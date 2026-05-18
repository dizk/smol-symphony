// Filesystem-backed tracker that reads issues from
//   <tracker.root>/<state>/<identifier>.md
//
// Each .md file has YAML front matter:
//   ---
//   id: ABC-1            # optional; defaults to basename
//   identifier: ABC-1    # optional; defaults to basename
//   title: ...
//   priority: 2          # optional
//   labels: [bug, foo]   # optional
//   blocked_by: [ABC-2]  # optional, list of identifiers
//   branch_name: feat/x  # optional
//   url: https://...     # optional
//   created_at: 2026-05-18T12:00:00Z   # optional
//   updated_at: 2026-05-18T13:00:00Z   # optional
//   ---
//   <description body>
//
// The state of an issue is taken verbatim from the parent directory name.
// State comparison is case-insensitive (SPEC §4.2 "Normalized Issue State").

import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { Issue, BlockerRef, TrackerConfig } from '../types.js';
import type { IssueTracker } from './types.js';
import { TrackerError } from './types.js';
import { log } from '../logging.js';

interface RawIssueFile {
  filePath: string;
  identifier: string;
  state: string;
  frontMatter: Record<string, unknown>;
  description: string;
}

function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function asStringList(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
  return [];
}

function asInt(v: unknown): number | null {
  if (typeof v === 'number' && Number.isInteger(v)) return v;
  if (typeof v === 'string' && /^-?\d+$/.test(v)) return parseInt(v, 10);
  return null;
}

function asTimestamp(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (v instanceof Date) return v.toISOString();
  return null;
}

function splitFrontMatter(text: string): { config: Record<string, unknown>; body: string } {
  if (!text.startsWith('---')) return { config: {}, body: text.trim() };
  const lines = text.split(/\r?\n/);
  const isFence = (l: string | undefined) => /^---\s*$/.test(l ?? '');
  if (!isFence(lines[0])) return { config: {}, body: text.trim() };
  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (isFence(lines[i])) {
      endIdx = i;
      break;
    }
  }
  if (endIdx < 0) return { config: {}, body: text.trim() };
  const fmText = lines.slice(1, endIdx).join('\n').trim();
  const body = lines.slice(endIdx + 1).join('\n').trim();
  let parsed: unknown = {};
  if (fmText.length > 0) {
    try {
      parsed = parseYaml(fmText);
    } catch (err) {
      throw new TrackerError(
        'local_issue_parse_error',
        `failed to parse front matter: ${(err as Error).message}`,
      );
    }
  }
  if (parsed === null || parsed === undefined) parsed = {};
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TrackerError('local_issue_parse_error', 'issue front matter must be a map');
  }
  return { config: parsed as Record<string, unknown>, body };
}

export class LocalMarkdownTracker implements IssueTracker {
  constructor(private cfg: TrackerConfig) {
    if (!cfg.root) throw new TrackerError('local_no_root', 'tracker.root is required');
  }

  updateConfig(cfg: TrackerConfig): void {
    if (!cfg.root) throw new TrackerError('local_no_root', 'tracker.root is required');
    this.cfg = cfg;
  }

  private get root(): string {
    return this.cfg.root!;
  }

  async fetchCandidateIssues(): Promise<Issue[]> {
    const all = await this.scanAll();
    const active = new Set(this.cfg.active_states.map((s) => s.toLowerCase()));
    const terminal = new Set(this.cfg.terminal_states.map((s) => s.toLowerCase()));
    const filtered = all.filter((raw) => {
      const s = raw.state.toLowerCase();
      return active.has(s) && !terminal.has(s);
    });
    return this.normalize(filtered, all);
  }

  async fetchIssuesByStates(stateNames: string[]): Promise<Issue[]> {
    // §17.3: empty input returns empty without an API call.
    if (stateNames.length === 0) return [];
    const want = new Set(stateNames.map((s) => s.toLowerCase()));
    const all = await this.scanAll();
    const filtered = all.filter((raw) => want.has(raw.state.toLowerCase()));
    return this.normalize(filtered, all);
  }

