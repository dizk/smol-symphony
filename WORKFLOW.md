---
# WORKFLOW.md — symphony dispatched against smol-symphony itself.
#
# Run with:
#
#   npx symphony WORKFLOW.md
#
# Defaults assume a fully local setup: the per-issue workspace clones from this
# repo's `.git` directory, the agent has no network credentials, and when the
# issue lands in a terminal state the per-issue branch is left in the workspace
# until cleanup. No patch bundle is written.
#
# To opt into the remote PR flow, export before launching:
#
#   SYMPHONY_REPO=owner/smol-symphony \
#   SYMPHONY_BASE_BRANCH=main \
#   npx symphony WORKFLOW.md
#
# `gh` on the host must be authenticated (`gh auth status` clean). The token
# never enters the VM.
#
# Every section and option is documented in WORKFLOW.template.md.

# Declared workflow states. Drives dispatch eligibility (role: active),
# terminal cleanup (role: terminal), and the propose_issue landing directory
# (role: holding). This map is the single source of truth — there are no
# separate active/terminal lists to keep in sync.
#
# Per-state `adapter` / `model` / `max_turns` override the workflow-level
# `acp.*` and `agent.max_turns` defaults at dispatch time. `allowed_transitions`
# narrows the targets the agent can pass to `symphony.transition` while
# operating in this state (omit for "any declared state is reachable").
states:
  Todo:
    role: active
    adapter: claude
    # Opus 4.8, 1M-context variant. The plain `claude-opus-4-7` is the 200K
    # variant — a γ-class refactor dispatch hit two mid-turn compactions before
    # reaching the edit phase; `[1m]` gives ~30x headroom and removes the stall.
    # The suffix is Claude Code's model-selection convention, forwarded to the
    # adapter via ANTHROPIC_MODEL. Review stays on codex (cross-model review).
    model: claude-opus-4-8[1m]
    max_turns: 10
  Review:
    # Codex picks up the implementer's branch and approves or rejects. On
    # approval it transitions the issue to Done with PR-body notes; on
    # rejection it transitions back to Todo with rework instructions.
    role: active
    adapter: codex
    # codex-acp accepts the model via `-c model="..."` argv (TOML); see
    # src/agent/adapters.ts. `gpt-5-codex` was historically rejected with the
    # ChatGPT-account user, so leave `model` unset and let codex-acp pick its
    # own default code-review model. Operators with an API-key Codex setup can
    # pin a specific model here once that's known-good.
    max_turns: 6
    allowed_transitions: [Todo, Done]
  Reflect:
    # Sleep cycle (issue 122). A single recurring "Sleep cycle" issue rests in
    # Dormant; the operator — or an external cron / `symphony reflect` verb —
    # arms a cycle by moving it into Reflect. eval_mode binds the read-only
    # /symphony/issues (all state dirs, including the Done/*.md handoff
    # transcripts) and /symphony/logs (per-issue JSONL run logs) mounts so the
    # agent can mine finished work for *recurring* harness friction, distil
    # lessons, and file improvement proposals via propose_issue (which land in
    # Triage — the human gate). It reflects on *how symphony runs work*
    # (WORKFLOW.md prompt branches, per-state model/max_turns/effort, hooks,
    # the gondolin image config, acceptance criteria, timeouts), NOT the product code under
    # review. After filing it transitions to Dormant and waits to be re-armed.
    # See the Reflect prompt branch (the `when "Reflect"` case in the body) for
    # the read → distil → propose loop and the guardrails. Cadence: the operator
    # / an external cron / a `mv` on disk can still arm a cycle, and the
    # orchestrator now also auto-arms Dormant → Reflect on idle or after N
    # terminal transitions (issue 125 — see the `sleep_cycle:` block below).
    role: active
    adapter: claude
    # 1M-context Opus: a reflection turn reads many Done/*.md transcripts plus
    # the relevant logs/<id>.jsonl, so the large-context variant avoids mid-turn
    # compaction (same rationale as the Todo state).
    model: claude-opus-4-8[1m]
    # Higher than Todo/Review: reading the history, distilling patterns, and
    # filing one proposal per lesson takes more turns than a single edit/review.
    max_turns: 20
    # Bind the read-only /symphony/issues + /symphony/logs mounts for this state.
    eval_mode: true
    # The reflector may ONLY go dormant — it cannot route itself into
    # Todo/Review/Done. A guardrail on this self-modifying loop; filing
    # improvements happens through propose_issue (→ Triage), which is
    # independent of allowed_transitions.
    allowed_transitions: [Dormant]
  Done:
    role: terminal
    # Issue 36 (reconciler v2 / typed action DAG): the legacy `after_run`
    # shell that pushed the branch and opened a PR is replaced by two typed
    # actions. The host pre-stages SYMPHONY_PR_TITLE / SYMPHONY_PR_BODY_FILE /
    # SYMPHONY_BRANCH (the same values the old shell read); the action
    # executor exposes them as $pr_title / $pr_body_file / $branch /
    # $base_branch / $repo in the fixed template namespace
    # (src/actions/types.ts → ActionContext). The `if: $repo` predicate
    # matches the old `[ -n "${SYMPHONY_REPO:-}" ] || exit 0` short-circuit
    # so the local-only mode is still a no-op. Per-action retry/snapshot
    # plumbing replaces the opaque shell-exit-code surface; on rate-limit
    # the create_pr_if_missing action shows "retrying in 60s" on the
    # dashboard instead of a silent failure.
    actions:
      - kind: push_branch
        name: push-branch
        remote: origin
        ref: $branch
        if: $repo
      - kind: create_pr_if_missing
        name: open-pr
        base: $base_branch
        head: $branch
        title_from: $pr_title
        body_from: $pr_body_file
        if: $repo
  Cancelled:
    role: terminal
    # Cancelled means the work was abandoned; no patch, no PR. The workspace is
    # cleaned up after the run unwinds and the commits are discarded with it.
  Triage:
    # Landing directory for `symphony.propose_issue`. Never dispatched; the
    # operator approves or discards from the dashboard. Declared FIRST among
    # holding states so it stays the `propose_issue` landing + triage target
    # (both resolve the first declared holding state).
    role: holding
  Dormant:
    # Resting place for the recurring "Sleep cycle" issue (issue 122) between
    # reflection runs. Holding → never dispatched. A reflection cycle re-arms by
    # moving the issue from Dormant back into Reflect: the orchestrator's
    # `sleep_cycle:` auto-arm (issue 125, below) does this on idle / after N
    # terminal transitions, and an external cron, a `symphony reflect` verb, or
    # `mv` on disk still work too. NOTE: the dashboard currently
    # renders triage approve/discard buttons on every holding row and the
    # tracker resolves a move by issue id regardless of source directory, so
    # clicking those buttons on a Dormant issue would mis-route it — re-arm via
    # cron/CLI/filesystem, not the dashboard buttons. A follow-up restricts
    # those buttons to the triage-landing state.
    role: holding

