// Host credential-secrets module — re-homes the credential *lifecycle* (extract,
// mint, refresh) onto Gondolin's secret-injection model. This is the
// "transport-free" half of the old `credential-proxy.ts`: instead of running an
// HTTP server that mints per-dispatch sentinels and forwards upstream, we hand
// Gondolin a `createHttpHooks(...)` config per VM (host allowlist + a
// token-shaped placeholder secret + request/response hooks) and let Gondolin
// substitute the real access token into the outbound request at egress
// (TLS-MITM). The host stays the sole owner of the durable refresh token; the
// guest only ever sees a placeholder. See `docs/research/gondolin-sandbox-migration.md`
// §3 (the host-only-refresh invariant), §4.3 (the per-VM fan-out design), §4.4
// (per-adapter routing).
//
// DORMANT (Phase 2): nothing on the dispatch path imports this module yet. It
// reuses the extractor/mint/flock-refresh logic from `credential-proxy.ts` +
// `adapter-names.ts` rather than duplicating it — only the *shape* of the output
// (a Gondolin hooks config + an `updateSecret` push) is new.
//
// The §4.3 fan-out, restated as the contract this module owns:
//   - Each VM gets its own `createHttpHooks` instance, so each has its own
//     `secretManager` whose live `value` Gondolin reads per-request. A push-based
//     model means a missed `updateSecret` leaves THAT VM stale (and its
//     `revokedValues` never learns the old token, silently dropping revocation
//     for that VM). So this module owns a REGISTRY of every live manager and, on
//     each rotation, pushes the fresh value to ALL of them.
//   - A manager torn down mid-push must not throw — it is dropped.
//   - A VM created *during* a refresh must observe the latest value at create
//     time (seed from the module's cached value), never start stale.
//   - A per-VM proactive tick keyed off `expiresAt` keeps a long dispatch fresh
//     without relying solely on the global ticker cadence.

import path from 'node:path';
import os from 'node:os';
import {
  createHttpHooks,
  makePlaceholderFunc,
  BASE62_ALPHABET,
  BASE64URL_ALPHABET,
  type CreateHttpHooksOptions,
  type HttpHooks,
  type SecretManager,
} from '@earendil-works/gondolin';
import { log } from '../logging.js';
import type { AcpAdapterId } from './adapter-names.js';
import {
  hostOpencodeCredentialPath,
  opencodeGithubTokenFromAuth,
  opencodeGithubTokenFromEnv,
} from './adapter-names.js';
import {
  extractClaudeToken,
  extractCodexToken,
  codexEnvFallback,
  defaultClaudeRefresher,
  defaultCopilotExchange,
  defaultFlockAcquire,
  CLAUDE_BILLING_TELL_HEADERS,
  CODEX_BILLING_TELL_HEADERS,
  COPILOT_BILLING_TELL_HEADERS,
  COPILOT_EGRESS_HEADERS,
  COPILOT_EXCHANGE_HOST,
  COPILOT_EXCHANGE_PATH,
  COPILOT_INFERENCE_HOST,
  type TokenInfo,
  type CopilotTokenExchange,
  type LockAcquire,
} from './credential-proxy.js';

// ---------------------------------------------------------------------------
// Per-adapter static config (placeholder shape, secret env var name, hosts).
// ---------------------------------------------------------------------------

/**
 * The env var / secret name each adapter's placeholder is keyed under. These are
 * the SAME names the in-VM client reads its bearer from (claude reads
 * `ANTHROPIC_AUTH_TOKEN`, codex `OPENAI_API_KEY`); `createHttpHooks` returns an
 * `env` map keyed by these so the runner can stage the placeholder into the VM
 * env / fake creds files.
 */
const CLAUDE_SECRET_NAME = 'ANTHROPIC_AUTH_TOKEN';
const CODEX_SECRET_NAME = 'OPENAI_API_KEY';
const OPENCODE_SECRET_NAME = 'OPENCODE_PROXY_TOKEN';

