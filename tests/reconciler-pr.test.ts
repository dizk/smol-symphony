// PR autopilot resource tests (issue 38; simplified by issue 101). Covers the
// new shrunk autopilot:
//
//   (a) mergeable + open → arm auto-merge.
//   (b) CONFLICTING → route back to the implementing state with notes (no
//       counter, no holding state, no host-side rebase).
//   (c) MERGED / CLOSED → cleanup workspace + remote branch (latched).
//   (d) CLOSE intent (Cancelled path) → close PR + delete remote branch.
//   (e) UNKNOWN → defer until next pass; no arm / no route.
//
// All resource-level I/O is behind stubs (PrApi, PrTransitionApi,
// PrCleanupApi) so the suite is fully in-process — no `gh`, no `git`, no
// GitHub round-trips. There is no longer a PrGitApi or workspaceEnsure
// surface: the autopilot does not rebase from the workspace and does not
// materialize missing workspaces. The dispatched agent owns rebasing onto
// the freshly-fetched `origin/<base>`.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  PrResource,
  type PrApi,
  type PrCleanupApi,
  type PrIntent,
  type PrIntendedProvider,
  type PrSummary,
  type PrTransitionApi,
  type PrView,
} from '../src/reconciler/pr.js';

// ── shared fixtures ─────────────────────────────────────────────────────────

function makeIntent(over: Partial<PrIntent> = {}): PrIntent {
  return {
    identifier: '42',
    kind: 'merge',
    state: 'Done',
    workspace_path: '/tmp/ws/42',
    branch: 'agent/42',
    base_branch: 'main',
    ...over,
  };
}

function makeView(over: Partial<PrView> = {}): PrView {
  return {
    number: 7,
    url: 'https://example.test/pr/7',
    state: 'OPEN',
    mergeable: 'MERGEABLE',
    merge_state_status: 'CLEAN',
    base_ref_name: 'main',
    base_ref_oid: 'base-oid',
    head_ref_name: 'agent/42',
    head_ref_oid: 'head-1',
    review_decision: 'APPROVED',
    auto_merge_armed: false,
    ...over,
  };
}

function intended(intents: PrIntent[]): PrIntendedProvider {
  return { prIntended: async () => intents };
}

interface PrApiCalls {
  list: string[];
  view: number[];
  arm: Array<{ pr: number; strategy: string }>;
  updateBranch: number[];
  close: number[];
  deleteBranch: string[];
}

function makePrApi(opts: {
  summary?: PrSummary | null;
  view?: PrView | (() => PrView);
  viewSequence?: PrView[];
  armThrows?: Error;
  updateBranchThrows?: Error;
  closeThrows?: Error;
  deleteThrows?: Error;
}): { api: PrApi; calls: PrApiCalls } {
  const calls: PrApiCalls = {
    list: [],
    view: [],
    arm: [],
    updateBranch: [],
    close: [],
    deleteBranch: [],
  };
  let viewIdx = 0;
  const api: PrApi = {
    async listForBranch(branch) {
      calls.list.push(branch);
      return opts.summary === undefined ? { number: 7, url: 'https://example.test/pr/7' } : opts.summary;
    },
    async view(n) {
      calls.view.push(n);
      if (opts.viewSequence) {
        const v = opts.viewSequence[viewIdx] ?? opts.viewSequence[opts.viewSequence.length - 1]!;
        viewIdx += 1;
        return v;
      }
      if (typeof opts.view === 'function') return opts.view();
      return opts.view ?? makeView();
    },
    async armAutoMerge(pr, strategy) {
      calls.arm.push({ pr, strategy });
      if (opts.armThrows) throw opts.armThrows;
    },
    async updateBranch(pr) {
      calls.updateBranch.push(pr);
      if (opts.updateBranchThrows) throw opts.updateBranchThrows;
    },
    async closePr(pr) {
      calls.close.push(pr);
      if (opts.closeThrows) throw opts.closeThrows;
    },
    async deleteRemoteBranch(branch) {
      calls.deleteBranch.push(branch);
      if (opts.deleteThrows) throw opts.deleteThrows;
    },
  };
  return { api, calls };
}

