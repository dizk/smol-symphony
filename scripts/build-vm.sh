#!/usr/bin/env bash
# Build the per-issue smolvm VM image used by symphony.
#
# Result: ./.vm/symphony.smolmachine + .smolmachine asset bundle.
# Inside: node:20-alpine + git, bash, ripgrep, curl, ca-certificates + the codex and
# claude CLIs installed globally via npm.
#
# This script is idempotent — it deletes any prior template VM and rebuilds the artifact.

set -euo pipefail

VM_NAME="${VM_NAME:-symphony-template}"
OUT_DIR="${OUT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/.vm}"
OUT_FILE="${OUT_FILE:-$OUT_DIR/symphony.smolmachine}"
CPUS="${CPUS:-2}"
MEM_MIB="${MEM_MIB:-4096}"
BASE_IMAGE="${BASE_IMAGE:-node:20-alpine}"
CODEX_PKG="${CODEX_PKG:-@openai/codex}"
CLAUDE_PKG="${CLAUDE_PKG:-@anthropic-ai/claude-code}"

mkdir -p "$OUT_DIR"

log() { printf '\033[1;36m[build-vm]\033[0m %s\n' "$*" >&2; }

# Reset any prior template VM. Running VMs cannot be packed.
log "removing any previous template VM '$VM_NAME'"
if smolvm machine ls --json 2>/dev/null | grep -q "\"name\":\"$VM_NAME\""; then
  smolvm machine stop --name "$VM_NAME" >/dev/null 2>&1 || true
  smolvm machine delete "$VM_NAME" -f >/dev/null
fi

log "creating template VM (base=$BASE_IMAGE)"
smolvm machine create "$VM_NAME" --image "$BASE_IMAGE" --cpus "$CPUS" --mem "$MEM_MIB" --net >/dev/null
smolvm machine start --name "$VM_NAME" >/dev/null

# `smolvm machine exec --stream` rejects absolute paths in PATH lookup on this build, so
# we always invoke npm via its absolute path (it lives at /usr/local/bin/npm in the
# node:20-alpine image).
log "installing alpine packages (bash, git, ripgrep, curl, ca-certificates)"
smolvm machine exec --name "$VM_NAME" -- /sbin/apk add --no-cache bash git ripgrep curl ca-certificates >/dev/null

log "installing $CODEX_PKG"
smolvm machine exec --name "$VM_NAME" -- /usr/local/bin/npm install -g "$CODEX_PKG" >&2

log "installing $CLAUDE_PKG"
smolvm machine exec --name "$VM_NAME" -- /usr/local/bin/npm install -g "$CLAUDE_PKG" >&2

log "verifying versions inside VM"
smolvm machine exec --name "$VM_NAME" -- sh -c 'codex --version && claude --version' >&2

log "stopping template VM"
smolvm machine stop --name "$VM_NAME" >/dev/null

log "packing -> $OUT_FILE"
smolvm pack create --from-vm "$VM_NAME" -o "$OUT_FILE" --cpus "$CPUS" --mem "$MEM_MIB" >&2

log "cleaning up template VM"
smolvm machine delete "$VM_NAME" -f >/dev/null

log "done: $OUT_FILE"
ls -lh "$OUT_FILE" "$OUT_FILE.smolmachine" 2>/dev/null >&2 || true
