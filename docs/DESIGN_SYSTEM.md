# Faultline design system

The dashboard is a network-operations interface: dense, dark, and read under
time pressure by someone deciding whether to escalate. This document is the
contract that keeps it consistent.

Source of truth: [`public/design-system.css`](../public/design-system.css) for
tokens and primitives, [`public/shell.js`](../public/shell.js) for the render
helpers and the router.

---

## 1. The colour rule

This is the rule everything else depends on.

| Role | Where it may appear | Token |
|---|---|---|
| **Chrome** | brand mark, primary action, active nav, focus ring | `--fl-brand`, `--fl-accent` |
| **Status** | only where it reports a measured or decided state | `--fl-ok`, `--fl-warn`, `--fl-crit`, `--fl-idle` |
| **Everything else** | neutral | `--fl-text*`, `--fl-surface*`, `--fl-border*` |

Chrome colour never appears inside a data region. Status colour is never
decorative. Hierarchy inside a panel comes from weight, size and spacing — not
from hue.

The base is neutral slate (`#0b0e13`), deliberately not tinted, so the only
saturated pixels on screen are ones that carry meaning.

**Interactive is blue, healthy is green.** Keeping those separate is what lets a
green badge mean "this measurement passed" rather than "this thing is clickable".

Status vocabulary is centralised in `statusOf()` in `shell.js`. Panels translate
their domain words (`PASS`, `SUPPORTED`, `stale`, `CONTRADICTED`, …) through it
instead of picking a colour, which is what previously left `PASS` green in one
panel and mint in another.

## 2. Type

Six sizes. Nothing below 10px — the previous UI used 8px uppercase labels, which
is the clearest "prototype" tell in a dense interface.

| Token | Size | Use |
|---|---|---|
| `--fl-fs-micro` | 11px | uppercase labels, table headers, meta, footnotes |
| `--fl-fs-sm` | 12px | table cells, dense body |
| `--fl-fs-base` | 13px | body |
| `--fl-fs-md` | 15px | panel titles |
| `--fl-fs-lg` | 19px | page title |
| `--fl-fs-metric` | 26px | tile numerals |

Uppercase micro-labels are `600` weight, `.08em` tracking, `--fl-text-3`. They
are labels, not accents; they are never coloured.

Every figure a reader might compare down a column uses `font-variant-numeric:
tabular-nums`. Measured values, addresses and identifiers use `--fl-mono`.

## 3. Spacing, radius, elevation

- **Spacing**: 4px base — `--fl-s1` … `--fl-s8` (4/8/12/16/20/24/32). No other values.
- **Radius**: `4` chip, `6` control, `8` card, `999` pill. No other values.
- **Elevation**: surfaces separate with hairlines. `--fl-shadow-raised` is a 1px
  hint; `--fl-shadow-float` is reserved for things that genuinely float
  (dialog, drawer, menu). Panels do not glow and do not use gradients.

Density targets: table row 34px, panel padding 16px, grid gap 12px.

## 4. Layout

12-column grid (`.fl-grid` + `.fl-col-*`), the layout contract for every
dashboard surface. Panels below ~4 columns stop being readable; tables need 6.

The shell is a fixed rail plus a sticky topbar over a scrolling content column.
Views are real routed destinations (`#/bisect`), not anchors into one long page.

Navigation is grouped by the product's verbs — **Capture, Isolate, Preserve** —
so the rail teaches the product model rather than listing screens.

## 5. Components

| Component | Class | Notes |
|---|---|---|
| Panel | `.fl-panel` | the only card. `data-status` adds a 2px left edge |
| Panel header | `.fl-panel-head` | eyebrow label + title left, actions right |
| Stat tile | `.fl-tile` | opens an operational view. Text values step down a size |
| Table | `.fl-table` | sticky header, hairline rows, numerics right-aligned mono |
| Key/value | `.fl-kv` | the detail pattern in context panels |
| Badge | `.fl-badge` | `data-status`; `.fl-badge-code` for machine states |
| Provenance tag | `.fl-source` | `measured` / `inferred` / `external` / `demo` |
| Timeline | `.fl-timeline` | when · rail · body. Used for reasoning transcripts |
| Disclosure | `.fl-disclose` | progressive detail |
| Control bar | `.fl-controlbar` | scope, parameters, primary action |
| State | `.fl-state` | empty, error and locked surfaces |
| Skeleton | `.fl-skeleton` | loading. Preserves layout; spinners do not |

Build with the helpers in `shell.js` (`panel()`, `tile()`, `badge()`,
`stateBadge()`, `state()`, `disclose()`, `bars()`) rather than hand-writing
markup, so a change to a primitive reaches every surface.

## 6. Provenance is a first-class component

Faultline mixes measured, inferred and third-party data, and its entire argument
is that conclusions are traceable. `.fl-source` states which class a value
belongs to:

- `measured` — this machine observed it
- `inferred` — deduced from evidence, with confidence
- `external` — retrieved from a public source, supporting evidence only
- `demo` — sample data, never presented as a measurement

Inferred relationships are drawn differently from observed ones (dashed vs
solid). The product does not claim topology it did not measure.

## 7. States

Every surface needs all four. An empty surface must say what it will contain and
how to fill it, or it reads as broken.

- **Empty** — what goes here, and the action that produces it.
- **Loading** — skeletons at the shape of the incoming content.
- **Error** — what failed, in the API's own words, plus a retry.
- **Locked** — `auth.lockedState()`, so every gated panel reads identically.

**Do not render placeholder data to make a screen look finished.** Where a
capability is not implemented yet or has no browser
surface yet (Change Assurance), the screen says so.

## 8. Wording

| Prefer | Over | Why |
|---|---|---|
| Reference incidents · Worked examples | Demo scenarios | describes purpose, not build status |
| Sample data | DEMO | a label, not a disclaimer |
| Live data is locked | Unlock live data to… | states the condition first |
| Experiment path | Experiment graph | it is a sequence, not a graph |
| Competing explanations | Hypotheses | the reader is a network engineer, not a statistician |
| Eliminated explanations | Contradicted | plain language for a collapsed audit trail |
| Stopped because | Stopping reason | reads as a sentence with its value |
| Full record | All executed experiments | one disclosure heading for all detail |

Verdict headlines are sentences, not enum names. The enum stays available in the
badge and the record.

## 9. Extending it

1. If a token is missing, add it to `design-system.css` — never to a panel.
2. If a component is missing, add a helper to `shell.js`.
3. Panels do not inject stylesheets. The rules left inside `bisect-panel.js` are
   the two that are genuinely local to that screen.
4. `styles.css` holds legacy aliases for panels not yet migrated. That section
   shrinks as panels move over; it is not somewhere to add new rules.
