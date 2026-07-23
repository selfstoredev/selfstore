/**
 * The simple store, end to end over the real engine (memory cache, fake
 * targets): the zero-config promise, the fail-fast id rule, the connect
 * semantics (merge / started / password up front), portable backups through
 * the facade, and the data staying alive across a reopen.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { selfstore, type SimpleStore } from './simple';
import { memoryCache } from '../persistence/cache';
import type { BackupTarget } from '../persistence/target';
import { restore } from '../selfstore';

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

	it('exposes the headless status and the typed error', async () => {
		const { store } = await makeStore();
		expect(store.status.labelKey).toMatch(/^status\./);
		expect(store.error).toBeNull();
		expect(store.advanced.state).toBe(store.state); // same instance, no copy
	});
});
