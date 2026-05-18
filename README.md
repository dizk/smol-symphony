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

## Codex inside the VM

`codex app-server` runs **inside** the per-issue smolvm machine. The host workspace
directory is volume-mounted at the same absolute path so the agent's view of paths matches
the host's.

The cleanest setup is a custom OCI image with `codex` pre-installed. Point
`smolvm.image` at it from `WORKFLOW.md`. If `image` is null, smolvm boots a bare Alpine VM
and you can mount the host `codex` binary in via `smolvm.bin_path` (and set
`codex.command` to use it — e.g. `codex.command: /opt/codex/bin/codex app-server`).

For real runs you typically also forward `OPENAI_API_KEY`:

```yaml
smolvm:
  image: my-codex-alpine:latest
  net: true
  forward_env: [OPENAI_API_KEY]
```

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
