import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { writeIssueFile } from '../src/issues.js';
import type { IssueFs } from '../src/util/fs-issues.js';

describe('writeIssueFile clock injection', () => {
  it('stamps created_at / updated_at from the injected clock', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'symphony-issues-'));
    try {
      // Pinned epoch: 2026-05-01T00:00:00.000Z. The seam's contract is that the
      // ISO timestamp in the front matter is derived from `now()` — no hidden
      // `new Date()` reads from the wall clock.
      const fixed = Date.UTC(2026, 4, 1, 0, 0, 0);
      const result = await writeIssueFile({
        trackerRoot: root,
        state: 'Todo',
        title: 'Pinned clock',
        now: () => fixed,
      });
      const body = await readFile(result.path, 'utf8');
      assert.match(body, /created_at: "2026-05-01T00:00:00\.000Z"/);
      assert.match(body, /updated_at: "2026-05-01T00:00:00\.000Z"/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('writeIssueFile fs injection', () => {
  it('routes every fs operation through the injected IssueFs port', async () => {
    // In-memory stub: the seam's contract is that writeIssueFile never touches
    // `node:fs/promises` directly, so a stub that records every call is enough
    // to verify both the order of operations and the values written.
    const calls: string[] = [];
    const files = new Map<string, string>();
    const dirs = new Set<string>();

    const stub: IssueFs = {
      async mkdir(p, opts) {
        calls.push(`mkdir ${p} recursive=${opts.recursive}`);
        dirs.add(p);
      },
      async readdir(p) {
        calls.push(`readdir ${p}`);
        if (!dirs.has(p)) {
          const err = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException;
          err.code = 'ENOENT';
          throw err;
        }
        return [];
      },
      async stat(p) {
        calls.push(`stat ${p}`);
        if (dirs.has(p)) return { isDirectory: () => true };
        const err = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      },
      async writeFile(p, data) {
        calls.push(`writeFile ${p} bytes=${data.length}`);
        files.set(p, data);
      },
    };

    const result = await writeIssueFile({
      trackerRoot: '/virtual/root',
      state: 'Todo',
      title: 'Stub-fs path',
      now: () => Date.UTC(2026, 4, 1, 0, 0, 0),
      fs: stub,
    });

    assert.equal(result.state, 'Todo');
    // First numeric id assigned via the stubbed readdir walk.
    assert.equal(result.identifier, '1');
    assert.equal(result.path, path.join('/virtual/root', 'Todo', '1.md'));
    // The stub captured the write — no leakage to real disk.
    const written = files.get(result.path);
    assert.ok(written);
    assert.match(written, /title: "Stub-fs path"/);
    assert.match(written, /created_at: "2026-05-01T00:00:00\.000Z"/);
    // The first call is the state-dir mkdir, proving the port is used end-to-end.
    assert.equal(calls[0], 'mkdir /virtual/root/Todo recursive=true');
    assert.ok(
      calls.includes(`writeFile ${result.path} bytes=${written.length}`),
      'writeFile was routed through the stub',
    );
  });
});
