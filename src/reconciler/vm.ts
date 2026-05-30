// VM reaper resource (issue 33 / reconciler stage 2; Gondolin migration Phase 4).
// Owns the lifecycle of `symphony-*` VMs: anything outside the orchestrator's
// intended set is an orphan and gets reaped.
//
// Observation source = Gondolin's session registry, NOT the smolvm machine
// registry + `_boot-vm` /proc scraping. Gondolin owns one host runner process
// per VM and tracks it in a session registry keyed by uuid, carrying the
// `sessionLabel` the orchestrator minted (`symphony-<identifier>`) and the host
// `pid`. The reaper reaps in two complementary ways:
//
//   1. STALE sessions (dead-pid orphans + orphan socket files) are collected by
//      Gondolin's own `gc()` — the shell calls it at the start of each pass.
//      This subsumes the old "`machine delete -f` succeeded but left the worker
//      alive" cleanup: Gondolin reconciles its own registry against live pids.
//   2. LIVE orphans — a session whose host process is still alive but whose
//      `symphony-` label is NOT in the intended set (a botched teardown, or a
//      SIGKILL'd symphony whose runner child survived) — are reaped HERE by
//      SIGTERM→SIGKILL on the host `pid`. `gc()` can't touch these because the
//      pid is alive; only the orchestrator knows the intended set.
//
// Label safety: a session with no label, or a label outside the
// `symphony-` namespace (an operator's own VM, a sibling tool's session), is
// never touched. The reaper acts only on confidently-symphony-owned, never-
// intended sessions.
//
// Effects-as-data (issue 69): the decision of WHAT to do is a pure function
// (`decideVm`) of the observed session state; HOW it's done (Gondolin gc,
// listSessions, process.kill, sleep) is the shell's job. This module is
// import-pure: no `node:fs`, no timers, no adapter imports. The reaper's local
// session shape (`ReaperSession`) is declared here — mirroring the existing
// `VmRegistryPort` local-interface convention — so vm.ts never reaches for the
// concrete `VmClient` adapter or the `vm-port` module; the shell adapts
// `VmClient.listSessions()` → `ReaperSession[]`.

import { log } from '../logging.js';
import { ResourceActionLedger } from './ledger.js';
import type { KillSessionAction, ResourceSnapshot } from './types.js';

// Domain constant. Every VM the orchestrator creates is labelled with this
// prefix (the runner mints `sessionLabel = symphony-<identifier>`); the reaper
// only acts on labels that match. The vm-port adapter mirrors the same value —
// keep them in sync.
export const SYMPHONY_VM_PREFIX = 'symphony-';

const DEFAULT_KILL_GRACE_MS = 3_000;
const MAX_ACTION_HISTORY = 32;

/**
 * Source of the orchestrator's currently-intended VM set. Returned each
 * reconcile pass so the reaper sees the latest snapshot of running +
 * about-to-be-allocated dispatches. The reaper compares this against the
 * Gondolin session set (filtered by `SYMPHONY_VM_PREFIX`) and reaps the
 * difference. The intended names ARE the session labels: the orchestrator's
 * `intendedVmNames()` returns one `symphony-<identifier>` per running dispatch,
 * matching the `sessionLabel` the runner minted for that dispatch.
 */
export interface IntendedVmProvider {
  intendedVmNames(): Set<string>;
}

/**
 * Minimal Gondolin session surface the reaper consumes. Subset of `VmSession`
 * (`agent/vm-port.ts`); declared locally so vm.ts stays adapter- and
 * port-import-free (same convention as the old `VmRegistryPort`). The shell
 * (`./index.ts`) adapts `VmClient.listSessions()` into this shape.
 */
export interface ReaperSession {
  /** Host pid of the Gondolin runner process backing this session. */
  pid: number;
  /** The orchestrator-minted `sessionLabel`, when set. Absent ⇒ left alone. */
  label?: string;
}

/**
 * Reaper IO surface, injected by the shell. `gc` collects STALE sessions
 * (dead-pid orphans + orphan sockets) — Gondolin's own registry reconciliation.
 * `listSessions` enumerates the live session set the pure decision compares
 * against the intended set. `killProcess` sends a host signal.
 */
export interface VmResourceOptions {
  intended: IntendedVmProvider;
  /**
   * Gondolin session GC. Collects STALE sessions (dead-pid orphans) and orphan
   * socket files; returns the count reaped. Run first each pass so the
   * subsequent `listSessions` only surfaces live sessions. Production wiring
   * delegates to `VmClient.gc()`.
   */
  gc: () => Promise<number>;
  /**
   * Enumerate the host's Gondolin sessions. Production wiring adapts
   * `VmClient.listSessions()` → `ReaperSession[]` in `./index.ts`.
   */
  listSessions: () => Promise<ReaperSession[]>;
  /**
   * Send a signal to a host PID. Production wiring delegates to `process.kill`
   * in `./index.ts`. Receivers throw nothing on success and ESRCH/EPERM via
   * a thrown Error on failure.
   */
  killProcess: (pid: number, signal: NodeJS.Signals | 0) => void;
  /**
   * SIGTERM-to-SIGKILL grace period (ms). A session runner that ignores SIGTERM
   * is SIGKILL'd after this delay. Default 3s; tests pass a small value so the
   * grace path is observable in fast suites.
   */
  killGraceMs?: number;
}

/**
 * Snapshot of every input `decideVm` needs. Populated by the shell's
 * observation pass — `decideVm` is a pure function of this record.
 */
