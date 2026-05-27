// PR autopilot adapters (shell). Concrete `gh` + `git` shell-out implementations
// of the {@link PrApi} and {@link PrGitApi} ports declared in `./pr.ts`.
// Lifted out of `pr.ts` so the core resource module stays pure domain (issue 70)
// — `pr.ts` no longer imports `util/process` and is free of `Date.now()`-style
// non-determinism. Both classes keep their I/O tightly scoped (specific gh
// subcommands, specific git args) so the surface stays narrow and a future
// migration to GitHub's REST API or a different git library is a single-file
// change.
//
// pr.ts re-exports the port interfaces from this module's `import type` line
// only; this file does not import any non-type symbol from `./pr.ts`, so the
// `domain ← adapters` invariant holds at runtime.

import { runProcess } from '../util/process.js';
import type {
  PrApi,
  PrGitApi,
  PrMergeable,
  PrState,
  PrSummary,
  PrView,
  PushOutcome,
  RebaseOutcome,
} from './pr.js';

interface ShellResult {
  exit: number;
  stdout: string;
  stderr: string;
}

// Thin shape adapter over the unified runProcess. `exit: -1` is the historical
// PR-autopilot sentinel for "spawn errored or process signalled"; map runProcess's
// `exit_code: null` into it so downstream gh-output / git-stderr parsing stays
// identical to the pre-refactor shape.
async function runShell(
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number } = {},
): Promise<ShellResult> {
  const r = await runProcess(cmd, args, {
    cwd: opts.cwd,
    timeoutMs: opts.timeoutMs,
    // PR autopilot's git/gh output can be large (rebase trees, gh json blobs);
    // keep the historical 1 MiB clamp rather than the 64 KiB default.
    maxBytes: 1_048_576,
  });
  return {
    exit: r.exit_code ?? -1,
    stdout: r.stdout,
    stderr: r.stderr,
  };
}

/**
 * True iff a rebase is paused mid-flight in `workspacePath`. Git sets the
 * `REBASE_HEAD` ref while a rebase (either backend) is stopped on conflicts and
 * clears it on continue/abort, so `git rev-parse --verify --quiet REBASE_HEAD`
 * is a locale-independent probe. Done via the git port's shell-out rather than
 * stat()ing `.git/rebase-merge|rebase-apply`, keeping core free of direct fs
 * IO (FC/IS purity). Issue 55.
 */
async function rebaseInProgress(workspacePath: string, timeoutMs: number | undefined): Promise<boolean> {
  const r = await runShell(
    'git',
    ['rev-parse', '--verify', '--quiet', 'REBASE_HEAD'],
    { cwd: workspacePath, timeoutMs },
  );
  return r.exit === 0 && r.stdout.trim().length > 0;
}

/** Default production PrApi backed by the `gh` CLI on the host. */
export class GhCliPrApi implements PrApi {
  constructor(private readonly opts: { timeoutMs?: number; cwd?: string } = {}) {}

