/**
 * WebKit (Safari, and every browser on iOS) drops the IndexedDB connection of
 * a page left in the background, silently: every later transaction on the old
 * connection throws UnknownError "Connection to Indexed Database server lost.
 * Refresh the page to try again". A cache that kept that connection failed
 * every local write until a reload - and the store read each failure as an
 * unsent edit, so the badge stayed on "will retry" while the retries uploaded
 * to the destination and failed again on the local bookkeeping.
 */

import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { indexedDbCache } from './cache';
import { createLocalStore } from './store';
import type { BackupTarget } from './target';
import type { Snapshot } from '../selfstore';

const seen = new Set<IDBDatabase>();
const dead = new WeakSet<IDBDatabase>();
const transaction = IDBDatabase.prototype.transaction;

/** Record every connection; one marked dead throws the way WebKit's does. */
function trackConnections(): void {
	vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (
		this: IDBDatabase,
		...args: Parameters<IDBDatabase['transaction']>
	) {
		if (dead.has(this)) {
			throw new DOMException(
				'Connection to Indexed Database server lost. Refresh the page to try again',
				'UnknownError'
			);
		}
		seen.add(this);
		return transaction.apply(this, args);
	});
}

/** Every connection opened so far dies; new ones work. */
function loseConnections(): void {
	for (const d of seen) dead.add(d);
}

afterEach(() => {
	vi.restoreAllMocks();
	seen.clear();
});

let n = 0;

describe('a dropped IndexedDB connection', () => {
	it('the cache reopens it instead of failing for the rest of the session', async () => {
		trackConnections();
		const cache = indexedDbCache(`idb-loss-${++n}`);
		await cache.kv.set('k', 1);
		loseConnections();
		await cache.kv.set('k', 2);
		expect(await cache.kv.get('k')).toBe(2);
		await cache.saveCollections({ notes: [{ id: 'n1' }] });
		expect((await cache.load())?.collections).toEqual({ notes: [{ id: 'n1' }] });
	});

	it('an edit made after the loss turns back to saved on the next interval check', async () => {
		trackConnections();
		const app = { collections: { notes: [{ id: 'n1' }] } as Record<string, unknown[]> };
		const store = createLocalStore({
			app: 'idb-loss',
			schemaVersion: 1,
			gather: () => ({ collections: structuredClone(app.collections), files: [] }),
			apply: (snap: Snapshot) => {
				app.collections = structuredClone(snap.collections ?? {});
			},
			cache: indexedDbCache(`idb-loss-${++n}`),
			debounceMs: 0
		});
		await store.init();
		let remote: Blob | null = null;
		let version = 0;
		const target: BackupTarget = {
			kind: 'drive',
			label: 'Google Drive',
			async save(b) {
				remote = b;
				return String(++version);
			},
			async load() {
				return remote;
			},
			async stat() {
				return remote ? String(version) : null;
			},
			async isReady() {
				return true;
			},
			async reconnect() {
				return true;
			},
			async disconnect() {}
		};
		await store.attachTarget(target, { strategy: 'replace-remote' });
		expect(store.state.status.labelKey).toBe('status.saved');

		loseConnections(); // the phone put the page in the background
		app.collections = { notes: [{ id: 'n1' }, { id: 'n2' }] };
		store.schedule(); // the app's debounced save, as an edit triggers it
		await new Promise((r) => setTimeout(r, 20)); // its timer fires and queues the save

		// The app's 60 s interval: past the store's own stale gate, well under 2 min.
		const now = Date.now();
		vi.spyOn(Date, 'now').mockReturnValue(now + 61_000);
		await store.syncIfStale('interval');
		expect(store.state.status.labelKey).toBe('status.saved');
	});
});
