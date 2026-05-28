# Anthropic accept matrix for the credential-proxy (α verification)

Status: measurement. Pins the three wire-level questions issue #112 raises so
the credential-proxy implementation (β) can pick its upstream-auth channel
without guessing.

Measured against `https://api.anthropic.com/v1/messages` from a host that
holds an active Claude Max `~/.claude/.credentials.json`. All calls used
`anthropic-version: 2023-06-01`, model `claude-haiku-4-5-20251001`,
`max_tokens: 1`, and the single-message body `[{role:"user",content:"hi"}]`.
Captured run date: 2026-05-28. Subscription tier: `default_claude_max_20x`.
Subscription org id is redacted below as `<ORG_UUID>` and the operator's
`oauthAccount.accountUuid` as `<ACCOUNT_UUID>`. Token bytes are redacted as
`<ACCESS_TOKEN>` (the literal `claudeAiOauth.accessToken` field, which
matches the documented `sk-ant-oat01-…` shape).

## 1. Results

| # | Auth header                                  | `metadata.user_id`  | `tools` | Extra identity headers                                                         | HTTP | Response excerpt                                                              | Subscription-billing signal in response                                                                 |
| - | -------------------------------------------- | ------------------- | ------- | ------------------------------------------------------------------------------ | ---- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| 1 | `x-api-key: <ACCESS_TOKEN>`                  | absent              | absent  | none                                                                           | 401  | `{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}` | None — request rejected at auth layer.                                                                  |
| 2 | `x-api-key: <ACCESS_TOKEN>`                  | absent              | present | none                                                                           | 401  | same `invalid x-api-key` body                                                 | None — auth-layer rejection precedes any tools-overage classifier.                                      |
| 3 | `x-api-key: <ACCESS_TOKEN>`                  | `<ACCOUNT_UUID>`    | present | none                                                                           | 401  | same `invalid x-api-key` body                                                 | None — fingerprint cannot rescue a token the channel refuses.                                           |
| 4 | `authorization: Bearer <ACCESS_TOKEN>`       | absent              | present | none                                                                           | 200  | `{"content":[{"type":"text","text":"Hello"}],"usage":{"input_tokens":542,…,"service_tier":"standard"}}` | `anthropic-organization-id: <ORG_UUID>` matches the operator's Max org. `anthropic-ratelimit-unified-{5h,7d}-{status,reset,utilization}` headers present. `anthropic-ratelimit-unified-overage-disabled-reason: org_level_disabled` + `overage-status: rejected`. |
| 5 | `authorization: Bearer <ACCESS_TOKEN>`       | `<ACCOUNT_UUID>`    | present | `anthropic-beta: oauth-2025-04-20,claude-code-20250219`, `user-agent: claude-cli/2.1.146 (external, cli)`, `x-app: cli` | 200  | identical-shape success body, `input_tokens: 542`                             | Same subscription headers as row 4 (same org id, same unified-5h/7d block).                             |
| 6 | `x-api-key: <real-Anthropic-API-key>`        | absent              | present | none                                                                           | not run | n/a                                                                          | n/a — host has no `ANTHROPIC_API_KEY` available; see §3.                                                |

Three supplementary Bearer variants were run to disambiguate fingerprint and
identity-header behavior:

| #   | Auth header                                  | `metadata.user_id`  | `tools` | Extra identity headers | HTTP | Notes                                                                                                                    |
| --- | -------------------------------------------- | ------------------- | ------- | ---------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------ |
| 4b  | `authorization: Bearer <ACCESS_TOKEN>`       | `00000000-0000-0000-0000-000000000000` (deliberately wrong) | present | none | 200  | Wrong `metadata.user_id` is accepted — Anthropic does **not** cross-reference the value against the token's account claim. |
| 4c  | `authorization: Bearer <ACCESS_TOKEN>`       | `<ACCOUNT_UUID>`    | present | none                   | 200  | Identity headers are not required for Bearer success.                                                                    |
| 4d  | `authorization: Bearer <ACCESS_TOKEN>`       | absent              | absent  | none                   | 200  | Bare minimum Bearer call succeeds. Without `tools`, `usage.input_tokens == 8` (vs `542` when tools are present).         |

## 2. What each row tells us

### Channel (rows 1–5 vs 4)

The `claudeAiOauth.accessToken` value extracted from
`~/.claude/.credentials.json` is rejected on the `x-api-key` channel with
`"invalid x-api-key"` regardless of whether `metadata.user_id` is supplied
(rows 1–3). The same token bytes succeed on `Authorization: Bearer …`
(row 4). The "X-Api-Key works for `sk-ant-oat-*`" community report referenced
in the issue body (`earendil-works/pi#2751`) appears to apply only to the
`CLAUDE_CODE_OAUTH_TOKEN` flavor minted by `claude setup-token`, not to the
`accessToken` field of the `/login`-issued subscription file. As of the run
date the only working channel for the `.credentials.json` accessToken is
Bearer.

### Fingerprint (rows 4, 4b, 4c, 5)

