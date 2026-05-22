// Workspace resource tests (issue 34 / reconciler stage 3). Covers the AC
// scenarios from the issue body:
//
//   (a) stale workspace for an issue now in Cancelled → removed.
//   (b) stale workspace for an issue that no longer has a file at all → removed.
//   (c) active workspace whose HEAD matches integration → untouched.
//   (d) active workspace whose HEAD is behind integration AND has no agent
//       work to lose → re-cloned (i.e. removed; dispatch recreates on next
//       tick via the existing `WorkspaceManager.ensureFor` path).
//   (e) active workspace whose HEAD is behind integration BUT carries
//       uncommitted changes or commits ahead of integration → left alone
//       and surfaced as `stuck` so the operator can intervene.
//
// In-flight protection (the dispatch-just-starting race that `inFlightIdentifiers`
// covers) is also pinned: an active identifier missing from the tracker but
// present in the in-flight set must NOT be reaped.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  WorkspaceResource,
  type IntegrationRefProvider,
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

  it('leaves an active workspace alone when integration ref is unavailable', async () => {
    // The drift detector is dormant when no integration provider is wired
    // (current production state — the workflow has no integration block).
    // Even with no inspector, the active dir must survive.
    const root = await makeWorkspaceRoot('alive');
    try {
      const res = new WorkspaceResource({
        workspaceRoot: root,
        intended: intended(['alive']),
        // No integrationRef, no inspect.
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

describe('WorkspaceResource — drift detection', () => {
  function fakeIntegration(sha: string | null): IntegrationRefProvider {
    return { currentIntegrationSha: async () => sha };
  }

  it('leaves an active workspace alone when its HEAD already incorporates the integration tip', async () => {
    const root = await makeWorkspaceRoot('up-to-date');
    try {
      const inspect = async (): Promise<WorkspaceInspection> => ({
        head: 'abc123',
        hasUncommitted: false,
        integrationAncestor: true,
        commitsAheadOfIntegration: 0,
      });
      const removed: string[] = [];
      const res = new WorkspaceResource({
        workspaceRoot: root,
        intended: intended(['up-to-date']),
        integrationRef: fakeIntegration('deadbeef'),
        inspect,
        remove: async (id) => {
          removed.push(id);
        },
      });
      await res.reconcile();
      assert.deepEqual(removed, [], 'up-to-date workspace untouched');
      assert.equal(res.stuckOnLastPass(), 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('re-clones an active workspace when HEAD is behind integration AND nothing would be lost', async () => {
    // Drift but no uncommitted changes and no agent work ahead of integration
    // → safe to drop. Removal is implemented as `rm`; the next dispatch's
    // `ensureFor` rebuilds the dir via the existing after_create hook.
    const root = await makeWorkspaceRoot('drifted');
    try {
      const removed: Array<{ id: string; reason: string }> = [];
      const res = new WorkspaceResource({
        workspaceRoot: root,
        intended: intended(['drifted']),
        integrationRef: fakeIntegration('newer-integration-sha'),
        inspect: async () => ({
          head: 'older-sha',
          hasUncommitted: false,
          integrationAncestor: false,
          commitsAheadOfIntegration: 0,
        }),
        remove: async (id, reason) => {
          removed.push({ id, reason });
          await rm(path.join(root, id), { recursive: true, force: true });
        },
      });
      await res.reconcile();
      assert.deepEqual(removed, [{ id: 'drifted', reason: 'drift_reclone' }]);
      assert.equal(await dirExists(path.join(root, 'drifted')), false);
      const snap = res.snapshot();
      const action = snap.actions.find((a) => a.action === 're_clone_workspace:drifted');
      assert.ok(action, 'ledger records re_clone action');
      assert.equal(action!.state, 'done');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('marks the workspace stuck (not re-cloned) when agent has uncommitted changes', async () => {
    // Safety: re-clone would destroy uncommitted edits. Refuse and surface
    // it via `last_error` so the operator notices on the dashboard. The
    // workspace stays on disk untouched.
    const root = await makeWorkspaceRoot('dirty');
    try {
      const removed: string[] = [];
      const res = new WorkspaceResource({
        workspaceRoot: root,
        intended: intended(['dirty']),
        integrationRef: fakeIntegration('newer-sha'),
        inspect: async () => ({
          head: 'older-sha',
          hasUncommitted: true,
          integrationAncestor: false,
          commitsAheadOfIntegration: 0,
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
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('marks the workspace stuck when agent/<id> has commits ahead of integration', async () => {
    // Safety: re-clone would discard the agent's work. Same surfacing as the
    // uncommitted-changes case.
    const root = await makeWorkspaceRoot('ahead');
    try {
      const removed: string[] = [];
      const res = new WorkspaceResource({
        workspaceRoot: root,
        intended: intended(['ahead']),
        integrationRef: fakeIntegration('newer-sha'),
        inspect: async () => ({
          head: 'agent-head-sha',
          hasUncommitted: false,
          integrationAncestor: false,
          commitsAheadOfIntegration: 3,
        }),
        remove: async (id) => {
          removed.push(id);
        },
      });
      await res.reconcile();
      assert.deepEqual(removed, [], 'no removal when agent has commits ahead');
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
