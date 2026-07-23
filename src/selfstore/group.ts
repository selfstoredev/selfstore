// Passwordless groups: the public-key layer under peers (see PEERS.md).
//
// Each member holds an Ed25519 keypair to sign the copies they publish and an
// X25519 keypair to receive data keys. A copy is encrypted once under a fresh
// AES-256-GCM data key, enveloped per member (ephemeral ECDH + HKDF + GCM
// wrap - the age recipient model). Membership is a manifest signed by a
// single admin key; a copy is trusted only when its signature verifies and
// its author is in the manifest.
//
// WebCrypto only, no polyfill: the supply-chain surface stays flat, and
// evergreen browsers plus Node 20+ have everything needed.

import type { RecipientStanza } from './types';
import { toBase64, fromBase64 } from './base64';
import { SelfstoreError } from './errors';

/** The `keying` header value for group-mode boxes (see SPEC.md section 12). */
export const GROUP_KEYING = 'x25519-hkdf-sha256';

// Enforced on both seal and open, so a member cannot publish a copy under a
// narrower key (16 bytes -> AES-128) and have readers accept it.
const DATA_KEY_BYTES = 32;
const CURVE_PUB_BYTES = 32;
// Group mode targets a handful of members; the cap keeps a crafted copy from
// demanding one asymmetric operation per stanza without bound.
export const MAX_RECIPIENTS = 256;

// Domain separation: every signature and derivation binds its purpose, so
// bytes signed in one role can never be replayed in another.
const DOMAIN_BOX = 'selfstore-group-sig-v1';
const DOMAIN_MANIFEST = 'selfstore-group-manifest-v1';
const HKDF_INFO = 'selfstore-group-wrap-v1';

const utf8 = new TextEncoder();

/**
 * A member's full identity: private halves PKCS#8 DER, public halves raw 32
 * bytes, all base64. Treat the *Priv fields like a password - seal them at
 * rest (identityVault) and move them only over a trusted channel.
 */
export interface GroupIdentity {
	sigPub: string;
	sigPriv: string;
	encPub: string;
	encPriv: string;
}

/** One member as the manifest lists them: public keys only. */
export interface GroupMember {
	id: string;
	label?: string;
	/** Ed25519 public key (base64 raw): verifies the copies this member signs. */
	sig: string;
	/** X25519 public key (base64 raw): receives the data-key envelopes. */
	enc: string;
}

/**
 * The membership document, single-writer (the admin), carried as a
 * SignedManifest. `seq` grows on every change; consumers refuse a lower seq
 * than one already applied (the store persists the high-water mark).
 */
export interface GroupManifest {
	v: 1;
	/** Random group id (base64), so seq high-water marks never collide. */
	group: string;
	seq: number;
	/** The admin's Ed25519 public key. Members pin it at join time (TOFU). */
	admin: string;
	members: GroupMember[];
}

/**
 * A manifest as it travels: the exact signed payload bytes plus the admin's
 * signature. Signing bytes rather than re-serialized JSON sidesteps
 * canonicalization entirely.
 */
export interface SignedManifest {
	selfstoreManifest: 1;
	payload: string;
	sig: string;
}

/** Coerce to the ArrayBuffer-backed view WebCrypto's types want (safe here). */
function src(u8: Uint8Array): Uint8Array<ArrayBuffer> {
	return u8 as Uint8Array<ArrayBuffer>;
}

function concat(...parts: Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let o = 0;
	for (const p of parts) {
		out.set(p, o);
		o += p.length;
	}
	return out;
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
	return new Uint8Array(await crypto.subtle.digest('SHA-256', src(bytes)));
}

let curvesOk: Promise<boolean> | null = null;

/** Whether WebCrypto implements Ed25519 + X25519 here. Password mode never needs this. */
export function groupCryptoAvailable(): Promise<boolean> {
	curvesOk ??= (async () => {
		try {
			await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify']);
			await crypto.subtle.generateKey('X25519', false, ['deriveBits']);
			return true;
		} catch {
			return false;
		}
	})();
	return curvesOk;
}

