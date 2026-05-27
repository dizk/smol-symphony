// PR autopilot adapters (shell). Concrete `gh` shell-out implementation of
// the {@link PrApi} port declared in `./pr.ts`. Lifted out of `pr.ts` so the
// core resource module stays pure domain (issue 70) — `pr.ts` no longer
// imports `util/process` and is free of `Date.now()`-style non-determinism.
//
// pr.ts re-exports the port interface from this module's `import type` line
// only; this file does not import any non-type symbol from `./pr.ts`, so the
// `domain ← adapters` invariant holds at runtime.

import { runProcess } from '../util/process.js';
import type { PrApi, PrMergeable, PrState, PrSummary, PrView } from './pr.js';

interface ShellResult {
  exit: number;
  stdout: string;
  stderr: string;
}

// Thin shape adapter over the unified runProcess. `exit: -1` is the historical
// PR-autopilot sentinel for "spawn errored or process signalled"; map runProcess's
// `exit_code: null` into it so downstream gh-output parsing stays identical to
// the pre-refactor shape.
async function runShell(
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number } = {},
): Promise<ShellResult> {
  const r = await runProcess(cmd, args, {
    cwd: opts.cwd,
    timeoutMs: opts.timeoutMs,
    // PR autopilot's gh output can be large (json blobs); keep the historical
    // 1 MiB clamp rather than the 64 KiB default.
    maxBytes: 1_048_576,
  });
  return {
    exit: r.exit_code ?? -1,
    stdout: r.stdout,
    stderr: r.stderr,
  };
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
    return parseGhPrView(prNumber, res.stdout);
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

function parseGhPrView(prNumber: number, stdout: string): PrView {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(stdout) as Record<string, unknown>;
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
