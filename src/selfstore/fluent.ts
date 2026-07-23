// Fluent facade over the functional API. The chain is staged so an illegal
// call order does not compile: backup() exposes only .as(), and .withReadme()
// appears only after .encryptedWith() (the readme ships inside the encrypted
// ZIP, so it means nothing on a plain one).
//
//   const blob = await backup(snapshot).as('my-app', '1.2.0').encryptedWith(pw).toBlob();
//   const snap = await restore(file).withPassword(pw).read();

import type { Snapshot, Header, EncodeOptions } from './types';
import { RESERVED_COLLECTION_PREFIX } from './types';
import { writeBox, readBox, readBoxMeta, asBytes, BACKUP_MIME, BACKUP_EXTENSION } from './box';

/** Start writing a backup. Naming the app via .as() is the required next step. */
export function backup(snapshot: Snapshot): BackupDraft {
	return new BackupDraft(snapshot);
}

/** Start reading a backup (a picked File, a fetched Blob, or raw bytes). */
export function restore(input: Blob | Uint8Array): RestoreBuilder {
	return new RestoreBuilder(input);
}

// Validation lives in the constructor, not the factory, so direct
// construction cannot bypass it.
export class BackupDraft {
	constructor(private readonly snapshot: Snapshot) {
		for (const name of Object.keys(snapshot.collections)) {
			if (name.startsWith(RESERVED_COLLECTION_PREFIX)) {
				throw new TypeError(
					`backup(): collection "${name}" uses the reserved "${RESERVED_COLLECTION_PREFIX}" prefix (library bookkeeping) - rename it`
				);
			}
		}
	}

	/** Name the writing app (stored cleartext in the backup's metadata). */
	as(app: string, appVersion?: string): BackupBuilder {
		return new BackupBuilder(this.snapshot, { app, appVersion });
	}
}

export class BackupBuilder {
	constructor(
		protected readonly snapshot: Snapshot,
		protected readonly opts: EncodeOptions
	) {}

	/** Encrypt the backup (AES-256-GCM over an Argon2id-derived key). */
	encryptedWith(password: string): EncryptedBackupBuilder {
		return new EncryptedBackupBuilder(this.snapshot, { ...this.opts, password });
	}

	/** The backup as raw bytes. */
	async toBytes(): Promise<Uint8Array> {
		return writeBox(this.snapshot, this.opts);
	}

	/** The backup as a Blob, ready to upload or hand to a save dialog. */
	async toBlob(): Promise<Blob> {
		return new Blob([(await this.toBytes()) as BlobPart], { type: BACKUP_MIME });
	}

	/** Save the backup to disk (File System Access API, else a download).
	 *  Browser-only terminal; defaults to `<app>-<date>.zip`. */
	async toDisk(filename?: string): Promise<void> {
		const blob = await this.toBlob();
		const name =
			filename ?? `${this.opts.app}-${new Date().toISOString().slice(0, 10)}${BACKUP_EXTENSION}`;
		const { saveToDisk } = await import('./targets/local');
		await saveToDisk(blob, name);
	}
}

export class EncryptedBackupBuilder extends BackupBuilder {
	constructor(snapshot: Snapshot, opts: EncodeOptions) {
		if (!opts.password) {
			throw new TypeError(
				'EncryptedBackupBuilder: a password is required - use backup(snapshot).as(app).encryptedWith(password)'
			);
		}
		super(snapshot, opts);
	}

	/** Brand the README shipped inside the encrypted ZIP. */
	withReadme(text: string): EncryptedBackupBuilder {
		return new EncryptedBackupBuilder(this.snapshot, { ...this.opts, readme: text });
	}
}

export class RestoreBuilder {
	private password?: string;

	constructor(private readonly input: Blob | Uint8Array) {}

	/** Accepts undefined so callers can pass straight through from an optional field. */
	withPassword(password?: string): this {
		this.password = password || undefined;
		return this;
	}

	/** The cleartext metadata (app, date, encryption), without decrypting. */
	async meta(): Promise<Header> {
		return readBoxMeta(await asBytes(this.input));
	}

	/** True if reading will require a password. */
	async isEncrypted(): Promise<boolean> {
		return (await this.meta()).encryption !== 'none';
	}

	/** Read the backup into a snapshot. Reserved `__*` collections (library
	 *  bookkeeping) are stripped. PASSWORD_REQUIRED when encrypted and no
	 *  password given, DECRYPT_FAILED on a wrong one. */
	async read(): Promise<Snapshot> {
		const snap = await readBox(await asBytes(this.input), this.password);
		const collections = Object.fromEntries(
			Object.entries(snap.collections).filter(
				([name]) => !name.startsWith(RESERVED_COLLECTION_PREFIX)
			)
		);
		return { collections, files: snap.files };
	}
}
