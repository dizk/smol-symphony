#!/usr/bin/env bash
# symphony after_run hook.
#
# Runs after every turn, on the host, with cwd set to the per-issue workspace.
# Gated on the issue file landing in a terminal-state directory in the tracker
# root: until that happens the hook returns cleanly and writes no artifacts.
#
# Two output modes once the issue terminates:
#   - If SYMPHONY_REPO is set: push the branch and open (or update) a GitHub PR
#     via `gh`. When the terminal state is `Merge`, additionally delegate to
#     `merge.sh` to decide on `gh pr merge --auto`.
#   - Else (local-only): write the agent's commits as a git format-patch bundle
#     into ./.symphony/patches/<branch>.patch.
#
# A patch bundle is always materialized BEFORE the push attempt so the agent's
# work survives any failure in the gh/origin chain.

set -eu

SOURCE_REPO="${SYMPHONY_SOURCE_REPO:-${PWD}/../../..}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BASE="${SYMPHONY_BASE_BRANCH:-main}"
ISSUE_ID="$(basename "$PWD")"
BRANCH="agent/${ISSUE_ID}"
TRACKER_ROOT="${SYMPHONY_TRACKER_ROOT:-$HOME/.symphony/trackers/smol-symphony}"
PATCHES_DIR="${SYMPHONY_PATCHES_DIR:-${SOURCE_REPO}/.symphony/patches}"
# Terminal-state set. Keep in sync with WORKFLOW.md's role:terminal entries;
# the orchestrator does not currently expose declared terminal states to the
# hook environment.
TERMINAL_STATES="${SYMPHONY_TERMINAL_STATES:-Merge Cancelled}"

# Walk the configured terminal-state directories and see if the issue file has
# landed in any of them. If not, this is a non-terminal turn (still in Todo,
# handed off to Review, etc.) — nothing to hand off yet.
FOUND_TERMINAL=""
ISSUE_FILE=""
for st in ${TERMINAL_STATES}; do
  if [ -f "${TRACKER_ROOT}/${st}/${ISSUE_ID}.md" ]; then
    FOUND_TERMINAL="${st}"
    ISSUE_FILE="${TRACKER_ROOT}/${st}/${ISSUE_ID}.md"
    break
  fi
done
if [ -z "${FOUND_TERMINAL}" ]; then
  echo "issue ${ISSUE_ID} not in a terminal state yet (checked: ${TERMINAL_STATES}); skipping handoff"
  exit 0
fi
echo "issue ${ISSUE_ID} reached terminal state ${FOUND_TERMINAL}; running handoff"

# Pull PR title + body straight from the terminal-state issue file. The
# `symphony.transition` tool appends every hop's notes to the issue body before
# each move, so the file in FOUND_TERMINAL carries the full thread.
RAW_TITLE="$(awk '
  BEGIN { in_fm = 0 }
  NR == 1 && /^---[[:space:]]*$/ { in_fm = 1; next }
  in_fm && /^---[[:space:]]*$/ { exit }
  in_fm && /^title:[[:space:]]*/ {
    sub(/^title:[[:space:]]*/, "")
    # Strip optional surrounding quotes (single or double).
    gsub(/^["'\'']|["'\'']$/, "")
    print
    exit
  }
' "${ISSUE_FILE}")"
if [ -n "${RAW_TITLE}" ]; then
  TITLE="${RAW_TITLE}"
else
  TITLE=""
fi
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

# Resolve the ref the agent diverged from. In remote mode origin/${BASE} exists
# (after_create's `git fetch`). In local-only mode we kept the local ${BASE}
# branch alive (`git clone --branch ${BASE}` creates it at the original tip;
# `git checkout -b ${BRANCH}` does not remove it).
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

# Always materialize a patch bundle BEFORE attempting the remote push. This is
# the robust artifact: if anything in the gh/origin chain fails — missing
# origin remote, a network blip, a gh auth glitch — the agent's work survives
# at .symphony/patches/<branch>.patch and can be replayed by hand.
mkdir -p "${PATCHES_DIR}"
PATCH_OUT="${PATCHES_DIR}/$(echo "${BRANCH}" | tr '/' '_').patch"
git format-patch --stdout "${MERGE_BASE}..${BRANCH}" > "${PATCH_OUT}"
echo "wrote patch bundle: ${PATCH_OUT}"

if [ -n "${SYMPHONY_REPO:-}" ]; then
  # Remote PR mode. Be defensive about origin: an earlier workspace creation
  # may have happened with SYMPHONY_REPO unset (after_create's remote-add
  # branch was skipped), leaving the workspace without an origin remote even
  # though we're now in PR mode. Re-create it idempotently before pushing.
  if ! git remote get-url origin >/dev/null 2>&1; then
    echo "after_run: origin remote missing; re-adding"
    git remote add origin "https://github.com/${SYMPHONY_REPO}.git"
    gh auth setup-git 2>/dev/null || true
  fi
  # Push + PR. On failure we leave the patch bundle (above) in place as the
  # canonical record; operators can `gh pr create` from it manually.
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
    # Merge-state handoff: delegate the auto-merge decision to merge.sh. The
    # script enables `gh pr merge --auto` iff the branch did not touch
    # WORKFLOW.md (any change to the agent's own workflow stays human-gated).
    if [ "${FOUND_TERMINAL}" = "Merge" ]; then
      bash "${SCRIPT_DIR}/merge.sh" "${BASE}" "${BRANCH}"
    fi
  else
    echo "git push failed; patch bundle preserved at ${PATCH_OUT}" >&2
  fi
else
  # Local-only mode: the patch bundle above is the canonical output.
  echo "  apply with:  git -C <target-repo> am ${PATCH_OUT}"
fi
