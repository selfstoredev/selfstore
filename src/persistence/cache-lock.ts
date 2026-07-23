// Seal-key material for a lock-mode cache. The key is derived from a password
// (the backup's Argon2id KDF) or supplied by the app (e.g. a passkey PRF key),
// and is held in memory only - never written next to the data. That is what a
// device-key seal (cache-crypto) cannot give: a copy of the whole browser
// profile carries the device key, but not a secret kept in RAM. Only the KDF
// salt is persisted, and a salt is not secret.

import { unseal, type EncEnvelope } from './cache-crypto';
import { deriveKey, freshKdfParams } from '../selfstore/crypto';
import type { KdfParams } from '../selfstore/types';

/** Argon2id parameters for a password-locked cache; persisted in the clear. */
export type CacheKdf = KdfParams;

/** Fresh Argon2id parameters (random salt, current default cost). */
export function freshCacheKdf(): CacheKdf {
	return freshKdfParams();
}

/** Derive the AES-GCM seal key from a password and its stored parameters. */
export function keyFromPassword(password: string, kdf: CacheKdf): Promise<CryptoKey> {
	return deriveKey(password, kdf);
}

/** True if `key` decrypts `probe`. A wrong key fails AES-GCM authentication;
 *  that is a wrong-secret answer, never an error to surface. */
export async function opens(key: CryptoKey, probe: EncEnvelope): Promise<boolean> {
	try {
		await unseal(key, probe);
		return true;
	} catch {
		return false;
	}
}
