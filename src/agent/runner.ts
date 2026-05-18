// Agent Runner (SPEC §10.7): workspace + prompt + Codex app-server client, with continuation
// turns up to agent.max_turns. The Codex app-server runs inside a per-issue smolvm machine
// (microVM) for isolation. The host's workspace directory is volume-mounted into the VM at
// the same absolute path so cwd values are consistent.

import path from 'node:path';
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
import { CodexClient, type JsonValue } from './codex.js';
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
  onRateLimits: (issueId: string, snapshot: JsonValue) => void;
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

function sessionKey(threadId: string, turnId: string): string {
  return `${threadId}-${turnId}`;
}

export class AgentRunner {
  constructor(
    private cfg: ServiceConfig,
    private workflow: WorkflowDefinition,
    private workspaces: WorkspaceManager,
    private tracker: IssueTracker,
    private smolvm: SmolvmClient,
    private events: AgentRunnerEvents,
  ) {}

  vmNameFor(issue: Issue): string {
    return `symphony-${sanitizeWorkspaceKey(issue.identifier)}`.toLowerCase();
  }

  // Run one full attempt: prepare workspace, before_run hook, start session, drive turns,
  // tear down. The caller (orchestrator) decides on retries based on the returned `ok`.
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
      // §9.5 Invariant 1: agent cwd MUST be the per-issue workspace path. Mount the host
      // workspace at the same absolute path inside the VM so cwd values match host paths.
      { host: workspace.path, guest: workspace.path, readonly: false },
    ];
    if (this.cfg.smolvm.bin_path) {
      mounts.push({ host: this.cfg.smolvm.bin_path, guest: '/opt/codex', readonly: true });
    }
    const env: Record<string, string> = {};
    for (const k of this.cfg.smolvm.forward_env) {
      const v = process.env[k];
      if (v && v.length > 0) env[k] = v;
    }

    try {
      await this.smolvm.ensureRunning(vmName, {
        image: this.cfg.smolvm.image,
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

    // Launch `codex app-server` (or the configured command) inside the VM, wired to stdio.
    // bash -lc preserves $PATH for cases where `codex` lives in /opt/codex/bin.
    const execStream = this.smolvm.execInteractive(vmName, {
      command: ['bash', '-lc', this.cfg.codex.command],
      workdir: workspace.path,
      env: {},
      timeoutMs: null,
    });

    const recentStderr: string[] = [];
    execStream.stderr.setEncoding('utf8');
    execStream.stderr.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) {
        const t = line.trim();
        if (t.length === 0) continue;
        recentStderr.push(t);
        if (recentStderr.length > 50) recentStderr.shift();
      }
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
      if (cancelSignal.cancelled) execStream.kill();
    };
    const cancelCheckTimer = setInterval(onCancel, 500);

    const client = new CodexClient({
      stdin: execStream.stdin,
      stdout: execStream.stdout,
      stderr: execStream.stderr,
      readTimeoutMs: this.cfg.codex.read_timeout_ms,
      turnTimeoutMs: this.cfg.codex.turn_timeout_ms,
      onEvent: (event) => this.events.onRuntimeEvent(issue.id, event),
      onTokenUsage: (u) => this.events.onTokenUsage(issue.id, u),
      onRateLimits: (s) => this.events.onRateLimits(issue.id, s),
    });

    try {
      await client.initialize({
        clientInfo: { name: 'smol-symphony', version: '0.1.0' },
      });
    } catch (err) {
      clearInterval(cancelCheckTimer);
      logger.error('codex initialize failed', { error: (err as Error).message, stderr: recentStderr.slice(-5).join(' | ') });
      this.events.onRuntimeEvent(issue.id, {
        at: new Date().toISOString(),
        event: 'startup_failed',
        message: (err as Error).message,
      });
      await cleanup('initialize_failed');
      return { ok: false, reason: 'agent session startup error', threadId: null, turnsCompleted: 0 };
    }

    let threadId: string;
    try {
      threadId = await client.startThread({
        cwd: workspace.path,
        ...(this.cfg.codex.approval_policy
          ? { approvalPolicy: this.cfg.codex.approval_policy as unknown as JsonValue }
          : {}),
        ...(this.cfg.codex.thread_sandbox
          ? { sandbox: this.cfg.codex.thread_sandbox as unknown as JsonValue }
          : {}),
      });
    } catch (err) {
      clearInterval(cancelCheckTimer);
      logger.error('thread/start failed', { error: (err as Error).message });
      await cleanup('thread_start_failed');
      return { ok: false, reason: 'agent session startup error', threadId: null, turnsCompleted: 0 };
    }

    this.events.onSessionStarted?.({
      issueId: issue.id,
      sessionId: sessionKey(threadId, 'initial'),
      threadId,
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
        const rendered = await renderPrompt({
          template: isContinuation ? CONTINUATION_PROMPT : this.workflow.prompt_template,
          issue: currentIssue,
          attempt: attempt === null ? null : attempt,
        });
        prompt = rendered;
      } catch (err) {
        clearInterval(cancelCheckTimer);
        logger.error('prompt rendering failed', { error: (err as Error).message });
        await cleanup('prompt_error');
        return { ok: false, reason: 'prompt error', threadId, turnsCompleted };
      }

      this.events.onTurn(issue.id, turn);
      const turnResult = await client.runTurn({
        threadId,
        cwd: workspace.path,
        input: [{ type: 'text', text: prompt }],
        ...(this.cfg.codex.turn_sandbox_policy
          ? { sandboxPolicy: this.cfg.codex.turn_sandbox_policy as unknown as JsonValue }
          : {}),
      });

      if (turnResult.reason !== 'turn_completed') {
        lastReason = turnResult.reason;
        // §16.5: turn_failed / turn_timeout / turn_cancelled / turn_input_required /
        // subprocess_exit all fail the attempt so the orchestrator retries with backoff
        // rather than scheduling the short continuation retry used for a clean exit.
        agentFailure = `agent turn ${turnResult.reason}: ${turnResult.message}`;
        break;
      }
      turnsCompleted++;

      // §16.5: after every normal turn, re-check tracker state and decide whether to continue.
      let refreshed: Issue[];
      try {
        refreshed = await this.tracker.fetchIssueStatesByIds([issue.id]);
      } catch (err) {
        clearInterval(cancelCheckTimer);
        logger.error('issue state refresh failed', { error: (err as Error).message });
        await cleanup('issue_state_refresh_failed');
        return { ok: false, reason: 'issue state refresh error', threadId, turnsCompleted };
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
      // Tiny pacing delay between turns to avoid event-loop starvation under fast notifications.
      await delay(25);
    }

    clearInterval(cancelCheckTimer);
    await cleanup(lastReason);
    if (agentFailure) {
      return { ok: false, reason: agentFailure, threadId, turnsCompleted };
    }
    return { ok: true, reason: lastReason, threadId, turnsCompleted };
  }
}
