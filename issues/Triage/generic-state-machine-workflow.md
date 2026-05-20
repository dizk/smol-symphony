---
id: "generic-state-machine-workflow"
identifier: "generic-state-machine-workflow"
title: "Generic state-machine workflow: per-state model + MCP transition"
created_at: "2026-05-20T15:00:00.000Z"
updated_at: "2026-05-20T15:00:00.000Z"
---

Three pieces:

1. **`symphony.transition({ to_state, notes? })`** — MCP tool agents call to
   move an issue between states. Notes are appended to the issue body so the
   next agent (in the next state) sees them in `issue.description`.
2. **Dynamic state directories** — declared in `WORKFLOW.md`; the local
   tracker auto-creates `<root>/<StateName>/` on startup for each declared
   state.
3. **Per-state adapter + model** — each state declares which adapter and
   which model to dispatch with. Today's workflow-global `acp.adapter` /
   `acp.model` become the defaults; per-state values override.

Workspace persistence falls out for free: the per-issue workspace is already
keyed by issue identifier and survives across attempts. Moving the issue
file between state directories doesn't touch the workspace. The same
`agent/<id>` git branch persists across transitions, so a reviewer agent
sees the implementer's commits, the next implementer sees the reviewer's
findings appended to the issue body.

## Schema

```yaml
states:
  Todo:
    role: active
    adapter: claude
    model: claude-opus-4-7
    max_turns: 10
  Review:
    role: active
    adapter: codex
    model: gpt-5-codex
    max_turns: 4
    allowed_transitions: [Todo, Done]   # optional; default: any declared state
  Done:
    role: terminal
  Cancelled:
    role: terminal
  Triage:
    role: holding   # exists, never dispatched (replaces today's hardcoded Triage)
```

Roles: `active` (dispatched), `terminal` (run ends, workspace removed),
`holding` (file exists, orchestrator ignores it).

If `states:` is absent, synthesize one from the legacy
`tracker.active_states` + `tracker.terminal_states` lists — every existing
workflow keeps working unchanged.

Per-state overrides cascade onto the workflow-level `acp.*` and
`agent.max_turns` defaults. No `cleanup_workspace` flag and no per-state
`max_concurrent` in V1 — the role alone drives cleanup (terminal = remove,
otherwise keep). `allowed_transitions` is an optional per-state list; when
omitted, any declared state is reachable.

Validation: ≥1 active, ≥1 terminal; state names unique
case-insensitively; every adapter referenced by any state must be a known
profile and its host credential must be readable; every name in
`allowed_transitions` must be a declared state.

## MCP: `symphony.transition({ to_state, notes? })`

Validation and side-effects, in order:

1. Validate `to_state` exists in the current `states:` config.
2. If the current state declares `allowed_transitions`, validate that
   `to_state` is in that list.
3. Call `tracker.moveIssueToState(issueId, to_state, { fromRoot, fromState,
   notes, actor })` — the tracker appends the notes block to the issue file
   and does the atomic rename in one call (see "Tracker contract" below).
4. Set `marked_done = true` so the runner unwinds between turns.
5. Set `cleanup_workspace_on_exit = true` iff the target state has
   `role: terminal`. Active→active and active→holding moves preserve the
   workspace.
6. Log a `system` event with `from`, `to`, `notes_len`, actor,
   `cleanup` flag.

### Recoverable errors (the agent gets to retry)

`allowed_transitions` rejection and unknown-state both return MCP
**tool-result errors** — i.e. `CallToolResult` with `isError: true`,
a human-readable `text` block in `content[]`, and the structured payload
on the SDK's `structuredContent` slot. They are NOT JSON-RPC `error`
envelopes; the SDK delivers the result to the agent's tool-call site,
the agent reads it, the run continues. Per MCP 2025-06-18,
`CallToolResult.content` is `ContentBlock[]` and does not define a
`json` block type — machine-readable payloads live on `structuredContent`.

Rejected transition:

```json
{
  "isError": true,
  "content": [
    { "type": "text", "text": "transition to \"Done\" is not allowed from \"Review\". allowed: Todo" }
  ],
  "structuredContent": {
    "error": "transition_not_allowed",
    "from_state": "Review",
    "requested_to_state": "Done",
    "allowed_transitions": ["Todo"]
  }
}
```

