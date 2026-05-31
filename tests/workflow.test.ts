import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  splitFrontMatter,
  buildServiceConfig,
  expandVar,
  parseWorkflow,
  validateDispatch,
} from '../src/workflow.js';
import { validateDispatchIo } from '../src/workflow-loader.js';
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
    const text = ['---', 'agent:', '  preamble: |', '    echo a', '    ---', '    echo b', '---', 'prompt body'].join('\n');
    const r = splitFrontMatter(text);
    assert.equal((r.config as any).agent.preamble.trim(), 'echo a\n---\necho b');
    assert.equal(r.body, 'prompt body');
  });

  it('rejects unset $VAR for tracker.root', () => {
    assert.throws(() =>
      buildServiceConfig(
        {
          tracker: { kind: 'local', root: '$SYM_DOES_NOT_EXIST' },
          states: minimalStates,
        },
        '/tmp/WORKFLOW.md',
        {},
      ),
    );
  });

  it('expands env vars only on $VAR pattern', () => {
    assert.equal(expandVar('$SYM_FOO', { SYM_FOO: '/some/abs' }), '/some/abs');
    assert.equal(expandVar('https://api.example/path', {}), 'https://api.example/path');
  });

  it('parseWorkflow returns both definition and config from a string', () => {
    const text = [
      '---',
      'tracker:',
      '  kind: local',
      '  root: /tmp/issues',
      'states:',
      '  Todo: { role: active }',
      '  Done: { role: terminal }',
      '  Triage: { role: holding }',
      '---',
      'prompt body {{ issue.identifier }}',
    ].join('\n');
    const { definition, config } = parseWorkflow(text, '/tmp/WORKFLOW.md');
    assert.equal(config.tracker.kind, 'local');
    assert.equal(config.tracker.root, '/tmp/issues');
    assert.equal(definition.prompt_template, 'prompt body {{ issue.identifier }}');
    assert.deepEqual(Object.keys(config.states), ['Todo', 'Done', 'Triage']);
  });

  it('parseWorkflow threads env into $VAR expansion', () => {
    const text = [
      '---',
      'tracker:',
      '  kind: local',
      '  root: $SYM_TRACKER_ROOT',
      'states:',
      '  Todo: { role: active }',
      '  Done: { role: terminal }',
      '  Triage: { role: holding }',
      '---',
      'body',
    ].join('\n');
    const { config } = parseWorkflow(text, '/tmp/WORKFLOW.md', {
      SYM_TRACKER_ROOT: '/var/lib/symphony',
    });
    assert.equal(config.tracker.root, '/var/lib/symphony');
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
    // Circuit breaker (issue 128) defaults to 5 consecutive identical failures.
    assert.equal(cfg.agent.circuit_breaker_threshold, 5);
  });

  it('parses agent.circuit_breaker_threshold and rejects the degenerate value 1 (issue 128)', () => {
    const cfg = buildServiceConfig(
      {
        tracker: { kind: 'local', root: '/tmp/issues' },
        states: minimalStates,
        agent: { circuit_breaker_threshold: 0 },
      },
      '/tmp/WORKFLOW.md',
    );
    assert.equal(cfg.agent.circuit_breaker_threshold, 0); // 0 = disabled
    assert.throws(
      () =>
        buildServiceConfig(
          {
            tracker: { kind: 'local', root: '/tmp/issues' },
            states: minimalStates,
            agent: { circuit_breaker_threshold: 1 },
          },
          '/tmp/WORKFLOW.md',
        ),
      /circuit_breaker_threshold must be 0 \(disabled\) or an integer >= 2/,
    );
    assert.throws(
      () =>
        buildServiceConfig(
          {
            tracker: { kind: 'local', root: '/tmp/issues' },
            states: minimalStates,
            agent: { circuit_breaker_threshold: -3 },
          },
          '/tmp/WORKFLOW.md',
        ),
      /circuit_breaker_threshold must be 0 \(disabled\) or an integer >= 2/,
    );
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

  it('parses the credentials block (ticker interval) (issue 113)', () => {
    const cfg = buildServiceConfig(
      {
        tracker: { kind: 'local', root: '/tmp/issues' },
        states: minimalStates,
        credentials: {
          ticker_interval_ms: 600_000,
        },
      },
      '/tmp/WORKFLOW.md',
    );
    assert.equal(cfg.credentials.ticker_interval_ms, 600_000);
    const defaults = buildServiceConfig(
      { tracker: { kind: 'local', root: '/tmp/issues' }, states: minimalStates },
      '/tmp/WORKFLOW.md',
    );
    assert.equal(defaults.credentials.ticker_interval_ms, 6 * 60 * 60 * 1000);
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

  it('parses gondolin.image (the VM image selector) and defaults the rest', () => {
    const cfg = buildServiceConfig(
      {
        tracker: { kind: 'local', root: '/tmp/issues' },
        states: minimalStates,
        gondolin: { image: 'symphony-agents:latest', cpus: 4, mem_mib: 8192 },
      },
      '/tmp/symphony/WORKFLOW.md',
    );
    assert.equal(cfg.gondolin.image, 'symphony-agents:latest');
    assert.equal(cfg.gondolin.cpus, 4);
    assert.equal(cfg.gondolin.mem_mib, 8192);
    assert.deepEqual(cfg.gondolin.volumes, []);
  });

  it('parses egress.allowed_hosts (the dev-tooling firewall) and defaults to []', () => {
    const withEgress = buildServiceConfig(
      {
        tracker: { kind: 'local', root: '/tmp/issues' },
        states: minimalStates,
        egress: { allowed_hosts: ['registry.npmjs.org', 'github.com'] },
      },
      '/tmp/symphony/WORKFLOW.md',
    );
    assert.deepEqual(withEgress.egress.allowed_hosts, ['registry.npmjs.org', 'github.com']);

    const noEgress = buildServiceConfig(
      { tracker: { kind: 'local', root: '/tmp/issues' }, states: minimalStates },
      '/tmp/symphony/WORKFLOW.md',
    );
    assert.deepEqual(noEgress.egress.allowed_hosts, [], 'absent egress block ⇒ empty allowlist');
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

  it('parses per-state eval_mode boolean opt-in', () => {
    // Issue 40: per-state opt-in for symphony self-introspection mounts. Only
    // `true` enables it; absent / false / any non-boolean is rejected so a
    // YAML-quoting accident ("true" as a string) can't silently turn the
    // extra mounts on.
    const cfg = buildServiceConfig(
      {
        tracker: { kind: 'local', root: '/tmp/issues' },
        states: {
          Todo: { role: 'active' },
          Eval: { role: 'active', eval_mode: true },
          Calm: { role: 'active', eval_mode: false },
          Done: { role: 'terminal' },
          Triage: { role: 'holding' },
        },
      },
      '/tmp/WORKFLOW.md',
    );
    assert.equal(cfg.states.Eval!.eval_mode, true);
    // Explicit false normalizes to "not opted in" (omitted on the parsed
    // shape; consumers branch on `=== true`).
    assert.equal(cfg.states.Calm!.eval_mode, undefined);
    assert.equal(cfg.states.Todo!.eval_mode, undefined);
  });

  it('rejects a non-boolean eval_mode value', () => {
    assert.throws(
      () =>
        buildServiceConfig(
          {
            tracker: { kind: 'local', root: '/tmp/issues' },
            states: {
              Todo: { role: 'active' },
              Eval: { role: 'active', eval_mode: 'true' },
              Done: { role: 'terminal' },
              Triage: { role: 'holding' },
            },
          },
          '/tmp/WORKFLOW.md',
        ),
      /eval_mode must be a boolean/,
    );
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
            Todo: { role: 'active', adapter: 'gemini' },
            Done: { role: 'terminal' },
            Triage: { role: 'holding' },
          },
        },
        '/tmp/WORKFLOW.md',
      );
      const err = validateDispatch(cfg);
      assert.match(err ?? '', /adapter "gemini" is not a known profile/);
    });
  });

  it('rejects per-state adapter whose host credential is missing', async () => {
    // Point HOME at an empty tmp dir so the credential file the validator
    // probes for does not exist. validateDispatchIo calls hostClaudeCredentialPath()
    // for any state pinned to the claude adapter; the probe uses os.homedir()
    // (which reads $HOME) at call time. The fs probe lives in the shell loader;
    // the pure structural validateDispatch no longer touches the disk. codex is
    // probed too, but via its own sources (auth.json token / OPENAI_API_KEY) —
    // covered by the dedicated codex cases below.
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
        assert.equal(validateDispatch(cfg), null);
        const err = validateDispatchIo(cfg);
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
    // startup probe), but validateDispatchIo only walks per-state adapters; a
    // state without `adapter` must not trigger a credential check.
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
        assert.equal(validateDispatch(cfg), null);
        assert.equal(validateDispatchIo(cfg), null);
      } finally {
        if (prevHome === undefined) delete process.env.HOME;
        else process.env.HOME = prevHome;
        await rm(fakeHome, { recursive: true, force: true });
      }
    });
  });

  it('rejects a per-state codex adapter when neither auth.json nor OPENAI_API_KEY is present', async () => {
    // Empty fake HOME (no `~/.codex/auth.json`) and OPENAI_API_KEY unset: codex
    // routes through the proxy with two valid sources, so the probe fails only
    // when BOTH are absent.
    await withTrackerRoot(async (root) => {
      const fakeHome = await mkdtemp(path.join(os.tmpdir(), 'symphony-fake-home-codex-'));
      const prevHome = process.env.HOME;
      const prevKey = process.env.OPENAI_API_KEY;
      process.env.HOME = fakeHome;
      delete process.env.OPENAI_API_KEY;
      try {
        const cfg = buildServiceConfig(
          {
            tracker: { kind: 'local', root },
            states: {
              Todo: { role: 'active', adapter: 'codex' },
              Done: { role: 'terminal' },
              Triage: { role: 'holding' },
            },
          },
          '/tmp/WORKFLOW.md',
        );
        assert.equal(validateDispatch(cfg), null);
        const err = validateDispatchIo(cfg);
        assert.match(err ?? '', /adapter "codex" requires a host credential/);
      } finally {
        if (prevHome === undefined) delete process.env.HOME;
        else process.env.HOME = prevHome;
        if (prevKey === undefined) delete process.env.OPENAI_API_KEY;
        else process.env.OPENAI_API_KEY = prevKey;
        await rm(fakeHome, { recursive: true, force: true });
      }
    });
  });

  it('accepts a per-state codex adapter satisfied by OPENAI_API_KEY alone', async () => {
    await withTrackerRoot(async (root) => {
      const fakeHome = await mkdtemp(path.join(os.tmpdir(), 'symphony-fake-home-codex-env-'));
      const prevHome = process.env.HOME;
      const prevKey = process.env.OPENAI_API_KEY;
      process.env.HOME = fakeHome;
      process.env.OPENAI_API_KEY = 'sk-env-codex';
      try {
        const cfg = buildServiceConfig(
          {
            tracker: { kind: 'local', root },
            states: {
              Todo: { role: 'active', adapter: 'codex' },
              Done: { role: 'terminal' },
              Triage: { role: 'holding' },
            },
          },
          '/tmp/WORKFLOW.md',
        );
        assert.equal(validateDispatch(cfg), null);
        assert.equal(validateDispatchIo(cfg), null);
      } finally {
        if (prevHome === undefined) delete process.env.HOME;
        else process.env.HOME = prevHome;
        if (prevKey === undefined) delete process.env.OPENAI_API_KEY;
        else process.env.OPENAI_API_KEY = prevKey;
        await rm(fakeHome, { recursive: true, force: true });
      }
    });
  });

  it('accepts a per-state codex adapter satisfied by a ~/.codex/auth.json token', async () => {
    await withTrackerRoot(async (root) => {
      const fakeHome = await mkdtemp(path.join(os.tmpdir(), 'symphony-fake-home-codex-file-'));
      const prevHome = process.env.HOME;
      const prevKey = process.env.OPENAI_API_KEY;
      process.env.HOME = fakeHome;
      delete process.env.OPENAI_API_KEY;
      try {
        await mkdir(path.join(fakeHome, '.codex'), { recursive: true });
        await writeFile(
          path.join(fakeHome, '.codex', 'auth.json'),
          JSON.stringify({ tokens: { access_token: 'codex-oauth-token' } }),
        );
        const cfg = buildServiceConfig(
          {
            tracker: { kind: 'local', root },
            states: {
              Todo: { role: 'active', adapter: 'codex' },
              Done: { role: 'terminal' },
              Triage: { role: 'holding' },
            },
          },
          '/tmp/WORKFLOW.md',
        );
        assert.equal(validateDispatch(cfg), null);
        assert.equal(validateDispatchIo(cfg), null);
      } finally {
        if (prevHome === undefined) delete process.env.HOME;
        else process.env.HOME = prevHome;
        if (prevKey === undefined) delete process.env.OPENAI_API_KEY;
        else process.env.OPENAI_API_KEY = prevKey;
        await rm(fakeHome, { recursive: true, force: true });
      }
    });
  });

});

