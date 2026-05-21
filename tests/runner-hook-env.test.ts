import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildAfterRunHookEnv } from '../src/agent/runner.js';
import type { Issue, RunningEntry } from '../src/types.js';

// `buildAfterRunHookEnv` is the orchestrator-side staging helper that collapses the
// Done after_run hook (formerly ~80 lines of awk/git plumbing) down to a few git/gh
// calls. The script consumes:
//   SYMPHONY_ISSUE_ID  / SYMPHONY_BRANCH      — identifier-derived
//   SYMPHONY_PR_TITLE                          — "<id>: <title>", already prefixed
//   SYMPHONY_PR_BODY_FILE                      — absolute path to a temp file the host
//                                                wrote with the up-to-date issue body
// We pin the contract end-to-end: env keys present, file written, fallback path
// honored, cleanup wipes the temp dir.

function makeEntry(opts: {
  issue: Partial<Issue> & { id: string; identifier: string; title: string; state: string };
  tracker_root_at_dispatch?: string | null;
}): RunningEntry {
  const issue: Issue = {
    id: opts.issue.id,
    identifier: opts.issue.identifier,
    title: opts.issue.title,
    description: opts.issue.description ?? null,
    priority: null,
    state: opts.issue.state,
    branch_name: null,
    url: null,
    labels: [],
    blocked_by: [],
    created_at: null,
    updated_at: null,
  };
  return {
    issue_id: issue.id,
    identifier: issue.identifier,
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
    workspace_path: '/tmp/workspace',
    cancel: () => undefined,
    recent_events: [],
    last_error: null,
    cleanup_workspace_on_exit: false,
    mcp_token: null,
    tracker_root_at_dispatch: opts.tracker_root_at_dispatch ?? null,
    resolved_actor: 'claude/claude-opus-4-7',
    transitioned: false,
    steering_requested: false,
    steering_question: null,
    steering_context: null,
  };
}

describe('buildAfterRunHookEnv', () => {
  it('reads the post-transition body from disk so multi-hop notes ride into the PR', async () => {
    // The orchestrator's MCP `transition` tool appends notes to the issue file before
    // moving it into the target state directory. The hook needs the latest content so
    // implementer → reviewer → approval notes all land in the PR body.
    const trackerRoot = await mkdtemp(path.join(os.tmpdir(), 'symphony-hook-env-tracker-'));
    try {
      const stateDir = path.join(trackerRoot, 'Done');
      await mkdir(stateDir, { recursive: true });
      const file = path.join(stateDir, '42.md');
      await writeFile(
        file,
        ['---', 'id: "42"', 'title: "Original title"', '---', '', 'body line one', 'body line two'].join('\n'),
        'utf8',
      );
      const entry = makeEntry({
        issue: {
          id: '42',
          identifier: '42',
          title: 'Original title',
          description: 'stale in-memory description',
          state: 'Done',
        },
        tracker_root_at_dispatch: trackerRoot,
      });
      const { env, cleanup } = await buildAfterRunHookEnv(entry);
      try {
        assert.equal(env.SYMPHONY_ISSUE_ID, '42');
        assert.equal(env.SYMPHONY_BRANCH, 'agent/42');
        assert.equal(env.SYMPHONY_PR_TITLE, '42: Original title');
        const body = await readFile(env.SYMPHONY_PR_BODY_FILE!, 'utf8');
        assert.equal(body, 'body line one\nbody line two');
      } finally {
        await cleanup();
      }
    } finally {
      await rm(trackerRoot, { recursive: true, force: true });
    }
  });

  it('falls back to the in-memory description when the tracker file is unreachable', async () => {
    // Tracker root snapshot may be null (older test harness, propose-flow paths) or the
    // file may be gone (manual operator move). Either way the hook still has to fire
    // — fall back to the dispatch-time description rather than aborting.
    const entry = makeEntry({
      issue: {
        id: '7',
        identifier: '7',
        title: 'Trim me   ',
        description: 'inline fallback body',
        state: 'Done',
      },
      tracker_root_at_dispatch: null,
    });
    const { env, cleanup } = await buildAfterRunHookEnv(entry);
    try {
      assert.equal(env.SYMPHONY_ISSUE_ID, '7');
      assert.equal(env.SYMPHONY_BRANCH, 'agent/7');
      // Title is trimmed before being id-prefixed so the PR list stays tidy.
      assert.equal(env.SYMPHONY_PR_TITLE, '7: Trim me');
      const body = await readFile(env.SYMPHONY_PR_BODY_FILE!, 'utf8');
      assert.equal(body, 'inline fallback body');
    } finally {
      await cleanup();
    }
  });

  it('handles a blank title by falling back to the bare issue id', async () => {
    // The hook produces "${SYMPHONY_PR_TITLE}" verbatim; an empty title would yield a PR
    // titled "10: " which is ugly. The host normalizes to just the id.
    const entry = makeEntry({
      issue: { id: '10', identifier: '10', title: '   ', description: null, state: 'Done' },
      tracker_root_at_dispatch: null,
    });
    const { env, cleanup } = await buildAfterRunHookEnv(entry);
    try {
      assert.equal(env.SYMPHONY_PR_TITLE, '10');
      const body = await readFile(env.SYMPHONY_PR_BODY_FILE!, 'utf8');
      assert.equal(body, '');
    } finally {
      await cleanup();
    }
  });

  it('cleanup removes the temp body file directory', async () => {
    // The runner calls cleanup() in a finally block; the temp dir must be gone after
    // it returns so we don't strand body files in $TMPDIR across runs.
    const entry = makeEntry({
      issue: { id: '1', identifier: '1', title: 'x', state: 'Done', description: 'body' },
      tracker_root_at_dispatch: null,
    });
    const { env, cleanup } = await buildAfterRunHookEnv(entry);
    const bodyFile = env.SYMPHONY_PR_BODY_FILE!;
    await stat(bodyFile);
    await cleanup();
    await assert.rejects(stat(bodyFile));
  });

  it('extracts the body verbatim when the issue file has no front matter', async () => {
    // The local tracker writes front-matter unconditionally, but a hand-edited file or
    // a propose-issue payload without front-matter should still yield a usable PR body.
    const trackerRoot = await mkdtemp(path.join(os.tmpdir(), 'symphony-hook-env-nofm-'));
    try {
      const stateDir = path.join(trackerRoot, 'Done');
      await mkdir(stateDir, { recursive: true });
      const file = path.join(stateDir, '99.md');
      await writeFile(file, 'no front matter just body here', 'utf8');
      const entry = makeEntry({
        issue: { id: '99', identifier: '99', title: 'T', state: 'Done', description: 'stale' },
        tracker_root_at_dispatch: trackerRoot,
      });
      const { env, cleanup } = await buildAfterRunHookEnv(entry);
      try {
        const body = await readFile(env.SYMPHONY_PR_BODY_FILE!, 'utf8');
        assert.equal(body, 'no front matter just body here');
      } finally {
        await cleanup();
      }
    } finally {
      await rm(trackerRoot, { recursive: true, force: true });
    }
  });
});
