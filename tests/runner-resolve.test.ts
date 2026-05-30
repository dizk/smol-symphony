import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildEvalModeMounts,
  EVAL_MODE_ISSUES_GUEST_PATH,
  EVAL_MODE_LOGS_GUEST_PATH,
  resolveDispatchConfig,
} from '../src/agent/runner.js';
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
      eval_mode: false,
    });
    assert.deepEqual(resolveDispatchConfig(cfg, 'Review'), {
      adapter: 'codex',
      model: 'gpt-5-codex',
      effort: null,
      max_turns: 4,
      eval_mode: false,
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
      eval_mode: false,
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
      eval_mode: false,
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

  it('per-state effort wins over workflow-level acp.effort', () => {
    // Same undefined-vs-null contract as model: per-state effort overrides the
    // workflow-level default; the value is forwarded verbatim (symphony does
    // not validate against the adapter's supportedEffortLevels list).
    const cfg = buildServiceConfig(
      {
        tracker: { kind: 'local', root: '/tmp/issues' },
        acp: { adapter: 'claude', effort: 'medium' },
        states: {
          Todo: { role: 'active', effort: 'xhigh' },
          Review: { role: 'active' },
          Done: { role: 'terminal' },
          Triage: { role: 'holding' },
        },
      },
      '/tmp/WORKFLOW.md',
    );
    assert.equal(resolveDispatchConfig(cfg, 'Todo').effort, 'xhigh');
    assert.equal(resolveDispatchConfig(cfg, 'Review').effort, 'medium');
  });

  it('treats an explicit per-state effort: null as "use adapter default"', () => {
    // Same null semantics as model: an explicit per-state null clears the
    // workflow-level effort for that state rather than inheriting it. Operators
    // can carve out one state that runs at the adapter's own default while the
    // rest of the workflow uses an elevated effort.
    const cfg = buildServiceConfig(
      {
        tracker: { kind: 'local', root: '/tmp/issues' },
        acp: { adapter: 'claude', effort: 'xhigh' },
        states: {
          Todo: { role: 'active', effort: '   ' },
          Done: { role: 'terminal' },
          Triage: { role: 'holding' },
        },
      },
      '/tmp/WORKFLOW.md',
    );
    assert.equal(resolveDispatchConfig(cfg, 'Todo').effort, null);
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

  it('surfaces per-state eval_mode and defaults it to false', () => {
    // Issue 40: a state opts in to read-only symphony mounts via
    // `eval_mode: true`. resolveDispatchConfig pins the flag at attempt start
    // so a workflow reload mid-attempt can't toggle mounts on a live VM.
    const cfg = buildServiceConfig(
      {
        tracker: { kind: 'local', root: '/tmp/issues' },
        acp: { adapter: 'claude' },
        states: {
          Todo: { role: 'active' },
          Eval: { role: 'active', eval_mode: true },
          Done: { role: 'terminal' },
          Triage: { role: 'holding' },
        },
      },
      '/tmp/WORKFLOW.md',
    );
    assert.equal(resolveDispatchConfig(cfg, 'Todo').eval_mode, false);
    assert.equal(resolveDispatchConfig(cfg, 'Eval').eval_mode, true);
  });
});

describe('buildEvalModeMounts', () => {
  it('returns no mounts when the state did not opt in', () => {
    // Defensive: even with both roots configured, a state that didn't set
    // eval_mode: true should contribute zero extra mounts — flipping it by
    // accident would add VFS mounts to every dispatch that didn't ask for them.
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
    const resolved = resolveDispatchConfig(cfg, 'Todo');
    assert.deepEqual(buildEvalModeMounts(cfg, resolved), []);
  });

  it('mounts tracker.root and logs.root read-only when the state opts in', () => {
    const cfg = buildServiceConfig(
      {
        tracker: { kind: 'local', root: '/tmp/issues' },
        // Explicit logs.root so we don't depend on the cwd-relative default.
        logs: { root: '/tmp/logs' },
        acp: { adapter: 'claude' },
        states: {
          Eval: { role: 'active', eval_mode: true },
          Done: { role: 'terminal' },
          Triage: { role: 'holding' },
        },
      },
      '/tmp/WORKFLOW.md',
    );
    const resolved = resolveDispatchConfig(cfg, 'Eval');
    const mounts = buildEvalModeMounts(cfg, resolved);
    assert.deepEqual(mounts, [
      { host: '/tmp/issues', guest: EVAL_MODE_ISSUES_GUEST_PATH, readonly: true },
      { host: '/tmp/logs', guest: EVAL_MODE_LOGS_GUEST_PATH, readonly: true },
    ]);
  });

  it('skips the tracker mount when tracker.root is unset', () => {
    // Defense in depth: the local-tracker loader always pins tracker.root,
    // but a hand-built ServiceConfig (or a future non-local tracker) might
    // leave it null. The eval-mode mounts then degrade to whichever roots
    // are available rather than passing a null host path to the VM mount.
    const cfg = buildServiceConfig(
      {
        // Non-local tracker — parser does not auto-default tracker.root.
        tracker: { kind: 'remote' },
        logs: { root: '/tmp/logs' },
        acp: { adapter: 'claude' },
        states: {
          Eval: { role: 'active', eval_mode: true },
          Done: { role: 'terminal' },
          Triage: { role: 'holding' },
        },
      },
      '/tmp/WORKFLOW.md',
    );
    const resolved = resolveDispatchConfig(cfg, 'Eval');
    const mounts = buildEvalModeMounts(cfg, resolved);
    assert.deepEqual(mounts, [
      { host: '/tmp/logs', guest: EVAL_MODE_LOGS_GUEST_PATH, readonly: true },
    ]);
  });
});
