// VM reaper tests (issue 33 / reconciler stage 2). Covers the AC scenarios:
//   (a) daemon registry empty + 3 orphan _boot-vm workers → all killed.
//   (b) stale symphony-* in registry, no current dispatch → destroyed.
//   (c) active dispatch + matching registry + matching worker → left alone.
//   (d) SIGTERM-then-SIGKILL grace: a worker that ignores SIGTERM is SIGKILL'd
//       after the configured grace period.
//
// The tests drive `VmResource` directly with stubbed smolvm + boot-worker
// enumerators so they stay hermetic and fast — no host /proc reads or smolvm
// CLI calls.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { VmResource, type BootWorker, type IntendedVmProvider } from '../src/reconciler/vm.js';
import type { SmolvmClient } from '../src/agent/smolvm.js';

// --- shared fixtures ---------------------------------------------------------

interface FakeSmolvm {
  client: SmolvmClient;
  destroyed: string[];
  setRegistry: (vms: string[]) => void;
}

function makeFakeSmolvm(initialVms: string[]): FakeSmolvm {
  const state = { vms: [...initialVms], destroyed: [] as string[] };
  const client: Partial<SmolvmClient> = {
    list: async () => [...state.vms],
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
    setRegistry: (vms: string[]) => {
      state.vms = [...vms];
    },
  };
}

function provider(names: string[]): IntendedVmProvider {
  return { intendedVmNames: () => new Set(names) };
}

interface FakeProcess {
  pid: number;
  vmName: string;
  alive: boolean;
  // Should this PID exit when receiving SIGTERM? false = ignore SIGTERM (the
  // grace-test scenario where SIGKILL is required).
  exitsOnSigterm: boolean;
}

interface KillRecorder {
  signals: Array<{ pid: number; signal: NodeJS.Signals | 0 }>;
  // The current worker list as inferred from the procs[] state; passed to the
  // VmResource as `listBootWorkers`.
  list: () => Promise<BootWorker[]>;
  kill: (pid: number, signal: NodeJS.Signals | 0) => void;
}

function makeKillRecorder(procs: FakeProcess[]): KillRecorder {
  const signals: Array<{ pid: number; signal: NodeJS.Signals | 0 }> = [];
  const list = async (): Promise<BootWorker[]> =>
    procs.filter((p) => p.alive).map((p) => ({ pid: p.pid, vmName: p.vmName }));
  const kill = (pid: number, signal: NodeJS.Signals | 0): void => {
    signals.push({ pid, signal });
    const p = procs.find((x) => x.pid === pid);
    if (!p || !p.alive) {
      const err: NodeJS.ErrnoException = new Error(`kill ESRCH`);
      err.code = 'ESRCH';
      throw err;
    }
    if (signal === 0) return;
    if (signal === 'SIGTERM' && p.exitsOnSigterm) {
      p.alive = false;
      return;
    }
    if (signal === 'SIGKILL') {
      p.alive = false;
    }
  };
  return { signals, list, kill };
}

// --- tests -------------------------------------------------------------------

