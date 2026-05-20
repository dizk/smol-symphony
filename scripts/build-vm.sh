#!/usr/bin/env bash
# Build the per-issue smolvm VM image used by symphony.
#
# Result: ./.vm/symphony.smolmachine + .smolmachine asset bundle.
# Inside: node:24-bookworm-slim + git/ripgrep + the three ACP-capable coding agents:
#   * codex (musl + glibc) and @zed-industries/codex-acp (glibc-only prebuilt)
#   * claude-agent-acp (pure JS adapter for Claude Code)
#   * opencode-ai (ships an ACP server: `opencode acp`)
#
# Plus the symphony-vm-agent stdio proxy at /opt/symphony/vm-agent.mjs (see vm-agent.js).
#
# We use a debian (glibc) base so the glibc-linked codex-acp prebuilt works. Alpine almost
# works but its musl loader rejects codex-acp's prebuilt binary. Node 24 is the current
# stable line; node 20 worked but is the previous LTS and lacks recent stream/perf fixes.

set -euo pipefail

VM_NAME="${VM_NAME:-symphony-template}"
OUT_DIR="${OUT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/.vm}"
OUT_FILE="${OUT_FILE:-$OUT_DIR/symphony.smolmachine}"
CPUS="${CPUS:-2}"
MEM_MIB="${MEM_MIB:-4096}"
BASE_IMAGE="${BASE_IMAGE:-node:24-bookworm-slim}"

mkdir -p "$OUT_DIR"

log() { printf '\033[1;36m[build-vm]\033[0m %s\n' "$*" >&2; }

log "removing any previous template VM '$VM_NAME'"
if smolvm machine ls --json 2>/dev/null | grep -q "\"name\":\"$VM_NAME\""; then
  smolvm machine stop --name "$VM_NAME" >/dev/null 2>&1 || true
  smolvm machine delete "$VM_NAME" -f >/dev/null
fi

log "creating template VM (base=$BASE_IMAGE)"
smolvm machine create "$VM_NAME" --image "$BASE_IMAGE" --cpus "$CPUS" --mem "$MEM_MIB" --net >/dev/null
smolvm machine start --name "$VM_NAME" >/dev/null

log "installing system packages"
smolvm machine exec --name "$VM_NAME" -- /usr/bin/apt-get update >/dev/null
smolvm machine exec --name "$VM_NAME" -- /usr/bin/apt-get install -y --no-install-recommends git ripgrep ca-certificates curl >/dev/null

log "installing ACP-capable coding agents via npm"
smolvm machine exec --name "$VM_NAME" -- /usr/local/bin/npm install -g \
  @openai/codex \
  @anthropic-ai/claude-code \
  @agentclientprotocol/claude-agent-acp \
  @zed-industries/codex-acp \
  opencode-ai >&2

log "installing symphony-vm-agent (stdio bridge to ACP adapters)"
# Pipe the bridge script into the VM. We host this under /opt/symphony so future in-VM
# helpers (frame-level logging, an in-guest MCP server, etc.) live in the same tree.
smolvm machine exec --name "$VM_NAME" -i -- bash -lc 'mkdir -p /opt/symphony && cat > /opt/symphony/vm-agent.mjs && chmod 0644 /opt/symphony/vm-agent.mjs' < "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/vm-agent.js"

log "verifying agents inside VM"
smolvm machine exec --name "$VM_NAME" -- bash -lc '
  set -e
  which codex claude claude-agent-acp codex-acp opencode
  codex --version
  claude --version
  opencode --version
  # Smoke-test the proxy: missing required env should produce a clean usage error
  # (exit code 2, "SYMPHONY_ACP_URL is not set"). This proves the file is installed,
  # valid as ESM, and runs through its startup arg parsing. A full TCP round-trip is
  # exercised end-to-end by the orchestrator on the first dispatch.
  test -f /opt/symphony/vm-agent.mjs || { echo "vm-agent.mjs missing"; exit 1; }
  if node /opt/symphony/vm-agent.mjs 2>/tmp/vma-err; then
    echo "vm-agent unexpectedly exited 0 without required env"; exit 1
  fi
  grep -q "SYMPHONY_ACP_URL is not set" /tmp/vma-err || {
    echo "vm-agent smoke produced unexpected output:"; cat /tmp/vma-err; exit 1;
  }
  echo "vm-agent.mjs ok"
' >&2

log "stopping template VM"
smolvm machine stop --name "$VM_NAME" >/dev/null

log "packing -> $OUT_FILE"
smolvm pack create --from-vm "$VM_NAME" -o "$OUT_FILE" --cpus "$CPUS" --mem "$MEM_MIB" >&2

log "cleaning up template VM"
smolvm machine delete "$VM_NAME" -f >/dev/null

log "done: $OUT_FILE.smolmachine"
ls -lh "$OUT_FILE" "$OUT_FILE.smolmachine" 2>/dev/null >&2 || true
