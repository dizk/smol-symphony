---
name: smol-symphony
description: The orchestrator's console. A small dark workshop for dispatching and watching coding agents.
colors:
  surface-inset: "#0c0f15"
  surface-base: "#0f1115"
  surface-raised: "#161a22"
  surface-chip: "#20242c"
  border-soft: "#1c2029"
  border-firm: "#2a2e36"
  text-dim: "#6b7280"
  text-muted: "#9aa4b2"
  text-base: "#dfe2e7"
  text-strong: "#e6ebf2"
  text-on-accent: "#ffffff"
  dispatch-blue: "#2a6df4"
  running-bg: "#1f3a26"
  running-fg: "#58d68d"
  retrying-bg: "#3a2f1f"
  retrying-fg: "#f0c060"
  idle-bg: "#20242c"
  idle-fg: "#9aa4b2"
  error-fg: "#ff7676"
  success-fg: "#58d68d"
typography:
  headline:
    fontFamily: "ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.3rem"
    fontWeight: 400
    lineHeight: 1.2
  title:
    fontFamily: "ui-sans-serif, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.3
  body:
    fontFamily: "ui-sans-serif, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.45
  label:
    fontFamily: "ui-sans-serif, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.4
  pill:
    fontFamily: "ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.85em"
    fontWeight: 400
    lineHeight: 1.4
  data:
    fontFamily: "ui-sans-serif, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    fontFeature: "tabular-nums"
    lineHeight: 1.45
  th:
    fontFamily: "ui-sans-serif, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 500
    lineHeight: 1.4
rounded:
  sm: "4px"
  md: "8px"
  pill: "999px"
spacing:
  "2xs": "0.1rem"
  xs: "0.3rem"
  sm: "0.5rem"
  md: "1rem"
  lg: "1.5rem"
  xl: "2rem"
components:
  button-primary:
    backgroundColor: "{colors.dispatch-blue}"
    textColor: "{colors.text-on-accent}"
    rounded: "{rounded.sm}"
    padding: "0.5rem 1rem"
    typography: "{typography.body}"
  button-ghost:
    backgroundColor: "{colors.surface-chip}"
    textColor: "{colors.text-base}"
    rounded: "{rounded.sm}"
    padding: "0.3rem 0.7rem"
    typography: "{typography.body}"
  input:
    backgroundColor: "{colors.surface-inset}"
    textColor: "{colors.text-strong}"
    rounded: "{rounded.sm}"
    padding: "0.4rem 0.6rem"
    typography: "{typography.body}"
  card-form:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.text-base}"
    rounded: "{rounded.md}"
    padding: "1rem"
  pill-running:
    backgroundColor: "{colors.running-bg}"
    textColor: "{colors.running-fg}"
    rounded: "{rounded.pill}"
    padding: "0.1rem 0.5rem"
    typography: "{typography.pill}"
  pill-retrying:
    backgroundColor: "{colors.retrying-bg}"
    textColor: "{colors.retrying-fg}"
    rounded: "{rounded.pill}"
    padding: "0.1rem 0.5rem"
    typography: "{typography.pill}"
  pill-idle:
    backgroundColor: "{colors.idle-bg}"
    textColor: "{colors.idle-fg}"
    rounded: "{rounded.pill}"
    padding: "0.1rem 0.5rem"
    typography: "{typography.pill}"
  th:
    backgroundColor: "{colors.surface-base}"
    textColor: "{colors.text-muted}"
    typography: "{typography.th}"
    padding: "0.4rem 0.6rem"
  td:
    backgroundColor: "{colors.surface-base}"
    textColor: "{colors.text-base}"
    typography: "{typography.data}"
    padding: "0.4rem 0.6rem"
---

# Design System: smol-symphony

## 1. Overview

**Creative North Star: "The Quiet Workshop"**

