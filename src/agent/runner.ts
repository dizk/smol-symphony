// Agent Runner (SPEC §6.2): workspace + prompt + ACP session, with continuation turns up
// to agent.max_turns. The ACP adapter (claude-agent-acp / codex-acp / opencode acp) runs
// inside a per-issue Gondolin VM. The host workspace directory is volume-mounted into
// the VM at the same absolute path so cwd values are consistent.

import { setTimeout as delay } from 'node:timers/promises';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  Issue,
  RunningEntry,
  RuntimeEvent,
  ServiceConfig,
  WorkflowDefinition,
} from '../types.js';
import type { IssueTracker } from '../trackers/types.js';
import { WorkspaceManager, fetchBaseInWorkspace, sanitizeWorkspaceKey } from '../workspace.js';
import { renderPrompt } from '../prompt.js';
import { SYMPHONY_VM_PREFIX, type VmClient, type VmExec, type VmHandle } from './vm-port.js';
import {
  GondolinDispatcher,
  type GondolinDispatchOptions,
  type GondolinVmConfig,
} from './gondolin-dispatch.js';
import type { AdapterHooksConfig, CredentialSecretRegistry } from './credential-secrets.js';
import { stripCredentialEnv } from './vm-guards.js';
import { AcpClient } from './acp.js';
import {
  ADAPTERS,
  isKnownAdapter,
  type AcpAdapterId,
  type ModelInjection,
} from './adapters.js';
import type { GuestCredFile } from './gondolin-creds-staging.js';
import type { McpRegistry } from '../mcp.js';
import { activeStateNames } from '../issues.js';
import { withIssue } from '../logging.js';
import { resolveActionsForState, resolveHooksForState } from '../workflow.js';
import { parseFrontMatterLenient } from '../util/frontmatter.js';
import {
  runActions,
  toActionsSnapshot,
  type ActionContext,
  type ActionExecResult,
  type ProposeFollowupSink,
  type RunInVmExecutor,
  type WorkflowAction,
} from '../actions/index.js';
import { defaultPredicateEnv } from '../actions/predicate-env.js';
import type { ResourceSnapshot } from '../reconciler/index.js';
import {
  classifyTurnOutcome,
  computeForwardedEnv,
  decideAttemptOutcome,
  decideTurnContinuation,
  deriveActionContext,
  selectPromptKind,
} from './runner-decisions.js';
import type { McpServer } from '@agentclientprotocol/sdk';
import type { RunLog } from '../runlog.js';
import type { HookCapture, HookResult } from '../workspace.js';
import type { AcpBridge, AcpBridgeRegistration } from '../acp-bridge.js';
import type { Socket } from 'node:net';
import type { AdapterProfile } from './adapters.js';

export interface AgentRunnerEvents {
  onSessionStarted?: (info: {
    issueId: string;
    sessionId: string;
    threadId: string;
    pid: string | null;
  }) => void;
  onRuntimeEvent: (issueId: string, event: RuntimeEvent) => void;
  onTokenUsage: (
    issueId: string,
    usage: { input_tokens: number; output_tokens: number; total_tokens: number },
  ) => void;
  onRateLimits: (issueId: string, snapshot: unknown) => void;
  onTurn: (issueId: string, turnNumber: number) => void;
}

export interface RunAttemptResult {
  ok: boolean;
  reason: string;
  threadId: string | null;
  turnsCompleted: number;
}

const CONTINUATION_PROMPT_WITH_MCP =
  'Continue working on the same issue. Pick up where the prior turn left off and proceed with the next concrete action. If the work is fully complete, summarize what changed and call the symphony.transition tool to hand off to the next state.';

const CONTINUATION_PROMPT_NO_MCP =
  'Continue working on the same issue. Pick up where the prior turn left off and proceed with the next concrete action. If the work is fully complete, summarize what changed and stop.';

function continuationPrompt(mcpEnabled: boolean): string {
  return mcpEnabled ? CONTINUATION_PROMPT_WITH_MCP : CONTINUATION_PROMPT_NO_MCP;
}

// Source of truth for "which state's cleanup hooks/actions should fire."
// Prefers the running-entry's current issue state (the runner may have moved
// it during the attempt, e.g. via a typed-action reroute), otherwise falls
// back to the issue snapshot the attempt was launched with.
function resolveCleanupState(issue: Issue, runningEntry: RunningEntry | undefined): string {
  return runningEntry?.issue.state ?? issue.state;
}

// Stage the SYMPHONY_* env vars + temp body file consumed by the Done-state
// `actions:` block (push_branch + create_pr_if_missing). Reads the current
// issue file from <tracker_root>/<state>/<identifier>.md so any transition
// notes appended by `symphony.transition` ride through into the PR body; falls
// back to the in-memory description if the file isn't reachable (no tracker
// root pinned, or read failure). Returns the env map and a cleanup closure the
// caller MUST run after the actions complete, so the temp file is removed
// promptly.
async function stageActionContextEnv(
  entry: RunningEntry,
): Promise<{ env: Record<string, string>; cleanup: () => Promise<void> }> {
  const issue = entry.issue;
  const ident = entry.identifier;
  const branch = `agent/${ident}`;
  let body = issue.description ?? '';
  if (entry.tracker_root_at_dispatch) {
    const issuePath = path.join(entry.tracker_root_at_dispatch, issue.state, `${ident}.md`);
    try {
      const text = await readFile(issuePath, 'utf8');
      body = parseFrontMatterLenient(text).body;
    } catch {
      // Fall back to the dispatch-time description; the action still fires, it
      // just won't see notes the agent appended during the run.
    }
  }
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'symphony-pr-body-'));
  const bodyFile = path.join(tmpDir, 'body.md');
  await writeFile(bodyFile, body, 'utf8');
  const cleanup = async (): Promise<void> => {
    try {
      await rm(tmpDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup; tmp dir is in $TMPDIR and the OS will reclaim it eventually.
    }
  };
  const title = issue.title.trim();
  // Mirror after_create's `${SYMPHONY_BASE_BRANCH:-main}` default so an
  // operator who only exported SYMPHONY_REPO still gets a usable --base value.
  const baseBranch = process.env.SYMPHONY_BASE_BRANCH;
  const env: Record<string, string> = {
    SYMPHONY_ISSUE_ID: issue.id,
    SYMPHONY_BRANCH: branch,
    SYMPHONY_BASE_BRANCH: baseBranch && baseBranch.length > 0 ? baseBranch : 'main',
    SYMPHONY_PR_TITLE: title.length > 0 ? `${issue.id}: ${title}` : issue.id,
    SYMPHONY_PR_BODY_FILE: bodyFile,
  };
  return { env, cleanup };
}

function buildSteeringReplyPrompt(question: string, context: string | null, reply: string): string {
  const ctxBlock = context && context.length > 0 ? `\n\nContext you provided:\n${context}` : '';
  return [
    'The human operator has responded to your steering request.',
    '',
    'Your question was:',
    question,
    ctxBlock,
    '',
    'The human responded:',
    reply,
    '',
    'Continue work on the issue, taking the human response into account. If the work is fully complete, call symphony.transition to hand off to the next state. If you need to ask another question, call symphony.request_human_steering again.',
  ]
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
}

/**
 * Effective dispatch parameters for a single attempt against `state`. Computed once at the
 * top of runAttempt so a workflow reload (or a per-state override) cannot redirect the
 * adapter / model / loop budget mid-attempt; downstream code in the runner reads only
 * from this object, never from `this.cfg.acp.*` or `this.cfg.agent.max_turns` directly.
 */
export interface ResolvedDispatchConfig {
  adapter: AcpAdapterId;
  model: string | null;
  effort: string | null;
  max_turns: number;
  /**
   * Per-state opt-in flag (issue 40). When true, the runner adds two extra
   * read-only mounts to the per-issue VM (`tracker.root` → `/symphony/issues`,
   * `logs.root` → `/symphony/logs`) so an in-VM eval/debug agent can inspect
   * symphony's own state. Pinned at attempt start through this struct so a
   * workflow reload mid-attempt can't add or remove the mounts on the live VM.
   */
  eval_mode: boolean;
}

/**
 * Fixed guest paths for the eval/debug read-only mounts. Hardcoded (not
 * configurable) so the prompt body can reference them by literal path. Kept
 * as exports for tests and any future operator-facing surface that needs to
 * mention them.
 */
export const EVAL_MODE_ISSUES_GUEST_PATH = '/symphony/issues';
export const EVAL_MODE_LOGS_GUEST_PATH = '/symphony/logs';

/**
 * Resolve effective adapter/model/max_turns for an issue's current state. Per-state
 * overrides declared under `states.<name>` win; otherwise the workflow-level
 * `acp.adapter` / `acp.model` / `agent.max_turns` defaults apply.
 *
 * Throws when `state` is not declared in `cfg.states`. The orchestrator should never
 * dispatch an issue whose state is not declared (validateDispatch + reconciliation both
 * gate on that), but defense in depth: returning a silent fallback here would mask a
 * tracker/workflow drift bug as a confusing default-adapter run.
 */
