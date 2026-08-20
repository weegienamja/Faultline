# Faultline design system

The dashboard is a network-operations interface: dense, dark, and read under
time pressure by someone deciding whether to escalate. This document is the
contract that keeps it consistent.

Source of truth: [`public/css/`](../public/css/) for tokens, layers and
primitives; [`public/shell.js`](../public/shell.js) for the render helpers and
the router.

---

## 1. Cascade architecture

One `<link>`. [`public/css/faultline.css`](../public/css/faultline.css) declares
the layer order and assigns each file to a layer at import time, so a rule's
position in the cascade is a property of that list rather than of where it sits
inside a large stylesheet.

```
@layer reset, tokens, base, layout, components, features, evidence, utilities;
```

| Layer | File | Owns |
|---|---|---|
| `reset` | `reset.css` | the handful of UA defaults worth normalising |
| `tokens` | `tokens.css` | custom properties only — never a painted declaration |
| `base` | `base.css` | element defaults built from tokens |
| `layout` | `layout.css` | the shell and the three layout primitives |
| `components` | `components.css`, `chronology.css` | the shared vocabulary |
| `features` | `features.css` | surface-specific styling |
| `evidence` | `evidence.css` | the evidence-class visual language |
| `utilities` | `utilities.css` | single-purpose escape hatches |

**`evidence` sits after `features` deliberately.** Faultline's central rule is
that a simulated capture must never read as a measurement and an Analyst
hypothesis must never read as a deterministic finding. Putting the layer that
enforces that last means no feature stylesheet can weaken it by accident,
whatever selector it uses. The epistemic boundary is enforced by the cascade
itself, not by everyone remembering to be careful.

There is no `overrides` layer, and there is no need for one. Panels no longer
inject `<style>` into `<head>`, so nothing lands after the stylesheet and wins
on source order, and the `body .thing` counter-selectors that used to take the
specificity back are gone.

## 2. The colour rule

| Role | Where it may appear | Token |
|---|---|---|
| **Chrome** | brand mark, primary action, active nav, focus ring, and Faultline's own deterministic conclusions | `--fl-chrome` |
| **Status** | only where it reports a measured or decided state | `--fl-ok`, `--fl-warn`, `--fl-crit`, `--fl-idle` |
| **Everything else** | neutral | `--fl-text*`, `--fl-surface*`, `--fl-line*` |

Chrome colour never appears inside a data region. Status colour is never
decorative. Hierarchy inside a panel comes from weight, size and spacing — not
from hue.

**There is one chrome colour, not two.** The palette previously spent a mint
brand (`oklch 78.6% .142 168`) and a green OK status (`oklch 79.7% .164 160`)
eight degrees of hue apart at the same lightness — the same colour to the eye —
so the brand mark, the primary button and a passing measurement were
indistinguishable. Chrome is now a signal cyan at hue 208, 48 degrees off the OK
green, and it replaced the old blue accent as well. One interactive colour, and
the full green/amber/red/grey budget left free to mean something measured.

Colours are authored in `oklch()`; every `-soft` and `-line` variant is derived
from the base with `color-mix()`. Adding a status means adding one hue, not
three hand-tuned `rgba()` literals with alphas that drift apart.

There are **no raw hex or `rgb()` literals** anywhere in the stylesheet.

Status vocabulary is centralised in `statusOf()` in `shell.js`. Panels translate
their domain words (`PASS`, `SUPPORTED`, `stale`, `CONTRADICTED`, …) through it
instead of picking a colour.

`data-status` resolves to three slots — `--fl-status`, `--fl-status-soft`,
`--fl-status-line` — and components read those. A status-bearing component is
one rule, not four near-identical ones.

## 3. Type

Six sizes. Nothing below 11px — the panels that shipped 8px uppercase labels are
the clearest "prototype" tell in a dense interface.

| Token | Size | Use |
|---|---|---|
| `--fl-fs-micro` | 11px | uppercase labels, table headers, meta, footnotes |
| `--fl-fs-sm` | 12px | table cells, dense body |
| `--fl-fs-base` | 13px | body |
| `--fl-fs-md` | 14–15px | panel titles |
| `--fl-fs-lg` | 17–21px | page title |
| `--fl-fs-metric` | 22–28px | tile numerals |

