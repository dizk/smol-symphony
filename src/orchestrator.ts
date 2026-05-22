// Orchestrator (SPEC §7, §8, §14, §16). Owns the single-authority runtime state and
// drives the poll-and-dispatch tick, retries, reconciliation, and worker exit handling.

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
import { resolveHooksForState, validateDispatch, WorkflowError } from './workflow.js';
import type { AgentRunner } from './agent/runner.js';
import { ADAPTERS, assertHostCredentialReadable, isKnownAdapter, type AcpAdapterId } from './agent/adapters.js';
import { resolveDispatchConfig } from './agent/runner.js';
import type { SmolvmClient } from './agent/smolvm.js';
import { SYMPHONY_VM_PREFIX } from './agent/smolvm.js';
import { activeStateNames, terminalStateNames } from './issues.js';

// ACP rate-limit signals are out of band today; this is kept as a generic value type so the
// snapshot endpoint can attach whatever shape a future ACP `_meta` extension produces.
type JsonValue = unknown;
import type { WorkspaceManager, HookCapture, HookResult } from './workspace.js';
import { withIssue, log } from './logging.js';
import { openRunLog, type RunLog } from './runlog.js';
import { defaultMemProbe, computeMemoryAdmission, type MemProbe } from './memory.js';
import type { Reconciler, ReconcilerSnapshot } from './reconciler/index.js';

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

export class Orchestrator {
  private running = new Map<string, RunningEntry>();
  private claimed = new Set<string>();
  private retryAttempts = new Map<string, RetryEntry>();
  private completed = new Set<string>();
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
  // on the next dispatch — see §6.2).
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
    // Optional so test stubs that don't exercise VM lifecycle don't have to mint a
    // SmolvmClient. When absent, startup/shutdown VM reaping is skipped (logged once
    // at startup so misconfiguration is visible). Production wiring in bin/symphony.ts
    // always passes one in.
    private smolvm: SmolvmClient | null = null,
    // Memory probe used by the admission cap (issue 27). Defaults to reading
    // /proc/meminfo synchronously; tests inject a stub that returns a controlled
    // mem_available_mib so the clamp behavior is deterministic.
    private memProbe: MemProbe = defaultMemProbe,
    // Reconciler (issue 32) — owns managed external resources (today: the
    // Smolfile-driven bake). Optional so tests that don't exercise reconciliation
    // don't have to construct one; when absent, dispatch is never gated on a
    // bake and `Snapshot.reconciler` is null. Production wiring in bin/symphony.ts
    // always passes one in when `smolvm.smolfile` is configured.
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
    const validation = validateDispatch(this.cfg);
    if (validation) {
      log.error('startup validation failed', { error: validation });
      throw new WorkflowError('workflow_parse_error', validation);
    }
    // Fail fast when symphony will auto-stage credentials but the host file an
    // adapter needs is missing. Per-state overrides can change the adapter for
    // individual states (e.g. Review running on codex while Todo runs on claude),
    // so the set of credentials symphony needs at runtime is the union of
    // `cfg.acp.adapter` and every distinct `states.<name>.adapter`. validateDispatch
    // already rejects unknown adapter ids and re-checks credentials in its own walk,
    // but the orchestrator-startup probe is the operator-visible failure point:
    // surface it the same way for every adapter, not just the workflow-level default.
    const adapters = new Set<AcpAdapterId>();
    if (isKnownAdapter(this.cfg.acp.adapter)) {
      adapters.add(this.cfg.acp.adapter as AcpAdapterId);
    }
    for (const s of Object.values(this.cfg.states)) {
      if (s.adapter && isKnownAdapter(s.adapter)) {
        adapters.add(s.adapter as AcpAdapterId);
      }
    }
    for (const id of adapters) {
      try {
        await assertHostCredentialReadable(ADAPTERS[id]);
      } catch (err) {
        log.error('startup credential check failed', {
          adapter: id,
          error: (err as Error).message,
        });
        throw new WorkflowError('missing_host_credential', (err as Error).message);
      }
    }
    await this.startupTerminalCleanup();
    // Reap any leftover `symphony-*` VMs from a prior process. Without this, a
    // SIGKILL/crash of a previous symphony instance leaves libkrun VMs alive that
    // nothing tracks; over enough restarts they accumulate until the host runs out
    // of RAM (issue 26). Best-effort: failures are logged inside cleanupOrphanVms.
    await this.cleanupOrphanVms('startup');
    // Trigger an initial reconcile pass before dispatching. The pass returns
    // quickly even if a bake is needed — the bake runs on a background task and
    // dispatch is gated until ready() is true. Backstop tick keeps the loop alive
    // for missed signals.
    if (this.reconciler) {
      this.reconciler.start();
      void this.reconciler.reconcile().catch((err) =>
        log.warn('initial reconcile pass failed', { error: (err as Error).message }),
      );
    }
    this.scheduleTick(0);
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
    // Drain every open run log so the JSONL files are flushed before exit.
    const closures: Promise<void>[] = [];
    for (const [issueId, rl] of this.runLogs) {
      rl.system('runlog_closed', { reason: 'orchestrator_stopped' });
      closures.push(rl.close());
      this.runLogs.delete(issueId);
    }
    await Promise.all(closures);
    // The runner's per-attempt cleanup destroys its own VM, but stop() does NOT wait
    // for in-flight workers to unwind before returning — the bin script then exits
    // the process, which kills the smolvm CLI children but NOT the libkrun VMs they
    // launched (those are owned by the smolvm daemon). Without this backstop, every
    // SIGTERM during an active run leaks one VM per running entry, and over enough
    // operator restarts the host OOMs (issue 26). Enumerate by prefix so we also
    // catch VMs that drifted out of `running` (e.g. a worker that already removed
    // itself from `running` but hadn't reached the destroy call yet).
    await this.cleanupOrphanVms('shutdown');
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