A tidy workbench, not a control room. The orchestrator does the real work; this
surface only shows what is on the bench right now, and gives one place to put
new work on. Everything you can see is there because the orchestrator actually
knows it, and nothing is there for atmosphere.

The system is dark because the user opens it next to a terminal, against an
already-dark editor, in the middle of doing other things. It is flat because
the workshop has no spotlights: depth is conveyed by stacking slightly lighter
panels on a slightly darker bench, never by glow or lift. Numbers are tabular,
labels are real field names, and pills mean exactly the three states the
orchestrator tracks: running, retrying, idle.

What this system rejects, drawn from PRODUCT.md: generic SaaS dashboard chrome
(sidebar nav, gradient metric tiles, identical card grids), Jira-style ITSM
heaviness (modal-on-modal flows, status pills whose colors don't encode
distinct state), and AI-product chrome (violet gradients, glassmorphism,
sparkle iconography). smol-symphony runs AI agents but is not an AI product;
the agents are infrastructure, not the narrative.

**Key Characteristics:**
- Dark, cool-blue-leaning neutrals stacked into four tonal layers.
- One saturated accent (Dispatch Blue) reserved for the single primary verb.
- Three semantic pill states, each a paired bg + fg color. No fourth state, ever.
- No shadows. Depth is tonal stacking only.
- Single sans family. Tabular numerics for any cell that holds a number.
- Density over whitespace luxury: tables are dense, the form is grid-packed.

## 2. Colors: The Workshop Bench Palette

A cool-blue-leaning dark stack with one saturated accent and three semantic
status pairs. Each neutral is tinted toward the accent hue at near-zero
chroma so no surface reads as pure grey.

### Primary
- **Dispatch Blue** (`#2a6df4`, ≈`oklch(55% 0.22 261)`): the verb. Used only on
  the Create-issue submit button. Nowhere else on the page is this saturated.
  The button is the one place the user makes the orchestrator do something
  new; the color marks that action and only that action.

### Neutral (the bench, four tonal layers)
- **Inset** (`#0c0f15`, ≈`oklch(16% 0.008 260)`): input field interiors.
  Deeper than the body so fields read as sunken into the form, not floating.
- **Bench** (`#0f1115`, ≈`oklch(18% 0.005 260)`): the page body. The default
  surface; everything else stacks on or beneath this.
- **Raised Panel** (`#161a22`, ≈`oklch(21% 0.012 260)`): the create-issue form
  card. One step lighter than the bench, signalling "this is where you put new
  things."
- **Chip** (`#20242c`, ≈`oklch(27% 0.012 260)`): the refresh button and the
  idle pill. The most-lifted neutral; reserved for small interactive surfaces
  and quiet status.

### Border / Rule
- **Soft Rule** (`#1c2029`, ≈`oklch(25% 0.010 260)`): horizontal table row
  dividers. Just barely visible; the eye should track columns, not rows.
- **Firm Rule** (`#2a2e36`, ≈`oklch(31% 0.008 260)`): input borders and the
  underline beneath section headings. The structural lines.

### Text (the four-step ramp)
- **Dim** (`#6b7280`): timestamps, `small.dim` annotations. The lowest reading
  layer; reachable but not pulling attention.
- **Muted** (`#9aa4b2`): form labels, table headers, secondary copy.
- **Base** (`#dfe2e7`): primary body text and table cell contents.
- **Strong** (`#e6ebf2`): input field text and other content the user is
  actively typing or editing. One step brighter than base so what you're
  writing stands out from what you're reading.

### Status (three paired roles)
Each pill carries both a background and a foreground; they are not
interchangeable across states. The dark-on-color is what reads at a glance.

- **Running** (`bg #1f3a26`, `fg #58d68d`): active sessions. The orchestrator
  is currently spending tokens on this issue.
- **Retrying** (`bg #3a2f1f`, `fg #f0c060`): retry queue. The orchestrator
  hit a recoverable failure and will dispatch again on backoff.