tracker:
  kind: local
  # Operator-scoped tracker root (outside the repo). State transitions and
  # propose_issue writes don't dirty the codebase's git status. Symphony
  # auto-mkdirs every declared state directory under this root on startup.
  root: ~/.symphony/trackers/smol-symphony

# PR autopilot (issue 38, simplified by issue 101). Enabled 2026-05-25 so
# Done-state PRs that are MERGEABLE have GitHub auto-merge armed; PRs reported
# as CONFLICTING are routed back to Todo for the dispatched agent to rebase
# (the host runs `git fetch origin <base>` before each dispatch so
# `origin/<base>` is current in the workspace, and the Todo prompt's first
# step is `git rebase origin/<base>`). There is no autopilot-side rebase
# machinery and no consecutive-failure circuit breaker — the same route +
# redispatch path handles a stale-base branch and a genuinely-conflicting
# one. Strategy `squash` matches the repo's `NN: title (#PR)` history.
#
# PREREQUISITE: `gh pr merge --auto` requires at least one branch-protection
# rule on `main`, or arming auto-merge errors. Ensure one exists in the repo's
# GitHub settings. To disable, set `enabled: false` (the resource is then never
# constructed and Done-state behavior reverts to the after_run PR-create hook +
# operator merge). Note: while enabled, transitions into Done no longer fire the
# standard terminal workspace cleanup — the pr resource owns the workspace until
# its PR merges or closes.
pr_autopilot:
  enabled: true
  merge_state: Done
  close_state: Cancelled
  conflict_route_to: Todo
  auto_merge_strategy: squash
  poll_interval_ms: 30000

