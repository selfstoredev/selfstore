// @vitest-environment node
/**
 * The multi-backup manager against an in-memory destination: registry
 * bookkeeping (self-heal, prune-on-gone, joined/owner stamps), the per-file
 * encrypted/shared memories, and the isolation invariants of every gesture -
 * fixed-id targets, active-id committed only after a successful attach, wipe
 * on switch, blank starts. Needs native WebCrypto for the encrypted-file
 * cases, hence node env.
 */
import { describe, expect, it } from 'vitest';
import { createLocalStore, type LocalStore } from '../persistence/store';
import { memoryCache, type KV } from '../persistence/cache';
import type { BackupTarget } from '../persistence/target';
import { backup, restore } from '../selfstore';
import { createBackupsManager, type BackupsHost, type BackupsManager } from './manager';

const ACTIVE_KEY = 'test:activeFileId';

/** In-memory destination: files by id, list order = newest first (insertion
 *  reversed), plus switches to fake session refusal and owner lookups. */
class World {
	files = new Map<
		string,
		{ name: string; blob: Blob | null; modifiedTime: string | null; foreign?: boolean }
	>();
	nextId = 1;
	refuseSession = false;
	disconnects = 0;

	add(name: string, blob: Blob | null = null, modifiedTime: string | null = null): string {
		const id = `f${this.nextId++}`;
		this.files.set(id, { name, blob, modifiedTime, foreign: false });
		return id;
	}

	/** Another account's file: reachable by id (it was shared with us) but
	 *  absent from the own-files listing, like a real destination. */
	addForeign(name: string, blob: Blob | null = null): string {
		const id = `f${this.nextId++}`;
		this.files.set(id, { name, blob, modifiedTime: null, foreign: true });
		return id;
	}

	host(overrides: Partial<BackupsHost> = {}): BackupsHost {
		const world = this;
		return {
			kind: 'mem',
			activeIdKey: ACTIVE_KEY,
			async list() {
				return [...world.files.entries()]
					.reverse()
					.filter(([, f]) => !f.foreign)
					.map(([id, f]) => ({ id, name: f.name, modifiedTime: f.modifiedTime }));
			},
			open(fileId: string): BackupTarget {
				return {
					kind: 'mem',
					label: fileId,
					async save(blob) {
						const f = world.files.get(fileId);
						if (!f) throw new Error('gone');
						f.blob = blob;
						return null;
					},
					async load() {
						return world.files.get(fileId)?.blob ?? null;
					},
					async stat() {
						return world.files.has(fileId)
							? String(world.files.get(fileId)!.blob?.size ?? 0)
							: null;
					},
					async isReady() {
						return world.files.has(fileId);
					},
					async reconnect() {
						return true;
					},
					async disconnect() {
						world.disconnects++; // a real target would forget its credentials here
					}
				};
			},
			async create(fileName: string) {
				if ([...world.files.values()].some((f) => f.name === fileName)) {
					throw new Error('name taken');
				}
				return { fileId: world.add(fileName) };
			},
			async remove(fileId: string) {
				world.files.delete(fileId);
			},
			async rename(fileId: string, fileName: string) {
				const f = world.files.get(fileId);
				if (!f) throw new Error('gone');
				if ([...world.files.entries()].some(([id, o]) => id !== fileId && o.name === fileName)) {
					throw new Error('name taken');
				}
				f.name = fileName;
			},
			async findOrCreatePersonal() {
				if (world.refuseSession) return null;
				const hit = [...world.files.entries()].find(([, f]) => f.name === 'App.zip');
				if (hit) return { fileId: hit[0], created: false };
				return { fileId: world.add('App.zip'), created: true };
			},
			async ensureSession() {
				return !world.refuseSession;
			},
			...overrides
		};
	}
}

interface AppState {
	notes: { id: string }[];
}

function makeStore(app: string): { store: LocalStore; kv: KV; appState: AppState } {
	const cache = memoryCache();
	const appState: AppState = { notes: [] };
	const store = createLocalStore({
		app,
		schemaVersion: 1,
		cache,
		sync: { fallback: 'lww-set' },
		gather: () => ({ collections: { notes: [...appState.notes] }, files: [] }),
		apply: (snap) => {
			appState.notes = (snap.collections.notes ?? []) as { id: string }[];
		},
		logger: { warn() {}, error() {} }
	});
	return { store, kv: cache.kv, appState };
}

async function manager(
	world: World,
	opts: { hostOverrides?: Partial<BackupsHost>; name?: string } = {}
): Promise<{ m: BackupsManager; store: LocalStore; kv: KV; appState: AppState }> {
	const { store, kv, appState } = makeStore(
		opts.name ?? `backups-${Math.floor(Math.random() * 1e9)}`
	);
	await store.init();
	const m = createBackupsManager({
		store,
		kv,
		host: world.host(opts.hostOverrides),
		naming: { canonicalName: 'App.zip' }
	});
	return { m, store, kv, appState };
}

