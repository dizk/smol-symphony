import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LocalMarkdownTracker } from '../src/trackers/local.js';
import { McpRegistry } from '../src/mcp.js';
import type { RunningEntry, Issue } from '../src/types.js';

// Shared states map used across tests that need both the tracker and the
// registry to agree on the workflow shape. The MCP registry now requires a
// holding state for `propose_issue` (workflow validation guarantees this in
// production); tests construct fixtures directly so they must declare it too.
const trackerStates = {
  Todo: { role: 'active' as const },
  'In Progress': { role: 'active' as const },
  Done: { role: 'terminal' as const },
  Cancelled: { role: 'terminal' as const },
  Triage: { role: 'holding' as const },
};

function makeTracker(root: string): LocalMarkdownTracker {
  return new LocalMarkdownTracker({
    kind: 'local',
    states: trackerStates,
    root,
  });
}

function makeEntry(
  identifier: string,
  state: string,
  over: Partial<Pick<RunningEntry, 'tracker_root_at_dispatch'>> = {},
): RunningEntry {
  const issue: Issue = {
    id: identifier,
    identifier,
    title: 'test',
    description: null,
    priority: null,
    state,
    branch_name: null,
    url: null,
    labels: [],
    blocked_by: [],
    created_at: null,
    updated_at: null,
  };
  return {
    issue_id: identifier,
    identifier,
    issue,
    session_id: null,
    thread_id: null,
    turn_id: null,
    adapter_pid: null,
    last_event: null,
    last_event_at: null,
    last_message: null,
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    last_reported_input_tokens: 0,
    last_reported_output_tokens: 0,
    last_reported_total_tokens: 0,
    turn_count: 0,
    retry_attempt: null,
    started_at: new Date().toISOString(),
    workspace_path: '/tmp/ws',
    cancel: () => {},
    recent_events: [],
    last_error: null,
    cleanup_workspace_on_exit: false,
    mcp_token: null,
    tracker_root_at_dispatch: over.tracker_root_at_dispatch ?? null,
    resolved_actor: 'claude/default',
    transitioned: false,
    steering_requested: false,
    steering_question: null,
    steering_context: null,
  };
}

async function setupTree(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'symphony-mcp-'));
  await mkdir(path.join(root, 'In Progress'), { recursive: true });
  await mkdir(path.join(root, 'Done'), { recursive: true });
  await writeFile(
    path.join(root, 'In Progress', 'ABC-1.md'),
    `---\ntitle: Demo\n---\nBody.`,
  );
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

describe('LocalMarkdownTracker.moveIssueToState', () => {
  it('moves the file into the target state directory', async () => {
    const { root, cleanup } = await setupTree();
    try {
      const t = makeTracker(root);
      const result = await t.moveIssueToState('ABC-1', 'Done');
      assert.equal(result.fromState, 'In Progress');
      assert.equal(result.toState, 'Done');
      const inProgress = await readdir(path.join(root, 'In Progress'));
      const done = await readdir(path.join(root, 'Done'));
      assert.deepEqual(inProgress, []);
      assert.deepEqual(done, ['ABC-1.md']);
    } finally {
      await cleanup();
    }
  });

  it('is a no-op when already in the target state', async () => {
    const { root, cleanup } = await setupTree();
    try {
      const t = makeTracker(root);
      const result = await t.moveIssueToState('ABC-1', 'In Progress');
      assert.equal(result.fromState, 'In Progress');
      assert.equal(result.toState, 'In Progress');
    } finally {
      await cleanup();
    }
  });

  it('refuses to overwrite an existing file at the target path', async () => {
    // Regression: POSIX `rename` silently overwrites. A stale Done/ABC-1.md from a
    // prior cycle must not be clobbered when a recreated In Progress/ABC-1.md is
    // marked done. The stale file carries a different front-matter id so the source
    // lookup is unambiguous, but the basenames collide on the rename target.
    const { root, cleanup } = await setupTree();
    try {
      await writeFile(
        path.join(root, 'Done', 'ABC-1.md'),
        `---\nid: ZOMBIE-1\ntitle: Stale Done\n---\nold body`,
      );
      const t = makeTracker(root);
      await assert.rejects(
        () => t.moveIssueToState('ABC-1', 'Done'),
        (err: unknown) =>
          err instanceof Error &&
          (err as Error & { code?: string }).code === 'local_issue_target_exists',
      );
      // The source file is still in place — no destructive partial state.
      const inProgress = await readdir(path.join(root, 'In Progress'));
      assert.deepEqual(inProgress, ['ABC-1.md']);
    } finally {
      await cleanup();
    }
  });

  it('throws TrackerError when issue is missing', async () => {
    const { root, cleanup } = await setupTree();
    try {
      const t = makeTracker(root);
      await assert.rejects(
        () => t.moveIssueToState('NOT-REAL', 'Done'),
        (err: unknown) =>
          err instanceof Error &&
          (err as Error & { code?: string }).code === 'local_issue_not_found',
      );
    } finally {
      await cleanup();
    }
  });

  it('with fromState moves the correctly-sourced file when only one copy exists', async () => {
    // Regression: passing `fromState` should still work in the no-collision
    // happy path — disambiguation logic must not break the single-match case.
    const { root, cleanup } = await setupTree();
    try {
      const t = makeTracker(root);
      const result = await t.moveIssueToState('ABC-1', 'Done', { fromState: 'In Progress' });
      assert.equal(result.fromState, 'In Progress');
      assert.equal(result.toState, 'Done');
      assert.deepEqual(await readdir(path.join(root, 'In Progress')), []);
      assert.deepEqual(await readdir(path.join(root, 'Done')), ['ABC-1.md']);
    } finally {
      await cleanup();
    }
  });

  it('throws local_issue_ambiguous when multiple files share an id and no fromState given', async () => {
    // Regression: when two files in different non-target states share the
    // same id (front-matter override on one with a basename-mismatching id),
    // the tracker must refuse to guess and report which states collided.
    const { root, cleanup } = await setupTree();
    try {
      await mkdir(path.join(root, 'Todo'), { recursive: true });
      // The In Progress file already exists as ABC-1.md with id defaulting to basename.
      // Plant a second file in Todo whose front-matter id ALSO resolves to ABC-1.
      await writeFile(
        path.join(root, 'Todo', 'XYZ-9.md'),
        `---\nid: ABC-1\ntitle: Shadow\n---\nshadow body`,
      );
      const t = makeTracker(root);
      await assert.rejects(
        () => t.moveIssueToState('ABC-1', 'Done'),
        (err: unknown) => {
          if (!(err instanceof Error)) return false;
          const code = (err as Error & { code?: string }).code;
          if (code !== 'local_issue_ambiguous') return false;
          // Message names both colliding state directories.
          return /In Progress/.test(err.message) && /Todo/.test(err.message);
        },
      );
    } finally {
      await cleanup();
    }
  });
});

