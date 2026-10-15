// A notary over any RFC 3161 time-stamping authority. The authority signs the
// digest and the time in one token, so the receipt is complete on deposit: the
// token (the `.tsr` file) is the evidence, and `openssl ts -verify` checks it
// against the authority's certificate without this library.

import { fromBase64, toBase64 } from '../selfstore/base64';
import { hex } from '../selfstore/digest';
import { SelfstoreError } from '../selfstore/errors';
import { childrenOf, contentOf, DerError, expectTag, readNode, tlv, type DerNode } from './der';
import type { Notary, Receipt } from './proof';
import { reach } from './reach';

const SEQUENCE = 0x30;
const INTEGER = 0x02;
const OCTET_STRING = 0x04;
const OID = 0x06;
const GENERALIZED_TIME = 0x18;
const EXPLICIT_0 = 0xa0;

/** id-sha256, 2.16.840.1.101.3.4.2.1, with its NULL parameters. */
const SHA256_ALGORITHM = tlv(
	SEQUENCE,
	tlv(OID, Uint8Array.of(0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01)),
	Uint8Array.of(0x05, 0x00)
);

export interface Rfc3161Options {
	/** The authority's endpoint. In a browser it must answer CORS, or sit
	 *  behind a relay of yours that does: most public authorities do not. */
	url: string;
	/** Receipt `notary` field. Defaults to 'rfc3161'. */
	name?: string;
	/** Injected for tests and relays; defaults to the global fetch. */
	fetch?: typeof fetch;
}

/** What a timestamp token says, read without checking its signature. */
export interface TimestampToken {
	/** Lowercase hex of the digest the authority stamped. */
	readonly hash: string;
	/** ISO 8601 instant the authority signed. */
	readonly time: string;
	/** The nonce echoed back, as lowercase hex, when there is one. */
	readonly nonce?: string;
}