Anthropic's server does **not** validate `metadata.user_id` against the
token's account claim today: a deliberately-wrong UUID (row 4b), a correct
UUID without identity headers (row 4c), no metadata at all (rows 4, 4d), and
the full fingerprint pack (row 5) all return 200 with identical
subscription-billing headers. The hermes-claude-auth analysis predicted a
cross-check; we did not observe one on this account on this date.

This is a snapshot in time — Anthropic may turn the check back on. The
operational conclusion is: the proxy **need not** stage `~/.claude.json` or
any `account_uuid` into the in-VM filesystem to make today's Bearer call
succeed, but the proxy should be structured so that if a future 4xx
classifies as `metadata.user_id` mismatch the proxy can inject the operator's
`account_uuid` (and optionally Claude Code identity headers) on its own,
without re-staging anything into the guest. That keeps the fingerprint on
the host side where it belongs.

### Tools-overage classifier (rows 2, 4, 4b, 4c, 4d, 5)

We did not observe the 400 OAuth-overage response that
`NousResearch/hermes-agent#15080` referenced. Every Bearer call with
`tools: [...]` succeeded. We *did* observe that the server prepends a large
system prompt for tool-using Bearer calls: `usage.input_tokens == 542` for a
one-word user message when `tools` is present (rows 4, 4b, 4c, 5), versus
`usage.input_tokens == 8` for the same one-word message without `tools`
(row 4d). The most plausible explanation is that Anthropic injects the
Claude Code system prompt for OAuth-authenticated tool calls server-side and
counts those tokens against the subscription window. The proxy does not
need to compensate for this — Anthropic adds the bytes itself — but the β
issue should be aware that every tool-bearing agent request will burn the
extra ~540 tokens against the operator's Max budget.

### Billing routing (rows 1–5)

Every Bearer-success response carries the
`anthropic-ratelimit-unified-{5h,7d}-{status,reset,utilization}` family of
headers. The 5-hour and 7-day windows are Claude Max subscription concepts;
metered-API responses use `anthropic-ratelimit-{requests,input-tokens,output-tokens,…}-*`
headers instead. Each response also carried
`anthropic-ratelimit-unified-overage-disabled-reason: org_level_disabled`
plus `overage-status: rejected`, which is the Max plan's "no per-request
metered-overage" posture, and `anthropic-organization-id: <ORG_UUID>`
matching the operator's Claude Max `organizationUuid` from
`~/.claude.json`. The combination is a strong subscription-billing tell:
these requests are being charged against the Max plan's 5-hour / weekly
window, not as metered API usage.

## 3. Row 6 (control) — what we did not measure and why it's fine

Row 6 was specified as a control case: an `x-api-key: <ANTHROPIC_API_KEY>`
call to confirm the API path behaves as expected. The host running this
matrix has no `ANTHROPIC_API_KEY` available (no key in env, no `~/.anthropic`
directory, no key on disk). Adding one would require the operator to mint
and place a real Anthropic API key on the host. We did not do that because
the design decisions the matrix gates do not depend on it:

- The **channel** question is answered by rows 1–5 alone (the subscription
  token wants Bearer; the X-Api-Key channel is independent of whether a
  real API key would also work there).
- The **billing-routing** question is answered by the rate-limit header
  family observed on Bearer success: `unified-5h-*` / `unified-7d-*` plus
  `overage-disabled-reason: org_level_disabled` are subscription-side
  signals; a real-API-key request would carry the
  `anthropic-ratelimit-{requests,input-tokens,output-tokens}-*` family
  instead. We did not directly observe the API-key-side headers, but the
  presence of the subscription-side headers is itself sufficient evidence
  that Bearer subscription-token traffic is routed to the subscription
  budget, not metered usage.

If the operator later decides to validate row 6 — for example to confirm
the same model is reachable via metered API — the doc should be amended
with that observation; it does not change the recommendation below.

## 4. Recommendation for the credential-proxy (β)

**Pick `Authorization: Bearer <claudeAiOauth.accessToken>` as the proxy's
upstream auth header for the Anthropic profile, and do not stage
`~/.claude.json` (or any `account_uuid` derived from it) into the VM
filesystem.** Today's measurement says: the subscription `accessToken` works
on Bearer and only on Bearer; the server applies no `metadata.user_id`
fingerprint check; identity headers are not required; and the request is
billed against the Max subscription's 5h/7d window (not metered API). The
in-VM Claude Code therefore only needs `ANTHROPIC_BASE_URL` pointed at the
proxy plus a sentinel `ANTHROPIC_AUTH_TOKEN` (the per-dispatch bearer the
proxy validates and overwrites); the operator's subscription file and its
`oauthAccount` block stay entirely on the host. The proxy should still
expose a small seam — a header-set override on the upstream-rewrite step
— so that if Anthropic later re-activates the fingerprint check the proxy
can inject `metadata.user_id` (and Claude Code identity headers) host-side
from the same `~/.claude.json` it already has access to, with no guest-side
change. With this pick, the β design has no "depends on which channel"
branches left.

## 5. References

- `docs/research/credential-injection.md` §6 Option C — the proxy sketch this
  measurement validates.
- Issue #112 — defines the matrix and lists the prior-art links.
- Raw run artifacts (host-local, not committed): `/tmp/accept-matrix/row*/`
  contain `status.txt`, `headers.txt`, and `body.json` for each row.
