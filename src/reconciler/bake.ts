// Bake resource: converges `~/.cache/symphony/actions/bake/<sha256(Smolfile)>.smolmachine`
// from the Smolfile referenced by `smolvm.smolfile`.
//
// The bake takes minutes (apt + npm install in the guest); the orchestrator must not
// block dispatch waiting for it, so the reconciler runs the bake on a background task
// and gates dispatch via `bakeReady()`. Subsequent dispatches reuse the cached artifact
// via `smolvm machine create --from <cache_path>` instead of `--smolfile <path>`,
// skipping the per-start init pay.

import { readFile, stat, lstat, readlink, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { SmolvmConfig } from '../types.js';
import { log } from '../logging.js';
import {
  computeBakeHash,
  parseBakeVolumeHostPaths,
  selectGcVictims,
  type CachedArtifact,
} from './bake-plan.js';
import { createHash, type Hash } from 'node:crypto';
import { actionCacheDir, ensureCacheDir, tryAcquireLock, type FileLock } from './cache.js';
import { ResourceActionLedger } from './ledger.js';
import type { ResourceSnapshot } from './types.js';

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
//
// `smolvm pack create -o <X>` produces TWO files: a runnable stub at `<X>` and the
// actual SMOLPACK assets at `<X>.smolmachine`. `machine create --from` requires the
// SMOLPACK file, not the stub (which is just an ELF binary). So we strip the
// trailing `.smolmachine` from `output_path` before passing it as `-o`, then verify
// the SMOLPACK lands at `output_path`. The stub is unlinked — we don't use it.
export class SmolvmBakeExecutor implements BakeExecutor {
  async bake(input: BakeInput): Promise<void> {
    const vmName = `symphony-bake-${input.output_path.split(path.sep).pop()!.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 40)}`;
    const stubBase = input.output_path.endsWith('.smolmachine')
      ? input.output_path.slice(0, -'.smolmachine'.length)
      : input.output_path;
    // Resolve the Smolfile to an absolute path and run `machine create` with cwd
    // set to its directory, so smolvm resolves `[dev].volumes` relative entries
    // (e.g. `./scripts`, `../scripts`) against the Smolfile's location — the same
    // anchor the bake hash uses (readDesiredHash resolves them against
    // dirname(smolfile)). Without this, a process cwd != Smolfile dir would let
    // smolvm copy a different scripts/ tree than the one the cache key hashed,
    // baking a stale/wrong /opt/symphony with no runtime mount to correct it.
    const smolfileAbs = path.resolve(input.smolfile_path);
    const smolfileDir = path.dirname(smolfileAbs);
    try {
      await execFileAsync(
        'smolvm',
        [
          'machine',
          'create',
          vmName,
          '--smolfile',
          smolfileAbs,
          '--cpus',
          String(input.cpus),
          '--mem',
          String(input.mem_mib),
          '--net',
        ],
        { cwd: smolfileDir, timeout: BAKE_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 },
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
          stubBase,
          '--cpus',
          String(input.cpus),
          '--mem',
          String(input.mem_mib),
        ],
        { timeout: BAKE_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 },
      );
      // Verify the SMOLPACK assets file actually exists at the expected path. If
      // smolvm's output convention ever changes, fail loudly here rather than handing
      // the runner a stub that smolvm will reject with "invalid magic".
      try {
        await stat(input.output_path);
      } catch (err) {
        throw new Error(
          `bake produced no SMOLPACK at ${input.output_path}: ${(err as Error).message}`,
        );
      }
      // Drop the stub side-output (~25 MB ELF, unused by `machine create --from`).
      if (stubBase !== input.output_path) {
        try {
          await unlink(stubBase);
        } catch {
          // Best-effort: stub may not exist on a future smolvm that drops it.
        }
      }
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
    lastError: null,
    forcePending: false,
  };

  private readonly ledger = new ResourceActionLedger(this.id, { maxHistory: MAX_ACTION_HISTORY });

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
    const desiredHash = await this.readDesiredHash();
    if (!desiredHash) return;
    this.state.desiredHash = desiredHash;

    // Fold the sticky `forcePending` flag into the per-call force decision. This is
    // what closes the warm-cache race when force is called during an in-flight
    // non-force pass: `Reconciler.reconcile({ force: true })` synchronously calls
    // `markStale()` (sets forcePending=true), then awaits the in-flight pass. When
    // the in-flight pass's `bake.reconcile` resumes past its first await, it
    // observes forcePending=true here and runs force semantics (unlink + rebake)
    // instead of the cache-hit branch.
    const force = opts.force === true || this.state.forcePending;
    if (force) await this.invalidateCachedArtifact(desiredHash);

    // Cache hit? Update ready flag and we're done. (Unreachable under force in the
    // common case because we just unlinked; but a concurrent writer could land an
    // artifact between the unlink and the stat, in which case we accept it as fresh
    // and clear forcePending.)
    if (await this.cachedArtifactExists(desiredHash)) {
      await this.adoptCachedArtifact(desiredHash);
      return;
    }

    // Already baking the right hash? Don't kick off a duplicate. forcePending will
    // be cleared when that bake completes (any successful bake against the current
    // desiredHash is by definition "fresh" enough to satisfy the operator's force).
    if (this.state.inFlight && this.state.inFlightHash === desiredHash) return;

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

  // Read the Smolfile and hash it. On failure, record the error, drop
  // desired/ready (so a vanished Smolfile closes the dispatch gate even after
  // a successful prior bake), and return null so the caller short-circuits.
  private async readDesiredHash(): Promise<string | null> {
    try {
      const smolfilePath = this.opts.smolvm.smolfile!;
      const buf = await readFile(smolfilePath);
      // Absolute so the host-dir resolution below matches the bake, which runs
      // `machine create` with cwd = dirname(resolved Smolfile) (see bake()).
      const baseDir = path.dirname(path.resolve(smolfilePath));
      // Host dirs the Smolfile bakes into the image (e.g. scripts/) must
      // content-address into the hash, else editing a baked file silently reuses
      // a stale artifact.
      const bakedInputs = await Promise.all(
        parseBakeVolumeHostPaths(buf.toString('utf8')).map(async (p) => ({
          path: p,
          digest: await hashPathContent(path.resolve(baseDir, p)),
        })),
      );
      return computeBakeHash(buf, bakedInputs);
    } catch (err) {
      const msg = `read Smolfile failed: ${(err as Error).message}`;
      this.state.lastError = msg;
      this.state.desiredHash = null;
      this.state.readyHash = null;
      this.ledger.record('bake:read-smolfile', 'error', msg);
      log.warn('bake reconcile: smolfile read failed', {
        smolfile: this.opts.smolvm.smolfile,
        error: msg,
      });
      return null;
    }
  }

  private async invalidateCachedArtifact(hash: string): Promise<void> {
    try {
      await unlink(this.cachePath(hash));
    } catch {
      /* already absent */
    }
    this.state.readyHash = null;
  }

  private async adoptCachedArtifact(hash: string): Promise<void> {
    this.state.readyHash = hash;
    this.state.forcePending = false;
    // Best-effort GC every reconcile pass; cheap when the cache is small.
    await this.gcCache(hash).catch((err) =>
      log.debug('bake gc failed', { error: (err as Error).message }),
    );
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
      actions: this.ledger.snapshot(),
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
    const lock = await this.acquireBakeLock(hash, lockPath);
    if (!lock) return;

    this.ledger.start(`bake:${hash}`);
    this.state.inFlightHash = hash;
    log.info('reconciling bake', {
      hash,
      smolfile: this.opts.smolvm.smolfile,
      output: outputPath,
    });

    try {
      await this.bakeAndVerify(hash, outputPath);
    } catch (err) {
      const msg = (err as Error).message;
      this.recordFailure(hash, msg);
      log.warn('bake failed', { hash, error: msg });
    } finally {
      await lock.release();
    }
  }

  // Try to claim the bake lock for `hash`. Returns null when either acquire
  // failed (recorded as ledger error) or another symphony instance already
  // holds the lock (logged + ledger-started so the dashboard surfaces it).
  // Caller short-circuits on null.
  private async acquireBakeLock(hash: string, lockPath: string): Promise<FileLock | null> {
    let lock: FileLock | null;
    try {
      lock = await tryAcquireLock(lockPath);
    } catch (err) {
      this.recordFailure(hash, `lock acquire failed: ${(err as Error).message}`);
      return null;
    }
    if (!lock) {
      // Another symphony instance is baking this hash. We don't compete; the next
      // reconcile pass (config-change/tracker-change/backstop tick) will re-check
      // the cached artifact and pick up the winner's output. Record an in-progress
      // action so the dashboard shows "waiting on concurrent bake".
      log.info('bake: another instance holds the lock; waiting', { hash, lock_path: lockPath });
      this.ledger.start(`bake:${hash}`);
      this.state.inFlightHash = hash;
      return null;
    }
    return lock;
  }

  // Drive the executor, verify the artifact actually landed, and record success.
  // Throws on any step's failure so `runBake`'s catch handles it uniformly.
  private async bakeAndVerify(hash: string, outputPath: string): Promise<void> {
    await this.opts.executor.bake({
      smolfile_path: this.opts.smolvm.smolfile!,
      output_path: outputPath,
      cpus: this.opts.smolvm.cpus,
      mem_mib: this.opts.smolvm.mem_mib,
    });
    // Re-check the artifact actually landed. A buggy executor that returns without
    // writing would otherwise flip ready=true erroneously.
    if (!(await this.cachedArtifactExists(hash))) {
      throw new Error('bake completed but artifact is missing');
    }
    this.ledger.done(`bake:${hash}`);
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
  }

  private recordFailure(hash: string, error: string): void {
    this.state.lastError = error;
    this.ledger.error(`bake:${hash}`, error);
  }

  // Keep at most BAKE_CACHE_MAX_ENTRIES bake artifacts. The current ready hash is
  // always preserved; older artifacts are evicted by mtime ascending (LRU). Lock
  // files are ignored. The selection itself is pure (`selectGcVictims`); this
  // method just does the IO.
  private async gcCache(keepHash: string): Promise<void> {
    const dir = actionCacheDir(this.opts.cacheRoot, 'bake');
    const artifacts = await this.listCachedArtifacts(dir);
    const victims = selectGcVictims(
      artifacts,
      `${keepHash}.smolmachine`,
      BAKE_CACHE_MAX_ENTRIES,
    );
    for (const name of victims) {
      try {
        await unlink(path.join(dir, name));
      } catch {
        /* ignore */
      }
    }
  }

  private async listCachedArtifacts(dir: string): Promise<CachedArtifact[]> {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return [];
    }
    const out: CachedArtifact[] = [];
    for (const name of entries) {
      if (!name.endsWith('.smolmachine')) continue;
      try {
        const st = await stat(path.join(dir, name));
        if (!st.isFile()) continue;
        out.push({ name, mtime: st.mtimeMs });
      } catch {
        /* ignore */
      }
    }
    return out;
  }
}

