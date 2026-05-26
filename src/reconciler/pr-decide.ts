// Pure decision logic for the PR autopilot (issue 70). `decidePr(observed) →
// PrEffect[]` is the heart of the resource: every routing, rebase, push, arm,
// cleanup, and circuit-breaker branch lives here as a deterministic function
// of an observation snapshot. `pr.ts` is then the imperative shell that
// builds the observation, applies effects in order through the injected
// ports, folds outcomes back into the next observation, and re-decides until
// the decision list is empty.
//
// Why effects-as-data: the previous `processMerge()` interleaved IO and
// branches, so each conflict-handoff / circuit-breaker variation required a
// gh + git stub harness to exercise. With the pure decide split out, the
// branch table can be tested as a plain function over input objects — and the
// shell shrinks to one effect-application switch.
//
// Multi-pass semantics: outcomes of IO effects (summary lookup, view fetch,
// rebase) drive subsequent decisions. The shell records each outcome into the
// observation and calls `decidePr` again; the function looks at
// `summaryResolved` / `viewResolved` / `rebaseAttempted` to decide whether
// the next observation step has run yet. The loop terminates when `decidePr`
// returns `[]`.
//
// Action ledger / log lines / cache invalidation are handled inside the
// effect handlers in `pr.ts` — this module only emits the data describing
// what should happen.
//
// No IO imports. No clock. No randomness. Domain-only.

export type PrIntentKind = 'merge' | 'close';

/**
 * One issue under the autopilot's care. `merge` intents need a workspace path
 * because the rebase runs there. `close` intents only need the branch name
 * (we never touch the workspace — the issue is in a Cancelled-like state and
 * the orchestrator's normal terminal cleanup is free to reap it).
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
 * Per-PR view as reported by `gh pr view <#> --json ...`. Only the fields the
 * resource actually consults are typed; anything else gh returns is ignored.
 */
export interface PrView {
  number: number;
  url: string;
  state: PrState;
  mergeable: PrMergeable;
  base_ref_name: string;
  base_ref_oid: string | null;
  head_ref_name: string;
  head_ref_oid: string;
  review_decision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;
  auto_merge_armed: boolean;
}

export type RebaseOutcome =
  | { kind: 'ok'; new_head_sha: string }
  | { kind: 'conflict'; files: string[]; diagnostic: string }
  | { kind: 'concurrent_push'; observed_head_sha: string }
  | { kind: 'error'; diagnostic: string };

export type PushOutcome =
  | { kind: 'ok' }
  | { kind: 'concurrent_push'; diagnostic: string }
  | { kind: 'error'; diagnostic: string };

export type EnsureWorkspaceOutcome =
  | { kind: 'ok' }
  | { kind: 'error'; diagnostic: string };

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
  rebaseAttempts: number;
}

/** Config slice consulted by `decidePr`. */
export interface PrDecideConfig {
  strategy: 'squash' | 'merge' | 'rebase';
  maxRebaseAttempts: number;
  conflictRouteTo: string;
  conflictHoldingState: string | null;
}

/**
 * Single-intent observation snapshot. `summaryResolved` / `viewResolved` /
 * `rebaseAttempted` distinguish "haven't run that effect yet" from "ran it
 * and got null/error" — without that distinction the decide loop can't tell
 * a fresh observation from a failed one and would re-emit the effect forever.
 */
export interface PrObservation {
  intent: PrIntent;
  cache: PrCacheView;
  summaryResolved: boolean;
  summary: PrSummary | null;
  viewResolved: boolean;
  view: PrView | null;
  rebaseAttempted: boolean;
  rebaseOutcome: RebaseOutcome | null;
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
   * means "we're done with this intent this reconcile pass" — defer on
   * concurrent push, conflict route, breaker clamp, rebase-error surface.
   * `decidePr` returns `[]` when `halt` is true so the processIntent loop
   * exits cleanly without re-observing and re-deciding on stale obs.
   */
  halt: boolean;
  config: PrDecideConfig;
}

/**
 * Discriminated union of effects the shell knows how to apply. Each effect
 * either drives an injected port (rebase, arm, route, cleanup) or mutates the
 * per-issue cache the shell holds. Effects carry every input the apply step
 * needs — the shell does not reach back into observation or config when
 * executing one.
 */