export function resolveDispatchConfig(
  cfg: ServiceConfig,
  state: string,
): ResolvedDispatchConfig {
  const states = cfg.states;
  // Case-insensitive lookup matches the rest of symphony (eligibility, reconciliation,
  // local-tracker state directories all compare lowercase). A workflow that declares
  // `Todo` and a tracker file living under `todo/` still resolves correctly.
  let key: string | null = null;
  if (Object.prototype.hasOwnProperty.call(states, state)) {
    key = state;
  } else {
    const lower = state.toLowerCase();
    for (const name of Object.keys(states)) {
      if (name.toLowerCase() === lower) {
        key = name;
        break;
      }
    }
  }
  if (key === null) {
    const declared = Object.keys(states).join(', ');
    throw new Error(
      `resolveDispatchConfig: state "${state}" is not declared in workflow states (declared: ${
        declared.length > 0 ? declared : '<none>'
      })`,
    );
  }
  const s = states[key]!;
  const adapter = (s.adapter ?? cfg.acp.adapter) as AcpAdapterId;
  // Distinguish "not overridden" (undefined) from "explicitly null" (means: use adapter
  // default). Only fall back to workflow-level acp.model when the state did not declare
  // a model key at all; an explicit null in the state config means the operator wants
  // the adapter's own default for this state.
  const model = s.model === undefined ? cfg.acp.model : s.model;
  const effort = s.effort === undefined ? cfg.acp.effort : s.effort;
  const max_turns = s.max_turns ?? cfg.agent.max_turns;
  const eval_mode = s.eval_mode === true;
  return { adapter, model, effort, max_turns, eval_mode };
}

/**
 * Derive the extra read-only bind mounts the eval/debug mode contributes for
 * a single dispatch. Returns an empty list when the state did not opt in or
 * when neither symphony state root is configured (defense in depth — the
 * local tracker always sets `tracker.root` and the loader always sets
 * `logs.root`, but a hand-built ServiceConfig in tests might not).
 *
 * Pure so tests can assert the mount shape without spinning up the runner.
 * The host paths are absolute (the loader normalizes both roots), and the
 * guest paths are the fixed `EVAL_MODE_*` constants so the prompt body can
 * reference them by literal path.
 */
export function buildEvalModeMounts(
  cfg: ServiceConfig,
  resolved: ResolvedDispatchConfig,
): Array<{ host: string; guest: string; readonly: true }> {
  if (!resolved.eval_mode) return [];
  const mounts: Array<{ host: string; guest: string; readonly: true }> = [];
  const trackerRoot = cfg.tracker.root;
  if (trackerRoot && trackerRoot.length > 0) {
    mounts.push({ host: trackerRoot, guest: EVAL_MODE_ISSUES_GUEST_PATH, readonly: true });
  }
  const logsRoot = cfg.logs.root;
  if (logsRoot && logsRoot.length > 0) {
    mounts.push({ host: logsRoot, guest: EVAL_MODE_LOGS_GUEST_PATH, readonly: true });
  }
  return mounts;
}

/**
 * Sink the runner uses to surface per-attempt action ledgers (issue 36 AC5).
 * Implemented by `Orchestrator.recordActionResult` in production; tests can
 * stub the no-op to skip the snapshot wiring.
 */
export interface ActionSnapshotSink {
  recordActionResult(id: string, snapshot: ResourceSnapshot): void;
}

export class AgentRunner {
  constructor(
    private cfg: ServiceConfig,
    private workflow: WorkflowDefinition,
    private workspaces: WorkspaceManager,
    private tracker: IssueTracker,
    /**
     * Gondolin VM-substrate client (the in-process VM backend). Each
     * dispatch creates a per-issue VM through a per-attempt `GondolinDispatcher`
     * built over this client + the shared credential registry.
     */
    private vmClient: VmClient,
    private events: AgentRunnerEvents,
    private mcp: McpRegistry | null = null,
    /**
     * Host-side TCP bridge the in-VM agent dials back to for ACP traffic. The
     * exec channel is now just the process tether + stderr tap; required at
     * runtime — runAttempt fails fast if absent.
     */
    private acpBridge: AcpBridge | null = null,
    /**
     * Sink for `propose_followup` actions (issue 36). Wired to the
     * orchestrator's tracker in production; nullable for tests that don't
     * exercise the action. Same shape as the MCP `propose_issue` tool's
     * tracker-side write.
     */
    private followupSink: ProposeFollowupSink | null = null,
    /**
     * Sink for per-attempt action ledgers surfaced on Snapshot (issue 36 AC5).
     * Nullable so tests that don't exercise the snapshot surface can pass
     * undefined.
     */
    private actionSnapshotSink: ActionSnapshotSink | null = null,
    /**
     * Shared host credential registry (Gondolin secret-substitution model,
     * replaces the credential proxy). Owns every live per-VM `secretManager`;
     * the dispatcher registers a manager per dispatch, the ticker fans fresh
     * tokens out to all of them on rotation. Required — runAttempt fails fast
     * if absent.
     */
    private credentialRegistry: CredentialSecretRegistry | null = null,
    /**
     * Per-adapter Gondolin hooks config (allowlist + token-shaped placeholder
     * secret + request/response hooks). Built once at composition time from
     * `buildAdapterCredentialSpecs`; the dispatcher passes the selected adapter's
     * entry straight into `createHttpHooks`. Required — runAttempt fails fast
     * if the dispatched adapter is missing.
     */
    private adapterHooks: Record<AcpAdapterId, AdapterHooksConfig> | null = null,
    /**
     * Static Gondolin VM shape (image ref + cpus/mem). Resolved from config at
     * composition time. Required.
     */
    private gondolinVmConfig: GondolinVmConfig | null = null,
  ) {}

  setAcpBridge(bridge: AcpBridge | null): void {
    this.acpBridge = bridge;
  }

  updateConfig(cfg: ServiceConfig, workflow: WorkflowDefinition): void {
    this.cfg = cfg;
    this.workflow = workflow;
  }

  setMcpRegistry(mcp: McpRegistry | null): void {
    this.mcp = mcp;
  }

  vmNameFor(issue: Issue): string {
    return `${SYMPHONY_VM_PREFIX}${sanitizeWorkspaceKey(issue.identifier)}`.toLowerCase();
  }

  /**
   * Resolve the action templating context from the staged `extraEnv` map and
   * the running entry. Pass-through to the pure `deriveActionContext` helper
   * so the env fallback chain stays out of the imperative-shell complexity
   * budget; the shell only adapts `RunningEntry` → the helper's input shape
   * and feeds `process.env.SYMPHONY_REPO`.
   */
  private buildActionContext(
    entry: RunningEntry,
    workspacePath: string,
    extraEnv: Record<string, string> | undefined,
  ): ActionContext {
    return deriveActionContext({
      identifier: entry.identifier,
      workspacePath,
      issueId: entry.issue.id,
      issueTitle: entry.issue.title ?? '',
      issueDescription: entry.issue.description,
      repoEnv: process.env.SYMPHONY_REPO,
      extraEnv,
    });
  }

  /**
   * Construct a `RunInVmExecutor` bound to a specific per-issue VM. Each
   * invocation execs a fresh one-shot process against the dispatch's live
   * `VmHandle`, with stdin closed, stdout/stderr drained into the per-issue
   * run log, and a timeout that aborts the exec on overrun. The workspace is
   * VFS-mounted at the same host path inside the VM (the dispatcher declares
   * that mount at bring-up), so `workdir` is identical on both sides — no path
   * translation needed.
   *
   * Wraps the `VmHandle.exec` contract rather than reaching into the VmClient
   * from the actions module so the actions package stays free of
   * `node:child_process`/VM imports; the dependency inversion lets tests pass
   * `hostRunInVm` without touching the VM substrate.
   */
  private buildVmRunInVm(vm: VmHandle, runLog: RunLog | undefined): RunInVmExecutor {
    return ({ name, cmd, env, workdir, timeoutMs, onStdout, onStderr }) =>
      new Promise((resolve) => {
        const stream = vm.exec({
          command: cmd,
          workdir,
          env,
          // The local timer below kills the exec at the deadline; passing
          // timeoutMs to the VM exec lets the substrate enforce the same bound.
          timeoutMs,
        });
        // No stdin: run_in_vm is one-shot exec; the action's `cmd` is the
        // full command line. Closing stdin tells the in-VM process its
        // input stream is at EOF so it never blocks waiting for input.
        try {
          stream.stdin.end();
        } catch {
          /* idempotent on already-ended stream */
        }
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        const limit = 65_536;
        stream.stdout.setEncoding('utf8');
        stream.stderr.setEncoding('utf8');
        stream.stdout.on('data', (chunk: string) => {
          stdout += chunk;
          if (stdout.length > limit) stdout = stdout.slice(0, limit);
          onStdout?.(chunk);
          runLog?.record({ channel: 'hook', hook: `run_in_vm:${name}`, stream: 'stdout', text: chunk });
        });
        stream.stderr.on('data', (chunk: string) => {
          stderr += chunk;
          if (stderr.length > limit) stderr = stderr.slice(0, limit);
          onStderr?.(chunk);
          runLog?.record({ channel: 'hook', hook: `run_in_vm:${name}`, stream: 'stderr', text: chunk });
        });
        const timer = setTimeout(() => {
          timedOut = true;
          try {
            stream.kill();
          } catch {
            /* idempotent */
          }
        }, timeoutMs);
        stream.exit
          .then(({ code }) => {
            clearTimeout(timer);
            resolve({
              // Gondolin reports the abort/exit as a numeric signal; the
              // run-log surface only cares about exit_code + timed_out, so the
              // numeric signal is folded into `null` rather than mistyped.
              exit_code: code,
              signal: null,
              timed_out: timedOut,
              stdout,
              stderr,
            });
          })
          .catch((err: Error) => {
            clearTimeout(timer);
            resolve({
              exit_code: null,
              signal: null,
              timed_out: timedOut,
              stdout,
              stderr: stderr + `\n${err.message}`,
            });
          });
      });
  }

