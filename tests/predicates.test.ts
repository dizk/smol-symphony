// Pure-evaluator + adapter tests for `if:` predicates (issue 96).
//
// `evaluatePredicate` is now pure aside from the injected `PredicateEnv`;
// string-truthy predicates never touch the env, branch_exists / file_present
// always route through it. The executor's unwired-env fallback throws with a
// clear diagnostic on the IO predicates so missing wiring shows up on the
// action ledger.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { evaluatePredicate } from '../src/actions/predicates.js';
import { defaultPredicateEnv } from '../src/actions/predicate-env.js';
import { runActions } from '../src/actions/index.js';
import type { ActionContext, PredicateEnv } from '../src/actions/types.js';

function baseCtx(workspace: string): ActionContext {
  return {
    identifier: '42',
    workspace,
    branch: 'agent/42',
    base_branch: 'main',
    issue_title: 'title',
    issue_body: 'body',
    repo: 'org/repo',
    pr_title: '42: title',
    pr_body_file: path.join(workspace, '.body.md'),
  };
}

// A stub env that records calls so tests can assert the predicate evaluator
// routes through it (and only when the predicate shape requires it).
function stubEnv(over: Partial<PredicateEnv> = {}): PredicateEnv & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async branchExists(ref) {
      calls.push(`branchExists:${ref}`);
      return over.branchExists ? over.branchExists(ref, '') : false;
    },
    async pathExists(abs) {
      calls.push(`pathExists:${abs}`);
      return over.pathExists ? over.pathExists(abs) : false;
    },
  };
}

describe('evaluatePredicate (pure)', () => {
  it('returns true for null/undefined (no `if:` → always run)', async () => {
    const env = stubEnv();
    assert.equal(await evaluatePredicate(null, baseCtx('/ws'), '/ws', env), true);
    assert.equal(await evaluatePredicate(undefined, baseCtx('/ws'), '/ws', env), true);
    assert.deepEqual(env.calls, []);
  });

  it('evaluates string truthiness without touching the env', async () => {
    const env = stubEnv();
    const ctx = baseCtx('/ws');
    assert.equal(await evaluatePredicate('$repo', ctx, '/ws', env), true);
    assert.equal(await evaluatePredicate('$repo', { ...ctx, repo: null }, '/ws', env), false);
    assert.equal(await evaluatePredicate('', ctx, '/ws', env), false);
    assert.deepEqual(env.calls, []);
  });

  it('routes branch_exists through the env', async () => {
    const env = stubEnv({ async branchExists(ref) { return ref === 'main'; } });
    const ctx = baseCtx('/ws');
    assert.equal(await evaluatePredicate({ branch_exists: '$base_branch' }, ctx, '/ws', env), true);
    assert.equal(await evaluatePredicate({ branch_exists: 'nope' }, ctx, '/ws', env), false);
    assert.deepEqual(env.calls, ['branchExists:main', 'branchExists:nope']);
  });

  it('resolves file_present to an absolute path and routes through the env', async () => {
    const env = stubEnv({ async pathExists(abs) { return abs === '/ws/Smolfile'; } });
    const ctx = baseCtx('/ws');
    assert.equal(await evaluatePredicate({ file_present: 'Smolfile' }, ctx, '/ws', env), true);
    assert.equal(await evaluatePredicate({ file_present: '/absolute/missing' }, ctx, '/ws', env), false);
    assert.deepEqual(env.calls, ['pathExists:/ws/Smolfile', 'pathExists:/absolute/missing']);
  });
});

describe('defaultPredicateEnv (adapter)', () => {
  it('pathExists returns true for files and directories, false for missing paths', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'symphony-predicate-'));
    try {
      const subdir = path.join(dir, 'sub');
      await mkdir(subdir);
      const file = path.join(dir, 'file.md');
      await writeFile(file, 'x', 'utf8');
      assert.equal(await defaultPredicateEnv.pathExists(file), true);
      assert.equal(await defaultPredicateEnv.pathExists(subdir), true);
      assert.equal(await defaultPredicateEnv.pathExists(path.join(dir, 'missing')), false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('action executor: unwired predicateEnv', () => {
  it('still evaluates string-truthy predicates when no predicateEnv is wired', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'symphony-unwired-'));
    try {
      // `repo: null` → `if: $repo` is falsy → action is skipped. Without the
      // env in the picture this must still succeed; if string evaluation
      // erroneously routed through the unwired env, the action would error.
      const ctx: ActionContext = { ...baseCtx(dir), repo: null };
      const r = await runActions(
        [{ kind: 'push_branch', remote: 'origin', ref: '$branch', if: '$repo' }],
        { workspacePath: dir, ctx, snapshotId: 'actions:Done' },
      );
      assert.equal(r.ok, true);
      assert.equal(r.actions[0]!.state, 'done');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('surfaces a clear diagnostic on branch_exists when no predicateEnv is wired', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'symphony-unwired-'));
    try {
      const ctx = baseCtx(dir);
      const r = await runActions(
        [{ kind: 'push_branch', remote: 'origin', ref: '$branch', if: { branch_exists: '$base_branch' } }],
        { workspacePath: dir, ctx, snapshotId: 'actions:Done' },
      );
      assert.equal(r.ok, false);
      assert.match(r.reason ?? '', /branch_exists.*no predicateEnv/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('surfaces a clear diagnostic on file_present when no predicateEnv is wired', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'symphony-unwired-'));
    try {
      const ctx = baseCtx(dir);
      const r = await runActions(
        [{ kind: 'push_branch', remote: 'origin', ref: '$branch', if: { file_present: 'Smolfile' } }],
        { workspacePath: dir, ctx, snapshotId: 'actions:Done' },
      );
      assert.equal(r.ok, false);
      assert.match(r.reason ?? '', /file_present.*no predicateEnv/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
