// JSON-RPC client for the Codex app-server protocol (SPEC §10).
//
// Transport: newline-delimited JSON over stdio. Each line is a JSON object that is either
// a request, a response, or a notification, as defined by the Codex protocol.
//
// This client takes a pre-existing stdio pair (e.g. the streams of a smolvm exec session)
// and drives the §10 lifecycle: initialize → thread/start → turn/start → process notifications
// until turn/completed. Approval requests are answered according to the documented high-trust
// posture (auto-approve). User-input-required, unsupported dynamic tools, and signal exits are
// surfaced as failures so a run never stalls (§10.5).

import type { Readable, Writable } from 'node:stream';
import type { RuntimeEvent } from '../types.js';
import { log } from '../logging.js';

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [k: string]: JsonValue };

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params: JsonValue;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: JsonValue;
  error?: { code: number; message: string; data?: JsonValue };
}

interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params: JsonValue;
}

type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcResponse
  | JsonRpcNotification
  | (Partial<JsonRpcRequest> & Partial<JsonRpcResponse> & Partial<JsonRpcNotification>);

export interface CodexClientOptions {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  readTimeoutMs: number;
  turnTimeoutMs: number;
  onEvent: (event: RuntimeEvent, raw?: JsonRpcMessage) => void;
  onTokenUsage: (usage: { input_tokens: number; output_tokens: number; total_tokens: number }) => void;
  onRateLimits: (snapshot: JsonValue) => void;
  // Implementation-defined approval policy. The current implementation auto-approves;
  // override to surface to an operator.
  approvalPolicy?: 'auto_approve' | 'deny_all';
  /** Dynamic tools the runtime advertises; unknown names are failed without stalling. */
  supportedTools?: string[];
}

export interface InitializeParams {
  clientInfo: { name: string; version: string };
  clientCapabilities?: JsonValue;
  // Optional: declare client-side tools.
  tools?: Array<{ name: string; description: string; inputSchema: JsonValue }>;
}

export interface ThreadStartParams {
  approvalPolicy?: JsonValue;
  sandbox?: JsonValue;
  cwd?: string;
  baseInstructions?: string | null;
}

export interface TurnStartParams {
  threadId: string;
  cwd?: string;
  approvalPolicy?: JsonValue;
  sandboxPolicy?: JsonValue;
  input: Array<{ type: 'text'; text: string }>;
}

export interface TurnResult {
  turnId: string;
  reason: 'turn_completed' | 'turn_failed' | 'turn_cancelled' | 'turn_timeout' | 'turn_input_required' | 'subprocess_exit';
  message: string;
}

export class CodexProtocolError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'CodexProtocolError';
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function summarize(raw: unknown, max = 240): string {
  let s: string;
  try {
    s = typeof raw === 'string' ? raw : JSON.stringify(raw);
  } catch {
    s = String(raw);
  }
  if (s.length > max) s = s.slice(0, max) + '…';
  return s;
}

// Extract absolute token totals from a `thread/tokenUsage/updated` notification.
//
// The current Codex protocol nests totals under `tokenUsage.total.{inputTokens, outputTokens,
// totalTokens}` (see ThreadTokenUsageUpdatedNotification schema). We deliberately prefer the
// `total` breakdown over `last` so accumulation matches §13.5: "prefer absolute thread totals".
// Older payload shapes (`total_token_usage`, flat `usage`) are accepted as a fallback.
function extractTokenTotals(params: JsonValue): { input: number; output: number; total: number } | null {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return null;
  const obj = params as Record<string, JsonValue>;
  const candidates: Array<Record<string, JsonValue>> = [];
  const tokenUsage = obj['tokenUsage'];
  if (tokenUsage && typeof tokenUsage === 'object' && !Array.isArray(tokenUsage)) {
    const totalBreakdown = (tokenUsage as Record<string, JsonValue>)['total'];
    if (totalBreakdown && typeof totalBreakdown === 'object' && !Array.isArray(totalBreakdown)) {
      candidates.push(totalBreakdown as Record<string, JsonValue>);
    }
  }
  const totalTokenUsage = obj['total_token_usage'];
  if (totalTokenUsage && typeof totalTokenUsage === 'object' && !Array.isArray(totalTokenUsage)) {
    candidates.push(totalTokenUsage as Record<string, JsonValue>);
  }
  const usage = obj['usage'];
  if (usage && typeof usage === 'object' && !Array.isArray(usage)) {
    candidates.push(usage as Record<string, JsonValue>);
  }
  candidates.push(obj);
  for (const c of candidates) {
    const inRaw = c['input_tokens'] ?? c['inputTokens'];
    const outRaw = c['output_tokens'] ?? c['outputTokens'];
    const totRaw = c['total_tokens'] ?? c['totalTokens'];
    if (inRaw === undefined && outRaw === undefined && totRaw === undefined) continue;
    const inN = Number(inRaw ?? 0);
    const outN = Number(outRaw ?? 0);
    const totN = Number(totRaw ?? inN + outN);
    if (Number.isFinite(totN)) {
      return { input: inN, output: outN, total: totN };
    }
  }
  return null;
}

