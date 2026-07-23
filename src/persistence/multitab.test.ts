/**
 * Multi-tab coordination pins. Several store instances share one cache - the
 * real browser case: one IndexedDB, one tab each. The fold-on-save rule is
 * exercised first without the channel (multiTab: false - it is the always-on
 * correctness half), then the live BroadcastChannel refresh with it on. Node
 * ships BroadcastChannel, so the live tests run here exactly as in a browser;
 * the cross-tab Web Lock is browser-only and not needed for these sequential
 * flows.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { createLocalStore, type LocalStore } from './store';
import type { LocalCache, KV, CachedFile } from './cache';
import type { Snapshot } from '../selfstore';

function memCache(): LocalCache {
	const kvMap = new Map<string, unknown>();
	let collections: Record<string, unknown[]> | undefined;
	const files = new Map<string, CachedFile>();
	const kv: KV = {
		async get<T>(k: string) {
			return kvMap.get(k) as T | undefined;
		},
		async set(k, v) {
			kvMap.set(k, v);
		},
		async del(k) {
			kvMap.delete(k);
		}
	};
	return {
		kv,
		async load() {
			return collections ? { collections, files: [...files.values()] } : null;
		},
		async saveCollections(c) {
			collections = c;
		},
		async saveFiles(fs) {
			files.clear();
			for (const f of fs) files.set(f.id, f);
		},
		async clear() {
			kvMap.clear();
			collections = undefined;
			files.clear();
		},
		async requestPersistent() {
			return true;
		}
	};
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Every store created in a test registers here; afterEach disposes them all,
// so no BroadcastChannel handle outlives its test (or keeps vitest alive).
const open: LocalStore[] = [];
afterEach(() => {
	for (const s of open.splice(0)) s.dispose();
});

function tab(
	cache: LocalCache,
	opts: { multiTab: boolean; debounceMs?: number },
	initial: Record<string, unknown[]> = {}
) {
	const app = { collections: structuredClone(initial) };
	const store = createLocalStore({
		app: 'test',
		schemaVersion: 1,
		gather: () => ({ collections: structuredClone(app.collections), files: [] }),
		apply: (snap: Snapshot) => {
			app.collections = structuredClone(snap.collections ?? {});
		},
		cache,
		multiTab: opts.multiTab,
		debounceMs: opts.debounceMs ?? 10,
		logger: { warn() {}, error() {} }
	});
	open.push(store);
	return { store, app };
}

const ids = (rows: unknown[] | undefined): string[] =>
	((rows ?? []) as { id: string }[]).map((r) => r.id).sort();

describe('multi-tab: fold on save (correctness, no channel needed)', () => {
	it('two tabs saving on one cache keep both writes', async () => {
		const cache = memCache();
		const a = tab(cache, { multiTab: false });
		const b = tab(cache, { multiTab: false });
		await a.store.init();
		await b.store.init();

		a.app.collections.notes = [{ id: 'a1' }];
		await a.store.flush();
		b.app.collections.notes = [{ id: 'b1' }];
		await b.store.flush(); // without the fold this save would erase a1 from the cache

		expect(ids((await cache.load())!.collections.notes)).toEqual(['a1', 'b1']);
		expect(ids(b.app.collections.notes)).toEqual(['a1', 'b1']); // folded into B's app too

		// A picks the union up on its next save (epoch moved), edit intact.
		a.app.collections.notes = [...(a.app.collections.notes as object[]), { id: 'a2' }];
		await a.store.flush();
		expect(ids(a.app.collections.notes)).toEqual(['a1', 'a2', 'b1']);
		expect(ids((await cache.load())!.collections.notes)).toEqual(['a1', 'a2', 'b1']);
	});

	it('a stale tab cannot resurrect a record another tab deleted', async () => {
		const cache = memCache();
		const a = tab(cache, { multiTab: false }, { notes: [{ id: 'n1' }, { id: 'n2' }] });
		await a.store.init();
		await a.store.flush(); // seed the shared cache (clocks for n1/n2)
		const b = tab(cache, { multiTab: false });
		await b.store.init(); // B hydrates n1 + n2 and their meta

		a.app.collections.notes = [{ id: 'n2' }];
		await a.store.flush(); // A deletes n1: a tombstone lands in the shared meta

		b.app.collections.notes = [...(b.app.collections.notes as object[]), { id: 'n3' }];
		await b.store.flush(); // stale B still holds n1 in memory

		expect(ids((await cache.load())!.collections.notes)).toEqual(['n2', 'n3']); // n1 stays dead
		expect(ids(b.app.collections.notes)).toEqual(['n2', 'n3']);
	});
});

describe('multi-tab: live refresh (BroadcastChannel)', () => {
	it('an idle tab adopts a peer save', async () => {
		const cache = memCache();
		const a = tab(cache, { multiTab: true });
		const b = tab(cache, { multiTab: true });
		await a.store.init();
		await b.store.init();

		a.app.collections.notes = [{ id: 'a1' }];
		await a.store.flush();
		await sleep(50); // channel delivery + the serialized adopt

		expect(ids(b.app.collections.notes)).toEqual(['a1']);
		expect(b.store.state.lastSavedAt).toBe(a.store.state.lastSavedAt);
	});

	it('a tab holding an unsaved edit saves it on refresh instead of losing it', async () => {
		const cache = memCache();
		const a = tab(cache, { multiTab: true });
		const b = tab(cache, { multiTab: true, debounceMs: 60_000 }); // the edit stays in flight
		await a.store.init();
		await b.store.init();

		b.app.collections.notes = [{ id: 'b1' }];
		b.store.schedule(); // armed, far from firing

		a.app.collections.notes = [{ id: 'a1' }];
		await a.store.flush();
		await sleep(80); // B refreshes: pending edit -> full save, folding A's write in

		expect(ids((await cache.load())!.collections.notes)).toEqual(['a1', 'b1']);
		expect(ids(b.app.collections.notes)).toEqual(['a1', 'b1']);
		await sleep(80); // and A adopts B's fold back
		expect(ids(a.app.collections.notes)).toEqual(['a1', 'b1']);
	});

	it('forget in one tab clears the others', async () => {
		const cache = memCache();
		const a = tab(cache, { multiTab: true }, { notes: [{ id: 'n1' }] });
		await a.store.init();
		await a.store.flush();
		const b = tab(cache, { multiTab: true });
		await b.store.init();
		expect(ids(b.app.collections.notes)).toEqual(['n1']);

		await a.store.forget(); // no destination connected: full local wipe
		await sleep(50);
		expect(b.app.collections.notes ?? []).toEqual([]);
		expect(ids((await cache.load())?.collections.notes ?? [])).toEqual([]);
	});
});
