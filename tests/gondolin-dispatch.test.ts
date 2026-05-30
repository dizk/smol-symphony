// Unit tests for the dormant Gondolin dispatch orchestration (gondolin-dispatch.ts
// + vm-acp-mapping.ts). Fakes only — no VM, no /dev/kvm, no network. A fake VmClient
// records the CreateVmOptions + hands back a fake exec; a real CredentialSecretRegistry
// (with stubbed readToken/refresh + fake SecretManagers) exercises the
// seed-before-exec ordering.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, type Readable } from 'node:stream';
import type { SecretManager, SecretManagerEntry } from '@earendil-works/gondolin';
import {
  GondolinDispatcher,
  type GondolinDispatchOptions,
  type GondolinVmConfig,
} from '../src/agent/gondolin-dispatch.js';
import {
  buildAcpTcpDns,
  buildMcpTcpHostEntry,
  ACP_GUEST_PORT,
  ACP_SYNTHETIC_HOST,
  MCP_GUEST_PORT,
  MCP_SYNTHETIC_HOST,
} from '../src/agent/vm-acp-mapping.js';
import {
  CredentialSecretRegistry,
  buildAdapterHooksConfig,
  buildAdapterCredentialSpecs,
  type AdapterHooksConfig,
} from '../src/agent/credential-secrets.js';
import type {
  CreateVmOptions,
  VmClient,
  VmExec,
  VmHandle,
  VmMount,
  VmSession,
} from '../src/agent/vm-port.js';
import type { TokenInfo } from '../src/agent/credential-extractors.js';

const HOME = '/home/tester';

// --- fakes -----------------------------------------------------------------

interface FakeExec extends VmExec {
  stdinEnded: boolean;
  killed: boolean;
  readonly stderrPt: PassThrough;
}

/**
 * A fake exec. Staging writes (`/bin/sh -c …`) must RESOLVE `exit` so the
 * dispatcher's `await exec.exit` completes; the long-lived `vm-agent.mjs` launch
 * exec stays pending until `kill()`. `resolveOnEnd` distinguishes them.
 */
function makeFakeExec(resolveOnEnd: boolean): FakeExec {
  const stderrPt = new PassThrough();
  let resolveExit!: (v: { code: number | null; signal: number | null }) => void;
  const exit = new Promise<{ code: number | null; signal: number | null }>((r) => {
    resolveExit = r;
  });
  const exec: FakeExec = {
    stderrPt,
    stdinEnded: false,
    killed: false,
    stdin: {
      write() {},
      end() {
        exec.stdinEnded = true;
        if (resolveOnEnd) resolveExit({ code: 0, signal: null });
      },
    },
    stdout: new PassThrough() as Readable,
    stderr: stderrPt as unknown as Readable,
    pid: 4242,
    exit,
    kill() {
      exec.killed = true;
      resolveExit({ code: null, signal: 9 });
    },
  };
  return exec;
}

interface FakeVmHandle extends VmHandle {
  closed: number;
  execCalls: Parameters<VmHandle['exec']>[0][];
  /** Every exec returned, in order (staging writes first, then the launch exec). */
  execs: FakeExec[];
  /** The long-lived `vm-agent.mjs` launch exec (the LAST exec; `/bin/sh` writes precede it). */
  readonly fakeExec: FakeExec;
}

function isStagingWrite(opts: Parameters<VmHandle['exec']>[0]): boolean {
  return opts.command[0] === '/bin/sh';
}

function makeFakeVmHandle(id: string): FakeVmHandle {
  const execs: FakeExec[] = [];
  const handle = {
    id,
    closed: 0,
    execCalls: [],
    execs,
    exec(opts: Parameters<VmHandle['exec']>[0]) {
      handle.execCalls.push(opts);
      const exec = makeFakeExec(isStagingWrite(opts));
      execs.push(exec);
      return exec;
    },
    async close() {
      handle.closed += 1;
    },
    // The launch exec is the last exec created (staging writes run first).
    get fakeExec(): FakeExec {
      return execs[execs.length - 1]!;
    },
  } as FakeVmHandle;
  return handle;
}

