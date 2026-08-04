// The Drive side of sharing: companion files, the link grant, and a target over
// one whose lifecycle is its own. Fetch is stubbed - what is pinned here is the
// request SHAPE Drive is sent and the error protocol the store reads back, the
// two things a hand-rolled version in an app kept getting wrong.

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
	createCompanion,
	owner,
	secondary,
	share,
	unshare,
	FILE_ID_KEY,
	type DriveAuth
} from './drive';
import { isAuthExpired, isSelfstoreError } from '../../selfstore';
import type { KV } from '../cache';

interface Call {
	url: string;
	method: string;
	body: string | null;
}

function memKV(seed: Record<string, unknown> = {}): { kv: KV; seen: Map<string, unknown> } {
	const m = new Map<string, unknown>(Object.entries(seed));
	return {
		seen: m,
		kv: {
			async get<T = unknown>(k: string) {
				return m.get(k) as T | undefined;
			},
			async set(k, v) {
				m.set(k, v);
			},
			async del(k) {
				m.delete(k);
			}
		}
	};
}

function auth(): DriveAuth & { forgotten: number } {
	const a = {
		forgotten: 0,
		async token() {
			return 'tok';
		},
		async reconnect() {
			return true;
		},
		async forget() {
			a.forgotten++;
		}
	};
	return a;
}

/** Record every request and answer from a script keyed on url+method. */
function stubFetch(script: (call: Call) => { status: number; body?: string }): Call[] {
	const calls: Call[] = [];
	vi.stubGlobal(
		'fetch',
		vi.fn(async (url: string | URL, init?: RequestInit) => {
			const call: Call = {
				url: String(url),
				method: init?.method ?? 'GET',
				body: typeof init?.body === 'string' ? init.body : null
			};
			calls.push(call);
			const r = script(call);
			return new Response(r.body ?? null, { status: r.status });
		})
	);
	return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe('companion files', () => {
	it('creates an empty named file and answers its id', async () => {
		const calls = stubFetch(() => ({ status: 200, body: JSON.stringify({ id: 'copy-1' }) }));
		const { fileId } = await createCompanion({ auth: auth(), fileName: 'shared copy.zip' });

		expect(fileId).toBe('copy-1');
		expect(calls[0].method).toBe('POST');
		expect(calls[0].url).toContain('uploadType=multipart');
		// Unlike createBackup it does NOT search for a duplicate name first: two
		// members of two groups may legitimately hold identically named copies.
		expect(calls).toHaveLength(1);
	});
});

describe('the link grant', () => {
	it('share() grants anyone-with-the-link READER, nothing wider', async () => {
		const calls = stubFetch(() => ({ status: 200, body: '{}' }));
		await share({ auth: auth(), fileId: 'copy-1' });

		expect(calls[0].method).toBe('POST');
		expect(calls[0].url).toContain('/copy-1/permissions');
		expect(JSON.parse(calls[0].body!)).toEqual({ role: 'reader', type: 'anyone' });
	});

	it('unshare() deletes every link grant and leaves named ones alone', async () => {
		const permissions = {
			permissions: [
				{ id: 'p-anyone', type: 'anyone' },
				{ id: 'p-user', type: 'user' },
				{ id: 'p-anyone-2', type: 'anyone' }
			]
		};
		const calls = stubFetch((c) =>
			c.method === 'GET'
				? { status: 200, body: JSON.stringify(permissions) }
				: { status: 204, body: undefined }
		);
		await unshare({ auth: auth(), fileId: 'copy-1' });

		const deleted = calls.filter((c) => c.method === 'DELETE').map((c) => c.url.split('/').pop());
		expect(deleted).toEqual(['p-anyone', 'p-anyone-2']); // the named grant survives
	});

	it('unshare() treats an already-deleted file as private enough', async () => {
		stubFetch(() => ({ status: 404 }));
		await expect(unshare({ auth: auth(), fileId: 'gone' })).resolves.toBeUndefined();
	});

	it('a refused share carries a code, so the app can word it and the store can retry', async () => {
		stubFetch(() => ({ status: 403, body: 'forbidden' }));
		const err = await share({ auth: auth(), fileId: 'copy-1' }).catch((e: unknown) => e);

		expect(isSelfstoreError(err) && err.code).toBe('TARGET_WRITE_FAILED');
	});

	it('a lost session raises AuthExpired rather than a bare failure', async () => {
		stubFetch(() => ({ status: 401 }));
		const err = await share({ auth: auth(), fileId: 'copy-1' }).catch((e: unknown) => e);

		expect(isAuthExpired(err)).toBe(true);
	});
});

describe('owner()', () => {
	it('names the account a copy lives on', async () => {
		stubFetch(() => ({
			status: 200,
			body: JSON.stringify({ owners: [{ emailAddress: 'her@example.test', displayName: 'Her' }] })
		}));
		expect(await owner({ auth: auth(), fileId: 'copy-1' })).toEqual({
			email: 'her@example.test',
			name: 'Her'
		});
	});

	it('answers nulls rather than throwing when Drive will not say', async () => {
		stubFetch(() => ({ status: 404 }));
		// A missing label must never break the sync round that asked for it.
		expect(await owner({ auth: auth(), fileId: 'copy-1' })).toEqual({ email: null, name: null });
	});

	it('still reports a genuinely lost session', async () => {
		stubFetch(() => ({ status: 401 }));
		const err = await owner({ auth: auth(), fileId: 'copy-1' }).catch((e: unknown) => e);
		expect(isAuthExpired(err)).toBe(true);
	});
});

describe('secondary(): a target whose lifecycle is its own', () => {
	// No fileName: a target bound to an id never searches or creates by name.
	const options = (a: DriveAuth, kv: KV): { auth: DriveAuth; kv: KV } => ({ auth: a, kv });

	it('writes to the file it was given, not to the connected backup', async () => {
		const { kv } = memKV({ [FILE_ID_KEY]: 'my-backup' });
		const calls = stubFetch(() => ({ status: 200, body: JSON.stringify({ version: '7' }) }));

		const marker = await secondary(options(auth(), kv), 'copy-1').save(new Blob(['x']));

		expect(marker).toBe('7');
		expect(calls[0].url).toContain('/copy-1?');
		expect(calls[0].url).not.toContain('my-backup');
	});

	it('carries its own kind, so a store never mistakes it for the destination', () => {
		const { kv } = memKV();
		expect(secondary(options(auth(), kv), 'copy-1').kind).toBe('drive-companion');
	});

	it('disconnecting it forgets NEITHER the Drive session NOR the backup id', async () => {
		const a = auth();
		const { kv, seen } = memKV({ [FILE_ID_KEY]: 'my-backup' });

		await secondary(options(a, kv), 'copy-1').disconnect();

		// preview()'s disconnect would do both: right when the user is leaving
		// Drive, catastrophic when they are only dropping a shared copy.
		expect(a.forgotten).toBe(0);
		expect(seen.get(FILE_ID_KEY)).toBe('my-backup');
	});
});
