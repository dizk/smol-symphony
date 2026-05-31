// Unified child_process wrapper (issue 44). Owns spawn lifecycle for every
// host-side shell-out: git, gh, and similar tooling. Replaces seven near-
// identical wrappers that had each independently re-encoded the same spawn
// quirks (pipe both streams, accumulate with a max-bytes clamp, optional
// onChunk capture, optional timeout that SIGKILLs on overrun, optional
// cwd/env override).
//
// The single owner is what makes subprocess-management changes one-file
// edits — zombie reaping, prctl(PR_SET_PDEATHSIG), signal-propagation
// quirks all land here once instead of being applied seven times.

import { spawn } from 'node:child_process';

/**
 * Default per-stream byte clamp. Picked to match the dominant value across
 * the wrappers this module replaces (workspace, agent/integration,
 * actions/executor all used 65_536). Callers needing a larger buffer
 * (e.g. a large `git`/`gh` JSON payload) pass `maxBytes` explicitly.
 */
export const DEFAULT_MAX_BYTES = 65_536;

export interface RunResult {
  /**
   * Always true once `spawn()` returned — every call that reaches here
   * attempts the spawn, so there is no "did not run" sentinel to distinguish.
   */
  ran: true;
  /** Process exit code, or null if the process was signalled or spawn errored. */
  exit_code: number | null;
  /** Terminating signal, or null. */
  signal: NodeJS.Signals | null;
  /** True iff the timeout fired and we SIGKILLed the child. */
  timed_out: boolean;
  /** Captured stdout, clamped to `maxBytes`. */
  stdout: string;
  /** Captured stderr, clamped to `maxBytes`. */
  stderr: string;
}

export interface RunCapture {
  /** Fires for every stdout/stderr chunk the child produces (pre-clamp). */
  onChunk?: (stream: 'stdout' | 'stderr', text: string) => void;
  /** Fires once with the final result, immediately before the promise resolves. */
  onResult?: (result: RunResult) => void;
}

export interface RunOptions {
  cwd?: string;
  /** Merged on top of `process.env`. Pass `null` to use only this env. */
  env?: Record<string, string>;
  /** SIGKILL the child after this many ms. Omit / 0 = no timeout. */
  timeoutMs?: number;
  /** Per-stream byte clamp. Defaults to {@link DEFAULT_MAX_BYTES}. */
  maxBytes?: number;
  capture?: RunCapture;
  /**
   * When the `error` event fires (e.g. ENOENT for a missing binary), append
   * the error message to stderr so diagnostics surface what went wrong.
   * Defaults to true — most existing call sites already do this. Set false
   * for callers that only inspect exit_code (e.g. predicates).
   */
  appendErrorToStderr?: boolean;
}

/**
 * Run a process and capture its output. The single source of truth for
 * spawn-lifecycle behavior in this codebase: every shell-out goes through
 * here, so timeout, capture, env merge, and clamp all live in one place.
 *
 * Resolves (never rejects). Failure cases:
 *   - Spawn errored (ENOENT, EACCES): exit_code = null, stderr includes the
 *     OS error message when `appendErrorToStderr` is true.
 *   - Process timed out: timed_out = true, signal = 'SIGKILL'.
 *   - Process exited non-zero: exit_code carries the code.
 *
 * Callers that want a throwing variant use {@link runProcessExpect}.
 */
export function runProcess(
  bin: string,
  args: string[],
  opts: RunOptions = {},
): Promise<RunResult> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const appendErr = opts.appendErrorToStderr ?? true;
  const env = opts.env ? { ...process.env, ...opts.env } : process.env;
  return new Promise((resolve) => {
    const child = spawn(bin, args, {
      cwd: opts.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: env as NodeJS.ProcessEnv,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    child.stdout?.on('data', (b) => {
      const text = b.toString('utf8');
      stdout += text;
      if (stdout.length > maxBytes) stdout = stdout.slice(0, maxBytes);
      opts.capture?.onChunk?.('stdout', text);
    });
    child.stderr?.on('data', (b) => {
      const text = b.toString('utf8');
      stderr += text;
      if (stderr.length > maxBytes) stderr = stderr.slice(0, maxBytes);
      opts.capture?.onChunk?.('stderr', text);
    });
    const timer =
      opts.timeoutMs && opts.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            child.kill('SIGKILL');
          }, opts.timeoutMs)
        : null;
    const finish = (r: RunResult): void => {
      // Spawn failures emit both `error` and `close` for the same child (Node
      // emits ENOENT as `error` then synthesizes a `close` with code=-2). Both
      // handlers route here, so guard against double-settling — `onResult` is
      // documented as firing once, and downstream consumers (run-log and
      // action results) rely on that.
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      opts.capture?.onResult?.(r);
      resolve(r);
    };
    child.on('error', (err) => {
      const errStderr = appendErr ? `${stderr}${stderr.length > 0 ? '\n' : ''}${err.message}` : stderr;
      finish({
        ran: true,
        exit_code: null,
        signal: null,
        timed_out: timedOut,
        stdout,
        stderr: errStderr.length > maxBytes ? errStderr.slice(0, maxBytes) : errStderr,
      });
    });
    child.on('close', (code, signal) => {
      finish({
        ran: true,
        exit_code: code,
        signal: signal ?? null,
        timed_out: timedOut,
        stdout,
        stderr,
      });
    });
  });
}

/**
 * Throwing variant. Rejects with a {@link RunProcessError} when the process
 * timed out, was signalled, or exited non-zero (including `exit_code === null`
 * from a spawn error). Thin convenience over {@link runProcess} — the result
 * is still attached to the error so callers can inspect captured output.
 */
export async function runProcessExpect(
  bin: string,
  args: string[],
  opts: RunOptions = {},
): Promise<RunResult> {
  const r = await runProcess(bin, args, opts);
  if (r.exit_code !== 0 || r.timed_out || r.signal !== null) {
    throw new RunProcessError(bin, args, r);
  }
  return r;
}

export class RunProcessError extends Error {
  constructor(
    public readonly bin: string,
    public readonly args: string[],
    public readonly result: RunResult,
  ) {
    super(`${bin} ${args.join(' ')} ${describeRunFailure(result)}`);
    this.name = 'RunProcessError';
  }
}

/** Shared phrasing for run failure causes; used by RunProcessError and callers
 *  that want to surface the same wording (e.g. workspace.ts WorkspaceError). */
export function describeRunFailure(r: RunResult): string {
  if (r.timed_out) return 'timed out';
  if (r.signal !== null) return `terminated by signal ${r.signal}`;
  return `exited with code ${r.exit_code}`;
}
