---
# WORKFLOW.md — symphony dispatched against smol-symphony itself.
#
# Run with:
#
#   npx symphony WORKFLOW.md
#
# Defaults assume a fully local setup: the per-issue workspace clones from this
# repo's `.git` directory, the agent has no network credentials, and on
# mark_done the host writes a `git format-patch` bundle to
# `.symphony/patches/<branch>.patch` for human review.
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

tracker:
  kind: local
  root: ./issues
  active_states:
    - Todo
    - In Progress
  terminal_states:
    - Done
    - Cancelled

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

  # Runs after every attempt. Gated on the issue file being in Done/ (i.e. the
  # agent has called symphony.mark_done). Two outputs:
  #   - If SYMPHONY_REPO is set: push branch + open (or update) a PR via gh.
  #   - Else (local-only mode): write the agent's work as a git format-patch
  #     bundle into ./.symphony/patches/<branch>.patch for human review.
  after_run: |
    set -eu
    BASE="${SYMPHONY_BASE_BRANCH:-main}"
    ISSUE_ID="$(basename "$PWD")"
    BRANCH="agent/${ISSUE_ID}"
    TRACKER_ROOT="${SYMPHONY_TRACKER_ROOT:-$PWD/../../../issues}"
    PATCHES_DIR="${SYMPHONY_PATCHES_DIR:-$PWD/../../../.symphony/patches}"

    if [ ! -f "${TRACKER_ROOT}/Done/${ISSUE_ID}.md" ]; then
      echo "issue ${ISSUE_ID} not in Done/ yet; skipping handoff"
      exit 0
    fi
    # ALWAYS preserve mark_done.md early — before any other exit-0 path — so analytical
    # issues that produce no commits still leave a durable record of the agent's reasoning
    # outside the per-issue workspace (which is destroyed on terminal cleanup).
    MARKDONE=""
    if [ -f .git/symphony-runtime/mark_done.md ]; then
      MARKDONE=.git/symphony-runtime/mark_done.md
    elif [ -f .symphony-runtime/mark_done.md ]; then
      MARKDONE=.symphony-runtime/mark_done.md
    fi
    if [ -n "${MARKDONE}" ]; then
      NOTES_DIR="${SYMPHONY_NOTES_DIR:-$PWD/../../../.symphony/notes}"
      mkdir -p "${NOTES_DIR}"
      cp "${MARKDONE}" "${NOTES_DIR}/${ISSUE_ID}.md"
      echo "preserved mark_done.md at ${NOTES_DIR}/${ISSUE_ID}.md"
      TITLE="$(sed -n '1 s/^# //p' "${MARKDONE}")"
      BODY="$(tail -n +3 "${MARKDONE}")"
    else
      TITLE="${ISSUE_ID}"
      BODY="Symphony run for ${ISSUE_ID}."
    fi

    if ! git rev-parse --verify "${BRANCH}" >/dev/null 2>&1; then
      echo "no branch ${BRANCH}; nothing to hand off"
      exit 0
    fi

    # Resolve the ref the agent diverged from. In remote mode origin/${BASE}
    # exists (after_create's `git fetch`). In local-only mode we kept the local
    # ${BASE} branch alive (`git clone --branch ${BASE}` creates it at the
    # original tip; `git checkout -b ${BRANCH}` does not remove it). That tip
    # is exactly where the agent diverged from.
    if git rev-parse --verify "origin/${BASE}" >/dev/null 2>&1; then
      MERGE_BASE="origin/${BASE}"
    elif git rev-parse --verify "${BASE}" >/dev/null 2>&1; then
      MERGE_BASE="${BASE}"
    else
      echo "could not resolve merge base (no origin/${BASE} or local ${BASE})" >&2
      exit 1
    fi

    if [ -z "$(git log --oneline "${MERGE_BASE}..${BRANCH}" 2>/dev/null)" ]; then
      echo "no new commits on ${BRANCH}; nothing to hand off (diagnosis at .symphony/notes/${ISSUE_ID}.md)"
      exit 0
    fi

    # Always materialize a patch bundle BEFORE attempting the remote push. This is the
    # robust artifact: if anything in the gh/origin chain fails — missing origin remote
    # because an older after_create ran without SYMPHONY_REPO set, a network blip, a gh
    # auth glitch — the agent's work survives at .symphony/patches/<branch>.patch and can
    # be replayed by hand. The push + PR path below is best-effort on top.
    mkdir -p "${PATCHES_DIR}"
    PATCH_OUT="${PATCHES_DIR}/$(echo "${BRANCH}" | tr '/' '_').patch"
    git format-patch --stdout "${MERGE_BASE}..${BRANCH}" > "${PATCH_OUT}"
    echo "wrote patch bundle: ${PATCH_OUT}"

    if [ -n "${SYMPHONY_REPO:-}" ]; then
      # Remote PR mode. Be defensive about origin: an earlier workspace creation may have
      # happened with SYMPHONY_REPO unset (after_create's remote-add branch was skipped),
      # leaving the workspace without an origin remote even though we're now in PR mode.
      # Re-create it idempotently before pushing.
      if ! git remote get-url origin >/dev/null 2>&1; then
        echo "after_run: origin remote missing; re-adding"
        git remote add origin "https://github.com/${SYMPHONY_REPO}.git"
        gh auth setup-git 2>/dev/null || true
      fi
      # Push + PR. On failure we leave the patch bundle (above) in place as the canonical
      # record; operators can `gh pr create` from it manually.
      if git push -u origin "${BRANCH}"; then
        if gh pr view "${BRANCH}" >/dev/null 2>&1; then
          echo "PR already exists for ${BRANCH}; pushed updates"
        elif ! gh pr create \
          --base "${BASE}" \
          --head "${BRANCH}" \
          --title "${ISSUE_ID}: ${TITLE}" \
          --body "${BODY}"; then
          echo "gh pr create failed; patch bundle preserved at ${PATCH_OUT}" >&2
        fi
      else
        echo "git push failed; patch bundle preserved at ${PATCH_OUT}" >&2
      fi
    else
      # Local-only mode: the patch bundle above is the canonical output.
      echo "  apply with:  git -C <target-repo> am ${PATCH_OUT}"
    fi

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
  # auto-derived acp.command. The tracker is reached only through the symphony
  # MCP server.
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
  have network credentials; pushing is the host's job, after you mark done.

Workflow:

1. Read enough of the codebase to understand the change you need to make.
2. Make the smallest correct change. Add or update tests where the change is
   testable. Run `npm run typecheck` and `npm test`; both must pass.
3. Commit your work to the per-issue branch with a short message.
4. Call `symphony.mark_done({ title, summary })`:
   - `title`: a single line in imperative voice, ≤72 chars. Becomes the
     PR/commit title.
   - `summary`: a one- to three-paragraph narrative of what you did and why,
     plus any follow-ups you noticed but didn't do. Becomes the PR body.
   This is the only way to signal completion; nothing else will move the issue
   out of an active state.

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

{% if attempt -%}
This is continuation/retry attempt {{ attempt }}. Inspect the workspace before
making new edits; your previous run may have left commits on the branch. Check
`git log agent/{{ issue.identifier }}` to see what's there. If the work is
already complete, call `symphony.mark_done` with an appropriate title and
summary and stop.
{%- endif %}
