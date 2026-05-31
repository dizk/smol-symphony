// WORKFLOW.md parser and typed config view (SPEC §4). Pure: no fs, no process.
// The on-disk read and watcher live in `./workflow-loader.ts` (shell).

import path from 'node:path';
import os from 'node:os';
import { parseFrontMatter, FrontMatterError } from './util/frontmatter.js';
import type {
  ServiceConfig,
  StateConfig,
  StateHooksConfig,
  StatePrConfig,
  WorkflowDefinition,
  TrackerConfig,
  PollingConfig,
  WorkspaceConfig,
  LogsConfig,
  HooksConfig,
  AgentConfig,
  AcpConfig,
  GondolinConfig,
  EgressConfig,
  ServerConfig,
  McpConfig,
  PrConfig,
  PrAutopilotConfig,
  SleepCycleConfig,
  CredentialsConfig,
} from './types.js';
import { log } from './logging.js';
import { isKnownAdapter } from './agent/adapter-names.js';
import { parseActionsBlock } from './actions/parsing.js';
import type { WorkflowAction } from './actions/types.js';
import { WorkflowError } from './errors.js';

export { WorkflowError };

// Env map threaded through the pure parser. The shell loader passes
// `process.env`; tests pass an explicit map (or omit to get an empty one).
export type WorkflowEnv = Record<string, string | undefined>;

// §4.2: split YAML front matter from prompt body. Thin wrapper over the shared
// parser that translates FrontMatterError → WorkflowError so callers keep
// matching on the existing error codes.
export function splitFrontMatter(text: string): { config: Record<string, unknown>; body: string } {
  let fm;
  try {
    fm = parseFrontMatter(text);
  } catch (err) {
    if (err instanceof FrontMatterError) {
      const code = err.code === 'not_a_map' ? 'workflow_front_matter_not_a_map' : 'workflow_parse_error';
      throw new WorkflowError(code, err.message);
    }
    throw err;
  }
  return { config: fm.fields, body: fm.body };
}

/**
 * Pure entry point: split front matter, build the typed view, and return both
 * shapes. The shell loader reads the file from disk and the operator's env,
 * then calls this. `env` defaults to an empty map so tests that do not exercise
 * `$VAR` expansion need not thread it through.
 */
export function parseWorkflow(
  text: string,
  workflowPath: string,
  env: WorkflowEnv = {},
): { definition: WorkflowDefinition; config: ServiceConfig } {
  const { config: raw, body } = splitFrontMatter(text);
  const definition: WorkflowDefinition = { config: raw, prompt_template: body };
  const config = buildServiceConfig(raw, workflowPath, env);
  return { definition, config };
}

// $VAR / ~ expansion for path/command fields. `env` carries the variable map
// (the shell loader passes process.env; tests pass an explicit shape).
export function expandVar(value: string, env: WorkflowEnv = {}): string {
  if (typeof value !== 'string') return value;
  let s = value;
  if (s.startsWith('~/') || s === '~') {
    s = s === '~' ? os.homedir() : path.join(os.homedir(), s.slice(2));
  }
  const m = s.match(/^\$([A-Z_][A-Z0-9_]*)$/);
  if (m) {
    const envVal = env[m[1]!];
    return envVal ?? '';
  }
  return s;
}

function asString(v: unknown): string | null {
  if (typeof v === 'string') return v;
  return null;
}

function asInt(v: unknown, fallback: number): number {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string' && /^-?\d+$/.test(v)) return parseInt(v, 10);
  return fallback;
}

function asStringList(v: unknown, fallback: string[]): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
  return fallback;
}

function asMapStrPosInt(v: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    for (const [k, raw] of Object.entries(v as Record<string, unknown>)) {
      const n = asInt(raw, 0);
      if (n > 0) out[k.toLowerCase()] = n;
    }
  }
  return out;
}

function getObject(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const v = parent[key];
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  return {};
}

