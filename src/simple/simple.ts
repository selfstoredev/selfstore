// The simple store: one call, sensible defaults, and the store owns the data.
//
//   const store = await selfstore('notes-app');
//   await store.put('todos', { id: 't1', text: 'hello' });
//   store.onChange(render);
//
// Convention over configuration: schema version 1, an IndexedDB cache named
// after the app (in-memory where IndexedDB does not exist, so tests and SSR
// just work), debounced auto-save, and the browser sync moments wired.
// Every default has an option; everything deeper lives on store.advanced -
// the full createLocalStore, same instance.
//
// One rule is enforced rather than documented: records need a non-empty
// string id (the merge identifies records by it), so put() throws a
// TypeError right away. The advanced pull-model store only logs - it cannot
// know which collections an app considers mergeable.

import {
	createLocalStore,
	type LocalStore,
	type LocalStoreState,
	type StoreError
} from '../persistence/store';
import {
	indexedDbCache,
	memoryCache,
	isLockableCache,
	type KV,
	type LocalCache
} from '../persistence/cache';
import type { BackupTarget } from '../persistence/target';
import type { StatusDescriptor } from '../persistence/status';
import type { SyncConfig } from '../sync';
import type { ConnectTargets, ResumeOffer } from '../flows/connect';
import type { Snapshot, SnapshotFile } from '../selfstore/types';
import { SelfstoreError } from '../selfstore/errors';
import { restore, type PasswordPolicy } from '../selfstore';
import { saveToDisk } from '../selfstore/targets/local';
import {
	account as driveAccount,
	connect as driveConnect,
	fromSession as driveFromSession,
	type DriveAuth
} from '../persistence/targets/drive';
import { gisDriveAuth } from '../persistence/targets/drive-auth-gis';
import {
	connect as fileConnect,
	fromSession as fileFromSession,
	isSupported as fileIsSupported
} from '../persistence/targets/file';
import {
	connect as webdavConnect,
	fromSession as webdavFromSession,
	type WebdavConfig
} from '../persistence/targets/webdav';
import { connect as s3Connect, type S3Config } from '../persistence/targets/s3';

/** A record as the simple store sees it: plain JSON with a string id (the id
 *  field name can be remapped per collection via `sync.ids`). */
export type SimpleRecord = Record<string, unknown>;

/** Unlock callback for the ultra-sensitive cacheLock mode: return the session
 *  secret - a password (Argon2id-derived) or an app-provided key (e.g. a passkey
 *  PRF result). Called at boot; called again with { failed: true } after a wrong
 *  secret so the app can re-prompt. Throw to abort the boot (user cancelled). */
export type CacheUnlock = (attempt: { failed: boolean }) => Promise<string | CryptoKey>;

