// Host credential proxy — terminates per-dispatch sentinels on the host and
// substitutes the real upstream access token before forwarding the request to
// the adapter's upstream API. The proxy is adapter-keyed: each registration
// records which adapter it serves, and per-request handling resolves the
// matching `UpstreamProfile` (upstream host, credential reader, refresher,
// billing-tell headers). claude → api.anthropic.com; codex → api.openai.com;
// opencode → api.githubcopilot.com (with a host-side GitHub→Copilot token
// exchange — see the opencode profile block near the bottom of this file).
//
// Lifecycle mirrors AcpBridge (src/acp-bridge.ts):
//
//   1. Orchestrator calls `proxy.register({ issueId, identifier, adapterId })`
//      before the VM launches; the returned `sentinel` is staged into the VM
//      env as the adapter's token var (ANTHROPIC_AUTH_TOKEN / OPENAI_API_KEY)
//      and `baseUrl` as its base-URL var (ANTHROPIC_BASE_URL / OPENAI_BASE_URL).
//   2. The in-VM adapter speaks Bearer-auth to the proxy. Each request: the
//      proxy validates the inbound bearer against the registry, resolves the
//      registration's profile, reads the live access token out of that profile's
//      credential file (`~/.claude/.credentials.json` /
//      `~/.codex/auth.json`), strips inbound auth, attaches
//      `Authorization: Bearer <real>`, and forwards to the profile's upstream
//      host. The upstream response — including the profile's billing-tell
//      headers (`anthropic-ratelimit-unified-*` / `x-ratelimit-*`) — streams
//      back unchanged so the in-VM runner sees the operator's subscription
//      consumption.
//   3. On dispatch teardown the orchestrator calls `proxy.deregister(sentinel)`
//      so the token no longer authorizes upstream traffic.
//
// The "only the host refreshes" invariant is structural: VMs never hold a
// `refreshToken` under proxy mode. For claude (short ~8h TTL): when the cached
// access token is past its `expiresAt` (or within a small margin) the proxy
// spawns `claude -p "ok"` on the host under a kernel-managed `flock(2)` advisory
// lock (via `flock(1)`) so concurrent stale-cache callers — across processes —
// collapse into a single refresh. The host's own ticker (running on
// `cfg.credentials.ticker_interval_ms`) keeps the cache warm during idle
// periods so the first VM request after expiry doesn't pay the spawn latency.
// For codex (long ~8-day TTL): the proxy does NOT drive refresh — it re-reads
// `~/.codex/auth.json` on each request so a host-side rotation is picked up
// automatically, while the refresh token stays host-side (research Q3 option c;
// the OpenAI refresh dance is the eventual target but is deliberately deferred).
//
// Why `flock(1)` and not a homegrown lockfile protocol: the kernel owns the
// lock state. Two contenders cannot both believe they hold the lock; the lock
// is released automatically when the holder process dies (no stale-lock
// problem, no PID-liveness heuristics); and a peer cannot delete another
// peer's live lock (an `O_CREAT|O_EXCL` lockfile + `unlink` scheme always
// races on break/release ownership, see the codex review thread on this issue
// for the concrete sequence).
//
// A typed header-override seam runs immediately before each upstream forward.
// Its default is no-op (the in-VM client emits its own well-formed identity
// from the staged `~/.claude.json`); the seam exists so if Anthropic
// re-activates server-side `metadata.user_id` validation more strictly than
// today, the proxy can rewrite host-side without changing the VM contract.

import { createServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { request as httpsRequest, type RequestOptions as HttpsRequestOptions } from 'node:https';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, mkdir } from 'node:fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import type { AddressInfo } from 'node:net';
import { log } from '../logging.js';
import {
  hostOpencodeCredentialPath,
  opencodeGithubTokenFromAuth,
  opencodeGithubTokenFromEnv,
  type AcpAdapterId,
} from './adapter-names.js';

export interface CredentialProxyRegistration {
  /** Per-dispatch opaque sentinel. Staged into the VM as the adapter's token var. */
  sentinel: string;
  /** Base URL the in-VM client should dial. Staged as the adapter's base-URL var. */
  baseUrl: string;
}