// Build a fully typed ServiceConfig from a parsed front matter map. `env`
// supplies the variable map for `$VAR` expansion; defaults to {} so pure
// callers don't need to thread one in.
export function buildServiceConfig(
  raw: Record<string, unknown>,
  workflowPath: string,
  env: WorkflowEnv = {},
): ServiceConfig {
  const workflowAbs = path.resolve(workflowPath);
  const workflowDir = path.dirname(workflowAbs);

  // tracker (§4.3.1)
  const trackerRaw = getObject(raw, 'tracker');
  const trackerKind = (asString(trackerRaw['kind']) ?? '').trim();
  // local-tracker extension: optional `tracker.root` path.
  const trackerRootRaw = asString(trackerRaw['root']);
  let trackerRoot: string | null = null;
  if (trackerRootRaw) {
    const expanded = expandVar(trackerRootRaw, env);
    if (expanded === '') {
      throw new WorkflowError(
        'workflow_parse_error',
        `tracker.root references an unset variable: ${trackerRootRaw}`,
      );
    }
    trackerRoot = path.isAbsolute(expanded) ? expanded : path.resolve(workflowDir, expanded);
  } else if (trackerKind === 'local') {
    // Default local tracker root: <workflow-dir>/issues
    trackerRoot = path.resolve(workflowDir, 'issues');
  }
  const states = parseStatesBlock(raw['states']);
  const tracker: TrackerConfig = {
    kind: trackerKind,
    states,
    root: trackerRoot,
  };

  // polling (§4.3.2)
  const pollingRaw = getObject(raw, 'polling');
  const polling: PollingConfig = {
    interval_ms: asInt(pollingRaw['interval_ms'], 30_000),
  };

  // workspace (§4.3.3)
  const workspaceRaw = getObject(raw, 'workspace');
  const wsRootInput = asString(workspaceRaw['root']);
  let workspaceRoot: string;
  if (wsRootInput) {
    const expanded = expandVar(wsRootInput, env);
    if (expanded === '') {
      throw new WorkflowError(
        'workflow_parse_error',
        `workspace.root references an unset variable: ${wsRootInput}`,
      );
    }
    workspaceRoot = path.isAbsolute(expanded) ? expanded : path.resolve(workflowDir, expanded);
  } else {
    workspaceRoot = path.join(os.tmpdir(), 'symphony_workspaces');
  }
  const workspace: WorkspaceConfig = { root: path.resolve(workspaceRoot) };

  // logs (symphony extension): per-issue JSONL run logs. Default sits next to the workspace
  // root under `.symphony/logs/` so all symphony-managed state for a project lives in one
  // tree. Same expansion rules as workspace.root.
  const logsRaw = getObject(raw, 'logs');
  const logsRootInput = asString(logsRaw['root']);
  let logsRoot: string;
  if (logsRootInput) {
    const expanded = expandVar(logsRootInput, env);
    if (expanded === '') {
      throw new WorkflowError(
        'workflow_parse_error',
        `logs.root references an unset variable: ${logsRootInput}`,
      );
    }
    logsRoot = path.isAbsolute(expanded) ? expanded : path.resolve(workflowDir, expanded);
  } else {
    logsRoot = path.resolve(workflowDir, '.symphony', 'logs');
  }
  const logs: LogsConfig = { root: path.resolve(logsRoot) };

  // hooks (§4.3.4)
  const hooksRaw = getObject(raw, 'hooks');
  // `after_run` is no longer a hook kind: the post-attempt push + PR-create handoff
  // is now a typed Done-state `actions:` block (push_branch + create_pr_if_missing).
  // A workflow that still declares it is honored as a no-op and logged so the
  // operator can migrate to actions:.
  if (asString(hooksRaw['after_run']) !== null) {
    log.warn('hooks.after_run is deprecated and ignored; migrate to a Done-state actions: block', {});
  }
  const hooks: HooksConfig = {
    after_create: asString(hooksRaw['after_create']),
    before_run: asString(hooksRaw['before_run']),
    after_run: null,
    before_remove: asString(hooksRaw['before_remove']),
    timeout_ms: asInt(hooksRaw['timeout_ms'], 60_000),
  };
  if (hooks.timeout_ms <= 0) {
    throw new WorkflowError('workflow_parse_error', 'hooks.timeout_ms must be positive');
  }

  // agent (§4.3.5)
  const agentRaw = getObject(raw, 'agent');
  const maxTurns = asInt(agentRaw['max_turns'], 20);
  if (maxTurns <= 0) {
    throw new WorkflowError('workflow_parse_error', 'agent.max_turns must be positive');
  }
  // Memory-aware admission cap (issue 27). Default-on with a 2 GiB host reserve — that's
  // enough headroom for the orchestrator process, hooks, the per-VM Gondolin runners,
  // and the kernel's working set on a typical workstation. Operators can disable the cap (set
  // `memory_admission_enabled: false`) on hosts that don't expose /proc/meminfo or where
  // the static cap is already the binding constraint.
  const memAdmissionEnabledRaw = agentRaw['memory_admission_enabled'];
  const memoryAdmissionEnabled =
    memAdmissionEnabledRaw === undefined ? true : memAdmissionEnabledRaw !== false;
  const hostMemoryReserveMib = asInt(agentRaw['host_memory_reserve_mib'], 2048);
  if (hostMemoryReserveMib < 0) {
    throw new WorkflowError(
      'workflow_parse_error',
      'agent.host_memory_reserve_mib must be a non-negative integer',
    );
  }
  // Circuit breaker (issue 128). Default 5: after five consecutive identical
  // failures the orchestrator stops retrying and routes the issue to a holding
  // state. 0 disables the breaker; 1 would trip on the first failure (no retry
  // ever), which is rarely wanted, so the parser rejects it as a likely
  // misconfiguration — use 0 to disable or >= 2 to bound the loop.
  const circuitBreakerThreshold = asInt(agentRaw['circuit_breaker_threshold'], 5);
  if (circuitBreakerThreshold < 0 || circuitBreakerThreshold === 1) {
    throw new WorkflowError(
      'workflow_parse_error',
      'agent.circuit_breaker_threshold must be 0 (disabled) or an integer >= 2',
    );
  }
  const agent: AgentConfig = {
    max_concurrent_agents: asInt(agentRaw['max_concurrent_agents'], 10),
    max_turns: maxTurns,
    max_retry_backoff_ms: asInt(agentRaw['max_retry_backoff_ms'], 300_000),
    max_concurrent_agents_by_state: asMapStrPosInt(agentRaw['max_concurrent_agents_by_state']),
    memory_admission_enabled: memoryAdmissionEnabled,
    host_memory_reserve_mib: hostMemoryReserveMib,
    circuit_breaker_threshold: circuitBreakerThreshold,
  };

  // Migration (issue 137): per-state concurrency now lives on the state as
  // `states.<name>.max_concurrent`. Keep reading the deprecated by-name map
  // `agent.max_concurrent_agents_by_state` for one release — fold each entry
  // into the matching state's `max_concurrent` (per-state values win on
  // conflict) and log a single deprecation warning so the orchestrator only
  // ever reads the per-state field. Removed once dogfooding workflows migrate.
  foldLegacyConcurrencyCaps(states, agent.max_concurrent_agents_by_state);

  // acp (Symphony extension; see §4.3.6). `adapter` selects
  // one of symphony's known profiles (claude, codex, opencode); symphony auto-derives the
  // launch command from the adapter profile. Credentials are NOT staged into the workspace:
  // the guest only ever holds a token-shaped placeholder, and the host substitutes the real
  // upstream token into the outbound request at Gondolin egress (TLS-MITM via
  // `createHttpHooks` in src/agent/credential-secrets.ts). The real host credential
  // (`~/.claude/.credentials.json` for claude; `~/.codex/auth.json` access token or
  // `OPENAI_API_KEY` for codex; the GitHub Copilot token exchanged from
  // `~/.local/share/opencode/auth.json` for opencode) never enters the VM.
  //
  // `acp.bridge` configures the host-side TCP listener that the in-VM agent dials back
  // to for ACP traffic. The bridge replaced the earlier in-VM-exec stdio path; see
  // src/acp-bridge.ts for rationale.
  const acpRaw = getObject(raw, 'acp');
  const bridgeRaw = getObject(acpRaw, 'bridge');
  const modelRaw = asString(acpRaw['model']);
  const modelTrimmed = modelRaw === null ? null : modelRaw.trim();
  const effortRaw = asString(acpRaw['effort']);
  const effortTrimmed = effortRaw === null ? null : effortRaw.trim();
  const acp: AcpConfig = {
    adapter: asString(acpRaw['adapter']) ?? 'claude',
    model: modelTrimmed && modelTrimmed.length > 0 ? modelTrimmed : null,
    effort: effortTrimmed && effortTrimmed.length > 0 ? effortTrimmed : null,
    shell: asString(acpRaw['shell']) ?? 'bash',
    prompt_timeout_ms: asInt(acpRaw['prompt_timeout_ms'], 3_600_000),
    read_timeout_ms: asInt(acpRaw['read_timeout_ms'], 30_000),
    stall_timeout_ms: asInt(acpRaw['stall_timeout_ms'], 300_000),
    bridge: {
      bind_host: asString(bridgeRaw['bind_host']) ?? '0.0.0.0',
      bind_port: asInt(bridgeRaw['bind_port'], 8788),
      reach_host: asString(bridgeRaw['reach_host']) ?? '127.0.0.1',
      reach_url: asString(bridgeRaw['reach_url']),
      connect_timeout_ms: asInt(bridgeRaw['connect_timeout_ms'], 30_000),
    },
  };

  // credentials extension (issue 113). Defaults work out of the box for the
  // common case: run the host ticker every 6 hours.
  const credentialsRaw = getObject(raw, 'credentials');
  const credentials: CredentialsConfig = {
    ticker_interval_ms: asInt(credentialsRaw['ticker_interval_ms'], 6 * 60 * 60 * 1000),
  };

  // gondolin VM extension
  const gondolinRaw = getObject(raw, 'gondolin');
  const volumesRaw = gondolinRaw['volumes'];
  const volumes = Array.isArray(volumesRaw)
    ? volumesRaw.flatMap((v) => {
        if (!v || typeof v !== 'object' || Array.isArray(v)) return [];
        const m = v as Record<string, unknown>;
        const hostRaw = asString(m['host']);
        const guest = asString(m['guest']);
        if (!hostRaw || !guest) return [];
        const expandedHost = expandVar(hostRaw, env);
        if (expandedHost === '') return [];
        const host = path.isAbsolute(expandedHost)
          ? expandedHost
          : path.resolve(workflowDir, expandedHost);
        const readonly = m['readonly'] === true;
        return [{ host, guest, readonly }];
      })
    : [];
  const gondolin: GondolinConfig = {
    image: asString(gondolinRaw['image']),
    cpus: asInt(gondolinRaw['cpus'], 2),
    mem_mib: asInt(gondolinRaw['mem_mib'], 2048),
    volumes,
    // `forward_env` is forwarded into the VM boot env, but the runner strips EVERY
    // credential-bearing var (`stripCredentialEnv`) before boot — the guest holds
    // only the token-shaped placeholder Gondolin substitutes at egress, never a real
    // key. So even if an operator lists `OPENAI_API_KEY` here, it never reaches a VM.
    // The defaults are retained for any future forward-env-strategy adapter.
    forward_env: asStringList(gondolinRaw['forward_env'], [
      'OPENAI_API_KEY',
      'ANTHROPIC_API_KEY',
    ]),
  };

  // egress firewall: the general dev-tooling allowlist the in-VM agent may reach
  // (npm/git/CDNs) for gates. DISTINCT from the credential layer's per-adapter
  // substitution hosts — nothing listed here ever gets a real token substituted
  // (see credential-secrets.ts buildAdapterHooksConfig). Empty default: the agent
  // can reach only each adapter's inference host until the operator opts hosts in.
  const egressRaw = getObject(raw, 'egress');
  const egress: EgressConfig = {
    allowed_hosts: asStringList(egressRaw['allowed_hosts'], []),
  };

  // server extension (§9.5)
  const serverRaw = getObject(raw, 'server');
  const server: ServerConfig = {
    port: typeof serverRaw['port'] === 'number' ? (serverRaw['port'] as number) : null,
    host: asString(serverRaw['host']) ?? '127.0.0.1',
  };

  // mcp extension: per-issue MCP server (transition + request_human_steering + propose_issue
  // tools) injected into each ACP session. `host` defaults to the QEMU slirp gateway; the port is the
  // actually-bound HTTP server's port (resolved at runtime, not config-parse time, so
  // `--port` and an unset server.port can never desync). `host_url` is an explicit full-URL
  // override for cases where the VM can't reach the orchestrator via the host gateway.
  const mcpRaw = getObject(raw, 'mcp');
  const mcpEnabledRaw = mcpRaw['enabled'];
  const mcpEnabled = mcpEnabledRaw === undefined ? true : mcpEnabledRaw !== false;
  const mcp: McpConfig = {
    enabled: mcpEnabled,
    // 127.0.0.1 works because Gondolin maps a synthetic guest host to the host's
    // loopback (`tcp.hosts`). (Empirically verified;
    // 10.0.2.2 — the QEMU slirp gateway — is NOT reachable here.) Other VMMs
    // can override via the `host` field in the WORKFLOW.md mcp block.
    host: asString(mcpRaw['host']) ?? '127.0.0.1',
    explicit_host_url: asString(mcpRaw['host_url']),
  };

  // pr (issue 38, slimmed in issue 139). Optional block; default off. The slim
  // host-global engine toggle: `pr: { enabled, poll_interval_ms }`. The
  // merge/close/route targets and auto-merge strategy live ON the terminal
  // states they describe (`states.<name>.pr`, parsed in parseStatesBlock) and
  // are derived by scanning states (`derivePrRouting`), never named here.
  //
  // Migration (one release): a legacy top-level `pr_autopilot:` block is folded
  // onto the states it named (foldLegacyPrAutopilot) with a deprecation warning;
  // its engine half (enabled / poll) fills the new `pr:` block when that block
  // is absent. The new `pr:` block wins on conflict.
  const prRaw = getObject(raw, 'pr');
  const prKeyPresent = Object.prototype.hasOwnProperty.call(raw, 'pr');
  const legacyRaw = getObject(raw, 'pr_autopilot');
  const legacyKeyPresent = Object.prototype.hasOwnProperty.call(raw, 'pr_autopilot');

  foldLegacyPrAutopilot(states, legacyRaw, legacyKeyPresent);

  // enabled: new `pr:` wins; else legacy `pr_autopilot.enabled`; else false.
  const prEnabled = prKeyPresent
    ? prRaw['enabled'] === true
    : legacyKeyPresent
      ? legacyRaw['enabled'] === true
      : false;
  // poll TTL: new `pr:` wins; else legacy; else 30000.
  const legacyPoll = legacyKeyPresent ? asInt(legacyRaw['poll_interval_ms'], 30_000) : 30_000;
  const pollIntervalMs = prKeyPresent ? asInt(prRaw['poll_interval_ms'], legacyPoll) : legacyPoll;
  const pr: PrConfig = { enabled: prEnabled, poll_interval_ms: pollIntervalMs };
  if (pr.poll_interval_ms < 0) {
    throw new WorkflowError('workflow_parse_error', 'pr.poll_interval_ms must be non-negative');
  }

  // Derived compatibility view for mcp.ts + bin/symphony.ts (out of this
  // issue's allowed_paths). Routing comes from the state scan; enabled/poll
  // mirror the engine toggle. A follow-up migrates those consumers to read
  // `pr` + `derivePrRouting` directly and deletes this struct.
  const routing = derivePrRouting(states);
  const prAutopilot: PrAutopilotConfig = {
    enabled: pr.enabled,
    merge_state: routing.mergeState ?? '',
    close_state: routing.closeState,
    conflict_route_to: routing.conflictRouteTo,
    auto_merge_strategy: routing.strategy,
    poll_interval_ms: pr.poll_interval_ms,
  };

  const sleepCycle = parseSleepCycle(raw);

  return {
    workflow_path: workflowAbs,
    workflow_dir: workflowDir,
    tracker,
    polling,
    workspace,
    logs,
    hooks,
    agent,
    acp,
    gondolin,
    egress,
    server,
    mcp,
    pr,
    pr_autopilot: prAutopilot,
    sleep_cycle: sleepCycle,
    credentials,
    states,
  };
}

