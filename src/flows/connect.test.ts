/**
 * connectFlow: every rule here is a production lesson. The test names say the
 * rule; the fixtures replay the situation that used to break it.
 */

import { describe, it, expect } from 'vitest';
import { createLocalStore } from '../persistence/store';
import type { CachedFile, KV, LocalCache } from '../persistence/cache';
import type { BackupTarget } from '../persistence/target';
import { backup, importSnapshot, type Snapshot } from '../selfstore';
import { selfstore } from '../simple/simple';
import { connectFlow, type FlowHost } from './connect';
import type { FlowStore } from './machine';

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
		async saveFiles(list) {
			files.clear();
			for (const f of list) files.set(f.id, f);
		},
		async clear() {
			kvMap.clear();
			collections = undefined;
			files.clear();
		}
	};
}

function fakeTarget(initialRemote: Blob | null = null) {
	let remote = initialRemote;
	let loads = 0;
	const target: BackupTarget = {
		kind: 'drive',
		label: 'Fake Drive',
		async save(b) {
			remote = b;
			return null;
		},
		async load() {
			loads++;
			return remote;
		},
		async isReady() {
			return true;
		},
		async reconnect() {
			return true;
		},
		async disconnect() {
			/* nothing to forget */
		}
	};
	return {
		target,
		get remote() {
			return remote;
		},
		get loads() {
			return loads;
		}
	};
}

/** An app + engine + host, mirroring how the simple store wires the flow. */
function makeHost(initial: Record<string, unknown[]> = {}) {
	const app = { collections: structuredClone(initial) };
	const cache = memCache();
	const engine = createLocalStore({
		app: 'flow-test',
		schemaVersion: 1,
		gather: (): Snapshot => ({ collections: structuredClone(app.collections), files: [] }),
		apply: (snap: Snapshot) => {
			app.collections = structuredClone(snap.collections ?? {}) as Record<string, unknown[]>;
		},
		cache
	});
	const host: FlowHost = { engine, kv: cache.kv, backupName: 'flow-test.zip' };
	return { app, engine, host };
}

async function until<T>(flow: FlowStore<T>, pred: (s: T) => boolean, ms = 3000): Promise<T> {
	if (pred(flow.snapshot)) return flow.snapshot;
	return new Promise<T>((resolve, reject) => {
		let unsub: (() => void) | null = null;
		const timer = setTimeout(() => {
			unsub?.();
			reject(new Error(`until: timed out on ${JSON.stringify(flow.snapshot)}`));
		}, ms);
		unsub = flow.subscribe((s) => {
			if (!pred(s)) return;
			clearTimeout(timer);
			unsub?.();
			resolve(s);
		});
	});
}

