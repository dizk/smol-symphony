// PR autopilot resource (issue 38 / reconciler stage 4). Owns the lifecycle of
// each terminal-state issue's GitHub PR: keeps it rebased on origin/<base>, arms
// `gh pr merge --auto`, and routes rebase conflicts back to the implementing
// state with the conflict context attached. Sits behind `pr_autopilot.enabled`
// so a workflow that hasn't opted in observes no behavior change at runtime.
//
// Desired state per issue:
//   - identifier in `merge_state` (e.g. Done) with an open PR:
//       PR is rebased on origin/<base> and `gh pr merge --auto --<strategy>` is armed.
//   - identifier in `merge_state` whose PR has merged or closed:
//       local + (best-effort) remote branch deleted; workspace removed.
//   - identifier in `close_state` (e.g. Cancelled) with an open PR:
//       PR closed without merge; branches deleted.
//
// Actual state per issue:
//   - PR view from `gh pr view <#> --json mergeable,base/head ref/oid,…`.
//     Cached for `poll_interval_ms` per PR so a fast reconcile cadence does not
//     storm the GH API.
//
// Conflict handling: rebase conflict ≠ operator's problem. The resource:
//   1. Counts the attempt (per-identifier).
//   2. Appends a structured notes block to the issue file via the tracker's
//      moveIssueToState — same code path the MCP transition tool uses, so
//      file locking and atomic-write rules are unchanged.
//   3. Routes the issue from merge_state back to `conflict_route_to` (default:
//      first declared active state). The workspace + agent/<id> branch survive
//      across the active-state transition naturally (per the orchestrator's
//      role-driven cleanup rule), and the dispatch loop picks up the issue
//      again with the conflict markers in place.
//   4. After `max_rebase_attempts` consecutive failures, routes to the
//      configured holding state (default: a `Conflict` state if declared) so
//      the operator can intervene.
//
// All git + GH I/O is behind injectable callbacks. Production wires real
// shell-outs (see `./pr-adapters.ts` — the shell module that implements PrApi
// + PrGitApi against `gh` / `git` on the host); tests pass synchronous stubs.

import { log } from '../logging.js';
import { realClock, type ClockNow } from '../util/clock.js';
import { ResourceActionLedger } from './ledger.js';
import {
  decidePr,
  type EnsureWorkspaceOutcome,
  type PrCacheView,
  type PrEffect,
  type PrIntent,
  type PrObservation,
  type PrSummary,
  type PrView,
  type PushOutcome,
  type RebaseOutcome,
} from './pr-decide.js';
import type { ResourceSnapshot } from './types.js';

export type {
  EnsureWorkspaceOutcome,
  PrIntent,
  PrIntentKind,
  PrMergeable,
  PrState,
  PrSummary,
  PrView,
  PushOutcome,
  RebaseOutcome,
} from './pr-decide.js';

export interface PrIntendedProvider {
  /** Returns every issue the autopilot should currently be managing. */
  prIntended(): Promise<PrIntent[]>;
}

/**
 * GitHub-facing operations. Production wires `gh` CLI shell-outs; tests pass a
 * stub that records calls. Errors surface as thrown Errors — the resource
 * catches them at the action boundary and pushes a `kind: 'error'` entry into
 * the action ledger.
 */
export interface PrApi {
  /**
   * Look up a PR whose head ref is `branch`, in any state (open, merged,
   * closed). Returns the most recent match, or null when no PR has ever
   * existed for this branch. State-agnostic by design: once GitHub
   * auto-merges or an operator closes the PR, an OPEN-only filter would
   * stop returning it and the autopilot would never observe the terminal
   * state. `view(number)` is the source of truth for actual state.
   */
  listForBranch(branch: string): Promise<PrSummary | null>;
  /** Detailed PR view. Throws on transport error or unrecognized response. */
  view(prNumber: number): Promise<PrView>;
  /** Arm GitHub's auto-merge. Idempotent — gh re-arms cleanly. */
  armAutoMerge(prNumber: number, strategy: 'squash' | 'merge' | 'rebase'): Promise<void>;
  /** Close a PR without merging. */
  closePr(prNumber: number): Promise<void>;
  /** Delete a remote branch (best-effort; gh exits non-zero if already gone). */
  deleteRemoteBranch(branch: string): Promise<void>;
}

