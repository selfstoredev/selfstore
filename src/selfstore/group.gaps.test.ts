import { describe, it, expect, vi } from 'vitest';

describe('groupCryptoAvailable false path', () => {
	it('returns false when Ed25519 or X25519 is not available', async () => {
		vi.resetModules();
		vi.spyOn(crypto.subtle, 'generateKey').mockRejectedValue(new Error('Not supported'));
		const { groupCryptoAvailable } = await import('./group');
		expect(await groupCryptoAvailable()).toBe(false);
	});
});
