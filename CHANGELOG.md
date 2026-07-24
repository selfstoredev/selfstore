# Changelog

All notable changes to selfstore are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
adheres to [Semantic Versioning](https://semver.org/).

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
