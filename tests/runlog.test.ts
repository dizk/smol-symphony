import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openRunLog, summarizeRunLog, type RunLogEntry, type RunSummary } from '../src/runlog.js';

// Drain pending write() callbacks by closing the stream and waiting for it. Each test that
// asserts on file contents must close first because writes are buffered.
async function readAll(rl: ReturnType<typeof openRunLog>, file: string): Promise<string> {
  await rl.close();
  return readFileSync(file, 'utf8');
}

describe('runlog', () => {
  let tmpDir: string;
  before(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'symphony-runlog-'));
  });
  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes one JSON object per line with auto-stamped ts/issue_id/attempt', async () => {
    const rl = openRunLog(tmpDir, 'uuid-abc', 'ISSUE-1');
    rl.setAttempt(2);
    rl.record({ channel: 'acp', direction: 'host_to_vm', frame: { method: 'initialize' } });
    rl.record({ channel: 'stderr', text: 'hello' });
    const file = path.join(tmpDir, 'ISSUE-1.jsonl');
    const text = await readAll(rl, file);
    const lines = text.trim().split('\n');
    assert.equal(lines.length, 2);
    const a = JSON.parse(lines[0]!);
    const b = JSON.parse(lines[1]!);
    assert.equal(a.issue_id, 'uuid-abc');
    assert.equal(a.issue_identifier, 'ISSUE-1');
    assert.equal(a.attempt, 2);
    assert.equal(a.channel, 'acp');
    assert.equal(a.direction, 'host_to_vm');
    assert.deepEqual(a.frame, { method: 'initialize' });
    assert.match(a.ts, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(b.channel, 'stderr');
    assert.equal(b.text, 'hello');
    assert.equal(b.attempt, 2);
  });

  it('stamps issue_id and issue_identifier separately so opaque-UUID ids survive', async () => {
    // Some trackers use an opaque UUID as `id` and a human-readable key as `identifier`.
    const rl = openRunLog(tmpDir, 'a1b2c3d4-uuid', 'ENG-42');
    rl.record({ channel: 'system', event: 'attempt_started' });
    const file = path.join(tmpDir, 'ENG-42.jsonl');
    const text = await readAll(rl, file);
    const obj = JSON.parse(text.trim());
    assert.equal(obj.issue_id, 'a1b2c3d4-uuid');
    assert.equal(obj.issue_identifier, 'ENG-42');
  });

  it('appends across reopen and across attempts in one stream', async () => {
    const rl1 = openRunLog(tmpDir, 'uuid-2', 'ISSUE-2');
    rl1.setAttempt(0);
    rl1.record({ channel: 'system', event: 'attempt_started' });
    await rl1.close();
    const rl2 = openRunLog(tmpDir, 'uuid-2', 'ISSUE-2');
    rl2.setAttempt(1);
    rl2.record({ channel: 'system', event: 'attempt_started' });
    const file = path.join(tmpDir, 'ISSUE-2.jsonl');
    const text = await readAll(rl2, file);
    const lines = text.trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines.length, 2);
    assert.equal(lines[0].attempt, 0);
    assert.equal(lines[1].attempt, 1);
  });

  it('sanitizes identifier into the filename', async () => {
    const rl = openRunLog(tmpDir, 'uuid-3', 'foo/bar baz');
    rl.record({ channel: 'system', event: 'ping' });
    await rl.close();
    // Sanitized identifier: foo_bar_baz (slashes and spaces become underscores).
    const file = path.join(tmpDir, 'foo_bar_baz.jsonl');
    const text = readFileSync(file, 'utf8');
    assert.ok(text.length > 0);
  });

  it('auto-stamped fields override caller-supplied ones', async () => {
    // Regression for codex review P3: previously the spread put caller fields LAST so
    // they could silently overwrite ts / issue_id / issue_identifier / attempt and
    // corrupt downstream correlation. Now the canonical stamps win.
    const rl = openRunLog(tmpDir, 'real-uuid', 'REAL-IDENT');
    rl.setAttempt(7);
    rl.record({
      channel: 'system',
      event: 'sneak',
      // Hostile fields a careless caller might pass:
      ts: '1999-01-01T00:00:00.000Z',
      issue_id: 'spoof-uuid',
      issue_identifier: 'SPOOFED',
      attempt: 99,
    });
    const file = path.join(tmpDir, 'REAL-IDENT.jsonl');
    const text = await readAll(rl, file);
    const obj = JSON.parse(text.trim());
    assert.notEqual(obj.ts, '1999-01-01T00:00:00.000Z');
    assert.equal(obj.issue_id, 'real-uuid');
    assert.equal(obj.issue_identifier, 'REAL-IDENT');
    assert.equal(obj.attempt, 7);
    // The caller's other fields are still preserved:
    assert.equal(obj.event, 'sneak');
  });

  it('system() helper records channel:"system" with optional fields', async () => {
    const rl = openRunLog(tmpDir, 'uuid-4', 'ISSUE-3');
    rl.setAttempt(0);
    rl.system('attempt_started', { reason: 'unit-test' });
    rl.system('attempt_ended');
    const file = path.join(tmpDir, 'ISSUE-3.jsonl');
    const text = await readAll(rl, file);
    const lines = text.trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines[0].channel, 'system');
    assert.equal(lines[0].event, 'attempt_started');
    assert.deepEqual(lines[0].fields, { reason: 'unit-test' });
    assert.equal(lines[1].event, 'attempt_ended');
    assert.equal(lines[1].fields, undefined);
  });
});

