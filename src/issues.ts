// File-creation helpers shared between the HTTP dashboard's POST /api/v1/issues handler
// and the MCP propose_issue tool. Both write a Markdown file with YAML front matter into
// `<tracker.root>/<state>/<identifier>.md`; this module owns the slug + collision logic
// and the front-matter serializer so the two callers can't drift.
//
// State-of-file shape is the local-tracker contract: see src/trackers/local.ts for the
// reader side.

import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { sanitizeWorkspaceKey } from './workspace.js';

// Where agent-proposed issues land. The state directory is not in `tracker.active_states`
// (so the orchestrator never dispatches it) and not in `terminal_states` (so the tracker
// doesn't treat it as completed). The operator approves a proposal from the dashboard,
// which moves it into the first active state (typically Todo).
export const TRIAGE_STATE = 'Triage';

// Slugify a title into a filename-safe identifier. Lowercase ASCII with single-dash
// separators; trims to a sensible length so the on-disk path stays readable. Falls back to
// `issue` when the title is empty after stripping.
export function slugifyTitle(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return slug.length > 0 ? slug : 'issue';
}

// Walk every state directory under `trackerRoot` and return the set of issue identifiers
// (filename stem) currently present. Used to pick a unique suffix when deriving an
// identifier from a title — checking only the target state directory would let a `Done/foo.md`
// silently shadow a freshly created `Todo/foo.md` once it moves out of Todo.
export async function collectExistingIdentifiers(trackerRoot: string): Promise<Set<string>> {
  const out = new Set<string>();
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
      if (f.endsWith('.md')) out.add(f.slice(0, -3));
    }
  }
  return out;
}

export interface WriteIssueFileInput {
  trackerRoot: string;
  /** Explicit identifier from the caller; when omitted, derived from `title`. */
  identifier?: string;
  state: string;
  title: string;
  description?: string;
  priority?: number | null;
  labels?: string[];
  blocked_by?: string[];
  /**
   * Extra front-matter keys serialized after the standard set. Used by the MCP
   * propose_issue tool to stamp `proposed_by` (the calling issue's identifier)
   * and `proposed_at` (ISO timestamp) so the operator can see provenance in the
   * dashboard and in the file itself.
   */
  extra_front_matter?: Record<string, string | number | boolean>;
}

export interface WriteIssueFileResult {
  path: string;
  identifier: string;
  state: string;
}

/**
 * Used by the dashboard form and the MCP propose_issue tool. The local tracker stores
 * issues at `<tracker.root>/<state>/<identifier>.md` with YAML front matter; identifier
 * sanitization re-uses the workspace key rules so the file name is always safe across
 * the rest of the orchestrator.
 */
