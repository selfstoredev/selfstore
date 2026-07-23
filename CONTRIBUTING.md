# Contributing

Thanks for looking at selfstore. Small, focused PRs land fastest.

## Ground rules

- **KISS and frugal**: no new runtime dependency without a very good reason
  (the whole library depends on three).
- **The contract is sacred**: public API and file-format changes need an issue
  first. Backups written by ANY past version must keep reading.
- **Every failure has a stable code**: never throw bare `Error` from a code
  path a consumer can hit; extend `SelfstoreErrorCode` instead.
- **Headless**: the library never ships user-facing copy or colors. Errors
  carry codes; the app renders.

## Dev loop

```sh
npm install
npm test          # vitest, includes the seeded convergence fuzz
npm run typecheck # tsc --noEmit
npm run build     # tsup (ESM + d.ts)
```

All three must be green. New behaviour needs a test that fails without the
change; contract-level behaviour belongs in `contract.test.ts`.

## Commit style

Conventional commits (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`,
`chore:`), English, ASCII. One logical change per commit.