const CLAUDE_UPSTREAM_HOST = 'api.anthropic.com';
const CODEX_UPSTREAM_HOST = 'chatgpt.com';

/**
 * Token-shaped placeholder generators. The default `GONDOLIN_SECRET_…`
 * placeholder can fail a client's own token-shape validation BEFORE egress
 * substitution, so each adapter gets a placeholder shaped like the real token it
 * stands in for (design §4.3). `sk-ant-` for claude, `sk-` for codex's OpenAI
 * key shape, `gho_`-ish for the opencode Copilot bearer. The generator is called
 * ONCE at `createHttpHooks()` time; the real value arrives via `seedValue` /
 * `updateSecret` and is never the placeholder.
 */
function claudePlaceholder(): () => string {
  return makePlaceholderFunc({ prefix: 'sk-ant-', length: 64, alphabet: BASE62_ALPHABET });
}
function codexPlaceholder(): () => string {
  return makePlaceholderFunc({ prefix: 'sk-', length: 48, alphabet: BASE62_ALPHABET });
}
function opencodePlaceholder(): () => string {
  // The opencode custom provider forwards this as its bearer; a `gho_`-shaped
  // token keeps it indistinguishable in shape from a real Copilot/GitHub token.
  return makePlaceholderFunc({ prefix: 'gho_', length: 36, alphabet: BASE64URL_ALPHABET });
}

// ---------------------------------------------------------------------------
// Credential source: extract the host-side access token for an adapter.
// ---------------------------------------------------------------------------

/**
 * Per-adapter credential lifecycle, reusing the proxy's extractor/mint/refresh
 * logic verbatim — only the *delivery* (push into a Gondolin secret) is new.
 *   - `secretName`     the Gondolin secret / env var name the placeholder is keyed under
 *   - `allowedHosts`   the egress allowlist for this adapter's `createHttpHooks`
 *   - `placeholder`    the token-shaped placeholder generator (§4.3)
 *   - `billingHeaders` the billing-tell response header set (`onResponse` logging)
 *   - `readToken()`    resolve the current host-side access token (or null)
 *   - `refresh()`      drive a host-side refresh (claude `claude -p`; opencode mint)
 *   - `egressHeaders`  static headers attached at egress (opencode editor headers)
 *   - `onRequest`      optional per-adapter request guard (opencode path-allowlist)
 */
export interface AdapterCredentialSpec {
  adapterId: AcpAdapterId;
  secretName: string;
  allowedHosts: readonly string[];
  placeholder(): () => string;
  billingHeaders: readonly string[];
  readToken(): Promise<TokenInfo | null>;
  refresh(): Promise<void>;
  egressHeaders?: Record<string, string>;
  onRequest?: HttpHooks['onRequest'];
}

/** Read+parse a JSON credential file; returns null on any IO/parse failure. */
async function readJsonFile(p: string): Promise<unknown | null> {
  // Lazy fs import keeps this module's IO surface in one place; the proxy keeps
  // its own readFile. (No core-purity concern: this is an adapter.)
  const { readFile } = await import('node:fs/promises');
  let raw: string;
  try {
    raw = await readFile(p, 'utf8');
  } catch (err) {
    log.warn('credential-secrets: cannot read credentials', {
      path: p,
      error: (err as Error).message,
    });
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    log.warn('credential-secrets: credentials JSON parse failed', {
      path: p,
      error: (err as Error).message,
    });
    return null;
  }
}

function defaultClaudeCredentialsPath(): string {
  return path.join(os.homedir(), '.claude', '.credentials.json');
}
function defaultCodexCredentialsPath(): string {
  return path.join(os.homedir(), '.codex', 'auth.json');
}
function defaultLockPath(): string {
  return path.join(os.homedir(), '.symphony', 'oauth', 'refresh.lock');
}

