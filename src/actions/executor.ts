// Action executor (issue 36). Runs a per-state typed-action list during the
// runner's terminal cleanup, replacing the `after_run` shell hook for states
// that declare an `actions:` block.
//
// Per-action lifecycle:
//   1. Render templates against the ActionContext.
//   2. Evaluate `if:` predicate; skip when false (record state=done with
//      `cache_hit: skipped` semantics).
//   3. Apply the action via its kind-specific executor.
//   4. On failure, consult `on_error.retry`; replay with exponential backoff.
//   5. After retries exhausted, consult `on_error.then`: abort the cleanup
//      run, or reroute the issue to a holding state.
//
// The executor never mutates the issue's tracker state directly; reroute
// requests are returned as `route_to` on the result and the runner (which
// holds the McpRegistry / tracker) performs the move. Same separation as
// `routeIntegrationFailureToConflict`: keep the git/gh/exec side
// pure-functional, the orchestrator-state side next to the runner.

import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { runProcess, type RunResult } from '../util/process.js';
import type {
  ActionContext,
  ActionErrorPolicy,
  ActionOutcome,
  ActionStatus,
  ActionState,
  ActionsSnapshot,
  CreatePrIfMissingAction,
  DeleteBranchAction,
  EnsureBranchAction,
  CheckoutAction,
  MergeAction,
  ProposeFollowupAction,
  PushBranchAction,
  RunInVmAction,
  WorkflowAction,
} from './types.js';
import { renderTemplate, renderTree, TemplateError } from './templating.js';
import { evaluatePredicate } from './predicates.js';
import {
  computeCacheHash,
  invalidateCacheByName,
  readCache,
  runInVmCacheRoot,
  writeCache,
} from './cache.js';
import type { HookCapture } from '../workspace.js';
import { log } from '../logging.js';
import { realClock, isoFromClock, type ClockNow } from '../util/clock.js';

const DEFAULT_RETRY_COUNT = 3;
const DEFAULT_RETRY_BACKOFF_MS = 1_000;
const MAX_ACTION_HISTORY = 16;

export interface ProposeFollowupSink {
  /**
   * Propagate a `propose_followup` action through the same tracker path
   * `symphony.propose_issue` uses. The orchestrator wires this; the runner
   * passes the closure through. Returns the identifier of the proposal (for
   * the run log) — failures throw and trip the action's retry policy.
   */
  proposeFollowup(input: {
    title: string;
    description?: string;
    labels?: string[];
    priority?: number;
    parent_identifier: string;
  }): Promise<{ identifier: string }>;
}

/**
 * Backend that executes a `run_in_vm` action's command. Production wires the
 * smolvm exec path (the runner constructs a closure that calls
 * `smolvm.execInteractive(<vmName>, …)` against the per-issue VM so the
 * command lands inside the same sandbox the agent ran in); tests pass
 * `hostRunInVm`, which forks the command on the host. The executor never
 * spawns a `run_in_vm` command directly — failing to wire a `runInVm`
 * closure surfaces as a `run_in_vm: no VM runner wired` failure on the
 * action ledger instead of silently escaping the sandbox.
 */
export type RunInVmExecutor = (input: {
  /** Mirrors the action's `name` for diagnostics. */
  name: string;
  cmd: string[];
  env: Record<string, string>;
  /** Workspace root inside the VM (mounted at the same host path). */
  workdir: string;
  timeoutMs: number;
  /** Forwarded to the run log + per-issue capture surface, byte-for-byte. */
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}) => Promise<{
  exit_code: number | null;
  signal: NodeJS.Signals | null;
  timed_out: boolean;
  stdout: string;
  stderr: string;
}>;

