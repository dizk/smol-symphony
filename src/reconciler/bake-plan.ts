// Pure decision logic for the bake resource. Split out so the IO-driven adapter
// in `./bake.ts` only owns the imperative shell (fs, child_process, smolvm);
// hashing the Smolfile content and picking GC victims are deterministic
// functions of their inputs and live here.

import { createHash } from 'node:crypto';

/**
 * Content-addressed bake artifact key. Folds in the Smolfile bytes plus, for any
 * host directory the Smolfile bakes into the image via `[dev].volumes`, a
 * content digest of that directory. The latter is essential now that scripts/ is
 * copied into the rootfs at bake time (vs. a runtime bind-mount): without it,
 * editing `vm-agent.mjs` would not change the Smolfile and the stale baked
 * artifact would be reused. `bakedInputs` is sorted by path so the key is
 * order-independent.
 */
export function computeBakeHash(
  content: Buffer,
  bakedInputs: ReadonlyArray<{ path: string; digest: string }> = [],
): string {
  const h = createHash('sha256');
  h.update(content);
  for (const { path, digest } of [...bakedInputs].sort((a, b) => a.path.localeCompare(b.path))) {
    h.update('\0baked\0');
    h.update(path);
    h.update('\0');
    h.update(digest);
  }
  return h.digest('hex');
}

/**
 * Extract the host paths from a Smolfile's `[dev].volumes` (`"host:guest[:ro]"`
 * specs). These are the directories baked into the image, so their content must
 * feed the bake hash. Pure string parsing — no TOML dependency, no fs. Tolerates
 * a single- or multi-line array and both quote styles; returns the host portion
 * (everything before the first colon) of each entry, in declaration order.
 */
export function parseBakeVolumeHostPaths(smolfileText: string): string[] {
  const arrayMatch = /(?:^|\n)\s*volumes\s*=\s*\[([\s\S]*?)\]/.exec(smolfileText);
  if (!arrayMatch) return [];
  const entries = arrayMatch[1]!.match(/"[^"]*"|'[^']*'/g) ?? [];
  const hosts: string[] = [];
  for (const raw of entries) {
    const spec = raw.slice(1, -1); // strip quotes
    const host = spec.split(':')[0];
    if (host && host.length > 0) hosts.push(host);
  }
  return hosts;
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
