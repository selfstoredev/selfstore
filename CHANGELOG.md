# Changelog

All notable changes to selfstore are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
adheres to [Semantic Versioning](https://semver.org/). What each number means
and when one is published: [RELEASING.md](RELEASING.md).

The `0.x` line was the exploration, published while the API was still moving,
and it is no longer on npm. **1.0.0 (23 July 2026) is the first release meant to
be depended on.** The minors since are additive - each names what it added, and
none moved anything that already worked. Backups written by any version stay
readable by every later one; that rule holds across majors and is what the
version number is not asking you to trust.

## [Unreleased]

_Nothing yet. Entries land here as they are merged; the release PR stamps them
with a number and a date._

## [1.8.3] - 2026-07-29

### Added

- `driveBackupsHost()` in `selfstore/backups`: the `BackupsHost` port already
  wired over the Drive destination. Every operation the port asks for was
  already exported - list, open-by-id, create, rename, delete, find-or-create
  the personal file - so the only thing standing between an app and
  `<selfstore-backups>` was an adapter, and each app wrote its own. Mounting
  the backups list is now three lines, and the three details that adapter has
  to get right are settled once: `open()` binds a FIXED file id (a connect
  would re-resolve by name and merge two isolated backups), the active id lives
  under the same kv key the connect path reads (or a reload adopts a different
  file than the one on screen), and a lapsed session asks for consent instead
  of raising the reconnect gate.
- `driveTarget.account()` (and the `DriveAccount` type): which Google account
  the current session belongs to. A destination named "Google Drive" is not an
  address - several accounts look alike, and a user who connected the wrong one
  had no way to tell from a brand name. One metadata call, `user` field only,
  allowed by the `drive.file` scope; a destination that will not say answers
  nulls rather than throwing.

## [1.8.2] - 2026-07-29

### Fixed

- Opening another app's backup is now refused and named for what it is, instead
  of prompting for a password. Every backup has always carried its writing app's
  id in the cleartext header; nothing read it. So picking the wrong file taught
  the user their password "does not work" on a file that was never this app's to
  open - and the `deferUnlock` journey went further and silently adopted the
  foreign file as the app's home. The connect flow and the simple store now
  refuse before any password is asked (`FOREIGN_BACKUP`, worded by the widgets
  in every shipped language), and `attachTarget` refuses at the deepest level in
  both directions: `merge`/`replace-local` would pour foreign records into the
  app, `replace-remote`/`wipe` would destroy the other app's backup. A header
  that cannot be read accuses no one: corrupt or unrelated files keep behaving
  exactly as before, and `inspectTarget` now reports the writing app so hosts
  can word the refusal themselves.

- A failed read or write on the browser `file` destination now carries a stable
  error code, like every other destination already did. It threw the browser's
  own `DOMException`, which has no code, so the store's classification put all
  of them in the same default branch: transient, keep retrying. That reading is
  the one that is never true here. A permission the user revoked came back as
  "momentarily unreachable" instead of raising the one-click reconnect gate that
  is the only thing able to re-grant it; and a backup file that had been deleted,
  renamed or left on an unmounted volume was retried forever while the store went
  on reporting the data as saved, because the local write had already succeeded.
  A lost permission is now `AUTH_EXPIRED`, a file that is no longer there is
  `TARGET_GONE`, and anything else stays the retryable code it should always have
  been. `stat()` is deliberately unchanged: a marker nobody can read is still
  "cannot tell", not a failure.

## [1.8.1] - 2026-07-29

### Fixed

- The degraded download-only file mode no longer outlives the browser session
  that caused it. `'file-manual'` records something about the BROWSER - that a
  picker could not deliver a writable file - but it was persisted like a
  property of the data and re-read on every boot without ever asking again. One
  bad session was therefore permanent: a browser that ships the File System
  Access API and refuses it once, a picker called a moment after its activation
  lapsed, and the store stayed in download-on-demand mode on a Chromium
  perfectly able to hold a file, with nothing a user could click to get
  automatic saving back. A new session now re-examines the verdict: where a file
  can be held, the stale claim is dropped and the host can offer a destination
  again. Where the API is genuinely absent, nothing changes - that is not a
  stale verdict, it is the mode.

## [1.8.0] - 2026-07-29

### Added

- The `file` destination now works inside a desktop shell. `useDesktopFiles()`
  takes the shell's filesystem and dialog calls once at start-up, and every
  `file` destination in the library then writes a real path instead of asking
  the browser for a handle. With Tauri v2 that is the two plugin imports and one
  call; nothing else in a host changes, and `file: true` keeps meaning what it
  meant.

  The problem it answers: the File System Access API is Chromium-only, and
  inside a native webview it is usually absent altogether, since macOS and Linux
  shells embed WebKit which never shipped it. So packaging a web app as a
  desktop app used to _lose_ the file mode and fall back to download-on-demand,
  in the one environment where writing a real file is easiest.

  A path also outlives a handle. It survives a restart, an app update and a copy
  of the profile directory, and it carries no permission that has to be granted
  again, so a desktop app reopens on its file with nothing asked of the user
  where the browser needs a click. Writes there are also never reported as a
  lost grant: a full disk or an unplugged volume is transient, and raising the
  reconnect gate would ask someone to re-pick a file that never moved.

  No new runtime dependency: the shell's calls are injected, never imported, so
  a web build carries none of this.

## [1.7.5] - 2026-07-29

### Added

- The connect cards draw a glyph per destination on their own. `icons` was the
  host's job and nothing filled it, so a drop-in screen rendered bare cards and
  every consuming app answered the same way: two image files of its own, copied
  from app to app and drifting. The glyphs are inlined as data URIs, because a
  library that promises the data stays put cannot fetch an image from a third
  party to draw its own screen. They are deliberately NEUTRAL drawings, not
  brand marks: redistributing a provider's trademark inside a public package is
  a different question from an application displaying it to name an integration
  it offers, and a host that has cleared that right still passes its own logo
  through `icons`, which wins.

## [1.7.4] - 2026-07-29

### Fixed

- A property set on a widget BEFORE its class is defined now reaches the
  accessor instead of shadowing it for good. `el.store = handle` on a
  not-yet-defined element writes an own property on the instance; once the
  class is defined that own property answers first, the setter never runs, and
  the widget sits there - shut, or open and empty - without a word in the
  console. Every host that loads `defineSelfstoreWidgets()` lazily hits this: a
  dynamic import, a framework effect, a script at the end of the body. Each
  widget now hands those properties back on connect, so hosts no longer need a
  "widgets are defined" flag to gate their assignments.

## [1.7.3] - 2026-07-29

### Fixed

- A cross-tab lock nobody releases no longer freezes a tab for good. The
  serialized flows (save, pull, forget, detach) run under a Web Lock so two
  tabs never interleave on the shared cache - and a Web Lock belongs to a
  CLIENT, which does not necessarily hand it back when it stops running:
  Firefox keeps the locks of a page it has frozen into its back/forward cache,
  where Chrome refuses to freeze a page holding one. A second tab left open in
  the background could therefore hold `selfstore:<app>` forever, and every flow
  in the live tab queued behind a lock that would never come - no throw, no
  timeout, no signal of any kind. Saving stopped, and every gesture wired to a
  store call became a button that does nothing at all. The wait is now bounded:
  past it the flow goes ahead without the lock, which risks two tabs
  interleaving - what the merge engine is for, and what already happens between
  two devices - rather than a store that never writes again. The bypass is
  reported through `state.lastError` instead of passing in silence.

## [1.7.2] - 2026-07-29

### Fixed

- A published type no longer names a consumer application. The rationale for
  dated download names illustrated its point with one, and that comment
  travels: it is emitted into the shipped `.d.ts`, so every install carried the
  name of an unrelated product. Documentation only - no API or behaviour
  change.

## [1.7.1] - 2026-07-29

### Fixed

- A file picker called outside a user gesture no longer condemns the browser.
  A picker REQUIRES transient activation, and a call made without one throws
  exactly what a browser that ships the picker and refuses it throws - so the
  refusal was recorded against the browser, for the whole session. One
  mistimed call then sent every later save down the manual-download path on a
  Chrome that holds files perfectly well, and nothing ever revised that verdict.
  A throw only says something about the browser when the browser was allowed to
  answer, so the verdict is now conditioned on there having been an activation
  to spend.
- Adopting an existing backup file no longer discards the file when the
  readwrite grant is refused. Raising the grant up front is a courtesy - it
  spares a second prompt on the first save - but it was treated as a condition,
  and it can fail for a reason that has nothing to do with the file: the open
  picker consumes the very activation a permission prompt needs, so a browser
  can answer 'prompt' without ever asking anyone. The journey then read the
  refusal as "no file" and returned to the choice screen silently, which is how
  pointing at your own backup came to look like the app ignoring the click. The
  file is adopted either way: reading works on the grant the picker gave, and a
  write that cannot happen raises the store's own reconnect gate, whose one
  click re-asks from inside a real gesture - the only place it can work.

## [1.7.0] - 2026-07-28

### Added

- Widget copy takes `{placeholders}`, filled from the state. A status that
  cannot name WHERE it saved has to be read twice - the state on one line, the
  destination on another - and that split was imposed by the widget, not by the
  language: every pack was forced into the same "state, then label" order. A
  pack can now write one sentence and put the place where its own grammar wants
  it. A key built around a place carries a `.placeless` twin for the case where a
  target is attached but has no name to give - declared only where it is
  needed, since a key that never mentions a place already answers, so the placeholder itself
  can never reach the screen; an unknown placeholder is left visible rather than
  blanked, because a hole in a sentence reads as a bug nobody can name, while
  the key names it.

### Changed

- The status no longer describes the browser as the PLACE the data lives. It is
  not one: it holds a working copy that a cleared profile takes with it, so
  "only on this device" reads as an address and reassures about something that
  has no durability. The state with no destination now names what is MISSING -
  nothing has been saved out yet - and the saved state says where, by name.
  Both stay overridable per key, as all widget copy is.

## [1.6.9] - 2026-07-26

### Added

- The widgets now carry their own translations. Until now they shipped English
  copy and a `labels` map, so any non-English app had to hand-write a table of
  every string before it could show a screen - a drop-in element that needs
  a translation file first is not drop-in, and each consuming app ended up
  maintaining (and drifting on) its own wording. Each widget now ships a pack
  per language beside its English defaults, and picks the right one from the
  page: the nearest `lang` attribute, else `<html lang>`, else the browser.
  A French app writes nothing at all. French ships first; the resolution order
  is `labels` override, then the page's pack, then English, then the key, so
  an existing host that passes a full map keeps exactly the copy it had, and a
  host that overrides three keys gets those three and translated copy for the
  rest. Packs live next to the widget that uses them, so one key ('the
  destination did not answer', 'the share service did not answer') can read
  differently where it means something different.

## [1.6.8] - 2026-07-26

### Added

- `.verified()` on the backup chain, and `verifyBackup()` standalone: read a
  freshly written backup back before anyone is told it exists, and throw the new
  `VERIFY_FAILED` otherwise. A backup encrypted with a key nobody can reproduce,
  truncated, or built from an empty snapshot looks exactly like a good one -
  right name, right date, plausible size - and the difference only shows up on
  the day of the disaster, when it is too late to make another. The only way to
  know is to open it, and it costs one decrypt of data the app already holds.
  The flag rides in the encode options, so setting it on one link of the chain
  and losing it on the next is not possible.

## [1.6.7] - 2026-07-26

### Fixed

- A backup waiting to be downloaded is a WARNING, not information. The severity
  drives the colour of a pill, and `info` rendered calm next to a button asking
  for a gesture: the colour said all was well while the button said otherwise.
  What has been typed since the last export exists nowhere but that browser.
- `saveToDisk()` dates the name when it falls back to a download. Through a
  handle the app rewrites the same file, so the name stays stable; a download
  never replaces anything and the browser appends " (1)", " (2)" whatever we do.
  The pile forms either way - dated to the minute, it says which one is the
  latest and lets the user step back. `datedName()` is exported for hosts that
  build their own names.

## [1.6.6] - 2026-07-26

### Added

- `storageAdvice()`: whether this browser will keep the local store, and the one
  gesture that changes it. Safari erases script-writable storage after seven
  days of browser use without interaction with the site - it does not
  inconvenience a local-first app, it deletes it. Installing to the Dock or Home
  Screen switches the store to persistent mode, which WebKit exempts from its
  eviction triggers. Reported as an advisory, never a guarantee: WebKit does not
  document that this neutralises the inactivity rule by name. The library ships
  no copy - the host writes the sentence.

### Fixed

- `markDownloaded()` records WHEN. A download is the save on a browser that
  cannot hold a file, so `state.lastSavedAt` moves with it and a host can say
  "saved two hours ago" instead of a bare state word. Every host had to keep its
  own memo of the last export, and one of them kept it in memory - telling the
  user, the next morning, that they had never saved anything.

## [1.6.5] - 2026-07-26

### Added

- `fileTarget.openExisting()` is now public. It was reachable only through the
  connect widget, so a host drawing its own "load a backup" button had no way
  to let the user point at a file AND adopt it as the destination - it could
  read the bytes or attach a file, never both in one gesture.

## [1.6.4] - 2026-07-26

### Added

- `backup(...).encryptedWith(pw).alsoOpenedWith(secret)`: a second secret that
  also opens the backup, typically a recovery code the user prints and puts
  away. A password that lives only in one person's memory is the likeliest way
  a local-first backup dies - nothing can reset it. The envelope has always held
  several key slots; this exposes them where a backup is actually written. Each
  secret wraps the same data key, so either one opens the file and neither can
  be derived from the other. Reading is unchanged: `restore(...).withPassword()`
  already tries every slot.

## [1.6.3] - 2026-07-26

### Fixed

- The form field labels added in 1.6.2 referenced a CSS variable that does not
  exist (`--_muted`), so they rendered at full text colour instead of the muted
  tone every other secondary line uses.

## [1.6.2] - 2026-07-26

### Added

- `fileTarget.isOpenSupported()`: whether this browser can let the user point at
  an EXISTING file. Creating a backup degrades to a download when the picker is
  missing, but adopting an existing one has no fallback, so hosts need to gate
  that gesture separately. `<selfstore-connect>` now uses it instead of testing
  `window` directly, and stops rendering the "open" button on a browser that has
  refused the picker - it used to leave a button that answered nothing.
- New `labelled` and `label` parts on `<selfstore-connect>`, for theming the
  form fields' names.

### Fixed

- A browser that ships the file picker and then refuses to open it no longer
  produces an error the user cannot act on. Some browsers expose
  `showSaveFilePicker` and throw on call unless a flag is turned on, so every
  presence check returns a false positive: the host offered a file destination,
  the click threw, and the connect flow reported a failure. Presence is not
  capability, and the call is the only honest probe - so `isSupported()` now
  answers false once a picker has refused, and both `connectFile()` and the
  connect flow re-ask after a null answer, landing on the same
  download-on-demand mode as a browser without the API. A cancelled dialog is
  untouched: it still means the person changed their mind, not that the browser
  cannot do it.
- `openExisting()` no longer throws on a refused picker either. A permission
  denied on one chosen file is kept apart from a refused picker: the first says
  nothing about the browser, which has just proved that it opens.
- The WebDAV and S3 forms name their fields with a visible label instead of a
  placeholder only. The name vanished at the first keystroke, so anyone who
  paused mid-form had to clear a field to remember what it wanted, and a screen
  reader announced a row of unnamed inputs. A placeholder is a hint, not a label.
- The destination card puts its icon on the title's line. A card carrying its own
  action row is tall, and centering floated the icon in the middle of the text,
  beside no line in particular.

### Tests

- The distinction is pinned on both paths: refused degrades to manual, cancelled
  returns to the offer with no error. Each asserts the picker was actually
  called, so it cannot pass through the "API missing" branch instead. First
  tests on `connectFile()`, which had none. Coverage ratchet raised to
  82.4 / 76.5 / 77.1 / 85.2.

## [1.6.1] - 2026-07-26

### Fixed

- `backup(...).toDisk()` asks WHERE before it encrypts. The save dialog needs
  the transient user activation of the click that led to it, and building an
  encrypted backup outlives that window - Argon2id is deliberately slow. So the
  browser refused the dialog, `saveToDisk` read the refusal as "no picker here"
  and fell through to a download: the user clicked "save", chose nothing, and
  found a file in their downloads folder instead of where they meant to put it.
  Asking first fixes it, and a cancelled dialog now also skips building the
  backup at all rather than encrypting for nothing.
- A picker that refuses for any reason other than cancellation is no longer
  confused with a cancellation: the first still falls back to a download (the
  backup must reach the disk somehow), the second reports false and writes
  nothing.

### Tests

- The order is locked down: the dialog opens before the blob is built, and a
  cancellation builds no blob at all. Both would pass silently under the old
  order, which is why they exist. Coverage ratchet raised to
  81.8 / 75.95 / 76.6 / 84.7.

## [1.6.0] - 2026-07-25

### Changed

- `saveToDisk()`, `backup(...).toDisk()` and `store.downloadBackup()` now
  resolve to a **boolean**: true when bytes were handed to the browser, false
  when the user closed the save dialog. They used to swallow the cancellation
  and resolve as if the file had been written, so a host that stamped "last
  backup: today" afterwards told the user they were covered when no file
  existed - a lie that only surfaces the day the file is needed.
  `downloadBackup()` also keeps the pending-download flag up on a cancellation,
  instead of clearing the very nudge that asks for the missing file. Widening
  `Promise<void>` to `Promise<boolean>` breaks no caller that ignored it.
- `store` is now **idempotent** on `<selfstore-connect>`, `<selfstore-status>`
  and `<selfstore-gate>`: assigning the same handle again does nothing. Hosts
  can therefore assign it straight from a reactive effect and let that effect
  re-run. Before, every assignment rewired the flow, which would drop a journey
  in progress - so hosts invented "wire once" guards, and the obvious guard
  (keyed on the element) then swallowed the real assignment when the store was
  created after the widget was mounted, leaving the widget permanently inert.
  The widget owes the host this, not the other way round.

### Docs

- Recipe 4b: starting over after a forgotten `cacheLock` secret, where the
  ORDER is the whole recipe. Read the backup first (`read()` decrypts into
  memory and touches no storage), and only then clear the sealed cache: doing
  it the other way round loses the cache AND keeps nothing from a file whose
  password turns out not to match.
- Recipe 14 shows the reactive-effect assignment the idempotent setter allows.

### Tests

- `saveToDisk` over an accepting picker, a cancelled one, a picker that fails
  for another reason (falls through to the download), and no picker at all.
- `downloadBackup` on both paths, asserting the pending flag is only cleared
  once bytes are written.
- The two widget regressions: a re-assigned handle leaves a journey in progress
  untouched, and a store arriving after the mount still opens the gate.
  Coverage ratchet raised to 81.7 / 75.9 / 76.4 / 84.6.

## [1.5.0] - 2026-07-25

### Added

- `<selfstore-gate>`: the first-run screen, as a widget. Asking "where should
  this live?" up front is the one screen every consuming app had to build by
  hand, and the hand-rolled version kept getting the same two things wrong:
  it inspected `targetKind` instead of the derived `status.action`, so it
  demanded a new destination while the real problem was a broken connection,
  and it rebuilt its frame on every status tick, which re-appended the connect
  element and silently dropped a journey in progress. The gate opens itself
  while `status.action === 'choose-destination'`, shuts once the store has a
  durable home, and stands still while it is open. `armed` holds it closed
  during an app's boot, `deferrable` offers the honest way out (device-only is
  a working mode, just a fragile one) and emits `selfstore-gate-deferred`, and
  `brand` / `extra` / `footer` slots take the host's own chrome. It forwards
  the connect knobs (`targets`, `options`, `icons`, `recommended`, `advanced`,
  `webdavPresets`) to the child it builds, exposed as `gate.connect`.

### Tests

- The gate's ten cases, including the two regressions it exists to prevent: it
  stays shut over a `reconnect` status (a needs-attention destination outranks
  a missing one), and the connect child keeps its identity across status
  notifications, so a journey in progress survives. Coverage ratchet raised to
  81 / 75.5 / 75.9 / 83.8.

## [1.4.0] - 2026-07-25

### Added

- `LockableCache.reseal(secret)`: change the secret that seals a locked cache,
  in place. Until now "change my password" had no honest implementation for
  `cacheLock` - `unlock()` opens a cache but nothing changed its secret, so an
  app had to wipe and rebuild, which also throws away the durable
  destination's session. `reseal` re-derives the key under a fresh salt and
  rewrites every sealed record (collections and files), encrypting into memory
  first so the new salt and the data it governs land in a single transaction:
  an interrupted change can never leave records that no key opens. Requires
  the cache to be unlocked, since what cannot be read cannot be re-sealed.

### Tests

- First coverage of the sealed IndexedDB cache (`fake-indexeddb`): the first
  secret setting the lock, a wrong secret leaving it shut, a locked read
  refusing rather than answering "empty" (which would invite an app to save
  over real data), `clear()` working without the secret so a forgotten
  passphrase is not a dead end, and the `reseal` guarantees. Coverage ratchet
  raised to 80.7 / 75.4 / 75.6 / 83.5.

## [1.3.0] - 2026-07-25

### Fixed

- A store built with `requireEncryption` could not complete the connect
  journey at all: attaching an empty or plaintext destination went through
  without a password and the store refused it (`ENCRYPTION_REQUIRED`), so
  "create a new backup" always ended on the generic error step. The flow
  now encrypts such a destination with the secret the host supplies (see
  below), which also removes the older workaround of writing a cleartext
  backup and protecting it on a second write - the very first write is
  ciphertext.

### Added

- `ConnectFlowOptions.password`: a secret the host already holds (an app
  passphrase, a derived key), as a value or a lazily-resolved callback. It
  is used only when the journey creates or adopts a backup that is NOT
  already encrypted; a backup that is already encrypted keeps being proven
  through the password step (or adopted locked under `deferUnlock`), so a
  host secret that happens to differ can neither fail the attach nor
  overwrite what it cannot read.

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
