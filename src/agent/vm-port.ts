// Generalized VM-substrate port (Gondolin object model).
//
// Where the old smolvm port mirrored the CLI's name-keyed verbs
// (`create`/`start`/`stop`/`destroy`/`exec`), this port mirrors Gondolin's
// object model: `createVm(opts)` hands back a `VmHandle` that owns `exec()` /
// `close()`, and session discovery/GC is global — Gondolin owns the lifecycle
// registry, replacing the smolvm machine registry + the `_boot-vm` reaper.
//
// Domain code imports only this module (the hexagonal `domain↛adapters`
// direction holds); the concrete adapter lives in `./gondolin.ts`. The handful
// of Gondolin config types threaded through `CreateVmOptions`
// (`HttpHooks`/`TcpOptions`/`DnsOptions`) are produced by the host credential
// module + the ACP bridge and passed straight through to `VM.create` — this is
// the single-adapter seam, so leaking those infra types here is deliberate and
// cheap (the reaper-facing half — `listSessions`/`gc` — stays Gondolin-free).
//
// Phase 0 adds this alongside the still-live smolvm port; nothing wires it yet.

import type { Readable } from 'node:stream';
import type { DnsOptions, HttpHooks, TcpOptions } from '@earendil-works/gondolin';

// Prefix used as the `sessionLabel` for every VM the orchestrator creates. The
// reaper (and Gondolin session GC) filters the host's session set by this
// prefix so a VM that survives a symphony restart is recognised as an orphan.
export const SYMPHONY_VM_PREFIX = 'symphony-';

export interface VmMount {
  host: string;
  guest: string;
  readonly: boolean;
}

export interface CreateVmOptions {
  /**
   * Gondolin image ref (tag or digest) exported by `images/agents` — maps to
   * `VMOptions.sandbox.imagePath`. Replaces the smolvm image/from/smolfile trio.
   */
  imagePath: string;
  cpus: number;
  memMib: number;
  /**
   * Host→guest mounts. The adapter wraps each host path in a `RealFSProvider`
   * (read-write) or a `ReadonlyProvider`-wrapped one (read-only) under
   * `VMOptions.vfs.mounts`. No fixed mount cap (programmable VFS), so the
   * smolvm "bake scripts/ into the image" workaround is no longer needed.
   */
  mounts: VmMount[];
  /**
   * Default boot env. MUST NOT carry real credential material — the
   * host-only-refresh invariant (design doc §3) means the guest holds only
   * placeholders; real tokens are substituted at egress via `httpHooks`.
   */
  env: Record<string, string>;
  /**
   * Egress secret-substitution + host-allowlist hooks from the host credential
   * module (`createHttpHooks`). Passed straight to `VM.create`.
   */
  httpHooks?: HttpHooks;
  /** Raw-TCP host mappings — the ACP bridge rides one of these (`tcp.hosts`). */
  tcp?: TcpOptions;
  /** DNS mode; the ACP `tcp.hosts` mapping needs synthetic per-host resolution. */
  dns?: DnsOptions;
  /** Default-deny WebSocket upgrades (codex stays on the HTTP Responses transport). */
  allowWebSockets?: boolean;
  /** Session label for discovery/GC; the orchestrator prefixes `SYMPHONY_VM_PREFIX`. */
  sessionLabel: string;
  /** Default guest working directory for `exec`. */
  workdir?: string | null;
}

export interface VmExecOptions {
  command: string[];
  workdir?: string | null;
  env?: Record<string, string>;
  timeoutMs?: number | null;
}

/**
 * A launched in-VM process. Gondolin-native shape: `stdout`/`stderr` are piped
 * Node `Readable`s, `stdin` is a minimal writer (the ACP launcher only `.end()`s
 * it — ACP rides the TCP bridge, not exec stdio), `exit` resolves on completion,
 * and `kill()` aborts the exec (the adapter owns the `AbortController`).
 */
export interface VmExec {
  stdin: { write(chunk: string | Buffer): void; end(): void };
  stdout: Readable;
  stderr: Readable;
  /** Host pid of the VM runner, when known (logging parity with the smolvm port). */
  pid: number | undefined;
  exit: Promise<{ code: number | null; signal: number | null }>;
  /** Send the abort signal; idempotent. */
  kill(): void;
}

export interface VmHandle {
  /** Gondolin session uuid (`VM.id`). */
  readonly id: string;
  exec(opts: VmExecOptions): VmExec;
  close(): Promise<void>;
}

/** A discovered Gondolin session (for the reaper). Mirrors Gondolin's `SessionEntry`. */
export interface VmSession {
  id: string;
  pid: number;
  label?: string;
  /** Whether the session socket is connectable. */
  alive: boolean;
  createdAt: string;
}

/**
 * VM-substrate client port. The concrete adapter (`./gondolin.ts`) is thin over
 * Gondolin's `VM.create` / `vm.exec` / `vm.close` / `listSessions` /
 * `gcSessions`. Tests substitute fakes typed against this interface.
 */
export interface VmClient {
  createVm(opts: CreateVmOptions): Promise<VmHandle>;
  /** All Gondolin sessions on the host; filter by `SYMPHONY_VM_PREFIX` at the call site. */
  listSessions(): Promise<VmSession[]>;
  /** Collect stale sessions + orphan socket files; returns the count reaped. */
  gc(): Promise<number>;
}
