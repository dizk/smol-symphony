// Domain model per SPEC.md §3.

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
// "no hook for this state, even if workflow-level declares one". `timeout_ms` is
// not overridable per state — it's a global safety bound, not behavior.
//
// `after_run` is intentionally absent: the post-attempt push + PR-create handoff
// is a typed `actions:` block on the Done state now (push_branch +
// create_pr_if_missing). The parser warns and drops `after_run` when an operator
// still declares it; the three remaining hook kinds keep working.
//
// Deprecated for state-machine-mutating glue: prefer the `actions:` block on a state
// (typed records, see src/actions/types.ts) over shell hooks for new work. A state
// that declares both `hooks:` and `actions:` runs `actions:` and ignores `hooks:`;
// a startup deprecation warning is logged in validateDispatch.
export interface StateHooksConfig {
  after_create?: string | null;
  before_run?: string | null;
  before_remove?: string | null;
}

/**
 * Per-state PR autopilot behavior (issue 139). Declared on a `terminal` state,
 * this is where the routing that used to live in the top-level `pr_autopilot:`
 * block as named strings now lives — on the state it describes. A merge state
 * sets `auto_merge` (the `gh pr merge --auto --<strategy>` strategy) and, when
 * a non-mergeable PR should be sent back to the implementing state, an
 * `on_conflict.route_to`. A close state sets `close: true`. The engine on/off
 * switch + poll TTL stay host-global in the slim top-level `pr:` block
 * ({@link PrConfig}); the merge/close/route targets are derived by scanning
 * states for this field (`derivePrRouting` in src/workflow.ts), never by name.
 */
