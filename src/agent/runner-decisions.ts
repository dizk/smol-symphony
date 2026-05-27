// Pure decisions extracted from `runAttempt` / its cleanup closure (issue 62).
// The runner remains the imperative shell that drives ports (smolvm, bridge,
// tracker, hooks); each helper here takes a snapshot of shell state and
// returns the next decision so branches can be unit tested without spinning
// up a VM or a workspace. Everything in this module is deterministic and
// side-effect free.

export interface AttemptOutcome {
  ok: boolean;
  reason: string;
  threadId: string | null;
  turnsCompleted: number;
}

export type CleanupExecution = 'actions' | 'hook' | 'skip';

export interface CleanupExecutionInput {
  hasRunningEntry: boolean;
  actionsLength: number;
  hasAfterRunHook: boolean;
}

/** Cleanup branches: actions wins over hook (issue 36 AC2). */
export function decideCleanupExecution(input: CleanupExecutionInput): CleanupExecution {
  if (input.actionsLength > 0 && input.hasRunningEntry) return 'actions';
  if (input.hasAfterRunHook) return 'hook';
  return 'skip';
}

/** SYMPHONY_* env staging is only worth doing when the cleanup tail will read it. */
export function shouldStageAfterRunEnv(input: CleanupExecutionInput): boolean {
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
