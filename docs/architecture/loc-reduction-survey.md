# Architectural LOC-reduction survey

Status: 2026-05-28 — written for issue 107. No code changes; this file is a
prioritized intake list the operator can file as individual implementation
issues. Numbers are estimates from `wc -l` and grep accounting of the modules
involved, not from a real `git diff --stat`. Each candidate names the modules
it touches so a follow-up sizing pass can refine.

## Prioritized summary

Sorted by (estimated LOC removed) ÷ (risk). The "Net LOC" column already
discounts replacement code where one exists (typed actions, etc.). Letter
risks: L (low), M (medium), H (high).

| # | Candidate                                                             | Net LOC | Risk | Order              |
| - | --------------------------------------------------------------------- | ------- | ---- | ------------------ |
| 1 | Retire the `hooks:` surface end-to-end (config + runtime + tests)     | ~700    | M    | depends on #2      |
| 2 | Inline the after_run path into a Done-state `actions:` block          | ~80     | L    | unblocks #1        |
| 3 | Generate `WORKFLOW.md` from `WORKFLOW.template.md` (or vice versa)    | ~250    | M    | independent        |
| 4 | Drop unused action kinds (`merge`, `ensure_branch`, `checkout`, …)    | ~250    | L    | independent        |
| 5 | Collapse `src/workspace.ts`'s `runHookScript` wrapper                  | ~30     | L    | trivial            |
| 6 | Collapse `HookCapture` / `HookResult` re-exports                       | ~25     | L    | trivial            |
| 7 | Inline single-caller `util/crypto.ts` + `util/fs-issues.ts` ports     | ~50     | L    | independent        |
| 8 | Drop `pr_autopilot.close_state` "null disables" three-state knob       | ~25     | M    | independent        |

Items 1, 2, 4, 5, 6 together approach a one-thousand-LOC swing on the
implementer/runner half of the codebase without touching any feature an
operator actually uses today (the shipped `WORKFLOW.md` already declares zero
hooks). Items 3, 7, 8 are independent cleanups.

## Candidates

### 1. Retire the `hooks:` surface end-to-end

**Where:**
- `src/types.ts` — `HooksConfig`, `StateHooksConfig`, the `hooks?` field on
  `StateConfig`, the `hooks` field on `ServiceConfig` (~30 lines).
- `src/workflow.ts` — `parseStateHooksBlock` (~35 lines), `resolveHooksForState`
  (~30 lines), `findHooksAndActionsConflicts` / `warnOnHooksAndActionsConflict`
  (~35 lines), the `hooks` block in `buildServiceConfig` (~15 lines).
- `src/workspace.ts` — `runHookScript` re-export (~18 lines),
  `hookFailed` / `hookFailureReason` (~12 lines), `runAfterCreateHook`
  (~15 lines), `WorkspaceManager.runBeforeRun` /
  `WorkspaceManager.runAfterRunBestEffort` (~30 lines),
  the `before_remove` branch inside `WorkspaceManager.remove` (~6 lines),
  the `hookCapture` parameters threaded through `ensureFor` / `doEnsureFor`
  (~10 lines).
- `src/agent/runner.ts` — `initialHooks` / `cleanupHooks` plumbing,
  `runCleanupActionsOrHook`'s `'hook'` branch, the `before_run` /
  `after_create` / `after_run` / `before_remove` capture closures and
  `makeHookCapture`, the staged-env staging on the hook path
  (`stageCleanupEnv` is still needed for actions but the "hook fallback"
  contract goes away), and the four scattered
  `runAfterRunBestEffort(workspacePath, …hooks)` calls inside the failure
  paths of `prepareAdapterRuntime` / `bringUpVmAndExec` /
  `registerBridgeOrFail` / `startVmOrFail` (~150 lines combined).
- `src/orchestrator.ts` — `scheduleWorkspaceCleanup`'s `HookCapture` build +
  `resolveHooksForState` call (~25 lines).
- `src/bin/symphony.ts` — `warnOnHooksAndActionsConflict` call site, the
  "states.Todo.hooks.after_create" doc-comment reference (~10 lines).
- `tests/workflow.test.ts`, `tests/workspace.test.ts`,
  `tests/orchestrator.test.ts`, `tests/runner-hook-env.test.ts` —
  ~28 `hooks` references in `workflow.test.ts`, the `runHookScript extraEnv`
  describe in `workspace.test.ts`, the per-state hook resolution tests in
  `orchestrator.test.ts`, the entire `runner-hook-env.test.ts` file
  (239 lines, all asserting against the `SYMPHONY_PR_*` shell contract).
