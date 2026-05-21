---
# WORKFLOW.md — symphony dispatched against smol-symphony itself.
#
# Run with:
#
#   npx symphony WORKFLOW.md
#
# Defaults assume a fully local setup: the per-issue workspace clones from this
# repo's `.git` directory, the agent has no network credentials, and when the
# issue lands in a terminal state the host writes a `git format-patch` bundle
# to `.symphony/patches/<branch>.patch` for human review.
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
    # Per-state after_run fires only on transition INTO this state, so the
    # script does not have to walk the tracker to check whether the issue
    # actually landed in a terminal directory — the orchestrator's hook
    # resolution already gates that. Two outputs:
    #   - Always: write the agent's work as a git format-patch bundle into
    #     ./.symphony/patches/<branch>.patch for human review.
    #   - If SYMPHONY_REPO is set: push the per-issue branch + open (or update)
    #     a PR via gh on top of the patch bundle.
    hooks:
      after_run: |
        set -eu
        BASE="${SYMPHONY_BASE_BRANCH:-main}"
        ISSUE_ID="$(basename "$PWD")"
        BRANCH="agent/${ISSUE_ID}"
        TRACKER_ROOT="${SYMPHONY_TRACKER_ROOT:-$HOME/.symphony/trackers/smol-symphony}"
        PATCHES_DIR="${SYMPHONY_PATCHES_DIR:-$PWD/../../../.symphony/patches}"
        # The hook is attached to the Done state, so the issue file is here.
        ISSUE_FILE="${TRACKER_ROOT}/Done/${ISSUE_ID}.md"

        # Pull PR title + body straight from the Done-state issue file. The
        # `symphony.transition` tool appends every hop's notes (implementer →
        # reviewer → approval) to the issue body before each move, so the file
        # carries the full thread. We use:
        #   - Title: front-matter `title:` field, prefixed with the issue id so
        #     PR lists stay scannable. Falls back to the bare id when missing.
        #   - Body:  everything after the closing `---` of front-matter.
        # awk extracts `title:` without dragging in a YAML parser; the body-
        # extracting awk walks state: 0 = before opening fence, 1 = in front
        # matter, 2 = body. If the file has no opening fence, every line is body.
        RAW_TITLE="$(awk '
          BEGIN { in_fm = 0 }
          NR == 1 && /^---[[:space:]]*$/ { in_fm = 1; next }
          in_fm && /^---[[:space:]]*$/ { exit }
          in_fm && /^title:[[:space:]]*/ {
            sub(/^title:[[:space:]]*/, "")
            gsub(/^["'\'']|["'\'']$/, "")
            print
            exit
          }
        ' "${ISSUE_FILE}")"
        TITLE="${RAW_TITLE}"
        BODY="$(awk '
          BEGIN { state = 0 }
          NR == 1 {
            if ($0 ~ /^---[[:space:]]*$/) { state = 1; next }
            else { state = 2 }
          }
          state == 1 {
            if ($0 ~ /^---[[:space:]]*$/) { state = 2; next }
            next
          }
          state == 2 { print }
        ' "${ISSUE_FILE}")"
        if [ -z "${BODY}" ]; then
          BODY="$(cat "${ISSUE_FILE}")"
        fi

        if ! git rev-parse --verify "${BRANCH}" >/dev/null 2>&1; then
          echo "no branch ${BRANCH}; nothing to hand off"
          exit 0
        fi

        # Resolve the ref the agent diverged from. In remote mode origin/${BASE}
        # exists (after_create's `git fetch`). In local-only mode the local
        # ${BASE} branch is the tip the agent diverged from.
        if git rev-parse --verify "origin/${BASE}" >/dev/null 2>&1; then
          MERGE_BASE="origin/${BASE}"
        elif git rev-parse --verify "${BASE}" >/dev/null 2>&1; then
          MERGE_BASE="${BASE}"
        else
          echo "could not resolve merge base (no origin/${BASE} or local ${BASE})" >&2
          exit 1
        fi

        if [ -z "$(git log --oneline "${MERGE_BASE}..${BRANCH}" 2>/dev/null)" ]; then
          echo "no new commits on ${BRANCH}; nothing to hand off"
          exit 0
        fi

        # Always materialize the patch bundle BEFORE attempting the remote push.
        # If anything in the gh/origin chain fails the work survives at
        # .symphony/patches/<branch>.patch and can be replayed with `git am`.
        mkdir -p "${PATCHES_DIR}"
        PATCH_OUT="${PATCHES_DIR}/$(echo "${BRANCH}" | tr '/' '_').patch"
        git format-patch --stdout "${MERGE_BASE}..${BRANCH}" > "${PATCH_OUT}"
        echo "wrote patch bundle: ${PATCH_OUT}"

        if [ -n "${SYMPHONY_REPO:-}" ]; then
          # Remote PR mode. Be defensive about origin: an earlier workspace creation
          # may have happened with SYMPHONY_REPO unset (after_create's remote-add
          # branch was skipped), leaving the workspace without an origin remote
          # even though we are now in PR mode. Re-add it idempotently before pushing.
          if ! git remote get-url origin >/dev/null 2>&1; then
            echo "after_run: origin remote missing; re-adding"
            git remote add origin "https://github.com/${SYMPHONY_REPO}.git"
            gh auth setup-git 2>/dev/null || true
          fi
          if git push -u origin "${BRANCH}"; then
            if gh pr view "${BRANCH}" >/dev/null 2>&1; then
              echo "PR already exists for ${BRANCH}; pushed updates"
            elif ! gh pr create \
              --base "${BASE}" \
              --head "${BRANCH}" \
              --title "${ISSUE_ID}${TITLE:+: ${TITLE}}" \
              --body "${BODY}"; then
              echo "gh pr create failed; patch bundle preserved at ${PATCH_OUT}" >&2
            fi
          else
            echo "git push failed; patch bundle preserved at ${PATCH_OUT}" >&2
          fi
        else
          echo "  apply with:  git -C <target-repo> am ${PATCH_OUT}"
        fi
  Cancelled:
    role: terminal
    # Cancelled means the work was abandoned; no patch, no PR. The workspace is
    # cleaned up after the run unwinds and the commits are discarded with it.
  Triage:
    # Landing directory for `symphony.propose_issue`. Never dispatched; the
    # operator approves or discards from the dashboard.
    role: holding

