// Reconciler (issue 32). Owns the resource DAG that converges managed external
// resources toward their declared desired state.
//
// Resources: the VM reaper (Gondolin session GC), the workspace janitor, and PR
// autopilot. The DAG walker, per-action ledger, and dispatch-gating predicate
// are written generically so additional resources can plug in by registering.
// (The earlier per-issue image-bake resource was removed in the Gondolin
// migration — the agent image is built once via `images/agents`, not baked per
// issue.)
//
// Triggers (per issue 31 sketch):
//   • startup            — orchestrator calls reconcile() before the first dispatch.
//   • config-watcher     — orchestrator's onConfigReloaded calls reconcile().
//   • tracker-state      — left to a future stage (no tracker-driven resources in v1).
//   • backstop tick      — internal timer fires reconcile() every
//                          `backstopIntervalMs` so a missed signal can't park the
//                          reconciler forever.
//
// `reconcile --force` (CLI flag) propagates `{ force: true }` through, requesting
// an immediate reconcile pass instead of waiting on the backstop tick.

import type { ReconcilerSnapshot, ResourceSnapshot } from './types.js';
import { VmResource, type IntendedVmProvider, type ReaperSession } from './vm.js';
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
  type PrIntendedProvider,
  type PrTransitionApi,
} from './pr.js';
import { GhCliPrApi } from './pr-adapters.js';
import type { ServiceConfig } from '../types.js';
import type { VmClient, VmSession } from '../agent/vm-port.js';
import { log } from '../logging.js';

export interface ReconcilerOptions {
  // Backstop tick interval (ms). Default 5 minutes so a missed config-watcher
  // signal can't park the reconciler forever; tests override to a small value.
  backstopIntervalMs?: number;
  // VM reaper inputs (issue 33 / Gondolin migration Phase 4). Optional so test
  // harnesses that don't exercise VM lifecycle can omit them; when either
  // `vmClient` or an intended provider is missing, the vm resource is not
  // constructed and `reapVms()` is a no-op. The reaper observes Gondolin's
  // session registry (`vmClient.listSessions`) + runs Gondolin's GC
  // (`vmClient.gc`) — no more CLI `machine ls` / `_boot-vm` /proc scraping.
  vmClient?: VmClient;
  vmIntendedProvider?: IntendedVmProvider;
  // VmResource test hooks (mirror the same names on VmResourceOptions). Tests
  // can override the session enumerator / gc directly instead of supplying a
  // full VmClient.
  listSessions?: () => Promise<ReaperSession[]>;
  gc?: () => Promise<number>;
  killProcess?: (pid: number, signal: NodeJS.Signals | 0) => void;
  killGraceMs?: number;
  // Override the reaper's "own pid" (defaults to `process.pid`). Tests inject a
  // deterministic value so the self-pid exclusion path is observable without
  // depending on the test runner's real pid.
  selfPid?: number;
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
  prTransition?: PrTransitionApi;
  prCleanup?: PrCleanupApi;
}

export class Reconciler {
  private readonly backstopIntervalMs: number;
  // VM reaper. Built at construction when a VmClient + intended provider are
  // already wired; otherwise lazily constructed via setIntendedVmProvider
  // (the production path — bin/symphony.ts builds the Reconciler before the
  // Orchestrator, then plugs the Orchestrator in as the intended-VM source).
  private vm: VmResource | null = null;
  private vmClient: VmClient | null = null;
  private vmListSessions?: () => Promise<ReaperSession[]>;
  private vmGc?: () => Promise<number>;
  private vmKillProcess?: (pid: number, signal: NodeJS.Signals | 0) => void;
  private vmKillGraceMs?: number;
  private vmSelfPid?: number;
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
  private prTransition: PrTransitionApi | null = null;
  private prCleanup: PrCleanupApi | null = null;
  private backstopTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  // Single-flight: collapse concurrent reconcile() calls into one ongoing pass so
  // an event burst (config reload + backstop + manual trigger landing within ms
  // of each other) doesn't kick off three overlapping reconcile passes.
  private inFlight: Promise<void> | null = null;
  private rerunRequested = false;

  constructor(private cfg: ServiceConfig, opts: ReconcilerOptions = {}) {
    this.backstopIntervalMs = opts.backstopIntervalMs ?? 5 * 60_000;
    this.initVm(opts);
    this.initWorkspace(opts);
    this.initPrProviders(opts);
    this.pr = this.buildPrResource();
  }

