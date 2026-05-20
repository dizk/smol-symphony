// Strict Liquid rendering for the per-issue prompt template (SPEC §12, §5.4).
// Unknown variables and unknown filters must fail rendering (§5.4).

import { Liquid, type LiquidOptions } from 'liquidjs';
import type { Issue } from './types.js';

export class PromptError extends Error {
  constructor(public code: 'template_parse_error' | 'template_render_error', message: string) {
    super(message);
    this.name = 'PromptError';
  }
}

const LIQUID_OPTIONS: LiquidOptions = {
  strictVariables: true,
  strictFilters: true,
  // Only resolve own properties so prototype lookups like `issue.toString` are treated as
  // unknown variables instead of silently returning prototype data.
  ownPropertyOnly: true,
};

const ENGINE = new Liquid(LIQUID_OPTIONS);

function issueToScope(issue: Issue): Record<string, unknown> {
  // Convert keys to strings for template compatibility (§12.2). Preserve nested arrays/maps.
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description,
    priority: issue.priority,
    state: issue.state,
    branch_name: issue.branch_name,
    url: issue.url,
    labels: issue.labels.slice(),
    blocked_by: issue.blocked_by.map((b) => ({
      id: b.id,
      identifier: b.identifier,
      state: b.state,
    })),
    created_at: issue.created_at,
    updated_at: issue.updated_at,
  };
}

export interface RenderInput {
  template: string;
  issue: Issue;
  attempt: number | null;
}

const FALLBACK_PROMPT = 'You are working on an issue.';

export async function renderPrompt(input: RenderInput): Promise<string> {
  const tpl = input.template.trim();
  if (tpl.length === 0) {
    // §5.4 fallback prompt when workflow body is empty.
    return FALLBACK_PROMPT;
  }
  let parsed;
  try {
    parsed = ENGINE.parse(tpl);
  } catch (err) {
    throw new PromptError('template_parse_error', (err as Error).message);
  }
  try {
    return await ENGINE.render(parsed, {
      issue: issueToScope(input.issue),
      attempt: input.attempt,
    });
  } catch (err) {
    throw new PromptError('template_render_error', (err as Error).message);
  }
}