- **Idle** (`bg #20242c`, `fg #9aa4b2`): on disk, not running, not retrying.
  Deliberately the same hex as Chip + Muted, because idle is *the absence of
  status color*.

### Inline message
- **Error** (`#ff7676`): the create-form error line. Inline, not a toast, not
  a modal.
- **Success** (`#58d68d`): the create-form OK line. Shares the running-fg
  green by design; success means "the orchestrator now knows about this."

### Named Rules

**The One Verb Rule.** Dispatch Blue appears on exactly one element per page:
the primary action. If a second saturated accent is needed, the design is
wrong; reach for a status color (running/retrying/idle) or text weight first.

**The Three-Pill Rule.** Status pills encode running, retrying, idle.
Nothing else. Never invent a fourth pill color for taste; if a fourth state
emerges from the orchestrator, name it semantically and pair a new bg + fg
before adding it here.

**The Tinted Neutral Rule.** No pure greys. Every neutral leans on the cool
blue brand axis (hue ≈260) at near-zero chroma (0.005–0.012). Pure `#000` and
pure `#fff` are prohibited.

## 3. Typography

**Body Font:** `ui-sans-serif, system-ui, sans-serif` (browser native).
**Display Font:** none. The same family carries every role.
**Mono / Data Font:** still the same family, with `font-variant-numeric:
tabular-nums` on every cell that holds a number.

**Character:** the system font of whatever OS the user is on. No web fonts,
no FOUT, no loading flash. The console reads like the operating system, not
like a product. Numbers line up; text doesn't try to be elegant.

### Hierarchy

The scale is intentionally tight, with one density trick: section titles (h2)
match body in size and depend on a divider rule plus generous top margin for
hierarchy, not on type contrast. This keeps the page feeling dense and
console-like rather than article-like.

- **Headline** (h1, 400, `1.3rem` ≈ 20.8px, lh 1.2): the page title only.
  Appears once per page (`Symphony — tracker.root = …`).
- **Title** (h2, 400, `1rem` = 16px, lh 1.3, with a `1px` bottom rule in Firm
  Rule): section labels (`Create issue`, `Active sessions`, etc.). Same size
  as a paragraph; the rule beneath does the hierarchy work.
- **Body** (400, `14px`, lh 1.45): default text, table cells.
- **Label** (400, `14px`, color Muted): form labels and table headers.
- **Data** (400, `14px`, `tabular-nums`): every number that appears in a
  cell. Token counts, attempt numbers, runtime seconds, time-of-day.
- **TH** (500, `14px`, color Muted): table column headers. Heavier than body
  by one step (400 → 500), so columns name themselves.
- **Pill** (400, `0.85em` ≈ 11.9px against 14px body): the three status pills.
  Smaller than body so pills read as inline metadata, not content.

### Named Rules

**The System-Font Rule.** No web fonts are loaded, ever. The console must
look like the user's OS. If a custom face is added later, it has to justify
the latency cost in writing.

**The Tabular-Numbers Rule.** Any cell that contains a number applies
`font-variant-numeric: tabular-nums`. Token counts, attempt counts,
timestamps, IDs with digits: all of them. Columns of numbers must line up.

**The Same-Size Section-Header Rule.** Section titles (h2) are the same size
as body. Hierarchy comes from the divider rule beneath and the top margin
above, not from type scale. This keeps page density high.

## 4. Elevation

**The system is flat.** No `box-shadow` rule appears anywhere in the
stylesheet. Depth is conveyed entirely by tonal stacking of the neutrals:
`surface-inset` (deepest) → `surface-base` (default) → `surface-raised` (form
card) → `surface-chip` (refresh button, idle pill).

There is no hover lift, no focus glow, no drop shadow on the form card. A
panel reads as "raised" only because it is one step lighter than the bench
beneath it.

### Named Rules

