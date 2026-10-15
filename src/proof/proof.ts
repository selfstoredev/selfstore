// Proof of existence for the user's own documents: the bytes never leave the
// device, only their SHA-256 does. A notary dates that digest; the receipt it
// hands back is kept next to the file, in the user's own storage, and anyone
// holding the file and the receipt can check the two still belong together.

import { sha256Hex } from '../selfstore/digest';
import { isSelfstoreError, SelfstoreError } from '../selfstore/errors';
import { toBytes, type FileBytes } from '../simple/bytes';
import type { SimpleRecord } from '../simple/simple';

/**
 * What a notary hands back for one digest. `evidence` is the notary's own
 * material (a timestamp token, an inclusion path, a download address), as
 * strings - base64 for bytes - so a receipt is plain JSON and survives every
 * destination a store can write to.
 */
export interface Receipt {
	/** The notary that issued it (`Notary.name`). */
	readonly notary: string;
	/** Lowercase hex SHA-256 of the document. */
	readonly hash: string;
	/** The label sent with the deposit, if any. */
	readonly label?: string;
	/** ISO 8601 instant the notary vouches for (its clock, not the device's). */
	readonly depositedAt: string;
	/** False while the notary still has something to add (an anchor, a seal). */
	readonly complete: boolean;
	readonly evidence: Readonly<Record<string, string>>;
}

/**
 * Anyone who dates a digest. `deposit` must never see more than the digest and
 * the label; `complete` is called later - the next day, the next launch - and
 * returns the same receipt with whatever the notary could not give at once.
 * A notary that is final on deposit returns its argument unchanged.
 */
export interface Notary {
	readonly name: string;
	deposit(hash: string, label?: string): Promise<Receipt>;
	complete(receipt: Receipt): Promise<Receipt>;
}

/** A receipt as `prove()` keeps it: the notary's, plus what the device measured. */
export interface Proof extends Receipt {
	readonly kind: 'selfstore-proof';
	readonly version: 1;
	readonly algorithm: 'SHA-256';
	/** Size of the document in bytes. */
	readonly size: number;
	/** The store file the proof belongs to, when there is one. */
	readonly file?: string;
}

/** Where proofs are kept: the simple store fits as is. */
export interface ProofShelf {
	put(collection: string, record: SimpleRecord): Promise<void>;
}

/** The collection `prove()` and `completeProof()` write to. */
export const PROOFS = 'proofs';

export interface ProveOptions {
	notary: Notary;
	/** Sent to the notary with the digest. A TYPE ('invoice', 'inventory'),
	 *  never a name or a piece of the content: it leaves the device. */
	label?: string;
	/** Keep the proof in this store, under `PROOFS`, keyed by `file` or by hash. */
	store?: ProofShelf;
	/** Id of the store file the document is (as `putFile` returned it). */
	file?: string;
}

/** The result of `verify()`. */
export interface ProofCheck {
	/** The bytes hash to the receipt's digest (and size, when it carries one). */
	readonly matches: boolean;
	/** What the bytes hash to now. */
	readonly hash: string;
	/** Whether the notary had finished with this receipt. */
	readonly complete: boolean;
}

const HEX_DIGEST = /^[0-9a-f]{64}$/;

function refused(message: string): SelfstoreError {
	return new SelfstoreError('NOTARY_REFUSED', message);
}

/** A notary that answers for another digest, or for another notary, is not believed. */
function checkAnswer(answer: Receipt, hash: string, notary: Notary): void {
	if (typeof answer?.hash !== 'string' || answer.hash.toLowerCase() !== hash) {
		throw refused(`${notary.name} answered for another digest`);
	}
	if (answer.notary !== notary.name) {
		throw refused(`receipt names ${String(answer.notary)}, not ${notary.name}`);
	}
	if (Number.isNaN(Date.parse(answer.depositedAt))) {
		throw refused(`${notary.name} gave no readable deposit time`);
	}
}

async function shelve(proof: Proof, store: ProofShelf | undefined): Promise<void> {
	if (store) await store.put(PROOFS, { ...proof, id: proof.file ?? proof.hash });
}

/**
 * Hash `blob` on the device, deposit the digest with `options.notary`, and
 * return the proof - kept in `options.store` too when one is given. Only the
 * digest and the label leave the device.
 *
 * Throws NOTARY_UNAVAILABLE when the notary cannot be reached (retry later)
 * and NOTARY_REFUSED when it refuses or answers for something else.
 */
export async function prove(blob: FileBytes, options: ProveOptions): Promise<Proof> {
	const bytes = await toBytes(blob);
	const hash = await sha256Hex(bytes);
	const answer = await options.notary.deposit(hash, options.label);
	checkAnswer(answer, hash, options.notary);
	const proof: Proof = {
		...answer,
		hash,
		kind: 'selfstore-proof',
		version: 1,
		algorithm: 'SHA-256',
		size: bytes.length,
		...(options.file === undefined ? {} : { file: options.file })
	};
	await shelve(proof, options.store);
	return proof;
}

