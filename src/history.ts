// Historical sessions surface. Reads the per-issue JSONL run logs written by `runlog.ts`,
// groups them into a "history" page so an operator can audit what the agent actually did:
// tool calls (including failures), agent thinking, the human-steering questions it asked,
// and how it used symphony's MCP. Intentionally read-only and static — no polling, no
// re-runs; the logs themselves are the source of truth.
//
// The schema of a run log line is documented at the top of `runlog.ts`. We parse loosely
// (missing fields are tolerated, malformed lines are dropped) because these logs live for
// a long time and may straddle schema revisions.
//
// Path safety: `loadSession` only accepts identifiers matching the same `[A-Za-z0-9._-]+`
// alphabet `sanitizeWorkspaceKey` produces, so no input can escape `logsRoot` via `..`
// segments or absolute prefixes.
//
// Sensitive material: ACP frames have their `Bearer <token>` capability strings redacted at
// write time (see `redactBearerTokens` in `agent/acp.ts`), so this surface never has to
// re-redact. If a future event channel persists tokens, redact at the write site.

import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

export type RunLogEntry = {
  ts?: string;
  issue_id?: string;
  issue_identifier?: string;
  attempt?: number;
  channel?: string;
} & Record<string, unknown>;

export interface SessionSummary {
  identifier: string;
  file_path: string;
  size_bytes: number;
  last_modified: string;
  line_count: number;
  attempts: number;
  first_ts: string | null;
  last_ts: string | null;
  issue_title: string | null;
  tool_calls: number;
  tool_failures: number;
  steering_requests: number;
  mcp_calls: number;
  marked_done: boolean;
  agent_failure_reason: string | null;
}

// Identifier alphabet matches `sanitizeWorkspaceKey` so anything the runlog writes is
// reachable, but `../etc/passwd` is rejected outright.
const SAFE_IDENT = /^[A-Za-z0-9._-]+$/;

export function isSafeIdentifier(identifier: string): boolean {
  return SAFE_IDENT.test(identifier);
}

/** Parse a JSONL run log into an array of entries. Lines that fail JSON.parse are skipped. */
export function parseRunLog(text: string): RunLogEntry[] {
  if (text.length === 0) return [];
  const out: RunLogEntry[] = [];
  for (const line of text.split('\n')) {
    if (line.length === 0) continue;
    try {
      const v = JSON.parse(line) as unknown;
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        out.push(v as RunLogEntry);
      }
    } catch {
      // Best-effort: a truncated tail line during process kill would land here. The
      // operator sees a smaller-than-expected timeline; the orchestrator never crashed.
    }
  }
  return out;
}

function getFrame(entry: RunLogEntry): Record<string, unknown> | null {
  const f = (entry as { frame?: unknown }).frame;
  if (f && typeof f === 'object' && !Array.isArray(f)) return f as Record<string, unknown>;
  return null;
}

function getSessionUpdate(frame: Record<string, unknown>): Record<string, unknown> | null {
  if (frame['method'] !== 'session/update') return null;
  const params = frame['params'];
  if (!params || typeof params !== 'object') return null;
  const update = (params as { update?: unknown }).update;
  if (!update || typeof update !== 'object' || Array.isArray(update)) return null;
  return update as Record<string, unknown>;
}

function readClaudeToolName(update: Record<string, unknown>): string {
  const meta = update['_meta'];
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return '';
  const claude = (meta as { claudeCode?: unknown }).claudeCode;
  if (!claude || typeof claude !== 'object' || Array.isArray(claude)) return '';
  const name = (claude as { toolName?: unknown }).toolName;
  return typeof name === 'string' ? name : '';
}

function isMcpSymphonyTool(name: string): boolean {
  return /^mcp__symphony__/.test(name);
}

