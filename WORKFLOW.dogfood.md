---
# WORKFLOW.dogfood.md — symphony dispatched against smol-symphony itself.
#
# Run alongside the demo workflow:
#
#   npx symphony WORKFLOW.dogfood.md
#
# Or, with the HTTP dashboard:
#
#   npx symphony WORKFLOW.dogfood.md --port 8788
#
# Defaults assume a fully local setup: the workspace clones from this repo's `.git`
# directory, the agent has no network credentials, and on mark_done the host produces
# a `git format-patch` bundle in `.symphony/dogfood-patches/<branch>.patch` for review.
#
# To opt into the remote PR flow once this repo has a GitHub remote, export before
# launching symphony:
#
#   SYMPHONY_REPO=owner/smol-symphony \
#   SYMPHONY_BASE_BRANCH=main \
#   npx symphony WORKFLOW.dogfood.md
#
# `gh` on the host must be authenticated (`gh auth status` clean). The token never
# enters the VM.

tracker:
  kind: local
  root: ./issues-dogfood
  active_states:
    - Todo
    - In Progress
  terminal_states:
    - Done
    - Cancelled

polling:
  interval_ms: 5000

workspace:
  # Separate from the demo's ./.symphony/workspaces so both workflows can run side
  # by side without colliding on directory names.
  root: ./.symphony/dogfood-workspaces

hooks:
  timeout_ms: 120000

  # Clone smol-symphony into the fresh per-issue workspace using a strictly local
  # source (no creds needed). The agent receives a working git repo with full
  # history on the configured base branch, plus a per-issue branch checked out.
  # All network remotes are stripped so any `git push`/`git fetch` from inside the
  # VM fails closed.
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

    # `git clone --local` hardlinks .git/objects when possible — fast and disk-cheap.
    # `--no-tags` keeps the local refspec minimal; `--branch` lands on the right base.
    git clone --local --no-tags --branch "${BASE}" "${SOURCE_REPO}" .

    # Strip all remotes. The agent will see no network targets at all.
    for remote in $(git remote); do
      git remote remove "${remote}"
    done
    git config --local --unset credential.helper 2>/dev/null || true

    # If SYMPHONY_REPO is set, restore an `origin` pointing at the GitHub remote so
    # the after_run hook can push. The URL is the canonical HTTPS form (no token).
    if [ -n "${SYMPHONY_REPO:-}" ]; then
      git remote add origin "https://github.com/${SYMPHONY_REPO}.git"
      # Pre-fetch base so `origin/${BASE}` exists for ahead-of-base checks later.
      # Uses the host's `gh` auth — token still never touches the VM.
      gh auth setup-git 2>/dev/null || true
      git fetch --no-tags origin "${BASE}:refs/remotes/origin/${BASE}" || true
    fi

    git config --local user.name  "symphony-agent"
    git config --local user.email "agent@symphony.local"

    git checkout -b "${BRANCH}"

    echo "dogfood workspace ready: base=${BASE} branch=${BRANCH} source=${SOURCE_REPO}"

  # Runs after every attempt. Gated on the issue file being in Done/ — i.e. the
  # agent has called symphony.mark_done. Two outputs:
  #   - If SYMPHONY_REPO is set: push branch + open (or update) a PR via gh.
  #   - Else (local-only mode): write the agent's work as a git format-patch bundle
  #     into ./.symphony/dogfood-patches/<branch>.patch for human review.
  after_run: |
    set -eu
    BASE="${SYMPHONY_BASE_BRANCH:-main}"
    ISSUE_ID="$(basename "$PWD")"
    BRANCH="agent/${ISSUE_ID}"
    TRACKER_ROOT="${SYMPHONY_TRACKER_ROOT:-$PWD/../../../issues-dogfood}"
    PATCHES_DIR="${SYMPHONY_PATCHES_DIR:-$PWD/../../../.symphony/dogfood-patches}"

    if [ ! -f "${TRACKER_ROOT}/Done/${ISSUE_ID}.md" ]; then
      echo "issue ${ISSUE_ID} not in Done/ yet; skipping handoff"
      exit 0
    fi
    if ! git rev-parse --verify "${BRANCH}" >/dev/null 2>&1; then
      echo "no branch ${BRANCH}; nothing to hand off"
      exit 0
    fi

    # Resolve the ref the agent diverged from. In remote mode origin/${BASE}
    # exists (after_create's `git fetch`). In local-only mode we kept the local
    # ${BASE} branch alive — `git clone --branch ${BASE}` creates it at the
    # original tip and `git checkout -b ${BRANCH}` does not remove it. That tip
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
      echo "no new commits on ${BRANCH}; nothing to hand off"
      exit 0
    fi

    if [ -n "${SYMPHONY_REPO:-}" ]; then
      # Remote PR mode.
      git push -u origin "${BRANCH}"
      if gh pr view "${BRANCH}" >/dev/null 2>&1; then
        echo "PR already exists for ${BRANCH}; pushed updates"
      else
        TITLE="$(head -n1 RESULT.md 2>/dev/null || echo "${ISSUE_ID}")"
        gh pr create \
          --base "${BASE}" \
          --head "${BRANCH}" \
          --title "${ISSUE_ID}: ${TITLE}" \
          --body "Symphony dogfood run for ${ISSUE_ID}. See RESULT.md."
      fi
    else
      # Local-only mode: bundle the diff for human review.
      mkdir -p "${PATCHES_DIR}"
      OUT="${PATCHES_DIR}/$(echo "${BRANCH}" | tr '/' '_').patch"
      git format-patch --stdout "${MERGE_BASE}..${BRANCH}" > "${OUT}"
      echo "wrote patch bundle: ${OUT}"
      echo "  apply with:  git -C <target-repo> am ${OUT}"
    fi

