# Design System — MAETHIST

Preview of this system rendered: https://claude.ai/code/artifact/a28264c7-a3ff-4e5f-ae59-6fe268ae10f1

## Product Context

- **What this is:** A browser workspace for studying from your own material. Import a PDF or a deck, write on it by hand, construct real geometry, export clean vector PDF.
- **Who it's for:** Students and teachers. The device to design against is a budget Android tablet, roughly 960 CSS px wide, with a slow CPU and a capacitive stylus. Desktop and laptop are real but secondary.
- **Space:** Handwriting and annotation (GoodNotes, Notability), infinite canvas (Excalidraw, Obsidian Canvas), and maths instruments (Desmos, GeoGebra).
- **Project type:** Web app with a marketing site attached.

## Positioning

**Serious technical instrument.** Chosen deliberately over "calm study room" on 2026-09-03.

The consequence, and it is the point of this whole document: **real instruments are quiet.**
Desmos and GeoGebra are the maths instruments schools actually trust, and both are
near-white, single-accent, thin-ruled, small-typed. An instrument earns "serious" by not
competing with the measurement. A neon HUD with a starfield and `SYSTEM ONLINE` is what
a game about engineering looks like, not what an engineer's tool looks like.

Every rule below follows from that one sentence.

**Open tension:** the README currently tells a warm, personal story about being priced out
of an iPad. That is a different voice from this positioning. One of the two needs to move.

## Aesthetic Direction

**Blueprint**, chosen by the owner on 2026-11-15 for version 2 over "Paper and ink" and
"Chalkboard". It replaces the graphite-and-ochre look; the positioning above is unchanged,
and so is every rule that follows from it.

- **Direction:** A drafting sheet. Deep drafting blue, one cyan accent, ruled grid.
- **Decoration level:** Minimal. The ruled grid *is* the texture, on the canvas and behind the marketing pages. No starfields, no glows, no gradient fills.
- **Mood:** A drawing office at night. Nothing on screen is trying to impress you.
- **Dark first.** The dark sheet is the identity. Light is white drafting paper with blue rules, and is a full citizen: every token has a measured light value.
- **References:** desmos.com/calculator, geogebra.org/geometry, excalidraw.com

## Color

**Approach:** restrained, one hue. Chrome is drafting blue. One accent, and it marks exactly
one thing: the tool currently in your hand. Everything else saturated on screen was drawn
by the person using the app.

Thirteen tokens. This is the entire palette.

| Token | Light | Dark | Role | Contrast (light · dark) |
|---|---|---|---|---|
| `--paper` | `#F3F7FB` | `#0E2238` | App ground | ground |
| `--surface` | `#FFFFFF` | `#132C47` | Panels, cards, islands | ground |
| `--raised` | `#E6EEF6` | `#1A3857` | Hover, wells, inset | ground |
| `--ink` | `#0E2238` | `#E8F1FA` | Primary text | 14.95 · 12.44 AAA |
| `--ink-2` | `#3D5772` | `#9DBAD6` | Secondary text | 6.96 · 7.05 AA+ |
| `--ink-3` | `#6B839C` | `#7193B4` | Muted labels, non-load-bearing | 3.65 · 4.42 AA-large |
| `--rule` | `#CBD9E7` | `#2A4D73` | Hairlines. Never text. | — |
| `--rule-2` | `#DFE8F1` | `#1E3C5C` | Inner dividers, the ruled grid | — |
| `--accent` | `#0B6B94` | `#5FD4F0` | Active tool, primary action — a **fill** | 5.50 · 8.22 AA+ |
| `--accent-ink` | `#0A6289` | `#5FD4F0` | Accent-coloured **text on `--accent-wash`** | 5.84 · 7.14 AA |
| `--accent-wash` | `#DFF2FA` | `#12384F` | Active tool background | — |
| `--error` | `#B3261E` | `#FF9A8F` | Save failed, import failed | 6.07 · 6.94 AA |
| `--ok` | `#166534` | `#5EE0A0` | Saved | 6.62 · 8.55 AA+ |
| `--on-accent` | `#FFFFFF` | `#0E2238` | Text on an accent fill | 5.92 · 9.32 AA+ |

Never put white text on the accent in dark mode: the accent is a light cyan there, and
`--on-accent` is the dark navy made for it. Several feature stylesheets hard-coded `#fff`
on their old indigo buttons; v2 moved them to the token.

Contrast figures are measured WCAG relative-luminance ratios against both `--paper` and
`--surface`, taking the worse of the two. `--ink-3` is AA-large on purpose: it is for
labels that carry no load. Never put required information in it.

`--accent` is a **fill** colour: 4.68:1 on white, but only **4.47:1 as text on
`--accent-wash`**, which is below AA. That pairing — accent text inside an accent-tinted
box — is common enough in the editor to deserve its own token, so accent text on the wash
takes `--accent-ink`. In dark mode the accent already measures 6.88:1 on its wash, so
`--accent-ink` is the accent itself there. Borders and glyphs may stay `--accent`: the
non-text bar is 3:1.

**There is no warning colour.** This product has no forms to validate, and an amber
warning would fight the ochre accent for the same visual meaning. Saved and failed are
the only two states worth a colour.

**Why ochre.** Desmos blue, GeoGebra purple, Excalidraw indigo, GoodNotes blue, OneNote
purple. The category is entirely blue and purple. A burnt ochre reads as drafting
equipment rather than software, and it is instantly not them.

**Ink colours are the user's, not the system's.** The pen palette is content, not chrome,
and is exempt from this table. The *default* pen follows the ground in both directions:
`#ffffff` on dark, `#1b1b18` on light. An earlier version of this line said the app
"already does" this. It did not. It only ever flipped to white for a dark canvas, which
was harmless while the editor was hardcoded dark and became invisible ink the moment the
editor started following the operating system. Only those two defaults swap for each
other; a colour the user picked is never touched.

### Migration

The nine stylesheets currently hold **938 distinct colour literals**, including 65 different
white-at-alpha values, 61 black-at-alpha, and 26 slate-at-alpha, plus **eight parallel
token vocabularies**: `--chrome-`, `--planner-`, `--ribbon-`, `--tour-`, `--pomo-`,
`--sheet-`, and loose `--bg-` / `--panel-` sets. Roughly 150 real decisions expressed 938 ways.

This is not cosmetic debt. Those vocabularies are private to their feature and scoped to a
breakpoint: `--chrome-*` is declared on `body.chrome-rail`, which only exists at ≥1180px.
A panel built against it renders with **no background at all** on the target tablet. That
shipped, and it shipped because there was no single vocabulary to reach for.

Migrate in this order, one file per pass, so a regression is easy to place:
1. ~~`editor-chrome.css`~~ (done 2026-09-03) and the `--sheet-*` set
2. ~~`file-ribbon.css`~~ (done 2026-09-03)
3. `write.css` — **still outstanding.** Accent, radii and the alpha overlays are
   swept. It still holds **439 distinct colour literals** (980 declarations).
   An earlier version of this line said "~50", which was wrong: 50 was what
   renders on one screen, not what the file contains. The 439 are the real
   palette, and migrating them means deciding what each one means, which is the
   rewrite this migration keeps deferring
4. ~~`marketing.css`~~ (done 2026-09-03) and `style.css`
5. `planner.css`, `onboarding.css`, `not-found.css`

Translucent overlays collapse onto the wash ladder in `tokens.css`: `--w-1..5`
(lighten) and `--d-1..5` (darken). Solid surfaces use the theme-aware
`--rule`, `--rule-2`, `--raised`, `--accent-wash`. Any alpha outside those is drift.

**Caveat on the sweep that produced the ladder.** Mapping 338 declarations onto
10 rungs snapped some alphas by up to 0.100 (25/255), well past the ~2/255 this
project treats as imperceptible. The mass of values sat at 0.04-0.14 and moved
under 5/255, but roughly 13 white and 16 dark overlays could have shifted
visibly. The editor's main screen was compared before and after and is
indistinguishable; the other panels were not checked. Before extending this
ladder to another file, measure the worst-case snap first and add rungs until
it is under 0.02.

## Typography

- **Headlines, the wordmark, dialog titles and button labels:** **Space Grotesk** (400–700), as `var(--display)`. Added in v2: the technical grotesk that makes the product read as drafting equipment.
- **UI and body:** **Archivo** (400/500/600/700), as `var(--sans)`. Unchanged; it reads for an hour.
- **Numbers, measurements, keyboard hints, labels:** **JetBrains Mono** (400/500/700), as `var(--mono)`.
- **Loading:** self-hosted from `static/fonts/` by `tools/vendor_fonts.py`, `display=swap`, with every `unicode-range` kept. Three families is now the budget; Space Grotesk costs a latin visitor about 22 KB.

**The choice was never the problem.** `Inter`, `Segoe UI`, `Arial` and three bare system
stacks currently leak in alongside Archivo across the stylesheets. Fix the leaks; do not
change the families.

