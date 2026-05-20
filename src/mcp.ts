// Per-issue MCP server. Each active dispatch registers an entry here; the agent inside
// the smolvm connects to /api/v1/issues/<id>/mcp with the per-dispatch bearer token and
// sees exactly two tools:
//
//   mark_done(summary)              ─ atomic file move into the terminal state, sets the
//                                     marked_done flag on the RunningEntry so the runner
//                                     exits cleanly on next post-turn check.
//   request_human_steering(question, context?)
//                                   ─ stashes the question on the RunningEntry, returns
//                                     an ack to the agent. The runner then pauses the
//                                     autonomous loop and awaits a human reply submitted
//                                     via POST /api/v1/issues/<id>/steering-reply.
//
// The URL is the capability: the agent only ever knows its own /<id>/mcp endpoint. The
// bearer token is belt-and-braces in case a non-agent caller can reach 8787.
//
// MCP wire format here is JSON-RPC 2.0 over HTTP (the "Streamable HTTP" transport's
// non-SSE subset). We implement only the subset our two tools need: initialize, tools/list,
// tools/call, plus a polite notifications/initialized acknowledgement.

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { lstat, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { IssueTracker } from './trackers/types.js';
import type { RunningEntry, StateConfig } from './types.js';
import { log } from './logging.js';
import { writeIssueFile, pickHoldingState } from './issues.js';

const TERMINAL_STATE_FOR_DONE_DEFAULT = 'Done';

/**
 * Pick the terminal state directory mark_done should move issues into.
 *
 * Shared between the orchestrator (which snapshots this at dispatch time onto
 * the RunningEntry) and the registry's fallback path. Prefers an entry whose
 * lowercase form is "done"; falls back to the first configured terminal state,
 * then to a hardcoded "Done" when the list is empty.
 */
export function pickTerminalTarget(terminalStates: string[]): string {
  const preferred = terminalStates.find((s) => s.toLowerCase() === 'done');
  if (preferred) return preferred;
  if (terminalStates.length > 0) return terminalStates[0]!;
  return TERMINAL_STATE_FOR_DONE_DEFAULT;
}

const PROTOCOL_VERSION = '2025-06-18';

const TOOL_LIST = [
  {
    name: 'mark_done',
    description:
      'Signal that this issue is fully complete. The orchestrator will move the issue file into the terminal Done state, persist the title/summary you provide for downstream tooling (PR title, PR body, transcripts), and stop dispatching new turns. Call this once, at the very end of a successful run. There is no RESULT.md to write — the structured fields here are the canonical record.',
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description:
            'Short single-line title in imperative voice (≤72 chars recommended). Becomes the PR/commit title for the work. Example: "Add CHANGELOG.md with MCP entry".',
        },
        summary: {
          type: 'string',
          description:
            'Multi-paragraph narrative describing what changed, why, and any follow-ups the agent noticed but did not do. Becomes the PR body / transcript record.',
        },
      },
      required: ['title', 'summary'],
    },
  },
  {
    name: 'request_human_steering',
    description:
      'Pause work and ask the human operator a question. Your current turn will end immediately after this returns; the human response will arrive as the prompt for your next turn. Use only when you cannot proceed without a decision a human must make.',
    inputSchema: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description:
            'The question to ask the human. Be specific about what decision they need to make.',
        },
        context: {
          type: 'string',
          description:
            'Optional: relevant context the human needs to answer (file paths, options considered, etc.).',
        },
      },
      required: ['question'],
    },
  },
  {
    name: 'transition',
    description:
      'Move this issue into another declared state, optionally appending notes to its body for the next agent. Use this for handoffs — implementer → reviewer, reviewer → implementer (rework), or implementer → terminal Done — rather than only at the very end of the work. Notes are appended to the issue file BEFORE the state move, so the next dispatch sees them in `issue.description` along with everything the previous agents wrote. `to_state` must be one of the states declared in WORKFLOW.md; if the current state declares `allowed_transitions`, `to_state` must also be in that list. On a terminal target, the workspace is removed after your turn ends and no further turns will be dispatched. On a non-terminal target, the same workspace and `agent/<id>` git branch survive into the next state.',
    inputSchema: {
      type: 'object',
      properties: {
        to_state: {
          type: 'string',
          description:
            'Declared state to transition into (case-insensitive match against `states:` in WORKFLOW.md). Examples: "Review", "Done", "Todo".',
        },
        notes: {
          type: 'string',
          description:
            'Optional markdown notes to append to the issue body before the move. These become part of the issue description the next agent (in `to_state`) reads. Use this for review findings, rework instructions, or PR-body content on a terminal transition.',
        },
      },
      required: ['to_state'],
    },
  },
  {
    name: 'propose_issue',
    description:
      'Propose a new issue for the human to triage. The orchestrator drops the proposal into a non-active "Triage" state directory and does NOT dispatch it — the operator approves (moves to the active queue) or discards it from the dashboard. Use this when you notice work that is out of scope for your current task: an unrelated bug, a follow-up the operator should size, a refactor a future agent could pick up. The parent issue you are working on is automatically recorded; do not paste it into the body.',
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description:
            'Short single-line title in imperative voice (≤72 chars recommended). Example: "Fix race condition in workspace cleanup".',
        },
        description: {
          type: 'string',
          description:
            'Optional multi-paragraph body for the issue. Explain what you observed, where (file paths), and why it is worth handling separately from your current task.',
        },
        labels: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional list of label strings.',
        },
        priority: {
          type: 'number',
          description: 'Optional integer priority hint (tracker-defined meaning).',
        },
      },
      required: ['title'],
    },
  },
] as const;