/** Options - every one of them optional, the defaults carry a real app. */
export interface SimpleOptions {
	/** Your DATA schema version (default 1). Bump it together with `migrate`. */
	schema?: number;
	/** Upgrade a snapshot written by an older schema version. */
	migrate?: (fromVersion: number, snap: Snapshot) => Snapshot;
	/** Per-collection merge tuning (id field mapping, strategies). The default -
	 *  records keyed by `id`, later edit wins, deletes propagate - fits most apps. */
	sync?: SyncConfig;
	/**
	 * Google Drive, when this app uses it. Two shapes for two situations:
	 *
	 * `{ clientId }` is the whole wiring - the library builds the browser
	 * connection, keeps ONE session for the app (several would mean several
	 * consent screens), reuses its token across a reload, remembers which
	 * account holds the backup and hands that back to Google so the chooser
	 * stops appearing. Nothing else to write.
	 *
	 * A `DriveAuth` instead, for an app that gets its tokens elsewhere - a
	 * server broker holding a refresh token, a native shell.
	 *
	 * Either way, providing it here is also what lets a connected Drive backup
	 * restore itself on the next start.
	 */
	drive?: DriveAuth | { clientId: string; scope?: string };
	/** Where the working copy lives (default: IndexedDB named after the app;
	 *  in-memory when IndexedDB does not exist, e.g. tests or SSR). */
	cache?: LocalCache;
	/** Auto-save debounce in ms. */
	debounceMs?: number;
	/** Cross-tab coordination (default on in browsers). */
	multiTab?: boolean;
	/** Refuse to ever write or export a plaintext backup: connecting a
	 *  destination then demands a password (or a group). Off by default. */
	requireEncryption?: boolean;
	/** Reject a backup password weaker than this policy (length, character
	 *  classes) at protect()/addKey time. Preview the rules with
	 *  checkPasswordPolicy for a live UI hint. Omit for no policy. */
	passwordPolicy?: PasswordPolicy;
	/** Ultra-sensitive mode: seal the local cache under a key derived from a
	 *  secret held in memory (this callback), never on disk - so a copy of the
	 *  browser profile cannot read it. One unlock per session; branch it on the
	 *  app's existing login to leave the UX unchanged. Browser (IndexedDB) only. */
	cacheLock?: CacheUnlock;
	/** Wire tab focus / network return / interval / tab hide automatically
	 *  (default true in browsers). Pass false to drive syncing yourself. */
	autoSync?: boolean;
}

/** What connecting a destination did. 'merged': it already held a backup and
 *  both sides were folded together. 'started': it was empty, this device's data
 *  is now its content. 'manual': non-Chromium file fallback - offer
 *  downloadBackup() instead. 'cancelled': the user closed the picker/consent. */
export type ConnectOutcome = 'merged' | 'started' | 'manual' | 'cancelled';

export interface SimpleStore<
	S extends Record<string, SimpleRecord> = Record<string, SimpleRecord>
