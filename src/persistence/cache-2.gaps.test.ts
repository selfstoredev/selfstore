import 'fake-indexeddb/auto';
import { describe, it, expect } from 'vitest';
import { openDB } from 'idb';
import { indexedDbCache } from './cache';
import { SelfstoreError } from '../selfstore/errors';

let n = 0;
const freshName = () => `cache-test-${++n}`;

interface FakeEncFile {
	iv: Uint8Array;
	data: Uint8Array;
	meta: unknown;
}

describe('BAD_FORMAT on non-envelope file meta', () => {
	it('throws BAD_FORMAT when a file record has a non-envelope meta', async () => {
		const name = freshName();
		const cache = indexedDbCache(name, { lock: true });
		await cache.unlock('secret1');

		const db = await openDB(name);
		const corrupted: FakeEncFile = {
			iv: new Uint8Array([1, 2, 3]),
			data: new Uint8Array(),
			meta: 'not-an-envelope'
		};
		await db.put('files', corrupted, 'badfile');
		await db.close();

		await expect(cache.reseal('secret2')).rejects.toSatisfy((e) => {
			return (
				e instanceof SelfstoreError &&
				e.code === 'BAD_FORMAT' &&
				e.message === 'Unrecognized cache record (not a sealed envelope).'
			);
		});
	});
});