/**
 * Git-facing operations executed inside the per-issue workspace. The rebase
 * step also captures the conflicted file list so the conflict notes that get
 * appended to the tracker file are concrete (file paths + counts) rather than
 * a generic "merge failed" line.
 */
export interface PrGitApi {
  /**
   * Rebase `branch` onto `origin/<baseBranch>` inside `workspacePath`. The
   * `expectedHeadSha` is the SHA the reconciler last saw on the PR; mismatches
   * surface as `kind: 'concurrent_push'` (someone else pushed in the meantime)
   * so the reconciler defers rather than clobbering.
   */
  rebaseOnto(args: {
    workspacePath: string;
    branch: string;
    baseBranch: string;
    expectedHeadSha: string;
  }): Promise<RebaseOutcome>;
  /** Force-with-lease push the rebased branch back to origin. */
  pushForceWithLease(args: {
    workspacePath: string;
    branch: string;
    expectedHeadSha: string;
  }): Promise<PushOutcome>;
}

/**
 * Append a notes block + move the tracker file from `fromState` to `toState`.
 * Same shape as the MCP transition tool's tracker call so existing locking /
 * atomic-write guarantees apply.
 */
export interface PrTransitionApi {
  routeIssue(args: {
    identifier: string;
    fromState: string;
    toState: string;
    notes: string;
    actor: string;
  }): Promise<void>;
}

/**
 * Workspace + branch cleanup after a PR completes (merged or closed). The
 * remote branch is handled separately via {@link PrApi.deleteRemoteBranch}
 * because GitHub's `--delete-branch` flag already covers the merge path;
 * Cancelled close uses the explicit delete.
 */
export interface PrCleanupApi {
  removeWorkspace(identifier: string): Promise<void>;
}

/**
 * Idempotent materializer for the autopilot's per-issue workspace. Production
 * wires this to a closure that re-clones the source repo, fetches the remote
 * `agent/<id>` branch, and positions the local branch at the remote tip so
 * the standard rebase flow can run.
 *
 * Why this exists: an operator who flips `pr_autopilot.enabled` true after an
 * issue has already reached Done (and its workspace has been reaped by the
 * pre-autopilot terminal cleanup) leaves the autopilot with a non-null
 * `workspace_path` pointing at a missing directory. Without this seam the
 * rebase step would throw silently in git (the directory doesn't exist) and
 * the PR would stay BEHIND forever.
 *
 * The callback MUST be idempotent: the resource calls it on every rebase
 * pass, and production typically short-circuits when the directory already
 * exists.
 */
export interface PrWorkspaceEnsureApi {
  ensureWorkspace(args: {
    identifier: string;
    workspacePath: string;
    branch: string;
    baseBranch: string;
    expectedHeadSha: string;
  }): Promise<EnsureWorkspaceOutcome>;
}

