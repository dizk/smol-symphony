// GondolinVmClient — concrete VM-substrate adapter over `@earendil-works/gondolin`.
//
// Implements the `vm-port.ts` contract. Thin by design: `createVm` → `VM.create`
// (host mounts become `RealFSProvider`/`ReadonlyProvider` VFS entries), the
// handle's `exec` → `vm.exec` (piped stdio + an `AbortController` standing in
// for the VM port's `kill()`), `close` → `vm.close`, and `listSessions`/`gc`
// → Gondolin's session registry. No domain imports (hexagonal `adapters↛inward`).
//
// Phase 0: added but not yet wired into the runner/reconciler — that is Phase 1+.

import type { Readable } from 'node:stream';
import {
  VM,
  RealFSProvider,
  ReadonlyProvider,
  listSessions as gondolinListSessions,
  gcSessions,
  type VMOptions,
  type VirtualProvider,
} from '@earendil-works/gondolin';
import type {
  VmClient,
  CreateVmOptions,
  VmExec,
  VmExecOptions,
  VmHandle,
  VmSession,
} from './vm-port.js';

class GondolinVmHandle implements VmHandle {
  constructor(private readonly vm: VM) {}

  get id(): string {
    return this.vm.id;
  }

  exec(opts: VmExecOptions): VmExec {
    // Gondolin has no `proc.kill()`; aborting the signal passed to `exec` is the
    // teardown path, so the handle owns the controller.
    const ac = new AbortController();
    const proc = this.vm.exec(opts.command, {
      cwd: opts.workdir ?? undefined,
      env: opts.env,
      stdin: true,
      stdout: 'pipe',
      stderr: 'pipe',
      signal: ac.signal,
    });
    const stdout = proc.stdout;
    const stderr = proc.stderr;
    if (!stdout || !stderr) {
      throw new Error('gondolin exec did not expose piped stdout/stderr');
    }
    let killed = false;
    return {
      stdin: {
        write: (chunk: string | Buffer) => proc.write(chunk),
        end: () => proc.end(),
      },
      stdout,
      stderr,
      pid: this.vm.getHostPid() ?? undefined,
      exit: proc.result.then((r) => ({ code: r.exitCode, signal: r.signal ?? null })),
      kill: () => {
        if (killed) return;
        killed = true;
        try {
          ac.abort();
        } catch {
          // idempotent — already aborted / process gone
        }
      },
    };
  }

  async close(): Promise<void> {
    await this.vm.close();
  }
}

export class GondolinVmClient implements VmClient {
  async createVm(opts: CreateVmOptions): Promise<VmHandle> {
    const mounts: Record<string, VirtualProvider> = {};
    for (const m of opts.mounts) {
      const provider = new RealFSProvider(m.host);
      mounts[m.guest] = m.readonly ? new ReadonlyProvider(provider) : provider;
    }
    const options: VMOptions = {
      sandbox: { imagePath: opts.imagePath },
      cpus: opts.cpus,
      memory: `${opts.memMib}M`,
      env: opts.env,
      vfs: { mounts },
      httpHooks: opts.httpHooks,
      tcp: opts.tcp,
      dns: opts.dns,
      allowWebSockets: opts.allowWebSockets,
      sessionLabel: opts.sessionLabel,
    };
    const vm = await VM.create(options);
    return new GondolinVmHandle(vm);
  }

  async listSessions(): Promise<VmSession[]> {
    const sessions = await gondolinListSessions();
    return sessions.map((s) => ({
      id: s.id,
      pid: s.pid,
      label: s.label,
      alive: s.alive,
      createdAt: s.createdAt,
    }));
  }

  async gc(): Promise<number> {
    return gcSessions();
  }
}
