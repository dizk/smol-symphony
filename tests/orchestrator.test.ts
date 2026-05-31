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
import { Reconciler } from '../src/reconciler/index.js';
import type { ReaperSession } from '../src/reconciler/vm.js';

// Startup credential contract under the credential-proxy architecture
// (#114/#116/#120): every proxy-backed adapter in the union of workflow-level
// and per-state adapters is probed at startup. claude needs a readable
// `~/.claude/.credentials.json`; codex needs either a `~/.codex/auth.json` token
// or an `OPENAI_API_KEY` env var. A missing credential fails fast here rather
// than surfacing as an opaque per-request proxy failure mid-dispatch.

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

// Recording fake of the Gondolin reaper surface (`listSessions` + `gc` +
// `killProcess`). Captures which session pids were SIGTERM'd and how often the
// session set was enumerated / gc'd, so the orphan-cleanup tests can assert
// reaper behavior without touching real Gondolin sessions. Each entry is a
// `symphony-`-labelled session keyed by label→pid; `destroyed` reports the
// labels whose backing pid received a SIGTERM (the analogue of the old
// VM-destroy assertion).
interface FakeReaper {
  listSessions: () => Promise<ReaperSession[]>;
  gc: () => Promise<number>;
  killProcess: (pid: number, signal: NodeJS.Signals | 0) => void;
  destroyed: string[];
  listCalls: number;
  gcCalls: number;
  setSessions: (labels: string[]) => void;
}

