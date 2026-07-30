/**
 * A client-only DriveAuth: the Google Identity Services token flow, no backend.
 *
 * What this flow can and cannot do, because it decides how often a user is
 * interrupted. Google's browser token flow issues an access token that lives
 * about an hour and NO refresh token - a refresh token requires a client secret,
 * which requires a server. And `requestAccessToken` always opens a popup, even
 * with `prompt: ''`: the popup closes by itself when the grant is still on file,
 * but opening it at all needs a user gesture. So a purely client-side app cannot
 * silently re-acquire a token on page load. What it CAN do:
 *
 *   - reuse a token it already has (`persist: 'session'`), so a reload inside the
 *     hour asks for nothing at all;
 *   - name the account (`hint`), so the popup does not ask which one;
 *   - re-grant without the consent screen (`prompt: ''` before `'consent'`) -
 *     which is also what stops Google mailing "you granted access" every time.
 *
 * For a connection that never re-prompts, back the Drive target with a server
 * that holds a refresh token instead (a broker implementing this same DriveAuth).
 */

import type { DriveAuth } from './drive';

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
/** How long a token request may hang before it reads as failed. */
const TOKEN_TIMEOUT_MS = 120_000;
/** Refresh margin: a token this close to expiry counts as stale. */
const EXPIRY_MARGIN_MS = 60_000;
/** Google's default access-token lifetime, when the response omits expires_in. */
const DEFAULT_TOKEN_TTL_S = 3600;

let gisLoading: Promise<void> | null = null;
function loadGIS(): Promise<void> {
	if (typeof globalThis.window === 'undefined') return Promise.resolve();
	if (globalThis.window.google?.accounts) return Promise.resolve();
	gisLoading ??= new Promise<void>((resolve, reject) => {
		const s = document.createElement('script');
		s.src = 'https://accounts.google.com/gsi/client';
		s.async = true;
		s.onload = () => resolve();
		s.onerror = () => reject(new Error('GIS failed to load'));
		document.head.appendChild(s);
	});
	return gisLoading;
}

// prompt '' = no consent screen (the popup still opens, and closes on its own
// when the grant is on file); 'consent' = the full screen, every time.
// Module-level (not nested in gisDriveAuth) to keep the callback nesting shallow.
function requestToken(
	clientId: string,
	scope: string,
	prompt: string,
	hint: string | undefined,
	onToken: (token: string, expiry: number) => void
): Promise<string> {
	return new Promise((resolve, reject) => {
		let settled = false;
		const finish = (fn: () => void): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			fn();
		};
		const timer = setTimeout(() => finish(() => reject(new Error('timeout'))), TOKEN_TIMEOUT_MS);
		const client = globalThis.window.google!.accounts.oauth2.initTokenClient({
			client_id: clientId,
			scope,
			// Naming the account skips the chooser. A wrong or stale hint costs
			// nothing: Google falls back to asking, which is what it did anyway.
			...(hint ? { hint } : {}),
			callback(resp) {
				if (resp.error || !resp.access_token) {
					finish(() => reject(new Error(resp.error ?? 'token_failed')));
					return;
				}
				onToken(resp.access_token, Date.now() + (resp.expires_in ?? DEFAULT_TOKEN_TTL_S) * 1000);
				finish(() => resolve(resp.access_token!));
			},
			error_callback(err) {
				finish(() => reject(new Error(err?.type ?? 'gis_error')));
			}
		});
		client.requestAccessToken({ prompt });
	});
}

/** Where the access token survives between requests. */
export type GisTokenPersistence = 'memory' | 'session';

