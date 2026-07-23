// createLocalStore: the front door. Composes the backup format, the merge
// engine and a LocalCache into one lifecycle - debounced saves, flush on tab
// hide, logical clocks, replica merges, memory/cache/durable-home juggling all
// live here so the app never has to. Framework-agnostic (plain state plus
// subscribe) and headless (semantic status, never colours or copy). The app
// brings what is app-specific: gather, apply, a schema version, migrate.

import {
	inspect,
	isSelfstoreError,
	isAuthExpired,
	errorLabelKey,
	SelfstoreError,
	checkPasswordPolicy,
	type Snapshot,
	type SelfstoreErrorCode,
	type PasswordSlot,
	type ExternalSlot,
	type PasswordPolicy
} from '../selfstore';
import {
	writeBox,
	readBoxWithSync,
	asBytes,
	BACKUP_MIME,
	type GroupReadOptions,
	type BoxEnvelope
} from '../selfstore/box';
import { mintSlot, openSlot, mintExternalSlot, MAX_KEY_SLOTS } from '../selfstore/crypto';
import {
	GROUP_KEYING,
	openManifest,
	type GroupIdentity,
	type GroupManifest,
	type SignedManifest
} from '../selfstore/group';
import {
	stamp,
	merge,
	detectConflicts,
	createMeta,
	createNode,
	changes,
	gcTombstones,
	unsyncableCounts,
	idPathFor,
	type SyncMeta,
	type SyncConfig,
	type CollectionChanges,
	type Conflict
} from '../sync';
import { deriveStatus, type StatusDescriptor } from './status';
import { isReservedStoreMode, type BackupTarget, type PeerSource } from './target';
import type { LocalCache, CachedFile } from './cache';

export type Mode = 'persistent' | 'ephemeral';
/** Any BackupTarget kind, or a reserved store mode ('device', 'file-manual').
 *  Deliberately open: a custom target's kind flows through here. */
export type TargetKind = 'device' | 'file-manual' | (string & {});

/** What triggered a converge with the remote (for the sync journal). */
export type SyncSource = 'boot' | 'focus' | 'online' | 'interval' | 'manual' | 'push' | 'connect';

/** One journal line: a converge that actually changed local data. */
export interface SyncJournalEntry {
	at: number;
	source: SyncSource;
	changes: Record<string, CollectionChanges>;
	/** Concurrent same-record edits, auto-resolved latest-wins. Both values are
	 *  carried so the app can show or restore the overwritten one. */
	conflicts?: Conflict[];
}

/** The last problem the store hit, as a stable code the app maps to its own wording. */
export interface StoreError {
	code: SelfstoreErrorCode;
	/** Stable i18n key for `code` (errorLabelKey). Show this, mapped to your copy. */
	labelKey: string;
	/** Developer detail for logs - English, may carry an HTTP status. Never display it. */
	message: string;
}

// labelKey derived from code here, so no reporting site can forget it.
const storeError = (code: SelfstoreErrorCode, message: string): StoreError => ({
	code,
	labelKey: errorLabelKey(code),
	message
});

/**
 * Group mode: this member's identity, the admin key pinned at join time
 * (TOFU, from the invite), and the manifest as it travels. The store verifies
 * the manifest itself - signature, member-key shapes, group binding - so
 * group security never depends on the app remembering to call openManifest.
 */
export interface StoreGroupConfig {
	identity: GroupIdentity;
	/** The admin's Ed25519 public key (base64 raw), pinned from the invite. */
	admin: string;
	/** The admin-signed manifest exactly as distributed (signManifest output). */
	manifest: SignedManifest;
}

interface ActiveGroup {
	identity: GroupIdentity;
	admin: string;
	manifest: GroupManifest;
}

/** One attached peer (another member's read-only copy - see attachPeer). */
export interface PeerState {
	id: string;
	label: string;
	/** Last successful fold-in (ms epoch), or null. */
	lastSyncAt: number | null;
	/** Group mode: the manifest member whose signature the last folded copy carried. */
	author: string | null;
	/** Per-peer on purpose: a broken peer never gates the store itself. */
	lastError: StoreError | null;
}

/** One write-only published copy of this store (see attachMirror). */
export interface MirrorState {
	id: string;
	label: string;
	/** Last successful publish (ms epoch), or null. */
	lastPublishAt: number | null;
	/** Per-mirror on purpose: a broken mirror never gates the store itself. */
	lastError: StoreError | null;
}

/** One secondary synced copy of this store (see attachReplica). */
export interface ReplicaState {
	id: string;
	label: string;
	/** Last successful publish (ms epoch), or null. */
	lastPublishAt: number | null;
	/** Per-replica on purpose: a broken replica never gates the store itself. */
	lastError: StoreError | null;
}

/** The read-only snapshot of the store the UI renders. */
export interface LocalStoreState {
	ready: boolean;
	mode: Mode;
	targetKind: TargetKind;
	label: string | null;
	encrypted: boolean;
	locked: boolean;
	saving: boolean;
	lastSavedAt: number | null;
	status: StatusDescriptor;
	/** The last durable-target problem (upload/refresh), or null. */
	lastError: StoreError | null;
	/** Recent converges that changed local data, newest first (device-local). */
	journal: SyncJournalEntry[];
	/** The last live converge that changed data (drives the "synced" toast). */
	lastSync: SyncJournalEntry | null;
	/** Attached peers, in attach order. */
	peers: PeerState[];
	/** Attached mirrors, in attach order. */
	mirrors: MirrorState[];
	/** Attached replicas (secondary synced copies), in attach order. */
	replicas: ReplicaState[];
}

export interface LocalStoreOptions {
	/** App id; names the backup and scopes the default cache database. */
	app: string;
	/** Data schema version; bump when gather's shape changes. Stamped into every
	 *  backup, drives migrate() and the SCHEMA_TOO_NEW gate. */
	schemaVersion: number;
	/** Release version ("1.4.2"), stamped informationally into the header. */
	appVersion?: string;
	/** Branded README shipped inside encrypted backups. */
	readme?: string;
	/** Refuse to ever write or export a plaintext backup. attachTarget without a
	 *  password or group is rejected, setEncryption(null) is rejected, and
	 *  exportBlob refuses a cleartext copy - the backup that leaves the device is
	 *  always ciphertext. Scope is deliberately the travelling copy: the
	 *  on-device working cache stays governed by the browser profile, as ever.
	 *  Off by default. */
	requireEncryption?: boolean;
	/** Reject a backup password that fails this strength policy (length and
	 *  character classes): setEncryption, addEncryptionKey and a password given
	 *  to attachTarget throw WEAK_PASSWORD before touching anything. The app can
	 *  preview the same rules with checkPasswordPolicy so its UI blocks a weak
	 *  password before it is ever submitted. Omit for no policy. */
	passwordPolicy?: PasswordPolicy;
	/** Gather the app's live state into a portable snapshot. */
	gather: () => Promise<Snapshot> | Snapshot;
	/** Apply a snapshot into the app (replaces current state). */
	apply: (snap: Snapshot) => void;
	/** Upgrade a snapshot written by an older version to the current shape. */
	migrate?: (fromVersion: number, snap: Snapshot) => Snapshot;
	/** Per-collection merge strategies. Omit for everything lww-set. */
	sync?: SyncConfig;
	/** Derived collections whose merges are routine noise (recomputed data, not
	 *  user edits): converges touching only these skip the sync journal. */
	journalSilent?: string[];
	/** Prune delete-tombstones older than this many ms on each save. Safe only
	 *  when it comfortably exceeds the longest a device stays offline: a device
	 *  that never saw a delete resurrects the record once the tombstone is gone
	 *  everywhere. Omit to keep every tombstone; weeks is a reasonable value. */
	tombstoneHorizonMs?: number;
	/** Coordinate several tabs of the same app (default: on in browser
	 *  windows). Every save first folds what other tabs persisted, writes
	 *  serialize through a cross-tab Web Lock where available, and a
	 *  BroadcastChannel refreshes the other tabs after each write. Data and
	 *  bookkeeping only: a target's connection stays per tab (restoreTarget at
	 *  boot), and mode/target switches reach other tabs on reload. */
	multiTab?: boolean;
	/** The working store under the app. */
	cache: LocalCache;
	/** Rebuild a durable target connected in a past session. Receives the kind
	 *  persisted at attach time - built-in or custom. */
	restoreTarget?: (kind: string) => Promise<BackupTarget | null>;
	/** Debounce window for auto-save (ms). Default 800. */
	debounceMs?: number;
	/** Diagnostics sink, developer-facing (defaults to the console). */
	logger?: { warn(...args: unknown[]): void; error(...args: unknown[]): void };
}

export interface LocalStore {
	readonly state: LocalStoreState;
	subscribe(fn: () => void): () => void;

	/** Hydrate from the cache, restore a saved durable target, converge with it. */
	init(): Promise<void>;
	/** Schedule a debounced save (call after each mutation). */
	schedule(): void;
	/** Save now, cancelling the debounce (use on tab hide). */
	flush(): Promise<void>;

	/** Converge with the remote only if it changed since the last sync (a cheap
	 *  stat, throttled). Call on tab focus, network return and a slow interval. */
	syncIfStale(source: SyncSource): Promise<void>;
	/** Converge with the remote now (user gesture). Resolves to what changed
	 *  locally, or null when already up to date. */
	syncNow(): Promise<SyncJournalEntry | null>;

	/** Inspect a target for an existing backup, without changing any state. */
	inspectTarget(
		target: BackupTarget
	): Promise<{ hasBackup: boolean; date: string | null; encrypted: boolean }>;
	/** Attach a durable home. `strategy` reconciles with what is already on the
	 *  target: 'merge' (default, multi-device), 'replace-local' (load the
	 *  target into the app) or 'replace-remote' (overwrite the target).
	 *  `keepSession` leaves the departing target's credentials untouched (a
	 *  backup switch behind one account). `wipe` starts the new home blank -
	 *  empty data, fresh sync meta, never seeded from the departing one. */
	attachTarget(
		target: BackupTarget,
		opts?: {
			password?: string | null;
			/** Group mode: publish signed copies enveloped for every manifest
			 *  member, trust only member-signed copies back. The manifest is
			 *  verified here, against the pinned admin key, before anything
			 *  about the store changes. Mutually exclusive with `password`.
			 *  Not persisted: re-attach with the group config at boot. */
			group?: StoreGroupConfig;
			strategy?: 'merge' | 'replace-local' | 'replace-remote';
			keepSession?: boolean;
			wipe?: boolean;
		}
	): Promise<void>;
	/** Apply a newer membership manifest. Verified against the admin key and
	 *  group id pinned at attach (a swapped admin or foreign group never
	 *  lands), with seq monotonicity across sessions (MANIFEST_ROLLBACK on an
	 *  older one). The next publish re-envelopes for the new member list -
	 *  which is how removal takes effect: a removed member stops being a
	 *  recipient of anything published from now on. */
	setGroup(manifest: SignedManifest): Promise<void>;
	/** Attach another member's published copy as a read-only peer. Every
	 *  converge pulls each peer's copy and merges it as one more replica, then
	 *  publishes the merged state to this store's own target - crossed
	 *  read-only links are how read-write sharing emerges. A peer copy opens
	 *  with its own `password` when given, else the session password. Peer
	 *  problems land on `state.peers` and never gate the store. Not persisted:
	 *  re-attach at boot. Resolves to the peer id (pass `id` to pin it). */
	attachPeer(source: PeerSource, opts?: { id?: string; password?: string }): string;
	/** Detach a peer locally (never touches the member's copy). Unknown id: no-op. */
	detachPeer(id: string): void;
	/** Publish a write-only mirror: after every save or converge that moved
	 *  data, the current state is re-encoded under the mirror's own password
	 *  and saved to the mirror target. The store's own file is never re-keyed -
	 *  that is the point: your file stays yours, the copy others read travels
	 *  under the share key. The envelope is minted once (no KDF per publish);
	 *  mirror problems land on `state.mirrors` and never gate the store. Not
	 *  persisted: re-attach at boot. Resolves to the mirror id. */
	attachMirror(target: BackupTarget, opts: { password: string; id?: string }): string;
	/** Detach a mirror locally (the published copy stays where it is). */
	detachMirror(id: string): void;
	/** Attach a secondary synced copy: after every save or converge that moved
	 *  data, the CURRENT backup - same bytes, same key as the primary home - is
	 *  also written to this target. A resilience mirror of your own file (Drive
	 *  plus an S3 bucket, say), not a share: any device can later attach it as
	 *  its primary with the same password. Publishing reuses the primary's
	 *  envelope, so it costs no extra KDF; replica problems land on
	 *  `state.replicas` and never gate the store. Not persisted: re-attach at
	 *  boot. Resolves to the replica id (pass `id` to pin it). */
	attachReplica(target: BackupTarget, opts?: { id?: string }): string;
	/** Detach a replica locally (the copy already written stays where it is). */
	detachReplica(id: string): void;
	/** Switch to degraded download-on-demand mode (non-Chromium file). */
	setManualFile(): Promise<void>;
	/** Unlock an encrypted target: the password is held in memory only, then a
	 *  converge runs. False on a wrong password (the gate re-raises) or when
	 *  the target is not locked (use `reconnect`). */
	unlock(password: string): Promise<boolean>;
	/** Re-acquire access after a genuine loss: run the target's reconnect
	 *  gesture, then converge. False when locked (use `unlock`) or absent. */
	reconnect(): Promise<boolean>;
	/** Re-lock now: drop the in-memory password (encrypted target). */
	lock(): void;
	/** Detach the durable home (does not delete it); back to cache-only.
	 *  `keepSession` skips the target's disconnect so its credentials survive -
	 *  for a caller that still needs the destination right after (deleting the
	 *  detached file, attaching another one on the same account). */
	detachTarget(opts?: { keepSession?: boolean }): Promise<void>;