> {
	// --- Your data ---------------------------------------------------------
	/** Every record of a collection (treat as read-only; write via put/remove). */
	all<K extends keyof S & string>(collection: K): readonly S[K][];
	/** One record by id, or undefined. */
	get<K extends keyof S & string>(collection: K, id: string): S[K] | undefined;
	/** Insert or replace one record (auto-saves, debounced). Throws a TypeError
	 *  when the record has no non-empty string id. */
	put<K extends keyof S & string>(collection: K, record: S[K]): Promise<void>;
	/** Insert or replace many records in one save. */
	putAll<K extends keyof S & string>(collection: K, records: S[K][]): Promise<void>;
	/** Delete one record by id (propagates to other devices). Unknown id: no-op. */
	remove<K extends keyof S & string>(collection: K, id: string): Promise<void>;
	/** Empty a collection (every removal propagates). */
	clear<K extends keyof S & string>(collection: K): Promise<void>;
	/** Called after any data change: your writes, another tab, another device,
	 *  a restore. Returns an unsubscribe. */
	onChange(fn: () => void): () => void;

	// --- Where it lives ----------------------------------------------------
	/** Connect Google Drive as the durable home. An existing backup there is
	 *  MERGED with this device (multi-device); an encrypted one needs its
	 *  password up front (PASSWORD_REQUIRED is thrown before anything changes). */
	connectDrive(auth: DriveAuth, opts?: { password?: string }): Promise<ConnectOutcome>;
	/** Connect a disk file (File System Access; falls back to manual download). */
	connectFile(opts?: { password?: string }): Promise<ConnectOutcome>;
	/** Connect a WebDAV server (Nextcloud, ownCloud, your own). */
	connectWebdav(config: WebdavConfig, opts?: { password?: string }): Promise<ConnectOutcome>;
	/** Connect an S3-compatible bucket you control (Amazon S3, R2, B2, MinIO). */
	connectS3(config: S3Config, opts?: { password?: string }): Promise<ConnectOutcome>;
	/** Connect any custom BackupTarget with the same merge semantics. */
	connectTarget(target: BackupTarget, opts?: { password?: string }): Promise<ConnectOutcome>;
	/** Back to device-only (the destination keeps its last backup). */
	disconnect(): Promise<void>;

	// --- Backup copy (replica) ---------------------------------------------
	/** Also write the same encrypted backup to this second destination on
	 *  every save. A broken copy never gates the store (state.replicas). */
	addReplica(target: BackupTarget, opts?: { id?: string }): string;
	/** Stop writing the copy (the destination keeps its last backup). */
	removeReplica(id: string): void;

	// --- Protection & the two gate gestures --------------------------------
	/** Encrypt the durable backup end to end with this password (reversible). */
	protect(password: string): Promise<void>;
	/** Remove the backup password. */
	unprotect(): Promise<void>;
	/** status.action === 'unlock': supply the password to resume. */
	unlock(password: string): Promise<boolean>;
	/** status.action === 'reconnect': re-run the destination's auth gesture. */
	reconnect(): Promise<boolean>;

	// --- Portable backups ---------------------------------------------------
	/** The portable backup file (a real ZIP; encrypted when protect() is on). */
	exportBackup(): Promise<Blob>;
	/** Download the backup (also resolves the 'manual' file mode's pending flag).
	 *  False when the user closed the save dialog: nothing was written, the
	 *  pending flag stands, and the app must not record a backup. */
	downloadBackup(filename?: string): Promise<boolean>;
	/** Load a backup file into this store, replacing the local data (removals
	 *  propagate like edits). Throws PASSWORD_REQUIRED / DECRYPT_FAILED. */
	importBackup(file: Blob | Uint8Array, opts?: { password?: string }): Promise<void>;

	// --- Observability ------------------------------------------------------
	/** Headless status: { state, severity, action, labelKey } - map labelKey to
	 *  your own copy. */
	readonly status: StatusDescriptor;
	/** The last problem: { code, labelKey, message } - show labelKey, log message. */
	readonly error: StoreError | null;
	/** The full underlying state (advanced reads: journal, peers, mode...). */
	readonly state: LocalStoreState;
	/** Fires on any state change (status flips included) - for framework bindings. */
	subscribe(fn: () => void): () => void;

	// --- Lifecycle ----------------------------------------------------------
	/** Save now (called for you on tab hide when autoSync is on). */
	flush(): Promise<void>;
	/** Converge with the destination now (a user gesture like pull-to-refresh). */
	sync(): Promise<void>;
	/** Drop timers and listeners (tests, SPA teardown). */
	dispose(): void;

	/** The escape hatch: the full advanced store this simple one is built on -
	 *  peers, groups, custom strategies, everything (see selfstore/advanced). */
	readonly advanced: LocalStore;

	/** The attachment point for 'selfstore/flows': the engine plus the cache KV
	 *  and backup file name a flow needs to build destination targets. Apps on
	 *  the advanced store hand a flow the same three by themselves. */
	readonly flowHost: { engine: LocalStore; kv: KV; backupName: string };

	/** Who holds the destination, when it is known - the Google address behind a
	 *  Drive backup. Learned on connect and remembered across sessions, so a
	 *  surface can NAME the destination ("Google Drive" is not an address) and a
	 *  re-grant can skip the account chooser. Null for a file, or before a first
	 *  connect. Reading it costs nothing: no call goes out. */
	readonly account: string | null;

	/** The destination this device already used, ready to hand to a connect flow
	 *  as `options.resume` - so a returning visitor is offered "reopen my backup"
	 *  ahead of the plain destinations, instead of re-deriving a decision the
	 *  library already has on file. Null when there is nothing to resume. */
	resumeOffer(): ResumeOffer | null;

	/**
	 * The destinations this store can offer, ready for a connect flow or widget:
	 * Drive first when the app configured it, a file always.
	 *
	 * Consumers were assembling this by hand from the very session the store
	 * built - and the order and the "no client id means no Drive card" rule were
	 * rediscovered each time. An app wanting a different offer (a WebDAV server,
	 * its own target) still writes its own object; this is the default, not a
	 * ceiling.
	 */
	destinations(): ConnectTargets;
}

