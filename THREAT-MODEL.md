# Threat model

This document states what selfstore protects, against whom, and where its
protection stops. It is deliberately explicit about non-goals: a security tool
that overpromises is worse than one whose limits you can design around. For the
reporting policy see [SECURITY.md](./SECURITY.md).

## What selfstore is

A browser library that keeps an app's data in a local IndexedDB working copy
(its collections and file blobs sealed at rest under a non-extractable
per-device key), writes portable encrypted backups (a ZIP holding AES-256-GCM
ciphertext over an Argon2id-derived key), pushes those backups to a durable home
the user chooses
(a disk file, Google Drive, a WebDAV server, an S3 bucket), and merges across
devices with a logical-clock (HLC) last-writer-wins engine. There is no
selfstore server: the browser talks straight to the user's chosen destination.

## Assets

1. **Confidentiality of backup contents.** The user's records and files, once a
   password is set, must be unreadable to anyone holding the backup file.
2. **Integrity of backup contents.** A reader must detect any tampering with an
   encrypted backup rather than silently load altered data.
3. **Availability of local data.** A remote problem (offline, a hostile or
   broken target) must not destroy the local working copy or its committed
   edits.
4. **Local credentials.** Target passwords/tokens must not be trivially
   recoverable from disk.

## Trust boundaries

| Party | Trust |
|---|---|
| The app's own origin (its JS) | **Trusted.** It gathers and renders the data; it can read anything the user can. selfstore cannot defend data from the code it runs inside. |
| The browser + WebCrypto + IndexedDB | Trusted platform. |
| The durable target (Drive, WebDAV server, a synced folder) | **Untrusted for confidentiality.** With a password it only ever holds ciphertext. Semi-trusted for availability (it can withhold or roll back a file). |
| The network | **Untrusted.** Encrypted backups are ciphertext in transit; WebDAV Basic-auth is refused over plain http (loopback excepted). |
| Another origin / an XSS payload | **Hostile, largely out of scope** (see Non-goals). |

## Threats and mitigations

### T1 - The target operator reads a backup
A Drive admin, a WebDAV host, or anyone who obtains the file. **Mitigation:**
with a password the payload is AES-256-GCM under a random data key, itself
wrapped per password with Argon2id (46 MiB, 3 passes, 16-byte salt per slot;
the password envelope, SPEC.md 13). The target sees ciphertext plus a small
cleartext `meta.json` (app name, date, the per-slot KDF parameters, IVs).
Those cosmetic fields are
**not** secret and **not** authenticated - never base a security decision on
them. An unencrypted backup (no password) is a plain ZIP and confidential to no
one; that is the documented cost of browsability. An app that must never let a
target hold plaintext sets `requireEncryption`: the store then refuses to attach
a destination, publish, or drop encryption without a password (or a group),
turning "encrypted is the price of confidentiality" from a default into an
enforced invariant (`ENCRYPTION_REQUIRED`).

### T2 - Offline brute-force of the password
The attacker has the file and grinds passwords. **Mitigation:** Argon2id at
46 MiB / t=3 makes each guess memory-hard (~1-2 s on a phone). Cost is bounded
by the user's password entropy - selfstore cannot rescue a weak password, and
says so. Parameters are per slot, so a slot added long ago keeps its (possibly
weaker) cost; a fresh slot always uses the current setting. An app raises the
entropy floor with `passwordPolicy` (minimum length, character classes),
enforced at protect()/addKey time (`WEAK_PASSWORD`) - the app-side complement to
the per-guess cost, since Argon2id only buys time against a password that had
some entropy to begin with. A policy bounds the worst case; it is not a
guarantee of a strong password.

### T3 - Tampering with an encrypted backup
Flipping ciphertext bytes, or editing the KDF/IV to steer decryption.
**Mitigation:** AES-GCM authenticates the ciphertext; the effective `kdf` and
`iv` feed the same decrypt, so altering them makes authentication fail. Any
change surfaces as `DECRYPT_FAILED`, never as silently-wrong plaintext.

### T4 - Downgrade / plaintext substitution
An attacker with write access to the target swaps the encrypted backup for a
crafted **plaintext** one, hoping it loads with no password prompt.
**Mitigation:** the store remembers that its home is encrypted and refuses a
backup whose header says `encryption: none` (`UNEXPECTEDLY_UNENCRYPTED`),
rather than adopting the plaintext.

