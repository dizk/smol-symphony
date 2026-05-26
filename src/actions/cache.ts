// Content-hash cache for run_in_vm actions (issue 36 AC4).
//
// Adapter for the `RunInVmCacheStore` port declared in `./types.ts`. The
// pure executor in `./executor.ts` consumes the port; production wires
// `realRunInVmCacheStore` (this file's default export) into runActions.
// Classified as an adapter in `.dependency-cruiser.cjs` because everything
// below the port is fs/git IO (node:crypto, node:fs/promises, runProcess);
// the eslint shell-budget list mirrors `bake.ts` / `predicate-env.ts`.
//
// Cache layout:
//   <cacheRoot>/actions/run_in_vm/<name>/<sha256(workspace_tree ⊕ cmd ⊕ env)>/result.json
//
// The name is the first path segment so `symphony rerun --check=<name>` can
// drop an entire check's cache without recomputing the workspace-dependent
// hash (which the CLI doesn't know — it has no per-issue workspace). The
// per-execution path computes the hash against the actual per-issue
// workspace; the CLI just removes the namespace dir, and the next execution
// re-runs because no cached hash entry exists.
//
// `workspace_tree` hashes the live workspace contents the VM command will
// see: every file `git ls-files --cached --others --exclude-standard` would
// list (tracked, untracked-not-gitignored), read from the working tree (not
// from the index), so an uncommitted edit to a tracked file or a newly
// added untracked source file forces a cache miss. This is the whole point
// of `run_in_vm`: CI-style checks against the user's project as it exists
// in the per-issue workspace, post-agent-edits.

import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { actionCacheDir, defaultCacheRoot } from '../reconciler/cache.js';
import { runProcess } from '../util/process.js';
import type {
  RunInVmCacheKey,
  RunInVmCachedResult,
  RunInVmCacheStore,
} from './types.js';

export type { RunInVmCacheKey, RunInVmCachedResult, RunInVmCacheStore } from './types.js';

export const RUN_IN_VM_CACHE_KIND = 'run_in_vm';

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
 * Hash of the workspace's live, .gitignore-aware contents — what the VM
 * command will actually see. Uses `git ls-files --cached --others
 * --exclude-standard -z` to enumerate (cheap, handles .gitignore correctly),
 * then reads each file from the working tree (so uncommitted modifications
 * are captured). Tracked-but-deleted-in-worktree paths are folded in as a
 * deletion marker so removing a file still bumps the hash.
 *
 * Returns `'no-git'` when the workspace is not a git repo so the cache key
 * still computes; the cmd/env contribution still differentiates calls.
 */
async function workspaceTreeHash(workspacePath: string): Promise<string> {
  const lsZ = await runGitCapture(
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    workspacePath,
  );
  if (lsZ === null) return 'no-git';
  // -z output: NUL-separated paths, possibly with a trailing NUL. A path
  // can appear in both --cached and --others (a freshly added but git-add'd
  // file may show up in both lists depending on git's index state); dedupe
  // and sort so the hash is order-stable.
  const unique = Array.from(new Set(lsZ.split('\0').filter((p) => p.length > 0))).sort();
  const h = createHash('sha256');
  for (const rel of unique) {
    await mixFileIntoHash(h, workspacePath, rel);
  }
  return h.digest('hex');
}

// Read one workspace file and fold its contents (or a deletion/error marker)
// into the running hash. Split out so `workspaceTreeHash` stays under the
// shell-tier statement budget.
async function mixFileIntoHash(h: ReturnType<typeof createHash>, workspacePath: string, rel: string): Promise<void> {
  const abs = path.join(workspacePath, rel);
  let buf: Buffer;
  try {
    buf = await readFile(abs);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // ENOENT: tracked file deleted in worktree; record deletion so the cache
    // key differs from "file still present." EISDIR / other errors: record
    // as an error marker so we don't silently bucket two distinguishable
    // states together.
    h.update(code === 'ENOENT' ? 'D\0' : 'E\0');
    h.update(rel);
    h.update('\0');
    return;
  }
  h.update('F\0');
  h.update(rel);
  h.update('\0');
  h.update(buf.length.toString(10));
  h.update('\0');
  h.update(buf);
}

// Thin shape adapter: workspace-tree hashing wants `stdout | null` (null on
// any non-zero/error). The unified `runProcess` returns the full result; we
// throw away stderr (workspace-tree probes are quiet on the happy path) and
// project exit_code into the nullable signal. `maxBytes` is raised well above
// the unified default because `ls-files` output for a non-trivial workspace
// quickly exceeds 64 KiB; the cache hash MUST see the complete file list.
async function runGitCapture(args: string[], cwd: string): Promise<string | null> {
  const r = await runProcess('git', args, {
    cwd,
    maxBytes: 16 * 1024 * 1024,
    appendErrorToStderr: false,
  });
  return r.exit_code === 0 ? r.stdout : null;
}