export interface VmObservedState {
  /** Labels the orchestrator wants to keep alive (current dispatch set). */
  intended: ReadonlySet<string>;
  /** Live Gondolin sessions on the host (`listSessions`, post-`gc`). */
  sessions: readonly ReaperSession[];
}

/**
 * Reaper effect, applied by the shell. Reuses the typed action record from
 * `./types.ts` so the dashboard's existing `ReconcilerAction` taxonomy doubles
 * as the effect language.
 */
export type VmEffect = KillSessionAction;

/**
 * Pure decision: given the observed Gondolin session state, return the effects
 * the shell should apply. No IO, no clock reads, no logging.
 *
 * Effect rule:
 *   • Session has a `label` that starts with SYMPHONY_VM_PREFIX and isn't
 *     intended → `kill_session` (SIGTERM→SIGKILL its host pid).
 *
 * Anything outside the symphony-prefixed namespace — a session with no label,
 * or a label that doesn't start with the prefix — is left untouched (operator
 * VMs, sibling tools' sessions). STALE/dead-pid sessions and orphan sockets are
 * NOT this function's concern; Gondolin's `gc()` collects them in the shell
 * before the live session set reaches here.
 */
export function decideVm(state: VmObservedState): VmEffect[] {
  const out: VmEffect[] = [];
  for (const s of state.sessions) {
    const label = s.label;
    if (label === undefined) continue;
    if (!label.startsWith(SYMPHONY_VM_PREFIX)) continue;
    if (state.intended.has(label)) continue;
    out.push({ kind: 'kill_session', pid: s.pid, label });
  }
  return out;
}

/**
 * VM resource. Desired = orchestrator's intended VM (session-label) set.
 * Actual = Gondolin's live session set (filtered by `symphony-` label).
 * `reconcile()` is the thin shell loop: gc → observe → `decideVm` → apply.
 *
 * Independent of bake (`dependsOn: []`). Doesn't gate dispatch.
 */
export class VmResource {
  readonly id = 'vm';
  readonly dependsOn: string[] = [];

  private readonly gc: () => Promise<number>;
  private readonly listSessions: () => Promise<ReaperSession[]>;
  private readonly killProcess: (pid: number, signal: NodeJS.Signals | 0) => void;
  private readonly killGraceMs: number;

  private readonly ledger = new ResourceActionLedger(this.id, { maxHistory: MAX_ACTION_HISTORY });
  private lastError: string | null = null;

  constructor(private readonly opts: VmResourceOptions) {
    this.gc = opts.gc;
    this.listSessions = opts.listSessions;
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

    // Gondolin's own GC first: collect STALE (dead-pid) sessions + orphan
    // sockets. This subsumes the old smolvm "worker survived the daemon
    // destroy" cleanup — Gondolin reconciles its registry against live pids.
    await this.runGc();

    // Now enumerate the LIVE session set. `decideVm` compares it against the
    // intended set; survivors with a never-intended `symphony-` label are
    // LIVE orphans (alive pid, so gc() can't reach them) and get SIGTERM'd.
    const sessions = await this.observeSessions();
    const effects = decideVm({ intended: desired, sessions });
    if (effects.length === 0) return;

    log.info('vm reaper: killing orphan sessions', { orphans: effects.length });
    await Promise.all(effects.map((e) => this.killSession(e)));
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

  private async runGc(): Promise<void> {
    try {
      const reaped = await this.gc();
      if (reaped > 0) log.info('vm reaper: gondolin gc collected stale sessions', { reaped });
    } catch (err) {
      const msg = (err as Error).message;
      this.lastError = `gondolin gc failed: ${msg}`;
      log.warn('vm reaper: gondolin gc failed', { error: msg });
    }
  }

  private async observeSessions(): Promise<ReaperSession[]> {
    try {
      return await this.listSessions();
    } catch (err) {
      const msg = (err as Error).message;
      this.lastError = `session enumeration failed: ${msg}`;
      log.warn('vm reaper: session enumeration failed', { error: msg });
      return [];
    }
  }

  private async killSession(e: KillSessionAction): Promise<void> {
    const key = `kill_session:${e.pid}`;
    this.ledger.start(key);
    // SIGTERM. If the process is already gone (ESRCH) treat as success.
    try {
      this.killProcess(e.pid, 'SIGTERM');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ESRCH') {
        this.ledger.done(key);
        return;
      }
      const msg = (err as Error).message;
      this.lastError = msg;
      this.ledger.error(key, msg);
      log.warn('vm reaper: SIGTERM failed', { pid: e.pid, label: e.label, error: msg });
      return;
    }
    // Inline timer (rather than `node:timers/promises`) keeps the file
    // adapter-import-free for the functional-core lint.
    await new Promise<void>((resolve) => { setTimeout(resolve, this.killGraceMs); });
    // Probe with signal 0 — throws ESRCH if the process has exited. If it's
    // still alive, escalate to SIGKILL.
    let alive = false;
    try {
      this.killProcess(e.pid, 0);
      alive = true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ESRCH') {
        // EPERM and friends — assume alive but unkillable; surface as an error.
        const msg = (err as Error).message;
        this.lastError = msg;
        this.ledger.error(key, msg);
        log.warn('vm reaper: alive-probe failed', { pid: e.pid, error: msg });
        return;
      }
    }
    if (!alive) {
      this.ledger.done(key);
      return;
    }
    try {
      this.killProcess(e.pid, 'SIGKILL');
      this.ledger.done(key);
      log.info('vm reaper: SIGKILL applied after grace', {
        pid: e.pid,
        label: e.label,
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
      log.warn('vm reaper: SIGKILL failed', { pid: e.pid, label: e.label, error: msg });
    }
  }
}
