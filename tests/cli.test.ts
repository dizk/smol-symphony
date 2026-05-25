import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCli } from '../src/bin/cli-args.js';

const SYMPHONY_ENTRY = fileURLToPath(
  new URL('../src/bin/symphony.ts', import.meta.url),
);

describe('parseCli', () => {
  it('defaults to the serve subcommand when none is given', () => {
    const cli = parseCli([]);
    assert.equal(cli.subcommand, 'serve');
  });

  it('preserves the reconcile subcommand verbatim', () => {
    // Regression: an earlier shape collapsed `reconcile` back to `serve` on
    // return, which let the missing-workflow scaffold prompt fire during
    // `symphony reconcile`. The bare `reconcile` form (and `reconcile --force`)
    // must surface as their own subcommand so the missing-workflow guard can
    // restrict scaffolding to the serve path.
    assert.equal(parseCli(['reconcile']).subcommand, 'reconcile');
    assert.equal(parseCli(['reconcile', '--force']).subcommand, 'reconcile');
    assert.equal(parseCli(['reconcile', '/tmp/W.md']).subcommand, 'reconcile');
  });

  it('preserves the rerun subcommand', () => {
    const cli = parseCli(['rerun', '--check=lint']);
    assert.equal(cli.subcommand, 'rerun');
    assert.equal(cli.rerunCheck, 'lint');
  });

  it('parses --force only on the reconcile subcommand', () => {
    const cli = parseCli(['reconcile', '--force']);
    assert.equal(cli.subcommand, 'reconcile');
    assert.equal(cli.reconcileForce, true);
  });

  it('accepts --reconcile-force as a top-level alias', () => {
    const cli = parseCli(['--reconcile-force']);
    assert.equal(cli.subcommand, 'serve');
    assert.equal(cli.reconcileForce, true);
  });
});

describe('symphony reconcile with a missing workflow', () => {
  // `reconcile` operates on an existing workflow's state — there is nothing to
  // scaffold against. The CLI must error with exit 2 and never offer the
  // first-run scaffold prompt, even on an interactive terminal. We spawn the
  // entry point in a non-TTY child so this also doubles as an end-to-end smoke
  // test that the reconcile path reaches the missing-file branch rather than
  // crashing earlier.
  it('exits 2 with "workflow file not found" and does not prompt', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'symphony-reconcile-missing-'));
    try {
      const missing = path.join(dir, 'WORKFLOW.md');
      const res = spawnSync(
        process.execPath,
        ['--import', 'tsx', SYMPHONY_ENTRY, 'reconcile', missing],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      );
      assert.equal(res.status, 2, `stderr was: ${res.stderr}`);
      assert.match(res.stderr, /workflow file not found/);
      // The scaffold prompt is serve-only; verify both stdout and stderr are
      // silent on it so a future change that loosened the guard for reconcile
      // would fail here.
      assert.doesNotMatch(res.stdout, /Scaffold a starter workflow/);
      assert.doesNotMatch(res.stderr, /Scaffold a starter workflow/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
