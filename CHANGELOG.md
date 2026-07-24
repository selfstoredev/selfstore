# Changelog

All notable changes to selfstore are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
adheres to [Semantic Versioning](https://semver.org/).

## [1.2.0] - 2026-07-24

### Fixed

- A household join whose announce was lost (a network blip, a relay cold
  start at the exact join moment) no longer strands the joiner silently -
  member on their side, visible to nobody, edits publishing into a copy
  no one folds. The join now retries the announce, then persists an
  `announcePending` flag so EVERY converge keeps announcing (readable
  bulletin or not) until a fresh roster carries the copy.

### Added

- `MembershipInfo.announcePending`: the copy is not in a fresh roster yet;
  the host can show "waiting for the admin to see you" instead of a false
  everything-is-fine.
- `MembershipInfo.stale` + rotated-link detection: when the bulletin is
  fetched but no longer decrypts (the admin re-shared under a fresh key),
  two consecutive reads mark the membership stale so the host can say
  "this share was renewed, ask for a fresh invitation" instead of letting
  the member edit into the void. `ShareBackend.rereadJoined` may now
  resolve the literal `'unreadable'` to feed that verdict; backends that
  keep returning null simply never trigger it.

## [1.1.0] - 2026-07-24

### Added

- `BackupTarget.abortInFlight()` (optional): cut the target's in-flight
  network requests immediately. The built-in Drive, WebDAV and S3 targets
  implement it; `detachTarget()` calls it, so a user's "disconnect" lands
  at once instead of queueing behind a suspended request until its 15-30s
  network deadline - previously the disconnect looked dead on a phone
  whose radio woke up stuck, and only closing the tab recovered.
- `DriveAuth.token()` now also receives `{ signal }`: an app-side token
  broker running its own retry loop can pass it to its fetches and stop
  retrying the moment the target's work is cut. Implementations that
  ignore the option keep working exactly as before.

## [1.0.1] - 2026-07-24

### Fixed

- Boot can no longer hang behind a stalled network wait. A radio waking
  from sleep can suspend a request without ever erroring; every network
  wait of init() (session restore, destination check, boot pull) is now
  bounded to 25 seconds. On a stall the store comes up on the cached
  copy, stays connected, and the next save or sync retries - a stall is
  never treated as an authentication loss.

## [1.0.0] - 2026-07-23

First stable release. One install, three layers:

- **The simple store**: `selfstore(app)` - put/all/remove over named JSON
  collections and binary files, auto-saved to an IndexedDB working copy that
  is sealed at rest under a per-device key. Offline is the normal case.
- **Durable homes**: a disk file, Google Drive, WebDAV or any S3-compatible
  bucket, attached in one call. Everything leaves the device as an
  AES-256-GCM encrypted ZIP (Argon2id-derived keys, 1-8 password or
  external-key slots, tamper-evident header) in an independently specified
  format with committed test vectors and a Python reference reader.
- **Serverless sync and sharing**: deterministic HLC merge between one
  person's devices through the same backup file; read-only peers, mirrors
  and passwordless groups (per-member keys, signed manifests) between
  people. Conflicts are journaled, never silent.

Hardening built in: `requireEncryption`, password policies, `cacheLock`
(memory-only cache key for the most sensitive apps), an optional backup
copy (the same encrypted file also written to a second destination, never
gating the store), typed errors with stable i18n label keys, and a headless
status descriptor plus optional web-component widgets over the
connect/share/join/backups flows.

The public API is frozen under semantic versioning: the eight subpath
entries (`.`, `/advanced`, `/backups`, `/flows`, `/groups`, `/households`,
`/sync`, `/widgets`) and their exported types are the supported surface.
Container formats are numbered 1 (plain), 2 (group) and 3 (password
envelope); a reader rejects anything else. Breaking changes wait for a
2.0.0.
