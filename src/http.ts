// HTTP server extension (SPEC §13.7) plus the local-tracker UI for creating issues and
// watching status. The UI polls `/api/v1/state` so no SSE/WebSocket infrastructure is
// needed.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { parseFrontMatterLenient } from './util/frontmatter.js';
import type { Orchestrator } from './orchestrator.js';
import { log } from './logging.js';
import type { McpRegistry } from './mcp.js';
import { writeIssueFile } from './issues.js';
import type { IssueTracker } from './trackers/types.js';
import type { StateConfig } from './types.js';
import {
  type Route,
  type StateView,
  matchRoute,
  resolvePartialName,
  extractBearerToken,
  classifyContentType,
  checkSteeringCsrf,
  checkTriageCsrf,
  extractFormText,
  extractJsonText,
  decideCreateIssue,
  decideTriageTransition,
} from './http-handlers.js';

// Re-export so existing imports of StateView (e.g. src/bin/symphony.ts uses the same
// shape via `getTrackerView`) and any future consumer of the public surface continue
// to resolve through src/http.ts.
export type { StateView };

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
// returning a 4xx with an HTML partial silently leaves the region stale. For HTMX
// callers (currently only steering-reply, which targets the #ticker region) we
// return 200 with the ticker partial plus an inline error chip; the operator's
// textarea content sits in the board row (separate hx-preserve cycle) and is
// unaffected. JSON callers still get the appropriate status code and a structured
// error.
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
      const { fields } = parseFrontMatterLenient(text);
      const title = asString(fields['title']) ?? f.slice(0, -3);
      const proposed_by = asString(fields['proposed_by']);
      const proposed_at = asString(fields['proposed_at']);
      // Prefer the front-matter `identifier:` when set so the dashboard reports the
      // same identifier the orchestrator dispatches under (LocalMarkdownTracker's
      // normalize() at src/trackers/local.ts uses `fm.identifier ?? filename`).
      // Without this, an issue whose front-matter identifier differs from its
      // filename loses its overlaid running/retrying/awaiting state on the board
      // and its ticker jump-link points at a missing #row anchor.
      const fmIdent = asString(fields['identifier']);
      const identifier = fmIdent && fmIdent.length > 0 ? fmIdent : f.slice(0, -3);
      out.push({ identifier, state: stateDir, title, proposed_by, proposed_at });
    }
  }
  out.sort((a, b) => a.identifier.localeCompare(b.identifier));
  return out;
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
  // Fast path: filename stem matches. Common case where the operator never set
  // a front-matter identifier and the file is just `<identifier>.md`.
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
    const { fields, body } = parseFrontMatterLenient(text);
    return { identifier, state: stateDir, filePath, frontMatter: fields, body };
  }
  // Fallback: scan every .md file in every state directory and match by the
  // front-matter `identifier:` field. Handles the case where the orchestrator
  // dispatches under a front-matter identifier that differs from the filename
  // stem — same resolution the tracker uses in normalize() (`fm.identifier ??
  // filename`). Slower (reads every issue file) but only on the not-found path,
  // and only for trackers that actually exercise the override.
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
      const { fields, body } = parseFrontMatterLenient(text);
      if (asString(fields['identifier']) !== identifier) continue;
      return { identifier, state: stateDir, filePath, frontMatter: fields, body };
    }
  }
  return null;
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
// Dashboard render. The page is a single server-rendered HTML shell whose live
// regions (#tracker-state, #ticker, #board, footer.totals) poll their own
// partials at 2s via HTMX. The shell embeds the first render of each partial
// inline so the page is correct on first paint. The board is a kanban: one
// column per declared state, with the new-issue composer living in a right-side
// slide-in panel (the only card-shaped surface — see DESIGN.md One-Card Rule).
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
  // Declared per-state config in workflow declaration order. Drives the kanban
  // column order, the per-column add-issue affordance (active + holding only),
  // the per-row triage approve/discard buttons (holding only), the form-default
  // active state, and the still-used role-based pill class on the issue detail
  // page (which sits outside the kanban).
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

// ─── Top-of-page attention ticker ───────────────────────────────────────
// A horizontal strip listing what currently needs the operator's eyes: pending
// steering replies and stuck retries. Each identifier is an anchor link to the
// row inside the board — the operator scans the ticker, jumps to the column,
// and replies in place. The steering reply form itself now lives inline on its
// row in the board, so this ticker stays thin.
function renderAttentionPartial(p: PartialInputs, opts?: { errorMessage?: string }): string {
  const awaiting = p.snapshot.running.filter((r) => r.steering_requested);
  const retrying = p.snapshot.retrying;
  const errorMessage = opts?.errorMessage?.trim() ?? '';
  const segments: string[] = [];
  if (awaiting.length > 0) {
    const links = awaiting
      .map((r) =>
        `<a href="#row-${escapeHtml(r.issue_identifier)}" class="tick-id">${escapeHtml(r.issue_identifier)}</a>`,
      )
      .join(' ');
    segments.push(
      `<span class="tick tick-await"><span class="tick-label">${awaiting.length} awaiting</span> ${links}</span>`,
    );
  }
  if (retrying.length > 0) {
    const stuck = retrying.filter((r) => r.error).length;
    const links = retrying
      .map((r) =>
        `<a href="#row-${escapeHtml(r.issue_identifier)}" class="tick-id">${escapeHtml(r.issue_identifier)}</a>`,
      )
      .join(' ');
    const label = stuck > 0
      ? `${retrying.length} retrying · ${stuck} with error`
      : `${retrying.length} retrying`;
    segments.push(
      `<span class="tick tick-retry"><span class="tick-label">${label}</span> ${links}</span>`,
    );
  }
  if (errorMessage) {
    segments.push(`<span class="tick tick-err" role="alert">${escapeHtml(errorMessage)}</span>`);
  }
  return segments.join('');
}

