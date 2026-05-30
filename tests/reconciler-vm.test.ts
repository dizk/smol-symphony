// VM reaper tests (issue 33 / reconciler stage 2; Gondolin migration Phase 4).
// The reaper observes Gondolin's session registry instead of the old
// `machine ls` + `_boot-vm` /proc scraping. Covers the AC scenarios:
//   (a) `gc()` is invoked every pass (Gondolin's STALE/dead-pid + orphan-socket
//       collection — the reaper's first action).
//   (b) a symphony-labelled session NOT in the intended set is a LIVE orphan and
//       is killed by its host pid (SIGTERM, then SIGKILL after grace if it
//       ignores SIGTERM).
//   (c) an intended session is spared.
//   (d) a non-symphony session (or one with no label) is spared.
//
// The tests drive `VmResource` directly with a stubbed session enumerator + gc
// + a recording `killProcess` so they stay hermetic and fast — no real Gondolin
// sessions, no host signals.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  VmResource,
  decideVm,
  type IntendedVmProvider,
  type ReaperSession,
  type VmEffect,
} from '../src/reconciler/vm.js';

// --- shared fixtures ---------------------------------------------------------

// A fixed, deterministic "reaper's own pid" for the harness. Distinct from any
// session pid the tests use, so the self-pid exclusion only fires where a test
// deliberately collides a session pid with it.
const SELF_PID = 99_999;

function provider(names: string[]): IntendedVmProvider {
  return { intendedVmNames: () => new Set(names) };
}

interface FakeSession {
  pid: number;
  label?: string;
  alive: boolean;
  // Should this pid exit on SIGTERM? false = ignore SIGTERM (the grace-test
  // scenario where SIGKILL is required).
  exitsOnSigterm: boolean;
}

interface ReaperHarness {
  signals: Array<{ pid: number; signal: NodeJS.Signals | 0 }>;
  gcCalls: number;
  listSessions: () => Promise<ReaperSession[]>;
  gc: () => Promise<number>;
  killProcess: (pid: number, signal: NodeJS.Signals | 0) => void;
}

// Build the Gondolin-reaper IO surface (listSessions + gc + killProcess) over a
// mutable set of fake sessions. `listSessions` reflects only live sessions, so
// a SIGTERM/SIGKILL that flips `alive` is observable on the next enumeration.
function makeReaperHarness(sessions: FakeSession[]): ReaperHarness {
  const signals: Array<{ pid: number; signal: NodeJS.Signals | 0 }> = [];
  let gcCalls = 0;
  const listSessions = async (): Promise<ReaperSession[]> =>
    sessions.filter((s) => s.alive).map((s) => ({ pid: s.pid, label: s.label }));
  const gc = async (): Promise<number> => {
    gcCalls++;
    return 0;
  };
  const killProcess = (pid: number, signal: NodeJS.Signals | 0): void => {
    signals.push({ pid, signal });
    const s = sessions.find((x) => x.pid === pid);
    if (!s || !s.alive) {
      const err: NodeJS.ErrnoException = new Error('kill ESRCH');
      err.code = 'ESRCH';
      throw err;
    }
    if (signal === 0) return;
    if (signal === 'SIGTERM' && s.exitsOnSigterm) {
      s.alive = false;
      return;
    }
    if (signal === 'SIGKILL') {
      s.alive = false;
    }
  };
  return {
    signals,
    get gcCalls() {
      return gcCalls;
    },
    listSessions,
    gc,
    killProcess,
  };
}

// --- tests -------------------------------------------------------------------

