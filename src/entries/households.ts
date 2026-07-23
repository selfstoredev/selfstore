/**
 * selfstore/households - read-write sharing that never touches your
 * own file (the capability-link mirror model).
 *
 * Each member keeps their own backup file exactly as they chose it and
 * publishes a dedicated copy of it, sealed under the link key K; the others'
 * copies attach as read-only peers and every converge folds them in.
 * Possession of K is membership: the invitation is one link, revocation is
 * ending the share, and everyone keeps what already converged into their own
 * file - the local-first reality.
 *
 * The engine is headless and injectable: it drives a LocalStore and a KV, and
 * every network side effect goes through the `ShareBackend` port the host app
 * implements (where copy files live, how the bulletin is published, how
 * members announce). See the port's docs in this module; a complete in-memory
 * backend lives in the test suite as a reference.
 */

export {
	createHouseholdGroup,
	HOUSEHOLD_GROUP_KEY,
	type HouseholdGroup,
	type HouseholdGroupState,
	type IncomingShare,
	type ShareBackend
} from '../households/group';

export {
	decodeAnnounce,
	decodeShare,
	encodeAnnounce,
	encodeShare,
	HouseholdCodeError,
	randomId,
	toCopyLink,
	toRoster,
	type AnnouncePayload,
	type CopyLink,
	type DriveCopyLink,
	type HouseholdCodeErrorCode,
	type SharePayload
} from '../households/codec';
