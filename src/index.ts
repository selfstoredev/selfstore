// selfstore - local-first storage for browser apps.
//
//   const store = await selfstore('todo-app');
//   await store.put('todos', { id: 't1', text: 'ship it' });
//   store.onChange(render);   // local writes and multi-device merges
//
// IndexedDB persistence, debounced flushes and the browser sync moments (tab
// focus, network return, tab hide) come wired. Multi-device sync, end-to-end
// encryption and portable backups are one call each - see the README.
//
// Deeper layers ship as subpaths: selfstore/flows (headless journeys),
// /widgets (web components), /advanced (pull-model store, custom targets),
// /groups (passwordless group crypto), /backups, /households, /sync.

// --- The simple store: one call, the store owns the data ---
export {
	selfstore,
	type SimpleStore,
	type SimpleRecord,
	type SimpleOptions,
	type CacheUnlock,
	type ConnectOutcome
} from './simple/simple';

// --- Portable backup files, fluent ---
export {
	backup,
	restore,
	changePassword,
	type BackupDraft,
	type BackupBuilder,
	type EncryptedBackupBuilder,
	type RestoreBuilder,
	BACKUP_EXTENSION,
	BACKUP_MIME,
	type Snapshot,
	type SnapshotFile,
	type Header
} from './selfstore';
export {
	checkPasswordPolicy,
	type PasswordPolicy,
	type PasswordCheck,
	type PasswordRequirement
} from './selfstore';
export { saveToDisk, pickFromDisk } from './selfstore/targets/local';

// --- The error contract: branch on `err.code`, map `errorLabelKey` to copy ---
export {
	SelfstoreError,
	isSelfstoreError,
	errorLabelKey,
	type SelfstoreErrorCode
} from './selfstore';

// --- Google Drive auth in one line (Google Identity Services) ---
export { gisDriveAuth } from './persistence/targets/drive-auth-gis';
export type { DriveAuth } from './persistence/targets/drive';
export type { WebdavConfig } from './persistence/targets/webdav';
export type { S3Config } from './persistence/targets/s3';

// --- Types the simple store surfaces (status for your UI, the escape hatch) ---
export type {
	StatusDescriptor,
	Severity,
	StorageState,
	StatusAction
} from './persistence/status';
export type {
	StoreError,
	LocalStore,
	LocalStoreState,
	Mode,
	TargetKind
} from './persistence/store';
export type { SyncConfig } from './sync';
