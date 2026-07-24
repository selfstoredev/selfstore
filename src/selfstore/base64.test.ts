import { describe, it, expect } from 'vitest';
import { toBase64, fromBase64 } from './base64';

/**
 * The shared base64 helpers underpin the crypto layer and the KDF worker, both
 * of which rely on an exact byte round-trip. These pin the encoding directly
 * rather than only through the crypto suites that happen to consume it.
 */
describe('base64', () => {
	it('encodes a known vector', () => {
		// "Hello" -> the canonical base64 of its ASCII bytes.
		expect(toBase64(new Uint8Array([72, 101, 108, 108, 111]))).toBe('SGVsbG8=');
	});

	it('maps the empty array to the empty string and back', () => {
		expect(toBase64(new Uint8Array())).toBe('');
		expect(fromBase64('')).toEqual(new Uint8Array());
	});

	it('round-trips every byte value', () => {
		const all = new Uint8Array(256);
		for (let i = 0; i < 256; i++) all[i] = i;
		expect(fromBase64(toBase64(all))).toEqual(all);
	});

	it('round-trips lengths that straddle the 3-byte base64 boundary', () => {
		for (let n = 0; n <= 8; n++) {
			const bytes = new Uint8Array(n);
			for (let i = 0; i < n; i++) bytes[i] = (i * 37 + 13) & 0xff;
			expect(fromBase64(toBase64(bytes))).toEqual(bytes);
		}
	});
});
