// Per-adapter Gondolin fake-native-credential staging (design §3.3).
//
// This is the credential-MODEL half of the Gondolin backend — NOT the old proxy
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
// module guarantees is that it **extracts and EMITS only non-secret identity +
// metadata** (codex `account_id` / `auth_mode` / `last_refresh`, claude
// oauthAccount UUIDs — all read by an allowlist of known non-secret keys) — a real
// access/refresh token (or a real `OPENAI_API_KEY`) is never returned to the
// caller, never written into a staged file, and never put in the guest env. The
// guest-facing invariant (no real token in the VM) holds.
//
// LIVE: the runner (`runner.ts`) and `gondolin-dispatch.ts` consume this on the
// dispatch path. The runtime (non-credential) files still flow through
// `adapters.ts`' `stage*` helpers.
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
// the runner's `stageAdapterExtras` guest paths (runner.ts) so a client finds its
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
 * Non-secret codex completeness/identity metadata copied (by an explicit
 * allowlist) into the fake `~/.codex/auth.json`. EVERY field here is non-secret:
 * `accountId` is the `chatgpt_account_id` routing identifier; `authMode` /
 * `lastRefresh` are completeness markers codex 0.135 requires before it will send
 * the bearer (see `buildCodexFiles`). The real access/id/refresh tokens and any
 * real `OPENAI_API_KEY` are NEVER part of this struct — the reader reads them by
 * an allowlist and discards everything else.
 */
export interface CodexIdentity {
  /** `tokens.account_id` — the non-secret `chatgpt_account_id` routing identifier. */
  accountId: string | null;
  /** Top-level `auth_mode` (e.g. `"chatgpt"`) — a non-secret completeness marker. */
  authMode: string | null;
  /** Top-level `last_refresh` ISO timestamp — a non-secret completeness marker. */
  lastRefresh: string | null;
}

/**
 * Injectable host-side reads for the non-secret identity fields. NEITHER reader
 * RETURNS a token: the claude reader returns only the oauthAccount UUIDs, the
 * codex reader returns only an allowlisted set of non-secret metadata fields
 * (account_id / auth_mode / last_refresh) — even though the default codex reader
 * parses an auth.json whose bytes also contain real tokens (it discards them; see
 * the module header invariant). All default to a real file read (lazy fs import)
 * and tolerate a missing/malformed file by returning null.
 */
