// Domain model per SPEC.md §4.

export interface BlockerRef {
  id: string | null;
  identifier: string | null;
  state: string | null;
}

export interface Issue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number | null;
  state: string;
  branch_name: string | null;
  url: string | null;
  labels: string[];
  blocked_by: BlockerRef[];
  created_at: string | null;
  updated_at: string | null;
}

export interface WorkflowDefinition {
  config: Record<string, unknown>;
  prompt_template: string;
}

// Per-state configuration declared in the `states:` block of a workflow file. The
// orchestrator dispatches against `active`; `terminal` ends a run and triggers
// workspace cleanup; `holding` keeps a file in the tracker tree without ever
// dispatching it (Triage is the canonical example). `adapter` / `model` /
// `max_turns` override the workflow-level defaults when set; null/undefined means
// "use the workflow default at dispatch time". `allowed_transitions`, when non-null,
// restricts which states the agent may move to via the MCP `transition` tool; null
// means "any declared state is reachable".
export interface StateConfig {
  role: 'active' | 'terminal' | 'holding';
  adapter?: string;
  model?: string | null;
  max_turns?: number;
  allowed_transitions?: string[] | null;
}

export interface TrackerConfig {
  kind: string;
  // Derived from `states` after workflow parse so existing consumers keep working
  // unchanged. `active_states` lists every state with role `active`, in declaration
  // order; `terminal_states` lists every state with role `terminal`, in declaration
  // order. `states` is the canonical map.
  active_states: string[];
  terminal_states: string[];
  states: Record<string, StateConfig>;
  // local-tracker only:
  root: string | null;
}

export interface PollingConfig {
  interval_ms: number;
}

export interface WorkspaceConfig {
  root: string;
}

export interface LogsConfig {
  // Directory where per-issue JSONL run logs live. One file per issue
  // (`<root>/<sanitized-identifier>.jsonl`), appended across attempts and process restarts.
  root: string;
}

export interface HooksConfig {
  after_create: string | null;
  before_run: string | null;
  after_run: string | null;
  before_remove: string | null;
  timeout_ms: number;
}

export interface AgentConfig {
  max_concurrent_agents: number;
  max_turns: number;
  max_retry_backoff_ms: number;
  max_concurrent_agents_by_state: Record<string, number>;
}

// ACP adapter configuration. `adapter` selects one of symphony's known adapter profiles
// (currently `claude` and `codex`); the profile encodes the binary symphony launches
// inside the VM and the credential file it copies in from the host. Symphony always
// auto-derives the launch command (scrub guest cred dir + stage credential + exec the
// in-VM proxy); operators who need a custom shape fork scripts/vm-agent.js.
export interface AcpConfig {
  adapter: string;
  /**
   * Optional model selector forwarded to the adapter. Each adapter profile decides how
   * to surface it (env var for claude-agent-acp's ANTHROPIC_MODEL; `-c model="..."` argv
   * for codex-acp). Null means "use the adapter's own default".
   */
  model: string | null;
  shell: string;
  prompt_timeout_ms: number;
  read_timeout_ms: number;
  stall_timeout_ms: number;
  /**
   * Host-side TCP bridge that the in-VM agent dials back to for ACP traffic. The bridge
   * replaces the previous smolvm-exec stdio path (which had a stdin-pump bug) and decouples
   * symphony from any specific sandbox tech.
   */
  bridge: AcpBridgeConfig;
}

export interface AcpBridgeConfig {
  /** Host/IP symphony binds the bridge listener on. 0.0.0.0 by default for VM access. */
  bind_host: string;
  /** Port symphony binds. 0 picks an ephemeral port (recorded after start). */
  bind_port: number;
  /**
   * Host the in-VM agent uses to reach the bridge. Defaults to 127.0.0.1 because smolvm
   * remaps guest loopback to host loopback. Other sandboxes that need a different host
   * alias (or a reverse proxy) can override.
   */
  reach_host: string;
  /** Optional override for the full URL (e.g. through a reverse proxy). */
  reach_url: string | null;
  /**
   * How long to wait for the in-VM agent to connect after the VM is launched, before
   * failing the attempt. The agent normally connects within a second; this catches
   * misconfigured `reach_host` or sandbox-network issues.
   */
  connect_timeout_ms: number;
}

export interface SmolvmVolume {
  host: string;
  guest: string;
  readonly: boolean;
}

export interface SmolvmConfig {
  // Container image to pull. Mutually exclusive with `from`.
  image: string | null;
  // Path to a packed .smolmachine artifact (smolvm pack create --from-vm). When set, takes
  // precedence over `image`; the agent runner passes it to `smolvm machine create --from`.
  from: string | null;
  cpus: number;
  mem_mib: number;
  net: boolean;
  // Additional host:guest volume mounts (credentials, repo caches, ssh keys, …).
  volumes: SmolvmVolume[];
  // Extra env vars forwarded into the VM exec (e.g. OPENAI_API_KEY).
  forward_env: string[];
  // Base URL or unix socket for the smolvm server. Format: "unix:///path/to/sock" or "http://host:port".
  endpoint: string;
}

