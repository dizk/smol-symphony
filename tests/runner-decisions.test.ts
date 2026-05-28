import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Issue } from '../src/types.js';
import {
  classifyTurnOutcome,
  decideAttemptOutcome,
  decideTurnContinuation,
  deriveActionContext,
  selectPromptKind,
} from '../src/agent/runner-decisions.js';

function makeIssue(state: string): Issue {
  return {
    id: 'iss-1',
    identifier: '42',
    title: '',
    description: null,
    priority: null,
    state,
    branch_name: null,
    url: null,
    labels: [],
    blocked_by: [],
    created_at: null,
    updated_at: null,
  };
}

describe('decideAttemptOutcome', () => {
  const base = { sessionId: 's-1', turnsCompleted: 3, lastReason: 'max_turns_reached' };

  it('agentFailure > non-routed action failure > success (loop break reason)', () => {
    assert.deepEqual(
      decideAttemptOutcome({ ...base, agentFailure: 'oops', nonRoutedActionFailureReason: 'push' }),
      { ok: false, reason: 'oops', threadId: 's-1', turnsCompleted: 3 },
    );
    assert.deepEqual(
      decideAttemptOutcome({ ...base, agentFailure: null, nonRoutedActionFailureReason: 'push' }),
      { ok: false, reason: 'state action failed: push', threadId: 's-1', turnsCompleted: 3 },
    );
    assert.deepEqual(
      decideAttemptOutcome({ ...base, agentFailure: null, nonRoutedActionFailureReason: null }),
      { ok: true, reason: 'max_turns_reached', threadId: 's-1', turnsCompleted: 3 },
    );
  });
});

describe('selectPromptKind', () => {
  it('steering trumps firstTurn; firstTurn trumps continuation', () => {
    assert.equal(selectPromptKind({ pendingSteering: true, firstTurn: true }), 'steering');
    assert.equal(selectPromptKind({ pendingSteering: true, firstTurn: false }), 'steering');
    assert.equal(selectPromptKind({ pendingSteering: false, firstTurn: true }), 'initial');
    assert.equal(selectPromptKind({ pendingSteering: false, firstTurn: false }), 'continuation');
  });
});

describe('classifyTurnOutcome', () => {
  it('end_turn is success; transitioned beats non-end_turn; otherwise agent failure', () => {
    assert.deepEqual(
      classifyTurnOutcome({ outcomeReason: 'end_turn', outcomeMessage: '', transitioned: false }),
      { kind: 'success' },
    );
    assert.deepEqual(
      classifyTurnOutcome({ outcomeReason: 'end_turn', outcomeMessage: '', transitioned: true }),
      { kind: 'success' },
      'end_turn is success regardless of transitioned',
    );
    assert.deepEqual(
      classifyTurnOutcome({ outcomeReason: 'cancelled', outcomeMessage: 'by user', transitioned: true }),
      { kind: 'agent_transitioned' },
      'transitioned overrides a cancelled outcome (the work is done)',
    );
    assert.deepEqual(
      classifyTurnOutcome({ outcomeReason: 'max_tokens', outcomeMessage: 'limit', transitioned: false }),
      {
        kind: 'agent_failure',
        agentFailure: 'agent turn max_tokens: limit',
        reason: 'max_tokens',
      },
    );
  });
});

describe('decideTurnContinuation', () => {
  const activeStates = new Set(['todo', 'review']);

  it('missing issue → issue_no_longer_present', () => {
    assert.deepEqual(
      decideTurnContinuation({
        refreshedIssue: null,
        activeStates,
        autonomousTurns: 0,
        maxTurns: 5,
      }),
      { kind: 'break', reason: 'issue_no_longer_present' },
    );
  });

  it('inactive state → issue_no_longer_active (case-insensitive)', () => {
    assert.deepEqual(
      decideTurnContinuation({
        refreshedIssue: makeIssue('Done'),
        activeStates,
        autonomousTurns: 0,
        maxTurns: 5,
      }),
      { kind: 'break', reason: 'issue_no_longer_active' },
    );
    // Issue state casing should not matter — activeStates are already lowercase.
    assert.equal(
      decideTurnContinuation({
        refreshedIssue: makeIssue('TODO'),
        activeStates,
        autonomousTurns: 0,
        maxTurns: 5,
      }).kind,
      'continue',
    );
  });

  it('max_turns reached → break with max_turns_reached', () => {
    assert.deepEqual(
      decideTurnContinuation({
        refreshedIssue: makeIssue('Todo'),
        activeStates,
        autonomousTurns: 5,
        maxTurns: 5,
      }),
      { kind: 'break', reason: 'max_turns_reached' },
    );
    assert.deepEqual(
      decideTurnContinuation({
        refreshedIssue: makeIssue('Todo'),
        activeStates,
        autonomousTurns: 6,
        maxTurns: 5,
      }),
      { kind: 'break', reason: 'max_turns_reached' },
      'strictly >= triggers',
    );
  });

  it('active + under budget → continue', () => {
    assert.deepEqual(
      decideTurnContinuation({
        refreshedIssue: makeIssue('Todo'),
        activeStates,
        autonomousTurns: 4,
        maxTurns: 5,
      }),
      { kind: 'continue' },
    );
  });
});

describe('deriveActionContext', () => {
  it('uses staged SYMPHONY_* env when present', () => {
    const ctx = deriveActionContext({
      identifier: '7',
      workspacePath: '/ws/7',
      issueId: 'iss-7',
      issueTitle: 'Add foo',
      issueDescription: 'body',
      repoEnv: 'owner/repo',
      extraEnv: {
        SYMPHONY_BRANCH: 'agent/custom',
        SYMPHONY_BASE_BRANCH: 'develop',
        SYMPHONY_PR_TITLE: 'overridden',
        SYMPHONY_PR_BODY_FILE: '/tmp/body.md',
      },
    });
    assert.deepEqual(ctx, {
      identifier: '7',
      workspace: '/ws/7',
      branch: 'agent/custom',
      base_branch: 'develop',
      issue_title: 'Add foo',
      issue_body: 'body',
      repo: 'owner/repo',
      pr_title: 'overridden',
      pr_body_file: '/tmp/body.md',
    });
  });

  it('falls back to defaults when staged env is missing', () => {
    const ctx = deriveActionContext({
      identifier: '8',
      workspacePath: '/ws/8',
      issueId: 'iss-8',
      issueTitle: '  Trim me  ',
      issueDescription: null,
      repoEnv: undefined,
      extraEnv: undefined,
    });
    assert.equal(ctx.branch, 'agent/8');
    assert.equal(ctx.base_branch, 'main');
    assert.equal(ctx.pr_title, 'iss-8: Trim me', 'trims title and id-prefixes');
    assert.equal(ctx.pr_body_file, '');
    assert.equal(ctx.repo, null, 'undefined repoEnv → null');
    assert.equal(ctx.issue_body, '', 'null description → empty string');
  });

  it('empty title → bare issue id for pr_title; empty repoEnv → null', () => {
    const ctx = deriveActionContext({
      identifier: '9',
      workspacePath: '/ws/9',
      issueId: 'iss-9',
      issueTitle: '   ',
      issueDescription: '',
      repoEnv: '',
      extraEnv: {},
    });
    assert.equal(ctx.pr_title, 'iss-9', 'no title → just the id');
    assert.equal(ctx.repo, null);
  });
});
