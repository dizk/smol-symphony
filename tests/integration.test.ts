import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  performIntegrationMerge,
  resolveIntegrationRemote,
  routeIntegrationFailureToConflict,
  shouldMergeForState,
} from '../src/agent/integration.js';
import { LocalMarkdownTracker } from '../src/trackers/local.js';
import type { RunningEntry, Issue } from '../src/types.js';

// End-to-end fixtures for the shared-integration-branch flow (issue 19).
//
// The merge code is pure git plumbing in the host process, so the cheapest
// test substrate is `git init --bare` for the "source" repo plus a plain
// clone for the workspace. Both live under tmpdir; no smolvm, no network.

function git(args: string[], cwd: string, env?: Record<string, string>): { code: number | null; stdout: string; stderr: string } {
  const res = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...(env ?? {}) },
  });
  return { code: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

function gitOrThrow(args: string[], cwd: string, env?: Record<string, string>): string {
  const res = git(args, cwd, env);
  if (res.code !== 0) {
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${res.stderr || res.stdout}`);
  }
  return res.stdout;
}

const COMMIT_ENV = {
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

/**
 * Build a fresh source repo (bare) with `main` as the only branch and one
 * commit on it (we need the ref to be reachable before we can clone). Returns
 * the absolute path to the bare repo.
 */
async function makeSourceRepo(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'symphony-int-src-'));
  const bare = path.join(root, 'source.git');
  gitOrThrow(['init', '--bare', '--initial-branch=main', bare], root);
  // We need a commit on main; do it via a temp working clone.
  const seedClone = path.join(root, 'seed-clone');
  gitOrThrow(['clone', bare, seedClone], root);
  await writeFile(path.join(seedClone, 'README.md'), '# seed\n', 'utf8');
  gitOrThrow(['add', '.'], seedClone, COMMIT_ENV);
  gitOrThrow(['commit', '-m', 'seed'], seedClone, COMMIT_ENV);
  // Make sure we're pushing main even if the default branch differs locally.
  gitOrThrow(['branch', '-M', 'main'], seedClone);
  gitOrThrow(['push', 'origin', 'main'], seedClone);
  return bare;
}

/**
 * Mint a workspace cloned from `source` on `agent/<id>`, with a single
 * commit on the agent branch. Matches the shape the after_create hook would
 * leave behind (minus the integration branch handling, which we exercise
 * separately).
 */
async function makeWorkspace(source: string, identifier: string, commitText = 'agent change'): Promise<string> {
  const ws = await mkdtemp(path.join(os.tmpdir(), `symphony-int-ws-${identifier}-`));
  gitOrThrow(['clone', '--no-tags', '--branch', 'main', source, '.'], ws);
  // Strip the origin remote so the merge code's local-mode path has to add its
  // own — that's what the after_create hook does for local mode.
  gitOrThrow(['remote', 'remove', 'origin'], ws);
  gitOrThrow(['config', 'user.name', 'agent'], ws);
  gitOrThrow(['config', 'user.email', 'agent@example.com'], ws);
  gitOrThrow(['checkout', '-b', `agent/${identifier}`], ws);
  await writeFile(path.join(ws, `${identifier}.txt`), commitText + '\n', 'utf8');
  gitOrThrow(['add', '.'], ws, COMMIT_ENV);
  gitOrThrow(['commit', '-m', `work for ${identifier}`], ws, COMMIT_ENV);
  return ws;
}

function makeEntry(identifier: string, state: string, trackerRoot: string | null = null): RunningEntry {
  const issue: Issue = {
    id: identifier,
    identifier,
    title: 'test issue',
    description: null,
    priority: null,
    state,
    branch_name: null,
    url: null,
    labels: [],
    blocked_by: [],
    created_at: null,
    updated_at: null,
  };
  return {
    issue_id: identifier,
    identifier,
    issue,
    session_id: null,
    thread_id: null,
    turn_id: null,
    adapter_pid: null,
    last_event: null,
    last_event_at: null,
    last_message: null,
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    last_reported_input_tokens: 0,
    last_reported_output_tokens: 0,
    last_reported_total_tokens: 0,
    turn_count: 0,
    retry_attempt: null,
    started_at: new Date().toISOString(),
    workspace_path: '/tmp/workspace',
    cancel: () => undefined,
    recent_events: [],
    last_error: null,
    cleanup_workspace_on_exit: true,
    mcp_token: null,
    tracker_root_at_dispatch: trackerRoot,
    resolved_actor: 'claude/test',
    transitioned: true,
    steering_requested: false,
    steering_question: null,
    steering_context: null,
  };
}

describe('shouldMergeForState', () => {
  it('matches case-insensitively', () => {
    assert.equal(shouldMergeForState('Done', ['Done']), true);
    assert.equal(shouldMergeForState('done', ['Done']), true);
    assert.equal(shouldMergeForState('DONE', ['done']), true);
  });

  it('returns false for non-listed states', () => {
    assert.equal(shouldMergeForState('Cancelled', ['Done']), false);
    assert.equal(shouldMergeForState('Done', []), false);
  });
});

describe('resolveIntegrationRemote', () => {
  it('returns origin when SYMPHONY_REPO is set', () => {
    const prior = process.env.SYMPHONY_REPO;
    process.env.SYMPHONY_REPO = 'owner/repo';
    try {
      assert.deepEqual(resolveIntegrationRemote('/some/workspace'), { kind: 'origin' });
    } finally {
      if (prior === undefined) delete process.env.SYMPHONY_REPO;
      else process.env.SYMPHONY_REPO = prior;
    }
  });

  it('returns local with SYMPHONY_SOURCE_REPO when SYMPHONY_REPO is unset', () => {
    const priorRepo = process.env.SYMPHONY_REPO;
    const priorSrc = process.env.SYMPHONY_SOURCE_REPO;
    delete process.env.SYMPHONY_REPO;
    process.env.SYMPHONY_SOURCE_REPO = '/explicit/source';
    try {
      assert.deepEqual(resolveIntegrationRemote('/some/workspace'), {
        kind: 'local',
        sourceRepo: '/explicit/source',
      });
    } finally {
      if (priorRepo === undefined) delete process.env.SYMPHONY_REPO;
      else process.env.SYMPHONY_REPO = priorRepo;
      if (priorSrc === undefined) delete process.env.SYMPHONY_SOURCE_REPO;
      else process.env.SYMPHONY_SOURCE_REPO = priorSrc;
    }
  });

  it('falls back to ${workspace}/../../.. when neither env var is set', () => {
    const priorRepo = process.env.SYMPHONY_REPO;
    const priorSrc = process.env.SYMPHONY_SOURCE_REPO;
    delete process.env.SYMPHONY_REPO;
    delete process.env.SYMPHONY_SOURCE_REPO;
    try {
      const ws = '/tmp/project/.symphony/workspaces/42';
      assert.deepEqual(resolveIntegrationRemote(ws), {
        kind: 'local',
        sourceRepo: '/tmp/project',
      });
    } finally {
      if (priorRepo !== undefined) process.env.SYMPHONY_REPO = priorRepo;
      if (priorSrc !== undefined) process.env.SYMPHONY_SOURCE_REPO = priorSrc;
    }
  });
});

describe('performIntegrationMerge (local mode)', () => {
  it('first-run seed: creates integration from base when remote has none, then pushes', async () => {
    const source = await makeSourceRepo();
    const ws = await makeWorkspace(source, '1');
    try {
      // Sanity check: source has no integration ref yet.
      const refsBefore = git(['show-ref', '--verify', '--quiet', 'refs/heads/integration'], source);
      assert.notEqual(refsBefore.code, 0);

      const result = await performIntegrationMerge({
        workspacePath: ws,
        identifier: '1',
        integrationBranch: 'integration',
        baseBranch: 'main',
        remote: { kind: 'local', sourceRepo: source },
        timeoutMs: 30_000,
      });
      assert.equal(result.ok, true, JSON.stringify(result));

      // Source now has integration pointing at a merge commit.
      const refsAfter = git(['show-ref', 'refs/heads/integration'], source);
      assert.equal(refsAfter.code, 0);
      const log = gitOrThrow(['log', '--oneline', 'integration'], source);
      // Two commits: the seed, plus the merge commit. --no-ff guarantees the merge commit.
      assert.match(log, /Merge agent\/1 into integration/);

      // Temp remote was cleaned up.
      const remotes = gitOrThrow(['remote'], ws).trim();
      assert.equal(remotes, '');

      // Workspace HEAD is back on the agent branch so the after_run hook sees a
      // predictable HEAD.
      const head = gitOrThrow(['rev-parse', '--abbrev-ref', 'HEAD'], ws).trim();
      assert.equal(head, 'agent/1');
    } finally {
      await rm(path.dirname(source), { recursive: true, force: true });
      await rm(ws, { recursive: true, force: true });
    }
  });

  it('normal merge: integration already exists on remote, merges agent branch and pushes', async () => {
    const source = await makeSourceRepo();
    const ws1 = await makeWorkspace(source, '1', 'first change touching a.txt');
    let ws2: string | null = null;
    try {
      // First run lands a merge on integration.
      const r1 = await performIntegrationMerge({
        workspacePath: ws1,
        identifier: '1',
        integrationBranch: 'integration',
        baseBranch: 'main',
        remote: { kind: 'local', sourceRepo: source },
        timeoutMs: 30_000,
      });
      assert.equal(r1.ok, true);

      // Second issue branches from main (NOT the new integration) and lands its own
      // change on a disjoint path — should merge cleanly.
      ws2 = await makeWorkspace(source, '2', 'second change touching b.txt');
      // Replace the agent's file so its commit touches b.txt instead of overwriting 2.txt.
      await rm(path.join(ws2, '2.txt'), { force: true });
      await writeFile(path.join(ws2, 'b.txt'), 'second change\n', 'utf8');
      gitOrThrow(['add', '.'], ws2, COMMIT_ENV);
      gitOrThrow(['commit', '--amend', '-m', 'work for 2'], ws2, COMMIT_ENV);

      const r2 = await performIntegrationMerge({
        workspacePath: ws2,
        identifier: '2',
        integrationBranch: 'integration',
        baseBranch: 'main',
        remote: { kind: 'local', sourceRepo: source },
        timeoutMs: 30_000,
      });
      assert.equal(r2.ok, true, JSON.stringify(r2));

      // Integration now contains BOTH merges.
      const log = gitOrThrow(['log', '--oneline', 'integration'], source);
      assert.match(log, /Merge agent\/1 into integration/);
      assert.match(log, /Merge agent\/2 into integration/);
    } finally {
      await rm(path.dirname(source), { recursive: true, force: true });
      await rm(ws1, { recursive: true, force: true });
      if (ws2) await rm(ws2, { recursive: true, force: true });
    }
  });

  it('conflict: returns conflict result and leaves workspace clean (on agent branch)', async () => {
    const source = await makeSourceRepo();
    const ws1 = await makeWorkspace(source, '1', 'one wins');
    let ws2: string | null = null;
    try {
      // First agent's change: README.md gets one body.
      await writeFile(path.join(ws1, 'README.md'), '# seed\n\none body\n', 'utf8');
      gitOrThrow(['add', '.'], ws1, COMMIT_ENV);
      gitOrThrow(['commit', '--amend', '-m', 'work for 1'], ws1, COMMIT_ENV);
      const r1 = await performIntegrationMerge({
        workspacePath: ws1,
        identifier: '1',
        integrationBranch: 'integration',
        baseBranch: 'main',
        remote: { kind: 'local', sourceRepo: source },
        timeoutMs: 30_000,
      });
      assert.equal(r1.ok, true);

      // Second agent's change to the same README.md content. Branching from main
      // (not integration), so when we try to merge into integration it conflicts
      // on that line.
      ws2 = await makeWorkspace(source, '2', 'two also wins');
      await writeFile(path.join(ws2, 'README.md'), '# seed\n\ntwo body\n', 'utf8');
      gitOrThrow(['add', '.'], ws2, COMMIT_ENV);
      gitOrThrow(['commit', '--amend', '-m', 'work for 2'], ws2, COMMIT_ENV);

      const r2 = await performIntegrationMerge({
        workspacePath: ws2,
        identifier: '2',
        integrationBranch: 'integration',
        baseBranch: 'main',
        remote: { kind: 'local', sourceRepo: source },
        timeoutMs: 30_000,
      });
      assert.equal(r2.ok, false);
      assert.equal(r2.ok === false && r2.reason, 'conflict');

      // Workspace should be back on agent/2 with no merge in progress.
      const head = gitOrThrow(['rev-parse', '--abbrev-ref', 'HEAD'], ws2).trim();
      assert.equal(head, 'agent/2');
      // No MERGE_HEAD file → merge was aborted cleanly.
      const mergeHead = git(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], ws2);
      assert.notEqual(mergeHead.code, 0);
      // Temp remote was cleaned up.
      const remotes = gitOrThrow(['remote'], ws2).trim();
      assert.equal(remotes, '');
    } finally {
      await rm(path.dirname(source), { recursive: true, force: true });
      await rm(ws1, { recursive: true, force: true });
      if (ws2) await rm(ws2, { recursive: true, force: true });
    }
  });

  it('push refusal: integration moved on remote since our fetch, returns push_refused', async () => {
    // Simulate: two workspaces. First one merges. Second one fetches before the
    // first pushes (in a way) — we approximate by manually moving integration on
    // the source repo to a different SHA between the second workspace's merge and
    // its push.
    //
    // The simpler reproduction: pre-stage integration on the source with a commit
    // that ISN'T on the workspace's fetch view. We craft this by making the
    // workspace skip the post-merge push, then advance integration on source, then
    // attempt push.
    //
    // Even simpler: configure the source bare to reject non-ff pushes (which is
    // the default for `receive.denyNonFastForwards` in a shared scenario, but bare
    // repos default to allow). The way `performIntegrationMerge` does it, after a
    // successful merge it just pushes — and since the merge commit IS a fast-forward
    // descendant of integration (we reset to remote/integration before merging),
    // push always succeeds in single-actor scenarios.
    //
    // To force a push refusal, we set `receive.denyCurrentBranch=refuse` on a
    // non-bare source. We can't easily do that with our --bare source. Instead,
    // we use a non-bare source repo and run the merge against it.
    const root = await mkdtemp(path.join(os.tmpdir(), 'symphony-int-pushref-'));
    const source = path.join(root, 'source');
    try {
      gitOrThrow(['init', '--initial-branch=main', source], root);
      gitOrThrow(['config', 'user.name', 'test'], source, COMMIT_ENV);
      gitOrThrow(['config', 'user.email', 'test@example.com'], source, COMMIT_ENV);
      await writeFile(path.join(source, 'README.md'), '# seed\n', 'utf8');
      gitOrThrow(['add', '.'], source, COMMIT_ENV);
      gitOrThrow(['commit', '-m', 'seed'], source, COMMIT_ENV);
      // Seed integration locally on source.
      gitOrThrow(['branch', 'integration', 'main'], source);
      // Block push to integration in source: receive.denyCurrentBranch only fires for the
      // checked-out branch, so check integration out and refuse non-ff. simpler: refuse all.
      gitOrThrow(['checkout', 'integration'], source);
      gitOrThrow(['config', 'receive.denyCurrentBranch', 'refuse'], source);

      const ws = await makeWorkspace(source, '7');
      const result = await performIntegrationMerge({
        workspacePath: ws,
        identifier: '7',
        integrationBranch: 'integration',
        baseBranch: 'main',
        remote: { kind: 'local', sourceRepo: source },
        timeoutMs: 30_000,
      });
      assert.equal(result.ok, false);
      assert.equal(result.ok === false && result.reason, 'push_refused');

      // The merge succeeded locally — workspace's local integration HAS the merge
      // commit on it. Verify that, so an operator can `git fetch` it back later.
      const log = gitOrThrow(['log', '--oneline', 'integration'], ws);
      assert.match(log, /Merge agent\/7 into integration/);

      // Workspace HEAD is back on agent/7.
      const head = gitOrThrow(['rev-parse', '--abbrev-ref', 'HEAD'], ws).trim();
      assert.equal(head, 'agent/7');

      await rm(ws, { recursive: true, force: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('routeIntegrationFailureToConflict', () => {
  async function setupTracker(): Promise<{
    root: string;
    tracker: LocalMarkdownTracker;
    cleanup: () => Promise<void>;
  }> {
    const root = await mkdtemp(path.join(os.tmpdir(), 'symphony-int-tracker-'));
    const tracker = new LocalMarkdownTracker({
      kind: 'local',
      states: {
        Todo: { role: 'active' },
        Done: { role: 'terminal' },
        Cancelled: { role: 'terminal' },
        Triage: { role: 'holding' },
        Conflict: { role: 'holding' },
      },
      root,
    });
    await tracker.start();
    return { root, tracker, cleanup: () => rm(root, { recursive: true, force: true }) };
  }

  it('moves the file from Done to Conflict, appends diagnostic notes, clears cleanup flag', async () => {
    const { root, tracker, cleanup } = await setupTracker();
    try {
      // Stage an issue file in Done (simulating the post-transition state right
      // before the integration merge fired).
      await writeFile(
        path.join(root, 'Done', '7.md'),
        '---\nid: "7"\nidentifier: "7"\ntitle: "Demo"\n---\nOriginal body.\n',
        'utf8',
      );
      const entry = makeEntry('7', 'Done', root);
      entry.cleanup_workspace_on_exit = true;
      await routeIntegrationFailureToConflict(tracker, entry, 'Conflict', {
        ok: false,
        reason: 'conflict',
        integrationBranch: 'integration',
        remote: 'local',
        diagnostic: 'CONFLICT (content): Merge conflict in README.md',
      });
      // File is now in Conflict, gone from Done.
      assert.deepEqual(await readdir(path.join(root, 'Done')), []);
      assert.deepEqual(await readdir(path.join(root, 'Conflict')), ['7.md']);
      // Notes were appended with the reason and diagnostic.
      const body = await readFile(path.join(root, 'Conflict', '7.md'), 'utf8');
      assert.match(body, /integration merge failed \(conflict\)/);
      assert.match(body, /CONFLICT \(content\): Merge conflict in README\.md/);
      assert.match(body, /## claude\/test — \S+ — Done → Conflict/);
      // Entry state mutated; cleanup flag cleared.
      assert.equal(entry.cleanup_workspace_on_exit, false);
      assert.equal(entry.issue.state, 'Conflict');
    } finally {
      await cleanup();
    }
  });

  it('on push_refused, still routes to Conflict with the appropriate reason label', async () => {
    const { root, tracker, cleanup } = await setupTracker();
    try {
      await writeFile(
        path.join(root, 'Done', '8.md'),
        '---\nid: "8"\nidentifier: "8"\ntitle: "Demo"\n---\nbody\n',
        'utf8',
      );
      const entry = makeEntry('8', 'Done', root);
      entry.cleanup_workspace_on_exit = true;
      await routeIntegrationFailureToConflict(tracker, entry, 'Conflict', {
        ok: false,
        reason: 'push_refused',
        integrationBranch: 'integration',
        remote: 'origin',
        diagnostic: '! [rejected] integration -> integration (non-fast-forward)',
      });
      const body = await readFile(path.join(root, 'Conflict', '8.md'), 'utf8');
      assert.match(body, /integration merge failed \(push_refused\)/);
      assert.match(body, /non-fast-forward/);
      assert.equal(entry.cleanup_workspace_on_exit, false);
      assert.equal(entry.issue.state, 'Conflict');
    } finally {
      await cleanup();
    }
  });

  it('clears cleanup_workspace_on_exit even if the tracker move throws (so the workspace survives for manual recovery)', async () => {
    const fakeTracker = {
      fetchCandidateIssues: async () => ({ issues: [], root: null }),
      fetchIssuesByStates: async () => [],
      fetchIssueStatesByIds: async () => [],
      moveIssueToState: async () => {
        throw new Error('synthetic move failure');
      },
    };
    const entry = makeEntry('9', 'Done', null);
    entry.cleanup_workspace_on_exit = true;
    await routeIntegrationFailureToConflict(fakeTracker, entry, 'Conflict', {
      ok: false,
      reason: 'conflict',
      integrationBranch: 'integration',
      remote: 'origin',
      diagnostic: 'whatever',
    });
    assert.equal(entry.cleanup_workspace_on_exit, false);
    // State NOT updated because the move failed.
    assert.equal(entry.issue.state, 'Done');
  });

  it('handles trackers that do not implement moveIssueToState by clearing cleanup flag only', async () => {
    const readOnlyTracker = {
      fetchCandidateIssues: async () => ({ issues: [], root: null }),
      fetchIssuesByStates: async () => [],
      fetchIssueStatesByIds: async () => [],
    };
    const entry = makeEntry('10', 'Done', null);
    entry.cleanup_workspace_on_exit = true;
    await routeIntegrationFailureToConflict(readOnlyTracker, entry, 'Conflict', {
      ok: false,
      reason: 'conflict',
      integrationBranch: 'integration',
      remote: 'origin',
      diagnostic: 'whatever',
    });
    assert.equal(entry.cleanup_workspace_on_exit, false);
    assert.equal(entry.issue.state, 'Done');
  });
});
