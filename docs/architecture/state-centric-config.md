# State-centric workflow config — generalisation proposal

Status: 2026-05-31 — written for issue 135. No code changes; this file is a
prioritised intake list of draftable issues. The reviewer of this PR is asked to
sanity-check the proposal and, on approval, file each candidate below as an
individual `symphony.propose_issue` call (see "For the reviewer" at the end).

## Why

`WORKFLOW.md` has grown a top-level block per feature: `hooks:`, `agent:`,
`pr_autopilot:`, `sleep_cycle:`. Three of those four exist only to attach
behaviour *to a state*, and each does it by naming the state as a string and
then re-validating that state's role at parse time:

- `pr_autopilot:` names `merge_state` / `close_state` / `conflict_route_to` and
  re-checks each is terminal/terminal/active (`validatePrAutopilot`,
  `src/workflow.ts:824`).
- `sleep_cycle:` names `dormant_state` / `reflect_state` and re-checks
  holding/active (`validateSleepCycle`, `src/workflow.ts:789`).
- `hooks:` has a whole second copy of itself — the per-state `hooks:` override
  block — plus `resolveHooksForState` / `parseStateHooksBlock` /
  `findHooksAndActionsConflicts` to reconcile the two
  (`src/workflow.ts:559–741`).

This is the bloat the issue calls out. The state already owns `role`, `adapter`,
`model`, `effort`, `max_turns`, `allowed_transitions`, `actions`, `eval_mode`.
The fix is a single principle, applied four times:

> **A behaviour that is *about a state* lives *on the state*. Top-level blocks
> are reserved for genuinely host-global, cross-state concerns.**

