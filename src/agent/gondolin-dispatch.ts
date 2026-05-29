// Gondolin dispatch orchestration — the Gondolin equivalent of the runner's
// smolvm start + exec-launch + teardown sequence (runner.ts
// `startVmOrFail`/`launchExecStream`/`attachStderrTap` + teardown), composed over
// the injected `VmClient` port, the host `CredentialSecretRegistry`, and gondolin's
// `createHttpHooks`. This is the `application`-role composition seam: it wires the
// credential adapter + the VM port + the ACP bridge mapping together.
//
// DORMANT (Phase 1 + Phase 3): nothing on the live dispatch path (`runner.ts`
// runAttempt etc.) imports this. smolvm stays the live backend until the later flip
// PR. The Phase 3 invariant guards (vm-guards.ts) are wired in here so the Gondolin
// path is enforced-by-construction: mounts are validated and env is stripped while
// the `CreateVmOptions` are built — a credential mount HARD-FAILs and a credential
// env var can never reach the guest's PID-1 environment.
//
// Contract mirrored from the live runner (without modifying it):
//   - mounts: workspace RW + smolvm.volumes + eval-mode RO (buildVmMounts) — here the
//     caller passes the already-built list; we validate it.
//   - env: forwarded env (buildForwardedEnv) — here generalized via stripCredentialEnv.
//   - launch: `node /opt/symphony/vm-agent.mjs` (the in-VM ACP launcher), stdin
//     end()ed immediately (ACP rides the TCP bridge, not stdio), stderr tapped before
//     the bridge handshake (attachStderrTap).
//   - teardown: kill the exec, close the VM, deregister the secret manager —
//     idempotent and error-tolerant.

import { createHttpHooks, type SecretManager } from '@earendil-works/gondolin';
import { log } from '../logging.js';
import type { AcpAdapterId } from './adapter-names.js';
import type { AdapterHooksConfig, CredentialSecretRegistry, RegisteredVm } from './credential-secrets.js';
import {
  SYMPHONY_VM_PREFIX,
  type CreateVmOptions,
  type VmClient,
  type VmExec,
  type VmHandle,
  type VmMount,
} from './vm-port.js';
import { buildAcpTcpDns, type AcpTcpDns } from './vm-acp-mapping.js';
import {
  assertNoCredentialMounts,
  stripCredentialEnv,
  stripCredentialTokenVars,
  type CredentialMountGuardOptions,
} from './vm-guards.js';

/** Static VM-shape config the runner reads from `cfg` (image ref + resources). */
export interface GondolinVmConfig {
  /** Gondolin image ref (tag or digest) → `CreateVmOptions.imagePath`. */
  imagePath: string;
  cpus: number;
  memMib: number;
}

/** Sink for the in-VM agent's diagnostic stderr (mirrors runner.attachStderrTap). */
export type StderrSink = (chunk: string) => void;

export interface GondolinDispatchOptions {
  /** Stable per-dispatch identifier appended to `SYMPHONY_VM_PREFIX` for the session label. */
  identifier: string;
  /** Host→guest mounts (workspace RW + eval-mode RO). Validated by the Phase 3 guard. */
  mounts: VmMount[];
  /** Forwarded boot env (pre-strip). Credential vars are dropped before reaching the guest. */
  env: Record<string, string>;
  /** Guest working directory for the launched agent. */
  workdir: string;
  /** ACP bridge bind host + bound port (loopback). */
  bridgeHost: string;
  bridgePort: number;
  /** Per-dispatch ACP bridge bearer token → `SYMPHONY_ACP_TOKEN`. */
  acpToken: string;
  /** Adapter binary the in-VM launcher spawns → `SYMPHONY_ADAPTER_BIN`. */
  adapterBin: string;
  /** Effective adapter argv → `SYMPHONY_ADAPTER_ARGS` (JSON). */
  adapterArgs: readonly string[];
  /** Adapter runtime env (model/effort injection); credential vars are still stripped. */
  runtimeEnv: Record<string, string>;
  /** Diagnostic stderr sink (run log + event ring on the runner side). */
  onStderr: StderrSink;
  /** Override the credential-mount denylist (tests). */
  mountGuard?: CredentialMountGuardOptions;
}