  /**
   * Drive the typed action executor for a state's `actions:` block. Reroutes
   * the issue when an action returns `route_to` (today: `merge` on conflict);
   * the workspace and `agent/<id>` branch are preserved so the operator who
   * picks up the issue in the routed state can resolve it.
   *
   * Returns the underlying `ActionExecResult` so the caller can distinguish
   * "rerouted (treat as success — the agent's work is done; the issue lives
   * on in the conflict state)" from "non-routed failure (the cleanup pass
   * itself failed — the attempt must report `ok: false` so the orchestrator
   * retries or surfaces the error)." A void return here is what let a failed
   * `push_branch` / `create_pr_if_missing` look like a successful attempt
   * in the prior implementation.
   */
  private async runStateActions(
    stateName: string,
    actions: readonly WorkflowAction[],
    entry: RunningEntry,
    workspacePath: string,
    extraEnv: Record<string, string> | undefined,
    capture: HookCapture | undefined,
    runInVm: RunInVmExecutor | undefined,
  ): Promise<ActionExecResult> {
    const ctx = this.buildActionContext(entry, workspacePath, extraEnv);
    const snapshotId = `actions:${stateName}`;
    const logger = withIssue({ issue_id: entry.issue_id, issue_identifier: entry.identifier });
    logger.info('running state actions', {
      state: stateName,
      action_count: actions.length,
    });
    const result = await runActions(actions, {
      workspacePath,
      ctx,
      capture: capture ?? undefined,
      followupSink: this.followupSink ?? undefined,
      runInVm: runInVm ?? undefined,
      predicateEnv: defaultPredicateEnv,
      snapshotId,
      now: () => Date.now(),
    });
    // Surface on snapshot regardless of outcome; the dashboard shows the
    // full ledger including in-progress / error states.
    this.actionSnapshotSink?.recordActionResult(snapshotId, {
      id: snapshotId,
      ready: result.ok,
      desired_hash: null,
      last_error: result.actions.find((a) => a.state === 'error')?.error ?? null,
      actions: result.actions,
    });
    if (result.route_to) {
      logger.warn('state action requested reroute', {
        state: stateName,
        target_state: result.route_to,
        reason: result.reason,
      });
      await this.rerouteEntryAction(entry, stateName, result.route_to, result.reason);
    } else if (!result.ok) {
      logger.warn('state actions failed', {
        state: stateName,
        reason: result.reason,
      });
    }
    return result;
  }

  /**
   * Move `entry`'s tracker file into `targetState` and append a diagnostic
   * note. Used by `runStateActions` when an action returns a route_to (e.g.
   * `merge`'s on_conflict).
   */
  private async rerouteEntryAction(
    entry: RunningEntry,
    fromState: string,
    targetState: string,
    reason: string | null,
  ): Promise<void> {
    if (!this.tracker.moveIssueToState) {
      entry.cleanup_workspace_on_exit = false;
      return;
    }
    const notes = [
      `**Action rerouted** to \`${targetState}\` from \`${fromState}\`.`,
      '',
      `**Reason:** ${reason ?? 'unknown'}`,
      '',
      `**Workspace and \`agent/${entry.identifier}\` branch are preserved** for resolution.`,
    ].join('\n');
    try {
      await this.tracker.moveIssueToState(entry.issue_id, targetState, {
        fromRoot: entry.tracker_root_at_dispatch ?? undefined,
        fromState,
        notes,
        actor: entry.resolved_actor,
      });
    } catch {
      entry.cleanup_workspace_on_exit = false;
      return;
    }
    entry.cleanup_workspace_on_exit = false;
    entry.issue.state = targetState;
    // Record the conflict reroute so the run-summary reducer can surface it as
    // PR-autopilot rebase churn (issue 123). `rerouted` distinguishes it from a
    // normal handoff so it never counts as a review rejection.
    entry.last_transition = {
      from_state: fromState,
      to_state: targetState,
      notes,
      actor: entry.resolved_actor,
      terminal: false,
      rerouted: true,
    };
  }

  /**
   * Cleanup: run the per-state `actions:` block (push_branch +
   * create_pr_if_missing on Done is the canonical example). Stages the
   * SYMPHONY_* env vars + temp body file the action context consumes via
   * `deriveActionContext` (so $pr_body_file points at the post-transition
   * body), and tears them down via `finally`. Returns the non-routed action
   * failure reason, or null when the cleanup succeeded / rerouted / was
   * skipped (no actions declared or no running entry).
   *
   * The shell `hooks.after_run` arm that lived here historically is gone —
   * the parser drops `after_run` from the hooks: surface and the Done-state
   * handoff is a typed `actions:` block now.
   */
  private async runCleanupActions(
    issue: Issue,
    cleanupState: string,
    runningEntry: RunningEntry | undefined,
    workspacePath: string,
    vm: VmHandle | null,
    hookCapture: (hook: string) => HookCapture | undefined,
    runLog: RunLog | undefined,
  ): Promise<string | null> {
    const logger = withIssue({ issue_id: issue.id, issue_identifier: issue.identifier });
    const cleanupActions = resolveActionsForState(this.cfg, cleanupState);
    if (!runningEntry || !cleanupActions || cleanupActions.length === 0) return null;
    let staged: { extraEnv: Record<string, string> | undefined; cleanup: () => Promise<void> };
    try {
      const built = await stageActionContextEnv(runningEntry);
      staged = { extraEnv: built.env, cleanup: built.cleanup };
    } catch (err) {
      logger.warn('action-context env staging failed; running actions without SYMPHONY_PR_* vars', {
        error: (err as Error).message,
      });
      staged = { extraEnv: undefined, cleanup: async (): Promise<void> => undefined };
    }
    try {
      // run_in_vm goes through the per-issue VM's exec channel. The VM is still
      // alive here — teardown of the dispatch happens after the cleanup actions
      // run. A null handle (the dispatch never came up) skips run_in_vm.
      const runInVm: RunInVmExecutor | undefined = vm
        ? this.buildVmRunInVm(vm, runLog)
        : undefined;
      const actionResult = await this.runStateActions(
        cleanupState,
        cleanupActions,
        runningEntry,
        workspacePath,
        staged.extraEnv,
        hookCapture('actions'),
        runInVm,
      );
      if (!actionResult.ok && !actionResult.route_to) {
        return actionResult.reason ?? 'unknown';
      }
      return null;
    } finally {
      await staged.cleanup();
    }
  }

  /**
   * Per-attempt context assembled once the VM is up and the bridge is registered.
   * Everything `tearDownSession` needs to unwind cleanly lives here so post-VM
   * failure paths share one teardown contract. `acpSocket` is `null` until the
   * in-VM agent dials back; teardown checks for null before destroying.
   */
  private static readonly STDERR_RING_LIMIT = 240;
  private static readonly STDERR_LOG_LIMIT = 500;
  private static readonly STEERING_PREVIEW_LIMIT = 240;

  async runAttempt(
    issue: Issue,
    attempt: number | null,
    cancelSignal: { cancelled: boolean },
    runningEntry?: RunningEntry,
    runLog?: RunLog,
  ): Promise<RunAttemptResult> {
    const logger = withIssue({ issue_id: issue.id, issue_identifier: issue.identifier });
    try {
      return await this.runAttemptCore(issue, attempt, cancelSignal, runningEntry, runLog, logger);
    } catch (err) {
      if (err instanceof PhaseFailure) return err.attemptResult;
      throw err;
    }
  }

