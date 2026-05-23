// Content-hash cache for run_in_vm actions (issue 36 AC4).
//
// Cache layout:
//   <cacheRoot>/actions/run_in_vm/<sha256(workspace_tree ⊕ cmd ⊕ env)>/result.json
//
// `workspace_tree` is computed via `git ls-files | xargs sha1sum`-style:
// stable tree-of-tracked-files hash that ignores per-file mtimes. We use git
// because every action workspace is a clone (the workspace setup is
// orchestrator-owned, see src/workspace.ts) — so `git ls-tree --full-tree`
// against HEAD is always available and cheap. Untracked files are ignored
// for cache purposes; the alternative (hashing the whole directory) would
// trip every time `node_modules/` mtimed.

import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { actionCacheDir, defaultCacheRoot } from '../reconciler/cache.js';

export const RUN_IN_VM_CACHE_KIND = 'run_in_vm';

export interface RunInVmCacheKey {
  workspacePath: string;
  cmd: string[];
  env: Record<string, string>;
}

export interface RunInVmCachedResult {
  exit_code: number;
  stdout: string;
  stderr: string;
  finished_at: string;
}

/**
 * Hash the cache key. Order-stable over env keys so two callers with the
 * same env (but different key insertion order) hit the same cache entry.
 */
export async function computeCacheHash(key: RunInVmCacheKey): Promise<string> {
  const h = createHash('sha256');
  const tree = await workspaceTreeHash(key.workspacePath);
  h.update('tree:');
  h.update(tree);
  h.update('\0cmd:');
  for (const a of key.cmd) {
    h.update(a);
    h.update('\0');
  }
  h.update('env:');
  const keys = Object.keys(key.env).sort();
  for (const k of keys) {
    h.update(k);
    h.update('=');
    h.update(key.env[k] ?? '');
    h.update('\0');
  }
  return h.digest('hex');
}

/**
 * Stable hash of the workspace's tracked-files state. Returns `'no-git'`
 * when the workspace is not a git repo so the cache key still computes
 * (useful for tests with non-git workspaces); the no-git form keys every
 * unchanged (cmd, env) tuple to the same hash, so the cache still skips
 * re-execution when nothing about the call changed.
 */
async function workspaceTreeHash(workspacePath: string): Promise<string> {
  // Prefer `git rev-parse HEAD^{tree}` for a stable tree id; fall back to
  // `git ls-files -s` if HEAD doesn't exist yet (fresh repo with no
  // commits). Both forms ignore unstaged + untracked changes — a deliberate
  // tradeoff: the cache is keyed off committed state.
  const tree = await runGitCapture(['rev-parse', '--verify', '--quiet', 'HEAD^{tree}'], workspacePath);
  if (tree && tree.length > 0) return tree.trim();
  const ls = await runGitCapture(['ls-files', '-s'], workspacePath);
  if (ls === null) return 'no-git';
  return createHash('sha256').update(ls).digest('hex');
}

function runGitCapture(args: string[], cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn('git', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: process.env,
    });
    let out = '';
    child.stdout?.on('data', (b) => {
      out += b.toString('utf8');
    });
    child.on('error', () => resolve(null));
    child.on('close', (code) => resolve(code === 0 ? out : null));
  });
}

function cacheEntryDir(cacheRoot: string, hash: string): string {
  return path.join(actionCacheDir(cacheRoot, RUN_IN_VM_CACHE_KIND), hash);
}

export async function readCache(
  cacheRoot: string,
  hash: string,
): Promise<RunInVmCachedResult | null> {
  const dir = cacheEntryDir(cacheRoot, hash);
  try {
    const buf = await readFile(path.join(dir, 'result.json'), 'utf8');
    const parsed = JSON.parse(buf) as RunInVmCachedResult;
    if (typeof parsed.exit_code !== 'number') return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function writeCache(
  cacheRoot: string,
  hash: string,
  result: RunInVmCachedResult,
): Promise<void> {
  const dir = cacheEntryDir(cacheRoot, hash);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'result.json'), JSON.stringify(result), 'utf8');
}

/**
 * Drop the cache entry for a given hash. Used by
 * `symphony rerun --check=<name>`: the caller computes the hash from the
 * workflow's `run_in_vm` declaration and clears just that one entry rather
 * than blowing away the entire cache.
 */
export async function invalidateCache(cacheRoot: string, hash: string): Promise<void> {
  const dir = cacheEntryDir(cacheRoot, hash);
  try {
    await rm(dir, { recursive: true, force: true });
  } catch {
    // Best-effort.
  }
}

/** Default cache root mirrors the bake resource. */
export function runInVmCacheRoot(): string {
  return defaultCacheRoot();
}
