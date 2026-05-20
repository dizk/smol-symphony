// ACP TCP bridge — host-side transport for the in-VM ACP adapter.
//
// Before this module, symphony spoke ACP to the in-VM adapter over the smolvm-exec
// stdio channel directly. Two problems with that:
//
//   1. smolvm-exec's stdin pump does not reliably wake the in-VM reader for new
//      event-loop iterations unless host-side stdin keeps writing — so once symphony
//      stopped writing (after `session/prompt`), the adapter would freeze waiting for
//      events that the kernel had already delivered. The previous workaround was a
//      1.5 s `\n` keepalive on the smolvm-exec stdin.
//
//   2. The smolvm-exec stdio path tightly couples symphony to smolvm. If we ever swap
//      smolvm out for another sandbox (firecracker, gvisor, Kubernetes job, …) we'd
//      have to relearn the same per-sandbox-stdio quirks.
//
// This bridge replaces that path: symphony binds a TCP listener; the in-VM `vm-agent`
// dials back, authenticates with a per-dispatch bearer token, and from then on ACP
// JSON-RPC frames flow over a regular TCP socket. smolvm-exec is reduced to a process
// launcher — its stdio is used only for diagnostic stderr from the in-VM agent. Any
// sandbox that can (a) exec a process with env vars and (b) reach the host loopback
// can now run our agent stack.
//
// Lifecycle:
//   1. Orchestrator calls `bridge.register(issueId)` BEFORE launching the VM.
//      Returns a `{ token, accepted }` pair; `token` goes into the launch env as
//      SYMPHONY_ACP_TOKEN.
//   2. Launch command exec's `node /opt/symphony/vm-agent.mjs`, which dials
//      `tcp://<bridge.host>:<bridge.port>` and writes `Bearer <token>\n` as its first
//      line.
//   3. Bridge accepts the socket, parses the bearer line, looks up the registration,
//      validates the token (constant time), and resolves the registration's
//      `accepted` promise with the now-authenticated socket.
//   4. Caller hands the socket to AcpClient as its stdin/stdout.
//   5. On attempt teardown the caller closes the socket; vm-agent reacts by killing
//      the adapter and exiting; smolvm-exec sees the in-VM agent exit; the orchestrator
//      destroys the VM (per current lifecycle).

import { createServer, type Server, type Socket } from 'node:net';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { log } from './logging.js';

interface Registration {
  issueId: string;
  identifier: string;
  token: string;
  resolve: (socket: Socket) => void;
  reject: (err: Error) => void;
  /** Set when the awaiter has either received a socket or has timed out / been cancelled. */
  settled: boolean;
}

export interface AcpBridgeRegistration {
  /** Bearer token the in-VM agent must send as its first line. */
  token: string;
  /** Resolves with the authenticated socket once the in-VM agent connects. */
  accepted: Promise<Socket>;
  /** Cancels the registration if the dispatch is torn down before the agent connects. */
  cancel: (reason: string) => void;
}

export class AcpBridge {
  private server: Server | null = null;
  private boundPort: number | null = null;
  // Pending registrations keyed by token. Lookups are constant time because we walk and
  // compare with `timingSafeEqual`; the map is just for fast membership filtering of
  // expired entries during teardown.
  private pending = new Map<string, Registration>();
  // Live, post-auth sockets we've handed to callers. We track them so `stop()` can force
  // them closed instead of waiting on `server.close()` to drain — without that, SIGTERM
  // during an active attempt would block indefinitely while the adapter side fails to
  // unwind. Added in response to a review finding that pointed out the shutdown hang.
  private liveSockets = new Set<Socket>();
  // Pre-auth sockets: connected but not yet authenticated (or failing auth). Tracked so
  // stop() can destroy them too; otherwise `server.close()` waits for the 10s auth
  // deadline to expire on each idle connection before SIGTERM completes.
  private preAuthSockets = new Set<Socket>();
  private stopped = false;

