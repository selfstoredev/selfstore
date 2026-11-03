/**
 * The sealed kv space: bookkeeping that is itself a secret (a share key, a
 * mailbox id) must be ciphertext in a dump like the collections are, follow
 * the lock of a locked cache, and move with the secret when it changes.
 */

import 'fake-indexeddb/auto';
import { describe, it, expect } from 'vitest';
import { openDB } from 'idb';
import { indexedDbCache, memoryCache } from './cache';
import { newDeviceKey } from './cache-crypto';

const secret = { key: 'K-the-link-fragment-key', mailboxId: 'mailbox-7' };

let n = 0;
const freshName = () => `cache-sealed-kv-${++n}`;

async function rawKv(name: string, key: string): Promise<unknown> {
	const d = await openDB(name);
	try {
		return await d.get('kv', key);
	} finally {
		d.close();
	}
}

describe('sealed kv', () => {
	it('round-trips a value and keeps nothing readable at rest', async () => {
		const name = freshName();
		const cache = indexedDbCache(name);
		await cache.sealedKv!.set('share', secret);
		expect(await cache.sealedKv!.get('share')).toEqual(secret);
		const stored = JSON.stringify(await rawKv(name, 's:share'), (_k, v: unknown) =>
			v instanceof ArrayBuffer ? Array.from(new Uint8Array(v)) : v
		);
		expect(stored).not.toContain('K-the-link');
		expect(stored).not.toContain('mailbox-7');
		// The plain kv space does not see it either way.
		expect(await cache.kv.get('share')).toBeUndefined();
		await cache.sealedKv!.del('share');
		expect(await cache.sealedKv!.get('share')).toBeUndefined();
	});

	it('a locked cache refuses the sealed kv until unlock()', async () => {
		const cache = indexedDbCache(freshName(), { lock: true });
		// An absent record says nothing and needs no key.
		expect(await cache.sealedKv!.get('share')).toBeUndefined();
		await expect(cache.sealedKv!.set('share', secret)).rejects.toMatchObject({
			code: 'PASSWORD_REQUIRED'
		});
		await cache.unlock(await newDeviceKey());
		await cache.sealedKv!.set('share', secret);
		cache.lockNow();
		await expect(cache.sealedKv!.get('share')).rejects.toMatchObject({
			code: 'PASSWORD_REQUIRED'
		});
	});

	it('reseal() moves the sealed kv under the new secret', async () => {
		const name = freshName();
		const cache = indexedDbCache(name, { lock: true });
		const first = await newDeviceKey();
		const second = await newDeviceKey();
		await cache.unlock(first);
		await cache.saveCollections({ notes: [] });
		await cache.sealedKv!.set('share', secret);
		await cache.reseal(second);
		expect(await cache.sealedKv!.get('share')).toEqual(secret);
		// A fresh session: the old secret no longer opens the cache, the new one
		// reads the share back.
		const again = indexedDbCache(name, { lock: true });
		expect(await again.unlock(first)).toBe(false);
		expect(await again.unlock(second)).toBe(true);
		expect(await again.sealedKv!.get('share')).toEqual(secret);
	});

	it('clear() wipes the sealed space with the rest', async () => {
		const name = freshName();
		const cache = indexedDbCache(name);
		await cache.sealedKv!.set('share', secret);
		await cache.clear();
		expect(await rawKv(name, 's:share')).toBeUndefined();
	});

	it('the memory cache keeps the two spaces apart', async () => {
		const cache = memoryCache();
		await cache.sealedKv!.set('share', secret);
		expect(await cache.kv.get('share')).toBeUndefined();
		expect(await cache.sealedKv!.get('share')).toEqual(secret);
		await cache.clear();
		expect(await cache.sealedKv!.get('share')).toBeUndefined();
	});
});
