// Unit tests for the Phase 3 invariant guards (vm-guards.ts). No VM, no /dev/kvm,
// no network. The mount guard resolves symlinks via an injectable `realpath`
// (default `fs.realpathSync`); these tests inject a deterministic resolver — an
// identity for the lexical cases, a fake symlink map for the symlink-bypass case —
// so they stay hermetic and never touch the filesystem.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  assertNoCredentialMounts,
  CredentialMountError,
  stripCredentialEnv,
  stripCredentialTokenVars,
  isCredentialEnvName,
  isCredentialTokenName,
  canonicalizeHostPath,
} from '../src/agent/vm-guards.js';
import type { VmMount } from '../src/agent/vm-port.js';

const HOME = '/home/tester';

function mount(host: string, readonly = false): VmMount {
  return { host, guest: '/work', readonly };
}

describe('assertNoCredentialMounts', () => {
  // Identity realpath keeps the lexical cases hermetic (no fs touch); the symlink
  // case below injects a fake resolver.
  const opts = { homeDir: HOME, realpath: (p: string) => p };

  it('passes for a normal workspace mount under home', () => {
    assert.doesNotThrow(() =>
      assertNoCredentialMounts([mount('/home/tester/.symphony/workspaces/X')], opts),
    );
  });

  it('passes for a workspace outside home entirely', () => {
    assert.doesNotThrow(() => assertNoCredentialMounts([mount('/srv/work/repo')], opts));
  });

  it('throws for ~/.claude', () => {
    assert.throws(
      () => assertNoCredentialMounts([mount(path.join(HOME, '.claude'))], opts),
      CredentialMountError,
    );
  });

  it('throws for a file UNDER ~/.claude', () => {
    assert.throws(
      () => assertNoCredentialMounts([mount(path.join(HOME, '.claude', '.credentials.json'))], opts),
      (err: unknown) => err instanceof CredentialMountError && err.deniedUnder === path.join(HOME, '.claude'),
    );
  });

  it('throws for ~/.codex', () => {
    assert.throws(
      () => assertNoCredentialMounts([mount(path.join(HOME, '.codex', 'auth.json'))], opts),
      CredentialMountError,
    );
  });

  it('throws for the home directory root itself', () => {
    assert.throws(
      () => assertNoCredentialMounts([mount(HOME)], opts),
      (err: unknown) => err instanceof CredentialMountError && err.deniedUnder === HOME,
    );
  });

  it('throws for a tilde-expanded ~/.config mount', () => {
    assert.throws(() => assertNoCredentialMounts([mount('~/.config/opencode')], opts), CredentialMountError);
  });

  it('throws for the opencode auth dir (~/.local/share/opencode)', () => {
    assert.throws(
      () => assertNoCredentialMounts([mount(path.join(HOME, '.local', 'share', 'opencode'))], opts),
      CredentialMountError,
    );
  });

  it('throws for ~/.ssh', () => {
    assert.throws(() => assertNoCredentialMounts([mount(path.join(HOME, '.ssh'))], opts), CredentialMountError);
  });

  it('a READ-ONLY credential mount is NOT exempt', () => {
    assert.throws(
      () => assertNoCredentialMounts([mount(path.join(HOME, '.claude', '.credentials.json'), true)], opts),
      CredentialMountError,
    );
  });

  it('catches a symlink mount source whose target is a credential dir (codex review)', () => {
    // Lexically /tmp/codex-link is innocuous; its symlink target is ~/.codex. A
    // lexical-only guard would pass it while Gondolin mounts the resolved tree.
    const link = '/tmp/codex-link';
    const realpath = (p: string) => (p === link ? path.join(HOME, '.codex') : p);
    assert.throws(
      () => assertNoCredentialMounts([mount(link)], { homeDir: HOME, realpath }),
      CredentialMountError,
    );
  });

  it('catches a mount of the REAL home root when home is symlinked (codex review)', () => {
    // /home/tester is a symlink to /data/tester; mounting the real root must still
    // be denied (it exposes every credential child), not just the lexical root.
    const realHome = '/data/tester';
    const realpath = (p: string) => (p === HOME ? realHome : p);
    assert.throws(
      () => assertNoCredentialMounts([mount(realHome)], { homeDir: HOME, realpath }),
      CredentialMountError,
    );
  });

  it('does not false-positive on a sibling with a credential-dir prefix', () => {
    // `~/.codexible` must not count as under `~/.codex`.
    assert.doesNotThrow(() =>
      assertNoCredentialMounts([mount(path.join(HOME, '.codexible', 'data'))], opts),
    );
  });

  it('honors an extra denylist entry', () => {
    assert.throws(
      () =>
        assertNoCredentialMounts([mount('/vault/secrets/db')], {
          homeDir: HOME,
          extraDenylist: ['/vault/secrets'],
        }),
      CredentialMountError,
    );
  });

  it('rejects mounting an ANCESTOR of a credential dir (codex review)', () => {
    // ~/.local/share is not itself denied, but it CONTAINS ~/.local/share/opencode;
    // mounting it would expose the credential tree. Bidirectional overlap catches it.
    assert.throws(
      () => assertNoCredentialMounts([mount(path.join(HOME, '.local', 'share'))], opts),
      CredentialMountError,
    );
  });

  it('throws on the FIRST offender in a mixed list', () => {
    const mounts = [mount('/srv/ok'), mount(path.join(HOME, '.codex')), mount('/srv/also-ok')];
    assert.throws(() => assertNoCredentialMounts(mounts, opts), CredentialMountError);
  });
});

