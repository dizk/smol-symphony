// Gondolin dispatch orchestration — the Gondolin VM bring-up +
// exec-launch + teardown sequence (runner.ts
// `startVmOrFail`/`launchExecStream`/`attachStderrTap` + teardown), composed over
// the injected `VmClient` port, the host `CredentialSecretRegistry`, and gondolin's
// `createHttpHooks`. This is the `application`-role composition seam: it wires the
// credential adapter + the VM port + the ACP bridge mapping together.
//
// LIVE: the live dispatch path (`runner.ts` runAttempt etc.) imports this.
// Gondolin is the live VM backend. The invariant guards (vm-guards.ts) are
// wired in here so the Gondolin
// path is enforced-by-construction: mounts are validated and env is stripped while
// the `CreateVmOptions` are built — a credential mount HARD-FAILs and a credential
// env var can never reach the guest's PID-1 environment.
//
// Contract mirrored from the live runner (without modifying it):
//   - mounts: workspace RW + gondolin.volumes + eval-mode RO (buildVmMounts) — here the
//     caller passes the already-built list; we validate it.
//   - env: forwarded env (buildForwardedEnv) — here generalized via stripCredentialEnv.
//   - launch: `node /opt/symphony/vm-agent.mjs` (the in-VM ACP launcher), stdin
//     end()ed immediately (ACP rides the TCP bridge, not stdio), stderr tapped before
//     the bridge handshake (attachStderrTap).
//   - teardown: kill the exec, close the VM, deregister the secret manager —
//     idempotent and error-tolerant.

import { Buffer } from 'node:buffer';
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
import { buildAcpTcpDns, buildMcpTcpHostEntry, type AcpTcpDns } from './vm-acp-mapping.js';
import {
  assertNoCredentialMounts,
  stripCredentialEnv,
  stripCredentialTokenVars,
  type CredentialMountGuardOptions,
} from './vm-guards.js';
import {
  buildGondolinFakeCreds,
  type GondolinFakeCreds,
  type GuestCredFile,
  type HostIdentityReaders,
} from './gondolin-creds-staging.js';

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
  /**
   * Host MCP HTTP endpoint (orchestrator loopback `host:port`) to tunnel into the
   * guest via `tcp.hosts`, so the in-VM agent can reach the control plane
   * (`symphony.transition` / `propose_issue`). Without this the agent runs inference
   * turns but cannot transition state. Undefined when MCP is disabled, the HTTP
   * server hasn't bound a port, or an `explicit_host_url` already points the guest at
   * a directly-reachable URL — the runner mirrors that decision when building the
   * guest MCP URL so the URL and the tunnel stay consistent.
   */
  mcp?: { host: string; port: number };
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
  /**
   * Extra non-credential runtime files to materialize in the guest BEFORE the
   * agent launches (e.g. claude's `~/.claude/settings.json` carrying the
   * `effortLevel` runtime knob). These replace the earlier dispatch path's
   * `deriveAcpCommand` `cp` preamble: the content is known host-side, so it is
   * written straight into the guest via the same base64-piped exec the fake
   * creds use — no workspace staging + in-VM copy. Holds NO secret (model/effort
   * config only); credential material is delivered solely via the secretManager
   * placeholder + the fake-creds files.
   */
  extraGuestFiles?: readonly GuestCredFile[];
  /** Override the credential-mount denylist (tests). */
  mountGuard?: CredentialMountGuardOptions;
  /**
   * Resolved opencode model for the fake custom-provider config (opencode only;
   * ignored for claude/codex). Null ⇒ the adapter default.
   */
  opencodeModel?: string | null;
  /**
   * Injectable non-secret host identity reads for fake-creds staging (claude
   * oauthAccount UUIDs, codex `account_id`). Tests pass fakes; production uses the
   * default FS-backed readers. NEVER reads a real access/refresh token.
   */
  hostReaders?: HostIdentityReaders;
}