interface ActiveEntry {
  issueId: string;
  identifier: string;
  entry: RunningEntry;
  token: string;
  // Pending steering reply: resolved when a human POSTs a reply.
  pendingReply: { resolve: (text: string) => void; reject: (err: Error) => void } | null;
  // Snapshots captured at activate time so a WORKFLOW.md reload mid-flight cannot
  // redirect an in-flight `mark_done`. trackerRootSnapshot pins the filesystem
  // root the tracker should scan; terminalTarget pins the directory we move into.
  trackerRootSnapshot: string | null;
  terminalTarget: string;
}

export interface McpJsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: unknown;
}

export type McpJsonRpcResponse =
  | {
      jsonrpc: '2.0';
      id: string | number | null;
      result: unknown;
    }
  | {
      jsonrpc: '2.0';
      id: string | number | null;
      error: { code: number; message: string; data?: unknown };
    };

export class McpRegistry {
  private byIdentifier = new Map<string, ActiveEntry>();
  private effectivePort: number | null = null;
  // Live state-config map, kept in sync with the orchestrator's view via
  // `updateStates`. Used by `transition` to validate `to_state` and to resolve
  // the role of the target (terminal => set cleanup_workspace_on_exit). Empty
  // by default so test harnesses that don't supply a state map don't trip the
  // "unknown_state" branch on legacy mark_done shims — those still resolve via
  // the pinned terminal_target_at_dispatch.
  private states: Record<string, StateConfig> = {};

  constructor(
    private tracker: IssueTracker,
    private opts: { terminalStates: string[]; states?: Record<string, StateConfig> },
  ) {
    if (opts.states) this.states = opts.states;
  }

  updateTerminalStates(states: string[]): void {
    this.opts.terminalStates = states;
  }

  /** Push the latest state-config map in after a workflow reload. */
  updateStates(states: Record<string, StateConfig>): void {
    this.states = states;
  }

  /** Called once after the HTTP server binds, so URL construction uses the real port. */
  setEffectivePort(port: number | null): void {
    this.effectivePort = port;
  }

