# Research: tmux transport — drive the real Claude Code TUI, keep the interactive subscription

Status: research / pre-design (2026-05-28). No code yet. Companion to
`docs/research/credential-injection.md` and
`docs/research/credential-proxy-accept-matrix.md`. Goal: decide whether and how
Symphony should gain a second, parallel agent transport that runs the genuine
interactive Claude Code CLI inside a tmux session and drives it, rather than
speaking ACP to `claude-agent-acp`.

## 1. Why — the billing trigger (verified)

Anthropic's [Agent SDK billing change](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan),
effective **2026-06-15**, splits subscription usage into two pools:

- **Interactive Claude Code** (terminal / IDE TUI) — "continues to use your
  subscription usage limits exactly as before" (the unified 5h / 7d windows we
  observe in the credential proxy's forwarded `anthropic-ratelimit-unified-*`
  headers).
- **Agent SDK + `claude -p` + GitHub Actions + "third-party apps that
  authenticate with your Claude subscription"** — draws from a NEW, separate
  **monthly Agent SDK credit**: Pro $20 / Max 5x $100 / Max 20x $200. When the
  credit runs out, usage flows to API-rate credits if enabled, otherwise
  requests stop until the monthly refresh.

The load-bearing line for us is **"third-party apps that authenticate with your
Claude subscription."** Symphony's current path — the credential proxy (issue
113) feeding a subscription OAuth token to `claude-agent-acp` in the VM — is
exactly that. Post-2026-06-15 every dispatch is metered against the operator's
$200/mo (Max 20x) Agent SDK credit, not the full interactive allowance.

$200/mo of API-rate credit is thin for a fleet. A single heavy dispatch
observed during issue-114 testing burned ~167k input tokens in one turn before
the first compaction. At Opus API rates a handful of such dispatches exhausts
the monthly credit; after that, dispatches either bill real API dollars or
stall until the next month.

Driving the **interactive** Claude Code TUI keeps dispatches on the full Max
interactive allowance — the same pool the operator's own `claude` sessions use,
which is far more generous than $200/mo of metered credit. That is the entire
motivation.

Secondary leg — **ToS / licensing.** `docs/research/credential-proxy-accept-matrix.md`
established that subscription OAuth is licensed to Claude Code (the CLI) +
claude.ai, and that third-party Bearer use currently works but is a server-side
gray area Anthropic has shown willingness to lock down (the Jan/Feb 2026
episode). Running the genuine `claude` binary interactively removes that
ambiguity entirely — it is the licensed client.

## 2. Goals and constraints (operator direction, 2026-05-28)

1. **Parallel track, not a replacement.** The tmux transport is a second,
   selectable transport that coexists with the ACP bridge. A workflow / state
   knob (`transport: acp | tmux`) chooses per dispatch. Rationale: if Anthropic
   reverses the billing decision, or the tmux path proves too brittle, we flip
   the knob back with zero migration.
2. **Keep ACP for now where logging matters.** ACP's structured event stream is
   cleaner for introspection today; we keep it as the default while the tmux
   transport matures.
3. **Do not lose introspection on the tmux path.** Claude Code writes complete
   session transcripts to local JSONL files; we transport those out of the VM
   so the tmux path retains (and exceeds) ACP's observability. See §4.
4. **Switch-back-able.** Both transports terminate at the same control plane
   (the symphony MCP server) and the same per-issue workspace/branch contract,
   so a dispatch's outcome is transport-independent.

## 3. The interactive-TUI-in-tmux pattern (prior art)

Two reference implementations, both driving the unmodified Claude Code binary.

### Gastown (Steve Yegge) — the integration contract

