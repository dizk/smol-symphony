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

export class AgentRunner {
  constructor(
    private cfg: ServiceConfig,
    private workflow: WorkflowDefinition,
    private workspaces: WorkspaceManager,
    private tracker: IssueTracker,
    private smolvm: SmolvmClient,
    private events: AgentRunnerEvents,
    private mcp: McpRegistry | null = null,
  ) {}

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
  ): Promise<RunAttemptResult> {
    const logger = withIssue({ issue_id: issue.id, issue_identifier: issue.identifier });
    let workspace: Awaited<ReturnType<WorkspaceManager['ensureFor']>>;
    try {
      workspace = await this.workspaces.ensureFor(issue.identifier);
    } catch (err) {
      logger.error('workspace error', { error: (err as Error).message });
      return { ok: false, reason: 'workspace error', threadId: null, turnsCompleted: 0 };
    }

    try {
      await this.workspaces.runBeforeRun(workspace.path, this.cfg.hooks);
    } catch (err) {
      logger.error('before_run hook failed', { error: (err as Error).message });
      return { ok: false, reason: 'before_run hook error', threadId: null, turnsCompleted: 0 };
    }

    // Resolve which adapter binary to launch and how to feed it credentials. Two
    // paths:
    //   1. acp.command is set in WORKFLOW.md → use it verbatim (operator owns
    //      credential handling; symphony stays out of the way).
    //   2. acp.command is null → look up the adapter profile, stage the host
    //      credential into the workspace, and synthesize a launch command that
    //      copies the cred into the adapter's expected location and exec's the
    //      adapter binary.
    let effectiveAcpCommand: string;
    if (this.cfg.acp.command !== null) {
      effectiveAcpCommand = this.cfg.acp.command;
    } else if (isKnownAdapter(this.cfg.acp.adapter)) {
      const profile = ADAPTERS[this.cfg.acp.adapter as AcpAdapterId];
      let staged;
      try {
        staged = await stageCredential(workspace.path, profile);
      } catch (err) {
        logger.error('credential staging failed', {
          adapter: profile.id,
          error: (err as Error).message,
        });
        await this.workspaces.runAfterRunBestEffort(workspace.path, this.cfg.hooks);
        return { ok: false, reason: 'credential staging error', threadId: null, turnsCompleted: 0 };
      }
      effectiveAcpCommand = deriveAcpCommand(profile, staged.relPath);
    } else {
      // validateDispatch should have caught this, but defend in depth.
      logger.error('no acp launch path', { adapter: this.cfg.acp.adapter });
      return { ok: false, reason: 'no acp launch path configured', threadId: null, turnsCompleted: 0 };
    }

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
    } catch (err) {
      logger.error('smolvm bring-up failed', { error: (err as Error).message });
      await this.workspaces.runAfterRunBestEffort(workspace.path, this.cfg.hooks);
      return { ok: false, reason: 'smolvm bring-up error', threadId: null, turnsCompleted: 0 };
    }

    const execStream = this.smolvm.execInteractive(vmName, {
      command: [this.cfg.acp.shell, '-lc', effectiveAcpCommand],
      workdir: workspace.path,
      env: {},
      timeoutMs: null,
    });

    const cleanup = async (reason: string) => {
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
      await this.workspaces.runAfterRunBestEffort(workspace.path, this.cfg.hooks);
    };

    const onCancel = () => {
      if (cancelSignal.cancelled) {
        client.cancel().catch(() => undefined);
        execStream.kill();
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

    const client = new AcpClient({
      stdin: execStream.stdin,
      stdout: execStream.stdout,
      stderr: execStream.stderr,
      cwd: workspace.path,
      readTimeoutMs: this.cfg.acp.read_timeout_ms,
      promptTimeoutMs: this.cfg.acp.prompt_timeout_ms,
      onEvent: (event) => this.events.onRuntimeEvent(issue.id, event),
      onTokenUsage: (u) => this.events.onTokenUsage(issue.id, u),
      mcpServers,
    });

    let sessionId: string;
    try {
      const sess = await client.initSession();
      sessionId = sess.sessionId;
    } catch (err) {
      clearInterval(cancelCheckTimer);
      logger.error('acp init failed', {
        error: (err as Error).message,
        adapter: this.cfg.acp.adapter,
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
      if (autonomousTurns >= this.cfg.agent.max_turns) {
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