export interface ServerConfig {
  port: number | null;
  host: string;
}

// MCP server exposed to in-VM agents over HTTP. The orchestrator runs a JSON-RPC endpoint
// scoped to each active issue at /api/v1/issues/<id>/mcp; the URL itself is the capability,
// reinforced by a per-dispatch bearer token. Two tools live there today: mark_done and
// request_human_steering.
export interface McpConfig {
  enabled: boolean;
  // Hostname or IP the agent uses to reach the orchestrator from inside the smolvm.
  // Defaults to the QEMU slirp host address. The port is resolved at runtime from the
  // actually-bound HTTP server (NOT server.port at parse time), so `--port` and a workflow
  // that omits server.port can never desync.
  host: string;
  // Full URL override. When set in WORKFLOW.md, this is used verbatim and `host` plus the
  // bound HTTP port are ignored. Use this only when the VM cannot reach the orchestrator
  // through the host gateway (e.g. bridge networking with a fixed reverse-proxy URL).
  explicit_host_url: string | null;
}

export interface ServiceConfig {
  workflow_path: string;
  workflow_dir: string;
  tracker: TrackerConfig;
  polling: PollingConfig;
  workspace: WorkspaceConfig;
  logs: LogsConfig;
  hooks: HooksConfig;
  agent: AgentConfig;
  acp: AcpConfig;
  smolvm: SmolvmConfig;
  server: ServerConfig;
  mcp: McpConfig;
  // Canonical per-state configuration map. `tracker.active_states` /
  // `tracker.terminal_states` / `tracker.states` are derived from this at parse
  // time so the tracker (which only sees its slice of config) keeps working.
  states: Record<string, StateConfig>;
}

export interface Workspace {
  path: string;
  workspace_key: string;
  created_now: boolean;
}

// Aggregate token totals tracked by orchestrator (§4.1.8 codex_totals).
export interface CodexTotals {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  seconds_running: number;
}

// Running entry stored in orchestrator state per issue.
export interface RunningEntry {
  issue_id: string;
  identifier: string;
  issue: Issue;
  session_id: string | null;
  thread_id: string | null;
  turn_id: string | null;
  codex_app_server_pid: string | null;
  last_codex_event: string | null;
  last_codex_timestamp: string | null;
  last_codex_message: string | null;
  codex_input_tokens: number;
  codex_output_tokens: number;
  codex_total_tokens: number;
  last_reported_input_tokens: number;
  last_reported_output_tokens: number;
  last_reported_total_tokens: number;
  turn_count: number;
  retry_attempt: number | null;
  started_at: string;
  workspace_path: string;
  cancel: () => void;
  recent_events: RuntimeEvent[];
  last_error: string | null;
  // Set by reconciliation when the issue transitioned to a terminal tracker state. The
  // workspace will be deleted by the worker-exit handler after the run has fully unwound.
  cleanup_workspace_on_exit: boolean;
  // MCP integration. Populated when the runner registers this entry with the McpRegistry
  // so the agent's tool calls can be routed back. Lifecycle: set on registration, cleared
  // when the worker exits.
  mcp_token: string | null;
  // Snapshots captured at dispatch time so a WORKFLOW.md reload mid-flight cannot
  // redirect an in-flight mark_done. The orchestrator pins these in dispatchIssue
  // BEFORE workspace setup, before_run hooks, or smolvm bring-up — anything that
  // happens during that window (including a workflow reload that mutates
  // tracker.root or terminal_states) must not affect where mark_done lands.
  // McpRegistry.activate copies these into the ActiveEntry as-is.
  tracker_root_at_dispatch: string | null;
  terminal_target_at_dispatch: string;
  // Resolved "<adapter>/<model or 'default'>" identity at dispatch time. Stamped
  // into the notes header that `symphony.transition` writes onto the issue body so
  // the next agent (reading the issue in its new state) sees who handed off.
  resolved_actor: string;
  // Tool-driven exit signals. The runner reads these between turns.
  marked_done: boolean;
  // The MCP request_human_steering tool sets steering_requested = true and stashes the
  // agent's question here. The runner pauses the autonomous loop and awaits a human reply
  // via POST /api/v1/issues/<id>/steering-reply; the reply lands in steering_reply and the
  // next turn's prompt is built from the pair.
  steering_requested: boolean;
  steering_question: string | null;
  steering_context: string | null;
}

export interface RetryEntry {
  issue_id: string;
  identifier: string;
  attempt: number;
  due_at_ms: number;
  timer_handle: ReturnType<typeof setTimeout>;
  error: string | null;
}

export interface RuntimeEvent {
  at: string;
  event: string;
  message: string;
}
