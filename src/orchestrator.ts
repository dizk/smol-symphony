// Orchestrator. Owns the single-authority runtime state and drives the
// poll-and-dispatch tick, retries, reconciliation, and worker exit handling.

import type {
  Issue,
  RetryEntry,
  RetryKind,
  RunningEntry,
  RuntimeEvent,
  ServiceConfig,
  SessionTotals,
  WorkflowDefinition,
} from './types.js';
import type { IssueTracker } from './trackers/types.js';
import type { WorkflowSource } from './workflow.js';
import {
  resolveHooksForState,
  validateDispatch,
  warnOnHooksAndActionsConflict,
  WorkflowError,
} from './workflow.js';
import { validateDispatchIo } from './workflow-loader.js';
import { writeIssueFile, pickHoldingState } from './issues.js';
import type { ResourceSnapshot } from './reconciler/index.js';
import type { ProposeFollowupSink } from './actions/index.js';
import type { AgentRunner } from './agent/runner.js';
import { resolveDispatchConfig } from './agent/runner.js';
import {
  codexCredentialAvailable,
  codexMissingCredentialMessage,
  hostClaudeCredentialPath,
  hostCodexCredentialPath,
  isKnownAdapter,
} from './agent/adapter-names.js';
import { accessSync, constants as fsConstants, readFileSync } from 'node:fs';
import { activeStateNames, terminalStateNames } from './issues.js';
import {
  buildIssueDetailDto,
  classifyPrIntent,
  computeEligibilityReason,
  decideCircuitBreaker,
  decideExitRetry,
  decideReconcileForIssue,
  decideRetryAfterIneligible,
  requiredAdapterIds,
  resolveActorString,
  type CircuitBreakerState,
  type EligibilitySnapshot,
} from './orchestrator-decisions.js';

// ACP rate-limit signals are out of band today; this is kept as a generic value type so the
// snapshot endpoint can attach whatever shape a future ACP `_meta` extension produces.
type JsonValue = unknown;
import type { WorkspaceManager, HookCapture, HookResult } from './workspace.js';
import { withIssue, log } from './logging.js';
import { openRunLog, type RunLog } from './runlog.js';
import { defaultMemProbe, computeMemoryAdmission, type MemProbe } from './memory.js';
import type {
  Reconciler,
  ReconcilerSnapshot,
  IntendedVmProvider,
  WorkspaceIntendedProvider,
  BaseRefProvider,
  PrIntent,
  PrIntendedProvider,
} from './reconciler/index.js';
import { runProcess } from './util/process.js';

export interface Snapshot {
  generated_at: string;
  counts: { running: number; retrying: number };
  running: Array<{
    issue_id: string;
    issue_identifier: string;
    issue_title: string;
    issue_body: string;
    state: string;
    session_id: string | null;
    turn_count: number;
    last_event: string | null;
    last_message: string | null;
    started_at: string;
    last_event_at: string | null;
    tokens: { input_tokens: number; output_tokens: number; total_tokens: number };
    steering_requested: boolean;
    steering_question: string | null;
    steering_context: string | null;
    transitioned: boolean;
  }>;
  retrying: Array<{
    issue_id: string;
    issue_identifier: string;
    attempt: number;
    due_at: string;
    error: string | null;
  }>;
  session_totals: SessionTotals;
  rate_limits: JsonValue | null;
  /**
   * Memory-aware admission snapshot (issue 27). `effective_cap < static_cap` is the
   * "why isn't this dispatching" signal — the dynamic clamp has kicked in. When the
   * feature is disabled or the host doesn't expose `/proc/meminfo`, fields read
   * `enabled: false` / `probe_supported: false` and `effective_cap === static_cap`.
   */
  memory_admission: {
    enabled: boolean;
    probe_supported: boolean;
    mem_available_mib: number | null;
    reserve_mib: number;
    per_vm_mib: number;
    static_cap: number;
    effective_cap: number;
    admission_room: number | null;
    clamp_active: boolean;
  };
  /**
   * Per-resource reconciler state (issue 32). Stage 1 surfaces a single resource —
   * the Smolfile-driven `bake` — so the dashboard can render "baking…" / "ready" /
   * "error: <reason>" instead of an empty queue while dispatch is gated on the
   * bake. Null when no reconciler is wired (test stubs that don't exercise it).
   */
  reconciler: ReconcilerSnapshot | null;
}

interface RetrySchedule {
  identifier: string;
  attempt: number;
  delayMs: number;
  error: string | null;
  kind: RetryKind;
  target_state: string;
}

const CONTINUATION_DELAY_MS = 1_000;
const FAILURE_BASE_MS = 10_000;

/**
 * Resolve the base branch the autopilot should rebase against. Mirrors the
 * after_create hook contract — operators export `SYMPHONY_BASE_BRANCH` to
 * override; default is `main`.
 */
function baseBranchName(): string {
  const env = process.env.SYMPHONY_BASE_BRANCH;
  if (env && env.length > 0) return env;
  return 'main';
}

