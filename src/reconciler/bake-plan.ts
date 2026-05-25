// Pure decision logic for the bake resource. Split out so the IO-driven adapter
// in `./bake.ts` only owns the imperative shell (fs, child_process, smolvm);
// hashing the Smolfile content and picking GC victims are deterministic
// functions of their inputs and live here.

import { createHash } from 'node:crypto';

/** Content-addressed bake artifact key. */
export function computeBakeHash(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

export interface CachedArtifact {
  name: string;
  mtime: number;
}

/**
 * Select bake-cache entries to evict. The current `keepName` is always
 * preserved; the remaining slots are filled by mtime descending (most recent
 * first). Returns the names that should be unlinked. Pure: callers handle the
 * actual fs deletes.
 */
export function selectGcVictims(
  artifacts: CachedArtifact[],
  keepName: string,
  maxEntries: number,
): string[] {
  if (artifacts.length <= maxEntries) return [];
  const sorted = [...artifacts].sort((a, b) => b.mtime - a.mtime);
  const keep = new Set<string>([keepName]);
  for (const a of sorted.slice(0, maxEntries)) keep.add(a.name);
  return artifacts.filter((a) => !keep.has(a.name)).map((a) => a.name);
}
