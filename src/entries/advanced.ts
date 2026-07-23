/**
 * selfstore/advanced - the pull-model store and the machinery under it.
 *
 * The simple `selfstore()` facade (package root) owns its data. This entry
 * inverts that: with createLocalStore your app owns the data and hands the
 * store a gather/apply pair - use it when state lives in your own reactive
 * model (Svelte runes, Redux, signals) and the facade's collections would be
 * a second copy. Everything here also backs `store.advanced` on the simple
 * store: same machinery, same instance, so the two styles compose.
 *
 * Also here: the durable destinations (disk file, Google Drive, WebDAV) as
 * connectable targets, the BackupTarget contract for writing your own, the
 * caches, the headless status derivation, and the functional codec for the
 * backup file format (the fluent one lives at the package root).
 */

// --- The pull-model store: your app owns the data ---
export {
	createLocalStore,
	type LocalStore,
	type LocalStoreOptions,
	type LocalStoreState,
	type StoreError,
	type Mode,
	type TargetKind,
	type SyncSource,
	type SyncJournalEntry,
	type PeerState,
	type MirrorState,
	type ReplicaState,
	type StoreGroupConfig
} from '../persistence/store';

// --- On-device caches (the store's working copy) ---
export {
	indexedDbCache,
	memoryCache,
	isLockableCache,
	type LocalCache,
	type LockableCache,
	type CachedFile,
	type KV
} from '../persistence/cache';

// --- Headless status: map store state to your UI copy ---
export {
	deriveStatus,
	type StatusDescriptor,
	type StatusInput,
	type Severity,
	type StorageState,
	type StatusAction
} from '../persistence/status';

// --- The target contract (write your own destination) ---
export {
	RESERVED_STORE_MODES,
	isReservedStoreMode,
	type BackupTarget,
	type BuiltinTargetKind,
	type PeerSource
} from '../persistence/target';

// --- The backup file format, functional style (fluent lives at the root) ---
export {
	exportSnapshot,
	importSnapshot,
	inspect,
	isEncrypted,
	RESERVED_COLLECTION_PREFIX,
	type Snapshot,
	type SnapshotFile,
	type Header,
	type KdfParams,
	type RecipientStanza,
	type EncodeOptions
} from '../selfstore';

// --- Password strength policy (the store enforces it; the UI previews it) ---
export {
	checkPasswordPolicy,
	type PasswordPolicy,
	type PasswordCheck,
	type PasswordRequirement
} from '../selfstore';

// --- The full error contract (AuthExpiredError is what a custom target or
//     DriveAuth THROWS to signal genuine access loss; everything else it
//     throws is treated as transient and retried) ---
export {
	SelfstoreError,
	AuthExpiredError,
	isSelfstoreError,
	isAuthExpired,
	errorLabelKey,
	type SelfstoreErrorCode
} from '../selfstore';

// --- Durable destinations (opt-in), each implementing BackupTarget ---
// Explicit namespace objects: every member is deliberately public, so a future
// internal helper in a target module can never leak into the contract.
import {
	connect as fileConnect,
	fromSession as fileFromSession,
	isSupported as fileIsSupported
} from '../persistence/targets/file';
import {
	connect as webdavConnect,
	fromSession as webdavFromSession,
	peer as webdavPeer
} from '../persistence/targets/webdav';
import { connect as s3Connect, fromSession as s3FromSession } from '../persistence/targets/s3';
import {
	connect as driveConnect,
	fromSession as driveFromSession,
	preview as drivePreview,
	adopt as driveAdopt,
	findOrCreateOwnFile as driveFindOrCreateOwnFile,
	listBackups as driveListBackups,
	createBackup as driveCreateBackup,
	deleteBackup as driveDeleteBackup,
	renameBackup as driveRenameBackup,
	FILE_ID_KEY as DRIVE_FILE_ID_KEY
} from '../persistence/targets/drive';

/** Disk-file destination (File System Access, Chromium). */
export const fileTarget = {
	connect: fileConnect,
	fromSession: fileFromSession,
	isSupported: fileIsSupported
};

/** WebDAV destination (Nextcloud, ownCloud, any server the user controls), plus
 *  `peer()`: a read-only source over another member's shared WebDAV link, so a
 *  group can share read-write without Google Drive (see store.attachPeer). */
export const webdavTarget = {
	connect: webdavConnect,
	fromSession: webdavFromSession,
	peer: webdavPeer
};

/** S3-compatible destination (Amazon S3, Cloudflare R2, Backblaze B2, MinIO):
 *  the browser signs each request with SigV4 and writes one object on a bucket
 *  the user controls, no vendor broker. The bucket only ever holds the same
 *  end-to-end-encrypted .selfstore bytes. */
export const s3Target = {
	connect: s3Connect,
	fromSession: s3FromSession
};

/** Google Drive destination, plus the shared-file primitives (preview a specific
 *  file, adopt it as this device's backup, find-or-create the user's own file)
 *  and the backup-management ops (list the app's files with dates, create a
 *  named empty backup, rename one, delete one for good) - the raw pieces a "my
 *  backups" panel builds on. */
export const driveTarget = {
	connect: driveConnect,
	fromSession: driveFromSession,
	preview: drivePreview,
	adopt: driveAdopt,
	findOrCreateOwnFile: driveFindOrCreateOwnFile,
	listBackups: driveListBackups,
	createBackup: driveCreateBackup,
	deleteBackup: driveDeleteBackup,
	renameBackup: driveRenameBackup,
	FILE_ID_KEY: DRIVE_FILE_ID_KEY
};

export type { FileConnectOptions } from '../persistence/targets/file';
export type { DriveAuth, DriveOptions, DriveBackupInfo } from '../persistence/targets/drive';
export type {
	WebdavConfig,
	WebdavConnectOptions,
	WebdavPeerOptions
} from '../persistence/targets/webdav';
export type { S3Config, S3ConnectOptions } from '../persistence/targets/s3';
export { gisDriveAuth } from '../persistence/targets/drive-auth-gis';
export { saveToDisk, pickFromDisk } from '../selfstore/targets/local';
