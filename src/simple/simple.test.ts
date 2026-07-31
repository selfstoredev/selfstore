/**
 * The simple store, end to end over the real engine (memory cache, fake
 * targets): the zero-config promise, the fail-fast id rule, the connect
 * semantics (merge / started / password up front), portable backups through
 * the facade, and the data staying alive across a reopen.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { selfstore, type SimpleStore } from './simple';
import { memoryCache } from '../persistence/cache';
import type { BackupTarget } from '../persistence/target';
import { backup, restore } from '../selfstore';

interface Todo {
	id: string;
	text: string;
	done?: boolean;
	[k: string]: unknown;
}
type Schema = { todos: Todo; notes: { id: string; body: string; [k: string]: unknown } };

const open: SimpleStore<Schema>[] = [];
afterEach(() => {
	for (const s of open.splice(0)) s.dispose();
});

async function makeStore(cache = memoryCache()) {
	const store = await selfstore<Schema>('simple-test', { cache });
	open.push(store);
	return { store, cache };
}

function fakeTarget(initial: Blob | null = null): { target: BackupTarget; blob(): Blob | null } {
	let remote = initial;
	let tag = 0;
	return {
		target: {
			kind: 'fake',
			label: 'fake',
			async save(b) {
				remote = b;
				return String(++tag);
			},
			async load() {
				return remote;
			},
			async stat() {
				return remote ? String(tag) : null;
			},
			async isReady() {
				return true;
			},
			async reconnect() {
				return true;
			},
			async disconnect() {}
		},
		blob: () => remote
	};
}

describe('selfstore() - the simple store', () => {
	it('zero config: put / get / all / remove / clear round-trip with auto-save', async () => {
		const { store } = await makeStore();
		expect(store.all('todos')).toEqual([]);

		await store.put('todos', { id: 't1', text: 'hello' });
		await store.put('todos', { id: 't2', text: 'world' });
		expect(store.all('todos')).toHaveLength(2);
		expect(store.get('todos', 't1')?.text).toBe('hello');

		await store.put('todos', { id: 't1', text: 'hello again' }); // upsert
		expect(store.all('todos')).toHaveLength(2);
		expect(store.get('todos', 't1')?.text).toBe('hello again');

		await store.remove('todos', 't2');
		expect(store.all('todos')).toHaveLength(1);

		await store.clear('todos');
		expect(store.all('todos')).toEqual([]);
	});

	it('data survives a reopen over the same cache', async () => {
		const cache = memoryCache();
		const a = await selfstore<Schema>('simple-test', { cache });
		await a.put('todos', { id: 't1', text: 'persisted' });
		await a.flush();
		a.dispose();

		const b = await selfstore<Schema>('simple-test', { cache });
		open.push(b);
		expect(b.get('todos', 't1')?.text).toBe('persisted');
	});

	it('put fails FAST on a missing or non-string id, naming the fix', async () => {
		const { store } = await makeStore();
		await expect(async () =>
			store.put('todos', { text: 'no id' } as unknown as Todo)
		).rejects.toThrow(/STRING "id"/);
		await expect(async () =>
			store.put('todos', { id: 7, text: 'numeric' } as unknown as Todo)
		).rejects.toThrow(/sync: \{ ids/);
		expect(store.all('todos')).toEqual([]); // nothing half-written
	});

	it('respects a remapped id field, and skips the check for nested paths', async () => {
		const cache = memoryCache();
		const store = await selfstore('simple-test', {
			cache,
			sync: { ids: { notes: 'uuid', docs: 'doc.id' } }
		});
		open.push(store as SimpleStore<Schema>);

		await expect(async () => store.put('notes', { id: 'x', body: 'wrong field' })).rejects.toThrow(
			/STRING "uuid"/
		);
		await store.put('notes', { uuid: 'n1', body: 'ok' });
		expect(store.get('notes', 'n1')).toBeTruthy();
		// A dotted id path is an advanced setup: the simple check steps aside.
		await store.put('docs', { doc: { id: 'd1' } });
		expect(store.all('docs')).toHaveLength(1);
	});

	it('onChange fires on local writes AND on external applies', async () => {
		const { store } = await makeStore();
		let changes = 0;
		const off = store.onChange(() => changes++);

		await store.put('todos', { id: 't1', text: 'x' });
		expect(changes).toBe(1);

		await store.importBackup(await store.exportBackup()); // external apply path
		expect(changes).toBe(2);

		off();
		await store.put('todos', { id: 't2', text: 'y' });
		expect(changes).toBe(2);
	});

	it('connectTarget: an empty destination starts from this device (started)', async () => {
		const { store } = await makeStore();
		await store.put('todos', { id: 't1', text: 'mine' });
		const t = fakeTarget();
		expect(await store.connectTarget(t.target)).toBe('started');
		await store.flush();
		expect(t.blob()).not.toBeNull(); // this device's data now lives there
	});

	it('connectTarget: a destination with a backup MERGES both sides', async () => {
		// Device A writes to the destination...
		const cacheA = memoryCache();
		const a = await selfstore<Schema>('simple-test', { cache: cacheA });
		await a.put('todos', { id: 'a1', text: 'from A' });
		const t = fakeTarget();
		await a.connectTarget(t.target);
		await a.flush();
		a.dispose();

		// ...device B connects the same destination: union, nothing lost.
		const b = await selfstore<Schema>('simple-test', { cache: memoryCache() });
		open.push(b);
		await b.put('todos', { id: 'b1', text: 'from B' });
		expect(await b.connectTarget(t.target)).toBe('merged');
		const ids = b
			.all('todos')
			.map((r) => r.id)
			.sort();
		expect(ids).toEqual(['a1', 'b1']);
	});

	it('connectTarget: an encrypted backup without its password fails BEFORE attaching', async () => {
		const cacheA = memoryCache();
		const a = await selfstore<Schema>('simple-test', { cache: cacheA });
		await a.put('todos', { id: 'a1', text: 'secret' });
		const t = fakeTarget();
		await a.connectTarget(t.target);
		await a.protect('horse-battery');
		await a.flush();
		a.dispose();

		const b = await selfstore<Schema>('simple-test', { cache: memoryCache() });
		open.push(b);
		await expect(b.connectTarget(t.target)).rejects.toMatchObject({ code: 'PASSWORD_REQUIRED' });
		expect(b.state.targetKind).toBe('device'); // untouched
		expect(await b.connectTarget(t.target, { password: 'horse-battery' })).toBe('merged');
		expect(b.get('todos', 'a1')?.text).toBe('secret');
	});

	it('protect() encrypts the portable backup; unprotect() reverses it', async () => {
		const { store } = await makeStore();
		const t = fakeTarget();
		await store.connectTarget(t.target);
		await store.put('todos', { id: 't1', text: 'x' });

		await store.protect('pw');
		expect(await restore(await store.exportBackup()).isEncrypted()).toBe(true);

		await store.unprotect();
		expect(await restore(await store.exportBackup()).isEncrypted()).toBe(false);
	});

	it('importBackup replaces the data (and reads an encrypted file with its password)', async () => {
		const { store } = await makeStore();
		await store.put('todos', { id: 'old', text: 'gone after import' });

		const other = await selfstore<Schema>('simple-other', { cache: memoryCache() });
		open.push(other);
		await other.put('todos', { id: 'new', text: 'imported' });
		const plain = await other.exportBackup();

		await store.importBackup(plain);
		expect(store.all('todos').map((r) => r.id)).toEqual(['new']);

		await expect(store.importBackup(new Blob(['junk']))).rejects.toBeTruthy();
	});

	it('binary files ride through import/export untouched', async () => {
		const { store } = await makeStore();
		const withFiles = await selfstore('simple-files', { cache: memoryCache() });
		open.push(withFiles as SimpleStore<Schema>);
		await withFiles.put('todos', { id: 't1', text: 'x' });
		// Craft a backup carrying a file via the advanced escape hatch.
		const blob = await (
			await import('../selfstore')
		).exportSnapshot(
			{
				collections: { todos: [{ id: 't1', text: 'x' }] },
				files: [
					{
						id: 'f1',
						name: 'photo.bin',
						mime: 'application/octet-stream',
						bytes: new Uint8Array([1, 2, 3])
					}
				]
			},
			{ app: 'simple-test' }
		);

		await store.importBackup(blob);
		const roundTripped = await restore(await store.exportBackup()).read();
		expect(roundTripped.files).toHaveLength(1);
		expect(roundTripped.files[0].name).toBe('photo.bin');
	});

	it('answers manual when the browser ships a file picker and refuses it', async () => {
		// The presence check cannot tell a working picker from a decorative one,
		// so connectFile asks the browser twice: once from what it exposes, once
		// from how it behaved. Without the second question this call rejects, and
		// creating a vault dies on an error the practitioner cannot act on.
		vi.resetModules();
		const picker = vi.fn().mockRejectedValue(new DOMException('', 'NotAllowedError'));
		vi.stubGlobal('window', { showSaveFilePicker: picker });
		const { selfstore: freshSelfstore } = await import('./simple');

		const store = await freshSelfstore('picker-refused', { cache: memoryCache() });
		try {
			expect(await store.connectFile()).toBe('manual');
			expect(picker).toHaveBeenCalled();
			expect(store.state.targetKind).toBe('file-manual');
		} finally {
			store.dispose();
			vi.unstubAllGlobals();
		}
	});

	it('re-examines a degraded file mode instead of inheriting it forever', async () => {
		// 'file-manual' says something about the BROWSER, yet it was persisted like
		// a property of the data and re-read on every boot without ever asking
		// again. One session that could not open a picker then pinned
		// download-only mode on a Chromium perfectly able to hold a file, and
		// nothing the user could click brought automatic saving back.
		const cache = memoryCache();

		vi.resetModules();
		vi.stubGlobal('window', {
			showSaveFilePicker: vi.fn().mockRejectedValue(new DOMException('', 'NotAllowedError'))
		});
		const degraded = await (await import('./simple')).selfstore('re-examined', { cache });
		expect(await degraded.connectFile()).toBe('manual');
		expect(degraded.state.targetKind).toBe('file-manual');
		degraded.dispose();
		vi.unstubAllGlobals();

		// Next session, same data, a browser that answers: the verdict is stale.
		vi.resetModules();
		vi.stubGlobal('window', { showSaveFilePicker: vi.fn() });
		const capable = await (await import('./simple')).selfstore('re-examined', { cache });
		try {
			expect(capable.state.targetKind).toBe('device');
		} finally {
			capable.dispose();
			vi.unstubAllGlobals();
		}
	});

	it('keeps the degraded file mode where the picker is genuinely absent', async () => {
		// The correction must not overshoot. Where the API does not exist,
		// download-on-demand IS the mode, and clearing it would take away the one
		// state that tells the host to ask the user to save for themselves.
		const cache = memoryCache();

		vi.resetModules();
		vi.stubGlobal('window', {
			showSaveFilePicker: vi.fn().mockRejectedValue(new DOMException('', 'NotAllowedError'))
		});
		const first = await (await import('./simple')).selfstore('still-degraded', { cache });
		expect(await first.connectFile()).toBe('manual');
		first.dispose();
		vi.unstubAllGlobals();

		vi.resetModules();
		vi.stubGlobal('window', {}); // no File System Access API at all
		const second = await (await import('./simple')).selfstore('still-degraded', { cache });
		try {
			expect(second.state.targetKind).toBe('file-manual');
		} finally {
			second.dispose();
			vi.unstubAllGlobals();
		}
	});

	it('exposes the headless status and the typed error', async () => {
		const { store } = await makeStore();
		expect(store.status.labelKey).toMatch(/^status\./);
		expect(store.error).toBeNull();
		expect(store.advanced.state).toBe(store.state); // same instance, no copy
	});
});

describe('foreign backups', () => {
	it("refuses another app's backup before asking for its password", async () => {
		// Order is the point: the backup is encrypted and no password was given,
		// so without the guard this threw PASSWORD_REQUIRED and the app asked the
		// user for a password to a file that was never this app's to open.
		const { store } = await makeStore();
		const foreign = await backup({ collections: { notes: [{ id: 'n1' }] }, files: [] })
			.as('other-app')
			.encryptedWith('their-password')
			.toBlob();
		const t = fakeTarget(foreign);

		await expect(store.connectTarget(t.target)).rejects.toMatchObject({
			code: 'FOREIGN_BACKUP'
		});
		expect(store.state.targetKind).toBe('device');
	});
});

describe('drive: { clientId } - the whole wiring, in one option', () => {
	it('accepts a client id where it used to demand a built connection', async () => {
		// The point of the option: an app names its Google client and writes
		// nothing else - no session to build, memoise, or hand to four places.
		const store = await selfstore('drive-sugar', {
			cache: memoryCache(),
			drive: { clientId: 'cid.apps.googleusercontent.com' }
		});
		open.push(store as unknown as SimpleStore<Schema>);

		expect(store.state.targetKind).toBe('device'); // nothing connected yet
		expect(store.account).toBeNull();
		expect(store.resumeOffer()).toBeNull(); // nothing to resume either
	});

	it('a host that mints its own tokens still passes its DriveAuth', async () => {
		// Told apart by shape, so a broker-backed app is unaffected.
		const auth = { token: async () => 'tok', reconnect: async () => true, forget: async () => {} };
		const store = await selfstore('drive-broker', { cache: memoryCache(), drive: auth });
		open.push(store as unknown as SimpleStore<Schema>);

		expect(store.state.targetKind).toBe('device');
	});

	it('offers to reopen the backup it remembers, named by its account', async () => {
		vi.stubGlobal('localStorage', memLocalStorage());
		localStorage.setItem('selfstore.drive.account.drive-resume', 'someone@example.com');
		const auth = { token: async () => 'tok', reconnect: async () => true, forget: async () => {} };

		const store = await selfstore('drive-resume', { cache: memoryCache(), drive: auth });
		open.push(store as unknown as SimpleStore<Schema>);

		// What a returning visitor is offered ahead of the plain destinations -
		// the app no longer derives it, and cannot get it wrong.
		expect(store.account).toBe('someone@example.com');
		expect(store.resumeOffer()).toMatchObject({ kind: 'drive', detail: 'someone@example.com' });
		vi.unstubAllGlobals();
	});

	it('offers nothing to resume without a Drive connection to resume with', async () => {
		vi.stubGlobal('localStorage', memLocalStorage());
		localStorage.setItem('selfstore.drive.account.no-auth', 'someone@example.com');

		const store = await selfstore('no-auth', { cache: memoryCache() });
		open.push(store as unknown as SimpleStore<Schema>);

		expect(store.resumeOffer()).toBeNull();
		vi.unstubAllGlobals();
	});

	it('reading the account costs nothing and survives a browser without storage', async () => {
		const store = await selfstore('no-storage', { cache: memoryCache() });
		open.push(store as unknown as SimpleStore<Schema>);

		expect(globalThis.localStorage).toBeUndefined();
		expect(store.account).toBeNull();
	});
});

/** A localStorage the tests run without: node has none. */
function memLocalStorage() {
	const m = new Map<string, string>();
	return {
		getItem: (k: string) => m.get(k) ?? null,
		setItem: (k: string, v: string) => void m.set(k, v),
		removeItem: (k: string) => void m.delete(k)
	};
}

