#!/usr/bin/env bash
# symphony after_create hook.
#
# Runs once on the host when a per-issue workspace directory is first created,
# before the first dispatch. CWD is the workspace path
# (`<workspace.root>/<issue-id>/`). The agent has no network credentials inside
# the VM, so this hook prepares a working clone of the source repo with the
# correct base + per-issue branch checked out, and strips any remote that would
# let an in-VM `git push`/`fetch` reach the network.

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