export interface ActionExecutorOptions {
  workspacePath: string;
  ctx: ActionContext;
  /**
   * Run-log capture; the executor mirrors stdout/stderr of every spawned
   * command (and the action lifecycle) through the same shape the workspace
   * hooks use, so the per-issue JSONL log carries a uniform event stream
   * across hook-era and action-era runs.
   */
  capture?: HookCapture;
  /** Override for tests; production uses `~/.cache/symphony`. */
  cacheRoot?: string;
  /** Required for `propose_followup`. */
  followupSink?: ProposeFollowupSink;
  /**
   * Required for `run_in_vm`. Production wires the smolvm exec path; tests
   * pass `hostRunInVm`. When absent, `run_in_vm` actions fail immediately
   * with a "no VM runner wired" diagnostic (rather than silently falling
   * back to host spawn, which would defeat the sandbox boundary).
   */
  runInVm?: RunInVmExecutor;
  /** Logical scope id (e.g. `actions:Done`) for snapshot keying. */
  snapshotId: string;
  /**
   * Bound per-command timeout. Default 5 minutes; `run_in_vm` overrides via
   * its own `timeout` field. Used for git/gh/exec to keep a wedged remote
   * from hanging the run forever.
   */
  defaultCommandTimeoutMs?: number;
  /**
   * Wall-clock injection point. Tests pin time; production wires `Date.now`
   * (or the realClock util default). Used to stamp ledger row started_at /
   * finished_at fields. Mirrors the `now` seam on PrResource / ledger so the
   * whole reconciler/action side of the core is deterministic.
   */
  now?: ClockNow;
}

export interface ActionExecResult {
  ok: boolean;
  reason: string | null;
  route_to: string | null;
  /** Most-recent-first ledger; safe to embed in a snapshot. */
  actions: ActionStatus[];
}

/**
 * Run a sequence of declared actions. Returns the aggregated outcome. The
 * caller is responsible for placing the result in the snapshot store.
 *
 * Sequential by design: today's actions all touch the same workspace and
 * the same remote, so parallelism would require declared inputs/outputs to
 * be honored (the issue body sketches that as future work). Stage-1
 * semantics: each action runs after the prior completes; the first
 * non-routed failure stops the loop with `ok=false`.
 */
