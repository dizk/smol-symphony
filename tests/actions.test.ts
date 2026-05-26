// Tests for the typed-action DAG (issue 36).
//
// Coverage matches the issue AC:
//   (a) each action kind's happy path (push_branch / create_pr_if_missing /
//       ensure_branch / checkout / merge / delete_branch / run_in_vm /
//       propose_followup).
//   (b) retry-on-error policy.
//   (c) run_in_vm cache hit / miss.
//   (d) `actions:` + `hooks:` deprecation detection at the workflow layer.
//   (e) merge's `on_conflict: { route_to: ... }` routing.
//
// We exercise git through real on-disk repos (mirroring tests/workspace-setup
// style) and gh / npm / other binaries by stubbing them on PATH with a tiny
// shell shim — keeps the test independent of whether `gh` exists on the host.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile, chmod, readFile, readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {
  hostRunInVm,
  parseActionsBlock,
  renderTemplate,
  runActions,
  TemplateError,
  type ActionContext,
  type PredicateEnv,
  type RunInVmExecutor,
  type WorkflowAction,
} from '../src/actions/index.js';
import {
  computeCacheHash,
  invalidateRunInVmByName,
  makeRunInVmCacheStore,
} from '../src/actions/cache.js';
import { findHooksAndActionsConflicts, buildServiceConfig } from '../src/workflow.js';

// ----- Helpers ---------------------------------------------------------------

interface RunResult {
  exit: number;
  stdout: string;
  stderr: string;
}

function run(
  cmd: string,
  args: string[],
  cwd: string,
  env?: Record<string, string>,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: env ? { ...process.env, ...env } : process.env,
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (b) => {
      stdout += b.toString('utf8');
    });
    child.stderr?.on('data', (b) => {
      stderr += b.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ exit: code ?? -1, stdout, stderr }));
  });
}

async function git(args: string[], cwd: string): Promise<string> {
  const r = await run('git', args, cwd);
  if (r.exit !== 0) {
    throw new Error(`git ${args.join(' ')} in ${cwd} exited ${r.exit}: ${r.stderr}`);
  }
  return r.stdout.trim();
}

async function makeBareRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'symphony-bare-'));
  await git(['init', '--bare', '-b', 'main'], dir);
  return dir;
}

async function makeSourceRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'symphony-src-'));
  await git(['init', '-b', 'main'], dir);
  await git(['config', 'user.name', 'test'], dir);
  await git(['config', 'user.email', 'test@example.com'], dir);
  await writeFile(path.join(dir, 'README.md'), '# repo\n', 'utf8');
  await git(['add', '.'], dir);
  await git(['commit', '-m', 'initial'], dir);
  return dir;
}

/**
 * Build a workspace clone of a source repo with an agent/<id> branch cut.
 * Mirrors the dispatch-time workspace shape (cloned from source on `main`).
 * Returns `{ wsParent, ws }` so the caller can `rm -rf wsParent` without
 * accidentally clobbering /tmp (the workspace itself sits one level deep
 * inside a freshly-mkdtemp'd parent, so the parent is always safe to nuke).
 */
async function makeWorkspace(
  source: string,
  identifier: string,
  opts: { remote?: { name: string; url: string } } = {},
): Promise<{ wsParent: string; ws: string }> {
  const wsParent = await mkdtemp(path.join(os.tmpdir(), 'symphony-ws-'));
  const ws = path.join(wsParent, 'workspace');
  await git(['clone', '--branch', 'main', source, ws], wsParent);
  await git(['remote', 'remove', 'origin'], ws).catch(() => undefined);
  await git(['config', 'user.name', 'symphony-agent'], ws);
  await git(['config', 'user.email', 'agent@symphony.local'], ws);
  await git(['checkout', '-b', `agent/${identifier}`], ws);
  if (opts.remote) {
    await git(['remote', 'add', opts.remote.name, opts.remote.url], ws);
  }
  return { wsParent, ws };
}

function baseContext(workspace: string, identifier: string): ActionContext {
  return {
    identifier,
    workspace,
    branch: `agent/${identifier}`,
    base_branch: 'main',
    issue_title: 'Some title',
    issue_body: 'Some body',
    repo: 'org/repo',
    pr_title: `${identifier}: Some title`,
    pr_body_file: path.join(workspace, '.body.md'),
  };
}

/**
 * Stage a fake binary on PATH that records every invocation under `logDir`
 * and exits with `script`'s status. The script is the literal sh -c body;
 * use `exit 0` for happy path. Returns the directory to prepend to PATH.
 */
async function stageFakeBin(name: string, script: string): Promise<{ dir: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), `symphony-fakebin-${name}-`));
  const binPath = path.join(dir, name);
  await writeFile(binPath, `#!/bin/sh\n${script}\n`, 'utf8');
  await chmod(binPath, 0o755);
  return { dir };
}

async function withPath<T>(prepend: string, fn: () => Promise<T>): Promise<T> {
  const prior = process.env.PATH;
  process.env.PATH = `${prepend}:${prior ?? ''}`;
  try {
    return await fn();
  } finally {
    process.env.PATH = prior;
  }
}