	/** Build the portable .selfstore blob (for a manual download or dated copy). */
	exportBlob(): Promise<Blob>;
	/** Mark the file-manual pending download as resolved. */
	markDownloaded(): void;

	/** Stop persisting (shared computer). */
	setEphemeral(): void;
	/** Resume persisting to the cache. */
	leaveEphemeral(): Promise<void>;
	/** Wipe all app data. With a destination connected, keep the connection and
	 *  empty its backup too; with none, forget locally and return to the
	 *  cache-only default. The UI empties immediately, no reload. */
	forget(): Promise<void>;

	/** Add, change or remove the backup password - reversible. A non-empty
	 *  string (re)encrypts; null decrypts. Needs a connected, unlocked target;
	 *  rewrites cache and remote. Setting a password rotates the data key
	 *  (fresh key, single slot), so every previously authorized password
	 *  stops opening the file. */
	setEncryption(password: string | null): Promise<void>;

	/** Add another password that opens this backup: the data key gains one
	 *  slot, nothing is re-encrypted, existing passwords keep working - how
	 *  sharing adds its key without clobbering the owner's. Verified against
	 *  the built bytes before the write lands. Resolves to the slot id. */
	addEncryptionKey(password: string, id?: string): Promise<string>;

	/** Remove one password slot by id. Refuses the last slot (that is
	 *  setEncryption(null)) and refuses to lock the current session out.
	 *  Bearer reality: whoever held that password may hold old bytes - only a
	 *  rotation makes new writes unreadable to them. */
	removeEncryptionKey(id: string): Promise<void>;

	/** Encrypt under an external key (passkey PRF, hardware token) instead of
	 *  a typed password: fresh data key, one external slot. `keyRef` is stored
	 *  verbatim so the app can re-derive the secret. Rotates like
	 *  setEncryption; the app owns the WebAuthn exchange and hands in the
	 *  32-byte secret. */
	setExternalEncryption(secret: Uint8Array, keyRef: string): Promise<void>;

	/** Add an external-key slot to an already-encrypted backup - a passkey
	 *  alongside a recovery password, or the reverse. Needs an unlocked
	 *  session; verified against the built bytes before the write lands. */
	addExternalKey(secret: Uint8Array, keyRef: string, id?: string): Promise<string>;

	/** unlock(), but trying the external slots with `secret`. */
	unlockWithExternal(secret: Uint8Array): Promise<boolean>;

	/** The current slot table (id + kind, so a passkey slot can be labelled).
	 *  Empty when unknown: plaintext, locked, or not read yet this session. */
	listEncryptionKeys(): { id: string; kind: 'password' | 'external' }[];

	/** Cancel timers, close the cross-tab channel, drop subscribers - nothing
	 *  fires into a dead app after unmount. Persisted data is untouched; the
	 *  store is not usable afterwards. */
	dispose(): void;
}

// Reserved collection name: `__`-prefixed collections belong to the library
// and are stripped from decoded snapshots before they reach the app.
const RESERVED = '__store';

// Carried in a backup's sync.json sidecar: the schema version the data was
// written under plus the merge metadata (HLC clocks, tombstones).
interface Bookkeeping {
	schemaVersion: number;
	meta: SyncMeta;
}

// Named kv keys, so a typo cannot silently lose state.
const KEY = {
	mode: 'mode',
	version: 'version',
	syncMeta: 'syncMeta',
	lastSavedAt: 'lastSavedAt',
	enc: 'enc',
	targetKind: 'targetKind',
	remoteVersion: 'remoteVersion',
	syncJournal: 'syncJournal',
	baseMeta: 'baseMeta',
	// Bumped on every cache write: one cheap kv read tells a tab whether
	// someone else wrote since it last looked (multi-tab fold).
	epoch: 'writeEpoch',
	// SHA-256 of the content last pushed. Identical content skips the save (no
	// "saving" flash, no redundant upload); an unpushed local edit hashes
	// differently and still saves.
	savedHash: 'savedHash',
	// The KV has no key enumeration, so forget() needs this index to preserve
	// every group's anti-replay counter.
	groupSeqIds: 'groupSeqIds'
} as const;

const JOURNAL_MAX = 20;

// Focus events can burst; skip repeat staleness checks inside this window.
const STALE_CHECK_MS = 20_000;

