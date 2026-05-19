import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LocalMarkdownTracker } from '../src/trackers/local.js';

async function makeTree(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'symphony-tracker-'));
  await mkdir(path.join(root, 'Todo'), { recursive: true });
  await mkdir(path.join(root, 'Done'), { recursive: true });
  await writeFile(
    path.join(root, 'Todo', 'A-1.md'),
    `---\ntitle: First\npriority: 1\nlabels: [Bug, Foo]\nblocked_by: [A-2]\ncreated_at: "2025-01-01T00:00:00Z"\n---\nBody one.`,
  );
  await writeFile(
    path.join(root, 'Todo', 'A-3.md'),
    `---\ntitle: Third\npriority: 3\ncreated_at: "2025-02-01T00:00:00Z"\n---\nBody three.`,
  );
  await writeFile(
    path.join(root, 'Done', 'A-2.md'),
    `---\ntitle: Second\n---\nBody two.`,
  );
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

describe('local tracker', () => {
  it('fetches candidates filtered by active state', async () => {
    const { root, cleanup } = await makeTree();
    try {
      const t = new LocalMarkdownTracker({
        kind: 'local',
        endpoint: null,
        api_key: null,
        project_slug: null,
        active_states: ['Todo'],
        terminal_states: ['Done'],
        root,
      });
      const { issues } = await t.fetchCandidateIssues();
      assert.equal(issues.length, 2);
      const ids = issues.map((i) => i.identifier).sort();
      assert.deepEqual(ids, ['A-1', 'A-3']);
    } finally {
      await cleanup();
    }
  });

  it('returns root and terminalStates alongside issues as an atomic snapshot', async () => {
    // Regression: the orchestrator dispatch loop relies on fetchCandidateIssues
    // returning the tracker config it actually used during the scan, so a
    // workflow reload mid-tick can't make the fetched issues and the captured
    // snapshot disagree.
    const { root, cleanup } = await makeTree();
    try {
      const t = new LocalMarkdownTracker({
        kind: 'local',
        endpoint: null,
        api_key: null,
        project_slug: null,
        active_states: ['Todo'],
        terminal_states: ['Done', 'Cancelled'],
        root,
      });
      const result = await t.fetchCandidateIssues();
      assert.equal(result.root, root);
      assert.deepEqual(result.terminalStates, ['Done', 'Cancelled']);
      // Snapshot is a copy, not a live reference: mutating it must not affect
      // future calls.
      result.terminalStates.push('Tampered');
      const second = await t.fetchCandidateIssues();
      assert.deepEqual(second.terminalStates, ['Done', 'Cancelled']);
    } finally {
      await cleanup();
    }
  });

  it('normalizes labels to lowercase and resolves blocker state', async () => {
    const { root, cleanup } = await makeTree();
    try {
      const t = new LocalMarkdownTracker({
        kind: 'local',
        endpoint: null,
        api_key: null,
        project_slug: null,
        active_states: ['Todo'],
        terminal_states: ['Done'],
        root,
      });
      const { issues } = await t.fetchCandidateIssues();
      const a1 = issues.find((i) => i.identifier === 'A-1')!;
      assert.deepEqual(a1.labels, ['bug', 'foo']);
      assert.equal(a1.blocked_by[0]?.identifier, 'A-2');
      assert.equal(a1.blocked_by[0]?.state, 'Done');
    } finally {
      await cleanup();
    }
  });

  it('returns empty for empty fetchIssuesByStates', async () => {
    const { root, cleanup } = await makeTree();
    try {
      const t = new LocalMarkdownTracker({
        kind: 'local',
        endpoint: null,
        api_key: null,
        project_slug: null,
        active_states: ['Todo'],
        terminal_states: ['Done'],
        root,
      });
      assert.deepEqual(await t.fetchIssuesByStates([]), []);
    } finally {
      await cleanup();
    }
  });
});
