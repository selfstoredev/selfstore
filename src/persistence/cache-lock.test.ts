import { describe, it, expect } from 'vitest';
import { seal, newDeviceKey } from './cache-crypto';
import { keyFromPassword, opens, freshCacheKdf } from './cache-lock';

// Cheap Argon2id so the derivation does not dominate the suite; correctness of
// the derivation itself is the backup crypto's concern, tested there.
const cheap = () => ({ ...freshCacheKdf(), m: 8, t: 1, p: 1 });

describe('cache-lock', () => {
	it('the same password + params derive a key that opens what the first sealed', async () => {
		const kdf = cheap();
		const first = await keyFromPassword('correct horse', kdf);
		const again = await keyFromPassword('correct horse', kdf);
		const probe = await seal(first, new TextEncoder().encode('clinic notes'));
		expect(await opens(again, probe)).toBe(true);
	});

	it('a wrong password does not open the probe', async () => {
		const kdf = cheap();
		const right = await keyFromPassword('correct horse', kdf);
		const wrong = await keyFromPassword('correct h0rse', kdf);
		const probe = await seal(right, new TextEncoder().encode('secret'));
		expect(await opens(wrong, probe)).toBe(false);
	});

	it('a different salt derives a different key even for the same password', async () => {
		const a = await keyFromPassword('same', cheap());
		const probe = await seal(a, new Uint8Array([1, 2, 3]));
		const b = await keyFromPassword('same', cheap()); // fresh salt
		expect(await opens(b, probe)).toBe(false);
	});

	it('an unrelated key does not open the probe (external-key path)', async () => {
		const probe = await seal(await keyFromPassword('pw', cheap()), new Uint8Array([9]));
		expect(await opens(await newDeviceKey(), probe)).toBe(false);
	});

	it('freshCacheKdf mints argon2id params with a random salt', () => {
		const a = freshCacheKdf();
		const b = freshCacheKdf();
		expect(a.algo).toBe('argon2id');
		expect(a.salt).not.toBe(b.salt);
	});
});