Co-locating behaviour with its state removes the name-reference indirection and
the role re-validation (the state's own declared `role` is already authoritative),
and it shrinks the surface an operator has to learn from "states plus four
feature blocks" to "states, plus a short list of host knobs."

## Target shape

Today (abridged — the shipped `WORKFLOW.md`):

```yaml
states:
  Todo:    { role: active, adapter: claude, model: ..., max_turns: 10 }
  Review:  { role: active, adapter: codex,  max_turns: 6, allowed_transitions: [Todo, Done] }
  Reflect: { role: active, adapter: claude, max_turns: 20, eval_mode: true, allowed_transitions: [Dormant] }
  Done:    { role: terminal, actions: [ push_branch, create_pr_if_missing ] }
  Cancelled: { role: terminal }
  Triage:  { role: holding }
  Dormant: { role: holding }

pr_autopilot:
  enabled: true
  merge_state: Done
  close_state: Cancelled
  conflict_route_to: Todo
  auto_merge_strategy: squash
  poll_interval_ms: 30000

sleep_cycle:
  enabled: true
  issue_id: sleep-cycle
  dormant_state: Dormant
  reflect_state: Reflect
  arm_on_idle: true
  arm_after_done: 10

hooks:
  timeout_ms: 120000      # the only field the shipped workflow sets

agent:
  max_concurrent_agents: 1
  max_turns: 6
  max_retry_backoff_ms: 120000
  # max_concurrent_agents_by_state: { Todo: 1 }   # documented, by-name map
```

Target:

```yaml
states:
  Todo:
    role: active
    adapter: claude
    model: claude-opus-4-8[1m]
    max_turns: 10
    max_concurrent: 1                       # ← was agent.max_concurrent_agents_by_state.Todo
  Review:
    role: active
    adapter: codex
    max_turns: 6
    allowed_transitions: [Todo, Done]
  Reflect:
    role: active
    adapter: claude
    model: claude-opus-4-8[1m]
    max_turns: 20
    eval_mode: true
    allowed_transitions: [Dormant]
    arm:                                     # ← was top-level sleep_cycle:
      issue: sleep-cycle
      from: Dormant
      on_idle: true
      after_terminal: 10
  Done:
    role: terminal
    actions:                                 # ← already typed; hooks: deleted everywhere else
      - { kind: push_branch, remote: origin, ref: $branch, if: $repo }
      - { kind: create_pr_if_missing, base: $base_branch, head: $branch,
          title_from: $pr_title, body_from: $pr_body_file, if: $repo }
    pr:                                      # ← was pr_autopilot routing fields
      auto_merge: squash
      on_conflict: { route_to: Todo }
  Cancelled:
    role: terminal
    pr: { close: true }                      # ← was pr_autopilot.close_state
  Triage:  { role: holding }
  Dormant: { role: holding }

# top-level blocks that REMAIN — genuinely host-global / cross-state:
pr:                                          # engine toggle only (rename of pr_autopilot)
  enabled: true
  poll_interval_ms: 30000
agent:
  max_concurrent_agents: 1                   # global host ceiling (memory-admission clamps THIS)
  max_turns: 6                               # workflow-wide default; states override
  max_retry_backoff_ms: 120000
  circuit_breaker_threshold: 5
# hooks:        ← deleted (typed `actions:` is the only glue mechanism)
# sleep_cycle:  ← deleted (folded into states.Reflect.arm)
```

Net: `hooks:` and `sleep_cycle:` disappear from the top level, `pr_autopilot:`
shrinks to a two-field engine toggle, and the four role re-validators collapse to
zero.

### What stays top-level, and why

Not everything belongs on a state. These are host-global or cross-state and stay
where they are: `tracker`, `polling`, `workspace`, `logs`, `acp` (transport +
timeouts), `gondolin` (image / cpus / mem), `egress`, `server`, `mcp`,
`credentials`, and a slimmed `agent` (the global concurrency *ceiling* that
memory admission clamps, the workflow-wide `max_turns` default, retry backoff,
circuit breaker, memory admission). `max_concurrent_agents` is genuinely
cross-state — it bounds total host RAM across every VM at once — so it stays as a
ceiling even after per-state caps land.

## Migration policy (applies to every candidate)

The parser ignores unknown keys, so *adding* per-state keys is backward
compatible. *Relocating* a top-level block is a breaking change for any external
workflow. Standard mitigation, used by every candidate below:

1. Land the new per-state shape and make the runtime read it.
2. Keep reading the old top-level block for one release, emit a single
   startup `log.warn` naming the moved keys, and fold its values into the new
   shape (old + new merge; new wins on conflict).
3. Remove the old block + its validators in a follow-up once the dogfooding
   `WORKFLOW.md` and `WORKFLOW.template.md` are migrated.

Per `AGENTS.md`, the shipped `WORKFLOW.md` and `WORKFLOW.template.md` must be
migrated in the **same** PR as each change, and `SPEC.md` sections updated to
match. Each candidate's `allowed_paths` includes them.

## Relationship to the LOC-reduction survey (issue 107)

`docs/architecture/loc-reduction-survey.md` already proposes retiring the
`hooks:` surface (its #1 + #2, ~700 + ~80 LOC). **Candidate B below is the same
work, framed state-first** — file whichever the operator prefers, not both. The
survey's other items (generate `WORKFLOW.md` from the template; drop unused
action kinds; the `pr_autopilot.close_state` three-state knob, which Candidate C
subsumes) are independent and out of scope here.

## Prioritised summary

Ordered by (value ÷ risk). Risk: L (low), M (medium).

| # | Candidate                                                        | Risk | Order               |
| - | ---------------------------------------------------------------- | ---- | ------------------- |
| A | Per-state concurrency (`states.<name>.max_concurrent`)           | L    | first (warm-up)     |
| B | Retire `hooks:`; typed `actions:` is the only glue mechanism     | M    | independent         |
| C | Fold PR auto-merge routing onto states (`states.<name>.pr`)      | M    | independent         |
| D | Fold sleep-cycle auto-arm onto the active state (`.arm`)         | M    | independent         |
| E | (optional) Lifecycle-triggered actions (`on: before_remove` …)   | M    | only if B leaves a gap |

A, C, and D each delete one role re-validator and shrink/remove one top-level
block. B is the biggest single simplification. They are independent (no shared
files beyond the parser and the two doc files) and can land in any order; A is
listed first only because it is the smallest and lowest-risk way to establish the
"this knob now lives on the state" pattern the others follow.

---

## Candidate A — Per-state concurrency (`states.<name>.max_concurrent`)

**Problem.** The issue says "agent — concurrency and turn budget should be a part
of state." Turn budget already is: `states.<name>.max_turns` overrides the
workflow-wide `agent.max_turns` default. Concurrency is the asymmetric half — it
lives in a top-level by-name map, `agent.max_concurrent_agents_by_state`
(`src/types.ts:138`, parsed at `src/workflow.ts:260`, consumed at
`src/orchestrator.ts:675` `hasPerStateSlot`). That map names states as strings,
duplicating information the `states:` block already owns.

**Change.**
- Add `max_concurrent?: number` to `StateConfig` (`src/types.ts:61`) and parse it
  in `parseStatesBlock` (`src/workflow.ts:488`), reusing the positive-int
  validation pattern already used for `max_turns`.
- `Orchestrator.hasPerStateSlot` (`src/orchestrator.ts:675`) reads
  `cfg.states[name].max_concurrent` instead of
  `cfg.agent.max_concurrent_agents_by_state[name]`. The continuation-slot
  accounting (`src/orchestrator.ts:685–689`) is unchanged.
- Keep `agent.max_concurrent_agents` as the **global host ceiling** — it is the
  cross-state RAM bound that `computeAdmission` / `computeMemoryAdmission`
  (`src/orchestrator.ts:635`) clamps. Validate that the sum of per-state
  `max_concurrent` does not exceed it (mirrors the existing implicit contract
  noted in `WORKFLOW.template.md:585`).
- Migration: keep reading `agent.max_concurrent_agents_by_state` for one release
  with a deprecation `log.warn`, folding its entries into the per-state caps
  (per-state `max_concurrent` wins on conflict).

**allowed_paths.** `src/types.ts`, `src/workflow.ts`, `src/orchestrator.ts`,
`tests/workflow.test.ts`, `tests/orchestrator.test.ts`,
`tests/orchestrator-decisions.test.ts`, `WORKFLOW.md`, `WORKFLOW.template.md`,
`SPEC.md`.

**Acceptance.** `npm run typecheck`, `npm test`, `npm run lint:arch`,
`npm run lint` green. New tests: a state-level `max_concurrent` caps that state's
running set; the global ceiling still binds; the deprecated by-state map still
works with a warning. `WORKFLOW.template.md`'s `states:` and `agent:` sections
document the move; the shipped `WORKFLOW.md` uses `states.Todo.max_concurrent`.

**Risk.** **Low.** Additive new key; the by-name map is preserved one release;
the change is a single read-site swap plus a validator.

**Dependencies.** None. Establishes the per-state-knob pattern.

**Note.** Whether to *also* drop the workflow-wide `agent.max_turns` default (so
every state must declare its own budget) is a deliberate non-goal here: the
default is a DRY convenience for single-state workflows. Flag it for the operator
but do not remove it in this candidate.

---

## Candidate B — Retire `hooks:`; typed `actions:` is the only glue mechanism

**Problem.** The issue says "I also want hooks gone -> should just be actions on
states." There are two parallel glue systems: shell `hooks:`
(`after_create` / `before_run` / `before_remove` / `timeout_ms`, plus a per-state
override copy) and the typed `actions:` DAG (`src/actions/types.ts`). `actions:`
already won — a state declaring both runs `actions:` and ignores `hooks:` with a
deprecation warning (`findHooksAndActionsConflicts`, `src/workflow.ts:705`) — and
the shipped `WORKFLOW.md` declares **zero** hooks. The hook surface is pure
maintenance tax: config parsing (`parseStateHooksBlock`, `resolveHooksForState`),
runtime threading through the runner and `WorkspaceManager`, and four-channel test
coverage.

**Change.** Delete the workflow-level and per-state `hooks:` surface end-to-end:
`HooksConfig` / `StateHooksConfig` and the `hooks?` field on `StateConfig`
(`src/types.ts:44,73,126`); `parseStateHooksBlock` / `resolveHooksForState` /
`findHooksAndActionsConflicts` / `warnOnHooksAndActionsConflict` and the `hooks`
block in `buildServiceConfig` (`src/workflow.ts`); the hook lifecycle in
`src/workspace.ts` (`runBeforeRun`, `runAfterRunBestEffort`, the `before_remove`
branch in `remove()`) and `src/agent/runner.ts`; the `resolveHooksForState` call
in `scheduleWorkspaceCleanup` (`src/orchestrator.ts:1187`). The work those
lifecycle points genuinely do already has typed homes: the canonical
clone/branch/remote setup is `setupWorkspaceDir` (`src/workspace.ts`), the
post-attempt PR push/open is the Done state's `actions:` block, per-VM tooling is
baked into the agent image (`images/agents/`), and arbitrary in-sandbox commands
are `run_in_vm`. This is the same scope as the LOC survey's #1 + #2 (~780 LOC);
see that doc for the exhaustive call-site list.

**allowed_paths.** `src/types.ts`, `src/workflow.ts`, `src/workspace.ts`,
`src/workspace-types.ts`, `src/agent/runner.ts`, `src/agent/runner-decisions.ts`,
`src/orchestrator.ts`, `src/bin/symphony.ts`, the `tests/` files that reference
hooks (`workflow`, `workspace`, `orchestrator`, plus any `runner-hook-env`),
`WORKFLOW.md`, `WORKFLOW.template.md`, `SPEC.md`
(§4.3.4 / §5.4 / §4.3.7).

**Acceptance.** `npm run typecheck`, `npm test`, `npm run lint:arch`,
`npm run lint` green with the hook tests deleted, not skipped. No `hooks`
identifier survives in `src/` outside a CHANGELOG/migration note. `WORKFLOW.md`,
`WORKFLOW.template.md`, and `SPEC.md` carry no `hooks:` block. CHANGELOG notes the
breaking removal and points external workflows at `actions:` / the agent image.

**Risk.** **Medium.** Breaking for any external workflow that wired a custom
shell hook; the replacement (`actions:` / image bake) already exists, so it is a
migration cost, not a feature loss. See LOC survey #1 "Risk" for the subtle
`setupWorkspaceDir`-owns-the-contract point.

**Dependencies.** None for the deletion. If a real workflow later needs
pre-attempt or pre-removal glue with no typed home, that is Candidate E — do
**not** build E speculatively as part of this candidate.

---

## Candidate C — Fold PR auto-merge routing onto states (`states.<name>.pr`)

**Problem.** `pr_autopilot:` is a top-level block whose substance is three state
names (`merge_state` / `close_state` / `conflict_route_to`) plus their role
re-validation (`validatePrAutopilot`, `src/workflow.ts:824`). The state that
*means* "merge this issue's PR" is the place that knowledge belongs; naming it by
string from a sibling block is the indirection the issue wants gone.

**Change.**
- Add an optional `pr?` field to `StateConfig`: on a terminal state,
  `pr: { auto_merge: squash|merge|rebase, on_conflict: { route_to: <state> } }`
  (the merge state) or `pr: { close: true }` (the close state). Reuse the
  `actions` `on_conflict: { route_to }` vocabulary (`src/actions/types.ts:114`)
  for consistency.
- Keep a slim host-global engine toggle. Rename `pr_autopilot:` →
  `pr: { enabled, poll_interval_ms }` (the reconciler resource switch +
  per-PR `gh pr view` cache TTL). `auto_merge_strategy` moves onto the merge
  state's `pr.auto_merge`; `merge_state` / `close_state` / `conflict_route_to`
  are derived by scanning `states:` for the `pr:` field instead of named strings.
- `Reconciler.buildPrResource` (`src/reconciler/index.ts:205`) and the
  orchestrator's `prIntended` provider (`src/orchestrator.ts:1371`) read the
  merge/close/route targets and strategy from the per-state `pr:` config.
  `validatePrAutopilot` deletes outright — the state's own `role` is
  authoritative, so "merge_state must be terminal" becomes structurally true.
- `classifyPrIntent` (`src/orchestrator-decisions.ts:349`) keys off which state
  carries `pr:` rather than the two named-string fields.
- This subsumes LOC survey #8 (the `close_state` "null disables" three-state
  knob): "no close behaviour" becomes "no terminal state declares `pr.close`."