export interface GisDriveAuthOptions {
	clientId: string;
	scope?: string;
	/**
	 * The account to re-grant for, so the popup does not ask which one. Pass the
	 * address the app remembers (`driveTarget.account()` answers it once
	 * connected); a function is read at every request, for a host that only
	 * learns it after the first connect.
	 */
	hint?: string | (() => string | null | undefined);
	/**
	 * Where the access token lives between requests.
	 *
	 * `'memory'` (the default) keeps it in a closure and nowhere else: a reload
	 * has to re-acquire it, which needs a click, but no Drive-scoped credential is
	 * ever written to web storage.
	 *
	 * `'session'` also keeps it in `sessionStorage`, so a reload reuses the token
	 * it already has and asks for nothing. That token is a bearer credential for
	 * the `drive.file` scope, readable by any script on the origin; it dies with
	 * the tab and within the hour. Opt in for an app whose users reload often;
	 * leave it alone where an XSS on the origin must find nothing to lift.
	 */
	persist?: GisTokenPersistence;
}

/** Build a client-only DriveAuth for the given OAuth client id (no backend). */
export function gisDriveAuth(opts: GisDriveAuthOptions): DriveAuth {
	const scope = opts.scope ?? DRIVE_SCOPE;
	// Namespaced by client id: two apps sharing an origin (a dev host, a preview
	// deployment) must not read each other's token.
	const key = `selfstore.drive.token.${opts.clientId}`;
	// Every touch of web storage goes through this: a browser can refuse storage at
	// the property, or expose it and throw on read or write (private-mode
	// policies, embedded webviews, a full quota). Persistence is an optimisation -
	// none of those may break getting a token, so all three cases degrade to
	// memory instead of surfacing.
	const kept = <T>(job: (s: Storage) => T): T | undefined => {
		if (opts.persist !== 'session') return undefined;
		try {
			const s = globalThis.sessionStorage;
			return s ? job(s) : undefined;
		} catch {
			return undefined;
		}
	};

	let token: string | null = null;
	let expiry = 0;

	/** Read the persisted token when memory has none - i.e. after a reload. */
	function restore(): void {
		if (token) return;
		const raw = kept((s) => s.getItem(key));
		if (!raw) return;
		try {
			const held = JSON.parse(raw) as { token?: unknown; expiry?: unknown };
			if (typeof held.token === 'string' && typeof held.expiry === 'number') {
				token = held.token;
				expiry = held.expiry;
			}
		} catch {
			// A corrupt entry is dropped rather than carried: it would only surface
			// later as a 401 nobody could explain.
			kept((s) => s.removeItem(key));
		}
	}

	const fresh = (): boolean => !!token && Date.now() < expiry - EXPIRY_MARGIN_MS;

	function cache(t: string, exp: number): void {
		token = t;
		expiry = exp;
		kept((s) => s.setItem(key, JSON.stringify({ token: t, expiry: exp })));
	}
	function clear(): void {
		token = null;
		expiry = 0;
		kept((s) => s.removeItem(key));
	}

	const hintNow = (): string | undefined => {
		const h = typeof opts.hint === 'function' ? opts.hint() : opts.hint;
		return h || undefined;
	};

	return {
		async token(tokenOpts?: { forceRefresh?: boolean }): Promise<string> {
			// forceRefresh: the target saw a 401 on this cached token, so re-acquire
			// even though our own clock still thinks it fresh (Google can reject a
			// token before its nominal expiry). A rejected token must leave storage
			// too, or the next reload starts again from the same dead one.
			if (tokenOpts?.forceRefresh) clear();
			else restore();
			if (!tokenOpts?.forceRefresh && fresh()) return token!;
			await loadGIS();
			return requestToken(opts.clientId, scope, '', hintNow(), cache);
		},
		async reconnect(): Promise<boolean> {
			await loadGIS();
			// Silent first. The consent screen is for a grant that is genuinely
			// missing or withdrawn; re-showing it over a live grant re-asks a
			// question already answered, and Google mails the user about it every
			// single time.
			try {
				await requestToken(opts.clientId, scope, '', hintNow(), cache);
				return true;
			} catch {
				// fall through to the full consent screen
			}
			try {
				await requestToken(opts.clientId, scope, 'consent', hintNow(), cache);
				return true;
			} catch {
				return false;
			}
		},
		async forget(): Promise<void> {
			clear();
		}
	};
}
