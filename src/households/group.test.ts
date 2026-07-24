// @vitest-environment node
/**
 * END-TO-END PROOF of the capability-link household share, MIRROR MODEL: the
 * admin shares a link, a visitor opens it and joins, and both converge
 * read-write while every wallet file stays exactly what its owner chose -
 * plaintext, never re-keyed, never re-attached. Each member publishes a
 * dedicated copy (a selfstore mirror sealed under the link key K) and folds
 * the others' copies as keyed peers. Possession of K is membership.
 *
 * The backend is a tiny in-memory "world": copy files (real selfstore
 * encrypted blobs the mirrors write), plain-object bulletins (the crypto layer
 * is selfstore's own concern, covered elsewhere) and an announce mailbox.
 * Everything about join/roster/peer-folding is the production engine path.
 * Needs native WebCrypto, hence node env.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createLocalStore, type LocalStore } from '../persistence/store';
import { memoryCache, type KV } from '../persistence/cache';
import type { BackupTarget, PeerSource } from '../persistence/target';
import { importSnapshot, isEncrypted, type Snapshot } from '../selfstore';
import { createHouseholdGroup, HOUSEHOLD_GROUP_KEY, type ShareBackend } from './group';
import { decodeAnnounce, encodeAnnounce, type CopyLink, type SharePayload } from './codec';

// --- The in-memory world ----------------------------------------------------

/** Every file in the world (wallets and copies alike): the latest blob, plus a
 *  version tag stat() reads to skip unchanged files. */
interface Slot {
	blob: Blob | null;
	tag: number;
}

class World {
	files = new Map<string, Slot>();
	/** fileId -> the bulletin's control record (null = revoked). */
	bulletins = new Map<string, SharePayload | null>();
	mailbox = new Map<string, string[]>();
	private seq = 0;
	newId(prefix: string): string {
		return `${prefix}-${++this.seq}`;
	}
	slot(fileId: string): Slot {
		if (!this.files.has(fileId)) this.files.set(fileId, { blob: null, tag: 0 });
		return this.files.get(fileId)!;
	}
	target(fileId: string): BackupTarget {
		const slot = this.slot(fileId);
		return {
			kind: 'mem',
			label: fileId,
			async save(blob) {
				slot.blob = blob;
				slot.tag += 1;
				return String(slot.tag);
			},
			async load() {
				return slot.blob;
			},
			async stat() {
				return slot.blob ? String(slot.tag) : null;
			},
			async isReady() {
				return true;
			},
			async reconnect() {
				return true;
			},
			async disconnect() {}
		};
	}
}

function memKV(): KV {
	const m = new Map<string, unknown>();
	return {
		async get<T = unknown>(k: string) {
			return m.get(k) as T | undefined;
		},
		async set(k, v) {
			m.set(k, v);
		},
		async del(k) {
			m.delete(k);
		}
	};
}

/** A ShareBackend over the shared world, bound to one member's email. The v3
 *  contract: copies are dedicated files (createCopy mints one), handed to the
 *  store as mirror targets (copyTarget), never adopted as the wallet. */
function makeBackend(world: World, email: string): ShareBackend {
	let myBulletinId: string | null = null;
	let joined: { fileId: string; key: string } | null = null;

	return {
		async createCopy(existingFileId?: string) {
			const fileId = existingFileId ?? world.newId('copy');
			world.slot(fileId);
			return { provider: 'drive', fileId, ownerEmail: email } satisfies CopyLink;
		},
		copyTarget(fileId) {
			return world.target(fileId);
		},
		async dropCopy(fileId) {
			world.files.delete(fileId);
		},
		async publishBulletin(key, payload) {
			myBulletinId ??= world.newId('bulletin');
			world.bulletins.set(myBulletinId, payload);
			return { fileId: myBulletinId, key };
		},
		async revokeBulletin() {
			if (myBulletinId) world.bulletins.set(myBulletinId, null);
		},
		async openIncoming(fileId, key) {
			const share = world.bulletins.get(fileId);
			if (!share) return null;
			joined = { fileId, key };
			return { projection: {}, share };
		},
		async takeStashedIncoming() {
			if (!joined) return null;
			const share = world.bulletins.get(joined.fileId);
			if (!share) return null;
			return { key: joined.key, fileId: joined.fileId, content: { projection: {}, share } };
		},
		async rereadJoined(fileId) {
			return world.bulletins.get(fileId) ?? null;
		},
		async announce(mailboxId, copy) {
			world.mailbox.set(mailboxId, [
				...(world.mailbox.get(mailboxId) ?? []),
				encodeAnnounce({ v: 1, copy })
			]);
		},
		async takeAnnounces(mailboxId) {
			const parked = world.mailbox.get(mailboxId) ?? [];
			world.mailbox.set(mailboxId, []);
			return parked.map((c) => decodeAnnounce(c).copy);
		},
		peerSource(link): PeerSource {
			return {
				label: link.fileId,
				async load() {
					return world.files.get(link.fileId)?.blob ?? null;
				},
				async stat() {
					const slot = world.files.get(link.fileId);
					return slot?.blob ? String(slot.tag) : null;
				}
			};
		}
	};
}

