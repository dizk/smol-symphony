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
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fetchBaseInWorkspace, setupWorkspaceDir, resolveSetupOptions } from '../src/workspace.js';

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

  it('restores an origin pointing at the canonical HTTPS URL when SYMPHONY_REPO is set', async () => {
    // PR mode: origin must be present and target the canonical HTTPS URL for
    // the configured GitHub repo. `gh auth setup-git` and the
    // `origin/<base>` fetch are best-effort (network/auth dependent) and
    // happen to be no-ops in this test env; the key invariant is that
    // origin is restored to a usable URL after the clone-time strip.
    const source = await makeSourceRepo();
    const wsRoot = await mkdtemp(path.join(os.tmpdir(), 'symphony-ws-setup-pr-'));
    const wsPath = path.join(wsRoot, '7');
    await mkdir(wsPath, { recursive: true });
    try {
      await setupWorkspaceDir({
        workspacePath: wsPath,
        sourceRepo: source,
        baseBranch: 'main',
        branch: 'agent/7',
        originRepo: 'octo/example',
        gitIdentity: { name: 'symphony-agent', email: 'agent@symphony.local' },
      });
      const headRef = await git(['symbolic-ref', '--short', 'HEAD'], wsPath);
      assert.equal(headRef, 'agent/7', 'agent branch checked out');
      const originUrl = await git(['remote', 'get-url', 'origin'], wsPath);
      assert.equal(originUrl, 'https://github.com/octo/example.git');
    } finally {
      await rm(source, { recursive: true, force: true });
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