# Sleep-cycle auto-arm (issue 125, the deferred follow-up to issue 122). The
# orchestrator moves the recurring "Sleep cycle" reflection issue from Dormant
# (holding) into Reflect (active) automatically — the "sleep when not busy"
# framing — so the cadence no longer depends solely on the operator / an
# external cron / a `mv` on disk. Two triggers, evaluated on every poll:
#
#   • arm_on_idle: when the orchestrator is idle (nothing running, claimed, or
#     pending retry, and no active candidate this poll) AND ≥1 issue has reached
#     a terminal state since the last reflection run. The "≥1 since last run"
#     gate is load-bearing: without it an idle orchestrator would re-arm
#     reflection in a tight loop with nothing new to mine.
#   • arm_after_done: a backstop for busy stretches that never go idle — arm
#     once this many issues have reached a terminal state (Done/Cancelled — the
#     work the reflector reads) since the last run.
#
# The terminal-transition counter resets to 0 the moment the issue is armed, and
# is held in orchestrator memory only (a restart resets it). GUARDRAILS (carried
# over from 122): auto-arming ONLY moves the issue into Reflect — the proposals
# it files still land in Triage and still require human approve/discard, so this
# does not bypass the human gate. Default off in the parser; this project opts
# in. Requires a single `sleep-cycle` issue resting in Dormant (created by the
# operator); the block is inert until that issue exists.
sleep_cycle:
  enabled: true
  issue_id: sleep-cycle
  dormant_state: Dormant
  reflect_state: Reflect
  arm_on_idle: true
  arm_after_done: 10

polling:
  interval_ms: 5000

workspace:
  root: ./.symphony/workspaces

# Per-issue JSONL run logs plus an orchestrator-side `symphony.log` mirror.
# One JSONL file per issue, appended across attempts and process restarts;
# captures every ACP JSON-RPC frame to/from the VM, raw adapter stderr,
# host-side hook output, and orchestrator lifecycle events — intended for
# later evaluation by another agent. The sibling `symphony.log` captures the
# orchestrator's structured log (dispatch, hooks, reconciler, shutdown) in the
# same `key=value` format so a post-hoc review has both surfaces in one
# directory. While the file sink is active the console shows only the startup
# banner; `tail -f symphony.log` follows the detail, and `--verbose` mirrors it
# back to the console. See WORKFLOW.template.md for the full schema.
logs:
  root: ./.symphony/logs

hooks:
  timeout_ms: 120000

  # The canonical clone + base-branch checkout + `agent/<id>` branch cut +
  # origin/identity setup moved into the orchestrator's TypeScript
  # `setupWorkspaceDir` action (issue 34 / reconciler stage 3). The per-issue
  # workspace arrives at the dispatched agent with:
  #
  #   • a hardlinked `git clone --local` of the source repo on the base branch
  #     (SYMPHONY_BASE_BRANCH or `main`) at the source repo's current local
  #     base SHA
  #   • all network remotes stripped (in-VM `git push`/`git fetch` fail closed)
  #   • when SYMPHONY_REPO is set: `origin` restored to the canonical HTTPS URL
  #     so the host's Done hook can push (`gh auth setup-git` runs best-effort
  #     on the host so the push has credentials; the token never enters the VM)
  #   • `user.name = symphony-agent` / `user.email = agent@symphony.local`
  #   • `agent/<id>` checked out
  #
  # The source repo's local `<base>` is the single source of truth for the
  # workspace's base ref. To pick up a new base, update the source repo
  # (`git pull` / `git fetch && git checkout <base>`) before the next dispatch;
  # symphony does not implicitly fetch from `origin/<base>` at setup time.
  #
  # No `after_create:` block is declared because no repo-local glue is needed
  # on top of that. Add an `after_create:` here if you need additional
  # workspace setup — it fires AFTER the canonical setup against the prepared
  # workspace cwd.
  #
  # No workflow-level after_run: the handoff (patch + optional PR) lives on
  # the Done state's per-state hook (see `states.Done.hooks.after_run` above).
  # It only fires on transition into Done, so we no longer need a script-level
  # state check to short-circuit non-terminal turns.

