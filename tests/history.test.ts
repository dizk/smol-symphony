// Tests for the historical-sessions surface. Exercises the parser/summarizer + the HTTP
// routes that browse the per-issue JSONL run logs. The detail-page renderer is verified
// by spot-checking that the salient signals an operator audits for — tool failures, MCP
// usage, agent thinking, the original prompt — are present in the rendered HTML.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  isSafeIdentifier,
  listSessions,
  loadSession,
  parseRunLog,
  summarize,
  renderHistoryListPage,
  renderSessionDetailPage,
} from '../src/history.js';
import { startHttpServer, type HttpServerOptions } from '../src/http.js';
import type { Orchestrator, Snapshot } from '../src/orchestrator.js';

function makeStubOrchestrator(): Orchestrator {
  const snap: Snapshot = {
    generated_at: new Date().toISOString(),
    counts: { running: 0, retrying: 0 },
    running: [],
    retrying: [],
    codex_totals: { input_tokens: 0, output_tokens: 0, total_tokens: 0, seconds_running: 0 },
    rate_limits: null,
  };
  return {
    snapshot: () => snap,
    triggerRefresh: () => ({ status: 'ok' as const }),
    detailByIdentifier: () => null,
  } as unknown as Orchestrator;
}

// Build a realistic-looking jsonl log: attempt_started → prompt → thought → tool_call →
// tool_call_update (failed) → mcp__symphony__mark_done (completed) → attempt_ended.
function fixtureLog(issueId: string, identifier: string): string {
  const ts = (sec: number) => new Date(Date.parse('2026-05-20T12:00:00Z') + sec * 1000).toISOString();
  const lines = [
    {
      ts: ts(0),
      issue_id: issueId,
      issue_identifier: identifier,
      attempt: 1,
      channel: 'system',
      event: 'attempt_started',
      fields: {
        attempt: 1,
        issue_state: 'Todo',
        issue_title: 'Fix the login bug',
        workspace_path: '/tmp/ws',
        terminal_target: 'Done',
      },
    },
    {
      ts: ts(1),
      issue_id: issueId,
      issue_identifier: identifier,
      attempt: 1,
      channel: 'acp',
      direction: 'host_to_vm',
      frame: {
        jsonrpc: '2.0',
        id: 2,
        method: 'session/prompt',
        params: {
          sessionId: 'sess-1',
          prompt: [{ type: 'text', text: 'You are working on Fix the login bug. Begin.' }],
        },
      },
    },
    {
      ts: ts(2),
      issue_id: issueId,
      issue_identifier: identifier,
      attempt: 1,
      channel: 'acp',
      direction: 'vm_to_host',
      frame: {
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'sess-1',
          update: {
            sessionUpdate: 'agent_thought_chunk',
            content: { type: 'text', text: 'Let me first inspect the auth code.' },
          },
        },
      },
    },
    {
      ts: ts(3),
      issue_id: issueId,
      issue_identifier: identifier,
      attempt: 1,
      channel: 'acp',
      direction: 'vm_to_host',
      frame: {
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'sess-1',
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'tc-1',
            title: 'Bash',
            kind: 'execute',
            _meta: { claudeCode: { toolName: 'Bash' } },
            status: 'pending',
          },
        },
      },
    },
    {
      ts: ts(4),
      issue_id: issueId,
      issue_identifier: identifier,
      attempt: 1,
      channel: 'acp',
      direction: 'vm_to_host',
      frame: {
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'sess-1',
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'tc-1',
            status: 'failed',
            _meta: { claudeCode: { toolName: 'Bash' } },
            content: [
              { type: 'content', content: { type: 'text', text: 'command not found: nope' } },
            ],
          },
        },
      },
    },
    {
      ts: ts(5),
      issue_id: issueId,
      issue_identifier: identifier,
      attempt: 1,
      channel: 'stderr',
      text: 'a chatty adapter warning\n',
    },
    {
      ts: ts(6),
      issue_id: issueId,
      issue_identifier: identifier,
      attempt: 1,
      channel: 'hook',
      hook: 'after_run',
      stream: 'stdout',
      text: 'wrote patch bundle: /tmp/foo.patch\n',
    },
    {
      ts: ts(7),
      issue_id: issueId,
      issue_identifier: identifier,
      attempt: 1,
      channel: 'acp',
      direction: 'vm_to_host',
      frame: {
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'sess-1',
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'tc-2',
            title: 'mark_done',
            _meta: { claudeCode: { toolName: 'mcp__symphony__mark_done' } },
            status: 'pending',
          },
        },
      },
    },
    {
      ts: ts(8),
      issue_id: issueId,
      issue_identifier: identifier,
      attempt: 1,
      channel: 'acp',
      direction: 'vm_to_host',
      frame: {
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'sess-1',
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'tc-2',
            status: 'completed',
            _meta: { claudeCode: { toolName: 'mcp__symphony__mark_done' } },
            content: [
              { type: 'content', content: { type: 'text', text: 'Marked LOGIN-1 as done.' } },
            ],
          },
        },
      },
    },
    {
      ts: ts(9),
      issue_id: issueId,
      issue_identifier: identifier,
      attempt: 1,
      channel: 'system',
      event: 'attempt_ended',
      fields: { ok: true, reason: 'agent_marked_done', turns_completed: 1 },
    },
  ];
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
}

