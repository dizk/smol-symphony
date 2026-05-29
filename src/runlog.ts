// Per-issue JSONL run log. Captures everything crossing the host/VM boundary plus host-side
// hook output, so a later evaluation pass (likely another in-VM agent) can replay a run end
// to end. One file per issue, appended forever; each entry is a self-describing JSON object.
//
// Schema (one of):
//   { ts, issue_id, attempt, channel: "acp", direction: "host_to_vm"|"vm_to_host", frame: <parsed JSON-RPC> }
//   { ts, issue_id, attempt, channel: "acp", direction: ..., kind: "unparseable", raw: <string> }
//   { ts, issue_id, attempt, channel: "stderr", text }
//   { ts, issue_id, attempt, channel: "system", event, fields? }
//   { ts, issue_id, attempt, channel: "hook", hook, stream: "stdout"|"stderr", text }
//   { ts, issue_id, attempt, channel: "hook", hook, kind: "result", exit_code, signal, timed_out }
//
// Writes are best-effort: a write failure is swallowed so it can never crash the orchestrator
// (consistent with logging.ts §9.2). Streams are opened in append mode so concurrent symphony
// processes or restarts append safely to the same file.

import { createWriteStream, mkdirSync, writeFileSync, type WriteStream } from 'node:fs';
import path from 'node:path';
import { sanitizeWorkspaceKey } from './util/workspace-key.js';
import { log } from './logging.js';

export type RunLogChannel = 'acp' | 'stderr' | 'system' | 'hook';

export interface RunLogBaseEntry {
  channel: RunLogChannel;
  [key: string]: unknown;
}

export class RunLog {
  private stream: WriteStream;
  private currentAttempt = 0;
  // Once a stream error fires we stop trying to write. The first error is logged at warn;
  // subsequent attempts are silently dropped (prevents log spam if disk is full).
  private broken = false;
  // In-memory accumulator of the low-frequency LIFECYCLE events only (system events plus
  // the Done-state `actions:` stdout, where the PR URL surfaces). The high-frequency ACP
  // frame / stderr stream is NOT accumulated — it stays on disk. `writeSummary` reduces
  // this list into a compact per-issue `*.summary.json` for the reflector (issue 123), so
  // a reflection turn never has to re-parse the multi-MB raw frame log. Bounded by the two
  // caps below so a pathological issue can't grow the host's memory without limit.
  private lifecycle: RunLogEntry[] = [];
  private actionsStdout = '';
  private static readonly LIFECYCLE_CAP = 4000;
  private static readonly ACTIONS_STDOUT_CAP = 65_536;

  /**
   * `issueId` is the tracker's primary key (e.g. the local tracker's front-matter `id`)
   * and is what each JSONL line is stamped with. `identifier` is the filename-safe display
   * id (e.g. `ABC-123`) and is only used to derive the file path. The two coincide for
   * local trackers today but MUST be kept separate so downstream evaluators can correlate
   * by tracker id even on trackers where the values diverge.
   */
  constructor(
    private readonly filePath: string,
    private readonly issueId: string,
    private readonly identifier: string,
  ) {
    this.stream = createWriteStream(filePath, { flags: 'a', encoding: 'utf8' });
    this.stream.on('error', (err) => {
      if (!this.broken) {
        this.broken = true;
        log.warn('runlog write failed', {
          issue_id: this.issueId,
          issue_identifier: this.identifier,
          error: err.message,
        });
      }
    });
  }

  setAttempt(n: number): void {
    this.currentAttempt = n;
  }

  attempt(): number {
    return this.currentAttempt;
  }

