import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { Orchestrator } from '../src/orchestrator.js';
import { buildServiceConfig } from '../src/workflow.js';
import type { ServiceConfig, WorkflowDefinition, Issue } from '../src/types.js';
import type { WorkflowSource } from '../src/workflow.js';
import type { IssueTracker, CandidateFetchResult } from '../src/trackers/types.js';
import type { WorkspaceManager } from '../src/workspace.js';
import type { AgentRunner } from '../src/agent/runner.js';
import type { SmolvmClient } from '../src/agent/smolvm.js';
import { Reconciler } from '../src/reconciler/index.js';

// Phase 2 contract for orchestrator startup: the credential check is no longer
// just `cfg.acp.adapter`, it has to walk the union of the workflow-level adapter
// and every distinct adapter declared on any state. A workflow that pins claude
// at the top level but assigns codex to its Review state must fail startup
// loudly if codex's host credential is missing — otherwise the operator gets a
// confusing per-issue failure inside the VM instead of a clean error at boot.

function makeTracker(): IssueTracker {
  return {
    async fetchCandidateIssues(): Promise<CandidateFetchResult> {
      return { issues: [], root: null };
    },
    async fetchIssuesByStates(): Promise<Issue[]> {
      return [];
    },
    async fetchIssueStatesByIds(): Promise<Issue[]> {
      return [];
    },
  };
}

function makeStubs(): {
  workflowSrc: WorkflowSource;
  tracker: IssueTracker;
  workspaces: WorkspaceManager;
  runner: AgentRunner;
} {
  return {
    workflowSrc: { onChange: () => () => undefined, current: () => ({} as any), stop: async () => undefined } as unknown as WorkflowSource,
    tracker: makeTracker(),
    workspaces: {} as unknown as WorkspaceManager,
    runner: {} as unknown as AgentRunner,
  };
}

// Recording fake of SmolvmClient — captures `list()` and `destroy()` calls so the
// orphan-cleanup tests can assert which VMs were enumerated and which were torn down,
// without touching the real smolvm CLI.
interface FakeSmolvm {
  client: SmolvmClient;
  destroyed: string[];
  listCalls: number;
}

function makeFakeSmolvm(initialVms: string[]): FakeSmolvm {
  const state = { vms: [...initialVms], destroyed: [] as string[], listCalls: 0 };
  const client: Partial<SmolvmClient> = {
    list: async () => {
      state.listCalls++;
      return [...state.vms];
    },
    destroy: async (name: string) => {
      state.destroyed.push(name);
      state.vms = state.vms.filter((v) => v !== name);
    },
  };
  return {
    client: client as SmolvmClient,
    get destroyed() {
      return state.destroyed;
    },
    get listCalls() {
      return state.listCalls;
    },
  };
}

async function buildCfgAndDef(
  raw: Record<string, unknown>,
  trackerRoot: string,
): Promise<{ cfg: ServiceConfig; def: WorkflowDefinition }> {
  // The buildServiceConfig validator requires the local tracker root to exist
  // as a real directory; the caller passes one in so the per-test fixture owns
  // setup/teardown.
  const merged = { ...raw, tracker: { kind: 'local', root: trackerRoot, ...(raw.tracker as object ?? {}) } };
  const cfg = buildServiceConfig(merged, path.join(trackerRoot, 'WORKFLOW.md'));
  const def: WorkflowDefinition = { config: merged, prompt_template: '' };
  return { cfg, def };
}

