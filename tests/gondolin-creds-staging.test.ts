// Unit tests for the per-adapter Gondolin fake-native-creds staging
// (gondolin-creds-staging.ts). Fakes only — no VM, no network, no real creds.
//
// The invariant under test: the staged files + env hold ONLY placeholders (plus,
// for codex, the non-secret account_id from an INJECTED host reader). No real
// access/refresh token may appear; a real-looking refresh token is NEVER emitted.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import {
  buildGondolinFakeCreds,
  extractClaudeIdentity,
  extractCodexAccountId,
  type HostIdentityReaders,
} from '../src/agent/gondolin-creds-staging.js';
import {
  assemblePlaceholderJwt,
  PLACEHOLDER_JWT_EXP_SECONDS,
} from '../src/agent/credential-secrets.js';

const JUNK_REFRESH = 'JUNK-PLACEHOLDER-REFRESH-not-a-real-token';

// Injected host readers: a fixed non-secret identity, NEVER a token.
const FAKE_ACCOUNT_ID = 'acct_test_98765';
function fakeReaders(overrides: Partial<HostIdentityReaders> = {}): HostIdentityReaders {
  return {
    readClaudeIdentity: async () => ({
      accountUuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      organizationUuid: 'ffffffff-0000-1111-2222-333333333333',
    }),
    readCodexAccountId: async () => FAKE_ACCOUNT_ID,
    ...overrides,
  };
}

// --- claude ----------------------------------------------------------------

