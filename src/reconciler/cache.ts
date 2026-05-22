// Action-cache helpers. Stage 1 ships a single cache kind (`bake`); future stages
// (issue 36's `run_in_vm` cache) plug in alongside via the same layout:
//
//   <root>/actions/<kind>/<input-hash>[.suffix]
//   <root>/actions/<kind>/<input-hash>.lock
//
// `defaultCacheRoot()` is `$XDG_CACHE_HOME/symphony` when set, else `~/.cache/symphony`.

import { mkdir, open, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export function defaultCacheRoot(): string {
  const xdg = process.env.XDG_CACHE_HOME;
  if (xdg && xdg.length > 0) return path.join(xdg, 'symphony');
  return path.join(os.homedir(), '.cache', 'symphony');
}

export function actionCacheDir(root: string, kind: string): string {
  return path.join(root, 'actions', kind);
}

export async function ensureCacheDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

export interface FileLock {
  release(): Promise<void>;
}

// Try to acquire an exclusive on-disk lock at `lockPath`. Returns null if the lock
// is already held (another symphony instance is mid-bake). Idempotent release: a
// double-release is a no-op.
//
// On-disk locks are intentional here, not a flock(2) advisory lock — the lock must
// survive across processes (`symphony reconcile --force` in another shell, a parallel
// symphony instance) AND coordinate them. A stale lockfile after a crash is the
// failure mode operators trade for; the reconciler's backstop tick will retry, and
// the operator can `rm` the lockfile if a previous crash left one behind.
export async function tryAcquireLock(lockPath: string): Promise<FileLock | null> {
  await mkdir(path.dirname(lockPath), { recursive: true });
  let fh;
  try {
    fh = await open(lockPath, 'wx');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') return null;
    throw err;
  }
  try {
    await fh.writeFile(`${process.pid}\n`);
  } finally {
    await fh.close();
  }
  let released = false;
  return {
    release: async () => {
      if (released) return;
      released = true;
      try {
        await unlink(lockPath);
      } catch {
        // Best-effort: the lock file may already be gone (concurrent cleanup).
      }
    },
  };
}
