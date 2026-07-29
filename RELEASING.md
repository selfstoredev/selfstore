# Releasing

What a version number means here, when one is published, and what will never
change under you.

## The promise that actually matters

selfstore is a storage library. The number on the package is not what you are
trusting - the file is.

**A backup written by any version of selfstore stays readable by every later
version.** That is the compatibility rule the test suite enforces, and it is
not a semver consequence: it holds across majors too. The format is
[specified](SPEC.md) and readable without this library at all, including from
Python, so the exit is documented rather than promised.

Everything below is about the package. The paragraph above is about your data.

## What earns which number

**The default is patch.** Move the last digit unless there is a reason not to.

| Bump | When |
| --- | --- |
| **major** | An existing app stops compiling, or behaves differently without changing a line. |
| **minor** | A milestone worth announcing: a new entry point, a widget, a capability someone would upgrade *for*. |
| **patch** | Everything else, including a fix, a performance change, a correction to the `.d.ts` - and an added function or option. |

This used to read "minor: new API surface", and that criterion is what pushed
1.6 to 1.8 in three days: almost every release adds surface, so the minor
climbed continuously and the patch digit never moved. A version number is a
signal about how much has changed. When it moves at the same speed whatever
happens, it stops carrying one.

So the question is not "did anything get added" but "would a reader of the
changelog upgrade *for* this". One more option on an existing widget is a
patch. A new subpath entry, or a capability the library did not have, is a
minor.

Two consequences worth stating, because they are where semver usually gets
bent:

- **A bug fix that changes behaviour an app could have relied on is still a
  patch** if the old behaviour was wrong. The changelog says so explicitly.
- **A new default is a major**, even when the code compiles. Silent behaviour
  changes are the ones that cost a debugging afternoon.

## When a release is cut

Merging to `main` does **not** publish. A release is a deliberate act with a
reason: a fix someone is waiting for, or a coherent batch of work that is worth
installing.

The rule, in one line: **no more than one release a day, unless the second one
repairs the first.**

That exception is written down rather than hidden, because it is real - a
release that ships a genuine defect gets fixed the same hour, and pretending
otherwise would just make this document false.

What this rules out is the pattern that produced nine patches in thirty-six
hours: publishing per merge, because the pipeline was green and publishing was
one command away. Green CI is a precondition for a release, never a reason for
one.

## Nothing gets unpublished

Published versions stay published, even superseded ones, even mistakes.

Two reasons, both concrete:

- **A version number that is unpublished is burned forever.** npm never lets it
  be reused, so the history acquires a hole that no future release can fill.
- **A lockfile somewhere pins that exact version.** A caret range resolves
  forward, but `npm ci` resolves to the exact entry in the lock - unpublishing
  it turns someone's reproducible install into a failing one, with no warning
  and no fix on their side.

The tool for a release that should not be used is `npm deprecate`, which leaves
it installable and says so at install time. The tool for a broken release is
the next release.

## How the history reads

The `0.x` line was the exploration, published while the API was still moving,
and it is no longer on npm. **1.0.0 (23 July 2026) is the first release meant to
be depended on** - the point at which the format, the error contract and the
store's surface stopped changing shape.

The minors since are additive: each one names what it added, and none of them
moved anything that already worked. That is what a run of minors on a young
library looks like when the compatibility rule at the top of this page is being
kept, and it is the honest reading of a version number that climbed quickly.

## The mechanism, not just the intention

A rule that depends on remembering it gets broken. The one that produced nine
patches in thirty-six hours was structural: the version bump travelled inside
each feature PR, so every merge was already a release, and not publishing took
more effort than publishing.

So the bump moved out of the feature PR:

- **A feature PR carries its CHANGELOG entry under `## [Unreleased]`**, written
  while the reasoning is fresh, by whoever has it. No version number, no date.
- **A release is its own PR**: it stamps `[Unreleased]` with a number and a
  date, and bumps `package.json`.

Entries accumulating under `[Unreleased]` is the normal state of `main`, not a
backlog to clear. Batching is now the path of least resistance, which is the
only kind of rule that survives.

## The steps

1. `main` is green, `[Unreleased]` holds something worth installing.
2. Open the release PR: stamp the section with `X.Y.Z` and the date, bump
   `package.json`.
3. Merge, tag `vX.Y.Z` from `main`, GitHub Release from that section.
4. `npm publish` - from CI, with provenance.

An entry that only restates the diff is not an entry: the changelog says what
changed and **why**, in prose, because the why is the part nobody can recover
from the code six months later.

There is no develop or release branch. See [CONTRIBUTING.md](CONTRIBUTING.md).