// --- Test members -----------------------------------------------------------

interface Rec {
	id: string;
}
interface AppState {
	records: Rec[];
}

const open: LocalStore[] = [];
afterEach(() => {
	for (const s of open.splice(0)) s.dispose();
});

function makeStore(app: string) {
	const state: AppState = { records: [] };
	const store = createLocalStore({
		app,
		schemaVersion: 1,
		cache: memoryCache(),
		sync: { fallback: 'lww-set' },
		gather: (): Snapshot => ({ collections: { records: [...state.records] }, files: [] }),
		apply: (snap: Snapshot) => {
			state.records = (snap.collections.records ?? []) as Rec[];
		},
		logger: { warn() {}, error() {} }
	});
	open.push(store);
	return { state, store };
}

/** A member: their own store, connected to their own wallet file in the world
 *  (plaintext unless a password is given), plus the group engine over it. */
async function makeMember(
	world: World,
	email: string,
	app: string,
	walletId: string,
	password?: string
) {
	const { state, store } = makeStore(app);
	await store.init();
	await store.attachTarget(world.target(walletId), { strategy: 'replace-remote', password });
	const kv = memKV();
	const group = createHouseholdGroup({ store, kv, backend: makeBackend(world, email) });
	return { state, store, group, kv, walletId };
}

const ids = (rows: Rec[]): string[] => rows.map((r) => r.id).sort();

