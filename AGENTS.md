# AGENTS.md

Standing instructions for any AI agent (Claude Code, Codex, OpenCode, etc.)
working on this repo. Short list; keep it that way.

## Workflow template stays in sync

The repo ships two workflow files:

- `WORKFLOW.md` — the canonical workflow used to dispatch agents against this
  project.
- `WORKFLOW.template.md` — the annotated reference covering every supported
  option, its type, default, and example.

**When you change anything that affects workflow file syntax or semantics,
update `WORKFLOW.template.md` in the same commit.** Concretely:

- Adding a new YAML key under `tracker:`, `polling:`, `workspace:`, `hooks:`,
  `agent:`, `acp:`, `smolvm:`, `server:`, or `mcp:` → document it in the
  matching section of the template.
- Renaming or removing a key → rename or remove it in the template too.
- Changing a default value in `src/workflow.ts` (or whichever parser becomes
  authoritative) → update the `Default:` annotation in the template.
- Introducing a new top-level section → add a new section block to the
  template.
- Adding a new hook env var or Liquid context field → list it in the template
  alongside the existing ones (under `hooks:` or under the prompt-body
  comment).

If you find the template already drifted from the parser at the start of your
task, fix it as part of your change. The template is the contract for what
operators can write; an out-of-date template is a bug, not paperwork.

## Build, test, and check before declaring done

- `npm run typecheck` — must pass.
- `npm test` — must pass.
- `npm run build` — must pass.

Run all three before calling `symphony.transition` into a terminal state.

## Handoff: patch bundle vs. pull request

`after_run` in `WORKFLOW.md` ships in two modes:

- **Patch bundle (default).** Writes `git format-patch` to
  `.symphony/patches/<branch>.patch` for human review. No remote needed.
  This is what fires when no GitHub remote is wired up.
- **Pull request.** Triggered when `SYMPHONY_REPO=<owner>/<repo>` is exported
  before launch AND the working repo has an `origin` remote. The hook then
  pushes the per-issue branch and runs `gh pr create`. `gh auth status` must
  be clean on the host; the token never enters the VM.

To switch this project to PR mode:

```
git remote add origin git@github.com:<owner>/smol-symphony.git
git push -u origin main
SYMPHONY_REPO=<owner>/smol-symphony npx symphony WORKFLOW.md
```

`SYMPHONY_BASE_BRANCH` (default `main`) overrides the base the agent branches
from and the PR opens against.

### File-based auto-merge

In PR mode, `after_run` can arm `gh pr merge --auto` on the freshly opened PR so
GitHub merges it as soon as required checks pass. Three env vars gate this:

- `SYMPHONY_AUTO_MERGE` — set to a truthy value (`1`, `true`, …) to enable.
  Unset / `0` / `false` leaves the existing manual-review behavior in place.
- `SYMPHONY_CRITICAL_FILES` — newline-separated git pathspec entries. If any
  commit on the per-issue branch touches a matching path, auto-merge is
  suppressed and the PR is left open for a human to review and merge. Empty
  lines are ignored. Example:
  ```
  SYMPHONY_CRITICAL_FILES="package.json
  src/types.ts
  :(glob)src/**/*.sql"
  ```
- `SYMPHONY_MERGE_METHOD` — `squash` (default), `merge`, or `rebase`. Picks
  the strategy `gh pr merge --auto` requires.

Auto-merge requires the repo to have "Allow auto-merge" enabled in its GitHub
settings and the usual branch-protection prerequisites for the chosen method.

## Don't write to generated state

Skip these when staging commits unless the user asks:

- `.agents/`, `.claude/`, `.impeccable/` — local tooling state.
- `issues*/Done/`, `issues*/Cancelled/`, `issues*/In Progress/` — runtime
  tracker artifacts from prior symphony runs.
- `.symphony/` — workspaces, patch bundles, runtime caches.
- `skills-lock.json` — auto-generated.