// ─── Board (kanban) ─────────────────────────────────────────────────────
// One column per declared state in workflow declaration order. Each on-disk
// issue renders as a flat row in its state's column; transient orchestrator
// state (running / retrying / awaiting steering) is overlaid via a pill, a
// metadata trail, and — for awaiting — an inline question + reply form. Issues
// sitting in an undeclared state directory (e.g. after a workflow rename) get
// trailing columns so they stay visible until reconciled rather than silently
// dropping out of the dashboard.
function renderBoardPartial(p: PartialInputs): string {
  const runningById = new Map<string, RunningRow>();
  for (const r of p.snapshot.running) runningById.set(r.issue_identifier, r);
  const retryingById = new Map<string, RetryRow>();
  for (const r of p.snapshot.retrying) retryingById.set(r.issue_identifier, r);

  // Group disk issues by lower-cased state name. LocalMarkdownTracker matches
  // state directories case-insensitively against the declared `states:` keys
  // (src/trackers/local.ts §scanAllAt: `declared.has(dirEntry.toLowerCase())`),
  // so the dashboard must mirror that or a `todo/` directory under declared
  // `Todo` would be misclassified as an orphan and split off into its own
  // trailing column. `displayName` keeps the on-disk casing for orphan column
  // headers (the only place we need to show a non-declared name).
  const byStateLower = new Map<string, { displayName: string; items: DiskIssue[] }>();
  for (const i of p.diskIssues) {
    const key = i.state.toLowerCase();
    const entry = byStateLower.get(key);
    if (entry) entry.items.push(i);
    else byStateLower.set(key, { displayName: i.state, items: [i] });
  }

  // Terminal columns (Done, Cancelled, …) are deliberately omitted from the
  // board. The orchestrator's glance test — "is anything stuck, is anything
  // running" — doesn't read off finished work, and a wall of archived rows
  // dilutes the active surface. Terminal issues stay reachable through their
  // /issues/<id> detail page; a dedicated history surface is the natural place
  // to surface them again once we have something to anchor the row on (a PR
  // link, a final token total, a closed-at timestamp).
  const declared = p.states
    .filter((state) => state.role !== 'terminal')
    .map((state) => {
      const items = byStateLower.get(state.name.toLowerCase())?.items ?? [];
      return renderColumn(state, items, runningById, retryingById);
    });

  // Orphan columns: on-disk state directories whose names are not in the
  // declared `states:` set. These render even when they look "terminal" because
  // they're an error condition the operator needs to see (a workflow rename
  // left files behind), not a clean archive.
  const declaredLower = new Set(p.states.map((s) => s.name.toLowerCase()));
  const orphans: Array<{ name: string; items: DiskIssue[] }> = [];
  for (const [key, entry] of byStateLower) {
    if (declaredLower.has(key)) continue;
    orphans.push({ name: entry.displayName, items: entry.items });
  }
  orphans.sort((a, b) => a.name.localeCompare(b.name));
  const orphanColumns = orphans.map((o) =>
    renderColumn(
      { name: o.name, role: 'terminal' },
      o.items,
      runningById,
      retryingById,
      { orphan: true },
    ),
  );

  return `<div class="kanban">${declared.join('')}${orphanColumns.join('')}</div>`;
}

function renderColumn(
  state: StateView,
  items: DiskIssue[],
  runningById: Map<string, RunningRow>,
  retryingById: Map<string, RetryRow>,
  opts?: { orphan?: boolean },
): string {
  const orphan = opts?.orphan === true;
  const canAdd = !orphan && state.role !== 'terminal';

  // Sort within a column so anything needing attention floats to the top:
  // awaiting → running → retrying → idle. Ties break on identifier for stability.
  const sorted = items.slice().sort((a, b) => {
    const rank = (id: string) => {
      const run = runningById.get(id);
      if (run?.steering_requested) return 0;
      if (run) return 1;
      if (retryingById.get(id)) return 2;
      return 3;
    };
    const ar = rank(a.identifier);
    const br = rank(b.identifier);
    if (ar !== br) return ar - br;
    return a.identifier.localeCompare(b.identifier);
  });

  const rowsHtml = sorted
    .map((i) =>
      renderIssueRow(
        i,
        state,
        runningById.get(i.identifier),
        retryingById.get(i.identifier),
        { orphan },
      ),
    )
    .join('');

  const addBtn = canAdd
    ? `<button type="button" class="col-add"
              data-target-state="${escapeHtml(state.name)}"
              aria-label="add issue to ${escapeHtml(state.name)}"
              title="add issue to ${escapeHtml(state.name)}">+</button>`
    : '';

  const emptyHint =
    sorted.length === 0 && state.role === 'active' && !orphan
      ? `<p class="col-empty">drop into <code>${escapeHtml(state.name)}/</code></p>`
      : '';

  const orphanBadge = orphan
    ? `<span class="col-orphan" title="state not declared in workflow.md">undeclared</span>`
    : '';

  return `<section class="col col-${escapeHtml(state.role)}${orphan ? ' col-orphan-wrap' : ''}" data-state="${escapeHtml(state.name)}">
  <header class="col-head">
    <span class="col-name">${escapeHtml(state.name)}</span>
    <span class="col-count">${sorted.length}</span>
    ${orphanBadge}
    <span class="grow"></span>
    ${addBtn}
  </header>
  <div class="col-body">${rowsHtml}${emptyHint}</div>
</section>`;
}