  /**
   * Start listening on (host, port). Pass 0 for an ephemeral port; the actually-bound
   * port is available via `port()` and is what the in-VM agent must dial. Throws on
   * bind failure so the symphony bootstrap can surface the error early.
   */
  async start(host: string, port: number): Promise<void> {
    if (this.server) return;
    this.server = createServer((socket) => this.handleConnection(socket));
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        this.server?.removeListener('listening', onListening);
        reject(err);
      };
      const onListening = () => {
        this.server?.removeListener('error', onError);
        resolve();
      };
      this.server!.once('error', onError);
      this.server!.once('listening', onListening);
      this.server!.listen(port, host);
    });
    const addr = this.server.address() as AddressInfo | string | null;
    if (typeof addr === 'object' && addr !== null) {
      this.boundPort = addr.port;
    }
    // Re-attach a permanent error handler so post-bind runtime errors don't crash the
    // process — they land in the log and the listener stays up.
    this.server.on('error', (err) => log.warn('acp bridge runtime error', { error: err.message }));
    log.info('acp bridge listening', { host, port: this.boundPort });
  }

  /**
   * Actually-bound port (differs from the requested port when 0 was passed). Returns
   * `null` before `start()` has bound the listener.
   */
  port(): number | null {
    return this.boundPort;
  }

  /**
   * Register a pending dispatch. Returns a token to inject into the in-VM agent's env
   * and a promise that resolves when the agent connects + authenticates. The promise
   * rejects if `cancel()` is called or if `stop()` runs before the agent connects.
   */
  register(issueId: string, identifier: string): AcpBridgeRegistration {
    if (this.stopped) {
      throw new Error('acp bridge is stopped');
    }
    if (!this.server) {
      throw new Error('acp bridge is not listening; call start() first');
    }
    const token = randomBytes(24).toString('base64url');
    let resolveFn!: (s: Socket) => void;
    let rejectFn!: (e: Error) => void;
    const accepted = new Promise<Socket>((res, rej) => {
      resolveFn = res;
      rejectFn = rej;
    });
    // Defensive: attach an internal noop catch so a `cancel()` that lands before the
    // caller has wired up its own handler can't escalate into an unhandled-rejection
    // crash. The caller's eventual `await accepted` / `.then()` still sees the rejection
    // via its own handler chain — this `.catch` is a separate promise consumer and only
    // exists to keep Node's unhandled-rejection tracking quiet.
    accepted.catch(() => undefined);
    const reg: Registration = {
      issueId,
      identifier,
      token,
      resolve: (s) => {
        if (reg.settled) return;
        reg.settled = true;
        this.pending.delete(token);
        resolveFn(s);
      },
      reject: (err) => {
        if (reg.settled) return;
        reg.settled = true;
        this.pending.delete(token);
        rejectFn(err);
      },
      settled: false,
    };
    this.pending.set(token, reg);
    log.debug('acp bridge registered', { issue_id: issueId, issue_identifier: identifier });
    return {
      token,
      accepted,
      cancel: (reason) => reg.reject(new Error(`acp bridge cancel: ${reason}`)),
    };
  }

  /**
   * Stop accepting new connections, reject all pending registrations, and force-close
   * any live sockets. We deliberately tear down live sockets rather than waiting on
   * them — `server.close()` blocks until every active connection ends, and an unhappy
   * adapter / abruptly-killed VM can leave sockets half-open and stall SIGTERM
   * indefinitely. The runner's cleanup path already destroys its end on attempt exit,
   * so the only time this matters is symphony shutdown while an attempt is mid-flight.
   */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    for (const reg of [...this.pending.values()]) {
      reg.reject(new Error('acp bridge stopped'));
    }
    this.pending.clear();
    // Tear down BOTH pre-auth and live sockets. Pre-auth left to the 10s auth deadline
    // would delay SIGTERM by exactly that long for every idle client (e.g. a port scan
    // or a broken in-VM proxy that connects but never sends the bearer).
    for (const s of [...this.preAuthSockets, ...this.liveSockets]) {
      try {
        s.destroy();
      } catch {
        /* ignore */
      }
    }
    this.preAuthSockets.clear();
    this.liveSockets.clear();
    const srv = this.server;
    this.server = null;
    if (!srv) return;
    await new Promise<void>((resolve) => srv.close(() => resolve()));
    log.info('acp bridge stopped');
  }

  /**
   * Per-connection handshake. We accumulate bytes on the socket until we see the first
   * newline, parse `Bearer <token>` from that line, validate against a pending
   * registration in constant time, and either hand the socket back to the awaiter
   * (consuming any post-newline bytes that arrived in the same packet) or close.
   */
  private handleConnection(socket: Socket): void {
    socket.setNoDelay(true);
    // Track every accepted connection (even pre-auth) so stop() can tear them down.
    // Removed from preAuthSockets either when fail() destroys them or when the bearer
    // handshake succeeds and they move into liveSockets.
    this.preAuthSockets.add(socket);
    socket.once('close', () => this.preAuthSockets.delete(socket));
    let buf = Buffer.alloc(0);
    let handled = false;
    const fail = (reason: string) => {
      if (handled) return;
      handled = true;
      log.warn('acp bridge rejected connection', {
        remote: `${socket.remoteAddress}:${socket.remotePort}`,
        reason,
      });
      // Destroy (not just end) the socket. A misbehaving peer that ignores our half-close
      // would otherwise keep the connection counted by `server.close()` and stall
      // symphony shutdown indefinitely.
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
    };
    // Authentication deadline: if the in-VM agent doesn't send the bearer line within
    // 10s of connecting, the connection is almost certainly stuck or malformed. The
    // dispatch's own timeout would also catch this; this is just a tighter guard.
    const authDeadline = setTimeout(() => fail('auth timeout'), 10_000);
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const nl = buf.indexOf(0x0a);
      if (nl === -1) {
        // Cap the unauthenticated buffer at 1 KiB so a misbehaving client can't grow
        // memory before failing auth.
        if (buf.length > 1024) {
          fail('auth header too large');
        }
        return;
      }
      const headerLine = buf.subarray(0, nl).toString('utf8').trim();
      const remainder = buf.subarray(nl + 1);
      clearTimeout(authDeadline);
      socket.removeListener('data', onData);
      const match = /^Bearer\s+(\S+)$/.exec(headerLine);
      if (!match) {
        fail('malformed bearer line');
        return;
      }
      const presented = match[1]!;
      // Constant-time compare against each pending token. With max_concurrent_agents = 1
      // there's typically ONE pending entry, but loop anyway for correctness.
      let matched: Registration | null = null;
      const presentedBuf = Buffer.from(presented, 'utf8');
      for (const reg of this.pending.values()) {
        const expected = Buffer.from(reg.token, 'utf8');
        if (expected.length !== presentedBuf.length) continue;
        if (timingSafeEqual(expected, presentedBuf)) {
          matched = reg;
          break;
        }
      }
      if (!matched) {
        fail('invalid token');
        return;
      }
      handled = true;
      log.info('acp bridge accepted', {
        issue_id: matched.issueId,
        issue_identifier: matched.identifier,
        remote: `${socket.remoteAddress}:${socket.remotePort}`,
      });
      // CRITICAL: the temporary `data` listener above put the socket in flowing mode.
      // Removing that listener does NOT auto-pause it — any bytes already buffered in
      // the kernel or arriving immediately after will be re-emitted in flowing mode and
      // dropped if no listener is attached yet, which is exactly the window between
      // `resolve(socket)` and AcpClient's microtask wiring up `ndJsonStream`. Pause
      // explicitly so the next consumer is responsible for resuming. `unshift` puts the
      // residual bytes (bearer + ACP-frame in one packet case) back in front of any
      // subsequent kernel data.
      socket.pause();
      if (remainder.length > 0) {
        socket.unshift(remainder);
      }
      // Move from pre-auth tracking into live tracking. Both sets are tied into stop()
      // for forced teardown on shutdown.
      this.preAuthSockets.delete(socket);
      this.liveSockets.add(socket);
      socket.once('close', () => this.liveSockets.delete(socket));
      matched.resolve(socket);
    };
    socket.on('data', onData);
    socket.on('error', (err) => {
      // Connection errors before auth get swallowed; after auth the AcpClient owns the
      // socket and will see the error itself.
      if (!handled) {
        clearTimeout(authDeadline);
        fail(`socket error: ${err.message}`);
      }
    });
  }
}