describe('Orchestrator startup credential check', () => {
  it('iterates over every per-state adapter and fails when one credential is missing', async () => {
    // Set up a fake $HOME that contains the claude credential but not the
    // codex one. A workflow that declares a Review state on codex should then
    // surface the missing-codex-credential as a startup error, not silently
    // succeed because the workflow-level acp.adapter (claude) is OK.
    const fakeHome = await mkdtemp(path.join(os.tmpdir(), 'symphony-startup-home-'));
    const trackerRoot = await mkdtemp(path.join(os.tmpdir(), 'symphony-startup-tracker-'));
    const prevHome = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      // Stage the claude credential so the workflow-level acp.adapter probe
      // passes; leave codex absent so the per-state probe is the one that
      // trips.
      await mkdir(path.join(fakeHome, '.claude'), { recursive: true });
      await writeFile(path.join(fakeHome, '.claude', '.credentials.json'), '{}');

      const { cfg, def } = await buildCfgAndDef(
        {
          acp: { adapter: 'claude' },
          states: {
            Todo: { role: 'active', adapter: 'claude' },
            Review: { role: 'active', adapter: 'codex' },
            Done: { role: 'terminal' },
            Triage: { role: 'holding' },
          },
        },
        trackerRoot,
      );
      const { workflowSrc, tracker, workspaces, runner } = makeStubs();
      const orch = new Orchestrator(cfg, def, workflowSrc, tracker, workspaces, runner);
      await assert.rejects(
        () => orch.start(),
        (err: unknown) =>
          err instanceof Error &&
          /codex/.test(err.message) &&
          /credential/.test(err.message),
      );
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      await rm(fakeHome, { recursive: true, force: true });
      await rm(trackerRoot, { recursive: true, force: true });
    }
  });

  it('starts cleanly when credentials for every referenced adapter are present', async () => {
    // Same workflow as above but with both credentials staged. Orchestrator
    // should reach the post-credential-check workspace + VM reap path and
    // resolve without throwing.
    const fakeHome = await mkdtemp(path.join(os.tmpdir(), 'symphony-startup-home-ok-'));
    const trackerRoot = await mkdtemp(path.join(os.tmpdir(), 'symphony-startup-tracker-ok-'));
    const prevHome = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      await mkdir(path.join(fakeHome, '.claude'), { recursive: true });
      await writeFile(path.join(fakeHome, '.claude', '.credentials.json'), '{}');
      await mkdir(path.join(fakeHome, '.codex'), { recursive: true });
      await writeFile(path.join(fakeHome, '.codex', 'auth.json'), '{}');

      const { cfg, def } = await buildCfgAndDef(
        {
          acp: { adapter: 'claude' },
          states: {
            Todo: { role: 'active', adapter: 'claude' },
            Review: { role: 'active', adapter: 'codex' },
            Done: { role: 'terminal' },
            Triage: { role: 'holding' },
          },
        },
        trackerRoot,
      );
      const { workflowSrc, tracker, workspaces, runner } = makeStubs();
      const orch = new Orchestrator(cfg, def, workflowSrc, tracker, workspaces, runner);
      await orch.start();
      await orch.stop();
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      await rm(fakeHome, { recursive: true, force: true });
      await rm(trackerRoot, { recursive: true, force: true });
    }
  });

});

