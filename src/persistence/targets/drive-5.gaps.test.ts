import { describe, it, expect, vi } from 'vitest';
import { findOrCreateOwnFile } from './drive';
import type { KV } from '../cache';

function memKV(): KV {
	const m = new Map<string, unknown>();
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

describe('findOrCreateOwnFile', () => {
	it('creates the file when none exists', async () => {
		vi.stubGlobal(
			'fetch',
			vi
				.fn()
				.mockResolvedValueOnce(
					new Response(JSON.stringify({ files: [] }), {
						status: 200,
						headers: { 'Content-Type': 'application/json' }
					})
				)
				.mockResolvedValueOnce(
					new Response(JSON.stringify({ id: 'new_id_1' }), {
						status: 201,
						headers: { 'Content-Type': 'application/json' }
					})
				)
		);

		const out = await findOrCreateOwnFile({
			kv: memKV(),
			auth: {
				token: vi.fn().mockResolvedValue('tok'),
				reconnect: vi.fn().mockResolvedValue(true),
				forget: vi.fn()
			},
			fileName: 'selfstore.json'
		});

		expect(out).toEqual({ fileId: 'new_id_1', created: true });
	});
});