describe('McpRegistry JSON-RPC', () => {
  it('routes token issuance + comparison through the injected CryptoEnv', async () => {
    // Issue 96: tests can pin a deterministic CryptoEnv so token shape and
    // wrong-token rejection don't depend on randomBytes / timingSafeEqual
    // ambient state. The registry must use the env for both `activate` (mint)
    // and `isActive` (compare), and a constant-time-equal stub returning false
    // must reject even a literally-matching token.
    const { root, cleanup } = await setupTree();
    try {
      const t = makeTracker(root);
      const calls: Array<'newToken' | 'constantTimeEqual'> = [];
      let nextToken = 'deterministic-token-A';
      const reg = new McpRegistry(t, {
        crypto: {
          newToken: () => {
            calls.push('newToken');
            return nextToken;
          },
          constantTimeEqual: (a, b) => {
            calls.push('constantTimeEqual');
            return a === b;
          },
        },
      });
      const entry = makeEntry('ABC-1', 'In Progress');
      const token = reg.activate(entry);
      assert.equal(token, 'deterministic-token-A');
      assert.deepEqual(calls, ['newToken']);
      assert.equal(reg.isActive('ABC-1', 'deterministic-token-A'), true);
      assert.equal(reg.isActive('ABC-1', 'deterministic-token-B'), false);
      // Mint a second token on a second activation; verify it doesn't reuse the first.
      nextToken = 'deterministic-token-B';
      const entry2 = makeEntry('ABC-2', 'In Progress');
      const token2 = reg.activate(entry2);
      assert.equal(token2, 'deterministic-token-B');
      assert.notEqual(token2, token);
    } finally {
      await cleanup();
    }
  });

  it('lists the three tools', async () => {
    const { root, cleanup } = await setupTree();
    try {
      const t = makeTracker(root);
      const reg = new McpRegistry(t);
      const entry = makeEntry('ABC-1', 'In Progress');
      const token = reg.activate(entry);
      const res = await reg.handleJsonRpc('ABC-1', token, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
      });
      assert.ok(res && 'result' in res);
      const result = res.result as { tools: Array<{ name: string }> };
      const names = result.tools.map((t) => t.name).sort();
      assert.deepEqual(names, [
        'propose_issue',
        'request_human_steering',
        'transition',
      ]);
    } finally {
      await cleanup();
    }
  });

  it('rejects calls with the wrong token', async () => {
    const { root, cleanup } = await setupTree();
    try {
      const t = makeTracker(root);
      const reg = new McpRegistry(t);
      const entry = makeEntry('ABC-1', 'In Progress');
      reg.activate(entry);
      const res = await reg.handleJsonRpc('ABC-1', 'wrong-token', {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
      });
      assert.ok(res && 'error' in res);
      assert.equal((res as { error: { code: number } }).error.code, -32002);
    } finally {
      await cleanup();
    }
  });

  it('isActive rejects tokens of different lengths without throwing', async () => {
    // Regression: the timing-safe comparison must short-circuit cleanly on
    // length mismatch (timingSafeEqual throws on unequal-length buffers).
    // It must also compare BYTE lengths, not JS code-unit lengths: a non-ASCII
    // attacker token with matching `.length` but mismatched UTF-8 byte length
    // used to leak through and crash timingSafeEqual with a 500 instead of a
    // clean wrong-token rejection.
    const { root, cleanup } = await setupTree();
    try {
      const t = makeTracker(root);
      const reg = new McpRegistry(t);
      const entry = makeEntry('ABC-1', 'In Progress');
      const token = reg.activate(entry);
      assert.equal(reg.isActive('ABC-1', token), true);
      assert.equal(reg.isActive('ABC-1', 'short'), false);
      assert.equal(reg.isActive('ABC-1', token + 'extra'), false);
      // Same length, all wrong bytes.
      const wrong = 'x'.repeat(token.length);
      assert.equal(reg.isActive('ABC-1', wrong), false);
      // Same JS string length, different UTF-8 byte length. 'é' is one code
      // unit but two UTF-8 bytes, so this string matches token.length but
      // encodes to 2*token.length bytes — the buffer-length guard must catch
      // it without throwing.
      const nonAscii = 'é'.repeat(token.length);
      assert.equal(nonAscii.length, token.length);
      assert.equal(reg.isActive('ABC-1', nonAscii), false);
    } finally {
      await cleanup();
    }
  });

  it('request_human_steering stashes question, ack returns, submitSteeringReply unblocks waiter', async () => {
    const { root, cleanup } = await setupTree();
    try {
      const t = makeTracker(root);
      const reg = new McpRegistry(t);
      const entry = makeEntry('ABC-1', 'In Progress');
      const token = reg.activate(entry);

      const ack = await reg.handleJsonRpc('ABC-1', token, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'request_human_steering',
          arguments: { question: 'A or B?', context: 'opts: A, B' },
        },
      });
      const ackResult = (ack as { result: { isError: boolean; content: Array<{ text: string }> } }).result;
      assert.equal(ackResult.isError, false);
      assert.equal(entry.steering_requested, true);
      assert.equal(entry.steering_question, 'A or B?');
      assert.equal(entry.steering_context, 'opts: A, B');

      const cancel = { cancelled: false };
      const waiter = reg.awaitSteeringReply('ABC-1', cancel);
      // small delay so the waiter installs before we submit
      await new Promise((r) => setTimeout(r, 20));
      const accepted = reg.submitSteeringReply('ABC-1', 'go with A');
      assert.equal(accepted, true);
      const reply = await waiter;
      assert.equal(reply, 'go with A');
    } finally {
      await cleanup();
    }
  });

  it('submitSteeringReply resolves an awaiting waiter after an arbitrary delay (slow human)', async () => {
    // Regression (round-12 codex finding): the orchestrator's reconcile loop
    // exempts entries with steering_requested=true from stall detection so the
    // wait can legitimately exceed acp.stall_timeout_ms while the human composes
    // a reply. This locks in the registry-side invariant the exemption relies on:
    // a delayed submitSteeringReply must still resolve the original waiter, with
    // entry.steering_requested staying true for the entire wait window so the
    // orchestrator's exemption check remains valid throughout.
    const { root, cleanup } = await setupTree();
    try {
      const t = makeTracker(root);
      const reg = new McpRegistry(t);
      const entry = makeEntry('ABC-1', 'In Progress');
      const token = reg.activate(entry);
      await reg.handleJsonRpc('ABC-1', token, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'request_human_steering',
          arguments: { question: 'A or B?', context: null },
        },
      });
      assert.equal(entry.steering_requested, true);
      const cancel = { cancelled: false };
      const waiter = reg.awaitSteeringReply('ABC-1', cancel);
      // Hold off the reply long enough to simulate a slow human; verify the
      // steering_requested flag stays asserted across the wait so the
      // orchestrator's stall-detection exemption keeps applying.
      await new Promise((r) => setTimeout(r, 150));
      assert.equal(entry.steering_requested, true);
      assert.equal(cancel.cancelled, false);
      const accepted = reg.submitSteeringReply('ABC-1', 'go with B');
      assert.equal(accepted, true);
      const reply = await waiter;
      assert.equal(reply, 'go with B');
    } finally {
      await cleanup();
    }
  });

  it('awaitSteeringReply returns null when the cancel signal trips', async () => {
    const { root, cleanup } = await setupTree();
    try {
      const t = makeTracker(root);
      const reg = new McpRegistry(t);
      const entry = makeEntry('ABC-1', 'In Progress');
      reg.activate(entry);
      const cancel = { cancelled: false };
      const waiter = reg.awaitSteeringReply('ABC-1', cancel);
      setTimeout(() => {
        cancel.cancelled = true;
      }, 50);
      const result = await waiter;
      assert.equal(result, null);
    } finally {
      await cleanup();
    }
  });

  it('submitSteeringReply returns false when no waiter exists', async () => {
    const { root, cleanup } = await setupTree();
    try {
      const t = makeTracker(root);
      const reg = new McpRegistry(t);
      const entry = makeEntry('ABC-1', 'In Progress');
      reg.activate(entry);
      const ok = reg.submitSteeringReply('ABC-1', 'unsolicited');
      assert.equal(ok, false);
    } finally {
      await cleanup();
    }
  });

  it('deactivate rejects pending waiter', async () => {
    const { root, cleanup } = await setupTree();
    try {
      const t = makeTracker(root);
      const reg = new McpRegistry(t);
      const entry = makeEntry('ABC-1', 'In Progress');
      reg.activate(entry);
      const waiter = reg.awaitSteeringReply('ABC-1', { cancelled: false });
      // give the waiter a tick to install
      await new Promise((r) => setTimeout(r, 20));
      reg.deactivate('ABC-1');
      await assert.rejects(() => waiter, /mcp deactivated/);
    } finally {
      await cleanup();
    }
  });

  it('unknown method returns -32601', async () => {
    const { root, cleanup } = await setupTree();
    try {
      const t = makeTracker(root);
      const reg = new McpRegistry(t);
      const entry = makeEntry('ABC-1', 'In Progress');
      const token = reg.activate(entry);
      const res = await reg.handleJsonRpc('ABC-1', token, {
        jsonrpc: '2.0',
        id: 1,
        method: 'sessions/something',
      });
      assert.ok(res && 'error' in res);
      assert.equal((res as { error: { code: number } }).error.code, -32601);
    } finally {
      await cleanup();
    }
  });

  it('initialize returns protocol version and tool capability', async () => {
    const { root, cleanup } = await setupTree();
    try {
      const t = makeTracker(root);
      const reg = new McpRegistry(t);
      const entry = makeEntry('ABC-1', 'In Progress');
      const token = reg.activate(entry);
      const res = await reg.handleJsonRpc('ABC-1', token, {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {},
      });
      assert.ok(res && 'result' in res);
      const result = res.result as { protocolVersion: string; capabilities: { tools: unknown } };
      assert.equal(typeof result.protocolVersion, 'string');
      assert.ok(result.capabilities.tools);
    } finally {
      await cleanup();
    }
  });
});