function makeTransition(): {
  transition: PrTransitionApi;
  calls: Array<{ identifier: string; fromState: string; toState: string; notes: string; actor: string }>;
} {
  const calls: Array<{ identifier: string; fromState: string; toState: string; notes: string; actor: string }> = [];
  return {
    transition: {
      async routeIssue(input) {
        calls.push(input);
      },
    },
    calls,
  };
}

function makeCleanup(): { cleanup: PrCleanupApi; removed: string[] } {
  const removed: string[] = [];
  return {
    cleanup: {
      async removeWorkspace(identifier) {
        removed.push(identifier);
      },
    },
    removed,
  };
}

// ── tests ───────────────────────────────────────────────────────────────────

describe('PrResource — mergeable PR happy path', () => {
  it('observes the PR and arms auto-merge when mergeable', async () => {
    const intent = makeIntent();
    const { api, calls: apiCalls } = makePrApi({ view: makeView() });
    const { transition, calls: trCalls } = makeTransition();
    const { cleanup, removed } = makeCleanup();

    const res = new PrResource({
      intended: intended([intent]),
      pr: api,
      transition,
      cleanup,
      strategy: 'squash',
      conflictRouteTo: 'Todo',
      pollIntervalMs: 0,
    });

    await res.reconcile();

    assert.deepEqual(apiCalls.list, ['agent/42']);
    assert.deepEqual(apiCalls.view, [7]);
    assert.deepEqual(apiCalls.arm, [{ pr: 7, strategy: 'squash' }]);
    assert.equal(apiCalls.updateBranch.length, 0, 'CLEAN PRs do not get update-branch');
    assert.equal(trCalls.length, 0);
    assert.equal(removed.length, 0);

    const snap = res.snapshot();
    assert.equal(snap.id, 'pr');
    const armed = snap.actions.find((a) => a.action === 'arm_auto_merge:7');
    assert.ok(armed, 'arm_auto_merge in ledger');
    assert.equal(armed!.state, 'done');
  });

  it('does not re-arm an already-armed PR on a subsequent pass', async () => {
    const intent = makeIntent();
    const { api, calls } = makePrApi({
      viewSequence: [
        makeView({ auto_merge_armed: false }),
        makeView({ auto_merge_armed: true }),
      ],
    });
    const { transition } = makeTransition();
    const { cleanup } = makeCleanup();
    const res = new PrResource({
      intended: intended([intent]),
      pr: api,
      transition,
      cleanup,
      strategy: 'squash',
      conflictRouteTo: 'Todo',
      pollIntervalMs: 0,
    });
    await res.reconcile();
    await res.reconcile();
    assert.equal(calls.arm.length, 1, 'arm called exactly once across two passes');
  });

  it('skips when no open PR is found for the branch (local-only mode)', async () => {
    const intent = makeIntent();
    const { api, calls } = makePrApi({ summary: null });
    const { transition } = makeTransition();
    const { cleanup } = makeCleanup();
    const res = new PrResource({
      intended: intended([intent]),
      pr: api,
      transition,
      cleanup,
      strategy: 'squash',
      conflictRouteTo: 'Todo',
      pollIntervalMs: 0,
    });
    await res.reconcile();
    assert.deepEqual(calls.list, ['agent/42']);
    assert.equal(calls.view.length, 0);
    assert.equal(calls.arm.length, 0);
  });
});