// sleep_cycle (issue 125, follow-up to 122). Optional block; default off. When
// enabled the orchestrator auto-arms the recurring reflection issue (Dormant →
// Reflect) on idle or after N terminal-state transitions. State-name fields are
// normalized here and cross-referenced against the declared states map in
// `validateDispatch` (only when enabled), so an undeclared/wrong-role name gives
// a clearer error than a runtime lookup failure. `arm_on_idle` defaults to true;
// the explicit `false` keyword disables the idle trigger while leaving the
// done-threshold one available.
function parseSleepCycle(raw: Record<string, unknown>): SleepCycleConfig {
  const sleepRaw = getObject(raw, 'sleep_cycle');
  const issueIdRaw = asString(sleepRaw['issue_id']);
  const issueId = issueIdRaw && issueIdRaw.trim().length > 0 ? issueIdRaw.trim() : null;
  const dormantRaw = asString(sleepRaw['dormant_state']);
  const reflectRaw = asString(sleepRaw['reflect_state']);
  const armOnIdleRaw = sleepRaw['arm_on_idle'];
  const armAfterDone = asInt(sleepRaw['arm_after_done'], 0);
  if (armAfterDone < 0) {
    throw new WorkflowError(
      'workflow_parse_error',
      'sleep_cycle.arm_after_done must be a non-negative integer (0 disables the done-count trigger)',
    );
  }
  return {
    enabled: sleepRaw['enabled'] === true,
    issue_id: issueId,
    dormant_state: dormantRaw && dormantRaw.trim().length > 0 ? dormantRaw.trim() : 'Dormant',
    reflect_state: reflectRaw && reflectRaw.trim().length > 0 ? reflectRaw.trim() : 'Reflect',
    arm_on_idle: armOnIdleRaw === undefined ? true : armOnIdleRaw !== false,
    arm_after_done: armAfterDone,
  };
}

