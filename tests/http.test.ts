// HTTP tests for the dashboard's issue-creation surface. Covers the relaxed POST
// contract (title is the only required field; identifier and state are derived/defaulted)
// plus the existing behaviour for callers that supply explicit values.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { renderMarkdown, startHttpServer, type HttpServerOptions } from '../src/http.js';
import type { Orchestrator, Snapshot } from '../src/orchestrator.js';
import { LocalMarkdownTracker } from '../src/trackers/local.js';

type RunningRow = Snapshot['running'][number];

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
        states: {
          Todo: { role: 'active' },
          'In Progress': { role: 'active' },
          Done: { role: 'terminal' },
          Cancelled: { role: 'terminal' },
          Triage: { role: 'holding' },
        },
        root: trackerRoot,
      })
    : null;
  const serverOpts: HttpServerOptions = {
    port: 0,
    host: '127.0.0.1',
    getTrackerView: () => ({
      trackerRoot,
      states: [
        { name: 'Todo', role: 'active' },
        { name: 'In Progress', role: 'active' },
        { name: 'Done', role: 'terminal' },
        { name: 'Cancelled', role: 'terminal' },
        { name: 'Triage', role: 'holding' },
      ],
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

  it('rejects empty Content-Type without HX-Request (CSRF protection)', async () => {
    // Browsers send no Content-Type on a no-cors `fetch(..., { method: 'POST' })`
    // with no body; that "simple" request bypasses preflight, so an empty
    // Content-Type cross-origin POST must be rejected the same way a form-encoded
    // one is — otherwise any page can drive the triage endpoint.
    await writeFile(
      path.join(root, 'Triage', 'csrf-empty-ctype.md'),
      `---\nid: "csrf-empty-ctype"\nidentifier: "csrf-empty-ctype"\ntitle: "CSRF empty ctype"\n---\nbody.`,
    );
    const res = await fetch(`${server.url}/api/v1/issues/csrf-empty-ctype/approve`, {
      method: 'POST',
      // Undici sets a default content-type on fetch() POSTs; clear it explicitly
      // so the server sees the no-Content-Type case a browser no-cors POST sends.
      headers: { 'content-type': '' },
    });
    assert.equal(res.status, 403);
    // File was not moved.
    const triageFiles = await readdir(path.join(root, 'Triage'));
    assert.ok(triageFiles.includes('csrf-empty-ctype.md'));
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

describe('GET /issues/:identifier — issue detail page', () => {
  let root: string;
  let server: { url: string; close: () => Promise<void> };

  before(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'symphony-detail-'));
    await mkdir(path.join(root, 'Todo'), { recursive: true });
    await mkdir(path.join(root, 'Done'), { recursive: true });
    await mkdir(path.join(root, 'Triage'), { recursive: true });
    await writeFile(
      path.join(root, 'Todo', 'ABC-7.md'),
      [
        '---',
        'id: "ABC-7"',
        'identifier: "ABC-7"',
        'title: "Fix the login bug"',
        'priority: 2',
        'labels: ["bug", "auth"]',
        'blocked_by: ["ABC-5"]',
        'created_at: "2026-05-18T12:00:00Z"',
        'updated_at: "2026-05-19T08:30:00Z"',
        '---',
        '## Background',
        '',
        "Users can't sign in after the **migration** because the token format changed.",
        '',
        '- check `auth/middleware.ts`',
        '- check the prod log',
      ].join('\n'),
    );
    await writeFile(
      path.join(root, 'Done', 'ABC-1.md'),
      `---\nid: "ABC-1"\nidentifier: "ABC-1"\ntitle: "Already done"\n---\nClosed.`,
    );
    await writeFile(
      path.join(root, 'Triage', 'proposed-cleanup.md'),
      [
        '---',
        'id: "proposed-cleanup"',
        'identifier: "proposed-cleanup"',
        'title: "Sweep stale workspaces"',
        'proposed_by: "ABC-7"',
        'proposed_at: "2026-05-20T10:00:00Z"',
        '---',
        'Body text for the proposal.',
      ].join('\n'),
    );
    server = await bootServer(root, { withTracker: true });
  });

  after(async () => {
    await server.close();
    await rm(root, { recursive: true, force: true });
  });

  it('renders the active issue: title, state pill, labels, priority, blocker link, body markdown', async () => {
    const res = await fetch(`${server.url}/issues/ABC-7`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/html/);
    const html = await res.text();
    assert.match(html, /<h1>Fix the login bug<\/h1>/);
    assert.match(html, /<span class="pill running">Todo<\/span>/);
    assert.match(html, /<span class="label-chip">bug<\/span>/);
    assert.match(html, /<span class="label-chip">auth<\/span>/);
    assert.match(html, />priority<\/dt><dd><span class="num">2<\/span><\/dd>/);
    assert.match(
      html,
      /<a class="blocker-link" href="\/issues\/ABC-5">ABC-5<\/a>/,
    );
    assert.match(html, /<h2>Background<\/h2>/);
    assert.match(html, /<strong>migration<\/strong>/);
    assert.match(html, /<code>auth\/middleware\.ts<\/code>/);
    assert.match(html, /<p class="file-path"[^>]*>[^<]*Todo[/\\]ABC-7\.md<\/p>/);
  });

  it('renders a terminal-state issue with the done pill', async () => {
    const res = await fetch(`${server.url}/issues/ABC-1`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /<span class="pill done">Done<\/span>/);
    assert.match(html, /<h1>Already done<\/h1>/);
  });

  it('surfaces proposal provenance for Triage-state issues', async () => {
    const res = await fetch(`${server.url}/issues/proposed-cleanup`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /<h1>Sweep stale workspaces<\/h1>/);
    // Triage is neither active nor terminal so the page falls back to the idle pill.
    assert.match(html, /<span class="pill idle">Triage<\/span>/);
    // `proposed_by` is rendered as a clickable identifier link (the proposal's parent).
    assert.match(html, /<a class="blocker-link" href="\/issues\/ABC-7">ABC-7<\/a>/);
    assert.match(html, />proposed at<\/dt>/);
  });

  it('escapes raw HTML in the title and body so a malicious issue file cannot inject script', async () => {
    await writeFile(
      path.join(root, 'Todo', 'xss-attempt.md'),
      `---\nid: "xss-attempt"\nidentifier: "xss-attempt"\ntitle: "<script>alert(1)</script>"\n---\nBody with <img onerror=alert(2)>.`,
    );
    const res = await fetch(`${server.url}/issues/xss-attempt`);
    assert.equal(res.status, 200);
    const html = await res.text();
    // The page title rendering happens twice: in <title> and in <h1>. Neither should
    // include the literal opening <script> tag.
    assert.ok(!html.includes('<script>alert(1)</script>'), 'raw script tag leaked into page');
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.match(html, /&lt;img onerror=alert\(2\)&gt;/);
  });

  it('returns 404 HTML when no .md file matches the identifier', async () => {
    const res = await fetch(`${server.url}/issues/does-not-exist`);
    assert.equal(res.status, 404);
    assert.match(res.headers.get('content-type') ?? '', /text\/html/);
    const html = await res.text();
    assert.match(html, /issue not found/);
    assert.match(html, /does-not-exist/);
  });
});

describe('disk + triage rows link to the detail page', () => {
  let root: string;
  let server: { url: string; close: () => Promise<void> };

  before(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'symphony-disk-links-'));
    await mkdir(path.join(root, 'Todo'), { recursive: true });
    await mkdir(path.join(root, 'Triage'), { recursive: true });
    await writeFile(
      path.join(root, 'Todo', 'PILE-1.md'),
      `---\nid: "PILE-1"\nidentifier: "PILE-1"\ntitle: "On disk task"\n---\nbody.`,
    );
    await writeFile(
      path.join(root, 'Triage', 'TRI-1.md'),
      `---\nid: "TRI-1"\nidentifier: "TRI-1"\ntitle: "Proposed task"\n---\nbody.`,
    );
    server = await bootServer(root, { withTracker: true });
  });

  after(async () => {
    await server.close();
    await rm(root, { recursive: true, force: true });
  });

  it('on-disk row identifier is an anchor pointing at /issues/<id>', async () => {
    const res = await fetch(`${server.url}/api/v1/partials/disk`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /<a class="ident" href="\/issues\/PILE-1"[^>]*>PILE-1<\/a>/);
    assert.match(html, /<a class="title" href="\/issues\/PILE-1">On disk task<\/a>/);
  });

  it('triage row identifier is an anchor pointing at /issues/<id>', async () => {
    const res = await fetch(`${server.url}/api/v1/partials/triage`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /<a class="ident" href="\/issues\/TRI-1"[^>]*><strong>TRI-1<\/strong><\/a>/);
    assert.match(html, /<a class="title" href="\/issues\/TRI-1">Proposed task<\/a>/);
  });
});

