// Unit tests for the host credential proxy (issue 113). Mirrors the density
// of tests/acp-bridge.test.ts: register/deregister, unknown-sentinel rejected,
// expired-cache triggers `claude -p`, single-flight collapses concurrent
// callers, the host-side header-override seam (default no-op + recorded
// override path), and the `anthropic-ratelimit-unified-*` /
// `anthropic-organization-id` header forwarding to the in-VM client.

import { describe, it, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  CredentialProxy,
  type HeaderOverride,
  type UpstreamRequestor,
  type UpstreamResponse,
} from '../src/agent/credential-proxy.js';
import { stageClaudeIdentity } from '../src/agent/adapters.js';

interface RecordedRequest {
  method: string;
  pathname: string;
  headers: Record<string, string>;
  body: string;
}

interface FakeUpstream extends UpstreamRequestor {
  calls: RecordedRequest[];
  nextResponse(resp: UpstreamResponse): void;
}

function makeFakeUpstream(): FakeUpstream {
  const calls: RecordedRequest[] = [];
  const queue: UpstreamResponse[] = [];
  return {
    calls,
    nextResponse(resp) {
      queue.push(resp);
    },
    async send(input) {
      calls.push({
        method: input.method,
        pathname: input.pathname,
        headers: input.headers,
        body: input.body.toString('utf8'),
      });
      const resp = queue.shift();
      if (!resp) {
        return {
          statusCode: 200,
          headers: { 'content-type': 'application/json' },
          body: emptyBody(),
        };
      }
      return resp;
    },
  };
}

async function* emptyBody(): AsyncIterable<Buffer> {
  return;
}

function jsonBody(text: string): AsyncIterable<Buffer> {
  return (async function* () {
    yield Buffer.from(text, 'utf8');
  })();
}

interface BootedProxy {
  proxy: CredentialProxy;
  port: number;
  base: string;
  upstream: FakeUpstream;
  refresherCalls: number;
  tmp: string;
  credentialsPath: string;
  writeToken(accessToken: string, expiresAtMs: number | null): Promise<void>;
  setRefresher(fn: () => Promise<void>): void;
}

async function bootProxy(opts: {
  initialToken?: string;
  initialExpiresMs?: number | null;
  override?: HeaderOverride;
  refresher?: () => Promise<void>;
  now?: () => number;
  refreshMarginMs?: number;
} = {}): Promise<BootedProxy> {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'symphony-credproxy-test-'));
  const credentialsPath = path.join(tmp, '.credentials.json');
  if (opts.initialToken !== undefined) {
    const payload = { claudeAiOauth: { accessToken: opts.initialToken, expiresAt: opts.initialExpiresMs } };
    await writeFile(credentialsPath, JSON.stringify(payload), 'utf8');
  }
  const upstream = makeFakeUpstream();
  let refresherCalls = 0;
  let refresherFn: () => Promise<void> = opts.refresher ?? (async () => undefined);
  const proxy = new CredentialProxy({
    credentialsPath,
    lockPath: path.join(tmp, 'refresh.lock'),
    upstream,
    refresher: async () => {
      refresherCalls += 1;
      await refresherFn();
    },
    override: opts.override,
    now: opts.now,
    refreshMarginMs: opts.refreshMarginMs ?? 60_000,
  });
  await proxy.start('127.0.0.1', 0);
  const port = proxy.port();
  assert.ok(port && port > 0, 'proxy should expose a bound ephemeral port');
  const base = `http://127.0.0.1:${port}`;
  return {
    proxy,
    port: port,
    base,
    upstream,
    get refresherCalls() {
      return refresherCalls;
    },
    tmp,
    credentialsPath,
    async writeToken(accessToken, expiresAtMs) {
      const payload = { claudeAiOauth: { accessToken, expiresAt: expiresAtMs } };
      await writeFile(credentialsPath, JSON.stringify(payload), 'utf8');
    },
    setRefresher(fn) {
      refresherFn = fn;
    },
  } as BootedProxy;
}

async function teardown(b: BootedProxy): Promise<void> {
  await b.proxy.stop();
  await rm(b.tmp, { recursive: true, force: true });
}

