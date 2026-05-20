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

import { mkdir, readdir, readFile, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { Issue, BlockerRef, TrackerConfig } from '../types.js';
import type { IssueTracker, CandidateFetchResult } from './types.js';
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

  /**
   * Eagerly create the directory for every declared state under `tracker.root`.
   * Called from the orchestrator boot path so the operator-facing tree (and the
   * dashboard) sees every column the workflow declared, even before any issue
   * file lands in it. Lazy creation in writeIssueFile / moveIssueToState is left
   * in place as a belt-and-suspenders fallback for code paths that target a
   * state directory directly.
   */
  async start(): Promise<void> {
    if (!this.cfg.root) throw new TrackerError('local_no_root', 'tracker.root is required');
    const names = Object.keys(this.cfg.states ?? {});
    // When no `states` map is set (e.g. an older test harness building
    // TrackerConfig directly), fall back to the union of active + terminal so
    // boot still produces a usable tree.
    const decl =
      names.length > 0 ? names : [...this.cfg.active_states, ...this.cfg.terminal_states];
    for (const name of decl) {
      await mkdir(path.join(this.cfg.root, name), { recursive: true });
    }
  }

  private get root(): string {
    return this.cfg.root!;
  }

  async fetchCandidateIssues(): Promise<CandidateFetchResult> {
    // Capture root + terminal_states atomically at method entry. A workflow
    // reload during the fetch I/O cannot make the returned issues and the
    // returned snapshot disagree — both come from this single view of cfg.
    const root = this.cfg.root!;
    const terminalStates = [...this.cfg.terminal_states];
    const active = new Set(this.cfg.active_states.map((s) => s.toLowerCase()));
    const terminal = new Set(terminalStates.map((s) => s.toLowerCase()));
    const all = await this.scanAllAt(root);
    const filtered = all.filter((raw) => {
      const s = raw.state.toLowerCase();
      return active.has(s) && !terminal.has(s);
    });
    return {
      issues: this.normalize(filtered, all),
      root,
      terminalStates,
    };
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

  /** Expose the current tracker root so callers can snapshot it at dispatch time. */
  currentRoot(): string | null {
    return this.cfg.root;
  }

  /**
   * Move an issue's .md file from its current state directory to `toState`. Used by the
   * MCP mark_done tool. Atomic on the same filesystem (fs.rename); throws TrackerError
   * with a stable code on common failure modes so the MCP layer can surface them.
   */
  async moveIssueToState(
    issueId: string,
    toState: string,
    opts?: { fromRoot?: string; fromState?: string },
  ): Promise<{ fromState: string; toState: string; newPath: string }> {
    // When the caller pins a root (snapshot from dispatch time), scan there.
    // Otherwise use whatever the live config says. This protects in-flight
    // mark_done from a WORKFLOW.md reload that mutates tracker.root.
    const root = opts?.fromRoot ?? this.root;
    const all = await this.scanAllAt(root);
    const candidates = all.filter((raw) => this.idOf(raw) === issueId);
    if (candidates.length === 0) {
      throw new TrackerError('local_issue_not_found', `no issue file matches id ${issueId}`);
    }
    // Multiple files can share the same id when a stale terminal copy (e.g. an old
    // Done/ABC-1.md from a prior cycle) survives alongside a live In Progress/ABC-1.md.
    // `readdir` ordering is filesystem-dependent, so a blind `.find(...)` can pick the
    // stale copy and — if its state already equals `toState` — silently no-op via the
    // identity short-circuit below, leaving the active file stranded. Prefer the copy
    // whose state matches the caller-supplied `fromState`; if that still doesn't
    // resolve to a single file, refuse to guess.
    let match: RawIssueFile;
    if (candidates.length === 1) {
      match = candidates[0]!;
    } else {
      const fromState = opts?.fromState;
      const preferred = fromState
        ? candidates.filter((raw) => raw.state.toLowerCase() === fromState.toLowerCase())
        : [];
      if (preferred.length === 1) {
        match = preferred[0]!;
      } else {
        const states = candidates.map((raw) => raw.state).join(', ');
        throw new TrackerError(
          'local_issue_ambiguous',
          `multiple issue files match id ${issueId} across states [${states}]; pass fromState to disambiguate`,
        );
      }
    }
    if (match.state.toLowerCase() === toState.toLowerCase()) {
      return { fromState: match.state, toState: match.state, newPath: match.filePath };
    }
    const targetDir = path.join(root, toState);
    await mkdir(targetDir, { recursive: true });
    const basename = path.basename(match.filePath);
    const newPath = path.join(targetDir, basename);
    // POSIX `rename` overwrites the destination silently. Refuse to clobber a stale
    // terminal file with the same basename (e.g. an old Done/ABC-1.md left from a prior
    // run before this issue was recreated in In Progress). A small TOCTOU race remains
    // — another writer can create the target between this check and rename — but the
    // realistic failure mode is operator-leftover files, not concurrent writes.
    try {
      await stat(newPath);
      throw new TrackerError(
        'local_issue_target_exists',
        `refusing to overwrite existing file at ${newPath}`,
      );
    } catch (err) {
      if (err instanceof TrackerError) throw err;
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new TrackerError(
          'local_issue_move_error',
          `failed to stat target ${newPath}: ${(err as Error).message}`,
        );
      }
    }
    try {
      await rename(match.filePath, newPath);
    } catch (err) {
      throw new TrackerError(
        'local_issue_move_error',
        `failed to move ${match.filePath} -> ${newPath}: ${(err as Error).message}`,
      );
    }
    log.info('issue transitioned', {
      issue_id: issueId,
      from_state: match.state,
      to_state: toState,
      path: newPath,
    });
    return { fromState: match.state, toState, newPath };
  }

  private idOf(raw: RawIssueFile): string {
    const fmId = asString(raw.frontMatter['id']);
    return fmId && fmId.trim().length > 0 ? fmId : raw.identifier;
  }

  private async scanAll(): Promise<RawIssueFile[]> {
    return this.scanAllAt(this.root);
  }

  /** Variant that scans an explicit root, used by mark_done with a pinned snapshot. */
  private async scanAllAt(root: string): Promise<RawIssueFile[]> {
    let entries: string[];
    try {
      entries = await readdir(root);
    } catch (err) {
      throw new TrackerError(
        'local_root_read_error',
        `cannot read tracker.root ${root}: ${(err as Error).message}`,
      );
    }
    // Match directories against the declared state map case-insensitively, the
    // same comparison the orchestrator uses for active/terminal classification.
    // Unknown directories (operator-left scratch, a legacy state that was removed
    // from `states:`) are ignored with a warning so a stale tree doesn't crash
    // the dispatch loop. When the caller didn't provide a states map (e.g. a
    // test constructs TrackerConfig directly), fall back to active + terminal +
    // the implicit `Triage` holding state so legacy callers keep working.
    const declared = new Map<string, string>();
    const stateNames = Object.keys(this.cfg.states ?? {});
    if (stateNames.length > 0) {
      for (const name of stateNames) declared.set(name.toLowerCase(), name);
    } else {
      for (const name of [...this.cfg.active_states, ...this.cfg.terminal_states, 'Triage']) {
        declared.set(name.toLowerCase(), name);
      }
    }
    const out: RawIssueFile[] = [];
    for (const dirEntry of entries) {
      const dirPath = path.join(root, dirEntry);
      let stats;
      try {
        stats = await stat(dirPath);
      } catch {
        continue;
      }
      if (!stats.isDirectory()) continue;
      if (!declared.has(dirEntry.toLowerCase())) {
        log.warn('skipping undeclared state directory', { dir: dirPath });
        continue;
      }
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