// Parse the top-level `states:` block. The block is mandatory: every workflow
// must declare at least one `active`, one `terminal`, and one `holding` state
// (validation happens in `validateStates`). Insertion order matters —
// downstream consumers (dashboard, role-filtered active/terminal listings)
// follow declaration order — so we build a plain object incrementally rather
// than reconstructing via `Object.fromEntries`.
function parseStatesBlock(raw: unknown): Record<string, StateConfig> {
  if (raw === undefined || raw === null) {
    throw new WorkflowError(
      'workflow_parse_error',
      'workflow YAML must declare a top-level `states:` block with at least one active, one terminal, and one holding state. See WORKFLOW.template.md for the schema.',
    );
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new WorkflowError('workflow_parse_error', 'states: must be a map of name → config');
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length === 0) {
    throw new WorkflowError(
      'workflow_parse_error',
      'workflow YAML `states:` block is empty; declare at least one active, one terminal, and one holding state. See WORKFLOW.template.md for the schema.',
    );
  }
  const out: Record<string, StateConfig> = {};
  for (const [name, value] of entries) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new WorkflowError(
        'workflow_parse_error',
        `state "${name}": value must be a map`,
      );
    }
    const m = value as Record<string, unknown>;
    const roleRaw = asString(m['role']);
    if (roleRaw !== 'active' && roleRaw !== 'terminal' && roleRaw !== 'holding') {
      throw new WorkflowError(
        'workflow_parse_error',
        `state "${name}": role must be one of active|terminal|holding (got: ${String(m['role'])})`,
      );
    }
    const adapter = asString(m['adapter']);
    const modelRaw = asString(m['model']);
    const modelTrimmed = modelRaw === null ? undefined : modelRaw.trim();
    const model =
      modelTrimmed === undefined ? undefined : modelTrimmed.length > 0 ? modelTrimmed : null;
    // Same undefined-vs-null semantics as `model`: a missing key inherits the
    // workflow-level `acp.effort`; a blank/whitespace string normalizes to null
    // (an explicit "use the adapter default for this state" signal).
    const effortRaw = asString(m['effort']);
    const effortTrimmed = effortRaw === null ? undefined : effortRaw.trim();
    const effort =
      effortTrimmed === undefined ? undefined : effortTrimmed.length > 0 ? effortTrimmed : null;
    let maxTurns: number | undefined;
    if (m['max_turns'] !== undefined) {
      const n = asInt(m['max_turns'], -1);
      if (n <= 0) {
        throw new WorkflowError(
          'workflow_parse_error',
          `state "${name}": max_turns must be a positive integer`,
        );
      }
      maxTurns = n;
    }
    // Per-state concurrency cap (issue 137) — same positive-integer validation
    // as max_turns. Undefined when omitted (no per-state cap; only the global
    // agent.max_concurrent_agents ceiling applies).
    let maxConcurrent: number | undefined;
    if (m['max_concurrent'] !== undefined) {
      const n = asInt(m['max_concurrent'], -1);
      if (n <= 0) {
        throw new WorkflowError(
          'workflow_parse_error',
          `state "${name}": max_concurrent must be a positive integer`,
        );
      }
      maxConcurrent = n;
    }
    let allowed: string[] | null | undefined;
    if (m['allowed_transitions'] === undefined) {
      allowed = undefined;
    } else if (m['allowed_transitions'] === null) {
      allowed = null;
    } else if (Array.isArray(m['allowed_transitions'])) {
      allowed = (m['allowed_transitions'] as unknown[]).filter(
        (x): x is string => typeof x === 'string',
      );
    } else {
      throw new WorkflowError(
        'workflow_parse_error',
        `state "${name}": allowed_transitions must be a list of state names (or null/omitted)`,
      );
    }
    const stateHooks = parseStateHooksBlock(name, m['hooks']);
    const stateActions = parseActionsBlock(name, m['actions']);
    // eval_mode is a strict boolean opt-in: only true enables it, any other
    // value (including undefined, null, "true" string) leaves it off. Strict
    // typing here matches the rest of the YAML-flag plumbing in the parser
    // and stops a YAML-quoting accident ("true") from silently enabling the
    // mounts.
    const evalModeRaw = m['eval_mode'];
    if (evalModeRaw !== undefined && typeof evalModeRaw !== 'boolean') {
      throw new WorkflowError(
        'workflow_parse_error',
        `state "${name}": eval_mode must be a boolean (true/false)`,
      );
    }
    const statePr = parseStatePrBlock(name, m['pr']);
    const sc: StateConfig = { role: roleRaw };
    if (adapter !== null) sc.adapter = adapter;
    if (model !== undefined) sc.model = model;
    if (effort !== undefined) sc.effort = effort;
    if (maxTurns !== undefined) sc.max_turns = maxTurns;
    if (maxConcurrent !== undefined) sc.max_concurrent = maxConcurrent;
    if (allowed !== undefined) sc.allowed_transitions = allowed;
    if (stateHooks !== undefined) sc.hooks = stateHooks;
    if (stateActions !== undefined) sc.actions = stateActions;
    if (evalModeRaw === true) sc.eval_mode = true;
    if (statePr !== undefined) sc.pr = statePr;
    out[name] = sc;
  }
  return out;
}