// Monotonic ISO-timestamp generator so wall-clock deltas are deterministic.
function tsAt(seconds: number): string {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)).toISOString();
}

let clock = 0;
function sys(event: string, fields: Record<string, unknown>): RunLogEntry {
  return { channel: 'system', ts: tsAt(clock++), attempt: 0, event, fields };
}

const SUMMARY_CTX = { issueId: 'uuid-x', issueIdentifier: 'ISSUE-X', generatedAt: tsAt(999) };

function summarize(entries: RunLogEntry[], actionsStdout = ''): RunSummary {
  return summarizeRunLog({ entries, actionsStdout, ...SUMMARY_CTX });
}

describe('summarizeRunLog', () => {
  it('reconstructs the state path, attempts, and terminal outcome from a Todo→Review→Done run', () => {
    clock = 0;
    const s = summarize([
      sys('attempt_started', { attempt: 0, issue_state: 'Todo', max_turns: 10 }),
      sys('transition', { from_state: 'Todo', to_state: 'Review', notes: 'impl done', actor: 'claude/x', terminal: false }),
      sys('attempt_ended', { ok: true, reason: 'agent_transitioned', turns_completed: 4 }),
      sys('attempt_started', { attempt: 0, issue_state: 'Review', max_turns: 6 }),
      sys('transition', { from_state: 'Review', to_state: 'Done', notes: 'lgtm', actor: 'codex/y', terminal: true }),
      sys('attempt_ended', { ok: true, reason: 'agent_transitioned', turns_completed: 2 }),
    ]);
    assert.deepEqual(s.state_path, ['Todo', 'Review', 'Done']);
    assert.equal(s.attempts, 2);
    assert.equal(s.review_rejections, 0);
    assert.equal(s.terminal_state, 'Done');
    assert.equal(s.terminal_outcome, 'completed');
    assert.equal(s.turn_budget_exhausted, false);
    assert.equal(s.schema_version, 1);
    const todo = s.per_state.find((p) => p.state === 'Todo')!;
    assert.equal(todo.attempts, 1);
    assert.equal(todo.turns_used, 4);
    assert.equal(todo.max_turns, 10);
    assert.ok((s.wall_clock_ms_total ?? 0) > 0);
  });

  it('counts review→implement kick-backs and captures each rejection note', () => {
    clock = 0;
    const s = summarize([
      sys('attempt_started', { attempt: 0, issue_state: 'Todo', max_turns: 10 }),
      sys('transition', { from_state: 'Todo', to_state: 'Review', notes: 'v1', actor: 'a', terminal: false }),
      sys('attempt_ended', { ok: true, reason: 'agent_transitioned', turns_completed: 3 }),
      sys('attempt_started', { attempt: 0, issue_state: 'Review', max_turns: 6 }),
      sys('transition', { from_state: 'Review', to_state: 'Todo', notes: 'seam placement wrong', actor: 'codex', terminal: false }),
      sys('attempt_ended', { ok: true, reason: 'agent_transitioned', turns_completed: 1 }),
      sys('attempt_started', { attempt: 1, issue_state: 'Todo', max_turns: 10 }),
      sys('transition', { from_state: 'Todo', to_state: 'Review', notes: 'v2', actor: 'a', terminal: false }),
      sys('attempt_ended', { ok: true, reason: 'agent_transitioned', turns_completed: 2 }),
      sys('attempt_started', { attempt: 0, issue_state: 'Review', max_turns: 6 }),
      sys('transition', { from_state: 'Review', to_state: 'Done', notes: 'lgtm', actor: 'codex', terminal: true }),
      sys('attempt_ended', { ok: true, reason: 'agent_transitioned', turns_completed: 1 }),
    ]);
    assert.deepEqual(s.state_path, ['Todo', 'Review', 'Todo', 'Review', 'Done']);
    assert.equal(s.attempts, 4);
    assert.equal(s.review_rejections, 1);
    assert.equal(s.rejection_notes.length, 1);
    assert.equal(s.rejection_notes[0]!.from_state, 'Review');
    assert.equal(s.rejection_notes[0]!.to_state, 'Todo');
    assert.equal(s.rejection_notes[0]!.notes, 'seam placement wrong');
    // Todo→Review handoffs must NOT count as rejections even though Review recurs.
    const review = s.per_state.find((p) => p.state === 'Review')!;
    assert.equal(review.attempts, 2);
  });

  it('flags turn-budget exhaustion and collects stalls/timeouts from attempt reasons', () => {
    clock = 0;
    const s = summarize([
      sys('attempt_started', { attempt: 0, issue_state: 'Todo', max_turns: 5 }),
      sys('attempt_ended', { ok: true, reason: 'max_turns_reached', turns_completed: 5 }),
      sys('attempt_started', { attempt: 1, issue_state: 'Todo', max_turns: 5 }),
      sys('attempt_ended', { ok: false, reason: 'agent turn prompt_timeout: no reply', turns_completed: 2 }),
    ]);
    assert.equal(s.turn_budget_exhausted, true);
    const todo = s.per_state.find((p) => p.state === 'Todo')!;
    assert.equal(todo.budget_exhausted, true);
    assert.equal(todo.turns_used, 7);
    assert.equal(s.timeouts.length, 1);
    assert.match(s.timeouts[0]!.reason, /prompt_timeout/);
    assert.equal(s.timeouts[0]!.state, 'Todo');
    // No terminal transition was recorded → incomplete.
    assert.equal(s.terminal_state, null);
    assert.equal(s.terminal_outcome, 'incomplete');
  });

  it('extracts the PR number/url from the Done-state actions stdout', () => {
    clock = 0;
    const s = summarize(
      [
        sys('attempt_started', { attempt: 0, issue_state: 'Review', max_turns: 6 }),
        sys('transition', { from_state: 'Review', to_state: 'Done', notes: '', actor: 'codex', terminal: true }),
        sys('attempt_ended', { ok: true, reason: 'agent_transitioned', turns_completed: 1 }),
      ],
      'pushing branch...\nhttps://github.com/dizk/smol-symphony/pull/137\n',
    );
    assert.equal(s.pr_number, 137);
    assert.equal(s.pr_url, 'https://github.com/dizk/smol-symphony/pull/137');
  });

  it('records conflict reroutes separately and never counts them as rejections', () => {
    clock = 0;
    const s = summarize([
      sys('attempt_started', { attempt: 0, issue_state: 'Todo', max_turns: 10 }),
      // A reroute back to the initial state must NOT be read as a review rejection.
      sys('transition', { from_state: 'Todo', to_state: 'Todo', notes: 'rebase conflict', actor: 'a', terminal: false, rerouted: true }),
      sys('attempt_ended', { ok: true, reason: 'agent_transitioned', turns_completed: 1 }),
    ]);
    assert.equal(s.review_rejections, 0);
    assert.equal(s.conflict_routes.length, 1);
    assert.equal(s.conflict_routes[0]!.from_state, 'Todo');
  });

  it('degrades gracefully on an empty event stream', () => {
    const s = summarize([]);
    assert.deepEqual(s.state_path, []);
    assert.equal(s.attempts, 0);
    assert.equal(s.review_rejections, 0);
    assert.equal(s.terminal_state, null);
    assert.equal(s.terminal_outcome, 'incomplete');
    assert.equal(s.wall_clock_ms_total, null);
    assert.equal(s.pr_number, null);
  });
});

