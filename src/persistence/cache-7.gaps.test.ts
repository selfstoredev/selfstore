/**
 * Tests the error recovery path in key(): when loadOrCreateKey rejects,
 * _key must be reset to null so a subsequent call retries.
 */

import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach } from 'vitest';

let newDeviceKeyImpl: () => Promise<CryptoKey>;

vi.mock('./cache-crypto', async () => {
	const actual = await vi.importActual('./cache-crypto');
	return {
		...actual,
		newDeviceKey: () => newDeviceKeyImpl()
	};
});

import { indexedDbCache } from './cache';

describe('key() error handling', () => {
	beforeEach(() => {
		newDeviceKeyImpl = async () => {
			throw new Error('KEY_GEN_FAILED');
		};
	});

	it('sets _key to null and throws when loadOrCreateKey fails', async () => {
		const cache = indexedDbCache('test-key-error');
		await expect(cache.saveCollections({})).rejects.toThrow('KEY_GEN_FAILED');

		const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [
			'encrypt',
			'decrypt'
		]);
		newDeviceKeyImpl = async () => key;

		await expect(cache.saveCollections({})).resolves.toBeUndefined();
	});
});
