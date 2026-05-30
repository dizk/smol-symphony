// Per-adapter Gondolin fake-native-credential staging (design §3.3).
//
// This is the credential-MODEL half of the smolvm→Gondolin flip — NOT the proxy
// model. There is no proxy server and no base-URL injection: the in-VM client
// dials its REAL upstream (claude→api.anthropic.com, codex→chatgpt.com backend,
// opencode→api.githubcopilot.com) in its NATIVE mode, with a token-shaped
// PLACEHOLDER as its bearer. Gondolin substitutes the real access token into the
// outbound request at egress (TLS-MITM) per the per-VM `secretManager`; the real
// refresh/durable token NEVER enters the guest (the invariant).
//
// Given an adapter id + the placeholder value (from `createHttpHooks().env`) +
// identity inputs, this module builds the set of FAKE native credential FILES to
// stage into the guest (guest path + JSON content), each holding ONLY
// placeholders (plus, for codex, the non-secret `account_id` read from the host
// auth.json), and the guest ENV additions (the placeholder bearer keyed by the
// secret name) for a client that reads its bearer from env rather than a file.
//
// CRITICAL — placeholder identity: Gondolin substitutes the secret by EXACT
// string match in the outbound `Authorization` header (design §2). So the bearer
// the guest sends MUST equal the placeholder Gondolin holds. We therefore use the
// placeholder from `createHttpHooks().env[secretName]` VERBATIM as the staged
// file's bearer field (claude `claudeAiOauth.accessToken`, codex
// `tokens.access_token`). For codex that placeholder is ALREADY JWT-shaped with a
// far-future `exp` (see `credential-secrets.ts` `codexPlaceholder`/
// `assemblePlaceholderJwt`), so codex's native mode never refreshes it.
//
// Pure-ish: the only IO is reading the host `~/.codex/auth.json` to copy the
// non-secret `account_id` (codex) and the host `~/.claude.json` to copy the
// non-secret oauthAccount identity (claude). Both are injected via `hostReaders`
// so tests pass fakes — no real creds, no FS.
//
// INVARIANT (precise — codex review): the host `~/.codex/auth.json` DOES contain
// real tokens, so the default reader parses a file whose bytes include them (the
// host process already holds these tokens — `credential-secrets.ts` reads the same
// file for the access token, so this is no new host-side exposure). What this
// module guarantees is that it **extracts and EMITS only the non-secret identity**
// (`account_id`, oauthAccount UUIDs) — a real access/refresh token is never
// returned to the caller, never written into a staged file, and never put in the
// guest env. The guest-facing invariant (no real token in the VM) holds.
//
// DORMANT (Phase 5): only `gondolin-dispatch.ts` (itself off the live runner
// path) consumes this. The smolvm path keeps `adapters.ts`' `stage*` helpers.
//
// The fake-creds shapes are the ones the spike VERIFIED end-to-end (B5 claude,
// C7 codex) — see `spike/gondolin/tests/{b5-claude-real,c7-codex-real}.mjs` and
// `docs/research/gondolin-sandbox-migration.md` §3.3.

import os from 'node:os';
import path from 'node:path';
import { log } from '../logging.js';
import type { AcpAdapterId } from './adapter-names.js';
import { buildOpencodeConfig, OPENCODE_CONFIG_GUEST_PATH } from './adapters.js';

// ---------------------------------------------------------------------------
// Output shape.
// ---------------------------------------------------------------------------

/** A fake native credential file to materialize in the guest (placeholders only). */
export interface GuestCredFile {
  /** Absolute path inside the guest (e.g. `/root/.claude/.credentials.json`). */
  guestPath: string;
  /** UTF-8 file content (JSON). Holds ONLY placeholders + non-secret identity. */
  content: string;
  /** Guest file mode; creds files are 0600. */
  mode: number;
}

/**
 * The full staging result for one adapter dispatch: the fake native creds files
 * plus the guest env additions (the placeholder bearer keyed by the secret name).
 * Both are delivered to the guest BEFORE the agent launches.
 */