/** Wrap a refresher in the shared cross-process flock + in-flight collapse. */
function underLock(
  lockAcquire: LockAcquire,
  lockTimeoutMs: number,
  refresher: () => Promise<void>,
): () => Promise<void> {
  return async () => {
    let release: (() => Promise<void>) | null = null;
    try {
      release = await lockAcquire(lockTimeoutMs);
    } catch (err) {
      // Fail closed: do NOT run the refresher unserialized (it would race a peer
      // against the same credentials file). The caller re-reads the cache and
      // picks up whatever the lock-holding peer rotated to (mirrors the proxy's
      // `runRefreshUnderLock`).
      log.warn('credential-secrets: lock acquire failed; skipping refresh', {
        error: (err as Error).message,
      });
      throw new Error('credential-secrets: refresh lock acquire timeout');
    }
    try {
      await refresher();
    } finally {
      await release().catch((err) =>
        log.warn('credential-secrets: lock release error', { error: (err as Error).message }),
      );
    }
  };
}

export interface BuildSpecsOptions {
  /** Override credential paths (tests). */
  claudeCredentialsPath?: string;
  codexCredentialsPath?: string;
  opencodeCredentialsPath?: string;
  /** Cross-process refresh lock path. */
  lockPath?: string;
  /** Lock acquirer (default: `flock(1)`); tests inject a stub. */
  lockAcquire?: LockAcquire;
  /** Hard cap waiting on the lock. Default 90_000. */
  lockAcquireTimeoutMs?: number;
  /** Claude refresher (default: `claude -p`); tests inject a stub. */
  claudeRefresher?: () => Promise<void>;
  /** opencode GitHub→Copilot exchange (default: real https); tests inject a stub. */
  copilotExchange?: CopilotTokenExchange;
}

/**
 * Build the per-adapter credential specs. Reuses the proxy's extractors + mint +
 * flock helpers; the only new behavior is the Gondolin-shaped delivery and the
 * opencode `onRequest` path-allowlist (§4.4).
 */
export function buildAdapterCredentialSpecs(
  opts: BuildSpecsOptions = {},
): Record<AcpAdapterId, AdapterCredentialSpec> {
  const lockPath = opts.lockPath ?? defaultLockPath();
  const lockAcquire = opts.lockAcquire ?? defaultFlockAcquire(lockPath);
  const lockTimeoutMs = opts.lockAcquireTimeoutMs ?? 90_000;

  const claudeCredsPath = opts.claudeCredentialsPath ?? defaultClaudeCredentialsPath();
  const codexCredsPath = opts.codexCredentialsPath ?? defaultCodexCredentialsPath();
  const opencodeCredsPath = opts.opencodeCredentialsPath ?? hostOpencodeCredentialPath();

  const claudeRefresher = underLock(
    lockAcquire,
    lockTimeoutMs,
    opts.claudeRefresher ?? defaultClaudeRefresher(),
  );

  return {
    claude: {
      adapterId: 'claude',
      secretName: CLAUDE_SECRET_NAME,
      allowedHosts: [CLAUDE_UPSTREAM_HOST],
      placeholder: claudePlaceholder,
      billingHeaders: CLAUDE_BILLING_TELL_HEADERS,
      readToken: async () => extractClaudeToken(await readJsonFile(claudeCredsPath)),
      refresh: claudeRefresher,
    },
    codex: {
      adapterId: 'codex',
      secretName: CODEX_SECRET_NAME,
      allowedHosts: [CODEX_UPSTREAM_HOST],
      placeholder: codexPlaceholder,
      billingHeaders: CODEX_BILLING_TELL_HEADERS,
      // codex tokens are long-TTL (~8 days): re-read on demand, never drive an
      // OpenAI refresh dance — identical to the proxy's posture.
      readToken: async () =>
        extractCodexToken(await readJsonFile(codexCredsPath)) ?? codexEnvFallback(),
      refresh: () =>
        Promise.reject(
          new Error('credential-secrets: codex refresh is host-owned (long-TTL); not driven here'),
        ),
    },
    opencode: buildOpencodeSpec({
      credentialsPath: opencodeCredsPath,
      lockAcquire,
      lockTimeoutMs,
      exchange: opts.copilotExchange ?? defaultCopilotExchange(),
    }),
  };
}

