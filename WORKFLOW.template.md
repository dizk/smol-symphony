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
#   eval_mode (bool, optional): when true, the runner adds two extra read-only
#             bind mounts to every per-issue VM dispatched in this state so an
#             in-VM agent can inspect symphony's own state for evaluation /
#             debugging:
#               • `tracker.root` → `/symphony/issues` (every issue file across
#                 every state directory)
#               • `logs.root`    → `/symphony/logs`   (per-issue JSONL run-log
#                 transcripts captured by RunLog — ACP frames, stderr, hooks,
#                 system events)
#             Either mount is skipped silently if the corresponding root is
#             unset. Smolvm has a small per-VM mount cap (the workspace itself
#             already consumes one slot), so this is opt-in per state rather
#             than a workflow-wide default — flip it on for a dedicated eval
#             state, not for the routine implement/review flow. Default: false.
#   hooks     (map, optional): per-state overrides for the workflow-level `hooks:`
#             block. Each of `after_create`, `before_run`, and `before_remove`
#             is optional; an omitted key inherits the workflow-level hook, an
#             explicit `null` suppresses it for this state, and a string
#             replaces it. Resolution is by the issue's state at hook-fire time
#             — when the agent calls `symphony.transition`, `before_remove` is
#             resolved against the POST-transition state so a terminal-state's
#             hook can drive a state-specific artifact rescue. The shared
#             `timeout_ms` is not overridable per state. The Done-state push +
#             PR-create handoff lives in `actions:` (below); `hooks.after_run`
#             is no longer a recognized kind and a workflow that declares it
#             gets a startup warning + the value dropped on the floor.
#
#             DEPRECATED for new work: prefer `actions:` (below) over shell
#             hooks for state-specific glue. A state that declares both
#             `hooks:` and `actions:` runs `actions:` and logs a startup-time
#             deprecation warning naming the hook fields that were ignored.
#   actions   (list, optional): typed action DAG (issue 36, reconciler v2).
#             When set on a `terminal` state, this list runs on transition
#             INTO the state, replacing the per-state `after_run` shell.
#             Each entry is a closed-kind record:
#
#                 - kind: push_branch
#                   remote: origin
#                   ref: $branch
#                   if: $repo
#
#             Recognized kinds:
#               push_branch          { remote, ref }
#               create_pr_if_missing { base, head, title_from, body_from }
#               ensure_branch        { name, seed_from? }
#               checkout             { ref }
#               merge                { source, target, on_conflict }
#               delete_branch        { name, scope: local|remote|both, remote? }
#               run_in_vm            { name, cmd: [...], env?, timeout? }
#               propose_followup     { title, body?, labels?, priority? }
#
#             Templating: `$varname` references the fixed ActionContext
#             namespace ($identifier, $workspace, $branch, $base_branch,
#             $issue_title, $issue_body, $repo, $pr_title, $pr_body_file).
#             Unknown $vars throw at run-time (no silent "" expansion).
#
#             Conditional: optional `if:` field supports three predicates
#               - `if: $repo`                       (env-var-truthy)
#               - `if: { branch_exists: <ref> }`    (workspace branch)
#               - `if: { file_present: <path> }`    (workspace file)
#
#             Retry: optional `on_error.retry: { count, backoff_ms }`. Default
#             policy is 3 retries with exponential backoff starting at 1s,
#             then abort. `on_error.then: { route_to: <state> }` reroutes the
#             issue to a holding state instead of aborting.
#
#             merge's `on_conflict: { route_to: <state> }` is a fast-path
#             reroute. Use `on_conflict: abort` to fail the action and abort
#             the cleanup pass without a state move.
#
#             run_in_vm has content-hash caching: identical (workspace tree
#             ⊕ cmd ⊕ env) tuples skip execution and re-use the prior
#             successful result. The workspace-tree hash reflects live
#             contents (tracked + modified + untracked-not-gitignored), so
#             an uncommitted agent edit forces a cache miss. Cache lives
#             under `~/.cache/symphony/actions/run_in_vm/<name>/<sha256>/`.
#             `symphony rerun --check=<name>` drops the whole `<name>/`
#             namespace dir so the next dispatch re-runs that one check.
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
    # Terminal-state handoff via typed actions (issue 36). On transition into
    # Done, push the branch (if SYMPHONY_REPO is set → $repo non-empty) and
    # open a PR if one does not already exist. Templates resolve against the
    # fixed ActionContext namespace; the orchestrator stages $pr_title and
    # $pr_body_file from the issue file before firing.
    # actions:
    #   - { kind: push_branch, remote: origin, ref: $branch, if: $repo }
    #   - kind: create_pr_if_missing
    #     base: $base_branch
    #     head: $branch
    #     title_from: $pr_title
    #     body_from: $pr_body_file
    #     if: $repo
  Cancelled:
    role: terminal
  Triage:
    role: holding

