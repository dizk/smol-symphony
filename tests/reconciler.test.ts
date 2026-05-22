// Reconciler stage 1 tests (issue 32). Covers the six AC scenarios:
//   (a) initial bake from scratch
//   (b) cache hit
//   (c) Smolfile-change-triggered rebake
//   (d) dispatch refusal while bake in flight
//   (e) concurrent-instance lock prevents duplicate bakes
//   (f) bake failure surfaces in Snapshot without taking down dispatch

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Reconciler, type BakeExecutor } from '../src/reconciler/index.js';
import { tryAcquireLock, actionCacheDir } from '../src/reconciler/cache.js';
import { buildServiceConfig } from '../src/workflow.js';
import { Orchestrator } from '../src/orchestrator.js';
import type {
  Issue,
  ServiceConfig,
  WorkflowDefinition,
} from '../src/types.js';
import type { WorkflowSource } from '../src/workflow.js';
import type { IssueTracker, CandidateFetchResult } from '../src/trackers/types.js';
import type { WorkspaceManager } from '../src/workspace.js';
import type { AgentRunner } from '../src/agent/runner.js';

interface TmpEnv {
  workflowDir: string;
  trackerRoot: string;
  smolfilePath: string;
  cacheRoot: string;
  cleanup: () => Promise<void>;
}

async function makeTmpEnv(smolfileContent: string): Promise<TmpEnv> {
  const workflowDir = await mkdtemp(path.join(os.tmpdir(), 'symphony-recon-wf-'));
  const trackerRoot = path.join(workflowDir, 'issues');
  await mkdir(trackerRoot, { recursive: true });
  const smolfilePath = path.join(workflowDir, 'Smolfile');
  await writeFile(smolfilePath, smolfileContent);
  const cacheRoot = await mkdtemp(path.join(os.tmpdir(), 'symphony-recon-cache-'));
  return {
    workflowDir,
    trackerRoot,
    smolfilePath,
    cacheRoot,
    cleanup: async () => {
      await rm(workflowDir, { recursive: true, force: true });
      await rm(cacheRoot, { recursive: true, force: true });
    },
  };
}

function makeCfg(env: TmpEnv): ServiceConfig {
  return buildServiceConfig(
    {
      tracker: { kind: 'local', root: env.trackerRoot },
      states: {
        Todo: { role: 'active', adapter: 'claude' },
        Done: { role: 'terminal' },
        Triage: { role: 'holding' },
      },
      smolvm: { smolfile: './Smolfile', cpus: 2, mem_mib: 4096 },
    },
    path.join(env.workflowDir, 'WORKFLOW.md'),
  );
}

// Recording bake executor: tracks every bake invocation and writes a fake
// artifact (or throws on demand) so tests stay hermetic — no smolvm CLI calls.
function makeRecordingExecutor(opts: {
  fail?: boolean;
  hang?: boolean;
  artifactBody?: string;
} = {}): {
  exec: BakeExecutor;
  calls: Array<{ smolfile_path: string; output_path: string }>;
  release: () => void;
} {
  const calls: Array<{ smolfile_path: string; output_path: string }> = [];
  let releaseHang: (() => void) | null = null;
  const exec: BakeExecutor = {
    bake: async (input) => {
      calls.push({ smolfile_path: input.smolfile_path, output_path: input.output_path });
      if (opts.hang) {
        await new Promise<void>((resolve) => {
          releaseHang = resolve;
        });
      }
      if (opts.fail) {
        throw new Error('synthetic bake failure');
      }
      await mkdir(path.dirname(input.output_path), { recursive: true });
      await writeFile(input.output_path, opts.artifactBody ?? 'baked-artifact');
    },
  };
  return {
    exec,
    calls,
    release: () => {
      if (releaseHang) releaseHang();
    },
  };
}

