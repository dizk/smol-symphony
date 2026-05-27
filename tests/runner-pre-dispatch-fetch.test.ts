// Pins the issue-101 invariant at the runner layer: a fresh `origin/<base>`
// is a dispatch precondition, not a best-effort warm-up. If the host-side
// `git fetch origin <base>` fails in a workspace with an `origin` configured
// (auth, network, missing ref), `runAttempt` MUST abort the attempt before
// the `before_run` hook or any agent launch — otherwise the agent's first
// `git rebase origin/<base>` rebases against a stale local ref and we
// reproduce exactly the stale-base behavior issue 101 eliminates.
//
// Strategy: stand up a real workspace whose origin points at a bare remote
// that does NOT carry the requested base branch (so `git fetch origin main`
// is guaranteed to exit non-zero), hand it to a minimal AgentRunner via a
// stub WorkspaceManager, and assert the failure shape + that no downstream
// orchestration ran. The stub records `runBeforeRun` calls; the other
// runner ports (tracker, smolvm, events) are wired as never-called values
// so a regression that lets execution leak past the fetch surfaces as a
// thrown tripwire rather than a silent pass.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { AgentRunner } from '../src/agent/runner.js';
import { buildServiceConfig } from '../src/workflow.js';
import type { WorkflowDefinition, Issue } from '../src/types.js';
import type { WorkspaceManager } from '../src/workspace.js';
import type { IssueTracker } from '../src/trackers/types.js';
import type { SmolvmClient } from '../src/agent/smolvm.js';

function run(cmd: string, args: string[], cwd: string): Promise<{ exit: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', (b) => {
      stderr += b.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ exit: code ?? -1, stderr }));
  });
}

async function git(args: string[], cwd: string): Promise<void> {
  const r = await run('git', args, cwd);
  if (r.exit !== 0) {
    throw new Error(`git ${args.join(' ')} in ${cwd} exited ${r.exit}: ${r.stderr}`);
  }
}

describe('runAttempt pre-dispatch base fetch (issue 101 precondition)', () => {
  it('aborts the attempt with a typed failure when the host cannot refresh origin/<base>', async () => {
    const bareRemote = await mkdtemp(path.join(os.tmpdir(), 'symphony-101-runner-remote-'));
    const wsRoot = await mkdtemp(path.join(os.tmpdir(), 'symphony-101-runner-ws-'));
    const trackerRoot = await mkdtemp(path.join(os.tmpdir(), 'symphony-101-runner-tracker-'));
    try {
      // Empty bare remote on `main`: any subsequent `git fetch origin main`
      // exits non-zero ("couldn't find remote ref"), so fetchBaseInWorkspace
      // surfaces ok:false and the runner must abort.
      await git(['init', '--bare', '-b', 'main'], bareRemote);
      const wsPath = path.join(wsRoot, '42');
      await mkdir(wsPath, { recursive: true });
      await git(['init', '-b', 'main'], wsPath);
      await git(['config', 'user.name', 'test'], wsPath);
      await git(['config', 'user.email', 'test@example.com'], wsPath);
      await git(['remote', 'add', 'origin', bareRemote], wsPath);

      const cfg = buildServiceConfig(
        {
          workspace: { root: wsRoot },
          acp: { adapter: 'claude' },
          states: {
            Todo: { role: 'active', adapter: 'claude' },
            Done: { role: 'terminal' },
          },
          tracker: { kind: 'local', root: trackerRoot },
        },
        path.join(trackerRoot, 'WORKFLOW.md'),
      );
      const def: WorkflowDefinition = { config: {}, prompt_template: '' };

      let runBeforeRunCalls = 0;
      const fakeWorkspaces = {
        ensureFor: async () => ({ path: wsPath, workspace_key: '42', created_now: false }),
        runBeforeRun: async () => {
          runBeforeRunCalls += 1;
        },
        runAfterRunBestEffort: async () => {
          // Should also not fire when the attempt aborts before any agent run.
          throw new Error('tripwire: runAfterRunBestEffort called before agent launch');
        },
      } as unknown as WorkspaceManager;

      const tracker = {} as unknown as IssueTracker;
      const smolvm = {} as unknown as SmolvmClient;
      const events = {
        onRuntimeEvent: () => {
          throw new Error('tripwire: onRuntimeEvent');
        },
        onTokenUsage: () => {
          throw new Error('tripwire: onTokenUsage');
        },
        onRateLimits: () => {
          throw new Error('tripwire: onRateLimits');
        },
        onTurn: () => {
          throw new Error('tripwire: onTurn');
        },
      };

      const runner = new AgentRunner(cfg, def, fakeWorkspaces, tracker, smolvm, events);

      const issue: Issue = {
        id: '42',
        identifier: '42',
        title: 'pre-dispatch fetch failure',
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

      // Pre-set SYMPHONY_BASE_BRANCH=main so the runner asks for the base the
      // bare remote is guaranteed not to have. Restore afterwards.
      const prev = process.env.SYMPHONY_BASE_BRANCH;
      process.env.SYMPHONY_BASE_BRANCH = 'main';
      try {
        const result = await runner.runAttempt(issue, 0, { cancelled: false });
        assert.deepEqual(result, {
          ok: false,
          reason: 'pre-dispatch base fetch failed',
          threadId: null,
          turnsCompleted: 0,
        });
      } finally {
        if (prev === undefined) delete process.env.SYMPHONY_BASE_BRANCH;
        else process.env.SYMPHONY_BASE_BRANCH = prev;
      }
      assert.equal(
        runBeforeRunCalls,
        0,
        'before_run hook must not run when origin/<base> cannot be refreshed',
      );
    } finally {
      await rm(bareRemote, { recursive: true, force: true });
      await rm(wsRoot, { recursive: true, force: true });
      await rm(trackerRoot, { recursive: true, force: true });
    }
  });
});
