import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import {
  runProcess,
  runProcessExpect,
  runHookScript,
  RunProcessError,
  describeRunFailure,
  DEFAULT_MAX_BYTES,
} from '../src/util/process.js';

describe('runProcess', () => {
  it('captures stdout and stderr separately and reports exit_code=0', async () => {
    const r = await runProcess('sh', ['-c', 'printf out; printf err 1>&2; exit 0']);
    assert.equal(r.ran, true);
    assert.equal(r.exit_code, 0);
    assert.equal(r.signal, null);
    assert.equal(r.timed_out, false);
    assert.equal(r.stdout, 'out');
    assert.equal(r.stderr, 'err');
  });

  it('reports a non-zero exit_code without throwing', async () => {
    const r = await runProcess('sh', ['-c', 'exit 7']);
    assert.equal(r.exit_code, 7);
    assert.equal(r.timed_out, false);
    assert.equal(r.signal, null);
  });

  it('resolves with exit_code=null on spawn error (ENOENT)', async () => {
    const r = await runProcess('this-binary-does-not-exist-xyz', []);
    assert.equal(r.exit_code, null);
    // Default appendErrorToStderr=true: stderr carries the OS error message.
    assert.ok(r.stderr.length > 0);
  });

  it('omits the spawn error from stderr when appendErrorToStderr=false', async () => {
    const r = await runProcess('this-binary-does-not-exist-xyz', [], {
      appendErrorToStderr: false,
    });
    assert.equal(r.exit_code, null);
    assert.equal(r.stderr, '');
  });

  it('SIGKILLs on timeout and reports timed_out=true', async () => {
    const r = await runProcess('sh', ['-c', 'sleep 5'], { timeoutMs: 50 });
    assert.equal(r.timed_out, true);
    assert.equal(r.signal, 'SIGKILL');
  });

  it('clamps stdout and stderr to maxBytes', async () => {
    // Write 8 KiB of stdout and 8 KiB of stderr; clamp to 1 KiB each.
    const r = await runProcess(
      'sh',
      ['-c', 'yes | head -c 8192; yes | head -c 8192 1>&2'],
      { maxBytes: 1024 },
    );
    assert.equal(r.stdout.length, 1024);
    assert.equal(r.stderr.length, 1024);
  });

  it('uses DEFAULT_MAX_BYTES when maxBytes is unset', async () => {
    // Verify the constant matches the legacy 64 KiB the seven wrappers all used.
    assert.equal(DEFAULT_MAX_BYTES, 65_536);
    const r = await runProcess('sh', ['-c', 'yes | head -c 70000']);
    assert.equal(r.stdout.length, DEFAULT_MAX_BYTES);
  });

  it('fires onChunk for every stdout/stderr burst', async () => {
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    await runProcess('sh', ['-c', 'printf one; sleep 0.05; printf two; printf err 1>&2'], {
      capture: {
        onChunk: (stream, text) => {
          if (stream === 'stdout') stdoutChunks.push(text);
          else stderrChunks.push(text);
        },
      },
    });
    // We can't pin the exact chunk boundary count (kernel-buffered), but
    // every accumulated byte must have flowed through onChunk.
    assert.equal(stdoutChunks.join(''), 'onetwo');
    assert.equal(stderrChunks.join(''), 'err');
  });

  it('fires onResult exactly once with the final result before resolve', async () => {
    let onResultCalled = 0;
    let capturedResult: { exit_code: number | null } | null = null;
    const r = await runProcess('sh', ['-c', 'exit 3'], {
      capture: {
        onResult: (res) => {
          onResultCalled += 1;
          capturedResult = res;
        },
      },
    });
    assert.equal(onResultCalled, 1);
    assert.deepEqual(capturedResult, r);
    assert.equal(r.exit_code, 3);
  });

  it('merges env on top of process.env without leaking back to the host', async () => {
    const sentinel = `host-${Date.now()}`;
    process.env.SYMPHONY_TEST_HOST_VAR = sentinel;
    try {
      const r = await runProcess('sh', ['-c', 'printf "%s|%s" "$SYMPHONY_TEST_HOST_VAR" "$SYMPHONY_TEST_EXTRA_VAR"'], {
        env: { SYMPHONY_TEST_EXTRA_VAR: 'extra' },
      });
      assert.equal(r.stdout, `${sentinel}|extra`);
      assert.equal(process.env.SYMPHONY_TEST_EXTRA_VAR, undefined);
    } finally {
      delete process.env.SYMPHONY_TEST_HOST_VAR;
    }
  });

  it('honors env override of a same-named process.env var for the child only', async () => {
    process.env.SYMPHONY_TEST_OVERRIDE = 'host';
    try {
      const r = await runProcess('sh', ['-c', 'printf "%s" "$SYMPHONY_TEST_OVERRIDE"'], {
        env: { SYMPHONY_TEST_OVERRIDE: 'override' },
      });
      assert.equal(r.stdout, 'override');
      assert.equal(process.env.SYMPHONY_TEST_OVERRIDE, 'host');
    } finally {
      delete process.env.SYMPHONY_TEST_OVERRIDE;
    }
  });

  it('runs in the provided cwd', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'symphony-runproc-cwd-'));
    try {
      // Resolve the real path so symlinked tmpdirs (e.g. /tmp -> /private/tmp on macOS)
      // don't make the comparison flaky.
      const real = (await stat(dir)).isDirectory() ? dir : dir;
      const r = await runProcess('pwd', [], { cwd: real });
      assert.equal(r.exit_code, 0);
      assert.equal(r.stdout.trim(), real);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('runProcessExpect', () => {
  it('resolves with the result on exit_code=0', async () => {
    const r = await runProcessExpect('sh', ['-c', 'printf ok']);
    assert.equal(r.stdout, 'ok');
  });

  it('throws RunProcessError on non-zero exit', async () => {
    await assert.rejects(runProcessExpect('sh', ['-c', 'echo bad 1>&2; exit 9']), (err: unknown) => {
      assert.ok(err instanceof RunProcessError);
      assert.equal(err.bin, 'sh');
      assert.equal(err.result.exit_code, 9);
      assert.match(err.message, /exited with code 9/);
      return true;
    });
  });

  it('throws RunProcessError on timeout', async () => {
    await assert.rejects(
      runProcessExpect('sh', ['-c', 'sleep 5'], { timeoutMs: 50 }),
      (err: unknown) => {
        assert.ok(err instanceof RunProcessError);
        assert.equal(err.result.timed_out, true);
        assert.match(err.message, /timed out/);
        return true;
      },
    );
  });

  it('throws RunProcessError on spawn ENOENT (exit_code=null)', async () => {
    await assert.rejects(
      runProcessExpect('this-binary-does-not-exist-xyz', []),
      (err: unknown) => err instanceof RunProcessError,
    );
  });
});

describe('runHookScript', () => {
  it('runs `sh -lc <script>` and captures the result', async () => {
    const r = await runHookScript('printf "%s" "$SHELL_OUT"', { env: { SHELL_OUT: 'value' } });
    assert.equal(r.exit_code, 0);
    assert.equal(r.stdout, 'value');
    assert.equal(r.ran, true);
  });
});

describe('describeRunFailure', () => {
  it('phrases timeouts, signals, and non-zero exits distinctly', () => {
    assert.equal(
      describeRunFailure({
        ran: true,
        exit_code: null,
        signal: null,
        timed_out: true,
        stdout: '',
        stderr: '',
      }),
      'timed out',
    );
    assert.equal(
      describeRunFailure({
        ran: true,
        exit_code: null,
        signal: 'SIGTERM',
        timed_out: false,
        stdout: '',
        stderr: '',
      }),
      'terminated by signal SIGTERM',
    );
    assert.equal(
      describeRunFailure({
        ran: true,
        exit_code: 2,
        signal: null,
        timed_out: false,
        stdout: '',
        stderr: '',
      }),
      'exited with code 2',
    );
  });
});
