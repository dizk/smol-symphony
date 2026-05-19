// Agent Runner (SPEC §10.7): workspace + prompt + ACP session, with continuation turns up
// to agent.max_turns. The ACP adapter (claude-agent-acp / codex-acp / opencode acp) runs
// inside a per-issue smolvm machine. The host workspace directory is volume-mounted into
// the VM at the same absolute path so cwd values are consistent.

import { setTimeout as delay } from 'node:timers/promises';
import type {
  Issue,
  RuntimeEvent,
  ServiceConfig,
  WorkflowDefinition,
} from '../types.js';
import type { IssueTracker } from '../trackers/types.js';
import { WorkspaceManager, sanitizeWorkspaceKey } from '../workspace.js';
import { renderPrompt } from '../prompt.js';
import { SmolvmClient } from './smolvm.js';
import { AcpClient } from './acp.js';
import { withIssue } from '../logging.js';

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

const CONTINUATION_PROMPT =
  'Continue working on the same issue. Pick up where the prior turn left off and proceed with the next concrete action. If the work is fully complete, summarize what changed and stop.';

export class AgentRunner {
  constructor(
    private cfg: ServiceConfig,
    private workflow: WorkflowDefinition,
    private workspaces: WorkspaceManager,
    private tracker: IssueTracker,
    private smolvm: SmolvmClient,
    private events: AgentRunnerEvents,
  ) {}

  updateConfig(cfg: ServiceConfig, workflow: WorkflowDefinition): void {
    this.cfg = cfg;
    this.workflow = workflow;
  }

  vmNameFor(issue: Issue): string {
    return `symphony-${sanitizeWorkspaceKey(issue.identifier)}`.toLowerCase();
  }

  async runAttempt(
    issue: Issue,
    attempt: number | null,
    cancelSignal: { cancelled: boolean },
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
      command: [this.cfg.acp.shell, '-lc', this.cfg.acp.command],
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

    const client = new AcpClient({
      stdin: execStream.stdin,
      stdout: execStream.stdout,
      stderr: execStream.stderr,
      cwd: workspace.path,
      readTimeoutMs: this.cfg.acp.read_timeout_ms,
      promptTimeoutMs: this.cfg.acp.prompt_timeout_ms,
      onEvent: (event) => this.events.onRuntimeEvent(issue.id, event),
      onTokenUsage: (u) => this.events.onTokenUsage(issue.id, u),
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
    let lastReason = 'unknown';
    let agentFailure: string | null = null;
    let currentIssue = issue;
    const activeStates = new Set(this.cfg.tracker.active_states.map((s) => s.toLowerCase()));

    for (let turn = 1; turn <= this.cfg.agent.max_turns; turn++) {
      if (cancelSignal.cancelled) {
        lastReason = 'cancelled_by_reconciliation';
        break;
      }
      const isContinuation = turn > 1;
      let prompt: string;
      try {
        prompt = await renderPrompt({
          template: isContinuation ? CONTINUATION_PROMPT : this.workflow.prompt_template,
          issue: currentIssue,
          attempt: attempt === null ? null : attempt,
        });
      } catch (err) {
        clearInterval(cancelCheckTimer);
        logger.error('prompt rendering failed', { error: (err as Error).message });
        await cleanup('prompt_error');
        return { ok: false, reason: 'prompt error', threadId: sessionId, turnsCompleted };
      }

      this.events.onTurn(issue.id, turn);
      const outcome = await client.runPrompt(prompt);

      if (outcome.reason !== 'end_turn') {
        lastReason = outcome.reason;
        agentFailure = `agent turn ${outcome.reason}: ${outcome.message}`;
        break;
      }
      turnsCompleted++;

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
      if (turn >= this.cfg.agent.max_turns) {
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
