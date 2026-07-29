import { describe, it, expect, vi, afterEach } from 'vitest';
import { driveBackupsHost } from './drive-host';
import { FILE_ID_KEY, type DriveAuth } from '../persistence/targets/drive';
import type { KV } from '../persistence/cache';

function memKV(seed: Record<string, unknown> = {}): KV {
	const m = new Map<string, unknown>(Object.entries(seed));
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

/** An auth whose token can be made to fail, so the session fallback is testable.
 *  `reconnects` counts the consent popups the host asked for. */
function auth(opts: { live?: boolean; consents?: boolean } = {}): DriveAuth & {
	reconnects: number;
} {
	const a = {
		reconnects: 0,
		async token() {
			if (opts.live === false) throw new Error('no session');
			return 'tok';
		},
		async reconnect() {
			a.reconnects++;
			return opts.consents !== false;
		},
		async forget() {}
	};
	return a;
}

const host = (a: DriveAuth, kv: KV = memKV(), nameContains?: string) =>
	driveBackupsHost({ auth: a, kv, fileName: 'app.zip', nameContains });

afterEach(() => vi.unstubAllGlobals());

describe('driveBackupsHost - the port over the Drive destination', () => {
	it('lists what the destination reports, narrowed server-side when asked', async () => {
		const urls: string[] = [];
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string) => {
				urls.push(url);
				return new Response(
					JSON.stringify({
						files: [{ id: 'f1', name: 'app.zip', modifiedTime: '2026-01-02T03:04:05Z' }]
					}),
					{ status: 200 }
				);
			})
		);

		const rows = await host(auth(), memKV(), 'app').list();

		expect(rows).toEqual([
			{ id: 'f1', name: 'app.zip', modifiedTime: '2026-01-02T03:04:05Z', size: null }
		]);
		expect(urls[0]).toContain('name%20contains');
	});

	it('names the SAME active-id key the connect path reads', () => {
		// A key of its own would make a reload adopt a different file than the one
		// the panel just showed as active.
		expect(host(auth()).activeIdKey).toBe(FILE_ID_KEY);
		expect(host(auth()).kind).toBe('drive');
	});

	it('open() binds to the given id and never re-resolves by name', async () => {
		const saved: string[] = [];
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string) => {
				saved.push(url);
				return new Response(JSON.stringify({ version: '1' }), { status: 200 });
			})
		);
		// The kv points somewhere else on purpose: a `connect` would follow the kv
		// (or the file name) and two isolated backups would silently merge.
		const kv = memKV({ [FILE_ID_KEY]: 'other-file' });

		await host(auth(), kv)
			.open('wanted-file')
			.save(new Blob(['x']));

		expect(saved.some((u) => u.includes('wanted-file'))).toBe(true);
		expect(saved.some((u) => u.includes('other-file'))).toBe(false);
		// And it adopts nothing: the device's own wiring is untouched.
		expect(await kv.get(FILE_ID_KEY)).toBe('other-file');
	});

	it('create, rename and remove reach the destination; a duplicate name is refused', async () => {
		const calls: { url: string; method: string }[] = [];
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string, init?: RequestInit) => {
				calls.push({ url, method: init?.method ?? 'GET' });
				// The name lookup that guards duplicates: nothing carries the name.
				if (url.includes('fields=files(id)') || url.includes('fields=files%28id%29'))
					return new Response(JSON.stringify({ files: [] }), { status: 200 });
				return new Response(JSON.stringify({ id: 'new-file' }), { status: 200 });
			})
		);
		const h = host(auth());

		expect(await h.create('app (2026).zip')).toEqual({ fileId: 'new-file' });
		await h.rename!('new-file', 'app (renamed).zip');
		await h.remove('new-file');

		expect(calls.some((c) => c.method === 'DELETE')).toBe(true);
		expect(calls.some((c) => c.method === 'PATCH')).toBe(true);
	});

	it('findOrCreatePersonal answers the canonical file, existing or fresh', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string) =>
				url.includes('fields=files(id)') || url.includes('fields=files%28id%29')
					? new Response(JSON.stringify({ files: [{ id: 'mine' }] }), { status: 200 })
					: new Response(JSON.stringify({ id: 'created' }), { status: 200 })
			)
		);

		expect(await host(auth()).findOrCreatePersonal!()).toEqual({ fileId: 'mine', created: false });
	});

	it('ensureSession stays silent on a live session and only then asks for consent', async () => {
		const live = auth();
		expect(await host(live).ensureSession!()).toBe(true);
		expect(live.reconnects).toBe(0); // no popup over a working session

		const lapsed = auth({ live: false });
		expect(await host(lapsed).ensureSession!()).toBe(true);
		expect(lapsed.reconnects).toBe(1);
	});

	it('a refused consent is an answer, not a failure', async () => {
		const refused = auth({ live: false, consents: false });

		// False, never a throw: the caller aborts the gesture as cancelled.
		expect(await host(refused).ensureSession!()).toBe(false);
	});
});
