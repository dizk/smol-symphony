// Host-side OAuth ticker — periodically drives a credential refresh so the
// on-demand fallback isn't the only thing keeping the host access token fresh
// during long idle windows.
//
// Under the Gondolin secret-substitution model the work is delegated to the
// credential registry's `refreshAll()` (which fans `refreshAdapter` over every
// live adapter); the registry's per-adapter refresh carries the shared flock +
// single-flight, so concurrent ticks + a per-VM proactive `expiresAt` tick
// collapse into a single host-side refresh.
//
// Lifecycle:
//   start() — install the interval timer. Idempotent.
//   stop()  — clear the timer. Idempotent.

import { log } from '../logging.js';

export interface CredentialTickerOptions {
  /** Refresh cadence in milliseconds. 0 disables the ticker. */
  intervalMs: number;
  /**
   * Drive a host-side refresh of every live adapter's credential. Wired to the
   * `CredentialSecretRegistry` fan-out (`refreshAdapter` over each live adapter)
   * which seeds the per-VM secret managers + carries the flock/single-flight.
   */
  refreshAll: () => Promise<void>;
}

export class CredentialTicker {
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private readonly intervalMs: number;
  private readonly refreshAll: () => Promise<void>;

  constructor(opts: CredentialTickerOptions) {
    this.intervalMs = opts.intervalMs;
    this.refreshAll = opts.refreshAll;
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
      await this.refreshAll();
    } catch (err) {
      log.warn('credential ticker: refresh failed', { error: (err as Error).message });
    }
  }
}
