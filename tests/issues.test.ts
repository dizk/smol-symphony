import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { writeIssueFile } from '../src/issues.js';

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
