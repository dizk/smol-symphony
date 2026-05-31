// Pure decision logic for the PR autopilot (issue 70). `decidePr(observed) →
// PrEffect[]` is the heart of the resource: every routing, arm, cleanup, and
// reroute branch lives here as a deterministic function of an observation
// snapshot. `pr.ts` is then the imperative shell that builds the observation,
// applies effects in order through the injected ports, folds outcomes back
// into the next observation, and re-decides until the decision list is empty.
//
// Effects-as-data lets the branch table be tested as a plain function over
// input objects — and the shell shrinks to one effect-application switch.
//
// Multi-pass semantics: outcomes of IO effects (summary lookup, view fetch)
// drive subsequent decisions. The shell records each outcome into the
// observation and calls `decidePr` again; the function looks at
// `summaryResolved` / `viewResolved` to decide whether the next observation
// step has run yet. The loop terminates when `decidePr` returns `[]`.
//
// Action ledger / log lines are handled inside the effect handlers in
// `pr.ts` — this module only emits the data describing what should happen.
//
// No IO imports. No clock. No randomness. Domain-only.

export type PrIntentKind = 'merge' | 'close';

/**
 * One issue under the autopilot's care. `close` intents only need the branch
 * name (we never touch the workspace — the issue is in a Cancelled-like
 * state and the orchestrator's normal terminal cleanup is free to reap it).
 * `merge` intents carry the workspace path for diagnostics in the conflict-
 * route notes, but the autopilot no longer drives a rebase from it — the
 * dispatched agent owns rebasing onto a fresh `origin/<base>`.
 */
export interface PrIntent {
  identifier: string;
  kind: PrIntentKind;
  state: string;
  workspace_path: string | null;
  branch: string;
  base_branch: string;
}

/**
 * Result of looking up the open PR for a branch. `null` means no open PR
 * exists for this branch (local-only mode, or the PR was never opened).
 */
export interface PrSummary {
  number: number;
  url: string;
}

export type PrState = 'OPEN' | 'CLOSED' | 'MERGED';
export type PrMergeable = 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
/**
 * GitHub's `mergeStateStatus` enum. `mergeable` only tells us whether the diffs
 * conflict textually; `merge_state_status` is the richer "can this PR actually
 * merge right now?" signal — in particular it surfaces `BEHIND` (branch
 * protection requires up-to-date, base has moved without producing a textual
 * conflict), which `mergeable: MERGEABLE` hides. See issue 105.
 */
export type PrMergeStateStatus =
  | 'BEHIND'
  | 'BLOCKED'
  | 'CLEAN'
  | 'DIRTY'
  | 'DRAFT'
  | 'HAS_HOOKS'
  | 'UNKNOWN'
  | 'UNSTABLE';

/**
 * Per-PR view as reported by `gh pr view <#> --json ...`. Only the fields the
 * resource actually consults are typed; anything else gh returns is ignored.
 */
export interface PrView {
  number: number;
  url: string;
  state: PrState;
  mergeable: PrMergeable;
  merge_state_status: PrMergeStateStatus;
  base_ref_name: string;
  base_ref_oid: string | null;
  head_ref_name: string;
  head_ref_oid: string;
  review_decision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;
  auto_merge_armed: boolean;
}

/**
 * Outcome of a `close_pr` apply step. `ok: false` means the gh close call
 * surfaced an error through the ledger (no exception thrown — `runClosePr`
 * catches and records `last_error`). Carried in the observation so the next
 * `decidePr` call can gate `delete_remote_branch` on close success — main's
 * `runClosePr` returned early on failure, leaving the remote branch in place
 * under a still-open PR, and we preserve that contract here.
 */
export type CloseOutcome = { ok: boolean };

/**
 * Read-only slice of `PerIssueState` that the pure decision needs. The shell
 * snapshots this from the live state before each `decidePr` call.
 */
export interface PrCacheView {
  completed: boolean;
  armed: boolean;
  lastObservedHeadSha: string | null;
}

/** Config slice consulted by `decidePr`. */
export interface PrDecideConfig {
  strategy: 'squash' | 'merge' | 'rebase';
  conflictRouteTo: string;
}

/**
 * Single-intent observation snapshot. `summaryResolved` / `viewResolved`
 * distinguish "haven't run that effect yet" from "ran it and got null/error"
 * — without that distinction the decide loop can't tell a fresh observation
 * from a failed one and would re-emit the effect forever.
 */
