// Ambient typing for the Google Identity Services client, loaded at runtime from
// accounts.google.com. Covers the token flow (initTokenClient) and the auth-code
// flow (initCodeClient) in one place, so the Drive auth variants share it without
// clashing declarations.

interface GisTokenResponse {
	access_token?: string;
	expires_in?: number;
	error?: string;
}

interface GisCodeResponse {
	code?: string;
	error?: string;
}

interface GisOAuth2 {
	initTokenClient(cfg: {
		client_id: string;
		scope: string;
		callback: (resp: GisTokenResponse) => void;
		error_callback?: (err: { type?: string }) => void;
	}): { requestAccessToken(opts?: { prompt?: string }): void };
	initCodeClient(cfg: {
		client_id: string;
		scope: string;
		ux_mode: 'popup';
		callback: (resp: GisCodeResponse) => void;
		error_callback?: (err: { type?: string }) => void;
	}): { requestCode(): void };
}

interface Window {
	google?: { accounts: { oauth2: GisOAuth2 } };
}
