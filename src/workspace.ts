// Workspace manager (SPEC §5). Per-issue workspace dirs under workspace.root.
//
// Safety invariants enforced:
// 1. Workspace path is rooted at workspace.root (containment check).
// 2. Workspace key is sanitized — only [A-Za-z0-9._-] allowed.
// 3. Agent cwd MUST equal the workspace path (enforced by callers via runWithCwd).

import { mkdir, rm, lstat, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Workspace, HooksConfig, ServiceConfig } from './types.js';
import {
  runProcess,
  runHookScript as runHookScriptUtil,
  type RunResult,
} from './util/process.js';
import { sanitizeWorkspaceKey } from './util/workspace-key.js';
import type { HookCapture, HookResult } from './workspace-types.js';

// Re-exported so existing shell/entry importers (agent/runner.ts, tests) keep their
// `from '../workspace.js'` import path. The canonical definitions live in the
// foundation layer (util/workspace-key, workspace-types) so domain modules can
// import them directly without crossing the adapters↛inward boundary.
export { sanitizeWorkspaceKey };
export type { HookCapture, HookResult };

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
// semantics (§5.4). Optional `capture` streams output in real time (used by per-issue JSONL
// run logs) and reports the final result to the same callback. Optional `extraEnv` is
// merged on top of `process.env` so callers (e.g. the runner's after_run handoff) can
// stage hook-specific values without polluting the host process environment.
//
// Positional arity is preserved so callers (orchestrator, runner, tests) don't have to be
// touched; the body delegates to the unified `runHookScriptUtil` in `util/process.ts`.
export async function runHookScript(
  script: string,
  cwd: string,
  timeoutMs: number,
  capture?: HookCapture,
  extraEnv?: Record<string, string>,
): Promise<HookResult> {
  return runHookScriptUtil(script, {
    cwd,
    timeoutMs,
    env: extraEnv,
    capture,
    // The legacy hook wrapper did not append the spawn error message to
    // stderr (`child.on('error', () => { ... })` discarded `err`). Keep that
    // behavior so existing hook-failure diagnostics still read identically.
    appendErrorToStderr: false,
  });
}