/** A Drive that answers: an empty backup file, and an account (or a mute one). */
function driveReply(url: string, email: string | null): Response {
	if (url.includes('/about')) {
		return email
			? new Response(JSON.stringify({ user: { emailAddress: email } }), { status: 200 })
			: new Response(null, { status: 503 });
	}
	// The file exists but is empty: an empty destination reads as "started".
	if (url.includes('alt=media')) return new Response(null, { status: 404 });
	return new Response(JSON.stringify({ id: 'file-1', files: [{ id: 'file-1' }] }), { status: 200 });
}

describe('connecting Drive learns WHICH account holds the backup', () => {
	it('remembers the address on connect, and offers to reopen with it', async () => {
		vi.stubGlobal('localStorage', memLocalStorage());
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string) => driveReply(String(url), 'owner@example.com'))
		);
		const auth = { token: async () => 'tok', reconnect: async () => true, forget: async () => {} };
		const store = await selfstore('learns-account', { cache: memoryCache(), drive: auth });
		open.push(store as unknown as SimpleStore<Schema>);

		await store.connectDrive(auth);
		// Not awaited by connectDrive on purpose - a slow metadata call must not
		// delay the connect - so let it land.
		await new Promise((r) => setTimeout(r, 0));

		expect(store.account).toBe('owner@example.com');
		expect(store.resumeOffer()?.detail).toBe('owner@example.com');
		vi.unstubAllGlobals();
	});

	it('a destination that will not say costs the hint, never the connection', async () => {
		vi.stubGlobal('localStorage', memLocalStorage());
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string) => driveReply(String(url), null))
		);
		const auth = { token: async () => 'tok', reconnect: async () => true, forget: async () => {} };
		const store = await selfstore('silent-account', { cache: memoryCache(), drive: auth });
		open.push(store as unknown as SimpleStore<Schema>);

		const outcome = await store.connectDrive(auth);
		await new Promise((r) => setTimeout(r, 0));

		expect(outcome).not.toBe('cancelled'); // the connect itself stands
		expect(store.account).toBeNull();
		vi.unstubAllGlobals();
	});
});

