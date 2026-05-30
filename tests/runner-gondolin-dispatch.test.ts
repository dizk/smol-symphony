// Pins the LIVE Gondolin dispatch seam at the runner layer (the smolvm→Gondolin
// flip). The runner no longer starts a smolvm machine + dials a credential proxy;
// instead it builds a per-dispatch `GondolinDispatcher` over the injected
// `VmClient` + shared `CredentialSecretRegistry` + per-adapter hooks config, and
// the dispatch's secret-substitution model (placeholder bearer in the guest, real
// token at egress) replaces the proxy sentinel.
//
// We can't drive a full ACP `initialize` + `session/new` handshake without a real
// in-VM agent, so this test exercises the bring-up + teardown seam: the in-VM
// agent never dials the bridge, so `connectBridgeAndInitSession` times out fast
// and `tearDownSession` runs. That still covers the load-bearing wiring:
//   - the GondolinDispatcher is invoked (a VM is created) with the runner's mounts
//     (workspace RW), the bridge host/port + bearer threaded into the ACP mapping,
//     and the adapter bin/args;
//   - credential env is STRIPPED from the boot env (host-only-refresh invariant)
//     while the placeholder bearer reaches the launch env;
//   - a per-VM secret manager is registered (seeded) and then DEREGISTERED on
//     teardown, and the VM is CLOSED — the dispatch owns lifecycle now.
//
// Fakes only: a fake VmClient (records createVm + execs, hands back a fake exec
// that never connects to the bridge), a real CredentialSecretRegistry with a
// stubbed readToken, a real loopback AcpBridge, and a real workspace git repo
// with no origin (so the pre-dispatch base fetch skips cleanly).

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { PassThrough, type Readable } from 'node:stream';
import os from 'node:os';
import path from 'node:path';
import { AgentRunner } from '../src/agent/runner.js';
import { buildServiceConfig } from '../src/workflow.js';
import {
  CredentialSecretRegistry,
  buildAdapterCredentialSpecs,
  buildAdapterHooksConfig,
  type AdapterHooksConfig,
} from '../src/agent/credential-secrets.js';
import { ACP_GUEST_PORT, ACP_SYNTHETIC_HOST } from '../src/agent/vm-acp-mapping.js';
import type { GondolinVmConfig } from '../src/agent/gondolin-dispatch.js';
import { AcpBridge } from '../src/acp-bridge.js';
import type { AcpAdapterId } from '../src/agent/adapter-names.js';
import type {
  CreateVmOptions,
  VmClient,
  VmExec,
  VmExecOptions,
  VmHandle,
  VmSession,
} from '../src/agent/vm-port.js';
import type { WorkflowDefinition, Issue } from '../src/types.js';
import type { WorkspaceManager } from '../src/workspace.js';
import type { IssueTracker } from '../src/trackers/types.js';

const HOME = '/home/tester';

function run(cmd: string, args: string[], cwd: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: 'ignore' });
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? -1));
  });
}

async function git(args: string[], cwd: string): Promise<void> {
  const code = await run('git', args, cwd);
  if (code !== 0) throw new Error(`git ${args.join(' ')} exited ${code}`);
}

// --- fake exec / VM --------------------------------------------------------

interface FakeExec extends VmExec {
  killed: boolean;
}

/** Staging writes (`/bin/sh -c …`) resolve immediately on stdin.end(); the
 *  long-lived launch exec stays pending until kill(). */