  /**
   * Phase pipeline that backs `runAttempt`. Each `unwrap(...)` either yields
   * the phase's success value or throws `PhaseFailure` (caught by `runAttempt`
   * and converted to a `RunAttemptResult`). This keeps the orchestrator under
   * the imperative-shell budget while preserving the strict ordering of the
   * original 535-line method.
   */
  private async runAttemptCore(
    issue: Issue,
    attempt: number | null,
    cancelSignal: { cancelled: boolean },
    runningEntry: RunningEntry | undefined,
    runLog: RunLog | undefined,
    logger: ReturnType<typeof withIssue>,
  ): Promise<RunAttemptResult> {
    const resolved = this.unwrap(this.resolveAttemptDispatch(issue, logger));
    const hookCapture = this.makeHookCapture(runLog);
    const initialHooks = resolveHooksForState(this.cfg, issue.state);
    const ws = this.unwrap(
      await this.setupWorkspace(issue, initialHooks, hookCapture, runLog, logger),
    );
    const adapter = this.unwrap(this.prepareAdapterRuntime(resolved, logger));
    const bridge = this.unwrap(this.validateAcpBridge(logger));
    const vm = this.unwrap(
      await this.bringUpVmAndExec({
        issue,
        resolved,
        workspacePath: ws.workspace.path,
        adapter,
        runLog,
        logger,
      }),
    );
    const ctx: SessionContext = {
      issue,
      runningEntry,
      workspacePath: ws.workspace.path,
      vm: vm.vm,
      bridgeReg: vm.bridgeReg,
      exec: vm.exec,
      teardownDispatch: vm.teardownDispatch,
      acpSocket: null,
      hookCapture,
      runLog,
      logger,
    };
    // Once dispatch() has succeeded the VM + the per-VM secret registration are
    // live and ONLY this ctx's teardown can release them. `unwrap` throws a
    // `PhaseFailure` straight up the call stack, so a post-dispatch step that
    // returns early/throws BEFORE `tearDownSession` runs would strand the VM +
    // the secret manager. Guard the whole post-dispatch path: on any throw, tear
    // the dispatch down before propagating (idempotent — the dispatcher's
    // teardown() guards re-entry, so the normal success path's tearDownSession is
    // never double-counted).
    return this.runSessionOrTeardown(ctx, {
      resolved,
      cancelSignal,
      attempt,
      acpReachUrl: bridge.acpReachUrl,
    });
  }

  /**
   * Drive the post-dispatch path (bridge connect → session init → turn loop →
   * teardown) with a teardown safety net: any throw before the normal
   * `tearDownSession` runs still releases the Gondolin handle (close VM +
   * deregister the secret manager) so a post-dispatch failure cannot leak the VM.
   * The dispatch teardown is idempotent, so re-running it from the catch after an
   * inner `tearDownSession` already fired is a no-op.
   */
  private async runSessionOrTeardown(
    ctx: SessionContext,
    args: {
      resolved: ResolvedDispatchConfig;
      cancelSignal: { cancelled: boolean };
      attempt: number | null;
      acpReachUrl: string;
    },
  ): Promise<RunAttemptResult> {
    try {
      const session = this.unwrap(
        await this.connectBridgeAndInitSession({
          ctx,
          resolved: args.resolved,
          cancelSignal: args.cancelSignal,
          acpReachUrl: args.acpReachUrl,
        }),
      );
      const activeStates = new Set(activeStateNames(this.cfg.states).map((s) => s.toLowerCase()));
      const loopRes = await this.runTurnLoop({
        ctx,
        client: session.client,
        resolved: args.resolved,
        cancelSignal: args.cancelSignal,
        attempt: args.attempt,
        activeStates,
      });
      clearInterval(session.cancelCheckTimer);
      const tearReason =
        loopRes.kind === 'mid_failure' ? loopRes.cleanupReason : loopRes.lastReason;
      const nonRouted = await this.tearDownSession(ctx, tearReason);
      return composeAttemptResult({ loopRes, sessionId: session.sessionId, nonRouted });
    } catch (err) {
      // A post-dispatch step threw without unwinding the dispatch (e.g. an
      // unexpected throw inside session init that bypassed its own teardown).
      // Release the VM + secret registration before re-propagating.
      await this.teardownDispatch(ctx, 'post_dispatch_failure');
      throw err;
    }
  }

  /** Convert a PhaseResult into either the success value or a thrown PhaseFailure. */
  private unwrap<T>(res: PhaseResult<T>): T {
    if (!res.ok) throw new PhaseFailure(res.result);
    return res.value;
  }

  // -------------------------------------------------------------------------
  // Phase 1: dispatch resolution
  // -------------------------------------------------------------------------

  /**
   * Pin adapter/model/max_turns once at attempt start. Every downstream read
   * goes through `resolved`, not the live `this.cfg.acp.*` — that way a
   * workflow reload mid-attempt cannot redirect the adapter or change the
   * budget. Fails fast on unknown adapter (defense in depth — validateDispatch
   * + per-state validation should have caught it earlier).
   */
  private resolveAttemptDispatch(
    issue: Issue,
    logger: ReturnType<typeof withIssue>,
  ): PhaseResult<ResolvedDispatchConfig> {
    let resolved: ResolvedDispatchConfig;
    try {
      resolved = resolveDispatchConfig(this.cfg, issue.state);
    } catch (err) {
      logger.error('dispatch resolution failed', {
        error: (err as Error).message,
        state: issue.state,
      });
      return failPhase('dispatch resolution error');
    }
    if (!isKnownAdapter(resolved.adapter)) {
      logger.error('unknown acp adapter for state', {
        adapter: resolved.adapter,
        state: issue.state,
      });
      return failPhase('unknown acp adapter');
    }
    return { ok: true, value: resolved };
  }

  /**
   * Build the per-issue hook capture closure used by every workspace hook
   * invocation in this attempt. Returns `undefined` when no run log was
   * provided (production always wires one in; tests may not).
   */
  private makeHookCapture(
    runLog: RunLog | undefined,
  ): (hook: string) => HookCapture | undefined {
    return (hook: string): HookCapture | undefined =>
      runLog
        ? {
            onChunk: (stream, text) =>
              runLog.record({ channel: 'hook', hook, stream, text }),
            onResult: (r: HookResult) =>
              runLog.record({
                channel: 'hook',
                hook,
                kind: 'result',
                exit_code: r.exit_code,
                signal: r.signal,
                timed_out: r.timed_out,
              }),
          }
        : undefined;
  }

  // -------------------------------------------------------------------------
  // Phase 2: workspace setup (ensureFor + base fetch + before_run)
  // -------------------------------------------------------------------------

  private async setupWorkspace(
    issue: Issue,
    initialHooks: ReturnType<typeof resolveHooksForState>,
    hookCapture: (h: string) => HookCapture | undefined,
    runLog: RunLog | undefined,
    logger: ReturnType<typeof withIssue>,
  ): Promise<PhaseResult<{ workspace: Awaited<ReturnType<WorkspaceManager['ensureFor']>> }>> {
    let workspace: Awaited<ReturnType<WorkspaceManager['ensureFor']>>;
    try {
      workspace = await this.workspaces.ensureFor(
        issue.identifier,
        initialHooks,
        hookCapture('after_create'),
      );
    } catch (err) {
      logger.error('workspace error', { error: (err as Error).message });
      return failPhase('workspace error');
    }
    const fetchRes = await this.fetchBaseBranch(workspace.path, runLog, logger);
    if (!fetchRes.ok) return fetchRes;
    try {
      await this.workspaces.runBeforeRun(workspace.path, initialHooks, hookCapture('before_run'));
    } catch (err) {
      logger.error('before_run hook failed', { error: (err as Error).message });
      return failPhase('before_run hook error');
    }
    return { ok: true, value: { workspace } };
  }

  /**
   * Issue 101: a fresh `origin/<base>` is a dispatch precondition. The host
   * fetches it before every dispatch (fresh OR re-dispatch) so the agent's
   * first step — `git rebase origin/<base>` — runs against a current ref.
   * Skipped cleanly in local-only mode (no `origin` configured) — the source
   * repo's local `<base>` is the only truth there.
   */
  private async fetchBaseBranch(
    workspacePath: string,
    runLog: RunLog | undefined,
    logger: ReturnType<typeof withIssue>,
  ): Promise<PhaseResult<void>> {
    const envBase = process.env.SYMPHONY_BASE_BRANCH;
    const baseBranch = envBase && envBase.length > 0 ? envBase : 'main';
    const fetchResult = await fetchBaseInWorkspace(workspacePath, baseBranch);
    if (!fetchResult.ok) {
      logger.error('pre-dispatch base fetch failed; aborting attempt', {
        base_branch: baseBranch,
        error: fetchResult.diagnostic,
      });
      runLog?.system('pre_dispatch_base_fetch_failed', {
        base_branch: baseBranch,
        error: fetchResult.diagnostic,
      });
      return failPhase('pre-dispatch base fetch failed');
    }
    if (!fetchResult.skipped) {
      runLog?.system('pre_dispatch_base_fetch_ok', { base_branch: baseBranch });
    }
    return { ok: true, value: undefined };
  }

  // -------------------------------------------------------------------------
  // Phase 3: adapter runtime preparation (credentials + injections)
  // -------------------------------------------------------------------------

  /**
   * Apply model/effort runtime injections and seal the adapter runtime the
   * Gondolin dispatcher launches. Pre-handshake failures unwind through the
   * normal phase pipeline.
   *
   * Credentials never enter the VM: the dispatcher stages per-adapter FAKE
   * native creds (placeholders only) and registers a per-VM `secretManager`
   * that substitutes the real token at egress (Gondolin secret-substitution).
   * There is no credential proxy and no base-URL injection — the in-VM client
   * dials its REAL upstream in native mode with the placeholder bearer. So this
   * phase produces only the model/effort knobs (env vars, extra argv, and the
   * non-secret staged files like claude's `settings.json` effortLevel), which
   * ride through the dispatch options.
   */
  private prepareAdapterRuntime(
    resolved: ResolvedDispatchConfig,
    logger: ReturnType<typeof withIssue>,
  ): PhaseResult<AdapterRuntime> {
    const profile = ADAPTERS[resolved.adapter];
    const injectedRes = this.applyRuntimeInjectionsOrFail(profile, resolved, logger);
    if (!injectedRes.ok) return injectedRes;
    return {
      ok: true,
      value: {
        profile,
        adapterBin: profile.binary[0]!,
        effectiveAdapterArgs: [...profile.binary.slice(1), ...injectedRes.value.runtimeArgs],
        runtimeEnv: injectedRes.value.runtimeEnv,
        // Model/effort staged files (claude effortLevel settings.json) carry
        // their content in-memory, so they are passed straight to the dispatcher
        // as guest writes — no workspace staging + in-VM `cp` preamble.
        extraGuestFiles: injectedRes.value.runtimeExtraFiles,
      },
    };
  }

