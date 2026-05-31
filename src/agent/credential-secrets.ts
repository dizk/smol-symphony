// Host credential-secrets module — homes the credential *lifecycle* (extract,
// mint, refresh) onto Gondolin's secret-injection model. Instead of an HTTP
// proxy that mints per-dispatch sentinels and forwards upstream (the retired
// credential-proxy transport), we hand Gondolin a `createHttpHooks(...)` config
// per VM (host allowlist + a token-shaped placeholder secret + request/response
// hooks) and let Gondolin substitute the real access token into the outbound
// request at egress (TLS-MITM). The host stays the sole owner of the durable
// refresh token; the guest only ever sees a placeholder. See
// `docs/research/gondolin-sandbox-migration.md` §3 (the host-only-refresh
// invariant), §4.3 (the per-VM fan-out design), §4.4 (per-adapter routing).
//
// The host-side credential primitives (token extractors, the GitHub→Copilot
// mint, the flock-serialized refresh) live in `credential-extractors.ts`; this
// module reuses them + `adapter-names.ts` rather than duplicating — only the
// *shape* of the output (a Gondolin hooks config + an `updateSecret` push) is new.
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
import { Buffer } from 'node:buffer';
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
import { validAccountId } from './gondolin-creds-staging.js';
import {
  extractClaudeToken,
  extractCodexToken,
  codexEnvFallback,
  defaultClaudeRefresher,
  defaultCopilotExchange,
  defaultFlockAcquire,
  COPILOT_EGRESS_HEADERS,
  COPILOT_EXCHANGE_HOST,
  COPILOT_EXCHANGE_PATH,
  COPILOT_INFERENCE_HOST,
  type TokenInfo,
  type CopilotTokenExchange,
  type LockAcquire,
} from './credential-extractors.js';

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
/**
 * codex (ChatGPT-OAuth) runs in its NATIVE mode reading
 * `~/.codex/auth.json:tokens.access_token` as its bearer, so the placeholder must
 * be JWT-SHAPED (header.payload.signature) with a far-future `exp` — otherwise
 * codex treats it as expired and tries to refresh (egress-blocked, doomed). The
 * placeholder Gondolin substitutes at egress must be byte-identical to that
 * bearer, so the SAME assembled JWT is both the secret's placeholder here and the
 * staged `tokens.access_token` (see `gondolin-creds-staging.ts`, which reads this
 * placeholder out of `createHttpHooks().env` verbatim). The header + payload are
 * fixed; the signature segment is a high-entropy random string so each VM's
 * placeholder is unique + exact-matchable. Built once at `createHttpHooks()` time.
 *
 * GO-LIVE FINDING: codex-acp's local auth manager reads the
 * `https://api.openai.com/auth` claim (specifically `chatgpt_account_id`) out of
 * the bearer JWT *before* any egress. A placeholder with only `{ exp }` (no auth
 * claim) makes codex-acp consider the token incomplete and attempt a token
 * REFRESH mid-turn — which is egress-blocked → 403 → the turn is refused. The
 * spike's C7 placeholder embedded that claim and passed; production had dropped
 * it. So when the host `account_id` is known we embed it in the placeholder's
 * auth claim. The id is a NON-SECRET identifier (same one staged into auth.json's
 * `tokens.account_id`), never a token.
 */
function codexPlaceholder(accountId: string | null): () => string {
  const randomSig = makePlaceholderFunc({ length: 86, alphabet: BASE64URL_ALPHABET });
  return () => assemblePlaceholderJwt(randomSig(), accountId);
}
function opencodePlaceholder(): () => string {
  // The opencode custom provider forwards this as its bearer; a `gho_`-shaped
  // token keeps it indistinguishable in shape from a real Copilot/GitHub token.
  return makePlaceholderFunc({ prefix: 'gho_', length: 36, alphabet: BASE64URL_ALPHABET });
}

/**
 * Far-future JWT `exp` (seconds since epoch — 2100-01-01T00:00:00Z) baked into the
 * codex placeholder so codex's native mode treats it as a long-lived, unexpired
 * token and never attempts a refresh (which would be egress-blocked). Exported so
 * the fake-creds staging + tests can assert the same instant.
 */
export const PLACEHOLDER_JWT_EXP_SECONDS = 4_102_444_800;

