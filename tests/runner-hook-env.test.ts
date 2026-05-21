import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildAfterRunHookEnv, reconcilePostHookEntryState } from '../src/agent/runner.js';
import { buildServiceConfig } from '../src/workflow.js';
import type { Issue, RunningEntry } from '../src/types.js';

// `buildAfterRunHookEnv` is the orchestrator-side staging helper that collapses the
// Done after_run hook (formerly ~80 lines of awk/git plumbing) down to a few git/gh
// calls. The script consumes:
//   SYMPHONY_ISSUE_ID  / SYMPHONY_BRANCH      — identifier-derived
//   SYMPHONY_PR_TITLE                          — "<id>: <title>", already prefixed
//   SYMPHONY_PR_BODY_FILE                      — absolute path to a temp file the host
//                                                wrote with the up-to-date issue body
//   SYMPHONY_TRACKER_ROOT                      — tracker root snapshot; only present
//                                                when the dispatch captured it. Lets
//                                                the hook re-route the issue file to
//                                                a holding state (e.g. Conflict/) on
//                                                merge failure.
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

  it('stages SYMPHONY_BASE_BRANCH with a main default when the host env did not set it', async () => {
    // The Done hook runs under `set -eu` and references $SYMPHONY_BASE_BRANCH directly. The
    // documented PR-mode setup (AGENTS.md) only requires SYMPHONY_REPO to be exported, with
    // SYMPHONY_BASE_BRANCH optional and defaulting to "main" — the same default after_create
    // applies. Stage that default here so the hook is safe under `set -u`.
    const prior = process.env.SYMPHONY_BASE_BRANCH;
    delete process.env.SYMPHONY_BASE_BRANCH;
    try {
      const entry = makeEntry({
        issue: { id: '5', identifier: '5', title: 't', state: 'Done', description: 'body' },
        tracker_root_at_dispatch: null,
      });
      const { env, cleanup } = await buildAfterRunHookEnv(entry);
      try {
        assert.equal(env.SYMPHONY_BASE_BRANCH, 'main');
      } finally {
        await cleanup();
      }
    } finally {
      if (prior !== undefined) process.env.SYMPHONY_BASE_BRANCH = prior;
    }
  });

  it('forwards an explicit SYMPHONY_BASE_BRANCH from the host env', async () => {
    // Operators on a non-default base (e.g. `develop`) export SYMPHONY_BASE_BRANCH at
    // launch; the staged env must honour that rather than overriding with "main".
    const prior = process.env.SYMPHONY_BASE_BRANCH;
    process.env.SYMPHONY_BASE_BRANCH = 'develop';
    try {
      const entry = makeEntry({
        issue: { id: '6', identifier: '6', title: 't', state: 'Done', description: 'body' },
        tracker_root_at_dispatch: null,
      });
      const { env, cleanup } = await buildAfterRunHookEnv(entry);
      try {
        assert.equal(env.SYMPHONY_BASE_BRANCH, 'develop');
      } finally {
        await cleanup();
      }
    } finally {
      if (prior === undefined) delete process.env.SYMPHONY_BASE_BRANCH;
      else process.env.SYMPHONY_BASE_BRANCH = prior;
    }
  });

  it('stages SYMPHONY_TRACKER_ROOT so the hook can reroute the issue file on merge conflict', async () => {
    // The shared-integration flow (issue #18) has the Done after_run hook attempt
    // `git merge --no-ff agent/<id>` into `integration` and, on conflict, move the
    // tracker file into a `Conflict/` holding state. The hook needs the tracker root
    // to write outside the workspace; expose it as SYMPHONY_TRACKER_ROOT.
    const entry = makeEntry({
      issue: { id: '11', identifier: '11', title: 't', state: 'Done', description: 'body' },
      tracker_root_at_dispatch: '/var/symphony/tracker',
    });
    const { env, cleanup } = await buildAfterRunHookEnv(entry);
    try {
      assert.equal(env.SYMPHONY_TRACKER_ROOT, '/var/symphony/tracker');
    } finally {
      await cleanup();
    }
  });

  it('omits SYMPHONY_TRACKER_ROOT when no snapshot is available', async () => {
    // When the dispatch path could not capture a tracker root (older path, propose
    // flow), leave the env var unset rather than staging an empty string the hook
    // would still treat as a valid root under `set -u`.
    const entry = makeEntry({
      issue: { id: '12', identifier: '12', title: 't', state: 'Done', description: 'body' },
      tracker_root_at_dispatch: null,
    });
    const { env, cleanup } = await buildAfterRunHookEnv(entry);
    try {
      assert.equal(Object.prototype.hasOwnProperty.call(env, 'SYMPHONY_TRACKER_ROOT'), false);
    } finally {
      await cleanup();
    }
  });

  it('reconcilePostHookEntryState clears cleanup when after_run rerouted file to a holding state', async () => {
    // Done's after_run hook can move the issue file from Done/ to Conflict/ when
    // the integration merge fails. The transition into Done already set
    // `cleanup_workspace_on_exit = true` on the entry; without the post-hook
    // reconciliation the orchestrator would remove the workspace (and the only
    // copy of agent/<id> in local-only mode) even though the file is now in a
    // holding state needing operator triage.
    const trackerRoot = await mkdtemp(path.join(os.tmpdir(), 'symphony-posthook-reconcile-'));
    try {
      await mkdir(path.join(trackerRoot, 'Conflict'), { recursive: true });
      // File now lives under Conflict/ — Done/ is intentionally empty to mirror
      // what the after_run hook leaves behind on conflict.
      await writeFile(path.join(trackerRoot, 'Conflict', '18.md'), 'body', 'utf8');
      const cfg = buildServiceConfig(
        {
          tracker: { kind: 'local', root: trackerRoot },
          acp: { adapter: 'claude' },
          states: {
            Todo: { role: 'active' },
            Done: { role: 'terminal' },
            Conflict: { role: 'holding' },
          },
        },
        '/tmp/WORKFLOW.md',
      );
      const entry = makeEntry({
        issue: { id: '18', identifier: '18', title: 't', state: 'Done', description: 'body' },
        tracker_root_at_dispatch: trackerRoot,
      });
      entry.cleanup_workspace_on_exit = true;
      const result = await reconcilePostHookEntryState(entry, cfg);
      assert.equal(result.relocated, true);
      assert.equal(result.from, 'Done');
      assert.equal(result.to, 'Conflict');
      assert.equal(entry.issue.state, 'Conflict');
      assert.equal(entry.cleanup_workspace_on_exit, false);
    } finally {
      await rm(trackerRoot, { recursive: true, force: true });
    }
  });

  it('reconcilePostHookEntryState leaves a still-terminal entry untouched', async () => {
    // No reroute happened (file stayed in Done/), so the entry's transition
    // decision still stands and the orchestrator should proceed with cleanup.
    const trackerRoot = await mkdtemp(path.join(os.tmpdir(), 'symphony-posthook-noreroute-'));
    try {
      await mkdir(path.join(trackerRoot, 'Done'), { recursive: true });
      await writeFile(path.join(trackerRoot, 'Done', '19.md'), 'body', 'utf8');
      const cfg = buildServiceConfig(
        {
          tracker: { kind: 'local', root: trackerRoot },
          acp: { adapter: 'claude' },
          states: {
            Todo: { role: 'active' },
            Done: { role: 'terminal' },
            Conflict: { role: 'holding' },
          },
        },
        '/tmp/WORKFLOW.md',
      );
      const entry = makeEntry({
        issue: { id: '19', identifier: '19', title: 't', state: 'Done', description: 'body' },
        tracker_root_at_dispatch: trackerRoot,
      });
      entry.cleanup_workspace_on_exit = true;
      const result = await reconcilePostHookEntryState(entry, cfg);
      assert.equal(result.relocated, false);
      assert.equal(entry.issue.state, 'Done');
      assert.equal(entry.cleanup_workspace_on_exit, true);
    } finally {
      await rm(trackerRoot, { recursive: true, force: true });
    }
  });

  it('reconcilePostHookEntryState is a no-op without a tracker root snapshot', async () => {
    // Older dispatch paths and the propose-flow can both produce entries with
    // tracker_root_at_dispatch === null. The runner already tolerates that for
    // env staging; reconciliation must do the same rather than throwing.
    const cfg = buildServiceConfig(
      {
        tracker: { kind: 'local', root: '/tmp/x' },
        acp: { adapter: 'claude' },
        states: {
          Todo: { role: 'active' },
          Done: { role: 'terminal' },
          Conflict: { role: 'holding' },
        },
      },
      '/tmp/WORKFLOW.md',
    );
    const entry = makeEntry({
      issue: { id: '20', identifier: '20', title: 't', state: 'Done', description: 'body' },
      tracker_root_at_dispatch: null,
    });
    entry.cleanup_workspace_on_exit = true;
    const result = await reconcilePostHookEntryState(entry, cfg);
    assert.equal(result.relocated, false);
    assert.equal(entry.cleanup_workspace_on_exit, true);
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