export async function runActions(
  actions: readonly WorkflowAction[],
  opts: ActionExecutorOptions,
): Promise<ActionExecResult> {
  const now = opts.now ?? realClock;
  const iso = () => isoFromClock(now);
  const ledger: ActionStatus[] = [];
  const push = (status: ActionStatus) => {
    ledger.unshift(status);
    if (ledger.length > MAX_ACTION_HISTORY * 2) ledger.length = MAX_ACTION_HISTORY * 2;
  };
  const upd = (action: string, next: Partial<ActionStatus>) => {
    const idx = ledger.findIndex((a) => a.action === action && a.state === 'in_progress');
    if (idx >= 0) ledger[idx] = { ...ledger[idx]!, ...next };
  };

  let routeTo: string | null = null;
  let aborted = false;
  let abortReason: string | null = null;

  for (let i = 0; i < actions.length; i++) {
    if (aborted) break;
    const action = actions[i]!;
    const actionKey = actionSnapshotKey(action, i);
    const startedAt = iso();
    push({
      resource: opts.snapshotId,
      action: actionKey,
      state: 'in_progress',
      started_at: startedAt,
      finished_at: null,
      error: null,
    });

    // Render the action's string-typed fields once up front. We re-render on
    // retry to be robust to context mutations during the retry window, but in
    // practice the ActionContext is built once per cleanup pass.
    let rendered: WorkflowAction;
    try {
      rendered = renderTree(action, opts.ctx);
    } catch (err) {
      const msg = err instanceof TemplateError ? err.message : (err as Error).message;
      upd(actionKey, { state: 'error', finished_at: iso(), error: msg });
      log.warn('action template render failed', {
        action: actionKey,
        error: msg,
      });
      aborted = true;
      abortReason = msg;
      break;
    }

    // Conditional `if:`. A false predicate marks the action done with a
    // "skipped (if=false)" reason so the snapshot/log shows why nothing
    // happened. We re-use the `done` state because there's no "skipped"
    // ActionState; the run log captures the discriminator.
    let shouldRun: boolean;
    try {
      shouldRun = await evaluatePredicate(rendered.if, opts.ctx, opts.workspacePath);
    } catch (err) {
      const msg = (err as Error).message;
      upd(actionKey, { state: 'error', finished_at: iso(), error: msg });
      aborted = true;
      abortReason = msg;
      break;
    }
    if (!shouldRun) {
      upd(actionKey, { state: 'done', finished_at: iso() });
      opts.capture?.onChunk?.('stdout', `[action ${actionKey}] skipped (if=false)\n`);
      log.debug('action skipped', { action: actionKey, reason: 'if=false' });
      continue;
    }

    // Retry loop. Default policy: 3 retries with exponential backoff starting
    // at 1s, then `abort`. The on_error.then field overrides the default.
    const policy = effectivePolicy(action.on_error);
    let attempt = 0;
    let outcome: ActionOutcome | null = null;
    while (true) {
      outcome = await applyAction(rendered, opts).catch((err): ActionOutcome => ({
        ok: false,
        reason: (err as Error).message,
        route_to: null,
      }));
      if (outcome.ok) break;
      // Routed failure (e.g. merge conflict) — short-circuit the retry loop;
      // the route_to value will be returned to the runner.
      if (outcome.route_to) break;
      if (attempt >= policy.retry.count) break;
      const backoff = policy.retry.backoff_ms * Math.pow(2, attempt);
      opts.capture?.onChunk?.(
        'stderr',
        `[action ${actionKey}] attempt ${attempt + 1} failed: ${outcome.reason ?? 'unknown'}; retrying in ${backoff}ms\n`,
      );
      log.warn('action retrying', {
        action: actionKey,
        attempt: attempt + 1,
        next_backoff_ms: backoff,
        error: outcome.reason,
      });
      await delay(backoff);
      attempt++;
    }

    if (outcome.ok) {
      const note = outcome.cache_hit ? ' (cache hit)' : '';
      upd(actionKey, { state: 'done', finished_at: iso() });
      opts.capture?.onChunk?.('stdout', `[action ${actionKey}] ok${note}\n`);
      continue;
    }

    // Failure path. Two routes:
    //   1. action-typed routing (merge's on_conflict route_to fired by the
    //      executor): outcome.route_to is set.
    //   2. policy-typed routing (on_error.then.route_to): convert here.
    let route: string | null = outcome.route_to;
    if (!route && typeof policy.then === 'object' && policy.then.route_to) {
      route = policy.then.route_to;
    }
    upd(actionKey, {
      state: 'error',
      finished_at: iso(),
      error: outcome.reason ?? 'unknown',
    });
    opts.capture?.onChunk?.(
      'stderr',
      `[action ${actionKey}] failed: ${outcome.reason ?? 'unknown'}${route ? `; routing to ${route}` : ''}\n`,
    );
    log.warn('action failed', {
      action: actionKey,
      reason: outcome.reason,
      route_to: route,
    });
    if (route) {
      routeTo = route;
      aborted = true;
      abortReason = outcome.reason ?? 'unknown';
      break;
    }
    // No route; abort the cleanup actions list. (Default `then: "abort"`.)
    aborted = true;
    abortReason = outcome.reason ?? 'unknown';
  }

  return {
    ok: !aborted,
    reason: abortReason,
    route_to: routeTo,
    actions: ledger.slice(0, MAX_ACTION_HISTORY),
  };
}

function effectivePolicy(p: ActionErrorPolicy | undefined): {
  retry: { count: number; backoff_ms: number };
  then: 'abort' | { route_to: string };
} {
  return {
    retry: {
      count: p?.retry?.count ?? DEFAULT_RETRY_COUNT,
      backoff_ms: p?.retry?.backoff_ms ?? DEFAULT_RETRY_BACKOFF_MS,
    },
    then: p?.then ?? 'abort',
  };
}

