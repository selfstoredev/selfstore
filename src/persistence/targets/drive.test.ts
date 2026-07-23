import { describe, it, expect, vi, afterEach } from 'vitest';
import {
	fromSession,
	listBackups,
	createBackup,
	deleteBackup,
	renameBackup,
	FILE_ID_KEY,
	type DriveAuth,
	type DriveOptions
} from './drive';
import { isAuthExpired, isSelfstoreError } from '../../selfstore';
import type { KV } from '../cache';

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

/** A DriveAuth whose access token can go STALE: `token()` hands out the cached
 *  token; `token({ forceRefresh })` mints a new one. `tokens` records every
 *  value handed out so a test can prove a refresh happened. */
function stalableAuth(): DriveAuth & { tokens: string[]; forceRefreshes: number } {
	let n = 0;
	const auth = {
		tokens: [] as string[],
		forceRefreshes: 0,
		async token(opts?: { forceRefresh?: boolean }) {
			if (opts?.forceRefresh) {
				auth.forceRefreshes++;
				n++;
			}
			const t = `tok-${n}`;
			auth.tokens.push(t);
			return t;
		},
		async reconnect() {
			return true;
		},
		async forget() {}
	};
	return auth;
}

const opts = (auth: DriveAuth): DriveOptions => ({
	auth,
	kv: memKV({ [FILE_ID_KEY]: 'file-1' }),
	fileName: 'backup.zip'
});

afterEach(() => vi.unstubAllGlobals());

describe('drive target - stale-token 401 handling', () => {
	it('save retries once with a forced-fresh token when Google 401s a stale token, then succeeds', async () => {
		const auth = stalableAuth();
		let calls = 0;
		vi.stubGlobal(
			'fetch',
			vi.fn(async (_url: string, init?: RequestInit) => {
				calls++;
				const bearer = (init?.headers as Record<string, string>).Authorization;
				// tok-0 is the stale cached token (rejected); the forced refresh mints
				// tok-1, which Google accepts.
				if (bearer === 'Bearer tok-0') return new Response(null, { status: 401 });
				return new Response(JSON.stringify({ version: '42' }), { status: 200 });
			})
		);

		const target = await fromSession(opts(auth));
		const marker = await target!.save(new Blob(['data']));

		expect(marker).toBe('42'); // the save went through on the retry
		expect(auth.forceRefreshes).toBe(1); // exactly one forced refresh
		expect(calls).toBe(2); // one rejected, one accepted - no gate raised
	});

	it('save raises AuthExpired only when the forced-fresh token ALSO 401s (genuine loss)', async () => {
		const auth = stalableAuth();
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response(null, { status: 401 })) // every token rejected
		);

		const target = await fromSession(opts(auth));
		const err = await target!.save(new Blob(['data'])).catch((e: unknown) => e);

		expect(isAuthExpired(err)).toBe(true); // the reconnect gate is right to open here
		expect(auth.forceRefreshes).toBe(1); // it did try a fresh token first
	});

	it('save does NOT force-refresh on a transient 5xx (that must stay a retryable blip, no gate)', async () => {
		const auth = stalableAuth();
		vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 503 })));

		const target = await fromSession(opts(auth));
		const err = await target!.save(new Blob(['data'])).catch((e: unknown) => e);

		expect(isAuthExpired(err)).toBe(false); // TARGET_WRITE_FAILED, not a lost session
		expect(auth.forceRefreshes).toBe(0); // a 5xx is not a token problem
	});

	it('load recovers a stale-token 401 with a forced refresh instead of returning empty', async () => {
		const auth = stalableAuth();
		vi.stubGlobal(
			'fetch',
			vi.fn(async (_url: string, init?: RequestInit) => {
				const bearer = (init?.headers as Record<string, string>).Authorization;
				if (bearer === 'Bearer tok-0') return new Response(null, { status: 401 });
				return new Response('backup-bytes', { status: 200 });
			})
		);

		const target = await fromSession(opts(auth));
		const blob = await target!.load();

		expect(await blob!.text()).toBe('backup-bytes'); // the data was fetched, not lost
		expect(auth.forceRefreshes).toBe(1);
	});
});

