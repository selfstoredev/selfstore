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
import { verifyBackup, countsOf } from './verify';

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

	/**
	 * Read the backup back before handing it over, and throw VERIFY_FAILED if it
	 * does not hold what went in.
	 *
	 * A backup encrypted with a key nobody can reproduce, truncated, or built
	 * from an empty snapshot looks exactly like a good one: right name, right
	 * date, plausible size. The difference only shows up on the day of the
	 * disaster, when it is too late to make another. The only way to know is to
	 * open it, and it costs one decrypt of data the app already holds.
	 *
	 * Applies to every terminal below, so a host cannot verify and then write a
	 * different set of bytes by accident.
	 */
	verified(): BackupBuilder {
		return new BackupBuilder(this.snapshot, { ...this.opts, verify: true });
	}

	/** The backup as raw bytes. */
	async toBytes(): Promise<Uint8Array> {
		const bytes = await writeBox(this.snapshot, this.opts);
		if (this.opts.verify) {
			await verifyBackup(bytes, { password: this.opts.password, expect: countsOf(this.snapshot) });
		}
		return bytes;
	}

	/** The backup as a Blob, ready to upload or hand to a save dialog. */
	async toBlob(): Promise<Blob> {
		return new Blob([(await this.toBytes()) as BlobPart], { type: BACKUP_MIME });
	}

	/** Save the backup to disk (File System Access API, else a download).
	 *  Browser-only terminal; defaults to `<app>-<date>.zip`. False when the
	 *  user closed the save dialog: nothing was written, so do not tell them
	 *  they have a backup.
	 *
	 *  Asks WHERE first, encrypts after. The save dialog needs the transient
	 *  activation of the click that led here, and building an encrypted backup
	 *  outlives it (Argon2id is deliberately slow): encrypting first made the
	 *  browser refuse the dialog and silently download instead, turning a file
	 *  the user chose into one they have to go and find. */
	async toDisk(filename?: string): Promise<boolean> {
		const name =
			filename ?? `${this.opts.app}-${new Date().toISOString().slice(0, 10)}${BACKUP_EXTENSION}`;
		const { pickSaveHandle, writeToHandle, downloadBlob } = await import('./targets/local');
		const cible = await pickSaveHandle(name);
		if (cible === 'CANCELLED') return false;
		const blob = await this.toBlob();
		if (cible) {
			await writeToHandle(cible.handle, blob);
			return true;
		}
		downloadBlob(blob, name);
		return true;
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

	/** Same guarantee, keeping the encrypted chain's own links reachable. */
	override verified(): EncryptedBackupBuilder {
		return new EncryptedBackupBuilder(this.snapshot, { ...this.opts, verify: true });
	}

	/** Brand the README shipped inside the encrypted ZIP. */
	withReadme(text: string): EncryptedBackupBuilder {
		return new EncryptedBackupBuilder(this.snapshot, { ...this.opts, readme: text });
	}

	/**
	 * A second secret that also opens this backup - a recovery code the user
	 * printed and put away.
	 *
	 * A password that only lives in one person's memory is the likeliest way a
	 * local-first backup dies: no server can reset it, so the day it is
	 * forgotten the data is gone for good. The envelope has always held several
	 * key slots (see `keys[]` in the header); this exposes them where a backup
	 * is actually written. Each secret wraps the SAME data key, so either one
	 * opens the file and neither can read the other.
	 *
	 * Call it more than once for more than one recovery secret. Reading needs no
	 * change: `restore(...).withPassword(code)` already tries every slot.
	 */
	alsoOpenedWith(secret: string): EncryptedBackupBuilder {
		if (!secret) {
			throw new TypeError('alsoOpenedWith(): a non-empty secret is required.');
		}
		return new EncryptedBackupBuilder(this.snapshot, {
			...this.opts,
			extraSecrets: [...(this.opts.extraSecrets ?? []), secret]
		});
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
