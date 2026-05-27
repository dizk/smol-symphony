#!/usr/bin/env node
// CLI entry. Usage:
//   symphony [path-to-WORKFLOW.md] [--port <port>]
//   symphony reconcile [path-to-WORKFLOW.md] [--force] [--port <port>]
//   symphony rerun --check=<name> [path-to-WORKFLOW.md]
//
// Default workflow path is ./WORKFLOW.md.
//
// The `reconcile` subcommand boots symphony exactly the same way as the bare
// form; `--force` additionally invalidates any cached bake artifact for the
// current Smolfile hash before dispatch so the next bake is guaranteed to
// rebuild. `--reconcile-force` is kept as a top-level alias for ergonomics.
//
// The `rerun` subcommand (issue 36) invalidates one `run_in_vm` action's
// content-hash cache entries so the next dispatch into the state hosting it
// re-executes. It does not start a long-running process — it scans the
// workflow's state actions for a matching name and `rm`s the per-name cache
// namespace directory under `<cacheRoot>/actions/run_in_vm/<name>/`. The
// per-execution hash is workspace-dependent (the agent's edits change the
// tree); namespacing the cache by action name on disk means the CLI doesn't
// need to know any per-issue workspace state to invalidate the right
// entries.

import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline';
import { existsSync } from 'node:fs';
import { parseCli, type Cli } from './cli-args.js';
import { loadWorkflow, watchWorkflow } from '../workflow-loader.js';
import { scaffoldWorkflow, ScaffoldError } from '../scaffold.js';
import { invalidateRunInVmByName } from '../actions/index.js';
import type { RunInVmAction, WorkflowAction } from '../actions/index.js';
import { LocalMarkdownTracker } from '../trackers/local.js';
import { WorkspaceManager } from '../workspace.js';
import { SmolvmClient } from '../agent/smolvm.js';
import { AgentRunner } from '../agent/runner.js';
import { Orchestrator } from '../orchestrator.js';
import { startHttpServer } from '../http.js';
import { McpRegistry } from '../mcp.js';
import { AcpBridge } from '../acp-bridge.js';
import { GhCliPrApi, GitCliPrGitApi, Reconciler } from '../reconciler/index.js';
import { closeLogFile, log, setLogFile } from '../logging.js';
import type { ServiceConfig, WorkflowDefinition } from '../types.js';
import type { WorkflowSource } from '../workflow.js';

/**
 * Walk every declared state's `actions:` for a run_in_vm whose `name` matches
 * `target`. Returns the first match; duplicates would let a single rerun
 * invalidate multiple entries, which is rarely intended (operator wants to
 * re-run *one* named check).
 */
function findRunInVmByName(
  states: Record<string, { actions?: WorkflowAction[] }>,
  target: string,
): { state: string; action: RunInVmAction } | null {
  for (const [stateName, sc] of Object.entries(states)) {
    if (!sc.actions) continue;
    for (const a of sc.actions) {
      if (a.kind === 'run_in_vm' && a.name === target) {
        return { state: stateName, action: a };
      }
    }
  }
  return null;
}

async function runRerunCheck(workflowPath: string, name: string): Promise<number> {
  let cfg;
  try {
    ({ config: cfg } = await loadWorkflow(workflowPath));
  } catch (err) {
    process.stderr.write(`error: failed to load workflow: ${(err as Error).message}\n`);
    return 1;
  }
  const match = findRunInVmByName(cfg.states, name);
  if (!match) {
    process.stderr.write(
      `error: no run_in_vm action named "${name}" declared in WORKFLOW.md\n`,
    );
    return 2;
  }
  // Drop the per-name cache namespace directory. This invalidates every
  // hash entry under that name regardless of which per-issue workspace the
  // execution computed its hash against — the orchestrator's next dispatch
  // re-executes the check because the namespace is empty.
  await invalidateRunInVmByName(match.action);
  process.stdout.write(
    `invalidated run_in_vm "${name}" (state=${match.state})\n`,
  );
  return 0;
}

