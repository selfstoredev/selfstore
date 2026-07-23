// @vitest-environment node
// The backup-copy journey: attach a second destination receiving the primary's
// exact bytes, survive a reboot through the scoped kv record, and never let a
// broken copy gate the store. Custom connectors keep the unit offline; the
// drive restore path is proven against the real fromSession with fetch stubbed.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { createLocalStore, type LocalStore } from '../persistence/store';
import { memoryCache } from '../persistence/cache';
import type { BackupTarget } from '../persistence/target';
import { importSnapshot, type Snapshot } from '../selfstore';
import { replicaFlow, REPLICA_ID } from './replica';
import { FILE_ID_KEY } from '../persistence/targets/drive';

function memTarget(kind = 'mem') {
	let remote: Blob | null = null;
	let failWith: Error | null = null;
	let disconnected = 0;
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
	vi.unstubAllGlobals();
});

async function makeHost(initial: Record<string, unknown[]>) {
	const state = { collections: structuredClone(initial) };
	const cache = memoryCache();
	const store = createLocalStore({
		app: `replica-flow-${++seq}`,
		schemaVersion: 1,
		gather: () => ({ collections: structuredClone(state.collections), files: [] }),
		apply: (snap: Snapshot) => {
			state.collections = structuredClone(snap.collections ?? {});
		},
		cache,
		logger: { warn() {}, error() {} }
	});
	open.push(store);
	await store.init();
	return {
		store,
		state,
		kv: cache.kv,
		host: { engine: store, kv: cache.kv, backupName: 'App.zip' }
	};
}

async function until(pred: () => boolean, ms = 4000): Promise<void> {
	const t0 = Date.now();
	while (!pred()) {
		if (Date.now() - t0 > ms) throw new Error('until: timed out');
		await new Promise((r) => setTimeout(r, 15));
	}
}

describe('replicaFlow', () => {
	it('attaches through a connector, publishes the primary bytes and records the kind', async () => {
		const { store, kv, host } = await makeHost({ notes: [{ id: 'n1', text: 'hello' }] });
		const t = memTarget();
		const flow = replicaFlow(host, { file: async () => t.target });

		expect(flow.snapshot.step).toBe('idle');
		expect(flow.snapshot.kinds).toEqual(['file']);
		flow.open();
		expect(flow.snapshot.step).toBe('choose');
		flow.pick('file');
		await until(() => t.remote !== null);

		expect(flow.snapshot.step).toBe('idle');
		expect(flow.snapshot.error).toBeNull();
		expect(store.state.replicas.map((r) => r.id)).toEqual([REPLICA_ID]);
		const snap = await importSnapshot(t.remote!);
		expect(snap.collections.notes).toEqual([{ id: 'n1', text: 'hello' }]);
		expect(await kv.get('replica:record')).toEqual({ kind: 'file' });
		flow.dispose();
	});

	it('a cancelled connector leaves everything as it was - no error, no record', async () => {
		const { store, kv, host } = await makeHost({});
		const flow = replicaFlow(host, { file: async () => null });
		flow.open();
		flow.pick('file');
		await until(() => !flow.snapshot.busy);
		expect(flow.snapshot.step).toBe('choose');
		expect(flow.snapshot.error).toBeNull();
		expect(store.state.replicas).toEqual([]);
		expect(await kv.get('replica:record')).toBeUndefined();
		flow.dispose();
	});

	it('a throwing connector surfaces a StoreError and attaches nothing', async () => {
		const { store, kv, host } = await makeHost({});
		const flow = replicaFlow(host, {
			file: async () => {
				throw new Error('picker exploded');
			}
		});
		flow.open();
		flow.pick('file');
		await until(() => flow.snapshot.error !== null);
		expect(flow.snapshot.error?.code).toBe('TARGET_UNAVAILABLE');
		expect(store.state.replicas).toEqual([]);
		expect(await kv.get('replica:record')).toBeUndefined();
		flow.dispose();
	});

	it("webdav/s3 declared as 'true' route to their form step; cancel returns to idle", async () => {
		const { host } = await makeHost({});
		const flow = replicaFlow(host, { webdav: true, s3: true });
		flow.open();
		flow.pick('webdav');
		expect(flow.snapshot.step).toBe('form-webdav');
		flow.cancel();
		expect(flow.snapshot.step).toBe('idle');
		flow.open();
		flow.pick('s3');
		expect(flow.snapshot.step).toBe('form-s3');
		flow.cancel();
		flow.dispose();
	});

	it('remove() detaches, forgets the record and lets the target forget its session', async () => {
		const { store, kv, host } = await makeHost({ notes: [{ id: 'n1' }] });
		const t = memTarget();
		const flow = replicaFlow(host, { file: async () => t.target });
		flow.open();
		flow.pick('file');
		await until(() => store.state.replicas.length === 1);

		await flow.remove();
		expect(store.state.replicas).toEqual([]);
		expect(await kv.get('replica:record')).toBeUndefined();
		expect(t.disconnected).toBe(1);
		expect(flow.snapshot.replica).toBeNull();
		flow.dispose();
	});

	it('restore() rebuilds a custom kind only through the restoreTarget hook', async () => {
		const { store, kv, host } = await makeHost({ notes: [{ id: 'n1' }] });
		await kv.set('replica:record', { kind: 'file' });

		// No hook: a custom connector cannot be rebuilt silently - the record stays.
		const blind = replicaFlow(host, { file: async () => null });
		await blind.restore();
		expect(store.state.replicas).toEqual([]);
		expect(await kv.get('replica:record')).toEqual({ kind: 'file' });
		blind.dispose();

		const t = memTarget();
		const flow = replicaFlow(
			host,
			{ file: async () => null },
			{ restoreTarget: async () => t.target }
		);
		await flow.restore();
		expect(store.state.replicas.map((r) => r.id)).toEqual([REPLICA_ID]);
		expect(flow.snapshot.replica?.id).toBe(REPLICA_ID);
		flow.dispose();
	});

	it('restore() rebuilds a drive copy from its scoped session, no network at build', async () => {
		vi.stubGlobal('fetch', () => Promise.reject(new Error('offline')));
		const { store, kv, host } = await makeHost({ notes: [{ id: 'n1' }] });
		await kv.set('replica:record', { kind: 'drive' });
		await kv.set(`replica:${FILE_ID_KEY}`, 'file-123');

		const auth = { token: async () => 't', reconnect: async () => true, forget: async () => {} };
		const flow = replicaFlow(host, { drive: auth });
		await flow.restore();
		expect(store.state.replicas.map((r) => r.id)).toEqual([REPLICA_ID]);
		flow.dispose();
	});
});
