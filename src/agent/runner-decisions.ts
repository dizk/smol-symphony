// Pure decisions extracted from `runAttempt` / its cleanup closure (issues 62, 103).
// The runner remains the imperative shell that drives ports (the Gondolin VM, bridge,
// tracker, hooks); each helper here takes a snapshot of shell state and
// returns the next decision so branches can be unit tested without spinning
// up a VM or a workspace. Everything in this module is deterministic and
// side-effect free.

import type { Issue } from '../types.js';
import type { ActionContext } from '../actions/index.js';
import type { ProxyEnvVars } from './adapters.js';

export interface AttemptOutcome {
  ok: boolean;
  reason: string;
  threadId: string | null;
  turnsCompleted: number;
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

// ---------------------------------------------------------------------------
// Turn-loop decisions (issue 103). The runner's autonomous loop drives an
// ACP `runPrompt` per iteration, then folds three orthogonal flags into the
// next action: the adapter's outcome (`end_turn` vs failure), whether the
// agent has called `symphony.transition` (the `transitioned` flag on the
// running entry), and the post-turn tracker refresh. Splitting these into
// pure helpers keeps the shell loop body under the complexity budget and
// lets the precedence rules be unit-tested directly.

export type PromptKind = 'steering' | 'initial' | 'continuation';

/**
 * Pick which prompt template to render for the next iteration. A pending
 * steering reply trumps everything (the human is in the loop), then the
 * first-turn full prompt, then the bare continuation prompt for later
 * autonomous turns.
 */
export function selectPromptKind(input: {
  pendingSteering: boolean;
  firstTurn: boolean;
}): PromptKind {
  if (input.pendingSteering) return 'steering';
  if (input.firstTurn) return 'initial';
  return 'continuation';
}

export type TurnOutcomeClass =
  | { kind: 'success' }
  | { kind: 'agent_transitioned' }
  | { kind: 'agent_failure'; agentFailure: string; reason: string };

/**
 * Classify the outcome of a single `runPrompt`. `end_turn` is the happy path.
 * Anything else is a failure UNLESS the agent has called `symphony.transition`
 * (which can race with the adapter's reply): `transitioned` overrides because
 * the work is genuinely done and reconcile may have tripped the cancel signal
 * mid-flight, masking the real reason.
 */
export function classifyTurnOutcome(input: {
  outcomeReason: string;
  outcomeMessage: string;
  transitioned: boolean;
}): TurnOutcomeClass {
  if (input.outcomeReason === 'end_turn') return { kind: 'success' };
  if (input.transitioned) return { kind: 'agent_transitioned' };
  return {
    kind: 'agent_failure',
    agentFailure: `agent turn ${input.outcomeReason}: ${input.outcomeMessage}`,
    reason: input.outcomeReason,
  };
}

export type TurnContinuationReason =
  | 'issue_no_longer_present'
  | 'issue_no_longer_active'
  | 'max_turns_reached';

export type TurnContinuation =
  | { kind: 'continue' }
  | { kind: 'break'; reason: TurnContinuationReason };

/**
 * Decide whether the autonomous loop should run another iteration after a
 * successful `end_turn`. The three break conditions, in order: the tracker
 * lost the issue (file deleted out from under us), the issue moved to an
 * inactive state (terminal, holding, or routed elsewhere), or the per-state
 * `max_turns` budget is spent.
 */
export function decideTurnContinuation(input: {
  refreshedIssue: Issue | null;
  activeStates: ReadonlySet<string>;
  autonomousTurns: number;
  maxTurns: number;
}): TurnContinuation {
  if (input.refreshedIssue === null) return { kind: 'break', reason: 'issue_no_longer_present' };
  if (!input.activeStates.has(input.refreshedIssue.state.toLowerCase())) {
    return { kind: 'break', reason: 'issue_no_longer_active' };
  }
  if (input.autonomousTurns >= input.maxTurns) {
    return { kind: 'break', reason: 'max_turns_reached' };
  }
  return { kind: 'continue' };
}

export interface DeriveActionContextInput {
  identifier: string;
  workspacePath: string;
  issueId: string;
  issueTitle: string;
  issueDescription: string | null;
  /** Caller passes `process.env.SYMPHONY_REPO`; null/undefined → repo=null. */
  repoEnv: string | undefined;
  /** Staged SYMPHONY_* env from buildAfterRunHookEnv; undefined → all fallbacks. */
  extraEnv: Record<string, string> | undefined;
}

/**
 * Map a `RunningEntry` snapshot + optional staged SYMPHONY_* env into the
 * `ActionContext` the actions executor consumes. Mirrors the prior inline
 * fallback chain in `buildActionContext` so a Done state that previously
 * read `$SYMPHONY_BRANCH` from the hook env now reads `$branch` from the
 * action template namespace.
 *
 * Lifting the ternary fallbacks here drops `buildActionContext`'s
 * complexity from 14 to 1 (single pass-through call), letting the shell
 * stay under the imperative-shell budget.
 */
/**
 * Build the VM-facing credential-proxy env vars for a `'proxy'`-strategy
 * dispatch: `baseUrlVar=<proxy base URL>` and `tokenVar=<per-dispatch sentinel>`.
 * The in-VM client dials the proxy with the sentinel as its bearer; the proxy
 * substitutes the real upstream token host-side. A proxy adapter that declares
 * no `proxyEnv` is a profile bug, surfaced loudly here.
 */
export function proxyCredentialEnv(
  proxyEnv: ProxyEnvVars | undefined,
  adapterId: string,
  reg: { sentinel: string; baseUrl: string },
): Record<string, string> {
  if (!proxyEnv) {
    throw new Error(`adapter "${adapterId}" uses the credential proxy but declares no proxyEnv`);
  }
  return { [proxyEnv.baseUrlVar]: reg.baseUrl, [proxyEnv.tokenVar]: reg.sentinel };
}

/**
 * Compute the VM boot env from the `forward_env` list, dropping `omitVar` when
 * set. The runner passes the proxy adapter's credential var as `omitVar` so the
 * real token is never planted in the VM's PID-1 environment (it would otherwise
 * be readable via `/proc/1/environ`, defeating the proxy). `readEnv` is injected
 * so this stays deterministic and unit-testable.
 */
export function computeForwardedEnv(
  forwardList: readonly string[],
  omitVar: string | undefined,
  readEnv: (key: string) => string | undefined,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of forwardList) {
    if (k === omitVar) continue;
    const v = readEnv(k);
    if (v && v.length > 0) env[k] = v;
  }
  return env;
}

export function deriveActionContext(input: DeriveActionContextInput): ActionContext {
  const trimmedTitle = input.issueTitle.trim();
  const defaultPrTitle =
    trimmedTitle.length > 0 ? `${input.issueId}: ${trimmedTitle}` : input.issueId;
  const repoEnv = input.repoEnv;
  return {
    identifier: input.identifier,
    workspace: input.workspacePath,
    branch: input.extraEnv?.SYMPHONY_BRANCH ?? `agent/${input.identifier}`,
    base_branch: input.extraEnv?.SYMPHONY_BASE_BRANCH ?? 'main',
    issue_title: input.issueTitle,
    issue_body: input.issueDescription ?? '',
    repo: repoEnv && repoEnv.length > 0 ? repoEnv : null,
    pr_title: input.extraEnv?.SYMPHONY_PR_TITLE ?? defaultPrTitle,
    pr_body_file: input.extraEnv?.SYMPHONY_PR_BODY_FILE ?? '',
  };
}