export interface StatePrConfig {
  /** Merge state: arm GitHub auto-merge with this strategy. */
  auto_merge?: 'squash' | 'merge' | 'rebase';
  /**
   * Merge state: where to route the issue when its PR is non-mergeable so the
   * dispatched agent rebases. `route_to` is cross-referenced against the
   * declared states map at validation time (an undeclared target is rejected).
   * Reuses the `actions` `on_conflict: { route_to }` vocabulary for consistency.
   */
  on_conflict?: { route_to: string };
  /** Close state: close the PR without merging (typically Cancelled). */
  close?: boolean;
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
  /**
   * Per-state concurrency cap (issue 137): the maximum number of agents the
   * orchestrator runs simultaneously for issues in this state. When set, the
   * orchestrator's per-state slot accounting reads this instead of the
   * deprecated top-level `agent.max_concurrent_agents_by_state` by-name map —
   * concurrency now lives on the state, symmetric with `max_turns`. Undefined
   * means "no per-state cap; only the global `agent.max_concurrent_agents`
   * ceiling applies". Validated as a positive integer at parse time, and the
   * sum of per-state caps is validated against the global ceiling in
   * `validateDispatch`. The deprecated by-name map is folded into this field at
   * parse time (per-state values win on conflict) for one release.
   */
  max_concurrent?: number;
  allowed_transitions?: string[] | null;
  hooks?: StateHooksConfig;
  /**
   * Typed action DAG (issue 36, reconciler v2). When set on a `terminal` state,
   * this list runs in place of `after_run` shell on transition into the state.
   * When `actions:` and `hooks:` are both declared, the actions list wins and a
   * startup-time deprecation warning is logged. Schema lives in
   * src/actions/types.ts (`WorkflowAction` union); the field is typed via a
   * `type-only` import so the data model doesn't create a runtime cycle with
   * the action executor.
   */
  actions?: import('./actions/types.js').WorkflowAction[];
  /**
   * Eval/debug mode (issue 40). When true, the runner adds two extra
   * read-only bind mounts to dispatches in this state so an in-VM agent can
   * inspect symphony's own state for evaluation or debugging:
   *
   *   • `tracker.root` → `/symphony/issues` (every issue file across every
   *     state directory)
   *   • `logs.root`    → `/symphony/logs`   (per-issue JSONL run-log
   *     transcripts captured by RunLog)
   *
   * Either mount is skipped if the corresponding root is unset. Each VFS mount
   * has a cost so the flag is opt-in per state rather than a
   * workflow-wide default — flip it on for a dedicated eval state, not for
   * routine implement/review flow.
   */
  eval_mode?: boolean;
  /**
   * Per-state PR autopilot routing (issue 139). Valid only on a `terminal`
   * state. The merge state carries `{ auto_merge, on_conflict }`; the close
   * state carries `{ close: true }`. The reconciler / orchestrator derive the
   * merge/close/route targets by scanning states for this field instead of
   * reading named strings from a sibling `pr_autopilot:` block. See
   * {@link StatePrConfig}.
   */
  pr?: StatePrConfig;
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
  /**
   * Global host ceiling on simultaneously-running agents across every state. This is
   * the cross-state RAM bound that memory admission (`computeMemoryAdmission`) clamps,
   * and the value the sum of per-state `StateConfig.max_concurrent` caps is validated
   * against. It stays top-level (not on a state) because it bounds total host memory
   * across all VMs at once — a genuinely cross-state concern.
   */
  max_concurrent_agents: number;
  max_turns: number;
  max_retry_backoff_ms: number;
  /**
   * DEPRECATED (issue 137): per-state concurrency now lives on the state as
   * `StateConfig.max_concurrent`. This top-level by-name map is still read for one
   * release — the parser folds its entries into the matching state's `max_concurrent`
   * (per-state values win on conflict) and logs a single deprecation warning — then
   * the field is removed. State keys are normalized to lowercase; invalid/non-positive
   * entries are ignored.
   */
  max_concurrent_agents_by_state: Record<string, number>;
  /**
   * When true, the orchestrator reads `/proc/meminfo` on every tick and clamps the
   * effective concurrency cap to what currently fits in
   * `MemAvailable - host_memory_reserve_mib` at `gondolin.mem_mib` per VM. Issue 27.
   * When false (or on hosts without /proc/meminfo) the static `max_concurrent_agents`
   * is used unchanged.
   */
  memory_admission_enabled: boolean;
  /**
   * Headroom (MiB) the memory admission cap keeps for the orchestrator process itself,
   * hooks, the per-VM Gondolin runners, and the kernel's own working set. Only consulted when
   * `memory_admission_enabled` is true.
   */
  host_memory_reserve_mib: number;
  /**
   * Circuit breaker (issue 128). After this many CONSECUTIVE dispatch attempts
   * fail with the same normalized reason, the orchestrator stops retrying the
   * issue and routes it to a holding state for a human to inspect — instead of
   * looping forever on a deterministically-failing dispatch (a persistent
   * `401 invalid_api_key` once looped ~324 attempts over ~13h, booting a VM
   * every ~2 min). The streak resets the moment an attempt fails with a
   * different reason or exits cleanly, so transient/varied failures still
   * retry under the normal backoff. `0` disables the breaker entirely.
   */
  circuit_breaker_threshold: number;
}

// ACP adapter configuration. `adapter` selects one of symphony's known adapter profiles
// (currently `claude` and `codex`); the profile encodes the binary symphony launches
// inside the VM. Credentials never enter the VM: the guest only ever holds a token-shaped
// placeholder, and the host substitutes the real key into the outbound request at Gondolin
// egress (TLS-MITM via `createHttpHooks` in src/agent/credential-secrets.ts) — the
// Anthropic OAuth access token for claude, the `~/.codex/auth.json` access token (or host
// `OPENAI_API_KEY`) for codex. Operators who need a custom launch shape fork
// scripts/vm-agent.mjs.
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
   * replaced the earlier in-VM-exec stdio path (which had a stdin-pump bug) and decouples
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
   * Host the in-VM agent uses to reach the bridge. Defaults to 127.0.0.1; Gondolin
   * maps a synthetic guest host to the host loopback (`tcp.hosts`). Other sandboxes
   * that need a different host alias (or a reverse proxy) can override.
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

export interface GondolinVolume {
  host: string;
  guest: string;
  readonly: boolean;
}

export interface GondolinConfig {
  // Gondolin image selector: a build id (digest, e.g. the content-addressed id
  // printed by `npm run build:image`), a `name:tag` ref, or a path to an asset
  // directory exported by images/agents. Passed straight through to
  // `VM.create({ sandbox: { imagePath } })`. Required for dispatch (the runner
  // fails fast at boot when unset).
  image: string | null;
  cpus: number;
  mem_mib: number;
  // Additional host:guest VFS mounts beyond the per-issue workspace (repo
  // caches, eval-mode fixtures, …).
  volumes: GondolinVolume[];
  // Extra env vars forwarded into the VM exec. Credential-bearing vars are
  // stripped before boot regardless (see runner.buildForwardedEnv) so the guest
  // never receives a real token in its PID-1 environment.
  forward_env: string[];
}

