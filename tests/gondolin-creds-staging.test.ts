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
  extractCodexMetadata,
  type HostIdentityReaders,
} from '../src/agent/gondolin-creds-staging.js';
import {
  assemblePlaceholderJwt,
  PLACEHOLDER_JWT_EXP_SECONDS,
} from '../src/agent/credential-secrets.js';

const JUNK_REFRESH = 'JUNK-PLACEHOLDER-REFRESH-not-a-real-token';

// Injected host readers: a fixed non-secret identity/metadata, NEVER a token.
// The real host account_id is a UUID (the routing `chatgpt_account_id`); the
// account_id validators (extractCodexAccountId + extractCodexMetadata + the JWT
// chokepoint in assemblePlaceholderJwt) accept ONLY a UUID, so this fixture must
// be UUID-shaped for the happy path to embed/stage it.
const FAKE_ACCOUNT_ID = '00000000-0000-4000-8000-000000000abc';
const FAKE_AUTH_MODE = 'chatgpt';
const FAKE_LAST_REFRESH = '2026-05-22T08:59:06.309350255Z';
function fakeReaders(overrides: Partial<HostIdentityReaders> = {}): HostIdentityReaders {
  return {
    readClaudeIdentity: async () => ({
      accountUuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      organizationUuid: 'ffffffff-0000-1111-2222-333333333333',
    }),
    readCodexAccountId: async () => FAKE_ACCOUNT_ID,
    readCodexMetadata: async () => ({
      accountId: FAKE_ACCOUNT_ID,
      authMode: FAKE_AUTH_MODE,
      lastRefresh: FAKE_LAST_REFRESH,
    }),
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
  it('stages a codex-0.135-COMPLETE auth.json: JWT placeholder + non-secret completeness fields', async () => {
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
    const parsed = JSON.parse(auth!.content) as {
      OPENAI_API_KEY: unknown;
      auth_mode: unknown;
      last_refresh: unknown;
      tokens: Record<string, unknown>;
    };
    // tokens block: placeholder bearer + non-secret account_id + junk refresh.
    assert.equal(parsed.tokens.access_token, placeholder, 'access_token IS the placeholder JWT');
    assert.equal(parsed.tokens.id_token, placeholder);
    assert.equal(parsed.tokens.account_id, FAKE_ACCOUNT_ID, 'real non-secret account_id copied');
    assert.equal(parsed.tokens.refresh_token, JUNK_REFRESH);
    // Top-level completeness fields codex 0.135 requires before it sends the bearer.
    assert.equal(parsed.OPENAI_API_KEY, null, 'OPENAI_API_KEY explicitly null (OAuth tokens-block mode)');
    assert.equal(parsed.auth_mode, FAKE_AUTH_MODE, 'non-secret auth_mode copied from host');
    assert.equal(parsed.last_refresh, FAKE_LAST_REFRESH, 'non-secret last_refresh copied from host');

    // The placeholder JWT decodes to a far-future exp ⇒ codex never refreshes.
    const payload = JSON.parse(
      Buffer.from(placeholder.split('.')[1]!, 'base64url').toString('utf8'),
    ) as { exp: number };
    assert.equal(payload.exp, PLACEHOLDER_JWT_EXP_SECONDS);
    assert.ok(payload.exp > Math.floor(Date.now() / 1000) + 1e9, 'exp far in the future');
  });

  it('omits account_id/auth_mode/last_refresh when the host metadata is absent (still a valid tokens block)', async () => {
    const placeholder = assemblePlaceholderJwt('SIG');
    const out = await buildGondolinFakeCreds('codex', {
      placeholder,
      secretName: 'OPENAI_API_KEY',
      hostReaders: fakeReaders({ readCodexMetadata: async () => null }),
    });
    const auth = out.files.find((f) => f.guestPath === '/root/.codex/auth.json');
    const parsed = JSON.parse(auth!.content) as {
      OPENAI_API_KEY: unknown;
      tokens: Record<string, unknown>;
    };
    assert.ok(!('account_id' in parsed.tokens), 'no account_id key when host has none');
    assert.ok(!('auth_mode' in parsed), 'no auth_mode key when host has none');
    assert.ok(!('last_refresh' in parsed), 'no last_refresh key when host has none');
    // OPENAI_API_KEY: null is always present (it is a constant, not host-derived).
    assert.equal(parsed.OPENAI_API_KEY, null);
    assert.equal(parsed.tokens.access_token, placeholder);
  });

  it('omits only the absent metadata fields when the host has partial metadata', async () => {
    const placeholder = assemblePlaceholderJwt('SIG2');
    const out = await buildGondolinFakeCreds('codex', {
      placeholder,
      secretName: 'OPENAI_API_KEY',
      // account_id present, but auth_mode/last_refresh absent.
      hostReaders: fakeReaders({
        readCodexMetadata: async () => ({
          accountId: FAKE_ACCOUNT_ID,
          authMode: null,
          lastRefresh: null,
        }),
      }),
    });
    const auth = out.files.find((f) => f.guestPath === '/root/.codex/auth.json');
    const parsed = JSON.parse(auth!.content) as {
      auth_mode?: unknown;
      last_refresh?: unknown;
      tokens: Record<string, unknown>;
    };
    assert.equal(parsed.tokens.account_id, FAKE_ACCOUNT_ID);
    assert.ok(!('auth_mode' in parsed), 'absent auth_mode omitted');
    assert.ok(!('last_refresh' in parsed), 'absent last_refresh omitted');
  });
});