  private applyRuntimeInjectionsOrFail(
    profile: AdapterProfile,
    resolved: ResolvedDispatchConfig,
    logger: ReturnType<typeof withIssue>,
  ): PhaseResult<{ runtimeEnv: Record<string, string>; runtimeArgs: string[]; runtimeExtraFiles: GuestCredFile[] }> {
    try {
      const injected = this.applyRuntimeInjections(profile, resolved);
      return { ok: true, value: injected };
    } catch (err) {
      logger.error('runtime injection staging failed', { adapter: profile.id, error: (err as Error).message });
      return failPhase('runtime injection staging error');
    }
  }

  /**
   * Compose the model + effort injections through the three orthogonal
   * channels the adapter profile declares: env vars (claude-agent-acp's
   * ANTHROPIC_MODEL), extra argv (codex-acp's `-c model=...`), and staged
   * files (claude-agent-acp's settings.json for `effortLevel`). Pure: the
   * staged-file content is known in-memory and converted directly to guest
   * writes (no FS staging).
   */
  private applyRuntimeInjections(
    profile: AdapterProfile,
    resolved: ResolvedDispatchConfig,
  ): {
    runtimeEnv: Record<string, string>;
    runtimeArgs: string[];
    runtimeExtraFiles: GuestCredFile[];
  } {
    const acc = { runtimeEnv: {} as Record<string, string>, runtimeArgs: [] as string[], runtimeExtraFiles: [] as GuestCredFile[] };
    if (resolved.model) {
      this.applyModelInjection(profile.modelInjection(resolved.model), acc);
    }
    if (resolved.effort && profile.effortInjection) {
      this.applyModelInjection(profile.effortInjection(resolved.effort), acc);
    }
    return acc;
  }

