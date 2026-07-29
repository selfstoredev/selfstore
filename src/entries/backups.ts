/**
 * selfstore/backups - several backup files on one destination account, one
 * attached at a time (the personal, unnamed file plus any number of named
 * ones), each an isolated snapshot: opening one replaces the local data,
 * never merges, never touches the other files.
 *
 * `createBackupsManager({ store, kv, host, naming, keys? })` is headless and
 * injectable: the `BackupsHost` port carries the destination I/O (list,
 * open-by-id, create, delete, rename, session, owner lookup), the naming
 * rules derive named files from the canonical name, and every failure
 * surfaces as a stable code - the host app maps codes to its own copy and
 * wraps `subscribe` in its own reactivity.
 *
 * `driveBackupsHost({ auth, kv, fileName })` is that port already wired over
 * the Drive destination, so an app that keeps its backups there writes none of
 * it: the manager (and `<selfstore-backups>` with it) is three lines away.
 */

export { driveBackupsHost, type DriveBackupsHostOptions } from '../backups/drive-host';

export {
	createBackupsManager,
	type BackupFileInfo,
	type BackupOwner,
	type BackupRow,
	type BackupsErrorCode,
	type BackupsHost,
	type BackupsKeys,
	type BackupsManager,
	type BackupsNaming,
	type BackupsSnapshot,
	type KnownBackups
} from '../backups/manager';
