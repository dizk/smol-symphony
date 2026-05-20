// Orchestrator (SPEC §7, §8, §14, §16). Owns the single-authority runtime state and
// drives the poll-and-dispatch tick, retries, reconciliation, and worker exit handling.

import type {
  Issue,
  RetryEntry,
  RunningEntry,
  RuntimeEvent,
  ServiceConfig,
  CodexTotals,
  WorkflowDefinition,
} from './types.js';
import type { IssueTracker } from './trackers/types.js';
import type { WorkflowSource } from './workflow.js';
import { validateDispatch, WorkflowError } from './workflow.js';
import type { AgentRunner } from './agent/runner.js';
import { ADAPTERS, assertHostCredentialReadable, isKnownAdapter, type AcpAdapterId } from './agent/adapters.js';
import { pickTerminalTarget } from './mcp.js';

// ACP rate-limit signals are out of band today; this is kept as a generic value type so the
// snapshot endpoint can attach whatever shape a future ACP `_meta` extension produces.
type JsonValue = unknown;
import type { WorkspaceManager, HookCapture, HookResult } from './workspace.js';
import { withIssue, log } from './logging.js';
import { openRunLog, type RunLog } from './runlog.js';

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
    marked_done: boolean;
  }>;
  retrying: Array<{
    issue_id: string;
    issue_identifier: string;
    attempt: number;
    due_at: string;
    error: string | null;
  }>;
  codex_totals: CodexTotals;
  rate_limits: JsonValue | null;
}

interface RetrySchedule {
  identifier: string;
  attempt: number;
  delayMs: number;
  error: string | null;
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
  private codexTotals: CodexTotals = {
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    seconds_running: 0,
  };
  private codexRateLimits: JsonValue | null = null;
  private tickTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private refreshRequested = false;
  // Latest dispatch validation error, if any (operator-visible).
  private lastValidationError: string | null = null;

  // Optional callback used to propagate reloaded config to components that hold their own
  // tracker/runner/workspace state (so prompt body, hooks, smolvm config, etc., take effect
  // on the next dispatch — see §6.2).
  private onConfigReloaded?: (cfg: ServiceConfig, workflow: WorkflowDefinition) => void;

