// $-substitution against a fixed ActionContext namespace (issue 36).
//
// The issue body explicitly says "Mustache or `$`-substitution with a fixed
// namespace is enough; Bazel's Starlark is overkill." We pick `$identifier`
// over `${{ identifier }}` because the Done after_run already uses
// `$SYMPHONY_*` env-var shapes; sharing the prefix style keeps cognitive
// load low for operators converting hooks to actions.
//
// Behavior:
//   • `$name` expands to the named ActionContext field.
//   • An unknown `$name` throws — silent expansion to "" was the most common
//     hook-shell bug (typo'd `$SYMPHONY_PR_TITTLE` is the canonical example).
//   • Literal `$` followed by a non-word char is left alone.
//   • `\$name` escapes the substitution (literal `$name` in output).

import type { ActionContext } from './types.js';

export class TemplateError extends Error {
  constructor(public name: string, message: string) {
    super(message);
    this.name = 'TemplateError';
  }
}

const VAR_RE = /(\\?)\$([A-Za-z_][A-Za-z0-9_]*)/g;

/**
 * Substitute `$name` references in `template` against the ActionContext.
 * Throws TemplateError when a referenced variable is not in the fixed
 * namespace — silent "" expansion masks operator typos.
 */
export function renderTemplate(template: string, ctx: ActionContext): string {
  if (typeof template !== 'string') {
    return template;
  }
  return template.replace(VAR_RE, (full, escape: string, name: string) => {
    if (escape === '\\') return `$${name}`;
    if (!(name in ctx)) {
      throw new TemplateError(
        name,
        `unknown template variable "$${name}" (available: ${Object.keys(ctx).join(', ')})`,
      );
    }
    const v = (ctx as unknown as Record<string, unknown>)[name];
    if (v === null || v === undefined) return '';
    return String(v);
  });
}

/**
 * Render every string field of an object. Used to render an action's
 * declarative fields in one pass before execution. Recurses into arrays and
 * plain objects; primitives other than strings (numbers, booleans) pass
 * through unchanged.
 */
export function renderTree<T>(value: T, ctx: ActionContext): T {
  if (typeof value === 'string') return renderTemplate(value, ctx) as unknown as T;
  if (Array.isArray(value)) {
    return value.map((v) => renderTree(v, ctx)) as unknown as T;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = renderTree(v, ctx);
    }
    return out as unknown as T;
  }
  return value;
}
