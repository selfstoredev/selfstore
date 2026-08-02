/**
 * The claim the file API is built to support, measured rather than asserted:
 * a CRDT document carried as content-addressed update files survives two
 * devices editing it offline, and both sides' edits are in the result.
 *
 * The documentation says this rests on Yjs updates being commutative and
 * idempotent, so the union-by-id merge IS the CRDT merge. That is a property
 * of Yjs, not of selfstore, and a sentence claiming it is worth exactly
 * nothing without a test that folds real updates in a real store.
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { selfstore, type SimpleStore } from './simple';
import { memoryCache } from '../persistence/cache';
import type { BackupTarget } from '../persistence/target';

const UPDATE_MIME = 'application/x-yjs-update';

const open: SimpleStore[] = [];
afterEach(() => {
	for (const s of open.splice(0)) s.dispose();
});

function fakeTarget(): BackupTarget {
	let remote: Blob | null = null;
	let tag = 0;
	return {
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
	};
}

/** Fold every update the store carries into a fresh document - the read path
 *  of examples/yjs-document.ts, in the order the store hands them over. */
function foldInto(store: SimpleStore, order: 'as-is' | 'reversed' = 'as-is'): string {
	const doc = new Y.Doc();
	const updates = store.allFiles().filter((f) => f.mime === UPDATE_MIME);
	for (const f of order === 'reversed' ? [...updates].reverse() : updates) {
		Y.applyUpdate(doc, f.bytes);
	}
	return doc.getText('body').toString();
}

describe('carrying a CRDT document in the store', () => {
	it('keeps BOTH devices edits through an offline merge, in any order', async () => {
		// Device A edits offline and publishes to the destination.
		const a = await selfstore('crdt-test', { cache: memoryCache() });
		const docA = new Y.Doc();
		docA.getText('body').insert(0, 'written-by-A ');
		await a.putFile({ bytes: Y.encodeStateAsUpdate(docA), mime: UPDATE_MIME });
		const target = fakeTarget();
		await a.connectTarget(target);
		await a.flush();
		a.dispose();

		// Device B never saw A's work and edits its own copy.
		const b = await selfstore('crdt-test', { cache: memoryCache() });
		open.push(b);
		const docB = new Y.Doc();
		docB.getText('body').insert(0, 'written-by-B ');
		await b.putFile({ bytes: Y.encodeStateAsUpdate(docB), mime: UPDATE_MIME });

		expect(await b.connectTarget(target)).toBe('merged');

		// Both updates are there, and folding them converges whatever the order.
		const folded = foldInto(b);
		expect(folded).toContain('written-by-A');
		expect(folded).toContain('written-by-B');
		expect(foldInto(b, 'reversed')).toBe(folded);
	});

	it('folding the same update twice changes nothing', async () => {
		// Why onChange can re-fold on every single change without guarding.
		const store = await selfstore('crdt-test', { cache: memoryCache() });
		open.push(store);
		const doc = new Y.Doc();
		doc.getText('body').insert(0, 'once');
		const update = Y.encodeStateAsUpdate(doc);
		await store.putFile({ bytes: update, mime: UPDATE_MIME });

		const twice = new Y.Doc();
		Y.applyUpdate(twice, update);
		Y.applyUpdate(twice, update);
		expect(twice.getText('body').toString()).toBe('once');
		expect(foldInto(store)).toBe('once');
	});

	it('a stable id is the trap: one body wins and the other is gone', async () => {
		// The failure the content-id default exists to make unreachable. Written
		// down as a test so the reason survives the next person to read putFile.
		const a = await selfstore('crdt-trap', { cache: memoryCache() });
		const docA = new Y.Doc();
		docA.getText('body').insert(0, 'written-by-A ');
		await a.putFile({ id: 'body', bytes: Y.encodeStateAsUpdate(docA), mime: UPDATE_MIME });
		const target = fakeTarget();
		await a.connectTarget(target);
		await a.flush();
		a.dispose();

		const b = await selfstore('crdt-trap', { cache: memoryCache() });
		open.push(b);
		const docB = new Y.Doc();
		docB.getText('body').insert(0, 'written-by-B ');
		await b.putFile({ id: 'body', bytes: Y.encodeStateAsUpdate(docB), mime: UPDATE_MIME });
		await b.connectTarget(target);

		// One file, one body: A's work never arrives, and nothing reported it.
		expect(b.allFiles()).toHaveLength(1);
		const folded = foldInto(b);
		expect(folded).toContain('written-by-B');
		expect(folded).not.toContain('written-by-A');
	});
});