function makeFakeExec(resolveOnEnd: boolean): FakeExec {
  let resolveExit!: (v: { code: number | null; signal: number | null }) => void;
  const exit = new Promise<{ code: number | null; signal: number | null }>((r) => {
    resolveExit = r;
  });
  const exec: FakeExec = {
    killed: false,
    stdin: {
      write() {},
      end() {
        if (resolveOnEnd) resolveExit({ code: 0, signal: null });
      },
    },
    stdout: new PassThrough() as Readable,
    stderr: new PassThrough() as Readable,
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
  execCalls: VmExecOptions[];
}

function makeFakeVmHandle(): FakeVmHandle {
  const handle = {
    id: 'vm-fake-dispatch',
    closed: 0,
    execCalls: [] as VmExecOptions[],
    exec(opts: VmExecOptions) {
      handle.execCalls.push(opts);
      return makeFakeExec(opts.command[0] === '/bin/sh');
    },
    async close() {
      handle.closed += 1;
    },
  } as FakeVmHandle;
  return handle;
}

interface FakeVmClient extends VmClient {
  createCalls: CreateVmOptions[];
  handle: FakeVmHandle;
}

function makeFakeVmClient(): FakeVmClient {
  const handle = makeFakeVmHandle();
  const client: FakeVmClient = {
    createCalls: [],
    handle,
    async createVm(opts) {
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

// --- hooks config (hermetic: never touches real creds) ---------------------

function hooksFor(adapterId: AcpAdapterId): Record<AcpAdapterId, AdapterHooksConfig> {
  const specs = buildAdapterCredentialSpecs({
    claudeCredentialsPath: '/nonexistent/claude.json',
    codexCredentialsPath: '/nonexistent/codex.json',
    opencodeCredentialsPath: '/nonexistent/opencode.json',
    lockPath: '/tmp/symphony-runner-gondolin-test.lock',
    lockAcquire: async () => async () => {},
    claudeRefresher: async () => {},
  });
  return {
    claude: buildAdapterHooksConfig(specs.claude),
    codex: buildAdapterHooksConfig(specs.codex),
    opencode: buildAdapterHooksConfig(specs.opencode),
  } as Record<AcpAdapterId, AdapterHooksConfig>;
}

const VM_CONFIG: GondolinVmConfig = { imagePath: 'symphony-agents:latest', cpus: 2, memMib: 4096 };

function makeIssue(): Issue {
  return {
    id: '7',
    identifier: '7',
    title: 'gondolin dispatch seam',
    description: null,
    priority: null,
    state: 'Todo',
    branch_name: null,
    url: null,
    labels: [],
    blocked_by: [],
    created_at: null,
    updated_at: null,
  };
}

describe('runner Gondolin dispatch seam (live flip)', () => {
  let wsRoot: string;
  let trackerRoot: string;
  let wsPath: string;
  let bridge: AcpBridge;

  before(async () => {
    wsRoot = await mkdtemp(path.join(os.tmpdir(), 'symphony-gondolin-ws-'));
    trackerRoot = await mkdtemp(path.join(os.tmpdir(), 'symphony-gondolin-tracker-'));
    wsPath = path.join(wsRoot, '7');
    await mkdir(wsPath, { recursive: true });
    // A git repo with NO origin → the pre-dispatch base fetch skips cleanly.
    await git(['init', '-b', 'main'], wsPath);
    bridge = new AcpBridge({ loopbackOnly: true });
    await bridge.start('127.0.0.1', 0);
  });

  after(async () => {
    await bridge.stop().catch(() => undefined);
    await rm(wsRoot, { recursive: true, force: true });
    await rm(trackerRoot, { recursive: true, force: true });
  });

  function buildRunner(client: FakeVmClient, registry: CredentialSecretRegistry, adapter: AcpAdapterId) {
    const cfg = buildServiceConfig(
      {
        workspace: { root: wsRoot },
        acp: {
          adapter,
          // Fail the in-VM connect fast (the fake VM never dials back).
          bridge: { connect_timeout_ms: 150 },
        },
        mcp: { enabled: false },
        states: { Todo: { role: 'active', adapter }, Done: { role: 'terminal' } },
        tracker: { kind: 'local', root: trackerRoot },
      },
      path.join(trackerRoot, 'WORKFLOW.md'),
    );
    const def: WorkflowDefinition = { config: {}, prompt_template: 'do work' };
    const workspaces = {
      ensureFor: async () => ({ path: wsPath, workspace_key: '7', created_now: false }),
      runBeforeRun: async () => {},
      runAfterRunBestEffort: async () => {},
    } as unknown as WorkspaceManager;
    const tracker = {} as unknown as IssueTracker;
    const events = {
      onRuntimeEvent: () => {},
      onTokenUsage: () => {},
      onRateLimits: () => {},
      onTurn: () => {},
    };
    return new AgentRunner(
      cfg,
      def,
      workspaces,
      tracker,
      client,
      events,
      null, // mcp
      bridge,
      null, // followupSink
      null, // actionSnapshotSink
      registry,
      hooksFor(adapter),
      VM_CONFIG,
    );
  }

  it('dispatches via GondolinDispatcher (creates a VM with the workspace mount + ACP mapping) and tears it down', async () => {
    const client = makeFakeVmClient();
    const registry = new CredentialSecretRegistry({
      readToken: async () => ({ accessToken: 'real-host-token', expiresAtMs: null }),
      refresh: async () => {},
    });
    const runner = buildRunner(client, registry, 'claude');

    const result = await runner.runAttempt(makeIssue(), 0, { cancelled: false });

    // The in-VM agent never connected → the attempt fails at the bridge connect.
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'acp bridge connect failed');

    // A VM was created through the dispatcher with the workspace mount + the ACP
    // tcp.hosts mapping pointing at the real loopback bridge port.
    assert.equal(client.createCalls.length, 1);
    const opts = client.createCalls[0]!;
    assert.equal(opts.imagePath, 'symphony-agents:latest');
    assert.equal(opts.sessionLabel, 'symphony-7');
    assert.deepEqual(opts.mounts, [{ host: wsPath, guest: wsPath, readonly: false }]);
    const bridgePort = bridge.port()!;
    assert.deepEqual(opts.tcp!.hosts, {
      [`${ACP_SYNTHETIC_HOST}:${ACP_GUEST_PORT}`]: `127.0.0.1:${bridgePort}`,
    });
    assert.equal(opts.allowWebSockets, false);

    // The launch exec (last exec; the `/bin/sh` creds writes precede it) carries
    // the ACP url/token + adapter bin, and the placeholder bearer (NOT a real
    // token) reached the launch env.
    const launch = client.handle.execCalls[client.handle.execCalls.length - 1]!;
    assert.deepEqual(launch.command, ['node', '/opt/symphony/vm-agent.mjs']);
    assert.equal(launch.env!.SYMPHONY_ACP_URL, `tcp://${ACP_SYNTHETIC_HOST}:${ACP_GUEST_PORT}`);
    assert.equal(typeof launch.env!.SYMPHONY_ACP_TOKEN, 'string');
    assert.equal(launch.env!.SYMPHONY_ADAPTER_BIN, 'claude-agent-acp');
    assert.ok(launch.env!.ANTHROPIC_AUTH_TOKEN!.startsWith('sk-ant-'), 'placeholder bearer present');
    assert.notEqual(launch.env!.ANTHROPIC_AUTH_TOKEN, 'real-host-token', 'never the real token');

    // Teardown ran: the VM was closed and the secret manager deregistered (the
    // dispatch owns lifecycle now — no deferral to the reconciler).
    assert.equal(client.handle.closed, 1, 'VM closed on teardown');
    assert.equal(registry.size(), 0, 'secret manager deregistered on teardown');
  });

  it('STRIPS credential vars from the boot env even when forward_env lists them', async () => {
    const client = makeFakeVmClient();
    const registry = new CredentialSecretRegistry({
      readToken: async () => ({ accessToken: 'real-host-token', expiresAtMs: null }),
      refresh: async () => {},
    });
    const runner = buildRunner(client, registry, 'codex');
    // forward_env defaults include OPENAI_API_KEY; plant a real value on the host
    // to prove the dispatcher's stripCredentialEnv drops it from the boot env.
    const prev = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'sk-REAL-must-not-reach-guest';
    try {
      await runner.runAttempt(makeIssue(), 0, { cancelled: false });
    } finally {
      if (prev === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prev;
    }
    const opts = client.createCalls[0]!;
    assert.ok(!('OPENAI_API_KEY' in opts.env), 'real OPENAI_API_KEY stripped from boot env');
    for (const v of Object.values(opts.env)) {
      assert.notEqual(v, 'sk-REAL-must-not-reach-guest');
    }
  });

  it('fails fast (no VM) when the Gondolin credential collaborators are unwired', async () => {
    const client = makeFakeVmClient();
    const cfg = buildServiceConfig(
      {
        workspace: { root: wsRoot },
        acp: { adapter: 'claude', bridge: { connect_timeout_ms: 150 } },
        mcp: { enabled: false },
        states: { Todo: { role: 'active', adapter: 'claude' }, Done: { role: 'terminal' } },
        tracker: { kind: 'local', root: trackerRoot },
      },
      path.join(trackerRoot, 'WORKFLOW.md'),
    );
    const def: WorkflowDefinition = { config: {}, prompt_template: 'x' };
    const workspaces = {
      ensureFor: async () => ({ path: wsPath, workspace_key: '7', created_now: false }),
      runBeforeRun: async () => {},
      runAfterRunBestEffort: async () => {},
    } as unknown as WorkspaceManager;
    // No registry / hooks / vmConfig → the dispatch must fail before createVm.
    const runner = new AgentRunner(
      cfg,
      def,
      workspaces,
      {} as unknown as IssueTracker,
      client,
      { onRuntimeEvent: () => {}, onTokenUsage: () => {}, onRateLimits: () => {}, onTurn: () => {} },
      null,
      bridge,
    );
    const result = await runner.runAttempt(makeIssue(), 0, { cancelled: false });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'gondolin dispatch unavailable');
    assert.equal(client.createCalls.length, 0, 'no VM created when collaborators are unwired');
  });
});