- `SPEC.md` §4.3.4 ("hooks (object)"), §5.4 ("Workspace Hooks"), the
  state hook discussion in §4.3.7, plus stray "after_create"/"before_run"
  mentions (~70 lines of spec text).
- `WORKFLOW.template.md` lines 82–97 (per-state hooks override) and lines
  306–411 (the entire `hooks:` block + its prose — ~100 lines).
- `WORKFLOW.md` lines 137–168 (the apologia for *not* declaring any hooks)
  (~30 lines). The block becomes "delete" rather than "replace."

**What:** Delete the entire workflow-level + per-state `hooks:` surface
(`after_create`, `before_run`, `after_run`, `before_remove`, `timeout_ms`),
the orchestrator's hook lifecycle (`runBeforeRun`, `runAfterRunBestEffort`,
`runAfterCreateHook`, the `before_remove` branch in `remove()`), and every
test, doc, and spec section that references them. The work that genuinely
needs to happen at those lifecycle points already has a typed home: the
canonical clone+branch+remote setup lives in `setupWorkspaceDir`
(`workspace.ts`); the post-attempt PR push/open lives in the Done state's
`actions:` block (`push_branch`, `create_pr_if_missing`); per-attempt
sandbox bring-up lives in the runner. `WorkspaceManager.remove` reduces to
`assertContained` + `rm -rf`.

**Estimated LOC removed:** ~700 net (src + tests + docs). The four hook
fields are referenced ~80 times across `src/` and another ~100 times
across `tests/` + `docs/`; deleting the surface lets each call site
collapse to its non-hook half.

**Rationale:** The shipped `WORKFLOW.md` declares no hooks. `actions:` already
won the after_run race (`hooks:` + `actions:` on the same state is documented
as deprecated and silently ignored with a warning — see
`findHooksAndActionsConflicts` in `workflow.ts:641`). `setupWorkspaceDir`
(workspace.ts:187) owns the canonical clone/branch/remote setup that
`after_create` used to do; the issue body notes that the reconciler's
workspace/VM resources cover lifecycle; `[dev].init` in the Smolfile covers
per-VM dep install; `run_in_vm` covers arbitrary in-sandbox commands. The
hook surface today is a v1-default that no live workflow exercises and a
maintenance tax across config parsing, runtime threading, failure-path
error handling, and four-channel test coverage.

**Risk:** **Medium.** The surface is documented as the supported way to
add custom workspace setup ("Use `after_create` only for additional setup
on top of that"). Removing it is a breaking change for any external
workflow that wired in a custom hook. Mitigations: the recommended
replacement is a Smolfile `[dev].init` (for build-tooling install) or a
typed `actions:` entry (for state-machine glue). Both already exist;
removing hooks is a documentation-and-migration cost, not a feature loss.
A subtler risk: `setupWorkspaceDir` is the *current* home for
clone+branch+remote, but the public contract is "after_create runs after the
canonical setup." Removing the contract means external workflows that
relied on running shell glue on first creation have to migrate; that's the
breaking change.

**Dependencies / order:**
- Depends on #2 — the Done state's after_run hook (in the actual workflow,
  not the template) still nominally exists today (it was replaced by
  `actions:` in WORKFLOW.md but the `hooks:` infrastructure is still load-
  bearing for any non-default workflow). #2 confirms the typed-action
  replacement covers every case the canonical workflow needs.
- Blocks no other candidate. Items 5 and 6 are subsets that can land first
  as risk-warmers, but the bulk of the LOC is in #1's scope.

---

### 2. Inline the after_run path into a Done-state `actions:` block

**Where:**
- `WORKFLOW.md` already does this (lines 66–78: `push_branch` +
  `create_pr_if_missing`). Item is "confirm and codify" rather than "do
  the migration."
- `src/agent/runner.ts:570–593` — `stageCleanupEnv` (~24 lines) is
  shared by the hook + actions paths; once #1 lands, `stageCleanupEnv` can
  inline into the single caller and drop the `decideCleanupExecution`
  three-state result entirely (`actions` vs `hook` vs `skip` collapses to
  `actions` vs `skip`).
- `src/agent/runner-decisions.ts:18–37` — `decideCleanupExecution`,
  `CleanupExecution`, `shouldStageAfterRunEnv` (~22 lines). Becomes
  one-line decisions or inlines completely.
