import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  splitFrontMatter,
  buildServiceConfig,
  expandVar,
  validateDispatch,
} from '../src/workflow.js';
import { activeStateNames, terminalStateNames } from '../src/issues.js';

// Reused across the tests that don't care about the states block itself; covers
// the three required roles so the workflow parser accepts the config.
const minimalStates = {
  Todo: { role: 'active' as const },
  Done: { role: 'terminal' as const },
  Triage: { role: 'holding' as const },
};

describe('workflow', () => {
  it('parses front matter + body', () => {
    const r = splitFrontMatter('---\nfoo: 1\n---\nhello body');
    assert.deepEqual(r.config, { foo: 1 });
    assert.equal(r.body, 'hello body');
  });

  it('treats no front matter as body only', () => {
    const r = splitFrontMatter('no front matter here');
    assert.deepEqual(r.config, {});
    assert.equal(r.body, 'no front matter here');
  });

  it('does not treat indented `---` inside YAML as closing fence', () => {
    const text = ['---', 'hooks:', '  after_create: |', '    echo a', '    ---', '    echo b', '---', 'prompt body'].join('\n');
    const r = splitFrontMatter(text);
    assert.equal((r.config as any).hooks.after_create.trim(), 'echo a\n---\necho b');
    assert.equal(r.body, 'prompt body');
  });

  it('rejects unset $VAR for tracker.root', () => {
    delete process.env.SYM_DOES_NOT_EXIST;
    assert.throws(() =>
      buildServiceConfig(
        {
          tracker: { kind: 'local', root: '$SYM_DOES_NOT_EXIST' },
          states: minimalStates,
        },
        '/tmp/WORKFLOW.md',
      ),
    );
  });

  it('expands env vars only on $VAR pattern', () => {
    process.env.SYM_FOO = '/some/abs';
    assert.equal(expandVar('$SYM_FOO'), '/some/abs');
    assert.equal(expandVar('https://api.example/path'), 'https://api.example/path');
  });

  it('builds defaults', () => {
    const cfg = buildServiceConfig(
      { tracker: { kind: 'local', root: '/tmp/issues' }, states: minimalStates },
      '/tmp/WORKFLOW.md',
    );
    assert.equal(cfg.polling.interval_ms, 30000);
    assert.equal(cfg.agent.max_concurrent_agents, 10);
    assert.equal(cfg.agent.max_turns, 20);
    assert.equal(cfg.acp.adapter, 'claude');
    assert.equal(cfg.acp.shell, 'bash');
    // acp.model defaults to null: the adapter falls back to its own default model.
    assert.equal(cfg.acp.model, null);
  });

  it('parses acp.model and trims whitespace', () => {
    const cfg = buildServiceConfig(
      {
        tracker: { kind: 'local', root: '/tmp/issues' },
        states: minimalStates,
        acp: { adapter: 'claude', model: '  claude-opus-4-7  ' },
      },
      '/tmp/WORKFLOW.md',
    );
    assert.equal(cfg.acp.model, 'claude-opus-4-7');
  });

  it('treats empty acp.model as unset (null)', () => {
    // Explicit empty string in YAML should not pin the adapter to "" — that would
    // break adapters that look up the model by name. Normalize to null so the adapter
    // picks its own default.
    const cfg = buildServiceConfig(
      {
        tracker: { kind: 'local', root: '/tmp/issues' },
        states: minimalStates,
        acp: { adapter: 'claude', model: '   ' },
      },
      '/tmp/WORKFLOW.md',
    );
    assert.equal(cfg.acp.model, null);
  });

  it('parses acp.effort and trims whitespace; defaults to null', () => {
    const cfgDefault = buildServiceConfig(
      { tracker: { kind: 'local', root: '/tmp/issues' }, states: minimalStates },
      '/tmp/WORKFLOW.md',
    );
    assert.equal(cfgDefault.acp.effort, null);

    const cfgSet = buildServiceConfig(
      {
        tracker: { kind: 'local', root: '/tmp/issues' },
        states: minimalStates,
        acp: { adapter: 'codex', effort: '  xhigh  ' },
      },
      '/tmp/WORKFLOW.md',
    );
    assert.equal(cfgSet.acp.effort, 'xhigh');

    const cfgBlank = buildServiceConfig(
      {
        tracker: { kind: 'local', root: '/tmp/issues' },
        states: minimalStates,
        acp: { adapter: 'codex', effort: '   ' },
      },
      '/tmp/WORKFLOW.md',
    );
    assert.equal(cfgBlank.acp.effort, null);
  });

  it('rejects a workflow YAML with no states block', () => {
    assert.throws(
      () =>
        buildServiceConfig(
          { tracker: { kind: 'local', root: '/tmp/issues' } },
          '/tmp/WORKFLOW.md',
        ),
      /must declare a top-level `states:` block/,
    );
  });

  it('rejects a workflow YAML whose states block is empty', () => {
    assert.throws(
      () =>
        buildServiceConfig(
          { tracker: { kind: 'local', root: '/tmp/issues' }, states: {} },
          '/tmp/WORKFLOW.md',
        ),
      /`states:` block is empty/,
    );
  });
});

