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
#             codex, opencode). All route through the host credential proxy and
#             are startup-probed so a missing credential fails fast. claude has a
#             single host credential file (~/.claude/.credentials.json) that is
#             probed for readability; codex passes when either ~/.codex/auth.json
#             holds a token (ChatGPT-OAuth tokens.access_token or a top-level
#             OPENAI_API_KEY) or the host OPENAI_API_KEY env var is set; opencode
#             passes when either ~/.local/share/opencode/auth.json holds a
#             github-copilot token (run `opencode auth login` -> GitHub Copilot
#             on the host) or a COPILOT_GITHUB_TOKEN/GH_TOKEN/GITHUB_TOKEN env
#             var is set.
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
#                 system events — plus the compact `<key>.summary.json` outcome
#                 records the reflector reads; see the `logs:` block below)
#             Either mount is skipped silently if the corresponding root is
#             unset. Each VFS mount has a cost, so this is opt-in per state rather
#             than a workflow-wide default — flip it on for a dedicated eval
#             state, not for the routine implement/review flow. Default: false.
#             The canonical consumer is the "sleep cycle" reflection pattern —
#             see the SLEEP CYCLE section below the states block.
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
# SLEEP CYCLE — a reflection state that mines finished work for harness
# improvements (issue 122). Optional, opt-in pattern; layered on top of the
# states block above. The shipped smol-symphony WORKFLOW.md wires it for the
# dogfooding (symphony-on-symphony) setup.
#
# The idea: every dispatch starts from the same static prompt + config, no
# matter what the last 100 issues taught us about where agents stall, get
# rejected, burn their turn budget, or fight the harness. A periodic
# "reflection" turn closes that feedback loop — it reads completed-task history
# (the read-only mounts `eval_mode` exposes), distils *recurring* friction, and
# files improvement proposals against the HARNESS (this WORKFLOW.md's prompt
# branches and per-state model/max_turns/allowed_transitions/effort, hooks, the
# the gondolin image config, acceptance criteria, timeouts) — never the product code under
# review. Proposals land in Triage via `propose_issue`, so a human stays the
# gate. This is the "self-improving agent" pattern aimed at the harness rather
# than the product.
#
# Two states implement it:
#
#   Reflect (role: active, eval_mode: true):
#     - eval_mode binds /symphony/issues (all state dirs, incl. the Done/*.md
#       handoff transcripts) + /symphony/logs (per-issue JSONL run logs)
#       read-only into the VM. No extra mount plumbing — it reuses the existing
#       eval_mode mounts.
#     - Give it a capable adapter/model (large context helps: a reflection turn
#       reads many transcripts + logs) and a higher max_turns than your
#       implement/review states.
#     - allowed_transitions: [Dormant] — the reflector may ONLY go dormant. It
#       cannot route itself into the implement/review/done flow. Filing
#       improvements goes through propose_issue (→ Triage), which is independent
#       of allowed_transitions.
#     - The prompt body's `when "Reflect"` branch encodes the
#       read → distil → propose loop and the GUARDRAILS below.
#
#   Dormant (role: holding):
#     - Resting place for the single recurring "Sleep cycle" issue between runs.
#       Holding → never dispatched. Declare it AFTER your Triage state so Triage
#       stays the first holding state (the `propose_issue` landing + triage
#       approve/discard target both resolve the FIRST declared holding state).
#     - Dashboard caveat: the dashboard currently renders triage approve/discard
#       buttons on every holding row, and the tracker resolves a move by issue
#       id regardless of source directory — so clicking those buttons on a
#       Dormant issue would mis-route it. Re-arm via cron/CLI/filesystem, not the
#       dashboard buttons.
#
# GUARDRAILS (this is a self-modifying loop — keep the human in it):
#   - Output is proposals into Triage (holding, never auto-dispatched). The
#     operator approves/discards. Do not bypass this gate.
#   - Constrain the proposal surface to harness config. Forbid any proposal that
#     weakens the Review state, the test/lint gates, or the Triage gate itself.
#   - Each proposal must cite the issue ids that motivated it, so the operator
#     checks the lesson against the evidence rather than the reflector's summary.
#
# CADENCE (v1 — operator/scheduled-triggered, no orchestrator trigger logic):
#   A single recurring issue (e.g. titled "Sleep cycle") oscillates Reflect ↔
#   Dormant. The operator drops it into Reflect (dashboard, or `mv` on disk), or
#   an external cron / a `symphony reflect` verb arms it. After it files
#   proposals it transitions to Dormant and waits to be re-armed. Auto-arm on
#   idle (no active issues) or after N transitions into Done is a deliberate
#   follow-up, out of scope for v1.
#
# Example states to add (names are yours to choose):
#
#   states:
#     # ... your active/terminal states ...
#     Reflect:
#       role: active
#       adapter: claude
#       model: claude-opus-4-8[1m]   # large context for reading transcripts
#       max_turns: 20                # higher than implement/review
#       eval_mode: true
#       allowed_transitions: [Dormant]
#     Triage:
#       role: holding                # declared before Dormant
#     Dormant:
#       role: holding
# ─────────────────────────────────────────────────────────────────────────────

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
# sleep_cycle — auto-arm the recurring reflection issue (issue 125, the
# deferred follow-up to issue 122's sleep-cycle Reflect/Dormant states).
#
# Optional. When `enabled: true` the orchestrator moves the reflection issue
# (`issue_id`) from its `dormant_state` (a holding state it rests in between
# runs) into the active `reflect_state` automatically — the "sleep when not
# busy" framing — on either trigger, evaluated on every poll:
#
#   • arm_on_idle: the orchestrator is idle (nothing running, claimed, or
#     pending retry, and no active-state candidate this poll) AND ≥1 issue has
#     reached a terminal state since the last reflection run. The "≥1 since
#     last run" gate is required: an idle orchestrator with nothing finished
#     has nothing new to mine, and arming anyway would spin
#     (arm → reflect → dormant → idle → arm …) forever.
#   • arm_after_done: arm once this many issues have reached a terminal state
#     (the Done/Cancelled work the reflector reads) since the last run — a
#     backstop for busy stretches that never go idle. 0 disables this trigger.
#
# The terminal-transition counter resets to 0 the moment the issue is armed
# ("since the last reflection run" is measured from the previous arm) and is
# held in orchestrator memory only — a process restart resets it to 0.
#
# GUARDRAILS: auto-arming ONLY moves the issue into `reflect_state`. The
# proposals reflection files still land in the holding triage state and still
# require human approve/discard — this does not bypass the human gate. When
# `enabled: false` (or the block is absent) the only cadence is the
# operator / cron / `mv`-on-disk path, exactly as before.
#
# State-name fields are case-insensitive lookups against the declared `states:`
# map, validated only when `enabled: true`: `dormant_state` must be `holding`,
# `reflect_state` must be `active`, and `issue_id` must be set.
# ─────────────────────────────────────────────────────────────────────────────
sleep_cycle:
  # enabled (bool): master switch. Default false.
  enabled: false

  # issue_id (string): id/identifier of the recurring reflection issue resting
  # in dormant_state. Required when enabled. The block is inert until an issue
  # with this id exists in dormant_state.
  issue_id: sleep-cycle

  # dormant_state (string): the holding state the reflection issue rests in
  # between runs. Default 'Dormant'.
  dormant_state: Dormant

  # reflect_state (string): the active state the issue is armed into. Default
  # 'Reflect'.
  reflect_state: Reflect

  # arm_on_idle (bool): arm when the orchestrator goes idle (with ≥1 terminal
  # transition since the last run). Default true. Set false to rely only on
  # arm_after_done.
  arm_on_idle: true

  # arm_after_done (int): arm after this many terminal transitions since the
  # last run. Default 0 (disabled). Must be a non-negative integer.
  arm_after_done: 0

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
#   channel: "system"  — orchestrator lifecycle events (attempt_started — which
#                        also carries the per-state `max_turns` budget,
#                        attempt_ended, transition, reconciliation_terminating,
#                        etc.). The `transition` event records each state move
#                        (from_state, to_state, notes, actor, terminal,
#                        rerouted) so the trajectory is reconstructable.
#
# Per-issue run summary (for the sleep-cycle reflector): alongside each
# `<root>/<key>.jsonl`, the orchestrator writes a compact, versioned
# `<root>/<key>.summary.json` at the issue's terminal unwind. It is a pure
# REDUCTION over the lifecycle (`system`) events already in the JSONL — no extra
# hot-path logging — so a reflection turn can read dozens of summaries without
# re-parsing multi-MB frame logs. Fields (schema_version 1):
#   • state_path        — distinct states visited, terminal appended
#                         (e.g. ["Todo","Review","Todo","Review","Done"]);
#   • attempts          — total dispatched attempts;
#   • per_state[]       — {state, attempts, turns_used, max_turns,
#                         budget_exhausted, wall_clock_ms};
#   • review_rejections + rejection_notes[] — count and each reviewer kick-back's
#                         notes (a non-reroute transition back to the INITIAL
#                         implementing state, i.e. a Review→Todo rework);
#   • turn_budget_exhausted, timeouts[] (stall / prompt_timeout / transport);
#   • conflict_routes[] — PR-autopilot / action reroutes (rebase churn);
#   • terminal_state + terminal_outcome (completed | cancelled | incomplete);
#   • pr_number / pr_url (best-effort, scraped from the Done-state actions
#                         stdout; null when unavailable);
#   • first/last_event_at, wall_clock_ms_total, generated_at.
# Graceful absence / backfill: the summary is best-effort. Issues that closed
# BEFORE this feature shipped have no `*.summary.json`; a write failure or a
# mid-issue process restart (the in-memory accumulator only sees post-restart
# attempts) can leave it missing or partial. The reflector MUST treat an absent
# or partial summary as "no signal for this issue" and fall back to the raw
# JSONL (or skip the issue) — never as an error. No backfill job is run; old
# issues simply carry no summary.
#
# Orchestrator-side: a single `<root>/symphony.log` (created on demand) gets
# every structured log line symphony emits — workflow loads, dispatch
# decisions, hook results, reconciler ticks, shutdown — in `key=value` text
# format. Lets an agent reviewing a finished run (typically with
# `.symphony/logs/` mounted into a VM) replay orchestrator-side events
# alongside the per-issue JSONL traces in the same directory. Set the
# `SYMPHONY_LOG_FILE` env var to override the path; set it to the empty
# string to disable the file sink entirely (stderr remains).
#
# Console routing: while the file sink is active (the default), the structured
# stream goes to the file ONLY — the console shows just the startup banner
# (workflow, tracker root, dashboard URL, log-file path). `tail -f` the log
# file to follow the detail. Pass `--verbose` (alias `--foreground`) to mirror
# the structured stream back onto the console for interactive debugging. With
# no file sink configured, the structured stream stays on stderr.
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
  # concurrency cap to what currently fits at `gondolin.mem_mib` per VM after
  # subtracting `host_memory_reserve_mib`. This is a defense-in-depth backstop
  # for hosts where the static `max_concurrent_agents` is set generously: when
  # MemAvailable drops, new dispatches are gated so a misconfigured cap can't
  # walk the host into OOM (issue 27). On hosts without `/proc/meminfo`
  # (macOS, BSD) the probe degrades gracefully and the static cap is used
  # unchanged. Default: true.
  memory_admission_enabled: true

  # host_memory_reserve_mib (int): headroom (MiB) the memory admission cap
  # keeps for the orchestrator process itself, hooks, the per-VM Gondolin runners, and
  # the kernel's own working set. Only consulted when
  # `memory_admission_enabled` is true. Raise on hosts with heavy non-symphony
  # workloads; lower on dedicated worker hosts. Default: 2048.
  host_memory_reserve_mib: 2048

  # circuit_breaker_threshold (int): after this many CONSECUTIVE dispatch
  # attempts fail with the *same* (normalized) reason, the orchestrator stops
  # retrying the issue and routes it to a holding state (the first declared
  # `role: holding` state) for a human to inspect, instead of looping forever
  # on a deterministically-failing dispatch (issue 128 — a persistent
  # `401 invalid_api_key` once looped ~324 attempts over ~13h). The streak
  # resets the moment an attempt fails with a different reason or exits
  # cleanly, so transient/varied failures still retry under the normal backoff
  # (`max_retry_backoff_ms`). The tripped issue's body gets a diagnostic note
  # explaining the trip so the dashboard shows "stuck on identical failure"
  # rather than a silent loop. Set to 0 to disable; must otherwise be >= 2
  # (1 would trip on the first failure, never retrying). Default: 5.
  circuit_breaker_threshold: 5