/** The id field a collection's records are keyed by: `sync.ids` may remap it;
 *  a DOTTED path (nested id) is an advanced setup the simple check skips. */
function idFieldOf(sync: SyncConfig | undefined, collection: string): string | null {
	const mapped = sync?.ids?.[collection];
	if (mapped == null) return 'id';
	return mapped.includes('.') ? null : mapped;
}

function requireStringId(record: SimpleRecord, field: string | null, collection: string): string {
	if (field === null) return ''; // nested-path ids: validated by the engine's own rules
	const id = record[field];
	if (typeof id !== 'string' || id.length === 0) {
		throw new TypeError(
			`selfstore: a record in "${collection}" needs a non-empty STRING "${field}" ` +
				`(got ${JSON.stringify(id)}). String ids are what the multi-device merge keys on; ` +
				`map another field with { sync: { ids: { ${collection}: 'yourField' } } }.`
		);
	}
	return id;
}

/** True when a browser IndexedDB is available (SSR and plain Node lack it). */
function hasIndexedDb(): boolean {
	return typeof indexedDB !== 'undefined';
}

/** Told apart by shape: a DriveAuth mints tokens, a `{ clientId }` asks us to. */
function isDriveAuth(v: SimpleOptions['drive']): v is DriveAuth {
	return !!v && typeof (v as DriveAuth).token === 'function';
}

/** Where the connected Drive address is kept, per app: it is what stops Google
 *  asking WHICH account at every re-grant. An address is not a secret, and a
 *  browser that refuses storage simply gets the chooser back. */
const driveAccountKey = (app: string): string => `selfstore.drive.account.${app}`;

function localStore<T>(job: (store: Storage) => T): T | undefined {
	try {
		const store = globalThis.localStorage;
		return store ? job(store) : undefined;
	} catch {
		return undefined;
	}
}

function rememberedDriveAccount(app: string): string | undefined {
	return localStore((s) => s.getItem(driveAccountKey(app))) ?? undefined;
}

/** Learn the account behind a live Drive session, best-effort and once: it feeds
 *  the next re-grant's hint, and any surface that wants to name the destination. */
async function learnDriveAccount(app: string, auth: DriveAuth): Promise<void> {
	try {
		const who = await driveAccount({ auth });
		if (who.email) localStore((s) => s.setItem(driveAccountKey(app), who.email!));
	} catch {
		// A destination that will not say costs the hint, never the connection.
	}
}

/**
 * Open (or create) the app's local store. Awaits the initial load, so the
 * returned store is ready: data readable, destination restored, first converge
 * done. See SimpleOptions for the defaults.
 */
export async function selfstore<
	S extends Record<string, SimpleRecord> = Record<string, SimpleRecord>