export function createLocalStore(opts: LocalStoreOptions): LocalStore {
	const {
		app,
		schemaVersion: version,
		appVersion,
		gather,
		apply,
		cache,
		readme,
		debounceMs = 800
	} = opts;
	const logger = opts.logger ?? console;
	// Hard no-plaintext policy: a store told to require encryption refuses every
	// path that could emit a cleartext travelling copy (see requireEncryption).
	const requireEncryption = opts.requireEncryption ?? false;
	const passwordPolicy = opts.passwordPolicy;

	/** Throw WEAK_PASSWORD when a policy is set and this password fails it. The
	 *  unmet requirement codes ride in the message for logs; the app previews the
	 *  same rules with checkPasswordPolicy for its live UI hint. */
	function assertPasswordPolicy(pw: string): void {
		if (!passwordPolicy) return;
		const { ok, unmet } = checkPasswordPolicy(pw, passwordPolicy);
		if (!ok) {
			throw new SelfstoreError(
				'WEAK_PASSWORD',
				`Password does not meet the policy: ${unmet.join(', ')}.`
			);
		}
	}
	// Derived collections whose merges are routine noise, not user edits - they
	// do not make a converge worth a journal entry.
	const journalSilent = new Set(opts.journalSilent ?? []);
	const sync: SyncConfig = opts.sync ?? {};
	const kv = cache.kv;

	// Multi-tab coordination (see the multiTab option). The channel and the Web
	// Lock are the LIVENESS half and are gated; the fold-on-save correctness rule
	// below (foldTabWrites) is always on - it costs one kv read per save and
	// only ever triggers when something else actually wrote the shared cache.
	const multiTab =
		opts.multiTab ?? (typeof window !== 'undefined' && typeof BroadcastChannel !== 'undefined');
	const tabId = createNode();
	const channel =
		multiTab && typeof BroadcastChannel !== 'undefined'
			? new BroadcastChannel(`selfstore:${app}`)
			: null;
	const locks: LockManager | null =
		multiTab && typeof navigator !== 'undefined' && navigator.locks ? navigator.locks : null;
	const lockName = `selfstore:${app}`;

	let mode: Mode = 'persistent';
	let targetKind: TargetKind = 'device';
	let durable: BackupTarget | null = null;
	let label: string | null = null;
	let encrypted = false;
	let needsAttention = false;
	let lastError: StoreError | null = null;
	let pendingDownload = false;
	let lastSavedAt: number | null = null;
	let ready = false;
	let saving = false;
	// SHA-256 of the content last persisted to the remote (seeded from kv on
	// boot). doSave() skips a write whose content hashes identically - a reactive
	// touch (a share link created, a derived recompute) must never re-upload an
	// unchanged backup or flash "saving". Set only after a push truly succeeds, so
	// a deferred/failed push always retries.
	let lastSavedContentHash: string | null = null;
	let pass: string | null = null;
	// Transiently held only across an unlockWithExternal converge (a user-gesture
	// passkey unlock): while set, a decode that hits an external slot resolves its
	// secret from here. Never persisted, cleared the moment the unlock pull returns.
	let pendingExternalSecret: Uint8Array | null = null;
	// The own file's password envelope, captured at read time: the raw data key
	// plus the slot table verbatim. Memory only (see setPass), refreshed on
	// every successful own-copy read, carried into every encrypted rewrite.
	let envelope: BoxEnvelope | null = null;
	// Passwordless group mode (see StoreGroupConfig). In-memory only, like the
	// password: the app re-attaches with { group } at boot.
	let group: ActiveGroup | null = null;
	let meta: SyncMeta = createMeta();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let idleTimer: ReturnType<typeof setTimeout> | undefined;
	// The remote's last seen/written version marker (per target stat()). Lets us
	// skip pulls when nothing moved, and converge before a push would overwrite
	// another replica's write.
	let remoteVersion: string | null = null;
	let journal: SyncJournalEntry[] = [];
	let lastSync: SyncJournalEntry | null = null;
	// The meta as of the last converge: lets detectConflicts tell a concurrent
	// same-record edit (both sides moved since here) from a one-sided change.
	let baseMeta: SyncMeta | null = null;
	let lastStaleCheck = 0;
	// Collections already flagged for records without a string id, so the
	// data-loss warning fires once each, not on every save.
	const warnedNoId = new Set<string>();
	// The cache write epoch this tab has already absorbed (multi-tab fold).
	let seenEpoch: string | undefined;
	// An edit was schedule()d and not yet saved: a cross-tab refresh must SAVE it
	// (folding the other tab's write in) rather than adopt that tab's state over it.
	let pendingEdit = false;
	// Bumped by every schedule(). doSave clears pendingEdit only when this is
	// unchanged across its persist: an edit landing during the gather/write is not
	// in the persisted snapshot, so its flag must survive (else a cross-tab refresh
	// would adopt over it and lose it).
	let editSeq = 0;
	// Coalesces bursts of cross-tab messages into one queued refresh ('forget' wins).
	let queuedKind: 'change' | 'forget' | null = null;

	// The blob inspectTarget last downloaded, offered to the attach that usually
	// follows in the same connect journey so the backup is fetched once, not
	// twice. One-shot and reused only when the remote provably has not moved since
	// (see takeFreshPrefetch), so a stale blob can never clobber a concurrent write.
	let prefetched: { target: BackupTarget; blob: Blob; marker: string | null; at: number } | null =
		null;
	// A prefetched blob past this age is dropped: the connect journey (pick a
	// resolution, maybe type a password) is seconds, not minutes.
	const PREFETCH_TTL_MS = 60_000;

	// Peers: other members' published copies of this store, attached read-only
	// (see attachPeer). Distinct from the multi-tab machinery above, which
	// coordinates tabs of this member around one shared cache.
	interface PeerEntry {
		id: string;
		source: PeerSource;
		/** This copy's own decryption password (a share key); falls back to the
		 *  session password when absent. */
		password?: string;
		label: string;
		lastSyncAt: number | null;
		/** Group mode: manifest member id of the last verified author. */
		author: string | null;
		lastError: StoreError | null;
		/** Last change marker seen from stat(), to skip unchanged copies. */
		lastSeen: string | null;
		/** The envelope data key captured on the last successful read of this peer's
		 *  copy (share-key model), so the NEXT fold reuses it and skips the Argon2 KDF
		 *  (~1-2s) - the heaviest recurring cost of a shared session. A rotation on
		 *  the peer's side makes the cached key fail and the read falls back to the
		 *  password (see readEnvelopeBox). Memory only, like the own-file envelope. */
		envelope: BoxEnvelope | null;
	}
	const peerList: PeerEntry[] = [];

	// Mirrors: write-only published copies of this store, re-encoded under the
	// mirror's own password (see LocalStore.attachMirror). The envelope (data
	// key + single slot for the mirror password) is minted once at first
	// publish and reused, so publishing costs no KDF pass.
	interface MirrorEntry {
		id: string;
		target: BackupTarget;
		password: string;
		envelope: BoxEnvelope | null;
		label: string;
		lastPublishAt: number | null;
		lastError: StoreError | null;
	}
	const mirrorList: MirrorEntry[] = [];

	// Replicas: secondary synced copies of this store under its OWN key (see
	// LocalStore.attachReplica). Unlike a mirror, a replica carries no password of
	// its own - it receives the same buildBlob() bytes as the primary home, so it
	// is a resilience copy of your file rather than a re-keyed share.
	interface ReplicaEntry {
		id: string;
		target: BackupTarget;
		label: string;
		lastPublishAt: number | null;
		lastError: StoreError | null;
	}
	const replicaList: ReplicaEntry[] = [];

	// Serialize the mutating flows (save / pull / forget): a focus-pull racing the
	// debounced save must not interleave gather/restore. With multiTab the same
	// chain also holds a cross-tab Web Lock, so several tabs' writes never
	// interleave on the shared cache either. Serialized functions never await
	// another serialized one (that would self-deadlock the chain and the lock).
	let chain: Promise<unknown> = Promise.resolve();
	function serialize<T>(fn: () => Promise<T>): Promise<T> {
		const exec = locks ? (): Promise<T> => locks.request(lockName, fn) as Promise<T> : fn;
		const run = chain.then(exec, exec);
		chain = run.catch(() => undefined);
		return run;
	}

	// Auto-lock: drop the in-memory password after inactivity, so an unattended
	// (e.g. shared) machine does not keep an encrypted backup unlocked
	// indefinitely. Reset on each save (user activity).
	const IDLE_LOCK_MS = 30 * 60 * 1000;

	// A kind naming a real durable target (anything but the store modes).
	const durableKind = (): boolean => !isReservedStoreMode(targetKind);

	const subs = new Set<() => void>();
	// The state snapshot is rebuilt on notify and handed out by reference, so a
	// framework adapter (useSyncExternalStore etc.) sees a stable object between
	// changes instead of a fresh literal per read.
	let stateSnapshot: LocalStoreState;
	const notify = (): void => {
		stateSnapshot = buildState();
		subs.forEach((f) => f());
	};
	// Group mode never locks: there is no password to forget (the identity is
	// the app's to persist), so the unlock gate is a password-mode concept only.
	// Locked = encrypted with no way in: neither a password nor a held envelope
	// (the data key). An external-key unlock (a passkey) holds the envelope without
	// a password, so it reads as unlocked; a password lock clears both (setPass(null)
	// drops the envelope), so it reads as locked. Group mode is never "locked" here.
	const locked = (): boolean => durableKind() && encrypted && !pass && !envelope && !group;

	/** The group read options for the own target: only copies signed by this
	 *  member's key are ours (each member's copy is single-writer; a foreign
	 *  signature in our own storage is a swap, not a copy of ours). */
	const ownGroupRead = (): GroupReadOptions | undefined =>
		group ? { identity: group.identity, authors: [group.identity.sigPub] } : undefined;

	/** The group read options for PEERS: any current manifest member may sign. */
	const peerGroupRead = (): GroupReadOptions | undefined =>
		group
			? { identity: group.identity, authors: group.manifest.members.map((m) => m.sig) }
			: undefined;

	/** Manifest seq high-water mark key (rollback protection across sessions). */
	const groupSeqKey = (id: string): string => `groupSeq:${id}`;

	/** Persist a group's seq high-water mark and record its id in the index, so
	 *  forget() can preserve every group's mark across the cache wipe (the KV has
	 *  no key enumeration). Dropping a mark would let a replayed older manifest
	 *  re-add a removed member after a forget + re-join. */
	async function persistGroupSeq(id: string, seq: number): Promise<void> {
		await kv.set(groupSeqKey(id), seq);
		const ids = (await kv.get<string[]>(KEY.groupSeqIds)) ?? [];
		if (!ids.includes(id)) await kv.set(KEY.groupSeqIds, [...ids, id]);
	}

	/** Raise the blocking gate with its reason and notify; the app renders from
	 *  the code. Notifying here (not at each call site) keeps the "every mutation
	 *  ends in notify" invariant that the cached state snapshot depends on. */
	function raiseGate(code: SelfstoreErrorCode, message: string): void {
		needsAttention = true;
		lastError = storeError(code, message);
		notify();
	}

	/** A transient, self-healing problem: reported, never gated. */
	const transient = (message: string): StoreError => storeError('TARGET_UNAVAILABLE', message);

	/** Fire-and-forget kv write with the failure logged instead of unhandled. */
	function kvSetSafe(key: string, value: unknown, what: string): void {
		kv.set(key, value).catch((e) => logger.error(`[selfstore] ${what} write failed`, e));
	}

	function armIdleLock(): void {
		clearTimeout(idleTimer);
		// Arm whenever a secret sits in memory: a typed password, or the data key of
		// an envelope (password- or external-keyed). An external-keyed store holds no
		// password, so gate on the envelope too, or its data key would never expire.
		if (encrypted && (pass || envelope)) idleTimer = setTimeout(() => lockNow(), IDLE_LOCK_MS);
	}
	function lockNow(): void {
		clearTimeout(idleTimer);
		if (!pass && !envelope) return; // nothing sensitive in hand to drop
		setPass(null); // drops the password and the envelope's data key (see setPass)
		needsAttention = true; // re-lock: the gate asks to unlock again
		notify();
	}

	// The password lives in memory only, never web storage: a reload boots the
	// target locked and re-prompts, which keeps the secret out of reach of any
	// script that could read localStorage/sessionStorage (XSS defence in depth).
	// The password envelope (raw data key + slot table, captured at read time)
	// follows the same rule: locking or forgetting the password drops it too -
	// a locked store must not keep a key that silently decrypts.
	function setPass(p: string | null): void {
		pass = p;
		if (p === null) envelope = null;
		armIdleLock();
	}

	const toCachedFiles = (snap: Snapshot): CachedFile[] =>
		snap.files.map((f) => ({
			id: f.id,
			name: f.name,
			mime: f.mime,
			blob: new Blob([f.bytes as BlobPart], { type: f.mime })
		}));

	/** The inverse: rebuild a Snapshot from the cache's stored form. */
	async function cachedToSnapshot(local: {
		collections: Record<string, unknown[]>;
		files: CachedFile[];
	}): Promise<Snapshot> {
		return {
			collections: local.collections,
			files: await Promise.all(
				local.files.map(async (f) => ({
					id: f.id,
					name: f.name,
					mime: f.mime,
					bytes: new Uint8Array(await f.blob.arrayBuffer())
				}))
			)
		};
	}

	async function buildBlob(pre?: Snapshot): Promise<Blob> {
		// Backstop the attach/setEncryption guards: even a direct exportBlob() never
		// hands back cleartext once the store is set to require encryption.
		if (requireEncryption && !encrypted && !group) {
			throw new SelfstoreError(
				'ENCRYPTION_REQUIRED',
				'requireEncryption is set: refusing to build a plaintext backup.'
			);
		}
		// Reuse a snapshot the caller already gathered (pushDurable hashes it first),
		// so a save does not gather twice for the same bytes. No caller mutates state
		// between its gather and this call.
		const snap = pre ?? (await gather());
		// Encrypted writes carry the password envelope: the held data key plus
		// every slot from the last read, so a session that knows only one of the
		// backup's passwords never drops the others. A file read before the
		// envelope era (or a fresh setting) mints its single-slot envelope here -
		// the write upgrades the container in place, same password.
		let env: BoxEnvelope | undefined;
		if (encrypted && !group) {
			if (!envelope && pass) {
				const dataKey = crypto.getRandomValues(new Uint8Array(32));
				envelope = { dataKey, slots: [await mintSlot(pass, dataKey)] };
			}
			env = envelope ?? undefined;
			// Locked mid-build (a lock() or the idle auto-lock dropped both pass and
			// envelope while this write was awaiting the network): refuse rather than
			// fall through to a plaintext write of an encrypted backup. The caller's
			// push lands in its transient path and retries after unlock; exportBlob
			// surfaces the error instead of handing back cleartext.
			if (!env) {
				throw new SelfstoreError(
					'PASSWORD_REQUIRED',
					'Cannot write the encrypted backup while locked - unlock first.'
				);
			}
		}
		// The store's bookkeeping rides its own sync.json sidecar (encrypted with
		// the data when a password is set), so the app's collections travel
		// untouched - no reserved collection injected into user data.
		// Never stamp below the schema ceiling ever seen (same rule persistLocal uses
		// for the kv version): a downgraded app must not write its lower number over
		// newer-shape data it hydrated, or other devices would skip the migration.
		const stampV = Math.max(version, schemaCeiling);
		const sidecar: Bookkeeping = { schemaVersion: stampV, meta };
		// Group mode: envelope for every current member - plus ourselves even if
		// the manifest dropped us (we must always reopen our own copy), and sign.
		const groupOpts = group
			? {
					recipients: [
						...new Set([...group.manifest.members.map((m) => m.enc), group.identity.encPub])
					],
					sign: { pub: group.identity.sigPub, priv: group.identity.sigPriv }
				}
			: undefined;
		const bytes = await writeBox(
			{ collections: snap.collections, files: snap.files },
			{ app, appVersion, schemaVersion: stampV, envelope: env, group: groupOpts, readme },
			sidecar
		);
		return new Blob([bytes as BlobPart], { type: BACKUP_MIME });
	}

	/** Publish every attached mirror: the current state (collections + files +
	 *  sync sidecar, so a reader can merge it as a replica), re-encoded under
	 *  each mirror's own password. Failures land on that mirror's state and
	 *  never gate the store or the surrounding save/converge. */
	async function publishMirrors(): Promise<void> {
		if (mirrorList.length === 0 || locked() || needsAttention) return;
		// One snapshot for the whole round: every mirror publishes the same current
		// state, so re-gathering per mirror was pure repeat work.
		const snap = await gather();
		for (const m of mirrorList) {
			try {
				if (!m.envelope) {
					const dataKey = crypto.getRandomValues(new Uint8Array(32));
					m.envelope = { dataKey, slots: [await mintSlot(m.password, dataKey)] };
				}
				const sidecar: Bookkeeping = { schemaVersion: version, meta };
				const bytes = await writeBox(
					{ collections: snap.collections, files: snap.files },
					{ app, appVersion, schemaVersion: version, envelope: m.envelope, readme },
					sidecar
				);
				await m.target.save(new Blob([bytes as BlobPart], { type: BACKUP_MIME }));
				m.lastPublishAt = Date.now();
				m.lastError = null;
			} catch (e) {
				m.lastError = isAuthExpired(e)
					? storeError('AUTH_EXPIRED', 'Write access to the mirror expired or was revoked.')
					: isSelfstoreError(e)
						? storeError(e.code, e.message)
						: transient('Mirror momentarily unreachable.');
				logger.warn(`[selfstore] mirror "${m.id}" publish failed`, e);
			}
		}
		notify();
	}

	/** Write the current backup to every replica: the SAME bytes as the primary
	 *  home (buildBlob under the store's own key), built once for the round. Best
	 *  effort - a broken replica lands on its own state and never gates the store
	 *  or the surrounding save/converge. Skipped while locked (buildBlob would
	 *  refuse) or gated. */
	async function publishReplicas(): Promise<void> {
		if (replicaList.length === 0 || locked() || needsAttention) return;
		let blob: Blob;
		try {
			blob = await buildBlob();
		} catch (e) {
			// buildBlob refuses to write an encrypted backup while locked: skip this
			// round rather than emit a plaintext replica; the next save retries.
			logger.warn('[selfstore] replica publish skipped (cannot build backup)', e);
			return;
		}
		for (const r of replicaList) {
			try {
				await r.target.save(blob);
				r.lastPublishAt = Date.now();
				r.lastError = null;
			} catch (e) {
				r.lastError = isAuthExpired(e)
					? storeError('AUTH_EXPIRED', 'Write access to the replica expired or was revoked.')
					: isSelfstoreError(e)
						? storeError(e.code, e.message)
						: transient('Replica momentarily unreachable.');
				logger.warn(`[selfstore] replica "${r.id}" publish failed`, e);
			}
		}
		notify();
	}

	/** The store's bookkeeping for a decoded remote: the schema version its data
	 *  was written under and its merge metadata, from the sync.json sidecar. A
	 *  reserved `__`-prefixed collection is never data - strip it from the app's
	 *  view rather than hand it to apply(). */
	function readBookkeeping(
		snap: Snapshot,
		sidecar: unknown
	): { fromVersion: number; sync: SyncMeta | null } {
		if (RESERVED in snap.collections) delete snap.collections[RESERVED];
		const s = sidecar as Partial<Bookkeeping> | null;
		return { fromVersion: s?.schemaVersion ?? 0, sync: s?.meta ?? null };
	}

	const migrated = (snap: Snapshot, fromV: number): Snapshot =>
		opts.migrate && fromV < version ? opts.migrate(fromV, snap) : snap;

	/** Union files by id (immutable per id, so prefer local). Orphans from deleted
	 *  records self-heal: the next gather omits them and the cache reconciles. */
	function mergeFiles(local: Snapshot['files'], remote: Snapshot['files']): Snapshot['files'] {
		const byId = new Map<string, Snapshot['files'][number]>();
		for (const f of remote) byId.set(f.id, f);
		for (const f of local) byId.set(f.id, f);
		return [...byId.values()];
	}

	/** Persist the in-memory state to L2 and stamp which records moved. The
	 *  version stamp never goes below the schema ceiling: a downgraded app must
	 *  not erase the newer-schema marker, or its next boot would drop the
	 *  SCHEMA_TOO_NEW gate and let it clobber the newer backup. */
	/** Warn (once per collection) about records the sync engine cannot track
	 *  because they have no string id at the configured path: they silently never
	 *  replicate. The message states the fix, so a dev - or an LLM reading the
	 *  console - can correct it without digging. */
	function warnUnsyncable(collections: Record<string, unknown[]>): void {
		const counts = unsyncableCounts(collections, sync);
		for (const [name, n] of Object.entries(counts)) {
			if (warnedNoId.has(name)) continue;
			warnedNoId.add(name);
			const path = idPathFor(sync, name);
			logger.warn(
				`[selfstore] ${n} record(s) in collection "${name}" have no string id at "${path}" ` +
					`and will NOT sync or persist reliably. selfstore identifies records by a string id. ` +
					`Give each record a string id, or map this collection's id field with ` +
					`createLocalStore({ sync: { ids: { ${JSON.stringify(name)}: 'yourIdField' } } }).`
			);
		}
	}

	async function persistLocal(): Promise<void> {
		// Absorb what other tabs persisted first, so this write is a superset of
		// theirs instead of an overwrite (multi-tab safety). When the fold finds a
		// newer-schema cache it gates and returns false: this stale tab must not
		// write its old-shape data over the newer one (it would stamp the newer
		// version number onto old-shape records - cross-device corruption), the same
		// never-clobber rule convergeRemote and adoptTabState follow.
		if (!(await foldTabWrites())) return;
		const snap = await gather();
		warnUnsyncable(snap.collections);
		// Trim old delete-tombstones before stamping, so the sync metadata does not
		// grow without bound (opt-in; see tombstoneHorizonMs for the safety window).
		if (opts.tombstoneHorizonMs) meta = gcTombstones(meta, Date.now() - opts.tombstoneHorizonMs);
		meta = stamp(meta, snap.collections, sync);
		await cache.saveCollections(snap.collections);
		await cache.saveFiles(toCachedFiles(snap));
		await kv.set(KEY.syncMeta, meta);
		await kv.set(KEY.version, Math.max(version, schemaCeiling));
		lastSavedAt = Date.now();
		await kv.set(KEY.lastSavedAt, lastSavedAt);
		await publishWrite('change');
	}

	/** Stamp the cache with a fresh write epoch and tell the other tabs. The
	 *  message carries no user data (a tab id and a kind); the state itself
	 *  travels through the shared cache. */
	async function publishWrite(kind: 'change' | 'forget'): Promise<void> {
		seenEpoch = createNode();
		await kv.set(KEY.epoch, seenEpoch);
		channel?.postMessage({ tab: tabId, kind });
	}

	/** Fold in whatever OTHER tabs persisted since this tab last touched the
	 *  cache. Runs at the start of every persist: the shared cache is treated as
	 *  one more replica and merged with the app's live state - in-flight edits are
	 *  stamped first, so they keep their (latest) clocks - which is what makes a
	 *  save from one tab unable to erase another tab's records or resurrect its
	 *  deletes. One kv read when nothing changed. */
	async function foldTabWrites(): Promise<boolean> {
		const current = await kv.get<string>(KEY.epoch);
		if (current === undefined || current === seenEpoch) return true;
		const local = await cache.load();
		if (!local) {
			seenEpoch = current;
			return true;
		}
		const storedV = (await kv.get<number>(KEY.version)) ?? version;
		if (isNewerSchema(storedV)) {
			// A newer-schema tab wrote the cache: this stale tab gates instead of
			// merging shapes it cannot migrate. Reloading the tab resumes. Return
			// false so persistLocal ABORTS its write - never clobber the newer cache.
			gateNewerSchema(storedV);
			seenEpoch = current;
			return false;
		}
		const tabMeta = await kv.get<SyncMeta>(KEY.syncMeta);
		if (!tabMeta) {
			seenEpoch = current;
			return true;
		}
		const snap = migrated(await cachedToSnapshot(local), storedV);
		const live = await gather();
		meta = stamp(meta, live.collections, sync); // in-flight edits win over older tab clocks
		const merged = merge(
			{ collections: live.collections, meta },
			{ collections: snap.collections, meta: tabMeta },
			sync
		);
		meta = merged.meta;
		apply({ collections: merged.collections, files: mergeFiles(live.files, snap.files) });
		seenEpoch = current; // only after the fold landed, so a failure retries
		return true;
	}

	/** Replace this tab's state with what another tab persisted (only called with
	 *  no local edit in flight). Data + sync bookkeeping; the journal keeps this
	 *  tab's own in-memory conflict values, and a durable target's connection
	 *  stays per-tab. */
	async function adoptTabState(): Promise<void> {
		const current = await kv.get<string>(KEY.epoch);
		if (current === seenEpoch) return;
		const local = await cache.load();
		const storedV = (await kv.get<number>(KEY.version)) ?? version;
		// Same rule as boot: newer-schema data still hydrates (it is the user's),
		// but the gate blocks pushes from this stale tab.
		if (isNewerSchema(storedV)) gateNewerSchema(storedV);
		if (local) apply(migrated(await cachedToSnapshot(local), storedV));
		else apply({ collections: {}, files: [] });
		meta = (await kv.get<SyncMeta>(KEY.syncMeta)) ?? createMeta();
		baseMeta = (await kv.get<SyncMeta>(KEY.baseMeta)) ?? null;
		lastSavedAt = (await kv.get<number>(KEY.lastSavedAt)) ?? null;
		remoteVersion = (await kv.get<string>(KEY.remoteVersion)) ?? null;
		// Adopt the other tab's remote fingerprint too (it pushed, or forgot and
		// cleared it): keeping our own stale hash would wrongly skip a needed push.
		lastSavedContentHash = (await kv.get<string>(KEY.savedHash)) ?? null;
		if (durable) {
			// Another tab may have added or removed the backup password: refresh the
			// flag so this tab re-locks (and asks) instead of pushing the wrong setting.
			encrypted = (await kv.get(KEY.enc)) === true;
			needsAttention = needsAttention || locked();
		}
		seenEpoch = current;
		notify();
	}

	/** Coalesced cross-tab refresh: an idle tab adopts the other tab's state, a
	 *  tab holding an unsaved edit saves it instead (the save folds the other
	 *  write, so both survive), and a forget() elsewhere drops local state. */
	function onTabMessage(kind: 'change' | 'forget'): void {
		if (!ready || mode !== 'persistent') return;
		if (queuedKind) {
			if (kind === 'forget') queuedKind = 'forget';
			return;
		}
		queuedKind = kind;
		serialize(async () => {
			const k = queuedKind;
			queuedKind = null;
			if (k === 'forget') {
				clearTimeout(timer);
				pendingEdit = false; // the other tab wiped on purpose: the edit dies with the data
				mode = (await kv.get(KEY.mode)) === 'ephemeral' ? 'ephemeral' : 'persistent';
				const savedKind = (await kv.get<TargetKind>(KEY.targetKind)) ?? 'device';
				if (durable) {
					await dropDurable({ keepSession: true }); // that tab owns the disconnect side-effects
				}
				// Adopt the wiped kind even in a tab with no durable (file-manual): else
				// it kept 'file-manual', and its next save re-armed a download of the
				// now-empty backup while kv already said 'device'.
				targetKind = savedKind;
				pendingDownload = false;
				seenEpoch = undefined; // that tab cleared and rewrote: adopt unconditionally
				await adoptTabState();
			} else if (pendingEdit) {
				clearTimeout(timer);
				await doSave(); // folds the other tab's write and persists our edit with it
			} else {
				await adoptTabState();
			}
		}).catch((e) => logger.error('[selfstore] cross-tab refresh failed', e));
	}

	if (channel) {
		channel.onmessage = (ev: MessageEvent): void => {
			const msg = ev.data as { tab?: string; kind?: 'change' | 'forget' } | null;
			if (msg && msg.tab !== tabId && (msg.kind === 'change' || msg.kind === 'forget')) {
				onTabMessage(msg.kind);
			}
		};
	}

	/** The blob inspectTarget stashed for `t`, but only when it is still safe to
	 *  reuse instead of downloading again: same target, fresh entry, and - the
	 *  safety gate - the remote's change marker is unchanged since the inspect, so
	 *  the blob still is the remote. A moved remote (or a target that cannot report
	 *  a marker) returns null, and the caller does a live load. One-shot: the entry
	 *  is consumed whatever the outcome. */
	async function takeFreshPrefetch(t: BackupTarget): Promise<Blob | null> {
		const p = prefetched;
		prefetched = null; // one-shot, whatever we decide below
		if (!p || p.target !== t || p.marker === null) return null;
		if (Date.now() - p.at > PREFETCH_TTL_MS) return null;
		let now: string | null;
		try {
			now = t.stat ? await t.stat() : null;
		} catch {
			return null; // cannot confirm it did not move: load live
		}
		return now !== null && now === p.marker ? p.blob : null;
	}

	/** The remote's current change marker, or null when the target cannot tell. */
	async function statRemote(): Promise<string | null> {
		if (!durable?.stat) return null;
		try {
			return await durable.stat();
		} catch {
			return null;
		}
	}

	/** Readiness check for the encryption-management flows (setEncryption and the
	 *  key-slot methods), which call isReady() OUTSIDE the store's normal push
	 *  path. isReady() now THROWS AuthExpired on a genuine loss: raise the gate
	 *  before it propagates, so the store reads needs-attention instead of a false
	 *  "saved", then rethrow so the caller knows the op did not run. Throws
	 *  TARGET_WRITE_FAILED for a transient not-ready. */
	async function requireReady(where: string): Promise<void> {
		let ok: boolean;
		try {
			ok = await durable!.isReady();
		} catch (e) {
			if (isAuthExpired(e)) {
				raiseGate('AUTH_EXPIRED', 'Access to the destination expired or was revoked.');
			}
			throw e;
		}
		if (!ok) {
			throw new SelfstoreError(
				'TARGET_WRITE_FAILED',
				`${where}(): the destination is unreachable; try again online.`
			);
		}
	}

	async function setRemoteVersion(v: string | null): Promise<void> {
		remoteVersion = v;
		if (v === null) await kv.del(KEY.remoteVersion);
		else await kv.set(KEY.remoteVersion, v);
	}

	/** The persisted form of a journal entry: conflict VALUES are redacted. The
	 *  kv bookkeeping is not encrypted at rest (only the collections snapshot and
	 *  files are sealed), so full user records must never travel there - the live
	 *  in-memory journal keeps the values for the session's resolution UI. */
	function redactForStorage(entries: SyncJournalEntry[]): SyncJournalEntry[] {
		return entries.map((e) =>
			e.conflicts
				? {
						...e,
						conflicts: e.conflicts.map(({ collection, id, kept }) => ({ collection, id, kept }))
					}
				: e
		);
	}

	/** Append a converge to the journal - only when it changed something the user
	 *  can see (derived collections are silent). Returns the entry, or null. */
	function recordJournal(
		delta: Record<string, CollectionChanges>,
		source: SyncSource,
		conflicts: Conflict[] = []
	): SyncJournalEntry | null {
		const visible = Object.fromEntries(
			Object.entries(delta).filter(([name]) => !journalSilent.has(name))
		);
		if (Object.keys(visible).length === 0) return null;
		const entry: SyncJournalEntry = { at: Date.now(), source, changes: visible };
		if (conflicts.length > 0) entry.conflicts = conflicts;
		journal = [entry, ...journal].slice(0, JOURNAL_MAX);
		lastSync = entry;
		kvSetSafe(KEY.syncJournal, redactForStorage(journal), 'journal');
		return entry;
	}

	async function pushDurable(source: SyncSource = 'push'): Promise<boolean> {
		if (!durable || locked() || needsAttention) return false;
		try {
			// isReady() rethrows a genuine auth loss and returns false only for a
			// transient hiccup, so a cold-start never masquerades as "not ready".
			if (!(await durable.isReady())) {
				// Momentarily unreachable: the edit is safe in the local cache. Leave the
				// connection attached and let the next scheduled save / focus-sync retry.
				// Never raise the blocking reconnect gate over a still-valid session.
				lastError = transient('Save deferred: destination momentarily unreachable.');
				return false;
			}
			// Converge first when another replica wrote since our last sync: a blind
			// push would hide its changes from every replica until its next pull.
			const seen = await statRemote();
			if (seen !== null && remoteVersion !== null && seen !== remoteVersion) {
				await pullRemoteIntoLocal(source, seen);
				if (locked() || needsAttention) return false; // the pull hit a lock: never clobber
			}
			// Skip the upload when the remote already holds this exact content: a
			// converge that only adopted the remote, or a reactive re-save, would
			// otherwise re-encrypt and re-upload byte-identical data - the commonest
			// recurring waste of a synced session, and the "enregistrements inutiles"
			// a user sees. One gather() here feeds both the fingerprint and the blob.
			const snap = await gather();
			const digest = await contentDigest(snap);
			if (digest === lastSavedContentHash) {
				lastError = null;
				return true;
			}
			const written = await durable.save(await buildBlob(snap));
			await setRemoteVersion(typeof written === 'string' ? written : await statRemote());
			// Remember what reached the remote, so the next passive save (or a converge
			// that changed nothing) skips a byte-identical upload.
			lastSavedContentHash = digest;
			kvSetSafe(KEY.savedHash, digest, 'savedHash');
			lastError = null;
			return true;
		} catch (e) {
			if (isAuthExpired(e)) {
				// The session is genuinely gone: only a user gesture (reconnect) fixes it.
				raiseGate('AUTH_EXPIRED', 'Access to the destination expired or was revoked.');
			} else if (isSelfstoreError(e) && e.code === 'TARGET_GONE') {
				// The bound destination is permanently unwritable (the file was deleted
				// or moved, access was withdrawn, storage is full): retrying writes the
				// same doomed request forever - the silent "momentarily unreachable"
				// trap - so gate and let the user reconnect to a fresh file or free
				// space. This is a false "saved" otherwise: persistLocal already bumped
				// lastSavedAt, so a swallowed push would read as safely saved.
				raiseGate('TARGET_GONE', e.message);
			} else {
				// Transient (offline, cold-start 5xx, network reset): keep the connection,
				// the edit waits in the local cache, the next save/sync retries. Raising
				// the reconnect gate here is exactly the spurious popin we must avoid.
				lastError = transient('Save deferred: destination momentarily unreachable.');
			}
			logger.error('[selfstore] push to durable failed', e);
			return false;
		}
	}

	/** SHA-256 of the snapshot's user content (collections + files) - the bytes a
	 *  save would write, minus the encryption envelope and sync sidecar. Two saves
	 *  with the same digest push byte-identical user data, so the second is a
	 *  no-op. Stable across gathers of unchanged data (files sorted by id). */
	async function contentDigest(snap: Snapshot): Promise<string> {
		const enc = new TextEncoder();
		const parts: Uint8Array[] = [enc.encode(JSON.stringify(snap.collections))];
		for (const f of [...snap.files].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
			parts.push(enc.encode(`\u001f${f.id}\u001f${f.mime}\u001f`), f.bytes);
		}
		let len = 0;
		for (const p of parts) len += p.length;
		const buf = new Uint8Array(len);
		let off = 0;
		for (const p of parts) {
			buf.set(p, off);
			off += p.length;
		}
		const digest = await crypto.subtle.digest('SHA-256', buf);
		return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
	}

	async function doSave(): Promise<void> {
		if (mode !== 'persistent') return;
		// Snapshot the edit counter: an edit that lands while this save is gathering
		// or writing bumps it, and its flag must not be cleared below (that edit is
		// not in what we persist). See editSeq.
		const seq = editSeq;
		// Skip a save whose content is byte-identical to the last one pushed: a
		// reactive touch (a share link created, a derived store recomputed) must
		// not flash "saving" or re-upload an unchanged backup. A genuine edit - or
		// an edit not yet pushed to the remote - hashes differently and still
		// saves, so this only ever drops redundant work, never a real change.
		const digest = await contentDigest(await gather());
		if (digest === lastSavedContentHash) {
			if (editSeq === seq) pendingEdit = false;
			return;
		}
		saving = true;
		notify();
		try {
			await persistLocal();
			if (editSeq === seq) pendingEdit = false; // an edit that arrived mid-persist stays in flight
			if (targetKind === 'file-manual') {
				// No remote to reach: the downloaded file is the copy. Remember the
				// content so a passive re-save does not re-arm the download for nothing.
				lastSavedContentHash = digest;
				kvSetSafe(KEY.savedHash, digest, 'savedHash');
				pendingDownload = true;
				return;
			}
			// pushDurable owns the remote fingerprint now: it records lastSavedContentHash
			// only on a real push (a deferred/failed/permanent-gone push leaves it
			// untouched, so the next save retries), and skips a byte-identical upload.
			await pushDurable();
			// The published copies follow every local edit (best-effort, per-mirror
			// errors only - see publishMirrors).
			await publishMirrors();
			await publishReplicas();
		} finally {
			saving = false;
			notify();
		}
	}

	const save = (): Promise<void> => serialize(doSave);

	/** PURE check for a silent downgrade/substitution: we expect an encrypted
	 *  backup but the loaded file's header says it is unencrypted. An attacker
	 *  with write access to the destination could otherwise swap in a crafted
	 *  plaintext backup that loads with no password prompt. In group mode the
	 *  bar is higher still: anything that is not a group copy (plaintext or
	 *  password mode) is a substitution. The caller decides what to do (gate). */
	async function isDowngraded(remote: Blob): Promise<boolean> {
		if (!encrypted) return false;
		try {
			const h = await inspect(remote);
			if (group) return h.keying !== GROUP_KEYING;
			return h.encryption === 'none';
		} catch {
			return false; // unreadable header: let the normal import path handle it
		}
	}

	/** A decoded remote: the app snapshot plus its opaque sync.json sidecar. */
	type Decoded = { snapshot: Snapshot; sidecar: unknown };

	/** Decode a remote backup with the shared safety rails: the downgrade guard,
	 *  and the password/lock (or group trust) protocol. Resolves to the decoded
	 *  snapshot + sidecar, or 'locked' when the caller must not touch either side
	 *  (gate raised, reason in lastError). Any other decode failure PROPAGATES -
	 *  a genuine bug must never read as "nothing changed". */
	async function importLocked(remote: Blob): Promise<Decoded | 'locked'> {
		if (await isDowngraded(remote)) {
			raiseGate(
				'UNEXPECTEDLY_UNENCRYPTED',
				group
					? 'Expected a signed group copy - found something else. Refused for safety.'
					: 'Unexpected unencrypted backup - refused for safety.'
			);
			return 'locked';
		}
		try {
			const r = await readBoxWithSync(
				await asBytes(remote),
				pass ?? undefined,
				ownGroupRead(),
				envelope?.dataKey,
				// Only during a passkey unlock (a user gesture) is a secret in hand for
				// an external slot; a background converge has none and reads via the held
				// data key or gates for the user to unlock.
				pendingExternalSecret ? async () => pendingExternalSecret : undefined
			);
			// Capture (or refresh) the envelope: another device may have added or
			// removed a slot since our last read. A plain (never encrypted) copy
			// reads with none - the next password write mints it (buildBlob).
			if (!group) envelope = r.envelope ?? null;
			return r;
		} catch (e) {
			if (isSelfstoreError(e) && (e.code === 'PASSWORD_REQUIRED' || e.code === 'DECRYPT_FAILED')) {
				// The remote is genuinely encrypted (a key is missing or wrong). Reconcile
				// the local flag to that truth: a device that attached without a key - an
				// external-keyed backup has no attach-time secret to offer, unlike a
				// password - would otherwise carry encrypted=false and never read as
				// locked(), so neither unlock() nor unlockWithExternal() (both of which
				// require locked()) could ever clear the gate.
				if (!encrypted) {
					encrypted = true;
					kvSetSafe(KEY.enc, true, 'enc');
				}
				setPass(null);
				raiseGate(e.code, e.message);
				return 'locked'; // wrong/missing key: re-lock and ask, never clobber
			}
			if (
				isSelfstoreError(e) &&
				(e.code === 'IDENTITY_REQUIRED' ||
					e.code === 'SIGNATURE_INVALID' ||
					e.code === 'NOT_A_RECIPIENT')
			) {
				// Group trust failed on our own copy (foreign signature, missing
				// identity, no envelope): gate, never clobber either side.
				raiseGate(e.code, e.message);
				return 'locked';
			}
			throw e;
		}
	}

	// The highest schema version ever SEEN on this device's data (cache or
	// remote). While it exceeds our own, the gate stays up - and persistLocal
	// must never stamp a LOWER version over it, or a downgraded app would clear
	// the gate on its next boot and clobber the newer backup.
	let schemaCeiling = version;

	/** PURE: is this data written by a newer app schema than ours? */
	const isNewerSchema = (fromVersion: number): boolean => fromVersion > version;

	/** Command: record the newer schema and raise the blocking gate. An older app
	 *  must neither apply a shape it cannot migrate nor push its older shape over
	 *  it; only updating the app resolves this. */
	function gateNewerSchema(fromVersion: number): void {
		schemaCeiling = Math.max(schemaCeiling, fromVersion);
		raiseGate(
			'SCHEMA_TOO_NEW',
			`Backup written by schema v${fromVersion}; this app reads v${version}. Update the app.`
		);
	}

	/** Three-way converge the local state with a decoded remote snapshot: merge
	 *  when it carries sync metadata, else adopt the foreign copy if this device
	 *  is fresh. Resolves to the journal entry when the merge changed local data. */
	async function convergeRemote(
		snap: Snapshot,
		sidecar: unknown,
		source: SyncSource
	): Promise<SyncJournalEntry | null> {
		const { fromVersion, sync: remoteMeta } = readBookkeeping(snap, sidecar);
		if (isNewerSchema(fromVersion)) {
			gateNewerSchema(fromVersion);
			return null;
		}
		const snapM = migrated(snap, fromVersion);
		if (!remoteMeta) {
			await adoptForeign(snapM);
			return null;
		}
		const local = await gather();
		// Stamp before merging: an edit still inside the debounce window carries no
		// clock yet and would lose to any newer remote clock. Stamping now gives it
		// its rightful (latest) clock, so an in-flight edit survives the converge.
		meta = stamp(meta, local.collections, sync);
		const localState = { collections: local.collections, meta };
		const remoteState = { collections: snapM.collections, meta: remoteMeta };
		const result = merge(localState, remoteState, sync);
		// Informational: same-record edits both sides made since the last converge.
		// merge() already picked the latest; this reports what was overwritten, with
		// both values, so the app can surface (or restore) the losing side.
		const conflicts = detectConflicts(localState, remoteState, sync, baseMeta ?? undefined);
		const delta = changes(local.collections, result.collections, sync);
		meta = result.meta;
		baseMeta = meta;
		kvSetSafe(KEY.baseMeta, meta, 'baseMeta');
		apply({ collections: result.collections, files: mergeFiles(local.files, snapM.files) });
		// Record what the remote CURRENTLY holds (its decoded content, in our
		// migrated form). The push-back that follows this converge fingerprints the
		// merged local state and compares: equal when our merge added nothing (the
		// remote already has it - no ping-pong re-upload), different when we
		// contributed a newer value (so the needed push still happens). Without this
		// the fingerprint kept describing our last push, causing either a wasteful
		// full re-upload every passive sync, or - worse - skipping a push whose
		// merged content happened to match that stale fingerprint.
		lastSavedContentHash = await contentDigest({
			collections: snapM.collections,
			files: snapM.files
		});
		kvSetSafe(KEY.savedHash, lastSavedContentHash, 'savedHash');
		await persistLocal();
		if (conflicts.length) {
			logger.warn(
				'[selfstore] concurrent edits auto-resolved (latest kept): ' +
					conflicts.map((c) => `${c.collection}/${c.id}`).join(', ')
			);
		}
		return recordJournal(delta, source, conflicts);
	}

	/** Load + decode + converge only (no push back). `seen` is the remote marker
	 *  stat'ed before the load: a write landing mid-load still reads as stale on
	 *  the next check instead of being marked seen-but-unmerged. Resolves to the
	 *  journal entry, 'locked' (missing/wrong password, a refused plaintext swap,
	 *  or a newer-schema remote - the caller must not push), or null when nothing
	 *  changed. */
	async function pullRemoteIntoLocal(
		source: SyncSource,
		seen?: string | null
	): Promise<SyncJournalEntry | 'locked' | null> {
		if (!durable) return null;
		const marker = seen === undefined ? await statRemote() : seen;
		let remote: Blob | null = null;
		try {
			// Reuse the blob inspectTarget just downloaded when the remote has not
			// moved since (the connect journey), else load live. `marker` above was
			// stat'ed the same way the reuse is gated on, so it stays consistent.
			remote = (await takeFreshPrefetch(durable)) ?? (await durable.load());
		} catch {
			/* offline or transient: keep local, push later */
		}
		if (!remote) return null;
		const decoded = await importLocked(remote);
		if (decoded === 'locked') return 'locked';
		const entry = await convergeRemote(decoded.snapshot, decoded.sidecar, source);
		if (needsAttention) return 'locked'; // newer schema: never mark seen, never push
		await setRemoteVersion(marker);
		return entry;
	}

	/** Fold every attached peer's published copy into local state: pull each copy
	 *  (a cheap stat() skips unchanged ones), decode it with the same rails as the
	 *  own target, and merge it as one more replica - exactly the multi-device
	 *  merge, sourced from a read-only link. Per-peer failures are recorded on
	 *  that peer's state and never gate the store or block the surrounding
	 *  converge: only the own target raises blocking gates. Resolves to the last
	 *  journal entry a fold produced, or null when nothing changed. */
	async function foldPeers(source: SyncSource): Promise<SyncJournalEntry | null> {
		if (peerList.length === 0 || locked() || needsAttention) return null;
		let entry: SyncJournalEntry | null = null;
		let folded = false;
		for (const p of peerList) {
			try {
				let marker: string | null = null;
				if (p.source.stat) {
					try {
						marker = await p.source.stat();
					} catch (e) {
						if (isAuthExpired(e)) throw e; // a genuine read-access loss: record it below
						marker = null; // cannot tell: fall through to a full load
					}
					if (marker !== null && marker === p.lastSeen) {
						p.lastError = null;
						continue; // unchanged since the last fold
					}
				}
				const remote = await p.source.load();
				if (!remote) {
					// The member has not published a copy yet: nothing to fold.
					p.lastError = null;
					p.lastSyncAt = Date.now();
					continue;
				}
				if (p.password !== undefined) {
					// This copy travels under its own key: a plaintext blob in its
					// place is a substitution, refused per-peer - even when the own
					// own file is unencrypted (the mirror model's normal shape).
					try {
						if ((await inspect(remote)).encryption === 'none') {
							p.lastError = storeError(
								'UNEXPECTEDLY_UNENCRYPTED',
								'Peer copy unexpectedly unencrypted - refused for safety.'
							);
							continue;
						}
					} catch {
						// Unreadable header: the read below reports the real problem.
					}
				} else if (await isDowngraded(remote)) {
					// Same swap guard as the own target - we expect encrypted (or signed
					// group) copies and this is not one - scoped to this peer, no gate.
					p.lastError = storeError(
						'UNEXPECTEDLY_UNENCRYPTED',
						group
							? 'Peer copy is not a signed group copy - refused for safety.'
							: 'Peer copy unexpectedly unencrypted - refused for safety.'
					);
					continue;
				}
				const {
					snapshot,
					sidecar,
					author,
					envelope: peerEnv
				} = await readBoxWithSync(
					await asBytes(remote),
					p.password ?? pass ?? undefined,
					peerGroupRead(),
					p.envelope?.dataKey // reuse the data key: skip the Argon2 KDF unless rotated
				);
				// Cache the (possibly refreshed) data key for the next fold. A rotation
				// makes the reused key fail above, so readBoxWithSync fell back to the
				// password and returns the new envelope here.
				if (peerEnv) p.envelope = peerEnv;
				const { fromVersion, sync: peerMeta } = readBookkeeping(snapshot, sidecar);
				if (isNewerSchema(fromVersion)) {
					// That member runs a newer app. Skip their copy (we cannot read that
					// shape safely) without gating: we never write their copy, so there is
					// nothing we could clobber - unlike the own-target case.
					p.lastError = storeError(
						'SCHEMA_TOO_NEW',
						`Peer copy written by schema v${fromVersion}; this app reads v${version}.`
					);
					continue;
				}
				if (!peerMeta) {
					// A copy with no sync metadata cannot merge (a pre-sync backup, not a
					// published copy): flag the link rather than guess at clobbering.
					p.lastError = storeError(
						'BAD_FORMAT',
						'Peer copy carries no sync metadata; not a published copy.'
					);
					continue;
				}
				const snapM = migrated(snapshot, fromVersion);
				const local = await gather();
				// Stamp first, as everywhere: an in-flight edit keeps its (latest) clock.
				meta = stamp(meta, local.collections, sync);
				const localState = { collections: local.collections, meta };
				const remoteState = { collections: snapM.collections, meta: peerMeta };
				const result = merge(localState, remoteState, sync);
				const conflicts = detectConflicts(localState, remoteState, sync, baseMeta ?? undefined);
				const delta = changes(local.collections, result.collections, sync);
				meta = result.meta;
				baseMeta = meta;
				kvSetSafe(KEY.baseMeta, meta, 'baseMeta');
				apply({ collections: result.collections, files: mergeFiles(local.files, snapM.files) });
				folded = true;
				entry = recordJournal(delta, source, conflicts) ?? entry;
				p.lastError = null;
				p.lastSyncAt = Date.now();
				p.lastSeen = marker;
				// Group mode: surface WHO published this copy (verified, not claimed).
				p.author = author
					? (group?.manifest.members.find((m) => m.sig === author)?.id ?? null)
					: null;
			} catch (e) {
				p.lastError = isAuthExpired(e)
					? storeError('AUTH_EXPIRED', 'Read access to the peer copy expired or was revoked.')
					: isSelfstoreError(e)
						? storeError(e.code, e.message)
						: transient('Peer momentarily unreachable.');
				logger.warn(`[selfstore] peer "${p.id}" fold failed`, e);
			}
		}
		// One persist for the whole round (each fold already applied in memory).
		if (folded) await persistLocal();
		return entry;
	}

	/** Cheap staleness check across peers: true when any copy looks changed or
	 *  cannot tell cheaply. Never throws - a failing stat reads as "go check",
	 *  and the fold records the real error. */
	async function anyPeerMoved(): Promise<boolean> {
		for (const p of peerList) {
			if (!p.source.stat) return true;
			try {
				const marker = await p.source.stat();
				if (marker === null || marker !== p.lastSeen) return true;
			} catch {
				return true;
			}
		}
		return false;
	}

	/** Pull the durable copy and converge it with local (or adopt a foreign one),
	 *  fold the attached peers in, then push the result back so the remote
	 *  carries the merged state too (which is what lets peers gossip through us). */
	async function doPull(source: SyncSource): Promise<SyncJournalEntry | null> {
		if (!durable && peerList.length === 0 && mirrorList.length === 0) return null;
		let entry: SyncJournalEntry | null = null;
		if (durable) {
			const r = await pullRemoteIntoLocal(source);
			if (r === 'locked') return null; // locked: skip peers and the push too, never clobber
			entry = r;
		}
		entry = (await foldPeers(source)) ?? entry;
		if (durable) await pushDurable(source);
		// Refresh the published copies when this converge moved data (a fold
		// from a peer must reach the mirror readers too), and on the connect
		// round so a freshly attached mirror exists right away.
		if (entry !== null || source === 'connect') {
			await publishMirrors();
			await publishReplicas();
		}
		notify();
		return entry;
	}

	const pull = (source: SyncSource): Promise<SyncJournalEntry | null> =>
		serialize(() => doPull(source));

	/** Replace local data with the target's backup, then make the target match. */
	async function loadFromRemote(): Promise<void> {
		if (!durable) return;
		const remote = (await takeFreshPrefetch(durable)) ?? (await durable.load());
		if (remote) {
			const decoded = await importLocked(remote);
			if (decoded === 'locked') return; // gate raised: never clobber either side
			const { fromVersion } = readBookkeeping(decoded.snapshot, decoded.sidecar);
			if (isNewerSchema(fromVersion)) {
				gateNewerSchema(fromVersion);
				return;
			}
			apply(migrated(decoded.snapshot, fromVersion));
			await persistLocal();
		}
		await pushDurable();
	}

	/** A backup with no sync metadata: valid per the spec (hand-authored or
	 *  written by another tool), but there is nothing to merge with. Adopt it on
	 *  a fresh device; when this device already holds data, keep local - the next
	 *  push overwrites the remote with a merge-capable copy. */
	async function adoptForeign(snap: Snapshot): Promise<void> {
		const local = await cache.load();
		if (local) return;
		apply(snap);
		await persistLocal();
	}

	async function becomePersistent(): Promise<void> {
		if (mode !== 'persistent') {
			mode = 'persistent';
			await kv.set(KEY.mode, 'persistent');
		}
		await cache.requestPersistent?.();
	}

	/** keepSession: drop the target object but leave its credentials/session
	 *  intact (a same-account backup switch must not kill the shared auth). */
	async function dropDurable({
		keepSession = false
	}: { keepSession?: boolean } = {}): Promise<void> {
		if (durable && !keepSession) await durable.disconnect();
		durable = null;
		label = null;
		encrypted = false;
		needsAttention = false;
		pendingDownload = false;
		setPass(null);
		group = null; // the group config belongs to the departed target's attach
		await kv.del(KEY.enc);
		await setRemoteVersion(null); // the marker belongs to the departed target
		// The content fingerprint describes what reached the DEPARTED remote. Carried
		// into a new (or no) target it would wrongly skip the seed push to the new
		// destination - leaving it unwritten while the status reads "saved", then
		// resurrecting the old backup on the next converge - or suppress a local
		// persist of an edit-then-revert. Clear it with the marker, same reasoning.
		lastSavedContentHash = null;
		await kv.del(KEY.savedHash);
	}

	async function doForget(): Promise<void> {
		// Empty the in-memory state first, so the UI clears immediately (no reload)
		// and the snapshot we are about to persist/push is the empty one.
		apply({ collections: {}, files: [] });

		if (durable && !locked() && !needsAttention) {
			// A destination is connected: keep it attached and overwrite its backup
			// with the empty snapshot, so the data is gone here and on the target
			// while the connection (and its encryption/passphrase) is preserved.
			// Keep the existing meta (do not reset it): stamping the now-empty state
			// against it tombstones every record, so other devices drop them on the
			// next sync instead of re-propagating their copies back.
			await persistLocal(); // stamp(meta, {}) -> tombstones; stamps lastSavedAt
			await pushDurable(); // pushes empty data + the deletions to the target
		} else {
			// No destination (or it is locked/unreachable): nothing to propagate.
			// Forget everything on this device and reset to the cache-only default.
			// The group rollback high-water marks are SAFETY counters, not user data:
			// preserve every group's mark (not just the current one) across the wipe,
			// so a later re-join of any previously-seen group cannot be handed a
			// replayed older manifest (re-adding a removed member).
			const seqIds = (await kv.get<string[]>(KEY.groupSeqIds)) ?? [];
			const savedSeqs: [string, number][] = [];
			for (const id of seqIds) {
				const v = await kv.get<number>(groupSeqKey(id));
				if (v !== undefined) savedSeqs.push([id, v]);
			}
			meta = createMeta();
			await cache.clear();
			await dropDurable();
			for (const [id, v] of savedSeqs) await persistGroupSeq(id, v);
			mode = 'persistent';
			targetKind = 'device';
			lastSavedAt = null;
			await kv.set(KEY.mode, 'persistent');
			await kv.set(KEY.targetKind, 'device');
			await kv.set(KEY.syncMeta, meta);
			await kv.del(KEY.lastSavedAt);
			// The wipe reset the merge history (no tombstones): other tabs must DROP
			// their in-memory copies rather than fold them back in.
			await publishWrite('forget');
		}
		notify();
	}

	function buildState(): LocalStoreState {
		return {
			ready,
			mode,
			targetKind,
			label,
			encrypted,
			locked: locked(),
			saving,
			lastSavedAt,
			status: deriveStatus({
				persistent: mode === 'persistent',
				targetKind,
				saving,
				needsAttention,
				locked: locked(),
				pendingDownload
			}),
			lastError,
			journal,
			lastSync,
			peers: peerList.map(({ id, label: l, lastSyncAt, author, lastError: err }) => ({
				id,
				label: l,
				lastSyncAt,
				author,
				lastError: err
			})),
			mirrors: mirrorList.map(({ id, label: l, lastPublishAt, lastError: err }) => ({
				id,
				label: l,
				lastPublishAt,
				lastError: err
			})),
			replicas: replicaList.map(({ id, label: l, lastPublishAt, lastError: err }) => ({
				id,
				label: l,
				lastPublishAt,
				lastError: err
			}))
		};
	}
	stateSnapshot = buildState();

	return {
		get state(): LocalStoreState {
			return stateSnapshot;
		},

		subscribe(fn) {
			subs.add(fn);
			return () => subs.delete(fn);
		},

		async init() {
			mode = (await kv.get(KEY.mode)) === 'ephemeral' ? 'ephemeral' : 'persistent';
			if (mode === 'ephemeral') {
				ready = true;
				notify();
				return;
			}
			// Persistent from the start: ask the browser not to evict the cache even
			// before any durable home is attached (best-effort, never blocks boot).
			void Promise.resolve(cache.requestPersistent?.()).catch(() => undefined);

			const local = await cache.load();
			if (local) {
				const snap = await cachedToSnapshot(local);
				const storedV = (await kv.get<number>(KEY.version)) ?? version;
				// A cache written by a newer schema (the app was downgraded) still
				// hydrates - the data is the user's - but the gate blocks pushes so the
				// older app can never clobber the newer shape elsewhere.
				if (isNewerSchema(storedV)) gateNewerSchema(storedV);
				apply(migrated(snap, storedV));
			}

			lastSavedAt = (await kv.get<number>(KEY.lastSavedAt)) ?? null;
			// The fingerprint of what we last pushed: a passive save that matches it
			// (a reactive touch after boot, no real edit) is a no-op, but a local
			// edit that never reached the remote hashes differently and still saves.
			lastSavedContentHash = (await kv.get<string>(KEY.savedHash)) ?? null;
			meta = (await kv.get<SyncMeta>(KEY.syncMeta)) ?? createMeta();
			await kv.set(KEY.syncMeta, meta);
			baseMeta = (await kv.get<SyncMeta>(KEY.baseMeta)) ?? null;
			remoteVersion = (await kv.get<string>(KEY.remoteVersion)) ?? null;
			journal = (await kv.get<SyncJournalEntry[]>(KEY.syncJournal)) ?? [];
			// Everything above reflects the cache as of now: later folds only need to
			// absorb writes that land after this point.
			seenEpoch = await kv.get<string>(KEY.epoch);

			const savedKind = (await kv.get<TargetKind>(KEY.targetKind)) ?? 'device';
			if (!isReservedStoreMode(savedKind)) {
				encrypted = (await kv.get(KEY.enc)) === true;
				// Show the destination we are RESTORING right away: during the (often
				// slow) reconnect handshake the profile reads "Google Drive"
				// (connecting), not "this device". A failed restore resets it to
				// 'device' in the else-branch below; durable stays null until it lands,
				// and schedule() is inert until ready, so no save fires meanwhile.
				targetKind = savedKind;
				notify();
				// restoreTarget is app code (rebuilding a Drive/WebDAV session): a
				// transient throw must not brick boot. On throw, keep the saved kind so
				// a later reconnect retries - never demote to 'device' the way a
				// deliberate null return (no session to restore) does.
				let t: BackupTarget | null = null;
				let restoreThrew = false;
				try {
					t = opts.restoreTarget ? await opts.restoreTarget(savedKind) : null;
				} catch (e) {
					restoreThrew = true;
					lastError = transient('Could not restore the destination; will retry.');
					logger.error('[selfstore] restoreTarget failed', e);
				}
				if (t) {
					durable = t;
					targetKind = savedKind;
					label = t.label;
					// isReady() rethrows a genuine auth loss (open the gate) and returns
					// false only for a transient hiccup (stay connected, retry later) - so
					// booting during a broker cold-start no longer pops a spurious reconnect.
					let ok = false;
					try {
						ok = await t.isReady();
					} catch {
						raiseGate('AUTH_EXPIRED', 'Access to the destination expired or was revoked.');
					}
					needsAttention = needsAttention || locked();
					if (ok && !locked()) {
						// Boot must never crash the app on a bad remote: log, gate nothing,
						// keep the local copy and let a later sync retry.
						try {
							await pull('boot');
						} catch (e) {
							lastError = transient('Boot sync failed; will retry.');
							logger.error('[selfstore] boot sync failed', e);
						}
					}
				} else if (!restoreThrew) {
					// A deliberate null (no session to restore): fall back to cache-only.
					targetKind = 'device';
					await kv.set(KEY.targetKind, 'device');
				}
				// else: restore threw transiently - keep savedKind + durable null, so
				// the profile still reads the destination and a reconnect can retry.
			} else if (savedKind === 'file-manual') {
				targetKind = 'file-manual';
				pendingDownload = false;
			}
			// Peers attached before init() with no durable home (a read-only
			// follower): fold them now - with a durable target the boot pull above
			// already did. Same crash rule as boot: log, never block.
			if (!durable && peerList.length > 0) {
				try {
					await pull('boot');
				} catch (e) {
					lastError = transient('Boot sync failed; will retry.');
					logger.error('[selfstore] boot sync failed', e);
				}
			}
			ready = true;
			notify();
		},

		schedule() {
			// Passive auto-save is armed only once init() hydrated the app: before
			// that, gather() would snapshot emptiness over the cache (e.g. a stray
			// track on a viewer page that never initializes persistence).
			if (!ready) return;
			pendingEdit = true; // a cross-tab refresh must save this, not adopt over it
			editSeq++; // an edit landing mid-persist must keep pendingEdit (see doSave)
			clearTimeout(timer);
			// A background save failure (quota, cache write) must never surface as an
			// unhandled rejection from a debounce timer: log it and let the next
			// scheduled save retry.
			timer = setTimeout(
				() => save().catch((e) => logger.error('[selfstore] scheduled save failed', e)),
				debounceMs
			);
			armIdleLock(); // user activity resets the auto-lock countdown
		},

		lock: lockNow,

		async flush() {
			if (!ready) return; // same pre-init guard as schedule()
			clearTimeout(timer);
			if (mode === 'persistent') await save();
		},

		syncIfStale(source) {
			return serialize(async () => {
				if (locked() || needsAttention || mode !== 'persistent') return;
				if (!durable?.stat && peerList.length === 0) return;
				const nowMs = Date.now();
				if (nowMs - lastStaleCheck < STALE_CHECK_MS) return;
				lastStaleCheck = nowMs;
				let moved = false;
				if (durable?.stat) {
					const seen = await statRemote();
					moved = seen !== null && seen !== remoteVersion;
				}
				if (!moved) moved = await anyPeerMoved();
				if (!moved) return;
				// A background staleness check must never surface as an unhandled
				// rejection on a focus event: log and let the next check retry.
				try {
					await doPull(source);
				} catch (e) {
					lastError = transient('Background sync failed; will retry.');
					logger.error('[selfstore] background sync failed', e);
					notify();
				}
			});
		},

		syncNow() {
			return serialize(() => {
				lastStaleCheck = Date.now();
				return doPull('manual');
			});
		},

		attachTarget(target, attachOpts) {
			if (isReservedStoreMode(target.kind)) {
				throw new TypeError(
					`attachTarget(): kind "${target.kind}" is a reserved store mode, not a target kind - pick any other string`
				);
			}
			const cfg = attachOpts?.group ?? null;
			if (cfg && attachOpts?.password) {
				throw new TypeError(
					'attachTarget(): `group` and `password` are mutually exclusive - a group is keyed by member identities.'
				);
			}
			// A require-encryption store has no plaintext home: reject the attach up
			// front rather than let a passwordless target through to a cleartext save.
			if (requireEncryption && !attachOpts?.password && !cfg) {
				throw new SelfstoreError(
					'ENCRYPTION_REQUIRED',
					'attachTarget(): this store requires encryption - attach with a password or a group.'
				);
			}
			if (attachOpts?.password) assertPasswordPolicy(attachOpts.password);
			// Serialized with the save/pull chain: an in-flight converge of the
			// departing target finishes first, so it can neither resurrect that
			// backup's data over a wipe nor leak it into the new home.
			return serialize(async () => {
				// Verify the signed manifest first, against the admin key the app
				// pinned at join: the store is the verification gate, so a forged
				// membership rejects (SIGNATURE_INVALID) before anything changes.
				const g: ActiveGroup | null = cfg
					? {
							identity: cfg.identity,
							admin: cfg.admin,
							manifest: await openManifest(cfg.manifest, cfg.admin)
						}
					: null;
				if (g && !g.manifest.members.some((m) => m.sig === g.identity.sigPub)) {
					throw new TypeError(
						'attachTarget(): this identity is not a member of the manifest - the admin must add it first.'
					);
				}
				await becomePersistent();
				const strategy = attachOpts?.strategy ?? 'merge';
				// Flush pending edits to the departing target before we let go of it, but
				// only when the incoming strategy REPLACES local (switching isolated silos
				// via loadBackup): local is about to be overwritten, so an unsynced edit on
				// the file we leave would be lost unless we save it there first. 'merge'
				// keeps local (nothing stranded) and 'replace-remote' carries local into
				// the new home, so neither needs this - and a blind flush on 'merge' could
				// even resurrect a record another replica deleted. Best-effort: offline
				// keeps the edit in the local cache.
				if (strategy === 'replace-local' && durable && !locked() && !needsAttention) {
					try {
						await persistLocal();
						await pushDurable('push');
					} catch {
						/* offline or unreachable: the local cache keeps the edit */
					}
				}
				// Manifest seq must never move backwards, even across sessions: a
				// replayed old manifest would silently re-add a removed member.
				if (g) {
					const stored = await kv.get<number>(groupSeqKey(g.manifest.group));
					if (stored !== undefined && g.manifest.seq < stored) {
						throw new SelfstoreError(
							'MANIFEST_ROLLBACK',
							`Manifest seq ${g.manifest.seq} is older than the last applied (${stored}).`
						);
					}
					await persistGroupSeq(g.manifest.group, Math.max(stored ?? 0, g.manifest.seq));
				}
				await dropDurable({ keepSession: attachOpts?.keepSession });
				if (attachOpts?.wipe) {
					// A brand-new home starts blank: empty data and fresh sync meta (no
					// clocks or tombstones carried over from the previous backup).
					apply({ collections: {}, files: [] });
					meta = createMeta();
					baseMeta = null;
					await kv.set(KEY.syncMeta, meta);
					await kv.del(KEY.baseMeta);
				}
				durable = target;
				targetKind = target.kind;
				label = target.label;
				const next = attachOpts?.password ?? null;
				group = g;
				encrypted = !!next || !!g;
				setPass(next);
				// A new home means new key material: never carry the previous file's
				// envelope over (the legs below recapture it from the real file).
				envelope = null;
				await kv.set(KEY.enc, encrypted);
				await kv.set(KEY.targetKind, target.kind);
				needsAttention = false;
				notify();
				if (strategy === 'replace-local') await loadFromRemote();
				else if (strategy === 'replace-remote') await doSave();
				else await doPull('connect');
				notify();
			});
		},

		async inspectTarget(target) {
			// A read that fails is not a destination that is empty. Swallowing the
			// difference let a transient failure (offline, a cold start, an expired
			// token) read as "no backup", and the connect that followed could
			// overwrite a perfectly good one. Failures and unreadable files
			// propagate, typed, for the caller to surface; only a genuine
			// "nothing there" (a null blob) reads as empty.
			const blob = await target.load();
			// A missing file and an empty file both read as "nothing there": a
			// just-created destination file has zero bytes (Drive's create writes
			// metadata + empty content), and zero bytes cannot be data anyone
			// could lose. Only a NON-empty file that fails to parse propagates -
			// that one may be someone's backup.
			if (!blob || blob.size === 0) return { hasBackup: false, date: null, encrypted: false };
			// Remember this download (with the remote's current marker) so the attach
			// that typically follows reuses it instead of fetching the same file again.
			// A Blob is re-readable, so inspecting it here does not spend it.
			let marker: string | null;
			try {
				marker = target.stat ? await target.stat() : null;
			} catch {
				marker = null;
			}
			prefetched = { target, blob, marker, at: Date.now() };
			const header = await inspect(blob);
			return {
				hasBackup: true,
				date: header.createdAt ?? null,
				encrypted: header.encryption !== 'none'
			};
		},

		setManualFile() {
			// Serialized with the save/pull chain: dropping the durable target and
			// re-persisting must not interleave with an in-flight debounced save or a
			// focus-pull (which could push to, or converge from, the target we are
			// detaching mid-operation).
			return serialize(async () => {
				await becomePersistent();
				await dropDurable();
				targetKind = 'file-manual';
				pendingDownload = false;
				await kv.set(KEY.targetKind, 'file-manual');
				await persistLocal();
				notify();
			});
		},

		async unlock(password) {
			if (!locked() || !password) return false;
			setPass(password);
			// Clear only the LOCK, not a SCHEMA_TOO_NEW ceiling gate we do not own: a
			// downgraded app that hydrated newer-shape data must stay gated, or its
			// pull-then-push would upload old-shaped records stamped with the newer
			// version and corrupt other devices.
			needsAttention = schemaCeiling > version;
			await pull('manual'); // doPull notifies; a wrong password re-raises the gate
			return !needsAttention;
		},

		async reconnect() {
			if (locked() || !durable) return false; // a lock needs unlock(), not reconnect()
			if (await durable.reconnect()) {
				needsAttention = schemaCeiling > version; // keep the schema ceiling gate (see unlock)
				if (!needsAttention) lastError = null;
				await pull('manual');
				return !needsAttention;
			}
			return false;
		},

		detachTarget(opts) {
			// Serialized like setManualFile: a concurrent save/pull must not run
			// against a target that is being dropped out from under it.
			return serialize(async () => {
				await dropDurable({ keepSession: opts?.keepSession });
				targetKind = 'device';
				await kv.set(KEY.targetKind, 'device');
				notify();
			});
		},

		setGroup(next) {
			if (!group) {
				throw new TypeError('setGroup(): no group attached - attachTarget with { group } first.');
			}
			return serialize(async () => {
				// Verified against the admin key and group id pinned at attach: a
				// swapped admin (rotation is not a plain setGroup) or a foreign
				// group's manifest fails right here, whoever signed it. The store
				// is the verification gate, not the app.
				const manifest = await openManifest(next, group!.admin, group!.manifest.group);
				const key = groupSeqKey(manifest.group);
				const stored = (await kv.get<number>(key)) ?? 0;
				const floor = Math.max(stored, group!.manifest.seq);
				if (manifest.seq < floor) {
					throw new SelfstoreError(
						'MANIFEST_ROLLBACK',
						`Manifest seq ${manifest.seq} is older than the last applied (${floor}).`
					);
				}
				// Monotonic write: never lower the persisted high-water mark, even if a
				// concurrent (Web-Lock-less) tab read an older value first.
				await persistGroupSeq(manifest.group, Math.max(stored, manifest.seq));
				group = { ...group!, manifest };
				notify();
				// Republish under the new member list NOW: this is the moment a
				// removal stops enveloping the removed member. The membership change
				// alters the output bytes (recipients/envelopes) but not the content
				// digest, so the idempotent-save guard would wrongly skip it - drop
				// the fingerprint to force a real re-encode and upload.
				lastSavedContentHash = null;
				await doSave();
			});
		},

		attachPeer(source, peerOpts) {
			const id = peerOpts?.id ?? createNode();
			if (peerList.some((p) => p.id === id)) {
				throw new TypeError(`attachPeer(): a peer with id "${id}" is already attached`);
			}
			peerList.push({
				id,
				source,
				password: peerOpts?.password,
				label: source.label ?? id,
				lastSyncAt: null,
				author: null,
				lastError: null,
				lastSeen: null,
				envelope: null
			});
			notify();
			// Fold the new peer promptly (serialized with saves and pulls). Before
			// init() this just registers - the boot converge picks the peer up.
			if (ready) {
				void serialize(() => doPull('connect')).catch((e) =>
					logger.error('[selfstore] peer converge failed', e)
				);
			}
			return id;
		},

		detachPeer(id) {
			const i = peerList.findIndex((p) => p.id === id);
			if (i >= 0) {
				peerList.splice(i, 1);
				notify();
			}
		},

		attachMirror(target, mirrorOpts) {
			const id = mirrorOpts.id ?? createNode();
			if (mirrorList.some((m) => m.id === id)) {
				throw new TypeError(`attachMirror(): a mirror with id "${id}" is already attached`);
			}
			mirrorList.push({
				id,
				target,
				password: mirrorOpts.password,
				envelope: null,
				label: target.label ?? id,
				lastPublishAt: null,
				lastError: null
			});
			notify();
			// Publish promptly so the copy exists as soon as the mirror is wired
			// (serialized with saves and pulls). Before init() this just registers.
			if (ready) {
				void serialize(publishMirrors).catch((e) =>
					logger.error('[selfstore] mirror publish failed', e)
				);
			}
			return id;
		},

		detachMirror(id) {
			const i = mirrorList.findIndex((m) => m.id === id);
			if (i >= 0) {
				mirrorList.splice(i, 1);
				notify();
			}
		},

		attachReplica(target, replicaOpts) {
			const id = replicaOpts?.id ?? createNode();
			if (replicaList.some((r) => r.id === id)) {
				throw new TypeError(`attachReplica(): a replica with id "${id}" is already attached`);
			}
			replicaList.push({
				id,
				target,
				label: target.label ?? id,
				lastPublishAt: null,
				lastError: null
			});
			notify();
			// Publish promptly so the copy exists as soon as the replica is wired
			// (serialized with saves and pulls). Before init() this just registers.
			if (ready) {
				void serialize(publishReplicas).catch((e) =>
					logger.error('[selfstore] replica publish failed', e)
				);
			}
			return id;
		},

		detachReplica(id) {
			const i = replicaList.findIndex((r) => r.id === id);
			if (i >= 0) {
				replicaList.splice(i, 1);
				notify();
			}
		},

		exportBlob() {
			return buildBlob();
		},

		markDownloaded() {
			pendingDownload = false;
			notify();
		},

		setEphemeral() {
			mode = 'ephemeral';
			kvSetSafe(KEY.mode, 'ephemeral', 'mode');
			notify();
		},

		async leaveEphemeral() {
			await becomePersistent();
			await save();
		},

		forget() {
			return serialize(doForget);
		},

		async setEncryption(password) {
			// Reversible: add/change a password (non-empty string) or remove it (null),
			// after connecting. Rewrites the local cache and the remote backup with the
			// new setting - and COMMITS the flag only once the remote rewrite has
			// verifiably landed. The old order (flag first, best-effort save after)
			// let a deferred or failed write pass for success: the store then
			// expected one setting while the file kept the other, which surfaced as
			// "asks a password that never works" or an unresolvable reconnect gate.
			// The same reasoning turns the silent preconditions into loud errors: a
			// caller must never mistake a no-op for a rewrite.
			if (group) {
				throw new TypeError(
					'setEncryption(): the store is in group mode - encryption is keyed by the membership manifest (setGroup), not a password.'
				);
			}
			// Removing the password would leave a plaintext backup, which this store
			// forbids; changing it (non-empty) is still allowed.
			if (requireEncryption && !password) {
				throw new SelfstoreError(
					'ENCRYPTION_REQUIRED',
					'setEncryption(): this store requires encryption - the password cannot be removed.'
				);
			}
			if (password) assertPasswordPolicy(password);
			if (!durable) {
				throw new SelfstoreError('NOT_CONNECTED', 'setEncryption(): no destination is connected.');
			}
			if (locked() || needsAttention) {
				throw new SelfstoreError(
					'TARGET_WRITE_FAILED',
					'setEncryption(): the store needs attention; resolve it before changing encryption.'
				);
			}
			return serialize(async () => {
				// Converge first, under the current setting: another replica may have
				// written since our last sync, and its blob opens with the old key. A
				// blind re-encrypting push would clobber that write.
				await requireReady('setEncryption');
				const seen = await statRemote();
				if (seen !== null && remoteVersion !== null && seen !== remoteVersion) {
					await pullRemoteIntoLocal('push', seen);
					if (locked() || needsAttention) {
						throw new SelfstoreError(
							'TARGET_WRITE_FAILED',
							'setEncryption(): the pre-rewrite converge needs attention; resolve it first.'
						);
					}
				}
				const prevEncrypted = encrypted;
				const prevPass = pass;
				const prevEnvelope = envelope;
				encrypted = !!password;
				setPass(password || null);
				// Setting a password is a data-key ROTATION: drop the old envelope so
				// buildBlob mints a fresh key with a single slot. Every previously
				// authorized password (a share key, an old password) stops opening
				// the new bytes - that is the point.
				envelope = null;
				try {
					await persistLocal();
					pendingEdit = false;
					const written = await durable!.save(await buildBlob());
					await setRemoteVersion(typeof written === 'string' ? written : await statRemote());
					lastError = null;
					await kv.set(KEY.enc, encrypted); // the flag follows the write, never precedes it
				} catch (e) {
					// Roll the setting back everywhere the write did not reach: the
					// caller gets the failure, and the store still matches the file.
					encrypted = prevEncrypted;
					setPass(prevPass);
					envelope = prevEnvelope;
					await persistLocal().catch(() => undefined);
					if (isAuthExpired(e)) {
						raiseGate('AUTH_EXPIRED', 'Access to the destination expired or was revoked.');
					}
					throw e;
				} finally {
					notify();
				}
			});
		},

		async addEncryptionKey(password, id) {
			if (group) {
				throw new TypeError(
					'addEncryptionKey(): the store is in group mode - keys come from the membership manifest (setGroup), not passwords.'
				);
			}
			if (!password) {
				throw new TypeError('addEncryptionKey(): a non-empty password is required.');
			}
			assertPasswordPolicy(password);
			if (!durable) {
				throw new SelfstoreError(
					'NOT_CONNECTED',
					'addEncryptionKey(): no destination is connected.'
				);
			}
			if (locked() || needsAttention) {
				throw new SelfstoreError(
					'TARGET_WRITE_FAILED',
					'addEncryptionKey(): the store needs attention; resolve it before changing keys.'
				);
			}
			if (!encrypted || !pass) {
				throw new TypeError(
					'addEncryptionKey(): the backup has no password yet - setEncryption(password) first.'
				);
			}
			return serialize(async () => {
				await requireReady('addEncryptionKey');
				const seen = await statRemote();
				if (seen !== null && remoteVersion !== null && seen !== remoteVersion) {
					await pullRemoteIntoLocal('push', seen);
					if (locked() || needsAttention) {
						throw new SelfstoreError(
							'TARGET_WRITE_FAILED',
							'addEncryptionKey(): the pre-rewrite converge needs attention; resolve it first.'
						);
					}
				}
				// A pre-envelope file mints its own-password slot now; the new slot
				// joins it. Same data key: nothing is re-encrypted, every existing
				// password keeps opening the file - that is the whole point.
				if (!envelope) {
					const dataKey = crypto.getRandomValues(new Uint8Array(32));
					envelope = { dataKey, slots: [await mintSlot(pass!, dataKey)] };
				}
				if (envelope.slots.length >= MAX_KEY_SLOTS) {
					throw new TypeError(
						`addEncryptionKey(): this backup already has ${MAX_KEY_SLOTS} key slots.`
					);
				}
				if (id && envelope.slots.some((s) => s.id === id)) {
					throw new TypeError(`addEncryptionKey(): a key slot named "${id}" already exists.`);
				}
				const prevEnvelope = envelope;
				const slot = await mintSlot(password, envelope.dataKey, id);
				envelope = { dataKey: envelope.dataKey, slots: [...envelope.slots, slot] };
				try {
					const blob = await buildBlob();
					// Write-verified the strong way: the new password must open the very
					// bytes about to land, before they land.
					await readBoxWithSync(await asBytes(blob), password);
					const written = await durable!.save(blob);
					await setRemoteVersion(typeof written === 'string' ? written : await statRemote());
					lastError = null;
					return slot.id;
				} catch (e) {
					envelope = prevEnvelope;
					if (isAuthExpired(e)) {
						raiseGate('AUTH_EXPIRED', 'Access to the destination expired or was revoked.');
					}
					throw e;
				} finally {
					notify();
				}
			});
		},

		async removeEncryptionKey(id) {
			if (group) {
				throw new TypeError(
					'removeEncryptionKey(): the store is in group mode - keys come from the membership manifest (setGroup), not passwords.'
				);
			}
			if (!durable) {
				throw new SelfstoreError(
					'NOT_CONNECTED',
					'removeEncryptionKey(): no destination is connected.'
				);
			}
			if (locked() || needsAttention) {
				throw new SelfstoreError(
					'TARGET_WRITE_FAILED',
					'removeEncryptionKey(): the store needs attention; resolve it before changing keys.'
				);
			}
			if (!encrypted || !pass) {
				throw new TypeError('removeEncryptionKey(): the backup has no password.');
			}
			return serialize(async () => {
				await requireReady('removeEncryptionKey');
				const seen = await statRemote();
				if (seen !== null && remoteVersion !== null && seen !== remoteVersion) {
					await pullRemoteIntoLocal('push', seen);
					if (locked() || needsAttention) {
						throw new SelfstoreError(
							'TARGET_WRITE_FAILED',
							'removeEncryptionKey(): the pre-rewrite converge needs attention; resolve it first.'
						);
					}
				}
				if (!envelope) {
					throw new TypeError(
						'removeEncryptionKey(): no key slots known - the file predates the envelope or has not been read yet.'
					);
				}
				const remaining = envelope.slots.filter((s) => s.id !== id);
				if (remaining.length === envelope.slots.length) {
					throw new TypeError(`removeEncryptionKey(): no key slot named "${id}".`);
				}
				if (remaining.length === 0) {
					throw new TypeError(
						'removeEncryptionKey(): cannot remove the last key - setEncryption(null) decrypts instead.'
					);
				}
				// Lock-out guard: after the removal at least one remaining slot must
				// still open, or the very next reload would be unrecoverable. An
				// external-key slot (a passkey) counts - the app owns that key, so it
				// keeps a way in; otherwise this session's own password must open a
				// remaining PASSWORD slot.
				let stillOpens = remaining.some((s) => (s as ExternalSlot).kind === 'external');
				for (const s of remaining) {
					if (stillOpens) break;
					if ((s as ExternalSlot).kind === 'external') continue;
					if (await openSlot(s as PasswordSlot, pass!)) {
						stillOpens = true;
						break;
					}
				}
				if (!stillOpens) {
					throw new TypeError(
						'removeEncryptionKey(): removing this slot would lock this session out - rotate with setEncryption(password) instead.'
					);
				}
				const prevEnvelope = envelope;
				envelope = { dataKey: envelope.dataKey, slots: remaining };
				try {
					const blob = await buildBlob();
					await readBoxWithSync(await asBytes(blob), pass!); // our password still opens
					const written = await durable!.save(blob);
					await setRemoteVersion(typeof written === 'string' ? written : await statRemote());
					lastError = null;
				} catch (e) {
					envelope = prevEnvelope;
					if (isAuthExpired(e)) {
						raiseGate('AUTH_EXPIRED', 'Access to the destination expired or was revoked.');
					}
					throw e;
				} finally {
					notify();
				}
			});
		},

		async setExternalEncryption(secret, keyRef) {
			if (group) {
				throw new TypeError(
					'setExternalEncryption(): the store is in group mode - keys come from the membership manifest (setGroup), not an external key.'
				);
			}
			if (!durable) {
				throw new SelfstoreError(
					'NOT_CONNECTED',
					'setExternalEncryption(): no destination is connected.'
				);
			}
			if (locked() || needsAttention) {
				throw new SelfstoreError(
					'TARGET_WRITE_FAILED',
					'setExternalEncryption(): the store needs attention; resolve it before changing encryption.'
				);
			}
			return serialize(async () => {
				await requireReady('setExternalEncryption');
				const seen = await statRemote();
				if (seen !== null && remoteVersion !== null && seen !== remoteVersion) {
					await pullRemoteIntoLocal('push', seen);
					if (locked() || needsAttention) {
						throw new SelfstoreError(
							'TARGET_WRITE_FAILED',
							'setExternalEncryption(): the pre-rewrite converge needs attention; resolve it first.'
						);
					}
				}
				const prevEncrypted = encrypted;
				const prevPass = pass;
				const prevEnvelope = envelope;
				// Rotation: a fresh data key sealed under one external slot, so every
				// prior key (password or external) stops opening the new bytes.
				const dataKey = crypto.getRandomValues(new Uint8Array(32));
				const slot = await mintExternalSlot(secret, keyRef, dataKey);
				encrypted = true;
				pass = null; // external-keyed: no password (do not setPass - it drops the envelope)
				envelope = { dataKey, slots: [slot] };
				armIdleLock();
				try {
					await persistLocal();
					pendingEdit = false;
					const blob = await buildBlob();
					// Write-verified: the secret must open the very bytes about to land.
					await readBoxWithSync(
						await asBytes(blob),
						undefined,
						undefined,
						undefined,
						async () => secret
					);
					const written = await durable!.save(blob);
					await setRemoteVersion(typeof written === 'string' ? written : await statRemote());
					lastError = null;
					await kv.set(KEY.enc, true);
				} catch (e) {
					encrypted = prevEncrypted;
					pass = prevPass;
					envelope = prevEnvelope;
					armIdleLock();
					await persistLocal().catch(() => undefined);
					if (isAuthExpired(e)) {
						raiseGate('AUTH_EXPIRED', 'Access to the destination expired or was revoked.');
					}
					throw e;
				} finally {
					notify();
				}
			});
		},

		async addExternalKey(secret, keyRef, id) {
			if (group) {
				throw new TypeError(
					'addExternalKey(): the store is in group mode - keys come from the membership manifest (setGroup).'
				);
			}
			if (!durable) {
				throw new SelfstoreError('NOT_CONNECTED', 'addExternalKey(): no destination is connected.');
			}
			if (locked() || needsAttention) {
				throw new SelfstoreError(
					'TARGET_WRITE_FAILED',
					'addExternalKey(): the store needs attention; resolve it before changing keys.'
				);
			}
			if (!encrypted) {
				throw new TypeError(
					'addExternalKey(): the backup is not encrypted yet - setEncryption(password) or setExternalEncryption(secret, ref) first.'
				);
			}
			return serialize(async () => {
				await requireReady('addExternalKey');
				const seen = await statRemote();
				if (seen !== null && remoteVersion !== null && seen !== remoteVersion) {
					await pullRemoteIntoLocal('push', seen);
					if (locked() || needsAttention) {
						throw new SelfstoreError(
							'TARGET_WRITE_FAILED',
							'addExternalKey(): the pre-rewrite converge needs attention; resolve it first.'
						);
					}
				}
				// A password-unlocked session with no envelope yet mints its own slot
				// first (same data key), so the external slot joins it - nothing is
				// re-encrypted and the existing password keeps opening the file.
				if (!envelope && pass) {
					const dataKey = crypto.getRandomValues(new Uint8Array(32));
					envelope = { dataKey, slots: [await mintSlot(pass, dataKey)] };
				}
				if (!envelope) {
					throw new TypeError('addExternalKey(): no data key in hand - unlock the backup first.');
				}
				if (envelope.slots.length >= MAX_KEY_SLOTS) {
					throw new TypeError(
						`addExternalKey(): this backup already has ${MAX_KEY_SLOTS} key slots.`
					);
				}
				if (id && envelope.slots.some((s) => s.id === id)) {
					throw new TypeError(`addExternalKey(): a key slot named "${id}" already exists.`);
				}
				const prevEnvelope = envelope;
				const slot = await mintExternalSlot(secret, keyRef, envelope.dataKey, id);
				envelope = { dataKey: envelope.dataKey, slots: [...envelope.slots, slot] };
				try {
					const blob = await buildBlob();
					// Write-verified: the new secret must open the bytes about to land.
					await readBoxWithSync(
						await asBytes(blob),
						undefined,
						undefined,
						undefined,
						async () => secret
					);
					const written = await durable!.save(blob);
					await setRemoteVersion(typeof written === 'string' ? written : await statRemote());
					lastError = null;
					return slot.id;
				} catch (e) {
					envelope = prevEnvelope;
					if (isAuthExpired(e)) {
						raiseGate('AUTH_EXPIRED', 'Access to the destination expired or was revoked.');
					}
					throw e;
				} finally {
					notify();
				}
			});
		},

		async unlockWithExternal(secret) {
			if (!locked() || !durable) return false;
			// Hold the secret only across this converge: importLocked resolves the
			// external slot from it, adopts the envelope (data key) on success, and
			// every later read uses the held data key - the secret is needed once.
			pendingExternalSecret = secret;
			needsAttention = schemaCeiling > version; // clear only the LOCK, not a schema ceiling gate
			try {
				await pull('manual'); // doPull notifies; a wrong secret re-raises the gate
			} finally {
				pendingExternalSecret = null;
			}
			return !locked() && !needsAttention;
		},

		listEncryptionKeys() {
			return (envelope?.slots ?? []).map((s) => ({
				id: s.id,
				kind:
					(s as ExternalSlot).kind === 'external' ? ('external' as const) : ('password' as const)
			}));
		},

		dispose() {
			clearTimeout(timer);
			clearTimeout(idleTimer);
			channel?.close();
			subs.clear();
		}
	};
}