agent:
  # SERIALIZED to 1 (2026-05-27) to stop the FC/IS burn-down conflict storm:
  # every burn-down PR edits the same policy files (package.json --max-warnings
  # ratchet, .dependency-cruiser.cjs, eslint.config.js), so any two in flight
  # conflict by construction. Serial dispatch makes each PR rebase on the prior
  # merge. Revert to 2 once the arch-burndown queue drains.
  max_concurrent_agents: 1
  max_turns: 6
  max_retry_backoff_ms: 120000

acp:
  # Selecting "claude" is enough: symphony probes ~/.claude/.credentials.json
  # on the host at startup and auto-generates a launch command for the in-VM
  # agent. There is no `command` escape hatch under the TCP bridge transport —
  # the launch shape is fixed; fork scripts/vm-agent.mjs if you need to customize
  # what the agent spawns.
  adapter: claude
  # Credentials never enter the VM (issue 113; codex generalized in 116). The
  # guest holds only a token-shaped placeholder; the host substitutes the real
  # upstream credential into the outbound request at Gondolin egress (TLS-MITM):
  # for claude, the Anthropic OAuth access token; for codex (the Review state's
  # adapter), the OpenAI credential read from ~/.codex/auth.json (access token or
  # OPENAI_API_KEY, never the refresh token). Every credential-bearing var is
  # stripped from the forwarded VM boot env, so no real credential lands in the VM.
  # Reasoning effort forwarded to claude-agent-acp via a staged settings.json
  # (`{"effortLevel": "xhigh"}`) copied into /root/.claude/settings.json before the
  # adapter starts. xhigh is the second-highest tier under Opus 4.7 (max is the top
  # but is meaningfully slower); operators on a Haiku-backed model must drop this
  # because Haiku rejects xhigh at adapter startup. Valid set is `low|medium|high|xhigh|max`,
  # model-gated by claude-agent-acp's `supportedEffortLevels`.
  effort: xhigh
  shell: bash
  # Hard cap on a single session/prompt regardless of activity. Raised from 30min to
  # 60min (the code default) because a heavy refactor turn at effort=xhigh can run a
  # single uninterrupted turn past 30min — issue 103's healthy attempt was killed
  # mid-edit at the old 1800000 cap with turns_completed:0. Distinct from
  # stall_timeout_ms below (which only trips on NO activity).
  prompt_timeout_ms: 3600000
  read_timeout_ms: 30000
  # ACP TCP bridge. Symphony binds a listener on `bridge.bind_host:bind_port`; the in-VM
  # agent (`/opt/symphony/vm-agent.mjs`) dials `bridge.reach_host:bind_port` on startup
  # and authenticates with a per-dispatch bearer token. This replaced the earlier
  # in-VM-exec stdio path so symphony is not coupled to any particular sandbox's quirks.
  bridge:
    bind_host: 0.0.0.0
    bind_port: 8788
    reach_host: 127.0.0.1
  # Time between any ACP event from the adapter before symphony kills the attempt as stalled.
  # Raised from the 5-minute default because Opus 4.7 at effort=xhigh can take many minutes to
  # produce its first thought chunk on a heavy prompt. If a real wedge happens, attempts will
  # die at this longer threshold; if the agent is just thinking, we let it finish.
  stall_timeout_ms: 1800000

gondolin:
  # Per-issue microVM (Gondolin substrate). `image` is the agent rootfs the VM
  # boots, built ONCE with `npm run build:image` (see images/agents/) — not baked
  # per issue. The value is a Gondolin image selector: the content-addressed build
  # id printed by the build (pinned below for reproducibility), a `name:tag` ref
  # like `symphony-agents:latest`, or a path to an exported asset directory.
  image: cb875342-03ef-56e0-9306-dde8628aa17d
  cpus: 2
  mem_mib: 4096
  # No runtime bind-mounts. The in-VM launcher (/opt/symphony/vm-agent.mjs) is
  # baked into the image, so it needs no per-dispatch mount. Keeping `volumes`
  # empty leaves room for an eval_mode state's two read-only mounts (/symphony/issues
  # + /symphony/logs) on top of the auto-mounted workspace. Credentials never
  # mount: the host substitutes the real token at Gondolin egress; the tracker is
  # reached via the symphony MCP server (or the eval_mode mount).
  volumes: []
  # forward_env is a generic passthrough into the VM boot env, but the runner
  # strips EVERY credential-bearing var before boot (the guest holds only a
  # placeholder Gondolin substitutes at egress) — so listing OPENAI_API_KEY here
  # does NOT plant the real key in a VM.
  forward_env:
    - OPENAI_API_KEY
    - ANTHROPIC_API_KEY