interface PendingRequest {
  resolve: (v: JsonValue) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export class CodexClient {
  private nextId = 1;
  private pending = new Map<number | string, PendingRequest>();
  private notificationHandlers = new Map<string, (params: JsonValue) => void>();
  private serverRequestHandlers = new Map<string, (params: JsonValue) => Promise<JsonValue>>();
  private buffer = '';
  private closed = false;
  private threadId: string | null = null;
  private turnWaiter: { resolve: (r: TurnResult) => void; reject: (e: Error) => void } | null = null;
  private turnTimer: NodeJS.Timeout | null = null;
  private currentTurnId: string | null = null;

  constructor(private readonly opts: CodexClientOptions) {
    this.opts.stdout.setEncoding('utf8');
    this.opts.stdout.on('data', (chunk: string) => this.onData(chunk));
    this.opts.stdout.on('close', () => this.handleTransportClose('stdout_closed'));
    this.opts.stdout.on('error', (e) =>
      this.handleTransportClose(`stdout_error:${(e as Error).message}`),
    );
    this.opts.stdin.on('error', () => {
      /* ignore: pipe errors surface via close */
    });
    this.installDefaultHandlers();
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (line.length === 0) continue;
      let msg: JsonRpcMessage;
      try {
        msg = JSON.parse(line) as JsonRpcMessage;
      } catch (err) {
        this.emitRuntime('malformed', `cannot parse: ${(err as Error).message}: ${summarize(line)}`);
        continue;
      }
      this.dispatch(msg);
    }
  }

  private dispatch(msg: JsonRpcMessage): void {
    // Response to one of our requests.
    if (msg && 'id' in msg && msg.id !== undefined && (!('method' in msg) || msg.method === undefined)) {
      const id = msg.id as number | string;
      const pending = this.pending.get(id);
      if (!pending) {
        this.emitRuntime('other_message', `unmatched response id=${id}`);
        return;
      }
      this.pending.delete(id);
      clearTimeout(pending.timer);
      const asResp = msg as JsonRpcResponse;
      if (asResp.error) {
        pending.reject(new CodexProtocolError('response_error', asResp.error.message));
      } else {
        pending.resolve((asResp.result ?? null) as JsonValue);
      }
      return;
    }
    // Server request — needs response (e.g. approvals, dynamic tools).
    if (msg && 'method' in msg && 'id' in msg && msg.id !== undefined) {
      const method = msg.method as string;
      const params = (msg.params ?? null) as JsonValue;
      const handler = this.serverRequestHandlers.get(method);
      void this.respondToServerRequest(msg.id as number | string, method, params, handler);
      return;
    }
    // Notification.
    if (msg && 'method' in msg && msg.method) {
      const method = msg.method as string;
      const params = (msg.params ?? null) as JsonValue;
      const handler = this.notificationHandlers.get(method);
      if (handler) handler(params);
      else this.emitRuntime('notification', `${method} ${summarize(params)}`);
      return;
    }
    this.emitRuntime('other_message', summarize(msg));
  }

  private async respondToServerRequest(
    id: number | string,
    method: string,
    params: JsonValue,
    handler: ((params: JsonValue) => Promise<JsonValue>) | undefined,
  ): Promise<void> {
    try {
      let result: JsonValue;
      if (handler) {
        result = await handler(params);
      } else {
        // Unsupported server request: respond with structured error so the session doesn't
        // stall (§10.5 — unsupported dynamic tool calls).
        result = { error: { code: 'unsupported', message: `unsupported method ${method}` } } as JsonValue;
        this.emitRuntime('unsupported_tool_call', `${method} ${summarize(params)}`);
      }
      this.writeMessage({ jsonrpc: '2.0', id, result });
    } catch (err) {
      this.writeMessage({
        jsonrpc: '2.0',
        id,
        error: { code: -32000, message: (err as Error).message },
      });
    }
  }

