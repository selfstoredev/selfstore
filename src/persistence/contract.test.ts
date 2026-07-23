/**
 * Pins of the hardened public contract: typed error codes end to end, the
 * newer-schema guard, custom target kinds, the stable state reference, the
 * strict crypto-agility reader, and memoryCache as a first-class cache.
 * These are the promises consumers build on; a regression here is a breaking
 * change even if every feature still "works".
 */

import { describe, it, expect } from 'vitest';
import { createLocalStore, type LocalStoreOptions } from './store';
import { memoryCache } from './cache';
import type { BackupTarget } from './target';
import {
	AuthExpiredError,
	SelfstoreError,
	isAuthExpired,
	inspect,
	exportSnapshot,
	importSnapshot,
	restore as fluentRestore,
	type Snapshot
} from '../selfstore';
import { createMeta, stamp } from '../sync';
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';

function memTarget(kind = 'drive') {
	let remote: Blob | null = null;
	let failWith: Error | null = null;
	const target: BackupTarget = {
		kind,
		label: kind,
		async save(b) {
			if (failWith) throw failWith;
			remote = b;
			return null;
		},
		async load() {
			return remote;
		},
		async isReady() {
			return true;
		},
		async reconnect() {
			return true;
		},
		async disconnect() {}
	};
	return {
		target,
		get remote() {
			return remote;
		},
		fail(e: Error | null) {
			failWith = e;
		}
	};
}

function makeStore(initial: Record<string, unknown[]> = {}, extra: Partial<LocalStoreOptions> = {}) {
	const app = { collections: structuredClone(initial) };
	const cache = memoryCache();
	const store = createLocalStore({
		app: 'test',
		schemaVersion: 1,
		gather: () => ({ collections: structuredClone(app.collections), files: [] }),
		apply: (snap: Snapshot) => {
			app.collections = structuredClone(snap.collections ?? {});
		},
		cache,
		...extra
	});
	return { store, app, cache };
}

describe('typed error contract', () => {
	it('AuthExpiredError raises the gate with a stable code', async () => {
		const { store, app } = makeStore();
		await store.init();
		const t = memTarget();
		await store.attachTarget(t.target, { strategy: 'replace-remote' });

		t.fail(new AuthExpiredError());
		app.collections.accounts = [{ id: 'a1' }];
		await store.flush();

		expect(store.state.status.state).toBe('needs-attention');
		expect(store.state.lastError?.code).toBe('AUTH_EXPIRED');
	});

	it('a transient failure reports TARGET_UNAVAILABLE and never gates', async () => {
		const { store, app } = makeStore();
		await store.init();
		const t = memTarget();
		await store.attachTarget(t.target, { strategy: 'replace-remote' });

		t.fail(new Error('network reset'));
		app.collections.accounts = [{ id: 'a1' }];
		await store.flush();

		expect(store.state.status.state).not.toBe('needs-attention');
		expect(store.state.lastError?.code).toBe('TARGET_UNAVAILABLE');
	});

	it('a permanent target failure (TARGET_GONE) gates instead of looping as transient', async () => {
		const { store, app } = makeStore();
		await store.init();
		const t = memTarget();
		await store.attachTarget(t.target, { strategy: 'replace-remote' });

		// The bound file is gone / access withdrawn: retrying cannot fix it, so the
		// store must raise the gate (never a false "saved" over a frozen remote).
		t.fail(new SelfstoreError('TARGET_GONE', 'Drive backup unwritable (404).'));
		app.collections.accounts = [{ id: 'a1' }];
		await store.flush();

		expect(store.state.status.state).toBe('needs-attention');
		expect(store.state.lastError?.code).toBe('TARGET_GONE');
	});

	it('isAuthExpired recognises the typed error and nothing else', () => {
		expect(isAuthExpired(new AuthExpiredError())).toBe(true);
		// A bare marker property is not the contract: targets throw AuthExpiredError.
		expect(isAuthExpired(Object.assign(new Error('x'), { authExpired: true }))).toBe(false);
		expect(isAuthExpired(new Error('x'))).toBe(false);
	});
});

