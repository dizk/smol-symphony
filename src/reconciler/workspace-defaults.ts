// Workspace resource adapters (shell). Concrete fs + git implementations of
// the listing / inspection / removal ports declared on {@link WorkspaceResource}.
// Lifted from workspace.ts (issue 86) so the core resource no longer imports
// `node:fs/promises` or `util/process`. Production wiring lives in
// `reconciler/index.ts`; tests pass stubs and reach for these helpers only
// when they want the real fs/git path.

import { readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { runProcess } from '../util/process.js';
import type { WorkspaceInspection, WorkspaceListing } from './workspace.js';

/**
 * Enumerate workspace dirs under `root`. Non-directories are filtered out.
 * ENOENT on the root → empty list (cold start). Other errors propagate so the
 * resource records them in `last_error` rather than reaping every workspace
 * on a transient FS hiccup.
 */
export async function defaultListWorkspaceDirs(root: string): Promise<WorkspaceListing[]> {
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const out: WorkspaceListing[] = [];
  for (const name of entries) {
    const p = path.join(root, name);
    try {
      const st = await stat(p);
      if (st.isDirectory()) out.push({ name, path: p });
    } catch {
      // Entry vanished mid-pass; next reconcile picks it up.
    }
  }
  return out;
}

/**
 * Default inspector. All git invocations are workspace-local; drift detection
 * lives in the resource (compares `workspaceBaseSha` to the source repo's
 * current base SHA). Returns `head: null` for anything that doesn't look like
 * a git repo — the caller treats that as "don't touch this dir."
 */
export async function defaultInspectWorkspace(
  workspacePath: string,
  baseBranch: string,
): Promise<WorkspaceInspection> {
  const head = await runGitCapture(workspacePath, ['rev-parse', 'HEAD']);
  if (head.exit !== 0 || head.stdout.trim().length === 0) {
    return { head: null, workspaceBaseSha: null, hasUncommitted: false, commitsAheadOfBase: 0 };
  }
  const headSha = head.stdout.trim();
  const status = await runGitCapture(workspacePath, ['status', '--porcelain']);
  const hasUncommitted = status.exit === 0 && status.stdout.length > 0;
  // Workspace's frozen view of the base branch — the SHA that was current in
  // the source repo at clone time. The setup pipeline cuts the agent branch
  // from this ref, so it's always present unless an operator manually deleted it.
  const wsBase = await runGitCapture(workspacePath, ['rev-parse', baseBranch]);
  const workspaceBaseSha =
    wsBase.exit === 0 && wsBase.stdout.trim().length > 0 ? wsBase.stdout.trim() : null;
  let aheadCount = 0;
  if (workspaceBaseSha !== null) {
    // `<base>..HEAD` walks only objects the workspace itself owns — no cross-repo
    // reachability needed. Exits non-zero only for malformed refs; treat that
    // as 0 commits ahead rather than poisoning the snapshot.
    const ahead = await runGitCapture(workspacePath, [
      'rev-list',
      '--count',
      `${workspaceBaseSha}..${headSha}`,
    ]);
    aheadCount = ahead.exit === 0 ? Number(ahead.stdout.trim()) || 0 : 0;
  }
  return { head: headSha, workspaceBaseSha, hasUncommitted, commitsAheadOfBase: aheadCount };
}

/** Default removal: `rm -rf` the dir. Production wraps `WorkspaceManager.remove`; the two-callback design lets tests pass a stub. */
export async function defaultRemoveWorkspace(
  workspaceRoot: string,
  identifier: string,
): Promise<void> {
  await rm(path.join(workspaceRoot, identifier), { recursive: true, force: true });
}

// Thin shape adapter over runProcess: the inspector reads `result.exit`
// (vs. `exit_code`) and uses a tighter 16 KiB cap than runProcess's default.
async function runGitCapture(
  cwd: string,
  args: string[],
): Promise<{ exit: number; stdout: string; stderr: string }> {
  const r = await runProcess('git', args, { cwd, maxBytes: 16_384, appendErrorToStderr: false });
  return { exit: r.exit_code ?? -1, stdout: r.stdout, stderr: r.stderr };
}
