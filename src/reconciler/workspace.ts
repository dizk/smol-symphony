// Workspace resource (issue 34 / reconciler stage 3). Owns the lifecycle of
// per-issue workspace directories under `workspace.root`. Replaces the
// orchestrator's old `startupTerminalCleanup` sweep with a continuous-converge
// resource that also surfaces drift between an active workspace's HEAD and the
// current base branch tip.
//
// What this resource owns:
//   • Removing workspace dirs that no longer correspond to any non-terminal
//     issue file. The old startup sweep only fired once on boot; here it runs
//     on every reconcile tick.
//   • Creating workspace dirs for non-terminal issues that don't yet have one
//     on disk. The action body (clone source repo, cut `agent/<id>`, optional
//     origin restore) is delegated to `WorkspaceManager.ensureFor` so
//     dispatch-time and reconciler-driven eager creation share a single code
//     path. Idempotency / race safety is enforced inside `ensureFor` via a
//     per-identifier in-flight promise lock.
//   • Reporting drift between an active workspace's HEAD and the current
//     base-branch tip (e.g. base advanced while the issue was paused). v1 is
//     non-destructive: drift is surfaced as a `stale` / `stuck` annotation in
//     the snapshot and the workspace is left on disk. Re-clone (or any other
//     destructive recovery) is explicitly opt-in via an operator action or
//     per-issue label and is out of scope for this stage.
//
// Race-condition rule (same shape as VmResource): the intended set comes
// from a provider the orchestrator implements. It returns both the active
// issue identifiers (long-lived desired set) AND the identifiers currently
// in-flight (running + claimed). The in-flight slice covers the window
// between "tick claims an issue" and "tracker shows it as active" — without
// it, a brand-new issue's workspace could be reaped seconds after creation
// because the reconciler raced ahead of the tracker read.

import { sanitizeWorkspaceKey } from '../util/workspace-key.js';
import { log } from '../logging.js';
import { ResourceActionLedger } from './ledger.js';
import type { ResourceSnapshot } from './types.js';

/**
 * Identifiers the orchestrator wants to keep workspaces for. Returned per
 * reconcile pass so the reaper sees the latest tracker view and the latest
 * in-flight allocations.
 *
 * Each map is keyed by raw issue identifier and carries the current state
 * name so the create callback can apply the orchestrator's merge-state guard
 * (it skips eager recreation of a workspace whose issue sits in the autopilot's
 * merge state).
 *
 * `activeIdentifiers` is the long-lived desired set (non-terminal issues with
 * a file on disk). It MUST throw on tracker errors rather than fail open —
 * the reconciler's reconcile loop catches the throw and leaves existing
 * workspaces untouched. Swallowing the error and returning the empty set
 * would cause a transient tracker failure to reap every workspace.
 *
 * `inFlightIdentifiers` covers the window between dispatch claiming an issue
 * and the tracker reflecting it, mirroring VmResource's intended-set rule.
 * The state value is the dispatched-from state (for running entries) or
 * target state (for pending retries) — whichever the create callback's
 * merge-state guard should see.
 */
export interface WorkspaceIntendedProvider {
  activeIdentifiers(): Promise<Map<string, string>>;
  inFlightIdentifiers(): Map<string, string>;
}

/**
 * Source of truth for the base branch the dispatch-time clone targeted:
 * its name (`main` by default) and its CURRENT SHA in the source repo. The
 * inspector reads the workspace's own copy of `branch` to get the workspace's
 * snapshot of base, then the resource compares the two SHAs.
 *
 * Why both? The workspace is cloned with `git clone --local --no-tags`, which
 * only hardlinks objects present in the source repo at clone time. After the
 * source repo's base advances, the workspace has no objects for the new
 * commits — so any cross-repo `git merge-base --is-ancestor <new-sha>` run
 * inside the workspace returns "unknown SHA" (exit 128), not "diverged". The
 * v0 implementation conflated unknown with ancestor and silently missed every
 * real drift case. Comparing the workspace's own copy of `<branch>` against
 * the source repo's current tip sidesteps that boundary: both SHAs are
 * resolvable in their own repo, and inequality is a definitive drift signal.
 *
 * Returns null when the SHA cannot be resolved (no `.git` in source, base
 * branch missing, etc.) — drift detection is skipped that pass; orphan
 * removal still fires.
 */
export interface BaseRefProvider {
  currentBaseRef(): Promise<{ branch: string; sha: string } | null>;
}

