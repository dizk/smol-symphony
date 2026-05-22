// Reconciler stage 1 (issue 32). Owns the resource DAG that converges managed
// external resources toward their declared desired state.
//
// Stage 1 ships exactly one resource: the Smolfile-driven bake. The DAG walker,
// per-action ledger, and dispatch-gating predicate are written generically so
// later stages (VM lifecycle, workspace lifecycle, integration branch management
// — issues 33–36) can plug in by registering additional resources.
//
// Triggers (per issue 31 sketch):
//   • startup            — orchestrator calls reconcile() before the first dispatch.
//   • config-watcher     — orchestrator's onConfigReloaded calls reconcile().
//   • tracker-state      — left to a future stage (no tracker-driven resources in v1).
//   • backstop tick      — internal timer fires reconcile() every
//                          `backstopIntervalMs` so a missed signal can't park the
//                          reconciler forever.
//
// `reconcile --force` (CLI flag) propagates `{ force: true }` through to each
// resource so the bake can drop its cached artifact and rebuild.

import { BakeResource, SmolvmBakeExecutor, type BakeExecutor } from './bake.js';
import { defaultCacheRoot } from './cache.js';
import type { ReconcilerSnapshot } from './types.js';
import type { ServiceConfig, SmolvmConfig } from '../types.js';
import { log } from '../logging.js';

export interface ReconcilerOptions {
  // Root for `~/.cache/symphony` (overridable for tests).
  cacheRoot?: string;
  // Bake executor (overridable for tests). Defaults to the smolvm-CLI-driven impl.
  bakeExecutor?: BakeExecutor;
  // Backstop tick interval (ms). Default 5 minutes so a missed config-watcher
  // signal can't park the reconciler forever; tests override to a small value.
  backstopIntervalMs?: number;
}

export class Reconciler {
  private readonly cacheRoot: string;
  private readonly bakeExecutor: BakeExecutor;
  private readonly backstopIntervalMs: number;
  private bake: BakeResource;
  private backstopTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  // Single-flight: collapse concurrent reconcile() calls into one ongoing pass so
  // an event burst (config reload + backstop + manual trigger landing within ms
  // of each other) doesn't kick off three overlapping bakes for the same hash.
  private inFlight: Promise<void> | null = null;
  private rerunRequested = false;

  constructor(private cfg: ServiceConfig, opts: ReconcilerOptions = {}) {
    this.cacheRoot = opts.cacheRoot ?? defaultCacheRoot();
    this.bakeExecutor = opts.bakeExecutor ?? new SmolvmBakeExecutor();
    this.backstopIntervalMs = opts.backstopIntervalMs ?? 5 * 60_000;
    this.bake = new BakeResource({
      cacheRoot: this.cacheRoot,
      smolvm: cfg.smolvm,
      executor: this.bakeExecutor,
    });
  }

  // Re-bind the bake resource against the freshly-reloaded smolvm config. The
  // bake's in-flight task (if any) keeps running against the prior hash; the
  // next reconcile() pass will pick up the new desired hash.
  updateConfig(cfg: ServiceConfig): void {
    this.cfg = cfg;
    this.bake = new BakeResource({
      cacheRoot: this.cacheRoot,
      smolvm: cfg.smolvm,
      executor: this.bakeExecutor,
    });
    void this.reconcile().catch((err) =>
      log.warn('reconcile after config reload failed', { error: (err as Error).message }),
    );
  }

  start(): void {
    if (this.backstopTimer) return;
    this.backstopTimer = setInterval(() => {
      void this.reconcile().catch((err) =>
        log.debug('backstop reconcile failed', { error: (err as Error).message }),
      );
    }, this.backstopIntervalMs);
    this.backstopTimer.unref();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.backstopTimer) {
      clearInterval(this.backstopTimer);
      this.backstopTimer = null;
    }
    // Don't wait for an in-flight bake — operator-initiated shutdown is expected
    // to leave any partially-baked artifact behind (the lock file is the signal
    // for the next run to retry or skip). Surface awaitInFlight() as an explicit
    // call for tests that need deterministic completion.
  }

  async awaitInFlight(): Promise<void> {
    await this.bake.waitForInFlight();
  }

  // Trigger a reconcile pass. Idempotent across overlapping callers (single-flight);
  // if a pass is in progress when called, a re-run is scheduled to fire once it
  // completes so the latest config is always observed.
  async reconcile(opts: { force?: boolean } = {}): Promise<void> {
    if (this.stopped) return;
    if (this.inFlight) {
      this.rerunRequested = true;
      await this.inFlight;
      if (this.rerunRequested) {
        // The most recent call may have set force=true; we can't reliably merge
        // that flag with an in-flight pass, so a follow-up always runs as a
        // non-forced pass. A user who wants force semantics on a coalesced call
        // can simply re-invoke `symphony reconcile --force` once the in-flight
        // pass finishes.
        this.rerunRequested = false;
        await this.runPass({});
      }
      return;
    }
    await this.runPass(opts);
    while (this.rerunRequested && !this.stopped) {
      this.rerunRequested = false;
      await this.runPass({});
    }
  }

  private async runPass(opts: { force?: boolean }): Promise<void> {
    this.inFlight = (async () => {
      try {
        // The DAG is trivial in v1 — one node — so we just run reconcile on the
        // bake. As more resources land, walk in dependency order and propagate
        // ready-state through dependsOn.
        await this.bake.reconcile(opts);
      } catch (err) {
        log.warn('reconcile pass threw', { error: (err as Error).message });
      } finally {
        this.inFlight = null;
      }
    })();
    await this.inFlight;
  }

  // Public predicate the orchestrator's dispatch loop calls before claiming an issue.
  // True iff every resource the dispatch flow depends on is ready. In v1 this is just
  // the bake.
  dispatchReady(): boolean {
    return this.bake.ready();
  }

  // Path the runner passes to `smolvm machine create --from <path>` for the
  // currently ready bake. Null when no bake is ready (or no Smolfile is configured;
  // in that case the runner falls back to `smolvm.from`/`smolvm.image` from config).
  // Implements the runner's `BakedArtifactProvider` interface so the runner can
  // hold the Reconciler directly without wrapping it.
  artifactPath(): string | null {
    return this.bake.artifactPath();
  }

  bakedArtifactPath(): string | null {
    return this.bake.artifactPath();
  }

  // Convenience accessor for tests/CLI.
  smolvmConfig(): SmolvmConfig {
    return this.cfg.smolvm;
  }

  snapshot(): ReconcilerSnapshot {
    return { resources: [this.bake.snapshot()] };
  }
}

export type { BakeExecutor } from './bake.js';
export type { ReconcilerSnapshot, ResourceSnapshot, ActionStatus } from './types.js';