export type PrEffect =
  | { kind: 'observe_summary'; identifier: string; branch: string }
  | { kind: 'observe_view'; identifier: string; prNumber: number }
  | {
      kind: 'rebase_and_push';
      identifier: string;
      workspacePath: string;
      branch: string;
      baseBranch: string;
      expectedHeadSha: string;
    }
  | {
      kind: 'arm_auto_merge';
      identifier: string;
      prNumber: number;
      strategy: 'squash' | 'merge' | 'rebase';
    }
  | { kind: 'close_pr'; identifier: string; prNumber: number }
  | { kind: 'delete_remote_branch'; identifier: string; branch: string }
  | { kind: 'cleanup_workspace'; identifier: string }
  | {
      kind: 'route_conflict';
      identifier: string;
      fromState: string;
      toState: string;
      notes: string;
      circuitBroken: boolean;
    }
  | { kind: 'log_concurrent_push'; identifier: string; observed: string; now: string }
  | { kind: 'update_observed_head'; identifier: string; sha: string }
  | { kind: 'mark_completed'; identifier: string }
  | { kind: 'reset_attempts'; identifier: string }
  | { kind: 'increment_attempts'; identifier: string; attempt: number; max: number }
  | { kind: 'reset_transient'; identifier: string }
  | { kind: 'forget_identifier'; identifier: string }
  | { kind: 'clamp_attempts'; identifier: string; value: number }
  | { kind: 'set_last_error'; message: string };

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
  // Concurrent-push defer: head SHA moved since the last observation we
  // recorded. Only meaningful pre-rebase — after our own rebase the cached
  // head reflects the new local SHA while `view.head_ref_oid` still names
  // the pre-rebase SHA we observed at the start of the pass, and that diff
  // is our own push, not a third party's.
  if (
    !obs.rebaseAttempted &&
    cache.lastObservedHeadSha !== null &&
    cache.lastObservedHeadSha !== view.head_ref_oid
  ) {
    return [
      {
        kind: 'log_concurrent_push',
        identifier: id,
        observed: cache.lastObservedHeadSha,
        now: view.head_ref_oid,
      },
      { kind: 'update_observed_head', identifier: id, sha: view.head_ref_oid },
    ];
  }

  if (intent.workspace_path !== null) {
    if (!obs.rebaseAttempted) {
      return [
        {
          kind: 'rebase_and_push',
          identifier: id,
          workspacePath: intent.workspace_path,
          branch: intent.branch,
          baseBranch: intent.base_branch,
          expectedHeadSha: view.head_ref_oid,
        },
      ];
    }
    const outcome = obs.rebaseOutcome;
    if (outcome === null) return [];
    if (outcome.kind === 'ok') {
      const eff: PrEffect[] = [];
      if (cache.rebaseAttempts > 0) eff.push({ kind: 'reset_attempts', identifier: id });
      if (!cache.armed) {
        eff.push({
          kind: 'arm_auto_merge',
          identifier: id,
          prNumber: view.number,
          strategy: obs.config.strategy,
        });
      }
      return eff;
    }
    if (outcome.kind === 'conflict') return decideConflict(obs, outcome);
    if (outcome.kind === 'concurrent_push') {
      return [{ kind: 'update_observed_head', identifier: id, sha: outcome.observed_head_sha }];
    }
    if (outcome.kind === 'error') {
      return [{ kind: 'set_last_error', message: outcome.diagnostic }];
    }
    return [];
  }

  // No workspace to drive a rebase from. Textual conflict route OR arm.
  if (view.mergeable === 'CONFLICTING') return decideConflict(obs, null);
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
 * Conflict routing: increment the attempt counter, then route to either the
 * implementing state (counter < max) or the holding state (counter >= max).
 * When no holding state is declared the breaker can't park anywhere, so we
 * record `last_error` and clamp the counter to avoid unbounded growth.
 */
