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
  WorkspaceResource,
  type BaseRefProvider,
  type WorkspaceInspection,
  type WorkspaceIntendedProvider,
  type WorkspaceResourceOptions,
} from '../src/reconciler/workspace.js';
import {
  defaultInspectWorkspace,
  defaultListWorkspaceDirs,
  defaultRemoveWorkspace,
} from '../src/reconciler/workspace-defaults.js';
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

// Build a WorkspaceIntendedProvider whose active/in-flight maps share a
// caller-controlled default state ('Todo'). Tests that need to assert
// per-state hook resolution use `intendedWithStates` instead.
function intended(active: string[], inFlight: string[] = []): WorkspaceIntendedProvider {
  return intendedWithStates(
    new Map(active.map((id) => [id, 'Todo'])),
    new Map(inFlight.map((id) => [id, 'Todo'])),
  );
}

function intendedWithStates(
  active: Map<string, string>,
  inFlight: Map<string, string> = new Map(),
): WorkspaceIntendedProvider {
  return {
    activeIdentifiers: async () => active,
    inFlightIdentifiers: () => inFlight,
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

// Production wiring lives in reconciler/index.ts; tests reach for the same
// adapter defaults so they don't have to re-implement the readdir+stat or git
// listing. Required ports get sensible defaults; callers override `inspect` /
// `remove` / `create` / `baseRef` / `listWorkspaces` as needed.
function makeResource(
  root: string,
  overrides: Partial<WorkspaceResourceOptions> & Pick<WorkspaceResourceOptions, 'intended'>,
): WorkspaceResource {
  return new WorkspaceResource({
    listWorkspaces: () => defaultListWorkspaceDirs(root),
    inspect: defaultInspectWorkspace,
    remove: (id) => defaultRemoveWorkspace(root, id),
    ...overrides,
  });
}

// --- tests -------------------------------------------------------------------

describe('WorkspaceResource — stale removal', () => {
  it('removes a workspace for an issue now in a terminal state (Cancelled)', async () => {
    // Active set excludes "42" (the operator cancelled it). The dir on disk
    // is leftover from a prior run; the reaper drops it.
    const root = await makeWorkspaceRoot('42', '7');
    try {
      const removed: string[] = [];
      const res = makeResource(root, {
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
      const res = makeResource(root, {
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
      const res = makeResource(root, {
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
      const res = makeResource(root, {
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
      const res = makeResource(root, {
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
      const res = makeResource(root, {
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
      const res = makeResource(root, {
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
      const res = makeResource(root, {
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
      const res = makeResource(root, {
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

describe('WorkspaceResource — create_workspace', () => {
  it('calls create for an active identifier with no dir on disk', async () => {
    // Eager-create path: an issue is in the desired set but its workspace dir
    // doesn't exist yet. The reconciler must call the create callback. The
    // stub records the identifier and materializes the dir so the next pass
    // observes idempotency.
    const root = await mkdtemp(path.join(os.tmpdir(), 'symphony-ws-create-'));
    try {
      const created: string[] = [];
      const res = makeResource(root, {
        intended: intended(['new-issue']),
        create: async (id) => {
          created.push(id);
          await mkdir(path.join(root, id), { recursive: true });
        },
      });
      await res.reconcile();
      assert.deepEqual(created, ['new-issue']);
      assert.equal(res.createdOnLastPass(), 1);
      assert.equal(await dirExists(path.join(root, 'new-issue')), true);
      const snap = res.snapshot();
      const action = snap.actions.find((a) => a.action === 'create_workspace:new-issue');
      assert.ok(action, 'ledger records create_workspace');
      assert.equal(action!.state, 'done');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('skips create when the workspace dir already exists', async () => {
    // Idempotent path: the dispatch runner already created the dir; the
    // reconciler should observe it as `present` and not invoke create.
    const root = await makeWorkspaceRoot('existing');
    try {
      const created: string[] = [];
      const res = makeResource(root, {
        intended: intended(['existing']),
        create: async (id) => {
          created.push(id);
        },
      });
      await res.reconcile();
      assert.deepEqual(created, [], 'no create when dir already on disk');
      assert.equal(res.createdOnLastPass(), 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('uses the sanitized key for both ledger correlation and present-set lookup', async () => {
    // Identifier `foo/bar` sanitizes to `foo_bar` on disk. The create
    // callback receives the RAW identifier (WorkspaceManager.ensureFor will
    // re-sanitize; sanitization is idempotent), but the action key in the
    // ledger uses the sanitized form so it correlates with any future
    // remove_workspace entry for the same dir.
    const root = await mkdtemp(path.join(os.tmpdir(), 'symphony-ws-create-sanitize-'));
    try {
      const created: string[] = [];
      const res = makeResource(root, {
        intended: intended(['foo/bar']),
        create: async (id) => {
          created.push(id);
        },
      });
      await res.reconcile();
      assert.deepEqual(created, ['foo/bar'], 'create receives raw identifier');
      const snap = res.snapshot();
      const action = snap.actions.find((a) => a.action === 'create_workspace:foo_bar');
      assert.ok(action, 'action key uses sanitized name');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('eagerly creates a workspace for an in-flight identifier even without a tracker file', async () => {
    // The in-flight set covers the dispatch-claiming window before the
    // tracker reflects the issue. A reconciler tick during that window
    // should also produce a workspace — the runner's own ensureFor will
    // see the dir present (or coalesce with this one via the per-id lock)
    // and proceed without a second clone.
    const root = await mkdtemp(path.join(os.tmpdir(), 'symphony-ws-create-inflight-'));
    try {
      const created: string[] = [];
      const res = makeResource(root, {
        intended: intended([], ['claimed']),
        create: async (id) => {
          created.push(id);
        },
      });
      await res.reconcile();
      assert.deepEqual(created, ['claimed']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('records errors when create fails', async () => {
    // A create failure must land in the action ledger AND in last_error so
    // the dashboard can surface it. The reconciler does NOT throw — other
    // identifiers in the same pass should still get processed.
    const root = await mkdtemp(path.join(os.tmpdir(), 'symphony-ws-create-err-'));
    try {
      const res = makeResource(root, {
        intended: intended(['boom']),
        create: async () => {
          throw new Error('synthetic create failure');
        },
      });
      await res.reconcile();
      const snap = res.snapshot();
      const action = snap.actions.find((a) => a.action === 'create_workspace:boom');
      assert.ok(action);
      assert.equal(action!.state, 'error');
      assert.match(action!.error ?? '', /synthetic create failure/);
      assert.match(snap.last_error ?? '', /synthetic create failure/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not call create when no create callback is wired', async () => {
    // Janitor-only mode: harnesses without an intended create provider still
    // run the reaper; missing-create-callback is a no-op for that side of
    // the diff. Belt-and-suspenders on the resource's optionality.
    const root = await mkdtemp(path.join(os.tmpdir(), 'symphony-ws-no-create-'));
    try {
      const res = makeResource(root, {
        intended: intended(['missing']),
        // no create callback
      });
      await res.reconcile();
      assert.equal(res.createdOnLastPass(), 0);
      assert.equal(await dirExists(path.join(root, 'missing')), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('first run on a missing workspace root still creates dirs for active issues', async () => {
    // Cold-start scenario: workspace.root does not yet exist. The reconciler
    // must NOT bail early on the ENOENT readdir — it should treat actual
    // entries as empty and still drive create_workspace for each active
    // identifier. The create callback handles the root mkdir (production's
    // WorkspaceManager.ensureFor does `mkdir(root, {recursive: true})`).
    const root = path.join(os.tmpdir(), `symphony-ws-cold-${Date.now()}`);
    try {
      const created: string[] = [];
      const res = makeResource(root, {
        intended: intended(['fresh']),
        create: async (id) => {
          created.push(id);
          await mkdir(path.join(root, id), { recursive: true });
        },
      });
      await res.reconcile();
      assert.deepEqual(created, ['fresh']);
      assert.equal(await dirExists(path.join(root, 'fresh')), true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('passes the issue state to the create callback', async () => {
    // The orchestrator's createWorkspace(identifier, state) uses the state for
    // its merge-state guard, so the workspace resource must forward the value
    // the intended provider declares rather than dropping it.
    const root = await mkdtemp(path.join(os.tmpdir(), 'symphony-ws-state-'));
    try {
      const received: Array<{ identifier: string; state: string | null }> = [];
      const res = makeResource(root, {
        intended: intendedWithStates(
          new Map([
            ['active-issue', 'Review'],
            ['inflight-issue', 'Todo'],
          ]),
          // Active set takes precedence over in-flight when both name the
          // same identifier — pin that with a deliberate disagreement.
          new Map([
            ['inflight-issue', 'Todo'],
            ['active-issue', 'STALE-TARGET'],
          ]),
        ),
        create: async (identifier, state) => {
          received.push({ identifier, state });
        },
      });
      await res.reconcile();
      received.sort((a, b) => a.identifier.localeCompare(b.identifier));
      assert.deepEqual(received, [
        { identifier: 'active-issue', state: 'Review' },
        { identifier: 'inflight-issue', state: 'Todo' },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('WorkspaceResource — fail-closed on tracker error', () => {
  it('leaves existing workspaces untouched when activeIdentifiers throws', async () => {
    // Regression test: if the tracker read fails (bad YAML, ENOENT on a state
    // dir, transient FS error), the resource must NOT treat the empty set as
    // the desired state. The original v0 of the orchestrator's provider
    // swallowed the error and returned {} — every dir on disk would then be
    // reaped as stale on the next pass. Surface as last_error and bail.
    const root = await makeWorkspaceRoot('keepme-1', 'keepme-2');
    try {
      const removed: string[] = [];
      const provider: WorkspaceIntendedProvider = {
        activeIdentifiers: async () => {
          throw new Error('tracker scan exploded');
        },
        inFlightIdentifiers: () => new Map(),
      };
      const res = makeResource(root, {
        intended: provider,
        remove: async (id) => {
          removed.push(id);
        },
      });
      await res.reconcile();
      assert.deepEqual(removed, [], 'no workspaces removed when tracker fetch fails');
      assert.equal(await dirExists(path.join(root, 'keepme-1')), true);
      assert.equal(await dirExists(path.join(root, 'keepme-2')), true);
      const snap = res.snapshot();
      assert.match(snap.last_error ?? '', /active_fetch_failed.*tracker scan exploded/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('WorkspaceResource — snapshot shape', () => {
  it('reports id, ready, and a per-action ledger', async () => {
    const root = await makeWorkspaceRoot('stale1', 'stale2');
    try {
      const res = makeResource(root, {
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
      const res = makeResource(root, {
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
    const res = makeResource(root, {
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
      const res = makeResource(wsRoot, {
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
      const res = makeResource(wsRoot, {
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
      const res = makeResource(wsRoot, {
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

  it('reconciler-driven create produces a workspace whose base matches the source repo', async () => {
    // End-to-end: a non-terminal issue identifier flows through the
    // reconciler's create path against a real `setupWorkspaceDir`, and the
    // resulting workspace base SHA agrees with the source repo's base SHA
    // (the very invariant the drift check relies on). Pins finding #2 from
    // the prior review iteration: setup and drift must share a source of
    // truth.
    const source = await makeRealSourceRepo();
    const wsRoot = await mkdtemp(path.join(os.tmpdir(), 'symphony-create-e2e-'));
    try {
      const res = makeResource(wsRoot, {
        intended: intended(['new-issue']),
        baseRef: {
          currentBaseRef: async () => ({
            branch: 'main',
            sha: await runShell('git', ['rev-parse', 'main'], source),
          }),
        },
        create: async (identifier) => {
          const wsPath = path.join(wsRoot, identifier);
          await mkdir(wsPath, { recursive: true });
          await setupWorkspaceDir({
            workspacePath: wsPath,
            sourceRepo: source,
            baseBranch: 'main',
            branch: `agent/${identifier}`,
            originRepo: null,
            gitIdentity: { name: 'symphony-agent', email: 'agent@symphony.local' },
          });
        },
      });
      await res.reconcile();

      const wsPath = path.join(wsRoot, 'new-issue');
      assert.equal(await dirExists(wsPath), true);
      const wsBase = await runShell('git', ['rev-parse', 'main'], wsPath);
      const srcBase = await runShell('git', ['rev-parse', 'main'], source);
      assert.equal(wsBase, srcBase, 'workspace base SHA matches source repo');
      const head = await runShell('git', ['symbolic-ref', '--short', 'HEAD'], wsPath);
      assert.equal(head, 'agent/new-issue', 'agent branch checked out');

      // Second pass with no source-side advance: no drift, no double-create.
      await res.reconcile();
      assert.equal(res.staleOnLastPass(), 0);
      assert.equal(res.stuckOnLastPass(), 0);
      assert.equal(res.createdOnLastPass(), 0, 'idempotent on second pass');
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