### T5 - Cipher/KDF confusion
A file declares an unknown cipher or KDF to provoke misbehaviour.
**Mitigation:** the reader accepts only `aes-256-gcm` + `argon2id`; anything
else is `UNSUPPORTED_VERSION` (not a misleading `DECRYPT_FAILED`), so foreign
parameters are never fed to AES-GCM.

### T6 - Memory-hard bomb (hostile KDF parameters)
A crafted backup sets `m` to gigabytes so that merely *opening* it exhausts
memory before any password check. **Mitigation:** a read-side ceiling refuses
Argon2id parameters above 1 GiB / t=10 / p=4 (far above what we ever write) as
`UNSUPPORTED_VERSION`, before touching the KDF. In envelope mode (format 3)
every SLOT carries its own parameters and each is checked against the same
ceiling before its trial; the slot count itself is capped at 8, so a crafted
file cannot demand unbounded memory-hard work by listing slots.

### T6b - Envelope slot manipulation
An attacker holding the file adds, strips or relabels password slots.
**Mitigation:** the exact `meta.json` bytes are the `data.enc` GCM AAD, so an
in-place edit to the slot table (or any header field) fails the decrypt tag,
and re-emitting the file under an unauthenticated shape fails outright - the
reader accepts no envelope format but 5. Each wrap is itself AES-GCM (a
tampered `wrapped`/`iv`/`kdf` fails that slot: wrong-password and tampering
stay one case). Slot `id`s are cosmetic locators; nothing security-relevant
reads them. What the envelope guarantees: knowing ONE slot's password never
reveals another slot's password, and REMOVING a slot is not revocation -
whoever held a password may hold the file and the data key; only a data-key
rotation (setEncryption) cuts future access. The store enforces the
distinction and additionally write-verifies every slot change (the new table
must open with the session's password before the file lands) and refuses a
removal that would lock the current session out.

### T7 - Decompression bomb
A tiny archive that inflates to a huge one. **Mitigation:** two guards - a
per-entry cap (512 MiB) and an aggregate cap (1 GiB across the archive), so
neither one big entry nor many small ones can blow up a reader.

### T8 - Stale-schema corruption
A device still on an older data schema pulls (or is handed) data written by a
newer one. **Mitigation:** the store gates on `SCHEMA_TOO_NEW`, blocks pushes,
and keeps the version stamp from ever moving *down* - so a downgraded app cannot
clear its own gate on reboot and clobber the newer backup.

### T9 - Credential theft from local storage
Someone reads IndexedDB/localStorage on the device. **Mitigation:** the backup
password lives in memory only and is never written to web storage (a reload
re-prompts). WebDAV credentials and the S3 secret access key are sealed at rest
under a per-device non-extractable WebCrypto key (the same seal mechanism for
both). The Drive access token is held in memory only. An auto-lock drops the
in-memory password after inactivity.

### T10 - Cleartext credentials on the wire
WebDAV sends the password as HTTP Basic auth on every request. **Mitigation:**
non-https WebDAV URLs are refused at connect time (loopback excepted for local
development), so credentials never travel in cleartext. S3 is stronger by
construction: requests are AWS SigV4-signed (HMAC-SHA256 over the canonical
request), so the secret key computes a per-request signature locally and never
leaves the device - only the signature, the access-key id and the signed
headers travel. https is enforced there too (loopback excepted), so the object
bytes stay confidential in transit.

### T11 - Journal metadata leaking to unencrypted storage
The sync journal records auto-resolved conflicts (both edited versions) for the
session's resolution UI. The kv bookkeeping space is **not** encrypted.
**Mitigation:** persisted journal entries are redacted to
`{collection, id, kept}` - the full record values live in memory only and never
land in kv.

### T12 - A second home widens the operator set
`attachReplica` writes the SAME encrypted backup, under the SAME data key, to an
extra target for resilience (a mirror-for-availability, not a re-key).
**Mitigation is the encryption itself:** every replica operator holds only
ciphertext (T1), so N homes disclose no more than one - a replica buys
availability, not a new key and not a new disclosure surface. The honest
corollary: with no password set, a replica copies plaintext to one more
operator, so fanning out is exactly when `requireEncryption` earns its keep.

### T13 - A lost or forensically-imaged device
Someone images the disk, dumps the IndexedDB object stores, or exfiltrates part
of the profile. **Mitigation:** the local cache seals the collections snapshot
and every file blob under a non-extractable per-device AES-256-GCM key
(cache-crypto), fresh IV per record; only the small kv bookkeeping (sync
metadata, the redacted journal - T11) stays in the clear. A raw dump of the
stored values is ciphertext, and the key's bytes can never be read back out.
**Honest boundary:** the key is a non-extractable handle kept in the SAME
database, so it defeats casual inspection, partial exfiltration and forensic
value-dumps - NOT a copy of the WHOLE browser profile (the key travels with it
and stays usable), nor code running in the origin (which decrypts through the
same key). To defeat a full-profile copy too, opt into `cacheLock`: the cache is
then sealed under a key derived from a secret held only in memory (a password,
or an app-supplied key such as a passkey PRF) and never written to disk, so the
copied profile carries no usable key. It costs one unlock per session and does
not change the origin ceiling (once unlocked, code in the page decrypts).

## Known limitations (explicit non-goals)

- **A compromised app origin (XSS).** Code running in the app's origin can read
  whatever the app can, including the in-memory password and the live data.
  selfstore is defence-in-depth (secrets out of web storage), not a sandbox
  against the app itself. Preventing XSS is the app's responsibility.

- **Rollback / stale-backup replay.** An attacker with write access to the
  target can serve an *older* backup. selfstore does not have a signed,
  monotonic version counter, so it cannot by itself prove a backup is the latest
  - full anti-rollback needs server cooperation or signatures, out of scope for a
  serverless brick. What *is* guaranteed: the merge is last-writer-wins by
  logical clock, so a rolled-back remote **cannot erase committed local edits** -
  they carry newer clocks and win the next converge. The residual risk is a
  *fresh* device (no local data) restoring a rolled-back copy. Mitigate by
  encrypting backups and using a destination only the user controls.

- **Metadata.** Even for an encrypted backup, the cleartext `meta.json` reveals
  the app name and creation date, and the ciphertext's *size* leaks the rough
  data volume. Record ids, collection names and sync clocks travel **inside** the
  encrypted envelope (in `sync.json` / the encrypted manifest), so they are not
  exposed; file and total sizes are.

- **Password recovery.** There is no backdoor and no recovery: lose the password,
  lose an encrypted backup. This is a promise, not a gap.

- **Zeroizing secrets.** JavaScript strings cannot be reliably wiped from memory;
  the password persists in the JS heap until GC.

- **Cross-tab messages.** Multi-tab coordination broadcasts only a tab id and a
  message kind on a same-origin BroadcastChannel; user data never travels on
  the channel (state moves through IndexedDB). Same-origin code can already
  read the cache directly - see the XSS non-goal above.

- **Real-time collaboration.** The engine is state-based LWW, not a sequence
  CRDT. Concurrent edits converge (latest wins, conflicts surfaced) but there is
  no character-level merge. Store an Automerge/Yjs document as a binary file for
  that.

## Passwordless groups (peers phase 2)

Group mode (SPEC.md section 12, PEERS.md) replaces the shared passphrase with
per-member keys. What it adds, and what it honestly cannot:

- **Trust root = the invite channel (TOFU).** A new member pins the admin's
  key from the invite; the invite travels over a channel the members already
  trust (a messenger, email, a QR shown in person). An attacker controlling
  that channel AT INVITE TIME owns the membership - true of any end-to-end
  system without an external PKI. After the pin, manifest forgery requires
  the admin's private key. The STORE verifies every manifest against the
  pinned key itself (attach and setGroup take the admin-signed manifest) -
  the verification is not delegated to the app, so it cannot be forgotten.
- **Authorship is signed, not assumed.** Every published copy is
  Ed25519-signed by its author, and a copy is folded ONLY if its author is in
  the signed manifest. All recipients share each publication's data key, so a
  malicious member could re-encrypt altered data - but they cannot sign it as
  someone else: the signature, not the GCM tag, is the integrity root.
- **Compromised member.** A member's device compromise leaks everything that
  member can read (the whole group state - by design, every member holds the
  union) and lets the attacker publish as that member until the admin removes
  them from the manifest. Blast radius on STORAGE stays contained: a member
  can only ever corrupt their own copy.
- **Removal is forward-only, and takes effect per member as they apply it.** A
  fresh data key is drawn per publication and enveloped for the CURRENT members,
  so a removed member reads nothing published after removal - and keeps
  everything before it (already on their disk; no protocol can undo that).
  Membership is a signed manifest, not a live revocation: a member still on an
  OLDER manifest keeps trusting a just-removed member's copies until they apply
  the admin's seq+1 removal. So removal fully closes only once every member has
  the new manifest - propagate it promptly. The store persists a monotonic seq
  high-water mark (surviving detach and forget) so a replayed OLDER manifest
  re-adding a removed member is refused.
- **Manifest rollback.** Consumers persist the manifest's monotonic `seq` per
  group and refuse older ones, so a replayed old manifest cannot silently
  re-add a removed member. The admin key's compromise defeats this (it can
  sign a fresh higher seq).