describe('renderMarkdown — agent-flavoured Markdown', () => {
  it('wraps a plain question in a <p> and escapes raw HTML', () => {
    const out = renderMarkdown('Is the <script> tag here safe?');
    assert.equal(out, '<p>Is the &lt;script&gt; tag here safe?</p>');
  });

  it('renders bold, italic, and inline code', () => {
    const out = renderMarkdown('Use **bold** and *italic* with `code` inline.');
    assert.match(out, /<strong>bold<\/strong>/);
    assert.match(out, /<em>italic<\/em>/);
    assert.match(out, /<code>code<\/code>/);
  });

  it('does not turn snake_case_identifiers into italics', () => {
    const out = renderMarkdown('Call set_user_id with the id.');
    assert.ok(!out.includes('<em>'), `unexpected <em> in: ${out}`);
  });

  it('renders headers, paragraphs, and unordered lists', () => {
    const out = renderMarkdown(['# Question', '', 'Should I:', '', '- option A', '- option B'].join('\n'));
    assert.match(out, /<h1>Question<\/h1>/);
    assert.match(out, /<p>Should I:<\/p>/);
    assert.match(out, /<ul><li>option A<\/li><li>option B<\/li><\/ul>/);
  });

  it('renders ordered lists', () => {
    const out = renderMarkdown(['1. first', '2. second'].join('\n'));
    assert.match(out, /<ol><li>first<\/li><li>second<\/li><\/ol>/);
  });

  it('renders fenced code blocks with escaped contents and language class', () => {
    const out = renderMarkdown(['```ts', 'const x = `<i>` + 1;', '```'].join('\n'));
    assert.match(out, /<pre><code class="language-ts">const x = `&lt;i&gt;` \+ 1;<\/code><\/pre>/);
  });

  it('does not process markdown inside a code fence', () => {
    const out = renderMarkdown(['```', '**not bold**', '```'].join('\n'));
    assert.match(out, /<pre><code>\*\*not bold\*\*<\/code><\/pre>/);
    assert.ok(!out.includes('<strong>'), `unexpected <strong> in: ${out}`);
  });

  it('renders safe http(s) and mailto links and rejects javascript: URLs', () => {
    const safe = renderMarkdown('See [docs](https://example.com/path?a=1&b=2).');
    assert.match(safe, /<a href="https:\/\/example.com\/path\?a=1&amp;b=2" rel="noopener noreferrer">docs<\/a>/);

    const mailto = renderMarkdown('Email [me](mailto:me@example.com).');
    assert.match(mailto, /href="mailto:me@example.com"/);

    const unsafe = renderMarkdown('Click [here](javascript:alert(1)).');
    assert.ok(!unsafe.includes('<a '), `javascript: should not produce a link tag: ${unsafe}`);
    assert.ok(unsafe.includes('[here]'), `unsafe link text should be preserved literally: ${unsafe}`);
  });

  it('renders blockquotes', () => {
    const out = renderMarkdown(['> agent says hi', '> on two lines'].join('\n'));
    assert.match(out, /<blockquote>/);
    assert.match(out, /agent says hi/);
  });

  it('escapes HTML inside inline code', () => {
    const out = renderMarkdown('See `<script>alert(1)</script>` literally.');
    assert.match(out, /<code>&lt;script&gt;alert\(1\)&lt;\/script&gt;<\/code>/);
    assert.ok(!out.includes('<script>'), `raw <script> leaked: ${out}`);
  });
});

