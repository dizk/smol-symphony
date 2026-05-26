// PR autopilot resource tests (issue 38 / reconciler stage 4). Covers the AC
// scenarios from the issue body:
//
//   (a) clean rebase happy path: PR observed, rebase ok, force-push ok, auto-merge armed.
//   (b) rebase conflict → routes Done back to Todo with structured notes; counter increments.
//   (c) circuit breaker: after `max_rebase_attempts` consecutive failures, routes to the
//       configured holding state.
//   (d) GitHub auto-merge observation: when the PR is MERGED next pass, workspace + remote
//       branch are cleaned up.
//   (e) branch cleanup on PR close (Cancelled path).
//   (f) force-with-lease guard: when the observed head SHA changes between ticks, the
//       reconciler defers instead of clobbering.
//
// All resource-level I/O is behind stubs (PrApi, PrGitApi, PrTransitionApi, PrCleanupApi)
// so the suite is fully in-process — no `gh`, no `git`, no GitHub round-trips. A small
// "production adapter" section at the bottom exercises GitCliPrGitApi against a real
// on-disk git repo to pin the conflict-state-preserved behavior that the resource
// stubs out at the interface boundary.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { closeLogFile, setLogFile } from '../src/logging.js';
import {
  GitCliPrGitApi,
  PrResource,
  type EnsureWorkspaceOutcome,
  type PrApi,
  type PrCleanupApi,
  type PrGitApi,
  type PrIntent,
  type PrIntendedProvider,
  type PrSummary,
  type PrTransitionApi,
  type PrView,
  type PrWorkspaceEnsureApi,
  type PushOutcome,
  type RebaseOutcome,
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
  close: number[];
  deleteBranch: string[];
}

