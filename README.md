# smol-symphony

A TypeScript implementation of [Symphony](./SPEC.md) — a long-running orchestrator that
reads work from an issue tracker, prepares per-issue workspaces, and runs the
[Codex app-server](https://developers.openai.com/codex/app-server/) for each issue inside
an isolated [smolvm](https://smolmachines.com/) microVM.

## Architecture at a glance

```
┌─────────────────────────────────────────────────────────────────────────┐
│ Symphony (Node.js host)                                                 │
│                                                                         │
│   ┌────────────┐    ┌────────────┐    ┌──────────────┐                  │
│   │ WORKFLOW.md│───▶│ Workflow   │───▶│ Orchestrator │                  │
│   │ (watched)  │    │ + Config   │    │ (single auth)│                  │
│   └────────────┘    └────────────┘    └──────────────┘                  │
│                                              │                          │
│   ┌────────────┐                             ▼                          │
│   │ issues/    │◀────── Local Markdown Tracker                          │
│   │ <state>/   │                             │                          │
│   │  *.md      │                             ▼                          │
│   └────────────┘                       Agent Runner                     │
│                                              │                          │
│                                              ▼ stdio                    │
│                                       ┌──────────────────────────────┐  │
│                                       │ smolvm machine (per issue)   │  │
│                                       │   workspace volume-mounted   │  │
│                                       │   ┌────────────────────────┐ │  │
│                                       │   │ codex app-server       │ │  │
│                                       │   │   JSON-RPC over stdio  │ │  │
│                                       │   └────────────────────────┘ │  │
│                                       └──────────────────────────────┘  │
│                                                                         │
│   HTTP server (optional):  /  (UI),  /api/v1/state,  /api/v1/issues,    │
│                            /api/v1/<identifier>,  /api/v1/refresh       │
└─────────────────────────────────────────────────────────────────────────┘
```

## Quick start

Prerequisites:

- Node.js ≥ 20
- A `smolvm` binary on `$PATH` and the `smolvm` server reachable on the configured endpoint
  (`smolvm serve start --listen unix:///run/user/$UID/smolvm.sock` if not already running)
- A Codex-compatible VM image with `codex` on the guest `$PATH` (see "Codex inside the VM"
  below)

```bash
npm install
npm run build
npx symphony WORKFLOW.md
# or with the dev HTTP UI on http://127.0.0.1:8787
npx symphony WORKFLOW.md --port 8787
```

The CLI is a positional path argument, falling back to `./WORKFLOW.md`.

## Local Markdown tracker

This build ships only the `local` tracker. Issues live as `.md` files under
`tracker.root`. The parent directory becomes the issue state.

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

Each file uses YAML front matter:

```markdown
---
title: "Fix the login bug"
priority: 2
labels: [bug, auth]
blocked_by: [ABC-5]
created_at: "2026-05-18T09:00:00Z"
---
Long-form description in the body.
```

The state comparison is case-insensitive, so directory names like `todo`, `Todo`, or
`TODO` are equivalent.

To move an issue between states, move the file. The polling loop will pick the change up
on the next tick. The agent inside the VM can do this itself (e.g.
`mv ../Todo/ABC-1.md ../Done/`) since the parent `issues/` tree can be exposed via a hook
or shared workspace if needed.

## WORKFLOW.md

`WORKFLOW.md` is a Markdown file with YAML front matter for runtime config and a
[Liquid](https://liquidjs.com/) template for the per-issue prompt. The spec details every
field — see [SPEC.md §5–§6](./SPEC.md). The shipped example covers the common cases.

The orchestrator watches the file and re-applies config (poll interval, concurrency,
hooks, prompt template, smolvm settings) on change without restart. In-flight runs keep
the settings they started with.

## HTTP UI

When `--port` (or `server.port` in `WORKFLOW.md`) is set, a small dashboard is hosted at
`/`:

- A form to create new issues. POSTs to `/api/v1/issues`. The `state` field is restricted
  to the configured active/terminal states.
- A live status table (polls `/api/v1/state` every 2s) showing active sessions, the retry
  queue, and aggregate token totals.
- A list of all issues on disk so you can see ones that are idle.

`POST /api/v1/refresh` triggers an immediate poll + reconciliation cycle.

## ACP — talking to Claude, Codex, and OpenCode

Symphony speaks the [Agent Client Protocol](https://agentclientprotocol.com) (Zed's open
JSON-RPC protocol for coding agents). One client, three (and counting) compatible adapters
shipping inside the VM image:

| Adapter                   | Command inside VM         | Source                                          |
| ------------------------- | ------------------------- | ----------------------------------------------- |
| Claude Code               | `claude-agent-acp`        | `@agentclientprotocol/claude-agent-acp`         |
| Codex                     | `codex-acp`               | `@zed-industries/codex-acp` (glibc prebuilt)    |
| OpenCode                  | `opencode acp`            | `opencode-ai`                                   |

Switching agents is a one-line change in `WORKFLOW.md`:

```yaml
acp:
  adapter: claude         # label only — appears in logs
  command: claude-agent-acp
  shell: bash
  prompt_timeout_ms: 1800000
  read_timeout_ms: 30000
  stall_timeout_ms: 300000
```

For Codex, use `command: codex-acp`. For OpenCode, use `command: opencode acp`.

### Token accounting under ACP

ACP's `usage_update` reports **context-window usage** (`used / size`), not cumulative
input/output tokens. Symphony maps `used` into `total_tokens` and leaves `input_tokens` /
`output_tokens` as zero. If you need true I/O token totals, an adapter-specific MCP server
or `_meta` extension is the right place to surface it.

## The VM image

The shipped `scripts/build-vm.sh` builds a packed `.smolmachine` artifact that contains
`node:20-bookworm-slim` + `git`, `ripgrep`, `curl`, `ca-certificates`, and the four
agent-related npm packages above. Debian is used instead of Alpine because `codex-acp`'s
prebuilt is glibc-linked.

```bash
bash scripts/build-vm.sh
# -> .vm/symphony.smolmachine.smolmachine  (~1.1 GB compressed)
```

`WORKFLOW.md` then references it via `smolvm.from`:

```yaml
smolvm:
  from: ./.vm/symphony.smolmachine.smolmachine
  cpus: 2
  mem_mib: 4096
  net: true
  volumes:
    - host: ~/.claude          # claude-agent-acp credentials + per-session SQLite
      guest: /root/.claude
      readonly: false
    - host: ~/.codex           # codex-acp credentials, if you use that adapter
      guest: /root/.codex
      readonly: false
  forward_env: [OPENAI_API_KEY, ANTHROPIC_API_KEY]
```

The credential mounts are **read-write** because the adapters need to write per-session
state into their respective home dirs. If you want stricter isolation, copy auth files
into a per-workspace location and mount only that.

Other ways to provide a VM image:
- `smolvm.image: my-agent-image:latest` — pull from a registry.
- `smolvm.image: null` + `smolvm.bin_path: /host/path/to/agent` — boot a bare VM and mount
  the adapter binary in.

## Trust posture

This implementation follows the SPEC §10.5 "high-trust" example posture:

- Command execution and file change approvals: **auto-approve** (accept-for-session).
- User-input-required turns: **fail the run** (the orchestrator retries on backoff).
- Unsupported dynamic tool calls: **return failure**, the session keeps running.

Sandbox isolation comes from running each agent inside a smolvm microVM whose only
external resource is the workspace volume.

## Testing

```bash
npm test         # unit tests for workflow / tracker / prompt / workspace
npm run build    # tsc typecheck + emit dist/
```

A real end-to-end smoke run requires a VM image with `codex` available.