export interface HostIdentityReaders {
  /** Resolve the non-secret claude oauthAccount identity, or null. */
  readClaudeIdentity(): Promise<ClaudeIdentity | null>;
  /** Resolve the non-secret codex `account_id`, or null. */
  readCodexAccountId(): Promise<string | null>;
  /**
   * Resolve the non-secret codex completeness metadata (account_id / auth_mode /
   * last_refresh), or null when the file is missing/malformed. Reads by an
   * ALLOWLIST — never returns the access/id/refresh token or a real OPENAI_API_KEY.
   */
  readCodexMetadata(): Promise<CodexIdentity | null>;
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
 * codex fake `~/.codex/auth.json`, shaped to be COMPLETE for codex 0.135.
 *
 * GO-LIVE FINDING (2026-05-30, the real root cause; the earlier "post-101 WS
 * drop" was a red herring): codex 0.135's local auth manager runs a COMPLETENESS
 * check on auth.json BEFORE it will send the `Authorization` bearer. A too-minimal
 * `{ tokens: { access_token, id_token, refresh_token, account_id } }` is judged
 * "credentials incomplete" — so codex sends NO bearer at all → unauthenticated →
 * 401 → a blocked refresh → turn refusal. With a COMPLETE auth.json the WS Upgrade
 * gets a clean 101 through Gondolin and the turn completes. The proven-working
 * shape (spike C7, VERIFIED) carries the non-secret top-level completeness fields
 * `auth_mode` + `last_refresh` (and `OPENAI_API_KEY: null`) alongside the tokens
 * block.
 *
 * SAFETY-FIRST: we do NOT spread the host auth.json into the staged file (that
 * would leak a real token if any secret field were missed). Instead we read ONLY
 * an ALLOWLIST of non-secret metadata via the injected reader and BUILD a fresh
 * object from scratch:
 *   - top level: `OPENAI_API_KEY: null` (the OAuth tokens block is the live cred,
 *     never an apikey) + the non-secret `auth_mode` + `last_refresh` when known;
 *   - `tokens`: the JWT-shaped `placeholder` as both `access_token` (codex's
 *     bearer; Gondolin substitutes the real token at egress) and `id_token`, a
 *     JUNK `refresh_token` (the guest has nothing real to rotate), and the
 *     non-secret `account_id` (the `chatgpt-account-id` routing identifier).
 * The placeholder's far-future JWT `exp` (baked in by `credential-secrets.ts`)
 * keeps codex from proactively refreshing. The real access/id/refresh token never
 * enters this object.
 */
async function buildCodexFiles(
  placeholder: string,
  readers: HostIdentityReaders,
): Promise<GuestCredFile[]> {
  const meta = await safeReadCodexMetadata(readers);
  // Re-validate at this STAGING chokepoint (codex review, HIGH). `HostIdentityReaders`
  // is an injectable boundary, so even though the default reader already guards via
  // `extractCodexMetadata`, a custom/buggy/hostile reader could hand us a non-UUID
  // `accountId` (or an out-of-allowlist `authMode`/`lastRefresh`). The same shared
  // guards run again here so a token-shaped value is OMITTED from the staged
  // auth.json regardless of which reader produced it (defense-in-depth).
  const accountId = validAccountId(meta?.accountId ?? null);
  const authMode = validAuthMode(meta?.authMode ?? null);
  const lastRefresh = validLastRefresh(meta?.lastRefresh ?? null);
  const tokens: Record<string, unknown> = {
    access_token: placeholder,
    id_token: placeholder,
    refresh_token: JUNK_REFRESH,
    ...(accountId !== null ? { account_id: accountId } : {}),
  };
  // Top-level non-secret completeness fields. `OPENAI_API_KEY: null` mirrors the
  // host (codex stores the OAuth tokens block, NOT an api key); `auth_mode` /
  // `last_refresh` are the markers codex 0.135's completeness check requires (see
  // the doc comment). All are non-secret; absent/invalid ⇒ omitted (best-effort).
  const auth: Record<string, unknown> = {
    OPENAI_API_KEY: null,
    ...(authMode !== null ? { auth_mode: authMode } : {}),
    tokens,
    ...(lastRefresh !== null ? { last_refresh: lastRefresh } : {}),
  };
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

async function safeReadCodexMetadata(readers: HostIdentityReaders): Promise<CodexIdentity | null> {
  try {
    return await readers.readCodexMetadata();
  } catch (err) {
    log.warn('gondolin-creds-staging: codex metadata read failed (non-fatal)', {
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
 * returns ONLY the non-secret identity/metadata — the claude oauthAccount UUIDs,
 * the codex `account_id`, and the codex completeness metadata (account_id /
 * auth_mode / last_refresh, allowlisted). The codex auth.json's bytes also contain
 * real tokens; they are parsed-then-discarded and never returned/emitted (module
 * header invariant). A missing/malformed file yields null.
 */
export function defaultHostIdentityReaders(): HostIdentityReaders {
  const readCodexAuth = () => readHostJson(path.join(os.homedir(), '.codex', 'auth.json'));
  return {
    readClaudeIdentity: async () =>
      extractClaudeIdentity(await readHostJson(path.join(os.homedir(), '.claude.json'))),
    readCodexAccountId: async () => extractCodexAccountId(await readCodexAuth()),
    readCodexMetadata: async () => extractCodexMetadata(await readCodexAuth()),
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
 *
 * SAFETY-CRITICAL (codex review, HIGH): this value flows (via `symphony.ts` →
 * `buildAdapterCredentialSpecs({ codexAccountId })` → `codexPlaceholder` →
 * `assemblePlaceholderJwt`) into the placeholder JWT's `chatgpt_account_id` claim,
 * and that JWT IS the guest's staged `tokens.access_token` BEARER. So we validate
 * the value through the SHARED {@link validAccountId} UUID guard here: a hostile /
 * malformed `account_id` (a token / `sk-…` / JWT string) is NOT a UUID → returns
 * null → the claim is OMITTED from the bearer (the SAFE failure), never embedded.
 */
export function extractCodexAccountId(parsed: unknown): string | null {
  const tokens = pickObject(parsed, 'tokens');
  if (tokens === null) return null;
  return validAccountId(pickString(tokens, 'account_id'));
}

/**
 * Pure: pull ONLY the allowlisted NON-SECRET codex completeness metadata out of a
 * parsed `~/.codex/auth.json`. SAFETY-CRITICAL: this reads three explicit
 * non-secret keys by name (`tokens.account_id`, top-level `auth_mode`,
 * `last_refresh`) and NEVER touches `tokens.access_token` / `tokens.id_token` /
 * `tokens.refresh_token` / a real `OPENAI_API_KEY` — even though the parsed object
 * holds them. Returns null only when the file is entirely missing/unparseable
 * (parsed === null); a present-but-sparse auth.json yields a struct with null
 * fields (each omitted downstream). The non-null fields are pure identity /
 * metadata that codex 0.135 needs to consider the staged creds complete.
 */
export function extractCodexMetadata(parsed: unknown): CodexIdentity | null {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const top = parsed as Record<string, unknown>;
  const tokens = pickObject(parsed, 'tokens');
  // Strict format guards (codex review, HIGH): account_id flows into the placeholder
  // JWT payload → the guest BEARER, so a hostile/malformed host auth.json must not be
  // able to smuggle a token-shaped value through it. Real tokens (JWT/`sk-…`/refresh)
  // don't match a UUID / a known auth_mode / an ISO-timestamp shape, so on a mismatch
  // we OMIT the field — codex may then judge creds incomplete (the SAFE failure)
  // rather than us staging a real-looking value into a bearer/metadata slot.
  return {
    accountId: validAccountId(tokens !== null ? pickString(tokens, 'account_id') : null),
    authMode: validAuthMode(pickString(top, 'auth_mode')),
    lastRefresh: validLastRefresh(pickString(top, 'last_refresh')),
  };
}

/** A ChatGPT account_id is a UUID; a real token (JWT/`sk-…`/refresh) never matches this. */
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
/** codex auth modes are a tiny closed set. */
const KNOWN_AUTH_MODES: ReadonlySet<string> = new Set(['chatgpt', 'apikey']);
/** `last_refresh` is an ISO-8601 timestamp: digits + `-:.TZ+`, bounded length. */
const ISO_TIMESTAMP_RE = /^[0-9T:.Z+-]{1,40}$/;

/**
 * SHARED account_id guard (codex review, HIGH). The `account_id` is a non-secret
 * UUID routing identifier; a real token (JWT / `sk-…` / refresh) NEVER matches a
 * UUID. Both account_id flows MUST validate through THIS one definition so a
 * hostile/malformed host `~/.codex/auth.json` cannot smuggle a token-shaped value
 * into either sink:
 *   1. the placeholder JWT's `https://api.openai.com/auth.chatgpt_account_id`
 *      claim — which becomes the guest BEARER (`credential-secrets.ts`
 *      `assemblePlaceholderJwt` imports this); and
 *   2. the staged `~/.codex/auth.json` `tokens.account_id` metadata
 *      (`extractCodexMetadata`, below).
 * On a non-UUID value we return null so the field is OMITTED from BOTH sinks (the
 * JWT stays well-formed; codex may then prompt — the SAFE failure) rather than
 * embed a real-looking value.
 */
export function validAccountId(v: string | null): string | null {
  return v !== null && UUID_RE.test(v) ? v : null;
}
function validAuthMode(v: string | null): string | null {
  return v !== null && KNOWN_AUTH_MODES.has(v) ? v : null;
}
function validLastRefresh(v: string | null): string | null {
  return v !== null && ISO_TIMESTAMP_RE.test(v) ? v : null;
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
