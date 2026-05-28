import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Orchestrator } from '../src/orchestrator.js';
import { buildServiceConfig } from '../src/workflow.js';
import type {
  ServiceConfig,
  WorkflowDefinition,
  Issue,
  RunningEntry,
} from '../src/types.js';
import type { WorkflowSource } from '../src/workflow.js';
import type {
  IssueTracker,
  CandidateFetchResult,
} from '../src/trackers/types.js';
import type { WorkspaceManager } from '../src/workspace.js';
import type { AgentRunner, RunAttemptResult } from '../src/agent/runner.js';

// Issue 25: runs must serialise across active states. When an issue normal-exits
// after a transition (Todo → Review) the orchestrator schedules a 1s continuation
// retry. Before the fix, a tick that fired inside that 1s window could pick up a
// brand-new Todo and consume the global slot — leaving the just-transitioned
// issue requeued with "no available orchestrator slots". The fix counts pending
// continuations against the slot budget so the resuming worker is guaranteed a
// slot when its timer fires.

function makeIssue(id: string, state: string): Issue {
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

interface FakeTracker extends IssueTracker {
  setIssues(issues: Issue[]): void;
}

function makeFakeTracker(): FakeTracker {
  let store: Issue[] = [];
  return {
    setIssues(issues) {
      store = issues.map((i) => ({ ...i }));
    },
    async fetchCandidateIssues(): Promise<CandidateFetchResult> {
      // Mirror LocalMarkdownTracker: only active-state issues are surfaced as
      // candidates. The orchestrator computes its own active-set filter against
      // the issues we return; returning everything is fine.
      return { issues: store.map((i) => ({ ...i })), root: null };
    },
    async fetchIssuesByStates(stateNames: string[]): Promise<Issue[]> {
      const lower = new Set(stateNames.map((s) => s.toLowerCase()));
      return store
        .filter((i) => lower.has(i.state.toLowerCase()))
        .map((i) => ({ ...i }));
    },
    async fetchIssueStatesByIds(ids: string[]): Promise<Issue[]> {
      const set = new Set(ids);
      return store.filter((i) => set.has(i.id)).map((i) => ({ ...i }));
    },
  };
}

type RunBehaviour = (
  issue: Issue,
  entry: RunningEntry,
) => RunAttemptResult | Promise<RunAttemptResult>;

interface FakeRunner {
  runner: AgentRunner;
  calls: Array<{ issue_id: string; state: string }>;
  /** Hand control to the runner for the next dispatch; resolves with the chosen behaviour. */
  setBehaviour(behaviour: RunBehaviour): void;
}

function makeFakeRunner(): FakeRunner {
  let behaviour: RunBehaviour | null = null;
  const calls: FakeRunner['calls'] = [];
  const runner = {
    async runAttempt(
      issue: Issue,
      _attempt: number | null,
      _cancel: { cancelled: boolean },
      entry: RunningEntry,
    ): Promise<RunAttemptResult> {
      calls.push({ issue_id: issue.id, state: issue.state });
      if (!behaviour) {
        return { ok: false, reason: 'no behaviour set', threadId: null, turnsCompleted: 0 };
      }
      return await behaviour(issue, entry);
    },
  } as unknown as AgentRunner;
  return {
    runner,
    calls,
    setBehaviour(b) {
      behaviour = b;
    },
  };
}

function makeFakeWorkspaces(): WorkspaceManager {
  return {
    workspacePathFor(identifier: string): string {
      return `/tmp/symphony-test-ws/${identifier}`;
    },
    async remove(): Promise<void> {
      // no-op
    },
  } as unknown as WorkspaceManager;
}

async function stageCreds(fakeHome: string): Promise<void> {
  await mkdir(path.join(fakeHome, '.claude'), { recursive: true });
  await writeFile(path.join(fakeHome, '.claude', '.credentials.json'), '{}');
  await mkdir(path.join(fakeHome, '.codex'), { recursive: true });
  // A real token so the codex startup probe (#120) passes: an empty `{}`
  // yields no token and the proxy would 503, so the probe rejects it too.
  await writeFile(
    path.join(fakeHome, '.codex', 'auth.json'),
    JSON.stringify({ tokens: { access_token: 'codex-oauth-token' } }),
  );
}

async function buildCfg(
  raw: Record<string, unknown>,
  trackerRoot: string,
): Promise<{ cfg: ServiceConfig; def: WorkflowDefinition }> {
  const merged = {
    ...raw,
    tracker: {
      kind: 'local',
      root: trackerRoot,
      ...(raw.tracker as object ?? {}),
    },
  };
  const cfg = buildServiceConfig(merged, path.join(trackerRoot, 'WORKFLOW.md'));
  const def: WorkflowDefinition = { config: merged, prompt_template: '' };
  return { cfg, def };
}

function noopWorkflowSrc(): WorkflowSource {
  return {
    onChange: () => () => undefined,
    current: () => ({} as any),
    stop: async () => undefined,
  } as unknown as WorkflowSource;
}

describe('Orchestrator serialises runs across active states (issue 25)', () => {
  it('holds the slot for a pending continuation; tick does not dispatch a different Todo', async () => {
    const fakeHome = await mkdtemp(path.join(os.tmpdir(), 'symphony-serialise-home-'));
    const trackerRoot = await mkdtemp(path.join(os.tmpdir(), 'symphony-serialise-tracker-'));
    const prevHome = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      await stageCreds(fakeHome);
      const { cfg, def } = await buildCfg(
        {
          acp: { adapter: 'claude' },
          // Disable memory admission so the test isn't sensitive to the CI runner's
          // free memory — the continuation-slot behavior under test has nothing to
          // do with issue 27's clamp.
          agent: { max_concurrent_agents: 1, memory_admission_enabled: false },
          polling: { interval_ms: 50 },
          states: {
            Todo: { role: 'active', adapter: 'claude' },
            Review: { role: 'active', adapter: 'codex' },
            Done: { role: 'terminal' },
            Triage: { role: 'holding' },
          },
        },
        trackerRoot,
      );

      const tracker = makeFakeTracker();
      const issue1 = makeIssue('1', 'Todo');
      const issue2 = makeIssue('2', 'Todo');
      tracker.setIssues([issue1, issue2]);

      const fakeRunner = makeFakeRunner();
      // Gate dispatch: the runner blocks until the test releases it, mirroring
      // a real worker run we can poke at deterministic moments.
      let release: (result: RunAttemptResult) => void = () => undefined;
      let onDispatch: (issue: Issue, entry: RunningEntry) => void = () => undefined;
      fakeRunner.setBehaviour((issue, entry) => {
        onDispatch(issue, entry);
        return new Promise<RunAttemptResult>((resolve) => {
          release = resolve;
        });
      });

      const orch = new Orchestrator(
        cfg,
        def,
        noopWorkflowSrc(),
        tracker,
        makeFakeWorkspaces(),
        fakeRunner.runner,
      );
      await orch.start();

      // Wait for the orchestrator to pick up issue 1.
      const firstDispatch = await new Promise<{ issue: Issue; entry: RunningEntry }>(
        (resolve) => {
          onDispatch = (issue, entry) => resolve({ issue, entry });
        },
      );
      assert.equal(firstDispatch.issue.id, '1');
      assert.equal(firstDispatch.issue.state, 'Todo');
      assert.equal(fakeRunner.calls.length, 1);

      // Simulate the MCP transition: move issue 1 to Review, mutate the in-memory
      // entry to match (this is what McpRegistry.performTransition does on a real
      // transition), then resolve the worker's runAttempt as a normal exit.
      tracker.setIssues([{ ...issue1, state: 'Review' }, issue2]);
      firstDispatch.entry.issue.state = 'Review';
      firstDispatch.entry.transitioned = true;
      release({ ok: true, reason: 'transitioned', threadId: null, turnsCompleted: 1 });

      // Within the 1s continuation window, a tick (we have polling.interval_ms=50)
      // must NOT pick up issue 2. Wait long enough for several ticks to fire.
      await delay(400);
      assert.equal(
        fakeRunner.calls.length,
        1,
        `expected no further dispatch during the continuation window, saw: ${JSON.stringify(fakeRunner.calls)}`,
      );

      // The snapshot exposes the queued continuation; verify it is sitting in
      // retrying with no error (the failure-shaped re-queue would have error set).
      const snap = orch.snapshot();
      assert.equal(snap.counts.running, 0);
      assert.equal(snap.counts.retrying, 1);
      assert.equal(snap.retrying[0]!.issue_id, '1');
      assert.equal(snap.retrying[0]!.error, null);

      // Once the continuation timer fires (~1s after the normal exit), issue 1
      // should be redispatched in Review.
      const secondDispatch = await new Promise<{ issue: Issue; entry: RunningEntry }>(
        (resolve) => {
          onDispatch = (issue, entry) => resolve({ issue, entry });
        },
      );
      assert.equal(secondDispatch.issue.id, '1');
      assert.equal(secondDispatch.issue.state, 'Review');
      // Issue 2 still hasn't been picked up.
      const idsDispatched = fakeRunner.calls.map((c) => c.issue_id);
      assert.deepEqual(idsDispatched, ['1', '1']);

      await orch.stop();
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      await rm(fakeHome, { recursive: true, force: true });
      await rm(trackerRoot, { recursive: true, force: true });
    }
  });

  it('failure-backoff retries do NOT hold a slot; another candidate can run during the wait', async () => {
    const fakeHome = await mkdtemp(path.join(os.tmpdir(), 'symphony-serialise-home-'));
    const trackerRoot = await mkdtemp(path.join(os.tmpdir(), 'symphony-serialise-tracker-'));
    const prevHome = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      await stageCreds(fakeHome);
      const { cfg, def } = await buildCfg(
        {
          acp: { adapter: 'claude' },
          agent: { max_concurrent_agents: 1, memory_admission_enabled: false },
          polling: { interval_ms: 30 },
          states: {
            Todo: { role: 'active', adapter: 'claude' },
            Review: { role: 'active', adapter: 'codex' },
            Done: { role: 'terminal' },
            Triage: { role: 'holding' },
          },
        },
        trackerRoot,
      );

      const tracker = makeFakeTracker();
      const issue1 = makeIssue('1', 'Todo');
      const issue2 = makeIssue('2', 'Todo');
      tracker.setIssues([issue1, issue2]);

      const fakeRunner = makeFakeRunner();
      let release: (result: RunAttemptResult) => void = () => undefined;
      let onDispatch: (issue: Issue, entry: RunningEntry) => void = () => undefined;
      fakeRunner.setBehaviour((issue, entry) => {
        onDispatch(issue, entry);
        return new Promise<RunAttemptResult>((resolve) => {
          release = resolve;
        });
      });

      const orch = new Orchestrator(
        cfg,
        def,
        noopWorkflowSrc(),
        tracker,
        makeFakeWorkspaces(),
        fakeRunner.runner,
      );
      await orch.start();

      const first = await new Promise<{ issue: Issue; entry: RunningEntry }>(
        (resolve) => {
          onDispatch = (issue, entry) => resolve({ issue, entry });
        },
      );
      assert.equal(first.issue.id, '1');

      // Abnormal exit: failure retry should NOT hold the slot, so the next
      // tick is free to dispatch issue 2 even though issue 1 is queued for
      // a 10s exponential-backoff retry.
      release({ ok: false, reason: 'simulated crash', threadId: null, turnsCompleted: 0 });

      const second = await new Promise<{ issue: Issue; entry: RunningEntry }>(
        (resolve) => {
          onDispatch = (issue, entry) => resolve({ issue, entry });
        },
      );
      assert.equal(second.issue.id, '2');

      // Snapshot: issue 1 is in retrying with the failure error set; issue 2 is
      // running. This is the pre-fix behaviour for failure retries and should
      // be preserved.
      const snap = orch.snapshot();
      assert.equal(snap.counts.running, 1);
      assert.equal(snap.counts.retrying, 1);
      assert.equal(snap.running[0]!.issue_id, '2');
      assert.equal(snap.retrying[0]!.issue_id, '1');
      assert.equal(snap.retrying[0]!.error, 'simulated crash');

      // Drain issue 2 so the test exits cleanly.
      release({ ok: true, reason: 'done', threadId: null, turnsCompleted: 1 });
      await orch.stop();
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      await rm(fakeHome, { recursive: true, force: true });
      await rm(trackerRoot, { recursive: true, force: true });
    }
  });
});