describe('drive target - file identity is captured, never re-read per call', () => {
	it('keeps writing to ITS file after the remembered id is re-pointed (backup switch)', async () => {
		const auth = stalableAuth();
		const saved: string[] = [];
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string) => {
				saved.push(String(url));
				return new Response(JSON.stringify({ version: '1' }), { status: 200 });
			})
		);
		const kv = memKV({ [FILE_ID_KEY]: 'file-OLD' });
		const target = await fromSession({ auth, kv, fileName: 'backup.zip' });
		await target!.save(new Blob(['a'])); // captures file-old

		// A backup switch re-points the remembered id while this target is still
		// attached. Its remaining writes (the outgoing courtesy flush) must go to
		// file-old - the lazy per-call read wrote the old wallet into file-new,
		// silently merging two isolated backups.
		await kv.set(FILE_ID_KEY, 'file-NEW');
		await target!.save(new Blob(['b']));
		expect(saved.filter((u) => u.includes('file-OLD')).length).toBe(2);
		expect(saved.some((u) => u.includes('file-NEW'))).toBe(false);
	});

	it('disconnect() leaves the remembered id alone once it belongs to another file', async () => {
		const auth = stalableAuth();
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response(JSON.stringify({ version: '1' }), { status: 200 }))
		);
		const kv = memKV({ [FILE_ID_KEY]: 'file-OLD' });
		const target = await fromSession({ auth, kv, fileName: 'backup.zip' });
		await target!.save(new Blob(['a'])); // captures file-old

		await kv.set(FILE_ID_KEY, 'file-NEW');
		await target!.disconnect();
		expect(await kv.get(FILE_ID_KEY)).toBe('file-NEW'); // the new target keeps its id

		// On its own file, disconnect still forgets the id as before.
		const kv2 = memKV({ [FILE_ID_KEY]: 'file-2' });
		const target2 = await fromSession({ auth, kv: kv2, fileName: 'backup.zip' });
		await target2!.save(new Blob(['a']));
		await target2!.disconnect();
		expect(await kv2.get(FILE_ID_KEY)).toBeUndefined();
	});
});

describe('drive target - a failed read never passes for an empty file', () => {
	it('404 means the file is genuinely gone: null', async () => {
		const auth = stalableAuth();
		vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 404 })));

		const target = await fromSession(opts(auth));

		expect(await target!.load()).toBeNull();
	});

	it('a 5xx is a typed transient failure, not "no backup"', async () => {
		const auth = stalableAuth();
		vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 503 })));

		const target = await fromSession(opts(auth));

		await expect(target!.load()).rejects.toMatchObject({ code: 'TARGET_UNAVAILABLE' });
	});

	it('a 401 that survives the forced refresh is a genuine loss of access', async () => {
		const auth = stalableAuth();
		vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 401 })));

		const target = await fromSession(opts(auth));

		await expect(target!.load()).rejects.toMatchObject({ code: 'AUTH_EXPIRED' });
		expect(auth.forceRefreshes).toBe(1); // the stale-token refresh was tried first
	});
});

describe('drive target - the backup name is escaped for the query grammar', () => {
	it("escapes a single-quote in the name so it cannot break out of the name='...' clause", async () => {
		const auth = stalableAuth();
		let sentQuery = '';
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string) => {
				const u = new URL(url);
				const q = u.searchParams.get('q');
				if (q) sentQuery = q;
				return new Response(JSON.stringify({ files: [{ id: 'file-1' }] }), { status: 200 });
			})
		);
		// findOrCreateOwnFile runs findExistingFile with the given name.
		const { findOrCreateOwnFile } = await import('./drive');
		await findOrCreateOwnFile({ auth, kv: memKV(), fileName: "eve' or trashed=true or name='x" });
		// The injected quote is backslash-escaped, so the clause stays one literal.
		expect(sentQuery).toContain("name='eve\\' or trashed=true or name=\\'x'");
		expect(sentQuery).not.toContain("name='eve' or trashed=true"); // never broken out
	});
});

