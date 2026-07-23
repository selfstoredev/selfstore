/**
 * A client-only DriveAuth: the Google Identity Services token flow, no backend.
 * The access token is cached in sessionStorage so a reload reuses it, and a
 * silent re-acquisition is attempted when it lapses; if that fails (the Google
 * session expired, or third-party cookies are blocked) the Drive target reports
 * needs-attention and the user reconnects in one click. For a connection that
 * never re-prompts, back the Drive target with a server that holds a refresh
 * token instead (a broker implementing the same DriveAuth interface).
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

// prompt '' = silent (no UI, fails if the session lapsed); 'consent' = popup.
// Module-level (not nested in gisDriveAuth) to keep the callback nesting shallow.
function requestToken(
	clientId: string,
	scope: string,
	prompt: string,
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

/** Build a client-only DriveAuth for the given OAuth client id (no backend). */
export function gisDriveAuth(opts: { clientId: string; scope?: string }): DriveAuth {
	const scope = opts.scope ?? DRIVE_SCOPE;

	// The access token is kept in MEMORY only (never sessionStorage/localStorage),
	// so an XSS payload in the same origin cannot lift it from web storage. A
	// reload simply re-acquires it silently (prompt '') or, if the Google session
	// lapsed, surfaces a one-click reconnect. This trades a little re-prompting for
	// not persisting a Drive-scoped credential.
	let token: string | null = null;
	let expiry = 0;
	const fresh = (): boolean => !!token && Date.now() < expiry - EXPIRY_MARGIN_MS;

	function cache(t: string, exp: number): void {
		token = t;
		expiry = exp;
	}
	function clear(): void {
		token = null;
		expiry = 0;
	}

	return {
		async token(tokenOpts?: { forceRefresh?: boolean }): Promise<string> {
			// forceRefresh: the target saw a 401 on this cached token, so re-acquire
			// even though our own clock still thinks it is fresh (Google can reject a
			// token before its nominal expiry).
			if (!tokenOpts?.forceRefresh && fresh()) return token!;
			await loadGIS();
			return requestToken(opts.clientId, scope, '', cache); // silent
		},
		async reconnect(): Promise<boolean> {
			await loadGIS();
			try {
				await requestToken(opts.clientId, scope, 'consent', cache);
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
