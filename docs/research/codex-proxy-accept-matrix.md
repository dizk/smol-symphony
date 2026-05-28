# OpenAI / codex accept matrix for the credential-proxy (codex α)

Status: research / decision. Mirrors `docs/research/credential-proxy-accept-matrix.md`
(the Anthropic α, issue #112) for the codex / OpenAI side. Settles the four
research questions issue #115 raises so the orchestrator can decide whether —
and how — to extend the host credential proxy to the codex adapter.

**Important provenance caveat.** The Anthropic matrix (#112) was measured
*live* against `https://api.anthropic.com/v1/messages` from a host holding an
active Claude Max credential. **This doc could NOT be measured live**: the
implementing environment has no OpenAI API key, no ChatGPT-subscription
`~/.codex/auth.json`, and no outbound network credentials. Every row below is
therefore **doc-derived** — synthesised from OpenAI / codex documentation, the
`codex-rs` source behaviour described in those docs, well-established OpenAI API
conventions, and the 2026-05-28 web research pass recorded in the issue body.
Rows that would require a live token to confirm are marked
**`DOC-DERIVED (needs live confirm)`**. The recommendation (§6) is written to be
safe under that uncertainty: it does **not** flip codex onto an unverified path.

Captured: 2026-05-28.

---

## 1. Accept matrix (doc-derived)

Hypothetical calls to `https://api.openai.com/v1/responses` (codex's upstream)
with a credential drawn from `~/.codex/auth.json`. Two credential flavours
live in that file (see `docs/research/credential-injection.md` §2): an
`OPENAI_API_KEY` (API-key mode) and a `tokens` object holding
`access_token` / `id_token` / `refresh_token` / `account_id` (ChatGPT-OAuth
mode). Token bytes redacted as `<API_KEY>` / `<CHATGPT_ACCESS_TOKEN>` /
`<REFRESH_TOKEN>`.

| # | Credential source | Auth header | HTTP (expected) | Billing routing | Confidence |
| - | ----------------- | ----------- | --------------- | --------------- | ---------- |
| 1 | `OPENAI_API_KEY` (API-key mode) | `Authorization: Bearer <API_KEY>` | 200 | Metered pay-as-you-go (OpenAI API billing) | **High** — this is the documented OpenAI REST convention; the SDK uses `Authorization: Bearer <key>` and honors `base_url`. |
| 2 | `tokens.access_token` (ChatGPT-OAuth) | `Authorization: Bearer <CHATGPT_ACCESS_TOKEN>` | 200 | ChatGPT subscription (Plus/Pro/Business), **not** metered API | **Medium** — OpenAI's CI/CD auth docs describe codex authenticating with the ChatGPT-OAuth access token as a Bearer; the subscription-vs-API split is documented, but the exact request shape was not measured here. `DOC-DERIVED (needs live confirm)`. |
| 3 | `tokens.refresh_token` | (never sent to `/v1/*`) | n/a | n/a | **High** — the refresh token is only ever presented to OpenAI's OAuth token endpoint, never to the inference API. It is exactly what we keep off the VM. |
| 4 | `OPENAI_API_KEY` | `x-api-key: <API_KEY>` | 401 (expected) | n/a | **Medium** — OpenAI's REST API uses `Authorization: Bearer`, not `x-api-key` (that is an Anthropic convention). Listed to mirror the Anthropic matrix's channel disambiguation. `DOC-DERIVED`. |

### What the rows tell us

- **Channel.** Unlike Anthropic — where the subscription `accessToken` is
  rejected on `x-api-key` and only works on `Authorization: Bearer` (#112 rows
  1–5) — OpenAI uses `Authorization: Bearer <token>` for **both** the API key
  and the ChatGPT-OAuth access token. There is no channel ambiguity to resolve:
  the proxy's upstream auth header for the codex profile is `Authorization:
  Bearer <token>` in every mode.
- **No third-party lockdown.** The 2026-05-28 web pass confirms OpenAI has **not**
  shipped the Anthropic-style third-party-client ban (Anthropic's Feb-2026 ToS
  change + Apr-2026 billing enforcement that routes third-party OAuth to
  overage). OpenAI's stated GPT-5.5 position: *"We want people to be able to use
  Codex, and their ChatGPT subscription, wherever they like."* So there is **no
  server-side fingerprint / `metadata.user_id` validation problem** to design
  around — the whole hermes-claude-auth spoofing concern that dominated #112 is
  absent here. (Caveats: a ToS gray area exists around forking the Codex CLI /
  third-party OAuth — openai/codex#8338, feature-request #10974; and quota 429s
  have been reported for third-party ChatGPT-OAuth calls —
  openai/openai-python#2951.) The proxy therefore needs **no** identity-staging
  analogue of `stageClaudeIdentity` for codex.
- **Billing tell (research Q4 / #115).** The Anthropic side has the
  `anthropic-ratelimit-unified-{5h,7d}-*` family as a subscription-billing
  signal the proxy logs (`logRateLimitHeaders`). OpenAI's response-header tell
  was **not measurable here**. From docs + community reports the candidates to
  look for on a live ChatGPT-OAuth call are the `x-ratelimit-*` family
  (`x-ratelimit-limit-requests`, `x-ratelimit-remaining-requests`,
  `x-ratelimit-limit-tokens`, …) and any `x-ratelimit-*` variant that differs
  between subscription and metered traffic. **This is an explicit gap**: the
  codex-proxy implementation slice must capture the real subscription tell from
  a live call before it can log/forward it the way the Anthropic proxy logs the
  unified-5h headers. Until then there is no reliable "is this subscription or
  metered" assertion the proxy can make.

---

## 2. Research Q1 — OpenAI accept matrix

**Answer:** `Authorization: Bearer <token>` is the single accept channel for
both the `OPENAI_API_KEY` and the ChatGPT-OAuth `access_token`. `api.openai.com`
applies **no** Claude-Code-style server-side third-party-client validation
(no Anthropic-Jan-2026-lockdown equivalent). An `OPENAI_API_KEY` request bills
metered pay-as-you-go; a ChatGPT-OAuth `access_token` request bills against the
ChatGPT subscription (the two are separate billing systems sharing one login —
confirmed in docs, same shape as Anthropic's subscription/API split). The exact
subscription-billing response-header tell is **unconfirmed** (no live token) and
is carried as a gap into the implementation slice.

## 3. Research Q2 — does codex-acp honor `OPENAI_BASE_URL`? (THE GATING UNKNOWN)

**Answer: unresolved, and unresolvable in this environment.** This is the
load-bearing question for whether the proxy can interpose at all, and it could
**not** be settled without a live codex-acp + ChatGPT-OAuth environment.

What the docs say (cuts both ways):

- codex **does** honor a base-URL override: `openai_base_url` in `config.toml`,
  or `requires_openai_auth = true` on a custom provider to route ChatGPT-OAuth
  through an LLM proxy, plus `CODEX_CA_CERTIFICATE` for a custom CA. So
  base-URL interposition is *documented-supported* for the codex CLI — better
  than the `ANTHROPIC_BASE_URL=http://` question that was still open for claude
  before #112/#113.
- **But** two things remain unverified:
  1. Whether **codex-acp** (the ACP wrapper symphony launches) plumbs
     `OPENAI_BASE_URL` / `openai_base_url` through the same way the codex CLI
     does, *and* whether it does so for the **ChatGPT-OAuth auth handshake**
     specifically, or short-circuits to OpenAI's token endpoint regardless of
     base URL. The research note §8.3 flagged exactly this: *"does codex
     short-circuit to the OAuth endpoint regardless of base URL?"*
  2. Whether routing the OAuth **refresh** (not just the inference call) through
     a custom base URL is honored or hard-coded to `auth.openai.com`.

**Consequence:** if codex-acp ignores the base URL for the OAuth path (or for
the refresh), pointing `OPENAI_BASE_URL` at the proxy would **break** codex
dispatches that work today via `OPENAI_API_KEY` through `smolvm.forward_env` —
a regression neither the implementer (no creds) nor the reviewer (re-runs
typecheck/test/lint, no live codex dispatch) can catch. The API-key path is
lower-risk (the OpenAI SDK definitively honors `base_url` for normal API calls),
but the OAuth path — the entire point of the proxy, since an API key has no
refresh-token to protect — is the unverified one.

## 4. Research Q3 — refresh ownership (the hard core)

**Answer / recommendation: access-token-only into the proxy, host is the sole
refresher — same invariant as the claude proxy — leaning on codex's long TTL to
make races rare. Of the three options the issue lists, prefer (c) now, with (b)
as the eventual target and (a) rejected.**

The hard part is identical in shape to issue #77's rotation-poisoning, on the
OpenAI side, and it is *acute* for codex: per OpenAI's CI/CD auth docs +
`codex-rs/core/src/auth.rs`, codex refreshes its token bundle when `last_refresh`
is older than ~8 days **or on a 401** via a built-in refresh-and-retry path, and
**writes the rotated tokens + new `last_refresh` back to `auth.json`**. The
refresh token is **single-use / rotated**; OpenAI explicitly warns *"Do NOT
share the same file across concurrent jobs or multiple machines… one
`auth.json` per runner or per serialized workflow stream,"* and concurrent
refreshers hit `refresh_token_reused` → forced re-login (openai/codex#10332,
#9634, #6498, #19803).

The non-negotiable invariant (mirrors the claude proxy): **the VM's codex must
receive an access token only, never the refresh token.** Staging the full
`auth.json` into the VM is doubly wrong — it exposes the rotating refresh token
*and* codex would auto-refresh-on-401 inside the VM and write to its staged
copy, actively fighting any host-side refresher.

Option evaluation:

- **(a) `codex`-CLI equivalent of `claude -p`** that drives codex's own
  refresh + write-back on the host under flock. *Rejected for now:* there is no
  known codex subcommand that reliably triggers a refresh-and-writeback the way
  a `claude -p "ok"` round-trip does for Anthropic. Until one is found and
  verified, this is speculative.
- **(b) Proxy performs OpenAI's refresh dance itself** (owns the refresh token,
  POSTs to the OAuth token endpoint, writes the rotated bundle back to
  `auth.json` under flock). This is the heaviest path (research note Option C)
  and the eventual *correct* target — it makes the host the single writer that
  OpenAI's "serialized workflow stream" guidance literally recommends. But it
  requires implementing and live-testing the OpenAI refresh exchange, which is
  out of reach without a real refresh token.
- **(c) Lean on the long TTL.** codex access tokens are ~8-day-lived (issue body;
  research note §2 says ~10 days), vs Anthropic's ~8h. So the host-side
  refresh-race window is ~24× narrower than the claude proxy's. A simpler
  posture — proxy reads `tokens.access_token`, host is the sole refresher via
  whatever mechanism the operator already uses (host `codex` login/usage), and
  re-reads on expiry — suffices for the common case. **Recommended starting
  point**, because it preserves the security invariant (refresh token off the
  VM) without the proxy having to own OAuth, and the long TTL makes the
  simplification safe.

The proxy already has the right shape to absorb (b) later: `refresher` and the
flock-serialized `refreshNow()` are injectable; a codex profile would supply a
codex-specific `refresher` (the OpenAI refresh dance) and a codex-specific
credential reader (`tokens.access_token` / `OPENAI_API_KEY` instead of
`claudeAiOauth.accessToken`).

## 5. Research Q4 — API-key fast path

**Answer: confirmed as the simplest supported mode.** If the operator has an
`OPENAI_API_KEY` (not ChatGPT-OAuth), the proxy path is trivial: static
`Authorization: Bearer <key>`, no refresh, no rotation, no `auth.json` parsing.
An API key has no refresh token to protect, so the *security* upside of proxying
it (vs the current `forward_env` path) is only "keep the key out of the VM's
`/proc/<pid>/environ`" — modest. The OpenAI SDK honors `OPENAI_BASE_URL` for
normal API calls (high confidence), so the API-key-through-proxy path does not
depend on the unresolved Q2 OAuth-handshake question. This is the natural first
slice of a future codex-proxy implementation.

---

## 6. Decision (resolves issue #115 acceptance bullet 2)

Issue #115 offers two implementation branches: **(a)** generalize the proxy to
support codex end-to-end, or **(b)** a documented decision that codex stays
file-mode with a per-state `credentials_mode` knob. **Both options as literally
written are blocked by changes that landed after the issue was filed, plus the
unverifiable gating unknown:**

1. **#114 already removed file-mode and the global `credentials_mode` knob.**
   It deleted `stageCredential`, the per-adapter `hostCredentialPath` /
   `guestCredentialPath`, and the `acp.credentials_mode` config entirely. The
   proxy is now unconditional-for-claude; codex reads `OPENAI_API_KEY` via
   `smolvm.forward_env` with **no** credential bytes in the VM. So option (b)'s
   "codex stays *file-mode*" would mean **re-introducing** the deleted
   file-staging path — putting the codex refresh token back inside the VM —
   which directly contradicts the security posture #113/#114 established. That
   is the wrong direction.

2. **Option (a) cannot be honestly delivered from this environment.** Its
   acceptance ("ChatGPT-subscription billing confirmed, host sole refresher")
   requires a live ChatGPT-OAuth token to confirm Q2 (codex-acp honoring
   `OPENAI_BASE_URL` for the OAuth handshake), Q4's billing tell, and the
   refresh mechanism. None are measurable here, and shipping codex-onto-the-proxy
   blind risks regressing every Review dispatch with no test that can catch it.

**Therefore the decision is option (b)-in-spirit, adapted to the post-#114
world:** codex stays on its current **`forward-env`** credential path (the
post-#114 successor to "file mode" — credentials forwarded as env, never staged
as files), and the mixed-adapter-workflow answer is implemented as a
**per-adapter `credentialStrategy`** on `AdapterProfile` rather than a per-state
`credentials_mode` knob:

- `claude.credentialStrategy = 'proxy'` — routes through the host credential
  proxy (mints a sentinel, stages identity, forwards Bearer host-side).
- `codex.credentialStrategy = 'forward-env'` — reads `OPENAI_API_KEY` from
  `smolvm.forward_env`; the proxy is not involved.

**Why per-adapter beats per-state.** A per-state `credentials_mode` knob existed
in the pre-#114 design only because the mode was a *global* `acp:` setting, so a
mixed workflow (Todo=claude, Review=codex) could not have claude=proxy +
codex=file simultaneously. Post-#114, the credential mode is already implicitly
per-adapter (claude→proxy, codex→forward-env). Keying the strategy on the
adapter each state already selects gives exactly the mixed-workflow behaviour
the per-state knob was meant to provide — automatically, with no redundant knob
that would just mirror the adapter choice — and it satisfies the issue's third
acceptance bullet: the `profile.id !== 'claude'` branching is replaced by
adapter-aware dispatch, where proxy-capable adapters route through the proxy and
others proceed via `forward-env` with a logged line rather than crash-looping.

**The full codex-proxy work is deferred to a follow-up slice** (filed via
`propose_issue`) that, with a live ChatGPT-OAuth environment, would:
1. Confirm Q2 (codex-acp honors `OPENAI_BASE_URL` for the OAuth handshake) and
   Q4 (capture the subscription billing-tell header).
2. Generalize `CredentialProxy` to an `UpstreamProfile` keyed by adapter id
   (upstream host, credential reader, auth channel, refresher, billing-tell
   header set become per-adapter strategy objects), starting with the
   verifiable API-key fast path (§5), then the ChatGPT-OAuth access-token-only
   path with the host as sole refresher (§4, option (c) → (b)).
3. Flip `codex.credentialStrategy` to `'proxy'` once the live smoke passes.

## 7. References

- `docs/research/credential-proxy-accept-matrix.md` — the Anthropic α this
  mirrors (issue #112).
- `docs/research/credential-injection.md` §2 (codex `auth.json` shape), §5
  (codex auth precedence + self-refresh + write-back), §6 Option C (host proxy),
  §8.3 (`OPENAI_BASE_URL` / OAuth short-circuit risk — the Q2 gating unknown).
- `src/agent/credential-proxy.ts` — the claude proxy a codex `UpstreamProfile`
  would generalize.
- `src/agent/adapters.ts` — `AdapterProfile.credentialStrategy` (this issue).
- Issue #113 (β, the claude proxy), #114 (γ, deleted file-mode + flipped default
  to proxy), #77 (refresh-token rotation poisoning — the same hard core).
- Prior-research sources (2026-05-28 web pass, full URLs in the issue body):
  OpenAI permissive stance / no lockdown (mindstudio, help.openai.com);
  codex refresh + write-back + ~8-day cadence
  (developers.openai.com/codex/auth/ci-cd-auth, /codex/auth); single-use
  rotation collision (openai/codex#10332, #9634, #6498, #19803); base-url / CA
  override (developers.openai.com/codex/config-advanced, /config-reference);
  ToS gray area + third-party quota (openai/codex#8338, #10974,
  openai/openai-python#2951).