describe('CredentialProxy register/deregister', () => {
  let active: BootedProxy | null = null;
  afterEach(async () => {
    if (active) {
      await teardown(active);
      active = null;
    }
  });

  it('register() mints a sentinel + baseUrl pointing at the bound port', async () => {
    active = await bootProxy({ initialToken: 'tok-abc', initialExpiresMs: Date.now() + 3_600_000 });
    const reg = active.proxy.register({ issueId: 'i1', identifier: '1' });
    assert.ok(reg.sentinel.length > 0);
    assert.match(reg.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(reg.baseUrl, active.base);
  });

  it('accepts the inbound bearer that matches a live sentinel and forwards', async () => {
    active = await bootProxy({ initialToken: 'real-token-1', initialExpiresMs: Date.now() + 3_600_000 });
    const reg = active.proxy.register({ issueId: 'i1', identifier: '1' });
    active.upstream.nextResponse({
      statusCode: 200,
      headers: { 'content-type': 'application/json', 'anthropic-organization-id': 'org-test' },
      body: jsonBody('{"ok":true}'),
    });
    const res = await fetch(`${active.base}/v1/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${reg.sentinel}`, 'content-type': 'application/json' },
      body: '{"model":"opus"}',
    });
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.equal(text, '{"ok":true}');
    // Upstream call carries the real token substituted in.
    assert.equal(active.upstream.calls.length, 1);
    assert.equal(active.upstream.calls[0]!.headers['authorization'], 'Bearer real-token-1');
    // The sentinel is stripped from the inbound headers when forwarding.
    assert.notEqual(active.upstream.calls[0]!.headers['authorization'], `Bearer ${reg.sentinel}`);
  });

  it('rejects requests with an unknown sentinel as 401', async () => {
    active = await bootProxy({ initialToken: 'real-token-1', initialExpiresMs: Date.now() + 3_600_000 });
    const res = await fetch(`${active.base}/v1/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer not-the-real-sentinel` },
      body: '',
    });
    assert.equal(res.status, 401);
    assert.equal(active.upstream.calls.length, 0);
  });

  it('rejects requests after deregister', async () => {
    active = await bootProxy({ initialToken: 'real-token-1', initialExpiresMs: Date.now() + 3_600_000 });
    const reg = active.proxy.register({ issueId: 'i1', identifier: '1' });
    active.proxy.deregister(reg.sentinel);
    const res = await fetch(`${active.base}/v1/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${reg.sentinel}` },
      body: '',
    });
    assert.equal(res.status, 401);
  });

  it('returns 401 on a missing Authorization header', async () => {
    active = await bootProxy({ initialToken: 'real-token-1', initialExpiresMs: Date.now() + 3_600_000 });
    active.proxy.register({ issueId: 'i1', identifier: '1' });
    const res = await fetch(`${active.base}/v1/messages`, { method: 'POST' });
    assert.equal(res.status, 401);
  });
});

describe('CredentialProxy: expired cache + single-flight refresh', () => {
  let active: BootedProxy | null = null;
  afterEach(async () => {
    if (active) {
      await teardown(active);
      active = null;
    }
  });

  it('refreshes via `claude -p` when expiresAt is in the past', async () => {
    // Initial cache has an expired token. The refresher writes the rotated
    // tuple back to disk; the proxy re-reads and forwards the fresh token.
    const baseClock = 1_000_000;
    const expired = baseClock - 10_000;
    const refreshedExpiry = baseClock + 3_600_000;
    let booted: BootedProxy;
    booted = await bootProxy({
      initialToken: 'stale',
      initialExpiresMs: expired,
      now: () => baseClock,
    });
    active = booted;
    booted.setRefresher(async () => {
      await booted.writeToken('fresh-after-refresh', refreshedExpiry);
    });
    const reg = booted.proxy.register({ issueId: 'i1', identifier: '1' });
    booted.upstream.nextResponse({
      statusCode: 200,
      headers: {},
      body: jsonBody('{}'),
    });
    const res = await fetch(`${booted.base}/v1/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${reg.sentinel}` },
      body: '',
    });
    assert.equal(res.status, 200);
    assert.equal(booted.refresherCalls, 1, 'refresher must run exactly once');
    assert.equal(
      booted.upstream.calls[0]!.headers['authorization'],
      'Bearer fresh-after-refresh',
    );
  });

  it('single-flights concurrent expired-cache refresh attempts into one spawn', async () => {
    const baseClock = 2_000_000;
    const expired = baseClock - 10_000;
    const refreshedExpiry = baseClock + 3_600_000;
    let release: (() => void) | null = null;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const booted = await bootProxy({
      initialToken: 'stale',
      initialExpiresMs: expired,
      now: () => baseClock,
    });
    active = booted;
    booted.setRefresher(async () => {
      // Hold the refresh open until both inflight callers have hit refreshNow.
      // The single-flight collapse means only one `claude -p` spawn lands.
      await hold;
      await booted.writeToken('fresh-after-single-flight', refreshedExpiry);
    });
    const regA = booted.proxy.register({ issueId: 'iA', identifier: 'A' });
    const regB = booted.proxy.register({ issueId: 'iB', identifier: 'B' });
    booted.upstream.nextResponse({ statusCode: 200, headers: {}, body: jsonBody('{}') });
    booted.upstream.nextResponse({ statusCode: 200, headers: {}, body: jsonBody('{}') });
    const reqA = fetch(`${booted.base}/v1/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${regA.sentinel}` },
      body: '',
    });
    const reqB = fetch(`${booted.base}/v1/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${regB.sentinel}` },
      body: '',
    });
    // Let both requests reach ensureFreshToken before the refresher resolves.
    await new Promise((r) => setTimeout(r, 50));
    release!();
    const [resA, resB] = await Promise.all([reqA, reqB]);
    assert.equal(resA.status, 200);
    assert.equal(resB.status, 200);
    assert.equal(booted.refresherCalls, 1, 'expected single-flight collapse to 1 spawn');
  });
});

