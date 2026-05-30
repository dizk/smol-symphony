// GO-LIVE validation — the PRODUCTION Gondolin dispatch path, end-to-end, on a
// real dispatch with REAL subscription creds.
//
// This is the ONE seam the spike never ran end-to-end: the production
// `GondolinDispatcher` + a real `AcpBridge` (loopback) + the real `AcpClient`
// driven over the `tcp.hosts` ACP mapping, against the built Gondolin image,
// running a real model turn. The spike proved the substrate (A1-A3),
// secret-substitution (B5/C7), and the bearer handshake (A3) SEPARATELY; here we
// wire them through the actual production modules the runner composes
// (mirroring `runner.ts` bringUpVmAndExec / connectBridgeAndInitSession /
// buildAcpClient / initAcpSession + the turn drive).
//
// GATED: SKIP unless SPIKE_GONDOLIN_REAL=1 (needs /dev/kvm + real creds + the
// built `symphony-agents:latest` Gondolin image). CI has none of these, so the
// normal suite stays green — this test never runs there.
//
// It spends REAL subscription tokens and boots REAL VMs; only run it when the
// operator has authorized that.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Socket } from 'node:net';

import { GondolinVmClient } from '../src/agent/gondolin.js';
import type { VmHandle } from '../src/agent/vm-port.js';
import {
  GondolinDispatcher,
  type GondolinVmConfig,
} from '../src/agent/gondolin-dispatch.js';
import {
  buildAdapterCredentialSpecs,
  buildAdapterHooksConfig,
  CredentialSecretRegistry,
  type AdapterHooksConfig,
  type BuildSpecsOptions,
} from '../src/agent/credential-secrets.js';
import { defaultHostIdentityReaders } from '../src/agent/gondolin-creds-staging.js';
import { AcpBridge } from '../src/acp-bridge.js';
import { AcpClient } from '../src/agent/acp.js';
import { ADAPTERS } from '../src/agent/adapters.js';
import type { AcpAdapterId } from '../src/agent/adapter-names.js';
import type { RuntimeEvent } from '../src/types.js';

const ENABLED = process.env.SPIKE_GONDOLIN_REAL === '1';

// Generous: VM boot + a real model turn can take 1-3 min.
const TURN_TIMEOUT_MS = 300_000;

const VM_CONFIG: GondolinVmConfig = {
  imagePath: 'symphony-agents:latest',
  cpus: 2,
  memMib: 4096,
};

// Per-adapter expected egress + a refresh-endpoint detector. We capture host+path
// at the hook (NEVER headers/token); the assertion proves the turn hit ONLY the
// adapter's real upstream and ZERO oauth/token/refresh endpoint.
interface AdapterExpectation {
  /** The host the real model turn must hit (and the only allowed egress host). */
  upstreamHost: string;
  /** Match any oauth/token-grant/refresh endpoint (must NOT appear in egress). */
  refreshRe: RegExp;
  /** The path prefix the real inference call should hit, for a positive check. */
  inferencePathPrefix?: string;
}

const EXPECT: Record<'claude' | 'codex', AdapterExpectation> = {
  claude: {
    upstreamHost: 'api.anthropic.com',
    // /v1/messages = inference. A refresh would be /oauth/token (console host or
    // anthropic). /api/oauth/profile is a profile READ w/ the same bearer — not a
    // refresh — so match the token-GRANT endpoints precisely.
    refreshRe: /\/oauth\/token|\/v1\/oauth\/token|console\.anthropic\.com|\/oauth\/refresh/i,
    inferencePathPrefix: '/v1/',
  },
  codex: {
    upstreamHost: 'chatgpt.com',
    refreshRe: /\/oauth\/token|auth\.openai|\/token\b|\/refresh/i,
    inferencePathPrefix: '/backend-api/codex',
  },
};

interface EgressCapture {
  /** host+path pairs (NO headers, NO token) observed at the egress hook. */
  hits: string[];
  hosts(): string[];
}

/**
 * Wrap a freshly-built adapter hooks config so the egress hook ALSO records
 * host+path — preserving (and delegating to) any production `onRequest` guard
 * (e.g. opencode's path-allowlist). Returns the wrapped config + the capture.
 * NEVER touches headers/body (the real token is substituted downstream).
 */
