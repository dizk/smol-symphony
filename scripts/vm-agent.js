#!/usr/bin/env node
// symphony-vm-agent — in-guest proxy that runs the ACP adapter and bridges its stdio
// to a TCP socket dialed back to the host orchestrator.
//
// Why TCP and not stdio: the previous version of this proxy bridged the in-VM adapter's
// stdio to the smolvm-exec stdio channel directly. That channel has a stdin-pump bug
// that wedges the adapter after the SDK's first `available_commands_update` notification
// (the in-guest reader never wakes for subsequent kernel events unless host stdin keeps
// writing). We worked around it for a while with a 1.5 s `\n` keepalive on the host
// side, but the proper fix is to stop piping ACP through smolvm-exec at all. This proxy
// dials back to a TCP listener on the host (`SYMPHONY_ACP_URL`), authenticates with a
// per-dispatch bearer token (`SYMPHONY_ACP_TOKEN`), and from then on talks ACP over a
// plain socket the host owns. smolvm-exec is reduced to a launcher: its stdio just
// carries this proxy's own diagnostic stderr and the adapter's stderr (`inherit`'d).
//
// The same proxy works under any sandbox tech that can launch a process with env vars
// and reach the host loopback — that's the portability win.
//
// Configuration (all required unless noted):
//   SYMPHONY_ACP_URL          — `tcp://host:port` to dial. `127.0.0.1:8788` under smolvm
//                               since the guest loopback is rewritten to the host
//                               loopback.
//   SYMPHONY_ACP_TOKEN        — opaque per-dispatch bearer; sent as `Bearer <token>\n`
//                               first line.
//   SYMPHONY_ADAPTER_BIN      — adapter executable to spawn (PATH-resolved).
//   SYMPHONY_ADAPTER_ARGS     — JSON array of extra argv. Optional; defaults to `[]`.
//   SYMPHONY_VM_AGENT_DEBUG   — optional; truthy → log lifecycle to stderr.
//
// Exit code: mirrors the adapter's exit when it exits, or 1 if the connection fails
// before the adapter starts.

import { connect as netConnect } from 'node:net';
import { spawn } from 'node:child_process';
import { constants as osConstants } from 'node:os';
import { URL } from 'node:url';

const requiredEnv = (name) => {
  const v = process.env[name];
  if (!v) {
    process.stderr.write(`symphony-vm-agent: ${name} is not set\n`);
    process.exit(2);
  }
  return v;
};

const acpUrl = requiredEnv('SYMPHONY_ACP_URL');
const acpToken = requiredEnv('SYMPHONY_ACP_TOKEN');
const adapterBin = requiredEnv('SYMPHONY_ADAPTER_BIN');

let adapterArgs = [];
const rawArgs = process.env.SYMPHONY_ADAPTER_ARGS;
if (rawArgs && rawArgs.length > 0) {
  try {
    const parsed = JSON.parse(rawArgs);
    if (!Array.isArray(parsed) || !parsed.every((a) => typeof a === 'string')) {
      throw new Error('must be a JSON array of strings');
    }
    adapterArgs = parsed;
  } catch (err) {
    process.stderr.write(`symphony-vm-agent: SYMPHONY_ADAPTER_ARGS invalid: ${err.message}\n`);
    process.exit(2);
  }
}

const debug = !!process.env.SYMPHONY_VM_AGENT_DEBUG;
const log = (msg) => {
  if (debug) process.stderr.write(`symphony-vm-agent: ${msg}\n`);
};

let parsed;
try {
  parsed = new URL(acpUrl);
} catch (err) {
  process.stderr.write(`symphony-vm-agent: SYMPHONY_ACP_URL invalid: ${err.message}\n`);
  process.exit(2);
}
if (parsed.protocol !== 'tcp:') {
  process.stderr.write(
    `symphony-vm-agent: SYMPHONY_ACP_URL must use tcp:// scheme (got ${parsed.protocol})\n`,
  );
  process.exit(2);
}
const acpHost = parsed.hostname;
const acpPort = parseInt(parsed.port, 10);
if (!Number.isFinite(acpPort) || acpPort <= 0) {
  process.stderr.write(`symphony-vm-agent: SYMPHONY_ACP_URL has no port\n`);
  process.exit(2);
}

