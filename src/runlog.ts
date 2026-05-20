// Per-issue JSONL run log. Captures everything crossing the host/VM boundary plus host-side
// hook output, so a later evaluation pass (likely another in-VM agent) can replay a run end
// to end. One file per issue, appended forever; each entry is a self-describing JSON object.
//
// Schema (one of):
//   { ts, issue_id, attempt, channel: "acp", direction: "host_to_vm"|"vm_to_host", frame: <parsed JSON-RPC> }
//   { ts, issue_id, attempt, channel: "acp", direction: ..., kind: "unparseable", raw: <string> }
//   { ts, issue_id, attempt, channel: "stderr", text }
//   { ts, issue_id, attempt, channel: "system", event, fields? }
//   { ts, issue_id, attempt, channel: "hook", hook, stream: "stdout"|"stderr", text }
//   { ts, issue_id, attempt, channel: "hook", hook, kind: "result", exit_code, signal, timed_out }
//
// Writes are best-effort: a write failure is swallowed so it can never crash the orchestrator
// (consistent with logging.ts §13.2). Streams are opened in append mode so concurrent symphony
// processes or restarts append safely to the same file.

import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import path from 'node:path';
import { sanitizeWorkspaceKey } from './workspace.js';
import { log } from './logging.js';

export type RunLogChannel = 'acp' | 'stderr' | 'system' | 'hook';

export interface RunLogBaseEntry {
  channel: RunLogChannel;
  [key: string]: unknown;
}

export class RunLog {
  private stream: WriteStream;
  private currentAttempt = 0;
  // Once a stream error fires we stop trying to write. The first error is logged at warn;
  // subsequent attempts are silently dropped (prevents log spam if disk is full).
  private broken = false;

  /**
   * `issueId` is the tracker's primary key (e.g. the local tracker's front-matter `id`)
   * and is what each JSONL line is stamped with. `identifier` is the filename-safe display
   * id (e.g. `ABC-123`) and is only used to derive the file path. The two coincide for
   * local trackers today but MUST be kept separate so downstream evaluators can correlate
   * by tracker id even on trackers where the values diverge.
   */
  constructor(
    private readonly filePath: string,
    private readonly issueId: string,
    private readonly identifier: string,
  ) {
    this.stream = createWriteStream(filePath, { flags: 'a', encoding: 'utf8' });
    this.stream.on('error', (err) => {
      if (!this.broken) {
        this.broken = true;
        log.warn('runlog write failed', {
          issue_id: this.issueId,
          issue_identifier: this.identifier,
          error: err.message,
        });
      }
    });
  }

  setAttempt(n: number): void {
    this.currentAttempt = n;
  }

  attempt(): number {
    return this.currentAttempt;
  }

  /**
   * Append one entry. `ts`, `issue_id`, `issue_identifier`, and `attempt` are stamped
   * automatically and override any same-named field on the entry, so callers cannot
   * accidentally backdate or mislabel lines. Returns nothing — writes are best-effort.
   *
   * The spread order below intentionally puts the auto-stamped fields AFTER the caller's
   * entry so they win over any same-named keys the caller (often passing arbitrary fields
   * for ad-hoc events) accidentally supplied. Reversing this would silently corrupt the
   * canonical correlation identifiers downstream evaluation depends on.
   */
  record(entry: RunLogBaseEntry): void {
    if (this.broken) return;
    const stamped = {
      ...entry,
      ts: new Date().toISOString(),
      issue_id: this.issueId,
      issue_identifier: this.identifier,
      attempt: this.currentAttempt,
    };
    let line: string;
    try {
      line = JSON.stringify(stamped);
    } catch (err) {
      log.warn('runlog serialize failed', { issue_id: this.issueId, error: (err as Error).message });
      return;
    }
    try {
      this.stream.write(line + '\n');
    } catch {
      // Stream errors land in the 'error' handler. A synchronous throw here is unusual but
      // not impossible (e.g. if the stream is in an invalid state); silence it.
    }
  }

  /** Convenience: emit a `channel: "system"` event. */
  system(event: string, fields?: Record<string, unknown>): void {
    this.record({ channel: 'system', event, ...(fields ? { fields } : {}) });
  }

  /** Closes the underlying stream. Idempotent. */
  async close(): Promise<void> {
    return new Promise((resolve) => {
      if (this.broken) return resolve();
      this.stream.end(() => resolve());
    });
  }
}

/**
 * Open (or reopen, append-mode) the run log for an issue. Creates the directory tree on
 * demand. Path is `<logsRoot>/<sanitized-identifier>.jsonl`; sanitization matches workspace
 * keys so the same characters are escaped consistently across .symphony/ subdirs.
 *
 * `issueId` is the tracker's primary key and is stamped on every line as `issue_id`.
 * `issueIdentifier` is the filename-safe display id and is used to derive the path AND
 * is stamped as `issue_identifier`. Pass both — they may diverge on trackers where ids
 * are opaque distinct from human-readable identifiers.
 */
export function openRunLog(
  logsRoot: string,
  issueId: string,
  issueIdentifier: string,
): RunLog {
  const key = sanitizeWorkspaceKey(issueIdentifier);
  if (key.length === 0) {
    throw new Error(`cannot derive runlog filename from identifier: ${issueIdentifier}`);
  }
  mkdirSync(logsRoot, { recursive: true });
  const filePath = path.join(logsRoot, `${key}.jsonl`);
  return new RunLog(filePath, issueId, issueIdentifier);
}