**Every number sits on `font-variant-numeric: tabular-nums`.** A radius readout that shifts
sideways as it changes is the tell of a toy rather than an instrument. This applies to
measurement readouts, coordinates, angle marks, page numbers, timers, and file sizes.

**Scale** (rem, 16px root):

| Step | Size | Use |
|---|---|---|
| `--t-1` | 0.75 | Mono labels, keyboard hints |
| `--t-2` | 0.8125 | Secondary UI, chips |
| `--t-3` | 0.9375 | Body, default UI |
| `--t-4` | 1.0625 | Lede, section intro |
| `--t-5` | 1.375 | Card and panel headings |
| `--t-6` | 1.875 | Section headings |
| `--t-7` | 2.75 | Page display |

Tracking: `-0.022em` at `--t-7`, `-0.015em` at `--t-6`, `-0.008em` at `--t-4`, `0` below.
Mono labels get `+0.1em` and uppercase.

## Spacing

- **Base unit:** 4px. Nothing off the scale.
- **Density:** comfortable-compact. An instrument is dense; a toy is airy.
- **Scale:** `--s1` 4 · `--s2` 8 · `--s3` 12 · `--s4` 16 · `--s5` 24 · `--s6` 32 · `--s7` 48 · `--s8` 64

## Layout

- **Approach:** hybrid. Grid-disciplined in the editor, editorial on marketing, both on the same 4px module so the two read as one product.
- **Minimum touch target:** 44px, via `var(--tap)`. **Not yet met.** An earlier
  version of this file claimed it was, based on measuring `.tool` buttons only.
  A full sweep of the live editor found **44 controls under 44px**. Fixed so far:
  `.file-rail-btn` (was 33), `.menu-item` (41), `.toolbar-location-btn` (38),
  `.feature-tour-close` (33), and the tour progress dots (29x17, now carrying a
  44px `::after` hit area while the dot itself stays small), and on 2026-09-15 the
  whole `.pomo-*` family (14 controls, 33-43px), rebuilt at `var(--tap)`, and the
  Shape picker. Still outstanding: `.feature-tour-btn` (2), `.clear-confirm-close`
  (36), and 6 raw checkbox inputs at 13-19px.
- **Radius:** `--r-sm` 3px (controls, chips) · `--r-md` 6px (panels, cards) · `--r-lg` 10px (sheets, modals). Hierarchical, never uniform.
  Plus two shapes that are not scale values and are allowed: `--r-pill` 999px and `--r-circle` 50%.
- **Max reading width:** 62ch for prose, 74rem for page shells.

### Editor chrome

The editor chrome is **three islands, grouped by what a control acts on**, not one.
An earlier version of this line called for a single island, reasoned from an 800px phone
where three tool rows plus the File ribbon ate about 30% of the screen. That reasoning
holds below the 1180px rail breakpoint, where the chrome does collapse to one wrapping
bar. Above it, a single island holding 25 controls is worse than the problem it solves.

The three, at ≥1180px:

1. **The top bar** — one object spanning the band, in three zones. *Document* at the left
   (menu, File / Insert / Export, the name and save state, plus the two contextual export
   buttons that appear in notebook and deck modes). *The work* centred (undo, redo, the Shape assist toggle, then a divider and Clear).
   *The view* at the right (zoom out, a live percentage, zoom in, pan, fit), then a
   divider, then the workspace controls (canvas presets, YouTube, Pomodoro).
2. **The tool rail** — the nine drawing tools and the help button, left edge.
3. **The tool dock** — the current tool's own options, beside the rail.

What this replaced: everything that was not a drawing tool ended up in a single strip
pinned top-right, because that strip was defined as the residue after `editor-chrome.js`
pulled the tools out into the rail. It held history, a destructive action, two features,
a preference and three view controls in one row, and at 1400px it left **444px of empty
band** between itself and the File ribbon.

**Clear canvas sits beside history, by request.** It was moved to the File backstage on
2026-09-04 because it sat one control from Undo — the least safe and the safest thing in
the interface, side by side — and it came back on 2026-09-05. The adjacency objection was
never wrong, so the button is not a plain sibling of Undo: a divider separates it, it is
recessive until pointed at and then takes the destructive ochre, it keeps its confirm
modal, and clearing is now undoable (it was not before). It remains in the File ribbon
too; both entry points call `window.clearCanvasAction`.

**A zone is defined by what its controls act on, not by what was left over.** Any new
control belongs to the document, the work, the view, the workspace, or the tool in your
hand. If it belongs to none of those, it does not go in the bar.

**Every tool button carries its keyboard letter, printed permanently in the corner** at
`--t-1` mono in `--ink-3`, going `--accent` when the tool is active. This is how Excalidraw
handles it, and it is strictly better than the alternative: the help card built in the
previous session lived in a dock that only exists at ≥1180px, so the target device never
saw it. Nothing that teaches the instrument may hide behind a `?`.

Gestures that have no button (two-finger tap to undo, three-finger tap to redo) are listed
in an inline hint under the island and in the help sheet, never only in one of them.

## Motion

- **Approach (editor, since 2.8.1):** physical and quick. Controls answer like
  objects (they squash, stretch and settle), surfaces come from somewhere, and
  sets arrive in order; the instruments themselves (the canvas, the ink, the
  compass and protractor) never bounce. Supersedes "minimal-functional": the
  owner asked for the principles below by name. See **Motion and interaction
  principles**.
- **Approach (marketing, v3.1):** expressive but quiet. Blocks rise in as they
  scroll into view, the demo window leans toward the pointer, a light follows
  the pointer across tiles, and the theme switch wipes out of the button.
  Nothing on the first screen ever waits on a script.
- **Tokens:** `--ease-out` (expo-out), `--ease-in`, `--ease-in-out`,
  `--ease-spring` (marketing only), and `--dur-1..4` (120 / 180 / 320 / 640ms)
  in `tokens.css`. Use these; do not write a new curve.
- **Duration:** editor 120–180ms, nothing over 200ms except a navigation or
  theme transition. Marketing reveals may run to 640ms.
- **Shared layer:** `static/css/motion.css` and `static/js/motion.js` on every
  page: cross-document view transitions, the theme wipe
  (`Inkyscib.Motion.themeWipe(change, fromElement)`), and dialog entrances.
- **Never animate:** the ink. It must feel immediate, and it currently does.
- Respect `prefers-reduced-motion: reduce` everywhere.

### Motion and interaction principles

Asked for by the owner, by name (2026-11-24). Each one has a rule for this
product and a place it lives; the shared parts are `static/css/motion.css`
and `static/js/motion.js` (`Inkyscib.Motion.stagger`, `.originFrom`,
`.rubber`), loaded on every page. Two limits hold over all of them: **the ink
is never animated**, and **every answer starts in the frame it was asked
for**. Under `prefers-reduced-motion` every movement below stops; the state
change it carried still happens.

| Principle | The rule here | Where |
|---|---|---|
| **Timing** | Press 70ms, release 320ms, a surface 240-260ms, a set 28ms an item (capped at 12), a camera or drag spring 320-380ms. Nothing that answers a press waits. | `--dur-*` in tokens.css; motion.css |
| **Slow in, slow out** | Arrivals on a long ease-out (`--ease-out`), anything that travels both ways on `--ease-in-out`, exits accelerate (`--ease-in`). Linear only for progress. | tokens.css |
| **Anticipation** | A press squashes before anything happens; the quick ring's arc charges for 0.5s before it opens; its hub gathers (shrinks) before it lands. | `.mx-press`; quick-access.css |
| **Squash and stretch** | A pressed button gets wider and shorter (mass kept), then taller past rest as it releases. On the `scale` property, so it never fights a button's own transform. | `.mx-press`, `mxRelease` |
| **Follow-through** | Things that arrive go slightly past their rest and settle: ring slices, popovers, the sheet, a ticked box. Opacity and colour never overshoot. | `mxOriginIn`, `qaSlicePop`, `pbTick` |
| **Arcs** | Ring slices sweep out on a curve (through a point turned back 40 degrees), not along a ray. | quick-access.js `--ax/--ay` |
| **Staggering** | A set arrives in its order: the command search's rows, the File and Tools commands, a day's tasks (once per day shown, never on a re-render). | `Motion.stagger` |
| **Origin awareness** | A surface grows out of the control that opened it: the Canvas popover from its button, the File/Tools sheet from its tab, a tooltip from the side facing its control, the quick ring from the pointer. | `Motion.originFrom`; ui-kit.css |
| **Interruptible motion** | Movement a person can cut short is a transition, so it reverses from where it is: the press, the ring closing (pulled back in over 140ms; opening it again takes over). | motion.css; quick-access.js |
| **Rubber banding** | A drag past a limit keeps following with growing resistance and springs back on release: the YouTube player at the screen edges. | `Motion.rubber`; youtube.js |
| **Secondary action** | A main change carries a smaller one that confirms it: ticking a task pops the tick while the progress bar fills; the streak number jumps when it grows. | planner-brutal.css |
| **Exaggeration** | Spent in a few places only, where a feeling is the point: the streak jump, "Day complete", a finished focus session, the homepage hook. Never on tools. | planner, pomodoro |
| **Solid drawing** | One light, top-left: every hard shadow falls down and right, the same distance for the same depth (`--nb-shadow-*`), outlines the same weight per size. | tokens.css |
| **Doherty threshold** | Under 400ms the app answers or says it is working: a press shows in the same frame; anything slower (a frame import, Image to text, an export) puts a named chip or status up at once, with Stop where it can. | ribbon progress, ocr.js |
| **Fitts's law** | Targets at least 44px on touch; the most used things come to the pointer (the quick ring opens where you hold) or sit on an edge (the tool rail, the ribbon); the primary button is the largest in its surface. | DESIGN.md Spacing; quick-access.js |
| **Hick's law** | Few choices at once: eight tools in the ring, seven presets at most, one search box over everything instead of more menus, advanced edits in their own section. | quick-access.js, ui-kit.js |
| **Frequency of use** | What is used most is nearest: the ring holds the council's eight most-used tools; the command search lists what you run most first ("Frequent"), counted in this browser only (`inkyscib-command-usage`). | ui-kit.js |
| **Von Restorff effect** | One thing in a surface is different, and it is the thing to do: one yellow primary per surface; a coloured chip only for meaning (blue topic, green focus, red when an exam is near). | planner-brutal.css, brutal.css |
| **Peak-end rule** | Make the best moment and the last one good: the day completed, a focus session finished, a job's chip turning to a popped check when it is done, the Image to text card landing on the page. | motion.css `mxDonePop` |