function actionSnapshotKey(action: WorkflowAction, idx: number): string {
  if (action.name && action.name.length > 0) return `${action.kind}:${action.name}`;
  return `${action.kind}:#${idx}`;
}

// ===== Per-kind appliers ==================================================

async function applyAction(
  action: WorkflowAction,
  opts: ActionExecutorOptions,
): Promise<ActionOutcome> {
  switch (action.kind) {
    case 'push_branch':
      return applyPushBranch(action, opts);
    case 'create_pr_if_missing':
      return applyCreatePrIfMissing(action, opts);
    case 'ensure_branch':
      return applyEnsureBranch(action, opts);
    case 'checkout':
      return applyCheckout(action, opts);
    case 'merge':
      return applyMerge(action, opts);
    case 'delete_branch':
      return applyDeleteBranch(action, opts);
    case 'run_in_vm':
      return applyRunInVm(action, opts);
    case 'propose_followup':
      return applyProposeFollowup(action, opts);
    default: {
      const _exhaustive: never = action;
      void _exhaustive;
      return { ok: false, reason: 'unknown action kind', route_to: null };
    }
  }
}

async function applyPushBranch(
  action: PushBranchAction,
  opts: ActionExecutorOptions,
): Promise<ActionOutcome> {
  const res = await runCommand('git', ['push', '-u', action.remote, action.ref], opts);
  if (res.exit_code !== 0) {
    return {
      ok: false,
      reason: `git push ${action.remote} ${action.ref} exited ${res.exit_code}: ${diagnostic(res)}`,
      route_to: null,
    };
  }
  return { ok: true, reason: null, route_to: null };
}

async function applyCreatePrIfMissing(
  action: CreatePrIfMissingAction,
  opts: ActionExecutorOptions,
): Promise<ActionOutcome> {
  const view = await runCommand('gh', ['pr', 'view', action.head], opts);
  if (view.exit_code === 0) {
    opts.capture?.onChunk?.('stdout', `[create_pr_if_missing] PR for ${action.head} already exists\n`);
    return { ok: true, reason: null, route_to: null };
  }
  // `gh pr view` returns non-zero when no PR exists (or any other error). We
  // treat that as "open one"; gh will reject if the auth is missing or the
  // remote disagrees, and the failure surfaces as the create's diagnostic.
  const title = action.title_from;
  const body = action.body_from;
  const args = ['pr', 'create', '--base', action.base, '--head', action.head, '--title', title];
  // Convention: if `body_from` looks like an existing file path, pass via
  // `--body-file` (mirrors the SYMPHONY_PR_BODY_FILE hook contract); else
  // pass via `--body`. The orchestrator stages the body file before firing
  // actions for the Done state.
  if (await looksLikeFile(opts.workspacePath, body)) {
    args.push('--body-file', body);
  } else {
    args.push('--body', body);
  }
  const create = await runCommand('gh', args, opts);
  if (create.exit_code !== 0) {
    return {
      ok: false,
      reason: `gh pr create exited ${create.exit_code}: ${diagnostic(create)}`,
      route_to: null,
    };
  }
  return { ok: true, reason: null, route_to: null };
}

async function looksLikeFile(workspacePath: string, value: string): Promise<boolean> {
  if (!value || value.length === 0) return false;
  // Absolute path: probe directly. Relative path: probe against workspace.
  // Skip the probe for clearly-non-path strings (multi-line bodies, etc.).
  if (value.includes('\n')) return false;
  const probePath = path.isAbsolute(value) ? value : path.join(workspacePath, value);
  try {
    const { stat } = await import('node:fs/promises');
    const st = await stat(probePath);
    return st.isFile();
  } catch {
    return false;
  }
}

