import { describe, it, expect, vi, afterEach } from 'vitest';
import { connect, fromSession, peer, type WebdavConfig } from './webdav';
import { isAuthExpired } from '../../selfstore';
import type { KV } from '../cache';

function memKV(): KV {
	const m = new Map<string, unknown>();
	return {
		async get<T = unknown>(k: string) {
			return m.get(k) as T | undefined;
		},
		async set(k, v) {
			m.set(k, v);
		},
		async del(k) {
			m.delete(k);
		}
	};
}

const CFG: WebdavConfig = {
	url: 'https://cloud.example/backup.zip',
	username: 'me',
	password: 'secret'
};

/** A scripted fake fetch keyed by HTTP method; an unmapped method throws, like a
 *  CORS/offline failure. */
function fakeFetch(byMethod: Record<string, () => Response>) {
	return vi.fn(async (_url: string, init?: RequestInit) => {
		const make = byMethod[(init?.method ?? 'GET').toUpperCase()];
		if (!make) throw new TypeError('network error');
		return make();
	});
}

afterEach(() => vi.unstubAllGlobals());

describe('webdav target', () => {
	it('connects on a good HEAD and stores the credentials encrypted, not in the clear', async () => {
		const kv = memKV();
		vi.stubGlobal(
			'fetch',
			fakeFetch({ HEAD: () => new Response(null, { status: 200, headers: { 'Last-Modified': 'T0' } }) })
		);

		const target = await connect({ kv, config: CFG });
		expect(target).not.toBeNull();
		expect(target!.kind).toBe('webdav');
		expect(target!.label).toBe('cloud.example');

		const stored = await kv.get('webdavConfig');
		expect((stored as { __enc?: number })?.__enc).toBe(1); // an encrypted envelope
		expect(JSON.stringify(stored)).not.toContain('secret'); // password never in the clear
	});

	it('returns null (persists nothing) when the server is unreachable or CORS-blocked', async () => {
		const kv = memKV();
		vi.stubGlobal('fetch', fakeFetch({})); // every fetch throws
		expect(await connect({ kv, config: CFG })).toBeNull();
		expect(await kv.get('webdavConfig')).toBeUndefined();
	});

	it('restores the target by decrypting the persisted config', async () => {
		const kv = memKV();
		vi.stubGlobal('fetch', fakeFetch({ HEAD: () => new Response(null, { status: 200 }) }));
		await connect({ kv, config: CFG });
		const restored = await fromSession({ kv });
		expect(restored).not.toBeNull();
		expect(restored!.label).toBe('cloud.example');
	});

	it('restore is null when nothing was ever connected', async () => {
		expect(await fromSession({ kv: memKV() })).toBeNull();
	});

	it('saves via PUT (reporting the version), loads via GET', async () => {
		const kv = memKV();
		let putBody: unknown = null;
		vi.stubGlobal(
			'fetch',
			vi.fn(async (_url: string, init?: RequestInit) => {
				const m = (init?.method ?? 'GET').toUpperCase();
				if (m === 'HEAD') return new Response(null, { status: 200 });
				if (m === 'PUT') {
					putBody = init!.body;
					return new Response(null, { status: 201, headers: { ETag: 'v1' } });
				}
				if (m === 'GET') return new Response('SLFS-bytes', { status: 200 });
				throw new TypeError('unexpected');
			})
		);
		const target = (await connect({ kv, config: CFG }))!;
		const blob = new Blob(['SLFS-bytes']);
		expect(await target.save(blob)).toBe('v1');
		expect(putBody).toBe(blob);
		expect(await (await target.load())!.text()).toBe('SLFS-bytes');
	});

	it('treats a 404 as "no backup yet": still connectable, load resolves null', async () => {
		const kv = memKV();
		vi.stubGlobal(
			'fetch',
			fakeFetch({
				HEAD: () => new Response(null, { status: 404 }),
				GET: () => new Response(null, { status: 404 })
			})
		);
		const target = await connect({ kv, config: CFG });
		expect(target).not.toBeNull();
		expect(await target!.load()).toBeNull();
	});

	it('stat reports the version marker (ETag preferred over Last-Modified)', async () => {
		const kv = memKV();
		vi.stubGlobal(
			'fetch',
			fakeFetch({ HEAD: () => new Response(null, { status: 200, headers: { ETag: 'abc' } }) })
		);
		const target = (await connect({ kv, config: CFG }))!;
		expect(await target.stat!()).toBe('abc');
	});

	it('attaches an AbortSignal to its requests, so a hung server times out', async () => {
		const kv = memKV();
		let sawSignal = false;
		vi.stubGlobal(
			'fetch',
			vi.fn(async (_url: string, init?: RequestInit) => {
				if (init?.signal instanceof AbortSignal) sawSignal = true;
				const m = (init?.method ?? 'GET').toUpperCase();
				if (m === 'PUT') return new Response(null, { status: 201, headers: { ETag: 'v1' } });
				return new Response('x', { status: 200 });
			})
		);
		const target = (await connect({ kv, config: CFG }))!;
		sawSignal = false;
		await target.save(new Blob(['data']));
		expect(sawSignal).toBe(true);
	});

	it('disconnect clears the stored config and key', async () => {
		const kv = memKV();
		vi.stubGlobal('fetch', fakeFetch({ HEAD: () => new Response(null, { status: 200 }) }));
		const target = (await connect({ kv, config: CFG }))!;
		await target.disconnect();
		expect(await kv.get('webdavConfig')).toBeUndefined();
		expect(await kv.get('webdavKey')).toBeUndefined();
	});

	it('isReady throws AuthExpired when the stored credentials are rejected (401/403), so the store gates', async () => {
		for (const status of [401, 403]) {
			const kv = memKV();
			// Connect on a good HEAD, then the server starts rejecting the creds.
			let ok = true;
			vi.stubGlobal(
				'fetch',
				vi.fn(async () => (ok ? new Response(null, { status: 200 }) : new Response(null, { status })))
			);
			const target = (await connect({ kv, config: CFG }))!;
			ok = false;
			await target.isReady().then(
				() => expect.fail(`expected ${status} to throw`),
				(e) => expect(isAuthExpired(e)).toBe(true)
			);
		}
	});

	it('connect returns null (persists nothing) when credentials are rejected up front', async () => {
		for (const status of [401, 403]) {
			const kv = memKV();
			vi.stubGlobal('fetch', fakeFetch({ HEAD: () => new Response(null, { status }) }));
			expect(await connect({ kv, config: CFG })).toBeNull();
			expect(await kv.get('webdavConfig')).toBeUndefined();
		}
	});

	it('load throws AuthExpired on a 401/403 (a rejected read is a genuine loss, not empty)', async () => {
		for (const status of [401, 403]) {
			const kv = memKV();
			let head = 200;
			vi.stubGlobal(
				'fetch',
				vi.fn(async (_url: string, init?: RequestInit) => {
					if ((init?.method ?? 'GET').toUpperCase() === 'HEAD') return new Response(null, { status: head });
					return new Response(null, { status }); // GET rejected
				})
			);
			const target = (await connect({ kv, config: CFG }))!;
			head = status; // creds now rejected everywhere
			await target.load().then(
				() => expect.fail(`expected ${status} to throw`),
				(e) => expect(isAuthExpired(e)).toBe(true)
			);
		}
	});

	it('refuses a plain-http URL up front (Basic-auth credentials would be cleartext)', async () => {
		const kv = memKV();
		const spy = vi.fn();
		vi.stubGlobal('fetch', spy);
		await expect(
			connect({ kv, config: { ...CFG, url: 'http://cloud.example/backup.zip' } })
		).rejects.toThrow(/https/);
		expect(spy).not.toHaveBeenCalled(); // rejected before any request left the browser
		expect(await kv.get('webdavConfig')).toBeUndefined(); // and nothing persisted
	});

	it('allows plain http only for loopback (local dev)', async () => {
		const kv = memKV();
		vi.stubGlobal('fetch', fakeFetch({ HEAD: () => new Response(null, { status: 200 }) }));
		const target = await connect({ kv, config: { ...CFG, url: 'http://localhost:8080/backup.zip' } });
		expect(target).not.toBeNull();
	});
});