describe('attention partial — Markdown rendering for steering questions', () => {
  function makeOrchestratorWithSteering(question: string): Orchestrator {
    const row: RunningRow = {
      issue_id: 'q1',
      issue_identifier: 'q1',
      issue_title: 'Sample issue',
      issue_body: '',
      state: 'In Progress',
      session_id: 'abcd1234',
      turn_count: 2,
      last_event: null,
      last_message: null,
      started_at: new Date().toISOString(),
      last_event_at: null,
      tokens: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      steering_requested: true,
      steering_question: question,
      steering_context: null,
      transitioned: false,
    };
    const snap: Snapshot = {
      generated_at: new Date().toISOString(),
      counts: { running: 1, retrying: 0 },
      running: [row],
      retrying: [],
      codex_totals: { input_tokens: 0, output_tokens: 0, total_tokens: 0, seconds_running: 0 },
      rate_limits: null,
    };
    return {
      snapshot: () => snap,
      triggerRefresh: () => ({ status: 'ok' as const }),
      detailByIdentifier: () => null,
    } as unknown as Orchestrator;
  }

  it('renders Markdown inside the question-primary container instead of a raw <p>', async () => {
    const orch = makeOrchestratorWithSteering(
      ['Should I:', '', '- **delete** the file', '- or rename it to `foo.bak`?'].join('\n'),
    );
    const root = await mkdtemp(path.join(os.tmpdir(), 'symphony-md-'));
    const handle = await startHttpServer(orch, {
      port: 0,
      host: '127.0.0.1',
      getTrackerView: () => ({
        trackerRoot: root,
        states: [
          { name: 'Todo', role: 'active' },
          { name: 'In Progress', role: 'active' },
          { name: 'Done', role: 'terminal' },
          { name: 'Cancelled', role: 'terminal' },
          { name: 'Triage', role: 'holding' },
        ],
        workflowPath: '/tmp/WORKFLOW.md',
      }),
      mcp: null,
      tracker: null,
    });
    try {
      const res = await fetch(`http://127.0.0.1:${handle.port}/api/v1/partials/attention`);
      assert.equal(res.status, 200);
      const html = await res.text();
      assert.match(html, /<div class="question-primary">/);
      assert.match(html, /<strong>delete<\/strong>/);
      assert.match(html, /<code>foo\.bak<\/code>/);
      assert.match(html, /<ul><li>/);
    } finally {
      await handle.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

// Phase 4 of the state-machine workflow refactor: the HTTP server reads role
// from the declared `states:` map and uses that to colour the issue-detail pill,
// to order the on-disk listing, to drive the triage approve/discard targets,
// and to gate the dashboard's issue-creation form. These tests boot the server
// against bespoke state shapes (alternative holding name, role permutations) to
// confirm the dashboard tracks the declared config rather than the legacy
// hardcoded "Triage" / "Cancelled" / "Done" strings.

interface BespokeServerOpts {
  states: Array<{ name: string; role: 'active' | 'terminal' | 'holding' }>;
}

async function bootBespoke(
  trackerRoot: string,
  bespoke: BespokeServerOpts,
): Promise<{ url: string; close: () => Promise<void> }> {
  const orch = makeStubOrchestrator();
  const tracker = new LocalMarkdownTracker({
    kind: 'local',
    states: Object.fromEntries(bespoke.states.map((s) => [s.name, { role: s.role }])),
    root: trackerRoot,
  });
  const handle = await startHttpServer(orch, {
    port: 0,
    host: '127.0.0.1',
    getTrackerView: () => ({
      trackerRoot,
      states: bespoke.states,
      workflowPath: '/tmp/WORKFLOW.md',
    }),
    mcp: null,
    tracker,
  });
  return { url: `http://127.0.0.1:${handle.port}`, close: handle.close };
}

describe('role-based state pill on the issue-detail page', () => {
  let root: string;
  let server: { url: string; close: () => Promise<void> };

  before(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'symphony-pill-'));
    // Distinctive state names so the test asserts on role, not on a hardcoded
    // "Todo"/"Done"/"Triage" string: any active state must read as "running",
    // any terminal as "done", any holding as "idle".
    await mkdir(path.join(root, 'Brewing'), { recursive: true });
    await mkdir(path.join(root, 'Shipped'), { recursive: true });
    await mkdir(path.join(root, 'Holding'), { recursive: true });
    await writeFile(
      path.join(root, 'Brewing', 'A-1.md'),
      `---\nid: "A-1"\nidentifier: "A-1"\ntitle: "active item"\n---\nbody.`,
    );
    await writeFile(
      path.join(root, 'Shipped', 'A-2.md'),
      `---\nid: "A-2"\nidentifier: "A-2"\ntitle: "terminal item"\n---\nbody.`,
    );
    await writeFile(
      path.join(root, 'Holding', 'A-3.md'),
      `---\nid: "A-3"\nidentifier: "A-3"\ntitle: "holding item"\n---\nbody.`,
    );
    server = await bootBespoke(root, {
      states: [
        { name: 'Brewing', role: 'active' },
        { name: 'Shipped', role: 'terminal' },
        { name: 'Holding', role: 'holding' },
      ],
    });
  });

  after(async () => {
    await server.close();
    await rm(root, { recursive: true, force: true });
  });

  it('active role → running pill', async () => {
    const res = await fetch(`${server.url}/issues/A-1`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /<span class="pill running">Brewing<\/span>/);
  });

  it('terminal role → done pill', async () => {
    const res = await fetch(`${server.url}/issues/A-2`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /<span class="pill done">Shipped<\/span>/);
  });

  it('holding role → idle pill', async () => {
    const res = await fetch(`${server.url}/issues/A-3`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /<span class="pill idle">Holding<\/span>/);
  });
});

describe('disk partial includes terminal-state issues but excludes holding', () => {
  let root: string;
  let server: { url: string; close: () => Promise<void> };

  before(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'symphony-disk-terminal-'));
    await mkdir(path.join(root, 'Todo'), { recursive: true });
    await mkdir(path.join(root, 'Done'), { recursive: true });
    await mkdir(path.join(root, 'Triage'), { recursive: true });
    await writeFile(
      path.join(root, 'Todo', 'active-1.md'),
      `---\nid: "active-1"\nidentifier: "active-1"\ntitle: "still working"\n---\nbody.`,
    );
    await writeFile(
      path.join(root, 'Done', 'finished-1.md'),
      `---\nid: "finished-1"\nidentifier: "finished-1"\ntitle: "completed task"\n---\nbody.`,
    );
    await writeFile(
      path.join(root, 'Triage', 'pending-1.md'),
      `---\nid: "pending-1"\nidentifier: "pending-1"\ntitle: "needs review"\n---\nbody.`,
    );
    server = await bootBespoke(root, {
      states: [
        { name: 'Todo', role: 'active' },
        { name: 'Done', role: 'terminal' },
        { name: 'Triage', role: 'holding' },
      ],
    });
  });

  after(async () => {
    await server.close();
    await rm(root, { recursive: true, force: true });
  });

  it('includes active-state and terminal-state rows; excludes holding rows', async () => {
    const res = await fetch(`${server.url}/api/v1/partials/disk`);
    assert.equal(res.status, 200);
    const html = await res.text();
    // Active state appears.
    assert.ok(html.includes('active-1'), 'expected active-1 in the disk panel');
    // Terminal state now appears (Phase 4 broadened the visibility rule from
    // "active only" to "every declared non-holding state with issues").
    assert.ok(html.includes('finished-1'), 'expected terminal finished-1 in the disk panel');
    // Holding state is rendered in the separate triage panel; it must not
    // double-list here.
    assert.ok(!html.includes('pending-1'), 'holding-state pending-1 should not appear in the disk panel');
  });
});

