import { describe, it, expect } from 'vitest';
import {
	zip,
	unzip,
	pack,
	unpackWithSidecar,
	buildEntries,
	readSidecar,
	entriesToSnapshot,
	UNREADABLE_SIDECAR,
	MAX_ENTRY_BYTES,
	MAX_TOTAL_BYTES
} from './archive';
import { SelfstoreError } from './errors';
import type { Snapshot } from './types';

const utf8 = new TextDecoder();

const snapshot: Snapshot = {
	collections: { notes: [{ id: '1', body: 'hello' }], tags: [] },
	files: [
		{ id: 'a', name: 'photo.jpg', mime: 'image/jpeg', bytes: new Uint8Array([1, 2, 3, 4]) },
		{ id: 'b', name: 'doc.pdf', mime: 'application/pdf', bytes: new Uint8Array([9, 8, 7]) }
	]
};

describe('archive', () => {
	it('round-trips a snapshot and its sidecar through pack/unpack', async () => {
		const sidecar = { schema: 3, merged: ['x'] };
		const { snapshot: out, sidecar: back } = await unpackWithSidecar(await pack(snapshot, sidecar));
		expect(out).toEqual(snapshot);
		expect(back).toEqual(sidecar);
	});

	it('reports no sidecar when none was packed', async () => {
		const { snapshot: out, sidecar } = await unpackWithSidecar(await pack(snapshot));
		expect(out).toEqual(snapshot);
		expect(sidecar).toBeNull();
	});

	it('keeps the manifest to metadata only, with file bytes in their own entries', () => {
		const entries = buildEntries(snapshot);
		const manifest = JSON.parse(utf8.decode(entries['selfstore.json'])) as {
			version: number;
			files: { id: string; name: string; mime: string; bytes?: unknown }[];
		};
		expect(manifest.version).toBe(1);
		expect(manifest.files).toEqual([
			{ id: 'a', name: 'photo.jpg', mime: 'image/jpeg' },
			{ id: 'b', name: 'doc.pdf', mime: 'application/pdf' }
		]);
		expect(entries['files/a']).toEqual(new Uint8Array([1, 2, 3, 4]));
		expect(manifest.files[0].bytes).toBeUndefined();
	});

	it('omits the sidecar entry for undefined or null', () => {
		expect('sync.json' in buildEntries(snapshot)).toBe(false);
		expect('sync.json' in buildEntries(snapshot, null)).toBe(false);
		expect('sync.json' in buildEntries(snapshot, { any: 1 })).toBe(true);
	});

	it('reads an absent sidecar as null and an unreadable one as UNREADABLE_SIDECAR', () => {
		expect(readSidecar({})).toBeNull();
		expect(readSidecar({ 'sync.json': new TextEncoder().encode('{not json') })).toBe(
			UNREADABLE_SIDECAR
		);
	});

	it('refuses a file the manifest lists without its bytes', () => {
		const entries = buildEntries(snapshot);
		delete entries['files/b'];
		expect(() => entriesToSnapshot(entries)).toThrow(
			expect.objectContaining({ code: 'BAD_FORMAT' })
		);
	});

	it('keeps an empty file, which is not a missing one', () => {
		const empty = {
			...snapshot,
			files: [{ id: 'z', name: 'z', mime: 'text/plain', bytes: new Uint8Array() }]
		};
		expect(entriesToSnapshot(buildEntries(empty)).files[0]?.bytes).toEqual(new Uint8Array());
	});

	it('refuses an unreadable manifest as BAD_FORMAT, not a bare SyntaxError', () => {
		expect(() =>
			entriesToSnapshot({ 'selfstore.json': new TextEncoder().encode('{broken') })
		).toThrow(expect.objectContaining({ code: 'BAD_FORMAT' }));
	});

	it('refuses valid JSON that is not a manifest as BAD_FORMAT', () => {
		const read = (manifest: unknown) =>
			entriesToSnapshot({ 'selfstore.json': new TextEncoder().encode(JSON.stringify(manifest)) });
		for (const bad of [
			{ version: 1, collections: { notes: 'texte' } },
			{ version: 1, collections: { notes: [1] } },
			{ version: 1, collections: [] },
			{ version: 1, files: [{}] },
			[]
		]) {
			expect(() => read(bad)).toThrow(expect.objectContaining({ code: 'BAD_FORMAT' }));
		}
	});

	it('rebuilds a minimal manifest', () => {
		const empty = entriesToSnapshot({
			'selfstore.json': new TextEncoder().encode(JSON.stringify({ version: 1 }))
		});
		expect(empty).toEqual({ collections: {}, files: [] });
	});

	it('rejects a snapshot with no manifest', () => {
		expect(() => entriesToSnapshot({})).toThrow(SelfstoreError);
		try {
			entriesToSnapshot({});
			expect.unreachable('should have thrown');
		} catch (e) {
			expect((e as SelfstoreError).code).toBe('BAD_FORMAT');
		}
	});

	it('rejects unreadable archive bytes as BAD_FORMAT', async () => {
		await expect(unzip(new Uint8Array([1, 2, 3, 4]))).rejects.toMatchObject({
			code: 'BAD_FORMAT'
		});
	});

	it('enforces the per-entry size guard', async () => {
		const bytes = await zip({ 'files/big': new Uint8Array(100) });
		await expect(unzip(bytes, 50, 10_000)).rejects.toMatchObject({ code: 'TOO_LARGE' });
	});

	it('enforces the total size guard across legal entries', async () => {
		const bytes = await zip({ a: new Uint8Array(60), b: new Uint8Array(60) });
		// Each entry clears the per-entry limit; together they trip the total.
		await expect(unzip(bytes, 100, 100)).rejects.toMatchObject({ code: 'TOO_LARGE' });
	});

	it('exposes generous default bomb guards', () => {
		expect(MAX_ENTRY_BYTES).toBeLessThan(MAX_TOTAL_BYTES);
		expect(MAX_ENTRY_BYTES).toBeGreaterThan(0);
	});
});
