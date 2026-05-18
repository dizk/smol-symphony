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
  const workspaces = new WorkspaceManager(config);
  const smolvm = new SmolvmClient(config.smolvm);
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
  );
  orch = new Orchestrator(config, definition, src, tracker, workspaces, runner);

  // The tracker view is resolved through a getter so reloaded config (e.g. a moved
  // tracker.root, changed active/terminal states) is reflected by both the propagation
  // hook and the HTTP UI without rebinding the server.
  let liveCfg = config;
  orch.setOnConfigReloaded((cfg, def) => {
    tracker.updateConfig(cfg.tracker);
    workspaces.updateConfig(cfg);
    runner.updateConfig(cfg, def);
    liveCfg = cfg;
  });

  let http: { close: () => Promise<void> } | null = null;
  const httpPort = cli.port ?? config.server.port;
  if (httpPort !== null && httpPort !== undefined) {
    try {
      http = await startHttpServer(orch, {
        port: httpPort,
        host: config.server.host,
        getTrackerView: () => ({
          trackerRoot: liveCfg.tracker.root,
          activeStates: liveCfg.tracker.active_states,
          terminalStates: liveCfg.tracker.terminal_states,
        }),
      });
    } catch (err) {
      process.stderr.write(
        `error: failed to bind HTTP server on ${config.server.host}:${httpPort}: ${(err as Error).message}\n`,
      );
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
