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
  stageRuntimeFile,
} from '../src/agent/adapters.js';
import { validateDispatch } from '../src/workflow.js';
import type { ServiceConfig } from '../src/types.js';

function bareCfg(over: Partial<ServiceConfig['acp']> = {}): ServiceConfig {
  const states: ServiceConfig['states'] = {
    Todo: { role: 'active' },
    Done: { role: 'terminal' },
    Triage: { role: 'holding' },
  };
  return {
    workflow_path: '/tmp/WORKFLOW.md',
    workflow_dir: '/tmp',
    tracker: {
      kind: 'local',
      states,
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
      model: null,
      effort: null,
      shell: 'bash',
      prompt_timeout_ms: 1000,
      read_timeout_ms: 1000,
      stall_timeout_ms: 1000,
      bridge: {
        bind_host: '0.0.0.0',
        bind_port: 8788,
        reach_host: '127.0.0.1',
        reach_url: null,
        connect_timeout_ms: 30_000,
      },
      ...over,
    },
    smolvm: {
      image: null,
      from: null,
      smolfile: null,
      cpus: 1,
      mem_mib: 256,
      // The TCP bridge needs the VM to reach the host listener; validateDispatch refuses
      // `net: false` under the bridge transport.
      net: true,
      volumes: [],
      forward_env: [],
      endpoint: 'unix:///tmp/sock',
    },
    server: { port: null, host: '127.0.0.1' },
    mcp: { enabled: true, host: '10.0.2.2', explicit_host_url: null },
    integration: { branch: 'integration', conflict_state: 'Conflict', merge_on_states: [] },
    states,
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

  it('deriveAcpCommand emits a scrub-copy-proxy pipeline using the supplied staged path', () => {
    const cmd = deriveAcpCommand(ADAPTERS.claude, '.git/symphony-runtime/credentials/claude');
    // Scrub MUST come before mkdir+cp so any state baked into the VM image (e.g. from
    // `claude --version` running during the build's verification step) is gone before we
    // re-stage.
    assert.match(cmd, /^rm -rf \/root\/\.claude && mkdir -p \/root\/\.claude/);
    assert.match(cmd, /cp \.git\/symphony-runtime\/credentials\/claude \/root\/\.claude\/\.credentials\.json/);
    assert.match(cmd, /chmod 600 \/root\/\.claude\/\.credentials\.json/);
    // The adapter is launched indirectly via the in-VM proxy. The proxy reads its config
    // (SYMPHONY_ACP_URL/TOKEN/ADAPTER_BIN/ADAPTER_ARGS) from the environment symphony
    // sets on the `smolvm exec` invocation — NOT inline in the bash command — so the
    // command itself is identical across adapters and avoids leaking the per-dispatch
    // token into `ps`-visible argv.
    assert.match(cmd, /exec node \/opt\/symphony\/vm-agent\.mjs$/);
    assert.doesNotMatch(cmd, /SYMPHONY_/);
  });

  it('deriveAcpCommand for codex scrubs codex state dir then execs the same proxy', () => {
    const cmd = deriveAcpCommand(ADAPTERS.codex, '.git/symphony-runtime/credentials/codex');
    assert.match(cmd, /^rm -rf \/root\/\.codex && mkdir -p \/root\/\.codex/);
    assert.match(cmd, /cp \.git\/symphony-runtime\/credentials\/codex \/root\/\.codex\/auth\.json/);
    assert.match(cmd, /exec node \/opt\/symphony\/vm-agent\.mjs$/);
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
    // The adapter binary + args don't appear in the bash command at all under the TCP
    // architecture — they're passed via env on the smolvm-exec call, where the values
    // are argv to `smolvm` rather than substituted into a shell. The command must end
    // exactly at the proxy exec; nothing the profile contributes lands in the shell.
    assert.match(cmd, /exec node \/opt\/symphony\/vm-agent\.mjs$/);
    assert.doesNotMatch(cmd, /opencode/);
    assert.doesNotMatch(cmd, /rm -rf \/'/);
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

  it('deriveAcpCommand copies extra staged files (e.g. claude settings.json) before exec', () => {
    // Effort flows through a settings.json staged next to the credential, then copied
    // to /root/.claude/settings.json before the proxy execs the adapter. The order
    // matters: the staged file must land before `exec` replaces the shell.
    const cmd = deriveAcpCommand(
      ADAPTERS.claude,
      '.git/symphony-runtime/credentials/claude',
      [
        {
          stagedRelPath: '.git/symphony-runtime/credentials/claude-settings.json',
          guestPath: '/root/.claude/settings.json',
        },
      ],
    );
    assert.match(
      cmd,
      /cp \.git\/symphony-runtime\/credentials\/claude-settings\.json \/root\/\.claude\/settings\.json/,
    );
    // settings.json sits in the same guestDir as the credential; deriveAcpCommand
    // skips an extra mkdir for that case.
    assert.doesNotMatch(cmd, /mkdir -p \/root\/\.claude && mkdir -p \/root\/\.claude/);
    // Still ends with the proxy exec — extra cp lines are inserted before, not after.
    assert.match(cmd, /exec node \/opt\/symphony\/vm-agent\.mjs$/);
    // Sanity: the extra copy precedes exec.
    const cpIdx = cmd.indexOf('settings.json');
    const execIdx = cmd.indexOf('exec node');
    assert.ok(cpIdx > 0 && cpIdx < execIdx, 'extra cp must precede exec');
  });

  it('deriveAcpCommand emits an extra mkdir when an extra file targets a different guestDir', () => {
    const cmd = deriveAcpCommand(
      ADAPTERS.claude,
      '.git/symphony-runtime/credentials/claude',
      [
        {
          stagedRelPath: '.git/symphony-runtime/credentials/other',
          guestPath: '/etc/some/other.conf',
        },
      ],
    );
    assert.match(cmd, /mkdir -p \/etc\/some/);
    assert.match(cmd, /cp \.git\/symphony-runtime\/credentials\/other \/etc\/some\/other\.conf/);
  });

  it('claude profile surfaces the selected model via ANTHROPIC_MODEL env', () => {
    // claude-agent-acp reads ANTHROPIC_MODEL on startup and resolves it against the SDK
    // model list. Env-based selection avoids per-attempt argv leaks (model isn't a
    // secret, but ANTHROPIC_MODEL is the documented mechanism).
    const inj = ADAPTERS.claude.modelInjection('claude-opus-4-7');
    assert.deepEqual(inj, { env: { ANTHROPIC_MODEL: 'claude-opus-4-7' } });
    assert.equal(inj.extraArgs, undefined);
  });

  it('codex profile surfaces the selected model via -c model="..." argv', () => {
    // codex-acp takes `-c key=value` where value is parsed as TOML; we emit a JSON-
    // quoted string so model names with dots/hyphens are unambiguously TOML strings.
    const inj = ADAPTERS.codex.modelInjection('gpt-5-codex');
    assert.deepEqual(inj, { extraArgs: ['-c', 'model="gpt-5-codex"'] });
    assert.equal(inj.env, undefined);
  });

  it('codex modelInjection escapes embedded quotes so the TOML value stays well-formed', () => {
    // A pathological model id with a double-quote would break a naive `model="..."`
    // concatenation. JSON.stringify handles it; verify defensively.
    const inj = ADAPTERS.codex.modelInjection('weird"name');
    assert.deepEqual(inj, { extraArgs: ['-c', 'model="weird\\"name"'] });
  });

  it('claude profile surfaces effort via a staged settings.json (not env, not argv)', () => {
    // claude-agent-acp reads effortLevel only out of merged settings (the SDK's
    // resolveSettings reads $CLAUDE_CONFIG_DIR/settings.json + cwd .claude/settings.json
    // + platform managed-settings). There is no ANTHROPIC_EFFORT env and no CLI flag
    // on the ACP wrapper; staging a settings.json is the only reachable channel.
    const inj = ADAPTERS.claude.effortInjection!('xhigh');
    assert.equal(inj.env, undefined);
    assert.equal(inj.extraArgs, undefined);
    assert.ok(inj.stagedFiles, 'expected stagedFiles');
    assert.equal(inj.stagedFiles!.length, 1);
    const f = inj.stagedFiles![0]!;
    assert.equal(f.guestPath, '/root/.claude/settings.json');
    assert.deepEqual(JSON.parse(f.content), { effortLevel: 'xhigh' });
    // Adapter-prefixed name keeps the staging-dir namespace partitioned: the
    // credential file is named after the adapter id, so collisions are avoided.
    assert.match(f.stagedName, /^claude-/);
  });

  it('codex profile does not expose an effortInjection (no native effort knob)', () => {
    // codex-acp does not surface a generic effort lever on the wrapper today.
    // The runner skips effort wiring entirely when this is undefined, so an
    // operator who sets acp.effort under a codex-backed state still dispatches
    // cleanly — symphony just doesn't inject anything.
    assert.equal(ADAPTERS.codex.effortInjection, undefined);
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
    // negation can still expose the secret. Refuse loudly; linked worktrees
    // are unsupported under the TCP bridge transport.
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

describe('stageRuntimeFile', () => {
  it('writes content into the same staging dir as the credential, 0600', async () => {
    // Effort's settings.json staging mirrors the credential's defenses:
    // resolveStagingLocation picks .git/symphony-runtime/credentials/ inside a
    // normal git clone, and the symlink-replace dance prevents writing through
    // an attacker-planted leaf symlink.
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'symphony-stage-runtime-'));
    const ws = path.join(tmp, 'ws');
    await mkdir(path.join(ws, '.git'), { recursive: true });
    try {
      const staged = await stageRuntimeFile(ws, 'claude-settings.json', '{"effortLevel":"xhigh"}');
      assert.equal(
        staged.relPath,
        '.git/symphony-runtime/credentials/claude-settings.json',
      );
      const body = await readFile(staged.absPath, 'utf8');
      assert.equal(body, '{"effortLevel":"xhigh"}');
      const st = await stat(staged.absPath);
      assert.equal(st.mode & 0o777, 0o600);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('rejects a stagedName containing path separators or shell metachars', async () => {
    // Defense in depth: stagedName composes into a host path, then into the
    // POSIX-relative path baked into the bash command. Refuse anything outside
    // [A-Za-z0-9._-] so a future caller cannot escape the staging dir or
    // smuggle shell metacharacters through the rel path.
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'symphony-stage-runtime-'));
    const ws = path.join(tmp, 'ws');
    await mkdir(path.join(ws, '.git'), { recursive: true });
    try {
      await assert.rejects(() => stageRuntimeFile(ws, '../escape', 'x'), /stagedName/);
      await assert.rejects(() => stageRuntimeFile(ws, 'with space', 'x'), /stagedName/);
      await assert.rejects(() => stageRuntimeFile(ws, 'pipe|cmd', 'x'), /stagedName/);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe('validateDispatch', () => {
  it('passes when adapter is known and local tracker root exists', () => {
    const cfg = bareCfg({ adapter: 'claude' });
    // tracker.root must exist to pass; create a temp dir.
    return mkdtemp(path.join(os.tmpdir(), 'symphony-vd-')).then(async (root) => {
      cfg.tracker.root = root;
      assert.equal(validateDispatch(cfg), null);
      await rm(root, { recursive: true, force: true });
    });
  });

  it('rejects when adapter is unknown', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'symphony-vd-'));
    try {
      const cfg = bareCfg({ adapter: 'opencode' });
      cfg.tracker.root = root;
      const err = validateDispatch(cfg);
      assert.ok(err, 'expected validation error');
      assert.match(err!, /opencode/);
      assert.match(err!, /known profile/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects smolvm.net=false (in-VM proxy must reach the bridge)', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'symphony-vd-'));
    try {
      const cfg = bareCfg({ adapter: 'claude' });
      cfg.tracker.root = root;
      cfg.smolvm.net = false;
      const err = validateDispatch(cfg);
      assert.ok(err, 'expected validation error');
      assert.match(err!, /smolvm\.net=false is incompatible/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects setting both smolvm.image and smolvm.smolfile (mutually exclusive)', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'symphony-vd-'));
    try {
      const cfg = bareCfg({ adapter: 'claude' });
      cfg.tracker.root = root;
      cfg.smolvm.image = 'node:24-bookworm-slim';
      cfg.smolvm.smolfile = '/nonexistent/Smolfile';
      const err = validateDispatch(cfg);
      assert.ok(err, 'expected validation error');
      assert.match(err!, /set at most one of image \/ from \/ smolfile/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects smolvm.smolfile pointing at a missing file', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'symphony-vd-'));
    try {
      const cfg = bareCfg({ adapter: 'claude' });
      cfg.tracker.root = root;
      cfg.smolvm.smolfile = path.join(root, 'no-such-Smolfile');
      const err = validateDispatch(cfg);
      assert.ok(err, 'expected validation error');
      assert.match(err!, /smolvm\.smolfile not found/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('accepts smolvm.smolfile when the file exists', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'symphony-vd-'));
    try {
      const cfg = bareCfg({ adapter: 'claude' });
      cfg.tracker.root = root;
      const smolfilePath = path.join(root, 'Smolfile');
      await writeFile(smolfilePath, 'image = "node:24-bookworm-slim"\n');
      cfg.smolvm.smolfile = smolfilePath;
      assert.equal(validateDispatch(cfg), null);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
