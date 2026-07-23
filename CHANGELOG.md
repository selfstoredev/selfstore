# Changelog

All notable changes to selfstore are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
adheres to [Semantic Versioning](https://semver.org/).

## [1.0.0] - 2026-07-23

First stable release. The public API is now frozen under semantic versioning:
the eight subpath entries (`.`, `/advanced`, `/backups`, `/flows`, `/groups`,
`/households`, `/sync`, `/widgets`) and their exported types are the supported
surface, and breaking changes wait for a 2.0.0. No API change from 0.29.0 - the
version marks the stability commitment, plus one widget polish.

- widget: the attached backup copy renders as a line INSIDE the active backup's
  card, under its pills (label, freshness, an inline "remove"), instead of a
  separate row below the card - it reads as part of that backup, not a sibling.

## [0.29.0] - 2026-07-23

Backups widget polish: no duplicate shared rows, the attached copy as one
line, an active shared badge that looks active, and clearer WebDAV help.

- widget: the "shared with me" section never shows an owner twice. A
  registry file whose owner already has a membership (a re-join left the
  old file behind) no longer adds a second, Forget-only row - the
  membership row (with Leave) stands alone; plain Forget rows also
  collapse to one per owner.
- widget: the active shared backup's badge row now carries the same green
  active border as every other attached backup.
- widget: the backup copy renders as ONE compact line hanging off the
  active backup's card (label, freshness, an inline "remove"), never a
  second bordered block.
- widget: the WebDAV backup-copy form spells out that the URL is the full
  file URL (a custom port goes in it) and that the server must allow the
  app to reach it (CORS) - some hosted drives never will from a browser.

## [0.28.0] - 2026-07-23

Several memberships per device, one per joined silo.

- households: the engine stores a LIST of memberships (a lone pre-multi
  record lifts into it on first load). With a `wallet` getter, joining
  another share ADDS a membership bound to the attached silo - the
  'mismatch' dead end is gone (single-wallet hosts keep the historical
  one-membership rule); a re-join over the same silo replaces its stale
  one; `leave(walletFileId?)` names which membership goes. Every
  membership arms its own mirror and rereads its OWN bulletin
  (`rereadJoined(fileId, key)` takes the invitation capability). State
  exposes `memberships`.
- widget: the `member` input accepts a list - the attached silo wears the
  badge, every joined row's one action is leaving, and the leave event's
  detail names the wallet file.

## [0.27.0] - 2026-07-22

Wallet-scoped sharing: a joined portfolio is its own dedicated wallet,
fully isolated from the member's own backups.

- households: a share binds to the wallet file it was started or joined
  on (`wallet` getter on `createHouseholdGroup`, `walletFileId` in state)
  and lies dormant while another silo is attached - the mirror never
  publishes another silo's data into the copy, the peers never fold the
  shared data into another silo. Call `syncGroup()` after every silo
  switch so the guard applies immediately.
- backups: `registerShared` records a file under the sharer's label;
  `createShared` creates the joined wallet blank, named outside the own
  convention, filed under the shared registry, never under "mine".
- widget: the `member` input can name the membership's wallet file - the
  badge row renders only while that silo is attached, its registry row
  opens like any shared silo otherwise, and the one menu action is
  leaving (new `backups.shared.leave` label), never a mere forget.

## [0.26.0] - 2026-07-22

One install, three layers:

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

Breaking: container formats are numbered 1 (plain), 2 (group) and 3
(password envelope); a reader rejects anything else. All pre-0.26 legacy
format and migration support is dropped, so files written by earlier
versions no longer open.