/** A launched Gondolin dispatch: the exec streams plus an idempotent teardown. */
export interface GondolinDispatchHandle {
  readonly vm: VmHandle;
  readonly exec: VmExec;
  /** What `SYMPHONY_ACP_URL` was set to (the mapped synthetic name + port). */
  readonly acpUrl: string;
  /** Kill the exec, close the VM, deregister the secret manager. Idempotent. */
  teardown(): Promise<void>;
}

/**
 * The in-VM ACP launcher command. Mirrors the smolvm path's
 * `exec node /opt/symphony/vm-agent.mjs` (deriveAcpCommand). On Gondolin there is no
 * `bash -lc` wrapper and no per-dispatch staged-file `cp` preamble — runtime files
 * land via VFS mounts / the baked image — so the launcher is exec'd directly.
 */
const VM_AGENT_COMMAND: readonly string[] = ['node', '/opt/symphony/vm-agent.mjs'];

/**
 * Orchestrates a single Gondolin dispatch. Inject the VM port, the host credential
 * registry, and the per-adapter hooks config; `dispatch()` builds the enforced
 * `CreateVmOptions`, creates the VM, seeds + registers the secret manager BEFORE the
 * agent launches, then launches the in-VM ACP agent and returns a teardown handle.
 */
export class GondolinDispatcher {
  constructor(
    private readonly vmClient: VmClient,
    private readonly registry: CredentialSecretRegistry,
    private readonly hooksConfig: AdapterHooksConfig,
    private readonly vmConfig: GondolinVmConfig,
  ) {}

  async dispatch(opts: GondolinDispatchOptions): Promise<GondolinDispatchHandle> {
    // ONE createHttpHooks call yields BOTH the httpHooks (into createVm) and the
    // secretManager (into the registry) for this VM. Splitting them would give the
    // VM hooks a different manager than the one we seed/refresh — they must be the
    // same instance.
    const { httpHooks, secretManager } = createHttpHooks(this.hooksConfig.options);
    const mapping = buildAcpTcpDns(opts.bridgeHost, opts.bridgePort);

    // Phase 3 enforcement, BEFORE createVm: a credential mount throws here, and the
    // env is stripped so no real token reaches the guest's boot environment.
    assertNoCredentialMounts(opts.mounts, opts.mountGuard);
    const createOpts = this.buildCreateVmOptions(opts, httpHooks, mapping);

    const vm = await this.vmClient.createVm(createOpts);
    // Seed + register the manager BEFORE launching the agent so the placeholder's
    // real value is present before the first egress (the registry seeds value '' →
    // real token synchronously-after-await). AWAIT it before exec.
    const registered = await this.registerSecretManager(secretManager);

    const exec = this.launchAgent(vm, opts, mapping.acpUrl);
    return this.buildHandle(vm, exec, registered, mapping.acpUrl);
  }

  /** Build the enforced `CreateVmOptions`: stripped env, validated mounts, ACP mapping. */
  private buildCreateVmOptions(
    opts: GondolinDispatchOptions,
    httpHooks: CreateVmOptions['httpHooks'],
    mapping: AcpTcpDns,
  ): CreateVmOptions {
    return {
      imagePath: this.vmConfig.imagePath,
      cpus: this.vmConfig.cpus,
      memMib: this.vmConfig.memMib,
      mounts: opts.mounts,
      env: stripCredentialEnv(opts.env),
      httpHooks,
      tcp: mapping.tcp,
      dns: mapping.dns,
      // codex stays on the HTTP Responses transport; WS upgrades are opaque
      // post-101 so default-deny (design §4.1).
      allowWebSockets: false,
      sessionLabel: `${SYMPHONY_VM_PREFIX}${opts.identifier}`,
      workdir: opts.workdir,
    };
  }