describe('PrResource — CONFLICTING route back to implementing', () => {
  it('routes Done → Todo with notes when the PR is reported CONFLICTING', async () => {
    const intent = makeIntent();
    const { api, calls: apiCalls } = makePrApi({
      view: makeView({ mergeable: 'CONFLICTING' }),
    });
    const { transition, calls: trCalls } = makeTransition();
    const { cleanup } = makeCleanup();

    const res = new PrResource({
      intended: intended([intent]),
      pr: api,
      transition,
      cleanup,
      strategy: 'squash',
      conflictRouteTo: 'Todo',
      pollIntervalMs: 0,
    });
    await res.reconcile();

    assert.equal(apiCalls.arm.length, 0, 'no arm on a CONFLICTING PR');
    assert.equal(trCalls.length, 1);
    const call = trCalls[0]!;
    assert.equal(call.identifier, '42');
    assert.equal(call.fromState, 'Done');
    assert.equal(call.toState, 'Todo');
    assert.match(call.notes, /not mergeable against base/);
    assert.match(call.notes, /CONFLICTING/);
    assert.match(call.notes, /agent rebases/i);
    assert.equal(call.actor, 'pr-autopilot');
  });

  it('records the routing action in the ledger', async () => {
    const intent = makeIntent();
    const { api } = makePrApi({ view: makeView({ mergeable: 'CONFLICTING' }) });
    const { transition } = makeTransition();
    const { cleanup } = makeCleanup();
    const res = new PrResource({
      intended: intended([intent]),
      pr: api,
      transition,
      cleanup,
      strategy: 'squash',
      conflictRouteTo: 'Todo',
      pollIntervalMs: 0,
    });
    await res.reconcile();
    const snap = res.snapshot();
    const routed = snap.actions.find((a) => a.action === 'route_to_conflict:42:todo');
    assert.ok(routed);
    assert.equal(routed!.state, 'done');
  });

  it('still routes when there is no workspace_path (textual fallback path)', async () => {
    // No workspace = autopilot was enabled mid-flight and the dir was already
    // reaped. The autopilot has no rebase machinery anymore, so the only
    // distinction the workspace_path makes is in the notes block.
    const intent = makeIntent({ workspace_path: null });
    const { api } = makePrApi({ view: makeView({ mergeable: 'CONFLICTING' }) });
    const { transition, calls: trCalls } = makeTransition();
    const { cleanup } = makeCleanup();
    const res = new PrResource({
      intended: intended([intent]),
      pr: api,
      transition,
      cleanup,
      strategy: 'squash',
      conflictRouteTo: 'Todo',
      pollIntervalMs: 0,
    });
    await res.reconcile();

    assert.equal(trCalls.length, 1);
    assert.equal(trCalls[0]!.toState, 'Todo');
    assert.match(trCalls[0]!.notes, /CONFLICTING/);
  });

  it('does not arm after a CONFLICTING route even on a subsequent pass before the agent runs', async () => {
    // Routing transitions the file out of the merge state, so the next
    // reconcile pass simply doesn't see this identifier in intents. We model
    // that with a mutable provider.
    let intents: PrIntent[] = [makeIntent()];
    const provider: PrIntendedProvider = { prIntended: async () => intents };
    const { api, calls: apiCalls } = makePrApi({
      view: makeView({ mergeable: 'CONFLICTING' }),
    });
    const { transition, calls: trCalls } = makeTransition();
    const { cleanup } = makeCleanup();
    const res = new PrResource({
      intended: provider,
      pr: api,
      transition,
      cleanup,
      strategy: 'squash',
      conflictRouteTo: 'Todo',
      pollIntervalMs: 0,
    });

    await res.reconcile();
    assert.equal(trCalls.length, 1, 'first pass routes on CONFLICTING');
    assert.equal(apiCalls.arm.length, 0);

    // Issue is now in Todo; the autopilot sees nothing.
    intents = [];
    await res.reconcile();
    assert.equal(trCalls.length, 1, 'no second route while issue is not in merge state');
    assert.equal(apiCalls.arm.length, 0);
  });

  it('routes again when the agent re-pushes and the PR still reports CONFLICTING', async () => {
    // The agent rebased and pushed but the PR still ends up CONFLICTING
    // (race with another merge). The autopilot routes again — no circuit
    // breaker, just the same simple loop.
    let intents: PrIntent[] = [];
    const provider: PrIntendedProvider = { prIntended: async () => intents };
    const { api } = makePrApi({
      view: makeView({ mergeable: 'CONFLICTING' }),
    });
    const { transition, calls: trCalls } = makeTransition();
    const { cleanup } = makeCleanup();
    const res = new PrResource({
      intended: provider,
      pr: api,
      transition,
      cleanup,
      strategy: 'squash',
      conflictRouteTo: 'Todo',
      pollIntervalMs: 0,
    });

    for (let round = 1; round <= 4; round += 1) {
      intents = [makeIntent()];
      await res.reconcile();
      intents = [];
      await res.reconcile();
    }

    assert.equal(trCalls.length, 4, 'every round routes — no circuit breaker');
    for (const call of trCalls) {
      assert.equal(call.toState, 'Todo');
    }
  });
});

