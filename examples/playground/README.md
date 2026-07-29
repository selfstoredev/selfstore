# Playground

The whole pitch in one screen, running the published package: notes that survive
a reload, a real file on the disk as their home, and a genuine encrypted ZIP.

## Open it without installing anything

[Open in StackBlitz](https://stackblitz.com/github/selfstoredev/selfstore/tree/main/examples/playground)

## Or run it locally

```sh
cd examples/playground
npm install
npm run dev
```

## What each button actually does

- **Typing** writes to the store, which auto-saves to an IndexedDB working copy.
  Reload the page and the text is still there. Nothing left the tab.
- **Keep it in a file on my disk** runs `store.connectFile()`. On a Chromium
  browser you pick a real `.zip` once and every later change rewrites that same
  file. Elsewhere the store falls back to `'manual'` and says so.
- **Download an encrypted backup** turns on `protect()` and hands over the file.
  `downloadBackup()` returns `false` when the save dialog is dismissed, and the
  page says nothing was written rather than claiming a backup exists.

## One honest caveat about the embedded preview

The file picker needs the File System Access API, which a cross-origin preview
iframe does not get. In StackBlitz, **open the preview in its own tab** before
pressing that button, or it will report the manual fallback on a browser that
handles files perfectly well.

Everything else - persistence, status, encryption, the backup file - works in
the embedded preview.