export function summarize(
  identifier: string,
  filePath: string,
  mtimeMs: number,
  sizeBytes: number,
  entries: RunLogEntry[],
): SessionSummary {
  let attempts = 0;
  let firstTs: string | null = null;
  let lastTs: string | null = null;
  let toolCalls = 0;
  let toolFailures = 0;
  let steeringRequests = 0;
  let mcpCalls = 0;
  let markedDone = false;
  let agentFailureReason: string | null = null;
  let issueTitle: string | null = null;
  for (const e of entries) {
    if (typeof e.attempt === 'number' && e.attempt > attempts) attempts = e.attempt;
    if (typeof e.ts === 'string') {
      if (firstTs === null) firstTs = e.ts;
      lastTs = e.ts;
    }
    if (e.channel === 'system') {
      const event = typeof e['event'] === 'string' ? (e['event'] as string) : '';
      const fields =
        e['fields'] && typeof e['fields'] === 'object' && !Array.isArray(e['fields'])
          ? (e['fields'] as Record<string, unknown>)
          : null;
      if (event === 'attempt_started' && fields) {
        const t = fields['issue_title'];
        if (typeof t === 'string' && t.length > 0 && issueTitle === null) issueTitle = t;
      }
      if (event === 'attempt_ended' && fields) {
        const ok = fields['ok'];
        const reason = fields['reason'];
        if (ok === false && typeof reason === 'string') agentFailureReason = reason;
      }
    } else if (e.channel === 'acp') {
      const frame = getFrame(e);
      if (!frame) continue;
      const update = getSessionUpdate(frame);
      if (!update) continue;
      const kind = update['sessionUpdate'];
      if (kind === 'tool_call') {
        toolCalls++;
        const name = readClaudeToolName(update);
        if (isMcpSymphonyTool(name)) {
          mcpCalls++;
          if (name === 'mcp__symphony__request_human_steering') steeringRequests++;
          if (name === 'mcp__symphony__mark_done') markedDone = true;
        }
      } else if (kind === 'tool_call_update') {
        const status = update['status'];
        if (status === 'failed') toolFailures++;
        // mark_done arrives as a tool_call_update with status=completed in some adapters;
        // recognising it via _meta keeps the flag accurate regardless of which notification
        // carried the canonical "completed" event.
        const name = readClaudeToolName(update);
        if (name === 'mcp__symphony__mark_done' && status === 'completed') markedDone = true;
      }
    }
  }
  return {
    identifier,
    file_path: filePath,
    size_bytes: sizeBytes,
    last_modified: new Date(mtimeMs).toISOString(),
    line_count: entries.length,
    attempts,
    first_ts: firstTs,
    last_ts: lastTs,
    issue_title: issueTitle,
    tool_calls: toolCalls,
    tool_failures: toolFailures,
    steering_requests: steeringRequests,
    mcp_calls: mcpCalls,
    marked_done: markedDone,
    agent_failure_reason: agentFailureReason,
  };
}

/**
 * Scan `logsRoot` for `*.jsonl` run logs and return a per-session summary sorted by most
 * recent activity first. Files that can't be stat()ed or read are silently skipped — the
 * dashboard remains useful even if one log is corrupt.
 */
export async function listSessions(logsRoot: string | null): Promise<SessionSummary[]> {
  if (!logsRoot) return [];
  let names: string[];
  try {
    names = await readdir(logsRoot);
  } catch {
    return [];
  }
  const out: SessionSummary[] = [];
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    const filePath = path.join(logsRoot, name);
    try {
      const st = await stat(filePath);
      if (!st.isFile()) continue;
      const text = await readFile(filePath, 'utf8');
      const entries = parseRunLog(text);
      const ident = name.slice(0, -'.jsonl'.length);
      out.push(summarize(ident, filePath, st.mtimeMs, st.size, entries));
    } catch {
      // unreadable / vanished mid-scan — keep going
    }
  }
  out.sort((a, b) => b.last_modified.localeCompare(a.last_modified));
  return out;
}

/**
 * Load one session's full entry timeline. Returns `null` when the identifier is unsafe
 * (path traversal attempt) or the file is missing.
 */
export async function loadSession(
  logsRoot: string,
  identifier: string,
): Promise<{ identifier: string; entries: RunLogEntry[]; mtimeMs: number; size: number } | null> {
  if (!isSafeIdentifier(identifier)) return null;
  const filePath = path.join(logsRoot, `${identifier}.jsonl`);
  let st;
  try {
    st = await stat(filePath);
  } catch {
    return null;
  }
  if (!st.isFile()) return null;
  let text: string;
  try {
    text = await readFile(filePath, 'utf8');
  } catch {
    return null;
  }
  return { identifier, entries: parseRunLog(text), mtimeMs: st.mtimeMs, size: st.size };
}

// ─────────────────────────────────────────────────────────────────────────────
// Rendering. The history pages share the dashboard's color palette but live on
// their own routes; keep the CSS local so the dashboard's poll-driven shell
// doesn't have to know about them.
// ─────────────────────────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTimeShort(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatClockTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function durationSeconds(first: string | null, last: string | null): number | null {
  if (!first || !last) return null;
  const a = Date.parse(first);
  const b = Date.parse(last);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, (b - a) / 1000);
}

function formatDuration(seconds: number | null): string {
  if (seconds === null) return '';
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return rem === 0 ? `${m}m` : `${m}m${rem}s`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  return remM === 0 ? `${h}h` : `${h}h${remM}m`;
}