describe('PrResource — UNKNOWN mergeable', () => {
  it('defers (no arm, no route) when GitHub reports UNKNOWN', async () => {
    const intent = makeIntent();
    const { api, calls: apiCalls } = makePrApi({
      view: makeView({ mergeable: 'UNKNOWN' }),
    });
    const { transition, calls: trCalls } = makeTransition();
    const { cleanup } = makeCleanup();
    const res = new PrResource({
      intended: intended([intent]),
      pr: api,
      transition,
      cleanup,
      strategy: 'squash',
      conflictRouteTo: 'Todo',
      pollIntervalMs: 0,
    });
    await res.reconcile();

    assert.equal(apiCalls.arm.length, 0, 'no arm on UNKNOWN');
    assert.equal(apiCalls.updateBranch.length, 0, 'no update-branch on UNKNOWN');
    assert.equal(trCalls.length, 0, 'no route on UNKNOWN');
  });
});

describe('PrResource — MERGEABLE + BEHIND advances the branch', () => {
  it('issues `gh pr update-branch` when MERGEABLE+BEHIND, even after auto-merge is armed', async () => {
    // The stuck-armed scenario from issue 105: mergeable=MERGEABLE,
    // mergeStateStatus=BEHIND, auto_merge_armed=true. Without
    // update-branch the PR sits forever — branch protection blocks the
    // armed merge until the branch catches up.
    const intent = makeIntent();
    const { api, calls: apiCalls } = makePrApi({
      view: makeView({ merge_state_status: 'BEHIND', auto_merge_armed: true }),
    });
    const { transition, calls: trCalls } = makeTransition();
    const { cleanup } = makeCleanup();
    const res = new PrResource({
      intended: intended([intent]),
      pr: api,
      transition,
      cleanup,
      strategy: 'squash',
      conflictRouteTo: 'Todo',
      pollIntervalMs: 0,
    });
    await res.reconcile();

    assert.deepEqual(apiCalls.updateBranch, [7]);
    assert.equal(apiCalls.arm.length, 0, 'already armed by GitHub; do not re-arm');
    assert.equal(trCalls.length, 0, 'BEHIND is not a conflict route');

    const snap = res.snapshot();
    const upd = snap.actions.find((a) => a.action === 'update_branch:7');
    assert.ok(upd, 'update_branch in ledger');
    assert.equal(upd!.state, 'done');
  });

  it('arms auto-merge AND advances the branch on first pass when MERGEABLE+BEHIND and not yet armed', async () => {
    const intent = makeIntent();
    const { api, calls: apiCalls } = makePrApi({
      view: makeView({ merge_state_status: 'BEHIND', auto_merge_armed: false }),
    });
    const { transition } = makeTransition();
    const { cleanup } = makeCleanup();
    const res = new PrResource({
      intended: intended([intent]),
      pr: api,
      transition,
      cleanup,
      strategy: 'squash',
      conflictRouteTo: 'Todo',
      pollIntervalMs: 0,
    });
    await res.reconcile();

    assert.deepEqual(apiCalls.arm, [{ pr: 7, strategy: 'squash' }]);
    assert.deepEqual(apiCalls.updateBranch, [7]);
  });

  it('does not re-issue update-branch within a single pass (cached view still reads BEHIND)', async () => {
    // The decide-then-apply loop in pr.ts runs decidePr again after each
    // effect batch; the per-PR poll TTL only throttles between reconcile
    // passes. The update_branch handler must halt the pass so we don't
    // hammer gh until the loop iteration cap is reached.
    const intent = makeIntent();
    const { api, calls: apiCalls } = makePrApi({
      view: makeView({ merge_state_status: 'BEHIND', auto_merge_armed: true }),
    });
    const { transition } = makeTransition();
    const { cleanup } = makeCleanup();
    const res = new PrResource({
      intended: intended([intent]),
      pr: api,
      transition,
      cleanup,
      strategy: 'squash',
      conflictRouteTo: 'Todo',
      pollIntervalMs: 0,
    });
    await res.reconcile();
    assert.equal(apiCalls.updateBranch.length, 1);
  });

  it('does NOT emit update_branch on MERGEABLE+CLEAN (arms only, today\'s behavior)', async () => {
    const intent = makeIntent();
    const { api, calls: apiCalls } = makePrApi({
      view: makeView({ merge_state_status: 'CLEAN' }),
    });
    const { transition, calls: trCalls } = makeTransition();
    const { cleanup } = makeCleanup();
    const res = new PrResource({
      intended: intended([intent]),
      pr: api,
      transition,
      cleanup,
      strategy: 'squash',
      conflictRouteTo: 'Todo',
      pollIntervalMs: 0,
    });
    await res.reconcile();

    assert.deepEqual(apiCalls.arm, [{ pr: 7, strategy: 'squash' }]);
    assert.equal(apiCalls.updateBranch.length, 0);
    assert.equal(trCalls.length, 0);
  });

  it('does NOT emit update_branch on MERGEABLE+BLOCKED (e.g. required reviews pending)', async () => {
    // BLOCKED means branch protection is blocking on something other than
    // staleness (failing checks, missing reviews). update-branch wouldn't
    // unblock it; the armed auto-merge waits for the gate to lift.
    const intent = makeIntent();
    const { api, calls: apiCalls } = makePrApi({
      view: makeView({ merge_state_status: 'BLOCKED', auto_merge_armed: true }),
    });
    const { transition, calls: trCalls } = makeTransition();
    const { cleanup } = makeCleanup();
    const res = new PrResource({
      intended: intended([intent]),
      pr: api,
      transition,
      cleanup,
      strategy: 'squash',
      conflictRouteTo: 'Todo',
      pollIntervalMs: 0,
    });
    await res.reconcile();

    assert.equal(apiCalls.updateBranch.length, 0);
    assert.equal(apiCalls.arm.length, 0, 'already armed; do nothing');
    assert.equal(trCalls.length, 0);
  });

  it('CONFLICTING still routes back to implementing — BEHIND does not displace the conflict path', async () => {
    // Sanity that the new BEHIND branch is gated by mergeable=MERGEABLE,
    // not reached for CONFLICTING views even if mergeStateStatus is BEHIND.
    const intent = makeIntent();
    const { api, calls: apiCalls } = makePrApi({
      view: makeView({ mergeable: 'CONFLICTING', merge_state_status: 'DIRTY' }),
    });
    const { transition, calls: trCalls } = makeTransition();
    const { cleanup } = makeCleanup();
    const res = new PrResource({
      intended: intended([intent]),
      pr: api,
      transition,
      cleanup,
      strategy: 'squash',
      conflictRouteTo: 'Todo',
      pollIntervalMs: 0,
    });
    await res.reconcile();

    assert.equal(apiCalls.updateBranch.length, 0);
    assert.equal(apiCalls.arm.length, 0);
    assert.equal(trCalls.length, 1);
    assert.equal(trCalls[0]!.toState, 'Todo');
  });

  it('records update_branch errors in last_error without crashing the pass', async () => {
    const intent = makeIntent();
    const { api } = makePrApi({
      view: makeView({ merge_state_status: 'BEHIND', auto_merge_armed: true }),
      updateBranchThrows: new Error('gh pr update-branch 422: not authorized'),
    });
    const { transition } = makeTransition();
    const { cleanup } = makeCleanup();
    const res = new PrResource({
      intended: intended([intent]),
      pr: api,
      transition,
      cleanup,
      strategy: 'squash',
      conflictRouteTo: 'Todo',
      pollIntervalMs: 0,
    });
    await res.reconcile();
    assert.match(res.snapshot().last_error ?? '', /update-branch 422/);
  });
});

