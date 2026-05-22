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
//   • Reporting drift between an active workspace's HEAD and the current
//     base-branch tip (e.g. base advanced while the issue was paused). v1 is
//     non-destructive: drift is surfaced as a `stale` / `stuck` annotation in
//     the snapshot and the workspace is left on disk. Re-clone (or any other
//     destructive recovery) is explicitly opt-in via an operator action or
//     per-issue label and is out of scope for this stage.
//
// What stays with WorkspaceManager:
//   • Per-dispatch allocation. The runner's dispatch path still calls
//     `WorkspaceManager.ensureFor` which creates the dir and runs the canonical
//     `setupWorkspaceDir` action on first creation. The reconciler is purely a
//     janitor here for v1; create-workspace runs at dispatch time because it
//     is tightly coupled to dispatch readiness signaling.
//
// Race-condition rule (same shape as VmResource): the intended set comes
// from a provider the orchestrator implements. It returns both the active
// issue identifiers (long-lived desired set) AND the identifiers currently
// in-flight (running + claimed). The in-flight slice covers the window
// between "tick claims an issue" and "tracker shows it as active" — without
// it, a brand-new issue's workspace could be reaped seconds after creation
// because the reconciler raced ahead of the tracker read.

import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { sanitizeWorkspaceKey } from '../workspace.js';
import { log } from '../logging.js';
import type { ActionStatus, ResourceSnapshot } from './types.js';

/**
 * Identifiers the orchestrator wants to keep workspaces for. Returned per
 * reconcile pass so the reaper sees the latest tracker view and the latest
 * in-flight allocations.
 *
 * `activeIdentifiers` is the long-lived desired set (non-terminal issues with
 * a file on disk). `inFlightIdentifiers` covers the window between dispatch
 * claiming an issue and the tracker reflecting it, mirroring VmResource's
 * intended-set rule.
 */
export interface WorkspaceIntendedProvider {
  activeIdentifiers(): Promise<Set<string>>;
  inFlightIdentifiers(): Set<string>;
}

/**
 * Source of the "what HEAD should be" SHA for the drift check — i.e. the
 * current tip of the configured base branch in the source repo. The
 * orchestrator implements this against `cfg.workflow_dir` (which in the
 * canonical layout is the source repo) and `SYMPHONY_BASE_BRANCH` (default
 * `main`). Returns null when the SHA cannot be resolved (e.g. the source
 * repo isn't a git repo, or the base branch doesn't exist) — in that case
 * the drift detector is skipped this pass and only stale-workspace removal
 * fires.
 */
export interface BaseRefProvider {
  currentBaseSha(): Promise<string | null>;
}

export interface WorkspaceInspection {
  /** HEAD SHA of the workspace, or null if not a git repo / cannot read. */
  head: string | null;
  /** True iff `git status --porcelain` is non-empty. */
  hasUncommitted: boolean;
  /**
   * True iff `baseSha` is an ancestor of HEAD. When the caller passes
   * `baseSha === null`, the inspector returns true here (no drift check
   * possible). Equivalent to `git merge-base --is-ancestor <sha> HEAD`.
   */
  baseAncestor: boolean;
  /**
   * Number of commits reachable from HEAD that are NOT in the base history.
   * Only meaningful when `baseSha` is non-null. Used as the "would a re-clone
   * discard agent work?" safety signal — non-zero means the workspace gets
   * marked `stuck` instead of `stale`.
   */
  commitsAheadOfBase: number;
}

