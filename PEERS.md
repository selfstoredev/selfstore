# Peers: read-write sharing over read-only links

Share one store between several people without anyone granting WRITE access
to anything. Each member publishes their OWN full copy of the store on their
OWN storage, hands the group a READ-ONLY link to it, and attaches the other
members' links as peers. That is the whole trick: read-write sharing emerges
from crossed read-only links.

Status: shipped. Two group crypto modes:

- **Passphrase (phase 1):** every copy encrypted with ONE shared passphrase,
  exchanged once out of band. Ordinary format-2 boxes, zero new crypto.
- **Passwordless (phase 2):** per-member keys - every copy is Ed25519-SIGNED
  by its author and sealed for each member (X25519 envelopes), membership is
  a manifest signed by one admin. Format generation 3 (SPEC.md section 12).

## Why this topology

Sharing through one common writable file is the awkward classic: write
access is provider-specific to grant, scary to hand out, and concurrent
writers on storage without locks or transactions can clobber each other.
Inverting the topology dissolves all of it, by construction:

- **One writer per file.** Every member only ever writes their own copy;
  write races cannot exist.
- **Blast radius contained.** A buggy or malicious member can only corrupt
  their own copy; the others simply detach that peer.
- **Any provider, mixed freely.** Read-only links exist everywhere; one
  member can publish to Google Drive and another to WebDAV.
- **Every member is a full backup.** The store is state-based, so all copies
  converge to the union of everyone's writes.
- **Gossip is transitive.** Members publish MERGED state, so A receives C's
  writes through B's copy. The link graph does not need to be complete: a
  star around one member propagates everything in two hops (2N links
  instead of N x N).

Prior art: pull-based replication as in git remotes, feed replication as in
Secure Scuttlebutt, applied to a state-based store.

## How it works

On every converge (boot, focus, online, interval, manual gesture, connect),
the store pulls each peer's copy - a cheap `stat()` skips unchanged ones -
and merges it with the machinery that already powers multi-device and
multi-tab (HLC + LWW): a peer is just one more replica. The publish that
follows writes the merged state back to the member's own copy, which is what
lets the other members gossip through it.

