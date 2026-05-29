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
  ACP_GUEST_PORT,
  ACP_SYNTHETIC_HOST,
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
import type { TokenInfo } from '../src/agent/credential-proxy.js';

const HOME = '/home/tester';

// --- fakes -----------------------------------------------------------------

interface FakeExec extends VmExec {
  stdinEnded: boolean;
  killed: boolean;
  readonly stderrPt: PassThrough;
}

function makeFakeExec(): FakeExec {
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
  readonly fakeExec: FakeExec;
}

function makeFakeVmHandle(id: string): FakeVmHandle {
  const fakeExec = makeFakeExec();
  const handle: FakeVmHandle = {
    id,
    closed: 0,
    execCalls: [],
    fakeExec,
    exec(opts) {
      handle.execCalls.push(opts);
      return fakeExec;
    },
    async close() {
      handle.closed += 1;
    },
  };
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

function stubHooksConfig(adapterId: 'claude' = 'claude'): AdapterHooksConfig {
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

    assert.equal(client.handle.execCalls.length, 1);
    const exec = client.handle.execCalls[0]!;
    assert.deepEqual(exec.command, ['node', '/opt/symphony/vm-agent.mjs']);
    assert.equal(exec.workdir, '/work');
    assert.equal(exec.timeoutMs, null);
    assert.equal(client.handle.fakeExec.stdinEnded, true, 'stdin end()ed immediately');

    const env = exec.env!;
    assert.equal(env.SYMPHONY_ACP_URL, `tcp://${ACP_SYNTHETIC_HOST}:${ACP_GUEST_PORT}`);
    assert.equal(env.SYMPHONY_ACP_URL, handle.acpUrl);
    assert.equal(env.SYMPHONY_ACP_TOKEN, 'bridge-bearer-abc');
    assert.equal(env.SYMPHONY_ADAPTER_BIN, 'claude-agent-acp');
    assert.equal(env.SYMPHONY_ADAPTER_ARGS, JSON.stringify(['--foo', 'bar']));
    assert.equal(env.ANTHROPIC_MODEL, 'opus', 'innocuous runtime env kept');
    assert.ok(!('ANTHROPIC_AUTH_TOKEN' in env), 'runtime credential var stripped from launch env');
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
});

// keep the unused VmMount import meaningful for the type-only consumers above
const _typecheck: VmMount = { host: '/x', guest: '/y', readonly: false };
void _typecheck;
