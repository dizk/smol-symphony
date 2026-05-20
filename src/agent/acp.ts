// ACP (Agent Client Protocol) client wrapper.
//
// Symphony talks the Zed Agent Client Protocol (https://agentclientprotocol.com) so that a
// single integration covers Claude (`claude-agent-acp`), Codex (`codex-acp`), and OpenCode
// (`opencode acp`). The protocol is JSON-RPC over stdio.
//
// This wrapper:
//   * spawns the adapter command inside a smolvm machine (the child process stdio is the
//     transport; nothing local is mutated outside the VM)
//   * bridges Node child process stdio to the SDK's WHATWG streams via Readable.toWeb / etc.
//   * implements the small Client surface ACP requires — session update streaming,
//     permission requests, and (optionally) fs/terminal — under a documented high-trust
//     posture (auto-approve, no client-side fs writes; the agent uses its own tools in-VM)
//   * exposes high-level methods `initSession()` and `runPrompt()` that the agent runner
//     uses to drive one turn of work.

import { Readable, Transform, type TransformCallback, Writable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Agent,
  type Client,
  type AuthenticateRequest,
  type AuthenticateResponse,
  type CancelNotification,
  type CreateTerminalRequest,
  type CreateTerminalResponse,
  type KillTerminalRequest,
  type KillTerminalResponse,
  type PromptRequest,
  type PromptResponse,
  type ReadTextFileRequest,
  type ReadTextFileResponse,
  type ReleaseTerminalRequest,
  type ReleaseTerminalResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type TerminalOutputRequest,
  type TerminalOutputResponse,
  type WaitForTerminalExitRequest,
  type WaitForTerminalExitResponse,
  type WriteTextFileRequest,
  type WriteTextFileResponse,
  type McpServer,
} from '@agentclientprotocol/sdk';
import type { RuntimeEvent } from '../types.js';
import { log } from '../logging.js';
import type { RunLog } from '../runlog.js';
import { summarizeToolCall, summarizeToolCallUpdate } from './tool-call-summary.js';

export interface AcpClientOptions {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  cwd: string;
  readTimeoutMs: number;
  promptTimeoutMs: number;
  onEvent: (event: RuntimeEvent) => void;
  onTokenUsage: (usage: { input_tokens: number; output_tokens: number; total_tokens: number }) => void;
  /** MCP servers to expose to the agent on session/new. Empty array = no MCP. */
  mcpServers?: McpServer[];
  /**
   * Per-issue JSONL run log. When set, every ACP frame in either direction (parsed as JSON
   * where possible, raw otherwise), every byte of adapter stderr, and lifecycle system
   * events are recorded for later evaluation. Optional so unit tests can omit it.
   */
  runLog?: RunLog;
}

export type PromptOutcome =
  | { reason: 'end_turn'; message: string }
  | { reason: 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled'; message: string }
  | { reason: 'prompt_timeout'; message: string }
  | { reason: 'subprocess_exit'; message: string }
  | { reason: 'startup_failed'; message: string };

export class AcpProtocolError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'AcpProtocolError';
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

function extractTextContent(content: unknown): string {
  if (!content || typeof content !== 'object') return '';
  const c = content as Record<string, unknown>;
  if (c.type === 'text' && typeof c.text === 'string') return c.text;
  return '';
}

// Transform that hands each newline-delimited frame to `onLine` while passing the raw bytes
// through to downstream consumers unchanged. Used to tap the ACP JSON-RPC transport in both
// directions for the per-issue JSONL run log. Buffering lives in `_transform`; a final flush
// surfaces any unterminated tail so a clean shutdown does not drop the last frame.
//
// We decode with a `StringDecoder` rather than `chunk.toString('utf8')` because TCP/stdout
// chunk boundaries can fall inside a multibyte UTF-8 sequence: an unaccompanied byte split
// would otherwise be silently converted to a U+FFFD replacement character, corrupting the
// JSON we record. The decoder buffers the trailing incomplete sequence and returns it
// prepended to the next chunk's decode.
class LineTap extends Transform {
  private buf = '';
  private decoder = new StringDecoder('utf8');
  constructor(private readonly onLine: (line: string) => void) {
    super();
  }
  _transform(chunk: Buffer | string, _enc: BufferEncoding, cb: TransformCallback): void {
    this.buf +=
      typeof chunk === 'string' ? chunk : this.decoder.write(chunk as Buffer);
    let idx: number;
    while ((idx = this.buf.indexOf('\n')) !== -1) {
      const line = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 1);
      if (line.length > 0) {
        try {
          this.onLine(line);
        } catch {
          // Tap failures must not interrupt the stream.
        }
      }
    }
    cb(null, chunk);
  }
  _flush(cb: TransformCallback): void {
    // Drain any incomplete multibyte sequence the decoder is still holding, then surface
    // an unterminated tail so a clean shutdown does not drop the last frame.
    const tail = this.decoder.end();
    if (tail.length > 0) this.buf += tail;
    if (this.buf.length > 0) {
      try {
        this.onLine(this.buf);
      } catch {
        /* see _transform */
      }
      this.buf = '';
    }
    cb();
  }
}

