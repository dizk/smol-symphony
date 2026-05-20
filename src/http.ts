// HTTP server extension (SPEC §13.7) plus the local-tracker UI for creating issues and
// watching status. The UI polls `/api/v1/state` so no SSE/WebSocket infrastructure is
// needed.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { Orchestrator } from './orchestrator.js';
import { log } from './logging.js';
import type { McpRegistry } from './mcp.js';
import { writeIssueFile } from './issues.js';
import type { IssueTracker } from './trackers/types.js';
import type { StateConfig } from './types.js';

// Compact view of the declared per-state config used by the dashboard. The view-builder
// in src/bin/symphony.ts derives this from `cfg.states` on every request so a workflow
// reload (which mutates the live config in place) is reflected without rebinding the
// server. Order is the workflow declaration order — operators get state columns and
// approve/discard targets in the sequence they wrote them in `states:`.
export interface StateView {
  name: string;
  role: 'active' | 'terminal' | 'holding';
}

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

// Cross-site form POSTs are "simple" CORS requests that bypass preflight, so an
// unauthenticated endpoint that accepts form-encoded bodies is CSRFable from any
// origin. Steering reply uses this check (in addition to requiring HX-Request) to
// reject form bodies whose Origin doesn't match the Host the request hit.
//
// We treat the request as same-origin if either:
//   • An Origin header is present and its host:port equals the Host header (the
//     normal browser case), or
//   • There is no Origin header at all AND no Referer header (curl, internal calls,
//     non-browser tools). Browsers always send Origin on cross-origin form POSTs.
function isSameOriginRequest(req: IncomingMessage): boolean {
  const host = (req.headers['host'] ?? '').toString().trim();
  const origin = (req.headers['origin'] ?? '').toString().trim();
  if (origin) {
    try {
      const parsed = new URL(origin);
      return parsed.host === host;
    } catch {
      return false;
    }
  }
  // No Origin header — only trust if there's no Referer either (a real browser
  // form POST sets at least one).
  return !(req.headers['referer'] && req.headers['referer'].length > 0);
}

// HTMX's default response handling does not swap content on 4xx/5xx responses, so
// returning a 4xx with an HTML partial silently leaves the panel stale. For HTMX
// callers we therefore return 200 with the attention partial plus a one-line error
// banner; the operator's textarea text survives via hx-preserve. JSON callers still
// get the appropriate status code and a structured error.
async function htmxOrJsonError(
  res: ServerResponse,
  isHtmx: boolean,
  orch: Orchestrator,
  view: ReturnType<HttpServerOptions['getTrackerView']>,
  jsonStatus: number,
  code: string,
  message: string,
): Promise<void> {
  if (isHtmx) {
    const p = await gatherPartialInputs(orch, view);
    res.statusCode = 200;
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.end(renderAttentionPartial(p, { errorMessage: message }));
    return;
  }
  jsonResponse(res, jsonStatus, { error: { code, message } });
}

async function readTextBody(req: IncomingMessage, maxBytes = 1_000_000): Promise<string> {
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
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// Browse current issues directly from disk so the UI can show items that are neither
// currently running nor in the retry queue. Triage entries additionally surface the
// `proposed_by` / `proposed_at` front-matter so the dashboard can show provenance for
// agent-authored proposals — fields are optional and null for hand-written issues.
async function listIssuesFromDisk(trackerRoot: string): Promise<Array<{
  identifier: string;
  state: string;
  title: string;
  proposed_by: string | null;
  proposed_at: string | null;
}>> {
  const out: Array<{
    identifier: string;
    state: string;
    title: string;
    proposed_by: string | null;
    proposed_at: string | null;
  }> = [];
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
      const proposed_by = matchFrontMatterString(text, 'proposed_by');
      const proposed_at = matchFrontMatterString(text, 'proposed_at');
      out.push({ identifier: f.slice(0, -3), state: stateDir, title, proposed_by, proposed_at });
    }
  }
  out.sort((a, b) => a.identifier.localeCompare(b.identifier));
  return out;
}