Peer data enters through the exact same pipeline as the own target: the
`migrate()` upgrade path, the newer-schema gate, the unsyncable-record
warnings, and the sync journal (peer folds append entries with their source
and conflict values, so the app's existing "what changed" UI covers them).

## API

```ts
import type { PeerSource } from 'selfstore';

// A peer is structurally a READ-ONLY subset of BackupTarget - any existing
// target (built-in or custom) can be attached as a peer as-is; its save()
// is simply never called.
interface PeerSource {
	load(): Promise<Blob | null>; // the peer's published copy, or null
	stat?(): Promise<string | null>; // cheap change marker (skip unchanged)
	readonly label?: string; // display name (defaults to the peer id)
}

const peerId = store.attachPeer(source, { id: 'alice' }); // id optional
store.detachPeer(peerId); // local only; never touches the member's copy
store.state.peers; // [{ id, label, lastSyncAt, lastError }]
```

Bring your own source, or use a built-in one. Any `BackupTarget` is already a
`PeerSource` (its `save` is never called), and there is a ready-made read-only
WebDAV source so a group can share read-write WITHOUT Google Drive - each
member publishes to their own WebDAV and shares a read-only link:

```ts
import { webdavTarget } from 'selfstore';

// A Nextcloud/ownCloud read-only share link (no credentials needed):
store.attachPeer(webdavTarget.peer({ url: BOB_SHARE_URL, label: 'Bob' }), { id: 'bob' });
// ...or a shared path that needs Basic auth (https required then):
store.attachPeer(webdavTarget.peer({ url, username, password }), { id: 'carol' });
```

Anything else is a three-line source over the transport of your choice, e.g. a
public link: `{ load: () => fetch(url).then((r) => (r.ok ? r.blob() : null)) }`.

There is no dedicated "sync the peers" call: `syncNow()` and
`syncIfStale(...)` fold them, like every other converge.

Peers are NOT persisted across sessions (deliberately: what it takes to
rebuild a source - a file id, a URL, a picked handle - is the app's
knowledge, exactly like `restoreTarget`). Re-attach them at boot; attaching
before `init()` just registers, and the boot converge picks them up.

## Encryption option 1: one shared passphrase

The existing password mode, unchanged: every copy in the group is encrypted
with ONE shared passphrase, exchanged once out of band (the same channel
that carries the links). The store opens peer copies with the same password
as its own target.

Rotating the group passphrase = each member runs `setEncryption(next)` on
their own store. Until a member rotates, their copy simply stops folding for
the others (a per-peer `DECRYPT_FAILED`, see below) - nothing breaks.

## Encryption option 2: passwordless groups (per-member keys)

No shared secret at all. Each member holds an identity - an Ed25519 keypair
(signing) and an X25519 keypair (receiving) - and membership is a small
manifest signed by ONE admin:

```ts
import { generateIdentity, identityVault, signManifest, newGroupId } from 'selfstore';

// Each member, once per device (sealed at rest under a device key):
const identity = await identityVault(cache.kv).loadOrCreate();

// The ADMIN builds and signs the membership manifest (single-writer):
const manifest = {
	v: 1, group: newGroupId(), seq: 1, admin: admin.sigPub,
	members: [
		{ id: 'alice', sig: alice.sigPub, enc: alice.encPub },
		{ id: 'bob', sig: bobPublic.sig, enc: bobPublic.enc } // from bob's invite reply
	]
};
const signed = await signManifest(manifest, admin.sigPriv);

// Members attach with { group } instead of { password }. The STORE verifies
// the signed manifest against the admin key pinned from the invite (TOFU):
// a manifest that does not verify rejects with SIGNATURE_INVALID before
// anything changes. (openManifest stays exported for inspecting a manifest
// outside a store.)
await store.attachTarget(myTarget, {
	group: { identity, admin: pinnedAdminKey, manifest: signed }
});
store.attachPeer(bobSource, { id: 'bob' });
```

What the store then does on every publish: draws a FRESH random data key,
seals the copy for every manifest member (X25519 + HKDF envelopes), and SIGNS
it. On every fold: refuses any copy whose author is not a manifest member
(`SIGNATURE_INVALID`), verifies the signature before any decryption, then
opens this member's envelope. `state.peers[].author` reports the VERIFIED
member id behind each peer copy.

Membership changes ride `store.setGroup(nextSigned)` - the admin-signed
manifest as distributed; the store re-verifies it against the pinned admin
key and the attached group id:

- **Add:** the admin publishes seq+1 with the newcomer; members apply it and
  their next publish envelopes for the newcomer (the store republishes
  immediately on setGroup). The newcomer reads everything from then on - and
  receives the full history through the copies (state converges to the union).
- **Remove:** the admin publishes seq+1 without the member; because the data
  key is fresh per publication, the removed member simply stops being a
  recipient of anything new. What they already fetched stays theirs - no
  protocol can undo that; say it honestly in the UI.
- **Rollback protection:** the store persists each group's highest seq and
  refuses older manifests (`MANIFEST_ROLLBACK`), even across sessions.

Requirements and limits: WebCrypto Ed25519 + X25519 (evergreen browsers,
Node 20+; feature-detect with `groupCryptoAvailable()`); the invite channel
is the trust root (TOFU on the admin key); no forward secrecy (long-term
keys - see THREAT-MODEL.md). Group mode and `password` are mutually
exclusive, and a group store never shows the `locked` gate (there is no
password to forget; identity persistence is the app's, via `identityVault`).

## Failure surface

Two hard rules, both pinned by tests:

1. A peer failure NEVER blocks local use or the own publish.
2. Per-peer problems never raise the store's blocking gates - only the own
   target does that. They are recorded per peer on `state.peers[].lastError`
   with the existing stable codes:

| Code | Meaning for a peer | Store impact |
|---|---|---|
| `TARGET_UNAVAILABLE` | transient (offline, 5xx, cold start) | silent retry at the next converge |
| `AUTH_EXPIRED` | read access genuinely lost | surfaced on the peer; fix access in the app, then converge |
| `PASSWORD_REQUIRED` / `DECRYPT_FAILED` | the copy does not open with the group passphrase (rotated, or a wrong link) | surfaced on the peer; the store keeps its OWN password and lock state |
| `UNEXPECTEDLY_UNENCRYPTED` | not the expected kind of copy: plaintext in passphrase mode, or anything non-group in group mode (swap guard) | that copy is refused |
| `SCHEMA_TOO_NEW` | that member runs a newer app schema | that copy is skipped (we never write it, so nothing can be clobbered) |
| `BAD_FORMAT` | the link does not point at a published copy | surfaced on the peer |
| `SIGNATURE_INVALID` | group mode: bad signature, or the author is not a manifest member | that copy is refused |
| `NOT_A_RECIPIENT` | group mode: valid copy, but no envelope for this identity (removed, or published pre-join) | that copy is skipped |

On the OWN target the group refusals (`SIGNATURE_INVALID`, `NOT_A_RECIPIENT`,
`IDENTITY_REQUIRED`) DO raise the blocking gate - a substituted own copy must
stop everything, exactly like a wrong password, and never be clobbered.

## Operational notes

- **Tombstone GC.** A member offline longer than the horizon resurrects
  deletions on return. For grouped stores set `tombstoneHorizonMs` well
  above the longest expected absence (90 days or more), or leave GC off.
- **`forget()` propagates.** With a connected target, `forget()` publishes
  tombstones for everything - and peers fold deletions, so the wipe reaches
  the whole group. That is the documented "data gone everywhere" semantics
  extended to its group; detach the peers first if you only mean one member.
- **Multi-tab.** Peer folding happens inside the same serialized chain (and
  cross-tab Web Lock) as saves and syncs; folded data reaches other tabs
  through the existing fold-on-save cache path.
- **Attribution.** HLC stamps already carry replica ids; an app can map
  replica ids to member names in its own data. The format learns nothing.
- **Size and cadence.** Each converge reads up to N-1 copies (`stat()`
  usually skips most). Intended for small groups (2 to about 10) and
  MB-scale boxes; the existing zip guards apply per copy. Pull-only means
  propagation latency is the converge cadence, not real time.
- **Trust root.** The invitation (links + passphrase, or links + admin key)
  travels over a channel the members already trust - a messenger, email. If
  that channel is compromised at invite time, so is the group. The signed
  manifest narrows every later step to the admin key; the invite moment
  itself cannot be secured further without an external PKI (true of any E2E
  system).

## Out of scope

No push transport (pull only, propagation at converge cadence), no deltas,
no partial replication, no forward secrecy (long-term member keys, see
THREAT-MODEL.md), and no in-band invite exchange (links, admin key and
identity replies travel over the app's own channel).