const HISTORY_CSS = `:root {
  color-scheme: dark;
  --inset: #0c0f15; --bench: #0f1115; --raised: #161a22; --chip: #20242c;
  --rule-soft: #1c2029; --rule-firm: #2a2e36;
  --dim: #6b7280; --muted: #9aa4b2; --base: #dfe2e7; --strong: #e6ebf2;
  --accent: #2a6df4;
  --run-bg: #1f3a26; --run-fg: #58d68d;
  --retry-bg: #3a2f1f; --retry-fg: #f0c060;
  --idle-bg: #20242c; --idle-fg: #9aa4b2;
  --await-bg: #1f2a36; --await-fg: #7fb5d4;
  --done-bg: #1c2a1f; --done-fg: #82c896;
  --err: #ff7676;
  --think-fg: #b39ddb;
}
* { box-sizing: border-box; }
html, body { background: var(--bench); color: var(--base); }
body {
  font: 14px/1.45 ui-sans-serif, system-ui, sans-serif;
  margin: 0; padding: 0;
  display: flex; flex-direction: column; min-height: 100vh;
}
main {
  width: 100%; max-width: 1080px; margin: 0 auto;
  padding: 1rem 1.5rem 2rem; flex: 1;
}
code, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.92em; }
.dim { color: var(--dim); }
.grow { flex: 1; }
a { color: var(--await-fg); }
a:hover { color: var(--strong); }
#header {
  display: flex; align-items: center; gap: 0.5rem;
  padding: 0.65rem 1.5rem;
  background: var(--bench); border-bottom: 1px solid var(--rule-firm);
  font-size: 13px;
  position: sticky; top: 0; z-index: 10;
}
#header .brand { font-weight: 600; color: var(--strong); letter-spacing: 0.01em; }
#header .rule { color: var(--dim); }
#header nav a {
  color: var(--muted); text-decoration: none; margin-right: 0.5rem;
}
#header nav a:hover, #header nav a.current { color: var(--strong); }
h1 {
  font-size: 1.05rem; font-weight: 500;
  margin: 0.6rem 0 0.6rem; padding-bottom: 0.35rem;
  border-bottom: 1px solid var(--rule-firm);
}
h2 {
  font-size: 0.95rem; font-weight: 500;
  margin: 1.4rem 0 0.45rem; padding-bottom: 0.3rem;
  border-bottom: 1px solid var(--rule-soft);
  color: var(--muted);
  letter-spacing: 0.02em;
}
.empty { padding: 0.5rem 0; color: var(--dim); }
.pill {
  display: inline-block; padding: 0.05rem 0.5rem; border-radius: 999px;
  font-size: 0.78em; line-height: 1.4;
  font-variant-numeric: tabular-nums;
  background: var(--chip); color: var(--muted);
}
.pill.done { background: var(--done-bg); color: var(--done-fg); }
.pill.err { background: #3a1f22; color: var(--err); }
.pill.steering { background: var(--await-bg); color: var(--await-fg); }
.pill.mcp { background: #1c2a3a; color: #8db5e3; }
.pill.fail { background: #3a1f22; color: var(--err); }

/* List page ──────────────────────────────────────────────────────────────── */
ul.sessions-history { list-style: none; padding: 0; margin: 0; }
ul.sessions-history li {
  padding: 0.5rem 0; border-bottom: 1px solid var(--rule-soft);
}
ul.sessions-history li:last-child { border-bottom: 0; }
.row-line-1 {
  display: flex; align-items: baseline; gap: 0.65rem; flex-wrap: wrap;
  font-variant-numeric: tabular-nums;
}
.row-line-1 .ident {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  color: var(--strong);
}
.row-line-1 .title {
  color: var(--base);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  flex: 1 1 12rem; min-width: 0;
}
.row-line-2 {
  display: flex; align-items: center; gap: 0.55rem; flex-wrap: wrap;
  font-size: 0.85em; color: var(--dim);
  margin-top: 0.15rem;
  font-variant-numeric: tabular-nums;
}
.row-line-2 .stat { display: inline-flex; gap: 0.25rem; align-items: baseline; }
.row-line-2 .stat .n { color: var(--base); }
.row-line-2 .stat.err .n { color: var(--err); }
.row-line-2 .stat.mcp .n { color: #8db5e3; }
.row-line-2 .open {
  margin-left: auto; color: var(--await-fg); text-decoration: none;
}
.row-line-2 .open:hover { color: var(--strong); }

/* Detail page ────────────────────────────────────────────────────────────── */
.meta-grid {
  display: grid; grid-template-columns: max-content 1fr;
  gap: 0.2rem 1rem;
  margin: 0 0 0.8rem;
  font-size: 0.92em;
}
.meta-grid dt { color: var(--dim); }
.meta-grid dd { margin: 0; color: var(--base); font-variant-numeric: tabular-nums; }
.meta-grid dd.ident { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: var(--strong); }

.attempt-section {
  margin: 1rem 0;
  padding: 0.45rem 0.7rem 0.65rem;
  background: var(--raised); border-radius: 6px;
}
.attempt-section header {
  display: flex; gap: 0.5rem; align-items: baseline;
  font-size: 0.9em; color: var(--muted);
  padding-bottom: 0.3rem; margin-bottom: 0.4rem;
  border-bottom: 1px solid var(--rule-firm);
  font-variant-numeric: tabular-nums;
}
.attempt-section header .label {
  color: var(--strong); letter-spacing: 0.04em;
  text-transform: uppercase; font-size: 0.78em;
}
.attempt-section header .stat { color: var(--dim); }
.attempt-section header .stat .n { color: var(--base); }

.entry {
  display: grid; grid-template-columns: 5.5rem 8.5rem 1fr;
  gap: 0.4rem 0.7rem;
  padding: 0.25rem 0;
  border-top: 1px dotted var(--rule-soft);
  font-variant-numeric: tabular-nums;
}
.entry:first-child { border-top: 0; }
.entry .ts { color: var(--dim); font-size: 0.82em; }
.entry .kind { color: var(--muted); font-size: 0.82em; letter-spacing: 0.02em; }
.entry .body { min-width: 0; }
.entry .body pre {
  margin: 0; padding: 0.35rem 0.55rem;
  background: var(--inset); border: 1px solid var(--rule-firm); border-radius: 3px;
  font: 12.5px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  white-space: pre-wrap; word-break: break-word;
  color: var(--muted);
  max-height: 24em; overflow: auto;
}
.entry .body details > summary {
  cursor: pointer; color: var(--dim); list-style: none;
  font-size: 0.85em; padding: 0.1rem 0;
}
.entry .body details > summary::-webkit-details-marker { display: none; }
.entry .body details > summary::before {
  content: "▸"; padding-right: 0.3rem; display: inline-block;
  transition: transform 180ms cubic-bezier(.22,1,.36,1);
  color: var(--dim);
}
.entry .body details[open] > summary::before { transform: rotate(90deg); }
.entry.system .body { color: var(--muted); }
.entry.system .kind { color: var(--retry-fg); }
.entry.system .body .event { color: var(--strong); font-weight: 500; }
.entry.system.attempt-started .kind { color: var(--run-fg); }
.entry.system.attempt-ended .kind { color: var(--done-fg); }
.entry.system.attempt-ended.failed .kind { color: var(--err); }
.entry.stderr .kind { color: var(--dim); }
.entry.stderr .body pre { color: var(--dim); }
.entry.hook .kind { color: var(--retry-fg); }
.entry.thought .kind { color: var(--think-fg); }
.entry.thought .body .text { color: var(--think-fg); font-style: italic; }
.entry.message .kind { color: var(--base); }
.entry.message .body .text { color: var(--base); }
.entry.tool-call .kind { color: var(--await-fg); }
.entry.tool-call .body .name {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  color: var(--strong);
}
.entry.tool-call.mcp .body .name { color: #8db5e3; }
.entry.tool-call.failed .kind { color: var(--err); }
.entry.tool-call .body .status { color: var(--dim); font-size: 0.85em; margin-left: 0.4rem; }
.entry.tool-call .body .status.failed { color: var(--err); }
.entry.tool-call .body .status.completed { color: var(--done-fg); }
.entry.prompt .kind { color: var(--strong); }
.entry.prompt .body .role { color: var(--dim); font-size: 0.82em; }
.entry.usage .kind { color: var(--dim); }
.entry.unparseable .kind { color: var(--err); }
.entry.unknown .kind { color: var(--dim); }

.detail-toolbar {
  display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap;
  margin: 0.4rem 0 0.6rem;
  font-size: 0.88em; color: var(--dim);
}
.detail-toolbar label { user-select: none; cursor: pointer; }
.detail-toolbar input[type="checkbox"] {
  vertical-align: middle; margin-right: 0.3rem;
}
.back-link { display: inline-block; margin-bottom: 0.3rem; }
`;

