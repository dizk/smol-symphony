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
    model: claude-opus-4-7
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
  Done:
    role: terminal
    # Per-state after_run fires only on transition INTO this state. The host
    # pre-stages SYMPHONY_PR_TITLE / SYMPHONY_PR_BODY_FILE / SYMPHONY_BRANCH for
    # us (title is already issue-id prefixed; the body file carries the full
    # multi-hop notes from the issue's tracker file), so the hook is just the
    # push + PR-create. Local-only mode (no SYMPHONY_REPO) exits 0 and leaves
    # the per-issue branch in the workspace; the orchestrator removes the
    # workspace after this hook returns.
    hooks:
      after_run: |
        set -eu
        [ -n "${SYMPHONY_REPO:-}" ] || exit 0
        git push -u origin "$SYMPHONY_BRANCH"
        if gh pr view "$SYMPHONY_BRANCH" >/dev/null 2>&1; then
          echo "PR already exists for $SYMPHONY_BRANCH; pushed updates"
          exit 0
        fi
        gh pr create \
          --base "$SYMPHONY_BASE_BRANCH" \
          --head "$SYMPHONY_BRANCH" \
          --title "$SYMPHONY_PR_TITLE" \
          --body-file "$SYMPHONY_PR_BODY_FILE"
  Cancelled:
    role: terminal
    # Cancelled means the work was abandoned; no patch, no PR. The workspace is
    # cleaned up after the run unwinds and the commits are discarded with it.
  Triage:
    # Landing directory for `symphony.propose_issue`. Never dispatched; the
    # operator approves or discards from the dashboard. Must precede `Conflict`
    # below so propose_issue (which lands in the first holding state) still
    # targets Triage rather than the integration-conflict bucket.
    role: holding
  Conflict:
    # Holding state for issues whose post-terminal merge fails. Currently inert
    # because the `integration:` block is not declared (shared-integration flow
    # is disabled); nothing routes here. Kept as a no-op declaration so
    # re-enabling integration later is a one-block addition rather than also
    # needing to re-declare the holding state.
    role: holding

tracker:
  kind: local
  # Operator-scoped tracker root (outside the repo). State transitions and
  # propose_issue writes don't dirty the codebase's git status. Symphony
  # auto-mkdirs every declared state directory under this root on startup.
  root: ~/.symphony/trackers/smol-symphony

# Shared-integration-branch flow is currently DISABLED. Per-issue workspaces
# clone directly from the base branch; terminal-state merges land via the
# standard PR flow against `main` rather than a shared `integration` ref.
#
# To re-enable (e.g. when concurrent dispatches become common), restore an
# `integration:` block here:
#
#   integration:
#     branch: integration
#     conflict_state: Conflict
#     merge_on_states: [Done]
#
# and rewrite the `hooks.after_create` script below to clone from `integration`
# (seeded from base on first run) instead of from base directly. The
# orchestrator path that performs the host-side merge keys on a non-empty
# `merge_on_states` list — leaving the block absent fully skips the feature.

polling:
  interval_ms: 5000

workspace:
  root: ./.symphony/workspaces

# Per-issue JSONL run logs. One file per issue, appended across attempts and
# process restarts. Captures every ACP JSON-RPC frame to/from the VM, raw
# adapter stderr, host-side hook output, and orchestrator lifecycle events —
# intended for later evaluation by another agent. See WORKFLOW.template.md
# for the full schema.
logs:
  root: ./.symphony/logs

hooks:
  timeout_ms: 120000

  # Clone smol-symphony into the fresh per-issue workspace from a strictly local
  # source (no creds needed). The agent receives a working git repo with full
  # history on the base branch plus a per-issue branch checked out from it.
  # All network remotes are stripped so any `git push`/`git fetch` from inside
  # the VM fails closed.
  after_create: |
    set -eu
    SOURCE_REPO="${SYMPHONY_SOURCE_REPO:-${PWD}/../../..}"
    BASE="${SYMPHONY_BASE_BRANCH:-main}"
    ISSUE_ID="$(basename "$PWD")"
    BRANCH="agent/${ISSUE_ID}"

    if [ ! -d "${SOURCE_REPO}/.git" ]; then
      echo "after_create: SOURCE_REPO=${SOURCE_REPO} is not a git repo" >&2
      exit 1
    fi

    # `git clone --local` hardlinks .git/objects when possible; fast and disk-cheap.
    # `--no-tags` keeps the local refspec minimal; `--branch` lands on the base.
    git clone --local --no-tags --branch "${BASE}" "${SOURCE_REPO}" .

    # Strip all remotes. The agent will see no network targets at all.
    for remote in $(git remote); do
      git remote remove "${remote}"
    done
    git config --local --unset credential.helper 2>/dev/null || true

    # If SYMPHONY_REPO is set, restore an `origin` pointing at the GitHub remote
    # so the after_run hook can push. The URL is the canonical HTTPS form (no
    # token); auth comes from the host's `gh`, which never enters the VM. After
    # fetching origin/${BASE} we reset the local base branch to it, ensuring
    # the `agent/<id>` branch we cut next is based on the live remote tip
    # rather than a possibly-stale source-repo copy.
    if [ -n "${SYMPHONY_REPO:-}" ]; then
      git remote add origin "https://github.com/${SYMPHONY_REPO}.git"
      gh auth setup-git 2>/dev/null || true
      if git fetch --no-tags origin "${BASE}:refs/remotes/origin/${BASE}"; then
        git checkout -B "${BASE}" "refs/remotes/origin/${BASE}"
      fi
    fi

    git config --local user.name  "symphony-agent"
    git config --local user.email "agent@symphony.local"

    git checkout -b "${BRANCH}"

    echo "workspace ready: base=${BASE} branch=${BRANCH} source=${SOURCE_REPO}"

  # No workflow-level after_run: the handoff (patch + optional PR) lives on
  # the Done state's per-state hook (see `states.Done.hooks.after_run` above).
  # It only fires on transition into Done, so we no longer need a script-level
  # state check to short-circuit non-terminal turns.

