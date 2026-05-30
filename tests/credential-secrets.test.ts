// Unit tests for the dormant `credential-secrets` module (Phase 2 of the
// Gondolin migration). No VM, no /dev/kvm, no network — fakes only.
//
// Coverage:
//   - per-adapter hooks-config shape (allowedHosts, token-shaped placeholder,
//     secret name, billing-tell onResponse, opencode onRequest present)
//   - the registry push-to-all fan-out incl. a torn-down manager (no throw; the
//     survivor still gets updated) and seed-on-register from the cache
//   - the opencode onRequest path-allowlist (GET /copilot_internal/v2/token
//     allowed; other api.github.com paths/methods blocked; other hosts pass)

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { SecretManager, SecretManagerEntry } from '@earendil-works/gondolin';
import {
  buildAdapterCredentialSpecs,
  buildAdapterHooksConfig,
  makeGithubExchangePathGuard,
  makeBillingTellResponseHook,
  CredentialSecretRegistry,
  type AdapterCredentialSpec,
} from '../src/agent/credential-secrets.js';
import type { TokenInfo } from '../src/agent/credential-proxy.js';

// --- fakes -----------------------------------------------------------------

interface FakeManager extends SecretManager {
  readonly updates: { name: string; value: string | undefined }[];
  /** When true, every updateSecret call throws (simulates a torn-down VM). */
  dead: boolean;
}

function makeFakeManager(): FakeManager {
  const updates: { name: string; value: string | undefined }[] = [];
  return {
    updates,
    dead: false,
    listSecrets(): SecretManagerEntry[] {
      return [];
    },
    updateSecret(name, options): void {
      if (this.dead) throw new Error('manager torn down');
      updates.push({ name, value: options.value });
    },
    deleteSecret(): void {},
  };
}

/** Spec builder with stubbed token reads / refreshers — never touches disk. */
function stubSpecs(opts: {
  claudeRefresher?: () => Promise<void>;
  copilotExchange?: (t: string) => Promise<TokenInfo>;
} = {}): Record<string, AdapterCredentialSpec> {
  return buildAdapterCredentialSpecs({
    // Point every credential path at a guaranteed-missing file so readToken
    // resolves to null (no real host creds read in unit tests).
    claudeCredentialsPath: '/nonexistent/claude.json',
    codexCredentialsPath: '/nonexistent/codex.json',
    opencodeCredentialsPath: '/nonexistent/opencode.json',
    lockPath: '/tmp/symphony-credsecrets-test.lock',
    // Never spawn flock(1): the lock acquirer is a no-op release.
    lockAcquire: async () => async () => {},
    claudeRefresher: opts.claudeRefresher ?? (async () => {}),
    copilotExchange: opts.copilotExchange,
  });
}

// --- per-adapter hooks-config shape ----------------------------------------