The top three are `clamp()`ed against container width. The ranges are
deliberately narrow: this is an engineering tool, and it must not grow
dashboard-sized headings on a wide display. Fluid sizing is here to make the
interface transition naturally between widths, not to scale dramatically.

Uppercase micro-labels are `600` weight, `.08em` tracking, `--fl-text-3`. They
are labels, not accents; they are never coloured.

Every figure a reader might compare down a column is `tabular-nums`. Machine
values — addresses, IDs, interface names — use `.fl-value`, which is monospace
and breaks anywhere, because a 63-character hostname label must wrap rather than
push a dashboard column wide.

## 4. Spacing, radius, elevation

- **Spacing**: 4px base — `--fl-s1` … `--fl-s8`. `--fl-gutter` is the one fluid
  value, so page padding tightens on a genuinely small surface with no query.
- **Radius**: `4` chip, `6` control, `8` card, `999` pill. No other values. The
  injected panel sheets between them used 8, 9, 10, 11, 14 and 999.
- **Elevation**: surfaces separate with hairlines. Shadow is reserved for things
  that genuinely float, and blur radii stay small: this UI runs beside a live
  measurement loop and must not cost compositor time. No glows, no gradients.
- **Density**: `[data-density="compact"]` re-points the padding and row tokens
  on a container, so a sidebar can run tighter than the main column without any
  component learning about sidebars.

Touch targets come from `@media (pointer: coarse)`, not from a width guess: a
600px desktop window keeps 30px controls, a 900px tablet gets 44px ones.

## 5. Layout

Two mechanisms for two jobs.

**Viewport media queries — the shell only.** Three of them, down from thirteen.
Whether the navigation rail is labelled, iconised or horizontal is a property of
the window, and the drawer's column-vs-overlay decision is a sibling
relationship no container can see.

**Container queries — everything else.** A component adapts to the space it was
actually given. This is what makes a 600px desktop window behave like a 600px
region rather than like a phone, and what lets the same panel render correctly
in a wide dashboard column and in the 400px Analyst drawer with no
page-specific rule.

**There are no breakpoint tokens.** Three of them used to exist, documented as
the single source of truth for the layout thresholds, and they were referenced
zero times — a media or container query condition cannot consume a custom
property. They were documentation dressed as configuration, and the thresholds
had already drifted behind them. The real values are written literally at each
query with the reason beside them:

| Threshold | Container | Transition |
|---|---|---|
| 60rem | `fl-region` | main + aside side by side (`.fl-split`) |
| 42rem | `fl-panel` | chronology phases side by side |
| 40rem | `fl-panel` | two-pane master/detail (cases, intelligence) |
| 34rem | `fl-panel` | tables stack; evidence rows go four-track |
| 30rem | `fl-panel` | timeline drops its fixed timestamp column |
| 18rem | `fl-panel` | key/value pairs go two-column |
| 7rem / 5.5rem | `fl-node` | topology node drops its glyph, then its subtitle |

Named containers, because they nest:

| Container | On | Queried by |
|---|---|---|
| `fl-region` | `.fl-content`, `.fl-analyst`, page shells | `.fl-split` |
| `fl-panel` | every `.fl-panel`, `.panel`, `.live-card` | tables, timelines, chronology, `.live-kv` |
| `fl-topology` | `.topology-canvas` | node padding |
| `fl-node` | `.topology-node` | its own icon and subtitle |

Three layout primitives replace the 12-column grid, whose only real users were a
5/7 and an 8/4 split decided by viewport width:

- `.fl-cards` — peers that fill the space. `repeat(auto-fit, minmax(min(100%,
  var(--fl-card-min, 18rem)), 1fr))`. Fully intrinsic; no query at all. The
  `min(100%, …)` is what stops the track overflowing a narrow container.
- `.fl-split` — a primary region with a secondary one beside it. Stacks by
  default, goes side by side only when its own container is wide enough.
- `.fl-stack` / `.fl-row` — vertical rhythm and wrapping inline groups.

The shell is a rail plus a sticky topbar over a scrolling content column. Views
are real routed destinations (`#/bisect`), not anchors into one long page.

Navigation is grouped by the product's four verbs — **Capture, Isolate, Explain,
Preserve** (plus Manage) — so the rail teaches the product model rather than
listing screens.

## 6. Components

