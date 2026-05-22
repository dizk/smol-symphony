# Research: avoiding credential-file injection into the VM

Status: research / pre-design. No code changes proposed yet — the goal of this
note is to land on a direction.

## 1. What we do today

`stageCredential` in `src/agent/adapters.ts` copies the host's adapter
credential file (`~/.claude/.credentials.json` or `~/.codex/auth.json`) into
the per-issue workspace under `.git/symphony-runtime/credentials/<id>` (or
`.symphony-runtime/` when the workspace has no `.git/`). The workspace is
bind-mounted into the smolvm guest at the same absolute path, and
`deriveAcpCommand` emits a bash prelude that `cp`s the staged file into the
adapter's expected location inside the VM — `/root/.claude/.credentials.json`
for claude-agent-acp, `/root/.codex/auth.json` for codex-acp — before
exec'ing `vm-agent.mjs`.

Once that copy has run, the credential's bytes are physically present in two
places the in-VM agent can read with no privilege escalation:

1. the staged copy under the bind-mounted workspace
   (`<workspace>/.git/symphony-runtime/credentials/<id>`), and
2. the adapter's expected guest path (`/root/.claude/.credentials.json` etc.).

`README.md`'s "Trust posture" section calls this out as the intended posture:
"Credentials are never bind-mounted from the host. Symphony copies the single
credential file into a per-workspace location … and refuses to operate on
workspaces inside the credential file's ancestor repo." That guards against
the host filesystem leaking into the VM, but it does not stop the in-VM agent
from reading the staged file — it is already inside the mount.

## 2. What's actually in the file

For `~/.claude/.credentials.json` the schema (subscription OAuth) is:

```
claudeAiOauth.accessToken
claudeAiOauth.refreshToken
claudeAiOauth.expiresAt
claudeAiOauth.scopes.[]
claudeAiOauth.subscriptionType
claudeAiOauth.rateLimitTier
```

For `~/.codex/auth.json` (ChatGPT-managed sessions): `auth_mode`,
`OPENAI_API_KEY`, and a `tokens` object holding `id_token`, `access_token`,
`refresh_token`, `account_id`, plus `last_refresh`.

The high-blast-radius secret in both files is the **refresh token**: it is
long-lived (≫ a session), can mint new access tokens at will, and is
equivalent to the user's subscription credentials. A compromised or
ill-behaved agent inside the VM can read it from the staged file and
exfiltrate it through any network path the VM has — and `smolvm.net: true`
is the default.

Access tokens are short-lived (Codex's are ~10 days; Anthropic's subscription
OAuth access tokens are shorter). Exposure of an access token alone is a
much smaller incident than exposure of the refresh token.

## 3. Threat model and goals

We want to keep the **refresh token** off the VM filesystem. The host is
trusted. The in-VM root user is treated as untrusted with respect to
host-issued credentials — even though the operator launched the agent, a
compromised agent (e.g. via a prompt-injected file from a tracker issue, a
malicious npm install, an adapter bug) must not be able to extract
subscription credentials.

Out of scope for now: hiding the *access* token from the in-VM root user
entirely. Process env vars (visible in `/proc/<pid>/environ`) and outbound
network sockets are visible to root inside the VM by definition; we accept
that. The goal is to constrain what an in-VM compromise yields to "one
short-lived access token", not "permanent subscription takeover".

Must work with both:

- **API key auth** (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`).
- **OAuth** (Anthropic subscription OAuth in `~/.claude/.credentials.json`;
  ChatGPT-managed OAuth in `~/.codex/auth.json`).

The mechanism must work against stock `claude-agent-acp` and `codex-acp` —
we do not fork the adapters.

## 4. Reference: how Docker Sandbox (sbx) avoids the problem

Docker sbx is a microVM-based agent sandbox shipped by Docker. Its
credential posture is documented at
`https://docs.docker.com/ai/sandboxes/security/credentials/` and
`https://docs.docker.com/ai/sandboxes/agents/claude-code/`. The relevant
mechanics:

- Each sandbox has a host-side HTTP/HTTPS proxy. *"The only way traffic can
  leave a sandbox is through an HTTP/HTTPS proxy on your host."*
- Credentials live in the host's OS keychain (`sbx secret set -g anthropic`,
  `sbx secret set -g openai`, …). They never enter the sandbox.
- The sandbox is configured with sentinel env values (e.g.
  `ANTHROPIC_API_KEY=proxy-managed`). The proxy *"looks up the matching
  credential on the host, and overwrites the auth header before
  forwarding."* — the real key is attached on the host side, in flight.