agent:
  max_concurrent_agents: 1
  max_turns: 6
  max_retry_backoff_ms: 120000

acp:
  # Selecting "claude" is enough: symphony reads ~/.claude/.credentials.json on
  # the host, stages a copy into the workspace's runtime dir, and auto-generates
  # a launch command that places the file at the adapter's expected path inside
  # the VM before exec'ing the in-VM proxy. There is no `command` escape hatch
  # under the TCP bridge transport — the launch shape is fixed; fork
  # scripts/vm-agent.mjs if you need to customize what the proxy spawns.
  adapter: claude
  # Reasoning effort forwarded to claude-agent-acp via a staged settings.json
  # (`{"effortLevel": "xhigh"}`) copied into /root/.claude/settings.json before the
  # adapter starts. xhigh is the second-highest tier under Opus 4.7 (max is the top
  # but is meaningfully slower); operators on a Haiku-backed model must drop this
  # because Haiku rejects xhigh at adapter startup. Valid set is `low|medium|high|xhigh|max`,
  # model-gated by claude-agent-acp's `supportedEffortLevels`.
  effort: xhigh
  shell: bash
  prompt_timeout_ms: 1800000
  read_timeout_ms: 30000
  # ACP TCP bridge. Symphony binds a listener on `bridge.bind_host:bind_port`; the in-VM
  # proxy (`/opt/symphony/vm-agent.mjs`) dials `bridge.reach_host:bind_port` on startup
  # and authenticates with a per-dispatch bearer token. This replaced the smolvm-exec
  # stdio path so symphony is not coupled to any particular sandbox's stdio quirks.
  bridge:
    bind_host: 0.0.0.0
    bind_port: 8788
    reach_host: 127.0.0.1
  # Time between any ACP event from the adapter before symphony kills the attempt as stalled.
  # Raised from the 5-minute default because Opus 4.7 at effort=xhigh can take many minutes to
  # produce its first thought chunk on a heavy prompt. If a real wedge happens, attempts will
  # die at this longer threshold; if the agent is just thinking, we let it finish.
  stall_timeout_ms: 1800000

smolvm:
  # Declarative VM setup via Smolfile. The reconciler (issue 32) hashes the Smolfile
  # on startup and on change, builds a .smolmachine artifact under
  # ~/.cache/symphony/actions/bake/<sha256>.smolmachine, and gates dispatch on
  # bake-ready. Dispatch then uses `smolvm machine create --from <cache>` so the
  # Smolfile's apt + npm install are paid once at bake time, not per dispatch.
  smolfile: ./Smolfile
  cpus: 2
  mem_mib: 4096
  net: true
  # No volume mounts. Workspace is auto-mounted by the runner. Credentials are
  # staged into the workspace by symphony and copied into ~/.claude by the
  # auto-derived ACP launch command. The tracker is reached only through the
  # symphony MCP server.
  volumes: []
  forward_env:
    - OPENAI_API_KEY
    - ANTHROPIC_API_KEY

server:
  port: 8787
  # Bound to all interfaces because access is gated by tailscale, not by the
  # HTTP server itself. The endpoint has no auth; only expose it inside a
  # trusted network boundary.
  host: 0.0.0.0

mcp:
  # The VM's loopback transparently reaches the host's loopback in smolvm, so
  # 127.0.0.1 from inside the VM hits the host's listener. Override only if
  # your VMM has a different host alias.
  host: 127.0.0.1
---
You are working on **smol-symphony**, a TypeScript orchestrator that dispatches
coding agents into per-issue smolvm microVMs and talks to them over the Agent
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
- Source lives under `src/`. Tests live under `tests/`. Run `npm test` and
  `npm run typecheck` before declaring work done.
- You are on a per-issue branch (`agent/{{ issue.identifier }}`) checked out
  from the configured base branch. Commit your work locally. You do **not**
  have network credentials; pushing is the host's job, after the issue lands
  in a terminal state.
- This workflow has two active states: **Todo** (you, implementing) and
  **Review** (Codex, reviewing). Read the per-state instructions below.

{% case issue.state %}
{% when "Todo" %}
You are the **implementer**. Your job: turn the issue into a working change on
the per-issue branch, then hand off to the reviewer.

1. Read enough of the codebase to understand the change you need to make.
2. Decide where the change belongs before writing it. The orchestrator
   (`src/agent/runner.ts`, `src/mcp.ts`, `src/orchestrator.ts`) owns the
   state machine and the tracker. Hooks in `WORKFLOW.md` are for repo-local
   glue: cloning the workspace, `git push`, `gh pr create`, rescuing
   artifacts. State-machine behavior (new transitions, conflict routing,
   anything that mutates tracker files or runtime entry state) belongs in
   the orchestrator with typed APIs and tests — not in a shell hook. If you
   find yourself adding a `SYMPHONY_*` env var so a hook can reach into
   orchestrator state, or writing a hook that the runner then has to
   re-detect via a post-hook scan, that is the signal you are on the wrong
   side of the seam: stop and put the logic in the runner/MCP layer
   instead. The issue body may sketch a shell-shaped solution; treat that
   as one option, not a directive.
3. Make the smallest correct change. Add or update tests where the change is
   testable. Run `npm run typecheck` and `npm test`; both must pass.
4. Commit your work to the per-issue branch with a short message.
5. Hand off to the reviewer by calling:

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