  /**
   * Build the URL the ACP agent will be told to POST to. Returns null when no HTTP server
   * is available and no explicit URL is configured; the runner uses that to skip MCP
   * injection (with a warning) instead of advertising an unreachable endpoint.
   */
  buildUrl(identifier: string, mcp: { host: string; explicit_host_url: string | null }): string | null {
    const base = mcp.explicit_host_url
      ? mcp.explicit_host_url.replace(/\/+$/, '')
      : this.effectivePort === null
        ? null
        : `http://${mcp.host}:${this.effectivePort}`;
    if (!base) return null;
    return `${base}/api/v1/issues/${encodeURIComponent(identifier)}/mcp`;
  }

  /**
   * Register an active dispatch. Returns the bearer token the runner injects into the
   * agent's MCP server config via ACP's session/new mcpServers field.
   */
  activate(entry: RunningEntry): string {
    const token = randomBytes(24).toString('base64url');
    entry.mcp_token = token;
    entry.marked_done = false;
    entry.steering_requested = false;
    entry.steering_question = null;
    entry.steering_context = null;
    // Carry the dispatch-time snapshots through verbatim. Reading
    // this.tracker.currentRoot() / this.preferredTerminalState() here would be
    // wrong: activate runs AFTER workspace setup, before_run hook, and smolvm
    // bring-up — a window during which a WORKFLOW.md reload can mutate tracker
    // root or terminal_states. The dispatch-time values are the only ones that
    // accurately reflect the world the run was started in.
    const active: ActiveEntry = {
      issueId: entry.issue_id,
      identifier: entry.identifier,
      entry,
      token,
      pendingReply: null,
      trackerRootSnapshot: entry.tracker_root_at_dispatch,
      terminalTarget: entry.terminal_target_at_dispatch,
    };
    this.byIdentifier.set(entry.identifier, active);
    log.debug('mcp activated', {
      issue_identifier: entry.identifier,
      terminal_target: active.terminalTarget,
      tracker_root: active.trackerRootSnapshot,
    });
    return token;
  }

  deactivate(identifier: string): void {
    const active = this.byIdentifier.get(identifier);
    if (!active) return;
    // Reject any waiter so the runner unblocks instead of hanging.
    if (active.pendingReply) {
      active.pendingReply.reject(new Error('mcp deactivated while awaiting human reply'));
      active.pendingReply = null;
    }
    this.byIdentifier.delete(identifier);
    log.debug('mcp deactivated', { issue_identifier: identifier });
  }

  /**
   * Resolve a pending human reply. Returns false if no waiter exists (the agent hasn't
   * requested steering, or the reply was already delivered).
   */
  submitSteeringReply(identifier: string, text: string): boolean {
    const active = this.byIdentifier.get(identifier);
    if (!active || !active.pendingReply) return false;
    const { resolve } = active.pendingReply;
    active.pendingReply = null;
    resolve(text);
    return true;
  }

  /**
   * Block until a human reply arrives, the cancel signal trips, or the active entry is
   * deactivated. Returns the reply text or null if cancelled.
   */
  async awaitSteeringReply(
    identifier: string,
    cancelSignal: { cancelled: boolean },
  ): Promise<string | null> {
    const active = this.byIdentifier.get(identifier);
    if (!active) return null;
    if (active.pendingReply) {
      throw new Error('steering reply already being awaited for this issue');
    }
    let timer: NodeJS.Timeout | null = null;
    try {
      return await new Promise<string | null>((resolve, reject) => {
        active.pendingReply = {
          resolve: (text) => resolve(text),
          reject: (err) => reject(err),
        };
        // Poll cancellation every 250ms (same cadence as the runner's cancel-check timer).
        timer = setInterval(() => {
          if (cancelSignal.cancelled) {
            if (active.pendingReply) {
              active.pendingReply = null;
              resolve(null);
            }
          }
        }, 250);
      });
    } finally {
      if (timer) clearInterval(timer);
    }
  }

