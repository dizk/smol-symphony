import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, stat, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  ADAPTERS,
  isKnownAdapter,
  deriveAcpCommand,
  stageRuntimeFile,
  stageCodexPlaceholderAuth,
} from '../src/agent/adapters.js';
import { validateDispatch } from '../src/workflow.js';
import { validateDispatchIo } from '../src/workflow-loader.js';
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
      memory_admission_enabled: false,
      host_memory_reserve_mib: 2048,
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
    states,
  } as ServiceConfig;
}

describe('adapters registry', () => {
  it('exposes claude and codex profiles', () => {
    assert.ok(ADAPTERS.claude);
    assert.deepEqual(ADAPTERS.claude.binary, ['claude-agent-acp']);
    assert.ok(ADAPTERS.codex);
    assert.deepEqual(ADAPTERS.codex.binary, ['codex-acp']);
  });

  it('declares the per-adapter credential strategy the runner dispatches on', () => {
    // The runner keys credential handling on `credentialStrategy`, not on `id`
    // (issue #115/#116). Both claude and codex now route through the host
    // credential proxy. A 'forward-env' adapter must NOT crash-loop when the
    // proxy is unwired — it just proceeds; none ship today.
    assert.equal(ADAPTERS.claude.credentialStrategy, 'proxy');
    assert.equal(ADAPTERS.codex.credentialStrategy, 'proxy');
  });

  it('proxy adapters declare the VM-facing base-URL + token env var names', () => {
    // applyCredentialEnv stages reg.baseUrl/sentinel under these names so the
    // in-VM client dials the proxy with the sentinel as its bearer (issue #116).
    assert.deepEqual(ADAPTERS.claude.proxyEnv, {
      baseUrlVar: 'ANTHROPIC_BASE_URL',
      tokenVar: 'ANTHROPIC_AUTH_TOKEN',
    });
    assert.deepEqual(ADAPTERS.codex.proxyEnv, {
      baseUrlVar: 'OPENAI_BASE_URL',
      tokenVar: 'OPENAI_API_KEY',
    });
  });

  it('isKnownAdapter narrows on supported ids only', () => {
    assert.equal(isKnownAdapter('claude'), true);
    assert.equal(isKnownAdapter('codex'), true);
    assert.equal(isKnownAdapter('opencode'), false);
    assert.equal(isKnownAdapter('unknown'), false);
    assert.equal(isKnownAdapter(''), false);
  });

  it('deriveAcpCommand with no extra files just execs the in-VM proxy', () => {
    // Credentials no longer cross the boundary: the in-VM proxy reads its config
    // (SYMPHONY_ACP_URL/TOKEN/ADAPTER_BIN/ADAPTER_ARGS) from the environment
    // symphony sets on the `smolvm exec` invocation and the credential proxy
    // mints a per-VM sentinel for the bearer. So with no extra files staged the
    // command is literally just `exec node /opt/symphony/vm-agent.mjs`.
    const cmd = deriveAcpCommand(ADAPTERS.claude);
    assert.equal(cmd, 'exec node /opt/symphony/vm-agent.mjs');
    assert.doesNotMatch(cmd, /SYMPHONY_/);
    assert.doesNotMatch(cmd, /\.credentials\.json/);
  });

  it('deriveAcpCommand for codex also just execs the proxy (no credential staging)', () => {
    // codex routes through the host credential proxy (sentinel + OPENAI_BASE_URL);
    // it stages no identity file, so nothing crosses the boundary either.
    const cmd = deriveAcpCommand(ADAPTERS.codex);
    assert.equal(cmd, 'exec node /opt/symphony/vm-agent.mjs');
  });

  it('deriveAcpCommand quotes every token (no shell injection via profile)', () => {
    const evil = {
      id: 'claude' as const,
      // Imagine a future profile with multi-token launch + a metacharacter slipping in.
      binary: ['opencode', 'acp', '; rm -rf /'] as const,
      credentialStrategy: 'proxy' as const,
      modelInjection: () => ({}),
    };
    const cmd = deriveAcpCommand(evil);
    // The adapter binary + args don't appear in the bash command at all under the TCP
    // architecture — they're passed via env on the smolvm-exec call, where the values
    // are argv to `smolvm` rather than substituted into a shell. The command must end
    // exactly at the proxy exec; nothing the profile contributes lands in the shell.
    assert.match(cmd, /exec node \/opt\/symphony\/vm-agent\.mjs$/);
    assert.doesNotMatch(cmd, /opencode/);
    assert.doesNotMatch(cmd, /rm -rf \//);
  });

  it('deriveAcpCommand throws on an empty binary vector', () => {
    assert.throws(
      () =>
        deriveAcpCommand({
          id: 'claude',
          binary: [],
          credentialStrategy: 'proxy',
          modelInjection: () => ({}),
        }),
      /empty binary launch vector/,
    );
  });

  it('deriveAcpCommand copies the claude identity file before exec', () => {
    // The minimal ~/.claude.json identity (oauthAccount UUIDs only) is staged
    // by stageClaudeIdentity and copied to /root/.claude.json before the proxy
    // execs the adapter. The order matters: the staged file must land before
    // `exec` replaces the shell.
    const cmd = deriveAcpCommand(ADAPTERS.claude, [
      {
        stagedRelPath: '.git/symphony-runtime/identity/claude.json',
        guestPath: '/root/.claude.json',
      },
    ]);
    assert.match(
      cmd,
      /cp \.git\/symphony-runtime\/identity\/claude\.json \/root\/\.claude\.json/,
    );
    // No credential file appears anywhere — credentials never enter the VM.
    assert.doesNotMatch(cmd, /\.credentials\.json/);
    // Still ends with the proxy exec — extra cp lines are inserted before, not after.
    assert.match(cmd, /exec node \/opt\/symphony\/vm-agent\.mjs$/);
    // Sanity: the cp precedes exec.
    const cpIdx = cmd.indexOf('cp ');
    const execIdx = cmd.indexOf('exec node');
    assert.ok(cpIdx > 0 && cpIdx < execIdx, 'extra cp must precede exec');
  });

  it('deriveAcpCommand emits a mkdir -p for each extra file destination directory', () => {
    const cmd = deriveAcpCommand(ADAPTERS.claude, [
      {
        stagedRelPath: '.git/symphony-runtime/runtime/claude-settings.json',
        guestPath: '/root/.claude/settings.json',
      },
    ]);
    assert.match(cmd, /mkdir -p \/root\/\.claude/);
    assert.match(
      cmd,
      /cp \.git\/symphony-runtime\/runtime\/claude-settings\.json \/root\/\.claude\/settings\.json/,
    );
    assert.match(cmd, /chmod 600 \/root\/\.claude\/settings\.json/);
    assert.match(cmd, /exec node \/opt\/symphony\/vm-agent\.mjs$/);
  });

  it('deriveAcpCommand shell-quotes paths defensively', () => {
    const cmd = deriveAcpCommand(ADAPTERS.claude, [
      {
        stagedRelPath: 'has spaces/identity.json',
        guestPath: '/root/.claude.json',
      },
    ]);
    // shQuote single-quotes anything outside [A-Za-z0-9_\-./], so the space-containing
    // path becomes one safe token in the cp argument.
    assert.match(cmd, /cp 'has spaces\/identity\.json'/);
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
    // Adapter-prefixed name keeps the staging-dir namespace partitioned.
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

describe('stageRuntimeFile', () => {
  it('writes content into runtime/ subdir under .git/symphony-runtime/, 0600', async () => {
    // Runtime files (e.g. claude's settings.json for effortLevel) land under the
    // `runtime/` subdir, separate from the `identity/` subdir for stageClaudeIdentity.
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'symphony-stage-runtime-'));
    const ws = path.join(tmp, 'ws');
    await mkdir(path.join(ws, '.git'), { recursive: true });
    try {
      const staged = await stageRuntimeFile(ws, 'claude-settings.json', '{"effortLevel":"xhigh"}');
      assert.equal(
        staged.relPath,
        '.git/symphony-runtime/runtime/claude-settings.json',
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

describe('stageCodexPlaceholderAuth', () => {
  it('stages a FAKE auth.json — no real token, no OAuth tokens block, no refresh_token', async () => {
    // codex-acp's session-init credential check requires ~/.codex/auth.json to
    // EXIST (it fails "Authentication required" with only the env sentinel). The
    // placeholder satisfies that check WITHOUT carrying a real credential: codex
    // then uses the env OPENAI_API_KEY sentinel as its bearer and the proxy
    // substitutes the real token. This test locks the "no real secret in the VM"
    // invariant (live-verified on issue 120: codex reviewed through the proxy
    // with this placeholder; 17 codex upstream calls, Review→Done).
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'symphony-stage-codex-'));
    const ws = path.join(tmp, 'ws');
    await mkdir(path.join(ws, '.git'), { recursive: true });
    try {
      const staged = await stageCodexPlaceholderAuth(ws);
      assert.equal(staged.relPath, '.git/symphony-runtime/credential/auth.json');
      const body = await readFile(staged.absPath, 'utf8');
      const parsed = JSON.parse(body) as Record<string, unknown>;
      assert.equal(parsed.auth_mode, 'apikey');
      // No OAuth tokens block at all → no access_token / id_token / refresh_token.
      assert.equal(parsed.tokens, undefined);
      // Whatever the OPENAI_API_KEY placeholder is, it must not be a real key:
      // the env sentinel (precedence) is the bearer the proxy actually validates.
      assert.match(String(parsed.OPENAI_API_KEY), /placeholder/);
      assert.doesNotMatch(body, /refresh_token/);
      const st = await stat(staged.absPath);
      assert.equal(st.mode & 0o777, 0o600);
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
    // smolfile existence is an fs probe; structural validateDispatch returns
    // null and the loader-side validateDispatchIo surfaces the missing-file
    // error.
    const root = await mkdtemp(path.join(os.tmpdir(), 'symphony-vd-'));
    try {
      const cfg = bareCfg({ adapter: 'claude' });
      cfg.tracker.root = root;
      cfg.smolvm.smolfile = path.join(root, 'no-such-Smolfile');
      assert.equal(validateDispatch(cfg), null);
      const err = validateDispatchIo(cfg);
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
      assert.equal(validateDispatchIo(cfg), null);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
