# Implementation plan: migrate `src/` off smolvm → Gondolin (full cutover)

Status: plan (2026-05-29). Companion to `gondolin-sandbox-migration.md` (design +
spike results). **Decision: write smolvm out COMPLETELY** — no parallel fallback,
no transport-knob for the VM backend. Gondolin becomes the sole VM substrate.

## Goal & preserved invariants

Replace the smolvm CLI backend + the bake/pack pipeline + the credential-proxy
*transport* with Gondolin (`@earendil-works/gondolin`), and delete smolvm. **Must
survive the migration** (all spike-verified — see the design doc §7):
- **Host-only OAuth refresh** — verified end-to-end for **claude (B5) + codex (C7)**
  with real subscription creds: fake native creds in guest (placeholder only) → real
  token substituted at egress → real turn completes; zero token-refresh egress; no
  creds rotation; non-allowlisted hosts attempted-but-blocked.
- **No real tokens in the VM** (operator rule) — uniform for all three adapters
  (opencode = host-mint, not self-exchange).
- The **ACP transport**, **MCP control plane** (`src/mcp.ts`), per-issue
  **runlog/LineTap**, and the **workspace/branch contract** — unchanged.

**Spike already de-risked:** boot/exec/VFS (A1), secret inject+rotate+revoke + TLS-MITM
CA trust (A2), ACP over `tcp.hosts` (A3), real claude+codex turns (B5/C7). So this is
wiring + deletion, not research.

## Prerequisite — productionize the agent image build

Move `spike/gondolin/{Dockerfile.agents, build-config.oci.json, build-image-oci.sh}`
into the repo (e.g. `images/agents/`). The OCI/glibc image (`node:24-bookworm-slim`
+ agents, matching the old Smolfile) **replaces the Smolfile + the per-issue
bake/pack pipeline**. Build trigger: an operator/CI step (`make image` /
`scripts/build-agent-image.sh`) tagging `symphony-agents:<digest>`; the runner
references it by tag/digest via `gondolin` config. Gondolin injects its MITM CA, so
the image needs no CA setup (verified). Must land **before** Phase 1.

## Phased PRs

Small PRs (respect the diff-size gate + hexagonal `domain↛adapters` direction +
eslint ratchet). Phases 0–5 build Gondolin behind the runner while smolvm still
exists; Phase 6 deletes smolvm once the cutover is green.

### Phase 0 — dependency + generalized VM port (no behavior change)
- Add `@earendil-works/gondolin` to `package.json`.
- Generalize the port: `src/agent/smolvm-port.ts` → `vm-port.ts`, reshaped to
  Gondolin's object model — `createVm(opts) → VmHandle { exec(cmd, opts), close() }`
  plus `listSessions()` / `gc(prefix)` for the reaper — instead of the name-keyed
  `create/start/stop/destroy/exec` verbs. Domain (`reconciler`, `runner`) imports
  only the port (depcruise stays green).
- Add `GondolinVmClient` adapter implementing the port (thin over `VM.create` /
  `vm.exec` / `vm.close` / `listSessions` / `gcSessions`).

### Phase 1 — VM lifecycle cutover (`runner.ts`)
- Replace `ensureRunning(name)` + `execInteractive(name)` with
  `createVm({ imagePath, vfs, env, httpHooks, tcp, dns, allowWebSockets, sessionLabel })`
  → `vm.exec([...], {...})` launching `node /opt/symphony/vm-agent.mjs` → `vm.close()`.
- VFS: `buildVmMounts` (runner.ts:1221) → `vfs.mounts` (`RealFSProvider` for the
  workspace + eval-mode mounts). The 3-mount cap and the "bake scripts/ into the
  image" workaround (commit `ba1b520`) go away — VFS is programmable.
- Transport: ACP bridge over a **`tcp.hosts`** mapping — a unique synthetic guest
  host → the host bridge loopback, with `dns:{ mode:'synthetic', syntheticHostMapping:'per-host' }`.
  `SYMPHONY_ACP_URL` → the mapped name. Bind `AcpBridge` **loopback-only** (tighten
  acp-bridge.ts:95-110). `scripts/vm-agent.mjs` is UNCHANGED (still dials `SYMPHONY_ACP_URL`).

### Phase 2 — credential layer (shrink the proxy)
- New host module (reshape `credential-proxy.ts` → `credential-secrets.ts`): keep
  `extractClaudeToken` / codex / opencode extractors + the `flock` cross-process
  refresh + `credential-ticker.ts`. **Output** = a `createHttpHooks({ allowedHosts,
  secrets, onRequest, onResponse })` config + a registry of live per-VM
  `secretManager`s; the ticker pushes `updateSecret(value)` to all on rotation
  (+ a per-VM proactive tick keyed off `expiresAt`).
