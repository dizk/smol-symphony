import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Orchestrator } from '../src/orchestrator.js';
import { buildServiceConfig } from '../src/workflow.js';
import {
  computeMemoryAdmission,
  parseMemAvailableMib,
  type MemProbe,
} from '../src/memory.js';
import type {
  ServiceConfig,
  WorkflowDefinition,
  Issue,
} from '../src/types.js';
import type { WorkflowSource } from '../src/workflow.js';
import type {
  IssueTracker,
  CandidateFetchResult,
} from '../src/trackers/types.js';
import type { WorkspaceManager } from '../src/workspace.js';
import type { AgentRunner } from '../src/agent/runner.js';

// Issue 27: memory-aware admission cap. The orchestrator reads `/proc/meminfo`
// each tick and clamps the effective concurrency cap to what fits in
// `MemAvailable - host_memory_reserve_mib` at `gondolin.mem_mib` per VM. Two
// layers of coverage:
//   - the pure `computeMemoryAdmission` math (covering the clamp formula and
//     the every-knob-off fallback) so the unit doesn't depend on orchestrator
//     plumbing.
//   - a thin orchestrator surface test that wires a fake probe into the
//     constructor and asserts the snapshot's `memory_admission` block reflects
//     the probe reading.

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
    workflowSrc: {
      onChange: () => () => undefined,
      current: () => ({} as any),
      stop: async () => undefined,
    } as unknown as WorkflowSource,
    tracker: makeTracker(),
    workspaces: {} as unknown as WorkspaceManager,
    runner: {} as unknown as AgentRunner,
  };
}

async function buildCfgAndDef(
  raw: Record<string, unknown>,
  trackerRoot: string,
): Promise<{ cfg: ServiceConfig; def: WorkflowDefinition }> {
  const merged = {
    ...raw,
    tracker: { kind: 'local', root: trackerRoot, ...((raw.tracker as object) ?? {}) },
  };
  const cfg = buildServiceConfig(merged, path.join(trackerRoot, 'WORKFLOW.md'));
  const def: WorkflowDefinition = { config: merged, prompt_template: '' };
  return { cfg, def };
}

describe('parseMemAvailableMib', () => {
  it('extracts MemAvailable from a real-shaped /proc/meminfo', () => {
    // Truncated but format-faithful sample. Kernel writes `MemAvailable:    NNNN kB`
    // (note variable-width whitespace, lowercase `kB`).
    const meminfo = [
      'MemTotal:       16312456 kB',
      'MemFree:         3140212 kB',
      'MemAvailable:   12345678 kB',
      'Buffers:           12345 kB',
    ].join('\n');
    // 12345678 KiB / 1024 = 12056 MiB (floor).
    assert.equal(parseMemAvailableMib(meminfo), Math.floor(12345678 / 1024));
  });

  it('returns null when MemAvailable is missing', () => {
    const meminfo = 'MemTotal:       16312456 kB\nMemFree:         3140212 kB\n';
    assert.equal(parseMemAvailableMib(meminfo), null);
  });
});

describe('computeMemoryAdmission', () => {
  it('returns static cap unchanged when the feature is disabled', () => {
    const r = computeMemoryAdmission({
      enabled: false,
      static_cap: 4,
      running: 1,
      probe: { mem_available_mib: 8192, supported: true },
      reserve_mib: 2048,
      per_vm_mib: 2048,
    });
    assert.equal(r.effective_cap, 4);
    assert.equal(r.clamp_active, false);
    assert.equal(r.admission_room, null);
  });

  it('returns static cap unchanged when the probe is unsupported (mem_available_mib=null)', () => {
    const r = computeMemoryAdmission({
      enabled: true,
      static_cap: 4,
      running: 0,
      probe: { mem_available_mib: null, supported: false },
      reserve_mib: 2048,
      per_vm_mib: 2048,
    });
    assert.equal(r.effective_cap, 4);
    assert.equal(r.clamp_active, false);
  });

  it('clamps to `running + floor((available - reserve) / per_vm)` when memory is the binding constraint', () => {
    // 6144 - 2048 = 4096 MiB headroom; at 2048 MiB/VM that's 2 additional VMs.
    // With 1 already running, effective_cap = 1 + 2 = 3, below static_cap=10.
    const r = computeMemoryAdmission({
      enabled: true,
      static_cap: 10,
      running: 1,
      probe: { mem_available_mib: 6144, supported: true },
      reserve_mib: 2048,
      per_vm_mib: 2048,
    });
    assert.equal(r.effective_cap, 3);
    assert.equal(r.admission_room, 2);
    assert.equal(r.clamp_active, true);
  });

  it('falls back to static cap when memory comfortably fits all slots', () => {
    // 32 GiB available, 2 GiB reserve, 2 GiB/VM, static cap 4 → admission_room = 15,
    // memoryCap = running (0) + 15 = 15, effective = min(4, 15) = 4.
    const r = computeMemoryAdmission({
      enabled: true,
      static_cap: 4,
      running: 0,
      probe: { mem_available_mib: 32768, supported: true },
      reserve_mib: 2048,
      per_vm_mib: 2048,
    });
    assert.equal(r.effective_cap, 4);
    assert.equal(r.admission_room, 15);
    assert.equal(r.clamp_active, false);
  });

  it('treats sub-reserve memory as zero admission room (does not allow a half-VM)', () => {
    // 1 GiB available, 2 GiB reserve → headroom is negative.
    const r = computeMemoryAdmission({
      enabled: true,
      static_cap: 4,
      running: 0,
      probe: { mem_available_mib: 1024, supported: true },
      reserve_mib: 2048,
      per_vm_mib: 2048,
    });
    assert.equal(r.effective_cap, 0);
    assert.equal(r.admission_room, 0);
    assert.equal(r.clamp_active, true);
  });
});

