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

codex:
  command: codex app-server
  approval_policy: never
  thread_sandbox: workspace-write
  turn_timeout_ms: 1800000
  read_timeout_ms: 5000
  stall_timeout_ms: 300000

smolvm:
  # When `image` is null smolvm boots a bare Alpine VM. Provide an image that includes
  # `codex` on $PATH (e.g. a custom image built from node:20-alpine plus `npm i -g @openai/codex`)
  # for a real end-to-end run.
  image: null
  cpus: 2
  mem_mib: 2048
  net: true
  forward_env:
    - OPENAI_API_KEY

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
