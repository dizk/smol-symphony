// Known-adapter registry: id type and membership check.
//
// This module is the seam between the config layer (src/workflow.ts) and the IO
// adapter layer (src/agent/adapters.ts). Both sides need to agree on which adapter
// ids exist; pulling the registry out of adapters.ts lets workflow.ts validate
// configured ids without importing the IO layer (which would flip the layering
// direction). The full adapter *profile* (binary, model injection, effort
// injection, …) still lives in agent/adapters.ts.

import path from 'node:path';
import os from 'node:os';

export type AcpAdapterId = 'claude' | 'codex' | 'opencode';

export const KNOWN_ADAPTER_IDS: readonly AcpAdapterId[] = ['claude', 'codex', 'opencode'];

export function isKnownAdapter(id: string): id is AcpAdapterId {
  return (KNOWN_ADAPTER_IDS as readonly string[]).includes(id);
}

/**
 * Absolute path to the host's claude OAuth credential file. The host reads this
 * to substitute the live access token into the outbound request at Gondolin
 * egress (the guest only ever holds a token-shaped placeholder); the workflow
 * loader probes its existence at startup so a missing file fails fast with a
 * clear message instead of opaque per-request errors.
 */
export function hostClaudeCredentialPath(): string {
  return path.join(os.homedir(), '.claude', '.credentials.json');
}

/**
 * Absolute path to the host's codex credential file. The host re-reads this to
 * substitute the live token into the outbound request at Gondolin egress (a
 * ChatGPT-OAuth `tokens.access_token` or a top-level `OPENAI_API_KEY`); the
 * startup probe reads it once so a completely missing codex credential fails
 * fast instead of surfacing as a mid-dispatch `503 no cached access token`.
 */
export function hostCodexCredentialPath(): string {
  return path.join(os.homedir(), '.codex', 'auth.json');
}

/**
 * Absolute path to the host's opencode credential file. opencode stores its
 * `opencode auth login` credentials at `$XDG_DATA_HOME/opencode/auth.json`
 * (defaulting to `~/.local/share/opencode/auth.json`). The host reads the
 * GitHub Copilot OAuth token out of this file to mint a short-lived Copilot
 * token and substitute it into the outbound request at Gondolin egress, and the
 * startup probe reads it once so a missing/empty opencode credential fails fast
 * instead of surfacing mid-dispatch.
 */
export function hostOpencodeCredentialPath(): string {
  const xdg = process.env['XDG_DATA_HOME'];
  const base = nonEmptyString(xdg) ? xdg! : path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'opencode', 'auth.json');
}

/**
 * Pure: pull the durable GitHub OAuth token out of opencode's parsed
 * `auth.json`. opencode keys credentials by provider id; the GitHub Copilot
 * entry is stored under `"github-copilot"` as an OAuth record. The DURABLE
 * GitHub OAuth token (the secret the host keeps and exchanges for a short-lived
 * Copilot token) lives under `refresh`; opencode caches the
 * exchanged short-lived Copilot token under `access`/`expires` in the same
 * record. We deliberately read `refresh` first — that is the long-lived token
 * the exchange needs — and tolerate alternate field names for forward
 * compatibility. Returns null when no github-copilot OAuth token is present.
 *
 * The exact shape is DOC-DERIVED (see docs/research/opencode-copilot-accept-matrix.md):
 * `{ "github-copilot": { "type": "oauth", "refresh": "gho_…", "access": "tok…", "expires": <ms> } }`.
 */
export function opencodeGithubTokenFromAuth(parsed: unknown): string | null {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const entry = (parsed as Record<string, unknown>)['github-copilot'];
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const rec = entry as Record<string, unknown>;
  // Prefer `refresh` (the durable GitHub OAuth token); fall back across plausible
  // field names so a minor opencode storage-schema change doesn't silently break us.
  for (const key of ['refresh', 'token', 'access', 'oauth']) {
    if (nonEmptyString(rec[key])) return rec[key] as string;
  }
  return null;
}

/**
 * Pure: read the GitHub OAuth token opencode would use for the Copilot
 * exchange from the host environment, following opencode's documented
 * precedence `COPILOT_GITHUB_TOKEN` > `GH_TOKEN` > `GITHUB_TOKEN`. Returns the
 * first non-empty value, or null. The host uses this as the fallback when
 * `auth.json` yields no token; the startup probe uses it to accept a dispatch
 * the host could serve from the environment alone.
 */
export function opencodeGithubTokenFromEnv(env: NodeJS.ProcessEnv): string | null {
  for (const key of ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN']) {
    if (nonEmptyString(env[key])) return env[key]!;
  }
  return null;
}

/**
 * Pure: does opencode have a resolvable GitHub Copilot credential from either
 * source the host reads — a `github-copilot` token in `auth.json`, or one of
 * the `COPILOT_GITHUB_TOKEN`/`GH_TOKEN`/`GITHUB_TOKEN` env vars? The shell
 * reads the file (passing `null` when absent/unreadable) and its env in; this
 * mirrors the host's egress read path so the startup probe accepts exactly when
 * a dispatch would.
 */
export function opencodeCredentialAvailable(
  authFileText: string | null,
  env: NodeJS.ProcessEnv,
): boolean {
  if (opencodeGithubTokenFromEnv(env) !== null) return true;
  if (authFileText === null) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(authFileText);
  } catch {
    return false;
  }
  return opencodeGithubTokenFromAuth(parsed) !== null;
}

/** Human-readable explanation of which opencode credential sources were checked. */
export function opencodeMissingCredentialMessage(): string {
  return `adapter "opencode" requires a host GitHub Copilot credential, but none is available: neither a "github-copilot" token in ${hostOpencodeCredentialPath()} (run \`opencode auth login\` → GitHub Copilot on the host) nor a COPILOT_GITHUB_TOKEN/GH_TOKEN/GITHUB_TOKEN environment variable is present`;
}

/**
 * Pure: does codex have a resolvable credential from either valid source? The
 * host reads two — the `~/.codex/auth.json` token (a ChatGPT-OAuth
 * `tokens.access_token` or a top-level `OPENAI_API_KEY`) or an `OPENAI_API_KEY`
 * env var. The shell reads the file (passing `null` when absent/unreadable) and
 * its env in; this mirrors the host's `extractCodexToken` + env fallback so the
 * startup probe accepts exactly when a dispatch would.
 */
export function codexCredentialAvailable(
  authFileText: string | null,
  env: NodeJS.ProcessEnv,
): boolean {
  if (nonEmptyString(env['OPENAI_API_KEY'])) return true;
  if (authFileText === null) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(authFileText);
  } catch {
    return false;
  }
  return codexAuthFileHasToken(parsed);
}

/** Human-readable explanation of which codex credential sources were checked. */
export function codexMissingCredentialMessage(): string {
  return `adapter "codex" requires a host credential, but none is available: neither a token in ${hostCodexCredentialPath()} (ChatGPT-OAuth tokens.access_token or OPENAI_API_KEY) nor an OPENAI_API_KEY environment variable is present`;
}

function codexAuthFileHasToken(parsed: unknown): boolean {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  const root = parsed as Record<string, unknown>;
  const tokens = root['tokens'];
  if (tokens && typeof tokens === 'object' && !Array.isArray(tokens)) {
    if (nonEmptyString((tokens as Record<string, unknown>)['access_token'])) return true;
  }
  return nonEmptyString(root['OPENAI_API_KEY']);
}

function nonEmptyString(v: unknown): boolean {
  return typeof v === 'string' && v.length > 0;
}