- **Identity at rest.** Member private keys are sealed with the same
  device-key mechanism as the WebDAV credentials (AES-GCM under a
  non-extractable key in the same IndexedDB): defeats disk forensics and
  partial exfiltration, NOT code running in the origin or a full-profile
  copy. Moving an identity between a member's devices is the app's job, over
  a channel the user trusts - never through the group's shared storage.
- **Opt-in identity passphrase lock.** `vault.protect(passphrase)` reseals
  the identity under an Argon2id-derived key (the backup KDF's write-side
  defaults and read-side ceiling) instead of the device key. That closes the
  full-profile gap above: a copied browser profile or an exfiltrated kv can
  no longer USE the identity without the passphrase, and the vault refuses to
  open, replace or re-mint a locked identity (`PASSWORD_REQUIRED`). It does
  NOT defend against code running in the origin while the user unlocks (the
  decrypted identity is then in memory), a keylogger capturing the
  passphrase, or a weak passphrase - Argon2id slows brute force, it cannot
  fix a guessable one. There is no recovery: a forgotten passphrase means
  `clear()` and a re-import from another device, or a fresh invite.
- **Metadata.** A group copy's cleartext header additionally reveals the
  author's public key, the RECIPIENT COUNT and stanza key ids (hashes, not
  names). Whoever holds the file learns the group's size, not its membership.
