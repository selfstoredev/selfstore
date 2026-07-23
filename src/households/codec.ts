// Household share transport (capability-link model): the plain shapes the
// bulletin and the copy-announce carry, plus a dependency-free base64url
// codec. The link key K is the shared group secret - possession is
// membership, no per-member identity, no signed manifest. Payloads carry
// only file ids of link-readable files whose content is encrypted under K,
// so an id alone reveals nothing. Pure by contract: no secret held, no I/O,
// no framework - shapes, validation and transport strings only.

// --- Errors -----------------------------------------------------------------

/** Why a code was refused. `malformed` covers bad transport, wrong structure or
 *  a code decoded as the wrong kind of payload; `unsupported-version` is a
 *  numeric `v` this build does not understand. */
export type HouseholdCodeErrorCode = 'malformed' | 'unsupported-version';

/** The single typed error this module throws, so callers branch on `code`
 *  instead of parsing messages. A decoder that throws never returns a partially
 *  parsed object - it fails whole. */
export class HouseholdCodeError extends Error {
	readonly code: HouseholdCodeErrorCode;
	constructor(code: HouseholdCodeErrorCode, message: string) {
		super(message);
		this.name = 'HouseholdCodeError';
		this.code = code;
		Object.setPrototypeOf(this, HouseholdCodeError.prototype);
	}
}

const malformed = (message: string): HouseholdCodeError =>
	new HouseholdCodeError('malformed', message);

// --- Types ------------------------------------------------------------------

/** Where a member published their encrypted copy. A discriminated union on
 *  `provider` so a future transport (WebDAV, ...) slots in beside Drive without
 *  changing the payload shapes. Today: Drive only. */
export type CopyLink = DriveCopyLink;

/** A copy hosted on the owner's Google Drive. `fileId` is the Drive file id (a
 *  public-link file, ciphertext under K); the owner fields are a cosmetic "on
 *  X's Drive" hint, both optional. */
export interface DriveCopyLink {
	provider: 'drive';
	fileId: string;
	ownerEmail?: string;
	ownerName?: string;
}

/** The bulletin's control record (rides one reserved collection inside the
 *  K-encrypted bulletin): where members announce their copy (`mailboxId`, a
 *  secret only K-holders can read) and the roster of every known copy (the
 *  admin's own first). */
export interface SharePayload {
	v: 1;
	mailboxId: string;
	roster: CopyLink[];
}

/** Member -> admin, through the announce mailbox: "here is my copy, fold it".
 *  No identity, no signature: knowing the mailboxId (which lives inside the
 *  K-encrypted bulletin) already proves the sender holds K. */
export interface AnnouncePayload {
	v: 1;
	copy: CopyLink;
}

// --- base64url (isomorphic, dependency-free) --------------------------------

const utf8Encoder = new TextEncoder();
// `fatal` makes a truncated or corrupted byte run throw instead of silently
// yielding U+FFFD, so a mangled code fails fast in the decoder.
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

function bytesToBinary(bytes: Uint8Array): string {
	let out = '';
	for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
	return out;
}

