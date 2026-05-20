---
id: "migrate-to-acp-set-model"
identifier: "migrate-to-acp-set-model"
title: "Use ACP session/set_model for model selection when the adapter supports it"
created_at: "2026-05-20T11:29:35.000Z"
updated_at: "2026-05-20T11:29:35.000Z"
---
Background: PR #8 introduced `acp.model` and applies it via adapter-specific injection — `ANTHROPIC_MODEL` env for `claude-agent-acp`, `-c model="..."` argv for `codex-acp`. That works today but bypasses the ACP protocol's own model-selection mechanism.

The ACP SDK at `node_modules/@agentclientprotocol/sdk/schema/schema.json` exposes:

- `session/set_model` request `{ sessionId, modelId }` (`x-method: session/set_model`, `x-side: agent`).
- `SessionModelState { currentModelId, availableModels: ModelInfo[] }` returned as part of `NewSessionResponse` / `LoadSessionResponse`.
- The host SDK (`ClientSideConnection.unstable_setSessionModel`) is available out of the box.
- Both are marked **UNSTABLE** in the spec: *"This capability is not part of the spec yet, and may be removed or changed at any point."*

Adapter support today (verified against installed versions):

- `@agentclientprotocol/claude-agent-acp` v0.27.0: **implements** `unstable_setSessionModel` (calls `query.setModel(modelId)` and persists via `updateConfigOption`). Also returns `SessionModelState` from `session/new` driven by `getAvailableModels` (which resolves `ANTHROPIC_MODEL` → `settings.json` → default).
- `@zed-industries/codex-acp` v0.14.0: **does not implement** it. Grepping the bundle for `setSessionModel`, `set_model`, `currentModelId`, `availableModels` returns zero matches.

What to do here:

1. **Add a hybrid path in `src/agent/runner.ts` / `src/agent/acp.ts`:**
   - After `client.initSession()`, inspect the session/new response for `SessionModelState`. If it carries `availableModels` AND the workflow's `acp.model` is set AND the requested model id appears in `availableModels`, call `client.conn.unstable_setSessionModel({ sessionId, modelId })` before the first prompt. Log the resolved model.
   - If the session/new response does NOT carry a `SessionModelState` (or `availableModels` is empty), keep using the adapter-specific injection from PR #8 (env/argv). This is what codex-acp will hit today.
   - If `acp.model` is set but is NOT in `availableModels` after init, log a warning and let the adapter fall back to its default (don't fail the dispatch).

2. **AcpClient surface:** add a thin wrapper `setModel(modelId: string): Promise<void>` on `AcpClient` (it already holds the `conn` and the `sessionId`). Keep it as a single line: `await this.conn.unstable_setSessionModel({ sessionId: this.sessionId, modelId })` with the usual `withTimeout` shape used for other ACP calls. Comment that the underlying method is unstable per the ACP spec.

3. **Capture `SessionModelState` from session/new:** `initSession()` in `src/agent/acp.ts` already destructures session/new — extend it to also return `modelState` (or store it on the instance). Pass to runner so runner can decide whether to call the new path or fall back to injection.

4. **Tests:** add a unit test in `tests/acp.test.ts` (creating it if needed) that drives a fake adapter and verifies (a) session/set_model is sent when modelState is present + model matches, (b) it is NOT sent when modelState is absent (so codex falls back), (c) it is NOT sent (and a warning logs) when the requested model is missing from availableModels.

5. **Documentation update:** the comment block in `src/agent/adapters.ts` and `WORKFLOW.template.md` should note that `claude` uses the protocol path when available and falls back to env, while `codex` uses `-c model=...` until upstream adds session/set_model.

Run `npm run typecheck` and `npm test` before `mark_done`. Both must pass.

Commit with a short message like `acp: prefer session/set_model when adapter advertises models`.

Non-goals for this issue:

- Removing the env/argv injection from PR #8. It stays as the fallback.
- Tracking upstream codex-acp progress on set_model. We just detect at runtime; when codex-acp implements it, this code path will automatically start using the protocol API for codex too without further work.
- Per-session dynamic model swaps via UI. The workflow-level setting is fine for v1.
