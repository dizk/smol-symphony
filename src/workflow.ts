// WORKFLOW.md parser and typed config view (SPEC §4). Pure: no fs, no process.
// The on-disk read and watcher live in `./workflow-loader.ts` (shell).

import path from 'node:path';
import os from 'node:os';
import { parseFrontMatter, FrontMatterError } from './util/frontmatter.js';
import type {
  ServiceConfig,
  StateConfig,
  StateHooksConfig,
  WorkflowDefinition,
  TrackerConfig,
  PollingConfig,
  WorkspaceConfig,
  LogsConfig,
  HooksConfig,
  AgentConfig,
  AcpConfig,
  SmolvmConfig,
  ServerConfig,
  McpConfig,
  PrAutopilotConfig,
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
// supplies the variable map for `$VAR` expansion (and `XDG_RUNTIME_DIR` for
// the smolvm endpoint default); defaults to {} so pure callers don't need to
// thread one in.
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
  // enough headroom for the orchestrator process, hooks, the smolvm daemon, and the
  // kernel's working set on a typical workstation. Operators can disable the cap (set
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
  const agent: AgentConfig = {
    max_concurrent_agents: asInt(agentRaw['max_concurrent_agents'], 10),
    max_turns: maxTurns,
    max_retry_backoff_ms: asInt(agentRaw['max_retry_backoff_ms'], 300_000),
    max_concurrent_agents_by_state: asMapStrPosInt(agentRaw['max_concurrent_agents_by_state']),
    memory_admission_enabled: memoryAdmissionEnabled,
    host_memory_reserve_mib: hostMemoryReserveMib,
  };

  // acp (Symphony extension; see §4.3.6). `adapter` selects
  // one of symphony's known profiles (claude, codex); symphony auto-derives the launch
  // command from the adapter profile and stages the host credential file into the
  // workspace.
  //
  // `acp.bridge` configures the host-side TCP listener that the in-VM agent dials back
  // to for ACP traffic. The bridge replaced the smolvm-exec stdio path; see
  // src/acp-bridge.ts for rationale.
  const acpRaw = getObject(raw, 'acp');
  const bridgeRaw = getObject(acpRaw, 'bridge');
  const modelRaw = asString(acpRaw['model']);
  const modelTrimmed = modelRaw === null ? null : modelRaw.trim();
  const effortRaw = asString(acpRaw['effort']);
  const effortTrimmed = effortRaw === null ? null : effortRaw.trim();
  // Issue 113: credentials_mode `proxy` routes through the host credential
  // proxy; `file` (default during transition) stages the full credential into
  // the workspace as before. Unknown values fall back to `file` so a typo
  // doesn't silently leak credentials into the VM via a half-configured
  // proxy mode.
  const credentialsModeRaw = asString(acpRaw['credentials_mode']);
  const credentialsMode: 'file' | 'proxy' =
    credentialsModeRaw === 'proxy' ? 'proxy' : 'file';
  const acp: AcpConfig = {
    adapter: asString(acpRaw['adapter']) ?? 'claude',
    credentials_mode: credentialsMode,
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

  // credentials extension (issue 113). Only consulted when
  // `acp.credentials_mode === 'proxy'`. Defaults work out of the box for the
  // common case: bind on 127.0.0.1 with an ephemeral port, run the host
  // ticker every 6 hours.
  const credentialsRaw = getObject(raw, 'credentials');
  const credentials: CredentialsConfig = {
    proxy_bind_host: asString(credentialsRaw['proxy_bind_host']) ?? '127.0.0.1',
    proxy_bind_port: asInt(credentialsRaw['proxy_bind_port'], 0),
    ticker_interval_ms: asInt(credentialsRaw['ticker_interval_ms'], 6 * 60 * 60 * 1000),
  };

  // smolvm extension
  const smolvmRaw = getObject(raw, 'smolvm');
  const fromRaw = asString(smolvmRaw['from']);
  let from: string | null = null;
  if (fromRaw) {
    const expanded = expandVar(fromRaw, env);
    if (expanded === '') {
      throw new WorkflowError(
        'workflow_parse_error',
        `smolvm.from references an unset variable: ${fromRaw}`,
      );
    }
    from = path.isAbsolute(expanded) ? expanded : path.resolve(workflowDir, expanded);
  }
  const smolfileRaw = asString(smolvmRaw['smolfile']);
  let smolfile: string | null = null;
  if (smolfileRaw) {
    const expanded = expandVar(smolfileRaw, env);
    if (expanded === '') {
      throw new WorkflowError(
        'workflow_parse_error',
        `smolvm.smolfile references an unset variable: ${smolfileRaw}`,
      );
    }
    smolfile = path.isAbsolute(expanded) ? expanded : path.resolve(workflowDir, expanded);
  }
  const volumesRaw = smolvmRaw['volumes'];
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
  const smolvm: SmolvmConfig = {
    image: asString(smolvmRaw['image']),
    from,
    smolfile,
    cpus: asInt(smolvmRaw['cpus'], 2),
    mem_mib: asInt(smolvmRaw['mem_mib'], 2048),
    net: smolvmRaw['net'] !== false,
    volumes,
    // Default forwarded credentials cover all three shipped ACP adapters so workflows that
    // do not override `smolvm.forward_env` still authenticate after the default-adapter
    // switch to claude-agent-acp.
    forward_env: asStringList(smolvmRaw['forward_env'], [
      'OPENAI_API_KEY',
      'ANTHROPIC_API_KEY',
    ]),
    endpoint:
      asString(smolvmRaw['endpoint']) ??
      `unix://${env['XDG_RUNTIME_DIR'] ?? '/run/user/1000'}/smolvm.sock`,
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
    // 127.0.0.1 works for smolvm because its VM network intercepts loopback
    // traffic and forwards it to the host's loopback. (Empirically verified;
    // 10.0.2.2 — the QEMU slirp gateway — is NOT reachable here.) Other VMMs
    // can override via the `host` field in the WORKFLOW.md mcp block.
    host: asString(mcpRaw['host']) ?? '127.0.0.1',
    explicit_host_url: asString(mcpRaw['host_url']),
  };

  // pr_autopilot (issue 38). Optional block; default off. When enabled the
  // reconciler keeps each terminal-state issue's PR rebased on origin/<base>
  // and arms GitHub auto-merge. State-name fields are resolved against the
  // declared states map at validation time — the parser only normalizes the
  // raw string, so an undeclared name surfaces in `validateDispatch` with a
  // clearer error than a runtime lookup failure.
  const prAutopilotRaw = getObject(raw, 'pr_autopilot');
  const prAutopilotEnabledRaw = prAutopilotRaw['enabled'];
  const prAutopilotEnabled = prAutopilotEnabledRaw === true;
  const mergeStateRaw = asString(prAutopilotRaw['merge_state']);
  // close_state is "string with default Cancelled" when the key is absent, but
  // an explicit `close_state: null` (or empty string) disables the close path
  // entirely — see WORKFLOW.template.md. Distinguish "key absent" from "key
  // present with a falsy value" so the default doesn't silently re-enable a
  // path the operator turned off.
  const closeStateKeyPresent = Object.prototype.hasOwnProperty.call(
    prAutopilotRaw,
    'close_state',
  );
  const closeStateRaw = asString(prAutopilotRaw['close_state']);
  const closeStateTrimmed = closeStateRaw?.trim() ?? '';
  const closeState: string | null = closeStateKeyPresent
    ? closeStateTrimmed.length > 0
      ? closeStateTrimmed
      : null
    : 'Cancelled';
  const conflictRouteToRaw = asString(prAutopilotRaw['conflict_route_to']);
  const strategyRaw = asString(prAutopilotRaw['auto_merge_strategy']) ?? 'squash';
  const autoMergeStrategy: 'squash' | 'merge' | 'rebase' =
    strategyRaw === 'merge' || strategyRaw === 'rebase' ? strategyRaw : 'squash';
  const prAutopilot: PrAutopilotConfig = {
    enabled: prAutopilotEnabled,
    merge_state: mergeStateRaw && mergeStateRaw.trim().length > 0 ? mergeStateRaw.trim() : 'Done',
    close_state: closeState,
    conflict_route_to:
      conflictRouteToRaw && conflictRouteToRaw.trim().length > 0
        ? conflictRouteToRaw.trim()
        : null,
    auto_merge_strategy: autoMergeStrategy,
    poll_interval_ms: asInt(prAutopilotRaw['poll_interval_ms'], 30_000),
  };
  if (prAutopilot.poll_interval_ms < 0) {
    throw new WorkflowError(
      'workflow_parse_error',
      'pr_autopilot.poll_interval_ms must be non-negative',
    );
  }

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
    smolvm,
    server,
    mcp,
    pr_autopilot: prAutopilot,
    credentials,
    states,
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
    const sc: StateConfig = { role: roleRaw };
    if (adapter !== null) sc.adapter = adapter;
    if (model !== undefined) sc.model = model;
    if (effort !== undefined) sc.effort = effort;
    if (maxTurns !== undefined) sc.max_turns = maxTurns;
    if (allowed !== undefined) sc.allowed_transitions = allowed;
    if (stateHooks !== undefined) sc.hooks = stateHooks;
    if (stateActions !== undefined) sc.actions = stateActions;
    if (evalModeRaw === true) sc.eval_mode = true;
    out[name] = sc;
  }
  return out;
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
// `tracker.root` existence, `smolvm.smolfile` existence, per-state adapter
// credential readability — live in the shell loader's `validateDispatchIo`,
// which the orchestrator calls alongside this function. Keeping the structural
// half pure means tests and the reload tick can re-run it cheaply on every
// reconcile without re-hitting the disk.
export function validateDispatch(cfg: ServiceConfig): string | null {
  if (cfg.tracker.kind !== 'local') {
    return `unsupported_tracker_kind: ${cfg.tracker.kind || '<missing>'}`;
  }
  if (!cfg.tracker.root) return 'tracker.root must be set for local tracker';
  // `cfg.states` is always populated by buildServiceConfig — the parser refuses
  // workflows without a `states:` block — so callers never need a fallback here.
  const statesError = validateStates(cfg.states);
  if (statesError) return statesError;
  if (!isKnownAdapter(cfg.acp.adapter)) {
    return `acp.adapter "${cfg.acp.adapter}" is not a known profile; use one of: claude, codex`;
  }
  // smolvm artifact source is one of image / from / smolfile. The smolvm CLI itself
  // would also reject conflicting flags, but failing here gives the operator a clear
  // pointer at the workflow key instead of a deep CLI error.
  const sources = [cfg.smolvm.image, cfg.smolvm.from, cfg.smolvm.smolfile].filter(
    (v): v is string => v !== null,
  );
  if (sources.length > 1) {
    return 'smolvm: set at most one of image / from / smolfile (mutually exclusive)';
  }
  // The bridge transport requires the VM to dial the host. Without networking the proxy
  // can never reach `SYMPHONY_ACP_URL`, every attempt fails after connect_timeout_ms,
  // and the operator gets a slow opaque error instead of a fast clear one.
  if (cfg.smolvm.net === false) {
    return (
      'smolvm.net=false is incompatible with the ACP TCP bridge. The in-VM proxy must ' +
      'reach the host listener; set smolvm.net: true (the default) or override the ' +
      'reachability of the bridge via acp.bridge.reach_url.'
    );
  }
  // pr_autopilot is always populated by buildServiceConfig, but test harnesses
  // sometimes hand-build a ServiceConfig from an earlier shape; treat a
  // missing block as `{ enabled: false }` so legacy fixtures keep validating.
  if (cfg.pr_autopilot && cfg.pr_autopilot.enabled) {
    const prError = validatePrAutopilot(cfg.pr_autopilot, cfg.states);
    if (prError) return prError;
  }
  return null;
}

/**
 * Cross-reference the pr_autopilot block against the declared states map.
 * Only fires when `pr_autopilot.enabled` is true so a workflow that hasn't
 * opted in isn't gated on the `merge_state` / `close_state` / conflict-state
 * names referring to live states.
 */
function validatePrAutopilot(
  cfg: PrAutopilotConfig,
  states: Record<string, StateConfig>,
): string | null {
  const byLower = new Map<string, string>();
  for (const name of Object.keys(states)) byLower.set(name.toLowerCase(), name);

  const mergeCanonical = byLower.get(cfg.merge_state.toLowerCase());
  if (!mergeCanonical) {
    return `pr_autopilot.merge_state references undeclared state "${cfg.merge_state}"`;
  }
  if (states[mergeCanonical]!.role !== 'terminal') {
    return `pr_autopilot.merge_state "${cfg.merge_state}" must be a terminal state (got role: ${states[mergeCanonical]!.role})`;
  }

  if (cfg.close_state !== null) {
    const closeCanonical = byLower.get(cfg.close_state.toLowerCase());
    if (!closeCanonical) {
      return `pr_autopilot.close_state references undeclared state "${cfg.close_state}"`;
    }
    if (states[closeCanonical]!.role !== 'terminal') {
      return `pr_autopilot.close_state "${cfg.close_state}" must be a terminal state (got role: ${states[closeCanonical]!.role})`;
    }
  }

  if (cfg.conflict_route_to !== null) {
    const routeCanonical = byLower.get(cfg.conflict_route_to.toLowerCase());
    if (!routeCanonical) {
      return `pr_autopilot.conflict_route_to references undeclared state "${cfg.conflict_route_to}"`;
    }
    if (states[routeCanonical]!.role !== 'active') {
      return `pr_autopilot.conflict_route_to "${cfg.conflict_route_to}" must be an active state (got role: ${states[routeCanonical]!.role})`;
    }
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
  for (const [name, cfg] of Object.entries(states)) {
    if (cfg.allowed_transitions) {
      for (const target of cfg.allowed_transitions) {
        if (!seen.has(target.toLowerCase())) {
          return `state "${name}": allowed_transitions references undeclared state "${target}"`;
        }
      }
    }
    if (cfg.adapter !== undefined && !isKnownAdapter(cfg.adapter)) {
      return `state "${name}": adapter "${cfg.adapter}" is not a known profile; use one of: claude, codex`;
    }
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
