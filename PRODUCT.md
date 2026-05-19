# Product

## Register

product

## Users

Open-source developers self-hosting smol-symphony on their own machine (or a
trusted home server reached over tailscale). They run the orchestrator from a
terminal, live mostly in their editor, and open the HTTP dashboard to triage
work and watch agents run.

The dashboard is a glance surface, not a destination. A typical session: pop it
open, add an issue or two, scan what's running, close it. They are not babysitting
a feed.

Context when using it: localhost or LAN, modern desktop browser, usually a second
monitor or background tab next to the editor and a terminal where the symphony
process is logging.

## Product Purpose

smol-symphony is a small TypeScript orchestrator that takes Markdown issues off a
local tracker, prepares per-issue workspaces, and runs coding agents
(Claude Code, Codex, OpenCode) inside isolated smolvm microVMs over ACP. The
HTTP dashboard exists to do two things well:

1. **Dispatch** — create issues into the tracker without dropping back to the
   filesystem.
2. **Triage** — see at a glance which sessions are running, which are retrying,
   and which issues are sitting idle on disk.

Success is when a self-hoster can keep agents fed and notice problems quickly,
without ever feeling they are using a SaaS product.

## Brand Personality

Quiet. Precise. Infrastructural.

Reads like a well-built CLI rendered in HTML: terse labels, technical accuracy,
no flourish. The orchestrator itself is small (the "smol" is load-bearing) and
the dashboard should feel like an honest extension of it, not an aspirational
face glued on top.

Voice: direct, lowercase-comfortable, names things by what they are
(`tracker.root`, `retry queue`, `usage_update`). Never marketing copy. Never a
welcoming hero. The user already chose to run this.

## Anti-references

Three patterns this must never resemble:

- **Generic SaaS dashboard.** Sidebar nav, gradient hero tiles, big-number /
  tiny-label metric cards, identical-card grids, "Welcome back" greetings.
  Indistinguishable-Linear-clone aesthetic. The big-number-tiny-label
  hero-metric template is explicitly banned.
- **Jira / enterprise ITSM heaviness.** Modal-on-modal workflows, status pills
  whose colors do not actually map to meaningful state, dense forms with
  required fields nobody fills in, the texture of bureaucracy. Status pills
  are allowed only when they encode real, distinct states.
- **AI-product chrome.** Violet gradients, glassmorphic cards, sparkle / star
  iconography signalling "AI inside". smol-symphony runs AI agents but is not
  an AI product; the agents are infrastructure, not the narrative. No
  purple-gradient-on-dark, no shimmer, no animated thinking dots.

## Design Principles

1. **Match the orchestrator's restraint.** The codebase is small and
   plumbing-first; the dashboard should feel like an extension of that, not a
   product face bolted on. If a feature would not exist in a pure CLI version
   of the same tool, justify why it earns space in the UI.

2. **Show real state; refuse status theater.** Every pill, color, and number
   must correspond to a distinct, true thing the orchestrator knows. No
   progress affordances that don't reflect progress. No counts that don't
   count. Tokens, attempts, due-at timestamps — exact values, no rounding for
   aesthetics.

3. **Optimize for the glance, not the session.** Users are not living in this
   tab. The first second of looking at the page should answer "is anything
   stuck?" and "is anything running?" Density beats whitespace luxury for
   the running / retry / issue tables.

4. **Agents are not the brand.** This tool dispatches Claude, Codex, OpenCode —
   it does not perform AI-ness. The product narrative is "small orchestrator
   with isolated VM execution", not "AI-powered work runner". Visual language
   should reflect that.

5. **Read like a CLI in HTML form.** Monospace-friendly information, tabular
   numbers, exact identifiers, plain verbs. If a label sounds like marketing,
   replace it with the field name.

## Accessibility & Inclusion

Bare minimum responsible baseline for a self-hosted dev tool:

- Keyboard navigation works for the create-issue form and any actionable
  controls.
- Contrast on text and pills is legible against the chosen background (no
  decorative-only low-contrast text).
- Form labels are real `<label for=...>` associations, not floating placeholders.

Out of scope unless requested: WCAG 2.2 AA certification, screen-reader landmark
choreography, full reduced-motion design system, light-mode parity. Revisit if
real users report needs.
