import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, stat, rm, access, symlink, lstat } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ADAPTERS,
  isKnownAdapter,
  deriveAcpCommand,
  stageCredential,
} from '../src/agent/adapters.js';
import { validateDispatch } from '../src/workflow.js';
import type { ServiceConfig } from '../src/types.js';

function bareCfg(over: Partial<ServiceConfig['acp']> = {}): ServiceConfig {
  return {
    workflow_path: '/tmp/WORKFLOW.md',
    workflow_dir: '/tmp',
    tracker: {
      kind: 'local',
      endpoint: null,
      api_key: null,
      project_slug: null,
      active_states: ['Todo'],
      terminal_states: ['Done'],
      root: '/tmp/issues',
    },
    polling: { interval_ms: 30_000 },
    workspace: { root: '/tmp/ws' },
    hooks: {
      after_create: null,
      before_run: null,
      after_run: null,
      before_remove: null,
      timeout_ms: 60_000,
    },
    agent: {
      max_concurrent_agents: 1,
      max_turns: 1,
      max_retry_backoff_ms: 1000,
      max_concurrent_agents_by_state: {},
    },
    acp: {
      adapter: 'claude',
      command: null,
      shell: 'bash',
      prompt_timeout_ms: 1000,
      read_timeout_ms: 1000,
      stall_timeout_ms: 1000,
      ...over,
    },
    smolvm: {
      image: null,
      from: null,
      cpus: 1,
      mem_mib: 256,
      net: false,
      bin_path: null,
      volumes: [],
      forward_env: [],
      endpoint: 'unix:///tmp/sock',
    },
    server: { port: null, host: '127.0.0.1' },
    mcp: { enabled: true, host: '10.0.2.2', explicit_host_url: null },
  } as ServiceConfig;
}

describe('adapters registry', () => {
  it('exposes claude and codex profiles', () => {
    assert.ok(ADAPTERS.claude);
    assert.deepEqual(ADAPTERS.claude.binary, ['claude-agent-acp']);
    assert.equal(ADAPTERS.claude.guestCredentialPath, '/root/.claude/.credentials.json');
    assert.ok(ADAPTERS.codex);
    assert.deepEqual(ADAPTERS.codex.binary, ['codex-acp']);
    assert.equal(ADAPTERS.codex.guestCredentialPath, '/root/.codex/auth.json');
  });

  it('isKnownAdapter narrows on supported ids only', () => {
    assert.equal(isKnownAdapter('claude'), true);
    assert.equal(isKnownAdapter('codex'), true);
    assert.equal(isKnownAdapter('opencode'), false);
    assert.equal(isKnownAdapter('unknown'), false);
    assert.equal(isKnownAdapter(''), false);
  });

  it('deriveAcpCommand emits a copy-then-exec pipeline using the supplied staged path', () => {
    const cmd = deriveAcpCommand(ADAPTERS.claude, '.git/symphony-runtime/credentials/claude');
    assert.match(cmd, /mkdir -p \/root\/\.claude/);
    assert.match(cmd, /cp \.git\/symphony-runtime\/credentials\/claude \/root\/\.claude\/\.credentials\.json/);
    assert.match(cmd, /chmod 600 \/root\/\.claude\/\.credentials\.json/);
    assert.match(cmd, /exec claude-agent-acp$/);
  });

  it('deriveAcpCommand for codex points at codex paths', () => {
    const cmd = deriveAcpCommand(ADAPTERS.codex, '.git/symphony-runtime/credentials/codex');
    assert.match(cmd, /cp \.git\/symphony-runtime\/credentials\/codex \/root\/\.codex\/auth\.json/);
    assert.match(cmd, /exec codex-acp$/);
  });

  it('deriveAcpCommand quotes every binary token (no shell injection via profile)', () => {
    const evil = {
      id: 'claude' as const,
      hostCredentialPath: '.claude/.credentials.json',
      guestCredentialPath: '/root/.claude/.credentials.json',
      // Imagine a future profile with multi-token launch + a metacharacter slipping in.
      binary: ['opencode', 'acp', '; rm -rf /'] as const,
    };
    const cmd = deriveAcpCommand(evil, '.git/symphony-runtime/credentials/claude');
    // Each token shows up single-quoted; the destructive payload cannot escape.
    assert.match(cmd, /exec opencode acp '; rm -rf \/'$/);
    assert.ok(!/exec.*&&.*rm -rf/.test(cmd));
  });

  it('deriveAcpCommand throws on an empty binary vector', () => {
    assert.throws(
      () =>
        deriveAcpCommand(
          {
            id: 'claude',
            hostCredentialPath: '.claude/.credentials.json',
            guestCredentialPath: '/root/.claude/.credentials.json',
            binary: [],
          },
          '.git/symphony-runtime/credentials/claude',
        ),
      /empty binary launch vector/,
    );
  });

  it('deriveAcpCommand shell-quotes the staged path defensively', () => {
    const cmd = deriveAcpCommand(ADAPTERS.claude, 'has spaces/creds');
    // shQuote single-quotes anything outside [A-Za-z0-9_\-./], so the space-containing
    // path becomes one safe token in the cp argument.
    assert.match(cmd, /cp 'has spaces\/creds'/);
  });
});