describe('webdav peer (read-only)', () => {
	const URL_RO = 'https://cloud.example/s/tok3n/download';

	it('loads a member copy via GET and reports the version via HEAD', async () => {
		vi.stubGlobal(
			'fetch',
			fakeFetch({
				GET: () => new Response('COPY-bytes', { status: 200 }),
				HEAD: () => new Response(null, { status: 200, headers: { ETag: 'e1' } })
			})
		);
		const p = peer({ url: URL_RO });
		expect(p.label).toBe('cloud.example');
		expect(await (await p.load())!.text()).toBe('COPY-bytes');
		expect(await p.stat!()).toBe('e1');
	});

	it('treats 404 as "not published yet" (null), never an error', async () => {
		vi.stubGlobal('fetch', fakeFetch({ GET: () => new Response(null, { status: 404 }) }));
		expect(await peer({ url: URL_RO }).load()).toBeNull();
	});

	it('maps 401/403 to a genuine loss of read access (AuthExpired)', async () => {
		for (const status of [401, 403]) {
			vi.stubGlobal('fetch', fakeFetch({ GET: () => new Response(null, { status }) }));
			await peer({ url: URL_RO })
				.load()
				.then(
					() => expect.fail(`expected ${status} to throw`),
					(e) => expect(isAuthExpired(e)).toBe(true)
				);
		}
	});

	it('maps any other error to transient (retried, never gates)', async () => {
		vi.stubGlobal('fetch', fakeFetch({ GET: () => new Response(null, { status: 503 }) }));
		await expect(peer({ url: URL_RO }).load()).rejects.toMatchObject({ code: 'TARGET_UNAVAILABLE' });
	});

	it('a failing HEAD reads as "cannot tell" (null), so a fold falls through to a full load', async () => {
		vi.stubGlobal('fetch', fakeFetch({})); // every request throws
		expect(await peer({ url: URL_RO }).stat!()).toBeNull();
	});

	it('a public share link sends NO Authorization header', async () => {
		let sentAuth: string | null = 'unset';
		vi.stubGlobal(
			'fetch',
			vi.fn(async (_url: string, init?: RequestInit) => {
				sentAuth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? null;
				return new Response('x', { status: 200 });
			})
		);
		await peer({ url: URL_RO }).load();
		expect(sentAuth).toBeNull();
	});

	it('a credentialed peer sends Basic auth and refuses plain http (cleartext creds)', async () => {
		let sentAuth: string | undefined;
		vi.stubGlobal(
			'fetch',
			vi.fn(async (_url: string, init?: RequestInit) => {
				sentAuth = (init?.headers as Record<string, string> | undefined)?.Authorization;
				return new Response('x', { status: 200 });
			})
		);
		await peer({ url: 'https://cloud.example/dav/copy.zip', username: 'bob', password: 'pw' }).load();
		expect(sentAuth).toBe('Basic ' + btoa('bob:pw'));

		expect(() => peer({ url: 'http://cloud.example/dav/copy.zip', username: 'bob', password: 'pw' })).toThrow(
			/https/
		);
	});
});