egress:
  # General dev-tooling firewall for the in-VM agent. Gondolin denies guest egress
  # by default; the agent can always reach its own inference host (handled by the
  # credential layer), and these hosts are additionally opened so gates can run
  # (`npm install`, git-based deps, release binaries). SECURITY: nothing here ever
  # gets a real token substituted — listing a host grants plain network egress
  # only. The real upstream token is substituted solely on each adapter's inference
  # host (see src/agent/credential-secrets.ts).
  allowed_hosts:
    - registry.npmjs.org             # npm install
    - github.com                     # git-based deps / release pages
    - codeload.github.com            # GitHub tarball fetch
    - objects.githubusercontent.com  # release-binary downloads

server:
  port: 8787
  # Bound to all interfaces because access is gated by tailscale, not by the
  # HTTP server itself. The endpoint has no auth; only expose it inside a
  # trusted network boundary.
  host: 0.0.0.0

mcp:
  # Gondolin maps a synthetic guest host to the host's loopback (`tcp.hosts`), so
  # 127.0.0.1 from inside the VM hits the host's listener. Override only if
  # your VMM has a different host alias.
  host: 127.0.0.1
---
You are working on **smol-symphony**, a TypeScript orchestrator that dispatches
coding agents into per-issue Gondolin microVMs and talks to them over the Agent
Client Protocol (ACP). Your workspace is a fresh clone of this repo.

Issue: **{{ issue.identifier }} — {{ issue.title }}**
State: {{ issue.state }}
{% if issue.priority -%}Priority: {{ issue.priority }}{%- endif %}
{% if issue.labels.size > 0 -%}Labels: {% for l in issue.labels %}{{ l }}{% unless forloop.last %}, {% endunless %}{% endfor %}{%- endif %}

{% if issue.description -%}
Description:

{{ issue.description }}
{%- endif %}

Orientation:

- This is the smol-symphony codebase. Start by reading `README.md` and
  `PRODUCT.md` if you haven't seen them. `SPEC.md` is the long-form design
  spec. `CLAUDE.md` (if present) has any standing instructions for this repo.
- Source lives under `src/`. Tests live under `tests/`. Before declaring work
  done, run `npm run typecheck`, `npm test`, `npm run lint:arch` (import
  direction + hexagonal layering: domain must reach infra only through injected
  ports), and `npm run lint` (functional-core purity + imperative-shell
  complexity budgets); all must pass.
- You are on a per-issue branch (`agent/{{ issue.identifier }}`) checked out
  from the configured base branch. Commit your work locally. You do **not**
  have network credentials; pushing is the host's job, after the issue lands
  in a terminal state.
- This workflow's active states are **Todo** (you, implementing), **Review**
  (Codex, reviewing), and **Reflect** (the sleep-cycle reflection turn that
  mines finished work for harness improvements). Read the per-state
  instructions below.

{% case issue.state %}
{% when "Todo" %}
You are the **implementer**. Your job: turn the issue into a working change on
the per-issue branch, then hand off to the reviewer.

