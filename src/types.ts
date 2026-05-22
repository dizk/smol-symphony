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

// Per-state hook overrides. Any field set here replaces the workflow-level hook of
// the same name when an issue is in this state at hook-fire time. `undefined` (key
// absent) means "fall through to the workflow-level hook"; an explicit `null` means
// "no hook for this state, even if workflow-level declares one" so a terminal state
// can opt out of a global after_run that otherwise no-ops on it. `timeout_ms` is
// not overridable per state — it's a global safety bound, not behavior.
export interface StateHooksConfig {
  after_create?: string | null;
  before_run?: string | null;
  after_run?: string | null;
  before_remove?: string | null;
}

// Per-state configuration declared in the `states:` block of a workflow file. The
// orchestrator dispatches against `active`; `terminal` ends a run and triggers
// workspace cleanup; `holding` keeps a file in the tracker tree without ever
// dispatching it (Triage is the canonical example). `adapter` / `model` /
// `max_turns` override the workflow-level defaults when set; null/undefined means
// "use the workflow default at dispatch time". `allowed_transitions`, when non-null,
// restricts which states the agent may move to via the MCP `transition` tool; null
// means "any declared state is reachable". `hooks`, when set, overrides individual
// workflow-level hook fields for issues in this state — used to give terminal states
// (e.g. Done, Merge, Cancelled) divergent handoff behavior without an inline
// terminal-state switch inside a single global hook.
export interface StateConfig {
  role: 'active' | 'terminal' | 'holding';
  adapter?: string;
  model?: string | null;
  // Per-state override of the adapter's effort/reasoning level. Same
  // undefined-vs-null semantics as `model`: undefined inherits the workflow-level
  // `acp.effort`, an explicit null clears it (use the adapter's own default).
  // Valid values are adapter- and model-specific; symphony does not enforce an
  // enum so it does not drift from the adapter's own supported list.
  effort?: string | null;
  max_turns?: number;
  allowed_transitions?: string[] | null;
  hooks?: StateHooksConfig;
}