// ----- Templating + predicates -----------------------------------------------

describe('renderTemplate', () => {
  it('expands known $var references', () => {
    const ctx = baseContext('/ws', '42');
    assert.equal(renderTemplate('push $branch to $base_branch', ctx), 'push agent/42 to main');
  });

  it('throws on unknown variables (no silent "" expansion)', () => {
    const ctx = baseContext('/ws', '42');
    assert.throws(() => renderTemplate('$SYMPHONY_NOPE', ctx), TemplateError);
  });

  it('preserves \\$name as a literal $name (escape)', () => {
    const ctx = baseContext('/ws', '42');
    // \$branch is a literal "$branch" in the output; the unescaped $branch
    // a few tokens later expands as usual.
    assert.equal(renderTemplate('see \\$branch but expand $branch', ctx), 'see $branch but expand agent/42');
  });
});

// ----- Parser ---------------------------------------------------------------

describe('parseActionsBlock', () => {
  it('parses a closed-set actions list', () => {
    const out = parseActionsBlock('Done', [
      { kind: 'push_branch', remote: 'origin', ref: '$branch' },
      {
        kind: 'create_pr_if_missing',
        base: '$base_branch',
        head: '$branch',
        title_from: '$pr_title',
        body_from: '$pr_body_file',
        if: '$repo',
      },
    ]);
    assert.equal(out?.length, 2);
    assert.equal(out![0]!.kind, 'push_branch');
    assert.equal(out![1]!.kind, 'create_pr_if_missing');
  });

  it('rejects unknown action kinds at parse time', () => {
    assert.throws(() =>
      parseActionsBlock('Done', [{ kind: 'invent_pr', base: 'x', head: 'y' }]),
    );
  });

  it('requires run_in_vm.name (used by cache + rerun CLI)', () => {
    assert.throws(() =>
      parseActionsBlock('Review', [{ kind: 'run_in_vm', cmd: ['true'] }]),
    );
  });

  it('parses merge.on_conflict as either "abort" or {route_to}', () => {
    const out = parseActionsBlock('Done', [
      {
        kind: 'merge',
        source: 'agent/42',
        target: 'integration',
        on_conflict: { route_to: 'Conflict' },
      },
      {
        kind: 'merge',
        source: 'agent/42',
        target: 'integration',
        on_conflict: 'abort',
      },
    ]);
    assert.equal((out![0] as { on_conflict: unknown }).on_conflict instanceof Object, true);
    assert.equal((out![1] as { on_conflict: string }).on_conflict, 'abort');
  });
});

// ----- Happy paths -----------------------------------------------------------

describe('action: push_branch happy path', () => {
  it('git pushes the branch and reports ok', async () => {
    const source = await makeSourceRepo();
    const bare = await makeBareRepo();
    const { wsParent, ws } = await makeWorkspace(source, '42', { remote: { name: 'origin', url: bare } });
    try {
      await writeFile(path.join(ws, 'note.md'), 'work\n', 'utf8');
      await git(['add', '.'], ws);
      await git(['commit', '-m', 'wip'], ws);

      const ctx = baseContext(ws, '42');
      const result = await runActions(
        [{ kind: 'push_branch', remote: 'origin', ref: '$branch' }],
        { workspacePath: ws, ctx, snapshotId: 'actions:Done' },
      );
      assert.equal(result.ok, true);
      // Bare repo should now have the branch.
      const branches = await git(['branch', '--list'], bare);
      assert.match(branches, /agent\/42/);
      assert.equal(result.actions.length, 1);
      assert.equal(result.actions[0]!.state, 'done');
    } finally {
      await rm(source, { recursive: true, force: true });
      await rm(bare, { recursive: true, force: true });
      await rm(wsParent, { recursive: true, force: true });
    }
  });
});