- For OAuth: *"If no API key is set, Claude Code prompts you to
  authenticate interactively using OAuth. The proxy handles the OAuth flow,
  so credentials aren't stored inside the sandbox."*
- *"Sandboxes don't pick up user-level configuration from your host, such
  as `~/.claude`."*

Two operating modes are documented:

- **Forward proxy.** Sandbox uses an explicit forward proxy (presumably via
  `HTTPS_PROXY`); the proxy handles MITM TLS using its own CA, which the
  sandbox trusts. Credential injection works here.
- **Transparent proxy.** Outbound traffic is redirected at the network
  layer. Policy is enforced but credential injection is not available
  because the client opens TLS directly to the upstream.

The architectural property to copy: **the secret lives only on the host;
the sandbox is parameterized with the upstream URL plus a sentinel header,
and a host-side mediator attaches real credentials on egress.**

## 5. What the adapters give us to work with

### claude-agent-acp / Claude Code

Claude Code's auth precedence (from
`https://code.claude.com/docs/en/authentication`):

1. `CLAUDE_CODE_USE_BEDROCK` / `_VERTEX` / `_FOUNDRY` — cloud provider creds.
2. `ANTHROPIC_AUTH_TOKEN` — sent as `Authorization: Bearer …`.
3. `ANTHROPIC_API_KEY` — sent as `X-Api-Key`.
4. `apiKeyHelper` — a shell script Claude Code invokes to obtain a key. Re-run
   every `CLAUDE_CODE_API_KEY_HELPER_TTL_MS` (5 min default) or on HTTP 401.
   Its output is used as the API key (X-Api-Key channel).
5. `CLAUDE_CODE_OAUTH_TOKEN` — long-lived (one year) OAuth token generated
   by `claude setup-token`. CI/script-friendly. *"This token authenticates
   with your Claude subscription"* — it is scoped to inference only and
   does not require refresh.
6. Subscription OAuth from `/login` (the `.credentials.json` file).

Also: `ANTHROPIC_BASE_URL` redirects all API traffic to a custom endpoint
(`https://code.claude.com/docs/en/authentication` references it for
"LLM gateway or proxy" use).

### codex-acp / Codex

Codex auth precedence (`https://developers.openai.com/codex/auth`):

1. `CODEX_ACCESS_TOKEN` (passed in via `codex login --with-access-token`).
2. `OPENAI_API_KEY` (passed in via `codex login --with-api-key`).
3. `~/.codex/auth.json` (either API key or ChatGPT OAuth tokens).

Codex's ChatGPT-managed session knows how to refresh its own tokens against
OpenAI's auth endpoint and writes the new tokens back to `auth.json` — so
unlike Anthropic, a long-lived no-refresh token is not natively supported;
the refresh token is required for sessions longer than ~10 days.

## 6. Option space

### Option A — Env vars only (no file)

Skip `stageCredential` entirely. Forward credentials via the existing
`smolvm.forward_env` channel as env vars.

| Auth mode                       | Env var to forward             | Operator action            |
| ------------------------------- | ------------------------------ | -------------------------- |
| Anthropic API key               | `ANTHROPIC_API_KEY`            | none (already supported)   |
| Anthropic subscription          | `CLAUDE_CODE_OAUTH_TOKEN`      | `claude setup-token` (1×)  |
| OpenAI API key                  | `OPENAI_API_KEY`               | none                       |
| ChatGPT subscription            | `CODEX_ACCESS_TOKEN`           | refresh every ~10 days     |

Pros:

- Zero new moving parts: just stop staging the file, switch
  `smolvm.forward_env` defaults, and document the setup-token step.
- The refresh token never crosses the VM boundary in any form.
- Composes with `CLAUDE_CODE_USE_BEDROCK` etc. with no changes.

Cons:

- For Anthropic subscription, requires `claude setup-token` (one-time, but
  the resulting token is a year-long inference token — *not* worse than the
  refresh token currently injected, and is the
  documented CI path).
- For ChatGPT subscription, `CODEX_ACCESS_TOKEN` expires; symphony cannot
  refresh it because OpenAI requires the refresh token to refresh, and that
  is exactly what we want to keep off the VM. Either we accept periodic
  re-login on the host (operator-visible) or we go to Option C for codex
  subscription users.
- Env vars are visible to any in-VM process at `/proc/<pid>/environ`. With
  one user in the VM that is a non-issue; document the boundary.

### Option B — `apiKeyHelper` callback to host

Set claude-agent-acp's `apiKeyHelper` setting (already pluggable via the
adapter's `settings.json`, which symphony already stages for the effort
knob) to a small script that dials the host orchestrator over a new local
endpoint, exchanges a per-dispatch bearer for a fresh API token, and
prints it on stdout. Claude Code calls the helper every 5 min by default
and on every 401.