1. **Rebase onto a fresh base first.** Symphony has just fetched
   `origin/main` into your workspace (or whatever base branch
   `SYMPHONY_BASE_BRANCH` names — `main` is the default and matches this
   project). The very first thing to do is rebase your branch onto it:

   ```
   git rebase origin/main
   ```

   - On a fresh issue this is a no-op (you're already on top of base).
   - On a re-dispatch where base has advanced this picks up the new commits.
   - If `git rebase` reports conflicts, **resolve them in-tree as part of
     this turn** (reconcile your change with what landed on base), `git add`
     the resolved files, and `git rebase --continue` (repeat per replayed
     commit). Then proceed to step 2. There is no separate conflict state
     to route to — handling the conflict is part of normal implementation
     work, just like any other rebase you'd do on your own machine.
2. Read enough of the codebase to understand the change you need to make.
3. Decide where the change belongs before writing it. The orchestrator
   (`src/agent/runner.ts`, `src/mcp.ts`, `src/orchestrator.ts`) owns the
   state machine and the tracker. Hooks in `WORKFLOW.md` are for repo-local
   glue: cloning the workspace, `git push`, `gh pr create`, rescuing
   artifacts. State-machine behavior (new transitions, anything that
   mutates tracker files or runtime entry state) belongs in the
   orchestrator with typed APIs and tests — not in a shell hook. If you
   find yourself adding a `SYMPHONY_*` env var so a hook can reach into
   orchestrator state, or writing a hook that the runner then has to
   re-detect via a post-hook scan, that is the signal you are on the wrong
   side of the seam: stop and put the logic in the runner/MCP layer
   instead. The issue body may sketch a shell-shaped solution; treat that
   as one option, not a directive.
4. Make the smallest correct change for the issue's stated scope, and keep it
   focused. If you notice work beyond what the issue states, call
   `symphony.propose_issue` for it rather than expanding this change to swallow
   follow-up work. Add or update tests where the change is testable. Before
   handing off, run `npm run typecheck`, `npm test`, `npm run lint:arch`, and
   `npm run lint` — all must pass.
   **Do NOT edit the `--max-warnings` ratchet in `package.json`** — leave that line
   exactly as-is. It is tightened in one pass at the end of the burn-down. Your change
   only needs to keep `npm run lint` green at the *current* ratchet (it will, as long
   as you reduce or hold the warning count). Lowering it yourself just collides with
   every other in-flight issue's `package.json` and forces manual conflict resolution.
5. Commit your work to the per-issue branch with a short message.
6. Hand off to the reviewer by calling:

   ```
   symphony.transition({
     to_state: "Review",
     notes: "# <imperative-voice title, ≤72 chars>\n\n<one- to three-paragraph
             summary of what you changed, why, files touched, and tests added>"
   })
   ```

   The notes describe **this change**. Out-of-scope items you noticed —
   unrelated bugs, refactors, follow-ups, a future ticket someone should
   size — go through `symphony.propose_issue` (see the shared section below).
   Do not park them in a "Follow-ups not done" section in the notes; that
   surface dies in `Done/<id>.md` and no agent ever sees it again.

   Don't include a verification section restating that
   `npm run typecheck` / `npm test` / `npm run build` passed — that's an
   AGENTS.md requirement and the reviewer re-runs them. Mention test count
   or extra commands only when something is atypical (test count dropped,
   you ran a smoke against a live service, etc.).

   The notes block is appended to the issue body **before** the file moves to
   `Review/`, so the reviewer sees it as part of `issue.description` on the
   next dispatch. Write it as if it were the PR body — because if the reviewer
   approves, the entire issue body (including this block) becomes the PR
   description. Then end your turn; do not call any further tools.

{% when "Review" %}
You are the **reviewer**. The implementer has committed work to the per-issue
branch (`agent/{{ issue.identifier }}`) and handed off. Their summary is in
the issue description above. Your job: decide whether the work is correct and
either approve (→ Done) or send it back (→ Todo) with specific findings.

1. Read the implementer's notes in the issue description carefully — title,
   summary, files claimed touched. (Follow-ups belong in `propose_issue`,
   not the notes; if you see a "Follow-ups not done" section in the notes,
   reject and ask the implementer to file each item as a separate
   `propose_issue` call instead.)
2. Inspect the diff against the base branch:

   ```
   git log --oneline main..HEAD
   git diff main..HEAD
   ```

   Look at each file the implementer claimed to touch. Spot-check tests and
   typecheck pass:

   ```
   npm run typecheck
   npm test
   ```

3. Placement check — is the change on the right side of the seam?

   The orchestrator (`src/agent/runner.ts`, `src/mcp.ts`, `src/orchestrator.ts`)
   owns the state machine and tracker. Hooks in `WORKFLOW.md` are for
   repo-local glue: cloning the workspace, `git push`, `gh pr create`,
   rescuing artifacts. Reject when the diff crosses that line:

   - A hook implements a new state transition, or mutates the tracker
     filesystem the orchestrator owns (e.g. `mv issues/<state>/<id>.md
     issues/<other-state>/<id>.md`).
   - A hook mutates runtime state the orchestrator committed earlier (e.g.
     undoing a cleanup flag) and the runner now has to re-detect what the
     hook did via a post-hook scan.
   - A new `SYMPHONY_*` env var is added so a hook can reach into
     orchestrator-owned state. The contract is growing because the logic is
     on the wrong side; surface it as a typed call in the runner/MCP layer
     instead.

   If any of the above fires, reject with a pointer to the right home
   (runner, MCP tool, or orchestrator). Hook-only diffs that stay within
   repo-local glue (push/PR/clone/format-patch) are fine — this check is
   about state-machine logic leaking into shell.

4. Decide:

   - **Approve**: the change is correct, tests pass, no blocking issues. Call

     ```
     symphony.transition({
       to_state: "Done",
       notes: "<approval rationale; this becomes the PR body>"
     })
     ```

     Your notes are appended to the issue body and feed straight into the PR
     description the host opens against the base branch. Be specific about
     what you verified.

   - **Reject**: the change is wrong, incomplete, or has issues that need
     rework. Call

     ```
     symphony.transition({
       to_state: "Todo",
       notes: "<specific findings: file paths, line numbers, what's wrong,
               what needs to change. Be concrete — the implementer will see
               this as their next prompt.>"
     })
     ```

     The issue goes back to Todo with your findings appended. The same
     workspace and `agent/{{ issue.identifier }}` branch survive the round
     trip, so the next implementer dispatch sees both your notes and their
     prior commits.

   Either way, end your turn after the transition call. Do not call any
   further tools.

{% when "Reflect" %}
You are the **reflector** running symphony's *sleep cycle*. You are not
implementing or reviewing a product change. Your job: mine symphony's own
finished work for *recurring* friction in **how it runs work**, distil concrete
lessons, and file one harness-improvement proposal per lesson into Triage —
where a human operator decides whether to adopt it. Then go dormant.

This is a self-modifying loop: you read agent-authored transcripts and then
propose changes to *your own* operating instructions. The guardrails below are
load-bearing — follow them exactly.

**What you can read** (read-only mounts present only in this state):

- `/symphony/issues/` — every issue file across every state directory. The
  richest signal is `/symphony/issues/Done/*.md`: each file is the full handoff
  thread (every `symphony.transition` notes block from implementer → reviewer →
  approval is appended to the body), so a Done file shows how the work actually
  went, not just the final result. `Triage/`, `Cancelled/`, and the active
  state dirs are visible too.
- `/symphony/logs/<id>.jsonl` — the per-issue run log: every ACP frame, adapter
  stderr line, hook output, and orchestrator lifecycle event for that issue.
  This is where stalls, turn-budget exhaustion, retries, and timeouts show up
  in detail.
- Your workspace is a clone of the symphony repo, so you can read `WORKFLOW.md`,
  `WORKFLOW.template.md`, `src/`, `images/agents/`, etc. to ground each proposal
  in the concrete knob it would change.

If structured per-issue run summaries exist (companion issue #123), start from
those as an index; otherwise skim `Done/*.md` and open the
`/symphony/logs/<id>.jsonl` for the issues that look anomalous.

**What to look for — *recurring* patterns, not one-offs.** One bad run is
noise; the same failure shape across several issues is signal. For example:

- repeated `Review → Todo` rejects with the same root cause (the reviewer keeps
  catching the same class of mistake the implementer prompt doesn't prevent);
- turn-budget exhaustion (a state hits `max_turns` before it can transition);
- stalls / timeouts (`stall_timeout_ms` / `prompt_timeout_ms` trips);
- rebase / merge-conflict churn on re-dispatch;
- credential re-login loops;
- acceptance-criteria misses a sharper prompt or checklist would have caught;
- prompt ambiguity that forced `request_human_steering`.

**For each distilled lesson, file exactly one `symphony.propose_issue` call**
(one per fix — never batch multiple fixes into one proposal; Triage is
per-item). Each proposal must:

- name a single concrete change to the **harness / operating config**: a
  `WORKFLOW.md` prompt branch, a per-state `model` / `max_turns` /
  `allowed_transitions` / `effort`, a hook, the `gondolin` image config, an
  acceptance criterion, or a timeout;
- include a **before → after** (what the config/prompt says now, what you'd
  change it to);
- cite the **evidence** — the issue ids (and, where useful, the log lines or
  Done-file quotes) that motivated it — so the operator can check the lesson
  against the trajectories rather than trusting your summary.

**Hard guardrails — a proposal that violates any of these must NOT be filed:**

- Propose changes to the **harness only** — `WORKFLOW.md` /
  `WORKFLOW.template.md`, per-state config, hooks, the `gondolin` image config,
  acceptance criteria, timeouts. Do **not** propose edits to product/source code under
  `src/` as a "fix" for a trajectory; if a genuine product bug is the root
  cause, that is an ordinary `propose_issue` for an implementer, not a harness
  change, and you should frame it that way.
- Never propose anything that **weakens a quality gate.** Do not weaken or
  remove the Review state, the `npm run typecheck` / `npm test` /
  `npm run lint:arch` / `npm run lint` gates, or the Triage human-approval gate
  itself. The whole point of this loop is that a human stays in it; proposals
  that would let the loop dispatch its own changes without review are
  forbidden, even if the trajectories seem to "justify" them.
- One fix per proposal, each with cited evidence. No proposal without issue ids.

When you have filed your proposals — or concluded there is no recurring pattern
worth acting on this cycle — hand off by going dormant:

```
symphony.transition({
  to_state: "Dormant",
  notes: "<one-paragraph log of this cycle: how many issues you reviewed, the
          patterns you found, and the proposal titles you filed (or 'no
          actionable pattern this cycle')>"
})
```

Then end your turn; do not call any further tools. A later cadence (operator,
cron, or `symphony reflect`) re-arms you by moving the issue back into Reflect.

{% else %}
This state (`{{ issue.state }}`) does not have a state-specific prompt yet in
this workflow. Re-read the issue body for instructions; if you can't infer
what to do safely, call `symphony.request_human_steering` rather than guessing.
{% endcase %}

If you genuinely cannot proceed — ambiguous requirements, missing context that
only a human can supply, a design decision that needs human input — call
`symphony.request_human_steering({ question, context })` instead of guessing.
Your turn will end immediately and the human's response will arrive as your
next prompt.

Steering tips:

- The operator's dashboard already shows the original issue title and body
  alongside your question. Do **not** restate or paraphrase the issue body in
  `question`; ask the specific thing you need answered.
- Use `context` for facts the operator wouldn't otherwise see: what you've
  inspected, what you've already tried, what constraint is forcing the
  question.

If during your work you notice something worth fixing that is **out of scope**
for your current task — an unrelated bug, a follow-up the operator should
size, a refactor a future agent could pick up — call
`symphony.propose_issue({ title, description?, labels?, priority? })`. The
proposal lands in a Triage state directory that the orchestrator does **not**
dispatch; the operator approves or discards it from the dashboard. Your
current issue is automatically recorded as the proposal's parent — do not
paste it into the body. Use this instead of grafting unrelated changes onto
your current task; keep your branch focused.

File **one `propose_issue` call per follow-up**, not a batched call with
multiple items in one body. Triage is per-item triage; the operator's
approve/discard verb is per-issue, so a batched proposal forces an
all-or-nothing decision and loses the individual sizing/priority each
follow-up deserves. The "Follow-ups not done" pattern of writing a bulleted
list in the handoff notes is the wrong surface — those notes ride into the
PR and then die in `Done/<id>.md`; only `propose_issue` puts the items in
front of the operator on the dashboard.

{% if attempt -%}
This is continuation/retry attempt {{ attempt }}. Inspect the workspace before
making new edits; your previous run may have left commits on the branch. Check
`git log agent/{{ issue.identifier }}` to see what's there. If the work is
already complete in the current state, call `symphony.transition` with the
appropriate next state and notes summarising what was already done, then stop.
{%- endif %}