// --- JWT-bearer flow (flow 1): account_id → placeholder JWT → guest bearer ---
//
// `assemblePlaceholderJwt(sig, accountId)` builds the codex placeholder, which is
// staged VERBATIM as `tokens.access_token` (the guest BEARER) and held by Gondolin
// for exact-match substitution. The account_id ends up in the
// `https://api.openai.com/auth.chatgpt_account_id` claim. The HIGH finding: a
// hostile/malformed host account_id (a real token/api-key string) must NEVER reach
// that claim. The shared UUID guard at this chokepoint OMITS a non-UUID id.

function decodeJwtPayload(jwt: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(jwt.split('.')[1]!, 'base64url').toString('utf8')) as Record<
    string,
    unknown
  >;
}

describe('assemblePlaceholderJwt — account_id JWT-bearer claim (flow 1)', () => {
  it('embeds a UUID account_id in the chatgpt_account_id claim (happy path unchanged)', () => {
    const jwt = assemblePlaceholderJwt('SIG', FAKE_ACCOUNT_ID);
    const payload = decodeJwtPayload(jwt);
    assert.equal(payload.exp, PLACEHOLDER_JWT_EXP_SECONDS);
    const authClaim = payload['https://api.openai.com/auth'] as { chatgpt_account_id?: string };
    assert.equal(authClaim?.chatgpt_account_id, FAKE_ACCOUNT_ID, 'UUID id embedded in the bearer claim');
  });

  it('OMITS the auth claim when account_id is null (well-formed JWT, no id to embed)', () => {
    const payload = decodeJwtPayload(assemblePlaceholderJwt('SIG', null));
    assert.ok(!('https://api.openai.com/auth' in payload), 'no auth claim');
    assert.equal(payload.exp, PLACEHOLDER_JWT_EXP_SECONDS, 'still a well-formed placeholder JWT');
  });

  it('OMITS a token-shaped / JWT-shaped / sk- account_id from the bearer claim (never embedded)', () => {
    for (const hostile of [
      'eyJhbGc.REAL.ACCESS_TOKEN', // JWT-shaped real token
      'sk-proj-REAL-apikey-value', // OpenAI api-key shaped
      'rt_REAL_refresh_token', // refresh-token shaped
      'acct_test_98765', // the OLD non-UUID fixture shape
    ]) {
      const jwt = assemblePlaceholderJwt('SIG', hostile);
      const payload = decodeJwtPayload(jwt);
      assert.ok(
        !('https://api.openai.com/auth' in payload),
        `token-shaped account_id "${hostile}" must NOT produce an auth claim`,
      );
      assert.ok(!jwt.includes(Buffer.from(hostile).toString('base64url')), 'value not encoded into the JWT');
      // The JWT stays well-formed (the SAFE failure: codex may prompt, not leak).
      assert.equal(payload.exp, PLACEHOLDER_JWT_EXP_SECONDS, 'JWT still well-formed');
    }
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
    // Readers that return a real token where a UUID/account_id is expected. The
    // codex builder reads ONLY readCodexMetadata, whose account_id is now UUID-guarded
    // (a non-UUID like REAL is dropped to null → omitted). We assert the literal
    // real-refresh token is absent from every staged file regardless.
    const hostile = fakeReaders({
      readCodexAccountId: async () => REAL,
      readCodexMetadata: async () => ({ accountId: REAL, authMode: REAL, lastRefresh: REAL }),
    });
    for (const adapterId of ['claude', 'codex', 'opencode'] as const) {
      const out = await buildGondolinFakeCreds(adapterId, {
        placeholder: adapterId === 'codex' ? assemblePlaceholderJwt('sig') : 'placeholder-value',
        secretName: 'TOKEN',
        opencodeModel: null,
        hostReaders: hostile,
      });
      const blob = out.files.map((f) => f.content).join('\n');
      // The smuggled REAL string must appear NOWHERE in any staged file (it is
      // neither a valid account_id/auth_mode/last_refresh, so all three are omitted).
      assert.ok(!blob.includes(REAL), `${adapterId}: smuggled token absent from staged files`);
      // refresh_token / refreshToken slots must be the junk literal, never REAL.
      assert.ok(!blob.includes(JUNK_REFRESH.replace('PLACEHOLDER', 'REAL')), `${adapterId}: no real refresh`);
      assert.ok(blob.includes(JUNK_REFRESH) || adapterId === 'opencode', `${adapterId}: junk refresh used`);
      // The env value is exactly the placeholder we passed (a fake).
      assert.equal(Object.values(out.env)[0], out.env.TOKEN);
    }
  });

  it('codex: a real access/refresh token smuggled through the metadata reader NEVER lands in auth.json', async () => {
    // Worst case: the host metadata reader is compromised and tries to return the
    // REAL access/refresh token in EVERY metadata slot. Two defenses fire: (1) the
    // builder ALWAYS overrides the bearer/refresh with the placeholder + junk, and
    // (2) the strict account_id/auth_mode/last_refresh format guards reject the
    // token-shaped values, so they are OMITTED entirely. A real token must never
    // appear ANYWHERE in the staged file.
    const REAL_ACCESS = 'eyJREAL.ACCESS.TOKEN_must_never_leave_host';
    const REAL_REFRESH = 'rt_REAL_refresh_must_never_leave_host';
    const placeholder = assemblePlaceholderJwt('uniqsig');
    const out = await buildGondolinFakeCreds('codex', {
      placeholder,
      secretName: 'OPENAI_API_KEY',
      hostReaders: fakeReaders({
        readCodexMetadata: async () => ({
          accountId: REAL_ACCESS, // hostile: NOT a UUID → guarded out
          authMode: REAL_REFRESH, // hostile: NOT a known auth_mode → guarded out
          lastRefresh: REAL_REFRESH, // hostile: NOT an ISO timestamp → guarded out
        }),
      }),
    });
    const auth = out.files.find((f) => f.guestPath === '/root/.codex/auth.json')!;
    const parsed = JSON.parse(auth.content) as {
      auth_mode?: unknown;
      last_refresh?: unknown;
      tokens: Record<string, unknown>;
    };
    // The bearer + refresh slots are NEVER the host-supplied value — they are the
    // placeholder + junk literal, by construction.
    assert.equal(parsed.tokens.access_token, placeholder, 'bearer is the placeholder, not a smuggled token');
    assert.equal(parsed.tokens.id_token, placeholder);
    assert.equal(parsed.tokens.refresh_token, JUNK_REFRESH, 'refresh is the junk literal');
    // The token-shaped strings are NOT a valid account_id/auth_mode/last_refresh, so
    // the strict guards OMIT them from the (non-secret) metadata slots entirely.
    assert.ok(!('account_id' in parsed.tokens), 'token-shaped account_id omitted, not embedded');
    assert.ok(!('auth_mode' in parsed), 'token-shaped auth_mode omitted, not embedded');
    assert.ok(!('last_refresh' in parsed), 'token-shaped last_refresh omitted, not embedded');
    // Belt-and-suspenders: the smuggled strings appear NOWHERE in the staged file.
    assert.ok(!auth.content.includes(REAL_ACCESS), 'no smuggled access token anywhere in auth.json');
    assert.ok(!auth.content.includes(REAL_REFRESH), 'no smuggled refresh token anywhere in auth.json');
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

  it('extracts only tokens.account_id (UUID), never the access/refresh token', () => {
    const acct = extractCodexAccountId({
      tokens: { account_id: FAKE_ACCOUNT_ID, access_token: 'JWT.REAL', refresh_token: 'rt_REAL' },
    });
    assert.equal(acct, FAKE_ACCOUNT_ID);
  });

  it('returns null when the codex tokens block or account_id is absent', () => {
    assert.equal(extractCodexAccountId({}), null);
    assert.equal(extractCodexAccountId({ tokens: {} }), null);
    assert.equal(extractCodexAccountId(null), null);
  });

  it('rejects a token-shaped (non-UUID) account_id so it never reaches the JWT-bearer flow', () => {
    // This is the value symphony.ts feeds into the placeholder JWT bearer claim.
    // A token / sk- / JWT string is not a UUID → must be dropped to null here.
    assert.equal(
      extractCodexAccountId({ tokens: { account_id: 'eyJabc.DEF.ghi_real_jwt' } }),
      null,
    );
    assert.equal(extractCodexAccountId({ tokens: { account_id: 'sk-REAL-apikey-value' } }), null);
    assert.equal(extractCodexAccountId({ tokens: { account_id: 'acct_test_98765' } }), null);
    assert.equal(extractCodexAccountId({ tokens: { account_id: 'rt_refresh_token' } }), null);
  });
});

describe('extractCodexMetadata (pure, allowlisted non-secret fields only)', () => {
  it('extracts ONLY account_id (UUID) + auth_mode + last_refresh, never any token', () => {
    const meta = extractCodexMetadata({
      auth_mode: 'chatgpt',
      last_refresh: '2026-05-22T08:59:06.309350255Z',
      OPENAI_API_KEY: 'sk-REAL-apikey-should-be-ignored',
      tokens: {
        account_id: FAKE_ACCOUNT_ID,
        access_token: 'JWT.REAL.ACCESS',
        id_token: 'JWT.REAL.ID',
        refresh_token: 'rt_REAL',
      },
    });
    assert.deepEqual(meta, {
      accountId: FAKE_ACCOUNT_ID,
      authMode: 'chatgpt',
      lastRefresh: '2026-05-22T08:59:06.309350255Z',
    });
    // Belt-and-suspenders: the serialized struct contains none of the real tokens.
    const blob = JSON.stringify(meta);
    assert.ok(!/JWT\.REAL|rt_REAL|sk-REAL/.test(blob), 'no real token leaked into metadata');
  });

  it('rejects token-shaped / out-of-allowlist account_id, auth_mode, last_refresh (all guarded out)', () => {
    // Each field carries a hostile token-shaped value; the strict guards must drop
    // each to null so NONE is staged into the (non-secret) metadata slots.
    const meta = extractCodexMetadata({
      auth_mode: 'eyJREAL.ACCESS.jwt', // not in {chatgpt,apikey}
      last_refresh: 'sk-REAL-not-a-timestamp', // not ISO-charset
      tokens: {
        account_id: 'eyJREAL.ACCESS.jwt', // not a UUID
        access_token: 'JWT.REAL.ACCESS',
        refresh_token: 'rt_REAL',
      },
    });
    assert.deepEqual(meta, { accountId: null, authMode: null, lastRefresh: null });
  });

  it('rejects an sk- / apikey-shaped account_id and an out-of-charset last_refresh', () => {
    const meta = extractCodexMetadata({
      auth_mode: 'apikey', // valid allowlisted mode — kept
      last_refresh: '2026-05-22T08:59:06Z; rm -rf', // contains illegal chars → dropped
      tokens: { account_id: 'sk-proj-REAL-apikey-value' }, // not a UUID → dropped
    });
    assert.deepEqual(meta, { accountId: null, authMode: 'apikey', lastRefresh: null });
  });

  it('returns a struct with null fields when present-but-sparse, null only when unparseable', () => {
    assert.deepEqual(extractCodexMetadata({}), {
      accountId: null,
      authMode: null,
      lastRefresh: null,
    });
    assert.deepEqual(extractCodexMetadata({ tokens: {} }), {
      accountId: null,
      authMode: null,
      lastRefresh: null,
    });
    assert.equal(extractCodexMetadata(null), null);
    assert.equal(extractCodexMetadata('not-an-object'), null);
    assert.equal(extractCodexMetadata([1, 2, 3]), null);
  });
});