describe('disk partial renders states in declared order', () => {
  let root: string;
  let server: { url: string; close: () => Promise<void> };

  before(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'symphony-disk-order-'));
    // Three active states; issues seeded so the alphabetical-by-identifier sort
    // would interleave them, letting the test prove the partial orders by the
    // workflow's declared `states:` order rather than by identifier.
    await mkdir(path.join(root, 'Backlog'), { recursive: true });
    await mkdir(path.join(root, 'Doing'), { recursive: true });
    await mkdir(path.join(root, 'Review'), { recursive: true });
    await writeFile(
      path.join(root, 'Backlog', 'item-c.md'),
      `---\nid: "item-c"\nidentifier: "item-c"\ntitle: "backlog c"\n---\nbody.`,
    );
    await writeFile(
      path.join(root, 'Doing', 'item-b.md'),
      `---\nid: "item-b"\nidentifier: "item-b"\ntitle: "doing b"\n---\nbody.`,
    );
    await writeFile(
      path.join(root, 'Review', 'item-a.md'),
      `---\nid: "item-a"\nidentifier: "item-a"\ntitle: "review a"\n---\nbody.`,
    );
    server = await bootBespoke(root, {
      states: [
        { name: 'Backlog', role: 'active' },
        { name: 'Doing', role: 'active' },
        { name: 'Review', role: 'active' },
        { name: 'Done', role: 'terminal' },
      ],
    });
  });

  after(async () => {
    await server.close();
    await rm(root, { recursive: true, force: true });
  });

  it('orders rows by declared state position (not identifier)', async () => {
    const res = await fetch(`${server.url}/api/v1/partials/disk`);
    assert.equal(res.status, 200);
    const html = await res.text();
    const cIdx = html.indexOf('item-c');
    const bIdx = html.indexOf('item-b');
    const aIdx = html.indexOf('item-a');
    assert.ok(cIdx > -1 && bIdx > -1 && aIdx > -1, 'all three identifiers should render');
    // Declared order is Backlog → Doing → Review, so item-c (Backlog) should
    // render before item-b (Doing) which should render before item-a (Review).
    assert.ok(cIdx < bIdx, `expected item-c (Backlog) before item-b (Doing); got positions ${cIdx} vs ${bIdx}`);
    assert.ok(bIdx < aIdx, `expected item-b (Doing) before item-a (Review); got positions ${bIdx} vs ${aIdx}`);
  });
});