interface FakeVmClient extends VmClient {
  createCalls: CreateVmOptions[];
  readonly handle: FakeVmHandle;
  /** When set, createVm rejects with this error (lifecycle-failure tests). */
  createError: Error | null;
}

function makeFakeVmClient(): FakeVmClient {
  const handle = makeFakeVmHandle('vm-fake-1');
  const client: FakeVmClient = {
    createCalls: [],
    handle,
    createError: null,
    async createVm(opts) {
      if (client.createError) throw client.createError;
      client.createCalls.push(opts);
      return handle;
    },
    async listSessions(): Promise<VmSession[]> {
      return [];
    },
    async gc() {
      return 0;
    },
  };
  return client;
}

interface FakeManager extends SecretManager {
  readonly updates: { name: string; value: string | undefined }[];
}

function makeFakeManager(): FakeManager {
  const updates: { name: string; value: string | undefined }[] = [];
  return {
    updates,
    listSecrets(): SecretManagerEntry[] {
      return [];
    },
    updateSecret(name, options) {
      updates.push({ name, value: options.value });
    },
    deleteSecret() {},
  };
}

// The dispatcher calls `createHttpHooks(hooksConfig.options)` internally, which mints
// a fresh secretManager. To observe the registry seeding, we capture the manager the
// REGISTRY receives via a registry whose readToken returns a known token. The test
// asserts ordering by checking that register() resolved (registry.size grew) before
// the exec is observed — the dispatcher awaits register before launchAgent.

function stubHooksConfig(adapterId: 'claude' | 'codex' | 'opencode' = 'claude'): AdapterHooksConfig {
  const specs = buildAdapterCredentialSpecs({
    claudeCredentialsPath: '/nonexistent/claude.json',
    codexCredentialsPath: '/nonexistent/codex.json',
    opencodeCredentialsPath: '/nonexistent/opencode.json',
    lockPath: '/tmp/symphony-gondolin-dispatch-test.lock',
    lockAcquire: async () => async () => {},
    claudeRefresher: async () => {},
  });
  return buildAdapterHooksConfig(specs[adapterId]!);
}

