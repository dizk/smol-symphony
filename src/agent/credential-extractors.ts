// Host-side credential primitives: pull the live access token out of each
// adapter's on-host credential file, drive a host-side refresh, and mint the
// short-lived GitHub→Copilot token. These are the "extractor" half of the old
// `credential-proxy.ts` — the transport (the per-dispatch HTTP proxy that
// terminated sentinels and forwarded to upstream) is gone; under Gondolin the
// real token is substituted at egress by `createHttpHooks` in
// `credential-secrets.ts`, which builds on exactly these helpers.
//
// The "only the host refreshes" invariant lives here too: `extractCodexToken`
// NEVER reads `tokens.refresh_token`, and `defaultClaudeRefresher` triggers
// Anthropic's own client (`claude -p`) rather than implementing OAuth — the
// refresh token never leaves the host and never reaches the guest.

import { request as httpsRequest, type RequestOptions as HttpsRequestOptions } from 'node:https';
import { mkdir } from 'node:fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';

/** Access token plus its absolute expiry (ms since epoch), or null when unknown. */
export interface TokenInfo {
  accessToken: string;
  expiresAtMs: number | null;
  /**
   * codex only: true when `accessToken` is a ChatGPT-OAuth subscription token
   * (auth.json `tokens.access_token`). Such tokens are honored ONLY on the
   * ChatGPT backend (chatgpt.com/backend-api/codex), never the metered platform
   * API (api.openai.com/v1, which 401s for the missing `api.responses.write`
   * scope). The codex egress route keys on this; an API-key credential leaves it
   * false/undefined and keeps the default platform route.
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
 * Exchange a durable GitHub OAuth token for a short-lived GitHub Copilot token
 * (POST/GET `api.github.com/copilot_internal/v2/token`). Returns the Copilot
 * token + its expiry. Injectable so opencode tests don't hit the network. The
 * exchange HOST (api.github.com) is distinct from the inference host
 * (api.githubcopilot.com).
 */
export type CopilotTokenExchange = (githubToken: string) => Promise<TokenInfo>;

/**
 * Acquire the cross-process refresh lock. The returned promise resolves to a
 * `release` callback once the lock is held; on timeout / failure, the promise
 * rejects with `Error("credential proxy: refresh lock acquire timeout")`.
 * `release` is idempotent; calling it more than once is a no-op.
 */
export type LockAcquire = (timeoutMs: number) => Promise<() => Promise<void>>;

// Anthropic's subscription billing tell: the unified-window ratelimit family +
// org id. Logged per response so operators can observe Max-window consumption.
// Used by `credential-secrets`' `onResponse` hook.
export const CLAUDE_BILLING_TELL_HEADERS: readonly string[] = [
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
// `x-ratelimit-*` candidate family; whichever appear are logged.
export const CODEX_BILLING_TELL_HEADERS: readonly string[] = [
  'x-ratelimit-limit-requests',
  'x-ratelimit-remaining-requests',
  'x-ratelimit-reset-requests',
  'x-ratelimit-limit-tokens',
  'x-ratelimit-remaining-tokens',
  'x-ratelimit-reset-tokens',
];

/**
 * Default claude refresher: spawn `claude -p "ok"` and resolve when it exits.
 * Claude Code's own OAuth path detects the stale access token, refreshes against
 * Anthropic, and atomically writes the rotated tuple back to
 * `~/.claude/.credentials.json`. Symphony never implements OAuth — Anthropic's
 * own client does.
 */
export function defaultClaudeRefresher(): () => Promise<void> {
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
 * Pull `accessToken` and `expiresAt` out of the claude credentials JSON. The
 * shape `claude` writes is `{ claudeAiOauth: { accessToken, expiresAt, ... } }`,
 * but we tolerate flat top-level fields too for forward compatibility.
 */
export function extractClaudeToken(parsed: unknown): TokenInfo | null {
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
 * tokens are long-lived (~8 days) and credential-secrets re-reads on demand
 * rather than driving a refresh (research Q3 option c).
 */
export function extractCodexToken(parsed: unknown): TokenInfo | null {
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

function nonEmptyString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** Read `OPENAI_API_KEY` from the host environment as a codex credential fallback. */
export function codexEnvFallback(): TokenInfo | null {
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
export function defaultFlockAcquire(lockPath: string): LockAcquire {
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

// ---------------------------------------------------------------------------
// opencode / GitHub Copilot token exchange (issue 130).
//
// opencode's auth.json holds a DURABLE GitHub OAuth token that
// `api.githubcopilot.com` does NOT accept. It must be exchanged host-side for a
// short-lived (~30 min) Copilot token at
// `api.github.com/copilot_internal/v2/token`, which then becomes the bearer.
// The durable GitHub OAuth token never becomes the bearer and never enters the
// guest. See docs/research/opencode-copilot-accept-matrix.md.

// Used by `credential-secrets` for its `allowedHosts` + the `api.github.com`
// path-allowlist guard.
export const COPILOT_EXCHANGE_HOST = 'api.github.com';
export const COPILOT_EXCHANGE_PATH = '/copilot_internal/v2/token';
export const COPILOT_INFERENCE_HOST = 'api.githubcopilot.com';

// A VS Code Copilot Chat identity. The in-VM `@ai-sdk/openai-compatible` client
// sends none of these, so the host supplies the full set real-world Copilot
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
 * headers are case-insensitive and inbound headers are normalised to lowercase,
 * so these merge cleanly over the inbound set).
 */
export const COPILOT_EGRESS_HEADERS: Record<string, string> = {
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
export const COPILOT_BILLING_TELL_HEADERS: readonly string[] = [
  'x-ratelimit-limit-requests',
  'x-ratelimit-remaining-requests',
  'x-ratelimit-limit-tokens',
  'x-ratelimit-remaining-tokens',
  'x-github-request-id',
];

/**
 * Default GitHub→Copilot token exchange: `GET api.github.com/copilot_internal/v2/token`
 * with `Authorization: token <gho_…>` (GitHub's classic-token scheme, NOT
 * Bearer) and the editor headers. Parses `{ token, expires_at }` — `expires_at`
 * is unix SECONDS, converted to ms. DOC-DERIVED request/response shape.
 */
export function defaultCopilotExchange(): CopilotTokenExchange {
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