describe('history.parseRunLog', () => {
  it('parses one entry per line and tolerates blank lines', () => {
    const text = '{"a":1}\n\n{"b":2}\n';
    const parsed = parseRunLog(text);
    assert.equal(parsed.length, 2);
    assert.equal(parsed[0]!['a'], 1);
    assert.equal(parsed[1]!['b'], 2);
  });

  it('drops unparseable lines without throwing', () => {
    const text = '{"ok":true}\nthis is not json\n{"ok":2}\n';
    const parsed = parseRunLog(text);
    assert.equal(parsed.length, 2);
  });

  it('drops non-object JSON values', () => {
    const text = '"hello"\n[1,2,3]\n{"ok":1}\n';
    const parsed = parseRunLog(text);
    assert.equal(parsed.length, 1);
  });
});

describe('history.summarize', () => {
  it('extracts identifying signals from the fixture log', () => {
    const text = fixtureLog('uuid-1', 'LOGIN-1');
    const entries = parseRunLog(text);
    const s = summarize('LOGIN-1', '/tmp/LOGIN-1.jsonl', Date.now(), text.length, entries);
    assert.equal(s.identifier, 'LOGIN-1');
    assert.equal(s.issue_title, 'Fix the login bug');
    assert.equal(s.attempts, 1);
    assert.equal(s.tool_calls, 2, 'two tool_call starts');
    assert.equal(s.tool_failures, 1);
    assert.equal(s.mcp_calls, 1, 'one mcp__symphony__ tool');
    assert.equal(s.marked_done, true);
    assert.equal(s.line_count, entries.length);
    assert.equal(s.agent_failure_reason, null);
  });

  it('records agent failure reason from attempt_ended.ok=false', () => {
    const ts = '2026-05-20T12:00:00Z';
    const text =
      JSON.stringify({
        ts,
        issue_id: 'a',
        issue_identifier: 'A-1',
        attempt: 1,
        channel: 'system',
        event: 'attempt_ended',
        fields: { ok: false, reason: 'max_turns_reached', turns_completed: 6 },
      }) + '\n';
    const s = summarize('A-1', '/tmp/A-1.jsonl', Date.now(), text.length, parseRunLog(text));
    assert.equal(s.agent_failure_reason, 'max_turns_reached');
  });

  it('counts steering requests via mcp__symphony__request_human_steering', () => {
    const ts = '2026-05-20T12:00:00Z';
    const entry = {
      ts,
      issue_id: 'a',
      issue_identifier: 'A-1',
      attempt: 1,
      channel: 'acp',
      direction: 'vm_to_host',
      frame: {
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 's',
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'tc',
            _meta: { claudeCode: { toolName: 'mcp__symphony__request_human_steering' } },
          },
        },
      },
    };
    const text = JSON.stringify(entry) + '\n';
    const s = summarize('A-1', '/tmp/A-1.jsonl', Date.now(), text.length, parseRunLog(text));
    assert.equal(s.steering_requests, 1);
    assert.equal(s.mcp_calls, 1);
  });
});

describe('history.isSafeIdentifier', () => {
  it('accepts sanitizeWorkspaceKey-style identifiers', () => {
    assert.equal(isSafeIdentifier('LOGIN-1'), true);
    assert.equal(isSafeIdentifier('login_bug.v2'), true);
    assert.equal(isSafeIdentifier('fix-the-login-bug'), true);
  });

  it('rejects path-traversal attempts', () => {
    assert.equal(isSafeIdentifier('../etc/passwd'), false);
    assert.equal(isSafeIdentifier('foo/bar'), false);
    assert.equal(isSafeIdentifier(''), false);
    assert.equal(isSafeIdentifier('has space'), false);
  });
});

