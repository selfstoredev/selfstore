// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { indexedDbCache } from './cache';

describe('requestPersistent', () => {
	let originalNavigator: Navigator;

	beforeEach(() => {
		originalNavigator = global.navigator;
		const storage = {
			persist: vi.fn<() => Promise<boolean>>(),
			persisted: vi.fn<() => Promise<boolean>>()
		};
		Object.defineProperty(global, 'navigator', {
			value: { storage },
			writable: true,
			configurable: true
		});
	});

	afterEach(() => {
		Object.defineProperty(global, 'navigator', {
			value: originalNavigator,
			writable: true,
			configurable: true
		});
		vi.restoreAllMocks();
	});

	it('returns true when storage is already persisted', async () => {
		const cache = indexedDbCache('test-persist-1');
		(navigator.storage.persisted as ReturnType<typeof vi.fn>).mockResolvedValue(true);

		const result = await cache.requestPersistent?.();

		expect(result).toBe(true);
		expect(navigator.storage.persisted).toHaveBeenCalledOnce();
		expect(navigator.storage.persist).not.toHaveBeenCalled();
	});

	it('returns true when persist() succeeds', async () => {
		const cache = indexedDbCache('test-persist-2');
		(navigator.storage.persisted as ReturnType<typeof vi.fn>).mockResolvedValue(false);
		(navigator.storage.persist as ReturnType<typeof vi.fn>).mockResolvedValue(true);

		const result = await cache.requestPersistent?.();

		expect(result).toBe(true);
		expect(navigator.storage.persisted).toHaveBeenCalledOnce();
		expect(navigator.storage.persist).toHaveBeenCalledOnce();
	});

	it('returns false when persist() returns false', async () => {
		const cache = indexedDbCache('test-persist-3');
		(navigator.storage.persisted as ReturnType<typeof vi.fn>).mockResolvedValue(false);
		(navigator.storage.persist as ReturnType<typeof vi.fn>).mockResolvedValue(false);

		const result = await cache.requestPersistent?.();

		expect(result).toBe(false);
		expect(navigator.storage.persisted).toHaveBeenCalledOnce();
		expect(navigator.storage.persist).toHaveBeenCalledOnce();
	});

	it('returns false when an exception is thrown', async () => {
		const cache = indexedDbCache('test-persist-4');
		(navigator.storage.persisted as ReturnType<typeof vi.fn>).mockRejectedValue(
			new Error('denied')
		);

		const result = await cache.requestPersistent?.();

		expect(result).toBe(false);
		expect(navigator.storage.persisted).toHaveBeenCalledOnce();
	});
});