  /** Fold one injection into the accumulator (env / args / guest files). */
  private applyModelInjection(
    inj: ModelInjection,
    acc: {
      runtimeEnv: Record<string, string>;
      runtimeArgs: string[];
      runtimeExtraFiles: GuestCredFile[];
    },
  ): void {
    if (inj.env) {
      for (const [k, v] of Object.entries(inj.env)) acc.runtimeEnv[k] = v;
    }
    if (inj.extraArgs) acc.runtimeArgs.push(...inj.extraArgs);
    if (inj.stagedFiles) {
      for (const f of inj.stagedFiles) {
        acc.runtimeExtraFiles.push({ guestPath: f.guestPath, content: f.content, mode: 0o600 });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Phase 4: bridge presence + reach URL
  // -------------------------------------------------------------------------

  /**
   * The TCP bridge is mandatory — without it there is no transport for ACP
   * frames. Returns the reach URL the in-VM agent will dial back to,
   * preferring the explicit `reach_url` override over the host/port derived
   * from the bridge's bound port.
   */
  private validateAcpBridge(
    logger: ReturnType<typeof withIssue>,
  ): PhaseResult<{ acpReachUrl: string }> {
    if (!this.acpBridge) {
      logger.error('acp bridge is not configured', {});
      return failPhase('acp bridge unavailable');
    }
    const port = this.acpBridge.port() ?? this.cfg.acp.bridge.bind_port;
    const acpReachUrl =
      this.cfg.acp.bridge.reach_url ?? `tcp://${this.cfg.acp.bridge.reach_host}:${port}`;
    return { ok: true, value: { acpReachUrl } };
  }

  // -------------------------------------------------------------------------
  // Phase 5: VM bring-up + bridge register + exec stream
  // -------------------------------------------------------------------------

  /**
   * Bring up the per-issue VM, register with the ACP bridge, and start the
   * in-VM proxy via Gondolin exec. VM start happens BEFORE bridge register so a
   * `register()` synchronous throw cannot leave us with a half-staged
   * registration whose `accepted` promise has no `.catch` attached yet
   * (Node ≥ 15 crashes on unhandled rejections).
   */
  private async bringUpVmAndExec(args: {
    issue: Issue;
    resolved: ResolvedDispatchConfig;
    workspacePath: string;
    adapter: AdapterRuntime;
    runLog: RunLog | undefined;
    logger: ReturnType<typeof withIssue>;
  }): Promise<PhaseResult<VmExecHandle>> {
    const dispatcherRes = this.buildDispatcherOrFail(args.resolved, args.logger);
    if (!dispatcherRes.ok) return dispatcherRes;
    const bridgePort = this.acpBridge!.port() ?? this.cfg.acp.bridge.bind_port;
    const bridgeHost = this.cfg.acp.bridge.reach_host;
    // Register the bridge FIRST so the dispatch launch env carries the bearer.
    // `register()` attaches its own internal `.catch`, so a cancel before the
    // caller's `await accepted` cannot escalate to an unhandled rejection.
    const regRes = this.registerBridgeOrFail(args.issue, args.logger);
    if (!regRes.ok) return regRes;
    const bridgeReg = regRes.value.bridgeReg;
    try {
      const handle = await dispatcherRes.value.dispatch(
        this.buildDispatchOptions({ ...args, bridgeHost, bridgePort, bridgeReg }),
      );
      return {
        ok: true,
        value: { vm: handle.vm, exec: handle.exec, bridgeReg, teardownDispatch: handle.teardown },
      };
    } catch (err) {
      // The dispatch failed mid-bring-up. Cancel the bridge registration (the VM,
      // if it came up, is torn down by the dispatcher's own error path); the
      // reconciler GC converges any session that leaked past close().
      bridgeReg.cancel('gondolin_dispatch_failed');
      args.logger.error('gondolin dispatch failed', { error: (err as Error).message });
      return failPhase('gondolin dispatch error');
    }
  }

  /**
   * Build the per-dispatch `GondolinDispatcher` for the resolved adapter. The
   * VM client, credential registry, and Gondolin VM shape are injected once at
   * composition time; the per-adapter hooks config (allowlist + placeholder
   * secret + request/response hooks) selects the credential routing. Fails fast
   * if any collaborator is unwired (the composition root guarantees them).
   */
  private buildDispatcherOrFail(
    resolved: ResolvedDispatchConfig,
    logger: ReturnType<typeof withIssue>,
  ): PhaseResult<GondolinDispatcher> {
    if (!this.credentialRegistry || !this.adapterHooks || !this.gondolinVmConfig) {
      logger.error('gondolin dispatch collaborators are not wired', {
        registry: this.credentialRegistry !== null,
        hooks: this.adapterHooks !== null,
        vmConfig: this.gondolinVmConfig !== null,
      });
      return failPhase('gondolin dispatch unavailable');
    }
    const hooks = this.adapterHooks[resolved.adapter];
    if (!hooks) {
      logger.error('no gondolin hooks config for adapter', { adapter: resolved.adapter });
      return failPhase('gondolin adapter hooks unavailable');
    }
    return {
      ok: true,
      value: new GondolinDispatcher(
        this.vmClient,
        this.credentialRegistry,
        hooks,
        this.gondolinVmConfig,
      ),
    };
  }

  /**
   * Assemble the `GondolinDispatchOptions` for a dispatch. Mounts (workspace RW
   * + configured volumes + eval-mode RO) are validated by the Phase 3 guard
   * inside the dispatcher; the forwarded boot env is stripped of all credential
   * vars there too. The adapter bin/args/runtime-env + the non-secret runtime
   * files (effort settings.json) ride through; the bridge host/port + bearer
   * become the dispatch's ACP wiring.
   */
  private buildDispatchOptions(args: {
    issue: Issue;
    resolved: ResolvedDispatchConfig;
    workspacePath: string;
    adapter: AdapterRuntime;
    runLog: RunLog | undefined;
    logger: ReturnType<typeof withIssue>;
    bridgeHost: string;
    bridgePort: number;
    bridgeReg: AcpBridgeRegistration;
  }): GondolinDispatchOptions {
    return {
      identifier: sanitizeWorkspaceKey(args.issue.identifier).toLowerCase(),
      mounts: this.buildVmMounts(args.workspacePath, args.resolved),
      env: this.buildForwardedEnv(),
      workdir: args.workspacePath,
      bridgeHost: args.bridgeHost,
      bridgePort: args.bridgePort,
      acpToken: args.bridgeReg.token,
      adapterBin: args.adapter.adapterBin,
      adapterArgs: args.adapter.effectiveAdapterArgs,
      runtimeEnv: args.adapter.runtimeEnv,
      extraGuestFiles: args.adapter.extraGuestFiles,
      opencodeModel: args.resolved.model,
      onStderr: (chunk) => this.onAgentStderr(chunk, args.issue, args.runLog, args.logger),
    };
  }

  private buildVmMounts(
    workspacePath: string,
    resolved: ResolvedDispatchConfig,
  ): Array<{ host: string; guest: string; readonly: boolean }> {
    const mounts: Array<{ host: string; guest: string; readonly: boolean }> = [
      { host: workspacePath, guest: workspacePath, readonly: false },
    ];
    for (const v of this.cfg.gondolin.volumes) {
      mounts.push({ host: v.host, guest: v.guest, readonly: v.readonly });
    }
    for (const m of buildEvalModeMounts(this.cfg, resolved)) {
      mounts.push(m);
    }
    return mounts;
  }

  /**
   * Forward the configured `gondolin.forward_env` vars into the VM boot env, then
   * STRIP every credential-bearing var via `stripCredentialEnv` (defense in depth).
   * `forward_env` can name a real cred var (e.g. `OPENAI_API_KEY`), so this strip
   * makes "no real token reaches the guest boot env" obvious AT THE SOURCE rather
   * than only inside the dispatcher. The dispatcher's `buildCreateVmOptions`
   * re-applies the SAME `stripCredentialEnv` as the enforcement chokepoint — the
   * double-strip is idempotent (`stripCredentialEnv` is a pure filter), so the two
   * layers compose without surprise. The guest holds only the placeholder bearer
   * Gondolin substitutes at egress (the host-only-refresh invariant). No per-adapter
   * omit is needed here (the strip is uniform + strictly stronger).
   */
  private buildForwardedEnv(): Record<string, string> {
    return stripCredentialEnv(
      computeForwardedEnv(this.cfg.gondolin.forward_env, undefined, (k) => process.env[k]),
    );
  }

  private registerBridgeOrFail(
    issue: Issue,
    logger: ReturnType<typeof withIssue>,
  ): PhaseResult<{ bridgeReg: AcpBridgeRegistration }> {
    try {
      const bridgeReg = this.acpBridge!.register(issue.id, issue.identifier);
      return { ok: true, value: { bridgeReg } };
    } catch (err) {
      logger.error('acp bridge register failed', { error: (err as Error).message });
      return failPhase('acp bridge register failed');
    }
  }

  /**
   * The diagnostic-stderr sink the dispatcher pipes the in-VM agent's stderr to.
   * Mirrors the old `attachStderrTap`: records to the run log, surfaces a
   * truncated `agent_stderr` runtime event, and logs at info. Wired before the
   * bridge handshake (the dispatcher taps stderr at launch) so a pre-connect
   * crash still surfaces.
   */
  private onAgentStderr(
    chunk: string,
    issue: Issue,
    runLog: RunLog | undefined,
    logger: ReturnType<typeof withIssue>,
  ): void {
    runLog?.record({ channel: 'stderr', text: chunk });
    const text = chunk.trim();
    if (text.length === 0) return;
    const truncated =
      text.length > AgentRunner.STDERR_RING_LIMIT
        ? text.slice(0, AgentRunner.STDERR_RING_LIMIT) + '…'
        : text;
    this.events.onRuntimeEvent(issue.id, {
      at: new Date().toISOString(),
      event: 'agent_stderr',
      message: truncated,
    });
    logger.info('agent stderr', { text: text.slice(0, AgentRunner.STDERR_LOG_LIMIT) });
  }

  // -------------------------------------------------------------------------
  // Phase 6: bridge connect + MCP setup + AcpClient + initSession
  // -------------------------------------------------------------------------

  private async connectBridgeAndInitSession(args: {
    ctx: SessionContext;
    resolved: ResolvedDispatchConfig;
    cancelSignal: { cancelled: boolean };
    acpReachUrl: string;
  }): Promise<PhaseResult<{
    client: AcpClient;
    sessionId: string;
    cancelCheckTimer: ReturnType<typeof setInterval>;
  }>> {
    const connRes = await this.waitForBridgeAccept(args.ctx, args.acpReachUrl);
    if (!connRes.ok) {
      await this.tearDownSession(args.ctx, 'acp_bridge_connect_failed');
      return connRes;
    }
    args.ctx.acpSocket = connRes.value.acpSocket;
    const clientRef: { current: AcpClient | null } = { current: null };
    const cancelCheckTimer = this.startCancelTimer(args.ctx, args.cancelSignal, clientRef);
    const mcpRes = this.setupMcpForAttempt(args.ctx);
    if (!mcpRes.ok) {
      await this.cancelAndTearDown(args.ctx, cancelCheckTimer, mcpRes.cleanupReason);
      return { ok: false, result: mcpRes.result };
    }
    const client = this.buildAcpClient(args.ctx, mcpRes.value.mcpServers);
    clientRef.current = client;
    const sessRes = await this.initAcpSession(args.ctx, client, args.resolved);
    if (!sessRes.ok) {
      await this.cancelAndTearDown(args.ctx, cancelCheckTimer, 'init_failed');
      return sessRes;
    }
    this.emitSessionStarted(args.ctx, sessRes.value.sessionId);
    return { ok: true, value: { client, sessionId: sessRes.value.sessionId, cancelCheckTimer } };
  }

  private async cancelAndTearDown(
    ctx: SessionContext,
    timer: ReturnType<typeof setInterval>,
    reason: string,
  ): Promise<void> {
    clearInterval(timer);
    await this.tearDownSession(ctx, reason);
  }

  private buildAcpClient(ctx: SessionContext, mcpServers: McpServer[]): AcpClient {
    return new AcpClient({
      stdin: ctx.acpSocket!,
      stdout: ctx.acpSocket!,
      stderr: ctx.exec.stderr,
      cwd: ctx.workspacePath,
      readTimeoutMs: this.cfg.acp.read_timeout_ms,
      promptTimeoutMs: this.cfg.acp.prompt_timeout_ms,
      onEvent: (event) => this.events.onRuntimeEvent(ctx.issue.id, event),
      onTokenUsage: (u) => this.events.onTokenUsage(ctx.issue.id, u),
      mcpServers,
      runLog: ctx.runLog,
    });
  }

  private emitSessionStarted(ctx: SessionContext, sessionId: string): void {
    this.events.onSessionStarted?.({
      issueId: ctx.issue.id,
      sessionId,
      threadId: sessionId,
      pid: ctx.exec.pid ? String(ctx.exec.pid) : null,
    });
  }

  /**
   * Race the bridge handshake against a configured connect timeout. A stuck
   * VM or misconfigured `reach_host` would otherwise hang the attempt until
   * the orchestrator's stall timer fires much later.
   */
  private async waitForBridgeAccept(
    ctx: SessionContext,
    acpReachUrl: string,
  ): Promise<PhaseResult<{ acpSocket: Socket }>> {
    try {
      const acpSocket = await Promise.race([
        ctx.bridgeReg.accepted,
        new Promise<Socket>((_, reject) =>
          setTimeout(
            () => reject(new Error('acp bridge: in-VM agent did not connect in time')),
            this.cfg.acp.bridge.connect_timeout_ms,
          ),
        ),
      ]);
      ctx.runLog?.system('acp_bridge_connected', { reach_url: acpReachUrl });
      return { ok: true, value: { acpSocket } };
    } catch (err) {
      ctx.logger.error('acp bridge connect timeout', { error: (err as Error).message });
      ctx.runLog?.system('acp_bridge_failed', { error: (err as Error).message });
      return failPhase('acp bridge connect failed');
    }
  }

  /**
   * Start the periodic cancel check. The polite path is `client.cancel()`
   * (session/cancel over ACP); the belt-and-braces path is `forceClose()` to
   * unwind a stuck `runPrompt()` plus `execStream.kill()` and socket destroy
   * to break the transport. `clientRef.current` may briefly be null between
   * timer start and AcpClient construction; the `?.` keeps that race safe.
   */
  private startCancelTimer(
    ctx: SessionContext,
    cancelSignal: { cancelled: boolean },
    clientRef: { current: AcpClient | null },
  ): ReturnType<typeof setInterval> {
    const onCancel = (): void => {
      if (!cancelSignal.cancelled) return;
      const c = clientRef.current;
      c?.cancel().catch(() => undefined);
      c?.forceClose('cancel_requested');
      try { ctx.exec.kill(); } catch { /* idempotent */ }
      if (ctx.acpSocket && !ctx.acpSocket.destroyed) {
        try { ctx.acpSocket.destroy(); } catch { /* idempotent */ }
      }
    };
    return setInterval(onCancel, 500);
  }

  /**
   * Wire the MCP registry servers list for AcpClient. MCP is mandatory for
   * symphony operations (`transition`, `request_human_steering`); fail fast
   * if the registry or the reachable URL is missing.
   */
  private setupMcpForAttempt(
    ctx: SessionContext,
  ): { ok: true; value: { mcpServers: McpServer[] } } | { ok: false; result: RunAttemptResult; cleanupReason: string } {
    const mcpServers: McpServer[] = [];
    if (!this.cfg.mcp.enabled || !ctx.runningEntry) {
      return { ok: true, value: { mcpServers } };
    }
    if (!this.mcp) {
      ctx.logger.error('mcp is required but no registry is wired into the runner', {});
      return {
        ok: false,
        result: { ok: false, reason: 'mcp required but registry unavailable', threadId: null, turnsCompleted: 0 },
        cleanupReason: 'mcp_registry_unavailable',
      };
    }
    const url = this.mcp.buildUrl(ctx.runningEntry.identifier, {
      host: this.cfg.mcp.host,
      explicit_host_url: this.cfg.mcp.explicit_host_url,
    });
    if (!url) {
      ctx.logger.error('mcp is required but no reachable URL is configured', {
        host: this.cfg.mcp.host,
        explicit_host_url: this.cfg.mcp.explicit_host_url,
      });
      return {
        ok: false,
        result: {
          ok: false,
          reason: 'mcp required but URL unavailable (start the HTTP server or set mcp.host_url)',
          threadId: null,
          turnsCompleted: 0,
        },
        cleanupReason: 'mcp_url_unavailable',
      };
    }
    const token = this.mcp.activate(ctx.runningEntry);
    mcpServers.push({
      type: 'http',
      name: 'symphony',
      url,
      headers: [{ name: 'Authorization', value: `Bearer ${token}` }],
    });
    ctx.logger.debug('mcp registered', { url });
    return { ok: true, value: { mcpServers } };
  }

  private async initAcpSession(
    ctx: SessionContext,
    client: AcpClient,
    resolved: ResolvedDispatchConfig,
  ): Promise<PhaseResult<{ sessionId: string }>> {
    try {
      const sess = await client.initSession();
      return { ok: true, value: { sessionId: sess.sessionId } };
    } catch (err) {
      ctx.logger.error('acp init failed', {
        error: (err as Error).message,
        adapter: resolved.adapter,
      });
      this.events.onRuntimeEvent(ctx.issue.id, {
        at: new Date().toISOString(),
        event: 'startup_failed',
        message: (err as Error).message,
      });
      return failPhase('agent session startup error');
    }
  }

  // -------------------------------------------------------------------------
  // Phase 7: autonomous turn loop
  // -------------------------------------------------------------------------

  /**
   * Drive the ACP loop. Runs as long as the agent keeps engaging — only
   * autonomous turns count against max_turns; steering-reply turns are free
   * because the human is in the loop.
   */
  private async runTurnLoop(args: {
    ctx: SessionContext;
    client: AcpClient;
    resolved: ResolvedDispatchConfig;
    cancelSignal: { cancelled: boolean };
    attempt: number | null;
    activeStates: ReadonlySet<string>;
  }): Promise<TurnLoopResult> {
    const state: TurnLoopState = {
      turnsCompleted: 0,
      autonomousTurns: 0,
      lastReason: 'unknown',
      agentFailure: null,
      currentIssue: args.ctx.issue,
      pendingSteering: null,
      firstTurn: true,
    };
    while (true) {
      const iter = await this.runTurnIteration({ ...args, state });
      if (iter.kind === 'mid_failure') {
        return { kind: 'mid_failure', publicReason: iter.publicReason, cleanupReason: iter.cleanupReason, turnsCompleted: state.turnsCompleted };
      }
      if (iter.kind === 'break') break;
    }
    return { kind: 'done', lastReason: state.lastReason, agentFailure: state.agentFailure, turnsCompleted: state.turnsCompleted };
  }

  private async runTurnIteration(args: {
    ctx: SessionContext;
    client: AcpClient;
    resolved: ResolvedDispatchConfig;
    cancelSignal: { cancelled: boolean };
    attempt: number | null;
    activeStates: ReadonlySet<string>;
    state: TurnLoopState;
  }): Promise<IterationResult> {
    const { ctx, client, resolved, cancelSignal, attempt, activeStates, state } = args;
    if (cancelSignal.cancelled) {
      state.lastReason = 'cancelled_by_reconciliation';
      return { kind: 'break' };
    }
    const promptRes = await this.prepareTurnPrompt(state, attempt, ctx.logger);
    if (promptRes.kind === 'mid_failure') return promptRes;
    const isSteeringReply = state.pendingSteering !== null;
    state.pendingSteering = null;
    state.firstTurn = false;
    this.events.onTurn(ctx.issue.id, state.turnsCompleted + 1);
    const outcome = await client.runPrompt(promptRes.prompt);
    const turnRes = this.applyTurnOutcome(state, outcome, ctx.runningEntry, isSteeringReply);
    if (turnRes.kind === 'break') return turnRes;
    return await this.handlePostTurnFlow({ ctx, cancelSignal, activeStates, resolved, state });
  }

  private async prepareTurnPrompt(
    state: TurnLoopState,
    attempt: number | null,
    logger: ReturnType<typeof withIssue>,
  ): Promise<{ kind: 'ok'; prompt: string } | { kind: 'mid_failure'; publicReason: string; cleanupReason: string }> {
    try {
      const prompt = await this.composeTurnPrompt(state, attempt);
      return { kind: 'ok', prompt };
    } catch (err) {
      logger.error('prompt rendering failed', { error: (err as Error).message });
      return { kind: 'mid_failure', publicReason: 'prompt error', cleanupReason: 'prompt_error' };
    }
  }

  /**
   * Render the prompt for the next iteration via the pure `selectPromptKind`
   * helper. Steering replies trump everything (the human is in the loop);
   * the first turn gets the full template; later autonomous turns get the
   * bare continuation prompt.
   */
  private async composeTurnPrompt(state: TurnLoopState, attempt: number | null): Promise<string> {
    const kind = selectPromptKind({
      pendingSteering: state.pendingSteering !== null,
      firstTurn: state.firstTurn,
    });
    if (kind === 'steering') {
      const ps = state.pendingSteering!;
      return buildSteeringReplyPrompt(ps.question, ps.context, ps.reply);
    }
    if (kind === 'initial') {
      return renderPrompt({
        template: this.workflow.prompt_template,
        issue: state.currentIssue,
        attempt,
      });
    }
    return continuationPrompt(this.cfg.mcp.enabled);
  }

  /**
   * Classify the runPrompt outcome (delegated to pure `classifyTurnOutcome`)
   * and update the turn counters. Returns the next loop control: `break`
   * collapses agent failure / agent_transitioned into a single break signal
   * with state already populated; `continue` falls through to post-turn flow.
   */
  private applyTurnOutcome(
    state: TurnLoopState,
    outcome: { reason: string; message: string },
    runningEntry: RunningEntry | undefined,
    isSteeringReply: boolean,
  ): { kind: 'break' } | { kind: 'continue' } {
    const cls = classifyTurnOutcome({
      outcomeReason: outcome.reason,
      outcomeMessage: outcome.message,
      transitioned: runningEntry?.transitioned === true,
    });
    if (cls.kind === 'agent_failure') {
      state.agentFailure = cls.agentFailure;
      state.lastReason = cls.reason;
      return { kind: 'break' };
    }
    if (cls.kind === 'agent_transitioned') {
      state.lastReason = 'agent_transitioned';
      return { kind: 'break' };
    }
    state.turnsCompleted++;
    if (!isSteeringReply) state.autonomousTurns++;
    return { kind: 'continue' };
  }

  /**
   * Post-turn flow: tool-driven exit > steering pause > tracker refresh +
   * continuation decision. The tracker-refresh branch is in its own helper
   * so the orchestrator stays under the shell complexity / statement budget;
   * the pure `decideTurnContinuation` and `handleSteeringRequest` carry the
   * decision-heavy work.
   */
  private async handlePostTurnFlow(args: {
    ctx: SessionContext;
    cancelSignal: { cancelled: boolean };
    activeStates: ReadonlySet<string>;
    resolved: ResolvedDispatchConfig;
    state: TurnLoopState;
  }): Promise<IterationResult> {
    const { ctx, cancelSignal, activeStates, resolved, state } = args;
    if (ctx.runningEntry?.transitioned) {
      state.lastReason = 'agent_transitioned';
      return { kind: 'break' };
    }
    if (ctx.runningEntry?.steering_requested && this.mcp) {
      return await this.handleSteeringBranch(ctx, ctx.runningEntry, cancelSignal, state);
    }
    return await this.refreshAndDecideContinuation({ ctx, activeStates, resolved, state });
  }

  private async handleSteeringBranch(
    ctx: SessionContext,
    entry: RunningEntry,
    cancelSignal: { cancelled: boolean },
    state: TurnLoopState,
  ): Promise<IterationResult> {
    const steer = await this.handleSteeringRequest(ctx, entry, cancelSignal);
    if (steer.kind === 'cancelled') {
      state.lastReason = 'cancelled_while_awaiting_steering';
      return { kind: 'break' };
    }
    state.pendingSteering = steer.pendingSteering;
    return { kind: 'continue' };
  }

  private async refreshAndDecideContinuation(args: {
    ctx: SessionContext;
    activeStates: ReadonlySet<string>;
    resolved: ResolvedDispatchConfig;
    state: TurnLoopState;
  }): Promise<IterationResult> {
    const { ctx, activeStates, resolved, state } = args;
    let refreshed: Issue[];
    try {
      refreshed = await this.tracker.fetchIssueStatesByIds([ctx.issue.id]);
    } catch (err) {
      ctx.logger.error('issue state refresh failed', { error: (err as Error).message });
      return { kind: 'mid_failure', publicReason: 'issue state refresh error', cleanupReason: 'issue_state_refresh_failed' };
    }
    const found = refreshed[0] ?? null;
    const cont = decideTurnContinuation({
      refreshedIssue: found,
      activeStates,
      autonomousTurns: state.autonomousTurns,
      maxTurns: resolved.max_turns,
    });
    if (cont.kind === 'break') {
      if (found) state.currentIssue = found;
      state.lastReason = cont.reason;
      return { kind: 'break' };
    }
    state.currentIssue = found!;
    await delay(25);
    return { kind: 'continue' };
  }

  /**
   * Park the autonomous loop on a pending steering request. The wait does
   * not count against max_turns; cancellation breaks via the registry's
   * cancel-aware resolver (which resolves null when `cancelSignal.cancelled`
   * flips).
   */
  private async handleSteeringRequest(
    ctx: SessionContext,
    entry: RunningEntry,
    cancelSignal: { cancelled: boolean },
  ): Promise<
    | { kind: 'cancelled' }
    | { kind: 'received'; pendingSteering: { question: string; context: string | null; reply: string } }
  > {
    const question = entry.steering_question ?? '';
    const context = entry.steering_context;
    const limit = AgentRunner.STEERING_PREVIEW_LIMIT;
    this.events.onRuntimeEvent(ctx.issue.id, {
      at: new Date().toISOString(),
      event: 'awaiting_human_steering',
      message: question.length > limit ? question.slice(0, limit) + '…' : question,
    });
    const reply = await this.mcp!.awaitSteeringReply(ctx.issue.identifier, cancelSignal);
    if (reply === null) return { kind: 'cancelled' };
    entry.steering_requested = false;
    entry.steering_question = null;
    entry.steering_context = null;
    this.events.onRuntimeEvent(ctx.issue.id, {
      at: new Date().toISOString(),
      event: 'human_steering_received',
      message: reply.length > limit ? reply.slice(0, limit) + '…' : reply,
    });
    return { kind: 'received', pendingSteering: { question, context, reply } };
  }

  // -------------------------------------------------------------------------
  // Phase 8: session teardown (consolidates the old `cleanup(reason)` closure)
  // -------------------------------------------------------------------------

  /**
   * Unwind a session: cancel the bridge registration, destroy the socket and
   * kill the launch exec, deactivate MCP, run the per-state `actions:` block
   * (which may `run_in_vm` against the still-live VM), THEN tear down the
   * Gondolin dispatch — close the VM and deregister the per-VM secret manager.
   * The dispatch owns the VM lifecycle now (Gondolin), so teardown is synchronous
   * here rather than deferred to the reconciler.
   *
   * Returns the non-routed action failure reason, or null when the cleanup
   * succeeded or routed (so the caller can fold it into `decideAttemptOutcome`).
   */
  private async tearDownSession(ctx: SessionContext, reason: string): Promise<string | null> {
    this.detachSession(ctx, reason);
    await this.awaitExecExit(ctx.exec);
    this.deactivateMcpForEntry(ctx.runningEntry);
    ctx.logger.debug('agent runner cleanup', { reason });
    const nonRouted = await this.runCleanupActions(
      ctx.issue,
      resolveCleanupState(ctx.issue, ctx.runningEntry),
      ctx.runningEntry,
      ctx.workspacePath,
      // run_in_vm cleanup execs into the live dispatch VM before it is closed below.
      ctx.vm,
      ctx.hookCapture,
      ctx.runLog,
    );
    await this.teardownDispatch(ctx, reason);
    return nonRouted;
  }

  private detachSession(ctx: SessionContext, reason: string): void {
    ctx.bridgeReg.cancel(reason);
    try {
      if (ctx.acpSocket && !ctx.acpSocket.destroyed) ctx.acpSocket.destroy();
    } catch { /* ignore */ }
    try { ctx.exec.kill(); } catch { /* ignore */ }
  }

  private async awaitExecExit(exec: VmExec): Promise<void> {
    try { await exec.exit; } catch { /* ignore */ }
  }

  private deactivateMcpForEntry(entry: RunningEntry | undefined): void {
    if (this.mcp && entry) this.mcp.deactivate(entry.identifier);
  }

  /**
   * Close the dispatch's VM + deregister its secret manager (idempotent — the
   * dispatcher's `teardown()` guards re-entry). Runs after the cleanup actions
   * so `run_in_vm` still sees a live VM. A null teardown (the dispatch never
   * came up) is a no-op.
   */
  private async teardownDispatch(ctx: SessionContext, reason: string): Promise<void> {
    if (!ctx.teardownDispatch) return;
    ctx.runLog?.system('vm_teardown', { reason });
    try {
      await ctx.teardownDispatch();
    } catch (err) {
      ctx.logger.warn('gondolin dispatch teardown threw', { error: (err as Error).message });
    }
  }
}

// ---------------------------------------------------------------------------
// Phase pipeline glue: types + helpers used by runAttemptCore + each phase.
// Kept at module scope (not nested in AgentRunner) so they remain unit-testable
// and so the class stays focused on orchestration rather than plumbing.
// ---------------------------------------------------------------------------

type PhaseResult<T> = { ok: true; value: T } | { ok: false; result: RunAttemptResult };

class PhaseFailure extends Error {
  constructor(public readonly attemptResult: RunAttemptResult) {
    super(`phase_failure: ${attemptResult.reason}`);
    this.name = 'PhaseFailure';
  }
}

function failPhase(reason: string): { ok: false; result: RunAttemptResult } {
  return { ok: false, result: { ok: false, reason, threadId: null, turnsCompleted: 0 } };
}

interface AdapterRuntime {
  profile: AdapterProfile;
  adapterBin: string;
  effectiveAdapterArgs: string[];
  runtimeEnv: Record<string, string>;
  /**
   * Non-secret runtime files (model/effort knobs, e.g. claude's
   * `~/.claude/settings.json` effortLevel) the dispatcher writes into the guest
   * before launch. Carries no credential material.
   */
  extraGuestFiles: GuestCredFile[];
}

interface VmExecHandle {
  /** The live dispatch VM handle (run_in_vm cleanup execs into it). */
  vm: VmHandle;
  /** The launched `vm-agent.mjs` exec (process tether + stderr tap). */
  exec: VmExec;
  bridgeReg: AcpBridgeRegistration;
  /** Idempotent dispatch teardown: kill exec, close VM, deregister secret manager. */
  teardownDispatch: () => Promise<void>;
}

/**
 * Mutable context threaded through phases 5–8. `acpSocket` starts null and
 * is filled in once the bridge handshake completes; `tearDownSession` checks
 * for null before destroying so the post-bridge-fail path is a no-op for the
 * socket but still runs the bridge cancel + exec kill + Done-state actions.
 */
interface SessionContext {
  issue: Issue;
  runningEntry: RunningEntry | undefined;
  workspacePath: string;
  /** The dispatch VM handle, or null if the dispatch never came up. */
  vm: VmHandle | null;
  bridgeReg: AcpBridgeRegistration;
  exec: VmExec;
  /** Idempotent Gondolin dispatch teardown; null when the dispatch never came up. */
  teardownDispatch: (() => Promise<void>) | null;
  acpSocket: Socket | null;
  hookCapture: (h: string) => HookCapture | undefined;
  runLog: RunLog | undefined;
  logger: ReturnType<typeof withIssue>;
}

interface TurnLoopState {
  turnsCompleted: number;
  autonomousTurns: number;
  lastReason: string;
  agentFailure: string | null;
  currentIssue: Issue;
  pendingSteering: { question: string; context: string | null; reply: string } | null;
  firstTurn: boolean;
}

type TurnLoopResult =
  | { kind: 'done'; lastReason: string; agentFailure: string | null; turnsCompleted: number }
  | { kind: 'mid_failure'; publicReason: string; cleanupReason: string; turnsCompleted: number };

type IterationResult =
  | { kind: 'continue' }
  | { kind: 'break' }
  | { kind: 'mid_failure'; publicReason: string; cleanupReason: string };

/**
 * Compose the final RunAttemptResult from the turn-loop outcome + teardown
 * action ledger. `mid_failure` (prompt render error, tracker refresh error)
 * gets surfaced verbatim; the happy path delegates to `decideAttemptOutcome`
 * which encodes the agentFailure > non-routed action failure > success
 * precedence.
 */
function composeAttemptResult(input: {
  loopRes: TurnLoopResult;
  sessionId: string;
  nonRouted: string | null;
}): RunAttemptResult {
  if (input.loopRes.kind === 'mid_failure') {
    return {
      ok: false,
      reason: input.loopRes.publicReason,
      threadId: input.sessionId,
      turnsCompleted: input.loopRes.turnsCompleted,
    };
  }
  return decideAttemptOutcome({
    agentFailure: input.loopRes.agentFailure,
    nonRoutedActionFailureReason: input.nonRouted,
    lastReason: input.loopRes.lastReason,
    sessionId: input.sessionId,
    turnsCompleted: input.loopRes.turnsCompleted,
  });
}
