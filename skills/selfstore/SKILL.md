---
name: selfstore
description: Give a browser app saving, backup, restore and multi-device sync with no server and no account, using the selfstore library - an IndexedDB working copy plus a portable encrypted ZIP the user owns, on a disk file, Google Drive, WebDAV or S3. Use when the task is local-first or offline storage in a web app, persisting data without a backend, letting users own or export their data as a file, syncing one person's devices, sharing over read-only links, or writing and debugging selfstore code.
---

# Storing a browser app's data with selfstore

One npm package, nine imports. The store OWNS the data: named JSON collections
plus binary files, never interpreted. ESM, TypeScript, browser-first, MIT.

```sh
npm install selfstore
```

## Decide first whether this is the right tool

Reach for it when a web app wants save, backup, restore or sync WITHOUT a
server or an account, when users must own their data as a portable file, for
multi-device convergence for one person, or for async sharing between a few
people over read-only links.

Do NOT reach for it for multi-GB data (everything is in memory), realtime
collaborative editing (use a CRDT library - though CRDT updates can ride along,
see below), or server-side storage. Say so rather than bending it.

## The default path, and it is short

```ts
import { selfstore } from 'selfstore';

const store = await selfstore<{ todos: Todo }>('todo-app'); // ready when resolved

await store.put('todos', { id: crypto.randomUUID(), text: 'ship it' });
store.all('todos'); // readonly array
store.onChange(render); // local writes AND merges from other devices
```

That is the whole first step. IndexedDB cache, debounced auto-save, save on tab
hide and converge on focus are wired already. In a test or under SSR, with no
IndexedDB, it falls back to an in-memory cache, so the same code runs under
vitest with zero mocks.

Reach for `createLocalStore` from `selfstore/advanced` only when the app must
keep owning its own state and hand snapshots over. Writing it first is the most
common wrong turn.

## The five things a first integration gets wrong

**1. A record needs a STRING `id`.** The merge keys on it. `put()` throws a
TypeError naming the fix; the advanced store only warns, and the record then
silently never replicates. Remap the field per collection with
`selfstore('app', { sync: { ids: { events: 'ref' } } })`.

**2. `<selfstore-storage>` is a full-viewport modal until a home is chosen.**
Correct when the app's data means nothing until the user says where it lives.
Wrong on a page that must work before any answer - a demo, a landing page, a
scratchpad. There, mount `<selfstore-destination>` or `<selfstore-status>` and
put the connect journey behind a control the user reaches deliberately.

**3. Reach for the widget before writing the screen.** `selfstore/widgets`
ships the whole journey as framework-free custom elements, themed with
`--selfstore-*` properties and `::part()`, reworded through the `labels`
property. If one is close but not right, fix the widget rather than rebuild it
by hand - a hand-rolled connect screen misses the cases the flow already
handles.

**4. Branch on `err.code`, never on a message.** Every failure is a
`SelfstoreError` with a stable code and an i18n `labelKey`. Show the key, log
the message, keep a default branch: new codes arrive in minors. The one to
handle by name is `PASSWORD_REQUIRED`, thrown BEFORE anything attaches when a
destination holds an encrypted backup - prompt, then retry with `{ password }`.

**5. Handle all four connect outcomes.** `connectDrive` / `connectFile` /
`connectWebdav` / `connectS3` resolve to `'merged'` (both sides folded, nothing
lost), `'started'` (the destination was empty), `'cancelled'` (the user closed
the picker) or `'manual'` (no File System Access in this browser - offer
`downloadBackup()`). Treating the last one as a failure breaks every non-Chromium
visitor.

## Growing, one call at a time

```ts
await store.connectDrive(gisDriveAuth({ clientId })); // or connectFile / connectWebdav / connectS3
await store.protect(passphrase); // end-to-end encryption from here on
await store.downloadBackup(); // hand the user a real .zip
await store.importBackup(file); // REPLACES local data
```

Binary files live in the same store, backup and merge. `putFile` defaults the
id to the SHA-256 of the bytes: keep that default. Files merge by union on id
with no clock, so two devices holding different bytes under one id lose one
silently, and the content hash is what puts different bytes on different ids.
File deletions do not propagate - tie a file's lifetime to a record.

`selfstore/groups` is EXPERIMENTAL and sits outside the semver promise. Warn
before recommending it.

## Where the rest is

The full API reference ships inside the package, so it is on disk at the exact
version installed:

```sh
cat node_modules/selfstore/llms.txt
```

Online, every documentation page is served as markdown at the same path with
`.md`:

- <https://selfstore.dev/llms.txt> - the map, one line per page
- <https://selfstore.dev/docs/quick-start.md> - this page, in full
- <https://selfstore.dev/docs/widgets.md> - the drop-in components
- <https://selfstore.dev/docs/errors.md> - every code and its label key
- <https://selfstore.dev/docs/sync.md> - what converges, and what cannot
- <https://selfstore.dev/llms-full.txt> - all of it in one file
