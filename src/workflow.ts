// WORKFLOW.md loader, watcher, and typed config view (SPEC §5, §6).

import { readFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import chokidar from 'chokidar';
import { parse as parseYaml } from 'yaml';
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
  IntegrationConfig,
} from './types.js';
import { log } from './logging.js';
import {
  isKnownAdapter,
  ADAPTERS,
  hostCredentialAbsPath,
  type AcpAdapterId,
} from './agent/adapters.js';
import { accessSync, constants as fsConstants } from 'node:fs';

export class WorkflowError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'WorkflowError';
  }
}

// §5.2: split YAML front matter from prompt body.
export function splitFrontMatter(text: string): { config: Record<string, unknown>; body: string } {
  if (!text.startsWith('---')) {
    return { config: {}, body: text.trim() };
  }
  const lines = text.split(/\r?\n/);
  // First and closing fences must be exactly `---` (with optional trailing whitespace),
  // unindented. Otherwise an indented `---` inside a multiline YAML hook script would be
  // mistaken for the closing fence.
  const isFence = (line: string | undefined): boolean => /^---\s*$/.test(line ?? '');
  if (!isFence(lines[0])) {
    return { config: {}, body: text.trim() };
  }
  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (isFence(lines[i])) {
      endIdx = i;
      break;
    }
  }
  if (endIdx < 0) {
    throw new WorkflowError('workflow_parse_error', 'unterminated YAML front matter');
  }
  const fmText = lines.slice(1, endIdx).join('\n');
  const body = lines.slice(endIdx + 1).join('\n').trim();
  let parsed: unknown;
  try {
    parsed = fmText.trim().length === 0 ? {} : parseYaml(fmText);
  } catch (err) {
    throw new WorkflowError('workflow_parse_error', `invalid YAML front matter: ${(err as Error).message}`);
  }
  if (parsed === null || parsed === undefined) parsed = {};
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new WorkflowError('workflow_front_matter_not_a_map', 'YAML front matter must decode to a map');
  }
  return { config: parsed as Record<string, unknown>, body };
}

export async function loadWorkflow(workflowPath: string): Promise<WorkflowDefinition> {
  let text: string;
  try {
    text = await readFile(workflowPath, 'utf8');
  } catch (err) {
    throw new WorkflowError('missing_workflow_file', `cannot read ${workflowPath}: ${(err as Error).message}`);
  }
  const { config, body } = splitFrontMatter(text);
  return { config, prompt_template: body };
}