export interface GondolinFakeCreds {
  files: GuestCredFile[];
  /** `{ [secretName]: placeholder }` — merged into the guest launch env. */
  env: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Constants.
// ---------------------------------------------------------------------------

// Guest paths the fake native creds land at (the VM runs as root). These mirror
// the smolvm `stageAdapterExtras` guest paths (runner.ts) so a client finds its
// creds in exactly the place its native mode looks.
const CLAUDE_CREDENTIALS_GUEST_PATH = '/root/.claude/.credentials.json';
const CLAUDE_CONFIG_GUEST_PATH = '/root/.claude.json';
const CODEX_AUTH_GUEST_PATH = '/root/.codex/auth.json';

const CRED_FILE_MODE = 0o600;

// Far-future expiry (2100-01-01T00:00:00Z, ms since epoch) so the claude client
// never proactively refreshes the placeholder (a refresh attempt would be
// egress-blocked and is pure waste). Matches the spike's `4102444800000`. (codex's
// far-future `exp` lives inside its JWT placeholder, set in credential-secrets.ts.)
const FAR_FUTURE_MS = 4_102_444_800_000;

// A junk refresh token: token-SHAPED but explicitly never a real token. The guest
// has nothing to rotate (the real refresh token stays host-side, layer 1).
const JUNK_REFRESH = 'JUNK-PLACEHOLDER-REFRESH-not-a-real-token';

// ---------------------------------------------------------------------------
// Injectable host readers (the ONLY IO; never EMITS real tokens — see invariant).
// ---------------------------------------------------------------------------

/** Non-secret claude identity copied verbatim into the fake `~/.claude.json`. */
export interface ClaudeIdentity {
  accountUuid: string;
  organizationUuid: string;
}

/**
 * Injectable host-side reads for the non-secret identity fields. NEITHER reader
 * RETURNS a token: the claude reader returns only the oauthAccount UUIDs, the
 * codex reader returns only the `account_id` — even though the default codex
 * reader parses an auth.json whose bytes also contain real tokens (it discards
 * them; see the module header invariant). Both default to a real file read (lazy
 * fs import) and tolerate a missing/malformed file by returning null.
 */
export interface HostIdentityReaders {
  /** Resolve the non-secret claude oauthAccount identity, or null. */
  readClaudeIdentity(): Promise<ClaudeIdentity | null>;
  /** Resolve the non-secret codex `account_id`, or null. */
  readCodexAccountId(): Promise<string | null>;
}

/** Inputs the per-adapter builders need beyond the placeholder. */
export interface GondolinCredsInput {
  /**
   * The placeholder bearer from `createHttpHooks().env[secretName]`. Used VERBATIM
   * as the staged bearer field (so it byte-matches what Gondolin substitutes).
   */
  placeholder: string;
  /** The secret / env-var name the placeholder is keyed under (e.g. `ANTHROPIC_AUTH_TOKEN`). */
  secretName: string;
  /** The resolved opencode model (custom-provider config); null ⇒ adapter default. */
  opencodeModel?: string | null;
  /** Non-secret host identity reads (injected in tests). */
  hostReaders?: HostIdentityReaders;
}

// ---------------------------------------------------------------------------
// Builders per adapter.
// ---------------------------------------------------------------------------

/**
 * Build the fake native creds + env additions for `adapterId`. The placeholder
 * (a fake, token-shaped value) is what the guest sees as its bearer; Gondolin
 * substitutes the real token at egress. The returned `env` is always the
 * single-entry `{ [secretName]: placeholder }` so a client reading its bearer
 * from env (not a file) still gets the placeholder.
 */
export async function buildGondolinFakeCreds(
  adapterId: AcpAdapterId,
  input: GondolinCredsInput,
): Promise<GondolinFakeCreds> {
  const env = { [input.secretName]: input.placeholder };
  const readers = input.hostReaders ?? defaultHostIdentityReaders();
  switch (adapterId) {
    case 'claude':
      return { files: await buildClaudeFiles(input.placeholder, readers), env };
    case 'codex':
      return { files: await buildCodexFiles(input.placeholder, readers), env };
    case 'opencode':
      return { files: buildOpencodeFiles(input.opencodeModel ?? null), env };
  }
}

/**
 * claude fake `~/.claude/.credentials.json` = `{ claudeAiOauth: { accessToken:
 * <placeholder>, refreshToken: <junk>, expiresAt: <far future ms> } }` (spike B5).
 * Far-future expiry ⇒ no proactive refresh. ALSO stage the scrubbed
 * `~/.claude.json` identity (oauthAccount UUIDs only — the real accountUuid /
 * organizationUuid are identifiers, NOT secrets) when the host provides one;
 * absent identity is non-fatal (best-effort, matching `stageClaudeIdentity`).
 */
async function buildClaudeFiles(
  placeholder: string,
  readers: HostIdentityReaders,
): Promise<GuestCredFile[]> {
  const credsContent = JSON.stringify({
    claudeAiOauth: {
      accessToken: placeholder,
      refreshToken: JUNK_REFRESH,
      expiresAt: FAR_FUTURE_MS,
    },
  });
  const files: GuestCredFile[] = [credFile(CLAUDE_CREDENTIALS_GUEST_PATH, credsContent)];

  const identity = await safeReadClaudeIdentity(readers);
  if (identity !== null) {
    const configContent = JSON.stringify({
      hasCompletedOnboarding: true,
      oauthAccount: identity,
      projects: {},
    });
    files.push(credFile(CLAUDE_CONFIG_GUEST_PATH, configContent));
  }
  return files;
}

/**
 * codex fake `~/.codex/auth.json` with a `tokens` block: the JWT-shaped
 * placeholder (used VERBATIM as both `access_token` and `id_token` — codex's
 * native mode reads `access_token` as its bearer and Gondolin substitutes it at
 * egress) + the REAL, non-secret `account_id` read from the host auth.json (for
 * the `chatgpt-account-id` routing header) + a junk refresh_token. The
 * placeholder's far-future `exp` (baked in by `credential-secrets.ts`) keeps
 * codex from refreshing. `OPENAI_API_KEY` is omitted (the OAuth `tokens` block is
 * the live credential).
 */
async function buildCodexFiles(
  placeholder: string,
  readers: HostIdentityReaders,
): Promise<GuestCredFile[]> {
  const accountId = await safeReadCodexAccountId(readers);
  const tokens: Record<string, unknown> = {
    access_token: placeholder,
    id_token: placeholder,
    refresh_token: JUNK_REFRESH,
    ...(accountId !== null ? { account_id: accountId } : {}),
  };
  // `last_refresh` is omitted on purpose: codex's "is the token expired?" decision
  // keys off the JWT `exp` (far-future, baked into the placeholder), not the file's
  // last_refresh timestamp. Omitting it (matching the apikey-mode fake in
  // adapters.ts) avoids any "time since last refresh" heuristic confusion.
  const auth = { tokens };
  return [credFile(CODEX_AUTH_GUEST_PATH, JSON.stringify(auth))];
}

/**
 * opencode reuses the existing custom-provider config (`buildOpencodeConfig`):
 * `apiKey: {env:OPENCODE_PROXY_TOKEN}`. The placeholder bearer is delivered via
 * the env additions (the `{env:…}` interpolation reads it), so the config file
 * itself holds no token — only the provider declaration + model.
 */
function buildOpencodeFiles(model: string | null): GuestCredFile[] {
  return [credFile(OPENCODE_CONFIG_GUEST_PATH, buildOpencodeConfig(model))];
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

function credFile(guestPath: string, content: string): GuestCredFile {
  return { guestPath, content, mode: CRED_FILE_MODE };
}

async function safeReadClaudeIdentity(readers: HostIdentityReaders): Promise<ClaudeIdentity | null> {
  try {
    return await readers.readClaudeIdentity();
  } catch (err) {
    log.warn('gondolin-creds-staging: claude identity read failed (non-fatal)', {
      error: (err as Error).message,
    });
    return null;
  }
}

async function safeReadCodexAccountId(readers: HostIdentityReaders): Promise<string | null> {
  try {
    return await readers.readCodexAccountId();
  } catch (err) {
    log.warn('gondolin-creds-staging: codex account_id read failed (non-fatal)', {
      error: (err as Error).message,
    });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Default host identity readers (real FS; parse host creds but emit only identity).
// ---------------------------------------------------------------------------

/**
 * Default readers backed by the host filesystem. Each parses the host file and
 * returns ONLY the non-secret identity field — the claude oauthAccount UUIDs and
 * the codex `account_id`. The codex auth.json's bytes also contain real tokens;
 * they are parsed-then-discarded and never returned/emitted (module header
 * invariant). A missing/malformed file yields null.
 */
export function defaultHostIdentityReaders(): HostIdentityReaders {
  return {
    readClaudeIdentity: async () =>
      extractClaudeIdentity(await readHostJson(path.join(os.homedir(), '.claude.json'))),
    readCodexAccountId: async () =>
      extractCodexAccountId(await readHostJson(path.join(os.homedir(), '.codex', 'auth.json'))),
  };
}

async function readHostJson(p: string): Promise<unknown | null> {
  const { readFile } = await import('node:fs/promises');
  let raw: string;
  try {
    raw = await readFile(p, 'utf8');
  } catch {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Pure: pull ONLY the non-secret oauthAccount UUIDs out of a parsed `~/.claude.json`.
 * Mirrors `adapters.ts` `extractOauthAccountIdentity` — no token, no device/session
 * id, no local config.
 */
export function extractClaudeIdentity(parsed: unknown): ClaudeIdentity | null {
  const acct = pickObject(parsed, 'oauthAccount');
  if (acct === null) return null;
  const accountUuid = pickString(acct, 'accountUuid');
  const organizationUuid = pickString(acct, 'organizationUuid');
  if (accountUuid === null || organizationUuid === null) return null;
  return { accountUuid, organizationUuid };
}

/**
 * Pure: pull ONLY the non-secret `account_id` out of a parsed `~/.codex/auth.json`
 * `tokens` block. The parsed object also holds the real access/refresh tokens (the
 * caller parsed the whole file), but this function reads + returns ONLY `account_id`
 * — the tokens are never returned or emitted.
 */
export function extractCodexAccountId(parsed: unknown): string | null {
  const tokens = pickObject(parsed, 'tokens');
  if (tokens === null) return null;
  return pickString(tokens, 'account_id');
}

function pickObject(value: unknown, key: string): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = (value as Record<string, unknown>)[key];
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  return v as Record<string, unknown>;
}

function pickString(obj: Record<string, unknown>, key: string): string | null {
  const v = obj[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}
