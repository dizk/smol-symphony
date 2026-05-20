import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { splitFrontMatter, buildServiceConfig, expandVar } from '../src/workflow.js';

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
        { tracker: { kind: 'local', root: '$SYM_DOES_NOT_EXIST' } },
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
    const cfg = buildServiceConfig({ tracker: { kind: 'local', root: '/tmp/issues' } }, '/tmp/WORKFLOW.md');
    assert.equal(cfg.polling.interval_ms, 30000);
    assert.equal(cfg.agent.max_concurrent_agents, 10);
    assert.equal(cfg.agent.max_turns, 20);
    // acp.command defaults to null so symphony auto-derives it from acp.adapter.
    assert.equal(cfg.acp.command, null);
    assert.equal(cfg.acp.adapter, 'claude');
    assert.equal(cfg.acp.shell, 'bash');
    // acp.model defaults to null: the adapter falls back to its own default model.
    assert.equal(cfg.acp.model, null);
  });

  it('parses acp.model and trims whitespace', () => {
    const cfg = buildServiceConfig(
      {
        tracker: { kind: 'local', root: '/tmp/issues' },
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
        acp: { adapter: 'claude', model: '   ' },
      },
      '/tmp/WORKFLOW.md',
    );
    assert.equal(cfg.acp.model, null);
  });
});