function makePrApi(opts: {
  summary?: PrSummary | null;
  view?: PrView | (() => PrView);
  viewSequence?: PrView[];
  armThrows?: Error;
  closeThrows?: Error;
  deleteThrows?: Error;
}): { api: PrApi; calls: PrApiCalls } {
  const calls: PrApiCalls = {
    list: [],
    view: [],
    arm: [],
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

function makeGit(opts: {
  rebase?: RebaseOutcome | (() => RebaseOutcome);
  rebaseSequence?: RebaseOutcome[];
  push?: PushOutcome | (() => PushOutcome);
}): {
  git: PrGitApi;
  calls: {
    rebase: Array<{ workspacePath: string; branch: string; baseBranch: string; expectedHeadSha: string }>;
    push: Array<{ workspacePath: string; branch: string; expectedHeadSha: string }>;
  };
} {
  const calls = {
    rebase: [] as Array<{ workspacePath: string; branch: string; baseBranch: string; expectedHeadSha: string }>,
    push: [] as Array<{ workspacePath: string; branch: string; expectedHeadSha: string }>,
  };
  let rebaseIdx = 0;
  const git: PrGitApi = {
    async rebaseOnto(args) {
      calls.rebase.push(args);
      if (opts.rebaseSequence) {
        const r = opts.rebaseSequence[rebaseIdx] ?? opts.rebaseSequence[opts.rebaseSequence.length - 1]!;
        rebaseIdx += 1;
        return r;
      }
      if (typeof opts.rebase === 'function') return opts.rebase();
      return opts.rebase ?? { kind: 'ok', new_head_sha: 'rebased-head' };
    },
    async pushForceWithLease(args) {
      calls.push.push(args);
      if (typeof opts.push === 'function') return opts.push();
      return opts.push ?? { kind: 'ok' };
    },
  };
  return { git, calls };
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

function makeWorkspaceEnsure(opts: {
  outcome?: EnsureWorkspaceOutcome | (() => EnsureWorkspaceOutcome);
} = {}): {
  workspaceEnsure: PrWorkspaceEnsureApi;
  calls: Array<{ identifier: string; workspacePath: string; branch: string; baseBranch: string; expectedHeadSha: string }>;
} {
  const calls: Array<{ identifier: string; workspacePath: string; branch: string; baseBranch: string; expectedHeadSha: string }> = [];
  return {
    workspaceEnsure: {
      async ensureWorkspace(args) {
        calls.push(args);
        if (typeof opts.outcome === 'function') return opts.outcome();
        return opts.outcome ?? { kind: 'ok' };
      },
    },
    calls,
  };
}

// ── tests ───────────────────────────────────────────────────────────────────

describe('PrResource — clean rebase happy path', () => {
  it('observes the PR, rebases, force-pushes, and arms auto-merge', async () => {
    const intent = makeIntent();
    const { api, calls: apiCalls } = makePrApi({
      view: makeView(),
    });
    const { git, calls: gitCalls } = makeGit({
      rebase: { kind: 'ok', new_head_sha: 'new-head-after-rebase' },
      push: { kind: 'ok' },
    });
    const { transition, calls: trCalls } = makeTransition();
    const { cleanup, removed } = makeCleanup();

    const res = new PrResource({
      intended: intended([intent]),
      pr: api,
      git,
      transition,
      cleanup,
      strategy: 'squash',
      maxRebaseAttempts: 3,
      conflictRouteTo: 'Todo',
      conflictHoldingState: 'Conflict',
      pollIntervalMs: 0,
    });

    await res.reconcile();

    assert.deepEqual(apiCalls.list, ['agent/42']);
    assert.deepEqual(apiCalls.view, [7]);
    assert.equal(gitCalls.rebase.length, 1);
    assert.deepEqual(gitCalls.rebase[0], {
      workspacePath: '/tmp/ws/42',
      branch: 'agent/42',
      baseBranch: 'main',
      expectedHeadSha: 'head-1',
    });
    assert.equal(gitCalls.push.length, 1);
    assert.deepEqual(apiCalls.arm, [{ pr: 7, strategy: 'squash' }]);
    assert.equal(trCalls.length, 0);
    assert.equal(removed.length, 0);

    const snap = res.snapshot();
    assert.equal(snap.id, 'pr');
    const armed = snap.actions.find((a) => a.action === 'arm_auto_merge:7');
    assert.ok(armed, 'arm_auto_merge in ledger');
    assert.equal(armed!.state, 'done');
    const rebased = snap.actions.find((a) => a.action === 'rebase_and_force_push:42');
    assert.ok(rebased);
    assert.equal(rebased!.state, 'done');
  });

  it('does not re-arm an already-armed PR on a subsequent pass', async () => {
    const intent = makeIntent();
    // First pass: PR is unarmed; second pass: gh reports it armed. The
    // resource should call armAutoMerge exactly once.
    const { api, calls } = makePrApi({
      viewSequence: [
        makeView({ auto_merge_armed: false }),
        makeView({ auto_merge_armed: true, head_ref_oid: 'rebased-head' }),
      ],
    });
    const { git } = makeGit({ rebase: { kind: 'ok', new_head_sha: 'rebased-head' }, push: { kind: 'ok' } });
    const { transition } = makeTransition();
    const { cleanup } = makeCleanup();
    const res = new PrResource({
      intended: intended([intent]),
      pr: api,
      git,
      transition,
      cleanup,
      strategy: 'squash',
      maxRebaseAttempts: 3,
      conflictRouteTo: 'Todo',
      conflictHoldingState: 'Conflict',
      pollIntervalMs: 0,
    });
    await res.reconcile();
    await res.reconcile();
    assert.equal(calls.arm.length, 1, 'arm called exactly once across two passes');
  });

  it('skips when no open PR is found for the branch (local-only mode)', async () => {
    const intent = makeIntent();
    const { api, calls } = makePrApi({ summary: null });
    const { git } = makeGit({});
    const { transition } = makeTransition();
    const { cleanup } = makeCleanup();
    const res = new PrResource({
      intended: intended([intent]),
      pr: api,
      git,
      transition,
      cleanup,
      strategy: 'squash',
      maxRebaseAttempts: 3,
      conflictRouteTo: 'Todo',
      conflictHoldingState: 'Conflict',
      pollIntervalMs: 0,
    });
    await res.reconcile();
    assert.deepEqual(calls.list, ['agent/42']);
    assert.equal(calls.view.length, 0);
    assert.equal(calls.arm.length, 0);
  });
});

describe('PrResource — rebase conflict routing', () => {
  it('routes Done → Todo with structured notes on first conflict', async () => {
    const intent = makeIntent();
    const { api } = makePrApi({});
    const { git } = makeGit({
      rebase: { kind: 'conflict', files: ['src/foo.ts', 'tests/bar.test.ts'], diagnostic: 'CONFLICT (content): Merge conflict in src/foo.ts' },
    });
    const { transition, calls: trCalls } = makeTransition();
    const { cleanup } = makeCleanup();

    const res = new PrResource({
      intended: intended([intent]),
      pr: api,
      git,
      transition,
      cleanup,
      strategy: 'squash',
      maxRebaseAttempts: 3,
      conflictRouteTo: 'Todo',
      conflictHoldingState: 'Conflict',
      pollIntervalMs: 0,
    });
    await res.reconcile();

    assert.equal(trCalls.length, 1);
    const call = trCalls[0]!;
    assert.equal(call.identifier, '42');
    assert.equal(call.fromState, 'Done');
    assert.equal(call.toState, 'Todo');
    assert.match(call.notes, /attempt 1 of 3/);
    assert.match(call.notes, /src\/foo\.ts/);
    assert.match(call.notes, /tests\/bar\.test\.ts/);
    assert.match(call.notes, /Resolve the conflicts/);
    assert.equal(call.actor, 'pr-autopilot');
  });

  it('attempts the host-side rebase even when gh already reports CONFLICTING so markers land on disk for the routed agent', async () => {
    // Issue 55: previously the autopilot short-circuited when gh reported
    // CONFLICTING and routed without ever running git, which left the
    // routed agent looking at a clean workspace with no conflict to chase.
    // Now we always run the rebase when there's a workspace to drive from,
    // so the rebase markers + `.git/rebase-merge` end up on disk and the
    // agent dispatched into the routed-back state can `git rebase --continue`.
    const intent = makeIntent();
    const { api } = makePrApi({ view: makeView({ mergeable: 'CONFLICTING' }) });
    const { git, calls: gitCalls } = makeGit({
      rebase: { kind: 'conflict', files: ['src/foo.ts'], diagnostic: 'CONFLICT (content): Merge conflict in src/foo.ts' },
    });
    const { transition, calls: trCalls } = makeTransition();
    const { cleanup } = makeCleanup();
    const res = new PrResource({
      intended: intended([intent]),
      pr: api,
      git,
      transition,
      cleanup,
      strategy: 'squash',
      maxRebaseAttempts: 3,
      conflictRouteTo: 'Todo',
      conflictHoldingState: 'Conflict',
      pollIntervalMs: 0,
    });
    await res.reconcile();

    assert.equal(gitCalls.rebase.length, 1, 'rebase attempted even when gh reports CONFLICTING');
    assert.equal(trCalls.length, 1);
    assert.equal(trCalls[0]!.toState, 'Todo');
    // Notes should mention the in-progress rebase + concrete file list (the
    // conflict outcome from the rebase, not the null fallback).
    assert.match(trCalls[0]!.notes, /rebase is left IN PROGRESS/);
    assert.match(trCalls[0]!.notes, /src\/foo\.ts/);
  });

  it('falls back to textual-notes-only routing when CONFLICTING and there is no workspace', async () => {
    // No workspace = autopilot was enabled mid-flight and the dir was
    // already reaped. We can't drive a rebase, so route with the textual
    // fallback notes.
    const intent = makeIntent({ workspace_path: null });
    const { api } = makePrApi({ view: makeView({ mergeable: 'CONFLICTING' }) });
    const { git, calls: gitCalls } = makeGit({});
    const { transition, calls: trCalls } = makeTransition();
    const { cleanup } = makeCleanup();
    const res = new PrResource({
      intended: intended([intent]),
      pr: api,
      git,
      transition,
      cleanup,
      strategy: 'squash',
      maxRebaseAttempts: 3,
      conflictRouteTo: 'Todo',
      conflictHoldingState: 'Conflict',
      pollIntervalMs: 0,
    });
    await res.reconcile();

    assert.equal(gitCalls.rebase.length, 0, 'cannot run rebase without a workspace');
    assert.equal(trCalls.length, 1);
    assert.equal(trCalls[0]!.toState, 'Todo');
    assert.match(trCalls[0]!.notes, /CONFLICTING/);
  });

  it('records the routing action in the ledger', async () => {
    const intent = makeIntent();
    const { api } = makePrApi({});
    const { git } = makeGit({
      rebase: { kind: 'conflict', files: ['x.ts'], diagnostic: 'boom' },
    });
    const { transition } = makeTransition();
    const { cleanup } = makeCleanup();
    const res = new PrResource({
      intended: intended([intent]),
      pr: api,
      git,
      transition,
      cleanup,
      strategy: 'squash',
      maxRebaseAttempts: 3,
      conflictRouteTo: 'Todo',
      conflictHoldingState: 'Conflict',
      pollIntervalMs: 0,
    });
    await res.reconcile();
    const snap = res.snapshot();
    const routed = snap.actions.find((a) => a.action === 'route_to_conflict:42:todo');
    assert.ok(routed);
    assert.equal(routed!.state, 'done');
  });
});

describe('PrResource — circuit breaker', () => {
  it('routes to the holding state after max_rebase_attempts consecutive failures across Done → conflict_route_to cycles', async () => {
    // Realistic production flow: each round the issue is in Done, the rebase
    // conflicts, the resource routes Done → Todo. Meanwhile an agent resolves
    // and pushes a new head SHA, the issue cycles back to Done, and another
    // reconcile pass runs. Between passes the identifier is briefly OUT of
    // the intended set (it's in Todo/Review). The rebaseAttempts counter must
    // accumulate across these cycles so the breaker fires on the 3rd attempt
    // when max=3 (per the issue contract: counter >= N → route to conflict).

    // We model the round trip with a mutable intended-set provider: when the
    // resource calls prIntended() we feed it the current state. Between
    // reconcile passes we flip the intent in/out and bump the head SHA so the
    // resource sees a "fresh" PR each return.
    let currentIntents: PrIntent[] = [];
    const provider: PrIntendedProvider = { prIntended: async () => currentIntents };
    let currentHead = 'head-1';
    const { api, calls: apiCalls } = makePrApi({
      view: () => makeView({ head_ref_oid: currentHead }),
    });
    const { git, calls: gitCalls } = makeGit({
      rebase: { kind: 'conflict', files: ['x.ts'], diagnostic: 'boom' },
    });
    const { transition, calls: trCalls } = makeTransition();
    const { cleanup } = makeCleanup();
    const res = new PrResource({
      intended: provider,
      pr: api,
      git,
      transition,
      cleanup,
      strategy: 'squash',
      maxRebaseAttempts: 3,
      conflictRouteTo: 'Todo',
      conflictHoldingState: 'Conflict',
      pollIntervalMs: 0,
    });

    // Round 1: Done → conflict → route to Todo. attempts becomes 1.
    currentIntents = [makeIntent()];
    await res.reconcile();
    assert.equal(trCalls.length, 1);
    assert.equal(trCalls[0]!.toState, 'Todo');
    assert.match(trCalls[0]!.notes, /attempt 1 of 3/);
    assert.equal(res.rebaseAttemptsFor('42'), 1);

    // Agent picks it up, resolves, transitions back to Review then Done. The
    // identifier is OUT of the intended set in between. Reconciler ticks
    // during that gap should not drop the counter.
    currentIntents = [];
    await res.reconcile();
    assert.equal(res.rebaseAttemptsFor('42'), 1, 'counter survives intended-set absence');

    // Round 2: Done again with a new head SHA. New conflict. attempts -> 2.
    currentHead = 'head-2';
    currentIntents = [makeIntent()];
    await res.reconcile();
    assert.equal(trCalls.length, 2);
    assert.equal(trCalls[1]!.toState, 'Todo');
    assert.match(trCalls[1]!.notes, /attempt 2 of 3/);
    assert.equal(res.rebaseAttemptsFor('42'), 2);

    // Gap again.
    currentIntents = [];
    await res.reconcile();
    assert.equal(res.rebaseAttemptsFor('42'), 2);

    // Round 3: attempts -> 3 (== max). Breaker fires — route to Conflict.
    currentHead = 'head-3';
    currentIntents = [makeIntent()];
    await res.reconcile();
    assert.equal(trCalls.length, 3);
    assert.equal(trCalls[2]!.toState, 'Conflict');
    assert.match(trCalls[2]!.notes, /circuit broken/i);

    // After the breaker fires the counter is dropped (operator intervention
    // is treated as a hard reset), so if the issue ever returns to Done it
    // starts fresh.
    assert.equal(res.rebaseAttemptsFor('42'), 0);

    // Sanity: every round actually called rebase + transition.
    assert.equal(gitCalls.rebase.length, 3);
    assert.equal(apiCalls.list.length, 3);
    assert.equal(apiCalls.view.length, 3);
  });

  it('preserves the counter when the identifier leaves the intended set with a non-zero count', async () => {
    // Direct unit test of resetTransient semantics: a single conflict route
    // leaves rebaseAttempts=1; the next pass with an empty intended set
    // must NOT zero it out.
    let currentIntents: PrIntent[] = [makeIntent()];
    const provider: PrIntendedProvider = { prIntended: async () => currentIntents };
    const { api } = makePrApi({});
    const { git } = makeGit({
      rebase: { kind: 'conflict', files: ['x.ts'], diagnostic: 'boom' },
    });
    const { transition } = makeTransition();
    const { cleanup } = makeCleanup();
    const res = new PrResource({
      intended: provider,
      pr: api,
      git,
      transition,
      cleanup,
      strategy: 'squash',
      maxRebaseAttempts: 3,
      conflictRouteTo: 'Todo',
      conflictHoldingState: 'Conflict',
      pollIntervalMs: 0,
    });
    await res.reconcile();
    assert.equal(res.rebaseAttemptsFor('42'), 1);
    currentIntents = [];
    await res.reconcile();
    assert.equal(res.rebaseAttemptsFor('42'), 1, 'counter must survive intended-set absence');
    await res.reconcile();
    assert.equal(res.rebaseAttemptsFor('42'), 1, 'counter must survive many empty passes');
  });

  it('resets the counter on a successful rebase between conflicts (consecutive-failure semantics)', async () => {
    // attempts -> 1 on first conflict; a subsequent successful rebase clears
    // it back to 0 so a future conflict starts the count fresh.
    let currentIntents: PrIntent[] = [makeIntent()];
    const provider: PrIntendedProvider = { prIntended: async () => currentIntents };
    let nextRebase: RebaseOutcome = {
      kind: 'conflict',
      files: ['x.ts'],
      diagnostic: 'boom',
    };
    const { api } = makePrApi({});
    const { git } = makeGit({ rebase: () => nextRebase, push: { kind: 'ok' } });
    const { transition } = makeTransition();
    const { cleanup } = makeCleanup();
    const res = new PrResource({
      intended: provider,
      pr: api,
      git,
      transition,
      cleanup,
      strategy: 'squash',
      maxRebaseAttempts: 3,
      conflictRouteTo: 'Todo',
      conflictHoldingState: 'Conflict',
      pollIntervalMs: 0,
    });

    await res.reconcile();
    assert.equal(res.rebaseAttemptsFor('42'), 1);

    // Round trip — agent fixed, issue back in Done, head SHA bumped.
    currentIntents = [];
    await res.reconcile();
    currentIntents = [makeIntent()];
    nextRebase = { kind: 'ok', new_head_sha: 'rebased-head' };
    await res.reconcile();
    assert.equal(res.rebaseAttemptsFor('42'), 0, 'successful rebase resets the counter');
  });

  it('surfaces a hard error and clamps the counter when no holding state is declared and the breaker trips', async () => {
    // With max=2 and no holding state declared: round 1 routes to Todo,
    // round 2 trips the breaker but has nowhere to route — it must surface
    // last_error and clamp the counter at `max` so subsequent passes don't
    // grow it unbounded.
    let currentIntents: PrIntent[] = [];
    const provider: PrIntendedProvider = { prIntended: async () => currentIntents };
    let currentHead = 'head-1';
    const { api } = makePrApi({
      view: () => makeView({ head_ref_oid: currentHead }),
    });
    const { git } = makeGit({
      rebase: { kind: 'conflict', files: [], diagnostic: 'boom' },
    });
    const { transition, calls: trCalls } = makeTransition();
    const { cleanup } = makeCleanup();
    const res = new PrResource({
      intended: provider,
      pr: api,
      git,
      transition,
      cleanup,
      strategy: 'squash',
      maxRebaseAttempts: 2,
      conflictRouteTo: 'Todo',
      conflictHoldingState: null,
      pollIntervalMs: 0,
    });
    // Round 1: attempts -> 1 (< max), routes to Todo.
    currentIntents = [makeIntent()];
    await res.reconcile();
    assert.equal(trCalls.length, 1);
    assert.equal(trCalls[0]!.toState, 'Todo');
    assert.equal(res.rebaseAttemptsFor('42'), 1);
    // Round 2: attempts -> 2 (== max), breaker would fire but no holding
    // state — surfaces last_error and clamps at max.
    currentIntents = [];
    await res.reconcile();
    currentHead = 'head-2';
    currentIntents = [makeIntent()];
    await res.reconcile();
    assert.equal(trCalls.length, 1, 'no transition fired without a holding state');
    assert.match(res.snapshot().last_error ?? '', /circuit broken/);
    assert.equal(res.rebaseAttemptsFor('42'), 2);
    // Round 3: attempts increments to 3, still clamps back to max=2 — no
    // unbounded growth.
    currentIntents = [];
    await res.reconcile();
    currentHead = 'head-3';
    currentIntents = [makeIntent()];
    await res.reconcile();
    assert.equal(trCalls.length, 1, 'still no transition');
    assert.equal(res.rebaseAttemptsFor('42'), 2, 'counter clamped at max');
  });

  it('also breaks the circuit on gh-CONFLICTING-only cycles (no host rebase needed)', async () => {
    // The existing breaker test drives the rebase-conflict path. Production
    // log evidence for issue 54 was a PR whose mergeable=CONFLICTING was set
    // by GitHub directly, so the resource never reached runRebase — every
    // conflict observation came through the `view.mergeable === 'CONFLICTING'`
    // branch of processMerge. Both branches must funnel through handleConflict's
    // single increment; this test pins that the breaker still trips on the Nth
    // route when the rebase path is never exercised.
    let currentIntents: PrIntent[] = [];
    const provider: PrIntendedProvider = { prIntended: async () => currentIntents };
    let currentHead = 'head-1';
    const { api, calls: apiCalls } = makePrApi({
      view: () => makeView({ head_ref_oid: currentHead, mergeable: 'CONFLICTING' }),
    });
    const { git, calls: gitCalls } = makeGit({});
    const { transition, calls: trCalls } = makeTransition();
    const { cleanup } = makeCleanup();
    const res = new PrResource({
      intended: provider,
      pr: api,
      git,
      transition,
      cleanup,
      strategy: 'squash',
      maxRebaseAttempts: 3,
      conflictRouteTo: 'Todo',
      conflictHoldingState: 'Conflict',
      pollIntervalMs: 0,
    });

    for (let round = 1; round <= 3; round += 1) {
      currentHead = `head-${round}`;
      // No workspace → the resource can't host-rebase, so every conflict must
      // come through processMerge's `view.mergeable === 'CONFLICTING'` branch.
      currentIntents = [makeIntent({ workspace_path: null })];
      await res.reconcile();
      currentIntents = [];
      await res.reconcile();
    }

    assert.equal(gitCalls.rebase.length, 0, 'gh-CONFLICTING path must never invoke host rebase');
    assert.equal(apiCalls.view.length, 3, 'one PR view per round');
    assert.equal(trCalls.length, 3, 'exactly N routes total: max-1 to Todo + 1 to Conflict');
    assert.equal(trCalls[0]!.toState, 'Todo');
    assert.equal(trCalls[1]!.toState, 'Todo');
    assert.equal(trCalls[2]!.toState, 'Conflict', 'Nth route parks in holding state, not N+1th');
    assert.match(trCalls[2]!.notes, /circuit broken/i);
  });

  it('emits a pr reconcile: conflict attempt log line on every route with attempt + max', async () => {
    // Acceptance criterion from issue 54: each conflict route must surface the
    // attempt-counter through structured logs so the operator can see the
    // breaker's progress without reconstructing the timeline by hand. Captures
    // through the persistent file sink — the same path production logs hit.
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'pr-attempt-log-'));
    const logPath = path.join(tmpDir, 'pr.log');
    setLogFile(logPath);
    try {
      let currentIntents: PrIntent[] = [];
      const provider: PrIntendedProvider = { prIntended: async () => currentIntents };
      let currentHead = 'head-1';
      const { api } = makePrApi({
        view: () => makeView({ head_ref_oid: currentHead }),
      });
      const { git } = makeGit({
        rebase: { kind: 'conflict', files: ['x.ts'], diagnostic: 'boom' },
      });
      const { transition } = makeTransition();
      const { cleanup } = makeCleanup();
      const res = new PrResource({
        intended: provider,
        pr: api,
        git,
        transition,
        cleanup,
        strategy: 'squash',
        maxRebaseAttempts: 3,
        conflictRouteTo: 'Todo',
        conflictHoldingState: 'Conflict',
        pollIntervalMs: 0,
      });

      for (let round = 1; round <= 3; round += 1) {
        currentHead = `head-${round}`;
        currentIntents = [makeIntent()];
        await res.reconcile();
        currentIntents = [];
        await res.reconcile();
      }

      await closeLogFile();
      const text = readFileSync(logPath, 'utf8');
      const attemptLines = text
        .split('\n')
        .filter((l) => l.includes('msg="pr reconcile: conflict attempt"'));
      assert.equal(attemptLines.length, 3, 'one attempt log line per conflict route');
      assert.match(attemptLines[0]!, /attempt=1 /);
      assert.match(attemptLines[0]!, /max=3/);
      assert.match(attemptLines[0]!, /identifier=42 /);
      assert.match(attemptLines[1]!, /attempt=2 /);
      assert.match(attemptLines[2]!, /attempt=3 /);
    } finally {
      await closeLogFile();
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('PrResource — auto-merge observation + cleanup', () => {
  it('cleans up workspace + remote branch when the PR is MERGED', async () => {
    const intent = makeIntent();
    const { api, calls: apiCalls } = makePrApi({
      view: makeView({ state: 'MERGED' }),
    });
    const { git, calls: gitCalls } = makeGit({});
    const { transition } = makeTransition();
    const { cleanup, removed } = makeCleanup();

    const res = new PrResource({
      intended: intended([intent]),
      pr: api,
      git,
      transition,
      cleanup,
      strategy: 'squash',
      maxRebaseAttempts: 3,
      conflictRouteTo: 'Todo',
      conflictHoldingState: 'Conflict',
      pollIntervalMs: 0,
    });
    await res.reconcile();

    assert.equal(gitCalls.rebase.length, 0, 'no rebase needed on merged PR');
    assert.deepEqual(apiCalls.deleteBranch, ['agent/42']);
    assert.deepEqual(removed, ['42']);

    // Second pass with the same intent should be a no-op (completed latched).
    await res.reconcile();
    assert.deepEqual(removed, ['42'], 'cleanup only fires once');
  });

  it('cleans up workspace AND remote branch on a PR that was CLOSED out from under the autopilot', async () => {
    // Issue contract: PR closed OR merged + agent/<id> branch present -> cleanup_branches.
    // An operator who closes a Done-state PR by hand will leave agent/<id> on
    // origin forever unless the autopilot reaps it here.
    const intent = makeIntent();
    const { api, calls } = makePrApi({ view: makeView({ state: 'CLOSED' }) });
    const { git } = makeGit({});
    const { transition } = makeTransition();
    const { cleanup, removed } = makeCleanup();
    const res = new PrResource({
      intended: intended([intent]),
      pr: api,
      git,
      transition,
      cleanup,
      strategy: 'squash',
      maxRebaseAttempts: 3,
      conflictRouteTo: 'Todo',
      conflictHoldingState: 'Conflict',
      pollIntervalMs: 0,
    });
    await res.reconcile();
    assert.deepEqual(removed, ['42']);
    assert.deepEqual(calls.deleteBranch, ['agent/42'], 'remote agent branch must be deleted on operator-closed PR');

    // Subsequent pass with the same intent must not re-delete or re-clean.
    await res.reconcile();
    assert.equal(calls.deleteBranch.length, 1, 'branch delete only fires once');
    assert.equal(removed.length, 1, 'workspace cleanup only fires once');
  });
});

describe('PrResource — terminal state observation across TTL', () => {
  it('observes MERGED after the PR ages out of OPEN and completes cleanup', async () => {
    // Pass 1 observes the PR as OPEN: rebase + arm fire normally. Then time
    // advances past the poll TTL and GitHub auto-merge has actually merged
    // the PR. Pass 2 must NOT re-list the branch — once the number is known
    // it is sticky, so the resource cannot regress to the pre-fix behavior
    // of forgetting a previously-discovered PR after it leaves OPEN. Pass 2
    // re-views and drives cleanup off the observed MERGED state.
    let now = 1_000;
    const intent = makeIntent();
    let currentView: PrView = makeView();
    const { api, calls: apiCalls } = makePrApi({
      view: () => currentView,
    });
    const { git } = makeGit({
      rebase: { kind: 'ok', new_head_sha: 'rebased' },
      push: { kind: 'ok' },
    });
    const { transition } = makeTransition();
    const { cleanup, removed } = makeCleanup();
    const res = new PrResource({
      intended: intended([intent]),
      pr: api,
      git,
      transition,
      cleanup,
      strategy: 'squash',
      maxRebaseAttempts: 3,
      conflictRouteTo: 'Todo',
      conflictHoldingState: 'Conflict',
      pollIntervalMs: 30_000,
      now: () => now,
    });

    await res.reconcile();
    assert.equal(apiCalls.list.length, 1, 'listForBranch fires on first lookup');
    assert.equal(apiCalls.view.length, 1);
    assert.equal(apiCalls.arm.length, 1, 'first pass arms auto-merge');

    // PR has merged on GitHub. Advance the clock past the TTL so the view
    // cache is invalidated; the listForBranch cache must remain sticky.
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

  it('observes CLOSED on a Done-state PR after TTL expires and completes cleanup', async () => {
    // Same as above but the PR was closed (operator hand-closed without
    // merging) instead of merged. Branch + workspace cleanup still fire.
    let now = 1_000;
    const intent = makeIntent();
    let currentView: PrView = makeView();
    const { api, calls: apiCalls } = makePrApi({
      view: () => currentView,
    });
    const { git } = makeGit({
      rebase: { kind: 'ok', new_head_sha: 'rebased' },
      push: { kind: 'ok' },
    });
    const { transition } = makeTransition();
    const { cleanup, removed } = makeCleanup();
    const res = new PrResource({
      intended: intended([intent]),
      pr: api,
      git,
      transition,
      cleanup,
      strategy: 'squash',
      maxRebaseAttempts: 3,
      conflictRouteTo: 'Todo',
      conflictHoldingState: 'Conflict',
      pollIntervalMs: 30_000,
      now: () => now,
    });
    await res.reconcile();
    assert.equal(apiCalls.list.length, 1);

    now += 60_000;
    currentView = makeView({ state: 'CLOSED' });
    await res.reconcile();
    assert.equal(apiCalls.list.length, 1, 'listForBranch sticky');
    assert.deepEqual(removed, ['42']);
    assert.deepEqual(apiCalls.deleteBranch, ['agent/42']);
  });

  it('re-polls listForBranch past TTL only when no PR has ever been found', async () => {
    // No PR exists yet for this branch (local-only mode). listForBranch
    // returns null. Within the TTL we must NOT re-poll. Past the TTL we
    // re-poll — the PR may have been opened in the meantime.
    let now = 1_000;
    const intent = makeIntent();
    const { api, calls } = makePrApi({ summary: null });
    const { git } = makeGit({});
    const { transition } = makeTransition();
    const { cleanup } = makeCleanup();
    const res = new PrResource({
      intended: intended([intent]),
      pr: api,
      git,
      transition,
      cleanup,
      strategy: 'squash',
      maxRebaseAttempts: 3,
      conflictRouteTo: 'Todo',
      conflictHoldingState: 'Conflict',
      pollIntervalMs: 30_000,
      now: () => now,
    });
    await res.reconcile();
    assert.equal(calls.list.length, 1);

    // Within TTL: cached null, no re-poll.
    now += 5_000;
    await res.reconcile();
    assert.equal(calls.list.length, 1, 'null-result cache holds within TTL');

    // Past TTL: re-poll for a maybe-newly-opened PR.
    now += 30_000;
    await res.reconcile();
    assert.equal(calls.list.length, 2, 'null-result re-polled past TTL');
  });
});

describe('PrResource — cancelled close path', () => {
  it('closes the PR and deletes the remote branch when intent.kind=close', async () => {
    const intent = makeIntent({ kind: 'close', state: 'Cancelled', workspace_path: null });
    const { api, calls } = makePrApi({});
    const { git, calls: gitCalls } = makeGit({});
    const { transition } = makeTransition();
    const { cleanup, removed } = makeCleanup();
    const res = new PrResource({
      intended: intended([intent]),
      pr: api,
      git,
      transition,
      cleanup,
      strategy: 'squash',
      maxRebaseAttempts: 3,
      conflictRouteTo: 'Todo',
      conflictHoldingState: 'Conflict',
      pollIntervalMs: 0,
    });
    await res.reconcile();

    assert.deepEqual(calls.close, [7]);
    assert.deepEqual(calls.deleteBranch, ['agent/42']);
    assert.equal(gitCalls.rebase.length, 0, 'close path never rebases');
    assert.equal(removed.length, 0, 'close path does not remove workspace (normal terminal cleanup handles it)');
  });

  it('latches completed so a subsequent pass does not re-close', async () => {
    const intent = makeIntent({ kind: 'close', state: 'Cancelled', workspace_path: null });
    const { api, calls } = makePrApi({});
    const { git } = makeGit({});
    const { transition } = makeTransition();
    const { cleanup } = makeCleanup();
    const res = new PrResource({
      intended: intended([intent]),
      pr: api,
      git,
      transition,
      cleanup,
      strategy: 'squash',
      maxRebaseAttempts: 3,
      conflictRouteTo: 'Todo',
      conflictHoldingState: 'Conflict',
      pollIntervalMs: 0,
    });
    await res.reconcile();
    await res.reconcile();
    assert.equal(calls.close.length, 1);
    assert.equal(calls.deleteBranch.length, 1);
  });

  it('still deletes the remote branch when the PR is already CLOSED before the autopilot observes it', async () => {
    // The operator (or an external automation) closed the PR before this
    // reconciler tick. The contract still wants the agent/<id> branch reaped.
    const intent = makeIntent({ kind: 'close', state: 'Cancelled', workspace_path: null });
    const { api, calls } = makePrApi({ view: makeView({ state: 'CLOSED' }) });
    const { git } = makeGit({});
    const { transition } = makeTransition();
    const { cleanup, removed } = makeCleanup();
    const res = new PrResource({
      intended: intended([intent]),
      pr: api,
      git,
      transition,
      cleanup,
      strategy: 'squash',
      maxRebaseAttempts: 3,
      conflictRouteTo: 'Todo',
      conflictHoldingState: 'Conflict',
      pollIntervalMs: 0,
    });
    await res.reconcile();
    assert.equal(calls.close.length, 0, 'no close call when already closed');
    assert.deepEqual(calls.deleteBranch, ['agent/42'], 'remote branch must still be deleted');
    assert.equal(removed.length, 0, 'cancelled close path leaves workspace to normal terminal cleanup');

    // Latch holds across the next pass.
    await res.reconcile();
    assert.equal(calls.deleteBranch.length, 1, 'branch delete fires exactly once');
  });

  it('still deletes the remote branch when the PR is already MERGED before the autopilot observes the cancel', async () => {
    // Edge case: the PR merged just before the issue was cancelled. The
    // branch may still be on origin (e.g. operator armed without
    // --delete-branch). Best-effort delete.
    const intent = makeIntent({ kind: 'close', state: 'Cancelled', workspace_path: null });
    const { api, calls } = makePrApi({ view: makeView({ state: 'MERGED' }) });
    const { git } = makeGit({});
    const { transition } = makeTransition();
    const { cleanup } = makeCleanup();
    const res = new PrResource({
      intended: intended([intent]),
      pr: api,
      git,
      transition,
      cleanup,
      strategy: 'squash',
      maxRebaseAttempts: 3,
      conflictRouteTo: 'Todo',
      conflictHoldingState: 'Conflict',
      pollIntervalMs: 0,
    });
    await res.reconcile();
    assert.equal(calls.close.length, 0);
    assert.deepEqual(calls.deleteBranch, ['agent/42']);
  });
});

describe('PrResource — force-with-lease concurrent-push guard', () => {
  it('defers when the observed head SHA has changed since the last view', async () => {
    const intent = makeIntent();
    const { api, calls: apiCalls } = makePrApi({
      viewSequence: [
        makeView({ head_ref_oid: 'head-1' }),
        // Next pass: someone else pushed; gh reports a new head SHA.
        makeView({ head_ref_oid: 'head-2', auto_merge_armed: true }),
      ],
    });
    const { git, calls: gitCalls } = makeGit({ rebase: { kind: 'ok', new_head_sha: 'head-1-rebased' }, push: { kind: 'ok' } });
    const { transition } = makeTransition();
    const { cleanup } = makeCleanup();

    const res = new PrResource({
      intended: intended([intent]),
      pr: api,
      git,
      transition,
      cleanup,
      strategy: 'squash',
      maxRebaseAttempts: 3,
      conflictRouteTo: 'Todo',
      conflictHoldingState: 'Conflict',
      pollIntervalMs: 0,
    });
    await res.reconcile();
    // First pass rebases & arms.
    assert.equal(gitCalls.rebase.length, 1);
    assert.equal(apiCalls.arm.length, 1);

    await res.reconcile();
    // Second pass: head SHA mismatch from cached observation → defer.
    assert.equal(gitCalls.rebase.length, 1, 'no additional rebase after concurrent push');
    assert.equal(apiCalls.arm.length, 1, 'no additional arm after concurrent push');
  });

  it('treats a concurrent_push from the git api as a defer (no error in last_error)', async () => {
    const intent = makeIntent();
    const { api } = makePrApi({});
    const { git } = makeGit({ rebase: { kind: 'concurrent_push', observed_head_sha: 'sha-other' } });
    const { transition } = makeTransition();
    const { cleanup } = makeCleanup();
    const res = new PrResource({
      intended: intended([intent]),
      pr: api,
      git,
      transition,
      cleanup,
      strategy: 'squash',
      maxRebaseAttempts: 3,
      conflictRouteTo: 'Todo',
      conflictHoldingState: 'Conflict',
      pollIntervalMs: 0,
    });
    await res.reconcile();
    const snap = res.snapshot();
    assert.equal(snap.last_error, null, 'concurrent_push is a soft defer, not an error');
  });
});

describe('PrResource — poll interval cache', () => {
  it('reuses the cached PR view within poll_interval_ms', async () => {
    let now = 1_000;
    const intent = makeIntent();
    const { api, calls } = makePrApi({ view: makeView() });
    const { git } = makeGit({ rebase: { kind: 'ok', new_head_sha: 'rebased' } });
    const { transition } = makeTransition();
    const { cleanup } = makeCleanup();
    const res = new PrResource({
      intended: intended([intent]),
      pr: api,
      git,
      transition,
      cleanup,
      strategy: 'squash',
      maxRebaseAttempts: 3,
      conflictRouteTo: 'Todo',
      conflictHoldingState: 'Conflict',
      pollIntervalMs: 30_000,
      now: () => now,
    });

    await res.reconcile();
    assert.equal(calls.view.length, 1);
    assert.equal(calls.list.length, 1);

    // Without an intervening rebase that invalidates the cache, the second
    // pass within the TTL should reuse the cached entries. We bypass the
    // rebase cache-invalidation by making the second view's intent identical
    // — but the rebase still ran on the first pass, which calls
    // st.prView = null. So we need a no-rebase first pass: use mergeable=UNKNOWN?
    // Actually rebase only runs when mergeable != CONFLICTING and workspace
    // is set. To get a no-rebase first pass, use a closed PR ... but that
    // also latches completed. Simpler: re-bind a no-workspace intent.

    // Reset and exercise cache only.
    const intentNoWs = makeIntent({ workspace_path: null });
    const apiNoWs = makePrApi({ view: makeView({ auto_merge_armed: true }) });
    const res2 = new PrResource({
      intended: intended([intentNoWs]),
      pr: apiNoWs.api,
      git,
      transition,
      cleanup,
      strategy: 'squash',
      maxRebaseAttempts: 3,
      conflictRouteTo: 'Todo',
      conflictHoldingState: 'Conflict',
      pollIntervalMs: 30_000,
      now: () => now,
    });

    await res2.reconcile();
    now += 5_000; // within ttl
    await res2.reconcile();
    assert.equal(apiNoWs.calls.list.length, 1, 'list call cached within TTL');
    assert.equal(apiNoWs.calls.view.length, 1, 'view call cached within TTL');

    now += 30_000; // past ttl
    await res2.reconcile();
    // listForBranch is sticky once a PR has been found — see the post-TTL
    // terminal-state tests above. Only `view` is re-fetched past the TTL.
    assert.equal(apiNoWs.calls.list.length, 1, 'listForBranch sticky once found');
    assert.equal(apiNoWs.calls.view.length, 2, 'view re-fetched past TTL');
  });
});

describe('PrResource — error surfaces', () => {
  it('records arm errors in last_error without crashing the pass', async () => {
    const intent = makeIntent();
    const { api } = makePrApi({ armThrows: new Error('rate-limited') });
    const { git } = makeGit({ rebase: { kind: 'ok', new_head_sha: 'rebased' } });
    const { transition } = makeTransition();
    const { cleanup } = makeCleanup();
    const res = new PrResource({
      intended: intended([intent]),
      pr: api,
      git,
      transition,
      cleanup,
      strategy: 'squash',
      maxRebaseAttempts: 3,
      conflictRouteTo: 'Todo',
      conflictHoldingState: 'Conflict',
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
    const { git } = makeGit({});
    const { transition } = makeTransition();
    const { cleanup } = makeCleanup();
    const res = new PrResource({
      intended: failingProvider,
      pr: api,
      git,
      transition,
      cleanup,
      strategy: 'squash',
      maxRebaseAttempts: 3,
      conflictRouteTo: 'Todo',
      conflictHoldingState: 'Conflict',
      pollIntervalMs: 0,
    });
    await res.reconcile();
    assert.match(res.snapshot().last_error ?? '', /tracker exploded/);
  });
});

describe('PrResource — workspace ensure before rebase (issue 53)', () => {
  it('calls workspaceEnsure.ensureWorkspace before rebasing when wired', async () => {
    const intent = makeIntent();
    const { api } = makePrApi({});
    const { git, calls: gitCalls } = makeGit({});
    const { transition } = makeTransition();
    const { cleanup } = makeCleanup();
    const { workspaceEnsure, calls: ensureCalls } = makeWorkspaceEnsure();

    const res = new PrResource({
      intended: intended([intent]),
      pr: api,
      git,
      transition,
      cleanup,
      workspaceEnsure,
      strategy: 'squash',
      maxRebaseAttempts: 3,
      conflictRouteTo: 'Todo',
      conflictHoldingState: 'Conflict',
      pollIntervalMs: 0,
    });
    await res.reconcile();

    assert.equal(ensureCalls.length, 1, 'ensureWorkspace called once before the rebase');
    assert.deepEqual(ensureCalls[0], {
      identifier: '42',
      workspacePath: '/tmp/ws/42',
      branch: 'agent/42',
      baseBranch: 'main',
      expectedHeadSha: 'head-1',
    });
    assert.equal(gitCalls.rebase.length, 1, 'rebase still runs after ensureWorkspace ok');
  });

  it('surfaces ensureWorkspace errors as a rebase action error and skips rebase', async () => {
    const intent = makeIntent();
    const { api } = makePrApi({});
    const { git, calls: gitCalls } = makeGit({});
    const { transition } = makeTransition();
    const { cleanup } = makeCleanup();
    const { workspaceEnsure } = makeWorkspaceEnsure({
      outcome: { kind: 'error', diagnostic: 'clone failed: ENOENT' },
    });

    const res = new PrResource({
      intended: intended([intent]),
      pr: api,
      git,
      transition,
      cleanup,
      workspaceEnsure,
      strategy: 'squash',
      maxRebaseAttempts: 3,
      conflictRouteTo: 'Todo',
      conflictHoldingState: 'Conflict',
      pollIntervalMs: 0,
    });
    await res.reconcile();

    assert.equal(gitCalls.rebase.length, 0, 'rebase skipped on ensureWorkspace error');
    const snap = res.snapshot();
    const rebaseAction = snap.actions.find((a) => a.action === 'rebase_and_force_push:42');
    assert.ok(rebaseAction, 'rebase action recorded in ledger');
    assert.equal(rebaseAction!.state, 'error');
    assert.match(rebaseAction!.error ?? '', /clone failed: ENOENT/);
  });

  it('skips ensure when workspaceEnsure is not wired (back-compat)', async () => {
    // Test harnesses that stub git.rebaseOnto entirely may omit workspaceEnsure;
    // the resource must not throw or short-circuit in that case — it just runs
    // the rebase as before.
    const intent = makeIntent();
    const { api } = makePrApi({});
    const { git, calls: gitCalls } = makeGit({});
    const { transition } = makeTransition();
    const { cleanup } = makeCleanup();

    const res = new PrResource({
      intended: intended([intent]),
      pr: api,
      git,
      transition,
      cleanup,
      strategy: 'squash',
      maxRebaseAttempts: 3,
      conflictRouteTo: 'Todo',
      conflictHoldingState: 'Conflict',
      pollIntervalMs: 0,
    });
    await res.reconcile();

    assert.equal(gitCalls.rebase.length, 1, 'rebase still runs without workspaceEnsure wired');
  });
});

describe('PrResource — rebase error observability (issue 53)', () => {
  // Capture stderr to assert log.warn lines fire on every rebase/push error path.
  // The logging module writes to process.stderr.write directly.
  async function withStderrCapture<T>(fn: () => Promise<T>): Promise<{ result: T; stderr: string }> {
    const origWrite = process.stderr.write.bind(process.stderr);
    let captured = '';
    // @ts-expect-error monkey-patch for capture
    process.stderr.write = (chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
      captured += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      // Don't forward to the real stderr — keeps the test output clean.
      void rest;
      return true;
    };
    try {
      const result = await fn();
      return { result, stderr: captured };
    } finally {
      process.stderr.write = origWrite;
    }
  }

  it('warn-logs when rebaseOnto throws', async () => {
    const intent = makeIntent();
    const { api } = makePrApi({});
    const git: PrGitApi = {
      async rebaseOnto() {
        throw new Error('ENOENT: no such workspace');
      },
      async pushForceWithLease() {
        return { kind: 'ok' };
      },
    };
    const { transition } = makeTransition();
    const { cleanup } = makeCleanup();

    const { stderr } = await withStderrCapture(async () => {
      const res = new PrResource({
        intended: intended([intent]),
        pr: api,
        git,
        transition,
        cleanup,
        strategy: 'squash',
        maxRebaseAttempts: 3,
        conflictRouteTo: 'Todo',
        conflictHoldingState: 'Conflict',
        pollIntervalMs: 0,
      });
      await res.reconcile();
    });
    assert.match(stderr, /pr reconcile: rebase failed/);
    assert.match(stderr, /rebase_threw/);
    assert.match(stderr, /ENOENT: no such workspace/);
  });

  it('warn-logs when pushForceWithLease throws', async () => {
    const intent = makeIntent();
    const { api } = makePrApi({});
    const git: PrGitApi = {
      async rebaseOnto() {
        return { kind: 'ok', new_head_sha: 'rebased' };
      },
      async pushForceWithLease() {
        throw new Error('push transport exploded');
      },
    };
    const { transition } = makeTransition();
    const { cleanup } = makeCleanup();

    const { stderr } = await withStderrCapture(async () => {
      const res = new PrResource({
        intended: intended([intent]),
        pr: api,
        git,
        transition,
        cleanup,
        strategy: 'squash',
        maxRebaseAttempts: 3,
        conflictRouteTo: 'Todo',
        conflictHoldingState: 'Conflict',
        pollIntervalMs: 0,
      });
      await res.reconcile();
    });
    assert.match(stderr, /pr reconcile: rebase failed/);
    assert.match(stderr, /push_threw/);
    assert.match(stderr, /push transport exploded/);
  });

  it('warn-logs on push kind=error', async () => {
    const intent = makeIntent();
    const { api } = makePrApi({});
    const { git } = makeGit({
      rebase: { kind: 'ok', new_head_sha: 'rebased' },
      push: { kind: 'error', diagnostic: 'permission denied' },
    });
    const { transition } = makeTransition();
    const { cleanup } = makeCleanup();

    const { stderr } = await withStderrCapture(async () => {
      const res = new PrResource({
        intended: intended([intent]),
        pr: api,
        git,
        transition,
        cleanup,
        strategy: 'squash',
        maxRebaseAttempts: 3,
        conflictRouteTo: 'Todo',
        conflictHoldingState: 'Conflict',
        pollIntervalMs: 0,
      });
      await res.reconcile();
    });
    assert.match(stderr, /pr reconcile: rebase failed/);
    assert.match(stderr, /push_error/);
    assert.match(stderr, /permission denied/);
  });

  it('warn-logs on ensureWorkspace error before the rebase even runs', async () => {
    const intent = makeIntent();
    const { api } = makePrApi({});
    const { git } = makeGit({});
    const { transition } = makeTransition();
    const { cleanup } = makeCleanup();
    const { workspaceEnsure } = makeWorkspaceEnsure({
      outcome: { kind: 'error', diagnostic: 'recreate_failed: disk full' },
    });

    const { stderr } = await withStderrCapture(async () => {
      const res = new PrResource({
        intended: intended([intent]),
        pr: api,
        git,
        transition,
        cleanup,
        workspaceEnsure,
        strategy: 'squash',
        maxRebaseAttempts: 3,
        conflictRouteTo: 'Todo',
        conflictHoldingState: 'Conflict',
        pollIntervalMs: 0,
      });
      await res.reconcile();
    });
    assert.match(stderr, /pr reconcile: rebase failed/);
    assert.match(stderr, /ensure_workspace/);
    assert.match(stderr, /disk full/);
  });
});

// ── production adapter: GitCliPrGitApi against a real on-disk git repo ─────
//
// The PrResource tests above stub PrGitApi at the interface boundary. These
// tests exercise the actual `git` shell-outs in GitCliPrGitApi against a real
// repository to pin two production-only invariants:
//
//   1. On a rebase conflict, the working tree must be left WITH conflict
//      markers AND a `.git/rebase-merge` (or `rebase-apply`) directory on
//      disk — the rebase is left IN PROGRESS so the routed agent can
//      `git add` + `git rebase --continue`. (Issue 38 review finding #1.)
//   2. The concurrent-push guard fires when local HEAD diverges from the
//      expectedHeadSha the resource passes down.

async function runStep(cwd: string, cmd: string, args: string[]): Promise<{ exit: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (b) => (stdout += b.toString('utf8')));
    child.stderr?.on('data', (b) => (stderr += b.toString('utf8')));
    child.on('error', (err) => resolve({ exit: -1, stdout, stderr: stderr + String(err) }));
    child.on('close', (code) => resolve({ exit: code ?? -1, stdout, stderr }));
  });
}

async function gitOk(cwd: string, args: string[]): Promise<string> {
  const r = await runStep(cwd, 'git', args);
  if (r.exit !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${r.stderr.trim()}`);
  }
  return r.stdout.trim();
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

describe('GitCliPrGitApi — real git', () => {
  it('leaves the rebase IN PROGRESS with conflict markers on disk when the rebase conflicts', async () => {
    const baseRemote = await mkdtemp(path.join(os.tmpdir(), 'pr-git-remote-'));
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'pr-git-ws-'));
    try {
      // Bare remote so the workspace clone has an `origin` to fetch from.
      await gitOk(baseRemote, ['init', '--bare', '-b', 'main']);

      // Seed the remote with a single commit on main.
      const seed = await mkdtemp(path.join(os.tmpdir(), 'pr-git-seed-'));
      try {
        await gitOk(seed, ['init', '-b', 'main']);
        await gitOk(seed, ['config', 'user.name', 'test']);
        await gitOk(seed, ['config', 'user.email', 'test@example.com']);
        await runStep(seed, 'sh', ['-c', 'echo "line one\nline two\nline three" > file.txt']);
        await gitOk(seed, ['add', 'file.txt']);
        await gitOk(seed, ['commit', '-m', 'seed']);
        await gitOk(seed, ['remote', 'add', 'origin', baseRemote]);
        await gitOk(seed, ['push', 'origin', 'main']);
      } finally {
        await rm(seed, { recursive: true, force: true });
      }

      // Clone the workspace from the bare remote, then create a feature
      // branch that touches the same line as a subsequent main commit.
      await gitOk(workspace, ['clone', baseRemote, '.']);
      await gitOk(workspace, ['config', 'user.name', 'test']);
      await gitOk(workspace, ['config', 'user.email', 'test@example.com']);
      await gitOk(workspace, ['checkout', '-b', 'agent/42']);
      await runStep(workspace, 'sh', ['-c', 'echo "line one\nFEATURE\nline three" > file.txt']);
      await gitOk(workspace, ['commit', '-am', 'feature change']);
      const featureHead = await gitOk(workspace, ['rev-parse', 'HEAD']);

      // Advance main on the remote with a conflicting change to the same line.
      const main = await mkdtemp(path.join(os.tmpdir(), 'pr-git-main-'));
      try {
        await gitOk(main, ['clone', baseRemote, '.']);
        await gitOk(main, ['config', 'user.name', 'test']);
        await gitOk(main, ['config', 'user.email', 'test@example.com']);
        await runStep(main, 'sh', ['-c', 'echo "line one\nMAIN\nline three" > file.txt']);
        await gitOk(main, ['commit', '-am', 'main change']);
        await gitOk(main, ['push', 'origin', 'main']);
      } finally {
        await rm(main, { recursive: true, force: true });
      }

      const git = new GitCliPrGitApi({ timeoutMs: 30_000 });
      const outcome = await git.rebaseOnto({
        workspacePath: workspace,
        branch: 'agent/42',
        baseBranch: 'main',
        expectedHeadSha: featureHead,
      });

      assert.equal(outcome.kind, 'conflict', `expected conflict, got ${JSON.stringify(outcome)}`);
      if (outcome.kind !== 'conflict') return;
      assert.ok(outcome.files.includes('file.txt'), `expected file.txt in conflicted files: ${outcome.files.join(',')}`);

      // The rebase must be left IN PROGRESS for the routed agent to resolve.
      // git keeps state in either .git/rebase-merge (interactive / m) or
      // .git/rebase-apply (am-style). Either is acceptable.
      const rebaseMerge = path.join(workspace, '.git', 'rebase-merge');
      const rebaseApply = path.join(workspace, '.git', 'rebase-apply');
      const hasRebaseDir = (await pathExists(rebaseMerge)) || (await pathExists(rebaseApply));
      assert.ok(hasRebaseDir, 'rebase-in-progress directory must remain after a conflicted rebase');

      // The conflicted file must still contain conflict markers.
      const fileBody = await readFile(path.join(workspace, 'file.txt'), 'utf8');
      assert.match(fileBody, /<<<<<<< /);
      assert.match(fileBody, /=======/);
      assert.match(fileBody, />>>>>>> /);

      // And `git status` (human form) reports the rebase in progress.
      const status = await runStep(workspace, 'git', ['status']);
      assert.match(status.stdout, /rebase in progress/i, `git status should mention rebase, got: ${status.stdout}`);
    } finally {
      await rm(baseRemote, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('returns concurrent_push when local HEAD diverges and is NOT rebased on origin/<base>', async () => {
    // Setup: feature branch's HEAD is on an orphan commit that has no
    // ancestor relationship to origin/main, so the "is ancestor" check
    // fails and we treat the divergence as an unexpected local mutation.
    const baseRemote = await mkdtemp(path.join(os.tmpdir(), 'pr-git-remote-'));
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'pr-git-ws-'));
    try {
      await gitOk(baseRemote, ['init', '--bare', '-b', 'main']);
      const seed = await mkdtemp(path.join(os.tmpdir(), 'pr-git-seed-'));
      try {
        await gitOk(seed, ['init', '-b', 'main']);
        await gitOk(seed, ['config', 'user.name', 'test']);
        await gitOk(seed, ['config', 'user.email', 'test@example.com']);
        await runStep(seed, 'sh', ['-c', 'echo seed > file.txt']);
        await gitOk(seed, ['add', 'file.txt']);
        await gitOk(seed, ['commit', '-m', 'seed']);
        await gitOk(seed, ['remote', 'add', 'origin', baseRemote]);
        await gitOk(seed, ['push', 'origin', 'main']);
      } finally {
        await rm(seed, { recursive: true, force: true });
      }
      await gitOk(workspace, ['clone', baseRemote, '.']);
      await gitOk(workspace, ['config', 'user.name', 'test']);
      await gitOk(workspace, ['config', 'user.email', 'test@example.com']);
      // Create an orphan branch (no ancestor of main) and land HEAD there.
      await gitOk(workspace, ['checkout', '--orphan', 'agent/42']);
      await runStep(workspace, 'sh', ['-c', 'echo unrelated > unrelated.txt']);
      await gitOk(workspace, ['add', 'unrelated.txt']);
      await gitOk(workspace, ['commit', '-m', 'unrelated orphan']);
      const realHead = await gitOk(workspace, ['rev-parse', 'HEAD']);

      const git = new GitCliPrGitApi({ timeoutMs: 30_000 });
      const outcome = await git.rebaseOnto({
        workspacePath: workspace,
        branch: 'agent/42',
        baseBranch: 'main',
        expectedHeadSha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      });

      assert.equal(outcome.kind, 'concurrent_push');
      if (outcome.kind === 'concurrent_push') {
        assert.equal(outcome.observed_head_sha, realHead);
      }
    } finally {
      await rm(baseRemote, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('returns ok with the local HEAD when the branch is already rebased on origin/<base> (issue 55)', async () => {
    // Models the conflict-resolve-and-push flow: the autopilot routed a
    // CONFLICTING PR back to Todo with the rebase in progress; the agent
    // resolved the conflicts in-tree and `git rebase --continue`-d the
    // sequence; the local branch is now on top of origin/main but the
    // remote still has the pre-rebase SHA. The autopilot's next pass must
    // detect this as "ready to push" rather than the historical
    // concurrent_push bail.
    const baseRemote = await mkdtemp(path.join(os.tmpdir(), 'pr-git-remote-'));
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'pr-git-ws-'));
    try {
      await gitOk(baseRemote, ['init', '--bare', '-b', 'main']);
      const seed = await mkdtemp(path.join(os.tmpdir(), 'pr-git-seed-'));
      try {
        await gitOk(seed, ['init', '-b', 'main']);
        await gitOk(seed, ['config', 'user.name', 'test']);
        await gitOk(seed, ['config', 'user.email', 'test@example.com']);
        await runStep(seed, 'sh', ['-c', 'echo seed > file.txt']);
        await gitOk(seed, ['add', 'file.txt']);
        await gitOk(seed, ['commit', '-m', 'seed']);
        await gitOk(seed, ['remote', 'add', 'origin', baseRemote]);
        await gitOk(seed, ['push', 'origin', 'main']);
      } finally {
        await rm(seed, { recursive: true, force: true });
      }

      // Advance main on the remote with a new commit (the "base advance" the
      // agent had to rebase past).
      const mainAdvance = await mkdtemp(path.join(os.tmpdir(), 'pr-git-main-'));
      try {
        await gitOk(mainAdvance, ['clone', baseRemote, '.']);
        await gitOk(mainAdvance, ['config', 'user.name', 'test']);
        await gitOk(mainAdvance, ['config', 'user.email', 'test@example.com']);
        await runStep(mainAdvance, 'sh', ['-c', 'echo "main advance" > advance.txt']);
        await gitOk(mainAdvance, ['add', 'advance.txt']);
        await gitOk(mainAdvance, ['commit', '-m', 'advance']);
        await gitOk(mainAdvance, ['push', 'origin', 'main']);
      } finally {
        await rm(mainAdvance, { recursive: true, force: true });
      }

      await gitOk(workspace, ['clone', baseRemote, '.']);
      await gitOk(workspace, ['config', 'user.name', 'test']);
      await gitOk(workspace, ['config', 'user.email', 'test@example.com']);
      // Cut agent/42 from the latest main (simulating the agent having
      // already rebased onto the new main tip in-workspace).
      await gitOk(workspace, ['checkout', '-b', 'agent/42']);
      await runStep(workspace, 'sh', ['-c', 'echo feature > file.txt']);
      await gitOk(workspace, ['commit', '-am', 'feature on top of advanced main']);
      const localHead = await gitOk(workspace, ['rev-parse', 'HEAD']);

      const git = new GitCliPrGitApi({ timeoutMs: 30_000 });
      const outcome = await git.rebaseOnto({
        workspacePath: workspace,
        branch: 'agent/42',
        baseBranch: 'main',
        // The autopilot's lastObserved SHA on the remote — a pre-rebase
        // dummy that doesn't match the now-rebased localHead.
        expectedHeadSha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      });

      assert.equal(
        outcome.kind,
        'ok',
        `expected ok (already-rebased-locally fast path), got ${JSON.stringify(outcome)}`,
      );
      if (outcome.kind === 'ok') {
        assert.equal(outcome.new_head_sha, localHead);
      }
    } finally {
      await rm(baseRemote, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('returns concurrent_push when a rebase is already in progress on disk (issue 55)', async () => {
    // The conflict-routed agent's workspace inherits .git/rebase-merge from
    // the autopilot's failed rebase. The autopilot must NOT touch the
    // workspace while the agent is mid-resolution: finishing or aborting
    // the rebase here would clobber exactly the state the agent is
    // resolving. Detected by the rebase-in-progress check.
    const baseRemote = await mkdtemp(path.join(os.tmpdir(), 'pr-git-remote-'));
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'pr-git-ws-'));
    try {
      await gitOk(baseRemote, ['init', '--bare', '-b', 'main']);
      const seed = await mkdtemp(path.join(os.tmpdir(), 'pr-git-seed-'));
      try {
        await gitOk(seed, ['init', '-b', 'main']);
        await gitOk(seed, ['config', 'user.name', 'test']);
        await gitOk(seed, ['config', 'user.email', 'test@example.com']);
        await runStep(seed, 'sh', ['-c', 'echo "line one\nline two\nline three" > file.txt']);
        await gitOk(seed, ['add', 'file.txt']);
        await gitOk(seed, ['commit', '-m', 'seed']);
        await gitOk(seed, ['remote', 'add', 'origin', baseRemote]);
        await gitOk(seed, ['push', 'origin', 'main']);
      } finally {
        await rm(seed, { recursive: true, force: true });
      }
      await gitOk(workspace, ['clone', baseRemote, '.']);
      await gitOk(workspace, ['config', 'user.name', 'test']);
      await gitOk(workspace, ['config', 'user.email', 'test@example.com']);
      await gitOk(workspace, ['checkout', '-b', 'agent/42']);
      await runStep(workspace, 'sh', ['-c', 'echo "line one\nFEATURE\nline three" > file.txt']);
      await gitOk(workspace, ['commit', '-am', 'feature']);
      const featureHead = await gitOk(workspace, ['rev-parse', 'HEAD']);

      // Advance main with a conflicting change so the first rebase attempt
      // wedges into rebase-in-progress.
      const main = await mkdtemp(path.join(os.tmpdir(), 'pr-git-main-'));
      try {
        await gitOk(main, ['clone', baseRemote, '.']);
        await gitOk(main, ['config', 'user.name', 'test']);
        await gitOk(main, ['config', 'user.email', 'test@example.com']);
        await runStep(main, 'sh', ['-c', 'echo "line one\nMAIN\nline three" > file.txt']);
        await gitOk(main, ['commit', '-am', 'main change']);
        await gitOk(main, ['push', 'origin', 'main']);
      } finally {
        await rm(main, { recursive: true, force: true });
      }

      const git = new GitCliPrGitApi({ timeoutMs: 30_000 });
      // First call lands the rebase in conflict / in-progress.
      const first = await git.rebaseOnto({
        workspacePath: workspace,
        branch: 'agent/42',
        baseBranch: 'main',
        expectedHeadSha: featureHead,
      });
      assert.equal(first.kind, 'conflict');

      // Second call must observe the in-progress rebase and bail without
      // running git rebase or git fetch again.
      const second = await git.rebaseOnto({
        workspacePath: workspace,
        branch: 'agent/42',
        baseBranch: 'main',
        expectedHeadSha: featureHead,
      });
      assert.equal(
        second.kind,
        'concurrent_push',
        `expected concurrent_push (rebase in progress guard), got ${JSON.stringify(second)}`,
      );
    } finally {
      await rm(baseRemote, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