describe('triage approve/discard with alternative holding/cancelled names', () => {
  let root: string;
  let server: { url: string; close: () => Promise<void> };

  before(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'symphony-triage-roles-'));
    await mkdir(path.join(root, 'Holding'), { recursive: true });
    await writeFile(
      path.join(root, 'Holding', 'h-1.md'),
      `---\nid: "h-1"\nidentifier: "h-1"\ntitle: "approve me"\n---\nbody.`,
    );
    await writeFile(
      path.join(root, 'Holding', 'h-2.md'),
      `---\nid: "h-2"\nidentifier: "h-2"\ntitle: "discard me"\n---\nbody.`,
    );
    server = await bootBespoke(root, {
      // First active state is "Working" (not "Todo"); the discard preference
      // for a case-insensitive "Cancelled" must still fire even when the
      // declared name uses different casing ("cancelled" → "cancelled").
      states: [
        { name: 'Working', role: 'active' },
        { name: 'Shipped', role: 'terminal' },
        { name: 'cancelled', role: 'terminal' },
        { name: 'Holding', role: 'holding' },
      ],
    });
  });

  after(async () => {
    await server.close();
    await rm(root, { recursive: true, force: true });
  });

  it('approve moves into the first declared active state (not the literal "Todo")', async () => {
    const res = await fetch(`${server.url}/api/v1/issues/h-1/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(res.status, 200);
    const data = (await res.json()) as { from_state: string; to_state: string };
    assert.equal(data.from_state, 'Holding');
    assert.equal(data.to_state, 'Working');
    const workingFiles = await readdir(path.join(root, 'Working'));
    assert.ok(workingFiles.includes('h-1.md'));
  });

  it('discard prefers the case-insensitive "cancelled" terminal over the first declared terminal', async () => {
    const res = await fetch(`${server.url}/api/v1/issues/h-2/discard`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(res.status, 200);
    const data = (await res.json()) as { from_state: string; to_state: string };
    assert.equal(data.from_state, 'Holding');
    assert.equal(data.to_state, 'cancelled');
    const cancelledFiles = await readdir(path.join(root, 'cancelled'));
    assert.ok(cancelledFiles.includes('h-2.md'));
  });
});

describe('triage discard falls back to first terminal when no "cancelled" is declared', () => {
  let root: string;
  let server: { url: string; close: () => Promise<void> };

  before(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'symphony-triage-fallback-'));
    await mkdir(path.join(root, 'Triage'), { recursive: true });
    await writeFile(
      path.join(root, 'Triage', 'orphan.md'),
      `---\nid: "orphan"\nidentifier: "orphan"\ntitle: "orphan"\n---\nbody.`,
    );
    server = await bootBespoke(root, {
      // Only one terminal, and it's not called "Cancelled". The discard handler
      // must fall back to it rather than failing.
      states: [
        { name: 'Todo', role: 'active' },
        { name: 'Archived', role: 'terminal' },
        { name: 'Triage', role: 'holding' },
      ],
    });
  });

  after(async () => {
    await server.close();
    await rm(root, { recursive: true, force: true });
  });

  it('falls back to the first declared terminal state', async () => {
    const res = await fetch(`${server.url}/api/v1/issues/orphan/discard`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(res.status, 200);
    const data = (await res.json()) as { to_state: string };
    assert.equal(data.to_state, 'Archived');
  });
});

describe('POST /api/v1/issues accepts declared active+terminal states and rejects holding/undeclared', () => {
  let root: string;
  let server: { url: string; close: () => Promise<void> };

  before(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'symphony-issue-roles-'));
    server = await bootBespoke(root, {
      states: [
        { name: 'Working', role: 'active' },
        { name: 'Shipped', role: 'terminal' },
        { name: 'Holding', role: 'holding' },
      ],
    });
  });

  after(async () => {
    await server.close();
    await rm(root, { recursive: true, force: true });
  });

  it('accepts an active state', async () => {
    const res = await fetch(`${server.url}/api/v1/issues`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'item one', state: 'Working' }),
    });
    assert.equal(res.status, 201);
  });

  it('accepts a terminal state', async () => {
    const res = await fetch(`${server.url}/api/v1/issues`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'item two', state: 'Shipped' }),
    });
    assert.equal(res.status, 201);
  });

  it('rejects a holding state name', async () => {
    const res = await fetch(`${server.url}/api/v1/issues`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'item three', state: 'Holding' }),
    });
    assert.equal(res.status, 400);
    const data = (await res.json()) as { error: { message: string } };
    assert.match(data.error.message, /state must be one of/);
    assert.ok(!data.error.message.includes('Holding'), 'holding state should not appear in the allow-list message');
  });

  it('rejects an undeclared state name', async () => {
    const res = await fetch(`${server.url}/api/v1/issues`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'item four', state: 'NotDeclared' }),
    });
    assert.equal(res.status, 400);
  });
});