Pros:

- Refresh token stays on host. Symphony does the OAuth refresh dance
  against `https://console.anthropic.com/v1/oauth/token` (or the
  subscription-OAuth equivalent) and hands the access token back through
  the helper.
- Reuses the existing TCP bridge primitive (`AcpBridge` / `register()`) —
  per-dispatch bearer token, host loopback only.
- Anthropic-blessed extension point.

Cons:

- The helper's output is used as `X-Api-Key`, not as `Authorization:
  Bearer`. Subscription OAuth access tokens are Bearer credentials —
  whether they work through the X-Api-Key channel is *not documented* and
  needs verification against the SDK. If they do not, this option only
  helps rotating API-key vault setups, not subscription OAuth.
- Codex has no equivalent helper hook; would need Option C anyway.

### Option C — Host-side HTTPS proxy (Docker sbx pattern)

Run a per-issue HTTPS proxy on host loopback. Configure the VM with
`ANTHROPIC_BASE_URL=http://127.0.0.1:<port>` and a sentinel
`ANTHROPIC_AUTH_TOKEN` (or none). The proxy:

1. Accepts plain HTTP from the VM (no MITM CA cert needed in the VM).
2. Strips the inbound Authorization header.
3. Re-attaches the real Authorization header — either a constant API key
   or a current OAuth access token managed by symphony on the host,
   refreshed against the upstream OAuth endpoint as needed.
4. Opens TLS to `api.anthropic.com` (or `api.openai.com` for the codex
   profile) and forwards the request.

Pros:

- Refresh token, full `.credentials.json`, never leave the host. This is
  the Docker sbx posture, applied directly.
- Single mechanism works for API key + OAuth + future auth modes — proxy
  is opaque to the choice.
- Symphony already has the pieces to build this: `AcpBridge` is a
  per-dispatch host-side TCP listener with bearer auth; the credentials
  proxy is the same pattern with HTTP request/response framing instead of
  raw byte forwarding.
- Codex works the same way via `OPENAI_BASE_URL` (the OpenAI SDK respects
  it, and codex-acp delegates to that SDK).

Cons:

- We now own an HTTP proxy that mirrors enough of the Anthropic + OpenAI
  HTTP surface to forward arbitrary requests. In practice this is a
  ~150-line `http.createServer` that proxies the request as-is (we don't
  parse the body, only rewrite headers).
- We have to own the OAuth refresh dance for subscription users — fetching
  a new access token from the refresh endpoint when the current one
  expires. The same dance Claude Code / Codex already do, just moved
  host-side.
- Requires verifying that `ANTHROPIC_BASE_URL=http://127.0.0.1:…` is
  accepted by the SDK (no upgrade to HTTPS); the docs imply yes — the
  SDK uses the URL verbatim — but worth confirming against the SDK source
  before committing to this.
- The MCP server in symphony already listens on host loopback for the
  in-VM agent. A second loopback endpoint is fine but does need a
  separate bearer namespace to keep authz separated.

### Option D — Read-once filesystem (rejected)

Mount the credential as a special FS that returns the file on first read
and an empty file afterwards. smolvm has no facility for this and it
would not stop a fast attacker. Mentioned only to close the option.

### Option E — Stage only the access token, refresh on host (partial)

Keep the file path, but parse `.credentials.json` host-side and write a
new file into the VM containing only `accessToken` (plus enough fields
that the adapter loads it without erroring) — no `refreshToken`. On 401,
symphony detects it (via a runtime event or a re-dispatch), refreshes
host-side, restages.

Pros: minimal API surface change inside symphony; works for both adapters.
Cons: brittle (depends on how each adapter reacts to a 401; we'd need to
re-stage mid-attempt, which the current architecture doesn't do; the
short-lived access token is still on the VM filesystem). Mostly a
fallback if Option C turns out to be infeasible.

## 7. Recommendation

A layered policy with Option A as the default and Option C as the
fallback for subscription OAuth:

1. **Default = env vars only (Option A).** Stop staging the credential file
   whenever a sufficient env var is available on the host:

   - `ANTHROPIC_API_KEY` set → forward, no file.
   - `CLAUDE_CODE_OAUTH_TOKEN` set → forward, no file.
   - `OPENAI_API_KEY` set → forward, no file.
   - `CODEX_ACCESS_TOKEN` set → forward, no file.

   Documentation gains a one-paragraph "for subscription users, run
   `claude setup-token` once" note alongside the existing `gh auth login`
   guidance.

