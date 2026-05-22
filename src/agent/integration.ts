// Shared-integration-branch merge (issue 19). Runs host-side, inside the per-issue
// workspace, after the agent has transitioned the issue into a terminal state listed in
// `integration.merge_on_states`. The flow:
//
//   1. Fetch the integration branch from the remote (origin in PR mode; a temporary
//      `sym_local_integration` remote pointing at the local source repo in local mode).
//   2. If it does not exist yet, seed it from the base branch (the very first run after
//      the operator opts into the integration flow).
//   3. Check out integration locally, reset hard to the remote tip, and merge
//      `agent/<id>` with --no-ff so the merge commit is durable.
//   4. Push integration to the remote.
//   5. Switch back to `agent/<id>` so the Done after_run hook (which pushes that branch
//      and opens a PR against base) sees a familiar HEAD.
//
// On merge conflict, the runner reroutes the issue to a Conflict holding state and
// preserves the workspace + branch (see `routeIntegrationFailureToConflict`). On push
// refusal (non-ff because someone else pushed in the meantime, or `main → integration`
// happened manually) the same reroute fires; concurrent-agent push retry is a separate
// follow-up (concurrency is capped at 1 today).
//
// All git invocations go through `runGit`, which streams output into the per-issue
// JSONL run log under a synthetic hook name so the evaluation pass sees the same shape
// it would for any other shell-out (the wrapper does not introduce a new channel kind).

import { spawn } from 'node:child_process';
import path from 'node:path';
import type { IssueTracker } from '../trackers/types.js';
import type { RunningEntry } from '../types.js';
import type { HookCapture } from '../workspace.js';
import { log } from '../logging.js';

export type IntegrationRemote =
  | { kind: 'origin' }
  | { kind: 'local'; sourceRepo: string };

export interface IntegrationMergeOptions {
  workspacePath: string;
  identifier: string;
  integrationBranch: string;
  baseBranch: string;
  remote: IntegrationRemote;
  timeoutMs: number;
  capture?: HookCapture;
}

export interface IntegrationMergeOk {
  ok: true;
  integrationBranch: string;
  remote: 'origin' | 'local';
  merged_at: string;
}

export interface IntegrationMergeFail {
  ok: false;
  reason: 'conflict' | 'push_refused' | 'other';
  diagnostic: string;
  integrationBranch: string;
  remote: 'origin' | 'local';
}

export type IntegrationMergeResult = IntegrationMergeOk | IntegrationMergeFail;

// Fixed name for the temp remote we add in local-mode. The workspace's after_create hook
// has already stripped all named remotes; we add this one inside `performIntegrationMerge`
// and remove it again in `finally` so the workspace contract (no agent-visible remotes
// in local mode) survives both the success and the failure paths.
const LOCAL_REMOTE_NAME = 'sym_local_integration';

interface GitResult {
  exit_code: number | null;
  signal: NodeJS.Signals | null;
  timed_out: boolean;
  stdout: string;
  stderr: string;
}

