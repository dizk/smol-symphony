// VM reaper resource (issue 33 / reconciler stage 2). Owns the lifecycle of
// `symphony-*` libkrun VMs: anything outside the orchestrator's intended set is
// an orphan and gets reaped.
//
// The 2026-05-22 incident motivated a two-source actual set. The smolvm daemon
// keeps a machine registry (`smolvm machine ls`) — that's the easy half. The
// other half is the host-side `_boot-vm` worker process that wraps each libkrun
// VM. Upstream smolvm has a known bug where `machine delete -f` returns success
// but leaves the `_boot-vm` worker alive; over enough restarts those workers
// accumulate, hold their VMs' guest memory, and the host OOMs. We treat the
// process list as a second authoritative source and SIGTERM→SIGKILL anything
// that names a `symphony-` VM but isn't in the intended set.
//
// VM-name mapping (`_boot-vm` → symphony VM):
//   `_boot-vm` argv contains the path to `~/.cache/smolvm/vms/<hash>/boot-config.json`.
//   smolvm consumes and deletes that file shortly after boot, so for a running
//   VM it isn't present on disk. The persistent sibling `<dir>/name` (plain
//   text = the daemon-registered VM name) is what we read instead. A
//   `boot-config.json` fallback remains for robustness across smolvm versions
//   and for the narrow window before the daemon removes it. We only kill
//   workers whose resolved name starts with `symphony-`; anything else (an
//   operator's personal VM, a sibling tool's workers) is left alone. The IO
//   side of this mapping lives in `./index.ts`; this module stays pure.
//
// Effects-as-data (issue 69): the decision of WHAT to do is a pure function
// (`decideVm`) of the observed state; HOW it's done (smolvm CLI, /proc reads,
// process.kill, sleep) is the shell's job. This module is import-pure:
// no `node:fs`, no timers, no adapter imports.

import { log } from '../logging.js';
import { ResourceActionLedger } from './ledger.js';
import type {
  DestroyMachineAction,
  KillBootWorkerAction,
  ResourceSnapshot,
} from './types.js';

// Domain constant. Every VM the orchestrator creates is named with this
// prefix; the reaper only acts on names that match. The smolvm-port adapter
// mirrors the same value where it mints VM names — keep them in sync.
export const SYMPHONY_VM_PREFIX = 'symphony-';

const DEFAULT_KILL_GRACE_MS = 3_000;
const MAX_ACTION_HISTORY = 32;

/**
 * Source of the orchestrator's currently-intended VM set. Returned each
 * reconcile pass so the reaper sees the latest snapshot of running +
 * about-to-be-allocated dispatches. The reaper compares this against the
 * union of (daemon registry, _boot-vm process list) and kills the difference.
 */
export interface IntendedVmProvider {
  intendedVmNames(): Set<string>;
}

/** Result of inspecting one `_boot-vm` host process. */
export interface BootWorker {
  pid: number;
  vmName: string;
}

/**
 * Minimal smolvm surface the reaper consumes. Subset of the `SmolvmClient`
 * port; declared locally so vm.ts stays adapter-import-free.
 */
export interface VmRegistryPort {
  list(): Promise<string[]>;
  destroy(name: string): Promise<void>;
}

export interface VmResourceOptions {
  smolvm: VmRegistryPort;
  intended: IntendedVmProvider;
  /**
   * Process enumerator. Production wiring (defaultListBootWorkers in
   * `./index.ts`) returns workers whose VM name could be resolved from the
   * persistent `<vmdir>/name` file (with a `boot-config.json` fallback).
   * Workers with no resolvable name are dropped at the source.
   */
  listBootWorkers: () => Promise<BootWorker[]>;
  /**
   * Send a signal to a host PID. Production wiring delegates to `process.kill`
   * in `./index.ts`. Receivers throw nothing on success and ESRCH/EPERM via
   * a thrown Error on failure.
   */
  killProcess: (pid: number, signal: NodeJS.Signals | 0) => void;
  /**
   * SIGTERM-to-SIGKILL grace period (ms). A boot worker that ignores SIGTERM
   * is SIGKILL'd after this delay. Default 3s; tests pass a small value so
   * the grace path is observable in fast suites.
   */
  killGraceMs?: number;
}