  /**
   * Handle a single JSON-RPC envelope. The HTTP layer takes care of routing (identifier
   * lookup, token check) and passes us the parsed body. Returns null for notifications
   * (no `id`); the HTTP layer responds with 204 in that case.
   */
  async handleJsonRpc(
    identifier: string,
    token: string,
    body: unknown,
  ): Promise<McpJsonRpcResponse | null> {
    const active = this.byIdentifier.get(identifier);
    if (!active) {
      return makeError(getId(body), -32001, 'issue not active');
    }
    if (!constantTimeStringEqual(active.token, token)) {
      return makeError(getId(body), -32002, 'invalid token');
    }
    if (!isRpcRequest(body)) {
      return makeError(getId(body), -32600, 'invalid JSON-RPC request');
    }
    const id = body.id ?? null;
    const isNotification = body.id === undefined;
    try {
      switch (body.method) {
        case 'initialize': {
          if (isNotification) return null;
          return {
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion: PROTOCOL_VERSION,
              capabilities: {
                tools: { listChanged: false },
              },
              serverInfo: {
                name: 'smol-symphony',
                version: '0.1.0',
              },
            },
          };
        }
        case 'notifications/initialized':
        case 'notifications/cancelled':
        case 'notifications/progress': {
          return null;
        }
        case 'tools/list': {
          if (isNotification) return null;
          return { jsonrpc: '2.0', id, result: { tools: TOOL_LIST } };
        }
        case 'tools/call': {
          if (isNotification) return null;
          const params = (body.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
          const name = params.name;
          const args = params.arguments ?? {};
          if (name === 'mark_done') {
            return await this.callMarkDone(active, id, args);
          }
          if (name === 'transition') {
            return await this.callTransition(active, id, args);
          }
          if (name === 'request_human_steering') {
            return this.callRequestHumanSteering(active, id, args);
          }
          if (name === 'propose_issue') {
            return await this.callProposeIssue(active, id, args);
          }
          return makeError(id, -32601, `unknown tool: ${name}`);
        }
        case 'ping': {
          if (isNotification) return null;
          return { jsonrpc: '2.0', id, result: {} };
        }
        default:
          if (isNotification) return null;
          return makeError(id, -32601, `unknown method: ${body.method}`);
      }
    } catch (err) {
      log.warn('mcp handler error', {
        issue_identifier: identifier,
        method: body.method,
        error: (err as Error).message,
      });
      return makeError(id, -32603, (err as Error).message);
    }
  }

  /**
   * Shared file-move + flag-flip path used by both `mark_done` (which targets the
   * pinned terminal state with a synthesized notes block) and `transition` (which
   * accepts any declared target plus operator-supplied notes). Returns the
   * tracker's resolved {from, to, newPath} on success, throwing the underlying
   * TrackerError on failure so the caller can wrap it in a tool-error response.
   *
   * Cleanup-on-exit is decided by the role of the canonical target state: terminal
   * targets clean the workspace, active/holding targets preserve it so the same
   * `agent/<id>` git branch survives across the handoff. When the registry has no
   * live states map (e.g. a test harness that didn't wire one), we fall back to
   * "any move that lands in the dispatch-pinned terminal target cleans" — which is
   * the legacy `mark_done` semantics.
   */
  private async performTransition(
    active: ActiveEntry,
    toState: string,
    notes: string,
    actor: string,
  ): Promise<{ fromState: string; toState: string; newPath: string }> {
    if (!this.tracker.moveIssueToState) {
      throw new Error('this tracker does not support state transitions');
    }
    const fromRoot = active.trackerRootSnapshot ?? undefined;
    const fromState = active.entry.issue.state;
    const result = await this.tracker.moveIssueToState(active.issueId, toState, {
      fromRoot,
      fromState,
      notes: notes.length > 0 ? notes : undefined,
      actor,
    });
    active.entry.marked_done = true;
    // Pick the canonical declared name (preserving operator-supplied casing) so
    // the role lookup matches the workflow's `states:` map. When no states map
    // is present, fall back to the dispatch-time terminal target — that's the
    // path mark_done has always used.
    let cleanup = false;
    const stateMap = this.states;
    const canonicalName = canonicalStateName(stateMap, result.toState);
    if (canonicalName !== null) {
      cleanup = stateMap[canonicalName]!.role === 'terminal';
    } else {
      cleanup = result.toState.toLowerCase() === active.terminalTarget.toLowerCase();
    }
    active.entry.cleanup_workspace_on_exit = cleanup;
    return result;
  }

