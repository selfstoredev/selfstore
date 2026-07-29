# CLAUDE.md

Guidance for AI agents working in this repo. Most of this code is
AI-generated; these rules exist so it does not rot over time. Every rule is
enforced by CI on each push, so the only way through is to actually comply.

## Quality gate

Run before every commit (the pre-commit hook runs a fast subset on staged
files, CI runs everything):

```sh
npm run gate
```

`gate` = `format:check` + `lint` + `typecheck` + `knip` + `dup` +
`test:coverage`. `prepublishOnly` re-runs the core of it, so a red gate can
never reach npm.

| Command | Tool | Catches |
| --- | --- | --- |
| `npm run format:check` | prettier | style drift |
| `npm run lint` | eslint + sonarjs, zero warnings | bugs, code smells, complexity |
| `npm run typecheck` | tsc (src + examples) | type errors |
| `npm run knip` | knip | dead files, exports, dependencies |
| `npm run dup` | jscpd | copy-paste |
| `npm run test:coverage` | vitest | regressions, coverage ratchet |

The KDF tests derive real Argon2id keys (46 MiB, 3 passes); vitest's
`testTimeout` is raised in `vitest.config.ts` so a loaded machine does not
produce false timeouts. A timeout there is an environment signal, not a bug.

## The contract

- This library is a standalone, generic building block. Never reference any
  consumer application or sibling project by name, anywhere: code, docs,
  examples, commit messages, PR text.
- The public API is the product: the subpath entries and their exported
  types are the supported surface; breaking changes wait for a major.
- Backups written by any released version must keep reading, or the format
  gets a new numbered generation with an explicit CHANGELOG entry.
- Every failure a consumer can hit carries a stable error code with an i18n
  label key; never throw bare Error from a public path. The STORE ships no
  user-facing copy: it exposes keys, the host words them.
- The WIDGETS are the exception, and deliberately so: a drop-in screen that
  needs a translation table before it can be shown is not drop-in. They ship
  their own copy (EN defaults plus a pack per language, colocated with the
  widget so one key can read differently in two widgets), pick the page's
  language on their own, and let a host override any key. Adding a widget
  string means adding it to every pack in the same file.
- No dead code. knip fails on unused files, exports and dependencies.
- No copy-paste above the jscpd threshold: extract or reuse.
- Complexity budget: sonarjs caps cognitive complexity per function.
- Coverage is a ratchet. Thresholds in `vitest.config.ts` only ever go UP.
- Runtime dependencies are a liability: three is a feature. Adding one
  needs a written justification.
- Formatting belongs to prettier. Never hand-format, never fight it.
- No secrets in the repo, ever (gitleaks scans every push).
- When the gate is red: fix the cause. Never weaken a rule, raise a
  threshold, or add an eslint-disable to get past it; any exception needs
  explicit human approval in the PR.

## Git

- GitHub flow: `main` is the only long-lived branch and stays releasable.
  Every change is a small PR into `main`, squash-merged with a green CI.
- The CHANGELOG entry travels IN the feature PR, under `## [Unreleased]` -
  written while the reasoning is fresh, by whoever has it. The version number
  and the date are NOT in that PR.
- A release is a separate, deliberate PR that stamps `[Unreleased]` with a
  number and a date, bumps `package.json`, and is followed by a `vX.Y.Z` tag
  (release.yml dispatch, notes from that section).
- Merging does not publish, and green CI is a precondition for a release, never
  a reason for one. At most one release a day unless the second repairs the
  first. Entries accumulate under `[Unreleased]` in between; that is the normal
  state of `main`, not a backlog to clear.
- Publishing to npm is then a third step: publish.yml runs on a published
  release, or on demand with the tag. It never rides along with a merge.
- Nothing is ever unpublished: a burned version number cannot be reused, and a
  lockfile somewhere pins that exact one. See RELEASING.md.
- Conventional commits, English, pure ASCII. Author is always
  Florian Mousseau <florian.mousseau@gmail.com>; no AI mention, no co-author
  trailer, no tool branding anywhere (commits, branches, PRs).
