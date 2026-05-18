// Tracker adapter contract (SPEC §11.1).

import type { Issue } from '../types.js';

export interface IssueTracker {
  /** SPEC §11.1.1: fetch issues whose state is in the configured active set. */
  fetchCandidateIssues(): Promise<Issue[]>;
  /** SPEC §11.1.2: used for startup terminal-workspace cleanup. */
  fetchIssuesByStates(stateNames: string[]): Promise<Issue[]>;
  /** SPEC §11.1.3: refresh tracker state for the given issue ids. Missing ids omitted. */
  fetchIssueStatesByIds(issueIds: string[]): Promise<Issue[]>;
}

export class TrackerError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'TrackerError';
  }
}
