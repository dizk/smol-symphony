// Pure decisions extracted from `src/orchestrator.ts` (issue 75). Mirrors
// `src/agent/runner-decisions.ts`: every helper takes a snapshot of shell
// state and returns the next decision so the orchestrator stays thin wiring
// and each branch can be unit tested without spinning up a tracker, runner,
// or reconciler. Deterministic and side-effect free.

import type {
  Issue,
  RetryEntry,
  RetryKind,
  RunningEntry,
  ServiceConfig,
  StateConfig,
} from './types.js';
import type { PrIntent } from './reconciler/pr.js';
import { activeStateNames, terminalStateNames } from './issues.js';

export type ReconcileAction =
  | { kind: 'terminate'; cleanup: boolean; reason: string }
  | { kind: 'refresh' }
  | { kind: 'none' };

/**
 * Per-running-issue reconcile decision based on the freshly-fetched tracker
 * view. Missing rows → terminate without cleanup; terminal-role state →
 * terminate with cleanup driven by `role`; active-role state → refresh the
 * in-memory issue snapshot; anything else (holding, unknown) → terminate
 * without cleanup. Routing cleanup through `role` lets a future per-state
 * `cleanup_workspace` flag flip without touching the orchestrator again.
 */
export function decideReconcileForIssue(
  fresh: Issue | undefined,
  states: Record<string, StateConfig>,
): ReconcileAction {
  if (!fresh) return { kind: 'terminate', cleanup: false, reason: 'tracker_state_missing' };
  const s = fresh.state.toLowerCase();
  const terminal = new Set(terminalStateNames(states).map((n) => n.toLowerCase()));
  if (terminal.has(s)) {
    const canonical = Object.keys(states).find((n) => n.toLowerCase() === s);
    const cleanup = canonical ? states[canonical]!.role === 'terminal' : false;
    return { kind: 'terminate', cleanup, reason: 'tracker_state_terminal' };
  }
  const active = new Set(activeStateNames(states).map((n) => n.toLowerCase()));
  if (active.has(s)) return { kind: 'refresh' };
  return { kind: 'terminate', cleanup: false, reason: 'tracker_state_non_active' };
}

export interface EligibilitySnapshot {
  active: ReadonlySet<string>;
  terminal: ReadonlySet<string>;
  running: ReadonlySet<string>;
  claimed: ReadonlySet<string>;
  perStateSlot: (state: string) => boolean;
}

/**
 * Returns null when the issue is eligible to dispatch, otherwise a short
 * reason string. `ignoreOwnClaim` is set by the retry path so an issue's
 * own claim does not block its redispatch.
 */
export function computeEligibilityReason(
  issue: Issue,
  ignoreOwnClaim: boolean,
  snap: EligibilitySnapshot,
): string | null {
  if (!issue.id || !issue.identifier || !issue.title || !issue.state) {
    return 'missing required issue fields';
  }
  const state = issue.state.toLowerCase();
  if (!snap.active.has(state) || snap.terminal.has(state)) return 'state not active';
  if (snap.running.has(issue.id)) return 'already running';
  if (!ignoreOwnClaim && snap.claimed.has(issue.id)) return 'already claimed';
  if (!snap.perStateSlot(issue.state)) return 'no per-state slot';
  if (state === 'todo' && hasNonTerminalBlocker(issue, snap.terminal)) {
    return 'has non-terminal blocker';
  }
  return null;
}

export function hasNonTerminalBlocker(issue: Issue, terminal: ReadonlySet<string>): boolean {
  for (const b of issue.blocked_by) {
    if (!b.state) return true;
    if (!terminal.has(b.state.toLowerCase())) return true;
  }
  return false;
}

/**
 * Resolved actor string (`"<adapter>/<model or 'default'>"`) for the
 * dispatch-time RunningEntry. Returns null when state resolution would throw
 * (state not declared in workflow) so the shell can fall back to workflow
 * defaults instead of carrying the try/catch.
 */
export function resolveActorString(
  states: Record<string, StateConfig>,
  workflowAdapter: string,
  workflowModel: string | null | undefined,
  state: string,
): string {
  const key = canonicalStateKey(states, state);
  if (key === null) return `${workflowAdapter}/${workflowModel ?? 'default'}`;
  const s = states[key]!;
  const adapter = s.adapter ?? workflowAdapter;
  const model = s.model === undefined ? workflowModel : s.model;
  return `${adapter}/${model ?? 'default'}`;
}