  /**
   * Append one entry. `ts`, `issue_id`, `issue_identifier`, and `attempt` are stamped
   * automatically and override any same-named field on the entry, so callers cannot
   * accidentally backdate or mislabel lines. Returns nothing — writes are best-effort.
   *
   * The spread order below intentionally puts the auto-stamped fields AFTER the caller's
   * entry so they win over any same-named keys the caller (often passing arbitrary fields
   * for ad-hoc events) accidentally supplied. Reversing this would silently corrupt the
   * canonical correlation identifiers downstream evaluation depends on.
   */
  record(entry: RunLogBaseEntry): void {
    if (this.broken) return;
    const stamped = {
      ...entry,
      ts: new Date().toISOString(),
      issue_id: this.issueId,
      issue_identifier: this.identifier,
      attempt: this.currentAttempt,
    };
    this.captureLifecycle(stamped as RunLogEntry);
    let line: string;
    try {
      line = JSON.stringify(stamped);
    } catch (err) {
      log.warn('runlog serialize failed', { issue_id: this.issueId, error: (err as Error).message });
      return;
    }
    try {
      this.stream.write(line + '\n');
    } catch {
      // Stream errors land in the 'error' handler. A synchronous throw here is unusual but
      // not impossible (e.g. if the stream is in an invalid state); silence it.
    }
  }

  /** Convenience: emit a `channel: "system"` event. */
  system(event: string, fields?: Record<string, unknown>): void {
    this.record({ channel: 'system', event, ...(fields ? { fields } : {}) });
  }

  /**
   * Fold a just-stamped entry into the in-memory lifecycle accumulator that
   * `writeSummary` reduces over. Keeps only the cheap, low-frequency signals:
   * every `system` event, plus the Done-state `actions:` stdout (where
   * `gh pr create` prints the PR URL). The high-volume ACP/stderr channels are
   * skipped so the hot path stays a single bounded string-compare.
   */
  private captureLifecycle(stamped: RunLogEntry): void {
    if (stamped.channel === 'system') {
      if (this.lifecycle.length < RunLog.LIFECYCLE_CAP) this.lifecycle.push(stamped);
      return;
    }
    if (
      stamped.channel === 'hook' &&
      stamped.hook === 'actions' &&
      stamped.stream === 'stdout' &&
      typeof stamped.text === 'string' &&
      this.actionsStdout.length < RunLog.ACTIONS_STDOUT_CAP
    ) {
      this.actionsStdout += stamped.text;
    }
  }

  /** Sibling path of the JSONL log: `<root>/<key>.summary.json`. */
  summaryFilePath(): string {
    return this.filePath.replace(/\.jsonl$/, '.summary.json');
  }

  /**
   * Reduce the accumulated lifecycle events into a compact per-issue summary
   * and write it next to the JSONL log. Best-effort: a failure is logged at
   * warn and swallowed (a missing summary is tolerated by the reflector). Pure
   * over in-memory state, so it needs no disk read and no stream flush — the
   * orchestrator calls it at the terminal unwind, just before closing the log.
   */
  writeSummary(generatedAt?: string): void {
    if (this.lifecycle.length === 0) return;
    try {
      const summary = summarizeRunLog({
        entries: this.lifecycle,
        actionsStdout: this.actionsStdout,
        issueId: this.issueId,
        issueIdentifier: this.identifier,
        generatedAt,
      });
      writeFileSync(this.summaryFilePath(), JSON.stringify(summary, null, 2) + '\n', 'utf8');
    } catch (err) {
      log.warn('run summary write failed', {
        issue_id: this.issueId,
        issue_identifier: this.identifier,
        error: (err as Error).message,
      });
    }
  }

  /** Closes the underlying stream. Idempotent. */
  async close(): Promise<void> {
    return new Promise((resolve) => {
      if (this.broken) return resolve();
      this.stream.end(() => resolve());
    });
  }
}

/**
 * Open (or reopen, append-mode) the run log for an issue. Creates the directory tree on
 * demand. Path is `<logsRoot>/<sanitized-identifier>.jsonl`; sanitization matches workspace
 * keys so the same characters are escaped consistently across .symphony/ subdirs.
 *
 * `issueId` is the tracker's primary key and is stamped on every line as `issue_id`.
 * `issueIdentifier` is the filename-safe display id and is used to derive the path AND
 * is stamped as `issue_identifier`. Pass both — they may diverge on trackers where ids
 * are opaque distinct from human-readable identifiers.
 */
export function openRunLog(
  logsRoot: string,
  issueId: string,
  issueIdentifier: string,
): RunLog {
  const key = sanitizeWorkspaceKey(issueIdentifier);
  if (key.length === 0) {
    throw new Error(`cannot derive runlog filename from identifier: ${issueIdentifier}`);
  }
  mkdirSync(logsRoot, { recursive: true });
  const filePath = path.join(logsRoot, `${key}.jsonl`);
  return new RunLog(filePath, issueId, issueIdentifier);
}