/** A real encrypted backup blob, as a protected file on the destination. */
async function encryptedBlob(password: string): Promise<Blob> {
	return backup({ collections: { notes: [{ id: 'n1', secret: true }] }, files: [] })
		.as('backups-test')
		.encryptedWith(password)
		.toBlob();
}

async function plainBlob(): Promise<Blob> {
	return backup({ collections: { notes: [{ id: 'n1' }] }, files: [] })
		.as('backups-test')
		.toBlob();
}

describe('naming', () => {
	it('derives named files from the canonical name and parses labels back', async () => {
		const world = new World();
		const { m } = await manager(world);
		expect(m.fileNameFor(' family ')).toBe('App (family).zip');
		world.add('App.zip');
		world.add('App (family).zip');
		world.add('app-share-123.bin'); // internal file: not a backup name
		const rows = await m.list();
		expect(rows.map((r) => [r.name, r.label])).toEqual(
			[
				['app-share-123.bin', undefined],
				['App (family).zip', 'family'],
				['App.zip', null]
			].filter(([, label]) => label !== undefined)
		);
	});
});

describe('open', () => {
	it('opens a plain backup, commits the active id AFTER the attach, stamps the registry', async () => {
		const world = new World();
		const id = world.add('App.zip', await plainBlob());
		const { m, store, kv } = await manager(world);
		expect(await m.openBackup(id)).toBe('ok');
		expect(await kv.get(ACTIVE_KEY)).toBe(id);
		expect(store.state.targetKind).toBe('mem');
		expect(m.snapshot.registry.personalFileId).toBe(id);
		expect(m.snapshot.joined).toBe(false);
	});

	it('two-steps an encrypted backup: "encrypted" without a passphrase, open with it', async () => {
		const world = new World();
		const id = world.add('App.zip', await encryptedBlob('pw'));
		const { m, kv } = await manager(world);
		expect(await m.openBackup(id)).toBe('encrypted');
		// Nothing attached, nothing committed on the first leg.
		expect(await kv.get(ACTIVE_KEY)).toBeUndefined();
		expect(await m.openBackup(id, 'pw')).toBe('ok');
		expect(await kv.get(ACTIVE_KEY)).toBe(id);
		// The encrypted bit was learned and decorates the listing.
		const rows = await m.list();
		expect(rows.find((r) => r.fileId === id)?.encrypted).toBe(true);
	});

	it('prunes a GONE file from the registry and reports the gone code', async () => {
		const world = new World();
		const id = world.add('App.zip', await plainBlob());
		const { m } = await manager(world);
		await m.openBackup(id);
		const other = world.add('App (family).zip', await plainBlob());
		await m.openBackup(other);
		world.files.delete(id);
		// The stale personal entry survives in the registry until the failed open.
		await m.refresh();
		expect(m.snapshot.registry.personalFileId).toBe(id);
		expect(await m.openBackup(id)).toBe('failed');
		expect(m.snapshot.lastError).toBe('gone');
		expect(m.snapshot.registry.personalFileId).toBeNull();
	});

	it('aborts as cancelled when the session hook refuses', async () => {
		const world = new World();
		const id = world.add('App.zip', await plainBlob());
		world.refuseSession = true;
		const { m, kv } = await manager(world);
		expect(await m.openBackup(id)).toBe('failed');
		expect(m.snapshot.lastError).toBe('cancelled');
		expect(await kv.get(ACTIVE_KEY)).toBeUndefined();
	});

	it('openPersonal adopts an existing file and starts a missing one blank', async () => {
		const world = new World();
		const { m: m1, kv: kv1, store: s1 } = await manager(world);
		expect(await m1.openPersonal()).toBe('ok');
		const created = [...world.files.entries()].find(([, f]) => f.name === 'App.zip');
		expect(created).toBeDefined();
		expect(await kv1.get(ACTIVE_KEY)).toBe(created![0]);
		expect(s1.state.targetKind).toBe('mem');

		// A second device with data on the file: adopt, not clobber.
		const { m: m2 } = await manager(world);
		expect(await m2.openPersonal()).toBe('ok');
		expect(m2.snapshot.registry.personalFileId).toBe(created![0]);
	});
});

