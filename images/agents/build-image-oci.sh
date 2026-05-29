#!/usr/bin/env bash
# Build the Symphony agent rootfs image for the Gondolin VM substrate.
#
# Replaces the old per-issue smolvm bake/pack pipeline: build ONCE here, then the
# runner boots the resulting image by tag/digest. Two steps:
#   1. docker build a node:24-bookworm-slim image with all agent CLIs baked in
#      (glibc → opencode installs cleanly, unlike the Alpine/musl path).
#   2. gondolin build with oci.image pointing at that image (no in-chroot postBuild,
#      so no root needed), tagging symphony-agents:<tag>.
#
# Usage:  bash images/agents/build-image-oci.sh [TAG]
#   TAG defaults to symphony-agents:latest. Pin a digest in your gondolin config.
#
# The gondolin CLI is resolved in this order so this script runs both before and
# after the runtime dep lands in package.json:
#   $GONDOLIN_BIN  >  local node_modules  >  npx --yes @earendil-works/gondolin@$VER
set -euo pipefail
cd "$(dirname "$0")"

TAG="${1:-symphony-agents:latest}"
ROOTFS_IMG="symphony-agents-rootfs:latest"
GONDOLIN_VERSION="${GONDOLIN_VERSION:-0.12.0}"
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || echo "$PWD/../..")"
TOOLS="$PWD/.tools"

# Resolve the gondolin CLI.
LOCAL_GONDOLIN="$REPO_ROOT/node_modules/@earendil-works/gondolin/dist/bin/gondolin.js"
if [ -n "${GONDOLIN_BIN:-}" ]; then
  GONDOLIN="$GONDOLIN_BIN"
elif [ -f "$LOCAL_GONDOLIN" ]; then
  GONDOLIN="node $LOCAL_GONDOLIN"
else
  echo ">> gondolin not in node_modules; using npx @earendil-works/gondolin@${GONDOLIN_VERSION}"
  GONDOLIN="npx --yes @earendil-works/gondolin@${GONDOLIN_VERSION}"
fi

# Gondolin compresses the initramfs with `lz4` on the host; provision it without
# root if missing.
if ! command -v lz4 >/dev/null 2>&1 && [ ! -x "$TOOLS/bin/lz4" ]; then
  echo ">> lz4 not found; fetching into .tools (no root) ..."
  mkdir -p "$TOOLS/dl" "$TOOLS/extract" "$TOOLS/bin"
  ( cd "$TOOLS/dl" && apt-get download lz4 liblz4-1 )
  for d in "$TOOLS"/dl/*.deb; do dpkg-deb -x "$d" "$TOOLS/extract"; done
  ln -sf "$(find "$TOOLS/extract" -name lz4 -type f | head -1)" "$TOOLS/bin/lz4"
fi
if [ -x "$TOOLS/bin/lz4" ]; then
  export PATH="$TOOLS/bin:$PATH"
  LIBDIR="$(dirname "$(find "$TOOLS/extract" -name 'liblz4.so*' 2>/dev/null | head -1)")"
  [ -n "${LIBDIR:-}" ] && export LD_LIBRARY_PATH="${LIBDIR}${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
fi
echo ">> using lz4: $(command -v lz4 || echo MISSING)"

echo ">> [1/2] docker build glibc rootfs image ${ROOTFS_IMG} (agents baked in) ..."
docker build -t "${ROOTFS_IMG}" -f Dockerfile.agents .

echo ">> [2/2] gondolin build (OCI rootfs) → ${TAG} ..."
$GONDOLIN build --config build-config.oci.json --tag "${TAG}"

echo ">> done. local image refs:"
$GONDOLIN image ls