function renderIssueRow(
  i: DiskIssue,
  state: StateView,
  running: RunningRow | undefined,
  retrying: RetryRow | undefined,
  opts?: { orphan?: boolean },
): string {
  const orphan = opts?.orphan === true;
  const isAwaiting = !!running?.steering_requested;
  const isRunning = !!running && !isAwaiting;
  const isRetrying = !!retrying;
  const isHolding = !orphan && state.role === 'holding';
  const ident = i.identifier;
  const escIdent = escapeHtml(ident);
  const href = `/issues/${encodeURIComponent(ident)}`;

  let pill = '';
  if (isAwaiting) pill = '<span class="pill awaiting">awaiting</span>';
  else if (isRunning) pill = '<span class="pill running">running</span>';
  else if (isRetrying) pill = '<span class="pill retrying">retrying</span>';

  let meta = '';
  if (running) {
    const tokens = formatTokens(running.tokens.total_tokens || 0);
    meta = `<span class="row-meta">turn ${running.turn_count} · ${escapeHtml(tokens)} tok</span>`;
  } else if (retrying) {
    const dueAt = formatTimeShort(retrying.due_at) || '—';
    meta = `<span class="row-meta">attempt ${retrying.attempt} · due ${escapeHtml(dueAt)}</span>`;
  }

  let peek = '';
  if (running && !isAwaiting) {
    const text = truncate(running.last_message ?? running.last_event ?? '', 110);
    if (text) peek = `<div class="row-peek dim">${escapeHtml(text)}</div>`;
  }

  let retryErr = '';
  if (retrying && retrying.error) {
    retryErr = `<div class="row-err">${escapeHtml(truncate(retrying.error, 200))}</div>`;
  }

  let triageActions = '';
  if (isHolding && !isRunning && !isAwaiting && !isRetrying) {
    triageActions = `<div class="row-actions">
    <form class="row-action"
          hx-post="/api/v1/issues/${encodeURIComponent(ident)}/approve"
          hx-target="#board" hx-swap="morph:innerHTML">
      <button type="submit" class="ghost-sm" title="approve into the first active state">approve</button>
    </form>
    <form class="row-action"
          hx-post="/api/v1/issues/${encodeURIComponent(ident)}/discard"
          hx-target="#board" hx-swap="morph:innerHTML">
      <button type="submit" class="ghost-sm danger" title="discard the proposal">discard</button>
    </form>
  </div>`;
  }

  const steering = isAwaiting ? renderSteeringInline(running!) : '';

  const rowClasses = [
    'row',
    isAwaiting ? 'row-await' : '',
    isRunning ? 'row-run' : '',
    isRetrying && retrying?.error ? 'row-retry-stuck' : '',
    orphan ? 'row-orphan' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return `<article class="${rowClasses}" id="row-${escIdent}">
  <div class="row-head">
    <a class="row-ident" href="${href}" title="open ${escIdent}">${escIdent}</a>
    ${pill}
    <span class="grow"></span>
    ${meta}
  </div>
  <a class="row-title" href="${href}">${escapeHtml(i.title)}</a>
  ${peek}
  ${retryErr}
  ${triageActions}
  ${steering}
</article>`;
}

function renderSteeringInline(r: RunningRow): string {
  const question = (r.steering_question ?? '').trim() || '(no question text)';
  const context = (r.steering_context ?? '').trim();
  const issueTitle = (r.issue_title ?? '').trim();
  const issueBody = (r.issue_body ?? '').trim();
  const hasOriginalTask = issueTitle.length > 0 || issueBody.length > 0;
  const hasAnyExtra = hasOriginalTask || context.length > 0;
  // Stable textarea id + hx-preserve so the every-2s board repoll keeps the
  // operator's draft reply intact across morph swaps.
  const textareaId = `reply-${r.issue_identifier}`;
  const summaryLabel =
    hasOriginalTask && context
      ? 'original task & agent’s context'
      : hasOriginalTask
        ? 'original task'
        : 'agent’s context';
  return `<div class="steering">
  <div class="steering-q">${renderMarkdown(question)}</div>
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
        hx-target="#ticker" hx-swap="morph:innerHTML">
    <textarea id="${escapeHtml(textareaId)}" name="text" required
              placeholder="your reply…"
              aria-label="reply to ${escapeHtml(r.issue_identifier)}"
              hx-preserve="true"></textarea>
    <div class="reply-row">
      <span class="hint dim">enter to send · shift+enter for newline</span>
      <button type="submit" class="ghost">send reply</button>
    </div>
  </form>
</div>`;
}

// ─── Right-side new-issue panel (the One Card) ─────────────────────────
// The dashboard's only card-shaped surface (DESIGN.md §5 One-Card Rule). Slides
// in from the right edge when the operator clicks a column's `+` button; the
// column the click came from pre-selects the state field. Non-modal: the board
// stays visible and interactive on the left. Esc closes; backdrop clicks do not
// (avoid accidental discards of in-progress drafts).
function renderNewIssuePanel(p: PartialInputs): string {
  const targets = p.states.filter((s) => s.role !== 'terminal');
  const firstActive = p.states.find((s) => s.role === 'active');
  const defaultState = (firstActive ?? targets[0])?.name ?? '';
  const options = targets
    .map((s) => {
      const sel = s.name === defaultState ? ' selected' : '';
      return `<option value="${escapeHtml(s.name)}"${sel}>${escapeHtml(s.name)}</option>`;
    })
    .join('');
  return `<aside id="new-panel" class="new-panel" aria-hidden="true" aria-labelledby="np-title">
  <header class="np-head">
    <h2 id="np-title">new issue</h2>
    <button type="button" class="np-close" aria-label="close" title="close (esc)">×</button>
  </header>
  <form class="np-form" id="np-form">
    <label for="np-state">column</label>
    <select id="np-state" name="state" required>${options}</select>
    <label for="np-title-input">title</label>
    <input id="np-title-input" name="title" required autocomplete="off" placeholder="what needs doing?" />
    <label for="np-description">description</label>
    <textarea id="np-description" name="description" rows="6" placeholder="optional — context for the agent"></textarea>
    <div class="np-actions">
      <span class="np-msg" id="np-msg" role="status" aria-live="polite"></span>
      <button type="submit" class="np-submit">create</button>
    </div>
  </form>
</aside>`;
}

function renderTotalsPartial(p: PartialInputs): string {
  const t = p.snapshot.session_totals;
  if (!t || (t.input_tokens === 0 && t.output_tokens === 0 && t.seconds_running === 0)) return '';
  return `${formatTokens(t.input_tokens)} in · ${formatTokens(t.output_tokens)} out · ${formatTokens(t.total_tokens)} total · ${formatRuntime(t.seconds_running)} runtime`;
}

function renderDashboardHtml(p: PartialInputs): string {
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
html, body { background: var(--bench); color: var(--base); margin: 0; }
body {
  font: 14px/1.45 ui-sans-serif, system-ui, sans-serif;
  min-height: 100vh;
  display: flex; flex-direction: column;
}
code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.92em; color: var(--strong); }
.dim { color: var(--dim); }
.grow { flex: 1 1 auto; }

/* ── header strip ─────────────────────────────────────────────────────── */
#header {
  display: flex; align-items: center; gap: 0.5rem;
  padding: 0.65rem 1.25rem;
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

/* ── ticker ──────────────────────────────────────────────────────────── */
#ticker {
  display: flex; flex-wrap: wrap; gap: 0.5rem 1.25rem; align-items: center;
  padding: 0 1.25rem; background: var(--bench);
  border-bottom: 1px solid var(--rule-soft);
  font-size: 13px;
  transition: padding 200ms cubic-bezier(.22,1,.36,1),
              border-bottom-color 200ms cubic-bezier(.22,1,.36,1);
}
#ticker:empty { padding-top: 0; padding-bottom: 0; border-bottom-color: transparent; }
#ticker:not(:empty) { padding-top: 0.5rem; padding-bottom: 0.5rem; }
.tick { display: inline-flex; align-items: center; gap: 0.4rem; flex-wrap: wrap; }
.tick-label { color: var(--muted); font-variant-numeric: tabular-nums; }
.tick-await .tick-label { color: var(--await-fg); }
.tick-retry .tick-label { color: var(--retry-fg); }
.tick-err { color: var(--err); }
.tick-id {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  color: var(--base); text-decoration: none;
  border-bottom: 1px solid var(--rule-firm);
  font-size: 0.92em;
  padding-bottom: 1px;
}
.tick-id:hover, .tick-id:focus-visible { color: #9cc0ff; border-bottom-color: #9cc0ff; outline: none; }

/* ── board ───────────────────────────────────────────────────────────── */
#board {
  flex: 1 1 auto; min-height: 0;
  padding: 1rem 1.25rem 2.5rem;
  overflow-x: auto;
}
.kanban {
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: minmax(260px, 1fr);
  gap: 1.5rem;
  align-items: start;
  min-width: min-content;
}
.col { display: flex; flex-direction: column; min-width: 0; }
.col-head {
  display: flex; align-items: baseline; gap: 0.4rem;
  padding: 0 0 0.35rem;
  border-bottom: 1px solid var(--rule-firm);
  margin-bottom: 0.5rem;
}
.col-name {
  color: var(--muted); font-weight: 500; font-size: 14px;
  letter-spacing: 0.01em;
}
.col-holding .col-name { color: var(--retry-fg); }
.col-terminal .col-name { color: var(--dim); }
.col-count { color: var(--dim); font-size: 0.82em; font-variant-numeric: tabular-nums; }
.col-orphan {
  color: var(--err); font-size: 0.7em; letter-spacing: 0.05em;
  text-transform: uppercase; margin-left: 0.3rem;
}
.col-add {
  background: transparent; color: var(--muted);
  border: 1px solid var(--rule-firm); border-radius: 4px;
  width: 22px; height: 22px;
  display: inline-flex; align-items: center; justify-content: center;
  cursor: pointer; font: inherit; line-height: 1; font-size: 16px;
  transition: color 160ms cubic-bezier(.22,1,.36,1), border-color 160ms cubic-bezier(.22,1,.36,1);
}
.col-add:hover { color: var(--strong); border-color: var(--muted); }
.col-add:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.col-body { display: flex; flex-direction: column; }
.col-empty {
  padding: 0.4rem 0; margin: 0;
  font-size: 0.9em; color: var(--dim);
}
.col-empty code { color: var(--muted); }