  private installDefaultHandlers(): void {
    // Approvals — auto-approve under the documented high-trust posture.
    //
    // Method names and decision values come from the Codex v2 protocol:
    //   - item/commandExecution/requestApproval → CommandExecutionApprovalDecision
    //   - item/fileChange/requestApproval       → FileChangeApprovalDecision
    //   - item/permissions/requestApproval      → PermissionsRequestApprovalDecision
    // All three accept "acceptForSession" so future prompts for the same scope auto-pass.
    const autoApproveSession = async (params: JsonValue): Promise<JsonValue> => {
      this.emitRuntime('approval_auto_approved', summarize(params));
      return { decision: 'acceptForSession' };
    };
    this.serverRequestHandlers.set('item/commandExecution/requestApproval', autoApproveSession);
    this.serverRequestHandlers.set('item/fileChange/requestApproval', autoApproveSession);
    this.serverRequestHandlers.set('item/permissions/requestApproval', autoApproveSession);
    // Legacy v1 request names retained for transitional compatibility.
    this.serverRequestHandlers.set('execCommandApproval', autoApproveSession);
    this.serverRequestHandlers.set('applyPatchApproval', autoApproveSession);
    this.serverRequestHandlers.set('fileChangeRequestApproval', autoApproveSession);
    this.serverRequestHandlers.set('commandExecutionRequestApproval', autoApproveSession);
    this.serverRequestHandlers.set('permissionsRequestApproval', autoApproveSession);
    this.serverRequestHandlers.set('mcpServer/elicitation/request', autoApproveSession);
    // User-input requests fail the run instead of stalling (§10.5).
    this.serverRequestHandlers.set('item/tool/requestUserInput', async (params) => {
      this.emitRuntime('turn_input_required', summarize(params));
      this.completeTurn({
        turnId: this.currentTurnId ?? '',
        reason: 'turn_input_required',
        message: summarize(params),
      });
      return { decision: 'reject', reason: 'user input not supported' };
    });
    // Dynamic tool calls — reject unsupported tools without stalling (§10.5).
    this.serverRequestHandlers.set('item/tool/call', async (params) => {
      const supported = new Set(this.opts.supportedTools ?? []);
      const toolName =
        params && typeof params === 'object' && !Array.isArray(params)
          ? (params as Record<string, JsonValue>)['name']
          : null;
      if (typeof toolName === 'string' && supported.has(toolName)) {
        // The runtime advertised it but has no in-process implementation yet — still fail
        // gracefully rather than throw. Implementations override this handler to do real work.
        return { isError: true, content: [{ type: 'text', text: `tool ${toolName} not implemented` }] };
      }
      this.emitRuntime('unsupported_tool_call', summarize(params));
      return { isError: true, content: [{ type: 'text', text: `unsupported tool: ${toolName ?? '?'}` }] };
    });

    // Notifications — extract observability signal.
    //
    // Schema notes (Codex v2):
    //   thread/started.params = { thread: { id, ... } }      — id nested under thread
    //   turn/started.params   = { threadId, turn: { id, status, ... } }
    //   turn/completed.params = { threadId, turn: { id, status: "completed"|"failed"|... } }
    // The turn/completed notification fires for every terminal status. We must look at
    // turn.status to know whether the turn truly succeeded.
    const idOfThread = (params: JsonValue): string | null => {
      if (params && typeof params === 'object' && !Array.isArray(params)) {
        const thread = (params as Record<string, JsonValue>)['thread'];
        if (thread && typeof thread === 'object' && !Array.isArray(thread)) {
          const id = (thread as Record<string, JsonValue>)['id'];
          if (typeof id === 'string') return id;
        }
      }
      return null;
    };
    const turnFromParams = (params: JsonValue): Record<string, JsonValue> | null => {
      if (params && typeof params === 'object' && !Array.isArray(params)) {
        const turn = (params as Record<string, JsonValue>)['turn'];
        if (turn && typeof turn === 'object' && !Array.isArray(turn)) {
          return turn as Record<string, JsonValue>;
        }
      }
      return null;
    };

    this.notificationHandlers.set('thread/started', (params) => {
      const tid = idOfThread(params);
      if (tid) this.threadId = tid;
      this.emitRuntime('session_started', summarize(params));
    });
    this.notificationHandlers.set('turn/started', (params) => {
      const turn = turnFromParams(params);
      const tid = turn ? turn['id'] : null;
      if (typeof tid === 'string') this.currentTurnId = tid;
      this.emitRuntime('turn_started', summarize(params));
    });
    this.notificationHandlers.set('turn/completed', (params) => {
      const turn = turnFromParams(params);
      const status = typeof turn?.['status'] === 'string' ? (turn['status'] as string) : 'completed';
      const turnId = typeof turn?.['id'] === 'string' ? (turn['id'] as string) : this.currentTurnId ?? '';
      if (status === 'completed') {
        this.emitRuntime('turn_completed', summarize(params));
        this.completeTurn({ turnId, reason: 'turn_completed', message: summarize(params) });
      } else if (status === 'interrupted') {
        this.emitRuntime('turn_cancelled', summarize(params));
        this.completeTurn({ turnId, reason: 'turn_cancelled', message: summarize(params) });
      } else {
        // failed or any other non-completed terminal status
        this.emitRuntime('turn_failed', summarize(params));
        this.completeTurn({ turnId, reason: 'turn_failed', message: summarize(params) });
      }
    });
    this.notificationHandlers.set('thread/tokenUsage/updated', (params) => {
      const totals = extractTokenTotals(params);
      if (totals) {
        this.opts.onTokenUsage({
          input_tokens: totals.input,
          output_tokens: totals.output,
          total_tokens: totals.total,
        });
      }
      this.emitRuntime('thread_tokenUsage_updated', summarize(params));
    });
    this.notificationHandlers.set('account/rateLimits/updated', (params) => {
      this.opts.onRateLimits(params);
      this.emitRuntime('account_rateLimits_updated', summarize(params));
    });
    this.notificationHandlers.set('error', (params) => {
      this.emitRuntime('error_notification', summarize(params));
    });
  }

