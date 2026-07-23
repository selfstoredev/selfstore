# Recipes

Copy-paste solutions to the things people actually do with selfstore, ordered
the way an app grows: start with the simple store (recipes 1-6), drop to the
backup-file layer when you only need files (7), and reach for
`selfstore/advanced` / `selfstore/groups` when your architecture asks for it
(8-12). Everything is ESM + TypeScript.

## 1. Start an app (five lines, no config)

```ts
import { selfstore } from 'selfstore';

const store = await selfstore<{ todos: Todo }>('todo-app');

await store.put('todos', { id: crypto.randomUUID(), text: 'ship it' });
store.all('todos');                       // read (typed, readonly)
store.onChange(() => render(store.all('todos'))); // local writes AND other devices
```

Auto-save to IndexedDB (debounced), save on tab hide, sync on focus and on
network return: already wired. In tests and SSR (no IndexedDB) the same call
lands on an in-memory cache, so this exact code runs under vitest.

## 2. Sync across the user's devices

Connect a destination the USER owns - the same call on every device:

```ts
import { gisDriveAuth } from 'selfstore';

const outcome = await store.connectDrive(gisDriveAuth({ clientId })); // Google Drive
// or: await store.connectFile();                          // a disk file (Chromium)
// or: await store.connectWebdav({ url, username, password }); // Nextcloud & friends

switch (outcome) {
  case 'started':   break; // destination was empty: this device now lives there
  case 'merged':    break; // it held a backup: both sides folded, nothing lost
  case 'manual':    break; // no File System Access: offer store.downloadBackup()
  case 'cancelled': break; // the user closed the picker / consent
}
```

If the destination holds an ENCRYPTED backup and you passed no password, the
call throws `PASSWORD_REQUIRED` before touching anything: prompt, then retry
with `connectDrive(auth, { password })`.

## 3. Encrypt end to end, and hand the user a real backup

```ts
await store.protect('a passphrase the user chose'); // AES-256-GCM over Argon2id
// From here every byte leaving the device is ciphertext. Reversible:
await store.unprotect();

await store.downloadBackup();          // a portable .zip (encrypted while protected)
const blob = await store.exportBackup(); // the same file, yours to route
```

### 3b. Several passwords on one backup (key slots)

One encrypted file, more than one secret that opens it - a spouse's password,
a printed recovery code, a share key. Slots wrap the same random data key, so
adding or removing one never re-encrypts the data:

```ts
const adv = store.advanced; // or your createLocalStore instance directly

const id = await adv.addEncryptionKey('the second password'); // both open it now
adv.listEncryptionKeys();                 // [{ id: '...' }, { id: '...' }]
await adv.removeEncryptionKey(id);        // that password stops opening REWRITES

// Removing a slot is NOT revocation (whoever held the password may hold the
// file). To actually revoke, CHANGE the password - a data-key rotation:
await adv.setEncryption('a fresh password'); // every old secret stops opening
```

The store write-verifies every slot change (the new table must open before the
file lands), refuses removing the slot your own session unlocks with, and caps
the table at 8 slots.

## 4. Import a backup file the user picks

```ts
import { restore } from 'selfstore';

const file = await pickFile(); // an <input type=file> File/Blob

// Peek before importing - cleartext header, no password, no decrypt:
const meta = await restore(file).meta();
if (meta.app !== 'todo-app') warn(`This backup is from "${meta.app}".`);

// Replace this store's data with the file (removals propagate like edits):
await store.importBackup(file, {
  password: (await restore(file).isEncrypted()) ? await promptPassword() : undefined
});
```

## 5. The string-id rule (and remapping it)

Every record needs a non-empty **string id**: it is what the multi-device
merge keys on. The simple store enforces it at `put()` with a clear error
instead of letting a record silently never sync.

```ts
await store.put('todos', { id: crypto.randomUUID(), text: 'good' });

// Your records key on another field? One option:
const crm = await selfstore('crm', { sync: { ids: { contacts: 'uuid' } } });

// Per-collection merge behaviour rides the same option:
const app = await selfstore('my-app', {
  sync: { strategies: { accounts: 'lww-map' }, fallback: 'lww-set' }
});
// lww-set: later write per id wins. lww-map: concurrent edits to DIFFERENT
// fields both survive. grow-set: append-only union. manual: surface conflicts.
```

## 6. Render the status, handle the two gate gestures

The store is headless: it ships stable KEYS, you ship the copy.

```ts
store.subscribe(() => {
  statusBar.textContent = t(store.status.labelKey);   // e.g. 'status.synced'
  if (store.error) toast(t(store.error.labelKey));    // e.g. 'error.authExpired'
});

// Only two situations ever need a user gesture:
if (store.status.action === 'unlock')    await store.unlock(await promptPassword());
if (store.status.action === 'reconnect') await store.reconnect();
```