tracker:
  kind: local
  # Operator-scoped tracker root (outside the repo). State transitions and
  # propose_issue writes don't dirty the codebase's git status. Symphony
  # auto-mkdirs every declared state directory under this root on startup.
  root: ~/.symphony/trackers/smol-symphony

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
  # history on the configured base branch, plus a per-issue branch checked out.
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
    # `--no-tags` keeps the local refspec minimal; `--branch` lands on the right base.
    git clone --local --no-tags --branch "${BASE}" "${SOURCE_REPO}" .

    # Strip all remotes. The agent will see no network targets at all.
    for remote in $(git remote); do
      git remote remove "${remote}"
    done
    git config --local --unset credential.helper 2>/dev/null || true

    # If SYMPHONY_REPO is set, restore an `origin` pointing at the GitHub remote
    # so the after_run hook can push. The URL is the canonical HTTPS form (no
    # token); auth comes from the host's `gh`, which never enters the VM.
    if [ -n "${SYMPHONY_REPO:-}" ]; then
      git remote add origin "https://github.com/${SYMPHONY_REPO}.git"
      gh auth setup-git 2>/dev/null || true
      git fetch --no-tags origin "${BASE}:refs/remotes/origin/${BASE}" || true
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
  # scripts/vm-agent.js if you need to customize what the proxy spawns.
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
  from: ./.vm/symphony.smolmachine.smolmachine
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
2. Make the smallest correct change. Add or update tests where the change is
   testable. Run `npm run typecheck` and `npm test`; both must pass.
3. Commit your work to the per-issue branch with a short message.
4. Hand off to the reviewer by calling:

   ```
   symphony.transition({
     to_state: "Review",
     notes: "# <imperative-voice title, ≤72 chars>\n\n<one- to three-paragraph
             summary of what you changed, why, files touched, tests added, and
             any follow-ups you noticed but didn't do>"
   })
   ```

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
   summary, files claimed touched, follow-ups noted.
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

3. Decide:

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

{% if attempt -%}
This is continuation/retry attempt {{ attempt }}. Inspect the workspace before
making new edits; your previous run may have left commits on the branch. Check
`git log agent/{{ issue.identifier }}` to see what's there. If the work is
already complete in the current state, call `symphony.transition` with the
appropriate next state and notes summarising what was already done, then stop.
{%- endif %}
