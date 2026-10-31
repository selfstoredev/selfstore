/**
 * The digest journal notary against a fake journal serving the shapes a real
 * one publishes: the deposit answers with the journal's receipt, and the
 * receipt completes only once the first tour covering its line is anchored in
 * Bitcoin.
 */

import { describe, expect, it } from 'vitest';
import { fromBase64 } from '../selfstore/base64';
import { digestJournalNotary } from './journal';
import { completeProof, prove, type Proof, type Receipt } from './proof';

const HELLO_HASH = '5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03';
const OTHER_HASH = 'a424ba415b2b5e06757faeff2276700e5fa1f1c581ebe2d37b50ca8039e92cfa';
const ID = '80d2d6df68c68605cc8f7ed90783c0f406b0c0e0fd57e9f51b73b3dd23f9bce5';
const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

const RECEIPT = {
	version: 1,
	sha256: HELLO_HASH,
	jour: '2026-10-13',
	depose: '2026-10-13T09:12:44.120Z',
	source: 'declare',
	libelle: 'inventory',
	sel: '00112233445566778899aabbccddeeff'
};
const LINE = `{"sha256":"${HELLO_HASH}","jour":"2026-10-13","place":2,"recu":"${ID}"}`;

const deposits = (...lines: string[]): string => lines.map((l) => `${l}\n`).join('');
const OTHER_LINE = `{"sha256":"${OTHER_HASH}","jour":"2026-10-13","place":1,"recu":"${'0'.repeat(64)}"}`;

interface TourShape {
	id: string;
	depots: number;
	ots: string;
	bloc: number | null;
	horodatage: string | null;
	fichiers: string[];
}

function tour(id: string, depots: number, ots = 'bitcoin', tsr = false): TourShape {
	const files = [`${id}.json`, `${id}.racine`, `${id}.racine.ots`];
	return {
		id,
		depots,
		ots,
		bloc: ots === 'bitcoin' ? 971230 : null,
		horodatage: tsr ? 'fait' : null,
		fichiers: tsr ? [...files, `${id}.racine.tsr`] : files
	};
}

interface Journal {
	deposit?: () => Response;
	deposits?: string;
	tours?: TourShape[];
}

/** A fetch that plays the journal, recording every call. */
function journal(serve: Journal): typeof fetch & { calls: { url: string; init?: RequestInit }[] } {
	const calls: { url: string; init?: RequestInit }[] = [];
	const routes: Record<string, () => Response> = {
		'/api/depots': serve.deposit ?? (() => Response.json({ id: ID, ligne: LINE, recu: RECEIPT })),
		'/empreintes/depots.jsonl': () => new Response(serve.deposits ?? ''),
		'/tours.json': () =>
			Response.json({ tours: (serve.tours ?? []).map((t) => ({ ...t, racine: `root-${t.id}` })) })
	};
	const fake = (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
		calls.push({ url: String(url), init });
		const path = new URL(String(url)).pathname;
		const file = /^\/empreintes\/(.+\.racine\.(ots|tsr))$/.exec(path);
		if (file) return Promise.resolve(new Response(bytes(file[1]) as BodyInit));
		return Promise.resolve(routes[path]?.() ?? new Response('', { status: 404 }));
	};
	return Object.assign(fake as typeof fetch, { calls });
}

const URL_BASE = 'https://journal.example';

async function deposited(fetch: typeof globalThis.fetch): Promise<Proof> {
	return prove(bytes('hello\n'), {
		notary: digestJournalNotary({ url: `${URL_BASE}/`, fetch }),
		label: 'inventory'
	});
}