# ─────────────────────────────────────────────────────────────────────────────
# pr_autopilot — arm GitHub auto-merge when a terminal-state PR is
# mergeable; route non-mergeable PRs back to the implementing state.
#
# Optional. When `enabled: true` the reconciler grows a `pr` resource that, on
# every tick, looks up each issue in `merge_state` (default `Done`) via
# `gh pr list --head agent/<id>`, fetches its detail with `gh pr view`, and:
#
#   • Arms GitHub's auto-merge when the PR is `mergeable: MERGEABLE`
#     (`gh pr merge --auto --<strategy> --delete-branch`). GitHub merges as
#     soon as required checks pass and review requirements are satisfied.
#   • When the PR is `mergeable: CONFLICTING`, appends a structured notes
#     block to the issue file and routes the issue from `merge_state` back
#     to `conflict_route_to` (default: the first declared `role: active`
#     state). The workspace + `agent/<id>` branch are preserved. Before the
#     next dispatch symphony runs `git fetch origin <base>` so
#     `origin/<base>` is current in the workspace, and the Todo prompt's
#     first step is `git rebase origin/<base>` — so resolving the conflict
#     is the agent's normal flow, not an out-of-band autopilot operation.
#   • For issues in `close_state` (default `Cancelled`) with an open PR,
#     closes the PR without merge and best-effort-deletes the remote branch.
#
# Requires `gh` authenticated on the host (`gh auth status` clean). The token
# never enters the VM. Auto-merge ALSO requires at least one branch protection
# rule on the base branch, or `gh pr merge --auto` will error — set one in
# the repo's GitHub settings before flipping `enabled: true`.
#
# When `enabled: false` (or the block is absent) the autopilot is fully
# inert: the resource is never constructed and the orchestrator's existing
# Done-state behavior (workspace cleanup + the Done-state `actions:` block
# that pushes the branch and opens the PR + operator-merge) is unchanged.
#
# Workspace lifecycle gotcha: when `enabled: true`, transitions into
# `merge_state` no longer fire the standard terminal workspace cleanup. The
# pr resource owns the workspace from that point on and removes it once the
# PR has merged (or been closed). Transitions into `close_state` (and any
# other terminal state) keep the standard cleanup-on-transition behavior.
# ─────────────────────────────────────────────────────────────────────────────
pr_autopilot:
  # enabled (bool): master switch. Default false.
  enabled: false

  # merge_state (string): terminal state whose issues should have their PRs
  # auto-merged. Default 'Done'.
  merge_state: Done

  # close_state (string, optional): terminal state whose issues should have
  # their PRs closed without merge. Default 'Cancelled'. Set to null (or
  # omit by setting an empty string) to disable the close path.
  close_state: Cancelled

  # conflict_route_to (string, optional): active state to route a non-
  # mergeable issue back into. Defaults to the first declared `role: active`
  # state — for symphony's two-stage Todo/Review workflow that's Todo.
  conflict_route_to: Todo

  # auto_merge_strategy (enum: squash|merge|rebase): forwarded to
  # `gh pr merge --auto --<strategy>`. Default 'squash'.
  auto_merge_strategy: squash

  # poll_interval_ms (int): per-PR GitHub view cache TTL, milliseconds. The
  # reconciler may tick more often than this; a single PR view is reused
  # within the window. Default 30000.
  poll_interval_ms: 30000

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
# logs — per-issue JSONL run logs (everything to/from the VM, plus hooks) AND
# the orchestrator-side text log mirrored to disk for offline debugging.
#
# Per-issue: one file per issue at `<root>/<sanitized-identifier>.jsonl`,
# appended across attempts AND across symphony process restarts. Each line is
# a self-describing JSON object with `ts`, `issue_id`, `attempt`, and a
# `channel` discriminator:
#
#   channel: "acp"     — JSON-RPC frame between host and the in-VM adapter.
#                        `direction` ("host_to_vm" | "vm_to_host") and `frame`
#                        (parsed JSON) — or `kind: "unparseable"` + `raw`.
#   channel: "stderr"  — raw byte chunk from the adapter / VM stderr.
#   channel: "hook"    — stdout/stderr chunk from a host-side hook, plus a final
#                        `kind: "result"` line (exit_code, signal, timed_out).
#                        `hook` field names which hook: after_create | before_run
#                        | before_remove.
#   channel: "system"  — orchestrator lifecycle events (attempt_started,
#                        attempt_ended, reconciliation_terminating, etc.).
#
# Orchestrator-side: a single `<root>/symphony.log` (created on demand) gets
# every structured log line that symphony writes to stderr — workflow loads,
# dispatch decisions, hook results, reconciler ticks, shutdown — in the same
# `key=value` text format. Lets an agent reviewing a finished run (typically
# with `.symphony/logs/` mounted into a VM) replay orchestrator-side events
# alongside the per-issue JSONL traces in the same directory. Set the
# `SYMPHONY_LOG_FILE` env var to override the path; set it to the empty
# string to disable the file sink entirely (stderr remains).
#
# Intended for later evaluation — typically by another agent running inside a VM
# — so the schema is verbose on purpose. Writes are best-effort: a failure to
# write a log line never crashes the orchestrator.
# ─────────────────────────────────────────────────────────────────────────────
logs:
  # root (path): directory holding per-issue JSONL files and symphony.log.
  # Default: ./.symphony/logs
  root: ./.symphony/logs

