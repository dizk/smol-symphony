// HTTP tests for the dashboard's issue-creation surface. Covers the relaxed POST
// contract (title is the only required field; identifier and state are derived/defaulted)
// plus the existing behaviour for callers that supply explicit values.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startHttpServer, type HttpServerOptions } from '../src/http.js';
import type { Orchestrator, Snapshot } from '../src/orchestrator.js';
import { LocalMarkdownTracker } from '../src/trackers/local.js';

function makeStubOrchestrator(): Orchestrator {
  const emptySnapshot: Snapshot = {
    generated_at: new Date().toISOString(),
    counts: { running: 0, retrying: 0 },
    running: [],
    retrying: [],
    codex_totals: { input_tokens: 0, output_tokens: 0, total_tokens: 0, seconds_running: 0 },
    rate_limits: null,
  };
  return {
    snapshot: () => emptySnapshot,
    triggerRefresh: () => ({ status: 'ok' as const }),
    detailByIdentifier: () => null,
  } as unknown as Orchestrator;
}

async function bootServer(
  trackerRoot: string,
  opts?: { withTracker?: boolean },
): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const orch = makeStubOrchestrator();
  const tracker = opts?.withTracker
    ? new LocalMarkdownTracker({
        kind: 'local',
        endpoint: null,
        api_key: null,
        project_slug: null,
        active_states: ['Todo', 'In Progress'],
        terminal_states: ['Done', 'Cancelled'],
        root: trackerRoot,
      })
    : null;
  const serverOpts: HttpServerOptions = {
    port: 0,
    host: '127.0.0.1',
    getTrackerView: () => ({
      trackerRoot,
      activeStates: ['Todo', 'In Progress'],
      terminalStates: ['Done', 'Cancelled'],
      workflowPath: '/tmp/WORKFLOW.md',
    }),
    mcp: null,
    tracker,
  };
  const handle = await startHttpServer(orch, serverOpts);
  return {
    url: `http://127.0.0.1:${handle.port}`,
    close: handle.close,
  };
}

describe('POST /api/v1/issues — relaxed input', () => {
  let root: string;
  let server: { url: string; close: () => Promise<void> };

  before(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'symphony-http-'));
    server = await bootServer(root);
  });

  after(async () => {
    await server.close();
    await rm(root, { recursive: true, force: true });
  });

  it('creates an issue when only title is supplied (derives identifier + default state)', async () => {
    const res = await fetch(`${server.url}/api/v1/issues`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Fix the login bug' }),
    });
    assert.equal(res.status, 201);
    const data = (await res.json()) as { identifier: string; state: string; path: string };
    assert.equal(data.identifier, 'fix-the-login-bug');
    assert.equal(data.state, 'Todo');

    const files = await readdir(path.join(root, 'Todo'));
    assert.deepEqual(files, ['fix-the-login-bug.md']);

    const text = await readFile(path.join(root, 'Todo', 'fix-the-login-bug.md'), 'utf8');
    assert.match(text, /title: "Fix the login bug"/);
    assert.match(text, /id: "fix-the-login-bug"/);
  });

  it('appends a numeric suffix when the derived slug collides', async () => {
    const res = await fetch(`${server.url}/api/v1/issues`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Fix the login bug' }),
    });
    assert.equal(res.status, 201);
    const data = (await res.json()) as { identifier: string };
    assert.equal(data.identifier, 'fix-the-login-bug-2');
  });

  it('still rejects requests missing a title', async () => {
    const res = await fetch(`${server.url}/api/v1/issues`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
    const data = (await res.json()) as { error: { message: string } };
    assert.match(data.error.message, /title is required/);
  });

  it('honours an explicit identifier and state when provided', async () => {
    const res = await fetch(`${server.url}/api/v1/issues`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Refactor cache eviction',
        identifier: 'CACHE-7',
        state: 'In Progress',
        description: 'Long-form body text.',
      }),
    });
    assert.equal(res.status, 201);
    const data = (await res.json()) as { identifier: string; state: string };
    assert.equal(data.identifier, 'CACHE-7');
    assert.equal(data.state, 'In Progress');

    const text = await readFile(path.join(root, 'In Progress', 'CACHE-7.md'), 'utf8');
    assert.match(text, /Long-form body text\./);
  });

  it('rejects an explicit state that is not configured', async () => {
    const res = await fetch(`${server.url}/api/v1/issues`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Whatever', state: 'NotAState' }),
    });
    assert.equal(res.status, 400);
    const data = (await res.json()) as { error: { message: string } };
    assert.match(data.error.message, /state must be one of/);
  });

  it('falls back to "issue" when the title slugifies to nothing', async () => {
    const res = await fetch(`${server.url}/api/v1/issues`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '!!!' }),
    });
    assert.equal(res.status, 201);
    const data = (await res.json()) as { identifier: string };
    assert.equal(data.identifier, 'issue');
  });
});