[gastown](https://github.com/steveyegge/gastown) orchestrates agents through
tmux + env vars as "configuration, not compilation" — it never links agent
code. Its [provider-integration contract](https://github.com/steveyegge/gastown/blob/main/docs/agent-provider-integration.md)
is a per-harness **preset** declaring:

- **Launch:** run the binary in a dedicated tmux pane; env vars (`GT_ROLE`,
  `GT_ROOT`, …) set before launch. `command` + `args` are the launch signature.
- **Readiness:** scan the pane for a `ready_prompt_prefix` (e.g. `"❯ "`), with a
  `ready_delay_ms` fallback for TUIs without a detectable prompt; cross-check
  `pane_current_command` against `process_names`.
- **Send work:** `prompt_mode: arg` (pass the prompt as a CLI argument) when the
  harness supports it; else `tmux send-keys` with Enter sent separately.
- **Completion / idle:** prompt-prefix reappears + process-name observation;
  `capture-pane` screen-scrape only as a fallback.
- **Resume:** `--resume <session-id>` (flag or subcommand style); session id
  tracked via an env var.

Notably, gastown is migrating *away* from scraping toward native status
(`GetStatus()` / `IsReady()` — the "Gas City" contract). The lesson: **scraping
is the fallback, a structured signal is the goal.**

### amux (mixpeek) — the pure-scraping playbook

[amux](https://github.com/mixpeek/amux) drives Claude Code with "no hooks, no
patches" via ANSI-stripped `capture-pane -p`. Its watchdog detects, from the
visible buffer / scrollback:

- idle vs working (prompt presence); **turn complete** when the next input
  prompt reappears;
- **usage-cap menu** → parses the "resets HH:MM" time from scrollback and
  auto-resumes the fleet at reset (5-min safety fallback);
- **context pressure** ("Context < 50%") → sends `/compact`;
- **permission prompts** in bypass mode.

Input via `tmux send-keys -t <session> <text> Enter` (literal mode + separate
Enter to avoid paste / multiline races).

amux is the proof that a robust driver is achievable from terminal state alone;
but it is the brittle end of the spectrum (ANSI parsing, TUI layout drift across
Claude Code versions, prompt-collision races).

## 4. Introspection without ACP — read Claude Code's local transcripts

Claude Code persists a complete, append-only JSONL transcript per session. Layout
confirmed on this host (Claude Code 2.1.152):

```
~/.claude/projects/<project-path-hash>/<session-uuid>.jsonl
```

(One object per line; append-only — no locking, no rewrite, safe to tail.)

Line `type` discriminators observed in a real Symphony-project transcript:
`assistant`, `user`, `system`, `file-history-snapshot`, `ai-title`,
`last-prompt`, `pr-link`, `attachment`, `mode`, `queue-operation`,
`permission-mode`.

An `assistant` line carries everything we need and more than ACP gave us:

```
keys:    cwd, entrypoint, gitBranch, isSidechain, message, parentUuid,
         requestId, sessionId, timestamp, type, userType, uuid, version
message: content[], model, role, stop_reason, stop_details, usage, id
content: thinking | text | tool_use {id,name,input} | tool_result {tool_use_id}
```

Two findings that shape the design:

- **`message.usage` is present** — exact per-turn input/output token counts, so
  the host can track Max-window consumption from the transcript directly (the
  same data the proxy logs from response headers, but per-turn and richer).
- **`message.stop_reason` is the turn-completion signal, in the JSONL itself.**
  An `assistant` line with `stop_reason: "end_turn"` (and no trailing
  `tool_use`) means the turn finished and the agent is awaiting input. This is a
  structured completion signal that needs **no TUI scraping and no hook** — just
  a tail of the transcript.

**Export mechanism:** the transcript lives on the VM's `~/.claude/projects/…`.
Symphony already bind-mounts the per-issue workspace into the guest; a sibling
read-only tail (or a small in-VM forwarder over the existing host↔VM channel)
ships new JSONL lines to the host, where they map onto the existing
`onRuntimeEvent` stream (tool_use → tool-call event, assistant text → message
chunk, usage → token accounting). Net: the tmux path's introspection is the
canonical Claude Code transcript — strictly richer than ACP (it includes
`thinking` blocks, `stop_reason`, `parentUuid` threading, and `gitBranch`).

## 5. Proposed architecture for Symphony

### 5.1 Transport as a selectable seam

Introduce `transport: acp | tmux` (default `acp`) as a workflow/state knob,
parallel to the existing `credentials_mode` knob. Both transports share:

- the per-issue workspace + `agent/<id>` branch contract,
- the symphony **MCP control plane** (transition / propose_issue /
  request_human_steering),
- the outcome model (terminal-state transition, PR handoff actions).

They differ only in how the agent process is launched and how its turns are
observed. The cleanest home is a `Transport` interface alongside
`src/acp-bridge.ts`; the runner selects one at dispatch time.

### 5.2 Launch

In the VM, start the genuine `claude` binary interactively inside tmux (not
`claude -p` — that is the Agent SDK billing pool we are trying to avoid; §1).
Bypass-permissions mode so it runs autonomously. The initial issue prompt is
delivered either as a launch argument or via `send-keys` once the ready prompt
is detected.

### 5.3 Control plane — unchanged

Interactive Claude Code loads MCP servers via `--mcp-config` / project
`.mcp.json`. Symphony's per-issue MCP endpoint (bearer-scoped, issue 113's
sibling pattern) is wired the same way it is today. The agent transitions state
and proposes issues through MCP exactly as on the ACP path. **This is the
linchpin that makes the pivot tractable** — the entire control plane is
transport-independent.

### 5.4 Turn-completion & state detection (layered, structured-first)

1. **Primary — transcript tail (§4).** Watch the session JSONL for an
   `assistant` line with a terminal `stop_reason` and no pending `tool_use`.
   Structured, version-stable, no scraping.
2. **Secondary — Stop hook.** Claude Code's Stop / Notification hooks can write
   a sentinel file the host watches — a redundant, explicit "turn done" signal.
   (Verify hooks fire under bypass mode; §7.)
3. **Fallback — `capture-pane`.** Dispatches run in **bypass-permissions mode**
   (operator decision, 2026-05-28), so there are NO interactive permission
   prompts to detect. That leaves exactly one TUI-only signal not present in the
   transcript: the **usage-cap / rate-limit menu**. Adopt amux's reset-time
   parser for it. This is the entire scraping surface — making the tmux
   transport far less brittle than a general TUI driver (amux/gastown both also
   carry permission-prompt scraping, which we don't need).

### 5.5 Sending work

`tmux send-keys -t <session> -l <text>` then a separate `Enter` (literal mode +
split Enter, per both references, to dodge paste/multiline races). A `.ready`
handshake (only send when the pane is idle per §5.4) prevents prompt collisions.

### 5.6 Resume

`claude --resume <session-id>` (session id read from the transcript filename or
the `system/init` line). Lets a dispatch survive a transport reconnect without
losing context — the analogue of the ACP session, but backed by Claude Code's
own session store.

### 5.7 Codex

Out of scope here, but the same loose-coupling preset model extends to codex
(gastown already drives Claude Code + Codex + Copilot). Ties to issue 115; a
unified preset-based transport could eventually cover both adapters.

## 6. Tradeoffs vs the ACP transport

| Axis | ACP bridge (today) | tmux + interactive TUI |
| --- | --- | --- |
| Billing pool (post 2026-06-15) | Agent SDK credit ($200/mo Max 20x) | **Full interactive subscription** |
| ToS posture | third-party gray area | licensed interactive client |
| Transport robustness | structured JSON protocol — clean | TUI driving — brittle (ANSI, version drift, races) |
| Introspection | ACP event stream | **richer** — canonical JSONL transcript (§4) |
| Completion signal | protocol message | JSONL `stop_reason` (primary) + hook + scrape |
| Control plane | symphony MCP | symphony MCP (unchanged) |
| Maturity in Symphony | shipped, tested | greenfield |

The trade is **transport robustness for billing**. We keep ACP as default and
gate tmux behind the knob precisely so the brittleness is opt-in and reversible.

## 7. Open questions — verify before building

1. **Autonomous interactive run in a smolvm guest.** Confirm interactive
   `claude` in **bypass-permissions mode** runs an issue to completion in tmux
   and idles on the ready prompt between turns (no permission prompts to wedge
   on by design; watch for any *other* modal that stalls it). Prove in one guest
   before committing to the transport.
2. **Hook reliability under bypass mode.** Confirm the Stop hook fires and can
   write a host-visible sentinel (§5.4 layer 2). If unreliable, the JSONL tail
   (layer 1) stands alone.
3. **Exact transcript path inside the VM.** Verified on this host as
   `~/.claude/projects/<hash>/<uuid>.jsonl`; confirm the in-VM Claude Code
   version uses the same layout (some versions nest under `sessions/`).
4. **Usage-cap menu shape.** Capture a real rate-limit menu from the interactive
   TUI to write a robust parser (amux's "resets HH:MM" + 5-min fallback is the
   starting point).
5. **MCP + bypass interplay.** Confirm the per-issue MCP server is reachable and
   tools are callable from an interactive bypass-mode session the same way they
   are under claude-agent-acp.
6. **Does the interactive TUI honor a non-interactive initial prompt cleanly**
   (launch arg vs first send-keys), and does it idle on the ready prompt between
   turns so the host can drive multi-turn dispatches.

## 8. References

- Agent SDK billing change (the trigger): `https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan`
- Claude Code headless / programmatic (the pool we avoid): `https://code.claude.com/docs/en/headless`
- Gastown integration contract: `https://github.com/steveyegge/gastown/blob/main/docs/agent-provider-integration.md`
- amux (pure-scraping driver): `https://github.com/mixpeek/amux`
- Claude Code session transcript format: `https://github.com/simonw/claude-code-transcripts`, `https://databunny.medium.com/inside-claude-code-the-session-file-format-and-how-to-inspect-it-b9998e66d56b`
- Symphony internals this builds on: `src/acp-bridge.ts` (transport pattern to parallel), `scripts/vm-agent.mjs` (in-VM agent launcher), `src/agent/adapters.ts` (adapter profiles), `src/agent/credential-proxy.ts` (per-issue MCP + bearer pattern), `docs/research/credential-proxy-accept-matrix.md` (subscription billing signals).