/* ── row ─────────────────────────────────────────────────────────────── */
.row {
  padding: 0.55rem 0.6rem; margin: 0 -0.6rem;
  border-bottom: 1px solid var(--rule-soft);
  display: flex; flex-direction: column; gap: 0.2rem;
  border-radius: 3px;
}
.row:last-child { border-bottom: 0; }
.row-await { background: rgba(127, 181, 212, 0.07); }
.row-retry-stuck { background: rgba(240, 192, 96, 0.05); }
.row-orphan { opacity: 0.7; }
.row-head {
  display: flex; align-items: center; gap: 0.5rem;
  font-variant-numeric: tabular-nums;
}
.row-ident {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  color: var(--strong); text-decoration: none;
  font-size: 13px;
}
.row-ident:hover, .row-ident:focus-visible { color: #9cc0ff; outline: none; }
.pill {
  display: inline-block; padding: 0.1rem 0.55rem; border-radius: 999px;
  font-size: 0.78em; line-height: 1.4;
  font-variant-numeric: tabular-nums;
}
.pill.running { background: var(--run-bg); color: var(--run-fg); }
.pill.retrying { background: var(--retry-bg); color: var(--retry-fg); }
.pill.awaiting { background: var(--await-bg); color: var(--await-fg); }
.row-meta { color: var(--muted); font-size: 0.82em; }
.row-title {
  display: block;
  color: var(--base); text-decoration: none;
  font-size: 14px; line-height: 1.4;
  overflow-wrap: anywhere;
}
.row-title:hover, .row-title:focus-visible { color: var(--strong); outline: none; }
.row-peek {
  font-size: 0.85em; line-height: 1.4;
  overflow-wrap: anywhere;
  max-height: 2.85em; overflow: hidden;
}
.row-err {
  font-size: 0.85em; line-height: 1.35; color: var(--err);
  overflow-wrap: anywhere; word-break: break-word;
}
.row-actions { display: flex; gap: 0.4rem; margin-top: 0.2rem; }
.row-action { display: inline; margin: 0; padding: 0; }
.ghost {
  background: var(--chip); color: var(--base);
  border: 1px solid var(--rule-firm); border-radius: 4px;
  padding: 0.35rem 0.85rem; font: inherit; cursor: pointer;
  transition: border-color 180ms cubic-bezier(.22,1,.36,1);
}
.ghost:hover { border-color: var(--muted); }
.ghost:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.ghost-sm {
  background: transparent; color: var(--muted);
  border: 1px solid var(--rule-firm); border-radius: 3px;
  padding: 0.18rem 0.6rem; font: inherit; font-size: 0.82em; cursor: pointer;
  transition: color 160ms cubic-bezier(.22,1,.36,1), border-color 160ms cubic-bezier(.22,1,.36,1);
}
.ghost-sm:hover { color: var(--strong); border-color: var(--muted); }
.ghost-sm.danger:hover { color: var(--err); border-color: var(--err); }
.ghost-sm:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }

/* ── inline steering on awaiting rows ────────────────────────────────── */
.steering {
  margin-top: 0.45rem; padding-top: 0.45rem;
  border-top: 1px dashed var(--rule-firm);
  display: grid; gap: 0.4rem;
}
.steering-q { color: var(--strong); font-size: 0.95em; line-height: 1.45; }
.steering-q > :first-child { margin-top: 0; }
.steering-q > :last-child { margin-bottom: 0; }
.steering-q p { margin: 0.35em 0; }
.steering-q h1, .steering-q h2, .steering-q h3,
.steering-q h4, .steering-q h5, .steering-q h6 {
  margin: 0.5em 0 0.25em; font-weight: 500; font-size: 1em;
}
.steering-q ul, .steering-q ol { margin: 0.3em 0; padding-left: 1.4em; }
.steering-q li { margin: 0.15em 0; }
.steering-q code {
  background: var(--inset); padding: 0.05em 0.35em; border-radius: 3px; font-size: 0.92em;
}
.steering-q pre {
  margin: 0.5em 0; padding: 0.5rem 0.65rem;
  background: var(--inset); border: 1px solid var(--rule-firm); border-radius: 4px;
  font: 12.5px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  color: var(--muted); overflow: auto;
}
.steering-q pre code { background: transparent; padding: 0; font-size: inherit; }
.steering-q blockquote {
  margin: 0.35em 0; padding: 0.1em 0.7em;
  border-left: 2px solid var(--rule-firm); color: var(--muted);
}
.steering-q a { color: var(--await-fg); }
.steering-task { font-size: 0.88em; }
.steering-task > summary {
  cursor: pointer; list-style: none;
  color: var(--muted); padding: 0.2rem 0; user-select: none;
}
.steering-task > summary::-webkit-details-marker { display: none; }
.steering-task > summary::before {
  content: "▸"; padding-right: 0.4rem;
  transition: transform 180ms cubic-bezier(.22,1,.36,1);
  display: inline-block; color: var(--dim);
}
.steering-task[open] > summary::before { transform: rotate(90deg); }
.steering-task-body {
  display: grid; gap: 0.35rem;
  padding: 0.3rem 0 0 0.75rem;
}
.steering-task-label {
  font-size: 0.7em; color: var(--dim);
  letter-spacing: 0.08em; text-transform: uppercase;
}
.steering-task-body .issue-title {
  margin: 0; font-size: 0.95em; font-weight: 500; color: var(--base);
}
.steering-task-body .issue-body {
  margin: 0; color: var(--muted); font-size: 0.92em; line-height: 1.5;
}
.steering .context {
  margin: 0; padding: 0.5rem 0.65rem;
  background: var(--inset); border: 1px solid var(--rule-firm); border-radius: 4px;
  font: 12.5px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  color: var(--muted); white-space: pre-wrap; word-break: break-word;
  max-height: 12em; overflow: auto;
}
form.reply { display: grid; gap: 0.4rem; margin: 0; }
form.reply textarea {
  background: var(--inset); color: var(--strong);
  border: 1px solid var(--rule-firm); border-radius: 4px;
  padding: 0.45rem 0.6rem;
  font: 14px/1.5 ui-sans-serif, system-ui, sans-serif;
  width: 100%; min-height: 60px; resize: vertical;
}
form.reply textarea:focus-visible {
  outline: 1px solid var(--accent); outline-offset: 0; border-color: var(--accent);
}
form.reply .reply-row { display: flex; align-items: center; gap: 0.75rem; }
form.reply .hint { font-size: 0.82em; }

/* ── totals footer ───────────────────────────────────────────────────── */
footer.totals {
  padding: 0.85rem 1.25rem;
  border-top: 1px solid var(--rule-soft);
  color: var(--dim); font-size: 0.85em;
  font-variant-numeric: tabular-nums;
  display: flex; gap: 0.65rem; flex-wrap: wrap;
}
footer.totals:empty { display: none; }

/* ── right-side new-issue panel (the One Card) ───────────────────────── */
.new-panel {
  position: fixed; top: 0; right: 0;
  width: 400px; max-width: 90vw;
  height: 100vh;
  background: var(--raised);
  border-left: 1px solid var(--rule-firm);
  display: flex; flex-direction: column;
  transform: translateX(100%);
  transition: transform 320ms cubic-bezier(.22, 1, .36, 1),
              visibility 0s linear 320ms;
  visibility: hidden;
  z-index: 20;
}
.new-panel.open {
  transform: translateX(0);
  visibility: visible;
  transition: transform 320ms cubic-bezier(.22, 1, .36, 1);
}
.np-head {
  display: flex; align-items: center; gap: 0.75rem;
  padding: 1rem 1.25rem;
  border-bottom: 1px solid var(--rule-soft);
}
.np-head h2 { margin: 0; font-size: 1rem; font-weight: 500; color: var(--strong); }
.np-close {
  margin-left: auto;
  background: var(--chip); color: var(--muted);
  border: 1px solid var(--rule-firm); border-radius: 4px;
  width: 28px; height: 28px;
  cursor: pointer; font: inherit; font-size: 16px; line-height: 1;
  transition: color 160ms cubic-bezier(.22,1,.36,1), border-color 160ms cubic-bezier(.22,1,.36,1);
}
.np-close:hover { color: var(--strong); border-color: var(--muted); }
.np-close:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.np-form {
  display: flex; flex-direction: column; gap: 0.35rem;
  padding: 1rem 1.25rem; flex: 1; overflow: auto;
}
.np-form label {
  color: var(--muted); font-size: 14px; margin-top: 0.5rem;
}
.np-form label:first-of-type { margin-top: 0; }
.np-form select, .np-form input, .np-form textarea {
  background: var(--inset); color: var(--strong);
  border: 1px solid var(--rule-firm); border-radius: 4px;
  padding: 0.45rem 0.6rem; font: inherit; width: 100%;
}
.np-form textarea { resize: vertical; min-height: 120px; }
.np-form select:focus-visible,
.np-form input:focus-visible,
.np-form textarea:focus-visible {
  outline: 1px solid var(--accent); outline-offset: 0; border-color: var(--accent);
}
.np-actions {
  display: flex; align-items: center; gap: 0.75rem;
  margin-top: 0.9rem;
}
.np-msg {
  flex: 1; color: var(--muted); font-size: 0.88em;
  min-height: 1.2em; line-height: 1.2;
}
.np-msg.err { color: var(--err); }
.np-msg.ok { color: var(--run-fg); }
.np-submit {
  background: var(--accent); color: #f4f6fb; border: 0;
  padding: 0.55rem 1.1rem; border-radius: 4px;
  font: inherit; cursor: pointer;
  transition: filter 180ms cubic-bezier(.22,1,.36,1);
}
.np-submit:hover { filter: brightness(1.08); }
.np-submit:focus-visible { outline: 2px solid var(--strong); outline-offset: 2px; }

/* htmx ergonomics */
.htmx-request .refresh { opacity: 0.6; }
.htmx-settling .row-peek { opacity: 0.85; }
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

<div id="ticker"
     hx-get="/api/v1/partials/attention" hx-trigger="every 2s, refreshed from:body"
     hx-swap="morph:innerHTML">${renderAttentionPartial(p)}</div>

<main id="board"
      hx-get="/api/v1/partials/board" hx-trigger="every 2s, refreshed from:body"
      hx-swap="morph:innerHTML">${renderBoardPartial(p)}</main>

