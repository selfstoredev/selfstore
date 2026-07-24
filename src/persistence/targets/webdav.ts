/**
 * WebDAV backup target: the store re-writes one .selfstore file on a WebDAV
 * server the USER controls (Nextcloud, ownCloud, a plain WebDAV mount...). No
 * Google, no vendor broker - the browser talks straight to the server the user
 * owns. The bytes are the same end-to-end-encrypted .selfstore, so the server
 * only ever holds ciphertext.
 *
 * Two things the environment must allow, both documented for the user:
 *  - the server must send CORS for the app origin (methods PUT/GET/HEAD and the
 *    Authorization header), since browsers block cross-origin WebDAV otherwise;
 *  - the app's CSP connect-src must permit the server host.
 *
 * Credentials are stored ENCRYPTED at rest under a per-device non-extractable
 * key, so a set-and-forget connection never leaves a cleartext password in
 * IndexedDB. The version marker prefers ETag, falling back to Last-Modified
 * (the latter is CORS-safelisted, so it is readable without extra server config).
 */

import type { BackupTarget, PeerSource } from '../target';
import type { KV } from '../cache';
import { seal, unseal, isEnvelope, newDeviceKey } from '../cache-crypto';
import { boundedSignal, lifeLine } from './abort';
import { AuthExpiredError, SelfstoreError } from '../../selfstore';

const CONFIG_KEY = 'webdavConfig';
const KEY_KEY = 'webdavKey';

/** A hung server must not spin forever: a deadline turns the hang into an
 *  ordinary error the store retries (never a gate). Transfers get more room than
 *  the HEAD poke. */
const DATA_DEADLINE_MS = 30_000;
const META_DEADLINE_MS = 15_000;

export interface WebdavConfig {
	/** Full URL of the backup file, e.g. https://cloud.me/remote.php/dav/files/me/backup.zip */
	url: string;
	username: string;
	password: string;
}

export interface WebdavConnectOptions {
	/** Where the (encrypted) server config is persisted across sessions. */
	kv: KV;
	config: WebdavConfig;
}

async function configKey(kv: KV): Promise<CryptoKey> {
	const existing = await kv.get<CryptoKey>(KEY_KEY);
	if (existing) return existing;
	const fresh = await newDeviceKey();
	await kv.set(KEY_KEY, fresh);
	return fresh;
}

async function saveConfig(kv: KV, c: WebdavConfig): Promise<void> {
	const bytes = new TextEncoder().encode(JSON.stringify(c));
	await kv.set(CONFIG_KEY, await seal(await configKey(kv), bytes));
}

async function loadConfig(kv: KV): Promise<WebdavConfig | null> {
	const stored = await kv.get(CONFIG_KEY);
	if (!isEnvelope(stored)) return null;
	const bytes = await unseal(await configKey(kv), stored);
	return JSON.parse(new TextDecoder().decode(bytes)) as WebdavConfig;
}

function labelOf(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return 'WebDAV';
	}
}

/** WebDAV authenticates with HTTP Basic - the password is sent on every request.
 *  Over plain http that is cleartext on the wire, so refuse it. Allow https, and
 *  http only for loopback (local dev against a container on the same machine). */
function assertSecureUrl(url: string): void {
	let u: URL;
	try {
		u = new URL(url);
	} catch {
		throw new TypeError(`webdavTarget: invalid URL "${url}".`);
	}
	const loopback =
		u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
	if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) {
		throw new TypeError(
			`webdavTarget: refusing "${u.protocol}" - Basic-auth credentials need https (http is allowed only for localhost).`
		);
	}
}

function versionOf(res: Response): string | null {
	return res.headers.get('ETag') ?? res.headers.get('Last-Modified') ?? null;
}