describe('digestJournalNotary deposit', () => {
	it('posts only the digest and the label, and keeps the journal receipt', async () => {
		const fetch = journal({});
		const proof = await deposited(fetch);

		expect(fetch.calls).toHaveLength(1);
		expect(fetch.calls[0].url).toBe(`${URL_BASE}/api/depots`);
		expect(JSON.parse(fetch.calls[0].init?.body as string)).toEqual({
			sha256: HELLO_HASH,
			libelle: 'inventory'
		});
		expect(proof).toMatchObject({
			notary: 'digest-journal',
			hash: HELLO_HASH,
			label: 'inventory',
			depositedAt: RECEIPT.depose,
			complete: false,
			evidence: { journal: URL_BASE, id: ID, line: LINE, receipt: JSON.stringify(RECEIPT) }
		});
	});

	it('sends the journal deposit type with the digest and the label', async () => {
		const fetch = journal({});
		const notary = digestJournalNotary({ url: URL_BASE, fetch, type: 'affichage' });
		const receipt = await notary.deposit(HELLO_HASH, 'PC 069 123 24 A0001');
		expect(JSON.parse(fetch.calls[0].init?.body as string)).toEqual({
			sha256: HELLO_HASH,
			libelle: 'PC 069 123 24 A0001',
			type: 'affichage'
		});
		expect(receipt.label).toBe('PC 069 123 24 A0001');
	});

	it('sends no label field when there is none', async () => {
		const fetch = journal({});
		const notary = digestJournalNotary({ url: URL_BASE, fetch, name: 'my-journal' });
		const receipt = await notary.deposit(HELLO_HASH);
		expect(JSON.parse(fetch.calls[0].init?.body as string)).toEqual({ sha256: HELLO_HASH });
		expect(receipt.notary).toBe('my-journal');
		expect(receipt.label).toBeUndefined();
	});

	it('refuses an answer for another digest', async () => {
		const fetch = journal({
			deposit: () =>
				Response.json({ id: ID, ligne: LINE, recu: { ...RECEIPT, sha256: OTHER_HASH } })
		});
		await expect(deposited(fetch)).rejects.toMatchObject({ code: 'NOTARY_REFUSED' });
	});

	it('refuses an answer that is not a receipt', async () => {
		for (const body of ['<html>', '{}', JSON.stringify({ id: 'x', ligne: LINE, recu: RECEIPT })]) {
			const fetch = journal({ deposit: () => new Response(body) });
			await expect(deposited(fetch)).rejects.toMatchObject({ code: 'NOTARY_REFUSED' });
		}
	});

	it('tells a full journal (retry later) from a refusal', async () => {
		const full = journal({ deposit: () => new Response('', { status: 429 }) });
		await expect(deposited(full)).rejects.toMatchObject({ code: 'NOTARY_UNAVAILABLE' });
		const bad = journal({ deposit: () => new Response('', { status: 400 }) });
		await expect(deposited(bad)).rejects.toMatchObject({ code: 'NOTARY_REFUSED' });
		const down = Object.assign(() => Promise.reject(new Error('offline')), {}) as typeof fetch;
		await expect(deposited(down)).rejects.toMatchObject({ code: 'NOTARY_UNAVAILABLE' });
	});
});

describe('digestJournalNotary complete', () => {
	async function completed(serve: Journal): Promise<Receipt> {
		const fetch = journal(serve);
		const notary = digestJournalNotary({ url: URL_BASE, fetch });
		return completeProof(await deposited(fetch), { notary });
	}

	it('stays incomplete while the line is not published', async () => {
		expect((await completed({ deposits: deposits(OTHER_LINE) })).complete).toBe(false);
	});

	it('stays incomplete while no tour covers the line, or its tour is not in Bitcoin yet', async () => {
		const published = deposits(OTHER_LINE, LINE);
		expect((await completed({ deposits: published, tours: [tour('t1', 1)] })).complete).toBe(false);
		const pending = await completed({
			deposits: published,
			tours: [tour('t1', 1), tour('t2', 2, 'calendrier')]
		});
		expect(pending.complete).toBe(false);
	});

	it('completes with the first covering tour, its anchor proof and its timestamp', async () => {
		const proof = await completed({
			deposits: deposits(OTHER_LINE, LINE),
			tours: [tour('t1', 1), tour('t2', 2, 'bitcoin', true), tour('t3', 3)]
		});
		expect(proof).toMatchObject({
			complete: true,
			hash: HELLO_HASH,
			size: 6,
			evidence: { id: ID, tour: 't2', root: 'root-t2', block: '971230' }
		});
		expect(new TextDecoder().decode(fromBase64(proof.evidence.ots))).toBe('t2.racine.ots');
		expect(new TextDecoder().decode(fromBase64(proof.evidence.tsr))).toBe('t2.racine.tsr');
	});

	it('leaves the timestamp out when the journal did not stamp that root', async () => {
		const proof = await completed({ deposits: deposits(LINE), tours: [tour('t1', 1)] });
		expect(proof.complete).toBe(true);
		expect(proof.evidence.tsr).toBeUndefined();
	});

	it('refuses a journal that lists the receipt for another digest, or an unreadable file', async () => {
		const swapped = LINE.replace(HELLO_HASH, OTHER_HASH);
		await expect(completed({ deposits: deposits(swapped) })).rejects.toMatchObject({
			code: 'NOTARY_REFUSED'
		});
		await expect(completed({ deposits: 'not json\n' })).rejects.toMatchObject({
			code: 'NOTARY_REFUSED'
		});
	});

	it('refuses a receipt with no journal id', async () => {
		const notary = digestJournalNotary({ url: URL_BASE, fetch: journal({}) });
		const receipt: Receipt = {
			notary: 'digest-journal',
			hash: HELLO_HASH,
			depositedAt: RECEIPT.depose,
			complete: false,
			evidence: {}
		};
		await expect(notary.complete(receipt)).rejects.toMatchObject({ code: 'NOTARY_REFUSED' });
	});
});
