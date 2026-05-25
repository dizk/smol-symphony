// CLI argument parsing for the `symphony` binary. Lives in its own module so
// tests can import `parseCli` without triggering the `main()` side effects of
// `src/bin/symphony.ts` (HTTP/ACP listeners, tracker init, etc.) at import
// time.

import path from 'node:path';
import process from 'node:process';

export interface Cli {
  subcommand: 'serve' | 'reconcile' | 'rerun';
  workflow: string;
  port: number | null;
  reconcileForce: boolean;
  /** When subcommand=rerun: name of the run_in_vm action to invalidate. */
  rerunCheck: string | null;
}

export function parseCli(argv: string[]): Cli {
  // Detect subcommands. `reconcile` and `rerun` share the parsed-args
  // skeleton with the default `serve` mode; the subcommand is what differs
  // at the action layer (main() dispatches accordingly). Preserve the
  // subcommand verbatim in the return value — collapsing `reconcile` back to
  // `serve` would let the missing-workflow scaffold prompt fire on a
  // `symphony reconcile` invocation, which has nothing to scaffold against.
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
    subcommand,
    workflow: workflow ?? path.resolve(process.cwd(), 'WORKFLOW.md'),
    port,
    reconcileForce,
    rerunCheck,
  };
}
