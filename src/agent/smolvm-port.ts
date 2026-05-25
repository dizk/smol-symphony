// Smolvm port: the abstract contract domain code (the reconciler's VM reaper,
// the runner) holds against the smolvm subsystem. Adapters under `src/agent/`
// implement it; domain code under `src/reconciler/` imports only from this
// module so the hexagonal `domain↛adapters` direction holds.
//
// The constant + types here are referenced as types-only by reconciler/vm.ts;
// the constant is also used as a value (the `symphony-` prefix the VM reaper
// filters the host actual-set by). Concrete behavior lives in `./smolvm.ts`.

import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

// Prefix used by every VM the orchestrator creates. The runner mints VM names as
// `${SYMPHONY_VM_PREFIX}<sanitized-identifier>`; the orchestrator owns this namespace
// so any matching VM that survives across symphony process restarts (e.g. a SIGKILL'd
// previous instance) is treated as orphaned and destroyed at start/stop.
export const SYMPHONY_VM_PREFIX = 'symphony-';

export interface VmMount {
  host: string;
  guest: string;
  readonly: boolean;
}

export interface CreateOptions {
  // Source for the VM. At most one of:
  //   - `image`    : OCI image reference (`--image`).
  //   - `from`     : path to a packed .smolmachine artifact (`--from`). Boots from
  //                  pre-extracted layers (~250ms).
  //   - `smolfile` : path to a TOML Smolfile (`--smolfile`). The Smolfile declares
  //                  image + resources + `[dev].init` + `[dev].volumes`; symphony's
  //                  CLI flags merge with the Smolfile per smolvm's precedence rules
  //                  (CLI > Smolfile > defaults).
  // Mutual exclusion is enforced upstream in `validateDispatch`. When two are
  // somehow still set, `from` > `smolfile` > `image` so the highest-fidelity source
  // wins.
  image: string | null;
  from: string | null;
  smolfile: string | null;
  cpus: number;
  memMib: number;
  net: boolean;
  mounts: VmMount[];
  env: Record<string, string>;
  workdir: string | null;
  sshAgent: boolean;
}

export interface ExecOptions {
  command: string[];
  workdir: string | null;
  env: Record<string, string>;
  timeoutMs: number | null;
}

export interface ExecStream {
  child: ChildProcessByStdio<Writable, Readable, Readable>;
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  pid: number | undefined;
  /** Resolves with the child's exit info when the subprocess closes. */
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  /** Send SIGTERM, then SIGKILL after a short grace period. */
  kill(): void;
}

/**
 * Smolvm client port. Methods correspond 1:1 to the underlying `smolvm` CLI
 * verbs (`machine ls`, `machine create`, `machine start`, `machine stop`,
 * `machine delete`, `machine exec`). The concrete adapter in `./smolvm.ts`
 * shells out to the local `smolvm` binary; tests substitute fakes typed
 * against this interface.
 */
export interface SmolvmClient {
  /**
   * List every VM name known to the smolvm daemon. Returns [] on daemon /
   * transport failure — callers treat that as "nothing to enumerate".
   */
  list(): Promise<string[]>;
  exists(name: string): Promise<boolean>;
  create(name: string, opts: CreateOptions): Promise<void>;
  start(name: string): Promise<void>;
  stop(name: string): Promise<void>;
  destroy(name: string): Promise<void>;
  ensureRunning(name: string, opts: CreateOptions): Promise<void>;
  execInteractive(name: string, opts: ExecOptions): ExecStream;
}
