<!--
WORKFLOW.template.md — annotated reference for symphony workflow files.

A workflow file is a YAML front-matter block plus a Liquid-templated prompt
body. The orchestrator parses the front matter into ServiceConfig (defined in
src/types.ts) and renders the prompt body once per dispatched issue, with the
Liquid context `{ issue, attempt }`.

This document lists every supported section, every option within it, the
parser default, and a small example. For a complete worked example, see
WORKFLOW.md in this repo.

Notation:
  • Required keys are marked (required).
  • Types: `string`, `int`, `bool`, `path` (string resolved relative to the
    workflow file's directory unless absolute), `string[]`, `map<K, V>`.
  • Defaults are what the parser writes when the key is absent.
-->

---
# ─────────────────────────────────────────────────────────────────────────────
# tracker — where issues come from.
# ─────────────────────────────────────────────────────────────────────────────
tracker:
  # kind (required): currently the only supported value is 'local' (markdown
  # files under `root`, one per issue, organized by state subdirectory).
  kind: local

  # root (path): directory containing `<state>/<id>.md` files. Required.
  # Resolved relative to the workflow file if not absolute.
  root: ./issues

# ─────────────────────────────────────────────────────────────────────────────
# states — per-state configuration map. REQUIRED. Every workflow must declare
# at least one `active`, one `terminal`, and one `holding` state; a workflow
# missing the `states:` block (or missing any of those roles) is rejected at
# parse time. This map is the only place state names and roles are configured;
# there are no separate active/terminal lists to keep in sync.
#
# Keys are state names; values are config objects with these fields:
#   role (required, enum):
#     active   — orchestrator dispatches issues in this state.
#     terminal — orchestrator treats issues in this state as complete; the
#                workspace is removed after the run unwinds.
#     holding  — directory exists on disk, but the orchestrator never
#                dispatches issues from it. Triage is the canonical example
#                and the landing directory for `symphony.propose_issue`.
#   adapter   (string, optional): override the workflow-level `acp.adapter` for
#             agents dispatched in this state. Must be a known profile (claude,
#             codex) and its host credential must be readable at startup.
#   model     (string, optional): override `acp.model` for this state.
#             Blank or whitespace-only values normalize to "use the adapter
#             default" (same as the workflow-level acp.model semantics).
#   effort    (string, optional): override `acp.effort` for this state. Same
#             undefined-vs-null semantics as `model`: omit to inherit
#             `acp.effort`; blank/whitespace normalizes to null ("use the
#             adapter default for this state"). Valid values are adapter- and
#             model-specific (see `acp.effort`).
#   max_turns (int, optional): override `agent.max_turns` for this state.
#   allowed_transitions (string[]|null, optional): when set, restricts which
#             states agents in this state may transition to via the MCP
#             `transition` tool. Each entry must be a declared state. Omit (or
#             explicitly set to null) for "any declared state is reachable".
#             An empty list (`allowed_transitions: []`) means "no transitions
#             allowed out of this state" — the agent's `transition` calls will
#             always be rejected with `transition_not_allowed`. Useful for
#             review-style states that should pause until a human re-routes.
#   hooks     (map, optional): per-state overrides for the workflow-level `hooks:`
#             block. Each of `after_create`, `before_run`, `after_run`, and
#             `before_remove` is optional; an omitted key inherits the
#             workflow-level hook, an explicit `null` suppresses it for this
#             state, and a string replaces it. Resolution is by the issue's
#             state at hook-fire time — when the agent calls
#             `symphony.transition`, after_run and before_remove are resolved
#             against the POST-transition state, so a terminal-state's hook can
#             drive a state-specific handoff (e.g. Done opens a PR; Merge runs
#             an auto-merge; Cancelled writes only a patch). The shared
#             `timeout_ms` is not overridable per state.
#
# Declaration order matters: role-filtered listings (active states, terminal
# states) follow it, and the dashboard renders state columns in the same order.
# ─────────────────────────────────────────────────────────────────────────────
states:
  Todo:
    role: active
    adapter: claude
    model: claude-opus-4-7
    effort: xhigh
    max_turns: 10
  Review:
    role: active
    adapter: codex
    model: gpt-5-codex
    max_turns: 4
    allowed_transitions: [Todo, Done]
  Done:
    role: terminal
    # Per-state hooks let each terminal state drive its own handoff. Done could
    # push the branch and open a PR; a sibling Merge state could push, open the
    # PR, then auto-merge; Cancelled could opt out entirely with `after_run: null`.
    # hooks:
    #   after_run: |
    #     # state-specific PR-create logic here
  Cancelled:
    role: terminal
  Triage:
    role: holding

# ─────────────────────────────────────────────────────────────────────────────
# polling — how often to poll the tracker.
# ─────────────────────────────────────────────────────────────────────────────
polling:
  # interval_ms (int): tick interval, milliseconds.
  # Default: 30000
  interval_ms: 5000

# ─────────────────────────────────────────────────────────────────────────────
# workspace — per-issue working directory.
# ─────────────────────────────────────────────────────────────────────────────
workspace:
  # root (path): parent directory holding `<issue-id>/` working trees.
  # Default: $TMPDIR/symphony_workspaces
  root: ./.symphony/workspaces

# ─────────────────────────────────────────────────────────────────────────────
# logs — per-issue JSONL run logs (everything to/from the VM, plus hooks).
#
# One file per issue at `<root>/<sanitized-identifier>.jsonl`, appended across
# attempts AND across symphony process restarts. Each line is a self-describing
# JSON object with `ts`, `issue_id`, `attempt`, and a `channel` discriminator:
#
#   channel: "acp"     — JSON-RPC frame between host and the in-VM adapter.
#                        `direction` ("host_to_vm" | "vm_to_host") and `frame`
#                        (parsed JSON) — or `kind: "unparseable"` + `raw`.
#   channel: "stderr"  — raw byte chunk from the adapter / VM stderr.
#   channel: "hook"    — stdout/stderr chunk from a host-side hook, plus a final
#                        `kind: "result"` line (exit_code, signal, timed_out).
#                        `hook` field names which hook: after_create | before_run
#                        | after_run | before_remove.
#   channel: "system"  — orchestrator lifecycle events (attempt_started,
#                        attempt_ended, reconciliation_terminating, etc.).
#
# Intended for later evaluation — typically by another agent running inside a VM
# — so the schema is verbose on purpose. Writes are best-effort: a failure to
# write a log line never crashes the orchestrator.
# ─────────────────────────────────────────────────────────────────────────────
logs:
  # root (path): directory holding per-issue JSONL files.
  # Default: ./.symphony/logs
  root: ./.symphony/logs

# ─────────────────────────────────────────────────────────────────────────────
# hooks — shell scripts the orchestrator runs at workspace lifecycle points.
#
# All hooks run on the HOST (not inside the VM), with cwd set to the per-issue
# workspace path. Each hook is a multi-line shell snippet. Available env vars:
#
#   PWD                  — the workspace directory (cwd at hook start).
#   SYMPHONY_ISSUE_ID    — the issue identifier.
#   SYMPHONY_ISSUE_STATE — the issue's current state.
#   SYMPHONY_ATTEMPT     — 1-based attempt counter.
#   SYMPHONY_WORKFLOW    — absolute path to the workflow file.
#
# Plus any env var the operator exports before launching `symphony`. The
# common pattern is to plumb tracker root / repo / base via env so the same
# workflow file works against multiple repos. See WORKFLOW.md for an example.
# The shipped `WORKFLOW.md` reads these operator-exported env vars from its
# hook scripts:
#
#   SYMPHONY_BASE_BRANCH         — branch issues diverge from and PRs target.
#                                  Default: 'main'.
#   SYMPHONY_REPO                — '<owner>/<repo>'. When set, after_run pushes
#                                  the per-issue branch and opens a PR via gh;
#                                  otherwise after_run only writes a patch
#                                  bundle. Default: unset (patch-bundle mode).
#   SYMPHONY_INTEGRATION_BRANCH  — shared agent-integration branch in the
#                                  source repo. Workspaces clone from its tip
#                                  (created lazily from SYMPHONY_BASE_BRANCH on
#                                  first use); after_run fast-forwards it when
#                                  an issue lands in Done so subsequent issues
#                                  see prior agents' commits instead of stale
#                                  base. Default: 'agent-integration'. Set to
#                                  the empty string ('') to opt out and clone
#                                  directly from SYMPHONY_BASE_BRANCH (legacy
#                                  "branch from base" behavior).
#
# Per-state overrides: any state can declare its own `hooks:` block under
# `states.<name>.hooks` that overrides individual fields here for issues in
# that state. Useful when terminal states should branch behavior — e.g. Done
# opens a PR while a sibling Merge state opens it and auto-merges. See the
# `states:` block above for details.
# ─────────────────────────────────────────────────────────────────────────────
hooks:
  # timeout_ms (int): max wall time for a single hook invocation.
  # Default: 60000
  timeout_ms: 120000

  # after_create (string | null): runs right after the workspace directory is
  # created, before the first dispatch. Use for git clone, dependency install,
  # etc. Default: null.
  after_create: |
    set -eu
    # ... your setup ...

  # before_run (string | null): runs before each turn. Default: null. Use for
  # cheap "make sure the workspace is sane" checks; expensive setup belongs in
  # after_create.
  before_run: |
    set -eu
    # ... pre-turn checks ...

  # after_run (string | null): runs after each turn, regardless of outcome.
  # Inspect cwd or the tracker to decide whether work is complete. Default: null.
  after_run: |
    set -eu
    # ... post-turn handoff (push, format-patch, …) ...

  # before_remove (string | null): runs before the workspace directory is
  # deleted. Use to extract artifacts you want to keep. Default: null.
  before_remove: |
    set -eu
    # ... rescue artifacts ...

# ─────────────────────────────────────────────────────────────────────────────
# agent — concurrency and turn budget.
# ─────────────────────────────────────────────────────────────────────────────
agent:
  # max_concurrent_agents (int): cap on simultaneously-running agents across
  # the whole workflow. Default: 10
  max_concurrent_agents: 2

  # max_turns (int): hard ceiling on autonomous turns per issue. Steering-reply
  # turns are free; only autonomous turns count. Default: 20
  max_turns: 6

  # max_retry_backoff_ms (int): exponential backoff cap for retried dispatches
  # after recoverable failures. Default: 300000
  max_retry_backoff_ms: 120000

  # max_concurrent_agents_by_state (map<string, int>): optional per-state
  # concurrency cap. Sums must not exceed max_concurrent_agents. Default: {}.
  max_concurrent_agents_by_state:
    Todo: 1
    In Progress: 1

# ─────────────────────────────────────────────────────────────────────────────
# acp — Agent Client Protocol adapter selection.
# ─────────────────────────────────────────────────────────────────────────────
acp:
  # adapter (string): one of symphony's known profiles. The profile encodes the
  # binary to launch and the host credential file to stage. Default: 'claude'.
  #   claude   — claude-agent-acp; stages ~/.claude/.credentials.json
  #   codex    — codex-acp;        stages ~/.codex/auth.json
  adapter: claude

  # model (string | null): optional model selector forwarded to the chosen adapter.
  # Each adapter profile knows how to surface it natively:
  #   claude  — exported as ANTHROPIC_MODEL on the adapter process. Accepts anything
  #             claude-agent-acp would (aliases like "opus", "sonnet", or full IDs
  #             like "claude-opus-4-7").
  #   codex   — passed as `-c model="<value>"` argv to codex-acp (parsed as TOML).
  # Leave unset / null to use the adapter's own default model. Default: null.
  # model: claude-opus-4-7

  # effort (string | null): optional reasoning-effort lever forwarded to the chosen
  # adapter. Profile-specific surface:
  #   claude  — written into a staged `settings.json` ({"effortLevel": "<value>"})
  #             copied to /root/.claude/settings.json in the VM before claude-agent-acp
  #             starts. Valid values are `low|medium|high|xhigh|max`, gated per-model
  #             by claude-agent-acp's `supportedEffortLevels` (Opus supports `xhigh` and
  #             `max`; Haiku does not). Symphony does not validate the value — the
  #             adapter rejects unsupported choices at startup, which keeps symphony
  #             from drifting from the adapter's own supported list.
  #   codex   — not wired (codex-acp has no first-class effort knob on the wrapper);
  #             setting `acp.effort` for a codex-backed state is a no-op.
  # Leave unset / null for the adapter's own default. Default: null.
  # effort: xhigh

  # NOTE: the launch shape is fixed (in-VM proxy dialing back over the bridge);
  # fork `scripts/vm-agent.js` if you need to customize what the proxy spawns.

  # shell (string): shell used to run the ACP launch command. Default: 'bash'.
  shell: bash

  # prompt_timeout_ms (int): max wall time for a single ACP `session/prompt`
  # call (one symphony turn). Default: 3600000 (1 hour).
  prompt_timeout_ms: 1800000

  # read_timeout_ms (int): max time between bytes on the ACP stdio. Bumped from
  # a small default because VM cold-boot + adapter startup can take ~10s on
  # first use. Default: 30000
  read_timeout_ms: 30000

  # stall_timeout_ms (int): max time the adapter can be idle (no events) before
  # the turn is killed and retried. Default: 300000
  stall_timeout_ms: 300000

  # bridge — host-side TCP listener the in-VM proxy dials back to for ACP traffic.
  #
  # This replaced the old smolvm-exec stdio path. Symphony writes ACP JSON-RPC frames
  # onto an authenticated TCP socket; the in-VM proxy (`/opt/symphony/vm-agent.mjs`)
  # spawns the adapter via `child_process.spawn` with kernel pipes and bridges the
  # socket to the adapter's stdio. This decouples symphony from any particular
  # sandbox's stdio quirks — any sandbox that can launch a process with env vars and
  # reach the host loopback works unchanged.
  bridge:
    # bind_host (string): host symphony binds the listener on. 0.0.0.0 allows any
    # in-VM interface to reach the host loopback (smolvm remaps guest loopback to
    # host loopback transparently). Default: 0.0.0.0
    bind_host: 0.0.0.0

    # bind_port (int): port symphony binds the listener on. 0 picks an ephemeral
    # port (used port surfaces via the in-VM SYMPHONY_ACP_URL env var). Default: 8788
    bind_port: 8788

    # reach_host (string): host the in-VM proxy dials back to. For smolvm this is
    # 127.0.0.1 because the guest loopback hits the host loopback. Other sandboxes
    # may need a different alias. Default: 127.0.0.1
    reach_host: 127.0.0.1

    # reach_url (string|null): full URL override for the in-VM proxy's dial
    # destination, e.g. through a reverse proxy or different scheme. When null,
    # symphony constructs `tcp://<reach_host>:<bind_port>`. Default: null
    # reach_url: null

    # connect_timeout_ms (int): how long to wait for the in-VM proxy to connect after
    # the sandbox is launched, before failing the attempt. Default: 30000
    connect_timeout_ms: 30000

# ─────────────────────────────────────────────────────────────────────────────
# smolvm — microVM execution environment.
# ─────────────────────────────────────────────────────────────────────────────
smolvm:
  # from (path | null): path to a packed .smolmachine.smolmachine artifact.
  # Built once with `scripts/build-vm.sh`. Mutually exclusive with `image`.
  # Default: null.
  from: ./.vm/symphony.smolmachine.smolmachine

  # image (string | null): container image to pull instead of a packed artifact.
  # Mutually exclusive with `from`. Default: null.
  image: null

  # cpus (int): vCPU count per VM. Default: 2.
  cpus: 2

  # mem_mib (int): RAM per VM in MiB. Default: 2048.
  mem_mib: 4096

  # net (bool): whether the VM has outbound networking. Default: true.
  # Setting false isolates the VM at the cost of breaking adapters that fetch
  # tokens, models, or dependencies at run time.
  net: true

  # volumes (list): additional host:guest bind mounts. smolvm has a small
  # per-VM mount cap (the workspace itself already consumes one slot), so keep
  # this list small. Each entry: { host: path, guest: path, readonly?: bool }.
  # Default: [].
  volumes:
    - host: ~/.cache/npm
      guest: /root/.npm
      readonly: false

  # forward_env (string[]): host env vars forwarded into the VM exec.
  # Default: [OPENAI_API_KEY, ANTHROPIC_API_KEY]
  forward_env:
    - OPENAI_API_KEY
    - ANTHROPIC_API_KEY

  # endpoint (string): smolvm server. unix:// or http:// URI.
  # Default: unix://$XDG_RUNTIME_DIR/smolvm.sock (or /run/user/1000/smolvm.sock)
  endpoint: unix:///run/user/1000/smolvm.sock

# ─────────────────────────────────────────────────────────────────────────────
# server — HTTP dashboard + MCP endpoint listener.
# ─────────────────────────────────────────────────────────────────────────────
server:
  # port (int | null): when null, no HTTP server is started. `--port <n>` on
  # the CLI overrides this. Default: null.
  port: 8787

  # host (string): bind address. Default: '127.0.0.1'. Bind to '0.0.0.0' only
  # inside a trusted network boundary; the dashboard has no built-in auth.
  host: 0.0.0.0

# ─────────────────────────────────────────────────────────────────────────────
# mcp — Model Context Protocol server exposed to in-VM agents.
#
# The orchestrator runs a JSON-RPC endpoint scoped to each active issue at
# /api/v1/issues/<id>/mcp, gated by a per-dispatch bearer token. Three tools
# live there:
#
#   • symphony.transition({ to_state, notes? })
#     — canonical (and only) exit verb. Moves the issue into another declared
#       state, optionally appending `notes` (markdown) to the issue body before
#       the move so the next agent (in `to_state`) reads them as part of
#       `issue.description`. Terminal targets clean the workspace; active and
#       holding targets preserve it so the same `agent/<id>` git branch
#       survives the handoff. Rejected transitions return MCP tool-result
#       errors (isError:true) the agent can read and retry.
#   • symphony.request_human_steering({ question, context? })
#   • symphony.propose_issue({ title, description?, labels?, priority? })
#     — drops a new issue into the first declared `role: holding` state
#       directory (literal Triage if none declared). The orchestrator does NOT
#       dispatch it; the operator approves or discards from the dashboard. The
#       calling issue is recorded as proposed_by in the new file's
#       front-matter.
# ─────────────────────────────────────────────────────────────────────────────
mcp:
  # enabled (bool): when false, the orchestrator refuses to dispatch (MCP is
  # required for completion signaling). Default: true.
  enabled: true

  # host (string): hostname or IP the agent uses to reach the orchestrator
  # from inside the smolvm. The port is resolved at runtime from the
  # actually-bound HTTP server. Default: '127.0.0.1' (smolvm proxies VM
  # loopback to host loopback; verified empirically).
  host: 127.0.0.1

  # host_url (string | null): full-URL override. When set, used verbatim and
  # `host` + bound port are ignored. Use only when the VM cannot reach the
  # orchestrator through the host gateway (e.g. bridge networking with a
  # fixed reverse-proxy URL). Default: null.
  host_url: null
---
<!--
Liquid-templated prompt body. Rendered once per dispatched issue. Context:

  issue.identifier   — the issue's external id (e.g. "DEMO-42").
  issue.title        — issue title (string).
  issue.state        — current state (string, matches a key in `states:`).
  issue.description  — body text (string or empty). `symphony.transition`
                       appends its `notes` block here before the file moves,
                       so the next state's agent reads the previous state's
                       handoff message verbatim.
  issue.priority     — number or null.
  issue.labels       — list of strings (lowercased).
  attempt            — int, 1-based attempt counter; absent on first attempt.

Available Liquid filters: standard Shopify Liquid plus `escape_once`.

Per-state prompt branching (V1 pattern): when `states:` declares more than
one active role (e.g. Todo + Review), wrap the state-specific instructions in
a `{% case issue.state %}` / `{% when "..." %}` / `{% else %}` block. The
runner renders the prompt fresh on every dispatch, so each state's agent sees
only its own instructions plus whatever common preamble / postamble lives
outside the case. See WORKFLOW.md in this repo for a worked example.

The body below is the literal prompt sent to the agent. Keep it specific to
this workflow; orchestrator behavior (transition, request_human_steering,
propose_issue) is the same no matter what you write here.
-->

You are picking up a single issue and shepherding it through the workflow.

Issue: **{{ issue.identifier }} — {{ issue.title }}**
State: {{ issue.state }}
{% if issue.priority -%}Priority: {{ issue.priority }}{%- endif %}
{% if issue.labels.size > 0 -%}Labels: {% for l in issue.labels %}{{ l }}{% unless forloop.last %}, {% endunless %}{% endfor %}{%- endif %}

{% if issue.description -%}
Description:

{{ issue.description }}
{%- endif %}

Goals:

1. Work in the current directory only; treat it as the issue workspace.
2. Make the smallest correct change that satisfies the issue.
3. Hand off when done. `symphony.transition({ to_state, notes? })` is the
   canonical (and only) exit verb: pass a declared state name and optional
   markdown notes that get appended to the issue body for the next agent.
   For single-agent workflows, transition straight into the first declared
   `role: terminal` state to end the run.
4. If you cannot proceed without human input, call
   `symphony.request_human_steering({ question, context? })`. Your turn ends
   immediately; the human's reply arrives as your next prompt.
5. If you notice work out of scope for this issue — unrelated bugs, follow-ups
   a human should size, refactors worth a separate dispatch — call
   `symphony.propose_issue({ title, description?, labels?, priority? })`. It
   lands in the first declared `role: holding` state directory (defaults to
   `Triage/`); the operator approves or discards. Do not graft unrelated
   edits onto this branch.

{% if attempt -%}
This is continuation/retry attempt {{ attempt }}. Inspect the workspace before
making new edits; your previous run may have left state behind.
{%- endif %}
