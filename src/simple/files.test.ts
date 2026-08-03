/**
 * The file API on the simple store: content-addressed ids by default, the
 * immutability rule that keeps a multi-device union from dropping a body in
 * silence, and files riding through a reopen, a portable backup and a merge.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { selfstore, type SimpleStore } from './simple';
import { memoryCache } from '../persistence/cache';
import type { BackupTarget } from '../persistence/target';
import { restore } from '../selfstore';

const open: SimpleStore[] = [];
afterEach(() => {
	for (const s of open.splice(0)) s.dispose();
});

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);
const text = (b: Uint8Array): string => new TextDecoder().decode(b);

async function makeStore(cache = memoryCache()): Promise<SimpleStore> {
	const store = await selfstore('files-test', { cache });
	open.push(store);
	return store;
}

function fakeTarget(): { target: BackupTarget; blob(): Blob | null } {
	let remote: Blob | null = null;
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

describe('the simple store - files', () => {
	it('defaults the id to the content hash, and round-trips the bytes', async () => {
		const store = await makeStore();
		expect(store.allFiles()).toEqual([]);

		const id = await store.putFile({ bytes: bytes('hello'), name: 'greeting.txt' });
		expect(id).toMatch(/^[0-9a-f]{64}$/);
		expect(store.allFiles()).toHaveLength(1);
		expect(text(store.getFile(id)!.bytes)).toBe('hello');
		expect(store.getFile(id)!.name).toBe('greeting.txt');
		expect(store.getFile(id)!.mime).toBe('application/octet-stream');
		expect(store.getFile('nope')).toBeUndefined();
	});

	it('the same bytes land on the same id, once', async () => {
		const store = await makeStore();
		const a = await store.putFile({ bytes: bytes('same') });
		const b = await store.putFile({ bytes: bytes('same') });
		expect(b).toBe(a);
		expect(store.allFiles()).toHaveLength(1);
	});

	it('accepts a Blob and an ArrayBuffer as the body', async () => {
		const store = await makeStore();
		const fromBlob = await store.putFile({ bytes: new Blob([bytes('blobby') as BlobPart]) });
		const fromBuffer = await store.putFile({ bytes: bytes('buffered').buffer as ArrayBuffer });
		expect(text(store.getFile(fromBlob)!.bytes)).toBe('blobby');
		expect(text(store.getFile(fromBuffer)!.bytes)).toBe('buffered');
	});

	it('refuses different bytes under an id already taken, and names the way out', async () => {
		const store = await makeStore();
		await store.putFile({ id: 'avatar', bytes: bytes('v1') });

		// Re-putting the identical body is the normal case, not a conflict.
		await expect(store.putFile({ id: 'avatar', bytes: bytes('v1') })).resolves.toBe('avatar');

		await expect(store.putFile({ id: 'avatar', bytes: bytes('v2') })).rejects.toThrow(
			/immutable per id/
		);
		await expect(store.putFile({ id: 'avatar', bytes: bytes('v2') })).rejects.toThrow(
			/\{ replace: true \}/
		);
		expect(text(store.getFile('avatar')!.bytes)).toBe('v1'); // nothing half-written
	});

	it('replaces on demand, and rejects an empty id', async () => {
		const store = await makeStore();
		await store.putFile({ id: 'avatar', bytes: bytes('v1') });
		await store.putFile({ id: 'avatar', bytes: bytes('v2') }, { replace: true });
		expect(text(store.getFile('avatar')!.bytes)).toBe('v2');
		expect(store.allFiles()).toHaveLength(1);

		await expect(store.putFile({ id: '', bytes: bytes('x') })).rejects.toThrow(/STRING id/);
	});

	it('removeFile deletes, and is a no-op on an unknown id', async () => {
		const store = await makeStore();
		const id = await store.putFile({ bytes: bytes('doomed') });
		await store.removeFile('never-existed');
		expect(store.allFiles()).toHaveLength(1);
		await store.removeFile(id);
		expect(store.allFiles()).toEqual([]);
	});

	it('files survive a reopen over the same cache', async () => {
		const cache = memoryCache();
		const a = await selfstore('files-test', { cache });
		const id = await a.putFile({ bytes: bytes('durable'), name: 'keep.bin' });
		await a.flush();
		a.dispose();

		const b = await selfstore('files-test', { cache });
		open.push(b);
		expect(text(b.getFile(id)!.bytes)).toBe('durable');
		expect(b.getFile(id)!.name).toBe('keep.bin');
	});

	it('files ride in the portable backup', async () => {
		const store = await makeStore();
		const id = await store.putFile({ bytes: bytes('in the zip'), mime: 'text/plain' });
		const snap = await restore(await store.exportBackup()).read();
		expect(snap.files.map((f) => f.id)).toEqual([id]);
		expect(text(snap.files[0].bytes)).toBe('in the zip');
	});

	it('two devices, two content ids: the merge keeps BOTH bodies', async () => {
		// This is the guarantee a CRDT document rides on: store updates under
		// content ids, and no device's update is dropped when the copies meet.
		const a = await selfstore('files-test', { cache: memoryCache() });
		const idA = await a.putFile({ bytes: bytes('update-from-A') });
		const t = fakeTarget();
		await a.connectTarget(t.target);
		await a.flush();
		a.dispose();

		const b = await selfstore('files-test', { cache: memoryCache() });
		open.push(b);
		const idB = await b.putFile({ bytes: bytes('update-from-B') });
		expect(await b.connectTarget(t.target)).toBe('merged');

		const bodies = b
			.allFiles()
			.map((f) => text(f.bytes))
			.sort();
		expect(
			b
				.allFiles()
				.map((f) => f.id)
				.sort()
		).toEqual([idA, idB].sort());
		expect(bodies).toEqual(['update-from-A', 'update-from-B']);
	});
});
