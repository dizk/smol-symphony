import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseFrontMatter,
  parseFrontMatterLenient,
  FrontMatterError,
} from '../src/util/frontmatter.js';

describe('frontmatter (strict)', () => {
  it('parses fields + body', () => {
    const r = parseFrontMatter('---\nfoo: 1\n---\nhello body');
    assert.deepEqual(r.fields, { foo: 1 });
    assert.equal(r.body, 'hello body');
    assert.equal(r.hadFence, true);
  });

  it('treats no leading fence as body-only with hadFence=false', () => {
    const r = parseFrontMatter('no front matter here');
    assert.deepEqual(r.fields, {});
    assert.equal(r.body, 'no front matter here');
    assert.equal(r.hadFence, false);
  });

  it('treats empty front matter as empty fields but hadFence=true', () => {
    const r = parseFrontMatter('---\n---\nbody');
    assert.deepEqual(r.fields, {});
    assert.equal(r.body, 'body');
    assert.equal(r.hadFence, true);
  });

  it('handles CRLF line endings', () => {
    const r = parseFrontMatter('---\r\nfoo: bar\r\n---\r\nhello');
    assert.deepEqual(r.fields, { foo: 'bar' });
    assert.equal(r.body, 'hello');
  });

  it('does not treat indented `---` inside YAML multiline as closing fence', () => {
    const text = [
      '---',
      'hooks:',
      '  after_create: |',
      '    echo a',
      '    ---',
      '    echo b',
      '---',
      'prompt body',
    ].join('\n');
    const r = parseFrontMatter(text);
    assert.equal((r.fields as any).hooks.after_create.trim(), 'echo a\n---\necho b');
    assert.equal(r.body, 'prompt body');
  });

  it('correctly decodes single-quoted string values (the regex parser dropped surrounding quotes literally)', () => {
    const r = parseFrontMatter("---\ntitle: 'hello: world'\n---\nbody");
    assert.equal(r.fields['title'], 'hello: world');
  });

  it('correctly decodes double-quoted string values with escaped characters', () => {
    const r = parseFrontMatter('---\ntitle: "he said \\"hi\\""\n---\nbody');
    assert.equal(r.fields['title'], 'he said "hi"');
  });

  it('decodes multiline scalars in front matter', () => {
    const text = ['---', 'title: |', '  line one', '  line two', '---', 'body'].join('\n');
    const r = parseFrontMatter(text);
    assert.equal(r.fields['title'], 'line one\nline two\n');
  });

  it('throws unterminated for missing closing fence', () => {
    try {
      parseFrontMatter('---\nfoo: 1\nmore content');
      assert.fail('expected throw');
    } catch (err) {
      assert.ok(err instanceof FrontMatterError);
      assert.equal((err as FrontMatterError).code, 'unterminated');
    }
  });

  it('throws invalid_yaml on malformed YAML', () => {
    try {
      parseFrontMatter('---\nfoo: [unclosed\n---\nbody');
      assert.fail('expected throw');
    } catch (err) {
      assert.ok(err instanceof FrontMatterError);
      assert.equal((err as FrontMatterError).code, 'invalid_yaml');
    }
  });

  it('throws not_a_map when front matter decodes to a non-map (array)', () => {
    try {
      parseFrontMatter('---\n- a\n- b\n---\nbody');
      assert.fail('expected throw');
    } catch (err) {
      assert.ok(err instanceof FrontMatterError);
      assert.equal((err as FrontMatterError).code, 'not_a_map');
    }
  });

  it('throws not_a_map when front matter decodes to a scalar', () => {
    try {
      parseFrontMatter('---\njust a string\n---\nbody');
      assert.fail('expected throw');
    } catch (err) {
      assert.ok(err instanceof FrontMatterError);
      assert.equal((err as FrontMatterError).code, 'not_a_map');
    }
  });
});

describe('frontmatter (lenient)', () => {
  it('mirrors strict parser on well-formed input', () => {
    const r = parseFrontMatterLenient('---\nfoo: 1\n---\nbody');
    assert.deepEqual(r.fields, { foo: 1 });
    assert.equal(r.body, 'body');
    assert.equal(r.hadFence, true);
  });

  it('falls back to body-only on unterminated front matter', () => {
    const r = parseFrontMatterLenient('---\nfoo: 1\nmore');
    assert.deepEqual(r.fields, {});
    assert.equal(r.body, '---\nfoo: 1\nmore');
    assert.equal(r.hadFence, false);
  });

  it('falls back to body-only on invalid YAML', () => {
    const r = parseFrontMatterLenient('---\nfoo: [unclosed\n---\nbody');
    assert.deepEqual(r.fields, {});
    assert.equal(r.hadFence, false);
  });

  it('falls back to body-only when front matter is not a map', () => {
    const r = parseFrontMatterLenient('---\n- a\n- b\n---\nbody');
    assert.deepEqual(r.fields, {});
    assert.equal(r.hadFence, false);
  });

  it('handles no front matter at all', () => {
    const r = parseFrontMatterLenient('plain text\nbody');
    assert.deepEqual(r.fields, {});
    assert.equal(r.body, 'plain text\nbody');
    assert.equal(r.hadFence, false);
  });
});

