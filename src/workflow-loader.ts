// WORKFLOW.md file loader, watcher, and IO-touching dispatch validation.
//
// This module is the imperative shell around the pure `parseWorkflow`
// (src/workflow.ts): it reads the file off disk, captures `process.env`, and
// runs the fs probes (`tracker.root` existence,
// per-state credential readability) that the pure validator cannot. The
// chokidar watcher lives here too — on every reload it re-reads the file and
// re-invokes the pure parser, then publishes to listeners.

import path from 'node:path';
import process from 'node:process';
import { readFile } from 'node:fs/promises';
import { accessSync, constants as fsConstants, existsSync, readFileSync, statSync } from 'node:fs';
import chokidar from 'chokidar';
import {
  parseWorkflow,
  WorkflowError,
  type WorkflowChangeCallback,
  type WorkflowSource,
} from './workflow.js';
import type { ServiceConfig, WorkflowDefinition } from './types.js';
import {
  codexCredentialAvailable,
  codexMissingCredentialMessage,
  hostClaudeCredentialPath,
  hostCodexCredentialPath,
  isKnownAdapter,
} from './agent/adapter-names.js';
import { log } from './logging.js';

export type { WorkflowChangeCallback, WorkflowSource };

/**
 * Read the workflow file and parse it. Pure-parser caller: catches read
 * failures (re-throwing as the existing `missing_workflow_file` code so
 * downstream error matching keeps working) and threads `process.env` in so
 * `$VAR` expansion + `XDG_RUNTIME_DIR` default resolution see the same env
 * the operator launched symphony under.
 */
export async function loadWorkflow(
  workflowPath: string,
): Promise<{ definition: WorkflowDefinition; config: ServiceConfig }> {
  const abs = path.resolve(workflowPath);
  let text: string;
  try {
    text = await readFile(abs, 'utf8');
  } catch (err) {
    throw new WorkflowError(
      'missing_workflow_file',
      `cannot read ${abs}: ${(err as Error).message}`,
    );
  }
  return parseWorkflow(text, abs, process.env);
}

/**
 * IO-touching dispatch checks. Run alongside the pure `validateDispatch`:
 * tracker.root must be a real directory, and any per-state adapter override
 * must have a readable host credential. Returns null when every probe passes.
 */
export function validateDispatchIo(cfg: ServiceConfig): string | null {
  if (cfg.tracker.kind === 'local' && cfg.tracker.root) {
    if (!existsSync(cfg.tracker.root) || !statSync(cfg.tracker.root).isDirectory()) {
      return `tracker.root not found or not a directory: ${cfg.tracker.root}`;
    }
  }
  for (const [name, sc] of Object.entries(cfg.states)) {
    const credError = probeStateCredential(name, sc.adapter);
    if (credError) return credError;
  }
  return null;
}

// Both proxy-backed adapters have a host credential we can probe at load time.
// claude: the proxy reads `~/.claude/.credentials.json` on every upstream
// request to swap the live access token in for a per-VM sentinel. codex: the
// proxy reads either a `~/.codex/auth.json` token or an `OPENAI_API_KEY` env
// var. A missing credential fails here at load time instead of as an opaque
// per-request proxy error mid-dispatch.
function probeStateCredential(stateName: string, adapter: string | undefined): string | null {
  if (adapter === undefined || !isKnownAdapter(adapter)) return null;
  if (adapter === 'claude') return probeClaudeStateCredential(stateName);
  if (adapter === 'codex') return probeCodexStateCredential(stateName);
  return null;
}

function probeClaudeStateCredential(stateName: string): string | null {
  const credPath = hostClaudeCredentialPath();
  try {
    accessSync(credPath, fsConstants.R_OK);
    return null;
  } catch (err) {
    return `state "${stateName}": adapter "claude" requires a host credential at ${credPath}, but it is missing or unreadable: ${(err as Error).message}`;
  }
}

function probeCodexStateCredential(stateName: string): string | null {
  let authText: string | null = null;
  try {
    authText = readFileSync(hostCodexCredentialPath(), 'utf8');
  } catch {
    authText = null;
  }
  if (codexCredentialAvailable(authText, process.env)) return null;
  return `state "${stateName}": ${codexMissingCredentialMessage()}`;
}

/**
 * Build + watch a workflow source. Throws on initial load failure. Reloads
 * call back into the pure parser; the last-good config is preserved when a
 * reload fails so the orchestrator can keep ticking on the previous shape.
 */
export async function watchWorkflow(workflowPath: string): Promise<WorkflowSource> {
  const workflowAbs = path.resolve(workflowPath);
  let current = await loadWorkflow(workflowAbs);
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
        const next = await loadWorkflow(workflowAbs);
        current = next;
        log.info('workflow reloaded', { path: workflowAbs });
        for (const cb of listeners) cb({ definition: next.definition, config: next.config });
      } catch (err) {
        const e =
          err instanceof WorkflowError
            ? err
            : new WorkflowError('workflow_parse_error', (err as Error).message);
        log.warn('workflow reload failed; keeping last good config', {
          error: e.message,
          code: e.code,
        });
        for (const cb of listeners) cb({ error: e });
      } finally {
        reloadInFlight = null;
      }
    })();
    return reloadInFlight;
  };

  watcher.on('change', () => void reload());
  watcher.on('add', () => void reload());
  // §4.5: workflow read errors must block dispatch. If the file is deleted or
  // temporarily renamed, surface a missing_workflow_file error so the
  // orchestrator knows.
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
