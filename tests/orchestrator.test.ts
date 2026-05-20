import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Orchestrator } from '../src/orchestrator.js';
import { buildServiceConfig } from '../src/workflow.js';
import type { ServiceConfig, WorkflowDefinition, Issue } from '../src/types.js';
import type { WorkflowSource } from '../src/workflow.js';
import type { IssueTracker, CandidateFetchResult } from '../src/trackers/types.js';
import type { WorkspaceManager } from '../src/workspace.js';
import type { AgentRunner } from '../src/agent/runner.js';

// Phase 2 contract for orchestrator startup: the credential check is no longer
// just `cfg.acp.adapter`, it has to walk the union of the workflow-level adapter
// and every distinct adapter declared on any state. A workflow that pins claude
// at the top level but assigns codex to its Review state must fail startup
// loudly if codex's host credential is missing — otherwise the operator gets a
// confusing per-issue failure inside the VM instead of a clean error at boot.

function makeTracker(): IssueTracker {
  return {
    async fetchCandidateIssues(): Promise<CandidateFetchResult> {
      return { issues: [], root: null, terminalStates: [] };
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
    // should reach the post-credential-check `startupTerminalCleanup` path
    // and resolve without throwing.
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

  it('skips per-state credential checks when acp.command is set (operator-managed)', async () => {
    // acp.command is rejected by validateDispatch under the TCP bridge, so we
    // can't actually start with one set today. But the credential-check
    // pathway must still be conditional on `cfg.acp.command === null`: this
    // test guards the conditional so a future relaxation of validateDispatch
    // doesn't accidentally start probing host paths the operator owns.
    const fakeHome = await mkdtemp(path.join(os.tmpdir(), 'symphony-startup-home-cmd-'));
    const trackerRoot = await mkdtemp(path.join(os.tmpdir(), 'symphony-startup-tracker-cmd-'));
    const prevHome = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      // No credentials staged at all; if the gate is honored, start() will
      // still fail (validateDispatch rejects acp.command under the TCP
      // bridge) but the failure must NOT be about a missing credential —
      // it has to be the acp.command rejection.
      const { cfg, def } = await buildCfgAndDef(
        {
          acp: { adapter: 'claude', command: 'echo not-supported' },
          states: {
            Todo: { role: 'active' },
            Done: { role: 'terminal' },
          },
        },
        trackerRoot,
      );
      const { workflowSrc, tracker, workspaces, runner } = makeStubs();
      const orch = new Orchestrator(cfg, def, workflowSrc, tracker, workspaces, runner);
      await assert.rejects(
        () => orch.start(),
        (err: unknown) => err instanceof Error && /acp\.command is not supported/.test(err.message),
      );
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      await rm(fakeHome, { recursive: true, force: true });
      await rm(trackerRoot, { recursive: true, force: true });
    }
  });
});
