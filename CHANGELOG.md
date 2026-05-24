# Changelog

All notable operator-visible changes to smol-symphony are recorded here.
This project loosely follows [Keep a Changelog](https://keepachangelog.com/)
and [Semantic Versioning](https://semver.org/).

## [Unreleased]

The workflow became a state machine. A single issue can now travel through
any number of states with distinct adapters, models, and instructions, and
hand work off between them via a single MCP call.

### Added

- `pr_autopilot` workflow block (default off). When `enabled: true` the
  reconciler grows a `pr` resource that, on every tick, keeps each
  terminal-state issue's GitHub PR rebased on `origin/<base>`, arms
  `gh pr merge --auto --<strategy>`, and routes rebase conflicts back to
  the implementing state with a structured notes block (conflicted file
  list + diagnostic) appended to the issue body. After
  `max_rebase_attempts` consecutive failures the issue lands in the
  configured holding state (default `Conflict`). For issues in
  `close_state` (default `Cancelled`) with an open PR, the autopilot
  closes the PR without merge and best-effort-deletes the remote branch.
  Requires `gh` authenticated on the host AND a branch protection rule on
  the base requiring at least one check (`gh pr merge --auto` errors
  without one). When enabled, transitions into `merge_state` skip the
  standard terminal workspace cleanup — the autopilot owns the workspace
  until the PR merges or closes.
- `smolvm.smolfile` workflow key. Point it at a TOML
  [Smolfile](https://github.com/smol-machines/smolvm) and symphony hands it
  to `smolvm machine create --smolfile` for every per-issue VM. The repo
  ships a canonical `Smolfile` at the root that boots `node:24-bookworm-slim`,
  installs base CLI tooling + every ACP-capable coding agent, and
  bind-mounts `scripts/` as `/opt/symphony` so the in-VM stdio proxy at
  `/opt/symphony/vm-agent.mjs` is the same file the host pins.
- Workflows now declare states under a top-level `states:` block. Each
  state has a `role` (`active`, `terminal`, or `holding`) and optional
  per-state `adapter`, `model`, `max_turns`, and `allowed_transitions`
  overrides. Every active or terminal state can hold issues; holding
  states (e.g. `Triage`) sit outside the dispatch loop.
- New `symphony.transition({ to_state, notes })` MCP tool. The agent
  calls it to move the issue to another declared state. The `notes`
  block is appended to the issue body before the file is renamed, so
  the next state's agent reads the full handoff thread as part of
  `issue.description` on its next dispatch.
- Workflow prompts can branch on the current state with Liquid
  `{% case issue.state %}`, so one workflow can ship distinct
  instructions to (e.g.) an implementer state and a reviewer state.
- Per-state issue directories (`issues/<State>/`) are auto-created on
  startup; you no longer need to mkdir them by hand when adding a new
  state.
- Startup credential checks now iterate every adapter referenced by a
  per-state override, not just the workflow default — a typo in a
  per-state `adapter:` is caught before the first dispatch.

### Changed

- The per-issue workspace and `agent/<id>` branch now persist across
  active→active and active→holding transitions, so a reviewer state
  can pick up the implementer's diff without a re-clone. The runner
  only tears down the workspace when an issue lands in a state with
  `role: terminal`.
- Pull-request title is now `<issue-id>: <front-matter title>` and the
  body is the full issue body. Because every `transition` call
  appends a `## actor — ts — from → to` notes block to that body,
  the PR description ends up containing the entire handoff thread
  accumulated across every hop.
- The dashboard renders state columns in the order they appear in the
  workflow's `states:` map. Terminal-state issues (Done, Cancelled,
  etc.) are now sorted to the end of the main panel instead of
  hidden, so an operator can still see what landed where.
- Triage approve/discard now resolve targets from declared states:
  approve sends the issue to the first declared active state, discard
  sends it to the first terminal state whose name matches `cancelled`
  (case-insensitive) and falls back to the first declared terminal
  state otherwise.
- Snapshot API fields were renamed to drop the `codex_` prefix and
  become adapter-agnostic. If you read `/api/v1/state` directly:
  `codex_app_server_pid` → `adapter_pid`;
  `last_codex_event` / `_timestamp` / `_message` → `last_event` /
  `last_event_at` / `last_message`;
  `codex_input_tokens` / `codex_output_tokens` / `codex_total_tokens`
  → `input_tokens` / `output_tokens` / `total_tokens`;
  `codex_totals` → `session_totals`.

### Removed

- `scripts/build-vm.sh`. The Smolfile (with `smolvm.smolfile` in
  `WORKFLOW.md`) drives the per-issue VM declaratively; the imperative
  pre-pack script is no longer needed. To keep the old packed flow,
  run `smolvm pack create -s ./Smolfile -o ./.vm/symphony.smolmachine`
  once and set `smolvm.from` in `WORKFLOW.md` instead.
- `mark_done` MCP tool. Use `transition({ to_state: "<terminal>",
  notes })` instead. The `notes` block becomes the PR description,
  the same way the old `mark_done({ title, summary })` payload did.
- `mark_done.md` workspace staging file. The PR body now comes
  straight from the issue body.
- `tracker.active_states` and `tracker.terminal_states` workflow
  keys. Both are derived from `states[*].role` now. Workflows missing
  a `states:` block (or with no active, no terminal, or no holding
  state declared) fail at parse time with a clear error pointing at
  `WORKFLOW.template.md`.
- `acp.command` workflow key. The TCP bridge cannot honor a raw
  adapter command; all adapters connect through the bridge.
- `smolvm.bin_path` workflow mount. Adapter binaries are baked into
  the VM image now, so there is no host directory to bind-mount.
- Linear tracker scaffolding. No implementation ever shipped behind
  the `linear` endpoint, so the option has been dropped; the local
  Markdown tracker is the only `tracker.endpoint` value.

## [0.1.1] — 2026-05-19

- First published release on npm (`npx smol-symphony`).
