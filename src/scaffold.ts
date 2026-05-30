// First-run scaffold: write a starter WORKFLOW.md when an operator launches
// `symphony` against a directory that does not have one yet. The CLI prompts
// before calling in; this module is a pure file writer so it can be exercised
// from tests without an interactive stdin.

import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Body of the scaffolded WORKFLOW.md. Kept as an exported constant so tests can
 * assert against it without re-running the file write, and so future edits to
 * the starter shape stay in one place.
 *
 * The starter intentionally omits the `gondolin.image` selector and `volumes`
 * entries — the operator builds the agent image once (`npm run build:image`)
 * and pins the resulting build id / tag themselves. Baking a host-specific image
 * ref into the scaffold would couple the generated file to wherever symphony was
 * installed at scaffold time. See WORKFLOW.template.md for the worked example.
 */
export const SCAFFOLD_WORKFLOW_TEMPLATE = `---
# WORKFLOW.md — scaffolded by smol-symphony.
#
# Run: npx smol-symphony WORKFLOW.md
#
# See WORKFLOW.template.md for the full annotated reference:
# https://github.com/dizk/smol-symphony/blob/main/WORKFLOW.template.md

states:
  Todo:
    role: active
  Done:
    role: terminal
  Triage:
    role: holding

tracker:
  kind: local
  root: ./issues

polling:
  interval_ms: 5000

workspace:
  root: ./.symphony/workspaces

agent:
  max_concurrent_agents: 1
  max_turns: 10

acp:
  # Adapter whose binary symphony launches inside each per-issue VM.
  # Credentials never enter the VM: the guest holds only a token-shaped
  # placeholder, and the host substitutes the real key into the outbound request
  # at Gondolin egress (TLS-MITM).
  #   claude — host reads ~/.claude/.credentials.json
  #   codex  — host reads ~/.codex/auth.json (or host OPENAI_API_KEY)
  adapter: claude

gondolin:
  # Per-issue microVM (Gondolin substrate). \`image\` is the agent rootfs the VM
  # boots: build it once with \`npm run build:image\` (see images/agents/) and pin
  # the printed build id (a content-addressed digest) or its \`name:tag\` here.
  # The in-VM launcher (/opt/symphony/vm-agent.mjs) is baked into that image, so
  # no runtime \`volumes\` entry is needed; leave \`volumes\` empty. See
  # WORKFLOW.template.md for a worked example.
  #
  # image: symphony-agents:latest
  cpus: 2
  mem_mib: 4096

server:
  port: 8787
---
You are picking up a single issue and shepherding it through the workflow.

Issue: **{{ issue.identifier }} — {{ issue.title }}**
State: {{ issue.state }}
{% if issue.priority -%}Priority: {{ issue.priority }}{%- endif %}
{% if issue.labels.size > 0 -%}Labels: {% for l in issue.labels %}{{ l }}{% unless forloop.last %}, {% endunless %}{% endfor %}{%- endif %}

{% if issue.description -%}
Description:

{{ issue.description }}
{%- endif %}

Goals:

1. Work in the current directory only; treat it as the issue workspace.
2. Make the smallest correct change that satisfies the issue.
3. Hand off when done by calling \`symphony.transition({ to_state, notes? })\`
   into a declared \`role: terminal\` state (e.g. Done). The notes block is
   appended to the issue body and rides into the PR description.
4. If you cannot proceed without human input, call
   \`symphony.request_human_steering({ question, context? })\`. Your turn ends
   immediately; the human's reply arrives as your next prompt.
5. If you notice work out of scope for this issue, call
   \`symphony.propose_issue({ title, description?, labels?, priority? })\`. It
   lands in the first declared \`role: holding\` state directory (defaults to
   \`Triage/\`); the operator approves or discards from the dashboard.
`;

export interface ScaffoldOptions {
  /** Absolute path where the WORKFLOW.md file should be written. */
  workflowPath: string;
}

export interface ScaffoldResult {
  /** Absolute path of the written workflow file. */
  workflowPath: string;
}

export class ScaffoldError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'ScaffoldError';
  }
}

/**
 * Write a starter WORKFLOW.md at `workflowPath`. Creates the parent directory
 * if needed. Refuses to overwrite an existing file — callers are expected to
 * check for that case before prompting the operator.
 */
export async function scaffoldWorkflow(opts: ScaffoldOptions): Promise<ScaffoldResult> {
  if (!path.isAbsolute(opts.workflowPath)) {
    throw new ScaffoldError(
      'scaffold_relative_path',
      `scaffoldWorkflow requires an absolute path (got: ${opts.workflowPath})`,
    );
  }
  if (existsSync(opts.workflowPath)) {
    throw new ScaffoldError(
      'scaffold_file_exists',
      `refusing to overwrite existing file: ${opts.workflowPath}`,
    );
  }
  await mkdir(path.dirname(opts.workflowPath), { recursive: true });
  await writeFile(opts.workflowPath, SCAFFOLD_WORKFLOW_TEMPLATE, { flag: 'wx' });
  return { workflowPath: opts.workflowPath };
}