function withEgressCapture(
  adapterId: AcpAdapterId,
  specsOpts: BuildSpecsOptions,
): {
  hooks: AdapterHooksConfig;
  capture: EgressCapture;
} {
  const specs = buildAdapterCredentialSpecs(specsOpts);
  const hooks = buildAdapterHooksConfig(specs[adapterId]);
  const hits: string[] = [];
  const inner = hooks.options.onRequest;
  hooks.options.onRequest = (request: Request) => {
    try {
      const u = new URL(request.url);
      hits.push(`${u.host}${u.pathname}`);
    } catch {
      /* unparseable — ignore for capture, the guard below still runs */
    }
    return inner ? inner(request) : undefined;
  };
  return {
    hooks,
    capture: {
      hits,
      hosts: () => [...new Set(hits.map((h) => h.split('/')[0]!))],
    },
  };
}

/** A no-op-ish sink for AcpClient events (collect for diagnostics on failure). */
function makeEventSink(): { events: RuntimeEvent[]; onEvent: (e: RuntimeEvent) => void } {
  const events: RuntimeEvent[] = [];
  return { events, onEvent: (e) => events.push(e) };
}

/** Run one full adapter dispatch through the production path. */
async function runAdapterDispatch(adapterId: 'claude' | 'codex'): Promise<void> {
  const expectation = EXPECT[adapterId];
  const profile = ADAPTERS[adapterId];
  const identifier = `golive-${adapterId}-${Date.now()}`;
  const workdir = os.tmpdir(); // a real, mountable dir; the prompt does no FS work
  const stderrChunks: string[] = [];

  // (1) Real AcpBridge loopback, ephemeral port.
  const bridge = new AcpBridge({ loopbackOnly: true });
  await bridge.start('127.0.0.1', 0);
  const bridgePort = bridge.port();
  assert.ok(bridgePort && bridgePort > 0, 'bridge bound an ephemeral loopback port');
  const reg = bridge.register(`issue-${identifier}`, identifier);

  // (2) Per-adapter hooks (egress-wrapped) + VM client + shared registry wired
  //     EXACTLY like the production composition root (symphony.ts) — including
  //     binding the non-secret codex chatgpt_account_id into the spec options so
  //     the codex placeholder JWT carries the auth claim codex-acp requires.
  const codexAccountId = await defaultHostIdentityReaders().readCodexAccountId();
  const specsOpts: BuildSpecsOptions = { codexAccountId };
  const { hooks, capture } = withEgressCapture(adapterId, specsOpts);
  const vmClient = new GondolinVmClient();
  const specs = buildAdapterCredentialSpecs(specsOpts);
  const registry = new CredentialSecretRegistry({
    readToken: (id) => specs[id].readToken(),
    refresh: (id) => specs[id].refresh(),
  });

  // Snapshot the real host creds file bytes BEFORE the turn (rotation check).
  const hostCredsPath =
    adapterId === 'claude'
      ? path.join(os.homedir(), '.claude', '.credentials.json')
      : path.join(os.homedir(), '.codex', 'auth.json');
  const hostCredsBefore = await readFile(hostCredsPath, 'utf8');

  // (3) Production dispatcher.
  const dispatcher = new GondolinDispatcher(vmClient, registry, hooks, VM_CONFIG);

  let handle: Awaited<ReturnType<GondolinDispatcher['dispatch']>> | null = null;
  let client: AcpClient | null = null;
  try {
    handle = await dispatcher.dispatch({
      identifier,
      mounts: [{ host: workdir, guest: workdir, readonly: false }],
      env: {},
      workdir,
      bridgeHost: '127.0.0.1',
      bridgePort: bridgePort!,
      acpToken: reg.token,
      adapterBin: profile.binary[0]!,
      adapterArgs: profile.binary.slice(1),
      runtimeEnv: {},
      onStderr: (chunk) => stderrChunks.push(chunk),
    });
    // The launch exec's `exit` rejects when teardown aborts it (gondolin maps
    // AbortController → a rejected `proc.result`). The production runner awaits it
    // under a try/catch (runner.ts ~1723); here nothing else consumes it, so attach
    // a no-op catch to keep that abort-rejection from surfacing as an unhandled
    // rejection that would mask the real assertion failure.
    void handle.exec.exit.catch(() => undefined);

    // (c-pre) The guest's STAGED creds file holds the PLACEHOLDER, not the real
    // token. Read the fake creds file IN-GUEST and grep (mirrors spike B5/C7).
    const placeholder = handle.fakeCreds.env[hooks.secretName];
    assert.ok(placeholder && placeholder.length > 0, 'placeholder bearer was minted');
    const realToken = await readRealToken(adapterId);
    const guestCredsPath =
      adapterId === 'claude' ? '/root/.claude/.credentials.json' : '/root/.codex/auth.json';
    const guestBefore = await catInGuest(handle.vm, guestCredsPath);
    assert.ok(
      guestBefore.includes(placeholder),
      `guest staged creds (${guestCredsPath}) contain the placeholder bearer`,
    );
    assert.ok(
      !guestBefore.includes(realToken),
      `guest staged creds (${guestCredsPath}) do NOT contain the real host token`,
    );

    // (4) Await the bridge accept → build the real AcpClient over the socket
    //     (mirror runner.buildAcpClient), initSession, drive ONE prompt.
    const acpSocket: Socket = await Promise.race([
      reg.accepted,
      rejectAfter<Socket>(60_000, 'acp bridge: in-VM agent did not connect in time'),
    ]);
    const sink = makeEventSink();
    client = new AcpClient({
      stdin: acpSocket,
      stdout: acpSocket,
      stderr: handle.exec.stderr,
      cwd: workdir,
      readTimeoutMs: 60_000,
      promptTimeoutMs: TURN_TIMEOUT_MS,
      onEvent: sink.onEvent,
      onTokenUsage: () => {},
      mcpServers: [],
    });
    await client.initSession();
    const outcome = await client.runPrompt(
      'Reply with exactly the single word: PONG (nothing else).',
    );

    // Diagnostic (host+path only; never headers/token).
    // eslint-disable-next-line no-console
    console.log(
      `[${adapterId}] outcome=${outcome.reason} egress=${JSON.stringify([
        ...new Set(capture.hits),
      ])}`,
    );

    // (5a) A real upstream turn completed through Gondolin and yielded PONG.
    assert.equal(
      outcome.reason,
      'end_turn',
      `expected end_turn, got ${outcome.reason}: ${outcome.message} ` +
        `| stderr: ${stderrChunks.join('').slice(-800)} ` +
        `| events: ${sink.events.map((e) => e.event).join(',')}`,
    );
    assert.match(
      outcome.message,
      /PONG/i,
      `response should contain PONG; got: ${JSON.stringify(outcome.message)}`,
    );

    // (5b) Egress hit ONLY the adapter's real upstream, and ZERO refresh egress.
    const hosts = capture.hosts();
    assert.ok(
      hosts.includes(expectation.upstreamHost),
      `egress reached the real upstream ${expectation.upstreamHost}; hosts=${JSON.stringify(hosts)}`,
    );
    if (expectation.inferencePathPrefix) {
      assert.ok(
        capture.hits.some(
          (h) =>
            h.startsWith(`${expectation.upstreamHost}${expectation.inferencePathPrefix}`),
        ),
        `egress hit the inference path ${expectation.upstreamHost}${expectation.inferencePathPrefix}; ` +
          `paths=${JSON.stringify([...new Set(capture.hits)].slice(0, 20))}`,
      );
    }
    const refreshHits = capture.hits.filter((h) => expectation.refreshRe.test(h));
    assert.deepEqual(
      refreshHits,
      [],
      `ZERO refresh/token-grant egress expected; saw ${JSON.stringify(refreshHits)}`,
    );

    // (5c) The guest's staged creds STILL hold the placeholder after the turn
    //      (the in-VM client never rotated it — there is nothing real to rotate).
    const guestAfter = await catInGuest(handle.vm, guestCredsPath);
    assert.ok(
      guestAfter.includes(placeholder) && !guestAfter.includes(realToken),
      `guest creds NOT rotated to a real token after the turn`,
    );

    // (5d) The real HOST creds file is UNCHANGED (not rotated by the turn).
    const hostCredsAfter = await readFile(hostCredsPath, 'utf8');
    assert.equal(
      hostCredsAfter,
      hostCredsBefore,
      `host creds file ${hostCredsPath} must be byte-identical after the turn (not rotated)`,
    );
  } finally {
    // (5e) Teardown + assert the VM is gone.
    try {
      client?.forceClose('test_teardown');
    } catch {
      /* idempotent */
    }
    const vmId = handle?.vm.id;
    try {
      await handle?.teardown();
    } catch (err) {
      // surface but don't mask the primary assertion
      stderrChunks.push(`teardown error: ${(err as Error).message}`);
    }
    try {
      reg.cancel('test_done');
    } catch {
      /* idempotent */
    }
    await bridge.stop();

    if (vmId) {
      // listSessions should no longer show this VM (or gc reaps it).
      let sessions = await vmClient.listSessions();
      if (sessions.some((s) => s.id === vmId)) {
        await vmClient.gc();
        sessions = await vmClient.listSessions();
      }
      assert.ok(
        !sessions.some((s) => s.id === vmId && s.alive),
        `VM ${vmId} should be gone after teardown; live sessions=${JSON.stringify(
          sessions.filter((s) => s.alive).map((s) => s.id),
        )}`,
      );
    }
  }
}

