// At-rest encryption for the local cache: AES-256-GCM, fresh IV per record,
// under a non-extractable device key kept next to the data. Defeats casual
// inspection, partial exfiltration, and disk forensics of the store; does not
// stop code running in the origin or a copy of the whole browser profile
// (the key travels with it). No IndexedDB in here - unit-tests on WebCrypto.

/** An encrypted record: the GCM IV plus the ciphertext, both raw bytes. */
export interface EncEnvelope {
	__enc: 1;
	iv: ArrayBuffer;
	ct: ArrayBuffer;
}

/** Whether a stored value is one of our encrypted envelopes. */
export function isEnvelope(v: unknown): v is EncEnvelope {
	return typeof v === 'object' && v !== null && (v as { __enc?: unknown }).__enc === 1;
}

/** Fresh non-extractable AES-256-GCM device key - its bytes can never be read back out. */
export function newDeviceKey(): Promise<CryptoKey> {
	return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/** Encrypt bytes into an envelope with a fresh 96-bit IV. */
export async function seal(key: CryptoKey, plain: Uint8Array): Promise<EncEnvelope> {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain as BufferSource);
	return { __enc: 1, iv: iv.buffer, ct };
}

/** Decrypt an envelope. Throws on wrong key or tampered bytes - let it
 *  propagate, a decrypt failure is never "no data" (that would risk
 *  overwriting recoverable ciphertext). */
export async function unseal(key: CryptoKey, env: EncEnvelope): Promise<Uint8Array> {
	const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: env.iv }, key, env.ct);
	return new Uint8Array(plain);
}
