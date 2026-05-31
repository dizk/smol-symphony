// Workspace manager (SPEC §5). Per-issue workspace dirs under workspace.root.
//
// Safety invariants enforced:
// 1. Workspace path is rooted at workspace.root (containment check).
// 2. Workspace key is sanitized — only [A-Za-z0-9._-] allowed.
// 3. Agent cwd MUST equal the workspace path (enforced by callers via runWithCwd).

import { mkdir, rm, lstat, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Workspace, ServiceConfig } from './types.js';
import { runProcess, type RunResult } from './util/process.js';
import { sanitizeWorkspaceKey } from './util/workspace-key.js';

// Re-exported so existing shell/entry importers (agent/runner.ts, tests) keep their
// `from '../workspace.js'` import path. The canonical definitions live in the
// foundation layer (util/workspace-key, workspace-types) so domain modules can
// import them directly without crossing the adapters↛inward boundary. The
// `HookCapture`/`HookResult` shapes are the shared run-log/shell-out capture
// types the actions executor and the per-issue run log key off of.
export { sanitizeWorkspaceKey };
export type { HookCapture, HookResult } from './workspace-types.js';

export class WorkspaceError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'WorkspaceError';
  }
}

// §5.5 Invariant 2: workspace path MUST be contained within workspace root.
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

// Inputs for the canonical per-issue clone+branch+remote setup (issue 34).
// Previously lived as a repo-local `after_create` shell in WORKFLOW.md; lifted
// into TypeScript so the canonical setup is unit-testable and the reconciler's
// `workspace` resource owns it as a typed action instead of an opaque shell
// blob. See `setupWorkspaceDir` below.
export interface SetupWorkspaceDirOptions {
  // Empty target directory (already created by the caller).
  workspacePath: string;
  // Absolute path to the local source repo to clone from. Hardlinks objects
  // via `git clone --local` when possible.
  sourceRepo: string;
  // Base branch to land on (e.g. `main`).
  baseBranch: string;
  // Per-issue branch to cut from base (e.g. `agent/42`).
  branch: string;
  // GitHub `owner/repo` when the operator wants the host-side Done-state push
  // to reach a remote. `null` leaves the workspace network-isolated (no origin
  // remote).
  originRepo: string | null;
  // Explicit origin URL override. Defaults to the canonical
  // `https://github.com/<originRepo>.git`. Exists so tests (and non-github
  // remotes) can point origin at a reachable URL; production leaves it unset.
  originUrl?: string;
  // Pinned identity for commits the agent makes in the workspace.
  gitIdentity: { name: string; email: string };
}

// `runGit` / `runGitExpect` are thin specializations over the unified
// `runProcess` in util/process.ts: WorkspaceError wrapping is the reason they
// exist as named locals (the spawn quirks live in the util).
async function runGit(args: string[], cwd: string): Promise<RunResult> {
  return runProcess('git', args, { cwd });
}

async function runGitExpect(args: string[], cwd: string): Promise<RunResult> {
  const r = await runGit(args, cwd);
  if (r.exit_code !== 0) {
    throw new WorkspaceError(
      'workspace_setup_git_failed',
      `git ${args.join(' ')} exited ${r.exit_code}: ${r.stderr.trim() || r.stdout.trim()}`,
    );
  }
  return r;
}