describe('store.backups() - the last thing an app assembled by hand', () => {
	it('builds the manager once, over the store own session', async () => {
		const auth = { token: async () => 'tok', reconnect: async () => true, forget: async () => {} };
		const store = await selfstore('has-backups', { cache: memoryCache(), drive: auth });
		open.push(store as unknown as SimpleStore<Schema>);

		const first = await store.backups();
		expect(first).not.toBeNull();
		// Two managers over one destination would each hold their own idea of
		// which file is active.
		expect(await store.backups()).toBe(first);
		expect(first!.fileNameFor('2026')).toContain('has-backups');
	});

	it('offers nothing to manage without a Drive to manage it on', async () => {
		const store = await selfstore('no-backups', { cache: memoryCache() });
		open.push(store as unknown as SimpleStore<Schema>);

		expect(await store.backups()).toBeNull();
	});
});

describe('a connection learns whose it is, even with no connect to learn from', () => {
	it('names the account on the first token it hands out', async () => {
		// The case that had no name on it: a backup attached in an earlier
		// session (or before the library learned accounts at all). Nothing calls
		// connectDrive here - the store restores the destination at boot and the
		// engine asks for a token to converge, which is the moment the address
		// can be learned for free. Asking at start-up instead would need a token
		// with no user gesture behind it, and that opens a popup the browser
		// blocks.
		vi.stubGlobal('localStorage', memLocalStorage());
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string) => driveReply(String(url), 'owner@example.com'))
		);
		const cache = memoryCache();
		await cache.kv.set('targetKind', 'drive');
		await cache.kv.set('driveFileId', 'file-1');
		const auth = { token: async () => 'tok', reconnect: async () => true, forget: async () => {} };

		const store = await selfstore('restored-drive', { cache, drive: auth });
		open.push(store as unknown as SimpleStore<Schema>);
		await new Promise((r) => setTimeout(r, 0));

		expect(store.state.targetKind).toBe('drive');
		expect(store.account).toBe('owner@example.com');
		// And with it, the offer to reopen that backup becomes recognisable.
		expect(store.resumeOffer()?.detail).toBe('owner@example.com');
		vi.unstubAllGlobals();
	});

	it('asks once, then never again', async () => {
		vi.stubGlobal('localStorage', memLocalStorage());
		const fetched = vi.fn(async (url: string) => driveReply(String(url), 'owner@example.com'));
		vi.stubGlobal('fetch', fetched);
		const cache = memoryCache();
		await cache.kv.set('targetKind', 'drive');
		await cache.kv.set('driveFileId', 'file-1');
		const auth = { token: async () => 'tok', reconnect: async () => true, forget: async () => {} };

		const store = await selfstore('asks-once', { cache, drive: auth });
		open.push(store as unknown as SimpleStore<Schema>);
		await new Promise((r) => setTimeout(r, 0));
		const first = fetched.mock.calls.filter((c) => String(c[0]).includes('/about')).length;

		await store.put('notes', { id: 'n1', text: 'x' });
		await store.sync();
		await new Promise((r) => setTimeout(r, 0));

		const after = fetched.mock.calls.filter((c) => String(c[0]).includes('/about')).length;
		expect(first).toBe(1);
		expect(after).toBe(1);
		vi.unstubAllGlobals();
	});
});