  private async callMarkDone(
    active: ActiveEntry,
    id: string | number | null,
    args: Record<string, unknown>,
  ): Promise<McpJsonRpcResponse> {
    const titleRaw = typeof args.title === 'string' ? args.title.trim() : '';
    const summary = typeof args.summary === 'string' ? args.summary : '';
    if (!titleRaw) {
      return makeToolError(id, 'title is required and must be a non-empty string');
    }
    if (titleRaw.includes('\n')) {
      return makeToolError(id, 'title must be a single line (no embedded newlines)');
    }
    if (!summary.trim()) {
      return makeToolError(id, 'summary is required and must be a non-empty string');
    }
    if (!this.tracker.moveIssueToState) {
      return makeToolError(id, 'this tracker does not support state transitions');
    }
    // Target is the dispatch-pinned terminal state — same as before the transition
    // refactor. A WORKFLOW.md reload that changes tracker.root or terminal_states
    // between dispatch and mark_done must not redirect the move; the snapshot is
    // the single source of truth.
    //
    // Notes block synthesised from title + summary so the dogfood after_run hook
    // can read it in `issue.description` on the terminal side too, alongside the
    // existing `mark_done.md` write that lives in the workspace's staging dir.
    const target = active.terminalTarget;
    const notes = `# ${titleRaw}\n\n${summary.trim()}`;
    const actor = active.entry.resolved_actor;
    try {
      const result = await this.performTransition(active, target, notes, actor);
      // Persist the structured title+summary into the workspace so the after_run
      // hook (and any other consumers) can read them. Format is markdown so
      // operators can `cat` it without parsing JSON:
      //   # <title>
      //
      //   <summary>
      try {
        const stagingDir = await pickStagingDir(active.entry.workspace_path);
        await mkdir(stagingDir, { recursive: true });
        const body = `# ${titleRaw}\n\n${summary.trim()}\n`;
        await writeFile(path.join(stagingDir, 'mark_done.md'), body, { mode: 0o644 });
      } catch (err) {
        // Persistence failure is non-fatal — the move already happened, the
        // flag is set, and the title/summary are in the log line below. We
        // surface it as a warning so the operator can investigate.
        log.warn('mcp mark_done: failed to persist mark_done.md', {
          issue_identifier: active.identifier,
          error: (err as Error).message,
        });
      }
      log.info('mcp mark_done', {
        issue_identifier: active.identifier,
        from: result.fromState,
        to: result.toState,
        title: titleRaw,
        summary_chars: summary.length,
        actor,
        cleanup: active.entry.cleanup_workspace_on_exit,
      });
      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [
            {
              type: 'text',
              text: `Marked ${active.identifier} as done (moved to ${result.toState}). Stop now; no further turns will be dispatched.`,
            },
          ],
          isError: false,
        },
      };
    } catch (err) {
      return makeToolError(id, `failed to mark done: ${(err as Error).message}`);
    }
  }

  /**
   * `symphony.transition({ to_state, notes? })`: validate the target against the
   * declared `states:` map + the current state's `allowed_transitions` list, then
   * delegate to `performTransition` which owns the actual file move and flag flip.
   *
   * Validation failures return MCP tool-result errors (`isError: true`) with a
   * human-readable text block AND a structured JSON block describing the error
   * shape. This is NOT a JSON-RPC `error` envelope — the SDK delivers it as a
   * normal tool result and the agent reads the structured payload to pick a valid
   * target on its next call. `marked_done` stays false; no file is touched.
   */
  private async callTransition(
    active: ActiveEntry,
    id: string | number | null,
    args: Record<string, unknown>,
  ): Promise<McpJsonRpcResponse> {
    const toStateRaw = typeof args.to_state === 'string' ? args.to_state.trim() : '';
    const notes = typeof args.notes === 'string' ? args.notes : '';
    if (!toStateRaw) {
      return makeToolError(id, 'to_state is required and must be a non-empty string');
    }
    if (!this.tracker.moveIssueToState) {
      return makeToolError(id, 'this tracker does not support state transitions');
    }
    const stateMap = this.states;
    const declaredNames = Object.keys(stateMap);
    const canonicalTarget = canonicalStateName(stateMap, toStateRaw);
    if (canonicalTarget === null) {
      const text = `state "${toStateRaw}" is not declared. declared: ${
        declaredNames.length > 0 ? declaredNames.join(', ') : '<none>'
      }`;
      log.info('mcp transition rejected: unknown_state', {
        issue_identifier: active.identifier,
        requested_to_state: toStateRaw,
        declared_states: declaredNames,
      });
      return makeStructuredToolError(id, text, {
        error: 'unknown_state',
        declared_states: declaredNames,
      });
    }
    const fromStateRaw = active.entry.issue.state;
    const canonicalFrom = canonicalStateName(stateMap, fromStateRaw);
    if (canonicalFrom !== null) {
      // Per the brief: `allowed_transitions: null | undefined` => "any declared
      // state is reachable"; a present array => restrict to that list (empty
      // list => no transitions out, agent must wait for human cleanup).
      const allowed = stateMap[canonicalFrom]!.allowed_transitions;
      if (allowed) {
        const allowedLower = new Set(allowed.map((s) => s.toLowerCase()));
        if (!allowedLower.has(canonicalTarget.toLowerCase())) {
          const text = `transition to "${canonicalTarget}" is not allowed from "${canonicalFrom}". allowed: ${
            allowed.length > 0 ? allowed.join(', ') : '<none>'
          }`;
          log.info('mcp transition rejected: transition_not_allowed', {
            issue_identifier: active.identifier,
            from_state: canonicalFrom,
            requested_to_state: canonicalTarget,
            allowed_transitions: allowed,
          });
          return makeStructuredToolError(id, text, {
            error: 'transition_not_allowed',
            from_state: canonicalFrom,
            requested_to_state: canonicalTarget,
            allowed_transitions: allowed,
          });
        }
      }
    }
    const actor = active.entry.resolved_actor;
    try {
      const result = await this.performTransition(active, canonicalTarget, notes, actor);
      log.info('mcp transition', {
        issue_identifier: active.identifier,
        from: result.fromState,
        to: result.toState,
        notes_len: notes.length,
        actor,
        cleanup: active.entry.cleanup_workspace_on_exit,
      });
      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [
            {
              type: 'text',
              text: `Transitioned ${active.identifier} from ${result.fromState} to ${result.toState}${
                notes.length > 0 ? ` with notes (${notes.length} chars) appended` : ''
              }. End this turn now; the next dispatch will pick up under the new state.`,
            },
          ],
          isError: false,
          structuredContent: {
            from_state: result.fromState,
            to_state: result.toState,
            cleanup_workspace_on_exit: active.entry.cleanup_workspace_on_exit,
            notes_appended: notes.length > 0,
          },
        },
      };
    } catch (err) {
      return makeToolError(id, `failed to transition: ${(err as Error).message}`);
    }
  }

  private callRequestHumanSteering(
    active: ActiveEntry,
    id: string | number | null,
    args: Record<string, unknown>,
  ): McpJsonRpcResponse {
    const question = typeof args.question === 'string' ? args.question.trim() : '';
    const context = typeof args.context === 'string' ? args.context.trim() : '';
    if (!question) {
      return makeToolError(id, 'question is required and must be a non-empty string');
    }
    if (active.entry.steering_requested) {
      return makeToolError(
        id,
        'a steering request is already pending for this issue; end the turn and wait for the response',
      );
    }
    active.entry.steering_requested = true;
    active.entry.steering_question = question;
    active.entry.steering_context = context.length > 0 ? context : null;
    log.info('mcp request_human_steering', {
      issue_identifier: active.identifier,
      question_chars: question.length,
      has_context: context.length > 0,
    });
    return {
      jsonrpc: '2.0',
      id,
      result: {
        content: [
          {
            type: 'text',
            text: 'Question queued. End this turn now. The human response will arrive as the prompt for your next turn.',
          },
        ],
        isError: false,
      },
    };
  }

  private preferredTerminalState(): string {
    return pickTerminalTarget(this.opts.terminalStates);
  }

  /**
   * Drop a new issue file into the tracker's Triage/ directory. The orchestrator
   * never dispatches Triage entries because the state isn't in active_states; the
   * operator approves or discards from the dashboard. Parent issue (the active
   * dispatch this MCP call came from) is stamped into the front-matter as
   * `proposed_by` so provenance is visible in the file and the UI.
   *
   * Uses the dispatch-time tracker root snapshot — same rationale as mark_done:
   * a WORKFLOW.md reload that mutates tracker.root mid-flight must not redirect
   * an in-flight propose call to a different filesystem location.
   */
  private async callProposeIssue(
    active: ActiveEntry,
    id: string | number | null,
    args: Record<string, unknown>,
  ): Promise<McpJsonRpcResponse> {
    const titleRaw = typeof args.title === 'string' ? args.title.trim() : '';
    const description = typeof args.description === 'string' ? args.description : '';
    if (!titleRaw) {
      return makeToolError(id, 'title is required and must be a non-empty string');
    }
    if (titleRaw.includes('\n')) {
      return makeToolError(id, 'title must be a single line (no embedded newlines)');
    }
    const labels = Array.isArray(args.labels)
      ? args.labels.filter((x): x is string => typeof x === 'string')
      : [];
    const priority =
      typeof args.priority === 'number' && Number.isFinite(args.priority) ? args.priority : null;

    // Resolve the tracker root: prefer the dispatch-time snapshot, fall back to the
    // tracker's live root (e.g. for tests / trackers without a snapshot). Without a
    // resolvable root we can't write the file, so surface a clean tool error.
    const root =
      active.trackerRootSnapshot ??
      (this.tracker.currentRoot ? this.tracker.currentRoot() : null);
    if (!root) {
      return makeToolError(
        id,
        'tracker root is not available; cannot create issue files (is this a non-local tracker?)',
      );
    }
    // Landing state: first declared `holding` state in declaration order, falling
    // back to the literal "Triage" string when no holding state is declared. Phase
    // 1's legacy-fallback synthesis adds an implicit Triage holding state to every
    // workflow that didn't migrate to the `states:` block, so this path keeps
    // existing operators' Triage directories working unchanged.
    const landingState = pickHoldingState(this.states);
    try {
      const result = await writeIssueFile({
        trackerRoot: root,
        state: landingState,
        title: titleRaw,
        description,
        priority,
        labels,
        extra_front_matter: {
          proposed_by: active.identifier,
          proposed_at: new Date().toISOString(),
        },
      });
      log.info('mcp propose_issue', {
        proposed_by: active.identifier,
        identifier: result.identifier,
        state: result.state,
        title: titleRaw,
        description_chars: description.length,
      });
      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [
            {
              type: 'text',
              text: `Proposed issue ${result.identifier} in ${result.state}/. The operator will approve or discard from the dashboard; do not wait for it. Continue your current task.`,
            },
          ],
          isError: false,
          // Structured data alongside the human-readable text — MCP clients that
          // surface this make the identifier programmatically available without
          // re-parsing the content string.
          structuredContent: {
            identifier: result.identifier,
            state: result.state,
            path: result.path,
          },
        },
      };
    } catch (err) {
      return makeToolError(id, `failed to propose issue: ${(err as Error).message}`);
    }
  }

  /** Snapshot of currently active issues, used by HTTP for routing lookups. */
  isActive(identifier: string, token: string): boolean {
    const active = this.byIdentifier.get(identifier);
    return !!active && constantTimeStringEqual(active.token, token);
  }
}