/**
 * The opencode spec is HOST-MINT (operator rule: "no real tokens in the VM").
 * The host runs the GitHub→Copilot exchange and pushes the minted Copilot token
 * via `updateSecret`; the guest's custom provider sends only a placeholder
 * bearer against `api.githubcopilot.com`. The durable GitHub token never enters
 * the guest. The exchange host (`api.github.com`) is allowlisted ONLY so the
 * host-side exchange can reach it — guarded by the `onRequest` path-allowlist
 * below so a guest cannot turn that allowlist entry into a durable-token oracle.
 */
function buildOpencodeSpec(args: {
  credentialsPath: string;
  lockAcquire: LockAcquire;
  lockTimeoutMs: number;
  exchange: CopilotTokenExchange;
}): AdapterCredentialSpec {
  // In-memory cache of the short-lived Copilot token (the durable GitHub token
  // stays host-side and never lands here as the bearer).
  const cache: { token: TokenInfo | null } = { token: null };

  const mint = async (): Promise<void> => {
    const githubToken = await readOpencodeGithubToken(args.credentialsPath);
    if (githubToken === null) {
      throw new Error(
        'credential-secrets: opencode has no GitHub Copilot token to exchange (auth.json + env both empty)',
      );
    }
    cache.token = await args.exchange(githubToken);
  };

  return {
    adapterId: 'opencode',
    secretName: OPENCODE_SECRET_NAME,
    // Inference host + the host-mint exchange host. The exchange host is gated by
    // `onRequest` (only GET /copilot_internal/v2/token) — the durable-token
    // oracle guard (§4.4).
    allowedHosts: [COPILOT_INFERENCE_HOST, COPILOT_EXCHANGE_HOST],
    placeholder: opencodePlaceholder,
    billingHeaders: COPILOT_BILLING_TELL_HEADERS,
    egressHeaders: COPILOT_EGRESS_HEADERS,
    // The minted Copilot token is the secret value; reading it returns the cache
    // (null until the first mint runs as `refresh`).
    readToken: async () => cache.token,
    refresh: underLock(args.lockAcquire, args.lockTimeoutMs, mint),
    onRequest: makeGithubExchangePathGuard(),
  };
}

/** Read the durable GitHub OAuth token: opencode auth.json first, then env. */
async function readOpencodeGithubToken(credentialsPath: string): Promise<string | null> {
  const parsed = await readJsonFile(credentialsPath);
  if (parsed !== null) {
    const fromFile = opencodeGithubTokenFromAuth(parsed);
    if (fromFile !== null) return fromFile;
  }
  return opencodeGithubTokenFromEnv(process.env);
}

// ---------------------------------------------------------------------------
// onRequest guards.
// ---------------------------------------------------------------------------

/**
 * opencode's `api.github.com` durable-token-oracle guard (§4.4). Gondolin secret
 * substitution is HOST-scoped, not path-scoped: once `api.github.com` is
 * allowlisted, a guest could otherwise spend the real GitHub token on ANY
 * `api.github.com` path. This guard permits ONLY the token-exchange endpoint
 * (`GET /copilot_internal/v2/token`) and short-circuits everything else on that
 * host with a 403. All other hosts pass through untouched.
 *
 * NEVER logs the Authorization header or the full URL (only host + method +
 * pathname for a blocked request) — the hook may run before secret substitution
 * and there is no guarantee it sees only placeholders (§2/§4.3).
 */
export function makeGithubExchangePathGuard(): NonNullable<HttpHooks['onRequest']> {
  return (request: Request): Response | void => {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      // Unparseable URL → block defensively rather than forward.
      return new Response('blocked: unparseable request url', { status: 403 });
    }
    if (url.hostname !== COPILOT_EXCHANGE_HOST) return; // other hosts: untouched
    const method = request.method.toUpperCase();
    if (method === 'GET' && url.pathname === COPILOT_EXCHANGE_PATH) return; // permit
    log.warn('credential-secrets: blocked non-exchange request to github exchange host', {
      host: url.hostname,
      method,
      pathname: url.pathname,
    });
    return new Response('blocked: only GET /copilot_internal/v2/token is permitted', {
      status: 403,
    });
  };
}