function renderHeader(currentPath: 'history' | 'dashboard'): string {
  return `<header id="header">
  <span class="brand">symphony</span>
  <span class="rule" aria-hidden="true">·</span>
  <nav aria-label="primary">
    <a href="/"${currentPath === 'dashboard' ? ' class="current"' : ''}>dashboard</a>
    <a href="/history"${currentPath === 'history' ? ' class="current"' : ''}>history</a>
  </nav>
</header>`;
}

function pageShell(opts: {
  title: string;
  current: 'history' | 'dashboard';
  body: string;
  extraScript?: string;
}): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(opts.title)}</title>
<style>${HISTORY_CSS}</style>
</head><body>
${renderHeader(opts.current)}
<main>
${opts.body}
</main>
${opts.extraScript ? `<script>${opts.extraScript}</script>` : ''}
</body></html>`;
}

export function renderHistoryListPage(opts: {
  logsRoot: string | null;
  sessions: SessionSummary[];
}): string {
  const { logsRoot, sessions } = opts;
  const heading = `<h1>history <span class="dim count">(${sessions.length})</span></h1>`;
  const rootLine = logsRoot
    ? `<p class="dim mono">${escapeHtml(logsRoot)}</p>`
    : `<p class="dim">no <code>logs.root</code> is configured — set it in <code>WORKFLOW.md</code> to capture run logs.</p>`;
  let body: string;
  if (sessions.length === 0) {
    body = `${heading}
${rootLine}
<p class="empty">no historical sessions yet. logs land here once symphony dispatches its first issue.</p>`;
  } else {
    const items = sessions.map((s) => renderSessionRow(s)).join('');
    body = `${heading}
