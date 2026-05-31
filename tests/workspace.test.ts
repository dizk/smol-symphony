import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {
  sanitizeWorkspaceKey,
  assertContained,
  WorkspaceManager,
} from '../src/workspace.js';
import type { ServiceConfig } from '../src/types.js';

describe('workspace', () => {
  it('sanitizes identifiers to allowed charset', () => {
    assert.equal(sanitizeWorkspaceKey('ABC-1'), 'ABC-1');
    assert.equal(sanitizeWorkspaceKey('A B C'), 'A_B_C');
    // Dots are part of the allowed set per §5.5; only the slashes are replaced.
    assert.equal(sanitizeWorkspaceKey('foo/../bar'), 'foo_.._bar');
  });

  it('rejects paths outside root', () => {
    assert.throws(() => assertContained('/tmp/root', '/tmp/other/dir'));
    assert.throws(() => assertContained('/tmp/root', '/tmp/root'));
  });

  it('accepts contained paths whose names start with two dots', () => {
    // Per the §5.5 containment fix: `..fix` is a perfectly legal contained directory name
    // even though `path.relative()` returns a string starting with the two characters `..`.
    assert.doesNotThrow(() => assertContained('/tmp/root', '/tmp/root/..fix'));
    assert.doesNotThrow(() => assertContained('/tmp/root', '/tmp/root/ABC-1'));
  });
});

async function git(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (b) => {
      stdout += b.toString('utf8');
    });
    child.stderr?.on('data', (b) => {
      stderr += b.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(`git ${args.join(' ')} in ${cwd} exited ${code}: ${stderr}`));
      else resolve(stdout.trim());
    });
  });
}

async function makeSourceRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'symphony-wsmgr-source-'));
  await git(['init', '-b', 'main'], dir);
  await git(['config', 'user.name', 'test'], dir);
  await git(['config', 'user.email', 'test@example.com'], dir);
  await writeFile(path.join(dir, 'README.md'), '# initial\n', 'utf8');
  await git(['add', '.'], dir);
  await git(['commit', '-m', 'initial'], dir);
  return dir;
}

function buildCfg(workspaceRoot: string, sourceRepo: string): ServiceConfig {
  // Minimal ServiceConfig that exercises only the fields ensureFor touches.
  // workspace.root and workflow_dir are the only ones consulted on this
  // path (resolveSetupOptions falls back to workflow_dir for the source).
  return {
    workflow_path: '/dev/null',
    workflow_dir: sourceRepo,
    workspace: { root: workspaceRoot },
    // The rest are unused on this path; cast keeps the test self-contained
    // without rebuilding the entire workflow parser.
  } as unknown as ServiceConfig;
}

describe('WorkspaceManager.ensureFor — concurrency lock', () => {
  it('coalesces concurrent ensureFor calls for the same identifier into one setup pass', async () => {
    // Without the per-identifier lock the dispatch path and the reconciler's
    // create_workspace pass can race: both lstat the dir, both get ENOENT,
    // both mkdir, and both invoke `setupWorkspaceDir` -> `git clone --local`
    // into the same path. The second clone fails because the dir is no
    // longer empty. The lock collapses both callers into one setup, so neither
    // call rejects and exactly one of them reports `created_now`.
    const source = await makeSourceRepo();
    const wsRoot = await mkdtemp(path.join(os.tmpdir(), 'symphony-wsmgr-lock-'));
    try {
      const cfg = buildCfg(wsRoot, source);
      const mgr = new WorkspaceManager(cfg);
      const [a, b] = await Promise.all([
        mgr.ensureFor('42'),
        mgr.ensureFor('42'),
      ]);
      // Both resolved to the same workspace shape (coalesced on the same
      // promise — second caller observed the first's result).
      assert.equal(a.path, b.path);
      assert.equal(a.workspace_key, '42');
      // Coalesced: exactly one canonical setup ran, so both observers see the
      // same created_now (the second never re-ran setup against a populated dir).
      assert.equal(a.created_now, b.created_now);
      // Clone produced a real branch checkout — proof the single setup pass ran.
      const head = await git(['symbolic-ref', '--short', 'HEAD'], a.path);
      assert.equal(head, 'agent/42');
    } finally {
      await rm(source, { recursive: true, force: true });
      await rm(wsRoot, { recursive: true, force: true });
    }
  });

  it('releases the in-flight slot after completion so a later call re-enters cleanly', async () => {
    // After the first ensureFor resolves, a later call for the same
    // identifier (e.g. after a reconciler removed and is being asked to
    // re-create) must NOT be served from a stale in-flight slot. Pins the
    // `finally { ensureInFlight.delete(key) }` cleanup.
    const source = await makeSourceRepo();
    const wsRoot = await mkdtemp(path.join(os.tmpdir(), 'symphony-wsmgr-relock-'));
    try {
      const cfg = buildCfg(wsRoot, source);
      const mgr = new WorkspaceManager(cfg);
      const first = await mgr.ensureFor('7');
      assert.equal(first.created_now, true);
      // ensureFor again: workspace already on disk, lock slot is gone, no
      // duplicate setup, created_now is false.
      const second = await mgr.ensureFor('7');
      assert.equal(second.created_now, false);
      assert.equal(second.path, first.path);
    } finally {
      await rm(source, { recursive: true, force: true });
      await rm(wsRoot, { recursive: true, force: true });
    }
  });
});
