import { describe, it, expect, vi } from 'vitest';
import { adopt, FILE_ID_KEY } from './drive';
import type { DriveOptions, DriveAuth } from './drive';
import type { KV } from '../cache';

function memKV(seed: Record<string, unknown> = {}): KV {
	const m = new Map<string, unknown>(Object.entries(seed));
	return {
		async get<T = unknown>(k: string) {
			return m.get(k) as T | undefined;
		},
		async set(k, v) {
			m.set(k, v);
		},
		async del(k) {
			m.delete(k);
		}
	};
}

function mockAuth(): DriveAuth {
	return {
		async token() {
			return 'mock-token';
		},
		async reconnect() {
			return true;
		},
		async forget() {}
	};
}

describe('adopt', () => {
	it('stores the fileId in KV and returns a target', async () => {
		const kv = memKV();
		const setSpy = vi.spyOn(kv, 'set');
		const auth = mockAuth();
		const opts: DriveOptions = { kv, auth, fileName: 'test.backup' };
		const fileId = 'someFileId';
		const target = await adopt(opts, fileId);
		expect(setSpy).toHaveBeenCalledWith(FILE_ID_KEY, fileId);
		expect(await kv.get<string>(FILE_ID_KEY)).toBe(fileId);
		expect(target).toBeTruthy();
	});
});
