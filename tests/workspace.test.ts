import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeWorkspaceKey, assertContained } from '../src/workspace.js';

describe('workspace', () => {
  it('sanitizes identifiers to allowed charset', () => {
    assert.equal(sanitizeWorkspaceKey('ABC-1'), 'ABC-1');
    assert.equal(sanitizeWorkspaceKey('A B C'), 'A_B_C');
    // Dots are part of the allowed set per §9.5; only the slashes are replaced.
    assert.equal(sanitizeWorkspaceKey('foo/../bar'), 'foo_.._bar');
  });

  it('rejects paths outside root', () => {
    assert.throws(() => assertContained('/tmp/root', '/tmp/other/dir'));
    assert.throws(() => assertContained('/tmp/root', '/tmp/root'));
  });

  it('accepts contained paths whose names start with two dots', () => {
    // Per the §9.5 containment fix: `..fix` is a perfectly legal contained directory name
    // even though `path.relative()` returns a string starting with the two characters `..`.
    assert.doesNotThrow(() => assertContained('/tmp/root', '/tmp/root/..fix'));
    assert.doesNotThrow(() => assertContained('/tmp/root', '/tmp/root/ABC-1'));
  });
});
