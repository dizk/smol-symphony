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
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import {
  defaultInspectWorkspace,
  WorkspaceResource,
  type BaseRefProvider,
  type WorkspaceInspection,
  type WorkspaceIntendedProvider,
} from '../src/reconciler/workspace.js';
import { setupWorkspaceDir } from '../src/workspace.js';

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
  function fakeBase(sha: string | null, branch = 'main'): BaseRefProvider {
    return {
      currentBaseRef: async () => (sha === null ? null : { branch, sha }),
    };
  }

  it('leaves an active workspace alone when its frozen base matches the source tip', async () => {
    // The workspace's local copy of <branch> still points at the same SHA the
    // source repo's <branch> points at — nothing has moved since clone.
    const root = await makeWorkspaceRoot('up-to-date');
    try {
      const inspect = async (): Promise<WorkspaceInspection> => ({
        head: 'agent-head',
        workspaceBaseSha: 'deadbeef',
        hasUncommitted: false,
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
    // Workspace's frozen base disagrees with source's current base, but no
    // uncommitted changes and no agent work ahead of base. v1 surfaces this
    // as a `stale` annotation in the snapshot; the dir stays on disk so an
    // operator (or future opt-in re-clone path) can decide what to do.
    const root = await makeWorkspaceRoot('drifted');
    try {
      const removed: string[] = [];
      const res = new WorkspaceResource({
        workspaceRoot: root,
        intended: intended(['drifted']),
        baseRef: fakeBase('newer-base-sha'),
        inspect: async () => ({
          head: 'agent-head',
          workspaceBaseSha: 'older-base-sha',
          hasUncommitted: false,
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
        baseRef: fakeBase('newer-base-sha'),
        inspect: async () => ({
          head: 'agent-head',
          workspaceBaseSha: 'older-base-sha',
          hasUncommitted: true,
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
        baseRef: fakeBase('newer-base-sha'),
        inspect: async () => ({
          head: 'agent-head-sha',
          workspaceBaseSha: 'older-base-sha',
          hasUncommitted: false,
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

  it('skips drift detection when the workspace has no local base ref (operator deleted it)', async () => {
    // workspaceBaseSha === null means we can't reason about drift; don't
    // mark stale/stuck and don't remove. The workspace stays on disk.
    const root = await makeWorkspaceRoot('no-base');
    try {
      const removed: string[] = [];
      const res = new WorkspaceResource({
        workspaceRoot: root,
        intended: intended(['no-base']),
        baseRef: fakeBase('newer-base-sha'),
        inspect: async () => ({
          head: 'agent-head',
          workspaceBaseSha: null,
          hasUncommitted: false,
          commitsAheadOfBase: 0,
        }),
        remove: async (id) => {
          removed.push(id);
        },
      });
      await res.reconcile();
      assert.deepEqual(removed, []);
      assert.equal(res.staleOnLastPass(), 0);
      assert.equal(res.stuckOnLastPass(), 0);
      assert.equal(await dirExists(path.join(root, 'no-base')), true);
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

// --- end-to-end drift over a real git clone --------------------------------

// Exercises the failure mode the v0 implementation missed: a workspace
// created by `git clone --local` has no objects for commits added to the
// source repo after clone time, so any cross-repo `merge-base --is-ancestor`
// run inside the workspace exits 128 (unknown SHA) and the resource (in v0)
// silently treated that as "no drift." The fix is to compare the workspace's
// own copy of <branch> against the source repo's current <branch>, which
// both sides can resolve in their own object store. This test pins that path
// against real git — no inspector stub — so a regression resurfaces.

async function runShell(cmd: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (b) => {
      stdout += b.toString('utf8');
    });
    child.stderr?.on('data', (b) => {
      stderr += b.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`${cmd} ${args.join(' ')} (cwd=${cwd}) exited ${code}: ${stderr}`));
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

async function makeRealSourceRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'symphony-drift-source-'));
  await runShell('git', ['init', '-b', 'main'], dir);
  await runShell('git', ['config', 'user.name', 'test'], dir);
  await runShell('git', ['config', 'user.email', 'test@example.com'], dir);
  await writeFile(path.join(dir, 'README.md'), '# initial\n', 'utf8');
  await runShell('git', ['add', '.'], dir);
  await runShell('git', ['commit', '-m', 'initial'], dir);
  return dir;
}

describe('WorkspaceResource — real git drift detection', () => {
  it('marks a workspace stale (NOT removed) after the source repo advances its base branch', async () => {
    // 1. Build a real source repo on `main`.
    const source = await makeRealSourceRepo();
    const wsRoot = await mkdtemp(path.join(os.tmpdir(), 'symphony-drift-ws-'));
    const wsPath = path.join(wsRoot, '42');
    await mkdir(wsPath, { recursive: true });
    try {
      // 2. Use the canonical setup path the reconciler relies on. After this
      //    the workspace's main = source's main = SHA `A`, agent/42 is HEAD.
      await setupWorkspaceDir({
        workspacePath: wsPath,
        sourceRepo: source,
        baseBranch: 'main',
        branch: 'agent/42',
        originRepo: null,
        gitIdentity: { name: 'symphony-agent', email: 'agent@symphony.local' },
      });
      const wsBaseBefore = await runShell('git', ['rev-parse', 'main'], wsPath);
      const srcBaseBefore = await runShell('git', ['rev-parse', 'main'], source);
      assert.equal(wsBaseBefore, srcBaseBefore, 'sanity: pre-advance bases agree');

      // 3. Advance source's main with a new commit. The workspace cannot see
      //    this commit's object — `--local` only hardlinks what existed at
      //    clone time.
      await writeFile(path.join(source, 'CHANGE.md'), 'newer\n', 'utf8');
      await runShell('git', ['add', '.'], source);
      await runShell('git', ['commit', '-m', 'advance base'], source);
      const srcBaseAfter = await runShell('git', ['rev-parse', 'main'], source);
      assert.notEqual(srcBaseAfter, wsBaseBefore, 'source base actually moved');

      // 4. Run the reconciler with the REAL default inspector against the
      //    real workspace and a baseRef pointing at the source. v0 missed
      //    drift here because the workspace `merge-base --is-ancestor <new>
      //    HEAD` returned 128 (unknown SHA), which the code mapped to "no
      //    drift." The fix compares SHAs directly across the boundary.
      const baseRef: BaseRefProvider = {
        currentBaseRef: async () => ({ branch: 'main', sha: srcBaseAfter }),
      };
      const removed: string[] = [];
      const res = new WorkspaceResource({
        workspaceRoot: wsRoot,
        intended: intended(['42']),
        baseRef,
        // NO inspect override — exercises defaultInspectWorkspace.
        remove: async (id) => {
          removed.push(id);
        },
      });
      await res.reconcile();

      assert.deepEqual(removed, [], 'non-destructive: workspace must not be removed on drift');
      assert.equal(await dirExists(wsPath), true, 'workspace dir survives the pass');
      assert.equal(res.staleOnLastPass(), 1, 'drift surfaces as stale');
      assert.equal(res.stuckOnLastPass(), 0, 'no agent work to lose → stale, not stuck');
      const snap = res.snapshot();
      const mark = snap.actions.find((a) => a.action === 'mark_stale:42');
      assert.ok(mark, 'ledger records mark_stale annotation');
      assert.match(snap.last_error ?? '', /stale|base advanced/);
    } finally {
      await rm(source, { recursive: true, force: true });
      await rm(wsRoot, { recursive: true, force: true });
    }
  });

  it('leaves a freshly-cloned workspace untouched when source base has not advanced', async () => {
    // Companion to the drift test: same setup, no source-side advance, real
    // inspector. Asserts the up-to-date path doesn't accidentally fire
    // stale/stuck because of object-store boundary noise.
    const source = await makeRealSourceRepo();
    const wsRoot = await mkdtemp(path.join(os.tmpdir(), 'symphony-fresh-ws-'));
    const wsPath = path.join(wsRoot, '7');
    await mkdir(wsPath, { recursive: true });
    try {
      await setupWorkspaceDir({
        workspacePath: wsPath,
        sourceRepo: source,
        baseBranch: 'main',
        branch: 'agent/7',
        originRepo: null,
        gitIdentity: { name: 'symphony-agent', email: 'agent@symphony.local' },
      });
      const srcBase = await runShell('git', ['rev-parse', 'main'], source);
      const baseRef: BaseRefProvider = {
        currentBaseRef: async () => ({ branch: 'main', sha: srcBase }),
      };
      const res = new WorkspaceResource({
        workspaceRoot: wsRoot,
        intended: intended(['7']),
        baseRef,
      });
      await res.reconcile();
      assert.equal(res.staleOnLastPass(), 0);
      assert.equal(res.stuckOnLastPass(), 0);
      assert.equal(await dirExists(wsPath), true);
      assert.equal(res.snapshot().last_error, null);
    } finally {
      await rm(source, { recursive: true, force: true });
      await rm(wsRoot, { recursive: true, force: true });
    }
  });

  it('marks a drifted workspace stuck (NOT removed) when agent/<id> has a commit ahead of base', async () => {
    // Drift + agent work present: the safety policy is to surface as stuck
    // and keep the dir on disk so the operator can rescue the agent's
    // commit. Real-git path exercises commitsAheadOfBase from
    // defaultInspectWorkspace (`<base>..HEAD` reachability inside the
    // workspace's own object store).
    const source = await makeRealSourceRepo();
    const wsRoot = await mkdtemp(path.join(os.tmpdir(), 'symphony-stuck-ws-'));
    const wsPath = path.join(wsRoot, '9');
    await mkdir(wsPath, { recursive: true });
    try {
      await setupWorkspaceDir({
        workspacePath: wsPath,
        sourceRepo: source,
        baseBranch: 'main',
        branch: 'agent/9',
        originRepo: null,
        gitIdentity: { name: 'symphony-agent', email: 'agent@symphony.local' },
      });
      // Agent makes a commit on agent/9.
      await writeFile(path.join(wsPath, 'agent-work.md'), 'progress\n', 'utf8');
      await runShell('git', ['add', '.'], wsPath);
      await runShell('git', ['commit', '-m', 'agent commit'], wsPath);
      // Source base advances independently.
      await writeFile(path.join(source, 'CHANGE.md'), 'newer\n', 'utf8');
      await runShell('git', ['add', '.'], source);
      await runShell('git', ['commit', '-m', 'advance base'], source);
      const srcBaseAfter = await runShell('git', ['rev-parse', 'main'], source);

      const baseRef: BaseRefProvider = {
        currentBaseRef: async () => ({ branch: 'main', sha: srcBaseAfter }),
      };
      const removed: string[] = [];
      const res = new WorkspaceResource({
        workspaceRoot: wsRoot,
        intended: intended(['9']),
        baseRef,
        remove: async (id) => {
          removed.push(id);
        },
      });
      await res.reconcile();

      assert.deepEqual(removed, [], 'no removal when agent has commits ahead of base');
      assert.equal(await dirExists(wsPath), true, 'workspace dir preserved');
      assert.equal(res.stuckOnLastPass(), 1);
      assert.equal(res.staleOnLastPass(), 0);
      const snap = res.snapshot();
      assert.match(snap.last_error ?? '', /\d+ commit/);
    } finally {
      await rm(source, { recursive: true, force: true });
      await rm(wsRoot, { recursive: true, force: true });
    }
  });

  it('defaultInspectWorkspace returns the workspace base SHA (not the source base SHA)', async () => {
    // The drift comparison only works if the inspector reports the
    // workspace's frozen view, not whatever the source has now. Direct unit
    // assertion on defaultInspectWorkspace pins the contract.
    const source = await makeRealSourceRepo();
    const wsRoot = await mkdtemp(path.join(os.tmpdir(), 'symphony-inspect-'));
    const wsPath = path.join(wsRoot, 'x');
    await mkdir(wsPath, { recursive: true });
    try {
      await setupWorkspaceDir({
        workspacePath: wsPath,
        sourceRepo: source,
        baseBranch: 'main',
        branch: 'agent/x',
        originRepo: null,
        gitIdentity: { name: 'symphony-agent', email: 'agent@symphony.local' },
      });
      const wsBase = await runShell('git', ['rev-parse', 'main'], wsPath);
      // Advance source so source base != workspace base. The inspector must
      // still return the workspace's own SHA.
      await writeFile(path.join(source, 'OTHER.md'), 'newer\n', 'utf8');
      await runShell('git', ['add', '.'], source);
      await runShell('git', ['commit', '-m', 'advance'], source);
      const srcBaseNew = await runShell('git', ['rev-parse', 'main'], source);
      assert.notEqual(wsBase, srcBaseNew);

      const insp = await defaultInspectWorkspace(wsPath, 'main');
      assert.equal(insp.workspaceBaseSha, wsBase, 'inspector reports workspace base, not source');
      assert.equal(insp.hasUncommitted, false);
      assert.equal(insp.commitsAheadOfBase, 0, 'agent has not made any commits yet');
      assert.ok(insp.head, 'agent HEAD resolves');
    } finally {
      await rm(source, { recursive: true, force: true });
      await rm(wsRoot, { recursive: true, force: true });
    }
  });
});
