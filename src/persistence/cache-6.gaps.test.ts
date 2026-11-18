import 'fake-indexeddb/auto';
import { openDB } from 'idb';
import { describe, it, expect } from 'vitest';
import { indexedDbCache } from './cache';
import { SelfstoreError } from '../selfstore/errors';

describe('sealedKv.get throws on malformed envelope', () => {
	it('raises SelfstoreError BAD_FORMAT when raw value is not an envelope', async () => {
		const dbName = `cache-test-${Date.now()}-${Math.random()}`;
		const db = await openDB(dbName, 1, {
			upgrade(d) {
				d.createObjectStore('kv');
				d.createObjectStore('files');
			}
		});
		await db.put('kv', 'plain string', `s:foo`);
		db.close();

		const cache = indexedDbCache(dbName, { lock: false });
		let error: SelfstoreError | undefined;
		try {
			await cache.sealedKv!.get('foo');
		} catch (e) {
			error = e as SelfstoreError;
		}
		expect(error).toBeDefined();
		expect(error!.code).toBe('BAD_FORMAT');
		expect(error!.message).toBe('Unrecognized cache record (not a sealed envelope).');
	});
});