- **DELETE** the HTTP proxy server, sentinel minting, `forwardToUpstream`,
  `pipeBody`, base-URL injection (the ~half of the 1300 lines that was transport).
- `onResponse` → port the billing-tell logging (`anthropic-ratelimit-unified-*` / `x-ratelimit-*`).

### Phase 3 — invariant enforcement (P0 safety layer)
- **Mount/env denylist (hard-fail `createVm`)**: reject any mount resolving under a
  real credential path (`~/.claude`, `~/.codex`, opencode auth) or a host home dir;
  strip **all** credential env vars (extend `buildForwardedEnv` runner.ts:1247 beyond
  the single dispatched token var).
- **Fake-native-creds staging** (reuse `adapters.ts` staging): claude `claudeAiOauth`
  (placeholder access token, junk refresh, far-future `expiresAt`) + scrubbed
  `~/.claude.json` identity; codex JWT-shaped placeholder (far-future `exp`) + real
  `account_id` + junk refresh; opencode placeholder Copilot bearer via the custom
  OpenAI-compatible provider.
- **Egress**: `allowedHosts` per adapter (claude→`api.anthropic.com`; codex→`chatgpt.com`;
  opencode→`api.githubcopilot.com` + the host-mint exchange host). Refresh endpoints
  NOT allowlisted. **`onRequest` path-allowlist** for opencode's `api.github.com`
  host-mint (only `GET /copilot_internal/v2/token`) — the durable-token-oracle guard.
- `allowWebSockets:false` (codex stays on the HTTP Responses transport).

### Phase 4 — reaper + delete bake/pack
- Replace the reconciler VM reaper (`reconciler/vm.ts`) with Gondolin session GC
  (`listSessions`/`gcSessions` filtered by `sessionLabel` prefix). The `_boot-vm`
  orphan bug (`project_vm_reaper_blindspot`) is gone — Gondolin owns lifecycle.
- **DELETE** `reconciler/{bake,bake-plan,ledger}.ts` + `SmolvmBakeExecutor` + the bake
  resource wiring in `reconciler/index.ts`. The image is built once (prerequisite),
  not per-issue, so workspace-base-staleness pressure on the bake disappears.

### Phase 5 — per-adapter wiring + tests
- Wire claude/codex native fake files (spike-proven) + opencode host-mint (best-effort:
  custom provider + host-side GitHub→Copilot exchange + `updateSecret`; no host Copilot
  creds → user-report-validated).
- Port the spike tests into the repo suite: A1–A3 as substrate tests; `b5-claude-real` /
  `c7-codex-real` as creds-gated integration tests (skip without `SPIKE_*`).

### Phase 6 — DELETE smolvm + config migration
- **DELETE** `src/agent/smolvm.ts`, the `Smolfile`. Replace `SmolvmConfig`/`SmolvmVolume`
  (types.ts:231) with `GondolinConfig` (imagePath/digest, allowedHosts, cpus, memory,
  vfs mounts + denylist, dns). Update `workflow.ts` / `workflow-loader.ts` /
  `scaffold.ts` + `WORKFLOW.md` / `WORKFLOW.template.md` (`smolvm.*` → `gondolin.*`).
- `bin/symphony.ts:316`: `new SmolvmClient` → `new GondolinVmClient`.
- Sweep remaining smolvm refs (~20 files); update the depcruise baseline + eslint
  ratchet; CHANGELOG.

## Cross-cutting / unchanged
- `src/runlog.ts` + `src/agent/acp.ts` `LineTap` (ACP-frame tap) — unchanged.
- `src/mcp.ts` (mark_done / steering control plane) — unchanged.
- Per-issue workspace + branch contract — unchanged.
- **tmux transport** (`project_tmux_transport`, the 2026-06-15 billing track) is
  ORTHOGONAL and later: it rides on top of Gondolin (introspection via reading CC's
  JSONL out through the VFS / SSH). Gondolin must keep that path open but it's not in
  this migration.

## Sequencing & risk
- **Hard cutover:** Phases 0–5 make Gondolin fully work behind the runner *before*
  Phase 6 removes smolvm. Don't delete until the cutover is green on a real dispatch.
- **Diff-size gate + broken conflict-handoff + workspace-base-staleness:** keep PRs
  small (split the Phase 4/6 deletes), FF local main at each merge, and **don't arm
  `gh pr merge --auto`** until a branch is final (orphans late commits).
- **CA trust lives in the baked image** → the image-build prerequisite must land first.
- **P0 = Phase 3.** The invariant's strength is enforcement (denylist + path-policy),
  not convention — treat Phase 3 as gating, with the adversarial spike checks
  (expired token, planted refresh token, direct refresh POST) as regression tests.
</content>