describe('history.listSessions + loadSession', () => {
  let logsRoot: string;
  before(async () => {
    logsRoot = await mkdtemp(path.join(os.tmpdir(), 'symphony-hist-'));
    await writeFile(path.join(logsRoot, 'LOGIN-1.jsonl'), fixtureLog('uuid-1', 'LOGIN-1'));
    await writeFile(
      path.join(logsRoot, 'OTHER-2.jsonl'),
      JSON.stringify({
        ts: '2026-05-19T12:00:00Z',
        issue_id: 'u2',
        issue_identifier: 'OTHER-2',
        attempt: 0,
        channel: 'system',
        event: 'attempt_started',
        fields: { issue_title: 'Other thing' },
      }) + '\n',
    );
    // A non-JSONL file should be ignored.
    await writeFile(path.join(logsRoot, 'README.md'), 'ignore me');
  });
  after(async () => {
    await rm(logsRoot, { recursive: true, force: true });
  });

  it('returns one summary per .jsonl file, ignoring others', async () => {
    const out = await listSessions(logsRoot);
    assert.equal(out.length, 2);
    const ids = out.map((s) => s.identifier).sort();
    assert.deepEqual(ids, ['LOGIN-1', 'OTHER-2']);
  });

  it('loadSession returns parsed entries for a safe identifier', async () => {
    const loaded = await loadSession(logsRoot, 'LOGIN-1');
    assert.ok(loaded);
    assert.equal(loaded.identifier, 'LOGIN-1');
    assert.ok(loaded.entries.length > 0);
  });

  it('loadSession rejects path traversal', async () => {
    const loaded = await loadSession(logsRoot, '../etc/passwd');
    assert.equal(loaded, null);
  });

  it('loadSession returns null for missing files', async () => {
    const loaded = await loadSession(logsRoot, 'DOES-NOT-EXIST');
    assert.equal(loaded, null);
  });

  it('returns empty for missing logs root', async () => {
    const out = await listSessions(path.join(logsRoot, 'nonexistent'));
    assert.deepEqual(out, []);
  });

  it('returns empty for null logs root', async () => {
    const out = await listSessions(null);
    assert.deepEqual(out, []);
  });
});

describe('history rendering', () => {
  it('renderHistoryListPage shows identifiers and aggregated stats', () => {
    const text = fixtureLog('uuid-1', 'LOGIN-1');
    const entries = parseRunLog(text);
    const s = summarize('LOGIN-1', '/tmp/LOGIN-1.jsonl', Date.now(), text.length, entries);
    const html = renderHistoryListPage({ logsRoot: '/tmp/logs', sessions: [s] });
    assert.match(html, /LOGIN-1/);
    assert.match(html, /Fix the login bug/);
    assert.match(html, /marked done/);
    assert.match(html, /class="stat err">.*1<\/span> failed/);
    assert.match(html, /class="stat mcp">.*1<\/span> mcp/);
    assert.match(html, /<a class="open" href="\/history\/LOGIN-1">open/);
  });

  it('renderHistoryListPage shows the empty state when there are no sessions', () => {
    const html = renderHistoryListPage({ logsRoot: '/tmp/logs', sessions: [] });
    assert.match(html, /no historical sessions yet/);
  });

  it('renderSessionDetailPage surfaces thinking, tool failures, MCP calls, and the prompt', () => {
    const text = fixtureLog('uuid-1', 'LOGIN-1');
    const entries = parseRunLog(text);
    const s = summarize('LOGIN-1', '/tmp/LOGIN-1.jsonl', Date.now(), text.length, entries);
    const html = renderSessionDetailPage({
      identifier: 'LOGIN-1',
      entries,
      mtimeMs: Date.now(),
      size: text.length,
      summary: s,
    });
    // Original prompt body is reachable.
    assert.match(html, /You are working on Fix the login bug/);
    // Agent thinking is rendered (the audit signal).
    assert.match(html, /Let me first inspect the auth code/);
    // Tool failure is visible.
    assert.match(html, /tool-call failed/);
    assert.match(html, /command not found: nope/);
    // MCP call is highlighted.
    assert.match(html, /tool-call mcp/);
    assert.match(html, /mcp__symphony__mark_done/);
    // Hook output is captured.
    assert.match(html, /after_run/);
    // Attempt header.
    assert.match(html, /attempt 1/);
  });

  it('renderSessionDetailPage escapes HTML in agent text', () => {
    const ts = '2026-05-20T12:00:00Z';
    const text =
      JSON.stringify({
        ts,
        issue_id: 'a',
        issue_identifier: 'A-1',
        attempt: 0,
        channel: 'acp',
        direction: 'vm_to_host',
        frame: {
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 's',
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: '<script>alert(1)</script>' },
            },
          },
        },
      }) + '\n';
    const entries = parseRunLog(text);
    const s = summarize('A-1', '/tmp/A-1.jsonl', Date.now(), text.length, entries);
    const html = renderSessionDetailPage({
      identifier: 'A-1',
      entries,
      mtimeMs: Date.now(),
      size: text.length,
      summary: s,
    });
    assert.ok(!html.includes('<script>alert(1)</script>'), 'raw script tag must not appear');
    assert.match(html, /&lt;script&gt;/);
  });
});

