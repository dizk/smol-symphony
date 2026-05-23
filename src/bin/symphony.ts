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
import { existsSync } from 'node:fs';
import { loadWorkflow, buildServiceConfig, watchWorkflow } from '../workflow.js';
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
import { Reconciler } from '../reconciler/index.js';
import { log } from '../logging.js';

interface Cli {
  subcommand: 'serve' | 'rerun';
  workflow: string;
  port: number | null;
  reconcileForce: boolean;
  /** When subcommand=rerun: name of the run_in_vm action to invalidate. */
  rerunCheck: string | null;
}

function parseCli(argv: string[]): Cli {
  // Detect subcommands. `reconcile` and `rerun` share the parsed-args
  // skeleton with the default `serve` mode; the subcommand is what differs
  // at the action layer (main() dispatches accordingly).
  let subcommand: 'serve' | 'reconcile' | 'rerun' = 'serve';
  let rest = argv;
  if (argv[0] === 'reconcile') {
    subcommand = 'reconcile';
    rest = argv.slice(1);
  } else if (argv[0] === 'rerun') {
    subcommand = 'rerun';
    rest = argv.slice(1);
  }
  let workflow: string | null = null;
  let port: number | null = null;
  let reconcileForce = false;
  let rerunCheck: string | null = null;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === '--port' || a === '-p') {
      const v = rest[++i];
      if (!v) {
        process.stderr.write(`error: --port requires a value\n`);
        process.exit(2);
      }
      const n = parseInt(v, 10);
      if (!Number.isFinite(n) || n < 0) {
        process.stderr.write(`error: invalid --port value: ${v}\n`);
        process.exit(2);
      }
      port = n;
    } else if (a.startsWith('--port=')) {
      const n = parseInt(a.slice('--port='.length), 10);
      if (!Number.isFinite(n) || n < 0) {
        process.stderr.write(`error: invalid --port value: ${a}\n`);
        process.exit(2);
      }
      port = n;
    } else if (subcommand === 'reconcile' && a === '--force') {
      reconcileForce = true;
    } else if (a === '--reconcile-force') {
      // Top-level alias for `reconcile --force`. Kept so existing invocations and
      // process-manager unit files don't need rewriting; the new canonical shape is
      // `symphony reconcile --force [path]`.
      reconcileForce = true;
    } else if (subcommand === 'rerun' && (a === '--check' || a === '-c')) {
      const v = rest[++i];
      if (!v) {
        process.stderr.write(`error: --check requires a value\n`);
        process.exit(2);
      }
      rerunCheck = v;
    } else if (subcommand === 'rerun' && a.startsWith('--check=')) {
      rerunCheck = a.slice('--check='.length);
    } else if (a === '-h' || a === '--help') {
      process.stdout.write(
        `symphony [path-to-WORKFLOW.md] [--port PORT] [--reconcile-force]\n` +
          `symphony reconcile [path-to-WORKFLOW.md] [--force] [--port PORT]\n` +
          `symphony rerun --check=<name> [path-to-WORKFLOW.md]\n\n` +
          `If path is omitted, ./WORKFLOW.md is used.\n` +
          `\`reconcile --force\` (or the alias \`--reconcile-force\`) invalidates the\n` +
          `cached bake artifact and rebakes before dispatching.\n` +
          `\`rerun --check=<name>\` invalidates the named run_in_vm action's content-hash\n` +
          `cache entry so the next dispatch into its state re-executes it.\n`,
      );
      process.exit(0);
    } else if (!workflow) {
      workflow = a;
    } else {
      process.stderr.write(`error: unexpected argument: ${a}\n`);
      process.exit(2);
    }
  }
  return {
    subcommand: subcommand === 'rerun' ? 'rerun' : 'serve',
    workflow: workflow ?? path.resolve(process.cwd(), 'WORKFLOW.md'),
    port,
    reconcileForce,
    rerunCheck,
  };
}

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
  let def;
  try {
    def = await loadWorkflow(workflowPath);
  } catch (err) {
    process.stderr.write(`error: failed to load workflow: ${(err as Error).message}\n`);
    return 1;
  }
  let cfg;
  try {
    cfg = buildServiceConfig(def.config, workflowPath);
  } catch (err) {
    process.stderr.write(`error: failed to parse workflow: ${(err as Error).message}\n`);
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

async function main() {
  const cli = parseCli(process.argv.slice(2));
  const workflowPath = path.resolve(cli.workflow);
  if (!existsSync(workflowPath)) {
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

  let src;
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

  const tracker = new LocalMarkdownTracker(config.tracker);
  // Materialize every declared state directory under tracker.root up front so
  // the dashboard sees the full set of columns (including `holding` states like
  // Triage) before any issue lands in them.
  try {
    await tracker.start();
  } catch (err) {
    process.stderr.write(`error: tracker init failed: ${(err as Error).message}\n`);
    await src.stop().catch(() => undefined);
    process.exit(1);
  }
  const workspaces = new WorkspaceManager(config);
  const smolvm = new SmolvmClient(config.smolvm);
  // Always instantiate the registry so a workflow reload that flips mcp.enabled from
  // false to true takes effect without a process restart. The runner and HTTP routes
  // gate behavior on cfg.mcp.enabled at runtime; an inactive registry holds no entries
  // and answers all routes with "not active."
  const mcp = new McpRegistry(tracker, {
    states: config.states,
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
  // tracker's non-terminal issue set (issue 34). Smolvm client is passed at
  // construction; the orchestrator wires itself in as both the
  // IntendedVmProvider and the WorkspaceIntendedProvider after its own
  // construction below.
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
  orch = new Orchestrator(
    config,
    definition,
    src,
    tracker,
    workspaces,
    runner,
    undefined,
    reconciler,
  );
  // The Reconciler is constructed before the Orchestrator (the runner needs
  // the reconciler at its own construction time for the bake-artifact path),
  // so the vm reaper's IntendedVmProvider is plugged in here instead of at
  // Reconciler construction. The vm resource is only built when both
  // `smolvm` (passed above) and an intended provider are wired.
  reconciler.setIntendedVmProvider(orch);
  // Same ordering reason for the workspace resource (issue 34). The
  // orchestrator owns the tracker read used to compute the intended set; we
  // pass it in once it exists. Removal is delegated to WorkspaceManager so
  // the workflow-level `before_remove` hook fires on janitor removals — the
  // closure captures `workspaces` (whose config is kept live via
  // updateConfig on reload), so a rotated `workspace.root` or hooks block
  // takes effect without rebuilding the reconciler.
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

  // The tracker view is resolved through a getter so reloaded config (e.g. a moved
  // tracker.root, changed active/terminal states) is reflected by both the propagation
  // hook and the HTTP UI without rebinding the server.
  let liveCfg = config;
  orch.setOnConfigReloaded((cfg, def) => {
    tracker.updateConfig(cfg.tracker);
    workspaces.updateConfig(cfg);
    runner.updateConfig(cfg, def);
    mcp.updateStates(cfg.states);
    // The orchestrator's onChange handler already forwards the new config to
    // the reconciler (so a Smolfile-path change kicks off a new bake); we do
    // not re-forward here. liveCfg drives the HTTP dashboard's tracker view.
    liveCfg = cfg;
    // Materialize any state directory the reload introduced. Best-effort: a
    // mkdir failure here would normally come from a tracker.root rotation that
    // also failed at validateDispatch, so logging is enough.
    void tracker.start().catch((err) => {
      log.warn('tracker reinit after reload failed', { error: (err as Error).message });
    });
  });

  // Start the ACP TCP bridge BEFORE accepting any dispatches. A bind failure here is
  // fatal — we cannot run agents without their transport.
  try {
    await acpBridge.start(config.acp.bridge.bind_host, config.acp.bridge.bind_port);
  } catch (err) {
    process.stderr.write(
      `error: failed to bind ACP bridge on ${config.acp.bridge.bind_host}:${config.acp.bridge.bind_port}: ${(err as Error).message}\n`,
    );
    await src.stop().catch(() => undefined);
    process.exit(1);
  }

  let http: { close: () => Promise<void>; port: number } | null = null;
  const httpPort = cli.port ?? config.server.port;
  if (httpPort !== null && httpPort !== undefined) {
    try {
      http = await startHttpServer(orch, {
        port: httpPort,
        host: config.server.host,
        getTrackerView: () => ({
          trackerRoot: liveCfg.tracker.root,
          // Canonical per-state config in workflow declaration order. The HTTP
          // dashboard reads role from here for pill colours, declared order for
          // the on-disk listing, and approve/discard targets — each consumer
          // filters by role on demand. The closure reads `liveCfg.states` on
          // every request, and the reload callback reassigns `liveCfg` to the
          // freshly-parsed config, so a workflow reload is reflected here
          // without rebinding the server. Phase 3 wired the equivalent for the
          // MCP registry via `mcp.updateStates`; this view is its dashboard twin.
          states: Object.entries(liveCfg.states).map(([name, cfg]) => ({
            name,
            role: cfg.role,
          })),
          workflowPath,
        }),
        mcp,
        tracker,
      });
      // Tell the registry the actually-bound port (which differs from httpPort when
      // --port 0 is used and the kernel picks an ephemeral port). MCP URLs injected into
      // agents must point at the real listener, not the requested-port placeholder.
      mcp.setEffectivePort(http.port);
    } catch (err) {
      process.stderr.write(
        `error: failed to bind HTTP server on ${config.server.host}:${httpPort}: ${(err as Error).message}\n`,
      );
      await src.stop().catch(() => undefined);
      process.exit(1);
    }
  }

  // MCP precondition check: with mcp.enabled (the default), every dispatch will
  // require a reachable MCP URL. Verify NOW that one can be constructed, rather
  // than letting each per-issue dispatch fail with the same error after VM
  // bring-up costs are sunk. This catches the "WORKFLOW.md has no server.port,
  // and no --port was passed" misconfiguration at boot.
  if (config.mcp.enabled) {
    // The mcp.host_url override exists so an operator can point the in-VM agent
    // at a reverse-proxy-visible URL even when symphony binds the listener at
    // a different host/port. It does NOT replace the listener itself: symphony
    // is the process that actually serves /api/v1/issues/<id>/mcp. If no HTTP
    // listener was bound, the override would advertise a URL nothing answers,
    // and transition calls from the agent would fail. Refuse to boot in that
    // shape so the misconfiguration surfaces at startup instead of mid-dispatch.
    if (http === null) {
      process.stderr.write(
        `error: mcp.enabled=true but no HTTP server is configured. Symphony itself\n` +
          `must bind a listener (set --port or server.port) so it can serve the MCP\n` +
          `endpoint, even when mcp.host_url points the in-VM agent at a reverse proxy.\n`,
      );
      await src.stop().catch(() => undefined);
      process.exit(1);
    }
    const probeUrl = mcp.buildUrl('startup-check', {
      host: config.mcp.host,
      explicit_host_url: config.mcp.explicit_host_url,
    });
    if (probeUrl === null) {
      process.stderr.write(
        `error: mcp.enabled=true but no MCP URL can be constructed. ` +
          `Set --port, server.port, or mcp.host_url so the in-VM agent can reach ` +
          `the symphony MCP endpoint.\n`,
      );
      if (http) await http.close().catch(() => undefined);
      await src.stop().catch(() => undefined);
      process.exit(1);
    }
  }

  try {
    await orch.start();
  } catch (err) {
    process.stderr.write(`startup failed: ${(err as Error).message}\n`);
    if (http) await http.close().catch(() => undefined);
    await src.stop().catch(() => undefined);
    process.exit(1);
  }
  if (cli.reconcileForce) {
    // `--reconcile-force`: drop any cached bake artifact and rebuild before
    // dispatching. The orchestrator's reconciler gate keeps dispatch off until
    // the rebuild lands, so callers that pass --force after a dependency change
    // get a guaranteed fresh artifact on the next dispatch.
    log.info('reconcile --force requested');
    void orch.triggerReconcile({ force: true }).catch((err) =>
      log.warn('reconcile --force failed', { error: (err as Error).message }),
    );
  }
  log.info('symphony started', {
    workflow: workflowPath,
    workspace_root: config.workspace.root,
    tracker_root: config.tracker.root,
    poll_interval_ms: config.polling.interval_ms,
    http_port: httpPort,
  });

  const shutdown = async (signal: string) => {
    log.info('shutdown requested', { signal });
    await orch.stop();
    await acpBridge.stop().catch(() => undefined);
    if (http) await http.close().catch(() => undefined);
    await src.stop().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  process.stderr.write(`fatal: ${(err as Error).message}\n${(err as Error).stack ?? ''}\n`);
  process.exit(1);
});
