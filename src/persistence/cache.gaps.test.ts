import { describe, it, expect } from 'vitest';
import {
	isLockableCache,
	memoryCache,
	type KV,
	type LocalCache,
	type LockableCache
} from './cache';

describe('isLockableCache', () => {
	it('returns true for a lockable cache', () => {
		const dummyKv: KV = {
			get: async () => undefined,
			set: async () => {},
			del: async () => {}
		};
		const lockable: LocalCache & LockableCache = {
			kv: dummyKv,
			sealedKv: undefined,
			load: async () => null,
			saveCollections: async () => {},
			saveFiles: async () => {},
			clear: async () => {},
			unlock: async () => false,
			reseal: async () => {},
			lockNow: () => {},
			locked: false
		};
		expect(isLockableCache(lockable)).toBe(true);
	});

	it('returns false for a non‑lockable cache', () => {
		const nonLockable = memoryCache();
		expect(isLockableCache(nonLockable)).toBe(false);
	});
});
