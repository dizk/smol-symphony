#!/usr/bin/env node
// CLI entry (SPEC §17.7). Usage:
//   symphony [path-to-WORKFLOW.md] [--port <port>]
//
// Default workflow path is ./WORKFLOW.md.

import path from 'node:path';
import process from 'node:process';
import { existsSync } from 'node:fs';
import { watchWorkflow } from '../workflow.js';
import { LocalMarkdownTracker } from '../trackers/local.js';
import { WorkspaceManager } from '../workspace.js';
import { SmolvmClient } from '../agent/smolvm.js';
import { AgentRunner } from '../agent/runner.js';
import { Orchestrator } from '../orchestrator.js';
import { startHttpServer } from '../http.js';
import { McpRegistry } from '../mcp.js';
import { AcpBridge } from '../acp-bridge.js';
import { log } from '../logging.js';

interface Cli {
  workflow: string;
  port: number | null;
}

function parseCli(argv: string[]): Cli {
  let workflow: string | null = null;
  let port: number | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--port' || a === '-p') {
      const v = argv[++i];
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
    } else if (a === '-h' || a === '--help') {
      process.stdout.write(
        `symphony [path-to-WORKFLOW.md] [--port PORT]\n\n` +
          `If path is omitted, ./WORKFLOW.md is used.\n`,
      );
      process.exit(0);
    } else if (!workflow) {
      workflow = a;
    } else {
      process.stderr.write(`error: unexpected argument: ${a}\n`);
      process.exit(2);
    }
  }
  return { workflow: workflow ?? path.resolve(process.cwd(), 'WORKFLOW.md'), port };
}

async function main() {
  const cli = parseCli(process.argv.slice(2));
  const workflowPath = path.resolve(cli.workflow);
  if (!existsSync(workflowPath)) {
    process.stderr.write(`error: workflow file not found: ${workflowPath}\n`);
    process.exit(2);
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
  );
  orch = new Orchestrator(config, definition, src, tracker, workspaces, runner, smolvm);

  // The tracker view is resolved through a getter so reloaded config (e.g. a moved
  // tracker.root, changed active/terminal states) is reflected by both the propagation
  // hook and the HTTP UI without rebinding the server.
  let liveCfg = config;
  orch.setOnConfigReloaded((cfg, def) => {
    tracker.updateConfig(cfg.tracker);
    workspaces.updateConfig(cfg);
    runner.updateConfig(cfg, def);
    mcp.updateStates(cfg.states);
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
