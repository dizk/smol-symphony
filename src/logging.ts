// Structured key=value logging per SPEC.md §9.1.
// Sink failures do not crash the orchestrator (§9.2).
//
// Persistent file sink: when `setLogFile(path)` has been called, each emitted
// line is appended to that file. The on-disk format matches the stderr format
// (one `key=value ...` line per event) so an agent inspecting logs later sees
// the same shape. File-sink failures are swallowed (one stderr warning on first
// failure, then silent) per §9.2 so a full disk or permission error can never
// crash the orchestrator.
//
// Console routing (issue 118): when a file sink is active, structured lines go
// to the file ONLY — the operator console stays clean and shows just the
// intentional stdout banner. stderr remains the fallback when no file sink is
// configured (nothing is silently lost in a no-log-file setup), and
// `setLogVerbose(true)` (the `--verbose` flag) forces lines back onto stderr
// alongside the file for interactive debugging.

import { closeSync, createWriteStream, mkdirSync, openSync, type WriteStream } from 'node:fs';
import path from 'node:path';

type Level = 'debug' | 'info' | 'warn' | 'error';

const ENV_LEVEL = (process.env.SYMPHONY_LOG_LEVEL ?? 'info').toLowerCase() as Level;
const LEVEL_RANK: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let fileSink: WriteStream | null = null;
let fileSinkBroken = false;
let fileSinkPath: string | null = null;
let verbose = false;

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
  // Route to stderr only when no working file sink is capturing the line
  // (so a no-log-file setup loses nothing) or when --verbose was requested
  // (interactive debugging). A broken sink counts as inactive so its dropped
  // writes fall back to stderr rather than vanishing. See issue 118.
  const fileSinkActive = fileSink !== null && !fileSinkBroken;
  if (verbose || !fileSinkActive) {
    try {
      process.stderr.write(line);
    } catch {
      // Spec §9.2: a failed sink must not crash the service.
    }
  }
  writeFileSink(line);
}

/**
 * Force structured logs back onto stderr even when a file sink is active. The
 * `--verbose` / `--foreground` flag flips this on for interactive debugging;
 * the default (false) keeps the console clean by routing logs to the file only
 * whenever a sink is configured. Idempotent.
 */
export function setLogVerbose(on: boolean): void {
  verbose = on;
}

/**
 * Enable (or replace) the persistent file sink. Pass `null` to close any
 * currently-open file sink and revert to stderr-only.
 *
 * The directory is created on demand. The file is opened synchronously via
 * `openSync` so failures (EISDIR, EACCES, ENOTDIR, ENOSPC) raise before the
 * sink is installed — by the time this returns a non-null path, the file is
 * known to be writable. Open failures do not throw: a single stderr warning
 * is emitted and the function returns `null` so callers can branch without a
 * try/catch. After a successful open, runtime stream errors flip the sink
 * into a broken state (silently dropping further writes) so a mid-run
 * disk-full condition cannot recursively spam stderr.
 *
 * Idempotent for repeated calls with the same path. Returns the absolute path
 * actually opened, or `null` when the sink was disabled or failed to open.
 */
export function setLogFile(filePath: string | null): string | null {
  if (filePath === null || filePath === '') {
    void closeLogFile();
    return null;
  }
  const abs = path.resolve(filePath);
  if (fileSink && fileSinkPath === abs && !fileSinkBroken) return abs;
  void closeLogFile();
  let fd: number;
  try {
    mkdirSync(path.dirname(abs), { recursive: true });
    // Open synchronously so EISDIR / EACCES / ENOTDIR surface here instead of
    // arriving asynchronously on the stream's 'error' event after setLogFile()
    // has already returned the path. Passing the fd into createWriteStream
    // tells Node to reuse it (the stream's close still releases the fd).
    fd = openSync(abs, 'a');
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
  let stream: WriteStream;
  try {
    stream = createWriteStream(abs, { encoding: 'utf8', fd, autoClose: true });
  } catch (err) {
    try {
      closeSync(fd);
    } catch {
      // fd already gone; nothing to do.
    }
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
}

/**
 * Close the file sink and await the underlying stream's flush. Safe to call
 * repeatedly. Callers that intend to `process.exit()` immediately afterwards
 * MUST await this — `process.exit` does not drain pending WriteStream writes,
 * so the final log lines (including the shutdown banner) would otherwise be
 * lost. Tests that read the file back also await.
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