function runGit(args: string[], opts: IntegrationMergeOptions): Promise<GitResult> {
  return new Promise((resolve) => {
    const child = spawn('git', args, {
      cwd: opts.workspacePath,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout?.on('data', (b) => {
      const t = b.toString('utf8');
      stdout += t;
      if (stdout.length > 65_536) stdout = stdout.slice(0, 65_536);
      opts.capture?.onChunk?.('stdout', t);
    });
    child.stderr?.on('data', (b) => {
      const t = b.toString('utf8');
      stderr += t;
      if (stderr.length > 65_536) stderr = stderr.slice(0, 65_536);
      opts.capture?.onChunk?.('stderr', t);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, opts.timeoutMs);
    const finish = (r: GitResult) => {
      opts.capture?.onResult?.({
        ran: true,
        exit_code: r.exit_code,
        signal: r.signal,
        timed_out: r.timed_out,
        stdout: r.stdout,
        stderr: r.stderr,
      });
      resolve(r);
    };
    child.on('error', () => {
      clearTimeout(timer);
      finish({ exit_code: null, signal: null, timed_out: timedOut, stdout, stderr });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      finish({
        exit_code: code,
        signal: signal ?? null,
        timed_out: timedOut,
        stdout,
        stderr,
      });
    });
  });
}

function gitOk(r: GitResult): boolean {
  return r.exit_code === 0 && !r.timed_out && r.signal === null;
}

function trimDiagnostic(out: string, err: string, limit = 4096): string {
  const combined = [out.trim(), err.trim()].filter((s) => s.length > 0).join('\n');
  if (combined.length <= limit) return combined;
  return combined.slice(0, limit) + '\n…(truncated)';
}

/**
 * Run the host-side merge of `agent/<identifier>` into the integration branch.
 *
 * The function does not mutate any tracker state — it returns a result and the caller
 * decides whether to continue with terminal cleanup or reroute the issue to a holding
 * state. That split keeps the git side pure-functional and easy to test with bare-repo
 * fixtures; the orchestrator-state side lives next to the runner.
 */
export async function performIntegrationMerge(
  opts: IntegrationMergeOptions,
): Promise<IntegrationMergeResult> {
  const branch = `agent/${opts.identifier}`;
  const integration = opts.integrationBranch;
  const base = opts.baseBranch;
  const remoteName = opts.remote.kind === 'origin' ? 'origin' : LOCAL_REMOTE_NAME;
  const remoteKindForResult: 'origin' | 'local' = opts.remote.kind === 'origin' ? 'origin' : 'local';

  // Local mode: stage a temporary remote pointing at the source repo. The after_create
  // hook deliberately strips all named remotes in local mode so the in-VM agent has no
  // network targets; we re-introduce one only for the duration of this host-side merge.
  if (opts.remote.kind === 'local') {
    // Remove any leftover stale remote of this name (e.g. from a prior aborted merge).
    await runGit(['remote', 'remove', remoteName], opts).catch(() => undefined);
    const addRes = await runGit(['remote', 'add', remoteName, opts.remote.sourceRepo], opts);
    if (!gitOk(addRes)) {
      return failure('other', `failed to add temp remote ${remoteName}: ${trimDiagnostic(addRes.stdout, addRes.stderr)}`);
    }
  }

  try {
    // Fetch the integration branch. A non-zero exit code can mean either "transport
    // error" or "no such ref" depending on the remote; we then try to fetch base
    // separately so a missing integration branch (first-run case) is recoverable.
    const fetchIntegration = await runGit(
      ['fetch', '--no-tags', remoteName, integration],
      opts,
    );
    let integrationOnRemote = gitOk(fetchIntegration);

    // Always make sure base is fetched too — we need it as the seed source if integration
    // is missing, and even on the happy path the merge-base resolution benefits from a
    // fresh view of the remote base.
    const fetchBase = await runGit(['fetch', '--no-tags', remoteName, base], opts);
    if (!gitOk(fetchBase) && !integrationOnRemote) {
      return failure(
        'other',
        `failed to fetch base "${base}" from ${remoteName}: ${trimDiagnostic(fetchBase.stdout, fetchBase.stderr)}`,
      );
    }

    if (integrationOnRemote) {
      const co = await runGit(
        ['checkout', '-B', integration, `${remoteName}/${integration}`],
        opts,
      );
      if (!gitOk(co)) {
        return failure(
          'other',
          `failed to checkout integration: ${trimDiagnostic(co.stdout, co.stderr)}`,
        );
      }
    } else {
      // Seed integration from base. -B creates or resets the local branch atomically.
      const seed = await runGit(
        ['checkout', '-B', integration, `${remoteName}/${base}`],
        opts,
      );
      if (!gitOk(seed)) {
        return failure(
          'other',
          `failed to seed integration from base: ${trimDiagnostic(seed.stdout, seed.stderr)}`,
        );
      }
    }

    const mergeMsg = `Merge ${branch} into ${integration}`;
    const mergeRes = await runGit(
      ['merge', '--no-ff', '--no-edit', '-m', mergeMsg, branch],
      opts,
    );
    if (!gitOk(mergeRes)) {
      // Abort the merge to leave the working tree clean. Best-effort: if abort fails the
      // workspace is preserved anyway (cleanup_workspace_on_exit=false in the reroute),
      // so an operator can finish unwinding it by hand.
      await runGit(['merge', '--abort'], opts).catch(() => undefined);
      // Switch back to the agent branch so the workspace looks normal to anyone who pokes
      // at it later. Tolerate failure: the conflict diagnostic is what matters.
      await runGit(['checkout', branch], opts).catch(() => undefined);
      return failure(
        'conflict',
        `merge of ${branch} into ${integration} failed: ${trimDiagnostic(mergeRes.stdout, mergeRes.stderr)}`,
      );
    }

    const pushRes = await runGit(['push', remoteName, integration], opts);
    if (!gitOk(pushRes)) {
      // Switch back to the agent branch before returning so the workspace HEAD is
      // predictable for the Conflict-state operator. The merge commit stays on the local
      // integration branch in case the operator wants to inspect or replay it.
      await runGit(['checkout', branch], opts).catch(() => undefined);
      return failure(
        'push_refused',
        `push of ${integration} to ${remoteName} refused: ${trimDiagnostic(pushRes.stdout, pushRes.stderr)}`,
      );
    }

    // Switch back to the agent branch so the Done after_run hook (push + gh pr create)
    // operates on a HEAD it expects.
    const backRes = await runGit(['checkout', branch], opts);
    if (!gitOk(backRes)) {
      // The merge + push succeeded — log the inconsistency but don't fail the whole
      // operation. The agent's branch is still pushable from this state.
      log.warn('integration: checkout-back-to-agent-branch failed after successful merge', {
        identifier: opts.identifier,
        branch,
        stderr: backRes.stderr.slice(0, 500),
      });
    }

    return {
      ok: true,
      integrationBranch: integration,
      remote: remoteKindForResult,
      merged_at: new Date().toISOString(),
    };
  } finally {
    if (opts.remote.kind === 'local') {
      await runGit(['remote', 'remove', remoteName], opts).catch(() => undefined);
    }
  }

  function failure(
    reason: IntegrationMergeFail['reason'],
    diagnostic: string,
  ): IntegrationMergeFail {
    return {
      ok: false,
      reason,
      diagnostic,
      integrationBranch: integration,
      remote: remoteKindForResult,
    };
  }
}

/**
 * Resolve the remote the orchestrator should push integration to. Mirrors the
 * after_create hook's mode selector: SYMPHONY_REPO set => PR mode (origin already
 * configured by the hook); unset => local mode (push back to the source repo via a
 * temp remote). `workspacePath` is used to compute the local-mode default when
 * SYMPHONY_SOURCE_REPO is also unset — the same `${PWD}/../../..` shape the hook uses.
 */
export function resolveIntegrationRemote(workspacePath: string): IntegrationRemote {
  if (process.env.SYMPHONY_REPO && process.env.SYMPHONY_REPO.length > 0) {
    return { kind: 'origin' };
  }
  const sourceRepo =
    process.env.SYMPHONY_SOURCE_REPO && process.env.SYMPHONY_SOURCE_REPO.length > 0
      ? process.env.SYMPHONY_SOURCE_REPO
      : path.resolve(workspacePath, '..', '..', '..');
  return { kind: 'local', sourceRepo };
}

/**
 * Route an issue that just had its integration merge fail into the configured Conflict
 * holding state. Appends the diagnostic context to the issue body before the move so the
 * next reader (operator or future agent) sees what failed and where the workspace
 * stands. Clears `cleanup_workspace_on_exit` on the RunningEntry so the workspace and
 * `agent/<id>` branch survive for the conflict-resolver to use.
 *
 * Mutates the entry's `issue.state` to the conflict state so any subsequent hook
 * resolution in the runner picks up the Conflict state's hooks (if any).
 */
export async function routeIntegrationFailureToConflict(
  tracker: IssueTracker,
  entry: RunningEntry,
  conflictState: string,
  result: IntegrationMergeFail,
): Promise<void> {
  if (!tracker.moveIssueToState) {
    log.warn('integration: tracker does not support state moves; cannot reroute to conflict', {
      issue_id: entry.issue_id,
      issue_identifier: entry.identifier,
    });
    // We still flip cleanup off so the workspace and branch survive for manual recovery.
    entry.cleanup_workspace_on_exit = false;
    return;
  }
  const fromState = entry.issue.state;
  const heading = `integration merge failed (${result.reason})`;
  const notes = [
    `**Reason:** ${result.reason}`,
    '',
    `**Integration branch:** \`${result.integrationBranch}\` (remote: ${result.remote})`,
    '',
    `**Workspace and \`agent/${entry.identifier}\` branch are preserved** for resolution.`,
    '',
    'Diagnostic:',
    '',
    '```',
    result.diagnostic,
    '```',
  ].join('\n');
  // The tracker stamps a "## <actor> — <ts> — <from> → <to>" header before the notes; we
  // include a leading sentence inside the notes body so the heading-less notes block
  // still reads as a self-describing conflict report.
  const body = `${heading}\n\n${notes}`;
  try {
    await tracker.moveIssueToState(entry.issue_id, conflictState, {
      fromRoot: entry.tracker_root_at_dispatch ?? undefined,
      fromState,
      notes: body,
      actor: entry.resolved_actor,
    });
  } catch (err) {
    log.warn('integration: failed to reroute issue to conflict state', {
      issue_id: entry.issue_id,
      issue_identifier: entry.identifier,
      conflict_state: conflictState,
      error: (err as Error).message,
    });
    // Even on reroute failure, keep the workspace so the operator has something to look at.
    entry.cleanup_workspace_on_exit = false;
    return;
  }
  entry.cleanup_workspace_on_exit = false;
  entry.issue.state = conflictState;
  log.info('integration: issue rerouted to conflict state', {
    issue_id: entry.issue_id,
    issue_identifier: entry.identifier,
    from_state: fromState,
    to_state: conflictState,
    reason: result.reason,
  });
}

/** Case-insensitive membership test used by the runner to decide whether to merge. */
export function shouldMergeForState(stateName: string, mergeOnStates: string[]): boolean {
  const lower = stateName.toLowerCase();
  for (const s of mergeOnStates) {
    if (s.toLowerCase() === lower) return true;
  }
  return false;
}