- `tests/runner-hook-env.test.ts` (239 lines) — every test in here asserts
  the SYMPHONY_PR_* env contract that only matters when `hooks.after_run`
  shells out. Once the hook surface is gone the file is dead; the
  equivalent guarantees ride on the action-context tests in
  `tests/runner-decisions.test.ts` (the `deriveActionContext` helper) and
  `tests/actions.test.ts`.

**What:** Document that the canonical post-attempt PR handoff path is a
Done-state `actions:` block and remove the parallel `hooks.after_run`
implementation. The runner's cleanup decision shrinks from three branches
to two ("did anything declare an action list? if so run it; else skip"),
which deletes both `decideCleanupExecution` and the entire hook-fallback
arm of `runCleanupActionsOrHook` (~80 lines in the runner). The
`buildAfterRunHookEnv` helper at the top of `runner.ts` (~50 lines) goes
with it — its only consumer is the hook branch; the typed action context
is already wired through `deriveActionContext` in
`runner-decisions.ts:188`.

**Estimated LOC removed:** ~80 (src) + 239 (test file) = ~320 if you
include the orphan test deletion that should land alongside #1.

**Rationale:** The Done state's `actions:` block already does what the old
shell did, with better diagnostics (per-action retry/snapshot
plumbing — see the comment block at WORKFLOW.md:54–65). The Done-state
hook is the only after_run workload the shipped workflow needs; the rest
of the after_run surface is documented as deprecated.

**Risk:** **Low.** The work is already done in the workflow; this is
delete-only on the orchestrator side.

**Dependencies / order:** Lands as the *first half* of #1 (so the test
file doesn't get re-orphaned), or first on its own as a risk-warmer.

---

### 3. Generate `WORKFLOW.md` from `WORKFLOW.template.md` (or vice versa)

