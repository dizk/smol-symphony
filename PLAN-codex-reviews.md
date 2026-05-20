# Plan: automated Codex code reviews

Status: Draft. Planning document only — nothing in this file is implemented yet.
Scope: a single feature, behind a default-off workflow flag.

## 1. Goal

When a coding agent finishes an issue (calls `symphony.mark_done`), have a
second, independent Codex-driven agent review the diff before the work is
handed off to a human. The reviewer's job is to catch the things a single-pass
implementer misses: missing tests, hidden regressions, mis-scoped changes,
security smells, drift from `SPEC.md` / `PRODUCT.md` / `DESIGN.md`.

The reviewer is **advisory**: it never gates the PR or the patch bundle. Its
output lands alongside the existing handoff artifact so the human reviewer
reads both in one place.

## 2. Non-goals

- Auto-approve or auto-merge. The reviewer comments; the human merges.
- Replacing the existing `after_run` PR/patch outputs.
- Multi-pass back-and-forth between implementer and reviewer. v1 is
  single-pass.
- Per-line inline PR review comments. v1 posts one comment body.
- Tracker support beyond what the orchestrator already ships. The reviewer
  works the same on `kind: local` and `kind: linear`; no extra plan work.

## 3. Design

### 3.1 When the reviewer runs

Two viable triggers; v1 picks **(A)** for minimum surface change. **(B)** is
the migration target if review surfaces become first-class enough to want
full dashboard treatment.

- **(A) Inline at end of `after_run`, in a fresh smolvm.** The host hook that
  already produces the PR or patch bundle invokes a second smolvm boot with
  `codex-acp`, mounts the same per-issue workspace, hands the reviewer the
  diff range, lets it write a review artifact, then attaches that artifact to
  the PR or sibling-patch slot.
  - Pros: zero changes to the orchestrator's poll/dispatch loop; reviewer
    reuses the existing credential-staging path via `acp.adapter: codex`;
    review and handoff are atomic from the operator's perspective.
  - Cons: the reviewer's runtime is invisible to the dashboard; failures
    surface only in the host shell log of the hook.

- **(B) Separate symphony pass — review as its own pseudo-issue.** A
  successful `mark_done` would enqueue a `Review` state for the same issue
  id; the orchestrator dispatches it like any other issue, with a workflow
  whose adapter is `codex`.
  - Pros: full dashboard visibility, retry, concurrency budget, structured
    logs.
  - Cons: requires a new tracker state and orchestrator special-cases;
    couples reviewer cost to `agent.max_concurrent_agents`; harder to
    bootstrap.

### 3.2 Reviewer container

- **Adapter**: `codex` (binary `codex-acp`, host credential
  `~/.codex/auth.json` — already in `src/agent/adapters.ts`).
- **VM image**: the existing `.vm/symphony.smolmachine.smolmachine` from
  `scripts/build-vm.sh`. It already ships `codex-acp`, so no rebuild needed.
- **Workspace mount**: the implementer's per-issue workspace, so the reviewer
  sees both the original base branch and the agent's `agent/<id>` branch
  with full history.
- **Network creds**: none. Reviewer relies on `OPENAI_API_KEY` already in
  `smolvm.forward_env`.
- **MCP scope**: same per-issue MCP bearer as the implementer. The reviewer
  is expected to call exactly one new tool — see §3.5.

### 3.3 Reviewer prompt

Liquid-templated, parallel to the existing implementer prompt body in
`WORKFLOW.md`. The reviewer is told, in order:

1. It is reviewing the diff `MERGE_BASE..agent/<id>` against the issue text
   (passed verbatim) and the implementer's `mark_done` summary (also passed
   verbatim, read from `.git/symphony-runtime/mark_done.md`).
2. It must not edit files. The high-trust posture from SPEC §10.5 is
   unchanged; this is policy in the prompt, not enforcement.
3. It must call `symphony.submit_review({ verdict, body })` exactly once and
   stop. Verdicts: `approve`, `comment`, `request_changes`.
4. Turn budget is small (default 3 turns; see §3.6). Most reviews should
   finish in one turn.

### 3.4 Output sinks

The `after_run` hook routes the review based on the same `SYMPHONY_REPO`
signal it already uses to choose PR-vs-patch mode:

| Handoff mode  | Implementer artifact                          | Reviewer artifact                                                 |
| ------------- | --------------------------------------------- | ----------------------------------------------------------------- |
| Patch bundle  | `.symphony/patches/agent_<id>.patch`          | `.symphony/patches/agent_<id>.review.md` (sibling of the patch)   |
| Pull request  | `gh pr create` output                         | `gh pr comment --body-file <review.md>` on the just-created PR    |

The first line of the review artifact is the verdict header, e.g.
`# review: request_changes — <issue-id>`, so a grep across
`.symphony/patches/` answers "which reviews flagged anything?" without
opening files.

### 3.5 New MCP tool: `symphony.submit_review`

Add a third tool alongside `mark_done` and `request_human_steering` in
`src/mcp.ts`:

- **Schema**:
  - `verdict`: `'approve' | 'comment' | 'request_changes'` (required)
  - `body`: string (required, markdown)
- **Effect**: writes `<workspace>/.git/symphony-runtime/review.md` (or
  `<workspace>/.symphony-runtime/review.md` when the workspace has no
  `.git/`), with content `# review: <verdict> — <id>\n\n<body>\n`.