Transient trouble (offline, cold start, 5xx) never raises `reconnect`: edits
stay safe locally and the next save or sync retries on its own.

Framework bindings are a few lines each (`store.subscribe` + a stable
`store.state`); see "Framework bindings" in the README for React and Svelte.

## 7. Backup files WITHOUT a store (the fluent layer)

```ts
import { backup, restore, changePassword } from 'selfstore';

// Write: staged fluent - an illegal order does not compile.
await backup({ collections: { notes }, files: [] })
  .as('my-app', '1.4.0')
  .encryptedWith(password)      // omit for a plain, browsable ZIP
  .toDisk('my-app-backup.zip'); // or .toBlob() / .toBytes()

// Read
const snap = await restore(file).withPassword(password).read();

// Add, rotate or remove the password of an existing file
const rekeyed = await changePassword(blob, { from: 'old', to: 'new' });
```

## 8. The pull-model store (your app owns the data)

When your state lives in its own reactive model (Svelte runes, Redux,
signals), invert the ownership with `selfstore/advanced`:

```ts
import { createLocalStore, indexedDbCache } from 'selfstore/advanced';

const store = createLocalStore({
  app: 'my-app',
  schemaVersion: 1,
  gather: () => myApp.toSnapshot(),      // your state -> snapshot
  apply: (snap) => myApp.load(snap),     // snapshot -> your state
  cache: indexedDbCache('my-app'),
});
await store.init();                      // hydrate from cache
myApp.onEveryChange(() => store.schedule());   // debounced auto-save
window.addEventListener('pagehide', () => store.flush());
```

`store.advanced` on a simple store is this same LocalStore, so you can also
stay simple and reach down for single calls.

## 9. Destinations on the advanced store (and silent reboot)

```ts
import { driveTarget, fileTarget, webdavTarget, gisDriveAuth } from 'selfstore/advanced';

const auth = gisDriveAuth({ clientId: GOOGLE_CLIENT_ID });
const drive = () => driveTarget.connect({ auth, kv: cache.kv, fileName: 'my-app.zip' });

const store = createLocalStore({
  app: 'my-app', schemaVersion: 1, gather, apply, cache,
  restoreTarget: async (kind) => (kind === 'drive' ? drive() : null), // silent reboot
});
await store.init();

// On a user click (opens Google consent the first time):
await store.attachTarget(await drive(), { strategy: 'merge', password });

// Disk file (Chromium) and WebDAV work alike:
const f = await fileTarget.connect({ kv: cache.kv, fileName: 'my-app.zip' });
const w = await webdavTarget.connect({ kv: cache.kv, config: { url, username, password } });
```

## 10. Write your own destination (S3, your KV, anything)

```ts
import { AuthExpiredError, type BackupTarget } from 'selfstore/advanced';

const bucket: BackupTarget = {
  kind: 's3',                       // any string except 'device' / 'file-manual'
  label: 'my bucket',
  async save(blob) { await putObject(KEY, blob); return null; },
  async load() { return (await getObject(KEY)) ?? null; },
  async isReady() { return true; }, // false = transient (retried);
  async reconnect() { return true; }, // THROW AuthExpiredError = genuine loss
  async disconnect() {}             // forget locally; never delete remote data
};
await store.connectTarget(bucket);  // simple store
// or: await advancedStore.attachTarget(bucket, { strategy: 'merge' });
```

Complete typechecked version: `examples/custom-target.ts`.

## 11. Share a store between people with read-only links (peers)

Nobody grants write access to anything: each member publishes their own copy
and shares it READ-ONLY; everyone attaches the others' links as peers. Every
converge folds the peers in and republishes the merged state, so members
gossip through each other (a star around one member is enough).

```ts
import { webdavTarget } from 'selfstore/advanced';

// Alice's app. Her own target is where SHE publishes; Bob's copy is a peer.
const bob = webdavTarget.peer({ url: BOB_SHARE_URL, label: 'Bob' });
// Any target is also a PeerSource, and a bare public link is three lines:
//   const bob = { label: 'Bob', load: () => fetch(url).then(r => r.ok ? r.blob() : null) };

await store.attachTarget(myTarget, { password: groupPassphrase }); // my copy
store.attachPeer(bob, { id: 'bob' }); // his copy, read-only

// Phase-1 crypto: ONE group passphrase opens every member's copy (exchange it
// once over the channel that carries the links). Peer problems never block
// your own saves; render them per peer:
for (const p of store.state.peers) {
  if (p.lastError) console.warn(`${p.label}: ${p.lastError.code}`);
}

// Re-attach peers at boot (they are not persisted), like restoreTarget:
// store.attachPeer(rebuildBobSource(), { id: 'bob' });
```