describe('action: create_pr_if_missing happy path', () => {
  it('skips create when `gh pr view` reports an existing PR', async () => {
    const source = await makeSourceRepo();
    const { wsParent, ws } = await makeWorkspace(source, '42');
    // Stub gh to make `pr view` succeed (PR exists); `pr create` would fail
    // the assertion below if invoked.
    const fake = await stageFakeBin(
      'gh',
      [
        '# capture invocation',
        `echo "$@" >> "${path.join(ws, '.gh-calls.log')}"`,
        'case "$1" in',
        '  pr)',
        '    case "$2" in',
        '      view) echo "PR exists"; exit 0 ;;',
        '      create) echo "should not be called" >&2; exit 99 ;;',
        '    esac ;;',
        'esac',
        'exit 1',
      ].join('\n'),
    );
    try {
      const ctx = baseContext(ws, '42');
      await writeFile(ctx.pr_body_file, 'body content', 'utf8');
      const result = await withPath(fake.dir, () =>
        runActions(
          [
            {
              kind: 'create_pr_if_missing',
              base: '$base_branch',
              head: '$branch',
              title_from: '$pr_title',
              body_from: '$pr_body_file',
            },
          ],
          { workspacePath: ws, ctx, snapshotId: 'actions:Done' },
        ),
      );
      assert.equal(result.ok, true);
      const log = await readFile(path.join(ws, '.gh-calls.log'), 'utf8');
      assert.match(log, /pr view/);
      assert.doesNotMatch(log, /pr create/);
    } finally {
      await rm(source, { recursive: true, force: true });
      await rm(wsParent, { recursive: true, force: true });
      await rm(fake.dir, { recursive: true, force: true });
    }
  });

  it('creates a PR when `gh pr view` returns non-zero', async () => {
    const source = await makeSourceRepo();
    const { wsParent, ws } = await makeWorkspace(source, '42');
    const fake = await stageFakeBin(
      'gh',
      [
        `echo "$@" >> "${path.join(ws, '.gh-calls.log')}"`,
        'case "$1" in',
        '  pr)',
        '    case "$2" in',
        '      view) exit 1 ;;',
        '      create) echo "https://github.com/x/y/pull/1"; exit 0 ;;',
        '    esac ;;',
        'esac',
        'exit 1',
      ].join('\n'),
    );
    try {
      const ctx = baseContext(ws, '42');
      await writeFile(ctx.pr_body_file, 'body content', 'utf8');
      const result = await withPath(fake.dir, () =>
        runActions(
          [
            {
              kind: 'create_pr_if_missing',
              base: '$base_branch',
              head: '$branch',
              title_from: '$pr_title',
              body_from: '$pr_body_file',
            },
          ],
          { workspacePath: ws, ctx, snapshotId: 'actions:Done' },
        ),
      );
      assert.equal(result.ok, true);
      const log = await readFile(path.join(ws, '.gh-calls.log'), 'utf8');
      assert.match(log, /pr view/);
      assert.match(log, /pr create/);
    } finally {
      await rm(source, { recursive: true, force: true });
      await rm(wsParent, { recursive: true, force: true });
      await rm(fake.dir, { recursive: true, force: true });
    }
  });
});

describe('action: ensure_branch / checkout / delete_branch happy paths', () => {
  it('ensure_branch creates a branch if absent, no-op if present', async () => {
    const source = await makeSourceRepo();
    const { wsParent, ws } = await makeWorkspace(source, '42');
    try {
      const ctx = baseContext(ws, '42');
      // First call creates `feature/x`.
      const r1 = await runActions(
        [{ kind: 'ensure_branch', name: 'feature/x' }],
        { workspacePath: ws, ctx, snapshotId: 'actions:Done' },
      );
      assert.equal(r1.ok, true);
      const r2 = await runActions(
        [{ kind: 'ensure_branch', name: 'feature/x' }],
        { workspacePath: ws, ctx, snapshotId: 'actions:Done' },
      );
      assert.equal(r2.ok, true);
      const branches = await git(['branch', '--list'], ws);
      assert.match(branches, /feature\/x/);
    } finally {
      await rm(source, { recursive: true, force: true });
      await rm(wsParent, { recursive: true, force: true });
    }
  });

  it('checkout switches refs', async () => {
    const source = await makeSourceRepo();
    const { wsParent, ws } = await makeWorkspace(source, '42');
    try {
      await git(['branch', 'feature/y'], ws);
      const ctx = baseContext(ws, '42');
      const r = await runActions(
        [{ kind: 'checkout', ref: 'feature/y' }],
        { workspacePath: ws, ctx, snapshotId: 'actions:Done' },
      );
      assert.equal(r.ok, true);
      const head = await git(['rev-parse', '--abbrev-ref', 'HEAD'], ws);
      assert.equal(head, 'feature/y');
    } finally {
      await rm(source, { recursive: true, force: true });
      await rm(wsParent, { recursive: true, force: true });
    }
  });

  it('delete_branch (local) removes a local branch', async () => {
    const source = await makeSourceRepo();
    const { wsParent, ws } = await makeWorkspace(source, '42');
    try {
      await git(['branch', 'doomed'], ws);
      const ctx = baseContext(ws, '42');
      const r = await runActions(
        [{ kind: 'delete_branch', name: 'doomed', scope: 'local' }],
        { workspacePath: ws, ctx, snapshotId: 'actions:Done' },
      );
      assert.equal(r.ok, true);
      const branches = await git(['branch', '--list'], ws);
      assert.doesNotMatch(branches, /doomed/);
    } finally {
      await rm(source, { recursive: true, force: true });
      await rm(wsParent, { recursive: true, force: true });
    }
  });
});

// ----- merge: on_conflict route_to ------------------------------------------