**allowed_paths.** `src/types.ts`, `src/workflow.ts`, `src/orchestrator.ts`,
`src/orchestrator-decisions.ts`, `src/reconciler/index.ts`,
`src/reconciler/pr.ts`, `src/reconciler/pr-decide.ts`, the matching `tests/`
(`workflow`, `reconciler-pr`, `orchestrator-decisions`, `reconciler`),
`WORKFLOW.md`, `WORKFLOW.template.md`, `SPEC.md`.

**Acceptance.** `npm run typecheck`, `npm test`, `npm run lint:arch`,
`npm run lint` green. New tests: a terminal state with `pr.auto_merge` arms
auto-merge; `pr.close` closes; `on_conflict.route_to` routes; an undeclared
route target is rejected at parse time with a clear error. `WORKFLOW.md` migrated
to `states.Done.pr` / `states.Cancelled.pr` + a two-field top-level `pr:`.

**Risk.** **Medium.** Touches the PR reconciler resource lifecycle (the survey
flags this lifecycle as the one to be careful around). Keep the reconciler's
workspace-ownership semantics (merge-state transitions defer cleanup,
`src/orchestrator.ts:1362`) identical — only the *source* of the config moves.
Migration: parse the legacy `pr_autopilot:` block one release with a warning.

**Dependencies.** Independent. Lands cleaner after B (fewer state-config moving
parts), but does not require it.

