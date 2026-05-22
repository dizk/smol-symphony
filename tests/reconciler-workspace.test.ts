// Workspace resource tests (issue 34 / reconciler stage 3). Covers the AC
// scenarios from the issue body:
//
//   (a) stale workspace for an issue now in Cancelled → removed.
//   (b) stale workspace for an issue that no longer has a file at all → removed.
//   (c) active workspace whose HEAD matches base → untouched, no marks.
//   (d) active workspace whose HEAD is behind base AND has no agent work to
//       lose → marked `stale` in the snapshot; the workspace stays on disk
//       (re-clone is operator-triggered in v1).
//   (e) active workspace whose HEAD is behind base BUT carries uncommitted
//       changes or commits ahead of base → marked `stuck` in the snapshot;
//       the workspace stays on disk so the operator can rescue work.
//
// In-flight protection (the dispatch-just-starting race that
// `inFlightIdentifiers` covers) is also pinned: an active identifier missing
// from the tracker but present in the in-flight set must NOT be reaped.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  WorkspaceResource,
  type BaseRefProvider,
  type WorkspaceInspection,
  type WorkspaceIntendedProvider,
} from '../src/reconciler/workspace.js';

// --- shared fixtures ---------------------------------------------------------

async function makeWorkspaceRoot(...identifiers: string[]): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'symphony-ws-resource-'));
  for (const id of identifiers) {
    const dir = path.join(root, id);
    await mkdir(dir, { recursive: true });
    // Leave a sentinel file so a successful rm is observable beyond the
    // directory itself (cheap protection against the test passing because
    // the dir was never created in the first place).
    await writeFile(path.join(dir, 'sentinel'), 'present', 'utf8');
  }
  return root;
}

function intended(active: string[], inFlight: string[] = []): WorkspaceIntendedProvider {
  return {
    activeIdentifiers: async () => new Set(active),
    inFlightIdentifiers: () => new Set(inFlight),
  };
}

async function dirExists(p: string): Promise<boolean> {
  try {
    const st = await stat(p);
    return st.isDirectory();
  } catch {
    return false;
  }
}

// --- tests -------------------------------------------------------------------