log(`dialing ${acpHost}:${acpPort}`);

const socket = netConnect({ host: acpHost, port: acpPort, allowHalfOpen: false });
socket.setNoDelay(true);

// Pre-connect error handler: a TCP-level failure here means we couldn't reach the host
// bridge at all. Exit hard so symphony's host-side bridge-connect-timeout fires its own
// error path. We REMOVE this listener once `connect` fires; otherwise it would also kick
// in for post-auth errors and bypass startBridge()'s graceful adapter teardown.
const onPreConnectError = (err) => {
  process.stderr.write(`symphony-vm-agent: socket error: ${err.message}\n`);
  process.exit(1);
};
socket.once('error', onPreConnectError);

socket.once('connect', () => {
  socket.off('error', onPreConnectError);
  log('connected; sending bearer line');
  // The bearer line MUST end with a bare \n; the host expects exactly that delimiter.
  socket.write(`Bearer ${acpToken}\n`);
  startBridge();
});

function startBridge() {
  log(`spawn ${adapterBin} ${JSON.stringify(adapterArgs)}`);
  const child = spawn(adapterBin, adapterArgs, {
    // Adapter stdio: kernel pipes we fully own. Adapter stderr is inherited so any
    // crashes / warnings show up on this proxy's stderr → smolvm-exec stderr → host
    // orchestrator stderr capture. ACP frames flow ONLY over the TCP socket.
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  // Bridge socket ↔ adapter stdio with explicit `data` handlers + `write()` (NOT
  // stream.pipe()): we observed during the bisect that pipe() can interact badly with
  // certain transport quirks, so we forward bytes synchronously and let the kernel pipe
  // buffer absorb any short-term mismatch. With a clean TCP socket this is moot but
  // costs nothing and keeps the pattern uniform.
  socket.on('data', (chunk) => {
    try {
      child.stdin.write(chunk);
    } catch {
      /* adapter stdin closed while we were writing — see exit handler */
    }
  });
  child.stdout.on('data', (chunk) => {
    try {
      socket.write(chunk);
    } catch {
      /* host socket closed while we were writing — see exit handlers */
    }
  });
  // Half-closes: when the host closes its write side, the adapter should see stdin EOF;
  // when the adapter closes stdout, the host should see socket-half-close.
  socket.on('end', () => {
    log('host closed socket; ending adapter stdin');
    try {
      child.stdin.end();
    } catch {
      /* ignore */
    }
  });
  child.stdout.on('end', () => {
    log('adapter closed stdout; ending socket write side');
    try {
      socket.end();
    } catch {
      /* ignore */
    }
  });
  child.stdin.on('error', (err) => {
    if (err.code !== 'EPIPE') log(`adapter stdin error: ${err.message}`);
  });
  socket.on('error', (err) => {
    log(`socket error after auth: ${err.message}`);
    try {
      child.kill('SIGTERM');
    } catch {
      /* ignore */
    }
  });
  child.on('error', (err) => {
    process.stderr.write(`symphony-vm-agent: failed to spawn adapter: ${err.message}\n`);
    try {
      socket.end();
    } catch {
      /* ignore */
    }
    process.exit(127);
  });
  // Use `close` not `exit`: `exit` fires when the adapter process terminates but its
  // stdio pipes may still have buffered bytes our `data` handlers haven't drained yet.
  // `close` fires only after all stdio streams have been closed AND drained, so by then
  // every byte the adapter wrote has been forwarded to our socket.write() above. We
  // still need to wait for the socket itself to flush those forwarded bytes to the
  // kernel before exiting, hence the `socket.end(callback)` pattern: end() signals
  // shutdown and the callback fires after the write buffer has drained.
  child.on('close', (code, signal) => {
    log(`adapter close code=${code} signal=${signal}`);
    const finalize = () => {
      if (signal) {
        const sig = osConstants.signals[signal] ?? 0;
        process.exit(128 + sig);
      }
      process.exit(code ?? 0);
    };
    try {
      socket.end(finalize);
    } catch {
      finalize();
    }
  });
  // Forward host-side termination signals to the adapter.
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    process.on(sig, () => {
      log(`received ${sig}; forwarding to adapter`);
      try {
        child.kill(sig);
      } catch {
        /* ignore */
      }
    });
  }
}
