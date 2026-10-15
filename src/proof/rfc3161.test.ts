/**
 * The RFC 3161 notary: a real reply from a public authority is read field by
 * field, and a synthetic authority answering the request it was sent shows the
 * deposit refusing every answer that is not about this digest and this nonce.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { childrenOf, contentOf, readNode, tlv } from './der';
import { prove, verify } from './proof';
import { readTimestampReply, rfc3161Notary, timestampReplyOf, timestampRequest } from './rfc3161';

const HELLO_HASH = '5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03';
const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);
const ascii = (s: string): Uint8Array => new TextEncoder().encode(s);
const hexBytes = (h: string): Uint8Array =>
	Uint8Array.from(h.match(/../g) ?? [], (p) => Number.parseInt(p, 16));

/** `openssl ts -query -data hello.txt -sha256 -cert`, answered by freetsa.org on 2026-10-11. */
const REAL_REPLY = new Uint8Array(readFileSync(new URL('./fixtures/hello.tsr', import.meta.url)));

interface Reply {
	status?: number;
	hash?: string;
	nonce?: Uint8Array | null;
	time?: string;
}

/** A TimeStampResp shaped like a real one, with no signature (nothing here checks it). */
function reply({
	status = 0,
	hash = HELLO_HASH,
	nonce = Uint8Array.of(0x42),
	time = '20261011180018Z'
}: Reply): Uint8Array {
	const statusInfo = tlv(0x30, tlv(0x02, Uint8Array.of(status)));
	if (status > 1) return tlv(0x30, statusInfo);
	const algorithm = tlv(0x30, tlv(0x06, hexBytes('608648016503040201')), Uint8Array.of(0x05, 0x00));
	const tstInfo = tlv(
		0x30,
		tlv(0x02, Uint8Array.of(1)),
		tlv(0x06, hexBytes('2a0304')),
		tlv(0x30, algorithm, tlv(0x04, hexBytes(hash))),
		tlv(0x02, Uint8Array.of(0x10, 0x20)),
		tlv(0x18, ascii(time)),
		tlv(0x30, tlv(0x02, Uint8Array.of(1))),
		...(nonce === null ? [] : [tlv(0x02, nonce)])
	);
	const encapsulated = tlv(
		0x30,
		tlv(0x06, hexBytes('2a864886f70d0109100104')),
		tlv(0xa0, tlv(0x04, tstInfo))
	);
	const signedData = tlv(0x30, tlv(0x02, Uint8Array.of(3)), tlv(0x31), encapsulated);
	const contentInfo = tlv(0x30, tlv(0x06, hexBytes('2a864886f70d010702')), tlv(0xa0, signedData));
	return tlv(0x30, statusInfo, contentInfo);
}

/** The digest and nonce a TimeStampReq carries. */
function readRequest(body: Uint8Array): { hash: string; nonce: Uint8Array; certReq: boolean } {
	const [, imprint, nonce, certReq] = childrenOf(body, readNode(body, 0));
	const digest = childrenOf(body, imprint)[1];
	const hash = Array.from(contentOf(body, digest), (b) => b.toString(16).padStart(2, '0')).join('');
	return { hash, nonce: contentOf(body, nonce), certReq: contentOf(body, certReq)[0] === 0xff };
}

type Answer = (request: ReturnType<typeof readRequest>) => Response;

/** A fetch that plays the authority, recording what it was sent. */
function authority(answer: Answer): typeof fetch & { calls: { url: string; init: RequestInit }[] } {
	const calls: { url: string; init: RequestInit }[] = [];
	const fake = (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
		calls.push({ url: String(url), init: init ?? {} });
		return Promise.resolve(answer(readRequest(init?.body as Uint8Array)));
	};
	return Object.assign(fake as typeof fetch, { calls });
}

const granted: Answer = (req) =>
	new Response(reply({ hash: req.hash, nonce: req.nonce }) as BodyInit);

describe('readTimestampReply', () => {
	it('reads the digest, the time and the nonce of a real authority reply', () => {
		expect(readTimestampReply(REAL_REPLY)).toEqual({
			hash: HELLO_HASH,
			time: '2026-10-11T18:00:18.000Z',
			nonce: 'd69bc12c49b5f783'
		});
	});

	it('keeps fractional seconds and reads a reply with no nonce', () => {
		expect(readTimestampReply(reply({ nonce: null, time: '20261011180018.25Z' }))).toEqual({
			hash: HELLO_HASH,
			time: '2026-10-11T18:00:18.250Z'
		});
	});

	it('refuses a refusal, with its status', () => {
		expect(() => readTimestampReply(reply({ status: 2 }))).toThrow(/status 2/);
	});

	it('refuses what is not a timestamp reply as NOTARY_REFUSED', () => {
		for (const junk of [
			new Uint8Array(0),
			bytes('<html>'),
			Uint8Array.of(0x30, 0x80, 0, 0),
			reply({ time: 'yesterday' })
		]) {
			expect(() => readTimestampReply(junk)).toThrow(
				expect.objectContaining({ code: 'NOTARY_REFUSED' })
			);
		}
	});
});