${rootLine}
<ul class="sessions-history">${items}</ul>`;
  }
  return pageShell({ title: 'symphony · history', current: 'history', body });
}

function renderSessionRow(s: SessionSummary): string {
  const title = s.issue_title ?? '';
  const stats: string[] = [];
  stats.push(`<span class="stat"><span class="n">${s.attempts || 1}</span> attempt${s.attempts === 1 ? '' : 's'}</span>`);
  stats.push(`<span class="stat"><span class="n">${s.tool_calls}</span> tool${s.tool_calls === 1 ? '' : 's'}</span>`);
  if (s.tool_failures > 0) {
    stats.push(`<span class="stat err"><span class="n">${s.tool_failures}</span> failed</span>`);
  }
  if (s.mcp_calls > 0) {
    stats.push(`<span class="stat mcp"><span class="n">${s.mcp_calls}</span> mcp</span>`);
  }
  if (s.steering_requests > 0) {
    stats.push(`<span class="stat"><span class="n">${s.steering_requests}</span> steering</span>`);
  }
  const duration = formatDuration(durationSeconds(s.first_ts, s.last_ts));
  const pills: string[] = [];
  if (s.marked_done) pills.push('<span class="pill done">marked done</span>');
  if (s.agent_failure_reason) {
    pills.push(`<span class="pill fail" title="${escapeHtml(s.agent_failure_reason)}">last attempt failed</span>`);
  }
  return `<li>
  <div class="row-line-1">
    <strong class="ident">${escapeHtml(s.identifier)}</strong>
    ${pills.join(' ')}
    <span class="title">${escapeHtml(title)}</span>
  </div>
  <div class="row-line-2">
    <span title="${escapeHtml(s.last_modified)}">${escapeHtml(formatTimeShort(s.last_modified))}</span>
    <span class="dim">·</span>
    ${stats.join('<span class="dim">·</span>')}
    ${duration ? `<span class="dim">·</span><span class="stat"><span class="n">${escapeHtml(duration)}</span> elapsed</span>` : ''}
    <span class="dim">·</span>
    <span title="${s.size_bytes} bytes">${escapeHtml(formatBytes(s.size_bytes))}</span>
    <a class="open" href="/history/${encodeURIComponent(s.identifier)}">open →</a>
  </div>
</li>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Detail page: render every entry in chronological order, grouped by attempt.
// Entries are categorized into a small visual taxonomy:
//   prompt          — outbound session/prompt request
//   message         — inbound agent_message_chunk (text answer)
//   thought         — inbound agent_thought_chunk (reasoning)
//   tool-call       — inbound tool_call / tool_call_update (with status colouring)
//   usage           — inbound usage_update
//   acp-other       — anything else on the ACP channel
//   hook            — host-side hook stdout/stderr/result
//   stderr          — adapter stderr
//   system          — orchestrator lifecycle event
//   unparseable     — a line we couldn't JSON-decode (raw bytes preserved)
// ─────────────────────────────────────────────────────────────────────────────

interface ClassifiedEntry {
  cls: string;          // CSS class on the .entry row
  kindLabel: string;    // small label shown in the second column
  bodyHtml: string;     // already-escaped body markup
  entry: RunLogEntry;
}

function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + '…';
}

function extractText(content: unknown): string {
  if (!content || typeof content !== 'object' || Array.isArray(content)) return '';
  const c = content as Record<string, unknown>;
  if (c['type'] === 'text' && typeof c['text'] === 'string') return c['text'];
  return '';
}

function renderJsonDetails(label: string, value: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(value, null, 2);
  } catch {
    text = String(value);
  }
  return `<details><summary>${escapeHtml(label)}</summary><pre>${escapeHtml(text)}</pre></details>`;
}

