// The backup format: Snapshot in, portable ZIP out, and back. Plain archive
// without a password, AES-256-GCM (over Argon2id) with one.
//
//   const blob = await exportSnapshot(snapshot, { app: 'my-app', password });
//   const back = await importSnapshot(blob, { password });
//
// or fluent, same engine:
//
//   const blob = await backup(snapshot).as('my-app').encryptedWith(password).toBlob();
//   const back = await restore(blob).withPassword(password).read();

import type { Snapshot, Header, EncodeOptions } from './types';
import { writeBox, readBox, readBoxMeta, asBytes } from './box';

export type {
	Snapshot,
	SnapshotFile,
	Header,
	KdfParams,
	RecipientStanza,
	EncodeOptions,
	PasswordSlot,
	ExternalSlot,
	KeySlot
} from './types';
export { RESERVED_COLLECTION_PREFIX } from './types';
export {
	SelfstoreError,
	AuthExpiredError,
	isSelfstoreError,
	isAuthExpired,
	errorLabelKey,
	type SelfstoreErrorCode
} from './errors';
export { BACKUP_EXTENSION, BACKUP_MIME } from './box';
export {
	checkPasswordPolicy,
	type PasswordPolicy,
	type PasswordCheck,
	type PasswordRequirement
} from './password-policy';
export {
	backup,
	restore,
	type BackupDraft,
	type BackupBuilder,
	type EncryptedBackupBuilder,
	type RestoreBuilder
} from './fluent';

/** Serialize a snapshot to a portable backup blob (compressed; encrypted if a password is given). */
export async function exportSnapshot(snapshot: Snapshot, opts: EncodeOptions): Promise<Blob> {
	return new Blob([(await writeBox(snapshot, opts)) as BlobPart], { type: 'application/zip' });
}

/** Read a backup blob (or raw bytes) back into a snapshot. */
export async function importSnapshot(
	input: Blob | Uint8Array,
	opts: { password?: string } = {}
): Promise<Snapshot> {
	return readBox(await asBytes(input), opts.password);
}

/** Peek at a backup's cleartext metadata (app, date, whether it's encrypted) without decrypting. */
export async function inspect(input: Blob | Uint8Array): Promise<Header> {
	return readBoxMeta(await asBytes(input));
}

/** True if the backup needs a password to import. */
export async function isEncrypted(input: Blob | Uint8Array): Promise<boolean> {
	return (await inspect(input)).encryption !== 'none';
}

/** Re-encrypt under a new password. `from` opens the file, `to` protects the
 *  result; omit `to` for an unencrypted backup. */
export async function changePassword(
	input: Blob | Uint8Array,
	opts: { from?: string; to?: string; readme?: string }
): Promise<Blob> {
	const bytes = await asBytes(input);
	const meta = await readBoxMeta(bytes);
	const snapshot = await readBox(bytes, opts.from);
	return exportSnapshot(snapshot, {
		app: meta.app,
		appVersion: meta.appVersion,
		schemaVersion: meta.schemaVersion,
		password: opts.to,
		readme: opts.readme
	});
}
