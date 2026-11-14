import { describe, it, expect } from 'vitest';
import { openManifest, type SignedManifest } from './group';
import { SelfstoreError } from './errors';

const ADMIN_PUB = 'ZHVtbXktYWRtaW4tcHVibGljLWtleS1iYXNlNjQ='; // dummy base64

describe('openManifest - invalid signed manifest structure', () => {
	it('throws SIGNATURE_INVALID with exact message when signed is null', async () => {
		try {
			await openManifest(null as unknown as SignedManifest, ADMIN_PUB);
			throw new Error('Expected to throw');
		} catch (e) {
			expect(e).toBeInstanceOf(SelfstoreError);
			expect((e as SelfstoreError).code).toBe('SIGNATURE_INVALID');
			expect((e as SelfstoreError).message).toBe('Not a signed selfstore manifest.');
		}
	});

	it('throws SIGNATURE_INVALID with exact message when selfstoreManifest is not 1', async () => {
		const signed = {
			selfstoreManifest: 2,
			payload: 'dGVzdA==',
			sig: 'dGVzdA=='
		} as unknown as SignedManifest;
		try {
			await openManifest(signed, ADMIN_PUB);
			throw new Error('Expected to throw');
		} catch (e) {
			expect(e).toBeInstanceOf(SelfstoreError);
			expect((e as SelfstoreError).code).toBe('SIGNATURE_INVALID');
			expect((e as SelfstoreError).message).toBe('Not a signed selfstore manifest.');
		}
	});

	it('throws SIGNATURE_INVALID with exact message when payload is not a string', async () => {
		const signed = {
			selfstoreManifest: 1,
			payload: 123,
			sig: 'dGVzdA=='
		} as unknown as SignedManifest;
		try {
			await openManifest(signed, ADMIN_PUB);
			throw new Error('Expected to throw');
		} catch (e) {
			expect(e).toBeInstanceOf(SelfstoreError);
			expect((e as SelfstoreError).code).toBe('SIGNATURE_INVALID');
			expect((e as SelfstoreError).message).toBe('Not a signed selfstore manifest.');
		}
	});
});
