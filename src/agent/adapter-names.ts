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
 * instead of opaque per-request errors. The codex adapter has no host file
 * dependency under the proxy architecture — it relies on `OPENAI_API_KEY`
 * forwarded via `smolvm.forward_env`.
 */
export function hostClaudeCredentialPath(): string {
  return path.join(os.homedir(), '.claude', '.credentials.json');
}