describe('CredentialProxy: header-override seam', () => {
  let active: BootedProxy | null = null;
  afterEach(async () => {
    if (active) {
      await teardown(active);
      active = null;
    }
  });

  it('default override is a no-op (body + headers pass through unchanged except auth)', async () => {
    active = await bootProxy({ initialToken: 'tok', initialExpiresMs: Date.now() + 3_600_000 });
    const reg = active.proxy.register({ issueId: 'i1', identifier: '1' });
    active.upstream.nextResponse({ statusCode: 200, headers: {}, body: jsonBody('{}') });
    const sent = '{"model":"opus","messages":[]}';
    const res = await fetch(`${active.base}/v1/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${reg.sentinel}`, 'content-type': 'application/json' },
      body: sent,
    });
    assert.equal(res.status, 200);
    const recorded = active.upstream.calls[0]!;
    assert.equal(recorded.body, sent);
    // Custom override headers should NOT have been injected by default.
    assert.equal(recorded.headers['x-app'], undefined);
    assert.equal(recorded.headers['anthropic-beta'], undefined);
    // The default no-op override does NOT impersonate the claude CLI's user-agent.
    // Node's fetch client sets its own default `user-agent: node` on the inbound
    // request, which the proxy passes through unchanged; assert it didn't get
    // rewritten to the claude CLI shape that the recorded-override path uses.
    assert.notEqual(recorded.headers['user-agent'], 'claude-cli/test');
  });

  it('override can rewrite the request body and inject identity headers', async () => {
    const override: HeaderOverride = ({ headers, body }) => {
      // Parse the body, inject metadata.user_id, re-serialize. This is the
      // exact shape future Anthropic fingerprint validators care about.
      const parsed = JSON.parse(body.toString('utf8') || '{}') as Record<string, unknown>;
      const meta = (parsed['metadata'] as Record<string, unknown>) ?? {};
      meta['user_id'] = 'host-rewritten-uuid';
      parsed['metadata'] = meta;
      const newBody = Buffer.from(JSON.stringify(parsed), 'utf8');
      return {
        headers: {
          ...headers,
          'user-agent': 'claude-cli/test',
          'x-app': 'cli',
          'anthropic-beta': 'oauth-2025-04-20,claude-code-20250219',
        },
        body: newBody,
      };
    };
    active = await bootProxy({
      initialToken: 'tok',
      initialExpiresMs: Date.now() + 3_600_000,
      override,
    });
    const reg = active.proxy.register({ issueId: 'i1', identifier: '1' });
    active.upstream.nextResponse({ statusCode: 200, headers: {}, body: jsonBody('{}') });
    await fetch(`${active.base}/v1/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${reg.sentinel}`, 'content-type': 'application/json' },
      body: '{"model":"opus"}',
    });
    const recorded = active.upstream.calls[0]!;
    assert.equal(recorded.headers['user-agent'], 'claude-cli/test');
    assert.equal(recorded.headers['x-app'], 'cli');
    assert.equal(
      recorded.headers['anthropic-beta'],
      'oauth-2025-04-20,claude-code-20250219',
    );
    const parsedBody = JSON.parse(recorded.body) as Record<string, unknown>;
    assert.deepEqual(parsedBody['metadata'], { user_id: 'host-rewritten-uuid' });
  });
});