export interface WorkspaceResourceOptions {
  workspaceRoot: string;
  intended: WorkspaceIntendedProvider;
  /**
   * Optional base-branch source. When omitted (or it returns null), the drift
   * detector is skipped for that pass and only stale-workspace removal fires.
   * Production wires the orchestrator as the implementation; tests pass a stub.
   */
  baseRef?: BaseRefProvider;
  /**
   * Override for filesystem + git inspection (tests pass a stub). Receives the
   * base SHA so the implementation can run the comparison in a single
   * subprocess pass instead of forcing the resource to make two trips across
   * the boundary.
   */
  inspect?: (workspacePath: string, baseSha: string | null) => Promise<WorkspaceInspection>;
  /**
   * Override for the remove action (tests pass a stub). Receives the
   * sanitized dir name (which is what `WorkspaceManager.workspacePathFor`
   * resolves to since sanitization is idempotent) and the reason. Production
   * defers to `WorkspaceManager.remove` so before_remove fires.
   */
  remove?: (identifier: string, reason: RemoveReason) => Promise<void>;
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
 * Stat-based default inspector. Spawns three git invocations against the
 * workspace path: `rev-parse HEAD`, `status --porcelain`, and (only when
 * `baseSha` is non-null) `merge-base --is-ancestor` + `rev-list --count`.
 * Returns `head: null` for anything that doesn't look like a git repo — the
 * caller treats that as "can't reason about this dir, don't touch it."
 */
export async function defaultInspectWorkspace(
  workspacePath: string,
  baseSha: string | null,
): Promise<WorkspaceInspection> {
  const head = await runGitCapture(workspacePath, ['rev-parse', 'HEAD']);
  if (head.exit !== 0 || head.stdout.trim().length === 0) {
    return {
      head: null,
      hasUncommitted: false,
      baseAncestor: true,
      commitsAheadOfBase: 0,
    };
  }
  const headSha = head.stdout.trim();
  const status = await runGitCapture(workspacePath, ['status', '--porcelain']);
  const hasUncommitted = status.exit === 0 && status.stdout.length > 0;
  if (baseSha === null) {
    return { head: headSha, hasUncommitted, baseAncestor: true, commitsAheadOfBase: 0 };
  }
  // is-ancestor exits 0 iff the first arg is an ancestor of the second; 1 otherwise.
  // Any other exit (e.g. unknown SHA) we treat as "ancestor unknown → no drift"
  // so a transient missing-object error doesn't trigger a spurious stale flag.
  const isAncestor = await runGitCapture(workspacePath, [
    'merge-base',
    '--is-ancestor',
    baseSha,
    headSha,
  ]);
  let baseAncestor: boolean;
  if (isAncestor.exit === 0) baseAncestor = true;
  else if (isAncestor.exit === 1) baseAncestor = false;
  else baseAncestor = true;
  const ahead = await runGitCapture(workspacePath, [
    'rev-list',
    '--count',
    `${baseSha}..${headSha}`,
  ]);
  const aheadCount = ahead.exit === 0 ? Number(ahead.stdout.trim()) || 0 : 0;
  return { head: headSha, hasUncommitted, baseAncestor, commitsAheadOfBase: aheadCount };
}

interface GitCaptureResult {
  exit: number;
  stdout: string;
  stderr: string;
}

function runGitCapture(cwd: string, args: string[]): Promise<GitCaptureResult> {
  return new Promise((resolve) => {
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (b) => {
      stdout += b.toString('utf8');
      if (stdout.length > 16_384) stdout = stdout.slice(0, 16_384);
    });
    child.stderr?.on('data', (b) => {
      stderr += b.toString('utf8');
      if (stderr.length > 16_384) stderr = stderr.slice(0, 16_384);
    });
    child.on('error', () => resolve({ exit: -1, stdout, stderr }));
    child.on('close', (code) => resolve({ exit: code ?? -1, stdout, stderr }));
  });
}

/**
 * Default removal: just `rm -rf` the directory. Production wiring overrides
 * this with `WorkspaceManager.remove` so the configured before_remove hook
 * fires. The two-callback design lets tests skip the hook plumbing entirely.
 */
async function defaultRemoveWorkspace(workspaceRoot: string, identifier: string): Promise<void> {
  const { rm } = await import('node:fs/promises');
  const dir = path.join(workspaceRoot, identifier);
  await rm(dir, { recursive: true, force: true });
}

/**
 * Workspace resource. Desired = active issue workspaces (set of sanitized
 * identifiers from the tracker plus in-flight allocations). Actual = dirs
 * under `workspace.root`. Diff → one destructive action plus two snapshot
 * annotations:
 *
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
 * resource; the BaseRefProvider is a direct dependency call. The metadata is
 * carried forward for the stage-4 `integration_branch` resource that
 * [[issue-31]] sketched (now slated for [[issue-36]] follow-up if shared-
 * integration is ever re-enabled).
 */
export class WorkspaceResource {
  readonly id = 'workspace';
  readonly dependsOn: string[] = [];

  private readonly inspect: (
    workspacePath: string,
    baseSha: string | null,
  ) => Promise<WorkspaceInspection>;
  private readonly remove: (identifier: string, reason: RemoveReason) => Promise<void>;
  private actions: ActionStatus[] = [];
  private lastError: string | null = null;
  private staleCount = 0;
  private stuckCount = 0;

  constructor(private readonly opts: WorkspaceResourceOptions) {
    this.inspect = opts.inspect ?? defaultInspectWorkspace;
    this.remove =
      opts.remove ??
      ((identifier) => defaultRemoveWorkspace(this.opts.workspaceRoot, identifier));
  }

  ready(): boolean {
    // Janitorial; doesn't gate dispatch (bake is the only dispatch gate today).
    return true;
  }