/**
 * Fold the deprecated `agent.max_concurrent_agents_by_state` by-name map into
 * each matching state's `max_concurrent` (issue 137). Mutates the states map in
 * place. Per-state `max_concurrent` wins on conflict — a legacy entry only fills
 * a state that declares no explicit cap. The legacy map's keys are already
 * lowercased (`asMapStrPosInt`); match them case-insensitively against the
 * declared state names. Emits a single deprecation warning when the map is
 * non-empty so the operator knows to move the cap onto the state. After this
 * runs the orchestrator only ever reads `states.<name>.max_concurrent`.
 */
function foldLegacyConcurrencyCaps(
  states: Record<string, StateConfig>,
  legacyByState: Record<string, number>,
): void {
  const entries = Object.entries(legacyByState);
  if (entries.length === 0) return;
  log.warn(
    'agent.max_concurrent_agents_by_state is deprecated; move the cap onto states.<name>.max_concurrent (per-state values win on conflict)',
    { states: entries.map(([name]) => name) },
  );
  for (const [lowerName, cap] of entries) {
    for (const [name, state] of Object.entries(states)) {
      if (name.toLowerCase() === lowerName) {
        if (state.max_concurrent === undefined) state.max_concurrent = cap;
        break;
      }
    }
  }
}

/**
 * Per-state `pr:` block (issue 139). Optional, valid on a terminal state.
 * `auto_merge` (squash|merge|rebase) marks the merge state and picks the
 * `gh pr merge --auto` strategy; `on_conflict.route_to` names the active state
 * a non-mergeable PR is routed back into; `close: true` marks the close state.
 * Returns `undefined` when the block is absent or declares nothing meaningful
 * (so an empty `pr: {}` doesn't shadow a legacy fold). The structural shape is
 * validated here; the cross-reference (route_to is a declared state, pr only on
 * terminal states, merge/close uniqueness) is in `validateStates`.
 */
