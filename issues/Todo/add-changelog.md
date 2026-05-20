---
id: "add-changelog"
identifier: "add-changelog"
title: "Add CHANGELOG.md covering the state-machine refactor"
created_at: "2026-05-20T17:00:00.000Z"
updated_at: "2026-05-20T17:00:00.000Z"
---

There's no `CHANGELOG.md` in the repo. We just landed a 11-commit
refactor (state-machine workflow + 5 dead-code cleanup passes + a
field rename) that materially changes how symphony works for any
operator who runs it. We need a changelog so the next time someone
runs `npx smol-symphony` they can see what's new since 0.1.1.

## What to do

1. Read `git log --oneline v0.1.1..HEAD` and the README to understand
   what landed. The phase commit messages are detailed; lean on them
   rather than re-deriving from diffs.
2. Create `CHANGELOG.md` at the repo root following the
   keepachangelog.com format (loosely — no need to be religious about
   it). Entries should describe operator-visible behavior changes,
   not implementation details.
3. Add an `[Unreleased]` section with the state-machine refactor
   covered under headers `### Added`, `### Changed`, `### Removed`,
   `### Fixed` where appropriate. Things to mention (not exhaustive):
   - **Added**: `states:` block in `WORKFLOW.md` with per-state
     `role` / `adapter` / `model` / `max_turns` /
     `allowed_transitions`. Roles `active`, `terminal`, `holding`.
     `symphony.transition` MCP tool. Per-state directory auto-mkdir.
   - **Changed**: workspace persists across active→active and
     active→holding state transitions; cleanup only on transition to
     a `terminal` role. PR title now derived from issue front-matter
     `title:`; PR body is the whole issue body (which contains every
     transition's notes block accumulated across hops).
   - **Removed**: `mark_done` MCP tool (replaced by
     `transition({ to_state: "<terminal>", notes })`). `mark_done.md`
     workspace staging file. `tracker.active_states` /
     `tracker.terminal_states` lists (derived from `states[*].role`
     now). `acp.command` config field. `smolvm.bin_path` mount.
     Linear tracker scaffolding (it never had an implementation).
   - **Renamed**: `codex_app_server_pid`/`last_codex_*`/`codex_*_tokens`
     fields on the snapshot API to adapter-agnostic names
     (`adapter_pid`, `last_event`, `input_tokens`, etc.). The
     `codex_totals` snapshot field is now `session_totals`.
4. Above the `[Unreleased]` section, add a `[0.1.1]` section with a
   one-line "first published release" entry (use the existing
   `v0.1.1` git tag's date).

## Style

- Operator-facing. No file paths, no function names. "You can now…",
  "The hook receives…", etc.
- One bullet per behavior change. Group under the keep-a-changelog
  headers. Skip empty headers.
- Don't restate the SPEC. The changelog is "what changed", not "how
  it works"; if a reader wants the how, they read SPEC.md or
  WORKFLOW.template.md.

## Acceptance

- `CHANGELOG.md` exists at the repo root.
- All four refactor concerns (states block, transition tool,
  removed surface, renamed fields) are visible to a reader who only
  reads the changelog.
- The dogfood `WORKFLOW.md` continues to parse + validate cleanly
  (this issue should not touch it).
- `npm run typecheck` and `npm test` still pass (no code changes
  expected; this is doc-only).