  /** Register the VM's secret manager with the host registry; await the seed. */
  private async registerSecretManager(manager: SecretManager): Promise<RegisteredVm> {
    return this.registry.register({
      manager,
      secretName: this.hooksConfig.secretName,
      adapterId: this.hooksConfig.adapterId as AcpAdapterId,
    });
  }

  /**
   * Launch the in-VM ACP agent. Stdin is end()ed immediately — ACP frames ride the
   * TCP bridge, not the exec stdio; the exec channel is a process tether + a
   * diagnostic-stderr pipe (mirrors launchExecStream + attachStderrTap).
   */
  private launchAgent(vm: VmHandle, opts: GondolinDispatchOptions, acpUrl: string): VmExec {
    const exec = vm.exec({
      command: [...VM_AGENT_COMMAND],
      workdir: opts.workdir,
      env: this.buildLaunchEnv(opts, acpUrl),
      timeoutMs: null,
    });
    exec.stdin.end();
    this.attachStderrTap(exec, opts.onStderr);
    return exec;
  }

  /**
   * The launch env the in-VM `vm-agent.mjs` reads to dial back + spawn the adapter.
   * Runtime env (model/effort/base-url injection) is merged but passed through
   * `stripCredentialTokenVars` so an adapter injection can never smuggle a real token
   * into the guest while preserving the non-secret vendor-prefixed config knobs
   * (`ANTHROPIC_MODEL`, `OPENAI_BASE_URL`, …) the adapter legitimately needs.
   */
  private buildLaunchEnv(opts: GondolinDispatchOptions, acpUrl: string): Record<string, string> {
    return {
      SYMPHONY_ACP_URL: acpUrl,
      SYMPHONY_ACP_TOKEN: opts.acpToken,
      SYMPHONY_ADAPTER_BIN: opts.adapterBin,
      SYMPHONY_ADAPTER_ARGS: JSON.stringify(opts.adapterArgs),
      ...stripCredentialTokenVars(opts.runtimeEnv),
    };
  }

  /**
   * Pipe the exec's stderr to the caller's sink. Attached before the bridge
   * handshake so a pre-connect crash (vm-agent missing, malformed env, adapter that
   * exits during startup) still surfaces.
   */
  private attachStderrTap(exec: VmExec, sink: StderrSink): void {
    exec.stderr.setEncoding('utf8');
    exec.stderr.on('data', (chunk: string) => {
      try {
        sink(chunk);
      } catch (err) {
        log.warn('gondolin-dispatch: stderr sink threw', { error: (err as Error).message });
      }
    });
  }

  /** Wrap the live VM + exec + registration into the idempotent teardown handle. */
  private buildHandle(
    vm: VmHandle,
    exec: VmExec,
    registered: RegisteredVm,
    acpUrl: string,
  ): GondolinDispatchHandle {
    let torndown = false;
    return {
      vm,
      exec,
      acpUrl,
      teardown: async () => {
        if (torndown) return;
        torndown = true;
        await teardownDispatch(vm, exec, registered);
      },
    };
  }
}

/**
 * Idempotent, error-tolerant teardown: kill the exec, close the VM, deregister the
 * secret manager. Each step is independently guarded so one failure does not strand
 * the others (mirrors the runner's tearDownSession resilience).
 */
async function teardownDispatch(
  vm: VmHandle,
  exec: VmExec,
  registered: RegisteredVm,
): Promise<void> {
  try {
    exec.kill();
  } catch (err) {
    log.warn('gondolin-dispatch: exec.kill threw during teardown', {
      error: (err as Error).message,
    });
  }
  try {
    await vm.close();
  } catch (err) {
    log.warn('gondolin-dispatch: vm.close threw during teardown', {
      error: (err as Error).message,
    });
  }
  try {
    registered.deregister();
  } catch (err) {
    log.warn('gondolin-dispatch: deregister threw during teardown', {
      error: (err as Error).message,
    });
  }
}