${renderNewIssuePanel(p)}

<footer class="totals"
        hx-get="/api/v1/partials/totals" hx-trigger="every 2s, refreshed from:body"
        hx-swap="morph:innerHTML">${renderTotalsPartial(p)}</footer>

<script>
(() => {
  const $ = (id) => document.getElementById(id);
  const panel = $('new-panel');
  const stateSelect = $('np-state');
  const titleInput = $('np-title-input');
  const descTextarea = $('np-description');
  const npMsg = $('np-msg');
  const form = $('np-form');

  const setMsg = (text, cls) => {
    npMsg.className = 'np-msg' + (cls ? ' ' + cls : '');
    npMsg.textContent = text;
  };

  const openPanel = (targetState) => {
    if (targetState) {
      for (const opt of stateSelect.options) {
        if (opt.value === targetState) { stateSelect.value = targetState; break; }
      }
    }
    setMsg('');
    panel.classList.add('open');
    panel.setAttribute('aria-hidden', 'false');
    requestAnimationFrame(() => setTimeout(() => titleInput.focus(), 120));
  };
  const closePanel = () => {
    panel.classList.remove('open');
    panel.setAttribute('aria-hidden', 'true');
  };

  document.addEventListener('click', (ev) => {
    const t = ev.target;
    if (!(t instanceof Element)) return;
    const addBtn = t.closest('.col-add');
    if (addBtn) {
      openPanel(addBtn.getAttribute('data-target-state') || '');
      return;
    }
    if (t.closest('.np-close')) { closePanel(); return; }
  });

  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && panel.classList.contains('open')) {
      ev.preventDefault(); closePanel(); return;
    }
    const t = ev.target;
    if (!(t instanceof HTMLTextAreaElement)) return;
    if (!t.closest('form.reply')) return;
    if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) {
      ev.preventDefault();
      t.form && t.form.requestSubmit();
    }
  });

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    setMsg('creating…');
    const body = {
      state: stateSelect.value,
      title: titleInput.value.trim(),
      description: descTextarea.value,
    };
    try {
      const res = await fetch('/api/v1/issues', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error((data && data.error && data.error.message) || ('HTTP ' + res.status));
      setMsg('created ' + data.identifier, 'ok');
      titleInput.value = '';
      descTextarea.value = '';
      fetch('/api/v1/refresh', { method: 'POST' }).catch(() => {});
      document.body.dispatchEvent(new CustomEvent('refreshed', { bubbles: true }));
      setTimeout(() => { closePanel(); setMsg(''); }, 900);
    } catch (err) {
      setMsg(err.message, 'err');
    }
  });
})();
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

// ─── Per-route handler dispatch ─────────────────────────────────────────
// matchRoute (in http-handlers.ts) returns a discriminated union; the table below
// maps each route kind to a thin shell handler. The handler signature carries the
// narrowed route variant so each function sees the parsed identifier/action it
// expects without a manual cast. Everything that decides "what to do" lives in
// http-handlers; everything here is IO + response writing.
interface HandlerCtx<R extends Route> {
  req: IncomingMessage;
  res: ServerResponse;
  orch: Orchestrator;
  opts: HttpServerOptions;
  view: ReturnType<HttpServerOptions['getTrackerView']>;
  method: string;
  route: R;
}
type RouteHandlers = {
  [K in Route['kind']]: (ctx: HandlerCtx<Extract<Route, { kind: K }>>) => Promise<void>;
};

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  orch: Orchestrator,
  opts: HttpServerOptions,
): Promise<void> {
  // URL parsing inside the handler so a malformed Host header doesn't crash the listener.
  let pathname: string;
  try {
    pathname = new URL(req.url ?? '/', 'http://symphony.local').pathname;
  } catch {
    return badRequest(res, 'invalid request URL');
  }
  const method = (req.method ?? 'GET').toUpperCase();
  const view = opts.getTrackerView();
  const route = matchRoute(pathname);
  const handler = ROUTE_HANDLERS[route.kind] as (
    ctx: HandlerCtx<Route>,
  ) => Promise<void>;
  await handler({ req, res, orch, opts, view, method, route });
}

async function handleDashboard(ctx: HandlerCtx<{ kind: 'dashboard' }>): Promise<void> {
  if (ctx.method !== 'GET') return methodNotAllowed(ctx.res);
  const p = await gatherPartialInputs(ctx.orch, ctx.view);
  ctx.res.statusCode = 200;
  ctx.res.setHeader('content-type', 'text/html; charset=utf-8');
  ctx.res.end(renderDashboardHtml(p));
}

// Static preview for impeccable live mode. The file under .impeccable/preview/ is a
// captured snapshot of the dashboard with polling disabled, used as a variant playground.
// Read on every request so live-wrap edits land immediately.
async function handlePreview(ctx: HandlerCtx<{ kind: 'preview' }>): Promise<void> {
  if (ctx.method !== 'GET') return methodNotAllowed(ctx.res);
  try {
    const html = await readFile('.impeccable/preview/dashboard.html', 'utf8');
    ctx.res.statusCode = 200;
    ctx.res.setHeader('content-type', 'text/html; charset=utf-8');
    ctx.res.setHeader('cache-control', 'no-store');
    ctx.res.end(html);
  } catch (err) {
    notFound(ctx.res, 'preview_missing', `preview not available: ${(err as Error).message}`);
  }
}

// HTMX partials. Each region polls its own endpoint at 2s; this is what the dashboard
// <section hx-get=...> elements consume. They return only the inner HTML; the outer
// wrapper is in the dashboard shell.
async function handlePartial(ctx: HandlerCtx<{ kind: 'partial'; slug: string }>): Promise<void> {
  if (ctx.method !== 'GET') return methodNotAllowed(ctx.res);
  const name = resolvePartialName(ctx.route.slug);
  if (!name) {
    return notFound(ctx.res, 'partial_not_found', `partial ${ctx.route.slug} does not exist`);
  }
  const p = await gatherPartialInputs(ctx.orch, ctx.view);
  const body =
    name === 'header' ? renderHeaderPartial(p)
    : name === 'attention' ? renderAttentionPartial(p)
    : name === 'board' ? renderBoardPartial(p)
    : renderTotalsPartial(p);
  ctx.res.statusCode = 200;
  ctx.res.setHeader('content-type', 'text/html; charset=utf-8');
  ctx.res.setHeader('cache-control', 'no-store');
  ctx.res.end(body);
}

