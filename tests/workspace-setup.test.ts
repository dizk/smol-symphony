// Tests for the canonical clone+branch+remote setup (issue 34). Exercises the
// `setupWorkspaceDir` function lifted out of WORKFLOW.md's `hooks.after_create`
// shell. Both modes from the AC are covered:
//
//   • PR mode      — `originRepo` set: an `origin` remote is restored after
//                    the clone-time strip, and the canonical HTTPS URL is
//                    used. (We do NOT attempt the `gh auth setup-git` / fetch
//                    branch here; those are best-effort and don't run in a
//                    network-isolated test env.)
//   • local-only   — `originRepo` null: no origin, no push target, no network
//                    surface from inside the workspace.
//
// The tests build a real on-disk source repo (initial commit on `main`) so the
// clone path exercises actual git plumbing rather than a stub.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {
  fetchBaseInWorkspace,
  restorePushedBranch,
  setupWorkspaceDir,
  resolveSetupOptions,
} from '../src/workspace.js';

interface GitResult {
  exit: number;
  stdout: string;
  stderr: string;
}

function run(cmd: string, args: string[], cwd: string, env?: Record<string, string>): Promise<GitResult> {
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

async function makeSourceRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'symphony-source-repo-'));
  // Use `-b main` on init so we don't depend on the host's init.defaultBranch.
  await git(['init', '-b', 'main'], dir);
  await git(['config', 'user.name', 'test'], dir);
  await git(['config', 'user.email', 'test@example.com'], dir);
  await writeFile(path.join(dir, 'README.md'), '# source\n', 'utf8');
  await git(['add', '.'], dir);
  await git(['commit', '-m', 'initial'], dir);
  return dir;
}

describe('setupWorkspaceDir', () => {
  it('clones source repo on the base branch and cuts the per-issue branch (local-only)', async () => {
    // Local-only mode: SYMPHONY_REPO is null. No origin should remain, no
    // network targets reachable from inside the workspace.
    const source = await makeSourceRepo();
    const wsRoot = await mkdtemp(path.join(os.tmpdir(), 'symphony-ws-setup-'));
    const wsPath = path.join(wsRoot, '42');
    await mkdir(wsPath, { recursive: true });
    try {
      await setupWorkspaceDir({
        workspacePath: wsPath,
        sourceRepo: source,
        baseBranch: 'main',
        branch: 'agent/42',
        originRepo: null,
        gitIdentity: { name: 'symphony-agent', email: 'agent@symphony.local' },
      });
      const headRef = await git(['symbolic-ref', '--short', 'HEAD'], wsPath);
      assert.equal(headRef, 'agent/42', 'agent branch checked out');
      const remotes = await git(['remote'], wsPath);
      assert.equal(remotes, '', 'no remotes configured in local-only mode');
      const userName = await git(['config', '--local', 'user.name'], wsPath);
      const userEmail = await git(['config', '--local', 'user.email'], wsPath);
      assert.equal(userName, 'symphony-agent');
      assert.equal(userEmail, 'agent@symphony.local');
      // Base branch is reachable in the workspace (cloned, even if HEAD is
      // now on agent/<id>).
      await git(['rev-parse', 'main'], wsPath);
    } finally {
      await rm(source, { recursive: true, force: true });
      await rm(wsRoot, { recursive: true, force: true });
    }
  });

  it('restores origin and cuts a fresh per-issue branch on first dispatch (reachable origin, no pushed branch)', async () => {
    // PR mode against a reachable origin with no pushed agent/<id> yet: origin
    // is restored and HEAD lands on a freshly-cut agent/7. origin points at a
    // local bare remote (originUrl) so the restore probe is hermetic and
    // ls-remote returns a clean "no such ref" (exit 2); production derives
    // https://github.com/<originRepo>.git.
    const source = await makeSourceRepo();
    const bare = await mkdtemp(path.join(os.tmpdir(), 'symphony-ws-setup-pr-remote-'));
    const wsRoot = await mkdtemp(path.join(os.tmpdir(), 'symphony-ws-setup-pr-'));
    const wsPath = path.join(wsRoot, '7');
    await mkdir(wsPath, { recursive: true });
    try {
      await git(['init', '--bare', '-b', 'main'], bare);
      await setupWorkspaceDir({
        workspacePath: wsPath,
        sourceRepo: source,
        baseBranch: 'main',
        branch: 'agent/7',
        originRepo: 'octo/example',
        originUrl: bare,
        gitIdentity: { name: 'symphony-agent', email: 'agent@symphony.local' },
      });
      const headRef = await git(['symbolic-ref', '--short', 'HEAD'], wsPath);
      assert.equal(headRef, 'agent/7', 'fresh agent branch checked out');
      const originUrl = await git(['remote', 'get-url', 'origin'], wsPath);
      assert.equal(originUrl, bare, 'origin restored to the configured URL');
    } finally {
      await rm(source, { recursive: true, force: true });
      await rm(bare, { recursive: true, force: true });
      await rm(wsRoot, { recursive: true, force: true });
    }
  });

  it('refuses to set up a workspace when the source repo is not a git repo', async () => {
    // Same precondition the shell hook used to enforce. Surfaces as a typed
    // WorkspaceError so the runner can decide on retry vs hard-fail.
    const source = await mkdtemp(path.join(os.tmpdir(), 'symphony-not-a-repo-'));
    const wsRoot = await mkdtemp(path.join(os.tmpdir(), 'symphony-ws-setup-bad-'));
    const wsPath = path.join(wsRoot, '1');
    await mkdir(wsPath, { recursive: true });
    try {
      await assert.rejects(
        setupWorkspaceDir({
          workspacePath: wsPath,
          sourceRepo: source,
          baseBranch: 'main',
          branch: 'agent/1',
          originRepo: null,
          gitIdentity: { name: 'a', email: 'a@b.local' },
        }),
        /not a git repository/,
      );
    } finally {
      await rm(source, { recursive: true, force: true });
      await rm(wsRoot, { recursive: true, force: true });
    }
  });
});

