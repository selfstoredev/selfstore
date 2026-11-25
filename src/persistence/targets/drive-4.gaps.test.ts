import { describe, it, expect, vi } from 'vitest';
import { unshare } from './drive';
import { SelfstoreError } from '../../selfstore';
import type { DriveAuth } from './drive';

describe('unshare error handling', () => {
	it('throws TARGET_UNAVAILABLE when the permissions list fails', async () => {
		const badResponse = new Response(null, { status: 500, statusText: 'Server Error' });
		const fetchMock = vi.fn().mockResolvedValueOnce(badResponse);
		const origFetch = global.fetch;
		vi.stubGlobal('fetch', fetchMock);

		const auth: DriveAuth = {
			token: () => Promise.resolve('fake-token'),
			reconnect: vi.fn(),
			forget: vi.fn()
		};

		await expect(unshare({ auth, fileId: 'dummy-file-id' })).rejects.toThrowError(
			new SelfstoreError('TARGET_UNAVAILABLE', 'Drive permissions failed: 500')
		);

		expect(fetchMock).toHaveBeenCalledOnce();

		global.fetch = origFetch;
	});
});
