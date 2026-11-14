import { describe, it, expect } from 'vitest';
import { openManifest, type SignedManifest } from './group';

describe('openManifest – malformed manifest signature or keys', () => {
	it('throws SIGNATURE_INVALID with the exact message on decode error', async () => {
		const badSigned: SignedManifest = {
			selfstoreManifest: 1,
			payload: '!!!invalid base64!!!',
			sig: ''
		};
		await expect(openManifest(badSigned, 'someAdminKey')).rejects.toThrow(
			expect.objectContaining({
				code: 'SIGNATURE_INVALID',
				message: 'Malformed manifest signature or keys.'
			})
		);
	});
});