/**
 * Assemble a structurally-valid (but cryptographically meaningless) JWT-shaped
 * placeholder: `base64url(header).base64url(payload).<signature>`. codex never
 * verifies the signature — it reads `exp` (must be far-future, so it never tries
 * to refresh) and the `https://api.openai.com/auth.chatgpt_account_id` claim
 * (which it uses to route + to consider the token complete; a missing claim
 * triggers a refresh, see `codexPlaceholder`). The real token replaces this whole
 * string at egress. The `signature` segment is the caller's high-entropy random
 * string, making each VM's placeholder unique + exact-matchable by Gondolin's
 * header substitution.
 *
 * `accountId` is the NON-SECRET `chatgpt_account_id` (when known); embedding it in
 * the auth claim mirrors the spike's proven C7 placeholder. When null (host has no
 * account_id) the claim is omitted — the JWT is still well-formed; codex may then
 * refresh, but there is no id to embed.
 *
 * SAFETY-CRITICAL (codex review, HIGH): this JWT becomes the guest's staged BEARER,
 * so this is the LAST chokepoint before a host `account_id` lands in a bearer slot.
 * The id is re-validated through the SHARED {@link validAccountId} UUID guard here
 * (defense-in-depth — independent of the caller's own validation): a non-UUID /
 * token-shaped value is NOT embedded; the claim is simply OMITTED (the well-formed,
 * SAFE failure). A real token (JWT / `sk-…` / refresh) never matches a UUID, so it
 * can never reach the `chatgpt_account_id` claim via this path.
 */
export function assemblePlaceholderJwt(signature: string, accountId: string | null = null): string {
  const safeAccountId = validAccountId(accountId);
  const header = base64urlJson({ alg: 'RS256', typ: 'JWT' });
  const payload = base64urlJson({
    exp: PLACEHOLDER_JWT_EXP_SECONDS,
    ...(safeAccountId !== null
      ? { 'https://api.openai.com/auth': { chatgpt_account_id: safeAccountId } }
      : {}),
  });
  return `${header}.${payload}.${signature}`;
}

function base64urlJson(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
}

// ---------------------------------------------------------------------------
// Credential source: extract the host-side access token for an adapter.
// ---------------------------------------------------------------------------

/**
 * Per-adapter credential lifecycle, reusing the proxy's extractor/mint/refresh
 * logic verbatim — only the *delivery* (push into a Gondolin secret) is new.
 *   - `secretName`     the Gondolin secret / env var name the placeholder is keyed under
 *   - `substitutionHosts` the hosts the real token may be substituted onto at egress
 *                      (the credential's validity scope). NOT the general firewall:
 *                      `buildAdapterHooksConfig` unions these with the workspace
 *                      `egress.allowed_hosts` to form `createHttpHooks.allowedHosts`,
 *                      but only `substitutionHosts` are wired into `secrets[].hosts`,
 *                      so a general egress host never receives a real token.
 *   - `placeholder`    the token-shaped placeholder generator (§4.3)
 *   - `readToken()`    resolve the current host-side access token (or null)
 *   - `refresh()`      drive a host-side refresh (claude `claude -p`; opencode mint)
 *   - `egressHeaders`  static headers attached at egress (opencode editor headers)
 *   - `onRequest`      optional per-adapter request guard (opencode path-allowlist)
 */
