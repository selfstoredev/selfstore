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
  label key; never throw bare Error from a public path. The library ships
  no user-facing copy.
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
- A release is a `vX.Y.Z` tag cut from `main` (release.yml dispatch, notes
  from the CHANGELOG section); npm publish is a manual, human step.
- Conventional commits, English, pure ASCII. Author is always
  Florian Mousseau <florian.mousseau@gmail.com>; no AI mention, no co-author
  trailer, no tool branding anywhere (commits, branches, PRs).
