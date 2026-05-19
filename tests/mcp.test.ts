import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LocalMarkdownTracker } from '../src/trackers/local.js';
import { McpRegistry } from '../src/mcp.js';
import type { RunningEntry, Issue } from '../src/types.js';

function makeTracker(root: string): LocalMarkdownTracker {
  return new LocalMarkdownTracker({
    kind: 'local',
    endpoint: null,
    api_key: null,
    project_slug: null,
    active_states: ['Todo', 'In Progress'],
    terminal_states: ['Done', 'Cancelled'],
    root,
  });
}

function makeEntry(
  identifier: string,
  state: string,
  over: Partial<Pick<RunningEntry, 'tracker_root_at_dispatch' | 'terminal_target_at_dispatch'>> = {},
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
    codex_app_server_pid: null,
    last_codex_event: null,
    last_codex_timestamp: null,
    last_codex_message: null,
    codex_input_tokens: 0,
    codex_output_tokens: 0,
    codex_total_tokens: 0,
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
    terminal_target_at_dispatch: over.terminal_target_at_dispatch ?? 'Done',
    marked_done: false,
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
  it('lists the two tools', async () => {
    const { root, cleanup } = await setupTree();
    try {
      const t = makeTracker(root);
      const reg = new McpRegistry(t, { terminalStates: ['Done', 'Cancelled'] });
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
      assert.deepEqual(names, ['mark_done', 'request_human_steering']);
    } finally {
      await cleanup();
    }
  });

  it('rejects calls with the wrong token', async () => {
    const { root, cleanup } = await setupTree();
    try {
      const t = makeTracker(root);
      const reg = new McpRegistry(t, { terminalStates: ['Done', 'Cancelled'] });
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

  it('mark_done moves the file and sets the flag', async () => {
    const { root, cleanup } = await setupTree();
    try {
      const t = makeTracker(root);
      const reg = new McpRegistry(t, { terminalStates: ['Done', 'Cancelled'] });
      const entry = makeEntry('ABC-1', 'In Progress');
      const token = reg.activate(entry);
      const res = await reg.handleJsonRpc('ABC-1', token, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'mark_done', arguments: { summary: 'all done' } },
      });
      assert.ok(res && 'result' in res);
      const result = res.result as { isError: boolean; content: Array<{ text: string }> };
      assert.equal(result.isError, false);
      assert.match(result.content[0]!.text, /Marked ABC-1 as done/);
      assert.equal(entry.marked_done, true);
      const inProgress = await readdir(path.join(root, 'In Progress'));
      const done = await readdir(path.join(root, 'Done'));
      assert.deepEqual(inProgress, []);
      assert.deepEqual(done, ['ABC-1.md']);
    } finally {
      await cleanup();
    }
  });

  it('mark_done uses the terminal target snapshotted at dispatch time, not the current registry config', async () => {
    // Regression: if WORKFLOW.md reloads between dispatch and mark_done and
    // changes terminal_states, in-flight mark_done must still use the target
    // that was valid when the run was dispatched. The orchestrator pins
    // terminal_target_at_dispatch on the RunningEntry BEFORE activate runs,
    // so a reload that fires before activate (during workspace setup or the
    // before_run hook) must also be ignored.
    const { root, cleanup } = await setupTree();
    try {
      const t = makeTracker(root);
      const reg = new McpRegistry(t, { terminalStates: ['Done', 'Cancelled'] });
      const entry = makeEntry('ABC-1', 'In Progress', { terminal_target_at_dispatch: 'Done' });
      // Mutate the registry's live terminal_states BEFORE activate — simulating
      // a workflow reload during workspace setup / before_run / VM bring-up.
      reg.updateTerminalStates(['Cancelled', 'Archived']);
      const token = reg.activate(entry);
      await reg.handleJsonRpc('ABC-1', token, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'mark_done', arguments: { summary: 'done' } },
      });
      // File landed in the dispatch-time 'Done' target, NOT the post-reload first
      // entry 'Cancelled'.
      assert.deepEqual(await readdir(path.join(root, 'Done')), ['ABC-1.md']);
      assert.deepEqual(await readdir(path.join(root, 'In Progress')), []);
    } finally {
      await cleanup();
    }
  });

  it('mark_done uses the tracker root snapshotted at dispatch time', async () => {
    // Regression: workflow reload that mutates tracker.root must not redirect
    // an in-flight mark_done to a different filesystem location. The orchestrator
    // pins tracker_root_at_dispatch on the RunningEntry BEFORE activate runs, so
    // a reload that fires before activate must also be ignored.
    const { root, cleanup } = await setupTree();
    try {
      const t = makeTracker(root);
      const reg = new McpRegistry(t, { terminalStates: ['Done', 'Cancelled'] });
      const entry = makeEntry('ABC-1', 'In Progress', { tracker_root_at_dispatch: root });
      // Plant a decoy tracker root with an unrelated ABC-1 file.
      const decoyRoot = await mkdtemp(path.join(os.tmpdir(), 'symphony-decoy-'));
      await mkdir(path.join(decoyRoot, 'In Progress'), { recursive: true });
      await mkdir(path.join(decoyRoot, 'Done'), { recursive: true });
      await writeFile(
        path.join(decoyRoot, 'In Progress', 'ABC-1.md'),
        `---\ntitle: DECOY\n---\nthis file must not move`,
      );
      try {
        // Mutate the tracker's live config to point at the decoy BEFORE activate —
        // simulating a workflow reload during workspace setup / before_run.
        t.updateConfig({
          kind: 'local',
          endpoint: null,
          api_key: null,
          project_slug: null,
          active_states: ['Todo', 'In Progress'],
          terminal_states: ['Done', 'Cancelled'],
          root: decoyRoot,
        });
        const token = reg.activate(entry);
        await reg.handleJsonRpc('ABC-1', token, {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'mark_done', arguments: { summary: 'done' } },
        });
        // Original root's ABC-1 moved into its own Done/.
        assert.deepEqual(await readdir(path.join(root, 'In Progress')), []);
        assert.deepEqual(await readdir(path.join(root, 'Done')), ['ABC-1.md']);
        // Decoy tracker root is untouched.
        assert.deepEqual(await readdir(path.join(decoyRoot, 'In Progress')), ['ABC-1.md']);
        assert.deepEqual(await readdir(path.join(decoyRoot, 'Done')), []);
      } finally {
        await rm(decoyRoot, { recursive: true, force: true });
      }
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
      const reg = new McpRegistry(t, { terminalStates: ['Done'] });
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

  it('mark_done with a stale Done/<id>.md alongside the active In Progress copy returns tool error, not silent no-op', async () => {
    // Regression: when a stale Done/ABC-1.md (e.g. an operator-leftover from a
    // prior cycle) coexists with the live In Progress/ABC-1.md, the scan returns
    // both. The pre-fix code did a blind `.find(...)` that could pick the stale
    // Done copy and short-circuit because its state already equals the target —
    // setting marked_done=true while leaving the live In Progress file stranded.
    //
    // After the fix, callMarkDone passes fromState='In Progress' (the entry's
    // dispatched-from state), which disambiguates to the live file. The actual
    // move then fails the existing overwrite-protection check because the stale
    // Done basename collides, surfacing a clean tool error. Either way, the
    // active file must NOT be silently abandoned with marked_done=true.
    const { root, cleanup } = await setupTree();
    try {
      // Plant a stale Done/ABC-1.md (different front-matter id so the source
      // lookup still finds the In Progress copy by id, but basenames collide).
      await writeFile(
        path.join(root, 'Done', 'ABC-1.md'),
        `---\nid: ZOMBIE-1\ntitle: Stale Done\n---\nold body`,
      );
      const t = makeTracker(root);
      const reg = new McpRegistry(t, { terminalStates: ['Done', 'Cancelled'] });
      const entry = makeEntry('ABC-1', 'In Progress');
      const token = reg.activate(entry);
      const res = await reg.handleJsonRpc('ABC-1', token, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'mark_done', arguments: { summary: 'done' } },
      });
      const result = (res as { result: { isError: boolean; content: Array<{ text: string }> } }).result;
      assert.equal(result.isError, true);
      assert.match(result.content[0]!.text, /failed to mark done/);
      // The marked_done flag must stay false so the runner doesn't exit thinking
      // the work landed — operator needs to clean up the stale Done file first.
      assert.equal(entry.marked_done, false);
      // The live In Progress file is still in place; nothing was destructively moved.
      assert.deepEqual(await readdir(path.join(root, 'In Progress')), ['ABC-1.md']);
    } finally {
      await cleanup();
    }
  });

  it('mark_done sets cleanup_workspace_on_exit so onWorkerExit removes the workspace', async () => {
    // Regression: the reconcile loop normally sets this flag when it sees a terminal-state
    // transition, but the runner exits via marked_done before reconcile runs. Without this
    // the workspace leaks.
    const { root, cleanup } = await setupTree();
    try {
      const t = makeTracker(root);
      const reg = new McpRegistry(t, { terminalStates: ['Done', 'Cancelled'] });
      const entry = makeEntry('ABC-1', 'In Progress');
      assert.equal(entry.cleanup_workspace_on_exit, false);
      const token = reg.activate(entry);
      await reg.handleJsonRpc('ABC-1', token, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'mark_done', arguments: { summary: 'done' } },
      });
      assert.equal(entry.cleanup_workspace_on_exit, true);
    } finally {
      await cleanup();
    }
  });

  it('mark_done rejects empty summary', async () => {
    const { root, cleanup } = await setupTree();
    try {
      const t = makeTracker(root);
      const reg = new McpRegistry(t, { terminalStates: ['Done', 'Cancelled'] });
      const entry = makeEntry('ABC-1', 'In Progress');
      const token = reg.activate(entry);
      const res = await reg.handleJsonRpc('ABC-1', token, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'mark_done', arguments: { summary: '   ' } },
      });
      const result = (res as { result: { isError: boolean; content: Array<{ text: string }> } }).result;
      assert.equal(result.isError, true);
      assert.match(result.content[0]!.text, /summary is required/);
      assert.equal(entry.marked_done, false);
    } finally {
      await cleanup();
    }
  });

  it('request_human_steering stashes question, ack returns, submitSteeringReply unblocks waiter', async () => {
    const { root, cleanup } = await setupTree();
    try {
      const t = makeTracker(root);
      const reg = new McpRegistry(t, { terminalStates: ['Done', 'Cancelled'] });
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
      const reg = new McpRegistry(t, { terminalStates: ['Done', 'Cancelled'] });
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
      const reg = new McpRegistry(t, { terminalStates: ['Done', 'Cancelled'] });
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
      const reg = new McpRegistry(t, { terminalStates: ['Done', 'Cancelled'] });
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
      const reg = new McpRegistry(t, { terminalStates: ['Done', 'Cancelled'] });
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
      const reg = new McpRegistry(t, { terminalStates: ['Done', 'Cancelled'] });
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
      const reg = new McpRegistry(t, { terminalStates: ['Done', 'Cancelled'] });
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
      const reg = new McpRegistry(t, { terminalStates: ['Done'] });
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
      const reg = new McpRegistry(t, { terminalStates: ['Done'] });
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
      const reg = new McpRegistry(t, { terminalStates: ['Done'] });
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
      const reg = new McpRegistry(t, { terminalStates: ['Done'] });
      reg.setEffectivePort(8787);
      const url = reg.buildUrl('ABC-1 hi', { host: '10.0.2.2', explicit_host_url: null });
      assert.equal(url, 'http://10.0.2.2:8787/api/v1/issues/ABC-1%20hi/mcp');
    } finally {
      await cleanup();
    }
  });
});