function classifyEntry(entry: RunLogEntry): ClassifiedEntry {
  const channel = entry.channel;
  if (channel === 'system') {
    const event = typeof entry['event'] === 'string' ? (entry['event'] as string) : 'system';
    const fields = entry['fields'];
    let cls = 'system';
    if (event === 'attempt_started') cls += ' attempt-started';
    if (event === 'attempt_ended') {
      const ok = fields && typeof fields === 'object' && !Array.isArray(fields)
        ? (fields as Record<string, unknown>)['ok']
        : null;
      cls += ' attempt-ended' + (ok === false ? ' failed' : '');
    }
    let body = `<span class="event">${escapeHtml(event)}</span>`;
    if (fields && typeof fields === 'object' && !Array.isArray(fields)) {
      const summary = summarizeFields(fields as Record<string, unknown>);
      if (summary) body += ` <span class="dim">${escapeHtml(summary)}</span>`;
      body += renderJsonDetails('fields', fields);
    }
    return { cls, kindLabel: 'system', bodyHtml: body, entry };
  }
  if (channel === 'stderr') {
    const text = typeof entry['text'] === 'string' ? (entry['text'] as string) : '';
    return {
      cls: 'stderr',
      kindLabel: 'stderr',
      bodyHtml: `<pre>${escapeHtml(text)}</pre>`,
      entry,
    };
  }
  if (channel === 'hook') {
    const hook = typeof entry['hook'] === 'string' ? (entry['hook'] as string) : 'hook';
    const kind = typeof entry['kind'] === 'string' ? (entry['kind'] as string) : null;
    if (kind === 'result') {
      const exitCode = entry['exit_code'];
      const signal = entry['signal'];
      const timedOut = entry['timed_out'];
      const parts: string[] = [];
      if (exitCode !== null && exitCode !== undefined) parts.push(`exit=${escapeHtml(String(exitCode))}`);
      if (signal !== null && signal !== undefined) parts.push(`signal=${escapeHtml(String(signal))}`);
      if (timedOut) parts.push('timed out');
      const failed = exitCode !== 0 && exitCode !== null && exitCode !== undefined;
      return {
        cls: 'hook' + (failed || timedOut ? ' failed' : ''),
        kindLabel: `hook · ${hook}`,
        bodyHtml: `<span class="event">result</span> <span class="dim">${parts.join(' · ')}</span>`,
        entry,
      };
    }
    const stream = typeof entry['stream'] === 'string' ? (entry['stream'] as string) : 'stdout';
    const text = typeof entry['text'] === 'string' ? (entry['text'] as string) : '';
    return {
      cls: 'hook',
      kindLabel: `hook · ${hook} · ${stream}`,
      bodyHtml: `<pre>${escapeHtml(text)}</pre>`,
      entry,
    };
  }
  if (channel === 'acp') {
    const direction = entry['direction'] === 'host_to_vm' ? 'host_to_vm' : 'vm_to_host';
    const dirArrow = direction === 'host_to_vm' ? '→ vm' : '← vm';
    if (entry['kind'] === 'unparseable') {
      const raw = typeof entry['raw'] === 'string' ? (entry['raw'] as string) : '';
      return {
        cls: 'unparseable',
        kindLabel: `acp ${dirArrow}`,
        bodyHtml: `<span class="dim">(unparseable frame)</span><pre>${escapeHtml(raw)}</pre>`,
        entry,
      };
    }
    const frame = getFrame(entry);
    if (!frame) {
      return {
        cls: 'unknown',
        kindLabel: `acp ${dirArrow}`,
        bodyHtml: renderJsonDetails('frame', entry),
        entry,
      };
    }
    return classifyAcpFrame(frame, direction, dirArrow, entry);
  }
  return {
    cls: 'unknown',
    kindLabel: typeof channel === 'string' ? channel : 'entry',
    bodyHtml: renderJsonDetails('entry', entry),
    entry,
  };
}

function classifyAcpFrame(
  frame: Record<string, unknown>,
  direction: 'host_to_vm' | 'vm_to_host',
  dirArrow: string,
  entry: RunLogEntry,
): ClassifiedEntry {
  const method = typeof frame['method'] === 'string' ? (frame['method'] as string) : null;

  if (method === 'session/update') {
    const update = getSessionUpdate(frame);
    if (update) return classifySessionUpdate(update, entry);
  }

  if (method === 'session/prompt') {
    const params = frame['params'];
    let promptText = '';
    if (params && typeof params === 'object' && !Array.isArray(params)) {
      const promptArr = (params as { prompt?: unknown }).prompt;
      if (Array.isArray(promptArr)) {
        for (const block of promptArr) {
          if (block && typeof block === 'object') {
            const t = (block as { type?: unknown; text?: unknown });
            if (t.type === 'text' && typeof t.text === 'string') promptText += t.text;
          }
        }
      }
    }
    return {
      cls: 'prompt',
      kindLabel: 'prompt',
      bodyHtml: `<div class="role">human → agent</div><pre>${escapeHtml(promptText || JSON.stringify(params))}</pre>`,
      entry,
    };
  }

  if (method === 'session/cancel') {
    return {
      cls: 'system',
      kindLabel: `acp ${dirArrow}`,
      bodyHtml: `<span class="event">session/cancel</span>`,
      entry,
    };
  }

  if (method === 'initialize' || method === 'session/new') {
    return {
      cls: 'system',
      kindLabel: `acp ${dirArrow}`,
      bodyHtml: `<span class="event">${escapeHtml(method)}</span>${renderJsonDetails('params', frame['params'])}`,
      entry,
    };
  }

  // JSON-RPC response without a method — typically the reply to session/prompt etc.
  if (method === null && 'result' in frame) {
    const id = frame['id'];
    const result = frame['result'];
    let kind = `acp ${dirArrow}`;
    let bodyHead = '<span class="event">result</span>';
    if (result && typeof result === 'object' && !Array.isArray(result)) {
      const stopReason = (result as { stopReason?: unknown }).stopReason;
      if (typeof stopReason === 'string') {
        kind = 'turn result';
        bodyHead = `<span class="event">stop_reason</span> <span class="dim">${escapeHtml(stopReason)}</span>`;
      }
    }
    return {
      cls: 'acp-other',
      kindLabel: kind,
      bodyHtml: `${bodyHead}${id !== undefined ? ` <span class="dim">id=${escapeHtml(String(id))}</span>` : ''}${renderJsonDetails('result', result)}`,
      entry,
    };
  }

  if (method === null && 'error' in frame) {
    const err = frame['error'];
    return {
      cls: 'unparseable',
      kindLabel: `acp ${dirArrow}`,
      bodyHtml: `<span class="event">error</span>${renderJsonDetails('error', err)}`,
      entry,
    };
  }

  return {
    cls: 'unknown',
    kindLabel: method ? `acp · ${method}` : `acp ${dirArrow}`,
    bodyHtml: renderJsonDetails('frame', frame),
    entry,
  };
}

