import { describe, it, expect } from 'vitest';
import { errorLabelKey, type SelfstoreErrorCode } from './errors';

// The full code enum, pinned here so this test fails if a code is added without
// deciding its key (the app-facing contract must stay exhaustive).
const EXPECTED: Record<SelfstoreErrorCode, string> = {
	BAD_FORMAT: 'error.badFormat',
	UNSUPPORTED_VERSION: 'error.unsupportedVersion',
	PASSWORD_REQUIRED: 'error.passwordRequired',
	DECRYPT_FAILED: 'error.decryptFailed',
	TOO_LARGE: 'error.tooLarge',
	AUTH_EXPIRED: 'error.authExpired',
	TARGET_UNAVAILABLE: 'error.targetUnavailable',
	TARGET_WRITE_FAILED: 'error.targetWriteFailed',
	TARGET_GONE: 'error.targetGone',
	NOT_CONNECTED: 'error.notConnected',
	WEAK_PASSWORD: 'error.weakPassword',
	ENCRYPTION_REQUIRED: 'error.encryptionRequired',
	UNEXPECTEDLY_UNENCRYPTED: 'error.unexpectedlyUnencrypted',
	SCHEMA_TOO_NEW: 'error.schemaTooNew',
	IDENTITY_REQUIRED: 'error.identityRequired',
	SIGNATURE_INVALID: 'error.signatureInvalid',
	NOT_A_RECIPIENT: 'error.notARecipient',
	MANIFEST_ROLLBACK: 'error.manifestRollback'
};

describe('errorLabelKey', () => {
	it('maps every code to its stable lower-camel key under the error. namespace', () => {
		for (const [code, key] of Object.entries(EXPECTED)) {
			expect(errorLabelKey(code as SelfstoreErrorCode)).toBe(key);
		}
	});

	it('is deterministic and namespaced (usable as a translation key)', () => {
		expect(errorLabelKey('AUTH_EXPIRED')).toBe('error.authExpired');
		expect(errorLabelKey('AUTH_EXPIRED')).toBe(errorLabelKey('AUTH_EXPIRED'));
		for (const key of Object.values(EXPECTED)) {
			expect(key.startsWith('error.')).toBe(true);
			expect(key).not.toContain('_');
		}
	});
});