/**
 * Constant-time string comparison for secrets. Uses crypto.timingSafeEqual on
 * equal-length buffers; rejects different-length inputs (the registry only ever
 * issues fixed-width base64url tokens, so a length mismatch is unconditionally
 * a wrong-token signal and the early exit doesn't leak per-byte timing).
 *
 * We compare BYTE lengths after UTF-8 encoding, not JS string `.length` (which
 * counts UTF-16 code units). An attacker-supplied non-ASCII token can match the
 * real token's code-unit count while encoding to a different byte length; passing
 * those buffers to timingSafeEqual would throw `Input buffers must have the same
 * byte length`, surfacing as an HTTP 500 instead of a clean wrong-token rejection.
 */
function constantTimeStringEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, 'utf8');
  const bBuf = Buffer.from(b, 'utf8');
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

/**
 * Pick the symphony-runtime staging directory for a workspace. Mirrors the
 * adapter-staging policy in adapters.ts: when the workspace has its own
 * `.git/` directory, the runtime files live inside it (outside the working
 * tree, structurally untrackable); otherwise they sit at workspace root.
 * `mark_done` writes its persisted artifact here so the after_run hook can
 * find it via the same probe.
 */
async function pickStagingDir(workspacePath: string): Promise<string> {
  const gitPath = path.join(workspacePath, '.git');
  try {
    const st = await lstat(gitPath);
    if (st.isDirectory()) return path.join(workspacePath, '.git', 'symphony-runtime');
  } catch {
    // .git missing or unstat-able — fall through to the workspace-root path.
  }
  return path.join(workspacePath, '.symphony-runtime');
}

