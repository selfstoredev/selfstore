// AES-256-GCM via WebCrypto over an Argon2id-derived key (hash-wasm). The
// derivation runs in a worker when the platform has one (see kdf.ts); the
// WASM is imported dynamically so it only loads when a password is used.

import type { KdfParams, PasswordSlot, ExternalSlot } from './types';
import { deriveRaw } from './kdf';
import { toBase64, fromBase64 } from './base64';
import { SelfstoreError } from './errors';

export { toBase64, fromBase64 };

const IV_BYTES = 12;
const SALT_BYTES = 16;

/**
 * Cost for new backups: 46 MiB, 3 passes - above the OWASP Argon2id minimum,
 * ~1-2 s on a phone. Params are stored per file, so older backups keep
 * decrypting with their own cost.
 */
export const DEFAULT_ARGON2 = { m: 47104, t: 3, p: 1 } as const;

/**
 * Read-side ceiling (m is in KiB: 1 GiB, 10 passes, 4 lanes). Without it a
 * crafted file could declare m = 8_000_000 and make the reader allocate
 * gigabytes before any password check. Out-of-range params are
 * UNSUPPORTED_VERSION, not DECRYPT_FAILED - the file is not corrupt, its
 * parameters are just outside what this reader will run.
 */
const KDF_MAX = { m: 1024 * 1024, t: 10, p: 4 } as const;
const KDF_MIN = { m: 8, t: 1, p: 1 } as const;

/** Throws UNSUPPORTED_VERSION on out-of-range Argon2 params. Call before touching the WASM. */
export function assertKdfBounds(kdf: KdfParams): void {
	const { m, t, p } = kdf;
	const ok =
		Number.isInteger(m) &&
		Number.isInteger(t) &&
		Number.isInteger(p) &&
		m >= KDF_MIN.m &&
		m <= KDF_MAX.m &&
		t >= KDF_MIN.t &&
		t <= KDF_MAX.t &&
		p >= KDF_MIN.p &&
		p <= KDF_MAX.p;
	if (!ok) {
		throw new SelfstoreError(
			'UNSUPPORTED_VERSION',
			`Argon2 parameters out of the supported range (m=${m} KiB, t=${t}, p=${p}).`
		);
	}
}

function randomBytes(n: number): Uint8Array {
	const b = new Uint8Array(n);
	crypto.getRandomValues(b);
	return b;
}

/** Coerce to the ArrayBuffer-backed view WebCrypto's types want (always safe here). */
function src(u8: Uint8Array): Uint8Array<ArrayBuffer> {
	return u8 as Uint8Array<ArrayBuffer>;
}

/**
 * Derive the AES-256-GCM key for `kdf`, imported non-extractable. Shared by
 * the backup cipher and the identity vault's passphrase lock.
 */
export async function deriveKey(password: string, kdf: KdfParams): Promise<CryptoKey> {
	const raw = await deriveRaw(password, kdf);
	return crypto.subtle.importKey('raw', src(raw), 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/** Fresh salt at the current default cost, for a new password-sealed write. */
export function freshKdfParams(): KdfParams {
	return { algo: 'argon2id', salt: toBase64(randomBytes(SALT_BYTES)), ...DEFAULT_ARGON2 };
}

// --- Password envelope (format 3) slots --------------------------------------

/**
 * Each slot costs one Argon2id trial on open, so an unbounded list would let
 * a crafted file demand unbounded memory-hard work. Same spirit as
 * assertKdfBounds.
 */
export const MAX_KEY_SLOTS = 8;

/** Wrap the 32-byte data key under a key derived from `password`, fresh salt and IV. */
export async function mintSlot(
	password: string,
	dataKey: Uint8Array,
	id?: string
): Promise<PasswordSlot> {
	const kdf = freshKdfParams();
	const key = await deriveKey(password, kdf);
	const iv = randomBytes(IV_BYTES);
	const wrapped = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: src(iv) }, key, src(dataKey));
	return {
		id: id ?? toBase64(randomBytes(6)),
		kdf,
		iv: toBase64(iv),
		wrapped: toBase64(new Uint8Array(wrapped))
	};
}

/**
 * Returns the data key if `password` opens this slot, else null. GCM keeps
 * wrong-password and tampering indistinguishable (fail closed). Bounds are
 * checked before any derivation, and that refusal is never swallowed - a
 * memory-hard bomb must not hide behind "wrong password".
 */
export async function openSlot(slot: PasswordSlot, password: string): Promise<Uint8Array | null> {
	assertKdfBounds(slot.kdf);
	try {
		const key = await deriveKey(password, slot.kdf);
		const pt = await crypto.subtle.decrypt(
			{ name: 'AES-GCM', iv: src(fromBase64(slot.iv)) },
			key,
			src(fromBase64(slot.wrapped))
		);
		const dataKey = new Uint8Array(pt);
		return dataKey.length === 32 ? dataKey : null;
	} catch (e) {
		if (e instanceof SelfstoreError) throw e;
		return null;
	}
}