describe('fetchBaseInWorkspace (issue 101)', () => {
  it('runs `git fetch --no-tags origin <base>` and updates the remote-tracking ref', async () => {
    // Bare remote → workspace clones from it on `main`; an advancing commit on
    // the bare remote (via a sibling clone) is picked up by the pre-dispatch
    // fetch. The post-fetch `origin/main` SHA must match the new tip.
    const bareRemote = await mkdtemp(path.join(os.tmpdir(), 'symphony-base-fetch-remote-'));
    const wsRoot = await mkdtemp(path.join(os.tmpdir(), 'symphony-base-fetch-ws-'));
    const pusher = await mkdtemp(path.join(os.tmpdir(), 'symphony-base-fetch-pusher-'));
    try {
      await git(['init', '--bare', '-b', 'main'], bareRemote);
      // Seed the remote with one commit on main.
      const seed = await mkdtemp(path.join(os.tmpdir(), 'symphony-base-fetch-seed-'));
      try {
        await git(['init', '-b', 'main'], seed);
        await git(['config', 'user.name', 'test'], seed);
        await git(['config', 'user.email', 'test@example.com'], seed);
        await writeFile(path.join(seed, 'a.txt'), 'one\n');
        await git(['add', '.'], seed);
        await git(['commit', '-m', 'seed'], seed);
        await git(['remote', 'add', 'origin', bareRemote], seed);
        await git(['push', 'origin', 'main'], seed);
      } finally {
        await rm(seed, { recursive: true, force: true });
      }

      // Clone the workspace.
      const wsPath = path.join(wsRoot, '42');
      await mkdir(wsPath, { recursive: true });
      await git(['clone', bareRemote, '.'], wsPath);
      await git(['config', 'user.name', 'symphony-agent'], wsPath);
      await git(['config', 'user.email', 'agent@symphony.local'], wsPath);
      await git(['checkout', '-b', 'agent/42'], wsPath);
      const oldOriginMain = await git(['rev-parse', 'origin/main'], wsPath);

      // Advance main on the remote from a sibling clone — mirrors a peer PR
      // landing while this workspace was paused between dispatches.
      await git(['clone', bareRemote, '.'], pusher);
      await git(['config', 'user.name', 'peer'], pusher);
      await git(['config', 'user.email', 'peer@example.com'], pusher);
      await writeFile(path.join(pusher, 'b.txt'), 'two\n');
      await git(['add', '.'], pusher);
      await git(['commit', '-m', 'advance'], pusher);
      await git(['push', 'origin', 'main'], pusher);
      const advancedSha = await git(['rev-parse', 'HEAD'], pusher);

      const result = await fetchBaseInWorkspace(wsPath, 'main');
      assert.deepEqual(result, { ok: true, skipped: false, diagnostic: null });

      const newOriginMain = await git(['rev-parse', 'origin/main'], wsPath);
      assert.equal(newOriginMain, advancedSha, 'origin/main now points at the advanced tip');
      assert.notEqual(newOriginMain, oldOriginMain, 'fetch actually moved the ref forward');
    } finally {
      await rm(bareRemote, { recursive: true, force: true });
      await rm(wsRoot, { recursive: true, force: true });
      await rm(pusher, { recursive: true, force: true });
    }
  });

  it('returns skipped:true when no origin remote is configured (local-only mode)', async () => {
    // Workspaces created by `setupWorkspaceDir` in local mode have all
    // remotes stripped. The pre-dispatch fetch must no-op cleanly so an
    // operator who doesn't use PR mode isn't broken by the new behavior.
    const source = await makeSourceRepo();
    const wsRoot = await mkdtemp(path.join(os.tmpdir(), 'symphony-base-fetch-local-ws-'));
    const wsPath = path.join(wsRoot, '42');
    await mkdir(wsPath, { recursive: true });
    try {
      await setupWorkspaceDir({
        workspacePath: wsPath,
        sourceRepo: source,
        baseBranch: 'main',
        branch: 'agent/42',
        originRepo: null,
        gitIdentity: { name: 'symphony-agent', email: 'agent@symphony.local' },
      });
      // Sanity: no remote.
      const remotes = await git(['remote'], wsPath);
      assert.equal(remotes, '');

      const result = await fetchBaseInWorkspace(wsPath, 'main');
      assert.deepEqual(result, { ok: true, skipped: true, diagnostic: null });
    } finally {
      await rm(source, { recursive: true, force: true });
      await rm(wsRoot, { recursive: true, force: true });
    }
  });

  it('returns ok:false with a diagnostic when the fetch fails (e.g. base ref missing on remote)', async () => {
    // origin points at a bare remote that does NOT have the requested base
    // branch. `git fetch` will exit non-zero; the helper surfaces a typed
    // failure rather than throwing so the dispatch path can abort the
    // attempt without launching the agent against a stale base ref (issue
    // 101 invariant: fresh `origin/<base>` is a dispatch precondition).
    const bareRemote = await mkdtemp(path.join(os.tmpdir(), 'symphony-base-fetch-fail-remote-'));
    const wsRoot = await mkdtemp(path.join(os.tmpdir(), 'symphony-base-fetch-fail-ws-'));
    try {
      await git(['init', '--bare', '-b', 'main'], bareRemote);
      // No commits on main — fetching a nonexistent branch fails.
      const wsPath = path.join(wsRoot, '42');
      await mkdir(wsPath, { recursive: true });
      await git(['init', '-b', 'main'], wsPath);
      await git(['remote', 'add', 'origin', bareRemote], wsPath);

      const result = await fetchBaseInWorkspace(wsPath, 'nonexistent-branch');
      assert.equal(result.ok, false);
      assert.equal(result.skipped, false);
      assert.match(result.diagnostic ?? '', /couldn't find remote ref|fatal/i);
    } finally {
      await rm(bareRemote, { recursive: true, force: true });
      await rm(wsRoot, { recursive: true, force: true });
    }
  });
});

describe('restorePushedBranch', () => {
  it('restores an existing remote per-issue branch so a re-dispatch continues the pushed work', async () => {
    // The bug this closes: on a re-dispatch the workspace was re-cloned and the
    // per-issue branch cut fresh off base, orphaning the already-pushed
    // `agent/<id>` commits. Here the remote already has agent/77 with distinct
    // work; restore must land HEAD on it (not re-cut from base).
    const bareRemote = await mkdtemp(path.join(os.tmpdir(), 'symphony-restore-remote-'));
    const wsRoot = await mkdtemp(path.join(os.tmpdir(), 'symphony-restore-ws-'));
    try {
      await git(['init', '--bare', '-b', 'main'], bareRemote);
      let agentSha = '';
      const seed = await mkdtemp(path.join(os.tmpdir(), 'symphony-restore-seed-'));
      try {
        await git(['init', '-b', 'main'], seed);
        await git(['config', 'user.name', 'test'], seed);
        await git(['config', 'user.email', 'test@example.com'], seed);
        await writeFile(path.join(seed, 'a.txt'), 'base\n');
        await git(['add', '.'], seed);
        await git(['commit', '-m', 'base'], seed);
        await git(['remote', 'add', 'origin', bareRemote], seed);
        await git(['push', 'origin', 'main'], seed);
        await git(['checkout', '-b', 'agent/77'], seed);
        await writeFile(path.join(seed, 'work.txt'), 'pushed work\n');
        await git(['add', '.'], seed);
        await git(['commit', '-m', 'agent work'], seed);
        await git(['push', 'origin', 'agent/77'], seed);
        agentSha = await git(['rev-parse', 'HEAD'], seed);
      } finally {
        await rm(seed, { recursive: true, force: true });
      }

      // Fresh workspace clone lands on main with no local agent/77.
      const wsPath = path.join(wsRoot, '77');
      await mkdir(wsPath, { recursive: true });
      await git(['clone', bareRemote, '.'], wsPath);
      await git(['config', 'user.name', 'symphony-agent'], wsPath);
      await git(['config', 'user.email', 'agent@symphony.local'], wsPath);
      assert.equal(await git(['symbolic-ref', '--short', 'HEAD'], wsPath), 'main');

      const restored = await restorePushedBranch(wsPath, 'agent/77');
      assert.equal(restored, true);
      assert.equal(await git(['symbolic-ref', '--short', 'HEAD'], wsPath), 'agent/77');
      assert.equal(
        await git(['rev-parse', 'HEAD'], wsPath),
        agentSha,
        'HEAD restored to the pushed remote tip, not re-cut from base',
      );
      assert.equal(await readFile(path.join(wsPath, 'work.txt'), 'utf8'), 'pushed work\n');
    } finally {
      await rm(bareRemote, { recursive: true, force: true });
      await rm(wsRoot, { recursive: true, force: true });
    }
  });

  it('returns false (caller cuts a fresh branch) when no such branch exists on the remote', async () => {
    const bareRemote = await mkdtemp(path.join(os.tmpdir(), 'symphony-restore-none-remote-'));
    const wsRoot = await mkdtemp(path.join(os.tmpdir(), 'symphony-restore-none-ws-'));
    try {
      await git(['init', '--bare', '-b', 'main'], bareRemote);
      const seed = await mkdtemp(path.join(os.tmpdir(), 'symphony-restore-none-seed-'));
      try {
        await git(['init', '-b', 'main'], seed);
        await git(['config', 'user.name', 'test'], seed);
        await git(['config', 'user.email', 'test@example.com'], seed);
        await writeFile(path.join(seed, 'a.txt'), 'base\n');
        await git(['add', '.'], seed);
        await git(['commit', '-m', 'base'], seed);
        await git(['remote', 'add', 'origin', bareRemote], seed);
        await git(['push', 'origin', 'main'], seed);
      } finally {
        await rm(seed, { recursive: true, force: true });
      }
      const wsPath = path.join(wsRoot, '88');
      await mkdir(wsPath, { recursive: true });
      await git(['clone', bareRemote, '.'], wsPath);
      assert.equal(await git(['symbolic-ref', '--short', 'HEAD'], wsPath), 'main');

      const restored = await restorePushedBranch(wsPath, 'agent/88');
      assert.equal(restored, false);
      // HEAD unchanged — the caller cuts the fresh branch off base.
      assert.equal(await git(['symbolic-ref', '--short', 'HEAD'], wsPath), 'main');
    } finally {
      await rm(bareRemote, { recursive: true, force: true });
      await rm(wsRoot, { recursive: true, force: true });
    }
  });

  it('does not false-match a suffix-colliding remote branch (cuts fresh)', async () => {
    // origin has refs/heads/archive/agent/88 but NOT agent/88. ls-remote's
    // suffix matching would exit 0 on a bare `agent/88` pattern; the exact-ref
    // probe must return false so a genuine first dispatch cuts fresh rather than
    // trying (and failing) to fetch a nonexistent exact ref and unwinding.
    const bareRemote = await mkdtemp(path.join(os.tmpdir(), 'symphony-restore-collide-remote-'));
    const wsRoot = await mkdtemp(path.join(os.tmpdir(), 'symphony-restore-collide-ws-'));
    try {
      await git(['init', '--bare', '-b', 'main'], bareRemote);
      const seed = await mkdtemp(path.join(os.tmpdir(), 'symphony-restore-collide-seed-'));
      try {
        await git(['init', '-b', 'main'], seed);
        await git(['config', 'user.name', 'test'], seed);
        await git(['config', 'user.email', 'test@example.com'], seed);
        await writeFile(path.join(seed, 'a.txt'), 'base\n');
        await git(['add', '.'], seed);
        await git(['commit', '-m', 'base'], seed);
        await git(['remote', 'add', 'origin', bareRemote], seed);
        await git(['push', 'origin', 'main'], seed);
        await git(['checkout', '-b', 'archive/agent/88'], seed);
        await writeFile(path.join(seed, 'old.txt'), 'archived\n');
        await git(['add', '.'], seed);
        await git(['commit', '-m', 'archived'], seed);
        await git(['push', 'origin', 'archive/agent/88'], seed);
      } finally {
        await rm(seed, { recursive: true, force: true });
      }
      const wsPath = path.join(wsRoot, '88');
      await mkdir(wsPath, { recursive: true });
      await git(['clone', bareRemote, '.'], wsPath);
      assert.equal(await git(['symbolic-ref', '--short', 'HEAD'], wsPath), 'main');

      const restored = await restorePushedBranch(wsPath, 'agent/88');
      assert.equal(restored, false);
      assert.equal(await git(['symbolic-ref', '--short', 'HEAD'], wsPath), 'main');
    } finally {
      await rm(bareRemote, { recursive: true, force: true });
      await rm(wsRoot, { recursive: true, force: true });
    }
  });

  it('fetches the exact branch ref, not a same-named tag', async () => {
    // A tag sharing the branch name (refs/tags/<branch>) pointing elsewhere must
    // not be checked out in place of the branch. Fetching refs/heads/<branch>
    // (matching the probe) restores the branch commit, not the tag's.
    const bareRemote = await mkdtemp(path.join(os.tmpdir(), 'symphony-restore-tag-remote-'));
    const wsRoot = await mkdtemp(path.join(os.tmpdir(), 'symphony-restore-tag-ws-'));
    try {
      await git(['init', '--bare', '-b', 'main'], bareRemote);
      let branchSha = '';
      let baseSha = '';
      const seed = await mkdtemp(path.join(os.tmpdir(), 'symphony-restore-tag-seed-'));
      try {
        await git(['init', '-b', 'main'], seed);
        await git(['config', 'user.name', 'test'], seed);
        await git(['config', 'user.email', 'test@example.com'], seed);
        await writeFile(path.join(seed, 'a.txt'), 'base\n');
        await git(['add', '.'], seed);
        await git(['commit', '-m', 'base'], seed);
        await git(['remote', 'add', 'origin', bareRemote], seed);
        await git(['push', 'origin', 'main'], seed);
        baseSha = await git(['rev-parse', 'HEAD'], seed);
        await git(['checkout', '-b', 'agent/tagcollide'], seed);
        await writeFile(path.join(seed, 'work.txt'), 'branch work\n');
        await git(['add', '.'], seed);
        await git(['commit', '-m', 'branch work'], seed);
        branchSha = await git(['rev-parse', 'HEAD'], seed);
        // Tag of the same name pointing at base (a different commit than the branch).
        await git(['tag', 'agent/tagcollide', 'main'], seed);
        await git(
          ['push', 'origin', 'refs/heads/agent/tagcollide:refs/heads/agent/tagcollide', 'refs/tags/agent/tagcollide:refs/tags/agent/tagcollide'],
          seed,
        );
      } finally {
        await rm(seed, { recursive: true, force: true });
      }
      assert.notEqual(branchSha, baseSha);
      const wsPath = path.join(wsRoot, 'tc');
      await mkdir(wsPath, { recursive: true });
      await git(['clone', bareRemote, '.'], wsPath);

      const restored = await restorePushedBranch(wsPath, 'agent/tagcollide');
      assert.equal(restored, true);
      assert.equal(
        await git(['rev-parse', 'HEAD'], wsPath),
        branchSha,
        'restored the branch commit, not the same-named tag',
      );
    } finally {
      await rm(bareRemote, { recursive: true, force: true });
      await rm(wsRoot, { recursive: true, force: true });
    }
  });

  it('returns false in local-only mode (no origin remote)', async () => {
    const wsRoot = await mkdtemp(path.join(os.tmpdir(), 'symphony-restore-local-ws-'));
    const wsPath = path.join(wsRoot, '99');
    try {
      await mkdir(wsPath, { recursive: true });
      await git(['init', '-b', 'main'], wsPath);
      await git(['config', 'user.name', 'test'], wsPath);
      await git(['config', 'user.email', 'test@example.com'], wsPath);
      await writeFile(path.join(wsPath, 'a.txt'), 'base\n');
      await git(['add', '.'], wsPath);
      await git(['commit', '-m', 'base'], wsPath);
      const restored = await restorePushedBranch(wsPath, 'agent/99');
      assert.equal(restored, false);
    } finally {
      await rm(wsRoot, { recursive: true, force: true });
    }
  });

  it('fails closed (throws) when the origin is unreachable, so setup unwinds and a later tick can retry', async () => {
    // Transport/auth failure must NOT be treated as "no branch" and cut fresh:
    // that would risk a later force-with-lease over already-pushed work once the
    // origin recovers. An unreachable origin makes ls-remote exit 128 → throw.
    const wsRoot = await mkdtemp(path.join(os.tmpdir(), 'symphony-restore-unreachable-ws-'));
    const wsPath = path.join(wsRoot, '55');
    try {
      await mkdir(wsPath, { recursive: true });
      await git(['init', '-b', 'main'], wsPath);
      await git(['config', 'user.name', 'test'], wsPath);
      await git(['config', 'user.email', 'test@example.com'], wsPath);
      await writeFile(path.join(wsPath, 'a.txt'), 'base\n');
      await git(['add', '.'], wsPath);
      await git(['commit', '-m', 'base'], wsPath);
      await git(['remote', 'add', 'origin', '/nonexistent/symphony-restore-unreachable-remote'], wsPath);
      await assert.rejects(
        restorePushedBranch(wsPath, 'agent/55'),
        /ls-remote origin agent\/55 failed/,
      );
    } finally {
      await rm(wsRoot, { recursive: true, force: true });
    }
  });
});

describe('resolveSetupOptions', () => {
  it('falls back to workflowDir and main when no env vars are set', () => {
    const prevSource = process.env.SYMPHONY_SOURCE_REPO;
    const prevBase = process.env.SYMPHONY_BASE_BRANCH;
    const prevRepo = process.env.SYMPHONY_REPO;
    delete process.env.SYMPHONY_SOURCE_REPO;
    delete process.env.SYMPHONY_BASE_BRANCH;
    delete process.env.SYMPHONY_REPO;
    try {
      const opts = resolveSetupOptions({
        identifier: '42',
        workspacePath: '/tmp/ws/42',
        workflowDir: '/repo/project',
      });
      assert.equal(opts.sourceRepo, '/repo/project');
      assert.equal(opts.baseBranch, 'main');
      assert.equal(opts.originRepo, null);
      assert.equal(opts.branch, 'agent/42');
      assert.equal(opts.gitIdentity.name, 'symphony-agent');
      assert.equal(opts.gitIdentity.email, 'agent@symphony.local');
    } finally {
      if (prevSource !== undefined) process.env.SYMPHONY_SOURCE_REPO = prevSource;
      if (prevBase !== undefined) process.env.SYMPHONY_BASE_BRANCH = prevBase;
      if (prevRepo !== undefined) process.env.SYMPHONY_REPO = prevRepo;
    }
  });

  it('honors SYMPHONY_REPO / SYMPHONY_BASE_BRANCH / SYMPHONY_SOURCE_REPO env overrides', () => {
    const prevSource = process.env.SYMPHONY_SOURCE_REPO;
    const prevBase = process.env.SYMPHONY_BASE_BRANCH;
    const prevRepo = process.env.SYMPHONY_REPO;
    process.env.SYMPHONY_SOURCE_REPO = '/other/source';
    process.env.SYMPHONY_BASE_BRANCH = 'develop';
    process.env.SYMPHONY_REPO = 'octo/example';
    try {
      const opts = resolveSetupOptions({
        identifier: '7',
        workspacePath: '/tmp/ws/7',
        workflowDir: '/repo/project',
      });
      assert.equal(opts.sourceRepo, '/other/source');
      assert.equal(opts.baseBranch, 'develop');
      assert.equal(opts.originRepo, 'octo/example');
      assert.equal(opts.branch, 'agent/7');
    } finally {
      if (prevSource === undefined) delete process.env.SYMPHONY_SOURCE_REPO;
      else process.env.SYMPHONY_SOURCE_REPO = prevSource;
      if (prevBase === undefined) delete process.env.SYMPHONY_BASE_BRANCH;
      else process.env.SYMPHONY_BASE_BRANCH = prevBase;
      if (prevRepo === undefined) delete process.env.SYMPHONY_REPO;
      else process.env.SYMPHONY_REPO = prevRepo;
    }
  });
});