async function applyEnsureBranch(
  action: EnsureBranchAction,
  opts: ActionExecutorOptions,
): Promise<ActionOutcome> {
  const exists = await runCommand(
    'git',
    ['rev-parse', '--verify', '--quiet', `refs/heads/${action.name}`],
    opts,
    /*silent*/ true,
  );
  if (exists.exit_code === 0) return { ok: true, reason: null, route_to: null };
  const args = ['branch', action.name];
  if (action.seed_from && action.seed_from.length > 0) args.push(action.seed_from);
  const create = await runCommand('git', args, opts);
  if (create.exit_code !== 0) {
    return {
      ok: false,
      reason: `git branch ${action.name} exited ${create.exit_code}: ${diagnostic(create)}`,
      route_to: null,
    };
  }
  return { ok: true, reason: null, route_to: null };
}

async function applyCheckout(
  action: CheckoutAction,
  opts: ActionExecutorOptions,
): Promise<ActionOutcome> {
  const res = await runCommand('git', ['checkout', action.ref], opts);
  if (res.exit_code !== 0) {
    return {
      ok: false,
      reason: `git checkout ${action.ref} exited ${res.exit_code}: ${diagnostic(res)}`,
      route_to: null,
    };
  }
  return { ok: true, reason: null, route_to: null };
}

async function applyMerge(
  action: MergeAction,
  opts: ActionExecutorOptions,
): Promise<ActionOutcome> {
  // Switch to target, merge source. On conflict, abort the merge so the
  // working tree is clean and route to `on_conflict.route_to` (if set);
  // otherwise propagate as a failure for the generic retry/on_error path.
  const co = await runCommand('git', ['checkout', action.target], opts);
  if (co.exit_code !== 0) {
    return {
      ok: false,
      reason: `git checkout ${action.target} exited ${co.exit_code}: ${diagnostic(co)}`,
      route_to: null,
    };
  }
  const mergeMsg = `Merge ${action.source} into ${action.target}`;
  const res = await runCommand(
    'git',
    ['merge', '--no-ff', '--no-edit', '-m', mergeMsg, action.source],
    opts,
  );
  if (res.exit_code === 0) return { ok: true, reason: null, route_to: null };
  // Conflict: abort the merge so the working tree is clean.
  await runCommand('git', ['merge', '--abort'], opts, /*silent*/ true).catch(() => undefined);
  if (action.on_conflict === 'abort') {
    return {
      ok: false,
      reason: `merge of ${action.source} into ${action.target} failed: ${diagnostic(res)}`,
      route_to: null,
    };
  }
  return {
    ok: false,
    reason: `merge conflict: ${diagnostic(res)}`,
    route_to: action.on_conflict.route_to,
  };
}

async function applyDeleteBranch(
  action: DeleteBranchAction,
  opts: ActionExecutorOptions,
): Promise<ActionOutcome> {
  if (action.scope === 'local' || action.scope === 'both') {
    const res = await runCommand('git', ['branch', '-D', action.name], opts);
    if (res.exit_code !== 0) {
      return {
        ok: false,
        reason: `git branch -D ${action.name} exited ${res.exit_code}: ${diagnostic(res)}`,
        route_to: null,
      };
    }
  }
  if (action.scope === 'remote' || action.scope === 'both') {
    if (!action.remote) {
      return { ok: false, reason: 'delete_branch: remote scope requires a remote', route_to: null };
    }
    const res = await runCommand('git', ['push', action.remote, '--delete', action.name], opts);
    if (res.exit_code !== 0) {
      return {
        ok: false,
        reason: `git push --delete exited ${res.exit_code}: ${diagnostic(res)}`,
        route_to: null,
      };
    }
  }
  return { ok: true, reason: null, route_to: null };
}