# ─────────────────────────────────────────────────────────────────────────────
# hooks — shell scripts the orchestrator runs at workspace lifecycle points.
#
# All hooks run on the HOST (not inside the VM), with cwd set to the per-issue
# workspace path. Each hook is a multi-line shell snippet. Available context:
#
#   PWD                  — the workspace directory (cwd at hook start). The
#                          per-issue workspace path is `<workspace.root>/<id>`,
#                          so `basename "$PWD"` gives the issue identifier.
#
# Plus any env var the operator exports before launching `symphony` — the
# orchestrator forwards the parent process env unchanged. The common pattern
# is to plumb tracker root / repo / base via env so the same workflow file
# works against multiple checkouts.
#
# `after_run` is not a hook kind any more: the Done-state push + PR-create
# handoff is a typed `actions:` block (see `states.Done.actions` above). The
# action executor exposes the same context — `$branch`, `$base_branch`,
# `$pr_title`, `$pr_body_file` — that the old hook read from `SYMPHONY_*` env
# vars. A workflow that still declares `hooks.after_run` (workflow-level or
# per-state) is warned at startup and the value is dropped on the floor.
#
# Per-state overrides: any state can declare its own `hooks:` block under
# `states.<name>.hooks` that overrides individual fields here for issues in
# that state. See the `states:` block above for details.
# ─────────────────────────────────────────────────────────────────────────────
hooks:
  # timeout_ms (int): max wall time for a single hook invocation.
  # Default: 60000
  timeout_ms: 120000

  # after_create (string | null): additional repo-local glue run AFTER the
  # built-in canonical workspace setup, before the first dispatch. Default: null.
  #
  # The orchestrator now performs the canonical clone + branch + remote setup
  # in TypeScript (`setupWorkspaceDir`) on first creation, BEFORE this hook
  # runs. The workspace cwd already has:
  #
  #   • a hardlinked `git clone --local --no-tags` of the source repo (selected
  #     via `SYMPHONY_SOURCE_REPO`, default: the directory containing
  #     WORKFLOW.md) on the base branch (`SYMPHONY_BASE_BRANCH`, default `main`)
  #   • all network remotes stripped (in-VM `git push`/`git fetch` fail closed)
  #   • when `SYMPHONY_REPO` is set: `origin` restored to the canonical HTTPS
  #     URL `https://github.com/<owner>/<repo>.git` so a host-side terminal
  #     hook can push; `gh auth setup-git` runs best-effort on the host so the
  #     push has credentials (the token never enters the VM). Without
  #     `SYMPHONY_REPO` the workspace stays local-only with no remotes
  #   • `user.name = symphony-agent` / `user.email = agent@symphony.local`
  #     pinned in `--local` config
  #   • `agent/<id>` checked out off the base SHA
  #
  # Use `after_create` only for additional setup on top of that — dependency
  # bootstrap, code generation, etc. The canonical clone/branch/remote work
  # is owned by the orchestrator and SHOULD NOT be re-implemented here. Leave
  # this block unset if no additional glue is needed.
  after_create: |
    set -eu
    # ... your additional repo-local setup, if any ...

  # before_run (string | null): runs before each turn. Default: null. Use for
  # cheap "make sure the workspace is sane" checks; one-time expensive setup
  # belongs in after_create (which fires only on first workspace creation).
  before_run: |
    set -eu
    # ... pre-turn checks ...

  # NOTE: `after_run` is no longer a hook kind. The post-attempt handoff (push
  # branch, open PR) lives in `states.Done.actions:` as typed records — see
  # the `states:` block above for the canonical pair (push_branch +
  # create_pr_if_missing).

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

  # memory_admission_enabled (bool): when true, before each dispatch the
  # orchestrator reads `/proc/meminfo` (MemAvailable) and clamps the effective
  # concurrency cap to what currently fits at `smolvm.mem_mib` per VM after
  # subtracting `host_memory_reserve_mib`. This is a defense-in-depth backstop
  # for hosts where the static `max_concurrent_agents` is set generously: when
  # MemAvailable drops, new dispatches are gated so a misconfigured cap can't
  # walk the host into OOM (issue 27). On hosts without `/proc/meminfo`
  # (macOS, BSD) the probe degrades gracefully and the static cap is used
  # unchanged. Default: true.
  memory_admission_enabled: true

  # host_memory_reserve_mib (int): headroom (MiB) the memory admission cap
  # keeps for the orchestrator process itself, hooks, the smolvm daemon, and
  # the kernel's own working set. Only consulted when
  # `memory_admission_enabled` is true. Raise on hosts with heavy non-symphony
  # workloads; lower on dedicated worker hosts. Default: 2048.
  host_memory_reserve_mib: 2048