describe('RunLog.writeSummary', () => {
  let tmpDir: string;
  before(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'symphony-summary-'));
  });
  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reduces the accumulated lifecycle events into <key>.summary.json', async () => {
    const rl = openRunLog(tmpDir, 'uuid-sum', 'SUM-1');
    rl.setAttempt(0);
    rl.system('attempt_started', { attempt: 0, issue_state: 'Todo', max_turns: 8 });
    // High-frequency frames are NOT accumulated — they must not affect the summary.
    rl.record({ channel: 'acp', direction: 'host_to_vm', frame: { method: 'x' } });
    rl.system('transition', { from_state: 'Todo', to_state: 'Done', notes: 'ship it', actor: 'claude/x', terminal: true });
    rl.record({ channel: 'hook', hook: 'actions', stream: 'stdout', text: 'https://github.com/dizk/smol-symphony/pull/9\n' });
    rl.system('attempt_ended', { ok: true, reason: 'agent_transitioned', turns_completed: 3 });
    rl.writeSummary(tsAt(500));
    const summaryFile = path.join(tmpDir, 'SUM-1.summary.json');
    assert.ok(existsSync(summaryFile), 'summary file should exist');
    const parsed = JSON.parse(readFileSync(summaryFile, 'utf8')) as RunSummary;
    assert.equal(parsed.issue_id, 'uuid-sum');
    assert.equal(parsed.issue_identifier, 'SUM-1');
    assert.deepEqual(parsed.state_path, ['Todo', 'Done']);
    assert.equal(parsed.terminal_state, 'Done');
    assert.equal(parsed.pr_number, 9);
    assert.equal(parsed.generated_at, tsAt(500));
    await rl.close();
  });

  it('no-ops when no lifecycle events were recorded', async () => {
    const rl = openRunLog(tmpDir, 'uuid-empty', 'EMPTY-1');
    rl.writeSummary();
    assert.equal(existsSync(path.join(tmpDir, 'EMPTY-1.summary.json')), false);
    await rl.close();
  });
});
