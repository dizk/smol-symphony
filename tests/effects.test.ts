// Pure unit tests for planActions (issue 68). No filesystem, no `runProcess`,
// no clock — same inputs always produce the same Effect[].

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { planActions, type Effect, type ActionContext, type WorkflowAction } from '../src/actions/index.js';

const ctx: ActionContext = {
  identifier: '42',
  workspace: '/ws',
  branch: 'agent/42',
  base_branch: 'main',
  issue_title: 'Some title',
  issue_body: 'Some body',
  repo: 'org/repo',
  pr_title: '42: Some title',
  pr_body_file: '/ws/.body.md',
};
type Run = Extract<Effect, { kind: 'run' }>;
type Fail = Extract<Effect, { kind: 'render_failed' }>;

describe('planActions (pure)', () => {
  it('renders templates against the ActionContext', () => {
    const [first] = planActions([{ kind: 'push_branch', remote: 'origin', ref: '$branch' }], ctx);
    assert.equal(first!.kind, 'run');
    assert.equal(((first as Run).rendered as { ref: string }).ref, 'agent/42');
  });

  it('captures template-render errors as render_failed (no throw)', () => {
    const [first] = planActions([{ kind: 'push_branch', remote: 'origin', ref: '$nope_unknown_var' }], ctx);
    assert.equal(first!.kind, 'render_failed');
    assert.match((first as Fail).error, /\$nope_unknown_var/);
  });

  it('preserves order and assigns deterministic snapshot keys', () => {
    const keys = planActions(
      [
        { kind: 'push_branch', name: 'push-agent', remote: 'origin', ref: '$branch' },
        { kind: 'checkout', ref: '$base_branch' },
        { kind: 'delete_branch', name: 'doomed', scope: 'local' },
      ],
      ctx,
    ).map((e) => e.snapshotKey);
    assert.deepEqual(keys, ['push_branch:push-agent', 'checkout:#1', 'delete_branch:doomed']);
  });

  it('carries the rendered predicate as data (shell evaluates the IO part)', () => {
    const [e] = planActions([{ kind: 'push_branch', remote: 'origin', ref: '$branch', if: '$repo' }], ctx);
    assert.equal((e as Run).predicate, 'org/repo');
  });

  it('normalises per-action retry/then policy with defaults', () => {
    const [a, b] = planActions(
      [
        { kind: 'push_branch', remote: 'origin', ref: 'main' },
        {
          kind: 'merge',
          source: 'agent/42',
          target: 'integration',
          on_conflict: { route_to: 'Conflict' },
          on_error: { retry: { count: 5, backoff_ms: 250 }, then: { route_to: 'Holding' } },
        },
      ],
      ctx,
    );
    assert.deepEqual((a as Run).policy, { retry: { count: 3, backoff_ms: 1_000 }, then: 'abort' });
    assert.deepEqual((b as Run).policy, {
      retry: { count: 5, backoff_ms: 250 },
      then: { route_to: 'Holding' },
    });
  });

  it('is deterministic — repeated calls return structurally equal Effect[]', () => {
    const actions: WorkflowAction[] = [
      { kind: 'push_branch', remote: 'origin', ref: '$branch' },
      {
        kind: 'create_pr_if_missing',
        base: '$base_branch',
        head: '$branch',
        title_from: '$pr_title',
        body_from: '$pr_body_file',
      },
    ];
    assert.deepEqual(planActions(actions, ctx), planActions(actions, ctx));
  });
});