async function applyRunInVm(
  action: RunInVmAction,
  opts: ActionExecutorOptions,
): Promise<ActionOutcome> {
  const cacheRoot = opts.cacheRoot ?? runInVmCacheRoot();
  const env = action.env ?? {};
  const hash = await computeCacheHash({ workspacePath: opts.workspacePath, cmd: action.cmd, env });
  const cached = await readCache(cacheRoot, action.name, hash);
  if (cached && cached.exit_code === 0) {
    // Cache hits only on prior success: "Did `npm test` already pass against
    // this tree hash?" The issue body's framing matches Bazel's semantics —
    // failures are transient (flaky test, network blip) and must not gate
    // a fresh execution. The retry policy + per-attempt re-execution work
    // together to give the in-process retry window a real chance.
    opts.capture?.onChunk?.(
      'stdout',
      `[run_in_vm ${action.name}] cache hit (hash=${hash.slice(0, 12)}…); skipping execution\n`,
    );
    return { ok: true, reason: null, route_to: null, cache_hit: true };
  }
  // The only escape hatch for arbitrary commands runs inside the per-issue
  // VM (the sandbox the agent was just running in). When no `runInVm`
  // closure is wired, fail loudly rather than fall back to host spawn —
  // dropping the sandbox boundary for the one surface that can carry
  // arbitrary commands is exactly the regression issue 36's typed-action
  // design exists to prevent.
  if (!opts.runInVm) {
    return {
      ok: false,
      reason: `run_in_vm "${action.name}" failed: no VM runner wired`,
      route_to: null,
    };
  }
  const timeoutMs = (action.timeout ?? Math.ceil((opts.defaultCommandTimeoutMs ?? 300_000) / 1000)) * 1000;
  const onStdout = (chunk: string): void => {
    opts.capture?.onChunk?.('stdout', chunk);
  };
  const onStderr = (chunk: string): void => {
    opts.capture?.onChunk?.('stderr', chunk);
  };
  const res = await opts.runInVm({
    name: action.name,
    cmd: action.cmd,
    env,
    workdir: opts.workspacePath,
    timeoutMs,
    onStdout,
    onStderr,
  });
  opts.capture?.onResult?.({
    ran: true,
    exit_code: res.exit_code,
    signal: res.signal,
    timed_out: res.timed_out,
    stdout: res.stdout,
    stderr: res.stderr,
  });
  const result = {
    exit_code: res.exit_code ?? -1,
    stdout: res.stdout,
    stderr: res.stderr,
    finished_at: isoFromClock(opts.now ?? realClock),
  };
  if (res.exit_code === 0) {
    // Cache successes only; see comment above the readCache branch.
    await writeCache(cacheRoot, action.name, hash, result).catch((err) =>
      log.warn('run_in_vm cache write failed', { name: action.name, hash, error: (err as Error).message }),
    );
    return { ok: true, reason: null, route_to: null };
  }
  return {
    ok: false,
    reason: `run_in_vm "${action.name}" exit=${res.exit_code}: ${diagnostic(res)}`,
    route_to: null,
  };
}

/**
 * Host-spawn implementation of `RunInVmExecutor`. Used by tests so a
 * unit test can exercise the cache/retry plumbing without booting a VM,
 * and as an explicit opt-in for harnesses that want host-mode execution
 * (e.g. running symphony against a workspace with no smolvm available).
 * Production wires the VM-side variant in `AgentRunner`; calling this
 * helper from the orchestrator path would defeat the sandbox boundary
 * the typed-action DAG exists to enforce.
 */
export const hostRunInVm: RunInVmExecutor = async ({
  cmd,
  env,
  workdir,
  timeoutMs,
  onStdout,
  onStderr,
}) => {
  const [bin, ...args] = cmd;
  return runProcess(bin!, args, {
    cwd: workdir,
    env,
    timeoutMs,
    capture: {
      onChunk: (stream, text) => {
        if (stream === 'stdout') onStdout?.(text);
        else onStderr?.(text);
      },
    },
  });
};