/**
 * Canonical per-issue clone+branch+remote setup (issue 34). Performs the work
 * a repo-local `after_create` shell once did, but in TypeScript so:
 *
 *   1. The setup is unit-testable independent of any workflow-defined glue.
 *   2. The reconciler's `workspace` resource owns it as a typed `create_workspace`
 *      action instead of an opaque shell blob.
 *   3. State-machine behavior (origin restoration, identity pinning) is owned by
 *      the orchestrator, not a shell script.
 *
 * Behavior (mirroring the shell version's invariants minus the origin-fetch
 * reset — see "Base ref source-of-truth" below):
 *
 *   - `git clone --local --no-tags --branch <base> <source> .` into `workspacePath`,
 *     hardlinking objects when possible (fast + disk-cheap).
 *   - Strip every remote the clone left behind so any in-VM `git push`/`git fetch`
 *     fails closed (no network targets reachable from inside the dispatched agent).
 *   - Unset any inherited `credential.helper` for the same reason.
 *   - When `originRepo` is set, restore an `origin` pointing at the canonical
 *     HTTPS URL (no token; auth comes from the host's `gh` and never enters the
 *     VM). `gh auth setup-git` runs best-effort so a later host-side `git push`
 *     from the Done-state `push_branch` action can authenticate.
 *   - Pin `user.name`/`user.email` to the symphony-agent identity.
 *   - `git checkout -b <branch>` to cut the per-issue branch.
 *
 * Base ref source-of-truth: the source repo's local `<base>` is the canonical
 * reference. The previous shell version also fetched `origin/<base>` when
 * `originRepo` was set and reset the workspace's base to that live remote tip,
 * but that created two divergent sources of truth — `Orchestrator.currentBaseRef`
 * resolves `<base>` in the source repo, and a fetch-and-reset workspace would
 * be based on a ref the reconciler can't see. The drift detector caught the
 * resulting "freshly cloned workspace is already stale" false positives, so
 * the fetch+reset step is gone. To pick up a new base, the operator updates
 * the source repo (`git pull` / `git fetch`) and the next workspace clones
 * from the updated source.
 *
 * `workspacePath` must exist and be empty. Caller is responsible for the mkdir
 * and for unwinding the directory on failure.
 */
export async function setupWorkspaceDir(opts: SetupWorkspaceDirOptions): Promise<void> {
  const { workspacePath, sourceRepo, baseBranch, branch, originRepo, originUrl, gitIdentity } = opts;
  // 1. Source repo must look like a git repo. Same check the shell ran, lifted
  //    into TypeScript so the error surfaces as a typed WorkspaceError rather
  //    than a shell exit code the runner has to decode.
  try {
    const gitDir = path.join(sourceRepo, '.git');
    const st = await stat(gitDir);
    if (!st.isDirectory() && !st.isFile()) {
      throw new WorkspaceError(
        'workspace_setup_no_source_repo',
        `source repo ${sourceRepo} is not a git repository`,
      );
    }
  } catch (err) {
    if (err instanceof WorkspaceError) throw err;
    throw new WorkspaceError(
      'workspace_setup_no_source_repo',
      `source repo ${sourceRepo} is not a git repository: ${(err as Error).message}`,
    );
  }

  // 2. Clone hardlinked, narrow refspec, land on base. `.` is the cwd so the
  //    objects/refs go directly into `workspacePath`.
  await runGitExpect(
    ['clone', '--local', '--no-tags', '--branch', baseBranch, sourceRepo, '.'],
    workspacePath,
  );

  // 3. Strip all remotes the clone copied over (typically just `origin`
  //    pointing at SOURCE_REPO). Network targets stay zero by default.
  const remotes = await runGitExpect(['remote'], workspacePath);
  for (const remote of remotes.stdout.split(/\r?\n/).map((r) => r.trim()).filter((r) => r.length > 0)) {
    await runGitExpect(['remote', 'remove', remote], workspacePath);
  }
  // Unset credential.helper if the clone inherited one. Best-effort: an empty
  // local config returns exit 5 which is fine.
  await runGit(['config', '--local', '--unset', 'credential.helper'], workspacePath);

  // 4. Conditional origin restore. SYMPHONY_REPO is the documented "I want
  //    the Done-state push to reach a remote" opt-in; without it the workspace
  //    stays purely local and no origin is configured. The remote URL is the
  //    canonical HTTPS form (no token); auth comes from the host's `gh`,
  //    which never enters the VM. Unlike the prior shell version, we do
  //    NOT fetch `origin/<base>` and reset — see the function comment for
  //    why; the source repo's local `<base>` is the canonical base ref.
  if (originRepo && originRepo.length > 0) {
    await runGitExpect(
      ['remote', 'add', 'origin', originUrl ?? `https://github.com/${originRepo}.git`],
      workspacePath,
    );
    // `gh auth setup-git` is best-effort: a host without gh installed should
    // still get a working workspace with an origin pointing at the HTTPS URL,
    // even if a later push fails for lack of credentials.
    await runProcess('gh', ['auth', 'setup-git'], { cwd: workspacePath });
  }

  // 5. Pin commit identity. Local-only so this never leaks into ~/.gitconfig.
  await runGitExpect(
    ['config', '--local', 'user.name', gitIdentity.name],
    workspacePath,
  );
  await runGitExpect(
    ['config', '--local', 'user.email', gitIdentity.email],
    workspacePath,
  );

  // 6. Land HEAD on the per-issue branch. When the branch already exists on
  //    `origin` (a re-dispatch after the PR autopilot routes a conflicting issue
  //    back to the implementing state, or any prior push), restore it so the
  //    agent's already-pushed work is carried forward and rebased onto the fresh
  //    base — rather than cutting a new branch off base and orphaning that work.
  //    Only the issue's first dispatch (no remote branch yet) takes the
  //    fresh-cut path. See `restorePushedBranch` for the loop this closes.
  if (await restorePushedBranch(workspacePath, branch)) return;
  await runGitExpect(['checkout', '-b', branch], workspacePath);
}