**The Flat-By-Default Rule.** Surfaces are flat. Shadows are forbidden.
Depth cues come from the four-step neutral stack and from the divider rules
under section titles. If a future state needs visible elevation, introduce a
fifth neutral step before reaching for `box-shadow`.

**The No-Glow Rule.** Focus, hover, and active states change color or
border, never glow. Glassmorphism, blur backdrops, and shimmer animations
are prohibited (carries PRODUCT.md's AI-product-chrome anti-reference).

## 5. Components

The doctrine is **crisp and exact**: minimal radius vocabulary (4px for
controls, 8px for the form card, 999px for pills), 1px borders only where
structurally necessary, hairline-tight alignment, no decorative motion.

### Buttons

Two variants. Both share radius `4px` and the body type role.

- **Primary** (Create issue): background Dispatch Blue (`#2a6df4`), text
  on-accent (`#ffffff`, see Don'ts), padding `0.5rem 1rem`, no border. Placed
  inside the form grid as `grid-column: 2; justify-self: start`, so it
  aligns under the input column rather than spanning the form.
- **Ghost / Refresh** (next to "Active sessions"): background Chip
  (`#20242c`), text Base (`#dfe2e7`), 1px Firm Rule border, padding
  `0.3rem 0.7rem`. Smaller than primary on every axis; used for
  console-style "refresh now" actions only.

Hover and focus states are presently unstyled. The "crisp and exact"
philosophy permits adding a `1px` Dispatch Blue focus-visible ring on both
variants in a future pass; do not add hover lift or color shifts that imply
elevation.

### Inputs

`<input>`, `<select>`, `<textarea>` share one style.

- **Background** Inset (`#0c0f15`), one step *deeper* than the form card.
  Inputs read as sunken slots, not floating tiles.
- **Border** `1px solid` Firm Rule (`#2a2e36`).
- **Text** Strong (`#e6ebf2`) so what is being typed sits one step above
  surrounding body text.
- **Radius** `4px`.
- **Padding** `0.4rem 0.6rem`.
- **Width** `100%` of the form grid's value column.
- **Textareas** add `min-height: 80px; resize: vertical`.

Focus state is currently the browser default. Adding a `1px` Dispatch Blue
focus-visible outline is the obvious next refinement, consistent with the
philosophy.

### Card (the create-issue form)

The only card-shaped surface in the system. There is exactly one.

- **Background** Raised Panel (`#161a22`).
- **Radius** `8px` (the only place 8px appears).
- **Padding** `1rem`.
- **No border, no shadow.**
- **Layout** `display: grid; grid-template-columns: max-content 1fr; gap:
  0.5rem 1rem; align-items: center;` so labels (max-content) align with
  their inputs (1fr) on the same row.

This is the workshop's input slot. The 8px corner is intentionally slightly
softer than the rest of the system; on the next polish pass we may sharpen
it to 4px or to a `1px` Firm Rule border with no radius. Either move would
push the system further toward CLI-in-HTML.

### Pills (status chips)

`display: inline-block`, `padding: 0.1rem 0.5rem`, `border-radius: 999px`,
`font-size: 0.85em`. Three semantic instances, each a paired bg + fg:

- **Running** — bg `#1f3a26`, fg `#58d68d`. Live session.
- **Retrying** — bg `#3a2f1f`, fg `#f0c060`. Backoff queue.
- **Idle** — bg `#20242c`, fg `#9aa4b2`. On disk, not active.

No fourth pill exists. If a new orchestrator state appears, the new pill
gets a named bg + fg pair entered into the colors block and a row added in
this section. Do not reuse an existing pair for a new meaning.

### Tables

The dominant content shape. Three tables on the page: Active sessions, Retry
queue, All known issues.

- `width: 100%`, `border-collapse: collapse`.
- `th, td` padding `0.4rem 0.6rem`, `border-bottom: 1px solid` Soft Rule
  (`#1c2029`).
- `th` text-align left, color Muted, weight 500.
- Every cell inherits `font-variant-numeric: tabular-nums`.
- No striping. The Soft Rule divider is enough.

### Inline status messages

The form's `.msg` line is `grid-column: 1 / span 2; min-height: 1.2em`. It
holds three states: neutral (color Muted), error (`#ff7676`), ok (`#58d68d`).
Always inline, never a toast, never a modal.

### Named Rules

**The One-Card Rule.** The create-issue form is the only card-shaped
surface. Other sections are unbordered blocks separated by section titles
and divider rules. Resist adding cards to wrap tables or stats.

**The Inline-Feedback Rule.** Success and error feedback land in the same
inline `.msg` slot where the form sits. No toast notifications. No modal
confirmations. The user already saw the issue land in the table below.

**The Sunken-Input Rule.** Inputs are visually deeper than the surface they
sit on (Inset against Raised Panel). They must not appear to float; if a
new input style is introduced, it follows this depth rule.

## 6. Do's and Don'ts

### Do:
- **Do** stack neutrals in four steps (Inset → Bench → Raised Panel → Chip)
  to convey depth. No shadows.
- **Do** keep Dispatch Blue (`#2a6df4`) on exactly one element per page: the
  primary verb. Everywhere else, status colors and text weight do the work.
- **Do** apply `font-variant-numeric: tabular-nums` to every cell holding a
  number. Token counts and attempt numbers must align across rows.
- **Do** name new colors semantically (`surface-chip`, `retrying-fg`), not
  by hue (`grey-3`, `green-400`). The token name is the contract.
- **Do** put feedback inline in the `.msg` slot. Errors and successes never
  leave their grid cell.
- **Do** keep the type scale tight: h1 1.3rem, h2 1rem (same as body),
  body 14px, pill 0.85em. Hierarchy through rules and weight, not scale.
- **Do** keep section titles (h2) the same size as body, separated by a
  Firm Rule underline and 2rem of top margin.

### Don't:
- **Don't** add a fourth saturated accent. There is one verb color. Status
  pills carry the only other saturation in the system, and they encode three
  named states. A fourth pill is a smell.
- **Don't** ship a sidebar nav, breadcrumb trail, or a "Welcome back" hero.
  PRODUCT.md flags this as generic-SaaS-dashboard chrome; the workshop has
  one room. Add a tab strip only when a second page genuinely exists.
- **Don't** use big-number-with-tiny-label metric tiles. The hero-metric
  template is explicitly prohibited.
- **Don't** add violet gradients, glassmorphic blur, sparkle / star icons,
  or any "AI inside" iconography. smol-symphony runs AI agents but is not an
  AI product. (PRODUCT.md anti-reference, verbatim.)
- **Don't** add Jira-style status pills whose colors do not map to distinct
  orchestrator state. Three pills, three states, three bg + fg pairs. That
  is the entire vocabulary.
- **Don't** introduce `box-shadow`. Depth is tonal. If you reach for a
  shadow, add a fifth neutral step instead.
- **Don't** use `border-left` greater than `1px` as a colored stripe on
  rows, cards, or alerts (carries impeccable's absolute ban).
- **Don't** use `#000` or `#fff` as text or background. The single existing
  `color: white` on the primary button is a known soft spot to tint toward
  the brand hue (target ≈`oklch(98% 0.005 260)`) on the next polish pass.
- **Don't** introduce a web font. The console reads like the OS;
  `ui-sans-serif, system-ui, sans-serif` is non-negotiable unless an
  intentional editorial change is being made.
- **Don't** add modals. Inline-first, always. PRODUCT.md flags
  modal-on-modal flows as Jira-ITSM heaviness.
- **Don't** animate layout properties or add motion that doesn't encode
  state. The 2-second polling refresh is the only "motion" the system has,
  and that is informational, not decorative.
- **Don't** wrap content in a generic container. The form is the one card.
  Tables and stat lines stand on the bench directly.
