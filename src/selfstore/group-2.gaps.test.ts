import { describe, it, expect, vi } from 'vitest';

// Stub global crypto to simulate missing curves
vi.stubGlobal('crypto', {
	subtle: {
		generateKey: vi.fn(() => Promise.reject(new Error('Not supported')))
	}
});

import { generateIdentity } from './group';

describe('requireCurves throws when crypto missing', () => {
	it('throws TypeError with exact message when curves unavailable', async () => {
		let error: unknown;
		try {
			await generateIdentity();
		} catch (e) {
			error = e;
		}
		expect(error).toBeInstanceOf(TypeError);
		expect((error as Error).message).toBe(
			'Group mode needs WebCrypto Ed25519 and X25519 (evergreen browsers, Node 20+); this platform does not provide them. Use password mode instead, or upgrade the runtime.'
		);
	});
});
