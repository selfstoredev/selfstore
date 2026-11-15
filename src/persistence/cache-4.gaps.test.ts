import 'fake-indexeddb/auto';
import { describe, it, expect } from 'vitest';
import { openDB } from 'idb';
import { seal, isEnvelope } from './cache-crypto';
import { indexedDbCache } from './cache';
import { SelfstoreError } from '../selfstore/errors';

describe('openFileMeta validates decrypted metadata', () => {
	it('throws BAD_FORMAT when unsealed meta lacks name', async () => {
		const cache = indexedDbCache('cache-meta-test-1');
		await cache.saveCollections({ notes: [] });
		await cache.saveFiles([
			{ id: 'f1', name: 'ok.txt', mime: 'text/plain', blob: new Blob(['data']) }
		]);

		const db = await openDB('cache-meta-test-1');
		const raw = (await db.get('files', 'f1')) as Record<string, unknown>;
		expect(isEnvelope(raw)).toBe(true);
		expect(isEnvelope(raw.meta)).toBe(true);

		const deviceKey = (await db.get('kv', '__deviceKey')) as CryptoKey;
		const badMeta = await seal(
			deviceKey,
			new TextEncoder().encode(JSON.stringify({ mime: 'text/plain' }))
		);
		await db.put('files', { ...raw, meta: badMeta }, 'f1');
		db.close();

		const error = await cache.load().catch((e: unknown) => e);
		expect(error).toBeInstanceOf(SelfstoreError);
		expect(error).toMatchObject({
			code: 'BAD_FORMAT',
			message: 'Unrecognized cache record (file name or type missing).'
		});
	});

	it('throws BAD_FORMAT when unsealed meta has non-string mime', async () => {
		const cache = indexedDbCache('cache-meta-test-2');
		await cache.saveCollections({ notes: [] });
		await cache.saveFiles([
			{ id: 'f2', name: 'ok.txt', mime: 'text/plain', blob: new Blob(['data']) }
		]);

		const db = await openDB('cache-meta-test-2');
		const raw = (await db.get('files', 'f2')) as Record<string, unknown>;
		const deviceKey = (await db.get('kv', '__deviceKey')) as CryptoKey;
		const badMeta = await seal(
			deviceKey,
			new TextEncoder().encode(JSON.stringify({ name: 'x', mime: true }))
		);
		await db.put('files', { ...raw, meta: badMeta }, 'f2');
		db.close();

		const error = await cache.load().catch((e: unknown) => e);
		expect(error).toBeInstanceOf(SelfstoreError);
		expect(error).toMatchObject({
			code: 'BAD_FORMAT',
			message: 'Unrecognized cache record (file name or type missing).'
		});
	});
});
