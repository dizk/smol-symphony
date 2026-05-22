// Reconciler types (issue 32 / future issue 31).
//
// The reconciler converges managed external resources (today: the Smolfile-driven bake)
// toward a declared desired state. Each resource describes its work as typed action
// records — not opaque closures — so per-action progress can be surfaced on Snapshot
// and (in v2 — issue 36) the same record shape can be reused for hook-declared actions.
//
// Action records carry a discriminant `kind`. v1 ships only `bake`; new kinds are added
// as more resources land in later stages of the reconciler refactor.

export type ReconcilerAction =
  | BakeAction
  | DestroyMachineAction
  | KillBootWorkerAction
  | RemoveWorkspaceAction
  | CreateWorkspaceAction;

// Bake the Smolfile-derived `.smolmachine` artifact and write it to the action cache.
// The `input_hash` (sha256 of the Smolfile body) is the cache key: subsequent dispatches
// with an unchanged Smolfile see the artifact on disk and skip the bake entirely.
export interface BakeAction {
  kind: 'bake';
  input_hash: string;
  smolfile_path: string;
  output_path: string;
  cpus: number;
  mem_mib: number;
}

// Destroy a daemon-registered `symphony-*` VM that the orchestrator no longer
// intends to keep around (issue 33). Driven by `smolvm machine delete -f`.
export interface DestroyMachineAction {
  kind: 'destroy_machine';
  vm_name: string;
}

// SIGTERM (with SIGKILL fallback after grace) a `_boot-vm` host worker whose
// VM is `symphony-*`-prefixed but not in the orchestrator's intended set
// (issue 33). Covers the upstream smolvm bug where `machine delete -f`
// succeeds in the daemon but leaves the worker alive.
export interface KillBootWorkerAction {
  kind: 'kill_boot_worker';
  pid: number;
  vm_name: string;
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
// (clone source repo, cut `agent/<id>`, optional origin restore, after_create
// hook) lives in `WorkspaceManager.ensureFor` / `setupWorkspaceDir` — the
// reconciler's create callback delegates there so dispatch-time creation and
// reconciler-driven eager creation share one code path.
export interface CreateWorkspaceAction {
  kind: 'create_workspace';
  identifier: string;
}

// State of an individual action attempt. Reported on Snapshot.reconciler so the
// dashboard can show "baking…", "ready", or "error: <reason>" instead of an empty queue.
export type ActionState = 'in_progress' | 'done' | 'error';

export interface ActionStatus {
  // Resource that owns this action (e.g. "bake").
  resource: string;
  // Unique-within-resource action key (e.g. "bake:<hash>").
  action: string;
  state: ActionState;
  started_at: string;
  finished_at: string | null;
  // Populated when `state === 'error'`.
  error: string | null;
}

// Per-resource summary plus its action ledger. Resources with no desired state (e.g.
// the bake resource when `smolvm.smolfile` is unset) still appear, so the dashboard
// shows the resource exists even when there is no work to do.
export interface ResourceSnapshot {
  id: string;
  // True iff dependents can proceed — i.e. desired state matches actual.
  ready: boolean;
  // Latest desired-input hash (e.g. sha256(Smolfile)). null when no desired state.
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
