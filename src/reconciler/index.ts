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

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { BakeResource, SmolvmBakeExecutor, type BakeExecutor } from './bake.js';
import { defaultCacheRoot } from './cache.js';
import type { ReconcilerSnapshot } from './types.js';
import { VmResource, type BootWorker, type IntendedVmProvider } from './vm.js';
import {
  WorkspaceResource,
  type BaseRefProvider,
  type WorkspaceIntendedProvider,
  type WorkspaceResourceOptions,
} from './workspace.js';
import {
  defaultInspectWorkspace,
  defaultListWorkspaceDirs,
  defaultRemoveWorkspace,
} from './workspace-defaults.js';
import {
  PrResource,
  type PrApi,
  type PrCleanupApi,
  type PrGitApi,
  type PrIntendedProvider,
  type PrTransitionApi,
  type PrWorkspaceEnsureApi,
} from './pr.js';
import { GhCliPrApi, GitCliPrGitApi } from './pr-adapters.js';
import type { ServiceConfig, SmolvmConfig } from '../types.js';
import type { SmolvmClient } from '../agent/smolvm-port.js';
import { log } from '../logging.js';

export interface ReconcilerOptions {
  // Root for `~/.cache/symphony` (overridable for tests).
  cacheRoot?: string;
  // Bake executor (overridable for tests). Defaults to the smolvm-CLI-driven impl.
  bakeExecutor?: BakeExecutor;
  // Backstop tick interval (ms). Default 5 minutes so a missed config-watcher
  // signal can't park the reconciler forever; tests override to a small value.
  backstopIntervalMs?: number;
  // VM reaper inputs (issue 33). Optional so test harnesses that don't exercise
  // VM lifecycle can omit them; when either `smolvm` or an intended provider is
  // missing, the vm resource is not constructed and `reapVms()` is a no-op.
  smolvm?: SmolvmClient;
  vmIntendedProvider?: IntendedVmProvider;
  // VmResource test hooks (mirror the same names on VmResourceOptions).
  listBootWorkers?: () => Promise<BootWorker[]>;
  killProcess?: (pid: number, signal: NodeJS.Signals | 0) => void;
  killGraceMs?: number;
  // Workspace resource inputs (issue 34). Optional so test harnesses that
  // don't exercise workspace reconciliation can omit them; when
  // `workspaceIntendedProvider` is missing the workspace resource is not
  // constructed and the reconciler's reconcile() pass skips it. Production
  // wiring passes both at construction or later via `setWorkspaceProviders`.
  workspaceIntendedProvider?: WorkspaceIntendedProvider;
  workspaceBaseRef?: BaseRefProvider;
  workspaceInspect?: WorkspaceResourceOptions['inspect'];
  workspaceRemove?: WorkspaceResourceOptions['remove'];
  workspaceCreate?: WorkspaceResourceOptions['create'];
  // PR autopilot resource (issue 38). When `pr_autopilot.enabled` is false the
  // resource is not constructed and `reconcile()` skips the pass. Wired via
  // `setPrAutopilotProviders` after construction so the orchestrator (which
  // implements every callback) can be built after the Reconciler.
  prIntendedProvider?: PrIntendedProvider;
  prApi?: PrApi;
  prGit?: PrGitApi;
  prTransition?: PrTransitionApi;
  prCleanup?: PrCleanupApi;
  prWorkspaceEnsure?: PrWorkspaceEnsureApi;
}