function decideConflict(
  obs: PrObservation,
  rebase: Extract<RebaseOutcome, { kind: 'conflict' }> | null,
): PrEffect[] {
  const id = obs.intent.identifier;
  const view = obs.view!;
  const attempt = obs.cache.rebaseAttempts + 1;
  const max = obs.config.maxRebaseAttempts;

  if (attempt >= max) {
    if (obs.config.conflictHoldingState === null) {
      return [
        { kind: 'increment_attempts', identifier: id, attempt, max },
        {
          kind: 'set_last_error',
          message: `pr_autopilot: circuit broken for ${id} after ${max} attempts; no conflict_holding_state declared`,
        },
        { kind: 'clamp_attempts', identifier: id, value: max },
      ];
    }
    return [
      { kind: 'increment_attempts', identifier: id, attempt, max },
      {
        kind: 'route_conflict',
        identifier: id,
        fromState: obs.intent.state,
        toState: obs.config.conflictHoldingState,
        notes: buildConflictNotes({
          intent: obs.intent,
          view,
          rebase,
          attempt: max,
          max,
          circuitBroken: true,
        }),
        circuitBroken: true,
      },
      { kind: 'forget_identifier', identifier: id },
    ];
  }
  return [
    { kind: 'increment_attempts', identifier: id, attempt, max },
    {
      kind: 'route_conflict',
      identifier: id,
      fromState: obs.intent.state,
      toState: obs.config.conflictRouteTo,
      notes: buildConflictNotes({
        intent: obs.intent,
        view,
        rebase,
        attempt,
        max,
        circuitBroken: false,
      }),
      circuitBroken: false,
    },
    { kind: 'reset_transient', identifier: id },
  ];
}

/**
 * Structured notes block appended to the issue file when a conflict route
 * fires. Pure: every input is part of the observation. Lives here (not in the
 * shell) so the route effect carries its rendered notes as data.
 */
export function buildConflictNotes(args: {
  intent: PrIntent;
  view: PrView;
  rebase: Extract<RebaseOutcome, { kind: 'conflict' }> | null;
  attempt: number;
  max: number;
  circuitBroken: boolean;
}): string {
  const { intent, view, rebase, attempt, max, circuitBroken } = args;
  const heading = circuitBroken
    ? `pr_autopilot — circuit broken after ${max} rebase attempts`
    : `pr_autopilot — rebase conflict, attempt ${attempt} of ${max}`;
  const lines: string[] = [heading, ''];
  lines.push(
    `Rebasing \`${intent.branch}\` onto \`origin/${intent.base_branch}\` produced a conflict on PR #${view.number} (${view.url}).`,
  );
  lines.push('');
  if (rebase !== null) {
    if (rebase.files.length > 0) {
      lines.push('Conflicted files:');
      lines.push('');
      for (const f of rebase.files) lines.push(`- ${f}`);
      lines.push('');
    }
    if (rebase.diagnostic.length > 0) {
      lines.push('Diagnostic:');
      lines.push('');
      lines.push('```');
      lines.push(rebase.diagnostic);
      lines.push('```');
      lines.push('');
    }
  } else {
    lines.push(
      `GitHub reports the PR as \`mergeable: CONFLICTING\` against base SHA ${view.base_ref_oid ?? '<unknown>'}.`,
    );
    lines.push('');
  }
  if (circuitBroken) {
    lines.push(
      'The autopilot has stopped trying. Resolve the conflict by hand (or as the operator), push the resolution to the same branch, and move the issue back to the merge state.',
    );
  } else if (rebase !== null) {
    lines.push(
      `The rebase is left IN PROGRESS in the workspace (\`${intent.workspace_path ?? '<no workspace>'}\`): the conflicted files contain merge markers, and \`.git/rebase-*\` is on disk. Resolve the conflicts in-tree, \`git add\` the resolved files, and \`git rebase --continue\` (repeat per replayed commit). When the rebase finishes, re-run typecheck + tests, then transition back to the reviewer.`,
    );
  } else {
    lines.push(
      `GitHub reports a conflict against \`origin/${intent.base_branch}\`. In the workspace (\`${intent.workspace_path ?? '<no workspace>'}\`), run \`git fetch origin ${intent.base_branch} && git rebase origin/${intent.base_branch}\`, resolve any conflicts in-tree, \`git rebase --continue\`, ensure typecheck + tests pass, then transition back to the reviewer.`,
    );
  }
  return lines.join('\n');
}