  /** Operator trigger for an immediate poll cycle (§13.7 /refresh). */
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
    try {
      await this.reconcile();
    } catch (err) {
      log.warn('reconcile error', { error: (err as Error).message });
    }
    const validation = validateDispatch(this.cfg);
    if (validation) {
      this.lastValidationError = validation;
      log.warn('dispatch validation failed; skipping dispatch', { error: validation });
      this.scheduleTick(this.cfg.polling.interval_ms);
      return;
    }
    this.lastValidationError = null;

    let candidates: Issue[];
    let snapshotTrackerRoot: string | null;
    try {
      // Atomic fetch: the tracker returns the issues AND the root it used during
      // the scan. That's the snapshot we pin onto each RunningEntry, so a workflow
      // reload that races the dispatch loop can't cause `transition` to operate
      // against a different tracker root than where the issue lives.
      const result = await this.tracker.fetchCandidateIssues();
      candidates = result.issues;
      snapshotTrackerRoot = result.root;
    } catch (err) {
      log.warn('candidate fetch failed', { error: (err as Error).message });
      this.scheduleTick(this.cfg.polling.interval_ms);
      return;
    }
    // Reconciler gate (issue 32): refuse to dispatch any issue whose prerequisites
    // haven't converged. v1 only gates on the bake; later stages add VM/workspace
    // lifecycle. When the gate is closed we trigger a reconcile pass (cheap when
    // a bake is already in flight) so the loop self-corrects on the next poll
    // instead of waiting on the slower backstop tick.
    if (this.reconciler && !this.reconciler.dispatchReady()) {
      log.debug('dispatch gated on reconciler', {
        candidate_count: candidates.length,
      });
      void this.reconciler.reconcile().catch((err) =>
        log.debug('gated-reconcile failed', { error: (err as Error).message }),
      );
      this.scheduleTick(this.cfg.polling.interval_ms);
      return;
    }
    const sorted = this.sortForDispatch(candidates);
    for (const issue of sorted) {
      if (this.availableGlobalSlots() <= 0) break;
      if (!this.isEligible(issue)) continue;
      void this.dispatchIssue(issue, null, {
        trackerRoot: snapshotTrackerRoot,
      });
    }
    this.scheduleTick(this.cfg.polling.interval_ms);
  }

  /** §8.5: stall detection + tracker state refresh for running issues. */
  private async reconcile(): Promise<void> {
    // Part A: stall detection.
    if (this.cfg.acp.stall_timeout_ms > 0) {
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
    // Part B: tracker state refresh.
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
    const terminal = new Set(terminalStateNames(this.cfg.states).map((s) => s.toLowerCase()));
    const active = new Set(activeStateNames(this.cfg.states).map((s) => s.toLowerCase()));
    // Look up canonical state config (declaration-cased) so the cleanup decision flows
    // through `role` rather than a hardcoded "terminal => cleanup". Today only terminal
    // roles trigger cleanup, but routing through `role` lets a future per-state
    // `cleanup_workspace` flag override the policy without touching reconcile again.
    const stateMap = this.cfg.states;
    const stateLower = new Map<string, string>();
    for (const name of Object.keys(stateMap)) stateLower.set(name.toLowerCase(), name);
    const cleanupForState = (stateName: string): boolean => {
      const canonical = stateLower.get(stateName.toLowerCase());
      if (!canonical) return false;
      return stateMap[canonical]!.role === 'terminal';
    };
    for (const id of ids) {
      const fresh = byId.get(id);
      if (!fresh) {
        // Missing from tracker — non-active, no cleanup (§8.5 part B "neither" branch).
        this.terminateRunning(id, false, 'tracker_state_missing');
        continue;
      }
      const s = fresh.state.toLowerCase();
      if (terminal.has(s)) {
        this.terminateRunning(id, cleanupForState(fresh.state), 'tracker_state_terminal');
      } else if (active.has(s)) {
        const entry = this.running.get(id);
        if (entry) entry.issue = fresh;
      } else {
        this.terminateRunning(id, false, 'tracker_state_non_active');
      }
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

  /** §8.2 candidate eligibility. */
  private isEligible(issue: Issue): boolean {
    return this.eligibilityReason(issue, /*ignoreOwnClaim*/ false) === null;
  }

  // Returns null when eligible, otherwise a short reason string. The `ignoreOwnClaim`
  // form is used by the retry path so the issue's own claim/retry entry does not block
  // its own redispatch.
  private eligibilityReason(issue: Issue, ignoreOwnClaim: boolean): string | null {
    if (!issue.id || !issue.identifier || !issue.title || !issue.state) {
      return 'missing required issue fields';
    }
    const state = issue.state.toLowerCase();
    const active = new Set(activeStateNames(this.cfg.states).map((s) => s.toLowerCase()));
    const terminal = new Set(terminalStateNames(this.cfg.states).map((s) => s.toLowerCase()));
    if (!active.has(state) || terminal.has(state)) return 'state not active';
    if (this.running.has(issue.id)) return 'already running';
    if (!ignoreOwnClaim && this.claimed.has(issue.id)) return 'already claimed';
    if (!this.hasPerStateSlot(issue.state)) return 'no per-state slot';
    if (state === 'todo' && this.hasNonTerminalBlocker(issue)) return 'has non-terminal blocker';
    return null;
  }

  private hasNonTerminalBlocker(issue: Issue): boolean {
    const terminal = new Set(terminalStateNames(this.cfg.states).map((s) => s.toLowerCase()));
    for (const b of issue.blocked_by) {
      if (!b.state) return true;
      if (!terminal.has(b.state.toLowerCase())) return true;
    }
    return false;
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

  /** §8.3: per-state slot accounting using current running entries. */
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

  /** §8.2 sort: priority ASC (null last), then created_at ASC, then identifier. */
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

  /** §16.4 dispatch_issue */
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
    // Resolve "<adapter>/<model or 'default'>" at dispatch time and pin it on the
    // entry. The MCP transition tool stamps this into the notes-block header the
    // next agent reads in `issue.description`. resolveDispatchConfig already folds
    // any per-state override on top of the workflow defaults; falling back to a
    // workflow-default-only string when no states map is declared (e.g. an older
    // test harness) keeps the field non-null without falsely advertising a
    // per-state binding the orchestrator never saw.
    let resolvedActor: string;
    try {
      const resolved = resolveDispatchConfig(this.cfg, issue.state);
      resolvedActor = `${resolved.adapter}/${resolved.model ?? 'default'}`;
    } catch {
      resolvedActor = `${this.cfg.acp.adapter}/${this.cfg.acp.model ?? 'default'}`;
    }
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
    runLog?.system('attempt_ended', { ok, reason, turns_completed: turnsCompleted });
    this.onWorkerExit(issue.id, ok, reason, entry);
  }

  /** §16.6 on_worker_exit */
  private onWorkerExit(issueId: string, normal: boolean, reason: string, entry: RunningEntry): void {
    this.running.delete(issueId);
    const elapsedMs = Date.now() - Date.parse(entry.started_at);
    if (Number.isFinite(elapsedMs)) {
      this.sessionTotals.seconds_running += elapsedMs / 1000;
    }
    const identifier = entry.identifier;
    const logger = withIssue({ issue_id: issueId, issue_identifier: identifier });

    if (entry.cleanup_workspace_on_exit) {
      // Workspace removal is deferred until the worker has fully unwound (including
      // after_run hook execution) so we never delete the dir while the agent is still
      // inside it. The before_remove hook runs inside `workspaces.remove` and is mirrored
      // into the per-issue run log via the same HookCapture pattern as the in-attempt hooks.
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
      // Resolve before_remove against the issue's terminal state — that's the state the
      // file landed in when `symphony.transition` flipped cleanup_workspace_on_exit, so a
      // terminal-state-specific before_remove (e.g. "merge the PR, then drop the
      // workspace") fires instead of the workflow-level fallback.
      const removalHooks = resolveHooksForState(this.cfg, entry.issue.state);
      this.workspaces
        .remove(entry.identifier, removalHooks, capture)
        .catch((err) =>
          logger.warn('workspace removal failed', { error: (err as Error).message }),
        )
        .finally(() => {
          // Issue is in a terminal state; close the log so the file handle is released.
          // Pass `viaCleanup: true` so the close goes through even though
          // `cleanupInFlight` is still set for this issueId — we clear it right after.
          this.cleanupInFlight.delete(issueId);
          this.closeRunLog(issueId, { reason: 'cleanup_on_exit' }, { viaCleanup: true });
        });
    }

    // §14.2: if the service was stopped while this worker was unwinding, do not schedule
    // a new retry — that would leave a live timer behind even though stop() was called.
    if (this.stopped) {
      this.claimed.delete(issueId);
      // stop() also closes any open run logs; do nothing more here.
      return;
    }

    if (normal) {
      this.completed.add(issueId);
      logger.info('worker exited (normal)', { reason });
      // entry.issue.state has been updated to the post-transition state by
      // McpRegistry.performTransition (if the agent transitioned) and is the
      // state the continuation will dispatch into; if the worker exited
      // without transitioning, the state is unchanged and the continuation
      // is a no-op poll that lands back here on the next tick.
      this.scheduleRetry(issueId, {
        identifier,
        attempt: 1,
        delayMs: CONTINUATION_DELAY_MS,
        error: null,
        kind: 'continuation',
        target_state: entry.issue.state,
      });
    } else {
      const nextAttempt =
        entry.retry_attempt !== null && entry.retry_attempt !== undefined ? entry.retry_attempt + 1 : 1;
      const delayMs = Math.min(
        FAILURE_BASE_MS * Math.pow(2, nextAttempt - 1),
        this.cfg.agent.max_retry_backoff_ms,
      );
      logger.warn('worker exited (abnormal)', { reason, next_attempt: nextAttempt, delay_ms: delayMs });
      this.scheduleRetry(issueId, {
        identifier,
        attempt: nextAttempt,
        delayMs,
        error: reason,
        kind: 'failure',
        target_state: entry.issue.state,
      });
    }
  }

  /** §8.4 retry queue. */
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

  /** §16.6 on_retry_timer */
  private async onRetryTimer(issueId: string): Promise<void> {
    if (this.stopped) return;
    const entry = this.retryAttempts.get(issueId);
    if (!entry) return;
    this.retryAttempts.delete(issueId);
    let candidates: Issue[];
    let snapshotTrackerRoot: string | null;
    try {
      const result = await this.tracker.fetchCandidateIssues();
      candidates = result.issues;
      snapshotTrackerRoot = result.root;
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
      return;
    }
    const issue = candidates.find((i) => i.id === issueId);
    if (!issue) {
      this.claimed.delete(issueId);
      log.info('retry releasing claim (not in candidates)', {
        issue_id: issueId,
        issue_identifier: entry.identifier,
      });
      this.closeRunLog(issueId, { reason: 'claim_released_not_in_candidates' });
      return;
    }
    // Re-apply full candidate eligibility, ignoring this issue's own claim. This catches
    // late-breaking issues like a new non-terminal blocker on a Todo or a state change to
    // an inactive value that slipped past the candidate filter on edge tracker shapes.
    const reason = this.eligibilityReason(issue, true);
    if (reason !== null) {
      if (reason === 'no per-state slot') {
        // Reaching this branch means some other claim has the slot we
        // expected. With the continuation-holds-slot rule above, that
        // happens only when genuine contention is in play (e.g. max=2
        // with two unrelated issues running) — never as a side effect of
        // a tick stealing this issue's own continuation. Re-queue as a
        // failure-shaped backoff; the orchestrator can dispatch other
        // work during the wait.
        this.scheduleRetry(issueId, {
          identifier: issue.identifier,
          attempt: entry.attempt + 1,
          delayMs: Math.min(
            FAILURE_BASE_MS * Math.pow(2, entry.attempt),
            this.cfg.agent.max_retry_backoff_ms,
          ),
          error: 'no available orchestrator slots',
          kind: 'failure',
          target_state: issue.state,
        });
        return;
      }
      // For non-slot reasons (blocker, missing fields, non-active state), the right action
      // is to release the claim rather than spin on it.
      this.claimed.delete(issueId);
      log.info('retry releasing claim (ineligible)', {
        issue_id: issueId,
        issue_identifier: entry.identifier,
        reason,
      });
      this.closeRunLog(issueId, { reason: `claim_released_ineligible:${reason}` });
      return;
    }
    void this.dispatchIssue(issue, entry.attempt, {
      trackerRoot: snapshotTrackerRoot,
    });
  }

  /**
   * Destroy any VM in the smolvm daemon whose name starts with the symphony prefix.
   * Called at start (to reap orphans from a prior process) and at stop (to backstop
   * workers that didn't reach their per-attempt destroy in time).
   *
   * The `symphony-` namespace is owned by the orchestrator; matching VMs are
   * unconditionally destroyed. Smolvm enumeration and per-VM destroy are both
   * best-effort (the underlying client swallows and logs CLI failures); we never
   * fail startup/shutdown on a stuck VM.
   */
  private async cleanupOrphanVms(reason: 'startup' | 'shutdown'): Promise<void> {
    if (!this.smolvm) return;
    let all: string[];
    try {
      all = await this.smolvm.list();
    } catch (err) {
      log.warn('orphan vm enumeration failed', {
        reason,
        error: (err as Error).message,
      });
      return;
    }
    const orphans = all.filter((n) => n.startsWith(SYMPHONY_VM_PREFIX));
    if (orphans.length === 0) return;
    log.info('destroying orphan symphony VMs', { reason, count: orphans.length });
    // Parallel destroy: each VM is independent, and smolvm.destroy already wraps the
    // CLI call in a per-VM timeout so a single stuck VM can't hang the rest.
    await Promise.all(orphans.map((name) => this.smolvm!.destroy(name)));
  }

  /** §8.6 startup terminal workspace cleanup. */
  private async startupTerminalCleanup(): Promise<void> {
    try {
      const terminals = await this.tracker.fetchIssuesByStates(terminalStateNames(this.cfg.states));
      for (const issue of terminals) {
        try {
          // Each terminal state can declare its own before_remove (e.g. push a PR vs.
          // write a patch). Resolve per issue.state so the right one fires.
          const removalHooks = resolveHooksForState(this.cfg, issue.state);
          await this.workspaces.remove(issue.identifier, removalHooks);
        } catch (err) {
          log.warn('terminal cleanup failed for issue', {
            issue_identifier: issue.identifier,
            error: (err as Error).message,
          });
        }
      }
    } catch (err) {
      log.warn('startup terminal cleanup fetch failed', { error: (err as Error).message });
    }
  }

  // Public hooks the runner uses to feed events back.
  reportTokenUsage(issueId: string, usage: { input_tokens: number; output_tokens: number; total_tokens: number }) {
    const e = this.running.get(issueId);
    if (!e) return;
    // §13.5: prefer absolute totals; track deltas to avoid double-counting.
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

  /** §13.3 snapshot. */
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
      reconciler: this.reconciler ? this.reconciler.snapshot() : null,
    };
  }

  /** Issue-detail view used by the HTTP /api/v1/<identifier> endpoint. */
  detailByIdentifier(identifier: string): unknown | null {
    let entry: RunningEntry | null = null;
    for (const e of this.running.values()) {
      if (e.identifier === identifier) {
        entry = e;
        break;
      }
    }
    let retry: RetryEntry | null = null;
    for (const r of this.retryAttempts.values()) {
      if (r.identifier === identifier) {
        retry = r;
        break;
      }
    }
    if (!entry && !retry) return null;
    return {
      issue_identifier: identifier,
      issue_id: entry?.issue_id ?? retry?.issue_id ?? null,
      status: entry ? 'running' : 'retrying',
      workspace: entry ? { path: entry.workspace_path } : null,
      attempts: {
        current_retry_attempt: retry?.attempt ?? null,
      },
      running: entry
        ? {
            session_id: entry.session_id,
            turn_count: entry.turn_count,
            state: entry.issue.state,
            started_at: entry.started_at,
            last_event: entry.last_event,
            last_message: entry.last_message,
            last_event_at: entry.last_event_at,
            tokens: {
              input_tokens: entry.input_tokens,
              output_tokens: entry.output_tokens,
              total_tokens: entry.total_tokens,
            },
          }
        : null,
      retry: retry
        ? {
            attempt: retry.attempt,
            due_at: new Date(retry.due_at_ms).toISOString(),
            error: retry.error,
          }
        : null,
      recent_events: entry?.recent_events ?? [],
      last_error: entry?.last_error ?? retry?.error ?? null,
      tracked: {},
    };
  }
}