describe('buildGondolinFakeCreds — claude', () => {
  it('stages .credentials.json with the placeholder bearer, junk refresh, far-future expiry', async () => {
    const placeholder = 'sk-ant-PLACEHOLDER-deadbeef';
    const out = await buildGondolinFakeCreds('claude', {
      placeholder,
      secretName: 'ANTHROPIC_AUTH_TOKEN',
      hostReaders: fakeReaders(),
    });

    assert.deepEqual(out.env, { ANTHROPIC_AUTH_TOKEN: placeholder });

    const creds = out.files.find((f) => f.guestPath === '/root/.claude/.credentials.json');
    assert.ok(creds, 'creds file present');
    assert.equal(creds!.mode, 0o600);
    const parsed = JSON.parse(creds!.content) as { claudeAiOauth: Record<string, unknown> };
    assert.equal(parsed.claudeAiOauth.accessToken, placeholder, 'accessToken IS the placeholder');
    assert.equal(parsed.claudeAiOauth.refreshToken, JUNK_REFRESH);
    assert.ok((parsed.claudeAiOauth.expiresAt as number) > Date.now() + 1e12, 'far-future expiry');
  });

  it('stages the scrubbed ~/.claude.json identity (UUIDs only, no token) when present', async () => {
    const out = await buildGondolinFakeCreds('claude', {
      placeholder: 'sk-ant-x',
      secretName: 'ANTHROPIC_AUTH_TOKEN',
      hostReaders: fakeReaders(),
    });
    const cfg = out.files.find((f) => f.guestPath === '/root/.claude.json');
    assert.ok(cfg, 'identity staged');
    const parsed = JSON.parse(cfg!.content) as { oauthAccount: Record<string, string> };
    assert.equal(parsed.oauthAccount.accountUuid, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    assert.equal(parsed.oauthAccount.organizationUuid, 'ffffffff-0000-1111-2222-333333333333');
    assert.ok(!/accessToken|refreshToken|access_token/.test(cfg!.content), 'no token field in identity');
  });

  it('omits the identity file (non-fatal) when the host has none', async () => {
    const out = await buildGondolinFakeCreds('claude', {
      placeholder: 'sk-ant-x',
      secretName: 'ANTHROPIC_AUTH_TOKEN',
      hostReaders: fakeReaders({ readClaudeIdentity: async () => null }),
    });
    assert.equal(out.files.length, 1, 'only the creds file');
    assert.equal(out.files[0]!.guestPath, '/root/.claude/.credentials.json');
  });

  it('tolerates a throwing identity reader (still stages creds, no identity)', async () => {
    const out = await buildGondolinFakeCreds('claude', {
      placeholder: 'sk-ant-x',
      secretName: 'ANTHROPIC_AUTH_TOKEN',
      hostReaders: fakeReaders({
        readClaudeIdentity: async () => {
          throw new Error('boom');
        },
      }),
    });
    assert.equal(out.files.length, 1);
  });
});

// --- codex -----------------------------------------------------------------

describe('buildGondolinFakeCreds — codex', () => {
  it('stages auth.json: JWT-shaped placeholder, real account_id, junk refresh, no OPENAI_API_KEY', async () => {
    // A realistic codex placeholder is a JWT-shaped string (as credential-secrets mints).
    const placeholder = assemblePlaceholderJwt('RANDOMSIG_deadbeef');
    const out = await buildGondolinFakeCreds('codex', {
      placeholder,
      secretName: 'OPENAI_API_KEY',
      hostReaders: fakeReaders(),
    });

    assert.deepEqual(out.env, { OPENAI_API_KEY: placeholder });

    const auth = out.files.find((f) => f.guestPath === '/root/.codex/auth.json');
    assert.ok(auth, 'auth.json present');
    assert.equal(auth!.mode, 0o600);
    const parsed = JSON.parse(auth!.content) as { tokens: Record<string, unknown> };
    assert.equal(parsed.tokens.access_token, placeholder, 'access_token IS the placeholder JWT');
    assert.equal(parsed.tokens.id_token, placeholder);
    assert.equal(parsed.tokens.account_id, FAKE_ACCOUNT_ID, 'real non-secret account_id copied');
    assert.equal(parsed.tokens.refresh_token, JUNK_REFRESH);
    assert.ok(!('OPENAI_API_KEY' in parsed), 'no apikey field (OAuth tokens-block mode)');

    // The placeholder JWT decodes to a far-future exp ⇒ codex never refreshes.
    const payload = JSON.parse(
      Buffer.from(placeholder.split('.')[1]!, 'base64url').toString('utf8'),
    ) as { exp: number };
    assert.equal(payload.exp, PLACEHOLDER_JWT_EXP_SECONDS);
    assert.ok(payload.exp > Math.floor(Date.now() / 1000) + 1e9, 'exp far in the future');
  });

  it('omits account_id when the host reader yields none (still stages a valid tokens block)', async () => {
    const placeholder = assemblePlaceholderJwt('SIG');
    const out = await buildGondolinFakeCreds('codex', {
      placeholder,
      secretName: 'OPENAI_API_KEY',
      hostReaders: fakeReaders({ readCodexAccountId: async () => null }),
    });
    const auth = out.files.find((f) => f.guestPath === '/root/.codex/auth.json');
    const parsed = JSON.parse(auth!.content) as { tokens: Record<string, unknown> };
    assert.ok(!('account_id' in parsed.tokens), 'no account_id key when host has none');
    assert.equal(parsed.tokens.access_token, placeholder);
  });
});

// --- opencode --------------------------------------------------------------

describe('buildGondolinFakeCreds — opencode', () => {
  it('stages the custom-provider config; the placeholder rides env, not the file', async () => {
    const placeholder = 'gho_PLACEHOLDER_deadbeef';
    const out = await buildGondolinFakeCreds('opencode', {
      placeholder,
      secretName: 'OPENCODE_PROXY_TOKEN',
      opencodeModel: 'claude-sonnet-4.5',
    });

    assert.deepEqual(out.env, { OPENCODE_PROXY_TOKEN: placeholder });
    const cfg = out.files.find((f) => f.guestPath === '/root/.config/opencode/opencode.json');
    assert.ok(cfg, 'opencode.json present');
    assert.ok(cfg!.content.includes('{env:OPENCODE_PROXY_TOKEN}'), 'apiKey is the env interpolation');
    assert.ok(!cfg!.content.includes(placeholder), 'placeholder NOT inlined into the file');
    assert.ok(cfg!.content.includes('claude-sonnet-4.5'), 'selected model present');
  });
});

// --- invariant: no real token ever emitted ---------------------------------

describe('buildGondolinFakeCreds — invariant (no real token escapes to the guest)', () => {
  it('never emits a real-looking refresh token even when readers try to smuggle one', async () => {
    const REAL = 'rt_REAL_refresh_token_should_never_leave_host';
    // Readers that return a real token where a UUID/account_id is expected: the
    // builders must IGNORE non-whitelisted shapes (extractors validate UUIDs are
    // strings; the codex reader returns only account_id). Even a hostile string
    // here only lands in the (non-secret) account_id / UUID slots — never as a
    // bearer or refresh — and we assert the literal real-refresh token is absent.
    const hostile = fakeReaders({
      readCodexAccountId: async () => REAL, // would only ever land in account_id
    });
    for (const adapterId of ['claude', 'codex', 'opencode'] as const) {
      const out = await buildGondolinFakeCreds(adapterId, {
        placeholder: adapterId === 'codex' ? assemblePlaceholderJwt('sig') : 'placeholder-value',
        secretName: 'TOKEN',
        opencodeModel: null,
        hostReaders: hostile,
      });
      const blob = out.files.map((f) => f.content).join('\n');
      // refresh_token / refreshToken slots must be the junk literal, never REAL.
      assert.ok(!blob.includes(JUNK_REFRESH.replace('PLACEHOLDER', 'REAL')), `${adapterId}: no real refresh`);
      assert.ok(blob.includes(JUNK_REFRESH) || adapterId === 'opencode', `${adapterId}: junk refresh used`);
      // The env value is exactly the placeholder we passed (a fake).
      assert.equal(Object.values(out.env)[0], out.env.TOKEN);
    }
  });

  it('claude/codex refresh slots hold ONLY the junk literal, not the placeholder or any real token', async () => {
    const claude = await buildGondolinFakeCreds('claude', {
      placeholder: 'sk-ant-p',
      secretName: 'ANTHROPIC_AUTH_TOKEN',
      hostReaders: fakeReaders(),
    });
    const c = JSON.parse(claude.files[0]!.content) as { claudeAiOauth: { refreshToken: string } };
    assert.equal(c.claudeAiOauth.refreshToken, JUNK_REFRESH);
    assert.notEqual(c.claudeAiOauth.refreshToken, 'sk-ant-p');
  });
});

// --- pure extractors --------------------------------------------------------

describe('extractClaudeIdentity / extractCodexAccountId (pure, non-secret only)', () => {
  it('extracts only the oauthAccount UUIDs, never a token', () => {
    const id = extractClaudeIdentity({
      oauthAccount: { accountUuid: 'u', organizationUuid: 'o', emailAddress: 'x@y.z' },
      claudeAiOauth: { accessToken: 'sk-ant-REAL', refreshToken: 'rt-REAL' },
    });
    assert.deepEqual(id, { accountUuid: 'u', organizationUuid: 'o' });
  });

  it('returns null when oauthAccount or its UUIDs are missing', () => {
    assert.equal(extractClaudeIdentity({}), null);
    assert.equal(extractClaudeIdentity({ oauthAccount: { accountUuid: 'u' } }), null);
    assert.equal(extractClaudeIdentity(null), null);
  });

  it('extracts only tokens.account_id, never the access/refresh token', () => {
    const acct = extractCodexAccountId({
      tokens: { account_id: 'acct_X', access_token: 'JWT.REAL', refresh_token: 'rt_REAL' },
    });
    assert.equal(acct, 'acct_X');
  });

  it('returns null when the codex tokens block or account_id is absent', () => {
    assert.equal(extractCodexAccountId({}), null);
    assert.equal(extractCodexAccountId({ tokens: {} }), null);
    assert.equal(extractCodexAccountId(null), null);
  });
});