export interface PrResourceOptions {
  intended: PrIntendedProvider;
  pr: PrApi;
  git: PrGitApi;
  transition: PrTransitionApi;
  cleanup: PrCleanupApi;
  /**
   * Optional workspace materializer. When wired (production), the resource
   * calls it before every rebase so a missing workspace (autopilot enabled
   * after the dir was reaped, see issue 53) is re-cloned + repositioned on
   * the remote branch tip rather than silently failing in `git rebaseOnto`.
   * Tests that stub `git.rebaseOnto` may omit this; the resource skips the
   * pre-rebase ensure when it's absent.
   */
  workspaceEnsure?: PrWorkspaceEnsureApi;
  /**
   * GitHub auto-merge strategy. Mirrors the workflow's
   * `pr_autopilot.auto_merge_strategy`; the resource doesn't hardcode 'squash'
   * because some projects prefer 'merge' (preserve every agent commit) or
   * 'rebase' (linear history).
   */
  strategy: 'squash' | 'merge' | 'rebase';
  /** Maximum consecutive rebase attempts before circuit-breaking. */
  maxRebaseAttempts: number;
  /**
   * State the resource routes a conflict-rebasing issue back into. v1
   * defaults to the first declared active state; the orchestrator resolves
   * this from the workflow before constructing the resource.
   */
  conflictRouteTo: string;
  /**
   * Holding state the resource routes into after `maxRebaseAttempts`
   * consecutive failures. When null the circuit-broken issue stays in the
   * merge state and a `last_error` annotation surfaces on the dashboard.
   */
  conflictHoldingState: string | null;
  /**
   * Per-PR cache TTL. `gh pr view` and `gh pr list` results within the
   * window are reused. 0 disables caching (used by tests that want every
   * pass to re-fetch).
   */
  pollIntervalMs: number;
  /** Operator-visible actor label stamped into transition notes. */
  actor?: string;
  /**
   * Wall clock used for lookup/view TTL bookkeeping and ledger timestamps.
   * Defaults to `realClock` (the production wall clock, imported from the
   * foundation `util/clock` module rather than referencing `Date.now()` from
   * core directly). Tests pin a deterministic clock.
   */
  now?: ClockNow;
}

interface PerIssueState {
  // Cached PR lookup. `prSummary` is the PR number+url for this issue's
  // branch. Once non-null it is STICKY for the resource's lifetime: PR
  // numbers don't change, and a previously-discovered PR moving from OPEN
  // → MERGED/CLOSED must not blank the cache (otherwise the next
  // `listForBranch` may return null after the OPEN-filter, or the terminal
  // PR could disappear from the most-recent slot, and the autopilot would
  // never observe the terminal state to drive cleanup). `lastLookupAt`
  // governs only the cache miss path (null result, re-poll on TTL).
  // `lastViewAt` is independent because `view(number)` is the freshness
  // call once the number is known.
  prSummary: PrSummary | null | undefined; // undefined = never looked up
  lastLookupAt: number;
  prView: PrView | null;
  lastViewAt: number;
  // Rebase attempt counter. Persisted across Done → conflict_route_to →
  // ... → Done cycles so the circuit breaker accumulates consecutive
  // failures (see issue 38 acceptance criteria). Reset only on a
  // successful rebase, terminal cleanup (merge/close), or a circuit-broken
  // route to the holding state — NOT when the identifier leaves the
  // intended set or when we route back to the implementing state.
  rebaseAttempts: number;
  lastObservedHeadSha: string | null;
  // True once we've called armAutoMerge for this PR; idempotency lives in
  // the action (gh accepts re-arming), but tracking this lets the snapshot
  // surface "armed" without re-querying.
  armed: boolean;
  // Cleanup latch. Once a merged/closed PR's workspace + remote branch
  // have been reaped we don't want to re-arm or rebase on subsequent ticks.
  completed: boolean;
}

const MAX_ACTION_HISTORY = 64;

export class PrResource {
  readonly id = 'pr';
  readonly dependsOn: string[] = [];

  private state = new Map<string, PerIssueState>();
  private lastError: string | null = null;
  private readonly now: () => number;
  private readonly actor: string;
  private readonly ledger: ResourceActionLedger;

  constructor(private readonly opts: PrResourceOptions) {
    this.now = opts.now ?? realClock;
    this.actor = opts.actor ?? 'pr-autopilot';
    this.ledger = new ResourceActionLedger(this.id, {
      now: this.now,
      maxHistory: MAX_ACTION_HISTORY,
    });
  }

  ready(): boolean {
    return true;
  }