describe('McpRegistry.buildUrl', () => {
  it('returns null when no effective port and no explicit URL (avoids advertising a dead endpoint)', async () => {
    const { root, cleanup } = await setupTree();
    try {
      const t = makeTracker(root);
      const reg = new McpRegistry(t);
      // setEffectivePort has not been called (e.g. HTTP server disabled).
      const url = reg.buildUrl('ABC-1', { host: '10.0.2.2', explicit_host_url: null });
      assert.equal(url, null);
    } finally {
      await cleanup();
    }
  });

  it('uses the bound port (not server.port at parse time)', async () => {
    const { root, cleanup } = await setupTree();
    try {
      const t = makeTracker(root);
      const reg = new McpRegistry(t);
      reg.setEffectivePort(9090);
      const url = reg.buildUrl('ABC-1', { host: '10.0.2.2', explicit_host_url: null });
      assert.equal(url, 'http://10.0.2.2:9090/api/v1/issues/ABC-1/mcp');
    } finally {
      await cleanup();
    }
  });

  it('honors an explicit host_url override and ignores the bound port', async () => {
    const { root, cleanup } = await setupTree();
    try {
      const t = makeTracker(root);
      const reg = new McpRegistry(t);
      reg.setEffectivePort(8787);
      const url = reg.buildUrl('ABC-1', {
        host: '10.0.2.2',
        explicit_host_url: 'https://symphony.internal:9443/',
      });
      assert.equal(url, 'https://symphony.internal:9443/api/v1/issues/ABC-1/mcp');
    } finally {
      await cleanup();
    }
  });

  it('URL-encodes the identifier so weird ids do not break the route', async () => {
    const { root, cleanup } = await setupTree();
    try {
      const t = makeTracker(root);
      const reg = new McpRegistry(t);
      reg.setEffectivePort(8787);
      const url = reg.buildUrl('ABC-1 hi', { host: '10.0.2.2', explicit_host_url: null });
      assert.equal(url, 'http://10.0.2.2:8787/api/v1/issues/ABC-1%20hi/mcp');
    } finally {
      await cleanup();
    }
  });
});

