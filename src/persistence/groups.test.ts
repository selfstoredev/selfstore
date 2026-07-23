/**
 * Passwordless groups, store layer: members publish signed, per-member-sealed
 * copies and fold each other through peers - no password anywhere. Pins the
 * trust rules end to end: only manifest members are believed, removal stops
 * future access (and only future - honestly), manifests never roll back, and
 * every refusal lands on the right scope (per peer, or the own-target gate).
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
	createLocalStore,
	type LocalStore,
	type LocalStoreOptions,
	type StoreGroupConfig
} from './store';
import { memoryCache, type LocalCache } from './cache';
import { identityVault } from './identity';
import type { BackupTarget } from './target';
import {
	generateIdentity,
	newGroupId,
	signManifest,
	type GroupIdentity,
	type GroupManifest,
	type SignedManifest
} from '../selfstore/group';
import { exportSnapshot, inspect, type Snapshot } from '../selfstore';

function memTarget(kind = 'drive') {
	let remote: Blob | null = null;
	let version = 0;
	const target: BackupTarget = {
		kind,
		label: kind,
		async save(b) {
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
		/** Plant arbitrary bytes as the published copy (attack simulation). */
		seed(b: Blob) {
			remote = b;
			version++;
		}
	};
}

let seq = 0;
const open: LocalStore[] = [];
afterEach(() => {
	for (const s of open.splice(0)) s.dispose();
});

function makeStore(
	initial: Record<string, unknown[]> = {},
	extra: Partial<LocalStoreOptions> = {}
) {
	const app = { collections: structuredClone(initial) };
	const cache = memoryCache();
	const store = createLocalStore({
		app: `groups-${++seq}`,
		schemaVersion: 1,
		gather: () => ({ collections: structuredClone(app.collections), files: [] }),
		apply: (snap: Snapshot) => {
			app.collections = structuredClone(snap.collections ?? {});
		},
		cache,
		logger: { warn() {}, error() {} },
		...extra
	});
	open.push(store);
	return { store, app, cache };
}

const ids = (rows: unknown[] | undefined): string[] =>
	(rows ?? []).map((r) => (r as { id: string }).id).sort();

interface Member {
	id: string;
	identity: GroupIdentity;
	store: ReturnType<typeof makeStore>['store'];
	app: ReturnType<typeof makeStore>['app'];
	t: ReturnType<typeof memTarget>;
}

/** A group of members, each with an identity, a store seeded with one record
 *  (`<id>1`) and their own published copy. The first name is the admin; the
 *  stores receive the signed manifest (they verify it themselves). */
async function makeGroup(
	names: string[]
): Promise<{ manifest: GroupManifest; signed: SignedManifest; members: Member[] }> {
	const identities = await Promise.all(names.map(() => generateIdentity()));
	const manifest: GroupManifest = {
		v: 1,
		group: newGroupId(),
		seq: 1,
		admin: identities[0].sigPub,
		members: names.map((id, i) => ({ id, sig: identities[i].sigPub, enc: identities[i].encPub }))
	};
	const signed = await signManifest(manifest, identities[0].sigPriv);
	const members: Member[] = [];
	for (let i = 0; i < names.length; i++) {
		const m = makeStore({ accounts: [{ id: `${names[i]}1` }] });
		await m.store.init();
		const t = memTarget();
		await m.store.attachTarget(t.target, {
			group: { identity: identities[i], admin: identities[0].sigPub, manifest: signed },
			strategy: 'replace-remote'
		});
		members.push({ id: names[i], identity: identities[i], store: m.store, app: m.app, t });
	}
	return { manifest, signed, members };
}