// ---------------------------------------------------------------------------
// onResponse: billing-tell logging (ports the proxy's logRateLimitHeaders).
// ---------------------------------------------------------------------------

/**
 * Port the proxy's billing-tell logging onto an `onResponse` hook: log whichever
 * of `billingHeaders` (`anthropic-ratelimit-unified-*` / `x-ratelimit-*` / org
 * id) appear so operators can observe subscription consumption. NEVER logs the
 * Authorization header or the full URL.
 */
export function makeBillingTellResponseHook(
  adapterId: AcpAdapterId,
  billingHeaders: readonly string[],
): NonNullable<HttpHooks['onResponse']> {
  return (response: Response): void => {
    const observed: Record<string, string> = {};
    for (const name of billingHeaders) {
      const v = response.headers.get(name);
      if (v === null) continue;
      observed[name] = v;
    }
    if (Object.keys(observed).length > 0) {
      log.info('credential-secrets: upstream ratelimit', { adapter: adapterId, ...observed });
    }
  };
}

// ---------------------------------------------------------------------------
// createHttpHooks config builder per adapter.
// ---------------------------------------------------------------------------

/**
 * The Gondolin `createHttpHooks(...)` config for one adapter PLUS the
 * module-side metadata (`secretName`, `readToken`, `refresh`) the registry needs
 * to seed/refresh the resulting `secretManager`. The caller passes
 * `options` to `createHttpHooks`, registers the returned `secretManager` via
 * {@link CredentialSecretRegistry.register}, and threads `httpHooks` into
 * `VM.create`.
 */
export interface AdapterHooksConfig {
  adapterId: AcpAdapterId;
  secretName: string;
  /** Ready to pass to `createHttpHooks(options)`. */
  options: CreateHttpHooksOptions;
  /** Resolve the current host-side access token (seed value). */
  readToken(): Promise<TokenInfo | null>;
  /** Drive a host-side refresh, then `readToken` again. */
  refresh(): Promise<void>;
}

/** Build the `createHttpHooks` config for a single adapter spec. */
export function buildAdapterHooksConfig(spec: AdapterCredentialSpec): AdapterHooksConfig {
  const onRequest = spec.onRequest;
  const onResponse = makeBillingTellResponseHook(spec.adapterId, spec.billingHeaders);
  const options: CreateHttpHooksOptions = {
    allowedHosts: [...spec.allowedHosts],
    secrets: {
      [spec.secretName]: {
        hosts: [...spec.allowedHosts],
        // Seeded later via `updateSecret`; the empty initial value is never
        // forwarded on the happy path (the registry seeds before first exec).
        value: '',
        placeholder: spec.placeholder(),
      },
    },
    onResponse,
    ...(onRequest ? { onRequest } : {}),
  };
  return {
    adapterId: spec.adapterId,
    secretName: spec.secretName,
    options,
    readToken: spec.readToken,
    refresh: spec.refresh,
  };
}

// ---------------------------------------------------------------------------
// Registry of live per-VM secretManagers + push-to-all fan-out (§4.3).
// ---------------------------------------------------------------------------

interface RegistryEntry {
  manager: SecretManager;
  secretName: string;
  adapterId: AcpAdapterId;
  /** Proactive-refresh timer keyed off `expiresAt`, if scheduled. */
  timer: NodeJS.Timeout | null;
}

/** A registered VM, handed back so the caller can deregister it on teardown. */
export interface RegisteredVm {
  /** Stable handle key for this VM's manager. */
  readonly key: string;
  /** Tear down the registration (idempotent): clears the proactive timer + drops the manager. */
  deregister(): void;
}