  async fetchIssueStatesByIds(issueIds: string[]): Promise<Issue[]> {
    if (issueIds.length === 0) return [];
    const want = new Set(issueIds);
    const all = await this.scanAll();
    const found = all.filter((raw) => want.has(this.idOf(raw)));
    return this.normalize(found, all);
  }

  private idOf(raw: RawIssueFile): string {
    const fmId = asString(raw.frontMatter['id']);
    return fmId && fmId.trim().length > 0 ? fmId : raw.identifier;
  }

  private async scanAll(): Promise<RawIssueFile[]> {
    let entries: string[];
    try {
      entries = await readdir(this.root);
    } catch (err) {
      throw new TrackerError(
        'local_root_read_error',
        `cannot read tracker.root ${this.root}: ${(err as Error).message}`,
      );
    }
    const out: RawIssueFile[] = [];
    for (const dirEntry of entries) {
      const dirPath = path.join(this.root, dirEntry);
      let stats;
      try {
        stats = await stat(dirPath);
      } catch {
        continue;
      }
      if (!stats.isDirectory()) continue;
      const state = dirEntry;
      let files: string[];
      try {
        files = await readdir(dirPath);
      } catch {
        continue;
      }
      for (const fileName of files) {
        if (!fileName.endsWith('.md')) continue;
        const filePath = path.join(dirPath, fileName);
        let st;
        try {
          st = await stat(filePath);
        } catch {
          continue;
        }
        if (!st.isFile()) continue;
        let text: string;
        try {
          text = await readFile(filePath, 'utf8');
        } catch (err) {
          log.warn('skipping unreadable issue file', { file: filePath, error: (err as Error).message });
          continue;
        }
        let parsed: { config: Record<string, unknown>; body: string };
        try {
          parsed = splitFrontMatter(text);
        } catch (err) {
          log.warn('skipping malformed issue file', { file: filePath, error: (err as Error).message });
          continue;
        }
        out.push({
          filePath,
          identifier: fileName.slice(0, -3),
          state,
          frontMatter: parsed.config,
          description: parsed.body,
        });
      }
    }
    return out;
  }

  // Build normalized Issue objects. `all` is used to resolve blocker states.
  private normalize(target: RawIssueFile[], all: RawIssueFile[]): Issue[] {
    // Resolve blockers by normalized identifier (front-matter `identifier` if set, else basename)
    // and also by id, so users can refer to either.
    const byKey = new Map<string, RawIssueFile>();
    for (const r of all) {
      const ident = asString(r.frontMatter['identifier']) ?? r.identifier;
      byKey.set(ident, r);
      byKey.set(this.idOf(r), r);
      // Also accept the basename for resilience, last-wins ordering doesn't matter.
      byKey.set(r.identifier, r);
    }
    return target.map((r) => this.toIssue(r, byKey));
  }

  private toIssue(raw: RawIssueFile, byKey: Map<string, RawIssueFile>): Issue {
    const fm = raw.frontMatter;
    const id = this.idOf(raw);
    const identifier = asString(fm['identifier']) ?? raw.identifier;
    const title = asString(fm['title']) ?? identifier;
    const priority = asInt(fm['priority']);
    const labels = asStringList(fm['labels']).map((s) => s.toLowerCase());
    const branch_name = asString(fm['branch_name']);
    const url = asString(fm['url']);
    const created_at = asTimestamp(fm['created_at']);
    const updated_at = asTimestamp(fm['updated_at']);
    const description = raw.description.length > 0 ? raw.description : null;

    const blockerIdents = asStringList(fm['blocked_by']);
    const blocked_by: BlockerRef[] = blockerIdents.map((ident) => {
      const found = byKey.get(ident);
      if (found) {
        const foundIdent = asString(found.frontMatter['identifier']) ?? found.identifier;
        return {
          id: this.idOf(found),
          identifier: foundIdent,
          state: found.state,
        };
      }
      return { id: null, identifier: ident, state: null };
    });

    return {
      id,
      identifier,
      title,
      description,
      priority,
      state: raw.state,
      branch_name,
      url,
      labels,
      blocked_by,
      created_at,
      updated_at,
    };
  }
}