  private initVm(opts: ReconcilerOptions): void {
    this.vmClient = opts.vmClient ?? null;
    this.vmListSessions = opts.listSessions;
    this.vmGc = opts.gc;
    this.vmKillProcess = opts.killProcess;
    this.vmKillGraceMs = opts.killGraceMs;
    this.vmSelfPid = opts.selfPid;
    // Build eagerly only when a session source AND an intended provider are
    // both already wired. The session source is either the VmClient or the
    // explicit `listSessions` test hook; `setIntendedVmProvider` rebuilds once
    // the orchestrator lands.
    if ((this.vmClient || this.vmListSessions) && opts.vmIntendedProvider) {
      this.vm = this.buildVmResource(opts.vmIntendedProvider);
    }
  }

  /**
   * Assemble the {@link VmResource} options against the wired Gondolin session
   * source. `listSessions`/`gc` resolve from explicit test hooks first, then
   * fall back to the {@link VmClient} (the production path) — the shell adapts
   * `VmClient.listSessions()` (`VmSession[]`) into the reaper's local
   * `ReaperSession` shape so vm.ts never imports the port/adapter.
   */
  private buildVmResource(intended: IntendedVmProvider): VmResource {
    const client = this.vmClient;
    const listSessions =
      this.vmListSessions ??
      (client ? async (): Promise<ReaperSession[]> => adaptSessions(await client.listSessions()) : null);
    const gc = this.vmGc ?? (client ? (): Promise<number> => client.gc() : null);
    if (!listSessions || !gc) {
      throw new Error('vm reaper: no session source wired (need vmClient or listSessions+gc)');
    }
    return new VmResource({
      intended,
      listSessions,
      gc,
      killProcess: this.vmKillProcess ?? defaultKillProcess,
      killGraceMs: this.vmKillGraceMs,
      // The reaper's own pid, injected so the pure core can exclude it (and so
      // the shell can never `process.kill` itself). Sourced here in the shell —
      // vm.ts must not read `process`.
      selfPid: this.vmSelfPid ?? process.pid,
    });
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
    if (opts.prTransition) this.prTransition = opts.prTransition;
    if (opts.prCleanup) this.prCleanup = opts.prCleanup;
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
    if (!this.prIntended || !this.prApi || !this.prTransition || !this.prCleanup) {
      return null;
    }
    const conflictRouteTo =
      this.cfg.pr_autopilot.conflict_route_to ?? defaultConflictRouteTo(this.cfg);
    return new PrResource({
      intended: this.prIntended,
      pr: this.prApi,
      transition: this.prTransition,
      cleanup: this.prCleanup,
      strategy: this.cfg.pr_autopilot.auto_merge_strategy,
      conflictRouteTo,
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
   * No-op when no session source (VmClient or explicit `listSessions` hook)
   * was wired at Reconciler construction; without one, the reaper has nothing
   * to enumerate Gondolin's session set with.
   */
  setIntendedVmProvider(provider: IntendedVmProvider): void {
    if (!this.vmClient && !this.vmListSessions) return;
    this.vm = this.buildVmResource(provider);
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
    transition: PrTransitionApi;
    cleanup: PrCleanupApi;
  }): void {
    this.prIntended = opts.intended;
    this.prApi = opts.pr;
    this.prTransition = opts.transition;
    this.prCleanup = opts.cleanup;
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
       * passes a closure over `WorkspaceManager.remove`; tests omit it to use
       * the default `rm -rf`.
       */
      remove?: WorkspaceResourceOptions['remove'];
      /**
       * Override the create callback. Production passes a closure over
       * `WorkspaceManager.ensureFor` so the same canonical clone+branch+remote
       * setup that dispatch uses also fires for reconciler-driven eager
       * creation. Omitted ⇒ the reconciler only reaps; useful for tests that
       * don't exercise creation.
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
   * Decoupled from `reconcile()` so VM reaping can run on its own cadence
   * (startup/shutdown/worker-exit) without waiting on a full reconcile pass.
   * Returns immediately when the vm resource isn't wired.
   */
  async reapVms(): Promise<void> {
    if (!this.vm) return;
    try {
      await this.vm.reconcile();
    } catch (err) {
      log.warn('vm reap pass threw', { error: (err as Error).message });
    }
  }

  // Re-bind config-dependent resources against the freshly-reloaded config.
  updateConfig(cfg: ServiceConfig): void {
    this.cfg = cfg;
    // Workspace janitor reads `workspace.root` at construction; rebind so a
    // workflow reload that moved the workspace root takes effect on the next
    // pass. Preserves the held intended/integration providers — they're
    // referenced indirectly via the orchestrator's identity, which doesn't
    // change on reload.
    if (this.workspace) {
      this.workspace = this.buildWorkspaceResource();
    }
    // PR autopilot reads strategy / route-state fields from cfg at
    // construction. Rebuild so a reload that flips `enabled` or changes any
    // field takes effect on the next pass.
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
    // Don't block shutdown on an in-flight reconcile pass — the janitors are
    // idempotent and re-run on the next start. Surface awaitInFlight() as an
    // explicit call for tests that need deterministic completion.
  }

  // Await the current reconcile pass (if any). Used by tests that trigger a
  // background reconcile (e.g. via updateConfig) and need it settled before
  // asserting. Resolves immediately when no pass is in flight.
  async awaitInFlight(): Promise<void> {
    if (this.inFlight) await this.inFlight;
  }

  // Trigger a reconcile pass. Idempotent across overlapping callers (single-flight);
  // if a pass is in progress when called, a re-run is scheduled to fire once it
  // completes so the latest config is always observed.
  //
  // `force` requests an immediate pass (the CLI `reconcile --force` entry point);
  // it no longer has resource-specific semantics now that the bake is gone, but
  // the parameter is threaded so existing callers keep compiling and the rerun
  // coalescing below still guarantees a fresh pass observes the latest state.
  async reconcile(opts: { force?: boolean } = {}): Promise<void> {
    if (this.stopped) return;
    if (this.inFlight) {
      this.rerunRequested = true;
      await this.inFlight;
      if (this.rerunRequested) {
        this.rerunRequested = false;
        await this.runPass();
      }
      return;
    }
    await this.runPass();
    while (this.rerunRequested && !this.stopped) {
      this.rerunRequested = false;
      await this.runPass();
    }
  }

  private async runPass(): Promise<void> {
    this.inFlight = (async () => {
      try {
        // Independent janitors: vm reaper, workspace janitor, PR autopilot. Each
        // is idempotent / cheap when there's no work to do — the passes return
        // immediately when desired == actual.
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
  // True iff every resource the dispatch flow depends on is ready. The bake was
  // the only dispatch-gating prerequisite; with the image built ahead of time
  // (not per issue) there is nothing left to gate on, so dispatch is always ready.
  dispatchReady(): boolean {
    return true;
  }

  snapshot(): ReconcilerSnapshot {
    const resources: ResourceSnapshot[] = [];
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
 * Adapt Gondolin's `VmSession[]` (from `VmClient.listSessions()`) into the
 * reaper's local `ReaperSession` shape. Keeping this projection in the shell
 * lets `vm.ts` (the functional core) stay free of any `vm-port`/adapter import:
 * the core only ever sees the minimal `{ pid, label? }` it acts on.
 *
 * Safety: only `alive === true` sessions are forwarded to the core. A STALE
 * (dead-pid, `alive: false`) session is Gondolin `gc()`'s job; if it reached the
 * core it could be SIGTERM'd as a "live orphan" even though its recorded `pid`
 * may since have been REUSED by an unrelated host process — signalling that pid
 * would hit the wrong process. Dropping dead sessions here keeps the core
 * minimal (it never needs an `alive` flag) and guarantees `decideVm` only ever
 * sees genuinely-live pids.
 */
function adaptSessions(sessions: VmSession[]): ReaperSession[] {
  return sessions
    .filter((s) => s.alive === true)
    .map((s) => ({ pid: s.pid, label: s.label }));
}

function defaultKillProcess(pid: number, signal: NodeJS.Signals | 0): void {
  process.kill(pid, signal);
}

export type { ReconcilerSnapshot, ResourceSnapshot, ActionStatus } from './types.js';
export type { IntendedVmProvider, ReaperSession, VmEffect, VmObservedState } from './vm.js';
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
  PrTransitionApi,
  PrCleanupApi,
} from './pr.js';
export { PrResource } from './pr.js';
export { GhCliPrApi } from './pr-adapters.js';