// Record one ACP frame to the run log. Lines that parse as JSON are stored as parsed values
// so the evaluator agent doesn't double-decode; anything else lands as `kind: "unparseable"`
// with the raw bytes preserved for forensic value.
//
// Before recording, capability tokens in the frame are redacted in place. The most common
// one is the symphony MCP bearer that we inject into `session/new` as
// `mcpServers[].headers[].value = "Bearer <token>"`; that token is the agent's per-issue
// capability to call `mark_done` and `request_human_steering`, and the JSONL log is a
// long-lived append-only file an evaluator may share. Replace any string starting with
// `Bearer ` with `Bearer <redacted>` anywhere in the tree.
function recordAcpFrame(
  runLog: RunLog | undefined,
  direction: 'host_to_vm' | 'vm_to_host',
  line: string,
): void {
  if (!runLog) return;
  let frame: unknown;
  try {
    frame = JSON.parse(line);
  } catch {
    runLog.record({ channel: 'acp', direction, kind: 'unparseable', raw: line });
    return;
  }
  redactBearerTokens(frame);
  runLog.record({ channel: 'acp', direction, frame });
}

// Walk `value` and replace any string of the form `Bearer <token>` with `Bearer <redacted>`.
// Mutates in place; callers must pass the parsed JSON (which is single-use per call). We
// walk arrays and plain objects only; primitives other than strings are skipped, and we
// guard against cycles even though ACP frames shouldn't contain them.
function redactBearerTokens(value: unknown, seen = new WeakSet<object>()): void {
  if (Array.isArray(value)) {
    if (seen.has(value)) return;
    seen.add(value);
    for (let i = 0; i < value.length; i++) {
      const v = value[i];
      if (typeof v === 'string') {
        if (v.startsWith('Bearer ')) value[i] = 'Bearer <redacted>';
      } else if (v && typeof v === 'object') {
        redactBearerTokens(v, seen);
      }
    }
    return;
  }
  if (value && typeof value === 'object') {
    if (seen.has(value as object)) return;
    seen.add(value as object);
    for (const k of Object.keys(value as Record<string, unknown>)) {
      const v = (value as Record<string, unknown>)[k];
      if (typeof v === 'string') {
        if (v.startsWith('Bearer ')) (value as Record<string, unknown>)[k] = 'Bearer <redacted>';
      } else if (v && typeof v === 'object') {
        redactBearerTokens(v, seen);
      }
    }
  }
}

// One open ACP session bound to a single child process. The adapter is expected to be
// already running; `initSession()` performs `initialize` + `session/new`, and `runPrompt()`
// drives one prompt-to-stop_reason cycle.
export class AcpClient {
  private conn: ClientSideConnection;
  private sessionId: string | null = null;
  private closed = false;
  private cancelled = false;
  // Tracked here so the runner snapshot picks up the most recent assistant text per turn.
  private lastAssistantText = '';
  // Held so `handleTransportClose` can forcibly end the SDK's reader/writer streams.
  // Without this, destroying the underlying socket emits `'close'` on `opts.stdout` but
  // the LineTap Transform in between may not propagate end-of-stream synchronously to
  // `Readable.toWeb`'s output. The SDK's `receive()` reader loop then stays parked in
  // `reader.read()`, so the in-flight `session/prompt` promise never rejects and the
  // runner hangs in `runPrompt()` despite the socket being gone.
  private inboundTap: LineTap;
  private outboundTap: LineTap;

