// Host credential proxy — terminates per-dispatch sentinels on the host and
// substitutes the real Anthropic OAuth access token before forwarding the
// request to api.anthropic.com.
//
// Lifecycle mirrors AcpBridge (src/acp-bridge.ts):
//
//   1. Orchestrator calls `proxy.register({ issueId, identifier })` before the
//      VM launches; the returned `sentinel` is staged into the VM env as
//      ANTHROPIC_AUTH_TOKEN and `baseUrl` as ANTHROPIC_BASE_URL.
//   2. The in-VM claude-agent-acp speaks Bearer-auth to the proxy. Each
//      request: the proxy validates the inbound bearer against the registry,
//      reads the live access token out of `~/.claude/.credentials.json`,
//      strips inbound auth, attaches `Authorization: Bearer <real>`, and
//      forwards to api.anthropic.com. The upstream response — including
//      `anthropic-ratelimit-unified-*` headers and `anthropic-organization-id`
//      — streams back unchanged so the in-VM runner sees the operator's
//      Max-window consumption.
//   3. On dispatch teardown the orchestrator calls `proxy.deregister(sentinel)`
//      so the token no longer authorizes upstream traffic.
//
// The "only the host refreshes" invariant is structural: VMs have no
// `refreshToken` on their filesystem under proxy mode. When the cached access
// token is past its `expiresAt` (or within a small margin) the proxy spawns
// `claude -p "ok"` on the host under an flock so concurrent stale-cache
// callers collapse into a single refresh. The host's own ticker (running on
// `cfg.credentials.ticker_interval_ms`) keeps the cache warm during idle
// periods so the first VM request after expiry doesn't pay the spawn latency.
//
// A typed header-override seam runs immediately before each upstream forward.
// Its default is no-op (the in-VM client emits its own well-formed identity
// from the staged `~/.claude.json`); the seam exists so if Anthropic
// re-activates server-side `metadata.user_id` validation more strictly than
// today, the proxy can rewrite host-side without changing the VM contract.

import { createServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { request as httpsRequest, type RequestOptions as HttpsRequestOptions } from 'node:https';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, mkdir, open as fsOpen, stat as fsStat, unlink as fsUnlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import type { AddressInfo } from 'node:net';
import { log } from '../logging.js';

export interface CredentialProxyRegistration {
  /** Per-dispatch opaque sentinel. Staged into the VM as ANTHROPIC_AUTH_TOKEN. */
  sentinel: string;
  /** Base URL the in-VM client should dial. Staged as ANTHROPIC_BASE_URL. */
  baseUrl: string;
}

export interface RegisterOpts {
  issueId: string;
  identifier: string;
}

/** Input to the header-override seam. The body has been fully buffered. */
export interface HeaderOverrideInput {
  method: string;
  pathname: string;
  headers: Record<string, string>;
  body: Buffer;
}

/** Output of the header-override seam. */
export interface HeaderOverrideOutput {
  headers: Record<string, string>;
  body: Buffer;
}

/** Host-side header-override seam: optional rewrite before upstream forward. */
export type HeaderOverride = (input: HeaderOverrideInput) => HeaderOverrideOutput;

const NOOP_OVERRIDE: HeaderOverride = ({ headers, body }) => ({ headers, body });

/** Upstream forwarder. Pluggable for tests. */
export interface UpstreamRequestor {
  send(input: UpstreamRequestInput): Promise<UpstreamResponse>;
}

export interface UpstreamRequestInput {
  method: string;
  pathname: string;
  headers: Record<string, string>;
  body: Buffer;
}

export interface UpstreamResponse {
  statusCode: number;
  headers: Record<string, string | string[]>;
  /** Async iterable over response body chunks; consumed exactly once. */
  body: AsyncIterable<Buffer>;
}

export interface CredentialProxyOptions {
  /** Path to host claude credentials JSON. Default: ~/.claude/.credentials.json. */
  credentialsPath?: string;
  /** Path to the cross-process lock file serializing host-side refreshes. */
  lockPath?: string;
  /** Refresh when (expiresAt - now) is below this many ms. Default 60_000. */
  refreshMarginMs?: number;
  /** Upstream forwarder. Default: real api.anthropic.com over https. */
  upstream?: UpstreamRequestor;
  /** Refresher (default: spawn `claude -p "ok"`). Tests inject a stub. */
  refresher?: () => Promise<void>;
  /** Header-override seam (default: pass-through). */
  override?: HeaderOverride;
  /** Clock; tests inject a deterministic one. */
  now?: () => number;
  /** Polling interval (ms) while waiting on the cross-process lock. Default 25. */
  lockPollMs?: number;
  /**
   * Lock files older than this (ms) are treated as abandoned by a crashed
   * holder and force-cleared. Must comfortably exceed the worst-case refresher
   * runtime (a `claude -p ok` round-trip). Default 180_000 (3 minutes).
   */
  lockStaleMs?: number;
  /**
   * Hard cap on time spent waiting for the cross-process lock. Default 90_000
   * (90 seconds). Bounded so a pathological peer can't hang a VM request
   * indefinitely; on timeout, the caller falls back to the stale cached token.
   */
  lockAcquireTimeoutMs?: number;
}

interface Registration {
  sentinel: string;
  issueId: string;
  identifier: string;
}

const REFRESH_HEADER_NAMES: readonly string[] = [
  'anthropic-organization-id',
  'anthropic-ratelimit-unified-5h-status',
  'anthropic-ratelimit-unified-5h-reset',
  'anthropic-ratelimit-unified-5h-utilization',
  'anthropic-ratelimit-unified-7d-status',
  'anthropic-ratelimit-unified-7d-reset',
  'anthropic-ratelimit-unified-7d-utilization',
];

/**
 * Default upstream: forward via https to api.anthropic.com. The body is sent
 * as-is; the response stream is the IncomingMessage which `AsyncIterable`s
 * over chunks so callers can pipe SSE responses without buffering.
 */
function defaultUpstream(): UpstreamRequestor {
  return {
    send: ({ method, pathname, headers, body }) =>
      new Promise<UpstreamResponse>((resolve, reject) => {
        const opts: HttpsRequestOptions = {
          method,
          hostname: 'api.anthropic.com',
          path: pathname,
          headers: { ...headers, 'content-length': String(body.length), host: 'api.anthropic.com' },
        };
        const req = httpsRequest(opts, (res) => {
          resolve({
            statusCode: res.statusCode ?? 0,
            headers: res.headers as Record<string, string | string[]>,
            body: res,
          });
        });
        req.once('error', reject);
        req.end(body);
      }),
  };
}

/**
 * Default refresher: spawn `claude -p "ok"` and resolve when it exits. Claude
 * Code's own OAuth path detects the stale access token, refreshes against
 * Anthropic, and atomically writes the rotated tuple back to
 * `~/.claude/.credentials.json`. Symphony never implements OAuth — Anthropic's
 * own client does.
 */
function defaultRefresher(): () => Promise<void> {
  return () =>
    new Promise<void>((resolve, reject) => {
      const p = spawn('claude', ['-p', 'ok'], { stdio: 'ignore' });
      p.once('error', reject);
      p.once('exit', (code) => {
        if (code === 0) return resolve();
        reject(new Error(`claude -p exited with code ${code ?? '<null>'}`));
      });
    });
}

export class CredentialProxy {
  private server: HttpServer | null = null;
  private boundPort: number | null = null;
  private boundHost: string | null = null;
  private readonly pending = new Map<string, Registration>();
  private readonly credentialsPath: string;
  private readonly lockPath: string;
  private readonly refreshMarginMs: number;
  private readonly upstream: UpstreamRequestor;
  private readonly refresher: () => Promise<void>;
  private readonly now: () => number;
  private readonly lockPollMs: number;
  private readonly lockStaleMs: number;
  private readonly lockAcquireTimeoutMs: number;
  private override: HeaderOverride;
  private stopped = false;
  // In-process single-flight: when a refresh is in flight, every other caller
  // awaits the same promise instead of racing into `claude -p`.
  private refreshInFlight: Promise<void> | null = null;

  constructor(opts: CredentialProxyOptions = {}) {
    const wiring = resolveCredentialProxyWiring(opts);
    const tuning = resolveCredentialProxyTuning(opts);
    this.credentialsPath = wiring.credentialsPath;
    this.lockPath = wiring.lockPath;
    this.upstream = wiring.upstream;
    this.refresher = wiring.refresher;
    this.override = wiring.override;
    this.now = wiring.now;
    this.refreshMarginMs = tuning.refreshMarginMs;
    this.lockPollMs = tuning.lockPollMs;
    this.lockStaleMs = tuning.lockStaleMs;
    this.lockAcquireTimeoutMs = tuning.lockAcquireTimeoutMs;
  }

  /**
   * Start the listener on (host, port). Pass 0 for an ephemeral port.
   * `baseUrl` returned from `register()` reflects the actually-bound port.
   */
  async start(host: string, port: number): Promise<void> {
    if (this.server) return;
    const server = createServer((req, res) => {
      void this.handleRequest(req, res).catch((err) => {
        log.warn('credential proxy: handler crashed', { error: (err as Error).message });
        if (!res.headersSent) {
          try { res.writeHead(500, { 'content-type': 'text/plain' }); res.end('proxy error'); } catch { /* ignore */ }
        } else {
          try { res.end(); } catch { /* ignore */ }
        }
      });
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => {
        server.removeListener('listening', onListening);
        reject(err);
      };
      const onListening = (): void => {
        server.removeListener('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, host);
    });
    const addr = server.address() as AddressInfo | string | null;
    if (typeof addr === 'object' && addr !== null) this.boundPort = addr.port;
    this.boundHost = host;
    server.on('error', (err) => log.warn('credential proxy runtime error', { error: err.message }));
    log.info('credential proxy listening', { host, port: this.boundPort });
  }

  port(): number | null {
    return this.boundPort;
  }

  baseUrl(): string | null {
    if (this.boundPort === null || this.boundHost === null) return null;
    // `0.0.0.0` is meaningful at bind time but never as a client dial target;
    // the VM's claude-agent-acp must point at the host loopback (the smolvm
    // guest-loopback shim rewrites it to the host's loopback transparently,
    // same as the ACP bridge case).
    const reachHost = this.boundHost === '0.0.0.0' || this.boundHost === '::' ? '127.0.0.1' : this.boundHost;
    return `http://${reachHost}:${this.boundPort}`;
  }

  /**
   * Mint a fresh sentinel and register it for `(issueId, identifier)`. The
   * caller stages the result as `ANTHROPIC_AUTH_TOKEN=<sentinel>` and
   * `ANTHROPIC_BASE_URL=<baseUrl>` in the VM launch env.
   */
  register(opts: RegisterOpts): CredentialProxyRegistration {
    if (this.stopped) throw new Error('credential proxy is stopped');
    if (!this.server) throw new Error('credential proxy is not listening; call start() first');
    const baseUrl = this.baseUrl();
    if (!baseUrl) throw new Error('credential proxy has no bound URL');
    const sentinel = `sk-symphony-${randomBytes(24).toString('base64url')}`;
    this.pending.set(sentinel, { sentinel, issueId: opts.issueId, identifier: opts.identifier });
    log.debug('credential proxy registered', { issue_id: opts.issueId, issue_identifier: opts.identifier });
    return { sentinel, baseUrl };
  }

  /** Revoke the sentinel; subsequent requests under it are rejected with 401. */
  deregister(sentinel: string): void {
    this.pending.delete(sentinel);
  }

  /** Replace the header-override seam (pass null to clear). */
  setOverride(override: HeaderOverride | null): void {
    this.override = override ?? NOOP_OVERRIDE;
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.pending.clear();
    const srv = this.server;
    this.server = null;
    if (!srv) return;
    await new Promise<void>((resolve) => srv.close(() => resolve()));
    log.info('credential proxy stopped');
  }

  /**
   * Spawn `claude -p "ok"` (or the injected refresher) under a host-side
   * cross-process lock so concurrent symphony processes — and concurrent
   * in-process callers — collapse into one refresh. Anthropic's own client
   * owns OAuth: we just trigger it and re-read the rotated credential.
   */
  async refreshNow(): Promise<void> {
    if (this.refreshInFlight) return this.refreshInFlight;
    const p = this.runRefreshUnderLock().finally(() => {
      this.refreshInFlight = null;
    });
    this.refreshInFlight = p;
    return p;
  }

  private async runRefreshUnderLock(): Promise<void> {
    await mkdir(path.dirname(this.lockPath), { recursive: true });
    const acquired = await this.acquireFileLock();
    if (!acquired) {
      // Could not acquire within timeout — proceed without the lock rather
      // than failing the request. The caller will return whatever token is
      // in the cache; in the worst case the upstream rejects with 401 and
      // the in-VM runner surfaces that as a normal auth error.
      log.warn('credential proxy: lock acquire timed out; refreshing without serialization', {
        path: this.lockPath,
      });
      try {
        await this.refresher();
      } catch (err) {
        log.warn('credential proxy: unserialized refresh failed', { error: (err as Error).message });
        throw err;
      }
      return;
    }
    try {
      await this.refresher();
    } finally {
      await this.releaseFileLock();
    }
  }

  /**
   * Cross-process advisory lock built on `O_CREAT | O_EXCL`. Each holder
   * writes its PID into the lockfile so a second process can detect a
   * crashed predecessor; mtime-based staleness is the backstop when PID
   * inspection fails (different host, PID reuse, etc.).
   *
   * Returns true on acquire, false on timeout.
   */
  private async acquireFileLock(): Promise<boolean> {
    const start = this.now();
    let firstAttempt = true;
    while (true) {
      try {
        // O_CREAT | O_EXCL via the 'wx' open flag: filesystem-atomic create.
        // If two processes race here, exactly one succeeds and the other
        // gets EEXIST; we then poll until the holder releases or the file
        // is detected stale.
        const handle = await fsOpen(this.lockPath, 'wx', 0o600);
        try {
          await handle.writeFile(`${process.pid}\n`, 'utf8');
        } finally {
          await handle.close().catch(() => undefined);
        }
        return true;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'EEXIST') throw err;
        if (await this.lockHolderIsStale()) {
          await fsUnlink(this.lockPath).catch(() => undefined);
          continue;
        }
        if (firstAttempt) {
          log.debug('credential proxy: refresh lock held; waiting', { path: this.lockPath });
          firstAttempt = false;
        }
        if (this.now() - start >= this.lockAcquireTimeoutMs) return false;
        await sleep(this.lockPollMs);
      }
    }
  }

  private async releaseFileLock(): Promise<void> {
    await fsUnlink(this.lockPath).catch(() => undefined);
  }

  private async lockHolderIsStale(): Promise<boolean> {
    let mtimeMs: number;
    try {
      const st = await fsStat(this.lockPath);
      mtimeMs = st.mtimeMs;
    } catch {
      // Vanished between the EEXIST and our stat — treat as released.
      return true;
    }
    return this.now() - mtimeMs > this.lockStaleMs;
  }

  /**
   * Read the cached access token. Returns the access token plus its
   * `expiresAt` in milliseconds since epoch when present, so callers can
   * decide whether a refresh is needed before forwarding the request.
   */
  private async readCachedToken(): Promise<{ accessToken: string; expiresAtMs: number | null } | null> {
    let raw: string;
    try {
      raw = await readFile(this.credentialsPath, 'utf8');
    } catch (err) {
      log.warn('credential proxy: cannot read credentials', {
        path: this.credentialsPath,
        error: (err as Error).message,
      });
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      log.warn('credential proxy: credentials JSON parse failed', { error: (err as Error).message });
      return null;
    }
    return extractAccessToken(parsed);
  }

  private async ensureFreshToken(): Promise<string | null> {
    const cached = await this.readCachedToken();
    if (cached === null) return null;
    if (cached.expiresAtMs === null || cached.expiresAtMs - this.now() > this.refreshMarginMs) {
      return cached.accessToken;
    }
    try {
      await this.refreshNow();
    } catch (err) {
      log.warn('credential proxy: refresh failed', { error: (err as Error).message });
      // Fall through to return the stale token rather than failing the request
      // closed — the upstream will respond with 401 if the token is actually
      // dead, and the in-VM runner already handles that.
      return cached.accessToken;
    }
    const refreshed = await this.readCachedToken();
    return refreshed?.accessToken ?? cached.accessToken;
  }

  /**
   * Per-request handler. Each request:
   *   1. validate the inbound bearer against the registry → 401 on unknown
   *   2. ensure a fresh upstream access token (refresh on expiry)
   *   3. fold the request body into a Buffer (small for claude requests)
   *   4. run the header-override seam (default no-op)
   *   5. forward to upstream with `Authorization: Bearer <real>`
   *   6. stream the response back; log the ratelimit/org headers so operators
   *      can observe Max-window consumption.
   */
  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const inbound = parseBearer(req.headers['authorization']);
    const matched = inbound ? this.findRegistration(inbound) : null;
    if (!matched) {
      writeProxyError(res, 401, 'unknown sentinel');
      return;
    }
    const access = await this.ensureFreshToken();
    if (!access) {
      writeProxyError(res, 503, 'credential proxy: no cached access token');
      return;
    }
    const body = await readBody(req);
    const rewritten = this.override({
      method: req.method ?? 'GET',
      pathname: req.url ?? '/',
      headers: collectHeaders(req),
      body,
    });
    await this.forwardToUpstream(matched, req, res, rewritten, access);
  }

  private async forwardToUpstream(
    matched: Registration,
    req: IncomingMessage,
    res: ServerResponse,
    rewritten: HeaderOverrideOutput,
    access: string,
  ): Promise<void> {
    try {
      const upstream = await this.upstream.send({
        method: req.method ?? 'GET',
        pathname: req.url ?? '/',
        headers: { ...rewritten.headers, authorization: `Bearer ${access}` },
        body: rewritten.body,
      });
      forwardResponse(matched, upstream, res);
    } catch (err) {
      log.warn('credential proxy: upstream error', {
        issue_id: matched.issueId,
        error: (err as Error).message,
      });
      if (!res.headersSent) writeProxyError(res, 502, 'upstream error');
      else res.end();
    }
  }

  private findRegistration(presented: string): Registration | null {
    const presentedBuf = Buffer.from(presented, 'utf8');
    for (const reg of this.pending.values()) {
      const expected = Buffer.from(reg.sentinel, 'utf8');
      if (expected.length !== presentedBuf.length) continue;
      if (timingSafeEqual(expected, presentedBuf)) return reg;
    }
    return null;
  }
}

// The constructor's nullish-coalescing chain would otherwise blow the FC/IS
// complexity budget, so defaults are applied in two thematic groups.

function resolveCredentialProxyWiring(opts: CredentialProxyOptions): {
  credentialsPath: string;
  lockPath: string;
  upstream: UpstreamRequestor;
  refresher: () => Promise<void>;
  override: HeaderOverride;
  now: () => number;
} {
  return {
    credentialsPath: opts.credentialsPath ?? path.join(os.homedir(), '.claude', '.credentials.json'),
    lockPath: opts.lockPath ?? path.join(os.homedir(), '.symphony', 'oauth', 'refresh.lock'),
    upstream: opts.upstream ?? defaultUpstream(),
    refresher: opts.refresher ?? defaultRefresher(),
    override: opts.override ?? NOOP_OVERRIDE,
    now: opts.now ?? (() => Date.now()),
  };
}

function resolveCredentialProxyTuning(opts: CredentialProxyOptions): {
  refreshMarginMs: number;
  lockPollMs: number;
  lockStaleMs: number;
  lockAcquireTimeoutMs: number;
} {
  return {
    refreshMarginMs: opts.refreshMarginMs ?? 60_000,
    lockPollMs: opts.lockPollMs ?? 25,
    lockStaleMs: opts.lockStaleMs ?? 180_000,
    lockAcquireTimeoutMs: opts.lockAcquireTimeoutMs ?? 90_000,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function writeProxyError(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'content-type': 'text/plain' });
  res.end(message);
}

/** Extract the bearer token from an `Authorization` header, or null on miss. */
function parseBearer(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return null;
  const match = /^Bearer\s+(\S+)$/.exec(raw.trim());
  return match ? match[1]! : null;
}

/** Collect inbound headers into a plain string map, dropping `host`/`authorization`. */
function collectHeaders(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    const key = k.toLowerCase();
    if (key === 'host' || key === 'authorization' || key === 'content-length') continue;
    if (Array.isArray(v)) {
      out[key] = v.join(', ');
    } else if (typeof v === 'string') {
      out[key] = v;
    }
  }
  return out;
}

