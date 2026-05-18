// HTTP server extension (SPEC §13.7) plus the local-tracker UI for creating issues and
// watching status. The UI polls `/api/v1/state` so no SSE/WebSocket infrastructure is
// needed.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdir, readdir, readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Orchestrator } from './orchestrator.js';
import { sanitizeWorkspaceKey } from './workspace.js';
import { log } from './logging.js';

function jsonResponse(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('content-length', Buffer.byteLength(text));
  res.end(text);
}

function methodNotAllowed(res: ServerResponse): void {
  jsonResponse(res, 405, { error: { code: 'method_not_allowed', message: 'method not allowed' } });
}

function notFound(res: ServerResponse, code = 'not_found', message = 'not found'): void {
  jsonResponse(res, 404, { error: { code, message } });
}

function badRequest(res: ServerResponse, message: string): void {
  jsonResponse(res, 400, { error: { code: 'bad_request', message } });
}

async function readJsonBody(req: IncomingMessage, maxBytes = 1_000_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        req.destroy();
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (text.length === 0) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch (err) {
        reject(new Error(`invalid JSON: ${(err as Error).message}`));
      }
    });
    req.on('error', reject);
  });
}

// Used by the dashboard form. The local tracker stores issues at:
//   <tracker.root>/<state>/<identifier>.md
// with YAML front matter. Identifier sanitization re-uses the workspace key rules so the
// file name is always safe across the rest of the orchestrator.
async function writeIssueFile(input: {
  trackerRoot: string;
  identifier: string;
  state: string;
  title: string;
  description?: string;
  priority?: number | null;
  labels?: string[];
  blocked_by?: string[];
}): Promise<{ path: string; identifier: string; state: string }> {
  const ident = sanitizeWorkspaceKey(input.identifier);
  if (!ident) throw new Error('identifier must contain at least one allowed character');
  const stateDir = path.join(input.trackerRoot, input.state);
  await mkdir(stateDir, { recursive: true });
  const filePath = path.join(stateDir, `${ident}.md`);
  try {
    await stat(filePath);
    throw new Error(`issue ${ident} already exists at ${filePath}`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const now = new Date().toISOString();
  const fm: Record<string, unknown> = {
    id: ident,
    identifier: ident,
    title: input.title,
    created_at: now,
    updated_at: now,
  };
  if (typeof input.priority === 'number') fm.priority = input.priority;
  if (input.labels && input.labels.length > 0) fm.labels = input.labels;
  if (input.blocked_by && input.blocked_by.length > 0) fm.blocked_by = input.blocked_by;

  const yamlLines = ['---'];
  for (const [k, v] of Object.entries(fm)) {
    if (Array.isArray(v)) {
      yamlLines.push(`${k}: [${v.map((x) => JSON.stringify(x)).join(', ')}]`);
    } else if (typeof v === 'string') {
      yamlLines.push(`${k}: ${JSON.stringify(v)}`);
    } else {
      yamlLines.push(`${k}: ${String(v)}`);
    }
  }
  yamlLines.push('---', '');
  const body = (input.description ?? '').trim();
  const content = yamlLines.join('\n') + (body.length > 0 ? body + '\n' : '');
  await writeFile(filePath, content, 'utf8');
  return { path: filePath, identifier: ident, state: input.state };
}

// Browse current issues directly from disk so the UI can show items that are neither
// currently running nor in the retry queue.
async function listIssuesFromDisk(trackerRoot: string): Promise<Array<{
  identifier: string;
  state: string;
  title: string;
}>> {
  const out: Array<{ identifier: string; state: string; title: string }> = [];
  let entries: string[];
  try {
    entries = await readdir(trackerRoot);
  } catch {
    return out;
  }
  for (const stateDir of entries) {
    const dirPath = path.join(trackerRoot, stateDir);
    let st;
    try {
      st = await stat(dirPath);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    let files: string[];
    try {
      files = await readdir(dirPath);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith('.md')) continue;
      const filePath = path.join(dirPath, f);
      let text: string;
      try {
        text = await readFile(filePath, 'utf8');
      } catch {
        continue;
      }
      let title = f.slice(0, -3);
      const titleMatch = /^---[\s\S]*?\ntitle:\s*(.+)\n[\s\S]*?---/m.exec(text);
      if (titleMatch) {
        title = titleMatch[1]!.trim().replace(/^["'](.*)["']$/, '$1');
      }
      out.push({ identifier: f.slice(0, -3), state: stateDir, title });
    }
  }
  out.sort((a, b) => a.identifier.localeCompare(b.identifier));
  return out;
}

function renderDashboardHtml(opts: { trackerRoot: string; activeStates: string[]; terminalStates: string[] }): string {
  const allStates = Array.from(new Set([...opts.activeStates, ...opts.terminalStates]));
  const stateOptions = allStates.map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('');
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Symphony</title>
<style>
:root { color-scheme: dark; }
body { font: 14px ui-sans-serif, system-ui, sans-serif; padding: 1.5rem; max-width: 1100px; margin: 0 auto; background: #0f1115; color: #dfe2e7; }
h1 { margin-top: 0; font-size: 1.3rem; }
h2 { font-size: 1rem; border-bottom: 1px solid #2a2e36; padding-bottom: 0.4rem; margin-top: 2rem; }
form.create { display: grid; grid-template-columns: max-content 1fr; gap: 0.5rem 1rem; align-items: center; background: #161a22; padding: 1rem; border-radius: 8px; }
form.create label { color: #9aa4b2; }
form.create input, form.create select, form.create textarea { background: #0c0f15; color: #e6ebf2; border: 1px solid #2a2e36; padding: 0.4rem 0.6rem; border-radius: 4px; font: inherit; width: 100%; box-sizing: border-box; }
form.create textarea { min-height: 80px; resize: vertical; }
form.create button { grid-column: 2; justify-self: start; background: #2a6df4; color: white; border: 0; padding: 0.5rem 1rem; border-radius: 4px; font: inherit; cursor: pointer; }
form.create .msg { grid-column: 1 / span 2; min-height: 1.2em; color: #9aa4b2; }
form.create .msg.err { color: #ff7676; }
form.create .msg.ok { color: #58d68d; }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 0.4rem 0.6rem; border-bottom: 1px solid #1c2029; font-variant-numeric: tabular-nums; }
th { color: #9aa4b2; font-weight: 500; }
.pill { display: inline-block; padding: 0.1rem 0.5rem; border-radius: 999px; font-size: 0.85em; }
.pill.running { background: #1f3a26; color: #58d68d; }
.pill.retrying { background: #3a2f1f; color: #f0c060; }
.pill.idle { background: #20242c; color: #9aa4b2; }
small.dim { color: #6b7280; }
button.refresh { background: #20242c; color: #dfe2e7; border: 1px solid #2a2e36; padding: 0.3rem 0.7rem; border-radius: 4px; cursor: pointer; font: inherit; margin-left: 0.5rem; }
</style>
</head><body>
<h1>Symphony <small class="dim">— tracker.root = ${escapeHtml(opts.trackerRoot)}</small></h1>

<h2>Create issue</h2>
<form class="create" id="create-form">
  <label for="identifier">Identifier</label>
  <input id="identifier" name="identifier" required placeholder="ABC-42" />
  <label for="title">Title</label>
  <input id="title" name="title" required />
  <label for="state">State</label>
  <select id="state" name="state">${stateOptions}</select>
  <label for="priority">Priority</label>
  <input id="priority" name="priority" type="number" min="0" max="10" placeholder="2" />
  <label for="labels">Labels (comma-separated)</label>
  <input id="labels" name="labels" placeholder="bug, urgent" />
  <label for="description">Description</label>
  <textarea id="description" name="description" placeholder="What needs to be done?"></textarea>
  <button type="submit">Create issue</button>
  <div class="msg" id="create-msg"></div>
</form>

<h2>Active sessions <button class="refresh" onclick="refresh()" type="button">Refresh now</button></h2>
<div id="running-block"><small class="dim">Loading…</small></div>

<h2>Retry queue</h2>
<div id="retry-block"><small class="dim">Loading…</small></div>

<h2>Totals</h2>
<div id="totals-block"><small class="dim">Loading…</small></div>

<h2>All known issues</h2>
<div id="issues-block"><small class="dim">Loading…</small></div>

<script>
const $ = (id) => document.getElementById(id);
function fmtDate(s) { if (!s) return '—'; try { return new Date(s).toLocaleTimeString(); } catch { return s; } }
function escape(s) { const d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }

async function refresh() {
  try {
    const [state, issues] = await Promise.all([
      fetch('/api/v1/state').then(r => r.json()),
      fetch('/api/v1/issues').then(r => r.json()),
    ]);
    renderRunning(state.running);
    renderRetry(state.retrying);
    renderTotals(state.codex_totals, state.rate_limits);
    renderIssues(issues.issues || [], state.running, state.retrying);
  } catch (err) {
    console.error(err);
  }
}

function renderRunning(rows) {
  const el = $('running-block');
  if (!rows.length) { el.innerHTML = '<small class="dim">No active sessions.</small>'; return; }
  el.innerHTML = '<table><thead><tr><th>Issue</th><th>State</th><th>Turn</th><th>Started</th><th>Last event</th><th>Tokens</th></tr></thead><tbody>' +
    rows.map(r => '<tr>' +
      '<td><strong>' + escape(r.issue_identifier) + '</strong></td>' +
      '<td><span class="pill running">' + escape(r.state) + '</span></td>' +
      '<td>' + r.turn_count + '</td>' +
      '<td><small class="dim">' + fmtDate(r.started_at) + '</small></td>' +
      '<td><small>' + escape(r.last_event || '') + '</small></td>' +
      '<td>' + (r.tokens.total_tokens || 0) + '</td>' +
      '</tr>').join('') + '</tbody></table>';
}

function renderRetry(rows) {
  const el = $('retry-block');
  if (!rows.length) { el.innerHTML = '<small class="dim">No retries scheduled.</small>'; return; }
  el.innerHTML = '<table><thead><tr><th>Issue</th><th>Attempt</th><th>Due</th><th>Last error</th></tr></thead><tbody>' +
    rows.map(r => '<tr>' +
      '<td><strong>' + escape(r.issue_identifier) + '</strong></td>' +
      '<td>' + r.attempt + '</td>' +
      '<td><small class="dim">' + fmtDate(r.due_at) + '</small></td>' +
      '<td><small>' + escape(r.error || '') + '</small></td>' +
      '</tr>').join('') + '</tbody></table>';
}

function renderTotals(totals, rate) {
  const el = $('totals-block');
  if (!totals) { el.innerHTML = '<small class="dim">No totals yet.</small>'; return; }
  el.innerHTML = '<div>Input ' + (totals.input_tokens || 0) +
    ', output ' + (totals.output_tokens || 0) +
    ', total ' + (totals.total_tokens || 0) +
    ' tokens — ' + Math.round(totals.seconds_running || 0) + 's runtime.' +
    (rate ? ' <small class="dim">rate limits attached</small>' : '') + '</div>';
}

function renderIssues(issues, running, retrying) {
  const el = $('issues-block');
  if (!issues.length) { el.innerHTML = '<small class="dim">No issues on disk.</small>'; return; }
  const runIds = new Set(running.map(r => r.issue_identifier));
  const retryIds = new Set(retrying.map(r => r.issue_identifier));
  el.innerHTML = '<table><thead><tr><th>Identifier</th><th>State</th><th>Title</th><th>Activity</th></tr></thead><tbody>' +
    issues.map(i => {
      let pill = '<span class="pill idle">idle</span>';
      if (runIds.has(i.identifier)) pill = '<span class="pill running">running</span>';
      else if (retryIds.has(i.identifier)) pill = '<span class="pill retrying">retry queued</span>';
      return '<tr>' +
        '<td>' + escape(i.identifier) + '</td>' +
        '<td>' + escape(i.state) + '</td>' +
        '<td>' + escape(i.title) + '</td>' +
        '<td>' + pill + '</td>' +
      '</tr>';
    }).join('') + '</tbody></table>';
}

$('create-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const msg = $('create-msg');
  msg.className = 'msg';
  msg.textContent = 'Creating…';
  const labels = $('labels').value.split(',').map(s => s.trim()).filter(Boolean);
  const priorityRaw = $('priority').value.trim();
  const body = {
    identifier: $('identifier').value.trim(),
    title: $('title').value.trim(),
    state: $('state').value,
    description: $('description').value,
    labels,
    priority: priorityRaw === '' ? null : Number(priorityRaw),
  };
  try {
    const res = await fetch('/api/v1/issues', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message || ('HTTP ' + res.status));
    msg.className = 'msg ok';
    msg.textContent = 'Created ' + data.identifier + ' at ' + data.path;
    $('create-form').reset();
    refresh();
    fetch('/api/v1/refresh', { method: 'POST' }).catch(() => {});
  } catch (err) {
    msg.className = 'msg err';
    msg.textContent = err.message;
  }
});

refresh();
setInterval(refresh, 2000);
</script>
</body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export interface HttpServerOptions {
  port: number;
  host: string;
  /** Returns the current tracker root and state lists. Wired to the orchestrator's live cfg. */
  getTrackerView: () => { trackerRoot: string | null; activeStates: string[]; terminalStates: string[] };
}

// Resolves once the server has either bound the requested port or rejected with the bind
// error so CLI startup can surface EADDRINUSE / EACCES instead of an unhandled rejection.
export async function startHttpServer(
  orch: Orchestrator,
  opts: HttpServerOptions,
): Promise<{ close: () => Promise<void> }> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handleRequest(req, res, orch, opts).catch((err) => {
      log.error('http handler error', { error: (err as Error).message });
      try {
        jsonResponse(res, 500, {
          error: { code: 'internal_error', message: (err as Error).message },
        });
      } catch {
        /* response already started */
      }
    });
  });
  server.on('clientError', (err, socket) => {
    log.debug('http client error', { error: (err as Error).message });
    try {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    } catch {
      /* socket may already be closed */
    }
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
      server.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : opts.port;
      log.info('http server listening', { host: opts.host, port });
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(opts.port, opts.host);
  });

  // After bind succeeds, install a permanent error handler so later runtime errors
  // (sockets resetting, ENOTCONN, etc.) are logged rather than crashing the process.
  server.on('error', (err) => {
    log.warn('http server error', { error: (err as Error).message });
  });

  return {
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  orch: Orchestrator,
  opts: HttpServerOptions,
): Promise<void> {
  // URL parsing inside the handler so a malformed Host header doesn't crash the listener.
  let pathname: string;
  try {
    const url = new URL(req.url ?? '/', 'http://symphony.local');
    pathname = url.pathname;
  } catch {
    return badRequest(res, 'invalid request URL');
  }
  const method = (req.method ?? 'GET').toUpperCase();
  const view = opts.getTrackerView();

  if (pathname === '/') {
    if (method !== 'GET') return methodNotAllowed(res);
    const html = renderDashboardHtml({
      trackerRoot: view.trackerRoot ?? '(unset)',
      activeStates: view.activeStates,
      terminalStates: view.terminalStates,
    });
    res.statusCode = 200;
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(html);
    return;
  }
  if (pathname === '/api/v1/state') {
    if (method !== 'GET') return methodNotAllowed(res);
    return jsonResponse(res, 200, orch.snapshot());
  }
  if (pathname === '/api/v1/refresh') {
    if (method !== 'POST') return methodNotAllowed(res);
    const status = orch.triggerRefresh();
    return jsonResponse(res, 202, {
      ...status,
      requested_at: new Date().toISOString(),
      operations: ['poll', 'reconcile'],
    });
  }
  if (pathname === '/api/v1/issues') {
    if (method === 'GET') {
      const root = view.trackerRoot;
      if (!root) return jsonResponse(res, 200, { issues: [] });
      const issues = await listIssuesFromDisk(root);
      return jsonResponse(res, 200, { issues });
    }
    if (method === 'POST') {
      const root = view.trackerRoot;
      if (!root) return badRequest(res, 'tracker.root not configured');
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        return badRequest(res, (err as Error).message);
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return badRequest(res, 'body must be a JSON object');
      }
      const b = body as Record<string, unknown>;
      const identifier = typeof b.identifier === 'string' ? b.identifier.trim() : '';
      const title = typeof b.title === 'string' ? b.title.trim() : '';
      const state = typeof b.state === 'string' ? b.state.trim() : '';
      if (!identifier) return badRequest(res, 'identifier is required');
      if (!title) return badRequest(res, 'title is required');
      if (!state) return badRequest(res, 'state is required');
      // Restrict `state` to one of the configured active/terminal states. Anything else
      // (or values containing path separators / `..`) is rejected so the request cannot
      // escape the tracker root via `path.join`.
      const allowedStates = new Set([...view.activeStates, ...view.terminalStates]);
      if (!allowedStates.has(state)) {
        return badRequest(res, `state must be one of: ${[...allowedStates].join(', ') || '<none configured>'}`);
      }
      const description = typeof b.description === 'string' ? b.description : undefined;
      const priority =
        typeof b.priority === 'number' && Number.isFinite(b.priority) ? b.priority : null;
      const labels = Array.isArray(b.labels)
        ? b.labels.filter((x): x is string => typeof x === 'string')
        : [];
      const blockedBy = Array.isArray(b.blocked_by)
        ? b.blocked_by.filter((x): x is string => typeof x === 'string')
        : [];
      try {
        const created = await writeIssueFile({
          trackerRoot: root,
          identifier,
          title,
          state,
          description,
          priority,
          labels,
          blocked_by: blockedBy,
        });
        log.info('issue created via http', { identifier: created.identifier, state: created.state });
        return jsonResponse(res, 201, created);
      } catch (err) {
        return jsonResponse(res, 409, {
          error: { code: 'create_failed', message: (err as Error).message },
        });
      }
    }
    return methodNotAllowed(res);
  }
  const m = /^\/api\/v1\/([^/]+)$/.exec(pathname);
  if (m) {
    if (method !== 'GET') return methodNotAllowed(res);
    const identifier = decodeURIComponent(m[1]!);
    const detail = orch.detailByIdentifier(identifier);
    if (!detail) return notFound(res, 'issue_not_found', `issue ${identifier} is not tracked`);
    return jsonResponse(res, 200, detail);
  }
  notFound(res);
}