/** Reject after `ms`, for racing against the bridge accept. */
function rejectAfter<T>(ms: number, message: string): Promise<T> {
  return new Promise<T>((_, reject) => setTimeout(() => reject(new Error(message)), ms));
}

/** Read the real host access token (host-side ONLY; never logged/asserted on). */
async function readRealToken(adapterId: 'claude' | 'codex'): Promise<string> {
  if (adapterId === 'claude') {
    const c = JSON.parse(
      await readFile(path.join(os.homedir(), '.claude', '.credentials.json'), 'utf8'),
    );
    return (c.claudeAiOauth ?? c).accessToken as string;
  }
  const a = JSON.parse(await readFile(path.join(os.homedir(), '.codex', 'auth.json'), 'utf8'));
  return a.tokens.access_token as string;
}

/** `cat` a file inside the guest and collect stdout (a tiny, bounded exec). */
async function catInGuest(vm: VmHandle, guestPath: string): Promise<string> {
  const exec = vm.exec({ command: ['/bin/sh', '-c', `cat '${guestPath}'`], timeoutMs: 15_000 });
  exec.stdin.end();
  let out = '';
  exec.stdout.setEncoding('utf8');
  exec.stdout.on('data', (chunk: string) => {
    out += chunk;
  });
  await exec.exit;
  return out;
}