describe('PrResource — auto-merge observation + cleanup', () => {
  it('cleans up workspace + remote branch when the PR is MERGED', async () => {
    const intent = makeIntent();
    const { api, calls: apiCalls } = makePrApi({
      view: makeView({ state: 'MERGED' }),
    });
    const { transition } = makeTransition();
    const { cleanup, removed } = makeCleanup();

    const res = new PrResource({
      intended: intended([intent]),
      pr: api,
      transition,
      cleanup,
      strategy: 'squash',
      conflictRouteTo: 'Todo',
      pollIntervalMs: 0,
    });
    await res.reconcile();

    assert.deepEqual(apiCalls.deleteBranch, ['agent/42']);
    assert.deepEqual(removed, ['42']);

    // Second pass with the same intent should be a no-op (completed latched).
    await res.reconcile();
    assert.deepEqual(removed, ['42'], 'cleanup only fires once');
  });

  it('cleans up workspace AND remote branch on a PR that was CLOSED out from under the autopilot', async () => {
    const intent = makeIntent();
    const { api, calls } = makePrApi({ view: makeView({ state: 'CLOSED' }) });
    const { transition } = makeTransition();
    const { cleanup, removed } = makeCleanup();
    const res = new PrResource({
      intended: intended([intent]),
      pr: api,
      transition,
      cleanup,
      strategy: 'squash',
      conflictRouteTo: 'Todo',
      pollIntervalMs: 0,
    });
    await res.reconcile();
    assert.deepEqual(removed, ['42']);
    assert.deepEqual(calls.deleteBranch, ['agent/42']);

    await res.reconcile();
    assert.equal(calls.deleteBranch.length, 1);
    assert.equal(removed.length, 1);
  });
});