function getId(body: unknown): string | number | null {
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const rec = body as Record<string, unknown>;
    if (typeof rec.id === 'string' || typeof rec.id === 'number') return rec.id;
  }
  return null;
}

function isRpcRequest(body: unknown): body is McpJsonRpcRequest {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const rec = body as Record<string, unknown>;
  return rec.jsonrpc === '2.0' && typeof rec.method === 'string';
}

function makeError(id: string | number | null, code: number, message: string): McpJsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function makeToolError(id: string | number | null, message: string): McpJsonRpcResponse {
  // MCP convention: tool errors return result.isError=true rather than JSON-RPC error.
  return {
    jsonrpc: '2.0',
    id,
    result: {
      content: [{ type: 'text', text: message }],
      isError: true,
    },
  };
}

/**
 * MCP tool error with both a human-readable text block and a structured JSON
 * block. Used by `symphony.transition` so agents can read the rejection's
 * structured payload (`declared_states`, `allowed_transitions`, etc.) to pick a
 * valid target on their next call without re-parsing the prose. Pairs with
 * `makeToolError` (text-only) for everything else.
 */
function makeStructuredToolError(
  id: string | number | null,
  text: string,
  json: Record<string, unknown>,
): McpJsonRpcResponse {
  return {
    jsonrpc: '2.0',
    id,
    result: {
      // MCP 2025-06-18 `CallToolResult.content` is `ContentBlock[]` and does not
      // define a `json` block type; the canonical home for machine-readable
      // payloads is `structuredContent`. Keep only the text block in `content[]`
      // for human display and put the structured shape on the SDK-recognised slot.
      content: [{ type: 'text', text }],
      isError: true,
      structuredContent: json,
    },
  };
}

/**
 * Resolve a caller-supplied state name to its canonical declared form (the
 * casing the operator wrote in `states:`). Comparison is case-insensitive to
 * mirror the rest of symphony (eligibility, reconciliation, the local-tracker
 * directory scan all compare lowercase). Returns null when no declared name
 * matches.
 */
function canonicalStateName(
  states: Record<string, StateConfig>,
  name: string,
): string | null {
  if (Object.prototype.hasOwnProperty.call(states, name)) return name;
  const lower = name.toLowerCase();
  for (const declared of Object.keys(states)) {
    if (declared.toLowerCase() === lower) return declared;
  }
  return null;
}