describe('workflow states block', () => {
  it('parses an explicit states block with role + per-state overrides', () => {
    const cfg = buildServiceConfig(
      {
        tracker: { kind: 'local', root: '/tmp/issues' },
        states: {
          Todo: { role: 'active', adapter: 'claude', model: 'claude-opus-4-7', max_turns: 10 },
          Review: { role: 'active', adapter: 'codex', allowed_transitions: ['Todo', 'Done'] },
          Done: { role: 'terminal' },
          Cancelled: { role: 'terminal' },
          Triage: { role: 'holding' },
        },
      },
      '/tmp/WORKFLOW.md',
    );
    assert.deepEqual(Object.keys(cfg.states), ['Todo', 'Review', 'Done', 'Cancelled', 'Triage']);
    assert.equal(cfg.states.Todo!.role, 'active');
    assert.equal(cfg.states.Todo!.adapter, 'claude');
    assert.equal(cfg.states.Todo!.model, 'claude-opus-4-7');
    assert.equal(cfg.states.Todo!.max_turns, 10);
    assert.deepEqual(cfg.states.Review!.allowed_transitions, ['Todo', 'Done']);
    // Role-filtered listings track declaration order so the dashboard's
    // grouping stays deterministic.
    assert.deepEqual(activeStateNames(cfg.tracker.states), ['Todo', 'Review']);
    assert.deepEqual(terminalStateNames(cfg.tracker.states), ['Done', 'Cancelled']);
  });

  it('trims and normalizes per-state model overrides', () => {
    const cfg = buildServiceConfig(
      {
        tracker: { kind: 'local', root: '/tmp/issues' },
        states: {
          Todo: { role: 'active', model: '  claude-opus-4-7  ' },
          Review: { role: 'active', model: '   ' },
          ExplicitNull: { role: 'active', model: null },
          NoOverride: { role: 'active' },
          Done: { role: 'terminal' },
          Triage: { role: 'holding' },
        },
      },
      '/tmp/WORKFLOW.md',
    );
    assert.equal(cfg.states.Todo!.model, 'claude-opus-4-7');
    // Blank model trims to null — same normalization as the workflow-level acp.model.
    assert.equal(cfg.states.Review!.model, null);
    // Explicit YAML `model: null` must also normalize to null, distinct from
    // omitting the key entirely (which stays undefined so resolveDispatchConfig
    // inherits the workflow default).
    assert.equal(cfg.states.ExplicitNull!.model, null);
    assert.equal(cfg.states.NoOverride!.model, undefined);
  });

  it('trims and normalizes per-state effort overrides; preserves undefined when absent', () => {
    const cfg = buildServiceConfig(
      {
        tracker: { kind: 'local', root: '/tmp/issues' },
        states: {
          Todo: { role: 'active' },
          Review: { role: 'active', effort: '  xhigh  ' },
          Blank: { role: 'active', effort: '   ' },
          ExplicitNull: { role: 'active', effort: null },
          Done: { role: 'terminal' },
          Triage: { role: 'holding' },
        },
      },
      '/tmp/WORKFLOW.md',
    );
    // No `effort:` declared → undefined (so resolveDispatchConfig can fall through to
    // the workflow-level acp.effort).
    assert.equal(cfg.states.Todo!.effort, undefined);
    assert.equal(cfg.states.Review!.effort, 'xhigh');
    // Explicit blank string clears the workflow default (same shape as model).
    assert.equal(cfg.states.Blank!.effort, null);
    // Explicit YAML null also clears — must NOT collapse to undefined the way an
    // omitted key does, or resolveDispatchConfig would silently re-inherit acp.effort.
    assert.equal(cfg.states.ExplicitNull!.effort, null);
  });
});

