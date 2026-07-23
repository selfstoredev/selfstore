/**
 * The identity vault's opt-in passphrase lock. Pins the one CRITICAL
 * invariant - a locked identity is never opened, replaced or re-minted
 * without the passphrase (load/loadOrCreate/save throw PASSWORD_REQUIRED,
 * they never return null over a lock) - plus the exact error codes, the
 * back-compat promise (a pre-lock bare envelope keeps loading), and the
 * same KDF read-side ceiling as backup decrypts. Device-mode basics live
 * in groups.test.ts.
 */

import { describe, it, expect } from 'vitest';
import { identityVault } from './identity';
import { memoryCache } from './cache';
import { seal, newDeviceKey } from './cache-crypto';
import { generateIdentity } from '../selfstore/group';
import type { KdfParams } from '../selfstore/types';
import type { EncEnvelope } from './cache-crypto';

const IDENTITY_KEY = 'groupIdentity';
const PW = 'correct horse battery staple';

/** The stored lock wrapper, as the tests read it back from kv to tamper with. */
interface StoredLock {
	selfstoreVaultLock: 1;
	kdf: KdfParams;
	envelope: EncEnvelope;
}

function freshVault() {
	const cache = memoryCache();
	return { kv: cache.kv, vault: identityVault(cache.kv) };
}

