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
    return parseGhPrView(prNumber, parsed);
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
function pickString(raw: unknown, fallback: string): string {
  return typeof raw === 'string' ? raw : fallback;
}
function pickStringOrNull(raw: unknown): string | null {
  return typeof raw === 'string' ? raw : null;
}
function parseGhPrView(prNumber: number, parsed: Record<string, unknown>): PrView {
  return {
    number: typeof parsed.number === 'number' ? parsed.number : prNumber,
    url: pickString(parsed.url, ''),
    state: normalizeState(parsed.state),
    mergeable: normalizeMergeable(parsed.mergeable),
    base_ref_name: pickString(parsed.baseRefName, ''),
    base_ref_oid: pickStringOrNull(parsed.baseRefOid),
    head_ref_name: pickString(parsed.headRefName, ''),
    head_ref_oid: pickString(parsed.headRefOid, ''),
    review_decision: normalizeReviewDecision(parsed.reviewDecision),
    auto_merge_armed:
      parsed.autoMergeRequest !== null &&
      parsed.autoMergeRequest !== undefined &&
      typeof parsed.autoMergeRequest === 'object',
  };
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
    const head = await this.readHead(args.workspacePath);
    if (head.kind === 'error') return head;
    // A rebase already in progress means the conflict-routed agent is still
    // resolving it; finishing or aborting here would clobber that work. Bail
    // without touching the workspace. Issue 55.
    if (await rebaseInProgress(args.workspacePath, this.opts.timeoutMs)) {
      return { kind: 'concurrent_push', observed_head_sha: head.sha };
    }
    const fetchErr = await this.fetchBase(args.workspacePath, args.baseBranch);
    if (fetchErr) return fetchErr;
    if (head.sha !== args.expectedHeadSha) {
      return this.classifyLocalDivergence(args.workspacePath, args.baseBranch, head.sha);
    }
    return this.runRebase(args.workspacePath, args.baseBranch);
  }

  private async readHead(
    workspacePath: string,
  ): Promise<{ kind: 'ok'; sha: string } | (RebaseOutcome & { kind: 'error' })> {
    const head = await runShell('git', ['rev-parse', 'HEAD'], {
      cwd: workspacePath,
      timeoutMs: this.opts.timeoutMs,
    });
    if (head.exit !== 0) {
      return { kind: 'error', diagnostic: `rev-parse HEAD failed: ${head.stderr.trim()}` };
    }
    return { kind: 'ok', sha: head.stdout.trim() };
  }

  private async fetchBase(
    workspacePath: string,
    baseBranch: string,
  ): Promise<(RebaseOutcome & { kind: 'error' }) | null> {
    const fetch = await runShell('git', ['fetch', '--no-tags', this.remote, baseBranch], {
      cwd: workspacePath,
      timeoutMs: this.opts.timeoutMs,
    });
    if (fetch.exit !== 0) {
      return { kind: 'error', diagnostic: `git fetch failed: ${fetch.stderr.trim()}` };
    }
    return null;
  }

  // localHead has diverged from the SHA the autopilot last saw on the PR.
  // Distinguish via ancestry: if origin/<base> is an ancestor of localHead the
  // conflict-routed agent already rebased — return ok so the caller pushes the
  // resolved branch. Otherwise treat as unexpected local mutation and defer.
  // Issue 55.
  private async classifyLocalDivergence(
    workspacePath: string,
    baseBranch: string,
    localHead: string,
  ): Promise<RebaseOutcome> {
    const isAncestor = await runShell(
      'git',
      ['merge-base', '--is-ancestor', `${this.remote}/${baseBranch}`, localHead],
      { cwd: workspacePath, timeoutMs: this.opts.timeoutMs },
    );
    if (isAncestor.exit === 0) {
      return { kind: 'ok', new_head_sha: localHead };
    }
    return { kind: 'concurrent_push', observed_head_sha: localHead };
  }

  private async runRebase(workspacePath: string, baseBranch: string): Promise<RebaseOutcome> {
    const rebase = await runShell('git', ['rebase', `${this.remote}/${baseBranch}`], {
      cwd: workspacePath,
      timeoutMs: this.opts.timeoutMs,
    });
    if (rebase.exit !== 0) {
      return this.collectRebaseConflict(workspacePath, rebase);
    }
    const newHead = await runShell('git', ['rev-parse', 'HEAD'], {
      cwd: workspacePath,
      timeoutMs: this.opts.timeoutMs,
    });
    if (newHead.exit !== 0) {
      return { kind: 'error', diagnostic: `post-rebase rev-parse failed: ${newHead.stderr.trim()}` };
    }
    return { kind: 'ok', new_head_sha: newHead.stdout.trim() };
  }

  // Leave the rebase IN PROGRESS — the conflict-routed agent inherits the
  // working tree with conflict markers and .git/rebase-* state, so they can
  // resolve in-tree and `git rebase --continue` rather than starting over.
  // Running `git rebase --abort` here would discard exactly the state the
  // routed agent is supposed to resolve.
  private async collectRebaseConflict(
    workspacePath: string,
    rebase: ShellResult,
  ): Promise<RebaseOutcome> {
    const conflicts = await runShell('git', ['diff', '--name-only', '--diff-filter=U'], {
      cwd: workspacePath,
      timeoutMs: this.opts.timeoutMs,
    });
    const files = conflicts.stdout
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    return {
      kind: 'conflict',
      files,
      diagnostic: `${rebase.stdout.trim()}\n${rebase.stderr.trim()}`.trim(),
    };
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