agent:
  # Tighter budget while we're still learning what the agent does inside this repo.
  max_concurrent_agents: 1
  max_turns: 6
  max_retry_backoff_ms: 120000

acp:
  # Selecting "claude" is enough: symphony reads ~/.claude/.credentials.json on the
  # host, stages a copy into .symphony-runtime/credentials/claude in the workspace,
  # and auto-generates a launch command that places the file at the adapter's
  # expected path inside the VM before exec'ing claude-agent-acp. No bash glue
  # needed in the workflow. Set `command:` only to override (e.g. testing a forked
  # adapter or a non-default binary path).
  adapter: claude
  shell: bash
  prompt_timeout_ms: 1800000
  read_timeout_ms: 30000
  stall_timeout_ms: 300000

smolvm:
  from: ./.vm/symphony.smolmachine.smolmachine
  cpus: 2
  mem_mib: 4096
  net: true
  # No volume mounts. The workspace is auto-mounted by the runner; that's all the
  # agent needs. Credentials are staged into the workspace by before_run and
  # copied into ~/.claude by the acp.command above. The tracker is reached
  # exclusively through the symphony MCP server.
  volumes: []
  forward_env:
    - OPENAI_API_KEY
    - ANTHROPIC_API_KEY

server:
  # Distinct port so the demo workflow on 8787 and this dogfood workflow can run
  # concurrently without colliding.
  port: 8788
  host: 0.0.0.0

mcp:
  # In smolvm, the VM's loopback transparently reaches the host's loopback —
  # confirmed empirically: `curl http://127.0.0.1:HOSTPORT/` from inside the VM
  # hits the host's listener. The URL is built at runtime as
  # `http://<host>:<bound-port>/api/v1/issues/<id>/mcp`. Default `host` is
  # 127.0.0.1; override only if your VMM has a different host alias.
  host: 127.0.0.1
---
You are working on **smol-symphony**, a TypeScript orchestrator that dispatches
coding agents into per-issue smolvm microVMs and talks to them over the Agent
Client Protocol (ACP). This repo contains its own source. Your workspace is a
fresh clone of it.

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
  `PRODUCT.md` if you haven't seen them. `SPEC.md` is the long-form design spec.
  `CLAUDE.md` (if present) has any standing instructions for working in this repo.
- Source lives under `src/`. Tests live under `tests/`. Run `npm test` and
  `npm run typecheck` before declaring work done.
- You are on a per-issue branch (`agent/{{ issue.identifier }}`) checked out from
  the configured base branch. Commit your work locally. You do **not** have
  network credentials — pushing is the host's job, after you mark the issue done.

Workflow:

1. Read enough of the codebase to understand the change you need to make.
2. Make the smallest correct change. Add or update tests where the change is
   testable. Run `npm run typecheck` and `npm test`; both must pass.
3. Commit your work to the per-issue branch with a short, conventional message.
4. Write a one- to three-paragraph summary of what you did into `RESULT.md` in
   the workspace root. Mention any follow-ups you noticed but didn't do.
5. Call `symphony.mark_done({ summary })` with a one-line summary. This is the
   only way to signal completion; nothing else will move the issue out of an
   active state.

If you genuinely cannot proceed — ambiguous requirements, missing context that
only a human can supply, a design decision that needs human input — call
`symphony.request_human_steering({ question, context })` instead of guessing.
Your turn will end immediately and the human's response will arrive as your
next prompt.

{% if attempt -%}
This is continuation/retry attempt {{ attempt }}. Inspect the workspace before
making new edits — your previous run may have left commits on the branch and
a partial RESULT.md. If the work is already complete, call
`symphony.mark_done` with a summary derived from RESULT.md and stop.
{%- endif %}
