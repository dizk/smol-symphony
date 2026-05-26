// Workflow actions (issue 36 — typed action DAG, reconciler v2).
//
// Public surface for the rest of symphony. The executor and parser are the
// two consumer-facing modules; types stay separate so they can be imported
// without pulling node child_process into pure-data import sites.
//
// The `run_in_vm` cache adapter lives at `./cache.ts` and is NOT re-exported
// here (domain↛adapters): runner/CLI/tests import from `./cache.js` directly.

export * from './types.js';
export { parseActionsBlock } from './parsing.js';
export {
  runActions,
  toActionsSnapshot,
  hostRunInVm,
  type ActionExecResult,
  type ActionExecutorOptions,
  type ProposeFollowupSink,
  type RunInVmExecutor,
} from './executor.js';
export { renderTemplate, renderTree, TemplateError } from './templating.js';
export { evaluatePredicate } from './predicates.js';
