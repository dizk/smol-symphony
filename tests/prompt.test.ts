import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderPrompt, PromptError } from '../src/prompt.js';
import type { Issue } from '../src/types.js';

const issue: Issue = {
  id: 'ABC-1',
  identifier: 'ABC-1',
  title: 'Demo',
  description: 'do the thing',
  priority: 2,
  state: 'Todo',
  branch_name: null,
  url: null,
  labels: ['bug'],
  blocked_by: [],
  created_at: null,
  updated_at: null,
};

describe('prompt', () => {
  it('renders simple variables', async () => {
    const out = await renderPrompt({
      template: 'Hello {{ issue.identifier }} ({{ issue.title }})',
      issue,
      attempt: null,
    });
    assert.equal(out, 'Hello ABC-1 (Demo)');
  });

  it('fails on unknown variables (strict)', async () => {
    await assert.rejects(
      () => renderPrompt({ template: '{{ does.not.exist }}', issue, attempt: null }),
      (err: unknown) => err instanceof PromptError && err.code === 'template_render_error',
    );
  });

  it('fails on unknown filters', async () => {
    await assert.rejects(
      () => renderPrompt({ template: '{{ issue.title | nonsense }}', issue, attempt: null }),
      // Liquid may surface unknown-filter errors at either parse or render time depending
      // on version; both are valid §5.4 "strict filters" failures.
      (err: unknown) =>
        err instanceof PromptError &&
        (err.code === 'template_render_error' || err.code === 'template_parse_error'),
    );
  });

  it('falls back to a default prompt when template is empty', async () => {
    const out = await renderPrompt({ template: '   \n   ', issue, attempt: null });
    assert.match(out, /working on an issue/);
  });

  it('blocks prototype property lookups', async () => {
    await assert.rejects(
      () => renderPrompt({ template: '{{ issue.toString }}', issue, attempt: null }),
      (err: unknown) => err instanceof PromptError && err.code === 'template_render_error',
    );
  });
});
