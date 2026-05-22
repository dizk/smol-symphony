// Workspace resource (issue 34 / reconciler stage 3). Owns the lifecycle of
// per-issue workspace directories under `workspace.root`. Replaces the
// orchestrator's old `startupTerminalCleanup` sweep with a continuous-converge
// resource that also catches drift between an active workspace's HEAD and the
// current integration ref.
//
// What this resource owns:
//   • Removing workspace dirs that no longer correspond to any non-terminal
//     issue file. The old startup sweep only fired once on boot; here it runs
//     on every reconcile tick.
//   • Detecting that an active workspace's HEAD has fallen behind the current
//     integration ref (e.g. integration advanced while the issue was paused)
//     and re-cloning if it is safe to do so. "Safe" today means: no
//     uncommitted changes and no agent/<id> commits ahead of integration.
//     When unsafe, the workspace is marked `stuck` in the snapshot so the
//     operator notices instead of the resource silently destroying agent work.
//
// What stays with WorkspaceManager:
//   • Per-dispatch allocation. The runner's dispatch path still calls
//     `WorkspaceManager.ensureFor` which creates the dir and runs after_create
//     the first time it sees an issue. The reconciler is purely a janitor
//     here; "re_clone_workspace" is implemented as "remove the dir and let
//     the next dispatch recreate it." That keeps the after_create hook (which
//     is workflow-defined and may need staging like SYMPHONY_REPO) on the
//     dispatch path where the runner already wires its env.
//
// Race-condition rule (same shape as VmResource): the intended set comes
// from a provider the orchestrator implements. It returns both the active
// issue identifiers (long-lived desired set) AND the identifiers currently
// in-flight (running + claimed). The in-flight slice covers the window
// between "tick claims an issue" and "tracker shows it as active" — without
// it, a brand-new issue's workspace could be reaped seconds after creation
// because the reconciler raced ahead of the tracker read.

import { readdir, rm, stat } from 'node:fs/promises';
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
 * Source of the "what HEAD should be" SHA for the drift check. Returns null
 * when there is no integration ref to compare against — in that case the
 * drift detector is dormant and the resource only removes stale workspaces.
 * Stage 4 ([[issue-35]]) will plug in a real integration_branch resource
 * here; until then production returns null when the workflow has no
 * `integration:` block.
 */
export interface IntegrationRefProvider {
  currentIntegrationSha(): Promise<string | null>;
}

export interface WorkspaceInspection {
  /** HEAD SHA of the workspace, or null if not a git repo / cannot read. */
  head: string | null;
  /** True iff `git status --porcelain` is non-empty. */
  hasUncommitted: boolean;
  /**
   * True iff `integrationSha` is an ancestor of HEAD. When the caller passes
   * `integrationSha === null`, the inspector returns true here (no drift
   * check possible). Equivalent to `git merge-base --is-ancestor <sha> HEAD`.
   */
  integrationAncestor: boolean;
  /**
   * Number of commits reachable from HEAD that are NOT in the integration
   * history. Only meaningful when `integrationSha` is non-null. Used as the
   * "would re-clone discard agent work?" safety check.
   */
  commitsAheadOfIntegration: number;
}

export interface WorkspaceResourceOptions {
  workspaceRoot: string;
  intended: WorkspaceIntendedProvider;
  /**
   * Optional integration-ref source. When omitted (or it returns null), the
   * drift detector is dormant and only stale-workspace removal fires. Stage 4
   * provides a real implementation; stage 3 falls back to a stub that always
   * returns null when no integration block is declared.
   */
  integrationRef?: IntegrationRefProvider;
  /**
   * Override for filesystem + git inspection (tests pass a stub). Receives
   * the integration SHA so the implementation can run the comparison in a
   * single subprocess pass instead of forcing the resource to make two trips
   * across the boundary.
   */
  inspect?: (workspacePath: string, integrationSha: string | null) => Promise<WorkspaceInspection>;
  /**
   * Override for the remove action (tests pass a stub). Receives the
   * sanitized dir name (which is what `WorkspaceManager.workspacePathFor`
   * resolves to since sanitization is idempotent) and the reason. Production
   * defers to `WorkspaceManager.remove` so before_remove fires.
   */
  remove?: (identifier: string, reason: RemoveReason) => Promise<void>;
}

export type RemoveReason = 'stale_issue' | 'drift_reclone';

const MAX_ACTION_HISTORY = 32;

/**
 * Stat-based default inspector. Spawns three git invocations against the
 * workspace path: `rev-parse HEAD`, `status --porcelain`, and (only when
 * `integrationSha` is non-null) `merge-base --is-ancestor` + `rev-list --count`.
 * Returns `head: null` for anything that doesn't look like a git repo — the
 * caller treats that as "can't reason about this dir, don't touch it."
 */
