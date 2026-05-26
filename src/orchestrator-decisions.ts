// Pure decisions extracted from `src/orchestrator.ts` (issue 75). Mirrors
// `src/agent/runner-decisions.ts`: every helper takes a snapshot of shell
// state and returns the next decision so the orchestrator stays thin wiring
// and each branch can be unit tested without spinning up a tracker, runner,
// or reconciler. Deterministic and side-effect free.
//
// Scope here is two of the "decision-heavy branches" called out in #75:
// dispatch admission (`computeEligibilityReason`) and reap triggering on a
// fresh tracker view (`decideReconcileForIssue`). The remaining
// shell-complexity warnings on `orchestrator.ts` (start, tick, dispatchIssue,
// onWorkerExit, onRetryTimer, prIntended, detailByIdentifier) are tracked as
// a follow-up so this slice stays inside the PR size budget.

import type { Issue, StateConfig } from './types.js';
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
