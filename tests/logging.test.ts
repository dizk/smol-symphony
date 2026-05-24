import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeLogFile, log, setLogFile } from '../src/logging.js';

// Drain the WriteStream by closing the file sink so buffered writes flush before we read.
async function flushAndRead(filePath: string): Promise<string> {
  await closeLogFile();
  return readFileSync(filePath, 'utf8');
}

describe('logging file sink', () => {
  let tmpDir: string;
  before(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'symphony-logging-'));
  });
  after(async () => {
    await closeLogFile();
    rmSync(tmpDir, { recursive: true, force: true });
  });
  afterEach(async () => {
    await closeLogFile();
  });

  it('mirrors structured logs to the configured file in key=value format', async () => {
    const file = path.join(tmpDir, 'sink-basic.log');
    const opened = setLogFile(file);
    assert.equal(opened, path.resolve(file));
    log.info('hello world', { issue_id: '42', count: 3 });
    log.warn('something happened', { reason: 'because' });
    const text = await flushAndRead(file);
    const lines = text.trim().split('\n');
    assert.equal(lines.length, 2);
    assert.match(lines[0]!, /^ts=\d{4}-\d{2}-\d{2}T/);
    assert.match(lines[0]!, / level=info /);
    assert.match(lines[0]!, / msg="hello world"/);
    assert.match(lines[0]!, / issue_id=42 /);
    assert.match(lines[0]!, / count=3$/);
    assert.match(lines[1]!, / level=warn /);
    assert.match(lines[1]!, / reason=because$/);
  });

  it('appends across reopens so process restarts do not truncate', async () => {
    const file = path.join(tmpDir, 'sink-append.log');
    setLogFile(file);
    log.info('first');
    await closeLogFile();
    setLogFile(file);
    log.info('second');
    const text = await flushAndRead(file);
    const lines = text.trim().split('\n');
    assert.equal(lines.length, 2);
    assert.match(lines[0]!, / msg=first$/);
    assert.match(lines[1]!, / msg=second$/);
  });

  it('creates the parent directory on demand', async () => {
    const dir = path.join(tmpDir, 'nested', 'deeper');
    const file = path.join(dir, 'sink.log');
    assert.equal(existsSync(dir), false);
    setLogFile(file);
    log.info('mkdir worked');
    const text = await flushAndRead(file);
    assert.ok(text.includes('msg="mkdir worked"'));
    assert.ok(statSync(dir).isDirectory());
  });

  it('setLogFile(null) disables the sink without losing stderr output', async () => {
    const file = path.join(tmpDir, 'sink-disable.log');
    setLogFile(file);
    log.info('before disable');
    // setLogFile(null) closes the sink; await so the buffered write hits disk.
    await closeLogFile();
    setLogFile(null);
    log.info('after disable');
    const text = readFileSync(file, 'utf8');
    assert.match(text, / msg="before disable"/);
    assert.equal(text.includes('after disable'), false);
  });

  it('repeated setLogFile with the same path is idempotent (no truncation)', async () => {
    const file = path.join(tmpDir, 'sink-idempotent.log');
    setLogFile(file);
    log.info('one');
    // Same absolute path — should not reopen / truncate.
    setLogFile(file);
    log.info('two');
    const text = await flushAndRead(file);
    const lines = text.trim().split('\n');
    assert.equal(lines.length, 2);
    assert.match(lines[0]!, / msg=one$/);
    assert.match(lines[1]!, / msg=two$/);
  });

  it('open failure does not throw and reverts to stderr-only', () => {
    // A path whose parent is a regular file cannot be mkdir'd; setLogFile should
    // swallow the EEXIST/ENOTDIR and return null instead of throwing.
    const blockingFile = path.join(tmpDir, 'blocker');
    writeFileSync(blockingFile, 'not a dir');
    const opened = setLogFile(path.join(blockingFile, 'sink.log'));
    assert.equal(opened, null);
    // Subsequent log calls must still succeed (stderr-only).
    assert.doesNotThrow(() => log.info('still alive'));
  });

  it('reports failure synchronously when the target path is a directory', () => {
    // EISDIR surfaces from `openSync(path, 'a')` synchronously. The first
    // implementation relied on createWriteStream's async open event, which
    // meant setLogFile() would return the path and only later flip the sink
    // into a broken state. The synchronous open closes that gap so the
    // return value reflects the actual sink state.
    const asDir = path.join(tmpDir, 'sink-is-a-directory');
    mkdirSync(asDir, { recursive: true });
    const opened = setLogFile(asDir);
    assert.equal(opened, null);
    // The sink must not be installed; subsequent log calls go to stderr only.
    assert.doesNotThrow(() => log.info('after eisdir'));
  });
});