export interface TrackerConfig {
  kind: string;
  // Canonical per-state map. Active/terminal/holding membership is read by role
  // via the helpers in src/issues.ts (`activeStateNames`, `terminalStateNames`)
  // — no separate derived lists live on this config.
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
// in-VM proxy); operators who need a custom shape fork scripts/vm-agent.mjs.
export interface AcpConfig {
  adapter: string;
  /**
   * Optional model selector forwarded to the adapter. Each adapter profile decides how
   * to surface it (env var for claude-agent-acp's ANTHROPIC_MODEL; `-c model="..."` argv
   * for codex-acp). Null means "use the adapter's own default".
   */
  model: string | null;
  /**
   * Optional effort / reasoning level forwarded to the adapter. Profile-specific: for
   * claude-agent-acp symphony stages a `settings.json` with `{"effortLevel": "<value>"}`
   * alongside the credential and copies it into `/root/.claude/settings.json` in the VM
   * (the wrapper reads this via the SDK's `resolveSettings`). Valid values are
   * adapter- and model-specific; symphony does not enforce an enum (the adapter's own
   * `supportedEffortLevels` is the source of truth — e.g. Opus supports `xhigh`, Haiku
   * does not). Null means "use the adapter's own default".
   */
  effort: string | null;
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
  // Container image to pull. Mutually exclusive with `from` and `smolfile`.
  image: string | null;
  // Path to a packed .smolmachine artifact (smolvm pack create --from-vm). When set, takes
  // precedence over `image`; the agent runner passes it to `smolvm machine create --from`.
  from: string | null;
  // Path to a TOML Smolfile (https://github.com/smol-machines/smolvm) describing the
  // per-issue VM declaratively. When set, the runner passes `--smolfile <path>` to
  // `smolvm machine create`; the Smolfile's `image`, `cpus`, `memory`, `net`, and
  // `[dev].init` / `[dev].volumes` provide the source-of-truth setup, replacing the
  // old hand-built .smolmachine pre-pack flow. CLI flags symphony still emits (cpus,
  // memory, net, --volume for the workspace mount, --env for forwarded credentials)
  // override or merge with the Smolfile per smolvm's precedence rules. When both
  // `smolfile` and one of `image`/`from` are set the workflow parser rejects the
  // config (mutually exclusive).
  smolfile: string | null;
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
// reinforced by a per-dispatch bearer token. Tools live there: transition, propose_issue,
// and request_human_steering.
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

// Shared-integration-branch configuration. When `merge_on_states` is non-empty, a
// successful terminal transition into one of those states triggers a host-side
// merge of `agent/<id>` into `branch` (followed by a push if a network remote is
// configured). On conflict or push refusal the orchestrator routes the issue
// into `conflict_state` (a holding state) and preserves the workspace + branch
// so an operator or future agent can resolve it. When `merge_on_states` is
// empty the feature is off and the orchestrator behaves as if no integration
// block were declared.
export interface IntegrationConfig {
  branch: string;
  conflict_state: string;
  merge_on_states: string[];
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
  integration: IntegrationConfig;
  // Canonical per-state configuration map. The same map is mirrored onto
  // `tracker.states` so the tracker (which only sees its slice of config)
  // keeps the state set without reaching back into the full ServiceConfig.
  states: Record<string, StateConfig>;
}

export interface Workspace {
  path: string;
  workspace_key: string;
  created_now: boolean;
}

// Aggregate token totals tracked by orchestrator across all sessions.
export interface SessionTotals {
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
  adapter_pid: string | null;
  last_event: string | null;
  last_event_at: string | null;
  last_message: string | null;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
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
  // Snapshot of `tracker.root` captured at dispatch time so a WORKFLOW.md reload
  // mid-flight cannot redirect an in-flight `transition` (or `propose_issue`) to
  // a different filesystem location. The orchestrator pins this in dispatchIssue
  // BEFORE workspace setup, before_run hooks, or smolvm bring-up — anything that
  // happens during that window (including a workflow reload that mutates
  // tracker.root) must not affect where the move lands. McpRegistry.activate
  // copies the value into the ActiveEntry as-is.
  tracker_root_at_dispatch: string | null;
  // Resolved "<adapter>/<model or 'default'>" identity at dispatch time. Stamped
  // into the notes header that `symphony.transition` writes onto the issue body so
  // the next agent (reading the issue in its new state) sees who handed off.
  resolved_actor: string;
  // Tool-driven exit signal. Set when the agent successfully called `symphony.transition`
  // (the only way to mutate tracker state from inside the VM). The runner reads this
  // between turns and unwinds cleanly; the field was named `marked_done` before the
  // standalone `mark_done` MCP tool was removed in Cleanup 2.
  transitioned: boolean;
  // The MCP request_human_steering tool sets steering_requested = true and stashes the
  // agent's question here. The runner pauses the autonomous loop and awaits a human reply
  // via POST /api/v1/issues/<id>/steering-reply; the reply lands in steering_reply and the
  // next turn's prompt is built from the pair.
  steering_requested: boolean;
  steering_question: string | null;
  steering_context: string | null;
}

// Discriminates the two retry shapes in the queue. A `continuation` is the
// short follow-up scheduled after a clean worker exit so the same issue can
// resume in its (post-transition) state without other Todo work stealing the
// slot mid-handoff. A `failure` is the exponential-backoff retry after an
// abnormal exit (or a re-queue when no slots were available); during its
// backoff the orchestrator is free to dispatch other work. Continuations
// hold a slot for the duration of their delay; failures do not. See
// Orchestrator.availableGlobalSlots / hasPerStateSlot.
export type RetryKind = 'continuation' | 'failure';

export interface RetryEntry {
  issue_id: string;
  identifier: string;
  attempt: number;
  due_at_ms: number;
  timer_handle: ReturnType<typeof setTimeout>;
  error: string | null;
  kind: RetryKind;
  // State the next attempt will dispatch into. For continuations this is the
  // post-transition state recorded on the running entry at exit time; for
  // failures it is the same state the worker last ran under. Used by
  // per-state slot accounting so a pending continuation counts against the
  // target state's cap.
  target_state: string;
}

export interface RuntimeEvent {
  at: string;
  event: string;
  message: string;
}