---

## Candidate D — Fold sleep-cycle auto-arm onto the active state (`states.<name>.arm`)

**Problem.** The issue's headline: "make STATES model … sleep cycles." Today the
sleep cycle is a top-level `sleep_cycle:` block that names `dormant_state` /
`reflect_state` / `issue_id` and re-validates their roles (`validateSleepCycle`,
`src/workflow.ts:789`). It is also special-cased to *reflection* — but the
underlying mechanism ("auto-enter this active state from a holding resting place
when idle / after N terminal transitions") is general.

**Change.**
- Add an optional `arm?` field to an **active** `StateConfig`:
  `arm: { issue: <id>, from: <holding-state>, on_idle: bool, after_terminal: int }`.
  Declared on the state the issue is armed *into* (e.g. `Reflect`), with `from`
  the holding state it rests in (e.g. `Dormant`).
- `Orchestrator.maybeArmSleepCycle` / `armReflection`
  (`src/orchestrator.ts:1085,1115`) read the trigger from the armed state's `arm:`
  config rather than `cfg.sleep_cycle`. `decideSleepCycleArm`
  (`src/orchestrator-decisions.ts:309`) stays a pure decision over the same
  inputs (idle, doneSinceReflect, on_idle, after_terminal). `recordSleepCycleProgress`
  (`src/orchestrator.ts:1070`) counts terminal transitions as today.
- `validateSleepCycle` deletes — the armed state's `role: active` and the
  `from` state's `role: holding` are authoritative from the `states:` block.
- Generalisation: nothing here is reflection-specific, so a workflow can arm any
  active state from any holding state. Keep the existing guardrail that arming
  only *moves the issue* — proposals it then files still land in Triage behind the
  human gate.
- Migration: parse the legacy `sleep_cycle:` block one release with a warning
  that maps `dormant_state`→`from`, `reflect_state`→the state carrying `arm:`,
  `arm_on_idle`→`on_idle`, `arm_after_done`→`after_terminal`.

**allowed_paths.** `src/types.ts`, `src/workflow.ts`, `src/orchestrator.ts`,
`src/orchestrator-decisions.ts`, the matching `tests/` (`workflow`,
`orchestrator`, `orchestrator-decisions`, `reflect-state`), `WORKFLOW.md`,
`WORKFLOW.template.md`, `SPEC.md`.

**Acceptance.** `npm run typecheck`, `npm test`, `npm run lint:arch`,
`npm run lint` green. New tests: an active state with `arm.on_idle` arms its
`from`-state issue on idle (with ≥1 terminal since last run); `after_terminal`
arms after N; the counter resets on arm; arming a non-`from` state is a no-op.
`WORKFLOW.md` migrated to `states.Reflect.arm`; `WORKFLOW.template.md`'s SLEEP
CYCLE section rewritten around the per-state trigger.

**Risk.** **Medium.** The arming loop is the self-modifying sleep cycle; preserve
every existing guardrail (only moves into the armed state; Triage gate intact;
idle "≥1 terminal since last run" gate to avoid a tight re-arm loop).

**Dependencies.** Independent.

---

## Candidate E — (optional) Lifecycle-triggered actions

**Problem / when to file.** Candidate B deletes `hooks:` on the premise that
every lifecycle point already has a typed home. If, while doing B, an implementer
finds a *real* workflow need for pre-attempt or pre-removal glue that neither
`setupWorkspaceDir`, the Done `actions:` block, the agent image, nor `run_in_vm`
covers, that gap — and only then — justifies this candidate. File it as a
follow-up from B, not speculatively.

**Change (sketch).** Add an `on?: 'enter' | 'create' | 'before_run' |
'before_remove'` discriminator to `BaseAction` (`src/actions/types.ts:64`),
defaulting to `enter` (the current transition-into-state semantics). The executor
gains trigger-filtered passes at the matching lifecycle points. This makes
`actions:` the single, typed, state-attached mechanism for *all* glue — the full
realisation of "hooks gone -> actions on states" — without a parallel shell
surface.

**Risk.** **Medium.** Net-new execution points; only worth its weight against a
concrete need. Default-off (`on: enter`) keeps every existing `actions:` block
behaving identically.

**Dependencies.** Follows B.

---

## For the reviewer

If you approve this proposal, **before** transitioning to `Done`, file each
candidate as its own `symphony.propose_issue` call (one per candidate — Triage is
per-item, and batching forces an all-or-nothing operator decision). Suggested
shape per call:

- `title`: e.g. "Per-state concurrency cap (states.<name>.max_concurrent)".
- `description`: lift the candidate's **Problem / Change / allowed_paths /
  Acceptance** verbatim (that is the four-section body shape `AGENTS.md`
  prescribes for this tracker). Add a one-line link back to this doc
  (`docs/architecture/state-centric-config.md`) for the shared north-star and
  migration policy.
- `labels`: `["refactor"]` (Candidate B may also warrant `["breaking"]`).
- `priority`: A = 2, B = 2, C = 3, D = 3; E only if B surfaces the gap.

This issue (135) is recorded automatically as each proposal's parent — do not
paste it into the bodies. File A–D; file E only if you judge the speculative
trigger system worth queuing now (the recommendation is to defer it). Then
approve by transitioning to `Done`.

If you instead find the proposal wrong or incomplete, transition back to `Todo`
with specific findings rather than filing anything.
