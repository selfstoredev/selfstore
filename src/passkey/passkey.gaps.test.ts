// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { passkeyUnlock } from './passkey';

const OPTIONS = { appName: 'Test app', salt: 'test-salt-v1' };

function defineGlobal(name: string, value: unknown): void {
	Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

function setupBrowser(available: boolean | Error): void {
	const mock = vi.fn();
	if (available instanceof Error) mock.mockRejectedValue(available);
	else mock.mockResolvedValue(available);

	defineGlobal('window', {
		PublicKeyCredential: { isUserVerifyingPlatformAuthenticatorAvailable: mock }
	});
	defineGlobal('navigator', { credentials: {} });
	defineGlobal('crypto', { subtle: {}, getRandomValues: (arr: Uint8Array) => arr });
	defineGlobal('localStorage', { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() });
}

const GLOBAL_KEYS = ['window', 'navigator', 'crypto', 'localStorage'] as const;

describe('passkeyUnlock.available', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
		for (const key of GLOBAL_KEYS) {
			Reflect.deleteProperty(globalThis, key);
		}
	});

	it('returns true when platform authenticator is available', async () => {
		setupBrowser(true);
		const unlock = passkeyUnlock(OPTIONS);
		expect(await unlock.available()).toBe(true);
	});

	it('returns false when platform authenticator is not available', async () => {
		setupBrowser(false);
		const unlock = passkeyUnlock(OPTIONS);
		expect(await unlock.available()).toBe(false);
	});

	it('returns false when the availability check throws', async () => {
		setupBrowser(new Error('Not allowed'));
		const unlock = passkeyUnlock(OPTIONS);
		expect(await unlock.available()).toBe(false);
	});

	it('returns false when WebAuthn is not usable', async () => {
		defineGlobal('window', {});
		defineGlobal('navigator', { credentials: {} });
		defineGlobal('crypto', { subtle: {} });
		const unlock = passkeyUnlock(OPTIONS);
		expect(await unlock.available()).toBe(false);
	});
});
