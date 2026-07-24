/**
 * S3 backup target: the store re-writes one object on an S3-compatible bucket
 * the USER controls - Amazon S3, Cloudflare R2, Backblaze B2, MinIO, any server
 * that speaks the S3 REST API and SigV4. No vendor broker: the browser signs
 * each request itself and talks straight to the endpoint. The bytes are the
 * same end-to-end-encrypted .selfstore, so the bucket only ever holds
 * ciphertext.
 *
 * Two things the environment must allow, both documented for the user:
 *  - the bucket must send CORS for the app origin: allowed methods GET/PUT/HEAD,
 *    allowed headers authorization/x-amz-*, and ExposeHeaders ETag (so the
 *    version marker is readable), or browsers block the cross-origin request;
 *  - the app's CSP connect-src must permit the endpoint host.
 *
 * Credentials (the secret access key) are stored ENCRYPTED at rest under a
 * per-device non-extractable key, exactly like the WebDAV target, so a
 * set-and-forget connection never leaves a cleartext secret in IndexedDB.
 *
 * Path style is the default: the object lives at endpoint/bucket/key, which
 * every S3-compatible server accepts and needs no per-bucket DNS. Set
 * forcePathStyle:false for AWS virtual-hosted style (bucket as a host label).
 */

import type { BackupTarget } from '../target';
import type { KV } from '../cache';
import { seal, unseal, isEnvelope, newDeviceKey } from '../cache-crypto';
import { boundedSignal, lifeLine } from './abort';
import { AuthExpiredError, SelfstoreError } from '../../selfstore';
import { signS3, sha256Hex, EMPTY_PAYLOAD_SHA256 } from './sigv4';

const CONFIG_KEY = 's3Config';
const KEY_KEY = 's3Key';

const DATA_DEADLINE_MS = 30_000;
const META_DEADLINE_MS = 15_000;

export interface S3Config {
	/** Endpoint origin, e.g. https://s3.eu-west-3.amazonaws.com,
	 *  https://<account>.r2.cloudflarestorage.com, https://minio.example.com. */
	endpoint: string;
	/** Signing region ("eu-west-3"; R2 uses "auto"; MinIO any configured value). */
	region: string;
	bucket: string;
	/** Object key (the backup file), e.g. backups/app.selfstore. */
	key: string;
	accessKeyId: string;
	secretAccessKey: string;
	/** endpoint/bucket/key (default) vs bucket.endpoint/key. Default true. */
	forcePathStyle?: boolean;
}

export interface S3ConnectOptions {
	/** Where the (encrypted) config is persisted across sessions. */
	kv: KV;
	config: S3Config;
}

async function configKey(kv: KV): Promise<CryptoKey> {
	const existing = await kv.get<CryptoKey>(KEY_KEY);
	if (existing) return existing;
	const fresh = await newDeviceKey();
	await kv.set(KEY_KEY, fresh);
	return fresh;
}

async function saveConfig(kv: KV, c: S3Config): Promise<void> {
	const bytes = new TextEncoder().encode(JSON.stringify(c));
	await kv.set(CONFIG_KEY, await seal(await configKey(kv), bytes));
}

async function loadConfig(kv: KV): Promise<S3Config | null> {
	const stored = await kv.get(CONFIG_KEY);
	if (!isEnvelope(stored)) return null;
	const bytes = await unseal(await configKey(kv), stored);
	return JSON.parse(new TextDecoder().decode(bytes)) as S3Config;
}

/** SigV4 puts the secret on the wire only as a derived signature, but the
 *  request still needs https: an http endpoint would expose the object bytes
 *  and headers. Allow http for loopback (a local MinIO in dev) only. */
function assertSecureEndpoint(endpoint: string): URL {
	let u: URL;
	try {
		u = new URL(endpoint);
	} catch {
		throw new TypeError(`s3Target: invalid endpoint "${endpoint}".`);
	}
	const loopback =
		u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
	if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) {
		throw new TypeError(
			`s3Target: refusing "${u.protocol}" - S3 requests need https (http is allowed only for localhost).`
		);
	}
	return u;
}

function labelOf(c: S3Config): string {
	try {
		return `${c.bucket} (${new URL(c.endpoint).host})`;
	} catch {
		return c.bucket || 'S3';
	}
}

function versionOf(res: Response): string | null {
	return res.headers.get('ETag') ?? res.headers.get('Last-Modified') ?? null;
}