export interface PrObservation {
  intent: PrIntent;
  cache: PrCacheView;
  summaryResolved: boolean;
  summary: PrSummary | null;
  viewResolved: boolean;
  view: PrView | null;
  /**
   * Close-path outcome tracker. `closeAttempted` flips true after the shell
   * applies a `close_pr` effect; `closeOutcome.ok` records whether the gh
   * close call succeeded. `decideClose` uses these to emit
   * `delete_remote_branch` only after a successful close — matching the
   * pre-refactor `runClosePr` behavior that returned early on failure.
   */
  closeAttempted: boolean;
  closeOutcome: CloseOutcome | null;
  /**
   * Terminal-pass marker set by the shell after applying any effect that
   * means "we're done with this intent this reconcile pass" — conflict route
   * back to the implementing state, or any other halt-worthy effect.
   * `decidePr` returns `[]` when `halt` is true so the processIntent loop
   * exits cleanly without re-observing and re-deciding on stale obs.
   */
  halt: boolean;
  config: PrDecideConfig;
}

/**
 * Discriminated union of effects the shell knows how to apply. Each effect
 * either drives an injected port (arm, route, cleanup) or mutates the
 * per-issue cache the shell holds. Effects carry every input the apply step
 * needs — the shell does not reach back into observation or config when
 * executing one.
 */
export type PrEffect =
  | { kind: 'observe_summary'; identifier: string; branch: string }
  | { kind: 'observe_view'; identifier: string; prNumber: number }
  | {
      kind: 'arm_auto_merge';
      identifier: string;
      prNumber: number;
      strategy: 'squash' | 'merge' | 'rebase';
    }
  | { kind: 'update_branch'; identifier: string; prNumber: number }
  | { kind: 'close_pr'; identifier: string; prNumber: number }
  | { kind: 'delete_remote_branch'; identifier: string; branch: string }
  | { kind: 'cleanup_workspace'; identifier: string }
  | {
      kind: 'route_conflict';
      identifier: string;
      fromState: string;
      toState: string;
      notes: string;
    }
  | { kind: 'update_observed_head'; identifier: string; sha: string }
  | { kind: 'mark_completed'; identifier: string }
  | { kind: 'reset_transient'; identifier: string };

/**
 * Pure decision: given an observation, return the next batch of effects the
 * shell should apply. After applying, the shell rebuilds the observation
 * (with new IO outcomes folded in) and calls `decidePr` again. The loop ends
 * when the result is empty.
 */
export function decidePr(obs: PrObservation): PrEffect[] {
  const { intent, cache } = obs;
  const id = intent.identifier;

  if (obs.halt) return [];
  if (cache.completed) return [];
  if (!obs.summaryResolved) {
    return [{ kind: 'observe_summary', identifier: id, branch: intent.branch }];
  }
  if (intent.kind === 'close') return decideClose(obs);

  // merge intent below
  if (obs.summary === null) return [];
  if (!obs.viewResolved) {
    return [{ kind: 'observe_view', identifier: id, prNumber: obs.summary.number }];
  }
  if (obs.view === null) return [];
  const view = obs.view;

  if (view.state === 'MERGED' || view.state === 'CLOSED') {
    return [
      { kind: 'delete_remote_branch', identifier: id, branch: intent.branch },
      { kind: 'cleanup_workspace', identifier: id },
      { kind: 'mark_completed', identifier: id },
    ];
  }

  // CONFLICTING → route the issue back to the implementing state so the
  // dispatched agent rebases onto a freshly-fetched `origin/<base>` as part
  // of its normal work. The autopilot no longer drives a rebase from the
  // workspace; "is my branch mergeable?" is the agent's responsibility now.
  if (view.mergeable === 'CONFLICTING') return decideConflict(obs);

  // UNKNOWN: GitHub is still computing mergeability — defer until the next
  // pass. Arming on UNKNOWN works (auto-merge waits for the computed state)
  // but produces noisier ledgers; the per-PR poll TTL means UNKNOWN
  // typically resolves within one tick.
  if (view.mergeable === 'UNKNOWN') {
    // Pin the observed head SHA so the next pass can detect concurrent
    // pushes if the agent has pushed in the meantime.
    if (cache.lastObservedHeadSha !== view.head_ref_oid) {
      return [{ kind: 'update_observed_head', identifier: id, sha: view.head_ref_oid }];
    }
    return [];
  }

  // MERGEABLE: arm `gh pr merge --auto` once. GitHub handles the wait-for-
  // checks-and-reviews part on its own; we just keep the auto-merge armed.
  if (!cache.armed) {
    return [
      {
        kind: 'arm_auto_merge',
        identifier: id,
        prNumber: view.number,
        strategy: obs.config.strategy,
      },
    ];
  }
  // Armed but BEHIND: branch protection's "require branches up to date" rule
  // blocks the auto-merge until the branch catches up to base. The diffs
  // don't textually conflict (mergeable=MERGEABLE), so the CONFLICTING route
  // never fires — without an explicit nudge the PR sits armed-and-stuck
  // forever. Advance the branch via `gh pr update-branch`; once the head
  // moves, head_ref_oid changes (update_observed_head absorbs it) and the
  // status leaves BEHIND, so the effect stops firing. See issue 105.
  if (view.merge_state_status === 'BEHIND') {
    return [{ kind: 'update_branch', identifier: id, prNumber: view.number }];
  }
  return [];
}