describe('drive target - a hung request has a deadline (never spins forever)', () => {
	it('attaches an AbortSignal to save and load, so a dead connection times out', async () => {
		const auth = stalableAuth();
		let sawSignal = false;
		vi.stubGlobal(
			'fetch',
			vi.fn(async (_url: string, init?: RequestInit) => {
				if (init?.signal instanceof AbortSignal) sawSignal = true;
				return new Response(JSON.stringify({ version: '1' }), { status: 200 });
			})
		);
		const target = await fromSession(opts(auth));
		await target!.save(new Blob(['data']));
		expect(sawSignal).toBe(true);

		sawSignal = false;
		await target!.load();
		expect(sawSignal).toBe(true);
	});
});

describe('drive target - a permanently unwritable file gates (not a silent retry loop)', () => {
	it('a 404 on save means the bound file is gone: TARGET_GONE, not a transient write failure', async () => {
		const auth = stalableAuth();
		vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 404 })));

		const target = await fromSession(opts(auth));
		const err = await target!.save(new Blob(['data'])).catch((e: unknown) => e);

		expect(isAuthExpired(err)).toBe(false); // access is fine; the FILE vanished
		expect(err).toMatchObject({ code: 'TARGET_GONE' });
	});

	it('a 403 that is NOT a rate limit (permission/quota) is permanent: TARGET_GONE', async () => {
		const auth = stalableAuth();
		vi.stubGlobal(
			'fetch',
			vi.fn(
				async () =>
					new Response(JSON.stringify({ error: { errors: [{ reason: 'storageQuotaExceeded' }] } }), {
						status: 403
					})
			)
		);

		const target = await fromSession(opts(auth));
		const err = await target!.save(new Blob(['data'])).catch((e: unknown) => e);

		expect(err).toMatchObject({ code: 'TARGET_GONE' });
	});

	it('a 403 rate limit stays a retryable blip (TARGET_WRITE_FAILED), never gates', async () => {
		const auth = stalableAuth();
		vi.stubGlobal(
			'fetch',
			vi.fn(
				async () =>
					new Response(JSON.stringify({ error: { errors: [{ reason: 'userRateLimitExceeded' }] } }), {
						status: 403
					})
			)
		);

		const target = await fromSession(opts(auth));
		const err = await target!.save(new Blob(['data'])).catch((e: unknown) => e);

		expect(isAuthExpired(err)).toBe(false);
		expect(err).toMatchObject({ code: 'TARGET_WRITE_FAILED' }); // transient, retried
	});
});

