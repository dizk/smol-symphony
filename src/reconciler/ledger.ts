// Shared action ledger for reconciler resources (issue 43).
//
// Each resource (bake, vm, workspace, pr, …) carries a most-recent-first buffer
// of `ActionStatus` rows so the dashboard can render "what is this resource
// currently doing / what did it just try." Every resource used to inline its
// own copy of the push/done/error/snapshot plumbing — four identical
// implementations modulo the action-key shape (bake keys by hash, the rest key
// by an opaque string). This module centralizes that plumbing so adding a new
// ledger field (per-action duration, structured logging, ring-buffer policy)
// is a one-file change.
//
// Semantics preserved verbatim from the prior inline implementations:
//   • start(action)  — unshifts an `in_progress` row.
//   • done(action)   — flips the most-recent matching `in_progress` row to
//                      `done`. Idempotent: a second call (or a call with no
//                      matching row) is a no-op.
//   • error(action)  — flips the matching `in_progress` row to `error`; when
//                      no in-progress row exists, pushes a fresh orphan-error
//                      row with `started_at === finished_at`.
//   • record(action) — pushes a one-shot already-terminal annotation (used by
//                      workspace's mark_stale/mark_stuck and the vm reaper's
//                      kill_session path).
//   • run(action, fn) — convenience wrapper: start → await → done/error.
//
// The buffer is capped at `maxHistory * 2` rows; `snapshot()` exposes the
// first `maxHistory` for the dashboard. The over-cap headroom matches the
// pre-refactor behavior: the underlying array keeps a small lookback for
// late-arriving `done`/`error` calls whose `in_progress` row was created
// shortly before a flood of newer actions.

import type { ActionStatus } from './types.js';

export interface LedgerOptions {
  /** Wall-clock injection point (tests pin time). Defaults to `Date.now`. */
  now?: () => number;
  /**
   * Snapshot slice cap (default 32). Matches what each resource exposed as its
   * private `MAX_ACTION_HISTORY` before this refactor: bake = 8, vm = 32,
   * workspace = 32, pr = 64. Each call site passes its prior cap so snapshot
   * payload shapes are unchanged.
   */
  maxHistory?: number;
}

const DEFAULT_MAX_HISTORY = 32;

export class ResourceActionLedger {
  private readonly resource: string;
  private readonly nowFn: () => number;
  private readonly maxHistory: number;
  private readonly buf: ActionStatus[] = [];

  constructor(resource: string, opts: LedgerOptions = {}) {
    this.resource = resource;
    this.nowFn = opts.now ?? (() => Date.now());
    this.maxHistory = opts.maxHistory ?? DEFAULT_MAX_HISTORY;
  }

  start(action: string): void {
    this.push({
      resource: this.resource,
      action,
      state: 'in_progress',
      started_at: this.iso(),
      finished_at: null,
      error: null,
    });
  }

  done(action: string): void {
    const idx = this.findInProgress(action);
    if (idx < 0) return;
    this.buf[idx] = { ...this.buf[idx]!, state: 'done', finished_at: this.iso() };
  }

  error(action: string, msg: string): void {
    const idx = this.findInProgress(action);
    const finished = this.iso();
    if (idx >= 0) {
      this.buf[idx] = {
        ...this.buf[idx]!,
        state: 'error',
        finished_at: finished,
        error: msg,
      };
      return;
    }
    this.push({
      resource: this.resource,
      action,
      state: 'error',
      started_at: finished,
      finished_at: finished,
      error: msg,
    });
  }

  /**
   * One-shot terminal annotation. The action is pushed already-finished;
   * `started_at === finished_at`. Used for state that has no meaningful
   * in-progress phase (workspace drift annotations, vm kill_session errors).
   */
  record(action: string, state: 'done' | 'error', error: string | null = null): void {
    const now = this.iso();
    this.push({
      resource: this.resource,
      action,
      state,
      started_at: now,
      finished_at: now,
      error,
    });
  }

  /**
   * Convenience: start the action, await the promise, then done/error based on
   * outcome. Returns the wrapped result so callers can still branch on the
   * value or message without rethrowing. Errors are converted to their
   * `.message` string — matching every existing resource's `(err as Error).message`
   * extraction.
   */
  async run<T>(
    action: string,
    fn: () => Promise<T>,
  ): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
    this.start(action);
    try {
      const value = await fn();
      this.done(action);
      return { ok: true, value };
    } catch (err) {
      const msg = (err as Error).message;
      this.error(action, msg);
      return { ok: false, error: msg };
    }
  }

  /** Most-recent-first slice of action statuses, capped at `maxItems`. */
  snapshot(maxItems?: number): ActionStatus[] {
    return this.buf.slice(0, maxItems ?? this.maxHistory);
  }

  private findInProgress(action: string): number {
    return this.buf.findIndex((a) => a.action === action && a.state === 'in_progress');
  }

  private push(status: ActionStatus): void {
    this.buf.unshift(status);
    if (this.buf.length > this.maxHistory * 2) {
      this.buf.length = this.maxHistory * 2;
    }
  }

  private iso(): string {
    return new Date(this.nowFn()).toISOString();
  }
}
