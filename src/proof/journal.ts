// A notary over a public digest journal: a service that takes a SHA-256 with
// no account, writes it as one line of a public deposits file, and folds that
// file into a Merkle tree it anchors in Bitcoin (OpenTimestamps) and often
// stamps under RFC 3161 too. The deposit answers at once with the journal's
// own receipt; the anchor comes hours later, so `complete` is what fetches it.
//
// The protocol, relative to the journal's base URL:
//   POST /api/depots              {"sha256", "libelle"?, "type"?} -> 201
//        {"id", "jour", "place", "ligne", "recu": {"sha256", "depose", ...}}
//   GET  /empreintes/depots.jsonl one JSON line per deposit, in order, with "recu" = id
//   GET  /tours.json              {"tours": [{"id", "instant"?, "racine", "depots", "ots",
//                                  "bloc", "horodatage", "fichiers"}]}; a tour covers the
//                                  first `depots` lines of the deposits file as it
//                                  stood at its `instant`
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
	/**
	 * The journal's deposit type, sent as `type` with every deposit (a journal
	 * that issues typed receipts, such as a permit display, keys them on it).
	 * None by default: the deposit is the journal's ordinary one.
	 */
	type?: string;
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
	instant?: string;
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

/**
 * Whether a tour can cover a line deposited at `depositedAt`: a tour folded the
 * file before the deposit cannot, whatever its size. A journal that publishes
 * no `instant` leaves the question open.
 */
function mayCover(tour: Tour, depositedAt: string): boolean {
	if (tour.instant === undefined) return true;
	const folded = Date.parse(tour.instant);
	const deposited = Date.parse(depositedAt);
	return Number.isNaN(folded) || Number.isNaN(deposited) || folded > deposited;
}

/**
 * Whether reading the deposits file can complete the receipt: only once a tour
 * folded after the deposit is anchored in Bitcoin. Until then the first tour
 * covering the line is either absent or not anchored, and the receipt stays
 * as it is without the file (which grows with every deposit of every user).
 */
function worthReading(tours: readonly Tour[], depositedAt: string): boolean {
	return tours.some((t) => t.depots > 0 && t.ots === 'bitcoin' && mayCover(t, depositedAt));
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
 * file). The label is sent as the journal's `libelle`: keep it a TYPE, unless
 * the journal's `type` (an option of the notary) says what the label is.
 *
 * On deposit the receipt is incomplete; its evidence holds the journal's
 * address, the receipt `id`, the public `line` and the journal's own `receipt`
 * as JSON - the file its verifier reads. `complete` finds the first tour that
 * covers the line and, once that tour is anchored in Bitcoin, completes the
 * receipt with `tour`, `root`, `block`, the `.ots` proof and, when the journal
 * stamped that root, the `.tsr` token (both base64). Checking the Merkle path
 * from the line to the root is the journal's verifier's job.
 *
 * `complete` reads the tour list first and the deposits file only when a tour
 * folded after the deposit is anchored: the file lists every deposit of every
 * user and grows without end, the tour list stays small.
 */
export function digestJournalNotary(options: JournalOptions): Notary {
	const name = options.name ?? 'digest-journal';
	const base = options.url.replace(/\/+$/, '');
	const typed = options.type === undefined ? {} : { type: options.type };
	const send = options.fetch ?? globalThis.fetch;
	const get = (path: string): Promise<Response> =>
		reach(send, `${base}${path}`, undefined, 'the journal');
	const bytesOf = async (path: string): Promise<string> =>
		toBase64(new Uint8Array(await (await get(path)).arrayBuffer()));
	// The deposits file, read once per state of the tour list: a line covered by
	// a known tour was already in the copy read after that tour was listed, so a
	// round that completes many receipts reads the file once, not once each.
	let deposits: { key: string; text: string } | undefined;
	const depositsFile = async (tours: readonly Tour[]): Promise<string> => {
		const last = tours.at(-1);
		const key = last === undefined ? '' : `${last.id}:${last.depots}`;
		if (deposits?.key !== key) {
			deposits = { key, text: await (await get('/empreintes/depots.jsonl')).text() };
		}
		return deposits.text;
	};

	return {
		name,
		async deposit(hash: string, label?: string): Promise<Receipt> {
			const response = await reach(
				send,
				`${base}/api/depots`,
				{
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({
						sha256: hash,
						...(label === undefined ? {} : { libelle: label }),
						...typed
					})
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
			const { tours } = (await (await get('/tours.json')).json()) as { tours: Tour[] };
			if (!worthReading(tours, receipt.depositedAt)) return receipt;
			const rank = rankOf(await depositsFile(tours), id, receipt.hash);
			if (rank === 0) return receipt;
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