  constructor(private opts: AcpClientOptions) {
    // Bridge child stdio to the WHATWG streams the SDK speaks. `ndJsonStream` expects raw
    // bytes; we use Readable.toWeb / Writable.toWeb for the conversion. Both directions
    // pass through a LineTap so the per-issue JSONL run log captures every JSON-RPC frame
    // verbatim (parsed JSON when possible, raw bytes when not).
    this.inboundTap = new LineTap((line) => recordAcpFrame(opts.runLog, 'vm_to_host', line));
    this.outboundTap = new LineTap((line) => recordAcpFrame(opts.runLog, 'host_to_vm', line));
    opts.stdout.pipe(this.inboundTap);
    this.outboundTap.pipe(opts.stdin);
    const input = Readable.toWeb(this.inboundTap) as ReadableStream<Uint8Array>;
    const output = Writable.toWeb(this.outboundTap) as WritableStream<Uint8Array>;
    const stream = ndJsonStream(output, input);
    this.conn = new ClientSideConnection((_agent) => this.makeClient(), stream);

    // Stderr handling lives in the AgentRunner now — it attaches a tap immediately after
    // launching the sandbox process so pre-bridge startup failures (vm-agent missing,
    // bad env, adapter crash before connect) are captured in the JSONL run log and the
    // per-issue event ring. AcpClient no longer consumes opts.stderr; the field is kept
    // on the options type for backward compatibility and so callers retain a single
    // place to think about where the stderr stream goes.
    opts.stdout.on('close', () => this.handleTransportClose('stdout_closed'));
    opts.stdin.on('error', () => {
      /* surface through transport close */
    });
  }