export async function writeIssueFile(input: WriteIssueFileInput): Promise<WriteIssueFileResult> {
  const stateDir = path.join(input.trackerRoot, input.state);
  await mkdir(stateDir, { recursive: true });
  let ident: string;
  let filePath: string;
  const explicit = (input.identifier ?? '').trim();
  if (explicit.length > 0) {
    ident = sanitizeWorkspaceKey(explicit);
    if (!ident) throw new Error('identifier must contain at least one allowed character');
    filePath = path.join(stateDir, `${ident}.md`);
    try {
      await stat(filePath);
      throw new Error(`issue ${ident} already exists at ${filePath}`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  } else {
    // No identifier supplied → derive a slug from the title and disambiguate against
    // collisions across every state directory under the tracker root, so a `-2` suffix
    // appears whenever the same titled issue already exists anywhere (Todo / Done / etc).
    const base = slugifyTitle(input.title);
    const existing = await collectExistingIdentifiers(input.trackerRoot);
    ident = base;
    let n = 2;
    while (existing.has(ident)) {
      ident = `${base}-${n}`;
      n += 1;
    }
    filePath = path.join(stateDir, `${ident}.md`);
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
  if (input.extra_front_matter) {
    for (const [k, v] of Object.entries(input.extra_front_matter)) {
      fm[k] = v;
    }
  }

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

// Surgical front-matter edit: replace the `priority:` line in an existing issue file with
// `priority: <n>`, leaving the rest of the file (key order, quoting, whitespace, body)
// untouched. Inserts the line just before the closing fence when the file has no existing
// priority. Used by the dashboard's rerank endpoint: the operator clicks ▲/▼ on a Todo row
// and we rewrite priorities to materialize the new order without round-tripping YAML.
//
// The dispatcher already sorts by `priority` ASC (null last), so a dense per-state numbering
// (1, 2, 3, …) is exactly what surfaces the operator's chosen order on the next poll. Files
// whose priority would not change are not touched.
export function rewriteFrontMatterPriority(text: string, priority: number): string {
  const lines = text.split(/\r?\n/);
  const fence = (l: string | undefined) => /^---\s*$/.test(l ?? '');
  if (!fence(lines[0])) {
    throw new Error('issue file has no YAML front matter');
  }
  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (fence(lines[i])) {
      endIdx = i;
      break;
    }
  }
  if (endIdx < 0) {
    throw new Error('issue file front matter is unterminated');
  }
  const newLine = `priority: ${priority}`;
  let priorityIdx = -1;
  for (let i = 1; i < endIdx; i++) {
    if (/^priority\s*:/.test(lines[i] ?? '')) {
      priorityIdx = i;
      break;
    }
  }
  if (priorityIdx !== -1) {
    if (lines[priorityIdx] === newLine) return text;
    lines[priorityIdx] = newLine;
  } else {
    lines.splice(endIdx, 0, newLine);
  }
  return lines.join('\n');
}

// Per-state listing used by the dashboard's rerank action. Reads every `.md` file under
// `<trackerRoot>/<state>/`, pulls the dispatch-sort fields (priority, created_at) out of
// the front matter, and returns the rows sorted exactly the way the orchestrator sorts
// candidates: priority ASC (null last), then created_at ASC, then identifier ASC. Mirroring
// that order means what the operator sees on disk and what they click ▲/▼ to rearrange is
// the dispatcher's actual queue, not a separate view.
export interface RerankRow {
  identifier: string;
  filePath: string;
  priority: number | null;
  createdAt: string | null;
  text: string;
}

export async function readStateForRerank(
  trackerRoot: string,
  state: string,
): Promise<RerankRow[]> {
  const dirPath = path.join(trackerRoot, state);
  let files: string[];
  try {
    files = await readdir(dirPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const rows: RerankRow[] = [];
  for (const file of files) {
    if (!file.endsWith('.md')) continue;
    const filePath = path.join(dirPath, file);
    let text: string;
    try {
      text = await readFile(filePath, 'utf8');
    } catch {
      continue;
    }
    rows.push({
      identifier: file.slice(0, -3),
      filePath,
      priority: extractFrontMatterInt(text, 'priority'),
      createdAt: extractFrontMatterString(text, 'created_at'),
      text,
    });
  }
  rows.sort(compareDispatchOrder);
  return rows;
}

// Same sort key as Orchestrator.sortForDispatch — priority ASC with null last, then
// created_at ASC, then identifier. Kept here so the dashboard's listing and the rerank
// computation don't drift from the orchestrator. If §8.2 changes, both move together.
export function compareDispatchOrder(
  a: { priority: number | null; createdAt: string | null; identifier: string },
  b: { priority: number | null; createdAt: string | null; identifier: string },
): number {
  const pa = a.priority ?? Number.POSITIVE_INFINITY;
  const pb = b.priority ?? Number.POSITIVE_INFINITY;
  if (pa !== pb) return pa - pb;
  const ca = a.createdAt ? Date.parse(a.createdAt) : Number.POSITIVE_INFINITY;
  const cb = b.createdAt ? Date.parse(b.createdAt) : Number.POSITIVE_INFINITY;
  if (Number.isFinite(ca) && Number.isFinite(cb) && ca !== cb) return ca - cb;
  return a.identifier.localeCompare(b.identifier);
}

// Cheap regex extractors that mirror the dashboard's existing front-matter probes. The
// authoritative YAML reader lives in trackers/local.ts; this is sufficient for the dispatch
// key fields the rerank flow needs (priority, created_at) and avoids pulling the yaml
// parser into a code path that only cares about two scalar values.
function extractFrontMatterInt(text: string, key: string): number | null {
  const v = extractFrontMatterString(text, key);
  if (v === null) return null;
  if (!/^-?\d+$/.test(v)) return null;
  return parseInt(v, 10);
}

function extractFrontMatterString(text: string, key: string): string | null {
  const re = new RegExp(`^---[\\s\\S]*?\\n${key}:\\s*(.+)\\n[\\s\\S]*?^---`, 'm');
  const m = re.exec(text);
  if (!m) return null;
  return m[1]!.trim().replace(/^["'](.*)["']$/, '$1');
}

export type RerankDirection = 'up' | 'down';

export class RerankError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'RerankError';
  }
}

export interface RerankResult {
  identifier: string;
  state: string;
  direction: RerankDirection;
  fromIndex: number;
  toIndex: number;
  changed: Array<{ identifier: string; priority: number }>;
}

/**
 * Swap the issue at `identifier` with its visible neighbour in `direction` within
 * `state`, by rewriting the `priority:` front-matter line on whichever files need to
 * change. Returns the resulting (state-local) order plus the diff that was persisted so
 * the HTTP handler can log a one-liner.
 *
 * At a boundary (top + up, bottom + down) returns a no-op result (`fromIndex === toIndex`,
 * `changed: []`). The dashboard treats that as success and just re-renders the row in the
 * same place.
 *
 * Writes are best-effort sequential — a fatal mid-write fault leaves the on-disk priorities
 * partially updated. The next render will reflect whatever made it to disk, and a subsequent
 * click can finish the move; we accept that over a copy-and-rename ceremony for what is
 * single-operator local tooling.
 */
export async function rerankIssueInState(
  trackerRoot: string,
  state: string,
  identifier: string,
  direction: RerankDirection,
): Promise<RerankResult> {
  const rows = await readStateForRerank(trackerRoot, state);
  const idx = rows.findIndex((r) => r.identifier === identifier);
  if (idx === -1) {
    throw new RerankError('rerank_issue_not_found', `no .md file matches ${identifier} in ${state}`);
  }
  const target = idx + (direction === 'up' ? -1 : 1);
  if (target < 0 || target >= rows.length) {
    return {
      identifier,
      state,
      direction,
      fromIndex: idx,
      toIndex: idx,
      changed: [],
    };
  }
  const reordered = rows.slice();
  const [moved] = reordered.splice(idx, 1);
  reordered.splice(target, 0, moved!);
  const changed: Array<{ identifier: string; priority: number }> = [];
  for (let i = 0; i < reordered.length; i++) {
    const row = reordered[i]!;
    const newPriority = i + 1;
    if (row.priority === newPriority) continue;
    const nextText = rewriteFrontMatterPriority(row.text, newPriority);
    if (nextText === row.text) continue;
    await writeFile(row.filePath, nextText, 'utf8');
    changed.push({ identifier: row.identifier, priority: newPriority });
  }
  return {
    identifier,
    state,
    direction,
    fromIndex: idx,
    toIndex: target,
    changed,
  };
}