function classifySessionUpdate(update: Record<string, unknown>, entry: RunLogEntry): ClassifiedEntry {
  const kind = typeof update['sessionUpdate'] === 'string' ? (update['sessionUpdate'] as string) : 'session_update';
  switch (kind) {
    case 'agent_message_chunk': {
      const text = extractText(update['content']);
      return {
        cls: 'message',
        kindLabel: 'agent text',
        bodyHtml: `<div class="text">${escapeHtml(text)}</div>`,
        entry,
      };
    }
    case 'agent_thought_chunk': {
      const text = extractText(update['content']);
      return {
        cls: 'thought',
        kindLabel: 'thinking',
        bodyHtml: `<div class="text">${escapeHtml(text)}</div>`,
        entry,
      };
    }
    case 'tool_call':
    case 'tool_call_update': {
      const name = readClaudeToolName(update) ||
        (typeof update['title'] === 'string' ? (update['title'] as string) : '') ||
        (typeof update['kind'] === 'string' ? (update['kind'] as string) : '') ||
        'tool';
      const status = typeof update['status'] === 'string' ? (update['status'] as string) : '';
      const failed = status === 'failed';
      const mcp = isMcpSymphonyTool(name);
      const cls = ['tool-call'];
      if (mcp) cls.push('mcp');
      if (failed) cls.push('failed');
      const statusHtml = status
        ? `<span class="status ${escapeHtml(status)}">${escapeHtml(status)}</span>`
        : '';
      const snippet = clip(firstTextSnippet(update['content']), 240);
      const args = update['input'] ?? update['rawInput'];
      const head = `<span class="name">${escapeHtml(name)}</span>${statusHtml}${
        kind === 'tool_call_update' ? '' : ' <span class="dim">started</span>'
      }`;
      let body = head;
      if (snippet) body += `<div class="text dim">${escapeHtml(snippet)}</div>`;
      if (args !== undefined) body += renderJsonDetails('input', args);
      const fullContent = update['content'];
      if (fullContent !== undefined) body += renderJsonDetails('content', fullContent);
      return {
        cls: cls.join(' '),
        kindLabel: mcp ? 'mcp tool' : kind === 'tool_call' ? 'tool call' : 'tool update',
        bodyHtml: body,
        entry,
      };
    }
    case 'plan': {
      const entriesArr = update['entries'];
      return {
        cls: 'system',
        kindLabel: 'plan',
        bodyHtml: `<span class="event">plan</span>${renderJsonDetails('entries', entriesArr ?? update)}`,
        entry,
      };
    }
    case 'usage_update': {
      const used = update['used'];
      const size = update['size'];
      return {
        cls: 'usage',
        kindLabel: 'usage',
        bodyHtml: `<span class="dim">used=${escapeHtml(String(used ?? '?'))} / size=${escapeHtml(String(size ?? '?'))}</span>`,
        entry,
      };
    }
    default:
      return {
        cls: 'acp-other',
        kindLabel: kind,
        bodyHtml: renderJsonDetails('update', update),
        entry,
      };
  }
}

function firstTextSnippet(content: unknown): string {
  if (!Array.isArray(content)) return '';
  for (const item of content) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const inner =
      obj['type'] === 'content' && obj['content'] && typeof obj['content'] === 'object' && !Array.isArray(obj['content'])
        ? (obj['content'] as Record<string, unknown>)
        : obj;
    if (inner['type'] === 'text' && typeof inner['text'] === 'string') {
      return (inner['text'] as string).replace(/\s+/g, ' ').trim();
    }
  }
  return '';
}

function summarizeFields(fields: Record<string, unknown>): string {
  const out: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v === null || v === undefined) continue;
    if (typeof v === 'object') continue;
    out.push(`${k}=${String(v)}`);
  }
  return out.join(' · ');
}