// Inputs for the canonical per-issue clone+branch+remote setup (issue 34).
// Previously lived as the `hooks.after_create` shell in WORKFLOW.md; lifted
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
  // GitHub `owner/repo` when the operator wants the after_run hook to push
  // back. `null` leaves the workspace network-isolated (no origin remote).
  originRepo: string | null;
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
 * the old `hooks.after_create` shell did, but in TypeScript so:
 *
 *   1. The setup is unit-testable independent of a workflow-defined shell hook.
 *   2. The reconciler's `workspace` resource owns it as a typed `create_workspace`
 *      action instead of an opaque shell blob.
 *   3. State-machine behavior (origin restoration, identity pinning) stays on
 *      the orchestrator side of the runner/hook seam.
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
 *     from the Done hook can authenticate.
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
  const { workspacePath, sourceRepo, baseBranch, branch, originRepo, gitIdentity } = opts;
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
  //    the after_run hook to push" opt-in; without it the workspace stays
  //    purely local and no origin is configured. The remote URL is the
  //    canonical HTTPS form (no token); auth comes from the host's `gh`,
  //    which never enters the VM. Unlike the prior shell version, we do
  //    NOT fetch `origin/<base>` and reset — see the function comment for
  //    why; the source repo's local `<base>` is the canonical base ref.
  if (originRepo && originRepo.length > 0) {
    await runGitExpect(
      ['remote', 'add', 'origin', `https://github.com/${originRepo}.git`],
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

  // 6. Cut the per-issue branch off base. After this HEAD is `branch`, ready
  //    for the dispatched agent to commit against.
  await runGitExpect(['checkout', '-b', branch], workspacePath);
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
 * canonical setup can run before the optional repo-local `after_create` shell.
 * Falls back to env-derived defaults (SYMPHONY_*) when fields are omitted.
 */
export interface ResolveSetupOptionsArgs {
  identifier: string;
  workspacePath: string;
  workflowDir: string;
}

/**
 * Resolve the env-driven SetupWorkspaceDirOptions for an issue at dispatch
 * time. Centralized so the runner/manager and tests can share the same
 * mapping. Mirrors the shell heuristic the old after_create used:
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
  // optional origin/identity setup) BEFORE the optional repo-local
  // `after_create` shell. The shell is now a thin glue surface for workflow
  // authors who need to add additional setup — the canonical clone+branch+remote
  // work is owned by `setupWorkspaceDir` and unit-tested independently.
  //
  // `hooks` is resolved per the issue's current state by the caller (so a
  // state-level hooks override applies); pass the workflow-level hooks for
  // state-agnostic callers.
  //
  // Concurrent callers for the same identifier (dispatch runner + reconciler
  // eager-create) coalesce via `ensureInFlight`: the second caller awaits
  // the first's result and observes `created_now: false` from the cached
  // workspace shape (since the first's promise already resolved with the
  // created-now=true outcome). Callers must NOT rely on `created_now`
  // distinguishing "I created it" from "someone else did, just before me" —
  // the bool exists only to gate the `after_create` hook on first-mkdir,
  // and the lock guarantees it fires exactly once.
  async ensureFor(
    identifier: string,
    hooks: HooksConfig,
    captureAfterCreate?: HookCapture,
  ): Promise<Workspace> {
    const key = sanitizeWorkspaceKey(identifier);
    const existing = this.ensureInFlight.get(key);
    if (existing) return existing;
    const p = this.doEnsureFor(identifier, hooks, captureAfterCreate);
    this.ensureInFlight.set(key, p);
    try {
      return await p;
    } finally {
      this.ensureInFlight.delete(key);
    }
  }

  private async doEnsureFor(
    identifier: string,
    hooks: HooksConfig,
    captureAfterCreate?: HookCapture,
  ): Promise<Workspace> {
    const workspaceRoot = this.cfg.workspace.root;
    await mkdir(workspaceRoot, { recursive: true });
    const wsPath = this.workspacePathFor(identifier);
    assertContained(workspaceRoot, wsPath);

    let createdNow = false;
    try {
      // Use lstat so symlinks at the workspace path are rejected: a symlink could redirect
      // hook execution and the returned cwd outside the workspace root, which violates the
      // §5.5 containment invariant.
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

    if (createdNow) {
      // Canonical clone+branch+remote setup. Fatal failure unwinds the dir
      // so the next dispatch tick can retry cleanly.
      try {
        await setupWorkspaceDir(
          resolveSetupOptions({
            identifier,
            workspacePath: wsPath,
            workflowDir: this.cfg.workflow_dir,
          }),
        );
      } catch (err) {
        try {
          await rm(wsPath, { recursive: true, force: true });
        } catch {
          // Best-effort cleanup.
        }
        throw err;
      }
    }

    if (createdNow && hooks.after_create) {
      const res = await runHookScript(
        hooks.after_create,
        wsPath,
        hooks.timeout_ms,
        captureAfterCreate,
      );
      if (hookFailed(res)) {
        // §5.4: after_create failure is fatal — also unwind the partially prepared directory.
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

  // Run before_run; throw on failure/timeout (§5.4).
  async runBeforeRun(workspacePath: string, hooks: HooksConfig, capture?: HookCapture): Promise<void> {
    if (!hooks.before_run) return;
    const res = await runHookScript(hooks.before_run, workspacePath, hooks.timeout_ms, capture);
    if (hookFailed(res)) {
      throw new WorkspaceError('before_run_failed', `before_run hook ${hookFailureReason(res)}`);
    }
  }

  // Best-effort after_run hook (§5.4: failure logged and ignored — caller logs).
  // `extraEnv` is merged into the hook process env; callers use this to stage
  // values (e.g. SYMPHONY_PR_TITLE, SYMPHONY_PR_BODY_FILE) that the hook script
  // would otherwise have to extract by hand.
  async runAfterRunBestEffort(
    workspacePath: string,
    hooks: HooksConfig,
    capture?: HookCapture,
    extraEnv?: Record<string, string>,
  ): Promise<HookResult | null> {
    if (!hooks.after_run) return null;
    return runHookScript(hooks.after_run, workspacePath, hooks.timeout_ms, capture, extraEnv);
  }

  // Best-effort before_remove + filesystem removal (§5.4).
  async remove(
    identifier: string,
    hooks: HooksConfig,
    capture?: HookCapture,
  ): Promise<HookResult | null> {
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
      hookResult = await runHookScript(hooks.before_remove, wsPath, hooks.timeout_ms, capture);
    }
    await rm(wsPath, { recursive: true, force: true });
    return hookResult;
  }
}
