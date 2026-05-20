// File-creation helpers shared between the HTTP dashboard's POST /api/v1/issues handler
// and the MCP propose_issue tool. Both write a Markdown file with YAML front matter into
// `<tracker.root>/<state>/<identifier>.md`; this module owns the slug + collision logic
// and the front-matter serializer so the two callers can't drift.
//
// State-of-file shape is the local-tracker contract: see src/trackers/local.ts for the
// reader side.

import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { sanitizeWorkspaceKey } from './workspace.js';
import type { StateConfig } from './types.js';

/**
 * Thrown by `pickHoldingState` when no `holding`-role state is declared. The
 * workflow parser refuses configs without one, so reaching this path implies a
 * programmer error or a hand-mutated config — callers that surface this to
 * agents (the MCP propose_issue tool, the HTTP triage handler) should produce
 * a structured `no_holding_state` error rather than a generic message.
 */
export class NoHoldingStateError extends Error {
  constructor() {
    super('no holding state declared in workflow');
    this.name = 'NoHoldingStateError';
  }
}

/**
 * First declared `holding` state in declaration order. Shared between the MCP
 * `propose_issue` tool (where new agent-proposed issues land) and the HTTP
 * triage approve/discard handler (where the from-state is implied). Throws
 * `NoHoldingStateError` when no holding state is declared.
 */
export function pickHoldingState(states: Record<string, StateConfig>): string {
  for (const [name, cfg] of Object.entries(states)) {
    if (cfg.role === 'holding') return name;
  }
  throw new NoHoldingStateError();
}

/**
 * Names of every `role: active` state in declaration order. Used by the
 * orchestrator's eligibility/reconciliation paths, the local tracker's
 * candidate filter, and the HTTP dashboard's default-state lookup. Replaces
 * the derived `tracker.active_states` list that was removed in Cleanup 4.
 */
export function activeStateNames(states: Record<string, StateConfig>): string[] {
  const out: string[] = [];
  for (const [name, cfg] of Object.entries(states)) {
    if (cfg.role === 'active') out.push(name);
  }
  return out;
}

/**
 * Names of every `role: terminal` state in declaration order. Mirror of
 * `activeStateNames` for the terminal role — used by the orchestrator's
 * reconcile/eligibility/cleanup paths and by the local tracker.
 */
export function terminalStateNames(states: Record<string, StateConfig>): string[] {
  const out: string[] = [];
  for (const [name, cfg] of Object.entries(states)) {
    if (cfg.role === 'terminal') out.push(name);
  }
  return out;
}

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
