import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveDispatchConfig } from '../src/agent/runner.js';
import { buildServiceConfig } from '../src/workflow.js';

// Phase 2 contract: `resolveDispatchConfig` is the single resolution site for
// adapter/model/max_turns at dispatch time. Per-state overrides win; workflow
// defaults fall through; an undeclared state throws (defense in depth — the
// orchestrator should never dispatch one, but if it does we want a loud, clear
// error rather than a silent fall-through to the global default).

describe('resolveDispatchConfig', () => {
  it('returns per-state values when set', () => {
    const cfg = buildServiceConfig(
      {
        tracker: { kind: 'local', root: '/tmp/issues' },
        acp: { adapter: 'claude', model: 'claude-opus-4-7' },
        agent: { max_turns: 20 },
        states: {
          Todo: { role: 'active', adapter: 'claude', model: 'claude-sonnet-4-5', max_turns: 5 },
          Review: { role: 'active', adapter: 'codex', model: 'gpt-5-codex', max_turns: 4 },
          Done: { role: 'terminal' },
          Triage: { role: 'holding' },
        },
      },
      '/tmp/WORKFLOW.md',
    );
    assert.deepEqual(resolveDispatchConfig(cfg, 'Todo'), {
      adapter: 'claude',
      model: 'claude-sonnet-4-5',
      effort: null,
      max_turns: 5,
    });
    assert.deepEqual(resolveDispatchConfig(cfg, 'Review'), {
      adapter: 'codex',
      model: 'gpt-5-codex',
      effort: null,
      max_turns: 4,
    });
  });

  it('falls back to workflow-level defaults when the state declares no overrides', () => {
    const cfg = buildServiceConfig(
      {
        tracker: { kind: 'local', root: '/tmp/issues' },
        acp: { adapter: 'codex', model: 'gpt-5-codex' },
        agent: { max_turns: 17 },
        states: {
          Todo: { role: 'active' },
          Done: { role: 'terminal' },
          Triage: { role: 'holding' },
        },
      },
      '/tmp/WORKFLOW.md',
    );
    assert.deepEqual(resolveDispatchConfig(cfg, 'Todo'), {
      adapter: 'codex',
      model: 'gpt-5-codex',
      effort: null,
      max_turns: 17,
    });
  });

  it('partial overrides cascade onto workflow defaults', () => {
    // Adapter overridden but model + max_turns inherit from the workflow level.
    const cfg = buildServiceConfig(
      {
        tracker: { kind: 'local', root: '/tmp/issues' },
        acp: { adapter: 'claude', model: 'claude-opus-4-7' },
        agent: { max_turns: 30 },
        states: {
          Review: { role: 'active', adapter: 'codex' },
          Done: { role: 'terminal' },
          Triage: { role: 'holding' },
        },
      },
      '/tmp/WORKFLOW.md',
    );
    assert.deepEqual(resolveDispatchConfig(cfg, 'Review'), {
      adapter: 'codex',
      model: 'claude-opus-4-7',
      effort: null,
      max_turns: 30,
    });
  });

  it('resolves states case-insensitively', () => {
    // Tracker directory names are compared case-insensitively elsewhere in
    // symphony (eligibility, reconciliation); the helper has to follow suit so
    // a state declared as `Todo` resolves correctly for an issue whose state
    // field is `todo`.
    const cfg = buildServiceConfig(
      {
        tracker: { kind: 'local', root: '/tmp/issues' },
        acp: { adapter: 'claude' },
        states: {
          Todo: { role: 'active', max_turns: 7 },
          Done: { role: 'terminal' },
          Triage: { role: 'holding' },
        },
      },
      '/tmp/WORKFLOW.md',
    );
    assert.equal(resolveDispatchConfig(cfg, 'todo').max_turns, 7);
    assert.equal(resolveDispatchConfig(cfg, 'TODO').max_turns, 7);
  });

  it('throws when the state is not declared', () => {
    const cfg = buildServiceConfig(
      {
        tracker: { kind: 'local', root: '/tmp/issues' },
        acp: { adapter: 'claude' },
        states: {
          Todo: { role: 'active' },
          Done: { role: 'terminal' },
          Triage: { role: 'holding' },
        },
      },
      '/tmp/WORKFLOW.md',
    );
    assert.throws(() => resolveDispatchConfig(cfg, 'Mystery'), /Mystery/);
  });

  it('treats an explicit per-state model: null as "use adapter default"', () => {
    // Distinguish "no model key declared on this state" (inherit workflow
    // acp.model) from "explicitly null" (this state runs against the adapter's
    // own default, ignoring the workflow-level model). Otherwise an operator
    // who deliberately clears the model for a Review state would still see the
    // workflow-level claude-opus-4-7 sneak in.
    const cfg = buildServiceConfig(
      {
        tracker: { kind: 'local', root: '/tmp/issues' },
        acp: { adapter: 'claude', model: 'claude-opus-4-7' },
        states: {
          Todo: { role: 'active', model: '   ' },
          Done: { role: 'terminal' },
          Triage: { role: 'holding' },
        },
      },
      '/tmp/WORKFLOW.md',
    );
    // Parser normalizes a blank model string to null; resolveDispatchConfig
    // must keep that null instead of replacing it with the workflow fallback.
    assert.equal(resolveDispatchConfig(cfg, 'Todo').model, null);
  });

  it('resolves effort with per-state precedence and workflow fallback', () => {
    // Same undefined / null cascade as `model`: per-state effort wins when set;
    // omitting the key inherits acp.effort; explicit blank/null clears the
    // workflow default for that state.
    const cfg = buildServiceConfig(
      {
        tracker: { kind: 'local', root: '/tmp/issues' },
        acp: { adapter: 'codex', effort: 'high' },
        states: {
          Todo: { role: 'active', effort: 'xhigh' },
          Review: { role: 'active' },
          NoEffort: { role: 'active', effort: '   ' },
          Done: { role: 'terminal' },
          Triage: { role: 'holding' },
        },
      },
      '/tmp/WORKFLOW.md',
    );
    assert.equal(resolveDispatchConfig(cfg, 'Todo').effort, 'xhigh');
    assert.equal(resolveDispatchConfig(cfg, 'Review').effort, 'high');
    assert.equal(resolveDispatchConfig(cfg, 'NoEffort').effort, null);
  });

  it('defaults effort to null when neither workflow nor state declares it', () => {
    const cfg = buildServiceConfig(
      {
        tracker: { kind: 'local', root: '/tmp/issues' },
        acp: { adapter: 'codex' },
        states: {
          Todo: { role: 'active' },
          Done: { role: 'terminal' },
          Triage: { role: 'holding' },
        },
      },
      '/tmp/WORKFLOW.md',
    );
    assert.equal(resolveDispatchConfig(cfg, 'Todo').effort, null);
  });
});
