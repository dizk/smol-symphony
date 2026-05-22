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
//   That file's `name` field is the VM's daemon-registered name. We only kill
//   workers whose name starts with `symphony-`; anything else (an operator's
//   personal VM, a sibling tool's workers) is left alone.
//
// Defense in depth: malformed/missing boot-config.json drops the worker from
// consideration. The reaper would rather leak than blindly kill a process whose
// VM name we can't confirm.

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { SYMPHONY_VM_PREFIX, type SmolvmClient } from '../agent/smolvm.js';
import { log } from '../logging.js';
import type { ActionStatus, ResourceSnapshot } from './types.js';

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

export interface VmResourceOptions {
  smolvm: SmolvmClient;
  intended: IntendedVmProvider;
  /**
   * Process enumerator (overridable for tests). Returns workers whose VM name
   * could be resolved via boot-config.json. Workers with malformed/missing
   * config are dropped at the source.
   */
  listBootWorkers?: () => Promise<BootWorker[]>;
  /**
   * Send a signal to a host PID (overridable for tests). Defaults to
   * `process.kill`. Receivers throw nothing on success and ESRCH/EPERM via
   * a thrown Error on failure.
   */
  killProcess?: (pid: number, signal: NodeJS.Signals | 0) => void;
  /**
   * SIGTERM-to-SIGKILL grace period (ms). A boot worker that ignores SIGTERM
   * is SIGKILL'd after this delay. Default 3s; tests pass a small value so
   * the grace path is observable in fast suites.
   */
  killGraceMs?: number;
}

const DEFAULT_KILL_GRACE_MS = 3_000;
const MAX_ACTION_HISTORY = 32;

/**
 * Enumerate every `_boot-vm` host worker and map it to its symphony VM name
 * via the `boot-config.json` referenced in argv. Linux-only (reads /proc).
 *
 * Workers whose argv has no boot-config path, whose boot-config is missing
 * or unparseable, or whose `name` field is absent are dropped silently — the
 * reaper only acts on confidently-identified strays.
 */
export async function defaultListBootWorkers(): Promise<BootWorker[]> {
  const procDir = '/proc';
  let entries: string[];
  try {
    entries = await readdir(procDir);
  } catch {
    return [];
  }
  const out: BootWorker[] = [];
  for (const ent of entries) {
    const pid = Number(ent);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    let raw: string;
    try {
      raw = await readFile(path.join(procDir, ent, 'cmdline'), 'utf8');
    } catch {
      continue;
    }
    const argv = raw.split('\0').filter((s) => s.length > 0);
    if (argv.length === 0) continue;
    if (!argv.some((a) => path.basename(a) === '_boot-vm')) continue;
    const configPath = argv.find((a) => a.endsWith('boot-config.json'));
    if (!configPath) continue;
    let body: string;
    try {
      body = await readFile(configPath, 'utf8');
    } catch {
      log.debug('vm reaper: boot-config read failed', { pid, configPath });
      continue;
    }
    let parsed: { name?: unknown };
    try {
      parsed = JSON.parse(body) as { name?: unknown };
    } catch {
      log.debug('vm reaper: boot-config malformed', { pid, configPath });
      continue;
    }
    const name = parsed.name;
    if (typeof name !== 'string' || name.length === 0) continue;
    out.push({ pid, vmName: name });
  }
  return out;
}

function defaultKillProcess(pid: number, signal: NodeJS.Signals | 0): void {
  process.kill(pid, signal);
}

/**
 * VM resource. Desired = orchestrator's intended VM set. Actual = union of
 * `smolvm machine ls` (filtered by `symphony-` prefix) and `_boot-vm` workers
 * mapped through boot-config.json (also `symphony-` filtered).
 *
 * Diff → two action shapes:
 *   • destroy_machine — registry-tracked symphony VM not in intended.
 *   • kill_boot_worker — host PID running a symphony VM, not in intended;
 *                        SIGTERM → grace → SIGKILL if still alive.
 *
 * Independent of bake (`dependsOn: []`). Doesn't gate dispatch.
 */
export class VmResource {
  readonly id = 'vm';
  readonly dependsOn: string[] = [];

  private readonly listBootWorkers: () => Promise<BootWorker[]>;
  private readonly killProcess: (pid: number, signal: NodeJS.Signals | 0) => void;
  private readonly killGraceMs: number;

  private actions: ActionStatus[] = [];
  private lastError: string | null = null;