Unknown state:

```json
{
  "isError": true,
  "content": [
    { "type": "text", "text": "state \"Reveiw\" is not declared. declared: Todo, Review, Done, Cancelled, Triage" }
  ],
  "structuredContent": {
    "error": "unknown_state",
    "declared_states": ["Todo", "Review", "Done", "Cancelled", "Triage"]
  }
}
```

In both cases: no `marked_done`, no file move, no notes append. The
agent sees the structured error and picks a valid target on its next
tool call.

## Tracker contract

`moveIssueToState` is extended to take optional `notes` and own the
append+move atomicity (the MCP layer should not be calculating file
paths — only the tracker knows where issues live). New signature:

```ts
moveIssueToState(
  issueId: string,
  toState: string,
  opts?: {
    fromRoot?: string;
    fromState?: string;
    notes?: string;     // appended before the rename
    actor?: string;     // "<adapter>/<model>" — used in the notes header
  },
): Promise<{ fromState: string; toState: string; newPath: string }>;
```

`local.ts` does:
1. Read the source file at `<fromRoot>/<fromState>/<id>.md`.
2. If `notes`, build the notes block (`## <actor> — <iso> — <from> → <to>\n\n<notes>\n`) and append; write the new body to a `<id>.md.tmp` in the same source directory, fsync, atomic-rename `<id>.md.tmp` → `<id>.md` (the same-dir rename keeps the file pre-move).
3. Atomic-rename `<fromRoot>/<fromState>/<id>.md` → `<fromRoot>/<toState>/<id>.md`.

`src/trackers/types.ts` updated to the new signature. The MCP layer
gets the simplified happy path: `tracker.moveIssueToState(...)`, then
flag-flipping on the `RunningEntry`. No filepath calculation in
`src/mcp.ts`.

`mark_done({ title, summary })` becomes
`transition({ to_state: <first terminal state>, notes: "# " + title +
"\n\n" + summary })`. The existing `mark_done.md` write under the
workspace stays — the dogfood `after_run` hook reads it for PR title/body.

`propose_issue` keeps working; its landing directory becomes "first
declared `holding` state, or literal `Triage` if none".

## Per-state adapter/model resolution

The runner today reads `cfg.acp.adapter`, `cfg.acp.model`, `cfg.acp.shell`
in several places (profile lookup, model injection, launch env) plus
`cfg.agent.max_turns` for the autonomous-loop ceiling. Wrap into a small
helper resolved once at dispatch:

```ts
function resolveDispatchConfig(cfg, state): {
  adapter: AcpAdapterId;
  model: string | null;
  max_turns: number;
} {
  const s = cfg.states[state];
  return {
    adapter: s?.adapter ?? cfg.acp.adapter,
    model:   s?.model   ?? cfg.acp.model,
    max_turns: s?.max_turns ?? cfg.agent.max_turns,
  };
}
```

Runner calls this once at the top of `dispatch`, uses the result for
adapter lookup, model injection, launch env, and the autonomous-loop
budget. No further `this.cfg.acp.adapter` / `this.cfg.agent.max_turns`
reads remain in the dispatch path.

Startup adapter-credential check (`src/orchestrator.ts:141`) iterates
over every adapter referenced by any declared state, not just
`cfg.acp.adapter`.

## Files touched

- **`src/types.ts`** — add `StateConfig`, `ServiceConfig.states`. Keep
  `active_states` / `terminal_states` as derived getters.
- **`src/workflow.ts`** — parse `states:` (with legacy fallback); validate;
  iterate per-state adapter credential check.
- **`src/trackers/types.ts`** — extend `moveIssueToState` signature with
  optional `notes` and `actor` (see Tracker contract above).
- **`src/trackers/local.ts`** — `mkdir -p` every declared state dir on
  `start()`. Read across all of them; attach state from directory name.
  `moveIssueToState` accepts any declared state and handles notes-append
  + atomic rename in one call.
- **`src/orchestrator.ts`** — eligibility uses `cfg.states[s].role`;
  startup credential check iterates per-state.