describe('action: merge on_conflict route_to', () => {
  it('routes to the configured state on conflict and leaves the working tree clean', async () => {
    const source = await makeSourceRepo();
    const { wsParent, ws } = await makeWorkspace(source, '42');
    try {
      // Diverge: on `agent/42` write file with one content; on `integration`
      // (cut from main) write the same file with conflicting content.
      await writeFile(path.join(ws, 'conflict.md'), 'agent-content\n', 'utf8');
      await git(['add', '.'], ws);
      await git(['commit', '-m', 'agent edit'], ws);
      await git(['checkout', '-b', 'integration', 'main'], ws);
      await writeFile(path.join(ws, 'conflict.md'), 'integration-content\n', 'utf8');
      await git(['add', '.'], ws);
      await git(['commit', '-m', 'integration edit'], ws);
      // Back to agent so the executor's `checkout target` is a real switch.
      await git(['checkout', 'agent/42'], ws);

      const ctx = baseContext(ws, '42');
      const action: WorkflowAction = {
        kind: 'merge',
        source: 'agent/42',
        target: 'integration',
        on_conflict: { route_to: 'Conflict' },
      };
      const r = await runActions([action], { workspacePath: ws, ctx, snapshotId: 'actions:Done' });
      assert.equal(r.ok, false);
      assert.equal(r.route_to, 'Conflict');
      // Working tree should be clean (merge --abort fired).
      const status = await git(['status', '--porcelain'], ws);
      assert.equal(status, '');
    } finally {
      await rm(source, { recursive: true, force: true });
      await rm(wsParent, { recursive: true, force: true });
    }
  });
});

// ----- run_in_vm cache hit/miss ---------------------------------------------