/**
 * Restore an already-pushed per-issue branch into a freshly-cloned workspace, so
 * a re-dispatch continues from the work that was pushed instead of discarding it.
 * Returns true when `origin/<branch>` existed and HEAD now sits on a local
 * `<branch>` at the fetched remote tip; false when there is no `origin`
 * (local-only mode) or no such remote branch yet (the issue's first dispatch), in
 * which case the caller cuts a fresh branch off base.
 *
 * The dispatched agent rebases this restored branch onto the freshly-fetched base
 * (`fetchBaseInWorkspace` + the Todo prompt's `git rebase origin/<base>`), so a
 * stale-based restored branch is carried forward and any conflicts resolved as
 * part of the normal flow. Without this restore, every re-dispatch cut a
 * brand-new branch off base and orphaned the pushed `agent/<id>` commits: a
 * bounced issue redid all its work from scratch and its remote branch never
 * advanced past the first push, so the PR stayed CONFLICTING and the autopilot
 * re-routed it forever — a non-converging Done→conflict→reroute→redo loop.
 *
 * Fails closed on a transport/auth error rather than cutting fresh: only an
 * `ls-remote --exit-code` "no matching refs" (exit 2) means the branch truly
 * doesn't exist yet. An unreachable/unauthenticated origin (exit 128, …) is
 * indistinguishable from "branch present but unobservable", so falling back to a
 * fresh cut there would risk the next push force-with-lease'ing over already-
 * pushed work once the origin recovers (`runCanonicalSetup` won't re-run on the
 * existing dir). Throwing makes `runCanonicalSetup` unwind the dir so a later
 * tick retries the restore. Network calls run with `GIT_TERMINAL_PROMPT=0` so
 * they fail fast instead of blocking on a credential prompt.
 */
export async function restorePushedBranch(
  workspacePath: string,
  branch: string,
): Promise<boolean> {
  const noPrompt = { cwd: workspacePath, env: { GIT_TERMINAL_PROMPT: '0' } };
  const remoteCheck = await runProcess('git', ['remote', 'get-url', 'origin'], {
    cwd: workspacePath,
  });
  if (remoteCheck.exit_code !== 0) return false;
  // Probe the EXACT head ref. `ls-remote … <branch>` does suffix matching, so a
  // colliding ref like `refs/heads/archive/<branch>` would exit 0 (false positive)
  // for a `<branch>` that doesn't exist; the exact `fetch` below would then fail
  // and a first dispatch would unwind forever. `refs/heads/<branch>` matches only
  // the exact ref.
  const exists = await runProcess(
    'git',
    ['ls-remote', '--exit-code', 'origin', `refs/heads/${branch}`],
    noPrompt,
  );
  // exit 2 = reached the remote, no such ref → genuine first dispatch, cut fresh.
  if (exists.exit_code === 2) return false;
  // Any other non-zero (128, …) is a transport/auth failure — fail closed.
  if (exists.exit_code !== 0) {
    throw new WorkspaceError(
      'workspace_setup_origin_unreachable',
      `git ls-remote origin ${branch} failed (exit ${exists.exit_code}): ${(exists.stderr || exists.stdout).trim()}`,
    );
  }
  // Fetch the exact head ref (matching the probe): an unqualified `<branch>`
  // refspec would resolve a same-named tag (refs/tags/<branch>) into FETCH_HEAD
  // even with --no-tags, and checkout would then restore the tag's commit.
  const fetched = await runProcess('git', ['fetch', '--no-tags', 'origin', `refs/heads/${branch}`], noPrompt);
  if (fetched.exit_code !== 0) {
    throw new WorkspaceError(
      'workspace_setup_branch_fetch_failed',
      `git fetch origin ${branch} failed (exit ${fetched.exit_code}): ${(fetched.stderr || fetched.stdout).trim()}`,
    );
  }
  await runGitExpect(['checkout', '-b', branch, 'FETCH_HEAD'], workspacePath);
  return true;
}