/** A launched Gondolin dispatch: the exec streams plus an idempotent teardown. */
export interface GondolinDispatchHandle {
  readonly vm: VmHandle;
  readonly exec: VmExec;
  /** What `SYMPHONY_ACP_URL` was set to (the mapped synthetic name + port). */
  readonly acpUrl: string;
  /**
   * The fake native credential files staged into the guest (placeholders only) +
   * the placeholder env additions. Already materialized into the guest before the
   * agent launched; exposed for observability/tests (and so a future VFS-mount
   * variant can re-stage the same content).
   */
  readonly fakeCreds: GondolinFakeCreds;
  /** Kill the exec, close the VM, deregister the secret manager. Idempotent. */
  teardown(): Promise<void>;
}

/**
 * The in-VM ACP launcher command. Mirrors the earlier dispatch path's
 * `exec node /opt/symphony/vm-agent.mjs` (deriveAcpCommand). On Gondolin there is no
 * `bash -lc` wrapper and no per-dispatch staged-file `cp` preamble — runtime files
 * land via VFS mounts / the baked image — so the launcher is exec'd directly.
 */
const VM_AGENT_COMMAND: readonly string[] = ['node', '/opt/symphony/vm-agent.mjs'];

/**
 * PATH for the launched agent's exec. Gondolin's `vm.exec` runs the command
 * WITHOUT a login shell, so the guest's profile-set PATH does not apply — the
 * default exec PATH is only `/usr/sbin:/usr/bin:/sbin:/bin`, which EXCLUDES
 * `/usr/local/bin` where the image installs `node` and every agent CLI
 * (`claude-agent-acp` / `codex-acp` / `opencode`). Without this, the launch
 * command `node …` fails to spawn (ENOENT) and the in-VM agent never dials the
 * bridge back — and even if `node` were found, the adapter the agent spawns
 * (`SYMPHONY_ADAPTER_BIN`, also in `/usr/local/bin`) would not resolve either.
 * Set it explicitly on the launch exec env (which the adapter child inherits) so
 * the production dispatch path does not depend on a login shell. This carries no
 * secret — it is a fixed search path. (Go-live validation finding.)
 */
const GUEST_AGENT_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

/** Bound on each fake-creds write exec (a tiny mkdir+write; never hangs). */
const STAGE_TIMEOUT_MS = 15_000;

/**
 * Build the in-guest write command for a single fake-creds file. The content is
 * base64-encoded host-side and decoded in-guest, so arbitrary JSON (quotes,
 * newlines, `$`) can never break out of the shell or be interpreted — there is no
 * heredoc/`echo` injection surface. `mkdir -p` the parent, decode into place, then
 * `chmod`. POSIX-portable (`/bin/sh`, `base64 -d`). The guest path is single-quoted
 * (paths we emit contain no `'`).
 */
function writeFileCommand(file: GuestCredFile): string[] {
  const b64 = Buffer.from(file.content, 'utf8').toString('base64');
  const dir = posixDirname(file.guestPath);
  const mode = file.mode.toString(8);
  const script =
    `mkdir -p '${dir}' && ` +
    `printf %s '${b64}' | base64 -d > '${file.guestPath}' && ` +
    `chmod ${mode} '${file.guestPath}'`;
  return ['/bin/sh', '-c', script];
}