- **Routing**: the `after_run` hook reads this file the same way it already
  reads `mark_done.md` and sends it to the right sink.
- **Idempotency**: `submit_review` overwrites. Calling twice in a turn is
  fine; the last write wins.
- **Empty-review fallback**: if the reviewer session ends without calling
  `submit_review`, the hook writes a stub
  (`# review: comment — <id>\n\nreviewer produced no output\n`) so the
  operator always sees something land. The stub never blocks anything.
- **No state transition.** Unlike `mark_done`, `submit_review` does not move
  the issue file. The issue is already in `Done/` by the time the reviewer
  runs.

### 3.6 Configuration

`WORKFLOW.md` gains a new top-level `review:` section. Defaults preserve
today's behavior (reviewer disabled).

```yaml
review:
  # When false, the reviewer step is skipped. Default: false.
  enabled: true
  # Adapter used for the reviewer. Default: 'codex'. Any adapter in
  # src/agent/adapters.ts is allowed.
  adapter: codex
  # Turn budget for the reviewer; lower than agent.max_turns on purpose.
  # Default: 3.
  max_turns: 3
  # smolvm image for the reviewer VM. Defaults to smolvm.from so a single
  # built image covers both roles.
  vm: ./.vm/symphony.smolmachine.smolmachine
```

Per `AGENTS.md`, **`WORKFLOW.template.md` MUST be updated in the same commit
that introduces `review:`**, with the section, its keys, types, defaults,
and an example.

### 3.7 Trust posture

- The reviewer never holds `gh` auth. PR comments are posted from the host,
  using the operator's existing `gh` session, after the VM exits. The token
  never enters the reviewer VM, same rule as the implementer.
- Remotes are already stripped inside the VM by `hooks.after_create`. The
  reviewer can read the branch but cannot push.
- The reviewer's MCP scope is bound to the same issue id as the implementer.
  There is no cross-issue read path.
- Token cost is operator-borne. The reviewer counts against `OPENAI_API_KEY`
  quota and shows up in the codex adapter's `usage_update` stream.

## 4. Implementation phases

Each phase is one PR.

1. **MCP tool.** Add `submit_review` to `src/mcp.ts` and unit tests in
   `tests/mcp.test.ts`. No behavior change for existing workflows; the tool
   is registered but never invoked unless a workflow wires it in.
2. **`after_run` reviewer step.** Update the shipped `WORKFLOW.md`
   `after_run` hook to (a) check `SYMPHONY_REVIEW_ENABLED`, (b) launch a
   second smolvm with `codex-acp` against the same workspace, (c) read
   `review.md` and route it to either a PR comment or a sibling patch file.
   Update `WORKFLOW.template.md` to document `review:`.
3. **Orchestrator wiring.** Parse `review:` into `ServiceConfig`
   (`src/workflow.ts`, `src/types.ts`). Plumb the chosen knobs to the hook
   via env (`SYMPHONY_REVIEW_ENABLED`, `SYMPHONY_REVIEW_ADAPTER`,
   `SYMPHONY_REVIEW_MAX_TURNS`, `SYMPHONY_REVIEW_VM`). Add parser tests in
   `tests/workflow.test.ts`.
4. **Dashboard surface.** Decide pill-or-annotation (see §5 Q1) and ship.
5. **Linear parity smoke.** Verify the path works against `kind: linear`.
   No code changes expected; one e2e run.

## 5. Open questions

1. **Pill or no pill?** `DESIGN.md` §2 names a "Three-Pill Rule" that
   forbids a fourth status pill. Either we (a) name a fourth state and
   amend `DESIGN.md`, or (b) render the review as an annotation under the
   implementer's row without its own pill. Needs product sign-off before
   Phase 4 starts.
2. **`request_changes` semantics.** Does `request_changes` *block* PR
   creation, or only annotate? v1 says annotate-only. Operators who want a
   hard gate can read the verdict line from the review file in a wrapper.
3. **Iteration loop.** Should the implementer ever see the review and get a
   chance to fix it? v1 says no (single-pass). v2 could re-enqueue the
   implementer's issue with the review attached as `attempt 2` context.
4. **Reviewer adapter.** The issue title says "codex code reviews".
   Confirm: always Codex, or operator-selectable (recommended: selectable,
   default `codex`)?
5. **Turn budget default.** `review.max_turns: 3` gives the reviewer room
   to read files before committing to a verdict. `1` forces a single-turn
   verdict and bounds cost more tightly. Pick based on observed
   first-week-of-use cost.

## 6. Test plan (for the implementation issues)

- `tests/mcp.test.ts` — `submit_review` writes the expected file, validates
  the `verdict` enum, idempotent overwrite, falls back when called with an
  empty body.
- `tests/workflow.test.ts` — `review:` parses with the right defaults,
  rejects unknown adapters, rejects non-positive `max_turns`.
- Manual smoke: run symphony against a trivial issue ("add a comment to
  `src/types.ts`"), verify that `.symphony/patches/agent_<id>.review.md`
  appears with a non-empty body and a valid verdict header.

## 7. Migration and rollback

`review.enabled` defaults to `false`. Operators opt in per workflow file.
To roll back, set `review.enabled: false` or delete the `review:` block;
the existing handoff path is unchanged. No on-disk migrations.
