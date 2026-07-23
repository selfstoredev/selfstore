import { describe, it, expect } from 'vitest';
import { seal, unseal, isEnvelope, newDeviceKey } from './cache-crypto';

describe('cache-crypto', () => {
	it('round-trips bytes through a device key', async () => {
		const key = await newDeviceKey();
		const json = '{"accounts":[{"id":"a1","balance":1234.56}]}';
		const env = await seal(key, new TextEncoder().encode(json));
		expect(isEnvelope(env)).toBe(true);
		const back = new TextDecoder().decode(await unseal(key, env));
		expect(back).toBe(json);
	});

	it('uses a fresh IV each time (ciphertext is not deterministic)', async () => {
		const key = await newDeviceKey();
		const plain = new Uint8Array([1, 2, 3]);
		const a = await seal(key, plain);
		const b = await seal(key, plain);
		expect(new Uint8Array(a.iv)).not.toEqual(new Uint8Array(b.iv));
		expect(new Uint8Array(a.ct)).not.toEqual(new Uint8Array(b.ct));
		// And the ciphertext is not the plaintext.
		expect([...new Uint8Array(a.ct)]).not.toEqual([...plain]);
	});

	it('the device key cannot be exported (non-extractable)', async () => {
		const key = await newDeviceKey();
		expect(key.extractable).toBe(false);
		await expect(crypto.subtle.exportKey('raw', key)).rejects.toThrow();
	});

	it('unseal throws on the wrong key instead of losing data silently', async () => {
		const env = await seal(await newDeviceKey(), new Uint8Array([9, 9, 9]));
		await expect(unseal(await newDeviceKey(), env)).rejects.toThrow();
	});

	it('isEnvelope tells encrypted records from foreign plaintext', () => {
		expect(isEnvelope({ accounts: [] })).toBe(false); // bare collections
		expect(isEnvelope({ name: 'x.pdf', mime: 'application/pdf' })).toBe(false); // bare file record
		expect(isEnvelope(null)).toBe(false);
		expect(isEnvelope({ __enc: 1, iv: new ArrayBuffer(12), ct: new ArrayBuffer(4) })).toBe(true);
	});
});