  async listForBranch(branch: string): Promise<PrSummary | null> {
    // `--state all` so a PR that has merged or been closed is still
    // returned — once we have the number we drive cleanup via `view`,
    // which works against any state. An OPEN-only filter would make a
    // post-merge or operator-closed PR invisible to the autopilot.
    const res = await runShell(
      'gh',
      ['pr', 'list', '--head', branch, '--state', 'all', '--json', 'number,url', '--limit', '1'],
      this.opts,
    );
    if (res.exit !== 0) {
      throw new Error(`gh pr list failed (exit ${res.exit}): ${res.stderr.trim()}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(res.stdout);
    } catch (err) {
      throw new Error(`gh pr list returned non-JSON: ${(err as Error).message}`);
    }
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    const first = parsed[0] as { number?: unknown; url?: unknown };
    if (typeof first.number !== 'number' || typeof first.url !== 'string') return null;
    return { number: first.number, url: first.url };
  }

  async view(prNumber: number): Promise<PrView> {
    const res = await runShell(
      'gh',
      [
        'pr',
        'view',
        String(prNumber),
        '--json',
        'number,url,state,mergeable,baseRefName,baseRefOid,headRefName,headRefOid,reviewDecision,autoMergeRequest',
      ],
      this.opts,
    );
    if (res.exit !== 0) {
      throw new Error(`gh pr view ${prNumber} failed (exit ${res.exit}): ${res.stderr.trim()}`);
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(res.stdout) as Record<string, unknown>;
    } catch (err) {
      throw new Error(`gh pr view returned non-JSON: ${(err as Error).message}`);
    }
    return {
      number: typeof parsed.number === 'number' ? parsed.number : prNumber,
      url: typeof parsed.url === 'string' ? parsed.url : '',
      state: normalizeState(parsed.state),
      mergeable: normalizeMergeable(parsed.mergeable),
      base_ref_name: typeof parsed.baseRefName === 'string' ? parsed.baseRefName : '',
      base_ref_oid: typeof parsed.baseRefOid === 'string' ? parsed.baseRefOid : null,
      head_ref_name: typeof parsed.headRefName === 'string' ? parsed.headRefName : '',
      head_ref_oid: typeof parsed.headRefOid === 'string' ? parsed.headRefOid : '',
      review_decision: normalizeReviewDecision(parsed.reviewDecision),
      auto_merge_armed:
        parsed.autoMergeRequest !== null &&
        parsed.autoMergeRequest !== undefined &&
        typeof parsed.autoMergeRequest === 'object',
    };
  }

  async armAutoMerge(prNumber: number, strategy: 'squash' | 'merge' | 'rebase'): Promise<void> {
    const flag =
      strategy === 'merge' ? '--merge' : strategy === 'rebase' ? '--rebase' : '--squash';
    const res = await runShell(
      'gh',
      ['pr', 'merge', String(prNumber), '--auto', flag, '--delete-branch'],
      this.opts,
    );
    if (res.exit !== 0) {
      throw new Error(`gh pr merge --auto failed (exit ${res.exit}): ${res.stderr.trim()}`);
    }
  }

  async closePr(prNumber: number): Promise<void> {
    const res = await runShell('gh', ['pr', 'close', String(prNumber)], this.opts);
    if (res.exit !== 0) {
      throw new Error(`gh pr close failed (exit ${res.exit}): ${res.stderr.trim()}`);
    }
  }

  async deleteRemoteBranch(branch: string): Promise<void> {
    // `gh api -X DELETE` is the most direct path; falls back to `git push :branch`
    // via shell would require knowing the remote URL. gh is required by the
    // existing PR-create hook anyway so we can rely on it being present.
    const res = await runShell(
      'gh',
      ['api', '-X', 'DELETE', `repos/{owner}/{repo}/git/refs/heads/${branch}`],
      this.opts,
    );
    if (res.exit !== 0) {
      // 422 / 404 from gh api is "branch already gone" — surface as a soft
      // error so the resource records it but doesn't keep retrying.
      throw new Error(`gh api delete branch failed (exit ${res.exit}): ${res.stderr.trim()}`);
    }
  }
}

function normalizeState(raw: unknown): PrState {
  if (raw === 'OPEN' || raw === 'CLOSED' || raw === 'MERGED') return raw;
  return 'OPEN';
}
function normalizeMergeable(raw: unknown): PrMergeable {
  if (raw === 'MERGEABLE' || raw === 'CONFLICTING' || raw === 'UNKNOWN') return raw;
  return 'UNKNOWN';
}
function normalizeReviewDecision(raw: unknown): PrView['review_decision'] {
  if (raw === 'APPROVED' || raw === 'CHANGES_REQUESTED' || raw === 'REVIEW_REQUIRED') return raw;
  return null;
}

/** Default production PrGitApi backed by `git` shelled out in the workspace. */
export class GitCliPrGitApi implements PrGitApi {
  constructor(private readonly opts: { timeoutMs?: number; remote?: string } = {}) {}

  private get remote(): string {
    return this.opts.remote ?? 'origin';
  }

  async rebaseOnto(args: {
    workspacePath: string;
    branch: string;
    baseBranch: string;
    expectedHeadSha: string;
  }): Promise<RebaseOutcome> {
    // 1. Read the workspace's local HEAD up front.
    const head = await runShell(
      'git',
      ['rev-parse', 'HEAD'],
      { cwd: args.workspacePath, timeoutMs: this.opts.timeoutMs },
    );
    if (head.exit !== 0) {
      return { kind: 'error', diagnostic: `rev-parse HEAD failed: ${head.stderr.trim()}` };
    }
    const localHead = head.stdout.trim();
    // 2. If a rebase is already in progress (markers on disk in
    //    `.git/rebase-merge` / `.git/rebase-apply`), the agent we routed
    //    the conflict to is still resolving it. Bail without touching the
    //    workspace — finishing or aborting the rebase here would clobber
    //    exactly the state the agent is working on. Issue 55.
    if (await rebaseInProgress(args.workspacePath, this.opts.timeoutMs)) {
      return { kind: 'concurrent_push', observed_head_sha: localHead };
    }
    // 3. Fetch the base ref so origin/<base> is current.
    const fetch = await runShell(
      'git',
      ['fetch', '--no-tags', this.remote, args.baseBranch],
      { cwd: args.workspacePath, timeoutMs: this.opts.timeoutMs },
    );
    if (fetch.exit !== 0) {
      return { kind: 'error', diagnostic: `git fetch failed: ${fetch.stderr.trim()}` };
    }
    // 4. If local HEAD has diverged from the SHA we last saw on the PR,
    //    either an agent finished resolving a rebase in-tree (and the
    //    workspace is now on top of `origin/<base>`) or some unrelated
    //    local mutation happened. Distinguish via ancestry:
    //
    //      - `origin/<base>` is an ancestor of localHead → agent rebased.
    //        Return ok so the caller force-with-leases the resolved branch.
    //        Issue 55 — without this the conflict-routed agent could resolve
    //        but the autopilot would forever return concurrent_push and the
    //        PR would never flip CONFLICTING → MERGEABLE.
    //      - Otherwise → unexpected local divergence. Return concurrent_push
    //        so the autopilot defers rather than clobbering work it can't
    //        explain.
    if (localHead !== args.expectedHeadSha) {
      const isAncestor = await runShell(
        'git',
        ['merge-base', '--is-ancestor', `${this.remote}/${args.baseBranch}`, localHead],
        { cwd: args.workspacePath, timeoutMs: this.opts.timeoutMs },
      );
      if (isAncestor.exit === 0) {
        return { kind: 'ok', new_head_sha: localHead };
      }
      return { kind: 'concurrent_push', observed_head_sha: localHead };
    }
    // 5. localHead === expectedHeadSha; run the rebase normally.
    const rebase = await runShell(
      'git',
      ['rebase', `${this.remote}/${args.baseBranch}`],
      { cwd: args.workspacePath, timeoutMs: this.opts.timeoutMs },
    );
    if (rebase.exit !== 0) {
      // Collect the conflicted files for the notes block.
      const conflicts = await runShell(
        'git',
        ['diff', '--name-only', '--diff-filter=U'],
        { cwd: args.workspacePath, timeoutMs: this.opts.timeoutMs },
      );
      const files = conflicts.stdout
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      // Leave the rebase IN PROGRESS — the agent picking up the conflict-routed
      // issue inherits the working tree with conflict markers in place and the
      // .git/rebase-* state on disk, so they can resolve in-tree and
      // `git rebase --continue` rather than starting over. Running
      // `git rebase --abort` here would discard exactly the state the routed
      // agent is supposed to resolve.
      return {
        kind: 'conflict',
        files,
        diagnostic: `${rebase.stdout.trim()}\n${rebase.stderr.trim()}`.trim(),
      };
    }
    // 6. New HEAD after rebase.
    const newHead = await runShell('git', ['rev-parse', 'HEAD'], {
      cwd: args.workspacePath,
      timeoutMs: this.opts.timeoutMs,
    });
    if (newHead.exit !== 0) {
      return { kind: 'error', diagnostic: `post-rebase rev-parse failed: ${newHead.stderr.trim()}` };
    }
    return { kind: 'ok', new_head_sha: newHead.stdout.trim() };
  }

  async pushForceWithLease(args: {
    workspacePath: string;
    branch: string;
    expectedHeadSha: string;
  }): Promise<PushOutcome> {
    const res = await runShell(
      'git',
      [
        'push',
        '--force-with-lease=' + args.branch + ':' + args.expectedHeadSha,
        this.remote,
        args.branch,
      ],
      { cwd: args.workspacePath, timeoutMs: this.opts.timeoutMs },
    );
    if (res.exit === 0) return { kind: 'ok' };
    // git's force-with-lease reports "stale info" / "rejected" on a lease
    // mismatch; treat anything containing those substrings as a concurrent-push.
    const blob = `${res.stdout}\n${res.stderr}`;
    if (/stale info|rejected|non-fast-forward/i.test(blob)) {
      return { kind: 'concurrent_push', diagnostic: blob.trim() };
    }
    return { kind: 'error', diagnostic: blob.trim() };
  }
}