// ===========================================================================
// Per-issue run summary (issue 123)
//
// The reflector (companion #122) needs to spot patterns across many finished
// issues. The raw `<id>.jsonl` runs to multiple MB per heavy issue, so we emit
// a compact, comparable per-issue OUTCOME record alongside it. The summary is a
// pure reduction over the LIFECYCLE events already captured in the run log — no
// new hot-path instrumentation; the high-frequency ACP frame stream is not
// touched.
//
// Schema is versioned (`schema_version`). The reflector tolerates a missing
// summary (issues closed before this feature shipped, or runs whose summary
// write failed): treat absence as "no signal for this issue", never an error.
// ===========================================================================

/** Bumped when the on-disk `*.summary.json` shape changes incompatibly. */
export const RUN_SUMMARY_SCHEMA_VERSION = 1;

/** Per-active-state rollup. One entry per distinct state the issue was dispatched in. */
export interface RunSummaryStateStat {
  state: string;
  /** Number of dispatched attempts (incl. failure retries) in this state. */
  attempts: number;
  /** Sum of turns completed across this state's attempts (steering replies included). */
  turns_used: number;
  /** Resolved `max_turns` budget for this state, or null if never recorded. */
  max_turns: number | null;
  /** True if any attempt in this state ended `max_turns_reached`. */
  budget_exhausted: boolean;
  /** Wall-clock spent in this state (sum of per-attempt start→end), ms. */
  wall_clock_ms: number;
}

/** A review→implement kick-back: the highest-signal "what does the implementer keep getting wrong". */
export interface RunSummaryRejection {
  from_state: string;
  to_state: string;
  actor: string | null;
  /** The reviewer's rework notes (capped — see NOTE_CAP). */
  notes: string;
}

/** An attempt that ended in a stall / timeout / transport failure. */
export interface RunSummaryTimeout {
  attempt: number;
  state: string | null;
  reason: string;
}

/** A PR-autopilot / action conflict reroute (rebase churn). */
export interface RunSummaryRoute {
  from_state: string;
  to_state: string;
}

/**
 * Compact per-issue outcome record. Small enough that a reflection turn can
 * read dozens within budget; everything here is derived from the RunLog event
 * stream by {@link summarizeRunLog}.
 */
export interface RunSummary {
  schema_version: number;
  issue_id: string;
  issue_identifier: string;
  /** Distinct consecutive states visited, terminal state appended. e.g. ["Todo","Review","Todo","Review","Done"]. */
  state_path: string[];
  /** Total dispatched attempts across all states. */
  attempts: number;
  per_state: RunSummaryStateStat[];
  /** Count of review→implement kick-backs (== rejection_notes.length). */
  review_rejections: number;
  rejection_notes: RunSummaryRejection[];
  /** True if any state exhausted its turn budget. */
  turn_budget_exhausted: boolean;
  timeouts: RunSummaryTimeout[];
  conflict_routes: RunSummaryRoute[];
  /** The terminal state reached, or null if the run never reached one. */
  terminal_state: string | null;
  /** Coarse classification of `terminal_state`. "merged" is determined downstream (host PR merge). */
  terminal_outcome: 'completed' | 'cancelled' | 'incomplete';
  pr_number: number | null;
  pr_url: string | null;
  first_event_at: string | null;
  last_event_at: string | null;
  wall_clock_ms_total: number | null;
  generated_at: string;
}

/**
 * Loosely-typed view of one stamped JSONL entry. The reducer reads only the
 * lifecycle-relevant fields; everything else is carried by the index signature.
 */
export interface RunLogEntry {
  channel: string;
  ts: string;
  attempt: number;
  event?: string;
  fields?: Record<string, unknown>;
  hook?: string;
  stream?: string;
  text?: string;
  [k: string]: unknown;
}

interface AttemptSpan {
  attempt: number;
  state: string;
  max_turns: number | null;
  turns_used: number;
  reason: string | null;
  started_at: string;
  ended_at: string | null;
}