export interface AdapterCredentialSpec {
  adapterId: AcpAdapterId;
  secretName: string;
  /** Hosts the real token may be substituted onto (credential validity scope),
   *  NOT the general egress firewall — see the interface doc above. */
  substitutionHosts: readonly string[];
  placeholder(): () => string;
  readToken(): Promise<TokenInfo | null>;
  refresh(): Promise<void>;
  egressHeaders?: Record<string, string>;
  onRequest?: HttpHooks['onRequest'];
  /**
   * Whether this adapter's guest egress may open a WebSocket. codex-acp streams
   * the Responses API over a WS Upgrade, so codex needs `true`; claude/opencode are
   * plain HTTPS so they stay `false` (default-deny). SAFE under Gondolin: the real
   * token is substituted on the Upgrade handshake's `Authorization` header (the
   * handshake is hookable — `createHttpHooks` `onRequest` runs `applySecretsToRequest`),
   * so the placeholder never egresses; the post-101 frames are an opaque tunnel to
   * the ALLOWLISTED inference host only (a non-allowlisted refresh host's upgrade is
   * blocked). The old proxy-era `#127` wss-leak risk does NOT apply (the proxy
   * couldn't substitute inside the tunnel; Gondolin substitutes before it).
   */
  allowWebSockets: boolean;
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
  /**
   * The host's NON-SECRET codex `chatgpt_account_id`. Embedded in the codex
   * placeholder JWT's `https://api.openai.com/auth` claim so codex-acp considers
   * the (placeholder) bearer complete and does NOT attempt a mid-turn refresh
   * (egress-blocked → 403 → refusal — the go-live finding). Resolve it once at
   * composition (see `defaultHostIdentityReaders().readCodexAccountId`) and pass
   * it here. Null/absent ⇒ the claim is omitted (best-effort).
   */
  codexAccountId?: string | null;
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
      substitutionHosts: [CLAUDE_UPSTREAM_HOST],
      placeholder: claudePlaceholder,
      readToken: async () => extractClaudeToken(await readJsonFile(claudeCredsPath)),
      refresh: claudeRefresher,
      allowWebSockets: false, // plain HTTPS
    },
    codex: {
      adapterId: 'codex',
      secretName: CODEX_SECRET_NAME,
      substitutionHosts: [CODEX_UPSTREAM_HOST],
      // codex-acp streams /backend-api/codex/responses over a WebSocket Upgrade.
      // It MUST be allowed: the real token is substituted on the hookable Upgrade
      // handshake (createHttpHooks onRequest → applySecretsToRequest), so the
      // handshake reaches the ALLOWLISTED inference host with the real bearer and
      // gets a clean 101; the post-101 frames are an opaque tunnel to that one
      // host. SAFE — the placeholder never egresses and a non-allowlisted refresh
      // host's upgrade is blocked. The earlier "post-101 tunnel drop" was a red
      // herring: it was caused by an INCOMPLETE staged auth.json (codex 0.135
      // judged the creds incomplete → sent no bearer → 401 → blocked refresh). With
      // a COMPLETE staged auth.json (auth_mode + last_refresh + the tokens block —
      // see gondolin-creds-staging.ts buildCodexFiles) the WS turn completes
      // end-to-end (validated 2026-05-30 through the production dispatch path).
      allowWebSockets: true,
      // Bind the host account_id into the placeholder JWT's auth claim so
      // codex-acp does not refresh the placeholder (go-live finding).
      placeholder: () => codexPlaceholder(opts.codexAccountId ?? null),
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
    // oracle guard (§4.4). Both are substitution hosts: the minted Copilot token
    // is valid on inference, and the exchange handshake is hookable on the
    // exchange host (the placeholder never egresses).
    substitutionHosts: [COPILOT_INFERENCE_HOST, COPILOT_EXCHANGE_HOST],
    placeholder: opencodePlaceholder,
    egressHeaders: COPILOT_EGRESS_HEADERS,
    // The minted Copilot token is the secret value; reading it returns the cache
    // (null until the first mint runs as `refresh`).
    readToken: async () => cache.token,
    refresh: underLock(args.lockAcquire, args.lockTimeoutMs, mint),
    onRequest: makeGithubExchangePathGuard(),
    allowWebSockets: false, // openai-compatible HTTP provider
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
 * Egress audit. Wraps an adapter's optional `onRequest` guard with a log line for
 * EVERY guest egress request. Gondolin invokes `onRequest` before its host allow/deny
 * check, so this sees every request the guest attempts — allowed, about-to-be-blocked,
 * and TLS-MITM'd inference calls alike — the only host-side visibility into in-VM
 * egress (the ACP run log captures only ACP frames + adapter stderr). The `allowed`
 * flag is a best-effort match against this adapter's resolved allowlist (exact or
 * subdomain), so an `allowed:false` line pinpoints a blocked host the SDK reached.
 * NEVER logs the URL query or any header (a placeholder/real token can ride either) —
 * only method + host + pathname. Pure pass-through: logs, then delegates to `inner`
 * (if any) unchanged. (Originally added while diagnosing issue 135; kept as standing
 * observability.)
 */
export function makeEgressAuditHook(
  adapterId: AcpAdapterId,
  allowedHosts: readonly string[],
  inner: HttpHooks['onRequest'] | undefined,
): NonNullable<HttpHooks['onRequest']> {
  return async (request: Request) => {
    try {
      const u = new URL(request.url);
      const host = u.hostname;
      const allowed = allowedHosts.some((h) => host === h || host.endsWith(`.${h}`));
      log.info('egress request', {
        adapter: adapterId,
        method: request.method,
        host,
        path: u.pathname,
        allowed,
      });
    } catch {
      // Logging must never break egress.
    }
    return inner ? inner(request) : undefined;
  };
}

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
    // Permit ONLY the exact exchange endpoint with NO query string. The legitimate
    // host-side exchange (`defaultCopilotExchange`) sends a bare path; a
    // `?…`-variant is neither needed nor trusted, so requiring an empty search
    // keeps the allow condition as narrow as the real call (codex review).
    if (method === 'GET' && url.pathname === COPILOT_EXCHANGE_PATH && url.search === '') return; // permit
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
  /** Whether the guest may open a WebSocket (codex-acp Responses stream needs it). */
  allowWebSockets: boolean;
}