**Where:**
- `WORKFLOW.md` (492 lines, the project's own canonical workflow).
- `WORKFLOW.template.md` (708 lines, the annotated reference).
- A new generator (small) under `scripts/` if the chosen direction is
  template → workflow.

**What:** Decide a single source of truth. Two viable shapes:
- **`WORKFLOW.template.md` is the only file**, with a generator that
  strips the `<!-- … -->` annotation blocks and the `# …` line comments
  to produce the executable `WORKFLOW.md`. Operators copy the generated
  file as their starting point.
- **`WORKFLOW.md` is the only file**, with a doc-extractor that reads
  comments out of it and produces `WORKFLOW.template.md` for the
  documentation site.

Either direction removes one of the two files outright. Both files agree
today; that agreement is the maintenance tax that this candidate removes.

**Estimated LOC removed:** ~250. Direct duplication is smaller than the
file sizes suggest (the template's comment blocks are unique; the
workflow's apologia comments are unique), but the structural copy of the
YAML block shape (states, tracker, hooks, agent, acp, smolvm, server, mcp,
pr_autopilot) is repeated essentially line-for-line. Generator script is
~50 lines, so the net is ~250 LOC.

**Rationale:** Two-file drift is already evident: `WORKFLOW.md`'s
`max_concurrent_agents: 1` is a hand-written override of the template's
`2`; the workflow's `Review` state config has commentary about
`gpt-5-codex` that doesn't appear in the template; the template's
`acp.effort: xhigh` example is identical to the workflow's, but a
hand-edit on either side wouldn't propagate. Either single-source-of-truth
direction makes drift impossible by construction.

**Risk:** **Medium.** Downstream consumers (`scaffold.ts`'s
`SCAFFOLD_WORKFLOW_TEMPLATE`, the npm package's exported template path,
the README's link to `WORKFLOW.template.md` for the worked example) would
need to follow whichever direction the generator goes. The scaffold's
`SCAFFOLD_WORKFLOW_TEMPLATE` is a third, even more minimal, source of
truth today (75 lines) — it can probably be derived from the same
generator, which removes another ~75 LOC.

**Dependencies / order:** Independent. Lands cleanest after the hooks
surface is gone (#1) because both files would then carry no `hooks:`
block, simplifying the generator's structural normalization.

---

### 4. Drop unused action kinds (`merge`, `ensure_branch`, `checkout`, `delete_branch`, `propose_followup`, `run_in_vm`)

**Where:**
- `src/actions/types.ts:94–159` — `EnsureBranchAction`, `CheckoutAction`,
  `MergeAction`, `DeleteBranchAction`, `RunInVmAction`,
  `ProposeFollowupAction` interfaces (~70 lines).
- `src/actions/parsing.ts:158–322` — per-kind validation branches in
  `parseAction`'s switch (~165 lines).
- `src/actions/executor.ts` — `applyEnsureBranch`, `applyCheckout`,
  `applyMerge`, `applyDeleteBranch`, `applyRunInVm`, `applyProposeFollowup`,
  the `tryRunInVmCacheHit`/`executeRunInVm`/`hostRunInVm` triplet, plus the
  `RunInVmExecutor` port and the `runInVm` field on `ActionExecutorOptions`
  (~300 lines). The `propose_followup` infrastructure (`ProposeFollowupSink`
  port + the runner's `followupSink` wiring + `applyProposeFollowup`)
  duplicates the MCP `propose_issue` path.
- `src/actions/effects.ts` (~86 lines) — drops the planActions
  pre-rendering that's only used by the larger action set; the two
  surviving kinds (push_branch, create_pr_if_missing) can render inline.
- `src/actions/cache.ts` (~226 lines) — the entire content-hash cache
  layer exists for `run_in_vm`. Goes if `run_in_vm` goes.
- `src/agent/runner.ts:480–530` — `buildVmRunInVm`, `runStateActions`
  wiring of `runInVm` and `followupSink` (~50 lines).
- `tests/actions.test.ts` (1165 lines) — every test for the dropped kinds.
  Rough estimate: ~700 lines describe the dropped action surfaces; the
  surviving push_branch + create_pr_if_missing tests are a small subset.
- `tests/effects.test.ts` (86 lines), `tests/predicates.test.ts` (149
  lines) — only the kind-specific entries.
- `WORKFLOW.template.md` lines 105–143 (kind enumeration + cache notes)
  (~40 lines).

**What:** Keep only the two action kinds the canonical workflow uses
(`push_branch`, `create_pr_if_missing`) and the supporting infrastructure
they exercise. Drop the cache layer (`run_in_vm`-only), the host-spawn
executor (`hostRunInVm`-only), the followup sink (duplicates MCP
`propose_issue`), and the predicate IO seam if no surviving kind needs
`branch_exists`/`file_present`.

**Estimated LOC removed:** ~250 net (counted conservatively: ~1100
lines of types + parser + executor + cache + tests, less ~50 lines of
trimmed-down replacement for the two surviving kinds, less the ~800 lines
of test that are still useful for the two surviving kinds).

**Rationale:** Six of the eight declared action kinds are never used in
the shipped workflow (`WORKFLOW.md`). Five of them are never used anywhere
in `src/` either — only in `tests/`. `run_in_vm` is the most interesting:
it duplicates the in-VM exec surface the runner already owns, brings its
own ~226-line content-hash cache, requires a separate `RunInVmExecutor`
port, and the only production caller would be a check workflow nobody has
written. `propose_followup` is a parallel write to the tracker that
duplicates `symphony.propose_issue` (the MCP tool) — the executor's
comment at executor.ts:72 documents the duplication explicitly. If a
future workflow needs one of these, re-add it under the closed-union shape
the executor already enforces.

**Risk:** **Low.** No production caller of any kind in this set exists
today. The `propose_followup` removal narrows the closed contract; the
MCP path is the supported way to propose issues from inside a dispatched
run, and no one has wired a terminal-state action to propose follow-ups.

**Dependencies / order:** Independent. Lands cleanest after #2 so the
action set's surviving kinds match the surviving cleanup path.

---

### 5. Collapse `src/workspace.ts`'s `runHookScript` wrapper

**Where:**
- `src/workspace.ts:85–102` — `runHookScript` (~18 lines, including the
  comment) is a one-call delegate to `util/process.ts`'s `runHookScript`
  with `appendErrorToStderr: false` hard-coded.
- `tests/workspace.test.ts:159–203` — the `runHookScript extraEnv`
  describe block, which exists only because `workspace.ts` re-exports the
  helper.

**What:** Either flip the default in `util/process.ts`'s `runHookScript`
to `appendErrorToStderr: false` (matching every current call site that
goes through `workspace.ts`), or have the four `workspace.ts` callers
import `runHookScript` directly from `util/process.ts` with the option
set inline. The re-export goes away; the wrapper's "legacy hook wrapper
did not append the spawn error message to stderr" comment goes away.

**Estimated LOC removed:** ~30 (src + tests).

**Rationale:** The wrapper exists only to flip one boolean default. It
adds a layer of indirection between the four `WorkspaceManager` callers
and the unified subprocess wrapper, plus it carries its own test set
even though the underlying behavior is fully covered by
`tests/util-process.test.ts`.

**Risk:** **Low.** The wrapper is a one-liner and its semantics are
already documented in `util/process.ts`. The behavioral note (don't
append spawn errors to stderr) is preserved by passing the option from
the call site; the documentation note moves with it.

**Dependencies / order:** Independent. Lands cleanest *before* #1
(it tightens the test surface that #1 then deletes, instead of
deleting both at the same time and risking a regression hiding in
the spread).

---

### 6. Collapse `HookCapture` / `HookResult` re-exports

**Where:**
- `src/workspace-types.ts` (17 lines) — defines `HookCapture = RunCapture`
  and `HookResult = RunResult` as type aliases over `util/process.ts`'s
  types.
- `src/workspace.ts:17,24` — imports both from `workspace-types.ts` and
  re-exports them so existing importers keep their `from '../workspace.js'`
  paths.
- `src/agent/runner.ts:59` — imports `HookCapture, HookResult` from
  `workspace.js` (~30 references).
- `src/actions/executor.ts:49` — imports `HookCapture` from
  `workspace-types.js`.
- `src/orchestrator.ts:44` — imports both from `workspace.js`.

**What:** Delete `src/workspace-types.ts`; let consumers import
`RunCapture`/`RunResult` directly from `util/process.ts`. The `Hook*`
aliasing was useful before the hook wrappers and the subprocess wrapper
shared a shape — they share now, so the alias is just a type-redirection
layer with no semantic value.

**Estimated LOC removed:** ~25 (file + redirected imports).

**Rationale:** `workspace-types.ts:11` itself says: "Aliased to the
unified RunResult since hook callers and every other shell-out share the
same shape." With the unification done, the alias is the only thing
left to delete.

**Risk:** **Low.** Pure rename; no runtime change. Catches every
importer at compile time (TypeScript surfaces the renamed types).

**Dependencies / order:** Independent. Best landed alongside #5 since
both shrink the same module.

---

### 7. Inline single-caller `util/crypto.ts` + `util/fs-issues.ts` ports

**Where:**
- `src/util/crypto.ts` (42 lines) — `CryptoEnv` port + `realCrypto`
  adapter. Single consumer: `src/mcp.ts`.
- `src/util/fs-issues.ts` (37 lines) — `IssueFs` port + `realIssueFs`
  adapter. Single consumer: `src/issues.ts`.

**What:** Inline both ports into their callers. The seam exists to keep
`mcp.ts` and `issues.ts` "functional-core pure" (no direct
`node:crypto` / `node:fs/promises` imports), which is a lint-rule
posture, not a behavioral requirement. With one consumer apiece, the
port is paying tax on an architecture that hasn't matured: the standard
"port + adapter + injected default" shape only earns its keep when there
are multiple consumers or when the port is mocked from multiple test
locations.

Two alternatives that preserve the intent:
- Move both `mcp.ts` and `issues.ts` out of the functional-core lint
  group (already true for `util/clock.ts`, see the file's first comment),
  then delete the ports.
- Keep `crypto.ts` (the `timingSafeEqual` defense is a meaningful
  encapsulation) and only inline `fs-issues.ts`.

**Estimated LOC removed:** ~50.

**Rationale:** Both ports are documented as mirrors of `util/clock.ts`,
which has multiple consumers (`mcp.ts`, `issues.ts`, `actions/executor.ts`,
`reconciler/pr.ts`). The clock port earns its keep; the others don't yet.

**Risk:** **Low.** The injected-default pattern lets tests pin behavior;
inlining means tests pin via fakes in the consumer instead. The test
surface for `mcp.ts` and `issues.ts` already mocks the surrounding
tracker/IO, so the additional fakes are small.

**Dependencies / order:** Independent. Could land as part of a broader
"foundation/util audit" issue.

---

### 8. Drop `pr_autopilot.close_state` "null disables" three-state knob

**Where:**
- `src/workflow.ts:378–388` — the `closeStateKeyPresent` /
  `closeStateRaw` / `closeStateTrimmed` chain that distinguishes "key
  absent (default Cancelled)" from "key present with null/empty (disable
  close path)" (~12 lines).
- `src/types.ts:293` — `close_state: string | null` (the null arm).
- `src/orchestrator-decisions.ts:194–217` — the `classifyPrIntent`
  branch that handles `closeState === null` (~5 lines).
- `src/reconciler/pr.ts` close-path implementation — guarded on
  `close_state` not being null.
- `WORKFLOW.template.md:233–236` — the prose explaining the three
  states.

**What:** Collapse `close_state` to a non-nullable string with a single
default (`Cancelled`). Operators who genuinely want to disable the close
path can declare a terminal state name that no issue ever reaches; that's
a configuration discipline thing, not a parser-shape thing.

**Estimated LOC removed:** ~25.

**Rationale:** The three-state knob (absent ↔ default; explicit value;
explicit null) is the most complex shape in the workflow parser and the
only one in `pr_autopilot`. The two-state default-or-override shape is the
shape every other optional config field uses; collapsing here removes one
schema oddity.

**Risk:** **Medium.** External operators relying on the null/empty
"disable close path" semantics get a soft behavior change (PR autopilot
will try to close PRs for any issue in the renamed `close_state`).
Mitigation: emit a deprecation warning in the parser when the field is
present with a falsy value (one release), then remove the branch.

**Dependencies / order:** Independent.

---

## Out of scope / already done

The following are mentioned in the issue body or are obvious adjacent
candidates, but should not be re-proposed:

- **Shared-integration-branch handoff** (#99 / issue 106, ~2.1k LOC). Already
  removed.
- **Out-of-band conflict-handoff machinery** (#94). Already removed. The
  `pr_autopilot` conflict-route-to path is the supported replacement and
  is not in scope for further removal — issue 101 deliberately closed the
  re-route loop, and shrinking it would re-open it.
- **`runner.ts` decomposition to budget** (#100). Already landed. The
  phase pipeline structure in `runAttemptCore` (runner.ts:724) is what
  keeps the imperative shell under the complexity ratchet; reverting it
  would re-trip the lint:arch rule.
- **WORKFLOW.md doc references to "integration branch",
  "conflict_holding_state", "rebase_and_push".** None present in
  `WORKFLOW.md`, `WORKFLOW.template.md`, `SPEC.md`, or `src/`. The cleanup
  the issue body anticipates is already done.
- **`util/clock.ts` port.** Has four consumers (`mcp.ts`, `issues.ts`,
  `actions/executor.ts`, `reconciler/pr.ts`) plus tests; the port earns its
  keep. Not a single-caller candidate.
- **`util/process.ts`.** Ten consumers including the workspace,
  reconciler, smolvm client, actions executor, and predicates. Strong
  multi-consumer port; do not inline.
- **`hooks.timeout_ms` and the `HOOK_TIMEOUT` paths if `hooks:` survives.**
  Only relevant if #1 is rejected. Don't file as a separate candidate —
  the prudent failure mode for #1 is to keep `hooks:` and the existing
  timeout, not to slice the surface mid-way.
- **`acp.command` workflow key.** Already removed per CHANGELOG (the
  bridge transport cannot honor a raw command). Not present in code.
- **`mark_done` MCP tool.** Already removed (CHANGELOG); the
  `transitioned` field on `RunningEntry` is the surviving signal.
- **`scripts/build-vm.sh`.** Already removed (CHANGELOG).
- **`tracker.active_states` / `tracker.terminal_states` workflow keys.**
  Already removed (CHANGELOG); the `states:` block is the single source
  of truth.
- **Linear tracker scaffolding.** Already removed (CHANGELOG); only the
  local Markdown tracker exists.
- **`smolvm.bin_path` workflow mount.** Already removed (CHANGELOG);
  adapter binaries are baked into the VM image.

## Notes on accounting

LOC estimates come from `wc -l` on the modules involved, plus
grep-count accounting of references that follow (`hooks` appears ~80
times in `src/` and ~100 times in `tests/` + `docs/`; deleting the
surface removes most of them, not all). Each candidate's "Net LOC"
already subtracts replacement code where one exists. Real `git diff
--stat` numbers will run smaller than the gross deletion when comments,
blank lines, and partial-line edits are factored in; the order of the
priority table should be stable under that adjustment because the
ratios between candidates are dominated by which surfaces survive.

Risk grades are conservative. None of the candidates listed here are
"hard" in the sense that the affected behavior has no replacement; the
medium grades capture downstream-consumer migration costs (item 1's
external-workflow break, item 3's scaffold/docs cascade, item 8's
opt-out-via-config workaround). The hard cases — anything touching the
pr_autopilot reconciler resource lifecycle, the per-issue MCP
registry's bearer-token contract, or the workspace containment
invariants — are intentionally out of scope for this survey because
their LOC footprint is small relative to the risk of regressing the
sandbox boundary.