describe('action: run_in_vm cache hit/miss', () => {
  it('caches successful results and skips re-execution', async () => {
    const source = await makeSourceRepo();
    const { wsParent, ws } = await makeWorkspace(source, '42');
    const cacheRoot = await mkdtemp(path.join(os.tmpdir(), 'symphony-cache-'));
    // Counter file lives OUTSIDE the workspace so its growth doesn't bump
    // the workspace-tree hash and break the cache-hit expectation. The
    // workspace-tree hash now reflects live workspace contents
    // (tracked + modified + untracked-not-gitignored) — see the regression
    // tests below — so any per-test side-effect needs an out-of-workspace
    // sentinel to survive across calls.
    const counterDir = await mkdtemp(path.join(os.tmpdir(), 'symphony-counter-'));
    const counterPath = path.join(counterDir, 'runs');
    try {
      const ctx = baseContext(ws, '42');
      const action: WorkflowAction = {
        kind: 'run_in_vm',
        name: 'count',
        cmd: ['sh', '-c', `echo run >> "${counterPath}"; exit 0`],
      };
      const cache = makeRunInVmCacheStore(cacheRoot);
      const r1 = await runActions([action], {
        workspacePath: ws,
        ctx,
        snapshotId: 'actions:Review',
        runInVmCache: cache,
        runInVm: hostRunInVm,
      });
      assert.equal(r1.ok, true);
      const r2 = await runActions([action], {
        workspacePath: ws,
        ctx,
        snapshotId: 'actions:Review',
        runInVmCache: cache,
        runInVm: hostRunInVm,
      });
      assert.equal(r2.ok, true);
      const log = await readFile(counterPath, 'utf8');
      assert.equal(log.trim().split('\n').length, 1, 'second run should be a cache hit');
      // Cache invalidation: re-run after invalidating should re-execute.
      await invalidateRunInVmByName(action as import('../src/actions/index.js').RunInVmAction, cacheRoot);
      const r3 = await runActions([action], {
        workspacePath: ws,
        ctx,
        snapshotId: 'actions:Review',
        runInVmCache: cache,
        runInVm: hostRunInVm,
      });
      assert.equal(r3.ok, true);
      const log2 = await readFile(counterPath, 'utf8');
      assert.equal(log2.trim().split('\n').length, 2, 'post-invalidate run should re-execute');
    } finally {
      await rm(source, { recursive: true, force: true });
      await rm(wsParent, { recursive: true, force: true });
      await rm(cacheRoot, { recursive: true, force: true });
      await rm(counterDir, { recursive: true, force: true });
    }
  });

  it('cache key changes when cmd changes', async () => {
    const ws = await mkdtemp(path.join(os.tmpdir(), 'symphony-nogit-ws-'));
    try {
      const h1 = await computeCacheHash({ workspacePath: ws, cmd: ['echo', 'a'], env: {} });
      const h2 = await computeCacheHash({ workspacePath: ws, cmd: ['echo', 'b'], env: {} });
      assert.notEqual(h1, h2);
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });

  // Reviewer's first finding (round 2): the cache key was based on
  // `git rev-parse HEAD^{tree}`, which only sees committed state. A
  // cached `npm test` could therefore be reused after the agent edited
  // files without committing, or after an untracked source file landed —
  // exactly the silent-skip the issue's "CI against the user's project"
  // framing rules out. The fix hashes live workspace contents (tracked +
  // modified + untracked-not-gitignored); these two regression tests pin
  // that behavior.
  it('cache miss when an uncommitted tracked-file edit lands', async () => {
    const source = await makeSourceRepo();
    const { wsParent, ws } = await makeWorkspace(source, '42');
    const cacheRoot = await mkdtemp(path.join(os.tmpdir(), 'symphony-cache-'));
    const counterDir = await mkdtemp(path.join(os.tmpdir(), 'symphony-counter-'));
    const counterPath = path.join(counterDir, 'runs');
    try {
      const ctx = baseContext(ws, '42');
      const action: WorkflowAction = {
        kind: 'run_in_vm',
        name: 'count-edit',
        cmd: ['sh', '-c', `echo run >> "${counterPath}"; exit 0`],
      };
      const cache = makeRunInVmCacheStore(cacheRoot);
      await runActions([action], {
        workspacePath: ws,
        ctx,
        snapshotId: 'actions:Review',
        runInVmCache: cache,
        runInVm: hostRunInVm,
      });
      // Edit README.md (tracked) without committing. The OLD HEAD-tree hash
      // would not change; the NEW live-tree hash must.
      await writeFile(path.join(ws, 'README.md'), '# edited (uncommitted)\n', 'utf8');
      await runActions([action], {
        workspacePath: ws,
        ctx,
        snapshotId: 'actions:Review',
        runInVmCache: cache,
        runInVm: hostRunInVm,
      });
      const lines = (await readFile(counterPath, 'utf8')).trim().split('\n').length;
      assert.equal(
        lines,
        2,
        'uncommitted edit to a tracked file must invalidate the run_in_vm cache',
      );
    } finally {
      await rm(source, { recursive: true, force: true });
      await rm(wsParent, { recursive: true, force: true });
      await rm(cacheRoot, { recursive: true, force: true });
      await rm(counterDir, { recursive: true, force: true });
    }
  });

  it('cache miss when an untracked source file is added', async () => {
    const source = await makeSourceRepo();
    const { wsParent, ws } = await makeWorkspace(source, '42');
    const cacheRoot = await mkdtemp(path.join(os.tmpdir(), 'symphony-cache-'));
    const counterDir = await mkdtemp(path.join(os.tmpdir(), 'symphony-counter-'));
    const counterPath = path.join(counterDir, 'runs');
    try {
      const ctx = baseContext(ws, '42');
      const action: WorkflowAction = {
        kind: 'run_in_vm',
        name: 'count-untracked',
        cmd: ['sh', '-c', `echo run >> "${counterPath}"; exit 0`],
      };
      const cache = makeRunInVmCacheStore(cacheRoot);
      await runActions([action], {
        workspacePath: ws,
        ctx,
        snapshotId: 'actions:Review',
        runInVmCache: cache,
        runInVm: hostRunInVm,
      });
      // Drop a brand-new untracked file (not in .gitignore — source
      // repo's only tracked file is README.md and it ships no gitignore).
      // The OLD HEAD-tree hash would not change; the NEW live-tree hash
      // includes untracked-not-gitignored paths, so this must invalidate.
      await writeFile(path.join(ws, 'new-source.ts'), 'export {};\n', 'utf8');
      await runActions([action], {
        workspacePath: ws,
        ctx,
        snapshotId: 'actions:Review',
        runInVmCache: cache,
        runInVm: hostRunInVm,
      });
      const lines = (await readFile(counterPath, 'utf8')).trim().split('\n').length;
      assert.equal(
        lines,
        2,
        'new untracked source file must invalidate the run_in_vm cache',
      );
    } finally {
      await rm(source, { recursive: true, force: true });
      await rm(wsParent, { recursive: true, force: true });
      await rm(cacheRoot, { recursive: true, force: true });
      await rm(counterDir, { recursive: true, force: true });
    }
  });
});

// ----- propose_followup happy path ------------------------------------------

describe('action: propose_followup happy path', () => {
  it('routes to the supplied sink and surfaces the proposed identifier', async () => {
    const source = await makeSourceRepo();
    const { wsParent, ws } = await makeWorkspace(source, '42');
    const seen: Array<unknown> = [];
    try {
      const ctx = baseContext(ws, '42');
      const r = await runActions(
        [
          {
            kind: 'propose_followup',
            title: 'follow-up from $identifier',
            body: 'context',
            labels: ['triage'],
          },
        ],
        {
          workspacePath: ws,
          ctx,
          snapshotId: 'actions:Done',
          followupSink: {
            proposeFollowup: async (input) => {
              seen.push(input);
              return { identifier: 'F-1' };
            },
          },
        },
      );
      assert.equal(r.ok, true);
      assert.deepEqual(seen[0], {
        title: 'follow-up from 42',
        description: 'context',
        labels: ['triage'],
        parent_identifier: '42',
      });
    } finally {
      await rm(source, { recursive: true, force: true });
      await rm(wsParent, { recursive: true, force: true });
    }
  });
});

// ----- Retry policy ---------------------------------------------------------

describe('action retry-on-error policy', () => {
  it('retries transient failures up to count and then aborts (default policy via small count)', async () => {
    const source = await makeSourceRepo();
    const { wsParent, ws } = await makeWorkspace(source, '42');
    try {
      const ctx = baseContext(ws, '42');
      const counterPath = path.join(ws, '.retries');
      const action: WorkflowAction = {
        kind: 'run_in_vm',
        name: 'flaky',
        cmd: ['sh', '-c', `echo r >> "${counterPath}"; exit 1`],
        on_error: { retry: { count: 2, backoff_ms: 1 } },
      };
      const cacheRoot = await mkdtemp(path.join(os.tmpdir(), 'symphony-cache-'));
      try {
        const r = await runActions([action], {
          workspacePath: ws,
          ctx,
          snapshotId: 'actions:Review',
          runInVmCache: makeRunInVmCacheStore(cacheRoot),
          runInVm: hostRunInVm,
        });
        assert.equal(r.ok, false);
        // Initial attempt + 2 retries = 3 invocations BEFORE the cache writes
        // the failing result on the last try; subsequent calls would cache-hit.
        const lines = (await readFile(counterPath, 'utf8')).trim().split('\n');
        assert.equal(lines.length, 3);
      } finally {
        await rm(cacheRoot, { recursive: true, force: true });
      }
    } finally {
      await rm(source, { recursive: true, force: true });
      await rm(wsParent, { recursive: true, force: true });
    }
  });
});

// ----- Conditional `if:` predicates -----------------------------------------

describe('action `if:` predicate', () => {
  it('skips when env-var predicate expands to empty', async () => {
    const source = await makeSourceRepo();
    const { wsParent, ws } = await makeWorkspace(source, '42');
    try {
      const ctx: ActionContext = { ...baseContext(ws, '42'), repo: null };
      // No remote configured; if the action ran, `git push` would fail.
      const r = await runActions(
        [{ kind: 'push_branch', remote: 'origin', ref: '$branch', if: '$repo' }],
        { workspacePath: ws, ctx, snapshotId: 'actions:Done' },
      );
      assert.equal(r.ok, true);
    } finally {
      await rm(source, { recursive: true, force: true });
      await rm(wsParent, { recursive: true, force: true });
    }
  });

  it('routes branch_exists / file_present through the injected PredicateEnv', async () => {
    const ctx = baseContext('/ws', '42');
    const seen: string[] = [];
    const stub: PredicateEnv = {
      async branchExists(ref) { seen.push(`b:${ref}`); return false; },
      async pathExists(abs) { seen.push(`p:${abs}`); return false; },
    };
    // Both predicates evaluate to false → action skipped (no IO, no failure).
    const r = await runActions(
      [
        { kind: 'checkout', ref: '$branch', if: { branch_exists: '$branch' } },
        { kind: 'checkout', ref: 'main', if: { file_present: 'no.md' } },
      ],
      { workspacePath: '/ws', ctx, snapshotId: 'actions:T', predicateEnv: stub },
    );
    assert.deepEqual(seen, ['b:agent/42', 'p:/ws/no.md']);
    assert.equal(r.ok, true);
    assert.equal(r.actions[0]!.state, 'done');
    assert.equal(r.actions[1]!.state, 'done');
  });
});

// ----- Deprecation detection ------------------------------------------------

describe('hooks ∧ actions deprecation', () => {
  it('findHooksAndActionsConflicts flags a state declaring both', () => {
    const cfg = buildServiceConfig(
      {
        tracker: { kind: 'local', root: '/tmp/issues' },
        states: {
          Todo: { role: 'active' },
          Done: {
            role: 'terminal',
            hooks: { after_run: 'echo legacy' },
            actions: [{ kind: 'push_branch', remote: 'origin', ref: 'main' }],
          },
          Triage: { role: 'holding' },
        },
      },
      '/tmp/WORKFLOW.md',
    );
    const conflicts = findHooksAndActionsConflicts(cfg);
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0]!.state, 'Done');
    assert.deepEqual(conflicts[0]!.hook_fields, ['after_run']);
  });

  it('does not flag states with only one of the two declared', () => {
    const cfg = buildServiceConfig(
      {
        tracker: { kind: 'local', root: '/tmp/issues' },
        states: {
          Todo: { role: 'active' },
          Done: {
            role: 'terminal',
            actions: [{ kind: 'push_branch', remote: 'origin', ref: 'main' }],
          },
          Triage: { role: 'holding' },
        },
      },
      '/tmp/WORKFLOW.md',
    );
    assert.equal(findHooksAndActionsConflicts(cfg).length, 0);
  });
});