describe('buildAdapterHooksConfig — per-adapter shape', () => {
  it('claude → api.anthropic.com with an sk-ant- placeholder and billing onResponse', () => {
    const specs = stubSpecs();
    const cfg = buildAdapterHooksConfig(specs.claude!);
    assert.equal(cfg.adapterId, 'claude');
    assert.equal(cfg.secretName, 'ANTHROPIC_AUTH_TOKEN');
    assert.deepEqual(cfg.options.allowedHosts, ['api.anthropic.com']);
    const secret = cfg.options.secrets!['ANTHROPIC_AUTH_TOKEN']!;
    assert.deepEqual(secret.hosts, ['api.anthropic.com']);
    assert.equal(secret.value, '', 'initial value is empty; seeded via updateSecret');
    const placeholder = typeof secret.placeholder === 'function' ? secret.placeholder() : secret.placeholder;
    assert.ok(placeholder!.startsWith('sk-ant-'), `placeholder ${placeholder} should be token-shaped`);
    assert.equal(typeof cfg.options.onResponse, 'function');
    assert.equal(cfg.options.onRequest, undefined, 'claude has no onRequest guard');
  });

  it('codex → chatgpt.com with a JWT-shaped placeholder (native ChatGPT-OAuth, far-future exp)', () => {
    const specs = stubSpecs();
    const cfg = buildAdapterHooksConfig(specs.codex!);
    assert.equal(cfg.secretName, 'OPENAI_API_KEY');
    assert.deepEqual(cfg.options.allowedHosts, ['chatgpt.com']);
    const secret = cfg.options.secrets!['OPENAI_API_KEY']!;
    const placeholder = typeof secret.placeholder === 'function' ? secret.placeholder() : secret.placeholder;
    // codex runs in its native ChatGPT-OAuth mode reading tokens.access_token as
    // its bearer, so the placeholder must be a JWT (header.payload.signature) with a
    // far-future `exp` — otherwise codex treats it as expired and tries to refresh.
    const segs = placeholder!.split('.');
    assert.equal(segs.length, 3, `placeholder ${placeholder} should be JWT-shaped`);
    const payload = JSON.parse(Buffer.from(segs[1]!, 'base64url').toString('utf8')) as { exp: number };
    assert.ok(payload.exp > 4_000_000_000, 'far-future exp ⇒ no refresh');
    assert.equal(cfg.options.onRequest, undefined, 'codex has no onRequest guard');
  });

  it('opencode → githubcopilot.com + api.github.com (host-mint) with an onRequest guard', () => {
    const specs = stubSpecs();
    const cfg = buildAdapterHooksConfig(specs.opencode!);
    assert.equal(cfg.secretName, 'OPENCODE_PROXY_TOKEN');
    assert.deepEqual(
      cfg.options.allowedHosts,
      ['api.githubcopilot.com', 'api.github.com'],
      'inference host + the host-mint exchange host',
    );
    const secret = cfg.options.secrets!['OPENCODE_PROXY_TOKEN']!;
    const placeholder = typeof secret.placeholder === 'function' ? secret.placeholder() : secret.placeholder;
    assert.ok(placeholder!.startsWith('gho_'), `placeholder ${placeholder} should be token-shaped`);
    assert.equal(typeof cfg.options.onRequest, 'function', 'opencode has the path-allowlist guard');
  });
});

// --- onRequest path-allowlist ----------------------------------------------

describe('makeGithubExchangePathGuard — durable-token-oracle guard', () => {
  const guard = makeGithubExchangePathGuard();

  it('permits GET /copilot_internal/v2/token on api.github.com', () => {
    const out = guard(new Request('https://api.github.com/copilot_internal/v2/token', { method: 'GET' }));
    assert.equal(out, undefined, 'permitted request passes through (returns void)');
  });

  it('blocks a different path on api.github.com', () => {
    const out = guard(new Request('https://api.github.com/user', { method: 'GET' }));
    assert.ok(out instanceof Response);
    assert.equal((out as Response).status, 403);
  });

  it('blocks a non-GET method on the exchange path', () => {
    const out = guard(new Request('https://api.github.com/copilot_internal/v2/token', { method: 'POST' }));
    assert.ok(out instanceof Response);
    assert.equal((out as Response).status, 403);
  });

  it('blocks a repo-contents path (would otherwise spend the real GitHub token)', () => {
    const out = guard(new Request('https://api.github.com/repos/o/r/contents/secret', { method: 'GET' }));
    assert.ok(out instanceof Response);
    assert.equal((out as Response).status, 403);
  });

  it('blocks a query-string variant of the exchange path (codex review)', () => {
    const out = guard(new Request('https://api.github.com/copilot_internal/v2/token?x=1', { method: 'GET' }));
    assert.ok(out instanceof Response);
    assert.equal((out as Response).status, 403);
  });

  it('leaves other hosts untouched', () => {
    const out = guard(new Request('https://api.githubcopilot.com/chat/completions', { method: 'POST' }));
    assert.equal(out, undefined);
  });
});

// --- onResponse billing-tell -----------------------------------------------

describe('makeBillingTellResponseHook', () => {
  it('does not throw and returns void regardless of headers', () => {
    const hook = makeBillingTellResponseHook('claude', ['anthropic-ratelimit-unified-5h-status']);
    const res = new Response(null, {
      headers: { 'anthropic-ratelimit-unified-5h-status': 'allowed' },
    });
    const out = hook(res, new Request('https://api.anthropic.com/v1/messages'));
    assert.equal(out, undefined);
  });
});