async function requireCurves(): Promise<void> {
	if (!(await groupCryptoAvailable())) {
		throw new TypeError(
			'Group mode needs WebCrypto Ed25519 and X25519 (evergreen browsers, Node 20+); ' +
				'this platform does not provide them. Use password mode instead, or upgrade the runtime.'
		);
	}
}

const importSigPriv = (b64: string): Promise<CryptoKey> =>
	crypto.subtle.importKey('pkcs8', src(fromBase64(b64)), 'Ed25519', false, ['sign']);
const importSigPub = (b64: string): Promise<CryptoKey> =>
	crypto.subtle.importKey('raw', src(fromBase64(b64)), 'Ed25519', false, ['verify']);
const importEncPriv = (b64: string): Promise<CryptoKey> =>
	crypto.subtle.importKey('pkcs8', src(fromBase64(b64)), 'X25519', false, ['deriveBits']);
const importEncPub = (b64: string): Promise<CryptoKey> =>
	crypto.subtle.importKey('raw', src(fromBase64(b64)), 'X25519', false, []);

/** Generate a fresh member identity (two keypairs). */
export async function generateIdentity(): Promise<GroupIdentity> {
	await requireCurves();
	const sig = (await crypto.subtle.generateKey('Ed25519', true, [
		'sign',
		'verify'
	])) as CryptoKeyPair;
	const enc = (await crypto.subtle.generateKey('X25519', true, ['deriveBits'])) as CryptoKeyPair;
	const raw = async (k: CryptoKey): Promise<string> =>
		toBase64(new Uint8Array(await crypto.subtle.exportKey('raw', k)));
	const pkcs8 = async (k: CryptoKey): Promise<string> =>
		toBase64(new Uint8Array(await crypto.subtle.exportKey('pkcs8', k)));
	return {
		sigPub: await raw(sig.publicKey),
		sigPriv: await pkcs8(sig.privateKey),
		encPub: await raw(enc.publicKey),
		encPriv: await pkcs8(enc.privateKey)
	};
}

/** The shareable half of an identity: what the admin puts in the manifest. */
export function publicIdentity(id: GroupIdentity): { sig: string; enc: string } {
	return { sig: id.sigPub, enc: id.encPub };
}

/** A fresh random group id for a new manifest. */
export function newGroupId(): string {
	return toBase64(crypto.getRandomValues(new Uint8Array(16)));
}

/** First 8 bytes of SHA-256(raw X25519 public), base64: finds a reader's stanza while naming nobody. */
export async function keyId(encPubB64: string): Promise<string> {
	return toBase64((await sha256(fromBase64(encPubB64))).subarray(0, 8));
}

// Wrap key for one stanza: HKDF-SHA256 over the X25519 shared secret, salted
// with ephemeralPub || recipientPub so the key binds to this exact pair.
async function stanzaWrapKey(
	priv: CryptoKey,
	otherPub: CryptoKey,
	ephPubRaw: Uint8Array,
	recipientPubRaw: Uint8Array,
	usage: 'encrypt' | 'decrypt'
): Promise<CryptoKey> {
	const shared = new Uint8Array(
		await crypto.subtle.deriveBits({ name: 'X25519', public: otherPub }, priv, 256)
	);
	const ikm = await crypto.subtle.importKey('raw', src(shared), 'HKDF', false, ['deriveBits']);
	const bits = new Uint8Array(
		await crypto.subtle.deriveBits(
			{
				name: 'HKDF',
				hash: 'SHA-256',
				salt: src(concat(ephPubRaw, recipientPubRaw)),
				info: src(utf8.encode(HKDF_INFO))
			},
			ikm,
			256
		)
	);
	return crypto.subtle.importKey('raw', src(bits), 'AES-GCM', false, [usage]);
}