describe('identityVault passphrase lock', () => {
	it('protect: load and loadOrCreate throw PASSWORD_REQUIRED and never touch the stored value', async () => {
		const { kv, vault } = freshVault();
		const identity = await vault.loadOrCreate();
		await vault.protect(PW);
		expect(await vault.isProtected()).toBe(true);

		const before = await kv.get(IDENTITY_KEY);
		await expect(vault.load()).rejects.toMatchObject({ code: 'PASSWORD_REQUIRED' });
		// The critical one: loadOrCreate must never mint a second identity over a lock.
		await expect(vault.loadOrCreate()).rejects.toMatchObject({ code: 'PASSWORD_REQUIRED' });
		expect(await kv.get(IDENTITY_KEY)).toBe(before); // same stored value, byte for byte

		// The lock still opens, to the exact same identity, and leaks nothing at rest.
		expect(await vault.unlock(PW)).toEqual(identity);
		expect(JSON.stringify(before)).not.toContain(identity.sigPriv);
	});

	it('unlock: wrong passphrase throws DECRYPT_FAILED, the right one still opens', async () => {
		const { vault } = freshVault();
		const identity = await vault.loadOrCreate();
		await vault.protect(PW);
		await expect(vault.unlock('wrong horse')).rejects.toMatchObject({ code: 'DECRYPT_FAILED' });
		expect(await vault.unlock(PW)).toEqual(identity);
	});

	it('unprotect restores device mode; a wrong passphrase leaves the vault untouched', async () => {
		const { vault } = freshVault();
		const identity = await vault.loadOrCreate();
		await vault.protect(PW);

		await expect(vault.unprotect('wrong horse')).rejects.toMatchObject({ code: 'DECRYPT_FAILED' });
		expect(await vault.isProtected()).toBe(true); // untouched: still locked

		await vault.unprotect(PW);
		expect(await vault.isProtected()).toBe(false);
		expect(await vault.load()).toEqual(identity); // device mode again, same identity
	});

	it('protect on an EMPTY vault creates and protects in one step', async () => {
		const { vault } = freshVault();
		await vault.protect(PW);
		expect(await vault.isProtected()).toBe(true);
		await expect(vault.load()).rejects.toMatchObject({ code: 'PASSWORD_REQUIRED' });
		const identity = await vault.unlock(PW);
		// A real, complete identity was minted under the lock.
		for (const k of ['sigPub', 'sigPriv', 'encPub', 'encPriv'] as const) {
			expect(identity[k]).toBeTypeOf('string');
			expect(identity[k].length).toBeGreaterThan(0);
		}
	});

	it('protect on an already-protected vault throws PASSWORD_REQUIRED (no silent rekey)', async () => {
		const { kv, vault } = freshVault();
		await vault.protect(PW);
		const before = await kv.get(IDENTITY_KEY);
		await expect(vault.protect('another one')).rejects.toMatchObject({ code: 'PASSWORD_REQUIRED' });
		expect(await kv.get(IDENTITY_KEY)).toBe(before); // the original lock survives
		await expect(vault.unlock('another one')).rejects.toMatchObject({ code: 'DECRYPT_FAILED' });
		expect(await vault.unlock(PW)).toBeTruthy(); // and the original passphrase still opens
	});

	it('save on a protected vault throws PASSWORD_REQUIRED (never overwrites a lock)', async () => {
		const { vault } = freshVault();
		const identity = await vault.loadOrCreate();
		await vault.protect(PW);
		await expect(vault.save(await generateIdentity())).rejects.toMatchObject({
			code: 'PASSWORD_REQUIRED'
		});
		expect(await vault.unlock(PW)).toEqual(identity); // the locked one is intact
	});

	it('clear works even when protected (lost-passphrase escape hatch); the next identity is FRESH', async () => {
		const { vault } = freshVault();
		const old = await vault.loadOrCreate();
		await vault.protect(PW);
		await vault.clear();
		expect(await vault.isProtected()).toBe(false);
		const fresh = await vault.loadOrCreate(); // a new identity, not the forgotten one
		expect(fresh.sigPub).not.toBe(old.sigPub);
		expect(fresh.encPub).not.toBe(old.encPub);
	});

	it('back-compat: a pre-lock vault (bare envelope under the device key) still loads', async () => {
		// Hand-write the exact shape every vault produced before the lock existed.
		const cache = memoryCache();
		const identity = await generateIdentity();
		const deviceKey = await newDeviceKey();
		await cache.kv.set('groupVaultKey', deviceKey);
		await cache.kv.set(
			IDENTITY_KEY,
			await seal(deviceKey, new TextEncoder().encode(JSON.stringify(identity)))
		);
		const vault = identityVault(cache.kv);
		expect(await vault.isProtected()).toBe(false);
		expect(await vault.load()).toEqual(identity);
	});

	it('unlock refuses a KDF bomb as UNSUPPORTED_VERSION before deriving (tampered kv)', async () => {
		const { kv, vault } = freshVault();
		await vault.protect(PW);
		const stored = (await kv.get(IDENTITY_KEY)) as StoredLock;
		await kv.set(IDENTITY_KEY, { ...stored, kdf: { ...stored.kdf, m: 8_000_000 } });
		await expect(vault.unlock(PW)).rejects.toMatchObject({ code: 'UNSUPPORTED_VERSION' });
	});

	it('a tampered ciphertext fails closed as DECRYPT_FAILED', async () => {
		const { kv, vault } = freshVault();
		await vault.protect(PW);
		const stored = (await kv.get(IDENTITY_KEY)) as StoredLock;
		new Uint8Array(stored.envelope.ct)[0] ^= 0xff; // flip one byte
		await expect(vault.unlock(PW)).rejects.toMatchObject({ code: 'DECRYPT_FAILED' });
	});

	it('every protect draws a fresh random salt', async () => {
		const { kv, vault } = freshVault();
		await vault.protect(PW);
		const first = ((await kv.get(IDENTITY_KEY)) as StoredLock).kdf.salt;
		await vault.unprotect(PW);
		await vault.protect(PW); // same passphrase, new lock
		expect(((await kv.get(IDENTITY_KEY)) as StoredLock).kdf.salt).not.toBe(first);
	});

	it('guards: unlock/unprotect on an unprotected vault and an empty passphrase are TypeErrors', async () => {
		const { vault } = freshVault();
		await vault.loadOrCreate();
		await expect(vault.unlock(PW)).rejects.toThrow(TypeError);
		await expect(vault.unprotect(PW)).rejects.toThrow(TypeError);
		await expect(vault.protect('')).rejects.toThrow(TypeError);
		expect(await vault.isProtected()).toBe(false); // nothing changed
	});
});