export interface WorkspaceInspection {
  /** HEAD SHA of the workspace (agent/<id> tip), or null if not a git repo. */
  head: string | null;
  /**
   * SHA the workspace's LOCAL copy of the base branch points at. Captured at
   * `git clone --local --no-tags --branch <base>` time and frozen there unless
   * an explicit operator refresh happens. Comparing this to the source repo's
   * current base SHA is the drift signal. Null when the workspace has no such
   * ref (e.g. operator deleted the local base branch).
   */
  workspaceBaseSha: string | null;
  /** True iff `git status --porcelain` is non-empty. */
  hasUncommitted: boolean;
  /**
   * Number of commits reachable from HEAD that are NOT in the workspace's
   * local base history. Computed entirely within the workspace (no cross-repo
   * walk). Non-zero means the workspace would lose agent work to a re-clone;
   * surfaced as the `stuck` annotation in v1.
   */
  commitsAheadOfBase: number;
}

/** One entry per workspace dir on disk; the listing adapter filters non-dirs and resolves the absolute path. */
export type WorkspaceListing = { name: string; path: string };

export interface WorkspaceResourceOptions {
  intended: WorkspaceIntendedProvider;
  /**
   * Enumerate workspace dirs under the root. Production wires
   * `defaultListWorkspaceDirs(workspace.root)` from `./workspace-defaults`;
   * tests pass a stub. Must filter to directories only and translate ENOENT
   * on the root into an empty list (cold start).
   */
  listWorkspaces: () => Promise<WorkspaceListing[]>;
  /**
   * Optional base-branch source. When omitted (or it returns null), the drift
   * detector is skipped for that pass and only stale-workspace removal fires.
   * Production wires the orchestrator as the implementation; tests pass a stub.
   */
  baseRef?: BaseRefProvider;
  /**
   * Filesystem + git inspection. Production wires `defaultInspectWorkspace`
   * from `./workspace-defaults`; tests pass a stub. Receives the base branch
   * name (so the inspector can `git rev-parse <branch>` in the workspace) but
   * does NOT receive the source repo's SHA — that comparison happens in the
   * resource so we never run a cross-repo git operation inside the workspace
   * (which only sees objects hardlinked at clone time).
   */
  inspect: (workspacePath: string, baseBranch: string) => Promise<WorkspaceInspection>;
  /**
   * Remove a workspace dir. Receives the sanitized dir name (which is what
   * `WorkspaceManager.workspacePathFor` resolves to since sanitization is
   * idempotent) and the reason. Production defers to `WorkspaceManager.remove`
   * (a best-effort `rm -rf`); tests pass a stub.
   */
  remove: (identifier: string, reason: RemoveReason) => Promise<void>;
  /**
   * Override for the create action (tests pass a stub). Receives the raw
   * identifier (not the sanitized dir name — `WorkspaceManager.ensureFor`
   * does its own sanitization) plus the issue's current state name so the
   * orchestrator can apply its merge-state guard before creating.
   * `state` is null only on the defensive path where the provider failed to
   * supply one (e.g. an in-flight retry whose target state has been pruned);
   * production callers always pass a string. Production defers to
   * `WorkspaceManager.ensureFor` so the same canonical setup + per-identifier
   * lock that dispatch uses applies here. Omitted ⇒ the resource only reaps,
   * matching the v0 janitor-only behavior for harnesses that don't exercise
   * creation.
   */
  create?: (identifier: string, state: string | null) => Promise<void>;
}

/**
 * Why the janitor is removing a workspace. v1 has exactly one reason — the
 * owning issue is no longer non-terminal (the old `startupTerminalCleanup`
 * sweep's job). Drift-driven re-clone is NOT a v1 remove reason; drift is
 * surfaced as a snapshot annotation only.
 */
export type RemoveReason = 'stale_issue';

const MAX_ACTION_HISTORY = 32;

