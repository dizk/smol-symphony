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

## Handoff: pull request (or branch-only in local mode)

The handoff lives on the **Done** state's per-state `after_run` hook in
`WORKFLOW.md` (`states.Done.hooks.after_run`). Because the orchestrator only
fires that hook on transition INTO Done, the script does not need to check
whether the issue actually terminated — that's structurally guaranteed. The
sibling Cancelled state has no `after_run`, so cancelled work is discarded
with the workspace.

The orchestrator pre-stages `SYMPHONY_PR_TITLE`, `SYMPHONY_PR_BODY_FILE`,
`SYMPHONY_BRANCH`, and `SYMPHONY_TRACKER_ROOT` before invoking the hook. The
body file holds the current tracker issue body, which carries every
`symphony.transition` notes block accumulated across the run.

- **Pull request.** Triggered when `SYMPHONY_REPO=<owner>/<repo>` is exported
  before launch. The `after_create` hook adds the `origin` remote pointing at
  GitHub; `after_run` pushes the per-issue branch, then runs `gh pr create`.
  `gh auth status` must be clean on the host; the token never enters the VM.
- **Local-only (default).** When `SYMPHONY_REPO` is unset the push/PR step is
  skipped. The per-issue `agent/<id>` branch is left in the workspace until
  the orchestrator removes the workspace; pick the commits up with `git log`
  against your local clone, or run with `SYMPHONY_REPO` set to open a PR.

To switch this project to PR mode:

```
SYMPHONY_REPO=<owner>/smol-symphony npx symphony WORKFLOW.md
```

`SYMPHONY_BASE_BRANCH` (default `main`) overrides the base PRs open against.
`SYMPHONY_INTEGRATION_BRANCH` (default `integration`) overrides the shared
integration branch agents converge on (see below).

## Shared integration branch

Agents branch their workspace from a shared `integration` branch (not BASE),
so an in-flight agent sees work from peers whose PRs against `main` are still
open for review. This decouples agent throughput from human review throughput
— the PR queue can grow without starving the swarm.

How it works:

- `after_create` clones from `integration` (seeded from `main` on first run).
- `after_run` (on Done) opens the PR against `main` as before, then merges
  `agent/<id>` into `integration` and pushes. In remote mode the push goes to
  `origin`; in local mode it goes to the source repo's `integration` branch.
- On a clean merge the issue terminates in Done. On a merge conflict the hook
  aborts the merge (leaving `integration` clean), moves the issue file from
  `Done/` to the `Conflict/` holding state, and appends the list of
  conflicted files + diff stat to the body. The PR against `main` is
  unaffected — the operator can land it on their own cadence.

### `main → integration` reconciliation ritual

When PRs land on `main`, `integration` drifts. Periodically fold `main` into
`integration` so new dispatches see the merged work:

```
# in remote mode
git fetch origin main integration
git checkout integration
git pull --ff-only origin integration
git merge --ff-only origin/main || git merge origin/main
git push origin integration

# in local mode (source repo on disk)
git fetch . main:main  # ensure local main is current
git checkout integration
git merge --ff-only main || git merge main
```

This is currently a manual operator ritual; a future issue can wire it onto a
PR-merge webhook so it happens automatically.

### Conflict resolution

When an issue lands in `Conflict/`:

1. Read the appended diff context to see which files conflicted.
2. Either rebase the per-issue branch against the current `integration` and
   re-run the integration merge by hand, or discard the agent's work and
   route the issue back into the active queue (Todo) from the dashboard.
3. The PR against `main` is independent and is still open for review.

The orchestrator does not auto-dispatch from `Conflict/`; resolution is a
human-in-the-loop step. The per-issue workspace (`.symphony/workspaces/<id>`)
and the `agent/<id>` branch inside it are preserved across the reroute so
the resolution above has something to rebase from — the runner detects the
post-hook reroute and suppresses the terminal-state workspace cleanup.

## Don't write to generated state

Skip these when staging commits unless the user asks:

- `.agents/`, `.claude/`, `.impeccable/` — local tooling state.
- `issues*/Done/`, `issues*/Cancelled/`, `issues*/In Progress/` — runtime
  tracker artifacts from prior symphony runs.
- `.symphony/` — workspaces, runtime caches.
- `skills-lock.json` — auto-generated.