async function handleState(ctx: HandlerCtx<{ kind: 'state' }>): Promise<void> {
  if (ctx.method !== 'GET') return methodNotAllowed(ctx.res);
  jsonResponse(ctx.res, 200, ctx.orch.snapshot());
}

async function handleRefresh(ctx: HandlerCtx<{ kind: 'refresh' }>): Promise<void> {
  if (ctx.method !== 'POST') return methodNotAllowed(ctx.res);
  const status = ctx.orch.triggerRefresh();
  jsonResponse(ctx.res, 202, {
    ...status,
    requested_at: new Date().toISOString(),
    operations: ['poll', 'reconcile'],
  });
}

async function handleIssues(ctx: HandlerCtx<{ kind: 'issues' }>): Promise<void> {
  if (ctx.method === 'GET') return handleListIssues(ctx);
  if (ctx.method === 'POST') return handleCreateIssue(ctx);
  methodNotAllowed(ctx.res);
}

async function handleListIssues(ctx: HandlerCtx<{ kind: 'issues' }>): Promise<void> {
  const root = ctx.view.trackerRoot;
  if (!root) return jsonResponse(ctx.res, 200, { issues: [] });
  const issues = await listIssuesFromDisk(root);
  jsonResponse(ctx.res, 200, { issues });
}

async function handleCreateIssue(ctx: HandlerCtx<{ kind: 'issues' }>): Promise<void> {
  const root = ctx.view.trackerRoot;
  if (!root) return badRequest(ctx.res, 'tracker.root not configured');
  let body: unknown;
  try {
    body = await readJsonBody(ctx.req);
  } catch (err) {
    return badRequest(ctx.res, (err as Error).message);
  }
  const decision = decideCreateIssue(body, ctx.view.states);
  if (!decision.ok) {
    return jsonResponse(ctx.res, decision.status, {
      error: { code: decision.code, message: decision.message },
    });
  }
  try {
    const created = await writeIssueFile({
      trackerRoot: root,
      identifier: decision.identifier,
      title: decision.title,
      state: decision.state,
      description: decision.description,
      priority: decision.priority,
      labels: decision.labels,
      blocked_by: decision.blocked_by,
    });
    log.info('issue created via http', { identifier: created.identifier, state: created.state });
    jsonResponse(ctx.res, 201, created);
  } catch (err) {
    jsonResponse(ctx.res, 409, {
      error: { code: 'create_failed', message: (err as Error).message },
    });
  }
}

