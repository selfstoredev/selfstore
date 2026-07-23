import { describe, it, expect } from 'vitest';
import { argon2id } from 'hash-wasm';
import { assertKdfBounds, fromBase64, DEFAULT_ARGON2, mintSlot, openSlot } from './crypto';
import type { KdfParams } from './types';
import { SelfstoreError } from './errors';

const hex = (u: Uint8Array): string => [...u].map((b) => b.toString(16).padStart(2, '0')).join('');

/**
 * Known-answer test for the KDF. The vector below was produced by hash-wasm's
 * Argon2id (which validates against the Argon2 reference vectors in its own CI)
 * with the exact parameter mapping deriveKey() uses - `m` in KiB, `t` iterations,
 * `p` lanes, a 32-byte tag. Pinning it catches two silent failures: our pinned
 * hash-wasm changing its output on an upgrade (old encrypted backups would stop
 * decrypting), and a mistake in how we pass the parameters. The raw-vs-encoded
 * cross-check confirms the digest is the primitive's, not a coincidence.
 */
describe('argon2id KAT (v1.3, m in KiB)', () => {
	const password = new Uint8Array(32).fill(0x01);
	const salt = new Uint8Array(16).fill(0x02);
	const params = { parallelism: 1, iterations: 3, memorySize: 256, hashLength: 32 };
	const EXPECTED = '79b62406841693e13e3ca6a908ca3c20a7ec1a48931461cb54065e63640d1003';

	it('reproduces the pinned digest for fixed inputs', async () => {
		const raw = await argon2id({ password, salt, ...params, outputType: 'binary' });
		expect(hex(raw)).toBe(EXPECTED);
	});

	it('the encoded PHC string carries the same digest', async () => {
		const encoded = await argon2id({ password, salt, ...params, outputType: 'encoded' });
		const digest = encoded.split('$').pop()!; // base64 tag (no padding)
		expect(hex(fromBase64(digest + '='))).toBe(EXPECTED);
		expect(encoded).toContain('$argon2id$v=19$m=256,t=3,p=1$');
	});
});

describe('KDF read-side ceiling', () => {
	const kdf = (over: Partial<KdfParams>): KdfParams => ({
		algo: 'argon2id',
		salt: 'AgICAgICAgICAgICAgICAg==',
		...DEFAULT_ARGON2,
		...over
	});

	it('accepts the parameters we actually write', () => {
		expect(() => assertKdfBounds(kdf({}))).not.toThrow();
	});

	it('refuses a memory-hard bomb (m above 1 GiB) as UNSUPPORTED_VERSION', () => {
		expect(() => assertKdfBounds(kdf({ m: 8_000_000 }))).toThrowError(/out of the supported range/);
		try {
			assertKdfBounds(kdf({ m: 8_000_000 }));
		} catch (e) {
			expect((e as SelfstoreError).code).toBe('UNSUPPORTED_VERSION');
		}
	});

	it('refuses absurd t / p', () => {
		expect(() => assertKdfBounds(kdf({ t: 99 }))).toThrow();
		expect(() => assertKdfBounds(kdf({ p: 99 }))).toThrow();
	});
});

describe('password envelope slots', () => {
	it('mints and opens a slot; a wrong password is null, not a throw', async () => {
		const dataKey = crypto.getRandomValues(new Uint8Array(32));
		const slot = await mintSlot('pw-a', dataKey, 'owner');
		expect(slot.id).toBe('owner');
		expect(slot.kdf.algo).toBe('argon2id');
		expect(await openSlot(slot, 'pw-a')).toEqual(dataKey);
		expect(await openSlot(slot, 'pw-b')).toBeNull();
	});

	it('a KDF bomb in a slot refuses loudly, never hides behind "wrong password"', async () => {
		const dataKey = crypto.getRandomValues(new Uint8Array(32));
		const slot = await mintSlot('pw', dataKey);
		slot.kdf.m = 8_000_000; // a hostile file could declare this per slot
		await expect(openSlot(slot, 'pw')).rejects.toMatchObject({ code: 'UNSUPPORTED_VERSION' });
	});

	it('every slot gets its own id, salt and IV, even for the same inputs', async () => {
		const dataKey = crypto.getRandomValues(new Uint8Array(32));
		const a = await mintSlot('same-pw', dataKey);
		const b = await mintSlot('same-pw', dataKey);
		expect(a.id).not.toEqual(b.id);
		expect(a.kdf.salt).not.toEqual(b.kdf.salt);
		expect(a.iv).not.toEqual(b.iv);
		expect(a.wrapped).not.toEqual(b.wrapped);
	});
});
