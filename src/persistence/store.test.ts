/**
 * Unit coverage for the two reversible data/security operations on the store:
 *   - forget() while a destination is connected: empties the remote backup but
 *     keeps the connection (vs the cache-only fallback with no destination);
 *   - setEncryption(): add then remove a password on a connected target.
 * Driven through an in-memory cache and a fake BackupTarget, so the test runs in
 * the plain Node project (native WebCrypto powers the .selfstore round-trips).
 */

import { describe, it, expect, vi } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { createLocalStore } from './store';
import type { LocalCache, KV, CachedFile } from './cache';
import type { BackupTarget } from './target';
import {
	importSnapshot,
	inspect,
	errorLabelKey,
	SelfstoreError,
	AuthExpiredError,
	type Snapshot
} from '../selfstore';
import { readBoxWithSync } from '../selfstore/box';
import { gcmSealRaw } from '../selfstore/group';
import { pack } from '../selfstore/archive';
import type { SyncConfig } from '../sync';

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

function fakeTarget(kind: 'drive' | 'file' = 'drive') {
	let remote: Blob | null = null;
	let disconnected = 0;
	const target: BackupTarget = {
		kind,
		label: kind === 'drive' ? 'Google Drive' : 'backup.selfstore',
		async save(b) {
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
		async disconnect() {
			disconnected++;
		}
	};
	return {
		target,
		get remote() {
			return remote;
		},
		get disconnected() {
			return disconnected;
		}
	};
}

/** A store wired to an isolated cache, mirroring an in-test app state. */
function makeStore(
	initial: Record<string, unknown[]> = {},
	sync?: SyncConfig,
	debounceMs?: number,
	journalSilent?: string[]
) {
	const app = { collections: structuredClone(initial) };
	const cache = memCache();
	const store = createLocalStore({
		app: 'test',
		schemaVersion: 1,
		gather: () => ({ collections: structuredClone(app.collections), files: [] }),
		apply: (snap: Snapshot) => {
			app.collections = structuredClone(snap.collections ?? {});
		},
		sync,
		journalSilent,
		cache,
		debounceMs
	});
	return { store, app, cache };
}

describe('store.forget', () => {
	it('keeps the connection and empties the remote backup when connected', async () => {
		const { store, app } = makeStore({ accounts: [{ id: 'a1', name: 'Boursorama' }] });
		const t = fakeTarget('drive');
		await store.attachTarget(t.target, { strategy: 'replace-remote' });

		expect(store.state.targetKind).toBe('drive');
		const before = await importSnapshot(t.remote!);
		expect((before.collections.accounts ?? []).length).toBe(1);

		await store.forget();

		expect(store.state.targetKind).toBe('drive'); // still connected
		expect(t.disconnected).toBe(0); // never disconnected
		expect(app.collections).toEqual({}); // local data gone
		const after = await importSnapshot(t.remote!);
		expect(after.collections.accounts ?? []).toEqual([]); // remote emptied
	});

	it('returns to the cache-only default when no destination is connected', async () => {
		const { store, app } = makeStore({ accounts: [{ id: 'a1' }] });
		await store.forget();
		expect(store.state.targetKind).toBe('device');
		expect(app.collections).toEqual({});
	});

	it('propagates the deletion to a second device sharing the target', async () => {
		// Device A seeds the shared target; device B syncs and gets the record.
		const a = makeStore({ accounts: [{ id: 'a1', name: 'Boursorama' }] });
		const b = makeStore();
		const shared = fakeTarget('drive');
		await a.store.attachTarget(shared.target, { strategy: 'replace-remote' });
		await b.store.attachTarget(shared.target, { strategy: 'merge' });
		expect((b.app.collections.accounts ?? []).length).toBe(1); // B received it

		// A erases everything (connected): the empty state is pushed with tombstones.
		await a.store.forget();

		// B re-syncs (a fresh attach re-pulls): the tombstone must win, so B drops it
		// instead of re-propagating its copy back.
		await b.store.attachTarget(shared.target, { strategy: 'merge' });
		expect(b.app.collections.accounts ?? []).toEqual([]);
		const remote = await importSnapshot(shared.remote!);
		expect(remote.collections.accounts ?? []).toEqual([]); // not resurrected
	});
});

describe('store.attachTarget backup switches (isolated backups)', () => {
	it('loads an isolated backup: local data replaced, the departing backup untouched', async () => {
		// Silo S (shared) is seeded by another device; silo P (personal) by this one.
		const other = makeStore({ accounts: [{ id: 's1', name: 'Shared' }] });
		const shared = fakeTarget('drive');
		await other.store.attachTarget(shared.target, { strategy: 'replace-remote' });

		const { store, app } = makeStore({ accounts: [{ id: 'p1', name: 'Mine' }] });
		const personal = fakeTarget('drive');
		await store.attachTarget(personal.target, { strategy: 'replace-remote' });
		const personalBefore = await importSnapshot(personal.remote!);

		await store.attachTarget(shared.target, { strategy: 'replace-local', keepSession: true });

		// Soft switch: the departing personal silo keeps its session and its bytes.
		expect(personal.disconnected).toBe(0);
		const personalAfter = await importSnapshot(personal.remote!);
		expect(personalAfter.collections.accounts).toEqual(personalBefore.collections.accounts);
		// Local state is the loaded silo, replaced - never merged.
		expect(app.collections.accounts).toEqual([{ id: 's1', name: 'Shared' }]);
		const sharedNow = await importSnapshot(shared.remote!);
		expect((sharedNow.collections.accounts ?? []).length).toBe(1); // no p1 leaked in
	});

	it('wipe starts the new backup blank instead of seeding it from the loaded one', async () => {
		const { store, app } = makeStore({ accounts: [{ id: 's1', name: 'Shared' }] });
		const sharedT = fakeTarget('drive');
		await store.attachTarget(sharedT.target, { strategy: 'replace-remote' });

		const fresh = fakeTarget('drive');
		await store.attachTarget(fresh.target, {
			strategy: 'replace-remote',
			keepSession: true,
			wipe: true
		});

		expect(app.collections).toEqual({}); // local starts blank with the new silo
		const freshNow = await importSnapshot(fresh.remote!);
		expect(freshNow.collections.accounts ?? []).toEqual([]); // nothing copied over
		const sharedNow = await importSnapshot(sharedT.remote!);
		expect((sharedNow.collections.accounts ?? []).length).toBe(1); // departing silo intact
		expect(sharedT.disconnected).toBe(0);
	});

	it('a non-soft attach still disconnects the departing target', async () => {
		const { store } = makeStore({ accounts: [{ id: 'a1' }] });
		const a = fakeTarget('drive');
		await store.attachTarget(a.target, { strategy: 'replace-remote' });
		const b = fakeTarget('file');
		await store.attachTarget(b.target, { strategy: 'replace-remote' });
		expect(a.disconnected).toBe(1);
	});

	it('flushes a pending local edit to the departing backup before switching', async () => {
		// A shared silo seeded by another device, to switch into.
		const other = makeStore({ accounts: [{ id: 's1', name: 'Shared' }] });
		const shared = fakeTarget('drive');
		await other.store.attachTarget(shared.target, { strategy: 'replace-remote' });

		// This device sits on its personal silo with one already-saved record.
		const { store, app } = makeStore({ accounts: [{ id: 'p1', name: 'Mine' }] });
		const personal = fakeTarget('drive');
		await store.attachTarget(personal.target, { strategy: 'replace-remote' });

		// An edit lands locally but is not pushed yet (offline / within debounce):
		// mutate the app state directly so the store never saved it to the file.
		app.collections.accounts = [
			{ id: 'p1', name: 'Mine' },
			{ id: 'p2', name: 'Unsynced edit' }
		];
		const before = await importSnapshot(personal.remote!);
		expect((before.collections.accounts ?? []).length).toBe(1); // edit not on the file yet

		// Switch backups: the departing personal silo must first receive the edit,
		// so an immediate switch never strands unsynced work on the file we leave.
		await store.attachTarget(shared.target, { strategy: 'replace-local', keepSession: true });

		const after = await importSnapshot(personal.remote!);
		expect(after.collections.accounts).toEqual([
			{ id: 'p1', name: 'Mine' },
			{ id: 'p2', name: 'Unsynced edit' }
		]);
		// The loaded silo replaced local, and the edit never leaked into it.
		expect(app.collections.accounts).toEqual([{ id: 's1', name: 'Shared' }]);
		const sharedNow = await importSnapshot(shared.remote!);
		expect((sharedNow.collections.accounts ?? []).length).toBe(1);
	});
});

describe('schema migration', () => {
	it('applies the forward migration when the cached schema is older than the app', async () => {
		const cache = memCache();
		// A cache written by schema v1: an account without the later `currency` field.
		await cache.saveCollections({ accounts: [{ id: 'a1', label: 'Boursorama' }] });
		await cache.kv.set('version', 1);

		let restored: Record<string, unknown[]> = {};
		const store = createLocalStore({
			app: 'test',
			schemaVersion: 2,
			gather: () => ({ collections: structuredClone(restored), files: [] }),
			apply: (snap: Snapshot) => {
				restored = structuredClone(snap.collections ?? {});
			},
			migrate: (from, snap) => {
				if (from < 2) {
					snap.collections.accounts = (snap.collections.accounts as { id: string }[]).map((a) => ({
						currency: 'EUR',
						...a
					}));
				}
				return snap;
			},
			cache
		});

		await store.init();

		const accounts = restored.accounts as { id: string; label: string; currency?: string }[];
		expect(accounts[0].currency).toBe('EUR'); // migration filled the new field
		expect(accounts[0].label).toBe('Boursorama'); // existing data preserved
	});

	it('does not migrate a cache already at the current version', async () => {
		const cache = memCache();
		await cache.saveCollections({ accounts: [{ id: 'a1' }] });
		await cache.kv.set('version', 2);

		let migrated = false;
		const store = createLocalStore({
			app: 'test',
			schemaVersion: 2,
			gather: () => ({ collections: {}, files: [] }),
			apply: () => {},
			migrate: (_from, snap) => {
				migrated = true;
				return snap;
			},
			cache
		});

		await store.init();
		expect(migrated).toBe(false);
	});
});

describe('freshness (stat-based converge)', () => {
	const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

	/** A shared target whose version bumps on each write, like a Drive file. */
	function versionedTarget() {
		let remote: Blob | null = null;
		let version = 0;
		let loads = 0;
		const target: BackupTarget = {
			kind: 'drive',
			label: 'Google Drive',
			async save(b) {
				remote = b;
				version++;
				return String(version);
			},
			async load() {
				loads++;
				return remote;
			},
			async stat() {
				stats++;
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
		let stats = 0;
		return {
			target,
			get loads() {
				return loads;
			},
			get stats() {
				return stats;
			}
		};
	}

	it('pushDurable converges first when another replica wrote since the last sync', async () => {
		const a = makeStore({ accounts: [{ id: 'a1', name: 'A' }] });
		const b = makeStore();
		await a.store.init(); // flush/schedule only run on an initialized store
		await b.store.init();
		const shared = versionedTarget();
		await a.store.attachTarget(shared.target, { strategy: 'replace-remote' });
		await b.store.attachTarget(shared.target, { strategy: 'merge' }); // B receives a1

		// A adds a record; B does not know yet.
		a.app.collections.accounts = [...(a.app.collections.accounts ?? []), { id: 'a2', name: 'A2' }];
		await a.store.flush();

		// B edits its own copy and saves: the pre-push converge must fold a2 in,
		// instead of overwriting the remote with a state that lacks it.
		b.app.collections.accounts = (b.app.collections.accounts as { id: string; name: string }[]).map(
			(x) => (x.id === 'a1' ? { ...x, name: 'renamed-by-B' } : x)
		);
		await b.store.flush();

		const remote = await importSnapshot((await shared.target.load())!);
		const ids = (remote.collections.accounts as { id: string }[]).map((x) => x.id).sort();
		expect(ids).toEqual(['a1', 'a2']); // both survive on the remote
		expect(b.app.collections.accounts).toHaveLength(2); // and locally on B
	});

	it('syncIfStale does not download when the remote has not moved', async () => {
		const a = makeStore({ accounts: [{ id: 'a1' }] });
		const shared = versionedTarget();
		await a.store.attachTarget(shared.target, { strategy: 'replace-remote' });
		const loadsBefore = shared.loads;
		await a.store.syncIfStale('focus');
		expect(shared.loads).toBe(loadsBefore); // stat only, no backup download
	});

	it('syncIfStale converges when the remote moved, and journals what changed', async () => {
		const a = makeStore({ accounts: [{ id: 'a1' }] });
		const b = makeStore();
		await a.store.init();
		await b.store.init();
		const shared = versionedTarget();
		await a.store.attachTarget(shared.target, { strategy: 'replace-remote' });
		await b.store.attachTarget(shared.target, { strategy: 'merge' });

		a.app.collections.accounts = [{ id: 'a1' }, { id: 'a2' }];
		await a.store.flush();

		await b.store.syncIfStale('focus');
		expect(b.app.collections.accounts).toHaveLength(2);
		expect(b.store.state.journal[0]).toMatchObject({
			source: 'focus',
			changes: { accounts: { added: 1, updated: 0, removed: 0 } }
		});
		expect(b.store.state.lastSync).toBe(b.store.state.journal[0]);
	});

	it('records a same-record concurrent edit on the journal (local loses to a later remote)', async () => {
		const a = makeStore({ accounts: [{ id: 'a1', name: 'A' }] });
		const b = makeStore();
		await a.store.init();
		await b.store.init();
		const shared = versionedTarget();
		await a.store.attachTarget(shared.target, { strategy: 'replace-remote' });
		await b.store.attachTarget(shared.target, { strategy: 'merge' }); // B gets a1 and a base

		// B edits a1 first (earlier HLC) and pushes.
		b.app.collections.accounts = [{ id: 'a1', name: 'renamed-by-B' }];
		await b.store.flush();
		await sleep(5); // separate the wall clocks so ordering is deterministic

		// A edits the same record later (wins the HLC) and pushes.
		a.app.collections.accounts = [{ id: 'a1', name: 'renamed-by-A' }];
		await a.store.flush();

		// B converges: its earlier a1 loses to A's later a1, so B's copy changes and
		// the concurrent edit is recorded on the journal entry rather than vanishing.
		await b.store.syncIfStale('focus');

		expect((b.app.collections.accounts as { name: string }[])[0].name).toBe('renamed-by-A');
		// The journal carries the conflict VALUES (both sides), not just a count, so
		// an app can show - or offer to restore - the overwritten version.
		const conflicts = b.store.state.journal[0]?.conflicts;
		expect(conflicts).toHaveLength(1);
		expect(conflicts![0]).toMatchObject({
			collection: 'accounts',
			id: 'a1',
			local: { id: 'a1', name: 'renamed-by-B' },
			remote: { id: 'a1', name: 'renamed-by-A' }
		});
		// Privacy at rest: the kv-persisted journal is REDACTED - the kv space is
		// not encrypted, so full user records must never land there. Values live
		// in memory only, for the session's resolution UI.
		const persisted =
			(await b.cache.kv.get<{ conflicts?: Record<string, unknown>[] }[]>('syncJournal'))!;
		const stored = persisted.find((e) => e.conflicts?.length)!;
		expect(stored.conflicts![0]).not.toHaveProperty('local');
		expect(stored.conflicts![0]).not.toHaveProperty('remote');
		expect(stored.conflicts![0]).toMatchObject({ collection: 'accounts', id: 'a1' });
		expect(JSON.stringify(persisted)).not.toContain('renamed-by');
	});

	it('a stray flush before init never touches the cache (viewer-page safety)', async () => {
		const a = makeStore({ accounts: [{ id: 'a1' }] });
		await a.store.flush(); // e.g. a pagehide on a page that never initializes
		expect(await a.cache.load()).toBeNull(); // nothing gathered, nothing written
	});

	it('schedule is a pre-init no-op, then debounce-saves once initialized', async () => {
		const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
		const a = makeStore({ accounts: [{ id: 'a1' }] }, undefined, 10);
		a.store.schedule(); // pre-init: must not even arm the timer
		await sleep(40);
		expect(await a.cache.load()).toBeNull();
		await a.store.init();
		a.store.schedule();
		await sleep(60);
		expect(await a.cache.load()).not.toBeNull(); // the debounced save landed
	});

	it('syncNow resolves to null (and journals nothing) when already up to date', async () => {
		const a = makeStore({ accounts: [{ id: 'a1' }] });
		const shared = versionedTarget();
		await a.store.attachTarget(shared.target, { strategy: 'replace-remote' });
		const before = a.store.state.journal.length;
		expect(await a.store.syncNow()).toBeNull();
		expect(a.store.state.journal.length).toBe(before);
	});

	it('throttles consecutive stale checks (focus events can burst)', async () => {
		const a = makeStore({ accounts: [{ id: 'a1' }] });
		const shared = versionedTarget();
		await a.store.attachTarget(shared.target, { strategy: 'replace-remote' });
		const statsBefore = shared.stats;
		await a.store.syncIfStale('focus'); // stats once, remote unmoved
		await a.store.syncIfStale('focus'); // throttled: no second stat
		expect(shared.stats).toBe(statsBefore + 1);
	});

	it('journals nothing when only journal-silent collections changed', async () => {
		const cfg: SyncConfig = { ids: { dailyHistory: 'date' } };
		const silent = ['dailyHistory'];
		const a = makeStore(
			{ dailyHistory: [{ date: '2026-07-01', value: 100 }] },
			cfg,
			undefined,
			silent
		);
		const b = makeStore({}, cfg, undefined, silent);
		const shared = versionedTarget();
		await a.store.attachTarget(shared.target, { strategy: 'replace-remote' });
		await b.store.attachTarget(shared.target, { strategy: 'merge' });
		expect(b.app.collections.dailyHistory).toHaveLength(1); // the data converged
		expect(b.store.state.journal).toEqual([]); // silently: routine derived points
		expect(b.store.state.lastSync).toBeNull();
	});

	it('re-locks and never clobbers when the remote passphrase is wrong', async () => {
		// Device A owns an encrypted backup.
		const a = makeStore({ accounts: [{ id: 'a1' }] });
		const shared = versionedTarget();
		await a.store.attachTarget(shared.target, { password: 'right', strategy: 'replace-remote' });

		// Device B attaches with the wrong passphrase: it must re-lock and ask,
		// keeping its local data and leaving the remote untouched.
		const b = makeStore({ accounts: [{ id: 'b-local' }] });
		await b.store.attachTarget(shared.target, { password: 'wrong', strategy: 'merge' });
		expect(b.store.state.locked).toBe(true);
		expect(b.app.collections.accounts).toEqual([{ id: 'b-local' }]);
		const remote = await importSnapshot((await shared.target.load())!, { password: 'right' });
		expect((remote.collections.accounts as { id: string }[]).map((x) => x.id)).toEqual(['a1']);
	});

	it('an in-flight edit inside the debounce window survives a converge', async () => {
		const a = makeStore({ accounts: [{ id: 'a1', name: 'original' }] });
		const b = makeStore();
		await a.store.init();
		await b.store.init();
		const shared = versionedTarget();
		await a.store.attachTarget(shared.target, { strategy: 'replace-remote' });
		await b.store.attachTarget(shared.target, { strategy: 'merge' });

		// B renames and pushes: the remote now carries a newer clock for a1.
		await sleep(5); // distinct HLC wall-clock ms
		b.app.collections.accounts = [{ id: 'a1', name: 'renamed-by-B' }];
		await b.store.flush();

		// A edits the same record but has not saved yet (mid-debounce) when a
		// converge lands: stamp-before-merge must give the edit its rightful
		// (latest) clock, so it wins instead of losing to B's already-stamped write.
		await sleep(5);
		a.app.collections.accounts = [{ id: 'a1', name: 'in-flight-edit' }];
		await a.store.syncNow();
		expect((a.app.collections.accounts as { name: string }[])[0].name).toBe('in-flight-edit');
	});
});

describe('store.setEncryption', () => {
	it('adds then removes a password, rewriting the remote each time', async () => {
		const { store } = makeStore({ accounts: [{ id: 'a1', name: 'x' }] });
		const t = fakeTarget('drive');
		await store.attachTarget(t.target, { strategy: 'replace-remote' });

		expect(store.state.encrypted).toBe(false);
		expect((await inspect(t.remote!)).encryption).toBe('none');

		await store.setEncryption('a-very-strong-pass');
		expect(store.state.encrypted).toBe(true);
		expect((await inspect(t.remote!)).encryption).not.toBe('none');
		const dec = await importSnapshot(t.remote!, { password: 'a-very-strong-pass' });
		expect((dec.collections.accounts ?? []).length).toBe(1);

		await store.setEncryption(null);
		expect(store.state.encrypted).toBe(false);
		expect((await inspect(t.remote!)).encryption).toBe('none');
	});

	it('refuses without a connected target: a no-op must never pass for a rewrite', async () => {
		const { store } = makeStore();
		await expect(store.setEncryption('a-very-strong-pass')).rejects.toThrow('no destination');
		expect(store.state.encrypted).toBe(false);
	});

	it('commits the flag only when the rewrite LANDS: unreachable and failed writes roll back', async () => {
		const { store } = makeStore({ accounts: [{ id: 'a1' }] });
		let ready = true;
		let failSave = false;
		let remote: Blob | null = null;
		const target: BackupTarget = {
			kind: 'drive',
			label: 'Google Drive',
			async save(b) {
				if (failSave) throw new SelfstoreError('TARGET_WRITE_FAILED', 'boom');
				remote = b;
				return null;
			},
			async load() {
				return remote;
			},
			async isReady() {
				return ready;
			},
			async reconnect() {
				return true;
			},
			async disconnect() {}
		};
		await store.attachTarget(target, { strategy: 'replace-remote' });

		// Destination unreachable: the old code committed encrypted=true and let
		// the push defer - the store then expected a sealed file over a plaintext
		// remote, an unresolvable "unexpectedly unencrypted" wall after reload.
		ready = false;
		await expect(store.setEncryption('a-very-strong-pass')).rejects.toThrow('unreachable');
		expect(store.state.encrypted).toBe(false);
		expect((await inspect(remote!)).encryption).toBe('none');

		// Write failure mid-rewrite: same rollback, remote untouched.
		ready = true;
		failSave = true;
		await expect(store.setEncryption('a-very-strong-pass')).rejects.toThrow('boom');
		expect(store.state.encrypted).toBe(false);
		expect((await inspect(remote!)).encryption).toBe('none');

		// Back online: the same call now succeeds end to end.
		failSave = false;
		await store.setEncryption('a-very-strong-pass');
		expect(store.state.encrypted).toBe(true);
		expect((await inspect(remote!)).encryption).not.toBe('none');
	});
});

describe('store key slots (password envelope)', () => {
	it('adds a second password, revokes it, and guards the last slot + self-lock-out', async () => {
		const { store } = makeStore({ accounts: [{ id: 'a1' }] });
		const t = fakeTarget('drive');
		await store.attachTarget(t.target, { strategy: 'replace-remote' });

		// No password yet: there is nothing to add a key to.
		await expect(store.addEncryptionKey('guest-pw')).rejects.toThrow('no password yet');
		expect(store.listEncryptionKeys()).toEqual([]);

		await store.setEncryption('owner-pw');
		expect(store.listEncryptionKeys()).toHaveLength(1);

		// The new password opens the very bytes on the target; the old one still does.
		const id = await store.addEncryptionKey('guest-pw', 'guest');
		expect(id).toBe('guest');
		expect(store.listEncryptionKeys()).toHaveLength(2);
		const asOwner = await importSnapshot(t.remote!, { password: 'owner-pw' });
		expect(asOwner.collections.accounts).toEqual([{ id: 'a1' }]);
		const asGuest = await importSnapshot(t.remote!, { password: 'guest-pw' });
		expect(asGuest.collections.accounts).toEqual([{ id: 'a1' }]);

		// A duplicate id is refused (ids are how an app tracks slots).
		await expect(store.addEncryptionKey('other', 'guest')).rejects.toThrow('already exists');

		// Removing the slot OUR password opens would lock this session out.
		const own = store.listEncryptionKeys().find((s) => s.id !== 'guest')!;
		await expect(store.removeEncryptionKey(own.id)).rejects.toThrow('lock this session out');

		// Revoking the guest: their password stops opening, ours keeps working.
		await store.removeEncryptionKey('guest');
		expect(store.listEncryptionKeys()).toHaveLength(1);
		await expect(importSnapshot(t.remote!, { password: 'guest-pw' })).rejects.toMatchObject({
			code: 'DECRYPT_FAILED'
		});
		expect(
			(await importSnapshot(t.remote!, { password: 'owner-pw' })).collections.accounts
		).toEqual([{ id: 'a1' }]);

		// Unknown ids and the last slot are refused (decrypting is setEncryption(null)).
		await expect(store.removeEncryptionKey('nope')).rejects.toThrow('no key slot');
		await expect(store.removeEncryptionKey(own.id)).rejects.toThrow('last key');
	});

	it('a fresh session reading the file captures the slot table', async () => {
		const a = makeStore({ accounts: [{ id: 'a1' }] });
		const t = fakeTarget('drive');
		await a.store.attachTarget(t.target, { strategy: 'replace-remote' });
		await a.store.setEncryption('owner-pw');
		await a.store.addEncryptionKey('guest-pw', 'guest');

		// A second device attaches to the same file with the GUEST password: it can
		// read, rewrite (preserving the owner slot), and list both slots.
		const b = makeStore();
		await b.store.attachTarget(t.target, { password: 'guest-pw', strategy: 'replace-local' });
		expect(b.app.collections.accounts).toEqual([{ id: 'a1' }]);
		expect(b.store.listEncryptionKeys()).toHaveLength(2);

		b.app.collections.accounts = [{ id: 'a1' }, { id: 'a2' }];
		await b.store.syncNow();

		// The guest's write did not drop the owner's slot.
		const asOwner = await importSnapshot(t.remote!, { password: 'owner-pw' });
		expect(asOwner.collections.accounts).toHaveLength(2);
	});

	it('setEncryption rotates the data key: every old password stops opening', async () => {
		const { store } = makeStore({ accounts: [{ id: 'a1' }] });
		const t = fakeTarget('drive');
		await store.attachTarget(t.target, { strategy: 'replace-remote' });
		await store.setEncryption('owner-pw');
		await store.addEncryptionKey('guest-pw', 'guest');

		await store.setEncryption('rotated-pw');
		expect(store.listEncryptionKeys()).toHaveLength(1);
		expect(
			(await importSnapshot(t.remote!, { password: 'rotated-pw' })).collections.accounts
		).toEqual([{ id: 'a1' }]);
		await expect(importSnapshot(t.remote!, { password: 'owner-pw' })).rejects.toMatchObject({
			code: 'DECRYPT_FAILED'
		});
		await expect(importSnapshot(t.remote!, { password: 'guest-pw' })).rejects.toMatchObject({
			code: 'DECRYPT_FAILED'
		});
	});
});

describe('store.unlock / reconnect (attention split)', () => {
	it('unlock takes the password; reconnect is a no-op while locked', async () => {
		const { store, app } = makeStore({ accounts: [{ id: 'a1' }] });
		const t = fakeTarget('drive');
		await store.attachTarget(t.target, { password: 'right', strategy: 'replace-remote' });
		expect(store.state.locked).toBe(false);

		store.lock();
		expect(store.state.locked).toBe(true);
		expect(store.state.status.action).toBe('unlock'); // the status names the gesture

		// reconnect() is for a genuine auth loss, not a lock: it must not clear it.
		expect(await store.reconnect()).toBe(false);
		expect(store.state.locked).toBe(true);

		// A wrong password re-locks and keeps asking.
		expect(await store.unlock('wrong')).toBe(false);
		expect(store.state.locked).toBe(true);

		// The right password unlocks and the data is intact.
		expect(await store.unlock('right')).toBe(true);
		expect(store.state.locked).toBe(false);
		expect(app.collections.accounts).toEqual([{ id: 'a1' }]);
	});
});

describe('store external-key encryption (passkey-style, no typed password)', () => {
	const bytesOf = async (b: Blob) => new Uint8Array(await b.arrayBuffer());

	it('seals with a caller secret (no password) and lists it as an external slot', async () => {
		const { store } = makeStore({ accounts: [{ id: 'a1', name: 'x' }] });
		const t = fakeTarget('drive');
		await store.attachTarget(t.target, { strategy: 'replace-remote' });

		const secret = crypto.getRandomValues(new Uint8Array(32));
		await store.setExternalEncryption(secret, 'passkey:cred-1');
		expect(store.state.encrypted).toBe(true);

		// The remote is the authenticated envelope, opened by the secret alone.
		expect((await inspect(t.remote!)).encryption).not.toBe('none');
		const r = await readBoxWithSync(
			await bytesOf(t.remote!),
			undefined,
			undefined,
			undefined,
			async () => secret
		);
		expect((r.snapshot.collections.accounts ?? []).length).toBe(1);
		expect(r.format).toBe(3);

		// No password opens it - there is no password slot.
		await expect(importSnapshot(t.remote!, { password: 'anything' })).rejects.toMatchObject({
			code: 'DECRYPT_FAILED'
		});

		expect(store.listEncryptionKeys()).toEqual([{ id: expect.any(String), kind: 'external' }]);
	});

	it('a second device unlocks a locked external backup with the secret, not a password', async () => {
		const secret = crypto.getRandomValues(new Uint8Array(32));
		const a = makeStore({ accounts: [{ id: 'a1' }] });
		const t = fakeTarget('drive');
		await a.store.attachTarget(t.target, { strategy: 'replace-remote' });
		await a.store.setExternalEncryption(secret, 'passkey:cred-1');

		// Device B attaches with no key: encrypted file, so it locks (never clobbers).
		const b = makeStore({ accounts: [{ id: 'b-local' }] });
		await b.store.attachTarget(t.target, { strategy: 'merge' });
		expect(b.store.state.locked).toBe(true);
		expect(b.app.collections.accounts).toEqual([{ id: 'b-local' }]); // local kept

		// A wrong secret keeps it locked.
		expect(await b.store.unlockWithExternal(crypto.getRandomValues(new Uint8Array(32)))).toBe(
			false
		);
		expect(b.store.state.locked).toBe(true);

		// The right secret opens it: the remote data is now readable and merges in.
		expect(await b.store.unlockWithExternal(secret)).toBe(true);
		expect(b.store.state.locked).toBe(false);
		expect(b.app.collections.accounts).toContainEqual({ id: 'a1' }); // remote adopted
		expect(b.app.collections.accounts).toContainEqual({ id: 'b-local' }); // local merged in
	});

	it('adds an external key alongside a recovery password: either one opens the file', async () => {
		const { store } = makeStore({ accounts: [{ id: 'a1' }] });
		const t = fakeTarget('drive');
		await store.attachTarget(t.target, { strategy: 'replace-remote' });

		// A backup must be encrypted before an external key can join it.
		const secret = crypto.getRandomValues(new Uint8Array(32));
		await expect(store.addExternalKey(secret, 'passkey:cred-1')).rejects.toThrow(
			'not encrypted yet'
		);

		// Recovery password first, then the passkey secret as a second slot.
		await store.setEncryption('recovery-pw');
		const id = await store.addExternalKey(secret, 'passkey:cred-1', 'passkey');
		expect(id).toBe('passkey');
		expect(store.listEncryptionKeys()).toEqual([
			{ id: expect.any(String), kind: 'password' },
			{ id: 'passkey', kind: 'external' }
		]);

		// The recovery password still opens it; the secret opens it too.
		expect(
			(await importSnapshot(t.remote!, { password: 'recovery-pw' })).collections.accounts
		).toEqual([{ id: 'a1' }]);
		const r = await readBoxWithSync(
			await bytesOf(t.remote!),
			undefined,
			undefined,
			undefined,
			async () => secret
		);
		expect(r.snapshot.collections.accounts).toEqual([{ id: 'a1' }]);
	});

	it('lock() drops the external data key; unlockWithExternal re-opens it', async () => {
		const secret = crypto.getRandomValues(new Uint8Array(32));
		const { store, app } = makeStore({ accounts: [{ id: 'a1' }] });
		const t = fakeTarget('drive');
		await store.attachTarget(t.target, { strategy: 'replace-remote' });
		await store.setExternalEncryption(secret, 'passkey:cred-1');
		expect(store.state.locked).toBe(false);

		// Manual lock must drop the held data key even with no password in play.
		store.lock();
		expect(store.state.locked).toBe(true);

		// The passkey gesture re-derives it.
		expect(await store.unlockWithExternal(secret)).toBe(true);
		expect(store.state.locked).toBe(false);
		expect(app.collections.accounts).toEqual([{ id: 'a1' }]);
	});
});

describe('non-string id warning (data-loss footgun)', () => {
	it('warns once per collection, and states the fix, when records lack a string id', async () => {
		const warnings: string[] = [];
		const cache = memCache();
		const app = {
			collections: {
				todos: [
					{ id: 1, text: 'a' },
					{ id: 2, text: 'b' }
				], // numeric ids: unsyncable
				notes: [{ id: 'n1' }] // fine
			} as Record<string, unknown[]>
		};
		const store = createLocalStore({
			app: 'test',
			schemaVersion: 1,
			gather: () => ({ collections: structuredClone(app.collections), files: [] }),
			apply: (snap: Snapshot) => {
				app.collections = structuredClone(snap.collections ?? {});
			},
			cache,
			logger: { warn: (...a: unknown[]) => warnings.push(a.join(' ')), error: () => {} }
		});

		await store.init();
		await store.flush(); // persistLocal runs the check
		await store.flush(); // a second save must not re-warn the same collection

		const todo = warnings.filter((w) => w.includes('"todos"'));
		expect(todo).toHaveLength(1); // once, not per save
		expect(todo[0]).toContain('no string id');
		expect(todo[0]).toContain('yourIdField'); // the message states the corrective API
		expect(warnings.some((w) => w.includes('"notes"'))).toBe(false); // well-formed: silent
	});
});

describe('store.dispose', () => {
	it('cancels a pending debounced save so it never fires after teardown', async () => {
		const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
		const a = makeStore({ accounts: [{ id: 'a1' }] }, undefined, 20);
		await a.store.init();
		a.store.schedule(); // arm the debounce
		a.store.dispose(); // then tear down before it fires
		await sleep(50);
		expect(await a.cache.load()).toBeNull(); // the save never landed
	});

	it('drops subscribers so no notify reaches them after teardown', async () => {
		const a = makeStore();
		await a.store.init();
		let hits = 0;
		a.store.subscribe(() => hits++);
		a.store.dispose();
		await a.store.flush(); // would notify(saving) twice on a live store
		expect(hits).toBe(0);
	});
});

/** A target whose readiness and save outcome the test flips at will, to exercise
 *  the transient-vs-genuine-auth-loss classification the durable push depends on.
 *  An auth loss is signalled the way the auth layer does it: a thrown
 *  AuthExpiredError; anything else is a transient hiccup. */
type FailMode = 'ok' | 'transient-save' | 'auth-save' | 'not-ready' | 'not-ready-auth';
function controllableTarget() {
	let remote: Blob | null = null;
	let mode: FailMode = 'ok';
	const authErr = (): Error => new AuthExpiredError('session gone');
	const target: BackupTarget = {
		kind: 'drive',
		label: 'Google Drive',
		async save(b) {
			if (mode === 'transient-save') throw new Error('network reset');
			if (mode === 'auth-save') throw authErr();
			remote = b;
			return null;
		},
		async load() {
			return remote;
		},
		async stat() {
			return null;
		},
		async isReady() {
			if (mode === 'not-ready') return false;
			if (mode === 'not-ready-auth') throw authErr();
			return true;
		},
		async reconnect() {
			return true;
		},
		async disconnect() {}
	};
	return {
		target,
		setMode(m: FailMode) {
			mode = m;
		}
	};
}

describe('store durable-push failure classification', () => {
	// A mid-session save that fails: connect cleanly, then let a later flush() hit
	// the failing target (flush() only runs once init() has armed the store).
	async function connected(mode: FailMode) {
		const { store, app } = makeStore();
		await store.init();
		const t = controllableTarget();
		await store.attachTarget(t.target, { strategy: 'replace-remote' });
		expect(store.state.status.state).toBe('saved');
		t.setMode(mode);
		app.collections.accounts = [{ id: 'a1' }];
		await store.flush();
		return store;
	}

	it('a transient save failure keeps the connection - no reconnect gate', async () => {
		// The blocking gate must not open over a still-valid session: the edit is
		// safe in the local cache and the next save/sync retries.
		const store = await connected('transient-save');
		expect(store.state.status.state).toBe('saved');
	});

	it('a genuine auth loss on save opens the reconnect gate', async () => {
		const store = await connected('auth-save');
		expect(store.state.status.state).toBe('needs-attention');
	});

	it('the gated error carries a stable labelKey the app translates (not the raw message)', async () => {
		const store = await connected('auth-save');
		// The store is headless: it ships a code + a stable labelKey; the app owns
		// the copy. `message` is a developer detail, never for display.
		expect(store.state.lastError).toMatchObject({
			code: 'AUTH_EXPIRED',
			labelKey: errorLabelKey('AUTH_EXPIRED')
		});
		expect(store.state.lastError?.labelKey).toBe('error.authExpired');
		expect(typeof store.state.lastError?.message).toBe('string');
	});

	it('a transient not-ready skips the push without opening the gate', async () => {
		const store = await connected('not-ready');
		expect(store.state.status.state).not.toBe('needs-attention');
	});

	it('boot: a lost session opens the gate, a transient hiccup does not', async () => {
		const { mk } = rebootRig();

		// First session connects a drive target, so the cache remembers it.
		const t0 = controllableTarget();
		await mk(async () => t0.target).attachTarget(t0.target, { strategy: 'replace-remote' });

		// Reboot with a genuinely gone session: the gate must open.
		const tAuth = controllableTarget();
		tAuth.setMode('not-ready-auth');
		const sAuth = mk(async () => tAuth.target);
		await sAuth.init();
		expect(sAuth.state.status.state).toBe('needs-attention');

		// Reboot with a merely transient hiccup: stay connected, no gate.
		const tTrans = controllableTarget();
		tTrans.setMode('not-ready');
		const sTrans = mk(async () => tTrans.target);
		await sTrans.init();
		expect(sTrans.state.status.state).not.toBe('needs-attention');
	});
});

describe('store.inspectTarget', () => {
	it('a null blob reads as an empty destination', async () => {
		const { store } = makeStore();
		const t = fakeTarget('drive');

		expect(await store.inspectTarget(t.target)).toMatchObject({ hasBackup: false });
	});

	it('a read failure propagates, typed - it must never read as "no backup"', async () => {
		const { store } = makeStore();
		const t = fakeTarget('drive');
		t.target.load = async () => {
			throw new SelfstoreError('TARGET_UNAVAILABLE', 'flaky network');
		};

		await expect(store.inspectTarget(t.target)).rejects.toMatchObject({
			code: 'TARGET_UNAVAILABLE'
		});
	});

	it('an unreadable file propagates too, instead of inviting an overwrite', async () => {
		const { store } = makeStore();
		const t = fakeTarget('drive');
		t.target.load = async () => new Blob(['this is not a backup zip']);

		await expect(store.inspectTarget(t.target)).rejects.toMatchObject({ code: 'BAD_FORMAT' });
	});
});

describe('store.inspectTarget - empty files', () => {
	it('an EMPTY file reads as an empty destination (a just-created Drive file has zero bytes)', async () => {
		const { store } = makeStore();
		const t = fakeTarget('drive');
		t.target.load = async () => new Blob([]);

		expect(await store.inspectTarget(t.target)).toMatchObject({ hasBackup: false });
	});
});

describe('store save dedup (no redundant remote writes)', () => {
	it('skips a save with byte-identical content, but always writes a real edit', async () => {
		const { store, app } = makeStore({ accounts: [{ id: 'a1', name: 'X' }] });
		await store.init(); // flush runs only on an initialized store
		const t = fakeTarget('drive');
		let saves = 0;
		const realSave = t.target.save.bind(t.target);
		t.target.save = async (b) => {
			saves++;
			return realSave(b);
		};
		await store.attachTarget(t.target, { strategy: 'replace-remote' });

		// Baseline: the content is now on the remote and its fingerprint recorded.
		await store.flush();
		const base = saves;

		// A passive save with no content change (a reactive touch, a share link
		// created) must not re-upload the same bytes.
		await store.flush();
		expect(saves).toBe(base);

		// A genuine edit hashes differently and must reach the remote.
		(app.collections.accounts as { id: string; name: string }[]).push({ id: 'a2', name: 'Y' });
		await store.flush();
		expect(saves).toBe(base + 1);

		// No change again: skipped.
		await store.flush();
		expect(saves).toBe(base + 1);
	});

	// Seed a real .selfstore blob, then wrap it in a stat-capable target that
	// counts load() calls, so a test can prove connect fetches the file once.
	async function seededStatTarget(marker: () => string) {
		const seed = makeStore({ accounts: [{ id: 'a1', name: 'Seed' }] });
		await seed.store.init();
		const seedT = fakeTarget('drive');
		await seed.store.attachTarget(seedT.target, { strategy: 'replace-remote' });
		const blob = seedT.remote!;
		let loads = 0;
		const target: BackupTarget = {
			kind: 'drive',
			label: 'Google Drive',
			async save() {
				return marker();
			},
			async load() {
				loads++;
				return blob;
			},
			async stat() {
				return marker();
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
			get loads() {
				return loads;
			}
		};
	}

	it('connect fetches the backup once: attach reuses the blob inspect downloaded', async () => {
		const t = await seededStatTarget(() => 'v1'); // remote never moves
		const { store, app } = makeStore();
		await store.init();

		const info = await store.inspectTarget(t.target); // download #1
		expect(info.hasBackup).toBe(true);
		await store.attachTarget(t.target, { strategy: 'replace-local' }); // reuses #1
		expect(t.loads).toBe(1);
		expect(app.collections.accounts).toEqual([{ id: 'a1', name: 'Seed' }]);
	});

	it('connect re-downloads when the remote moved between inspect and attach', async () => {
		let version = 'v1';
		const t = await seededStatTarget(() => version);
		const { store } = makeStore();
		await store.init();

		await store.inspectTarget(t.target); // download #1, marker v1 captured
		version = 'v2'; // another device wrote in the meantime
		await store.attachTarget(t.target, { strategy: 'replace-local' }); // must not reuse a stale blob
		expect(t.loads).toBe(2);
	});

	it('a converge that only re-reads unchanged remote content pushes nothing back', async () => {
		const { store } = makeStore({ accounts: [{ id: 'a1', name: 'X' }] });
		await store.init();
		const t = fakeTarget('drive');
		let saves = 0;
		const realSave = t.target.save.bind(t.target);
		t.target.save = async (b) => {
			saves++;
			return realSave(b);
		};
		await store.attachTarget(t.target, { strategy: 'replace-remote' });
		await store.flush(); // content on the remote, fingerprint recorded
		saves = 0;

		// A manual converge loads the (unchanged) remote and merges it - a no-op.
		// The push-back leg must skip the byte-identical upload, not re-encrypt and
		// re-write the same blob (the "enregistrements inutiles" a user sees).
		await store.syncNow();
		expect(saves).toBe(0);
	});
});

describe('write-verified key operations and format refusals', () => {
	it('switching destination (replace-remote) seeds the new target - the old fingerprint does not suppress it', async () => {
		// Seed target A with content C; its digest becomes the fingerprint.
		const { store, app } = makeStore({ accounts: [{ id: 'a1', name: 'Mine' }] });
		await store.init();
		const A = fakeTarget('drive');
		await store.attachTarget(A.target, { strategy: 'replace-remote' });
		await store.flush();

		// Switch to an empty target B, this device's data wins (replace-remote).
		const B = fakeTarget('drive');
		let bSaves = 0;
		const realSave = B.target.save.bind(B.target);
		B.target.save = async (b) => {
			bSaves++;
			return realSave(b);
		};
		await store.attachTarget(B.target, { strategy: 'replace-remote' });

		// B must have received the seed (the fingerprint of A must not skip it, or B
		// stays empty and the next sync resurrects A's old backup into local).
		expect(bSaves).toBeGreaterThan(0);
		const onB = await importSnapshot(B.remote!);
		expect((onB.collections.accounts ?? []).length).toBe(1);
		void app;
	});

	it('a locked encrypted store refuses to write plaintext (export rejects)', async () => {
		const { store } = makeStore({ accounts: [{ id: 'a1' }] });
		await store.init();
		const t = fakeTarget('drive');
		await store.attachTarget(t.target, { password: 'pw', strategy: 'replace-remote' });
		store.lock();
		await expect(store.exportBlob()).rejects.toMatchObject({ code: 'PASSWORD_REQUIRED' });
	});

	it('attaching (merge) to a target already holding our content uploads nothing back (no ping-pong)', async () => {
		const A = makeStore({ accounts: [{ id: 'a1', name: 'X' }] });
		await A.store.init();
		const shared = fakeTarget('drive');
		await A.store.attachTarget(shared.target, { strategy: 'replace-remote' });

		let saves = 0;
		const realSave = shared.target.save.bind(shared.target);
		shared.target.save = async (b) => {
			saves++;
			return realSave(b);
		};

		const B = makeStore();
		await B.store.init();
		await B.store.attachTarget(shared.target, { strategy: 'merge' });
		expect(B.app.collections.accounts).toEqual([{ id: 'a1', name: 'X' }]);
		expect(saves).toBe(0); // the converge adopted the remote; nothing to push back
	});

	it('setEncryption raises the reconnect gate (not just throws) when the destination auth is lost', async () => {
		const { store } = makeStore({ accounts: [{ id: 'a1' }] });
		await store.init();
		const t = fakeTarget('drive');
		let authLost = false;
		t.target.isReady = async () => {
			if (authLost) throw new AuthExpiredError('gone');
			return true;
		};
		await store.attachTarget(t.target, { strategy: 'replace-remote' });

		authLost = true;
		await expect(store.setEncryption('pw')).rejects.toBeTruthy();
		// The store must read needs-attention, not a false "saved", after the loss.
		expect(store.state.status.state).toBe('needs-attention');
		expect(store.state.lastError?.code).toBe('AUTH_EXPIRED');
	});

	it('init survives a restoreTarget that throws (does not brick the store)', async () => {
		const cache = memCache();
		await cache.kv.set('targetKind', 'drive');
		const app = { collections: {} as Record<string, unknown[]> };
		const store = createLocalStore({
			app: 'test',
			schemaVersion: 1,
			gather: () => ({ collections: structuredClone(app.collections), files: [] }),
			apply: (s: Snapshot) => {
				app.collections = structuredClone(s.collections ?? {});
			},
			cache,
			restoreTarget: async () => {
				throw new Error('broker cold start');
			}
		});
		await store.init(); // must resolve, never reject
		expect(store.state.ready).toBe(true);
		expect(store.state.targetKind).toBe('drive'); // kept for a later reconnect, not demoted
	});

	it('refuses a backup rewritten under an unsupported format id', async () => {
		// A versioned target so a converge notices the swap and actually re-reads.
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
		const { store, app } = makeStore({ accounts: [{ id: 'a1' }] });
		await store.init();
		await store.attachTarget(target, { password: 'pw', strategy: 'replace-remote' });
		await store.flush();
		// The seed write is the authenticated envelope.
		expect((await inspect(remote!)).format).toBe(3);

		// A party with write access rewrites the backup under a format id the
		// reader does not accept: it copies the real key slot (so the password
		// would still open it) but drops the authenticated header that makes the
		// slot table tamper-evident. Same content, unsupported format, fresh
		// version marker.
		const decoded = await readBoxWithSync(new Uint8Array(await remote!.arrayBuffer()), 'pw');
		const enc = await gcmSealRaw(
			decoded.envelope!.dataKey,
			await pack(decoded.snapshot, decoded.sidecar)
		);
		const downgraded = {
			format: 4,
			app: 'test',
			createdAt: '2026-01-01T00:00:00.000Z',
			encryption: 'aes-256-gcm',
			keys: decoded.envelope!.slots,
			iv: enc.iv
		};
		remote = new Blob([
			zipSync({
				'meta.json': strToU8(JSON.stringify(downgraded)),
				'data.enc': enc.ciphertext,
				'LISEZMOI.txt': strToU8('x')
			}) as BlobPart
		]);
		version++;

		// The reader accepts only formats 1, 2 and 3, so the rewritten copy never
		// opens: the converge surfaces the refusal and the local data is never
		// clobbered by the tampered copy.
		await expect(store.syncNow()).rejects.toMatchObject({ code: 'UNSUPPORTED_VERSION' });
		expect(app.collections.accounts).toEqual([{ id: 'a1' }]);
	});
});

/** The reboot rig: a cache seeded with one collection, and a store factory
 *  that boots over it with the given session restore - the shape every
 *  "reboot with X" scenario shares. */
function rebootRig() {
	const cache = memCache();
	const app: { collections: Record<string, unknown[]> } = {
		collections: { accounts: [{ id: 'a1' }] }
	};
	const mk = (restore: () => Promise<BackupTarget | null>): ReturnType<typeof createLocalStore> =>
		createLocalStore({
			app: 'test',
			schemaVersion: 1,
			gather: () => ({ collections: structuredClone(app.collections), files: [] }),
			apply: (snap: Snapshot) => {
				app.collections = structuredClone((snap.collections ?? {}) as Record<string, unknown[]>);
			},
			cache,
			restoreTarget: restore
		});
	return { mk };
}

describe('store.init boot deadline', () => {
	// A mobile radio waking from sleep can suspend a network wait without ever
	// erroring: the boot used to hang behind "connecting..." until the user
	// reconnected by hand. Every network wait of init() is now bounded.
	it('a destination check that never settles cannot hang the boot', async () => {
		vi.useFakeTimers();
		try {
			const { mk } = rebootRig();

			// First session connects a drive target, so the cache remembers it.
			const t0 = controllableTarget();
			await mk(async () => t0.target).attachTarget(t0.target, { strategy: 'replace-remote' });

			// Reboot with a target whose readiness check NEVER settles.
			const frozen: BackupTarget = {
				...t0.target,
				isReady: () => new Promise<boolean>(() => {})
			};
			const s = mk(async () => frozen);
			const boot = s.init();
			await vi.advanceTimersByTimeAsync(30_000);
			await boot;

			expect(s.state.ready).toBe(true);
			// A stall is not an auth verdict: stay connected, no reconnect gate.
			expect(s.state.status.state).not.toBe('needs-attention');
			expect(s.state.targetKind).toBe('drive');
		} finally {
			vi.useRealTimers();
		}
	});

	it('a boot pull that never settles cannot hang the boot either', async () => {
		vi.useFakeTimers();
		try {
			const { mk } = rebootRig();

			const t0 = controllableTarget();
			await mk(async () => t0.target).attachTarget(t0.target, { strategy: 'replace-remote' });

			// Ready answers, but the download never does.
			const stalled: BackupTarget = {
				...t0.target,
				async isReady() {
					return true;
				},
				load: () => new Promise<Blob | null>(() => {})
			};
			const s = mk(async () => stalled);
			const boot = s.init();
			await vi.advanceTimersByTimeAsync(30_000);
			await boot;

			expect(s.state.ready).toBe(true);
			expect(s.state.targetKind).toBe('drive');
		} finally {
			vi.useRealTimers();
		}
	});
});