  constructor(private readonly opts: VmResourceOptions) {
    this.listBootWorkers = opts.listBootWorkers ?? defaultListBootWorkers;
    this.killProcess = opts.killProcess ?? defaultKillProcess;
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
    let workers: BootWorker[];
    try {
      workers = await this.listBootWorkers();
    } catch (err) {
      const msg = (err as Error).message;
      this.lastError = `boot worker enumeration failed: ${msg}`;
      log.warn('vm reaper: boot worker enumeration failed', { error: msg });
      workers = [];
    }

    const strayMachines = registry
      .filter((n) => n.startsWith(SYMPHONY_VM_PREFIX) && !desired.has(n));
    const strayWorkers = workers
      .filter((w) => w.vmName.startsWith(SYMPHONY_VM_PREFIX) && !desired.has(w.vmName));

    if (strayMachines.length === 0 && strayWorkers.length === 0) return;

    log.info('vm reaper: destroying strays', {
      stray_machines: strayMachines.length,
      stray_workers: strayWorkers.length,
    });

    // Destroy via the daemon first — that's the polite path; on success the
    // upstream smolvm releases the registry slot and (in the bug-free path)
    // also takes the `_boot-vm` worker down. Parallel: smolvm.destroy already
    // bounds each call with its own timeout.
    await Promise.all(strayMachines.map((n) => this.destroyMachine(n)));

    // Re-enumerate workers so the SIGTERM step skips PIDs the daemon destroy
    // already brought down. Without this we'd needlessly SIGTERM dead PIDs and
    // log noise; with the upstream bug present, the survivors are the ones we
    // actually need to kill.
    let survivors: BootWorker[];
    try {
      survivors = await this.listBootWorkers();
    } catch {
      survivors = workers;
    }
    const stillStray = survivors.filter(
      (w) => w.vmName.startsWith(SYMPHONY_VM_PREFIX) && !desired.has(w.vmName),
    );
    await Promise.all(stillStray.map((w) => this.killWorker(w)));
  }

  snapshot(): ResourceSnapshot {
    return {
      id: this.id,
      ready: true,
      desired_hash: null,
      last_error: this.lastError,
      actions: this.actions.slice(0, MAX_ACTION_HISTORY),
    };
  }

  private async destroyMachine(name: string): Promise<void> {
    const key = `destroy_machine:${name}`;
    const startedAt = new Date().toISOString();
    this.pushAction({
      resource: this.id,
      action: key,
      state: 'in_progress',
      started_at: startedAt,
      finished_at: null,
      error: null,
    });
    try {
      await this.opts.smolvm.destroy(name);
      this.markActionDone(key);
    } catch (err) {
      const msg = (err as Error).message;
      this.lastError = msg;
      this.markActionError(key, msg);
      log.warn('vm reaper: destroy_machine failed', { name, error: msg });
    }
  }

  private async killWorker(w: BootWorker): Promise<void> {
    const key = `kill_boot_worker:${w.pid}`;
    const startedAt = new Date().toISOString();
    this.pushAction({
      resource: this.id,
      action: key,
      state: 'in_progress',
      started_at: startedAt,
      finished_at: null,
      error: null,
    });
    // SIGTERM. If the process is already gone (ESRCH) treat as success.
    try {
      this.killProcess(w.pid, 'SIGTERM');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ESRCH') {
        this.markActionDone(key);
        return;
      }
      const msg = (err as Error).message;
      this.lastError = msg;
      this.markActionError(key, msg);
      log.warn('vm reaper: SIGTERM failed', { pid: w.pid, vm: w.vmName, error: msg });
      return;
    }
    await delay(this.killGraceMs);
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
        this.markActionError(key, msg);
        log.warn('vm reaper: alive-probe failed', { pid: w.pid, error: msg });
        return;
      }
    }
    if (!alive) {
      this.markActionDone(key);
      return;
    }
    try {
      this.killProcess(w.pid, 'SIGKILL');
      this.markActionDone(key);
      log.info('vm reaper: SIGKILL applied after grace', {
        pid: w.pid,
        vm: w.vmName,
        grace_ms: this.killGraceMs,
      });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ESRCH') {
        this.markActionDone(key);
        return;
      }
      const msg = (err as Error).message;
      this.lastError = msg;
      this.markActionError(key, msg);
      log.warn('vm reaper: SIGKILL failed', { pid: w.pid, vm: w.vmName, error: msg });
    }
  }

  private pushAction(status: ActionStatus): void {
    this.actions.unshift(status);
    if (this.actions.length > MAX_ACTION_HISTORY * 2) {
      this.actions.length = MAX_ACTION_HISTORY * 2;
    }
  }

  private markActionDone(key: string): void {
    const idx = this.actions.findIndex((a) => a.action === key && a.state === 'in_progress');
    const finished = new Date().toISOString();
    if (idx >= 0) {
      this.actions[idx] = { ...this.actions[idx]!, state: 'done', finished_at: finished };
    }
  }

  private markActionError(key: string, error: string): void {
    const idx = this.actions.findIndex((a) => a.action === key && a.state === 'in_progress');
    const finished = new Date().toISOString();
    if (idx >= 0) {
      this.actions[idx] = {
        ...this.actions[idx]!,
        state: 'error',
        finished_at: finished,
        error,
      };
    } else {
      this.pushAction({
        resource: this.id,
        action: key,
        state: 'error',
        started_at: finished,
        finished_at: finished,
        error,
      });
    }
  }
}