describe('create / rename / delete', () => {
	it('creates a named backup that starts BLANK (nothing carried from the open one)', async () => {
		const world = new World();
		const personal = world.add('App.zip', await plainBlob());
		const { m, appState } = await manager(world);
		await m.openBackup(personal);
		expect(appState.notes).toHaveLength(1);
		expect(await m.createNamed('family')).toBe('ok');
		// The new file is active and the working set is empty - an isolated
		// snapshot, never seeded from the previous file.
		expect(appState.notes).toHaveLength(0);
		const rows = await m.list();
		const fam = rows.find((r) => r.label === 'family');
		expect(fam).toBeDefined();
		expect(fam?.encrypted).toBe(false); // fresh backups start unprotected, remembered
		// The personal file's content is untouched.
		expect(world.files.get(personal)?.blob).not.toBeNull();
	});

	it('refuses a create when the destination already carries the name', async () => {
		const world = new World();
		world.add('App (family).zip');
		const { m } = await manager(world);
		expect(await m.createNamed('family')).toBe('failed');
		expect(m.snapshot.lastError).toBe('failed');
	});

	it('renames in place (id unchanged) and refuses a taken name', async () => {
		const world = new World();
		const a = world.add('App (a).zip');
		world.add('App (b).zip');
		const { m } = await manager(world);
		expect(await m.renameBackup(a, 'c')).toBe('ok');
		expect(world.files.get(a)?.name).toBe('App (c).zip');
		expect(await m.renameBackup(a, 'b')).toBe('failed');
		expect(world.files.get(a)?.name).toBe('App (c).zip');
	});

	it('deleting the ACTIVE file detaches first, then removes and cleans the registry', async () => {
		const world = new World();
		const id = world.add('App.zip', await plainBlob());
		const { m, store, appState } = await manager(world);
		await m.openBackup(id);
		expect(store.state.targetKind).toBe('mem');
		expect(await m.deleteBackup(id)).toBe(true);
		expect(store.state.targetKind).toBe('device');
		expect(world.files.has(id)).toBe(false);
		expect(m.snapshot.activeFileId).toBeNull();
		expect(m.snapshot.registry.personalFileId).toBeNull();
		// Local data survives the delete (the app went device-only).
		expect(appState.notes).toHaveLength(1);
	});

	it('deleting the ACTIVE file keeps the destination session - the remove needs it', async () => {
		const world = new World();
		const id = world.add('App.zip', await plainBlob());
		const { m, kv } = await manager(world);
		await m.openBackup(id);
		expect(await m.deleteBackup(id)).toBe(true);
		// The detach must not run the target's disconnect: on a real destination
		// that forgets the credentials, and the remove (and any create right
		// after) still needs them. Deleting a file is not logging out.
		expect(world.disconnects).toBe(0);
		expect(world.files.has(id)).toBe(false);
		// The remembered id is cleared all the same: nothing dangles on a
		// deleted file.
		expect(await kv.get(ACTIVE_KEY)).toBeUndefined();
	});

	it('after deleting the protected ACTIVE backup, a new backup starts unprotected', async () => {
		const world = new World();
		const id = world.add('App.zip', await encryptedBlob('pw'));
		const { m, store } = await manager(world);
		expect(await m.openBackup(id, 'pw')).toBe('ok');
		expect(store.state.encrypted).toBe(true);
		expect(await m.deleteBackup(id)).toBe(true);

		// "No file left, nothing locked": the fresh backup carries no trace of
		// the deleted one's protection - not the flag, not the lock, and the
		// bytes on the destination are a plain container.
		expect(await m.createNamed('fresh')).toBe('ok');
		expect(store.state.locked).toBe(false);
		expect(store.state.encrypted).toBe(false);
		await store.flush();
		const fresh = [...world.files.values()].find((f) => f.name === 'App (fresh).zip');
		expect(fresh?.blob).toBeTruthy();
		expect(await restore(fresh!.blob!).isEncrypted()).toBe(false);
	});
});