- **`src/agent/runner.ts`** — single call to `resolveDispatchConfig` at
  the top of `dispatch`, drives adapter / model / launch env / max_turns.
- **`src/mcp.ts`** — implement `transition`; rewrite `mark_done` as a
  shim; generalize `propose_issue`'s landing state. Errors returned as
  `CallToolResult { isError: true }`, not JSON-RPC error envelopes.
- **`src/bin/symphony.ts`** — wire the live `states` map into the HTTP
  tracker view and the MCP registry context; ensure the dynamic-reload
  path refreshes both.
- **`src/http.ts`** — dashboard groups issues by declared states in
  declaration order; status pill class reads from role; triage
  approve/discard / issue-creation validation accept any declared state.
- **`WORKFLOW.md`** (dogfood) — `states:` block with a `Review` state
  pointed at Codex; prompt restructured with `{% case issue.state %}`;
  `after_run` swapped from "grep Done/" to walking terminal directories.
- **`WORKFLOW.template.md`** — document the new `states:` schema.

(`src/issues.ts`'s `appendNotes` helper from the earlier draft is gone —
the tracker owns the append now.)

Per-state prompt is Liquid only — `{% case issue.state %}` already works
because `issue.state` is in scope (`src/prompt.ts:26`). No prompt-render
change.

## What we're explicitly NOT doing in V1

- **No `RunningEntry` snapshot of state config.** Workflow reloads
  mid-run are rare; `transition` validates against live config. Worst
  case is one failed tool call and a clean re-dispatch.
- **No special handling for external active→active state changes
  mid-run.** Today's reconciler updates `entry.issue` in place; we keep
  that. The agent finishes its turn under the old state's prompt; next
  dispatch (or reconciler kill) cleans up. Operators who care can mark
  the issue Cancelled and re-add it.
- **No new `extraEnv` API on hooks.** The dogfood `after_run` figures out
  the target state by scanning terminal directories on disk. The
  existing env (PWD / SYMPHONY_ISSUE_ID / etc.) is enough.
- **No `cleanup_workspace` per-state flag.** `role: terminal` ⇒ cleanup,
  otherwise keep. That's the whole policy.

These are deliberate simplifications. If a workflow reload race or an
operator-driven state shuffle actually bites in practice, add the
machinery then; don't pay for it on day one.

## Tests

- `tests/workflow.test.ts` — `states:` parsing, legacy-fallback synthesis,
  validation errors.
- `tests/local-tracker.test.ts` — auto-mkdir, reading across all declared
  states.
- `tests/orchestrator.test.ts` — eligibility under role-based model;
  per-state credential check at startup.
- `tests/mcp.test.ts` — `transition` validates target, appends notes,
  moves file; cleanup flag set correctly for terminal vs active targets;
  unknown / disallowed targets return structured errors that list
  declared states / allowed transitions, and the run continues (no
  `marked_done`, no file move).
- End-to-end: drive Todo → Review → Done and Todo → Review → Todo via
  the local tracker + MCP. Verify the same workspace and `agent/<id>`
  branch survive both flows.

## Acceptance

- Dogfood `WORKFLOW.md` uses `states:` with a `Review` state on Codex.
- Todo → Review → Done end-to-end via `symphony.transition`. `mark_done`
  still works as a compat alias.
- Todo → Review → Todo: reviewer findings land in `issue.description`;
  next Todo dispatch sees them.
- Workspace and `agent/<id>` branch survive both flows.
- `after_run` opens a PR only when the file lands in a terminal `Done`
  state.
- All existing tests pass; new tests above pass.
- Both adapters (claude, codex) dispatch under the new path.

## Related cleanup (file as separate issue)

Linear tracker is dead code: there is no `src/trackers/linear.ts`. The only
residue is `tracker.kind: 'linear'` parsing in `src/workflow.ts:143,372-375`,
a fallback prompt string in `src/prompt.ts:52`, doc comments in
`src/runlog.ts:37,124`, and Linear-flavored sections in
`WORKFLOW.template.md` / `SPEC.md`. Worth deleting in its own pass —
don't entangle with this brief.