function canonicalStateKey(states: Record<string, StateConfig>, state: string): string | null {
  if (Object.prototype.hasOwnProperty.call(states, state)) return state;
  const lower = state.toLowerCase();
  for (const name of Object.keys(states)) if (name.toLowerCase() === lower) return name;
  return null;
}

export interface RetrySchedulePlan {
  attempt: number;
  delayMs: number;
  error: string | null;
  kind: RetryKind;
  target_state: string;
}

/**
 * Retry schedule for a worker that just exited. Normal exits become
 * `continuation` (1s, slot-holding); abnormal exits become `failure` with
 * exponential backoff capped at `maxBackoffMs`. `target_state` is whatever
 * state the running entry was carrying at exit time (the post-transition
 * state for a clean exit, otherwise unchanged).
 */
export function decideExitRetry(input: {
  normal: boolean;
  reason: string;
  priorAttempt: number | null | undefined;
  targetState: string;
  continuationDelayMs: number;
  failureBaseMs: number;
  maxBackoffMs: number;
}): RetrySchedulePlan {
  if (input.normal) {
    return {
      attempt: 1,
      delayMs: input.continuationDelayMs,
      error: null,
      kind: 'continuation',
      target_state: input.targetState,
    };
  }
  const nextAttempt =
    input.priorAttempt !== null && input.priorAttempt !== undefined ? input.priorAttempt + 1 : 1;
  return {
    attempt: nextAttempt,
    delayMs: Math.min(input.failureBaseMs * Math.pow(2, nextAttempt - 1), input.maxBackoffMs),
    error: input.reason,
    kind: 'failure',
    target_state: input.targetState,
  };
}

/**
 * Retry-timer response when a re-polled issue is found ineligible. A
 * `no per-state slot` reason yields a failure-backoff reschedule (the loop
 * can dispatch other work during the wait); any other ineligibility releases
 * the claim. Mirrors the inline switch the orchestrator used to carry.
 */
export function decideRetryAfterIneligible(input: {
  reason: string;
  priorAttempt: number;
  targetState: string;
  failureBaseMs: number;
  maxBackoffMs: number;
}): { kind: 'release' } | { kind: 'reschedule'; plan: RetrySchedulePlan } {
  if (input.reason !== 'no per-state slot') return { kind: 'release' };
  return {
    kind: 'reschedule',
    plan: {
      attempt: input.priorAttempt + 1,
      delayMs: Math.min(
        input.failureBaseMs * Math.pow(2, input.priorAttempt),
        input.maxBackoffMs,
      ),
      error: 'no available orchestrator slots',
      kind: 'failure',
      target_state: input.targetState,
    },
  };
}

// ---------------------------------------------------------------------------
// Circuit breaker (issue 128). The retry path retries an abnormally-exited
// dispatch with exponential backoff and NO upper bound on identical failures:
// a deterministically-failing dispatch (e.g. a persistent `401
// invalid_api_key`) loops indefinitely, booting + reaping a VM every backoff
// interval. These pure helpers let the orchestrator bound that loop — count
// consecutive same-reason failures and decide when to stop retrying — without
// the streak bookkeeping leaking into the shell.

/**
 * Normalize a failure `reason` so two attempts that failed *the same way*
 * compare equal even when the message embeds volatile tokens (request ids,
 * status codes, timestamps, hashes, per-dispatch sentinels). Without this, a
 * reason carrying a varying id would never repeat verbatim and the breaker
 * would never trip.
 *
 * Rule: lowercase, then collapse every whitespace-delimited token that
 * contains a digit into `<id>` — volatile identifiers almost always carry a
 * digit (a request id, an HTTP status, a timestamp fragment, a counter, a hex
 * hash), whereas the human-readable words that carry a failure's *identity*
 * (`agent turn refusal`, `smolvm bring-up error`, `invalid_api_key`) do not.
 *
 * The collapse is deliberately one-way and aggressive (a `401` and a `403`
 * both become `<id>`): for a breaker keyed on "same failure every attempt",
 * merging near-identical persistent errors is the safe direction — the
 * alternative (never tripping because an embedded id varies) is the regression
 * this closes. Genuinely different failure *classes* keep distinct words and
 * so reset the streak rather than accumulating toward a trip.
 */
