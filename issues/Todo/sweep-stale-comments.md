---
id: "sweep-stale-comments"
identifier: "sweep-stale-comments"
title: "Sweep stale comments and dead-reference TODOs in src/"
created_at: "2026-05-20T17:05:00.000Z"
updated_at: "2026-05-20T17:05:00.000Z"
---

Five cleanup passes just landed (Linear/acp.command/bin_path removal;
mark_done removal; legacy `states:` fallback removal; derived
active/terminal lists removal; SPEC sync + `marked_done` →
`transitioned` rename + codex_* → adapter-agnostic field rename).
Inevitably some comments now reference things that no longer exist.

## What to do

1. Grep `src/` for strings that may now be stale, including but not
   limited to:
   - `mark_done` in comments (the tool was removed; the field was
     renamed to `transitioned`).
   - `active_states` / `terminal_states` in comments (these fields
     are gone from `TrackerConfig`; the canonical map is
     `cfg.states`).
   - `Linear` (no implementation; doc-only).
   - `acp.command` (removed).
   - `bin_path` / `/opt/codex` (removed).
   - `codex_app_server_pid` / `last_codex_event` / `last_codex_*` /
     `codex_input_tokens` (fields renamed).
   - `app-server` / `Codex app-server` (we speak ACP).
   - `TRIAGE_STATE` (constant deleted; the canonical lookup is
     `pickHoldingState`).
   - `synthesizeLegacyStates` (function deleted).
   - `pickTerminalTarget` (function deleted).
2. For each stale reference: either update it to reflect current
   behavior or delete the comment outright if it's no longer useful.
3. Sweep for TODO/FIXME/XXX markers. Anything that points at work
   the refactor actually completed: delete. Anything that points at
   genuine future work: leave it but consider whether it'd be better
   as a `propose_issue` follow-up filed during a real run (don't file
   one for this issue — just flag in the run summary).
4. Sweep for "// removed" / "// dropped" / "// legacy" comments that
   describe code that's already gone. These are post-mortem noise;
   delete.

Don't touch:
- `docs/` (SPEC.md, AGENTS.md, README.md, WORKFLOW.template.md were
  swept during Cleanup 5 already; trust them).
- Test files (test descriptions can stay even if slightly aged).
- The intentional history comment in `src/types.ts` next to
  `RunningEntry.transitioned` (it's there on purpose).

## Acceptance

- A representative grep for the stale strings above returns nothing
  in `src/` other than the intentional history comment.
- `npm run typecheck` and `npm test` pass (this is comment-only;
  zero behavior change).
- The PR summary lists each category of comment cleaned up
  (one-liner per category, not a per-file dump).