/**
 * Sanitize an action name for use as a path segment. We validate at parse
 * time (see parseActionsBlock for run_in_vm) but defensively encode here so
 * a future relaxation of the parser rule can't silently make two names
 * collide on the filesystem.
 */
function sanitizeNameSegment(name: string): string {
  // Map every char outside [A-Za-z0-9._-] to `_<hex>`; the underscore prefix
  // guarantees the encoded form is unambiguous against a literal "_" because
  // a literal underscore would not be followed by two hex chars... actually
  // since `_` is in the safe set, `_AB` is a possible literal name. To keep
  // collision-freedom we use `%` as the escape sentinel (which is unsafe and
  // therefore always escaped if it appears literally).
  let out = '';
  for (const ch of name) {
    if (/[A-Za-z0-9._-]/.test(ch)) {
      out += ch;
    } else {
      out += '%' + ch.charCodeAt(0).toString(16).padStart(2, '0');
    }
  }
  return out.length > 0 ? out : '_';
}

function cacheNameDir(cacheRoot: string, name: string): string {
  return path.join(actionCacheDir(cacheRoot, RUN_IN_VM_CACHE_KIND), sanitizeNameSegment(name));
}

function cacheEntryDir(cacheRoot: string, name: string, hash: string): string {
  return path.join(cacheNameDir(cacheRoot, name), hash);
}

export async function readCache(
  cacheRoot: string,
  name: string,
  hash: string,
): Promise<RunInVmCachedResult | null> {
  const dir = cacheEntryDir(cacheRoot, name, hash);
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
  name: string,
  hash: string,
  result: RunInVmCachedResult,
): Promise<void> {
  const dir = cacheEntryDir(cacheRoot, name, hash);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'result.json'), JSON.stringify(result), 'utf8');
}

/**
 * Drop every cache entry for a named check. Used by `symphony rerun
 * --check=<name>`: the operator names the check, not the workspace, and the
 * orchestrator's next dispatch into the state hosting it re-executes
 * because the namespace directory is empty.
 *
 * Per-name (rather than per-hash) invalidation is the cache-layout fix for
 * the rerun CLI: the CLI has no per-issue workspace to hash against, so any
 * hash-based invalidation would key off the wrong workspace and miss the
 * entry the per-issue execution actually wrote. Dropping the namespace dir
 * sidesteps the problem entirely.
 */
export async function invalidateCacheByName(cacheRoot: string, name: string): Promise<void> {
  const dir = cacheNameDir(cacheRoot, name);
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

/**
 * Drop every cache entry for a named `run_in_vm` action. Used by
 * `symphony rerun --check=<name>`: the next dispatch into the state hosting
 * the check sees an empty cache namespace and re-executes, while every
 * other check's entries stay in place.
 *
 * No workspace argument: the cache is namespaced by action name on disk
 * (`<root>/actions/run_in_vm/<name>/<hash>/`), so invalidation is a
 * namespace-directory drop, not a hash lookup. This is the layout fix for
 * the rerun CLI — the CLI has no per-issue workspace to hash against, and
 * the per-execution hash is workspace-dependent, so any hash-keyed
 * invalidation would miss the entry the per-issue execution actually wrote.
 */
export async function invalidateRunInVmByName(
  action: { name: string },
  cacheRoot?: string,
): Promise<void> {
  await invalidateCacheByName(cacheRoot ?? runInVmCacheRoot(), action.name);
}

/**
 * Bind a `RunInVmCacheStore` to a specific on-disk cacheRoot. The runner
 * uses `runInVmCacheRoot()`; tests pin a tmp dir. The store hands the
 * executor the port shape (`hashKey`/`read`/`write`) while keeping cacheRoot
 * a construction-time detail of the adapter.
 */
export function makeRunInVmCacheStore(cacheRoot: string): RunInVmCacheStore {
  return {
    hashKey: computeCacheHash,
    read: (name, hash) => readCache(cacheRoot, name, hash),
    write: (name, hash, result) => writeCache(cacheRoot, name, hash, result),
  };
}

/**
 * Production implementation of the `RunInVmCacheStore` port. The runner
 * (application layer) passes this into `runActions` so the pure executor
 * never imports the IO half. Tests substitute their own via
 * `makeRunInVmCacheStore(<tmp>)`.
 */
export const realRunInVmCacheStore: RunInVmCacheStore = makeRunInVmCacheStore(runInVmCacheRoot());