describe('passwordless group', () => {
	it('converges through a hub with signed, sealed copies and verified authors', async () => {
		const { members } = await makeGroup(['alice', 'bob', 'carol']);
		const [alice, bob, carol] = members;

		// Star topology: bob is the hub.
		bob.store.attachPeer(alice.t.target, { id: 'alice' });
		bob.store.attachPeer(carol.t.target, { id: 'carol' });
		alice.store.attachPeer(bob.t.target, { id: 'bob' });
		carol.store.attachPeer(bob.t.target, { id: 'bob' });

		await bob.store.syncNow();
		await alice.store.syncNow();
		await carol.store.syncNow();

		for (const m of members) {
			expect(ids(m.app.collections.accounts)).toEqual(['alice1', 'bob1', 'carol1']);
		}
		// Attribution is VERIFIED (signature), not claimed.
		expect(bob.store.state.peers.map((p) => p.author).sort()).toEqual(['alice', 'carol']);

		// The published copies are group boxes: format 2, no plaintext leakage.
		const header = await inspect(alice.t.remote!);
		expect(header.format).toBe(2);
		expect(header.keying).toBe('x25519-hkdf-sha256');
		const raw = new TextDecoder().decode(new Uint8Array(await alice.t.remote!.arrayBuffer()));
		expect(raw).not.toContain('alice1');
	});

	it('removing a member stops their access to NEW publications only', async () => {
		const { manifest, members } = await makeGroup(['alice', 'bob', 'carol']);
		const [alice, bob, carol] = members;
		bob.store.attachPeer(alice.t.target, { id: 'alice' });
		alice.store.attachPeer(bob.t.target, { id: 'bob' });
		carol.store.attachPeer(alice.t.target, { id: 'alice' });
		await bob.store.syncNow();
		await carol.store.syncNow();
		expect(ids(carol.app.collections.accounts)).toContain('alice1');

		// The admin (alice) drops carol: seq 2, members alice + bob, admin-signed.
		const next = await signManifest(
			{ ...manifest, seq: 2, members: manifest.members.filter((m) => m.id !== 'carol') },
			alice.identity.sigPriv
		);
		await alice.store.setGroup(next);
		await bob.store.setGroup(next);

		// Alice publishes something new. Carol's fold of alice's copy now fails
		// on HER envelope only - the copy is valid, carol is just not a recipient.
		alice.app.collections.accounts = [{ id: 'alice1' }, { id: 'alice2' }];
		await alice.store.flush();
		await carol.store.syncNow();
		expect(carol.store.state.peers[0].lastError?.code).toBe('NOT_A_RECIPIENT');
		expect(ids(carol.app.collections.accounts)).not.toContain('alice2'); // future sealed off
		expect(ids(carol.app.collections.accounts)).toContain('alice1'); // the past stays hers
		expect(carol.store.state.status.state).not.toBe('needs-attention');

		// The remaining members keep converging.
		await bob.store.syncNow();
		expect(ids(bob.app.collections.accounts)).toContain('alice2');
	});

	it('setGroup republishes immediately: a removed member is sealed off with no new content edit', async () => {
		// Regression: the idempotent-save guard skipped setGroup's mandated republish
		// (membership changes the envelope recipients, not the content digest), so a
		// removed member kept decrypting the current copy until the next real edit.
		const { manifest, members } = await makeGroup(['alice', 'bob', 'carol']);
		const [alice, , carol] = members;
		carol.store.attachPeer(alice.t.target, { id: 'alice' });
		await carol.store.syncNow();
		expect(ids(carol.app.collections.accounts)).toContain('alice1');

		// Admin drops carol. No content edit follows - the re-envelope must happen NOW.
		const next = await signManifest(
			{ ...manifest, seq: 2, members: manifest.members.filter((m) => m.id !== 'carol') },
			alice.identity.sigPriv
		);
		await alice.store.setGroup(next);

		// Carol re-reads alice's current (content-unchanged) copy: already sealed off.
		await carol.store.syncNow();
		expect(carol.store.state.peers[0].lastError?.code).toBe('NOT_A_RECIPIENT');
	});

	it('refuses a manifest rollback, even across a re-attach', async () => {
		const { manifest, signed, members } = await makeGroup(['alice', 'bob']);
		const [alice] = members;
		await alice.store.setGroup(await signManifest({ ...manifest, seq: 2 }, alice.identity.sigPriv));

		await expect(alice.store.setGroup(signed)).rejects.toMatchObject({
			code: 'MANIFEST_ROLLBACK'
		});

		// The high-water mark survives a detach: re-attaching with the old
		// manifest (a replay) is refused too.
		await alice.store.detachTarget();
		await expect(
			alice.store.attachTarget(alice.t.target, {
				group: { identity: alice.identity, admin: alice.identity.sigPub, manifest: signed },
				strategy: 'merge'
			})
		).rejects.toMatchObject({ code: 'MANIFEST_ROLLBACK' });
	});

	it('setGroup refuses a manifest that does not verify against the pinned admin', async () => {
		const { manifest, members } = await makeGroup(['alice', 'bob']);
		const [alice] = members;
		const impostor = await generateIdentity();
		// Admin-swap attempt, signed by the impostor: the pinned key refuses it,
		// even though the manifest is internally consistent and its seq is newer.
		const swapped = await signManifest(
			{ ...manifest, seq: 2, admin: impostor.sigPub },
			impostor.sigPriv
		);
		await expect(alice.store.setGroup(swapped)).rejects.toMatchObject({
			code: 'SIGNATURE_INVALID'
		});
		// Signed by the REAL admin but for a different group id: binding refuses it.
		const foreign = await signManifest(
			{ ...manifest, seq: 2, group: newGroupId() },
			alice.identity.sigPriv
		);
		await expect(alice.store.setGroup(foreign)).rejects.toMatchObject({
			code: 'SIGNATURE_INVALID'
		});
	});

	it('attach verifies the signed manifest itself: a forged membership never lands', async () => {
		const admin = await generateIdentity();
		const attacker = await generateIdentity();
		const manifest: GroupManifest = {
			v: 1,
			group: newGroupId(),
			seq: 1,
			admin: admin.sigPub,
			members: [{ id: 'me', sig: admin.sigPub, enc: admin.encPub }]
		};
		// The attacker adds themselves and signs with THEIR key. The app calls
		// nothing special - the store verifies against the pinned admin key.
		const forged = await signManifest(
			{
				...manifest,
				members: [...manifest.members, { id: 'evil', sig: attacker.sigPub, enc: attacker.encPub }]
			},
			attacker.sigPriv
		);
		const { store } = makeStore();
		await store.init();
		const t = memTarget();
		await expect(
			store.attachTarget(t.target, {
				group: { identity: admin, admin: admin.sigPub, manifest: forged }
			})
		).rejects.toMatchObject({ code: 'SIGNATURE_INVALID' });
		// Refused before anything changed: still device-only, nothing published.
		expect(store.state.targetKind).toBe('device');
		expect(store.state.encrypted).toBe(false);
		expect(t.remote).toBeNull();
	});

	it('a copy signed by a non-member is refused on both scopes', async () => {
		const { manifest, members } = await makeGroup(['alice', 'bob']);
		const [alice, bob] = members;
		bob.store.attachPeer(alice.t.target, { id: 'alice' });
		await bob.store.syncNow();

		// An attacker with write access to alice's storage plants a copy signed
		// by their own key, sealed for everyone (so decryption WOULD succeed).
		const attacker = await generateIdentity();
		const { writeBox } = await import('../selfstore/box');
		const forged = await writeBox(
			{ collections: { accounts: [{ id: 'evil' }] }, files: [] },
			{
				app: 'groups',
				schemaVersion: 1,
				group: {
					recipients: manifest.members.map((m) => m.enc),
					sign: { pub: attacker.sigPub, priv: attacker.sigPriv }
				}
			},
			{ schemaVersion: 1, meta: { v: 1 } }
		);
		alice.t.seed(new Blob([forged as BlobPart], { type: 'application/zip' }));

		// Bob's fold refuses it per peer; bob is untouched.
		await bob.store.syncNow();
		expect(bob.store.state.peers[0].lastError?.code).toBe('SIGNATURE_INVALID');
		expect(ids(bob.app.collections.accounts)).not.toContain('evil');
		expect(bob.store.state.status.state).not.toBe('needs-attention');

		// Alice's own pull gates (her copy was substituted) and never clobbers.
		await alice.store.syncNow();
		expect(alice.store.state.status.state).toBe('needs-attention');
		expect(alice.store.state.lastError?.code).toBe('SIGNATURE_INVALID');
		expect(ids(alice.app.collections.accounts)).not.toContain('evil');
	});

	it('a plaintext (or password) swap is refused in group mode', async () => {
		const { members } = await makeGroup(['alice', 'bob']);
		const [alice, bob] = members;
		bob.store.attachPeer(alice.t.target, { id: 'alice' });
		await bob.store.syncNow();

		alice.t.seed(
			await exportSnapshot(
				{ collections: { accounts: [{ id: 'plain' }] }, files: [] },
				{ app: 'x' }
			)
		);
		await bob.store.syncNow();
		expect(bob.store.state.peers[0].lastError?.code).toBe('UNEXPECTEDLY_UNENCRYPTED');
		expect(ids(bob.app.collections.accounts)).not.toContain('plain');
	});

	it('a fresh session re-attaches with the group and reads its copy back', async () => {
		const { signed, members } = await makeGroup(['alice', 'bob']);
		const [alice] = members;

		const rebooted = makeStore();
		await rebooted.store.init();
		await rebooted.store.attachTarget(alice.t.target, {
			group: { identity: alice.identity, admin: alice.identity.sigPub, manifest: signed },
			strategy: 'replace-local',
			keepSession: true
		});
		expect(ids(rebooted.app.collections.accounts)).toEqual(['alice1']);
		expect(rebooted.store.state.encrypted).toBe(true);
		expect(rebooted.store.state.locked).toBe(false); // group mode never locks
	});

	it('guards: group+password, non-member identity, setEncryption in group mode', async () => {
		const { signed, members } = await makeGroup(['alice', 'bob']);
		const [alice] = members;
		const outsider = await generateIdentity();
		const t = memTarget('file');
		const g: StoreGroupConfig = {
			identity: alice.identity,
			admin: alice.identity.sigPub,
			manifest: signed
		};

		expect(() => alice.store.attachTarget(t.target, { group: g, password: 'pw' })).toThrow(
			TypeError
		);
		// A valid manifest that does not LIST this identity: refused after the
		// (async) verification, before anything about the store changes.
		await expect(
			alice.store.attachTarget(t.target, { group: { ...g, identity: outsider } })
		).rejects.toThrow(TypeError);
		await expect(alice.store.setEncryption('pw')).rejects.toThrow(TypeError);
		expect(() => makeStore().store.setGroup(signed)).toThrow(TypeError);
	});
});

describe('identityVault', () => {
	it('creates once, reloads the same identity, and seals it at rest', async () => {
		const cache: LocalCache = memoryCache();
		const vault = identityVault(cache.kv);
		const first = await vault.loadOrCreate();
		const again = await vault.loadOrCreate();
		expect(again).toEqual(first);

		// At rest the kv holds a sealed envelope, not the private keys.
		const raw = await cache.kv.get('groupIdentity');
		expect(JSON.stringify(raw)).not.toContain(first.sigPriv);

		await vault.clear();
		expect(await vault.load()).toBeNull();
		const fresh = await vault.loadOrCreate();
		expect(fresh.sigPub).not.toBe(first.sigPub);
	});
});