function deferred<T>() {
	let resolve!: (v: T) => void;
	let reject!: (e: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

const snapOf = (collections: Record<string, unknown[]>): Snapshot => ({
	collections: collections as Snapshot['collections'],
	files: []
});

/** A remote already written by ANOTHER device's store (carries sync meta, so
 *  a 'merge' attach unions with it instead of adopting it wholesale). */
async function seedRemote(collections: Record<string, unknown[]>) {
	const t = fakeTarget();
	const seeder = makeHost(collections);
	await seeder.engine.init();
	await seeder.engine.attachTarget(t.target, { strategy: 'replace-remote' });
	await seeder.engine.flush();
	seeder.engine.dispose();
	return t;
}

describe('connectFlow: choosing and cancelling', () => {
	it('offers exactly the destinations it was given, in the order it wrote them', () => {
		const { host } = makeHost();
		const flow = connectFlow(host, { webdav: true, drive: async () => null });
		expect(flow.snapshot.kinds).toEqual(['webdav', 'drive']);
		expect(flow.snapshot.step).toBe('choose');
	});

	it('a cancelled popup or picker returns to choose, silently - cancel is not an error', async () => {
		const { host, engine } = makeHost();
		const flow = connectFlow(host, { drive: async () => null });
		flow.choose('drive');
		expect(flow.snapshot.step).toBe('authorizing');
		const s = await until(flow, (x) => x.step === 'choose');
		expect(s.error).toBeNull();
		expect(engine.state.targetKind).toBe('device');
	});

	it('one popup per gesture: choose is ignored while a leg is in flight', async () => {
		const { host } = makeHost();
		let opened = 0;
		const gate = deferred<BackupTarget | null>();
		const flow = connectFlow(host, {
			drive: () => {
				opened++;
				return gate.promise;
			}
		});
		flow.choose('drive');
		flow.choose('drive'); // double-click
		gate.resolve(null);
		await until(flow, (x) => x.step === 'choose');
		expect(opened).toBe(1);
	});

	it('cancel abandons the journey and a late resolution cannot resurrect it', async () => {
		const { host, engine } = makeHost();
		const gate = deferred<BackupTarget | null>();
		const t = fakeTarget();
		const flow = connectFlow(host, { drive: () => gate.promise });
		flow.choose('drive');
		flow.cancel();
		expect(flow.snapshot.step).toBe('choose');
		gate.resolve(t.target); // the popup finally answered - too late
		await new Promise((r) => setTimeout(r, 30));
		expect(flow.snapshot.step).toBe('choose');
		expect(engine.state.targetKind).toBe('device');
	});
});

describe('connectFlow: fresh and existing destinations', () => {
	it('an empty destination starts from this device (its data becomes the backup)', async () => {
		const { host, engine } = makeHost({ todos: [{ id: 't1', text: 'ship it' }] });
		await engine.init();
		const t = fakeTarget();
		const flow = connectFlow(host, { drive: async () => t.target });
		flow.choose('drive');
		const s = await until(flow, (x) => x.step === 'connected');
		expect(s.outcome).toBe('started');
		expect(engine.state.targetKind).toBe('drive');
		const remote = await importSnapshot(t.remote!);
		expect(remote.collections?.todos).toEqual([{ id: 't1', text: 'ship it' }]);
	});

	it('an existing plain backup merges by default - nothing asked, nothing lost', async () => {
		const t = await seedRemote({ todos: [{ id: 'a', text: 'from-backup' }] });
		const { host, engine, app } = makeHost({ todos: [{ id: 'b', text: 'local' }] });
		await engine.init();
		await engine.flush(); // the engine folds what it knows: register the local data
		const flow = connectFlow(host, { drive: async () => t.target });
		flow.choose('drive');
		const s = await until(flow, (x) => x.step === 'connected');
		expect(s.outcome).toBe('merged');
		const ids = (app.collections.todos as { id: string }[]).map((x) => x.id).sort();
		expect(ids).toEqual(['a', 'b']); // both sides survived
	});

	it('a connector failure is a retryable error, and retry returns to choose', async () => {
		const { host } = makeHost();
		const flow = connectFlow(host, {
			drive: async () => {
				throw new Error('boom');
			}
		});
		flow.choose('drive');
		const s = await until(flow, (x) => x.step === 'error');
		expect(s.error?.code).toBe('TARGET_UNAVAILABLE'); // unknown throws read as transient
		expect(s.error?.labelKey).toBe('error.targetUnavailable');
		flow.retry();
		expect(flow.snapshot.step).toBe('choose');
	});

	it('a destination that never answers surfaces as a retryable error, not a frozen spinner', async () => {
		const { host, engine } = makeHost();
		const never = new Promise<Blob | null>(() => undefined);
		const t = fakeTarget();
		t.target.load = () => never;
		const flow = connectFlow(host, { drive: async () => t.target }, { deadlineMs: 30 });
		flow.choose('drive');
		const s = await until(flow, (x) => x.step === 'error');
		expect(s.error?.code).toBe('TARGET_UNAVAILABLE');
		expect(engine.state.targetKind).toBe('device'); // nothing attached
	});
});

describe('connectFlow: the default resolution', () => {
	it("defaultResolution 'resume' adopts an existing backup without asking", async () => {
		const t = await seedRemote({ todos: [{ id: 'a', text: 'from-backup' }] });
		const { host, engine, app } = makeHost({ todos: [{ id: 'b', text: 'local' }] });
		await engine.init();
		await engine.flush();
		const flow = connectFlow(
			host,
			{ drive: async () => t.target },
			{ defaultResolution: 'resume' }
		);
		flow.choose('drive');
		const s = await until(flow, (x) => x.step === 'connected');
		expect(s.outcome).toBe('resumed'); // no conflict step on the way
		expect(app.collections.todos).toEqual([{ id: 'a', text: 'from-backup' }]); // the backup won
		expect(engine.state.targetKind).toBe('drive');
	});

	it('the conflict step, when raised, still outranks the default resolution', async () => {
		const t = await seedRemote({ todos: [{ id: 'a', text: 'from-backup' }] });
		const { host, engine } = makeHost({ todos: [{ id: 'b', text: 'local' }] });
		await engine.init();
		const flow = connectFlow(
			host,
			{ drive: async () => t.target },
			{ hasLocalData: () => true, defaultResolution: 'resume' }
		);
		flow.choose('drive');
		const s = await until(flow, (x) => x.step === 'conflict');
		expect(s.hasBackup).toBe(true); // the question is asked, not auto-answered
	});

	it('an empty destination is not concerned: this device still starts it', async () => {
		const { host, engine } = makeHost({ todos: [{ id: 't1', text: 'ship it' }] });
		await engine.init();
		const t = fakeTarget();
		const flow = connectFlow(
			host,
			{ drive: async () => t.target },
			{ defaultResolution: 'resume' }
		);
		flow.choose('drive');
		const s = await until(flow, (x) => x.step === 'connected');
		expect(s.outcome).toBe('started');
		expect(engine.state.targetKind).toBe('drive');
	});
});

describe('connectFlow: the password step', () => {
	const encryptedBackup = () =>
		backup(snapOf({ todos: [{ id: 'a', text: 'secret' }] }))
			.as('flow-test')
			.encryptedWith('right')
			.toBlob();

	it('an encrypted backup asks BEFORE anything attaches', async () => {
		const { host, engine } = makeHost();
		await engine.init();
		const t = fakeTarget(await encryptedBackup());
		const flow = connectFlow(host, { drive: async () => t.target });
		flow.choose('drive');
		const s = await until(flow, (x) => x.step === 'password');
		expect(s.encrypted).toBe(true);
		expect(engine.state.targetKind).toBe('device'); // store untouched
	});

	it('a wrong password stays on the step, says so, and still attaches nothing', async () => {
		const { host, engine, app } = makeHost();
		await engine.init();
		const t = fakeTarget(await encryptedBackup());
		const flow = connectFlow(host, { drive: async () => t.target });
		flow.choose('drive');
		await until(flow, (x) => x.step === 'password');

		flow.submitPassword('wrong');
		const s = await until(flow, (x) => x.passwordError);
		expect(s.step).toBe('password'); // retype, not a gate, not an error page
		expect(engine.state.targetKind).toBe('device');

		flow.submitPassword('right');
		const done = await until(flow, (x) => x.step === 'connected');
		expect(done.outcome).toBe('merged');
		expect(app.collections.todos).toEqual([{ id: 'a', text: 'secret' }]);
	});

	it('cancel from the password step wipes the journey back to choose', async () => {
		const { host, engine } = makeHost();
		await engine.init();
		const t = fakeTarget(await encryptedBackup());
		const flow = connectFlow(host, { drive: async () => t.target });
		flow.choose('drive');
		await until(flow, (x) => x.step === 'password');
		flow.cancel();
		expect(flow.snapshot.step).toBe('choose');
		expect(engine.state.targetKind).toBe('device');
	});

	it('overwrite: a forgotten password starts BLANK over the protected backup', async () => {
		const { host, engine, app } = makeHost({ todos: [{ id: 'b', text: 'local' }] });
		await engine.init();
		await engine.flush(); // this device holds data - which overwrite must not carry over
		const t = fakeTarget(await encryptedBackup());
		const flow = connectFlow(host, { drive: async () => t.target });
		flow.choose('drive');
		await until(flow, (x) => x.step === 'password');

		flow.overwrite();
		const done = await until(flow, (x) => x.step === 'connected');
		expect(done.outcome).toBe('replaced');
		expect(engine.state.targetKind).toBe('drive');
		// wipe: local is emptied and the remote holds a blank backup - the forgotten
		// encrypted backup is gone, and this device's old data is not pushed in its
		// place (it starts fresh, and the write stays tiny).
		expect(app.collections.todos ?? []).toEqual([]);
		const remote = await importSnapshot(t.remote!);
		expect(remote.collections?.todos ?? []).toEqual([]);
	});

	it('overwrite does nothing outside the password step', async () => {
		const { host, engine } = makeHost();
		await engine.init();
		const t = fakeTarget(await encryptedBackup());
		const flow = connectFlow(host, { drive: async () => t.target });
		// Before choosing, there is no target to overwrite: the call is inert.
		flow.overwrite();
		expect(flow.snapshot.step).toBe('choose');
		expect(engine.state.targetKind).toBe('device');
	});

	it('deferUnlock: an encrypted backup is adopted LOCKED, no password step', async () => {
		const { host, engine, app } = makeHost();
		await engine.init();
		const steps: string[] = [];
		const t = fakeTarget(await encryptedBackup());
		const flow = connectFlow(host, { drive: async () => t.target }, { deferUnlock: true });
		flow.subscribe((s) => steps.push(s.step));
		flow.choose('drive');
		const done = await until(flow, (x) => x.step === 'connected');
		expect(done.outcome).toBe('resumed');
		expect(steps).not.toContain('password'); // the step never raised
		expect(engine.state.targetKind).toBe('drive');
		expect(engine.state.locked).toBe(true); // adopted as-is, nothing readable
		expect(app.collections.todos ?? []).toEqual([]); // and nothing clobbered
		// The host's own surface unlocks it: the backup is intact underneath.
		expect(await engine.unlock('right')).toBe(true);
		expect(engine.state.locked).toBe(false);
		expect(app.collections.todos).toEqual([{ id: 'a', text: 'secret' }]);
	});

	it('deferUnlock leaves a plain backup journey untouched', async () => {
		const { host, engine } = makeHost();
		await engine.init();
		const t = fakeTarget(
			await backup(snapOf({ todos: [{ id: 'a', text: 'plain' }] }))
				.as('flow-test')
				.toBlob()
		);
		const flow = connectFlow(host, { drive: async () => t.target }, { deferUnlock: true });
		flow.choose('drive');
		const done = await until(flow, (x) => x.step === 'connected');
		expect(done.outcome).toBe('merged'); // the usual default, no adoption forced
		expect(engine.state.locked).toBe(false);
	});
});

describe('connectFlow: the conflict step', () => {
	const remoteBackup = () =>
		backup(snapOf({ todos: [{ id: 'a', text: 'from-backup' }] }))
			.as('flow-test')
			.toBlob();

	it('appears only when the app declared local data worth asking about', async () => {
		const { host, engine } = makeHost({ todos: [{ id: 'b', text: 'local' }] });
		await engine.init();
		const t = fakeTarget(await remoteBackup());
		const flow = connectFlow(host, { drive: async () => t.target }, { hasLocalData: () => true });
		flow.choose('drive');
		const s = await until(flow, (x) => x.step === 'conflict');
		expect(s.hasBackup).toBe(true);
		expect(engine.state.targetKind).toBe('device'); // still nothing attached
	});

	it('resume: the backup wins, this device adopts it', async () => {
		const { host, app, engine } = makeHost({ todos: [{ id: 'b', text: 'local' }] });
		await engine.init();
		const t = fakeTarget(await remoteBackup());
		const flow = connectFlow(host, { drive: async () => t.target }, { hasLocalData: () => true });
		flow.choose('drive');
		await until(flow, (x) => x.step === 'conflict');
		flow.resolveConflict('resume');
		const s = await until(flow, (x) => x.step === 'connected');
		expect(s.outcome).toBe('resumed');
		expect(app.collections.todos).toEqual([{ id: 'a', text: 'from-backup' }]);
	});

	it('replace: this device wins, the backup is overwritten', async () => {
		const { host, engine } = makeHost({ todos: [{ id: 'b', text: 'local' }] });
		await engine.init();
		const t = fakeTarget(await remoteBackup());
		const flow = connectFlow(host, { drive: async () => t.target }, { hasLocalData: () => true });
		flow.choose('drive');
		await until(flow, (x) => x.step === 'conflict');
		flow.resolveConflict('replace');
		const s = await until(flow, (x) => x.step === 'connected');
		expect(s.outcome).toBe('replaced');
		const remote = await importSnapshot(t.remote!);
		expect(remote.collections?.todos).toEqual([{ id: 'b', text: 'local' }]);
	});

	it('merge from the conflict step folds both sides', async () => {
		const { host, app, engine } = makeHost({ todos: [{ id: 'b', text: 'local' }] });
		await engine.init();
		await engine.flush();
		const t = await seedRemote({ todos: [{ id: 'a', text: 'from-backup' }] });
		const flow = connectFlow(host, { drive: async () => t.target }, { hasLocalData: () => true });
		flow.choose('drive');
		await until(flow, (x) => x.step === 'conflict');
		flow.resolveConflict('merge');
		const s = await until(flow, (x) => x.step === 'connected');
		expect(s.outcome).toBe('merged');
		const ids = (app.collections.todos as { id: string }[]).map((x) => x.id).sort();
		expect(ids).toEqual(['a', 'b']);
	});

	it('without the declaration, an existing backup merges without asking', async () => {
		const { host, engine, app } = makeHost({ todos: [{ id: 'b', text: 'local' }] });
		await engine.init();
		await engine.flush();
		const t = await seedRemote({ todos: [{ id: 'a', text: 'from-backup' }] });
		const flow = connectFlow(host, { drive: async () => t.target });
		flow.choose('drive');
		const s = await until(flow, (x) => x.step === 'connected');
		expect(s.outcome).toBe('merged');
		const ids = (app.collections.todos as { id: string }[]).map((x) => x.id).sort();
		expect(ids).toEqual(['a', 'b']);
	});
});

describe('connectFlow: degraded and form modes', () => {
	it('webdav offered without a config goes through the form step', () => {
		const { host } = makeHost();
		const flow = connectFlow(host, { webdav: true });
		flow.choose('webdav');
		expect(flow.snapshot.step).toBe('form');
		flow.cancel();
		expect(flow.snapshot.step).toBe('choose');
	});

	it('s3 offered without a config goes through the form step', () => {
		const { host } = makeHost();
		const flow = connectFlow(host, { s3: true, drive: async () => null });
		expect(flow.snapshot.kinds).toContain('s3');
		flow.choose('s3');
		expect(flow.snapshot.step).toBe('form');
		expect(flow.snapshot.kind).toBe('s3');
		flow.cancel();
		expect(flow.snapshot.step).toBe('choose');
	});

	it('an s3 connector runs the same journey to connected', async () => {
		const { host, engine } = makeHost();
		await engine.init();
		const t = fakeTarget();
		const flow = connectFlow(host, { s3: async () => t.target });
		flow.choose('s3');
		const s = await until(flow, (x) => x.step === 'connected');
		expect(s.outcome).toBe('started');
		expect(engine.state.targetKind).not.toBe('device');
	});

	it('the file picker degrades to manual download where the API is missing', async () => {
		const { host, engine } = makeHost();
		await engine.init();
		const flow = connectFlow(host, { file: true }); // Node has no showSaveFilePicker
		flow.choose('file');
		const s = await until(flow, (x) => x.step === 'connected');
		expect(s.outcome).toBe('manual');
		expect(engine.state.targetKind).toBe('file-manual');
	});
});

describe('connectFlow: from the simple store', () => {
	it('drives the facade end to end through store.flowHost', async () => {
		const store = await selfstore('flow-facade', { cache: memCache() });
		await store.put('todos', { id: 't1', text: 'hello' });
		const t = fakeTarget();
		const flow = connectFlow(store, { drive: async () => t.target });
		flow.choose('drive');
		const s = await until(flow, (x) => x.step === 'connected');
		expect(s.outcome).toBe('started');
		await store.flush();
		const remote = await importSnapshot(t.remote!);
		expect(remote.collections?.todos).toEqual([{ id: 't1', text: 'hello' }]);
		store.dispose();
	});
});
