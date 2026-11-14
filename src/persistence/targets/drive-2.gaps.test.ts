import { describe, it, expect, vi } from 'vitest';
import { fromSession, FILE_ID_KEY, type DriveOptions, type DriveAuth } from './drive';
import type { KV } from '../cache';

function mockKV(seed: Record<string, unknown> = {}): KV {
	const m = new Map<string, unknown>(Object.entries(seed));
	return {
		async get<T = unknown>(k: string): Promise<T | undefined> {
			return m.get(k) as T | undefined;
		},
		async set(k: string, v: unknown): Promise<void> {
			m.set(k, v);
		},
		async del(k: string): Promise<void> {
			m.delete(k);
		}
	};
}

function makeAuth(reconnectResult: boolean): DriveAuth {
	return {
		async token(): Promise<string> {
			return 'tkn';
		},
		reconnect: vi.fn(async () => reconnectResult),
		async forget(): Promise<void> {}
	};
}

describe('drive reconnect', () => {
	it('returns true when auth.reconnect() resolves true', async () => {
		const auth = makeAuth(true);
		const target = await fromSession({
			auth,
			kv: mockKV({ [FILE_ID_KEY]: 'fid' }),
			fileName: 'b'
		} satisfies DriveOptions);

		expect(target).not.toBeNull();
		expect(await target!.reconnect()).toBe(true);
		expect(auth.reconnect).toHaveBeenCalledOnce();
	});

	it('returns false when auth.reconnect() resolves false', async () => {
		const auth = makeAuth(false);
		const target = await fromSession({
			auth,
			kv: mockKV({ [FILE_ID_KEY]: 'fid' }),
			fileName: 'b'
		} satisfies DriveOptions);

		expect(target).not.toBeNull();
		expect(await target!.reconnect()).toBe(false);
		expect(auth.reconnect).toHaveBeenCalledOnce();
	});
});