describe('CredentialProxy: ratelimit + org headers forwarded to in-VM client', () => {
  let active: BootedProxy | null = null;
  afterEach(async () => {
    if (active) {
      await teardown(active);
      active = null;
    }
  });

  it('returns the upstream anthropic-ratelimit-unified-* + organization-id headers verbatim', async () => {
    active = await bootProxy({ initialToken: 'tok', initialExpiresMs: Date.now() + 3_600_000 });
    const reg = active.proxy.register({ issueId: 'i1', identifier: '1' });
    active.upstream.nextResponse({
      statusCode: 200,
      headers: {
        'content-type': 'application/json',
        'anthropic-organization-id': 'org-test-uuid',
        'anthropic-ratelimit-unified-5h-status': 'allowed',
        'anthropic-ratelimit-unified-5h-reset': '2026-05-28T22:00:00Z',
        'anthropic-ratelimit-unified-5h-utilization': '0.42',
        'anthropic-ratelimit-unified-7d-status': 'allowed',
        'anthropic-ratelimit-unified-7d-reset': '2026-06-04T22:00:00Z',
        'anthropic-ratelimit-unified-7d-utilization': '0.08',
      },
      body: jsonBody('{}'),
    });
    const res = await fetch(`${active.base}/v1/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${reg.sentinel}` },
      body: '',
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('anthropic-organization-id'), 'org-test-uuid');
    assert.equal(res.headers.get('anthropic-ratelimit-unified-5h-status'), 'allowed');
    assert.equal(res.headers.get('anthropic-ratelimit-unified-5h-utilization'), '0.42');
    assert.equal(res.headers.get('anthropic-ratelimit-unified-7d-utilization'), '0.08');
  });
});

describe('stageClaudeIdentity', () => {
  let prevHome: string | undefined;
  let tmpHome: string;
  let tmpWs: string;

  beforeEach(async () => {
    prevHome = process.env.HOME;
    tmpHome = await mkdtemp(path.join(os.tmpdir(), 'symphony-identity-home-'));
    tmpWs = await mkdtemp(path.join(os.tmpdir(), 'symphony-identity-ws-'));
    process.env.HOME = tmpHome;
  });

  afterEach(async () => {
    process.env.HOME = prevHome;
    await rm(tmpHome, { recursive: true, force: true });
    await rm(tmpWs, { recursive: true, force: true });
  });

  it('writes a minimal identity file with only oauthAccount.{accountUuid,organizationUuid}', async () => {
    // Host ~/.claude.json may carry a lot of operator-local state: prompt history pointers,
    // session_id, device_id, theme. None of that should reach the VM.
    await writeFile(
      path.join(tmpHome, '.claude.json'),
      JSON.stringify({
        oauthAccount: {
          accountUuid: 'ACCT-uuid-abc',
          organizationUuid: 'ORG-uuid-xyz',
          emailAddress: 'operator@example.com',
        },
        device_id: 'device-leak-me',
        session_id: 'session-leak-me',
        recent_paths: ['/operator/private/dir'],
        access_token_should_never_be_here: 'sk-ant-oat-fake-token',
        refreshToken: 'sk-ant-oar-fake-refresh',
      }),
      'utf8',
    );
    const staged = await stageClaudeIdentity(tmpWs);
    assert.ok(staged, 'staging should succeed when oauthAccount is present');
    const onDisk = await readFile(staged!.absPath, 'utf8');
    const parsed = JSON.parse(onDisk) as Record<string, unknown>;
    assert.deepEqual(parsed, {
      oauthAccount: {
        accountUuid: 'ACCT-uuid-abc',
        organizationUuid: 'ORG-uuid-xyz',
      },
    });
    // Defensive scan against the literal token + leakable identifier substrings.
    assert.equal(onDisk.includes('accessToken'), false);
    assert.equal(onDisk.includes('refreshToken'), false);
    assert.equal(onDisk.includes('device-leak-me'), false);
    assert.equal(onDisk.includes('session-leak-me'), false);
    assert.equal(onDisk.includes('sk-ant'), false);
    assert.equal(onDisk.includes('operator@example.com'), false);
    // Path matches the documented layout.
    assert.match(staged!.relPath, /symphony-runtime\/identity\/claude\.json$/);
    // Mode is restrictive (0600).
    const st = await stat(staged!.absPath);
    assert.equal(st.mode & 0o777, 0o600);
  });

  it('returns null when ~/.claude.json is missing', async () => {
    const result = await stageClaudeIdentity(tmpWs);
    assert.equal(result, null);
  });

  it('returns null when oauthAccount is malformed or missing UUIDs', async () => {
    await writeFile(
      path.join(tmpHome, '.claude.json'),
      JSON.stringify({ oauthAccount: { accountUuid: 'present-but-no-org' } }),
      'utf8',
    );
    const result = await stageClaudeIdentity(tmpWs);
    assert.equal(result, null);
  });
});
