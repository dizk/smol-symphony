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
import type { RunningEntry } from './types.js';
import { log } from './logging.js';
import { writeIssueFile, TRIAGE_STATE } from './issues.js';

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

  constructor(private tracker: IssueTracker, private opts: { terminalStates: string[] }) {}

  updateTerminalStates(states: string[]): void {
    this.opts.terminalStates = states;
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
    // Use the snapshots captured at activate time, not the registry's live config.
    // A WORKFLOW.md reload that changes tracker.root or terminal_states between
    // dispatch and mark_done must not redirect the move.
    //
    // Pass the entry's dispatched-from state as `fromState` so the tracker can
    // disambiguate when a stale terminal copy (e.g. a leftover Done/ABC-1.md
    // from a prior cycle) shares the issue id with the active In Progress copy.
    // Without this, a blind first-match could pick the stale terminal file and
    // silently no-op via the same-state short-circuit.
    const target = active.terminalTarget;
    const fromRoot = active.trackerRootSnapshot ?? undefined;
    const fromState = active.entry.issue.state;
    try {
      const result = await this.tracker.moveIssueToState(active.issueId, target, {
        fromRoot,
        fromState,
      });
      active.entry.marked_done = true;
      // The reconcile loop normally sets cleanup_workspace_on_exit when it observes a
      // terminal-state transition, but the runner can exit (via the marked_done flag)
      // before the next reconcile tick. Set it here so the workspace is cleaned up on
      // worker exit regardless of which path got there first.
      active.entry.cleanup_workspace_on_exit = true;
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
    try {
      const result = await writeIssueFile({
        trackerRoot: root,
        state: TRIAGE_STATE,
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