// ----- Smoke: confirm the cache lives under actions/run_in_vm/<name>/<hash>/ -

describe('run_in_vm cache layout', () => {
  it('writes to <cacheRoot>/actions/run_in_vm/<name>/<hash>/result.json', async () => {
    const source = await makeSourceRepo();
    const { wsParent, ws } = await makeWorkspace(source, '42');
    const cacheRoot = await mkdtemp(path.join(os.tmpdir(), 'symphony-cache-'));
    try {
      const ctx = baseContext(ws, '42');
      await runActions(
        [{ kind: 'run_in_vm', name: 'noop', cmd: ['true'] }],
        {
          workspacePath: ws,
          ctx,
          snapshotId: 'actions:Review',
          runInVmCache: makeRunInVmCacheStore(cacheRoot),
          runInVm: hostRunInVm,
        },
      );
      // Layout: <cacheRoot>/actions/run_in_vm/<name>/<hash>/result.json.
      // The `<name>/` directory is the namespace `symphony rerun
      // --check=<name>` drops to invalidate every hash entry without
      // needing to know the per-issue workspace.
      const kindDir = path.join(cacheRoot, 'actions', 'run_in_vm');
      const names = await readdir(kindDir);
      assert.deepEqual(names, ['noop']);
      const hashes = await readdir(path.join(kindDir, 'noop'));
      assert.equal(hashes.length, 1, 'one hash entry under the name namespace');
      const files = await readdir(path.join(kindDir, 'noop', hashes[0]!));
      assert.deepEqual(files.sort(), ['result.json']);
    } finally {
      await rm(source, { recursive: true, force: true });
      await rm(wsParent, { recursive: true, force: true });
      await rm(cacheRoot, { recursive: true, force: true });
    }
  });
});

