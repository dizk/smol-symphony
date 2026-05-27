import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  decideAttemptOutcome,
  decideCleanupExecution,
  decideTurnContinuation,
  shouldRunIntegrationMerge,
  shouldStageAfterRunEnv,
} from '../src/agent/runner-decisions.js';

describe('shouldRunIntegrationMerge', () => {
  it('is false unless the agent transitioned and the state is opted in', () => {
    const opts = { mergeOnStates: ['Done'] };
    assert.equal(
      shouldRunIntegrationMerge({ transitioned: false, cleanupState: 'Done', ...opts }),
      false,
    );
    assert.equal(
      shouldRunIntegrationMerge({ transitioned: true, cleanupState: 'Review', ...opts }),
      false,
    );
    assert.equal(
      shouldRunIntegrationMerge({ transitioned: true, cleanupState: 'done', ...opts }),
      true,
      'matches case-insensitively against merge_on_states',
    );
  });

  it('is false when merge_on_states is empty (feature off)', () => {
    assert.equal(
      shouldRunIntegrationMerge({ transitioned: true, cleanupState: 'Done', mergeOnStates: [] }),
      false,
    );
  });
});

describe('decideCleanupExecution', () => {
  it('skips, prefers actions over hook, falls back, and needs runningEntry for actions', () => {
    assert.equal(
      decideCleanupExecution({
        integrationFailed: true,
        hasRunningEntry: true,
        actionsLength: 3,
        hasAfterRunHook: true,
      }),
      'skip',
      'integration reroute => no post-cleanup work',
    );
    assert.equal(
      decideCleanupExecution({
        integrationFailed: false,
        hasRunningEntry: true,
        actionsLength: 2,
        hasAfterRunHook: true,
      }),
      'actions',
      'typed actions win when both declared (issue 36 AC2)',
    );
    assert.equal(
      decideCleanupExecution({
        integrationFailed: false,
        hasRunningEntry: true,
        actionsLength: 0,
        hasAfterRunHook: true,
      }),
      'hook',
    );
    assert.equal(
      decideCleanupExecution({
        integrationFailed: false,
        hasRunningEntry: false,
        actionsLength: 3,
        hasAfterRunHook: false,
      }),
      'skip',
      'actions need a runningEntry for SYMPHONY_* env',
    );
    assert.equal(
      decideCleanupExecution({
        integrationFailed: false,
        hasRunningEntry: true,
        actionsLength: 0,
        hasAfterRunHook: false,
      }),
      'skip',
    );
  });
});

describe('shouldStageAfterRunEnv', () => {
  it('stages only when a consumer (actions or hook) will run with a runningEntry', () => {
    assert.equal(
      shouldStageAfterRunEnv({
        integrationFailed: false,
        hasRunningEntry: true,
        actionsLength: 1,
        hasAfterRunHook: false,
      }),
      true,
    );
    assert.equal(
      shouldStageAfterRunEnv({
        integrationFailed: false,
        hasRunningEntry: true,
        actionsLength: 0,
        hasAfterRunHook: true,
      }),
      true,
    );
    assert.equal(
      shouldStageAfterRunEnv({
        integrationFailed: true,
        hasRunningEntry: true,
        actionsLength: 1,
        hasAfterRunHook: true,
      }),
      false,
      'integration reroute skips staging',
    );
    assert.equal(
      shouldStageAfterRunEnv({
        integrationFailed: false,
        hasRunningEntry: false,
        actionsLength: 1,
        hasAfterRunHook: true,
      }),
      false,
    );
  });
});

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

describe('decideTurnContinuation', () => {
  const base = {
    cancelled: false,
    transitioned: false,
    steeringRequested: false,
    issueStillPresent: true,
    issueStillActive: true,
    autonomousTurns: 0,
    maxTurns: 5,
  };

  it('cancellation wins over every other signal', () => {
    assert.deepEqual(
      decideTurnContinuation({ ...base, cancelled: true, transitioned: true }),
      { kind: 'break', reason: 'cancelled_by_reconciliation' },
    );
  });

  it('transitioned breaks before steering or tracker checks fire', () => {
    assert.deepEqual(
      decideTurnContinuation({
        ...base,
        transitioned: true,
        steeringRequested: true,
        issueStillPresent: false,
      }),
      { kind: 'break', reason: 'agent_transitioned' },
    );
  });

  it('steering pauses the loop (no break, no continue)', () => {
    assert.deepEqual(
      decideTurnContinuation({ ...base, steeringRequested: true }),
      { kind: 'await_steering' },
    );
  });

  it('missing tracker entry breaks with issue_no_longer_present', () => {
    assert.deepEqual(
      decideTurnContinuation({ ...base, issueStillPresent: false }),
      { kind: 'break', reason: 'issue_no_longer_present' },
    );
  });

  it('non-active state breaks with issue_no_longer_active', () => {
    assert.deepEqual(
      decideTurnContinuation({ ...base, issueStillActive: false }),
      { kind: 'break', reason: 'issue_no_longer_active' },
    );
  });

  it('max_turns boundary breaks with max_turns_reached', () => {
    assert.deepEqual(
      decideTurnContinuation({ ...base, autonomousTurns: 5, maxTurns: 5 }),
      { kind: 'break', reason: 'max_turns_reached' },
    );
  });

  it('otherwise continues into another autonomous turn', () => {
    assert.deepEqual(
      decideTurnContinuation({ ...base, autonomousTurns: 2, maxTurns: 5 }),
      { kind: 'continue' },
    );
  });
});