| Component | Class | Notes |
|---|---|---|
| Panel | `.fl-panel` | the only card, and a container. `data-status` adds a 2px inline-start edge |
| Stat tile | `.fl-tile` | opens an operational view. Text values step down a size |
| Table | `.fl-table` | sticky header, scroll affordance, numerics end-aligned mono |
| Stacked table | `.fl-table[data-stack]` | restacks as labelled key/value rows below 34rem of panel |
| Key/value | `.fl-kv` | the detail pattern in context panels |
| Badge | `.fl-badge` | `data-status`; `.fl-badge-code` for machine states |
| Provenance | `.fl-source` / `.fl-provenance` | see §7 |
| Evidence block | `.fl-evidence` | `data-evidence`; see §7 |
| Chronology | `.fl-chrono` | the Flight Recorder incident record; see §8 |
| Timeline | `.fl-timeline` | when · rail · body. Reasoning transcripts |
| Freshness | `.fl-age` | live / stale / carried-forward / disconnected |
| Disclosure | `.fl-disclose` | progressive detail |
| Control bar | `.fl-controlbar` | scope, parameters, primary action |
| State | `.fl-state` | empty, error and locked surfaces |
| Skeleton | `.fl-skeleton` | loading. Preserves layout; spinners do not |

Build with the helpers in `shell.js` (`panel()`, `tile()`, `badge()`,
`stateBadge()`, `state()`, `disclose()`, `bars()`) rather than hand-writing
markup, so a change to a primitive reaches every surface.

`.fl-table[data-stack]` requires `data-label` on each `<td>`. The `<thead>` stays
in the accessibility tree, visually hidden — nothing is dropped, the columns are
relabelled individually because the header has scrolled away.

## 7. Evidence is the visual language

Faultline's backend maintains strict epistemic boundaries. The interface carries
them as plainly as the data model does, because a user who cannot tell them
apart on screen has lost the property the product exists to provide.

Five classes, separated by **four independent signals**, so no single failure —
colour blindness, greyscale, a screenshot, a printed capsule — collapses two
into one:

| Class | Frame | Ground | Glyph | Weight |
|---|---|---|---|---|
| **Observed** | solid, solid rule | surface | `◉` | normal |
| **Deterministic comparison** | solid, **dotted** rule | surface | `≠` | normal |
| **Deterministic rule finding** | solid, **chrome** rule | surface | `⊢` | strong |
| **Deterministic experiment** | solid, **double** rule | **raised** | `⑂` | strongest |
| **Simulated** | **dashed all round** | **diagonal hatch** | `⟲` | normal |
| **Interpretation** | dashed, **no rule** | transparent | `~` | quietest |

Authority runs one way:
**experiment > rule finding > observed > comparison > interpretation**.
Simulated sits outside that ordering entirely, because it is not evidence about
the user's network at all.

**The two easiest to conflate are `deterministic` and `experiment`, and they are
the two it matters most to keep apart.** Both are Faultline's own conclusions and
both are reproducible, but only one of them established that *changing* a
condition changes the outcome:

```
deterministic   observed measurements -> fixed rules -> fault domain
experiment      condition varied -> outcome measured -> discriminator
```

Live Diagnostics runs a rule engine. Network Bisect runs experiments. The double
rule, the raised ground and the filled chrome chip belong to Bisect and to
nothing else; a rule-engine verdict that borrowed them would be claiming a
controlled experiment that never happened. Every class differs from every other
on **at least two** of the four signals — verified by computed style, not by
eye.

- The **inline-start rule** is what says "Faultline asserts this". Interpretation
  has none.
- The **hatch** on simulated is a texture, not a tint. It survives greyscale and
  a screenshot, which is exactly where a scenario could otherwise be mistaken
  for a capture of a real network.
- Every class that is not a plain measurement **states its own limit in words**,
  inside the block, every time — not in a legend elsewhere on the page.
- `.fl-panel:has([data-evidence="simulated"])` marks the panel header, so a user
  who scrolled past the banner still cannot read scripted numbers as
  measurements. `.fl-evidence-set:has(…)` marks a group that *mixes* scripted
  items into measured ones, which is the most dangerous state this interface can
  be in.

The live panel's older `src-badge src-<kind>` markup maps onto the same classes
rather than keeping a parallel set of colours for the same idea.

