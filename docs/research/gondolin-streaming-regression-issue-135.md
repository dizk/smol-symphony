# RCA: Gondolin `onResponse` disables response streaming → long agent turns die (issue 135)

**Status:** Root cause confirmed; fix landed on `fix/issue-135-transport-resilience`.
**Date:** 2026-05-31. **Time spent:** ~2 days across several investigation passes.
**Severity:** High — affected **every long agent turn across all issues** under Gondolin,
not just issue 135. Manifested as an infinite boot→fail→re-dispatch loop.

## TL;DR

symphony registered a Gondolin `onResponse` HTTP hook **purely to log rate-limit
headers** (a "billing tell"). Gondolin only streams a response body to the guest when
there is **no** `onResponse` hook:

```js
// node_modules/@earendil-works/gondolin/.../qemu/http.js
const canStream = Boolean(responseBodyStream) && !backend.options.httpHooks?.onResponse;
```

With `onResponse` set, `canStream` is always `false`, so Gondolin **fully buffers** every
response (`bufferResponseBodyWithLimit` — reads to EOF, then `sendHttpResponse` delivers
headers+body in one shot). For a long **streaming** model turn (a `/v1/messages` SSE that
streams ~400 KB over ~90–120 s), the in-VM Claude Code SDK — a streaming client — receives
**nothing** for the entire generation window, trips its stream/inactivity timeout, silently
retries, and after ~16 min exhausts and reports `ECONNRESET`. The host classified that as a
failed turn and re-dispatched, forever.

**Fix:** remove the `onResponse` billing-tell hook so `canStream` is `true` and responses
stream incrementally to the guest. (`src/agent/credential-secrets.ts`.)

This was a **smolvm → Gondolin regression**: under smolvm, egress went through a host HTTP
*proxy* that streamed responses; during the migration the proxy's `logRateLimitHeaders` was
ported onto a Gondolin `onResponse` hook, which silently disabled streaming.

## Symptom

Issue 135 (a heavy "draft issues into a file" task) looped: each dispatch booted a VM, ran
~16–22 min, died with `agent turn transport_error: Internal error: API Error: Unable to
connect to API (ECONNRESET)`, discarded the workspace, and re-dispatched. The circuit
breaker didn't stop it initially because failures flapped reason (fixed separately — see
"Related fixes").

## Investigation — what was RULED OUT (don't re-tread these)

Each was disproven with direct evidence, not reasoning:

| Hypothesis | Verdict | How it was ruled out |
|---|---|---|
| Nested `Workflow` fan-out (the original RCA) | Contributing trigger only | Defused via WORKFLOW.md "single agent" instruction; turns still died. The agent explicitly avoided `Workflow`. |
| Upstream caps a 16-min-long stream | **Refuted** | Inference is *serial* — many separate `/v1/messages`, each gets headers in ~1 s. No single long-lived stream. |
| Agent reaches an egress-**blocked** host at ~16 min | **Refuted** | Host-side egress audit (`onRequest` log): every request `allowed=true`. Nothing blocked. |
| Gondolin netstack abort (4 MB pending-write / 64 MB body cap) | **Refuted** | With Gondolin `net` debug on, **no** `tcp session aborted` and **no** `http bridge fetch failed` at the reset. |
| ACP TCP bridge (`vm-agent.mjs`) backpressure/stall | **Refuted** | Host socket queues all 0; in-guest DIAG counters showed `socketTx == adapterOut`, `writableLen = 0`, no sustained backpressure — the bridge forwarded everything the adapter produced. |
| Subagent (`Task`/`Agent`) fan-out running silently | **Refuted** | No `Task`/`Agent`/subagent tool-call ever appeared in the ACP frames. |
| Fixed connection-lifetime timeout | **Refuted** | Time-to-failure varied (16 min vs 22 min) — workload-dependent. |

## Root cause — the evidence chain

Three instrumented runs (egress audit on `onRequest`, Gondolin `net` debug routed to our
logger, and a forked **in-guest** `vm-agent.mjs` with byte-flow counters) produced:

1. **The adapter receives big responses but emits nothing.** In the 16 min before the reset,
   the in-guest DIAG counters showed `adapterOut` (bytes the adapter writes to its ACP stdout)
   **frozen**, `socketTx == adapterOut` (bridge forwarded all of it), `socketWritableLen = 0`,
   `sinceAdapterOut` climbing for ~16 min. So the bridge was healthy; the adapter produced
   **zero** ACP output.