  /**
   * One reconcile pass. Returns when every intended issue has been considered
   * (a single in-flight action per issue is awaited in series — concurrent
   * git operations across distinct workspaces are safe in principle, but the
   * orchestrator's broader concurrency model expects serial action ledger
   * writes within a single resource). Errors are caught at the action
   * boundary so one failing issue does not block the rest.
   */
  async reconcile(): Promise<void> {
    let intents: PrIntent[];
    try {
      intents = await this.opts.intended.prIntended();
    } catch (err) {
      const msg = (err as Error).message;
      this.lastError = `pr_intended_fetch_failed: ${msg}`;
      log.warn('pr reconcile: intended fetch failed', { error: msg });
      return;
    }

    // For identifiers no longer in the intended set, clear the transient
    // fields (cached PR view, head SHA, armed flag, completed latch) so
    // when they return we re-resolve everything from gh — but KEEP the
    // rebaseAttempts counter so the circuit breaker accumulates across
    // Done → conflict_route_to → ... → Done cycles. Without this, the
    // counter would reset every time we route a conflict, and the
    // max_rebase_attempts breaker would be unreachable in practice.
    const wanted = new Set(intents.map((i) => i.identifier));
    for (const id of [...this.state.keys()]) {
      if (!wanted.has(id)) {
        const st = this.state.get(id)!;
        if (st.rebaseAttempts === 0) {
          // Nothing to remember — drop the whole entry to bound the map.
          this.state.delete(id);
        } else {
          this.resetTransient(st);
        }
      }
    }

    // Reset per-pass error so a transient failure that has resolved doesn't
    // keep haunting the snapshot. Per-action errors will repopulate it.
    this.lastError = null;

    for (const intent of intents) {
      try {
        await this.processIntent(intent);
      } catch (err) {
        const msg = (err as Error).message;
        this.lastError = msg;
        log.warn('pr reconcile: per-issue pass threw', {
          identifier: intent.identifier,
          kind: intent.kind,
          error: msg,
        });
      }
    }
  }

  snapshot(): ResourceSnapshot {
    return {
      id: this.id,
      ready: true,
      desired_hash: null,
      last_error: this.lastError,
      actions: this.ledger.snapshot(),
    };
  }

  /** Test helper: read the rebase attempt count for an identifier. */
  rebaseAttemptsFor(identifier: string): number {
    return this.state.get(identifier)?.rebaseAttempts ?? 0;
  }

  /** Test helper: read the cached PR view (post-pass). */
  viewFor(identifier: string): PrView | null {
    return this.state.get(identifier)?.prView ?? null;
  }

  private getOrInit(identifier: string): PerIssueState {
    let st = this.state.get(identifier);
    if (!st) {
      st = {
        prSummary: undefined,
        lastLookupAt: 0,
        prView: null,
        lastViewAt: 0,
        rebaseAttempts: 0,
        lastObservedHeadSha: null,
        armed: false,
        completed: false,
      };
      this.state.set(identifier, st);
    }
    return st;
  }

  /**
   * Wipe everything except `rebaseAttempts`. Used when an identifier leaves
   * the intended set (typically because we routed it back to the implementing
   * state for an agent to resolve) so the next return to the merge state
   * starts with a fresh PR view but keeps the consecutive-conflict counter.
   */
  private resetTransient(st: PerIssueState): void {
    st.prSummary = undefined;
    st.lastLookupAt = 0;
    st.prView = null;
    st.lastViewAt = 0;
    st.lastObservedHeadSha = null;
    st.armed = false;
    st.completed = false;
  }

  /**
   * Drive one intent through the decide → apply loop. Observation is rebuilt
   * incrementally as each effect runs: `observe_summary` / `observe_view` /
   * `rebase_and_push` populate fields the next `decidePr` call consults; pure
   * cache mutations fold straight into the next iteration's `cache` snapshot.
   * The cap is a defensive guard — decide reduces work on every iteration
   * (a `_resolved` flag flips, or an outcome lands) so it terminates well
   * inside the bound.
   */
  private async processIntent(intent: PrIntent): Promise<void> {
    let obs = this.buildObservation(intent);
    for (let i = 0; i < 12; i += 1) {
      const effects = decidePr(obs);
      if (effects.length === 0) return;
      for (const eff of effects) {
        obs = await this.applyEffect(eff, obs);
      }
    }
    log.warn('pr reconcile: decide loop iteration cap reached', {
      identifier: intent.identifier,
    });
  }

