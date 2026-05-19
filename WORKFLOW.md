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
  volumes:
    # Mount host CLI auth so codex / claude inside the VM can talk to their providers
    # without re-running `codex login` / `claude login`. These directories also hold the
    # CLIs' per-session sqlite state files, so they must be read-write.
    - host: ~/.codex
      guest: /root/.codex
      readonly: false
    - host: ~/.claude
      guest: /root/.claude
      readonly: false
  forward_env:
    - OPENAI_API_KEY
    - ANTHROPIC_API_KEY

server:
  port: 8787
  host: 127.0.0.1
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
4. After your final commit (or final edit if there is no git repo), stop. The orchestrator
   will re-poll the tracker and decide whether more turns are needed.

{% if attempt -%}
This is continuation/retry attempt {{ attempt }}. Pick up where the previous turn left off.
Avoid redoing work that is already reflected on disk.
{%- endif %}