### Boot and navigation

The editor used to open behind a full-screen splash: a brand mark, a drawn
illustration of a canvas, two rotating captions and a progress bar, carrying
**nine looping animations across thirteen elements**. It was shown for as
little as 320ms, so none of them ever completed, and on a slow tablet it ran
long enough for the progress bar to fill, reset to zero and fill again. Five
rules, each one written from a specific thing that screen got wrong.

- **The editor is never covered by a picture of itself.** The splash drew a
  fake canvas with a fake toolbar, sitting between a real canvas preview on
  the landing page and the real canvas being opened. Three canvases, two of
  them fictional.
- **A progress indicator reflects real load state, or it is not shown.** The
  old bar was a 1.85s CSS loop with no connection to loading. A bar that
  restarts is worse than no bar: it tells the user the wait just began again.
- **Nothing decorative animates while someone is waiting.** If an animation
  cannot finish inside the time the screen is up, it is noise. Measure the
  screen's real lifetime before timing anything on it.
- **Chrome that is ready is shown as ready.** The toolbar and the grid are
  static markup and paint in about 90ms. Every script tag is `defer`, so
  nothing blocks that paint. Holding usable chrome behind a curtain until the
  scripts finish is a lie about what works.
- **The walk from `/` into `/write` is one move, not two screens.** Same
  origin, so a cross-document view transition carries the landing page's
  canvas into the editor's canvas. Where it is unsupported the browser does a
  plain navigation, which is the same result without the move. Because the
  transition fires at the new page's first paint, this only reads correctly
  once the covering layer is gone: otherwise it morphs into the splash.

The **budget is 90ms to a usable editor**, on any device, because that is when
the markup paints. Restoring a saved document is allowed to take longer, and
says so in the filename chip at `--ink-3` rather than behind an overlay.

## Decisions Log

