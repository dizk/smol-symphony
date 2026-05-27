// Agent Runner (SPEC §6.2): workspace + prompt + ACP session, with continuation turns up
// to agent.max_turns. The ACP adapter (claude-agent-acp / codex-acp / opencode acp) runs
// inside a per-issue smolvm machine. The host workspace directory is volume-mounted into
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
import { WorkspaceManager, sanitizeWorkspaceKey } from '../workspace.js';
import { renderPrompt } from '../prompt.js';
import { SmolvmClient, SYMPHONY_VM_PREFIX } from './smolvm.js';
import { AcpClient } from './acp.js';
import {
  ADAPTERS,
  deriveAcpCommand,
  isKnownAdapter,
  stageCredential,
  stageRuntimeFile,
  type AcpAdapterId,
  type ExtraGuestFile,
  type ModelInjection,
} from './adapters.js';
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
import type { ResourceSnapshot } from '../reconciler/index.js';
import {
  performIntegrationMerge,
  resolveIntegrationRemote,
  routeIntegrationFailureToConflict,
} from './integration.js';
import {
  decideAttemptOutcome,
  decideCleanupExecution,
  shouldRunIntegrationMerge,
  shouldStageAfterRunEnv,
} from './runner-decisions.js';
import type { McpServer } from '@agentclientprotocol/sdk';
import type { RunLog } from '../runlog.js';
import type { HookCapture, HookResult } from '../workspace.js';
import type { AcpBridge } from '../acp-bridge.js';
import type { Socket } from 'node:net';

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

