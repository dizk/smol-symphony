// Agent Runner (SPEC §10.7): workspace + prompt + ACP session, with continuation turns up
// to agent.max_turns. The ACP adapter (claude-agent-acp / codex-acp / opencode acp) runs
// inside a per-issue smolvm machine. The host workspace directory is volume-mounted into
// the VM at the same absolute path so cwd values are consistent.

import { setTimeout as delay } from 'node:timers/promises';
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
import { SmolvmClient } from './smolvm.js';
import { AcpClient } from './acp.js';
import {
  ADAPTERS,
  deriveAcpCommand,
  isKnownAdapter,
  stageCredential,
  type AcpAdapterId,
} from './adapters.js';
import type { McpRegistry } from '../mcp.js';
import { withIssue } from '../logging.js';
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
  'Continue working on the same issue. Pick up where the prior turn left off and proceed with the next concrete action. If the work is fully complete, summarize what changed and call the symphony.mark_done tool.';

const CONTINUATION_PROMPT_NO_MCP =
  'Continue working on the same issue. Pick up where the prior turn left off and proceed with the next concrete action. If the work is fully complete, summarize what changed and stop.';

function continuationPrompt(mcpEnabled: boolean): string {
  return mcpEnabled ? CONTINUATION_PROMPT_WITH_MCP : CONTINUATION_PROMPT_NO_MCP;
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
    'Continue work on the issue, taking the human response into account. If the work is fully complete, call symphony.mark_done. If you need to ask another question, call symphony.request_human_steering again.',
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
  max_turns: number;
}

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
  const states = cfg.states ?? {};
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
  const max_turns = s.max_turns ?? cfg.agent.max_turns;
  return { adapter, model, max_turns };
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
    return `symphony-${sanitizeWorkspaceKey(issue.identifier)}`.toLowerCase();
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
    let workspace: Awaited<ReturnType<WorkspaceManager['ensureFor']>>;
    try {
      workspace = await this.workspaces.ensureFor(issue.identifier, hookCapture('after_create'));
    } catch (err) {
      logger.error('workspace error', { error: (err as Error).message });
      return { ok: false, reason: 'workspace error', threadId: null, turnsCompleted: 0 };
    }

    try {
      await this.workspaces.runBeforeRun(workspace.path, this.cfg.hooks, hookCapture('before_run'));
    } catch (err) {
      logger.error('before_run hook failed', { error: (err as Error).message });
      return { ok: false, reason: 'before_run hook error', threadId: null, turnsCompleted: 0 };
    }

    // Resolve adapter launch. Under the TCP bridge architecture there is exactly one
    // launch shape: scrub the in-VM credential dir, stage the host credential into the
    // workspace, exec the in-VM proxy at /opt/symphony/vm-agent.mjs. The proxy reads its
    // config (SYMPHONY_ACP_URL/TOKEN/ADAPTER_BIN/ADAPTER_ARGS) from env, dials the
    // host's bridge, and spawns the adapter. The adapter id was already validated up
    // top via `resolved` (which folds in any per-state override), and `acp.command`
    // overrides are rejected by validateDispatch; the branches below are pure data
    // binding off the resolved profile.
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
        this.cfg.hooks,
        hookCapture('after_run'),
      );
      return { ok: false, reason: 'credential staging error', threadId: null, turnsCompleted: 0 };
    }
    const effectiveAcpCommand = deriveAcpCommand(profile, staged.relPath);
    const adapterBin = profile.binary[0]!;
    const adapterArgs = profile.binary.slice(1);
    // Apply the resolved model selection (if any) to the adapter via its profile-
    // specific mechanism: env var for claude-agent-acp, extra argv for codex-acp. The
    // returned env/args are merged into the smolvm-exec invocation below so they reach
    // the vm-agent proxy and then the spawned adapter. `resolved.model` is the per-state
    // override (when set) or the workflow-level acp.model fallback.
    const modelEnv: Record<string, string> = {};
    const modelArgs: string[] = [];
    if (resolved.model) {
      const inj = profile.modelInjection(resolved.model);
      if (inj.env) {
        for (const [k, v] of Object.entries(inj.env)) modelEnv[k] = v;
      }
      if (inj.extraArgs) modelArgs.push(...inj.extraArgs);
    }
    const effectiveAdapterArgs = [...adapterArgs, ...modelArgs];

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
    if (this.cfg.smolvm.bin_path) {
      mounts.push({ host: this.cfg.smolvm.bin_path, guest: '/opt/codex', readonly: true });
    }
    for (const v of this.cfg.smolvm.volumes) {
      mounts.push({ host: v.host, guest: v.guest, readonly: v.readonly });
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
    try {
      await this.smolvm.ensureRunning(vmName, {
        image: this.cfg.smolvm.image,
        from: this.cfg.smolvm.from,
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
      // — leaving a halted VM behind. Attempt a destroy so we don't leak it. No bridge
      // registration exists yet (intentional ordering); nothing else to cancel.
      runLog?.system('vm_destroy', { vm: vmName, reason: 'bring_up_failed' });
      await this.smolvm.destroy(vmName);
      await this.workspaces.runAfterRunBestEffort(
        workspace.path,
        this.cfg.hooks,
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
      runLog?.system('vm_destroy', { vm: vmName, reason: 'bridge_register_failed' });
      await this.smolvm.destroy(vmName);
      await this.workspaces.runAfterRunBestEffort(
        workspace.path,
        this.cfg.hooks,
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
        ...modelEnv,
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
      await this.workspaces.runAfterRunBestEffort(
        workspace.path,
        this.cfg.hooks,
        hookCapture('after_run'),
      );
      // Per the agreed lifecycle, every attempt gets a fresh VM. Destroy is best-effort:
      // smolvm.destroy already swallows errors and logs at warn, so a stuck/lost VM here
      // never aborts the attempt's return path. The next attempt's ensureRunning will
      // notice the VM is absent and create a new one.
      if (vmReady) {
        runLog?.system('vm_destroy', { vm: vmName, reason });
        await this.smolvm.destroy(vmName);
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
    //      after the model has emitted its final text and called `mark_done`).
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
    // MCP is required for symphony operations: mark_done is the only way for the agent
    // to signal completion, and request_human_steering is the only way to defer to a
    // human. If we can't construct a reachable URL — no bound HTTP port and no explicit
    // override — we abort the attempt rather than dispatch a tool-less agent.
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
    const activeStates = new Set(this.cfg.tracker.active_states.map((s) => s.toLowerCase()));

    // Decoupled from max_turns: the loop runs as long as the agent keeps engaging. Only
    // autonomous turns (turns without a pending human reply) count against max_turns.
    // Turns driven by a human steering reply run free; the human is in the loop and can
    // stop work at any time by walking away or by giving an instruction that ends in
    // mark_done.
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
        // mark_done is authoritative: if the agent moved the issue to a terminal state
        // mid-turn, reconcile may have tripped cancelSignal before the prompt returned.
        // The work is done regardless of how the prompt ended; honor that.
        if (runningEntry?.marked_done) {
          lastReason = 'agent_marked_done';
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
      if (runningEntry?.marked_done) {
        lastReason = 'agent_marked_done';
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
    if (agentFailure) {
      return { ok: false, reason: agentFailure, threadId: sessionId, turnsCompleted };
    }
    return { ok: true, reason: lastReason, threadId: sessionId, turnsCompleted };
  }
}