describe('McpRegistry propose_issue', () => {
  it('writes a Triage/<slug>.md file with proposed_by stamped from the calling issue', async () => {
    const { root, cleanup } = await setupTree();
    try {
      const t = makeTracker(root);
      const reg = new McpRegistry(t, { states: trackerStates });
      const entry = makeEntry('ABC-1', 'In Progress', { tracker_root_at_dispatch: root });
      const token = reg.activate(entry);
      const res = await reg.handleJsonRpc('ABC-1', token, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'propose_issue',
          arguments: {
            title: 'Investigate flaky workspace cleanup',
            description: 'Saw two consecutive runs leave dangling .symphony-runtime dirs.',
            labels: ['bug', 'flaky'],
            priority: 3,
          },
        },
      });
      assert.ok(res && 'result' in res);
      const result = res.result as {
        isError: boolean;
        content: Array<{ text: string }>;
        structuredContent: { identifier: string; state: string; path: string };
      };
      assert.equal(result.isError, false);
      assert.match(result.content[0]!.text, /^Proposed issue 1 /);
      assert.equal(result.structuredContent.state, 'Triage');
      assert.equal(result.structuredContent.identifier, '1');

      const triageDir = path.join(root, 'Triage');
      const files = await readdir(triageDir);
      assert.deepEqual(files, ['1.md']);
      const body = await readFile(path.join(triageDir, files[0]!), 'utf8');
      assert.match(body, /title: "Investigate flaky workspace cleanup"/);
      assert.match(body, /proposed_by: "ABC-1"/);
      assert.match(body, /proposed_at: "/);
      assert.match(body, /labels: \["bug", "flaky"\]/);
      assert.match(body, /priority: 3/);
      assert.match(body, /Saw two consecutive runs/);
    } finally {
      await cleanup();
    }
  });

  it('picks the next free numeric identifier across all state directories', async () => {
    // Regression-flavor: a prior cycle left `Done/1.md` behind. The new numeric proposal
    // must skip 1 and land at 2 instead of overwriting the stale terminal file. Title-slug
    // legacy files in other states are inert: only numeric basenames consume IDs.
    const { root, cleanup } = await setupTree();
    try {
      await writeFile(path.join(root, 'Done', '1.md'), `---\ntitle: Old\n---\nbody.`);
      await writeFile(
        path.join(root, 'Done', 'legacy-slug.md'),
        `---\ntitle: Legacy\n---\nbody.`,
      );
      const t = makeTracker(root);
      const reg = new McpRegistry(t, { states: trackerStates });
      const entry = makeEntry('ABC-1', 'In Progress', { tracker_root_at_dispatch: root });
      const token = reg.activate(entry);
      const res = await reg.handleJsonRpc('ABC-1', token, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'propose_issue',
          arguments: { title: 'Fix the thing' },
        },
      });
      const result = (res as {
        result: { isError: boolean; structuredContent: { identifier: string } };
      }).result;
      assert.equal(result.isError, false);
      assert.equal(result.structuredContent.identifier, '2');
      assert.deepEqual(await readdir(path.join(root, 'Triage')), ['2.md']);
    } finally {
      await cleanup();
    }
  });

  it('rejects missing or multi-line title', async () => {
    const { root, cleanup } = await setupTree();
    try {
      const t = makeTracker(root);
      const reg = new McpRegistry(t, { states: trackerStates });
      const entry = makeEntry('ABC-1', 'In Progress', { tracker_root_at_dispatch: root });
      const token = reg.activate(entry);
      const noTitle = await reg.handleJsonRpc('ABC-1', token, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'propose_issue', arguments: {} },
      });
      const noTitleResult = (noTitle as { result: { isError: boolean; content: Array<{ text: string }> } })
        .result;
      assert.equal(noTitleResult.isError, true);
      assert.match(noTitleResult.content[0]!.text, /title is required/);

      const multiLine = await reg.handleJsonRpc('ABC-1', token, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'propose_issue', arguments: { title: 'two\nlines' } },
      });
      const multiLineResult = (multiLine as { result: { isError: boolean; content: Array<{ text: string }> } })
        .result;
      assert.equal(multiLineResult.isError, true);
      assert.match(multiLineResult.content[0]!.text, /must be a single line/);

      // No triage file was written for either failure.
      let triageFiles: string[] = [];
      try {
        triageFiles = await readdir(path.join(root, 'Triage'));
      } catch {
        triageFiles = [];
      }
      assert.deepEqual(triageFiles, []);
    } finally {
      await cleanup();
    }
  });

  it('uses the tracker root snapshotted at dispatch time, not a post-reload root', async () => {
    // Same rationale as `transition`: a workflow reload that mutates tracker.root mid-flight
    // must not redirect an in-flight proposal to a different filesystem location.
    const { root, cleanup } = await setupTree();
    try {
      const t = makeTracker(root);
      const reg = new McpRegistry(t, { states: trackerStates });
      const entry = makeEntry('ABC-1', 'In Progress', { tracker_root_at_dispatch: root });
      const decoyRoot = await mkdtemp(path.join(os.tmpdir(), 'symphony-decoy-propose-'));
      try {
        t.updateConfig({
          kind: 'local',
          states: {
            Todo: { role: 'active' },
            'In Progress': { role: 'active' },
            Done: { role: 'terminal' },
            Triage: { role: 'holding' },
          },
          root: decoyRoot,
        });
        const token = reg.activate(entry);
        await reg.handleJsonRpc('ABC-1', token, {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'propose_issue', arguments: { title: 'Snapshot test' } },
        });
        // Lands in the original root, NOT the decoy.
        assert.deepEqual(await readdir(path.join(root, 'Triage')), ['1.md']);
        let decoyFiles: string[] = [];
        try {
          decoyFiles = await readdir(path.join(decoyRoot, 'Triage'));
        } catch {
          decoyFiles = [];
        }
        assert.deepEqual(decoyFiles, []);
      } finally {
        await rm(decoyRoot, { recursive: true, force: true });
      }
    } finally {
      await cleanup();
    }
  });
});