// General egress firewall for the in-VM agent (WORKFLOW.md `egress:`). Gondolin
// denies guest→non-allowlisted egress by default; these are the dev-tooling hosts
// the agent may reach for gates (npm registry, git hosts, release CDNs).
// SECURITY: this is the firewall ONLY — no credential is ever substituted for
// these hosts. The real token substitutes solely on each adapter's
// `substitutionHosts` (see credential-secrets.ts); the effective per-adapter
// allowlist handed to `createHttpHooks` is THIS list UNION that adapter's
// substitution host(s). So listing a host here grants plain network egress, never
// a token. Entries are bare hostnames (no scheme/port/path), matched against the
// request host; a malformed entry fails safe (the host stays blocked, never opened).
export interface EgressConfig {
  allowed_hosts: string[];
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
  // Hostname or IP the agent uses to reach the orchestrator from inside the VM.
  // Defaults to the QEMU slirp host address. The port is resolved at runtime from the
  // actually-bound HTTP server (NOT server.port at parse time), so `--port` and a workflow
  // that omits server.port can never desync.
  host: string;
  // Full URL override. When set in WORKFLOW.md, this is used verbatim and `host` plus the
  // bound HTTP port are ignored. Use this only when the VM cannot reach the orchestrator
  // through the host gateway (e.g. bridge networking with a fixed reverse-proxy URL).
  explicit_host_url: string | null;
}

// PR autopilot engine toggle (issue 38; slimmed in issue 139). When `enabled`
// is true the reconciler grows a `pr` resource that arms GitHub's auto-merge on
// each merge-state issue's PR when mergeable, routes non-mergeable PRs back to
// the implementing state (where the agent rebases onto a freshly-fetched base
// as part of its normal flow), and reaps the workspace + remote branch once
// GitHub merges or closes the PR. Default off so a workflow that does not
// declare the block (or declares it with enabled:false) behaves exactly as
// before.
//
// This is the host-global half only — the engine on/off switch and the per-PR
// `gh pr view` cache TTL. The merge/close/route targets and the auto-merge
// strategy moved ONTO the states they describe ({@link StatePrConfig} on a
// terminal state) and are derived by scanning states (`derivePrRouting`), not
// named here.
//
// `poll_interval_ms` is the per-PR GitHub view cache TTL. The reconciler may
// run more often than this (its own backstop tick is independent), but a
// single PR view is reused within the window.
export interface PrConfig {
  enabled: boolean;
  poll_interval_ms: number;
}

// Derived compatibility view of the old top-level `pr_autopilot:` block. The
// authored surface is now {@link PrConfig} (engine) + {@link StatePrConfig}
// (per-state routing); this struct is materialized in `buildServiceConfig` from
// the engine toggle + the state scan (`derivePrRouting`) PURELY so the two
// consumers that still read the old shape keep working without churn:
// `src/mcp.ts` (reads `enabled` + `merge_state` to suppress terminal workspace
// cleanup on the merge state) and `src/bin/symphony.ts` (feeds it to the MCP
// registry). Both are outside issue 139's allowed_paths; a follow-up migrates
// them to read `pr` + `derivePrRouting` and deletes this field.
//
// `merge_state` is the terminal state declaring `pr.auto_merge` (empty string
// when none does). `close_state` is the terminal state declaring
// `pr.close: true`. `conflict_route_to` is that merge state's
// `pr.on_conflict.route_to`. All are derived, never authored.
export interface PrAutopilotConfig {
  enabled: boolean;
  merge_state: string;
  close_state: string | null;
  conflict_route_to: string | null;
  auto_merge_strategy: 'squash' | 'merge' | 'rebase';
  poll_interval_ms: number;
}

