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
  resolveAfterRunScript,
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
          Done: { role: 'terminal' },
          Triage: { role: 'holding' },
        },
      },
      '/tmp/WORKFLOW.md',
    );
    assert.equal(cfg.states.Todo!.model, 'claude-opus-4-7');
    // Blank model trims to null — same normalization as the workflow-level acp.model.
    assert.equal(cfg.states.Review!.model, null);
  });

  it('parses per-state hooks.after_run (string and explicit null)', () => {
    const cfg = buildServiceConfig(
      {
        tracker: { kind: 'local', root: '/tmp/issues' },
        states: {
          Todo: { role: 'active' },
          Done: { role: 'terminal', hooks: { after_run: 'echo merge' } },
          Cancelled: { role: 'terminal', hooks: { after_run: null } },
          Triage: { role: 'holding' },
        },
      },
      '/tmp/WORKFLOW.md',
    );
    assert.equal(cfg.states.Done!.hooks?.after_run, 'echo merge');
    // Explicit null preserves the "suppress" semantics so the resolver can
    // tell it apart from "inherit the workflow default".
    assert.equal(cfg.states.Cancelled!.hooks?.after_run, null);
    assert.ok('after_run' in cfg.states.Cancelled!.hooks!);
    // A state with no `hooks` block at all just doesn't carry the field.
    assert.equal(cfg.states.Todo!.hooks, undefined);
  });

  it('rejects a non-string per-state hooks.after_run', () => {
    assert.throws(
      () =>
        buildServiceConfig(
          {
            tracker: { kind: 'local', root: '/tmp/issues' },
            states: {
              Todo: { role: 'active' },
              Done: { role: 'terminal', hooks: { after_run: 42 } },
              Triage: { role: 'holding' },
            },
          },
          '/tmp/WORKFLOW.md',
        ),
      /hooks\.after_run must be a string or null/,
    );
  });

  it('rejects a non-object per-state hooks value', () => {
    assert.throws(
      () =>
        buildServiceConfig(
          {
            tracker: { kind: 'local', root: '/tmp/issues' },
            states: {
              Todo: { role: 'active' },
              Done: { role: 'terminal', hooks: 'echo merge' },
              Triage: { role: 'holding' },
            },
          },
          '/tmp/WORKFLOW.md',
        ),
      /hooks must be a map/,
    );
  });
});

describe('resolveAfterRunScript', () => {
  it('returns the per-state script when set', () => {
    const cfg = buildServiceConfig(
      {
        tracker: { kind: 'local', root: '/tmp/issues' },
        hooks: { after_run: 'echo fallback' },
        states: {
          Todo: { role: 'active' },
          Done: { role: 'terminal', hooks: { after_run: 'echo merge' } },
          Triage: { role: 'holding' },
        },
      },
      '/tmp/WORKFLOW.md',
    );
    assert.equal(resolveAfterRunScript(cfg, 'Done'), 'echo merge');
  });

  it('returns null when the per-state script is explicit null (suppress)', () => {
    const cfg = buildServiceConfig(
      {
        tracker: { kind: 'local', root: '/tmp/issues' },
        hooks: { after_run: 'echo fallback' },
        states: {
          Todo: { role: 'active' },
          Done: { role: 'terminal' },
          Cancelled: { role: 'terminal', hooks: { after_run: null } },
          Triage: { role: 'holding' },
        },
      },
      '/tmp/WORKFLOW.md',
    );
    // Explicit null on the state wins, even when a workflow-level fallback exists.
    assert.equal(resolveAfterRunScript(cfg, 'Cancelled'), null);
  });

  it('falls back to workflow-level hooks.after_run when the state has no hooks block', () => {
    const cfg = buildServiceConfig(
      {
        tracker: { kind: 'local', root: '/tmp/issues' },
        hooks: { after_run: 'echo fallback' },
        states: {
          Todo: { role: 'active' },
          Done: { role: 'terminal' },
          Triage: { role: 'holding' },
        },
      },
      '/tmp/WORKFLOW.md',
    );
    assert.equal(resolveAfterRunScript(cfg, 'Done'), 'echo fallback');
  });

  it('returns null when neither state-level nor workflow-level is set', () => {
    const cfg = buildServiceConfig(
      {
        tracker: { kind: 'local', root: '/tmp/issues' },
        states: {
          Todo: { role: 'active' },
          Done: { role: 'terminal' },
          Triage: { role: 'holding' },
        },
      },
      '/tmp/WORKFLOW.md',
    );
    assert.equal(resolveAfterRunScript(cfg, 'Done'), null);
  });

  it('looks up states case-insensitively', () => {
    const cfg = buildServiceConfig(
      {
        tracker: { kind: 'local', root: '/tmp/issues' },
        states: {
          Todo: { role: 'active' },
          Done: { role: 'terminal', hooks: { after_run: 'echo merge' } },
          Triage: { role: 'holding' },
        },
      },
      '/tmp/WORKFLOW.md',
    );
    assert.equal(resolveAfterRunScript(cfg, 'done'), 'echo merge');
    assert.equal(resolveAfterRunScript(cfg, 'DONE'), 'echo merge');
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
