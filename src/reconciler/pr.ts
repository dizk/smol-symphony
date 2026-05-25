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
// shell-outs; tests pass synchronous stubs.

import { stat } from 'node:fs/promises';
import path from 'node:path';
import { log } from '../logging.js';
import { runProcess } from '../util/process.js';
import { ResourceActionLedger } from './ledger.js';
import type { ResourceSnapshot } from './types.js';

/**
 * True iff `<workspacePath>/.git/rebase-merge` or `.git/rebase-apply` exists
 * as a directory. Git creates either depending on whether the rebase used
 * merge (`-m`) or am (default for `rebase --apply`) backend; testing both
 * keeps the check robust across git versions. Issue 55.
 */
async function rebaseInProgress(workspacePath: string): Promise<boolean> {
  for (const dir of ['.git/rebase-merge', '.git/rebase-apply']) {
    try {
      const st = await stat(path.join(workspacePath, dir));
      if (st.isDirectory()) return true;
    } catch {
      // ENOENT / permission / etc — treat as "not in progress."
    }
  }
  return false;
}

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

export interface PrIntendedProvider {
  /** Returns every issue the autopilot should currently be managing. */
  prIntended(): Promise<PrIntent[]>;
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

export type RebaseOutcome =
  | { kind: 'ok'; new_head_sha: string }
  | { kind: 'conflict'; files: string[]; diagnostic: string }
  | { kind: 'concurrent_push'; observed_head_sha: string }
  | { kind: 'error'; diagnostic: string };

export type PushOutcome =
  | { kind: 'ok' }
  | { kind: 'concurrent_push'; diagnostic: string }
  | { kind: 'error'; diagnostic: string };

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

export type EnsureWorkspaceOutcome =
  | { kind: 'ok' }
  | { kind: 'error'; diagnostic: string };

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
  /** Override for the wall clock (tests pin time). */
  now?: () => number;
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
    this.now = opts.now ?? (() => Date.now());
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
        if (intent.kind === 'merge') {
          await this.processMerge(intent);
        } else {
          await this.processClose(intent);
        }
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

  private async processMerge(intent: PrIntent): Promise<void> {
    const st = this.getOrInit(intent.identifier);
    if (st.completed) return;

    // 1) Resolve the open PR for this branch.
    const summary = await this.lookupPrSummary(intent, st);
    if (!summary) {
      // No open PR; nothing to drive. v1 stops here — the operator either
      // opens it manually or symphony's terminal hook opens it on the next
      // dispatch into this state.
      return;
    }

    // 2) Fetch the detailed PR view (cached per poll interval).
    const view = await this.fetchPrView(intent.identifier, summary.number, st);
    if (!view) return;

    // 3) On terminal PR state, drive cleanup and latch.
    if (view.state === 'MERGED') {
      await this.cleanupAfterMerge(intent, view);
      st.completed = true;
      return;
    }
    if (view.state === 'CLOSED') {
      // The PR was closed (likely by the operator) instead of merging.
      // The issue contract says PR closed -> cleanup_branches, so reap
      // the remote agent/<id> branch alongside the workspace; otherwise
      // an operator-closed PR would leave the branch on origin forever.
      // The delete is best-effort (gh exits non-zero if it's already gone).
      await this.runDeleteRemoteBranch(intent.identifier, intent.branch);
      await this.runCleanupWorkspace(intent.identifier);
      st.completed = true;
      return;
    }

    // 4) PR is open. Defer when a concurrent push has changed the head SHA
    //    since our last observation — the operator (or a sibling tool) is
    //    touching the branch.
    if (
      st.lastObservedHeadSha !== null &&
      st.lastObservedHeadSha !== view.head_ref_oid
    ) {
      log.info('pr reconcile: deferring, head SHA changed since last observation', {
        identifier: intent.identifier,
        observed: st.lastObservedHeadSha,
        now: view.head_ref_oid,
      });
      st.lastObservedHeadSha = view.head_ref_oid;
      return;
    }

    // 5) Rebase path. Always attempt the host-side rebase when we have a
    //    workspace, even when gh reports `mergeable: CONFLICTING` — running
    //    the rebase leaves merge markers and `.git/rebase-merge` on disk
    //    so the agent dispatched into the routed-back state has a concrete
    //    conflict to resolve in-tree (no network fetch needed inside the
    //    VM). Without this, a CONFLICTING-on-first-encounter reroute would
    //    hand the agent a clean workspace and they'd have no actionable
    //    conflict to chase. Issue 55.
    //
    //    When there's no workspace to drive from (autopilot enabled
    //    mid-flight and the dir was already reaped), fall back below to the
    //    textual-notes route on CONFLICTING. Arming auto-merge runs after,
    //    on MERGEABLE/UNKNOWN.
    if (intent.workspace_path !== null) {
      const rebase = await this.runRebase(intent, view, st);
      if (rebase.kind === 'conflict') {
        await this.handleConflict(intent, view, rebase);
        return;
      }
      if (rebase.kind === 'concurrent_push') {
        // Defer: someone else has the lease (or an in-progress rebase is
        // mid-resolution — see GitCliPrGitApi.rebaseOnto's rebase-in-progress
        // guard).
        st.lastObservedHeadSha = rebase.observed_head_sha;
        return;
      }
      if (rebase.kind === 'error') {
        this.lastError = rebase.diagnostic;
        return;
      }
      if (rebase.kind === 'ok') {
        st.lastObservedHeadSha = rebase.new_head_sha;
        // Successful rebase resets the attempt counter — we're past the
        // failure that bumped it. (No-op when count is already 0.)
        st.rebaseAttempts = 0;
      }
    } else if (view.mergeable === 'CONFLICTING') {
      await this.handleConflict(intent, view, /*conflictFiles*/ null);
      return;
    }

    // 7) Arm auto-merge once the PR is in a sane state. gh re-arms cleanly
    //    so we don't need to track this beyond a snapshot bit.
    if (!st.armed) {
      await this.runArmAutoMerge(intent.identifier, view);
      st.armed = true;
    }
  }

