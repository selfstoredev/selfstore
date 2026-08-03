/**
 * selfstore/groups - passwordless group encryption. EXPERIMENTAL.
 *
 * This is the one subpath outside the package's stability promise: the exports
 * below may change shape, or be withdrawn, in a MINOR release. Everything else
 * - the package root and the other subpaths - waits for a major.
 *
 * The reason is evidence, not doubt about the cryptography. No application has
 * shipped this API, so its shape has never been tested by a second pair of
 * hands, and it is the most security-sensitive surface in the package: a
 * contract nobody has exercised is a promise rather than a fact. Saying so is
 * cheaper for everyone than discovering it in a major.
 *
 * The FILE is not experimental. Group mode is format generation 2, specified in
 * SPEC.md section 12 with a canonical `group.zip` test vector, and it keeps the
 * same guarantee as every other backup: what any version writes, every later
 * version reads. An app that adopts this today can be made to recompile; its
 * users' files cannot be stranded.
 *
 * Share one encrypted store between devices or people without a shared
 * password: each member holds an X25519/Ed25519 identity, every backup copy
 * carries a sealed envelope per member, and membership travels as a signed,
 * rollback-protected manifest. The store consumes this through
 * `LocalStoreOptions.group` / `store.setGroup` ('selfstore/advanced'); the
 * primitives live here for key ceremony, invitations and custom flows.
 * Threat model and protocol: PEERS.md in the repository.
 */

export {
	groupCryptoAvailable,
	generateIdentity,
	publicIdentity,
	newGroupId,
	keyId,
	signManifest,
	openManifest,
	GROUP_KEYING,
	type GroupIdentity,
	type GroupMember,
	type GroupManifest,
	type SignedManifest
} from '../selfstore/group';

/** Durable, optionally passphrase-locked storage for a member's identity. */
export { identityVault, type IdentityVault } from '../persistence/identity';