>(app: string, options: SimpleOptions = {}): Promise<SimpleStore<S>> {
	if (typeof app !== 'string' || app.length === 0) {
		throw new TypeError('selfstore: pass your app name, e.g. selfstore("my-app").');
	}

	// The one copy of the data. The engine pulls it on save (gather) and pushes
	// into it on restores/folds (apply); the facade's mutators edit it in place
	// copy-on-write and schedule a save.
	let collections: Record<string, SimpleRecord[]> = {};
	// Binary files ride along untouched (a backup that carries them keeps them);
	// managing them is an advanced-store concern.
	let files: SnapshotFile[] = [];

	const dataSubs = new Set<() => void>();
	const emitData = (): void => dataSubs.forEach((fn) => fn());

	const cache =
		options.cache ??
		(hasIndexedDb()
			? indexedDbCache(app, options.cacheLock ? { lock: true } : undefined)
			: memoryCache());
	const backupName = `${app}.zip`;
	// connectDrive() remembers the auth so a later restoreTarget can use it even
	// when options.drive was not provided up front (same session only).
	//
	// `{ clientId }` is the whole wiring done here rather than in every app: ONE
	// session (several would mean several consent screens), a token that survives
	// a reload, and the account remembered so Google stops asking which one. Each
	// of those was a separate decision every consumer had to discover; the app
	// that wrote them by hand hit all three as bugs first.
	let driveAuth: DriveAuth | null = isDriveAuth(options.drive)
		? options.drive
		: options.drive
			? gisDriveAuth({
					clientId: options.drive.clientId,
					scope: options.drive.scope,
					persist: 'session',
					hint: () => rememberedDriveAccount(app)
				})
			: null;

	// Ultra-sensitive: unlock the cache before the store hydrates from it. One
	// prompt per session, driven by the app (branch it on an existing login to
	// keep the UX unchanged). A wrong secret re-prompts; throw to abort.
	if (options.cacheLock && isLockableCache(cache)) {
		let failed = false;
		while (!(await cache.unlock(await options.cacheLock({ failed })))) failed = true;
	}

	const store = createLocalStore({
		app,
		schemaVersion: options.schema ?? 1,
		gather: (): Snapshot => structuredClone({ collections, files }),
		apply: (snap: Snapshot): void => {
			collections = (snap.collections ?? {}) as Record<string, SimpleRecord[]>;
			files = snap.files ?? [];
			emitData();
		},
		migrate: options.migrate,
		sync: options.sync,
		cache,
		debounceMs: options.debounceMs,
		multiTab: options.multiTab,
		requireEncryption: options.requireEncryption,
		passwordPolicy: options.passwordPolicy,
		restoreTarget: async (kind) => {
			if (kind === 'drive' && driveAuth) {
				return driveFromSession({ auth: driveAuth, kv: cache.kv, fileName: backupName });
			}
			if (kind === 'file') return fileFromSession({ kv: cache.kv });
			if (kind === 'webdav') return webdavFromSession({ kv: cache.kv });
			return null;
		}
	});

	await store.init();

	// A degraded file mode is a verdict about the BROWSER, but it was persisted
	// like a property of the data: every later session re-read the word without
	// ever asking again. One session that could not open a picker - a browser
	// that ships the API and refuses it, a call made a moment too late, a user on
	// another browser that day - then pinned download-only mode forever, on a
	// Chromium perfectly able to hold a file, with no way back.
	//
	// Nothing writes this word except a picker that could not deliver, so a
	// browser that CAN deliver makes it stale. Re-examined here, in the layer
	// that wrote it. Dropping to 'device' is the honest state: manual mode had
	// already released the durable target, so there is nothing to detach - only
	// a stale claim to stop repeating, and a destination the host can offer again.
	if (store.state.targetKind === 'file-manual' && fileIsSupported()) {
		await store.detachTarget();
	}

	// Auto-wired sync moments (Spring-Boot-style autoconfiguration): tab focus,
	// network return, a slow interval, and save-on-hide. Opt out with
	// { autoSync: false } to drive these yourself.
	const teardown: (() => void)[] = [];
	if (
		options.autoSync !== false &&
		typeof document !== 'undefined' &&
		typeof window !== 'undefined'
	) {
		const onVisibility = (): void => {
			if (document.visibilityState === 'hidden') void store.flush();
			else void store.syncIfStale('focus');
		};
		const onOnline = (): void => void store.syncIfStale('online');
		const onPageHide = (): void => void store.flush();
		const interval = setInterval(() => {
			if (document.visibilityState === 'visible') void store.syncIfStale('interval');
		}, 5 * 60_000);
		document.addEventListener('visibilitychange', onVisibility);
		window.addEventListener('online', onOnline);
		window.addEventListener('pagehide', onPageHide);
		teardown.push(() => {
			clearInterval(interval);
			document.removeEventListener('visibilitychange', onVisibility);
			window.removeEventListener('online', onOnline);
			window.removeEventListener('pagehide', onPageHide);
		});
	}

	function mutate(collection: string, next: SimpleRecord[]): Promise<void> {
		collections = { ...collections, [collection]: next };
		emitData();
		store.schedule();
		return Promise.resolve();
	}

	async function connectTarget(
		target: BackupTarget,
		opts: { password?: string } = {}
	): Promise<ConnectOutcome> {
		const info = await store.inspectTarget(target);
		if (info.hasBackup) {
			// Another app's backup is refused BEFORE the password question: asking
			// first teaches the user their password "does not work" on a file that
			// was never this app's to open.
			if (info.app !== null && info.app !== store.app) {
				throw new SelfstoreError(
					'FOREIGN_BACKUP',
					`This destination holds a backup written by app "${info.app}", not "${store.app}". Open it in its own application, or pick another file.`
				);
			}
			// Fail before attaching: an encrypted backup without its password would
			// otherwise attach locked, which is a support case, not an outcome.
			if (info.encrypted && !opts.password) {
				throw new SelfstoreError(
					'PASSWORD_REQUIRED',
					'This destination holds an encrypted backup: pass its password to connect.'
				);
			}
			await store.attachTarget(target, { password: opts.password ?? null, strategy: 'merge' });
			return 'merged';
		}
		await store.attachTarget(target, {
			password: opts.password ?? null,
			strategy: 'replace-remote'
		});
		return 'started';
	}

	const simple: SimpleStore<S> = {
		all<K extends keyof S & string>(collection: K): readonly S[K][] {
			return (collections[collection] ?? []) as S[K][];
		},
		get<K extends keyof S & string>(collection: K, id: string): S[K] | undefined {
			const field = idFieldOf(options.sync, collection) ?? 'id';
			return (collections[collection] ?? []).find((r) => r[field] === id) as S[K] | undefined;
		},
		put<K extends keyof S & string>(collection: K, record: S[K]): Promise<void> {
			const field = idFieldOf(options.sync, collection);
			const id = requireStringId(record, field, collection);
			const rows = collections[collection] ?? [];
			const at = field === null ? -1 : rows.findIndex((r) => r[field] === id);
			return mutate(
				collection,
				at === -1 ? [...rows, record] : rows.map((r, i) => (i === at ? record : r))
			);
		},
		putAll<K extends keyof S & string>(collection: K, records: S[K][]): Promise<void> {
			const field = idFieldOf(options.sync, collection);
			const byId = new Map<unknown, number>();
			for (const r of records) requireStringId(r, field, collection);
			const rows = [...(collections[collection] ?? [])];
			if (field !== null) {
				rows.forEach((r, i) => byId.set(r[field], i));
				for (const r of records) {
					const at = byId.get(r[field]);
					if (typeof at === 'number') rows[at] = r;
					else rows.push(r);
				}
			} else {
				rows.push(...records);
			}
			return mutate(collection, rows);
		},
		remove<K extends keyof S & string>(collection: K, id: string): Promise<void> {
			const field = idFieldOf(options.sync, collection) ?? 'id';
			const rows = collections[collection] ?? [];
			const next = rows.filter((r) => r[field] !== id);
			return next.length === rows.length ? Promise.resolve() : mutate(collection, next);
		},
		clear<K extends keyof S & string>(collection: K): Promise<void> {
			if ((collections[collection] ?? []).length === 0) return Promise.resolve();
			return mutate(collection, []);
		},
		onChange(fn: () => void): () => void {
			dataSubs.add(fn);
			return () => dataSubs.delete(fn);
		},

		async connectDrive(auth: DriveAuth, opts?: { password?: string }): Promise<ConnectOutcome> {
			driveAuth = auth;
			const target = await driveConnect({ auth, kv: cache.kv, fileName: backupName });
			if (!target) return 'cancelled';
			const outcome = await connectTarget(target, opts);
			// Learn WHICH account now that there is a session: it is the hint that
			// keeps the chooser away next time, and the name a panel can show. Not
			// awaited into the outcome - a slow metadata call must not delay the
			// connect the user is waiting on.
			if (outcome !== 'cancelled') void learnDriveAccount(app, auth);
			return outcome;
		},
		async connectFile(opts?: { password?: string }): Promise<ConnectOutcome> {
			// Asked twice on purpose: the first call answers from what the browser
			// exposes, the second from what it did when actually asked. A browser
			// that ships the picker and then refuses it only tells us so here.
			if (fileIsSupported()) {
				const target = await fileConnect({ kv: cache.kv, fileName: backupName });
				if (target) return connectTarget(target, opts);
				if (fileIsSupported()) return 'cancelled';
			}
			await store.setManualFile();
			return 'manual';
		},
		async connectWebdav(
			config: WebdavConfig,
			opts?: { password?: string }
		): Promise<ConnectOutcome> {
			const target = await webdavConnect({ kv: cache.kv, config });
			if (!target) {
				throw new SelfstoreError(
					'TARGET_UNAVAILABLE',
					'The WebDAV server did not answer (URL, credentials or CORS).'
				);
			}
			return connectTarget(target, opts);
		},
		async connectS3(config: S3Config, opts?: { password?: string }): Promise<ConnectOutcome> {
			const target = await s3Connect({ kv: cache.kv, config });
			if (!target) {
				throw new SelfstoreError(
					'TARGET_UNAVAILABLE',
					'The S3 endpoint did not answer (endpoint, credentials or CORS).'
				);
			}
			return connectTarget(target, opts);
		},
		connectTarget,
		disconnect: () => store.detachTarget(),
		addReplica: (target, opts) => store.attachReplica(target, opts),
		removeReplica: (id) => store.detachReplica(id),

		protect: (password: string) => store.setEncryption(password),
		unprotect: () => store.setEncryption(null),
		unlock: (password: string) => store.unlock(password),
		reconnect: () => store.reconnect(),

		exportBackup: () => store.exportBlob(),
		async downloadBackup(filename?: string): Promise<boolean> {
			const written = await saveToDisk(await store.exportBlob(), filename ?? backupName);
			// Clearing the pending flag on a cancelled dialog would drop the very
			// nudge that asks for the file the user still does not have.
			if (written) store.markDownloaded();
			return written;
		},
		async importBackup(file: Blob | Uint8Array, opts?: { password?: string }): Promise<void> {
			// The fluent read() strips reserved bookkeeping collections; removals
			// then propagate because the next save diffs against the sync meta.
			const reader = restore(file);
			const snap = opts?.password
				? await reader.withPassword(opts.password).read()
				: await reader.read();
			collections = (snap.collections ?? {}) as Record<string, SimpleRecord[]>;
			files = snap.files ?? [];
			emitData();
			store.schedule();
		},

		get status(): StatusDescriptor {
			return store.state.status;
		},
		get error(): StoreError | null {
			return store.state.lastError;
		},
		get state(): LocalStoreState {
			return store.state;
		},
		subscribe: (fn: () => void) => store.subscribe(fn),

		flush: () => store.flush(),
		async sync(): Promise<void> {
			await store.syncNow();
		},
		dispose(): void {
			teardown.forEach((fn) => fn());
			teardown.length = 0;
			store.dispose();
		},

		advanced: store,

		flowHost: { engine: store, kv: cache.kv, backupName },

		get account(): string | null {
			return rememberedDriveAccount(app) ?? null;
		},

		destinations(): ConnectTargets {
			// Drive first when there is one: it is the answer that follows a user
			// from device to device. A file always, for whoever wants no account.
			return driveAuth ? { drive: driveAuth, file: true } : { file: true };
		},

		resumeOffer(): ResumeOffer | null {
			const detail = rememberedDriveAccount(app);
			if (!driveAuth || !detail) return null;
			const auth = driveAuth;
			return {
				kind: 'drive',
				detail,
				// Reopening is not searching: fromSession takes the file id already
				// remembered, where a fresh connect resolves by name and could land on
				// another file carrying the same one.
				connect: () => driveFromSession({ auth, kv: cache.kv, fileName: backupName })
			};
		}
	};

	return simple;
}