  private buildObservation(intent: PrIntent): PrObservation {
    const st = this.getOrInit(intent.identifier);
    return {
      intent,
      cache: this.cacheView(st),
      summaryResolved: false,
      summary: null,
      viewResolved: false,
      view: null,
      rebaseAttempted: false,
      rebaseOutcome: null,
      halt: false,
      config: {
        strategy: this.opts.strategy,
        maxRebaseAttempts: this.opts.maxRebaseAttempts,
        conflictRouteTo: this.opts.conflictRouteTo,
        conflictHoldingState: this.opts.conflictHoldingState,
      },
    };
  }

  private cacheView(st: PerIssueState): PrCacheView {
    return {
      completed: st.completed,
      armed: st.armed,
      lastObservedHeadSha: st.lastObservedHeadSha,
      rebaseAttempts: st.rebaseAttempts,
    };
  }

  private static readonly EMPTY_CACHE: PrCacheView = {
    completed: false,
    armed: false,
    lastObservedHeadSha: null,
    rebaseAttempts: 0,
  };

  /**
   * Apply one effect from `decidePr`. IO effects route through the existing
   * ledger-wrapped port helpers; cache mutations land on the live
   * `PerIssueState` and the returned observation reflects the new cache view
   * so the next `decidePr` call sees the change.
   */
  private async applyEffect(eff: PrEffect, obs: PrObservation): Promise<PrObservation> {
    switch (eff.kind) {
      case 'observe_summary': {
        const st = this.getOrInit(eff.identifier);
        const summary = await this.lookupPrSummary(obs.intent, st);
        return { ...obs, summaryResolved: true, summary, cache: this.cacheView(st) };
      }
      case 'observe_view': {
        const st = this.getOrInit(eff.identifier);
        const view = await this.fetchPrView(eff.identifier, eff.prNumber, st);
        return { ...obs, viewResolved: true, view, cache: this.cacheView(st) };
      }
      case 'rebase_and_push': {
        const st = this.getOrInit(eff.identifier);
        const outcome = await this.runRebase(obs.intent, obs.view!, st);
        return {
          ...obs,
          rebaseAttempted: true,
          rebaseOutcome: outcome,
          cache: this.cacheView(st),
        };
      }
      case 'arm_auto_merge': {
        await this.runArmAutoMerge(eff.identifier, eff.prNumber, eff.strategy);
        const st = this.getOrInit(eff.identifier);
        st.armed = true;
        return { ...obs, cache: this.cacheView(st) };
      }
      case 'close_pr': {
        await this.runClosePr(eff.identifier, eff.prNumber);
        return obs;
      }
      case 'delete_remote_branch': {
        await this.runDeleteRemoteBranch(eff.identifier, eff.branch);
        return obs;
      }
      case 'cleanup_workspace': {
        await this.runCleanupWorkspace(eff.identifier);
        return obs;
      }
      case 'route_conflict': {
        await this.runConflictTransition(eff);
        return { ...obs, halt: true };
      }
      case 'log_concurrent_push': {
        log.info('pr reconcile: deferring, head SHA changed since last observation', {
          identifier: eff.identifier,
          observed: eff.observed,
          now: eff.now,
        });
        return obs;
      }
      case 'update_observed_head': {
        const st = this.getOrInit(eff.identifier);
        st.lastObservedHeadSha = eff.sha;
        // Emitted only in defer paths (concurrent-push detection + rebase
        // outcome=concurrent_push). Treat as terminal for this pass.
        return { ...obs, cache: this.cacheView(st), halt: true };
      }
      case 'mark_completed': {
        const st = this.getOrInit(eff.identifier);
        st.completed = true;
        return { ...obs, cache: this.cacheView(st) };
      }
      case 'reset_attempts': {
        const st = this.getOrInit(eff.identifier);
        st.rebaseAttempts = 0;
        return { ...obs, cache: this.cacheView(st) };
      }
      case 'increment_attempts': {
        const st = this.getOrInit(eff.identifier);
        st.rebaseAttempts = eff.attempt;
        log.info('pr reconcile: conflict attempt', {
          identifier: eff.identifier,
          attempt: eff.attempt,
          max: eff.max,
        });
        return { ...obs, cache: this.cacheView(st) };
      }
      case 'reset_transient': {
        const st = this.state.get(eff.identifier);
        if (st) this.resetTransient(st);
        // Always paired with route_conflict (route_to_implementing branch);
        // terminal for this pass.
        return {
          ...obs,
          cache: st ? this.cacheView(st) : PrResource.EMPTY_CACHE,
          halt: true,
        };
      }
      case 'forget_identifier': {
        this.state.delete(eff.identifier);
        // Paired with route_conflict in the circuit-broken branch.
        return { ...obs, cache: PrResource.EMPTY_CACHE, halt: true };
      }
      case 'clamp_attempts': {
        const st = this.getOrInit(eff.identifier);
        st.rebaseAttempts = eff.value;
        // Only emitted in the breaker no-holding-state branch; terminal.
        return { ...obs, cache: this.cacheView(st), halt: true };
      }
      case 'set_last_error': {
        this.lastError = eff.message;
        // Emitted only after rebase outcome=error or breaker no-holding;
        // both are terminal for the pass.
        return { ...obs, halt: true };
      }
    }
  }

