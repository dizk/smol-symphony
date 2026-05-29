# opencode / GitHub Copilot accept matrix for the credential-proxy (opencode α)

Status: research / decision + implementation (issue #130). Mirrors
`docs/research/codex-proxy-accept-matrix.md` (codex α, #116) and
`docs/research/credential-proxy-accept-matrix.md` (Anthropic α, #112) for the
opencode / GitHub Copilot side.

**Important provenance caveat.** Unlike the Anthropic matrix (#112, measured
live against `api.anthropic.com`), **none of the rows below could be measured
live by the implementer**: opencode is **not installed on the host** and there
is no `~/.local/share/opencode/auth.json` (the issue's stated operator
prerequisite). Every row is therefore **DOC-DERIVED** — synthesised from the
opencode source (sst/opencode → anomalyco/opencode), the official VS Code
Copilot Chat source (`microsoft/vscode-copilot-chat`), the published
`@ai-sdk/openai-compatible` package, and several independent real-world Copilot
proxies (ericc-ch/copilot-api, litellm, the JosXa opencode plugin). Rows that a
live opencode→Copilot dispatch would confirm are marked **`DOC-DERIVED (needs
live confirm)`**. The live end-to-end smoke (opencode-acp in a VM → proxy →
Copilot turn, GitHub OAuth token never in the VM) is **deferred to the operator**
(it needs a host with `opencode auth login` → GitHub Copilot completed), tracked
as a follow-up — the same posture #116 took for the codex billing-tell (#121).

Captured / implemented: 2026-05-29 (issue #130).

---

## 1. Credential flow (the shape this adapter implements)

```
opencode auth login → GitHub Copilot   (host, interactive device flow — operator one-time)
   └─ stores a durable GitHub OAuth token (gho_/ghu_) in
      ~/.local/share/opencode/auth.json under "github-copilot".refresh

per dispatch:
  VM:  opencode acp  ──POST {proxy}/chat/completions, Authorization: Bearer <sentinel>──▶  host proxy
       (custom @ai-sdk/openai-compatible provider "symphony-copilot",
        baseURL={env:OPENCODE_PROXY_BASE_URL}, apiKey={env:OPENCODE_PROXY_TOKEN})
  host proxy:
    1. validate sentinel → resolve opencode UpstreamProfile
    2. ensure a fresh Copilot token (cache miss / near-expiry →
       GET api.github.com/copilot_internal/v2/token, Authorization: token <gho_…>
       → { token, expires_at } → cache the short-lived Copilot token)
    3. swap Authorization: Bearer <copilot-token>, inject the Copilot editor
       headers, forward to api.githubcopilot.com/chat/completions
```

The **durable GitHub OAuth token never becomes the upstream bearer and never
enters the VM**. The VM only ever holds the per-dispatch sentinel
(`OPENCODE_PROXY_TOKEN`) + the proxy base URL (`OPENCODE_PROXY_BASE_URL`). This
is the codex/claude posture, with one extra host-side hop (the token exchange)
because the durable credential is not directly accepted by the inference API.

One Copilot credential unlocks **many models** (GPT-4o/4.1, Claude Sonnet,
Gemini, o-series, …) through one upstream — a single proxy profile gives
Symphony broad model choice.

---

## 2. Q1 — inference headers `api.githubcopilot.com/chat/completions` expects

**Answer (DOC-DERIVED):** a generic OpenAI-compatible client + proxy-injected
headers IS the accepted pattern (it is exactly how opencode's own
github-copilot provider works — a vendored `@ai-sdk/openai-compatible` wrapper +
a custom `fetch` that injects Copilot headers). The in-VM `@ai-sdk/openai-compatible`
client sends **none** of the Copilot headers, so the **proxy supplies them**
(`UpstreamProfile.egressHeaders` → `COPILOT_EGRESS_HEADERS` in
`src/agent/credential-proxy.ts`).

| Header | Value the proxy injects | Role | Confidence |
| ------ | ----------------------- | ---- | ---------- |
| `authorization` | `Bearer <exchanged copilot token>` | the bearer | DOC-DERIVED (every client) |
| `copilot-integration-id` | `vscode-chat` | **load-bearing** — GitHub rejects an unrecognised value | DOC-DERIVED (ericc-ch, litellm, JosXa, Alorse) |
| `editor-version` | `vscode/1.95.0` | editor identity (widens model allowlist) | DOC-DERIVED |
| `editor-plugin-version` | `copilot-chat/0.26.7` | editor identity | DOC-DERIVED |
| `user-agent` | `GitHubCopilotChat/0.26.7` | editor identity | DOC-DERIVED |
| `openai-intent` | `conversation-panel` | request intent | DOC-DERIVED |
| `x-github-api-version` | `2025-04-01` | API version pin | DOC-DERIVED |

Notes / why this set:

- The **two essential** headers per the Alorse community guide are
  `authorization` + `copilot-integration-id`. opencode's own minimal set adds
  `x-initiator`, `user-agent`, `openai-intent` (and conditional
  `copilot-vision-request`) but **omits** `editor-version`/`editor-plugin-version`/
  `copilot-integration-id`. Three independent real proxies (ericc-ch/copilot-api,
  litellm — caveat: litellm derives from copilot-api — and the JosXa opencode
  plugin) send the **fuller VS Code identity set**; that is the safer choice
  because **model-allowlist access is tied to the editor/client identity**.
- **Pinned values drift.** GitHub rolls `editor-version` /
  `editor-plugin-version` / `x-github-api-version` forward; a stale value may be
  silently downgraded or (on stricter routes) rejected. Bump these to mirror a
  current VS Code Copilot Chat release and re-verify here.
- `content-type: application/json` is sent by the in-VM client and passes
  through unchanged (the proxy preserves it).
- **Codex-class models are NOT reachable** via this provider: `gpt-5-codex` /
  `gpt-5.x-codex` are served on Copilot's `/responses` path, not
  `/chat/completions`, and return `unsupported_api_for_model` (a routing error,
  not a header/auth error). The pinned model set
  (`OPENCODE_PINNED_COPILOT_MODELS` in `src/agent/adapters.ts`) is restricted to
  chat-completions models (gpt-4o, gpt-4.1, o4-mini, claude-sonnet-4/4.5,
  gemini-2.5-pro).

**`DOC-DERIVED (needs live confirm)`:** the exact mandatory-vs-optional split is
route-dependent (individual `api.githubcopilot.com` vs Business/Enterprise
`api.business.githubcopilot.com`) and could not be corroborated by any
authoritative source.

---

## 3. Q2 — GitHub→Copilot token exchange

**Answer (DOC-DERIVED, multi-source):**

- **`GET https://api.github.com/copilot_internal/v2/token`** (GET, not POST —
  the issue body said POST; every verified client uses GET).
- The durable GitHub OAuth token is sent as **`Authorization: token <gho_…>`**
  (GitHub's classic-token scheme, **NOT** `Bearer`).
- Response JSON (confirmed against the official
  `microsoft/vscode-copilot-chat` `copilotToken.ts` schema): **`token`**
  (string — the short-lived Copilot bearer), **`expires_at`** (number, **unix
  SECONDS**), **`refresh_in`** (seconds), `sku`, and an optional **`endpoints`**
  object with `endpoints.api` (per-account API base URL). Minimal validator
  needs only `token` + `expires_at` + `refresh_in`.
- TTL is **server-driven** (`refresh_in`), observed **~25–30 min**; clients
  treat the token as stale ~5 min before `expires_at`.

Implemented in `src/agent/credential-proxy.ts`: `defaultCopilotExchange()` does
the GET with `Authorization: token <gho>` + `COPILOT_EXCHANGE_HEADERS` (editor
identity, **no** integration-id on the exchange call — ericc-ch's
`githubHeaders()` omits it there); `parseCopilotExchangeResponse()` reads
`token` + `expires_at`; `coerceCopilotExpiry()` converts seconds → ms so the
existing TTL-margin refresh logic fires before expiry → **no mid-session 401**.

**`DOC-DERIVED (needs live confirm)`:**
- `endpoints.api` routing — the implementation currently hardcodes
  `api.githubcopilot.com`. **Business/Enterprise Copilot accounts may return a
  different `endpoints.api`** (e.g. `api.business.githubcopilot.com`); honouring
  it is a follow-up (the proxy already has the `upstreamRoute` seam to do so).
- Client-id nuance: some third-party forks report that GitHub-App client ids
  (the `Ov23li…` prefix opencode historically used) **404** the exchange, while
  VS Code's OAuth-App id (`Iv1.b507a08c87ecfe98`) succeeds — and that the
  client id gates the model allowlist. We reuse **opencode's own stored token**
  and do **opencode's own exchange**, which works in opencode production
  (GitHub officially supports opencode since 2026-01-16), so this is not a
  blocker — but gated models may be narrower than VS Code's catalog.

---

## 4. Q3 — opencode `auth.json` shape

**Answer (DOC-DERIVED):** opencode stores credentials keyed by provider id at
`$XDG_DATA_HOME/opencode/auth.json` (default `~/.local/share/opencode/auth.json`).
The GitHub Copilot entry is an OAuth record under **`"github-copilot"`**:

```json
{ "github-copilot": { "type": "oauth", "refresh": "gho_…", "access": "<cached copilot token>", "expires": 1234567890 } }
```

The **durable GitHub OAuth token is under `refresh`**; `access`/`expires` cache
opencode's own exchanged short-lived Copilot token. The proxy reads **`refresh`**
(the durable token) and does its own exchange — it ignores opencode's cached
`access`. Env fallback precedence (confirmed):
**`COPILOT_GITHUB_TOKEN` > `GH_TOKEN` > `GITHUB_TOKEN`**.

Implemented: `opencodeGithubTokenFromAuth` (prefers `refresh`, tolerant of
alternate field names) + `opencodeGithubTokenFromEnv` +
`opencodeCredentialAvailable` + `hostOpencodeCredentialPath` (honours
`XDG_DATA_HOME`) in `src/agent/adapter-names.ts`. The startup probe
(`assertOpencodeCredential` in `src/orchestrator.ts`) fails fast when neither
source yields a token.

**`DOC-DERIVED (needs live confirm)`:** the exact `gho_`/`ghu_` prefix and
whether `refresh` holds the raw OAuth token vs a GitHub refresh token — the
field-name tolerance + env fallback cover the variants; a live `auth.json` would
confirm the exact key.

> ⚠️ **Operator note:** do **not** forward the durable GitHub token
> (`GH_TOKEN`/`GITHUB_TOKEN`/`COPILOT_GITHUB_TOKEN`) into the VM via
> `smolvm.forward_env`. The proxy reads it host-side for the exchange; planting
> it in the VM boot env (`/proc/1/environ`) would defeat the proxy. opencode in
> the VM uses the custom `symphony-copilot` provider (the sentinel), not the
> native github-copilot provider, so it does not need the GitHub token.

---

## 5. Q4 — `opencode acp` config + model selection

**Answer (MEASURED against opencode 1.15.12 source):**

- `opencode acp` starts the opencode server in-process and runs the **standard
  config pipeline** — there is no ACP-specific config path. It reads the **global
  config** `~/.config/opencode/{config.json,opencode.json,opencode.jsonc}`
  (`$XDG_CONFIG_HOME/opencode/…`) merged with project configs. Symphony stages
  the config at **`/root/.config/opencode/opencode.json`**
  (`OPENCODE_CONFIG_GUEST_PATH`) — global, not the project tree (avoids
  committing into the repo / colliding with a repo's own `opencode.json`).
- **Custom provider honoured:** `provider.<id>` with `npm`, `name`, `options`
  (`baseURL`/`apiKey` + arbitrary keys), `models`. We declare
  `provider.symphony-copilot.npm = "@ai-sdk/openai-compatible"`.
- **`{env:VAR}` interpolation supported** (empty string if unset), applied to
  every config value before parse. We use `{env:OPENCODE_PROXY_BASE_URL}` /
  `{env:OPENCODE_PROXY_TOKEN}`.
- **Model selection:** the config `model` key (`"<providerID>/<modelID>"`,
  split on the first `/`) is the default for ACP sessions — `session/new`
  carries no model. We set `model = "symphony-copilot/<resolved model>"`
  (`buildOpencodeConfig` in `src/agent/adapters.ts`). The provider block must
  exist even when no model is pinned, so the whole config (provider + model) is
  staged together (opencode's `modelInjection` is inert).
- **A non-empty `apiKey` is mandatory:** an openai-compatible provider with no
  apiKey throws `LoadAPIKeyError` → "Authentication required". `{env:OPENCODE_PROXY_TOKEN}`
  resolves to the per-dispatch sentinel, satisfying it.

**`DOC-DERIVED (needs live confirm)`:** that a live `opencode acp` dispatch picks
up the staged global config + custom provider + `{env:…}` and produces a turn
(the end-to-end smoke deferred to the operator).

---

## 6. Q5 — `/models` discovery

**Answer (MEASURED):** opencode does **NOT** issue `GET <baseURL>/models` for
OpenAI-compatible providers — not at startup, not on the model picker (the
`@ai-sdk/openai-compatible` v2.0.48 package hits only `/chat/completions`,
`/completions`, `/embeddings`, `/images/*`; never `/models`). For a custom
provider **not in the models.dev catalog, declaring `models` is REQUIRED** (it
is the only source of model entries). We pin an explicit `models` map; this is
load-bearing, not just an optimisation. (The proxy is path-transparent, so a
future `/models` call would forward fine regardless.)

Caveat (benign): opencode fetches `models.dev/api.json` in the background for
model metadata — unrelated to the proxy, no credential, can be disabled with
`OPENCODE_DISABLE_MODELS_FETCH` if total egress isolation is desired (at the
cost of context-limit metadata).

---

## 7. Implementation map (what landed where, issue #130)

- `src/agent/adapter-names.ts` — `opencode` in `AcpAdapterId`/`KNOWN_ADAPTER_IDS`;
  `hostOpencodeCredentialPath`, `opencodeGithubTokenFromAuth/FromEnv`,
  `opencodeCredentialAvailable`, `opencodeMissingCredentialMessage`.
- `src/agent/adapters.ts` — `opencode` `AdapterProfile` (`['opencode','acp']`,
  proxy strategy, `proxyEnv` `OPENCODE_PROXY_BASE_URL`/`OPENCODE_PROXY_TOKEN`,
  inert `modelInjection`); `buildOpencodeConfig` + `stageOpencodeConfig` +
  `OPENCODE_CONFIG_GUEST_PATH`.
- `src/agent/credential-proxy.ts` — opencode `UpstreamProfile`
  (`api.githubcopilot.com`, GitHub-token reader, in-memory Copilot-token cache,
  `defaultCopilotExchange` host-side exchange, `egressHeaders`, billing-tell
  candidates); `egressHeaders` seam on `UpstreamProfile` +
  `CopilotTokenExchange` test seam.
- `src/agent/runner.ts` — `stageAdapterExtras` opencode branch stages
  `opencode.json` → `/root/.config/opencode/opencode.json`.
- `src/orchestrator.ts` / `src/workflow.ts` — `assertOpencodeCredential` startup
  probe + validation-message text (mirrors the codex/claude precedent).
- `Smolfile` — pin `opencode-ai@1.15.12` (same reproducibility rationale as the
  pinned codex).

## 8. Open risks / needs-live-confirm (deferred to the operator)

1. **End-to-end smoke** — opencode-acp in a VM → proxy → Copilot turn, with the
   GitHub OAuth token verified absent from VM env/stderr and the proxy logging
   the `api.githubcopilot.com` call. Needs a host with `opencode auth login` →
   GitHub Copilot completed (interactive device flow, not headless).
2. **Exact inference header gate** (mandatory vs optional, individual vs
   Business endpoint) — see §2.
3. **`endpoints.api` routing** for Business/Enterprise Copilot — see §3.
4. **Billing-tell header** — `COPILOT_BILLING_TELL_HEADERS` is an UNMEASURED
   candidate set (same gap #116 carried for codex / #121).
5. **Version drift** — pinned `opencode-ai@1.15.12`, editor/plugin header
   versions, and `@ai-sdk/openai-compatible` behaviour roll forward; bump
   deliberately and re-verify against this doc.

## 9. References

- opencode ACP: https://opencode.ai/docs/acp/ · providers (custom
  openai-compatible): https://opencode.ai/docs/providers/ · config +
  `{env:VAR}`: https://opencode.ai/docs/config
- GitHub Copilot supports opencode (2026-01-16):
  https://github.blog/changelog/2026-01-16-github-copilot-now-supports-opencode/
- Token exchange + response schema: `microsoft/vscode-copilot-chat`
  `src/platform/authentication/common/copilotToken.ts`; ericc-ch/copilot-api
  `src/lib/api-config.ts`; BerriAI/litellm `litellm/llms/github_copilot/common_utils.py`.
- opencode source (config merge, custom provider, model selection, no `/models`
  discovery): sst/opencode → anomalyco/opencode `packages/opencode/src/{cli/cmd/acp.ts,acp/agent.ts,config/{config.ts,variable.ts,provider.ts}}`.
- Symphony precedent: #112/#116 (claude/codex proxy), #127 (codex custom-provider
  routing fix), `docs/research/codex-proxy-accept-matrix.md`,
  `docs/research/credential-proxy-accept-matrix.md`.
