# Symphony Service Specification (smol-symphony)

Status: trimmed reference v1

> **Scope.** This document captures the contracts that smol-symphony's code
> references — workspace safety, ACP approval posture, tracker adapter
> contract, prompt rendering, logging, etc. The broader architectural
> narrative was originally derived from
> [openai/symphony](https://github.com/openai/symphony/blob/main/SPEC.md); see
> that document for the original design context. This trimmed version is what
> stays in sync with this repo's code. Sections describing the polling loop,
> reconciler subsystem, retry mechanics, and reference algorithms have been
> removed — `src/orchestrator.ts`, `src/reconciler/`, and the test suite under
> `tests/` are the authoritative source for those behaviors.

## Normative Language

The key words `MUST`, `MUST NOT`, `REQUIRED`, `SHOULD`, `SHOULD NOT`,
`RECOMMENDED`, `MAY`, and `OPTIONAL` in this document are to be interpreted as
described in RFC 2119.

`Implementation-defined` means the behavior is part of the implementation
contract, but this specification does not prescribe one universal policy.

## 1. Problem Statement

Symphony is a long-running automation service that continuously reads work
from an issue tracker, creates an isolated workspace for each issue, and runs
a coding agent session for that issue inside the workspace.

The service solves four operational problems:

- It turns issue execution into a repeatable daemon workflow instead of manual
  scripts.
- It isolates agent execution in per-issue workspaces so agent commands run
  only inside per-issue workspace directories.
- It keeps the workflow policy in-repo (`WORKFLOW.md`) so teams version the
  agent prompt and runtime settings with their code.
- It provides enough observability to operate and debug multiple concurrent
  agent runs.

Boundary:

- Symphony is a scheduler/runner and tracker reader.
- Ticket writes (state transitions, comments, PR links) are typically
  performed by the coding agent using tools available in the workflow/runtime
  environment.
- A successful run can end at a workflow-defined handoff state (for example
  `Review`), not necessarily `Done`.

## 2. Goals and Non-Goals

### 2.1 Goals

- Poll the issue tracker on a fixed cadence and dispatch work with bounded
  concurrency.
- Maintain a single authoritative orchestrator state for dispatch, retries,
  and reconciliation.
- Create deterministic per-issue workspaces and preserve them across runs.
- Stop active runs when issue state changes make them ineligible.
- Recover from transient failures with exponential backoff.
- Load runtime behavior from a repository-owned `WORKFLOW.md` contract.
- Expose operator-visible observability (at minimum structured logs).
- Support tracker/filesystem-driven restart recovery without requiring a
  persistent database; exact in-memory scheduler state is not restored.

### 2.2 Non-Goals

- Rich web UI or multi-tenant control plane.
- Prescribing a specific dashboard or terminal UI implementation.
- General-purpose workflow engine or distributed job scheduler.
- Built-in business logic for how to edit tickets, PRs, or comments. (That
  logic lives in the workflow prompt and agent tooling.)
- Mandating strong sandbox controls beyond what the coding agent and host OS
  provide.

## 3. Core Domain Model

This section defines the entities the orchestrator passes around. The
TypeScript view lives in `src/types.ts`.

### 3.1 Entities

#### 3.1.1 Issue

Normalized issue record used by orchestration, prompt rendering, and
observability output.

Fields:

- `id` (string) — stable tracker-internal ID.
- `identifier` (string) — human-readable ticket key (example: `ABC-123`).
- `title` (string)
- `description` (string or null)
- `priority` (integer or null) — lower numbers are higher priority in dispatch
  sorting.
- `state` (string) — current tracker state name.
- `branch_name` (string or null) — tracker-provided branch metadata if
  available.
- `url` (string or null)
- `labels` (list of strings) — normalized to lowercase.
- `blocked_by` (list of blocker refs); each blocker ref contains:
  - `id` (string or null)
  - `identifier` (string or null)
  - `state` (string or null)
- `created_at` (timestamp or null)
- `updated_at` (timestamp or null)

#### 3.1.2 Workflow Definition

Parsed `WORKFLOW.md` payload:

- `config` (map) — YAML front matter root object.
- `prompt_template` (string) — Markdown body after front matter, trimmed.

#### 3.1.3 Service Config (Typed View)

Typed runtime values derived from `WorkflowDefinition.config` plus environment
resolution: poll interval, workspace root, active/terminal states, concurrency
limits, coding-agent executable/args/timeouts, workspace hooks.

#### 3.1.4 Workspace

Filesystem workspace assigned to one issue identifier. Logical fields:
`path` (absolute), `workspace_key` (sanitized identifier), `created_now`
(boolean, gates `after_create`).

#### 3.1.5 Live Session

State tracked while a coding-agent subprocess is running: `session_id`
(`<thread_id>-<turn_id>`), `thread_id`, `turn_id`, `adapter_pid`,
`last_event`, `last_event_at`, `last_message`, cumulative
`input_tokens`/`output_tokens`/`total_tokens`, `last_reported_*` counters
used to convert absolute totals to deltas, and `turn_count` (turns started
within the current worker lifetime).

#### 3.1.6 Retry Entry

Scheduled retry state for an issue: `issue_id`, `identifier`, `attempt`
(1-based), `due_at_ms`, `error`, `kind` (`continuation` after a normal exit,
`failure` after an abnormal exit), and `target_state` (the state the next
attempt dispatches into).

### 3.2 Stable Identifiers and Normalization Rules

- `Issue ID` — use for tracker lookups and internal map keys.
- `Issue Identifier` — use for human-readable logs and workspace naming.
- `Workspace Key` — derive from `issue.identifier` by replacing any character
  not in `[A-Za-z0-9._-]` with `_`. Use the sanitized value for the workspace
  directory name.
- `Normalized Issue State` — compare states after `lowercase`.
- `Session ID` — compose from coding-agent `thread_id` and `turn_id` as
  `<thread_id>-<turn_id>`.

## 4. Workflow Specification (Repository Contract)

### 4.1 File Discovery and Path Resolution

Workflow file path precedence:

1. Explicit application/runtime setting (set by CLI startup path).
2. Default: `WORKFLOW.md` in the current process working directory.

Loader behavior:

- If the file cannot be read, return `missing_workflow_file` error.
- The workflow file is expected to be repository-owned and version-controlled.

### 4.2 File Format

`WORKFLOW.md` is a Markdown file with OPTIONAL YAML front matter.

Parsing rules:

- If file starts with `---`, parse lines until the next `---` as YAML front
  matter.
- Remaining lines become the prompt body.
- If front matter is absent, treat the entire file as prompt body and use an
  empty config map.
- YAML front matter MUST decode to a map/object; non-map YAML is an error.
- Prompt body is trimmed before use.

Returned workflow object:

- `config`: front matter root object (not nested under a `config` key).
- `prompt_template`: trimmed Markdown body.

### 4.3 Front Matter Schema

Top-level keys: `tracker`, `states`, `polling`, `workspace`, `hooks`, `agent`,
`acp`. Unknown keys SHOULD be ignored for forward compatibility. Extensions
MAY define additional top-level keys without changing the core schema.

`WORKFLOW.template.md` is the annotated reference for every recognized field;
this section captures the contract the loader enforces.

#### 4.3.1 `tracker` (object)

- `kind` (string) — REQUIRED for dispatch; tracker-specific.

The set of recognised states and their roles is declared in the top-level
`states:` block (see §4.3.7), not under `tracker`. The tracker reads role
membership via `activeStateNames(states)` / `terminalStateNames(states)` (or
by inspecting `states[*].role` directly).

Tracker kinds MAY require additional fields under `tracker`. Implementations
MUST document the required fields, defaults, and validation rules for each
supported kind.

#### 4.3.2 `polling` (object)

- `interval_ms` (integer, default `30000`)

#### 4.3.3 `workspace` (object)

- `root` (path string or `$VAR`, default `<system-temp>/symphony_workspaces`)
- `~` is expanded; relative paths are resolved relative to the directory
  containing `WORKFLOW.md`. The effective workspace root is normalized to an
  absolute path before use.

#### 4.3.4 `hooks` (object)

- `after_create` (multiline shell script, OPTIONAL) — runs only when a
  workspace directory is newly created. Failure aborts workspace creation.
- `before_run` (multiline shell script, OPTIONAL) — runs before each agent
  attempt. Failure aborts the current attempt.
- `after_run` (multiline shell script, OPTIONAL) — runs after each agent
  attempt. Failure is logged but ignored.
- `before_remove` (multiline shell script, OPTIONAL) — runs before workspace
  deletion if the directory exists. Failure is logged but ignored.
- `timeout_ms` (integer, OPTIONAL, default `60000`) — applies to all hooks.

#### 4.3.5 `agent` (object)

- `max_concurrent_agents` (integer, default `10`)
- `max_turns` (positive integer, default `20`) — coding-agent turns within
  one worker session.
- `max_retry_backoff_ms` (integer, default `300000`)
- `max_concurrent_agents_by_state` (map `state_name -> positive integer`,
  default empty). State keys are normalized (`lowercase`) for lookup; invalid
  entries are ignored.

#### 4.3.6 `acp` (object)

Coding-agent launch is mediated by the Agent Client Protocol. The runtime
selects an adapter profile and runs it inside the per-issue sandbox; the host
opens an authenticated TCP bridge that the in-sandbox proxy dials back over
to carry ACP frames. See `WORKFLOW.template.md` (`acp:` section) for the full
annotated field list.

Fields read by the runtime:

- `adapter` (string, default `claude`) — selects an adapter profile (`claude`,
  `codex`, …).
- `model` (string or null, default `null`)
- `shell` (string, default `bash`)
- `prompt_timeout_ms` (integer, default `3600000`)
- `read_timeout_ms` (integer, default `30000`)
- `stall_timeout_ms` (integer, default `300000`; `<= 0` disables stall
  detection)
- `bridge` (object) — `bind_host`, `bind_port`, `reach_host`, `reach_url`,
  `connect_timeout_ms`; see `WORKFLOW.template.md`.

#### 4.3.7 `states` (map)

REQUIRED. Declares every tracker state the workflow recognises and the
per-state dispatch configuration. A workflow that omits the block, or that
omits any of the three roles (`active`, `terminal`, `holding`), is rejected
at parse time.

Each entry has the shape:

- `role` (enum, REQUIRED)
  - `active` — orchestrator dispatches issues in this state.
  - `terminal` — orchestrator treats issues in this state as complete; the
    workspace is removed after the run unwinds.
  - `holding` — directory exists on disk but the orchestrator never
    dispatches it. The landing state for `symphony.propose_issue` is the
    first declared `holding` state.
- `adapter` (string, OPTIONAL) — overrides the workflow-level `acp.adapter`
  for agents dispatched in this state.
- `model` (string or null, OPTIONAL) — overrides `acp.model` for this state.
- `max_turns` (integer, OPTIONAL) — overrides `agent.max_turns` for this
  state.
- `allowed_transitions` (list of strings or null, OPTIONAL) — when non-null,
  restricts which states agents in this state may move to via the MCP
  `symphony.transition` tool. `null` (or omitted) means "any declared state
  is reachable"; `[]` means "no transitions allowed out of this state".

Declaration order is preserved: role-filtered listings and the dashboard
render columns in the same order.

### 4.4 Prompt Template Contract

The Markdown body of `WORKFLOW.md` is the per-issue prompt template.

Rendering requirements:

- Use a strict template engine (Liquid-compatible semantics are sufficient).
- Unknown variables MUST fail rendering.
- Unknown filters MUST fail rendering.

Template input variables:

- `issue` (object) — includes all normalized issue fields, including labels
  and blockers.
- `attempt` (integer or null) — `null`/absent on first attempt; integer on
  retry or continuation run.

Fallback prompt behavior:

- If the workflow prompt body is empty, the runtime MAY use a minimal default
  prompt (`You are working on an issue.`).
- Workflow file read/parse failures are configuration/validation errors and
  SHOULD NOT silently fall back to a prompt.

### 4.5 Workflow Validation and Error Surface

Error classes:

- `missing_workflow_file`
- `workflow_parse_error`
- `workflow_front_matter_not_a_map`
- `template_parse_error` (during prompt rendering)
- `template_render_error` (unknown variable/filter, invalid interpolation)

Dispatch gating behavior:

- Workflow file read/YAML errors block new dispatches until fixed.
- Template errors fail only the affected run attempt.

## 5. Workspace Management and Safety

### 5.1 Workspace Layout

Workspace root: `workspace.root` (normalized absolute path). Per-issue
workspace path: `<workspace.root>/<sanitized_issue_identifier>`. Workspaces
are reused across runs for the same issue; successful runs do not auto-delete
workspaces.

### 5.2 Workspace Creation and Reuse

Input: `issue.identifier`.

Algorithm summary:

1. Sanitize identifier to `workspace_key`.
2. Compute workspace path under workspace root.
3. Ensure the workspace path exists as a directory.
4. Mark `created_now=true` only if the directory was created during this
   call; otherwise `created_now=false`.
5. If `created_now=true`, run the built-in canonical workspace setup
   (§5.3).
6. If `created_now=true`, run `after_create` hook if configured (after the
   canonical setup).

Concurrent callers for the same identifier MUST coalesce so the canonical
setup and `after_create` hook each run exactly once per workspace creation.

### 5.3 Built-in Workspace Population

The workspace lifecycle is owned by the orchestrator, not the workflow. On
first creation, the implementation MUST clone the source repository into the
workspace path, check out the configured base branch, and cut a per-issue
branch off the base, before running any optional `after_create` hook glue.

Canonical setup steps, in order, against the empty workspace directory:

1. Validate the source repository looks like a git repository.
2. `git clone --local --no-tags --branch <base>` from the source repo into
   the workspace path (hardlinked clone so the workspace's object store is a
   cheap delta over the source's at clone time).
3. Strip every remote the clone copied over and unset any inherited
   `credential.helper`, so any subsequent `git push`/`git fetch` from inside
   the workspace (including from within a dispatched VM) fails closed by
   default.
4. When configured for a remote repository (e.g. an `origin` URL known via
   env), restore `origin` pointing at the canonical HTTPS URL. The restore
   MUST NOT embed credentials; auth is provided host-side (e.g. by
   `gh auth setup-git`) so a host-side terminal hook can push without the
   token ever entering the workspace or any VM derived from it.
5. Pin commit identity in `--local` git config so commits carry a stable
   author/committer that never leaks into the operator's global git config.
6. `git checkout -b <branch>` for the per-issue branch (typically
   `agent/<id>`) off the base SHA.

The source repository's local `<base>` is the single source of truth for the
workspace's base ref. Implementations MUST NOT implicitly fetch from a
different ref (e.g. `origin/<base>`) and reset the workspace base to it; a
divergent source of truth would produce false-positive drift on a freshly
created workspace. Operators pick up a new base by updating the source repo
before the next dispatch.

Failure handling:

- Failure of any canonical setup step is fatal to workspace creation. The
  partially prepared directory MUST be removed so the next dispatch tick
  re-enters cleanly. `after_create` hook failure is also fatal.
- Reused workspaces are NOT destructively reset on subsequent dispatches;
  canonical setup runs only when the directory was created during the
  current ensure call.

Note: a shared integration-branch flow was prototyped but is currently
disabled; canonical clone is the only supported workspace source.

### 5.4 Workspace Hooks

Supported hooks: `hooks.after_create`, `hooks.before_run`, `hooks.after_run`,
`hooks.before_remove`.

Execution contract:

- Execute in a local shell context appropriate to the host OS, with the
  workspace directory as `cwd`. On POSIX systems, `sh -lc <script>` (or
  `bash -lc <script>`) is a conforming default.
- Hook timeout uses `hooks.timeout_ms`; default `60000 ms`.
- Log hook start, failures, and timeouts.

Failure semantics:

- `after_create` failure or timeout is fatal to workspace creation.
- `before_run` failure or timeout is fatal to the current run attempt.
- `after_run` failure or timeout is logged and ignored.
- `before_remove` failure or timeout is logged and ignored.

### 5.5 Safety Invariants

This is the most important portability constraint.

Invariant 1: Run the coding agent only in the per-issue workspace path.

- Before launching the coding-agent subprocess, validate `cwd ==
  workspace_path`.

Invariant 2: Workspace path MUST stay inside workspace root.

- Normalize both paths to absolute.
- Require `workspace_path` to have `workspace_root` as a prefix directory.
- Reject any path outside the workspace root.

Invariant 3: Workspace key is sanitized.

- Only `[A-Za-z0-9._-]` allowed in workspace directory names.
- Replace all other characters with `_`.

## 6. Agent Runner Protocol (Coding Agent Integration)

The reference implementation speaks the Agent Client Protocol (ACP) to one
of the known adapter profiles (`claude` via `claude-agent-acp`, `codex` via
`codex-acp`). ACP is the source of truth for protocol schemas, message
payloads, transport framing, and method names — implementations MUST consult
ACP documentation (https://agentclientprotocol.com) or its generated schema
rather than treating this specification as a protocol schema.

### 6.1 Approval, Tool Calls, and User Input Policy

Approval, sandbox, and user-input behavior is implementation-defined, with
two requirements:

- Each implementation MUST document its chosen approval, sandbox, and
  operator-confirmation posture.
- Approval requests and user-input-required events MUST NOT leave a run
  stalled indefinitely. An implementation MAY either satisfy them, surface
  them to an operator, auto-resolve them, or fail the run according to its
  documented policy.

**smol-symphony "high-trust" posture (the implementation in this repo):**

- Auto-approve command execution approvals for the session.
- Auto-approve file-change approvals for the session (`allow_always`).
- Treat user-input-required turns as hard failure.

Unsupported dynamic tool calls:

- Supported dynamic tool calls that are explicitly implemented and advertised
  by the runtime SHOULD be handled according to their extension contract.
- If the agent requests a dynamic tool call that is not supported, return a
  tool failure response using the targeted protocol and continue the session.
  This prevents the session from stalling on unsupported tool execution
  paths.

Optional client-side tool extension:

- An implementation MAY expose a limited set of client-side tools to the ACP
  session, advertised through the per-issue MCP endpoint stamped as a client
  capability during the ACP initialize handshake. smol-symphony advertises
  `symphony.transition`, `symphony.request_human_steering`, and
  `symphony.propose_issue`.

### 6.2 Agent Runner Contract

The `Agent Runner` wraps workspace + prompt + ACP adapter client.

Behavior:

1. Create/reuse workspace for issue.
2. Build prompt from workflow template.
3. Start ACP session via the configured adapter.
4. Forward ACP events to orchestrator.
5. On any error, fail the worker attempt (the orchestrator will retry).

Note: workspaces are intentionally preserved after successful runs.

## 7. Issue Tracker Integration Contract

### 7.1 REQUIRED Operations

An implementation MUST support these tracker adapter operations:

1. `fetch_candidate_issues()` — return issues in configured active states.
2. `fetch_issues_by_states(state_names)` — used for workspace lifecycle
   reconciliation.
3. `fetch_issue_states_by_ids(issue_ids)` — used for active-run
   reconciliation.

Empty input to `fetch_issues_by_states([])` MUST return empty without an
external call.

### 7.2 Implementation Notes

- Tracker-kind-specific transport, auth, and query mechanics are defined by
  the implementation of each tracker adapter.
- Normalized outputs MUST match the domain model in §3 regardless of
  transport.

### 7.3 Normalization Rules

Candidate issue normalization SHOULD produce fields listed in §3.1.1.

Additional normalization details:

- `labels` → lowercase strings.
- `blocked_by` → resolved from tracker-defined blocker references (for the
  local tracker, the front-matter `blocked_by` list of identifiers).
- `priority` → integer only (non-integers become null).
- `created_at` and `updated_at` → parse ISO-8601 timestamps.
- State comparison is case-insensitive.

### 7.4 Tracker Writes (Important Boundary)

Symphony does not require first-class tracker write APIs in the
orchestrator.

- Ticket mutations (state transitions, comments, PR metadata) are handled by
  the coding agent using tools defined by the workflow prompt.
- The service remains a scheduler/runner and tracker reader.
- Workflow-specific success often means "reached the next handoff state"
  (for example `Review`) rather than tracker terminal state `Done`.

State-transition primitives are exposed to in-VM agents through the MCP
surface — specifically the `symphony.transition({ to_state, notes? })` tool.
The tracker is the authoritative writer: the MCP layer validates `to_state`
against the workflow's declared `states:` map and any per-state
`allowed_transitions`, then delegates the notes-append + atomic file move to
`tracker.moveIssueToState`. The per-issue workspace and `agent/<id>` git
branch persist across non-terminal transitions (active ↔ active,
active → holding); cleanup is driven by the target state's role
(`role: terminal` ⇒ remove workspace, otherwise keep).

## 8. Prompt Construction and Context Assembly

### 8.1 Inputs

Inputs to prompt rendering:

- `workflow.prompt_template`
- normalized `issue` object
- OPTIONAL `attempt` integer (retry/continuation metadata)

### 8.2 Rendering Rules

- Render with strict variable checking (unknown variables fail).
- Render with strict filter checking (unknown filters fail).
- Convert issue object keys to strings for template compatibility.
- Preserve nested arrays/maps (labels, blockers) so templates can iterate.

### 8.3 Retry/Continuation Semantics

`attempt` SHOULD be passed to the template because the workflow prompt can
provide different instructions for:

- first run (`attempt` null or absent)
- continuation run after a successful prior session
- retry after error/timeout/stall

### 8.4 Failure Semantics

If prompt rendering fails, fail the run attempt immediately and let the
orchestrator treat it like any other worker failure.

## 9. Logging, Status, and Observability

### 9.1 Logging Conventions

REQUIRED context fields for issue-related logs:

- `issue_id`
- `issue_identifier`

REQUIRED context for coding-agent session lifecycle logs:

- `session_id`

Message formatting requirements:

- Use stable `key=value` phrasing.
- Include action outcome (`completed`, `failed`, `retrying`, etc.).
- Include concise failure reason when present.
- Avoid logging large raw payloads unless necessary.

### 9.2 Logging Outputs and Sinks

The spec does not prescribe where logs are written (stderr, file, remote
sink, etc.).

Requirements:

- Operators MUST be able to see startup/validation/dispatch failures without
  attaching a debugger.
- Implementations MAY write to one or more sinks.
- If a configured log sink fails, the service SHOULD continue running when
  possible and emit an operator-visible warning through any remaining sink.
  A failed sink MUST NOT crash the orchestrator.

### 9.3 Runtime Snapshot / Monitoring Interface (OPTIONAL but RECOMMENDED)

If the implementation exposes a synchronous runtime snapshot (for dashboards
or monitoring), it SHOULD return:

- `running` (list of running session rows); each row SHOULD include
  `turn_count`.
- `retrying` (list of retry queue rows).
- `session_totals`: `input_tokens`, `output_tokens`, `total_tokens`,
  `seconds_running` (aggregate runtime seconds as of snapshot time,
  including active sessions).
- `rate_limits` (latest coding-agent rate limit payload, if available).

RECOMMENDED snapshot error modes: `timeout`, `unavailable`.

### 9.4 Session Metrics and Token Accounting

Token accounting rules:

- Agent events can include token counts in multiple payload shapes.
- Prefer absolute thread totals when available, such as
  `thread/tokenUsage/updated` payloads or `total_token_usage` within
  token-count wrapper events.
- Ignore delta-style payloads such as `last_token_usage` for dashboard/API
  totals.
- Extract input/output/total token counts leniently from common field names
  within the selected payload.
- For absolute totals, track deltas relative to last reported totals to
  avoid double-counting.
- Do not treat generic `usage` maps as cumulative totals unless the event
  type defines them that way.
- Accumulate aggregate totals in orchestrator state.

Runtime accounting:

- Runtime SHOULD be reported as a live aggregate at snapshot/render time.
- Implementations MAY maintain a cumulative counter for ended sessions and
  add active-session elapsed time derived from `running` entries (for
  example `started_at`) when producing a snapshot/status view.
- Continuous background ticking of runtime totals is not REQUIRED.

Rate-limit tracking:

- Track the latest rate-limit payload seen in any agent update.
- Any human-readable presentation of rate-limit data is
  implementation-defined.

### 9.5 OPTIONAL HTTP Server Extension

An OPTIONAL HTTP interface for observability and operational control. The
dashboard/API MUST be observability/control surfaces only and MUST NOT become
REQUIRED for orchestrator correctness.

Extension config:

- `server.port` (integer, OPTIONAL) — enables the HTTP server. `0` requests
  an ephemeral port. CLI `--port` overrides `server.port` when both are
  present. Implementations SHOULD bind loopback by default unless explicitly
  configured otherwise.

Minimum endpoints (if shipped):

- `GET /` — human-readable dashboard.
- `GET /api/v1/state` — summary view (running sessions, retry queue,
  aggregate token/runtime totals, latest rate limits).
- `GET /api/v1/<issue_identifier>` — issue-specific runtime/debug details.
  Returns `404` for unknown issues with `{"error":{"code":"issue_not_found",
  "message":"..."}}`.
- `POST /api/v1/refresh` — queues an immediate tracker poll + reconciliation
  cycle (best-effort; implementations MAY coalesce repeated requests).
  Suggested response `202 Accepted`.

Endpoints SHOULD be read-only except for operational triggers like
`/refresh`. Unsupported methods on defined routes SHOULD return `405`. API
errors SHOULD use a JSON envelope such as
`{"error":{"code":"...","message":"..."}}`.