function parseStatePrBlock(stateName: string, raw: unknown): StatePrConfig | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new WorkflowError(
      'workflow_parse_error',
      `state "${stateName}": pr must be a map (auto_merge / on_conflict / close)`,
    );
  }
  const m = raw as Record<string, unknown>;
  const out: StatePrConfig = {};
  if (m['auto_merge'] !== undefined && m['auto_merge'] !== null) {
    const s = asString(m['auto_merge']);
    if (s !== 'squash' && s !== 'merge' && s !== 'rebase') {
      throw new WorkflowError(
        'workflow_parse_error',
        `state "${stateName}": pr.auto_merge must be one of squash|merge|rebase`,
      );
    }
    out.auto_merge = s;
  }
  if (m['on_conflict'] !== undefined && m['on_conflict'] !== null) {
    const oc = m['on_conflict'];
    if (typeof oc !== 'object' || Array.isArray(oc)) {
      throw new WorkflowError(
        'workflow_parse_error',
        `state "${stateName}": pr.on_conflict must be a map with a route_to field`,
      );
    }
    const routeTo = asString((oc as Record<string, unknown>)['route_to']);
    if (!routeTo || routeTo.trim().length === 0) {
      throw new WorkflowError(
        'workflow_parse_error',
        `state "${stateName}": pr.on_conflict.route_to must be a non-empty state name`,
      );
    }
    out.on_conflict = { route_to: routeTo.trim() };
  }
  if (m['close'] !== undefined && m['close'] !== null) {
    if (typeof m['close'] !== 'boolean') {
      throw new WorkflowError(
        'workflow_parse_error',
        `state "${stateName}": pr.close must be a boolean`,
      );
    }
    if (m['close'] === true) out.close = true;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Derive the PR autopilot routing by scanning states for the per-state `pr:`
 * field (issue 139) — the replacement for the old `pr_autopilot:` named
 * strings. The merge state is the terminal state declaring `pr.auto_merge`
 * (its strategy + `on_conflict.route_to` come along); the close state is the
 * terminal state declaring `pr.close: true`. First match wins; `validateStates`
 * enforces at-most-one of each so the choice is unambiguous at dispatch time.
 * Pure: a plain scan over the states map, no IO. The reconciler and the
 * orchestrator's PR intent provider call this to get their targets.
 */
export interface PrRouting {
  mergeState: string | null;
  closeState: string | null;
  conflictRouteTo: string | null;
  strategy: 'squash' | 'merge' | 'rebase';
}

export function derivePrRouting(states: Record<string, StateConfig>): PrRouting {
  let mergeState: string | null = null;
  let closeState: string | null = null;
  let conflictRouteTo: string | null = null;
  let strategy: 'squash' | 'merge' | 'rebase' = 'squash';
  for (const [name, sc] of Object.entries(states)) {
    if (sc.role !== 'terminal' || !sc.pr) continue;
    if (sc.pr.auto_merge && mergeState === null) {
      mergeState = name;
      strategy = sc.pr.auto_merge;
      conflictRouteTo = sc.pr.on_conflict?.route_to ?? null;
    }
    if (sc.pr.close && closeState === null) {
      closeState = name;
    }
  }
  return { mergeState, closeState, conflictRouteTo, strategy };
}

/**
 * Fold a deprecated top-level `pr_autopilot:` block onto the states it named
 * (issue 139). Mirrors {@link foldLegacyConcurrencyCaps}: the routing that used
 * to live as named strings (`merge_state` / `close_state` / `conflict_route_to`
 * / `auto_merge_strategy`) is injected onto the matching state's `pr:` field so
 * the state scan (`derivePrRouting`) is the single runtime source of truth. A
 * state that already declares `pr:` wins on conflict (its config is not
 * overwritten). Emits one deprecation warning when the block is present. The
 * engine half (enabled / poll_interval_ms) is handled by the caller. The legacy
 * close_state defaults to 'Cancelled' when the key is absent but is disabled by
 * an explicit null/empty/blank value — preserving the old parser's semantics.
 * A legacy name that matches no declared state is a silent no-op (the block is
 * deprecated; the operator's warning points at the new shape).
 */
function foldLegacyPrAutopilot(
  states: Record<string, StateConfig>,
  legacyRaw: Record<string, unknown>,
  present: boolean,
): void {
  if (!present) return;
  log.warn(
    'pr_autopilot: is deprecated; declare the engine toggle in `pr: { enabled, poll_interval_ms }` and the routing on terminal states as `states.<name>.pr` (auto_merge / on_conflict.route_to / close)',
    {},
  );
  const mergeRaw = asString(legacyRaw['merge_state']);
  const mergeState = mergeRaw && mergeRaw.trim().length > 0 ? mergeRaw.trim() : 'Done';
  const strategyRaw = asString(legacyRaw['auto_merge_strategy']) ?? 'squash';
  const strategy: 'squash' | 'merge' | 'rebase' =
    strategyRaw === 'merge' || strategyRaw === 'rebase' ? strategyRaw : 'squash';
  const conflictRaw = asString(legacyRaw['conflict_route_to']);
  const conflictRouteTo =
    conflictRaw && conflictRaw.trim().length > 0 ? conflictRaw.trim() : null;
  injectStatePr(states, mergeState, (pr) => {
    pr.auto_merge = strategy;
    if (conflictRouteTo) pr.on_conflict = { route_to: conflictRouteTo };
  });

  const closeKeyPresent = Object.prototype.hasOwnProperty.call(legacyRaw, 'close_state');
  const closeTrimmed = asString(legacyRaw['close_state'])?.trim() ?? '';
  const closeState: string | null = closeKeyPresent
    ? closeTrimmed.length > 0
      ? closeTrimmed
      : null
    : 'Cancelled';
  if (closeState) {
    injectStatePr(states, closeState, (pr) => {
      pr.close = true;
    });
  }
}

/**
 * Inject a derived `pr:` block onto the (case-insensitively) named state, but
 * only when that state declares no `pr:` of its own — state-level config always
 * wins over a folded legacy value. No-op when the name matches no state.
 */
function injectStatePr(
  states: Record<string, StateConfig>,
  name: string,
  set: (pr: StatePrConfig) => void,
): void {
  const lower = name.toLowerCase();
  for (const [stateName, sc] of Object.entries(states)) {
    if (stateName.toLowerCase() !== lower) continue;
    if (sc.pr) return;
    const pr: StatePrConfig = {};
    set(pr);
    sc.pr = pr;
    return;
  }
}

// Per-state `hooks:` block. Each field is optional and accepts either a script string
// or `null` to mean "explicitly suppress this hook for this state". A missing key falls
// through to the workflow-level hook of the same name at resolution time.
function parseStateHooksBlock(stateName: string, raw: unknown): StateHooksConfig | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new WorkflowError(
      'workflow_parse_error',
      `state "${stateName}": hooks must be a map of hook name → script (or null/omitted)`,
    );
  }
  const m = raw as Record<string, unknown>;
  const out: StateHooksConfig = {};
  // `after_run` is no longer a hook kind (the Done-state push + PR-create handoff
  // is a typed `actions:` block now). A state that still declares it is warned and
  // its value is dropped on the floor; the three remaining hook kinds keep working.
  if (Object.prototype.hasOwnProperty.call(m, 'after_run')) {
    log.warn(
      'state hooks.after_run is deprecated and ignored; migrate to a Done-state actions: block',
      { state: stateName },
    );
  }
  const fields: Array<keyof StateHooksConfig> = [
    'after_create',
    'before_run',
    'before_remove',
  ];
  for (const name of fields) {
    if (!Object.prototype.hasOwnProperty.call(m, name)) continue;
    const v = m[name];
    if (v === null) {
      out[name] = null;
    } else if (typeof v === 'string') {
      out[name] = v;
    } else {
      throw new WorkflowError(
        'workflow_parse_error',
        `state "${stateName}": hooks.${name} must be a string or null`,
      );
    }
  }
  return out;
}

/**
 * Resolve the typed action list a given state should run on transition-in.
 * Mirrors {@link resolveHooksForState}'s case-insensitive lookup but returns
 * the parsed `WorkflowAction[]` (or undefined when the state has no actions
 * block). The runner consults this instead of `after_run` when present.
 */