// ----- rerun --check parity: name-namespaced invalidation -------------------

// Reviewer's second finding (round 2): `symphony rerun --check=<name>`
// computed the cache hash against the workflow's source repo, but
// execution computes it against the per-issue workspace (often the
// agent/<id> branch with the agent's edits). Those hashes diverge as soon
// as the agent commits anything, so the CLI's rm-by-hash missed the entry
// execution actually wrote and the next dispatch happily cache-hit.
//
// The fix is layout: cache is keyed by `<name>/<hash>` on disk, and
// invalidation drops the whole `<name>/` directory. This test pins the
// fix from the CLI's perspective — invalidateRunInVmByName takes no
// workspace path and still removes the entry written by a divergent
// per-issue workspace.

describe('invalidateRunInVmByName (rerun CLI shape)', () => {
  it('drops entries written by execution even when the per-issue workspace has diverged', async () => {
    const source = await makeSourceRepo();
    const { wsParent, ws } = await makeWorkspace(source, '42');
    const cacheRoot = await mkdtemp(path.join(os.tmpdir(), 'symphony-cache-'));
    const counterDir = await mkdtemp(path.join(os.tmpdir(), 'symphony-counter-'));
    const counterPath = path.join(counterDir, 'runs');
    try {
      // Diverge the per-issue workspace from the source repo: commit an
      // agent-side edit so the workspace tree (and therefore the
      // execution-time cache hash) differs from anything the CLI could
      // compute against the source repo.
      await writeFile(path.join(ws, 'agent-edit.md'), 'agent work\n', 'utf8');
      await git(['add', '.'], ws);
      await git(['commit', '-m', 'agent edit'], ws);

      const ctx = baseContext(ws, '42');
      const action: import('../src/actions/index.js').RunInVmAction = {
        kind: 'run_in_vm',
        name: 'integration-build',
        cmd: ['sh', '-c', `echo run >> "${counterPath}"; exit 0`],
      };
      const cache = makeRunInVmCacheStore(cacheRoot);
      await runActions([action], {
        workspacePath: ws,
        ctx,
        snapshotId: 'actions:Review',
        runInVmCache: cache,
        runInVm: hostRunInVm,
      });
      // Sanity: a second run inside the same divergent workspace cache-hits.
      await runActions([action], {
        workspacePath: ws,
        ctx,
        snapshotId: 'actions:Review',
        runInVmCache: cache,
        runInVm: hostRunInVm,
      });
      assert.equal(
        (await readFile(counterPath, 'utf8')).trim().split('\n').length,
        1,
        'second run cache-hits before invalidation',
      );
      // Invalidate by name — note: no workspace argument. This is the
      // contract the rerun CLI relies on; previously the CLI needed to
      // probe the source repo's workspace hash, which mismatched the
      // per-issue execution hash and silently missed the entry.
      await invalidateRunInVmByName(action, cacheRoot);
      await runActions([action], {
        workspacePath: ws,
        ctx,
        snapshotId: 'actions:Review',
        runInVmCache: cache,
        runInVm: hostRunInVm,
      });
      assert.equal(
        (await readFile(counterPath, 'utf8')).trim().split('\n').length,
        2,
        'post-invalidate run must re-execute',
      );
    } finally {
      await rm(source, { recursive: true, force: true });
      await rm(wsParent, { recursive: true, force: true });
      await rm(cacheRoot, { recursive: true, force: true });
      await rm(counterDir, { recursive: true, force: true });
    }
  });
});

// ----- VM-runner sandbox boundary -------------------------------------------

// The reviewer flagged that `run_in_vm` was silently spawning on the host;
// the contract is now "must run via the wired VM executor." Two surfaces:
// (a) no runner wired → fail loudly instead of host-spawning, (b) the
// configured runner receives the command (not a host fork).