export interface RegisterOpts {
  issueId: string;
  identifier: string;
  /**
   * Which adapter this dispatch is for. Selects the `UpstreamProfile` the proxy
   * uses for every request under the minted sentinel. Defaults to `'claude'`
   * for backward compatibility with callers that predate the codex profile.
   */
  adapterId?: AcpAdapterId;
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
  /** Upstream host to dial (e.g. api.anthropic.com / api.openai.com). */
  host: string;
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

/** Access token plus its absolute expiry (ms since epoch), or null when unknown. */
export interface TokenInfo {
  accessToken: string;
  expiresAtMs: number | null;
  /**
   * codex only: true when `accessToken` is a ChatGPT-OAuth subscription token
   * (auth.json `tokens.access_token`). Such tokens are honored ONLY on the
   * ChatGPT backend (chatgpt.com/backend-api/codex), never the metered platform
   * API (api.openai.com/v1, which 401s for the missing `api.responses.write`
   * scope). The codex profile's `upstreamRoute` keys on this; an API-key
   * credential leaves it false/undefined and keeps the default platform route.
   */
  chatgptOAuth?: boolean;
  /**
   * codex ChatGPT-OAuth mode: the `chatgpt_account_id` for the
   * `chatgpt-account-id` header, when present in auth.json. Routing does NOT
   * depend on it — a ChatGPT-OAuth token with no account id still routes to the
   * backend (just without the header); `chatgptOAuth` is the routing signal.
   */
  chatgptAccountId?: string | null;
}

/**
 * Optional per-request upstream route derived from the live credential. Lets a
 * profile dial a different host/path with extra headers than its default
 * `upstreamHost` — used by codex to reach OpenAI's ChatGPT backend with a
 * subscription token instead of the metered platform API.
 */
export interface UpstreamRoute {
  /** Upstream host to dial instead of the profile's `upstreamHost`. */
  host: string;
  /** Rewrite the inbound pathname (e.g. `/v1/responses` → `/backend-api/codex/responses`). */
  rewritePath(pathname: string): string;
  /** Extra headers to attach at egress (e.g. `chatgpt-account-id`). */
  extraHeaders: Record<string, string>;
}

/**
 * Per-adapter upstream strategy. The proxy holds one per adapter id and resolves
 * the right one for each registration. Everything that was claude-specific —
 * the upstream host, the credential reader, the refresher, and the billing-tell
 * header set — lives here so a new adapter is a new profile, not a new branch.
 */
export interface UpstreamProfile {
  adapterId: AcpAdapterId;
  /** Upstream API host the proxy forwards to. */
  upstreamHost: string;
  /** Host file the live access token is read from on each request. */
  credentialsPath: string;
  /** Pure: pull the access token + expiry out of the parsed credential JSON. */
  extractToken(parsed: unknown): TokenInfo | null;
  /**
   * Fallback credential read from the host environment when the file yields no
   * token (codex: `OPENAI_API_KEY`). Returns null for adapters with no env path.
   */
  envFallback(): TokenInfo | null;
  /** Drive a host-side refresh (claude: `claude -p`). Tests inject a stub. */
  refresher: () => Promise<void>;
  /**
   * Static headers injected at egress on every forwarded request, regardless of
   * the inbound headers. opencode uses this for the GitHub Copilot editor
   * headers (`Editor-Version`, `Copilot-Integration-Id`, …) that
   * `api.githubcopilot.com` requires but the in-VM `@ai-sdk/openai-compatible`
   * client does not send. These WIN over inbound headers but a per-request
   * `upstreamRoute`'s `extraHeaders` win over these. Absent for claude/codex.
   */
  egressHeaders?: Record<string, string>;
  /** Response header names carrying the subscription billing tell, logged per response. */
  billingTellHeaders: readonly string[];
  /**
   * Optional per-request upstream route derived from the live token. codex
   * returns the ChatGPT-backend route when the credential is a ChatGPT-OAuth
   * subscription token (see {@link TokenInfo.chatgptAccountId}); null ⇒ forward
   * to `upstreamHost` with the path unchanged (API-key mode).
   */
  upstreamRoute?(token: TokenInfo): UpstreamRoute | null;
}

/**
 * Exchange a durable GitHub OAuth token for a short-lived GitHub Copilot token
 * (POST/GET `api.github.com/copilot_internal/v2/token`). Returns the Copilot
 * token + its expiry. Injectable so opencode-profile tests don't hit the
 * network. The exchange HOST (api.github.com) is distinct from the inference
 * upstreamHost (api.githubcopilot.com).
 */
export type CopilotTokenExchange = (githubToken: string) => Promise<TokenInfo>;

/** Per-adapter override hook for tests / non-default deployments. */
export interface UpstreamProfileOverride {
  credentialsPath?: string;
  refresher?: () => Promise<void>;
  upstreamHost?: string;
  /**
   * opencode only: inject the GitHub→Copilot token exchange so tests can run
   * the cache-populating refresher without hitting api.github.com. Ignored by
   * claude/codex.
   */
  copilotExchange?: CopilotTokenExchange;
}

export interface CredentialProxyOptions {
  /** Claude credential path shorthand. Equivalent to `profileOverrides.claude.credentialsPath`. */
  credentialsPath?: string;
  /** Per-adapter profile overrides (credential path, refresher, upstream host). */
  profileOverrides?: Partial<Record<AcpAdapterId, UpstreamProfileOverride>>;
  /** Path to the cross-process lock file serializing host-side refreshes. */
  lockPath?: string;
  /** Refresh when (expiresAt - now) is below this many ms. Default 60_000. */
  refreshMarginMs?: number;
  /** Upstream forwarder. Default: real https to `input.host`. */
  upstream?: UpstreamRequestor;
  /** Claude refresher shorthand. Equivalent to `profileOverrides.claude.refresher`. */
  refresher?: () => Promise<void>;
  /** Header-override seam (default: pass-through). */
  override?: HeaderOverride;
  /** Clock; tests inject a deterministic one. */
  now?: () => number;
  /**
   * Hard cap on time spent waiting to acquire the cross-process refresh lock.
   * Default 90_000 (90 seconds). Bounded so a pathological peer can't hang a
   * VM request indefinitely; on timeout, refreshNow fails closed (no refresher
   * spawn) and ensureFreshToken re-reads the cache to pick up whatever the
   * peer rotated to (or returns the stale token to let upstream surface 401).
   */
  lockAcquireTimeoutMs?: number;
  /**
   * Lock acquirer used to serialize host-side refresh across processes. The
   * returned `release` callback is idempotent and tears down the kernel-side
   * lock. Default: spawn `flock(1)` with the lockPath argument — this gives us
   * `flock(2)` advisory locking, where the kernel:
   *   (1) only permits one holder of the exclusive lock at a time,
   *   (2) releases the lock automatically when the holder process exits (so a
   *       crashed peer cannot leak a stale lock), and
   *   (3) makes it impossible for a peer to remove our live lock — there is no
   *       lockfile to unlink, only a kernel-managed lock on the file descriptor.
   * Tests inject a deterministic stub.
   */
  lockAcquire?: LockAcquire;
}

/**
 * Acquire the cross-process refresh lock. The returned promise resolves to a
 * `release` callback once the lock is held; on timeout / failure, the promise
 * rejects with `Error("credential proxy: refresh lock acquire timeout")`.
 * `release` is idempotent; calling it more than once is a no-op.
 */
export type LockAcquire = (timeoutMs: number) => Promise<() => Promise<void>>;

interface Registration {
  sentinel: string;
  issueId: string;
  identifier: string;
  adapterId: AcpAdapterId;
}

// Anthropic's subscription billing tell: the unified-window ratelimit family +
// org id. Logged per response so operators can observe Max-window consumption.
const CLAUDE_BILLING_TELL_HEADERS: readonly string[] = [
  'anthropic-organization-id',
  'anthropic-ratelimit-unified-5h-status',
  'anthropic-ratelimit-unified-5h-reset',
  'anthropic-ratelimit-unified-5h-utilization',
  'anthropic-ratelimit-unified-7d-status',
  'anthropic-ratelimit-unified-7d-reset',
  'anthropic-ratelimit-unified-7d-utilization',
];

// OpenAI's billing tell. The exact subscription-vs-metered discriminator was
// NOT measurable without a live ChatGPT-OAuth token (research Q4 /
// docs/research/codex-proxy-accept-matrix.md §1), so this is the documented
// `x-ratelimit-*` candidate family; whichever appear are logged. Q4 is left as a
// known limitation for #116: capturing the real discriminator needs a host with
// a live ChatGPT-OAuth credential AND access to the proxy's `upstream ratelimit`
// log line, tracked as follow-up #121.
const CODEX_BILLING_TELL_HEADERS: readonly string[] = [
  'x-ratelimit-limit-requests',
  'x-ratelimit-remaining-requests',
  'x-ratelimit-reset-requests',
  'x-ratelimit-limit-tokens',
  'x-ratelimit-remaining-tokens',
  'x-ratelimit-reset-tokens',
];

/**
 * Default upstream: forward via https to `input.host`. The body is sent as-is;
 * the response stream is the IncomingMessage which `AsyncIterable`s over chunks
 * so callers can pipe SSE responses without buffering.
 */
function defaultUpstream(): UpstreamRequestor {
  return {
    send: ({ host, method, pathname, headers, body }) =>
      new Promise<UpstreamResponse>((resolve, reject) => {
        const opts: HttpsRequestOptions = {
          method,
          hostname: host,
          path: pathname,
          headers: { ...headers, 'content-length': String(body.length), host },
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
 * Default claude refresher: spawn `claude -p "ok"` and resolve when it exits.
 * Claude Code's own OAuth path detects the stale access token, refreshes against
 * Anthropic, and atomically writes the rotated tuple back to
 * `~/.claude/.credentials.json`. Symphony never implements OAuth — Anthropic's
 * own client does.
 */
function defaultClaudeRefresher(): () => Promise<void> {
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

/**
 * Default codex refresher: none. codex access tokens are long-lived (~8 days),
 * so the proxy leans on re-read-on-request rather than driving the OpenAI
 * refresh dance (research Q3 option c). The host owns refresh via its own codex
 * usage; the refresh token never reaches the proxy or the VM. This throws so a
 * future expiry-driven refresh path fails loudly instead of silently spawning
 * an unimplemented refresher — codex `extractToken` returns a null expiry, so it
 * is never reached in normal operation.
 */
function defaultCodexRefresher(): () => Promise<void> {
  return () =>
    Promise.reject(
      new Error('codex credential refresh is host-owned (long-TTL); the proxy does not refresh'),
    );
}

export class CredentialProxy {
  private server: HttpServer | null = null;
  private boundPort: number | null = null;
  private boundHost: string | null = null;
  private readonly pending = new Map<string, Registration>();
  private readonly profiles: Map<AcpAdapterId, UpstreamProfile>;
  private readonly lockPath: string;
  private readonly refreshMarginMs: number;
  private readonly upstream: UpstreamRequestor;
  private readonly now: () => number;
  private readonly lockAcquireTimeoutMs: number;
  private readonly lockAcquire: LockAcquire;
  private override: HeaderOverride;
  private stopped = false;
  // In-process single-flight, per adapter: when a refresh is in flight for an
  // adapter, every other caller for that adapter awaits the same promise instead
  // of racing into the refresher.
  private readonly refreshInFlight = new Map<AcpAdapterId, Promise<void>>();

  constructor(opts: CredentialProxyOptions = {}) {
    const wiring = resolveCredentialProxyWiring(opts);
    const tuning = resolveCredentialProxyTuning(opts);
    this.profiles = wiring.profiles;
    this.lockPath = wiring.lockPath;
    this.upstream = wiring.upstream;
    this.override = wiring.override;
    this.now = wiring.now;
    this.lockAcquire = wiring.lockAcquire;
    this.refreshMarginMs = tuning.refreshMarginMs;
    this.lockAcquireTimeoutMs = tuning.lockAcquireTimeoutMs;
  }

  private profileFor(adapterId: AcpAdapterId): UpstreamProfile {
    const profile = this.profiles.get(adapterId);
    if (!profile) throw new Error(`credential proxy: no upstream profile for adapter "${adapterId}"`);
    return profile;
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
   * Mint a fresh sentinel and register it for `(issueId, identifier, adapterId)`.
   * The caller stages the result as the adapter's token + base-URL env vars in
   * the VM launch env. `adapterId` selects the `UpstreamProfile` used for every
   * request under this sentinel; it must be a profile the proxy knows.
   */
  register(opts: RegisterOpts): CredentialProxyRegistration {
    if (this.stopped) throw new Error('credential proxy is stopped');
    if (!this.server) throw new Error('credential proxy is not listening; call start() first');
    const baseUrl = this.baseUrl();
    if (!baseUrl) throw new Error('credential proxy has no bound URL');
    const adapterId = opts.adapterId ?? 'claude';
    this.profileFor(adapterId); // fail fast on an unknown adapter
    const sentinel = `sk-symphony-${randomBytes(24).toString('base64url')}`;
    this.pending.set(sentinel, { sentinel, issueId: opts.issueId, identifier: opts.identifier, adapterId });
    log.debug('credential proxy registered', {
      issue_id: opts.issueId,
      issue_identifier: opts.identifier,
      adapter: adapterId,
    });
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
   * Run the adapter's refresher under a host-side cross-process lock so
   * concurrent symphony processes — and concurrent in-process callers — collapse
   * into one refresh per adapter. The adapter's own client owns OAuth: we just
   * trigger it and re-read the rotated credential. Defaults to `'claude'` so the
   * ticker (`CredentialTicker`) keeps the short-TTL claude token warm.
   */
  async refreshNow(adapterId: AcpAdapterId = 'claude'): Promise<void> {
    const inflight = this.refreshInFlight.get(adapterId);
    if (inflight) return inflight;
    const profile = this.profileFor(adapterId);
    const p = this.runRefreshUnderLock(profile).finally(() => {
      this.refreshInFlight.delete(adapterId);
    });
    this.refreshInFlight.set(adapterId, p);
    return p;
  }

  private async runRefreshUnderLock(profile: UpstreamProfile): Promise<void> {
    let release: (() => Promise<void>) | null = null;
    try {
      release = await this.lockAcquire(this.lockAcquireTimeoutMs);
    } catch (err) {
      // Acquire failed (timeout, flock missing, etc.). Do NOT spawn the
      // refresher unserialized — that would race a live peer against the same
      // `~/.claude/.credentials.json` and defeat the cross-process
      // serialization the lock exists for. Fail closed: the caller
      // (ensureFreshToken) catches and re-reads the cache, picking up whatever
      // the lock-holding peer wrote during our wait — or returning the stale
      // token (upstream then surfaces 401 normally) if the peer is still
      // running.
      log.warn('credential proxy: lock acquire failed; skipping refresh', {
        path: this.lockPath,
        error: (err as Error).message,
      });
      throw new Error('credential proxy: refresh lock acquire timeout');
    }
    try {
      await profile.refresher();
    } finally {
      await release().catch((err) => {
        log.warn('credential proxy: lock release error', { error: (err as Error).message });
      });
    }
  }

  /**
   * Read the cached access token for `profile`. Tries the profile's credential
   * file first, then its env fallback (codex `OPENAI_API_KEY`). Returns the
   * access token plus its `expiresAt` in milliseconds since epoch when present,
   * so callers can decide whether a refresh is needed before forwarding.
   */
  private async readCachedToken(profile: UpstreamProfile): Promise<TokenInfo | null> {
    const fromFile = await this.readTokenFile(profile);
    if (fromFile !== null) return fromFile;
    return profile.envFallback();
  }

  private async readTokenFile(profile: UpstreamProfile): Promise<TokenInfo | null> {
    let raw: string;
    try {
      raw = await readFile(profile.credentialsPath, 'utf8');
    } catch (err) {
      log.warn('credential proxy: cannot read credentials', {
        adapter: profile.adapterId,
        path: profile.credentialsPath,
        error: (err as Error).message,
      });
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      log.warn('credential proxy: credentials JSON parse failed', {
        adapter: profile.adapterId,
        error: (err as Error).message,
      });
      return null;
    }
    return profile.extractToken(parsed);
  }

  private async ensureFreshToken(profile: UpstreamProfile): Promise<TokenInfo | null> {
    const cached = await this.readCachedToken(profile);
    if (cached === null) return null;
    if (cached.expiresAtMs === null || cached.expiresAtMs - this.now() > this.refreshMarginMs) {
      return cached;
    }
    try {
      await this.refreshNow(profile.adapterId);
    } catch (err) {
      log.warn('credential proxy: refresh failed', {
        adapter: profile.adapterId,
        error: (err as Error).message,
      });
      // Failure includes the lock-acquire-timeout path: a peer is presumed to
      // be running the refresh under the file lock. Re-read the cache so we
      // pick up whatever the peer wrote during our wait; fall back to the
      // stale token if not yet rotated (upstream then surfaces 401 normally).
      const postFail = await this.readCachedToken(profile);
      return postFail ?? cached;
    }
    const refreshed = await this.readCachedToken(profile);
    return refreshed ?? cached;
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
    const profile = this.profileFor(matched.adapterId);
    const token = await this.ensureFreshToken(profile);
    if (!token) {
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
    await this.forwardToUpstream(matched, profile, req, res, rewritten, token);
  }

  private async forwardToUpstream(
    matched: Registration,
    profile: UpstreamProfile,
    req: IncomingMessage,
    res: ServerResponse,
    rewritten: HeaderOverrideOutput,
    token: TokenInfo,
  ): Promise<void> {
    try {
      const upstream = await this.upstream.send(buildUpstreamRequest(profile, req, rewritten, token));
      forwardResponse(matched, profile, upstream, res);
    } catch (err) {
      log.warn('credential proxy: upstream error', {
        issue_id: matched.issueId,
        adapter: matched.adapterId,
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
  profiles: Map<AcpAdapterId, UpstreamProfile>;
  lockPath: string;
  upstream: UpstreamRequestor;
  override: HeaderOverride;
  now: () => number;
  lockAcquire: LockAcquire;
} {
  const lockPath = opts.lockPath ?? path.join(os.homedir(), '.symphony', 'oauth', 'refresh.lock');
  return {
    profiles: buildUpstreamProfiles(opts),
    lockPath,
    upstream: opts.upstream ?? defaultUpstream(),
    override: opts.override ?? NOOP_OVERRIDE,
    now: opts.now ?? (() => Date.now()),
    lockAcquire: opts.lockAcquire ?? defaultFlockAcquire(lockPath),
  };
}

/**
 * Build the adapter-keyed upstream profiles, applying any per-adapter overrides.
 * The top-level `credentialsPath` / `refresher` options are claude shorthands
 * (kept for backward compatibility); explicit `profileOverrides.claude` wins.
 */
function buildUpstreamProfiles(opts: CredentialProxyOptions): Map<AcpAdapterId, UpstreamProfile> {
  const claudeOv: UpstreamProfileOverride = {
    credentialsPath: opts.credentialsPath,
    refresher: opts.refresher,
    ...opts.profileOverrides?.claude,
  };
  const profiles = new Map<AcpAdapterId, UpstreamProfile>();
  profiles.set('claude', buildClaudeProfile(claudeOv));
  profiles.set('codex', buildCodexProfile(opts.profileOverrides?.codex ?? {}));
  profiles.set('opencode', buildOpencodeProfile(opts.profileOverrides?.opencode ?? {}));
  return profiles;
}

function buildClaudeProfile(ov: UpstreamProfileOverride): UpstreamProfile {
  return {
    adapterId: 'claude',
    upstreamHost: ov.upstreamHost ?? 'api.anthropic.com',
    credentialsPath: ov.credentialsPath ?? path.join(os.homedir(), '.claude', '.credentials.json'),
    extractToken: extractClaudeToken,
    envFallback: () => null,
    refresher: ov.refresher ?? defaultClaudeRefresher(),
    billingTellHeaders: CLAUDE_BILLING_TELL_HEADERS,
  };
}

function buildCodexProfile(ov: UpstreamProfileOverride): UpstreamProfile {
  return {
    adapterId: 'codex',
    upstreamHost: ov.upstreamHost ?? 'api.openai.com',
    credentialsPath: ov.credentialsPath ?? path.join(os.homedir(), '.codex', 'auth.json'),
    extractToken: extractCodexToken,
    envFallback: codexEnvFallback,
    refresher: ov.refresher ?? defaultCodexRefresher(),
    billingTellHeaders: CODEX_BILLING_TELL_HEADERS,
    upstreamRoute: codexUpstreamRoute,
  };
}

function resolveCredentialProxyTuning(opts: CredentialProxyOptions): {
  refreshMarginMs: number;
  lockAcquireTimeoutMs: number;
} {
  return {
    refreshMarginMs: opts.refreshMarginMs ?? 60_000,
    lockAcquireTimeoutMs: opts.lockAcquireTimeoutMs ?? 90_000,
  };
}

/**
 * Default cross-process lock: spawn `flock(1)` holding an exclusive lock on
 * `lockPath`. The child shell prints `READY\n` on stdout once the kernel has
 * granted the lock, then blocks on stdin via `exec cat`. Release closes the
 * child's stdin: cat reads EOF, exits, the kernel releases the flock(2) lock
 * automatically when the file descriptor is closed.
 *
 * The kernel guarantees we need from this lock:
 *   - mutual exclusion: only one holder at a time across processes;
 *   - automatic release on holder death (no stale-lock / PID-liveness
 *     heuristics);
 *   - ownership safety: a peer cannot delete our live lock (no lockfile to
 *     unlink — only a kernel-managed lock on the open FD).
 */
function defaultFlockAcquire(lockPath: string): LockAcquire {
  return async (timeoutMs: number) => {
    await mkdir(path.dirname(lockPath), { recursive: true });
    return spawnFlockHolder(lockPath, timeoutMs);
  };
}

async function spawnFlockHolder(lockPath: string, timeoutMs: number): Promise<() => Promise<void>> {
  // `flock -x -o lockfile sh -c '...'`: blocks until the kernel grants LOCK_EX
  // on the lockfile, then exec's the shell. The shell prints READY, then
  // `exec cat` replaces the shell with cat which blocks on stdin (closing
  // our pipe to it tells cat to exit, which lets flock's parent reap and
  // exit, which closes the FD and releases the kernel lock).
  //
  // `-o` makes flock close the lock-holding FD in the child process before
  // exec'ing the command, so the lock is held by *only* the flock parent.
  // Without `-o` the child would inherit the FD and could leak the lock past
  // the parent's death if the parent is killed before the child exits.
  const child = spawn('flock', ['-x', '-o', lockPath, 'sh', '-c', 'echo READY; exec cat'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  try {
    await waitForFlockReady(child, timeoutMs);
  } catch (err) {
    // We never saw READY: either flock is still waiting on the kernel lock
    // (timeout case) or the child crashed before acquire. Kill it hard so the
    // kernel never grants us a lock we won't release.
    try { child.kill('SIGKILL'); } catch { /* ignore */ }
    throw err;
  }
  return makeFlockRelease(child);
}

function waitForFlockReady(child: ChildProcess, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let stdoutBuf = '';
    let stderrBuf = '';
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('credential proxy: refresh lock acquire timeout'));
    }, timeoutMs);
    const settle = (err: Error | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    };
    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuf += chunk.toString('utf8');
      if (stdoutBuf.includes('READY')) settle(null);
    });
    child.stderr?.on('data', (chunk: Buffer) => { stderrBuf += chunk.toString('utf8'); });
    child.once('error', (err) => settle(err));
    child.once('exit', (code, signal) => {
      settle(new Error(`flock exited before ready (code=${code}, signal=${signal}, stderr=${stderrBuf.trim()})`));
    });
  });
}

function makeFlockRelease(child: ChildProcess): () => Promise<void> {
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    try { child.stdin?.end(); } catch { /* ignore */ }
    if (child.exitCode !== null || child.signalCode !== null) return;
    // Belt: if `cat` somehow doesn't exit on EOF, SIGTERM it after a delay so
    // we don't leak the kernel lock indefinitely.
    const sigtermTimer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
    }, 2_000);
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    clearTimeout(sigtermTimer);
  };
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

/**
 * Build the upstream request: apply the profile's credential-derived route
 * (codex ChatGPT backend → host swap + path rewrite + account header) over the
 * default host/path, and substitute the real bearer for the inbound sentinel.
 */
function buildUpstreamRequest(
  profile: UpstreamProfile,
  req: IncomingMessage,
  rewritten: HeaderOverrideOutput,
  token: TokenInfo,
): UpstreamRequestInput {
  const route = profile.upstreamRoute?.(token) ?? null;
  const inboundPath = req.url ?? '/';
  return {
    host: route?.host ?? profile.upstreamHost,
    method: req.method ?? 'GET',
    pathname: route ? route.rewritePath(inboundPath) : inboundPath,
    headers: {
      ...rewritten.headers,
      ...profile.egressHeaders,
      ...route?.extraHeaders,
      authorization: `Bearer ${token.accessToken}`,
    },
    body: rewritten.body,
  };
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
  profile: UpstreamProfile,
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
  logRateLimitHeaders(matched, profile, upstream.headers);
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

function logRateLimitHeaders(
  matched: Registration,
  profile: UpstreamProfile,
  headers: Record<string, string | string[]>,
): void {
  const observed: Record<string, string> = {};
  for (const name of profile.billingTellHeaders) {
    const v = headers[name];
    if (v === undefined) continue;
    observed[name] = Array.isArray(v) ? v.join(', ') : v;
  }
  if (Object.keys(observed).length > 0) {
    log.info('credential proxy: upstream ratelimit', {
      issue_id: matched.issueId,
      issue_identifier: matched.identifier,
      adapter: matched.adapterId,
      ...observed,
    });
  }
}

/**
 * Pull `accessToken` and `expiresAt` out of the claude credentials JSON. The
 * shape `claude` writes is `{ claudeAiOauth: { accessToken, expiresAt, ... } }`,
 * but we tolerate flat top-level fields too for forward compatibility.
 */
function extractClaudeToken(parsed: unknown): TokenInfo | null {
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

/**
 * Pull the access token out of the codex `~/.codex/auth.json`. Two flavours live
 * there (docs/research/codex-proxy-accept-matrix.md §1): a ChatGPT-OAuth
 * `tokens.access_token` and an API-key `OPENAI_API_KEY`. We prefer the OAuth
 * access token, then fall back to the API key. The `tokens.refresh_token` is
 * NEVER read — it stays host-side so an in-VM agent cannot rotate (and thereby
 * invalidate) the host's credential. `expiresAtMs` is null on purpose: codex
 * tokens are long-lived (~8 days) and the proxy re-reads on each request rather
 * than driving a refresh (research Q3 option c).
 */
function extractCodexToken(parsed: unknown): TokenInfo | null {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const root = parsed as Record<string, unknown>;
  const tokens = codexTokensObject(root);
  if (tokens !== null) {
    const oauth = nonEmptyString(tokens['access_token']);
    if (oauth !== null) {
      // ChatGPT-OAuth subscription credential → ChatGPT-backend route. The
      // account id (when present) becomes the `chatgpt-account-id` header, but
      // routing keys on `chatgptOAuth`: this token is ALWAYS rejected by the
      // platform API, with or without the account id.
      return {
        accessToken: oauth,
        expiresAtMs: null,
        chatgptOAuth: true,
        chatgptAccountId: nonEmptyString(tokens['account_id']),
      };
    }
  }
  // API-key credential: forward to the platform API (api.openai.com/v1) unchanged.
  const apiKey = nonEmptyString(root['OPENAI_API_KEY']);
  return apiKey === null ? null : { accessToken: apiKey, expiresAtMs: null };
}

/** The ChatGPT-OAuth `tokens` bundle from auth.json, or null when absent/malformed. */
function codexTokensObject(root: Record<string, unknown>): Record<string, unknown> | null {
  const tokens = root['tokens'];
  if (!tokens || typeof tokens !== 'object' || Array.isArray(tokens)) return null;
  return tokens as Record<string, unknown>;
}

const CHATGPT_BACKEND_HOST = 'chatgpt.com';

/**
 * codex ChatGPT-OAuth subscription tokens are accepted only by OpenAI's ChatGPT
 * backend (chatgpt.com/backend-api/codex), NOT the metered platform API
 * (api.openai.com/v1) — verified live: the platform API 401s with
 * "Missing scopes: api.responses.write" (the subscription token carries only
 * openid/profile/email/offline_access). Native codex POSTs to
 * `/backend-api/codex/responses` with a `chatgpt-account-id` header; the proxy
 * replays that at egress so the per-dispatch sentinel→token swap reaches a host
 * that honors the subscription. API-key credentials (no account id) keep the
 * default api.openai.com/v1 route.
 */
function codexUpstreamRoute(token: TokenInfo): UpstreamRoute | null {
  if (!token.chatgptOAuth) return null;
  // The account id is the routing context OpenAI's backend expects, but it is
  // not the routing trigger: an OAuth token without one still must avoid the
  // platform API. Send the header only when we have it.
  const extraHeaders: Record<string, string> = token.chatgptAccountId
    ? { 'chatgpt-account-id': token.chatgptAccountId }
    : {};
  return { host: CHATGPT_BACKEND_HOST, rewritePath: rewriteCodexBackendPath, extraHeaders };
}

/** `/v1/<rest>` → `/backend-api/codex/<rest>`; non-`/v1` paths pass through unchanged. */
function rewriteCodexBackendPath(pathname: string): string {
  return pathname.replace(/^\/v1(?=\/|$|\?)/, '/backend-api/codex');
}

function nonEmptyString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** Read `OPENAI_API_KEY` from the host environment as a codex credential fallback. */
function codexEnvFallback(): TokenInfo | null {
  const key = process.env['OPENAI_API_KEY'];
  if (typeof key === 'string' && key.length > 0) return { accessToken: key, expiresAtMs: null };
  return null;
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

// ---------------------------------------------------------------------------
// opencode / GitHub Copilot upstream profile (issue 130).
//
// Unlike claude/codex (where the credential FILE holds the bearer the proxy
// forwards), opencode's auth.json holds a DURABLE GitHub OAuth token that
// `api.githubcopilot.com` does NOT accept. The proxy must exchange it host-side
// for a short-lived (~30 min) Copilot token at
// `api.github.com/copilot_internal/v2/token`, cache that token in memory, and
// forward it as the bearer plus the Copilot editor headers. The durable GitHub
// OAuth token never becomes the bearer and never enters the VM.
//
// The exchange reuses the existing refresh machinery: a profile-owned cache
// holds the Copilot token, `extractToken` returns it (or a deliberately-expired
// COLD stub when uncached so `ensureFreshToken` runs the exchange before the
// first forward), and the exchange runs as the profile's `refresher` (under the
// shared flock + in-process single-flight, with the TTL-margin check firing it
// before expiry → no mid-session 401). The GitHub token is read-only here (the
// mint does not rotate it), so concurrent exchanges are safe — there is no
// single-use-rotation hazard like codex's OAuth refresh.
// See docs/research/opencode-copilot-accept-matrix.md.

const COPILOT_EXCHANGE_HOST = 'api.github.com';
const COPILOT_EXCHANGE_PATH = '/copilot_internal/v2/token';
const COPILOT_INFERENCE_HOST = 'api.githubcopilot.com';

// A VS Code Copilot Chat identity. The in-VM `@ai-sdk/openai-compatible` client
// sends none of these, so the proxy supplies the full set real-world Copilot
// proxies (ericc-ch/copilot-api, litellm) send — the "safer choice" over
// opencode's own minimal set per docs/research/opencode-copilot-accept-matrix.md.
// Pinned version values DRIFT (GitHub rolls editor/plugin versions forward); these
// reflect a recent VS Code Copilot Chat release and are DOC-DERIVED.
const COPILOT_EDITOR_VERSION = 'vscode/1.95.0';
const COPILOT_PLUGIN_VERSION = 'copilot-chat/0.26.7';
const COPILOT_USER_AGENT = 'GitHubCopilotChat/0.26.7';
const COPILOT_GH_API_VERSION = '2025-04-01';

/**
 * GitHub Copilot inference headers `api.githubcopilot.com/chat/completions`
 * expects. DOC-DERIVED (docs/research/opencode-copilot-accept-matrix.md).
 * `copilot-integration-id: vscode-chat` is the load-bearing one — GitHub rejects
 * an unrecognised value; the editor/user-agent headers identify the "editor" to
 * Copilot's telemetry and widen the model allowlist. Lowercase keys (HTTP
 * headers are case-insensitive and the proxy normalises inbound headers to
 * lowercase, so these merge cleanly over the inbound set).
 */
const COPILOT_EGRESS_HEADERS: Record<string, string> = {
  'copilot-integration-id': 'vscode-chat',
  'editor-version': COPILOT_EDITOR_VERSION,
  'editor-plugin-version': COPILOT_PLUGIN_VERSION,
  'user-agent': COPILOT_USER_AGENT,
  'openai-intent': 'conversation-panel',
  'x-github-api-version': COPILOT_GH_API_VERSION,
};

/**
 * Headers for the GitHub→Copilot token exchange (api.github.com). The editor +
 * user-agent identity is sent, but NOT `copilot-integration-id` — real clients
 * (ericc-ch/copilot-api `githubHeaders()`) omit it on the exchange call (it
 * belongs on the inference call). The GitHub OAuth token is added as
 * `Authorization: token <…>` at request time.
 */
const COPILOT_EXCHANGE_HEADERS: Record<string, string> = {
  accept: 'application/json',
  'editor-version': COPILOT_EDITOR_VERSION,
  'editor-plugin-version': COPILOT_PLUGIN_VERSION,
  'user-agent': COPILOT_USER_AGENT,
  'x-github-api-version': COPILOT_GH_API_VERSION,
};

// GitHub Copilot's billing-tell response headers. UNMEASURED candidate set (no
// live Copilot credential on the implementer's host — see the accept-matrix
// doc); whichever appear are logged, but there is no reliable subscription-vs-
// metered assertion until a live measurement lands.
const COPILOT_BILLING_TELL_HEADERS: readonly string[] = [
  'x-ratelimit-limit-requests',
  'x-ratelimit-remaining-requests',
  'x-ratelimit-limit-tokens',
  'x-ratelimit-remaining-tokens',
  'x-github-request-id',
];

/**
 * Cold stub returned by the opencode profile's token reader when no Copilot
 * token is cached yet but a GitHub token IS available: its zero expiry makes
 * `ensureFreshToken` treat it as stale and run the exchange refresher before
 * the first upstream forward. Its (empty) accessToken is never the bearer on
 * the happy path — the refresh populates the real token first. It is only ever
 * forwarded if the exchange itself fails, which then surfaces as an upstream
 * auth error (the correct outcome when the host cannot mint a Copilot token).
 */
const COPILOT_COLD_STUB: TokenInfo = { accessToken: '', expiresAtMs: 0 };

/**
 * Build the opencode upstream profile. Closes over an in-memory cache of the
 * exchanged Copilot token; `exchange` (injectable for tests) performs the
 * GitHub→Copilot mint.
 */
function buildOpencodeProfile(ov: UpstreamProfileOverride): UpstreamProfile {
  const credentialsPath = ov.credentialsPath ?? hostOpencodeCredentialPath();
  const exchange = ov.copilotExchange ?? defaultCopilotExchange();
  // Mutable cache of the short-lived Copilot token (the durable GitHub token
  // stays on the host and never lands here as the bearer).
  const cache: { token: TokenInfo | null } = { token: null };
  const cachedOrStub = (githubToken: string | null): TokenInfo | null => {
    if (cache.token !== null) return cache.token;
    return githubToken !== null ? COPILOT_COLD_STUB : null;
  };
  return {
    adapterId: 'opencode',
    upstreamHost: ov.upstreamHost ?? COPILOT_INFERENCE_HOST,
    credentialsPath,
    // `parsed` is opencode's auth.json. We read it only to detect that a
    // GitHub token EXISTS (so a cold cache forces a refresh vs a 503); the
    // token bytes never become the bearer — the cached Copilot token does.
    extractToken: (parsed) => cachedOrStub(opencodeGithubTokenFromAuth(parsed)),
    envFallback: () => cachedOrStub(opencodeGithubTokenFromEnv(process.env)),
    refresher: makeCopilotRefresher(credentialsPath, exchange, cache),
    egressHeaders: COPILOT_EGRESS_HEADERS,
    billingTellHeaders: COPILOT_BILLING_TELL_HEADERS,
  };
}

/**
 * The opencode refresher: read the durable GitHub token (auth.json first, then
 * the COPILOT_GITHUB_TOKEN/GH_TOKEN/GITHUB_TOKEN env fallback), exchange it for
 * a Copilot token, and store the result in `cache`. Throws when no GitHub token
 * is resolvable so the failure surfaces (rather than silently caching null).
 */
function makeCopilotRefresher(
  credentialsPath: string,
  exchange: CopilotTokenExchange,
  cache: { token: TokenInfo | null },
): () => Promise<void> {
  return async () => {
    const githubToken = await readOpencodeGithubToken(credentialsPath);
    if (githubToken === null) {
      throw new Error(
        'opencode: no GitHub Copilot token available to exchange (auth.json + env both empty)',
      );
    }
    cache.token = await exchange(githubToken);
  };
}

/** Read the durable GitHub OAuth token: opencode auth.json first, then env. */
async function readOpencodeGithubToken(credentialsPath: string): Promise<string | null> {
  try {
    const raw = await readFile(credentialsPath, 'utf8');
    const fromFile = opencodeGithubTokenFromAuth(JSON.parse(raw));
    if (fromFile !== null) return fromFile;
  } catch {
    // File missing / unreadable / bad JSON — fall through to the env fallback.
  }
  return opencodeGithubTokenFromEnv(process.env);
}

/**
 * Default GitHub→Copilot token exchange: `GET api.github.com/copilot_internal/v2/token`
 * with `Authorization: token <gho_…>` (GitHub's classic-token scheme, NOT
 * Bearer) and the editor headers. Parses `{ token, expires_at }` — `expires_at`
 * is unix SECONDS, converted to ms. DOC-DERIVED request/response shape.
 */
function defaultCopilotExchange(): CopilotTokenExchange {
  return (githubToken) =>
    new Promise<TokenInfo>((resolve, reject) => {
      const opts: HttpsRequestOptions = {
        method: 'GET',
        hostname: COPILOT_EXCHANGE_HOST,
        path: COPILOT_EXCHANGE_PATH,
        headers: {
          // GitHub's classic-token scheme (`token <…>`), NOT Bearer.
          authorization: `token ${githubToken}`,
          ...COPILOT_EXCHANGE_HEADERS,
        },
      };
      const req = httpsRequest(opts, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const status = res.statusCode ?? 0;
          const text = Buffer.concat(chunks).toString('utf8');
          if (status < 200 || status >= 300) {
            reject(new Error(`copilot token exchange failed: HTTP ${status}`));
            return;
          }
          resolve(parseCopilotExchangeResponse(text));
        });
      });
      req.once('error', reject);
      req.end();
    });
}

/** Parse the copilot_internal/v2/token response into a TokenInfo. */
function parseCopilotExchangeResponse(text: string): TokenInfo {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`copilot token exchange: malformed JSON (${(err as Error).message})`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('copilot token exchange: response is not an object');
  }
  const root = parsed as Record<string, unknown>;
  const token = root['token'];
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('copilot token exchange: response missing "token"');
  }
  return { accessToken: token, expiresAtMs: coerceCopilotExpiry(root['expires_at']) };
}

/** Copilot `expires_at` is unix SECONDS; convert to ms (null when absent/odd). */
function coerceCopilotExpiry(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value * 1000;
  if (typeof value === 'string') {
    const n = Number(value);
    if (Number.isFinite(n)) return n * 1000;
  }
  return null;
}