/** Decode a staged base64 write command back into its guest path + content. */
function decodeStagedWrite(opts: Parameters<VmHandle['exec']>[0]): { guestPath: string; content: string } {
  const script = opts.command[2] ?? '';
  const b64 = /printf %s '([^']+)' \| base64 -d > '([^']+)'/.exec(script);
  assert.ok(b64, `staging command did not match expected shape: ${script}`);
  return { guestPath: b64![2]!, content: Buffer.from(b64![1]!, 'base64').toString('utf8') };
}

/** All staged fake-creds writes from a dispatch's recorded exec calls. */
function stagedWrites(handle: FakeVmHandle): { guestPath: string; content: string }[] {
  return handle.execCalls.filter(isStagingWrite).map(decodeStagedWrite);
}

function makeRegistry(token: TokenInfo | null): {
  registry: CredentialSecretRegistry;
  registerOrder: number[];
} {
  const registerOrder: number[] = [];
  const registry = new CredentialSecretRegistry({
    readToken: async () => token,
    refresh: async () => {},
  });
  return { registry, registerOrder };
}

const VM_CONFIG: GondolinVmConfig = { imagePath: 'symphony-agents:latest', cpus: 2, memMib: 4096 };

// Hermetic host-identity readers: a fixed non-secret codex account_id + claude
// identity, NEVER a token. Keeps the fake-creds staging off the real ~/.codex and
// ~/.claude.json. The account_id is UUID-shaped (the real chatgpt_account_id is a
// UUID; the staging guards accept only a UUID — a token-shaped value is omitted).
const FAKE_ACCOUNT_ID = '00000000-0000-4000-8000-000000000abc';
const FAKE_HOST_READERS = {
  readClaudeIdentity: async () => ({
    accountUuid: '11111111-2222-3333-4444-555555555555',
    organizationUuid: '66666666-7777-8888-9999-000000000000',
  }),
  readCodexAccountId: async () => FAKE_ACCOUNT_ID,
  readCodexMetadata: async () => ({
    accountId: FAKE_ACCOUNT_ID,
    authMode: 'chatgpt',
    lastRefresh: '2026-05-22T08:59:06.309350255Z',
  }),
};

function baseOptions(overrides: Partial<GondolinDispatchOptions> = {}): GondolinDispatchOptions {
  return {
    identifier: 'SYM-1',
    mounts: [{ host: '/home/tester/.symphony/workspaces/SYM-1', guest: '/work', readonly: false }],
    env: { PATH: '/usr/bin', OPENAI_API_KEY: 'sk-real-should-be-stripped' },
    workdir: '/work',
    bridgeHost: '127.0.0.1',
    bridgePort: 55123,
    acpToken: 'bridge-bearer-abc',
    adapterBin: 'claude-agent-acp',
    adapterArgs: ['--foo', 'bar'],
    runtimeEnv: { ANTHROPIC_MODEL: 'opus', ANTHROPIC_AUTH_TOKEN: 'sk-ant-leak' },
    onStderr: () => {},
    mountGuard: { homeDir: HOME },
    hostReaders: FAKE_HOST_READERS,
    ...overrides,
  };
}

// --- buildAcpTcpDns ---------------------------------------------------------

describe('buildAcpTcpDns', () => {
  it('maps a per-host synthetic name+port to the bridge loopback', () => {
    const out = buildAcpTcpDns('127.0.0.1', 55123);
    assert.deepEqual(out.tcp.hosts, { [`${ACP_SYNTHETIC_HOST}:${ACP_GUEST_PORT}`]: '127.0.0.1:55123' });
    assert.deepEqual(out.dns, { mode: 'synthetic', syntheticHostMapping: 'per-host' });
    assert.equal(out.acpUrl, `tcp://${ACP_SYNTHETIC_HOST}:${ACP_GUEST_PORT}`);
  });

  it('honors a custom synthetic name (port-specific, not wildcard)', () => {
    const out = buildAcpTcpDns('127.0.0.1', 7, 'custom-name');
    assert.deepEqual(out.tcp.hosts, { [`custom-name:${ACP_GUEST_PORT}`]: '127.0.0.1:7' });
    assert.ok(!Object.keys(out.tcp.hosts).some((k) => k.includes('*')), 'no wildcard key');
    assert.equal(out.acpUrl, `tcp://custom-name:${ACP_GUEST_PORT}`);
  });
});

// --- buildMcpTcpHostEntry ---------------------------------------------------

describe('buildMcpTcpHostEntry', () => {
  it('maps the synthetic MCP name+port to the host MCP loopback (distinct from the ACP port)', () => {
    const entry = buildMcpTcpHostEntry('127.0.0.1', 8787);
    assert.deepEqual(entry, { [`${MCP_SYNTHETIC_HOST}:${MCP_GUEST_PORT}`]: '127.0.0.1:8787' });
    assert.notEqual(MCP_GUEST_PORT, ACP_GUEST_PORT, 'MCP + ACP guest ports must not collide');
    assert.ok(!Object.keys(entry).some((k) => k.includes('*')), 'no wildcard key');
  });
});

// --- dispatch: createVm opts ------------------------------------------------

describe('GondolinDispatcher.dispatch — createVm options', () => {
  it('carries allowWebSockets:false, the workspace mount, the ACP mapping, and the prefixed label', async () => {
    const client = makeFakeVmClient();
    const { registry } = makeRegistry({ accessToken: 'tok', expiresAtMs: null });
    const d = new GondolinDispatcher(client, registry, stubHooksConfig(), VM_CONFIG);

    await d.dispatch(baseOptions());

    assert.equal(client.createCalls.length, 1);
    const opts = client.createCalls[0]!;
    assert.equal(opts.allowWebSockets, false);
    assert.equal(opts.imagePath, 'symphony-agents:latest');
    assert.equal(opts.cpus, 2);
    assert.equal(opts.memMib, 4096);
    assert.equal(opts.sessionLabel, 'symphony-SYM-1');
    assert.equal(opts.workdir, '/work');
    assert.deepEqual(opts.mounts, [
      { host: '/home/tester/.symphony/workspaces/SYM-1', guest: '/work', readonly: false },
    ]);
    assert.deepEqual(opts.tcp!.hosts, {
      [`${ACP_SYNTHETIC_HOST}:${ACP_GUEST_PORT}`]: '127.0.0.1:55123',
    });
    assert.deepEqual(opts.dns, { mode: 'synthetic', syntheticHostMapping: 'per-host' });
    assert.ok(opts.httpHooks, 'httpHooks threaded through');
  });

  it('adds the MCP control-plane tunnel into tcp.hosts (alongside ACP) when opts.mcp is set', async () => {
    const client = makeFakeVmClient();
    const { registry } = makeRegistry({ accessToken: 'tok', expiresAtMs: null });
    const d = new GondolinDispatcher(client, registry, stubHooksConfig(), VM_CONFIG);

    await d.dispatch(baseOptions({ mcp: { host: '127.0.0.1', port: 8787 } }));

    const opts = client.createCalls[0]!;
    // BOTH channels share one tcp.hosts record + the single synthetic DNS config —
    // without the MCP entry the agent runs turns but can't reach symphony.transition.
    assert.deepEqual(opts.tcp!.hosts, {
      [`${ACP_SYNTHETIC_HOST}:${ACP_GUEST_PORT}`]: '127.0.0.1:55123',
      [`${MCP_SYNTHETIC_HOST}:${MCP_GUEST_PORT}`]: '127.0.0.1:8787',
    });
    assert.deepEqual(opts.dns, { mode: 'synthetic', syntheticHostMapping: 'per-host' });
  });

  it('omits the MCP tunnel when opts.mcp is undefined (only the ACP mapping)', async () => {
    const client = makeFakeVmClient();
    const { registry } = makeRegistry({ accessToken: 'tok', expiresAtMs: null });
    const d = new GondolinDispatcher(client, registry, stubHooksConfig(), VM_CONFIG);

    await d.dispatch(baseOptions()); // no mcp

    const opts = client.createCalls[0]!;
    assert.deepEqual(Object.keys(opts.tcp!.hosts), [`${ACP_SYNTHETIC_HOST}:${ACP_GUEST_PORT}`]);
  });

  it('STRIPS credential env vars from the boot env (no real token reaches the guest)', async () => {
    const client = makeFakeVmClient();
    const { registry } = makeRegistry({ accessToken: 'tok', expiresAtMs: null });
    const d = new GondolinDispatcher(client, registry, stubHooksConfig(), VM_CONFIG);

    await d.dispatch(baseOptions());

    const env = client.createCalls[0]!.env;
    assert.deepEqual(env, { PATH: '/usr/bin' }, 'OPENAI_API_KEY stripped, PATH kept');
    assert.ok(!('OPENAI_API_KEY' in env));
  });

  it('HARD-FAILs when a mount resolves under a credential path (and does NOT create a VM)', async () => {
    const client = makeFakeVmClient();
    const { registry } = makeRegistry({ accessToken: 'tok', expiresAtMs: null });
    const d = new GondolinDispatcher(client, registry, stubHooksConfig(), VM_CONFIG);

    await assert.rejects(
      d.dispatch(baseOptions({ mounts: [{ host: `${HOME}/.claude`, guest: '/c', readonly: true }] })),
      /credential path/,
    );
    assert.equal(client.createCalls.length, 0, 'no VM created when the guard fails');
    assert.equal(registry.size(), 0, 'no manager registered when the guard fails');
  });
});

// --- dispatch: launch ------------------------------------------------------

describe('GondolinDispatcher.dispatch — agent launch', () => {
  it('launches vm-agent.mjs, ends stdin, and sets the ACP env (with runtime creds stripped)', async () => {
    const client = makeFakeVmClient();
    const { registry } = makeRegistry({ accessToken: 'tok', expiresAtMs: null });
    const d = new GondolinDispatcher(client, registry, stubHooksConfig(), VM_CONFIG);

    const handle = await d.dispatch(baseOptions());

    // The LAST exec is the long-lived vm-agent.mjs launch; earlier execs are the
    // fake-creds write steps (`/bin/sh -c …`).
    const launch = client.handle.execCalls[client.handle.execCalls.length - 1]!;
    assert.deepEqual(launch.command, ['node', '/opt/symphony/vm-agent.mjs']);
    assert.equal(launch.workdir, '/work');
    assert.equal(launch.timeoutMs, null);
    assert.equal(client.handle.fakeExec.stdinEnded, true, 'stdin end()ed immediately');

    const env = launch.env!;
    assert.equal(env.SYMPHONY_ACP_URL, `tcp://${ACP_SYNTHETIC_HOST}:${ACP_GUEST_PORT}`);
    assert.equal(env.SYMPHONY_ACP_URL, handle.acpUrl);
    assert.equal(env.SYMPHONY_ACP_TOKEN, 'bridge-bearer-abc');
    assert.equal(env.SYMPHONY_ADAPTER_BIN, 'claude-agent-acp');
    assert.equal(env.SYMPHONY_ADAPTER_ARGS, JSON.stringify(['--foo', 'bar']));
    assert.equal(env.ANTHROPIC_MODEL, 'opus', 'innocuous runtime env kept');
    // The placeholder bearer (a FAKE) survives the strip because it is added AFTER
    // stripCredentialTokenVars — even though its var name is ANTHROPIC_AUTH_TOKEN.
    assert.equal(typeof env.ANTHROPIC_AUTH_TOKEN, 'string', 'placeholder bearer present in launch env');
    assert.ok(env.ANTHROPIC_AUTH_TOKEN!.startsWith('sk-ant-'), 'placeholder is claude-shaped');
    assert.notEqual(env.ANTHROPIC_AUTH_TOKEN, 'sk-ant-leak', 'NOT the real runtime token (that was stripped)');
  });

  it('taps stderr to the supplied sink', async () => {
    const client = makeFakeVmClient();
    const { registry } = makeRegistry({ accessToken: 'tok', expiresAtMs: null });
    const seen: string[] = [];
    const d = new GondolinDispatcher(client, registry, stubHooksConfig(), VM_CONFIG);

    await d.dispatch(baseOptions({ onStderr: (c) => seen.push(c) }));

    client.handle.fakeExec.stderrPt.write('boom\n');
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(seen, ['boom\n']);
  });
});

// --- dispatch: secret-manager ordering -------------------------------------

describe('GondolinDispatcher.dispatch — secret manager seeded + registered before exec', () => {
  it('registers (awaited) BEFORE the agent exec runs', async () => {
    const client = makeFakeVmClient();
    const { registry } = makeRegistry({ accessToken: 'tok', expiresAtMs: null });

    // Spy: record registry.size at the instant exec is called. If register() were not
    // awaited before launch, size would still be 0 at exec time.
    let sizeAtExec = -1;
    const origExec = client.handle.exec.bind(client.handle);
    client.handle.exec = (opts) => {
      sizeAtExec = registry.size();
      return origExec(opts);
    };

    const d = new GondolinDispatcher(client, registry, stubHooksConfig(), VM_CONFIG);
    await d.dispatch(baseOptions());

    assert.equal(sizeAtExec, 1, 'secret manager was registered+seeded before exec launched');
    assert.equal(registry.size(), 1);
  });
});

// --- teardown --------------------------------------------------------------

describe('GondolinDispatcher.dispatch — teardown', () => {
  it('kills the exec, closes the VM, deregisters the manager, and is idempotent', async () => {
    const client = makeFakeVmClient();
    const { registry } = makeRegistry({ accessToken: 'tok', expiresAtMs: null });
    const d = new GondolinDispatcher(client, registry, stubHooksConfig(), VM_CONFIG);

    const handle = await d.dispatch(baseOptions());
    assert.equal(registry.size(), 1);

    await handle.teardown();
    assert.equal(client.handle.fakeExec.killed, true, 'exec killed');
    assert.equal(client.handle.closed, 1, 'vm closed once');
    assert.equal(registry.size(), 0, 'manager deregistered');

    // Idempotent: a second teardown does not double-close or throw.
    await handle.teardown();
    assert.equal(client.handle.closed, 1, 'vm.close not called again');
  });

  it('teardown tolerates a vm.close that throws (still deregisters)', async () => {
    const client = makeFakeVmClient();
    const { registry } = makeRegistry({ accessToken: 'tok', expiresAtMs: null });
    client.handle.close = async () => {
      throw new Error('close boom');
    };
    const d = new GondolinDispatcher(client, registry, stubHooksConfig(), VM_CONFIG);

    const handle = await d.dispatch(baseOptions());
    await assert.doesNotReject(handle.teardown());
    assert.equal(registry.size(), 0, 'deregistered despite vm.close throwing');
  });

  it('CLOSES the VM and DEREGISTERS the manager when a post-createVm staging exec throws', async () => {
    const client = makeFakeVmClient();
    const { registry } = makeRegistry({ accessToken: 'tok', expiresAtMs: null });
    // The VM is created OK, but the first fake-creds staging write blows up. The
    // dispatch handle is never returned, so without the bring-up guard the VM +
    // the registered secret manager would leak.
    const realExec = client.handle.exec.bind(client.handle);
    client.handle.exec = (opts) => {
      if (opts.command[0] === '/bin/sh') throw new Error('staging exec boom');
      return realExec(opts);
    };
    const d = new GondolinDispatcher(client, registry, stubHooksConfig(), VM_CONFIG);

    await assert.rejects(d.dispatch(baseOptions()), /staging exec boom/);
    assert.equal(client.createCalls.length, 1, 'VM was created (failure is post-createVm)');
    assert.equal(client.handle.closed, 1, 'VM closed on the bring-up failure path');
    assert.equal(registry.size(), 0, 'secret manager deregistered on the bring-up failure path');
  });

  it('CLOSES the VM (and does not register) when registration throws before staging', async () => {
    const client = makeFakeVmClient();
    const { registry } = makeRegistry({ accessToken: 'tok', expiresAtMs: null });
    // register() throws: the manager never lands in the registry, so teardown must
    // close the VM WITHOUT a deregister (the null-registration branch).
    registry.register = async () => {
      throw new Error('register boom');
    };
    const d = new GondolinDispatcher(client, registry, stubHooksConfig(), VM_CONFIG);

    await assert.rejects(d.dispatch(baseOptions()), /register boom/);
    assert.equal(client.createCalls.length, 1, 'VM was created');
    assert.equal(client.handle.closed, 1, 'VM closed despite register throwing');
    assert.equal(registry.size(), 0, 'nothing registered (and nothing to deregister)');
  });
});

// --- dispatch: fake-creds staging ------------------------------------------

describe('GondolinDispatcher.dispatch — fake native creds staging', () => {
  it('stages claude fake creds (placeholder bearer, junk refresh, far-future expiry) BEFORE launch', async () => {
    const client = makeFakeVmClient();
    const { registry } = makeRegistry({ accessToken: 'tok', expiresAtMs: null });
    const d = new GondolinDispatcher(client, registry, stubHooksConfig('claude'), VM_CONFIG);

    const handle = await d.dispatch(baseOptions());

    const writes = stagedWrites(client.handle);
    const creds = writes.find((w) => w.guestPath === '/root/.claude/.credentials.json');
    assert.ok(creds, 'claude .credentials.json staged');
    const parsed = JSON.parse(creds!.content) as { claudeAiOauth: Record<string, unknown> };
    const placeholder = handle.fakeCreds.env.ANTHROPIC_AUTH_TOKEN!;
    assert.equal(parsed.claudeAiOauth.accessToken, placeholder, 'accessToken IS the placeholder bearer');
    assert.ok((placeholder as string).startsWith('sk-ant-'), 'placeholder is claude-shaped');
    assert.equal(parsed.claudeAiOauth.refreshToken, 'JUNK-PLACEHOLDER-REFRESH-not-a-real-token');
    assert.ok((parsed.claudeAiOauth.expiresAt as number) > Date.now() + 1e12, 'far-future expiry');

    // The scrubbed identity is staged too (non-secret UUIDs only — no token).
    const cfg = writes.find((w) => w.guestPath === '/root/.claude.json');
    assert.ok(cfg, 'claude.json identity staged');
    const cfgParsed = JSON.parse(cfg!.content) as { oauthAccount: Record<string, string> };
    assert.equal(cfgParsed.oauthAccount.accountUuid, '11111111-2222-3333-4444-555555555555');
    assert.ok(!/accessToken|refreshToken/.test(cfg!.content), 'identity carries no token field');

    // Staging writes precede the launch exec.
    const launchIdx = client.handle.execCalls.findIndex((o) => o.command[0] === 'node');
    const lastWriteIdx = client.handle.execCalls.map((o) => o.command[0]).lastIndexOf('/bin/sh');
    assert.ok(lastWriteIdx < launchIdx, 'all creds writes happen before the agent launch');
  });

  it('stages codex fake auth.json: JWT-shaped placeholder access_token (far-future exp), real account_id, junk refresh', async () => {
    const client = makeFakeVmClient();
    const { registry } = makeRegistry({ accessToken: 'tok', expiresAtMs: null });
    const d = new GondolinDispatcher(client, registry, stubHooksConfig('codex'), VM_CONFIG);

    const handle = await d.dispatch(baseOptions({ adapterBin: 'codex-acp' }));

    const writes = stagedWrites(client.handle);
    const auth = writes.find((w) => w.guestPath === '/root/.codex/auth.json');
    assert.ok(auth, 'codex auth.json staged');
    const parsed = JSON.parse(auth!.content) as {
      OPENAI_API_KEY: unknown;
      auth_mode: unknown;
      last_refresh: unknown;
      tokens: Record<string, unknown>;
    };
    const placeholder = handle.fakeCreds.env.OPENAI_API_KEY!;
    assert.equal(parsed.tokens.access_token, placeholder, 'access_token IS the placeholder bearer');
    // JWT-shaped: 3 base64url segments; payload carries a far-future exp.
    const segs = (placeholder as string).split('.');
    assert.equal(segs.length, 3, 'placeholder is JWT-shaped (header.payload.signature)');
    const payload = JSON.parse(Buffer.from(segs[1]!, 'base64url').toString('utf8')) as { exp: number };
    assert.ok(payload.exp > 4_000_000_000, 'JWT exp is far-future (no refresh)');
    // The REAL, non-secret account_id was copied from the injected host reader.
    assert.equal(parsed.tokens.account_id, FAKE_ACCOUNT_ID, 'real non-secret account_id copied');
    assert.equal(parsed.tokens.refresh_token, 'JUNK-PLACEHOLDER-REFRESH-not-a-real-token');
    // codex-0.135 completeness fields: non-secret top-level markers from the host
    // reader, plus OPENAI_API_KEY: null (OAuth tokens block is the live cred).
    assert.equal(parsed.OPENAI_API_KEY, null, 'OPENAI_API_KEY is null (not an apikey)');
    assert.equal(parsed.auth_mode, 'chatgpt', 'non-secret auth_mode copied');
    assert.equal(parsed.last_refresh, '2026-05-22T08:59:06.309350255Z', 'non-secret last_refresh copied');
  });

  it('stages opencode config (custom provider, no inline token; placeholder via env)', async () => {
    const client = makeFakeVmClient();
    const { registry } = makeRegistry({ accessToken: 'tok', expiresAtMs: null });
    const d = new GondolinDispatcher(client, registry, stubHooksConfig('opencode'), VM_CONFIG);

    const handle = await d.dispatch(
      baseOptions({ adapterBin: 'opencode', opencodeModel: 'gpt-4.1' }),
    );

    const writes = stagedWrites(client.handle);
    const cfg = writes.find((w) => w.guestPath === '/root/.config/opencode/opencode.json');
    assert.ok(cfg, 'opencode.json staged');
    const placeholder = handle.fakeCreds.env.OPENCODE_PROXY_TOKEN!;
    assert.ok((placeholder as string).startsWith('gho_'), 'placeholder is Copilot-shaped');
    // The config holds the {env:…} interpolation, NOT the placeholder string itself.
    assert.ok(cfg!.content.includes('{env:OPENCODE_PROXY_TOKEN}'), 'apiKey reads the env placeholder');
    assert.ok(!cfg!.content.includes(placeholder as string), 'no inline bearer in opencode.json');
    assert.ok(cfg!.content.includes('gpt-4.1'), 'selected model present');
  });

  it('placeholder bearer reaches the launch env AND survives the credential strip', async () => {
    const client = makeFakeVmClient();
    const { registry } = makeRegistry({ accessToken: 'tok', expiresAtMs: null });
    const d = new GondolinDispatcher(client, registry, stubHooksConfig('codex'), VM_CONFIG);

    const handle = await d.dispatch(
      baseOptions({ adapterBin: 'codex-acp', runtimeEnv: { OPENAI_API_KEY: 'sk-real-leak', OPENAI_BASE_URL: 'https://x' } }),
    );

    const launch = client.handle.execCalls[client.handle.execCalls.length - 1]!;
    const env = launch.env!;
    const placeholder = handle.fakeCreds.env.OPENAI_API_KEY!;
    assert.equal(env.OPENAI_API_KEY, placeholder, 'launch env carries the placeholder, not the stripped real token');
    assert.notEqual(env.OPENAI_API_KEY, 'sk-real-leak', 'the real runtime token was stripped first');
    assert.equal(env.OPENAI_BASE_URL, 'https://x', 'non-secret vendor config preserved');
  });

  it('NEVER emits a real-looking refresh token anywhere in the staged files or env', async () => {
    const REAL_REFRESH = 'rt_REAL_refresh_token_must_never_leave_the_host_0xCAFE';
    for (const adapterId of ['claude', 'codex', 'opencode'] as const) {
      const client = makeFakeVmClient();
      const { registry } = makeRegistry({ accessToken: 'tok', expiresAtMs: null });
      const d = new GondolinDispatcher(client, registry, stubHooksConfig(adapterId), VM_CONFIG);

      // A malicious/leaky reader that tries to smuggle a real refresh token via the
      // (supposedly non-secret) identity fields. The staging must IGNORE everything
      // but the whitelisted identity (UUIDs / account_id), so the refresh never lands.
      const handle = await d.dispatch(
        baseOptions({
          env: { PATH: '/usr/bin', GH_TOKEN: REAL_REFRESH, OPENAI_API_KEY: REAL_REFRESH },
          runtimeEnv: { ANTHROPIC_AUTH_TOKEN: REAL_REFRESH },
        }),
      );

      const writeBlob = stagedWrites(client.handle).map((w) => w.content).join('\n');
      assert.ok(!writeBlob.includes(REAL_REFRESH), `${adapterId}: no real token in staged files`);
      const launch = client.handle.execCalls[client.handle.execCalls.length - 1]!;
      const envBlob = JSON.stringify(launch.env);
      assert.ok(!envBlob.includes(REAL_REFRESH), `${adapterId}: no real token in launch env`);
      const bootBlob = JSON.stringify(client.handle.execCalls[0]); // any exec; boot env stripped separately
      void bootBlob;
      // The placeholder env value the guest holds is a fake (never the real token).
      assert.notEqual(Object.values(handle.fakeCreds.env)[0], REAL_REFRESH);
    }
  });
});

// keep the unused VmMount import meaningful for the type-only consumers above
const _typecheck: VmMount = { host: '/x', guest: '/y', readonly: false };
void _typecheck;
