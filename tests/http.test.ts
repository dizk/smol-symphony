// HTTP tests for the dashboard's issue-creation surface. Covers the relaxed POST
// contract (title is the only required field; identifier and state are derived/defaulted)
// plus the existing behaviour for callers that supply explicit values.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startHttpServer, type HttpServerOptions } from '../src/http.js';
import type { Orchestrator, Snapshot } from '../src/orchestrator.js';

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

async function bootServer(trackerRoot: string): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const orch = makeStubOrchestrator();
  const opts: HttpServerOptions = {
    port: 0,
    host: '127.0.0.1',
    getTrackerView: () => ({
      trackerRoot,
      activeStates: ['Todo', 'In Progress'],
      terminalStates: ['Done', 'Cancelled'],
      workflowPath: '/tmp/WORKFLOW.md',
    }),
    mcp: null,
  };
  const handle = await startHttpServer(orch, opts);
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
