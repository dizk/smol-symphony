// Reconciler tests. The Smolfile-driven bake resource was removed in the
// Gondolin migration (the agent image is built once via images/agents, not
// baked per issue), so the dispatch-gating prerequisite is gone: dispatch is
// always ready. The remaining resources (VM reaper, workspace janitor, PR
// autopilot) have their own dedicated test files. This file pins the de-baked
// invariants of the Reconciler shell itself.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Reconciler } from '../src/reconciler/index.js';
import { buildServiceConfig } from '../src/workflow.js';
import type { ServiceConfig } from '../src/types.js';

async function makeCfg(): Promise<{ cfg: ServiceConfig; cleanup: () => Promise<void> }> {
  const workflowDir = await mkdtemp(path.join(os.tmpdir(), 'symphony-recon-wf-'));
  const trackerRoot = path.join(workflowDir, 'issues');
  await mkdir(trackerRoot, { recursive: true });
  const cfg = buildServiceConfig(
    {
      tracker: { kind: 'local', root: trackerRoot },
      states: {
        Todo: { role: 'active', adapter: 'claude' },
        Done: { role: 'terminal' },
        Triage: { role: 'holding' },
      },
    },
    path.join(workflowDir, 'WORKFLOW.md'),
  );
  return { cfg, cleanup: () => rm(workflowDir, { recursive: true, force: true }) };
}

describe('Reconciler (de-baked)', () => {
  it('dispatch is always ready — there is no bake prerequisite to gate on', async () => {
    const { cfg, cleanup } = await makeCfg();
    try {
      const reconciler = new Reconciler(cfg);
      assert.equal(reconciler.dispatchReady(), true);
    } finally {
      await cleanup();
    }
  });

  it('snapshot lists no resources when none are wired (no bake resource)', async () => {
    const { cfg, cleanup } = await makeCfg();
    try {
      const reconciler = new Reconciler(cfg);
      assert.deepEqual(reconciler.snapshot().resources, []);
    } finally {
      await cleanup();
    }
  });

  it('reconcile() and awaitInFlight() resolve without any resources wired', async () => {
    const { cfg, cleanup } = await makeCfg();
    try {
      const reconciler = new Reconciler(cfg);
      await reconciler.reconcile();
      await reconciler.awaitInFlight();
      assert.equal(reconciler.dispatchReady(), true);
    } finally {
      await cleanup();
    }
  });
});
