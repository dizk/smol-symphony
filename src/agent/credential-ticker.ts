// Host-side OAuth ticker — periodically nudges Claude Code into refreshing
// the cached access token so the credential proxy's on-demand fallback isn't
// the only thing keeping `~/.claude/.credentials.json` fresh during long
// idle windows. Belt to the proxy's braces.
//
// The work is delegated to the proxy's own `refreshNow()` so both paths
// share one flock and one in-process single-flight — concurrent ticks +
// on-demand refresh from a VM request collapse into a single `claude -p`.
//
// Lifecycle:
//   start() — install the interval timer. Idempotent.
//   stop()  — clear the timer. Idempotent.

import { log } from '../logging.js';
import type { CredentialProxy } from './credential-proxy.js';

export interface CredentialTickerOptions {
  /** Refresh cadence in milliseconds. 0 disables the ticker. */
  intervalMs: number;
  /** Proxy whose `refreshNow()` carries the shared flock + single-flight. */
  proxy: CredentialProxy;
}

export class CredentialTicker {
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private readonly intervalMs: number;
  private readonly proxy: CredentialProxy;

  constructor(opts: CredentialTickerOptions) {
    this.intervalMs = opts.intervalMs;
    this.proxy = opts.proxy;
  }

  start(): void {
    if (this.timer || this.stopped) return;
    if (this.intervalMs <= 0) {
      log.info('credential ticker disabled (interval_ms <= 0)');
      return;
    }
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    // Don't prevent process shutdown on the ticker — the lifecycle is owned
    // by `stop()` below, but if a future code path drops the reference, we
    // shouldn't keep the event loop alive.
    if (typeof this.timer.unref === 'function') this.timer.unref();
    log.info('credential ticker started', { interval_ms: this.intervalMs });
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    try {
      await this.proxy.refreshNow();
    } catch (err) {
      log.warn('credential ticker: refresh failed', { error: (err as Error).message });
    }
  }
}