  // The Client interface implementation that the adapter calls back into. Every method is
  // implemented because we run the agent inside a smolvm; ACP requires the client to handle
  // requests it advertises, and the SDK's Client interface lists them all.
  private makeClient(): Client {
    const self = this;
    return {
      async sessionUpdate(params: SessionNotification): Promise<void> {
        return self.onSessionUpdate(params);
      },
      async requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
        return self.onPermissionRequest(params);
      },
      async readTextFile(_params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
        // §10.5 "high-trust" posture: the agent has direct workspace access inside the VM,
        // so client-mediated reads are unsupported. Returning an error keeps the session
        // alive (per §10.5 "unsupported dynamic tool calls return failure without stall").
        throw new AcpProtocolError('client_capability_not_implemented', 'client fs read not supported');
      },
      async writeTextFile(_params: WriteTextFileRequest): Promise<WriteTextFileResponse> {
        throw new AcpProtocolError('client_capability_not_implemented', 'client fs write not supported');
      },
      async createTerminal(_params: CreateTerminalRequest): Promise<CreateTerminalResponse> {
        throw new AcpProtocolError('client_capability_not_implemented', 'client terminal not supported');
      },
      async terminalOutput(_params: TerminalOutputRequest): Promise<TerminalOutputResponse> {
        throw new AcpProtocolError('client_capability_not_implemented', 'client terminal not supported');
      },
      async waitForTerminalExit(_params: WaitForTerminalExitRequest): Promise<WaitForTerminalExitResponse> {
        throw new AcpProtocolError('client_capability_not_implemented', 'client terminal not supported');
      },
      async killTerminal(_params: KillTerminalRequest): Promise<KillTerminalResponse> {
        throw new AcpProtocolError('client_capability_not_implemented', 'client terminal not supported');
      },
      async releaseTerminal(_params: ReleaseTerminalRequest): Promise<ReleaseTerminalResponse> {
        throw new AcpProtocolError('client_capability_not_implemented', 'client terminal not supported');
      },
    };
  }

  private emit(event: string, message: string): void {
    this.opts.onEvent({ at: nowIso(), event, message });
  }

  private onSessionUpdate(params: SessionNotification): void {
    const update = params.update as { sessionUpdate: string } & Record<string, unknown>;
    switch (update.sessionUpdate) {
      case 'agent_message_chunk': {
        const text = extractTextContent(update.content);
        if (text) {
          this.lastAssistantText += text;
          this.emit('agent_message_chunk', text.length > 80 ? text.slice(0, 80) + '…' : text);
        }
        return;
      }
      case 'agent_thought_chunk': {
        const text = extractTextContent(update.content);
        if (text) this.emit('agent_thought_chunk', text.length > 80 ? text.slice(0, 80) + '…' : text);
        return;
      }
      case 'tool_call': {
        this.emit('tool_call', summarizeToolCall(update));
        return;
      }
      case 'tool_call_update': {
        this.emit('tool_call_update', summarizeToolCallUpdate(update));
        return;
      }
      case 'plan': {
        this.emit('plan', summarize(update.entries ?? update));
        return;
      }
      case 'usage_update': {
        // ACP usage is "context-window used / size", not cumulative I/O tokens. We map it
        // into total_tokens so the existing orchestrator accounting stays meaningful; the
        // I/O split is recorded as zero because ACP does not expose it.
        const used = Number((update as Record<string, unknown>).used ?? 0);
        const size = Number((update as Record<string, unknown>).size ?? 0);
        this.opts.onTokenUsage({ input_tokens: 0, output_tokens: 0, total_tokens: used });
        this.emit('usage_update', `used=${used}/${size}`);
        return;
      }
      default:
        this.emit('session_update', `${update.sessionUpdate}: ${summarize(update)}`);
    }
  }

  private onPermissionRequest(params: RequestPermissionRequest): RequestPermissionResponse {
    // §10.5 high-trust posture: auto-approve every prompt with "allow_always" so the
    // agent doesn't ask twice in the same session. Falls back to the first listed option
    // if no "allow_*" kind is present, which keeps the session alive in degraded mode.
    const preferred =
      params.options.find((o) => o.kind === 'allow_always') ??
      params.options.find((o) => o.kind === 'allow_once') ??
      params.options[0];
    const optionId = preferred?.optionId ?? '';
    const tool = summarizeToolCallUpdate(params.toolCall);
    this.emit('approval_auto_approved', `${optionId || 'unknown'}: ${tool}`);
    return { outcome: { outcome: 'selected', optionId } };
  }

  private handleTransportClose(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.emit('subprocess_exit', reason);
    // Force-end the LineTap streams so the SDK's `receive()` reader loop observes
    // `done: true` from `reader.read()`. That makes the SDK call its internal `close()`,
    // which rejects every entry in `pendingResponses` (including the in-flight
    // `session/prompt`). Without this, the runner hangs in `runPrompt()` for the full
    // `prompt_timeout_ms` (30 min) even though the socket is gone, because `socket.destroy()`
    // emits `'close'` on the socket but Node's pipe machinery does not always propagate an
    // end-of-stream through the Transform synchronously. `Transform.end()` is idempotent
    // and safe to call here even if the natural pipe-EOF would have eventually arrived.
    try {
      this.inboundTap.end();
    } catch {
      /* idempotent — already ended */
    }
    try {
      this.outboundTap.end();
    } catch {
      /* idempotent — already ended */
    }
  }

  /**
   * Explicit force-close for cancel paths. Idempotent. Triggers `handleTransportClose`
   * (and thus the SDK's internal close + pendingResponses rejection) without waiting for
   * the underlying socket to surface its own `'close'` event. Safe to call from cancel
   * timers that fire repeatedly.
   */
  forceClose(reason: string): void {
    this.handleTransportClose(reason);
  }

  // Negotiate protocol + open a session. Throws on either failure.
  async initSession(): Promise<{ sessionId: string }> {
    const init = await withTimeout(
      this.conn.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientInfo: { name: 'smol-symphony', version: '0.1.0' },
        clientCapabilities: {
          // Advertise the minimum: the agent can read/write the workspace itself inside
          // the VM, so we do not offer fs/terminal capabilities.
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
      }),
      this.opts.readTimeoutMs,
      'initialize',
    );
    this.emit('session_init', `protocolVersion=${init.protocolVersion}`);

    // MCP is required for symphony operations: if the agent doesn't advertise support
    // for a requested transport, we refuse to start the session rather than silently
    // dropping the entry and running a degraded agent that has no mark_done /
    // request_human_steering tools. ACP's mcpCapabilities is optional and advertises
    // `http`/`sse`/`acp` as booleans; missing/undefined means "not supported." Stdio is
    // implicit (the spec treats it as the baseline) and has no `type` discriminator.
    const requested = this.opts.mcpServers ?? [];
    const caps = (init.agentCapabilities ?? {}) as {
      mcpCapabilities?: { http?: boolean; sse?: boolean; acp?: boolean };
    };
    const mcpCaps = caps.mcpCapabilities ?? {};
    const supportsKind = (kind: 'stdio' | 'http' | 'sse' | 'acp'): boolean => {
      if (kind === 'stdio') return true;
      if (kind === 'http') return mcpCaps.http === true;
      if (kind === 'sse') return mcpCaps.sse === true;
      if (kind === 'acp') return mcpCaps.acp === true;
      return false;
    };
    const unsupported = requested.filter((s) => {
      const kind = ((s as { type?: string }).type ?? 'stdio') as 'stdio' | 'http' | 'sse' | 'acp';
      return !supportsKind(kind);
    });
    if (unsupported.length > 0) {
      const kinds = unsupported
        .map((s) => (s as { type?: string }).type ?? 'stdio')
        .join(', ');
      this.emit(
        'mcp_capability_mismatch',
        `unsupported=${kinds} adapter_caps=${JSON.stringify(mcpCaps)}`,
      );
      throw new AcpProtocolError(
        'mcp_capability_mismatch',
        `agent does not support required MCP transport(s): ${kinds}. Adapter caps: ${JSON.stringify(
          mcpCaps,
        )}`,
      );
    }

    const session = await withTimeout(
      this.conn.newSession({ cwd: this.opts.cwd, mcpServers: requested }),
      this.opts.readTimeoutMs,
      'session/new',
    );
    this.sessionId = session.sessionId;
    this.emit(
      'session_started',
      `sessionId=${session.sessionId} cwd=${this.opts.cwd} mcp_servers=${requested.length}`,
    );
    return { sessionId: session.sessionId };
  }

  async runPrompt(promptText: string): Promise<PromptOutcome> {
    if (this.closed) return { reason: 'subprocess_exit', message: 'adapter already closed' };
    if (!this.sessionId) return { reason: 'startup_failed', message: 'no active session' };
    this.lastAssistantText = '';
    const request: PromptRequest = {
      sessionId: this.sessionId,
      prompt: [{ type: 'text', text: promptText }],
    };
    let resp: PromptResponse;
    try {
      resp = await withTimeout(this.conn.prompt(request), this.opts.promptTimeoutMs, 'session/prompt');
    } catch (err) {
      if (err instanceof TimeoutError) {
        // Best-effort cancel so the adapter doesn't keep working in the background.
        this.cancel().catch(() => undefined);
        return { reason: 'prompt_timeout', message: err.message };
      }
      if (this.closed) return { reason: 'subprocess_exit', message: (err as Error).message };
      return { reason: 'refusal', message: (err as Error).message };
    }
    return mapStopReason(resp.stopReason, this.lastAssistantText);
  }

  async cancel(): Promise<void> {
    if (!this.sessionId || this.closed || this.cancelled) return;
    this.cancelled = true;
    const note: CancelNotification = { sessionId: this.sessionId };
    try {
      await this.conn.cancel(note);
    } catch (err) {
      log.debug('acp cancel failed', { error: (err as Error).message });
    }
  }
}

function mapStopReason(stopReason: string, lastText: string): PromptOutcome {
  switch (stopReason) {
    case 'end_turn':
      return { reason: 'end_turn', message: summarize(lastText) };
    case 'max_tokens':
    case 'max_turn_requests':
    case 'refusal':
    case 'cancelled':
      return { reason: stopReason, message: summarize(lastText) };
    default:
      return { reason: 'refusal', message: `unknown stop_reason ${stopReason}` };
  }
}

class TimeoutError extends Error {}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new TimeoutError(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e as Error);
      },
    );
  });
}

// Used for misc auth helpers; we don't implement an interactive auth flow today.
export type _Unused = AuthenticateRequest | AuthenticateResponse | Agent;