  constructor(
    private cfg: ServiceConfig,
    private workflowDef: WorkflowDefinition,
    private workflowSrc: WorkflowSource,
    private tracker: IssueTracker,
    private workspaces: WorkspaceManager,
    private runner: AgentRunner,
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
    // Fail fast when symphony will auto-stage credentials but the host file the
    // adapter needs is missing. Operators who set acp.command explicitly own their
    // own credential plumbing, so skip the check in that branch.
    if (this.cfg.acp.command === null && isKnownAdapter(this.cfg.acp.adapter)) {
      const profile = ADAPTERS[this.cfg.acp.adapter as AcpAdapterId];
      try {
        await assertHostCredentialReadable(profile);
      } catch (err) {
        log.error('startup credential check failed', { error: (err as Error).message });
        throw new WorkflowError('missing_host_credential', (err as Error).message);
      }
    }
    await this.startupTerminalCleanup();
    this.scheduleTick(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.tickTimer) {
      clearTimeout(this.tickTimer);
      this.tickTimer = null;
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
    let snapshotTerminalTarget: string;
    try {
      // Atomic fetch: the tracker returns the issues AND the root/terminal_states
      // it used during the scan. That's the snapshot we pin onto each RunningEntry,
      // so a workflow reload that races the dispatch loop can't cause `mark_done`
      // to operate against a different tracker config than where the issue lives.
      const result = await this.tracker.fetchCandidateIssues();
      candidates = result.issues;
      snapshotTrackerRoot = result.root;
      snapshotTerminalTarget = pickTerminalTarget(result.terminalStates);
    } catch (err) {
      log.warn('candidate fetch failed', { error: (err as Error).message });
      this.scheduleTick(this.cfg.polling.interval_ms);
      return;
    }
    const sorted = this.sortForDispatch(candidates);
    for (const issue of sorted) {
      if (this.availableGlobalSlots() <= 0) break;
      if (!this.isEligible(issue)) continue;
      void this.dispatchIssue(issue, null, {
        trackerRoot: snapshotTrackerRoot,
        terminalTarget: snapshotTerminalTarget,
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
        const ref = entry.last_codex_timestamp ?? entry.started_at;
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
    const terminal = new Set(this.cfg.tracker.terminal_states.map((s) => s.toLowerCase()));
    const active = new Set(this.cfg.tracker.active_states.map((s) => s.toLowerCase()));
    for (const id of ids) {
      const fresh = byId.get(id);
      if (!fresh) {
        // Missing from tracker — non-active, no cleanup (§8.5 part B "neither" branch).
        this.terminateRunning(id, false, 'tracker_state_missing');
        continue;
      }
      const s = fresh.state.toLowerCase();
      if (terminal.has(s)) {
        this.terminateRunning(id, true, 'tracker_state_terminal');
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
    const active = new Set(this.cfg.tracker.active_states.map((s) => s.toLowerCase()));
    const terminal = new Set(this.cfg.tracker.terminal_states.map((s) => s.toLowerCase()));
    if (!active.has(state) || terminal.has(state)) return 'state not active';
    if (this.running.has(issue.id)) return 'already running';
    if (!ignoreOwnClaim && this.claimed.has(issue.id)) return 'already claimed';
    if (!this.hasPerStateSlot(issue.state)) return 'no per-state slot';
    if (state === 'todo' && this.hasNonTerminalBlocker(issue)) return 'has non-terminal blocker';
    return null;
  }

  private hasNonTerminalBlocker(issue: Issue): boolean {
    const terminal = new Set(this.cfg.tracker.terminal_states.map((s) => s.toLowerCase()));
    for (const b of issue.blocked_by) {
      if (!b.state) return true;
      if (!terminal.has(b.state.toLowerCase())) return true;
    }
    return false;
  }

  private availableGlobalSlots(): number {
    return Math.max(0, this.cfg.agent.max_concurrent_agents - this.running.size);
  }

  /** §8.3: per-state slot accounting using current running entries. */
  private hasPerStateSlot(stateName: string): boolean {
    const cap = this.cfg.agent.max_concurrent_agents_by_state[stateName.toLowerCase()];
    if (!cap) return this.availableGlobalSlots() > 0;
    let inState = 0;
    for (const e of this.running.values()) {
      if (e.issue.state.toLowerCase() === stateName.toLowerCase()) inState++;
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
    snapshot?: { trackerRoot: string | null; terminalTarget: string },
  ): Promise<void> {
    if (this.running.has(issue.id)) return;
    this.claimed.add(issue.id);
    this.retryAttempts.delete(issue.id);
    const cancel = { cancelled: false };
    const startedAt = new Date().toISOString();
    const workspacePath = this.workspaces.workspacePathFor(issue.identifier);
    // Snapshot tracker.root and the terminal target BEFORE workspace setup,
    // before_run, or smolvm bring-up. A WORKFLOW.md reload during that window
    // (or even between fetchCandidateIssues returning and this iteration of
    // the dispatch loop) can mutate the live tracker config; pinning here closes
    // that window. When the caller supplies a snapshot (the tick/retry path
    // does — it captured at the fetch atomically), prefer those values; the
    // optional fallback reads the live config for completeness.
    const trackerRootAtDispatch =
      snapshot?.trackerRoot ?? (this.tracker.currentRoot ? this.tracker.currentRoot() : null);
    const terminalTargetAtDispatch =
      snapshot?.terminalTarget ?? pickTerminalTarget(this.cfg.tracker.terminal_states);
    const entry: RunningEntry = {
      issue_id: issue.id,
      identifier: issue.identifier,
      issue,
      session_id: null,
      thread_id: null,
      turn_id: null,
      codex_app_server_pid: null,
      last_codex_event: null,
      last_codex_timestamp: null,
      last_codex_message: null,
      codex_input_tokens: 0,
      codex_output_tokens: 0,
      codex_total_tokens: 0,
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
      terminal_target_at_dispatch: terminalTargetAtDispatch,
      marked_done: false,
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
        terminal_target: terminalTargetAtDispatch,
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
      this.codexTotals.seconds_running += elapsedMs / 1000;
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
      this.workspaces
        .remove(entry.identifier, this.cfg.hooks, capture)
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
      this.scheduleRetry(issueId, {
        identifier,
        attempt: 1,
        delayMs: CONTINUATION_DELAY_MS,
        error: null,
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
    let snapshotTerminalTarget: string;
    try {
      const result = await this.tracker.fetchCandidateIssues();
      candidates = result.issues;
      snapshotTrackerRoot = result.root;
      snapshotTerminalTarget = pickTerminalTarget(result.terminalStates);
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
        this.scheduleRetry(issueId, {
          identifier: issue.identifier,
          attempt: entry.attempt + 1,
          delayMs: Math.min(
            FAILURE_BASE_MS * Math.pow(2, entry.attempt),
            this.cfg.agent.max_retry_backoff_ms,
          ),
          error: 'no available orchestrator slots',
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
      terminalTarget: snapshotTerminalTarget,
    });
  }

  /** §8.6 startup terminal workspace cleanup. */
  private async startupTerminalCleanup(): Promise<void> {
    try {
      const terminals = await this.tracker.fetchIssuesByStates(this.cfg.tracker.terminal_states);
      for (const issue of terminals) {
        try {
          await this.workspaces.remove(issue.identifier, this.cfg.hooks);
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
    e.codex_input_tokens = usage.input_tokens;
    e.codex_output_tokens = usage.output_tokens;
    e.codex_total_tokens = usage.total_tokens;
    e.last_reported_input_tokens = usage.input_tokens;
    e.last_reported_output_tokens = usage.output_tokens;
    e.last_reported_total_tokens = usage.total_tokens;
    this.codexTotals.input_tokens += dIn;
    this.codexTotals.output_tokens += dOut;
    this.codexTotals.total_tokens += dTot;
  }

  reportRateLimits(_issueId: string, snapshot: JsonValue) {
    this.codexRateLimits = snapshot;
  }

  reportRuntimeEvent(issueId: string, ev: RuntimeEvent) {
    const e = this.running.get(issueId);
    if (!e) return;
    e.last_codex_event = ev.event;
    e.last_codex_timestamp = ev.at;
    e.last_codex_message = ev.message;
    e.recent_events.push(ev);
    if (e.recent_events.length > 50) e.recent_events.shift();
  }

  reportSessionStarted(issueId: string, info: { sessionId: string; threadId: string; pid: string | null }) {
    const e = this.running.get(issueId);
    if (!e) return;
    e.session_id = info.sessionId;
    e.thread_id = info.threadId;
    e.codex_app_server_pid = info.pid;
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
        last_event: e.last_codex_event,
        last_message: e.last_codex_message,
        started_at: e.started_at,
        last_event_at: e.last_codex_timestamp,
        tokens: {
          input_tokens: e.codex_input_tokens,
          output_tokens: e.codex_output_tokens,
          total_tokens: e.codex_total_tokens,
        },
        steering_requested: e.steering_requested,
        steering_question: e.steering_question,
        steering_context: e.steering_context,
        marked_done: e.marked_done,
      })),
      retrying: [...this.retryAttempts.values()].map((r) => ({
        issue_id: r.issue_id,
        issue_identifier: r.identifier,
        attempt: r.attempt,
        due_at: new Date(r.due_at_ms).toISOString(),
        error: r.error,
      })),
      codex_totals: {
        ...this.codexTotals,
        seconds_running: this.codexTotals.seconds_running + liveExtraSeconds,
      },
      rate_limits: this.codexRateLimits,
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
            last_event: entry.last_codex_event,
            last_message: entry.last_codex_message,
            last_event_at: entry.last_codex_timestamp,
            tokens: {
              input_tokens: entry.codex_input_tokens,
              output_tokens: entry.codex_output_tokens,
              total_tokens: entry.codex_total_tokens,
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