describe('newer-schema guard (SCHEMA_TOO_NEW)', () => {
	it('an older app neither applies nor overwrites data written by a newer schema', async () => {
		// Device A (schema v2) seeds the shared target.
		const a = makeStore({ accounts: [{ id: 'a1', shapedFor: 'v2' }] }, { schemaVersion: 2 });
		await a.store.init();
		const shared = memTarget();
		await a.store.attachTarget(shared.target, { strategy: 'replace-remote' });
		const remoteBefore = shared.remote;

		// Device B still runs schema v1 and connects to the same backup.
		const b = makeStore({ accounts: [{ id: 'b-local' }] }, { schemaVersion: 1 });
		await b.store.init();
		await b.store.attachTarget(shared.target, { strategy: 'merge' });

		expect(b.store.state.lastError?.code).toBe('SCHEMA_TOO_NEW');
		expect(b.store.state.status.state).toBe('needs-attention');
		// B kept its local data untouched...
		expect(b.app.collections.accounts).toEqual([{ id: 'b-local' }]);
		// ...and never pushed its older shape over the newer backup.
		expect(shared.remote).toBe(remoteBefore);
	});
});

describe('newer-schema guard survives a flush and a reboot', () => {
	it('a downgraded app can neither erase the gate nor clobber after restart', async () => {
		const cache = memoryCache();
		const mk = (schemaVersion: number) => {
			const app = { collections: { accounts: [{ id: 'a1' }] } as Record<string, unknown[]> };
			const store = createLocalStore({
				app: 'test',
				schemaVersion,
				gather: () => ({ collections: structuredClone(app.collections), files: [] }),
				apply: (snap: Snapshot) => {
					app.collections = structuredClone(snap.collections ?? {});
				},
				cache
			});
			return { store, app };
		};

		// Session 1: the app runs schema v2 and persists.
		const v2 = mk(2);
		await v2.store.init();
		v2.app.collections.accounts = [{ id: 'a1', shaped: 'v2' }];
		await v2.store.flush();

		// Session 2: the app is DOWNGRADED to v1. The gate must raise...
		const v1 = mk(1);
		await v1.store.init();
		expect(v1.store.state.lastError?.code).toBe('SCHEMA_TOO_NEW');
		// ...and a flush (persistLocal) must not lower the stored version stamp.
		await v1.store.flush();

		// Session 3: same downgraded app reboots - the gate must STILL be up.
		const v1again = mk(1);
		await v1again.store.init();
		expect(v1again.store.state.lastError?.code).toBe('SCHEMA_TOO_NEW');
	});
});

describe('custom target kinds', () => {
	it('attaches, persists and restores a target with a custom kind', async () => {
		const cache = memoryCache();
		const custom = memTarget('s3');
		const mk = () => {
			const app = { collections: {} as Record<string, unknown[]> };
			return createLocalStore({
				app: 'test',
				schemaVersion: 1,
				gather: () => ({ collections: structuredClone(app.collections), files: [] }),
				apply: (snap: Snapshot) => {
					app.collections = structuredClone(snap.collections ?? {});
				},
				cache,
				restoreTarget: async (kind) => (kind === 's3' ? custom.target : null)
			});
		};

		const first = mk();
		await first.init();
		await first.attachTarget(custom.target, { strategy: 'replace-remote' });
		expect(first.state.targetKind).toBe('s3');
		expect(first.state.status.state).toBe('saved');

		// A fresh session restores the custom target by its persisted kind.
		const second = mk();
		await second.init();
		expect(second.state.targetKind).toBe('s3');
	});

	it('refuses a target claiming a reserved store mode as its kind', async () => {
		const { store } = makeStore();
		await store.init();
		const bogus = memTarget('device');
		expect(() => store.attachTarget(bogus.target)).toThrow(/reserved store mode/);
	});
});

describe('stable state reference', () => {
	it('returns the same snapshot object between changes (adapter-safe)', async () => {
		const { store, app } = makeStore();
		await store.init();
		const s1 = store.state;
		expect(store.state).toBe(s1); // repeated reads: same reference
		app.collections.accounts = [{ id: 'a1' }];
		await store.flush();
		expect(store.state).not.toBe(s1); // a change produced a new snapshot
		expect(store.state).toBe(store.state);
	});
});

