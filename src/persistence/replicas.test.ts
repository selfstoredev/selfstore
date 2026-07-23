// Replicas: secondary synced copies of the store under its OWN key. Unlike a
// mirror (re-keyed for a reader), a replica gets the same bytes as the primary
// home, so any device can later attach it as its primary with the same
// password. Failures land on the replica's own state and never gate the store.

import { describe, it, expect, afterEach } from 'vitest';
import { createLocalStore, type LocalStore, type LocalStoreOptions } from './store';
import { memoryCache } from './cache';
import type { BackupTarget } from './target';
import { importSnapshot, inspect, type Snapshot } from '../selfstore';

function memTarget(kind: string) {
	let remote: Blob | null = null;
	let version = 0;
	let failWith: Error | null = null;
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
		fail(e: Error | null) {
			failWith = e;
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
