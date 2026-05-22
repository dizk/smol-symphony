// Bake resource: converges `~/.cache/symphony/actions/bake/<sha256(Smolfile)>.smolmachine`
// from the Smolfile referenced by `smolvm.smolfile`.
//
// The bake takes minutes (apt + npm install in the guest); the orchestrator must not
// block dispatch waiting for it, so the reconciler runs the bake on a background task
// and gates dispatch via `bakeReady()`. Subsequent dispatches reuse the cached artifact
// via `smolvm machine create --from <cache_path>` instead of `--smolfile <path>`,
// skipping the per-start init pay.

import { createHash } from 'node:crypto';
import { readFile, stat, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { SmolvmConfig } from '../types.js';
import { log } from '../logging.js';
import { actionCacheDir, ensureCacheDir, tryAcquireLock, type FileLock } from './cache.js';
import type { ActionStatus, ResourceSnapshot } from './types.js';

const execFileAsync = promisify(execFile);

// GC policy (issue note): keep the most recent N=5 bakes per Smolfile lineage. With a
// single Smolfile lineage in stage 1 this is just a global cap on the bake cache.
const BAKE_CACHE_MAX_ENTRIES = 5;
// Bake the artifact end-to-end (create VM, run init, pack, delete). The apt + npm
// install in the shipped Smolfile reliably exceeds the smolvm `machine start` 60s
// timeout — see commit 562f6d5's hotfix message — so this gives the build plenty of
// headroom.
const BAKE_TIMEOUT_MS = 30 * 60 * 1000;

export interface BakeInput {
  smolfile_path: string;
  output_path: string;
  cpus: number;
  mem_mib: number;
}

// The bake action is abstract so tests can stub it without invoking smolvm. The
// production implementation drives the smolvm CLI; the stub used in tests writes a
// fake artifact (or throws to simulate failure).
export interface BakeExecutor {
  bake(input: BakeInput): Promise<void>;
}

// Production bake executor. Mirrors the discontinued scripts/build-vm.sh flow but
// drives the Smolfile path: `machine create --smolfile` runs the Smolfile's
// [dev].init at start, `pack create --from-vm` snapshots the populated VM, and the
// temporary VM is deleted in a finally block so a partial bake doesn't leak.
export class SmolvmBakeExecutor implements BakeExecutor {
  async bake(input: BakeInput): Promise<void> {
    const vmName = `symphony-bake-${input.output_path.split(path.sep).pop()!.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 40)}`;
    try {
      await execFileAsync(
        'smolvm',
        [
          'machine',
          'create',
          vmName,
          '--smolfile',
          input.smolfile_path,
          '--cpus',
          String(input.cpus),
          '--mem',
          String(input.mem_mib),
          '--net',
        ],
        { timeout: BAKE_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 },
      );
      await execFileAsync('smolvm', ['machine', 'start', '--name', vmName], {
        timeout: BAKE_TIMEOUT_MS,
        maxBuffer: 32 * 1024 * 1024,
      });
      await execFileAsync('smolvm', ['machine', 'stop', '--name', vmName], {
        timeout: BAKE_TIMEOUT_MS,
        maxBuffer: 32 * 1024 * 1024,
      });
      await execFileAsync(
        'smolvm',
        [
          'pack',
          'create',
          '--from-vm',
          vmName,
          '-o',
          input.output_path,
          '--cpus',
          String(input.cpus),
          '--mem',
          String(input.mem_mib),
        ],
        { timeout: BAKE_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 },
      );
    } finally {
      try {
        await execFileAsync('smolvm', ['machine', 'delete', vmName, '-f'], {
          timeout: 30_000,
          maxBuffer: 32 * 1024 * 1024,
        });
      } catch (err) {
        log.warn('bake: temp VM delete failed', { vm: vmName, error: (err as Error).message });
      }
    }
  }
}

export interface BakeResourceOptions {
  cacheRoot: string;
  smolvm: SmolvmConfig;
  executor: BakeExecutor;
}

interface BakeState {
  desiredHash: string | null;
  readyHash: string | null;
  inFlight: Promise<void> | null;
  inFlightHash: string | null;
  // Bounded ledger (most-recent-first). Older entries are dropped to keep
  // Snapshot payloads small.
  actions: ActionStatus[];
  lastError: string | null;
  // Sticky "operator wants a fresh bake" flag. Set by `markStale()` (called from
  // `Reconciler.reconcile({ force: true })` synchronously, before any await can
  // yield to the event loop) and cleared only when a `runBake()` completes
  // successfully. While set, `ready()` returns false so dispatch stays gated, and
  // the next `reconcile()` pass treats itself as force regardless of how the
  // caller invoked it. This is what closes the warm-cache race: a force coming in
  // during an in-flight non-force pass cannot get "absorbed" into a no-op rerun,
  // because the in-flight pass either (a) observes forcePending and runs force
  // semantics itself, or (b) restores readyHash on cache hit while
  // forcePending=true still keeps the gate closed for the rerun.
  forcePending: boolean;
}

const MAX_ACTION_HISTORY = 8;

// The bake resource implements the (informal) Resource trait described in issue 31:
//
//   desired()  — sha256(Smolfile content)
//   actual()   — presence of <cache>/<hash>.smolmachine
//   diff()     — a single `bake` action when actual ≠ desired
//   apply()    — runs the executor, holding an exclusive on-disk lock so concurrent
//                symphony instances don't double-bake
//
// `dependsOn` is empty in stage 1; later resources (e.g. workspace lifecycle) will
// declare a dependency on `bake` so the DAG order falls out naturally.
export class BakeResource {
  readonly id = 'bake';
  readonly dependsOn: string[] = [];

  private state: BakeState = {
    desiredHash: null,
    readyHash: null,
    inFlight: null,
    inFlightHash: null,
    actions: [],
    lastError: null,
    forcePending: false,
  };

  constructor(private readonly opts: BakeResourceOptions) {}

  // Path the runner should pass to `smolvm machine create --from <path>` for the
  // currently ready bake. Null when no bake is ready (or no Smolfile is configured).
  artifactPath(): string | null {
    if (!this.state.readyHash) return null;
    return this.cachePath(this.state.readyHash);
  }

  ready(): boolean {
    if (!this.opts.smolvm.smolfile) return true; // no Smolfile → no bake needed
    if (this.state.forcePending) return false;
    return this.state.readyHash !== null && this.state.readyHash === this.state.desiredHash;
  }

  desiredHash(): string | null {
    return this.state.desiredHash;
  }

  // Synchronous gate-close used by `Reconciler.reconcile({ force: true })`. Sets
  // `forcePending` so `ready()` returns false until the next successful runBake
  // clears it, and drops `readyHash` so any concurrent dispatchReady check that
  // bypasses the forcePending guard (none today, but defensive) also sees the
  // stale artifact as not-ready.
  markStale(): void {
    this.state.forcePending = true;
    this.state.readyHash = null;
  }

  // Run one reconcile pass: re-read the Smolfile, refresh desired/actual, and start
  // a bake if needed. The bake runs on a background task — this method returns once
  // the *pass* completes (the in-flight bake stays scheduled and observable via
  // `snapshot()`).
  //
  // `force` invalidates the cache for the current hash (removes the cached artifact)
  // before re-evaluating. Used by `symphony reconcile --force`.
  async reconcile(opts: { force?: boolean } = {}): Promise<void> {
    if (!this.opts.smolvm.smolfile) {
      this.state.desiredHash = null;
      this.state.readyHash = null;
      this.state.forcePending = false;
      return;
    }
    let desiredHash: string;
    try {
      const buf = await readFile(this.opts.smolvm.smolfile);
      desiredHash = createHash('sha256').update(buf).digest('hex');
    } catch (err) {
      const msg = `read Smolfile failed: ${(err as Error).message}`;
      this.state.lastError = msg;
      // Clear desired/ready so a Smolfile that becomes unreadable after a
      // successful bake (deletion, permission change) drops the dispatch gate
      // instead of leaving stale `readyHash === desiredHash` from the prior
      // pass. Without this, `dispatchReady()` would stay true and the runner
      // would dispatch against the previous artifact even though the
      // prerequisite (a readable Smolfile) no longer converges.
      this.state.desiredHash = null;
      this.state.readyHash = null;
      const now = new Date().toISOString();
      this.pushAction({
        resource: this.id,
        action: 'bake:read-smolfile',
        state: 'error',
        started_at: now,
        finished_at: now,
        error: msg,
      });
      log.warn('bake reconcile: smolfile read failed', {
        smolfile: this.opts.smolvm.smolfile,
        error: msg,
      });
      return;
    }
    this.state.desiredHash = desiredHash;

    // Fold the sticky `forcePending` flag into the per-call force decision. This is
    // what closes the warm-cache race when force is called during an in-flight
    // non-force pass: `Reconciler.reconcile({ force: true })` synchronously calls
    // `markStale()` (sets forcePending=true), then awaits the in-flight pass. When
    // the in-flight pass's `bake.reconcile` resumes past its first await, it
    // observes forcePending=true here and runs force semantics (unlink + rebake)
    // instead of the cache-hit branch.
    const force = opts.force === true || this.state.forcePending;
    if (force) {
      try {
        await unlink(this.cachePath(desiredHash));
      } catch {
        /* already absent */
      }
      this.state.readyHash = null;
    }

    // Cache hit? Update ready flag and we're done. (Unreachable under force in the
    // common case because we just unlinked; but a concurrent writer could land an
    // artifact between the unlink and the stat, in which case we accept it as fresh
    // and clear forcePending.)
    const cached = await this.cachedArtifactExists(desiredHash);
    if (cached) {
      this.state.readyHash = desiredHash;
      if (this.state.forcePending) this.state.forcePending = false;
      // Best-effort GC every reconcile pass; cheap when the cache is small.
      await this.gcCache(desiredHash).catch((err) =>
        log.debug('bake gc failed', { error: (err as Error).message }),
      );
      return;
    }

    // Already baking the right hash? Don't kick off a duplicate. forcePending will
    // be cleared when that bake completes (any successful bake against the current
    // desiredHash is by definition "fresh" enough to satisfy the operator's force).
    if (this.state.inFlight && this.state.inFlightHash === desiredHash) {
      return;
    }

    // Synchronously claim this hash BEFORE awaiting runBake's first await. Without
    // this, two reconcile() calls landing in the same microtask window would both
    // see `inFlightHash === null` (runBake hadn't set it yet) and both start a
    // duplicate runBake — the second one's inFlight assignment would clobber the
    // first's and awaitInFlight would return early, missing the real bake.
    this.state.inFlightHash = desiredHash;
    // Kick off the bake on a background task. The pass returns immediately; the
    // orchestrator's dispatch loop sees `ready() === false` until the bake completes.
    this.state.inFlight = this.runBake(desiredHash).finally(() => {
      this.state.inFlight = null;
      this.state.inFlightHash = null;
    });
  }

  async waitForInFlight(): Promise<void> {
    while (this.state.inFlight) {
      await this.state.inFlight;
    }
  }

  snapshot(): ResourceSnapshot {
    return {
      id: this.id,
      ready: this.ready(),
      desired_hash: this.state.desiredHash,
      last_error: this.state.lastError,
      actions: this.state.actions.slice(0, MAX_ACTION_HISTORY),
    };
  }

  private cachePath(hash: string): string {
    return path.join(actionCacheDir(this.opts.cacheRoot, 'bake'), `${hash}.smolmachine`);
  }

  private async cachedArtifactExists(hash: string): Promise<boolean> {
    try {
      const st = await stat(this.cachePath(hash));
      return st.isFile() && st.size > 0;
    } catch {
      return false;
    }
  }

  private async runBake(hash: string): Promise<void> {
    const outputPath = this.cachePath(hash);
    const lockPath = `${outputPath}.lock`;
    await ensureCacheDir(actionCacheDir(this.opts.cacheRoot, 'bake'));

    let lock: FileLock | null;
    try {
      lock = await tryAcquireLock(lockPath);
    } catch (err) {
      this.recordFailure(hash, `lock acquire failed: ${(err as Error).message}`);
      return;
    }
    if (!lock) {
      // Another symphony instance is baking this hash. We don't compete; the next
      // reconcile pass (config-change/tracker-change/backstop tick) will re-check
      // the cached artifact and pick up the winner's output. Record an in-progress
      // action so the dashboard shows "waiting on concurrent bake".
      log.info('bake: another instance holds the lock; waiting', { hash, lock_path: lockPath });
      this.pushAction({
        resource: this.id,
        action: `bake:${hash}`,
        state: 'in_progress',
        started_at: new Date().toISOString(),
        finished_at: null,
        error: null,
      });
      this.state.inFlightHash = hash;
      return;
    }

    const startedAt = new Date().toISOString();
    this.pushAction({
      resource: this.id,
      action: `bake:${hash}`,
      state: 'in_progress',
      started_at: startedAt,
      finished_at: null,
      error: null,
    });
    this.state.inFlightHash = hash;
    log.info('reconciling bake', {
      hash,
      smolfile: this.opts.smolvm.smolfile,
      output: outputPath,
    });

    try {
      await this.opts.executor.bake({
        smolfile_path: this.opts.smolvm.smolfile!,
        output_path: outputPath,
        cpus: this.opts.smolvm.cpus,
        mem_mib: this.opts.smolvm.mem_mib,
      });
      // Re-check the artifact actually landed. A buggy executor that returns without
      // writing would otherwise flip ready=true erroneously.
      const ok = await this.cachedArtifactExists(hash);
      if (!ok) {
        throw new Error('bake completed but artifact is missing');
      }
      this.markActionDone(hash);
      this.state.readyHash = hash;
      this.state.lastError = null;
      // Any successful bake against the current desiredHash satisfies a pending
      // force request: a fresh artifact exists on disk. Clear forcePending so
      // ready() flips true and dispatch can proceed.
      this.state.forcePending = false;
      log.info('bake ready', { hash, output: outputPath });
      await this.gcCache(hash).catch((err) =>
        log.debug('bake gc failed', { error: (err as Error).message }),
      );
    } catch (err) {
      const msg = (err as Error).message;
      this.recordFailure(hash, msg);
      log.warn('bake failed', { hash, error: msg });
    } finally {
      await lock.release();
    }
  }

  private recordFailure(hash: string, error: string): void {
    this.state.lastError = error;
    this.markActionError(hash, error);
  }

  private pushAction(status: ActionStatus): void {
    this.state.actions.unshift(status);
    if (this.state.actions.length > MAX_ACTION_HISTORY * 2) {
      this.state.actions.length = MAX_ACTION_HISTORY * 2;
    }
  }

  private markActionDone(hash: string): void {
    const key = `bake:${hash}`;
    const idx = this.state.actions.findIndex((a) => a.action === key && a.state === 'in_progress');
    if (idx >= 0) {
      this.state.actions[idx] = {
        ...this.state.actions[idx]!,
        state: 'done',
        finished_at: new Date().toISOString(),
      };
    }
  }

  private markActionError(hash: string, error: string): void {
    const key = `bake:${hash}`;
    const idx = this.state.actions.findIndex((a) => a.action === key && a.state === 'in_progress');
    const finished = new Date().toISOString();
    if (idx >= 0) {
      this.state.actions[idx] = {
        ...this.state.actions[idx]!,
        state: 'error',
        finished_at: finished,
        error,
      };
    } else {
      this.pushAction({
        resource: this.id,
        action: key,
        state: 'error',
        started_at: finished,
        finished_at: finished,
        error,
      });
    }
  }

  // Keep at most BAKE_CACHE_MAX_ENTRIES bake artifacts. The current ready hash is
  // always preserved; older artifacts are evicted by mtime ascending (LRU). Lock
  // files are ignored.
  private async gcCache(keepHash: string): Promise<void> {
    const dir = actionCacheDir(this.opts.cacheRoot, 'bake');
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }
    const artifacts: Array<{ name: string; mtime: number }> = [];
    for (const name of entries) {
      if (!name.endsWith('.smolmachine')) continue;
      const full = path.join(dir, name);
      try {
        const st = await stat(full);
        if (!st.isFile()) continue;
        artifacts.push({ name, mtime: st.mtimeMs });
      } catch {
        /* ignore */
      }
    }
    if (artifacts.length <= BAKE_CACHE_MAX_ENTRIES) return;
    artifacts.sort((a, b) => b.mtime - a.mtime);
    const keep = new Set<string>([`${keepHash}.smolmachine`]);
    for (const a of artifacts.slice(0, BAKE_CACHE_MAX_ENTRIES)) keep.add(a.name);
    for (const a of artifacts) {
      if (keep.has(a.name)) continue;
      try {
        await unlink(path.join(dir, a.name));
      } catch {
        /* ignore */
      }
    }
  }
}