export interface CredentialSecretRegistryOptions {
  /**
   * Resolve the current access token for an adapter (for seed + proactive
   * refresh). Defaults to the per-adapter spec's `readToken`.
   */
  readToken(adapterId: AcpAdapterId): Promise<TokenInfo | null>;
  /** Drive a host-side refresh for an adapter (proactive tick). */
  refresh(adapterId: AcpAdapterId): Promise<void>;
  /** Clock; tests inject a deterministic one. Default `Date.now`. */
  now?: () => number;
  /**
   * Schedule a callback `delayMs` in the future; returns a clearable timer.
   * Tests inject a deterministic scheduler. Default `setTimeout` (unref'd so the
   * proactive tick never holds the event loop open).
   */
  setTimer?: (cb: () => void, delayMs: number) => NodeJS.Timeout;
  clearTimer?: (timer: NodeJS.Timeout) => void;
  /**
   * Refresh proactively when `expiresAt - now` drops below this margin. Default
   * 60_000 (mirrors the proxy's `refreshMarginMs`).
   */
  refreshMarginMs?: number;
}

/**
 * Owns the set of live per-VM `secretManager`s and the cached latest value per
 * adapter. Implements the §4.3 fan-out contract:
 *   - `register` seeds the new manager from the latest cached value (or reads it
 *     fresh) BEFORE returning, so a VM created during a refresh never starts
 *     stale, and schedules its per-VM proactive tick keyed off `expiresAt`.
 *   - `pushToAll(adapterId, value)` updates the cache + every live manager for
 *     that adapter; a manager that throws (torn down mid-push) is dropped, not
 *     propagated.
 *   - `refreshAdapter(adapterId)` runs the host-side refresh, re-reads the token,
 *     and fans the result out — this is what the ticker calls per rotation.
 */
export class CredentialSecretRegistry {
  private readonly entries = new Map<string, RegistryEntry>();
  // Latest known value per adapter, used to seed a freshly-created manager.
  private readonly cachedValue = new Map<AcpAdapterId, string>();
  private seq = 0;
  private readonly readToken: (adapterId: AcpAdapterId) => Promise<TokenInfo | null>;
  private readonly refresh: (adapterId: AcpAdapterId) => Promise<void>;
  private readonly now: () => number;
  private readonly setTimer: (cb: () => void, delayMs: number) => NodeJS.Timeout;
  private readonly clearTimer: (timer: NodeJS.Timeout) => void;
  private readonly refreshMarginMs: number;

  constructor(opts: CredentialSecretRegistryOptions) {
    this.readToken = opts.readToken;
    this.refresh = opts.refresh;
    this.now = opts.now ?? (() => Date.now());
    this.setTimer =
      opts.setTimer ??
      ((cb, delayMs) => {
        const t = setTimeout(cb, delayMs);
        if (typeof t.unref === 'function') t.unref();
        return t;
      });
    this.clearTimer = opts.clearTimer ?? ((t) => clearTimeout(t));
    this.refreshMarginMs = opts.refreshMarginMs ?? 60_000;
  }

  /**
   * Register a freshly-created VM's `secretManager`. Seeds it from the latest
   * cached value (or reads one if the cache is cold) so it is never stale at
   * birth, schedules the proactive `expiresAt` tick, and returns a handle the
   * caller deregisters on VM teardown.
   */
  async register(args: {
    manager: SecretManager;
    secretName: string;
    adapterId: AcpAdapterId;
  }): Promise<RegisteredVm> {
    const key = `vm-${++this.seq}`;
    const entry: RegistryEntry = {
      manager: args.manager,
      secretName: args.secretName,
      adapterId: args.adapterId,
      timer: null,
    };
    this.entries.set(key, entry);

    // Seed: prefer a freshly-read token (also refreshes the cache + schedules the
    // proactive tick); fall back to the cached value if the read yields nothing.
    const token = await this.safeReadToken(args.adapterId);
    const seedValue = token?.accessToken ?? this.cachedValue.get(args.adapterId) ?? '';
    if (token?.accessToken) this.cachedValue.set(args.adapterId, token.accessToken);
    this.applyToEntry(key, entry, seedValue);
    if (token?.expiresAtMs != null) this.scheduleProactive(key, entry, token.expiresAtMs);

    return {
      key,
      deregister: () => this.deregister(key),
    };
  }