interface TransitionEvt {
  from_state: string;
  to_state: string;
  notes: string;
  actor: string | null;
  terminal: boolean;
  rerouted: boolean;
}

const NOTE_CAP = 4000;
const TIMEOUT_RE = /timeout|timed out|stall|prompt_timeout|did not connect|bridge/i;
const PR_URL_RE = /(https?:\/\/[^\s)]+\/pull\/(\d+))/;

function fieldsOf(e: RunLogEntry): Record<string, unknown> {
  return e.fields && typeof e.fields === 'object' ? (e.fields as Record<string, unknown>) : {};
}

function asStr(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function asNum(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function isBudgetExhausted(reason: string | null): boolean {
  return reason !== null && /max_turns/i.test(reason);
}

function spanDurationMs(s: AttemptSpan): number {
  if (!s.ended_at) return 0;
  const a = Date.parse(s.started_at);
  const b = Date.parse(s.ended_at);
  return Number.isFinite(a) && Number.isFinite(b) && b >= a ? b - a : 0;
}

/** Pair `attempt_started`/`attempt_ended` events in order into per-attempt spans. */
function buildAttemptSpans(entries: RunLogEntry[]): AttemptSpan[] {
  const spans: AttemptSpan[] = [];
  for (const e of entries) {
    if (e.channel !== 'system') continue;
    const f = fieldsOf(e);
    if (e.event === 'attempt_started') {
      spans.push({
        attempt: asNum(f.attempt) ?? spans.length,
        state: asStr(f.issue_state) ?? 'unknown',
        max_turns: asNum(f.max_turns),
        turns_used: 0,
        reason: null,
        started_at: e.ts,
        ended_at: null,
      });
    } else if (e.event === 'attempt_ended') {
      const open = spans[spans.length - 1];
      if (open && open.ended_at === null) {
        open.turns_used = asNum(f.turns_completed) ?? 0;
        open.reason = asStr(f.reason);
        open.ended_at = e.ts;
      }
    }
  }
  return spans;
}

function collectTransitions(entries: RunLogEntry[]): TransitionEvt[] {
  const out: TransitionEvt[] = [];
  for (const e of entries) {
    if (e.channel !== 'system' || e.event !== 'transition') continue;
    const f = fieldsOf(e);
    out.push({
      from_state: asStr(f.from_state) ?? 'unknown',
      to_state: asStr(f.to_state) ?? 'unknown',
      notes: asStr(f.notes) ?? '',
      actor: asStr(f.actor),
      terminal: f.terminal === true,
      rerouted: f.rerouted === true,
    });
  }
  return out;
}

function collapseConsecutive(seq: string[]): string[] {
  const out: string[] = [];
  for (const s of seq) {
    if (out[out.length - 1] !== s) out.push(s);
  }
  return out;
}

/** State path backbone is the per-attempt states (every dispatch logs one); the terminal state is appended. */
function buildStatePath(
  spans: AttemptSpan[],
  transitions: TransitionEvt[],
  terminalState: string | null,
): string[] {
  let path = collapseConsecutive(spans.map((s) => s.state));
  if (path.length === 0 && transitions.length > 0) {
    path = collapseConsecutive([transitions[0]!.from_state, ...transitions.map((t) => t.to_state)]);
  }
  if (terminalState && path[path.length - 1] !== terminalState) path.push(terminalState);
  return path;
}

function perStateStats(spans: AttemptSpan[]): RunSummaryStateStat[] {
  const order: string[] = [];
  const byState = new Map<string, RunSummaryStateStat>();
  for (const s of spans) {
    let stat = byState.get(s.state);
    if (!stat) {
      stat = { state: s.state, attempts: 0, turns_used: 0, max_turns: null, budget_exhausted: false, wall_clock_ms: 0 };
      byState.set(s.state, stat);
      order.push(s.state);
    }
    stat.attempts += 1;
    stat.turns_used += s.turns_used;
    if (s.max_turns !== null) stat.max_turns = s.max_turns;
    if (isBudgetExhausted(s.reason)) stat.budget_exhausted = true;
    stat.wall_clock_ms += spanDurationMs(s);
  }
  return order.map((st) => byState.get(st)!);
}

function capNotes(notes: string): string {
  return notes.length > NOTE_CAP ? notes.slice(0, NOTE_CAP) + '…[truncated]' : notes;
}

/**
 * A review rejection is a non-reroute transition back to the INITIAL implementing
 * state (where the issue started). In the shipped Todo→Review→Done flow that is
 * exactly a Review→Todo kick-back; the definition stays workflow-agnostic.
 */
function collectRejections(transitions: TransitionEvt[], initialState: string | null): RunSummaryRejection[] {
  if (initialState === null) return [];
  const out: RunSummaryRejection[] = [];
  for (const t of transitions) {
    if (t.rerouted) continue;
    if (t.to_state === initialState && t.from_state !== t.to_state) {
      out.push({ from_state: t.from_state, to_state: t.to_state, actor: t.actor, notes: capNotes(t.notes) });
    }
  }
  return out;
}

function collectTimeouts(spans: AttemptSpan[]): RunSummaryTimeout[] {
  const out: RunSummaryTimeout[] = [];
  for (const s of spans) {
    if (s.reason !== null && TIMEOUT_RE.test(s.reason)) {
      out.push({ attempt: s.attempt, state: s.state, reason: s.reason });
    }
  }
  return out;
}

function terminalOf(transitions: TransitionEvt[]): { state: string | null; outcome: RunSummary['terminal_outcome'] } {
  let terminal: TransitionEvt | null = null;
  for (const t of transitions) {
    if (t.terminal) terminal = t;
  }
  if (!terminal) return { state: null, outcome: 'incomplete' };
  return { state: terminal.to_state, outcome: /cancel/i.test(terminal.to_state) ? 'cancelled' : 'completed' };
}

function prFrom(actionsStdout: string): { number: number | null; url: string | null } {
  const m = PR_URL_RE.exec(actionsStdout);
  if (!m) return { number: null, url: null };
  return { url: m[1]!, number: Number.parseInt(m[2]!, 10) };
}

function wallClockTotal(entries: RunLogEntry[]): number | null {
  if (entries.length === 0) return null;
  const a = Date.parse(entries[0]!.ts);
  const b = Date.parse(entries[entries.length - 1]!.ts);
  return Number.isFinite(a) && Number.isFinite(b) && b >= a ? b - a : null;
}

/**
 * Reduce a per-issue lifecycle event list into a {@link RunSummary}. Pure and
 * deterministic (pass `generatedAt` to pin the timestamp under test). Tolerant
 * of partial streams — every field degrades to a sensible empty/null value.
 */
export function summarizeRunLog(input: {
  entries: RunLogEntry[];
  actionsStdout: string;
  issueId: string;
  issueIdentifier: string;
  generatedAt?: string;
}): RunSummary {
  const spans = buildAttemptSpans(input.entries);
  const transitions = collectTransitions(input.entries);
  const term = terminalOf(transitions);
  const statePath = buildStatePath(spans, transitions, term.state);
  const initialState = statePath[0] ?? spans[0]?.state ?? null;
  const rejections = collectRejections(transitions, initialState);
  const perState = perStateStats(spans);
  const pr = prFrom(input.actionsStdout);
  return {
    schema_version: RUN_SUMMARY_SCHEMA_VERSION,
    issue_id: input.issueId,
    issue_identifier: input.issueIdentifier,
    state_path: statePath,
    attempts: spans.length,
    per_state: perState,
    review_rejections: rejections.length,
    rejection_notes: rejections,
    turn_budget_exhausted: perState.some((s) => s.budget_exhausted),
    timeouts: collectTimeouts(spans),
    conflict_routes: transitions
      .filter((t) => t.rerouted)
      .map((t) => ({ from_state: t.from_state, to_state: t.to_state })),
    terminal_state: term.state,
    terminal_outcome: term.outcome,
    pr_number: pr.number,
    pr_url: pr.url,
    first_event_at: input.entries[0]?.ts ?? null,
    last_event_at: input.entries[input.entries.length - 1]?.ts ?? null,
    wall_clock_ms_total: wallClockTotal(input.entries),
    generated_at: input.generatedAt ?? new Date().toISOString(),
  };
}
