/**
 * selfstore/proof - prove that a document existed, without handing it over.
 *
 * `prove(blob, { notary })` hashes the bytes on the device, deposits the
 * SHA-256 with a notary, and keeps the receipt next to the file in the user's
 * own store. `verify(blob, receipt)` hashes again and compares. Only the digest
 * and an optional label ever leave the device.
 *
 * A notary is an interface - `deposit(hash, label)` returns a receipt,
 * `complete(receipt)` finishes one later - so any service that dates digests
 * plugs in. `rfc3161Notary` is the first adapter, over any RFC 3161
 * time-stamping authority; `digestJournalNotary` the second, over a public
 * digest journal anchored in Bitcoin.
 */

export {
	prove,
	verify,
	completeProof,
	PROOFS,
	type Notary,
	type Receipt,
	type Proof,
	type ProofCheck,
	type ProofShelf,
	type ProveOptions
} from '../proof/proof';
export {
	rfc3161Notary,
	readTimestampReply,
	timestampReplyOf,
	type Rfc3161Options,
	type TimestampToken
} from '../proof/rfc3161';
export { digestJournalNotary, type JournalOptions } from '../proof/journal';