- **No post-compromise secrecy / forward secrecy.** Long-term X25519 keys
  decrypt every stanza ever addressed to them: compromise a member's key and
  every copy they could read - past and future until removal - opens. Session
  ratchets are messaging-protocol territory, out of scope for a backup store.

## Cryptographic summary

- **Cipher:** AES-256-GCM (WebCrypto), 96-bit IV drawn fresh per encryption.
- **KDF:** Argon2id (hash-wasm, pinned), 16-byte random salt, 32-byte key,
  default 46 MiB / 3 passes / 1 lane; parameters stored per file (per SLOT in
  envelope mode, each slot with its own fresh salt), bounded on read. The derivation runs in a dedicated same-origin Web Worker when the
  platform provides one (the password crosses postMessage inside the same
  origin - the same trust domain as the page, see the XSS non-goal - and the
  worker is terminated when idle); where Workers are unavailable or blocked it
  falls back to the calling thread with byte-identical output.
- **Authentication:** GCM tag over the ciphertext; `kdf`/`iv` are the effective
  decrypt inputs, so tampering with them fails authentication.
- **Password envelope (format 3):** the only password-encrypted shape. A
  fresh random 32-byte data key seals the inner ZIP; the header carries the
  data key AES-256-GCM-wrapped once per password (1-8 slots, per-slot
  Argon2id). Slot edits never touch the data; a password CHANGE rotates the
  data key.
- **Group mode:** Ed25519 signatures (author, manifest) with domain
  separation; X25519 + HKDF-SHA256 per-recipient envelopes over a fresh
  random data key per publication; all via WebCrypto (Ed25519/X25519 need an
  evergreen browser or Node 20+; feature-detected, no polyfill by design).
- **Archive:** ZIP via fflate; compress-then-encrypt (ciphertext does not
  compress); per-entry and aggregate inflation guards.
- **Cache at rest:** the local IndexedDB collections snapshot and file blobs are
  sealed with AES-256-GCM (fresh 96-bit IV per record) under a non-extractable
  per-device key generated by WebCrypto and kept in the same database, so it is
  wiped together with the data it protects. The kv bookkeeping stays in the
  clear. Defense-in-depth against forensics and partial exfiltration, not
  against a full-profile copy or the origin (see T13).