describe('PrResource — terminal state observation across TTL', () => {
  it('observes MERGED after the PR ages out of OPEN and completes cleanup', async () => {
    let now = 1_000;
    const intent = makeIntent();
    let currentView: PrView = makeView();
    const { api, calls: apiCalls } = makePrApi({
      view: () => currentView,
    });
    const { transition } = makeTransition();
    const { cleanup, removed } = makeCleanup();
    const res = new PrResource({
      intended: intended([intent]),
      pr: api,
      transition,
      cleanup,
      strategy: 'squash',
      conflictRouteTo: 'Todo',
      pollIntervalMs: 30_000,
      now: () => now,
    });

    await res.reconcile();
    assert.equal(apiCalls.list.length, 1, 'listForBranch fires on first lookup');
    assert.equal(apiCalls.view.length, 1);
    assert.equal(apiCalls.arm.length, 1, 'first pass arms auto-merge');

    now += 60_000;
    currentView = makeView({ state: 'MERGED' });

    await res.reconcile();
    assert.equal(
      apiCalls.list.length,
      1,
      'listForBranch sticky — never re-called after PR transitions out of OPEN',
    );
    assert.equal(apiCalls.view.length, 2, 'view re-fetched past TTL');
    assert.deepEqual(removed, ['42'], 'workspace cleaned up after observed merge');
    assert.deepEqual(
      apiCalls.deleteBranch,
      ['agent/42'],
      'remote branch cleaned up after observed merge',
    );
  });

  it('re-polls listForBranch past TTL only when no PR has ever been found', async () => {
    let now = 1_000;
    const intent = makeIntent();
    const { api, calls } = makePrApi({ summary: null });
    const { transition } = makeTransition();
    const { cleanup } = makeCleanup();
    const res = new PrResource({
      intended: intended([intent]),
      pr: api,
      transition,
      cleanup,
      strategy: 'squash',
      conflictRouteTo: 'Todo',
      pollIntervalMs: 30_000,
      now: () => now,
    });
    await res.reconcile();
    assert.equal(calls.list.length, 1);

    now += 5_000;
    await res.reconcile();
    assert.equal(calls.list.length, 1, 'null-result cache holds within TTL');

    now += 30_000;
    await res.reconcile();
    assert.equal(calls.list.length, 2, 'null-result re-polled past TTL');
  });
});

