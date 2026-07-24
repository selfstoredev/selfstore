# selfstore

[![ci](https://github.com/selfstoredev/selfstore/actions/workflows/ci.yml/badge.svg)](https://github.com/selfstoredev/selfstore/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/selfstore)](https://www.npmjs.com/package/selfstore)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Local-first storage for browser apps, batteries included.** Your data lives
on the user's device, syncs across their devices without a server, and leaves
as a portable encrypted backup they actually own.

```ts
import { selfstore } from 'selfstore';

const store = await selfstore('todo-app');

await store.put('todos', { id: 't1', text: 'ship it' });
store.all('todos');            // [{ id: 't1', text: 'ship it' }]
store.onChange(render);        // local writes AND merges from other devices
```

That is a working app: saving to IndexedDB, debounced auto-save on every
mutation, and the browser sync moments (tab focus, network return, tab hide,
a slow interval) are already wired. No schema ceremony, no server, nothing to
host.

Docs, guides, a live demo and honest comparisons with the alternatives:
**[selfstore.dev](https://selfstore.dev)**.

## Going further is one call each

```ts
// Multi-device sync: connect a destination the USER owns.
await store.connectDrive(gisDriveAuth({ clientId }));  // Google Drive
await store.connectFile();                             // a file on disk (Chromium)
await store.connectWebdav({ url, username, password: appPassword }); // Nextcloud & friends

// End-to-end encryption of everything that leaves the device.
await store.protect('a passphrase the user chose');

// A portable encrypted .zip the user can walk away with.
await store.downloadBackup();
```

`connectDrive` / `connectFile` / `connectWebdav` all resolve to what actually
happened: `'merged'` (the destination already held data; both sides were
folded together, nothing lost), `'started'` (it was empty; this device's data
now lives there), `'cancelled'` (the user closed the picker), or `'manual'`
(no File System Access; offer `downloadBackup()` instead). If the destination
holds an encrypted backup and no password was given, the call throws
`PASSWORD_REQUIRED` BEFORE touching anything, so you can prompt and retry.

## The one rule

Records need a non-empty **string `id`**: it is what the multi-device merge
keys on. `put()` enforces it immediately with a clear error instead of letting
the record silently never sync. A different field name is one option away:

```ts
const store = await selfstore('crm', { sync: { ids: { contacts: 'uuid' } } });
```

Everything else about your records is your business: plain JSON in, plain JSON
out, no proxies, no injected fields, no ORM to fight.

## Status and errors are headless

The store never ships UI copy. It exposes a status descriptor
(`store.status`: `severity`, optional `action`, a stable `labelKey` like
`status.synced`) and typed errors (`store.error`: `{ code, labelKey }`, keys
like `error.authExpired`). You map the keys to your own wording and language;
the raw English `message` is for logs only.

```ts
store.subscribe(() => statusBar.textContent = t(store.status.labelKey));
```

Transient trouble (offline, a cold-started backend, a 5xx) never raises a
scary reconnect dialog: the edit stays safe in the local cache and the next
save or sync retries. Only a GENUINE loss of access (token revoked, permission
withdrawn) surfaces as `AUTH_EXPIRED` with a `reconnect` action.

| Code | Meaning |
|---|---|
| `BAD_FORMAT` | Not a backup file, or corrupt framing. |
| `UNSUPPORTED_VERSION` | Written by a newer format generation, cipher or KDF. |
| `PASSWORD_REQUIRED` | Encrypted backup opened without a password. |
| `DECRYPT_FAILED` | Wrong password, or tampered/corrupt ciphertext. |
| `TOO_LARGE` | An archive entry exceeds the zip-bomb guard (512 MiB). |
| `AUTH_EXPIRED` | Access to the destination genuinely lost; a user gesture reconnects. |
| `TARGET_UNAVAILABLE` | Transient: offline, cold start, 5xx. Retried automatically. |
| `TARGET_WRITE_FAILED` | The destination refused or failed the write (non-auth). |
| `NOT_CONNECTED` | The target has no connected destination. |
| `ENCRYPTION_REQUIRED` | `requireEncryption` is set: a plaintext attach, backup or export is refused. |
| `WEAK_PASSWORD` | The password fails the store's `passwordPolicy`. |
| `UNEXPECTEDLY_UNENCRYPTED` | Downgrade guard: expected encrypted, found plaintext. |
| `SCHEMA_TOO_NEW` | Data written by a newer app schema; update the app to sync. |

Branch on `err.code`, never parse messages. New codes may be ADDED in a minor
release, so keep a `default` branch in exhaustive switches.

## Backup files, on their own

The backup is a real ZIP, specified independently of this library
([SPEC.md](./SPEC.md), with a ~120-line Python reference reader and canonical
test vectors): unencrypted it opens in any archive tool; encrypted it is still
a valid ZIP holding the AES-256-GCM ciphertext, the cleartext parameters and a
readme - never a mystery blob. Working with backup FILES needs no store:

```ts
import { backup, restore, changePassword } from 'selfstore';

// Write: fluent and STAGED - an illegal order does not compile.
const blob = await backup({ collections: { notes }, files: [] })
  .as('my-app', '1.2.0')
  .encryptedWith(password)  // omit for a plain, browsable ZIP
  .withReadme('Import this file into MyApp with your password.')
  .toBlob();                // or .toBytes(), or .toDisk('my-backup.zip')

// Read
const meta = await restore(file).meta();          // cleartext, no password needed
if (await restore(file).isEncrypted()) { /* ask the user */ }
const snap = await restore(file).withPassword(password).read();

// Rotate, add or remove the password
const rekeyed = await changePassword(blob, { from: 'old', to: 'new' });
```

## When you need more: the deeper layers

The package root stays small on purpose. The machinery underneath is public
too, as subpaths of the same install:

| Import | What it is | Reach for it when |
|---|---|---|
| `selfstore` | the simple store + backup files | almost always: start here |
| `selfstore/flows` | the user journeys (connect a destination, share panel, join an invitation) as headless, tested state machines | you are building the connect/share/join UI and want the ordering and failure rules - one popup per gesture, password proven before attach, merge by default - already right |
| `selfstore/widgets` | the same journeys as drop-in web components (`<selfstore-connect>`, `<selfstore-share>`, `<selfstore-join>`) - framework-free, themable via CSS custom properties and `::part()`, reworded/localized via a `labels` map | you want the screens ready-made and your app's look on top |
| `selfstore/advanced` | the pull-model store (`createLocalStore`), custom `BackupTarget`s, caches, headless status derivation, functional codec | your state lives in its own reactive model (Svelte runes, Redux), or you are writing a destination (S3, your KV...) |
| `selfstore/groups` | passwordless group encryption: per-member identities, sealed envelopes, signed membership manifests | several PEOPLE share one encrypted store without a shared password ([PEERS.md](./PEERS.md)) |
| `selfstore/sync` | the bare merge engine (HLC + per-collection strategies, no CRDT runtime) | you only want the algorithm inside your own persistence ([SYNC docs in SPEC.md](./SPEC.md)) |

`store.advanced` on the simple store IS the `selfstore/advanced` store - same
instance - so the two styles compose instead of competing: start simple, reach
down for one advanced call (`attachPeer`, `setGroup`, a custom target), keep
the rest.

```ts
import { createLocalStore, indexedDbCache } from 'selfstore/advanced';

const store = createLocalStore({
  app: 'my-app',
  schemaVersion: 1,
  gather: () => state.toSnapshot(),   // YOUR app owns the data
  apply: (snap) => state.load(snap),
  cache: indexedDbCache('my-app')
});
await store.init();
onEveryChange(store.schedule);
```

## Local-first, demonstrably

selfstore exists so an app can *prove* its local-first claims instead of
asserting them:

- **No server anywhere in the loop.** Save, backup, restore and merge all run
  in the browser. There is nothing to host and nothing that sees the data.
- **The user owns a real file.** See "Backup files" above: a genuine,
  documented ZIP, readable by anything that follows the spec.
- **Encrypted the moment it leaves the device.** Cleartext at rest locally (so
  you keep queries and DevTools), end-to-end encrypted as soon as it goes to a
  file or the cloud: AES-256-GCM over an Argon2id-derived key, parameters
  stored per file so old backups keep decrypting when defaults improve.
- **Offline is the normal case, not a fallback.** The working copy is
  IndexedDB; durable homes and merges catch up whenever the device is back
  online.
- **Leaving is easy.** The format is stable across generations; a file written
  years ago by another app still reads.

## Multi-device merge, no CRDT runtime

A Hybrid Logical Clock plus pluggable per-collection strategies converge two
replicas deterministically, while your objects stay plain JSON. The default -
records keyed by `id`, later edit per record wins, deletes propagate as
tombstones - fits most apps; `sync: { strategies }` tunes it per collection:

| Strategy | Semantics |
|---|---|
| `lww-set` | records keyed by id; later write per id wins; deletes tombstoned |
| `lww-map` | field-by-field merge: concurrent edits to different fields both survive; same field goes to the later clock; deletes stay record-level |
| `grow-set` | append-only, entries immutable per id; union, never a conflict |
| `lww-register` | a single value; later write wins |
| `manual` | surface concurrent same-id edits (via `MergeResult.conflicts`) instead of resolving |

**Guarantees (seeded-fuzz tested):** every two-way merge is symmetric and
idempotent; `lww-set` and `grow-set` (used within their contracts) are also
order-independent across replicas. **Honest limits:** LWW resolves a
concurrent same-record (or same-field) edit by KEEPING THE LATER CLOCK - the
losing value is surfaced in the sync journal's conflicts, not merged. In
`lww-map`, a record deleted on one replica while another edits one of its
fields resurrects with the surviving side's fields only. Change detection
hashes content with 32-bit FNV-1a: a collision (~2^-32 per edit) would miss an
edit. If concurrent-edit losslessness is your requirement, embed a real CRDT
document (Yjs/Automerge) as a binary file in the snapshot.

## Sharing between people: peers

Share a store between several people WITHOUT anyone granting write access:
each member publishes their own copy on their own storage, shares it
read-only, and attaches the other members' links as peers
(`store.advanced.attachPeer(source)`). Every converge folds each peer's copy
in as one more replica and publishes the merged state back: one writer per
file (no write races), copies converge to the union (every member is a full
backup of the group), gossip is transitive (a star around one member is
enough). Peer problems are recorded per peer on `state.peers` and never gate
your own saves.

Group crypto, two options: ONE shared passphrase (exchanged once out of band),
or **passwordless groups** (`selfstore/groups`): a keypair per member, every
copy Ed25519-signed by its author and sealed per recipient (X25519 envelopes),
membership governed by an admin-signed manifest with rollback protection. The
full model, the failure table and the operational notes live in
[PEERS.md](./PEERS.md); the trust analysis in
[THREAT-MODEL.md](./THREAT-MODEL.md).

## Destinations

Built in: **disk file** (File System Access, truly zero backend, Chromium),
**Google Drive** (bring a `DriveAuth`; `gisDriveAuth` is the client-only
reference - occasional re-consent; a tiny refresh-token broker buys "connected
for good"; the cloud only ever sees opaque encrypted bytes), **WebDAV**
(Nextcloud and friends; credentials sealed at rest under a non-extractable
device key), and **S3-compatible buckets** (Amazon S3, Cloudflare R2, Backblaze
B2, MinIO): the browser signs each request with SigV4 itself, no vendor SDK, the
secret sealed at rest like the WebDAV credentials.

Yours: implement `BackupTarget { kind / save / load / isReady / reconnect /
disconnect }` from `selfstore/advanced` with any `kind` string (say `'ipfs'`)
and hand it to `store.connectTarget(...)`. Signal a genuine loss of access by
throwing `AuthExpiredError`; anything else you throw is treated as transient
and retried. `examples/custom-target.ts` is a complete one in ~30 lines.

> Honest scope: a disk file needs **no backend**; Drive client-only needs no
> backend but re-consents roughly hourly (third-party cookies); a permanent
> Drive connection needs a small refresh-token broker. WebDAV and S3 need only
> a CORS rule on the server/bucket for your app origin.

For resilience, `store.addReplica(target)` keeps a SECOND destination in sync
with the same backup - Drive as the primary, an S3 bucket as the synced copy -
so losing one home never loses the data. For locked-down deployments,
`createLocalStore({ requireEncryption, passwordPolicy })` refuses a plaintext
backup and a weak password at the engine (not just the UI); offering only
`webdav` / `s3` in the connect widget, and not mounting the share/join widgets,
keeps an app on the user's own storage with no sharing surface at all.

## Framework bindings

`store.subscribe(fn)` plus reading state is the whole contract, and the state
snapshot is referentially stable between changes - so every framework binds in
a few lines and there is deliberately NO adapter package to install:

```ts
// React. The THIRD argument matters: without it useSyncExternalStore throws
// during SSR (Next, Remix...).
import { useSyncExternalStore } from 'react';
const s = useSyncExternalStore(store.subscribe, () => store.state, () => store.state);

// Svelte (3, 4 and 5). The store contract is structural - this object IS a
// readable, no svelte import needed; use it as $persistence in components.
const persistence = {
  subscribe(run: (s: typeof store.state) => void) {
    run(store.state);
    return store.subscribe(() => run(store.state));
  }
};

// Vue, Solid, anything else: subscribe on mount, read store.state, call the
// returned unsubscriber on unmount.
```

## Security model

- Confidentiality and integrity come from AES-256-GCM: a wrong password, a
  flipped ciphertext byte or altered KDF/IV parameters all fail decryption.
  There is no partially-valid read.
- The KDF is Argon2id (memory-hard), 46 MiB / 3 passes by default, parameters
  stored per file. It runs in a Web Worker (shipped as
  `selfstore/kdf-worker`), falling back to the main thread with byte-identical
  results wherever workers cannot load.
- The cosmetic header fields (`app`, `appVersion`, `createdAt`) are cleartext
  and NOT authenticated; never base a security decision on them.
- Passwords are JavaScript strings: the platform gives no way to zeroize them.
  Derived keys are non-extractable WebCrypto keys.
- Decompression is guarded: any archive entry declaring more than 512 MiB is
  refused before inflation (`TOO_LARGE`), and a backup declaring absurd
  Argon2id parameters is rejected before the KDF runs.
- WebDAV Basic-auth credentials are refused over plain http (loopback aside);
  S3 requests are refused over plain http as well (loopback aside).
- The local IndexedDB cache is sealed at rest: the collections snapshot and file
  blobs are AES-256-GCM-encrypted under a non-extractable per-device key (only
  the small sync bookkeeping stays in the clear). Defense-in-depth against
  disk forensics and partial exfiltration, not against a full-profile copy or
  code in the origin - see T13 in the threat model.
- Ultra-sensitive `cacheLock`: seal that cache under a key held in memory only
  (a password, or an app key such as a passkey PRF), never on disk, so even a
  full-profile copy cannot read it. One unlock per session - `cacheLock` on the
  simple facade, or `indexedDbCache(name, { lock: true })` at the store layer.
  Still bounded by the origin (unlocked, code in the page decrypts).
- Opt-in hardening for sensitive deployments: `requireEncryption` refuses to
  write or export a plaintext backup, and `passwordPolicy` refuses a password
  weaker than a length / character-class rule - both enforced at the store, so
  the app cannot forget to check.
- The full analysis - assets, trust boundaries, threats and explicit non-goals
  (XSS, rollback replay, metadata) - is in [THREAT-MODEL.md](./THREAT-MODEL.md).

## When not to use selfstore

Honest limits: everything fits in memory (backups measured in MB, not GB;
there is no streaming path and no delta sync - every converge ships the whole
state); the merge targets one person's devices and small groups, not real-time
collaboration (use a CRDT library for that); there is no undo or history - an
LWW overwrite is final locally, so keep dated backup copies if you want time
travel (`backup(...).toDisk()` makes that a one-liner); and it is a browser
library (Node >= 20 works for tests, but the client is the point).

Other current limits, documented with open eyes: multi-tab coordination is
data-only (connections and mode switches apply to other tabs on reload;
`multiTab: false` opts out); deletion tombstones grow unless you opt in to
compaction (`tombstoneHorizonMs` on the advanced store - safe only if the
horizon exceeds the longest a device stays offline); binary files merge by id
union (no clocks: use content-addressed ids and tie file lifetime to a
record). In Vite DEV, if the KDF worker 404s under dependency pre-bundling,
add `optimizeDeps: { exclude: ['selfstore'] }`.

## Testing your integration

The simple store already runs in plain Node/vitest with no browser and no
mocks: without IndexedDB it lands on an in-memory cache, and
`await selfstore('app', { cache: memoryCache() })` (cache from
`selfstore/advanced`) makes the sharing explicit - two stores over one
`memoryCache()` simulate a reopen; a ~15-line in-memory `BackupTarget` (a Blob
variable) exercises the full save/sync/restore loop. That is exactly how
selfstore tests itself.

## For AI agents

`llms.txt` at the package root summarizes the API with canonical snippets, and
[RECIPES.md](./RECIPES.md) has copy-paste tasks (the `examples/` folder holds
the same mini-apps, typechecked). Rules of thumb: every record needs a
**string `id`** (the simple store enforces it; the advanced one only logs);
always branch on `err.code`, never parse error messages; treat
`DECRYPT_FAILED` as "wrong password or corrupted file" (indistinguishable by
design); an empty password means "not encrypted"; collection names starting
with `__` are reserved.

## Install

```sh
npm install selfstore
```

ESM only, TypeScript types included, browser-first. `fflate` and `hash-wasm`
are loaded lazily via dynamic import, so they stay out of your critical bundle
until the first compress/encrypt.

## License

MIT (c) Florian Mousseau
