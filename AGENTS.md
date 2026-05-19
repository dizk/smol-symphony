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

Run all three before calling `symphony.mark_done`.

## Don't write to generated state

Skip these when staging commits unless the user asks:

- `.agents/`, `.claude/`, `.impeccable/` — local tooling state.
- `issues*/Done/`, `issues*/Cancelled/`, `issues*/In Progress/` — runtime
  tracker artifacts from prior symphony runs.
- `.symphony/` — workspaces, patch bundles, runtime caches.
- `skills-lock.json` — auto-generated.
