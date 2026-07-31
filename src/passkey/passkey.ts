/**
 * Open a store with the device instead of the keyboard: Face, fingerprint or
 * Windows Hello in place of typing the password.
 *
 * WHAT IT IS. A platform passkey carrying the WebAuthn PRF extension (FIDO2
 * hmac-secret) yields a stable 32-byte secret - deterministic for that
 * credential and a fixed per-app salt, and it never leaves the authenticator.
 * That secret becomes an AES-256-GCM key, under which this module seals the
 * app's own secret (typically the backup password). Unlocking is then: user
 * verification -> PRF secret -> the password in the clear, in memory.
 *
 * WHAT IT IS NOT. It does not replace the password, it carries it. The
 * password keeps opening everything, on every device, forever; this is a
 * convenience bound to ONE browser profile on ONE machine. Losing the passkey
 * costs a typed password, never data. That asymmetry is deliberate: a second
 * independent key to the data would widen the blast radius of a stolen device,
 * which is the opposite of what a locked cache is for.
 *
 * THE PROPERTY IT PRESERVES. The sealed blob is useless on its own: a copy of
 * the browser profile does not open it, because the PRF secret lives in the
 * authenticator and demands user verification. That is exactly the guarantee a
 * lock-mode cache exists for, so enrolling does not weaken it.
 *
 * OPT-IN BY CONSTRUCTION. Nothing here runs unless an app calls
 * `passkeyUnlock()`. An app that never does simply has no such feature, and an
 * app that does still decides when to offer it - the recommended shape is an
 * explicit control the user turns on, and can turn off again with `forget()`.
 *
 * Requires the PRF extension: recent Chrome/Edge, Safari 18+, recent Android;
 * inside a native WebView it depends on the system WebView version. Nothing
 * trusts that blindly - `available()` and `enroll()` feature-detect at runtime
 * and FAIL CLOSED, so the option is only ever usable where a real secret comes
 * back. Dependency-free, and guarded for SSR and no-WebAuthn environments.
 */

/** How the passkey is presented by the platform, and what it protects. */
export interface PasskeyUnlockOptions {
	/**
	 * Shown by the operating system's passkey prompt and stored with the
	 * credential. The application name, as a person would read it.
	 */
	appName: string;
	/**
	 * Domain separator for the PRF evaluation - NOT a secret, and it may be a
	 * constant: the credential's own secret is what makes the derived key
	 * unique. Use a stable per-app string. Changing it rotates every
	 * passkey-derived key at once, which orphans every existing enrolment.
	 */
	salt: string;
	/** Where the sealed secret is kept on this device (default `selfstore.passkey`). */
	storageKey?: string;
}

/** The device-unlock facade. Every method is safe to call anywhere: outside a
 *  browser, or without WebAuthn, they report unavailable rather than throw. */
export interface PasskeyUnlock {
	/**
	 * Whether a user-verifying platform authenticator exists at all. Necessary
	 * but NOT sufficient: only an actual `enroll()` proves the PRF extension
	 * works here. Use it to decide whether to show the control, not to promise
	 * that it will succeed.
	 */
	available(): Promise<boolean>;
	/** Whether this device currently holds a sealed secret to reveal. */
	enrolled(): boolean;
	/**
	 * Create a platform passkey and seal `secret` behind it. `false` when the
	 * user cancelled, or when PRF did not yield a key here - fail closed, the
	 * host keeps its password prompt and should say so rather than pretend.
	 */
	enroll(secret: string): Promise<boolean>;
	/**
	 * Ask for Face / fingerprint / Hello and return the sealed secret. `null`
	 * on cancel, on a missing enrolment, or on any failure; the host then falls
	 * back to asking for the password. Never throws.
	 */
	reveal(): Promise<string | null>;
	/**
	 * Drop the sealed secret from this device. The platform credential itself
	 * is NOT deleted - the operating system owns it, and only the user can
	 * remove it from their passkey manager. Say that in the interface rather
	 * than implying a full erasure.
	 */
	forget(): void;
}

/** PRF extension shapes are absent from some TS DOM libs; describe what we use. */
type PrfInputs = { prf?: { eval?: { first: BufferSource } } };
type PrfOutputs = { prf?: { results?: { first?: ArrayBuffer } } };

/** What one device remembers: which credential to prefer, and the sealed secret. */
interface StoredEnrolment {
	credentialId: string;
	iv: string;
	sealed: string;
}

const DEFAULT_STORAGE_KEY = 'selfstore.passkey';
const PRF_BYTES = 32;

function toB64(bytes: ArrayBuffer | Uint8Array): string {
	const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	let s = '';
	for (const byte of b) s += String.fromCharCode(byte);
	return btoa(s);
}

