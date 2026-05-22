// Host memory probe used by the orchestrator's memory-aware admission cap.
//
// Issue 26 OOM was diagnosed as leaked VMs across process restarts and the leak itself
// is fixed by start/stop reaping. This module adds a defense-in-depth backstop so that
// an operator who raises `agent.max_concurrent_agents` on a memory-constrained host
// still won't dispatch more VMs than the host can fit. We read MemAvailable from
// `/proc/meminfo` and the orchestrator clamps the effective slot count to
// `running + floor((MemAvailable - reserve) / smolvm.mem_mib)`.
//
// `/proc/meminfo` is Linux-only (smolvm itself is Linux-only, but the orchestrator
// codebase is portable enough that running `npm test` on macOS shouldn't trip the
// probe). On any platform where the file is missing or unreadable, the probe
// returns null and the orchestrator falls back to the static cap.

import { readFileSync } from 'node:fs';

export interface MemorySnapshot {
  /** MemAvailable from /proc/meminfo, in MiB. Null when the file is missing or unparseable. */
  mem_available_mib: number | null;
  /** True when the host exposes /proc/meminfo. Lets the dashboard distinguish "probe disabled / unsupported" from "probe ran but read zero." */
  supported: boolean;
}

export type MemProbe = () => MemorySnapshot;

const PROC_MEMINFO = '/proc/meminfo';

/**
 * Parse a `/proc/meminfo` body and pull out `MemAvailable`. The kernel emits the value in
 * KiB (`MemAvailable:    12345678 kB`); we return MiB for symmetry with `smolvm.mem_mib`
 * and `host_memory_reserve_mib`. Returns null if the line is missing or unparseable —
 * the orchestrator treats that the same as the probe being unsupported and falls back
 * to the static cap.
 */
export function parseMemAvailableMib(meminfo: string): number | null {
  const match = meminfo.match(/^MemAvailable:\s+(\d+)\s*kB\s*$/m);
  if (!match) return null;
  const kb = parseInt(match[1]!, 10);
  if (!Number.isFinite(kb)) return null;
  return Math.floor(kb / 1024);
}

/**
 * Default probe — synchronously reads `/proc/meminfo`. The file is a kernel-served
 * virtual file (no disk I/O); reads are microsecond-cheap and we run it once per tick.
 * On any read or parse failure the probe returns `supported: false` so the orchestrator
 * falls back to the static cap rather than dropping to zero on a transient error.
 */
export const defaultMemProbe: MemProbe = () => {
  let body: string;
  try {
    body = readFileSync(PROC_MEMINFO, 'utf8');
  } catch {
    return { mem_available_mib: null, supported: false };
  }
  const mib = parseMemAvailableMib(body);
  if (mib === null) {
    // File exists but the line is missing or malformed — treat as supported-but-empty
    // so the operator sees "probe ran, no value" in the dashboard rather than a silent
    // fallback. The orchestrator's clamp treats null as "skip the clamp."
    return { mem_available_mib: null, supported: true };
  }
  return { mem_available_mib: mib, supported: true };
};

/**
 * Compute the memory-admission summary used by both the orchestrator's slot accounting
 * and the snapshot endpoint. Kept pure so callers (and tests) can feed it any combination
 * of static cap, probe result, running count, reserve, and per-VM size.
 *
 * The effective cap is `min(static_cap, running + admission_room)` where
 * `admission_room = max(0, floor((MemAvailable - reserve) / per_vm))`. We add `running`
 * because MemAvailable already reflects the memory the running VMs are using —
 * `admission_room` is therefore the count of *additional* VMs that fit, and adding the
 * current running count gives the total cap consistent with the static one.
 *
 * When the probe is disabled, unsupported, or returned a null reading, the effective cap
 * is the static cap unchanged. Callers see `clamp_active=false` in that case so the
 * dashboard can show "memory admission off" vs "probe is gating dispatch."
 */
export function computeMemoryAdmission(args: {
  enabled: boolean;
  static_cap: number;
  running: number;
  probe: MemorySnapshot;
  reserve_mib: number;
  per_vm_mib: number;
}): {
  effective_cap: number;
  admission_room: number | null;
  clamp_active: boolean;
} {
  const { enabled, static_cap, running, probe, reserve_mib, per_vm_mib } = args;
  if (!enabled || probe.mem_available_mib === null || per_vm_mib <= 0) {
    return { effective_cap: static_cap, admission_room: null, clamp_active: false };
  }
  const headroom = probe.mem_available_mib - reserve_mib;
  const room = headroom <= 0 ? 0 : Math.floor(headroom / per_vm_mib);
  const memoryCap = running + room;
  const effective = Math.min(static_cap, memoryCap);
  return {
    effective_cap: effective,
    admission_room: room,
    clamp_active: memoryCap < static_cap,
  };
}
