// Thin wrapper around the smolvm CLI for per-issue microVM isolation.
//
// We use the local `smolvm` binary because the npm package is a stub and the HTTP API does
// not support bidirectional stdio for `machine exec`. The CLI form `machine exec -i` exposes
// the VM-process stdin/stdout directly, which is exactly what the ACP JSON-RPC transport
// needs.

import { spawn, type ChildProcess, type ChildProcessByStdio } from 'node:child_process';
import path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import type { SmolvmConfig } from '../types.js';
import { runProcess, describeRunFailure } from '../util/process.js';
import { log } from '../logging.js';

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

export class SmolvmError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'SmolvmError';
  }
}

export class SmolvmClient {
  constructor(private readonly cfg: SmolvmConfig) {}

  // The smolvm binary is invoked directly. The endpoint config is reserved for a future HTTP
  // transport but is not threaded through the CLI today — the CLI talks to the local daemon
  // automatically.
  // Redact secret-bearing argv values before logging. `--env KEY=value` carries forwarded
  // tokens (OPENAI_API_KEY, ANTHROPIC_API_KEY, …) and must never reach stderr or log sinks.
  private redactArgv(args: string[]): string {
    const out: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i]!;
      if (a === '--env' || a === '-e') {
        out.push(a);
        const next = args[i + 1];
        if (next !== undefined) {
          const eq = next.indexOf('=');
          out.push(eq >= 0 ? `${next.slice(0, eq)}=<redacted>` : next);
          i += 1;
        }
        continue;
      }
      out.push(a);
    }
    return out.join(' ');
  }

  // Smolvm CLI invocations route through the unified `runProcess`. The legacy
  // `execFile` shape used a 32 MiB maxBuffer; we keep that ceiling here because
  // `machine ls --json` can return a long list of machines on a busy daemon.
  private async run(args: string[], opts: { timeoutMs?: number } = {}): Promise<{ stdout: string; stderr: string }> {
    log.debug('smolvm cli', { argv: this.redactArgv(args) });
    const r = await runProcess('smolvm', args, {
      timeoutMs: opts.timeoutMs,
      maxBytes: 32 * 1024 * 1024,
    });
    if (r.exit_code !== 0 || r.timed_out || r.signal !== null) {
      throw new SmolvmError(
        'smolvm_cli_failed',
        `smolvm ${args.join(' ')} ${describeRunFailure(r)}: ${r.stderr.trim() || r.stdout.trim()}`,
      );
    }
    return { stdout: r.stdout, stderr: r.stderr };
  }

  // List all VM names known to the smolvm daemon. Failures (daemon down, malformed
  // JSON) return [] — callers treat that as "nothing to enumerate" rather than fatal,
  // which is right both for `exists` and for orphan cleanup.
  async list(): Promise<string[]> {
    try {
      const { stdout } = await this.run(['machine', 'ls', '--json'], { timeoutMs: 10_000 });
      const parsed = JSON.parse(stdout) as { machines?: Array<{ name?: string }> } | Array<{ name?: string }>;
      const list = Array.isArray(parsed) ? parsed : parsed.machines ?? [];
      return list
        .map((m) => m.name)
        .filter((n): n is string => typeof n === 'string' && n.length > 0);
    } catch {
      return [];
    }
  }

  async exists(name: string): Promise<boolean> {
    const all = await this.list();
    return all.includes(name);
  }

  async create(name: string, opts: CreateOptions): Promise<void> {
    const args = ['machine', 'create', name];
    if (opts.from) {
      args.push('--from', opts.from);
    } else if (opts.smolfile) {
      args.push('--smolfile', opts.smolfile);
    } else if (opts.image) {
      args.push('--image', opts.image);
    }
    args.push('--cpus', String(opts.cpus));
    args.push('--mem', String(opts.memMib));
    if (opts.net) args.push('--net');
    if (opts.sshAgent) args.push('--ssh-agent');
    if (opts.workdir) args.push('--workdir', opts.workdir);
    for (const m of opts.mounts) {
      const spec = `${path.resolve(m.host)}:${m.guest}${m.readonly ? ':ro' : ''}`;
      args.push('--volume', spec);
    }
    for (const [k, v] of Object.entries(opts.env)) {
      args.push('--env', `${k}=${v}`);
    }
    await this.run(args, { timeoutMs: 120_000 });
  }

  async start(name: string): Promise<void> {
    await this.run(['machine', 'start', '--name', name], { timeoutMs: 60_000 });
  }

  async stop(name: string): Promise<void> {
    try {
      await this.run(['machine', 'stop', '--name', name], { timeoutMs: 30_000 });
    } catch (err) {
      log.warn('smolvm stop failed', { name, error: (err as Error).message });
    }
  }

  async destroy(name: string): Promise<void> {
    try {
      await this.run(['machine', 'delete', name, '-f'], { timeoutMs: 30_000 });
    } catch (err) {
      log.warn('smolvm delete failed', { name, error: (err as Error).message });
    }
  }

  async ensureRunning(name: string, opts: CreateOptions): Promise<void> {
    const exists = await this.exists(name);
    if (!exists) {
      await this.create(name, opts);
    }
    await this.start(name);
  }

  // Spawn an interactive exec session inside the VM. Returns a ChildProcessByStdio with all
  // three stdio streams piped, which is suitable for stdio JSON-RPC.
  execInteractive(name: string, opts: ExecOptions): ExecStream {
    const args = ['machine', 'exec', '--name', name, '-i'];
    if (opts.workdir) args.push('--workdir', opts.workdir);
    for (const [k, v] of Object.entries(opts.env)) {
      args.push('--env', `${k}=${v}`);
    }
    if (opts.timeoutMs && opts.timeoutMs > 0) {
      args.push('--timeout', `${opts.timeoutMs}ms`);
    }
    args.push('--', ...opts.command);
    const child = spawn('smolvm', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcess & ChildProcessByStdio<Writable, Readable, Readable>;
    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.on('close', (code, signal) => resolve({ code: code, signal: signal ?? null }));
    });
    let killed = false;
    return {
      child,
      stdin: child.stdin,
      stdout: child.stdout,
      stderr: child.stderr,
      pid: child.pid,
      exit,
      kill: () => {
        if (killed) return;
        killed = true;
        try {
          child.kill('SIGTERM');
        } catch {
          // ignore
        }
        setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            // ignore
          }
        }, 3_000).unref();
      },
    };
  }
}