describe('WorkspaceResource — stale removal', () => {
  it('removes a workspace for an issue now in a terminal state (Cancelled)', async () => {
    // Active set excludes "42" (the operator cancelled it). The dir on disk
    // is leftover from a prior run; the reaper drops it.
    const root = await makeWorkspaceRoot('42', '7');
    try {
      const removed: string[] = [];
      const res = new WorkspaceResource({
        workspaceRoot: root,
        intended: intended(['7']),
        remove: async (id) => {
          removed.push(id);
          await rm(path.join(root, id), { recursive: true, force: true });
        },
      });
      await res.reconcile();
      assert.deepEqual(removed, ['42'], 'only the non-active dir was removed');
      assert.equal(await dirExists(path.join(root, '42')), false);
      assert.equal(await dirExists(path.join(root, '7')), true);
      const snap = res.snapshot();
      const action = snap.actions.find((a) => a.action === 'remove_workspace:42');
      assert.ok(action, 'ledger records remove_workspace');
      assert.equal(action!.state, 'done');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('removes a workspace whose issue file no longer exists at all', async () => {
    // Same shape from the reaper's perspective as the Cancelled case: the
    // identifier simply isn't in the active set. We pin the missing-file
    // scenario separately because in production the tracker drops the file
    // entirely (deleted by an operator), and the AC enumerates it explicitly.
    const root = await makeWorkspaceRoot('ghost');
    try {
      const res = new WorkspaceResource({
        workspaceRoot: root,
        intended: intended([]),
        remove: async (id) => rm(path.join(root, id), { recursive: true, force: true }),
      });
      await res.reconcile();
      assert.equal(await dirExists(path.join(root, 'ghost')), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('leaves an active workspace alone when base ref is unavailable', async () => {
    // Drift detection is skipped when no base provider is wired or it
    // returns null. The active dir must survive regardless.
    const root = await makeWorkspaceRoot('alive');
    try {
      const res = new WorkspaceResource({
        workspaceRoot: root,
        intended: intended(['alive']),
        // No baseRef, no inspect.
      });
      await res.reconcile();
      assert.equal(await dirExists(path.join(root, 'alive')), true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('protects an in-flight identifier even when the tracker has not caught up yet', async () => {
    // Dispatch claims an issue and creates its workspace BEFORE the tracker
    // reads it as active. Without `inFlightIdentifiers`, the next reconcile
    // pass would reap the fresh dir. Mirror of the VM resource's
    // intended-set race-condition guard.
    const root = await makeWorkspaceRoot('99');
    try {
      const removed: string[] = [];
      const res = new WorkspaceResource({
        workspaceRoot: root,
        intended: intended([], ['99']),
        remove: async (id) => {
          removed.push(id);
        },
      });
      await res.reconcile();
      assert.deepEqual(removed, [], 'in-flight identifier protected');
      assert.equal(await dirExists(path.join(root, '99')), true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('WorkspaceResource — drift detection (non-destructive)', () => {
  function fakeBase(sha: string | null): BaseRefProvider {
    return { currentBaseSha: async () => sha };
  }

  it('leaves an active workspace alone when its HEAD already incorporates the base tip', async () => {
    const root = await makeWorkspaceRoot('up-to-date');
    try {
      const inspect = async (): Promise<WorkspaceInspection> => ({
        head: 'abc123',
        hasUncommitted: false,
        baseAncestor: true,
        commitsAheadOfBase: 0,
      });
      const removed: string[] = [];
      const res = new WorkspaceResource({
        workspaceRoot: root,
        intended: intended(['up-to-date']),
        baseRef: fakeBase('deadbeef'),
        inspect,
        remove: async (id) => {
          removed.push(id);
        },
      });
      await res.reconcile();
      assert.deepEqual(removed, [], 'up-to-date workspace untouched');
      assert.equal(res.staleOnLastPass(), 0);
      assert.equal(res.stuckOnLastPass(), 0);
      const snap = res.snapshot();
      assert.equal(snap.last_error, null);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('marks a drifted clean workspace stale WITHOUT removing it (re-clone is opt-in)', async () => {
    // Drift but no uncommitted changes and no agent work ahead of base.
    // v1 surfaces this as a `stale` annotation in the snapshot; the dir
    // stays on disk so an operator (or future opt-in re-clone path) can
    // decide what to do.
    const root = await makeWorkspaceRoot('drifted');
    try {
      const removed: string[] = [];
      const res = new WorkspaceResource({
        workspaceRoot: root,
        intended: intended(['drifted']),
        baseRef: fakeBase('newer-base-sha'),
        inspect: async () => ({
          head: 'older-sha',
          hasUncommitted: false,
          baseAncestor: false,
          commitsAheadOfBase: 0,
        }),
        remove: async (id) => {
          removed.push(id);
        },
      });
      await res.reconcile();
      assert.deepEqual(removed, [], 'no removal on drift in v1');
      assert.equal(await dirExists(path.join(root, 'drifted')), true);
      assert.equal(res.staleOnLastPass(), 1);
      assert.equal(res.stuckOnLastPass(), 0);
      const snap = res.snapshot();
      assert.match(snap.last_error ?? '', /stale|base advanced/);
      const markAction = snap.actions.find((a) => a.action === 'mark_stale:drifted');
      assert.ok(markAction, 'ledger records mark_stale annotation');
      assert.equal(markAction!.state, 'done');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('marks the workspace stuck (not removed) when agent has uncommitted changes', async () => {
    // Safety: a hypothetical re-clone would destroy uncommitted edits.
    // Surface the situation via `last_error` so the operator notices on the
    // dashboard. The workspace stays on disk untouched.
    const root = await makeWorkspaceRoot('dirty');
    try {
      const removed: string[] = [];
      const res = new WorkspaceResource({
        workspaceRoot: root,
        intended: intended(['dirty']),
        baseRef: fakeBase('newer-sha'),
        inspect: async () => ({
          head: 'older-sha',
          hasUncommitted: true,
          baseAncestor: false,
          commitsAheadOfBase: 0,
        }),
        remove: async (id) => {
          removed.push(id);
        },
      });
      await res.reconcile();
      assert.deepEqual(removed, [], 'no removal when uncommitted changes are present');
      assert.equal(await dirExists(path.join(root, 'dirty')), true);
      assert.equal(res.stuckOnLastPass(), 1);
      const snap = res.snapshot();
      assert.match(snap.last_error ?? '', /uncommitted/);
      const markAction = snap.actions.find((a) => a.action === 'mark_stuck:dirty');
      assert.ok(markAction, 'ledger records mark_stuck annotation');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('marks the workspace stuck when agent/<id> has commits ahead of base', async () => {
    // Safety: a hypothetical re-clone would discard the agent's work. Same
    // surfacing as the uncommitted-changes case; same non-destructive policy.
    const root = await makeWorkspaceRoot('ahead');
    try {
      const removed: string[] = [];
      const res = new WorkspaceResource({
        workspaceRoot: root,
        intended: intended(['ahead']),
        baseRef: fakeBase('newer-sha'),
        inspect: async () => ({
          head: 'agent-head-sha',
          hasUncommitted: false,
          baseAncestor: false,
          commitsAheadOfBase: 3,
        }),
        remove: async (id) => {
          removed.push(id);
        },
      });
      await res.reconcile();
      assert.deepEqual(removed, [], 'no removal when agent has commits ahead');
      assert.equal(await dirExists(path.join(root, 'ahead')), true);
      assert.equal(res.stuckOnLastPass(), 1);
      const snap = res.snapshot();
      assert.match(snap.last_error ?? '', /3 commit/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('WorkspaceResource — snapshot shape', () => {
  it('reports id, ready, and a per-action ledger', async () => {
    const root = await makeWorkspaceRoot('stale1', 'stale2');
    try {
      const res = new WorkspaceResource({
        workspaceRoot: root,
        intended: intended([]),
        remove: async (id) => rm(path.join(root, id), { recursive: true, force: true }),
      });
      await res.reconcile();
      const snap = res.snapshot();
      assert.equal(snap.id, 'workspace');
      assert.equal(snap.ready, true, 'workspace janitor does not gate dispatch');
      assert.equal(snap.desired_hash, null);
      const removeActions = snap.actions.filter((a) => a.action.startsWith('remove_workspace:'));
      assert.equal(removeActions.length, 2);
      for (const a of removeActions) assert.equal(a.state, 'done');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('records errors when removal fails', async () => {
    const root = await makeWorkspaceRoot('boom');
    try {
      const res = new WorkspaceResource({
        workspaceRoot: root,
        intended: intended([]),
        remove: async () => {
          throw new Error('synthetic remove failure');
        },
      });
      await res.reconcile();
      const snap = res.snapshot();
      const action = snap.actions.find((a) => a.action === 'remove_workspace:boom');
      assert.ok(action);
      assert.equal(action!.state, 'error');
      assert.match(action!.error ?? '', /synthetic remove failure/);
      assert.match(snap.last_error ?? '', /synthetic remove failure/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns silently when the workspace root does not exist', async () => {
    // First-run scenario: the workspaces dir hasn't been created yet. Don't
    // log a spurious error or surface ENOENT as a failure.
    const root = path.join(os.tmpdir(), `symphony-ws-missing-${Date.now()}`);
    const res = new WorkspaceResource({
      workspaceRoot: root,
      intended: intended([]),
    });
    await res.reconcile();
    const snap = res.snapshot();
    assert.equal(snap.last_error, null);
  });
});