# ─────────────────────────────────────────────────────────────────────────────
# acp — Agent Client Protocol adapter selection.
# ─────────────────────────────────────────────────────────────────────────────
acp:
  # adapter (string): one of symphony's known profiles. The profile encodes the
  # binary to launch and the host credential file to stage. Default: 'claude'.
  #   claude   — claude-agent-acp; stages ~/.claude/.credentials.json
  #   codex    — codex-acp;        stages ~/.codex/auth.json
  adapter: claude

  # credentials_mode (enum: file|proxy): how the host hands credentials to the
  # in-VM adapter (issue 113). Default: 'file'.
  #
  #   file   — historical path. The entire host credential file is read,
  #            sensitive fields stripped (claude: refreshToken), and written
  #            into the workspace runtime dir; deriveAcpCommand copies it
  #            into the adapter's expected guest path before exec. The VM
  #            sees the short-lived accessToken on its filesystem.
  #   proxy  — symphony binds a host credential proxy on `credentials.proxy_*`
  #            (defaults: 127.0.0.1 with an ephemeral port). On each dispatch
  #            the proxy mints a per-VM sentinel; the VM is launched with
  #            ANTHROPIC_BASE_URL pointed at the proxy and
  #            ANTHROPIC_AUTH_TOKEN=<sentinel>. The proxy validates each
  #            inbound sentinel, swaps in the live access token read from
  #            ~/.claude/.credentials.json (refreshing host-side via
  #            `claude -p "ok"` under flock when the cache is stale), and
  #            forwards to api.anthropic.com. The VM gets a minimal
  #            ~/.claude.json staged for identity only — NO refreshToken, NO
  #            accessToken on the VM filesystem.
  #
  # `proxy` mode is the long-term direction; `file` stays the default during
  # the transition window so workflows that haven't migrated still work.
  # credentials_mode: file

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

  # NOTE: the launch shape is fixed (an in-VM proxy dials back over the bridge
  # and spawns the chosen adapter). Customizing what the proxy spawns requires
  # forking that proxy and rebuilding the VM image with the fork in place.

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
# credentials — host credential lifecycle (issue 113). Only consulted when
# `acp.credentials_mode === 'proxy'`. The proxy listens on host loopback and
# substitutes the real OAuth access token for a per-VM sentinel on every
# request. The ticker keeps the host's cached access token warm by
# periodically running `claude -p "ok"` — Claude Code's own OAuth path
# detects the stale token, refreshes against Anthropic, and atomically writes
# the rotated tuple back to `~/.claude/.credentials.json`. Symphony never
# implements OAuth; Anthropic's own client does.
# ─────────────────────────────────────────────────────────────────────────────
credentials:
  # proxy_bind_host (string): host the credential proxy binds on. Defaults to
  # loopback so the proxy is unreachable from outside the host. The smolvm
  # guest-loopback shim rewrites the in-VM 127.0.0.1 to the host's 127.0.0.1
  # transparently, same as the ACP bridge case. Default: 127.0.0.1
  proxy_bind_host: 127.0.0.1

  # proxy_bind_port (int): port the credential proxy binds on. 0 picks an
  # ephemeral port at startup. Default: 0
  proxy_bind_port: 0

  # ticker_interval_ms (int): how often the host ticker spawns `claude -p "ok"`
  # to refresh the OAuth cache. The proxy also refreshes on demand when a VM
  # request lands with an expired cached token, so the ticker is belt-to-the-
  # braces for idle periods. Set to 0 to disable the in-symphony ticker
  # entirely (operator runs their own systemd timer instead). Default: 21600000
  # (6 hours).
  ticker_interval_ms: 21600000

