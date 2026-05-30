import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  scaffoldWorkflow,
  ScaffoldError,
  SCAFFOLD_WORKFLOW_TEMPLATE,
} from '../src/scaffold.js';
import { loadWorkflow } from '../src/workflow-loader.js';

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'symphony-scaffold-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('scaffold', () => {
  it('writes WORKFLOW.md at the requested path', async () => {
    await withTempDir(async (dir) => {
      const target = path.join(dir, 'WORKFLOW.md');
      const result = await scaffoldWorkflow({ workflowPath: target });
      assert.equal(result.workflowPath, target);
      const written = await readFile(target, 'utf8');
      assert.equal(written, SCAFFOLD_WORKFLOW_TEMPLATE);
    });
  });

  it('creates the parent directory if it does not exist', async () => {
    await withTempDir(async (dir) => {
      const target = path.join(dir, 'nested', 'sub', 'WORKFLOW.md');
      await scaffoldWorkflow({ workflowPath: target });
      const written = await readFile(target, 'utf8');
      assert.ok(written.length > 0);
    });
  });

  it('refuses to overwrite an existing file', async () => {
    await withTempDir(async (dir) => {
      const target = path.join(dir, 'WORKFLOW.md');
      await writeFile(target, 'do not clobber');
      await assert.rejects(
        () => scaffoldWorkflow({ workflowPath: target }),
        (err) => err instanceof ScaffoldError && err.code === 'scaffold_file_exists',
      );
      // Original contents survive the failed write.
      const after = await readFile(target, 'utf8');
      assert.equal(after, 'do not clobber');
    });
  });

  it('rejects relative paths', async () => {
    await assert.rejects(
      () => scaffoldWorkflow({ workflowPath: 'WORKFLOW.md' }),
      (err) => err instanceof ScaffoldError && err.code === 'scaffold_relative_path',
    );
  });

  it('produces a workflow file that the loader and validator accept', async () => {
    await withTempDir(async (dir) => {
      const target = path.join(dir, 'WORKFLOW.md');
      await scaffoldWorkflow({ workflowPath: target });
      // Should not throw — every required block (states with active/terminal/
      // holding roles, tracker, adapter) must be populated by the scaffold so
      // the operator can iterate on the file without first fixing parse errors.
      const { definition: def, config: cfg } = await loadWorkflow(target);
      assert.equal(cfg.tracker.kind, 'local');
      assert.ok(cfg.states['Todo'], 'scaffold declares a Todo state');
      assert.equal(cfg.states['Todo']!.role, 'active');
      assert.equal(cfg.states['Done']!.role, 'terminal');
      assert.equal(cfg.states['Triage']!.role, 'holding');
      assert.equal(cfg.acp.adapter, 'claude');
      // Prompt body must include the issue identifier Liquid hook so the
      // dispatched agent sees which issue it is working on.
      assert.match(def.prompt_template, /\{\{\s*issue\.identifier\s*\}\}/);
      // Scaffold deliberately leaves the gondolin image unset; the parser allows
      // it (the operator pins gondolin.image to a built image before the first
      // dispatch — the runner fails fast at boot if it's still unset).
      assert.equal(cfg.gondolin.image, null);
    });
  });
});
