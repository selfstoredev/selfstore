// A notary over a public digest journal: a service that takes a SHA-256 with
// no account, writes it as one line of a public deposits file, and folds that
// file into a Merkle tree it anchors in Bitcoin (OpenTimestamps) and often
// stamps under RFC 3161 too. The deposit answers at once with the journal's
// own receipt; the anchor comes hours later, so `complete` is what fetches it.
//
// The protocol, relative to the journal's base URL:
//   POST /api/depots              {"sha256", "libelle"?} -> 201
//        {"id", "jour", "place", "ligne", "recu": {"sha256", "depose", ...}}
//   GET  /empreintes/depots.jsonl one JSON line per deposit, in order, with "recu" = id
//   GET  /tours.json              {"tours": [{"id", "racine", "depots", "ots", "bloc",
//                                  "horodatage", "fichiers"}]}; a tour covers the
//                                  first `depots` lines of the deposits file
//   GET  /empreintes/<tour>.racine.ots, /empreintes/<tour>.racine.tsr

import { toBase64 } from '../selfstore/base64';
import { SelfstoreError } from '../selfstore/errors';
import type { Notary, Receipt } from './proof';
import { reach } from './reach';

export interface JournalOptions {
	/** The journal's base URL, e.g. 'https://journal.example'. */
	url: string;
	/** Receipt `notary` field. Defaults to 'digest-journal'. */
	name?: string;
	/** Injected for tests and relays; defaults to the global fetch. */
	fetch?: typeof fetch;
}

interface Deposit {
	id: string;
	ligne: string;
	recu: { sha256: string; depose: string };
}

interface Tour {
	id: string;
	racine: string;
	depots: number;
	ots: string;
	bloc: number | null;
	horodatage: string | null;
	fichiers?: string[];
}

const HEX_ID = /^[0-9a-f]{64}$/;

function refused(message: string): SelfstoreError {
	return new SelfstoreError('NOTARY_REFUSED', message);
}

function readDeposit(body: unknown): Deposit {
	const d = body as Partial<Deposit> | null;
	if (
		typeof d?.id !== 'string' ||
		!HEX_ID.test(d.id) ||
		typeof d.ligne !== 'string' ||
		typeof d.recu?.sha256 !== 'string' ||
		typeof d.recu.depose !== 'string'
	) {
		throw refused('the journal answered without a receipt');
	}
	return d as Deposit;
}

function parseLine(text: string): { recu?: string; sha256?: string } {
	try {
		return JSON.parse(text) as { recu?: string; sha256?: string };
	} catch {
		throw refused('the journal published an unreadable deposits file');
	}
}

/** 1-based rank of the deposit line whose receipt id is `id`, or 0. */
function rankOf(deposits: string, id: string, hash: string): number {
	const lines = deposits.split('\n').filter(Boolean);
	for (const [index, text] of lines.entries()) {
		const line = parseLine(text);
		if (line.recu !== id) continue;
		if (line.sha256 !== hash) throw refused('the journal lists this receipt for another digest');
		return index + 1;
	}
	return 0;
}

/**
 * A notary over a public digest journal (the protocol is at the top of this
 * file). The label is sent as the journal's `libelle`: keep it a TYPE.
 *
 * On deposit the receipt is incomplete; its evidence holds the journal's
 * address, the receipt `id`, the public `line` and the journal's own `receipt`
 * as JSON - the file its verifier reads. `complete` finds the first tour that
 * covers the line and, once that tour is anchored in Bitcoin, completes the
 * receipt with `tour`, `root`, `block`, the `.ots` proof and, when the journal
 * stamped that root, the `.tsr` token (both base64). Checking the Merkle path
 * from the line to the root is the journal's verifier's job.
 */
export function digestJournalNotary(options: JournalOptions): Notary {
	const name = options.name ?? 'digest-journal';
	const base = options.url.replace(/\/+$/, '');
	const send = options.fetch ?? globalThis.fetch;
	const get = (path: string): Promise<Response> =>
		reach(send, `${base}${path}`, undefined, 'the journal');
	const bytesOf = async (path: string): Promise<string> =>
		toBase64(new Uint8Array(await (await get(path)).arrayBuffer()));

	return {
		name,
		async deposit(hash: string, label?: string): Promise<Receipt> {
			const response = await reach(
				send,
				`${base}/api/depots`,
				{
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ sha256: hash, ...(label === undefined ? {} : { libelle: label }) })
				},
				'the journal'
			);
			const deposit = readDeposit(await response.json().catch(() => null));
			return {
				notary: name,
				hash: deposit.recu.sha256,
				...(label === undefined ? {} : { label }),
				depositedAt: deposit.recu.depose,
				complete: false,
				evidence: {
					journal: base,
					id: deposit.id,
					line: deposit.ligne,
					receipt: JSON.stringify(deposit.recu)
				}
			};
		},
		async complete(receipt: Receipt): Promise<Receipt> {
			const id = receipt.evidence.id;
			if (id === undefined) throw refused('the receipt carries no journal id');
			const rank = rankOf(await (await get('/empreintes/depots.jsonl')).text(), id, receipt.hash);
			if (rank === 0) return receipt;
			const { tours } = (await (await get('/tours.json')).json()) as { tours: Tour[] };
			const tour = tours.find((t) => t.depots >= rank);
			if (tour?.ots !== 'bitcoin') return receipt;
			const stamped = tour.horodatage !== null && tour.fichiers?.includes(`${tour.id}.racine.tsr`);
			return {
				...receipt,
				complete: true,
				evidence: {
					...receipt.evidence,
					tour: tour.id,
					root: tour.racine,
					...(tour.bloc === null ? {} : { block: String(tour.bloc) }),
					ots: await bytesOf(`/empreintes/${tour.id}.racine.ots`),
					...(stamped ? { tsr: await bytesOf(`/empreintes/${tour.id}.racine.tsr`) } : {})
				}
			};
		}
	};
}