/**
 * Per-dispatch fetch of the workspace's base ref. Runs `git fetch --no-tags
 * origin <base>` so `origin/<base>` is current in the workspace before the
 * dispatched agent runs `git rebase origin/<base>` as the first step of its
 * Todo flow (issue 101). The host runs this because the in-VM agent has no
 * network credentials; `gh auth setup-git` on the host makes the fetch work
 * with the canonical HTTPS `origin` symphony configures in PR mode.
 *
 * A fresh `origin/<base>` is a dispatch precondition: when an `origin` is
 * configured and the fetch fails (auth, network, missing ref), this returns
 * `ok: false` with a diagnostic and the caller must abort the attempt — not
 * launch the agent against a stale ref, which would reproduce the stale-base
 * behavior issue 101 eliminates.
 *
 * No-op (returns `ok: true, skipped: true`) when the workspace has no
 * `origin` remote — that's the local-only mode where there is no network
 * source for the base ref, and the source repo's local `<base>` is the
 * only truth.
 */
export async function fetchBaseInWorkspace(
  workspacePath: string,
  baseBranch: string,
): Promise<{ ok: boolean; skipped: boolean; diagnostic: string | null }> {
  const remoteCheck = await runProcess('git', ['remote', 'get-url', 'origin'], {
    cwd: workspacePath,
  });
  if (remoteCheck.exit_code !== 0) {
    return { ok: true, skipped: true, diagnostic: null };
  }
  const fetch = await runProcess(
    'git',
    ['fetch', '--no-tags', 'origin', baseBranch],
    { cwd: workspacePath },
  );
  if (fetch.exit_code !== 0) {
    return {
      ok: false,
      skipped: false,
      diagnostic: (fetch.stderr || fetch.stdout).trim(),
    };
  }
  return { ok: true, skipped: false, diagnostic: null };
}

/**
 * Inputs the WorkspaceManager passes to its `createWorkspace` action so the
 * canonical setup can run on first creation. Falls back to env-derived defaults
 * (SYMPHONY_*) when fields are omitted.
 */
export interface ResolveSetupOptionsArgs {
  identifier: string;
  workspacePath: string;
  workflowDir: string;
}

/**
 * Resolve the env-driven SetupWorkspaceDirOptions for an issue at dispatch
 * time. Centralized so the runner/manager and tests can share the same
 * mapping:
 *
 *   - SYMPHONY_SOURCE_REPO override else fall back to `workflowDir`
 *     (the directory containing WORKFLOW.md, which in the canonical
 *     project layout is the repo root).
 *   - SYMPHONY_BASE_BRANCH override else 'main'.
 *   - SYMPHONY_REPO selects PR mode (origin restored) vs local-only.
 */
export function resolveSetupOptions(args: ResolveSetupOptionsArgs): SetupWorkspaceDirOptions {
  const sourceRepo =
    process.env.SYMPHONY_SOURCE_REPO && process.env.SYMPHONY_SOURCE_REPO.length > 0
      ? process.env.SYMPHONY_SOURCE_REPO
      : args.workflowDir;
  const baseBranch =
    process.env.SYMPHONY_BASE_BRANCH && process.env.SYMPHONY_BASE_BRANCH.length > 0
      ? process.env.SYMPHONY_BASE_BRANCH
      : 'main';
  const originRepo =
    process.env.SYMPHONY_REPO && process.env.SYMPHONY_REPO.length > 0
      ? process.env.SYMPHONY_REPO
      : null;
  return {
    workspacePath: args.workspacePath,
    sourceRepo,
    baseBranch,
    branch: `agent/${args.identifier}`,
    originRepo,
    gitIdentity: { name: 'symphony-agent', email: 'agent@symphony.local' },
  };
}

