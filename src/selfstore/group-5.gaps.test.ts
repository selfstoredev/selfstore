import { describe, it, expect } from 'vitest';
import { verifyBox } from './group';
import { toBase64 } from './base64';

describe('verifyBox catch branch', () => {
	const metaBytes = new Uint8Array([1, 2, 3]);
	const dataEnc = new Uint8Array([4, 5, 6]);
	const sig = new Uint8Array(64);

	it('returns false for invalid base64 public key', async () => {
		const result = await verifyBox(metaBytes, dataEnc, sig, '!!!');
		expect(result).toBe(false);
	});

	it('returns false for public key with wrong byte length', async () => {
		const shortKey = toBase64(new Uint8Array(31));
		const result = await verifyBox(metaBytes, dataEnc, sig, shortKey);
		expect(result).toBe(false);
	});
});