| Date | Decision | Rationale |
|---|---|---|
| 2026-09-03 | Positioning: serious technical instrument | User choice, taken over "calm study room" |
| 2026-09-03 | Instrument means quieter, not louder | Desmos, GeoGebra and Excalidraw are all near-white and single-accent; an instrument must not compete with the measurement |
| 2026-09-03 | Restrained-achromatic colour; user's ink is the only colour | Differentiates from a category whose chrome is full of colour, and keeps the student's work the brightest thing on their screen |
| 2026-09-03 | Ochre accent `#B4530A` / `#F0913C` | Whole category is blue or purple; ochre reads as drafting equipment |
| 2026-09-03 | No warning colour | No forms to validate; amber would fight the accent |
| 2026-09-03 | Keep Archivo + JetBrains Mono | Already loaded and correct; the failure was leakage, not the choice. Swapping costs a download on a slow connection |
| 2026-09-03 | Shortcut letters printed permanently on tools | The ≥1180px help card never reached the target device; the instrument must teach itself in place |
| 2026-09-03 | One editor island | Three rows plus ribbon cost ~30% of an 800px phone screen |
| 2026-09-03 | Pen style grid: 2x22px debris removed | The ragged 2-2-1 of near-touching icons came from `.tool-dock .pen-styles { grid-template-columns: repeat(2, 22px) }` with 22px buttons, left over from a 48px vertical dock that no longer exists. Deleted rather than overridden. Now a 3-column grid of 72x44 cells with 8px gaps, and the stroke preview went 30px to 52px so the five pens actually read apart. **Three separate rules were setting width on this button across two files; a fix that looks ignored usually means a more specific rule you have not found yet.** |
| 2026-09-03 | Pen style icons redrawn from the render code | The five were uniform-width squiggles differing only in thickness, so nothing showed how width varies ALONG the stroke, which is the only thing separating these pens. Variable-width nibs are now filled shapes; calligraphy is a curve, not a zigzag, because it was reading as a second fountain pen |
| 2026-09-03 | Colour picker never actually closed | The real fault, found on the third report. `.color-studio` sets `display: flex`, which outranks the browser's `[hidden] { display: none }`, so every close path set the attribute and the panel stayed on screen at full size, still swallowing clicks with its own hue slider. `.color-studio[hidden]` now forces `display: none`. **I twice reported this as working because I measured `root.hidden` rather than the computed display. Check what renders, not the flag that is supposed to make it render.** An audit of every `[hidden]` element found the same defect on `.compass-new-arc`; also fixed |
| 2026-09-03 | Hex field given a real label, and honest slider names | The code was an unlabelled mono scrap with `#` as its only label, which stops being a label the moment you type. Now a visible HEX label, a readable field, paste tolerance for a leading `#`, select-on-focus, an invalid-input note, and a copy button. Sliders renamed from Hue / **Amount** / **Light** to Hue / Saturation / Lightness |
| 2026-09-03 | Colour picker close button: 19x22 to 44x44 | Reported as "the close button does not work". It always worked: `closedByRealPointerClick: true`. It was a 19px glyph at 0.6 opacity that people could not hit. Now `var(--tap)` with hover and focus states |
| 2026-09-03 | Overlay wash ladder `--w-1..5` / `--d-1..5` | 338 alpha declarations in write.css collapsed onto 10 rungs. **Caveat:** the top rungs absorbed a wide band, so up to 13 white and 16 dark overlays shifted by more than the 2/255 threshold used elsewhere. Verified visually identical on the editor's main screen; not verified on every panel |
| 2026-09-03 | Editor theme follows the OS when unchosen | `<html>` carried a hardcoded `data-theme="dark"`, same bug as the marketing shell. Stamped before paint so there is no flash |
| 2026-09-03 | Default pen colour follows the ground both ways | Exposed by the change above. The flip to white only ever ran for a dark canvas, so a stored white default on a light page was invisible ink. Only the two defaults swap; a colour the user picked is never touched |
| 2026-09-03 | Pomodoro controls raised to `var(--tap)` | icon buttons 34, tabs 36, presets 40, sound chips 34. The volume slider keeps its 4px track and gains a 44px box |
| 2026-09-03 | Tool panel hint: 20 words to 6 | "Tap the tool again to close." The compass exception is something you meet, not something you get briefed on |
| 2026-09-03 | `tokens.css` is now the single vocabulary | Loaded first on every page. Marketing and the editor both read from it, so the two halves cannot drift apart again. `marketing.css` no longer carries its own copy |
| 2026-09-03 | `--chrome-*` aliases the core tokens and moved to `:root` | It was declared on `body.chrome-rail`, which only exists at >=1180px. That is the bug that shipped an unstyled panel on tablet. The names are kept so 800 lines of editor CSS needed no edit |
| 2026-09-03 | Editor accent: indigo to ochre | 116 literals of `#5a5aff` / `#a5a5ff` / `#3d3dc4` across 5 stylesheets. The editor and the site now share one accent |
| 2026-09-03 | Radii collapsed 23 values to 4 | 279 declarations rewritten onto `--r-sm/md/lg/pill`. Live editor went from 17 distinct radii to 5 |
| 2026-09-03 | `html` had no font-family | The cascade root fell back to Times New Roman; anything outside `body`'s subtree inherited serif. Now set in `tokens.css` |
| 2026-09-03 | Marketing pages rebuilt on the token set | First application of this system. `marketing.css` rewritten from the HUD version; `home.html` hero rebuilt; the starfield, nebula parallax and "SYSTEM READY" ticker deleted from template, CSS and JS |
| 2026-09-03 | Marketing copy stops narrating the software | `INITIALIZE CANVAS` to `Open the canvas`, `MOD_01.3 // PAGES` to `Pages`, `OPERATOR_01 // TEACHER` to `Teacher`, `SYSTEM ONLINE // MAETHIST OS v1.0` to `Free / offline / no account`. An instrument states what it does; it does not announce that it has booted |
| 2026-09-03 | Marketing now honours the system colour scheme | `<html>` carried a hardcoded `data-theme="dark"` and the CSS had no `prefers-color-scheme` block, so a light-mode visitor was always served dark. Three states now: system default, plus explicit light and dark |
| 2026-09-03 | Hero holds two columns down to 54rem | 62rem stacked at 992px, which caught the ~960px tablet and pushed the drawing below the fold. The drawing is the one thing on the page the product actually made |
| 2026-09-03 | 13 tokens replace 938 literals and 8 vocabularies | Feature-private, breakpoint-scoped tokens already shipped an invisible panel on tablet |
| 2026-09-04 | Boot splash deleted | It was the HUD era surviving on the one screen the migration never opened. `marketing.js` already carries the principle in a comment: an instrument does not announce that it has booted. That deletion took the starfield, the nebula parallax and the SYSTEM READY ticker off the marketing pages on 2026-09-03 and never reached `/write`. Nine looping animations, a fake canvas, a fake toolbar and a fake progress bar, on a screen whose real lifetime is however long the page takes to load: 320ms on localhost, seconds on the target tablet. Two behaviours, neither designed. ~600 lines removed |
| 2026-09-04 | Time to usable editor: 1030ms to 90ms | The chrome and the grid are static markup and were always ready; the splash was holding them back. Measured on the four-way prototype at https://claude.ai/code/artifact/e5ca74dd-7592-4cce-a1f5-3d427f078d37 |
| 2026-09-04 | Landing to editor is one view transition | `@view-transition { navigation: auto }` with a shared `view-transition-name` on `home.html .canvas` and `write.html #canvas-container`. Removes the blank navigation frame entirely, since the old page holds until the new one paints. Degrades to a plain navigation where unsupported. Needs an `:active` state on `.primary` so a slow load does not read as a dead click |
| 2026-09-04 | Third un-migrated cyan pocket found | The splash carried `#67e8f9` on the pen tip, `rgba(103,232,249,.7)` on a stroke and `#67e8f9` in the progress gradient, plus a `#facc15` yellow in a system that states it has no warning colour, and `font-weight: 850` against an Archivo that loads 400/500/600/700. The colour picker held five `#6ee7dd` rings. Assume more remain: the ochre migration was done per-file, and the files it did not open still carry the old accent |
| 2026-09-04 | Editor chrome: one top bar in three zones, not one island | The top-right strip was defined as "everything that is not a drawing tool", which is why it held history, a destructive action, two features, a preference and three view controls at once. Zones now group by what a control acts on. At 1400px this closed 444px of empty band. The one-island line in this document was reasoned from an 800px phone and still applies below the 1180px breakpoint, where the chrome collapses to one wrapping bar |
| 2026-09-04 | Clear canvas moved from the top bar into the File backstage | It sat one control from Undo. `ui.js` bound it with an unguarded `getElementById(...).onclick`, so the behaviour moved to `window.clearCanvasAction` and the ribbon calls that |
| 2026-09-05 | Backdrop blur removed from the rail, the top bar and the tool dock | `--chrome-bg` resolves to `--surface`, which is opaque in both themes, so `backdrop-filter: blur(22px) saturate(160%)` was blurring pixels the fill then covered completely. Invisible, but still a compositing layer and a full backdrop blur on every paint, on the three surfaces that sit over the one canvas that repaints continuously. They read as glass from the border, the shadow and the gap. `.pattern-pop` was the same bargain at 0.96 alpha and is now opaque. 17 elements carried a backdrop filter; 13 do |
| 2026-09-05 | Pointer verb unified on "Tap" | The product is touch-first (see the 44px floor above), and the copy is mostly "Tap" already. Four strings said "Click", two of them in the compass panel one line apart from a "Tap" -- `write.html` 1039 and 1059, `color-studio.js` 184 and 214. The house verb wins; the outliers moved |
| 2026-09-05 | Copyright year rendered rather than typed | The editor footer read `© 2025` in September 2026. A hard-coded year is wrong every January and nobody reads the footer to notice. An `inject_current_year` context processor supplies it |
| 2026-09-05 | Tool panels: the dock says when it has more, and shows a scrollbar again | The compass panel is ~960px of controls in a ~700px frame and scrolled fine, but `.tool-dock-body::-webkit-scrollbar` was set to `width: 0`, so nothing on screen said the rest existed. The bar is 6px again with a styled thumb, and `has-more` masks the bottom edge to a fade while anything is below the fold, clearing as you reach the end. Measured on the compass: 277px hidden, fade on; scrolled to the bottom, `remaining: -1`, fade off. `syncActivePanel` re-measures, because swapping panels changes the scroll height without touching the child list |
| 2026-09-05 | Algebra tiles: three columns instead of one 38px tower | The dock override laid seven tiles out as a centred single column 38px wide inside a 232px panel -- 194px of the width unused, the panel pushed into a scroll it did not need, an 8px label and an 11px swatch. Now a three-column grid: tray height 338px to 212px, label 8px to `--t-1` (12px), unit swatch 11px to 17px. The seven art sizes became `--tile-w`/`--tile-h` so a panel can scale the set with one `--tile-scale` without losing the proportions, which are the point -- x is wider than the unit, x2 is square, xy is x by y |
| 2026-09-05 | Write assist: input smoothing now applies to the stylus, not just the mouse | `appendInkPoint` filtered hand tremor for `pointerType === "mouse"` and returned early for everything else, on the reasoning that "pens already provide carefully sampled input". A stylus reports a clean sample of a shaky hand, and a fingertip is shakier still, so on the tablet this product targets handwriting was unassisted. The render-time pass (`smoothPoints` + `soften`) fits a curve through whatever was recorded and cannot remove a wobble already in the points. The device check is now a setting -- Off / Natural / Strong in the pen panel, `natural` by default, persisted with the rest of toolSettings. Measured on a synthetic stylus stroke with a 3px tremor: jitter RMS 2.963 off, 0.160 natural, 0.100 strong, with the point count unchanged, so it filters position rather than dropping samples |
| 2026-09-05 | Clear-canvas dialog rebuilt as an editorial panel | The confirm button was a 135deg amber gradient under a coloured glow, which is the first thing that reads as generated rather than designed, and the layout was a generic centred alert. The mark now sits beside the question, a hairline separates the decision from the explanation, the actions are right-aligned, and the destructive button is one solid `--accent`. The off-token `#ffd36b` focus ring and the orange confirming glow went with it, and light mode no longer needs its own palette for this dialog -- only the scrim |
| 2026-09-05 | Tool panels can be opened below the dock breakpoint again | `syncActivePanel` nulled the active tool whenever `isDockMode()` was false and then set `display: none` on every tool panel, so under 1180px no tool's controls could be opened at all -- pen colour, size and style out of reach on the budget tablet this product is written for. There was no other way in: `toggleToolbox` in core.js is exported and never called. Reproduced on pristine master before changing anything. The active tool is now computed at any width and only the dock chrome is gated on the breakpoint. Two things surfaced once the panel could open: it is `z-index: 11` against a File ribbon fixed at 9996, so the ribbon covered it, and its `top: 60px` predates that ribbon, so the toolbar clipped its first row. Floating panels are now placed under whichever bar hangs lowest, at 9997, with the height that is actually left; the inline styles are cleared when it re-docks. Its violet radial wash went at the same time -- the palette has one accent and it is ochre. Measured clean at 375, 768 and 1440 |
| 2026-09-05 | Chrome scripts moved next to core.js and made to init on execution | The three files that build the visible frame -- `file-ribbon.js`, `tool-dock.js`, `editor-chrome.js` -- are 17KB of a 399KB payload but sat last in a 47-file queue and waited for DOMContentLoaded on top, so they landed at 712/760/838ms with the event at 907ms. They only need core.js (`appState` and `syncWorkspaceShellBounds`, both defined at its top level), so they now sit directly after it and init on execution rather than on DOMContentLoaded. Chrome ready moved from 474ms after the DOM was parsed to 52ms after it |
| 2026-09-05 | Toggle chips fill their grid cell | The Labels group rendered five chips at five widths (59-115px) inside a fixed 104px two-column grid, and "Coordinates" overflowed its column. The dock styles these labels as `flex-direction: column; align-items: center`, which sizes the span to its text; `width: 100%` on the span beats that without having to out-specify the dock's own label rule. Applies to every `.geometry-toggle-grid`, so line, angle, compass and shape all straighten up |
| 2026-09-05 | Line kind became an edit, not just a draw setting | Extending is already a render-time decision -- `extendLineForKind` reads `lineKind` and the two points you dragged -- so switching a drawn line between segment, ray and line is non-destructive and reversible. The KIND buttons now act on the selected line when there is one, which is what the panel's hint always claimed, and set the default for the next line when there is not. The change goes through `commitHistory`, so it undoes. Buttons re-point at the selection on `canvasRendered`, there being no selection-changed event to listen for |
| 2026-09-05 | Hamburger menu deleted; its contents placed by the zone rule | The drawer had become a duplicate of the ribbon. Rather than move the leftovers into a new View tab -- which would rebuild the "everything that is not a drawing tool" bucket this document already records as a mistake -- each item was placed by the rule in Layout > Editor chrome: a control belongs to the document, the work, the view, the workspace, or the tool in your hand. Pattern is a property of the view, so it is a popover in the View cluster, where the canvas stays visible behind it; a backstage pane covers the very thing you are choosing a pattern for. Pages changes the shape of the document, so it is a File command. Toolbar location belonged to nothing that still worked -- `.chrome-rail .toolbar.is-topbar` sets `top: 14px` at (0,3,0) and beats `body.toolbar-location-down .toolbar` at (0,2,0), so the toggle was dead at >=1180px -- and was deleted. The GitHub link belongs to none of the five zones and was deleted. What survives is `#chromeTriggers`, a `hidden` host: ppt.js and image.js bind each file input's `change` handler inside `if (button && input)`, so deleting an import button would silently unbind its import. Four feature-tour steps that pointed into the drawer now point at ribbon tabs. Tab stops fell from 69 to 31 |
| 2026-09-05 | Extra tools moved into the ribbon as a Tools tab | Planner, Pomodoro, YouTube, AR Inky and the feature tour were split between the hamburger menu and the top-right bar. They are now one `Tools` tab beside Export, and the YouTube and Pomodoro buttons are `hidden` in the bar rather than deleted, because the ribbon triggers them by clicking them. Commands prefer a module API where one exists (`Planner.open`, `AR.toggleAR`, `FeatureTour.open`) and fall back to the button -- `plannerBtn` does not respond to a programmatic click at all, which is a pre-existing bug this routes around rather than fixes. The side menu is still there: the ribbon's PDF, PowerPoint and image commands work by clicking its buttons, so it cannot be deleted until those are rewired |
| 2026-09-05 | The half-built chrome is no longer painted before the real one | Reported as "this UI loads first before the actual canvas". All three chrome pieces are built by JavaScript -- `editor-chrome.js` creates the tool rail and moves the ten tool buttons into it, `file-ribbon.js` creates the ribbon -- and none of it exists in the markup. So the first paint was a different editor: every tool crammed into one centred bar, no rail, no ribbon, which then rearranged itself. Measured at 1440x900: `domInteractive` 356ms, last script 768ms, `DOMContentLoaded` 824ms -- a ~470ms window of the wrong layout. The chrome now sits at `opacity: 0` until `editor-chrome.js` adds `chrome-ready` at the end of its init, which is after all three chrome scripts have had their DOMContentLoaded turn. The canvas is real markup and still paints immediately, so the hold is a canvas with its hint, not a blank screen. Held through `body:not(.chrome-ready)` because the dock sets `opacity: 1` from inside a `@media (min-width: 1180px)` block at (0,2,0), which a bare `.tool-dock` rule loses to; opacity rather than display because `syncInsets` measures the toolbar's height and a display:none bar measures zero. An inline `load` listener adds the class as a failsafe, so a script failure cannot leave the editor permanently invisible |
| 2026-09-05 | Closed File backstage made inert, and focus handed back on close | Asked what sits below the File ribbon: the backstage panel does, permanently. It is `position: fixed` at ~71px, 652x233px, and when closed it is only `opacity: 0` -- still `display: grid`, still laid out under the ribbon, with its buttons in the tab order despite `aria-hidden="true"`. Focusable content inside an aria-hidden subtree is the combination the spec calls out, because the reader announces nothing while the focus ring is visibly gone. It now carries `inert` whenever it is closed, which takes it out of both the tab order and the accessibility tree: 4 phantom tab stops to 0. `inert` also blurs whatever was focused inside it, dropping focus to `<body>`, so `close()` hands focus back to the tab that opened it -- but only when focus was actually inside, so dismissing by clicking the canvas leaves the canvas alone |
| 2026-09-05 | Colour swatches moved to border-box, capped at 44px | Reported as "the two colours on the left are not completely visible". `.color-swatch` was content-box, so a 2-3px border was added outside the declared width and each swatch came out wider than its grid cell; the first column spilled past the panel's left edge. Every swatch is border-box now, with the base sizes restated as rendered diameters (20 to 24, 22 to 26) so nothing moved elsewhere. The dock cap is 44px rather than 52 because `.color-swatch.active` is `scale(1.12)`: the real footprint is 49.3px in a ~52px cell, and at 52 -- and still at 46 -- the selected swatch overflowed. The compass keeps its own `.compass-swatch`, so `.compass-colors` needed the same grid stated separately. Verified clip-free across pen, highlighter, shape, line, tiles, angle and compass |
| 2026-09-05 | Colour rows given a grid and room to breathe | `.chrome-rail .tool-dock .colors` said "44px tap targets" in its comment while setting 34px circles and a `2px` gap, and wrapped with flex, so six swatches came out as five plus a stranded one. A fixed four-column grid at `--s2`: swatches 43px to 60px, gap 2px to 8px, the second row lined up under the first. The hex field spans columns 2 to 4 on a row of its own with the picker pinned to column 1 -- at ~140px it wants more than a 52px cell, and in a `1fr` cell it pushed 35px past the panel edge |
| 2026-09-05 | Empty-state prism removed; the blank canvas keeps one line of text | The mark was a large octahedron labelled REFRACTION, and it was removed on request. It cost a full-viewport canvas, a device-pixel backing store, a pointer-parallax listener and -- before it was fixed earlier the same day -- a 60fps redraw that ran for the life of the page. What is left is `#emptyHint`: "Draw anywhere to start", real DOM text, 12px on `--t-1`, 6.86:1 dark and 4.70:1 light, centred in the workspace. `prism-canvas.js` is gone; `empty-state.js` replaces it and does nothing but toggle `body.canvas-empty` when the workspace becomes empty or stops being empty. The canvas label it replaced was `fillText` on an `aria-hidden` canvas: unselectable, silent to screen readers, 11px against a 12px scale floor, and it told a first-time user nothing |
| 2026-09-05 | Clear canvas returned to the top bar beside Undo | User request, reversing the 2026-09-04 move. The reason for the move stands, so the adjacency is mitigated rather than ignored: a divider, a recessive-until-hovered destructive colour, the existing confirm modal, and `clearCanvas()` now pushing an undo snapshot instead of wiping `undoStack` — which had made the File ribbon's "Undo can bring them back" false since the feature was written. The ribbon entry stays; both call `window.clearCanvasAction`, and the binding is guarded this time |
| 2026-09-04 | Zoom controls gained a live percentage and a fit button | Three view controls with no readout: no way to know your zoom or return to 100%. The readout polls `appState.transform.scale` rather than counting clicks, because wheel and pinch zoom write the transform directly and never go through `window.zoom`. Fit reuses `resetView()`, which the `0` key already used. Set in `--ink-2`, not `--ink-3`: measured 3.8:1 on the bar, and this document says `--ink-3` is non-load-bearing only |
| 2026-09-04 | Support / Buy me a coffee removed from the menu | User request. Took the last `#ffd36a` and `rgba(244, 180, 67, ...)` literals in `write.css` with it |
| 2026-09-15 | YouTube Save frame captures the playing frame, not the thumbnail | A cross-origin player cannot be read from the page, so the old capture drew YouTube's still thumbnail. While the video plays, Save frame asks to share the tab, crops the stream to the player (Region Capture where available), grabs one frame and rejects a blank one. If sharing is refused it falls back to `/api/youtube/frame`, which crops the nearest storyboard tile on the server. Every server fetch had been failing first: Python 3.14 with OpenSSL 3.5 turns on strict X.509 checks that reject an antivirus interception root, so only `VERIFY_X509_STRICT` is cleared and verification stays on |
| 2026-09-15 | Pomodoro rebuilt on the core tokens, its sound synthesised | Reported as too complicated, rain that did not sound like rain, an inaudible deep sea, and a settings icon that was not a gear. Two views, timer and settings, every control at `var(--tap)`; the gradient ground and the green and amber break colours are gone. Rain and deep sea are rendered offline and looped without a seam, levelled through a small-speaker filter so the low swell survives a tablet speaker. The ~1,000-line `.pomo-*` block in `write.css` was deleted |
| 2026-09-15 | The theme toggle became canvas presets | A preset sets `--canvas-ground`, the grid and ruling colour, and the chrome theme it pairs with, and is stamped on `html[data-canvas]` before first paint so a reload never flashes. Saved with preferences; read by notebook pages, library thumbnails and the background cache key |
| 2026-09-15 | Shape assist toggle in the work zone | Requested beside undo and redo with a divider before Clear. On, a drawn shape snaps to a real shape object, the pen stays in hand, and a chip offers Edit or Keep as ink; off, strokes stay ink and are not tidied. It acts on the work, so the zone rule puts it there. Kept in sync with the pen panel's switch |
| 2026-09-15 | File backstage rail cut to File and Recent | Insert, Export and Tools appeared twice, as ribbon tabs and as rail entries. They open from the ribbon only, and the backstage hides its rail when a ribbon tab opens it |
| 2026-09-15 | Every tool panel has a close button | A 44px close in the floating panel's sticky head and in the dock head. A docked panel hides its own head, so there is one close, not two |
| 2026-09-15 | Handwriting smoothed when the pen lifts, corners kept | Reported as write assist not feeling smooth. `ink-smooth.js` smooths the raw samples along the stroke's length with no phase lag, finds corners on a de-jittered copy so tremor is not mistaken for one, bounds how far any point may move, and pins the ends. Live ink is stabilised harder and the nib is drawn at the pen tip, so the line never trails the pen. Tuned on synthetic pen, mouse and touch strokes; not yet measured on the target tablet |
| 2026-09-15 | Shape picker: fifteen labelled shapes in four groups | Reported as too few shapes and hard to tell apart. It was seven 32px icon-only buttons (a Font Awesome square, a play glyph for the triangle) and a triangle-type row that appeared only after picking a triangle. Now Round, Triangles, Quadrilaterals and Polygons in three columns of labelled buttons, each triangle type a button of its own, then Fill (none, tint, solid) and Outline (solid, dashed, dotted). Each icon is drawn once, in a Jinja macro shared by the rail and the picker, and shows what sets its shape apart: ticks on equal sides, a box in the right angle, dots on corners you place. The old `.shapes`, `.shape-btn` and `.triangle-type-btn` rules were deleted, not overridden |
| 2026-09-15 | An ellipse is stored as its four axis ends | Centre, radii and tilt are read back from the points, so moving, rotating and stretching it is the select tool's existing polygon code, and a stretch keeps the area it produced. It exports to PDF as four cubics. Fill and dash reach the PDF too; a tint needs an ExtGState, so without one the path falls back rather than printing opaque |
| 2026-09-15 | Tool preferences were not being saved | Found while testing the Shape tool. `storage.js` declared `function savePreferences()`, then exported a debounced scheduler as `window.savePreferences`. In a classic script those are one binding, so the scheduler's timer called the scheduler, which rescheduled itself every 220ms, and nothing reached localStorage or IndexedDB. The writer is now `writePreferences`. **A top-level function in a classic script is a property of `window`; never export something else under its name** |
| 2026-09-17 | Tool panels unified on the core tokens, 960px first | Reported as "every tool's sub tool dialogue box UI is not interesting". They were not unstyled: the styling was gated. Everything good sat behind `@media (min-width: 1180px)` / `body.chrome-rail`, and the target is a ~960px tablet, so on the actual device the size slider was browser-default blue, the swatches were a ragged flex wrap (the layout this log already records as fixed), headings were centred at 0.66 opacity, the Line panel's five arrow tips stacked into a tower, and a tall panel scrolled with no cue. `write.css` now carries the wide-panel values scoped to `.tool-options` rather than `.tool-dock`, and the 130 lines of `.chrome-rail` overrides that existed only to undo the 48px-dock assumptions are gone. `.tool-options` was also declared twice in the same file 3,800 lines apart — the dead half's background, padding, radius and max-width are removed |
| 2026-09-17 | The indigo and the cyan are gone from the panels | 26 literals: `rgba(133,126,255,*)` on every checked toggle chip in the line, angle and compass panels, `#8b84ff` on the active swatch, `#a9a3ff`/`#5c54d6` on every hint glyph, five `#6ee7dd` focus rings, and the violet radial this log recorded as removed — which had survived in light mode only, which is why it kept being missed. All resolved to `--accent` / `--accent-wash` / `--ink`. A colour swatch's own fill is exempt: that is the user's ink, content rather than chrome |
| 2026-09-17 | `.tool-options` no longer blurs what it then covers | `backdrop-filter: blur(18px) saturate(1.15)` over an opaque `var(--surface)`: the same bargain removed from the rail and the top bar on 2026-09-03, still being paid on the device with the slowest GPU |
| 2026-09-17 | Shape assist icon redrawn as one mark | It was a dashed arc beside a small triangle — two fragments with dead space between them and no transformation cue, and at the 18px this renders at the `1.8 2.3` dash broke into loose specks that read as dirt. Now one square mid-correction: three sides settled, the fourth still the wobble that was drawn, in the accent. Same rule as the settings gear on 2026-09-15: an icon depicts the mechanism, as one mark, and must survive 18px |
| 2026-09-17 | Recents can rename and delete | Reported as missing. Both operations already existed and worked from the Library modal; the Recents row was a single `<button>`, and HTML forbids nesting controls inside one, so it had nowhere to put them. The row is a container now with an open button that keeps the row's centre — a mis-click in the middle of a row must never delete — and the two actions at the trailing edge, quiet until the row is pointed at and always on where there is no hover. Delete goes through the app's own confirm, now parameterised, rather than `window.confirm`; rename edits in the row. Deleting also releases the notebook's imported original, which used to be kept forever |
| 2026-09-17 | Eraser: what the hold-to-lasso does is a setting | Reported as the lasso being "also like an object clearing tool". It was worse than that: `finishLasso` never read `toolSettings` at all, so the panel could say Partial while the loop deleted whole objects regardless. `lassoAction` is its own key — the mode normaliser coerces anything that is not `object` back to `partial`, so a third value cannot survive there — and offers Erase them or Select them, erase by default. `.eraser-mode-btn` was rebuilt on the core tokens at the same time: it was 34px against the 44px floor, an 8px radius off the 3/6/10 scale, and indigo when active |
| 2026-09-19 | YouTube frames are cut by the server, not captured off the screen | Reported: "Save frame" asked to share the whole screen, visibly grew the player, and still produced a low-resolution picture. All three followed from one constraint — the browser cannot read pixels out of the cross-origin YouTube iframe — so the only thing it could photograph was the player's own ~420px box, which YouTube serves at about 360p. The server now resolves the stream with yt-dlp and decodes the frame at the exact playhead time with PyAV: 1920×1080 against ~420×215, no permission prompt, nothing on screen moves. It takes 4–5s cold and ~1.6s once the stream URL is cached, so the job is named in a progress chip beside Tools in the ribbon ("Importing YT frame") rather than leaving the button to look broken. YouTube's 320×180 storyboard remains the fallback when the video cannot be read. `getDisplayMedia` is gone entirely, and a test tripwire fails if anything reaches for it again |
| 2026-09-19 | The footer credit is signed, and moves | Asked for "cool and animated". The one place the app moves for its own sake, so it is kept small: TT is five hand-drawn strokes (each T's bar then stem, then a swash) that write themselves in once, about a second after load, and again when pointed at or focused, in ochre. No perpetual motion — anything that keeps moving pulls the eye while someone is writing. Two faults were caught only by capturing the animation frame by frame in real Chromium, since the in-app pane never advances animations: round caps drew every unstarted stroke as a dot, and a swash touching the stems' feet gave each T a base and made it read "II". Reduced motion gets the finished signature with no pen |
| 2026-09-19 | The YouTube player stays below the chrome | Reported: half the player's title bar hid behind the File ribbon when a video started. The ribbon stacks above the player, and every way the player got a position — a hard-coded 100px default, the viewport clamp and the drag — let its top rise to 0–8px. All three now keep it below the tool bar and ribbon; staying on screen wins where the window is too short for both. A mutation check showed the first test only half-worked: with the fix removed, a player dragged up sat on top of the tool bar, so its title bar was reachable while it covered the tools. The test now checks both directions |
| 2026-09-19 | YouTube frames arrive in well under a second | Measured first: the cost was not decoding but FFmpeg's own HTTP reader, which opened fresh connections as the MP4 demuxer hopped around and read far past the frame — 6.3s and 7.1s for frames at 2:05 and 5:00. A seekable file over one kept-alive connection, fetching 1 MB chunks into a shared cache, does the same in 0.84s and 0.88s with three requests. B-frames are skipped until 0.6s before the target (half the decode, byte-identical pixels), and the stream is resolved when a video loads rather than when the button is pressed. First capture 4.8s → 0.6s; nearby ones 0.1–0.2s. A shutter flash answers the click on the same frame |
| 2026-09-19 | Write assist is a slider, 0–100 | Asked for a spectrum rather than three buttons, and for handwriting "as clean and uniform as possible". The old presets were calibrated by measurement, so they are exact points on the new scale — 40 is Natural and 70 is Strong to the last digit, verified against a recording taken before the change — and saved "off"/"natural"/"strong" map onto 0/40/70. Above Strong the smoothing deliberately stops growing: measured, Strong's pen output already scores 0.0559 on turn jitter against 0.0575 for the intended line itself, so there is no wobble left, and a wider kernel only rounded letters (a zigzag's corners drifting 2.2 → 3.5px). Twicing looked like a way past that on one stroke and was not on twelve. So 70–100 buys uniformity instead: pressure evened toward the stroke's median, touch-down and lift-off hooks trimmed (strict enough to keep a 1's flag), and a longer reach for the digit tidy. The preview runs the real smoother and draws line weight, so the far end visibly does what it says |
| 2026-09-19 | The signature is written in real ink (supersedes the keyframe version above) | Asked for "the best in the industry". The first version revealed uniform-width lines with a dash, which reads as a loading indicator, not handwriting. Now each stroke is a filled calligraphic shape — width from a broad nib at 35° (bars thin, stems full) and pen pressure (touch-down, swell, a downstroke that finishes with weight) — revealed through a mask along its centreline, so tapered ink grows as a pen lays it down. A nib rides the leading edge, lifts and arcs through the air between strokes, and the ink is wet ochre that dries to the footer's ink. Hover re-inks rather than erasing: a white-hot glint of fresh ink traces the strokes in order. Every frame is `renderAt(ms)`, so it was reviewed frame by frame and its tests check the sequence at exact instants (strokes in order, one at a time, pen down only while writing, nothing erased on hover), each mutation-checked. Geometry is generated by `design/signature_geometry.js`. Plays once and on hover, never loops, pauses in a hidden tab, and is the finished signature without script or under reduced motion |
| 2026-09-20 | WCAG 2.1 AA: `--ink-3` came off every piece of text | axe-core on `/`, `/features`, `/about`, `/legal/privacy` and `/write` found 18 contrast failures, and all but three were the same thing: `--ink-3` (3.51:1) printing 12–13px informational text, which needs 4.5:1. This document already said `--ink-3` was non-load-bearing only, so the rule did not change — the usages did. `.card-index`, `.track-stack`, `.profile-tier`, `.profile-tags`, `.profile-stat span`, `.site-foot`, `.zoom`, the legal `caption`, `.assist-spectrum-number` and the assist scale's stop labels all moved to `--ink-2` (7:1). `--ink-3` keeps hairlines, hovers and the canvas grid, none of which carry text |
| 2026-09-20 | `--accent-ink` added; two off-token literals removed | The remaining three failures. The active write-assist toggle put `--accent` text on `--accent-wash` at 4.47:1, so accent-as-text gained its own token at `#AD4F09` (4.79:1) rather than darkening the brand accent everywhere. `.geometry-control-hint` was `rgba(51,65,91,.62)` light and `rgba(224,229,244,.52)` dark — two literals outside the vocabulary, the light one resolving to #818999 at 3.51:1 on 9.76px text; both are `--ink-2` now and the light-mode override is deleted. `--ribbon-ink-dim` went 0.62 → 0.66 alpha (4.31 → 4.86:1); the whole private `--ribbon-*` set is still the palette debt this document warns about. All five pages now report zero axe violations at wcag2a/2aa/21a/21aa, pinned by `tests/test_accessibility.py` |
| 2026-09-20 | Three effects taken from VengeanceUI, and the rest left | Asked to upgrade the app with VengeanceUI (MIT, React + Tailwind + Framer Motion). Nothing was installed: this project has no build step, and the library's own catalogue -- `aurora-hero`, `liquid-metal`, `fluid-morph-bg`, `glow-border-card` with its rotating multi-colour conic -- is the exact look this document records removing twice (the violet radial wash, the amber gradient under a coloured glow). What was worth taking was three techniques, rewritten in vanilla CSS against these tokens: the **border beam** (upstream's `offset-path` + `mask-composite`, respelled as a masked conic so Firefox and Safari get it too), the **sliding link underline** (near-verbatim, retimed from 300ms to `--slow`), and the **odometer digit roll** (the strip technique without Framer Motion). One accent, not two; transient, not ambient; nothing on the pointer path. `static/css/vengeance.css`, `static/js/odometer.js`, pinned by `tests/test_vengeance_ui.py` |
| 2026-09-20 | The beam may not position `.file-ribbon` | Writing `position: relative` on the ribbon to hang the beam off it looked inert on a 1280px screen, because `.chrome-rail .toolbar.is-topbar .file-ribbon` (editor-chrome.css:235) forces `position: static` above 1180px and outranks it. Below 1180px there is no `.chrome-rail`, the ribbon is `position: fixed`, and the new rule **wins** -- unpinning the File ribbon on the 960px tablet this product is written for. Caught by measuring `getComputedStyle(...).position` at both widths rather than by looking at the desktop. The save beam moved to `.file-ribbon-state`, which is static everywhere and is the element that actually reports the save. A breakpoint-gated override does not mean a rule is harmless; it means it is harmless *at the width you looked at* |
| 2026-09-21 | Shape assist is a three-step slider: Off, Straight, Exact | Reported: a square drawn by hand "sometimes appears as a rhombus". Measured: the quad classifier read right angles off the fitted corners within ±16°, so a square whose sides lean 14° came out a rhombus 25% of the time and one leaning 18° every time; and when it did say rectangle, the rebuild took the width from the diagonal, so a square leaning 10° came back 239x198. One switch could only say snap or don't, and the report is really a second question -- the figure meant, or the figure drawn. **Straight** is the figure meant: wide tolerances (mean corner error ≤22° is a right angle, sides within 15% of each other a square), the ideal figure built from edge projections so a lean adds nothing, and turned square to the page when within 15° of it (a near-45° square stays a diamond). **Exact** is the figure drawn: a kind is named only within 4°/5%, orientation is never touched, and an outline with no name keeps its corners, joined by straight edges, as ink. Both straighten long straight strokes (≥140px; Straight levels them to 0/45/90 within 8°). 40 hand-like squares leaning up to 20°: 40/40 squares at Straight, 0 rhombi. Scribbles, arcs, stars, lobed blobs: 0% at both steps. The slider reuses the write-assist spectrum control; its preview runs the real recogniser on a wobbly square, triangle and oval. The top-bar button is Off and back to the step last chosen. The old key's "1" reads as Straight |
| 2026-09-21 | Tool panels have one owner at every width | Reported: "every button dialogue box sometimes overlaps". Below 1180px each tool file ran its own open/close -- single tap for Pen and Eraser, a 300ms double tap for four others, none for Angle -- writing `style.display` behind `tool-dock.js`, and `events.js` hid every panel on each stroke start without telling it either. The worst case: Algebra tiles' button selected the tool, the dock showed its panel, and a leftover `toggleToolbox()` hid it -- the panel never opened on the tablet at all. Now the tool files only select, the dock toggles on a second tap at every width, a canvas tap and Escape put a settings panel away (Compass and Angle stay, as they always did in the dock), and `closeAllToolboxes` hands back to the dock afterwards |
| 2026-09-21 | Floating panels float from a body-level layer, into the free area | They lived inside the toolbar, which is centred with `transform: translateX(-50%)`. A transform is the containing block for `position: fixed` children and a stacking context, so every panel was placed from the toolbar's corner (46px in on a phone) and capped at its z-index of 10. They now move to `#toolPanelLayer`. Position and size come from one shared `ToolDock.freeArea()` -- below whichever bars sit in the top half, above whatever sits in the bottom half, the footer included -- and every floating panel is one width, docked to the left edge like the wide-screen dock. Content-box sizing had put padding, border and a stray margin outside the max-height, so panels ran 20px off a 600px window and over the privacy links; they are border-box now. The centring transform also animated: a panel turning floating slid 152px in from the left |
| 2026-09-21 | One floating surface at a time | Tool panel, canvas-theme popover and File sheet each opened over the others: the theme popover landed on an open Pen panel (237x195px), the colour studio opened over the toolbar and hid six of its buttons. Each now dispatches `inkyscib:surface-open` and closes itself on anyone else's; the colour studio only listens, since it belongs to the panel that opened it, and opens beside that panel (or its dock) inside the free area, scrolling itself when taller. The File sheet's height is derived from its top (`--sheet-top`): below 1180px the top moved to 198px while max-height kept the old arithmetic, so "Clear canvas" sat at 664px in a 600px window with nothing that scrolled to it |
| 2026-09-21 | Panel controls on `--tap`, the studio on the core tokens | Line styles and arrow tips were 30x26, the fixed-length clear 32, tiles 42, tile signs 34 (26 docked), Clear radius 32, the unit-name field 40x20 -- all to 44 via `--tap`, the unit field keeping its label look with its dotted rule drawn as a background. A lone toggle takes its whole row (Angle's "Show the angle" broke over two lines in half of one). `.tool-options label` outranked `.sr-only`, so two hidden Compass labels were 292px wide and the panel scrolled sideways. The colour studio drops its private blue-black glass, 16px blur, Segoe UI and separate light palette for `--surface`/`--ink`/`--sans`; slider tracks get an edge a white-to-white gradient cannot erase, and a focus ring `outline: none` had removed |
| 2026-09-21 | A floating panel waits to be asked | Found by the raw-input and live-stroke tests, which draw from (200, 300) on a 960x600 tablet: with panels docked to the left edge, the pen panel -- open unasked on every load -- sat exactly where a left-to-right writer starts, and the first stroke landed on the panel. Centred, it had covered the middle instead, which was no better. Below the dock a panel now opens when its tool is tapped, not when the editor loads; the dock, a column beside the canvas, still shows its panel. And at body level a panel's z-index finally takes effect, so it is the base `.tool-options` value, 11 -- above the toolbar and dock, under the assist chip, the YouTube player, the Pomodoro pill and every sheet, which is where the toolbar's stacking context had always, accidentally, held it |
| 2026-11-15 | v2 identity: Blueprint. Drafting blue, cyan accent `#0B6B94` / `#5FD4F0`, Space Grotesk for display | Owner picked it from three mocked directions. Supersedes the ochre accent and the "keep two families" rows above; positioning and every layout rule stand |
| 2026-11-15 | Below 1180px the chrome is two docked bars, and the tool row scrolls instead of wrapping | The wrapping bar was 200px of loose icons on a 600px tablet (three rows on a phone) with the File ribbon floating under it. Now 122px at every width; all controls fit unscrolled at 960px. Supersedes "collapse to one wrapping bar". `static/css/chrome-compact.css` |
| 2026-11-15 | The tour, the File sheet, the planner and My Notebooks read the core tokens | Each had its own palette (indigo, teal, lavender), so four dialogs were four different products. Their `--tour-*`, `--ribbon-*` and `--planner-*` names survive only as aliases |
| 2026-11-15 | The footer credit is a plain readable link, not an animated signature | Owner request: "Created by @kshitizarc", linked to LinkedIn. It rested at 40% opacity, under 3:1 |
| 2026-11-17 | Icons from Lucide (editor), Phosphor (Planner, Pomodoro, tour), Remix Icon (marketing, legal) | Owner request to use all three. One family per surface, chosen by `data-icon-set` on the surface root, so stroke and filled styles never share a row. Content drawings (shapes, nibs, line styles) stay hand-drawn. `tools/vendor_icons.py`, `static/icons/LICENSES.md` |
| 2026-11-17 | The YouTube player gets lecture tools (transport, speed, A-B loop, notes, resume, dock, keys) | Owner request. The embed hides its own controls at the player's size, and a lecture needs more than a music video does. Keys act only while the pointer is over the player, so the canvas keeps its shortcuts. Continue watching shows no thumbnails, so nothing reaches YouTube until you press play. `static/js/youtube.js` (Lecture tools), `tests/test_youtube_lecture.py` |
| 2026-11-17 | The focus timer gets per-mode hues on the clock and a Sound studio | Owner request. Supersedes the 2026-09-15 one-accent rule for the clock only: the Start button stays the one brand yellow in every mode. Beds are rendered and levelled like rain; beat frequencies are live oscillators (binaural or amplitude pulse). Labelled as a listening aid, not a treatment, with a seizure caution. `static/js/pomodoro.js`, `static/css/pomodoro.css` |
| 2026-11-17 | v3.1: one motion system | Owner request for a more premium, smoother feel. Shared curves and durations in `tokens.css`; page and theme changes run as view transitions; marketing blocks reveal on scroll, but only those below the fold at load, so LCP is untouched. The phone header scrolls away rather than pinning three rows over the page. `static/css/motion.css`, `static/js/motion.js` |
| 2026-11-17 | v3: neo-brutal with frost, on the marketing pages, the tour and the editor chrome | Owner request for a bolder, more modern look. Outlines and hard shadows are `--nb-*` and `--ui-*` core tokens in `tokens.css`; frost is `--frost*`. Dialogs are frosted everywhere, floating bars only on a fine pointer (frost costs a GPU pass per canvas repaint). The active tool is an inset box-shadow, so 44px targets do not change size. `static/css/brutal.css`, `chrome-brutal.css`, `tour.css` |
| 2026-11-17 | Renamed to MAETHIST; new maths-symbols mark | Owner request. The mark is full colour with black outlines, so it always sits on a paper tile (`#F3F7FB`) rather than directly on the dark sheet. Internal identifiers keep the old name so stored work survives. `tools/make_brand_icons.py` |
| 2026-11-19 | The tool rail can be hidden from the ribbon | Owner request. `body.rail-hidden` sets `--rail-w` to 0 and slides the docked rail out; below 1180px the same button hides the tool row, so the control exists at every width. Remembered per device (`inkyscib-rail-hidden`). `static/js/quick-access.js`, `static/css/quick-access.css` |
| 2026-11-19 | A still 2-second press opens a ring of eight tools | Owner request; the contents came from an LLM council (`docs/council/council-quick-ring-2026-11-19.md`). Every slice is labelled and is also on the rail or the ribbon, so the ring is never the only way to a tool. It is clamped inside the viewport and not armed for tools that already own a long press (eraser lasso, compass reopen). Slices are core tokens: frost, `--ui-line`, brand yellow for the tool in hand. |
| 2026-11-19 | Image to text runs on this server, not through a search engine | The owner asked whether images could go to Google image search in the background. Rejected: scraping it breaks Google's terms, it would send students' handwriting to a third party when the privacy policy says nothing goes to anyone, and image search finds pictures rather than transcribing them. Pix2Text MFR (ONNX, about 120 MB) reads equations and TrOCR (about 1.3 GB) reads handwriting, in memory. Optional per server: `requirements-ocr.txt`. `ocr_engine.py`, `static/js/ocr.js` |
| 2026-11-19 | Nothing over the canvas is frosted; a sheet or dialog is frosted only while open | Reported: "the response of pointer is very laggy". A backdrop blur is redrawn whenever the page under it changes, and while writing that is every pen sample. Closed panels sat at opacity 0 still carrying their blur (two of them full screen), and the top bar and rail were frosted on a fine pointer. Supersedes the v3 row's "floating bars frosted on a fine pointer". `static/css/chrome-brutal.css` (ink first) |
| 2026-11-19 | A picture background is screen-fixed wallpaper, edited in the image sheet | Owner request. It is a ground, not a document: it stays put while the page pans and zooms (a picture to annotate goes on the page instead). One edit sheet for pictures, frames and the background, so every edit exists in all three. Fade washes it toward `--canvas-ground` so ink stays readable. `static/js/canvas-picture.js` |
| 2026-11-19 | Image edits that need pixels are baked, never live | The council's edits (even light, levels, sharpen, black and white, clear paper, blur) are pixel passes. Each picture is baked once per size bucket (512, 1024, 2048) and cached; drawing is one `drawImage`. `static/js/image-process.js`, `docs/council/council-image-edits-2026-11-19.md` |
| 2026-11-19 | Every surface opens a clear 14px below the bar it hangs from (`--chrome-gap`) | Reported: "no spacing between the header ribbon and the sub-dialogue box". Measured: 0 to 6px for the File sheet, Canvas popover, panels and player; the bar's 4px hard shadow made them read as touching. `static/css/ui-kit.css`, `canvas-theme.js`, `editor-chrome.js`, `tool-dock.js` FREE_GAP, `youtube.js` |
| 2026-11-19 | Tooltips are drawn by the app, not the browser, and carry the key | From shadcn/ui's Tooltip: styled, shown on keyboard focus too, a skip delay along a toolbar. The native title is moved to `data-tip` on first use so two never show; the accessible name is kept. Solid, never frosted. `static/js/ui-kit.js` |
| 2026-11-19 | One command search (Ctrl+K, "/"; the double-click entry was removed in 2.8.4, as a double tap already means "back to the pen") | From shadcn/ui's Command and ComfyUI's double-click search. Lists the tools and the ribbon's own COMMANDS, so a new ribbon command is searchable without being added twice. `static/js/ui-kit.js` |
| 2026-11-19 | No tool panel opens on load, at any width | Owner request. Supersedes the dock's "keeps showing its panel" on a laptop. `static/js/tool-dock.js` |
| 2026-11-19 | About's display faces: Bricolage Grotesque and Instrument Serif italic | Owner request for "super cool" type with motion, on About only. Self-hosted by `tools/vendor_fonts.py`. Motion is a 22ms letter stagger, off under reduced motion. |
| 2026-11-19 | The Planner is neo-brutal, and is a study planner, not a calendar | Owner request; features from an LLM council (`docs/council/council-planner-2026-11-19.md`): focus from a task, exams with a revision spread, streak and this week, topic and notebook, backup. No accounts, push, AI plans or XP. Solid surfaces on the core tokens, scoped to `#plannerModal` in `static/css/planner-brutal.css`. |
| 2026-11-24 | Nineteen named motion and interaction principles, each with a rule and a home | Owner request, by name. Supersedes "Instruments do not bounce" for controls and surfaces; the canvas, the ink and the instruments still never bounce, and every answer starts in the frame it was asked for. Table under Motion. `static/css/motion.css`, `static/js/motion.js` |