export class Reconciler {
  private readonly cacheRoot: string;
  private readonly bakeExecutor: BakeExecutor;
  private readonly backstopIntervalMs: number;
  private bake: BakeResource;
  // VM reaper. Built at construction when smolvm + intended provider are
  // already wired; otherwise lazily constructed via setIntendedVmProvider
  // (the production path — bin/symphony.ts builds the Reconciler before the
  // Orchestrator, then plugs the Orchestrator in as the intended-VM source).
  private vm: VmResource | null = null;
  private smolvm: SmolvmClient | null = null;
  private vmListBootWorkers?: () => Promise<BootWorker[]>;
  private vmKillProcess?: (pid: number, signal: NodeJS.Signals | 0) => void;
  private vmKillGraceMs?: number;
  // Workspace janitor (issue 34). Constructed when an intended-set provider is
  // wired; without one there's no desired set to compare against, so the
  // resource is null and the reconcile pass skips it.
  private workspace: WorkspaceResource | null = null;
  private workspaceInspect?: WorkspaceResourceOptions['inspect'];
  private workspaceRemove?: WorkspaceResourceOptions['remove'];
  private workspaceCreate?: WorkspaceResourceOptions['create'];
  private workspaceBaseRef?: BaseRefProvider;
  private workspaceIntended: WorkspaceIntendedProvider | null = null;
  // PR autopilot (issue 38). Built only when `pr_autopilot.enabled` and
  // providers have been wired. Null otherwise; reconcile() skips the pass.
  private pr: PrResource | null = null;
  private prIntended: PrIntendedProvider | null = null;
  private prApi: PrApi | null = null;
  private prGit: PrGitApi | null = null;
  private prTransition: PrTransitionApi | null = null;
  private prCleanup: PrCleanupApi | null = null;
  private prWorkspaceEnsure: PrWorkspaceEnsureApi | null = null;
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
    this.initVm(opts);
    this.initWorkspace(opts);
    this.initPrProviders(opts);
    this.pr = this.buildPrResource();
  }

  private initVm(opts: ReconcilerOptions): void {
    this.smolvm = opts.smolvm ?? null;
    this.vmListBootWorkers = opts.listBootWorkers;
    this.vmKillProcess = opts.killProcess;
    this.vmKillGraceMs = opts.killGraceMs;
    if (this.smolvm && opts.vmIntendedProvider) {
      this.vm = new VmResource({
        smolvm: this.smolvm,
        intended: opts.vmIntendedProvider,
        listBootWorkers: this.vmListBootWorkers ?? defaultListBootWorkers,
        killProcess: this.vmKillProcess ?? defaultKillProcess,
        killGraceMs: this.vmKillGraceMs,
      });
    }
  }

  private initWorkspace(opts: ReconcilerOptions): void {
    this.workspaceInspect = opts.workspaceInspect;
    this.workspaceRemove = opts.workspaceRemove;
    this.workspaceCreate = opts.workspaceCreate;
    this.workspaceBaseRef = opts.workspaceBaseRef;
    if (opts.workspaceIntendedProvider) {
      this.workspaceIntended = opts.workspaceIntendedProvider;
      this.workspace = this.buildWorkspaceResource();
    }
  }

  private initPrProviders(opts: ReconcilerOptions): void {
    if (opts.prIntendedProvider) this.prIntended = opts.prIntendedProvider;
    if (opts.prApi) this.prApi = opts.prApi;
    if (opts.prGit) this.prGit = opts.prGit;
    if (opts.prTransition) this.prTransition = opts.prTransition;
    if (opts.prCleanup) this.prCleanup = opts.prCleanup;
    if (opts.prWorkspaceEnsure) this.prWorkspaceEnsure = opts.prWorkspaceEnsure;
  }

  /**
   * Construct (or rebuild) the PR autopilot resource against the current
   * config + wired providers. Returns null when `pr_autopilot.enabled` is
   * false OR any required provider is missing — the latter happens on the
   * production path during the brief window between Reconciler construction
   * and the orchestrator wiring its callbacks via {@link setPrAutopilotProviders}.
   */
  private buildPrResource(): PrResource | null {
    if (!this.cfg.pr_autopilot.enabled) return null;
    if (
      !this.prIntended ||
      !this.prApi ||
      !this.prGit ||
      !this.prTransition ||
      !this.prCleanup
    ) {
      return null;
    }
    const conflictRouteTo =
      this.cfg.pr_autopilot.conflict_route_to ?? defaultConflictRouteTo(this.cfg);
    return new PrResource({
      intended: this.prIntended,
      pr: this.prApi,
      git: this.prGit,
      transition: this.prTransition,
      cleanup: this.prCleanup,
      workspaceEnsure: this.prWorkspaceEnsure ?? undefined,
      strategy: this.cfg.pr_autopilot.auto_merge_strategy,
      maxRebaseAttempts: this.cfg.pr_autopilot.max_rebase_attempts,
      conflictRouteTo,
      conflictHoldingState:
        this.cfg.pr_autopilot.conflict_holding_state ?? defaultConflictHolding(this.cfg),
      pollIntervalMs: this.cfg.pr_autopilot.poll_interval_ms,
      actor: 'pr-autopilot',
    });
  }

  private buildWorkspaceResource(): WorkspaceResource | null {
    if (!this.workspaceIntended) return null;
    const root = this.cfg.workspace.root;
    return new WorkspaceResource({
      intended: this.workspaceIntended,
      baseRef: this.workspaceBaseRef,
      listWorkspaces: () => defaultListWorkspaceDirs(root),
      inspect: this.workspaceInspect ?? defaultInspectWorkspace,
      remove: this.workspaceRemove ?? ((identifier) => defaultRemoveWorkspace(root, identifier)),
      create: this.workspaceCreate,
    });
  }

  /**
   * Wire the VM resource against an intended-VM source after construction.
   * The orchestrator is the intended-VM provider in production (it owns the
   * `running` map) but is constructed AFTER the Reconciler because the runner
   * needs the Reconciler at construction time. Calling this is idempotent —
   * the resource is replaced wholesale.
   *
   * No-op when no SmolvmClient was wired at Reconciler construction; without
   * one, the reaper has nothing to enumerate the daemon side of the actual
   * set with.
   */
  setIntendedVmProvider(provider: IntendedVmProvider): void {
    if (!this.smolvm) return;
    this.vm = new VmResource({
      smolvm: this.smolvm,
      intended: provider,
      listBootWorkers: this.vmListBootWorkers ?? defaultListBootWorkers,
      killProcess: this.vmKillProcess ?? defaultKillProcess,
      killGraceMs: this.vmKillGraceMs,
    });
  }

  /**
   * Wire the PR autopilot resource after construction. Same ordering reason
   * as the VM and workspace janitors: the orchestrator implements every
   * provider but is built after the Reconciler. Idempotent — the resource
   * is rebuilt against the latest providers on each call.
   *
   * Calling this with `pr_autopilot.enabled` false in the live config is a
   * no-op (the resource stays null).
   */
  setPrAutopilotProviders(opts: {
    intended: PrIntendedProvider;
    pr: PrApi;
    git: PrGitApi;
    transition: PrTransitionApi;
    cleanup: PrCleanupApi;
    workspaceEnsure?: PrWorkspaceEnsureApi;
  }): void {
    this.prIntended = opts.intended;
    this.prApi = opts.pr;
    this.prGit = opts.git;
    this.prTransition = opts.transition;
    this.prCleanup = opts.cleanup;
    if (opts.workspaceEnsure !== undefined) this.prWorkspaceEnsure = opts.workspaceEnsure;
    this.pr = this.buildPrResource();
  }

  /**
   * Wire the workspace janitor after construction. Same construction-ordering
   * reason as `setIntendedVmProvider`: the orchestrator is the intended
   * provider in production but is built after the Reconciler. Idempotent —
   * the resource is replaced wholesale on each call.
   */
  setWorkspaceProviders(
    intended: WorkspaceIntendedProvider,
    opts: {
      baseRef?: BaseRefProvider;
      /**
       * Override the remove callback used by the workspace reaper. Production
       * passes a closure over `WorkspaceManager.remove` so the configured
       * `before_remove` hook fires on janitor removals; tests omit it to use
       * the default `rm -rf`.
       */
      remove?: WorkspaceResourceOptions['remove'];
      /**
       * Override the create callback. Production passes a closure over
       * `WorkspaceManager.ensureFor` so the same canonical clone+branch+remote
       * setup (and after_create hook) that dispatch uses also fires for
       * reconciler-driven eager creation. Omitted ⇒ the reconciler only
       * reaps; useful for tests that don't exercise creation.
       */
      create?: WorkspaceResourceOptions['create'];
    } = {},
  ): void {
    this.workspaceIntended = intended;
    if (opts.baseRef !== undefined) this.workspaceBaseRef = opts.baseRef;
    if (opts.remove !== undefined) this.workspaceRemove = opts.remove;
    if (opts.create !== undefined) this.workspaceCreate = opts.create;
    this.workspace = this.buildWorkspaceResource();
  }

  /**
   * Run the workspace reaper outside the normal reconcile() walk. Used by the
   * orchestrator at startup to take over from the deleted `startupTerminalCleanup`
   * sweep: a single awaited pass before the first dispatch tick removes
   * leftover dirs from a prior run so a brand-new dispatch doesn't reuse
   * stale state. No-op when the resource isn't wired.
   */
  async reapWorkspaces(): Promise<void> {
    if (!this.workspace) return;
    try {
      await this.workspace.reconcile();
    } catch (err) {
      log.warn('workspace reap pass threw', { error: (err as Error).message });
    }
  }

  /**
   * Run the VM reaper outside the normal reconcile() walk. Used by the
   * orchestrator at:
   *   • startup (after `start()` — initial sweep of leftover symphony-* VMs).
   *   • shutdown (`stop()` clears `running` first so desired = ∅).
   *   • non-clean worker exit (the per-attempt destroy may not have fired).
   *
   * Decoupled from `reconcile()` so VM reaping doesn't have to wait on a
   * mid-flight bake (and so a bake error doesn't suppress reaping). Returns
   * immediately when the vm resource isn't wired.
   */
  async reapVms(): Promise<void> {
    if (!this.vm) return;
    try {
      await this.vm.reconcile();
    } catch (err) {
      log.warn('vm reap pass threw', { error: (err as Error).message });
    }
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
    // Workspace janitor reads `workspace.root` at construction; rebind so a
    // workflow reload that moved the workspace root takes effect on the next
    // pass. Preserves the held intended/integration providers — they're
    // referenced indirectly via the orchestrator's identity, which doesn't
    // change on reload.
    if (this.workspace) {
      this.workspace = this.buildWorkspaceResource();
    }
    // PR autopilot reads strategy / max_rebase_attempts / route-state fields
    // from cfg at construction. Rebuild so a reload that flips `enabled` or
    // changes any field takes effect on the next pass.
    this.pr = this.buildPrResource();
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
  //
  // Force semantics: when called with `{ force: true }`, the bake's sticky
  // `forcePending` flag is set synchronously via `markStale()` BEFORE any await
  // can yield to the event loop. That closes the dispatch gate immediately
  // (`bake.ready()` returns false while forcePending is true) and propagates the
  // "I want a fresh artifact" intent into both the in-flight pass and any
  // subsequent rerun via the merge inside `BakeResource.reconcile()`. The flag
  // is cleared only when a successful `runBake()` lands a fresh artifact, so
  // there is no path where a coalesced force call gets absorbed into a non-force
  // rerun and silently drops the rebuild.
  async reconcile(opts: { force?: boolean } = {}): Promise<void> {
    if (this.stopped) return;
    if (opts.force === true) {
      // Synchronous. Must run before the first await of this function so that any
      // dispatch tick or in-flight pass observing the bake's state from this same
      // microtask sees the gate closed and forcePending set.
      this.bake.markStale();
    }
    if (this.inFlight) {
      this.rerunRequested = true;
      await this.inFlight;
      if (this.rerunRequested) {
        this.rerunRequested = false;
        // The rerun does not need to re-pass force=true: the in-flight pass
        // either (a) observed forcePending via the bake's internal merge and
        // already ran force semantics, or (b) restored readyHash on a cache hit
        // — in which case forcePending is still set, and this rerun's
        // `bake.reconcile()` will pick it up and run a force pass itself.
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
        // DAG order: bake first (it's the dispatch-gating prereq), then vm
        // and workspace (independent janitors). Each resource is idempotent /
        // cheap when there's no work to do — bake short-circuits on cache
        // hit, vm/workspace passes return immediately when desired == actual.
        await this.bake.reconcile(opts);
        if (this.vm) {
          try {
            await this.vm.reconcile();
          } catch (err) {
            log.warn('vm reconcile pass threw', { error: (err as Error).message });
          }
        }
        if (this.workspace) {
          try {
            await this.workspace.reconcile();
          } catch (err) {
            log.warn('workspace reconcile pass threw', { error: (err as Error).message });
          }
        }
        if (this.pr) {
          try {
            await this.pr.reconcile();
          } catch (err) {
            log.warn('pr reconcile pass threw', { error: (err as Error).message });
          }
        }
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
    const resources = [this.bake.snapshot()];
    if (this.vm) resources.push(this.vm.snapshot());
    if (this.workspace) resources.push(this.workspace.snapshot());
    if (this.pr) resources.push(this.pr.snapshot());
    return { resources };
  }
}

/**
 * First declared active state, used as the default `conflict_route_to` when
 * the workflow doesn't pin one. Mirrors symphony's convention of routing
 * conflict-handling work to "Todo" without hardcoding the name.
 */
function defaultConflictRouteTo(cfg: ServiceConfig): string {
  for (const [name, sc] of Object.entries(cfg.states)) {
    if (sc.role === 'active') return name;
  }
  // Validation already rejects workflows with no active state, but keep a
  // sentinel just in case so the PrResource can construct without throwing.
  return 'Todo';
}

/**
 * Default holding state for circuit-broken issues. Prefers a declared state
 * literally named `Conflict` (case-insensitive); otherwise falls back to the
 * first declared holding state. Returns null when no holding state exists,
 * which only happens on a workflow that bypassed validation.
 */
function defaultConflictHolding(cfg: ServiceConfig): string | null {
  let firstHolding: string | null = null;
  for (const [name, sc] of Object.entries(cfg.states)) {
    if (sc.role !== 'holding') continue;
    if (firstHolding === null) firstHolding = name;
    if (name.toLowerCase() === 'conflict') return name;
  }
  return firstHolding;
}

/**
 * Resolve a `_boot-vm` worker's VM name from its on-disk identity. The
 * argv-referenced `boot-config.json` lives under
 * `~/.cache/smolvm/vms/<hash>/boot-config.json`, but smolvm consumes and
 * deletes that file shortly after the VM boots — so for a running VM it isn't
 * present on disk. The persistent sibling file `<dir>/name` holds the
 * daemon-registered VM name as plain text and survives the VM's lifetime.
 *
 * Prefer `<dir>/name`. Fall back to parsing `boot-config.json` for robustness
 * across smolvm versions and for the narrow pre-consume window. Returns null
 * if neither yields a non-empty string — the reaper only acts on
 * confidently-identified strays.
 *
 * Lives here (shell) rather than vm.ts (core) so the fs imports don't violate
 * the functional-core purity rule.
 */
export async function resolveBootWorkerVmName(configPath: string): Promise<string | null> {
  const dir = path.dirname(configPath);
  const fromName = await readNameFile(dir);
  if (fromName !== null) return fromName;
  return readBootConfigName(configPath);
}

async function readNameFile(dir: string): Promise<string | null> {
  try {
    const raw = await readFile(path.join(dir, 'name'), 'utf8');
    const name = raw.trim();
    return name.length > 0 ? name : null;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      log.debug('vm reaper: name file read failed', { dir, error: (err as Error).message });
    }
    return null;
  }
}

async function readBootConfigName(configPath: string): Promise<string | null> {
  let body: string;
  try {
    body = await readFile(configPath, 'utf8');
  } catch {
    log.debug('vm reaper: boot-config read failed', { configPath });
    return null;
  }
  let parsed: { name?: unknown };
  try {
    parsed = JSON.parse(body) as { name?: unknown };
  } catch {
    log.debug('vm reaper: boot-config malformed', { configPath });
    return null;
  }
  const name = parsed.name;
  if (typeof name !== 'string' || name.length === 0) return null;
  return name;
}

/**
 * Enumerate every `_boot-vm` host worker and map it to its symphony VM name
 * via the persistent `<vmdir>/name` file (with a `boot-config.json` fallback).
 * Linux-only (reads /proc). Workers whose name can't be resolved are dropped
 * silently — the reaper only acts on confidently-identified strays.
 */
export async function defaultListBootWorkers(): Promise<BootWorker[]> {
  const procDir = '/proc';
  let entries: string[];
  try {
    entries = await readdir(procDir);
  } catch {
    return [];
  }
  const out: BootWorker[] = [];
  for (const ent of entries) {
    const worker = await inspectProcEntry(procDir, ent);
    if (worker !== null) out.push(worker);
  }
  return out;
}

async function inspectProcEntry(procDir: string, ent: string): Promise<BootWorker | null> {
  const pid = Number(ent);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  let raw: string;
  try {
    raw = await readFile(path.join(procDir, ent, 'cmdline'), 'utf8');
  } catch {
    return null;
  }
  const argv = raw.split('\0').filter((s) => s.length > 0);
  if (argv.length === 0) return null;
  if (!argv.some((a) => path.basename(a) === '_boot-vm')) return null;
  const configPath = argv.find((a) => a.endsWith('boot-config.json'));
  if (!configPath) return null;
  const vmName = await resolveBootWorkerVmName(configPath);
  if (vmName === null) return null;
  return { pid, vmName };
}

function defaultKillProcess(pid: number, signal: NodeJS.Signals | 0): void {
  process.kill(pid, signal);
}

export type { BakeExecutor } from './bake.js';
export type { ReconcilerSnapshot, ResourceSnapshot, ActionStatus } from './types.js';
export type { IntendedVmProvider, BootWorker, VmEffect, VmObservedState } from './vm.js';
export { decideVm } from './vm.js';
export type {
  WorkspaceIntendedProvider,
  BaseRefProvider,
  WorkspaceInspection,
  RemoveReason,
} from './workspace.js';
export type {
  PrIntent,
  PrIntentKind,
  PrIntendedProvider,
  PrSummary,
  PrView,
  PrState,
  PrMergeable,
  PrApi,
  PrGitApi,
  PrTransitionApi,
  PrCleanupApi,
  PrWorkspaceEnsureApi,
  EnsureWorkspaceOutcome,
  RebaseOutcome,
  PushOutcome,
} from './pr.js';
export { PrResource } from './pr.js';
export { GhCliPrApi, GitCliPrGitApi } from './pr-adapters.js';