// Read a single string-valued key from the YAML front-matter block at the top of the file.
// Mirrors the cheap regex approach used for `title` rather than a full YAML parse — the
// dashboard only needs the value for display, and the local tracker's reader (which uses
// the real YAML parser) is still authoritative for dispatch.
function matchFrontMatterString(text: string, key: string): string | null {
  const re = new RegExp(`^---[\\s\\S]*?\\n${key}:\\s*(.+)\\n[\\s\\S]*?---`, 'm');
  const m = re.exec(text);
  if (!m) return null;
  return m[1]!.trim().replace(/^["'](.*)["']$/, '$1');
}

// Read a single issue file by basename identifier. Walks every state directory under the
// tracker root because the on-disk listing and the dashboard refer to issues by their
// filename stem; the state is implied by which directory the file is in. Returns null
// when no .md file matches. Uses the real YAML parser (matches the local tracker) so a
// detail page sees the same labels / priority / blockers the orchestrator does.
interface DiskIssueDetail {
  identifier: string;
  state: string;
  filePath: string;
  frontMatter: Record<string, unknown>;
  body: string;
}

async function readIssueFromDisk(
  trackerRoot: string,
  identifier: string,
): Promise<DiskIssueDetail | null> {
  let entries: string[];
  try {
    entries = await readdir(trackerRoot);
  } catch {
    return null;
  }
  const target = `${identifier}.md`;
  for (const stateDir of entries) {
    const dirPath = path.join(trackerRoot, stateDir);
    let st;
    try {
      st = await stat(dirPath);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    const filePath = path.join(dirPath, target);
    let text: string;
    try {
      text = await readFile(filePath, 'utf8');
    } catch {
      continue;
    }
    const { frontMatter, body } = splitMarkdownFrontMatter(text);
    return { identifier, state: stateDir, filePath, frontMatter, body };
  }
  return null;
}

// Mirrors trackers/local.ts's splitFrontMatter — local copy keeps http.ts self-contained
// for tests that don't construct a tracker. Failures fall through to an empty front matter
// rather than throwing so the detail page still renders the body for files with malformed
// YAML (the orchestrator would have skipped them anyway).
function splitMarkdownFrontMatter(text: string): {
  frontMatter: Record<string, unknown>;
  body: string;
} {
  if (!text.startsWith('---')) return { frontMatter: {}, body: text.trim() };
  const lines = text.split(/\r?\n/);
  const isFence = (l: string | undefined) => /^---\s*$/.test(l ?? '');
  if (!isFence(lines[0])) return { frontMatter: {}, body: text.trim() };
  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (isFence(lines[i])) {
      endIdx = i;
      break;
    }
  }
  if (endIdx < 0) return { frontMatter: {}, body: text.trim() };
  const fmText = lines.slice(1, endIdx).join('\n').trim();
  const body = lines.slice(endIdx + 1).join('\n').trim();
  let parsed: unknown = {};
  if (fmText.length > 0) {
    try {
      parsed = parseYaml(fmText);
    } catch {
      parsed = {};
    }
  }
  if (parsed === null || parsed === undefined) parsed = {};
  if (typeof parsed !== 'object' || Array.isArray(parsed)) parsed = {};
  return { frontMatter: parsed as Record<string, unknown>, body };
}

async function gatherPartialInputs(
  orch: Orchestrator,
  view: {
    trackerRoot: string | null;
    states: StateView[];
    workflowPath: string;
  },
): Promise<PartialInputs> {
  const trackerRoot = view.trackerRoot ?? '(unset)';
  let diskIssues: DiskIssue[] = [];
  if (view.trackerRoot) {
    try {
      diskIssues = await listIssuesFromDisk(view.trackerRoot);
    } catch {
      diskIssues = [];
    }
  }
  return {
    workflowName: path.basename(view.workflowPath || 'workflow.md'),
    workflowPath: view.workflowPath || '',
    trackerRoot,
    states: view.states,
    snapshot: orch.snapshot(),
    diskIssues,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Dashboard render. The page is a single server-rendered HTML shell whose four
// live regions poll their own partials at 2s via HTMX. The shell embeds the
// first render of each partial inline so the page is correct on first paint.
// ─────────────────────────────────────────────────────────────────────────────

type Snapshot = ReturnType<Orchestrator['snapshot']>;
type RunningRow = Snapshot['running'][number];
type RetryRow = Snapshot['retrying'][number];
type DiskIssue = {
  identifier: string;
  state: string;
  title: string;
  proposed_by: string | null;
  proposed_at: string | null;
};

interface PartialInputs {
  workflowName: string;
  workflowPath: string;
  trackerRoot: string;
  // Declared per-state config in workflow declaration order. Drives the role-based
  // pill class (active → running, terminal → done, holding → idle), the on-disk
  // column ordering, and (via role filters at the call sites) the form-default
  // active state and triage approve/discard targets.
  states: StateView[];
  snapshot: Snapshot;
  diskIssues: DiskIssue[];
}

/**
 * Map a declared state name to its pill colour class. Active states pulse green
 * (`running`), terminals settle into the muted "done" palette, holdings (Triage)
 * use the same idle palette they always have. Unknown names — issues sitting in a
 * directory that's no longer declared in `states:` — fall back to idle so the
 * dashboard still renders something legible.
 */
function pillClassForState(states: StateView[], stateName: string): string {
  const lower = stateName.toLowerCase();
  const match = states.find((s) => s.name.toLowerCase() === lower);
  if (!match) return 'idle';
  switch (match.role) {
    case 'active':
      return 'running';
    case 'terminal':
      return 'done';
    case 'holding':
      return 'idle';
  }
}

function trackerStatus(snap: Snapshot): 'attention' | 'working' | 'idle' {
  const awaiting = snap.running.some((r) => r.steering_requested);
  if (awaiting || snap.retrying.length > 0) return 'attention';
  if (snap.running.length > 0) return 'working';
  return 'idle';
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function formatRuntime(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem === 0 ? `${h}h` : `${h}h${rem}m`;
}

function formatTimeShort(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function truncate(text: string | null | undefined, max: number): string {
  if (!text) return '';
  const trimmed = text.replace(/\s+/g, ' ').trim();
  return trimmed.length > max ? trimmed.slice(0, max - 1) + '…' : trimmed;
}

// The header partial returns ONLY the tracker-state badge content. Brand, workflow name,
// tracker root, and the refresh button live in the static shell and never repoll, so the
// 2s heartbeat doesn't flash the whole strip.
function renderHeaderPartial(p: PartialInputs): string {
  const status = trackerStatus(p.snapshot);
  const statusLabel = status === 'attention' ? 'attention' : status === 'working' ? 'working' : 'idle';
  return `<span class="badge badge-${status}" aria-label="tracker state: ${statusLabel}">${statusLabel}</span>`;
}

function renderAttentionPartial(p: PartialInputs, opts?: { errorMessage?: string }): string {
  const awaiting = p.snapshot.running.filter((r) => r.steering_requested);
  const retrying = p.snapshot.retrying;
  const errorMessage = opts?.errorMessage?.trim() ?? '';
  if (awaiting.length === 0 && retrying.length === 0 && !errorMessage) return '';

  const errorBanner = errorMessage
    ? `<div class="steering-error" role="alert">${escapeHtml(errorMessage)}</div>`
    : '';
  const steeringBlocks = awaiting.map((r) => renderSteeringBlock(r)).join('');
  const retryBlocks = retrying.length > 0 ? renderRetryBlock(retrying) : '';
  return `<h2 class="attention-title">attention</h2>
${errorBanner}${steeringBlocks}${retryBlocks}`;
}

function renderSteeringBlock(r: RunningRow): string {
  const question = (r.steering_question ?? '').trim() || '(no question text)';
  const context = (r.steering_context ?? '').trim();
  const issueTitle = (r.issue_title ?? '').trim();
  const issueBody = (r.issue_body ?? '').trim();
  const hasOriginalTask = issueTitle.length > 0 || issueBody.length > 0;
  const hasAnyExtra = hasOriginalTask || context.length > 0;
  // The textarea is given a stable id and hx-preserve="true" so the every-2s repoll of
  // the attention zone doesn't wipe the operator's in-progress reply.
  const textareaId = `reply-${r.issue_identifier}`;
  const summaryLabel =
    hasOriginalTask && context ? 'original task & agent’s context'
    : hasOriginalTask ? 'original task'
    : 'agent’s context';
  return `<article class="steering" data-identifier="${escapeHtml(r.issue_identifier)}">
  <header class="steering-head">
    <strong class="ident">${escapeHtml(r.issue_identifier)}</strong>
    <span class="pill awaiting">awaiting</span>
    <span class="turn"><span class="dim">turn</span> ${r.turn_count}</span>
  </header>
  <div class="question-primary">${renderMarkdown(question)}</div>
  ${hasAnyExtra ? `<details class="steering-task">
    <summary>${escapeHtml(summaryLabel)}</summary>
    <div class="steering-task-body">
      ${hasOriginalTask ? `<div class="steering-task-label">issue</div>
      ${issueTitle ? `<h3 class="issue-title">${escapeHtml(issueTitle)}</h3>` : ''}
      ${issueBody ? `<p class="issue-body">${escapeHtml(issueBody)}</p>` : ''}` : ''}
      ${context ? `<div class="steering-task-label">agent’s context</div>
      <pre class="context">${escapeHtml(context)}</pre>` : ''}
    </div>
  </details>` : ''}
  <form class="reply"
        hx-post="/api/v1/issues/${encodeURIComponent(r.issue_identifier)}/steering-reply"
        hx-target="#attention" hx-swap="morph:innerHTML">
    <textarea id="${escapeHtml(textareaId)}" name="text" required
              placeholder="your reply…"
              aria-label="reply to ${escapeHtml(r.issue_identifier)}"
              hx-preserve="true"></textarea>
    <div class="reply-row">
      <span class="hint dim">enter to send · shift+enter for newline</span>
      <button type="submit" class="ghost">send reply</button>
    </div>
  </form>
</article>`;
}

function renderRetryBlock(rows: RetryRow[]): string {
  const items = rows.map((r) => `<li>
    <strong class="ident">${escapeHtml(r.issue_identifier)}</strong>
    <span class="pill retrying">retrying</span>
    <span class="dim">attempt ${r.attempt}</span>
    <span class="dim">due ${escapeHtml(formatTimeShort(r.due_at) || '—')}</span>
    ${r.error ? `<div class="retry-err">${escapeHtml(truncate(r.error, 200))}</div>` : ''}
  </li>`).join('');
  return `<ul class="retry-list" aria-label="retry queue">${items}</ul>`;
}

function renderSessionsPartial(p: PartialInputs): string {
  const rows = p.snapshot.running;
  if (rows.length === 0) {
    const firstActive = p.states.find((s) => s.role === 'active')?.name ?? 'Todo';
    return `<h2>sessions</h2>
<p class="empty dim">no sessions running. agents wake when an issue lands in <code>${escapeHtml(firstActive)}/</code>.</p>`;
  }
  const sessionItems = rows.map((r) => renderSessionRow(r)).join('');
  return `<h2>sessions <span class="count dim">(${rows.length})</span></h2>
<ul class="sessions">${sessionItems}</ul>`;
}

function renderSessionRow(r: RunningRow): string {
  const awaiting = r.steering_requested;
  const pill = awaiting
    ? '<span class="pill awaiting">awaiting</span>'
    : r.transitioned
      ? '<span class="pill done">done</span>'
      : '<span class="pill running">running</span>';
  const tokens = r.tokens.total_tokens || 0;
  const sessionId = r.session_id ? r.session_id.slice(0, 8) : '—';
  const lastMsg = truncate(r.last_message ?? r.last_event ?? '', 140);
  // The session row is two lines max: identifier + pill + turn + tokens + time on top,
  // last-message on bottom. Session id / state / last-event detail is surfaced via the
  // row's title attr so it's available on hover without adding a third line of noise.
  const rowTitle = [
    `session ${sessionId}`,
    r.state,
    r.last_event ?? null,
    `started ${formatTimeShort(r.started_at) || '—'}`,
  ]
    .filter(Boolean)
    .join(' · ');
  return `<li class="session" title="${escapeHtml(rowTitle)}">
  <div class="session-row">
    <strong class="ident">${escapeHtml(r.issue_identifier)}</strong>
    ${pill}
    <span class="turn"><span class="dim">turn</span> ${r.turn_count}</span>
    <span class="grow"></span>
    <span class="tokens dim">${formatTokens(tokens)} tok</span>
  </div>
  ${lastMsg ? `<div class="session-msg dim">${escapeHtml(lastMsg)}</div>` : ''}
</li>`;
}

// Pending agent proposals. Empty when no issues sit in the Triage/ directory; otherwise a
// two-line row per item with an approve (→ first active state) and discard (→ first
// terminal state, prefers Cancelled) action. Provenance (`proposed_by`, `proposed_at`) is
// surfaced as a dim meta line. Hand-written files dropped into Triage/ render the same way
// minus the "from <parent>" bit — meaning operators can also pre-stage human proposals
// in that directory.
function renderTriagePartial(p: PartialInputs): string {
  // Surface every issue whose on-disk state has role `holding`. The workflow
  // parser refuses configs without at least one holding state, so this set is
  // always non-empty in production; the dashboard simply mirrors whatever the
  // operator declared (alternative names like "Backlog" surface here too).
  const holdingNames = new Set(
    p.states.filter((s) => s.role === 'holding').map((s) => s.name.toLowerCase()),
  );
  const triage = p.diskIssues.filter((i) => holdingNames.has(i.state.toLowerCase()));
  if (triage.length === 0) {
    // Empty state is silent rather than narrated — operators see "triage" only when
    // there is something to triage. This matches PRODUCT.md "show real state".
    return '';
  }
  const firstActive = p.states.find((s) => s.role === 'active');
  const approveTarget = firstActive?.name ?? 'Todo';
  const items = triage.map((i) => renderTriageRow(i, approveTarget)).join('');
  return `<h2 class="triage-title">triage <span class="count dim">(${triage.length})</span></h2>
<ul class="triage">${items}</ul>`;
}

function renderTriageRow(i: DiskIssue, approveTarget: string): string {
  const meta: string[] = [];
  if (i.proposed_by) meta.push(`from ${escapeHtml(i.proposed_by)}`);
  if (i.proposed_at) {
    const when = formatTimeShort(i.proposed_at);
    if (when) meta.push(when);
  }
  const metaLine = meta.length > 0 ? meta.join(' · ') : '';
  const ident = escapeHtml(i.identifier);
  // The buttons POST via HTMX and morph #triage so the row vanishes in place when the
  // file moves. We send hx-target=#triage rather than swapping the row inline because the
  // section header's count needs to update too.
  const href = `/issues/${encodeURIComponent(i.identifier)}`;
  return `<li class="triage-row">
  <div class="triage-line-1">
    <a class="ident" href="${href}" title="open ${ident}"><strong>${ident}</strong></a>
    <a class="title" href="${href}">${escapeHtml(i.title)}</a>
  </div>
  <div class="triage-line-2">
    ${metaLine ? `<span class="meta dim">${metaLine}</span>` : '<span class="meta dim">proposed</span>'}
    <span class="grow"></span>
    <form class="triage-actions"
          hx-post="/api/v1/issues/${encodeURIComponent(i.identifier)}/approve"
          hx-target="#triage" hx-swap="morph:innerHTML">
      <button type="submit" class="ghost-sm" title="move to ${escapeHtml(approveTarget)}/">approve</button>
    </form>
    <form class="triage-actions"
          hx-post="/api/v1/issues/${encodeURIComponent(i.identifier)}/discard"
          hx-target="#triage" hx-swap="morph:innerHTML">
      <button type="submit" class="ghost-sm danger" title="discard proposal">discard</button>
    </form>
  </div>
</li>`;
}

function renderDiskPartial(p: PartialInputs): string {
  const runIds = new Set(p.snapshot.running.map((r) => r.issue_identifier));
  const retryIds = new Set(p.snapshot.retrying.map((r) => r.issue_identifier));
  // Visibility rule (Phase 4 brief): "include every state that has at least one
  // issue OR is declared active". Concretely:
  //   • Declared `active` states appear in the panel's ordering even when they
  //     have no rows (their heading is implicit since the flat list uses a
  //     per-row state label rather than per-state subheaders, so this only
  //     matters for the "tracker is clean" empty-state hint).
  //   • Declared `terminal` states surface their rows here when they hold files
  //     — operators get one place to see finished work without leaving the
  //     dashboard. Today's design hid these; the role-based config now decides.
  //   • Declared `holding` states are surfaced through the separate triage
  //     panel above; we exclude them here to avoid double-listing.
  //   • Undeclared on-disk states (a directory whose name isn't in `states:`)
  //     surface too, so a workflow rename leaves a paper trail rather than
  //     silently dropping the rows. They sort to the end of the list.
  const declaredLower = new Map(p.states.map((s) => [s.name.toLowerCase(), s]));
  const candidates = p.diskIssues.filter((i) => {
    if (runIds.has(i.identifier) || retryIds.has(i.identifier)) return false;
    const declared = declaredLower.get(i.state.toLowerCase());
    if (!declared) return true;
    return declared.role !== 'holding';
  });
  // Order: declared-state position first (so Todo before In Progress before any
  // ad-hoc state), then identifier within a state. Undeclared states sort to the
  // end alphabetically by state name so stray rows still cluster together.
  const declaredOrder = p.states.map((s) => s.name);
  const orderIndex = new Map(declaredOrder.map((name, idx) => [name.toLowerCase(), idx]));
  const filtered = candidates.slice().sort((a, b) => {
    const ai = orderIndex.get(a.state.toLowerCase());
    const bi = orderIndex.get(b.state.toLowerCase());
    if (ai !== undefined && bi !== undefined && ai !== bi) return ai - bi;
    if (ai !== undefined && bi === undefined) return -1;
    if (ai === undefined && bi !== undefined) return 1;
    if (a.state !== b.state) return a.state.localeCompare(b.state);
    return a.identifier.localeCompare(b.identifier);
  });
  if (filtered.length === 0) {
    const firstActive = p.states.find((s) => s.role === 'active')?.name ?? 'Todo';
    return `<h2>on disk</h2>
<p class="empty dim">tracker is clean. drop a markdown file into <code>${escapeHtml(firstActive)}/</code> or open <em>new issue</em> below.</p>`;
  }
  const items = filtered.map((i) => {
    const href = `/issues/${encodeURIComponent(i.identifier)}`;
    return `<li>
    <a class="ident" href="${href}" title="open ${escapeHtml(i.identifier)}">${escapeHtml(i.identifier)}</a>
    <span class="state dim">${escapeHtml(i.state)}</span>
    <a class="title" href="${href}">${escapeHtml(i.title)}</a>
  </li>`;
  }).join('');
  return `<h2>on disk <span class="count dim">(${filtered.length})</span></h2>
<ul class="disk">${items}</ul>`;
}

function renderTotalsPartial(p: PartialInputs): string {
  const t = p.snapshot.session_totals;
  if (!t || (t.input_tokens === 0 && t.output_tokens === 0 && t.seconds_running === 0)) return '';
  return `${formatTokens(t.input_tokens)} in · ${formatTokens(t.output_tokens)} out · ${formatTokens(t.total_tokens)} total · ${formatRuntime(t.seconds_running)} runtime`;
}

function renderDashboardHtml(p: PartialInputs): string {
  const activeNames = p.states.filter((s) => s.role === 'active').map((s) => s.name);
  const defaultState = activeNames[0] ?? 'Todo';
  const activeNameSet = new Set(activeNames);
  const diskCount = p.diskIssues.filter((i) => activeNameSet.has(i.state)).length;
  const formOpen =
    diskCount === 0 && p.snapshot.running.length === 0 && p.snapshot.retrying.length === 0;

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>symphony · ${escapeHtml(p.workflowName)}</title>
<style>
:root {
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
code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.92em; color: var(--strong); }
/* List-row links (issue identifier / title in the disk + triage sections) inherit type
   from their parent and drop the default underline; hover and focus surface affordance
   through colour shift only — matches the no-glow rule. */
.disk a, .triage a { color: inherit; text-decoration: none; }
.disk a:hover, .disk a:focus-visible,
.triage a:hover, .triage a:focus-visible { color: #9cc0ff; outline: none; }
.dim { color: var(--dim); }
.grow { flex: 1; }
h2 {
  font-size: 1rem; font-weight: 500; margin: 1.6rem 0 0.5rem;
  padding-bottom: 0.35rem; border-bottom: 1px solid var(--rule-firm);
  letter-spacing: 0.01em;
}
h2:first-child { margin-top: 0.4rem; }

/* ── header strip ─────────────────────────────────────────────────────── */
#header {
  display: flex; align-items: center; gap: 0.5rem;
  padding: 0.65rem 1.5rem;
  background: var(--bench); border-bottom: 1px solid var(--rule-firm);
  font-size: 13px;
  position: sticky; top: 0; z-index: 10;
}
#header .brand { font-weight: 600; color: var(--strong); letter-spacing: 0.01em; }
#header .rule { color: var(--dim); }
#header .workflow { color: var(--base); }
#header .tracker-root {
  color: var(--dim); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  margin-left: 0.75rem;
  flex: 1 1 auto; min-width: 0;
}
#header .badge {
  display: inline-block; padding: 0.1rem 0.55rem; border-radius: 999px;
  font-size: 0.78em; letter-spacing: 0.04em; text-transform: uppercase;
  background: var(--idle-bg); color: var(--idle-fg);
}
#header .badge-working { background: var(--run-bg); color: var(--run-fg); }
#header .badge-attention { background: var(--await-bg); color: var(--await-fg); }
#header .badge-idle { background: var(--idle-bg); color: var(--idle-fg); }
#header .refresh {
  background: var(--chip); color: var(--base);
  border: 1px solid var(--rule-firm); border-radius: 4px;
  width: 28px; height: 28px;
  display: inline-flex; align-items: center; justify-content: center;
  cursor: pointer; font: inherit; font-size: 14px;
  transition: border-color 180ms cubic-bezier(.22,1,.36,1);
}
#header .refresh:hover { border-color: var(--muted); }
#header .refresh:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }

/* ── pills ────────────────────────────────────────────────────────────── */
.pill {
  display: inline-block; padding: 0.1rem 0.55rem; border-radius: 999px;
  font-size: 0.82em; line-height: 1.4;
  font-variant-numeric: tabular-nums;
}
.pill.running { background: var(--run-bg); color: var(--run-fg); }
.pill.retrying { background: var(--retry-bg); color: var(--retry-fg); }
.pill.idle { background: var(--idle-bg); color: var(--idle-fg); }
.pill.awaiting { background: var(--await-bg); color: var(--await-fg); }
.pill.done { background: var(--done-bg); color: var(--done-fg); }

/* ── attention zone ───────────────────────────────────────────────────── */
/* Animated open/close: max-height transitions between 0 (empty) and a generous cap
   (populated) so the section eases in and out rather than snapping the page up/down
   when steering arrives or is resolved. */
#attention {
  display: block;
  overflow: hidden;
  max-height: 0;
  margin-bottom: 0;
  transition: max-height 280ms cubic-bezier(.22, 1, .36, 1),
              margin-bottom 280ms cubic-bezier(.22, 1, .36, 1);
}
#attention:not(:empty) {
  max-height: 1500px;
  margin-bottom: 0.4rem;
}
.attention-title { color: var(--await-fg); border-bottom-color: var(--await-bg); }
.steering-error {
  margin: 0.4rem 0; padding: 0.5rem 0.7rem;
  background: var(--inset); border: 1px solid var(--rule-firm); border-radius: 4px;
  color: var(--err); font-size: 0.9em; line-height: 1.4;
}
/* The steering panel: question-first layout. Selected via /impeccable live (variant 3,
   question-scale=1.1, density=snug). The agent's prompt sits proud and unscaled, and the
   original issue + agent context tuck into a disclosure so the panel reads small until
   the operator wants depth. */
.steering {
  background: var(--raised); padding: 0.55rem 0.8rem; margin: 0.5rem 0;
  border-radius: 6px;
  display: grid; gap: 0.4rem;
}
.steering-head {
  display: flex; align-items: center; gap: 0.6rem;
}
.steering .ident { color: var(--strong); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.steering .turn { font-size: 0.88em; }
.steering .question-primary {
  margin: 0;
  font-size: calc(14px * 1.1);
  line-height: 1.4; color: var(--strong); font-weight: 400;
}
/* Inner Markdown rendered from the steering question. Reset margins so the
   first/last block hug the panel edge, but keep spacing between blocks. */
.steering .question-primary > :first-child { margin-top: 0; }
.steering .question-primary > :last-child { margin-bottom: 0; }
.steering .question-primary p { margin: 0.4em 0; }
.steering .question-primary h1,
.steering .question-primary h2,
.steering .question-primary h3,
.steering .question-primary h4,
.steering .question-primary h5,
.steering .question-primary h6 {
  margin: 0.6em 0 0.3em;
  font-weight: 500;
  border: 0; padding: 0;
  font-size: 1em;
}
.steering .question-primary ul,
.steering .question-primary ol { margin: 0.4em 0; padding-left: 1.4em; }
.steering .question-primary li { margin: 0.15em 0; }
.steering .question-primary code {
  background: var(--inset); padding: 0.05em 0.35em; border-radius: 3px;
  font-size: 0.92em;
}
.steering .question-primary pre {
  margin: 0.5em 0; padding: 0.5rem 0.65rem;
  background: var(--inset); border: 1px solid var(--rule-firm); border-radius: 4px;
  font: 12.5px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  color: var(--muted); overflow: auto;
}
.steering .question-primary pre code { background: transparent; padding: 0; font-size: inherit; }
.steering .question-primary blockquote {
  margin: 0.4em 0; padding: 0.1em 0.7em;
  border-left: 2px solid var(--rule-firm); color: var(--muted);
}
.steering .question-primary a { color: var(--await-fg); }
.steering details.steering-task { font-size: 0.92em; }
.steering details.steering-task > summary {
  cursor: pointer; list-style: none;
  color: var(--muted); padding: 0.3rem 0; user-select: none;
  font-size: 0.88em;
}
.steering details.steering-task > summary::-webkit-details-marker { display: none; }
.steering details.steering-task > summary::before {
  content: "▸"; padding-right: 0.4rem;
  transition: transform 180ms cubic-bezier(.22,1,.36,1);
  display: inline-block; color: var(--dim);
}
.steering details.steering-task[open] > summary::before { transform: rotate(90deg); }
.steering .steering-task-body {
  display: grid; gap: 0.45rem;
  padding: 0.35rem 0 0 0.85rem;
  border-left: 1px solid var(--rule-soft);
}
.steering .steering-task-label {
  font-size: 0.72em; color: var(--dim);
  letter-spacing: 0.09em; text-transform: uppercase;
}
.steering .steering-task-body .issue-title {
  margin: 0; font-size: 0.95em; font-weight: 500; color: var(--base);
}
.steering .steering-task-body .issue-body {
  margin: 0; color: var(--muted); font-size: 0.92em; line-height: 1.5;
}
.steering .context {
  margin: 0; padding: 0.5rem 0.65rem;
  background: var(--inset); border: 1px solid var(--rule-firm); border-radius: 4px;
  font: 12.5px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  color: var(--muted); white-space: pre-wrap; word-break: break-word;
  max-height: 12em; overflow: auto;
}
.steering form.reply { display: grid; gap: 0.45rem; }
.steering textarea {
  background: var(--inset); color: var(--strong);
  border: 1px solid var(--rule-firm); border-radius: 4px;
  padding: 0.5rem 0.65rem;
  font: 14px/1.5 ui-sans-serif, system-ui, sans-serif;
  width: 100%; min-height: 64px; resize: vertical;
}
.steering textarea:focus-visible { outline: 1px solid var(--accent); outline-offset: 0; border-color: var(--accent); }
.steering .reply-row { display: flex; align-items: center; gap: 0.75rem; }
.steering .hint { font-size: 0.82em; }
.ghost {
  background: var(--chip); color: var(--base);
  border: 1px solid var(--rule-firm); border-radius: 4px;
  padding: 0.35rem 0.85rem; font: inherit; cursor: pointer;
  transition: border-color 180ms cubic-bezier(.22,1,.36,1);
}
.ghost:hover { border-color: var(--muted); }
.ghost:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.ghost:disabled { color: var(--dim); cursor: not-allowed; }

.retry-list { list-style: none; padding: 0; margin: 0.4rem 0 0; }
.retry-list li {
  display: grid;
  grid-template-columns: max-content max-content max-content max-content;
  gap: 0.55rem; align-items: center;
  padding: 0.4rem 0; border-bottom: 1px solid var(--rule-soft);
  font-variant-numeric: tabular-nums;
}
.retry-list li:last-child { border-bottom: 0; }
.retry-list .ident { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.retry-list .retry-err {
  grid-column: 1 / -1; color: var(--err); font-size: 0.88em;
  padding-top: 0.15rem;
  word-break: break-word;
}

/* ── sessions ─────────────────────────────────────────────────────────── */
.sessions { list-style: none; padding: 0; margin: 0; }
.sessions li.session {
  padding: 0.5rem 0; border-bottom: 1px solid var(--rule-soft);
}
.sessions li.session:last-child { border-bottom: 0; }
.session-row {
  display: flex; align-items: baseline; gap: 0.65rem;
  font-variant-numeric: tabular-nums;
}
.session-row .ident { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: var(--strong); }
.session-row .turn { font-size: 0.88em; color: var(--muted); }
.session-row .tokens { font-size: 0.88em; }
.session-msg {
  margin-top: 0.2rem; padding-left: 0.05rem;
  font-size: 0.9em; line-height: 1.45;
  overflow-wrap: anywhere;
  max-height: 2.9em; overflow: hidden;
}

/* ── on disk ──────────────────────────────────────────────────────────── */
.disk { list-style: none; padding: 0; margin: 0; }
.disk li {
  display: grid;
  grid-template-columns: 10rem 5.5rem 1fr;
  gap: 0.5rem; align-items: baseline;
  padding: 0.35rem 0; border-bottom: 1px solid var(--rule-soft);
  font-variant-numeric: tabular-nums;
}
.disk li:last-child { border-bottom: 0; }
.disk .ident { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: var(--strong); }
.disk .state { font-size: 0.85em; }
.disk .title { color: var(--base); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.count { font-weight: 400; font-size: 0.88em; margin-left: 0.4rem; }

/* ── triage ──────────────────────────────────────────────────────────────
   Agent-proposed issues awaiting operator approval. Visually adjacent to the
   "disk" listing (a flat, dense list) — not to the "attention" zone, because
   triage is not blocking the orchestrator; it's a queue the operator drains at
   their own pace. The amber-ish "retry" palette is reused for the section
   header to mark it as "needs your eyes" without escalating to the urgent
   blue/attention treatment reserved for steering and retry failures. */
#triage:empty { display: none; }
.triage-title { color: var(--retry-fg); border-bottom-color: var(--retry-bg); }
.triage { list-style: none; padding: 0; margin: 0; }
.triage li.triage-row {
  padding: 0.45rem 0;
  border-bottom: 1px solid var(--rule-soft);
  display: grid; gap: 0.1rem;
}
.triage li.triage-row:last-child { border-bottom: 0; }
.triage .triage-line-1 {
  display: flex; align-items: baseline; gap: 0.65rem;
  font-variant-numeric: tabular-nums;
}
.triage .triage-line-1 .ident {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  color: var(--strong);
}
.triage .triage-line-1 .title {
  color: var(--base);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  flex: 1; min-width: 0;
}
.triage .triage-line-2 {
  display: flex; align-items: center; gap: 0.5rem;
  font-size: 0.88em;
  padding-left: 0.05rem;
}
.triage .meta { font-variant-numeric: tabular-nums; }
.triage form.triage-actions { display: inline; margin: 0; padding: 0; }
.ghost-sm {
  background: transparent; color: var(--muted);
  border: 1px solid var(--rule-firm); border-radius: 3px;
  padding: 0.15rem 0.55rem; font: inherit; font-size: 0.82em; cursor: pointer;
  transition: color 180ms cubic-bezier(.22,1,.36,1),
              border-color 180ms cubic-bezier(.22,1,.36,1);
}
.ghost-sm:hover { color: var(--strong); border-color: var(--muted); }
.ghost-sm.danger:hover { color: var(--err); border-color: var(--err); }
.ghost-sm:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }

/* ── new issue (collapsed) ────────────────────────────────────────────── */
details.new-issue {
  margin-top: 1.4rem;
}
details.new-issue > summary {
  cursor: pointer; list-style: none; padding: 0.55rem 0;
  border-bottom: 1px solid var(--rule-firm);
  font-size: 1rem; font-weight: 500;
  display: flex; align-items: center; gap: 0.5rem;
  user-select: none;
}
details.new-issue > summary::-webkit-details-marker { display: none; }
details.new-issue > summary::before {
  content: "▸"; color: var(--dim); font-size: 0.85em;
  transition: transform 180ms cubic-bezier(.22,1,.36,1);
  display: inline-block;
}
details.new-issue[open] > summary::before { transform: rotate(90deg); }
details.new-issue[open] > summary { border-bottom-color: var(--rule-firm); }
form.create {
  display: grid; grid-template-columns: max-content 1fr; gap: 0.5rem 1rem;
  align-items: center; padding: 1rem 0 0; margin-top: 0.4rem;
}
form.create label { color: var(--muted); }
form.create input, form.create select, form.create textarea {
  background: var(--inset); color: var(--strong);
  border: 1px solid var(--rule-firm); border-radius: 4px;
  padding: 0.4rem 0.6rem; font: inherit; width: 100%;
}
form.create input:focus-visible, form.create select:focus-visible, form.create textarea:focus-visible {
  outline: 1px solid var(--accent); outline-offset: 0; border-color: var(--accent);
}
form.create textarea { min-height: 80px; resize: vertical; }
form.create .submit-row {
  grid-column: 2; display: flex; align-items: center; gap: 0.85rem;
}
form.create button {
  background: var(--accent); color: #f4f6fb; border: 0;
  padding: 0.5rem 1rem; border-radius: 4px; font: inherit; cursor: pointer;
  transition: filter 180ms cubic-bezier(.22,1,.36,1);
  flex: 0 0 auto;
}
form.create button:hover { filter: brightness(1.08); }
form.create button:focus-visible { outline: 2px solid var(--strong); outline-offset: 2px; }
form.create .msg { min-height: 1.2em; color: var(--muted); font-size: 0.9em; line-height: 1.2; }
form.create .msg.err { color: var(--err); }
form.create .msg.ok { color: var(--run-fg); }

/* ── totals footer ────────────────────────────────────────────────────── */
footer.totals {
  margin-top: 2.5rem; padding-top: 0.85rem;
  border-top: 1px solid var(--rule-soft);
  color: var(--dim); font-size: 0.88em;
  font-variant-numeric: tabular-nums;
  display: flex; gap: 0.65rem; flex-wrap: wrap;
}
footer.totals:empty { display: none; }

.empty { padding: 0.5rem 0; }

/* htmx ergonomics */
.htmx-request .refresh { opacity: 0.6; }
.htmx-settling .session-msg { opacity: 0.85; }
</style>
<script src="https://unpkg.com/htmx.org@2.0.4/dist/htmx.min.js"></script>
<script src="https://unpkg.com/idiomorph@0.7.4/dist/idiomorph-ext.min.js"></script>
</head><body hx-ext="morph">

<header id="header">
  <span class="brand">symphony</span>
  <span class="rule" aria-hidden="true">·</span>
  <span class="workflow" title="${escapeHtml(p.workflowPath)}">${escapeHtml(p.workflowName)}</span>
  <span class="tracker-root" title="${escapeHtml(p.trackerRoot)}">${escapeHtml(p.trackerRoot)}</span>
  <span id="tracker-state"
        hx-get="/api/v1/partials/header" hx-trigger="every 2s, refreshed from:body"
        hx-swap="morph:innerHTML">${renderHeaderPartial(p)}</span>
  <button type="button" class="refresh"
          hx-post="/api/v1/refresh" hx-swap="none"
          aria-label="refresh now" title="poll &amp; reconcile">⟳</button>
</header>

<main>

<section id="attention"
         hx-get="/api/v1/partials/attention" hx-trigger="every 2s, refreshed from:body"
         hx-swap="morph:innerHTML">${renderAttentionPartial(p)}</section>

<section id="sessions"
         hx-get="/api/v1/partials/sessions" hx-trigger="every 2s, refreshed from:body"
         hx-swap="morph:innerHTML">${renderSessionsPartial(p)}</section>

<section id="triage"
         hx-get="/api/v1/partials/triage" hx-trigger="every 2s, refreshed from:body"
         hx-swap="morph:innerHTML">${renderTriagePartial(p)}</section>

<section id="disk"
         hx-get="/api/v1/partials/disk" hx-trigger="every 2s, refreshed from:body"
         hx-swap="morph:innerHTML">${renderDiskPartial(p)}</section>

<details class="new-issue"${formOpen ? ' open' : ''}>
  <summary>new issue</summary>
  <form class="create" id="create-form">
    <label for="title">title</label>
    <input id="title" name="title" required autocomplete="off" placeholder="what needs doing?" />
    <label for="description">description</label>
    <textarea id="description" name="description" placeholder="optional — extra context for the agent"></textarea>
    <div class="submit-row">
      <button type="submit">create issue</button>
      <span class="msg" id="create-msg" role="status" aria-live="polite">drops into <code>${escapeHtml(defaultState)}/</code> with a slug derived from the title.</span>
    </div>
  </form>
</details>

<footer class="totals"
        hx-get="/api/v1/partials/totals" hx-trigger="every 2s, refreshed from:body"
        hx-swap="morph:innerHTML">${renderTotalsPartial(p)}</footer>

</main>

<script>
const $ = (id) => document.getElementById(id);

// Enter-to-send on steering textareas. HTMX submits the form; shift+enter still inserts a newline.
document.addEventListener('keydown', (ev) => {
  const t = ev.target;
  if (!(t instanceof HTMLTextAreaElement)) return;
  if (!t.closest('form.reply')) return;
  if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) {
    ev.preventDefault();
    t.form && t.form.requestSubmit();
  }
});

// Create-issue form: stays on fetch+JSON. The dashboard only collects title +
// description; the server derives a slug identifier and defaults state to the first
// active state. Advanced fields (priority, labels, explicit identifier, explicit state)
// are still accepted by the API for direct callers — they just no longer clutter the form.
$('create-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const msg = $('create-msg');
  msg.className = 'msg'; msg.textContent = 'creating…';
  const body = {
    title: $('title').value.trim(),
    description: $('description').value,
  };
  try {
    const res = await fetch('/api/v1/issues', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error((data && data.error && data.error.message) || ('HTTP ' + res.status));
    msg.className = 'msg ok';
    msg.textContent = 'created ' + data.identifier;
    $('create-form').reset();
    fetch('/api/v1/refresh', { method: 'POST' }).catch(() => {});
    document.body.dispatchEvent(new CustomEvent('refreshed', { bubbles: true }));
  } catch (err) {
    msg.className = 'msg err';
    msg.textContent = err.message;
  }
});
</script>

</body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

// Minimal Markdown → HTML renderer used to make the steering panel's question
// (which agents tend to write in Markdown) actually readable. Intentionally
// dependency-free and small; covers the subset agents reach for in chat-style
// prompts: headers, paragraphs, lists, blockquotes, fenced + inline code,
// bold/italic, and links. Input is treated as untrusted: everything outside the
// transforms below is HTML-escaped, and link hrefs are restricted to
// http/https/mailto schemes so a `javascript:` URL can't slip through.
export function renderMarkdown(input: string): string {
  const text = input.replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  const blocks: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const fence = /^```([\w-]*)\s*$/.exec(line);
    if (fence) {
      const lang = fence[1] ?? '';
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i]!)) {
        body.push(lines[i]!);
        i++;
      }
      if (i < lines.length) i++; // consume closing fence
      const langAttr = lang ? ` class="language-${escapeHtml(lang)}"` : '';
      blocks.push(`<pre><code${langAttr}>${escapeHtml(body.join('\n'))}</code></pre>`);
      continue;
    }
    const header = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (header) {
      const level = header[1]!.length;
      blocks.push(`<h${level}>${renderInlineMarkdown(header[2]!)}</h${level}>`);
      i++;
      continue;
    }
    if (line.trim() === '') {
      i++;
      continue;
    }
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i]!)) {
        const m = /^\s*[-*+]\s+(.*)$/.exec(lines[i]!)!;
        items.push(`<li>${renderInlineMarkdown(m[1]!)}</li>`);
        i++;
      }
      blocks.push(`<ul>${items.join('')}</ul>`);
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i]!)) {
        const m = /^\s*\d+\.\s+(.*)$/.exec(lines[i]!)!;
        items.push(`<li>${renderInlineMarkdown(m[1]!)}</li>`);
        i++;
      }
      blocks.push(`<ol>${items.join('')}</ol>`);
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i]!)) {
        buf.push(lines[i]!.replace(/^\s*>\s?/, ''));
        i++;
      }
      blocks.push(`<blockquote>${renderMarkdown(buf.join('\n'))}</blockquote>`);
      continue;
    }
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() !== '' &&
      !/^```/.test(lines[i]!) &&
      !/^#{1,6}\s+/.test(lines[i]!) &&
      !/^\s*[-*+]\s+/.test(lines[i]!) &&
      !/^\s*\d+\.\s+/.test(lines[i]!) &&
      !/^\s*>\s?/.test(lines[i]!)
    ) {
      para.push(lines[i]!);
      i++;
    }
    blocks.push(`<p>${renderInlineMarkdown(para.join('\n'))}</p>`);
  }
  return blocks.join('\n');
}

function renderInlineMarkdown(input: string): string {
  const codes: string[] = [];
  let text = input.replace(/`([^`\n]+)`/g, (_m, code: string) => {
    const idx = codes.length;
    codes.push(`<code>${escapeHtml(code)}</code>`);
    return ` C${idx} `;
  });
  text = escapeHtml(text);
  text = text.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (m, label: string, url: string) => {
    if (!/^(https?:|mailto:)/i.test(url)) return m;
    return `<a href="${url}" rel="noopener noreferrer">${label}</a>`;
  });
  text = text.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
  text = text.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>');
  text = text.replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>');
  text = text.replace(/\n/g, '<br>');
  text = text.replace(/ C(\d+) /g, (_m, idx: string) => codes[Number(idx)]!);
  return text;
}

// ─────────────────────────────────────────────────────────────────────────────
// Issue-detail page. Linked from the identifier on every "on disk" and triage
// row. Shows what the on-disk Markdown file says: the front-matter metadata
// (labels, priority, blocked_by, provenance, timestamps) and the body rendered
// through the same minimal Markdown engine the steering panel uses. Read-only
// — actions live on the dashboard, not here. Follows the design system's
// quiet-workshop rules: flat panels, tabular numerics, no shadows, status pill
// uses the existing palette.
// ─────────────────────────────────────────────────────────────────────────────

function asStringList(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
  return [];
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function asNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return null;
}

function formatTimestamp(v: unknown): string | null {
  if (typeof v === 'string' && v.length > 0) return v;
  if (v instanceof Date) return v.toISOString();
  return null;
}

function renderIssueDetailPage(
  issue: DiskIssueDetail,
  view: { workflowPath: string; states: StateView[] },
): string {
  const fm = issue.frontMatter;
  const title = asString(fm['title']) ?? issue.identifier;
  const labels = asStringList(fm['labels']);
  const blockedBy = asStringList(fm['blocked_by']);
  const priority = asNumber(fm['priority']);
  const createdAt = formatTimestamp(fm['created_at']);
  const updatedAt = formatTimestamp(fm['updated_at']);
  const proposedBy = asString(fm['proposed_by']);
  const proposedAt = formatTimestamp(fm['proposed_at']);
  const branchName = asString(fm['branch_name']);
  const url = asString(fm['url']);

  // Pill colour follows the declared role: active → running, terminal → done,
  // holding → idle. An undeclared state (stale directory, file dropped by hand
  // into a name not in `states:`) falls back to idle so the detail page still
  // renders legibly.
  const stateClass = pillClassForState(view.states, issue.state);

  const metaRows: string[] = [];
  const metaRow = (label: string, value: string): string =>
    `<div class="meta-row"><dt>${escapeHtml(label)}</dt><dd>${value}</dd></div>`;

  metaRows.push(metaRow('state', `<span class="pill ${stateClass}">${escapeHtml(issue.state)}</span>`));
  if (labels.length > 0) {
    const chips = labels
      .map((l) => `<span class="label-chip">${escapeHtml(l)}</span>`)
      .join('');
    metaRows.push(metaRow('labels', `<div class="label-chips">${chips}</div>`));
  }
  if (priority !== null) {
    metaRows.push(metaRow('priority', `<span class="num">${escapeHtml(String(priority))}</span>`));
  }
  if (blockedBy.length > 0) {
    const items = blockedBy
      .map(
        (b) =>
          `<a class="blocker-link" href="/issues/${encodeURIComponent(b)}">${escapeHtml(b)}</a>`,
      )
      .join(', ');
    metaRows.push(metaRow('blocked by', items));
  }
  if (branchName) metaRows.push(metaRow('branch', `<code>${escapeHtml(branchName)}</code>`));
  if (url) {
    const safe = /^https?:/i.test(url) ? url : '';
    metaRows.push(
      metaRow(
        'url',
        safe ? `<a href="${escapeHtml(safe)}" rel="noopener noreferrer">${escapeHtml(safe)}</a>` : escapeHtml(url),
      ),
    );
  }
  if (createdAt) metaRows.push(metaRow('created', `<span class="num">${escapeHtml(createdAt)}</span>`));
  if (updatedAt && updatedAt !== createdAt)
    metaRows.push(metaRow('updated', `<span class="num">${escapeHtml(updatedAt)}</span>`));
  if (proposedBy)
    metaRows.push(
      metaRow(
        'proposed by',
        `<a class="blocker-link" href="/issues/${encodeURIComponent(proposedBy)}">${escapeHtml(proposedBy)}</a>`,
      ),
    );
  if (proposedAt) metaRows.push(metaRow('proposed at', `<span class="num">${escapeHtml(proposedAt)}</span>`));

  const bodyHtml = issue.body.length > 0
    ? `<div class="issue-body">${renderMarkdown(issue.body)}</div>`
    : `<p class="empty dim">no description</p>`;

  const workflowName = path.basename(view.workflowPath || 'workflow.md');

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(issue.identifier)} · symphony</title>
<style>
:root {
  color-scheme: dark;
  --inset: #0c0f15; --bench: #0f1115; --raised: #161a22; --chip: #20242c;
  --rule-soft: #1c2029; --rule-firm: #2a2e36;
  --dim: #6b7280; --muted: #9aa4b2; --base: #dfe2e7; --strong: #e6ebf2;
  --accent: #2a6df4;
  --run-bg: #1f3a26; --run-fg: #58d68d;
  --idle-bg: #20242c; --idle-fg: #9aa4b2;
  --done-bg: #1c2a1f; --done-fg: #82c896;
  --err: #ff7676;
}
* { box-sizing: border-box; }
html, body { background: var(--bench); color: var(--base); }
body {
  font: 14px/1.45 ui-sans-serif, system-ui, sans-serif;
  margin: 0; padding: 0;
  display: flex; flex-direction: column; min-height: 100vh;
}
code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.92em; color: var(--strong); }
a { color: var(--strong); text-decoration: none; }
a:hover { color: #9cc0ff; }
.dim { color: var(--dim); }
.num { font-variant-numeric: tabular-nums; }

/* header strip mirrors the dashboard so navigation feels continuous */
#header {
  display: flex; align-items: center; gap: 0.5rem;
  padding: 0.65rem 1.5rem;
  background: var(--bench); border-bottom: 1px solid var(--rule-firm);
  font-size: 13px;
  position: sticky; top: 0; z-index: 10;
}
#header .brand { font-weight: 600; color: var(--strong); letter-spacing: 0.01em; }
#header .rule { color: var(--dim); }
#header .crumb { color: var(--muted); }
#header .crumb-current { color: var(--base); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }

main {
  width: 100%; max-width: 920px; margin: 0 auto;
  padding: 1rem 1.5rem 2.5rem; flex: 1;
}
.back {
  display: inline-block; padding: 0.2rem 0; margin: 0.2rem 0 0.6rem;
  font-size: 0.88em; color: var(--muted);
}
.back:hover { color: var(--strong); }

.issue-head {
  display: grid; gap: 0.35rem;
  padding-bottom: 0.6rem; margin-bottom: 1.1rem;
  border-bottom: 1px solid var(--rule-firm);
}
.issue-head .ident {
  font: 12.5px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  color: var(--dim); letter-spacing: 0.02em;
}
.issue-head h1 {
  margin: 0; font-size: 1.3rem; font-weight: 500; color: var(--strong);
  line-height: 1.3;
}

/* pills carry status colour, sized to read as inline metadata not content */
.pill {
  display: inline-block; padding: 0.1rem 0.55rem; border-radius: 999px;
  font-size: 0.82em; line-height: 1.4;
  font-variant-numeric: tabular-nums;
}
.pill.running { background: var(--run-bg); color: var(--run-fg); }
.pill.idle { background: var(--idle-bg); color: var(--idle-fg); }
.pill.done { background: var(--done-bg); color: var(--done-fg); }

/* metadata definition list: tight two-column grid, label left, value right */
.issue-meta {
  margin: 0 0 1.4rem;
  display: grid; grid-template-columns: 8.5rem 1fr;
  row-gap: 0.35rem; column-gap: 1rem;
  font-variant-numeric: tabular-nums;
}
.issue-meta .meta-row { display: contents; }
.issue-meta dt {
  color: var(--dim); font-size: 0.85em;
  letter-spacing: 0.05em; text-transform: uppercase;
  align-self: baseline; padding-top: 0.15rem;
}
.issue-meta dd { margin: 0; color: var(--base); }
.label-chips { display: flex; flex-wrap: wrap; gap: 0.3rem; }
.label-chip {
  display: inline-block; padding: 0.05rem 0.5rem; border-radius: 4px;
  background: var(--chip); color: var(--muted);
  font-size: 0.85em; line-height: 1.5;
}
.blocker-link {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.92em; color: var(--muted);
}
.blocker-link:hover { color: var(--strong); }

h2.section-title {
  font-size: 1rem; font-weight: 500; margin: 0 0 0.5rem;
  padding-bottom: 0.35rem; border-bottom: 1px solid var(--rule-firm);
  letter-spacing: 0.01em;
}

.issue-body { color: var(--base); font-size: 0.95em; line-height: 1.55; }
.issue-body > :first-child { margin-top: 0; }
.issue-body > :last-child { margin-bottom: 0; }
.issue-body p { margin: 0.6em 0; }
.issue-body h1, .issue-body h2, .issue-body h3,
.issue-body h4, .issue-body h5, .issue-body h6 {
  margin: 1em 0 0.4em; font-weight: 500; color: var(--strong);
  border: 0; padding: 0;
}
.issue-body h1 { font-size: 1.15em; }
.issue-body h2 { font-size: 1.05em; }
.issue-body h3 { font-size: 1em; }
.issue-body ul, .issue-body ol { margin: 0.5em 0; padding-left: 1.5em; }
.issue-body li { margin: 0.15em 0; }
.issue-body code {
  background: var(--inset); padding: 0.05em 0.35em; border-radius: 3px;
  font-size: 0.92em;
}
.issue-body pre {
  margin: 0.7em 0; padding: 0.6rem 0.75rem;
  background: var(--inset); border: 1px solid var(--rule-firm); border-radius: 4px;
  font: 12.5px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  color: var(--muted); overflow: auto;
}
.issue-body pre code { background: transparent; padding: 0; font-size: inherit; }
.issue-body blockquote {
  margin: 0.5em 0; padding: 0.1em 0.8em;
  border-left: 2px solid var(--rule-firm); color: var(--muted);
}
.issue-body a { color: #9cc0ff; }

.file-path {
  margin-top: 1.4rem; padding-top: 0.7rem;
  border-top: 1px solid var(--rule-soft);
  color: var(--dim); font-size: 0.82em;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  word-break: break-all;
}
.empty { padding: 0.5rem 0; }
</style>
</head><body>

<header id="header">
  <span class="brand">symphony</span>
  <span class="rule" aria-hidden="true">·</span>
  <a class="crumb" href="/" title="back to ${escapeHtml(workflowName)}">${escapeHtml(workflowName)}</a>
  <span class="rule" aria-hidden="true">/</span>
  <span class="crumb-current">${escapeHtml(issue.identifier)}</span>
</header>

<main>
  <a class="back" href="/">← back</a>

  <section class="issue-head">
    <span class="ident">${escapeHtml(issue.identifier)}</span>
    <h1>${escapeHtml(title)}</h1>
  </section>

  <dl class="issue-meta">${metaRows.join('')}</dl>

  <h2 class="section-title">description</h2>
  ${bodyHtml}

  <p class="file-path" title="path on disk">${escapeHtml(issue.filePath)}</p>
</main>

</body></html>`;
}