  // ─── helpers: per-action wrappers with ledger + cache plumbing ──────────

  private async lookupPrSummary(
    intent: PrIntent,
    st: PerIssueState,
  ): Promise<PrSummary | null> {
    // Sticky cache once we have a number: PR numbers don't change, and the
    // PR moving to MERGED/CLOSED must not cause us to "forget" it — that
    // would skip the terminal observation the autopilot needs to drive
    // cleanup. Re-listing is restricted to the never-found-yet / still-null
    // paths below.
    if (st.prSummary) return st.prSummary;
    const now = this.now();
    if (
      st.prSummary === null &&
      now - st.lastLookupAt < this.opts.pollIntervalMs
    ) {
      // Still in the null-result TTL window: defer instead of re-querying.
      return null;
    }
    const actionKey = `list_pr_for_branch:${intent.identifier}`;
    this.ledger.start(actionKey);
    try {
      const result = await this.opts.pr.listForBranch(intent.branch);
      st.prSummary = result;
      st.lastLookupAt = now;
      this.ledger.done(actionKey);
      return result;
    } catch (err) {
      const msg = (err as Error).message;
      this.lastError = `list_pr_failed: ${msg}`;
      this.ledger.error(actionKey, msg);
      return null;
    }
  }

  private async fetchPrView(
    identifier: string,
    prNumber: number,
    st: PerIssueState,
  ): Promise<PrView | null> {
    const now = this.now();
    if (st.prView !== null && now - st.lastViewAt < this.opts.pollIntervalMs) {
      return st.prView;
    }
    const actionKey = `view_pr:${prNumber}`;
    this.ledger.start(actionKey);
    try {
      const view = await this.opts.pr.view(prNumber);
      st.prView = view;
      st.lastViewAt = now;
      // Pin the observed head SHA on the first successful view so the
      // concurrent-push guard has a reference even before the first rebase.
      if (st.lastObservedHeadSha === null) {
        st.lastObservedHeadSha = view.head_ref_oid;
      }
      st.armed = view.auto_merge_armed;
      this.ledger.done(actionKey);
      return view;
    } catch (err) {
      const msg = (err as Error).message;
      this.lastError = `view_pr_failed: ${msg}`;
      this.ledger.error(actionKey, msg);
      log.warn('pr reconcile: view failed', {
        identifier,
        pr_number: prNumber,
        error: msg,
      });
      return null;
    }
  }