describe('run_in_vm requires a wired VM runner', () => {
  it('fails with "no VM runner wired" when runInVm is not supplied', async () => {
    const source = await makeSourceRepo();
    const { wsParent, ws } = await makeWorkspace(source, '42');
    try {
      const ctx = baseContext(ws, '42');
      const sideEffect = path.join(ws, '.should-not-exist');
      // The previous executor would have host-spawned this command and
      // written the side-effect file. The fixed executor must short-circuit
      // before reaching any process spawn — the file's absence is the
      // assertion that the sandbox boundary held.
      const r = await runActions(
        [
          {
            kind: 'run_in_vm',
            name: 'rogue',
            cmd: ['sh', '-c', `touch "${sideEffect}"; exit 0`],
            // Disable retry so a single failed attempt ends the run.
            on_error: { retry: { count: 0, backoff_ms: 1 } },
          },
        ],
        { workspacePath: ws, ctx, snapshotId: 'actions:Review' },
      );
      assert.equal(r.ok, false);
      assert.match(String(r.reason), /no VM runner wired/);
      const { stat } = await import('node:fs/promises');
      await assert.rejects(stat(sideEffect), 'host spawn must not have happened');
    } finally {
      await rm(source, { recursive: true, force: true });
      await rm(wsParent, { recursive: true, force: true });
    }
  });

  it('routes run_in_vm through the wired RunInVmExecutor, not a host fork', async () => {
    const source = await makeSourceRepo();
    const { wsParent, ws } = await makeWorkspace(source, '42');
    const seen: Array<{ name: string; cmd: string[]; workdir: string }> = [];
    const fakeRunner: RunInVmExecutor = async (input) => {
      seen.push({ name: input.name, cmd: input.cmd, workdir: input.workdir });
      input.onStdout?.('hello\n');
      return { exit_code: 0, signal: null, timed_out: false, stdout: 'hello\n', stderr: '' };
    };
    try {
      const ctx = baseContext(ws, '42');
      const r = await runActions(
        [{ kind: 'run_in_vm', name: 'build', cmd: ['npm', 'run', 'build'] }],
        {
          workspacePath: ws,
          ctx,
          snapshotId: 'actions:Review',
          runInVm: fakeRunner,
        },
      );
      assert.equal(r.ok, true);
      assert.equal(seen.length, 1);
      assert.equal(seen[0]!.name, 'build');
      assert.deepEqual(seen[0]!.cmd, ['npm', 'run', 'build']);
      assert.equal(seen[0]!.workdir, ws);
    } finally {
      await rm(source, { recursive: true, force: true });
      await rm(wsParent, { recursive: true, force: true });
    }
  });
});

// ----- Failure propagation contract -----------------------------------------

// Reviewer's second finding: non-routed action failures were being swallowed,
// so a failed push/PR-create returned ok:true at the attempt level. The
// executor's ActionExecResult contract is the source of truth — runActions
// must surface ok:false (with no route_to) for ungraceful failures so the
// runner can map that to attempt failure.

describe('runActions failure propagation', () => {
  it('returns ok:false with no route_to when a typed action fails terminally', async () => {
    const source = await makeSourceRepo();
    const { wsParent, ws } = await makeWorkspace(source, '42');
    try {
      const ctx = baseContext(ws, '42');
      // No `origin` remote configured → `git push origin` fails. Retries
      // configured to 0 so the test runs quickly.
      const r = await runActions(
        [
          {
            kind: 'push_branch',
            remote: 'origin',
            ref: '$branch',
            on_error: { retry: { count: 0, backoff_ms: 1 } },
          },
        ],
        { workspacePath: ws, ctx, snapshotId: 'actions:Done' },
      );
      assert.equal(r.ok, false);
      assert.equal(r.route_to, null);
      assert.match(String(r.reason), /git push/);
    } finally {
      await rm(source, { recursive: true, force: true });
      await rm(wsParent, { recursive: true, force: true });
    }
  });

  it('returns ok:false WITH route_to when merge conflict reroutes', async () => {
    // Mirrors the existing merge-conflict happy path but asserts the
    // contract from the runner's perspective: a routed failure is still
    // ok:false (to break out of the action loop) but carries `route_to`,
    // which the runner uses to skip the attempt-failure path.
    const source = await makeSourceRepo();
    const { wsParent, ws } = await makeWorkspace(source, '42');
    try {
      await writeFile(path.join(ws, 'conflict.md'), 'agent-content\n', 'utf8');
      await git(['add', '.'], ws);
      await git(['commit', '-m', 'agent edit'], ws);
      await git(['checkout', '-b', 'integration', 'main'], ws);
      await writeFile(path.join(ws, 'conflict.md'), 'integration-content\n', 'utf8');
      await git(['add', '.'], ws);
      await git(['commit', '-m', 'integration edit'], ws);
      await git(['checkout', 'agent/42'], ws);

      const ctx = baseContext(ws, '42');
      const r = await runActions(
        [
          {
            kind: 'merge',
            source: 'agent/42',
            target: 'integration',
            on_conflict: { route_to: 'Conflict' },
            on_error: { retry: { count: 0, backoff_ms: 1 } },
          },
        ],
        { workspacePath: ws, ctx, snapshotId: 'actions:Done' },
      );
      assert.equal(r.ok, false);
      assert.equal(r.route_to, 'Conflict');
    } finally {
      await rm(source, { recursive: true, force: true });
      await rm(wsParent, { recursive: true, force: true });
    }
  });
});
