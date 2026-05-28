// Issue 122: the sleep-cycle Reflect state. These tests pin the shipped
// WORKFLOW.md wiring — the Reflect/Dormant states, the resolved dispatch
// config (eval_mode + the read-only mounts it implies), and the `when "Reflect"`
// prompt branch — so a future edit can't silently drop the reflection loop or
// its guardrails.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseWorkflow, validateDispatch } from '../src/workflow.js';
import {
  resolveDispatchConfig,
  buildEvalModeMounts,
  EVAL_MODE_ISSUES_GUEST_PATH,
  EVAL_MODE_LOGS_GUEST_PATH,
} from '../src/agent/runner.js';
import { renderPrompt } from '../src/prompt.js';
import type { Issue } from '../src/types.js';

const WORKFLOW_PATH = fileURLToPath(new URL('../WORKFLOW.md', import.meta.url));

function loadShippedWorkflow() {
  const text = readFileSync(WORKFLOW_PATH, 'utf8');
  return parseWorkflow(text, WORKFLOW_PATH);
}

function reflectIssue(): Issue {
  return {
    id: 'sleep-cycle',
    identifier: 'sleep-cycle',
    title: 'Sleep cycle',
    description: 'Recurring reflection issue.',
    priority: null,
    state: 'Reflect',
    branch_name: null,
    url: null,
    labels: [],
    blocked_by: [],
    created_at: null,
    updated_at: null,
  };
}

describe('shipped WORKFLOW.md sleep-cycle states', () => {
  it('is a structurally valid workflow', () => {
    const { config } = loadShippedWorkflow();
    assert.equal(validateDispatch(config), null);
  });

  it('declares a Reflect active state with eval_mode and a Dormant-only exit', () => {
    const { config } = loadShippedWorkflow();
    const reflect = config.states.Reflect;
    assert.ok(reflect, 'Reflect state should be declared');
    assert.equal(reflect!.role, 'active');
    assert.equal(reflect!.eval_mode, true);
    // The reflector may only go dormant — a guardrail on the self-modifying loop.
    assert.deepEqual(reflect!.allowed_transitions, ['Dormant']);
  });

  it('declares Dormant as a holding state after Triage', () => {
    const { config } = loadShippedWorkflow();
    const dormant = config.states.Dormant;
    assert.ok(dormant, 'Dormant state should be declared');
    assert.equal(dormant!.role, 'holding');
    // Triage must precede Dormant so propose_issue + triage approve/discard
    // (both resolve the FIRST holding state) keep targeting Triage.
    const stateNames = Object.keys(config.states);
    assert.ok(
      stateNames.indexOf('Triage') < stateNames.indexOf('Dormant'),
      'Triage must be declared before Dormant',
    );
  });

  it('resolves Reflect dispatch config with eval_mode + the read-only mounts', () => {
    const { config } = loadShippedWorkflow();
    const resolved = resolveDispatchConfig(config, 'Reflect');
    assert.equal(resolved.eval_mode, true);
    assert.equal(resolved.adapter, 'claude');
    // Higher turn budget than the Todo implementer (10) / Review (6) states.
    assert.ok(resolved.max_turns > 10, `expected Reflect max_turns > 10, got ${resolved.max_turns}`);
    // eval_mode binds both read-only introspection mounts.
    const mounts = buildEvalModeMounts(config, resolved);
    const guests = mounts.map((m) => m.guest);
    assert.ok(guests.includes(EVAL_MODE_ISSUES_GUEST_PATH));
    assert.ok(guests.includes(EVAL_MODE_LOGS_GUEST_PATH));
    assert.ok(mounts.every((m) => m.readonly === true));
  });
});

describe('Reflect prompt branch', () => {
  it('renders the read → distil → propose loop and the guardrails', async () => {
    const { definition } = loadShippedWorkflow();
    const out = await renderPrompt({
      template: definition.prompt_template,
      issue: reflectIssue(),
      attempt: null,
    });
    // Identifies the reflector role and the read-only mounts it reads from.
    assert.match(out, /reflector/i);
    assert.match(out, /\/symphony\/issues/);
    assert.match(out, /\/symphony\/logs/);
    // The propose-into-Triage loop with provenance.
    assert.match(out, /propose_issue/);
    assert.match(out, /recurring/i);
    assert.match(out, /before\s*(?:→|->|and after)/i);
    // Guardrails: harness-only, never weaken the gates, transition to Dormant.
    assert.match(out, /harness/i);
    assert.match(out, /Review state/);
    assert.match(out, /Triage/);
    assert.match(out, /to_state:\s*"Dormant"/);
    // The Todo-only rebase step must NOT leak into the Reflect branch.
    assert.doesNotMatch(out, /git rebase origin\/main/);
  });
});
