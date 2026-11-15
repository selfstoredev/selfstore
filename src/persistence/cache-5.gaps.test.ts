import 'fake-indexeddb/auto';
import { describe, it, expect } from 'vitest';
import { openDB } from 'idb';
import { indexedDbCache } from './cache';
import { SelfstoreError } from '../selfstore/errors';

describe('decodeFile throws on bad envelope', () => {
	it('throws SelfstoreError with exact BAD_FORMAT message when a file record is not a sealed envelope', async () => {
		const name = `test-${Math.random().toString(36).slice(2)}`;
		const cache = indexedDbCache(name, { lock: false });

		// Write a valid collections snapshot so load proceeds to read files.
		await cache.saveCollections({ dummy: [] });

		// Manually inject a corrupted file record into the IndexedDB 'files' store.
		const db = await openDB(name, 1, {
			upgrade(db) {
				if (!db.objectStoreNames.contains('files')) {
					db.createObjectStore('files');
				}
			}
		});
		const corrupted = { name: 'bad', mime: 'txt' };
		await db.put('files', corrupted, 'bad-id');
		db.close();

		// Load should attempt to decode the corrupted entry and throw.
		await expect(cache.load()).rejects.toThrow(
			new SelfstoreError('BAD_FORMAT', 'Unrecognized cache record (not a sealed envelope).')
		);
	});
});