describe('drive target - backup management ops', () => {
	it('listBackups parses the file rows, newest first as Drive answers them', async () => {
		const auth = stalableAuth();
		let queried = '';
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string) => {
				queried = decodeURIComponent(url);
				return new Response(
					JSON.stringify({
						files: [
							{ id: 'f2', name: 'Wallet (family).zip', modifiedTime: '2026-07-19T10:00:00Z', size: '2048' },
							{ id: 'f1', name: 'Wallet.zip', modifiedTime: '2026-07-01T08:00:00Z' }
						]
					}),
					{ status: 200 }
				);
			})
		);

		const rows = await listBackups({ auth, nameContains: 'Wallet' });
		expect(rows).toEqual([
			{ id: 'f2', name: 'Wallet (family).zip', modifiedTime: '2026-07-19T10:00:00Z', size: 2048 },
			{ id: 'f1', name: 'Wallet.zip', modifiedTime: '2026-07-01T08:00:00Z', size: null }
		]);
		// Owned, not trashed, narrowed by name: the app never sees another
		// account's share copies in its own listing.
		expect(queried).toContain("'me' in owners");
		expect(queried).toContain('trashed=false');
		expect(queried).toContain("name contains 'Wallet'");
	});

	it('listBackups raises AuthExpired on a 401 that survives the forced refresh', async () => {
		const auth = stalableAuth();
		vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 401 })));
		const err = await listBackups({ auth }).catch((e: unknown) => e);
		expect(isAuthExpired(err)).toBe(true);
		expect(auth.forceRefreshes).toBe(1);
	});

	it('createBackup refuses a name an owned live file already carries', async () => {
		const auth = stalableAuth();
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string) =>
				url.includes('/files?q=')
					? new Response(JSON.stringify({ files: [{ id: 'taken' }] }), { status: 200 })
					: new Response(JSON.stringify({ id: 'never' }), { status: 200 })
			)
		);
		const err = await createBackup({ auth, fileName: 'Wallet.zip' }).catch((e: unknown) => e);
		expect(isSelfstoreError(err) && err.code === 'TARGET_WRITE_FAILED').toBe(true);
	});

	it('createBackup creates an empty file and answers its id when the name is free', async () => {
		const auth = stalableAuth();
		const posts: string[] = [];
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string, init?: RequestInit) => {
				if (url.includes('/files?q=')) return new Response(JSON.stringify({ files: [] }), { status: 200 });
				posts.push(`${init?.method} ${url}`);
				return new Response(JSON.stringify({ id: 'fresh-1' }), { status: 200 });
			})
		);
		const { fileId } = await createBackup({ auth, fileName: 'Wallet (family).zip' });
		expect(fileId).toBe('fresh-1');
		expect(posts[0]).toContain('POST');
		expect(posts[0]).toContain('uploadType=multipart');
	});

	it('deleteBackup deletes, and a 404 (already gone) is success, never an error', async () => {
		const auth = stalableAuth();
		const calls: string[] = [];
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string, init?: RequestInit) => {
				calls.push(`${init?.method} ${url}`);
				return new Response(null, { status: calls.length === 1 ? 204 : 404 });
			})
		);
		await deleteBackup({ auth, fileId: 'f9' }); // 204: deleted
		await deleteBackup({ auth, fileId: 'f9' }); // 404: already gone, still fine
		expect(calls.every((c) => c.startsWith('DELETE'))).toBe(true);
	});

	it('renameBackup patches the name, and refuses one another owned file carries', async () => {
		const auth = stalableAuth();
		// The new name is free: one PATCH with the JSON name body goes out.
		const sent: { method?: string; url: string; body: string }[] = [];
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string, init?: RequestInit) => {
				if (url.includes('/files?q=')) return new Response(JSON.stringify({ files: [] }), { status: 200 });
				sent.push({ method: init?.method, url, body: String(init?.body ?? '') });
				return new Response(JSON.stringify({ id: 'f1' }), { status: 200 });
			})
		);
		await renameBackup({ auth, fileId: 'f1', fileName: 'Wallet (holidays).zip' });
		expect(sent).toHaveLength(1);
		expect(sent[0].method).toBe('PATCH');
		expect(sent[0].url).toContain('/files/f1');
		expect(JSON.parse(sent[0].body).name).toBe('Wallet (holidays).zip');

		// A DIFFERENT owned file already carries the target name: refuse, no PATCH.
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string) =>
				url.includes('/files?q=')
					? new Response(JSON.stringify({ files: [{ id: 'other' }] }), { status: 200 })
					: new Response(JSON.stringify({ id: 'never' }), { status: 200 })
			)
		);
		const err = await renameBackup({ auth, fileId: 'f1', fileName: 'Taken.zip' }).catch(
			(e: unknown) => e
		);
		expect(isSelfstoreError(err) && err.code === 'TARGET_WRITE_FAILED').toBe(true);
	});
});
