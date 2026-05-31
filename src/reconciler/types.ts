// Reconciler types (issue 32 / future issue 31).
//
// The reconciler converges managed external resources (VM reaper, workspace
// janitor, PR autopilot) toward a declared desired state. Each resource
// describes its work as typed action records — not opaque closures — so
// per-action progress can be surfaced on Snapshot and the same record shape
// can be reused for hook-declared actions.
//
// Action records carry a discriminant `kind`; new kinds are added as more
// resources land in later stages of the reconciler refactor.

export type ReconcilerAction =
  | KillSessionAction
  | RemoveWorkspaceAction
  | CreateWorkspaceAction;

// SIGTERM (with SIGKILL fallback after grace) the host Gondolin runner process
// backing a `symphony-*`-labelled session that is not in the orchestrator's
// intended set (Gondolin migration, Phase 4). Replaces `kill_boot_worker`: the
// reaper now observes Gondolin's session registry (`listSessions`) instead of
// `_boot-vm` /proc scraping, and a LIVE orphan (a botched teardown / a SIGKILL'd
// symphony whose runner child survived) is reaped by its host `pid`. STALE
// (dead-pid) sessions and orphan sockets are collected by Gondolin's own `gc()`
// before this effect is computed, so `kill_session` only ever targets a session
// whose host process is still alive.
export interface KillSessionAction {
  kind: 'kill_session';
  pid: number;
  label: string;
}

// Remove a per-issue workspace directory under `workspace.root` whose owning
// issue is no longer non-terminal (issue 34). Replaces the orchestrator's
// startup-only terminal cleanup pass with a continuous-converge action. v1
// has no destructive drift action; drift is surfaced as a `mark_stale` /
// `mark_stuck` annotation in the workspace resource's snapshot, and re-clone
// is operator-triggered (out of scope for this stage).
export interface RemoveWorkspaceAction {
  kind: 'remove_workspace';
  identifier: string;
}

// Create the per-issue workspace directory for an active (non-terminal) issue
// (issue 34). The desired set is the union of the tracker's non-terminal
// identifiers and the dispatch in-flight set; any identifier in that set
// without a dir under `workspace.root` triggers this action. The action body
// (clone source repo, cut `agent/<id>`, optional origin restore) lives in
// `WorkspaceManager.ensureFor` / `setupWorkspaceDir` — the reconciler's create
// callback delegates there so dispatch-time creation and reconciler-driven
// eager creation share one code path.
export interface CreateWorkspaceAction {
  kind: 'create_workspace';
  identifier: string;
}

// State of an individual action attempt. Reported on Snapshot.reconciler so the
// dashboard can show "baking…", "ready", or "error: <reason>" instead of an empty queue.
export type ActionState = 'in_progress' | 'done' | 'error';

export interface ActionStatus {
  // Resource that owns this action (e.g. "vm").
  resource: string;
  // Unique-within-resource action key (e.g. "kill_session:<pid>").
  action: string;
  state: ActionState;
  started_at: string;
  finished_at: string | null;
  // Populated when `state === 'error'`.
  error: string | null;
}

// Per-resource summary plus its action ledger. Resources with no desired state
// still appear, so the dashboard shows the resource exists even when there is
// no work to do.
export interface ResourceSnapshot {
  id: string;
  // True iff dependents can proceed — i.e. desired state matches actual.
  ready: boolean;
  // Latest desired-input hash. null when no desired state.
  desired_hash: string | null;
  // Last completed-or-failed action's error message. Persists past the action ledger
  // so the dashboard can show "last error" without scrolling the action list.
  last_error: string | null;
  // Most-recent-first slice of action statuses for this resource.
  actions: ActionStatus[];
}

export interface ReconcilerSnapshot {
  resources: ResourceSnapshot[];
}