/**
 * Workspace resource. Desired = active issue workspaces (set of sanitized
 * identifiers from the tracker plus in-flight allocations). Actual = dirs
 * under `workspace.root`. Diff drives two converging actions plus two
 * snapshot annotations:
 *
 *   • create_workspace — identifier in the desired set with no matching dir
 *                        on disk. Delegates to `WorkspaceManager.ensureFor`,
 *                        which runs the canonical clone+branch+remote setup.
 *   • remove_workspace — dir has no matching non-terminal issue.
 *   • mark_stale       — dir matches but HEAD is behind base and the
 *                        workspace has no uncommitted / ahead work. Non-
 *                        destructive: re-clone is operator-triggered in v1.
 *   • mark_stuck       — dir matches but HEAD is behind base AND has
 *                        uncommitted changes or commits ahead of base. Non-
 *                        destructive; surfaced so the operator can intervene
 *                        before any rebuild attempt.
 *
 * `dependsOn: ['base_ref']` is informational. v1 doesn't ship a base_ref
 * resource; the BaseRefProvider is a direct dependency call.
 */
export class WorkspaceResource {
  readonly id = 'workspace';
  readonly dependsOn: string[] = [];

  private readonly ledger = new ResourceActionLedger(this.id, { maxHistory: MAX_ACTION_HISTORY });
  private lastError: string | null = null;
  private staleCount = 0;
  private stuckCount = 0;
  private createdCount = 0;

  constructor(private readonly opts: WorkspaceResourceOptions) {}

  ready(): boolean {
    // Janitorial; doesn't gate dispatch (bake is the only dispatch gate today).
    return true;
  }