describe('triage approve / discard', () => {
  let root: string;
  let server: { url: string; close: () => Promise<void> };

  before(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'symphony-triage-'));
    await mkdir(path.join(root, 'Triage'), { recursive: true });
    await writeFile(
      path.join(root, 'Triage', 'investigate-cleanup.md'),
      `---\nid: "investigate-cleanup"\nidentifier: "investigate-cleanup"\ntitle: "Investigate cleanup"\nproposed_by: "agent-issues"\nproposed_at: "2026-05-20T10:00:00Z"\n---\nAgent noticed leftover dirs.`,
    );
    await writeFile(
      path.join(root, 'Triage', 'another-thing.md'),
      `---\nid: "another-thing"\nidentifier: "another-thing"\ntitle: "Another thing"\n---\nbody.`,
    );
    server = await bootServer(root, { withTracker: true });
  });

  after(async () => {
    await server.close();
    await rm(root, { recursive: true, force: true });
  });

  it('triage partial renders one row per file with provenance + action buttons', async () => {
    const res = await fetch(`${server.url}/api/v1/partials/triage`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /triage <span class="count dim">\(2\)<\/span>/);
    assert.match(html, /investigate-cleanup/);
    assert.match(html, /Investigate cleanup/);
    assert.match(html, /from agent-issues/);
    assert.match(html, /hx-post="\/api\/v1\/issues\/investigate-cleanup\/approve"/);
    assert.match(html, /hx-post="\/api\/v1\/issues\/investigate-cleanup\/discard"/);
    assert.match(html, /another-thing/);
  });

  it('approve moves the file to the first active state and returns a refreshed partial', async () => {
    const res = await fetch(`${server.url}/api/v1/issues/investigate-cleanup/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(res.status, 200);
    const data = (await res.json()) as { from_state: string; to_state: string; identifier: string };
    assert.equal(data.identifier, 'investigate-cleanup');
    assert.equal(data.from_state, 'Triage');
    assert.equal(data.to_state, 'Todo');
    const todoFiles = await readdir(path.join(root, 'Todo'));
    assert.ok(todoFiles.includes('investigate-cleanup.md'));
    const triageFiles = await readdir(path.join(root, 'Triage'));
    assert.ok(!triageFiles.includes('investigate-cleanup.md'));
  });

  it('discard moves to Cancelled (preferred over the first terminal state)', async () => {
    const res = await fetch(`${server.url}/api/v1/issues/another-thing/discard`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(res.status, 200);
    const data = (await res.json()) as { from_state: string; to_state: string };
    assert.equal(data.from_state, 'Triage');
    assert.equal(data.to_state, 'Cancelled');
    const cancelledFiles = await readdir(path.join(root, 'Cancelled'));
    assert.ok(cancelledFiles.includes('another-thing.md'));
  });

  it('approve via HTMX returns the re-rendered triage partial (200 OK)', async () => {
    // Stage a new proposal so the previous tests don't drain the section.
    await writeFile(
      path.join(root, 'Triage', 'htmx-flow.md'),
      `---\nid: "htmx-flow"\nidentifier: "htmx-flow"\ntitle: "HTMX flow"\n---\nbody.`,
    );
    const res = await fetch(`${server.url}/api/v1/issues/htmx-flow/approve`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'hx-request': 'true',
        // Browsers always send Origin on cross-origin form POSTs; matching Host
        // simulates the same-origin dashboard case the endpoint allows.
        origin: server.url,
      },
    });
    assert.equal(res.status, 200);
    const html = await res.text();
    // The htmx flow returns the triage partial. htmx-flow.md should now be gone from
    // the section since it moved to Todo/.
    assert.ok(!html.includes('htmx-flow'));
  });

  it('rejects form-encoded request without HX-Request (CSRF protection)', async () => {
    await writeFile(
      path.join(root, 'Triage', 'csrf-target.md'),
      `---\nid: "csrf-target"\nidentifier: "csrf-target"\ntitle: "CSRF target"\n---\nbody.`,
    );
    const res = await fetch(`${server.url}/api/v1/issues/csrf-target/approve`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        // No hx-request header; emulates a cross-origin form POST.
      },
    });
    assert.equal(res.status, 403);
    // File was not moved.
    const triageFiles = await readdir(path.join(root, 'Triage'));
    assert.ok(triageFiles.includes('csrf-target.md'));
  });

  it('returns 404 when the issue does not exist in Triage/', async () => {
    const res = await fetch(`${server.url}/api/v1/issues/does-not-exist/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(res.status, 404);
    const data = (await res.json()) as { error: { code: string } };
    assert.equal(data.error.code, 'local_issue_not_found');
  });

  it('returns 404 when no tracker is configured', async () => {
    // Spin up a separate server without a tracker to assert the action endpoints
    // refuse cleanly instead of crashing.
    const otherRoot = await mkdtemp(path.join(os.tmpdir(), 'symphony-triage-no-tracker-'));
    const noTracker = await bootServer(otherRoot, { withTracker: false });
    try {
      const res = await fetch(`${noTracker.url}/api/v1/issues/anything/approve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      });
      assert.equal(res.status, 404);
      const data = (await res.json()) as { error: { code: string } };
      assert.equal(data.error.code, 'tracker_no_state_transitions');
    } finally {
      await noTracker.close();
      await rm(otherRoot, { recursive: true, force: true });
    }
  });
});
