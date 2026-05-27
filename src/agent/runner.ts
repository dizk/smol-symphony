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

/**
 * Resolve the optional SYMPHONY_REPO env var into the `repo` field of an
 * ActionContext. Returns null when the var is missing or empty so the action
 * templating sees a deterministic shape (the prior inline form returned null
 * for the same cases).
 */
function resolveRepoFromEnv(): string | null {
  const v = process.env.SYMPHONY_REPO;
  return v && v.length > 0 ? v : null;
}

/**
 * PR title that matches the legacy `buildAfterRunHookEnv` shape: `<id>: <title>`
 * when the issue has a non-empty title, otherwise just `<id>`. Pulled out of
 * buildActionContext so its complexity stays under the shell budget.
 */
function defaultPrTitleFor(issue: Issue): string {
  const title = issue.title.trim();
  return title.length > 0 ? `${issue.id}: ${title}` : issue.id;
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

/**
 * Thrown by `runAttempt`'s stage helpers to abort the attempt with a typed
 * RunAttemptResult. Caught only at the top of `runAttempt` so the orchestrator
 * never sees this internal control-flow exception; the helpers themselves run
 * the appropriate pre-throw side effects (after_run hooks, cleanup closure) so
 * the catch path is just a `return err.result`.
 */
class AttemptAbort extends Error {
  constructor(readonly result: RunAttemptResult) {
    super(result.reason);
    this.name = 'AttemptAbort';
  }
}

/**
 * Per-attempt mutable state threaded through the stage helpers. Bundling these
 * fields lets `runAttempt` itself stay short — it composes stages instead of
 * declaring a dozen `let`s and then handing them to a sprawling cleanup
 * closure. Mutated by helpers that need to publish facts back to the loop /
 * cleanup; only the runner reads them.
 */
interface AttemptIo {
  logger: ReturnType<typeof withIssue>;
  hookCapture: (hook: string) => HookCapture | undefined;
  runLog: RunLog | undefined;
}

interface AttemptShell {
  io: AttemptIo;
  workspace: Awaited<ReturnType<WorkspaceManager['ensureFor']>>;
  initialHooks: ReturnType<typeof resolveHooksForState>;
  resolved: ResolvedDispatchConfig;
  /** Issue state at dispatch time; cleanup falls back to this when no running entry. */
  initialState: string;
}

interface AdapterRuntime {
  profile: (typeof ADAPTERS)[AcpAdapterId];
  adapterBin: string;
  adapterArgs: readonly string[];
  effectiveCommand: string;
  effectiveArgs: string[];
  runtimeEnv: Record<string, string>;
}

interface AttemptVm {
  shell: AttemptShell;
  adapter: AdapterRuntime;
  vmName: string;
  reachUrl: string;
}

interface AttemptSession {
  vm: AttemptVm;
  bridgeReg: ReturnType<AcpBridge['register']>;
  execStream: ReturnType<SmolvmClient['execInteractive']>;
  /** Null on the early-failure path before `awaitBridgeHandshake` resolves. */
  acpSocket: Socket | null;
  /** Null on the early-failure path before AcpClient is constructed. */
  client: AcpClient | null;
  sessionId: string;
  /** Null on the early-failure path before the cancel timer is scheduled. */
  cancelCheckTimer: NodeJS.Timeout | null;
  runningEntry: RunningEntry | undefined;
  /**
   * Set by `cleanupAttempt` when a non-routed action failure happens during
   * the terminal `actions:` pass; the final RunAttemptResult treats this as
   * attempt failure so the orchestrator retries instead of marking the issue
   * "done" while its push/PR-create never landed.
   */
  nonRoutedActionFailureReason: string | null;
}

interface TurnLoopResult {
  turnsCompleted: number;
  lastReason: string;
  agentFailure: string | null;
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
    const env = extraEnv ?? {};
    return {
      identifier: entry.identifier,
      workspace: workspacePath,
      branch: env.SYMPHONY_BRANCH ?? `agent/${entry.identifier}`,
      base_branch: env.SYMPHONY_BASE_BRANCH ?? 'main',
      issue_title: entry.issue.title ?? '',
      issue_body: entry.issue.description ?? '',
      repo: resolveRepoFromEnv(),
      pr_title: env.SYMPHONY_PR_TITLE ?? defaultPrTitleFor(entry.issue),
      pr_body_file: env.SYMPHONY_PR_BODY_FILE ?? '',
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

  async runAttempt(
    issue: Issue,
    attempt: number | null,
    cancelSignal: { cancelled: boolean },
    runningEntry?: RunningEntry,
    runLog?: RunLog,
  ): Promise<RunAttemptResult> {
    try {
      const shell = await this.openShell(issue, runLog);
      const adapter = await this.prepareAdapterRuntime(shell);
      const vm = await this.bringUpVm(shell, adapter, issue);
      const session = await this.connectAndInitSession(vm, issue, runningEntry, cancelSignal);
      const loop = await this.runTurnLoop(session, issue, attempt, cancelSignal);
      if (session.cancelCheckTimer) clearInterval(session.cancelCheckTimer);
      await this.cleanupAttempt(session, loop.lastReason);
      return decideAttemptOutcome({
        agentFailure: loop.agentFailure,
        nonRoutedActionFailureReason: session.nonRoutedActionFailureReason,
        lastReason: loop.lastReason,
        sessionId: session.sessionId,
        turnsCompleted: loop.turnsCompleted,
      });
    } catch (err) {
      if (err instanceof AttemptAbort) return err.result;
      throw err;
    }
  }

  /**
   * Stage 1: resolve dispatch config, set up the workspace + before_run, build
   * the per-hook capture closure. Failures throw `AttemptAbort` with the
   * appropriate `RunAttemptResult.reason`; the only side effect is hook
   * execution, and there is no VM yet so no `cleanup()` is needed on abort.
   */
  private async openShell(issue: Issue, runLog: RunLog | undefined): Promise<AttemptShell> {
    const logger = withIssue({ issue_id: issue.id, issue_identifier: issue.identifier });
    const resolved = this.resolveDispatchOrAbort(issue, logger);
    const hookCapture = makeHookCapture(runLog);
    const io: AttemptIo = { logger, hookCapture, runLog };
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
      throw new AttemptAbort({ ok: false, reason: 'workspace error', threadId: null, turnsCompleted: 0 });
    }
    try {
      await this.workspaces.runBeforeRun(workspace.path, initialHooks, hookCapture('before_run'));
    } catch (err) {
      logger.error('before_run hook failed', { error: (err as Error).message });
      throw new AttemptAbort({
        ok: false,
        reason: 'before_run hook error',
        threadId: null,
        turnsCompleted: 0,
      });
    }
    return { io, workspace, initialHooks, resolved, initialState: issue.state };
  }

  /**
   * Resolve adapter/model/max_turns once for this attempt. Every downstream
   * read goes through this struct, not the live `this.cfg.acp.*` — so a
   * workflow reload mid-attempt cannot redirect the adapter or budget. Throws
   * `AttemptAbort` on resolution failure or unknown adapter (defense in depth;
   * validateDispatch + per-state validation should have caught the latter).
   */
  private resolveDispatchOrAbort(
    issue: Issue,
    logger: ReturnType<typeof withIssue>,
  ): ResolvedDispatchConfig {
    let resolved: ResolvedDispatchConfig;
    try {
      resolved = resolveDispatchConfig(this.cfg, issue.state);
    } catch (err) {
      logger.error('dispatch resolution failed', {
        error: (err as Error).message,
        state: issue.state,
      });
      throw new AttemptAbort({
        ok: false,
        reason: 'dispatch resolution error',
        threadId: null,
        turnsCompleted: 0,
      });
    }
    if (!isKnownAdapter(resolved.adapter)) {
      logger.error('unknown acp adapter for state', {
        adapter: resolved.adapter,
        state: issue.state,
      });
      throw new AttemptAbort({
        ok: false,
        reason: 'unknown acp adapter',
        threadId: null,
        turnsCompleted: 0,
      });
    }
    return resolved;
  }

  /**
   * Stage 2: stage the host credential into the workspace, apply the resolved
   * model + effort injections (env / extra argv / staged files), and derive
   * the in-VM launch command. Three orthogonal injection channels compose
   * here so codex (argv-based) and claude (env + file-based) coexist without
   * per-adapter branching in the runner.
   *
   * On failure runs `after_run` best-effort (the VM is not up yet, so this
   * is the only cleanup needed) and throws `AttemptAbort`.
   */
  private async prepareAdapterRuntime(shell: AttemptShell): Promise<AdapterRuntime> {
    const { workspace, resolved, initialHooks, io } = shell;
    const profile = ADAPTERS[resolved.adapter];
    const staged = await this.stageCredentialOrAbort(workspace.path, profile, shell);
    const runtimeEnv: Record<string, string> = {};
    const runtimeArgs: string[] = [];
    const runtimeExtraFiles: ExtraGuestFile[] = [];
    try {
      if (resolved.model) {
        await applyRuntimeInjection(
          profile.modelInjection(resolved.model),
          workspace.path,
          runtimeEnv,
          runtimeArgs,
          runtimeExtraFiles,
        );
      }
      if (resolved.effort && profile.effortInjection) {
        await applyRuntimeInjection(
          profile.effortInjection(resolved.effort),
          workspace.path,
          runtimeEnv,
          runtimeArgs,
          runtimeExtraFiles,
        );
      }
    } catch (err) {
      io.logger.error('runtime injection staging failed', {
        adapter: profile.id,
        error: (err as Error).message,
      });
      await this.workspaces.runAfterRunBestEffort(
        workspace.path,
        this.cfg.hooks,
        io.hookCapture('after_run'),
      );
      throw new AttemptAbort({
        ok: false,
        reason: 'runtime injection staging error',
        threadId: null,
        turnsCompleted: 0,
      });
    }
    const adapterArgs = profile.binary.slice(1);
    return {
      profile,
      adapterBin: profile.binary[0]!,
      adapterArgs,
      effectiveCommand: deriveAcpCommand(profile, staged.relPath, runtimeExtraFiles),
      effectiveArgs: [...adapterArgs, ...runtimeArgs],
      runtimeEnv,
    };
  }

  private async stageCredentialOrAbort(
    workspacePath: string,
    profile: (typeof ADAPTERS)[AcpAdapterId],
    shell: AttemptShell,
  ): Promise<Awaited<ReturnType<typeof stageCredential>>> {
    try {
      return await stageCredential(workspacePath, profile);
    } catch (err) {
      shell.io.logger.error('credential staging failed', {
        adapter: profile.id,
        error: (err as Error).message,
      });
      await this.workspaces.runAfterRunBestEffort(
        workspacePath,
        shell.initialHooks,
        shell.io.hookCapture('after_run'),
      );
      throw new AttemptAbort({
        ok: false,
        reason: 'credential staging error',
        threadId: null,
        turnsCompleted: 0,
      });
    }
  }

  /**
   * Stage 3: validate the ACP bridge is configured, derive the reach URL the
   * in-VM proxy will dial, then bring up the per-issue VM with the workspace
   * mounted at the same host path. Uses a baked artifact (`--from`) when the
   * reconciler has one ready (issue 32) — that skips the per-start
   * `[dev].init` cost.
   *
   * On bring-up failure runs `after_run` best-effort; the half-created VM is
   * the reconciler `vm` resource's problem (issue 52). Throws `AttemptAbort`.
   */
  private async bringUpVm(
    shell: AttemptShell,
    adapter: AdapterRuntime,
    issue: Issue,
  ): Promise<AttemptVm> {
    const { workspace, resolved, initialHooks, io } = shell;
    if (!this.acpBridge) {
      io.logger.error('acp bridge is not configured', {});
      throw new AttemptAbort({
        ok: false,
        reason: 'acp bridge unavailable',
        threadId: null,
        turnsCompleted: 0,
      });
    }
    const reachUrl =
      this.cfg.acp.bridge.reach_url ??
      `tcp://${this.cfg.acp.bridge.reach_host}:${this.acpBridge.port() ?? this.cfg.acp.bridge.bind_port}`;
    const vmName = this.vmNameFor(issue);
    try {
      await this.smolvm.ensureRunning(vmName, this.buildEnsureRunningOptions(shell));
    } catch (err) {
      io.logger.error('smolvm bring-up failed', { error: (err as Error).message });
      await this.workspaces.runAfterRunBestEffort(
        workspace.path,
        initialHooks,
        io.hookCapture('after_run'),
      );
      throw new AttemptAbort({
        ok: false,
        reason: 'smolvm bring-up error',
        threadId: null,
        turnsCompleted: 0,
      });
    }
    return { shell, adapter, vmName, reachUrl };
  }

  /**
   * Compose mounts + forwarded env + baked-artifact source selection for
   * `ensureRunning`. Pulled out of `bringUpVm` so the latter stays focused on
   * the bring-up control flow and stays under the shell-complexity budget.
   */
  private buildEnsureRunningOptions(
    shell: AttemptShell,
  ): Parameters<SmolvmClient['ensureRunning']>[1] {
    const { workspace } = shell;
    const bakedFrom = this.bakedArtifacts?.artifactPath() ?? null;
    return {
      image: bakedFrom ? null : this.cfg.smolvm.image,
      from: bakedFrom ?? this.cfg.smolvm.from,
      smolfile: bakedFrom ? null : this.cfg.smolvm.smolfile,
      cpus: this.cfg.smolvm.cpus,
      memMib: this.cfg.smolvm.mem_mib,
      net: this.cfg.smolvm.net,
      mounts: this.buildVmMounts(shell),
      env: this.buildForwardedEnv(),
      workdir: workspace.path,
      sshAgent: false,
    };
  }

  private buildVmMounts(shell: AttemptShell): { host: string; guest: string; readonly: boolean }[] {
    const mounts: { host: string; guest: string; readonly: boolean }[] = [
      { host: shell.workspace.path, guest: shell.workspace.path, readonly: false },
    ];
    for (const v of this.cfg.smolvm.volumes) {
      mounts.push({ host: v.host, guest: v.guest, readonly: v.readonly });
    }
    for (const m of buildEvalModeMounts(this.cfg, shell.resolved)) {
      mounts.push(m);
    }
    return mounts;
  }

  private buildForwardedEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const k of this.cfg.smolvm.forward_env) {
      const v = process.env[k];
      if (v && v.length > 0) env[k] = v;
    }
    return env;
  }

  /**
   * Stage 4: register with the ACP bridge (AFTER VM bring-up — see the
   * cancel-rejects-without-handler note in the original code), exec the
   * in-VM proxy, attach the stderr tap, then race the bridge handshake
   * against the configured connect timeout, set up MCP, construct the
   * AcpClient, and call `initSession`.
   *
   * From this stage on, abort paths must go through `cleanupAttempt` rather
   * than just running `after_run`, because the VM is live and the bridge
   * registration / exec stream / socket need explicit teardown.
   */
  private async connectAndInitSession(
    vm: AttemptVm,
    issue: Issue,
    runningEntry: RunningEntry | undefined,
    cancelSignal: { cancelled: boolean },
  ): Promise<AttemptSession> {
    const bridgeReg = await this.registerBridgeOrAbort(vm, issue);
    const execStream = this.startExecAndStderrTap(vm, bridgeReg, issue);
    const acpSocket = await this.awaitBridgeHandshake(vm, bridgeReg, execStream, issue, runningEntry);
    const mcpServers = await this.attachMcpOrAbort(
      { vm, bridgeReg, execStream, acpSocket, runningEntry },
      issue,
    );
    const client = this.buildAcpClient(vm, issue, execStream, acpSocket, mcpServers);
    const cancelCheckTimer = setInterval(
      () => this.onCancelTick(cancelSignal, client, execStream, acpSocket),
      500,
    );
    const session: AttemptSession = {
      vm,
      bridgeReg,
      execStream,
      acpSocket,
      client,
      sessionId: '',
      cancelCheckTimer,
      runningEntry,
      nonRoutedActionFailureReason: null,
    };
    await this.initSessionOrAbort(session, issue);
    this.events.onSessionStarted?.({
      issueId: issue.id,
      sessionId: session.sessionId,
      threadId: session.sessionId,
      pid: execStream.pid ? String(execStream.pid) : null,
    });
    return session;
  }

  private async registerBridgeOrAbort(
    vm: AttemptVm,
    issue: Issue,
  ): Promise<ReturnType<AcpBridge['register']>> {
    const bridge = this.acpBridge;
    if (!bridge) {
      // Should never happen — bringUpVm already validated this. Defense in depth.
      throw new AttemptAbort({
        ok: false,
        reason: 'acp bridge unavailable',
        threadId: null,
        turnsCompleted: 0,
      });
    }
    try {
      return bridge.register(issue.id, issue.identifier);
    } catch (err) {
      vm.shell.io.logger.error('acp bridge register failed', { error: (err as Error).message });
      await this.workspaces.runAfterRunBestEffort(
        vm.shell.workspace.path,
        vm.shell.initialHooks,
        vm.shell.io.hookCapture('after_run'),
      );
      throw new AttemptAbort({
        ok: false,
        reason: 'acp bridge register failed',
        threadId: null,
        turnsCompleted: 0,
      });
    }
  }

  /**
   * Exec the in-VM proxy and attach a stderr tap that mirrors raw chunks
   * into the run log and a truncated form into the orchestrator's event ring.
   * The tap is attached BEFORE the bridge handshake so pre-connect crashes
   * (vm-agent missing, malformed env, adapter exits during startup) are
   * captured for debugging.
   */
  private startExecAndStderrTap(
    vm: AttemptVm,
    bridgeReg: ReturnType<AcpBridge['register']>,
    issue: Issue,
  ): ReturnType<SmolvmClient['execInteractive']> {
    const { shell, adapter, vmName, reachUrl } = vm;
    const execStream = this.smolvm.execInteractive(vmName, {
      command: [this.cfg.acp.shell, '-lc', adapter.effectiveCommand],
      workdir: shell.workspace.path,
      env: {
        SYMPHONY_ACP_URL: reachUrl,
        SYMPHONY_ACP_TOKEN: bridgeReg.token,
        SYMPHONY_ADAPTER_BIN: adapter.adapterBin,
        SYMPHONY_ADAPTER_ARGS: JSON.stringify(adapter.effectiveArgs),
        ...adapter.runtimeEnv,
      },
      timeoutMs: null,
    });
    // ACP frames flow over the bridge socket, not exec stdio; close stdin
    // immediately. The exec channel just carries diagnostic stderr and acts
    // as a process tether so we can kill the in-VM agent by closing the exec.
    execStream.stdin.end();
    execStream.stderr.setEncoding('utf8');
    execStream.stderr.on('data', (chunk: string) =>
      this.onStderrChunk(chunk, issue, shell.io),
    );
    return execStream;
  }

  private onStderrChunk(chunk: string, issue: Issue, io: AttemptIo): void {
    io.runLog?.record({ channel: 'stderr', text: chunk });
    const text = chunk.trim();
    if (text.length === 0) return;
    this.events.onRuntimeEvent(issue.id, {
      at: new Date().toISOString(),
      event: 'agent_stderr',
      message: text.length > 240 ? text.slice(0, 240) + '…' : text,
    });
    io.logger.info('agent stderr', { text: text.slice(0, 500) });
  }

  /**
   * Wait for the in-VM agent to dial back and authenticate, bounded by
   * `acp.bridge.connect_timeout_ms` so a stuck VM or misconfigured
   * `reach_host` cannot hang the attempt until the orchestrator's stall
   * timer fires much later.
   */
  private async awaitBridgeHandshake(
    vm: AttemptVm,
    bridgeReg: ReturnType<AcpBridge['register']>,
    execStream: ReturnType<SmolvmClient['execInteractive']>,
    issue: Issue,
    runningEntry: RunningEntry | undefined,
  ): Promise<Socket> {
    const { shell, reachUrl } = vm;
    try {
      const sock = await Promise.race([
        bridgeReg.accepted,
        new Promise<Socket>((_, reject) =>
          setTimeout(
            () => reject(new Error('acp bridge: in-VM agent did not connect in time')),
            this.cfg.acp.bridge.connect_timeout_ms,
          ),
        ),
      ]);
      shell.io.runLog?.system('acp_bridge_connected', { reach_url: reachUrl });
      return sock;
    } catch (err) {
      shell.io.logger.error('acp bridge connect timeout', { error: (err as Error).message });
      shell.io.runLog?.system('acp_bridge_failed', { error: (err as Error).message });
      await this.tearDownPartialAndAbort(
        { vm, bridgeReg, execStream, runningEntry, acpSocket: null },
        issue,
        'acp_bridge_connect_failed',
      );
      throw new AttemptAbort({
        ok: false,
        reason: 'acp bridge connect failed',
        threadId: null,
        turnsCompleted: 0,
      });
    }
  }

  /**
   * Cancellation tear-down. Three things have to happen for the runner to
   * unwind a stuck `client.runPrompt()`: `cancel()` (polite), `forceClose()`
   * (rejects pending requests), then kill the host-side exec + destroy the
   * socket so the bridge entry is reclaimed.
   */
  private onCancelTick(
    cancelSignal: { cancelled: boolean },
    client: AcpClient,
    execStream: ReturnType<SmolvmClient['execInteractive']>,
    acpSocket: Socket | null,
  ): void {
    if (!cancelSignal.cancelled) return;
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

  private buildAcpClient(
    vm: AttemptVm,
    issue: Issue,
    execStream: ReturnType<SmolvmClient['execInteractive']>,
    acpSocket: Socket,
    mcpServers: McpServer[],
  ): AcpClient {
    const { shell } = vm;
    return new AcpClient({
      stdin: acpSocket,
      stdout: acpSocket,
      stderr: execStream.stderr,
      cwd: shell.workspace.path,
      readTimeoutMs: this.cfg.acp.read_timeout_ms,
      promptTimeoutMs: this.cfg.acp.prompt_timeout_ms,
      onEvent: (event) => this.events.onRuntimeEvent(issue.id, event),
      onTokenUsage: (u) => this.events.onTokenUsage(issue.id, u),
      mcpServers,
      runLog: shell.io.runLog,
    });
  }

  /**
   * Register with the MCP registry so the agent's tool calls can be routed
   * back. MCP is required for symphony operations: `transition` is the only
   * way for the agent to signal completion (or hand off to another state),
   * and `request_human_steering` is the only way to defer to a human.
   *
   * Returns the McpServer array the AcpClient should advertise to the
   * adapter on session/new — empty when MCP is disabled or no running entry
   * is wired. Aborts the attempt if MCP is required but unavailable/unreachable.
   */
  private async attachMcpOrAbort(
    partial: {
      vm: AttemptVm;
      bridgeReg: ReturnType<AcpBridge['register']>;
      execStream: ReturnType<SmolvmClient['execInteractive']>;
      acpSocket: Socket;
      runningEntry: RunningEntry | undefined;
    },
    issue: Issue,
  ): Promise<McpServer[]> {
    const { runningEntry } = partial;
    if (!this.cfg.mcp.enabled || !runningEntry) return [];
    const logger = partial.vm.shell.io.logger;
    if (!this.mcp) {
      await this.tearDownPartialAndAbort(partial, issue, 'mcp_registry_unavailable');
      logger.error('mcp is required but no registry is wired into the runner', {});
      throw new AttemptAbort({
        ok: false,
        reason: 'mcp required but registry unavailable',
        threadId: null,
        turnsCompleted: 0,
      });
    }
    const url = this.mcp.buildUrl(runningEntry.identifier, {
      host: this.cfg.mcp.host,
      explicit_host_url: this.cfg.mcp.explicit_host_url,
    });
    if (!url) {
      await this.tearDownPartialAndAbort(partial, issue, 'mcp_url_unavailable');
      logger.error('mcp is required but no reachable URL is configured', {
        host: this.cfg.mcp.host,
        explicit_host_url: this.cfg.mcp.explicit_host_url,
      });
      throw new AttemptAbort({
        ok: false,
        reason: 'mcp required but URL unavailable (start the HTTP server or set mcp.host_url)',
        threadId: null,
        turnsCompleted: 0,
      });
    }
    const token = this.mcp.activate(runningEntry);
    logger.debug('mcp registered', { url });
    return [
      {
        type: 'http',
        name: 'symphony',
        url,
        headers: [{ name: 'Authorization', value: `Bearer ${token}` }],
      },
    ];
  }

  private async initSessionOrAbort(session: AttemptSession, issue: Issue): Promise<void> {
    const logger = session.vm.shell.io.logger;
    try {
      const sess = await session.client!.initSession();
      session.sessionId = sess.sessionId;
    } catch (err) {
      logger.error('acp init failed', {
        error: (err as Error).message,
        adapter: session.vm.shell.resolved.adapter,
      });
      this.events.onRuntimeEvent(issue.id, {
        at: new Date().toISOString(),
        event: 'startup_failed',
        message: (err as Error).message,
      });
      await this.cleanupAttempt(session, 'init_failed');
      throw new AttemptAbort({
        ok: false,
        reason: 'agent session startup error',
        threadId: null,
        turnsCompleted: 0,
      });
    }
  }

  /**
   * Drive the autonomous-plus-steering turn loop. The loop runs as long as
   * the agent keeps engaging — only autonomous turns count against
   * `max_turns`; steering-reply turns run free because the human is in the
   * loop and can stop work at any time. Returns a `TurnLoopResult` capturing
   * the loop's break reason and any agent-side failure for the final
   * `decideAttemptOutcome` call.
   */
  private async runTurnLoop(
    session: AttemptSession,
    issue: Issue,
    attempt: number | null,
    cancelSignal: { cancelled: boolean },
  ): Promise<TurnLoopResult> {
    const state: TurnLoopState = {
      turnsCompleted: 0,
      autonomousTurns: 0,
      lastReason: 'unknown',
      agentFailure: null,
      currentIssue: issue,
      pendingSteering: null,
      firstTurn: true,
    };
    const activeStates = new Set(activeStateNames(this.cfg.states).map((s) => s.toLowerCase()));
    while (true) {
      if (cancelSignal.cancelled) {
        state.lastReason = 'cancelled_by_reconciliation';
        break;
      }
      const step = await this.runOneTurn(state, session, issue, attempt, cancelSignal, activeStates);
      if (step === 'break') break;
      if (step === 'delay') await delay(25);
    }
    return {
      turnsCompleted: state.turnsCompleted,
      lastReason: state.lastReason,
      agentFailure: state.agentFailure,
    };
  }

  /**
   * One turn iteration: render + send the prompt, classify the outcome, then
   * decide whether to break, continue (queued steering reply), or sleep
   * before the next iteration. Mutates `state` in place; returns the loop's
   * next control-flow verdict so `runTurnLoop` stays under the shell
   * statement budget.
   */
  private async runOneTurn(
    state: TurnLoopState,
    session: AttemptSession,
    issue: Issue,
    attempt: number | null,
    cancelSignal: { cancelled: boolean },
    activeStates: ReadonlySet<string>,
  ): Promise<'break' | 'continue' | 'delay'> {
    const prompt = await this.renderTurnPromptOrAbort(state, session, issue, attempt);
    const isSteeringReply = state.pendingSteering !== null;
    state.pendingSteering = null;
    state.firstTurn = false;
    this.events.onTurn(issue.id, state.turnsCompleted + 1);
    const outcome = await session.client!.runPrompt(prompt);
    if (outcome.reason !== 'end_turn') {
      applyNonEndTurnOutcome(state, outcome, session.runningEntry);
      return 'break';
    }
    state.turnsCompleted++;
    if (!isSteeringReply) state.autonomousTurns++;
    return this.evaluateTurnContinuation(state, session, issue, cancelSignal, activeStates);
  }

  private async renderTurnPromptOrAbort(
    state: TurnLoopState,
    session: AttemptSession,
    issue: Issue,
    attempt: number | null,
  ): Promise<string> {
    try {
      if (state.pendingSteering) {
        return buildSteeringReplyPrompt(
          state.pendingSteering.question,
          state.pendingSteering.context,
          state.pendingSteering.reply,
        );
      }
      if (state.firstTurn) {
        return await renderPrompt({
          template: this.workflow.prompt_template,
          issue: state.currentIssue,
          attempt,
        });
      }
      return continuationPrompt(this.cfg.mcp.enabled);
    } catch (err) {
      session.vm.shell.io.logger.error('prompt rendering failed', { error: (err as Error).message });
      if (session.cancelCheckTimer) clearInterval(session.cancelCheckTimer);
      await this.cleanupAttempt(session, 'prompt_error');
      throw new AttemptAbort({
        ok: false,
        reason: 'prompt error',
        threadId: session.sessionId,
        turnsCompleted: state.turnsCompleted,
      });
    }
  }

  /**
   * After a successful end_turn, decide whether to continue, await human
   * steering, or break the loop with a final `lastReason`. Returns:
   *   - 'break'    : the loop should exit; `state.lastReason` is set
   *   - 'continue' : a steering reply is queued; skip the delay and re-enter
   *   - 'delay'    : another autonomous turn; sleep 25ms then re-enter
   */
  private async evaluateTurnContinuation(
    state: TurnLoopState,
    session: AttemptSession,
    issue: Issue,
    cancelSignal: { cancelled: boolean },
    activeStates: ReadonlySet<string>,
  ): Promise<'break' | 'continue' | 'delay'> {
    const { runningEntry } = session;
    if (runningEntry?.transitioned) {
      state.lastReason = 'agent_transitioned';
      return 'break';
    }
    if (runningEntry?.steering_requested && this.mcp) {
      const broke = await this.handleSteering(state, session, issue, cancelSignal);
      return broke ? 'break' : 'continue';
    }
    return this.refreshAndDecide(state, session, issue, activeStates);
  }

  private async handleSteering(
    state: TurnLoopState,
    session: AttemptSession,
    issue: Issue,
    cancelSignal: { cancelled: boolean },
  ): Promise<boolean> {
    const entry = session.runningEntry!;
    const question = entry.steering_question ?? '';
    const ctx = entry.steering_context;
    this.events.onRuntimeEvent(issue.id, {
      at: new Date().toISOString(),
      event: 'awaiting_human_steering',
      message: question.length > 240 ? question.slice(0, 240) + '…' : question,
    });
    const reply = await this.mcp!.awaitSteeringReply(issue.identifier, cancelSignal);
    if (reply === null) {
      state.lastReason = 'cancelled_while_awaiting_steering';
      return true;
    }
    entry.steering_requested = false;
    entry.steering_question = null;
    entry.steering_context = null;
    state.pendingSteering = { question, context: ctx, reply };
    this.events.onRuntimeEvent(issue.id, {
      at: new Date().toISOString(),
      event: 'human_steering_received',
      message: reply.length > 240 ? reply.slice(0, 240) + '…' : reply,
    });
    return false;
  }

  private async refreshAndDecide(
    state: TurnLoopState,
    session: AttemptSession,
    issue: Issue,
    activeStates: ReadonlySet<string>,
  ): Promise<'break' | 'delay'> {
    let refreshed: Issue[];
    try {
      refreshed = await this.tracker.fetchIssueStatesByIds([issue.id]);
    } catch (err) {
      session.vm.shell.io.logger.error('issue state refresh failed', {
        error: (err as Error).message,
      });
      if (session.cancelCheckTimer) clearInterval(session.cancelCheckTimer);
      await this.cleanupAttempt(session, 'issue_state_refresh_failed');
      throw new AttemptAbort({
        ok: false,
        reason: 'issue state refresh error',
        threadId: session.sessionId,
        turnsCompleted: state.turnsCompleted,
      });
    }
    const found = refreshed[0];
    if (!found) {
      state.lastReason = 'issue_no_longer_present';
      return 'break';
    }
    state.currentIssue = found;
    if (!activeStates.has(found.state.toLowerCase())) {
      state.lastReason = 'issue_no_longer_active';
      return 'break';
    }
    if (state.autonomousTurns >= session.vm.shell.resolved.max_turns) {
      state.lastReason = 'max_turns_reached';
      return 'break';
    }
    return 'delay';
  }

  /**
   * Full attempt cleanup once the VM is up and the bridge has been registered.
   * Cancels the bridge registration, tears down connections, runs the
   * integration-merge handoff (issue 19), then dispatches either the typed
   * `actions:` ledger or the legacy `after_run` hook based on the resolved
   * post-transition state.
   *
   * Captures non-routed action failures into `session.nonRoutedActionFailureReason`
   * so the final `decideAttemptOutcome` surfaces a failed push / pr-create
   * instead of silently marking the issue done.
   */
  private async cleanupAttempt(
    session: AttemptSession,
    reason: string,
  ): Promise<void> {
    this.tearDownConnections(session, reason);
    const merge = await this.runIntegrationMergeIfGated(session);
    const cleanupHooks = resolveHooksForState(this.cfg, merge.cleanupState);
    const cleanupActions = resolveActionsForState(this.cfg, merge.cleanupState);
    const cleanupExec = decideCleanupExecution({
      integrationFailed: merge.failed,
      hasRunningEntry: session.runningEntry !== undefined,
      actionsLength: cleanupActions?.length ?? 0,
      hasAfterRunHook: Boolean(cleanupHooks.after_run),
    });
    await this.runTerminalCleanupTail(session, merge, cleanupHooks, cleanupActions, cleanupExec);
    session.vm.shell.io.runLog?.system('vm_teardown_deferred', {
      vm: session.vm.vmName,
      reason,
    });
  }

  /**
   * Sync part of cleanup: cancel the bridge registration, destroy the
   * socket, kill the exec stream, drain its exit, deactivate MCP. Idempotent
   * on already-torn-down state so callers above can call it twice (the
   * mid-attempt failure path runs it once; the loop's final cleanup runs it
   * again).
   */
  private tearDownConnections(session: AttemptSession, reason: string): void {
    session.bridgeReg.cancel(reason);
    try {
      if (session.acpSocket && !session.acpSocket.destroyed) session.acpSocket.destroy();
    } catch {
      /* ignore */
    }
    try {
      session.execStream.kill();
    } catch {
      /* ignore */
    }
    session.execStream.exit.catch(() => undefined);
    if (this.mcp && session.runningEntry) {
      this.mcp.deactivate(session.runningEntry.identifier);
    }
    session.vm.shell.io.logger.debug('agent runner cleanup', { reason });
  }

  /**
   * Run the shared-integration-branch merge handoff (issue 19) when the
   * agent has transitioned into a state opted in to
   * `integration.merge_on_states`. On success returns `{cleanupState,
   * failed: false}` so the caller proceeds into the same `actions:`/`after_run`
   * path the Done state expects. On failure reroutes the issue to the
   * configured conflict state, preserves the workspace + branch, and
   * returns `{cleanupState: <conflict state>, failed: true}` so the caller
   * picks up that state's hooks (typically none) and skips after_run.
   *
   * Falls back to the dispatch-time state when no running entry is wired
   * (the runner can be invoked without one for the headless path).
   */
  private async runIntegrationMergeIfGated(
    session: AttemptSession,
  ): Promise<{ cleanupState: string; failed: boolean }> {
    const { runningEntry } = session;
    // Resolve after_run against the issue's CURRENT state. If the agent called
    // symphony.transition during the attempt, the MCP handler updated
    // runningEntry.issue.state to the new state, so terminal-state hooks fire
    // instead of the initial state's. Falls back to the resolved dispatch
    // state when no entry is wired or the transition never happened.
    const cleanupState = runningEntry?.issue.state ?? session.vm.shell.initialState;
    if (!runningEntry) return { cleanupState, failed: false };
    const liveState = runningEntry.issue.state;
    const integrationCfg = this.cfg.integration;
    const gated = shouldRunIntegrationMerge({
      transitioned: runningEntry.transitioned,
      cleanupState: liveState,
      mergeOnStates: integrationCfg.merge_on_states,
    });
    if (!gated) return { cleanupState: liveState, failed: false };
    const result = await this.performMergeAndLog(session, runningEntry, liveState);
    if (result.ok) return { cleanupState: liveState, failed: false };
    await routeIntegrationFailureToConflict(
      this.tracker,
      runningEntry,
      integrationCfg.conflict_state,
      result,
    );
    // The reroute mutated runningEntry.issue.state to the conflict state. Pick
    // up the new state so after_run resolves against the conflict-state hooks
    // (typically none) and so vm_teardown_deferred logging shows the new state.
    return { cleanupState: runningEntry.issue.state, failed: true };
  }

  private async performMergeAndLog(
    session: AttemptSession,
    runningEntry: RunningEntry,
    terminalState: string,
  ): Promise<Awaited<ReturnType<typeof performIntegrationMerge>>> {
    const integrationCfg = this.cfg.integration;
    const io = session.vm.shell.io;
    const remote = resolveIntegrationRemote(session.vm.shell.workspace.path);
    io.runLog?.system('integration_merge_started', {
      identifier: runningEntry.identifier,
      integration_branch: integrationCfg.branch,
      terminal_state: terminalState,
      remote: remote.kind,
    });
    const result = await performIntegrationMerge({
      workspacePath: session.vm.shell.workspace.path,
      identifier: runningEntry.identifier,
      integrationBranch: integrationCfg.branch,
      baseBranch: process.env.SYMPHONY_BASE_BRANCH || 'main',
      remote,
      timeoutMs: this.cfg.hooks.timeout_ms,
      capture: io.hookCapture('integration_merge'),
    });
    if (result.ok) {
      io.runLog?.system('integration_merge_succeeded', {
        integration_branch: result.integrationBranch,
        remote: result.remote,
        merged_at: result.merged_at,
      });
    } else {
      io.runLog?.system('integration_merge_failed', {
        reason: result.reason,
        integration_branch: result.integrationBranch,
        remote: result.remote,
        diagnostic: result.diagnostic.slice(0, 2000),
      });
    }
    return result;
  }

  /**
   * Stage SYMPHONY_* env vars + a temp body file once, then dispatch either
   * the typed `actions:` ledger (issue 36 AC2 — wins over hooks.after_run) or
   * the legacy `after_run` shell hook. Both consume the same staged env, so
   * building it once avoids two redundant tracker reads on the Done state.
   * Captures non-routed action failures back into the session so the final
   * `decideAttemptOutcome` surfaces them.
   */
  private async runTerminalCleanupTail(
    session: AttemptSession,
    cleanupState: { cleanupState: string; failed: boolean },
    cleanupHooks: ReturnType<typeof resolveHooksForState>,
    cleanupActions: readonly WorkflowAction[] | undefined,
    cleanupExec: ReturnType<typeof decideCleanupExecution>,
  ): Promise<void> {
    const staged = shouldStageAfterRunEnv({
      integrationFailed: cleanupState.failed,
      hasRunningEntry: session.runningEntry !== undefined,
      actionsLength: cleanupActions?.length ?? 0,
      hasAfterRunHook: Boolean(cleanupHooks.after_run),
    })
      ? await this.stageAfterRunEnvBestEffort(session)
      : { env: undefined, cleanup: null };
    try {
      await this.dispatchCleanupExec(
        cleanupExec,
        session,
        cleanupState.cleanupState,
        cleanupHooks,
        cleanupActions,
        staged.env,
      );
    } finally {
      if (staged.cleanup) await staged.cleanup();
    }
  }

  /**
   * Stage SYMPHONY_* env vars + a temp body file. Logs a warning and returns
   * an empty result if staging itself fails — the hook can still run, it just
   * won't see the PR-mode vars. The cleanup closure is returned alongside so
   * the caller can run it under `finally` regardless of the dispatch outcome.
   */
  private async stageAfterRunEnvBestEffort(
    session: AttemptSession,
  ): Promise<{ env: Record<string, string> | undefined; cleanup: (() => Promise<void>) | null }> {
    try {
      const out = await buildAfterRunHookEnv(session.runningEntry!);
      return { env: out.env, cleanup: out.cleanup };
    } catch (err) {
      session.vm.shell.io.logger.warn(
        'after_run env staging failed; running hook without SYMPHONY_PR_* vars',
        { error: (err as Error).message },
      );
      return { env: undefined, cleanup: null };
    }
  }

  private async dispatchCleanupExec(
    cleanupExec: ReturnType<typeof decideCleanupExecution>,
    session: AttemptSession,
    cleanupState: string,
    cleanupHooks: ReturnType<typeof resolveHooksForState>,
    cleanupActions: readonly WorkflowAction[] | undefined,
    extraEnv: Record<string, string> | undefined,
  ): Promise<void> {
    const io = session.vm.shell.io;
    if (cleanupExec === 'actions' && session.runningEntry && cleanupActions) {
      const runInVm: RunInVmExecutor = this.buildVmRunInVm(session.vm.vmName, io.runLog);
      const result = await this.runStateActions(
        cleanupState,
        cleanupActions,
        session.runningEntry,
        session.vm.shell.workspace.path,
        extraEnv,
        io.hookCapture('actions'),
        runInVm,
      );
      if (!result.ok && !result.route_to) {
        session.nonRoutedActionFailureReason = result.reason ?? 'unknown';
      }
      return;
    }
    if (cleanupExec === 'hook') {
      await this.workspaces.runAfterRunBestEffort(
        session.vm.shell.workspace.path,
        cleanupHooks,
        io.hookCapture('after_run'),
        extraEnv,
      );
    }
  }

  /**
   * Pre-session-ready helper: tear down connections and run the post-VM
   * cleanup pass. Used by stage helpers (`awaitBridgeHandshake`,
   * `attachMcpOrAbort`, `initSessionOrAbort`) that need to abort after VM
   * bring-up but before the AcpClient is wired up. We synthesize a minimal
   * `AttemptSession` so the same `cleanupAttempt` body runs against the
   * partial state.
   */
  private async tearDownPartialAndAbort(
    partial: {
      vm: AttemptVm;
      bridgeReg: ReturnType<AcpBridge['register']>;
      execStream: ReturnType<SmolvmClient['execInteractive']>;
      runningEntry: RunningEntry | undefined;
      acpSocket: Socket | null;
    },
    _issue: Issue,
    reason: string,
  ): Promise<void> {
    const session: AttemptSession = {
      vm: partial.vm,
      bridgeReg: partial.bridgeReg,
      execStream: partial.execStream,
      acpSocket: partial.acpSocket,
      client: null,
      sessionId: '',
      cancelCheckTimer: null,
      runningEntry: partial.runningEntry,
      nonRoutedActionFailureReason: null,
    };
    await this.cleanupAttempt(session, reason);
  }
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

function makeHookCapture(
  runLog: RunLog | undefined,
): (hook: string) => HookCapture | undefined {
  if (!runLog) return () => undefined;
  return (hook: string) => ({
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
  });
}

async function applyRuntimeInjection(
  inj: ModelInjection,
  workspacePath: string,
  env: Record<string, string>,
  args: string[],
  files: ExtraGuestFile[],
): Promise<void> {
  if (inj.env) {
    for (const [k, v] of Object.entries(inj.env)) env[k] = v;
  }
  if (inj.extraArgs) args.push(...inj.extraArgs);
  if (inj.stagedFiles) {
    for (const f of inj.stagedFiles) {
      const stagedFile = await stageRuntimeFile(workspacePath, f.stagedName, f.content);
      files.push({ stagedRelPath: stagedFile.relPath, guestPath: f.guestPath });
    }
  }
}

function applyNonEndTurnOutcome(
  state: TurnLoopState,
  outcome: Awaited<ReturnType<AcpClient['runPrompt']>>,
  runningEntry: RunningEntry | undefined,
): void {
  if (runningEntry?.transitioned) {
    state.lastReason = 'agent_transitioned';
    return;
  }
  state.lastReason = outcome.reason;
  state.agentFailure = `agent turn ${outcome.reason}: ${outcome.message}`;
}
