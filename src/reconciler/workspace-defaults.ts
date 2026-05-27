// Workspace resource adapters (shell). Concrete fs + git shell-out
// implementations of the listing / inspection / removal ports declared on
// {@link WorkspaceResource}. Lifted out of `reconciler/workspace.ts` so the
// core resource module stays pure domain (issue 86) — workspace.ts no longer
// imports `node:fs/promises` or `util/process`. Production wiring lives in
// `reconciler/index.ts`; tests pass their own stubs and reach for these
// helpers only when they want the real fs/git path.

import { readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { runProcess } from '../util/process.js';
import type { WorkspaceInspection } from './workspace.js';

/**
 * Enumerate the workspace root, returning one entry per directory. Non-
 * directory entries (stray files, broken symlinks) are filtered out so the
 * resource only ever reasons about workspace dirs.
 *
 * ENOENT on the root is treated as the cold-start case — return an empty
 * list rather than throwing. The first reconciler-driven create call will
 * mkdir the root via `WorkspaceManager.ensureFor`. Any other readdir error
 * propagates so the resource can record it in `last_error` and skip the pass
 * rather than reaping every workspace on a transient FS hiccup.
 */
export async function defaultListWorkspaceDirs(
  root: string,
): Promise<Array<{ name: string; path: string }>> {
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return [];
    throw err;
  }
  const out: Array<{ name: string; path: string }> = [];
  for (const name of entries) {
    const p = path.join(root, name);
    try {
      const st = await stat(p);
      if (st.isDirectory()) out.push({ name, path: p });
    } catch {
      // Skip entries that vanish or fail stat — the next pass picks them up.
    }
  }
  return out;
}

/**
 * Stat-based default inspector. All git invocations are workspace-local: we
 * never reach across to the source repo's object store, which is why drift
 * detection lives in the resource (comparing this inspector's
 * `workspaceBaseSha` to `BaseRefProvider.currentBaseRef().sha`) rather than
 * here. Returns `head: null` for anything that doesn't look like a git repo —
 * the caller treats that as "can't reason about this dir, don't touch it."
 */
export async function defaultInspectWorkspace(
  workspacePath: string,
  baseBranch: string,
): Promise<WorkspaceInspection> {
  const head = await runGitCapture(workspacePath, ['rev-parse', 'HEAD']);
  if (head.exit !== 0 || head.stdout.trim().length === 0) {
    return {
      head: null,
      workspaceBaseSha: null,
      hasUncommitted: false,
      commitsAheadOfBase: 0,
    };
  }
  const headSha = head.stdout.trim();
  const status = await runGitCapture(workspacePath, ['status', '--porcelain']);
  const hasUncommitted = status.exit === 0 && status.stdout.length > 0;
  // Workspace's frozen view of the base branch — the SHA that was current in
  // the source repo at clone time. The setup pipeline cuts the agent branch
  // from this ref, so it's always present unless an operator manually deleted
  // it.
  const wsBase = await runGitCapture(workspacePath, ['rev-parse', baseBranch]);
  const workspaceBaseSha =
    wsBase.exit === 0 && wsBase.stdout.trim().length > 0 ? wsBase.stdout.trim() : null;
  let aheadCount = 0;
  if (workspaceBaseSha !== null) {
    // `<base>..HEAD` walks only objects the workspace itself owns — no
    // cross-repo reachability needed. Exits non-zero only for malformed refs;
    // treat that as 0 commits ahead rather than poisoning the snapshot.
    const ahead = await runGitCapture(workspacePath, [
      'rev-list',
      '--count',
      `${workspaceBaseSha}..${headSha}`,
    ]);
    aheadCount = ahead.exit === 0 ? Number(ahead.stdout.trim()) || 0 : 0;
  }
  return { head: headSha, workspaceBaseSha, hasUncommitted, commitsAheadOfBase: aheadCount };
}

/**
 * Default removal: just `rm -rf` the directory. Production wiring overrides
 * this with `WorkspaceManager.remove` so the configured before_remove hook
 * fires. The two-callback design lets tests skip the hook plumbing entirely.
 */
export async function defaultRemoveWorkspace(
  workspaceRoot: string,
  identifier: string,
): Promise<void> {
  const dir = path.join(workspaceRoot, identifier);
  await rm(dir, { recursive: true, force: true });
}

interface GitCaptureResult {
  exit: number;
  stdout: string;
  stderr: string;
}

// Thin shape adapter over runProcess. Stays as a named local because the
// inspector's call sites read `result.exit` rather than `exit_code`, and
// historical clamp is 16 KiB (smaller than the unified default — the
// inspector only ever reads a SHA or a single porcelain status line).
async function runGitCapture(cwd: string, args: string[]): Promise<GitCaptureResult> {
  const r = await runProcess('git', args, { cwd, maxBytes: 16_384, appendErrorToStderr: false });
  return { exit: r.exit_code ?? -1, stdout: r.stdout, stderr: r.stderr };
}