# ─────────────────────────────────────────────────────────────────────────────
# smolvm — microVM execution environment.
# ─────────────────────────────────────────────────────────────────────────────
smolvm:
  # smolfile (path | null): path to a TOML Smolfile (https://github.com/smol-machines/smolvm)
  # describing the per-issue VM declaratively. When set, the runner passes
  # `--smolfile <path>` to `smolvm machine create`; the Smolfile's `image`, resources,
  # and `[dev].init` / `[dev].volumes` carry the per-VM setup. The repo ships a
  # canonical `Smolfile` at the root that installs node tooling + every ACP-capable
  # coding agent and bind-mounts scripts/ → /opt/symphony so the in-VM proxy at
  # /opt/symphony/vm-agent.mjs is the same file the host pins. Mutually exclusive
  # with `image` and `from`. Default: null.
  smolfile: ./Smolfile

  # from (path | null): path to a packed .smolmachine.smolmachine artifact
  # built with `smolvm pack create`. Mutually exclusive with `image` and
  # `smolfile`. The artifact must contain a Node.js runtime, the ACP adapters
  # you intend to use (claude-agent-acp, codex-acp, etc.), and the symphony
  # in-VM proxy at /opt/symphony/vm-agent.mjs. Default: null.
  from: null

  # image (string | null): container image to pull instead of a packed artifact
  # or Smolfile. Mutually exclusive with `from` and `smolfile`. Default: null.
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