2. **…while `/v1/messages` responses "completed" every ~90–120 s at ~400 KB each** (Gondolin
   `http bridge body complete … N bytes in Xms`). The host only ever sent **one** prompt
   (`socketRx` flat) → the adapter was grinding one turn, retrying.
3. **Gondolin gates streaming on the absence of `onResponse`** (`qemu/http.js`, the `canStream`
   line above). `bufferResponseBodyWithLimit` confirms full buffering; `sendHttpResponse`
   delivers only at the end. Gondolin's `HttpHooks` has **only** `onRequest`/`onResponse` — no
   header-only response hook — so any response observability forces the buffering path.
4. **symphony set `onResponse` unconditionally** (`makeBillingTellResponseHook`) on every
   adapter, so `canStream` was always false.

Put together: a big streaming turn was buffered whole for ~90–120 s before the guest saw a
byte → the streaming SDK timed out → silent retry loop → ~16 min → ECONNRESET. Short early
turns survived because they buffered in seconds, under the SDK's timeout.

## The fix

`src/agent/credential-secrets.ts` — `buildAdapterHooksConfig` no longer registers an
`onResponse` hook; the `makeBillingTellResponseHook` function and the `*_BILLING_TELL_HEADERS`
constants (`src/agent/credential-extractors.ts`) and the `billingHeaders` spec field were
removed entirely. Lost capability: the `credential-secrets: upstream ratelimit` log line
(pure observability — reconstructable from request logging later if needed).

## How to avoid regressing this

- **Do NOT register a Gondolin `onResponse` hook.** It silently disables response streaming
  for the whole VM. This is the load-bearing invariant; it deserves a guard/comment at the
  hooks-config site (added in `buildAdapterHooksConfig`).
- Credential substitution and the egress firewall work on **`onRequest` + `secrets`**, which do
  **not** disable streaming — those are unaffected.
- If response-header observability is ever needed again, it requires **vendoring Gondolin** to
  add a streaming-compatible header-only hook (e.g. `onResponseHead`) that fires on headers
  without consuming the body, then moving the billing-tell there.

## Related fixes (same branch)

- `acp.ts`: connection faults now classify as `transport_error` (not `refusal`).
- `orchestrator-decisions.ts`: circuit breaker counts **consecutive** failures regardless of
  reason (the old same-reason streak let flapping ECONNRESET↔401 dodge the breaker).
- WORKFLOW.md / scaffold: "work as a single agent — do not fan out" (defuses the original
  false-trigger; not the root cause, but reduces turn size/fragility).

## Diagnostic instrumentation (temporary — revert after validation)

Added during the investigation, still on the branch:
- `credential-secrets.ts` `makeEgressAuditHook` — wraps `onRequest`, logs every egress
  request + `allowed` flag.
- `gondolin.ts` — `sandbox.debug = ['net']` + a `debugLog` sink (filtered) to surface the
  `http bridge …` lifecycle + `tcp session aborted …`.
- `runner.ts` + `gondolin-dispatch.ts` — a `/opt/symphony-dbg` read-only mount + `VM_AGENT_COMMAND`
  override that runs the instrumented `spike/vm-agent-debug/vm-agent.mjs` (byte-flow counters)
  instead of the image-baked `/opt/symphony/vm-agent.mjs`.

These are observability only; revert (or keep the egress audit if wanted) once the fix is
validated. The byte-flow counters and `gondolin/net` debug were what pinned the cause.

## Validation — PASSED (2026-05-31, post-fix run)

Re-ran issue 135 with the fix (and the diagnostics still in place to observe):

- **ACP frames flowed continuously — `maxGapSec = 0` for the entire run** (vs the ~16-min
  silence freeze in every prior attempt). The in-guest `adapterOut` counter climbed steadily
  (790 K → 1.05 M) including through the heavy-generation phase.
- **Response sizes were normal again** — 4–22 KB streaming turns completing in 5–67 s, not the
  pathological 400–567 KB blobs the buffering path produced.
- **0 `transport_error` / 0 ECONNRESET.**
- **The turn completed and the issue transitioned `Todo → Review`** at 09:56:15 via the
  symphony MCP `transition` (actor `claude/claude-opus-4-8[1m]`, 2936-char review note) — in
  **~8.5 min**, where it had died at 16–22 min on 7+ prior attempts.

Conclusion: removing the `onResponse` hook restored streaming and unblocked the turn. Root
cause and fix confirmed.