Deletions propagate (tombstones): set `tombstoneHorizonMs` well above the
longest a member stays offline, or leave it unset. The full model, failure
table and operational notes live in `PEERS.md`.

### 11b. Mirrors: share WITHOUT touching anyone's own file

The variant that keeps every member's own file exactly what its owner chose
(plaintext, or their own password): nobody re-keys their backup for the
share. Each member attaches a write-only MIRROR - a published copy of their
store, re-encoded under the share key after every save or converge that
moved data - and reads the others' mirrors as peers WITH that key:

```ts
// Alice: her own file stays plaintext on HER target. The share never touches it.
store.attachMirror(myCopyTarget, { password: shareKey }); // my published copy
store.attachPeer(bobCopySource, { id: 'bob', password: shareKey }); // his

// Each member edits only their own file; reading the other's copy is what
// resynchronizes. Mirror problems land on state.mirrors, peers on
// state.peers - neither ever gates the store or holds a save hostage.
```

A keyed peer refuses a plaintext blob in its place (per-peer substitution
guard), and the mirror's envelope is minted once, so publishing costs no
KDF pass. Like peers, mirrors are not persisted: re-attach at boot.

## 12. Passwordless group: per-member keys, no shared secret

Same topology as recipe 11, but nobody types or shares a passphrase: every
copy is SIGNED by its author and sealed for each member. Membership is a
manifest signed by one admin.

```ts
import { identityVault, signManifest, newGroupId } from 'selfstore/groups';

// 1. Each member, once per device (sealed at rest under a device key):
const identity = await identityVault(cache.kv).loadOrCreate();
// Send { sig: identity.sigPub, enc: identity.encPub } to the admin
// over the channel you already trust (the one carrying the links).

// 2. The ADMIN alone builds and signs the membership manifest:
const manifest = {
  v: 1 as const, group: newGroupId(), seq: 1, admin: identity.sigPub,
  members: [
    { id: 'me', sig: identity.sigPub, enc: identity.encPub },
    { id: 'bob', sig: bobReply.sig, enc: bobReply.enc }
  ]
};
const signedManifest = await signManifest(manifest, identity.sigPriv);
// Distribute signedManifest with the invite (any channel; it is signed).

// 3. Every member attaches with { group } - no password parameter at all.
//    The STORE verifies the signed manifest against the admin key pinned
//    from the invite (TOFU): a bad signature rejects with SIGNATURE_INVALID
//    before anything changes.
await store.attachTarget(myTarget, {
  group: { identity, admin: pinnedAdminSigKey, manifest: signedManifest }
});
store.attachPeer(bobSource, { id: 'bob' });

// state.peers[].author = the VERIFIED member behind each copy.
// Membership changes (add or remove a member): the admin signs seq+1 and
// everyone applies it - the store re-verifies against the pinned key and
// the next publish re-envelopes accordingly:
await store.setGroup(nextSigned);
```

Opt-in: lock the identity itself behind a passphrase, so a copied browser
profile (or an exfiltrated IndexedDB) cannot use it. Stateless: `unlock`
returns the identity for you to hold in memory; at rest it stays sealed.

```ts
const vault = identityVault(cache.kv);
await vault.protect(passphrase); // reseal under Argon2id(passphrase)
// later, at boot:
const identity = (await vault.isProtected())
  ? await vault.unlock(passphrase) // wrong passphrase: DECRYPT_FAILED
  : await vault.loadOrCreate(); // PASSWORD_REQUIRED if locked - never re-mints
await vault.unprotect(passphrase); // opt back out: device-key mode again
```

Forgot the passphrase? There is no recovery: `vault.clear()` forgets the
identity, then re-import it from another device or ask for a fresh invite.

Honest edges: a removed member keeps what they already fetched (removal
protects the future); the invite channel is the trust root (TOFU); needs
WebCrypto Ed25519 + X25519 (evergreen browsers, Node 20+ - check
`groupCryptoAvailable()`). Details: `PEERS.md`, format: `SPEC.md` section 12.

## 13. The connect/share/join screens without re-deriving the rules (flows)

The journeys around the store - pick a destination, run the share panel, open
an invitation - are where connection UIs accumulate their bugs: double popups,
a cancel treated as an error, a wrong password half-attaching, a flaky listing
blanking the panel. `selfstore/flows` ships them as HEADLESS state machines:
you render the snapshot and call the actions, the ordering and failure rules
are already right (and pinned by tests).

```ts
import { connectFlow } from 'selfstore/flows';
import { gisDriveAuth } from 'selfstore';

const flow = connectFlow(store, {
  drive: gisDriveAuth({ clientId }),
  file: true, // degrades to manual download where the picker API is missing
  webdav: true // renders your form step, then flow.submitWebdav(config)
});

flow.subscribe(render); // Svelte: $flow just works; React: useSyncExternalStore
// in your click handler (the popup must belong to the gesture):
flow.choose('drive');
// then, driven by snapshot.step:
flow.submitPassword(typed); // 'password': proven BEFORE anything attaches
flow.resolveConflict('merge'); // 'conflict': or 'resume' / 'replace'
```