describe('registry and memories', () => {
	it('markActive stamps joined + owner for a non-personal file and clears them back', async () => {
		const world = new World();
		const mine = world.add('App.zip', await plainBlob());
		const theirs = world.addForeign('Their.zip', await plainBlob()); // another account's file
		const owner = { email: 'other@example.com', name: 'Other' };
		const { m, kv } = await manager(world, {
			hostOverrides: { fileOwner: async () => owner }
		});
		await m.openBackup(mine);
		expect(m.snapshot.joined).toBe(false);
		// The app attached the other file through some join path; it marks it.
		await kv.set(ACTIVE_KEY, theirs);
		await m.markActive(theirs);
		expect(m.snapshot.joined).toBe(true);
		expect(m.snapshot.owner).toEqual(owner);
		expect(m.snapshot.registry.shared[0]?.fileId).toBe(theirs);
		expect(m.snapshot.registry.shared[0]?.ownerEmail).toBe('other@example.com');
		// Back on the personal file: the flags clear.
		await kv.set(ACTIVE_KEY, mine);
		await m.markActive(mine);
		expect(m.snapshot.joined).toBe(false);
		expect(m.snapshot.owner).toBeNull();
		// hydrate() reads the same truth back from the kv on the next boot.
		await m.hydrate();
		expect(m.snapshot.joined).toBe(false);
	});

	it('self-heals excluded ids (a sharing engine copy) out of the registry', async () => {
		const world = new World();
		const copy = world.add('copy.bin');
		const { m, kv, store } = await manager(world, {
			hostOverrides: { excludedFileIds: async () => [copy] }
		});
		await kv.set('selfstore:backups:registry:v1', {
			personalFileId: copy,
			shared: [{ fileId: copy, ownerEmail: null, ownerName: null }]
		});
		await m.refresh();
		expect(m.snapshot.registry.personalFileId).toBeNull();
		expect(m.snapshot.registry.shared).toEqual([]);
		void store;
	});

	it('remembers the shared bit per file and decorates the listing', async () => {
		const world = new World();
		const id = world.add('App.zip', await plainBlob());
		const { m } = await manager(world);
		await m.noteShared(id, true);
		let rows = await m.list();
		expect(rows.find((r) => r.fileId === id)?.shared).toBe(true);
		await m.noteShared(id, false);
		rows = await m.list();
		expect(rows.find((r) => r.fileId === id)?.shared).toBe(false);
	});

	it('probes encryption without opening and remembers the answer', async () => {
		const world = new World();
		const id = world.add('App (x).zip', await encryptedBlob('pw'));
		const { m } = await manager(world);
		expect((await m.list()).find((r) => r.fileId === id)?.encrypted).toBeNull();
		expect(await m.probeEncryption(id)).toBe(true);
		expect((await m.list()).find((r) => r.fileId === id)?.encrypted).toBe(true);
	});

	it('forgetShared drops a registry entry without touching the file', async () => {
		const world = new World();
		const mine = world.add('App.zip', await plainBlob());
		const theirs = world.addForeign('Their.zip', await plainBlob());
		const { m, kv } = await manager(world, {
			hostOverrides: { fileOwner: async () => ({ email: 'x@y.z', name: null }) }
		});
		await m.openBackup(mine); // the store must be ON the managed kind
		await kv.set(ACTIVE_KEY, theirs);
		await m.markActive(theirs);
		expect(m.snapshot.registry.shared).toHaveLength(1);
		await m.forgetShared(theirs);
		expect(m.snapshot.registry.shared).toEqual([]);
		expect(world.files.has(theirs)).toBe(true);
	});
});

describe('joined shared wallet', () => {
	it("registerShared labels a file as the sharer's; markActive then reads it as joined", async () => {
		const world = new World();
		// A file on MY OWN account, named OUTSIDE the own convention (a joined
		// portfolio's dedicated wallet): registered shared, it presents as the
		// sharer's - never resolved through fileOwner, never filed as mine.
		const id = world.add('Recu de ana - App.zip', await plainBlob());
		const { m } = await manager(world);
		await m.registerShared(id, { email: 'ana@x.fr', name: null });
		await m.hydrate();
		expect(m.snapshot.registry.shared).toEqual([
			{ fileId: id, ownerEmail: 'ana@x.fr', ownerName: null }
		]);
		await m.openBackup(id);
		expect(m.snapshot.joined).toBe(true);
		expect(m.snapshot.owner?.email).toBe('ana@x.fr');
		expect(m.snapshot.registry.personalFileId).not.toBe(id);
	});

	it('createShared attaches a BLANK joined wallet, filed under shared, and the host stages its content', async () => {
		const world = new World();
		const { m, store, appState } = await manager(world);
		appState.notes.push({ id: 'mine-1' }); // whatever silo was loaded before
		expect(await m.createShared('Recu de ana - App.zip', { email: 'ana@x.fr', name: null })).toBe(
			'ok'
		);
		// Blank start: the previous silo's data never crosses into the joined wallet.
		expect(appState.notes).toEqual([]);
		const snap = m.snapshot;
		expect(snap.joined).toBe(true);
		expect(snap.owner?.email).toBe('ana@x.fr');
		expect(snap.registry.personalFileId).toBeNull();
		expect(snap.registry.shared.map((s) => s.fileId)).toContain(snap.activeFileId);
		// Named outside the own convention: the own list never shows it.
		expect((await m.list()).map((r) => r.fileId)).not.toContain(snap.activeFileId);
		// The host stages the shared projection and saves: the wallet holds it.
		appState.notes.push({ id: 'shared-1' });
		await store.flush();
		const blob = world.files.get(snap.activeFileId!)!.blob!;
		expect(blob).not.toBeNull();
		const back = await restore(blob).read();
		expect((back.collections.notes as { id: string }[]).map((n) => n.id)).toEqual(['shared-1']);
	});
});
