// Unit tests for the pure bake-key logic. The bake hash is content-addressed:
// it must change when the Smolfile OR any baked-in host dir (scripts/, copied
// into the image by [dev].init) changes, and must be order-independent over the
// baked inputs. parseBakeVolumeHostPaths feeds the latter from the Smolfile's
// [dev].volumes without a TOML dependency.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeBakeHash, parseBakeVolumeHostPaths } from '../src/reconciler/bake-plan.js';

const SMOL = Buffer.from('image = "node:24"\n[dev]\nvolumes = ["./scripts:/opt/symphony-src:ro"]\n');

describe('computeBakeHash', () => {
  it('is deterministic for the same inputs', () => {
    const a = computeBakeHash(SMOL, [{ path: './scripts', digest: 'abc' }]);
    const b = computeBakeHash(SMOL, [{ path: './scripts', digest: 'abc' }]);
    assert.equal(a, b);
  });

  it('changes when the Smolfile content changes', () => {
    const a = computeBakeHash(SMOL);
    const b = computeBakeHash(Buffer.from(SMOL.toString() + '# tweak\n'));
    assert.notEqual(a, b);
  });

  it('changes when a baked input digest changes (the scripts/ content guard)', () => {
    const before = computeBakeHash(SMOL, [{ path: './scripts', digest: 'v1' }]);
    const after = computeBakeHash(SMOL, [{ path: './scripts', digest: 'v2' }]);
    assert.notEqual(before, after);
  });

  it('differs from the no-baked-inputs hash (folding is observable)', () => {
    assert.notEqual(computeBakeHash(SMOL), computeBakeHash(SMOL, [{ path: './scripts', digest: 'x' }]));
  });

  it('is order-independent over baked inputs', () => {
    const one = computeBakeHash(SMOL, [
      { path: './a', digest: '1' },
      { path: './b', digest: '2' },
    ]);
    const two = computeBakeHash(SMOL, [
      { path: './b', digest: '2' },
      { path: './a', digest: '1' },
    ]);
    assert.equal(one, two);
  });
});

describe('parseBakeVolumeHostPaths', () => {
  it('extracts the host portion of a single volume spec', () => {
    assert.deepEqual(parseBakeVolumeHostPaths('volumes = ["./scripts:/opt/symphony-src:ro"]'), ['./scripts']);
  });

  it('handles multiple entries and a missing :ro suffix', () => {
    assert.deepEqual(
      parseBakeVolumeHostPaths('volumes = ["./scripts:/opt/symphony-src:ro", "./extra:/opt/extra"]'),
      ['./scripts', './extra'],
    );
  });

  it('tolerates a multi-line array and indentation', () => {
    const text = '[dev]\n  volumes = [\n    "./scripts:/opt/symphony-src:ro",\n  ]\n';
    assert.deepEqual(parseBakeVolumeHostPaths(text), ['./scripts']);
  });

  it('returns [] when there is no volumes key', () => {
    assert.deepEqual(parseBakeVolumeHostPaths('image = "node:24"\n[dev]\ninit = ["echo hi"]\n'), []);
  });

  it('returns [] for an empty volumes array (the baked-image runtime config)', () => {
    assert.deepEqual(parseBakeVolumeHostPaths('volumes = []'), []);
  });
});
