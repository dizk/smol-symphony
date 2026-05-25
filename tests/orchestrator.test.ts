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

  it('ensureWorkspaceForAutopilot short-circuits when the workspace dir already exists (issue 53)', async () => {
    // Idempotency contract: the PR resource calls ensureWorkspace on every
    // rebase pass, so when the dir is already there the orchestrator must
    // NOT re-invoke WorkspaceManager.ensureFor (a re-clone would clobber the
    // working tree and lose the agent's in-progress commits).
    const trackerRoot = await mkdtemp(path.join(os.tmpdir(), 'symphony-ensure-exists-tracker-'));
    const wsRoot = await mkdtemp(path.join(os.tmpdir(), 'symphony-ensure-exists-ws-'));
    try {
      const { cfg, def } = await buildCfgAndDef(
        {
          workspace: { root: wsRoot },
          acp: { adapter: 'claude' },
          pr_autopilot: {
            enabled: true,
            merge_state: 'Done',
            close_state: 'Cancelled',
            max_rebase_attempts: 3,
            auto_merge_strategy: 'squash',
            poll_interval_ms: 30000,
          },
          states: {
            Todo: { role: 'active', adapter: 'claude' },
            Done: { role: 'terminal' },
            Cancelled: { role: 'terminal' },
            Conflict: { role: 'holding' },
          },
        },
        trackerRoot,
      );
      let ensureForCalls = 0;
      const fakeWorkspaces = {
        workspacePathFor: (identifier: string) => path.join(wsRoot, identifier),
        ensureFor: async () => {
          ensureForCalls += 1;
          return { path: '/tmp/ignored', workspace_key: 'x', created_now: true };
        },
      } as unknown as WorkspaceManager;
      const { workflowSrc, tracker, runner } = makeStubs();
      const orch = new Orchestrator(cfg, def, workflowSrc, tracker, fakeWorkspaces, runner);
      // Pre-create the workspace directory: the autopilot's caller observes
      // it on disk, so ensureWorkspaceForAutopilot must take the short path.
      const existingDir = path.join(wsRoot, 'issue-77');
      await mkdir(existingDir, { recursive: true });
      const outcome = await orch.ensureWorkspaceForAutopilot({
        identifier: 'issue-77',
        workspacePath: existingDir,
        branch: 'agent/77',
        baseBranch: 'main',
        expectedHeadSha: 'deadbeef',
      });
      assert.deepEqual(outcome, { kind: 'ok' });
      assert.equal(ensureForCalls, 0, 'ensureFor must NOT be called when the dir already exists');
    } finally {
      await rm(trackerRoot, { recursive: true, force: true });
      await rm(wsRoot, { recursive: true, force: true });
    }
  });

  it('ensureWorkspaceForAutopilot materializes a missing workspace and positions HEAD at the remote agent tip (issue 53)', async () => {
    // End-to-end happy path: bare remote has main + an agent/<id> branch with
    // one extra commit. The local workspace dir does not exist. The orchestrator
    // must (a) re-clone via WorkspaceManager.ensureFor, (b) fetch origin
    // agent/<id>, and (c) hard-reset the local branch to the remote tip — so
    // `git rev-parse HEAD` after the call equals the remote agent branch SHA.
    const trackerRoot = await mkdtemp(path.join(os.tmpdir(), 'symphony-ensure-e2e-tracker-'));
    const wsRoot = await mkdtemp(path.join(os.tmpdir(), 'symphony-ensure-e2e-ws-'));
    const bareRemote = await mkdtemp(path.join(os.tmpdir(), 'symphony-ensure-e2e-remote-'));
    const sourceRepo = await mkdtemp(path.join(os.tmpdir(), 'symphony-ensure-e2e-source-'));
    const pusher = await mkdtemp(path.join(os.tmpdir(), 'symphony-ensure-e2e-pusher-'));
    const runGit = (cwd: string, args: string[]): Promise<void> =>
      new Promise((resolve, reject) => {
        const child = spawn('git', args, { cwd, stdio: 'ignore' });
        child.on('error', reject);
        child.on('close', (code) =>
          code === 0 ? resolve() : reject(new Error(`git ${args.join(' ')} exit ${code}`)),
        );
      });
    const captureGit = async (cwd: string, args: string[]): Promise<string> =>
      new Promise((resolve, reject) => {
        const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        child.stdout?.on('data', (b) => (out += b.toString('utf8')));
        child.on('error', reject);
        child.on('close', (code) =>
          code === 0 ? resolve(out.trim()) : reject(new Error(`git ${args.join(' ')} exit ${code}`)),
        );
      });
    try {
      // Production shape: the *source repo* (the operator's workflow_dir,
      // i.e. what `setupWorkspaceDir` clones from) holds only `main`. The
      // agent/<id> branch lives only on the GitHub-like origin — the
      // dispatched agent pushed it from inside its VM and the source repo
      // never tracked it. We use a separate `pusher` clone of the bare remote
      // to seed the agent branch so `sourceRepo` stays untouched.
      await runGit(bareRemote, ['init', '--bare', '-b', 'main']);
      await runGit(sourceRepo, ['init', '-b', 'main']);
      await runGit(sourceRepo, ['config', 'user.name', 'test']);
      await runGit(sourceRepo, ['config', 'user.email', 'test@example.com']);
      await writeFile(path.join(sourceRepo, 'README.md'), 'seed\n');
      await runGit(sourceRepo, ['add', 'README.md']);
      await runGit(sourceRepo, ['commit', '-m', 'seed']);
      await runGit(sourceRepo, ['remote', 'add', 'origin', bareRemote]);
      await runGit(sourceRepo, ['push', 'origin', 'main']);
      // Detach the source from the bare remote so it cannot opportunistically
      // know about `agent/77`: that branch must exist *only* on the bare
      // remote, never reachable from `sourceRepo`'s refs.
      await runGit(sourceRepo, ['remote', 'remove', 'origin']);

      // Seed `agent/77` on the bare remote from a throwaway clone — mirrors
      // "agent ran in its VM and pushed its branch back to GitHub".
      await runGit(pusher, ['clone', '--branch', 'main', bareRemote, '.']);
      await runGit(pusher, ['config', 'user.name', 'agent']);
      await runGit(pusher, ['config', 'user.email', 'agent@example.com']);
      await runGit(pusher, ['checkout', '-b', 'agent/77']);
      await writeFile(path.join(pusher, 'agent-work.md'), 'agent commit\n');
      await runGit(pusher, ['add', 'agent-work.md']);
      await runGit(pusher, ['commit', '-m', 'agent work']);
      const expectedAgentSha = await captureGit(pusher, ['rev-parse', 'HEAD']);
      await runGit(pusher, ['push', 'origin', 'agent/77']);

      const { cfg, def } = await buildCfgAndDef(
        {
          workspace: { root: wsRoot },
          acp: { adapter: 'claude' },
          pr_autopilot: {
            enabled: true,
            merge_state: 'Done',
            close_state: 'Cancelled',
            max_rebase_attempts: 3,
            auto_merge_strategy: 'squash',
            poll_interval_ms: 30000,
          },
          states: {
            Todo: { role: 'active', adapter: 'claude' },
            Done: { role: 'terminal' },
            Cancelled: { role: 'terminal' },
            Conflict: { role: 'holding' },
          },
        },
        trackerRoot,
      );
      // Fake WorkspaceManager that mimics setupWorkspaceDir's outcome: it
      // clones the *source repo* (which only has `main`) and then strips +
      // re-adds origin pointing at the bare remote. After this, the workspace
      // has NO `refs/remotes/origin/agent/77` ref — exactly the production
      // shape, so the orchestrator's fetch+reset has to materialize it.
      const fakeWorkspaces = {
        workspacePathFor: (identifier: string) => path.join(wsRoot, identifier),
        ensureFor: async (identifier: string) => {
          const wsPath = path.join(wsRoot, identifier);
          await mkdir(wsPath, { recursive: true });
          await runGit(wsPath, ['clone', '--local', '--branch', 'main', sourceRepo, '.']);
          await runGit(wsPath, ['config', 'user.name', 'symphony-agent']);
          await runGit(wsPath, ['config', 'user.email', 'agent@symphony.local']);
          await runGit(wsPath, ['remote', 'remove', 'origin']);
          await runGit(wsPath, ['remote', 'add', 'origin', bareRemote]);
          await runGit(wsPath, ['checkout', '-b', `agent/${identifier}`]);
          return { path: wsPath, workspace_key: identifier, created_now: true };
        },
      } as unknown as WorkspaceManager;
      const { workflowSrc, tracker, runner } = makeStubs();
      const orch = new Orchestrator(cfg, def, workflowSrc, tracker, fakeWorkspaces, runner);
      const wsPath = path.join(wsRoot, '77');
      const outcome = await orch.ensureWorkspaceForAutopilot({
        identifier: '77',
        workspacePath: wsPath,
        branch: 'agent/77',
        baseBranch: 'main',
        expectedHeadSha: expectedAgentSha,
      });
      assert.equal(outcome.kind, 'ok', JSON.stringify(outcome));
      // The fetch must create `refs/remotes/origin/agent/77` so the
      // subsequent `git reset --hard origin/agent/77` resolves. This is the
      // specific regression: an unscoped `git fetch origin <branch>` cannot
      // be relied on to update the remote-tracking ref in every git config,
      // so the orchestrator uses an explicit refspec.
      const remoteAgentSha = await captureGit(wsPath, ['rev-parse', 'refs/remotes/origin/agent/77']);
      assert.equal(remoteAgentSha, expectedAgentSha, 'origin/agent/77 ref points at pushed tip');
      // Local HEAD must equal the remote agent branch SHA so the standard
      // rebaseOnto can run its rev-parse HEAD == expectedHeadSha check.
      const headAfter = await captureGit(wsPath, ['rev-parse', 'HEAD']);
      assert.equal(headAfter, expectedAgentSha, 'HEAD repositioned to remote agent branch tip');
      // The agent's extra commit must be present in the working tree.
      const { readFile } = await import('node:fs/promises');
      const agentWork = await readFile(path.join(wsPath, 'agent-work.md'), 'utf8');
      assert.match(agentWork, /agent commit/);
    } finally {
      await rm(trackerRoot, { recursive: true, force: true });
      await rm(wsRoot, { recursive: true, force: true });
      await rm(bareRemote, { recursive: true, force: true });
      await rm(sourceRepo, { recursive: true, force: true });
      await rm(pusher, { recursive: true, force: true });
    }
  });

  it('ensureWorkspaceForAutopilot returns a typed error when materialization fails (issue 53)', async () => {
    // When workspaces.ensureFor throws (e.g., source repo missing), the
    // orchestrator must surface it as { kind: 'error', diagnostic } so the
    // PR resource can record it in the action ledger and the operator sees
    // a concrete failure on the dashboard instead of silent stall.
    const trackerRoot = await mkdtemp(path.join(os.tmpdir(), 'symphony-ensure-fail-tracker-'));
    const wsRoot = await mkdtemp(path.join(os.tmpdir(), 'symphony-ensure-fail-ws-'));
    try {
      const { cfg, def } = await buildCfgAndDef(
        {
          workspace: { root: wsRoot },
          acp: { adapter: 'claude' },
          pr_autopilot: {
            enabled: true,
            merge_state: 'Done',
            close_state: 'Cancelled',
            max_rebase_attempts: 3,
            auto_merge_strategy: 'squash',
            poll_interval_ms: 30000,
          },
          states: {
            Todo: { role: 'active', adapter: 'claude' },
            Done: { role: 'terminal' },
            Cancelled: { role: 'terminal' },
            Conflict: { role: 'holding' },
          },
        },
        trackerRoot,
      );
      const fakeWorkspaces = {
        workspacePathFor: (identifier: string) => path.join(wsRoot, identifier),
        ensureFor: async () => {
          throw new Error('source repo not a git repository');
        },
      } as unknown as WorkspaceManager;
      const { workflowSrc, tracker, runner } = makeStubs();
      const orch = new Orchestrator(cfg, def, workflowSrc, tracker, fakeWorkspaces, runner);
      // The dir does NOT exist, so the orchestrator goes into the materialize
      // path; ensureFor throws and we expect a typed error back.
      const missingDir = path.join(wsRoot, 'issue-88');
      const outcome = await orch.ensureWorkspaceForAutopilot({
        identifier: 'issue-88',
        workspacePath: missingDir,
        branch: 'agent/88',
        baseBranch: 'main',
        expectedHeadSha: 'deadbeef',
      });
      assert.equal(outcome.kind, 'error');
      if (outcome.kind === 'error') {
        assert.match(outcome.diagnostic, /ensure_workspace_clone_failed/);
        assert.match(outcome.diagnostic, /source repo not a git repository/);
      }
    } finally {
      await rm(trackerRoot, { recursive: true, force: true });
      await rm(wsRoot, { recursive: true, force: true });
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
