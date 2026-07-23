# Encrypted notes demo

A one-page notebook built on selfstore, meant to show the whole pitch at a
glance: it works offline, the data lives in the browser, you connect a home you
control to back it up, a password encrypts that backup end to end, and a second
tab stays in sync on its own.

## Run it

```sh
npm install     # runtime deps on disk (idb, hash-wasm, fflate)
npm run build   # produces dist/
npx serve       # or any static server at the repo root
```

Then open `/demo/` in a Chromium-based browser (the file destination uses the
File System Access API). The page pulls the local `dist/` build and its three
runtime deps straight from `node_modules`, so nothing is fetched over the
network once it is served.

## Run it without a build

The importmap in `index.html` also documents a CDN variant: drop the three
`node_modules` entries and point `selfstore` and `selfstore/widgets` at
`https://esm.sh/selfstore@<version>` (esm.sh resolves the deps itself). Handy
for a hosted, clone-free demo.

## What each step shows

- **Type a note** - the store persists to IndexedDB; reload and it is still
  there, with no server involved.
- **Sync it to a home you control** - the `<selfstore-connect>` widget drives
  the connect journey for a disk file, a WebDAV server, or an S3 bucket.
- **Encrypt backup** - a password turns the backup into ciphertext before it
  leaves the device; the destination only ever stores the encrypted archive.
  Available once a home is connected (encryption protects the backup).
- **Open a second tab** - edits converge across tabs on their own.
