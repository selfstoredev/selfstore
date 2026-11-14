import { describe, it, expect, beforeEach } from 'vitest';
import { fromSession, FILE_ID_KEY } from './drive';
import { AuthExpiredError } from '../../selfstore';
import type { DriveAuth, DriveOptions } from './drive';
import type { KV } from '../cache';

function memKV(seed: Record<string, unknown> = {}): KV {
	const m = new Map<string, unknown>(Object.entries(seed));
	return {
		async get<T = unknown>(k: string) {
			return m.get(k) as T | undefined;
		},
		async set(k: string, v: unknown) {
			m.set(k, v);
		},
		async del(k: string) {
			m.delete(k);
		}
	};
}

function createMockAuth(shouldThrow: boolean, error: Error): DriveAuth {
	return {
		async reconnect() {
			return true;
		},
		async token(_opts?: { forceRefresh?: boolean; signal?: AbortSignal }) {
			if (shouldThrow) throw error;
			return 'valid-token';
		},
		async forget() {}
	};
}

describe('DriveTarget isReady', () => {
	let kv: KV;
	let baseOpts: DriveOptions;

	beforeEach(() => {
		kv = memKV({ [FILE_ID_KEY]: 'test-file-id' });
		baseOpts = { auth: createMockAuth(false, new Error()), kv, fileName: 'test.backup' };
	});

	it('throws the exact AuthExpiredError when token throws an expired auth error', async () => {
		const expiredError = new AuthExpiredError('token expired');
		const opts = { ...baseOpts, auth: createMockAuth(true, expiredError) };
		const target = await fromSession(opts);
		if (!target) throw new Error('fromSession returned null');
		await expect(target.isReady()).rejects.toBe(expiredError);
	});

	it('returns false when token throws a non-expired error', async () => {
		const transientError = new Error('network error');
		const opts = { ...baseOpts, auth: createMockAuth(true, transientError) };
		const target = await fromSession(opts);
		if (!target) throw new Error('fromSession returned null');
		await expect(target.isReady()).resolves.toBe(false);
	});
});