/**
 * Snapshot of every input `decideVm` needs. Populated by the shell's
 * observation pass — `decideVm` is a pure function of this record.
 */
export interface VmObservedState {
  /** Names the orchestrator wants to keep alive (current dispatch set). */
  intended: ReadonlySet<string>;
  /** Names known to the smolvm daemon (`smolvm machine ls`). */
  registry: readonly string[];
  /** Host `_boot-vm` workers whose VM name resolved from disk. */
  workers: readonly BootWorker[];
}

/**
 * Reaper effect, applied by the shell. Reuses the typed action records from
 * `./types.ts` so the dashboard's existing `ReconcilerAction` taxonomy doubles
 * as the effect language.
 */
export type VmEffect = DestroyMachineAction | KillBootWorkerAction;

/**
 * Pure decision: given the observed VM/worker state, return the effects the
 * shell should apply. No IO, no clock reads, no logging.
 *
 * Effect rules:
 *   • Registry entry starts with SYMPHONY_VM_PREFIX and isn't intended
 *     → `destroy_machine`.
 *   • Worker's vmName starts with SYMPHONY_VM_PREFIX and isn't intended
 *     → `kill_boot_worker`.
 *
 * Anything outside the symphony-prefixed namespace is left untouched
 * (operator VMs, sibling tools' workers).
 */
export function decideVm(state: VmObservedState): VmEffect[] {
  const out: VmEffect[] = [];
  for (const name of state.registry) {
    if (name.startsWith(SYMPHONY_VM_PREFIX) && !state.intended.has(name)) {
      out.push({ kind: 'destroy_machine', vm_name: name });
    }
  }
  for (const w of state.workers) {
    if (!w.vmName.startsWith(SYMPHONY_VM_PREFIX)) continue;
    if (state.intended.has(w.vmName)) continue;
    out.push({ kind: 'kill_boot_worker', pid: w.pid, vm_name: w.vmName });
  }
  return out;
}

/**
 * VM resource. Desired = orchestrator's intended VM set. Actual = union of
 * `smolvm machine ls` (filtered by `symphony-` prefix) and `_boot-vm` workers
 * (also `symphony-` filtered). `reconcile()` is the thin shell loop:
 * observe → `decideVm` → apply. The two-phase shape (destroy machines, then
 * re-observe and kill survivors) reuses `decideVm` on the survivor set so the
 * pure decision keeps owning what counts as a stray.
 *
 * Independent of bake (`dependsOn: []`). Doesn't gate dispatch.
 */
export class VmResource {
  readonly id = 'vm';
  readonly dependsOn: string[] = [];

  private readonly listBootWorkers: () => Promise<BootWorker[]>;
  private readonly killProcess: (pid: number, signal: NodeJS.Signals | 0) => void;
  private readonly killGraceMs: number;

  private readonly ledger = new ResourceActionLedger(this.id, { maxHistory: MAX_ACTION_HISTORY });
  private lastError: string | null = null;

  constructor(private readonly opts: VmResourceOptions) {
    this.listBootWorkers = opts.listBootWorkers;
    this.killProcess = opts.killProcess;
    this.killGraceMs = opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  }

  ready(): boolean {
    // VM reaping is a janitorial task — it doesn't gate dispatch. The bake
    // resource is the only thing dispatch waits on today; reaping just runs
    // alongside.
    return true;
  }

