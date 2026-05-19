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

export interface TrackerConfig {
  kind: string;
  endpoint: string | null;
  api_key: string | null;
  project_slug: string | null;
  active_states: string[];
  terminal_states: string[];
  // local-tracker only:
  root: string | null;
}

export interface PollingConfig {
  interval_ms: number;
}

export interface WorkspaceConfig {
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

// ACP adapter configuration (replaces the codex-specific block in the spec). The launch
// `command` names the adapter binary inside the VM — e.g. `claude-agent-acp`,
// `codex-acp`, or `opencode acp`. `adapter` is a free-form label included in logs/snapshots
// so operators can tell which agent ran a given session.
export interface AcpConfig {
  adapter: string;
  command: string;
  shell: string;
  prompt_timeout_ms: number;
  read_timeout_ms: number;
  stall_timeout_ms: number;
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
  // Path on host to a directory containing the codex binary; mounted read-only into the VM at /opt/codex.
  bin_path: string | null;
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

export interface ServiceConfig {
  workflow_path: string;
  workflow_dir: string;
  tracker: TrackerConfig;
  polling: PollingConfig;
  workspace: WorkspaceConfig;
  hooks: HooksConfig;
  agent: AgentConfig;
  acp: AcpConfig;
  smolvm: SmolvmConfig;
  server: ServerConfig;
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
