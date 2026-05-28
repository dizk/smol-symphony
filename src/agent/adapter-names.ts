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

export type AcpAdapterId = 'claude' | 'codex';

export const KNOWN_ADAPTER_IDS: readonly AcpAdapterId[] = ['claude', 'codex'];

export function isKnownAdapter(id: string): id is AcpAdapterId {
  return (KNOWN_ADAPTER_IDS as readonly string[]).includes(id);
}

/**
 * Absolute path to the host's claude OAuth credential file. The host
 * credential proxy reads this on every upstream request to substitute the
 * live access token for a per-VM sentinel; the workflow loader probes its
 * existence at startup so a missing file fails fast with a clear message
 * instead of opaque per-request errors.
 */
export function hostClaudeCredentialPath(): string {
  return path.join(os.homedir(), '.claude', '.credentials.json');
}

/**
 * Absolute path to the host's codex credential file. The credential proxy
 * re-reads this on every upstream request (a ChatGPT-OAuth `tokens.access_token`
 * or a top-level `OPENAI_API_KEY`); the startup probe reads it once so a
 * completely missing codex credential fails fast instead of surfacing as a
 * mid-dispatch `503 no cached access token`.
 */
export function hostCodexCredentialPath(): string {
  return path.join(os.homedir(), '.codex', 'auth.json');
}

/**
 * Pure: does codex have a resolvable credential from either valid source? The
 * credential proxy reads two — the `~/.codex/auth.json` token (a ChatGPT-OAuth
 * `tokens.access_token` or a top-level `OPENAI_API_KEY`) or an `OPENAI_API_KEY`
 * env var. The shell reads the file (passing `null` when absent/unreadable) and
 * its env in; this mirrors the proxy's `extractCodexToken` + env fallback so the
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
