# AGENTS.md

The rules for this repository live in [CLAUDE.md](CLAUDE.md), and they apply to
any agent working here, whichever file it happens to read first.

Release mechanics, and what earns which version number, are in
[RELEASING.md](RELEASING.md). The short version: **patch, unless an app
breaks**. The second digit stays put - not for a new function, not for a new
subpath entry, not for a new widget. What a release is worth installing for
belongs in its CHANGELOG entry, not in the number.

Two conventions get lost most often, so they are repeated here:

- Branches and PRs are named by open-source convention, in English, with **no
  tool prefix** - not `claude/`, not `agent/`, not `codex/`. A merge writes the
  branch name into the history for good; a sibling repo collected six such
  branches in a day before anyone noticed.
- PR titles follow the same rule as commits: English, conventional commits,
  pure ASCII.