describe('strict reader (crypto agility)', () => {
	it('reports UNSUPPORTED_VERSION for an unknown cipher, never DECRYPT_FAILED', async () => {
		const blob = await exportSnapshot(
			{ collections: { a: [] }, files: [] },
			{ app: 'test', password: 'pw' }
		);
		const entries = unzipSync(new Uint8Array(await blob.arrayBuffer()));
		const meta = JSON.parse(strFromU8(entries['meta.json']));
		meta.encryption = 'xchacha20-poly1305';
		entries['meta.json'] = strToU8(JSON.stringify(meta));
		const tampered = zipSync(entries, { level: 0 });

		await expect(inspect(tampered)).rejects.toMatchObject({ code: 'UNSUPPORTED_VERSION' });
	});

	it('stamps and reports the schema version in the header', async () => {
		const blob = await exportSnapshot(
			{ collections: { a: [] }, files: [] },
			{ app: 'test', appVersion: '1.4.2', schemaVersion: 3 }
		);
		const header = await inspect(blob);
		expect(header.schemaVersion).toBe(3);
		expect(header.appVersion).toBe('1.4.2');
	});
});

describe('sync bookkeeping rides its own entry', () => {
	it('a store-written backup keeps only app data in its collections', async () => {
		const { store, app } = makeStore();
		await store.init();
		app.collections.accounts = [{ id: 'a1' }];
		await store.flush();
		const blob = await store.exportBlob();

		// The store's schema + merge metadata travels in the dedicated sync.json
		// sidecar, never as a reserved collection injected into user data - so even
		// the RAW functional read (which strips nothing) sees only app collections.
		const raw = await importSnapshot(blob);
		expect(Object.keys(raw.collections)).toEqual(['accounts']);

		// The fluent read agrees.
		const snap = await fluentRestore(blob).read();
		expect(Object.keys(snap.collections)).toEqual(['accounts']);
	});

	it('strips a reserved __store collection from a foreign backup instead of handing it to the app', async () => {
		// A hand-authored file may carry a `__`-prefixed collection. Reserved
		// names belong to the library: the data around them loads (foreign adopt
		// on a fresh device), the reserved collection never reaches apply().
		let meta = createMeta();
		meta = stamp(meta, { accounts: [{ id: 'a1', name: 'Foreign' }] }, {});
		const foreignBlob = await exportSnapshot(
			{
				collections: {
					accounts: [{ id: 'a1', name: 'Foreign' }],
					__store: [{ version: 1, sync: meta }]
				},
				files: []
			},
			{ app: 'test', schemaVersion: 1 }
		);

		const { store, app } = makeStore();
		await store.init();
		const t = memTarget();
		await t.target.save(foreignBlob); // preload the target with the foreign backup
		await store.attachTarget(t.target, { strategy: 'merge' });

		// The app data loaded...
		expect(app.collections.accounts).toEqual([{ id: 'a1', name: 'Foreign' }]);
		// ...and the reserved collection never leaked into the app's view.
		expect(app.collections).not.toHaveProperty('__store');
		// ...and the store lands cleanly saved, no gate.
		expect(store.state.status.state).toBe('saved');
	});
});

describe('memoryCache', () => {
	it('runs the full store cycle and survives a second instance on the same cache', async () => {
		const cache = memoryCache();
		const mk = () => {
			const app = { collections: {} as Record<string, unknown[]> };
			const store = createLocalStore({
				app: 'test',
				schemaVersion: 1,
				gather: () => ({ collections: structuredClone(app.collections), files: [] }),
				apply: (snap: Snapshot) => {
					app.collections = structuredClone(snap.collections ?? {});
				},
				cache
			});
			return { store, app };
		};

		const a = mk();
		await a.store.init();
		a.app.collections.notes = [{ id: 'n1', text: 'hello' }];
		await a.store.flush();

		const b = mk();
		await b.store.init();
		expect(b.app.collections.notes).toEqual([{ id: 'n1', text: 'hello' }]);
	});
});