// Stage the env vars + body file the Done state's after_run hook consumes (SYMPHONY_*).
// Reads the current issue file from <tracker_root>/<state>/<identifier>.md so any
// transition notes appended by `symphony.transition` ride through into the PR body;
// falls back to the in-memory description if the file isn't reachable (no tracker root
// pinned, or read failure). Returns the env map and a cleanup closure the caller MUST
// run after the hook completes, so the temp file is removed promptly.
export async function buildAfterRunHookEnv(
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
      // Fall back to the dispatch-time description; the hook still works, it just
      // won't see notes the agent appended during the run.
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
  // Mirror after_create's `${SYMPHONY_BASE_BRANCH:-main}` default so an operator who only
  // exported SYMPHONY_REPO (the documented PR-mode setup in AGENTS.md) still gets a usable
  // --base value. Staging here means the hook script can run under `set -u` and reference
  // $SYMPHONY_BASE_BRANCH directly without an inline shell default.
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
 * Source for the currently-ready baked `.smolmachine` artifact produced by the
 * reconciler (issue 32). When set, the runner passes `--from <path>` to smolvm
 * instead of `--smolfile <Smolfile>`, so the per-start `[dev].init` cost is
 * skipped. Null means "no bake ready" — the runner then falls back to whichever
 * of `smolvm.{from,smolfile,image}` is set in config.
 */
export interface BakedArtifactProvider {
  artifactPath(): string | null;
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
    private smolvm: SmolvmClient,
    private events: AgentRunnerEvents,
    private mcp: McpRegistry | null = null,
    /**
     * Host-side TCP bridge the in-VM agent dials back to for ACP traffic. Replaced the
     * smolvm-exec stdio path; required at runtime — runAttempt fails fast if absent.
     */
    private acpBridge: AcpBridge | null = null,
    /**
     * Reconciler-driven bake artifact provider. When set and returning a path,
     * the runner uses `from: <path>` instead of `smolfile: <Smolfile>`; the
     * orchestrator's reconciler gate guarantees this returns non-null before
     * any dispatch happens when `smolvm.smolfile` is configured.
     */
    private bakedArtifacts: BakedArtifactProvider | null = null,
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
  ) {}

  setAcpBridge(bridge: AcpBridge | null): void {
    this.acpBridge = bridge;
  }

  setBakedArtifactProvider(provider: BakedArtifactProvider | null): void {
    this.bakedArtifacts = provider;
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
   * the running entry. The context fields mirror the SYMPHONY_* env names so
   * a Done state that previously read `$SYMPHONY_BRANCH` from the hook env
   * now reads `$branch` from the action template namespace.
   */
  private buildActionContext(
    entry: RunningEntry,
    workspacePath: string,
    extraEnv: Record<string, string> | undefined,
  ): ActionContext {
    const branch = extraEnv?.SYMPHONY_BRANCH ?? `agent/${entry.identifier}`;
    const baseBranch = extraEnv?.SYMPHONY_BASE_BRANCH ?? 'main';
    const prTitle =
      extraEnv?.SYMPHONY_PR_TITLE ??
      (entry.issue.title.trim().length > 0
        ? `${entry.issue.id}: ${entry.issue.title.trim()}`
        : entry.issue.id);
    const prBodyFile = extraEnv?.SYMPHONY_PR_BODY_FILE ?? '';
    return {
      identifier: entry.identifier,
      workspace: workspacePath,
      branch,
      base_branch: baseBranch,
      issue_title: entry.issue.title ?? '',
      issue_body: entry.issue.description ?? '',
      repo: process.env.SYMPHONY_REPO && process.env.SYMPHONY_REPO.length > 0
        ? process.env.SYMPHONY_REPO
        : null,
      pr_title: prTitle,
      pr_body_file: prBodyFile,
    };
  }

  /**
   * Construct a `RunInVmExecutor` bound to a specific per-issue VM. Each
   * invocation spawns a fresh `smolvm machine exec -i` session against
   * `vmName`, with stdin closed, stdout/stderr drained into the per-issue
   * run log, and a timeout that escalates to SIGKILL on overrun. The
   * workspace is bind-mounted at the same host path inside the VM (the
   * runner declares that mount at bring-up), so `workdir` is identical
   * on both sides — no path translation needed.
   *
   * Wraps the smolvm.execInteractive contract rather than reaching into
   * the SmolvmClient from the actions module so the actions package
   * stays free of `node:child_process`/smolvm imports; the dependency
   * inversion lets tests pass `hostRunInVm` without touching smolvm.
   */
  private buildVmRunInVm(vmName: string, runLog: RunLog | undefined): RunInVmExecutor {
    return ({ name, cmd, env, workdir, timeoutMs, onStdout, onStderr }) =>
      new Promise((resolve) => {
        const stream = this.smolvm.execInteractive(vmName, {
          command: cmd,
          workdir,
          env,
          // execInteractive's own timeoutMs is forwarded to smolvm CLI as
          // `--timeout`. We pass it through so the VM-side process gets
          // killed at the same deadline as our local timer; the local
          // timer below is the belt-and-braces fallback.
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
          .then(({ code, signal }) => {
            clearTimeout(timer);
            resolve({
              exit_code: code,
              signal: signal ?? null,
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
   * the issue when an action returns `route_to` (today: `merge` on conflict).
   * Mirrors the integration-merge reroute machinery so the failure path keeps
   * the workspace + agent branch available for the operator who picks up the
   * issue in the conflict state.
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
   * `merge`'s on_conflict). Mirrors `routeIntegrationFailureToConflict` but
   * is parameterized on the typed-action reason rather than on the
   * integration-merge result.
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
  }

  /**
   * Cleanup phase 1: shared-integration-branch handoff. When the agent has
   * just transitioned into a terminal state listed in
   * `integration.merge_on_states`, attempt a host-side merge of
   * `agent/<identifier>` into the shared integration branch BEFORE the
   * terminal state's after_run/actions runs. On success the caller proceeds
   * into the same cleanup tail; on conflict / push-refusal the runner reroutes
   * the issue to the configured holding state (Conflict), preserves the
   * workspace + agent branch, and returns `integrationFailed: true` so the
   * caller skips the after_run path (no orphan PR opens).
   *
   * The returned `cleanupState` reflects the post-reroute state when the merge
   * failed, and the unchanged input state otherwise.
   */
  private async runIntegrationMergeAndReroute(
    issue: Issue,
    runningEntry: RunningEntry | undefined,
    workspacePath: string,
    hookCapture: (hook: string) => HookCapture | undefined,
    runLog: RunLog | undefined,
  ): Promise<{ cleanupState: string; integrationFailed: boolean }> {
    const cleanupState = runningEntry?.issue.state ?? issue.state;
    if (runningEntry === undefined) {
      return { cleanupState, integrationFailed: false };
    }
    const integrationCfg = this.cfg.integration;
    const gated = shouldRunIntegrationMerge({
      transitioned: runningEntry.transitioned,
      cleanupState,
      mergeOnStates: integrationCfg.merge_on_states,
    });
    if (!gated) {
      return { cleanupState, integrationFailed: false };
    }
    const remote = resolveIntegrationRemote(workspacePath);
    runLog?.system('integration_merge_started', {
      identifier: runningEntry.identifier,
      integration_branch: integrationCfg.branch,
      terminal_state: cleanupState,
      remote: remote.kind,
    });
    const result = await performIntegrationMerge({
      workspacePath,
      identifier: runningEntry.identifier,
      integrationBranch: integrationCfg.branch,
      baseBranch: process.env.SYMPHONY_BASE_BRANCH || 'main',
      remote,
      timeoutMs: this.cfg.hooks.timeout_ms,
      capture: hookCapture('integration_merge'),
    });
    if (result.ok) {
      runLog?.system('integration_merge_succeeded', {
        integration_branch: result.integrationBranch,
        remote: result.remote,
        merged_at: result.merged_at,
      });
      return { cleanupState, integrationFailed: false };
    }
    runLog?.system('integration_merge_failed', {
      reason: result.reason,
      integration_branch: result.integrationBranch,
      remote: result.remote,
      diagnostic: result.diagnostic.slice(0, 2000),
    });
    await routeIntegrationFailureToConflict(
      this.tracker,
      runningEntry,
      integrationCfg.conflict_state,
      result,
    );
    // The reroute mutates runningEntry.issue.state to the conflict state; the
    // returned cleanupState picks up the conflict state's hooks (typically
    // none) for the after_run resolution below.
    return { cleanupState: runningEntry.issue.state, integrationFailed: true };
  }

  /**
   * Cleanup phase 2: dispatch the per-state `actions:` block or the legacy
   * `hooks.after_run` shell, gated on `decideCleanupExecution`. Stages the
   * SYMPHONY_* env vars + temp body file once for whichever branch runs and
   * tears them down via the `finally`. Returns the non-routed action failure
   * reason (or null when the cleanup succeeded / routed-failed / was skipped)
   * so the caller can fold it into the attempt outcome.
   */
  private async runCleanupActionsOrHook(
    issue: Issue,
    cleanupState: string,
    runningEntry: RunningEntry | undefined,
    workspacePath: string,
    vmReady: boolean,
    vmName: string,
    integrationFailed: boolean,
    hookCapture: (hook: string) => HookCapture | undefined,
    runLog: RunLog | undefined,
  ): Promise<string | null> {
    const logger = withIssue({ issue_id: issue.id, issue_identifier: issue.identifier });
    const cleanupHooks = resolveHooksForState(this.cfg, cleanupState);
    const cleanupActions = resolveActionsForState(this.cfg, cleanupState);
    const decisionInput = {
      integrationFailed,
      hasRunningEntry: runningEntry !== undefined,
      actionsLength: cleanupActions?.length ?? 0,
      hasAfterRunHook: Boolean(cleanupHooks.after_run),
    };
    const cleanupExec = decideCleanupExecution(decisionInput);
    let extraEnv: Record<string, string> | undefined,
      extraEnvCleanup: (() => Promise<void>) | null = null;
    if (shouldStageAfterRunEnv(decisionInput)) {
      try {
        ({ env: extraEnv, cleanup: extraEnvCleanup } = await buildAfterRunHookEnv(
          runningEntry!,
        ));
      } catch (err) {
        logger.warn('after_run env staging failed; running hook without SYMPHONY_PR_* vars', {
          error: (err as Error).message,
        });
      }
    }
    let nonRoutedActionFailureReason: string | null = null;
    try {
      // Per-state `actions:` block wins over `hooks.after_run` (issue 36
      // AC2). decideCleanupExecution guarantees runningEntry + non-empty
      // cleanupActions when it returns 'actions', so the `!`s are sound.
      if (cleanupExec === 'actions') {
        // run_in_vm goes through the per-issue VM's exec channel. The VM is
        // still alive here — destroy is deferred to the reconciler after
        // runAttempt returns. The `vmReady` guard mirrors the bring-up gate.
        const runInVm: RunInVmExecutor | undefined = vmReady
          ? this.buildVmRunInVm(vmName, runLog)
          : undefined;
        const actionResult = await this.runStateActions(
          cleanupState,
          cleanupActions!,
          runningEntry!,
          workspacePath,
          extraEnv,
          hookCapture('actions'),
          runInVm,
        );
        if (!actionResult.ok && !actionResult.route_to) {
          nonRoutedActionFailureReason = actionResult.reason ?? 'unknown';
        }
      } else if (cleanupExec === 'hook') {
        await this.workspaces.runAfterRunBestEffort(
          workspacePath,
          cleanupHooks,
          hookCapture('after_run'),
          extraEnv,
        );
      }
    } finally {
      if (extraEnvCleanup) await extraEnvCleanup();
    }
    return nonRoutedActionFailureReason;
  }

  async runAttempt(
    issue: Issue,
    attempt: number | null,
    cancelSignal: { cancelled: boolean },
    runningEntry?: RunningEntry,
    runLog?: RunLog,
  ): Promise<RunAttemptResult> {
    const logger = withIssue({ issue_id: issue.id, issue_identifier: issue.identifier });
    // Resolve adapter/model/max_turns once for this attempt against the issue's current
    // state. Every downstream read in this method goes through `resolved`, not the live
    // `this.cfg.acp.*` / `this.cfg.agent.max_turns` — that way a workflow reload between
    // here and the final loop iteration cannot redirect the adapter or change the budget.
    let resolved: ResolvedDispatchConfig;
    try {
      resolved = resolveDispatchConfig(this.cfg, issue.state);
    } catch (err) {
      logger.error('dispatch resolution failed', {
        error: (err as Error).message,
        state: issue.state,
      });
      return {
        ok: false,
        reason: 'dispatch resolution error',
        threadId: null,
        turnsCompleted: 0,
      };
    }
    if (!isKnownAdapter(resolved.adapter)) {
      // Defense in depth: validateDispatch + per-state validation should have caught
      // this. The state name is in the error so an operator who sees this in the logs
      // can spot a typo in their per-state adapter override.
      logger.error('unknown acp adapter for state', {
        adapter: resolved.adapter,
        state: issue.state,
      });
      return { ok: false, reason: 'unknown acp adapter', threadId: null, turnsCompleted: 0 };
    }
    const hookCapture = (hook: string): HookCapture | undefined =>
      runLog
        ? {
            onChunk: (stream, text) => runLog.record({ channel: 'hook', hook, stream, text }),
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
    // Resolve hooks against the dispatch-time state. after_create only fires when the
    // workspace is created (i.e. the first attempt against an issue), so this state is
    // also the one whose after_create runs. before_run uses the same state — runAttempt
    // runs once per attempt and the issue hasn't moved between dispatchIssue and here.
    const initialHooks = resolveHooksForState(this.cfg, issue.state);
    let workspace: Awaited<ReturnType<WorkspaceManager['ensureFor']>>;
    try {
      workspace = await this.workspaces.ensureFor(
        issue.identifier,
        initialHooks,
        hookCapture('after_create'),
      );
    } catch (err) {
      logger.error('workspace error', { error: (err as Error).message });
      return { ok: false, reason: 'workspace error', threadId: null, turnsCompleted: 0 };
    }

    try {
      await this.workspaces.runBeforeRun(workspace.path, initialHooks, hookCapture('before_run'));
    } catch (err) {
      logger.error('before_run hook failed', { error: (err as Error).message });
      return { ok: false, reason: 'before_run hook error', threadId: null, turnsCompleted: 0 };
    }

    // Resolve adapter launch. Under the TCP bridge architecture there is exactly one
    // launch shape: scrub the in-VM credential dir, stage the host credential into the
    // workspace, exec the in-VM proxy at /opt/symphony/vm-agent.mjs. The proxy reads its
    // config (SYMPHONY_ACP_URL/TOKEN/ADAPTER_BIN/ADAPTER_ARGS) from env, dials the
    // host's bridge, and spawns the adapter. The adapter id was already validated up
    // top via `resolved` (which folds in any per-state override); the branches below are
    // pure data binding off the resolved profile.
    const profile = ADAPTERS[resolved.adapter];
    let staged;
    try {
      staged = await stageCredential(workspace.path, profile);
    } catch (err) {
      logger.error('credential staging failed', {
        adapter: profile.id,
        error: (err as Error).message,
      });
      await this.workspaces.runAfterRunBestEffort(
        workspace.path,
        initialHooks,
        hookCapture('after_run'),
      );
      return { ok: false, reason: 'credential staging error', threadId: null, turnsCompleted: 0 };
    }
    const adapterBin = profile.binary[0]!;
    const adapterArgs = profile.binary.slice(1);
    // Apply the resolved model / effort selections (if any) to the adapter via its
    // profile-specific mechanisms: env var for claude-agent-acp's ANTHROPIC_MODEL, extra
    // argv for codex-acp's `-c model=...`, staged file for claude-agent-acp's
    // settings.json (effortLevel lives there). The injections compose along three
    // orthogonal channels — env, extraArgs, stagedFiles — so codex (argv-based) and
    // claude (env + file-based) coexist without per-adapter branching here.
    const runtimeEnv: Record<string, string> = {};
    const runtimeArgs: string[] = [];
    const runtimeExtraFiles: ExtraGuestFile[] = [];
    const applyInjection = async (inj: ModelInjection): Promise<void> => {
      if (inj.env) {
        for (const [k, v] of Object.entries(inj.env)) runtimeEnv[k] = v;
      }
      if (inj.extraArgs) runtimeArgs.push(...inj.extraArgs);
      if (inj.stagedFiles) {
        for (const f of inj.stagedFiles) {
          const stagedFile = await stageRuntimeFile(workspace.path, f.stagedName, f.content);
          runtimeExtraFiles.push({
            stagedRelPath: stagedFile.relPath,
            guestPath: f.guestPath,
          });
        }
      }
    };
    try {
      if (resolved.model) {
        await applyInjection(profile.modelInjection(resolved.model));
      }
      if (resolved.effort && profile.effortInjection) {
        await applyInjection(profile.effortInjection(resolved.effort));
      }
    } catch (err) {
      logger.error('runtime injection staging failed', {
        adapter: profile.id,
        error: (err as Error).message,
      });
      await this.workspaces.runAfterRunBestEffort(
        workspace.path,
        this.cfg.hooks,
        hookCapture('after_run'),
      );
      return {
        ok: false,
        reason: 'runtime injection staging error',
        threadId: null,
        turnsCompleted: 0,
      };
    }
    const effectiveAcpCommand = deriveAcpCommand(profile, staged.relPath, runtimeExtraFiles);
    const effectiveAdapterArgs = [...adapterArgs, ...runtimeArgs];

    // The TCP bridge is mandatory. Without it there's no transport for ACP frames; we
    // would be back to the smolvm-exec stdio path the bridge replaced. Fail fast.
    if (!this.acpBridge) {
      logger.error('acp bridge is not configured', {});
      return { ok: false, reason: 'acp bridge unavailable', threadId: null, turnsCompleted: 0 };
    }
    const acpReachUrl =
      this.cfg.acp.bridge.reach_url ??
      `tcp://${this.cfg.acp.bridge.reach_host}:${this.acpBridge.port() ?? this.cfg.acp.bridge.bind_port}`;

    const vmName = this.vmNameFor(issue);
    const mounts = [
      { host: workspace.path, guest: workspace.path, readonly: false },
    ];
    for (const v of this.cfg.smolvm.volumes) {
      mounts.push({ host: v.host, guest: v.guest, readonly: v.readonly });
    }
    // Eval/debug mode (issue 40): when the resolved state opts in, mount the
    // tracker root + logs root read-only so an in-VM agent can inspect every
    // issue file and the per-issue JSONL transcripts. Skipped silently when
    // the state did not opt in; the mount list grows by at most two slots
    // here (smolvm's per-VM mount cap is small but the workspace itself only
    // takes one slot, so the two extras fit comfortably).
    for (const m of buildEvalModeMounts(this.cfg, resolved)) {
      mounts.push(m);
    }
    const env: Record<string, string> = {};
    for (const k of this.cfg.smolvm.forward_env) {
      const v = process.env[k];
      if (v && v.length > 0) env[k] = v;
    }

    // Bring up the VM BEFORE registering with the ACP bridge. If we registered first and
    // ensureRunning then threw, the catch path would call `bridgeReg.cancel(...)` which
    // synchronously rejects the registration's `accepted` promise — and at that point no
    // .catch handler is attached yet (the awaiter is wired further below). The resulting
    // unhandled-rejection crashes the orchestrator (Node ≥ 15 default). Registering after
    // a successful bring-up makes the cancel path moot for that early failure.
    let vmReady = false;
    // Issue 32: when the reconciler has a ready baked artifact, dispatch uses
    // `--from <cache_path>` so the per-start [dev].init cost is paid once at bake
    // time instead of on every dispatch. Falls back to the static `smolvm.{from,
    // smolfile,image}` config when no bake is ready (only relevant for harnesses
    // that don't wire a reconciler; production dispatch is gated by the
    // orchestrator on `reconciler.dispatchReady()` and reaches here only when
    // a bake is ready or no Smolfile is configured).
    const bakedFrom = this.bakedArtifacts?.artifactPath() ?? null;
    const vmFrom = bakedFrom ?? this.cfg.smolvm.from;
    const vmSmolfile = bakedFrom ? null : this.cfg.smolvm.smolfile;
    const vmImage = bakedFrom ? null : this.cfg.smolvm.image;
    try {
      await this.smolvm.ensureRunning(vmName, {
        image: vmImage,
        from: vmFrom,
        smolfile: vmSmolfile,
        cpus: this.cfg.smolvm.cpus,
        memMib: this.cfg.smolvm.mem_mib,
        net: this.cfg.smolvm.net,
        mounts,
        env,
        workdir: workspace.path,
        sshAgent: false,
      });
      vmReady = true;
    } catch (err) {
      logger.error('smolvm bring-up failed', { error: (err as Error).message });
      // ensureRunning can fail after `machine create` succeeded but before `machine start`
      // — leaving a halted VM behind. Teardown is the reconciler `vm` resource's job
      // (issue 52): on return, the orchestrator drops this issue from `running`, so the
      // reaper sees the half-created VM as a stray and destroys it on the next kick
      // (fired from `onWorkerExit`).
      await this.workspaces.runAfterRunBestEffort(
        workspace.path,
        initialHooks,
        hookCapture('after_run'),
      );
      return { ok: false, reason: 'smolvm bring-up error', threadId: null, turnsCompleted: 0 };
    }

    // VM is up — now register with the bridge. The .accepted promise will get its
    // rejection handler attached when we Promise.race against it below; that
    // continuation is created within the same synchronous block so no failure path
    // between here and there can crash on an unhandled rejection.
    //
    // register() throws synchronously if the bridge has already been stopped (e.g. a
    // SIGTERM landed between ensureRunning resolving and this line). The VM is up at
    // that point, so we must tear it down here — the cleanup closure that handles
    // post-handshake failures isn't built yet.
    let bridgeReg: ReturnType<AcpBridge['register']>;
    try {
      bridgeReg = this.acpBridge.register(issue.id, issue.identifier);
    } catch (err) {
      logger.error('acp bridge register failed', { error: (err as Error).message });
      // VM is live but the bridge is gone; teardown belongs to the reconciler `vm`
      // resource (issue 52). Returning here drops the running entry, and the reaper
      // kick in `onWorkerExit` converges the now-orphaned VM.
      await this.workspaces.runAfterRunBestEffort(
        workspace.path,
        initialHooks,
        hookCapture('after_run'),
      );
      return {
        ok: false,
        reason: 'acp bridge register failed',
        threadId: null,
        turnsCompleted: 0,
      };
    }

    const execStream = this.smolvm.execInteractive(vmName, {
      command: [this.cfg.acp.shell, '-lc', effectiveAcpCommand],
      workdir: workspace.path,
      // The in-VM proxy (`vm-agent.mjs`) reads these to know where to dial back and what
      // adapter to spawn. The bearer token is a per-dispatch secret so it cannot survive
      // the attempt; visible via `ps` on the host but the host is trusted.
      env: {
        SYMPHONY_ACP_URL: acpReachUrl,
        SYMPHONY_ACP_TOKEN: bridgeReg.token,
        SYMPHONY_ADAPTER_BIN: adapterBin,
        SYMPHONY_ADAPTER_ARGS: JSON.stringify(effectiveAdapterArgs),
        ...runtimeEnv,
      },
      timeoutMs: null,
    });

    // We do NOT use execStream.stdin/.stdout for ACP frames anymore — those flow over the
    // bridge socket once the in-VM agent dials back. The exec channel just carries
    // diagnostic stderr (vm-agent's own logs + the inherited adapter stderr) and acts as
    // a process tether so we can kill the in-VM agent by closing the exec.
    execStream.stdin.end();

    // Attach the stderr tap NOW — before we await the bridge handshake — so any
    // pre-connect crash (vm-agent missing, malformed env, adapter that exits during
    // startup) lands in the per-issue run log and the orchestrator's event ring. AcpClient
    // no longer reads stderr; this is the single, always-on source. The same listener
    // stays attached for the duration of the attempt and continues capturing post-connect
    // stderr (e.g. claude-agent-acp warnings).
    execStream.stderr.setEncoding('utf8');
    execStream.stderr.on('data', (chunk: string) => {
      // Always mirror the raw chunk into the run log so the evaluator sees adapter output
      // byte-for-byte, even if it is only whitespace.
      runLog?.record({ channel: 'stderr', text: chunk });
      const text = chunk.trim();
      if (text.length === 0) return;
      // Push into the orchestrator's per-issue ring + symphony log. Truncate the symphony
      // log line so a chatty adapter (claude-agent-acp's "No onPostToolUseHook found …"
      // warnings, for example) doesn't dominate the host stderr stream.
      this.events.onRuntimeEvent(issue.id, {
        at: new Date().toISOString(),
        event: 'agent_stderr',
        message: text.length > 240 ? text.slice(0, 240) + '…' : text,
      });
      logger.info('agent stderr', { text: text.slice(0, 500) });
    });

    // The socket the bridge accepts becomes AcpClient's stdin AND stdout. We keep a
    // reference so cleanup can close it even on partial failure.
    let acpSocket: Socket | null = null;

    // Captured by `cleanup` when a non-routed action failure happens during
    // the terminal `actions:` pass. The final return below treats this as
    // attempt failure so the orchestrator retries (or otherwise surfaces it)
    // instead of marking the issue "done" while its push/PR-create never
    // landed. Routed failures (merge → conflict state) intentionally do NOT
    // set this — the agent's work succeeded; the issue lives on in the
    // conflict state. Only failures with no `route_to` propagate.
    let nonRoutedActionFailureReason: string | null = null;

    const cleanup = async (reason: string) => {
      // Cancel the bridge registration if the in-VM agent never connected. Idempotent on
      // success (already-resolved registrations ignore cancel).
      bridgeReg.cancel(reason);
      try {
        if (acpSocket && !acpSocket.destroyed) acpSocket.destroy();
      } catch {
        /* ignore */
      }
      try {
        execStream.kill();
      } catch {
        /* ignore */
      }
      try {
        await execStream.exit;
      } catch {
        /* ignore */
      }
      if (this.mcp && runningEntry) {
        this.mcp.deactivate(runningEntry.identifier);
      }
      logger.debug('agent runner cleanup', { reason });
      // Phase 1: shared-integration-branch handoff (issue 19). Returns the
      // cleanupState reflecting any conflict-state reroute and a flag the
      // next phase uses to skip after_run when the merge failed.
      const integrationResult = await this.runIntegrationMergeAndReroute(
        issue,
        runningEntry,
        workspace.path,
        hookCapture,
        runLog,
      );
      // Phase 2: per-state `actions:` block or legacy `hooks.after_run`,
      // gated on `decideCleanupExecution`. Captures any non-routed action
      // failure so the orchestrator surfaces it instead of marking the
      // attempt successful while the push/PR-create never landed.
      nonRoutedActionFailureReason = await this.runCleanupActionsOrHook(
        issue,
        integrationResult.cleanupState,
        runningEntry,
        workspace.path,
        vmReady,
        vmName,
        integrationResult.integrationFailed,
        hookCapture,
        runLog,
      );
      // Per the agreed lifecycle, every attempt gets a fresh VM. Teardown is the
      // reconciler `vm` resource's job (issue 52): the runner only mutates desired
      // state. By the time this `cleanup()` returns, `runAttempt` returns to the
      // orchestrator, which deletes the running entry and kicks the reaper —
      // converging the now-orphan VM in one tick.
      if (vmReady) {
        runLog?.system('vm_teardown_deferred', { vm: vmName, reason });
      }
    };

    // Wait for the in-VM agent to dial back and authenticate. We bound this with a config
    // timeout because a stuck VM or misconfigured `reach_host` would otherwise hang the
    // attempt until the orchestrator's stall timer fires much later. The exec process's
    // stderr is captured separately so failures surface there for debugging.
    try {
      acpSocket = await Promise.race([
        bridgeReg.accepted,
        new Promise<Socket>((_, reject) =>
          setTimeout(
            () => reject(new Error('acp bridge: in-VM agent did not connect in time')),
            this.cfg.acp.bridge.connect_timeout_ms,
          ),
        ),
      ]);
      runLog?.system('acp_bridge_connected', { reach_url: acpReachUrl });
    } catch (err) {
      logger.error('acp bridge connect timeout', { error: (err as Error).message });
      runLog?.system('acp_bridge_failed', { error: (err as Error).message });
      await cleanup('acp_bridge_connect_failed');
      return { ok: false, reason: 'acp bridge connect failed', threadId: null, turnsCompleted: 0 };
    }

    // Cancellation tear-down. Three things have to happen for the runner to actually
    // unwind a stuck `client.runPrompt()`:
    //   1. `client.cancel()` — sends `session/cancel` over ACP. The polite path; the
    //      adapter SHOULD respond to the in-flight `session/prompt` with
    //      `stop_reason: cancelled`. In practice the adapter often goes silent (e.g.
    //      after the model has emitted its final text and called `transition`).
    //   2. `client.forceClose()` — explicitly ends the LineTap streams the SDK is reading
    //      from. This makes the SDK's `receive()` reader loop observe `done` and call its
    //      internal `close()`, which rejects every pending request including the in-flight
    //      `session/prompt`. Without this, the runner stays parked in `runPrompt()` for
    //      the full `prompt_timeout_ms` (30 min) even after the transport is gone.
    //   3. `execStream.kill()` + `acpSocket.destroy()` — terminate the host-side
    //      `smolvm machine exec` and the TCP bridge connection. The kill does NOT
    //      propagate into the VM (the in-VM adapter keeps running until VM destroy in
    //      cleanup()), but breaking the socket lets the bridge entry be reclaimed and
    //      surfaces the close as `'close'` on the socket (a belt-and-braces second
    //      trigger for `handleTransportClose` if `forceClose` somehow didn't fire).
    const onCancel = () => {
      if (cancelSignal.cancelled) {
        client.cancel().catch(() => undefined);
        client.forceClose('cancel_requested');
        execStream.kill();
        if (acpSocket && !acpSocket.destroyed) {
          try {
            acpSocket.destroy();
          } catch {
            /* idempotent on already-destroyed socket */
          }
        }
      }
    };
    const cancelCheckTimer = setInterval(onCancel, 500);

    // Register with the MCP registry so the agent's tool calls can be routed back.
    // MCP is required for symphony operations: `transition` is the only way for the
    // agent to signal completion (or hand off to another state), and
    // request_human_steering is the only way to defer to a human. If we can't construct
    // a reachable URL — no bound HTTP port and no explicit override — we abort the
    // attempt rather than dispatch a tool-less agent.
    const mcpServers: McpServer[] = [];
    if (this.cfg.mcp.enabled && runningEntry) {
      if (!this.mcp) {
        clearInterval(cancelCheckTimer);
        await cleanup('mcp_registry_unavailable');
        logger.error('mcp is required but no registry is wired into the runner', {});
        return {
          ok: false,
          reason: 'mcp required but registry unavailable',
          threadId: null,
          turnsCompleted: 0,
        };
      }
      const url = this.mcp.buildUrl(runningEntry.identifier, {
        host: this.cfg.mcp.host,
        explicit_host_url: this.cfg.mcp.explicit_host_url,
      });
      if (!url) {
        clearInterval(cancelCheckTimer);
        await cleanup('mcp_url_unavailable');
        logger.error('mcp is required but no reachable URL is configured', {
          host: this.cfg.mcp.host,
          explicit_host_url: this.cfg.mcp.explicit_host_url,
        });
        return {
          ok: false,
          reason: 'mcp required but URL unavailable (start the HTTP server or set mcp.host_url)',
          threadId: null,
          turnsCompleted: 0,
        };
      }
      const token = this.mcp.activate(runningEntry);
      mcpServers.push({
        type: 'http',
        name: 'symphony',
        url,
        headers: [{ name: 'Authorization', value: `Bearer ${token}` }],
      });
      logger.debug('mcp registered', { url });
    }

    // ACP transport: bridge socket for stdin AND stdout (writes go through the same
    // socket the in-VM agent reads from; reads come from the socket the agent writes to).
    // Adapter stderr still flows via the smolvm-exec stderr channel (vm-agent inherits
    // stderr from its parent, which is the smolvm exec), so symphony's LineTap on
    // execStream.stderr keeps the per-issue JSONL log full-fidelity for stderr.
    const client = new AcpClient({
      stdin: acpSocket,
      stdout: acpSocket,
      stderr: execStream.stderr,
      cwd: workspace.path,
      readTimeoutMs: this.cfg.acp.read_timeout_ms,
      promptTimeoutMs: this.cfg.acp.prompt_timeout_ms,
      onEvent: (event) => this.events.onRuntimeEvent(issue.id, event),
      onTokenUsage: (u) => this.events.onTokenUsage(issue.id, u),
      mcpServers,
      runLog,
    });

    let sessionId: string;
    try {
      const sess = await client.initSession();
      sessionId = sess.sessionId;
    } catch (err) {
      clearInterval(cancelCheckTimer);
      logger.error('acp init failed', {
        error: (err as Error).message,
        adapter: resolved.adapter,
      });
      this.events.onRuntimeEvent(issue.id, {
        at: new Date().toISOString(),
        event: 'startup_failed',
        message: (err as Error).message,
      });
      await cleanup('init_failed');
      return { ok: false, reason: 'agent session startup error', threadId: null, turnsCompleted: 0 };
    }

    this.events.onSessionStarted?.({
      issueId: issue.id,
      sessionId,
      threadId: sessionId,
      pid: execStream.pid ? String(execStream.pid) : null,
    });

    let turnsCompleted = 0;
    let autonomousTurns = 0;
    let lastReason = 'unknown';
    let agentFailure: string | null = null;
    let currentIssue = issue;
    let pendingSteering: { question: string; context: string | null; reply: string } | null = null;
    let firstTurn = true;
    const activeStates = new Set(activeStateNames(this.cfg.states).map((s) => s.toLowerCase()));

    // Decoupled from max_turns: the loop runs as long as the agent keeps engaging. Only
    // autonomous turns (turns without a pending human reply) count against max_turns.
    // Turns driven by a human steering reply run free; the human is in the loop and can
    // stop work at any time by walking away or by giving an instruction that ends in
    // a `transition` call.
    while (true) {
      if (cancelSignal.cancelled) {
        lastReason = 'cancelled_by_reconciliation';
        break;
      }
      let prompt: string;
      const isSteeringReply = pendingSteering !== null;
      try {
        if (pendingSteering) {
          prompt = buildSteeringReplyPrompt(
            pendingSteering.question,
            pendingSteering.context,
            pendingSteering.reply,
          );
          pendingSteering = null;
        } else if (firstTurn) {
          prompt = await renderPrompt({
            template: this.workflow.prompt_template,
            issue: currentIssue,
            attempt: attempt === null ? null : attempt,
          });
        } else {
          prompt = continuationPrompt(this.cfg.mcp.enabled);
        }
      } catch (err) {
        clearInterval(cancelCheckTimer);
        logger.error('prompt rendering failed', { error: (err as Error).message });
        await cleanup('prompt_error');
        return { ok: false, reason: 'prompt error', threadId: sessionId, turnsCompleted };
      }
      firstTurn = false;

      // Label is the 1-based ordinal of the turn about to run, counting every turn
      // (autonomous + steering reply), so the running snapshot never shows duplicate
      // turn_count values across a steering boundary.
      this.events.onTurn(issue.id, turnsCompleted + 1);
      const outcome = await client.runPrompt(prompt);

      if (outcome.reason !== 'end_turn') {
        // `transitioned` is authoritative: if the agent called symphony.transition
        // mid-turn, reconcile may have tripped cancelSignal before the prompt
        // returned. The work is done regardless of how the prompt ended; honor that.
        if (runningEntry?.transitioned) {
          lastReason = 'agent_transitioned';
          break;
        }
        lastReason = outcome.reason;
        agentFailure = `agent turn ${outcome.reason}: ${outcome.message}`;
        break;
      }
      turnsCompleted++;

      // Count this completed turn against max_turns iff it was an autonomous turn (i.e.
      // not itself a reply to a human steering message). Steering-reply turns are free.
      // Steering-REQUEST turns (autonomous turns that called request_human_steering)
      // still count: the agent did autonomous work before deferring to a human.
      if (!isSteeringReply) {
        autonomousTurns++;
      }

      // Tool-driven exits: the MCP handler has already done the work; we just read the flag.
      if (runningEntry?.transitioned) {
        lastReason = 'agent_transitioned';
        break;
      }

      // Steering: pause the autonomous loop and wait for a human reply. The wait does not
      // count against max_turns; cancellation breaks us out via the registry's cancel-aware
      // resolver. The next iteration uses the steering-reply prompt.
      if (runningEntry?.steering_requested && this.mcp) {
        const question = runningEntry.steering_question ?? '';
        const ctx = runningEntry.steering_context;
        this.events.onRuntimeEvent(issue.id, {
          at: new Date().toISOString(),
          event: 'awaiting_human_steering',
          message: question.length > 240 ? question.slice(0, 240) + '…' : question,
        });
        const reply = await this.mcp.awaitSteeringReply(issue.identifier, cancelSignal);
        if (reply === null) {
          lastReason = 'cancelled_while_awaiting_steering';
          break;
        }
        runningEntry.steering_requested = false;
        runningEntry.steering_question = null;
        runningEntry.steering_context = null;
        pendingSteering = { question, context: ctx, reply };
        this.events.onRuntimeEvent(issue.id, {
          at: new Date().toISOString(),
          event: 'human_steering_received',
          message: reply.length > 240 ? reply.slice(0, 240) + '…' : reply,
        });
        continue;
      }

      // Autonomous turn finished without a tool-driven exit. Refresh tracker state and
      // decide whether to continue.
      let refreshed: Issue[];
      try {
        refreshed = await this.tracker.fetchIssueStatesByIds([issue.id]);
      } catch (err) {
        clearInterval(cancelCheckTimer);
        logger.error('issue state refresh failed', { error: (err as Error).message });
        await cleanup('issue_state_refresh_failed');
        return { ok: false, reason: 'issue state refresh error', threadId: sessionId, turnsCompleted };
      }
      const found = refreshed[0];
      if (!found) {
        lastReason = 'issue_no_longer_present';
        break;
      }
      currentIssue = found;
      if (!activeStates.has(found.state.toLowerCase())) {
        lastReason = 'issue_no_longer_active';
        break;
      }
      if (autonomousTurns >= resolved.max_turns) {
        lastReason = 'max_turns_reached';
        break;
      }
      await delay(25);
    }

    clearInterval(cancelCheckTimer);
    await cleanup(lastReason);
    // `decideAttemptOutcome` collapses the three failure channels (agent
    // turn failure, non-routed terminal-action failure during cleanup, and
    // graceful break) into the single RunAttemptResult shape. agentFailure
    // wins; then nonRoutedActionFailureReason (a failed push / pr-create
    // must surface so the orchestrator retries instead of marking done);
    // otherwise the loop's break reason is success.
    return decideAttemptOutcome({
      agentFailure,
      nonRoutedActionFailureReason,
      lastReason,
      sessionId,
      turnsCompleted,
    });
  }
}
