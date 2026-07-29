# AGENTS.md

The rules for this repository live in [CLAUDE.md](CLAUDE.md), and they apply to
any agent working here, whichever file it happens to read first.

Release mechanics, and what earns which version number, are in
[RELEASING.md](RELEASING.md). The short version: **the default is patch**. The
minor moves for a milestone someone would upgrade *for*, not for one more
function.

Two conventions get lost most often, so they are repeated here:

- Branches and PRs are named by open-source convention, in English, with **no
  tool prefix** - not `claude/`, not `agent/`, not `codex/`. A merge writes the
  branch name into the history for good; a sibling repo collected six such
  branches in a day before anyone noticed.
- PR titles follow the same rule as commits: English, conventional commits,
  pure ASCII.
