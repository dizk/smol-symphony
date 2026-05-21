# smol-symphony

A small TypeScript orchestrator that reads issues off a local Markdown tracker,
prepares per-issue workspaces, and runs coding agents (Claude Code, Codex,
OpenCode) inside isolated [smolvm](https://smolmachines.com/) microVMs over the
[Agent Client Protocol](https://agentclientprotocol.com).

The agent signals progress through an injected MCP server (`transition`,
`request_human_steering`, `propose_issue`); the orchestrator handles state,
retry, concurrency, and produces either a pull request or a `git format-patch`
bundle per issue.

```
┌──────────────────────────────────────────────────────────────────────────┐
│  symphony (node host)                                                    │
│                                                                          │
│    ./issues/<state>/*.md  ──┐                                            │
│    ./WORKFLOW.md            ├──▶  orchestrator  ──▶  agent runner        │
│    ./WORKFLOW.template.md ──┘     poll · reconcile · dispatch            │
│                                                          │               │
│                                                          ▼  ACP/RPC      │
│                                       ┌───────────────────────────────┐  │
│                                       │ smolvm  (per-issue VM)        │  │
│                                       │   adapter (claude / codex)    │  │
│                                       │   workspace mount             │  │
│                                       │   mcp client  ────────────────┼─┐│
│                                       └───────────────────────────────┘ ││
│                                                                         ││
│              symphony MCP server  ◀─────────────────────────────────────┘│
│      ( transition · request_human_steering · propose_issue )             │
│                                                                          │
│    HTTP dashboard (HTMX):  /                                             │
│      attention · sessions · on disk · new issue · totals                 │
└──────────────────────────────────────────────────────────────────────────┘
```

## Quick start

Prerequisites:

- Node.js ≥ 20.
- A `smolvm` binary on `$PATH` with the server reachable on the configured
  endpoint (e.g. `smolvm serve start --listen unix:///run/user/$UID/smolvm.sock`).
- A packed VM image (one-time): `bash scripts/build-vm.sh` produces
  `.vm/symphony.smolmachine.smolmachine` (~1.1 GB; ships `claude-agent-acp`,
  `codex-acp`, and `opencode` on the guest `$PATH`).
- For the default `acp.adapter: claude`: a credentials file at
  `~/.claude/.credentials.json` on the host (symphony reads and stages it; the
  host directory is **not** bind-mounted into the VM).

Run, against an existing workflow file in the current directory:

```bash
npx smol-symphony WORKFLOW.md
```

(Or `npm i -g smol-symphony` and then `symphony WORKFLOW.md` to skip the
fetch.) Both invoke the `symphony` bin shipped in this package.

Open the dashboard at `http://127.0.0.1:8787/`. Drop issues into
`issues/Todo/` from the filesystem or the dashboard's `new issue` form;
symphony dispatches them on the next poll.

### From a checkout

If you're hacking on symphony itself:

```bash
git clone https://github.com/dizk/smol-symphony.git
cd smol-symphony
npm install
npm run build
npx symphony WORKFLOW.md     # the local bin
```

`npm run dev` (via `tsx watch`) reruns on source edits.

## Local Markdown tracker

Issues live as `.md` files under `tracker.root`. The parent directory is the
issue state; the set of valid state directories comes from the `states:` block
in `WORKFLOW.md` (see below) and is auto-mkdir'd on startup.

```
issues/
├── Todo/
│   ├── 1.md
│   └── 2.md
├── Review/
│   └── 3.md
├── Done/
│   └── 4.md
└── Triage/
    └── 5.md
```

The basename is the issue identifier. When a caller (dashboard form, MCP
`propose_issue`) omits an explicit identifier, the tracker picks the next free
positive integer by scanning every state directory under `tracker.root`.
Operator-supplied identifiers (e.g. `CACHE-7.md`) pass through unchanged and
coexist with the numeric ones.

Each file has YAML front matter and an optional body:

```markdown
---
title: "Fix the login bug"
priority: 2
labels: [bug, auth]
blocked_by: [5]
---
Long-form description in the body.
```

State comparison is case-insensitive. Moving the file between state
directories is the canonical state transition; the orchestrator does this
itself in response to `symphony.transition`. The agent inside the VM does
**not** have filesystem access to the tracker root: it signals progress
through the MCP server and the orchestrator does the file move.

## WORKFLOW.md

`WORKFLOW.md` is a YAML front matter block (orchestrator config) plus a
[Liquid](https://liquidjs.com/)-templated prompt body. The shipped file in
this repo is the canonical project workflow; see
[WORKFLOW.template.md](./WORKFLOW.template.md) for the annotated reference
covering every supported option, its type, default, and example.

The workflow is a **state machine**. A required top-level `states:` block
declares every state an issue can occupy, its `role` (`active` — dispatched;
`terminal` — triggers cleanup and handoff; `holding` — sits outside the
dispatch loop, e.g. `Triage`), and optional per-state `adapter`, `model`,
`max_turns`, and `allowed_transitions` overrides. A single issue can travel
through any number of states with distinct adapters and instructions; the
prompt body can branch on the current state with Liquid
`{% case issue.state %}`. The shipped workflow uses a two-stage
`Todo → Review → Done` flow (Claude implements, Codex reviews).

Symphony watches the file and re-applies poll interval, concurrency, hooks,
prompt body, smolvm settings, etc. on change without restart. In-flight runs
keep the settings they started with.

## Dashboard

When `server.port` is set (or `--port <n>` is passed), a single-page HTMX
dashboard is served at `/`. Five live regions poll their own partials every
2s; idiomorph keeps unchanged DOM stable so polling doesn't twitch text.

- **header strip** — workflow file + tracker root + status badge
  (`working` / `attention` / `idle`).
- **attention** — only present when something needs you. Steering requests
  (question, original task, agent's context, reply textarea) and retry
  queue ease open with a CSS `max-height` transition so the page doesn't
  jump.
- **sessions** — running issues. Two-line rows: identifier + pill + turn +
  tokens, then a dim last-message line.
- **on disk** — active-state issues not currently dispatched.
- **new issue** — collapsed `<details>` form. Posts JSON to
  `POST /api/v1/issues`.
- **totals** — dim footer with token + runtime aggregate.

The steering reply form posts form-encoded with `HX-Request: true` and a
same-origin check. The endpoint also accepts `application/json` for direct
API clients. CSRF-relevant content types (`text/plain`,
`multipart/form-data`) are rejected with 415.

## MCP — how the agent talks back

Symphony injects an MCP server into each ACP session at
`http://<host>:<bound-port>/api/v1/issues/<id>/mcp`, gated by a per-dispatch
bearer token. Three tools:

- **`symphony.transition({ to_state, notes? })`** — canonical (and only)
  exit verb. Moves the issue into another declared state, optionally
  appending markdown `notes` to the issue body before the move so the next
  agent (in `to_state`) reads them as part of `issue.description`. A
  transition into a `role: terminal` state ends the run and triggers
  workspace cleanup; transitions between active/holding states preserve the
  workspace so the same `agent/<id>` git branch survives the handoff.
  Rejected transitions (unknown target, disallowed by
  `allowed_transitions`) return MCP tool-result errors the agent can read
  and retry.
- **`symphony.request_human_steering({ question, context? })`** — call
  when blocked on something only a human can answer. The turn ends
  immediately; the human's reply arrives as the prompt for the next turn.
  Steering-reply turns don't count against `agent.max_turns`.
- **`symphony.propose_issue({ title, description?, labels?, priority? })`** —
  call when the agent notices work that is out of scope for its current
  task. The proposal lands in the `Triage/` state directory, which the
  orchestrator does **not** dispatch; the operator approves (→ first active
  state) or discards (→ first terminal state, prefers `Cancelled`) from the
  dashboard. The calling issue's identifier and a timestamp are stamped into
  the proposal's front-matter as `proposed_by` / `proposed_at` so provenance
  is visible.

In smolvm, the VM's `127.0.0.1` transparently reaches the host's
`127.0.0.1` (verified empirically), so the agent reaches the orchestrator
without any mount or special host alias.

## ACP — adapter registry

One ACP client (symphony's `agent/acp.ts`), two shipped adapter profiles.
Each profile encodes the binary symphony launches and the host credential
file it stages into the workspace before exec:

| Adapter   | Binary             | Host credential file              |
| --------- | ------------------ | --------------------------------- |
| `claude`  | `claude-agent-acp` | `~/.claude/.credentials.json`     |
| `codex`   | `codex-acp`        | `~/.codex/auth.json`              |

`WORKFLOW.md`:

```yaml
acp:
  adapter: claude
  shell: bash
  prompt_timeout_ms: 1800000
  read_timeout_ms: 30000
  stall_timeout_ms: 300000
```

Selecting an adapter is enough — symphony auto-derives the launch command
that stages the credential into the workspace's runtime dir and copies it
into the adapter's expected guest path before exec. Set `command:` only to
override (testing a forked adapter, a non-standard binary path); doing so
opts out of automatic credential staging.

Credentials are **never bind-mounted from the host**. Symphony copies the
single credential file into a per-workspace location (under `.git/` when
the workspace has its own clone, else `.symphony-runtime/`) and refuses to
operate on workspaces inside the credential file's ancestor repo.

## After-run handoff: PR or patch

`WORKFLOW.md`'s `after_run` hook ships in two modes:

- **Pull request mode.** Triggered when `SYMPHONY_REPO=<owner>/<repo>` is
  exported. The hook pushes the per-issue branch to GitHub and runs
  `gh pr create --base $SYMPHONY_BASE_BRANCH ...`. Requires `gh auth status`
  to be clean on the host. The token never enters the VM.
- **Patch bundle mode** (default). Writes
  `.symphony/patches/<branch>.patch` via `git format-patch` so you can
  review and apply with `git am`. No remote required.

Either way, when an issue lands in the `Done` terminal state the hook also
fast-forwards an **agent integration branch** in the source repo (default:
`agent-integration`, created lazily from `SYMPHONY_BASE_BRANCH` on first use).
Subsequent issues clone from the integration branch's tip rather than the base
branch, so an issue dispatched after another one completes sees the prior
agent's commits instead of stale code. Override or disable with
`SYMPHONY_INTEGRATION_BRANCH=<name>` (or `SYMPHONY_INTEGRATION_BRANCH=""` for
the legacy "always branch from base" behavior). Non-fast-forward updates are a
no-op with a warning; the patch bundle is the durable artifact in that case.

The PR title and body come from the issue file itself: title from the
front-matter `title:` (prefixed with the issue id), body from everything
after the front-matter — which includes every `symphony.transition` notes
block accumulated across the run, giving reviewers the full handoff thread.

See [AGENTS.md](./AGENTS.md) for the env-var contract and switch-over
commands.

## Trust posture

Sandbox isolation comes from running each agent inside a smolvm microVM.
The VM has no network credentials (only the agent's API key is forwarded
via `smolvm.forward_env`), no tracker filesystem access (the tracker is
reached only through the MCP server), and stripped git remotes (set by
`after_create`).

Within the ACP session, the orchestrator follows SPEC §10.5's "high-trust"
posture:

- Command execution and file change approvals: auto-approve.
- User-input-required turns: end the turn (the orchestrator retries on
  backoff).
- Unsupported dynamic tool calls: return failure; the session keeps running.

## Tests

```bash
npm run typecheck    # tsc --noEmit
npm test             # 170 tests across workflow, tracker, prompt, workspace,
                     # adapters, http, mcp, acp-bridge, orchestrator, run log,
                     # runner state resolution, and tool-call summary surfaces
npm run build        # tsc emit to dist/
```

An end-to-end smoke run needs a real smolvm + VM image.

See [CHANGELOG.md](./CHANGELOG.md) for operator-visible changes between
releases.

## License

MIT. See [LICENSE](./LICENSE).