describe('HTTP /history routes', () => {
  let logsRoot: string;
  let server: { url: string; close: () => Promise<void> };

  before(async () => {
    logsRoot = await mkdtemp(path.join(os.tmpdir(), 'symphony-http-hist-'));
    await writeFile(path.join(logsRoot, 'LOGIN-1.jsonl'), fixtureLog('uuid-1', 'LOGIN-1'));
    const orch = makeStubOrchestrator();
    const opts: HttpServerOptions = {
      port: 0,
      host: '127.0.0.1',
      getTrackerView: () => ({
        trackerRoot: null,
        activeStates: ['Todo'],
        terminalStates: ['Done', 'Cancelled'],
        workflowPath: '/tmp/WORKFLOW.md',
        logsRoot,
      }),
      mcp: null,
      tracker: null,
    };
    const handle = await startHttpServer(orch, opts);
    server = { url: `http://127.0.0.1:${handle.port}`, close: handle.close };
  });

  after(async () => {
    await server.close();
    await rm(logsRoot, { recursive: true, force: true });
  });

  it('GET /history lists known sessions', async () => {
    const res = await fetch(`${server.url}/history`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/html/);
    const html = await res.text();
    assert.match(html, /LOGIN-1/);
    assert.match(html, /Fix the login bug/);
  });

  it('GET /history/<id> renders the detail page', async () => {
    const res = await fetch(`${server.url}/history/LOGIN-1`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /You are working on Fix the login bug/);
    assert.match(html, /mcp__symphony__mark_done/);
  });

  it('GET /history/<id> rejects path-traversal identifiers with 404', async () => {
    const res = await fetch(`${server.url}/history/..%2Fetc%2Fpasswd`);
    assert.equal(res.status, 404);
  });

  it('GET /history/<id> returns 404 for unknown identifiers', async () => {
    const res = await fetch(`${server.url}/history/UNKNOWN`);
    assert.equal(res.status, 404);
  });

  it('GET /api/v1/history/<id>.jsonl streams the raw run log', async () => {
    const res = await fetch(`${server.url}/api/v1/history/LOGIN-1.jsonl`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /application\/x-ndjson/);
    const text = await res.text();
    // Every line should be valid JSON.
    for (const line of text.trim().split('\n')) JSON.parse(line);
  });

  it('dashboard shell links to /history', async () => {
    const res = await fetch(`${server.url}/`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /href="\/history"/);
  });
});

describe('HTTP /history routes — logs disabled', () => {
  let server: { url: string; close: () => Promise<void> };

  before(async () => {
    const orch = makeStubOrchestrator();
    const opts: HttpServerOptions = {
      port: 0,
      host: '127.0.0.1',
      getTrackerView: () => ({
        trackerRoot: null,
        activeStates: ['Todo'],
        terminalStates: ['Done'],
        workflowPath: '/tmp/WORKFLOW.md',
        // logsRoot omitted on purpose
      }),
      mcp: null,
      tracker: null,
    };
    const handle = await startHttpServer(orch, opts);
    server = { url: `http://127.0.0.1:${handle.port}`, close: handle.close };
  });

  after(async () => {
    await server.close();
  });

  it('GET /history renders an empty page (no logs.root configured)', async () => {
    const res = await fetch(`${server.url}/history`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /no <code>logs.root<\/code> is configured/);
  });

  it('GET /history/<id> returns 404 when logs root is missing', async () => {
    const res = await fetch(`${server.url}/history/whatever`);
    assert.equal(res.status, 404);
    const data = (await res.json()) as { error: { code: string } };
    assert.equal(data.error.code, 'logs_not_configured');
  });
});