  private async runRebase(
    intent: PrIntent,
    view: PrView,
    st: PerIssueState,
  ): Promise<RebaseOutcome> {
    const actionKey = `rebase_and_force_push:${intent.identifier}`;
    this.ledger.start(actionKey);
    if (intent.workspace_path === null) {
      // Defensive: callers should not invoke runRebase without a workspace.
      const msg = 'rebase requested without workspace path';
      this.ledger.error(actionKey, msg);
      log.warn('pr reconcile: rebase failed', {
        identifier: intent.identifier,
        stage: 'precondition',
        error: msg,
      });
      return { kind: 'error', diagnostic: msg };
    }
    // Issue 53: re-materialize a missing workspace on demand. The autopilot
    // owns the workspace once an issue enters merge_state; if it's been
    // reaped (e.g. operator flipped pr_autopilot enabled after the dir was
    // cleaned up by the pre-autopilot terminal rule), this restores it so
    // the rebase doesn't throw silently in git.
    if (this.opts.workspaceEnsure) {
      const ensure = await this.opts.workspaceEnsure.ensureWorkspace({
        identifier: intent.identifier,
        workspacePath: intent.workspace_path,
        branch: intent.branch,
        baseBranch: intent.base_branch,
        expectedHeadSha: view.head_ref_oid,
      });
      if (ensure.kind === 'error') {
        this.ledger.error(actionKey, ensure.diagnostic);
        log.warn('pr reconcile: rebase failed', {
          identifier: intent.identifier,
          stage: 'ensure_workspace',
          error: ensure.diagnostic,
        });
        return { kind: 'error', diagnostic: ensure.diagnostic };
      }
    }
    let rebase: RebaseOutcome;
    try {
      rebase = await this.opts.git.rebaseOnto({
        workspacePath: intent.workspace_path,
        branch: intent.branch,
        baseBranch: intent.base_branch,
        expectedHeadSha: view.head_ref_oid,
      });
    } catch (err) {
      const msg = (err as Error).message;
      this.ledger.error(actionKey, msg);
      log.warn('pr reconcile: rebase failed', {
        identifier: intent.identifier,
        stage: 'rebase_threw',
        error: msg,
      });
      return { kind: 'error', diagnostic: msg };
    }

    if (rebase.kind === 'ok') {
      // Force-with-lease push. The git side has already verified the
      // workspace's local HEAD matches the SHA we observed; the lease binds
      // the SHA we expect on the remote so a concurrent push between this
      // step and the previous one is detected (rather than silently
      // overwritten).
      let push: PushOutcome;
      try {
        push = await this.opts.git.pushForceWithLease({
          workspacePath: intent.workspace_path,
          branch: intent.branch,
          expectedHeadSha: view.head_ref_oid,
        });
      } catch (err) {
        const msg = (err as Error).message;
        this.ledger.error(actionKey, msg);
        log.warn('pr reconcile: rebase failed', {
          identifier: intent.identifier,
          stage: 'push_threw',
          error: msg,
        });
        return { kind: 'error', diagnostic: msg };
      }
      if (push.kind === 'concurrent_push') {
        this.ledger.error(actionKey, push.diagnostic);
        log.warn('pr reconcile: rebase failed', {
          identifier: intent.identifier,
          stage: 'push_concurrent',
          error: push.diagnostic,
        });
        return { kind: 'concurrent_push', observed_head_sha: view.head_ref_oid };
      }
      if (push.kind === 'error') {
        this.ledger.error(actionKey, push.diagnostic);
        log.warn('pr reconcile: rebase failed', {
          identifier: intent.identifier,
          stage: 'push_error',
          error: push.diagnostic,
        });
        return { kind: 'error', diagnostic: push.diagnostic };
      }
      this.ledger.done(actionKey);
      log.info('pr reconcile: rebase+push ok', {
        identifier: intent.identifier,
        new_head_sha: rebase.new_head_sha,
      });
      // After a successful push the PR's head SHA on GitHub will change to
      // the new SHA. Pin it locally so the next pass's view-vs-state diff
      // is correct.
      st.lastObservedHeadSha = rebase.new_head_sha;
      // Invalidate the view cache so the next pass sees fresh mergeable
      // state (the rebase may have changed it from CONFLICTING to
      // MERGEABLE or UNKNOWN).
      st.prView = null;
      st.lastViewAt = 0;
      return rebase;
    }
    const finalDiagnostic =
      rebase.kind === 'conflict'
        ? 'rebase conflict'
        : rebase.kind === 'concurrent_push'
        ? 'concurrent push'
        : rebase.kind === 'error'
        ? rebase.diagnostic
        : 'unknown';
    this.ledger.error(actionKey, finalDiagnostic);
    log.warn('pr reconcile: rebase failed', {
      identifier: intent.identifier,
      stage: 'rebase_outcome',
      outcome: rebase.kind,
      error: finalDiagnostic,
    });
    return rebase;
  }