describe('VmResource reaper', () => {
  it('daemon registry empty + 3 orphan _boot-vm workers → reconciler kills all three', async () => {
    // The 2026-05-22 incident shape: smolvm's machine ls is empty but the host
    // has surviving `_boot-vm` workers holding their VMs' memory. The reaper
    // must SIGTERM each one — none survive the pass.
    const smolvm = makeFakeSmolvm([]);
    const procs: FakeProcess[] = [
      { pid: 1001, vmName: 'symphony-1', alive: true, exitsOnSigterm: true },
      { pid: 1002, vmName: 'symphony-2', alive: true, exitsOnSigterm: true },
      { pid: 1003, vmName: 'symphony-3', alive: true, exitsOnSigterm: true },
    ];
    const rec = makeKillRecorder(procs);
    const vm = new VmResource({
      smolvm: smolvm.client,
      intended: provider([]),
      listBootWorkers: rec.list,
      killProcess: rec.kill,
      killGraceMs: 10,
    });

    await vm.reconcile();

    assert.deepEqual(smolvm.destroyed, [], 'no daemon destroys (registry was empty)');
    const sigterm = rec.signals.filter((s) => s.signal === 'SIGTERM').map((s) => s.pid).sort();
    assert.deepEqual(sigterm, [1001, 1002, 1003], 'SIGTERM sent to all three workers');
    assert.deepEqual(
      rec.signals.filter((s) => s.signal === 'SIGKILL'),
      [],
      'no SIGKILL needed when SIGTERM is honored',
    );
    assert.equal(procs.filter((p) => p.alive).length, 0, 'all three workers exited');
  });

  it('stale symphony-99 in registry + no current dispatch → reconciler destroys it', async () => {
    // The daemon registry remembers a VM from a prior process, but the running
    // map is empty. The reaper destroys via the daemon.
    const smolvm = makeFakeSmolvm(['symphony-99', 'operator-personal-vm']);
    const rec = makeKillRecorder([]);
    const vm = new VmResource({
      smolvm: smolvm.client,
      intended: provider([]),
      listBootWorkers: rec.list,
      killProcess: rec.kill,
      killGraceMs: 10,
    });

    await vm.reconcile();

    assert.deepEqual(smolvm.destroyed, ['symphony-99'], 'only the symphony-* registry entry torn down');
    assert.deepEqual(rec.signals, [], 'no signals when the registry destroy handled it');
  });

  it('active dispatch for issue 42 + matching VM + matching boot-vm worker → reconciler leaves everything alone', async () => {
    // The race condition the issue body calls out: in-flight dispatch must
    // appear in the intended set so the reaper doesn't kill the VM out from
    // under the runner.
    const smolvm = makeFakeSmolvm(['symphony-42']);
    const procs: FakeProcess[] = [
      { pid: 4242, vmName: 'symphony-42', alive: true, exitsOnSigterm: true },
    ];
    const rec = makeKillRecorder(procs);
    const vm = new VmResource({
      smolvm: smolvm.client,
      intended: provider(['symphony-42']),
      listBootWorkers: rec.list,
      killProcess: rec.kill,
      killGraceMs: 10,
    });

    await vm.reconcile();

    assert.deepEqual(smolvm.destroyed, [], 'no daemon destroy for the active dispatch');
    assert.deepEqual(rec.signals, [], 'no signals sent to the active worker');
    assert.equal(procs[0]!.alive, true, 'worker stayed alive');
  });

  it('SIGTERM-then-SIGKILL grace: a worker that ignores SIGTERM is killed after the grace period', async () => {
    // Issue 33 explicitly requires the grace path: send SIGTERM, wait, then
    // SIGKILL if the process is still alive. This pins the escalation order so
    // a misbehaving boot worker never accumulates.
    const smolvm = makeFakeSmolvm([]);
    const stubborn: FakeProcess = {
      pid: 7777,
      vmName: 'symphony-stubborn',
      alive: true,
      exitsOnSigterm: false,
    };
    const rec = makeKillRecorder([stubborn]);
    const vm = new VmResource({
      smolvm: smolvm.client,
      intended: provider([]),
      listBootWorkers: rec.list,
      killProcess: rec.kill,
      killGraceMs: 20,
    });

    const start = Date.now();
    await vm.reconcile();
    const elapsed = Date.now() - start;

    // SIGTERM first, signal 0 to probe alive, then SIGKILL.
    const order = rec.signals.map((s) => s.signal);
    assert.equal(order[0], 'SIGTERM');
    assert.ok(order.includes(0), 'signal-0 alive probe fires after the grace');
    assert.ok(order.includes('SIGKILL'), 'SIGKILL fires after the grace');
    assert.equal(stubborn.alive, false, 'process is dead after SIGKILL');
    // Bound the grace window to keep the test honest — the SIGKILL must come
    // strictly after `killGraceMs`, not immediately.
    assert.ok(elapsed >= 15, `grace elapsed: ${elapsed}ms`);
  });

  it('non-symphony workers are left alone even when not in the intended set', async () => {
    // The reaper owns the `symphony-` namespace and only that namespace. An
    // operator's personal `_boot-vm` (named e.g. `dev-shell`) MUST survive.
    const smolvm = makeFakeSmolvm(['dev-shell']);
    const procs: FakeProcess[] = [
      { pid: 1, vmName: 'dev-shell', alive: true, exitsOnSigterm: true },
      { pid: 2, vmName: 'symphony-leak', alive: true, exitsOnSigterm: true },
    ];
    const rec = makeKillRecorder(procs);
    const vm = new VmResource({
      smolvm: smolvm.client,
      intended: provider([]),
      listBootWorkers: rec.list,
      killProcess: rec.kill,
      killGraceMs: 10,
    });

    await vm.reconcile();

    assert.deepEqual(smolvm.destroyed, [], 'dev-shell is not symphony-prefixed; left in registry');
    assert.equal(procs[0]!.alive, true, 'dev-shell process untouched');
    assert.equal(procs[1]!.alive, false, 'symphony-leak got reaped');
  });

  it('snapshot reports per-action ledger and last_error', async () => {
    // The dashboard reads from `snapshot()` to surface what the reaper just
    // did. Verify both happy and failure shapes land in the ledger.
    const smolvm = makeFakeSmolvm(['symphony-ok', 'symphony-broken']);
    // Override destroy so symphony-broken fails.
    (smolvm.client.destroy as (n: string) => Promise<void>) = async (name: string) => {
      if (name === 'symphony-broken') throw new Error('synthetic destroy failure');
      smolvm.destroyed.push(name);
    };
    const rec = makeKillRecorder([]);
    const vm = new VmResource({
      smolvm: smolvm.client,
      intended: provider([]),
      listBootWorkers: rec.list,
      killProcess: rec.kill,
      killGraceMs: 10,
    });

    await vm.reconcile();

    const snap = vm.snapshot();
    assert.equal(snap.id, 'vm');
    assert.equal(snap.ready, true, 'vm reaping does not gate dispatch');
    const errAction = snap.actions.find((a) => a.action.includes('symphony-broken'));
    assert.ok(errAction, 'failure recorded');
    assert.equal(errAction!.state, 'error');
    assert.match(errAction!.error!, /synthetic destroy failure/);
    assert.match(snap.last_error!, /synthetic destroy failure/);
  });
});
