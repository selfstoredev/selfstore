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

**Patch, unless an app breaks.** Move the last digit. That is the rule, not the
default with exceptions.

| Bump | When |
| --- | --- |
| **major** | An existing app stops compiling, or behaves differently without changing a line. |
| **minor** | Almost never. Reserved for what no reader could take for a routine release - a new container generation, a different way of using the library altogether. A new entry point is not one. A new widget is not one. |
| **patch** | Everything else, without an exception to look for: a fix, a performance change, a `.d.ts` correction, an added function, an added option, a new subpath entry, a new widget. |

This has been narrowed twice, and both times for the same reason. It first read
"minor: new API surface", which pushed 1.6 to 1.8 in three days - almost every
release adds surface, so the minor climbed continuously and the patch digit
never moved. It then read "would a reader upgrade *for* this", which was still a
judgement call made release by release, and judgement calls in a hurry all land
on the same side: 1.8 arrived the same week.

A version number is a signal about how much has changed. When it moves at the
same speed whatever happens, it stops carrying one. What something is worth
installing for belongs in the CHANGELOG entry, which says it in prose and in
detail; the digit cannot say it and should stop trying.

So: **the second digit stays put.** If a release feels too big for a patch, that
feeling is a sign the entry needs writing better, not that the number needs
moving.

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
4. `npm publish` - from CI, with provenance, and with the tag rather than a
   branch. The workflow refuses a tag whose version disagrees with
   `package.json`, because that is the one mistake nothing downstream can take
   back.

`refs/tags/v*` accepts no update at all, from anybody - not a deletion, not a
rewind, and not a move forward. That is not tidiness: `--provenance` attests a
commit, and an attestation that points at a tag somebody can move attests
nothing. Once `vX.Y.Z` exists it points where it points, and the way to correct
a release is the next release.

The third one is named on purpose, because forbidding the first two is not
enough and reads as though it were. "No force-push" only blocks a REWIND;
walking a release tag FORWARD onto a later commit is a fast-forward and goes
straight through - and forward is the direction that matters, since `main`
advances after every release. The rule that closes it is `update`.

An entry that only restates the diff is not an entry: the changelog says what
changed and **why**, in prose, because the why is the part nobody can recover
from the code six months later.

There is no develop or release branch. See [CONTRIBUTING.md](CONTRIBUTING.md).