describe('timestampRequest', () => {
	it('asks for this SHA-256 digest, with the nonce and the certificate', () => {
		const request = readRequest(timestampRequest(HELLO_HASH, Uint8Array.of(0x42, 0x01)));
		expect(request).toEqual({ hash: HELLO_HASH, nonce: Uint8Array.of(0x42, 0x01), certReq: true });
	});
});

describe('rfc3161Notary', () => {
	it('deposits the digest and returns a complete receipt carrying the reply', async () => {
		const fetch = authority(granted);
		const notary = rfc3161Notary({ url: 'https://tsa.example/tsr', fetch });
		const proof = await prove(bytes('hello\n'), { notary, label: 'inventory' });

		expect(fetch.calls).toHaveLength(1);
		expect(fetch.calls[0].url).toBe('https://tsa.example/tsr');
		expect(fetch.calls[0].init.headers).toEqual({ 'content-type': 'application/timestamp-query' });
		expect(proof).toMatchObject({
			notary: 'rfc3161',
			hash: HELLO_HASH,
			label: 'inventory',
			depositedAt: '2026-10-11T18:00:18.000Z',
			complete: true,
			evidence: { tsa: 'https://tsa.example/tsr' }
		});
		expect(readTimestampReply(timestampReplyOf(proof)!).hash).toBe(HELLO_HASH);
		expect((await verify(bytes('hello\n'), proof)).matches).toBe(true);
	});

	it('never sends the label, and draws a fresh nonce per deposit', async () => {
		const fetch = authority(granted);
		const notary = rfc3161Notary({ url: 'https://tsa.example/tsr', fetch, name: 'my-tsa' });
		const first = await notary.deposit(HELLO_HASH, 'a-label-that-must-stay-home');
		await notary.deposit(HELLO_HASH);
		const sent = fetch.calls.map((c) =>
			new TextDecoder('latin1').decode(c.init.body as Uint8Array)
		);
		expect(sent[0]).not.toContain('a-label');
		expect(sent[0]).not.toBe(sent[1]);
		expect(first.notary).toBe('my-tsa');
		expect(await notary.complete(first)).toBe(first);
	});

	it('refuses a token for another digest', async () => {
		const fetch = authority(
			(req) => new Response(reply({ hash: '0'.repeat(64), nonce: req.nonce }) as BodyInit)
		);
		const notary = rfc3161Notary({ url: 'https://tsa.example/tsr', fetch });
		await expect(notary.deposit(HELLO_HASH)).rejects.toMatchObject({ code: 'NOTARY_REFUSED' });
	});

	it('refuses a reply to another request (a replayed or cached token)', async () => {
		const fetch = authority(() => new Response(reply({}) as BodyInit));
		const notary = rfc3161Notary({ url: 'https://tsa.example/tsr', fetch });
		await expect(notary.deposit(HELLO_HASH)).rejects.toMatchObject({ code: 'NOTARY_REFUSED' });
	});

	it('tells an unreachable authority from one that refuses', async () => {
		const down = rfc3161Notary({
			url: 'u',
			fetch: () => Promise.reject(new TypeError('fetch failed'))
		});
		const busy = rfc3161Notary({
			url: 'u',
			fetch: authority(() => new Response('', { status: 503 }))
		});
		const limited = rfc3161Notary({
			url: 'u',
			fetch: authority(() => new Response('', { status: 429 }))
		});
		const wrong = rfc3161Notary({
			url: 'u',
			fetch: authority(() => new Response('', { status: 400 }))
		});
		const refusing = rfc3161Notary({
			url: 'u',
			fetch: authority(() => new Response(reply({ status: 2 }) as BodyInit))
		});
		await expect(down.deposit(HELLO_HASH)).rejects.toMatchObject({ code: 'NOTARY_UNAVAILABLE' });
		await expect(busy.deposit(HELLO_HASH)).rejects.toMatchObject({ code: 'NOTARY_UNAVAILABLE' });
		await expect(limited.deposit(HELLO_HASH)).rejects.toMatchObject({ code: 'NOTARY_UNAVAILABLE' });
		await expect(wrong.deposit(HELLO_HASH)).rejects.toMatchObject({ code: 'NOTARY_REFUSED' });
		await expect(refusing.deposit(HELLO_HASH)).rejects.toMatchObject({ code: 'NOTARY_REFUSED' });
	});

	it('has no reply to offer for a receipt from another notary', () => {
		expect(timestampReplyOf({ evidence: {} })).toBeUndefined();
	});
});

describe('der', () => {
	it('round-trips long-form lengths', () => {
		for (const size of [127, 128, 300, 70_000]) {
			const encoded = tlv(0x04, new Uint8Array(size));
			const node = readNode(encoded, 0);
			expect(node.end - node.start).toBe(size);
			expect(node.end).toBe(encoded.length);
		}
	});

	it('refuses truncated input and lengths it cannot hold', () => {
		expect(() => readNode(Uint8Array.of(0x04, 0x82, 0x01), 0)).toThrow(/truncated length/);
		expect(() => readNode(Uint8Array.of(0x04, 0x85, 1, 1, 1, 1, 1), 0)).toThrow(
			/unsupported length/
		);
		expect(() => readNode(Uint8Array.of(0x04, 0x05, 1), 0)).toThrow(/past its parent/);
		expect(() => readNode(Uint8Array.of(0x04), 0)).toThrow(/truncated header/);
	});
});
