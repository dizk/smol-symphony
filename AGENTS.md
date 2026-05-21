# AGENTS.md

Standing instructions and a small map for any AI agent (Claude Code, Codex,
OpenCode, etc.) working on this repo. Keep it short.

## Where things live

- `src/orchestrator.ts` — top-level wiring; per-issue dispatch lifecycle entry.
- `src/agent/runner.ts` — per-issue runner; owns the running-entry state the
  hook env contract is built from.
- `src/mcp.ts` — MCP tools exposed to in-VM agents (`symphony.transition`,
  `symphony.request_human_steering`, `symphony.propose_issue`).
- `src/workflow.ts` — workflow file parser; the contract `WORKFLOW.template.md`
  documents.
- `src/trackers/local.ts` — local markdown tracker (only kind today).
- `src/acp-bridge.ts` + `scripts/vm-agent.js` — host↔VM ACP transport.
- `src/http.ts` — HTTP dashboard + MCP endpoint listener.
- `WORKFLOW.md` — canonical workflow this repo dispatches against itself.
- `WORKFLOW.template.md` — annotated reference for workflow file syntax.
- Handoff (push + PR) is documented in `README.md` § "After-run handoff".

## Workflow template stays in sync

**When you change anything that affects workflow file syntax or semantics,
update `WORKFLOW.template.md` in the same commit.** Concretely:

- Adding a new YAML key under `tracker:`, `polling:`, `workspace:`, `hooks:`,
  `agent:`, `acp:`, `smolvm:`, `server:`, or `mcp:` → document it in the
  matching section of the template.
- Renaming or removing a key → rename or remove it in the template too.
- Changing a default value in `src/workflow.ts` → update the `Default:`
  annotation in the template.
- Adding a new hook env var or Liquid context field → list it in the template
  alongside the existing ones.

If you find the template already drifted from the parser at the start of your
task, fix it as part of your change. An out-of-date template is a bug, not
paperwork.

## Hooks are glue, not state-machine extension points

Hooks in `WORKFLOW.md` are repo-local glue that runs on the host with cwd in
the per-issue workspace: cloning, `git push`, `gh pr create`, rescuing
artifacts. They are not an extension point for behavior the orchestrator owns.

Implement in the orchestrator (runner / MCP / `src/orchestrator.ts`) — not in
a hook — when the change adds a new state transition, mutates tracker files
the orchestrator wrote, needs the runner to re-detect what the hook did, or
requires a new `SYMPHONY_*` env var so the hook can reach into
orchestrator-owned state. A growing hook env contract is a signal the logic is
on the wrong side of the seam; surface it as a typed call instead.

Issue bodies sometimes sketch a shell-shaped solution under an `after_run:`
heading. Treat that as one option, not a directive.

## Build, test, and check before declaring done

- `npm run typecheck` — must pass.
- `npm test` — must pass.
- `npm run build` — must pass.

Run all three before calling `symphony.transition` into a terminal state.

## Don't write to generated state

Skip these when staging commits unless the user asks:

- `.agents/`, `.claude/`, `.impeccable/` — local tooling state.
- `issues*/Done/`, `issues*/Cancelled/`, `issues*/In Progress/` — runtime
  tracker artifacts from prior symphony runs.
- `.symphony/` — workspaces, runtime caches.
- `skills-lock.json` — auto-generated.