// Orphan-VM reaping is the lifecycle counterpart to startup terminal workspace
// cleanup: each per-issue smolvm VM is owned by the orchestrator process, but the
// libkrun VM itself outlives a SIGKILL or crash of that process because it is
// daemon-managed. Without the reaping path, every restart leaves the prior
// instance's VMs behind, and over enough restarts the host OOMs (issue 26).
//
// Issue 33 moved the reaping into the reconciler's `vm` resource. The
// orchestrator just wires itself in as the IntendedVmProvider and triggers a
// reap at three points: startup (sweep prior-process strays), shutdown
// (backstop in-flight workers whose cleanup the SIGTERM cancelled), and after
// any non-clean worker exit. These tests pin those orchestrator-level
// integration points; the per-action details (SIGTERM→SIGKILL grace,
// boot-worker enumeration via /proc) are covered in tests/reconciler-vm.test.ts.
describe('Orchestrator VM lifecycle reaping', () => {
  // Helper: build a Reconciler with the supplied fake smolvm client and a
  // hermetic boot-worker stub. The boot-worker default reads host /proc; tests
  // must stub it so the suite doesn't pick up real `_boot-vm` workers on a
  // busy developer box.
  function makeReconcilerWith(cfg: ServiceConfig, fake: FakeSmolvm): Reconciler {
    return new Reconciler(cfg, {
      smolvm: fake.client,
      listBootWorkers: async () => [],
      killProcess: () => undefined,
      killGraceMs: 0,
      // Keep the backstop interval long so it never fires inside a test;
      // we drive reapVms() manually via start/stop.
      backstopIntervalMs: 60_000,
    });
  }

  it('destroys orphan symphony-* VMs at startup via the reconciler', async () => {
    const fakeHome = await mkdtemp(path.join(os.tmpdir(), 'symphony-vm-start-home-'));
    const trackerRoot = await mkdtemp(path.join(os.tmpdir(), 'symphony-vm-start-tracker-'));
    const prevHome = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      await mkdir(path.join(fakeHome, '.claude'), { recursive: true });
      await writeFile(path.join(fakeHome, '.claude', '.credentials.json'), '{}');

      const { cfg, def } = await buildCfgAndDef(
        {
          acp: { adapter: 'claude' },
          states: {
            Todo: { role: 'active', adapter: 'claude' },
            Done: { role: 'terminal' },
            Triage: { role: 'holding' },
          },
        },
        trackerRoot,
      );
      const { workflowSrc, tracker, workspaces, runner } = makeStubs();
      // Mix orphan symphony VMs with an unrelated VM the operator may have running.
      // Only the symphony-prefixed ones should be reaped.
      const fake = makeFakeSmolvm([
        'symphony-1',
        'symphony-old-issue',
        'unrelated-vm',
        'SYMPHONY-uppercase-not-prefix', // case-sensitive prefix; this stays
      ]);
      const reconciler = makeReconcilerWith(cfg, fake);
      const orch = new Orchestrator(
        cfg,
        def,
        workflowSrc,
        tracker,
        workspaces,
        runner,
        undefined,
        reconciler,
      );
      reconciler.setIntendedVmProvider(orch);
      await orch.start();
      assert.deepEqual(fake.destroyed.sort(), ['symphony-1', 'symphony-old-issue']);
      await orch.stop();
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      await rm(fakeHome, { recursive: true, force: true });
      await rm(trackerRoot, { recursive: true, force: true });
    }
  });

  it('destroys remaining symphony-* VMs at shutdown so SIGTERM does not leak them', async () => {
    const fakeHome = await mkdtemp(path.join(os.tmpdir(), 'symphony-vm-stop-home-'));
    const trackerRoot = await mkdtemp(path.join(os.tmpdir(), 'symphony-vm-stop-tracker-'));
    const prevHome = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      await mkdir(path.join(fakeHome, '.claude'), { recursive: true });
      await writeFile(path.join(fakeHome, '.claude', '.credentials.json'), '{}');

      const { cfg, def } = await buildCfgAndDef(
        {
          acp: { adapter: 'claude' },
          states: {
            Todo: { role: 'active', adapter: 'claude' },
            Done: { role: 'terminal' },
            Triage: { role: 'holding' },
          },
        },
        trackerRoot,
      );
      const { workflowSrc, tracker, workspaces, runner } = makeStubs();
      // No orphans at startup; simulate a VM that the runner's per-attempt cleanup
      // didn't reach in time (e.g. SIGTERM mid-attempt) by injecting it before stop().
      const fake = makeFakeSmolvm([]);
      const reconciler = makeReconcilerWith(cfg, fake);
      const orch = new Orchestrator(
        cfg,
        def,
        workflowSrc,
        tracker,
        workspaces,
        runner,
        undefined,
        reconciler,
      );
      reconciler.setIntendedVmProvider(orch);
      await orch.start();
      assert.deepEqual(fake.destroyed, []);
      // Inject a "leaked" VM into the smolvm view to mimic the SIGTERM-mid-run path.
      (fake.client.list as () => Promise<string[]>) = async () => ['symphony-leaked-7'];
      await orch.stop();
      assert.deepEqual(fake.destroyed, ['symphony-leaked-7']);
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      await rm(fakeHome, { recursive: true, force: true });
      await rm(trackerRoot, { recursive: true, force: true });
    }
  });

  it('createWorkspace resolves per-state hooks for the reconciler-driven path', async () => {
    // Regression test: the reconciler invokes createWorkspace(identifier, state)
    // when it eagerly creates a missing workspace. The orchestrator must
    // resolve hooks against `state` via `resolveHooksForState`, not just pass
    // the workflow-level block — otherwise a state-level `after_create`
    // override (e.g. `states.Todo.hooks.after_create`) silently fails to fire
    // when creation is reconciler-driven. The fix carries enough state through
    // the intended provider for hook resolution to work.
    const trackerRoot = await mkdtemp(path.join(os.tmpdir(), 'symphony-create-hooks-tracker-'));
    try {
      const { cfg, def } = await buildCfgAndDef(
        {
          acp: { adapter: 'claude' },
          hooks: { after_create: 'workflow-level-after-create' },
          states: {
            Todo: {
              role: 'active',
              adapter: 'claude',
              hooks: { after_create: 'todo-state-after-create' },
            },
            Review: { role: 'active', adapter: 'claude' },
            Done: { role: 'terminal' },
          },
        },
        trackerRoot,
      );
      // Capture every (identifier, hooks) tuple the orchestrator hands to
      // WorkspaceManager.ensureFor so we can pin which after_create script the
      // resolver picked. The fake also counts invocations so the test can
      // assert exactly-once behavior when the lock coalesces two callers.
      const ensureCalls: Array<{
        identifier: string;
        after_create: string | null;
      }> = [];
      const fakeWorkspaces = {
        ensureFor: async (identifier: string, hooks: { after_create: string | null }) => {
          ensureCalls.push({ identifier, after_create: hooks.after_create });
          return { path: '/tmp/ignored', workspace_key: identifier, created_now: true };
        },
      } as unknown as WorkspaceManager;
      const { workflowSrc, tracker, runner } = makeStubs();
      const orch = new Orchestrator(cfg, def, workflowSrc, tracker, fakeWorkspaces, runner);
      // State-level override wins for Todo.
      await orch.createWorkspace('issue-42', 'Todo');
      // No state override on Review → workflow-level after_create fires.
      await orch.createWorkspace('issue-43', 'Review');
      // Defensive null state → falls back to workflow-level hooks.
      await orch.createWorkspace('issue-44', null);
      assert.deepEqual(ensureCalls, [
        { identifier: 'issue-42', after_create: 'todo-state-after-create' },
        { identifier: 'issue-43', after_create: 'workflow-level-after-create' },
        { identifier: 'issue-44', after_create: 'workflow-level-after-create' },
      ]);
    } finally {
      await rm(trackerRoot, { recursive: true, force: true });
    }
  });

  it('reconciler-driven create fires a state-level after_create exactly once', async () => {
    // End-to-end pin on the per-identifier ensureFor lock: when both the
    // reconciler and a dispatch caller race on the same identifier with the
    // same per-state hooks, after_create must fire exactly once. Drives the
    // real WorkspaceManager + setupWorkspaceDir against a real source repo so
    // the lock + after_create interaction is the live one (not a stub).
    const trackerRoot = await mkdtemp(path.join(os.tmpdir(), 'symphony-create-once-tracker-'));
    const wsRoot = await mkdtemp(path.join(os.tmpdir(), 'symphony-create-once-ws-'));
    const sourceRepo = await mkdtemp(path.join(os.tmpdir(), 'symphony-create-once-src-'));
    const markerFile = path.join(
      await mkdtemp(path.join(os.tmpdir(), 'symphony-create-once-marker-')),
      'count.txt',
    );
    // Build a real source repo on main so setupWorkspaceDir can clone it.
    await new Promise<void>((resolve, reject) => {
      const child = spawn('sh', ['-lc', [
        'git init -b main',
        'git config user.name test',
        'git config user.email test@example.com',
        'echo initial > README.md',
        'git add .',
        'git commit -m initial',
      ].join(' && ')], { cwd: sourceRepo, stdio: 'ignore' });
      child.on('error', reject);
      child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`git init exit ${code}`))));
    });
    try {
      const { cfg, def } = await buildCfgAndDef(
        {
          workspace: { root: wsRoot },
          acp: { adapter: 'claude' },
          // Per-state override picks up an `after_create` that appends to a
          // marker file. If it fires twice the file ends up with 2 lines.
          states: {
            Todo: {
              role: 'active',
              adapter: 'claude',
              hooks: { after_create: `echo fired >> ${markerFile}` },
            },
            Done: { role: 'terminal' },
          },
        },
        trackerRoot,
      );
      const realWorkspaces = new (await import('../src/workspace.js')).WorkspaceManager(cfg);
      // Force the canonical setup to clone from the test source repo regardless
      // of cfg.workflow_dir.
      const prevSource = process.env.SYMPHONY_SOURCE_REPO;
      process.env.SYMPHONY_SOURCE_REPO = sourceRepo;
      try {
        const { workflowSrc, tracker, runner } = makeStubs();
        const orch = new Orchestrator(cfg, def, workflowSrc, tracker, realWorkspaces, runner);
        // Two concurrent callers for the same identifier (reconciler eager-create
        // + dispatch runner). The per-identifier lock must coalesce them and the
        // per-state after_create must fire exactly once.
        await Promise.all([
          orch.createWorkspace('issue-100', 'Todo'),
          orch.createWorkspace('issue-100', 'Todo'),
        ]);
        const { readFile } = await import('node:fs/promises');
        const body = await readFile(markerFile, 'utf8');
        const lines = body.split('\n').filter((l) => l.length > 0);
        assert.equal(lines.length, 1, `after_create fired ${lines.length} times, expected 1`);
      } finally {
        if (prevSource === undefined) delete process.env.SYMPHONY_SOURCE_REPO;
        else process.env.SYMPHONY_SOURCE_REPO = prevSource;
      }
    } finally {
      await rm(trackerRoot, { recursive: true, force: true });
      await rm(wsRoot, { recursive: true, force: true });
      await rm(sourceRepo, { recursive: true, force: true });
      await rm(path.dirname(markerFile), { recursive: true, force: true });
    }
  });

  it('skips reaping when no Reconciler is wired (test/stub harness)', async () => {
    // The orchestrator's Reconciler parameter is optional so tests that don't
    // care about VM lifecycle can omit it. Confirm that path stays silent and
    // does not throw at start/stop.
    const fakeHome = await mkdtemp(path.join(os.tmpdir(), 'symphony-vm-skip-home-'));
    const trackerRoot = await mkdtemp(path.join(os.tmpdir(), 'symphony-vm-skip-tracker-'));
    const prevHome = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      await mkdir(path.join(fakeHome, '.claude'), { recursive: true });
      await writeFile(path.join(fakeHome, '.claude', '.credentials.json'), '{}');
      const { cfg, def } = await buildCfgAndDef(
        {
          acp: { adapter: 'claude' },
          states: {
            Todo: { role: 'active', adapter: 'claude' },
            Done: { role: 'terminal' },
            Triage: { role: 'holding' },
          },
        },
        trackerRoot,
      );
      const { workflowSrc, tracker, workspaces, runner } = makeStubs();
      const orch = new Orchestrator(cfg, def, workflowSrc, tracker, workspaces, runner);
      await orch.start();
      await orch.stop();
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      await rm(fakeHome, { recursive: true, force: true });
      await rm(trackerRoot, { recursive: true, force: true });
    }
  });
});