export async function defaultInspectWorkspace(
  workspacePath: string,
  integrationSha: string | null,
): Promise<WorkspaceInspection> {
  const head = await runGitCapture(workspacePath, ['rev-parse', 'HEAD']);
  if (head.exit !== 0 || head.stdout.trim().length === 0) {
    return {
      head: null,
      hasUncommitted: false,
      integrationAncestor: true,
      commitsAheadOfIntegration: 0,
    };
  }
  const headSha = head.stdout.trim();
  const status = await runGitCapture(workspacePath, ['status', '--porcelain']);
  const hasUncommitted = status.exit === 0 && status.stdout.length > 0;
  if (integrationSha === null) {
    return { head: headSha, hasUncommitted, integrationAncestor: true, commitsAheadOfIntegration: 0 };
  }
  // is-ancestor exits 0 iff the first arg is an ancestor of the second; 1 otherwise.
  // Any other exit (e.g. unknown SHA) we treat as "ancestor unknown → no drift"
  // so a transient missing-object error doesn't trigger a destructive re-clone.
  const isAncestor = await runGitCapture(workspacePath, [
    'merge-base',
    '--is-ancestor',
    integrationSha,
    headSha,
  ]);
  let integrationAncestor: boolean;
  if (isAncestor.exit === 0) integrationAncestor = true;
  else if (isAncestor.exit === 1) integrationAncestor = false;
  else integrationAncestor = true;
  const ahead = await runGitCapture(workspacePath, [
    'rev-list',
    '--count',
    `${integrationSha}..${headSha}`,
  ]);
  const aheadCount = ahead.exit === 0 ? Number(ahead.stdout.trim()) || 0 : 0;
  return { head: headSha, hasUncommitted, integrationAncestor, commitsAheadOfIntegration: aheadCount };
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
  const dir = path.join(workspaceRoot, identifier);
  await rm(dir, { recursive: true, force: true });
}

/**
 * Workspace resource. Desired = active issue workspaces (set of sanitized
 * identifiers from the tracker plus in-flight allocations). Actual = dirs
 * under `workspace.root`. Diff → two action shapes:
 *   • remove_workspace — dir has no matching non-terminal issue.
 *   • re_clone_workspace — dir matches but HEAD has fallen behind integration
 *                          and the workspace has no agent work to lose.
 *
 * Stuck case (drift + uncommitted/ahead) records a `last_error` and is left
 * on disk so the operator can inspect or intervene.
 *
 * Declares `dependsOn: ['integration_branch']` for the stage-4 wiring even
 * though that resource does not exist yet; the reconciler walker tolerates
 * unknown dependencies (they're informational metadata), and the explicit
 * declaration makes the ordering intent visible.
 */
export class WorkspaceResource {
  readonly id = 'workspace';
  readonly dependsOn: string[] = ['integration_branch'];

  private readonly inspect: (
    workspacePath: string,
    integrationSha: string | null,
  ) => Promise<WorkspaceInspection>;
  private readonly remove: (identifier: string, reason: RemoveReason) => Promise<void>;
  private actions: ActionStatus[] = [];
  private lastError: string | null = null;
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

    let integrationSha: string | null = null;
    if (this.opts.integrationRef) {
      try {
        integrationSha = await this.opts.integrationRef.currentIntegrationSha();
      } catch (err) {
        log.debug('workspace reconcile: integration ref lookup failed', {
          error: (err as Error).message,
        });
        integrationSha = null;
      }
    }

    this.stuckCount = 0;
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

      // In the desired set. Check for drift.
      if (integrationSha === null) continue;
      let inspection: WorkspaceInspection;
      try {
        inspection = await this.inspect(dirPath, integrationSha);
      } catch (err) {
        log.debug('workspace reconcile: inspect failed', {
          identifier: entry,
          error: (err as Error).message,
        });
        continue;
      }
      if (inspection.head === null) continue;
      if (inspection.integrationAncestor) continue;
      if (inspection.hasUncommitted || inspection.commitsAheadOfIntegration > 0) {
        this.stuckCount += 1;
        const reason = inspection.hasUncommitted
          ? 'uncommitted changes present'
          : `${inspection.commitsAheadOfIntegration} commit(s) ahead of integration`;
        const msg = `workspace ${entry} stale vs integration but refusing re-clone: ${reason}`;
        this.lastError = msg;
        log.warn('workspace reconcile: stuck (drift unsafe to re-clone)', {
          identifier: entry,
          reason,
        });
        continue;
      }
      await this.runRemove(entry, 'drift_reclone');
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

  /** Test helper: number of workspaces left stuck on the last reconcile pass. */
  stuckOnLastPass(): number {
    return this.stuckCount;
  }

  private async runRemove(identifier: string, reason: RemoveReason): Promise<void> {
    const actionKey =
      reason === 'stale_issue'
        ? `remove_workspace:${identifier}`
        : `re_clone_workspace:${identifier}`;
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
