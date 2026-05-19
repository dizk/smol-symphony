---
title: "Example dogfood task — add a CHANGELOG.md entry"
priority: 5
labels: [docs, example]
created_at: "2026-05-19T00:00:00Z"
---
This is the starter issue for the dogfood workflow. It exists so the orchestrator
has something to pick up on first launch and so you can confirm the end-to-end
loop (clone -> agent -> mark_done -> patch bundle) works against this repo.

Task: create a `CHANGELOG.md` at the repo root with one entry describing the MCP
+ steering work landed in the recent uncommitted changes. Look at the diff
against `main` for context; keep the entry short and factual (no marketing).

Definition of done:

- `CHANGELOG.md` exists at the repo root.
- The first entry summarizes the new symphony MCP tools (mark_done,
  request_human_steering) and the runner's loop refactor for steering replies.
- `npm run typecheck` and `npm test` still pass (they shouldn't be affected,
  but verify).
- `RESULT.md` written. `symphony.mark_done` called.

This issue is safe to delete or replace once the loop is verified.