function decideClose(obs: PrObservation): PrEffect[] {
  const id = obs.intent.identifier;
  if (obs.summary === null) return [{ kind: 'mark_completed', identifier: id }];
  if (!obs.viewResolved) {
    return [{ kind: 'observe_view', identifier: id, prNumber: obs.summary.number }];
  }
  if (obs.view === null) return [];
  const view = obs.view;
  if (view.state === 'MERGED' || view.state === 'CLOSED') {
    return [
      { kind: 'delete_remote_branch', identifier: id, branch: obs.intent.branch },
      { kind: 'mark_completed', identifier: id },
    ];
  }
  // Open PR: close first, then gate branch deletion on close success. A
  // failed close leaves the PR open on origin, so deleting the remote branch
  // would orphan it — matching main's `runClosePr` which returned early on
  // failure. The completion latch still fires (same as main) so a transient
  // gh outage doesn't leave the close intent looping every pass.
  if (!obs.closeAttempted) {
    return [{ kind: 'close_pr', identifier: id, prNumber: view.number }];
  }
  if (obs.closeOutcome !== null && obs.closeOutcome.ok) {
    return [
      { kind: 'delete_remote_branch', identifier: id, branch: obs.intent.branch },
      { kind: 'mark_completed', identifier: id },
    ];
  }
  return [{ kind: 'mark_completed', identifier: id }];
}

/**
 * Conflict routing: append a notes block and move the issue back to the
 * implementing state. No counter, no circuit breaker — the dispatched agent
 * rebases onto a freshly-fetched `origin/<base>` and resolves the conflict
 * as part of its normal Todo flow. Each round the PR flips back to
 * MERGEABLE on the agent's force-push, the next reconcile pass arms
 * auto-merge, and merging happens once checks pass.
 */
function decideConflict(obs: PrObservation): PrEffect[] {
  const id = obs.intent.identifier;
  const view = obs.view!;
  return [
    {
      kind: 'route_conflict',
      identifier: id,
      fromState: obs.intent.state,
      toState: obs.config.conflictRouteTo,
      notes: buildConflictNotes({ intent: obs.intent, view }),
    },
    { kind: 'reset_transient', identifier: id },
  ];
}

/**
 * Structured notes block appended to the issue file when a conflict route
 * fires. Pure: every input is part of the observation. Lives here (not in the
 * shell) so the route effect carries its rendered notes as data.
 */
export function buildConflictNotes(args: { intent: PrIntent; view: PrView }): string {
  const { intent, view } = args;
  const lines: string[] = [
    'pr autopilot — PR is not mergeable against base',
    '',
    `GitHub reports PR #${view.number} (${view.url}) as \`mergeable: ${view.mergeable}\` against \`origin/${intent.base_branch}\`.`,
    '',
    `Routing the issue back to \`${intent.state}\` → implementing state. The next dispatch will fetch \`origin/${intent.base_branch}\` afresh into the workspace; the agent rebases \`${intent.branch}\` onto it as the first step of its normal Todo flow, resolves any conflicts in-tree, re-runs typecheck/tests, and hands back off to the reviewer. Once the rebased branch is force-pushed, this PR flips back to MERGEABLE and auto-merge is armed on the next reconcile pass.`,
  ];
  return lines.join('\n');
}
