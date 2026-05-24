// Structured key=value logging to stderr per SPEC.md §9.1.
// Sink failures do not crash the orchestrator (§9.2).
//
// Optional persistent file sink: when `setLogFile(path)` has been called, each
// emitted line is appended to that file in addition to stderr. The on-disk
// format matches the stderr format (one `key=value ...` line per event) so an
// agent inspecting logs later sees the same shape it sees on stderr. File-sink
// failures are swallowed (one stderr warning on first failure, then silent)
// per §9.2 so a full disk or permission error can never crash the orchestrator.

import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import path from 'node:path';

type Level = 'debug' | 'info' | 'warn' | 'error';

const ENV_LEVEL = (process.env.SYMPHONY_LOG_LEVEL ?? 'info').toLowerCase() as Level;
const LEVEL_RANK: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let fileSink: WriteStream | null = null;
let fileSinkBroken = false;
let fileSinkPath: string | null = null;

function quote(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[\s"=]/.test(s) ? JSON.stringify(s) : s;
}

function format(level: Level, msg: string, fields: Record<string, unknown>): string {
  const ts = new Date().toISOString();
  const parts = [`ts=${ts}`, `level=${level}`, `msg=${quote(msg)}`];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    parts.push(`${k}=${quote(v)}`);
  }
  return parts.join(' ');
}

function writeFileSink(line: string): void {
  if (!fileSink || fileSinkBroken) return;
  try {
    fileSink.write(line);
  } catch {
    // Stream errors land in the 'error' handler attached in setLogFile; a
    // synchronous throw is unusual but not impossible — swallow it.
  }
}

function emit(level: Level, msg: string, fields: Record<string, unknown> = {}) {
  if (LEVEL_RANK[level] < LEVEL_RANK[ENV_LEVEL]) return;
  const line = format(level, msg, fields) + '\n';
  try {
    process.stderr.write(line);
  } catch {
    // Spec §9.2: a failed sink must not crash the service.
  }
  writeFileSink(line);
}

/**
 * Enable (or replace) the persistent file sink. Pass `null` to close any
 * currently-open file sink and revert to stderr-only.
 *
 * The directory is created on demand. If the file cannot be opened, the call
 * itself does not throw — a single stderr warning is emitted and subsequent
 * logs continue to flow to stderr only. After a successful open, runtime
 * stream errors flip the sink into a broken state (silently dropping further
 * writes) so a mid-run disk-full condition cannot recursively spam stderr.
 *
 * Idempotent for repeated calls with the same path. Returns the absolute path
 * actually opened, or `null` when the sink was disabled or failed to open.
 */
export function setLogFile(filePath: string | null): string | null {
  if (filePath === null || filePath === '') {
    closeLogFile();
    return null;
  }
  const abs = path.resolve(filePath);
  if (fileSink && fileSinkPath === abs && !fileSinkBroken) return abs;
  closeLogFile();
  try {
    mkdirSync(path.dirname(abs), { recursive: true });
    const stream = createWriteStream(abs, { flags: 'a', encoding: 'utf8' });
    stream.on('error', (err) => {
      if (!fileSinkBroken) {
        fileSinkBroken = true;
        try {
          process.stderr.write(
            format('warn', 'log file sink write failed', { path: abs, error: err.message }) + '\n',
          );
        } catch {
          // stderr itself failed; nothing left to do.
        }
      }
    });
    fileSink = stream;
    fileSinkPath = abs;
    fileSinkBroken = false;
    return abs;
  } catch (err) {
    try {
      process.stderr.write(
        format('warn', 'log file sink open failed', { path: abs, error: (err as Error).message }) +
          '\n',
      );
    } catch {
      // stderr itself failed; nothing left to do.
    }
    fileSink = null;
    fileSinkPath = null;
    fileSinkBroken = false;
    return null;
  }
}

/**
 * Close the file sink and await the underlying stream's flush. Safe to call
 * repeatedly. The orchestrator's signal-shutdown path does not need to await
 * this (process.exit flushes); tests that read the file back must.
 */
export async function closeLogFile(): Promise<void> {
  const sink = fileSink;
  fileSink = null;
  fileSinkPath = null;
  fileSinkBroken = false;
  if (!sink) return;
  await new Promise<void>((resolve) => {
    try {
      sink.end(() => resolve());
    } catch {
      resolve();
    }
  });
}

export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) => emit('debug', msg, fields ?? {}),
  info: (msg: string, fields?: Record<string, unknown>) => emit('info', msg, fields ?? {}),
  warn: (msg: string, fields?: Record<string, unknown>) => emit('warn', msg, fields ?? {}),
  error: (msg: string, fields?: Record<string, unknown>) => emit('error', msg, fields ?? {}),
};

export interface IssueLogContext {
  issue_id?: string;
  issue_identifier?: string;
  session_id?: string;
}

export function withIssue(ctx: IssueLogContext) {
  return {
    debug: (msg: string, fields: Record<string, unknown> = {}) => log.debug(msg, { ...ctx, ...fields }),
    info: (msg: string, fields: Record<string, unknown> = {}) => log.info(msg, { ...ctx, ...fields }),
    warn: (msg: string, fields: Record<string, unknown> = {}) => log.warn(msg, { ...ctx, ...fields }),
    error: (msg: string, fields: Record<string, unknown> = {}) => log.error(msg, { ...ctx, ...fields }),
  };
}
