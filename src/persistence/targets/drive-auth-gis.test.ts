// @vitest-environment happy-dom
/**
 * The client-only DriveAuth. What is tested here is how OFTEN a user is
 * interrupted, because that is the whole point of this file: a reload inside the
 * hour must ask for nothing, a re-grant must not re-show a consent screen over a
 * live grant (Google mails the user each time it does), and the account must not
 * have to be picked again.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { gisDriveAuth } from './drive-auth-gis';

type Req = { prompt: string; hint?: string; clientId: string };

/** A stand-in for Google Identity Services. `answer` decides each request. */
function stubGIS(answer: (req: Req, n: number) => { token?: string; error?: string }) {
	const seen: Req[] = [];
	(globalThis.window as unknown as { google: unknown }).google = {
		accounts: {
			oauth2: {
				initTokenClient(cfg: {
					client_id: string;
					hint?: string;
					callback: (r: { access_token?: string; expires_in?: number; error?: string }) => void;
					error_callback: (e: { type?: string }) => void;
				}) {
					return {
						requestAccessToken({ prompt }: { prompt: string }) {
							const req = { prompt, hint: cfg.hint, clientId: cfg.client_id };
							seen.push(req);
							const r = answer(req, seen.length);
							if (r.token) cfg.callback({ access_token: r.token, expires_in: 3600 });
							else cfg.error_callback({ type: r.error ?? 'refused' });
						}
					};
				}
			}
		}
	};
	return seen;
}

const auth = (over: Partial<Parameters<typeof gisDriveAuth>[0]> = {}) =>
	gisDriveAuth({ clientId: 'cid', ...over });

beforeEach(() => {
	sessionStorage.clear();
	vi.unstubAllGlobals();
});

describe('gisDriveAuth - how often the user is interrupted', () => {
	it('asks Google once, then serves the token it holds', async () => {
		const seen = stubGIS(() => ({ token: 'tok-1' }));
		const a = auth();

		expect(await a.token()).toBe('tok-1');
		expect(await a.token()).toBe('tok-1');

		expect(seen).toHaveLength(1); // the second call cost nothing
	});

	it('persist "session" survives a reload; the default does not', async () => {
		const seen = stubGIS(() => ({ token: 'tok-1' }));
		await auth({ persist: 'session' }).token();

		// A reload is a NEW auth over the same storage: nothing must be asked.
		const seenAfter = seen.length;
		expect(await auth({ persist: 'session' }).token()).toBe('tok-1');
		expect(seen).toHaveLength(seenAfter);

		// Memory-only is the default, and it deliberately re-asks.
		sessionStorage.clear();
		await auth().token();
		expect(await auth().token()).toBe('tok-1');
		expect(seen.length).toBeGreaterThan(seenAfter + 1);
	});

	it('never persists the token unless asked', async () => {
		stubGIS(() => ({ token: 'tok-1' }));

		await auth().token();

		// The whole trade-off: no Drive-scoped credential in web storage by default.
		expect(Object.keys(sessionStorage)).toEqual([]);
	});

	it('a token Google rejects leaves storage, so a reload cannot start from it', async () => {
		const seen = stubGIS((_r, n) => ({ token: `tok-${n}` }));
		const a = auth({ persist: 'session' });
		await a.token();

		expect(await a.token({ forceRefresh: true })).toBe('tok-2');

		expect(JSON.parse(sessionStorage.getItem('selfstore.drive.token.cid')!).token).toBe('tok-2');
		expect(seen[1].prompt).toBe('');
	});

	it('a corrupt entry is dropped, not carried', async () => {
		stubGIS(() => ({ token: 'tok-fresh' }));
		sessionStorage.setItem('selfstore.drive.token.cid', '{not json');

		expect(await auth({ persist: 'session' }).token()).toBe('tok-fresh');
	});

	it('reconnect tries silently BEFORE the consent screen', async () => {
		// The consent screen is what makes Google mail "you granted access" - over
		// a grant already on file it re-asks an answered question.
		const seen = stubGIS(() => ({ token: 'tok-1' }));

		expect(await auth().reconnect()).toBe(true);

		expect(seen.map((r) => r.prompt)).toEqual(['']);
	});

	it('falls back to consent only when the silent request fails', async () => {
		const seen = stubGIS((r) => (r.prompt === '' ? { error: 'no_session' } : { token: 'tok-1' }));

		expect(await auth().reconnect()).toBe(true);

		expect(seen.map((r) => r.prompt)).toEqual(['', 'consent']);
	});

	it('reports a refusal instead of throwing when both attempts fail', async () => {
		stubGIS(() => ({ error: 'access_denied' }));

		expect(await auth().reconnect()).toBe(false);
	});

	it('names the account so the chooser does not appear, value or callback', async () => {
		const seen = stubGIS(() => ({ token: 'tok-1' }));

		await auth({ hint: 'someone@example.com' }).token();
		let learnt: string | null = null;
		const late = auth({ hint: () => learnt });
		await late.token({ forceRefresh: true });
		learnt = 'later@example.com';
		await late.token({ forceRefresh: true });

		expect(seen[0].hint).toBe('someone@example.com');
		expect(seen[1].hint).toBeUndefined(); // not known yet: no hint rather than a wrong one
		expect(seen[2].hint).toBe('later@example.com');
	});

	it('forget() takes the token out of storage too', async () => {
		stubGIS(() => ({ token: 'tok-1' }));
		const a = auth({ persist: 'session' });
		await a.token();

		await a.forget();

		expect(sessionStorage.getItem('selfstore.drive.token.cid')).toBeNull();
	});

	it('namespaces by client id, so two apps on one origin stay apart', async () => {
		stubGIS(() => ({ token: 'tok-a' }));
		await gisDriveAuth({ clientId: 'app-a', persist: 'session' }).token();

		expect(sessionStorage.getItem('selfstore.drive.token.app-a')).not.toBeNull();
		expect(sessionStorage.getItem('selfstore.drive.token.app-b')).toBeNull();
	});

	it('degrades to memory when web storage throws', async () => {
		const seen = stubGIS(() => ({ token: 'tok-1' }));
		vi.stubGlobal('sessionStorage', {
			getItem() {
				throw new Error('blocked');
			},
			setItem() {
				throw new Error('blocked');
			},
			removeItem() {
				throw new Error('blocked');
			}
		});

		const a = auth({ persist: 'session' });
		expect(await a.token()).toBe('tok-1');
		expect(await a.token()).toBe('tok-1'); // memory still answers
		expect(seen).toHaveLength(1);
	});
});
