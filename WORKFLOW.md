---
tracker:
  kind: local
  # tracker.root defaults to <workflow-dir>/issues when omitted.
  active_states:
    - Todo
    - In Progress
  terminal_states:
    - Done
    - Cancelled

polling:
  interval_ms: 5000

workspace:
  root: ./.symphony/workspaces

hooks:
  timeout_ms: 30000

agent:
  max_concurrent_agents: 2
  max_turns: 8
  max_retry_backoff_ms: 120000

acp:
  # Choose which ACP-compatible adapter to run inside the VM. The shipped image installs:
  #   claude   ->  claude-agent-acp        (Anthropic Claude Code)
  #   codex    ->  codex-acp               (OpenAI Codex)
  #   opencode ->  opencode acp            (OpenCode)
  adapter: claude
  command: claude-agent-acp
  # The shipped VM has bash installed; minimal images can override to `sh`.
  shell: bash
  # Total time a single ACP `session/prompt` may run (one symphony turn).
  prompt_timeout_ms: 1800000
  # Bumped from a small default because VM cold-boot + adapter startup can take ~10s on
  # first use; subsequent reuses of the same VM are sub-second.
  read_timeout_ms: 30000
  stall_timeout_ms: 300000

smolvm:
  # Built once with: scripts/build-vm.sh
  # The packed artifact ships `codex` + `claude` on /usr/local/bin inside the VM.
  # The `.smolmachine.smolmachine` file is the data bundle; the bare `.smolmachine`
  # next to it is a stub binary and not what `--from` accepts.
  from: ./.vm/symphony.smolmachine.smolmachine
  cpus: 2
  mem_mib: 4096
  net: true
  # NOTE: smolvm imposes a small per-VM mount limit. The runner already mounts the
  # workspace, so keep extra volumes minimal. With MCP doing all issue-tracker writes
  # server-side (via mark_done), the agent does not need filesystem access to the
  # tracker root anymore — credentials for the chosen adapter are the only extra mount.
  volumes:
    # Mount the matching credentials dir for the adapter selected in `acp.command` above.
    # For codex-acp, swap this to ~/.codex.
    - host: ~/.claude
      guest: /root/.claude
      readonly: false
  forward_env:
    - OPENAI_API_KEY
    - ANTHROPIC_API_KEY

server:
  port: 8787
  # Bound to all interfaces because access is gated by tailscale, not by the HTTP server
  # itself. The endpoint has no auth — only expose it inside a trusted network boundary.
  host: 0.0.0.0
---
You are picking up a single issue from a local Markdown tracker and shepherding it through
the workflow.

Issue: **{{ issue.identifier }} — {{ issue.title }}**
State: {{ issue.state }}
{% if issue.priority -%}Priority: {{ issue.priority }}{%- endif %}
{% if issue.labels.size > 0 -%}Labels: {% for l in issue.labels %}{{ l }}{% unless forloop.last %}, {% endunless %}{% endfor %}{%- endif %}

{% if issue.description -%}
Description:

{{ issue.description }}
{%- endif %}

Goals for this run:

1. Work in the current directory only; treat it as the issue workspace.
2. Make the smallest correct change that satisfies the issue.
3. When you are done, write a short summary of what you did into `RESULT.md` in the
   workspace root.
4. **Signal completion through the `symphony` MCP server.** Two tools are available:
   - `symphony.mark_done({ summary })` — call this once, at the end of a successful run,
     after writing `RESULT.md`. The orchestrator atomically moves the issue file into the
     terminal `Done/` state and stops dispatching new turns.
   - `symphony.request_human_steering({ question, context? })` — call this when you
     cannot proceed without a human decision. Your current turn ends immediately after
     the tool returns; the human's response arrives as the prompt for your next turn.
5. If you cannot finish (blocked on something only a human can resolve), call
   `symphony.request_human_steering` rather than ending the turn silently. The
   orchestrator will keep redispatching otherwise. Document blockers in `RESULT.md`
   for context.
6. After calling `symphony.mark_done`, stop. The orchestrator re-polls the tracker
   every tick — if the file is still in an active state directory it will dispatch
   another turn, which costs tokens.

{% if attempt -%}
This is continuation/retry attempt {{ attempt }}. The previous run left the workspace in
some state; inspect it before doing anything new. If `RESULT.md` already exists and the
issue is satisfied, call `symphony.mark_done` and stop without further edits.
{%- endif %}
