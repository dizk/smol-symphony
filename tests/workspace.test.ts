import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sanitizeWorkspaceKey, assertContained, runHookScript } from '../src/workspace.js';

describe('workspace', () => {
  it('sanitizes identifiers to allowed charset', () => {
    assert.equal(sanitizeWorkspaceKey('ABC-1'), 'ABC-1');
    assert.equal(sanitizeWorkspaceKey('A B C'), 'A_B_C');
    // Dots are part of the allowed set per §9.5; only the slashes are replaced.
    assert.equal(sanitizeWorkspaceKey('foo/../bar'), 'foo_.._bar');
  });

  it('rejects paths outside root', () => {
    assert.throws(() => assertContained('/tmp/root', '/tmp/other/dir'));
    assert.throws(() => assertContained('/tmp/root', '/tmp/root'));
  });

  it('accepts contained paths whose names start with two dots', () => {
    // Per the §9.5 containment fix: `..fix` is a perfectly legal contained directory name
    // even though `path.relative()` returns a string starting with the two characters `..`.
    assert.doesNotThrow(() => assertContained('/tmp/root', '/tmp/root/..fix'));
    assert.doesNotThrow(() => assertContained('/tmp/root', '/tmp/root/ABC-1'));
  });
});

describe('runHookScript extraEnv', () => {
  it('merges extraEnv on top of process.env without leaking back to the host', async () => {
    // The Done state's after_run hook reads SYMPHONY_PR_TITLE / SYMPHONY_PR_BODY_FILE
    // staged by the orchestrator; the runner threads those through as extraEnv. Verify the
    // merge happens and that the host environment is not mutated as a side effect.
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'symphony-hook-env-'));
    try {
      const sentinel = `prior-${Date.now()}`;
      process.env.SYMPHONY_HOST_VAR = sentinel;
      const res = await runHookScript(
        'printf "%s|%s" "$SYMPHONY_HOST_VAR" "$SYMPHONY_EXTRA_VAR"',
        cwd,
        5_000,
        undefined,
        { SYMPHONY_EXTRA_VAR: 'staged-value' },
      );
      assert.equal(res.exit_code, 0);
      assert.equal(res.stdout, `${sentinel}|staged-value`);
      // Host env still carries the original sentinel; staged-only var did not leak in.
      assert.equal(process.env.SYMPHONY_HOST_VAR, sentinel);
      assert.equal(process.env.SYMPHONY_EXTRA_VAR, undefined);
    } finally {
      delete process.env.SYMPHONY_HOST_VAR;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('extraEnv overrides a same-named process.env var for the hook only', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'symphony-hook-env-override-'));
    try {
      process.env.SYMPHONY_OVERRIDE_ME = 'host-value';
      const res = await runHookScript(
        'printf "%s" "$SYMPHONY_OVERRIDE_ME"',
        cwd,
        5_000,
        undefined,
        { SYMPHONY_OVERRIDE_ME: 'staged-wins' },
      );
      assert.equal(res.stdout, 'staged-wins');
      assert.equal(process.env.SYMPHONY_OVERRIDE_ME, 'host-value');
    } finally {
      delete process.env.SYMPHONY_OVERRIDE_ME;
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