describe('VmResource reaper (Gondolin sessions)', () => {
  it('3 orphan symphony-* sessions not in the intended set → reconciler kills all three by pid', async () => {
    // The 2026-05-22 incident shape, Gondolin edition: live runner processes
    // backing symphony sessions that the orchestrator no longer intends. Each
    // is SIGTERM'd by its host pid — none survive the pass.
    const sessions: FakeSession[] = [
      { pid: 1001, label: 'symphony-1', alive: true, exitsOnSigterm: true },
      { pid: 1002, label: 'symphony-2', alive: true, exitsOnSigterm: true },
      { pid: 1003, label: 'symphony-3', alive: true, exitsOnSigterm: true },
    ];
    const rec = makeReaperHarness(sessions);
    const vm = new VmResource({
      selfPid: SELF_PID,
      intended: provider([]),
      listSessions: rec.listSessions,
      gc: rec.gc,
      killProcess: rec.killProcess,
      killGraceMs: 10,
    });

    await vm.reconcile();

    assert.equal(rec.gcCalls, 1, 'gondolin gc invoked once per pass');
    const sigterm = rec.signals.filter((s) => s.signal === 'SIGTERM').map((s) => s.pid).sort();
    assert.deepEqual(sigterm, [1001, 1002, 1003], 'SIGTERM sent to all three orphan pids');
    assert.deepEqual(
      rec.signals.filter((s) => s.signal === 'SIGKILL'),
      [],
      'no SIGKILL needed when SIGTERM is honored',
    );
    assert.equal(sessions.filter((s) => s.alive).length, 0, 'all three runners exited');
  });

  it('active dispatch for issue 42 + matching session → reconciler leaves it alone', async () => {
    // The race condition the issue body calls out: an in-flight dispatch must
    // appear in the intended set (by its sessionLabel) so the reaper doesn't
    // kill the VM out from under the runner.
    const sessions: FakeSession[] = [
      { pid: 4242, label: 'symphony-42', alive: true, exitsOnSigterm: true },
    ];
    const rec = makeReaperHarness(sessions);
    const vm = new VmResource({
      selfPid: SELF_PID,
      intended: provider(['symphony-42']),
      listSessions: rec.listSessions,
      gc: rec.gc,
      killProcess: rec.killProcess,
      killGraceMs: 10,
    });

    await vm.reconcile();

    assert.equal(rec.gcCalls, 1, 'gc still runs even when nothing is reaped');
    assert.deepEqual(rec.signals, [], 'no signals sent to the active session');
    assert.equal(sessions[0]!.alive, true, 'session stayed alive');
  });

  it('SIGTERM-then-SIGKILL grace: a session that ignores SIGTERM is killed after the grace period', async () => {
    // Issue 33 explicitly requires the grace path: send SIGTERM, wait, then
    // SIGKILL if the process is still alive. This pins the escalation order so
    // a misbehaving runner never accumulates.
    const stubborn: FakeSession = {
      pid: 7777,
      label: 'symphony-stubborn',
      alive: true,
      exitsOnSigterm: false,
    };
    const rec = makeReaperHarness([stubborn]);
    const vm = new VmResource({
      selfPid: SELF_PID,
      intended: provider([]),
      listSessions: rec.listSessions,
      gc: rec.gc,
      killProcess: rec.killProcess,
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

  it('non-symphony and unlabelled sessions are left alone even when not in the intended set', async () => {
    // The reaper owns the `symphony-` namespace and only that namespace. An
    // operator's personal session (`dev-shell`) and a session with no label
    // (a sibling tool's) MUST survive; the symphony-labelled orphan is reaped.
    const sessions: FakeSession[] = [
      { pid: 1, label: 'dev-shell', alive: true, exitsOnSigterm: true },
      { pid: 2, label: undefined, alive: true, exitsOnSigterm: true },
      { pid: 3, label: 'symphony-leak', alive: true, exitsOnSigterm: true },
    ];
    const rec = makeReaperHarness(sessions);
    const vm = new VmResource({
      selfPid: SELF_PID,
      intended: provider([]),
      listSessions: rec.listSessions,
      gc: rec.gc,
      killProcess: rec.killProcess,
      killGraceMs: 10,
    });

    await vm.reconcile();

    assert.equal(sessions[0]!.alive, true, 'dev-shell session untouched');
    assert.equal(sessions[1]!.alive, true, 'unlabelled session untouched');
    assert.equal(sessions[2]!.alive, false, 'symphony-leak got reaped');
    const killedPids = rec.signals.map((s) => s.pid);
    assert.ok(!killedPids.includes(1), 'no signal to dev-shell');
    assert.ok(!killedPids.includes(2), 'no signal to the unlabelled session');
  });

  it('gc is invoked even when there are no sessions to reap', async () => {
    // Gondolin's STALE/dead-pid + orphan-socket collection must run every pass,
    // independent of whether any LIVE orphan exists.
    const rec = makeReaperHarness([]);
    const vm = new VmResource({
      selfPid: SELF_PID,
      intended: provider([]),
      listSessions: rec.listSessions,
      gc: rec.gc,
      killProcess: rec.killProcess,
      killGraceMs: 10,
    });

    await vm.reconcile();

    assert.equal(rec.gcCalls, 1, 'gc ran');
    assert.deepEqual(rec.signals, [], 'no signals when there is nothing to reap');
  });

  it('snapshot reports per-action ledger and last_error', async () => {
    // The dashboard reads from `snapshot()` to surface what the reaper just
    // did. A killProcess that throws a non-ESRCH error (e.g. EPERM on the
    // alive-probe) lands an error in the ledger + last_error.
    const stubborn: FakeSession = {
      pid: 5150,
      label: 'symphony-eperm',
      alive: true,
      exitsOnSigterm: false,
    };
    const rec = makeReaperHarness([stubborn]);
    // Override killProcess: SIGTERM succeeds, but the post-grace alive-probe
    // (signal 0) throws EPERM — surfaced as an error, not silently swallowed.
    const killProcess = (pid: number, signal: NodeJS.Signals | 0): void => {
      rec.signals.push({ pid, signal });
      if (signal === 0) {
        const err: NodeJS.ErrnoException = new Error('operation not permitted');
        err.code = 'EPERM';
        throw err;
      }
    };
    const vm = new VmResource({
      selfPid: SELF_PID,
      intended: provider([]),
      listSessions: rec.listSessions,
      gc: rec.gc,
      killProcess,
      killGraceMs: 10,
    });

    await vm.reconcile();

    const snap = vm.snapshot();
    assert.equal(snap.id, 'vm');
    assert.equal(snap.ready, true, 'vm reaping does not gate dispatch');
    const errAction = snap.actions.find((a) => a.action.includes('5150'));
    assert.ok(errAction, 'failure recorded');
    assert.equal(errAction!.state, 'error');
    assert.match(errAction!.error!, /operation not permitted/);
    assert.match(snap.last_error!, /operation not permitted/);
  });

  it('symphony orphans with unsafe pids (0 / NaN / negative) are never signalled', async () => {
    // codex review HIGH: `process.kill(pid, sig)` signals the whole process
    // GROUP for pid <= 0 and throws on NaN. A never-intended symphony- session
    // carrying such a pid must reach NO host signal — the only thing sparing it
    // is the pid-safety guard (decideVm + the shell's belt-and-suspenders).
    const sessions: FakeSession[] = [
      { pid: 0, label: 'symphony-zero', alive: true, exitsOnSigterm: true },
      { pid: Number.NaN, label: 'symphony-nan', alive: true, exitsOnSigterm: true },
      { pid: -4242, label: 'symphony-neg', alive: true, exitsOnSigterm: true },
    ];
    const rec = makeReaperHarness(sessions);
    const vm = new VmResource({
      selfPid: SELF_PID,
      intended: provider([]),
      listSessions: rec.listSessions,
      gc: rec.gc,
      killProcess: rec.killProcess,
      killGraceMs: 10,
    });

    await vm.reconcile();

    assert.deepEqual(rec.signals, [], 'no host signal sent for any unsafe pid');
  });

  it('a symphony orphan whose pid equals the reaper self pid is never signalled', async () => {
    // codex review HIGH: a label collision / registry surfacing our own pid must
    // not make the orchestrator SIGTERM itself. The session is alive and a
    // never-intended symphony- orphan; only the self-pid exclusion spares it.
    const sessions: FakeSession[] = [
      { pid: SELF_PID, label: 'symphony-self', alive: true, exitsOnSigterm: true },
    ];
    const rec = makeReaperHarness(sessions);
    const vm = new VmResource({
      selfPid: SELF_PID,
      intended: provider([]),
      listSessions: rec.listSessions,
      gc: rec.gc,
      killProcess: rec.killProcess,
      killGraceMs: 10,
    });

    await vm.reconcile();

    assert.deepEqual(rec.signals, [], 'reaper never signals its own pid');
    assert.equal(sessions[0]!.alive, true, 'self session left alive');
  });

  it('a dead (alive:false) symphony session is left to gc() — never signalled as a live orphan', async () => {
    // codex review MEDIUM: a STALE (dead-pid) session whose recorded pid may
    // have been REUSED by an unrelated host process must never be SIGTERM'd.
    // The shell forwards only `alive === true` sessions to the core; gc() owns
    // the dead ones. Here a live orphan and a dead orphan share the pass: only
    // the live one is reaped, the dead one's pid is never signalled.
    const sessions: FakeSession[] = [
      { pid: 3030, label: 'symphony-dead', alive: false, exitsOnSigterm: true },
      { pid: 4040, label: 'symphony-live', alive: true, exitsOnSigterm: true },
    ];
    const rec = makeReaperHarness(sessions);
    const vm = new VmResource({
      selfPid: SELF_PID,
      intended: provider([]),
      listSessions: rec.listSessions,
      gc: rec.gc,
      killProcess: rec.killProcess,
      killGraceMs: 10,
    });

    await vm.reconcile();

    const killedPids = rec.signals.map((sig) => sig.pid);
    assert.ok(!killedPids.includes(3030), 'dead session pid never signalled (gc owns it)');
    const sigterm = rec.signals.filter((sig) => sig.signal === 'SIGTERM').map((sig) => sig.pid);
    assert.deepEqual(sigterm, [4040], 'the live orphan is still reaped');
    assert.equal(sessions[1]!.alive, false, 'live orphan exited on SIGTERM');
  });
});

// Pure `decideVm` tests (issue 69). The class-level tests above exercise the
// shell loop end-to-end; these pin the pure decision in isolation.
describe('decideVm (pure)', () => {
  // The pure decision now consumes `selfPid` to exclude the reaper's own
  // process. Pick a value that never collides with any session pid below, so
  // the self-pid path only fires in the test that deliberately collides.
  const PURE_SELF_PID = 88_888;
  const s = (pid: number, label?: string): ReaperSession => ({ pid, label });

  it('empty observed state → no effects', () => {
    assert.deepEqual(decideVm({ intended: new Set(), sessions: [], selfPid: PURE_SELF_PID }), []);
  });

  it('non-symphony and unlabelled sessions are left untouched', () => {
    // The reaper owns only the `symphony-` namespace; an operator's personal
    // session, a sibling tool's labelled session, or one with no label must
    // never appear in the effect list.
    assert.deepEqual(
      decideVm({
        intended: new Set(),
        sessions: [s(1, 'dev-shell'), s(2, 'operator-vm'), s(3, undefined)],
        selfPid: PURE_SELF_PID,
      }),
      [],
    );
  });

  it('case-sensitive prefix: SYMPHONY-* (uppercase) is not the symphony- namespace', () => {
    assert.deepEqual(
      decideVm({ intended: new Set(), sessions: [s(1, 'SYMPHONY-upper')], selfPid: PURE_SELF_PID }),
      [],
    );
  });

  it('mixed: stray symphony session + intended match → only the stray', () => {
    const effects = decideVm({
      intended: new Set(['symphony-keep']),
      sessions: [s(101, 'symphony-keep'), s(202, 'symphony-orphan')],
      selfPid: PURE_SELF_PID,
    });
    const expected: VmEffect[] = [{ kind: 'kill_session', pid: 202, label: 'symphony-orphan' }];
    assert.deepEqual(effects, expected);
  });

  it('symphony-labelled orphan with an unsafe pid (0 / NaN / negative) is NOT killed', () => {
    // `process.kill(pid, sig)` signals the whole PROCESS GROUP for pid <= 0 and
    // throws on NaN — a registry anomaly must never produce a kill effect.
    // Each of these has a never-intended symphony- label, so the ONLY thing
    // sparing them is the pid-safety guard.
    assert.deepEqual(
      decideVm({
        intended: new Set(),
        sessions: [
          s(0, 'symphony-zero'),
          s(Number.NaN, 'symphony-nan'),
          s(-4242, 'symphony-neg'),
        ],
        selfPid: PURE_SELF_PID,
      }),
      [],
      'no kill_session emitted for pid 0 / NaN / negative',
    );
  });

  it("a symphony orphan whose pid equals selfPid is NOT killed (don't signal ourselves)", () => {
    // A label collision (or a registry that surfaced our own pid) must never
    // make the orchestrator SIGTERM itself.
    assert.deepEqual(
      decideVm({
        intended: new Set(),
        sessions: [s(PURE_SELF_PID, 'symphony-self')],
        selfPid: PURE_SELF_PID,
      }),
      [],
      'self pid is excluded even with a never-intended symphony- label',
    );
  });

  it('is pure: same input → same output, no input mutation', () => {
    const intended = new Set(['symphony-keep']);
    const observed = { intended, sessions: [s(1, 'symphony-orphan')], selfPid: PURE_SELF_PID };
    const first = decideVm(observed);
    const second = decideVm(observed);
    assert.deepEqual(first, second);
    assert.equal(intended.size, 1, 'intended set unchanged');
  });
});
