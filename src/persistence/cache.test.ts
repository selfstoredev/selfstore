/**
 * The sealed IndexedDB cache. This surface holds the user's data at rest, and
 * every rule here is one that, when broken, loses it: a wrong secret must not
 * open the cache, clearing must leave nothing an old key still governs, and
 * changing the secret must never strand the data between two keys.
 */

import 'fake-indexeddb/auto';
import { describe, it, expect } from 'vitest';
import { indexedDbCache } from './cache';

const snapshot = { notes: [{ id: 'n1', text: 'hello' }] };

// A fresh database per test: IndexedDB is global, and a shared name would let
// one test's salt decide another's outcome.
let n = 0;
const freshCache = () => indexedDbCache(`cache-test-${++n}`, { lock: true });

describe('sealed cache', () => {
	it('accepts the first secret and gives the data back', async () => {
		const cache = freshCache();
		expect(await cache.unlock('a-long-passphrase')).toBe(true);
		await cache.saveCollections(snapshot);
		expect((await cache.load())?.collections).toEqual(snapshot);
	});

	it('refuses a secret that does not open what is already there', async () => {
		const cache = freshCache();
		await cache.unlock('the-right-passphrase');
		await cache.saveCollections(snapshot);
		cache.lockNow();

		expect(await cache.unlock('a-wrong-passphrase')).toBe(false);
		expect(cache.locked).toBe(true); // a failed attempt leaves it shut, not half-open
		expect(await cache.unlock('the-right-passphrase')).toBe(true);
	});

	it('reads nothing while locked, rather than returning an empty cache', async () => {
		const cache = freshCache();
		await cache.unlock('the-right-passphrase');
		await cache.saveCollections(snapshot);
		cache.lockNow();

		// Answering "empty" would invite the app to save over real data.
		await expect(cache.load()).rejects.toMatchObject({ code: 'PASSWORD_REQUIRED' });
	});

	it('clear() needs no secret, so a forgotten passphrase is not a dead end', async () => {
		const cache = freshCache();
		await cache.unlock('the-right-passphrase');
		await cache.saveCollections(snapshot);
		cache.lockNow();

		await cache.clear(); // the way out of an unopenable cache
		expect(await cache.unlock('a-brand-new-passphrase')).toBe(true);
		expect(await cache.load()).toBeNull();
	});

	describe('reseal', () => {
		it('swaps the secret and keeps every byte', async () => {
			const cache = freshCache();
			await cache.unlock('the-first-passphrase');
			await cache.saveCollections(snapshot);

			await cache.reseal('the-second-passphrase');
			expect((await cache.load())?.collections).toEqual(snapshot); // still open

			cache.lockNow();
			expect(await cache.unlock('the-first-passphrase')).toBe(false); // the old one is dead
			expect(await cache.unlock('the-second-passphrase')).toBe(true);
			expect((await cache.load())?.collections).toEqual(snapshot); // and intact
		});

		it('re-seals the files too, not only the collections', async () => {
			const cache = freshCache();
			await cache.unlock('the-first-passphrase');
			await cache.saveCollections(snapshot);
			await cache.saveFiles([
				{ id: 'f1', name: 'note.txt', mime: 'text/plain', blob: new Blob(['bytes']) }
			]);

			await cache.reseal('the-second-passphrase');
			cache.lockNow();
			await cache.unlock('the-second-passphrase');

			const loaded = await cache.load();
			expect(loaded?.files).toHaveLength(1);
			expect(await loaded?.files[0].blob.text()).toBe('bytes');
		});

		it('refuses while locked: what cannot be read cannot be re-sealed', async () => {
			const cache = freshCache();
			await cache.unlock('the-right-passphrase');
			await cache.saveCollections(snapshot);
			cache.lockNow();

			await expect(cache.reseal('another-passphrase')).rejects.toMatchObject({
				code: 'PASSWORD_REQUIRED'
			});
		});

		it('accepts an app-supplied key, for a passkey or hardware secret', async () => {
			const cache = freshCache();
			await cache.unlock('the-first-passphrase');
			await cache.saveCollections(snapshot);

			const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
				'encrypt',
				'decrypt'
			]);
			await cache.reseal(key);
			cache.lockNow();

			expect(await cache.unlock(key)).toBe(true);
			expect((await cache.load())?.collections).toEqual(snapshot);
		});
	});
});
