/**
 * selfstore/passkey - open a store with the device instead of the keyboard:
 * Face, fingerprint or Windows Hello in place of typing the password.
 *
 * `passkeyUnlock({ appName, salt })` seals a secret you already hold - normally
 * the backup password - behind a platform passkey carrying the WebAuthn PRF
 * extension, and hands it back after a user verification. It does not replace
 * the password: the password keeps opening everything on every device, while
 * this is a convenience bound to one browser profile on one machine.
 *
 * The feature exists only where an app builds it. There is no global switch and
 * nothing turns on by itself; an app that never calls `passkeyUnlock()` has no
 * such capability at all, and `forget()` gives the user the way back out.
 *
 * Everything fails closed: on a platform without the PRF extension, enrolment
 * refuses rather than storing a blob nothing can ever open.
 */

export { passkeyUnlock, type PasskeyUnlock, type PasskeyUnlockOptions } from '../passkey/passkey';
