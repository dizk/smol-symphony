// Pure decisions extracted from `runAttempt` / its cleanup closure (issue 62).
// The runner remains the imperative shell that drives ports (smolvm, bridge,
// tracker, hooks); each helper here takes a snapshot of shell state and
// returns the next decision so branches can be unit tested without spinning
// up a VM or a workspace. Everything in this module is deterministic and
// side-effect free.

import { shouldMergeForState } from './integration.js';

export interface AttemptOutcome {
  ok: boolean;
  reason: string;
  threadId: string | null;
  turnsCompleted: number;
}

export interface IntegrationMergeGate {
  transitioned: boolean;
  cleanupState: string;
  mergeOnStates: readonly string[];
}

/** Integration merge gate: requires a transition AND opt-in via merge_on_states. */
export function shouldRunIntegrationMerge(gate: IntegrationMergeGate): boolean {
  if (!gate.transitioned) return false;
  if (gate.mergeOnStates.length === 0) return false;
  return shouldMergeForState(gate.cleanupState, gate.mergeOnStates as string[]);
}

export type CleanupExecution = 'actions' | 'hook' | 'skip';

export interface CleanupExecutionInput {
  integrationFailed: boolean;
  hasRunningEntry: boolean;
  actionsLength: number;
  hasAfterRunHook: boolean;
}

/** Cleanup branches: actions wins over hook (issue 36 AC2); integration failure skips. */
export function decideCleanupExecution(input: CleanupExecutionInput): CleanupExecution {
  if (input.integrationFailed) return 'skip';
  if (input.actionsLength > 0 && input.hasRunningEntry) return 'actions';
  if (input.hasAfterRunHook) return 'hook';
  return 'skip';
}

/** SYMPHONY_* env staging is only worth doing when the cleanup tail will read it. */
export function shouldStageAfterRunEnv(input: CleanupExecutionInput): boolean {
  if (input.integrationFailed) return false;
  if (!input.hasRunningEntry) return false;
  return input.actionsLength > 0 || input.hasAfterRunHook;
}

export interface AttemptOutcomeInput {
  agentFailure: string | null;
  nonRoutedActionFailureReason: string | null;
  lastReason: string;
  sessionId: string;
  turnsCompleted: number;
}

/**
 * Collapse the three failure channels into one AttemptOutcome.
 * Precedence: agentFailure > non-routed terminal-action failure > success.
 * The non-routed action failure case fronts a `state action failed: ` prefix
 * so the orchestrator (and any downstream `reason`-keyed dashboard logic)
 * can tell apart "the agent itself failed" from "the post-agent push/PR
 * step failed". Silently treating a failed push as success was the prior
 * bug this contract closes.
 */
export function decideAttemptOutcome(input: AttemptOutcomeInput): AttemptOutcome {
  if (input.agentFailure !== null) {
    return {
      ok: false,
      reason: input.agentFailure,
      threadId: input.sessionId,
      turnsCompleted: input.turnsCompleted,
    };
  }
  if (input.nonRoutedActionFailureReason !== null) {
    return {
      ok: false,
      reason: `state action failed: ${input.nonRoutedActionFailureReason}`,
      threadId: input.sessionId,
      turnsCompleted: input.turnsCompleted,
    };
  }
  return {
    ok: true,
    reason: input.lastReason,
    threadId: input.sessionId,
    turnsCompleted: input.turnsCompleted,
  };
}

/**
 * Classify the post-end_turn flow when the loop should consider whether to do
 * another autonomous iteration. Pure decision over the snapshot the loop has
 * after refreshing tracker state. Reasons mirror the strings the runner sets
 * into `lastReason` so the AttemptOutcome reason field stays unchanged.
 */
export interface TurnContinuationInput {
  cancelled: boolean;
  transitioned: boolean;
  steeringRequested: boolean;
  issueStillPresent: boolean;
  issueStillActive: boolean;
  autonomousTurns: number;
  maxTurns: number;
}

export type TurnContinuation =
  | { kind: 'continue' }
  | { kind: 'await_steering' }
  | { kind: 'break'; reason: string };

export function decideTurnContinuation(input: TurnContinuationInput): TurnContinuation {
  if (input.cancelled) return { kind: 'break', reason: 'cancelled_by_reconciliation' };
  if (input.transitioned) return { kind: 'break', reason: 'agent_transitioned' };
  if (input.steeringRequested) return { kind: 'await_steering' };
  if (!input.issueStillPresent) return { kind: 'break', reason: 'issue_no_longer_present' };
  if (!input.issueStillActive) return { kind: 'break', reason: 'issue_no_longer_active' };
  if (input.autonomousTurns >= input.maxTurns) return { kind: 'break', reason: 'max_turns_reached' };
  return { kind: 'continue' };
}
