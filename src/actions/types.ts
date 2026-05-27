// Workflow action records (issue 36 — reconciler v2 / typed action DAG).
//
// Per-state `actions:` blocks declare a closed set of typed records that the
// orchestrator runs in place of an `after_run` shell hook. Each kind has a
// fixed schema; the only escape hatch for arbitrary commands is `run_in_vm`,
// which is content-hash cached so identical (workspace, cmd, env) tuples
// don't re-execute.
//
// Action records are pure data; the executor (src/actions/executor.ts) is the
// one place that knows how to apply each kind. This mirrors the v1
// reconciler's `BakeAction`/`DestroyMachineAction`/… pattern (records, not
// closures) so the snapshot machinery and the dashboard can render per-action
// state uniformly across both surfaces.

import type { ActionStatus, ActionState } from '../reconciler/types.js';

export type { ActionStatus, ActionState } from '../reconciler/types.js';

/**
 * Conditional predicate. `null`/undefined means "always run". Three concrete
 * shapes — env-var-truthy (`"$var"`), branch-exists, file-present — match the
 * issue body's "outgrow declarative if you need more" rule.
 */
export type ActionPredicate =
  | string
  | { branch_exists: string }
  | { file_present: string }
  | null;

/**
 * Port the pure predicate evaluator reaches IO through. `branchExists` is
 * backed by `git rev-parse --verify --quiet` in production; `pathExists` is
 * backed by `fs.stat`. The default implementation lives in
 * `src/actions/predicate-env.ts` so the evaluator core stays free of
 * `node:fs/promises` and `runProcess` imports.
 *
 * `pathExists` receives an absolute path — the evaluator resolves relative
 * file_present strings against the workspace before calling.
 */
export interface PredicateEnv {
  branchExists(ref: string, workspacePath: string): Promise<boolean>;
  pathExists(absPath: string): Promise<boolean>;
}

/**
 * Per-action error policy. Defaults: retry 3 times with exponential backoff
 * starting at 1s, then abort the run. `then: "route_to"` reroutes the issue
 * into a declared state (used by `merge`'s on_conflict).
 */
export interface ActionErrorPolicy {
  retry?: {
    count: number;
    /** Initial backoff in ms; doubles after each failed attempt. */
    backoff_ms: number;
  };
  /**
   * After all retries are exhausted: abort the run (default) or reroute the
   * issue to the named state. `route_to: <state>` is the conflict-routing
   * primitive `merge` uses for `on_conflict: { route_to: <state> }`.
   */
  then?: 'abort' | { route_to: string };
}

interface BaseAction {
  /** Stable name used by `symphony rerun --check=<name>` and snapshot keys. */
  name?: string;
  if?: ActionPredicate;
  on_error?: ActionErrorPolicy;
}

/** `git push <remote> <ref>`. Idempotent at the remote. */
export interface PushBranchAction extends BaseAction {
  kind: 'push_branch';
  remote: string;
  ref: string;
}

/**
 * `gh pr view` then `gh pr create` if missing. The `*_from` fields take a
 * template string the executor resolves against the action context.
 * `body_from` may point to either a literal body or a `$pr_body_file` path
 * (the executor reads files referenced by template variables ending in
 * `_file`).
 */
export interface CreatePrIfMissingAction extends BaseAction {
  kind: 'create_pr_if_missing';
  base: string;
  head: string;
  title_from: string;
  body_from: string;
}

/** Create branch if absent. No-op if it already exists. */
export interface EnsureBranchAction extends BaseAction {
  kind: 'ensure_branch';
  /** Branch name (template-substituted). */
  name: string;
  /** Optional seed ref (e.g. `main`); when absent, branch is cut off HEAD. */
  seed_from?: string;
}

/** `git checkout <ref>`. */
export interface CheckoutAction extends BaseAction {
  kind: 'checkout';
  ref: string;
}

/**
 * `git merge <source>` into `target`. On merge conflict, the
 * `on_conflict.route_to` field is consumed by the executor as a fast path:
 * the issue is rerouted to the named state instead of going through the
 * generic on_error policy. `abort` means "fail the action."
 */