// --- Authenticated envelope (format 3) data seal -----------------------------

/**
 * Seal the inner ZIP under the data key with the header bytes as AAD. Format
 * 5 passes the exact meta.json bytes here, which binds the slot table to the
 * ciphertext: write access to the file is not enough to strip or swap a key
 * slot without breaking the tag. The caller generates the iv (it rides in
 * meta.json, hence inside the AAD) so seal and open agree byte for byte.
 */
export async function gcmSealAad(
	key32: Uint8Array,
	iv: Uint8Array,
	plaintext: Uint8Array,
	aad: Uint8Array
): Promise<Uint8Array> {
	const key = await crypto.subtle.importKey('raw', src(key32), 'AES-GCM', false, ['encrypt']);
	const ct = await crypto.subtle.encrypt(
		{ name: 'AES-GCM', iv: src(iv), additionalData: src(aad) },
		key,
		src(plaintext)
	);
	return new Uint8Array(ct);
}

/**
 * Open sealed data. `aad` is the additional authenticated data bound at seal
 * time (the envelope binds its header bytes); pass none for seals that bound
 * none. Any tag failure - wrong key, corrupt data, altered header - is one
 * DECRYPT_FAILED.
 */
export async function gcmOpenAad(
	key32: Uint8Array,
	iv: Uint8Array,
	ciphertext: Uint8Array,
	aad?: Uint8Array
): Promise<Uint8Array> {
	try {
		const key = await crypto.subtle.importKey('raw', src(key32), 'AES-GCM', false, ['decrypt']);
		const params: AesGcmParams = { name: 'AES-GCM', iv: src(iv) };
		if (aad) params.additionalData = src(aad);
		const pt = await crypto.subtle.decrypt(params, key, src(ciphertext));
		return new Uint8Array(pt);
	} catch {
		throw new SelfstoreError('DECRYPT_FAILED', 'Corrupted, wrong-key, or altered-header ciphertext.');
	}
}

// --- External-key slots ------------------------------------------------------

// A passkey PRF output is 32 bytes; anything under 16 is too weak to key a backup.
const MIN_EXTERNAL_SECRET = 16;

const EXTERNAL_INFO = new TextEncoder().encode('selfstore-external-slot-v1');

/**
 * KEK for an external slot. The secret is already high-entropy (passkey PRF,
 * hardware token), so one HKDF-SHA256 expansion is enough - Argon2 only
 * exists to stretch low-entropy passwords. The fixed info label
 * domain-separates this use from any other the same secret might see.
 */
async function externalKek(secret: Uint8Array): Promise<CryptoKey> {
	const ikm = await crypto.subtle.importKey('raw', src(secret), 'HKDF', false, ['deriveBits']);
	const bits = await crypto.subtle.deriveBits(
		{ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: src(EXTERNAL_INFO) },
		ikm,
		256
	);
	return crypto.subtle.importKey('raw', src(new Uint8Array(bits)), 'AES-GCM', false, [
		'encrypt',
		'decrypt'
	]);
}

/** Wrap the data key under a KEK derived from `secret`; `keyRef` is carried verbatim. */
export async function mintExternalSlot(
	secret: Uint8Array,
	keyRef: string,
	dataKey: Uint8Array,
	id?: string
): Promise<ExternalSlot> {
	if (secret.length < MIN_EXTERNAL_SECRET) {
		throw new TypeError(`mintExternalSlot(): external secret must be >= ${MIN_EXTERNAL_SECRET} bytes.`);
	}
	const key = await externalKek(secret);
	const iv = randomBytes(IV_BYTES);
	const wrapped = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: src(iv) }, key, src(dataKey));
	return {
		id: id ?? toBase64(randomBytes(6)),
		kind: 'external',
		keyRef,
		iv: toBase64(iv),
		wrapped: toBase64(new Uint8Array(wrapped))
	};
}

/** Returns the data key if `secret` opens this slot, else null. Fail closed, like openSlot. */
export async function openExternalSlot(
	slot: ExternalSlot,
	secret: Uint8Array
): Promise<Uint8Array | null> {
	if (secret.length < MIN_EXTERNAL_SECRET) return null;
	try {
		const key = await externalKek(secret);
		const pt = await crypto.subtle.decrypt(
			{ name: 'AES-GCM', iv: src(fromBase64(slot.iv)) },
			key,
			src(fromBase64(slot.wrapped))
		);
		const dataKey = new Uint8Array(pt);
		return dataKey.length === 32 ? dataKey : null;
	} catch {
		return null;
	}
}
