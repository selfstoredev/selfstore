# Sync: serverless convergent merge

This module keeps several copies of the same JSON data in agreement **without a
server**. Each device edits its own copy offline; when the copies meet (through a
shared backup file, not a sync service), every device folds the others in and
they all end up identical.

No server means no referee. Two devices change the same record while offline,
then meet: someone has to decide who wins, and every device must decide the
*same* way, in any order. That is the whole problem this module solves.

## The clock (`hlc.ts`)

You cannot order edits with `Date.now()`: device clocks disagree, and a phone
running five minutes fast would win every conflict. A Hybrid Logical Clock is a
timestamp built from three parts:

```
wall time  |  counter  |  device id
```

- **wall time** keeps it roughly in step with real time;
- the **counter** breaks ties within the same millisecond, and keeps rising even
  if the wall clock jumps backwards, so a clock never goes down;
- the **device id** makes the order *strict*: two different devices can never
  produce the same stamp, so "later wins" is never a coin flip.

It is encoded as a fixed-width string, so comparing two clocks is a plain string
comparison and string order equals edit order.

## The merge (`merge.ts`)

Records are matched by a string `id` field. For each id, the later clock wins.
A delete leaves a **tombstone** (a dated "this was removed") so a device that
never saw the delete cannot silently bring the record back.

What "wins" means is configurable per collection:

| strategy | what it means |
| --- | --- |
| `lww-set` | later write per id wins. The default. |
| `lww-map` | merge field by field: edits to *different* fields of one record both survive |
| `grow-set` | append-only; entries never change, so they never conflict |
| `lww-register` | one value taken as a whole; later write wins |
| `manual` | do not auto-resolve; hand both versions back to the app |

You pick them when you open the store:

```ts
selfstore('app', {
  sync: {
    strategies: { ledger: 'grow-set', settings: 'lww-register' },
    fallback: 'lww-set',
  },
});
```

Conflicts are never dropped in silence: a genuine concurrent edit is reported,
with both values, so the app can say "your other device changed this too".

## Why you can trust it (`merge.fuzz.test.ts`)

"Converge" has a precise meaning, and the fuzz test checks it on thousands of
random, seeded edit histories:

- **order does not matter**: merging A then B equals merging B then A;
- **duplicates do not matter**: merging the same copy twice changes nothing;
- **grouping does not matter**: a three-way merge lands in the same place however
  you pair it up.

When a case fails it prints its seed, so the exact history replays as a fixed
regression test.

## What it is not

- **Full-state**, not delta: every merge works on the whole dataset. Fine at the
  MB scale, wasteful for very large data.
- **Not a sequence CRDT**: for live collaborative text, store a Yjs or Automerge
  document as a binary file in the snapshot and let the store carry it.

Files: `hlc.ts` is the clock, `merge.ts` is the engine, `index.ts` is the public
surface.