The `conflict` step only appears when you declared local data worth asking
about (`{ hasLocalData: () => store.all('todos').length > 0 }`); otherwise the
flow applies `defaultResolution` - `'merge'` unless you choose `'resume'`
(the existing backup wins; the intuitive default when connecting means
"open my backup") or `'replace'` (this device wins). An encrypted backup
still proves its password first, whatever the resolution.

`shareFlow(engine)` and `joinFlow(link, engine)` run the share panel and the
invitation journey over a small engine port YOU implement (how links travel -
a Drive public link, a relay - is your app's business). The machines bring the
hard-won rules: a transient listing failure keeps the last-known members
(`stale: true`) instead of blanking the panel, removals are confirmed before
they leave the snapshot, removing yourself is refused, joining previews before
it commits, and the account switch is part of the journey. The share engine's
optional moves (`removeMember`, `revokeAll` - end the whole share in one
gesture) surface as `canRemoveMembers` / `canRevokeAll` in the snapshot, so a
panel only renders what its engine can actually do. A join engine
whose own popup the user closed resolves `null` from `join()`: the flow
returns to 'ready' silently - backing out of a human gesture is never an
error in these flows.

## 14. The same screens, ready-made (widgets)

When you do not want to build the connect/share/join UI at all, the widgets
render the flows for you - and stay YOUR app visually: fonts and colors
inherit from the page, every knob is a CSS custom property, every node is
restylable through `::part()`, and every string is replaceable through
`labels` (which is also how you localize them).

```ts
import { defineSelfstoreWidgets } from 'selfstore/widgets';
defineSelfstoreWidgets(); // <selfstore-connect>, <selfstore-share>, <selfstore-join>
```

```html
<selfstore-connect id="connect"></selfstore-connect>
<style>
  selfstore-connect { --selfstore-accent: #7c3aed; --selfstore-radius: 8px; }
  selfstore-connect::part(button-primary) { text-transform: uppercase; }
</style>
<script type="module">
  const el = document.querySelector('#connect');
  el.store = store; // the simple store (or a hand-built FlowHost)
  el.targets = { drive: gisDriveAuth({ clientId }), file: true, webdav: true };
  el.labels = { 'connect.title': 'Ou garder vos donnees ?' }; // partial, merges over EN
  el.addEventListener('selfstore-connected', (e) => console.log(e.detail.outcome));
</script>
```

`<selfstore-share>` and `<selfstore-join>` take the same engine ports as
their flows (recipe 13): `shareEl.engine = myShareEngine`,
`joinEl.link = location.href; joinEl.engine = myJoinEngine`. Events:
'selfstore-link-created', 'selfstore-joined', 'selfstore-join-refused'.
Custom elements work as-is in plain HTML, Svelte, Vue and React; for
programmatic control, `el.flow` is the underlying flow.

Every knob is optional; the default is the full journey. On
`<selfstore-connect>`, the destinations render in the order your `targets`
object writes them, and `recommended="drive"` badges one card (part `tag`).
`<selfstore-share>` renders ONE link per level: a level either shows its
live link (QR, copy, revoke) or a create button for it - no second write
link next to a first, and nothing to name. `levels="read"` narrows what the
panel offers to create (links the engine lists always render),
`with-create="off"` / `with-members="off"` hide those sections,
`el.confirmAction = (a) => confirm('Revoke?')` vetoes every destructive
gesture (revoke, remove, stop), and
`el.qrProvider = async (url) => dataUrl` dresses each link with a QR image
(part `qr`) without adding a dependency. An engine that implements
`revokeAll()` (end the whole share in one move) gets a quiet "Stop sharing"
link at the panel's foot - rendered only once somebody besides you is in
the members list (alone, revoking a link already ends everything); success
emits 'selfstore-share-stopped'. On `<selfstore-join>`,
`variant="banner"` collapses the card to a one-line row for pages that render
their own preview. An empty-string label (`labels: { 'share.title': '' }`)
hides an optional heading. Every widget also takes `options` for its flow:
`connectEl.options = { defaultResolution: 'resume' }` adopts an existing
backup without asking, and `joinEl.options = { deadlineMs: 120000 }` keeps a
join whose engine opens an account chooser from timing out mid-popup.

Test/SSR tip: the simple store already falls back to memory with no IndexedDB;
on the advanced store swap `indexedDbCache('my-app')` for `memoryCache()`. See
the API surface in `llms.txt`, the container layout in `SPEC.md`, and the
security analysis in `THREAT-MODEL.md`.