function binaryToBytes(binary: string): Uint8Array {
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

/** base64url without padding of raw bytes. btoa + TextEncoder work in the
 *  browser and in Node 20+, so the codec stays dependency-free and isomorphic. */
function bytesToBase64url(bytes: Uint8Array): string {
	return btoa(bytesToBinary(bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlEncode(text: string): string {
	return bytesToBase64url(utf8Encoder.encode(text));
}

/** Inverse of base64urlEncode. Throws on any character outside the alphabet or
 *  on an invalid UTF-8 byte run; decodeJson turns that into a 'malformed'. */
function base64urlDecode(code: string): string {
	const b64 = code.replace(/-/g, '+').replace(/_/g, '/');
	const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
	return utf8Decoder.decode(binaryToBytes(atob(padded)));
}

/** A short, url-safe, random id (9 bytes -> 12 base64url chars) from WebCrypto -
 *  used for the announce mailbox id. This repo bans Math.random; getRandomValues
 *  is the sanctioned entropy source and exists in every browser and Node 20+. */
export function randomId(): string {
	const bytes = new Uint8Array(9);
	crypto.getRandomValues(bytes);
	return bytesToBase64url(bytes);
}

// --- Structural guards ------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isString(v: unknown): v is string {
	return typeof v === 'string';
}

/** Enforce the format version. A numeric `v` other than 1 is a code from a
 *  future/older build (unsupported-version); anything else is garbage. */
function requireV1(v: unknown): void {
	if (v === 1) return;
	if (typeof v === 'number') {
		throw new HouseholdCodeError(
			'unsupported-version',
			`payload version ${v} is not supported (expected 1)`
		);
	}
	throw malformed('missing or non-numeric version field');
}

/** Decode base64url -> JSON, mapping any failure to a single 'malformed'. */
function decodeJson(code: string): unknown {
	if (typeof code !== 'string' || code.length === 0)
		throw malformed('code must be a non-empty string');
	let json: string;
	try {
		json = base64urlDecode(code);
	} catch {
		throw malformed('code is not valid base64url');
	}
	try {
		return JSON.parse(json) as unknown;
	} catch {
		throw malformed('code payload is not valid JSON');
	}
}

/** Rebuild a CopyLink field by field, so a decoded link carries exactly the
 *  known keys (no smuggled extras) and every present field has the right type. */
export function toCopyLink(v: unknown): CopyLink {
	if (!isRecord(v)) throw malformed('copy link is not an object');
	if (v.provider === 'drive') {
		if (!isString(v.fileId)) throw malformed('drive copy link needs a string fileId');
		if (v.ownerEmail !== undefined && !isString(v.ownerEmail))
			throw malformed('copy link ownerEmail must be a string');
		if (v.ownerName !== undefined && !isString(v.ownerName))
			throw malformed('copy link ownerName must be a string');
		const link: DriveCopyLink = { provider: 'drive', fileId: v.fileId };
		if (isString(v.ownerEmail)) link.ownerEmail = v.ownerEmail;
		if (isString(v.ownerName)) link.ownerName = v.ownerName;
		return link;
	}
	throw malformed(`unknown copy-link provider ${JSON.stringify(v.provider)}`);
}

/** Every entry of a roster array validated as a CopyLink, de-duplicated by
 *  fileId (first occurrence wins). An empty roster is structurally valid.
 *  Exported for the backend, which revalidates the roster it re-publishes. */
export function toRoster(v: unknown): CopyLink[] {
	if (!Array.isArray(v)) throw malformed('roster is not an array');
	const seen = new Set<string>();
	const out: CopyLink[] = [];
	for (const entry of v) {
		const link = toCopyLink(entry);
		if (seen.has(link.fileId)) continue;
		seen.add(link.fileId);
		out.push(link);
	}
	return out;
}

// --- Codec ------------------------------------------------------------------
// Transport = base64url(no padding) of compact JSON. Each encoder is a pure,
// deterministic function of its input; each decoder validates the version and
// the full structure and throws HouseholdCodeError on anything it cannot trust.

export function encodeShare(payload: SharePayload): string {
	return base64urlEncode(JSON.stringify(payload));
}

export function decodeShare(code: string): SharePayload {
	const raw = decodeJson(code);
	if (!isRecord(raw)) throw malformed('share payload is not an object');
	requireV1(raw.v);
	if (!isString(raw.mailboxId)) throw malformed('share payload needs a string mailboxId');
	return { v: 1, mailboxId: raw.mailboxId, roster: toRoster(raw.roster) };
}

export function encodeAnnounce(payload: AnnouncePayload): string {
	return base64urlEncode(JSON.stringify(payload));
}

export function decodeAnnounce(code: string): AnnouncePayload {
	const raw = decodeJson(code);
	if (!isRecord(raw)) throw malformed('announce is not an object');
	requireV1(raw.v);
	return { v: 1, copy: toCopyLink(raw.copy) };
}
