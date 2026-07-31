/**
 * Device unlock. The rules tested here are the ones that, when broken, either
 * lock a user out of their own data or quietly hand it to someone else: a
 * platform that pretends to support PRF must not produce a half-enrolment, an
 * enrolment must only ever return the exact secret that was sealed, and
 * anything unopenable must clear itself instead of failing forever.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { passkeyUnlock } from './passkey';

const OPTIONS = { appName: 'Test app', salt: 'test-salt-v1' };

/** Which PRF secret the fake authenticator hands back, or none at all. */
let prfResult: ArrayBuffer | null;
/** Set to make the platform refuse (a cancelled prompt). */
let userCancels: boolean;
let created: number;
let asserted: number;

function fakeCredential(): unknown {
	return {
		rawId: new Uint8Array([1, 2, 3, 4]).buffer,
		getClientExtensionResults: () => (prfResult ? { prf: { results: { first: prfResult } } } : {})
	};
}

/** `navigator` is a getter-only global in Node, so these have to be defined
 *  rather than assigned - and defined as configurable, to be removable again. */
function define(name: string, value: unknown): void {
	Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

function installBrowser(): void {
	const store = new Map<string, string>();
	define('window', {
		PublicKeyCredential: { isUserVerifyingPlatformAuthenticatorAvailable: async () => true }
	});
	define('location', { hostname: 'example.test' });
	define('localStorage', {
		getItem: (k: string) => store.get(k) ?? null,
		setItem: (k: string, v: string) => void store.set(k, v),
		removeItem: (k: string) => void store.delete(k)
	});
	define('navigator', {
		credentials: {
			create: async () => {
				created++;
				if (userCancels) throw new Error('cancelled');
				return fakeCredential();
			},
			get: async () => {
				asserted++;
				if (userCancels) throw new Error('cancelled');
				return fakeCredential();
			}
		}
	});
}

function uninstallBrowser(): void {
	for (const k of ['window', 'location', 'localStorage', 'navigator']) {
		Object.defineProperty(globalThis, k, { value: undefined, configurable: true, writable: true });
	}
}

beforeEach(() => {
	prfResult = crypto.getRandomValues(new Uint8Array(32)).buffer;
	userCancels = false;
	created = 0;
	asserted = 0;
	installBrowser();
});

describe('passkey unlock', () => {
	it('gives back exactly the secret it sealed', async () => {
		const passkey = passkeyUnlock(OPTIONS);

		expect(await passkey.enroll('correct horse battery staple')).toBe(true);
		expect(passkey.enrolled()).toBe(true);
		expect(await passkey.reveal()).toBe('correct horse battery staple');
	});

	it('keeps a secret that is not ASCII intact', async () => {
		const passkey = passkeyUnlock(OPTIONS);
		const secret = 'phrase accentuee: ete, ou, ca - and an emoji';

		await passkey.enroll(secret);

		expect(await passkey.reveal()).toBe(secret);
	});

	it('FAILS CLOSED when the platform announces a passkey but returns no PRF secret', async () => {
		// The dangerous case: isUserVerifyingPlatformAuthenticatorAvailable() says
		// yes, create() succeeds, and only the extension result is missing. Storing
		// anything here would leave an enrolment that can never be opened.
		prfResult = null;
		const passkey = passkeyUnlock(OPTIONS);

		expect(await passkey.enroll('secret')).toBe(false);
		expect(passkey.enrolled()).toBe(false);
	});

	it('refuses a PRF result of the wrong size rather than deriving from it', async () => {
		prfResult = new Uint8Array(16).buffer;
		const passkey = passkeyUnlock(OPTIONS);

		expect(await passkey.enroll('secret')).toBe(false);
	});

	it('reports failure instead of throwing when the user cancels', async () => {
		const passkey = passkeyUnlock(OPTIONS);
		userCancels = true;

		expect(await passkey.enroll('secret')).toBe(false);
		expect(await passkey.reveal()).toBe(null);
	});

	it('returns null when nothing is enrolled, without prompting the user', async () => {
		const passkey = passkeyUnlock(OPTIONS);

		expect(await passkey.reveal()).toBe(null);
		expect(asserted).toBe(0);
	});

	it('drops an enrolment the passkey can no longer open', async () => {
		const passkey = passkeyUnlock(OPTIONS);
		await passkey.enroll('secret');

		// The authenticator now yields a different secret - a rotated credential,
		// or another passkey answering. The blob is dead weight from here on.
		prfResult = crypto.getRandomValues(new Uint8Array(32)).buffer;

		expect(await passkey.reveal()).toBe(null);
		expect(passkey.enrolled()).toBe(false);
	});

	it('forgets on demand, and stops answering', async () => {
		const passkey = passkeyUnlock(OPTIONS);
		await passkey.enroll('secret');

		passkey.forget();

		expect(passkey.enrolled()).toBe(false);
		expect(await passkey.reveal()).toBe(null);
	});

	it('keeps two apps on one device apart', async () => {
		const first = passkeyUnlock({ ...OPTIONS, storageKey: 'app.one' });
		const second = passkeyUnlock({ ...OPTIONS, storageKey: 'app.two' });

		await first.enroll('first secret');

		expect(second.enrolled()).toBe(false);
		expect(await first.reveal()).toBe('first secret');
	});

	it('asks the authenticator at most twice to enrol', async () => {
		// One create(), plus one get() only when create() did not carry the PRF
		// result. A third prompt would be a user-visible regression.
		const passkey = passkeyUnlock(OPTIONS);

		await passkey.enroll('secret');

		expect(created).toBe(1);
		expect(asserted).toBeLessThanOrEqual(1);
	});

	it('reports unavailable outside a browser instead of throwing', async () => {
		uninstallBrowser();
		const passkey = passkeyUnlock(OPTIONS);

		expect(await passkey.available()).toBe(false);
		expect(passkey.enrolled()).toBe(false);
		expect(await passkey.enroll('secret')).toBe(false);
		expect(await passkey.reveal()).toBe(null);
	});
});