/**
 * Build the `createHttpHooks` config for a single adapter spec.
 *
 * The egress firewall (`options.allowedHosts`) = the general workspace dev-tooling
 * allowlist (`egress.allowed_hosts` from WORKFLOW.md — npm/git/CDNs) UNION this
 * adapter's `substitutionHosts` (you must be able to reach the host whose token you
 * substitute on). SECURITY: only `substitutionHosts` are wired into
 * `secrets[].hosts`, so the real token is NEVER substituted for a general egress
 * host — those receive plain network egress only. The firewall is the union; the
 * substitution scope is not.
 */
export function buildAdapterHooksConfig(
  spec: AdapterCredentialSpec,
  egressAllowlist: readonly string[] = [],
): AdapterHooksConfig {
  const allowedHosts = [...new Set([...egressAllowlist, ...spec.substitutionHosts])];
  // Host-side egress audit (standing observability): wrap the adapter's optional
  // onRequest guard so every guest egress request is logged with an `allowed` flag.
  // Gondolin runs onRequest BEFORE its allow/deny check, so this is the only host-side
  // window into in-VM egress. Safe with streaming (onRequest never disables it; only
  // onResponse does — see the no-onResponse note below). To quiet it, unwrap to
  // `spec.onRequest`.
  const onRequest = makeEgressAuditHook(spec.adapterId, allowedHosts, spec.onRequest);
  // FIX (issue 135, 2026-05-31): do NOT register an `onResponse` hook. Gondolin only
  // streams a response when there is no onResponse — `canStream = Boolean(body) &&
  // !httpHooks.onResponse` (qemu/http.js). With onResponse set, Gondolin FULLY BUFFERS
  // every response (`bufferResponseBodyWithLimit`) before the guest sees a byte. For a
  // long streaming model turn (~400 KB SSE over ~90–120 s) the in-VM SDK — a streaming
  // client — gets nothing for the whole generation window, trips its stream timeout,
  // silently retries, and after ~16 min dies with ECONNRESET → re-dispatch loop. The
  // old `onResponse` was a pure billing-tell (rate-limit header logging), no functional
  // role; dropping it restores streaming. To restore that logging without breaking
  // streaming, Gondolin needs a header-only response hook (it has none today) — see the
  // still-exported `makeBillingTellResponseHook` and the "vendor Gondolin" option.
  const options: CreateHttpHooksOptions = {
    allowedHosts,
    secrets: {
      [spec.secretName]: {
        hosts: [...spec.substitutionHosts],
        // Seeded later via `updateSecret`; the empty initial value is never
        // forwarded on the happy path (the registry seeds before first exec).
        value: '',
        placeholder: spec.placeholder(),
      },
    },
    onRequest,
  };
  return {
    adapterId: spec.adapterId,
    secretName: spec.secretName,
    options,
    readToken: spec.readToken,
    refresh: spec.refresh,
    allowWebSockets: spec.allowWebSockets,
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
  // Per-adapter rotation counter, bumped on every `pushToAll(adapterId, …)`.
  // `register` snapshots its adapter's counter across the async `readToken` so it
  // can detect a rotation FOR THAT ADAPTER that landed mid-read and avoid
  // clobbering the fresher value with its own stale read. Per-adapter (not global)
  // so a rotation for a *different* adapter never makes a cold entry skip seeding.
  private readonly cacheSeq = new Map<AcpAdapterId, number>();
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

    const seqBefore = this.cacheSeq.get(args.adapterId) ?? 0;
    const token = await this.safeReadToken(args.adapterId);
    this.seedUnlessRotated(key, entry, args.adapterId, seqBefore, token);
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
    this.cacheSeq.set(adapterId, (this.cacheSeq.get(adapterId) ?? 0) + 1);
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

  /**
   * Seed a freshly-registered entry from its read token — UNLESS a rotation for
   * the same adapter landed during the async read (codex review). The entry is
   * inserted synchronously before `register`'s await, so a concurrent
   * `pushToAll(adapterId, …)` already applied the fresher value to it; re-applying
   * our older read would both regress the live value and revoke the fresher one
   * (gondolin revokes the old value whenever the new differs). The sequence is
   * per-adapter, so a rotation for a *different* adapter never starves this seed.
   */
  private seedUnlessRotated(
    key: string,
    entry: RegistryEntry,
    adapterId: AcpAdapterId,
    seqBefore: number,
    token: TokenInfo | null,
  ): void {
    if ((this.cacheSeq.get(adapterId) ?? 0) !== seqBefore) return;
    const seedValue = token?.accessToken ?? this.cachedValue.get(adapterId) ?? '';
    if (token?.accessToken) this.cachedValue.set(adapterId, token.accessToken);
    this.applyToEntry(key, entry, seedValue);
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