function fromConfig(c: WebdavConfig, kv: KV): BackupTarget {
	const headers = { Authorization: 'Basic ' + btoa(`${c.username}:${c.password}`) };
	// The instance's LIFE line: abortInFlight() (a user detach) cuts every
	// suspended request now instead of at its deadline (see the Drive target).
	const life = lifeLine();
	const bounded = (ms: number): AbortSignal => boundedSignal(ms, life.current());

	/** One HEAD, or null on a network/CORS failure (transient - the caller decides
	 *  what "cannot reach" means for it). */
	async function probe(): Promise<Response | null> {
		try {
			return await fetch(c.url, {
				method: 'HEAD',
				headers,
				signal: bounded(META_DEADLINE_MS)
			});
		} catch {
			return null;
		}
	}
	async function stat(): Promise<string | null> {
		const res = await probe();
		return res && res.ok ? versionOf(res) : null; // 404 / error / offline: "cannot tell"
	}
	async function ready(): Promise<boolean> {
		const res = await probe();
		if (!res) return false; // offline / CORS blocked: transient, the store retries later
		// 401/403 = the stored credentials are rejected: a genuine loss of access
		// only the user can fix (re-enter the config), so gate rather than loop as
		// "momentarily unreachable". 404 = file not created yet, still writable.
		if (res.status === 401 || res.status === 403) {
			throw new AuthExpiredError(`WebDAV rejected the credentials (${res.status}).`);
		}
		return res.ok || res.status === 404;
	}
	/** Credentials are stored; a reconnect just re-checks reachability. It can
	 *  never mint new credentials, so a rejection is reported as false (never
	 *  thrown) - only re-running connect() with a fresh config fixes bad creds. */
	async function reconnectProbe(): Promise<boolean> {
		const res = await probe();
		return !!res && (res.ok || res.status === 404);
	}

	return {
		kind: 'webdav',
		label: labelOf(c.url),
		abortInFlight: life.cut,
		async save(blob: Blob): Promise<string | null> {
			const res = await fetch(c.url, {
				method: 'PUT',
				headers,
				body: blob,
				signal: bounded(DATA_DEADLINE_MS)
			});
			// 401/403 = the server rejected the stored credentials: a genuine loss of
			// access the user must fix. Anything else (5xx, conflict) is transient.
			if (res.status === 401 || res.status === 403) {
				throw new AuthExpiredError(`WebDAV rejected the credentials (${res.status}).`);
			}
			if (!res.ok)
				throw new SelfstoreError('TARGET_WRITE_FAILED', `WebDAV PUT failed: ${res.status}`);
			return versionOf(res) ?? (await stat());
		},
		async load(): Promise<Blob | null> {
			const res = await fetch(c.url, {
				method: 'GET',
				headers,
				signal: bounded(DATA_DEADLINE_MS)
			});
			if (res.status === 404) return null;
			if (res.status === 401 || res.status === 403) {
				throw new AuthExpiredError(`WebDAV rejected the credentials (${res.status}).`);
			}
			if (!res.ok)
				throw new SelfstoreError('TARGET_UNAVAILABLE', `WebDAV GET failed: ${res.status}`);
			return res.blob();
		},
		stat,
		isReady: ready,
		reconnect: reconnectProbe, // stored credentials: re-check reachability, no gesture
		async disconnect(): Promise<void> {
			await kv.del(CONFIG_KEY);
			await kv.del(KEY_KEY);
		}
	};
}

export interface WebdavPeerOptions {
	/** URL of ANOTHER member's published copy, read-only: a Nextcloud/ownCloud
	 *  read-only share link, or a file URL they granted you read access to. */
	url: string;
	/** Optional Basic-auth credentials, when the read-only share needs them.
	 *  Omit for a public/tokenised share link (a Nextcloud `/s/<token>/download`
	 *  URL) that needs none. Held in memory only - a peer is re-attached each
	 *  session (see attachPeer), so nothing is persisted here. */
	username?: string;
	password?: string;
	/** Display label (defaults to the URL host). */
	label?: string;
}

/** A read-only WebDAV peer: another member's published copy, fetched over a
 *  shared URL, for `store.attachPeer`. It is the read half of a WebDAV target
 *  (GET + HEAD only, never a write), so a group can share read-write without
 *  Google Drive - each member publishes to their own WebDAV and shares a
 *  read-only link. Failures follow the peer protocol: a 401/403 is a genuine
 *  loss of read access (AuthExpiredError), 404 means "not published yet"
 *  (null), anything else is transient. */
export function peer(opts: WebdavPeerOptions): PeerSource {
	// Basic-auth credentials are cleartext on the wire, so require https when they
	// are present; a credential-less public link carries only ciphertext, so any
	// host it lives on is the member's own choice.
	if (opts.username !== undefined) assertSecureUrl(opts.url);
	const headers =
		opts.username !== undefined
			? { Authorization: 'Basic ' + btoa(`${opts.username}:${opts.password ?? ''}`) }
			: undefined;
	return {
		label: opts.label ?? labelOf(opts.url),
		async load(): Promise<Blob | null> {
			const res = await fetch(opts.url, {
				method: 'GET',
				headers,
				signal: AbortSignal.timeout(DATA_DEADLINE_MS)
			});
			if (res.status === 404) return null; // the member has not published yet
			if (res.status === 401 || res.status === 403) {
				throw new AuthExpiredError(`WebDAV peer rejected the credentials (${res.status}).`);
			}
			if (!res.ok) {
				throw new SelfstoreError('TARGET_UNAVAILABLE', `WebDAV peer GET failed: ${res.status}`);
			}
			return res.blob();
		},
		async stat(): Promise<string | null> {
			try {
				const res = await fetch(opts.url, {
					method: 'HEAD',
					headers,
					signal: AbortSignal.timeout(META_DEADLINE_MS)
				});
				return res.ok ? versionOf(res) : null; // cannot tell: fall through to a full load
			} catch {
				return null;
			}
		}
	};
}

/** Validate + persist the config, returning the target, or null when the server
 *  is unreachable, rejects the credentials, or blocks the cross-origin request. */
export async function connect(opts: WebdavConnectOptions): Promise<BackupTarget | null> {
	assertSecureUrl(opts.config.url); // cleartext credentials over http are refused up front
	const target = fromConfig(opts.config, opts.kv);
	// isReady() now THROWS on a 401/403 (so a later rejection gates the store); at
	// first connect a rejection just means "wrong credentials, try again", so a
	// throw here reads the same as false - report null, persist nothing.
	let ok: boolean;
	try {
		ok = await target.isReady();
	} catch {
		ok = false;
	}
	if (!ok) return null;
	await saveConfig(opts.kv, opts.config);
	return target;
}

/** Rebuild the target from the encrypted config persisted last session, or null. */
export async function fromSession(opts: { kv: KV }): Promise<BackupTarget | null> {
	const config = await loadConfig(opts.kv);
	return config ? fromConfig(config, opts.kv) : null;
}