describe('canonicalizeHostPath', () => {
  it('expands a bare ~', () => {
    assert.equal(canonicalizeHostPath('~', HOME), HOME);
  });
  it('expands ~/sub', () => {
    assert.equal(canonicalizeHostPath('~/.codex', HOME), path.join(HOME, '.codex'));
  });
  it('collapses .. lexically', () => {
    assert.equal(canonicalizeHostPath('/a/b/../c', HOME), '/a/c');
  });
});

describe('stripCredentialEnv', () => {
  it('removes every adapter token var', () => {
    const env = {
      ANTHROPIC_AUTH_TOKEN: 'sk-ant-real',
      OPENAI_API_KEY: 'sk-real',
      OPENCODE_PROXY_TOKEN: 'gho_real',
      PATH: '/usr/bin',
    };
    assert.deepEqual(stripCredentialEnv(env), { PATH: '/usr/bin' });
  });

  it('removes the *_API_KEY / *_TOKEN / *_SECRET families', () => {
    const env = {
      FOO_API_KEY: 'a',
      BAR_TOKEN: 'b',
      BAZ_SECRET: 'c',
      QUUX: 'keep',
    };
    assert.deepEqual(stripCredentialEnv(env), { QUUX: 'keep' });
  });

  it('removes the named vendor families and GitHub durable tokens', () => {
    const env = {
      ANTHROPIC_MODEL: 'opus',
      OPENAI_BASE_URL: 'http://x',
      OPENCODE_PROXY_BASE_URL: 'http://y',
      COPILOT_GITHUB_TOKEN: 'gho_x',
      GITHUB_TOKEN: 'ghp_x',
      GH_TOKEN: 'ghp_y',
      LANG: 'C',
    };
    // ANTHROPIC_*/OPENAI_*/OPENCODE_*/COPILOT_*/GITHUB_*/GH_* are all dropped wholesale.
    assert.deepEqual(stripCredentialEnv(env), { LANG: 'C' });
  });

  it('keeps innocuous vars untouched', () => {
    const env = { HOME: '/root', TERM: 'xterm', SYMPHONY_ACP_URL: 'tcp://x:7000', NODE_ENV: 'production' };
    assert.deepEqual(stripCredentialEnv(env), env);
  });

  it('is case-insensitive on the name match', () => {
    assert.equal(isCredentialEnvName('openai_api_key'), true);
    assert.equal(isCredentialEnvName('Github_Token'), true);
    assert.equal(isCredentialEnvName('path'), false);
  });

  it('does not mutate the input', () => {
    const env = { OPENAI_API_KEY: 'x', PATH: '/bin' };
    const out = stripCredentialEnv(env);
    assert.deepEqual(env, { OPENAI_API_KEY: 'x', PATH: '/bin' });
    assert.notEqual(out, env);
  });
});

describe('stripCredentialTokenVars (runtime-env policy: keep vendor config, drop tokens)', () => {
  it('keeps vendor-prefixed CONFIG knobs but drops the actual token', () => {
    const env = {
      ANTHROPIC_MODEL: 'opus',
      ANTHROPIC_BASE_URL: 'http://proxy',
      OPENAI_BASE_URL: 'http://proxy/v1',
      ANTHROPIC_AUTH_TOKEN: 'sk-ant-real',
      OPENAI_API_KEY: 'sk-real',
      OPENCODE_PROXY_TOKEN: 'gho_real',
    };
    assert.deepEqual(stripCredentialTokenVars(env), {
      ANTHROPIC_MODEL: 'opus',
      ANTHROPIC_BASE_URL: 'http://proxy',
      OPENAI_BASE_URL: 'http://proxy/v1',
    });
  });

  it('isCredentialTokenName: token vars true, vendor config false', () => {
    assert.equal(isCredentialTokenName('ANTHROPIC_AUTH_TOKEN'), true);
    assert.equal(isCredentialTokenName('FOO_SECRET'), true);
    assert.equal(isCredentialTokenName('ANTHROPIC_MODEL'), false);
    assert.equal(isCredentialTokenName('OPENAI_BASE_URL'), false);
    // The strict boot-env policy DOES drop the vendor-prefixed config; the runtime
    // policy keeps it. This asymmetry is intentional.
    assert.equal(isCredentialEnvName('ANTHROPIC_MODEL'), true);
  });
});
