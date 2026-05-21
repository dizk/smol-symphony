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
    # pre-stages SYMPHONY_PR_TITLE / SYMPHONY_PR_BODY_FILE / SYMPHONY_BRANCH /
    # SYMPHONY_TRACKER_ROOT for us (title is already issue-id prefixed; the body
    # file carries the full multi-hop notes from the issue's tracker file), so
    # the hook is just push + PR-create + integration merge. Local-only mode (no
    # SYMPHONY_REPO) skips push/PR but still keeps the integration branch on the
    # source repo in sync so concurrent agents see each other's work. The
    # orchestrator removes the workspace after this hook returns.
    hooks:
      after_run: |
        set -eu
        ISSUE_ID="$SYMPHONY_ISSUE_ID"
        BRANCH="$SYMPHONY_BRANCH"
        BASE="$SYMPHONY_BASE_BRANCH"
        INTEGRATION="${SYMPHONY_INTEGRATION_BRANCH:-integration}"
        SOURCE_REPO="${SYMPHONY_SOURCE_REPO:-${PWD}/../../..}"

        # 1) PR against `main` (remote mode only). Independent of the integration
        # merge below — even if integration conflicts, the PR is still opened so
        # the operator can handle it on the normal review cadence.
        if [ -n "${SYMPHONY_REPO:-}" ]; then
          git push -u origin "$BRANCH"
          if gh pr view "$BRANCH" >/dev/null 2>&1; then
            echo "PR already exists for $BRANCH; pushed updates"
          else
            gh pr create \
              --base "$BASE" \
              --head "$BRANCH" \
              --title "$SYMPHONY_PR_TITLE" \
              --body-file "$SYMPHONY_PR_BODY_FILE"
          fi
        fi

        # 2) Merge agent/<id> into the shared integration branch. Done in the
        # workspace (we already have the agent branch checked out), then pushed
        # to whichever repo owns integration for this run: origin in remote mode,
        # the source repo in local mode.
        if [ -n "${SYMPHONY_REPO:-}" ]; then
          INT_PUSH_TARGET="origin"
          if ! git fetch --no-tags origin "${INTEGRATION}:refs/symphony/integ-base" 2>/dev/null; then
            # Origin doesn't have integration yet (first run after switching to
            # this flow). Seed it from BASE on origin and re-fetch.
            git fetch --no-tags origin "${BASE}:refs/symphony/integ-base"
            git push origin "refs/symphony/integ-base:refs/heads/${INTEGRATION}"
          fi
        else
          INT_PUSH_TARGET="$SOURCE_REPO"
          if ! git -C "$SOURCE_REPO" rev-parse --verify "refs/heads/${INTEGRATION}" >/dev/null 2>&1; then
            git -C "$SOURCE_REPO" branch "$INTEGRATION" "$BASE"
          fi
          git fetch --no-tags "$SOURCE_REPO" "${INTEGRATION}:refs/symphony/integ-base"
        fi

        # Detach to the integration tip and squash-merge agent/<id>. Squash
        # keeps integration history readable (one commit per issue) and makes
        # future per-issue rebases trivial. The original per-commit history is
        # preserved on agent/<id> for the PR against main.
        git checkout --detach refs/symphony/integ-base >/dev/null
        MERGE_OK=0
        HAS_CHANGES=0
        CONFLICT_FILES=""
        DIFFSTAT=""
        if git merge --squash "$BRANCH"; then
          if git diff --cached --quiet; then
            echo "no changes to integrate from ${BRANCH} (agent branch is identical to ${INTEGRATION})"
            MERGE_OK=1
          else
            HAS_CHANGES=1
            git commit -m "integrate ${BRANCH}" >/dev/null
            MERGE_OK=1
          fi
        else
          CONFLICT_FILES="$(git diff --name-only --diff-filter=U || true)"
          DIFFSTAT="$(git diff --stat HEAD || true)"
          # --squash doesn't track MERGE_HEAD, so `merge --abort` is a no-op
          # here; reset hard to drop the conflicted working tree + index.
          git reset --hard HEAD >/dev/null 2>&1 || true
        fi

        if [ "$MERGE_OK" = "1" ] && [ "$HAS_CHANGES" = "1" ]; then
          if ! git push "$INT_PUSH_TARGET" "HEAD:refs/heads/${INTEGRATION}"; then
            echo "warning: ${INTEGRATION} push to ${INT_PUSH_TARGET} failed" >&2
            # Treat push failure (e.g. SOURCE_REPO currently has integration
            # checked out → denyCurrentBranch, or origin/integration moved
            # under us in a concurrent run) like a conflict so the operator is
            # notified rather than silently losing the merge.
            MERGE_OK=0
            CONFLICT_FILES=""
            DIFFSTAT="(push to ${INT_PUSH_TARGET}'s ${INTEGRATION} refused; the destination may currently have ${INTEGRATION} checked out, or it moved under us)"
          fi
        fi

        # Restore the workspace HEAD on the agent branch so any later inspection
        # (or before_remove hook) finds a sensible checkout.
        git checkout "$BRANCH" >/dev/null 2>&1 || true

        if [ "$MERGE_OK" = "1" ]; then
          echo "integrated ${BRANCH} into ${INTEGRATION} on ${INT_PUSH_TARGET}"
          exit 0
        fi

        # 3) Conflict — re-route the issue file from Done/ to Conflict/ and
        # append the diff context to the body so the operator can see what
        # conflicted without re-running the merge by hand. The orchestrator
        # already moved the file to Done/<id>.md as part of the terminal
        # transition; we move it sideways here.
        echo "integration merge failed for ${BRANCH}; routing issue to Conflict/" >&2
        if [ -z "${SYMPHONY_TRACKER_ROOT:-}" ]; then
          echo "warning: SYMPHONY_TRACKER_ROOT unset; leaving issue in Done/" >&2
          exit 0
        fi
        mkdir -p "${SYMPHONY_TRACKER_ROOT}/Conflict"
        SRC="${SYMPHONY_TRACKER_ROOT}/Done/${ISSUE_ID}.md"
        DST="${SYMPHONY_TRACKER_ROOT}/Conflict/${ISSUE_ID}.md"
        if [ -f "$SRC" ]; then
          mv "$SRC" "$DST"
        fi
        if [ -f "$DST" ]; then
          {
            echo ""
            echo "## Integration merge conflict"
            echo ""
            echo "Merging \`${BRANCH}\` into \`${INTEGRATION}\` failed on ${INT_PUSH_TARGET}."
            if [ -n "$CONFLICT_FILES" ]; then
              echo ""
              echo "Conflicted files:"
              echo '```'
              echo "$CONFLICT_FILES"
              echo '```'
            fi
            if [ -n "$DIFFSTAT" ]; then
              echo ""
              echo "Diff stat (${BRANCH} vs ${INTEGRATION}):"
              echo '```'
              echo "$DIFFSTAT"
              echo '```'
            fi
          } >> "$DST"
        fi
  Cancelled:
    role: terminal
    # Cancelled means the work was abandoned; no patch, no PR. The workspace is
    # cleaned up after the run unwinds and the commits are discarded with it.
  Conflict:
    # Holding state for issues whose Done-state integration merge failed. The
    # orchestrator does NOT dispatch from here; the operator inspects the
    # appended diff context in the issue body, resolves the conflict manually
    # (rebasing the per-issue branch against integration, or dropping the
    # integration merge if the PR was already closed), and routes the issue
    # back into the active queue or to Cancelled from the dashboard.
    role: holding
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
  # history on the shared integration branch, plus a per-issue branch checked
  # out. All network remotes are stripped so any `git push`/`git fetch` from
  # inside the VM fails closed.
  #
  # Branching off integration (not BASE) is the agent-throughput fix: in-flight
  # agents see work from peers whose PRs against main are still open for review.
  # On first run after switching to this flow, integration is seeded from BASE.
  # See AGENTS.md for the `main → integration` reconciliation ritual that keeps
  # integration from drifting too far from main.
  after_create: |
    set -eu
    SOURCE_REPO="${SYMPHONY_SOURCE_REPO:-${PWD}/../../..}"
    BASE="${SYMPHONY_BASE_BRANCH:-main}"
    INTEGRATION="${SYMPHONY_INTEGRATION_BRANCH:-integration}"
    ISSUE_ID="$(basename "$PWD")"
    BRANCH="agent/${ISSUE_ID}"

    if [ ! -d "${SOURCE_REPO}/.git" ]; then
      echo "after_create: SOURCE_REPO=${SOURCE_REPO} is not a git repo" >&2
      exit 1
    fi

    # Ensure SOURCE_REPO has an integration branch. This is the authoritative
    # integration in local-only mode, and the seed used by the remote-mode block
    # below when origin doesn't carry integration yet.
    if ! git -C "${SOURCE_REPO}" rev-parse --verify "refs/heads/${INTEGRATION}" >/dev/null 2>&1; then
      echo "creating ${INTEGRATION} from ${BASE} on source repo (first run)"
      git -C "${SOURCE_REPO}" branch "${INTEGRATION}" "${BASE}"
    fi

    # `git clone --local` hardlinks .git/objects when possible; fast and disk-cheap.
    # `--no-tags` keeps the local refspec minimal; `--branch` lands on integration.
    git clone --local --no-tags --branch "${INTEGRATION}" "${SOURCE_REPO}" .

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
      # Sync local integration with origin's view if it exists; otherwise seed
      # origin from the local copy we just cloned (push without --force; this
      # only succeeds on a non-existent or already-ancestor remote ref).
      if git fetch --no-tags origin "${INTEGRATION}:refs/remotes/origin/${INTEGRATION}" 2>/dev/null; then
        git checkout "${INTEGRATION}"
        git reset --hard "refs/remotes/origin/${INTEGRATION}"
      else
        git push origin "refs/heads/${INTEGRATION}:refs/heads/${INTEGRATION}" || true
      fi
    fi

    git config --local user.name  "symphony-agent"
    git config --local user.email "agent@symphony.local"

    git checkout -b "${BRANCH}"

    echo "workspace ready: base=${BASE} integration=${INTEGRATION} branch=${BRANCH} source=${SOURCE_REPO}"

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
