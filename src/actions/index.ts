// Workflow actions (issue 36 — typed action DAG, reconciler v2).
//
// Public surface for the rest of symphony. The executor and parser are the
// two consumer-facing modules; types stay separate so they can be imported
// without pulling node child_process into pure-data import sites.

export * from './types.js';
export { parseActionsBlock } from './parsing.js';
export {
  runActions,
  invalidateRunInVmByName,
  toActionsSnapshot,
  type ActionExecResult,
  type ActionExecutorOptions,
  type ProposeFollowupSink,
} from './executor.js';
export { renderTemplate, renderTree, TemplateError } from './templating.js';
export { evaluatePredicate } from './predicates.js';
export {
  computeCacheHash,
  invalidateCache,
  readCache,
  writeCache,
  runInVmCacheRoot,
  type RunInVmCacheKey,
  type RunInVmCachedResult,
  RUN_IN_VM_CACHE_KIND,
} from './cache.js';