function fromConfig(c: S3Config, kv: KV): BackupTarget {
	const endpointUrl = assertSecureEndpoint(c.endpoint);
	const pathStyle = c.forcePathStyle ?? true;
	// Path style keeps one host and no per-bucket DNS; virtual-hosted folds the
	// bucket into the host label (AWS's preferred form).
	const origin = pathStyle
		? `${endpointUrl.protocol}//${endpointUrl.host}`
		: `${endpointUrl.protocol}//${c.bucket}.${endpointUrl.host}`;
	const objectPath = pathStyle ? `/${c.bucket}/${c.key}` : `/${c.key}`;
	// The instance's LIFE line: abortInFlight() (a user detach) cuts every
	// suspended request now instead of at its deadline (see the Drive target).
	const life = lifeLine();

	async function request(
		method: string,
		payloadHashHex: string,
		body?: BodyInit,
		extraHeaders?: Record<string, string>,
		deadlineMs = DATA_DEADLINE_MS
	): Promise<Response> {
		const signed = await signS3({
			method,
			origin,
			path: objectPath,
			region: c.region,
			accessKeyId: c.accessKeyId,
			secretAccessKey: c.secretAccessKey,
			payloadHashHex,
			extraHeaders
		});
		return fetch(signed.url, {
			method,
			headers: signed.headers,
			body,
			signal: boundedSignal(deadlineMs, life.current())
		});
	}

	/** One HEAD, or null on a network/CORS failure (transient). */
	async function probe(): Promise<Response | null> {
		try {
			return await request('HEAD', EMPTY_PAYLOAD_SHA256, undefined, undefined, META_DEADLINE_MS);
		} catch {
			return null;
		}
	}
	async function stat(): Promise<string | null> {
		const res = await probe();
		return res && res.ok ? versionOf(res) : null; // 404 / error / offline: cannot tell
	}
	async function ready(): Promise<boolean> {
		const res = await probe();
		if (!res) return false; // offline / CORS blocked: transient, retried later
		// 403 = the credentials are rejected (a HEAD with GetObject permission
		// returns 404, not 403, for a missing object - so 403 is a real auth loss,
		// not "no backup yet"). 404 = object not created yet, still writable.
		if (res.status === 403) {
			throw new AuthExpiredError('S3 rejected the credentials (403).');
		}
		return res.ok || res.status === 404;
	}
	/** Stored credentials: a reconnect just re-checks reachability, never mints new
	 *  keys, so a rejection is reported as false rather than thrown. */
	async function reconnectProbe(): Promise<boolean> {
		const res = await probe();
		return !!res && (res.ok || res.status === 404);
	}

	return {
		kind: 's3',
		label: labelOf(c),
		abortInFlight: life.cut,
		async save(blob: Blob): Promise<string | null> {
			const bytes = new Uint8Array(await blob.arrayBuffer());
			const res = await request('PUT', await sha256Hex(bytes), bytes);
			if (res.status === 403) {
				throw new AuthExpiredError('S3 rejected the credentials (403).');
			}
			if (!res.ok) throw new SelfstoreError('TARGET_WRITE_FAILED', `S3 PUT failed: ${res.status}`);
			return versionOf(res) ?? (await stat());
		},
		async load(): Promise<Blob | null> {
			const res = await request('GET', EMPTY_PAYLOAD_SHA256);
			if (res.status === 404) return null;
			if (res.status === 403) {
				throw new AuthExpiredError('S3 rejected the credentials (403).');
			}
			if (!res.ok) throw new SelfstoreError('TARGET_UNAVAILABLE', `S3 GET failed: ${res.status}`);
			return res.blob();
		},
		stat,
		isReady: ready,
		reconnect: reconnectProbe,
		async disconnect(): Promise<void> {
			await kv.del(CONFIG_KEY);
			await kv.del(KEY_KEY);
		}
	};
}

/** Validate + persist the config, returning the target, or null when the bucket
 *  is unreachable, rejects the credentials, or blocks the cross-origin request. */
export async function connect(opts: S3ConnectOptions): Promise<BackupTarget | null> {
	assertSecureEndpoint(opts.config.endpoint);
	const target = fromConfig(opts.config, opts.kv);
	// isReady() throws on a 403 (a later rejection gates the store); at first
	// connect a rejection just means "wrong credentials, try again", so a throw
	// here reads the same as false - report null, persist nothing.
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
