import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildIssueDetailDto,
  classifyPrIntent,
  computeEligibilityReason,
  decideExitRetry,
  decideReconcileForIssue,
  decideRetryAfterIneligible,
  hasNonTerminalBlocker,
  requiredAdapterIds,
  resolveActorString,
  type EligibilitySnapshot,
} from '../src/orchestrator-decisions.js';
import type { Issue, ServiceConfig, StateConfig } from '../src/types.js';

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

describe('resolveActorString', () => {
  const cfgStates: Record<string, StateConfig> = {
    Todo: { role: 'active' },
    Review: { role: 'active', adapter: 'codex', model: 'gpt-5' },
    Done: { role: 'terminal' },
  };
  it('uses per-state adapter+model overrides', () => {
    assert.equal(resolveActorString(cfgStates, 'claude', 'opus', 'Review'), 'codex/gpt-5');
  });
  it('falls back to workflow defaults when state has no override', () => {
    assert.equal(resolveActorString(cfgStates, 'claude', 'opus', 'Todo'), 'claude/opus');
  });
  it('lowercase state name is matched case-insensitively', () => {
    assert.equal(resolveActorString(cfgStates, 'claude', 'opus', 'review'), 'codex/gpt-5');
  });
  it('unknown state falls back to workflow defaults (no throw)', () => {
    assert.equal(resolveActorString(cfgStates, 'claude', 'opus', 'Bogus'), 'claude/opus');
  });
  it("'default' renders when model is null/undefined", () => {
    assert.equal(resolveActorString(cfgStates, 'claude', null, 'Todo'), 'claude/default');
  });
});

describe('decideExitRetry', () => {
  const base = {
    targetState: 'Todo',
    continuationDelayMs: 1_000,
    failureBaseMs: 10_000,
    maxBackoffMs: 60_000,
  };
  it('normal exit → 1s continuation, attempt 1, no error', () => {
    const r = decideExitRetry({ ...base, normal: true, reason: 'ok', priorAttempt: 3 });
    assert.deepEqual(r, {
      attempt: 1, delayMs: 1_000, error: null, kind: 'continuation', target_state: 'Todo',
    });
  });
  it('abnormal first attempt uses base delay', () => {
    const r = decideExitRetry({ ...base, normal: false, reason: 'crash', priorAttempt: null });
    assert.equal(r.attempt, 1);
    assert.equal(r.delayMs, 10_000);
    assert.equal(r.kind, 'failure');
    assert.equal(r.error, 'crash');
  });
  it('abnormal Nth attempt grows exponentially, capped at maxBackoff', () => {
    const r2 = decideExitRetry({ ...base, normal: false, reason: 'x', priorAttempt: 1 });
    assert.equal(r2.delayMs, 20_000);
    const rCap = decideExitRetry({ ...base, normal: false, reason: 'x', priorAttempt: 10 });
    assert.equal(rCap.delayMs, 60_000);
  });
});

describe('decideRetryAfterIneligible', () => {
  const base = { priorAttempt: 1, targetState: 'Todo', failureBaseMs: 10_000, maxBackoffMs: 60_000 };
  it('no per-state slot → reschedule with backoff', () => {
    const r = decideRetryAfterIneligible({ ...base, reason: 'no per-state slot' });
    assert.equal(r.kind, 'reschedule');
    if (r.kind === 'reschedule') {
      assert.equal(r.plan.attempt, 2);
      assert.equal(r.plan.delayMs, 20_000);
      assert.equal(r.plan.error, 'no available orchestrator slots');
      assert.equal(r.plan.kind, 'failure');
    }
  });
  it('any other reason → release', () => {
    for (const reason of ['has non-terminal blocker', 'state not active', 'missing required issue fields']) {
      assert.deepEqual(decideRetryAfterIneligible({ ...base, reason }), { kind: 'release' });
    }
  });
});