# ─────────────────────────────────────────────────────────────────────────────
# acp — Agent Client Protocol adapter selection.
# ─────────────────────────────────────────────────────────────────────────────
acp:
  # adapter (string): one of symphony's known profiles. Default: 'claude'.
  #   claude   — claude-agent-acp. Routes through the host credential proxy;
  #              no credential file enters the VM.
  #   codex    — codex-acp. Also routes through the host credential proxy
  #              (issue 116); no credential file — and no real OPENAI_API_KEY —
  #              enters the VM.
  #   opencode — opencode acp, backed by GitHub Copilot (issue 130). Routes
  #              through the host credential proxy; the proxy exchanges the
  #              host's `opencode auth login` GitHub OAuth token for a
  #              short-lived Copilot token host-side — the GitHub token never
  #              enters the VM. One Copilot credential unlocks many models
  #              (GPT-4o/4.1, Claude Sonnet, Gemini, o-series, …).
  adapter: claude

  # Credentials never enter the VM (issue 113; codex generalized in 116). On
  # each dispatch the host credential proxy (`credentials.proxy_*`, default
  # 127.0.0.1 + ephemeral port) mints a per-VM sentinel; the VM is launched
  # with the adapter's base-URL env var pointed at the proxy and its
  # token env var set to the sentinel. The proxy validates each inbound
  # sentinel, swaps in the live upstream credential host-side, and forwards
  # to the adapter's upstream.
  #
  # For claude: VM gets ANTHROPIC_BASE_URL=<proxy> + ANTHROPIC_AUTH_TOKEN=<sentinel>;
  # the proxy reads the live access token from ~/.claude/.credentials.json
  # (refreshing host-side via `claude -p "ok"` under flock when the cache is
  # stale) and forwards to api.anthropic.com. A minimal ~/.claude.json is
  # staged for identity only — NO refreshToken, NO accessToken on the VM.
  #
  # For codex: VM gets OPENAI_BASE_URL=<proxy> + OPENAI_API_KEY=<sentinel>;
  # the proxy reads the live credential (`tokens.access_token` or
  # `OPENAI_API_KEY` from ~/.codex/auth.json, with an OPENAI_API_KEY env
  # fallback — NEVER the refresh token) and forwards to api.openai.com. The
  # real OPENAI_API_KEY is intentionally stripped from the forwarded VM boot
  # env so it cannot land in the VM's PID-1 environment; codex-acp runs in
  # API-key mode against the proxy and never performs the OAuth handshake
  # in-VM (that, and refresh, stay host-side).
  #
  # For opencode: VM gets OPENCODE_PROXY_BASE_URL=<proxy> +
  # OPENCODE_PROXY_TOKEN=<sentinel>, and a staged opencode.json (at
  # /root/.config/opencode/opencode.json) declares a custom
  # @ai-sdk/openai-compatible provider whose baseURL/apiKey read those env vars.
  # The proxy reads the durable GitHub OAuth token from
  # ~/.local/share/opencode/auth.json (COPILOT_GITHUB_TOKEN/GH_TOKEN/GITHUB_TOKEN
  # env fallback), exchanges it host-side at
  # api.github.com/copilot_internal/v2/token for a short-lived Copilot token
  # (cached + TTL-refreshed before expiry), injects the Copilot editor headers,
  # and forwards to api.githubcopilot.com. The durable GitHub token never enters
  # the VM — so do NOT also list it in `gondolin.forward_env`. See
  # docs/research/opencode-copilot-accept-matrix.md.

  # model (string | null): optional model selector forwarded to the chosen adapter.
  # Each adapter profile knows how to surface it natively:
  #   claude  — exported as ANTHROPIC_MODEL on the adapter process. Accepts anything
  #             claude-agent-acp would (aliases like "opus", "sonnet", or full IDs
  #             like "claude-opus-4-7").
  #   codex   — passed as `-c model="<value>"` argv to codex-acp (parsed as TOML).
  #   opencode— baked into the staged opencode.json as model="symphony-copilot/<value>".
  #             Use a Copilot chat-completions model id (e.g. gpt-4o, gpt-4.1,
  #             claude-sonnet-4.5, gemini-2.5-pro); codex-class models served only
  #             on Copilot's /responses path are NOT reachable. Default: gpt-4o.
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
  # This replaced the earlier in-VM-exec stdio path. Symphony writes ACP JSON-RPC frames
  # onto an authenticated TCP socket; the in-VM proxy (`/opt/symphony/vm-agent.mjs`)
  # spawns the adapter via `child_process.spawn` with kernel pipes and bridges the
  # socket to the adapter's stdio. This decouples symphony from any particular
  # sandbox's stdio quirks — any sandbox that can launch a process with env vars and
  # reach the host loopback works unchanged.
  bridge:
    # bind_host (string): host symphony binds the listener on. 0.0.0.0 allows any
    # in-VM interface to reach the host loopback (Gondolin maps a synthetic guest host to
    # host loopback transparently). Default: 0.0.0.0
    bind_host: 0.0.0.0

    # bind_port (int): port symphony binds the listener on. 0 picks an ephemeral
    # port (used port surfaces via the in-VM SYMPHONY_ACP_URL env var). Default: 8788
    bind_port: 8788

    # reach_host (string): host the in-VM agent dials back to. Under Gondolin this is
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
# credentials — host credential lifecycle (issue 113). The proxy listens on
# host loopback and substitutes the real OAuth access token for a per-VM
# sentinel on every request. The ticker keeps the host's cached access token
# warm by periodically running `claude -p "ok"` — Claude Code's own OAuth
# path detects the stale token, refreshes against Anthropic, and atomically
# writes the rotated tuple back to `~/.claude/.credentials.json`. Symphony
# never implements OAuth; Anthropic's own client does.
# ─────────────────────────────────────────────────────────────────────────────
credentials:
  # proxy_bind_host (string): host the credential proxy binds on. Defaults to
  # loopback so the proxy is unreachable from outside the host. Gondolin maps the
  # in-VM 127.0.0.1 to the host's 127.0.0.1 transparently, same as the ACP bridge
  # case. Default: 127.0.0.1
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
# gondolin — microVM execution environment (Gondolin substrate).
# ─────────────────────────────────────────────────────────────────────────────
gondolin:
  # image (string | null): the agent rootfs the VM boots, expressed as a Gondolin
  # image selector. Build it ONCE with `npm run build:image` (see images/agents/) —
  # the build prints a content-addressed build id (a digest); pin that id here for
  # an immutable, reproducible reference. A `name:tag` ref (e.g.
  # `symphony-agents:latest`) or a path to an exported asset directory also work.
  # The image bakes a Node.js runtime, every ACP-capable coding agent
  # (claude-agent-acp, codex-acp, opencode), and the in-VM launcher at
  # /opt/symphony/vm-agent.mjs — so dispatch needs no runtime mounts. REQUIRED:
  # the runner fails fast at boot when this is unset. Default: null.
  image: symphony-agents:latest

  # cpus (int): vCPU count per VM. Default: 2.
  cpus: 2

  # mem_mib (int): RAM per VM in MiB. Default: 2048.
  mem_mib: 4096

  # volumes (list): additional host:guest VFS mounts beyond the auto-mounted
  # workspace. Gondolin's VFS is programmable (no hard per-VM mount cap), but keep
  # this lean — if ANY state sets `eval_mode: true` it adds two read-only mounts
  # (/symphony/issues + /symphony/logs) on top of the workspace. Prefer baking
  # static tooling into the image over a runtime mount. Each entry:
  # { host: path, guest: path, readonly?: bool }. Default: [].
  volumes:
    - host: ~/.cache/npm
      guest: /root/.npm
      readonly: false

  # forward_env (string[]): host env vars forwarded into the VM exec.
  # Default: [OPENAI_API_KEY, ANTHROPIC_API_KEY]
  # NOTE: the runner strips EVERY credential-bearing var from the forwarded boot
  # env before launch — the guest holds only a token-shaped placeholder that
  # Gondolin substitutes with the real token at egress — so listing a credential
  # var here does NOT plant the real key in the VM's PID-1 env.
  forward_env:
    - OPENAI_API_KEY
    - ANTHROPIC_API_KEY

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
  # from inside the VM. The port is resolved at runtime from the
  # actually-bound HTTP server. Default: '127.0.0.1' (Gondolin maps VM
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