  async reconcile(): Promise<void> {
    const desired = this.opts.intended.intendedVmNames();

    // The smolvm client's `list` swallows daemon-side failures and returns [].
    // Treat that as an empty actual set on this axis — the process axis still
    // catches surviving workers.
    const registry = await this.opts.smolvm.list();
    const workers = await this.observeWorkers();

    const initial = decideVm({ intended: desired, registry, workers });
    if (initial.length === 0) return;

    const strayMachines = initial.filter(
      (e): e is DestroyMachineAction => e.kind === 'destroy_machine',
    );
    const strayWorkers = initial.filter(
      (e): e is KillBootWorkerAction => e.kind === 'kill_boot_worker',
    );
    log.info('vm reaper: destroying strays', {
      stray_machines: strayMachines.length,
      stray_workers: strayWorkers.length,
    });

    // Destroy via the daemon first — that's the polite path; on success the
    // upstream smolvm releases the registry slot and (in the bug-free path)
    // also takes the `_boot-vm` worker down. Parallel: smolvm.destroy already
    // bounds each call with its own timeout.
    await Promise.all(strayMachines.map((e) => this.destroyMachine(e.vm_name)));

    // Re-enumerate workers so the SIGTERM step skips PIDs the daemon destroy
    // already brought down. `decideVm` runs again over the survivors so the
    // pure function still owns what counts as a stray.
    const survivors = await this.observeWorkers();
    const followup = decideVm({ intended: desired, registry: [], workers: survivors });
    const stillStray = followup.filter(
      (e): e is KillBootWorkerAction => e.kind === 'kill_boot_worker',
    );
    await Promise.all(stillStray.map((e) => this.killWorker({ pid: e.pid, vmName: e.vm_name })));
  }

  snapshot(): ResourceSnapshot {
    return {
      id: this.id,
      ready: true,
      desired_hash: null,
      last_error: this.lastError,
      actions: this.ledger.snapshot(),
    };
  }

  private async observeWorkers(): Promise<BootWorker[]> {
    try {
      return await this.listBootWorkers();
    } catch (err) {
      const msg = (err as Error).message;
      this.lastError = `boot worker enumeration failed: ${msg}`;
      log.warn('vm reaper: boot worker enumeration failed', { error: msg });
      return [];
    }
  }

  private async destroyMachine(name: string): Promise<void> {
    const key = `destroy_machine:${name}`;
    const res = await this.ledger.run(key, () => this.opts.smolvm.destroy(name));
    if (!res.ok) {
      this.lastError = res.error;
      log.warn('vm reaper: destroy_machine failed', { name, error: res.error });
    }
  }

  private async killWorker(w: BootWorker): Promise<void> {
    const key = `kill_boot_worker:${w.pid}`;
    this.ledger.start(key);
    // SIGTERM. If the process is already gone (ESRCH) treat as success.
    try {
      this.killProcess(w.pid, 'SIGTERM');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ESRCH') {
        this.ledger.done(key);
        return;
      }
      const msg = (err as Error).message;
      this.lastError = msg;
      this.ledger.error(key, msg);
      log.warn('vm reaper: SIGTERM failed', { pid: w.pid, vm: w.vmName, error: msg });
      return;
    }
    // Inline timer (rather than `node:timers/promises`) keeps the file
    // adapter-import-free for the functional-core lint.
    await new Promise<void>((resolve) => { setTimeout(resolve, this.killGraceMs); });
    // Probe with signal 0 — throws ESRCH if the process has exited. If it's
    // still alive, escalate to SIGKILL.
    let alive = false;
    try {
      this.killProcess(w.pid, 0);
      alive = true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ESRCH') {
        // EPERM and friends — assume alive but unkillable; surface as an error.
        const msg = (err as Error).message;
        this.lastError = msg;
        this.ledger.error(key, msg);
        log.warn('vm reaper: alive-probe failed', { pid: w.pid, error: msg });
        return;
      }
    }
    if (!alive) {
      this.ledger.done(key);
      return;
    }
    try {
      this.killProcess(w.pid, 'SIGKILL');
      this.ledger.done(key);
      log.info('vm reaper: SIGKILL applied after grace', {
        pid: w.pid,
        vm: w.vmName,
        grace_ms: this.killGraceMs,
      });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ESRCH') {
        this.ledger.done(key);
        return;
      }
      const msg = (err as Error).message;
      this.lastError = msg;
      this.ledger.error(key, msg);
      log.warn('vm reaper: SIGKILL failed', { pid: w.pid, vm: w.vmName, error: msg });
    }
  }
}
