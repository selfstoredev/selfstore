// One stable error-code enum for the whole library, format layer and
// persistence layer alike. Codes may be added in a minor release (keep a
// default branch in exhaustive switches); existing codes never change meaning.

export type SelfstoreErrorCode =
	// backup format / crypto
	| 'BAD_FORMAT' // not a backup file / corrupt framing
	| 'UNSUPPORTED_VERSION' // file (or cipher/KDF) from a newer format version
	| 'PASSWORD_REQUIRED' // encrypted backup opened without a password, or vault used before unlock()
	| 'DECRYPT_FAILED' // wrong password, or tampered/corrupt ciphertext
	| 'TOO_LARGE' // archive entry exceeds the size guard (zip-bomb defence)
	// durable targets / store lifecycle
	| 'AUTH_EXPIRED' // access genuinely lost: only a user gesture (reconnect) fixes it
	| 'TARGET_UNAVAILABLE' // transient: offline, cold start, 5xx - retry later
	| 'TARGET_WRITE_FAILED' // destination refused or failed the write (non-auth), retryable
	| 'TARGET_GONE' // destination permanently unwritable (file deleted, permission withdrawn, storage full); retrying cannot fix it
	| 'NOT_CONNECTED' // no connected destination (no file id, no config)
	| 'WEAK_PASSWORD' // password fails the store's configured passwordPolicy
	| 'ENCRYPTION_REQUIRED' // store set requireEncryption: a plaintext attach, backup or export is refused
	| 'UNEXPECTEDLY_UNENCRYPTED' // downgrade guard: expected encrypted, found plaintext
	| 'SCHEMA_TOO_NEW' // data written by a newer app schema: update the app to sync again
	// passwordless groups (see PEERS.md)
	| 'IDENTITY_REQUIRED' // group-encrypted copy opened without a member identity
	| 'SIGNATURE_INVALID' // copy/manifest signature failed, or author not a trusted member
	| 'NOT_A_RECIPIENT' // valid group copy, but no envelope for this identity
	| 'MANIFEST_ROLLBACK'; // membership manifest older than one already applied

/**
 * i18n key for an error code: lower-camel-cased under `error.`, e.g.
 * 'error.authExpired'. The library ships the key, the app owns the copy;
 * consumers never have to show the raw developer message. Deterministic, so
 * codes added later get a key for free - keep a fallback for unknown ones.
 */
export function errorLabelKey(code: SelfstoreErrorCode): string {
	return 'error.' + code.toLowerCase().replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
}

export class SelfstoreError extends Error {
	constructor(
		readonly code: SelfstoreErrorCode,
		message: string
	) {
		super(message);
		this.name = 'SelfstoreError';
	}
}

/**
 * Genuine loss of access to a destination (session gone, token revoked):
 * only a user gesture fixes it. Anything else a target throws is treated as
 * transient and retried, so a network hiccup never raises the blocking
 * reconnect gate over a still-valid connection. Custom targets and DriveAuth
 * implementations throw this to signal the genuine case.
 */
export class AuthExpiredError extends SelfstoreError {
	constructor(message = 'Access to the destination expired or was revoked.') {
		super('AUTH_EXPIRED', message);
		this.name = 'AuthExpiredError';
	}
}

/**
 * Shape check rather than instanceof, so it survives two bundled copies of
 * the library. The name check keeps foreign coded errors (ENOENT...) out.
 */
export function isSelfstoreError(e: unknown): e is SelfstoreError {
	return (
		e instanceof Error &&
		typeof (e as { code?: unknown }).code === 'string' &&
		(e.name === 'SelfstoreError' || e.name === 'AuthExpiredError')
	);
}

/** True on genuine access loss, false on transient blips. */
export function isAuthExpired(e: unknown): boolean {
	if (typeof e !== 'object' || e === null) return false;
	return (e as { code?: unknown }).code === 'AUTH_EXPIRED';
}
