// Workspace manager (SPEC §9). Per-issue workspace dirs under workspace.root.
//
// Safety invariants enforced:
// 1. Workspace path is rooted at workspace.root (containment check).
// 2. Workspace key is sanitized — only [A-Za-z0-9._-] allowed.
// 3. Agent cwd MUST equal the workspace path (enforced by callers via runWithCwd).

import { mkdir, rm, lstat } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { Workspace, HooksConfig, ServiceConfig } from './types.js';

export class WorkspaceError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'WorkspaceError';
  }
}

// §9.5 Invariant 3.
export function sanitizeWorkspaceKey(identifier: string): string {
  return identifier.replace(/[^A-Za-z0-9._-]/g, '_');
}

// §9.5 Invariant 2: workspace path MUST be contained within workspace root.
//
// We deliberately check for a `..` path component rather than a `..` prefix on the
// relative path: an identifier like `..fix` sanitizes to a perfectly contained child
// directory whose relative path begins with the two-character substring `..` but does
// not actually escape the root.
export function assertContained(workspaceRoot: string, candidate: string): void {
  const rootAbs = path.resolve(workspaceRoot);
  const candAbs = path.resolve(candidate);
  if (candAbs === rootAbs) {
    throw new WorkspaceError(
      'invalid_workspace_path',
      `workspace path must not equal workspace root (${rootAbs})`,
    );
  }
  const rel = path.relative(rootAbs, candAbs);
  if (rel === '' || path.isAbsolute(rel)) {
    throw new WorkspaceError(
      'invalid_workspace_path',
      `workspace path ${candAbs} is not contained within ${rootAbs}`,
    );
  }
  const parts = rel.split(path.sep);
  if (parts.some((p) => p === '..')) {
    throw new WorkspaceError(
      'invalid_workspace_path',
      `workspace path ${candAbs} is not contained within ${rootAbs}`,
    );
  }
}

export interface HookResult {
  ran: boolean;
  exit_code: number | null;
  signal: NodeJS.Signals | null;
  timed_out: boolean;
  stdout: string;
  stderr: string;
}

// A hook failed when it timed out, exited with a non-zero status, or was terminated by a
// signal. The signal-termination case is important — otherwise a fatal `before_run` script
// that calls `kill -TERM $$` would look successful (exit_code=null, timed_out=false).
function hookFailed(res: HookResult): boolean {
  return res.timed_out || res.signal !== null || res.exit_code !== 0;
}

function hookFailureReason(res: HookResult): string {
  if (res.timed_out) return 'timed out';
  if (res.signal !== null) return `terminated by signal ${res.signal}`;
  return `exited with code ${res.exit_code}`;
}

// Execute a hook script (POSIX `sh -lc`). Returns result so callers can decide on failure
// semantics (§9.4).
export async function runHookScript(
  script: string,
  cwd: string,
  timeoutMs: number,
): Promise<HookResult> {
  return new Promise((resolve) => {
    const child = spawn('sh', ['-lc', script], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout?.on('data', (b) => {
      stdout += b.toString('utf8');
      if (stdout.length > 65_536) stdout = stdout.slice(0, 65_536);
    });
    child.stderr?.on('data', (b) => {
      stderr += b.toString('utf8');
      if (stderr.length > 65_536) stderr = stderr.slice(0, 65_536);
    });
    const t = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.on('error', () => {
      clearTimeout(t);
      resolve({ ran: true, exit_code: null, signal: null, timed_out: timedOut, stdout, stderr });
    });
    child.on('close', (code, signal) => {
      clearTimeout(t);
      resolve({
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

export class WorkspaceManager {
  constructor(private cfg: ServiceConfig) {}

  updateConfig(cfg: ServiceConfig): void {
    this.cfg = cfg;
  }

  workspacePathFor(identifier: string): string {
    const key = sanitizeWorkspaceKey(identifier);
    if (key.length === 0) {
      throw new WorkspaceError('invalid_workspace_key', `cannot sanitize identifier: ${identifier}`);
    }
    return path.join(this.cfg.workspace.root, key);
  }

  // Ensure the per-issue workspace directory exists. Runs after_create when created_now.
  async ensureFor(identifier: string): Promise<Workspace> {
    const workspaceRoot = this.cfg.workspace.root;
    await mkdir(workspaceRoot, { recursive: true });
    const wsPath = this.workspacePathFor(identifier);
    assertContained(workspaceRoot, wsPath);

    let createdNow = false;
    try {
      // Use lstat so symlinks at the workspace path are rejected: a symlink could redirect
      // hook execution and the returned cwd outside the workspace root, which violates the
      // §9.5 containment invariant.
      const st = await lstat(wsPath);
      if (st.isSymbolicLink()) {
        throw new WorkspaceError(
          'workspace_path_is_symlink',
          `workspace path ${wsPath} is a symlink; refusing to use`,
        );
      }
      if (!st.isDirectory()) {
        throw new WorkspaceError(
          'workspace_path_not_directory',
          `expected directory at ${wsPath}, found a non-directory`,
        );
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        await mkdir(wsPath, { recursive: true });
        createdNow = true;
      } else {
        throw err;
      }
    }

    if (createdNow && this.cfg.hooks.after_create) {
      const res = await runHookScript(
        this.cfg.hooks.after_create,
        wsPath,
        this.cfg.hooks.timeout_ms,
      );
      if (hookFailed(res)) {
        // §9.4: after_create failure is fatal — also unwind the partially prepared directory.
        try {
          await rm(wsPath, { recursive: true, force: true });
        } catch {
          // Best-effort cleanup.
        }
        throw new WorkspaceError(
          'after_create_failed',
          `after_create hook ${hookFailureReason(res)}`,
        );
      }
    }

    return {
      path: wsPath,
      workspace_key: sanitizeWorkspaceKey(identifier),
      created_now: createdNow,
    };
  }

  // Run before_run; throw on failure/timeout (§9.4).
  async runBeforeRun(workspacePath: string, hooks: HooksConfig): Promise<void> {
    if (!hooks.before_run) return;
    const res = await runHookScript(hooks.before_run, workspacePath, hooks.timeout_ms);
    if (hookFailed(res)) {
      throw new WorkspaceError('before_run_failed', `before_run hook ${hookFailureReason(res)}`);
    }
  }

  // Best-effort after_run hook (§9.4: failure logged and ignored — caller logs).
  async runAfterRunBestEffort(workspacePath: string, hooks: HooksConfig): Promise<HookResult | null> {
    if (!hooks.after_run) return null;
    return runHookScript(hooks.after_run, workspacePath, hooks.timeout_ms);
  }

  // Best-effort before_remove + filesystem removal (§9.4).
  async remove(identifier: string, hooks: HooksConfig): Promise<HookResult | null> {
    const wsPath = this.workspacePathFor(identifier);
    assertContained(this.cfg.workspace.root, wsPath);
    let hookResult: HookResult | null = null;
    try {
      const st = await lstat(wsPath);
      if (st.isSymbolicLink() || !st.isDirectory()) return null;
    } catch {
      return null;
    }
    if (hooks.before_remove) {
      hookResult = await runHookScript(hooks.before_remove, wsPath, hooks.timeout_ms);
    }
    await rm(wsPath, { recursive: true, force: true });
    return hookResult;
  }
}
