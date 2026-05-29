// hashPathContent feeds the bake cache key with the content of host dirs baked
// into the image (scripts/). Because the Smolfile copies them with `cp -a`, the
// digest must register not just file bytes but also metadata `cp -a` preserves:
// file mode (chmod +x), directory structure (an added empty dir), and symlinks
// (preserved, not followed). Otherwise a stale `.smolmachine` would be reused.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, chmod, mkdir, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { hashPathContent } from '../src/reconciler/bake.js';

describe('hashPathContent', () => {
  let dir: string;
  before(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'symphony-hashdir-'));
    await writeFile(path.join(dir, 'a.mjs'), 'console.log(1)\n');
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('is deterministic and changes when file bytes change', async () => {
    const h1 = await hashPathContent(dir);
    assert.equal(await hashPathContent(dir), h1);
    await writeFile(path.join(dir, 'a.mjs'), 'console.log(2)\n');
    assert.notEqual(await hashPathContent(dir), h1);
  });

  it('changes on a metadata-only chmod (cp -a preserves mode)', async () => {
    const before = await hashPathContent(dir);
    await chmod(path.join(dir, 'a.mjs'), 0o755);
    assert.notEqual(await hashPathContent(dir), before);
  });

  it('changes when an empty directory is added', async () => {
    const before = await hashPathContent(dir);
    await mkdir(path.join(dir, 'emptydir'));
    assert.notEqual(await hashPathContent(dir), before);
  });

  it('changes when a symlink is added (and hashes the target, not the file it points to)', async () => {
    const before = await hashPathContent(dir);
    await symlink('a.mjs', path.join(dir, 'link.mjs'));
    assert.notEqual(await hashPathContent(dir), before);
  });

  it('follows a symlinked ROOT path (smolvm resolves it; cp -a copies its contents)', async () => {
    const real = await mkdtemp(path.join(os.tmpdir(), 'symphony-hashreal-'));
    await writeFile(path.join(real, 'vm-agent.mjs'), 'v1\n');
    const link = path.join(os.tmpdir(), `symphony-hashlink-${path.basename(real)}`);
    await symlink(real, link);
    try {
      // Hashing the symlinked root equals hashing the resolved dir (root followed).
      assert.equal(await hashPathContent(link), await hashPathContent(real));
      // Editing the target through the symlink changes the digest (not stale).
      const before = await hashPathContent(link);
      await writeFile(path.join(real, 'vm-agent.mjs'), 'v2\n');
      assert.notEqual(await hashPathContent(link), before);
    } finally {
      await rm(link, { force: true });
      await rm(real, { recursive: true, force: true });
    }
  });

  it('yields a stable marker for a missing path', async () => {
    const a = await hashPathContent(path.join(dir, 'does-not-exist'));
    const b = await hashPathContent(path.join(dir, 'also-missing'));
    // both absent → both hash the absent marker over an empty rel, so equal
    assert.equal(a, b);
  });
});
