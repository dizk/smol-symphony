import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openRunLog } from '../src/runlog.js';

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

  it('stamps issue_id and issue_identifier separately so Linear-style UUIDs survive', async () => {
    // Linear-style: id is an opaque UUID, identifier is the human-readable key.
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
