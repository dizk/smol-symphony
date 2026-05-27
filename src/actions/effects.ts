// Effects-as-data foundation (issue 68): pure planner half of the
// planActions/runEffects split. Effects are plain data describing IO so the
// "decide what to do" half is unit-testable without spawning processes.
// Issues 69/70 build on the `Effect` union.

import type { ActionContext, ActionErrorPolicy, ActionPredicate, WorkflowAction } from './types.js';
import { renderTree, TemplateError } from './templating.js';

const DEFAULT_RETRY_COUNT = 3, DEFAULT_RETRY_BACKOFF_MS = 1_000;

export interface NormalizedActionPolicy {
  retry: { count: number; backoff_ms: number };
  then: 'abort' | { route_to: string };
}

// `kind: 'run'` carries a rendered action + predicate (the shell evaluates
// it — `branch_exists`/`file_present` need IO) + normalised policy.
// `kind: 'render_failed'` surfaces template errors as data so the shell
// ledger records them without re-throwing through the planner.
export type Effect =
  | {
      kind: 'run';
      snapshotKey: string;
      rendered: WorkflowAction;
      predicate: ActionPredicate | undefined;
      policy: NormalizedActionPolicy;
    }
  | { kind: 'render_failed'; snapshotKey: string; error: string };

/** Pure planner — same inputs always produce the same `Effect[]`. */
export function planActions(actions: readonly WorkflowAction[], ctx: ActionContext): Effect[] {
  return actions.map((action, index) => {
    const snapshotKey = actionSnapshotKey(action, index);
    try {
      const rendered = renderTree(action, ctx);
      return {
        kind: 'run',
        snapshotKey,
        rendered,
        predicate: rendered.if ?? undefined,
        policy: effectivePolicy(action.on_error),
      };
    } catch (err) {
      const error = err instanceof TemplateError ? err.message : (err as Error).message;
      return { kind: 'render_failed', snapshotKey, error };
    }
  });
}

function effectivePolicy(p: ActionErrorPolicy | undefined): NormalizedActionPolicy {
  return {
    retry: {
      count: p?.retry?.count ?? DEFAULT_RETRY_COUNT,
      backoff_ms: p?.retry?.backoff_ms ?? DEFAULT_RETRY_BACKOFF_MS,
    },
    then: p?.then ?? 'abort',
  };
}

function actionSnapshotKey(action: WorkflowAction, idx: number): string {
  if (action.name && action.name.length > 0) return `${action.kind}:${action.name}`;
  return `${action.kind}:#${idx}`;
}
