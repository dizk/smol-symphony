import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeEligibilityReason,
  decideReconcileForIssue,
  hasNonTerminalBlocker,
  type EligibilitySnapshot,
} from '../src/orchestrator-decisions.js';
import type { Issue, StateConfig } from '../src/types.js';

const states: Record<string, StateConfig> = {
  Todo: { role: 'active' },
  Review: { role: 'active' },
  Done: { role: 'terminal' },
  Triage: { role: 'holding' },
};

function makeIssue(over: Partial<Issue> = {}): Issue {
  return {
    id: '1', identifier: '1', title: 'a', description: '', priority: 1,
    state: 'Todo', branch_name: null, url: null, labels: [], blocked_by: [],
    created_at: null, updated_at: null, ...over,
  };
}

function makeSnap(over: Partial<EligibilitySnapshot> = {}): EligibilitySnapshot {
  return {
    active: new Set(['todo', 'review']), terminal: new Set(['done']),
    running: new Set(), claimed: new Set(), perStateSlot: () => true, ...over,
  };
}

describe('decideReconcileForIssue', () => {
  it('missing row → terminate without cleanup', () => {
    assert.deepEqual(decideReconcileForIssue(undefined, states), {
      kind: 'terminate', cleanup: false, reason: 'tracker_state_missing',
    });
  });
  it('terminal state → terminate with cleanup driven by role', () => {
    assert.deepEqual(decideReconcileForIssue(makeIssue({ state: 'done' }), states), {
      kind: 'terminate', cleanup: true, reason: 'tracker_state_terminal',
    });
  });
  it('active state → refresh', () => {
    assert.deepEqual(decideReconcileForIssue(makeIssue({ state: 'Review' }), states), { kind: 'refresh' });
  });
  it('holding state → terminate without cleanup', () => {
    assert.deepEqual(decideReconcileForIssue(makeIssue({ state: 'Triage' }), states), {
      kind: 'terminate', cleanup: false, reason: 'tracker_state_non_active',
    });
  });
});

describe('computeEligibilityReason', () => {
  it('flags missing fields', () => {
    assert.equal(
      computeEligibilityReason(makeIssue({ title: '' }), false, makeSnap()),
      'missing required issue fields',
    );
  });
  it('rejects non-active states', () => {
    assert.equal(computeEligibilityReason(makeIssue({ state: 'Done' }), false, makeSnap()), 'state not active');
  });
  it('rejects already running and already claimed (unless ignoreOwnClaim)', () => {
    assert.equal(
      computeEligibilityReason(makeIssue(), false, makeSnap({ running: new Set(['1']) })),
      'already running',
    );
    assert.equal(
      computeEligibilityReason(makeIssue(), false, makeSnap({ claimed: new Set(['1']) })),
      'already claimed',
    );
    assert.equal(
      computeEligibilityReason(makeIssue(), true, makeSnap({ claimed: new Set(['1']) })),
      null,
      'retry path bypasses own claim',
    );
  });
  it('rejects when per-state slot is unavailable', () => {
    assert.equal(
      computeEligibilityReason(makeIssue(), false, makeSnap({ perStateSlot: () => false })),
      'no per-state slot',
    );
  });
  it('Todo with a non-terminal blocker is blocked; only-terminal blockers pass', () => {
    const blocked = makeIssue({ blocked_by: [{ id: 'x', identifier: 'x', state: 'Review' }] });
    assert.equal(computeEligibilityReason(blocked, false, makeSnap()), 'has non-terminal blocker');
    const unblocked = makeIssue({ blocked_by: [{ id: 'x', identifier: 'x', state: 'Done' }] });
    assert.equal(computeEligibilityReason(unblocked, false, makeSnap()), null);
  });
});

describe('hasNonTerminalBlocker', () => {
  it('treats stateless blocker rows as blocking (defensive)', () => {
    const issue = makeIssue({ blocked_by: [{ id: null, identifier: null, state: null }] });
    assert.equal(hasNonTerminalBlocker(issue, new Set(['done'])), true);
  });
});