  private handleTransportClose(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    const err = new CodexProtocolError('port_exit', reason);
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
    if (this.turnWaiter) {
      const w = this.turnWaiter;
      this.turnWaiter = null;
      if (this.turnTimer) {
        clearTimeout(this.turnTimer);
        this.turnTimer = null;
      }
      w.resolve({
        turnId: this.currentTurnId ?? '',
        reason: 'subprocess_exit',
        message: reason,
      });
    }
  }

  private emitRuntime(event: string, message: string, raw?: JsonRpcMessage): void {
    this.opts.onEvent({ at: nowIso(), event, message }, raw);
  }

  private writeMessage(msg: JsonRpcRequest | JsonRpcResponse): void {
    if (this.closed) return;
    try {
      this.opts.stdin.write(JSON.stringify(msg) + '\n');
    } catch (err) {
      log.warn('codex write failed', { error: (err as Error).message });
    }
  }

  async request<T = JsonValue>(method: string, params: JsonValue): Promise<T> {
    const id = this.nextId++;
    const promise = new Promise<JsonValue>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new CodexProtocolError('response_timeout', `request ${method} timed out`));
        }
      }, this.opts.readTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    this.writeMessage({ jsonrpc: '2.0', id, method, params });
    return (await promise) as T;
  }

  async initialize(params: InitializeParams): Promise<JsonValue> {
    return this.request('initialize', params as unknown as JsonValue);
  }

  async startThread(params: ThreadStartParams): Promise<string> {
    const result = await this.request<JsonValue>('thread/start', params as unknown as JsonValue);
    // Codex v2 ThreadStartResponse nests the id under `thread.id`.
    if (result && typeof result === 'object' && !Array.isArray(result)) {
      const thread = (result as Record<string, JsonValue>)['thread'];
      if (thread && typeof thread === 'object' && !Array.isArray(thread)) {
        const id = (thread as Record<string, JsonValue>)['id'];
        if (typeof id === 'string') {
          this.threadId = id;
          return id;
        }
      }
      // Legacy v1 shape: `{ threadId: "..." }`
      const legacy = (result as Record<string, JsonValue>)['threadId'];
      if (typeof legacy === 'string') {
        this.threadId = legacy;
        return legacy;
      }
    }
    throw new CodexProtocolError('response_error', 'thread/start did not return a thread id');
  }

  // Send turn/start and resolve when one of the turn-terminating notifications fires (or the
  // subprocess exits, or the turn timeout elapses).
  async runTurn(params: TurnStartParams): Promise<TurnResult> {
    if (this.turnWaiter) {
      throw new CodexProtocolError('turn_in_progress', 'another turn is already in flight');
    }
    const result = new Promise<TurnResult>((resolve, reject) => {
      this.turnWaiter = { resolve, reject };
      this.turnTimer = setTimeout(() => {
        if (this.turnWaiter) {
          const w = this.turnWaiter;
          this.turnWaiter = null;
          w.resolve({
            turnId: this.currentTurnId ?? '',
            reason: 'turn_timeout',
            message: `turn exceeded ${this.opts.turnTimeoutMs}ms`,
          });
        }
      }, this.opts.turnTimeoutMs);
    });
    // Fire-and-forget: server will signal completion via a notification.
    try {
      await this.request('turn/start', params as unknown as JsonValue);
    } catch (err) {
      this.completeTurn({
        turnId: this.currentTurnId ?? '',
        reason: 'turn_failed',
        message: (err as Error).message,
      });
    }
    return result;
  }

  private completeTurn(r: TurnResult): void {
    if (!this.turnWaiter) return;
    const w = this.turnWaiter;
    this.turnWaiter = null;
    if (this.turnTimer) {
      clearTimeout(this.turnTimer);
      this.turnTimer = null;
    }
    w.resolve(r);
  }

  async interrupt(): Promise<void> {
    if (!this.threadId) return;
    try {
      await this.request('turn/interrupt', { threadId: this.threadId } as unknown as JsonValue);
    } catch (err) {
      log.debug('turn/interrupt failed', { error: (err as Error).message });
    }
  }

  get currentThreadId(): string | null {
    return this.threadId;
  }
}