/**
 * Ask the notary for what it could not give on deposit. A complete proof is
 * returned as is, without a call. The fields the device measured are kept;
 * the notary may only add to its own.
 */
export async function completeProof(
	proof: Proof,
	options: { notary: Notary; store?: ProofShelf }
): Promise<Proof> {
	if (proof.complete) return proof;
	const answer = await options.notary.complete(proof);
	checkAnswer(answer, proof.hash, options.notary);
	const completed: Proof = {
		...answer,
		hash: proof.hash,
		kind: proof.kind,
		version: proof.version,
		algorithm: proof.algorithm,
		size: proof.size,
		...(proof.file === undefined ? {} : { file: proof.file })
	};
	await shelve(completed, options.store);
	return completed;
}

/**
 * Hash `blob` again and compare it with the receipt. This proves the bytes are
 * the ones the receipt names; that the receipt itself is genuine is what the
 * notary's evidence is for, checked with the notary's own verifier.
 *
 * Throws BAD_FORMAT on a receipt that carries no SHA-256 digest at all - a
 * damaged receipt is not a document that changed.
 */
export async function verify(
	blob: FileBytes,
	receipt: Pick<Receipt, 'hash' | 'complete'> & { size?: number }
): Promise<ProofCheck> {
	const expected = typeof receipt?.hash === 'string' ? receipt.hash.toLowerCase() : '';
	if (!HEX_DIGEST.test(expected)) {
		throw new SelfstoreError('BAD_FORMAT', 'the receipt carries no SHA-256 digest');
	}
	const bytes = await toBytes(blob);
	const hash = await sha256Hex(bytes);
	const sizeAgrees = receipt.size === undefined || receipt.size === bytes.length;
	return { matches: hash === expected && sizeAgrees, hash, complete: receipt.complete === true };
}

/** Where proofs are read back from: the simple store fits as is. */
export interface ProofLibrary extends ProofShelf {
	all(collection: string): readonly SimpleRecord[];
}

function isProof(record: SimpleRecord): boolean {
	return (
		record.kind === 'selfstore-proof' &&
		typeof record.hash === 'string' &&
		HEX_DIGEST.test(record.hash) &&
		typeof record.notary === 'string' &&
		typeof record.complete === 'boolean'
	);
}

/**
 * Every proof kept in `store`, oldest deposit first. Records that are not
 * proofs - another app's, a damaged one - are skipped rather than trusted.
 */
export function proofsIn(store: Pick<ProofLibrary, 'all'>): Proof[] {
	return store
		.all(PROOFS)
		.filter(isProof)
		.map((record) => {
			const { id: _id, ...proof } = record;
			return proof as unknown as Proof;
		})
		.sort((a, b) => Date.parse(a.depositedAt) - Date.parse(b.depositedAt));
}

/** What `completePending()` did, proof by proof. */
export interface PendingRound {
	/** Finished this round, and written back to the store. */
	readonly completed: readonly Proof[];
	/** Still waiting: the notary has nothing to add yet, could not be reached,
	 *  or is not among the notaries given. Ask again on a later launch. */
	readonly pending: readonly Proof[];
	/** The notary answered for something else; kept as it was, not overwritten. */
	readonly refused: readonly Proof[];
}

function isCode(error: unknown, code: string): boolean {
	return isSelfstoreError(error) && error.code === code;
}

/**
 * Ask each notary to finish the incomplete proofs it issued - the call an app
 * makes at launch, since a notary that anchors its digests finishes a receipt
 * hours after the deposit. A notary that cannot be reached is not asked again
 * this round; a proof whose notary is not in `notaries` waits. Only a proof
 * that came back complete is written to the store.
 */
export async function completePending(options: {
	store: ProofLibrary;
	notaries: readonly Notary[];
}): Promise<PendingRound> {
	const byName = new Map(options.notaries.map((notary) => [notary.name, notary]));
	const unreachable = new Set<string>();
	const completed: Proof[] = [];
	const pending: Proof[] = [];
	const refused: Proof[] = [];
	for (const proof of proofsIn(options.store)) {
		if (proof.complete) continue;
		const notary = byName.get(proof.notary);
		if (notary === undefined || unreachable.has(notary.name)) {
			pending.push(proof);
			continue;
		}
		try {
			const answer = await completeProof(proof, { notary });
			if (answer.complete) {
				await shelve(answer, options.store);
				completed.push(answer);
			} else {
				pending.push(proof);
			}
		} catch (error) {
			if (isCode(error, 'NOTARY_UNAVAILABLE')) {
				unreachable.add(notary.name);
				pending.push(proof);
			} else if (isCode(error, 'NOTARY_REFUSED')) {
				refused.push(proof);
			} else {
				throw error;
			}
		}
	}
	return { completed, pending, refused };
}