describe('capability-link household share (mirror model)', () => {
	it('admin and joiner converge READ-WRITE while both wallets stay PLAINTEXT', async () => {
		const world = new World();
		const admin = await makeMember(world, 'admin@x.fr', 'hh-admin', 'admin-wallet');
		const bob = await makeMember(world, 'bob@x.fr', 'hh-bob', 'bob-wallet');

		admin.state.records.push({ id: 'a1' });
		await admin.store.flush();
		const link = await admin.group.startShare();
		expect(admin.group.state.isAdmin).toBe(true);
		expect(admin.group.state.memberCount).toBe(1);
		// The copy is a dedicated file: never the wallet itself.
		const adminCopy = admin.group.state.selfFileId!;
		expect(adminCopy).not.toBe('admin-wallet');

		// Bob opens the link (read-only preview), then joins.
		bob.state.records.push({ id: 'b1' });
		await bob.store.flush();
		expect(await bob.group.openIncoming(link.fileId, link.key)).not.toBeNull();
		expect(await bob.group.join()).toBe('joined');
		expect(bob.group.state.active).toBe(true);
		expect(bob.group.state.isAdmin).toBe(false);
		expect(bob.group.state.selfFileId).not.toBe('bob-wallet');

		// Converge: bob folds the admin copy; the admin folds bob's announced copy.
		await bob.store.syncNow();
		await admin.group.syncGroup();
		await admin.store.syncNow();
		await bob.store.syncNow();
		await admin.store.syncNow();

		// PROOF of read-write convergence: both hold both writes.
		expect(ids(admin.state.records)).toEqual(['a1', 'b1']);
		expect(ids(bob.state.records)).toEqual(['a1', 'b1']);
		expect(admin.group.state.memberCount).toBe(2);

		// The point of the model: both wallets stay plaintext, untouched by the
		// share; both copies are sealed under K and carry the converged data.
		expect(await isEncrypted(world.files.get('admin-wallet')!.blob!)).toBe(false);
		expect(await isEncrypted(world.files.get('bob-wallet')!.blob!)).toBe(false);
		const copyBlob = world.files.get(adminCopy)!.blob!;
		expect(await isEncrypted(copyBlob)).toBe(true);
		const snap = await importSnapshot(copyBlob, { password: link.key });
		expect(ids(snap.collections.records as Rec[])).toEqual(['a1', 'b1']);
	});

	it('joining when nothing was opened reports no-invite; a second join is idempotent', async () => {
		const world = new World();
		const bob = await makeMember(world, 'bob@x.fr', 'hh-bob2', 'bob-wallet2');
		expect(await bob.group.join()).toBe('no-invite');

		const admin = await makeMember(world, 'admin@x.fr', 'hh-admin2', 'admin-wallet2');
		const link = await admin.group.startShare();
		await bob.group.openIncoming(link.fileId, link.key);
		expect(await bob.group.join()).toBe('joined');
		expect(await bob.group.join()).toBe('joined'); // already a member: no-op
	});

	it('a password-protected wallet REFUSES to share and to join (the honest rule)', async () => {
		const world = new World();
		const admin = await makeMember(world, 'admin@x.fr', 'hh-pw-admin', 'pw-wallet', 'owner-pw');
		await expect(admin.group.startShare()).rejects.toThrow(/password-protected/);
		expect(admin.group.state.active).toBe(false);

		// Same rule on the join side.
		const boss = await makeMember(world, 'boss@x.fr', 'hh-pw-boss', 'boss-wallet');
		const link = await boss.group.startShare();
		const carol = await makeMember(world, 'carol@x.fr', 'hh-pw-carol', 'carol-wallet', 'carol-pw');
		await carol.group.openIncoming(link.fileId, link.key);
		await expect(carol.group.join()).rejects.toThrow(/password-protected/);
		expect(carol.group.state.active).toBe(false);
	});

	it('a failed publication never orphans the share: the half-share persists, the wallet stays untouched, invite() finishes', async () => {
		const world = new World();
		const m = await makeMember(world, 'admin@x.fr', 'hh-fail', 'fail-wallet');
		m.state.records.push({ id: 'a1' });
		await m.store.flush();
		const backend = makeBackend(world, 'admin@x.fr');
		let failPublish = true;
		const probed: ShareBackend = {
			...backend,
			async publishBulletin(key, payload) {
				if (failPublish) throw new Error('offline');
				return backend.publishBulletin(key, payload);
			}
		};
		const g = createHouseholdGroup({ store: m.store, kv: memKV(), backend: probed });
		await expect(g.startShare()).rejects.toThrow('offline');
		// The group state (with K) was persisted before the publication: nothing
		// is orphaned, and the WALLET was never part of the gamble.
		expect(g.state.active).toBe(true);
		expect(g.state.inviteCapability).toBeNull();
		expect(await isEncrypted(world.files.get('fail-wallet')!.blob!)).toBe(false);
		// The natural retry (re-show the link) completes the publication.
		failPublish = false;
		const cap = await g.invite();
		expect(cap.fileId).toBeTruthy();
		expect(g.state.inviteCapability).not.toBeNull();
		// And a second share on a device that already holds one is refused.
		await expect(g.startShare()).rejects.toThrow('already exists');
	});

	it('leave() stops the flow and drops MY copy; the wallet keeps everything already converged', async () => {
		const world = new World();
		const admin = await makeMember(world, 'admin@x.fr', 'hh-leave-admin', 'leave-admin-wallet');
		const bob = await makeMember(world, 'bob@x.fr', 'hh-leave-bob', 'leave-bob-wallet');
		admin.state.records.push({ id: 'a1' });
		await admin.store.flush();
		const link = await admin.group.startShare();
		await bob.group.openIncoming(link.fileId, link.key);
		await bob.group.join();
		await bob.store.syncNow();
		expect(ids(bob.state.records)).toEqual(['a1']);
		const bobCopy = bob.group.state.selfFileId!;

		await bob.group.leave();
		expect(bob.group.state.active).toBe(false);
		expect(await bob.kv.get(HOUSEHOLD_GROUP_KEY)).toBeUndefined();
		// His copy file is gone; his wallet still holds the converged data and
		// stays plaintext - the share never touched it.
		expect(world.files.has(bobCopy)).toBe(false);
		expect(ids(bob.state.records)).toEqual(['a1']);
		expect(await isEncrypted(world.files.get('leave-bob-wallet')!.blob!)).toBe(false);
		// Detached for real: a later admin write no longer reaches him.
		admin.state.records.push({ id: 'a2' });
		await admin.store.flush();
		await bob.store.syncNow();
		expect(bob.state.records.some((r) => r.id === 'a2')).toBe(false);
	});

	it('the ADMIN leave() IS the revocation: the bulletin dies, a fresh visitor cannot open the old link', async () => {
		const world = new World();
		const admin = await makeMember(world, 'admin@x.fr', 'hh-rv-admin', 'rv-wallet');
		const link = await admin.group.startShare();
		const adminCopy = admin.group.state.selfFileId!;
		await admin.group.leave();
		expect(admin.group.state.active).toBe(false);
		expect(world.files.has(adminCopy)).toBe(false); // own copy dropped

		const late = await makeMember(world, 'late@x.fr', 'hh-rv-late', 'late-wallet');
		expect(await late.group.openIncoming(link.fileId, link.key)).toBeNull();
	});

	it('revoke + re-share EVICTS for real: fresh K, ex-member exchanges nothing and reads mismatch', async () => {
		const world = new World();
		const admin = await makeMember(world, 'admin@x.fr', 'hh-rm-admin', 'rm-admin-wallet');
		const bob = await makeMember(world, 'bob@x.fr', 'hh-rm-bob', 'rm-bob-wallet');
		admin.state.records.push({ id: 'a1' });
		await admin.store.flush();
		const link = await admin.group.startShare();
		await bob.group.openIncoming(link.fileId, link.key);
		expect(await bob.group.join()).toBe('joined');
		await bob.store.syncNow();
		await admin.group.syncGroup();
		expect(admin.group.state.memberCount).toBe(2);

		// The panel's Revoke on the edit link runs leave(); creating the next
		// edit link runs startShare(). Together: the lock changes for everyone.
		await admin.group.leave();
		const link2 = await admin.group.startShare();
		expect(link2.key).not.toBe(link.key);
		expect(admin.group.state.memberCount).toBe(1); // everyone out

		// Bob still holds the old key: nothing new reaches him...
		admin.state.records.push({ id: 'a2' });
		await admin.store.flush();
		await bob.store.syncNow();
		expect(bob.state.records.some((r) => r.id === 'a2')).toBe(false);
		// ...and nothing he writes reaches the admin (his copy left the roster;
		// his old peer entry reads a dead file).
		bob.state.records.push({ id: 'b-after' });
		await bob.store.flush();
		await admin.store.syncNow();
		expect(admin.state.records.some((r) => r.id === 'b-after')).toBe(false);

		// His self-heal re-announce lands in the old mailbox nobody drains.
		await bob.group.syncGroup();
		await admin.group.syncGroup();
		expect(admin.group.state.memberCount).toBe(1);

		// And the old invitation is no door either: his app still sits on the
		// dead group, so an opened bulletin from another share reads MISMATCH.
		await bob.group.openIncoming(link2.fileId, link2.key);
		expect(await bob.group.join()).toBe('mismatch');
	});

	it('restore() re-arms the mirror and the peers after a reboot', async () => {
		const world = new World();
		const admin = await makeMember(world, 'admin@x.fr', 'hh-boot-admin', 'boot-admin-wallet');
		const bob = await makeMember(world, 'bob@x.fr', 'hh-boot-bob', 'boot-bob-wallet');
		admin.state.records.push({ id: 'a1' });
		await admin.store.flush();
		const link = await admin.group.startShare();
		await bob.group.openIncoming(link.fileId, link.key);
		await bob.group.join();
		await bob.store.syncNow();
		await admin.group.syncGroup();

		// Reboot the admin device: fresh store on the same wallet, fresh engine
		// on the same kv - restore() must re-arm without any user gesture.
		admin.store.dispose();
		const re = makeStore('hh-boot-admin-2');
		await re.store.init();
		await re.store.attachTarget(world.target('boot-admin-wallet'), { strategy: 'replace-local' });
		const g2 = createHouseholdGroup({
			store: re.store,
			kv: admin.kv,
			backend: makeBackend(world, 'admin@x.fr')
		});
		await g2.restore();
		expect(re.store.state.mirrors.some((m) => m.id.startsWith('household-copy'))).toBe(true);
		expect(re.store.state.peers.length).toBe(1);

		// The re-armed device still converges: bob's write flows in, and the
		// admin's copy follows the wallet again.
		bob.state.records.push({ id: 'b2' });
		await bob.store.flush();
		await re.store.syncNow();
		expect(ids(re.state.records)).toEqual(['a1', 'b2']);
	});

	it('a member missing from a fresh roster re-announces itself (lost-announce self-heal)', async () => {
		const world = new World();
		const admin = await makeMember(world, 'admin@x.fr', 'hh-heal-admin', 'heal-admin-wallet');
		const bob = await makeMember(world, 'bob@x.fr', 'hh-heal-bob', 'heal-bob-wallet');
		const link = await admin.group.startShare();
		await bob.group.openIncoming(link.fileId, link.key);
		expect(await bob.group.join()).toBe('joined');
		await admin.group.syncGroup();
		expect(admin.group.state.memberCount).toBe(2);

		// Simulate the lost-announce world: the bulletin regresses to a roster
		// without bob (stale rewrite, crashed fold - the announce is consumed).
		world.bulletins.set(link.fileId, {
			v: 1,
			mailboxId: (await world.bulletins.get(link.fileId))!.mailboxId,
			roster: admin.group.state.members
				.filter((m) => m.fileId !== bob.group.state.selfFileId)
				.map((m) => ({ provider: 'drive' as const, fileId: m.fileId }))
		});
		// Bob notices he is gone from a fresh read and announces again...
		await bob.group.syncGroup();
		// ...so the admin's next fold brings him back without any user action.
		await admin.group.syncGroup();
		expect(admin.group.state.members.some((m) => m.fileId === bob.group.state.selfFileId)).toBe(
			true
		);
	});

	it('a member drops a peer only after TWO consecutive roster reads without it (stale-read tolerance)', async () => {
		const world = new World();
		const admin = await makeMember(world, 'admin@x.fr', 'hh-stale-admin', 'stale-admin-wallet');
		const bob = await makeMember(world, 'bob@x.fr', 'hh-stale-bob', 'stale-bob-wallet');
		const carol = await makeMember(world, 'carol@x.fr', 'hh-stale-carol', 'stale-carol-wallet');
		const link = await admin.group.startShare();
		await bob.group.openIncoming(link.fileId, link.key);
		await bob.group.join();
		await carol.group.openIncoming(link.fileId, link.key);
		await carol.group.join();
		await admin.group.syncGroup(); // folds + rebroadcasts a 3-strong roster
		await bob.group.syncGroup();
		const carolId = carol.group.state.selfFileId!;
		expect(bob.group.state.members.some((m) => m.fileId === carolId)).toBe(true);

		// A STALE bulletin read without carol must not drop her on first sight...
		const full = (await world.bulletins.get(link.fileId))!;
		world.bulletins.set(link.fileId, {
			v: 1,
			mailboxId: full.mailboxId,
			roster: full.roster.filter((l) => l.fileId !== carolId)
		});
		await bob.group.syncGroup();
		expect(bob.group.state.members.some((m) => m.fileId === carolId)).toBe(true); // retained (miss 1)
		// ...but a SECOND consecutive read without her makes it real.
		await bob.group.syncGroup();
		expect(bob.group.state.members.some((m) => m.fileId === carolId)).toBe(false);
	});

	it('a failed rebroadcast is retried on the next converge (needsRebroadcast)', async () => {
		const world = new World();
		const m = await makeMember(world, 'admin@x.fr', 'hh-rb-admin', 'rb-admin-wallet');
		const backend = makeBackend(world, 'admin@x.fr');
		let failPublish = false;
		const probed: ShareBackend = {
			...backend,
			async publishBulletin(key, payload) {
				if (failPublish) throw new Error('offline');
				return backend.publishBulletin(key, payload);
			}
		};
		const g = createHouseholdGroup({ store: m.store, kv: memKV(), backend: probed });
		const link = await g.startShare();
		const bob = await makeMember(world, 'bob@x.fr', 'hh-rb-bob', 'rb-bob-wallet');
		await bob.group.openIncoming(link.fileId, link.key);
		await bob.group.join();

		// The fold works but the rebroadcast fails: the roster grew locally,
		// the bulletin stayed stale, and the announce is already consumed.
		failPublish = true;
		await g.syncGroup();
		expect(g.state.memberCount).toBe(2);
		expect((await world.bulletins.get(link.fileId))!.roster.length).toBe(1);
		// Next converge (nothing new to fold) still republishes.
		failPublish = false;
		await g.syncGroup();
		expect((await world.bulletins.get(link.fileId))!.roster.length).toBe(2);
	});

	it('a wallet protected AFTER the fact goes dormant: the mirror is torn down, the copy stops moving', async () => {
		const world = new World();
		const admin = await makeMember(world, 'admin@x.fr', 'hh-dorm-admin', 'dorm-wallet');
		admin.state.records.push({ id: 'a1' });
		await admin.store.flush();
		await admin.group.startShare();
		const copyId = admin.group.state.selfFileId!;
		await admin.store.syncNow();
		const tagBefore = world.files.get(copyId)!.tag;
		expect(tagBefore).toBeGreaterThan(0);

		// The UI refuses protect-while-shared; if a password lands anyway (an
		// older build, a script), the next converge tears the mirror down.
		await admin.store.setEncryption('late-pw');
		await admin.group.syncGroup();
		expect(admin.store.state.mirrors).toEqual([]);
		admin.state.records.push({ id: 'a2' });
		await admin.store.flush();
		expect(world.files.get(copyId)!.tag).toBe(tagBefore); // copy untouched
	});

	it('a wallet-bound share goes DORMANT on another silo (nothing crosses) and re-arms on return', async () => {
		const world = new World();
		// A multi-silo admin: the engine is told which wallet file is attached.
		const { state, store } = makeStore('hh-scope-admin');
		await store.init();
		await store.attachTarget(world.target('scope-wallet'), { strategy: 'replace-remote' });
		const attached = { id: 'scope-wallet' as string | null };
		const group = createHouseholdGroup({
			store,
			kv: memKV(),
			backend: makeBackend(world, 'admin@x.fr'),
			wallet: async () => attached.id
		});
		const bob = await makeMember(world, 'bob@x.fr', 'hh-scope-bob', 'scope-bob-wallet');

		state.records.push({ id: 'a1' });
		await store.flush();
		const link = await group.startShare();
		expect(group.state.walletFileId).toBe('scope-wallet');
		await bob.group.openIncoming(link.fileId, link.key);
		await bob.group.join();
		await bob.store.syncNow();
		expect(ids(bob.state.records)).toEqual(['a1']);

		// Switch to ANOTHER silo (the host calls syncGroup after every switch):
		// full dormancy, both directions.
		const copyId = group.state.selfFileId!;
		attached.id = 'scope-other';
		await store.attachTarget(world.target('scope-other'), { strategy: 'replace-remote' });
		await group.syncGroup();
		expect(store.state.mirrors).toEqual([]);
		expect(store.state.peers).toEqual([]);
		const tagBefore = world.files.get(copyId)!.tag;

		// Private work on the other silo: the copy must not move, bob sees nothing.
		state.records.push({ id: 'p1' });
		await store.flush();
		await group.syncGroup();
		expect(world.files.get(copyId)!.tag).toBe(tagBefore);
		await bob.store.syncNow();
		expect(bob.state.records.some((r) => r.id === 'p1')).toBe(false);

		// Back on the bound wallet: the share re-arms and converges again.
		attached.id = 'scope-wallet';
		await store.attachTarget(world.target('scope-wallet'), {
			strategy: 'replace-local',
			wipe: true
		});
		await group.syncGroup();
		expect(store.state.mirrors.some((m) => m.id.startsWith('household-copy'))).toBe(true);
		state.records.push({ id: 'a2' });
		await store.flush();
		await bob.store.syncNow();
		expect(ids(bob.state.records)).toEqual(['a1', 'a2']);
	});

	it('restore() arms nothing while the bound wallet is away, and re-arms once it is back', async () => {
		const world = new World();
		const admin = await makeMember(world, 'admin@x.fr', 'hh-scope-r-admin', 'scope-r-admin');
		const link = await admin.group.startShare();

		// Bob joins from his bound wallet, then the device reboots on another silo.
		const first = makeStore('hh-scope-r-bob');
		await first.store.init();
		await first.store.attachTarget(world.target('scope-r-bob'), { strategy: 'replace-remote' });
		const attached = { id: 'scope-r-bob' as string | null };
		const kv = memKV();
		const backend = makeBackend(world, 'bob@x.fr');
		const g1 = createHouseholdGroup({
			store: first.store,
			kv,
			backend,
			wallet: async () => attached.id
		});
		await g1.openIncoming(link.fileId, link.key);
		expect(await g1.join()).toBe('joined');
		first.store.dispose();

		const re = makeStore('hh-scope-r-bob-2');
		await re.store.init();
		attached.id = 'scope-r-other';
		await re.store.attachTarget(world.target('scope-r-other'), { strategy: 'replace-remote' });
		const g2 = createHouseholdGroup({
			store: re.store,
			kv,
			backend,
			wallet: async () => attached.id
		});
		await g2.restore();
		expect(g2.state.walletFileId).toBe('scope-r-bob');
		expect(re.store.state.mirrors).toEqual([]);
		expect(re.store.state.peers).toEqual([]);

		// The bound silo comes back: restore arms mirror + peers again.
		attached.id = 'scope-r-bob';
		await re.store.attachTarget(world.target('scope-r-bob'), { strategy: 'replace-remote' });
		await g2.restore();
		expect(re.store.state.mirrors.some((m) => m.id.startsWith('household-copy'))).toBe(true);
		expect(re.store.state.peers.length).toBe(1);
	});

	it('a device holds TWO memberships, one per silo: each converges in its own scope, leave() takes one', async () => {
		const world = new World();
		const anne = await makeMember(world, 'anne@x.fr', 'hh-mm-anne', 'mm-anne-wallet');
		const marc = await makeMember(world, 'marc@x.fr', 'hh-mm-marc', 'mm-marc-wallet');
		anne.state.records.push({ id: 'anne-1' });
		await anne.store.flush();
		marc.state.records.push({ id: 'marc-1' });
		await marc.store.flush();
		const linkA = await anne.group.startShare();
		const linkM = await marc.group.startShare();

		// Bob: one store, one dedicated silo per joined share.
		const { state, store } = makeStore('hh-mm-bob');
		await store.init();
		const attached = { id: 'mm-bob-silo-anne' as string | null };
		await store.attachTarget(world.target('mm-bob-silo-anne'), { strategy: 'replace-remote' });
		const group = createHouseholdGroup({
			store,
			kv: memKV(),
			backend: makeBackend(world, 'bob@x.fr'),
			wallet: async () => attached.id
		});
		await group.openIncoming(linkA.fileId, linkA.key);
		expect(await group.join()).toBe('joined');
		await store.syncNow();
		expect(ids(state.records)).toEqual(['anne-1']);

		// A SECOND share on a SECOND silo: a second membership, never a mismatch.
		attached.id = 'mm-bob-silo-marc';
		await store.attachTarget(world.target('mm-bob-silo-marc'), {
			strategy: 'replace-remote',
			wipe: true
		});
		await group.syncGroup(); // the silo switch puts the first share to sleep
		await group.openIncoming(linkM.fileId, linkM.key);
		expect(await group.join()).toBe('joined');
		expect(group.state.memberships.length).toBe(2);
		await store.syncNow();
		expect(ids(state.records)).toEqual(['marc-1']);
		expect(state.records.some((r) => r.id === 'anne-1')).toBe(false); // never mixed

		// Back on the first silo: its membership re-arms and still converges.
		attached.id = 'mm-bob-silo-anne';
		await store.attachTarget(world.target('mm-bob-silo-anne'), {
			strategy: 'replace-local',
			wipe: true
		});
		await group.syncGroup();
		anne.state.records.push({ id: 'anne-2' });
		await anne.store.flush();
		await store.syncNow();
		expect(ids(state.records)).toEqual(['anne-1', 'anne-2']);

		// Leaving ONE membership keeps the other.
		await group.leave('mm-bob-silo-anne');
		expect(group.state.memberships.length).toBe(1);
		expect(group.state.memberships[0].sharedBy).toBe('marc@x.fr');
	});

	it('a pre-multi single record lifts into the list unchanged (v1 -> v2)', async () => {
		const world = new World();
		const admin = await makeMember(world, 'admin@x.fr', 'hh-lift-admin', 'lift-admin-wallet');
		const link = await admin.group.startShare();
		const m = await makeMember(world, 'bob@x.fr', 'hh-lift-bob', 'lift-bob-wallet');
		await m.group.openIncoming(link.fileId, link.key);
		expect(await m.group.join()).toBe('joined');
		// Regress the persisted record to the 0.27 single-object shape.
		const v2 = await m.kv.get<{ v: 2; groups: unknown[] }>(HOUSEHOLD_GROUP_KEY);
		expect(v2?.v).toBe(2);
		await m.kv.set(HOUSEHOLD_GROUP_KEY, v2!.groups[0]);
		const rebooted = createHouseholdGroup({
			store: m.store,
			kv: m.kv,
			backend: makeBackend(world, 'bob@x.fr')
		});
		await rebooted.restore();
		expect(rebooted.state.active).toBe(true);
		expect(rebooted.state.memberships.length).toBe(1);
		expect(m.store.state.mirrors.some((x) => x.id.startsWith('household-copy'))).toBe(true);
	});

	it('a lost join announce persists as pending and heals on the next converge', async () => {
		const world = new World();
		const admin = await makeMember(world, 'admin@x.fr', 'hh-lost', 'lost-wallet');
		const link = await admin.group.startShare();

		// Bob joins while the mailbox drops every announce (a network blip, a
		// relay cold start): the exact stranded-joiner incident - member on his
		// side, visible to nobody, editing into the void.
		const bob = await makeMember(world, 'bob@x.fr', 'hh-lost-bob', 'lost-bob-wallet');
		const backend = makeBackend(world, 'bob@x.fr');
		let mailboxDown = true;
		const flaky: ShareBackend = {
			...backend,
			async announce(mailboxId, copy) {
				if (mailboxDown) throw new Error('relay 429');
				return backend.announce(mailboxId, copy);
			}
		};
		const group = createHouseholdGroup({ store: bob.store, kv: memKV(), backend: flaky });
		await group.openIncoming(link.fileId, link.key);
		expect(await group.join()).toBe('joined'); // joined on his side, but...
		expect(group.state.memberships[0].announcePending).toBe(true); // ...honestly pending

		// The admin folds nothing: the announce never arrived.
		await admin.group.syncGroup();
		expect(admin.group.state.memberCount).toBe(1);

		// The blip clears. Bob's next converge re-announces (fresh bulletin,
		// his copy absent), and the admin's fold finally admits him.
		mailboxDown = false;
		await group.syncGroup();
		await admin.group.syncGroup();
		expect(admin.group.state.memberCount).toBe(2);

		// A fresh roster now carries bob: pending clears on his next reread.
		await group.syncGroup();
		expect(group.state.memberships[0].announcePending).toBe(false);
	}, 20_000);

	it('a rotated link marks the membership stale after two unreadable reads; a readable one clears it', async () => {
		const world = new World();
		const admin = await makeMember(world, 'admin@x.fr', 'hh-rot', 'rot-wallet');
		const link = await admin.group.startShare();
		const bob = await makeMember(world, 'bob@x.fr', 'hh-rot-bob', 'rot-bob-wallet');
		const backend = makeBackend(world, 'bob@x.fr');
		let unreadable = false;
		const rotatable: ShareBackend = {
			...backend,
			async rereadJoined(fileId, key) {
				return unreadable ? 'unreadable' : backend.rereadJoined(fileId, key);
			}
		};
		const group = createHouseholdGroup({ store: bob.store, kv: memKV(), backend: rotatable });
		await group.openIncoming(link.fileId, link.key);
		expect(await group.join()).toBe('joined');

		// The admin rotated: bob's key stops decrypting the bulletin.
		unreadable = true;
		await group.syncGroup();
		expect(group.state.memberships[0].stale).toBe(false); // one read: doubt
		await group.syncGroup();
		expect(group.state.memberships[0].stale).toBe(true); // two in a row: truth

		// A readable bulletin again (re-shared under the same key) clears it.
		unreadable = false;
		await group.syncGroup();
		expect(group.state.memberships[0].stale).toBe(false);
	});
});
