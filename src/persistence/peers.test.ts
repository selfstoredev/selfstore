/**
 * Peers: read-write sharing over crossed read-only links. Each member's store
 * publishes to its own target; the other members attach that target as a
 * read-only PeerSource. These tests pin the contract: copies converge to the
 * union (including through a hub - gossip), deletions propagate, and every
 * per-peer failure (unreachable, auth loss, wrong passphrase, newer schema,
 * plaintext swap) is recorded on that peer without gating the store or
 * blocking the own publish.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { createLocalStore, type LocalStore, type LocalStoreOptions } from './store';
import { memoryCache } from './cache';
import type { BackupTarget, PeerSource } from './target';
import { AuthExpiredError, type Snapshot } from '../selfstore';

/** An in-memory BackupTarget with a stat() marker (bumped on each save), so
 *  both the own-remote and the peer staleness paths behave like Drive/WebDAV. */
function memTarget(kind = 'drive') {
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
			if (failWith) throw failWith;
			return remote;
		},
		async stat() {
			if (failWith) throw failWith;
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

/** Wrap a target as a PeerSource that counts load() calls (stat-skip pin). */
function peerView(t: BackupTarget) {
	let loads = 0;
	const source: PeerSource = {
		label: `view:${t.kind}`,
		async load() {
			loads++;
			return t.load();
		},
		async stat() {
			return t.stat!();
		}
	};
	return {
		source,
		get loads() {
			return loads;
		}
	};
}

// Each store gets its own app name (so no BroadcastChannel cross-talk between
// members - they are different people, not tabs) and its own cache.
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
	const store = createLocalStore({
		app: `peers-${++seq}`,
		schemaVersion: 1,
		gather: () => ({ collections: structuredClone(app.collections), files: [] }),
		apply: (snap: Snapshot) => {
			app.collections = structuredClone(snap.collections ?? {});
		},
		cache: memoryCache(),
		logger: { warn() {}, error() {} },
		...extra
	});
	open.push(store);
	return { store, app };
}

const ids = (rows: unknown[] | undefined): string[] =>
	(rows ?? []).map((r) => (r as { id: string }).id).sort();

/** A member with its own published copy: store attached to a fresh target. */
async function member(id: string, extra: Partial<LocalStoreOptions> = {}, password?: string) {
	const m = makeStore({ accounts: [{ id }] }, extra);
	await m.store.init();
	const t = memTarget();
	await m.store.attachTarget(t.target, { strategy: 'replace-remote', password });
	return { ...m, t };
}

describe('convergence over crossed read-only links', () => {
	it('two members converge to the union, both locally and on their copies', async () => {
		const a = await member('a1');
		const b = await member('b1');

		b.store.attachPeer(a.t.target);
		await b.store.syncNow();
		expect(ids(b.app.collections.accounts)).toEqual(['a1', 'b1']);

		a.store.attachPeer(b.t.target);
		await a.store.syncNow();
		expect(ids(a.app.collections.accounts)).toEqual(['a1', 'b1']);

		// Both PUBLISHED copies carry the union too: a fresh viewer of either
		// copy sees everything (each member is a full backup of the group).
		const viewer = makeStore();
		await viewer.store.init();
		viewer.store.attachPeer(a.t.target);
		await viewer.store.syncNow();
		expect(ids(viewer.app.collections.accounts)).toEqual(['a1', 'b1']);
	});

	it('gossip: a star around a hub propagates everything in two hops', async () => {
		const a = await member('a1');
		const c = await member('c1');
		const hub = await member('h1');

		// Only the hub links A and C; A and C only link the hub.
		hub.store.attachPeer(a.t.target);
		hub.store.attachPeer(c.t.target);
		await hub.store.syncNow();
		expect(ids(hub.app.collections.accounts)).toEqual(['a1', 'c1', 'h1']);

		a.store.attachPeer(hub.t.target);
		await a.store.syncNow();
		c.store.attachPeer(hub.t.target);
		await c.store.syncNow();
		expect(ids(a.app.collections.accounts)).toEqual(['a1', 'c1', 'h1']);
		expect(ids(c.app.collections.accounts)).toEqual(['a1', 'c1', 'h1']);
	});

	it('deletions propagate between members (tombstones win over old copies)', async () => {
		const a = await member('a1');
		const b = await member('b1');
		b.store.attachPeer(a.t.target);
		a.store.attachPeer(b.t.target);
		await b.store.syncNow();
		await a.store.syncNow();
		expect(ids(a.app.collections.accounts)).toEqual(['a1', 'b1']);

		// A deletes a1 and publishes; B folds the tombstone in.
		a.app.collections.accounts = (a.app.collections.accounts as { id: string }[]).filter(
			(r) => r.id !== 'a1'
		);
		await a.store.flush();
		await b.store.syncNow();
		expect(ids(b.app.collections.accounts)).toEqual(['b1']);
	});

	it('a device-only follower (no durable target) can track a copy', async () => {
		const a = await member('a1');
		const f = makeStore();
		await f.store.init();
		f.store.attachPeer(a.t.target);
		await f.store.syncNow();
		expect(f.store.state.targetKind).toBe('device');
		expect(ids(f.app.collections.accounts)).toEqual(['a1']);
	});

	it('peers attached before init() fold at boot', async () => {
		const a = await member('a1');
		const f = makeStore();
		f.store.attachPeer(a.t.target);
		await f.store.init();
		expect(ids(f.app.collections.accounts)).toEqual(['a1']);
	});

	it('stat() skips unchanged copies (no useless downloads)', async () => {
		const a = await member('a1');
		const b = await member('b1');
		const view = peerView(a.t.target);
		b.store.attachPeer(view.source);
		await b.store.syncNow(); // the attach converge already folded; this one stat-skips
		expect(view.loads).toBe(1);

		await b.store.syncNow();
		expect(view.loads).toBe(1); // unchanged: stat short-circuits the download

		a.app.collections.accounts = [{ id: 'a1' }, { id: 'a2' }];
		await a.store.flush();
		await b.store.syncNow();
		expect(view.loads).toBe(2);
		expect(ids(b.app.collections.accounts)).toEqual(['a1', 'a2', 'b1']);
	});

	it('detachPeer stops folding that copy', async () => {
		const a = await member('a1');
		const b = await member('b1');
		const id = b.store.attachPeer(a.t.target);
		await b.store.syncNow();
		expect(b.store.state.peers).toHaveLength(1);

		b.store.detachPeer(id);
		expect(b.store.state.peers).toHaveLength(0);
		a.app.collections.accounts = [{ id: 'a1' }, { id: 'a2' }];
		await a.store.flush();
		await b.store.syncNow();
		expect(ids(b.app.collections.accounts)).toEqual(['a1', 'b1']); // a2 never folded
	});
});