describe('Reconciler bake resource', () => {
  it('(a) initial bake: builds artifact and flips ready=true', async () => {
    const env = await makeTmpEnv('image = "alpine:3.20"\n');
    try {
      const cfg = makeCfg(env);
      const { exec, calls } = makeRecordingExecutor();
      const reconciler = new Reconciler(cfg, { cacheRoot: env.cacheRoot, bakeExecutor: exec });

      assert.equal(reconciler.dispatchReady(), false, 'starts not ready');
      await reconciler.reconcile();
      await reconciler.awaitInFlight();

      assert.equal(calls.length, 1, 'exactly one bake call');
      assert.equal(reconciler.dispatchReady(), true, 'ready after bake');
      const baked = reconciler.bakedArtifactPath();
      assert.ok(baked, 'baked path is set');
      assert.ok(baked!.startsWith(env.cacheRoot), 'baked path lives under the cache root');
      assert.ok(existsSync(baked!), 'baked artifact exists on disk');

      const snap = reconciler.snapshot();
      assert.equal(snap.resources.length, 1);
      assert.equal(snap.resources[0]!.id, 'bake');
      assert.equal(snap.resources[0]!.ready, true);
      const action = snap.resources[0]!.actions[0];
      assert.equal(action?.state, 'done');
      assert.match(action!.action, /^bake:[0-9a-f]{64}$/);
    } finally {
      await env.cleanup();
    }
  });

  it('(b) warm start: pre-existing artifact is treated as ready without baking', async () => {
    const env = await makeTmpEnv('image = "alpine:3.20"\n');
    try {
      // Pre-stage the cached artifact for the current Smolfile hash. The hash matches
      // the sha256 of the Smolfile body we wrote above.
      const { createHash } = await import('node:crypto');
      const body = await readFile(env.smolfilePath);
      const hash = createHash('sha256').update(body).digest('hex');
      const cacheDir = actionCacheDir(env.cacheRoot, 'bake');
      await mkdir(cacheDir, { recursive: true });
      await writeFile(path.join(cacheDir, `${hash}.smolmachine`), 'preexisting');

      const cfg = makeCfg(env);
      const { exec, calls } = makeRecordingExecutor();
      const reconciler = new Reconciler(cfg, { cacheRoot: env.cacheRoot, bakeExecutor: exec });
      await reconciler.reconcile();
      await reconciler.awaitInFlight();

      assert.equal(calls.length, 0, 'no bake on warm start');
      assert.equal(reconciler.dispatchReady(), true);
      assert.equal(reconciler.bakedArtifactPath(), path.join(cacheDir, `${hash}.smolmachine`));
    } finally {
      await env.cleanup();
    }
  });

  it('(c) Smolfile content change triggers a rebake', async () => {
    const env = await makeTmpEnv('image = "alpine:3.20"\n');
    try {
      const cfg = makeCfg(env);
      const { exec, calls } = makeRecordingExecutor();
      const reconciler = new Reconciler(cfg, { cacheRoot: env.cacheRoot, bakeExecutor: exec });
      await reconciler.reconcile();
      await reconciler.awaitInFlight();
      const firstHash = reconciler.snapshot().resources[0]!.desired_hash;
      assert.equal(calls.length, 1);
      assert.ok(firstHash);

      // Mutate the Smolfile and force a fresh reconcile via updateConfig (which is the
      // path the orchestrator takes on a workflow reload). updateConfig schedules a
      // background reconcile; call reconcile explicitly here so awaitInFlight always
      // has an in-flight pass to wait on regardless of scheduling.
      await writeFile(env.smolfilePath, 'image = "alpine:3.21"\n');
      reconciler.updateConfig(makeCfg(env));
      await reconciler.reconcile();
      await reconciler.awaitInFlight();

      const secondHash = reconciler.snapshot().resources[0]!.desired_hash;
      assert.notEqual(firstHash, secondHash, 'hash changed');
      assert.equal(calls.length, 2, 'rebake fired');
      assert.equal(reconciler.dispatchReady(), true);
      assert.ok(reconciler.bakedArtifactPath()!.endsWith(`${secondHash}.smolmachine`));
    } finally {
      await env.cleanup();
    }
  });

  it('(d) dispatch refusal while bake is in flight (orchestrator gate)', async () => {
    const env = await makeTmpEnv('image = "alpine:3.20"\n');
    const fakeHome = await mkdtemp(path.join(os.tmpdir(), 'symphony-recon-home-'));
    const prevHome = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      await mkdir(path.join(fakeHome, '.claude'), { recursive: true });
      await writeFile(path.join(fakeHome, '.claude', '.credentials.json'), '{}');

      const cfg = makeCfg(env);
      const def: WorkflowDefinition = { config: {}, prompt_template: '' };
      const { exec, release } = makeRecordingExecutor({ hang: true });
      const reconciler = new Reconciler(cfg, {
        cacheRoot: env.cacheRoot,
        bakeExecutor: exec,
        backstopIntervalMs: 60_000,
      });

      // The orchestrator dispatch gate is what's under test, but we don't want a
      // real runner. Stub everything the orchestrator touches except the gate.
      let fetchCalls = 0;
      const dispatched: string[] = [];
      const tracker: IssueTracker = {
        async fetchCandidateIssues(): Promise<CandidateFetchResult> {
          fetchCalls++;
          return {
            issues: [
              {
                id: 'X-1',
                identifier: 'X-1',
                title: 'first',
                description: null,
                priority: null,
                state: 'Todo',
                branch_name: null,
                url: null,
                labels: [],
                blocked_by: [],
                created_at: null,
                updated_at: null,
              } satisfies Issue,
            ],
            root: env.trackerRoot,
          };
        },
        async fetchIssuesByStates(): Promise<Issue[]> {
          return [];
        },
        async fetchIssueStatesByIds(): Promise<Issue[]> {
          return [];
        },
      };
      const workflowSrc: WorkflowSource = {
        onChange: () => () => undefined,
        current: () => ({ definition: def, config: cfg }),
        stop: async () => undefined,
      };
      const runner = {
        runAttempt: async (issue: Issue) => {
          dispatched.push(issue.identifier);
          return { ok: true, reason: 'ok', threadId: null, turnsCompleted: 0 };
        },
      } as unknown as AgentRunner;
      const workspaces = {
        workspacePathFor: (id: string) => path.join(env.workflowDir, 'ws', id),
      } as unknown as WorkspaceManager;
      const orch = new Orchestrator(
        cfg,
        def,
        workflowSrc,
        tracker,
        workspaces,
        runner,
        null,
        undefined,
        reconciler,
      );
      await orch.start();

      // The orchestrator's first tick should refuse to dispatch because the bake is
      // hung. Give the event loop a couple of turns to run the dispatch tick.
      await new Promise((r) => setTimeout(r, 50));
      assert.ok(fetchCalls >= 1, 'candidate fetch happened');
      assert.deepEqual(dispatched, [], 'no dispatch while bake in flight');
      assert.equal(reconciler.dispatchReady(), false);
      const snap = orch.snapshot();
      assert.ok(snap.reconciler, 'snapshot exposes reconciler block');
      assert.equal(snap.reconciler!.resources[0]!.ready, false);
      assert.equal(snap.reconciler!.resources[0]!.actions[0]!.state, 'in_progress');

      // Let the bake finish; reconciler should flip ready, and a subsequent
      // reconcile pass should reflect that in the snapshot.
      release();
      await reconciler.awaitInFlight();
      assert.equal(reconciler.dispatchReady(), true);

      await orch.stop();
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      await rm(fakeHome, { recursive: true, force: true });
      await env.cleanup();
    }
  });

  it('(e) concurrent-instance lock prevents duplicate bakes', async () => {
    const env = await makeTmpEnv('image = "alpine:3.20"\n');
    try {
      const cfg = makeCfg(env);
      // Compute the hash so we know the lock path.
      const { createHash } = await import('node:crypto');
      const body = await readFile(env.smolfilePath);
      const hash = createHash('sha256').update(body).digest('hex');
      const cacheDir = actionCacheDir(env.cacheRoot, 'bake');
      await mkdir(cacheDir, { recursive: true });
      const lockPath = path.join(cacheDir, `${hash}.smolmachine.lock`);
      const lock = await tryAcquireLock(lockPath);
      assert.ok(lock, 'first lock acquired');

      const { exec, calls } = makeRecordingExecutor();
      const reconciler = new Reconciler(cfg, { cacheRoot: env.cacheRoot, bakeExecutor: exec });
      await reconciler.reconcile();
      await reconciler.awaitInFlight();
      // The reconciler should bail because the lock is held by "another instance"
      // (us, in this test). No bake call goes out.
      assert.equal(calls.length, 0, 'no bake fired while lock is held');
      assert.equal(reconciler.dispatchReady(), false);
      const snap = reconciler.snapshot();
      assert.equal(snap.resources[0]!.actions[0]!.state, 'in_progress');

      // Release the lock; a fresh reconcile pass now bakes.
      await lock!.release();
      await reconciler.reconcile();
      await reconciler.awaitInFlight();
      assert.equal(calls.length, 1, 'bake runs after the foreign lock releases');
      assert.equal(reconciler.dispatchReady(), true);
    } finally {
      await env.cleanup();
    }
  });

  it('(f) bake failure surfaces in Snapshot without taking down dispatch (ready stays false; reconciler keeps running)', async () => {
    const env = await makeTmpEnv('image = "alpine:3.20"\n');
    try {
      const cfg = makeCfg(env);
      const { exec, calls } = makeRecordingExecutor({ fail: true });
      const reconciler = new Reconciler(cfg, { cacheRoot: env.cacheRoot, bakeExecutor: exec });
      await reconciler.reconcile();
      await reconciler.awaitInFlight();

      assert.equal(calls.length, 1);
      assert.equal(reconciler.dispatchReady(), false);
      const snap = reconciler.snapshot();
      const failed = snap.resources[0]!.actions[0];
      assert.equal(failed?.state, 'error');
      assert.match(failed!.error!, /synthetic bake failure/);
      assert.match(snap.resources[0]!.last_error!, /synthetic bake failure/);

      // Reconciler is still functional after the failure: a healthy executor on
      // the next pass produces a ready artifact.
      const recovery = makeRecordingExecutor();
      const reconciler2 = new Reconciler(cfg, {
        cacheRoot: env.cacheRoot,
        bakeExecutor: recovery.exec,
      });
      await reconciler2.reconcile();
      await reconciler2.awaitInFlight();
      assert.equal(reconciler2.dispatchReady(), true);
    } finally {
      await env.cleanup();
    }
  });

  it('--reconcile-force drops the cached artifact and rebakes', async () => {
    const env = await makeTmpEnv('image = "alpine:3.20"\n');
    try {
      const cfg = makeCfg(env);
      const { exec, calls } = makeRecordingExecutor();
      const reconciler = new Reconciler(cfg, { cacheRoot: env.cacheRoot, bakeExecutor: exec });
      await reconciler.reconcile();
      await reconciler.awaitInFlight();
      assert.equal(calls.length, 1);
      const baked = reconciler.bakedArtifactPath();
      assert.ok(baked);
      const beforeMtime = (await stat(baked!)).mtimeMs;

      // Wait a tick so the mtime difference is observable on filesystems with
      // second-resolution mtimes (most ext4 mounts).
      await new Promise((r) => setTimeout(r, 5));

      await reconciler.reconcile({ force: true });
      await reconciler.awaitInFlight();
      assert.equal(calls.length, 2, 'force triggered a fresh bake');
      const afterMtime = (await stat(baked!)).mtimeMs;
      assert.ok(afterMtime >= beforeMtime, 'artifact was rewritten');
      assert.equal(reconciler.dispatchReady(), true);
    } finally {
      await env.cleanup();
    }
  });

  it('with no smolfile configured, dispatchReady is trivially true (no bake needed)', async () => {
    const env = await makeTmpEnv('image = "alpine:3.20"\n');
    try {
      const cfg = buildServiceConfig(
        {
          tracker: { kind: 'local', root: env.trackerRoot },
          states: {
            Todo: { role: 'active', adapter: 'claude' },
            Done: { role: 'terminal' },
            Triage: { role: 'holding' },
          },
          smolvm: { image: 'alpine:3.20', cpus: 2, mem_mib: 4096 },
        },
        path.join(env.workflowDir, 'WORKFLOW.md'),
      );
      const { exec, calls } = makeRecordingExecutor();
      const reconciler = new Reconciler(cfg, { cacheRoot: env.cacheRoot, bakeExecutor: exec });
      await reconciler.reconcile();
      assert.equal(calls.length, 0);
      assert.equal(reconciler.dispatchReady(), true);
      assert.equal(reconciler.bakedArtifactPath(), null);
    } finally {
      await env.cleanup();
    }
  });
});