2. **Fallback = host-side credentials proxy (Option C)** for operators who
   have only `.credentials.json` / `auth.json` and either cannot or will
   not generate a long-lived token. Symphony runs a per-issue HTTP proxy
   on loopback, parameterizes the VM with `ANTHROPIC_BASE_URL` /
   `OPENAI_BASE_URL` + sentinel auth, and handles OAuth refresh on the
   host. Same architecture for both adapters.

3. **Legacy file-staging path** becomes an explicit opt-in (a workflow
   knob, e.g. `acp.credentials_mode: file`) for operators who want to
   keep the existing behavior during a transition window. Default flips
   away from it.

This sequencing gives us a small, high-leverage first PR (Option A: stop
staging when env vars suffice; this likely covers 90% of operators) and a
follow-up that introduces the proxy for subscription OAuth without
blocking on the simpler change.

## 8. Implementation sketch (for the follow-up tickets)

### 8.1 Env-var-only mode

- `AdapterProfile` gains an env-derivation step: given the current
  `process.env`, return a list of env vars to forward and a decision
  about whether to skip credential staging.
- Wire that into `runAttempt` between the existing model/effort injection
  block and the `stageCredential` call.
- When env-only mode is in effect, `deriveAcpCommand` skips the `cp …
  /root/.claude/.credentials.json` line and the prior `rm -rf` /
  `mkdir -p` of `guestDir` — there's no file to deposit.
- `assertHostCredentialReadable` becomes "assert at least one acceptable
  credential mechanism is reachable" — env var OR file.
- Tests: extend the existing adapters / runner unit tests with a case
  per (adapter × env-var-present × file-present) combination.

### 8.2 Host-side credentials proxy

- New module `src/agent/credential-proxy.ts` modelled on
  `src/acp-bridge.ts`:

  - `start(host, port)`, `port()`, `stop()` lifecycle identical.
  - `register(issueId, identifier)` returns `{ token, baseUrl }` instead
    of `{ token, accepted }`. Caller stages `<baseUrl>` as
    `ANTHROPIC_BASE_URL` (and/or `OPENAI_BASE_URL`) into the VM env
    plus the bearer as `ANTHROPIC_AUTH_TOKEN=<bearer>` (so the VM agent
    presents *something*; the proxy will validate and overwrite).
  - On incoming request: validate the bearer against `pending`, look up
    the host-side credential state, refresh the OAuth access token if
    expired, proxy the request to the upstream with the real
    Authorization header, stream the response back.

- New module `src/agent/oauth-refresh.ts`: pure host-side function that
  reads `.credentials.json`, refreshes the access token against the
  Anthropic auth endpoint when `expiresAt` is past, writes back to the
  host file. (Critically: the host file. The VM never sees this.)
- Workflow knob: `acp.credentials_mode: env | proxy | file` (default
  resolved at dispatch time based on what is available).

### 8.3 Risks to verify before committing

- `ANTHROPIC_BASE_URL` with `http://` scheme — does the Anthropic SDK
  accept it without upgrading to HTTPS? `claude-agent-acp` delegates to
  the SDK so this needs to be tested with a fixture proxy.
- Codex `OPENAI_BASE_URL` semantics for ChatGPT-OAuth mode (does codex
  short-circuit to the OAuth endpoint regardless of base URL?).
- 401 behavior — symphony's `apiKeyHelper` (Option B) or proxy refresh
  needs to be fast enough to keep up with Claude Code's expectation.
- Smolvm's `127.0.0.1` rewrite: we already rely on it for the ACP TCP
  bridge and MCP HTTP endpoint, so the proxy gets it free.

## 9. Out of scope

- Hiding the in-VM access token from the in-VM agent. The agent is the
  one making API calls; access tokens unavoidably traverse its process.
  The point of this work is to keep refresh tokens off the VM, not to
  hide access tokens from a process that has legitimate use of them.
- A general "vault" abstraction. We have two adapters; do the concrete
  thing for both and design the registry hook for future adapters
  alongside.

## 10. References

- Docker Sandbox credentials docs:
  `https://docs.docker.com/ai/sandboxes/security/credentials/`
- Docker Sandbox Claude Code adapter docs:
  `https://docs.docker.com/ai/sandboxes/agents/claude-code/`
- Docker Sandbox network policy docs:
  `https://docs.docker.com/ai/sandboxes/security/policy/`
- Claude Code authentication:
  `https://code.claude.com/docs/en/authentication`
- Codex authentication:
  `https://developers.openai.com/codex/auth`
- This repo: `src/agent/adapters.ts` (current staging), `src/acp-bridge.ts`
  (TCP bridge pattern to mirror), `src/agent/runner.ts` (where staging is
  invoked).