describe('classifyPrIntent', () => {
  const base = { mergeState: 'Done', closeState: 'Cancelled', baseBranch: 'main', mergeWorkspacePath: '/w/issue-1' };
  it('merge state → merge intent with workspace_path', () => {
    const issue = { identifier: '1', state: 'Done', branch_name: null };
    assert.deepEqual(classifyPrIntent({ ...base, issue }), {
      identifier: '1', kind: 'merge', state: 'Done', workspace_path: '/w/issue-1',
      branch: 'agent/1', base_branch: 'main',
    });
  });
  it('close state → close intent with null workspace_path', () => {
    const issue = { identifier: '2', state: 'Cancelled', branch_name: 'custom/branch' };
    assert.deepEqual(classifyPrIntent({ ...base, issue }), {
      identifier: '2', kind: 'close', state: 'Cancelled', workspace_path: null,
      branch: 'custom/branch', base_branch: 'main',
    });
  });
  it('null closeState skips close branch', () => {
    const issue = { identifier: '3', state: 'Cancelled', branch_name: null };
    assert.equal(classifyPrIntent({ ...base, closeState: null, issue }), null);
  });
  it('neither state → null', () => {
    const issue = { identifier: '4', state: 'Review', branch_name: null };
    assert.equal(classifyPrIntent({ ...base, issue }), null);
  });
});

describe('requiredAdapterIds', () => {
  function makeCfg(over: Partial<ServiceConfig> = {}): ServiceConfig {
    return {
      workflow_path: '', workflow_dir: '', tracker: {} as never, polling: {} as never,
      workspace: {} as never, logs: {} as never, hooks: {} as never, agent: {} as never,
      acp: { adapter: 'claude' } as never, smolvm: {} as never, server: {} as never,
      mcp: {} as never, integration: {} as never, pr_autopilot: {} as never,
      states: {}, ...over,
    };
  }
  it('unions workflow default + per-state overrides, filtered by isKnown', () => {
    const cfg = makeCfg({
      acp: { adapter: 'claude' } as never,
      states: {
        Todo: { role: 'active' },
        Review: { role: 'active', adapter: 'codex' },
        Done: { role: 'terminal', adapter: 'bogus' },
      },
    });
    const isKnown = (id: string) => id === 'claude' || id === 'codex';
    assert.deepEqual([...requiredAdapterIds(cfg, isKnown)].sort(), ['claude', 'codex']);
  });
  it('ignores workflow adapter when isKnown rejects it', () => {
    const cfg = makeCfg({ acp: { adapter: 'unknown' } as never, states: {} });
    assert.deepEqual([...requiredAdapterIds(cfg, () => false)], []);
  });
});

describe('buildIssueDetailDto', () => {
  it('returns null when both entry and retry are absent', () => {
    assert.equal(buildIssueDetailDto('x', null, null), null);
  });
  it('builds running-only DTO with status=running', () => {
    const entry = {
      issue_id: 'id-1', identifier: '1', workspace_path: '/w/1', session_id: 's',
      turn_count: 2, state: 'Todo', started_at: 'now', last_event: 'e', last_message: 'm',
      last_event_at: 't', input_tokens: 10, output_tokens: 20, total_tokens: 30,
      recent_events: [], last_error: null,
    };
    const dto = buildIssueDetailDto('1', entry, null) as Record<string, unknown>;
    assert.equal(dto.issue_identifier, '1');
    assert.equal(dto.issue_id, 'id-1');
    assert.equal(dto.status, 'running');
    assert.deepEqual(dto.workspace, { path: '/w/1' });
    assert.equal(dto.retry, null);
    assert.deepEqual(dto.attempts, { current_retry_attempt: null });
  });
  it('builds retry-only DTO with status=retrying and ISO due_at', () => {
    const retry = { issue_id: 'id-2', identifier: '2', attempt: 3, due_at_ms: 0, error: 'boom' };
    const dto = buildIssueDetailDto('2', null, retry) as Record<string, unknown>;
    assert.equal(dto.status, 'retrying');
    assert.equal(dto.running, null);
    assert.equal(dto.last_error, 'boom');
    assert.deepEqual(dto.attempts, { current_retry_attempt: 3 });
    const r = dto.retry as { due_at: string };
    assert.equal(r.due_at, new Date(0).toISOString());
  });
});