/** Envelope a data key: one ephemeral keypair and one stanza per recipient. */
export async function sealDataKey(
	dataKey: Uint8Array,
	recipientEncPubsB64: string[]
): Promise<RecipientStanza[]> {
	await requireCurves();
	if (dataKey.length !== DATA_KEY_BYTES) {
		throw new TypeError(`sealDataKey: data key must be ${DATA_KEY_BYTES} bytes (AES-256).`);
	}
	if (recipientEncPubsB64.length > MAX_RECIPIENTS) {
		throw new TypeError(`sealDataKey: too many recipients (max ${MAX_RECIPIENTS}).`);
	}
	const out: RecipientStanza[] = [];
	for (const r of recipientEncPubsB64) {
		const eph = (await crypto.subtle.generateKey('X25519', false, ['deriveBits'])) as CryptoKeyPair;
		const ephPubRaw = new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey));
		const key = await stanzaWrapKey(
			eph.privateKey,
			await importEncPub(r),
			ephPubRaw,
			fromBase64(r),
			'encrypt'
		);
		const iv = crypto.getRandomValues(new Uint8Array(12));
		const wrap = new Uint8Array(
			await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, src(dataKey))
		);
		out.push({
			kid: await keyId(r),
			epk: toBase64(ephPubRaw),
			iv: toBase64(iv),
			wrap: toBase64(wrap)
		});
	}
	return out;
}

/**
 * Open the stanza addressed to this identity and return the data key.
 * NOT_A_RECIPIENT when none opens (identity removed, or the copy predates
 * its joining).
 */
export async function openDataKey(
	stanzas: RecipientStanza[],
	identity: Pick<GroupIdentity, 'encPub' | 'encPriv'>
): Promise<Uint8Array> {
	await requireCurves();
	if (stanzas.length > MAX_RECIPIENTS) {
		throw new SelfstoreError('BAD_FORMAT', `Too many recipient stanzas (max ${MAX_RECIPIENTS}).`);
	}
	const myKid = await keyId(identity.encPub);
	const mine = stanzas.filter((s) => s.kid === myKid);
	// On a kid miss try them all; MAX_RECIPIENTS bounds that work.
	const candidates = mine.length > 0 ? mine : stanzas;
	const priv = await importEncPriv(identity.encPriv);
	const myPubRaw = fromBase64(identity.encPub);
	for (const s of candidates) {
		try {
			const key = await stanzaWrapKey(
				priv,
				await importEncPub(s.epk),
				fromBase64(s.epk),
				myPubRaw,
				'decrypt'
			);
			const pt = new Uint8Array(
				await crypto.subtle.decrypt(
					{ name: 'AES-GCM', iv: src(fromBase64(s.iv)) },
					key,
					src(fromBase64(s.wrap))
				)
			);
			// Any other length is a key-downgrade attempt, not a valid envelope.
			if (pt.length === DATA_KEY_BYTES) return pt;
		} catch {
			/* not our stanza (or tampered): try the next candidate */
		}
	}
	throw new SelfstoreError(
		'NOT_A_RECIPIENT',
		'No envelope opens for this identity: it is not (or no longer) a recipient of this copy.'
	);
}

/** AES-256-GCM under a raw 32-byte key (the group data key). */
export async function gcmSealRaw(
	key32: Uint8Array,
	plaintext: Uint8Array
): Promise<{ iv: string; ciphertext: Uint8Array }> {
	const key = await crypto.subtle.importKey('raw', src(key32), 'AES-GCM', false, ['encrypt']);
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, src(plaintext));
	return { iv: toBase64(iv), ciphertext: new Uint8Array(ct) };
}

/** Decrypt AES-256-GCM under a raw key; a tag failure is DECRYPT_FAILED. */
export async function gcmOpenRaw(
	key32: Uint8Array,
	ivB64: string,
	ciphertext: Uint8Array
): Promise<Uint8Array> {
	try {
		const key = await crypto.subtle.importKey('raw', src(key32), 'AES-GCM', false, ['decrypt']);
		const pt = await crypto.subtle.decrypt(
			{ name: 'AES-GCM', iv: src(fromBase64(ivB64)) },
			key,
			src(ciphertext)
		);
		return new Uint8Array(pt);
	} catch {
		throw new SelfstoreError('DECRYPT_FAILED', 'Corrupted or mismatched group ciphertext.');
	}
}

/**
 * Ed25519 over domain || SHA-256(meta.json) || SHA-256(data.enc): the two
 * digests cover everything a reader trusts (recipients, author claim, iv,
 * ciphertext). Returns the raw 64-byte sig.bin entry.
 */