  private async runArmAutoMerge(
    identifier: string,
    prNumber: number,
    strategy: 'squash' | 'merge' | 'rebase',
  ): Promise<void> {
    const actionKey = `arm_auto_merge:${prNumber}`;
    const res = await this.ledger.run(actionKey, () =>
      this.opts.pr.armAutoMerge(prNumber, strategy),
    );
    if (res.ok) {
      log.info('pr reconcile: armed auto-merge', {
        identifier,
        pr_number: prNumber,
        strategy,
      });
    } else {
      this.lastError = res.error;
    }
  }

  private async runClosePr(identifier: string, prNumber: number): Promise<void> {
    const actionKey = `close_pr:${prNumber}`;
    const res = await this.ledger.run(actionKey, () => this.opts.pr.closePr(prNumber));
    if (res.ok) {
      log.info('pr reconcile: closed pr', { identifier, pr_number: prNumber });
    } else {
      this.lastError = res.error;
    }
  }

  private async runDeleteRemoteBranch(identifier: string, branch: string): Promise<void> {
    const actionKey = `delete_remote_branch:${branch}`;
    const res = await this.ledger.run(actionKey, () => this.opts.pr.deleteRemoteBranch(branch));
    if (!res.ok) {
      // Remote-branch deletion is best-effort — the branch may already be
      // gone (gh exits non-zero), or the operator may have removed it. We
      // log at info, surface in last_error, and move on.
      this.lastError = `delete_remote_branch_failed: ${res.error}`;
      log.info('pr reconcile: remote branch delete failed (best-effort)', {
        identifier,
        branch,
        error: res.error,
      });
    }
  }

  private async runCleanupWorkspace(identifier: string): Promise<void> {
    const actionKey = `cleanup_workspace:${identifier}`;
    const res = await this.ledger.run(actionKey, () =>
      this.opts.cleanup.removeWorkspace(identifier),
    );
    if (!res.ok) this.lastError = res.error;
  }

  /**
   * Apply the `route_conflict` effect: same tracker.routeIssue call shape and
   * action-ledger key as before. Counter increment + state cleanup
   * (`reset_transient` / `forget_identifier`) ride as separate effects
   * emitted by `decidePr` so the breaker logic is testable as pure data.
   */
  private async runConflictTransition(
    eff: Extract<PrEffect, { kind: 'route_conflict' }>,
  ): Promise<void> {
    const actionKey = `route_to_conflict:${eff.identifier}:${eff.toState.toLowerCase()}`;
    const res = await this.ledger.run(actionKey, () =>
      this.opts.transition.routeIssue({
        identifier: eff.identifier,
        fromState: eff.fromState,
        toState: eff.toState,
        notes: eff.notes,
        actor: this.actor,
      }),
    );
    if (res.ok) {
      log.info('pr reconcile: routed to conflict-handling state', {
        identifier: eff.identifier,
        from_state: eff.fromState,
        to_state: eff.toState,
      });
    } else {
      this.lastError = res.error;
      log.warn('pr reconcile: conflict route failed', {
        identifier: eff.identifier,
        to_state: eff.toState,
        error: res.error,
      });
    }
  }
}