export function renderSessionDetailPage(opts: {
  identifier: string;
  entries: RunLogEntry[];
  mtimeMs: number;
  size: number;
  summary: SessionSummary;
}): string {
  const { identifier, entries, summary } = opts;
  const groups = new Map<number, ClassifiedEntry[]>();
  const order: number[] = [];
  for (const e of entries) {
    const attempt = typeof e.attempt === 'number' ? e.attempt : 0;
    if (!groups.has(attempt)) {
      groups.set(attempt, []);
      order.push(attempt);
    }
    groups.get(attempt)!.push(classifyEntry(e));
  }
  order.sort((a, b) => a - b);

  const totalLines = entries.length;

  const meta = `<dl class="meta-grid">
  <dt>identifier</dt><dd class="ident">${escapeHtml(identifier)}</dd>
  ${summary.issue_title ? `<dt>title</dt><dd>${escapeHtml(summary.issue_title)}</dd>` : ''}
  <dt>log file</dt><dd class="mono">${escapeHtml(opts.entries[0]?.['issue_identifier'] as string ?? identifier)}.jsonl <span class="dim">(${escapeHtml(formatBytes(opts.size))}, ${totalLines} line${totalLines === 1 ? '' : 's'})</span></dd>
  <dt>last modified</dt><dd>${escapeHtml(formatTimeShort(new Date(opts.mtimeMs).toISOString()))}</dd>
  ${summary.first_ts ? `<dt>first event</dt><dd>${escapeHtml(formatTimeShort(summary.first_ts))}</dd>` : ''}
  ${summary.last_ts ? `<dt>last event</dt><dd>${escapeHtml(formatTimeShort(summary.last_ts))}</dd>` : ''}
  <dt>tools</dt><dd>${summary.tool_calls} (${summary.tool_failures} failed) · ${summary.mcp_calls} mcp · ${summary.steering_requests} steering</dd>
  <dt>outcome</dt><dd>${summary.marked_done ? '<span class="pill done">marked done</span>' : summary.agent_failure_reason ? `<span class="pill fail">${escapeHtml(summary.agent_failure_reason)}</span>` : '<span class="pill">unfinished</span>'}</dd>
</dl>`;

  const toolbar = `<div class="detail-toolbar">
  <label><input type="checkbox" data-filter="stderr" checked> stderr</label>
  <label><input type="checkbox" data-filter="hook" checked> hooks</label>
  <label><input type="checkbox" data-filter="system" checked> system</label>
  <label><input type="checkbox" data-filter="usage" checked> usage</label>
  <span class="grow"></span>
  <a class="dim mono" href="/api/v1/history/${encodeURIComponent(identifier)}.jsonl">raw jsonl</a>
</div>`;

  const sections = order.map((attempt) => {
    const list = groups.get(attempt) ?? [];
    const tools = list.filter((e) => e.cls.startsWith('tool-call')).length;
    const failed = list.filter((e) => e.cls.includes('tool-call') && e.cls.includes('failed')).length;
    const thoughts = list.filter((e) => e.cls === 'thought').length;
    const rows = list.map((c) => renderEntry(c)).join('');
    return `<section class="attempt-section" data-attempt="${attempt}">
  <header>
    <span class="label">attempt ${attempt}</span>
    <span class="stat"><span class="n">${list.length}</span> events</span>
    <span class="dim">·</span>
    <span class="stat"><span class="n">${tools}</span> tool call${tools === 1 ? '' : 's'}</span>
    ${failed > 0 ? `<span class="dim">·</span><span class="stat" style="color:var(--err)"><span class="n">${failed}</span> failed</span>` : ''}
    <span class="dim">·</span>
    <span class="stat"><span class="n">${thoughts}</span> thinking</span>
  </header>
  ${rows || '<p class="empty">(no events)</p>'}
</section>`;
  }).join('');

  const body = `<a class="back-link dim" href="/history">← all sessions</a>
<h1>${escapeHtml(summary.issue_title || identifier)}</h1>
${meta}
${toolbar}
${sections || '<p class="empty">log file is empty.</p>'}`;

  const script = `
const checkboxes = document.querySelectorAll('input[data-filter]');
function applyFilters() {
  const hidden = new Set();
  for (const cb of checkboxes) {
    if (!cb.checked) hidden.add(cb.dataset.filter);
  }
  for (const row of document.querySelectorAll('.entry')) {
    let shouldHide = false;
    for (const h of hidden) {
      if (row.classList.contains(h) || (h === 'usage' && row.classList.contains('usage'))) {
        shouldHide = true; break;
      }
    }
    row.style.display = shouldHide ? 'none' : '';
  }
}
for (const cb of checkboxes) cb.addEventListener('change', applyFilters);
applyFilters();
`;

  return pageShell({ title: `symphony · ${identifier}`, current: 'history', body, extraScript: script });
}

function renderEntry(c: ClassifiedEntry): string {
  const ts = formatClockTime(typeof c.entry.ts === 'string' ? c.entry.ts : null);
  const fullTs = typeof c.entry.ts === 'string' ? c.entry.ts : '';
  return `<div class="entry ${c.cls}">
  <span class="ts" title="${escapeHtml(fullTs)}">${escapeHtml(ts)}</span>
  <span class="kind">${escapeHtml(c.kindLabel)}</span>
  <div class="body">${c.bodyHtml}</div>
</div>`;
}