function hexToBytes(hex: string): Uint8Array {
	return Uint8Array.from(hex.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
}

/** Leading zero bytes are DER's sign padding, not part of the value. */
function integerHex(bytes: Uint8Array): string {
	let at = 0;
	while (at < bytes.length - 1 && bytes[at] === 0) at++;
	return hex(bytes.subarray(at));
}

/** Eight random bytes, positive and minimal as a DER INTEGER. */
function newNonce(): Uint8Array {
	const nonce = crypto.getRandomValues(new Uint8Array(8));
	nonce[0] = (nonce[0] & 0x3f) | 0x40;
	return nonce;
}

/** A TimeStampReq (RFC 3161 section 2.4.1) for a SHA-256 digest, asking for the certificate. */
export function timestampRequest(hash: string, nonce: Uint8Array): Uint8Array {
	return tlv(
		SEQUENCE,
		tlv(INTEGER, Uint8Array.of(1)),
		tlv(SEQUENCE, SHA256_ALGORITHM, tlv(OCTET_STRING, hexToBytes(hash))),
		tlv(INTEGER, nonce),
		Uint8Array.of(0x01, 0x01, 0xff)
	);
}

/** YYYYMMDDHHMMSS[.fff]Z to ISO 8601. */
function generalizedTime(text: string): string {
	const parts = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\.\d+)?Z$/.exec(text);
	if (parts === null) throw new DerError(`unreadable time ${text}`);
	const [, y, mo, d, h, mi, s, fraction] = parts;
	return new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}${fraction ?? ''}Z`).toISOString();
}

/** TimeStampResp: the status, or the token when it was granted. */
function tokenOf(bytes: Uint8Array): DerNode {
	const [statusInfo, token] = childrenOf(bytes, expectTag(readNode(bytes, 0), SEQUENCE));
	const status = expectTag(childrenOf(bytes, expectTag(statusInfo, SEQUENCE))[0], INTEGER);
	const code = Number.parseInt(integerHex(contentOf(bytes, status)), 16);
	// 0 granted, 1 granted with modifications; anything else is a refusal.
	if (code > 1) {
		throw new SelfstoreError(
			'NOTARY_REFUSED',
			`the authority refused the request (status ${code})`
		);
	}
	return expectTag(token, SEQUENCE);
}

/** ContentInfo > SignedData > EncapsulatedContentInfo > TSTInfo. */
function tstInfoOf(bytes: Uint8Array, token: DerNode): DerNode {
	const signedData = expectTag(
		childrenOf(bytes, expectTag(childrenOf(bytes, token)[1], EXPLICIT_0))[0],
		SEQUENCE
	);
	const encapsulated = expectTag(childrenOf(bytes, signedData)[2], SEQUENCE);
	const wrapper = expectTag(childrenOf(bytes, encapsulated)[1], EXPLICIT_0);
	const octets = expectTag(childrenOf(bytes, wrapper)[0], OCTET_STRING);
	return expectTag(readNode(bytes, octets.start, octets.end), SEQUENCE);
}

/**
 * Read the digest, the time and the nonce out of a TimeStampResp (the `.tsr`
 * file). It does NOT check the authority's signature - that is what
 * `openssl ts -verify` is for; it is what tells a token for another document
 * apart before anything is kept. Throws NOTARY_REFUSED on a refusal or on
 * anything that is not a timestamp reply.
 */
export function readTimestampReply(bytes: Uint8Array): TimestampToken {
	try {
		const tstInfo = tstInfoOf(bytes, tokenOf(bytes));
		// version, policy, messageImprint, serialNumber, genTime, then optional
		// accuracy, ordering and nonce - the nonce is the only INTEGER among them.
		const [, , imprint, , time, ...rest] = childrenOf(bytes, tstInfo);
		const digest = expectTag(childrenOf(bytes, expectTag(imprint, SEQUENCE))[1], OCTET_STRING);
		const nonce = rest.find((node) => node.tag === INTEGER);
		const genTime = new TextDecoder().decode(contentOf(bytes, expectTag(time, GENERALIZED_TIME)));
		return {
			hash: hex(contentOf(bytes, digest)),
			time: generalizedTime(genTime),
			...(nonce ? { nonce: integerHex(contentOf(bytes, nonce)) } : {})
		};
	} catch (e) {
		if (e instanceof SelfstoreError) throw e;
		throw new SelfstoreError('NOTARY_REFUSED', `not a timestamp reply: ${(e as Error).message}`);
	}
}

async function post(options: Rfc3161Options, body: Uint8Array): Promise<Uint8Array> {
	const response = await reach(
		options.fetch ?? globalThis.fetch,
		options.url,
		{
			method: 'POST',
			headers: { 'content-type': 'application/timestamp-query' },
			body: body as BodyInit
		},
		'the authority'
	);
	return new Uint8Array(await response.arrayBuffer());
}

/**
 * A notary over an RFC 3161 time-stamping authority. The receipt is complete
 * on deposit; its evidence is the reply, base64 under `tsr`, and the
 * authority's address under `tsa`. The label is never sent: RFC 3161 has no
 * field for it, so it stays on the receipt.
 */
export function rfc3161Notary(options: Rfc3161Options): Notary {
	const name = options.name ?? 'rfc3161';
	return {
		name,
		async deposit(hash: string, label?: string): Promise<Receipt> {
			const nonce = newNonce();
			const reply = await post(options, timestampRequest(hash, nonce));
			const token = readTimestampReply(reply);
			if (token.hash !== hash) {
				throw new SelfstoreError('NOTARY_REFUSED', 'the authority stamped another digest');
			}
			if (token.nonce !== integerHex(nonce)) {
				throw new SelfstoreError('NOTARY_REFUSED', 'the reply does not answer this request');
			}
			return {
				notary: name,
				hash,
				...(label === undefined ? {} : { label }),
				depositedAt: token.time,
				complete: true,
				evidence: { tsr: toBase64(reply), tsa: options.url }
			};
		},
		complete(receipt: Receipt): Promise<Receipt> {
			return Promise.resolve(receipt);
		}
	};
}

/** The `.tsr` bytes of an RFC 3161 receipt, to offer as a download. */
export function timestampReplyOf(receipt: Pick<Receipt, 'evidence'>): Uint8Array | undefined {
	const tsr = receipt.evidence.tsr;
	return tsr === undefined ? undefined : fromBase64(tsr);
}
