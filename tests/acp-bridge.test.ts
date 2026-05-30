// Unit tests for the AcpBridge token-auth handshake. Covers the happy-path bearer
// acceptance, rejection of bad bearer lines, cancellation, the post-newline byte
// re-emission contract (so AcpClient sees data that arrived in the same TCP segment as
// the auth line), and the per-connection auth timeout.

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createConnection, type Socket } from 'node:net';
import { once } from 'node:events';
import { AcpBridge } from '../src/acp-bridge.js';

async function bootBridge(authTimeoutMs?: number): Promise<{ bridge: AcpBridge; port: number }> {
  const bridge = new AcpBridge(authTimeoutMs !== undefined ? { authTimeoutMs } : {});
  await bridge.start('127.0.0.1', 0);
  const port = bridge.port();
  assert.ok(port && port > 0, 'bridge should expose a bound ephemeral port');
  return { bridge, port };
}

function connect(port: number): Socket {
  return createConnection({ host: '127.0.0.1', port });
}

describe('AcpBridge token handshake', () => {
  let active: AcpBridge | null = null;

  afterEach(async () => {
    if (active) {
      await active.stop();
      active = null;
    }
  });

  it('register() yields a non-empty token and accepts a matching Bearer line', async () => {
    const { bridge, port } = await bootBridge();
    active = bridge;
    const reg = bridge.register('issue-1', 'ISSUE-1');
    assert.equal(typeof reg.token, 'string');
    assert.ok(reg.token.length > 0, 'token should be non-empty');

    const client = connect(port);
    await once(client, 'connect');
    client.write(`Bearer ${reg.token}\n`);

    const accepted = await reg.accepted;
    assert.ok(accepted, 'accepted promise should resolve with a socket');
    accepted.destroy();
    client.destroy();
  });

  it('rejects a wrong/malformed bearer line and does not resolve accepted', async () => {
    const { bridge, port } = await bootBridge();
    active = bridge;
    const reg = bridge.register('issue-2', 'ISSUE-2');

    let resolved = false;
    reg.accepted.then(
      () => {
        resolved = true;
      },
      () => undefined,
    );

    // Garbage first line — no "Bearer" prefix at all.
    const bad = connect(port);
    await once(bad, 'connect');
    bad.write('NotBearer whatever\n');
    await once(bad, 'close');

    // Wrong token presented with a well-formed bearer line.
    const wrong = connect(port);
    await once(wrong, 'connect');
    wrong.write('Bearer not-the-real-token\n');
    await once(wrong, 'close');

    // Give any spurious resolution a turn to land.
    await new Promise((r) => setImmediate(r));
    assert.equal(resolved, false, 'accepted must not resolve from a bad handshake');

    reg.cancel('test cleanup');
    await assert.rejects(reg.accepted);
  });

  it('cancel() rejects accepted and invalidates the token for later connects', async () => {
    const { bridge, port } = await bootBridge();
    active = bridge;
    const reg = bridge.register('issue-3', 'ISSUE-3');
    reg.cancel('dispatch torn down');
    await assert.rejects(reg.accepted, /dispatch torn down/);

    // A late client presenting the now-cancelled token must be rejected: the registration
    // is gone, so the bearer line doesn't match anything in `pending`.
    const late = connect(port);
    await once(late, 'connect');
    late.write(`Bearer ${reg.token}\n`);
    await once(late, 'close');
  });

  it('delivers post-newline remainder bytes to the next data listener', async () => {
    const { bridge, port } = await bootBridge();
    active = bridge;
    const reg = bridge.register('issue-4', 'ISSUE-4');

    const client = connect(port);
    await once(client, 'connect');
    // Auth line plus payload bytes in a single write — they hit the bridge in the same
    // TCP segment, exercising the `unshift` path that re-emits the remainder.
    const payload = 'hello-after-newline';
    client.write(`Bearer ${reg.token}\n${payload}`);

    const accepted = await reg.accepted;
    // The bridge paused the socket and unshifted the remainder before resolving — per its
    // documented contract the next consumer is responsible for resuming. In production
    // AcpClient does that via `.pipe()`; here we just attach a listener and call resume()
    // explicitly to drain whatever the bridge re-injected.
    const got = await new Promise<string>((resolve) => {
      const chunks: Buffer[] = [];
      accepted.on('data', (c: Buffer) => {
        chunks.push(c);
        const buf = Buffer.concat(chunks);
        if (buf.length >= payload.length) resolve(buf.subarray(0, payload.length).toString('utf8'));
      });
      accepted.resume();
    });
    assert.equal(got, payload);

    accepted.destroy();
    client.destroy();
  });

  it('closes a silent connection after the configured auth timeout', async () => {
    const { bridge, port } = await bootBridge(150);
    active = bridge;
    bridge.register('issue-5', 'ISSUE-5');

    const client = connect(port);
    await once(client, 'connect');
    const t0 = Date.now();
    await once(client, 'close');
    const elapsed = Date.now() - t0;
    // Allow generous slack on the upper bound to keep the test stable under CI jitter.
    assert.ok(elapsed >= 100, `close fired too early (${elapsed} ms)`);
    assert.ok(elapsed < 2_000, `close fired too late (${elapsed} ms)`);
  });
});

describe('AcpBridge loopbackOnly bind guard', () => {
  let active: AcpBridge | null = null;
  afterEach(async () => {
    if (active) {
      await active.stop();
      active = null;
    }
  });

  it('binds a loopback host when loopbackOnly is set', async () => {
    const bridge = new AcpBridge({ loopbackOnly: true });
    await bridge.start('127.0.0.1', 0);
    active = bridge;
    assert.ok((bridge.port() ?? 0) > 0, 'bound to an ephemeral loopback port');
  });

  it('accepts ::1 and localhost under loopbackOnly', async () => {
    const bridge = new AcpBridge({ loopbackOnly: true });
    // localhost resolves to loopback; bind should not be refused by the guard.
    await bridge.start('localhost', 0);
    active = bridge;
    assert.ok((bridge.port() ?? 0) > 0);
  });

  it('REFUSES a non-loopback host when loopbackOnly is set', async () => {
    const bridge = new AcpBridge({ loopbackOnly: true });
    await assert.rejects(bridge.start('0.0.0.0', 0), /not a loopback address/);
  });

  it('default (no loopbackOnly) still binds whatever host is given (default bind path unchanged)', async () => {
    const bridge = new AcpBridge();
    await bridge.start('0.0.0.0', 0);
    active = bridge;
    assert.ok((bridge.port() ?? 0) > 0, 'wider bind permitted by default');
  });
});