describe('McpRegistry transition', () => {
  // Build a 5-state workflow shape (Todo/Review active, Done/Cancelled terminal,
  // Triage holding) on disk and feed the same states map into the registry. This
  // mirrors what bin/symphony.ts wires up at runtime.
  async function setupStateTree(): Promise<{ root: string; cleanup: () => Promise<void> }> {
    const r = await mkdtemp(path.join(os.tmpdir(), 'symphony-mcp-states-'));
    for (const dir of ['Todo', 'Review', 'Done', 'Cancelled', 'Triage']) {
      await mkdir(path.join(r, dir), { recursive: true });
    }
    return { root: r, cleanup: () => rm(r, { recursive: true, force: true }) };
  }

  const states = {
    Todo: { role: 'active' as const },
    Review: { role: 'active' as const, allowed_transitions: ['Todo', 'Done'] },
    Done: { role: 'terminal' as const },
    Cancelled: { role: 'terminal' as const },
    Triage: { role: 'holding' as const },
  };

  function makeStateTracker(root: string): LocalMarkdownTracker {
    return new LocalMarkdownTracker({
      kind: 'local',
      states,
      root,
    });
  }

  it('appends notes, moves the file, sets transitioned and preserves workspace for active→active', async () => {
    const { root, cleanup } = await setupStateTree();
    try {
      await writeFile(
        path.join(root, 'Todo', 'ABC-1.md'),
        `---\ntitle: Issue\n---\nOriginal body.`,
      );
      const t = makeStateTracker(root);
      const reg = new McpRegistry(t, { states });
      const entry = makeEntry('ABC-1', 'Todo', { tracker_root_at_dispatch: root });
      entry.resolved_actor = 'claude/claude-opus-4-7';
      const token = reg.activate(entry);
      const res = await reg.handleJsonRpc('ABC-1', token, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'transition',
          arguments: {
            to_state: 'Review',
            notes: 'Implementation done; please review the workspace cleanup logic.',
          },
        },
      });
      assert.ok(res && 'result' in res);
      const result = res.result as {
        isError: boolean;
        content: Array<{ type: string; text?: string }>;
        structuredContent: { from_state: string; to_state: string; cleanup_workspace_on_exit: boolean };
      };
      assert.equal(result.isError, false);
      assert.equal(entry.transitioned, true);
      // Active→active: workspace NOT cleaned up so the same agent/<id> branch
      // survives into the next state.
      assert.equal(entry.cleanup_workspace_on_exit, false);
      assert.equal(result.structuredContent.from_state, 'Todo');
      assert.equal(result.structuredContent.to_state, 'Review');
      assert.equal(result.structuredContent.cleanup_workspace_on_exit, false);
      // File landed in Review/ with the notes block appended.
      assert.deepEqual(await readdir(path.join(root, 'Todo')), []);
      assert.deepEqual(await readdir(path.join(root, 'Review')), ['ABC-1.md']);
      const body = await readFile(path.join(root, 'Review', 'ABC-1.md'), 'utf8');
      assert.match(body, /## claude\/claude-opus-4-7 — \S+ — Todo → Review/);
      assert.match(body, /please review the workspace cleanup logic\./);
    } finally {
      await cleanup();
    }
  });

  it('suppresses cleanup_workspace_on_exit on active→merge_state when pr_autopilot is enabled', async () => {
    // Issue 38: the pr autopilot owns the workspace for issues in the merge
    // state — it rebases inside the workspace and removes it once the PR
    // merges. The MCP transition must NOT flip cleanup on transition into
    // that state, or the terminal cleanup path would reap the workspace
    // before the autopilot could ever use it. Other terminal states (e.g.
    // Cancelled) keep the standard cleanup-on-transition behavior.
    const { root, cleanup } = await setupStateTree();
    try {
      await writeFile(
        path.join(root, 'Review', 'AB-1.md'),
        `---\ntitle: Issue\n---\nbody`,
      );
      const t = makeStateTracker(root);
      const reg = new McpRegistry(t, {
        states,
        prAutopilot: {
          enabled: true,
          merge_state: 'Done',
          close_state: 'Cancelled',
          conflict_route_to: null,
          auto_merge_strategy: 'squash',
          poll_interval_ms: 30000,
        },
      });
      const entry = makeEntry('AB-1', 'Review', { tracker_root_at_dispatch: root });
      const token = reg.activate(entry);
      const res = await reg.handleJsonRpc('AB-1', token, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'transition', arguments: { to_state: 'Done', notes: 'LGTM' } },
      });
      const result = (res as { result: { isError: boolean; structuredContent: { cleanup_workspace_on_exit: boolean } } })
        .result;
      assert.equal(result.isError, false);
      assert.equal(
        entry.cleanup_workspace_on_exit,
        false,
        'pr_autopilot suppresses cleanup so the autopilot can rebase in the workspace',
      );
      assert.equal(result.structuredContent.cleanup_workspace_on_exit, false);
      // Issue file did move into Done/.
      assert.deepEqual(await readdir(path.join(root, 'Done')), ['AB-1.md']);
    } finally {
      await cleanup();
    }
  });

  it('still cleans up on active→close_state (Cancelled) even when pr_autopilot is enabled', async () => {
    // The close_state path doesn't need a workspace — the autopilot just
    // closes the PR via the GH API. Normal terminal cleanup runs so the
    // workspace + agent branch are reaped immediately. Start from Todo
    // because Review declares `allowed_transitions: [Todo, Done]` in this
    // suite's fixture (Cancelled isn't reachable from Review).
    const { root, cleanup } = await setupStateTree();
    try {
      await writeFile(
        path.join(root, 'Todo', 'AB-2.md'),
        `---\ntitle: Issue\n---\nbody`,
      );
      const t = makeStateTracker(root);
      const reg = new McpRegistry(t, {
        states,
        prAutopilot: {
          enabled: true,
          merge_state: 'Done',
          close_state: 'Cancelled',
          conflict_route_to: null,
          auto_merge_strategy: 'squash',
          poll_interval_ms: 30000,
        },
      });
      const entry = makeEntry('AB-2', 'Todo', { tracker_root_at_dispatch: root });
      const token = reg.activate(entry);
      const res = await reg.handleJsonRpc('AB-2', token, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'transition', arguments: { to_state: 'Cancelled' } },
      });
      const result = (res as { result: { isError: boolean } }).result;
      assert.equal(result.isError, false);
      assert.equal(entry.cleanup_workspace_on_exit, true);
    } finally {
      await cleanup();
    }
  });

  it('active→terminal sets cleanup_workspace_on_exit', async () => {
    const { root, cleanup } = await setupStateTree();
    try {
      await writeFile(
        path.join(root, 'Review', 'ABC-1.md'),
        `---\ntitle: Issue\n---\nbody`,
      );
      const t = makeStateTracker(root);
      const reg = new McpRegistry(t, { states });
      const entry = makeEntry('ABC-1', 'Review', { tracker_root_at_dispatch: root });
      const token = reg.activate(entry);
      const res = await reg.handleJsonRpc('ABC-1', token, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'transition', arguments: { to_state: 'Done', notes: 'LGTM' } },
      });
      const result = (res as { result: { isError: boolean; structuredContent: { cleanup_workspace_on_exit: boolean } } })
        .result;
      assert.equal(result.isError, false);
      assert.equal(entry.cleanup_workspace_on_exit, true);
      assert.equal(result.structuredContent.cleanup_workspace_on_exit, true);
      assert.deepEqual(await readdir(path.join(root, 'Done')), ['ABC-1.md']);
    } finally {
      await cleanup();
    }
  });

  it('updates entry.issue.state on successful transition so per-state hooks resolve correctly', async () => {
    // The runner's after_run and the orchestrator's before_remove resolve hooks
    // against runningEntry.issue.state. If the MCP handler did not mutate it, the
    // resolver would pick up the pre-transition state and a terminal-state hook
    // (e.g. Done's PR-create after_run) would never fire.
    const { root, cleanup } = await setupStateTree();
    try {
      await writeFile(path.join(root, 'Todo', 'ABC-1.md'), `---\ntitle: T\n---\nbody`);
      const t = makeStateTracker(root);
      const reg = new McpRegistry(t, { states });
      const entry = makeEntry('ABC-1', 'Todo', { tracker_root_at_dispatch: root });
      const token = reg.activate(entry);
      assert.equal(entry.issue.state, 'Todo');
      const res = await reg.handleJsonRpc('ABC-1', token, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'transition', arguments: { to_state: 'Review' } },
      });
      const result = (res as { result: { isError: boolean } }).result;
      assert.equal(result.isError, false);
      assert.equal(entry.issue.state, 'Review');
    } finally {
      await cleanup();
    }
  });

  it('preserves declared-casing for the post-transition entry state under case-insensitive input', async () => {
    const { root, cleanup } = await setupStateTree();
    try {
      await writeFile(path.join(root, 'Todo', 'ABC-1.md'), `---\ntitle: T\n---\nbody`);
      const t = makeStateTracker(root);
      const reg = new McpRegistry(t, { states });
      const entry = makeEntry('ABC-1', 'Todo', { tracker_root_at_dispatch: root });
      const token = reg.activate(entry);
      await reg.handleJsonRpc('ABC-1', token, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'transition', arguments: { to_state: 'review' } },
      });
      // The lowercase 'review' input still lands as the declared casing 'Review' on
      // the entry, matching the directory name and the workflow's `states:` key.
      assert.equal(entry.issue.state, 'Review');
    } finally {
      await cleanup();
    }
  });

  it('rejects unknown to_state with a structured error listing declared states', async () => {
    const { root, cleanup } = await setupStateTree();
    try {
      await writeFile(path.join(root, 'Todo', 'ABC-1.md'), `---\ntitle: T\n---\nbody`);
      const t = makeStateTracker(root);
      const reg = new McpRegistry(t, { states });
      const entry = makeEntry('ABC-1', 'Todo', { tracker_root_at_dispatch: root });
      const token = reg.activate(entry);
      const res = await reg.handleJsonRpc('ABC-1', token, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'transition', arguments: { to_state: 'Reveiw' } },
      });
      assert.ok(res && 'result' in res);
      const result = res.result as {
        isError: boolean;
        content: Array<{ type: string; text?: string }>;
        structuredContent?: Record<string, unknown>;
      };
      assert.equal(result.isError, true);
      // Human-readable text block.
      const text = result.content.find((c) => c.type === 'text');
      assert.ok(text && /not declared/.test(text.text ?? ''));
      assert.ok(text && /Todo, Review, Done, Cancelled, Triage/.test(text.text ?? ''));
      // Structured payload on the SDK's structuredContent slot (MCP 2025-06-18).
      assert.ok(result.structuredContent);
      assert.equal(result.structuredContent!['error'], 'unknown_state');
      assert.deepEqual(result.structuredContent!['declared_states'], [
        'Todo',
        'Review',
        'Done',
        'Cancelled',
        'Triage',
      ]);
      // No file move, no flag flip.
      assert.equal(entry.transitioned, false);
      assert.equal(entry.cleanup_workspace_on_exit, false);
      assert.deepEqual(await readdir(path.join(root, 'Todo')), ['ABC-1.md']);
    } finally {
      await cleanup();
    }
  });

  it('rejects disallowed transitions with allowed_transitions list', async () => {
    // Review declares allowed_transitions: [Todo, Done]; attempting to jump to
    // Cancelled must be rejected with a structured payload.
    const { root, cleanup } = await setupStateTree();
    try {
      await writeFile(path.join(root, 'Review', 'ABC-1.md'), `---\ntitle: R\n---\nbody`);
      const t = makeStateTracker(root);
      const reg = new McpRegistry(t, { states });
      const entry = makeEntry('ABC-1', 'Review', { tracker_root_at_dispatch: root });
      const token = reg.activate(entry);
      const res = await reg.handleJsonRpc('ABC-1', token, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'transition', arguments: { to_state: 'Cancelled' } },
      });
      const result = (res as {
        result: {
          isError: boolean;
          content: Array<{ type: string; text?: string }>;
          structuredContent?: Record<string, unknown>;
        };
      }).result;
      assert.equal(result.isError, true);
      const text = result.content.find((c) => c.type === 'text');
      assert.ok(text && /not allowed from "Review"/.test(text.text ?? ''));
      assert.ok(result.structuredContent);
      assert.equal(result.structuredContent!['error'], 'transition_not_allowed');
      assert.equal(result.structuredContent!['from_state'], 'Review');
      assert.equal(result.structuredContent!['requested_to_state'], 'Cancelled');
      assert.deepEqual(result.structuredContent!['allowed_transitions'], ['Todo', 'Done']);
      // No-op on disk.
      assert.equal(entry.transitioned, false);
      assert.deepEqual(await readdir(path.join(root, 'Review')), ['ABC-1.md']);
    } finally {
      await cleanup();
    }
  });

  it('case-insensitive target match preserves declared casing in the move', async () => {
    const { root, cleanup } = await setupStateTree();
    try {
      await writeFile(path.join(root, 'Todo', 'ABC-1.md'), `---\ntitle: T\n---\nbody`);
      const t = makeStateTracker(root);
      const reg = new McpRegistry(t, { states });
      const entry = makeEntry('ABC-1', 'Todo', { tracker_root_at_dispatch: root });
      const token = reg.activate(entry);
      // Lowercase 'review' must resolve to the declared 'Review' state.
      const res = await reg.handleJsonRpc('ABC-1', token, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'transition', arguments: { to_state: 'review', notes: 'x' } },
      });
      const result = (res as { result: { isError: boolean; structuredContent: { to_state: string } } }).result;
      assert.equal(result.isError, false);
      assert.equal(result.structuredContent.to_state, 'Review');
      // The file lands in the declared-casing directory.
      assert.deepEqual(await readdir(path.join(root, 'Review')), ['ABC-1.md']);
    } finally {
      await cleanup();
    }
  });

  it('propose_issue lands in the first declared holding state, not literal Triage', async () => {
    // Workflow with a holding state named something other than "Triage" — the
    // proposal must land there, not in a hardcoded Triage directory.
    const customStates = {
      Todo: { role: 'active' as const },
      Done: { role: 'terminal' as const },
      Inbox: { role: 'holding' as const },
    };
    const root = await mkdtemp(path.join(os.tmpdir(), 'symphony-propose-holding-'));
    try {
      for (const dir of ['Todo', 'Done', 'Inbox']) {
        await mkdir(path.join(root, dir), { recursive: true });
      }
      const t = new LocalMarkdownTracker({
        kind: 'local',
        states: customStates,
        root,
      });
      const reg = new McpRegistry(t, { states: customStates });
      const entry = makeEntry('ABC-1', 'Todo', { tracker_root_at_dispatch: root });
      const token = reg.activate(entry);
      const res = await reg.handleJsonRpc('ABC-1', token, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'propose_issue', arguments: { title: 'New idea' } },
      });
      const result = (res as {
        result: { isError: boolean; structuredContent: { state: string; identifier: string } };
      }).result;
      assert.equal(result.isError, false);
      assert.equal(result.structuredContent.state, 'Inbox');
      assert.deepEqual(await readdir(path.join(root, 'Inbox')), ['1.md']);
      // Triage directory got materialized only because we mkdir'd nothing in
      // setupStateTree; here we never created one and none was implicitly used.
      let triageFiles: string[] = [];
      try {
        triageFiles = await readdir(path.join(root, 'Triage'));
      } catch {
        triageFiles = [];
      }
      assert.deepEqual(triageFiles, []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('propose_issue surfaces a tool error when no holding state is declared', async () => {
    // Defense in depth: workflow validation refuses configs without a holding
    // state, so this branch should be unreachable in production. The registry
    // still catches the throw and converts it to a tool error so a misconfigured
    // test harness or a future code path that bypasses validation gets a clean
    // failure rather than an unhandled promise rejection.
    const noHoldingStates = {
      Todo: { role: 'active' as const },
      Done: { role: 'terminal' as const },
    };
    const root = await mkdtemp(path.join(os.tmpdir(), 'symphony-propose-no-holding-'));
    try {
      for (const dir of ['Todo', 'Done']) {
        await mkdir(path.join(root, dir), { recursive: true });
      }
      const t = new LocalMarkdownTracker({
        kind: 'local',
        states: noHoldingStates,
        root,
      });
      const reg = new McpRegistry(t, { states: noHoldingStates });
      const entry = makeEntry('ABC-1', 'Todo', { tracker_root_at_dispatch: root });
      const token = reg.activate(entry);
      const res = await reg.handleJsonRpc('ABC-1', token, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'propose_issue', arguments: { title: 'Triage me' } },
      });
      const result = (res as {
        result: {
          isError: boolean;
          content: Array<{ text: string }>;
          structuredContent?: Record<string, unknown>;
        };
      }).result;
      assert.equal(result.isError, true);
      assert.match(result.content[0]!.text, /no holding-role state declared/);
      assert.ok(result.structuredContent);
      assert.equal(result.structuredContent!['error'], 'no_holding_state');
      assert.deepEqual(result.structuredContent!['declared_states'], ['Todo', 'Done']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects transition when to_state is missing', async () => {
    const { root, cleanup } = await setupStateTree();
    try {
      await writeFile(path.join(root, 'Todo', 'ABC-1.md'), `---\ntitle: T\n---\nbody`);
      const t = makeStateTracker(root);
      const reg = new McpRegistry(t, { states });
      const entry = makeEntry('ABC-1', 'Todo', { tracker_root_at_dispatch: root });
      const token = reg.activate(entry);
      const res = await reg.handleJsonRpc('ABC-1', token, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'transition', arguments: {} },
      });
      const result = (res as { result: { isError: boolean; content: Array<{ text: string }> } })
        .result;
      assert.equal(result.isError, true);
      assert.match(result.content[0]!.text, /to_state is required/);
      assert.equal(entry.transitioned, false);
    } finally {
      await cleanup();
    }
  });

  it('end-to-end Todo → Review → Done: notes accumulate, workspace survives the middle hop, terminal cleans up', async () => {
    // Drive a single issue file through the full implementer → reviewer → approval
    // chain using two consecutive transition calls on the same registry. Verifies
    // the dogfood handoff shape: the file moves through directories with both
    // hop's notes appended, the same workspace key is preserved through Review,
    // and cleanup only fires on the terminal hop.
    const { root, cleanup } = await setupStateTree();
    try {
      const issuePath = (state: string) => path.join(root, state, 'ABC-1.md');
      await writeFile(issuePath('Todo'), `---\ntitle: Issue\n---\nInitial body.`);
      const tracker = makeStateTracker(root);
      const reg = new McpRegistry(tracker, { states });

      // Hop 1: Todo → Review (implementer handoff).
      const todoEntry = makeEntry('ABC-1', 'Todo', { tracker_root_at_dispatch: root });
      todoEntry.resolved_actor = 'claude/claude-opus-4-7';
      const todoToken = reg.activate(todoEntry);
      const reviewHop = await reg.handleJsonRpc('ABC-1', todoToken, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'transition',
          arguments: { to_state: 'Review', notes: '# Implement thing\n\nMade the change.' },
        },
      });
      const reviewHopResult = (reviewHop as {
        result: { isError: boolean; structuredContent: { cleanup_workspace_on_exit: boolean } };
      }).result;
      assert.equal(reviewHopResult.isError, false);
      // active→active: workspace preserved so the same `agent/<id>` branch survives.
      assert.equal(todoEntry.cleanup_workspace_on_exit, false);
      assert.equal(reviewHopResult.structuredContent.cleanup_workspace_on_exit, false);
      assert.deepEqual(await readdir(path.join(root, 'Todo')), []);
      assert.deepEqual(await readdir(path.join(root, 'Review')), ['ABC-1.md']);
      reg.deactivate('ABC-1');

      // Hop 2: Review → Done (reviewer approval). Simulates the next dispatch
      // picking the file up in its new Review state; same workspace key.
      const reviewEntry = makeEntry('ABC-1', 'Review', { tracker_root_at_dispatch: root });
      reviewEntry.resolved_actor = 'codex/default';
      reviewEntry.workspace_path = todoEntry.workspace_path;
      const reviewToken = reg.activate(reviewEntry);
      const doneHop = await reg.handleJsonRpc('ABC-1', reviewToken, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'transition',
          arguments: { to_state: 'Done', notes: 'LGTM; tests pass.' },
        },
      });
      const doneHopResult = (doneHop as {
        result: { isError: boolean; structuredContent: { cleanup_workspace_on_exit: boolean } };
      }).result;
      assert.equal(doneHopResult.isError, false);
      // active→terminal: workspace gets cleaned, no further dispatches.
      assert.equal(reviewEntry.cleanup_workspace_on_exit, true);
      assert.equal(doneHopResult.structuredContent.cleanup_workspace_on_exit, true);
      assert.deepEqual(await readdir(path.join(root, 'Review')), []);
      assert.deepEqual(await readdir(path.join(root, 'Done')), ['ABC-1.md']);
      // Both handoff notes accumulated in the file body (the next reader — the
      // dogfood after_run hook — extracts the final hop's title+summary).
      const finalBody = await readFile(issuePath('Done'), 'utf8');
      assert.match(finalBody, /Made the change\./);
      assert.match(finalBody, /LGTM; tests pass\./);
      assert.match(finalBody, /## claude\/claude-opus-4-7 — \S+ — Todo → Review/);
      assert.match(finalBody, /## codex\/default — \S+ — Review → Done/);
    } finally {
      await cleanup();
    }
  });

  it('end-to-end Todo → Review → Todo: rework cycle preserves workspace across both hops, notes accumulate', async () => {
    // Reviewer-rejects-back-to-Todo path. Both hops are active→active, so the
    // workspace and branch must survive; the implementer's next dispatch sees
    // both the original handoff and the reviewer's rework instructions.
    const { root, cleanup } = await setupStateTree();
    try {
      await writeFile(path.join(root, 'Todo', 'ABC-1.md'), `---\ntitle: Issue\n---\nInitial body.`);
      const tracker = makeStateTracker(root);
      const reg = new McpRegistry(tracker, { states });

      // Hop 1: Todo → Review.
      const todoEntry = makeEntry('ABC-1', 'Todo', { tracker_root_at_dispatch: root });
      todoEntry.resolved_actor = 'claude/claude-opus-4-7';
      const todoToken = reg.activate(todoEntry);
      await reg.handleJsonRpc('ABC-1', todoToken, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'transition', arguments: { to_state: 'Review', notes: 'first attempt' } },
      });
      assert.equal(todoEntry.cleanup_workspace_on_exit, false);
      reg.deactivate('ABC-1');

      // Hop 2: Review → Todo (rework). Reviewer rejects back; allowed because
      // Review.allowed_transitions includes Todo.
      const reviewEntry = makeEntry('ABC-1', 'Review', { tracker_root_at_dispatch: root });
      reviewEntry.resolved_actor = 'codex/default';
      const reviewToken = reg.activate(reviewEntry);
      const reworkHop = await reg.handleJsonRpc('ABC-1', reviewToken, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'transition',
          arguments: { to_state: 'Todo', notes: 'fix the off-by-one at src/foo.ts:42' },
        },
      });
      const reworkHopResult = (reworkHop as { result: { isError: boolean } }).result;
      assert.equal(reworkHopResult.isError, false);
      // active→active again: workspace preserved.
      assert.equal(reviewEntry.cleanup_workspace_on_exit, false);
      assert.deepEqual(await readdir(path.join(root, 'Review')), []);
      assert.deepEqual(await readdir(path.join(root, 'Todo')), ['ABC-1.md']);
      // Both rounds' notes are on the file the next Todo dispatch will read.
      const body = await readFile(path.join(root, 'Todo', 'ABC-1.md'), 'utf8');
      assert.match(body, /first attempt/);
      assert.match(body, /off-by-one at src\/foo\.ts:42/);
    } finally {
      await cleanup();
    }
  });

  it('updateStates picks up workflow reload — a state added post-construction is reachable', async () => {
    const { root, cleanup } = await setupStateTree();
    try {
      await writeFile(path.join(root, 'Todo', 'ABC-1.md'), `---\ntitle: T\n---\nbody`);
      const t = makeStateTracker(root);
      // Construct with a minimal map missing Review.
      const reg = new McpRegistry(t, {
        states: { Todo: { role: 'active' }, Done: { role: 'terminal' } },
      });
      const entry = makeEntry('ABC-1', 'Todo', { tracker_root_at_dispatch: root });
      const token = reg.activate(entry);
      // First call: Review isn't declared yet.
      const beforeReload = await reg.handleJsonRpc('ABC-1', token, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'transition', arguments: { to_state: 'Review' } },
      });
      const beforeReloadResult = (beforeReload as { result: { isError: boolean } }).result;
      assert.equal(beforeReloadResult.isError, true);
      // Reload pushes the full state map in.
      reg.updateStates(states);
      const afterReload = await reg.handleJsonRpc('ABC-1', token, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'transition', arguments: { to_state: 'Review', notes: 'ok' } },
      });
      const afterReloadResult = (afterReload as { result: { isError: boolean } }).result;
      assert.equal(afterReloadResult.isError, false);
      assert.deepEqual(await readdir(path.join(root, 'Review')), ['ABC-1.md']);
    } finally {
      await cleanup();
    }
  });
});