/**
 * Deterministic content digest of a host path baked into the image. A file
 * hashes its bytes; a directory is walked in sorted order, folding each entry's
 * relative path + bytes into one sha256. A missing path folds a stable "absent"
 * marker (the bake itself surfaces the real error). Used by the bake hash so
 * editing a baked file (e.g. `scripts/vm-agent.mjs`) forces a re-bake. Folds in
 * file/dir modes and directory structure (not just file bytes) so metadata-only
 * changes `cp -a` preserves — `chmod +x`, an added empty dir — also invalidate
 * the cache. Exported for tests.
 *
 * The ROOT path is followed if it is a symlink (`stat`): smolvm resolves a
 * symlinked `[dev].volumes` host path when it mounts it, and `cp -a <root>/.`
 * copies the resolved target's contents — so the digest must reflect the target,
 * not the link text. NESTED entries are walked with `lstat` (see foldPathInto)
 * so an interior symlink is preserved as a link, exactly as `cp -a` preserves it.
 */
export async function hashPathContent(absPath: string): Promise<string> {
  const h = createHash('sha256');
  let st;
  try {
    st = await stat(absPath); // follow a symlinked root
  } catch {
    h.update('\0absent\0');
    return h.digest('hex');
  }
  if (st.isDirectory()) {
    h.update(`\0root-dir\0${st.mode.toString(8)}\0`);
    for (const name of (await readdir(absPath)).sort()) {
      await foldPathInto(h, path.join(absPath, name), name);
    }
  } else if (st.isFile()) {
    h.update(`\0root-file\0${st.mode.toString(8)}\0`);
    h.update(await readFile(absPath));
  }
  return h.digest('hex');
}