describe('workflow states validation', () => {
  // Use a fresh tracker root so the tracker existence check inside validateDispatch
  // succeeds and we exercise the state-map branch.
  async function withTrackerRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
    const root = await mkdtemp(path.join(os.tmpdir(), 'symphony-states-validate-'));
    try {
      return await fn(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  it('rejects a workflow with no active state', async () => {
    await withTrackerRoot(async (root) => {
      const cfg = buildServiceConfig(
        {
          tracker: { kind: 'local', root },
          states: { Done: { role: 'terminal' }, Triage: { role: 'holding' } },
        },
        '/tmp/WORKFLOW.md',
      );
      const err = validateDispatch(cfg);
      assert.match(err ?? '', /at least one state must have role: active/);
    });
  });

  it('rejects a workflow with no terminal state', async () => {
    await withTrackerRoot(async (root) => {
      const cfg = buildServiceConfig(
        {
          tracker: { kind: 'local', root },
          states: { Todo: { role: 'active' } },
        },
        '/tmp/WORKFLOW.md',
      );
      const err = validateDispatch(cfg);
      assert.match(err ?? '', /at least one state must have role: terminal/);
    });
  });

  it('rejects a workflow with no holding state', async () => {
    await withTrackerRoot(async (root) => {
      const cfg = buildServiceConfig(
        {
          tracker: { kind: 'local', root },
          states: { Todo: { role: 'active' }, Done: { role: 'terminal' } },
        },
        '/tmp/WORKFLOW.md',
      );
      const err = validateDispatch(cfg);
      assert.match(err ?? '', /at least one state must have role: holding/);
    });
  });

  it('rejects duplicate state names (case-insensitive)', async () => {
    await withTrackerRoot(async (root) => {
      const cfg = buildServiceConfig(
        {
          tracker: { kind: 'local', root },
          states: {
            Todo: { role: 'active' },
            todo: { role: 'active' },
            Done: { role: 'terminal' },
            Triage: { role: 'holding' },
          },
        },
        '/tmp/WORKFLOW.md',
      );
      const err = validateDispatch(cfg);
      assert.match(err ?? '', /duplicate state name/);
    });
  });

  it('rejects allowed_transitions targeting an undeclared state', async () => {
    await withTrackerRoot(async (root) => {
      const cfg = buildServiceConfig(
        {
          tracker: { kind: 'local', root },
          states: {
            Todo: { role: 'active', allowed_transitions: ['Mystery'] },
            Done: { role: 'terminal' },
            Triage: { role: 'holding' },
          },
        },
        '/tmp/WORKFLOW.md',
      );
      const err = validateDispatch(cfg);
      assert.match(err ?? '', /allowed_transitions references undeclared state "Mystery"/);
    });
  });

  it('rejects unknown adapter in a per-state override', async () => {
    await withTrackerRoot(async (root) => {
      const cfg = buildServiceConfig(
        {
          tracker: { kind: 'local', root },
          states: {
            Todo: { role: 'active', adapter: 'opencode' },
            Done: { role: 'terminal' },
            Triage: { role: 'holding' },
          },
        },
        '/tmp/WORKFLOW.md',
      );
      const err = validateDispatch(cfg);
      assert.match(err ?? '', /adapter "opencode" is not a known profile/);
    });
  });

  it('rejects per-state adapter whose host credential is missing', async () => {
    // Point HOME at an empty tmp dir so the cred file the validator probes for
    // does not exist. assertHostCredentialReadable uses os.homedir() which reads
    // $HOME at call time.
    await withTrackerRoot(async (root) => {
      const fakeHome = await mkdtemp(path.join(os.tmpdir(), 'symphony-fake-home-'));
      const prevHome = process.env.HOME;
      process.env.HOME = fakeHome;
      try {
        const cfg = buildServiceConfig(
          {
            tracker: { kind: 'local', root },
            states: {
              Todo: { role: 'active', adapter: 'claude' },
              Done: { role: 'terminal' },
              Triage: { role: 'holding' },
            },
          },
          '/tmp/WORKFLOW.md',
        );
        const err = validateDispatch(cfg);
        assert.match(err ?? '', /requires a host credential at/);
      } finally {
        if (prevHome === undefined) delete process.env.HOME;
        else process.env.HOME = prevHome;
        await rm(fakeHome, { recursive: true, force: true });
      }
    });
  });

  it('accepts a workflow with no per-state adapter overrides even when host cred is missing', async () => {
    // The acp-level adapter check still runs (via the existing orchestrator
    // startup probe), but validateStates only walks per-state adapters; a state
    // without `adapter` must not trigger a credential check.
    await withTrackerRoot(async (root) => {
      const fakeHome = await mkdtemp(path.join(os.tmpdir(), 'symphony-fake-home-'));
      const prevHome = process.env.HOME;
      process.env.HOME = fakeHome;
      try {
        const cfg = buildServiceConfig(
          {
            tracker: { kind: 'local', root },
            states: {
              Todo: { role: 'active' },
              Done: { role: 'terminal' },
              Triage: { role: 'holding' },
            },
          },
          '/tmp/WORKFLOW.md',
        );
        const err = validateDispatch(cfg);
        assert.equal(err, null);
      } finally {
        if (prevHome === undefined) delete process.env.HOME;
        else process.env.HOME = prevHome;
        await rm(fakeHome, { recursive: true, force: true });
      }
    });
  });

});