export function resolveActionsForState(
  cfg: ServiceConfig,
  stateName: string,
): WorkflowAction[] | undefined {
  const states = cfg.states;
  let key: string | null = null;
  if (Object.prototype.hasOwnProperty.call(states, stateName)) {
    key = stateName;
  } else {
    const lower = stateName.toLowerCase();
    for (const name of Object.keys(states)) {
      if (name.toLowerCase() === lower) {
        key = name;
        break;
      }
    }
  }
  if (key === null) return undefined;
  return states[key]!.actions;
}

// Effective hooks for an issue currently in `stateName`. Per-state hook fields override
// the workflow-level ones; absent fields fall through. An explicit `null` in a state's
// hooks block suppresses that hook for the state even if the workflow declares it. The
// shared `timeout_ms` is always the workflow-level value — it bounds runtime cost, not
// behavior, and states are not allowed to weaken or strengthen it.
export function resolveHooksForState(cfg: ServiceConfig, stateName: string): HooksConfig {
  const base = cfg.hooks;
  const states = cfg.states;
  let key: string | null = null;
  if (Object.prototype.hasOwnProperty.call(states, stateName)) {
    key = stateName;
  } else {
    const lower = stateName.toLowerCase();
    for (const name of Object.keys(states)) {
      if (name.toLowerCase() === lower) {
        key = name;
        break;
      }
    }
  }
  if (key === null) return base;
  const sh = states[key]!.hooks;
  if (!sh) return base;
  const pick = (k: keyof StateHooksConfig): string | null =>
    Object.prototype.hasOwnProperty.call(sh, k) ? sh[k] ?? null : base[k];
  return {
    after_create: pick('after_create'),
    before_run: pick('before_run'),
    // `after_run` is no longer a live hook kind; the parser drops it. The field
    // stays on HooksConfig so existing test fixtures and the workspace helper's
    // method signature keep type-checking — it is permanently null at runtime.
    after_run: null,
    before_remove: pick('before_remove'),
    timeout_ms: base.timeout_ms,
  };
}

/**
 * Detect states that declare BOTH `hooks:` and `actions:`. The actions list
 * wins on those states (issue 36 AC2); we emit a single startup-time warning
 * per state so the operator knows the `hooks:` block is being ignored. Pure
 * function so the same surface is reachable from tests without the side
 * effect of the global log. Returns the list of (state, hook-fields) tuples
 * the caller can render however it likes; the production caller logs at
 * warn via {@link warnOnHooksAndActionsConflict}.
 */
export function findHooksAndActionsConflicts(
  cfg: ServiceConfig,
): Array<{ state: string; hook_fields: string[] }> {
  const out: Array<{ state: string; hook_fields: string[] }> = [];
  for (const [name, sc] of Object.entries(cfg.states)) {
    if (!sc.actions || sc.actions.length === 0) continue;
    const hooks = sc.hooks;
    if (!hooks) continue;
    const setFields: string[] = [];
    // `after_run` is parsed-and-dropped (see parseStateHooksBlock); only the
    // three live hook kinds can conflict with an `actions:` block now.
    for (const k of ['after_create', 'before_run', 'before_remove'] as const) {
      if (Object.prototype.hasOwnProperty.call(hooks, k) && hooks[k] !== null && hooks[k] !== undefined) {
        setFields.push(k);
      }
    }
    if (setFields.length > 0) out.push({ state: name, hook_fields: setFields });
  }
  return out;
}

/**
 * Log a deprecation warning for every state that declares both `hooks:` and
 * `actions:`. Called from the orchestrator at startup so the warning fires
 * before the first dispatch into a terminal state. The action-list wins
 * silently in the runtime; this surface is the operator-visible "we saw
 * your hook and ignored it" signal.
 */
export function warnOnHooksAndActionsConflict(cfg: ServiceConfig): void {
  const conflicts = findHooksAndActionsConflicts(cfg);
  for (const c of conflicts) {
    log.warn('state declares both `hooks:` and `actions:`; running actions and ignoring hooks (deprecated)', {
      state: c.state,
      ignored_hook_fields: c.hook_fields,
    });
  }
}

// Dispatch preflight validation (structural, pure). The fs-touching probes —
// `tracker.root` existence and the adapter credential files — live in the shell
// loader's `validateDispatchIo`, which the orchestrator calls alongside this
// function. Both adapters are startup-probed: claude requires a single readable
// host file (`~/.claude/.credentials.json`); codex passes when either
// `~/.codex/auth.json` holds a token (ChatGPT-OAuth `tokens.access_token` or a
// top-level `OPENAI_API_KEY`) or the host `OPENAI_API_KEY` env var is set. Keeping this
// structural half pure means tests and the reload tick can re-run it cheaply on
// every reconcile without re-hitting the disk.
export function validateDispatch(cfg: ServiceConfig): string | null {
  if (cfg.tracker.kind !== 'local') {
    return `unsupported_tracker_kind: ${cfg.tracker.kind || '<missing>'}`;
  }
  if (!cfg.tracker.root) return 'tracker.root must be set for local tracker';
  // `cfg.states` is always populated by buildServiceConfig — the parser refuses
  // workflows without a `states:` block — so callers never need a fallback here.
  const statesError = validateStates(cfg.states);
  if (statesError) return statesError;
  // cfg.agent is always populated by buildServiceConfig; guard for legacy
  // hand-built ServiceConfigs (older test fixtures) that omit the block.
  const concurrencyError = validateConcurrencyCaps(cfg.states, cfg.agent?.max_concurrent_agents);
  if (concurrencyError) return concurrencyError;
  if (!isKnownAdapter(cfg.acp.adapter)) {
    return `acp.adapter "${cfg.acp.adapter}" is not a known profile; use one of: claude, codex, opencode`;
  }
  // PR autopilot routing (issue 139) is validated structurally inside
  // `validateStates` (pr: only on terminal states; on_conflict.route_to must be
  // a declared state; at most one merge/close state). The state's own `role` is
  // authoritative, so the old `validatePrAutopilot` role re-validator is gone.
  // sleep_cycle is always populated by buildServiceConfig, but legacy
  // hand-built ServiceConfigs (older test fixtures) may omit it; treat a
  // missing block as disabled so those fixtures keep validating.
  if (cfg.sleep_cycle && cfg.sleep_cycle.enabled) {
    const scError = validateSleepCycle(cfg.sleep_cycle, cfg.states);
    if (scError) return scError;
  }
  return null;
}