describe('getting your data out in the clear', () => {
	it('exports a readable copy of a PROTECTED store, without touching it', async () => {
		// The question this answers: "can I actually read my own data?" The only
		// way before was unprotect(), which rewrites the destination and leaves
		// the real backup readable until you remember to undo it.
		const { store } = await makeStore();
		const t = fakeTarget();
		await store.connectTarget(t.target);
		await store.put('todos', { id: 't1', text: 'lisible' });
		await store.protect('un-mot-de-passe-long');
		await store.flush();

		const clair = await store.exportBackup({ plaintext: true });

		expect(await restore(clair).isEncrypted()).toBe(false);
		const relu = await restore(clair).read();
		expect((relu.collections.todos as { text: string }[])[0].text).toBe('lisible');

		// Nothing moved: the store is still protected and what sits on the
		// destination is still encrypted.
		expect(store.state.encrypted).toBe(true);
		expect(await restore(await store.exportBackup()).isEncrypted()).toBe(true);
		expect(await restore(t.blob()!).isEncrypted()).toBe(true);
	});

	it('still encrypts by default, so the flag is the only way to cleartext', async () => {
		const { store } = await makeStore();
		const t = fakeTarget();
		await store.connectTarget(t.target);
		await store.protect('un-mot-de-passe-long');

		expect(await restore(await store.exportBackup()).isEncrypted()).toBe(true);
	});

	it('refuses while locked: there is nothing readable to write', async () => {
		const cache = memoryCache();
		const a = await selfstore<Schema>('simple-test', { cache });
		const t = fakeTarget();
		await a.connectTarget(t.target);
		await a.put('todos', { id: 't1', text: 'secret' });
		await a.protect('un-mot-de-passe-long');
		await a.flush();
		a.dispose();

		// A fresh session over the same destination lands locked.
		const b = await selfstore<Schema>('simple-test', { cache: memoryCache() });
		open.push(b);
		await expect(b.connectTarget(t.target)).rejects.toMatchObject({
			code: 'PASSWORD_REQUIRED'
		});
	});

	it('is refused outright on a store that must never produce cleartext', async () => {
		// requireEncryption is the host saying "this store has no plaintext
		// form". An escape hatch would make that a lie, so the flag wins.
		const store = await selfstore<Schema>('simple-required', {
			cache: memoryCache(),
			requireEncryption: true
		});
		open.push(store);
		await store.put('todos', { id: 't1', text: 'x' });

		await expect(store.exportBackup({ plaintext: true })).rejects.toMatchObject({
			code: 'ENCRYPTION_REQUIRED'
		});
	});
});
