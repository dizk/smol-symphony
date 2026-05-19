// WORKFLOW.md loader, watcher, and typed config view (SPEC §5, §6).

import { readFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import chokidar from 'chokidar';
import { parse as parseYaml } from 'yaml';
import type {
  ServiceConfig,
  WorkflowDefinition,
  TrackerConfig,
  PollingConfig,
  WorkspaceConfig,
  HooksConfig,
  AgentConfig,
  AcpConfig,
  SmolvmConfig,
  ServerConfig,
} from './types.js';
import { log } from './logging.js';

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
  const apiKeyRaw = asString(trackerRaw['api_key']);
  const apiKeyResolved = apiKeyRaw ? expandVar(apiKeyRaw) : null;
  const trackerEndpointDefault = trackerKind === 'linear' ? 'https://api.linear.app/graphql' : null;
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
  const tracker: TrackerConfig = {
    kind: trackerKind,
    endpoint: asString(trackerRaw['endpoint']) ?? trackerEndpointDefault,
    api_key: apiKeyResolved && apiKeyResolved.length > 0 ? apiKeyResolved : null,
    project_slug: asString(trackerRaw['project_slug']),
    active_states: asStringList(trackerRaw['active_states'], ['Todo', 'In Progress']),
    terminal_states: asStringList(trackerRaw['terminal_states'], [
      'Closed',
      'Cancelled',
      'Canceled',
      'Duplicate',
      'Done',
    ]),
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

  // acp (Symphony extension; supersedes the §5.3.6 `codex` block). The adapter binary
  // is whatever ACP-compatible agent the workflow targets — claude-agent-acp, codex-acp,
  // opencode acp, etc. We still wrap it through a login shell so the agent inherits the
  // VM's $PATH and locale.
  const acpRaw = getObject(raw, 'acp');
  const acp: AcpConfig = {
    adapter: asString(acpRaw['adapter']) ?? 'unknown',
    command: asString(acpRaw['command']) ?? 'claude-agent-acp',
    shell: asString(acpRaw['shell']) ?? 'bash',
    prompt_timeout_ms: asInt(acpRaw['prompt_timeout_ms'], 3_600_000),
    read_timeout_ms: asInt(acpRaw['read_timeout_ms'], 30_000),
    stall_timeout_ms: asInt(acpRaw['stall_timeout_ms'], 300_000),
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
    cpus: asInt(smolvmRaw['cpus'], 2),
    mem_mib: asInt(smolvmRaw['mem_mib'], 2048),
    net: smolvmRaw['net'] !== false,
    bin_path: asString(smolvmRaw['bin_path']),
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

  return {
    workflow_path: workflowAbs,
    workflow_dir: workflowDir,
    tracker,
    polling,
    workspace,
    hooks,
    agent,
    acp,
    smolvm,
    server,
  };
}

// §6.3 dispatch preflight validation.
export function validateDispatch(cfg: ServiceConfig): string | null {
  if (!cfg.tracker.kind) return 'tracker.kind is required';
  if (cfg.tracker.kind !== 'linear' && cfg.tracker.kind !== 'local') {
    return `unsupported_tracker_kind: ${cfg.tracker.kind}`;
  }
  if (cfg.tracker.kind === 'linear') {
    if (!cfg.tracker.api_key) return 'missing_tracker_api_key';
    if (!cfg.tracker.project_slug) return 'missing_tracker_project_slug';
  }
  if (cfg.tracker.kind === 'local') {
    if (!cfg.tracker.root) return 'tracker.root must be set for local tracker';
    if (!existsSync(cfg.tracker.root) || !statSync(cfg.tracker.root).isDirectory()) {
      return `tracker.root not found or not a directory: ${cfg.tracker.root}`;
    }
  }
  if (!cfg.acp.command || !cfg.acp.command.trim()) return 'acp.command must be non-empty';
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