async function foldPathInto(h: Hash, absPath: string, rel: string): Promise<void> {
  let st;
  try {
    // lstat (not stat) so we do NOT follow symlinks — matching `cp -a`, which
    // preserves the link rather than its target. Following would let the cache
    // key depend on un-baked files and let a symlink cycle recurse forever.
    st = await lstat(absPath);
  } catch {
    h.update(`\0absent\0${rel}`);
    return;
  }
  if (st.isSymbolicLink()) {
    h.update(`\0symlink\0${rel}\0`);
    h.update(await readlink(absPath));
    return;
  }
  if (st.isDirectory()) {
    // Mark the dir itself (with its mode) so adding/removing an even-empty
    // directory, or a chmod on one, changes the digest — `cp -a` preserves both.
    h.update(`\0dir\0${rel}\0${st.mode.toString(8)}\0`);
    for (const name of (await readdir(absPath)).sort()) {
      await foldPathInto(h, path.join(absPath, name), rel ? `${rel}/${name}` : name);
    }
    return;
  }
  if (st.isFile()) {
    // Include the mode: `cp -a` preserves it, so a metadata-only change like
    // `chmod +x` alters the baked image even when the bytes are identical.
    h.update(`\0file\0${rel}\0${st.mode.toString(8)}\0`);
    h.update(await readFile(absPath));
  }
}