## 8. The chronology

The Flight Recorder incident record is where the product's visual language comes
from. `BEFORE → TRIGGER → DURING → DEEP CAPTURE → AFTER`, laid out as one
continuous record.

A rail runs the width of it, coloured by the state of each phase. **At the
trigger the rail steps down, and at recovery it steps back up.** The
displacement is the product's name made functional: the offset marks exactly
where the observed state changed, and the eye finds it before it reads a label.
It is used here and nowhere else — drawing it on unrelated surfaces would turn a
diagnostic into a motif.

The phases share grid rows through `subgrid`, so "state", "duration" and
"detail" sit on the same baseline across BEFORE / DURING / AFTER. Reading
horizontally compares like with like, which is the whole question the record
exists to answer and something three stacked independent cards cannot do.

Every stage renders even when empty: "no samples were retained before the
trigger" is a real and consequential fact, and omitting the column would hide
the reason the comparison below it is missing.

Below 42rem of panel the phases stack and the rail turns vertical. Nothing is
dropped.

## 9. States

Every surface needs all of these. An empty surface must say what it will contain
and how to fill it, or it reads as broken.

- **Empty** — what goes here, and the action that produces it.
- **Loading** — skeletons at the shape of the incoming content.
- **Error** — what failed, in the API's own words, plus a retry.
- **Locked** — `auth.lockedState()`, so every gated panel reads identically.
- **Busy** — `aria-busy="true"` on a control, so the state is announced as well
  as drawn.

**Do not render placeholder data to make a screen look finished.**

## 10. Motion

- One looping animation in the product (`.fl-running`), and it stops when the
  measurement does.
- View switches cross-fade for `--fl-dur-3` via `document.startViewTransition`,
  opacity only. The router declines to start one on first render, and declines
  entirely under `prefers-reduced-motion`.
- Under `prefers-reduced-motion: reduce`, nothing in the document animates or
  transitions. This is verified, not assumed.

## 11. Accessibility

- Heading outline is `h1` (view) → `h2` (panel) → `h3` (card or evidence block).
  No level is skipped.
- `:focus-visible` only, with an offset ring that stays visible against a
  status-tinted ground.
- Technical state never relies on colour alone: every status carries a word, and
  the evidence classes carry a frame, a ground and a glyph as well.
- Touch targets from `pointer: coarse`, not from viewport width. Inline links in
  prose keep the WCAG 2.5.8 inline exception; a link on its own in a panel
  footer does not, and gets a real target.
- Tables restack rather than dropping columns; the `<thead>` stays in the
  accessibility tree.
- Every control that opens a region reports that region's state. `setOpen()` in
  the Analyst drawer writes `aria-expanded` to *all* `[aria-controls]` controls,
  not just the one it was written for — the rail and the topbar both open the
  drawer, and a control that declares `aria-controls` while never updating
  `aria-expanded` tells assistive technology the region is permanently collapsed.
- `touch-action` is claimed by the smallest element that needs it. The topology
  canvas is `pan-y` so a swipe over empty space still scrolls the page; only the
  draggable nodes take `none`.

## 12. Extending it

1. If a token is missing, add it to `tokens.css` — never to a component.
2. If a component is missing, add it to `components.css` and a helper to
   `shell.js`.
3. **Panels do not inject stylesheets.** An injected `<style>` is unlayered and
   therefore beats every layer in this document.
4. Prefer a container query to a media query. Reach for a viewport query only
   when the *shell* has to change shape.
5. Do not add an `!important`. The two in `reset.css` are the whole budget.
6. Do not put a font-size below `--fl-fs-micro`. The 11px floor is enforced by
   there being no smaller literal anywhere in the stylesheet; where text does
   not fit at 11px, the answer is to stop rendering it, not to shrink it.
7. Prefer a prefixed class name to a scoping mechanism. Live Diagnostics' inner
   classes were held apart with `@scope`, which worked but made a large surface
   depend on that feature being supported — where it is not, the whole block is
   discarded. `.live-*` achieves the same containment with ordinary selectors.
8. New surfaces get `data-evidence` if they display anything that is not a
   direct measurement. That is not optional; it is the product's argument. If
   the surface is a conclusion, be exact about which kind: a rule engine reading
   measurements is `deterministic`, and only a controlled variation is
   `experiment`.