// $VAR / ~ expansion for path/command fields (§6.1).
export function expandVar(value: string): string {
  if (typeof value !== 'string') return value;
  let s = value;
  if (s.startsWith('~/') || s === '~') {
    s = s === '~' ? os.homedir() : path.join(os.homedir(), s.slice(2));
  }
  const m = s.match(/^\$([A-Z_][A-Z0-9_]*)$/);
  if (m) {
    const envVal = process.env[m[1]!];
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

// Build a fully typed ServiceConfig from a parsed front matter map (§6.1).
export function buildServiceConfig(
  raw: Record<string, unknown>,
  workflowPath: string,
): ServiceConfig {
  const workflowAbs = path.resolve(workflowPath);
  const workflowDir = path.dirname(workflowAbs);

  // tracker (§5.3.1)
  const trackerRaw = getObject(raw, 'tracker');
  const trackerKind = (asString(trackerRaw['kind']) ?? '').trim();
  // local-tracker extension: optional `tracker.root` path.
  const trackerRootRaw = asString(trackerRaw['root']);
  let trackerRoot: string | null = null;
  if (trackerRootRaw) {
    const expanded = expandVar(trackerRootRaw);
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

  // polling (§5.3.2)
  const pollingRaw = getObject(raw, 'polling');
  const polling: PollingConfig = {
    interval_ms: asInt(pollingRaw['interval_ms'], 30_000),
  };

  // workspace (§5.3.3)
  const workspaceRaw = getObject(raw, 'workspace');
  const wsRootInput = asString(workspaceRaw['root']);
  let workspaceRoot: string;
  if (wsRootInput) {
    const expanded = expandVar(wsRootInput);
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
    const expanded = expandVar(logsRootInput);
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

  // hooks (§5.3.4)
  const hooksRaw = getObject(raw, 'hooks');
  const hooks: HooksConfig = {
    after_create: asString(hooksRaw['after_create']),
    before_run: asString(hooksRaw['before_run']),
    after_run: asString(hooksRaw['after_run']),
    before_remove: asString(hooksRaw['before_remove']),
    timeout_ms: asInt(hooksRaw['timeout_ms'], 60_000),
  };
  if (hooks.timeout_ms <= 0) {
    throw new WorkflowError('workflow_parse_error', 'hooks.timeout_ms must be positive');
  }

  // agent (§5.3.5)
  const agentRaw = getObject(raw, 'agent');
  const maxTurns = asInt(agentRaw['max_turns'], 20);
  if (maxTurns <= 0) {
    throw new WorkflowError('workflow_parse_error', 'agent.max_turns must be positive');
  }
  const agent: AgentConfig = {
    max_concurrent_agents: asInt(agentRaw['max_concurrent_agents'], 10),
    max_turns: maxTurns,
    max_retry_backoff_ms: asInt(agentRaw['max_retry_backoff_ms'], 300_000),
    max_concurrent_agents_by_state: asMapStrPosInt(agentRaw['max_concurrent_agents_by_state']),
  };

  // acp (Symphony extension; supersedes the §5.3.6 `codex` block). `adapter` selects
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

  // smolvm extension
  const smolvmRaw = getObject(raw, 'smolvm');
  const fromRaw = asString(smolvmRaw['from']);
  let from: string | null = null;
  if (fromRaw) {
    const expanded = expandVar(fromRaw);
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
    const expanded = expandVar(smolfileRaw);
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
        const expandedHost = expandVar(hostRaw);
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
      `unix://${process.env.XDG_RUNTIME_DIR ?? '/run/user/1000'}/smolvm.sock`,
  };

  // server extension (§13.7)
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

  // integration (shared-branch flow). Optional block. When merge_on_states is
  // empty, the orchestrator skips integration handling entirely and behaves as
  // if no integration block were declared. Operators opt in per terminal state
  // by listing the state(s) that should fire the merge — typically just Done.
  // `branch` defaults to "integration", `conflict_state` to "Conflict".
  // Validation (declared-state references, role checks) lives in
  // `validateDispatch` so the parser stays decoupled from the live states map.
  const integrationRaw = getObject(raw, 'integration');
  const integrationBranch = asString(integrationRaw['branch'])?.trim();
  const integrationConflictState = asString(integrationRaw['conflict_state'])?.trim();
  const integration: IntegrationConfig = {
    branch: integrationBranch && integrationBranch.length > 0 ? integrationBranch : 'integration',
    conflict_state:
      integrationConflictState && integrationConflictState.length > 0
        ? integrationConflictState
        : 'Conflict',
    merge_on_states: asStringList(integrationRaw['merge_on_states'], []),
  };

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
    integration,
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
    const sc: StateConfig = { role: roleRaw };
    if (adapter !== null) sc.adapter = adapter;
    if (model !== undefined) sc.model = model;
    if (effort !== undefined) sc.effort = effort;
    if (maxTurns !== undefined) sc.max_turns = maxTurns;
    if (allowed !== undefined) sc.allowed_transitions = allowed;
    if (stateHooks !== undefined) sc.hooks = stateHooks;
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
  const fields: Array<keyof StateHooksConfig> = [
    'after_create',
    'before_run',
    'after_run',
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
    after_run: pick('after_run'),
    before_remove: pick('before_remove'),
    timeout_ms: base.timeout_ms,
  };
}

// §6.3 dispatch preflight validation.
export function validateDispatch(cfg: ServiceConfig): string | null {
  if (cfg.tracker.kind !== 'local') {
    return `unsupported_tracker_kind: ${cfg.tracker.kind || '<missing>'}`;
  }
  if (!cfg.tracker.root) return 'tracker.root must be set for local tracker';
  if (!existsSync(cfg.tracker.root) || !statSync(cfg.tracker.root).isDirectory()) {
    return `tracker.root not found or not a directory: ${cfg.tracker.root}`;
  }
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
  // smolfile is the path the runner hands smolvm via `--smolfile`. Verify it exists at
  // parse time so a typo / wrong cwd fails fast rather than at the first dispatch.
  if (cfg.smolvm.smolfile && !existsSync(cfg.smolvm.smolfile)) {
    return `smolvm.smolfile not found: ${cfg.smolvm.smolfile}`;
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
  if (cfg.integration.merge_on_states.length > 0) {
    const integrationError = validateIntegration(cfg.integration, cfg.states);
    if (integrationError) return integrationError;
  }
  return null;
}

// integration.merge_on_states cross-references the declared states map and
// must hit terminal states; conflict_state must hit a holding state. Off
// (merge_on_states: []) skips this check entirely so an operator who hasn't
// opted in isn't gated on a Conflict directory existing.
function validateIntegration(
  integration: IntegrationConfig,
  states: Record<string, StateConfig>,
): string | null {
  const byLower = new Map<string, string>();
  for (const name of Object.keys(states)) byLower.set(name.toLowerCase(), name);
  for (const target of integration.merge_on_states) {
    const canonical = byLower.get(target.toLowerCase());
    if (!canonical) {
      return `integration.merge_on_states references undeclared state "${target}"`;
    }
    if (states[canonical]!.role !== 'terminal') {
      return `integration.merge_on_states["${target}"] must reference a terminal state (got role: ${states[canonical]!.role})`;
    }
  }
  const conflictCanonical = byLower.get(integration.conflict_state.toLowerCase());
  if (!conflictCanonical) {
    return `integration.conflict_state references undeclared state "${integration.conflict_state}"`;
  }
  if (states[conflictCanonical]!.role !== 'holding') {
    return `integration.conflict_state "${integration.conflict_state}" must be a holding state (got role: ${states[conflictCanonical]!.role})`;
  }
  if (integration.branch.length === 0) {
    return 'integration.branch must be a non-empty string';
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
    if (cfg.adapter !== undefined) {
      if (!isKnownAdapter(cfg.adapter)) {
        return `state "${name}": adapter "${cfg.adapter}" is not a known profile; use one of: claude, codex`;
      }
      const credPath = hostCredentialAbsPath(ADAPTERS[cfg.adapter as AcpAdapterId]);
      try {
        accessSync(credPath, fsConstants.R_OK);
      } catch (err) {
        return `state "${name}": adapter "${cfg.adapter}" requires a host credential at ${credPath}, but it is missing or unreadable: ${(err as Error).message}`;
      }
    }
  }
  return null;
}

export type WorkflowChangeCallback = (
  next: { definition: WorkflowDefinition; config: ServiceConfig } | { error: WorkflowError },
) => void;

export interface WorkflowSource {
  current(): { definition: WorkflowDefinition; config: ServiceConfig };
  onChange(cb: WorkflowChangeCallback): () => void;
  stop(): Promise<void>;
}

// Build + watch a workflow source. Throws on initial load failure.
export async function watchWorkflow(workflowPath: string): Promise<WorkflowSource> {
  const workflowAbs = path.resolve(workflowPath);
  const initialDef = await loadWorkflow(workflowAbs);
  const initialCfg = buildServiceConfig(initialDef.config, workflowAbs);
  let current = { definition: initialDef, config: initialCfg };
  const listeners = new Set<WorkflowChangeCallback>();

  const watcher = chokidar.watch(workflowAbs, {
    ignoreInitial: true,
    persistent: true,
  });

  let reloadInFlight: Promise<void> | null = null;

  const reload = async () => {
    if (reloadInFlight) return reloadInFlight;
    reloadInFlight = (async () => {
      try {
        const def = await loadWorkflow(workflowAbs);
        const cfg = buildServiceConfig(def.config, workflowAbs);
        current = { definition: def, config: cfg };
        log.info('workflow reloaded', { path: workflowAbs });
        for (const cb of listeners) cb({ definition: def, config: cfg });
      } catch (err) {
        const e =
          err instanceof WorkflowError
            ? err
            : new WorkflowError('workflow_parse_error', (err as Error).message);
        log.warn('workflow reload failed; keeping last good config', { error: e.message, code: e.code });
        for (const cb of listeners) cb({ error: e });
      } finally {
        reloadInFlight = null;
      }
    })();
    return reloadInFlight;
  };

  watcher.on('change', () => void reload());
  watcher.on('add', () => void reload());
  // §5.5: workflow read errors must block dispatch. If the file is deleted or temporarily
  // renamed, surface a missing_workflow_file error so the orchestrator knows.
  watcher.on('unlink', () => void reload());

  return {
    current: () => current,
    onChange: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    stop: () => watcher.close(),
  };
}
