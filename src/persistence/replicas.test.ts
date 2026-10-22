// Replicas: secondary synced copies of the store under its OWN key. Unlike a
// mirror (re-keyed for a reader), a replica gets the same bytes as the primary
// home, so any device can later attach it as its primary with the same
// password. Failures land on the replica's own state and never gate the store.

import { describe, it, expect, afterEach } from 'vitest';
import { createLocalStore, type LocalStore, type LocalStoreOptions } from './store';
import { memoryCache, type LocalCache } from './cache';
import type { BackupTarget } from './target';
import { importSnapshot, inspect, type Snapshot } from '../selfstore';

function memTarget(kind: string) {
	let remote: Blob | null = null;
	let version = 0;
	let failWith: Error | null = null;
	let statFailWith: Error | null = null;
	const target: BackupTarget = {
		kind,
		label: kind,
		async save(b) {
			if (failWith) throw failWith;
			remote = b;
			version++;
			return String(version);
		},
		async load() {
			return remote;
		},
		async stat() {
			if (statFailWith) throw statFailWith;
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
	return {
		target,
		get remote() {
			return remote;
		},
		get version() {
			return version;
		},
		fail(e: Error | null) {
			failWith = e;
		},
		failStat(e: Error | null) {
			statFailWith = e;
		}
	};
}

let seq = 0;
const open: LocalStore[] = [];
afterEach(() => {
	for (const s of open.splice(0)) s.dispose();
});

async function makeStore(
	initial: Record<string, unknown[]>,
	extra: Partial<LocalStoreOptions> = {}
) {
	const state = { collections: structuredClone(initial) };
	const store = createLocalStore({
		app: `replicas-${++seq}`,
		schemaVersion: 1,
		gather: () => ({ collections: structuredClone(state.collections), files: [] }),
		apply: (snap: Snapshot) => {
			state.collections = structuredClone(snap.collections ?? {});
		},
		cache: memoryCache(),
		logger: { warn() {}, error() {} },
		...extra
	});
	open.push(store);
	return { store, state };
}

async function until(pred: () => boolean, ms = 4000): Promise<void> {
	const t0 = Date.now();
	while (!pred()) {
		if (Date.now() - t0 > ms) throw new Error('until: timed out');
		await new Promise((r) => setTimeout(r, 15));
	}
}

describe('replicas: secondary synced copies', () => {
	it('publishes the same-key backup on attach and follows every edit', async () => {
		const primary = memTarget('drive');
		const { store, state } = await makeStore({ notes: [{ id: 'n1', body: 'one' }] });
		await store.init();
		await store.attachTarget(primary.target, { strategy: 'replace-remote' });

		const replica = memTarget('s3');
		store.attachReplica(replica.target);
		await until(() => replica.remote !== null);

		// The replica holds the current state, readable with no password (the store
		// is plaintext here, same as the primary).
		expect((await importSnapshot(replica.remote!)).collections.notes).toHaveLength(1);
		expect(store.state.replicas).toHaveLength(1);
		expect(store.state.replicas[0].lastPublishAt).not.toBeNull();

		// A later edit reaches the replica too.
		const before = replica.remote;
		(state.collections.notes as unknown[]).push({ id: 'n2', body: 'two' });
		store.schedule();
		await store.flush();
		await until(() => replica.remote !== before);
		expect((await importSnapshot(replica.remote!)).collections.notes).toHaveLength(2);
	});

	it('carries the store password so the replica opens with it (a real backup)', async () => {
		const primary = memTarget('drive');
		const { store } = await makeStore({ notes: [{ id: 'n1', body: 'secret' }] });
		await store.init();
		await store.attachTarget(primary.target, { strategy: 'replace-remote', password: 'pw-123' });

		const replica = memTarget('s3');
		store.attachReplica(replica.target);
		await until(() => replica.remote !== null);

		expect((await inspect(replica.remote!)).encryption).not.toBe('none');
		const snap = await importSnapshot(replica.remote!, { password: 'pw-123' });
		expect((snap.collections.notes as { body: string }[])[0].body).toBe('secret');
	});

	it('a broken replica is recorded but never gates the store', async () => {
		const primary = memTarget('drive');
		const { store } = await makeStore({ notes: [{ id: 'n1', body: 'one' }] });
		await store.init();
		await store.attachTarget(primary.target, { strategy: 'replace-remote' });

		const replica = memTarget('s3');
		replica.fail(new Error('network down'));
		store.attachReplica(replica.target);

		await until(() => store.state.replicas[0]?.lastError !== null);
		expect(store.state.replicas[0].lastError).not.toBeNull();
		expect(store.state.locked).toBe(false);
		expect(store.state.status.severity).not.toBe('error'); // store itself stays healthy
		expect(replica.remote).toBeNull();
	});

	it('detachReplica stops publishing and drops it from state', async () => {
		const primary = memTarget('drive');
		const { store } = await makeStore({ notes: [{ id: 'n1', body: 'one' }] });
		await store.init();
		await store.attachTarget(primary.target, { strategy: 'replace-remote' });

		const replica = memTarget('s3');
		const id = store.attachReplica(replica.target);
		await until(() => replica.remote !== null);
		store.detachReplica(id);
		expect(store.state.replicas).toHaveLength(0);
	});
});

describe('a key change reaches every copy, and a failed write never loses one', () => {
	const opens = async (blob: Blob, password: string) =>
		importSnapshot(blob, { password }).then(
			() => true,
			() => false
		);

	it('re-keys the replicas with the primary when the password changes', async () => {
		const primary = memTarget('drive');
		const { store } = await makeStore({ notes: [{ id: 'n1', body: 'one' }] });
		await store.init();
		await store.attachTarget(primary.target, { strategy: 'replace-remote', password: 'old-pw-1' });
		const replica = memTarget('s3');
		store.attachReplica(replica.target);
		await until(() => replica.remote !== null);

		await store.setEncryption('new-pw-2');

		expect(await opens(replica.remote!, 'new-pw-2')).toBe(true);
		expect(await opens(replica.remote!, 'old-pw-1')).toBe(false);
	});

	it('a removed key stops opening the replica too', async () => {
		const primary = memTarget('drive');
		const { store } = await makeStore({ notes: [{ id: 'n1', body: 'one' }] });
		await store.init();
		await store.attachTarget(primary.target, { strategy: 'replace-remote', password: 'main-pw-1' });
		const shareId = await store.addEncryptionKey('share-pw-2');
		const replica = memTarget('s3');
		store.attachReplica(replica.target);
		await until(() => replica.remote !== null);
		expect(await opens(replica.remote!, 'share-pw-2')).toBe(true);

		await store.removeEncryptionKey(shareId);

		expect(await opens(replica.remote!, 'share-pw-2')).toBe(false);
		expect(await opens(replica.remote!, 'main-pw-1')).toBe(true);
	});

	it('keeps the new key when only the bookkeeping after the write fails', async () => {
		const base = memoryCache();
		let refuseEnc = false;
		const cache: LocalCache = {
			...base,
			kv: {
				...base.kv,
				async set(key, value) {
					if (refuseEnc && key === 'enc') throw new Error('quota exceeded');
					return base.kv.set(key, value);
				}
			}
		};
		const primary = memTarget('drive');
		const { store } = await makeStore({ notes: [{ id: 'n1', body: 'one' }] }, { cache });
		await store.init();
		await store.attachTarget(primary.target, { strategy: 'replace-remote', password: 'old-pw-1' });

		refuseEnc = true;
		await store.setEncryption('new-pw-2');
		refuseEnc = false;

		// The file is under the new key, so the store must still write under it.
		await store.addEncryptionKey('extra-pw-3');
		expect(await opens(primary.remote!, 'new-pw-2')).toBe(true);
		expect(await opens(primary.remote!, 'old-pw-1')).toBe(false);
	});

	it('defers a push when the destination cannot say whether it moved', async () => {
		const primary = memTarget('drive');
		const { store, state } = await makeStore({ notes: [{ id: 'n1', body: 'one' }] });
		await store.init();
		await store.attachTarget(primary.target, { strategy: 'replace-remote' });
		const before = primary.version;

		primary.failStat(new Error('HEAD 503'));
		(state.collections.notes as unknown[]).push({ id: 'n2', body: 'two' });
		store.schedule();
		await store.flush();
		expect(primary.version).toBe(before);
		await expect(store.setEncryption('any-pw-1')).rejects.toMatchObject({
			code: 'TARGET_WRITE_FAILED'
		});
		expect(primary.version).toBe(before);

		primary.failStat(null);
		store.schedule();
		await store.flush();
		expect((await importSnapshot(primary.remote!)).collections.notes).toHaveLength(2);
	});

	it('refuses to switch away while an edit cannot reach the home it leaves', async () => {
		const other = await makeStore({ notes: [{ id: 's1', body: 'shared' }] }, { app: 'switch' });
		await other.store.init();
		const shared = memTarget('drive');
		await other.store.attachTarget(shared.target, { strategy: 'replace-remote' });

		const { store, state } = await makeStore(
			{ notes: [{ id: 'p1', body: 'mine' }] },
			{ app: 'switch' }
		);
		await store.init();
		const personal = memTarget('drive');
		await store.attachTarget(personal.target, { strategy: 'replace-remote' });

		personal.fail(new Error('offline'));
		(state.collections.notes as unknown[]).push({ id: 'p2', body: 'unsaved' });
		await expect(
			store.attachTarget(shared.target, { strategy: 'replace-local', keepSession: true })
		).rejects.toMatchObject({ code: 'TARGET_WRITE_FAILED' });
		expect(state.collections.notes).toHaveLength(2);
		expect(store.state.targetKind).toBe('drive');

		personal.fail(null);
		await store.attachTarget(shared.target, { strategy: 'replace-local', keepSession: true });
		expect((await importSnapshot(personal.remote!)).collections.notes).toHaveLength(2);
		expect(state.collections.notes).toEqual([{ id: 's1', body: 'shared' }]);
	});
});
