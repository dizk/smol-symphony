// SmolvmClient lifecycle tests. The destroy() ordering test pins the fix for
// issue 50: `machine delete -f` alone leaves the libkrun `_boot-vm` worker
// alive (smolvm separates runtime stop/start from config create/delete), so
// teardown MUST issue `machine stop` before `machine delete` to actually kill
// the worker process.
//
// The tests stub the private `run()` method to record argv without spawning
// the real smolvm binary. `run` is TypeScript-private but not runtime-private,
// so assigning via an unknown cast is safe and standard for this kind of
// hermetic CLI-wrapper test.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SmolvmClient } from '../src/agent/smolvm.js';
import type { SmolvmConfig } from '../src/types.js';

const fakeCfg: SmolvmConfig = {
  image: null,
  from: null,
  smolfile: null,
  cpus: 1,
  mem_mib: 256,
  net: false,
  volumes: [],
  forward_env: [],
  endpoint: 'unix:///tmp/smolvm.sock',
};

interface RunRecorder {
  calls: string[][];
}

function withRunStub(
  client: SmolvmClient,
  impl: (args: string[]) => Promise<{ stdout: string; stderr: string }>,
): RunRecorder {
  const calls: string[][] = [];
  (client as unknown as { run: (args: string[]) => Promise<{ stdout: string; stderr: string }> }).run = async (
    args: string[],
  ) => {
    calls.push([...args]);
    return impl(args);
  };
  return { calls };
}

describe('SmolvmClient.destroy', () => {
  it('issues `machine stop` before `machine delete`', async () => {
    // The smolvm bug at the heart of issue 50: `machine delete -f` removes the
    // config dir but doesn't stop the libkrun worker. Pin the order so future
    // refactors can't silently swap back to delete-only.
    const client = new SmolvmClient(fakeCfg);
    const rec = withRunStub(client, async () => ({ stdout: '', stderr: '' }));

    await client.destroy('symphony-issue-50');

    assert.equal(rec.calls.length, 2, 'destroy must issue exactly two CLI calls');
    assert.deepEqual(rec.calls[0], ['machine', 'stop', '--name', 'symphony-issue-50']);
    assert.deepEqual(rec.calls[1], ['machine', 'delete', 'symphony-issue-50', '-f']);
  });

  it('still issues `machine delete` when `machine stop` fails', async () => {
    // A VM that crashed mid-attempt is already stopped; `machine stop` will
    // fail with "machine not running" but the config slot still needs to be
    // freed. The stop failure must not abort the delete.
    const client = new SmolvmClient(fakeCfg);
    const rec = withRunStub(client, async (args) => {
      if (args.includes('stop')) {
        throw new Error('machine not running');
      }
      return { stdout: '', stderr: '' };
    });

    await client.destroy('symphony-already-stopped');

    assert.equal(rec.calls.length, 2);
    assert.deepEqual(rec.calls[0], ['machine', 'stop', '--name', 'symphony-already-stopped']);
    assert.deepEqual(rec.calls[1], ['machine', 'delete', 'symphony-already-stopped', '-f']);
  });

  it('swallows a failing `machine delete` so callers never see the error', async () => {
    // destroy() is best-effort by contract: the reaper's worker-killing step
    // and the runner's per-attempt cleanup both rely on it never throwing.
    const client = new SmolvmClient(fakeCfg);
    withRunStub(client, async (args) => {
      if (args.includes('delete')) throw new Error('synthetic delete failure');
      return { stdout: '', stderr: '' };
    });

    await assert.doesNotReject(client.destroy('symphony-broken'));
  });
});
