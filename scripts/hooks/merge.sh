#!/usr/bin/env bash
# symphony Merge-state handoff.
#
# Invoked by after-run.sh when the issue lands in the `Merge` terminal state
# AND a PR has been opened on the host repo. Decides whether to enable GitHub
# auto-merge for that PR.
#
# Rule: if the agent touched `WORKFLOW.md` on the per-issue branch, leave the
# PR open for human review. Any change to the workflow that drives symphony's
# own dispatch loop is a meta-change worth a human's eyes before it lands on
# the base branch. If WORKFLOW.md is untouched, run `gh pr merge --auto` so
# GitHub merges the PR as soon as required checks pass.
#
# Args:
#   $1 — base branch (used to resolve the merge base for the diff check).
#   $2 — agent branch name.

set -eu

BASE="${1:?merge.sh: base branch required}"
BRANCH="${2:?merge.sh: branch name required}"

if [ -z "${SYMPHONY_REPO:-}" ]; then
  echo "merge.sh: SYMPHONY_REPO not set; nothing to auto-merge"
  exit 0
fi

# Resolve the diff base the same way after-run.sh does, so the file list
# matches what the PR actually contains.
if git rev-parse --verify "origin/${BASE}" >/dev/null 2>&1; then
  MERGE_BASE="origin/${BASE}"
elif git rev-parse --verify "${BASE}" >/dev/null 2>&1; then
  MERGE_BASE="${BASE}"
else
  echo "merge.sh: cannot resolve merge base (no origin/${BASE} or local ${BASE}); skipping" >&2
  exit 0
fi

# `git diff --name-only` lists every file changed on the branch. `grep -Fxq`
# matches the literal path WORKFLOW.md at the repo root only; a nested
# WORKFLOW.md elsewhere in the tree would not trigger the gate.
if git diff --name-only "${MERGE_BASE}..${BRANCH}" | grep -Fxq "WORKFLOW.md"; then
  echo "merge.sh: WORKFLOW.md was modified on ${BRANCH}; leaving PR for human review"
  exit 0
fi

# Untouched WORKFLOW.md → opt the PR into GitHub auto-merge. `--auto` requires
# the host repo to have auto-merge enabled in its settings (and typically a
# branch-protection rule with required checks). If gh refuses (auto-merge not
# enabled, no required checks, etc.) we surface the error and leave the PR
# open — after-run.sh already opened it, so a human can merge manually.
if gh pr merge "${BRANCH}" --auto --merge; then
  echo "merge.sh: enabled auto-merge for ${BRANCH}"
else
  echo "merge.sh: gh pr merge --auto failed; PR ${BRANCH} left open for human review" >&2
fi