// MCP JSON-RPC endpoint: agent (inside the smolvm) POSTs JSON-RPC envelopes here. The
// URL is per-issue (the agent only knows its own /<id>/mcp), backed by a bearer token
// generated at dispatch. Both layers are belt-and-braces against the no-auth 8787 socket.
async function handleMcp(
  ctx: HandlerCtx<{ kind: 'mcp'; identifier: string }>,
): Promise<void> {
  if (ctx.method !== 'POST') return methodNotAllowed(ctx.res);
  const mcp = ctx.opts.mcp;
  if (!mcp) return notFound(ctx.res, 'mcp_disabled', 'mcp endpoint not enabled');
  const { identifier } = ctx.route;
  const auth = (ctx.req.headers['authorization'] ?? ctx.req.headers['Authorization']) as
    | string
    | undefined;
  const token = extractBearerToken(auth);
  if (!token) return jsonResponse(ctx.res, 401, { error: { code: 'unauthorized', message: 'bearer token required' } });
  if (!mcp.isActive(identifier, token)) {
    return jsonResponse(ctx.res, 404, {
      error: { code: 'not_found', message: 'issue not active or token mismatch' },
    });
  }
  let body: unknown;
  try {
    body = await readJsonBody(ctx.req);
  } catch (err) {
    return badRequest(ctx.res, (err as Error).message);
  }
  const reply = await mcp.handleJsonRpc(identifier, token, body);
  if (reply === null) {
    // JSON-RPC notification (no id) → 204 No Content
    ctx.res.statusCode = 204;
    ctx.res.end();
    return;
  }
  jsonResponse(ctx.res, 200, reply);
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
async function handleSteeringReply(
  ctx: HandlerCtx<{ kind: 'steering'; identifier: string }>,
): Promise<void> {
  if (ctx.method !== 'POST') return methodNotAllowed(ctx.res);
  const mcp = ctx.opts.mcp;
  if (!mcp) return notFound(ctx.res, 'mcp_disabled', 'steering endpoint not enabled');
  const { identifier } = ctx.route;
  const isHtmx = ctx.req.headers['hx-request'] === 'true';
  const ctype = classifyContentType(ctx.req.headers['content-type']);
  const csrf = checkSteeringCsrf(ctype, isHtmx, isSameOriginRequest(ctx.req));
  if (!csrf.ok) {
    return jsonResponse(ctx.res, csrf.status, {
      error: { code: csrf.code, message: csrf.message },
    });
  }
  const text = await readSteeringText(ctx, ctype);
  if (text === null) return;
  if (!text) {
    return htmxOrJsonError(
      ctx.res, isHtmx, ctx.orch, ctx.view, 400, 'bad_request',
      'text is required and must be a non-empty string',
    );
  }
  if (!mcp.submitSteeringReply(identifier, text)) {
    return htmxOrJsonError(
      ctx.res, isHtmx, ctx.orch, ctx.view, 409, 'no_pending_steering',
      'no agent is awaiting steering for this issue',
    );
  }
  await respondSteeringAccepted(ctx, isHtmx, identifier);
}

async function respondSteeringAccepted(
  ctx: HandlerCtx<{ kind: 'steering'; identifier: string }>,
  isHtmx: boolean,
  identifier: string,
): Promise<void> {
  if (isHtmx) {
    const p = await gatherPartialInputs(ctx.orch, ctx.view);
    ctx.res.statusCode = 200;
    ctx.res.setHeader('content-type', 'text/html; charset=utf-8');
    ctx.res.end(renderAttentionPartial(p));
    return;
  }
  jsonResponse(ctx.res, 202, { identifier, accepted_at: new Date().toISOString() });
}

// Returns null when the body read errored and a response has already been written;
// otherwise returns the extracted text (empty string if absent/blank, caller treats
// that as the "no text supplied" case).
async function readSteeringText(
  ctx: HandlerCtx<{ kind: 'steering'; identifier: string }>,
  ctype: ReturnType<typeof classifyContentType>,
): Promise<string | null> {
  const isHtmx = ctx.req.headers['hx-request'] === 'true';
  if (ctype.isFormBody) {
    try {
      return extractFormText(await readTextBody(ctx.req));
    } catch (err) {
      await htmxOrJsonError(
        ctx.res, isHtmx, ctx.orch, ctx.view, 400, 'bad_request', (err as Error).message,
      );
      return null;
    }
  }
  try {
    return extractJsonText(await readJsonBody(ctx.req));
  } catch (err) {
    badRequest(ctx.res, (err as Error).message);
    return null;
  }
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
async function handleTriage(
  ctx: HandlerCtx<{ kind: 'triage'; identifier: string; action: 'approve' | 'discard' }>,
): Promise<void> {
  if (ctx.method !== 'POST') return methodNotAllowed(ctx.res);
  const tracker = ctx.opts.tracker;
  if (!tracker || !tracker.moveIssueToState) {
    return notFound(ctx.res, 'tracker_no_state_transitions', 'tracker does not support state transitions');
  }
  const root = ctx.view.trackerRoot;
  if (!root) return badRequest(ctx.res, 'tracker.root not configured');
  const { identifier, action } = ctx.route;
  const ctype = classifyContentType(ctx.req.headers['content-type']);
  const csrf = checkTriageCsrf(ctype, ctx.req.headers['hx-request'] === 'true', isSameOriginRequest(ctx.req));
  if (!csrf.ok) {
    return jsonResponse(ctx.res, csrf.status, {
      error: { code: csrf.code, message: csrf.message },
    });
  }
  const transition = decideTriageTransition(action, ctx.view.states);
  if (!transition.ok) {
    return jsonResponse(ctx.res, transition.status, {
      error: { code: transition.code, message: transition.message },
    });
  }
  await runTriageMove(ctx, tracker, root, identifier, action, transition.toState, transition.fromState);
}

async function runTriageMove(
  ctx: HandlerCtx<{ kind: 'triage'; identifier: string; action: 'approve' | 'discard' }>,
  tracker: NonNullable<HttpServerOptions['tracker']>,
  root: string,
  identifier: string,
  action: 'approve' | 'discard',
  toState: string,
  fromState: string,
): Promise<void> {
  const isHtmx = ctx.req.headers['hx-request'] === 'true';
  try {
    const result = await tracker.moveIssueToState!(identifier, toState, { fromRoot: root, fromState });
    log.info('triage action', { identifier, action, from: result.fromState, to: result.toState });
    // Nudge the orchestrator to pick the freshly approved issue up immediately instead
    // of waiting for the next poll tick. Best-effort: triggerRefresh is idempotent.
    if (action === 'approve') {
      try { ctx.orch.triggerRefresh(); } catch { /* refresh request is fire-and-forget */ }
    }
    if (isHtmx) return writeBoardPartial(ctx);
    jsonResponse(ctx.res, 200, {
      identifier, action, from_state: result.fromState, to_state: result.toState,
    });
  } catch (err) {
    const code = (err as Error & { code?: string }).code ?? 'triage_failed';
    const status = code === 'local_issue_not_found' ? 404 : 409;
    if (isHtmx) return writeBoardPartial(ctx);
    jsonResponse(ctx.res, status, { error: { code, message: (err as Error).message } });
  }
}

// Re-render the whole board after a triage move. HTMX morph keeps unchanged columns
// stable; only the row that moved (or "failed" and stayed) redraws.
async function writeBoardPartial(ctx: HandlerCtx<{ kind: 'triage'; identifier: string; action: 'approve' | 'discard' }>): Promise<void> {
  const p = await gatherPartialInputs(ctx.orch, ctx.view);
  ctx.res.statusCode = 200;
  ctx.res.setHeader('content-type', 'text/html; charset=utf-8');
  ctx.res.setHeader('cache-control', 'no-store');
  ctx.res.end(renderBoardPartial(p));
}

// Read-only HTML view of one issue. Linked from the identifier on every "on disk" and
// triage row; renders front-matter (labels, priority, blockers, provenance) plus the
// Markdown body so an operator can read the full task without leaving the browser. No
// editing surface — actions stay on the dashboard. Source of truth is the on-disk .md
// file, found by walking every state directory under tracker.root for a basename match.
async function handleDetailHtml(
  ctx: HandlerCtx<{ kind: 'detail_html'; identifier: string }>,
): Promise<void> {
  if (ctx.method !== 'GET') return methodNotAllowed(ctx.res);
  const root = ctx.view.trackerRoot;
  if (!root) {
    ctx.res.statusCode = 404;
    ctx.res.setHeader('content-type', 'text/html; charset=utf-8');
    ctx.res.end(renderIssueNotFoundPage('(tracker root not configured)', ctx.view));
    return;
  }
  const { identifier } = ctx.route;
  const issue = await readIssueFromDisk(root, identifier);
  if (!issue) {
    ctx.res.statusCode = 404;
    ctx.res.setHeader('content-type', 'text/html; charset=utf-8');
    ctx.res.end(renderIssueNotFoundPage(identifier, ctx.view));
    return;
  }
  ctx.res.statusCode = 200;
  ctx.res.setHeader('content-type', 'text/html; charset=utf-8');
  ctx.res.setHeader('cache-control', 'no-store');
  ctx.res.end(renderIssueDetailPage(issue, ctx.view));
}

async function handleDetailJson(
  ctx: HandlerCtx<{ kind: 'detail_json'; identifier: string }>,
): Promise<void> {
  if (ctx.method !== 'GET') return methodNotAllowed(ctx.res);
  const { identifier } = ctx.route;
  const detail = ctx.orch.detailByIdentifier(identifier);
  if (!detail) return notFound(ctx.res, 'issue_not_found', `issue ${identifier} is not tracked`);
  jsonResponse(ctx.res, 200, detail);
}

async function handleNotFoundRoute(ctx: HandlerCtx<{ kind: 'not_found' }>): Promise<void> {
  notFound(ctx.res);
}

const ROUTE_HANDLERS: RouteHandlers = {
  dashboard: handleDashboard,
  preview: handlePreview,
  partial: handlePartial,
  state: handleState,
  refresh: handleRefresh,
  issues: handleIssues,
  mcp: handleMcp,
  steering: handleSteeringReply,
  triage: handleTriage,
  detail_html: handleDetailHtml,
  detail_json: handleDetailJson,
  not_found: handleNotFoundRoute,
};

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