  async reconcile(): Promise<void> {
    // Read the desired set up front. Even if `listWorkspaces` returns the
    // empty set (workspace.root not yet created), we still want to create
    // dirs for every active identifier — the create path will mkdir the root
    // via `ensureFor`. Pulling this before the listing collapses the two
    // branches into one flow.
    //
    // Fail closed when the tracker read throws: we must NOT treat the empty
    // set as the desired state. Reaping every workspace on a transient
    // tracker hiccup is the regression this contract closes. Catch here,
    // surface as last_error, and bail — the next pass retries.
    let active: Map<string, string>;
    try {
      active = await this.opts.intended.activeIdentifiers();
    } catch (err) {
      const msg = (err as Error).message;
      this.lastError = `active_fetch_failed: ${msg}`;
      log.warn('workspace reconcile: active fetch failed', { error: msg });
      return;
    }
    const inFlight = this.opts.intended.inFlightIdentifiers();
    // Map sanitized key → { identifier, state } so the create callback gets
    // the operator-visible identifier AND the current state name (used by the
    // orchestrator's merge-state guard). Sanitize-then-set so
    // the dir-name comparison matches `workspacePathFor`'s post-sanitize
    // layout. Active issues take precedence over in-flight in case of
    // overlap so the tracker's authoritative state wins over an in-flight
    // entry that may carry a target_state (where the issue is going, not
    // where it currently lives).
    const wanted = new Map<string, { identifier: string; state: string | null }>();
    for (const [id, state] of inFlight) {
      wanted.set(sanitizeWorkspaceKey(id), { identifier: id, state });
    }
    for (const [id, state] of active) {
      wanted.set(sanitizeWorkspaceKey(id), { identifier: id, state });
    }

    let entries: WorkspaceListing[];
    try {
      entries = await this.opts.listWorkspaces();
    } catch (err) {
      this.lastError = `workspace_root_read_failed: ${(err as Error).message}`;
      log.warn('workspace reconcile: list failed', { error: (err as Error).message });
      return;
    }

    let baseRef: { branch: string; sha: string } | null = null;
    if (this.opts.baseRef) {
      try {
        baseRef = await this.opts.baseRef.currentBaseRef();
      } catch (err) {
        log.debug('workspace reconcile: base ref lookup failed', {
          error: (err as Error).message,
        });
        baseRef = null;
      }
    }

    this.staleCount = 0;
    this.stuckCount = 0;
    this.createdCount = 0;
    // Reset lastError at the start of every pass so a transient stale/stuck
    // condition that has since resolved doesn't keep haunting the snapshot.
    // Errors raised during this pass below will repopulate it.
    this.lastError = null;

    // Track which desired identifiers already exist on disk so the
    // create-loop below only fires for the missing ones.
    const present = new Set<string>();

    for (const { name, path: dirPath } of entries) {
      if (!wanted.has(name)) {
        await this.runRemove(name, 'stale_issue');
        continue;
      }
      present.add(name);

      // In the desired set. Check for drift (non-destructive). No baseRef
      // means we can't compare; just skip and treat the workspace as ok.
      if (baseRef === null) continue;
      let inspection: WorkspaceInspection;
      try {
        inspection = await this.opts.inspect(dirPath, baseRef.branch);
      } catch (err) {
        log.debug('workspace reconcile: inspect failed', {
          identifier: name,
          error: (err as Error).message,
        });
        continue;
      }
      if (inspection.head === null) continue;
      // Workspace has no local copy of the base branch — operator likely
      // deleted it. Skip drift detection rather than guess.
      if (inspection.workspaceBaseSha === null) continue;
      // Drift = workspace's frozen base SHA disagrees with source's current
      // base SHA. Any disagreement counts (fast-forward, divergence, rewind
      // all surface as "the operator's base moved out from under us"); the
      // operator can decide what to do.
      if (inspection.workspaceBaseSha === baseRef.sha) continue;
      // Drift detected. v1 never auto-removes for drift; we annotate and move
      // on so the operator can decide whether to relaunch the workspace.
      if (inspection.hasUncommitted || inspection.commitsAheadOfBase > 0) {
        this.stuckCount += 1;
        const reason = inspection.hasUncommitted
          ? 'uncommitted changes present'
          : `${inspection.commitsAheadOfBase} commit(s) ahead of base`;
        const msg = `workspace ${name} stuck: base advanced and ${reason}`;
        this.lastError = msg;
        this.recordMark(name, 'stuck', reason);
        log.warn('workspace reconcile: stuck (drift, agent work present)', {
          identifier: name,
          reason,
        });
        continue;
      }
      this.staleCount += 1;
      const staleReason = 'base advanced past workspace HEAD; re-clone is opt-in';
      this.lastError = `workspace ${name} stale: ${staleReason}`;
      this.recordMark(name, 'stale', staleReason);
      log.info('workspace reconcile: stale (drift, no agent work to lose)', {
        identifier: name,
        reason: staleReason,
      });
    }

    // Create any desired identifier that has no dir on disk. The create
    // callback is optional so test harnesses that exercise only the reaper
    // can skip it; production wires `WorkspaceManager.ensureFor`, which is
    // idempotent (per-identifier lock + dir-exists check) so a concurrent
    // dispatch call coalesces into the same setup pass.
    if (this.opts.create) {
      for (const [key, { identifier, state }] of wanted) {
        if (present.has(key)) continue;
        await this.runCreate(identifier, key, state);
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

  /** Test helper: number of workspaces marked stale on the last reconcile pass. */
  staleOnLastPass(): number {
    return this.staleCount;
  }

  /** Test helper: number of workspaces marked stuck on the last reconcile pass. */
  stuckOnLastPass(): number {
    return this.stuckCount;
  }

  /** Test helper: number of workspaces created on the last reconcile pass. */
  createdOnLastPass(): number {
    return this.createdCount;
  }

  private async runCreate(
    identifier: string,
    sanitizedKey: string,
    state: string | null,
  ): Promise<void> {
    if (!this.opts.create) return;
    // Action key uses the sanitized identifier (matches what
    // remove_workspace uses) so dashboards can correlate the two
    // operations on the same workspace dir.
    const actionKey = `create_workspace:${sanitizedKey}`;
    const res = await this.ledger.run(actionKey, () => this.opts.create!(identifier, state));
    if (res.ok) {
      this.createdCount += 1;
      log.info('workspace reconcile: created', { identifier, state });
    } else {
      this.lastError = res.error;
      log.warn('workspace reconcile: create failed', { identifier, state, error: res.error });
    }
  }

  private async runRemove(identifier: string, reason: RemoveReason): Promise<void> {
    const actionKey = `remove_workspace:${identifier}`;
    const res = await this.ledger.run(actionKey, () => this.opts.remove(identifier, reason));
    if (res.ok) {
      log.info('workspace reconcile: removed', { identifier, reason });
    } else {
      this.lastError = res.error;
      log.warn('workspace reconcile: remove failed', { identifier, reason, error: res.error });
    }
  }

  /**
   * Record a non-destructive drift annotation in the action ledger so the
   * dashboard can render "stale" / "stuck" badges per workspace without the
   * janitor touching disk. `mark_stale:<id>` and `mark_stuck:<id>` are the
   * v1 surfaces; the reason rides on the action's `error` field for parity
   * with the existing snapshot-error shape, even though it isn't a hard
   * failure.
   */
  private recordMark(identifier: string, status: 'stale' | 'stuck', reason: string): void {
    this.ledger.record(`mark_${status}:${identifier}`, 'done', reason);
  }
}