describe('Orchestrator memory admission integration', () => {
  // Plumb a fake probe through the orchestrator and verify the snapshot
  // surface matches what the operator would see on the dashboard.
  it('exposes memory_admission in the snapshot with the probe value', async () => {
    const fakeHome = await mkdtemp(path.join(os.tmpdir(), 'symphony-mem-home-'));
    const trackerRoot = await mkdtemp(path.join(os.tmpdir(), 'symphony-mem-tracker-'));
    const prevHome = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      await mkdir(path.join(fakeHome, '.claude'), { recursive: true });
      await writeFile(path.join(fakeHome, '.claude', '.credentials.json'), '{}');

      const { cfg, def } = await buildCfgAndDef(
        {
          acp: { adapter: 'claude' },
          // 4 GiB per VM, 2 GiB reserve, static cap 8. With a stubbed 8 GiB
          // available, admission_room = floor((8192-2048)/4096) = 1, effective = 1.
          agent: {
            max_concurrent_agents: 8,
            host_memory_reserve_mib: 2048,
            memory_admission_enabled: true,
          },
          gondolin: { mem_mib: 4096 },
          states: {
            Todo: { role: 'active', adapter: 'claude' },
            Done: { role: 'terminal' },
            Triage: { role: 'holding' },
          },
        },
        trackerRoot,
      );
      const { workflowSrc, tracker, workspaces, runner } = makeStubs();
      const probe: MemProbe = () => ({ mem_available_mib: 8192, supported: true });
      const orch = new Orchestrator(
        cfg,
        def,
        workflowSrc,
        tracker,
        workspaces,
        runner,
        probe,
      );
      await orch.start();
      const snap = orch.snapshot();
      assert.equal(snap.memory_admission.enabled, true);
      assert.equal(snap.memory_admission.probe_supported, true);
      assert.equal(snap.memory_admission.mem_available_mib, 8192);
      assert.equal(snap.memory_admission.reserve_mib, 2048);
      assert.equal(snap.memory_admission.per_vm_mib, 4096);
      assert.equal(snap.memory_admission.static_cap, 8);
      assert.equal(snap.memory_admission.effective_cap, 1);
      assert.equal(snap.memory_admission.admission_room, 1);
      assert.equal(snap.memory_admission.clamp_active, true);
      await orch.stop();
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      await rm(fakeHome, { recursive: true, force: true });
      await rm(trackerRoot, { recursive: true, force: true });
    }
  });

  it('reports clamp_active=false and effective_cap=static_cap when the feature is off', async () => {
    const fakeHome = await mkdtemp(path.join(os.tmpdir(), 'symphony-mem-off-home-'));
    const trackerRoot = await mkdtemp(path.join(os.tmpdir(), 'symphony-mem-off-tracker-'));
    const prevHome = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      await mkdir(path.join(fakeHome, '.claude'), { recursive: true });
      await writeFile(path.join(fakeHome, '.claude', '.credentials.json'), '{}');

      const { cfg, def } = await buildCfgAndDef(
        {
          acp: { adapter: 'claude' },
          agent: { max_concurrent_agents: 3, memory_admission_enabled: false },
          gondolin: { mem_mib: 4096 },
          states: {
            Todo: { role: 'active', adapter: 'claude' },
            Done: { role: 'terminal' },
            Triage: { role: 'holding' },
          },
        },
        trackerRoot,
      );
      const { workflowSrc, tracker, workspaces, runner } = makeStubs();
      // The probe should not be consulted when memory_admission_enabled is false.
      let probeCalls = 0;
      const probe: MemProbe = () => {
        probeCalls++;
        return { mem_available_mib: 256, supported: true };
      };
      const orch = new Orchestrator(
        cfg,
        def,
        workflowSrc,
        tracker,
        workspaces,
        runner,
        probe,
      );
      await orch.start();
      const snap = orch.snapshot();
      assert.equal(snap.memory_admission.enabled, false);
      assert.equal(snap.memory_admission.effective_cap, 3);
      assert.equal(snap.memory_admission.clamp_active, false);
      // mem_available_mib should be null when the probe is skipped.
      assert.equal(snap.memory_admission.mem_available_mib, null);
      assert.equal(probeCalls, 0);
      await orch.stop();
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      await rm(fakeHome, { recursive: true, force: true });
      await rm(trackerRoot, { recursive: true, force: true });
    }
  });
});
