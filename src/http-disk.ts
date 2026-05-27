// On-disk issue readers used by the dashboard and the /issues/<id> detail page.
// Walks the tracker root directly (rather than going through IssueTracker) so the UI
// can surface files in any state directory — including ones the orchestrator does not
// dispatch (Triage proposals, Done archives, orphan directories from a workflow
// rename). Lives in its own module so src/http.ts stays a thin routing shell; the
// per-file fs/parse logic is shared between the list view and the detail view.
//
// Decomposed (issue 74) from the original inline implementations in http.ts into
// async generators (iterStateDirs / iterIssueFiles) plus small fn-per-decision
// helpers, each of which fits inside the imperative-shell complexity budget.

import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { parseFrontMatterLenient } from './util/frontmatter.js';

export type DiskIssue = {
  identifier: string;
  state: string;
  title: string;
  proposed_by: string | null;
  proposed_at: string | null;
};

export interface DiskIssueDetail {
  identifier: string;
  state: string;
  filePath: string;
  frontMatter: Record<string, unknown>;
  body: string;
}

interface IssueFileEntry {
  stateDir: string;
  baseName: string;
  filePath: string;
  text: string;
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    const st = await stat(p);
    return st.isDirectory();
  } catch {
    return false;
  }
}

// Walks immediate subdirectories of the tracker root. Missing root yields nothing
// (the dashboard renders an empty board rather than 500ing). Non-directory entries
// and stat failures are skipped so a stray file at the tracker root doesn't break
// the listing.
async function* iterStateDirs(
  trackerRoot: string,
): AsyncGenerator<{ stateDir: string; dirPath: string }> {
  let entries: string[];
  try {
    entries = await readdir(trackerRoot);
  } catch {
    return;
  }
  for (const stateDir of entries) {
    const dirPath = path.join(trackerRoot, stateDir);
    if (await isDirectory(dirPath)) yield { stateDir, dirPath };
  }
}

// Yields every readable `.md` file under every state directory. Unreadable files
// (permissions, races against deletion) are skipped — the dashboard prefers a
// partial list over a broken page.
async function* iterIssueFiles(trackerRoot: string): AsyncGenerator<IssueFileEntry> {
  for await (const { stateDir, dirPath } of iterStateDirs(trackerRoot)) {
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
      yield { stateDir, baseName: f.slice(0, -3), filePath, text };
    }
  }
}

// Project an IssueFileEntry into the listing view. Triage entries surface their
// `proposed_by` / `proposed_at` front-matter so the dashboard can show provenance
// for agent-authored proposals — fields are null for hand-written issues.
// Prefers the front-matter `identifier:` when set so the listing reports the same
// identifier the orchestrator dispatches under (LocalMarkdownTracker.normalize uses
// `fm.identifier ?? filename`). Without this, an issue whose front-matter identifier
// differs from its filename loses its overlaid running/retrying/awaiting state on
// the board and its ticker jump-link points at a missing #row anchor.
function toDiskIssue(file: IssueFileEntry): DiskIssue {
  const { fields } = parseFrontMatterLenient(file.text);
  const title = asString(fields['title']) ?? file.baseName;
  const proposed_by = asString(fields['proposed_by']);
  const proposed_at = asString(fields['proposed_at']);
  const fmIdent = asString(fields['identifier']);
  const identifier = fmIdent && fmIdent.length > 0 ? fmIdent : file.baseName;
  return { identifier, state: file.stateDir, title, proposed_by, proposed_at };
}

// Browse current issues directly from disk so the UI can show items that are neither
// currently running nor in the retry queue. Result is sorted by identifier so the
// dashboard column ordering is deterministic across reloads.
export async function listIssuesFromDisk(trackerRoot: string): Promise<DiskIssue[]> {
  const out: DiskIssue[] = [];
  for await (const file of iterIssueFiles(trackerRoot)) {
    out.push(toDiskIssue(file));
  }
  out.sort((a, b) => a.identifier.localeCompare(b.identifier));
  return out;
}

// Fast path used by readIssueFromDisk: try the obvious filename in every state
// directory. Returns null without scanning file contents when no `<id>.md` exists,
// so the slow front-matter scan only runs when we genuinely need it.
async function tryReadByBasename(
  trackerRoot: string,
  identifier: string,
): Promise<DiskIssueDetail | null> {
  const target = `${identifier}.md`;
  for await (const { stateDir, dirPath } of iterStateDirs(trackerRoot)) {
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
  return null;
}

// Read a single issue file by basename identifier, walking every state directory.
// Falls back to scanning .md files by front-matter `identifier:` when the basename
// doesn't match — same resolution the local tracker uses in normalize()
// (`fm.identifier ?? filename`). Slower (reads every issue file) but only on the
// not-found path, and only for trackers that exercise the override.
export async function readIssueFromDisk(
  trackerRoot: string,
  identifier: string,
): Promise<DiskIssueDetail | null> {
  const fast = await tryReadByBasename(trackerRoot, identifier);
  if (fast) return fast;
  for await (const file of iterIssueFiles(trackerRoot)) {
    const { fields, body } = parseFrontMatterLenient(file.text);
    if (asString(fields['identifier']) !== identifier) continue;
    return { identifier, state: file.stateDir, filePath: file.filePath, frontMatter: fields, body };
  }
  return null;
}
