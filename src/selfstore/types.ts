// Public types. selfstore is schema-agnostic: named collections of opaque
// documents plus binary files. The app owns the schema and its migrations.

/** A binary attachment (image, PDF, any bytes). */
export interface SnapshotFile {
	id: string;
	name: string;
	mime: string;
	bytes: Uint8Array;
}

/**
 * Collection names starting with `__` are reserved for library bookkeeping
 * (createLocalStore keeps its sync metadata under `__store`). The fluent
 * `backup()` rejects them and `read()` strips them.
 */
export const RESERVED_COLLECTION_PREFIX = '__';

/** Everything a backup carries. Collection names must not start with `__`. */
export interface Snapshot {
	collections: Record<string, unknown[]>;
	files: SnapshotFile[];
}

/** Key-derivation parameters. Stored cleartext so older files still decode. */
export interface KdfParams {
	algo: 'argon2id';
	salt: string;
	m: number;
	t: number;
	p: number;
}

/**
 * One wrap of the random data key under one password; any slot's password
 * opens the backup. Adding or removing a slot leaves the data key alone.
 * Changing a password rotates the data key (setEncryption) - that is the
 * operation that actually revokes access.
 */
export interface PasswordSlot {
	/** Random id so an app can list or drop a slot without knowing its
	 *  password. Cleartext, not authenticated. */
	id: string;
	/** Absent on password slots, so files written before external keys
	 *  existed still parse. */
	kind?: 'password';
	kdf: KdfParams;
	/** 96-bit IV of the wrap, base64. */
	iv: string;
	/** AES-256-GCM(KEK, dataKey) with tag appended: 48 bytes, base64. */
	wrapped: string;
}

/**
 * Data key wrapped under a caller-supplied 32-byte secret (passkey PRF,
 * hardware token). The library never performs the WebAuthn or hardware
 * exchange; the app derives the secret and hands it in. KEK is
 * HKDF-SHA256 of the secret - no Argon2, the input is already
 * high-entropy. Shares the `keys[]` table with password slots, so a
 * backup can hold e.g. a passkey plus a recovery password.
 */
export interface ExternalSlot {
	id: string;
	kind: 'external';
	/** App-owned locator for re-deriving the secret (say, a WebAuthn
	 *  credential id). Cleartext, never a security input. */
	keyRef: string;
	/** 96-bit IV of the wrap, base64. */
	iv: string;
	/** AES-256-GCM(KEK, dataKey) with tag appended: 48 bytes, base64. */
	wrapped: string;
}

export type KeySlot = PasswordSlot | ExternalSlot;

/**
 * Group mode (format 2): the per-publication AES key wrapped for one
 * recipient. `kid` = first 8 bytes of SHA-256(recipient X25519 public),
 * base64 - a locator, not a name. `epk` is the ephemeral X25519 public;
 * `wrap` is AES-256-GCM(dataKey) under HKDF of the ECDH shared secret.
 */
export interface RecipientStanza {
	kid: string;
	epk: string;
	iv: string;
	wrap: string;
}

/**
 * Cleartext metadata: the `meta.json` entry of the ZIP.
 *
 * app/appVersion/createdAt are cosmetic and unauthenticated - never base a
 * security decision on them. In password-envelope mode the wrapped data key
 * authenticates the payload; in group mode the author's Ed25519 signature
 * (sig.bin) covers the exact meta.json and data.enc bytes.
 */
export interface Header {
	/** Format generation: 2 = plain ZIP, 3 = group, 4 = password envelope.
	 *  Absent means 2. */
	format?: number;
	app: string;
	/** Writing app's release version, informational. */
	appVersion?: string;
	/** Writing app's data schema version (createLocalStore `version`).
	 *  Distinct from appVersion: this one drives migration. */
	schemaVersion?: number;
	createdAt: string;
	encryption: 'none' | 'aes-256-gcm';
	/** 96-bit IV of data.enc, base64. Present when encrypted. */
	iv?: string;
	/** Group mode: data-key envelope scheme ('x25519-hkdf-sha256'). */
	keying?: string;
	/** Group mode: author's Ed25519 public key. Trust only after verifying
	 *  sig.bin and membership in the group manifest. */
	author?: string;
	/** Group mode: one data-key envelope per recipient. */
	recipients?: RecipientStanza[];
	/** Password envelope only: the data key wrapped once per password.
	 *  Present iff format === 4. */
	keys?: KeySlot[];
}

/** Options for writing a backup. */
export interface EncodeOptions {
	app: string;
	appVersion?: string;
	schemaVersion?: number;
	/** Omit or leave empty for an unencrypted backup (a plain, readable ZIP). */
	password?: string;
	/** Group mode: encrypt to these recipients (raw X25519 publics, base64)
	 *  under a fresh data key and sign with the author's Ed25519 key.
	 *  Mutually exclusive with `password`. */
	group?: {
		recipients: string[];
		sign: { pub: string; priv: string };
	};
	/** README text shipped inside an encrypted backup, for whoever opens the
	 *  ZIP by hand. Defaults to a neutral note; apps should brand it. */
	readme?: string;
	/** Rewrite path: reuse this exact envelope (held data key + slot table
	 *  from the last read) so a writer that knows only one password keeps
	 *  every other slot. Mutually exclusive with `password` and `group`. */
	envelope?: { dataKey: Uint8Array; slots: KeySlot[] };
}