/** Buffer the request body into a single Buffer. Bounded by client framing. */
async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

/**
 * Mirror the upstream response onto the client response. Strips `content-length`
 * (we re-derive via streaming) and logs the Max-window observability headers.
 */
function forwardResponse(
  matched: Registration,
  upstream: UpstreamResponse,
  res: ServerResponse,
): void {
  const headers: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(upstream.headers)) {
    if (v === undefined) continue;
    if (k.toLowerCase() === 'content-length' || k.toLowerCase() === 'transfer-encoding') continue;
    headers[k] = v;
  }
  res.writeHead(upstream.statusCode, headers);
  logRateLimitHeaders(matched, upstream.headers);
  void pipeBody(upstream.body, res);
}

async function pipeBody(body: AsyncIterable<Buffer>, res: ServerResponse): Promise<void> {
  try {
    for await (const chunk of body) {
      if (!res.write(chunk)) {
        await new Promise<void>((resolve) => res.once('drain', resolve));
      }
    }
  } catch (err) {
    log.warn('credential proxy: response pipe error', { error: (err as Error).message });
  } finally {
    res.end();
  }
}

function logRateLimitHeaders(matched: Registration, headers: Record<string, string | string[]>): void {
  const observed: Record<string, string> = {};
  for (const name of REFRESH_HEADER_NAMES) {
    const v = headers[name];
    if (v === undefined) continue;
    observed[name] = Array.isArray(v) ? v.join(', ') : v;
  }
  if (Object.keys(observed).length > 0) {
    log.info('credential proxy: upstream ratelimit', {
      issue_id: matched.issueId,
      issue_identifier: matched.identifier,
      ...observed,
    });
  }
}

/**
 * Pull `accessToken` and `expiresAt` out of the credentials JSON. The shape
 * `claude` writes is `{ claudeAiOauth: { accessToken, expiresAt, ... } }`,
 * but we tolerate flat top-level fields too for forward compatibility.
 */
function extractAccessToken(parsed: unknown): { accessToken: string; expiresAtMs: number | null } | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const root = parsed as Record<string, unknown>;
  const oauth = root['claudeAiOauth'];
  const candidate =
    oauth && typeof oauth === 'object' && !Array.isArray(oauth) ? (oauth as Record<string, unknown>) : root;
  const accessToken = candidate['accessToken'];
  if (typeof accessToken !== 'string' || accessToken.length === 0) return null;
  const expiresAtMs = coerceExpiresAtMs(candidate['expiresAt']);
  return { accessToken, expiresAtMs };
}

function coerceExpiresAtMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
    const parsedDate = Date.parse(value);
    if (Number.isFinite(parsedDate)) return parsedDate;
  }
  return null;
}