function fromB64(s: string): Uint8Array<ArrayBuffer> {
	const bin = atob(s);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

function webauthnUsable(): boolean {
	return (
		typeof window !== 'undefined' &&
		!!window.PublicKeyCredential &&
		typeof navigator !== 'undefined' &&
		!!navigator.credentials &&
		typeof crypto !== 'undefined' &&
		!!crypto.subtle
	);
}

function prfSecret(credential: PublicKeyCredential | null): Uint8Array | null {
	const first = (credential?.getClientExtensionResults() as PrfOutputs | undefined)?.prf?.results
		?.first;
	if (!first) return null;
	const bytes = new Uint8Array(first);
	return bytes.length === PRF_BYTES ? bytes : null;
}

/**
 * The 32 bytes coming out of PRF are an HMAC output, so they are already
 * uniform: import them straight as an AES-GCM key rather than running a KDF
 * over them. Stretching high-entropy material buys nothing and would only make
 * every unlock slower.
 */
function sealKey(secret: Uint8Array): Promise<CryptoKey> {
	return crypto.subtle.importKey('raw', secret as BufferSource, 'AES-GCM', false, [
		'encrypt',
		'decrypt'
	]);
}

export function passkeyUnlock(options: PasskeyUnlockOptions): PasskeyUnlock {
	const storageKey = options.storageKey ?? DEFAULT_STORAGE_KEY;
	const prfSalt = new TextEncoder().encode(options.salt);

	function read(): StoredEnrolment | null {
		try {
			if (typeof localStorage === 'undefined') return null;
			const raw = localStorage.getItem(storageKey);
			if (!raw) return null;
			const parsed = JSON.parse(raw) as StoredEnrolment;
			const complete =
				typeof parsed?.credentialId === 'string' &&
				typeof parsed?.iv === 'string' &&
				typeof parsed?.sealed === 'string';
			return complete ? parsed : null;
		} catch {
			return null;
		}
	}

	function write(entry: StoredEnrolment | null): void {
		try {
			if (typeof localStorage === 'undefined') return;
			if (entry) localStorage.setItem(storageKey, JSON.stringify(entry));
			else localStorage.removeItem(storageKey);
		} catch {
			/* storage blocked: the enrolment is simply not remembered */
		}
	}

	/**
	 * Re-derive the PRF secret. With a credential id it targets that one; with
	 * none, the platform offers the user's discoverable passkeys for this site.
	 */
	async function derive(credentialId?: string): Promise<Uint8Array | null> {
		try {
			const assertion = (await navigator.credentials.get({
				publicKey: {
					challenge: crypto.getRandomValues(new Uint8Array(32)),
					allowCredentials: credentialId
						? [{ type: 'public-key', id: fromB64(credentialId) as BufferSource }]
						: [],
					userVerification: 'required',
					extensions: { prf: { eval: { first: prfSalt } } } as PrfInputs,
					timeout: 60_000
				}
			})) as PublicKeyCredential | null;
			return prfSecret(assertion);
		} catch {
			return null;
		}
	}

	async function create(): Promise<{ credentialId: string; secret: Uint8Array } | null> {
		const credential = (await navigator.credentials.create({
			publicKey: {
				challenge: crypto.getRandomValues(new Uint8Array(32)),
				rp: { name: options.appName, id: location.hostname },
				user: {
					id: crypto.getRandomValues(new Uint8Array(16)),
					name: options.appName,
					displayName: options.appName
				},
				pubKeyCredParams: [
					{ type: 'public-key', alg: -7 },
					{ type: 'public-key', alg: -257 }
				],
				authenticatorSelection: {
					authenticatorAttachment: 'platform',
					userVerification: 'required',
					residentKey: 'required'
				},
				extensions: { prf: { eval: { first: prfSalt } } } as PrfInputs,
				timeout: 60_000
			}
		})) as PublicKeyCredential | null;
		if (!credential) return null;
		const credentialId = toB64(credential.rawId);
		// Some platforms hand the PRF result back from create(); most need a
		// second get(). Try the cheap path first to save the user one prompt.
		const secret = prfSecret(credential) ?? (await derive(credentialId));
		return secret ? { credentialId, secret } : null;
	}

	return {
		async available(): Promise<boolean> {
			try {
				if (!webauthnUsable()) return false;
				return await window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
			} catch {
				return false;
			}
		},

		enrolled(): boolean {
			return read() !== null;
		},

		async enroll(secret: string): Promise<boolean> {
			if (!webauthnUsable()) return false;
			try {
				const created = await create();
				if (!created) return false;
				const iv = crypto.getRandomValues(new Uint8Array(12));
				const sealed = await crypto.subtle.encrypt(
					{ name: 'AES-GCM', iv },
					await sealKey(created.secret),
					new TextEncoder().encode(secret)
				);
				write({ credentialId: created.credentialId, iv: toB64(iv), sealed: toB64(sealed) });
				return true;
			} catch {
				return false;
			}
		},

		async reveal(): Promise<string | null> {
			const entry = read();
			if (!entry || !webauthnUsable()) return null;
			const secret = await derive(entry.credentialId);
			if (!secret) return null;
			try {
				const opened = await crypto.subtle.decrypt(
					{ name: 'AES-GCM', iv: fromB64(entry.iv) as BufferSource },
					await sealKey(secret),
					fromB64(entry.sealed) as BufferSource
				);
				return new TextDecoder().decode(opened);
			} catch {
				// A wrong key or a tampered blob: an unopenable enrolment is dead
				// weight that would fail at every attempt, so drop it and let the
				// host fall back to the password.
				write(null);
				return null;
			}
		},

		forget(): void {
			write(null);
		}
	};
}
