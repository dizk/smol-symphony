// Known-adapter registry: id type, membership check, and the host credential path
// each adapter expects under $HOME.
//
// This module is the seam between the config layer (src/workflow.ts) and the IO
// adapter layer (src/agent/adapters.ts). Both sides need to agree on which adapter
// ids exist and where their credential files live; pulling the registry out of
// adapters.ts lets workflow.ts validate configured ids without importing the IO
// layer (which would flip the layering direction). The full adapter *profile*
// (binary, model injection, effort injection, …) still lives in agent/adapters.ts
// and consumes the constants exported here.

import path from 'node:path';
import os from 'node:os';

export type AcpAdapterId = 'claude' | 'codex';

export const KNOWN_ADAPTER_IDS: readonly AcpAdapterId[] = ['claude', 'codex'];

/**
 * Path under $HOME on the host where each adapter expects to find its credential
 * file. The corresponding AdapterProfile in src/agent/adapters.ts consumes this
 * map so the relative path is defined exactly once.
 */
export const HOST_CREDENTIAL_PATHS: Record<AcpAdapterId, string> = {
  claude: '.claude/.credentials.json',
  codex: '.codex/auth.json',
};

export function isKnownAdapter(id: string): id is AcpAdapterId {
  return (KNOWN_ADAPTER_IDS as readonly string[]).includes(id);
}

/** Absolute path on the host where adapter `id`'s credential file lives. */
export function hostCredentialAbsPathForId(id: AcpAdapterId): string {
  return path.join(os.homedir(), HOST_CREDENTIAL_PATHS[id]);
}