  /** Drop a VM's registration; clears its proactive timer. Idempotent. */
  deregister(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    if (entry.timer !== null) {
      this.clearTimer(entry.timer);
      entry.timer = null;
    }
    this.entries.delete(key);
  }

  /** Number of live managers (for tests / observability). */
  size(): number {
    return this.entries.size;
  }

  /**
   * Push a fresh secret value to EVERY live manager for `adapterId`, updating the
   * module cache first so a concurrent `register` seeds from it. A manager that
   * throws (torn down mid-push) is dropped, not propagated — the survivors still
   * get the update. This is the atomic fan-out the ticker relies on.
   */
  pushToAll(adapterId: AcpAdapterId, value: string): void {
    this.cachedValue.set(adapterId, value);
    for (const [key, entry] of [...this.entries]) {
      if (entry.adapterId !== adapterId) continue;
      this.applyToEntry(key, entry, value);
    }
  }

  /**
   * Run a host-side refresh for `adapterId`, re-read the token, and fan the fresh
   * value out to all live managers (rescheduling each VM's proactive tick). This
   * is the entry point the ticker calls on each rotation. Errors are logged, not
   * thrown (a single adapter's refresh failure must not break the others' ticks).
   */
  async refreshAdapter(adapterId: AcpAdapterId): Promise<void> {
    try {
      await this.refresh(adapterId);
    } catch (err) {
      log.warn('credential-secrets: refresh failed', {
        adapter: adapterId,
        error: (err as Error).message,
      });
      // Fall through: re-read anyway — a peer may have rotated the file under the
      // shared flock during our wait (mirrors the proxy's ensureFreshToken).
    }
    const token = await this.safeReadToken(adapterId);
    if (token === null) return;
    this.pushToAll(adapterId, token.accessToken);
    // Reschedule every live manager's proactive tick off the new expiry.
    if (token.expiresAtMs != null) {
      for (const [key, entry] of [...this.entries]) {
        if (entry.adapterId !== adapterId) continue;
        this.scheduleProactive(key, entry, token.expiresAtMs);
      }
    }
  }

  private applyToEntry(key: string, entry: RegistryEntry, value: string): void {
    try {
      entry.manager.updateSecret(entry.secretName, { value });
    } catch (err) {
      // The manager was torn down mid-push (its VM closed). Drop it; never throw.
      log.warn('credential-secrets: dropping dead secret manager', {
        adapter: entry.adapterId,
        error: (err as Error).message,
      });
      this.deregister(key);
    }
  }

  private async safeReadToken(adapterId: AcpAdapterId): Promise<TokenInfo | null> {
    try {
      return await this.readToken(adapterId);
    } catch (err) {
      log.warn('credential-secrets: readToken failed', {
        adapter: adapterId,
        error: (err as Error).message,
      });
      return null;
    }
  }

  /**
   * (Re)schedule the per-VM proactive refresh: fire `refreshMarginMs` before
   * `expiresAtMs` (clamped to ≥0) so a long dispatch refreshes without waiting on
   * the global ticker cadence. Replaces any prior timer for this entry.
   */
  private scheduleProactive(key: string, entry: RegistryEntry, expiresAtMs: number): void {
    if (entry.timer !== null) {
      this.clearTimer(entry.timer);
      entry.timer = null;
    }
    const delay = Math.max(0, expiresAtMs - this.now() - this.refreshMarginMs);
    entry.timer = this.setTimer(() => {
      entry.timer = null;
      // The whole-adapter refresh fans out to every live manager (incl. this
      // one) and reschedules; a per-VM tick driving the shared refresh is fine
      // because the host-side refresh is flock-serialized + single-flighted.
      void this.refreshAdapter(entry.adapterId);
    }, delay);
  }
}