export class Orchestrator
  implements
    IntendedVmProvider,
    WorkspaceIntendedProvider,
    BaseRefProvider,
    PrIntendedProvider,
    ProposeFollowupSink
{
  private running = new Map<string, RunningEntry>();
  private claimed = new Set<string>();
  private retryAttempts = new Map<string, RetryEntry>();
  // Per-issue circuit-breaker streak (issue 128): the last abnormal-exit reason
  // (normalized) and how many consecutive attempts failed with it. Updated on
  // every worker exit; cleared on a clean exit, on trip, and on claim release.
  // In-memory only — a process restart resets the streak, but the *trip itself*
  // is restart-safe because it physically moves the issue out of the active set.
  private circuitBreakers = new Map<string, CircuitBreakerState>();
  private completed = new Set<string>();
  // Per-state ledger of the most-recent action-list execution. Surfaced via
  // `snapshot.reconciler.resources` so the dashboard can render "Done.actions:
  // push_branch ok, create_pr_if_missing in_progress" without a separate
  // first-class surface for action state (issue 36 AC5).
  private lastActionResults = new Map<string, ResourceSnapshot>();
  // Per-issue JSONL run log. Opened lazily on first dispatch for an issue, kept open across
  // retries so the file is one chronological stream per issue, and closed only when the
  // issue finally unwinds (terminal cleanup, claim release without redispatch, or stop()).
  private runLogs = new Map<string, RunLog>();
  // Set of issue ids whose terminal cleanup (workspaces.remove + before_remove hook) is
  // still in flight. Used by closeRunLog to defer the close until the cleanup hook
  // capture has stopped writing; otherwise the retry-timer's "claim released" close fires
  // ~1s after worker exit (before the hook finishes) and we'd lose the cleanup hook lines
  // in the JSONL log.
  private cleanupInFlight = new Set<string>();
  private sessionTotals: SessionTotals = {
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    seconds_running: 0,
  };
  private rateLimits: JsonValue | null = null;
  private tickTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private refreshRequested = false;
  // Latest dispatch validation error, if any (operator-visible).
  private lastValidationError: string | null = null;

  // Optional callback used to propagate reloaded config to components that hold their own
  // tracker/runner/workspace state (so prompt body, hooks, smolvm config, etc., take effect
  // on the next dispatch).
  private onConfigReloaded?: (cfg: ServiceConfig, workflow: WorkflowDefinition) => void;

  // Last clamp-active state observed by availableGlobalSlots. Used to log
  // transitions (clamp_active true→false or false→true) at info level without
  // spamming the log every tick while the cap stays clamped.
  private memoryClampActive = false;

  constructor(
    private cfg: ServiceConfig,
    private workflowDef: WorkflowDefinition,
    private workflowSrc: WorkflowSource,
    private tracker: IssueTracker,
    private workspaces: WorkspaceManager,
    private runner: AgentRunner,
    // Memory probe used by the admission cap (issue 27). Defaults to reading
    // /proc/meminfo synchronously; tests inject a stub that returns a controlled
    // mem_available_mib so the clamp behavior is deterministic.
    private memProbe: MemProbe = defaultMemProbe,
    // Reconciler (issue 32, 33) — owns managed external resources: the
    // Smolfile-driven bake AND the symphony-VM lifecycle reaper. Optional so
    // tests that don't exercise reconciliation don't have to construct one;
    // when absent, dispatch is never gated on a bake, `Snapshot.reconciler`
    // is null, and stray VM reaping is skipped. Production wiring in
    // bin/symphony.ts always passes one in.
    private reconciler: Reconciler | null = null,
  ) {
    workflowSrc.onChange((next) => {
      if ('error' in next) {
        this.lastValidationError = next.error.message;
        log.warn('workflow reload error', { error: next.error.message });
        return;
      }
      this.cfg = next.config;
      this.workflowDef = next.definition;
      this.lastValidationError = null;
      this.onConfigReloaded?.(next.config, next.definition);
      // Issue 32: a config-watcher change is one of the reconciler's declared
      // triggers. Re-binding the resource set picks up a new `smolvm.smolfile`
      // path or hash and kicks off a new bake if the contents changed.
      this.reconciler?.updateConfig(next.config);
      log.info('runtime config reloaded', {
        poll_interval_ms: next.config.polling.interval_ms,
        max_concurrent_agents: next.config.agent.max_concurrent_agents,
      });
    });
  }

  /** Register a callback invoked after every successful workflow reload. */
  setOnConfigReloaded(cb: (cfg: ServiceConfig, workflow: WorkflowDefinition) => void): void {
    this.onConfigReloaded = cb;
  }

  async start(): Promise<void> {
    const validation = validateDispatch(this.cfg) ?? validateDispatchIo(this.cfg);
    if (validation) {
      log.error('startup validation failed', { error: validation });
      throw new WorkflowError('workflow_parse_error', validation);
    }
    // Issue 36 AC2: warn once at startup for every state that declares both
    // `hooks:` and `actions:`. The actions list wins at runtime; this log line
    // is the operator-visible "we noticed your hooks but ignored them" signal.
    warnOnHooksAndActionsConflict(this.cfg);
    await this.assertAdapterCredentials();
    await this.runStartupReconcile();
    this.scheduleTick(0);
  }

  /**
   * Fail fast when symphony will dispatch to an adapter whose host credential
   * (consumed by the credential proxy) is missing. Per-state overrides can
   * change the adapter, so the set is the union of `cfg.acp.adapter` and every
   * distinct `states.<name>.adapter`. claude needs `~/.claude/.credentials.json`;
   * codex needs either a `~/.codex/auth.json` token or an `OPENAI_API_KEY` env
   * var. A missing credential surfaces here as a clear startup error rather than
   * an opaque per-request proxy failure mid-dispatch.
   */
  private async assertAdapterCredentials(): Promise<void> {
    const ids = requiredAdapterIds(this.cfg, isKnownAdapter);
    if (ids.has('claude')) this.assertClaudeCredential();
    if (ids.has('codex')) this.assertCodexCredential();
  }

  private assertClaudeCredential(): void {
    const credPath = hostClaudeCredentialPath();
    try {
      accessSync(credPath, fsConstants.R_OK);
    } catch (err) {
      const msg = `adapter "claude" requires a host credential at ${credPath}, but it is missing or unreadable: ${(err as Error).message}`;
      log.error('startup credential check failed', { adapter: 'claude', error: msg });
      throw new WorkflowError('missing_host_credential', msg);
    }
  }

  private assertCodexCredential(): void {
    let authText: string | null = null;
    try {
      authText = readFileSync(hostCodexCredentialPath(), 'utf8');
    } catch {
      authText = null;
    }
    if (codexCredentialAvailable(authText, process.env)) return;
    const msg = codexMissingCredentialMessage();
    log.error('startup credential check failed', { adapter: 'codex', error: msg });
    throw new WorkflowError('missing_host_credential', msg);
  }

  /**
   * Initial workspace + VM reap and the first reconcile pass (issues 32-34).
   * The `running` map is empty here, so the janitors converge to "remove
   * anything orphaned by the previous process" and the bake (if any) starts
   * before the first dispatch.
   */
  private async runStartupReconcile(): Promise<void> {
    if (!this.reconciler) return;
    await this.reconciler.reapWorkspaces();
    await this.reconciler.reapVms();
    this.reconciler.start();
    void this.reconciler.reconcile().catch((err) =>
      log.warn('initial reconcile pass failed', { error: (err as Error).message }),
    );
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.tickTimer) {
      clearTimeout(this.tickTimer);
      this.tickTimer = null;
    }
    if (this.reconciler) {
      await this.reconciler.stop().catch(() => undefined);
    }
    for (const e of this.retryAttempts.values()) clearTimeout(e.timer_handle);
    this.retryAttempts.clear();
    // Signal cancel on all running entries.
    for (const e of this.running.values()) e.cancel();
    this.running.clear();
    this.claimed.clear();
    this.circuitBreakers.clear();
    // Drain every open run log so the JSONL files are flushed before exit.
    const closures: Promise<void>[] = [];
    for (const [issueId, rl] of this.runLogs) {
      rl.system('runlog_closed', { reason: 'orchestrator_stopped' });
      closures.push(rl.close());
      this.runLogs.delete(issueId);
    }
    await Promise.all(closures);
    // VM teardown lives in the reconciler `vm` resource (issue 52). stop() does NOT
    // wait for in-flight workers to unwind before returning — the bin script then
    // exits the process, which kills the smolvm CLI children but NOT the libkrun VMs
    // they launched (those are owned by the smolvm daemon). Without this backstop,
    // every SIGTERM during an active run leaks one VM per running entry, and over
    // enough operator restarts the host OOMs (issue 26). `running` is cleared above,
    // so the reaper's intended set is ∅ and every `symphony-*` VM (registry + any
    // surviving `_boot-vm` worker) gets torn down.
    if (this.reconciler) {
      await this.reconciler.reapVms();
    }
  }

  /**
   * Operator trigger for an immediate reconcile pass. Used by `symphony reconcile
   * --force` (which invalidates the cache first via `force: true`) and by any
   * future dashboard button that wants to re-evaluate the resource DAG without
   * waiting for the backstop tick.
   */
  async triggerReconcile(opts: { force?: boolean } = {}): Promise<void> {
    if (!this.reconciler) return;
    await this.reconciler.reconcile(opts);
  }

  /** Operator trigger for an immediate poll cycle (§9.5 /refresh). */
  triggerRefresh(): { queued: boolean; coalesced: boolean } {
    if (this.refreshRequested) return { queued: true, coalesced: true };
    this.refreshRequested = true;
    if (this.tickTimer) clearTimeout(this.tickTimer);
    this.tickTimer = setTimeout(() => void this.tick(), 0);
    return { queued: true, coalesced: false };
  }

  private scheduleTick(delayMs: number) {
    if (this.stopped) return;
    if (this.tickTimer) clearTimeout(this.tickTimer);
    this.tickTimer = setTimeout(() => void this.tick(), delayMs);
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    this.refreshRequested = false;
    await this.reconcileSafely();
    if (!this.applyDispatchValidation()) return;
    const fetched = await this.fetchCandidatesForTick();
    if (!fetched) return;
    if (this.gatedOnReconciler(fetched.issues.length)) return;
    this.dispatchSorted(this.sortForDispatch(fetched.issues), fetched.root);
    this.scheduleTick(this.cfg.polling.interval_ms);
  }

  private async reconcileSafely(): Promise<void> {
    try {
      await this.reconcile();
    } catch (err) {
      log.warn('reconcile error', { error: (err as Error).message });
    }
  }

  /**
   * Run dispatch validation. Returns true to continue dispatch, false when the
   * config is invalid (the tick is rescheduled and the caller must return).
   */
  private applyDispatchValidation(): boolean {
    const validation = validateDispatch(this.cfg) ?? validateDispatchIo(this.cfg);
    if (validation) {
      this.lastValidationError = validation;
      log.warn('dispatch validation failed; skipping dispatch', { error: validation });
      this.scheduleTick(this.cfg.polling.interval_ms);
      return false;
    }
    this.lastValidationError = null;
    return true;
  }

  /**
   * Atomic fetch: the tracker returns the issues AND the root it used during
   * the scan. That's the snapshot we pin onto each RunningEntry, so a workflow
   * reload that races the dispatch loop can't cause `transition` to operate
   * against a different tracker root than where the issue lives. Returns
   * null on tracker error (tick is rescheduled, caller must return).
   */
  private async fetchCandidatesForTick(): Promise<{ issues: Issue[]; root: string | null } | null> {
    try {
      const r = await this.tracker.fetchCandidateIssues();
      return { issues: r.issues, root: r.root };
    } catch (err) {
      log.warn('candidate fetch failed', { error: (err as Error).message });
      this.scheduleTick(this.cfg.polling.interval_ms);
      return null;
    }
  }

  /**
   * Reconciler gate (issue 32): refuse to dispatch any issue whose
   * prerequisites haven't converged. When the gate is closed we kick a
   * reconcile pass so the loop self-corrects on the next poll instead of
   * waiting on the slower backstop tick. Returns true when dispatch must
   * be skipped (caller must return).
   */
  private gatedOnReconciler(candidateCount: number): boolean {
    if (!this.reconciler || this.reconciler.dispatchReady()) return false;
    log.debug('dispatch gated on reconciler', { candidate_count: candidateCount });
    void this.reconciler.reconcile().catch((err) =>
      log.debug('gated-reconcile failed', { error: (err as Error).message }),
    );
    this.scheduleTick(this.cfg.polling.interval_ms);
    return true;
  }

  private dispatchSorted(sorted: Issue[], snapshotTrackerRoot: string | null): void {
    for (const issue of sorted) {
      if (this.availableGlobalSlots() <= 0) break;
      if (!this.isEligible(issue)) continue;
      void this.dispatchIssue(issue, null, { trackerRoot: snapshotTrackerRoot });
    }
  }

  /** Stall detection + tracker state refresh for running issues. */
  private async reconcile(): Promise<void> {
    this.detectStalls();
    await this.refreshTrackerStates();
  }

  private detectStalls(): void {
    if (this.cfg.acp.stall_timeout_ms <= 0) return;
    const now = Date.now();
    for (const [issueId, entry] of this.running) {
      // Skip stall detection for issues awaiting human steering: the agent is
      // intentionally paused while the human composes a reply, and the wait can
      // legitimately exceed stall_timeout_ms. The cancel signal still applies
      // (the runner's awaitSteeringReply respects it) for non-stall reasons like
      // terminal-state transitions or operator-initiated cancels.
      if (entry.steering_requested) continue;
      const ref = entry.last_event_at ?? entry.started_at;
      const elapsed = now - Date.parse(ref);
      if (Number.isFinite(elapsed) && elapsed > this.cfg.acp.stall_timeout_ms) {
        log.warn('stall detected', {
          issue_id: issueId,
          issue_identifier: entry.identifier,
          elapsed_ms: elapsed,
        });
        this.terminateRunning(issueId, false, `stalled after ${elapsed}ms`);
      }
    }
  }

  private async refreshTrackerStates(): Promise<void> {
    const ids = [...this.running.keys()];
    if (ids.length === 0) return;
    let refreshed: Issue[];
    try {
      refreshed = await this.tracker.fetchIssueStatesByIds(ids);
    } catch (err) {
      log.debug('state refresh failed; keep workers running', { error: (err as Error).message });
      return;
    }
    const byId = new Map(refreshed.map((i) => [i.id, i]));
    for (const id of ids) this.applyReconcileAction(id, byId.get(id));
  }

  private applyReconcileAction(id: string, fresh: Issue | undefined): void {
    const decision = decideReconcileForIssue(fresh, this.cfg.states);
    if (decision.kind === 'terminate') {
      this.terminateRunning(id, decision.cleanup, decision.reason);
    } else if (decision.kind === 'refresh' && fresh) {
      const entry = this.running.get(id);
      if (entry) entry.issue = fresh;
    }
  }

  private terminateRunning(issueId: string, cleanupWorkspace: boolean, reason: string): void {
    const entry = this.running.get(issueId);
    if (!entry) return;
    if (cleanupWorkspace) entry.cleanup_workspace_on_exit = true;
    entry.cancel();
    this.runLogs.get(issueId)?.system('reconciliation_terminating', {
      reason,
      cleanup_workspace: cleanupWorkspace,
    });
    log.info('reconciliation terminating run', {
      issue_id: issueId,
      issue_identifier: entry.identifier,
      reason,
      cleanup_workspace: cleanupWorkspace,
    });
  }

  /** Candidate eligibility. */
  private isEligible(issue: Issue): boolean {
    return this.eligibilityReason(issue, /*ignoreOwnClaim*/ false) === null;
  }

  // Returns null when eligible, otherwise a short reason string. The `ignoreOwnClaim`
  // form is used by the retry path so the issue's own claim/retry entry does not block
  // its own redispatch.
  private eligibilityReason(issue: Issue, ignoreOwnClaim: boolean): string | null {
    return computeEligibilityReason(issue, ignoreOwnClaim, this.eligibilitySnapshot());
  }

  private eligibilitySnapshot(): EligibilitySnapshot {
    return {
      active: new Set(activeStateNames(this.cfg.states).map((s) => s.toLowerCase())),
      terminal: new Set(terminalStateNames(this.cfg.states).map((s) => s.toLowerCase())),
      running: new Set(this.running.keys()),
      claimed: this.claimed,
      perStateSlot: (state) => this.hasPerStateSlot(state),
    };
  }

  private availableGlobalSlots(): number {
    // Pending continuations hold their slot. The continuation is the
    // post-transition resume of an issue that just normal-exited (e.g.
    // Todo→Review handoff); without this, a tick firing inside the 1s
    // continuation window can dispatch a brand-new Todo and steal the slot
    // the just-transitioned issue is about to reclaim, leaving it requeued
    // with "no available orchestrator slots" until something else finishes.
    // Failure-backoff retries do NOT hold slots: the orchestrator is free
    // to run other work during the exponential-backoff window.
    let pendingContinuations = 0;
    for (const r of this.retryAttempts.values()) {
      if (r.kind === 'continuation') pendingContinuations++;
    }
    const admission = this.computeAdmission();
    // Log a single line when the memory clamp transitions in or out of "active." This
    // gives the operator the "why isn't this dispatching" signal in the log without
    // spamming every tick while memory stays low.
    if (admission.clamp_active !== this.memoryClampActive) {
      this.memoryClampActive = admission.clamp_active;
      if (admission.clamp_active) {
        log.info('memory admission clamping concurrency', {
          static_cap: admission.static_cap,
          effective_cap: admission.effective_cap,
          mem_available_mib: admission.mem_available_mib,
          reserve_mib: admission.reserve_mib,
          per_vm_mib: admission.per_vm_mib,
        });
      } else {
        log.info('memory admission cleared; full static cap available', {
          static_cap: admission.static_cap,
          mem_available_mib: admission.mem_available_mib,
        });
      }
    }
    return Math.max(0, admission.effective_cap - this.running.size - pendingContinuations);
  }

  /**
   * Compute the current memory-admission snapshot. Reads `/proc/meminfo` via the injected
   * probe (default reads the real file; tests inject a stub). Pure with respect to the
   * orchestrator state — just folds running count + config + probe reading into the
   * dynamic cap. Snapshot endpoint and slot accounting both call through here so they
   * never desync.
   */
  private computeAdmission(): {
    enabled: boolean;
    probe_supported: boolean;
    mem_available_mib: number | null;
    reserve_mib: number;
    per_vm_mib: number;
    static_cap: number;
    effective_cap: number;
    admission_room: number | null;
    clamp_active: boolean;
  } {
    const staticCap = this.cfg.agent.max_concurrent_agents;
    const reserveMib = this.cfg.agent.host_memory_reserve_mib;
    const perVmMib = this.cfg.smolvm.mem_mib;
    const enabled = this.cfg.agent.memory_admission_enabled;
    const probe = enabled
      ? this.memProbe()
      : { mem_available_mib: null, supported: false };
    const { effective_cap, admission_room, clamp_active } = computeMemoryAdmission({
      enabled,
      static_cap: staticCap,
      running: this.running.size,
      probe,
      reserve_mib: reserveMib,
      per_vm_mib: perVmMib,
    });
    return {
      enabled,
      probe_supported: probe.supported,
      mem_available_mib: probe.mem_available_mib,
      reserve_mib: reserveMib,
      per_vm_mib: perVmMib,
      static_cap: staticCap,
      effective_cap,
      admission_room,
      clamp_active,
    };
  }

  /** Per-state slot accounting using current running entries. */
  private hasPerStateSlot(stateName: string): boolean {
    const cap = this.cfg.agent.max_concurrent_agents_by_state[stateName.toLowerCase()];
    if (!cap) return this.availableGlobalSlots() > 0;
    let inState = 0;
    for (const e of this.running.values()) {
      if (e.issue.state.toLowerCase() === stateName.toLowerCase()) inState++;
    }
    // Mirror the global rule for per-state caps: a pending continuation whose
    // target state matches counts against the state's cap, so the resuming
    // worker is guaranteed a slot when its timer fires.
    for (const r of this.retryAttempts.values()) {
      if (r.kind === 'continuation' && r.target_state.toLowerCase() === stateName.toLowerCase()) {
        inState++;
      }
    }
    return inState < cap && this.availableGlobalSlots() > 0;
  }

  /** Sort: priority ASC (null last), then created_at ASC, then identifier. */
  private sortForDispatch(issues: Issue[]): Issue[] {
    return [...issues].sort((a, b) => {
      const pa = a.priority ?? Number.POSITIVE_INFINITY;
      const pb = b.priority ?? Number.POSITIVE_INFINITY;
      if (pa !== pb) return pa - pb;
      const ca = a.created_at ? Date.parse(a.created_at) : Number.POSITIVE_INFINITY;
      const cb = b.created_at ? Date.parse(b.created_at) : Number.POSITIVE_INFINITY;
      if (Number.isFinite(ca) && Number.isFinite(cb) && ca !== cb) return ca - cb;
      return a.identifier.localeCompare(b.identifier);
    });
  }

  /** Dispatch one issue. */
  private async dispatchIssue(
    issue: Issue,
    attempt: number | null,
    snapshot?: { trackerRoot: string | null },
  ): Promise<void> {
    if (this.running.has(issue.id)) return;
    this.claimed.add(issue.id);
    this.retryAttempts.delete(issue.id);
    const cancel = { cancelled: false };
    const startedAt = new Date().toISOString();
    const workspacePath = this.workspaces.workspacePathFor(issue.identifier);
    // Snapshot tracker.root BEFORE workspace setup, before_run, or smolvm
    // bring-up. A WORKFLOW.md reload during that window (or even between
    // fetchCandidateIssues returning and this iteration of the dispatch loop)
    // can mutate the live tracker config; pinning here closes that window.
    // When the caller supplies a snapshot (the tick/retry path does — it
    // captured at the fetch atomically), prefer that value; the optional
    // fallback reads the live config for completeness.
    const trackerRootAtDispatch =
      snapshot?.trackerRoot ?? (this.tracker.currentRoot ? this.tracker.currentRoot() : null);
    // Resolve "<adapter>/<model or 'default'>" at dispatch time and pin it on
    // the entry. The MCP transition tool stamps this into the notes-block
    // header the next agent reads in `issue.description`. The helper folds any
    // per-state override on top of the workflow defaults; an unknown state
    // falls back to workflow defaults so an older test harness without a
    // states map still produces a non-null actor string.
    const resolvedActor = resolveActorString(
      this.cfg.states,
      this.cfg.acp.adapter,
      this.cfg.acp.model,
      issue.state,
    );
    const entry: RunningEntry = {
      issue_id: issue.id,
      identifier: issue.identifier,
      issue,
      session_id: null,
      thread_id: null,
      turn_id: null,
      adapter_pid: null,
      last_event: null,
      last_event_at: null,
      last_message: null,
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      last_reported_input_tokens: 0,
      last_reported_output_tokens: 0,
      last_reported_total_tokens: 0,
      turn_count: 0,
      retry_attempt: attempt,
      started_at: startedAt,
      workspace_path: workspacePath,
      cancel: () => {
        cancel.cancelled = true;
      },
      recent_events: [],
      last_error: null,
      cleanup_workspace_on_exit: false,
      mcp_token: null,
      tracker_root_at_dispatch: trackerRootAtDispatch,
      resolved_actor: resolvedActor,
      transitioned: false,
      steering_requested: false,
      steering_question: null,
      steering_context: null,
      last_transition: null,
    };
    this.running.set(issue.id, entry);
    const logger = withIssue({ issue_id: issue.id, issue_identifier: issue.identifier });
    const runLog = this.ensureRunLog(issue.id, issue.identifier);
    if (runLog) {
      runLog.setAttempt(attempt ?? 0);
      runLog.system('attempt_started', {
        attempt: attempt ?? 0,
        issue_state: issue.state,
        issue_title: issue.title,
        workspace_path: workspacePath,
        tracker_root: trackerRootAtDispatch,
        // Pin the per-state turn budget so the run-summary reducer can report
        // turns-used-vs-budget without re-resolving config (issue 123).
        max_turns: this.resolveStateMaxTurns(issue.state),
      });
    }
    logger.info('agent attempt started', { attempt });
    void this.runWorker(issue, attempt, entry, cancel, runLog);
  }

  /**
   * Open (or return the existing) per-issue run log. Returns `undefined` only when log file
   * opening throws — symphony should keep running even if logs can't be persisted, so the
   * runner sees `undefined` and behaves exactly as before.
   *
   * `issueId` (tracker primary key) is stamped on every line and is the map key so the
   * lifecycle survives identifier collisions or renames; `identifier` derives the filename.
   */
  private ensureRunLog(issueId: string, identifier: string): RunLog | undefined {
    const existing = this.runLogs.get(issueId);
    if (existing) return existing;
    try {
      const rl = openRunLog(this.cfg.logs.root, issueId, identifier);
      this.runLogs.set(issueId, rl);
      return rl;
    } catch (err) {
      log.warn('runlog open failed; continuing without run log', {
        issue_id: issueId,
        issue_identifier: identifier,
        error: (err as Error).message,
      });
      return undefined;
    }
  }

  /**
   * Resolve the per-state turn budget for the run log's `attempt_started`
   * event. Returns null on any resolution failure (unknown state) — the
   * summary reducer treats a null budget as "unknown", never an error.
   */
  private resolveStateMaxTurns(state: string): number | null {
    try {
      return resolveDispatchConfig(this.cfg, state).max_turns;
    } catch {
      return null;
    }
  }

  /**
   * Record the end-of-attempt lifecycle events: the `transition` the agent (or
   * an action reroute) performed during this attempt, if any, followed by
   * `attempt_ended`. Both feed the run-summary reducer (issue 123); recording
   * the transition here — once per attempt, off the hot path — is what makes
   * the state path, rejection notes, and terminal outcome reconstructable.
   */
  private recordAttemptEnd(
    runLog: RunLog | undefined,
    entry: RunningEntry,
    ok: boolean,
    reason: string,
    turnsCompleted: number,
  ): void {
    if (entry.last_transition) runLog?.system('transition', { ...entry.last_transition });
    runLog?.system('attempt_ended', { ok, reason, turns_completed: turnsCompleted });
  }

  private closeRunLog(
    issueId: string,
    fields?: Record<string, unknown>,
    opts: { viaCleanup?: boolean } = {},
  ): void {
    // If a terminal cleanup (`workspaces.remove`) is mid-flight for this issue, the
    // before_remove hook capture is still writing to the run log. Closing the log here
    // would truncate those lines on disk. Defer until the cleanup's .finally fires the
    // close with `viaCleanup: true`.
    if (!opts.viaCleanup && this.cleanupInFlight.has(issueId)) return;
    const rl = this.runLogs.get(issueId);
    if (!rl) return;
    if (fields) rl.system('runlog_closed', fields);
    // Emit the compact per-issue run summary (issue 123) at the terminal unwind,
    // when the lifecycle accumulator holds the full trajectory. Pure over
    // in-memory state, so it precedes (and does not depend on) the stream flush.
    rl.writeSummary();
    this.runLogs.delete(issueId);
    void rl.close();
  }

  private async runWorker(
    issue: Issue,
    attempt: number | null,
    entry: RunningEntry,
    cancelSignal: { cancelled: boolean },
    runLog: RunLog | undefined,
  ): Promise<void> {
    const logger = withIssue({ issue_id: issue.id, issue_identifier: issue.identifier });
    let ok = false;
    let reason = 'unknown';
    let turnsCompleted = 0;
    try {
      const result = await this.runner.runAttempt(issue, attempt, cancelSignal, entry, runLog);
      ok = result.ok;
      reason = result.reason;
      turnsCompleted = result.turnsCompleted;
      if (result.threadId) entry.thread_id = result.threadId;
      entry.turn_count = result.turnsCompleted;
    } catch (err) {
      ok = false;
      reason = (err as Error).message;
      logger.error('worker threw', { error: reason });
    }
    this.recordAttemptEnd(runLog, entry, ok, reason, turnsCompleted);
    this.onWorkerExit(issue.id, ok, reason, entry);
  }

  /** on_worker_exit */
  private onWorkerExit(issueId: string, normal: boolean, reason: string, entry: RunningEntry): void {
    this.running.delete(issueId);
    // Issue 52: the reconciler `vm` resource is the sole owner of VM teardown.
    // Every worker exit — clean or not — kicks the reaper so the intended set
    // (now excluding this issue) converges in a single pass.
    if (this.reconciler && !this.stopped) {
      void this.reconciler.reapVms().catch((err) =>
        log.debug('post-exit vm reap failed', { error: (err as Error).message }),
      );
    }
    const elapsedMs = Date.now() - Date.parse(entry.started_at);
    if (Number.isFinite(elapsedMs)) this.sessionTotals.seconds_running += elapsedMs / 1000;
    const logger = withIssue({ issue_id: issueId, issue_identifier: entry.identifier });
    if (entry.cleanup_workspace_on_exit) this.scheduleWorkspaceCleanup(issueId, entry, logger);
    // If the service was stopped while this worker was unwinding, do not schedule
    // a new retry — that would leave a live timer behind even though stop() was called.
    if (this.stopped) {
      this.claimed.delete(issueId);
      this.circuitBreakers.delete(issueId);
      return;
    }
    if (normal) this.completed.add(issueId);
    // Circuit breaker (issue 128): a deterministically-failing dispatch (same
    // reason every attempt) would otherwise retry forever under backoff. Trip
    // after the configured streak and route the issue to a holding state
    // instead of scheduling another retry.
    if (this.updateCircuitBreaker(issueId, normal, reason, entry)) return;
    const plan = decideExitRetry({
      normal,
      reason,
      priorAttempt: entry.retry_attempt,
      targetState: entry.issue.state,
      continuationDelayMs: CONTINUATION_DELAY_MS,
      failureBaseMs: FAILURE_BASE_MS,
      maxBackoffMs: this.cfg.agent.max_retry_backoff_ms,
    });
    if (normal) {
      logger.info('worker exited (normal)', { reason });
    } else {
      logger.warn('worker exited (abnormal)', {
        reason,
        next_attempt: plan.attempt,
        delay_ms: plan.delayMs,
      });
    }
    this.scheduleRetry(issueId, { identifier: entry.identifier, ...plan });
  }

  /**
   * Fold this exit into the per-issue circuit-breaker streak (issue 128) and
   * return true when the breaker tripped — the caller must then NOT schedule a
   * retry. A clean exit clears the streak; an abnormal exit either records the
   * (normalized) failure or, on reaching `agent.circuit_breaker_threshold`
   * consecutive identical failures, trips and fires the holding-state route.
   * The pure `decideCircuitBreaker` owns the counting; this shell just persists
   * the streak and dispatches the side effect.
   */
  private updateCircuitBreaker(
    issueId: string,
    normal: boolean,
    reason: string,
    entry: RunningEntry,
  ): boolean {
    const decision = decideCircuitBreaker({
      normal,
      reason,
      prior: this.circuitBreakers.get(issueId) ?? null,
      threshold: this.cfg.agent.circuit_breaker_threshold,
    });
    if (decision.kind === 'continue') {
      this.circuitBreakers.set(issueId, {
        normalizedReason: decision.normalizedReason,
        count: decision.count,
      });
      return false;
    }
    this.circuitBreakers.delete(issueId);
    if (decision.kind === 'trip') {
      void this.tripCircuitBreaker(issueId, entry, reason, decision.count);
      return true;
    }
    return false;
  }

  /**
   * Stop retrying a circuit-broken issue and move it into a holding state so a
   * human sees "stuck on identical failure" on the dashboard rather than a
   * silent multi-hour loop. The move is restart-safe (the file leaves the
   * active set on disk, so the loop cannot resume on the next process start).
   * If routing fails — no `holding` state declared, or the tracker can't write
   * — we keep the issue's dispatch claim so the tick's `already claimed` gate
   * still halts the loop for this session, and log loudly.
   */
  private async tripCircuitBreaker(
    issueId: string,
    entry: RunningEntry,
    reason: string,
    count: number,
  ): Promise<void> {
    const logger = withIssue({ issue_id: issueId, issue_identifier: entry.identifier });
    this.runLogs.get(issueId)?.system('circuit_breaker_tripped', {
      reason,
      consecutive_failures: count,
    });
    logger.error('circuit breaker tripped; halting retries', { reason, consecutive_failures: count });
    let holdingState: string;
    try {
      holdingState = pickHoldingState(this.cfg.states);
    } catch {
      logger.error('no holding state declared; retaining claim to halt the retry loop', { reason });
      return;
    }
    const moved = await this.routeToHolding(issueId, entry, holdingState, reason, count);
    if (moved) {
      this.claimed.delete(issueId);
      this.closeRunLog(issueId, { reason: 'circuit_breaker_tripped' });
    }
  }

  /**
   * Move `entry`'s tracker file into `holdingState`, appending a diagnostic
   * note (rendered into the issue body before the rename) so the operator sees
   * why it stopped. Returns false when the tracker can't perform the move so
   * the caller can fall back to retaining the claim. Modelled on the runner's
   * action-reroute path; the orchestrator owns this move because it is
   * state-machine behavior, not repo-local glue.
   */
  private async routeToHolding(
    issueId: string,
    entry: RunningEntry,
    holdingState: string,
    reason: string,
    count: number,
  ): Promise<boolean> {
    if (!this.tracker.moveIssueToState) return false;
    const notes = [
      `**Circuit breaker tripped** — routed to \`${holdingState}\` for human inspection.`,
      '',
      `Symphony stopped retrying after **${count} consecutive attempts failed with the same error**, to avoid an unbounded dispatch loop (issue 128).`,
      '',
      `**Last failure reason:** ${reason}`,
      '',
      `Resolve the underlying cause, then move the issue back into an active state to resume dispatch.`,
    ].join('\n');
    try {
      await this.tracker.moveIssueToState(issueId, holdingState, {
        fromRoot: entry.tracker_root_at_dispatch ?? undefined,
        fromState: entry.issue.state,
        notes,
        actor: entry.resolved_actor,
      });
      return true;
    } catch (err) {
      withIssue({ issue_id: issueId, issue_identifier: entry.identifier }).error(
        'circuit breaker route to holding failed; retaining claim',
        { error: (err as Error).message },
      );
      return false;
    }
  }

  /**
   * Workspace removal deferred until the worker has fully unwound (including
   * after_run hook execution) so we never delete the dir while the agent is
   * still inside it. The before_remove hook runs inside `workspaces.remove`
   * and is mirrored into the per-issue run log. The hook is resolved against
   * the issue's terminal state so a state-specific before_remove fires
   * instead of the workflow-level fallback.
   */
  private scheduleWorkspaceCleanup(
    issueId: string,
    entry: RunningEntry,
    logger: ReturnType<typeof withIssue>,
  ): void {
    const runLog = this.runLogs.get(issueId);
    const capture: HookCapture | undefined = runLog
      ? {
          onChunk: (stream, text) =>
            runLog.record({ channel: 'hook', hook: 'before_remove', stream, text }),
          onResult: (r: HookResult) =>
            runLog.record({
              channel: 'hook',
              hook: 'before_remove',
              kind: 'result',
              exit_code: r.exit_code,
              signal: r.signal,
              timed_out: r.timed_out,
            }),
        }
      : undefined;
    this.cleanupInFlight.add(issueId);
    const removalHooks = resolveHooksForState(this.cfg, entry.issue.state);
    this.workspaces
      .remove(entry.identifier, removalHooks, capture)
      .catch((err) => logger.warn('workspace removal failed', { error: (err as Error).message }))
      .finally(() => {
        this.cleanupInFlight.delete(issueId);
        this.closeRunLog(issueId, { reason: 'cleanup_on_exit' }, { viaCleanup: true });
      });
  }

  /** Retry queue. */
  private scheduleRetry(issueId: string, sched: RetrySchedule): void {
    if (this.stopped) return;
    const existing = this.retryAttempts.get(issueId);
    if (existing) clearTimeout(existing.timer_handle);
    const dueAt = Date.now() + sched.delayMs;
    const handle = setTimeout(() => void this.onRetryTimer(issueId), sched.delayMs);
    this.retryAttempts.set(issueId, {
      issue_id: issueId,
      identifier: sched.identifier,
      attempt: sched.attempt,
      due_at_ms: dueAt,
      timer_handle: handle,
      error: sched.error,
      kind: sched.kind,
      target_state: sched.target_state,
    });
    this.claimed.add(issueId);
  }

  /** on_retry_timer */
  private async onRetryTimer(issueId: string): Promise<void> {
    if (this.stopped) return;
    const entry = this.retryAttempts.get(issueId);
    if (!entry) return;
    this.retryAttempts.delete(issueId);
    const fetched = await this.fetchRetryCandidates(issueId, entry);
    if (!fetched) return;
    const issue = fetched.issues.find((i) => i.id === issueId);
    if (!issue) {
      this.releaseRetryClaim(issueId, entry.identifier, 'not_in_candidates');
      return;
    }
    const reason = this.eligibilityReason(issue, true);
    if (reason !== null) {
      this.handleRetryIneligible(issue, entry, reason);
      return;
    }
    void this.dispatchIssue(issue, entry.attempt, { trackerRoot: fetched.root });
  }

  /**
   * Tracker poll for the retry timer. Returns the snapshot or null when the
   * fetch failed (a failure-shaped retry is rescheduled internally so the
   * caller can just bail).
   */
  private async fetchRetryCandidates(
    issueId: string,
    entry: RetryEntry,
  ): Promise<{ issues: Issue[]; root: string | null } | null> {
    try {
      const r = await this.tracker.fetchCandidateIssues();
      return { issues: r.issues, root: r.root };
    } catch (err) {
      log.debug('retry poll failed', {
        issue_id: issueId,
        issue_identifier: entry.identifier,
        error: (err as Error).message,
      });
      this.scheduleRetry(issueId, {
        identifier: entry.identifier,
        attempt: entry.attempt + 1,
        delayMs: Math.min(
          FAILURE_BASE_MS * Math.pow(2, entry.attempt),
          this.cfg.agent.max_retry_backoff_ms,
        ),
        error: 'retry poll failed',
        kind: 'failure',
        target_state: entry.target_state,
      });
      return null;
    }
  }

  /**
   * Re-applied candidate eligibility came back non-null. The pure
   * `decideRetryAfterIneligible` picks between rescheduling (only `no
   * per-state slot`, which is genuine contention) and releasing the claim
   * (everything else: blocker, missing fields, non-active state).
   */
  private handleRetryIneligible(issue: Issue, entry: RetryEntry, reason: string): void {
    const action = decideRetryAfterIneligible({
      reason,
      priorAttempt: entry.attempt,
      targetState: issue.state,
      failureBaseMs: FAILURE_BASE_MS,
      maxBackoffMs: this.cfg.agent.max_retry_backoff_ms,
    });
    if (action.kind === 'release') {
      this.releaseRetryClaim(issue.id, entry.identifier, `ineligible:${reason}`, reason);
      return;
    }
    this.scheduleRetry(issue.id, { identifier: issue.identifier, ...action.plan });
  }

  private releaseRetryClaim(
    issueId: string,
    identifier: string,
    closeTag: string,
    ineligibleReason?: string,
  ): void {
    this.claimed.delete(issueId);
    this.circuitBreakers.delete(issueId);
    log.info(
      ineligibleReason
        ? 'retry releasing claim (ineligible)'
        : 'retry releasing claim (not in candidates)',
      { issue_id: issueId, issue_identifier: identifier, ...(ineligibleReason ? { reason: ineligibleReason } : {}) },
    );
    this.closeRunLog(issueId, { reason: `claim_released_${closeTag}` });
  }

  /**
   * Implements {@link IntendedVmProvider}. Returns the set of `symphony-*` VM
   * names the orchestrator currently intends to keep alive — one per running
   * dispatch. Used by the reconciler's vm resource to compute the orphan set
   * to reap. `running.set` happens BEFORE the runner calls
   * `smolvm.ensureRunning`, so a VM that exists in the daemon registry as
   * part of an in-flight `machine create` is always already represented
   * here. The reaper sees it as intended and leaves it alone, closing the
   * "creating-but-not-yet-active" race the issue body calls out.
   */
  intendedVmNames(): Set<string> {
    const out = new Set<string>();
    for (const entry of this.running.values()) {
      out.add(this.runner.vmNameFor(entry.issue));
    }
    return out;
  }

  /**
   * Implements {@link WorkspaceIntendedProvider}. Returns the map of
   * identifier → state the reconciler should preserve workspaces for. Two
   * sources are unioned:
   *
   *   • Tracker view: every issue file in a non-terminal state. Anything
   *     terminal (Done, Cancelled) is fair game for removal — this replaces
   *     the old `startupTerminalCleanup` sweep with a continuous pass.
   *   • In-flight allocations: running entries plus claimed/pending retries.
   *     The window between dispatch claiming an issue and the tracker
   *     reflecting it is brief but real; without this, a fresh dispatch's
   *     workspace could be reaped seconds after creation.
   *
   * The state value is carried so the reconciler's `create` callback can
   * resolve per-state hook overrides (a state-level `after_create` block
   * must fire for reconciler-driven eager creation, matching the runner's
   * resolution at dispatch time).
   *
   * Tracker errors propagate. Catching them here would cause an empty set
   * to be returned, which the reconciler would treat as authoritative and
   * reap every workspace — the regression this contract closes. The
   * resource's `reconcile()` catches the throw and leaves on-disk state
   * untouched until the next pass.
   *
   * Mirrors `intendedVmNames()` in shape so the reconciler's race-condition
   * reasoning is the same across both janitors.
   */
  async activeIdentifiers(): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const nonTerminal: string[] = [];
    for (const [name, cfg] of Object.entries(this.cfg.states)) {
      if (cfg.role !== 'terminal') nonTerminal.push(name);
    }
    const issues = await this.tracker.fetchIssuesByStates(nonTerminal);
    for (const i of issues) out.set(i.identifier, i.state);
    // Issue 38: when pr_autopilot is enabled, the merge-state issues' workspaces
    // are owned by the pr resource (it rebases inside them and cleans them up
    // post-merge). Include those identifiers in the desired set so the
    // workspace janitor doesn't reap a workspace the pr resource is actively
    // driving. The orchestrator's `createWorkspace` callback declines to
    // eagerly recreate a missing merge-state workspace — so adding it here is
    // safe: the workspace either already exists from the dispatch that ran
    // the issue into the merge state, or it doesn't and the autopilot just
    // skips the rebase step for that PR.
    if (this.cfg.pr_autopilot.enabled) {
      const mergeIssues = await this.tracker.fetchIssuesByStates([
        this.cfg.pr_autopilot.merge_state,
      ]);
      for (const i of mergeIssues) out.set(i.identifier, i.state);
    }
    return out;
  }

  /**
   * Identifiers the orchestrator has claimed for dispatch but the tracker may
   * not yet reflect as active, with the state used to resolve per-state hooks
   * for an eager workspace create. Running entries carry the state the
   * dispatch was claimed from (`issue.state`); pending retries carry their
   * `target_state` (where the next attempt will run). Both match what the
   * runner would resolve hooks against if it created the workspace itself.
   */
  inFlightIdentifiers(): Map<string, string> {
    const out = new Map<string, string>();
    for (const e of this.running.values()) out.set(e.identifier, e.issue.state);
    for (const r of this.retryAttempts.values()) out.set(r.identifier, r.target_state);
    return out;
  }

  /**
   * Implements {@link ProposeFollowupSink} for the action executor's
   * `propose_followup` action (issue 36). Same tracker shape as the MCP
   * `propose_issue` tool — file lands in the first declared `holding` state,
   * with `proposed_by` set to the parent issue's identifier. Uses the live
   * tracker root (passed-in parent identifier is the canonical attribution).
   */
  async proposeFollowup(input: {
    title: string;
    description?: string;
    labels?: string[];
    priority?: number;
    parent_identifier: string;
  }): Promise<{ identifier: string }> {
    const root = this.tracker.currentRoot ? this.tracker.currentRoot() : this.cfg.tracker.root;
    if (!root) {
      throw new Error('tracker root not available; cannot file propose_followup');
    }
    const landingState = pickHoldingState(this.cfg.states);
    const result = await writeIssueFile({
      trackerRoot: root,
      state: landingState,
      title: input.title,
      description: input.description ?? '',
      priority: input.priority ?? null,
      labels: input.labels ?? [],
      now: () => Date.now(),
      extra_front_matter: {
        proposed_by: input.parent_identifier,
        proposed_at: new Date().toISOString(),
      },
    });
    log.info('action propose_followup', {
      proposed_by: input.parent_identifier,
      identifier: result.identifier,
      state: result.state,
    });
    return { identifier: result.identifier };
  }

  /**
   * Receive a per-attempt action ledger from the runner's cleanup pass. The
   * snapshot is keyed by state so the dashboard can render "Done.actions:
   * push_branch ok, create_pr_if_missing rate-limited, retrying" without the
   * orchestrator having to know about specific action kinds.
   *
   * `id` should follow the `actions:<StateName>` convention so it sorts
   * predictably next to reconciler-resource rows in
   * `snapshot.reconciler.resources`.
   */
  recordActionResult(id: string, snapshot: ResourceSnapshot): void {
    this.lastActionResults.set(id, snapshot);
  }

  /**
   * Workspace removal callback the reconciler invokes for stale dirs (issue
   * 34). Defers to `WorkspaceManager.remove`, resolved against the live
   * workflow-level hooks so a reload that changed `before_remove` takes
   * effect on subsequent reaper passes. Orphan dirs have no matching issue
   * file and therefore no per-state hook to resolve — workflow-level is the
   * only meaningful choice. Failures are logged at warn (the reconciler's
   * action ledger also records them).
   */
  async removeWorkspace(identifier: string): Promise<void> {
    await this.workspaces.remove(identifier, this.cfg.hooks);
  }

  /**
   * Workspace create callback the reconciler invokes for non-terminal issues
   * whose dirs are not yet on disk (issue 34). Delegates to
   * `WorkspaceManager.ensureFor` so the same canonical clone+branch+remote
   * setup the dispatch path runs also fires here.
   *
   * Hooks are resolved against the issue's current state via
   * `resolveHooksForState`, so a state-level `after_create` override fires
   * the same way it would if the runner created the workspace itself. The
   * intended-set provider supplies the state alongside the identifier; the
   * `null` fallback is defensive — production callers always pass a state.
   *
   * Race with the runner's dispatch-time `ensureFor` is handled inside
   * `WorkspaceManager` via a per-identifier in-flight promise lock: both
   * callers coalesce into one setup pass, so `after_create` fires exactly
   * once whether the reconciler or the runner wins the race.
   */
  async createWorkspace(identifier: string, state: string | null): Promise<void> {
    // Issue 38: refuse to eagerly recreate a missing workspace for an issue
    // in the autopilot's merge state. Those workspaces only exist as
    // leftovers from a prior dispatch; recreating one from scratch would
    // miss the agent's local commits (the agent's branch is on the remote,
    // but a fresh clone would still need a separate fetch to pick it up).
    // Operators who genuinely want a recreated workspace can cancel the
    // issue (Cancelled triggers the close path + normal cleanup) and refile.
    if (
      this.cfg.pr_autopilot.enabled &&
      state !== null &&
      state.toLowerCase() === this.cfg.pr_autopilot.merge_state.toLowerCase()
    ) {
      return;
    }
    const hooks = state !== null ? resolveHooksForState(this.cfg, state) : this.cfg.hooks;
    await this.workspaces.ensureFor(identifier, hooks);
  }

  /**
   * Implements {@link PrIntendedProvider} (issue 38). Returns the set of
   * terminal-state issues the PR autopilot should manage:
   *
   *   • Issues in the configured `merge_state` (default `Done`) become
   *     `kind: 'merge'` intents. The autopilot rebases them on
   *     `origin/<base>` and arms GitHub auto-merge.
   *   • Issues in the configured `close_state` (default `Cancelled`) become
   *     `kind: 'close'` intents. The autopilot closes the PR without merge
   *     and best-effort-deletes the remote branch. The workspace is NOT
   *     supplied — Cancelled cleanup goes through the orchestrator's
   *     standard terminal path so the per-state `before_remove` hook still
   *     fires.
   *
   * Both queries hit the tracker; failures bubble (the pr resource catches
   * and surfaces in last_error so a transient tracker hiccup doesn't blank
   * the autopilot's intended set).
   *
   * When `pr_autopilot.enabled` is false this method is never invoked
   * (the reconciler skips its pr pass entirely), but the early return keeps
   * the public surface idempotent.
   */
  async prIntended(): Promise<PrIntent[]> {
    if (!this.cfg.pr_autopilot.enabled) return [];
    const mergeState = this.cfg.pr_autopilot.merge_state;
    const closeState = this.cfg.pr_autopilot.close_state;
    const baseBranch = baseBranchName();
    const states = closeState ? [mergeState, closeState] : [mergeState];
    const issues = await this.tracker.fetchIssuesByStates(states);
    const out: PrIntent[] = [];
    for (const issue of issues) {
      const intent = classifyPrIntent({
        issue,
        mergeState,
        closeState,
        baseBranch,
        mergeWorkspacePath: this.workspaces.workspacePathFor(issue.identifier),
      });
      if (intent) out.push(intent);
    }
    return out;
  }

  /**
   * Tracker-side transition the PR autopilot uses to route a conflict-rebasing
   * issue back into the implementing state (or, after exceeding the attempt
   * limit, into the holding state). Same shape as the MCP transition tool —
   * the tracker handles atomic notes-append + cross-directory rename.
   *
   * No workspace flag is touched here: the target state's `role` decides
   * cleanup at the transition's own level (active/holding never trigger
   * cleanup), and the workspace was preserved across the move into the merge
   * state in the first place because `pr_autopilot.enabled` suppresses the
   * terminal cleanup for that target. See {@link McpRegistry.performTransition}
   * for the role-driven rule.
   */
  async routeIssueForAutopilot(input: {
    identifier: string;
    fromState: string;
    toState: string;
    notes: string;
    actor: string;
  }): Promise<void> {
    if (!this.tracker.moveIssueToState) {
      throw new Error('tracker does not support state transitions');
    }
    // The tracker file's `id` may diverge from the identifier when the file
    // sets an explicit front-matter `id`. Resolve via a candidate scan so the
    // tracker can find the right file even with that aliasing.
    let issueId: string | null = null;
    try {
      const candidates = await this.tracker.fetchIssuesByStates([input.fromState]);
      const match = candidates.find((c) => c.identifier === input.identifier);
      if (match) issueId = match.id;
    } catch {
      // Fall through to identifier fallback below.
    }
    if (issueId === null) issueId = input.identifier;
    await this.tracker.moveIssueToState(issueId, input.toState, {
      fromState: input.fromState,
      notes: input.notes,
      actor: input.actor,
    });
  }

  /**
   * Implements {@link BaseRefProvider}. Returns the configured base branch
   * name AND its current SHA in the source repo (workflow_dir by default).
   * Returns null when the SHA can't be resolved (no `.git`, base branch
   * missing, etc.) — drift detection skips the pass.
   *
   * Why both fields: the reconciler's drift check compares the workspace's
   * own copy of `<branch>` (frozen at clone time) against this SHA. Returning
   * the branch name keeps the source-of-truth in one place; the inspector
   * uses it to run `git rev-parse <branch>` inside the workspace.
   *
   * `SYMPHONY_BASE_BRANCH` (default `main`) is the same env var the
   * dispatch-time clone honors, so the drift check is comparing against the
   * same ref the workspace was originally cloned from.
   */
  async currentBaseRef(): Promise<{ branch: string; sha: string } | null> {
    const branch =
      process.env.SYMPHONY_BASE_BRANCH && process.env.SYMPHONY_BASE_BRANCH.length > 0
        ? process.env.SYMPHONY_BASE_BRANCH
        : 'main';
    const sourceRepo =
      process.env.SYMPHONY_SOURCE_REPO && process.env.SYMPHONY_SOURCE_REPO.length > 0
        ? process.env.SYMPHONY_SOURCE_REPO
        : this.cfg.workflow_dir;
    const r = await runProcess('git', ['rev-parse', branch], { cwd: sourceRepo });
    if (r.exit_code !== 0) return null;
    const sha = r.stdout.trim();
    return sha.length > 0 ? { branch, sha } : null;
  }

  // Public hooks the runner uses to feed events back.
  reportTokenUsage(issueId: string, usage: { input_tokens: number; output_tokens: number; total_tokens: number }) {
    const e = this.running.get(issueId);
    if (!e) return;
    // §9.4: prefer absolute totals; track deltas to avoid double-counting.
    const dIn = Math.max(0, usage.input_tokens - e.last_reported_input_tokens);
    const dOut = Math.max(0, usage.output_tokens - e.last_reported_output_tokens);
    const dTot = Math.max(0, usage.total_tokens - e.last_reported_total_tokens);
    e.input_tokens = usage.input_tokens;
    e.output_tokens = usage.output_tokens;
    e.total_tokens = usage.total_tokens;
    e.last_reported_input_tokens = usage.input_tokens;
    e.last_reported_output_tokens = usage.output_tokens;
    e.last_reported_total_tokens = usage.total_tokens;
    this.sessionTotals.input_tokens += dIn;
    this.sessionTotals.output_tokens += dOut;
    this.sessionTotals.total_tokens += dTot;
  }

  reportRateLimits(_issueId: string, snapshot: JsonValue) {
    this.rateLimits = snapshot;
  }

  reportRuntimeEvent(issueId: string, ev: RuntimeEvent) {
    const e = this.running.get(issueId);
    if (!e) return;
    e.last_event = ev.event;
    e.last_event_at = ev.at;
    e.last_message = ev.message;
    e.recent_events.push(ev);
    if (e.recent_events.length > 50) e.recent_events.shift();
  }

  reportSessionStarted(issueId: string, info: { sessionId: string; threadId: string; pid: string | null }) {
    const e = this.running.get(issueId);
    if (!e) return;
    e.session_id = info.sessionId;
    e.thread_id = info.threadId;
    e.adapter_pid = info.pid;
  }

  reportTurnStarted(issueId: string, turnNumber: number) {
    const e = this.running.get(issueId);
    if (!e) return;
    e.turn_count = turnNumber;
  }

  /** §9.3 snapshot. */
  snapshot(): Snapshot {
    const generatedAt = new Date().toISOString();
    const liveExtraSeconds = [...this.running.values()]
      .map((e) => (Date.now() - Date.parse(e.started_at)) / 1000)
      .reduce((a, b) => a + b, 0);
    return {
      generated_at: generatedAt,
      counts: { running: this.running.size, retrying: this.retryAttempts.size },
      running: [...this.running.values()].map((e) => ({
        issue_id: e.issue_id,
        issue_identifier: e.identifier,
        issue_title: e.issue.title ?? '',
        issue_body: e.issue.description ?? '',
        state: e.issue.state,
        session_id: e.session_id,
        turn_count: e.turn_count,
        last_event: e.last_event,
        last_message: e.last_message,
        started_at: e.started_at,
        last_event_at: e.last_event_at,
        tokens: {
          input_tokens: e.input_tokens,
          output_tokens: e.output_tokens,
          total_tokens: e.total_tokens,
        },
        steering_requested: e.steering_requested,
        steering_question: e.steering_question,
        steering_context: e.steering_context,
        transitioned: e.transitioned,
      })),
      retrying: [...this.retryAttempts.values()].map((r) => ({
        issue_id: r.issue_id,
        issue_identifier: r.identifier,
        attempt: r.attempt,
        due_at: new Date(r.due_at_ms).toISOString(),
        error: r.error,
      })),
      session_totals: {
        ...this.sessionTotals,
        seconds_running: this.sessionTotals.seconds_running + liveExtraSeconds,
      },
      rate_limits: this.rateLimits,
      memory_admission: this.computeAdmission(),
      reconciler: this.buildReconcilerSnapshot(),
    };
  }

  /**
   * Combine the reconciler's resource snapshot with the most recent action
   * results so the dashboard sees both surfaces under one `reconciler.resources`
   * list. When neither side has anything to report (no reconciler wired AND no
   * actions ever ran), the field is null to preserve the existing test
   * harness's "no reconciler" shape.
   */
  private buildReconcilerSnapshot(): ReconcilerSnapshot | null {
    const base = this.reconciler ? this.reconciler.snapshot() : null;
    if (!base && this.lastActionResults.size === 0) return null;
    const resources = base ? [...base.resources] : [];
    for (const snap of this.lastActionResults.values()) resources.push(snap);
    return { resources };
  }

  /** Issue-detail view used by the HTTP /api/v1/<identifier> endpoint. */
  detailByIdentifier(identifier: string): unknown | null {
    const entry = this.findRunningByIdentifier(identifier);
    const retry = this.findRetryByIdentifier(identifier);
    return buildIssueDetailDto(
      identifier,
      entry
        ? {
            issue_id: entry.issue_id,
            identifier: entry.identifier,
            workspace_path: entry.workspace_path,
            session_id: entry.session_id,
            turn_count: entry.turn_count,
            state: entry.issue.state,
            started_at: entry.started_at,
            last_event: entry.last_event,
            last_message: entry.last_message,
            last_event_at: entry.last_event_at,
            input_tokens: entry.input_tokens,
            output_tokens: entry.output_tokens,
            total_tokens: entry.total_tokens,
            recent_events: entry.recent_events,
            last_error: entry.last_error,
          }
        : null,
      retry
        ? {
            issue_id: retry.issue_id,
            identifier: retry.identifier,
            attempt: retry.attempt,
            due_at_ms: retry.due_at_ms,
            error: retry.error,
          }
        : null,
    );
  }

  private findRunningByIdentifier(identifier: string): RunningEntry | null {
    for (const e of this.running.values()) if (e.identifier === identifier) return e;
    return null;
  }

  private findRetryByIdentifier(identifier: string): RetryEntry | null {
    for (const r of this.retryAttempts.values()) if (r.identifier === identifier) return r;
    return null;
  }
}