export interface MergeAction extends BaseAction {
  kind: 'merge';
  source: string;
  target: string;
  on_conflict: { route_to: string } | 'abort';
}

/** Delete a branch locally, remotely, or both. */
export interface DeleteBranchAction extends BaseAction {
  kind: 'delete_branch';
  name: string;
  scope: 'local' | 'remote' | 'both';
  /** Required when scope includes `remote`. */
  remote?: string;
}

/**
 * The shell escape hatch. Runs `cmd` (argv form) with the workspace as cwd,
 * timeout, and an env-var map. Cached by hash(workspace_tree ⊕ cmd ⊕ env) so
 * unchanged inputs skip execution. `name` is required because the cache /
 * rerun CLI / snapshot all key off it.
 */
export interface RunInVmAction extends BaseAction {
  kind: 'run_in_vm';
  /** Required; cache + dashboard + `symphony rerun --check=<name>` key. */
  name: string;
  cmd: string[];
  env?: Record<string, string>;
  /** Seconds; the executor enforces with SIGKILL on overrun. */
  timeout?: number;
}

/**
 * Submit a `Triage`-bound issue proposal. Hoists `symphony.propose_issue`'s
 * MCP shape into the action set so terminal states can file follow-ups
 * symmetrically with other actions (e.g. opening a "review-PR-merged"
 * cleanup task on Done). The orchestrator's tracker is the sink; no MCP
 * round-trip is involved.
 */
export interface ProposeFollowupAction extends BaseAction {
  kind: 'propose_followup';
  title: string;
  body?: string;
  labels?: string[];
  priority?: number;
}

/**
 * Closed union of every action kind a workflow `actions:` block can declare.
 * Adding a new kind is a four-step landing: extend this union, the parser,
 * the executor, and the docs.
 */
export type WorkflowAction =
  | PushBranchAction
  | CreatePrIfMissingAction
  | EnsureBranchAction
  | CheckoutAction
  | MergeAction
  | DeleteBranchAction
  | RunInVmAction
  | ProposeFollowupAction;

export type WorkflowActionKind = WorkflowAction['kind'];

/**
 * Template variables exposed to action fields and `if:` predicates. Fixed
 * namespace; arbitrary references throw at run-time so a typo surfaces fast
 * instead of silently expanding to `""`. Naming mirrors the Done state's
 * after_run env vars so the migration is mechanical.
 */
export interface ActionContext {
  /** Always present. */
  identifier: string;
  workspace: string;
  /** Pinned `agent/<identifier>` at dispatch time. */
  branch: string;
  base_branch: string;
  issue_title: string;
  issue_body: string;
  /** Set when `SYMPHONY_REPO` was exported; null otherwise. */
  repo: string | null;
  /** id-prefixed PR title (mirrors SYMPHONY_PR_TITLE). */
  pr_title: string;
  /** Path to a temp file holding the current issue body. */
  pr_body_file: string;
}

/**
 * Outcome of running a single action attempt. Carries enough state for the
 * executor to decide whether to retry, to reroute the issue, or to surface a
 * cache hit. Note: `route_to` is set only when the action's failure mapped
 * to a routed state (today: `merge`'s on_conflict). Generic on_error
 * `route_to` is handled by the executor wrapper.
 */
export interface ActionOutcome {
  ok: boolean;
  reason: string | null;
  /**
   * When non-null, the calling runner should reroute the issue to this state
   * instead of completing normal cleanup.
   */
  route_to: string | null;
  /**
   * True when an action declared cacheable (today: `run_in_vm`) skipped
   * execution because its inputs matched a prior successful run.
   */
  cache_hit?: boolean;
}

/**
 * Snapshot bundle the orchestrator drains from the executor between attempts.
 * Mirrors `ResourceSnapshot` so the dashboard can render workflow-action
 * progress next to reconciler-resource progress. `id` is `actions:<state>`
 * (e.g. `actions:Done`) so a workflow with multiple action-declaring states
 * surfaces each as its own row.
 */
export interface ActionsSnapshot {
  id: string;
  ready: boolean;
  last_error: string | null;
  actions: ActionStatus[];
}