// Deterministic label→pid map so a label like `symphony-1` always maps to the
// same fake host pid across enumerations within one fake.
function makeFakeReaper(initialLabels: string[]): FakeReaper {
  const pidFor = new Map<string, number>();
  let nextPid = 9001;
  const pidOf = (label: string): number => {
    let pid = pidFor.get(label);
    if (pid === undefined) {
      pid = nextPid++;
      pidFor.set(label, pid);
    }
    return pid;
  };
  const state = { labels: [...initialLabels], killedPids: [] as number[], listCalls: 0, gcCalls: 0 };
  return {
    listSessions: async (): Promise<ReaperSession[]> => {
      state.listCalls++;
      return state.labels.map((label) => ({ pid: pidOf(label), label }));
    },
    gc: async (): Promise<number> => {
      state.gcCalls++;
      return 0;
    },
    killProcess: (pid: number, signal: NodeJS.Signals | 0): void => {
      // The reaper SIGTERMs first, then probes with signal 0 / escalates to
      // SIGKILL. Our fake processes always exit on SIGTERM: record the kill and
      // drop the session from the live set so a subsequent pass enumerates
      // nothing (mirroring the real Gondolin runner exiting), then the probe
      // ESRCHes.
      if (signal === 'SIGTERM') {
        state.killedPids.push(pid);
        const label = [...pidFor.entries()].find(([, p]) => p === pid)?.[0];
        if (label !== undefined) state.labels = state.labels.filter((l) => l !== label);
        return;
      }
      // signal 0 (alive probe) after the SIGTERM-exit ⇒ ESRCH.
      const err: NodeJS.ErrnoException = new Error('kill ESRCH');
      err.code = 'ESRCH';
      throw err;
    },
    get destroyed() {
      // Map killed pids back to labels for a readable assertion.
      const byPid = new Map<number, string>();
      for (const label of pidFor.keys()) byPid.set(pidOf(label), label);
      return state.killedPids.map((pid) => byPid.get(pid) ?? `pid-${pid}`);
    },
    get listCalls() {
      return state.listCalls;
    },
    get gcCalls() {
      return state.gcCalls;
    },
    setSessions: (labels: string[]) => {
      // Pre-seed pids so a label injected after construction is stable.
      for (const label of labels) pidOf(label);
      state.labels = [...labels];
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
  it('fails startup when the claude credential is missing for a workflow that references claude', async () => {
    // `~/.claude/.credentials.json` is absent (codex is satisfied so the probe
    // gets past it to the claude state). A workflow that pins claude on any
    // state — even just a per-state override — must surface the missing
    // host-credential at startup rather than letting the proxy fail mid-dispatch.
    const fakeHome = await mkdtemp(path.join(os.tmpdir(), 'symphony-startup-home-'));
    const trackerRoot = await mkdtemp(path.join(os.tmpdir(), 'symphony-startup-tracker-'));
    const prevHome = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      await mkdir(path.join(fakeHome, '.codex'), { recursive: true });
      await writeFile(
        path.join(fakeHome, '.codex', 'auth.json'),
        JSON.stringify({ tokens: { access_token: 'codex-oauth-token' } }),
      );
      const { cfg, def } = await buildCfgAndDef(
        {
          acp: { adapter: 'codex' },
          states: {
            Todo: { role: 'active', adapter: 'codex' },
            Review: { role: 'active', adapter: 'claude' },
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
          /claude/.test(err.message) &&
          /credential/.test(err.message),
      );
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      await rm(fakeHome, { recursive: true, force: true });
      await rm(trackerRoot, { recursive: true, force: true });
    }
  });

  it('fails startup when the codex credential is missing for a workflow that references codex', async () => {
    // Empty fake $HOME (no `~/.codex/auth.json`) AND no OPENAI_API_KEY env: a
    // workflow that pins codex anywhere must surface the missing credential at
    // startup, mirroring the claude probe.
    const fakeHome = await mkdtemp(path.join(os.tmpdir(), 'symphony-startup-codex-home-'));
    const trackerRoot = await mkdtemp(path.join(os.tmpdir(), 'symphony-startup-codex-tracker-'));
    const prevHome = process.env.HOME;
    const prevKey = process.env.OPENAI_API_KEY;
    process.env.HOME = fakeHome;
    delete process.env.OPENAI_API_KEY;
    try {
      // claude credential present so the probe gets past claude to codex.
      await mkdir(path.join(fakeHome, '.claude'), { recursive: true });
      await writeFile(path.join(fakeHome, '.claude', '.credentials.json'), '{}');

      const { cfg, def } = await buildCfgAndDef(
        {
          acp: { adapter: 'claude' },
          states: {
            Todo: { role: 'active', adapter: 'codex' },
            Review: { role: 'active', adapter: 'claude' },
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
      if (prevKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prevKey;
      await rm(fakeHome, { recursive: true, force: true });
      await rm(trackerRoot, { recursive: true, force: true });
    }
  });

  it('fails startup when the opencode GitHub Copilot credential is missing', async () => {
    // Empty fake $HOME (no ~/.local/share/opencode/auth.json), no XDG_DATA_HOME,
    // and no COPILOT_GITHUB_TOKEN/GH_TOKEN/GITHUB_TOKEN env: a workflow that pins
    // opencode must surface the missing GitHub Copilot credential at startup.
    const fakeHome = await mkdtemp(path.join(os.tmpdir(), 'symphony-startup-opencode-home-'));
    const trackerRoot = await mkdtemp(path.join(os.tmpdir(), 'symphony-startup-opencode-tracker-'));
    const prevHome = process.env.HOME;
    const prevXdg = process.env.XDG_DATA_HOME;
    const prevTokens = {
      COPILOT_GITHUB_TOKEN: process.env.COPILOT_GITHUB_TOKEN,
      GH_TOKEN: process.env.GH_TOKEN,
      GITHUB_TOKEN: process.env.GITHUB_TOKEN,
    };
    process.env.HOME = fakeHome;
    delete process.env.XDG_DATA_HOME;
    delete process.env.COPILOT_GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    delete process.env.GITHUB_TOKEN;
    try {
      const { cfg, def } = await buildCfgAndDef(
        {
          acp: { adapter: 'opencode' },
          states: {
            Todo: { role: 'active', adapter: 'opencode' },
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
          /opencode/.test(err.message) &&
          /credential/.test(err.message),
      );
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevXdg === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = prevXdg;
      for (const [k, v] of Object.entries(prevTokens)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      await rm(fakeHome, { recursive: true, force: true });
      await rm(trackerRoot, { recursive: true, force: true });
    }
  });

  it('starts cleanly when both adapter credentials are present (codex via auth.json)', async () => {
    // Both adapters referenced; both credentials present. codex is satisfied by
    // a `~/.codex/auth.json` token (no OPENAI_API_KEY env needed).
    const fakeHome = await mkdtemp(path.join(os.tmpdir(), 'symphony-startup-home-ok-'));
    const trackerRoot = await mkdtemp(path.join(os.tmpdir(), 'symphony-startup-tracker-ok-'));
    const prevHome = process.env.HOME;
    const prevKey = process.env.OPENAI_API_KEY;
    process.env.HOME = fakeHome;
    delete process.env.OPENAI_API_KEY;
    try {
      await mkdir(path.join(fakeHome, '.claude'), { recursive: true });
      await writeFile(path.join(fakeHome, '.claude', '.credentials.json'), '{}');
      await mkdir(path.join(fakeHome, '.codex'), { recursive: true });
      await writeFile(
        path.join(fakeHome, '.codex', 'auth.json'),
        JSON.stringify({ tokens: { access_token: 'codex-oauth-token' } }),
      );

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
      if (prevKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prevKey;
      await rm(fakeHome, { recursive: true, force: true });
      await rm(trackerRoot, { recursive: true, force: true });
    }
  });

  it('starts cleanly when codex is satisfied by OPENAI_API_KEY alone (no auth.json)', async () => {
    // No `~/.codex/auth.json` on disk, but OPENAI_API_KEY is exported — the
    // proxy's env fallback covers it, so the startup probe must accept it.
    const fakeHome = await mkdtemp(path.join(os.tmpdir(), 'symphony-startup-home-envkey-'));
    const trackerRoot = await mkdtemp(path.join(os.tmpdir(), 'symphony-startup-tracker-envkey-'));
    const prevHome = process.env.HOME;
    const prevKey = process.env.OPENAI_API_KEY;
    process.env.HOME = fakeHome;
    process.env.OPENAI_API_KEY = 'sk-env-codex';
    try {
      await mkdir(path.join(fakeHome, '.claude'), { recursive: true });
      await writeFile(path.join(fakeHome, '.claude', '.credentials.json'), '{}');

      const { cfg, def } = await buildCfgAndDef(
        {
          acp: { adapter: 'claude' },
          states: {
            Todo: { role: 'active', adapter: 'codex' },
            Review: { role: 'active', adapter: 'claude' },
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
      if (prevKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prevKey;
      await rm(fakeHome, { recursive: true, force: true });
      await rm(trackerRoot, { recursive: true, force: true });
    }
  });

});

// Orphan-VM reaping is the lifecycle counterpart to startup terminal workspace
// cleanup: each per-issue VM is owned by the orchestrator process, but the
// libkrun VM itself outlives a SIGKILL or crash of that process because it is
// daemon-managed. Without the reaping path, every restart leaves the prior
// instance's VMs behind, and over enough restarts the host OOMs (issue 26).
//
// Issue 33 moved the reaping into the reconciler's `vm` resource. The
// orchestrator just wires itself in as the IntendedVmProvider and triggers a
// reap at three points: startup (sweep prior-process strays), shutdown
// (backstop in-flight workers whose cleanup the SIGTERM cancelled), and after
// any non-clean worker exit. These tests pin those orchestrator-level
// integration points; the per-action details (SIGTERM→SIGKILL grace, Gondolin
// session enumeration / gc) are covered in tests/reconciler-vm.test.ts.
describe('Orchestrator VM lifecycle reaping', () => {
  // Helper: build a Reconciler wired to the supplied fake Gondolin reaper
  // surface (listSessions + gc + killProcess). The defaults enumerate no
  // sessions / kill nothing, so the suite stays hermetic — it never touches
  // real Gondolin sessions on a busy developer box.
  function makeReconcilerWith(cfg: ServiceConfig, fake: FakeReaper): Reconciler {
    return new Reconciler(cfg, {
      listSessions: fake.listSessions,
      gc: fake.gc,
      killProcess: fake.killProcess,
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
      // Mix orphan symphony sessions with an unrelated session the operator may
      // have running. Only the symphony-prefixed labels should be reaped.
      const fake = makeFakeReaper([
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
      // No orphans at startup; simulate a session that the runner's per-attempt
      // cleanup didn't reach in time (e.g. SIGTERM mid-attempt) by injecting it
      // into the session view before stop().
      const fake = makeFakeReaper([]);
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
      // Inject a "leaked" session into the Gondolin view to mimic the
      // SIGTERM-mid-run path (a runner child that outlived its dispatch).
      fake.setSessions(['symphony-leaked-7']);
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

  it('kicks the reaper after a clean worker exit so the VM is freed within one tick (issue 52)', async () => {
    // Issue 52: VM teardown is owned solely by the reconciler `vm` resource;
    // the runner no longer destroys VMs directly. To keep latency
    // close to the prior eager path, `onWorkerExit` must kick `reapVms()` on
    // *every* exit, not just non-clean ones. Pre-issue-52 the kick was guarded
    // by `if (!normal)` so a clean exit waited for the 5-minute backstop tick.
    // This test pins the new contract by counting `reapVms()` calls observed
    // by the reconciler stub: a successful `runAttempt` resolution must
    // trigger one kick from `onWorkerExit`.
    const fakeHome = await mkdtemp(path.join(os.tmpdir(), 'symphony-vm-clean-home-'));
    const trackerRoot = await mkdtemp(path.join(os.tmpdir(), 'symphony-vm-clean-tracker-'));
    const prevHome = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      await mkdir(path.join(fakeHome, '.claude'), { recursive: true });
      await writeFile(path.join(fakeHome, '.claude', '.credentials.json'), '{}');

      const { cfg, def } = await buildCfgAndDef(
        {
          acp: { adapter: 'claude' },
          agent: { max_concurrent_agents: 1, memory_admission_enabled: false },
          polling: { interval_ms: 30 },
          states: {
            Todo: { role: 'active', adapter: 'claude' },
            Done: { role: 'terminal' },
            Triage: { role: 'holding' },
          },
        },
        trackerRoot,
      );

      const issue: Issue = {
        id: 'it1',
        identifier: 'it1',
        title: 'issue it1',
        description: null,
        priority: null,
        state: 'Todo',
        branch_name: null,
        url: null,
        labels: [],
        blocked_by: [],
        created_at: null,
        updated_at: null,
      };
      let issues: Issue[] = [issue];
      const tracker: IssueTracker = {
        async fetchCandidateIssues(): Promise<CandidateFetchResult> {
          return { issues: issues.map((i) => ({ ...i })), root: null };
        },
        async fetchIssuesByStates(stateNames: string[]): Promise<Issue[]> {
          const set = new Set(stateNames.map((s) => s.toLowerCase()));
          return issues.filter((i) => set.has(i.state.toLowerCase())).map((i) => ({ ...i }));
        },
        async fetchIssueStatesByIds(ids: string[]): Promise<Issue[]> {
          const set = new Set(ids);
          return issues.filter((i) => set.has(i.id)).map((i) => ({ ...i }));
        },
      };

      // Fake runner: parks `runAttempt` on a promise until the test releases
      // it with a clean result so the orchestrator's worker can be observed
      // mid-flight and then exited deterministically.
      let release: (r: RunAttemptResult) => void = () => undefined;
      let onDispatch: () => void = () => undefined;
      const runner = {
        vmNameFor: (i: Issue) => `symphony-${i.identifier}`,
        async runAttempt(): Promise<RunAttemptResult> {
          onDispatch();
          return new Promise<RunAttemptResult>((r) => {
            release = r;
          });
        },
      } as unknown as AgentRunner;

      const fake = makeFakeReaper([]);
      const reconciler = makeReconcilerWith(cfg, fake);
      // Spy on reapVms. The orchestrator calls it at startup (initial sweep)
      // and after every worker exit. We only care about post-exit calls, so
      // we snapshot the count at the moment `release` resolves.
      let reapCalls = 0;
      const realReap = reconciler.reapVms.bind(reconciler);
      reconciler.reapVms = async () => {
        reapCalls++;
        return realReap();
      };
      const fakeWorkspaces = {
        workspacePathFor(identifier: string): string {
          return `/tmp/symphony-vm-clean-ws/${identifier}`;
        },
        async ensureFor() {
          return { path: '/tmp/ignored', workspace_key: 'it1', created_now: true };
        },
        async remove(): Promise<void> {
          /* no-op */
        },
      } as unknown as WorkspaceManager;
      const orch = new Orchestrator(
        cfg,
        def,
        { onChange: () => () => undefined, current: () => ({} as any), stop: async () => undefined } as unknown as WorkflowSource,
        tracker,
        fakeWorkspaces,
        runner,
        undefined,
        reconciler,
      );
      reconciler.setIntendedVmProvider(orch);
      const dispatched = new Promise<void>((resolve) => {
        onDispatch = () => resolve();
      });
      await orch.start();
      await dispatched;
      const preExitCalls = reapCalls;

      // Take the issue off the tracker so the orchestrator's next poll tick
      // doesn't immediately re-dispatch (the test only cares about the
      // clean-exit kick, not retry semantics). Then release with a clean
      // result — this is the path the pre-52 code did NOT kick the reaper on.
      issues = [{ ...issue, state: 'Done' }];
      release({ ok: true, reason: 'done', threadId: null, turnsCompleted: 1 });

      // The kick happens synchronously inside onWorkerExit (it's
      // fire-and-forget but the .reapVms invocation itself is sync). Poll
      // briefly for the post-exit count to bump above the snapshot.
      const deadline = Date.now() + 2_000;
      while (reapCalls <= preExitCalls && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 10));
      }
      assert.ok(
        reapCalls > preExitCalls,
        `reapVms should fire on clean exit; saw ${preExitCalls} before, ${reapCalls} after`,
      );

      await orch.stop();
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      await rm(fakeHome, { recursive: true, force: true });
      await rm(trackerRoot, { recursive: true, force: true });
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

describe('Orchestrator circuit breaker (issue 128)', () => {
  it('routes an issue to a holding state after K consecutive identical failures and stops retrying', async () => {
    const fakeHome = await mkdtemp(path.join(os.tmpdir(), 'symphony-cb-home-'));
    const trackerRoot = await mkdtemp(path.join(os.tmpdir(), 'symphony-cb-tracker-'));
    const logsRoot = await mkdtemp(path.join(os.tmpdir(), 'symphony-cb-logs-'));
    const prevHome = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      await mkdir(path.join(fakeHome, '.claude'), { recursive: true });
      await writeFile(path.join(fakeHome, '.claude', '.credentials.json'), '{}');

      const { cfg, def } = await buildCfgAndDef(
        {
          acp: { adapter: 'claude' },
          agent: {
            max_concurrent_agents: 1,
            memory_admission_enabled: false,
            circuit_breaker_threshold: 3,
            // Fail-retry backoff is min(10000 * 2^(n-1), maxBackoff); a tiny cap
            // makes the retries fire ~immediately so the loop reaches the
            // threshold within the test's time budget.
            max_retry_backoff_ms: 5,
          },
          polling: { interval_ms: 20 },
          logs: { root: logsRoot },
          states: {
            Todo: { role: 'active', adapter: 'claude' },
            Done: { role: 'terminal' },
            Triage: { role: 'holding' },
          },
        },
        trackerRoot,
      );

      // Active-state-filtered fake tracker. `moveIssueToState` mutates the
      // in-memory state so a moved (holding) issue stops being a candidate,
      // mirroring the local tracker — this is what makes the trip restart-safe.
      let current: Issue = {
        id: 'cb1', identifier: 'cb1', title: 'cb', description: null, priority: null,
        state: 'Todo', branch_name: null, url: null, labels: [], blocked_by: [],
        created_at: null, updated_at: null,
      };
      const moves: Array<{ toState: string; fromState?: string; notes?: string }> = [];
      const tracker: IssueTracker = {
        async fetchCandidateIssues(): Promise<CandidateFetchResult> {
          const issues = current.state.toLowerCase() === 'todo' ? [{ ...current }] : [];
          return { issues, root: trackerRoot };
        },
        async fetchIssuesByStates(names: string[]): Promise<Issue[]> {
          const set = new Set(names.map((s) => s.toLowerCase()));
          return set.has(current.state.toLowerCase()) ? [{ ...current }] : [];
        },
        async fetchIssueStatesByIds(ids: string[]): Promise<Issue[]> {
          return ids.includes(current.id) ? [{ ...current }] : [];
        },
        currentRoot(): string | null {
          return trackerRoot;
        },
        async moveIssueToState(issueId, toState, opts) {
          moves.push({ toState, fromState: opts?.fromState, notes: opts?.notes });
          const fromState = current.state;
          current = { ...current, state: toState };
          return { fromState, toState, newPath: path.join(trackerRoot, toState, `${issueId}.md`) };
        },
      };

      let dispatchCount = 0;
      const runner = {
        vmNameFor: (i: Issue) => `symphony-${i.identifier}`,
        async runAttempt(): Promise<RunAttemptResult> {
          dispatchCount++;
          // Same failure class every attempt, but with a varying request id to
          // prove normalization collapses the volatile token — the breaker must
          // still treat these as identical and accumulate toward the trip.
          return {
            ok: false,
            reason: `agent turn refusal: 401 invalid_api_key (req_${dispatchCount}abc)`,
            threadId: null,
            turnsCompleted: 0,
          };
        },
      } as unknown as AgentRunner;

      const fakeWorkspaces = {
        workspacePathFor: (identifier: string) => path.join(trackerRoot, 'ws', identifier),
        async ensureFor() {
          return { path: path.join(trackerRoot, 'ws'), workspace_key: 'cb1', created_now: true };
        },
        async remove(): Promise<void> {
          /* no-op */
        },
      } as unknown as WorkspaceManager;

      const orch = new Orchestrator(
        cfg,
        def,
        { onChange: () => () => undefined, current: () => ({} as any), stop: async () => undefined } as unknown as WorkflowSource,
        tracker,
        fakeWorkspaces,
        runner,
      );
      await orch.start();

      // Wait for the breaker to trip (the single move into the holding state).
      const deadline = Date.now() + 3_000;
      while (moves.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 10));
      }
      assert.equal(moves.length, 1, 'breaker should route the issue exactly once');
      assert.equal(moves[0]!.toState, 'Triage');
      assert.equal(moves[0]!.fromState, 'Todo');
      assert.match(moves[0]!.notes ?? '', /Circuit breaker tripped/);
      assert.match(moves[0]!.notes ?? '', /3 consecutive attempts/);
      assert.equal(
        dispatchCount,
        3,
        `breaker should trip on the 3rd identical failure; saw ${dispatchCount} dispatches`,
      );
      assert.equal(current.state, 'Triage', 'issue should now live in the holding state');

      // No further dispatches after the trip — give the loop time to misbehave.
      await new Promise((r) => setTimeout(r, 200));
      assert.equal(dispatchCount, 3, 'no dispatch should occur after the breaker trips');

      await orch.stop();
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      await rm(fakeHome, { recursive: true, force: true });
      await rm(trackerRoot, { recursive: true, force: true });
      await rm(logsRoot, { recursive: true, force: true });
    }
  });

  it('still trips when the failure reason differs each attempt (issue 135: count by streak, not reason)', async () => {
    const fakeHome = await mkdtemp(path.join(os.tmpdir(), 'symphony-cb2-home-'));
    const trackerRoot = await mkdtemp(path.join(os.tmpdir(), 'symphony-cb2-tracker-'));
    const logsRoot = await mkdtemp(path.join(os.tmpdir(), 'symphony-cb2-logs-'));
    const prevHome = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      await mkdir(path.join(fakeHome, '.claude'), { recursive: true });
      await writeFile(path.join(fakeHome, '.claude', '.credentials.json'), '{}');

      const { cfg, def } = await buildCfgAndDef(
        {
          acp: { adapter: 'claude' },
          agent: {
            max_concurrent_agents: 1,
            memory_admission_enabled: false,
            circuit_breaker_threshold: 3,
            max_retry_backoff_ms: 5,
          },
          polling: { interval_ms: 20 },
          logs: { root: logsRoot },
          states: {
            Todo: { role: 'active', adapter: 'claude' },
            Done: { role: 'terminal' },
            Triage: { role: 'holding' },
          },
        },
        trackerRoot,
      );

      const current: Issue = {
        id: 'cb2', identifier: 'cb2', title: 'cb2', description: null, priority: null,
        state: 'Todo', branch_name: null, url: null, labels: [], blocked_by: [],
        created_at: null, updated_at: null,
      };
      const moves: Array<{ toState: string; notes?: string }> = [];
      const tracker: IssueTracker = {
        async fetchCandidateIssues(): Promise<CandidateFetchResult> {
          // Filter by state so a tripped (Triage) issue stops being a candidate,
          // mirroring the real tracker — this is what makes the trip restart-safe
          // (and keeps the loop from re-dispatching a routed issue forever).
          const issues = current.state.toLowerCase() === 'todo' ? [{ ...current }] : [];
          return { issues, root: trackerRoot };
        },
        async fetchIssuesByStates(names: string[]): Promise<Issue[]> {
          const set = new Set(names.map((s) => s.toLowerCase()));
          return set.has(current.state.toLowerCase()) ? [{ ...current }] : [];
        },
        async fetchIssueStatesByIds(ids: string[]): Promise<Issue[]> {
          return ids.includes(current.id) ? [{ ...current }] : [];
        },
        currentRoot(): string | null {
          return trackerRoot;
        },
        async moveIssueToState(issueId, toState, opts) {
          moves.push({ toState, notes: opts?.notes });
          current.state = toState;
          return { fromState: 'Todo', toState, newPath: path.join(trackerRoot, toState, `${issueId}.md`) };
        },
      };

      let dispatchCount = 0;
      const runner = {
        vmNameFor: (i: Issue) => `symphony-${i.identifier}`,
        async runAttempt(): Promise<RunAttemptResult> {
          dispatchCount++;
          // A DIFFERENT failure class each attempt — exactly the flapping that let
          // issue 135 dodge the old same-reason breaker. Post-fix the breaker counts
          // consecutive failures regardless of reason, so it must still trip.
          const reasons = [
            'gondolin bring-up error',
            'before_run hook error',
            'acp bridge register failed',
            'workspace error',
            'identity staging error',
          ];
          return {
            ok: false,
            reason: reasons[dispatchCount % reasons.length]!,
            threadId: null,
            turnsCompleted: 0,
          };
        },
      } as unknown as AgentRunner;

      const fakeWorkspaces = {
        workspacePathFor: (identifier: string) => path.join(trackerRoot, 'ws', identifier),
        async ensureFor() {
          return { path: path.join(trackerRoot, 'ws'), workspace_key: 'cb2', created_now: true };
        },
        async remove(): Promise<void> {
          /* no-op */
        },
      } as unknown as WorkspaceManager;

      const orch = new Orchestrator(
        cfg,
        def,
        { onChange: () => () => undefined, current: () => ({} as any), stop: async () => undefined } as unknown as WorkflowSource,
        tracker,
        fakeWorkspaces,
        runner,
      );
      await orch.start();

      // Pre-issue-135 the distinct reasons reset the streak and the breaker never
      // tripped (infinite loop). Now it counts consecutive failures regardless of
      // reason, so it must route the issue exactly once on the 3rd failure.
      const deadline = Date.now() + 3_000;
      while (moves.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 10));
      }
      assert.equal(moves.length, 1, 'breaker should route the issue once despite flapping reasons');
      assert.equal(moves[0]!.toState, 'Triage');
      assert.match(moves[0]!.notes ?? '', /Circuit breaker tripped/);
      assert.match(moves[0]!.notes ?? '', /3 consecutive attempts/);
      assert.equal(dispatchCount, 3, `breaker should trip on the 3rd consecutive failure; saw ${dispatchCount}`);

      // No further dispatches after the trip — give the loop time to misbehave.
      await new Promise((r) => setTimeout(r, 200));
      assert.equal(dispatchCount, 3, 'no dispatch should occur after the breaker trips');

      await orch.stop();
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      await rm(fakeHome, { recursive: true, force: true });
      await rm(trackerRoot, { recursive: true, force: true });
      await rm(logsRoot, { recursive: true, force: true });
    }
  });
});

describe('Orchestrator sleep-cycle auto-arm (issue 125)', () => {
  it('arms the reflection issue Dormant -> Reflect after N terminal transitions', async () => {
    const fakeHome = await mkdtemp(path.join(os.tmpdir(), 'symphony-sc-home-'));
    const trackerRoot = await mkdtemp(path.join(os.tmpdir(), 'symphony-sc-tracker-'));
    const logsRoot = await mkdtemp(path.join(os.tmpdir(), 'symphony-sc-logs-'));
    const prevHome = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      await mkdir(path.join(fakeHome, '.claude'), { recursive: true });
      await writeFile(path.join(fakeHome, '.claude', '.credentials.json'), '{}');

      const { cfg, def } = await buildCfgAndDef(
        {
          acp: { adapter: 'claude' },
          agent: {
            max_concurrent_agents: 1,
            memory_admission_enabled: false,
            circuit_breaker_threshold: 0,
            max_retry_backoff_ms: 5,
          },
          polling: { interval_ms: 20 },
          logs: { root: logsRoot },
          sleep_cycle: {
            enabled: true,
            issue_id: 'sleep-cycle',
            dormant_state: 'Dormant',
            reflect_state: 'Reflect',
            arm_on_idle: true,
            arm_after_done: 2,
          },
          states: {
            Todo: { role: 'active', adapter: 'claude' },
            Reflect: { role: 'active', adapter: 'claude' },
            Done: { role: 'terminal' },
            Triage: { role: 'holding' },
            Dormant: { role: 'holding' },
          },
        },
        trackerRoot,
      );

      // In-memory tracker: two Todo issues that finish into Done, plus the
      // recurring reflection issue resting in Dormant.
      const byId = new Map<string, Issue>([
        ['a', mk('a', 'Todo')],
        ['b', mk('b', 'Todo')],
        ['sleep-cycle', mk('sleep-cycle', 'Dormant')],
      ]);
      function mk(id: string, state: string): Issue {
        return {
          id, identifier: id, title: id, description: null, priority: null,
          state, branch_name: null, url: null, labels: [], blocked_by: [],
          created_at: null, updated_at: null,
        };
      }
      const active = new Set(['todo', 'reflect']);
      const moves: Array<{ id: string; toState: string; fromState?: string; notes?: string }> = [];
      const tracker: IssueTracker = {
        async fetchCandidateIssues(): Promise<CandidateFetchResult> {
          const issues = [...byId.values()]
            .filter((i) => active.has(i.state.toLowerCase()))
            .map((i) => ({ ...i }));
          return { issues, root: trackerRoot };
        },
        async fetchIssuesByStates(names: string[]): Promise<Issue[]> {
          const want = new Set(names.map((s) => s.toLowerCase()));
          return [...byId.values()].filter((i) => want.has(i.state.toLowerCase())).map((i) => ({ ...i }));
        },
        async fetchIssueStatesByIds(ids: string[]): Promise<Issue[]> {
          return ids.map((id) => byId.get(id)).filter((i): i is Issue => !!i).map((i) => ({ ...i }));
        },
        currentRoot(): string | null {
          return trackerRoot;
        },
        async moveIssueToState(issueId, toState, opts) {
          const cur = byId.get(issueId);
          const fromState = cur?.state;
          moves.push({ id: issueId, toState, fromState: opts?.fromState, notes: opts?.notes });
          if (cur) byId.set(issueId, { ...cur, state: toState });
          return { fromState: fromState ?? '?', toState, newPath: path.join(trackerRoot, toState, `${issueId}.md`) };
        },
      };

      // The runner stands in for the in-VM agent + MCP transition tool: it moves
      // the issue's tracker file and records the transition on the entry. A Todo
      // issue finishes into Done (terminal); the reflection issue, once armed,
      // returns to Dormant (holding, non-terminal — must NOT count toward arming).
      const runner = {
        vmNameFor: (i: Issue) => `symphony-${i.identifier}`,
        async runAttempt(issue: Issue, _attempt: unknown, _cancel: unknown, entry: any): Promise<RunAttemptResult> {
          const to = issue.state.toLowerCase() === 'reflect' ? 'Dormant' : 'Done';
          await tracker.moveIssueToState!(issue.id, to, { fromState: issue.state });
          entry.last_transition = {
            from_state: issue.state, to_state: to, notes: '', actor: null, terminal: to === 'Done',
          };
          entry.transitioned = true;
          return { ok: true, reason: 'transitioned', threadId: null, turnsCompleted: 1 };
        },
      } as unknown as AgentRunner;

      const fakeWorkspaces = {
        workspacePathFor: (identifier: string) => path.join(trackerRoot, 'ws', identifier),
        async ensureFor() {
          return { path: path.join(trackerRoot, 'ws'), workspace_key: 'sc', created_now: true };
        },
        async remove(): Promise<void> {
          /* no-op */
        },
      } as unknown as WorkspaceManager;

      const orch = new Orchestrator(
        cfg,
        def,
        { onChange: () => () => undefined, current: () => ({} as any), stop: async () => undefined } as unknown as WorkflowSource,
        tracker,
        fakeWorkspaces,
        runner,
      );
      await orch.start();

      // Wait for the orchestrator to auto-arm the reflection issue.
      const deadline = Date.now() + 8_000;
      const armed = () => moves.find((m) => m.id === 'sleep-cycle' && m.toState === 'Reflect');
      while (!armed() && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 10));
      }
      const arm = armed();
      assert.ok(arm, 'reflection issue should be auto-armed into Reflect');
      assert.equal(arm!.fromState, 'Dormant', 'arm must move it out of Dormant');
      assert.match(arm!.notes ?? '', /Auto-armed by the sleep cycle/);
      assert.match(arm!.notes ?? '', /Triage/);
      // Both Todo issues must have reached Done before the threshold tripped.
      assert.ok(
        moves.filter((m) => m.toState === 'Done').length >= 2,
        'two terminal transitions should precede the arm',
      );

      // Let the loop settle: the reflection run returns to Dormant and, with the
      // counter reset to 0, idle must NOT re-arm it (no spin).
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(
        moves.filter((m) => m.id === 'sleep-cycle' && m.toState === 'Reflect').length,
        1,
        'reflection should be armed exactly once (counter reset prevents re-arm)',
      );

      await orch.stop();
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      await rm(fakeHome, { recursive: true, force: true });
      await rm(trackerRoot, { recursive: true, force: true });
      await rm(logsRoot, { recursive: true, force: true });
    }
  });
});

describe('Orchestrator per-state concurrency caps (issue 137)', () => {
  function todoIssue(id: string, state = 'Todo'): Issue {
    return {
      id,
      identifier: id,
      title: `issue ${id}`,
      description: null,
      priority: null,
      state,
      branch_name: null,
      url: null,
      labels: [],
      blocked_by: [],
      created_at: null,
      updated_at: null,
    };
  }

  // Run the dispatch loop against `rawConfig` + `issues`, parking every
  // runAttempt so dispatched issues stay in the running set and continue to
  // occupy both their per-state and the global slot. Returns the set of distinct
  // issue ids that were dispatched once the loop has had several ticks to
  // settle. Uses the static concurrency cap (`memory_admission_enabled: false`)
  // so the count is deterministic regardless of host memory.
  async function dispatchedIds(
    rawConfig: Record<string, unknown>,
    issues: Issue[],
  ): Promise<Set<string>> {
    const fakeHome = await mkdtemp(path.join(os.tmpdir(), 'symphony-conc-home-'));
    const trackerRoot = await mkdtemp(path.join(os.tmpdir(), 'symphony-conc-tracker-'));
    const prevHome = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      await mkdir(path.join(fakeHome, '.claude'), { recursive: true });
      await writeFile(path.join(fakeHome, '.claude', '.credentials.json'), '{}');
      const { cfg, def } = await buildCfgAndDef(rawConfig, trackerRoot);

      const tracker: IssueTracker = {
        async fetchCandidateIssues(): Promise<CandidateFetchResult> {
          return { issues: issues.map((i) => ({ ...i })), root: trackerRoot };
        },
        async fetchIssuesByStates(names: string[]): Promise<Issue[]> {
          const set = new Set(names.map((s) => s.toLowerCase()));
          return issues.filter((i) => set.has(i.state.toLowerCase())).map((i) => ({ ...i }));
        },
        async fetchIssueStatesByIds(ids: string[]): Promise<Issue[]> {
          const set = new Set(ids);
          return issues.filter((i) => set.has(i.id)).map((i) => ({ ...i }));
        },
        currentRoot(): string | null {
          return trackerRoot;
        },
      };

      const dispatched = new Set<string>();
      const runner = {
        vmNameFor: (i: Issue) => `symphony-${i.identifier}`,
        async runAttempt(issue: Issue): Promise<RunAttemptResult> {
          dispatched.add(issue.id);
          // Park forever so the issue keeps occupying a slot; stop() signals
          // cancel and clears the running set without awaiting the worker.
          return new Promise<RunAttemptResult>(() => undefined);
        },
      } as unknown as AgentRunner;

      const fakeWorkspaces = {
        workspacePathFor: (identifier: string) => path.join(trackerRoot, 'ws', identifier),
        async ensureFor() {
          return { path: path.join(trackerRoot, 'ws'), workspace_key: 'k', created_now: true };
        },
        async remove(): Promise<void> {
          /* no-op */
        },
      } as unknown as WorkspaceManager;

      const orch = new Orchestrator(
        cfg,
        def,
        { onChange: () => () => undefined, current: () => ({} as any), stop: async () => undefined } as unknown as WorkflowSource,
        tracker,
        fakeWorkspaces,
        runner,
      );
      await orch.start();
      // Several poll ticks (interval 20ms) so any under-cap dispatch has every
      // chance to fire; the parked runAttempts keep the running set occupied.
      await new Promise((r) => setTimeout(r, 250));
      await orch.stop();
      return dispatched;
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      await rm(fakeHome, { recursive: true, force: true });
      await rm(trackerRoot, { recursive: true, force: true });
    }
  }

  it('caps a state to its max_concurrent even when the global ceiling has room', async () => {
    // Global ceiling 4 (plenty of room), but Todo is capped at 1. Three Todo
    // issues compete; only one runs because the per-state cap binds first.
    const dispatched = await dispatchedIds(
      {
        acp: { adapter: 'claude' },
        agent: { max_concurrent_agents: 4, memory_admission_enabled: false },
        polling: { interval_ms: 20 },
        states: {
          Todo: { role: 'active', adapter: 'claude', max_concurrent: 1 },
          Done: { role: 'terminal' },
          Triage: { role: 'holding' },
        },
      },
      [todoIssue('c1'), todoIssue('c2'), todoIssue('c3')],
    );
    assert.equal(dispatched.size, 1, `Todo.max_concurrent=1 should run exactly one; ran ${dispatched.size}`);
  });

  it('still lets the global ceiling bind across states (incl. an uncapped state)', async () => {
    // Global ceiling 1. Todo is capped at 1; Review declares no per-state cap.
    // One issue of each: the global ceiling permits only one running agent total,
    // so the second issue stays blocked even though its (uncapped) state has room.
    const dispatched = await dispatchedIds(
      {
        acp: { adapter: 'claude' },
        agent: { max_concurrent_agents: 1, memory_admission_enabled: false },
        polling: { interval_ms: 20 },
        states: {
          Todo: { role: 'active', adapter: 'claude', max_concurrent: 1 },
          Review: { role: 'active', adapter: 'claude' },
          Done: { role: 'terminal' },
          Triage: { role: 'holding' },
        },
      },
      // 'a-todo' sorts before 'b-review', so Todo dispatches first and the
      // uncapped Review issue is the one the global ceiling blocks.
      [todoIssue('a-todo', 'Todo'), todoIssue('b-review', 'Review')],
    );
    assert.equal(dispatched.size, 1, `global ceiling 1 should run exactly one; ran ${dispatched.size}`);
  });

  it('honors the deprecated agent.max_concurrent_agents_by_state map at dispatch', async () => {
    // The legacy by-state map is folded into the per-state cap at parse time, so
    // a workflow that hasn't migrated still gets its Todo cap enforced: global
    // room for 4, but the legacy Todo:1 cap runs only one of three.
    const dispatched = await dispatchedIds(
      {
        acp: { adapter: 'claude' },
        agent: {
          max_concurrent_agents: 4,
          memory_admission_enabled: false,
          max_concurrent_agents_by_state: { Todo: 1 },
        },
        polling: { interval_ms: 20 },
        states: {
          Todo: { role: 'active', adapter: 'claude' },
          Done: { role: 'terminal' },
          Triage: { role: 'holding' },
        },
      },
      [todoIssue('d1'), todoIssue('d2'), todoIssue('d3')],
    );
    assert.equal(dispatched.size, 1, `legacy by-state Todo:1 should run exactly one; ran ${dispatched.size}`);
  });
});