  private async processClose(intent: PrIntent): Promise<void> {
    const st = this.getOrInit(intent.identifier);
    if (st.completed) return;
    const summary = await this.lookupPrSummary(intent, st);
    if (!summary) {
      // No PR to close. Mark completed so we don't keep relooking.
      st.completed = true;
      return;
    }
    const view = await this.fetchPrView(intent.identifier, summary.number, st);
    if (!view) return;
    if (view.state === 'MERGED' || view.state === 'CLOSED') {
      // PR is already terminal — the operator closed/merged it before the
      // autopilot got to it. Still attempt the remote-branch delete: a PR
      // closed by hand typically leaves `agent/<id>` behind on origin, and
      // the contract says cleanup_branches fires whenever a closed-or-merged
      // PR has a branch present. Best-effort; gh exits non-zero on absence.
      await this.runDeleteRemoteBranch(intent.identifier, intent.branch);
      st.completed = true;
      return;
    }
    await this.runClosePr(intent.identifier, view, intent.branch);
    st.completed = true;
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

  private async runArmAutoMerge(identifier: string, view: PrView): Promise<void> {
    const actionKey = `arm_auto_merge:${view.number}`;
    const res = await this.ledger.run(actionKey, () =>
      this.opts.pr.armAutoMerge(view.number, this.opts.strategy),
    );
    if (res.ok) {
      log.info('pr reconcile: armed auto-merge', {
        identifier,
        pr_number: view.number,
        strategy: this.opts.strategy,
      });
    } else {
      this.lastError = res.error;
    }
  }

  private async runClosePr(
    identifier: string,
    view: PrView,
    branch: string,
  ): Promise<void> {
    const actionKey = `close_pr:${view.number}`;
    const res = await this.ledger.run(actionKey, () => this.opts.pr.closePr(view.number));
    if (res.ok) {
      log.info('pr reconcile: closed pr', {
        identifier,
        pr_number: view.number,
      });
    } else {
      this.lastError = res.error;
      return;
    }
    // Delete the remote branch separately. `--delete-branch` on the close
    // would do it, but the API contract makes the delete explicit so we get
    // a per-action ledger entry on failure (e.g. the branch was already
    // removed by an operator).
    await this.runDeleteRemoteBranch(identifier, branch);
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

  private async cleanupAfterMerge(intent: PrIntent, view: PrView): Promise<void> {
    // GitHub already deleted the remote branch via `--delete-branch` on the
    // arm. We still attempt a delete here so a misconfigured arm (operator
    // armed manually without --delete-branch) still ends in a clean state;
    // the delete is best-effort, so a "branch not found" is silent.
    await this.runDeleteRemoteBranch(intent.identifier, intent.branch);
    await this.runCleanupWorkspace(intent.identifier);
    log.info('pr reconcile: merged, cleanup complete', {
      identifier: intent.identifier,
      pr_number: view.number,
    });
  }

  /**
   * Append a structured notes block to the issue file and move it from the
   * merge state back into the conflict-route state (or, after exceeding the
   * attempt limit, into the holding state). The agent there sees the notes
   * as part of its prompt and is expected to resolve the conflict in the
   * preserved workspace.
   */
  private async handleConflict(
    intent: PrIntent,
    view: PrView,
    rebase: Extract<RebaseOutcome, { kind: 'conflict' }> | null,
  ): Promise<void> {
    const st = this.getOrInit(intent.identifier);
    st.rebaseAttempts += 1;
    const attempt = st.rebaseAttempts;
    const max = this.opts.maxRebaseAttempts;

    // Observability: emit the counter's progress toward the breaker on every
    // route, regardless of whether this is a route-to-implementing or a
    // route-to-holding. The route log line that follows reports the to_state
    // but not the attempt number — without this, reconstructing whether the
    // breaker tripped on time requires correlating timestamps by hand.
    log.info('pr reconcile: conflict attempt', {
      identifier: intent.identifier,
      attempt,
      max,
    });

    // With `max_rebase_attempts: N`, the Nth conflict route parks the issue
    // in the holding state. Pre-increment + `attempt >= max` means: routes 1
    // through N-1 go to conflict_route_to, route N goes to conflict_holding_state.
    // Both the gh-CONFLICTING and host-rebase-conflict paths in processMerge
    // funnel through this single increment, so the counter advances on every
    // observed conflict — no route can skip the count.
    if (attempt >= max) {
      // Circuit broken: route to the holding state if declared, else log a
      // hard error and stop attempting (the next pass will see the issue
      // still in merge_state and re-enter this branch).
      if (this.opts.conflictHoldingState === null) {
        this.lastError = `pr_autopilot: circuit broken for ${intent.identifier} after ${max} attempts; no conflict_holding_state declared`;
        log.warn('pr reconcile: circuit broken, no holding state declared', {
          identifier: intent.identifier,
          attempts: attempt,
        });
        // Clamp the counter at `max` so it doesn't grow unbounded if the
        // issue stays in the merge state without a holding-state route.
        st.rebaseAttempts = max;
        return;
      }
      const notes = this.buildConflictNotes({
        intent,
        view,
        rebase,
        attempt: max,
        max,
        circuitBroken: true,
      });
      await this.runConflictTransition(intent, this.opts.conflictHoldingState, notes);
      // After circuit-broken routing the operator is expected to intervene.
      // If the issue ever lands back in the merge state, start with a fresh
      // counter — the operator's intervention is treated as a hard reset of
      // the "consecutive failures" streak.
      this.state.delete(intent.identifier);
      return;
    }

    const notes = this.buildConflictNotes({
      intent,
      view,
      rebase,
      attempt,
      max,
      circuitBroken: false,
    });
    await this.runConflictTransition(intent, this.opts.conflictRouteTo, notes);
    // Keep `rebaseAttempts` so consecutive failures accumulate toward the
    // circuit breaker. Clear the transient PR data so the next return to the
    // merge state re-fetches a fresh PR view and head SHA. The intended-set
    // walk at the top of the next reconcile() pass will hit `resetTransient`
    // for this identifier (it's gone from the intended set while the agent
    // resolves), but doing it eagerly here makes the invariant local to the
    // route action.
    this.resetTransient(st);
  }

  private async runConflictTransition(
    intent: PrIntent,
    toState: string,
    notes: string,
  ): Promise<void> {
    const actionKey = `route_to_conflict:${intent.identifier}:${toState.toLowerCase()}`;
    const res = await this.ledger.run(actionKey, () =>
      this.opts.transition.routeIssue({
        identifier: intent.identifier,
        fromState: intent.state,
        toState,
        notes,
        actor: this.actor,
      }),
    );
    if (res.ok) {
      log.info('pr reconcile: routed to conflict-handling state', {
        identifier: intent.identifier,
        from_state: intent.state,
        to_state: toState,
      });
    } else {
      this.lastError = res.error;
      log.warn('pr reconcile: conflict route failed', {
        identifier: intent.identifier,
        to_state: toState,
        error: res.error,
      });
    }
  }

  private buildConflictNotes(args: {
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
}

// ─── default `gh` + `git` shell-out implementations ──────────────────────────
//
// Production wires these as PrApi / PrGitApi. Tests pass stubs. Both keep
// their I/O tightly scoped (specific gh subcommands, specific git args) so the
// surface stays narrow and a future migration to GitHub's REST API or a
// different git library is a single-file change.

interface ShellResult {
  exit: number;
  stdout: string;
  stderr: string;
}

// Thin shape adapter over the unified runProcess. `exit: -1` is the historical
// PR-autopilot sentinel for "spawn errored or process signalled"; map runProcess's
// `exit_code: null` into it so downstream gh-output / git-stderr parsing stays
// identical to the pre-refactor shape.
async function runShell(
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number } = {},
): Promise<ShellResult> {
  const r = await runProcess(cmd, args, {
    cwd: opts.cwd,
    timeoutMs: opts.timeoutMs,
    // PR autopilot's git/gh output can be large (rebase trees, gh json blobs);
    // keep the historical 1 MiB clamp rather than the 64 KiB default.
    maxBytes: 1_048_576,
  });
  return {
    exit: r.exit_code ?? -1,
    stdout: r.stdout,
    stderr: r.stderr,
  };
}

/** Default production PrApi backed by the `gh` CLI on the host. */
export class GhCliPrApi implements PrApi {
  constructor(private readonly opts: { timeoutMs?: number; cwd?: string } = {}) {}

  async listForBranch(branch: string): Promise<PrSummary | null> {
    // `--state all` so a PR that has merged or been closed is still
    // returned — once we have the number we drive cleanup via `view`,
    // which works against any state. An OPEN-only filter would make a
    // post-merge or operator-closed PR invisible to the autopilot.
    const res = await runShell(
      'gh',
      ['pr', 'list', '--head', branch, '--state', 'all', '--json', 'number,url', '--limit', '1'],
      this.opts,
    );
    if (res.exit !== 0) {
      throw new Error(`gh pr list failed (exit ${res.exit}): ${res.stderr.trim()}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(res.stdout);
    } catch (err) {
      throw new Error(`gh pr list returned non-JSON: ${(err as Error).message}`);
    }
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    const first = parsed[0] as { number?: unknown; url?: unknown };
    if (typeof first.number !== 'number' || typeof first.url !== 'string') return null;
    return { number: first.number, url: first.url };
  }

  async view(prNumber: number): Promise<PrView> {
    const res = await runShell(
      'gh',
      [
        'pr',
        'view',
        String(prNumber),
        '--json',
        'number,url,state,mergeable,baseRefName,baseRefOid,headRefName,headRefOid,reviewDecision,autoMergeRequest',
      ],
      this.opts,
    );
    if (res.exit !== 0) {
      throw new Error(`gh pr view ${prNumber} failed (exit ${res.exit}): ${res.stderr.trim()}`);
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(res.stdout) as Record<string, unknown>;
    } catch (err) {
      throw new Error(`gh pr view returned non-JSON: ${(err as Error).message}`);
    }
    return {
      number: typeof parsed.number === 'number' ? parsed.number : prNumber,
      url: typeof parsed.url === 'string' ? parsed.url : '',
      state: normalizeState(parsed.state),
      mergeable: normalizeMergeable(parsed.mergeable),
      base_ref_name: typeof parsed.baseRefName === 'string' ? parsed.baseRefName : '',
      base_ref_oid: typeof parsed.baseRefOid === 'string' ? parsed.baseRefOid : null,
      head_ref_name: typeof parsed.headRefName === 'string' ? parsed.headRefName : '',
      head_ref_oid: typeof parsed.headRefOid === 'string' ? parsed.headRefOid : '',
      review_decision: normalizeReviewDecision(parsed.reviewDecision),
      auto_merge_armed:
        parsed.autoMergeRequest !== null &&
        parsed.autoMergeRequest !== undefined &&
        typeof parsed.autoMergeRequest === 'object',
    };
  }

  async armAutoMerge(prNumber: number, strategy: 'squash' | 'merge' | 'rebase'): Promise<void> {
    const flag =
      strategy === 'merge' ? '--merge' : strategy === 'rebase' ? '--rebase' : '--squash';
    const res = await runShell(
      'gh',
      ['pr', 'merge', String(prNumber), '--auto', flag, '--delete-branch'],
      this.opts,
    );
    if (res.exit !== 0) {
      throw new Error(`gh pr merge --auto failed (exit ${res.exit}): ${res.stderr.trim()}`);
    }
  }

  async closePr(prNumber: number): Promise<void> {
    const res = await runShell('gh', ['pr', 'close', String(prNumber)], this.opts);
    if (res.exit !== 0) {
      throw new Error(`gh pr close failed (exit ${res.exit}): ${res.stderr.trim()}`);
    }
  }

  async deleteRemoteBranch(branch: string): Promise<void> {
    // `gh api -X DELETE` is the most direct path; falls back to `git push :branch`
    // via shell would require knowing the remote URL. gh is required by the
    // existing PR-create hook anyway so we can rely on it being present.
    const res = await runShell(
      'gh',
      ['api', '-X', 'DELETE', `repos/{owner}/{repo}/git/refs/heads/${branch}`],
      this.opts,
    );
    if (res.exit !== 0) {
      // 422 / 404 from gh api is "branch already gone" — surface as a soft
      // error so the resource records it but doesn't keep retrying.
      throw new Error(`gh api delete branch failed (exit ${res.exit}): ${res.stderr.trim()}`);
    }
  }
}

function normalizeState(raw: unknown): PrState {
  if (raw === 'OPEN' || raw === 'CLOSED' || raw === 'MERGED') return raw;
  return 'OPEN';
}
function normalizeMergeable(raw: unknown): PrMergeable {
  if (raw === 'MERGEABLE' || raw === 'CONFLICTING' || raw === 'UNKNOWN') return raw;
  return 'UNKNOWN';
}
function normalizeReviewDecision(raw: unknown): PrView['review_decision'] {
  if (raw === 'APPROVED' || raw === 'CHANGES_REQUESTED' || raw === 'REVIEW_REQUIRED') return raw;
  return null;
}

/** Default production PrGitApi backed by `git` shelled out in the workspace. */
export class GitCliPrGitApi implements PrGitApi {
  constructor(private readonly opts: { timeoutMs?: number; remote?: string } = {}) {}

  private get remote(): string {
    return this.opts.remote ?? 'origin';
  }

  async rebaseOnto(args: {
    workspacePath: string;
    branch: string;
    baseBranch: string;
    expectedHeadSha: string;
  }): Promise<RebaseOutcome> {
    // 1. Read the workspace's local HEAD up front.
    const head = await runShell(
      'git',
      ['rev-parse', 'HEAD'],
      { cwd: args.workspacePath, timeoutMs: this.opts.timeoutMs },
    );
    if (head.exit !== 0) {
      return { kind: 'error', diagnostic: `rev-parse HEAD failed: ${head.stderr.trim()}` };
    }
    const localHead = head.stdout.trim();
    // 2. If a rebase is already in progress (markers on disk in
    //    `.git/rebase-merge` / `.git/rebase-apply`), the agent we routed
    //    the conflict to is still resolving it. Bail without touching the
    //    workspace — finishing or aborting the rebase here would clobber
    //    exactly the state the agent is working on. Issue 55.
    if (await rebaseInProgress(args.workspacePath)) {
      return { kind: 'concurrent_push', observed_head_sha: localHead };
    }
    // 3. Fetch the base ref so origin/<base> is current.
    const fetch = await runShell(
      'git',
      ['fetch', '--no-tags', this.remote, args.baseBranch],
      { cwd: args.workspacePath, timeoutMs: this.opts.timeoutMs },
    );
    if (fetch.exit !== 0) {
      return { kind: 'error', diagnostic: `git fetch failed: ${fetch.stderr.trim()}` };
    }
    // 4. If local HEAD has diverged from the SHA we last saw on the PR,
    //    either an agent finished resolving a rebase in-tree (and the
    //    workspace is now on top of `origin/<base>`) or some unrelated
    //    local mutation happened. Distinguish via ancestry:
    //
    //      - `origin/<base>` is an ancestor of localHead → agent rebased.
    //        Return ok so the caller force-with-leases the resolved branch.
    //        Issue 55 — without this the conflict-routed agent could resolve
    //        but the autopilot would forever return concurrent_push and the
    //        PR would never flip CONFLICTING → MERGEABLE.
    //      - Otherwise → unexpected local divergence. Return concurrent_push
    //        so the autopilot defers rather than clobbering work it can't
    //        explain.
    if (localHead !== args.expectedHeadSha) {
      const isAncestor = await runShell(
        'git',
        ['merge-base', '--is-ancestor', `${this.remote}/${args.baseBranch}`, localHead],
        { cwd: args.workspacePath, timeoutMs: this.opts.timeoutMs },
      );
      if (isAncestor.exit === 0) {
        return { kind: 'ok', new_head_sha: localHead };
      }
      return { kind: 'concurrent_push', observed_head_sha: localHead };
    }
    // 5. localHead === expectedHeadSha; run the rebase normally.
    const rebase = await runShell(
      'git',
      ['rebase', `${this.remote}/${args.baseBranch}`],
      { cwd: args.workspacePath, timeoutMs: this.opts.timeoutMs },
    );
    if (rebase.exit !== 0) {
      // Collect the conflicted files for the notes block.
      const conflicts = await runShell(
        'git',
        ['diff', '--name-only', '--diff-filter=U'],
        { cwd: args.workspacePath, timeoutMs: this.opts.timeoutMs },
      );
      const files = conflicts.stdout
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      // Leave the rebase IN PROGRESS — the agent picking up the conflict-routed
      // issue inherits the working tree with conflict markers in place and the
      // .git/rebase-* state on disk, so they can resolve in-tree and
      // `git rebase --continue` rather than starting over. Running
      // `git rebase --abort` here would discard exactly the state the routed
      // agent is supposed to resolve.
      return {
        kind: 'conflict',
        files,
        diagnostic: `${rebase.stdout.trim()}\n${rebase.stderr.trim()}`.trim(),
      };
    }
    // 6. New HEAD after rebase.
    const newHead = await runShell('git', ['rev-parse', 'HEAD'], {
      cwd: args.workspacePath,
      timeoutMs: this.opts.timeoutMs,
    });
    if (newHead.exit !== 0) {
      return { kind: 'error', diagnostic: `post-rebase rev-parse failed: ${newHead.stderr.trim()}` };
    }
    return { kind: 'ok', new_head_sha: newHead.stdout.trim() };
  }

  async pushForceWithLease(args: {
    workspacePath: string;
    branch: string;
    expectedHeadSha: string;
  }): Promise<PushOutcome> {
    const res = await runShell(
      'git',
      [
        'push',
        '--force-with-lease=' + args.branch + ':' + args.expectedHeadSha,
        this.remote,
        args.branch,
      ],
      { cwd: args.workspacePath, timeoutMs: this.opts.timeoutMs },
    );
    if (res.exit === 0) return { kind: 'ok' };
    // git's force-with-lease reports "stale info" / "rejected" on a lease
    // mismatch; treat anything containing those substrings as a concurrent-push.
    const blob = `${res.stdout}\n${res.stderr}`;
    if (/stale info|rejected|non-fast-forward/i.test(blob)) {
      return { kind: 'concurrent_push', diagnostic: blob.trim() };
    }
    return { kind: 'error', diagnostic: blob.trim() };
  }
}