/**
 * Sleep-cycle auto-arm (issue 125, follow-up to 122). When `enabled`, the
 * orchestrator moves the recurring reflection issue (`issue_id`) from its
 * `dormant_state` (a holding state it rests in between runs) into the active
 * `reflect_state` automatically, on the "sleep when not busy" framing, when
 * either trigger fires:
 *
 *   • `arm_on_idle` and the orchestrator is idle (nothing running, claimed, or
 *     pending retry, and no active-state candidate this poll) AND at least one
 *     issue has reached a terminal state since the last reflection run —
 *     otherwise an idle orchestrator would re-arm reflection in a tight loop
 *     with nothing new to mine; or
 *   • `arm_after_done > 0` and that many issues have reached a terminal state
 *     (the work the reflector mines) since the last reflection run.
 *
 * The counter resets to 0 the moment the reflection issue is armed, so "since
 * the last reflection run" is measured from the previous arm. It is held in
 * orchestrator memory only (a process restart resets it to 0).
 *
 * Default off, so a workflow that does not declare the block — or declares it
 * with `enabled: false` — is unaffected, and the only cadence is the
 * operator/cron/`mv`-on-disk path from issue 122. Auto-arming ONLY moves the
 * issue into `reflect_state`; the proposals that reflection produces still land
 * in Triage and still require human approve/discard. It does not bypass the
 * human gate.
 *
 * `dormant_state` / `reflect_state` are case-insensitive lookups against the
 * declared states map, checked at validation time (when enabled): the dormant
 * state must be `holding`, the reflect state must be `active`. `issue_id` is
 * the reflection issue's tracker id/identifier; it is required when enabled.
 */
export interface SleepCycleConfig {
  enabled: boolean;
  issue_id: string | null;
  dormant_state: string;
  reflect_state: string;
  arm_on_idle: boolean;
  arm_after_done: number;
}

/**
 * Host-side credential lifecycle (issue 113). The ticker interval that
 * proactively spawns `claude -p "ok"` to keep the host's cached access token
 * warm during idle periods, so a long-lived dispatch's egress substitution
 * always has a fresh upstream token to inject.
 */
export interface CredentialsConfig {
  /**
   * How often the host ticker spawns `claude -p "ok"` to keep the OAuth
   * cache warm. Belt-and-braces to the per-VM proactive refresh. Default:
   * 6h. Set to 0 to disable the ticker entirely (operator runs their own
   * systemd timer instead).
   */
  ticker_interval_ms: number;
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
  gondolin: GondolinConfig;
  egress: EgressConfig;
  server: ServerConfig;
  mcp: McpConfig;
  // Slim host-global PR engine toggle (issue 139). Authoritative for enabled +
  // poll TTL; merge/close/route targets are derived from the states map.
  pr: PrConfig;
  // Derived compatibility view of `pr` + the state scan, kept only for the
  // out-of-allowed-paths consumers (mcp.ts, bin/symphony.ts). See
  // {@link PrAutopilotConfig}.
  pr_autopilot: PrAutopilotConfig;
  sleep_cycle: SleepCycleConfig;
  credentials: CredentialsConfig;
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
  // BEFORE workspace setup, before_run hooks, or VM bring-up — anything that
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
  // Snapshot of the most recent state transition performed during the active
  // attempt — set by the MCP `transition` tool (and by the runner's action
  // reroute). The orchestrator folds it into the per-issue run log as a
  // `transition` lifecycle event after the attempt unwinds, so the run-summary
  // reducer (src/runlog.ts) can reconstruct the trajectory (state path,
  // rejection notes, terminal outcome) without re-parsing the raw frame stream.
  // Null until the issue transitions.
  last_transition: TransitionRecord | null;
}

/**
 * Snapshot of a single state transition. Stashed on the running entry at the
 * transition site (MCP tool / action reroute) and emitted by the orchestrator
 * shell as a `transition` run-log event. Kept deliberately small: the
 * run-summary reducer reads these to rebuild the state path, count review
 * rejections, capture each rejection's notes, and label the terminal outcome.
 */
export interface TransitionRecord {
  from_state: string;
  to_state: string;
  /** Notes appended to the issue body on this move (reviewer rework notes, PR body, …). */
  notes: string;
  /** Resolved "<adapter>/<model>" actor that performed the move, or null when unknown. */
  actor: string | null;
  /** True when `to_state` has `role: terminal` (this move ends the run). */
  terminal: boolean;
  /** True for conflict/rework reroutes (PR-autopilot merge conflict, action `route_to`). */
  rerouted?: boolean;
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
