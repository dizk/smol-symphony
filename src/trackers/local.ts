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
// State comparison is case-insensitive (SPEC §3.2 "Normalized Issue State").

import { mkdir, open, readdir, readFile, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { parseFrontMatter, FrontMatterError } from '../util/frontmatter.js';
import type { Issue, BlockerRef, TrackerConfig } from '../types.js';
import type { IssueTracker, CandidateFetchResult } from './types.js';
import { TrackerError } from './types.js';
import { activeStateNames, terminalStateNames } from '../issues.js';
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

// Compose the appended-notes body. Pure: extracted so `appendNotesBlock` stays small
// enough for the imperative-shell complexity budget. Guarantees a blank line between the
// prior body and the new header; the block itself ends with a newline so subsequent
// appends stay readable.
function buildNotesAppendedBody(
  original: string,
  fromState: string,
  toState: string,
  notes: string,
  actor: string | undefined,
): string {
  const who = actor && actor.length > 0 ? actor : 'unknown';
  const ts = new Date().toISOString();
  const header = `## ${who} — ${ts} — ${fromState} → ${toState}`;
  const sep = original.endsWith('\n\n') ? '' : original.endsWith('\n') ? '\n' : '\n\n';
  return `${original}${sep}${header}\n\n${notes}\n`;
}

// Thin wrapper over the shared parser. Translates FrontMatterError → TrackerError
// so the scanner's existing skip-and-log catch picks them up under the same code.
function splitFrontMatter(text: string): { config: Record<string, unknown>; body: string } {
  let fm;
  try {
    fm = parseFrontMatter(text);
  } catch (err) {
    if (err instanceof FrontMatterError) {
      throw new TrackerError(
        'local_issue_parse_error',
        err.code === 'not_a_map' ? 'issue front matter must be a map' : `failed to parse front matter: ${err.message}`,
      );
    }
    throw err;
  }
  return { config: fm.fields, body: fm.body };
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
    // `states` is canonical (the workflow parser refuses configs without it);
    // mkdir each declared state directory so the dashboard sees every column
    // even before issues land.
    for (const name of Object.keys(this.cfg.states)) {
      await mkdir(path.join(this.cfg.root, name), { recursive: true });
    }
  }

  private get root(): string {
    return this.cfg.root!;
  }

  async fetchCandidateIssues(): Promise<CandidateFetchResult> {
    // Capture root atomically at method entry. A workflow reload during the
    // fetch I/O cannot make the returned issues and the returned snapshot
    // disagree — both come from this single view of cfg.
    const root = this.cfg.root!;
    const active = new Set(activeStateNames(this.cfg.states).map((s) => s.toLowerCase()));
    const terminal = new Set(terminalStateNames(this.cfg.states).map((s) => s.toLowerCase()));
    const all = await this.scanAllAt(root);
    const filtered = all.filter((raw) => {
      const s = raw.state.toLowerCase();
      return active.has(s) && !terminal.has(s);
    });
    return {
      issues: this.normalize(filtered, all),
      root,
    };
  }

  async fetchIssuesByStates(stateNames: string[]): Promise<Issue[]> {
    // Empty input returns empty without an API call.
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
   * MCP transition tool. Atomic on the same filesystem (fs.rename); throws TrackerError
   * with a stable code on common failure modes so the MCP layer can surface them.
   *
   * When `opts.notes` is a non-empty string, a notes block is appended to the issue body
   * BEFORE the cross-directory rename: the new body is written to `<id>.md.tmp` in the
   * source state directory, fsync'd, then atomically renamed onto `<id>.md` so the file
   * is still in the source state directory but now carries the notes. The
   * cross-directory rename then moves the updated file into the target state. This
   * sequencing means a crash between the two renames leaves the notes persisted in the
   * source directory — the next dispatch sees them on the live issue and the operator
   * can finish the move by hand.
   */
  async moveIssueToState(
    issueId: string,
    toState: string,
    opts?: { fromRoot?: string; fromState?: string; notes?: string; actor?: string },
  ): Promise<{ fromState: string; toState: string; newPath: string }> {
    // When the caller pins a root (snapshot from dispatch time), scan there.
    // Otherwise use whatever the live config says. This protects in-flight
    // transition calls from a WORKFLOW.md reload that mutates tracker.root.
    const { fromRoot, fromState, notes: rawNotes, actor } = opts ?? {};
    const root = fromRoot ?? this.root;
    const notes = typeof rawNotes === 'string' ? rawNotes : '';
    const all = await this.scanAllAt(root);
    const candidates = all.filter((raw) => this.idOf(raw) === issueId);
    if (candidates.length === 0) {
      throw new TrackerError('local_issue_not_found', `no issue file matches id ${issueId}`);
    }
    const match = this.resolveMatch(candidates, issueId, fromState);
    if (match.state.toLowerCase() === toState.toLowerCase()) {
      return { fromState: match.state, toState: match.state, newPath: match.filePath };
    }
    if (notes.length > 0) {
      await this.appendNotesBlock(match, toState, notes, actor);
    }
    const targetDir = path.join(root, toState);
    await mkdir(targetDir, { recursive: true });
    const newPath = path.join(targetDir, path.basename(match.filePath));
    await this.assertTargetFree(newPath);
    await this.crossDirRename(match.filePath, newPath);
    log.info('issue transitioned', {
      issue_id: issueId,
      from_state: match.state,
      to_state: toState,
      path: newPath,
    });
    return { fromState: match.state, toState, newPath };
  }

  private async crossDirRename(srcPath: string, dstPath: string): Promise<void> {
    try {
      await rename(srcPath, dstPath);
    } catch (err) {
      throw new TrackerError(
        'local_issue_move_error',
        `failed to move ${srcPath} -> ${dstPath}: ${(err as Error).message}`,
      );
    }
  }

  // Multiple files can share the same id when a stale terminal copy (e.g. an old
  // Done/ABC-1.md from a prior cycle) survives alongside a live In Progress/ABC-1.md.
  // `readdir` ordering is filesystem-dependent, so a blind `.find(...)` can pick the
  // stale copy and — if its state already equals `toState` — silently no-op via the
  // identity short-circuit in the caller, leaving the active file stranded. Prefer the
  // copy whose state matches the caller-supplied `fromState`; if that still doesn't
  // resolve to a single file, refuse to guess.
  private resolveMatch(
    candidates: RawIssueFile[],
    issueId: string,
    fromState: string | undefined,
  ): RawIssueFile {
    if (candidates.length === 1) return candidates[0]!;
    const preferred = fromState
      ? candidates.filter((raw) => raw.state.toLowerCase() === fromState.toLowerCase())
      : [];
    if (preferred.length === 1) return preferred[0]!;
    const states = candidates.map((raw) => raw.state).join(', ');
    throw new TrackerError(
      'local_issue_ambiguous',
      `multiple issue files match id ${issueId} across states [${states}]; pass fromState to disambiguate`,
    );
  }

  // We re-read the file (the scan parsed front-matter + body but discarded the verbatim
  // text) so the rewrite preserves operator-visible whitespace, comments, and any
  // trailing newlines exactly. The append block format is fixed across the tracker so the
  // dashboard / downstream tooling can recognise it.
  private async appendNotesBlock(
    match: RawIssueFile,
    toState: string,
    notes: string,
    actor: string | undefined,
  ): Promise<void> {
    const original = await this.readForNotesAppend(match.filePath);
    const appended = buildNotesAppendedBody(original, match.state, toState, notes, actor);
    await this.durablyReplaceInPlace(match.filePath, appended);
  }

  private async readForNotesAppend(filePath: string): Promise<string> {
    try {
      return await readFile(filePath, 'utf8');
    } catch (err) {
      throw new TrackerError(
        'local_issue_notes_read_error',
        `failed to read ${filePath} for notes append: ${(err as Error).message}`,
      );
    }
  }

  // Write to <targetPath>.tmp in the SAME directory, fsync the file descriptor for
  // durability, then atomic-rename onto targetPath. Same-directory rename is atomic on
  // POSIX filesystems, so any subsequent cross-directory move operates on a single
  // up-to-date file.
  private async durablyReplaceInPlace(targetPath: string, contents: string): Promise<void> {
    const tmpPath = targetPath + '.tmp';
    await this.writeAndFsync(tmpPath, contents);
    try {
      await rename(tmpPath, targetPath);
    } catch (err) {
      throw new TrackerError(
        'local_issue_notes_rename_error',
        `failed to atomic-rename ${tmpPath} -> ${targetPath}: ${(err as Error).message}`,
      );
    }
  }

  private async writeAndFsync(tmpPath: string, contents: string): Promise<void> {
    let fh;
    try {
      fh = await open(tmpPath, 'w', 0o644);
      await fh.writeFile(contents, 'utf8');
      await fh.sync();
    } catch (err) {
      try {
        if (fh) await fh.close();
      } catch {
        // best-effort close — surfacing the original error is more useful.
      }
      throw new TrackerError(
        'local_issue_notes_write_error',
        `failed to write notes tmp file ${tmpPath}: ${(err as Error).message}`,
      );
    }
    try {
      await fh.close();
    } catch {
      // The file is on disk and fsync'd; close failures are not load-bearing.
    }
  }

  // POSIX `rename` overwrites the destination silently. Refuse to clobber a stale
  // terminal file with the same basename (e.g. an old Done/ABC-1.md left from a prior
  // run before this issue was recreated in In Progress). A small TOCTOU race remains
  // — another writer can create the target between this check and the subsequent rename
  // — but the realistic failure mode is operator-leftover files, not concurrent writes.
  private async assertTargetFree(newPath: string): Promise<void> {
    try {
      await stat(newPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw new TrackerError(
        'local_issue_move_error',
        `failed to stat target ${newPath}: ${(err as Error).message}`,
      );
    }
    throw new TrackerError(
      'local_issue_target_exists',
      `refusing to overwrite existing file at ${newPath}`,
    );
  }

  private idOf(raw: RawIssueFile): string {
    const fmId = asString(raw.frontMatter['id']);
    return fmId && fmId.trim().length > 0 ? fmId : raw.identifier;
  }

  private async scanAll(): Promise<RawIssueFile[]> {
    return this.scanAllAt(this.root);
  }

  /** Variant that scans an explicit root, used by `transition` with a pinned snapshot. */
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
    // same comparison the orchestrator uses for role-based classification.
    // Unknown directories (operator-left scratch, a state that was removed from
    // `states:`) are ignored with a warning so a stale tree doesn't crash the
    // dispatch loop.
    const declared = new Map<string, string>();
    for (const name of Object.keys(this.cfg.states)) {
      declared.set(name.toLowerCase(), name);
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
      out.push(...(await this.scanStateDir(dirPath, dirEntry)));
    }
    return out;
  }

  // Read every .md file in a single state directory. Per-file failures (unreadable,
  // malformed front matter) are skipped with a warning so one bad file doesn't poison
  // the whole scan; a readdir failure on the directory itself silently yields nothing
  // for the same reason.
  private async scanStateDir(dirPath: string, state: string): Promise<RawIssueFile[]> {
    let files: string[];
    try {
      files = await readdir(dirPath);
    } catch {
      return [];
    }
    const out: RawIssueFile[] = [];
    for (const fileName of files) {
      if (!fileName.endsWith('.md')) continue;
      const raw = await this.readIssueFile(path.join(dirPath, fileName), fileName, state);
      if (raw) out.push(raw);
    }
    return out;
  }

  private async readIssueFile(
    filePath: string,
    fileName: string,
    state: string,
  ): Promise<RawIssueFile | null> {
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
    } catch (err) {
      log.warn('skipping unreadable issue file', { file: filePath, error: (err as Error).message });
      return null;
    }
    let parsed: { config: Record<string, unknown>; body: string };
    try {
      parsed = splitFrontMatter(text);
    } catch (err) {
      log.warn('skipping malformed issue file', { file: filePath, error: (err as Error).message });
      return null;
    }
    return {
      filePath,
      identifier: fileName.slice(0, -3),
      state,
      frontMatter: parsed.config,
      description: parsed.body,
    };
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