export function normalizeFailureReason(reason: string): string {
  return reason
    .toLowerCase()
    .replace(/\S*\d\S*/g, '<id>')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Per-issue circuit-breaker streak: the last failure's normalized reason and
 * how many consecutive attempts have failed with it. Held in orchestrator
 * memory across the dispatch→exit→retry cycle.
 */
export interface CircuitBreakerState {
  normalizedReason: string;
  count: number;
}

export type CircuitBreakerDecision =
  // Clean exit (or breaker irrelevant): clear any streak; keep the normal path.
  | { kind: 'reset' }
  // Abnormal exit recorded; under threshold — keep retrying. Caller persists
  // the returned state.
  | { kind: 'continue'; normalizedReason: string; count: number }
  // Threshold reached on identical consecutive failures — stop retrying and
  // route the issue to a holding state.
  | { kind: 'trip'; normalizedReason: string; count: number };

/**
 * Fold one worker exit into the circuit-breaker streak. A clean exit (`normal`)
 * resets it — the issue made progress. An abnormal exit increments the streak
 * when its normalized reason matches the prior one, otherwise restarts the
 * count at 1. When `threshold > 0` and the streak reaches it, the breaker
 * trips. `threshold <= 0` disables tripping entirely (the streak is still
 * tracked but never trips), so an operator can turn the breaker off.
 */
export function decideCircuitBreaker(input: {
  normal: boolean;
  reason: string;
  prior: CircuitBreakerState | null;
  threshold: number;
}): CircuitBreakerDecision {
  if (input.normal) return { kind: 'reset' };
  const normalizedReason = normalizeFailureReason(input.reason);
  const count =
    input.prior && input.prior.normalizedReason === normalizedReason ? input.prior.count + 1 : 1;
  if (input.threshold > 0 && count >= input.threshold) {
    return { kind: 'trip', normalizedReason, count };
  }
  return { kind: 'continue', normalizedReason, count };
}

// ---------------------------------------------------------------------------
// Sleep-cycle auto-arm (issue 125, follow-up to 122). The orchestrator moves
// the recurring reflection issue from its dormant (holding) state into the
// active reflect state when work has finished and either trigger fires. These
// pure helpers own the trigger decision and the arm-note text so the shell
// stays a thin "fetch the issue, move it, reset the counter" wrapper.

/** Which trigger armed the reflection cycle (or null when none fires). */
export type SleepCycleTrigger = 'idle' | 'done_threshold';

export interface SleepCycleArmInput {
  /** Whether the sleep-cycle block is enabled at all. */
  enabled: boolean;
  /** The reflection issue's id/identifier; null disables arming. */
  issueId: string | null;
  /** Arm when the orchestrator is idle (and work finished since last run). */
  armOnIdle: boolean;
  /** Arm after this many terminal transitions since last run (0 = disabled). */
  armAfterDone: number;
  /** Terminal-state transitions counted since the reflection issue was last armed. */
  doneSinceReflect: number;
  /** True when nothing is running/claimed/pending and no active candidate this poll. */
  idle: boolean;
}

/**
 * Decide whether to arm the reflection cycle this tick, and on which trigger.
 *
 * The done-threshold trigger takes precedence over idle when both hold (it's
 * the stronger, count-based signal — handy for the operator-visible log line).
 *
 * The idle trigger is deliberately gated on `doneSinceReflect > 0`: an idle
 * orchestrator with nothing finished since the last run has nothing new to
 * reflect on, and arming anyway would spin (arm → reflect → dormant → idle →
 * arm …) forever. Requiring fresh terminal work breaks that loop while still
 * honoring the "sleep when not busy" framing — reflection runs during downtime,
 * but only when there is new material to mine.
 *
 * Returns null when the block is disabled, has no issue id, or no trigger fires.
 */
export function decideSleepCycleArm(input: SleepCycleArmInput): SleepCycleTrigger | null {
  if (!input.enabled || !input.issueId) return null;
  if (input.armAfterDone > 0 && input.doneSinceReflect >= input.armAfterDone) {
    return 'done_threshold';
  }
  if (input.armOnIdle && input.idle && input.doneSinceReflect > 0) return 'idle';
  return null;
}

/**
 * The notes block appended to the reflection issue's body when the orchestrator
 * auto-arms it. Rendered into `issue.description` for the reflector's next
 * dispatch, so it doubles as a reminder of the guardrail: auto-arming only moves
 * the issue into Reflect — the proposals it files still land in Triage behind
 * the human approve/discard gate.
 */
export function sleepCycleArmNotes(
  trigger: SleepCycleTrigger,
  doneSinceReflect: number,
  armAfterDone: number,
): string {
  const why =
    trigger === 'done_threshold'
      ? `**${doneSinceReflect}** issues reached a terminal state since the last reflection run (threshold: ${armAfterDone}).`
      : `the orchestrator went idle with **${doneSinceReflect}** issue(s) finished since the last reflection run.`;
  return [
    '**Auto-armed by the sleep cycle** (issue 125).',
    '',
    `Trigger: ${trigger} — ${why}`,
    '',
    'This move only arms reflection. The proposals you file still land in Triage and still require human approve/discard — auto-arming does not bypass that gate.',
  ].join('\n');
}

/**
 * Classify a tracker issue into a PR autopilot intent or `null` (state
 * matches neither the configured merge nor close state). The shell supplies
 * `mergeWorkspacePath` because workspace pathing is an adapter concern;
 * close intents drop it (workspace is owned by terminal cleanup).
 */
export function classifyPrIntent(input: {
  issue: Pick<Issue, 'identifier' | 'state' | 'branch_name'>;
  mergeState: string;
  closeState: string | null;
  baseBranch: string;
  mergeWorkspacePath: string;
}): PrIntent | null {
  const stateLower = input.issue.state.toLowerCase();
  const isMerge = stateLower === input.mergeState.toLowerCase();
  const isClose = input.closeState !== null && stateLower === input.closeState.toLowerCase();
  if (!isMerge && !isClose) return null;
  const branch =
    input.issue.branch_name && input.issue.branch_name.length > 0
      ? input.issue.branch_name
      : `agent/${input.issue.identifier}`;
  return {
    identifier: input.issue.identifier,
    kind: isMerge ? 'merge' : 'close',
    state: input.issue.state,
    workspace_path: isMerge ? input.mergeWorkspacePath : null,
    branch,
    base_branch: input.baseBranch,
  };
}

/**
 * Distinct adapter ids whose host credential must be readable at startup —
 * the workflow-level default plus any per-state override. Lookup of "known"
 * is supplied by the shell (the registry of valid adapter ids lives in
 * `agent/adapters.ts`); the helper just unions and dedupes.
 */
export function requiredAdapterIds(
  cfg: ServiceConfig,
  isKnown: (id: string) => boolean,
): Set<string> {
  const out = new Set<string>();
  if (isKnown(cfg.acp.adapter)) out.add(cfg.acp.adapter);
  for (const s of Object.values(cfg.states)) {
    if (s.adapter && isKnown(s.adapter)) out.add(s.adapter);
  }
  return out;
}

export interface IssueDetailEntryView {
  issue_id: string;
  identifier: string;
  workspace_path: string;
  session_id: string | null;
  turn_count: number;
  state: string;
  started_at: string;
  last_event: string | null;
  last_message: string | null;
  last_event_at: string | null;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  recent_events: RunningEntry['recent_events'];
  last_error: string | null;
}

export interface IssueDetailRetryView {
  issue_id: string;
  identifier: string;
  attempt: number;
  due_at_ms: number;
  error: string | null;
}

/**
 * Build the issue-detail DTO served by `GET /api/v1/<identifier>`. Pure
 * with respect to the views supplied by the shell (`findRunningByIdentifier`
 * and `findRetryByIdentifier` do the impure scans). Returns null when
 * neither a running nor a retrying entry matches.
 */
export function buildIssueDetailDto(
  identifier: string,
  entry: IssueDetailEntryView | null,
  retry: IssueDetailRetryView | null,
): unknown | null {
  if (!entry && !retry) return null;
  return {
    issue_identifier: identifier,
    issue_id: entry?.issue_id ?? retry?.issue_id ?? null,
    status: entry ? 'running' : 'retrying',
    workspace: entry ? { path: entry.workspace_path } : null,
    attempts: { current_retry_attempt: retry?.attempt ?? null },
    running: entry ? buildIssueDetailRunningSection(entry) : null,
    retry: retry ? buildIssueDetailRetrySection(retry) : null,
    recent_events: entry?.recent_events ?? [],
    last_error: entry?.last_error ?? retry?.error ?? null,
    tracked: {},
  };
}

function buildIssueDetailRunningSection(entry: IssueDetailEntryView): unknown {
  return {
    session_id: entry.session_id,
    turn_count: entry.turn_count,
    state: entry.state,
    started_at: entry.started_at,
    last_event: entry.last_event,
    last_message: entry.last_message,
    last_event_at: entry.last_event_at,
    tokens: {
      input_tokens: entry.input_tokens,
      output_tokens: entry.output_tokens,
      total_tokens: entry.total_tokens,
    },
  };
}

function buildIssueDetailRetrySection(retry: IssueDetailRetryView): unknown {
  return {
    attempt: retry.attempt,
    due_at: new Date(retry.due_at_ms).toISOString(),
    error: retry.error,
  };
}

export type { RetryEntry, RunningEntry };