// --- registry fan-out (§4.3) -----------------------------------------------

function makeRegistry(opts: {
  tokens: Partial<Record<string, TokenInfo | null>>;
  refreshed?: () => void;
} = { tokens: {} }): CredentialSecretRegistry {
  return new CredentialSecretRegistry({
    readToken: async (adapterId) => opts.tokens[adapterId] ?? null,
    refresh: async () => {
      opts.refreshed?.();
    },
    // Deterministic: no real timers fire during the test.
    setTimer: () => ({}) as unknown as NodeJS.Timeout,
    clearTimer: () => {},
    now: () => 1_000_000,
    refreshMarginMs: 60_000,
  });
}

describe('CredentialSecretRegistry — fan-out', () => {
  it('seeds a freshly-registered manager from the read token', async () => {
    const reg = makeRegistry({ tokens: { claude: { accessToken: 'tok-A', expiresAtMs: null } } });
    const m = makeFakeManager();
    await reg.register({ manager: m, secretName: 'ANTHROPIC_AUTH_TOKEN', adapterId: 'claude' });
    assert.equal(reg.size(), 1);
    assert.deepEqual(m.updates, [{ name: 'ANTHROPIC_AUTH_TOKEN', value: 'tok-A' }]);
  });

  it('pushToAll updates every live manager for the adapter', async () => {
    const reg = makeRegistry({ tokens: { claude: { accessToken: 'seed', expiresAtMs: null } } });
    const m1 = makeFakeManager();
    const m2 = makeFakeManager();
    await reg.register({ manager: m1, secretName: 'ANTHROPIC_AUTH_TOKEN', adapterId: 'claude' });
    await reg.register({ manager: m2, secretName: 'ANTHROPIC_AUTH_TOKEN', adapterId: 'claude' });
    reg.pushToAll('claude', 'rotated');
    assert.equal(m1.updates.at(-1)!.value, 'rotated');
    assert.equal(m2.updates.at(-1)!.value, 'rotated');
  });

  it('does not push to managers of a different adapter', async () => {
    const reg = makeRegistry({
      tokens: { claude: { accessToken: 'c', expiresAtMs: null }, codex: { accessToken: 'x', expiresAtMs: null } },
    });
    const claudeM = makeFakeManager();
    const codexM = makeFakeManager();
    await reg.register({ manager: claudeM, secretName: 'ANTHROPIC_AUTH_TOKEN', adapterId: 'claude' });
    await reg.register({ manager: codexM, secretName: 'OPENAI_API_KEY', adapterId: 'codex' });
    reg.pushToAll('claude', 'only-claude');
    assert.equal(claudeM.updates.at(-1)!.value, 'only-claude');
    // codex manager only ever saw its seed value, never the claude push.
    assert.ok(!codexM.updates.some((u) => u.value === 'only-claude'));
  });

  it('a torn-down manager mid-push does not throw and is dropped; the survivor still updates', async () => {
    const reg = makeRegistry({ tokens: { claude: { accessToken: 'seed', expiresAtMs: null } } });
    const dead = makeFakeManager();
    const alive = makeFakeManager();
    await reg.register({ manager: dead, secretName: 'ANTHROPIC_AUTH_TOKEN', adapterId: 'claude' });
    await reg.register({ manager: alive, secretName: 'ANTHROPIC_AUTH_TOKEN', adapterId: 'claude' });
    assert.equal(reg.size(), 2);
    dead.dead = true; // its VM was torn down between register and the next push

    assert.doesNotThrow(() => reg.pushToAll('claude', 'rotated'));
    // The dead manager was dropped from the registry...
    assert.equal(reg.size(), 1);
    // ...and the survivor still received the rotated value.
    assert.equal(alive.updates.at(-1)!.value, 'rotated');
  });

  it('a VM registered AFTER a rotation seeds from the latest cached value (never stale)', async () => {
    // Cold read returns null, so register would otherwise seed empty. A prior
    // pushToAll populated the cache; the late VM must observe it.
    const reg = makeRegistry({ tokens: { claude: null } });
    reg.pushToAll('claude', 'rotated-before-this-vm');
    const late = makeFakeManager();
    await reg.register({ manager: late, secretName: 'ANTHROPIC_AUTH_TOKEN', adapterId: 'claude' });
    assert.equal(
      late.updates.at(-1)!.value,
      'rotated-before-this-vm',
      'late VM seeded from the cached value, not stale/empty',
    );
  });

  it('deregister drops the manager so a later push does not reach it', async () => {
    const reg = makeRegistry({ tokens: { claude: { accessToken: 'seed', expiresAtMs: null } } });
    const m = makeFakeManager();
    const handle = await reg.register({ manager: m, secretName: 'ANTHROPIC_AUTH_TOKEN', adapterId: 'claude' });
    handle.deregister();
    assert.equal(reg.size(), 0);
    reg.pushToAll('claude', 'after-deregister');
    assert.ok(!m.updates.some((u) => u.value === 'after-deregister'));
  });

  it('refreshAdapter drives the refresh then fans the re-read token out', async () => {
    let refreshed = 0;
    const reg = new CredentialSecretRegistry({
      readToken: async () => ({ accessToken: 'post-refresh', expiresAtMs: null }),
      refresh: async () => {
        refreshed += 1;
      },
      setTimer: () => ({}) as unknown as NodeJS.Timeout,
      clearTimer: () => {},
      now: () => 0,
    });
    const m = makeFakeManager();
    await reg.register({ manager: m, secretName: 'ANTHROPIC_AUTH_TOKEN', adapterId: 'claude' });
    await reg.refreshAdapter('claude');
    assert.equal(refreshed, 1);
    assert.equal(m.updates.at(-1)!.value, 'post-refresh');
  });

  it('register does not clobber a rotation that lands during its async read (codex review)', async () => {
    // readToken stays pending until we unblock it, simulating a slow host read.
    let resolveRead!: (t: TokenInfo | null) => void;
    const readGate = new Promise<TokenInfo | null>((r) => {
      resolveRead = r;
    });
    const reg = new CredentialSecretRegistry({
      readToken: () => readGate,
      refresh: async () => {},
      setTimer: () => ({}) as unknown as NodeJS.Timeout,
      clearTimer: () => {},
      now: () => 0,
    });
    const m = makeFakeManager();
    // register() inserts the entry, then suspends on the slow read.
    const registering = reg.register({
      manager: m,
      secretName: 'ANTHROPIC_AUTH_TOKEN',
      adapterId: 'claude',
    });
    // A rotation lands DURING the read and applies the fresh value to the live entry.
    reg.pushToAll('claude', 'fresh-rotated');
    // Now the read resolves with a STALE value; register must NOT apply it over the
    // rotation (doing so would regress the value and revoke the fresh token).
    resolveRead({ accessToken: 'stale-read', expiresAtMs: null });
    await registering;
    assert.equal(m.updates.at(-1)!.value, 'fresh-rotated');
    assert.ok(!m.updates.some((u) => u.value === 'stale-read'), 'stale read must not be applied');
    assert.equal(reg.size(), 1);
  });

  it('a rotation for a DIFFERENT adapter during register still seeds the cold entry (codex review)', async () => {
    // Per-adapter cacheSeq: a codex push must not make a claude register skip its seed.
    let resolveRead!: (t: TokenInfo | null) => void;
    const readGate = new Promise<TokenInfo | null>((r) => {
      resolveRead = r;
    });
    const reg = new CredentialSecretRegistry({
      readToken: () => readGate,
      refresh: async () => {},
      setTimer: () => ({}) as unknown as NodeJS.Timeout,
      clearTimer: () => {},
      now: () => 0,
    });
    const claudeM = makeFakeManager();
    const registering = reg.register({
      manager: claudeM,
      secretName: 'ANTHROPIC_AUTH_TOKEN',
      adapterId: 'claude',
    });
    // An UNRELATED rotation (codex) lands during the claude read.
    reg.pushToAll('codex', 'codex-rotated');
    // The claude read resolves; its value must still be applied (the codex push
    // never touched the claude entry, so seeding must NOT be skipped).
    resolveRead({ accessToken: 'claude-seed', expiresAtMs: null });
    await registering;
    assert.equal(claudeM.updates.at(-1)!.value, 'claude-seed');
  });
});
