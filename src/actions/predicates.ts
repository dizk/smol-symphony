// `if:` predicate evaluation (issue 36).
//
// Three predicate shapes — env-var-truthy, branch-exists, file-present.
// These are the three predicates the hook shell actually exercised across
// today's WORKFLOW.md; the issue body explicitly caps the predicate set
// there: "If users want more, they've outgrown declarative." The two IO
// shapes reach the world through an injected `PredicateEnv`.

import path from 'node:path';
import type { ActionContext, ActionPredicate, PredicateEnv } from './types.js';
import { renderTemplate } from './templating.js';

/**
 * Evaluate a predicate against the context. `null`/undefined → always true
 * (no `if:` → run unconditionally).
 *
 * The string form `"$var"` is a truthiness check on the named context field
 * — `if: $repo` matches the issue body's example exactly. A bare literal
 * (`if: yes`) is treated as truthy; the literal-false case `if: ""` /
 * `if: null` falls through to "always". `env` is required iff the predicate
 * is `branch_exists` / `file_present`; pure string predicates ignore it.
 */
export async function evaluatePredicate(
  predicate: ActionPredicate | undefined,
  ctx: ActionContext,
  workspacePath: string,
  env?: PredicateEnv,
): Promise<boolean> {
  if (predicate === null || predicate === undefined) return true;
  if (typeof predicate === 'string') {
    // Templates may already have been rendered by the executor's renderTree
    // pass before evaluatePredicate is called; re-rendering an already-rendered
    // empty string is a no-op. An empty (or empty-after-render) predicate is
    // explicitly false — the intent of `if: $repo` with $repo unset is "skip
    // when the var is empty," not "always run".
    const expanded = renderTemplate(predicate, ctx).trim();
    return expanded.length > 0;
  }
  if ('branch_exists' in predicate) {
    const ref = renderTemplate(predicate.branch_exists, ctx).trim();
    if (ref.length === 0) return false;
    if (!env) throw new Error('evaluatePredicate: branch_exists requires an injected PredicateEnv');
    return env.branchExists(ref, workspacePath);
  }
  if ('file_present' in predicate) {
    const file = renderTemplate(predicate.file_present, ctx).trim();
    if (file.length === 0) return false;
    const abs = path.isAbsolute(file) ? file : path.join(workspacePath, file);
    if (!env) throw new Error('evaluatePredicate: file_present requires an injected PredicateEnv');
    return env.pathExists(abs);
  }
  return false;
}