export async function signBox(
	metaBytes: Uint8Array,
	dataEnc: Uint8Array,
	sigPrivB64: string
): Promise<Uint8Array> {
	await requireCurves();
	const msg = concat(utf8.encode(DOMAIN_BOX), await sha256(metaBytes), await sha256(dataEnc));
	const key = await importSigPriv(sigPrivB64);
	return new Uint8Array(await crypto.subtle.sign('Ed25519', key, src(msg)));
}

/** False on any failure (bad key, bad bytes); the caller maps it to SIGNATURE_INVALID. */
export async function verifyBox(
	metaBytes: Uint8Array,
	dataEnc: Uint8Array,
	sig: Uint8Array,
	sigPubB64: string
): Promise<boolean> {
	try {
		await requireCurves();
		const msg = concat(utf8.encode(DOMAIN_BOX), await sha256(metaBytes), await sha256(dataEnc));
		return await crypto.subtle.verify('Ed25519', await importSigPub(sigPubB64), src(sig), src(msg));
	} catch {
		return false;
	}
}

/** Sign a manifest with the admin key, over the exact payload bytes. */
export async function signManifest(
	manifest: GroupManifest,
	adminSigPrivB64: string
): Promise<SignedManifest> {
	await requireCurves();
	const payload = utf8.encode(JSON.stringify(manifest));
	const key = await importSigPriv(adminSigPrivB64);
	const msg = concat(utf8.encode(DOMAIN_MANIFEST), payload);
	const sig = new Uint8Array(await crypto.subtle.sign('Ed25519', key, src(msg)));
	return { selfstoreManifest: 1, payload: toBase64(payload), sig: toBase64(sig) };
}

/**
 * Verify and parse a signed manifest against the pinned admin key (TOFU from
 * the invite). Rollback (seq) is enforced by the store, which persists the
 * high-water mark.
 */
export async function openManifest(
	signed: SignedManifest,
	adminSigPubB64: string,
	expectedGroupB64?: string
): Promise<GroupManifest> {
	await requireCurves();
	const bad = (why: string): SelfstoreError => new SelfstoreError('SIGNATURE_INVALID', why);
	if (!signed || signed.selfstoreManifest !== 1 || typeof signed.payload !== 'string') {
		throw bad('Not a signed selfstore manifest.');
	}
	let payload: Uint8Array;
	let ok: boolean;
	try {
		payload = fromBase64(signed.payload);
		const msg = concat(utf8.encode(DOMAIN_MANIFEST), payload);
		ok = await crypto.subtle.verify(
			'Ed25519',
			await importSigPub(adminSigPubB64),
			src(fromBase64(signed.sig ?? '')),
			src(msg)
		);
	} catch {
		throw bad('Malformed manifest signature or keys.');
	}
	if (!ok) throw bad('Manifest signature invalid for the pinned admin key.');
	const m = JSON.parse(new TextDecoder().decode(payload)) as GroupManifest;
	// Reject malformed member keys here, not later at import time.
	const is32ByteKey = (b64: string): boolean => {
		try {
			return fromBase64(b64).length === CURVE_PUB_BYTES;
		} catch {
			return false;
		}
	};
	const shapeOk =
		m &&
		m.v === 1 &&
		typeof m.group === 'string' &&
		Number.isInteger(m.seq) &&
		m.seq >= 0 &&
		m.admin === adminSigPubB64 &&
		Array.isArray(m.members) &&
		m.members.length <= MAX_RECIPIENTS &&
		m.members.every(
			(mem) =>
				mem &&
				typeof mem.id === 'string' &&
				mem.id.length > 0 &&
				is32ByteKey(mem.sig) &&
				is32ByteKey(mem.enc)
		);
	if (!shapeOk) throw bad('Manifest shape invalid or admin key mismatch.');
	// A member id resolves an author to a person; duplicates make that ambiguous.
	if (new Set(m.members.map((mem) => mem.id)).size !== m.members.length) {
		throw bad('Manifest has duplicate member ids.');
	}
	// An admin who reuses one key across groups must not get a manifest for
	// group Y accepted where X is meant.
	if (expectedGroupB64 !== undefined && m.group !== expectedGroupB64) {
		throw bad('Manifest is for a different group than expected.');
	}
	return m;
}
