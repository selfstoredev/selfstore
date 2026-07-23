// At-rest storage for a member identity (passwordless groups). Private keys
// are sealed under a non-extractable device key in the same kv - defeats disk
// forensics and partial exfiltration, not code running in the origin or a
// copy of the whole profile (THREAT-MODEL.md).
//
// The opt-in passphrase lock reseals the identity under Argon2id(passphrase)
// instead, closing the profile-copy gap at the cost of an unlock prompt. The
// vault keeps no unlocked session state: unlock() returns the identity, the
// caller holds it in memory, and at rest it stays sealed. A bare envelope
// keeps meaning device mode, so pre-lock vaults load unchanged.
//
// The identity is one person's; move it between their devices over a trusted
// channel (QR shown locally, encrypted note) - never through the group's
// shared storage.

import { seal, unseal, isEnvelope, newDeviceKey, type EncEnvelope } from './cache-crypto';
import type { KV } from './cache';
import { generateIdentity, type GroupIdentity } from '../selfstore/group';
import { deriveKey, freshKdfParams, assertKdfBounds } from '../selfstore/crypto';
import type { KdfParams } from '../selfstore/types';
import { SelfstoreError } from '../selfstore/errors';

const VAULT_KEY = 'groupVaultKey';
const IDENTITY_KEY = 'groupIdentity';

const utf8 = { enc: new TextEncoder(), dec: new TextDecoder() };

// Local kv bookkeeping only - not part of the interchange format (SPEC.md).
interface VaultLock {
	selfstoreVaultLock: 1;
	kdf: KdfParams;
	envelope: EncEnvelope;
}

function isVaultLock(v: unknown): v is VaultLock {
	return (
		typeof v === 'object' && v !== null && (v as { selfstoreVaultLock?: unknown }).selfstoreVaultLock === 1
	);
}

const encode = (identity: GroupIdentity): Uint8Array => utf8.enc.encode(JSON.stringify(identity));
const decode = (bytes: Uint8Array): GroupIdentity =>
	JSON.parse(utf8.dec.decode(bytes)) as GroupIdentity;

export interface IdentityVault {
	/** The stored identity, or null when none exists yet. On a protected
	 *  vault this throws PASSWORD_REQUIRED rather than returning null - a
	 *  locked identity exists, and null would invite loadOrCreate to mint a
	 *  second one over it. */
	load(): Promise<GroupIdentity | null>;
	/** Seal and store an identity, overwriting any previous one. Throws
	 *  PASSWORD_REQUIRED on a protected vault: a locked identity is never
	 *  silently replaced (unprotect() or clear() first). */
	save(identity: GroupIdentity): Promise<void>;
	/** load(), creating and storing a fresh identity when absent. Same
	 *  PASSWORD_REQUIRED rule as load(). */
	loadOrCreate(): Promise<GroupIdentity>;
	/** Forget the identity on this device. Allowed even when protected -
	 *  forgetting leaks nothing, and it is the honest lost-passphrase escape
	 *  hatch (re-import from another device, or get re-invited). */
	clear(): Promise<void>;
	isProtected(): Promise<boolean>;
	/** Decrypt a protected vault and return the identity. Stateless: the
	 *  caller holds it in memory, the stored value stays sealed. Wrong
	 *  passphrase and tampered blob are one DECRYPT_FAILED; hostile KDF
	 *  params are refused before any derivation. */
	unlock(passphrase: string): Promise<GroupIdentity>;
	/** Reseal the identity under Argon2id(passphrase); an empty vault gets a
	 *  fresh identity, created-and-protected in one step. Changing the
	 *  passphrase is unprotect(old) then protect(new) - an already-protected
	 *  vault throws PASSWORD_REQUIRED, never a silent rekey. */
	protect(passphrase: string): Promise<void>;
	/** Unlock with `passphrase`, then reseal under the device key. A wrong
	 *  passphrase throws DECRYPT_FAILED and leaves the vault untouched. */
	unprotect(passphrase: string): Promise<void>;
}

