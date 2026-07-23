/**
 * Mirrors: write-only published copies under their own key - the sharing
 * building block that never touches the wallet itself. A member keeps their
 * file plaintext (or under their own password), attaches a mirror sealed
 * under the share key, and the others read that mirror as a peer with that
 * key: crossed mirrors converge exactly like crossed read-only links, while
 * every wallet file stays exactly what its owner chose.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { createLocalStore, type LocalStore, type LocalStoreOptions } from './store';
import { memoryCache } from './cache';
import type { BackupTarget, PeerSource } from './target';
import { importSnapshot, inspect, type Snapshot } from '../selfstore';

/** An in-memory BackupTarget with a stat() marker (bumped on each save). */
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

/** Read-only view over a target, as another member would attach it. */
const view = (t: BackupTarget): PeerSource => ({
	label: `view:${t.kind}`,
	load: () => t.load(),
	stat: () => t.stat!()
});

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
		app: `mirrors-${++seq}`,
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

/** A member whose wallet is their own UNTOUCHED file (plaintext by default). */
async function member(id: string, password?: string) {
	const m = makeStore({ accounts: [{ id }] });
	await m.store.init();
	const t = memTarget();
	await m.store.attachTarget(t.target, { strategy: 'replace-remote', password });
	return { ...m, t };
}

async function until(pred: () => boolean | Promise<boolean>, ms = 4000): Promise<void> {
	const t0 = Date.now();
	for (;;) {
		if (await pred()) return;
		if (Date.now() - t0 > ms) throw new Error('until: timed out');
		await new Promise((r) => setTimeout(r, 15));
	}
}

const KEY = 'share-key-1';

describe('mirrors: published copies under their own key', () => {
	it('publishes on attach, follows every edit, and never touches the wallet', async () => {
		const a = await member('a1');
		const m = memTarget();
		a.store.attachMirror(m.target, { password: KEY });

		// The copy exists promptly, sealed under the MIRROR key...
		await until(() => m.remote !== null);
		expect((await inspect(m.remote!)).encryption).not.toBe('none');
		const first = await importSnapshot(m.remote!, { password: KEY });
		expect(ids(first.collections.accounts)).toEqual(['a1']);
		// ...while the wallet file stays plaintext, exactly as its owner chose.
		expect((await inspect(a.t.remote!)).encryption).toBe('none');

		// Every local edit reaches the copy.
		a.app.collections.accounts.push({ id: 'a2' });
		await a.store.flush();
		await until(async () => {
			const snap = await importSnapshot(m.remote!, { password: KEY });
			return ids(snap.collections.accounts).length === 2;
		});
		expect(a.store.state.mirrors[0].lastPublishAt).not.toBeNull();
		expect(a.store.state.mirrors[0].lastError).toBeNull();
	});

	it('crossed mirrors + keyed peers converge two PLAINTEXT wallets', async () => {
		const a = await member('a1');
		const b = await member('b1');
		const ma = memTarget();
		const mb = memTarget();
		a.store.attachMirror(ma.target, { password: KEY });
		b.store.attachMirror(mb.target, { password: KEY });
		await until(() => ma.remote !== null && mb.remote !== null);

		// Each reads the OTHER's copy with the share key - their own session
		// has no password at all (the wallets are plaintext).
		a.store.attachPeer(view(mb.target), { password: KEY });
		b.store.attachPeer(view(ma.target), { password: KEY });
		await a.store.syncNow();
		await b.store.syncNow();

		expect(ids(a.app.collections.accounts)).toEqual(['a1', 'b1']);
		expect(ids(b.app.collections.accounts)).toEqual(['a1', 'b1']);
		// Both wallets remain plaintext; both copies carry the union too.
		expect((await inspect(a.t.remote!)).encryption).toBe('none');
		expect((await inspect(b.t.remote!)).encryption).toBe('none');
		await until(async () => {
			const snap = await importSnapshot(ma.remote!, { password: KEY });
			return ids(snap.collections.accounts).length === 2;
		});
	});

	it('a keyed peer refuses a PLAINTEXT copy in its place (substitution guard, per-peer)', async () => {
		const a = await member('a1'); // publishes plaintext
		const b = await member('b1');
		b.store.attachPeer(view(a.t.target), { password: KEY });
		await b.store.syncNow();
		expect(b.store.state.peers[0].lastError?.code).toBe('UNEXPECTEDLY_UNENCRYPTED');
		expect(ids(b.app.collections.accounts)).toEqual(['b1']); // nothing folded
		expect(b.store.state.status.state).not.toBe('needs-attention'); // no gate
	});

	it('a broken mirror records its error, never gates, and heals on the next publish', async () => {
		const a = await member('a1');
		const m = memTarget();
		a.store.attachMirror(m.target, { password: KEY });
		await until(() => m.remote !== null);

		m.fail(new Error('boom'));
		a.app.collections.accounts.push({ id: 'a2' });
		await a.store.flush();
		expect(a.store.state.mirrors[0].lastError).not.toBeNull();
		expect(a.store.state.status.state).not.toBe('needs-attention');
		// The wallet's own save was never held hostage by the mirror.
		const own = await importSnapshot(a.t.remote!);
		expect(ids(own.collections.accounts)).toEqual(['a1', 'a2']);

		m.fail(null);
		a.app.collections.accounts.push({ id: 'a3' });
		await a.store.flush();
		await until(() => a.store.state.mirrors[0].lastError === null);
		const snap = await importSnapshot(m.remote!, { password: KEY });
		expect(ids(snap.collections.accounts)).toEqual(['a1', 'a2', 'a3']);
	});

	it('detachMirror stops publishing; the copy simply stops moving', async () => {
		const a = await member('a1');
		const m = memTarget();
		const id = a.store.attachMirror(m.target, { password: KEY });
		await until(() => m.remote !== null);
		const before = m.remote;

		a.store.detachMirror(id);
		a.app.collections.accounts.push({ id: 'a2' });
		await a.store.flush();
		expect(m.remote).toBe(before); // untouched since the detach
		expect(a.store.state.mirrors).toEqual([]);
	});
});
