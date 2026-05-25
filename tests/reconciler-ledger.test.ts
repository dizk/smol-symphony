// Unit tests for ResourceActionLedger (issue 43). The four resources
// (bake/vm/workspace/pr) used to verify these semantics indirectly through
// each resource's snapshot; centralizing the plumbing means the contract is
// pinned in one place.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ResourceActionLedger } from '../src/reconciler/ledger.js';

function pinnedClock(seed: number): () => number {
  let t = seed;
  return () => {
    const v = t;
    t += 1000;
    return v;
  };
}

describe('ResourceActionLedger', () => {
  it('start unshifts an in_progress row carrying the resource id', () => {
    const ledger = new ResourceActionLedger('bake', { now: () => 1_700_000_000_000 });
    ledger.start('bake:abc');
    const rows = ledger.snapshot();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.resource, 'bake');
    assert.equal(rows[0]!.action, 'bake:abc');
    assert.equal(rows[0]!.state, 'in_progress');
    assert.equal(rows[0]!.finished_at, null);
    assert.equal(rows[0]!.error, null);
    assert.equal(rows[0]!.started_at, new Date(1_700_000_000_000).toISOString());
  });

  it('done flips the most-recent matching in_progress row to done', () => {
    const ledger = new ResourceActionLedger('vm', { now: pinnedClock(1_700_000_000_000) });
    ledger.start('destroy_machine:foo');
    ledger.done('destroy_machine:foo');
    const rows = ledger.snapshot();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.state, 'done');
    assert.equal(rows[0]!.finished_at, new Date(1_700_000_001_000).toISOString());
  });

  it('done is idempotent when there is no matching in_progress row', () => {
    const ledger = new ResourceActionLedger('vm');
    ledger.done('destroy_machine:nonexistent');
    assert.equal(ledger.snapshot().length, 0);
    ledger.start('destroy_machine:foo');
    ledger.done('destroy_machine:foo');
    ledger.done('destroy_machine:foo'); // already terminal — no-op
    const rows = ledger.snapshot();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.state, 'done');
  });

  it('error flips the matching in_progress row to error', () => {
    const ledger = new ResourceActionLedger('pr', { now: pinnedClock(1_700_000_000_000) });
    ledger.start('rebase_and_force_push:foo');
    ledger.error('rebase_and_force_push:foo', 'rebase conflict');
    const rows = ledger.snapshot();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.state, 'error');
    assert.equal(rows[0]!.error, 'rebase conflict');
    assert.equal(rows[0]!.finished_at, new Date(1_700_000_001_000).toISOString());
  });

  it('error promotes to an orphan row when no in_progress row exists', () => {
    const ledger = new ResourceActionLedger('bake', { now: () => 1_700_000_000_000 });
    ledger.error('bake:read-smolfile', 'ENOENT');
    const rows = ledger.snapshot();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.state, 'error');
    assert.equal(rows[0]!.action, 'bake:read-smolfile');
    assert.equal(rows[0]!.error, 'ENOENT');
    assert.equal(rows[0]!.started_at, rows[0]!.finished_at);
  });

  it('record pushes a one-shot already-terminal row', () => {
    const ledger = new ResourceActionLedger('workspace', { now: () => 1_700_000_000_000 });
    ledger.record('mark_stale:issue-1', 'done', 'base advanced past workspace HEAD');
    const rows = ledger.snapshot();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.state, 'done');
    assert.equal(rows[0]!.started_at, rows[0]!.finished_at);
    assert.equal(rows[0]!.error, 'base advanced past workspace HEAD');
  });

  it('snapshot is most-recent-first and respects maxItems', () => {
    const ledger = new ResourceActionLedger('vm');
    for (let i = 0; i < 5; i++) {
      ledger.start(`destroy_machine:${i}`);
      ledger.done(`destroy_machine:${i}`);
    }
    const rows = ledger.snapshot(3);
    assert.equal(rows.length, 3);
    assert.equal(rows[0]!.action, 'destroy_machine:4');
    assert.equal(rows[1]!.action, 'destroy_machine:3');
    assert.equal(rows[2]!.action, 'destroy_machine:2');
  });

  it('snapshot defaults to maxHistory when no maxItems is passed', () => {
    const ledger = new ResourceActionLedger('bake', { maxHistory: 4 });
    for (let i = 0; i < 6; i++) {
      ledger.start(`bake:${i}`);
      ledger.done(`bake:${i}`);
    }
    assert.equal(ledger.snapshot().length, 4);
  });

  it('internal buffer is capped at maxHistory * 2 (clamp keeps a small lookback)', () => {
    const ledger = new ResourceActionLedger('bake', { maxHistory: 3 });
    for (let i = 0; i < 100; i++) {
      ledger.start(`bake:${i}`);
      ledger.done(`bake:${i}`);
    }
    // Snapshot at the clamp ceiling proves no growth beyond maxHistory * 2.
    assert.equal(ledger.snapshot(1000).length, 6);
  });

  it('run resolves to ok and flips the row to done on success', async () => {
    const ledger = new ResourceActionLedger('vm');
    const res = await ledger.run('destroy_machine:foo', async () => 42);
    assert.deepEqual(res, { ok: true, value: 42 });
    const rows = ledger.snapshot();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.state, 'done');
  });

  it('run resolves to error and flips the row to error on rejection', async () => {
    const ledger = new ResourceActionLedger('pr');
    const res = await ledger.run('arm_auto_merge:42', async () => {
      throw new Error('gh: forbidden');
    });
    assert.deepEqual(res, { ok: false, error: 'gh: forbidden' });
    const rows = ledger.snapshot();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.state, 'error');
    assert.equal(rows[0]!.error, 'gh: forbidden');
  });

  it('done matches only in_progress rows even if older done rows share the key', () => {
    const ledger = new ResourceActionLedger('pr');
    ledger.start('view_pr:1');
    ledger.done('view_pr:1');
    ledger.start('view_pr:1');
    ledger.done('view_pr:1');
    const rows = ledger.snapshot();
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!.state, 'done');
    assert.equal(rows[1]!.state, 'done');
  });

  it('opaque action keys support hash-based shapes (bake)', () => {
    const ledger = new ResourceActionLedger('bake');
    ledger.start('bake:deadbeef');
    ledger.done('bake:deadbeef');
    const rows = ledger.snapshot();
    assert.equal(rows[0]!.action, 'bake:deadbeef');
    assert.equal(rows[0]!.state, 'done');
  });
});