// Resolve the workspace dir, creating it if missing. Returns true when this call
// performed the mkdir (so the caller can gate one-time setup like the canonical
// clone on first-mkdir). Rejects symlinks (containment risk) and non-directory
// entries.
async function ensureWorkspaceDirExists(wsPath: string): Promise<boolean> {
  try {
    // lstat (not stat) so a symlink at the workspace path is rejected: a symlink
    // could redirect the canonical setup and the returned cwd outside the workspace
    // root, which violates the §5.5 containment invariant.
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
    return false;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      await mkdir(wsPath, { recursive: true });
      return true;
    }
    throw err;
  }
}

// Best-effort removal of a partially prepared workspace dir so the next dispatch
// tick can retry cleanly. Errors are swallowed (cleanup is non-fatal).
async function unwindWorkspaceDir(wsPath: string): Promise<void> {
  try {
    await rm(wsPath, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup.
  }
}

// Run the canonical TypeScript clone+branch+remote setup on a freshly created
// workspace dir. On failure, unwinds the dir before rethrowing.
async function runCanonicalSetup(
  identifier: string,
  wsPath: string,
  workflowDir: string,
): Promise<void> {
  try {
    await setupWorkspaceDir(
      resolveSetupOptions({
        identifier,
        workspacePath: wsPath,
        workflowDir,
      }),
    );
  } catch (err) {
    await unwindWorkspaceDir(wsPath);
    throw err;
  }
}

export class WorkspaceManager {
  // Per-identifier in-flight promise map. Coalesces concurrent ensureFor
  // calls for the same identifier into a single setup pass so the dispatch
  // path (runner.ts) and the reconciler's create_workspace pass don't race
  // on `git clone --local` into the same dir. The promise is removed in a
  // finally block so the next pass (e.g. a re-dispatch after the workspace
  // was removed) re-enters cleanly. Keyed by sanitized workspace key for
  // identity with `workspacePathFor`.
  private ensureInFlight = new Map<string, Promise<Workspace>>();

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

  // Ensure the per-issue workspace directory exists. On first creation, runs
  // the canonical TypeScript `create_workspace` action (clone + branch +
  // optional origin/identity setup). The canonical clone+branch+remote work is
  // owned by `setupWorkspaceDir` and unit-tested independently; additional
  // per-VM tooling lives in the agent image, not in a workspace-setup shell.
  //
  // Concurrent callers for the same identifier (dispatch runner + reconciler
  // eager-create) coalesce via `ensureInFlight`: the second caller awaits
  // the first's result and observes `created_now: false` from the cached
  // workspace shape (since the first's promise already resolved with the
  // created-now=true outcome). Callers must NOT rely on `created_now`
  // distinguishing "I created it" from "someone else did, just before me";
  // the lock guarantees the canonical setup runs exactly once.
  async ensureFor(identifier: string): Promise<Workspace> {
    const key = sanitizeWorkspaceKey(identifier);
    const existing = this.ensureInFlight.get(key);
    if (existing) return existing;
    const p = this.doEnsureFor(identifier);
    this.ensureInFlight.set(key, p);
    try {
      return await p;
    } finally {
      this.ensureInFlight.delete(key);
    }
  }

  private async doEnsureFor(identifier: string): Promise<Workspace> {
    const workspaceRoot = this.cfg.workspace.root;
    await mkdir(workspaceRoot, { recursive: true });
    const wsPath = this.workspacePathFor(identifier);
    assertContained(workspaceRoot, wsPath);
    const createdNow = await ensureWorkspaceDirExists(wsPath);
    if (createdNow) {
      await runCanonicalSetup(identifier, wsPath, this.cfg.workflow_dir);
    }
    return {
      path: wsPath,
      workspace_key: sanitizeWorkspaceKey(identifier),
      created_now: createdNow,
    };
  }

  // Best-effort filesystem removal of the per-issue workspace dir. A symlink or
  // non-directory at the path is a no-op (containment safety).
  async remove(identifier: string): Promise<void> {
    const wsPath = this.workspacePathFor(identifier);
    assertContained(this.cfg.workspace.root, wsPath);
    try {
      const st = await lstat(wsPath);
      if (st.isSymbolicLink() || !st.isDirectory()) return;
    } catch {
      return;
    }
    await rm(wsPath, { recursive: true, force: true });
  }
}
