// The working store behind createLocalStore: the app's data always lives here
// so a refresh never loses it. Swappable interface - indexedDbCache(name) in
// the browser, memoryCache() in tests and SSR.
//
// Collections and file blobs are encrypted at rest under a non-extractable
// device key kept in the same database (cache-crypto.ts). The small kv
// bookkeeping (sync metadata, journal) stays in the clear - it is not the
// sensitive payload.

import { openDB, type IDBPDatabase } from 'idb';
import { seal, unseal, isEnvelope, newDeviceKey, type EncEnvelope } from './cache-crypto';
import { SelfstoreError } from '../selfstore/errors';
import type { CacheKdf } from './cache-lock';

/** A binary attachment kept as a real Blob. */
export interface CachedFile {
	id: string;
	name: string;
	mime: string;
	blob: Blob;
}

/** A tiny async key/value space for the store's bookkeeping. */
export interface KV {
	get<T = unknown>(key: string): Promise<T | undefined>;
	set(key: string, value: unknown): Promise<void>;
	del(key: string): Promise<void>;
}

export interface LocalCache {
	readonly kv: KV;
	/** Load the persisted collections + files, or null if nothing was ever saved. */
	load(): Promise<{ collections: Record<string, unknown[]>; files: CachedFile[] } | null>;
	/** Overwrite the collections snapshot (small; written on every change). */
	saveCollections(collections: Record<string, unknown[]>): Promise<void>;
	/** Reconcile the file store: add new blobs, drop removed ones (immutable by id). */
	saveFiles(files: CachedFile[]): Promise<void>;
	/** Wipe every locally-stored byte (the "forget me on this device" action). */
	clear(): Promise<void>;
	/** Ask the platform to make storage persistent (not evicted). Best-effort;
	 *  optional because only browser-backed caches have the concept. */
	requestPersistent?(): Promise<boolean>;
}

/** A cache whose payload seal key is not on disk but supplied per session from
 *  a secret held in memory (a password, or an app-provided key such as a passkey
 *  PRF). Until unlock() succeeds each session, load()/save*() reject with
 *  PASSWORD_REQUIRED. Defeats a full-profile copy, which a device key cannot -
 *  see indexedDbCache(name, { lock: true }). */
export interface LockableCache extends LocalCache {
	/** Supply the session secret. A string is Argon2id-derived (the salt is
	 *  persisted in the clear); a CryptoKey is used as-is. Returns false when it
	 *  does not open existing data - the cache stays locked. The first secret on
	 *  an empty cache sets the lock. */
	unlock(secret: string | CryptoKey): Promise<boolean>;
	/** Drop the in-memory key: reads and writes lock until unlock() is called. */
	lockNow(): void;
	/** Whether no seal key is currently held. */
	readonly locked: boolean;
}

/** Narrow a cache to its lockable shape (created with { lock: true }). */
export function isLockableCache(cache: LocalCache): cache is LockableCache {
	return typeof (cache as Partial<LockableCache>).unlock === 'function';
}

/** In-memory LocalCache for tests and SSR paths where IndexedDB does not
 *  exist. Not encrypted - nothing is at rest. */
export function memoryCache(): LocalCache {
	const kvMap = new Map<string, unknown>();
	let collections: Record<string, unknown[]> | undefined;
	const files = new Map<string, CachedFile>();
	return {
		kv: {
			async get<T = unknown>(key: string): Promise<T | undefined> {
				return kvMap.get(key) as T | undefined;
			},
			async set(key: string, value: unknown): Promise<void> {
				kvMap.set(key, value);
			},
			async del(key: string): Promise<void> {
				kvMap.delete(key);
			}
		},
		async load() {
			if (collections === undefined) return null;
			// Clone both ways: a returned reference must never alias internal state.
			return { collections: structuredClone(collections), files: [...files.values()] };
		},
		async saveCollections(c) {
			collections = structuredClone(c);
		},
		async saveFiles(fs) {
			files.clear();
			for (const f of fs) files.set(f.id, f);
		},
		async clear() {
			kvMap.clear();
			collections = undefined;
			files.clear();
		}
	};
}

/** A file record decoded for the caller: metadata plus the live blob. */
interface StoredFile {
	name: string;
	mime: string;
	blob: Blob;
}
/** A file record as stored: metadata in the clear, bytes sealed. */
type EncFile = { name: string; mime: string } & EncEnvelope;

const COLLECTIONS_KEY = '__collections';
const DEVICE_KEY = '__deviceKey';
const CACHE_KDF = '__cacheKdf';

/** The default browser cache. `name` scopes the database to one app, so two
 *  apps on the same origin never collide. */
