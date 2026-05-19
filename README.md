# smol-symphony

A small TypeScript orchestrator that reads issues off a local Markdown tracker,
prepares per-issue workspaces, and runs coding agents (Claude Code, Codex,
OpenCode) inside isolated [smolvm](https://smolmachines.com/) microVMs over the
[Agent Client Protocol](https://agentclientprotocol.com).

The agent signals completion through an injected MCP server (`mark_done`,
`request_human_steering`); the orchestrator handles state, retry, concurrency,
and produces either a pull request or a `git format-patch` bundle per issue.

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
│              ( mark_done · request_human_steering )                      │
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
issue state.

```
issues/
├── Todo/
│   ├── ABC-1.md
│   └── ABC-2.md
├── In Progress/
│   └── ABC-3.md
└── Done/
    └── ABC-4.md
```

Each file has YAML front matter and an optional body:

```markdown
---
title: "Fix the login bug"
priority: 2
labels: [bug, auth]
blocked_by: [ABC-5]
---
Long-form description in the body.
```

State comparison is case-insensitive. Moving the file between state
directories is the canonical state transition; the orchestrator does this
itself in response to `mark_done`. The agent inside the VM does **not** have
filesystem access to the tracker root: it signals completion through the
MCP server and the orchestrator does the file move.

## WORKFLOW.md

`WORKFLOW.md` is a YAML front matter block (orchestrator config) plus a
[Liquid](https://liquidjs.com/)-templated prompt body. The shipped file in
this repo is the canonical project workflow; see
[WORKFLOW.template.md](./WORKFLOW.template.md) for the annotated reference
covering every supported option, its type, default, and example.

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
bearer token. Two tools:

- **`symphony.mark_done({ title, summary })`** — call once at end of a
  successful run. `title` is a single-line imperative summary (≤72 chars);
  `summary` is a one- to three-paragraph narrative. The orchestrator
  atomically moves the issue file to the terminal state and stops
  dispatching. The pair lands in
  `<workspace>/.git/symphony-runtime/mark_done.md` (or
  `<workspace>/.symphony-runtime/mark_done.md` when the workspace doesn't
  have its own `.git/`) for the `after_run` hook to consume.
- **`symphony.request_human_steering({ question, context? })`** — call
  when blocked on something only a human can answer. The turn ends
  immediately; the human's reply arrives as the prompt for the next turn.
  Steering-reply turns don't count against `agent.max_turns`.

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

The agent's `mark_done.md` provides the PR title/body or commit message; the
hook reads it from the workspace's runtime dir.

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
npm test             # 67 tests across workflow, tracker, prompt, workspace,
                     # adapters, http, and mcp surfaces
npm run build        # tsc emit to dist/
```

An end-to-end smoke run needs a real smolvm + VM image.

## License

MIT. See [LICENSE](./LICENSE).
