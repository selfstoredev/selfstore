import { describe, expect, it } from 'vitest';
import { selfstore } from './simple';
import { memoryCache } from '../persistence/cache';
import { SelfstoreError } from '../selfstore/errors';

describe('connectWebdav', () => {
	it('throws SelfstoreError when target is unavailable', async () => {
		const cache = memoryCache();
		const store = await selfstore<{ t: { id: string } }>('test-webdav', { cache });

		const config = {
			url: 'https://invalid.example.com',
			username: 'user',
			password: 'pass'
		};

		try {
			await store.connectWebdav(config);
			expect.unreachable('connectWebdav should have thrown');
		} catch (err) {
			expect(err).toBeInstanceOf(SelfstoreError);
			const selfstoreErr = err as SelfstoreError;
			expect(selfstoreErr.code).toBe('TARGET_UNAVAILABLE');
			expect(selfstoreErr.message).toBe(
				'The WebDAV server did not answer (URL, credentials or CORS).'
			);
		}

		store.dispose();
	});
});
