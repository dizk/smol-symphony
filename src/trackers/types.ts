// Tracker adapter contract (SPEC §11.1).

import type { Issue } from '../types.js';

/**
 * Atomic candidate-fetch result. `issues` is the filtered list; `root` and
 * `terminalStates` are the tracker's config values *captured at the moment of
 * the fetch*, so callers can use them as snapshots immune to any subsequent
 * config mutation (e.g. a workflow reload that runs between the await returning
 * and the caller's dispatch loop). The orchestrator pins these onto each
 * RunningEntry so a later `mark_done` operates against the same root and
 * terminal state the issue was fetched from, not against a post-reload view.
 */
export interface CandidateFetchResult {
  issues: Issue[];
  root: string | null;
  terminalStates: string[];
}

export interface IssueTracker {
  /** SPEC §11.1.1: fetch issues whose state is in the configured active set. */
  fetchCandidateIssues(): Promise<CandidateFetchResult>;
  /** SPEC §11.1.2: used for startup terminal-workspace cleanup. */
  fetchIssuesByStates(stateNames: string[]): Promise<Issue[]>;
  /** SPEC §11.1.3: refresh tracker state for the given issue ids. Missing ids omitted. */
  fetchIssueStatesByIds(issueIds: string[]): Promise<Issue[]>;
  /**
   * Optional capability: transition an issue to a new state. Used by the MCP `mark_done`
   * and `transition` tools so the agent can signal completion / hand off to the next
   * state without shelling out to `mv`. Trackers that are read-only (e.g. external
   * services accessed via a token without write scope) may omit this; the MCP server
   * will reject `mark_done` / `transition` calls in that case.
   *
   * `opts.fromRoot` lets callers pin the tracker storage location at the moment they
   * captured the issue, so a WORKFLOW.md reload that changes `tracker.root` mid-flight
   * cannot redirect a transition to a different filesystem location.
   *
   * `opts.fromState` disambiguates multi-match results when the same id appears under
   * more than one state directory (e.g. a stale Done/ABC-1.md alongside the live
   * In Progress/ABC-1.md). The caller passes the state the entry was dispatched from
   * so the move targets the active copy, not the stale one. When omitted and the scan
   * returns multiple matches, the tracker must throw rather than guess.
   *
   * `opts.notes`, when non-empty, is appended to the issue body BEFORE the rename so
   * the next agent (in the destination state) sees them in `issue.description` on the
   * next dispatch. The tracker owns the append+rename atomicity — the MCP layer must
   * not calculate file paths itself. Append shape (rendered by `local.ts`):
   *
   *     ## <actor or "unknown"> — <ISO timestamp> — <from_state> → <to_state>
   *
   *     <notes>
   *
   * `opts.actor` is the dispatch identity ("<adapter>/<model>") used in the notes
   * header. Unused when `notes` is empty/absent.
   */
  moveIssueToState?(
    issueId: string,
    toState: string,
    opts?: {
      fromRoot?: string;
      fromState?: string;
      notes?: string;
      actor?: string;
    },
  ): Promise<{ fromState: string; toState: string; newPath: string }>;
  /**
   * Optional capability: report the tracker's current backing-store location (e.g. the
   * local tracker's filesystem root). Used by the MCP layer to snapshot the storage
   * location at dispatch time so the snapshot survives a workflow reload that mutates
   * the live tracker config.
   */
  currentRoot?(): string | null;
}

export class TrackerError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'TrackerError';
  }
}
