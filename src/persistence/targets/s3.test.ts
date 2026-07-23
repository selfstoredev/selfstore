// The S3 target's behaviour, with fetch stubbed: the signing itself is pinned
// in sigv4.test.ts, so here we check the request shape (verb, URL, signed
// headers) and the error protocol (403 = genuine auth loss, 404 = no backup).

import { describe, it, expect, vi, afterEach } from 'vitest';
import { connect, type S3Config } from './s3';
import { memoryCache } from '../cache';
import { isAuthExpired } from '../../selfstore';

interface Call {
	url: string;
	method: string;
	headers: Record<string, string>;
	body: BodyInit | null;
}

/** Install a fetch that records each call and answers from a per-method script. */
function stubFetch(script: (call: Call) => { status: number; body?: BodyInit; etag?: string }) {
	const calls: Call[] = [];
	globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
		const call: Call = {
			url: String(url),
			method: init?.method ?? 'GET',
			headers: (init?.headers as Record<string, string>) ?? {},
			body: init?.body ?? null
		};
		calls.push(call);
		const r = script(call);
		const headers = new Headers();
		if (r.etag) headers.set('ETag', r.etag);
		return new Response(r.status === 404 || r.status === 403 ? null : r.body ?? null, {
			status: r.status,
			headers
		});
	}) as typeof fetch;
	return calls;
}

const baseConfig: S3Config = {
	endpoint: 'https://s3.eu-west-3.amazonaws.com',
	region: 'eu-west-3',
	bucket: 'my-bucket',
	key: 'backups/app.selfstore',
	accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
	secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'
};

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
	vi.restoreAllMocks();
});

describe('s3 target', () => {
	it('connects (HEAD ok), then PUTs a signed object at endpoint/bucket/key', async () => {
		const calls = stubFetch((c) => (c.method === 'PUT' ? { status: 200, etag: '"v1"' } : { status: 200 }));
		const target = await connect({ kv: memoryCache().kv, config: baseConfig });
		expect(target).not.toBeNull();
		expect(target!.kind).toBe('s3');
		expect(target!.label).toContain('my-bucket');

		const version = await target!.save(new Blob(['ciphertext']));
		const put = calls.find((c) => c.method === 'PUT')!;
		expect(put.url).toBe('https://s3.eu-west-3.amazonaws.com/my-bucket/backups/app.selfstore');
		expect(put.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\//);
		expect(put.headers['x-amz-content-sha256']).toMatch(/^[0-9a-f]{64}$/);
		expect(put.headers.host).toBeUndefined(); // the browser owns Host
		expect(version).toBe('"v1"');
	});

	it('load: 200 returns the bytes, 404 returns null, 403 is a genuine auth loss', async () => {
		const kv = memoryCache().kv;
		let mode: 'hit' | 'missing' | 'denied' = 'hit';
		stubFetch((c) => {
			if (c.method === 'HEAD') return { status: 200 };
			if (mode === 'missing') return { status: 404 };
			if (mode === 'denied') return { status: 403 };
			return { status: 200, body: 'stored-bytes' };
		});
		const target = (await connect({ kv, config: baseConfig }))!;

		expect(await (await target.load())!.text()).toBe('stored-bytes');
		mode = 'missing';
		expect(await target.load()).toBeNull();
		mode = 'denied';
		await expect(target.load()).rejects.toSatisfy(isAuthExpired);
	});

	it('isReady: HEAD 404 stays ready (no backup yet), HEAD 403 throws auth-expired', async () => {
		const kv = memoryCache().kv;
		let status = 404;
		stubFetch(() => ({ status }));
		// connect swallows a non-ok isReady as "wrong creds": 404 means the bucket
		// is reachable and the object simply does not exist yet, so it connects.
		const target = (await connect({ kv, config: baseConfig }))!;
		expect(await target.isReady()).toBe(true);
		status = 403;
		await expect(target.isReady()).rejects.toSatisfy(isAuthExpired);
	});

	it('virtual-hosted style folds the bucket into the host', async () => {
		const calls = stubFetch((c) => (c.method === 'PUT' ? { status: 200, etag: '"v1"' } : { status: 200 }));
		const target = (await connect({
			kv: memoryCache().kv,
			config: { ...baseConfig, forcePathStyle: false }
		}))!;
		await target.save(new Blob(['x']));
		const put = calls.find((c) => c.method === 'PUT')!;
		expect(put.url).toBe('https://my-bucket.s3.eu-west-3.amazonaws.com/backups/app.selfstore');
	});

	it('refuses a plain-http endpoint that is not loopback', async () => {
		await expect(
			connect({ kv: memoryCache().kv, config: { ...baseConfig, endpoint: 'http://s3.example.com' } })
		).rejects.toThrow(/https/);
	});
});