describe('pr_autopilot block', () => {
  async function withTrackerRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
    const root = await mkdtemp(path.join(os.tmpdir(), 'symphony-pr-autopilot-validate-'));
    try {
      return await fn(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  it('pr_autopilot defaults off when block is absent', () => {
    const cfg = buildServiceConfig(
      { tracker: { kind: 'local', root: '/tmp/issues' }, states: minimalStates },
      '/tmp/WORKFLOW.md',
    );
    assert.equal(cfg.pr_autopilot.enabled, false);
    assert.equal(cfg.pr_autopilot.merge_state, 'Done');
    assert.equal(cfg.pr_autopilot.close_state, 'Cancelled');
    assert.equal(cfg.pr_autopilot.auto_merge_strategy, 'squash');
  });

  it('pr_autopilot parses explicit fields and normalizes auto_merge_strategy', () => {
    const cfg = buildServiceConfig(
      {
        tracker: { kind: 'local', root: '/tmp/issues' },
        states: minimalStates,
        pr_autopilot: {
          enabled: true,
          merge_state: 'Done',
          close_state: 'Cancelled',
          conflict_route_to: 'Todo',
          auto_merge_strategy: 'rebase',
          poll_interval_ms: 15000,
        },
      },
      '/tmp/WORKFLOW.md',
    );
    assert.equal(cfg.pr_autopilot.enabled, true);
    assert.equal(cfg.pr_autopilot.conflict_route_to, 'Todo');
    assert.equal(cfg.pr_autopilot.auto_merge_strategy, 'rebase');
    assert.equal(cfg.pr_autopilot.poll_interval_ms, 15000);
  });

  it('pr_autopilot distinguishes absent close_state (default Cancelled) from explicit null/empty (disabled)', () => {
    // Key absent → default 'Cancelled'.
    const absent = buildServiceConfig(
      {
        tracker: { kind: 'local', root: '/tmp/issues' },
        states: minimalStates,
        pr_autopilot: { enabled: true },
      },
      '/tmp/WORKFLOW.md',
    );
    assert.equal(absent.pr_autopilot.close_state, 'Cancelled');

    // Explicit null → disabled (the close path is off).
    const explicitNull = buildServiceConfig(
      {
        tracker: { kind: 'local', root: '/tmp/issues' },
        states: minimalStates,
        pr_autopilot: { enabled: true, close_state: null },
      },
      '/tmp/WORKFLOW.md',
    );
    assert.equal(explicitNull.pr_autopilot.close_state, null);

    // Explicit empty string → disabled (treated the same as null per the
    // template doc — "omit by setting an empty string").
    const explicitEmpty = buildServiceConfig(
      {
        tracker: { kind: 'local', root: '/tmp/issues' },
        states: minimalStates,
        pr_autopilot: { enabled: true, close_state: '' },
      },
      '/tmp/WORKFLOW.md',
    );
    assert.equal(explicitEmpty.pr_autopilot.close_state, null);

    // Whitespace-only string → disabled (trim before checking).
    const explicitBlank = buildServiceConfig(
      {
        tracker: { kind: 'local', root: '/tmp/issues' },
        states: minimalStates,
        pr_autopilot: { enabled: true, close_state: '   ' },
      },
      '/tmp/WORKFLOW.md',
    );
    assert.equal(explicitBlank.pr_autopilot.close_state, null);
  });

  it('pr_autopilot rejects poll_interval_ms < 0 at parse time', () => {
    assert.throws(() =>
      buildServiceConfig(
        {
          tracker: { kind: 'local', root: '/tmp/issues' },
          states: minimalStates,
          pr_autopilot: { enabled: true, poll_interval_ms: -1 },
        },
        '/tmp/WORKFLOW.md',
      ),
    );
  });

  it('pr_autopilot validation: rejects merge_state that is not terminal', async () => {
    await withTrackerRoot(async (root) => {
      const cfg = buildServiceConfig(
        {
          tracker: { kind: 'local', root },
          states: {
            Todo: { role: 'active' },
            Done: { role: 'terminal' },
            Triage: { role: 'holding' },
            Conflict: { role: 'holding' },
          },
          pr_autopilot: { enabled: true, merge_state: 'Todo' },
        },
        '/tmp/WORKFLOW.md',
      );
      const err = validateDispatch(cfg);
      assert.match(err ?? '', /merge_state .* must be a terminal state/);
    });
  });

  it('pr_autopilot validation: rejects conflict_route_to that is not active', async () => {
    await withTrackerRoot(async (root) => {
      const cfg = buildServiceConfig(
        {
          tracker: { kind: 'local', root },
          states: {
            Todo: { role: 'active' },
            Done: { role: 'terminal' },
            Cancelled: { role: 'terminal' },
            Triage: { role: 'holding' },
            Conflict: { role: 'holding' },
          },
          pr_autopilot: {
            enabled: true,
            conflict_route_to: 'Triage',
          },
        },
        '/tmp/WORKFLOW.md',
      );
      const err = validateDispatch(cfg);
      assert.match(err ?? '', /conflict_route_to .* must be an active state/);
    });
  });

  it('pr_autopilot disabled bypasses cross-reference validation', async () => {
    await withTrackerRoot(async (root) => {
      const cfg = buildServiceConfig(
        {
          tracker: { kind: 'local', root },
          states: minimalStates,
          // enabled:false skips the state lookup, so an undeclared name does not error.
          pr_autopilot: { enabled: false, merge_state: 'Nope' },
        },
        '/tmp/WORKFLOW.md',
      );
      const err = validateDispatch(cfg);
      assert.equal(err, null);
    });
  });

});

describe('sleep_cycle block', () => {
  // States with both a Reflect (active) and Dormant (holding) declared, so the
  // enabled cross-reference checks have valid targets to resolve against.
  const sleepStates = {
    Todo: { role: 'active' as const },
    Reflect: { role: 'active' as const },
    Done: { role: 'terminal' as const },
    Triage: { role: 'holding' as const },
    Dormant: { role: 'holding' as const },
  };

  it('defaults off when the block is absent', () => {
    const cfg = buildServiceConfig(
      { tracker: { kind: 'local', root: '/tmp/issues' }, states: minimalStates },
      '/tmp/WORKFLOW.md',
    );
    assert.equal(cfg.sleep_cycle.enabled, false);
    assert.equal(cfg.sleep_cycle.issue_id, null);
    assert.equal(cfg.sleep_cycle.dormant_state, 'Dormant');
    assert.equal(cfg.sleep_cycle.reflect_state, 'Reflect');
    assert.equal(cfg.sleep_cycle.arm_on_idle, true);
    assert.equal(cfg.sleep_cycle.arm_after_done, 0);
  });

  it('parses explicit fields', () => {
    const cfg = buildServiceConfig(
      {
        tracker: { kind: 'local', root: '/tmp/issues' },
        states: sleepStates,
        sleep_cycle: {
          enabled: true,
          issue_id: 'sleep-cycle',
          dormant_state: 'Dormant',
          reflect_state: 'Reflect',
          arm_on_idle: false,
          arm_after_done: 7,
        },
      },
      '/tmp/WORKFLOW.md',
    );
    assert.equal(cfg.sleep_cycle.enabled, true);
    assert.equal(cfg.sleep_cycle.issue_id, 'sleep-cycle');
    assert.equal(cfg.sleep_cycle.arm_on_idle, false);
    assert.equal(cfg.sleep_cycle.arm_after_done, 7);
  });

  it('rejects a negative arm_after_done at parse time', () => {
    assert.throws(
      () =>
        buildServiceConfig(
          {
            tracker: { kind: 'local', root: '/tmp/issues' },
            states: sleepStates,
            sleep_cycle: { enabled: true, issue_id: 'sleep-cycle', arm_after_done: -1 },
          },
          '/tmp/WORKFLOW.md',
        ),
      /arm_after_done must be a non-negative integer/,
    );
  });

  it('validates a well-formed enabled block', () => {
    const cfg = buildServiceConfig(
      {
        tracker: { kind: 'local', root: '/tmp/issues' },
        states: sleepStates,
        sleep_cycle: {
          enabled: true,
          issue_id: 'sleep-cycle',
          dormant_state: 'Dormant',
          reflect_state: 'Reflect',
          arm_after_done: 5,
        },
      },
      '/tmp/WORKFLOW.md',
    );
    assert.equal(validateDispatch(cfg), null);
  });

  it('rejects an enabled block with no issue_id', () => {
    const cfg = buildServiceConfig(
      {
        tracker: { kind: 'local', root: '/tmp/issues' },
        states: sleepStates,
        sleep_cycle: { enabled: true, dormant_state: 'Dormant', reflect_state: 'Reflect' },
      },
      '/tmp/WORKFLOW.md',
    );
    assert.match(validateDispatch(cfg) ?? '', /sleep_cycle\.issue_id is required/);
  });

  it('rejects a dormant_state that is not a holding state', () => {
    const cfg = buildServiceConfig(
      {
        tracker: { kind: 'local', root: '/tmp/issues' },
        states: sleepStates,
        // Todo is active, not holding.
        sleep_cycle: { enabled: true, issue_id: 'sleep-cycle', dormant_state: 'Todo' },
      },
      '/tmp/WORKFLOW.md',
    );
    assert.match(validateDispatch(cfg) ?? '', /dormant_state "Todo" must be a holding state/);
  });

  it('rejects a reflect_state that is not an active state', () => {
    const cfg = buildServiceConfig(
      {
        tracker: { kind: 'local', root: '/tmp/issues' },
        states: sleepStates,
        // Triage is holding, not active.
        sleep_cycle: { enabled: true, issue_id: 'sleep-cycle', reflect_state: 'Triage' },
      },
      '/tmp/WORKFLOW.md',
    );
    assert.match(validateDispatch(cfg) ?? '', /reflect_state "Triage" must be an active state/);
  });

  it('rejects a dormant_state referencing an undeclared state', () => {
    const cfg = buildServiceConfig(
      {
        tracker: { kind: 'local', root: '/tmp/issues' },
        states: sleepStates,
        sleep_cycle: { enabled: true, issue_id: 'sleep-cycle', dormant_state: 'Nowhere' },
      },
      '/tmp/WORKFLOW.md',
    );
    assert.match(validateDispatch(cfg) ?? '', /dormant_state references undeclared state "Nowhere"/);
  });

  it('disabled bypasses cross-reference validation', () => {
    const cfg = buildServiceConfig(
      {
        tracker: { kind: 'local', root: '/tmp/issues' },
        states: minimalStates,
        // enabled:false → the undeclared/missing names must not error.
        sleep_cycle: { enabled: false, dormant_state: 'Nope', reflect_state: 'AlsoNope' },
      },
      '/tmp/WORKFLOW.md',
    );
    assert.equal(validateDispatch(cfg), null);
  });
});