/**
 * Cross-reference the sleep_cycle block against the declared states map. Only
 * fires when `sleep_cycle.enabled` is true so a workflow that hasn't opted in
 * isn't gated on the reflection issue id or the state names. The dormant state
 * must be `holding` (the reflection issue rests there, never dispatched) and the
 * reflect state must be `active` (so the armed issue is picked up on the next
 * poll). `issue_id` must be set — without it the orchestrator has nothing to arm.
 */
function validateSleepCycle(
  cfg: SleepCycleConfig,
  states: Record<string, StateConfig>,
): string | null {
  if (!cfg.issue_id) {
    return 'sleep_cycle.issue_id is required when sleep_cycle.enabled is true';
  }
  const byLower = new Map<string, string>();
  for (const name of Object.keys(states)) byLower.set(name.toLowerCase(), name);

  const dormantCanonical = byLower.get(cfg.dormant_state.toLowerCase());
  if (!dormantCanonical) {
    return `sleep_cycle.dormant_state references undeclared state "${cfg.dormant_state}"`;
  }
  if (states[dormantCanonical]!.role !== 'holding') {
    return `sleep_cycle.dormant_state "${cfg.dormant_state}" must be a holding state (got role: ${states[dormantCanonical]!.role})`;
  }

  const reflectCanonical = byLower.get(cfg.reflect_state.toLowerCase());
  if (!reflectCanonical) {
    return `sleep_cycle.reflect_state references undeclared state "${cfg.reflect_state}"`;
  }
  if (states[reflectCanonical]!.role !== 'active') {
    return `sleep_cycle.reflect_state "${cfg.reflect_state}" must be an active state (got role: ${states[reflectCanonical]!.role})`;
  }

  return null;
}

/**
 * Validate that the sum of per-state `max_concurrent` caps does not exceed the
 * global `agent.max_concurrent_agents` host ceiling (issue 137). A sum greater
 * than the ceiling can never be satisfied — the global clamp binds first — so it
 * is almost always a misconfiguration worth surfacing at startup. Returns null
 * when in budget or when the ceiling is unknown (legacy hand-built configs that
 * omit `agent`). The legacy by-name map is already folded into the per-state
 * caps by the time this runs, so its entries count toward the sum too.
 */
function validateConcurrencyCaps(
  states: Record<string, StateConfig>,
  ceiling: number | undefined,
): string | null {
  if (typeof ceiling !== 'number') return null;
  let sum = 0;
  for (const sc of Object.values(states)) {
    if (typeof sc.max_concurrent === 'number') sum += sc.max_concurrent;
  }
  if (sum > ceiling) {
    return `sum of per-state max_concurrent caps (${sum}) exceeds agent.max_concurrent_agents (${ceiling})`;
  }
  return null;
}

// State-map validation, exposed as a string|null so it composes with the rest of
// `validateDispatch`. Checks declared in the same order the operator would hit
// them while iterating on a malformed workflow: structural (roles, uniqueness),
// then cross-references (allowed_transitions targets), then host-resource
// dependencies (adapter known + credential readable).
function validateStates(states: Record<string, StateConfig>): string | null {
  const names = Object.keys(states);
  if (names.length === 0) return 'states: at least one state must be declared';
  let hasActive = false;
  let hasTerminal = false;
  let hasHolding = false;
  for (const cfg of Object.values(states)) {
    if (cfg.role === 'active') hasActive = true;
    else if (cfg.role === 'terminal') hasTerminal = true;
    else if (cfg.role === 'holding') hasHolding = true;
  }
  if (!hasActive) return 'states: at least one state must have role: active';
  if (!hasTerminal) return 'states: at least one state must have role: terminal';
  // `holding` is required so `propose_issue` always has a declared landing
  // directory; the dashboard's triage approve/discard surface also needs it.
  if (!hasHolding) return 'states: at least one state must have role: holding';
  const seen = new Map<string, string>();
  for (const name of names) {
    const key = name.toLowerCase();
    const prior = seen.get(key);
    if (prior !== undefined) {
      return `states: duplicate state name (case-insensitive): "${prior}" and "${name}"`;
    }
    seen.set(key, name);
  }
  // PR autopilot routing (issue 139): `pr:` is only meaningful on a terminal
  // state, `on_conflict.route_to` must name a declared state, and at most one
  // terminal state may declare the merge (`auto_merge`) or close (`close`)
  // behavior so `derivePrRouting`'s first-match is unambiguous.
  let mergeStateCount = 0;
  let closeStateCount = 0;
  for (const [name, cfg] of Object.entries(states)) {
    if (cfg.allowed_transitions) {
      for (const target of cfg.allowed_transitions) {
        if (!seen.has(target.toLowerCase())) {
          return `state "${name}": allowed_transitions references undeclared state "${target}"`;
        }
      }
    }
    if (cfg.adapter !== undefined && !isKnownAdapter(cfg.adapter)) {
      return `state "${name}": adapter "${cfg.adapter}" is not a known profile; use one of: claude, codex, opencode`;
    }
    if (cfg.pr) {
      if (cfg.role !== 'terminal') {
        return `state "${name}": pr: is only valid on a terminal state (got role: ${cfg.role})`;
      }
      if (cfg.pr.auto_merge) mergeStateCount += 1;
      if (cfg.pr.close) closeStateCount += 1;
      const routeTo = cfg.pr.on_conflict?.route_to;
      if (routeTo && !seen.has(routeTo.toLowerCase())) {
        return `state "${name}": pr.on_conflict.route_to references undeclared state "${routeTo}"`;
      }
    }
  }
  if (mergeStateCount > 1) {
    return `states: at most one terminal state may declare pr.auto_merge (found ${mergeStateCount})`;
  }
  if (closeStateCount > 1) {
    return `states: at most one terminal state may declare pr.close (found ${closeStateCount})`;
  }
  return null;
}

// Port type for the watcher implemented by the shell loader. Defined here so
// core consumers (orchestrator, tests) depend on the shape without reaching
// into the loader module directly.
export type WorkflowChangeCallback = (
  next: { definition: WorkflowDefinition; config: ServiceConfig } | { error: WorkflowError },
) => void;

export interface WorkflowSource {
  current(): { definition: WorkflowDefinition; config: ServiceConfig };
  onChange(cb: WorkflowChangeCallback): () => void;
  stop(): Promise<void>;
}