export interface HttpServerOptions {
  port: number;
  host: string;
  /**
   * Returns the current tracker root and the declared per-state config in
   * workflow order. Wired to the orchestrator's live cfg so a workflow reload
   * (which mutates the live config object in place) is reflected on the next
   * request without rebinding the server. The active/terminal/holding splits
   * are derived inside each consumer by filtering `states` on role; there are
   * no separate flat lists on the view.
   */
  getTrackerView: () => {
    trackerRoot: string | null;
    states: StateView[];
    workflowPath: string;
  };
  /** Optional MCP registry. When present, exposes /api/v1/issues/:id/mcp + steering-reply. */
  mcp?: McpRegistry | null;
  /**
   * Optional tracker reference. When present and the tracker supports
   * `moveIssueToState`, the triage approve/discard endpoints are enabled so
   * proposed issues can be promoted to the active queue or cancelled from the
   * dashboard. When null, the triage section still renders (it's just disk
   * listing) but the action buttons return 404.
   */
  tracker?: IssueTracker | null;
}

// Resolves once the server has either bound the requested port or rejected with the bind
// error so CLI startup can surface EADDRINUSE / EACCES instead of an unhandled rejection.
// Returns the *actually bound* port (relevant for --port 0, where the kernel picks an
// ephemeral port) so callers can advertise the live address.
export async function startHttpServer(
  orch: Orchestrator,
  opts: HttpServerOptions,
): Promise<{ close: () => Promise<void>; port: number }> {
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

  let boundPort = opts.port;
  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
      server.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : opts.port;
      boundPort = port;
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
    port: boundPort,
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
    const p = await gatherPartialInputs(orch, view);
    const html = renderDashboardHtml(p);
    res.statusCode = 200;
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(html);
    return;
  }
  // Static preview for impeccable live mode. The file under .impeccable/preview/ is a
  // captured snapshot of the dashboard with polling disabled, used as a variant playground.
  // Read on every request so live-wrap edits land immediately.
  if (pathname === '/preview' || pathname === '/preview/') {
    if (method !== 'GET') return methodNotAllowed(res);
    try {
      const html = await readFile('.impeccable/preview/dashboard.html', 'utf8');
      res.statusCode = 200;
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.setHeader('cache-control', 'no-store');
      res.end(html);
    } catch (err) {
      return notFound(res, 'preview_missing', `preview not available: ${(err as Error).message}`);
    }
    return;
  }
  // HTMX partials. Each region polls its own endpoint at 2s; this is what the dashboard
  // <section hx-get=...> elements consume. They return only the inner HTML; the outer
  // wrapper is in the dashboard shell.
  if (pathname.startsWith('/api/v1/partials/')) {
    if (method !== 'GET') return methodNotAllowed(res);
    const p = await gatherPartialInputs(orch, view);
    const slug = pathname.slice('/api/v1/partials/'.length);
    let body: string | null = null;
    if (slug === 'header') body = renderHeaderPartial(p);
    else if (slug === 'attention') body = renderAttentionPartial(p);
    else if (slug === 'sessions') body = renderSessionsPartial(p);
    else if (slug === 'triage') body = renderTriagePartial(p);
    else if (slug === 'disk') body = renderDiskPartial(p);
    else if (slug === 'totals') body = renderTotalsPartial(p);
    if (body === null) return notFound(res, 'partial_not_found', `partial ${slug} does not exist`);
    res.statusCode = 200;
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.end(body);
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
      const stateInput = typeof b.state === 'string' ? b.state.trim() : '';
      if (!title) return badRequest(res, 'title is required');
      // `identifier` and `state` are optional: identifier is derived from the title when
      // omitted, state defaults to the first declared active state (typically `Todo`). This
      // keeps the dispatch surface to a single required field for callers that just want to
      // hand the orchestrator a task.
      const firstActiveName = view.states.find((s) => s.role === 'active')?.name ?? '';
      const state = stateInput || firstActiveName;
      if (!state) {
        return badRequest(res, 'state is required (no active states declared to default to)');
      }
      // Restrict `state` to one of the declared states with role in {active, terminal}.
      // Holding states (Triage) are reachable through `propose_issue` and the on-disk
      // file drop, not this dashboard form — keeping the form to dispatchable targets
      // matches today's behaviour and stops a caller from bypassing the operator-
      // approval queue. Values containing path separators / `..` are rejected by the
      // set lookup so the request cannot escape the tracker root via `path.join`.
      const allowedNames = view.states
        .filter((s) => s.role === 'active' || s.role === 'terminal')
        .map((s) => s.name);
      const allowedStates = new Set(allowedNames);
      if (!allowedStates.has(state)) {
        return badRequest(
          res,
          `state must be one of: ${allowedNames.join(', ') || '<none configured>'}`,
        );
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
  // MCP JSON-RPC endpoint: agent (inside the smolvm) POSTs JSON-RPC envelopes here. The
  // URL is per-issue (the agent only knows its own /<id>/mcp), backed by a bearer token
  // generated at dispatch. Both layers are belt-and-braces against the no-auth 8787 socket.
  const mcpMatch = /^\/api\/v1\/issues\/([^/]+)\/mcp$/.exec(pathname);
  if (mcpMatch) {
    if (method !== 'POST') return methodNotAllowed(res);
    const mcp = opts.mcp;
    if (!mcp) return notFound(res, 'mcp_disabled', 'mcp endpoint not enabled');
    const identifier = decodeURIComponent(mcpMatch[1]!);
    const auth = (req.headers['authorization'] ?? req.headers['Authorization']) as
      | string
      | undefined;
    const token = auth && auth.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : '';
    if (!token) {
      res.statusCode = 401;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: { code: 'unauthorized', message: 'bearer token required' } }));
      return;
    }
    if (!mcp.isActive(identifier, token)) {
      res.statusCode = 404;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(
        JSON.stringify({ error: { code: 'not_found', message: 'issue not active or token mismatch' } }),
      );
      return;
    }
    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      return badRequest(res, (err as Error).message);
    }
    const reply = await mcp.handleJsonRpc(identifier, token, body);
    if (reply === null) {
      // JSON-RPC notification (no id) → 204 No Content
      res.statusCode = 204;
      res.end();
      return;
    }
    return jsonResponse(res, 200, reply);
  }

  // Steering reply: the dashboard (or any operator with access) submits the human's
  // response to a queued request_human_steering call. The orchestrator-side runner is
  // awaiting on the registry; this POST unblocks it.
  //
  // Two callers:
  //  • Dashboard via HTMX (form-encoded body, `HX-Request: true`, same-origin). We accept
  //    only this combination for form bodies and reply with an HTML partial that swaps
  //    into #attention.
  //  • Direct API client (JSON body). Replies with a structured JSON acknowledgement.
  //
  // The form-encoded branch is gated on `HX-Request: true` and a same-origin check so a
  // simple cross-site form POST cannot inject a steering reply: form-encoded is a "simple"
  // CORS request that bypasses preflight, and the steering endpoint is unauthenticated.
  // HTMX errors land at 200 OK with an inline `.steering-error` message because HTMX's
  // default response-handling does not swap on 4xx/5xx; returning 200 keeps the operator's
  // form in sync with reality (their textarea text is preserved by hx-preserve regardless).
  const steeringMatch = /^\/api\/v1\/issues\/([^/]+)\/steering-reply$/.exec(pathname);
  if (steeringMatch) {
    if (method !== 'POST') return methodNotAllowed(res);
    const mcp = opts.mcp;
    if (!mcp) return notFound(res, 'mcp_disabled', 'steering endpoint not enabled');
    const identifier = decodeURIComponent(steeringMatch[1]!);
    const isHtmx = req.headers['hx-request'] === 'true';
    const ctype = (req.headers['content-type'] ?? '').toLowerCase();
    const baseCtype = ctype.split(';', 1)[0]!.trim();
    const isFormBody = baseCtype === 'application/x-www-form-urlencoded';
    const isJsonBody = baseCtype === 'application/json';

    // Content-type gates against CSRF: form-urlencoded, text/plain, and multipart/form-data
    // are "simple" CORS requests and bypass preflight. Only application/json (non-simple,
    // triggers preflight) is accepted on the JSON path; the form path is additionally
    // gated on HX-Request + same-origin. Anything else is rejected outright.
    if (!isFormBody && !isJsonBody) {
      return jsonResponse(res, 415, {
        error: {
          code: 'unsupported_media_type',
          message: 'content-type must be application/json or application/x-www-form-urlencoded',
        },
      });
    }
    if (isFormBody) {
      if (!isHtmx || !isSameOriginRequest(req)) {
        return jsonResponse(res, 403, {
          error: {
            code: 'forbidden',
            message: 'form-encoded steering replies require an HTMX same-origin request',
          },
        });
      }
    }

    let text = '';
    if (isFormBody) {
      try {
        const raw = await readTextBody(req);
        const params = new URLSearchParams(raw);
        text = (params.get('text') ?? '').trim();
      } catch (err) {
        return htmxOrJsonError(res, isHtmx, orch, view, 400, 'bad_request', (err as Error).message);
      }
    } else {
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        return badRequest(res, (err as Error).message);
      }
      text =
        body && typeof body === 'object' && !Array.isArray(body) && typeof (body as Record<string, unknown>).text === 'string'
          ? ((body as Record<string, unknown>).text as string).trim()
          : '';
    }

    if (!text) {
      return htmxOrJsonError(
        res,
        isHtmx,
        orch,
        view,
        400,
        'bad_request',
        'text is required and must be a non-empty string',
      );
    }
    const ok = mcp.submitSteeringReply(identifier, text);
    if (!ok) {
      return htmxOrJsonError(
        res,
        isHtmx,
        orch,
        view,
        409,
        'no_pending_steering',
        'no agent is awaiting steering for this issue',
      );
    }
    if (isHtmx) {
      const p = await gatherPartialInputs(orch, view);
      res.statusCode = 200;
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(renderAttentionPartial(p));
      return;
    }
    return jsonResponse(res, 202, { identifier, accepted_at: new Date().toISOString() });
  }

  // Triage approve / discard. The dashboard renders these as buttons inside the triage
  // section; an operator clicks one and we move the issue file out of Triage/. Approve
  // sends it to the first active state (typically Todo) where the orchestrator will pick
  // it up on the next poll; discard sends it to the first terminal state that looks like a
  // cancellation (case-insensitive "Cancelled" match preferred) so the proposal is
  // archived rather than deleted — operators can still grep for what was proposed and
  // turned down.
  //
  // CSRF posture mirrors the steering-reply endpoint: form-encoded requires HX-Request
  // + same-origin; JSON requires application/json (preflight-triggering). HTMX errors
  // come back as 200 with a partial so the section doesn't go stale.
  const triageMatch = /^\/api\/v1\/issues\/([^/]+)\/(approve|discard)$/.exec(pathname);
  if (triageMatch) {
    if (method !== 'POST') return methodNotAllowed(res);
    const tracker = opts.tracker;
    if (!tracker || !tracker.moveIssueToState) {
      return notFound(
        res,
        'tracker_no_state_transitions',
        'tracker does not support state transitions',
      );
    }
    const root = view.trackerRoot;
    if (!root) return badRequest(res, 'tracker.root not configured');
    const identifier = decodeURIComponent(triageMatch[1]!);
    const action = triageMatch[2]!;
    const isHtmx = req.headers['hx-request'] === 'true';
    const ctype = (req.headers['content-type'] ?? '').toLowerCase();
    const baseCtype = ctype.split(';', 1)[0]!.trim();
    const isFormBody = baseCtype === 'application/x-www-form-urlencoded';
    const isJsonBody = baseCtype === 'application/json';
    // HTMX form submits arrive with an empty body and the standard form content-type;
    // direct API callers send application/json. An empty Content-Type from curl is
    // treated as a JSON call (consistent with how /issues handles bodyless POSTs).
    const isEmptyCtype = baseCtype === '';
    if (!isFormBody && !isJsonBody && !isEmptyCtype) {
      return jsonResponse(res, 415, {
        error: {
          code: 'unsupported_media_type',
          message: 'content-type must be application/json or application/x-www-form-urlencoded',
        },
      });
    }
    // Both form-encoded and empty Content-Type are "simple" CORS requests that bypass
    // preflight, so a cross-origin page can POST them without the browser blocking.
    // Gate both on HX-Request + same-origin; only application/json (which triggers a
    // preflight on cross-origin fetches) is exempt.
    if (isFormBody || isEmptyCtype) {
      if (!isHtmx || !isSameOriginRequest(req)) {
        return jsonResponse(res, 403, {
          error: {
            code: 'forbidden',
            message: 'triage actions require an HTMX same-origin request or application/json',
          },
        });
      }
    }
    let toState: string;
    if (action === 'approve') {
      // First declared `active` state in declaration order, falling back to the
      // literal "Todo" so a workflow without any active states still produces a
      // defined error path rather than crashing the handler. (validateStates
      // refuses configs without an active role, so the fallback is defensive.)
      const firstActive = view.states.find((s) => s.role === 'active');
      toState = firstActive?.name ?? 'Todo';
    } else {
      // Discard prefers a state literally named "Cancelled" (case-insensitive)
      // and falls back to the first declared `terminal` state. If neither is
      // declared we refuse the action rather than silently deleting.
      const terminals = view.states.filter((s) => s.role === 'terminal');
      const cancelled = terminals.find((s) => s.name.toLowerCase() === 'cancelled');
      const fallback = terminals[0];
      const target = cancelled ?? fallback;
      if (!target) {
        return jsonResponse(res, 409, {
          error: {
            code: 'no_discard_target',
            message: 'no terminal state configured to discard the proposal into',
          },
        });
      }
      toState = target.name;
    }
    // From-state for the move: the first declared `holding` state in
    // declaration order. The workflow parser refuses configs without one, so a
    // missing entry here would be a programmer error; refuse the action with a
    // clear error rather than silently picking a wrong state. Kept in sync with
    // `pickHoldingState` in src/issues.ts.
    const holdingState = view.states.find((s) => s.role === 'holding');
    if (!holdingState) {
      return jsonResponse(res, 409, {
        error: {
          code: 'no_holding_state',
          message: 'no holding state declared in workflow; cannot resolve triage from-state',
        },
      });
    }
    const holdingFromState = holdingState.name;
    try {
      const result = await tracker.moveIssueToState(identifier, toState, {
        fromRoot: root,
        fromState: holdingFromState,
      });
      log.info('triage action', { identifier, action, from: result.fromState, to: result.toState });
      // Nudge the orchestrator to pick the freshly approved issue up immediately instead
      // of waiting for the next poll tick. Best-effort: triggerRefresh is idempotent.
      if (action === 'approve') {
        try {
          orch.triggerRefresh();
        } catch {
          /* refresh request is fire-and-forget */
        }
      }
      if (isHtmx) {
        const p = await gatherPartialInputs(orch, view);
        res.statusCode = 200;
        res.setHeader('content-type', 'text/html; charset=utf-8');
        res.setHeader('cache-control', 'no-store');
        res.end(renderTriagePartial(p));
        return;
      }
      return jsonResponse(res, 200, {
        identifier,
        action,
        from_state: result.fromState,
        to_state: result.toState,
      });
    } catch (err) {
      const code = (err as Error & { code?: string }).code ?? 'triage_failed';
      const status = code === 'local_issue_not_found' ? 404 : 409;
      if (isHtmx) {
        // Re-render the section so the row that "failed" stays visible; the operator can
        // retry or investigate. We don't have a banner widget for this section yet, so
        // surface the failure via the log line + the section staying populated. A more
        // verbose UI is a follow-up if operators report needing it.
        const p = await gatherPartialInputs(orch, view);
        res.statusCode = 200;
        res.setHeader('content-type', 'text/html; charset=utf-8');
        res.setHeader('cache-control', 'no-store');
        res.end(renderTriagePartial(p));
        return;
      }
      return jsonResponse(res, status, {
        error: { code, message: (err as Error).message },
      });
    }
  }

  // Read-only HTML view of one issue. Linked from the identifier on every "on disk" and
  // triage row; renders front-matter (labels, priority, blockers, provenance) plus the
  // Markdown body so an operator can read the full task without leaving the browser. No
  // editing surface — actions stay on the dashboard. Source of truth is the on-disk .md
  // file, found by walking every state directory under tracker.root for a basename match.
  const detailMatch = /^\/issues\/([^/]+)\/?$/.exec(pathname);
  if (detailMatch) {
    if (method !== 'GET') return methodNotAllowed(res);
    const root = view.trackerRoot;
    if (!root) {
      res.statusCode = 404;
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(renderIssueNotFoundPage('(tracker root not configured)', view));
      return;
    }
    const identifier = decodeURIComponent(detailMatch[1]!);
    const issue = await readIssueFromDisk(root, identifier);
    if (!issue) {
      res.statusCode = 404;
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(renderIssueNotFoundPage(identifier, view));
      return;
    }
    res.statusCode = 200;
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.end(renderIssueDetailPage(issue, view));
    return;
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

function renderIssueNotFoundPage(
  identifier: string,
  view: { workflowPath: string },
): string {
  const workflowName = path.basename(view.workflowPath || 'workflow.md');
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>not found · symphony</title>
<style>
:root { color-scheme: dark; }
html, body {
  background: #0f1115; color: #dfe2e7;
  font: 14px/1.45 ui-sans-serif, system-ui, sans-serif;
  margin: 0; padding: 0;
}
main { max-width: 640px; margin: 0 auto; padding: 2.5rem 1.5rem; }
h1 { font-size: 1.2rem; font-weight: 500; color: #e6ebf2; margin: 0 0 0.6rem; }
p { color: #9aa4b2; line-height: 1.5; }
a { color: #9cc0ff; text-decoration: none; }
a:hover { color: #e6ebf2; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: #e6ebf2; }
</style>
</head><body>
<main>
  <h1>issue not found</h1>
  <p>no issue file matches <code>${escapeHtml(identifier)}</code> under the tracker root.</p>
  <p><a href="/">← back to ${escapeHtml(workflowName)}</a></p>
</main>
</body></html>`;
}
