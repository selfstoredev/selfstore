/**
 * selfstore/groups - passwordless group encryption.
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