/** An identity vault over the app's kv (e.g. `indexedDbCache(app).kv`). */
export function identityVault(kv: KV): IdentityVault {
	async function vaultKey(): Promise<CryptoKey> {
		const existing = await kv.get<CryptoKey>(VAULT_KEY);
		if (existing) return existing;
		const fresh = await newDeviceKey();
		await kv.set(VAULT_KEY, fresh);
		return fresh;
	}

	/** Device mode's write path: a bare envelope under the device key. */
	async function sealDevice(identity: GroupIdentity): Promise<void> {
		await kv.set(IDENTITY_KEY, await seal(await vaultKey(), encode(identity)));
	}

	async function load(): Promise<GroupIdentity | null> {
		const stored = await kv.get(IDENTITY_KEY);
		if (isVaultLock(stored)) {
			throw new SelfstoreError(
				'PASSWORD_REQUIRED',
				'The identity vault is passphrase-protected. Call unlock(passphrase) - ' +
					'load()/loadOrCreate() never open or replace a locked identity.'
			);
		}
		if (!isEnvelope(stored)) return null;
		return decode(await unseal(await vaultKey(), stored));
	}

	async function save(identity: GroupIdentity): Promise<void> {
		if (isVaultLock(await kv.get(IDENTITY_KEY))) {
			throw new SelfstoreError(
				'PASSWORD_REQUIRED',
				'The identity vault is passphrase-protected; save() never overwrites a locked ' +
					'identity. unprotect(passphrase) first, or clear() to forget it.'
			);
		}
		await sealDevice(identity);
	}

	async function unlock(passphrase: string): Promise<GroupIdentity> {
		const stored = await kv.get(IDENTITY_KEY);
		if (!isVaultLock(stored)) {
			throw new TypeError('unlock(): the vault is not passphrase-protected (check isProtected()).');
		}
		if (!stored.kdf || !isEnvelope(stored.envelope)) {
			throw new SelfstoreError('BAD_FORMAT', 'Missing or malformed vault lock parameters.');
		}
		// Same read-side ceiling as backup decrypts: a tampered kv must not make
		// unlock allocate gigabytes (memory-hard bomb) before any passphrase check.
		assertKdfBounds(stored.kdf);
		try {
			return decode(await unseal(await deriveKey(passphrase, stored.kdf), stored.envelope));
		} catch (e) {
			if (e instanceof SelfstoreError) throw e;
			throw new SelfstoreError('DECRYPT_FAILED', 'Wrong passphrase or tampered identity vault.');
		}
	}

	async function protect(passphrase: string): Promise<void> {
		if (!passphrase) throw new TypeError('protect(): a non-empty passphrase is required.');
		const stored = await kv.get(IDENTITY_KEY);
		if (isVaultLock(stored)) {
			throw new SelfstoreError(
				'PASSWORD_REQUIRED',
				'The identity vault is already passphrase-protected. To change the passphrase: ' +
					'unprotect(oldPassphrase), then protect(newPassphrase).'
			);
		}
		const identity = isEnvelope(stored)
			? decode(await unseal(await vaultKey(), stored)) // reseal the existing identity
			: await generateIdentity(); // empty vault: create-and-protect in one step
		const kdf = freshKdfParams();
		const envelope = await seal(await deriveKey(passphrase, kdf), encode(identity));
		await kv.set(IDENTITY_KEY, { selfstoreVaultLock: 1, kdf, envelope } satisfies VaultLock);
	}

	return {
		load,
		save,
		unlock,
		protect,
		async loadOrCreate(): Promise<GroupIdentity> {
			const existing = await load(); // PASSWORD_REQUIRED when protected: never mint over a lock
			if (existing) return existing;
			const fresh = await generateIdentity();
			await save(fresh);
			return fresh;
		},
		async clear(): Promise<void> {
			await kv.del(IDENTITY_KEY);
		},
		async isProtected(): Promise<boolean> {
			return isVaultLock(await kv.get(IDENTITY_KEY));
		},
		async unprotect(passphrase: string): Promise<void> {
			// unlock() enforces "protected" and the passphrase; only then rewrite.
			await sealDevice(await unlock(passphrase));
		}
	};
}