describe('per-peer failures never gate the store or block the own publish', () => {
	it('an unreachable peer reads as TARGET_UNAVAILABLE on that peer only', async () => {
		const b = await member('b1');
		b.store.attachPeer({
			label: 'dead',
			async load() {
				throw new Error('boom');
			}
		});
		b.app.collections.accounts = [{ id: 'b1' }, { id: 'b2' }];
		await b.store.flush();
		await b.store.syncNow();

		expect(b.store.state.peers[0].lastError?.code).toBe('TARGET_UNAVAILABLE');
		expect(b.store.state.status.state).not.toBe('needs-attention');
		// The own publish went through: a viewer of B's copy sees the edit.
		const viewer = makeStore();
		await viewer.store.init();
		viewer.store.attachPeer(b.t.target);
		await viewer.store.syncNow();
		expect(ids(viewer.app.collections.accounts)).toEqual(['b1', 'b2']);
	});

	it('a genuine read-access loss reads as AUTH_EXPIRED on the peer, no store gate', async () => {
		const b = await member('b1');
		b.store.attachPeer({
			label: 'revoked',
			async load() {
				throw new AuthExpiredError();
			}
		});
		await b.store.syncNow();
		expect(b.store.state.peers[0].lastError?.code).toBe('AUTH_EXPIRED');
		expect(b.store.state.status.state).not.toBe('needs-attention');
	});

	it('a copy that does not open with the group passphrase is skipped', async () => {
		const a = await member('a1', {}, 'alpha');

		// No password at all: PASSWORD_REQUIRED, and the member keeps working.
		const b = await member('b1');
		b.store.attachPeer(a.t.target);
		await b.store.syncNow();
		expect(b.store.state.peers[0].lastError?.code).toBe('PASSWORD_REQUIRED');
		expect(ids(b.app.collections.accounts)).toEqual(['b1']);
		expect(b.store.state.status.state).not.toBe('needs-attention');

		// The wrong password: DECRYPT_FAILED - and crucially the store does not
		// drop its own (valid) password or raise its own lock gate.
		const c = await member('c1', {}, 'beta');
		c.store.attachPeer(a.t.target);
		await c.store.syncNow();
		expect(c.store.state.peers[0].lastError?.code).toBe('DECRYPT_FAILED');
		expect(c.store.state.locked).toBe(false);
		expect(c.store.state.status.state).not.toBe('needs-attention');
	});

	it('a peer on a newer schema is skipped without gating this member', async () => {
		const a = await member('a2', { schemaVersion: 2 });
		const b = await member('b1', { schemaVersion: 1 });
		b.store.attachPeer(a.t.target);
		await b.store.syncNow();

		expect(b.store.state.peers[0].lastError?.code).toBe('SCHEMA_TOO_NEW');
		expect(b.store.state.status.state).not.toBe('needs-attention');
		expect(ids(b.app.collections.accounts)).toEqual(['b1']); // nothing folded
		// B keeps editing and publishing its own copy.
		b.app.collections.accounts = [{ id: 'b1' }, { id: 'b2' }];
		await b.store.flush();
		expect(b.store.state.lastError).toBeNull();
	});

	it('a plaintext peer copy is refused when this member expects encryption', async () => {
		const a = await member('a1'); // publishes unencrypted
		const b = await member('b1', {}, 'pw'); // group is supposed to be encrypted
		b.store.attachPeer(a.t.target);
		await b.store.syncNow();

		expect(b.store.state.peers[0].lastError?.code).toBe('UNEXPECTEDLY_UNENCRYPTED');
		expect(ids(b.app.collections.accounts)).toEqual(['b1']); // the swap did not fold
	});

	it('a broken peer heals silently once it works again', async () => {
		const a = await member('a1');
		const b = await member('b1');
		a.t.fail(new Error('down'));
		b.store.attachPeer(a.t.target);
		await b.store.syncNow();
		expect(b.store.state.peers[0].lastError?.code).toBe('TARGET_UNAVAILABLE');

		a.t.fail(null);
		await b.store.syncNow();
		expect(b.store.state.peers[0].lastError).toBeNull();
		expect(ids(b.app.collections.accounts)).toEqual(['a1', 'b1']);
	});
});