async function applyProposeFollowup(
  action: ProposeFollowupAction,
  opts: ActionExecutorOptions,
): Promise<ActionOutcome> {
  if (!opts.followupSink) {
    return {
      ok: false,
      reason: 'propose_followup action declared but no tracker sink wired',
      route_to: null,
    };
  }
  const input: Parameters<ProposeFollowupSink['proposeFollowup']>[0] = {
    title: action.title,
    parent_identifier: opts.ctx.identifier,
  };
  if (action.body !== undefined) input.description = action.body;
  if (action.labels !== undefined) input.labels = action.labels;
  if (action.priority !== undefined) input.priority = action.priority;
  try {
    const r = await opts.followupSink.proposeFollowup(input);
    opts.capture?.onChunk?.(
      'stdout',
      `[propose_followup] proposed ${r.identifier}: "${action.title}"\n`,
    );
    return { ok: true, reason: null, route_to: null };
  } catch (err) {
    return { ok: false, reason: `propose_followup failed: ${(err as Error).message}`, route_to: null };
  }
}

// ===== Process helpers ====================================================

type CmdResult = RunResult;

interface RunCommandExtra {
  extraEnv?: Record<string, string>;
  timeoutMs?: number;
}

function diagnostic(res: { stdout: string; stderr: string }): string {
  const parts = [res.stderr.trim(), res.stdout.trim()].filter((s) => s.length > 0);
  const combined = parts.join('\n');
  if (combined.length <= 2048) return combined;
  return combined.slice(0, 2048) + '\n…(truncated)';
}

// Thin specialization over the unified `runProcess`: glues per-action workspace
// + capture + per-action timeout into the shared options bag, and threads the
// `silent` flag so cleanup-side commands (e.g. `git merge --abort`) don't
// double-log into the per-issue capture surface.
function runCommand(
  bin: string,
  args: string[],
  opts: ActionExecutorOptions,
  silent = false,
  extra: RunCommandExtra = {},
): Promise<CmdResult> {
  return runProcess(bin, args, {
    cwd: opts.workspacePath,
    env: extra.extraEnv,
    timeoutMs: extra.timeoutMs ?? opts.defaultCommandTimeoutMs ?? 300_000,
    capture: silent ? undefined : opts.capture,
  });
}

// ===== Cache invalidation by name (rerun CLI) =============================

/**
 * Drop every cache entry for a named `run_in_vm` action. Used by
 * `symphony rerun --check=<name>`: the next dispatch into the state hosting
 * the check sees an empty cache namespace and re-executes, while every
 * other check's entries stay in place.
 *
 * No workspace argument: the cache is namespaced by action name on disk
 * (`<root>/actions/run_in_vm/<name>/<hash>/`), so invalidation is a
 * namespace-directory drop, not a hash lookup. This is the layout fix for
 * the rerun CLI — the CLI has no per-issue workspace to hash against, and
 * the per-execution hash is workspace-dependent, so any hash-keyed
 * invalidation would miss the entry the per-issue execution actually wrote.
 */
export async function invalidateRunInVmByName(
  action: RunInVmAction,
  cacheRoot?: string,
): Promise<void> {
  await invalidateCacheByName(cacheRoot ?? runInVmCacheRoot(), action.name);
}

/**
 * Pack the executor's per-action ledger into a Snapshot-shaped record so
 * the orchestrator can surface it alongside reconciler resources. `id` is
 * the same scope id passed at run time (`actions:<state>`); `ready=true`
 * mirrors the bake resource's "no outstanding work" semantic.
 */
export function toActionsSnapshot(
  id: string,
  result: ActionExecResult,
): ActionsSnapshot {
  const lastErr = result.actions.find((a) => a.state === 'error')?.error ?? null;
  return {
    id,
    ready: result.ok,
    last_error: lastErr,
    actions: result.actions.slice(0, MAX_ACTION_HISTORY),
  };
}

// Re-export for convenience.
export type { ActionStatus, ActionState };