  async reconcile(): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(this.opts.workspaceRoot);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return;
      this.lastError = `workspace_root_read_failed: ${(err as Error).message}`;
      log.warn('workspace reconcile: readdir failed', {
        workspace_root: this.opts.workspaceRoot,
        error: (err as Error).message,
      });
      return;
    }

    // Sanitize-then-set so dir-name comparisons match `workspacePathFor`'s
    // post-sanitize layout. `sanitizeWorkspaceKey` is idempotent, so passing
    // dir names back into WorkspaceManager.remove(...) re-sanitizes safely.
    const active = await this.opts.intended.activeIdentifiers().catch((err) => {
      this.lastError = `active_fetch_failed: ${(err as Error).message}`;
      log.warn('workspace reconcile: active fetch failed', { error: (err as Error).message });
      return null as Set<string> | null;
    });
    if (active === null) return;
    const inFlight = this.opts.intended.inFlightIdentifiers();
    const wanted = new Set<string>();
    for (const id of active) wanted.add(sanitizeWorkspaceKey(id));
    for (const id of inFlight) wanted.add(sanitizeWorkspaceKey(id));

    let baseSha: string | null = null;
    if (this.opts.baseRef) {
      try {
        baseSha = await this.opts.baseRef.currentBaseSha();
      } catch (err) {
        log.debug('workspace reconcile: base ref lookup failed', {
          error: (err as Error).message,
        });
        baseSha = null;
      }
    }

    this.staleCount = 0;
    this.stuckCount = 0;
    // Reset lastError at the start of every pass so a transient stale/stuck
    // condition that has since resolved doesn't keep haunting the snapshot.
    // Errors raised during this pass below will repopulate it.
    this.lastError = null;
    for (const entry of entries) {
      const dirPath = path.join(this.opts.workspaceRoot, entry);
      let st;
      try {
        st = await stat(dirPath);
      } catch {
        continue;
      }
      if (!st.isDirectory()) continue;

      if (!wanted.has(entry)) {
        await this.runRemove(entry, 'stale_issue');
        continue;
      }

      // In the desired set. Check for drift (non-destructive).
      if (baseSha === null) continue;
      let inspection: WorkspaceInspection;
      try {
        inspection = await this.inspect(dirPath, baseSha);
      } catch (err) {
        log.debug('workspace reconcile: inspect failed', {
          identifier: entry,
          error: (err as Error).message,
        });
        continue;
      }
      if (inspection.head === null) continue;
      if (inspection.baseAncestor) continue;
      // Drift detected. v1 never auto-removes for drift; we annotate and move
      // on so the operator can decide whether to relaunch the workspace.
      if (inspection.hasUncommitted || inspection.commitsAheadOfBase > 0) {
        this.stuckCount += 1;
        const reason = inspection.hasUncommitted
          ? 'uncommitted changes present'
          : `${inspection.commitsAheadOfBase} commit(s) ahead of base`;
        const msg = `workspace ${entry} stuck: base advanced and ${reason}`;
        this.lastError = msg;
        this.recordMark(entry, 'stuck', reason);
        log.warn('workspace reconcile: stuck (drift, agent work present)', {
          identifier: entry,
          reason,
        });
        continue;
      }
      this.staleCount += 1;
      const staleReason = 'base advanced past workspace HEAD; re-clone is opt-in';
      this.lastError = `workspace ${entry} stale: ${staleReason}`;
      this.recordMark(entry, 'stale', staleReason);
      log.info('workspace reconcile: stale (drift, no agent work to lose)', {
        identifier: entry,
        reason: staleReason,
      });
    }
  }

  snapshot(): ResourceSnapshot {
    return {
      id: this.id,
      ready: true,
      desired_hash: null,
      last_error: this.lastError,
      actions: this.actions.slice(0, MAX_ACTION_HISTORY),
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

  private async runRemove(identifier: string, reason: RemoveReason): Promise<void> {
    const actionKey = `remove_workspace:${identifier}`;
    const startedAt = new Date().toISOString();
    this.pushAction({
      resource: this.id,
      action: actionKey,
      state: 'in_progress',
      started_at: startedAt,
      finished_at: null,
      error: null,
    });
    try {
      await this.remove(identifier, reason);
      this.markActionDone(actionKey);
      log.info('workspace reconcile: removed', { identifier, reason });
    } catch (err) {
      const msg = (err as Error).message;
      this.lastError = msg;
      this.markActionError(actionKey, msg);
      log.warn('workspace reconcile: remove failed', { identifier, reason, error: msg });
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
    const actionKey = `mark_${status}:${identifier}`;
    const now = new Date().toISOString();
    this.pushAction({
      resource: this.id,
      action: actionKey,
      state: 'done',
      started_at: now,
      finished_at: now,
      error: reason,
    });
  }

  private pushAction(status: ActionStatus): void {
    this.actions.unshift(status);
    if (this.actions.length > MAX_ACTION_HISTORY * 2) {
      this.actions.length = MAX_ACTION_HISTORY * 2;
    }
  }

  private markActionDone(key: string): void {
    const idx = this.actions.findIndex((a) => a.action === key && a.state === 'in_progress');
    const finished = new Date().toISOString();
    if (idx >= 0) {
      this.actions[idx] = { ...this.actions[idx]!, state: 'done', finished_at: finished };
    }
  }

  private markActionError(key: string, error: string): void {
    const idx = this.actions.findIndex((a) => a.action === key && a.state === 'in_progress');
    const finished = new Date().toISOString();
    if (idx >= 0) {
      this.actions[idx] = {
        ...this.actions[idx]!,
        state: 'error',
        finished_at: finished,
        error,
      };
    } else {
      this.pushAction({
        resource: this.id,
        action: key,
        state: 'error',
        started_at: finished,
        finished_at: finished,
        error,
      });
    }
  }
}