/** POSIX dirname for an absolute guest path (always `/`-separated). */
function posixDirname(p: string): string {
  const idx = p.lastIndexOf('/');
  if (idx <= 0) return '/';
  return p.slice(0, idx);
}

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
    // ONE createHttpHooks call yields the httpHooks (into createVm), the
    // secretManager (into the registry), AND the placeholder `env` map (the
    // token-shaped fake bearer keyed by the secret name) for this VM. They must be
    // the same instance — and the placeholder `env` (previously dropped) is the
    // value the guest holds, so its fake creds + launch env are built from it.
    const { httpHooks, secretManager, env: placeholderEnv } = createHttpHooks(
      this.hooksConfig.options,
    );
    const mapping = buildAcpTcpDns(opts.bridgeHost, opts.bridgePort);
    // Add the guest→host MCP control-plane tunnel into the SAME tcp.hosts record
    // (the synthetic per-host DNS already resolves both names). Without this the
    // agent can run inference turns but cannot reach `symphony.transition` — so it
    // completes work but never transitions state (the gap dogfooding surfaced).
    if (opts.mcp) {
      mapping.tcp = {
        ...mapping.tcp,
        hosts: { ...mapping.tcp.hosts, ...buildMcpTcpHostEntry(opts.mcp.host, opts.mcp.port) },
      };
    }
    const fakeCreds = await this.buildFakeCreds(opts, placeholderEnv);

    // Phase 3 enforcement, BEFORE createVm: a credential mount throws here, and the
    // env is stripped so no real token reaches the guest's boot environment.
    assertNoCredentialMounts(opts.mounts, opts.mountGuard);
    const createOpts = this.buildCreateVmOptions(opts, httpHooks, mapping);

    const vm = await this.vmClient.createVm(createOpts);
    // Once the VM exists, EVERY subsequent step (register, stage, launch) can
    // throw — and the handle (the only teardown affordance) has not been returned
    // yet, so a throw here would strand the VM + the registered manager. Guard the
    // whole post-createVm bring-up: on any failure close the VM and deregister the
    // manager (if it got registered), then rethrow. Cleanup reuses the same
    // idempotent, error-tolerant `teardownDispatch` the handle uses.
    return this.bringUpOrTeardown(vm, secretManager, fakeCreds, mapping.acpUrl, opts);
  }

  /**
   * Register the secret manager, stage the fake creds, and launch the agent —
   * tearing the VM down (and deregistering the manager) on any failure so a
   * post-createVm throw can never leak the VM handle the caller never received.
   */
  private async bringUpOrTeardown(
    vm: VmHandle,
    secretManager: SecretManager,
    fakeCreds: GondolinFakeCreds,
    acpUrl: string,
    opts: GondolinDispatchOptions,
  ): Promise<GondolinDispatchHandle> {
    let registered: RegisteredVm | null = null;
    try {
      // Seed + register the manager BEFORE launching the agent so the placeholder's
      // real value is present before the first egress (the registry seeds value '' →
      // real token synchronously-after-await). AWAIT it before exec.
      registered = await this.registerSecretManager(secretManager);
      // Materialize the fake native creds files PLUS any non-credential runtime
      // files (model/effort knobs) into the guest BEFORE launching the agent — the
      // placeholder bearer (a fake) and the effort settings.json must be in place
      // at first read.
      await this.stageFakeCredsFiles(
        vm,
        [...fakeCreds.files, ...(opts.extraGuestFiles ?? [])],
        opts.workdir,
      );
      const exec = this.launchAgent(vm, opts, acpUrl, fakeCreds.env);
      return this.buildHandle(vm, exec, registered, acpUrl, fakeCreds);
    } catch (err) {
      // No launch exec yet (or the launch itself threw): close the VM + deregister
      // the manager (if registration succeeded). teardownDispatch tolerates a null
      // exec and a null registration, so this is safe at any failure point.
      await teardownDispatch(vm, null, registered);
      throw err;
    }
  }

  /**
   * Build the per-adapter fake native creds + placeholder env from the
   * placeholder Gondolin minted (`createHttpHooks().env[secretName]`). The
   * placeholder is used VERBATIM so it byte-matches what Gondolin substitutes at
   * egress; the real token never appears.
   */
  private async buildFakeCreds(
    opts: GondolinDispatchOptions,
    placeholderEnv: Record<string, string>,
  ): Promise<GondolinFakeCreds> {
    const secretName = this.hooksConfig.secretName;
    const placeholder = placeholderEnv[secretName] ?? '';
    return buildGondolinFakeCreds(this.hooksConfig.adapterId as AcpAdapterId, {
      placeholder,
      secretName,
      opencodeModel: opts.opencodeModel ?? null,
      hostReaders: opts.hostReaders,
    });
  }

  /**
   * Write each fake-creds file into the guest via a pre-launch exec. The content
   * is base64-piped (no shell-quoting hazard for arbitrary JSON) into a
   * `mkdir -p`'d destination, then chmod'd. Gondolin's programmable VFS could also
   * host these as mounts, but a write-exec needs no port extension and keeps the
   * "placeholder-before-launch" ordering enforced-by-construction here. Each write
   * is awaited so the file exists before `vm-agent.mjs` (and the adapter) starts.
   */
  private async stageFakeCredsFiles(
    vm: VmHandle,
    files: readonly GuestCredFile[],
    workdir: string,
  ): Promise<void> {
    for (const f of files) {
      const exec = vm.exec({
        command: writeFileCommand(f),
        workdir,
        timeoutMs: STAGE_TIMEOUT_MS,
      });
      exec.stdin.end();
      await exec.exit;
    }
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
      // Per-adapter (credential-secrets spec). Default-deny; codex → true because
      // codex-acp streams the Responses API over a WS Upgrade. SAFE: Gondolin
      // substitutes the real token on the (hookable) Upgrade handshake, so the
      // placeholder never egresses, and the post-101 tunnel reaches only the
      // allowlisted inference host (a refresh host's upgrade would be blocked). The
      // proxy-era #127 wss-leak concern does not apply under Gondolin substitution.
      allowWebSockets: this.hooksConfig.allowWebSockets,
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
  private launchAgent(
    vm: VmHandle,
    opts: GondolinDispatchOptions,
    acpUrl: string,
    placeholderEnv: Record<string, string>,
  ): VmExec {
    const exec = vm.exec({
      command: [...VM_AGENT_COMMAND],
      workdir: opts.workdir,
      env: this.buildLaunchEnv(opts, acpUrl, placeholderEnv),
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
   *
   * ORDERING (load-bearing): the placeholder bearer (a FAKE value keyed by the
   * credential var name itself, e.g. `ANTHROPIC_AUTH_TOKEN` / `OPENAI_API_KEY`) is
   * merged AFTER `stripCredentialTokenVars` — the strip would otherwise drop it as
   * a `*_TOKEN`/`*_API_KEY` name. Spreading it last means the placeholder survives
   * the strip while a real token smuggled via `runtimeEnv` (stripped first) cannot.
   */
  private buildLaunchEnv(
    opts: GondolinDispatchOptions,
    acpUrl: string,
    placeholderEnv: Record<string, string>,
  ): Record<string, string> {
    return {
      // PATH first so a non-login exec resolves `node` + the agent CLIs in
      // `/usr/local/bin` (see GUEST_AGENT_PATH). A runtimeEnv-supplied PATH (rare)
      // would override it via the spread below.
      PATH: GUEST_AGENT_PATH,
      SYMPHONY_ACP_URL: acpUrl,
      SYMPHONY_ACP_TOKEN: opts.acpToken,
      SYMPHONY_ADAPTER_BIN: opts.adapterBin,
      SYMPHONY_ADAPTER_ARGS: JSON.stringify(opts.adapterArgs),
      ...stripCredentialTokenVars(opts.runtimeEnv),
      // The placeholder (a fake) is ADDED after the strip — see the ordering note.
      ...placeholderEnv,
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
    fakeCreds: GondolinFakeCreds,
  ): GondolinDispatchHandle {
    let torndown = false;
    return {
      vm,
      exec,
      acpUrl,
      fakeCreds,
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
 * the others (mirrors the runner's tearDownSession resilience). `exec` is `null` when
 * teardown runs from a bring-up failure that aborted BEFORE the launch exec was
 * created, and `registered` is `null` when the secret manager never got registered —
 * both are skipped so the partial-bring-up cleanup is safe at any failure point.
 */
async function teardownDispatch(
  vm: VmHandle,
  exec: VmExec | null,
  registered: RegisteredVm | null,
): Promise<void> {
  if (exec) {
    try {
      exec.kill();
    } catch (err) {
      log.warn('gondolin-dispatch: exec.kill threw during teardown', {
        error: (err as Error).message,
      });
    }
  }
  try {
    await vm.close();
  } catch (err) {
    log.warn('gondolin-dispatch: vm.close threw during teardown', {
      error: (err as Error).message,
    });
  }
  if (registered) {
    try {
      registered.deregister();
    } catch (err) {
      log.warn('gondolin-dispatch: deregister threw during teardown', {
        error: (err as Error).message,
      });
    }
  }
}
