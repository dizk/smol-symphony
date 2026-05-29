# Research: Gondolin sandbox migration — replace smolvm + the credential-proxy transport

Status: research / pre-design (2026-05-29). No code yet. Companion to
`docs/research/credential-injection.md`,
`docs/research/credential-proxy-accept-matrix.md`, and
`docs/research/tmux-agent-transport.md`. **Revised after a codex review
(2026-05-29, gpt-5.5/xhigh)** — see the change log at the end; the review's
findings are folded into §3, §4.2-§4.4, §6, §7.

**Goal:** decide whether to rebase Symphony's isolation + secret-injection layer
onto [`@earendil-works/gondolin`](https://github.com/earendil-works/gondolin),
replacing (a) the `smolvm` CLI microVM backend and (b) the **transport half** of
the host credential proxy. The thesis (operator, 2026-05-29): Gondolin gives us a
**much cleaner basis** — microVM isolation, egress allowlisting, and per-host
secret injection are exactly Gondolin's three pillars, and it's the same Node/TS
runtime, so it integrates as an SDK instead of CLI-shelling.

This doc is the input to a codex review. Sections marked **[VERIFIED]** were read
from Gondolin source / our source; **[UNVERIFIED]** must be proven in the spike
(§7) before we commit.

---

## 1. Why

Two independent pains, one substrate:

1. **smolvm coupling & bugs.** The `smolvm` CLI backend carries an open
   `_boot-vm` orphan leak (`machine delete` is a config op, not a runtime stop —
   see `project_vm_reaper_blindspot`), a hard **3-mount virtio-fs cap** that
   forced us to bake `scripts/` into the image (commit `ba1b520`; a 4th mount
   makes `krun_start_enter` return `-22`), and per-issue workspace-base staleness
   tied to the reconciler. It is also a CLI we shell out to (`src/agent/smolvm.ts`),
   not a library.

2. **credential-proxy size.** `src/agent/credential-proxy.ts` is ~1300 lines.
   Most of that is *not* the secret plumbing — it is the HTTP server, per-dispatch
   sentinel minting, bearer validation, upstream forwarding, and SSE piping. The
   genuinely irreducible part is the **credential lifecycle** (refresh, flock,
   re-read, mint). Gondolin absorbs the transport; the lifecycle re-homes to a
   small module.

Gondolin's tagline is literally "Sandboxed VM Environment for AI Agents":
compute isolation (microVM), network egress control, and secrets protection from
exfiltration. That is our whole isolation + injection stack in one dependency.

---

## 2. What Gondolin is **[VERIFIED]**

- **Runtime / license:** Node.js/TypeScript, npm `@earendil-works/gondolin`,
  Apache-2.0. Guest sandbox layer in Zig. Repo self-describes as
  **"Experimental Linux microvm setup with a TypeScript Control Plane as Agent
  Sandbox"** — maturity is a real risk (§6). A Rust port (`gondolin-rs`) exists.
- **VM backend:** QEMU (default) or libkrun (optional); boots <1s. `VM.create(opts)`
  / `vm.exec(...)` / `vm.close()`. `vm.exec` supports `stdin: true`, `pty: true`,
  `buffer: false`, `signal`, plus `vm.shell()` and `proc.output()` streaming —
  i.e. interactive bidirectional stdio **is** available (we don't need it; see §4.2).
- **VFS:** programmable mounts (`vfs: { mounts: { '/workspace': new RealFSProvider(cwd) } }`).
  No fixed mount cap of the smolvm kind.
- **Network stack** (`host/src/qemu/network-stack.ts`): a **selective protocol
  proxy**, *not* a gVisor-style full netstack. The host attaches to QEMU's
  `-netdev stream` unix socket and classifies the first bytes of each outbound TCP
  flow as `http` / `tls` / `ssh` / `unknown-protocol` (unknown denied by default).
  UDP only port 53 (DNS); ICMP synthetic.
  - **Egress is allowlist-gated HTTP/TLS** via `createHttpHooks({ allowedHosts })`.
  - **Raw-TCP escape hatch:** `tcp.hosts` mappings — a matched flow is forwarded to
    a configured upstream `HOST:PORT`. This is how non-HTTP egress (e.g. our ACP
    bridge) is expressed.
  - **HTTPS works via TLS MITM** (`network.md` "HTTPS via TLS MITM"): the host
    reads the ClientHello SNI, presents a dynamically-generated cert signed by a
    **local Gondolin CA**, terminates TLS, recovers the plaintext HTTP request,
    runs hooks + secret substitution, then re-`fetch`es upstream over a fresh
    host→origin TLS (with a connect-time IP re-check for DNS-rebinding). **The
    guest must trust the Gondolin CA** — Gondolin caches a CA keypair on the host
    and makes the cert available inside the guest. This is the only way a
    placeholder inside an HTTPS `Authorization` header can be substituted, and it
    is a **new dependency** vs. today's proxy (where the guest dials a plain-HTTP
    loopback proxy, no MITM). See §7 A-2 for the CA-trust spike check.
    **CA hygiene (codex re-review — confirm against Gondolin source):** Gondolin
    generates a *persistent* host CA (reportedly under `~/.cache/gondolin/ssl`),
    injects `/etc/gondolin/mitm/ca.crt`, and guest init exports `SSL_CERT_FILE` /
    `CURL_CA_BUNDLE` / `REQUESTS_CA_BUNDLE` / `NODE_EXTRA_CA_CERTS`. Risk: one
    long-lived CA key becomes shared trust material across unrelated VMs/runs.
    Require a per-run (or per-Symphony) `mitmCertDir` with protected perms + a
    rotation/cleanup policy. Config constraint: if VFS is disabled or `/etc/gondolin`
    is shadowed, Gondolin skips the MITM mount and TLS breaks.
  - **Guest → host loopback is blocked by default.** Host → guest is the supported
    direction: `SandboxServer.openTcpStream()` opens a TCP stream to a guest
    loopback service over a dedicated virtio-serial port (`sandboxingress`),
    loopback-only.
- **Secrets** (`host/src/http/hooks.ts`):
  - `SecretDefinition = { hosts: string[]; value: string; placeholder?: string | (() => string) }`.
    **`value` is a static string — there is NO value callback.** Only `placeholder`
    may be a function, and it is called **once** at `createHttpHooks()` time.
  - `createHttpHooks(...)` returns `{ httpHooks, env, allowedHosts, secretManager }`.
    **`secretManager.updateSecret(name, { value?, hosts? })`** mutates the live
    secret value at runtime; `deleteSecret(name)` blanks it.
  - Substitution runs **per request**: `applySecretsToRequest` reads the *current*
    `entry.value` on every outbound request, substituting the placeholder in
    headers (incl. `Authorization: Basic` decode/re-encode), optionally query
    strings; **never** body, URL path, or response content.
  - **Rotation is enforced:** `updateSecret` pushes the old value into
    `revokedValues`; `assertSecretValuesAllowedForHost` then **throws
    `secret <name> revoked for host`** if a later request still carries a revoked
    value. So a rotated-out token is actively blocked at egress.
  - **`onRequest` / `onResponse` hooks:** `onRequest(req)` receives a WHATWG
    `Request` and may return `undefined` (unchanged), a **modified `Request`**, or
    a `Response` (short-circuit/block). **CORRECTION (codex review):** a returned
    `Request` **can** change the upstream URL — host/authority, path, and method
    — and the HTTP bridge fetches the rewritten URL (`hooks.ts:267-284`,
    `host/src/qemu/http.ts:1293-1377`). An earlier draft (from a doc summary) wrongly
    claimed it could not; that constraint does not exist. **Ordering:** the
    user-supplied `onRequest` runs **before** secret substitution ("Inject secrets
    at the last possible moment (after rewrites)", `hooks.ts:284`), so the hook
    normally sees *placeholders*, not real values — but Gondolin's docs warn there
    is **no general guarantee**. Rule: do not rely on hook ordering, and **never
    log auth headers/URLs from a hook**. Security consequence of host rewrite: a
    rewritten URL re-keys which `allowedHosts` / `isIpAllowed` check applies and
    which secret's `hosts` allowlist matches — a rewrite is powerful and must be
    audited (see §4.4). `onResponse(res, req)` may observe/modify the response.

---

## 3. The governing invariant — host-only refresh **[load-bearing]**

We use **subscription OAuth**, not an API key. The credential is
`claudeAiOauth.accessToken` from `~/.claude/.credentials.json` (~8h TTL), used as
a bearer. The OAuth **`refreshToken` must NEVER leave the host.** If a VM held the
refresh token, an in-VM agent could rotate it; rotation-on-use invalidates the
host's copy → credential poisoning / repeated `/login` during fleets
(`project_credential_rotation_poisoning`). This invariant already lives in
`extractClaudeToken` (credential-proxy.ts:975-985 — reads `accessToken` +
`expiresAt`, never `refreshToken`).

**Gondolin will enforce this invariant more strongly than the current proxy —
four layers (1-2 load-bearing, 3-4 defense-in-depth). NOTE (codex re-review):
layer 2 is not built yet; until it is, layer 1 is a convention, not a control —
the "enforced" wording below is the TARGET state, not today's code:**

1. **Structural — the *durable* secret never enters the guest.** Only short-lived
   bearers go into `secrets.value`; the guest env/files hold only a placeholder, and
   Gondolin swaps the real value in at egress. We never stage a real
   `~/.claude/.credentials.json`, never mount `~/.claude`, never put a real refresh
   token in env. **Scope caveat (codex Critical):** Gondolin substitution is
   **host-scoped, not path-scoped** — a placeholder scoped to a host is substituted on
   *any* path of that host, so the guest can make the host spend the real token on
   arbitrary endpoints of an allowlisted host unless we add an `onRequest` method/path
   allowlist (§3.4, §4.4). **Per-adapter exposure (uniform):** for **all three** adapters the guest sees only
   a placeholder — never the access or durable token. (opencode's *native
   self-exchange* would have been the one exception — it lands a real short-lived
   Copilot token in-guest — so per the operator's **"no real tokens in the VM"** rule
   we use **host-mint** for opencode, keeping it identical to claude/codex; see §4.4.)

2. **Active enforcement — "we won't mount it" is not enough (codex Critical).**
   Layer 1 is a *convention* unless the runner actively refuses to expose
   credential material, and the current runner does not fully guard this surface:
   - `buildVmMounts` (runner.ts:1221-1235) mounts the workspace **plus arbitrary
     operator-configured `smolvm.volumes`** with no denylist. A misconfigured
     volume (`~`, `~/.claude`, `~/.codex`, opencode auth, a `.env`) would plant
     refresh material in the guest. **Read-only is still enough to rotate a refresh
     token.** Requirement: under Gondolin mode, hard-fail VM creation if any mount
     resolves under a credential path (denylist + path-canonicalization), and
     forbid mounting host home dirs.
   - `buildForwardedEnv` (runner.ts:1247-1251) **already** drops the *dispatched*
     proxy adapter's token var so it can't leak via `/proc/1/environ` — good, but
     it omits only that one var. Requirement: strip **all** known credential env
     vars (every adapter's token var + `*_API_KEY`/`*_TOKEN` families), not just
     the active adapter's.
   - Build-time image `env` must carry no secrets either (Gondolin guidance: "Do
     not pass real secrets via `VM.env` or image build config `env`").

3. **Mode — the client runs native, with FAKE credential files (operator
   decision, 2026-05-29).** Instead of per-client env-bearer mode (which couples us
   to each client's bearer-env + custom-base-URL behavior and breaks on vendor
   churn), **stage fake native credential files for every adapter**
   (claude/codex/opencode) holding only **placeholders**, and let each client run in
   its **normal native mode** dialing its **real** upstream. The client has "zero
   clue" it is intercepted; Gondolin substitutes placeholder→real at egress (§2).
   This is the generic, churn-resistant path and the point of Gondolin. *(This is
   staging generated fake content at the guest credential paths — distinct from §3.2,
   which forbids mounting/forwarding the HOST's real credential files/env.)*
   **The invariant holds because the staged refresh/durable token is FAKE** — the
   real refresh token never leaves the host:
   - **claude:** fake `~/.claude/.credentials.json` = `{ claudeAiOauth: {
     accessToken: <token-shaped placeholder>, refreshToken: <junk>, expiresAt:
     <far future> } }`. Far-future expiry ⇒ no proactive refresh; Gondolin swaps the
     real access token at egress; the fake refresh token is worthless and the OAuth
     token endpoint is egress-blocked (§3.4). (Still stage the scrubbed
     `~/.claude.json` identity, adapters.ts:412-450.)
   - **codex:** to dial the ChatGPT backend natively, codex needs a fake
     `~/.codex/auth.json` with a `tokens` block (placeholder access_token +
     `account_id` + junk refresh_token). **NB (codex review):** this is a DIFFERENT
     schema than the fake auth.json we stage today, which is **apikey-mode**
     (`{OPENAI_API_KEY, auth_mode:'apikey'}`, adapters.ts:453) and never enters an
     OAuth handshake. The OAuth shape reintroduces a refresh surface → §7 C7 spikes
     apikey-mode + `onRequest` rewrite as the lower-risk alternative. See §4.4.
   - **opencode:** fake auth.json with a placeholder GitHub token ⇒ opencode runs its
     own GitHub→Copilot exchange; Gondolin substitutes the real GitHub token on that
     call. See §4.4 for the in-guest-Copilot-token tradeoff.
   **Residual failure mode (availability, NOT security):** on a transient upstream
   401 (host refresh lag) a **claude/codex** client may attempt a doomed refresh →
   blocked at egress → the turn fails → orchestrator retry. The host ticker keeping
   the real token fresh makes this rare; it never rotates the real token. This is the
   bounded price of "zero clue." *(opencode is different: its GitHub→Copilot exchange
   endpoint is intentionally **allowed**, so opencode mints fresh Copilot tokens
   normally throughout the VM's life — not "doomed"; the guard there is the §4.4
   path-allowlist, not a block.)*

4. **Network — block the refresh endpoint (contingent, NOT yet guaranteed).**
   This layer is **aspirational until the spike pins the exact refresh host/path**
   (**[UNVERIFIED]** — possibly `console.anthropic.com/.../oauth/token`, possibly
   same-host as inference). Caveats that defeat a naive block:
   - If refresh is **same-host** as inference, `allowedHosts: ['api.anthropic.com']`
     does **not** block it — we need explicit **method/path policy** (an `onRequest`
     that 403s the token path), not just a host allowlist.
   - Gondolin's `tcp.hosts` **mapped TCP bypasses HTTP hooks/secret substitution**
     entirely (security.md) — so a mapped-TCP route must never reach a refresh
     endpoint, or it sidesteps this layer.
   - Allowed hosts can receive arbitrary guest-readable data (egress to an allowed
     host is trusted). So this layer reduces, not eliminates, exfil risk.
   Until proven, do **not** claim "a stolen refresh token cannot rotate." Claim
   only: "a guest with no refresh token (layers 1-3) has nothing to rotate; layer 4
   is added defense-in-depth pending endpoint identification + a path-policy test."

**Host-only refresh stays exactly as today:** the host owns the credentials file
alone; `claude -p` under `flock(2)` performs the refresh (single owner → no
cross-copy rotation poisoning); `credential-ticker.ts` re-reads on expiry/idle and
pushes the fresh access token via `secretManager.updateSecret('ANTHROPIC_AUTH_TOKEN',
{ value })`. The `flock` cross-process lock is **retained** — it serializes refresh
across multiple Symphony processes sharing one credentials file, which is
Gondolin-independent.

> Net: "only the host refreshes" rests on layers 1-3 (no durable token in guest,
> actively enforced, client runs native) with layer 4 (egress path-policy, incl. an
> `onRequest` method/path allowlist because substitution is host-scoped not
> path-scoped) as defense-in-depth once endpoints are pinned. The strongest layers are 1+2; the
> codex review's point is that **layer 1 is only as strong as layer 2's
> enforcement** — convention is not a control. Today's proxy enforces the env axis
> (runner.ts:1247) but not mounts; the migration must close the mount axis too.

---

## 4. Mapping: current → Gondolin

### 4.1 VM lifecycle  **[VERIFIED current / UNVERIFIED target ergonomics]**
`src/agent/smolvm.ts` (`machine create/start/stop/delete/exec`, the `SmolvmClient`
port in `smolvm-port.ts`) → `VM.create({ vfs, httpHooks, env })` / `vm.exec` /
`vm.close`. Deletes the smolvm CLI wrapper, the `Smolfile`, and the reconciler's
bake/pack machinery (`src/reconciler/{bake,vm,ledger}`). Removes the `_boot-vm`
orphan bug and the 3-mount cap (programmable VFS).

### 4.2 Transport — ACP TCP bridge is **already** sandbox-portable  **[VERIFIED]**
ACP does **not** ride exec stdio. `src/acp-bridge.ts` binds a host TCP listener; the
in-VM `scripts/vm-agent.mjs` dials the host loopback (`tcp://127.0.0.1:8788`),
sends a `Bearer <token>\n` line, and from then on ACP JSON-RPC flows over that
socket. `machine exec` is reduced to a process launcher (stderr only). The bridge
header comment was written precisely for this migration: *"If we ever swap smolvm
out for another sandbox (firecracker, gvisor, Kubernetes job, …) … Any sandbox
that can (a) exec a process with env vars and (b) reach the host loopback can now
run our agent stack."* (acp-bridge.ts:12-21).

**The ACP channel is NOT covered by the §2 TLS-MITM / secret-substitution path**
(codex re-review): it is raw mapped TCP carrying our own one-shot bridge bearer
(acp-bridge.ts:215), not HTTPS to an allowlisted upstream — do not assume the HTTPS
interception policies apply to the control channel.

The only mismatch: Gondolin **blocks guest→host loopback by default**. Two
supported rewires, both raw-TCP, both preserve the bearer handshake + `LineTap`:
- **(A) `tcp.hosts` mapping** — guest dials a mapped name; Gondolin tunnels it to
  the host bridge `HOST:PORT`. Keeps today's dial-out direction; smallest change
  (`SYMPHONY_ACP_URL` points at the mapped name). **Preferred**, but underspecified
  — hardening requirements (codex review):
  - Mapped TCP is **raw forwarding with no HTTP hooks / no secret substitution**
    (sdk-network.md). That's fine for ACP (it carries our own bridge bearer, not an
    upstream secret) but means this channel is *outside* the egress-secret machinery
    — it must never be reusable to reach a real upstream or a refresh endpoint.
  - Requires a **unique synthetic guest hostname** + **port-specific** mapping (not
    a wildcard) — which needs Gondolin's synthetic per-host DNS mode so the name
    resolves to a mappable IP (confirm `dns` mode interplay). The host bridge must
    bind **loopback-only**: today `AcpBridge.start(host, port)` binds whatever host
    it is given (can be `0.0.0.0`, acp-bridge.ts:95-110) — wider than loopback, so
    this must be tightened. The per-dispatch bearer still gates auth.
  - Add a **negative test**: from the guest, prove no *other* host-loopback service
    (the dashboard/MCP on 8787, any other listener) is reachable via the mapping.
- **(B) Ingress inversion** — guest *listens*, host dials in. **Correction (codex):**
  `openTcpStream()` uses the **SSH virtio bridge**; `openIngressStream()` is the
  ingress (`sandboxingress`) path (`host/src/sandbox/server-ops.ts:375-481`). Pick
  the right primitive if we go this route. Inverts the connect direction; more
  rewiring.

### 4.3 Secret injection — `createHttpHooks` + `updateSecret` push model  **[VERIFIED mechanism]**
Per VM:
```ts
const { httpHooks, env, secretManager } = createHttpHooks({
  allowedHosts: ['api.anthropic.com'],        // inference; if refresh is same-host add an onRequest path-policy (§3.4) — comment alone is not a control
  secrets: {
    // placeholder MUST be token-shaped (codex re-review): the default
    // GONDOLIN_SECRET_… can fail client-side token-shape validation before egress
    // substitution. Today's proxy mints sk-symphony-… sentinels.
    ANTHROPIC_AUTH_TOKEN: {
      hosts: ['api.anthropic.com'],
      value: access.accessToken,   // the real token; re-pushed via updateSecret on refresh
      placeholder: makePlaceholderFunc({ prefix: 'sk-ant-', length: 64, alphabet: BASE62_ALPHABET }),
    },
  },
});
const vm = await VM.create({ httpHooks, env, vfs: { ... } });
```
Host-side refresh loop (the existing ticker + extract/mint) calls
`secretManager.updateSecret('ANTHROPIC_AUTH_TOKEN', { value: <fresh accessToken> })`
on each rotation; per-request substitution always uses the latest. This is the
"read creds from file, inject on demand" the operator wanted — as a **push** at
rotation time (with `revokedValues` enforcement), not a value callback (which
Gondolin does not have).

**Fan-out is a design requirement, not a footnote (codex Major).** Today the proxy
re-reads the host credential on *every* request, so freshness is automatic and a
single host refresh covers all VMs. Gondolin is **push-based, per
`createHttpHooks` instance (per VM)**. The failure mode: a missed `updateSecret`
leaves that VM substituting a **stale** access token *and* — because the rotation
never went through that manager — its `revokedValues` never learns the old value,
so the revocation guarantee is silently absent for that VM. Required design (to be
specified before implementation, not deferred):
- A **registry of live VM `secretManager`s** owned by the host credential module;
  every refresh iterates and pushes to **all** live managers atomically.
- Define behavior on push failure (e.g. VM torn down mid-push) and on a VM created
  *during* a refresh (read-at-create must observe the latest value — order the
  create after registration or seed from the same cached value).
- Consider a **per-VM proactive refresh tick** keyed off `expiresAt` so a long
  dispatch never relies solely on the global ticker cadence.
This is genuinely more moving parts than the current pull model — weigh it in §8.

### 4.4 Per-adapter routing  **[VERIFIED constraint / UNVERIFIED adapter config]**
With **fake native credential files** (§3.3) each adapter runs in its **native
mode** and dials its **real** upstream; Gondolin allowlists + MITM-substitutes. So
**native dial (no rewrite) is the default**; `onRequest` rewrite is held in reserve
only for edge cases. Per-adapter notes:
- **claude** → `api.anthropic.com`, bearer = OAuth access token (§3). No rewrite.
- **codex** → native fake `~/.codex/auth.json` (placeholder token + the **real,
  non-secret `account_id`**) ⇒ codex dials `chatgpt.com/backend-api/codex` **itself**
  and sends `chatgpt-account-id` from the file — **no host/path rewrite, no
  `onRequest` injection** (the `codexUpstreamRoute` swap, credential-proxy.ts:1041-1055,
  is deleted). Allowlist `chatgpt.com`, substitute the real token. Remaining risk =
  codex's **transport**: WS frames are opaque after the `101` Upgrade (codex
  re-review), so set **`allowWebSockets: false`** and require the **HTTP** Responses
  transport (the wss path was the #127 leak); never route codex egress over a
  mapped-TCP rule (it bypasses substitution). Subscription-OAuth-only (no
  `api.responses.write` on `api.openai.com`). **NB (codex review):** native
  ChatGPT-OAuth needs a `tokens`-block fake auth.json — a different schema than
  today's **apikey** file (adapters.ts:453) — and reintroduces a refresh surface;
  §7 C7 spikes apikey-mode + an `onRequest` host/path rewrite as the lower-risk
  alternative (codex never enters an OAuth handshake, so it never tries to refresh).
- **opencode** → **host-mint (DECIDED — operator: "no real tokens in the VM").** The
  host runs the GitHub→Copilot exchange and pushes the minted Copilot token via
  `updateSecret`; the guest uses the custom OpenAI-compatible provider with a
  *placeholder* bearer against `api.githubcopilot.com` (the real host; Gondolin
  substitutes at egress). The guest holds **no** real token — identical to
  claude/codex. This is today's proxy posture (credential-proxy.ts:1176-1270)
  re-homed onto Gondolin. **Rejected alternative — native self-exchange:** Gondolin
  *can* substitute the real GitHub token on the `api.github.com/copilot_internal/v2/token`
  call, but the minted Copilot token then lands **in-guest** (breaks the pattern), and
  host-scoped substitution would need a strict `onRequest` allowlist on `api.github.com`
  (only `GET /copilot_internal/v2/token`) to avoid a durable-token oracle. **Status =
  best-effort:** no host Copilot creds to verify locally (claude+codex ARE verified,
  §7); validate via user bug reports. Allowlist `api.githubcopilot.com` only; send the
  Copilot editor headers via `onRequest`.

---

## 5. What we delete / what shrinks

Delete: `src/agent/smolvm.ts`, `smolvm-port.ts`, `Smolfile`, `src/reconciler/{bake,vm,ledger}`
(VM lifecycle), and the **transport half** of `credential-proxy.ts` (HTTP server,
`register/deregister` sentinels, `parseBearer`, `forwardToUpstream`, `pipeBody`,
base-URL injection). Removes the 3-mount workaround and the `_boot-vm` orphan path.

Keep / re-home (shrunk): credential **lifecycle** — `extractClaudeToken`,
codex/opencode extract+mint, `credential-ticker.ts`, the `flock` refresh lock —
into a small host module whose only output is `updateSecret` calls + the static
`onRequest` headers. Keep `acp-bridge.ts` (rewire connect only), `vm-agent.mjs`,
`LineTap`/`runlog`, the MCP control plane.

---

## 6. Risks & open questions

1. **Convention-vs-control on the invariant (codex Critical).** The whole safety
   case collapses if layer-2 enforcement (§3.2) is not actually built — mount
   denylist + full credential-env strip + build-env hygiene. Treat these as P0
   implementation work, not "we'll be careful."
2. **Network layer is unproven (codex Critical).** §3.4 is contingent on pinning
   the refresh endpoint and adding path/method policy; `allowedHosts` alone is
   insufficient if refresh is same-host, and mapped TCP bypasses HTTP hooks.
3. **Experimental dependency.** Betting the isolation + secrets layer on an
   "experimental" project is a different risk profile than our battle-tested (if
   buggy) smolvm. Mitigation: vendor-pin, keep smolvm behind a port/adapter so the
   swap is reversible, gate behind the existing transport-selection knob.
4. **Per-VM `secretManager` fan-out** (§4.3) — now a design requirement: a live-VM
   manager registry + push-to-all + stale/missed-update handling. More moving parts
   than the current pull model.
5. **Per-adapter risk for codex/opencode** (§4.4) — the proxy deletion is not
   claude-only; codex's wss transport (the #127 bypass) and opencode's Copilot mint
   must each be spiked. Fallback: ship claude-only first, keep a thin host proxy for
   the others.
6. **Raw-TCP host reachability** for the ACP bridge — prove `tcp.hosts` mapping
   works (§4.2 option A) with the hardening + negative test before falling back to
   ingress inversion.
7. **Billing split is orthogonal.** Gondolin does **not** change the 2026-06-15
   Agent-SDK-vs-interactive metering (`tmux-agent-transport.md`); it is
   transport-neutral and pairs cleanly with the tmux pivot (Gondolin = VM + egress
   + secrets; tmux = in-VM driver; introspection via JSONL pulled through the VFS).
   Do not conflate the two decisions.
8. **DNS/TLS specifics** — confirm `allowedHosts` wildcard semantics and DNS mode
   (synthetic/trusted/open) are compatible with each adapter's upstream set, and
   that the synthetic per-host mode the ACP `tcp.hosts` mapping needs coexists with
   inference egress.
9. **MITM CA hygiene (codex re-review).** A persistent shared Gondolin CA is trust
   material across VMs/runs; require a per-run `mitmCertDir`, protected perms, and
   rotation. The in-VM client/Node runtime must pick up the CA (system store /
   `NODE_EXTRA_CA_CERTS`); the CA mount silently disappears if VFS/`/etc/gondolin`
   is shadowed.
10. **WebSocket opacity.** Post-`101` frames are not inspectable/substitutable;
   default-deny WebSockets and keep codex on the HTTP transport (§4.4).
11. **Fake-file schema drift.** The staged fake files must track each client's
   native credential format. Lower-churn than env/auth-mode coupling (the client
   runs its best-tested native path), but non-zero — a per-client schema check in
   the spike + a watch on client releases.

---

## 7. Spike plan — prove before committing

Smallest spike that kills the unknowns, in a worktree, no production wiring. The
**security-negative tests (B-group) are first-class, not afterthoughts** — they
are what the whole migration's safety rests on.

> **Spike status (2026-05-29) — `spike/gondolin/` (isolated, own package.json):**
> the substrate **A-group is GREEN on the dev host**, plus B(mechanical):
> - **A-1** Alpine microVM boots under KVM; exec + r/w VFS mount work; guest ships
>   curl/nc/node/python3/bash.
> - **A-2** secret injection proven end-to-end: guest holds only a placeholder, the
>   **TLS-MITM CA is trusted out-of-the-box** (the §2 "new dependency" risk — closed
>   for the default guest), upstream sees the real value, `updateSecret` rotates it
>   live per-request, the **old value is revoked (403)**, and a non-allowlisted host
>   is blocked (403).
> - **A-3** the ACP `tcp.hosts` rewire works: guest dials a mapped name (resolves via
>   `dns:{mode:'synthetic',syntheticHostMapping:'per-host'}`) → host bridge gets the
>   bearer → ACK; an unmapped name is unreachable.
> - **B(mechanical)** fake creds file holds no real token; refresh-endpoint stand-in
>   blocked; inference allowed.
>
> **Agent image built (2026-05-29) — all five agents.** A guest rootfs is just a
> filesystem QEMU boots, so the recommended path is the **OCI/glibc** one
> (`spike/gondolin/build-image-oci.sh` + `Dockerfile.agents` FROM `node:24-bookworm-slim`
> — the prod Smolfile base — + `build-config.oci.json`): `symphony-agents:latest`
> boots (Debian 12 / glibc) with **`claude` (2.1.156), `claude-agent-acp`, `codex`
> (0.135.0), `codex-acp`, `opencode` (1.15.12)** all on PATH. The agents are baked
> into the Docker image, so Gondolin needs no in-chroot `postBuild` (no root).
> An Alpine-minirootfs variant (`build-image.sh`) also exists but lacks opencode
> (its postinstall fails on musl-in-chroot — root-caused: reads `/proc/cpuinfo`,
> absent in the build chroot → baseline pick → chroot npm fallback fails); the OCI
> glibc path resolves it the same way prod does.
>
> **B5 (claude) + C7 (codex) VERIFIED with real subscription creds (2026-05-29, ALL
> PASS)** — `spike/gondolin/tests/{b5-claude-real,c7-codex-real}.mjs`. For each, a real
> turn (`claude -p` / `codex exec`) completed end-to-end through Gondolin: the guest
> held only a placeholder, the real token was injected at egress, egress reached only
> the inference host (telemetry / mcp-proxy / github attempted-but-**blocked**, the
> turn still completed), **zero** token-refresh egress, and the guest creds were NOT
> rotated. The host-only-refresh invariant holds in practice.
> **C8 (opencode) = best-effort host-mint** — no host Copilot creds to verify locally;
> same no-real-token-in-VM pattern; user-report-validated (§4.4).

**A — substrate**
1. **Boot + VFS + exec.** `VM.create` with a `RealFSProvider` workspace mount; run
   a real dispatch command; confirm boot, mount, exec, teardown.
2. **Secret injection + rotation + CA trust.** `createHttpHooks` with
   `allowedHosts: ['api.anthropic.com']` and a claude OAuth access token as the
   secret; request from the guest with the placeholder bearer over **HTTPS**;
   confirm (i) the in-VM client (claude / its Node runtime) **trusts the Gondolin
   MITM CA** out of the baked image — no TLS handshake failure (may need the CA in
   the system trust store and/or `NODE_EXTRA_CA_CERTS`); (ii) substitution into
   `Authorization: Bearer <placeholder>` and that an `anthropic-beta` header passes
   through; then `updateSecret` mid-session and confirm (a) the new token is used
   and (b) replaying the old token is **revoked** (`secret … revoked for host`).
3. **ACP bridge over `tcp.hosts`.** Unique synthetic guest hostname, port-specific
   mapping, loopback-only host bind; `vm-agent.mjs` dials it; confirm bearer
   handshake + round-trip ACP frame. Negative: prove no *other* host-loopback
   service (8787 dashboard/MCP, etc.) is reachable via the mapping. Ingress
   inversion (`openIngressStream`) only if this fails.

**B — the host-only-refresh invariant (§3), all negative**
4. **No *real* credential material reaches the guest.** The invariant is "no real
   **durable** token in any file/env, and no real access token for claude/codex",
   NOT "no file exists" — opencode self-exchange is the documented exception (a real
   short-lived Copilot token in-guest, §4.4). We deliberately stage **fake**
   credential files (§3.3), and codex already stages a fake
   `~/.codex/auth.json` to pass its init check (adapters.ts:453, runner.ts:990). So
   assert: no real `claudeAiOauth`/`refreshToken`/access token or real
   `~/.claude/.credentials.json`; no real `tokens` block in `~/.codex/auth.json`; no
   real opencode GitHub token; no credential env vars (filesystem + `/proc/1/environ`).
   Fake placeholders carrying no secret are allowed by design. Then assert VM
   creation **hard-fails** when a volume is misconfigured to mount a *real* credential
   path or a host home dir.
5. **Refresh suppression — happy path.** In-VM claude with a **fake native
   `~/.claude/.credentials.json`** (token-shaped placeholder accessToken, junk
   refreshToken, far-future `expiresAt`) → full dispatch with **zero** egress to any
   OAuth/token/refresh endpoint (capture egress); confirm the far-future expiry
   suppresses any proactive refresh.
6. **Refresh suppression — adversarial (codex Major).** (a) Substitute an
   **expired/invalid** access token and confirm the client surfaces an upstream
   401 rather than silently finding a refresh path. (b) Deliberately plant a **fake
   refresh token** in the guest (env + a creds file) and confirm the client still
   cannot rotate. (c) From the guest, **POST directly to every known refresh
   endpoint over HTTPS** and prove Gondolin **blocks before upstream** (allowlist
   miss, or `onRequest` path-403 if same-host as inference). **Separately** — mapped
   TCP bypasses HTTP hooks so it *cannot* be path-blocked (codex re-review): assert
   **no `tcp.hosts` rule targets any refresh-capable host/port** and test that such
   an endpoint is simply **not reachable** via mapped TCP (non-reachability, not HTTP
   blocking). Pin the exact refresh host/path here → decides `allowedHosts`-block vs
   `onRequest` path-403.

**C — per-adapter (the migration deletes the proxy for ALL adapters)**
7. **codex — spike BOTH shapes.** (i) **apikey-mode + `onRequest` rewrite** (lower
   refresh surface): keep today's apikey fake `~/.codex/auth.json`
   (`{OPENAI_API_KEY, auth_mode:'apikey'}`, adapters.ts:453) so codex never enters an
   OAuth handshake; let it dial api.openai.com and rewrite host/path →
   `chatgpt.com/backend-api/codex` + add `chatgpt-account-id` + substitute the real
   ChatGPT-OAuth token via `onRequest`. (ii) **native ChatGPT-OAuth fake file** (a
   `tokens` block: JWT-shaped placeholder access_token with far-future `exp` +
   `account_id` + junk refresh_token) so codex dials the backend itself — but **must
   prove codex does not try to refresh** the placeholder tokens. Either way set
   **`allowWebSockets: false`** (WS opaque post-`101`).
8. **opencode — spike BOTH options** (§4.4). **(a) native self-exchange:** fake
   auth.json with a `gho_`/`ghu_`-shaped placeholder GitHub token; prove the native
   provider works under Gondolin interception (NOT confirmed by the accept-matrix),
   that a real Copilot token lands in-guest, and — **required** — that an `onRequest`
   method/path allowlist on `api.github.com` permits **only** `GET
   /copilot_internal/v2/token` (host-scoped substitution otherwise = a durable-token
   oracle). **(b) host-mint:** keep today's host exchange + substitute the Copilot
   token (nothing real in-guest, smaller oracle surface). Confirm editor headers + no
   mid-session 401 in both.

Exit criteria: **all of B (4-6)** green, plus A-2/A-3 and the C step for each
adapter we intend to ship. Any B red ⇒ **reconsider**, not just revise. Any A/C
red ⇒ document the gap and narrow scope (e.g. keep a thin host proxy for the
failing adapter, or ship claude-only first).

---

## 8. Decision criteria

Proceed if: the spike is green on secrets-rotation + refresh-suppression + ACP
transport, AND we are comfortable pinning an experimental dependency behind a
reversible port. The win is a smaller, cleaner basis (one isolation+egress+secrets
dependency vs. smolvm CLI + a 1300-line proxy) with a *stronger* security posture
on the host-only-refresh invariant. Defer if the experimental-maturity risk
outweighs the cleanup, or if the per-VM secretManager fan-out proves awkward.

---

## Appendix — source citations

Gondolin (read at `main`, 2026-05-29):
- `host/src/http/hooks.ts` — `SecretDefinition`, `secretManager`, `updateSecret`,
  `revokedValues` enforcement, `onRequest`/`onResponse` semantics.
- `docs/secrets.md`, `docs/sdk-network.md`, `docs/security.md`, `docs/sdk-vm.md`.
- README / docs site: https://earendil-works.github.io/gondolin/

Symphony:
- `src/agent/credential-proxy.ts` (extract/route/mint, lifecycle), `src/agent/credential-ticker.ts`
- `src/acp-bridge.ts`, `scripts/vm-agent.mjs` (transport)
- `src/agent/smolvm.ts`, `src/agent/smolvm-port.ts`, `Smolfile` (VM backend)
- `src/agent/runner.ts:1221` (`buildVmMounts`), `:1247` (`buildForwardedEnv`)
- Memories: `project_credential_rotation_poisoning`, `project_vm_reaper_blindspot`,
  `project_tmux_transport`, `project_acp_wedge`, `reference_symphony_architecture`.

---

## Change log

- **2026-05-29 v1** — initial draft.
- **2026-05-29 v2** — revised after codex review (gpt-5.5/xhigh, verdict
  *revise-doc-first*). Changes: corrected the false "`onRequest` cannot rewrite
  host/path/method" claim (it can — `hooks.ts:267-284`); added §3.2 active
  enforcement (mount denylist + full env strip; runner.ts:1221/1247) as a distinct
  layer; downgraded §3.4 network block to contingent (same-host refresh, mapped-TCP
  bypass); upgraded §4.3 fan-out to a required design; reworked §4.4 to flag codex
  wss-bypass + opencode mint as unproven; expanded §7 into A/B/C groups with
  first-class adversarial refresh-suppression tests; fixed `openTcpStream` vs
  `openIngressStream`. Open follow-up: pin the OAuth refresh host/path.
- **2026-05-29 v3** — added the TLS-MITM mechanism + Gondolin-CA guest-trust
  requirement to §2 (this is *how* a placeholder in an HTTPS `Authorization`
  header gets substituted; a new dependency vs. today's plain-HTTP loopback proxy)
  and the corresponding CA-trust check to §7 A-2.
- **2026-05-29 v4** — second codex review (verdict still *revise-doc-first*; 5/7
  prior findings CLOSED, 2 PARTIAL). Changes: reframed §3 to four layers and flagged
  layer-1 enforcement as target-state not current; added MITM-CA hygiene (per-run
  `mitmCertDir`, rotation, VFS-shadow constraint) to §2 + §6; flagged the ACP channel
  as raw mapped TCP outside the TLS-MITM/secret path (§4.2) + loopback-bind tightening
  + synthetic-DNS dependency; made WebSockets default-deny with post-`101` opacity
  rationale (§4.4, §7); corrected §7 B4 to "no *real* credential material"; fixed the
  §7 B6(c) mapped-TCP contradiction (test non-reachability, not HTTP block); required
  a token-shaped custom placeholder (§4.3).
- **2026-05-29 v5** — **auth-staging decision reversed (operator).** Replaced the
  env-bearer recommendation in §3.3 with **fake native credential files for all
  adapters**: each client runs native with placeholders, "zero clue" it is
  intercepted; the invariant holds because the staged refresh/durable token is fake
  (real one stays host-side). Rationale: genericity + decoupling from per-client
  auth-mode/env churn. Simplifies §4.4 (codex dials the ChatGPT backend natively with
  `account_id` from the file → no rewrite; opencode self-exchanges → host mint may be
  deleted). New bounded cost: a native client may attempt a doomed refresh on a
  transient 401 (availability, not security).
- **2026-05-29 v6** — third codex review (verdict still *revise-doc-first*; prior
  CLOSED items held, both PARTIALs improved). Fixes: (Critical) opencode self-exchange
  is a **host-scoped durable-token oracle** — substitution is host-scoped not
  path-scoped, so an `onRequest` method/path allowlist on `api.github.com` (only
  `GET /copilot_internal/v2/token`) is **required**, and this tilts opencode toward
  the host-mint alternative (§3.1, §4.4, §7 C8); reconciled the invariant text — the
  guest holds no *durable* token (all adapters) and no access token for claude/codex,
  but opencode self-exchange lands a real short-lived Copilot token in-guest (§3.1,
  §7 B4); corrected the "doomed refresh" framing (claude/codex refresh = blocked;
  opencode exchange = intentionally allowed); corrected the codex fake-auth precedent
  — today's file is **apikey-mode** (`{OPENAI_API_KEY, auth_mode:'apikey'}`,
  adapters.ts:453), so native ChatGPT-OAuth needs a different schema and must prove
  no-refresh; added apikey+`onRequest`-rewrite as the lower-refresh-surface codex
  option (§7 C7); flagged native-opencode as a hypothesis (not confirmed by the
  accept-matrix); fixed stale §7 B5 (claude now has a fake native creds file) and §7
  C8 (host-mint vs self-exchange); per-adapter placeholder shapes (sk-ant / JWT /
  gho_); removed stray tags; "bearer mode" → "native mode" in the §3 net.
- **2026-05-29 v7** — **spike stood up** at `spike/gondolin/` (isolated). Ran the
  A-group on the dev host: **A1/A2/A3 + B(mechanical) all PASS** — see the Spike
  status block in §7. Empirically closes: TLS-MITM CA trust (works on the default
  Alpine guest, no extra setup), per-request live substitution + rotation +
  revocation (§4.3), and the `tcp.hosts` ACP rewire (§4.2 A; needs synthetic
  per-host DNS). B5/B6 + C7/C8 remain pending an agent image + real creds (scaffolded
  with procedure).
- **2026-05-29 v8** — **agent image build set up** (`spike/gondolin/build-image.sh`
  + `build-config.json`), tagged `symphony-agents:latest`. Verified: claude/codex/
  codex-acp baked in. Build gotchas found + handled: host `lz4` dep (auto-fetched
  no-root), `postBuild.commands` (not top-level `commands`), `container.force` for
  chroot-as-root, and opencode's musl postinstall (NOT fixed — `/proc`-less chroot
  picks baseline + chroot npm fallback fails; recommended fix = glibc/OCI rootfs,
  matching prod). B/C for claude+codex now unblocked; opencode = follow-up.
- **2026-05-29 v9** — **opencode resolved; image now has all five agents.** Added the
  OCI/glibc build path (`build-image-oci.sh` + `Dockerfile.agents` FROM
  `node:24-bookworm-slim` + `build-config.oci.json`): `symphony-agents:latest` boots
  with claude/claude-agent-acp/codex/codex-acp/**opencode** all present (Debian/glibc,
  matching prod). Confirms a guest rootfs is just a filesystem QEMU boots — opencode
  was never a fundamental blocker, only an Alpine/musl+chroot artifact. B5/B6 + C7/C8
  now need only real creds.
- **2026-05-29 v10** — **claude + codex VERIFIED end-to-end with real subscription
  creds** (`b5-claude-real.mjs`, `c7-codex-real.mjs`, both ALL PASS): real `claude -p`
  and `codex exec` turns completed through Gondolin (fake native creds → placeholder
  in guest → real token substituted at egress); egress hit only the inference host
  (telemetry/mcp/github attempted-but-blocked, turns still completed); zero
  token-refresh egress; zero creds rotation. The governing invariant holds in
  practice. opencode (C8) DECIDED = **host-mint** (operator: no real tokens in the VM
  → native self-exchange rejected because it lands a real Copilot token in-guest);
  best-effort + user-report-validated (no host Copilot creds).
- **2026-05-29 v11** — wrote the `src/` migration plan (full smolvm cutover, no
  fallback): **`docs/research/gondolin-migration-plan.md`** (6 phased PRs + image-build
  prereq + P0 invariant-enforcement phase). Session handed off here (context full).