/**
 * Read a single line from stdin with the given prompt. Resolves to the
 * trimmed input string (without the trailing newline). The readline interface
 * is closed before resolving so the process can exit cleanly afterwards.
 */
function promptLine(message: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise<string>((resolve) => {
    rl.question(message, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

/**
 * When the workflow file is missing and the operator is at an interactive
 * terminal, ask whether to scaffold a starter file. Returns true if the
 * scaffold was written (caller can continue boot), false otherwise (caller
 * should fall through to the usual "file not found" error).
 *
 * Non-interactive invocations (cron jobs, CI, container ENTRYPOINTs) skip the
 * prompt entirely and return false — silently scaffolding files into someone
 * else's working tree without a confirmed yes is the wrong default for a tool
 * that's usually run by an operator who knows where their workflow lives.
 */
async function maybeScaffoldMissingWorkflow(workflowPath: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  const answer = await promptLine(
    `WORKFLOW.md not found at ${workflowPath}.\nScaffold a starter workflow file here? [Y/n] `,
  );
  const normalized = answer.trim().toLowerCase();
  // Default-accept: bare enter, "y", "yes". Anything else is "no".
  const accept = normalized === '' || normalized === 'y' || normalized === 'yes';
  if (!accept) return false;
  try {
    const result = await scaffoldWorkflow({ workflowPath });
    process.stdout.write(`wrote ${result.workflowPath}\n`);
    process.stdout.write(
      `Edit it to point smolvm at your image / Smolfile / packed artifact, ` +
        `then run \`symphony ${path.relative(process.cwd(), result.workflowPath) || workflowPath}\` again.\n`,
    );
    return true;
  } catch (err) {
    const msg = err instanceof ScaffoldError ? err.message : (err as Error).message;
    process.stderr.write(`error: scaffold failed: ${msg}\n`);
    return false;
  }
}

/**
 * Centralized startup-failure cleanup. Writes the message, closes the optional
 * HTTP listener and workflow watcher, flushes the persistent log sink, and
 * exits non-zero. Returns `never` so call sites can treat the path as a hard
 * terminator and TypeScript narrows away post-call code.
 *
 * `flushLogs` matters because `process.exit` does NOT drain pending WriteStream
 * writes — without `closeLogFile()` we'd lose the final lines symphony.log was
 * about to receive (the startup-failure stderr line itself is unaffected, but
 * any buffered `log.*` output would be dropped).
 */
async function bailStartup(
  message: string,
  opts: { http?: { close: () => Promise<void> } | null; src: WorkflowSource },
): Promise<never> {
  process.stderr.write(message);
  if (opts.http) await opts.http.close().catch(() => undefined);
  await opts.src.stop().catch(() => undefined);
  await closeLogFile().catch(() => undefined);
  process.exit(1);
}

/**
 * Handle the two early-exit subcommands that don't enter the orchestrator
 * graph: a missing workflow file (offer to scaffold, or fail), and the
 * `rerun --check=<name>` subcommand (invalidate one action's cache and exit).
 * Returns to the caller only on the happy path of `serve`/`reconcile` against
 * an existing workflow.
 */
async function handlePreflight(cli: Cli, workflowPath: string): Promise<void> {
  if (!existsSync(workflowPath)) {
    // `rerun` operates on an existing workflow's action namespace; there is
    // nothing to scaffold against. Same for `reconcile`, which only makes sense
    // when a workflow already exists. Prompt only on the bare `serve` path.
    if (cli.subcommand === 'serve') {
      const scaffolded = await maybeScaffoldMissingWorkflow(workflowPath);
      // Stop here on purpose: the operator hasn't finished filling in
      // smolvm/source-of-truth fields yet, and dispatching immediately
      // would just fail at the first attempt with a confusing error. The
      // scaffold message already tells them how to relaunch.
      if (scaffolded) process.exit(0);
    }
    process.stderr.write(`error: workflow file not found: ${workflowPath}\n`);
    process.exit(2);
  }
  if (cli.subcommand === 'rerun') {
    if (!cli.rerunCheck) {
      process.stderr.write(`error: rerun requires --check=<name>\n`);
      process.exit(2);
    }
    const code = await runRerunCheck(workflowPath, cli.rerunCheck);
    process.exit(code);
  }
}

interface LoadedConfig {
  src: WorkflowSource;
  definition: WorkflowDefinition;
  config: ServiceConfig;
  /** Snapshot of $SYMPHONY_LOG_FILE so the reload handler knows whether the
   *  operator pinned the log path (empty string disables; absent uses logs.root). */
  envLogFile: string | undefined;
  logFile: string | null;
}

/**
 * Start the workflow watcher, validate that this build can serve the parsed
 * tracker (currently `kind=local` only), and resolve the persistent log file
 * path. Mirrors stderr to disk so an agent reviewing a run after the fact
 * (typically inside a VM with the workspace + .symphony/logs/ mounted in) can
 * read orchestrator-side events — workflow reloads, dispatch decisions, hook
 * results, reconciler ticks — alongside the per-issue JSONL run logs in the
 * same directory.
 *
 * Path resolution: `SYMPHONY_LOG_FILE` env override wins (`""` disables the
 * sink); otherwise `<logs.root>/symphony.log`. The directory is created on
 * demand. File-sink failure is swallowed: symphony continues on stderr only.
 */
async function loadAndValidateConfig(workflowPath: string): Promise<LoadedConfig> {
  let src: WorkflowSource;
  try {
    src = await watchWorkflow(workflowPath);
  } catch (err) {
    process.stderr.write(`error: failed to load workflow: ${(err as Error).message}\n`);
    process.exit(1);
  }
  const { definition, config } = src.current();
  if (config.tracker.kind !== 'local') {
    process.stderr.write(
      `error: this build supports tracker.kind=local only (got: ${config.tracker.kind || '<unset>'})\n`,
    );
    process.exit(2);
  }
  const envLogFile = process.env.SYMPHONY_LOG_FILE;
  const logFile =
    envLogFile === undefined
      ? path.join(config.logs.root, 'symphony.log')
      : envLogFile === ''
        ? null
        : envLogFile;
  setLogFile(logFile);
  return { src, definition, config, envLogFile, logFile };
}

interface OrchestratorGraph {
  tracker: LocalMarkdownTracker;
  workspaces: WorkspaceManager;
  smolvm: SmolvmClient;
  mcp: McpRegistry;
  acpBridge: AcpBridge;
  reconciler: Reconciler;
  runner: AgentRunner;
  orch: Orchestrator;
  /** Reads the most recent reloaded config. The HTTP dashboard's tracker view
   *  resolves through this so a workflow reload (which reassigns the live
   *  config) is reflected without rebinding the server. */
  getLiveCfg: () => ServiceConfig;
}

/**
 * Build the in-process graph: tracker, workspaces, smolvm, mcp, acpBridge,
 * reconciler, runner, orchestrator. Wires the post-construction provider
 * hooks (`reconciler.setIntendedVmProvider` / `setWorkspaceProviders` /
 * `setPrAutopilotProviders`) and the reload callback that propagates config
 * updates through every component.
 *
 * The Reconciler is constructed before the Orchestrator (the runner needs the
 * reconciler at its own construction time for the bake-artifact path), so the
 * vm reaper's IntendedVmProvider and workspace providers are plugged in after
 * the orchestrator exists. The vm resource is only built when both `smolvm`
 * (passed at Reconciler construction) and an intended provider are wired.
 */
async function buildOrchestratorGraph(opts: {
  config: ServiceConfig;
  definition: WorkflowDefinition;
  src: WorkflowSource;
  envLogFile: string | undefined;
}): Promise<OrchestratorGraph> {
  const { config, definition, src, envLogFile } = opts;
  const tracker = new LocalMarkdownTracker(config.tracker);
  // Materialize every declared state directory under tracker.root up front so
  // the dashboard sees the full set of columns (including `holding` states like
  // Triage) before any issue lands in them.
  try {
    await tracker.start();
  } catch (err) {
    await bailStartup(`error: tracker init failed: ${(err as Error).message}\n`, { src });
  }
  const workspaces = new WorkspaceManager(config);
  const smolvm = new SmolvmClient(config.smolvm);
  // Always instantiate the registry so a workflow reload that flips mcp.enabled from
  // false to true takes effect without a process restart. The runner and HTTP routes
  // gate behavior on cfg.mcp.enabled at runtime; an inactive registry holds no entries
  // and answers all routes with "not active."
  const mcp = new McpRegistry(tracker, {
    states: config.states,
    prAutopilot: config.pr_autopilot,
    now: () => Date.now(),
  });
  // ACP transport. The bridge listens on a TCP port for the in-VM agent's dial-back,
  // replacing the smolvm-exec stdio path. Started below alongside the HTTP server so a
  // bind failure surfaces before we accept any dispatches.
  const acpBridge = new AcpBridge();
  // Reconciler (issues 32, 33, 34). Owns the bake artifact lifecycle so the
  // Smolfile's apt + npm install is paid once per Smolfile-content change
  // instead of per dispatch (issue 32), reaps stray `symphony-*` VMs +
  // `_boot-vm` workers that survive process restarts or per-attempt cleanup
  // failures (issue 33), AND keeps per-issue workspace dirs converged to the
  // tracker's non-terminal issue set (issue 34).
  const reconciler = new Reconciler(config, { smolvm });
  // Build the runner with stubs first; we attach the orchestrator's hook callbacks after
  // construction since they reference the orchestrator instance.
  let orch!: Orchestrator;
  const runner = new AgentRunner(
    config,
    definition,
    workspaces,
    tracker,
    smolvm,
    {
      onRuntimeEvent: (id, ev) => orch.reportRuntimeEvent(id, ev),
      onTokenUsage: (id, u) => orch.reportTokenUsage(id, u),
      onRateLimits: (id, s) => orch.reportRateLimits(id, s),
      onTurn: (id, turn) => orch.reportTurnStarted(id, turn),
      onSessionStarted: (info) =>
        orch.reportSessionStarted(info.issueId, {
          sessionId: info.sessionId,
          threadId: info.threadId,
          pid: info.pid,
        }),
    },
    mcp,
    acpBridge,
    reconciler,
    // propose_followup sink (issue 36): orchestrator owns the tracker write
    // path, mirroring how the MCP `propose_issue` tool routes through the
    // tracker. The runner forwards the parent identifier so provenance is
    // recorded the same way.
    { proposeFollowup: (input) => orch.proposeFollowup(input) },
    // Action snapshot sink (issue 36 AC5): per-attempt ledger surfaces on
    // /api/v1/snapshot under reconciler.resources so the dashboard sees
    // "Done.actions: …" alongside the bake/vm/workspace resources.
    { recordActionResult: (id, snap) => orch.recordActionResult(id, snap) },
  );
  orch = new Orchestrator(config, definition, src, tracker, workspaces, runner, undefined, reconciler);
  wirePostConstructionProviders({ reconciler, orch });
  // The tracker view is resolved through a getter so reloaded config (e.g. a moved
  // tracker.root, changed active/terminal states) is reflected by both the propagation
  // hook and the HTTP UI without rebinding the server.
  let liveCfg = config;
  orch.setOnConfigReloaded(buildReloadHandler({
    tracker,
    workspaces,
    runner,
    mcp,
    envLogFile,
    onLiveCfg: (cfg) => {
      liveCfg = cfg;
    },
  }));
  return {
    tracker,
    workspaces,
    smolvm,
    mcp,
    acpBridge,
    reconciler,
    runner,
    orch,
    getLiveCfg: () => liveCfg,
  };
}

/**
 * Plug the orchestrator into the reconciler as the IntendedVmProvider, the
 * workspace intended/baseRef provider (with remove + create delegating back
 * through the orchestrator so workspace hooks fire on reconciler-driven
 * passes), and the PR autopilot's set of providers (intended set, PR/git
 * adapters, transition router, cleanup hook, and workspace re-materializer).
 * Kept as a separate function so `buildOrchestratorGraph` stays within the
 * imperative-shell statement budget.
 */
function wirePostConstructionProviders(opts: {
  reconciler: Reconciler;
  orch: Orchestrator;
}): void {
  const { reconciler, orch } = opts;
  reconciler.setIntendedVmProvider(orch);
  // Removal is delegated to WorkspaceManager so the workflow-level
  // `before_remove` hook fires on janitor removals — the closure captures
  // `workspaces` (whose config is kept live via updateConfig on reload), so a
  // rotated `workspace.root` or hooks block takes effect without rebuilding
  // the reconciler.
  reconciler.setWorkspaceProviders(orch, {
    baseRef: orch,
    remove: (identifier) => orch.removeWorkspace(identifier),
    // Create callback for the reconciler's eager-workspace pass (issue 34).
    // Delegates to `WorkspaceManager.ensureFor` via the orchestrator so the
    // canonical clone+branch+remote setup AND any per-state `after_create`
    // hook fire on reconciler-driven creates the same way they do on
    // dispatch. The intended-set provider supplies the issue's current state
    // alongside the identifier so `resolveHooksForState` picks up a
    // state-level override (e.g. `states.Todo.hooks.after_create`); the
    // per-identifier ensureFor lock collapses any race with concurrent
    // dispatch into one setup pass.
    create: (identifier, state) => orch.createWorkspace(identifier, state),
  });
  // PR autopilot wiring (issue 38). The Reconciler ignores this when
  // `pr_autopilot.enabled` is false (it stays a no-op pass), so we set the
  // providers unconditionally — a reload that flips the flag picks them up
  // via `updateConfig`'s rebuild path.
  reconciler.setPrAutopilotProviders({
    intended: orch,
    pr: new GhCliPrApi({ timeoutMs: 30_000 }),
    git: new GitCliPrGitApi({ timeoutMs: 60_000 }),
    transition: { routeIssue: (input) => orch.routeIssueForAutopilot(input) },
    cleanup: { removeWorkspace: (identifier) => orch.removeWorkspace(identifier) },
    // Issue 53: re-materialize a missing workspace before the autopilot's
    // rebase step so a Done-state PR whose workspace was reaped (e.g.
    // pr_autopilot was enabled after the dir was cleaned by the pre-autopilot
    // terminal rule) gets recovered instead of stalling silently.
    workspaceEnsure: { ensureWorkspace: (args) => orch.ensureWorkspaceForAutopilot(args) },
  });
}

/**
 * Returns the orchestrator's `onConfigReloaded` callback. On every reload it
 * forwards the freshly-parsed config to each long-lived component, retargets
 * the persistent log sink if `logs.root` rotated (unless the env override
 * locked it for the process lifetime), and re-materializes any state
 * directory the new workflow introduced. The orchestrator's own onChange
 * handler already forwards to the reconciler (so a Smolfile-path change kicks
 * off a new bake); we do not re-forward here.
 */
function buildReloadHandler(opts: {
  tracker: LocalMarkdownTracker;
  workspaces: WorkspaceManager;
  runner: AgentRunner;
  mcp: McpRegistry;
  envLogFile: string | undefined;
  onLiveCfg: (cfg: ServiceConfig) => void;
}): (cfg: ServiceConfig, def: WorkflowDefinition) => void {
  const { tracker, workspaces, runner, mcp, envLogFile, onLiveCfg } = opts;
  return (cfg, def) => {
    tracker.updateConfig(cfg.tracker);
    workspaces.updateConfig(cfg);
    runner.updateConfig(cfg, def);
    mcp.updateStates(cfg.states, cfg.pr_autopilot);
    onLiveCfg(cfg);
    if (envLogFile === undefined) {
      setLogFile(path.join(cfg.logs.root, 'symphony.log'));
    }
    // Best-effort: a mkdir failure here would normally come from a tracker.root
    // rotation that also failed at validateDispatch, so logging is enough.
    void tracker.start().catch((err) => {
      log.warn('tracker reinit after reload failed', { error: (err as Error).message });
    });
  };
}

/**
 * Bind the ACP TCP bridge, the optional HTTP server, and verify that — if MCP
 * is enabled — a reachable MCP URL can be constructed. Each bind/precondition
 * failure routes through `bailStartup` so the failure mode is uniform: write
 * to stderr, close any partial listeners, flush logs, exit non-zero.
 *
 * The ACP bridge must come up BEFORE we accept any dispatches: a bind failure
 * here is fatal because we cannot run agents without their transport. The MCP
 * precondition check is hoisted to boot so an in-VM agent doesn't fail mid-
 * dispatch (after the VM bring-up cost is sunk) with a misconfiguration the
 * operator could have caught at startup.
 */
async function startTransports(opts: {
  config: ServiceConfig;
  graph: OrchestratorGraph;
  cli: Cli;
  src: WorkflowSource;
  workflowPath: string;
}): Promise<{ http: { close: () => Promise<void>; port: number } | null }> {
  const { config, graph, cli, src, workflowPath } = opts;
  try {
    await graph.acpBridge.start(config.acp.bridge.bind_host, config.acp.bridge.bind_port);
  } catch (err) {
    await bailStartup(
      `error: failed to bind ACP bridge on ${config.acp.bridge.bind_host}:${config.acp.bridge.bind_port}: ${(err as Error).message}\n`,
      { src },
    );
  }
  const http = await bindHttpServer({ config, graph, cli, src, workflowPath });
  await checkMcpPrecondition({ config, graph, src, http });
  return { http };
}

/**
 * Resolve the HTTP port (CLI override > workflow `server.port` > none), bind
 * if requested, and tell the MCP registry the *actually* bound port. The
 * registry needs the live port (not the requested one) so URLs injected into
 * agents point at the real listener — with `--port 0` the kernel picks an
 * ephemeral port that differs from what we asked for.
 */
async function bindHttpServer(opts: {
  config: ServiceConfig;
  graph: OrchestratorGraph;
  cli: Cli;
  src: WorkflowSource;
  workflowPath: string;
}): Promise<{ close: () => Promise<void>; port: number } | null> {
  const { config, graph, cli, src, workflowPath } = opts;
  const httpPort = cli.port ?? config.server.port;
  if (httpPort === null || httpPort === undefined) return null;
  try {
    const http = await startHttpServer(graph.orch, {
      port: httpPort,
      host: config.server.host,
      // Canonical per-state config in workflow declaration order. The HTTP
      // dashboard reads role from here for pill colours, declared order for
      // the on-disk listing, and approve/discard targets — each consumer
      // filters by role on demand. The closure reads `liveCfg.states` on
      // every request, and the reload callback reassigns `liveCfg` to the
      // freshly-parsed config, so a workflow reload is reflected here
      // without rebinding the server. Phase 3 wired the equivalent for the
      // MCP registry via `mcp.updateStates`; this view is its dashboard twin.
      getTrackerView: () => ({
        trackerRoot: graph.getLiveCfg().tracker.root,
        states: Object.entries(graph.getLiveCfg().states).map(([name, cfg]) => ({
          name,
          role: cfg.role,
        })),
        workflowPath,
      }),
      mcp: graph.mcp,
      tracker: graph.tracker,
    });
    graph.mcp.setEffectivePort(http.port);
    return http;
  } catch (err) {
    // `await bailStartup(...)` resolves to `never` at runtime (the helper calls
    // process.exit), but TS doesn't propagate `Promise<never>` through `await`
    // for unreachability — `return` is what tells the type checker this branch
    // doesn't fall through.
    return await bailStartup(
      `error: failed to bind HTTP server on ${config.server.host}:${httpPort}: ${(err as Error).message}\n`,
      { src },
    );
  }
}

/**
 * MCP precondition check: with mcp.enabled (the default), every dispatch will
 * require a reachable MCP URL. Verify NOW that one can be constructed, rather
 * than letting each per-issue dispatch fail with the same error after VM
 * bring-up costs are sunk. Two failure modes:
 *
 *   1. mcp.enabled but no HTTP listener bound — `mcp.host_url` lets an operator
 *      point the in-VM agent at a reverse proxy but symphony itself must still
 *      serve `/api/v1/issues/<id>/mcp`. Without a listener, the override would
 *      advertise a URL nothing answers.
 *   2. mcp.enabled but the registry cannot build a URL (no port, no host_url).
 */
async function checkMcpPrecondition(opts: {
  config: ServiceConfig;
  graph: OrchestratorGraph;
  src: WorkflowSource;
  http: { close: () => Promise<void>; port: number } | null;
}): Promise<void> {
  const { config, graph, src, http } = opts;
  if (!config.mcp.enabled) return;
  if (http === null) {
    await bailStartup(
      `error: mcp.enabled=true but no HTTP server is configured. Symphony itself\n` +
        `must bind a listener (set --port or server.port) so it can serve the MCP\n` +
        `endpoint, even when mcp.host_url points the in-VM agent at a reverse proxy.\n`,
      { src },
    );
  }
  const probeUrl = graph.mcp.buildUrl('startup-check', {
    host: config.mcp.host,
    explicit_host_url: config.mcp.explicit_host_url,
  });
  if (probeUrl === null) {
    await bailStartup(
      `error: mcp.enabled=true but no MCP URL can be constructed. ` +
        `Set --port, server.port, or mcp.host_url so the in-VM agent can reach ` +
        `the symphony MCP endpoint.\n`,
      { http, src },
    );
  }
}

async function main() {
  const cli = parseCli(process.argv.slice(2));
  const workflowPath = path.resolve(cli.workflow);
  await handlePreflight(cli, workflowPath);

  const { src, config, definition, envLogFile, logFile } =
    await loadAndValidateConfig(workflowPath);
  const graph = await buildOrchestratorGraph({ config, definition, src, envLogFile });
  const { http } = await startTransports({ config, graph, cli, src, workflowPath });

  try {
    await graph.orch.start();
  } catch (err) {
    await bailStartup(`startup failed: ${(err as Error).message}\n`, { http, src });
  }
  if (cli.reconcileForce) {
    // `--reconcile-force`: drop any cached bake artifact and rebuild before
    // dispatching. The orchestrator's reconciler gate keeps dispatch off until
    // the rebuild lands, so callers that pass --force after a dependency change
    // get a guaranteed fresh artifact on the next dispatch.
    log.info('reconcile --force requested');
    void graph.orch.triggerReconcile({ force: true }).catch((err) =>
      log.warn('reconcile --force failed', { error: (err as Error).message }),
    );
  }
  log.info('symphony started', {
    workflow: workflowPath,
    workspace_root: config.workspace.root,
    tracker_root: config.tracker.root,
    log_file: logFile ?? '<disabled>',
    poll_interval_ms: config.polling.interval_ms,
    http_port: cli.port ?? config.server.port,
  });

  const shutdown = async (signal: string) => {
    log.info('shutdown requested', { signal });
    await graph.orch.stop();
    await graph.acpBridge.stop().catch(() => undefined);
    if (http) await http.close().catch(() => undefined);
    await src.stop().catch(() => undefined);
    await closeLogFile().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch(async (err) => {
  process.stderr.write(`fatal: ${(err as Error).message}\n${(err as Error).stack ?? ''}\n`);
  // setLogFile() may have been called before main() threw; flush the sink so
  // any log.* lines emitted before the fault reach symphony.log.
  await closeLogFile().catch(() => undefined);
  process.exit(1);
});
