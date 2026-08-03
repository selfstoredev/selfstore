// The on-demand wrapper around WebDAV and S3. Their own behaviour is pinned in
// webdav.test.ts and s3.test.ts; what matters here is that going through a
// dynamic import changed nothing a caller can observe - same arguments, same
// results - and that a chunk which never arrives reads as the destination not
// answering rather than as a bare Error escaping a public path.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { memoryCache } from '../cache';
import { isSelfstoreError } from '../../selfstore';
import { s3Connect, s3FromSession, webdavConnect, webdavFromSession } from './servers';
import type { S3Config } from './s3';
import type { WebdavConfig } from './webdav';

const s3Config: S3Config = {
	endpoint: 'https://s3.eu-west-3.amazonaws.com',
	region: 'eu-west-3',
	bucket: 'my-bucket',
	key: 'backups/app.selfstore',
	accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
	secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'
};

const webdavConfig: WebdavConfig = {
	url: 'https://cloud.example.test/remote.php/dav/files/me/backup.zip',
	username: 'me',
	password: 'an-app-password'
};

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
	vi.restoreAllMocks();
	vi.doUnmock('./s3');
	vi.doUnmock('./webdav');
	vi.resetModules();
});

/** 404 everywhere: the destination answers, it just holds no backup yet - the
 *  shortest path through connect() that still reaches a target. */
function stubEmptyServer(): void {
	globalThis.fetch = vi.fn(async () => new Response(null, { status: 404 })) as typeof fetch;
}

describe('the on-demand server destinations', () => {
	it('connects S3 exactly as the module does', async () => {
		stubEmptyServer();
		const target = await s3Connect({ kv: memoryCache().kv, config: s3Config });
		expect(target?.kind).toBe('s3');
	});

	it('connects WebDAV exactly as the module does', async () => {
		stubEmptyServer();
		const target = await webdavConnect({ kv: memoryCache().kv, config: webdavConfig });
		expect(target?.kind).toBe('webdav');
	});

	it('answers null when no session was ever stored', async () => {
		const kv = memoryCache().kv;
		expect(await s3FromSession({ kv })).toBeNull();
		expect(await webdavFromSession({ kv })).toBeNull();
	});

	it('restores a stored session, so a reload finds its destination again', async () => {
		stubEmptyServer();
		const kv = memoryCache().kv;
		await s3Connect({ kv, config: s3Config });
		expect((await s3FromSession({ kv }))?.kind).toBe('s3');
	});

	it('a chunk that never arrives is the destination not answering, with a code', async () => {
		vi.resetModules();
		vi.doMock('./s3', () => {
			throw new Error('Failed to fetch dynamically imported module');
		});
		const { s3Connect: lazy } = await import('./servers');
		const failure = await lazy({ kv: memoryCache().kv, config: s3Config }).catch((e: unknown) => e);
		expect(isSelfstoreError(failure) && failure.code).toBe('TARGET_UNAVAILABLE');
	});
});
