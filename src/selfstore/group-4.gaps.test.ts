import { describe, it, expect } from 'vitest';
import { gcmSealRaw, gcmOpenRaw } from './group';
import { SelfstoreError } from './errors';

describe('gcmOpenRaw', () => {
	it('returns plaintext when key, iv, ciphertext are correct', async () => {
		const key = crypto.getRandomValues(new Uint8Array(32));
		const plaintext = new Uint8Array([1, 2, 3, 4]);
		const { iv, ciphertext } = await gcmSealRaw(key, plaintext);
		const out = await gcmOpenRaw(key, iv, ciphertext);
		expect(out).toEqual(plaintext);
	});

	it('throws SelfstoreError DECRYPT_FAILED on wrong key', async () => {
		const key = crypto.getRandomValues(new Uint8Array(32));
		const wrongKey = crypto.getRandomValues(new Uint8Array(32));
		const plaintext = new Uint8Array([5, 6, 7, 8]);
		const { iv, ciphertext } = await gcmSealRaw(key, plaintext);
		await expect(gcmOpenRaw(wrongKey, iv, ciphertext)).rejects.toEqual(
			new SelfstoreError('DECRYPT_FAILED', 'Corrupted or mismatched group ciphertext.')
		);
	});
});
