# Design — Farmhouse Route Optimization

A locked design system for this app. Every page redesign reads this file before
emitting code. Do not regenerate per page — extend or amend this file when the
system needs to grow.

## Context

Internal logistics ops tool for Farmhouse (Saha Group): an admin dashboard
(route comparison, planning, database viewer, delivery reports) plus a
mobile field view for drivers. External stakeholders see this too, so it
needs to read as production-grade software — while keeping the warm
"Farmhouse" brand identity rather than becoming a generic cold SaaS product.

There are **no marketing pages** in this app — every page is functional
UI (filter bars, tables, forms, a map). Hallmark's marketing macrostructures
(Marquee Hero, Bento Grid, etc.) do not apply here; see § App pages below.

**Explicit deviation from Hallmark's default glassmorphism ban**: this app
keeps frosted-glass surfaces (`backdrop-filter: blur`) by the user's direct
request, overriding editorial/modern-minimal's "no glass" rule. This is a
project-level exception — the panels are glass, floating over a warm
gradient backdrop, with the new palette/typography/motion applied on top.

## Genre

editorial (default, flexible voice — allows a warm accent and hairline
surfaces rather than modern-minimal's forced monochrome/glass-ban register)

## Macrostructure family

No marketing pages. Every page is an **App page**: the existing functional
composition (filter bar → summary/metrics → main content) is preserved
as-is. The redesign is a token/typography/component-voice system applied
over that existing structure — never a macrostructure swap, never
enrichment. `driver.html` is the one **Mobile app page**: single-column
card list, its own component voice, same token system.

- App pages (index, plan, database, admin, deliveryReport): existing
  filter-bar/metrics/content composition, unchanged DOM structure and
  JS-referenced IDs/classes/form-field-names — only the visual/token layer
  and motion are replaced.
- Mobile app page (driver): existing login/stop-list/summary composition,
  same rule — visual layer only.

## Theme

Custom, anchored on the existing Farmhouse brand hues (converted to exact
OKLCH from the production hex values, not re-invented):

- `--color-paper`      oklch(97.8% 0.016 82.8)   /* cream — kept, already warm off-white, not pure white */
- `--color-paper-2`    oklch(92.9% 0.041 85.3)   /* wheat — secondary surface tint */
- `--color-ink`        oklch(30.3% 0.028 55.1)   /* warm dark brown text — kept */
- `--color-ink-2`      oklch(53.6% 0.035 66.9)   /* muted warm taupe — kept */
- `--color-rule`       oklch(85% 0.02 80)        /* hairline border tone, used on top of glass edges */
- `--color-accent`     oklch(54.7% 0.176 31.9)   /* barn red — primary brand accent, kept */
- `--color-accent-2`   oklch(48.4% 0.157 31.9)   /* barn-dark — accent hover/active state */
- `--color-gold`       oklch(75.4% 0.138 74.7)   /* gold — secondary highlight (e.g. "current" state), kept */
- `--color-focus`      oklch(54.7% 0.176 31.9)   /* focus ring = accent */
- `--glass` / `--glass-strong` / `--glass-2`     translucent white washes over the warm gradient backdrop
- `--glass-border`     translucent white, edge of every glass panel
- `--blur`             `saturate(160%) blur(14px)` — the frosted-glass filter itself

Functional status semantics (not decorative accents — kept distinct from
the single-accent rule because they're load-bearing UI meaning, established
this session for the delivery-report/driver-completion feature):

- `--color-early`   oklch(56.1% 0.092 238.7)   /* info blue */
- `--color-on-time` oklch(60.1% 0.097 140.9)   /* sage green */
- `--color-late`    oklch(54.3% 0.174 29.7)    /* danger red */

## Typography

- Display: **Fraunces**, weight 600, style normal (variable serif with real
  character — fits an artisanal/farm brand without reading generic-SaaS)
- Body: **Work Sans**, weight 400/500 (plain, legible at small sizes for
  dense tables/forms — deliberately not Inter/Geist, which read as the
  default-AI-tool typeface)
- Mono: **IBM Plex Mono**, weight 400 (coordinates, IDs, codes)
- Display tracking: -0.01em
- Type scale anchor: `--text-display` = clamp(1.75rem, 1.3rem + 2vw, 2.75rem)
  (dashboard headings are modest — this is a tool, not a landing page)

## Spacing

4-point named scale (see tokens.css). Pages must use named tokens
(`var(--space-md)`), never raw values.

## Motion

Richer than editorial's default "quiet, one entrance" — this app runs many
short sessions a day and should feel responsive, not static. Still fully
inside Hallmark's discipline: `transform`/`opacity` only, named easings,
no bounce, no infinite loops except functional loaders.

- Easings: `--ease-out` cubic-bezier(0.16, 1, 0.3, 1) · `--ease-in`
  cubic-bezier(0.7, 0, 0.84, 0) · `--ease-in-out` cubic-bezier(0.65, 0, 0.35, 1)
- Durations: `--dur-micro` 120ms · `--dur-short` 220ms · `--dur-long` 420ms
- **Page-load stagger reveal**: filter bar → metrics → content, staggered
  ~60ms per section via `--i` custom property, capped at 500ms total
- **Metric cards count up** 0→value on load/refresh (the one "alive" moment
  every dashboard page gets)
- **Hover/press feedback** on every interactive control (buttons, table
  rows, nav pills): 1–2px lift on hover (`--ease-out`), press settles to 0
- **Cross-fade on data updates**: switching History/Presale/Sample,
  applying a filter, paging a table — old content fades out, new fades in
- **Status badges pulse once on appearance** (early/on-time/late, driver
  "Current stop"): 2-cycle pulse, never looping
- Reduced-motion fallback: collapses to a 150ms opacity crossfade
  (`prefers-reduced-motion: reduce`)

## Microinteractions stance

- Silent success (already the pattern for driver stop-completion — inline
  badge, no toast) — keep and extend app-wide
- Hover delay 0ms (this is a tool, not a marketing site — no theatrical
  hover delays)
- Optimistic UI where the app already does it (driver "mark complete"),
  reconciled against the real server response

## CTA voice

- Primary: filled barn-red (`--color-accent`), 8px radius (not full pill —
  a tool reads more "instrument panel" than "product marketing")
- Secondary: outline/ghost, `--color-rule` border, ink text

## Per-page allowances

- All pages: typography only. No hero enrichment anywhere — function
  carries every page.

## What pages MUST share

- The wordmark/logotype treatment (dot + "Farmhouse …" title) in the topbar.
- The accent (`--color-accent`) and its restrained placement (primary
  buttons, active nav state, focus rings — not decorative floods).
- The display + body fonts.
- The CTA voice (button shape, radius, padding rhythm).
- Frosted-glass surfaces (`backdrop-filter: blur`) over the warm gradient
  backdrop, on every page including `driver.css`'s self-contained copy —
  restored by explicit user request; see the deviation note above.
- The motion language above (easings, durations, stagger pattern).

## What pages MAY differ on

- Which status-semantic colors appear (only deliveryReport/driver use
  early/on-time/late).
- Table vs. card vs. map-and-sidebar content composition, per page's
  existing function.

## Nav and footer

- **Nav**: keep the existing edge-aligned topbar shape (wordmark left,
  action buttons right) across every page — editorial's default masthead
  nav doesn't fit a persistent multi-page app toolbar. Retimed/restyled
  with the new tokens, not restructured.
- **Footer**: none. This is a tool, not a content site.

## Exports

### tokens.css
```css
:root {
  --color-paper:      oklch(97.8% 0.016 82.8);
  --color-paper-2:    oklch(92.9% 0.041 85.3);
  --color-ink:        oklch(30.3% 0.028 55.1);
  --color-ink-2:      oklch(53.6% 0.035 66.9);
  --color-rule:       oklch(85% 0.02 80);
  --color-accent:     oklch(54.7% 0.176 31.9);
  --color-accent-2:   oklch(48.4% 0.157 31.9);
  --color-accent-ink: oklch(99% 0.005 82.8);
  --color-gold:       oklch(75.4% 0.138 74.7);
  --color-focus:      oklch(54.7% 0.176 31.9);

  --color-early:      oklch(56.1% 0.092 238.7);
  --color-on-time:    oklch(60.1% 0.097 140.9);
  --color-late:       oklch(54.3% 0.174 29.7);

  --glass:        rgba(255, 255, 255, 0.42);
  --glass-strong: rgba(255, 255, 255, 0.62);
  --glass-2:      rgba(255, 255, 255, 0.28);
  --glass-border: rgba(255, 255, 255, 0.7);
  --glass-shadow: 0 10px 30px rgba(97, 58, 30, 0.18);
  --blur:         saturate(160%) blur(14px);

  --font-display: "Fraunces", ui-serif, Georgia, serif;
  --font-body:    "Work Sans", -apple-system, system-ui, sans-serif;
  --font-mono:    "IBM Plex Mono", ui-monospace, monospace;

  --space-3xs: 0.25rem;  --space-2xs: 0.5rem;  --space-xs: 0.75rem;
  --space-sm:  1rem;     --space-md:  1.5rem;  --space-lg: 2rem;
  --space-xl:  3rem;     --space-2xl: 4.5rem;  --space-3xl: 7rem;

  --text-xs: 0.75rem;  --text-sm: 0.875rem; --text-md: 1.125rem;
  --text-lg: 1.375rem; --text-xl: 1.75rem;  --text-2xl: 2.25rem;
  --text-display: clamp(1.75rem, 1.3rem + 2vw, 2.75rem);

  --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
  --ease-in: cubic-bezier(0.7, 0, 0.84, 0);
  --ease-in-out: cubic-bezier(0.65, 0, 0.35, 1);
  --dur-micro: 120ms; --dur-short: 220ms; --dur-long: 420ms;

  --radius-card: 14px; --radius-pill: 999px; --radius-input: 10px; --radius-btn: 8px;
}
```

### Tailwind v4 `@theme`
Not applicable — this project is vanilla HTML/CSS/JS, no Tailwind.

### DTCG `tokens.json`
Not generated — no consumer for this format in this project. `tokens.css`
is the single source of truth; add DTCG export if a future tool needs it.

### shadcn/ui CSS variables
Not applicable — no component framework in this project.