describe('gondolin real dispatch (go-live; SPIKE_GONDOLIN_REAL=1)', () => {
  it(
    'claude: real turn through the production dispatch path + invariant holds',
    { skip: !ENABLED, timeout: TURN_TIMEOUT_MS + 60_000 },
    async () => {
      await runAdapterDispatch('claude');
    },
  );

  // BLOCKER (validated 2026-05-30, two layers): codex-acp 0.15 streams
  // `/backend-api/codex/responses` over a WebSocket. (1) The dispatcher default-denies
  // WS, so the Upgrade was rejected outright. (2) Allowing WS (codex spec
  // allowWebSockets:true) lets the Upgrade HANDSHAKE succeed — the real token IS
  // substituted on the hookable handshake (createHttpHooks onRequest →
  // applySecretsToRequest), reaching `/responses` with a 101 — BUT the POST-101 opaque
  // tunnel drops the stream (`ResponseStreamDisconnected { http_status_code: None }`),
  // and codex-acp then attempts an egress-blocked refresh → 403 → REFUSAL. So WS-allow
  // is necessary-but-not-sufficient; the real blocker is the post-101 WS tunnel relay
  // (the layer that is, by Gondolin's design, an opaque passthrough). `codex exec`
  // (HTTP SSE) works through Gondolin; only codex-acp's WS transport fails. Until the
  // post-101 issue is resolved OR codex-acp is forced onto HTTP, codex routes via the
  // proxy fallback. claude is fully green on the identical production path.
  const CODEX_BLOCKED = true;
  it(
    'codex: real turn through the production dispatch path + invariant holds',
    { skip: !ENABLED || CODEX_BLOCKED, timeout: TURN_TIMEOUT_MS + 60_000 },
    async () => {
      await runAdapterDispatch('codex');
    },
  );
});