describe('PrResource — cancelled close path', () => {
  it('closes the PR and deletes the remote branch when intent.kind=close', async () => {
    const intent = makeIntent({ kind: 'close', state: 'Cancelled', workspace_path: null });
    const { api, calls } = makePrApi({});
    const { transition } = makeTransition();
    const { cleanup, removed } = makeCleanup();
    const res = new PrResource({
      intended: intended([intent]),
      pr: api,
      transition,
      cleanup,
      strategy: 'squash',
      conflictRouteTo: 'Todo',
      pollIntervalMs: 0,
    });
    await res.reconcile();

    assert.deepEqual(calls.close, [7]);
    assert.deepEqual(calls.deleteBranch, ['agent/42']);
    assert.equal(removed.length, 0, 'close path does not remove workspace (normal terminal cleanup handles it)');
  });

  it('latches completed so a subsequent pass does not re-close', async () => {
    const intent = makeIntent({ kind: 'close', state: 'Cancelled', workspace_path: null });
    const { api, calls } = makePrApi({});
    const { transition } = makeTransition();
    const { cleanup } = makeCleanup();
    const res = new PrResource({
      intended: intended([intent]),
      pr: api,
      transition,
      cleanup,
      strategy: 'squash',
      conflictRouteTo: 'Todo',
      pollIntervalMs: 0,
    });
    await res.reconcile();
    await res.reconcile();
    assert.equal(calls.close.length, 1);
    assert.equal(calls.deleteBranch.length, 1);
  });

  it('still deletes the remote branch when the PR is already CLOSED before the autopilot observes it', async () => {
    const intent = makeIntent({ kind: 'close', state: 'Cancelled', workspace_path: null });
    const { api, calls } = makePrApi({ view: makeView({ state: 'CLOSED' }) });
    const { transition } = makeTransition();
    const { cleanup, removed } = makeCleanup();
    const res = new PrResource({
      intended: intended([intent]),
      pr: api,
      transition,
      cleanup,
      strategy: 'squash',
      conflictRouteTo: 'Todo',
      pollIntervalMs: 0,
    });
    await res.reconcile();
    assert.equal(calls.close.length, 0, 'no close call when already closed');
    assert.deepEqual(calls.deleteBranch, ['agent/42']);
    assert.equal(removed.length, 0);

    await res.reconcile();
    assert.equal(calls.deleteBranch.length, 1);
  });

  it('does NOT delete the remote branch when gh pr close fails on an open PR', async () => {
    const intent = makeIntent({ kind: 'close', state: 'Cancelled', workspace_path: null });
    const { api, calls } = makePrApi({
      view: makeView({ state: 'OPEN' }),
      closeThrows: new Error('gh pr close 401: bad credentials'),
    });
    const { transition } = makeTransition();
    const { cleanup } = makeCleanup();
    const res = new PrResource({
      intended: intended([intent]),
      pr: api,
      transition,
      cleanup,
      strategy: 'squash',
      conflictRouteTo: 'Todo',
      pollIntervalMs: 0,
    });
    await res.reconcile();
    assert.deepEqual(calls.close, [7], 'close was attempted on the open PR');
    assert.equal(
      calls.deleteBranch.length,
      0,
      'remote branch must NOT be deleted when close failed (PR still open on origin)',
    );
    const snap = res.snapshot();
    assert.match(snap.last_error ?? '', /gh pr close 401/);
  });
});

describe('PrResource — poll interval cache', () => {
  it('reuses the cached PR view within poll_interval_ms', async () => {
    let now = 1_000;
    const intent = makeIntent();
    const { api, calls } = makePrApi({ view: makeView({ auto_merge_armed: true }) });
    const { transition } = makeTransition();
    const { cleanup } = makeCleanup();
    const res = new PrResource({
      intended: intended([intent]),
      pr: api,
      transition,
      cleanup,
      strategy: 'squash',
      conflictRouteTo: 'Todo',
      pollIntervalMs: 30_000,
      now: () => now,
    });

    await res.reconcile();
    now += 5_000;
    await res.reconcile();
    assert.equal(calls.list.length, 1, 'list call cached within TTL');
    assert.equal(calls.view.length, 1, 'view call cached within TTL');

    now += 30_000;
    await res.reconcile();
    assert.equal(calls.list.length, 1, 'listForBranch sticky once found');
    assert.equal(calls.view.length, 2, 'view re-fetched past TTL');
  });
});

describe('PrResource — error surfaces', () => {
  it('records arm errors in last_error without crashing the pass', async () => {
    const intent = makeIntent();
    const { api } = makePrApi({ armThrows: new Error('rate-limited') });
    const { transition } = makeTransition();
    const { cleanup } = makeCleanup();
    const res = new PrResource({
      intended: intended([intent]),
      pr: api,
      transition,
      cleanup,
      strategy: 'squash',
      conflictRouteTo: 'Todo',
      pollIntervalMs: 0,
    });
    await res.reconcile();
    assert.match(res.snapshot().last_error ?? '', /rate-limited/);
  });

  it('records intended-fetch failures without throwing through', async () => {
    const failingProvider: PrIntendedProvider = {
      prIntended: async () => {
        throw new Error('tracker exploded');
      },
    };
    const { api } = makePrApi({});
    const { transition } = makeTransition();
    const { cleanup } = makeCleanup();
    const res = new PrResource({
      intended: failingProvider,
      pr: api,
      transition,
      cleanup,
      strategy: 'squash',
      conflictRouteTo: 'Todo',
      pollIntervalMs: 0,
    });
    await res.reconcile();
    assert.match(res.snapshot().last_error ?? '', /tracker exploded/);
  });
});
