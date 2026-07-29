/**
 * The cross-tab Web Lock, and what happens when it never comes.
 *
 * A Web Lock belongs to a CLIENT, and a client that stops running does not
 * necessarily hand it back: Firefox keeps the locks of a page it has frozen
 * into its back/forward cache. A second tab left open in the background can
 * therefore hold `selfstore:<app>` for good - and every serialized flow in the
 * live tab used to queue behind it forever, with no throw and no timeout. The
 * store simply stopped writing, and every button wired to it did nothing at
 * all.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
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

type Grant = (lock: unknown) => Promise<unknown>;

/** A lock another client holds and never releases. It honours the signal - that
 *  is the whole escape - but grants nothing, ever. */
function heldForGood(): LockManager {
	return {
		request(_name: string, options: { signal?: AbortSignal }): Promise<unknown> {
			return new Promise((_resolve, reject) => {
				options.signal?.addEventListener('abort', () =>
					reject(new DOMException('aborted', 'AbortError'))
				);
			});
		},
		query: async () => ({ held: [], pending: [] })
	} as unknown as LockManager;
}

/** A free lock: granted at once, released when the flow settles. */
function free(trace: string[]): LockManager {
	return {
		async request(name: string, _options: unknown, grant: Grant): Promise<unknown> {
			trace.push('acquired');
			try {
				return await grant({ name, mode: 'exclusive' });
			} finally {
				trace.push('released');
			}
		},
		query: async () => ({ held: [], pending: [] })
	} as unknown as LockManager;
}

const open: LocalStore[] = [];
afterEach(() => {
	for (const s of open.splice(0)) s.dispose();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

function tab(cache: LocalCache, initial: Record<string, unknown[]> = {}) {
	const app = { collections: structuredClone(initial) };
	let gathers = 0;
	const store = createLocalStore({
		app: 'test',
		schemaVersion: 1,
		gather: () => {
			gathers++;
			return { collections: structuredClone(app.collections), files: [] };
		},
		apply: (snap: Snapshot) => {
			app.collections = structuredClone(snap.collections ?? {});
		},
		cache,
		multiTab: true,
		debounceMs: 10,
		logger: { warn() {}, error() {} }
	});
	open.push(store);
	return { store, app, gathers: () => gathers };
}

describe('cross-tab lock', () => {
	it('is taken and given back when it is free', async () => {
		const trace: string[] = [];
		vi.stubGlobal('navigator', { locks: free(trace) });
		const cache = memCache();
		const t = tab(cache, { notes: [{ id: 'n1' }] });
		await t.store.init();

		await t.store.flush();

		expect(trace).toEqual(['acquired', 'released']);
		expect((await cache.load())?.collections.notes).toHaveLength(1);
	});

	it('does not freeze the tab when the lock never comes', async () => {
		// The bug, exactly: the flow queued behind a lock held by a frozen tab and
		// stayed there. Nothing threw, so nothing could be reported - the store
		// just stopped writing.
		vi.stubGlobal('navigator', { locks: heldForGood() });
		const cache = memCache();
		const t = tab(cache, { notes: [{ id: 'n1' }] });
		await t.store.init();

		vi.useFakeTimers();
		const writing = t.store.flush();
		await vi.advanceTimersByTimeAsync(11_000);
		await writing;

		expect((await cache.load())?.collections.notes).toHaveLength(1);
	});

	it('runs the flow ONCE when it gives up on the lock', async () => {
		// Going ahead unlocked means calling the flow after the request rejected.
		// Read an abort that fires DURING the flow as "the lock never came" and it
		// would run a second time, over its own result. Measured against the
		// granted path rather than a hard number: one save is one save, whatever
		// it costs internally.
		vi.stubGlobal('navigator', { locks: free([]) });
		const granted = tab(memCache(), { notes: [{ id: 'n1' }] });
		await granted.store.init();
		const baseline = granted.gathers();
		await granted.store.flush();
		const cost = granted.gathers() - baseline;
		expect(cost).toBeGreaterThan(0); // the measure has to measure something

		vi.unstubAllGlobals();
		vi.stubGlobal('navigator', { locks: heldForGood() });
		const gaveUp = tab(memCache(), { notes: [{ id: 'n1' }] });
		await gaveUp.store.init();
		const before = gaveUp.gathers();

		vi.useFakeTimers();
		const writing = gaveUp.store.flush();
		await vi.advanceTimersByTimeAsync(11_000);
		await writing;

		expect(gaveUp.gathers() - before).toBe(cost);
	});

	it('says so instead of going quiet about it', async () => {
		vi.stubGlobal('navigator', { locks: heldForGood() });
		const cache = memCache();
		const t = tab(cache, { notes: [{ id: 'n1' }] });
		await t.store.init();

		vi.useFakeTimers();
		const writing = t.store.flush();
		await vi.advanceTimersByTimeAsync(11_000);
		await writing;

		expect(t.store.state.lastError?.code).toBe('TARGET_UNAVAILABLE');
	});
});
