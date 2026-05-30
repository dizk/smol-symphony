# Agent image (`symphony-agents`)

The rootfs Gondolin boots for every dispatch. Built **once** (here), not per-issue —
this replaces the old per-issue VM-image bake/pack pipeline.

## Build

```
npm run build:image            # → symphony-agents:latest
# or:  bash images/agents/build-image-oci.sh symphony-agents:<digest>
```

Two steps (see `build-image-oci.sh`):
1. `docker build` `Dockerfile.agents` (`node:24-bookworm-slim` + the agent CLIs) →
   `symphony-agents-rootfs:latest`.
2. `gondolin build --config build-config.oci.json` exports that OCI image as a
   Gondolin rootfs tagged `symphony-agents:<tag>`.

**Requirements:** `docker`, `/dev/kvm`, `qemu-system-x86_64`, and `lz4` (the script
auto-provisions `lz4` into `.tools/` without root if it's missing). The gondolin CLI
is resolved from `node_modules` if present, else a pinned `npx` (`GONDOLIN_VERSION`,
default `0.12.0`); override with `GONDOLIN_BIN`.

## What's inside (verified booted, 2026-05-29)

`claude` (2.1.156), `claude-agent-acp`, `codex` (0.135.0), `codex-acp`,
`opencode` (1.15.12) — all on PATH (Debian 12 / glibc). Agent CLI pins carry over
the set the former per-issue VM image pinned in production; bump
`Dockerfile.agents` deliberately (codex/codex-acp/opencode transport behavior is
load-bearing — see the pin comment).

## Notes
- **`scripts/vm-agent.mjs` IS baked in** at `/opt/symphony/vm-agent.mjs` (the `COPY`
  in `Dockerfile.agents`). The Gondolin dispatcher launches
  `node /opt/symphony/vm-agent.mjs` with NO runtime `/opt/symphony` mount, so the
  launcher must live in the image (a go-live finding: it was previously neither
  baked nor mounted). The old 3-mount-cap workaround (commit `ba1b520`) is gone —
  Gondolin's VFS is programmable, but the launcher is baked rather than mounted.
- **No CA setup needed.** Gondolin injects its MITM CA into the guest at boot
  (spike-verified: trusted out-of-the-box).
- Pin a **digest** (not `:latest`) in the runner's gondolin config for reproducible
  dispatches.