describe('stageCredential', () => {
  it('stages inside .git/symphony-runtime/ when the workspace is a normal git clone', async () => {
    // Files under .git/ are git's private area: `git add`/`git status` never recurse
    // into it, so the credential is structurally untrackable. This avoids the
    // gitignore-negation and tracked-file leaks that staging inside the working
    // tree would be vulnerable to.
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'symphony-stage-'));
    const fakeHome = path.join(tmp, 'home');
    const ws = path.join(tmp, 'ws');
    await mkdir(path.join(fakeHome, '.claude'), { recursive: true });
    await mkdir(path.join(ws, '.git'), { recursive: true });
    await writeFile(path.join(fakeHome, '.claude', '.credentials.json'), '{"tok":"abc"}', { mode: 0o600 });

    const origHome = os.homedir;
    (os as { homedir: () => string }).homedir = () => fakeHome;
    try {
      const staged = await stageCredential(ws, ADAPTERS.claude);
      assert.equal(staged.absPath, path.join(ws, '.git', 'symphony-runtime', 'credentials', 'claude'));
      assert.equal(staged.relPath, '.git/symphony-runtime/credentials/claude');
      const body = await readFile(staged.absPath, 'utf8');
      assert.equal(body, '{"tok":"abc"}');
      const st = await stat(staged.absPath);
      assert.equal(st.mode & 0o777, 0o600);
      // No exclude file is needed — git literally doesn't recurse into .git/.
      await assert.rejects(
        () => access(path.join(ws, '.git', 'info', 'exclude'), fsConstants.F_OK),
        /ENOENT/,
      );
    } finally {
      (os as { homedir: () => string }).homedir = origHome;
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('stages at .symphony-runtime/ when the workspace has no git and no ancestor git', async () => {
    // No git anywhere — workspace-root staging is fine.
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'symphony-stage-'));
    const fakeHome = path.join(tmp, 'home');
    const ws = path.join(tmp, 'ws');
    await mkdir(path.join(fakeHome, '.claude'), { recursive: true });
    await mkdir(ws, { recursive: true });
    await writeFile(path.join(fakeHome, '.claude', '.credentials.json'), '{}', { mode: 0o600 });

    const origHome = os.homedir;
    (os as { homedir: () => string }).homedir = () => fakeHome;
    try {
      const staged = await stageCredential(ws, ADAPTERS.claude);
      assert.equal(staged.relPath, '.symphony-runtime/credentials/claude');
      assert.equal(staged.absPath, path.join(ws, '.symphony-runtime', 'credentials', 'claude'));
    } finally {
      (os as { homedir: () => string }).homedir = origHome;
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('refuses the no-.git fallback when the workspace is inside an ancestor git repo', async () => {
    // Regression: git discovery walks up the directory tree. A workspace with no
    // own .git but inside an ancestor's working tree would let `git add -A` from
    // the workspace stage the credential in the ancestor's index, leaking it.
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'symphony-stage-'));
    const fakeHome = path.join(tmp, 'home');
    const ancestor = path.join(tmp, 'ancestor');
    const ws = path.join(ancestor, 'nested', 'workspace');
    await mkdir(path.join(fakeHome, '.claude'), { recursive: true });
    await mkdir(path.join(ancestor, '.git'), { recursive: true });
    await mkdir(ws, { recursive: true });
    await writeFile(path.join(fakeHome, '.claude', '.credentials.json'), 'HOSTCRED', { mode: 0o600 });

    const origHome = os.homedir;
    (os as { homedir: () => string }).homedir = () => fakeHome;
    try {
      await assert.rejects(
        () => stageCredential(ws, ADAPTERS.claude),
        /is inside an ancestor git repo/,
      );
      // No credential leaked anywhere.
      await assert.rejects(
        () => access(path.join(ws, '.symphony-runtime'), fsConstants.F_OK),
        /ENOENT/,
      );
    } finally {
      (os as { homedir: () => string }).homedir = origHome;
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('refuses the no-.git fallback when the workspace reaches an ancestor git via a symlinked parent', async () => {
    // Regression: findAncestorGit used to walk the lexical workspacePath, so a
    // workspace reached via a symlinked parent (e.g. /tmp/.../symlinked-ancestor
    // → /tmp/.../real-ancestor) would never see the real ancestor's .git/. The
    // no-git fallback then proceeded and staged the credential inside what is
    // actually a working tree — precisely the leak this guard exists to prevent.
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'symphony-stage-'));
    const fakeHome = path.join(tmp, 'home');
    const realAncestor = path.join(tmp, 'real-ancestor');
    const symlinkedAncestor = path.join(tmp, 'symlinked-ancestor');
    const ws = path.join(symlinkedAncestor, 'nested', 'workspace');
    await mkdir(path.join(fakeHome, '.claude'), { recursive: true });
    await mkdir(path.join(realAncestor, '.git'), { recursive: true });
    await mkdir(path.join(realAncestor, 'nested', 'workspace'), { recursive: true });
    await symlink(realAncestor, symlinkedAncestor);
    await writeFile(path.join(fakeHome, '.claude', '.credentials.json'), 'HOSTCRED', { mode: 0o600 });

    const origHome = os.homedir;
    (os as { homedir: () => string }).homedir = () => fakeHome;
    try {
      await assert.rejects(
        () => stageCredential(ws, ADAPTERS.claude),
        /is inside an ancestor git repo/,
      );
      // No credential leaked at the lexical (symlinked) path or the real one.
      await assert.rejects(
        () => access(path.join(ws, '.symphony-runtime'), fsConstants.F_OK),
        /ENOENT/,
      );
      await assert.rejects(
        () =>
          access(
            path.join(realAncestor, 'nested', 'workspace', '.symphony-runtime'),
            fsConstants.F_OK,
          ),
        /ENOENT/,
      );
    } finally {
      (os as { homedir: () => string }).homedir = origHome;
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('an own .git/ shields the ancestor — nested git case stages safely', async () => {
    // When the workspace HAS its own .git/, ancestor discovery doesn't matter:
    // git would stop at the workspace's own gitdir, and our staging lands inside
    // it (structurally untrackable). Verify the nested case works end-to-end.
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'symphony-stage-'));
    const fakeHome = path.join(tmp, 'home');
    const ancestor = path.join(tmp, 'ancestor');
    const ws = path.join(ancestor, 'nested', 'workspace');
    await mkdir(path.join(fakeHome, '.claude'), { recursive: true });
    await mkdir(path.join(ancestor, '.git'), { recursive: true });
    await mkdir(path.join(ws, '.git'), { recursive: true });
    await writeFile(path.join(fakeHome, '.claude', '.credentials.json'), 'HOSTCRED', { mode: 0o600 });

    const origHome = os.homedir;
    (os as { homedir: () => string }).homedir = () => fakeHome;
    try {
      const staged = await stageCredential(ws, ADAPTERS.claude);
      assert.equal(staged.relPath, '.git/symphony-runtime/credentials/claude');
      assert.equal(await readFile(staged.absPath, 'utf8'), 'HOSTCRED');
    } finally {
      (os as { homedir: () => string }).homedir = origHome;
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('refuses to auto-stage in a linked worktree (.git is a file)', async () => {
    // Regression: worktrees don't have a .git/ dir to stage under, and any
    // worktree-internal path is inside the working tree where gitignore-
    // negation can still expose the secret. Refuse loudly; operators using
    // worktrees must override acp.command.
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'symphony-stage-'));
    const fakeHome = path.join(tmp, 'home');
    const ws = path.join(tmp, 'ws');
    const perWorktreeGitDir = path.join(tmp, 'wtgitdir');
    await mkdir(path.join(fakeHome, '.claude'), { recursive: true });
    await mkdir(ws, { recursive: true });
    await mkdir(perWorktreeGitDir, { recursive: true });
    await writeFile(path.join(fakeHome, '.claude', '.credentials.json'), '{}', { mode: 0o600 });
    await writeFile(path.join(ws, '.git'), `gitdir: ${perWorktreeGitDir}\n`);

    const origHome = os.homedir;
    (os as { homedir: () => string }).homedir = () => fakeHome;
    try {
      await assert.rejects(
        () => stageCredential(ws, ADAPTERS.claude),
        /cannot auto-stage credentials in a linked worktree/,
      );
      // No credential leaked anywhere in the workspace. `.git` is still the
      // worktree pointer file (a file, not a dir), and no `.symphony-runtime/`
      // dir was created at the workspace root.
      const gitSt = await lstat(path.join(ws, '.git'));
      assert.equal(gitSt.isFile(), true);
      await assert.rejects(
        () => access(path.join(ws, '.symphony-runtime'), fsConstants.F_OK),
        /ENOENT/,
      );
    } finally {
      (os as { homedir: () => string }).homedir = origHome;
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('replaces a symlink at the staging destination instead of following it', async () => {
    // Regression: a planted symlink at the staging path must not cause the host
    // credential to be written through to whatever the link targets.
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'symphony-stage-'));
    const fakeHome = path.join(tmp, 'home');
    const ws = path.join(tmp, 'ws');
    await mkdir(path.join(fakeHome, '.claude'), { recursive: true });
    await mkdir(path.join(ws, '.git', 'symphony-runtime', 'credentials'), { recursive: true });
    await writeFile(path.join(fakeHome, '.claude', '.credentials.json'), 'HOSTCRED', { mode: 0o600 });
    // Plant a symlink at the staging path pointing at a file in the working tree.
    const target = path.join(ws, 'tracked-file');
    await writeFile(target, 'original');
    await symlink(target, path.join(ws, '.git', 'symphony-runtime', 'credentials', 'claude'));

    const origHome = os.homedir;
    (os as { homedir: () => string }).homedir = () => fakeHome;
    try {
      const staged = await stageCredential(ws, ADAPTERS.claude);
      const lst = await lstat(staged.absPath);
      assert.equal(lst.isSymbolicLink(), false);
      assert.equal(lst.isFile(), true);
      assert.equal(await readFile(staged.absPath, 'utf8'), 'HOSTCRED');
      // The link target was NOT overwritten with the cred.
      assert.equal(await readFile(target, 'utf8'), 'original');
    } finally {
      (os as { homedir: () => string }).homedir = origHome;
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('refuses to stage through a symlinked parent directory', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'symphony-stage-'));
    const fakeHome = path.join(tmp, 'home');
    const ws = path.join(tmp, 'ws');
    await mkdir(path.join(fakeHome, '.claude'), { recursive: true });
    await mkdir(path.join(ws, '.git'), { recursive: true });
    await writeFile(path.join(fakeHome, '.claude', '.credentials.json'), 'HOSTCRED', { mode: 0o600 });
    const escape = path.join(tmp, 'outside');
    await mkdir(escape, { recursive: true });
    // Plant .git/symphony-runtime as a symlink to a dir outside the workspace.
    await symlink(escape, path.join(ws, '.git', 'symphony-runtime'));

    const origHome = os.homedir;
    (os as { homedir: () => string }).homedir = () => fakeHome;
    try {
      await assert.rejects(
        () => stageCredential(ws, ADAPTERS.claude),
        /refusing to write symphony-runtime through a symlink/,
      );
    } finally {
      (os as { homedir: () => string }).homedir = origHome;
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('refuses when .git is something other than dir/file (e.g. a symlink)', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'symphony-stage-'));
    const fakeHome = path.join(tmp, 'home');
    const ws = path.join(tmp, 'ws');
    await mkdir(path.join(fakeHome, '.claude'), { recursive: true });
    await mkdir(ws, { recursive: true });
    await writeFile(path.join(fakeHome, '.claude', '.credentials.json'), '{}', { mode: 0o600 });
    const elsewhere = path.join(tmp, 'something-else');
    await mkdir(elsewhere, { recursive: true });
    await symlink(elsewhere, path.join(ws, '.git'));

    const origHome = os.homedir;
    (os as { homedir: () => string }).homedir = () => fakeHome;
    try {
      await assert.rejects(
        () => stageCredential(ws, ADAPTERS.claude),
        /neither a directory nor a file/,
      );
    } finally {
      (os as { homedir: () => string }).homedir = origHome;
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe('validateDispatch + acp.command', () => {
  it('passes when acp.command is null and adapter is known', () => {
    const cfg = bareCfg({ adapter: 'claude', command: null });
    // tracker.root must exist to pass; create a temp dir.
    return mkdtemp(path.join(os.tmpdir(), 'symphony-vd-')).then(async (root) => {
      cfg.tracker.root = root;
      assert.equal(validateDispatch(cfg), null);
      await rm(root, { recursive: true, force: true });
    });
  });

  it('rejects when acp.command is null and adapter is unknown', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'symphony-vd-'));
    try {
      const cfg = bareCfg({ adapter: 'opencode', command: null });
      cfg.tracker.root = root;
      const err = validateDispatch(cfg);
      assert.ok(err, 'expected validation error');
      assert.match(err!, /opencode/);
      assert.match(err!, /set acp\.command to override/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('passes when acp.command is set for an unknown adapter (override path)', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'symphony-vd-'));
    try {
      const cfg = bareCfg({ adapter: 'opencode', command: 'opencode acp' });
      cfg.tracker.root = root;
      assert.equal(validateDispatch(cfg), null);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects empty acp.command when explicitly set', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'symphony-vd-'));
    try {
      const cfg = bareCfg({ adapter: 'claude', command: '   ' });
      cfg.tracker.root = root;
      const err = validateDispatch(cfg);
      assert.match(err ?? '', /acp\.command must be non-empty when set/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