export function indexedDbCache(name: string, opts: { lock: true }): LockableCache;
export function indexedDbCache(name: string, opts?: { lock?: boolean }): LocalCache;
export function indexedDbCache(name: string, opts?: { lock?: boolean }): LocalCache {
	let _db: Promise<IDBPDatabase> | null = null;
	const db = (): Promise<IDBPDatabase> =>
		(_db ??= openDB(name, 1, {
			upgrade(d) {
				d.createObjectStore('kv');
				d.createObjectStore('files');
			}
		}));

	// Lock mode: the seal key is supplied per session (unlock) and kept in RAM
	// only; no device key is ever written, so a copy of the profile carries no
	// usable key. Locked reads/writes reject with PASSWORD_REQUIRED.
	const lockMode = opts?.lock === true;
	let sealKey: CryptoKey | null = null;

	// The device key lives in this same database, so it and the data it protects
	// are cleared together (clear() wipes both) - no orphaned ciphertext.
	let _key: Promise<CryptoKey> | null = null;
	function key(): Promise<CryptoKey> {
		if (lockMode) {
			return sealKey
				? Promise.resolve(sealKey)
				: Promise.reject(
						new SelfstoreError(
							'PASSWORD_REQUIRED',
							'The local cache is locked - unlock() it first.'
						)
					);
		}
		return (_key ??= loadOrCreateKey());
	}
	async function loadOrCreateKey(): Promise<CryptoKey> {
		const d = await db();
		const existing = (await d.get('kv', DEVICE_KEY)) as CryptoKey | undefined;
		if (existing) return existing;
		// Generate outside the write tx (a non-IDB await would auto-close it), then
		// store only if still absent so a racing tab cannot clobber the key.
		const fresh = await newDeviceKey();
		const tx = d.transaction('kv', 'readwrite');
		if (!(await tx.store.get(DEVICE_KEY))) await tx.store.put(fresh, DEVICE_KEY);
		await tx.done;
		return (await d.get('kv', DEVICE_KEY)) as CryptoKey;
	}

	async function decodeFile(v: EncFile): Promise<StoredFile> {
		if (!isEnvelope(v)) {
			throw new SelfstoreError('BAD_FORMAT', 'Unrecognized cache record (not a sealed envelope).');
		}
		const bytes = await unseal(await key(), v);
		return { name: v.name, mime: v.mime, blob: new Blob([bytes as BlobPart], { type: v.mime }) };
	}

	const kv: KV = {
		async get<T = unknown>(key: string): Promise<T | undefined> {
			return (await (await db()).get('kv', `m:${key}`)) as T | undefined;
		},
		async set(key: string, value: unknown): Promise<void> {
			await (await db()).put('kv', value, `m:${key}`);
		},
		async del(key: string): Promise<void> {
			await (await db()).delete('kv', `m:${key}`);
		}
	};

	const base: LocalCache = {
		kv,

		async load() {
			const d = await db();
			const rawCollections = await d.get('kv', COLLECTIONS_KEY);
			if (rawCollections === undefined) return null;
			// A decrypt (or shape) failure throws, never returns null: init then
			// leaves the store not-ready, so auto-save cannot overwrite the bytes.
			if (!isEnvelope(rawCollections)) {
				throw new SelfstoreError(
					'BAD_FORMAT',
					'Unrecognized cache record (not a sealed envelope).'
				);
			}
			const collections = JSON.parse(
				new TextDecoder().decode(await unseal(await key(), rawCollections))
			) as Record<string, unknown[]>;
			const files: CachedFile[] = [];
			for (const fileKey of await d.getAllKeys('files')) {
				const v = (await d.get('files', fileKey)) as EncFile | undefined;
				if (v) files.push({ id: String(fileKey), ...(await decodeFile(v)) });
			}
			return { collections, files };
		},

		async saveCollections(collections) {
			const bytes = new TextEncoder().encode(JSON.stringify(collections));
			const env = await seal(await key(), bytes);
			await (await db()).put('kv', env, COLLECTIONS_KEY);
		},

		async saveFiles(files) {
			const d = await db();
			const have = new Set((await d.getAllKeys('files')).map(String));
			const want = new Set(files.map((f) => f.id));
			// Seal new blobs before opening the write tx: crypto is a non-IDB await and
			// would otherwise auto-close the transaction.
			const k = await key();
			const fresh = await Promise.all(
				files
					.filter((f) => !have.has(f.id))
					.map(async (f) => {
						const env = await seal(k, new Uint8Array(await f.blob.arrayBuffer()));
						return { id: f.id, rec: { name: f.name, mime: f.mime, ...env } satisfies EncFile };
					})
			);
			const tx = d.transaction('files', 'readwrite');
			for (const { id, rec } of fresh) tx.store.put(rec, id);
			for (const id of have) if (!want.has(id)) tx.store.delete(id);
			await tx.done;
		},

		async clear() {
			const d = await db();
			await d.clear('kv');
			await d.clear('files');
			_key = null; // next save mints a fresh device key
			sealKey = null; // lock mode: forget the session key (its kdf lived in kv, now gone)
		},

		async requestPersistent() {
			if (typeof navigator === 'undefined' || !navigator.storage?.persist) return false;
			try {
				if (await navigator.storage.persisted()) return true;
				return await navigator.storage.persist();
			} catch {
				return false;
			}
		}
	};

	if (!lockMode) return base;

	const lockable: LockableCache = {
		...base,
		get locked() {
			return sealKey === null;
		},
		lockNow() {
			sealKey = null;
		},
		async unlock(secret: string | CryptoKey): Promise<boolean> {
			// cache-lock (and its Argon2id dependency) load only when lock mode is
			// actually used, so the default cache path stays free of the KDF.
			const { keyFromPassword, freshCacheKdf, opens } = await import('./cache-lock');
			const d = await db();
			let candidate: CryptoKey;
			if (typeof secret === 'string') {
				let kdf = (await d.get('kv', CACHE_KDF)) as CacheKdf | undefined;
				if (!kdf) {
					// Mint the salt once, race-safe against a second tab (same guard as
					// the device key): store only if still absent.
					const fresh = freshCacheKdf();
					const tx = d.transaction('kv', 'readwrite');
					if (!(await tx.store.get(CACHE_KDF))) await tx.store.put(fresh, CACHE_KDF);
					await tx.done;
					kdf = (await d.get('kv', CACHE_KDF)) as CacheKdf;
				}
				candidate = await keyFromPassword(secret, kdf);
			} else {
				candidate = secret;
			}
			// Trust the secret only once it opens existing data; an empty cache
			// accepts the first secret, which sets the lock.
			const raw = await d.get('kv', COLLECTIONS_KEY);
			if (isEnvelope(raw) && !(await opens(candidate, raw))) return false;
			sealKey = candidate;
			return true;
		}
	};
	return lockable;
}
