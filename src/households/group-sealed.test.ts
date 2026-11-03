// @vitest-environment node
/**
 * Where the membership record lives. K, the mailbox id and the invitation
 * capability ARE the membership: handed the cache's sealed space, the engine
 * keeps them there, and a record an earlier version wrote in the clear moves
 * over on first load with its clear copy gone.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createLocalStore, type LocalStore } from '../persistence/store';
import { memoryCache, type LocalCache } from '../persistence/cache';
import type { BackupTarget, PeerSource } from '../persistence/target';
import type { Snapshot } from '../selfstore';
import { createHouseholdGroup, HOUSEHOLD_GROUP_KEY, type ShareBackend } from './group';
import type { CopyLink } from './codec';

function memTarget(): BackupTarget {
	let blob: Blob | null = null;
	let tag = 0;
	return {
		kind: 'mem',
		label: 'copy',
		async save(b) {
			blob = b;
			tag += 1;
			return String(tag);
		},
		async load() {
			return blob;
		},
		async stat() {
			return blob ? String(tag) : null;
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

/** A backend that only mints copies and bulletins: the record is the subject. */
function stubBackend(): ShareBackend {
	let copies = 0;
	return {
		async createCopy(existingFileId?: string) {
			return { provider: 'drive', fileId: existingFileId ?? `copy-${++copies}` } satisfies CopyLink;
		},
		copyTarget: () => memTarget(),
		async dropCopy() {},
		async publishBulletin(key) {
			return { fileId: 'bulletin-1', key };
		},
		async revokeBulletin() {},
		async openIncoming() {
			return null;
		},
		async takeStashedIncoming() {
			return null;
		},
		async rereadJoined() {
			return null;
		},
		async announce() {},
		async takeAnnounces() {
			return [];
		},
		peerSource(): PeerSource {
			return {
				label: 'peer',
				async load() {
					return null;
				},
				async stat() {
					return null;
				}
			};
		}
	};
}

const open: LocalStore[] = [];
afterEach(() => {
	for (const s of open.splice(0)) s.dispose();
});

async function makeStore(cache: LocalCache): Promise<LocalStore> {
	const store = createLocalStore({
		app: 'sealed-record',
		schemaVersion: 1,
		cache,
		sync: { fallback: 'lww-set' },
		gather: (): Snapshot => ({ collections: { records: [] }, files: [] }),
		apply: () => {},
		logger: { warn() {}, error() {} }
	});
	open.push(store);
	await store.init();
	return store;
}

describe('the membership record in the sealed space', () => {
	it('startShare writes K to the sealed kv and nothing to the clear one', async () => {
		const cache = memoryCache();
		const store = await makeStore(cache);
		const group = createHouseholdGroup({
			store,
			kv: cache.kv,
			sealedKv: cache.sealedKv,
			backend: stubBackend()
		});
		const { key } = await group.startShare();
		expect(await cache.kv.get(HOUSEHOLD_GROUP_KEY)).toBeUndefined();
		const sealed = await cache.sealedKv!.get<{ groups: { key: string }[] }>(HOUSEHOLD_GROUP_KEY);
		expect(sealed?.groups.map((g) => g.key)).toEqual([key]);
	});

	it('a record left in the clear by an earlier version moves over on first load', async () => {
		const cache = memoryCache();
		const store = await makeStore(cache);
		const legacy = {
			v: 2,
			groups: [
				{
					role: 'admin',
					key: 'K-legacy',
					mailboxId: 'mailbox-legacy',
					roster: [{ provider: 'drive', fileId: 'copy-legacy' }],
					myCopy: { provider: 'drive', fileId: 'copy-legacy' },
					bulletin: { fileId: 'bulletin-legacy', key: 'K-legacy' },
					live: true
				}
			]
		};
		await cache.kv.set(HOUSEHOLD_GROUP_KEY, legacy);
		const group = createHouseholdGroup({
			store,
			kv: cache.kv,
			sealedKv: cache.sealedKv,
			backend: stubBackend()
		});
		await group.restore();
		expect(group.state.active).toBe(true);
		expect(group.state.inviteCapability).toEqual({ fileId: 'bulletin-legacy', key: 'K-legacy' });
		expect(await cache.kv.get(HOUSEHOLD_GROUP_KEY)).toBeUndefined();
		expect(await cache.sealedKv!.get(HOUSEHOLD_GROUP_KEY)).toEqual(legacy);
	});

	it('leave() clears the sealed record', async () => {
		const cache = memoryCache();
		const store = await makeStore(cache);
		const group = createHouseholdGroup({
			store,
			kv: cache.kv,
			sealedKv: cache.sealedKv,
			backend: stubBackend()
		});
		await group.startShare();
		await group.leave();
		expect(await cache.sealedKv!.get(HOUSEHOLD_GROUP_KEY)).toBeUndefined();
		expect(group.state.active).toBe(false);
	});

	it('without a sealed space the record stays in kv, as before', async () => {
		const cache = memoryCache();
		const store = await makeStore(cache);
		const group = createHouseholdGroup({ store, kv: cache.kv, backend: stubBackend() });
		await group.startShare();
		expect(await cache.kv.get(HOUSEHOLD_GROUP_KEY)).toBeDefined();
	});
});
