# TODOS

Deferred work, with enough context to pick up cold. An item here is a decision
that was made and recorded, not a vague intention. If something is worth doing
later, it goes here; if it is not worth writing down, it is not worth doing.

Ordered by expected value, not by effort.

---

## 1. Load the optional features on demand

**Why it matters:** about 350 KB of the editor bundle is features behind
buttons, and all of it is parsed and executed before the first stroke on every
visit. gzip cut the transfer, but parse and execute cost is paid on the
uncompressed bytes, and it is paid on a budget Android tablet with a slow CPU,
which is the device this product is written for.

| Module | Size | Reached by |
|---|---|---|
| `static/js/planner.js` | 96 KB | Planner button |
| `static/js/ppt.js` | 52 KB | PowerPoint import |
| `static/js/ppt-local-import.js` | 48 KB | PowerPoint import |
| `static/js/youtube.js` | 41 KB | YouTube button |
| `static/js/pomodoro.js` | 41 KB | Pomodoro button |
| `static/js/library.js` | 36 KB | My Notebooks |
| `static/js/onboarding.js` | 35 KB | First run only |

**Why it is not done:** each module wires its own UI at load time and registers
its own `DOMContentLoaded` handler, so this is a real refactor into dynamic
imports behind each entry point, not a mechanical change. `onboarding.js` is the
cheapest first target: it is 35 KB that only ever runs once per user, and it is
already gated on a `localStorage` key.

**Done when:** time to first stroke on a throttled mid-range mobile CPU profile
improves measurably, and every feature still opens from its own button.

---

## 2. ~~Blit the committed canvas layer when panning instead of rebuilding it~~

**Shipped 2026-09-11, and it covers zoom as well as pan.**

The plan here was a scroll-blit that redrew the newly exposed strip. What
landed instead is a **padded layer**: the committed bitmap is rasterised with
`__COMMITTED_PAD` device pixels of margin around the viewport (192, or 96 when
`navigator.deviceMemory <= 2`), so a transform change is served by drawing that
bitmap through a delta transform for as long as it still covers the canvas.
`__blitTransform` computes the mapping and returns null when coverage would
fail or the magnification would exceed `__BLIT_MAX_ZOOM`; either way the frame
falls back to the old rebuild, so the worst case is unchanged.

Choosing the margin over the exposed strip bought zoom for free — a strip
redraw only ever helps pan — at the cost of about 5 MB of extra bitmap at
1920x1200. Measured frames served from cache: 83% on a 1000 css px/s pan, 95%
on a slow pan, 98% on a pinch to 2x, 95% on a wheel zoom out.

Because a blit reuses a bitmap rasterised for a different scale, it is soft
while magnified; `__scheduleSharpRebuild` drops the cache 140 ms after movement
stops so the view lands sharp. Covered by `tests/test_canvas_blit.py`.

**Still open, if pan ever needs more budget:** redrawing the exposed strip on
top of a blit would remove the coverage limit entirely and make the pan budget
unbounded. Not worth it at 83–95%.

---

## 3. Brush and fountain nibs stroke once per point

**Why it matters:** `__drawVariablePenStroke` in `static/js/canvas.js` issues a
separate `beginPath()` / `stroke()` for every point so each segment can carry
its own width, and it recomputes `__penSegmentWidth` twice per segment. The live
stroke is repainted every frame while you draw, so a long stroke gets
progressively more expensive: the cost is quadratic in its own length.

**Why it is not urgent:** the default pen style takes the single-path route and
is unaffected. This only bites users who switch to the brush or fountain nib and
then draw a long stroke.

**Two steps, in order:** carrying `nextWidth` forward halves the width
computation immediately and is a few lines. Caching the already-drawn prefix of
the live stroke removes the quadratic term and is the real fix.

**Step one landed 2026-09-11.** `__drawVariablePenStroke` carries `currentWidth`
forward instead of recomputing each point's width twice — one
`__penSegmentWidth` call per segment instead of two. Output is **pixel-identical**
(same alpha hash, inked count and alpha total for brush and fountain against the
pre-change build). Measured **7.7–16.7% faster** over four interleaved A/B rounds.

**Two benchmarking traps found while measuring this, worth knowing before the
next attempt:** a sequential old-then-new run reported the change as 20% *slower*
— pure machine drift, and the same case read 1.4 ms in one run and 11.6 ms in
another. Interleave A/B/A/B and take medians. And a test stroke built as
`x = 150 + i * 1.1` runs off the canvas past ~1000 points, so Skia clips it and
the cost looks flat with length; hold the extent fixed and vary only the sample
count.

**Step two landed 2026-09-11 — the quadratic is gone.** The motivating numbers,
at a fixed on-canvas extent: per-frame cost was linear in point count (brush
0.2 ms at 125 points, 0.6 ms at 1000, 1.7 ms at 2000, 2.7 ms at 4000) and since
the live stroke is repainted every frame *as it grows*, the total over one
stroke was quadratic.

`__drawLiveStroke` in `static/js/canvas.js` now rasterises the settled part of
the stroke once into `__wetLayer` and redraws only the last `__WET_TAIL` (12)
points each frame. **Measured per-frame, median over the second half of a
stroke: brush 0.700 ms → 0.100 ms at 1500 points (86% off), fountain the same;
and the cached cost is flat — 600 and 1500 points both land at 0.100 ms**, which
is the actual point. Brush and fountain only; the default and gel nibs take the
single-path route and were never the problem.

Enabling this meant splitting the rasteriser into `__drawVariableSpan`, which
draws the loop segments in `[loopFrom, loopTo)` plus whichever end caps it owns.
**Splitting on a loop index is exact** — segment `i` runs from the midpoint
before `points[i]` to the midpoint after it, so two spans meeting at `k` cover
the stroke with no gap and no overlap. That matters: these nibs draw at
`globalAlpha` 0.96, so a doubled segment would show as a darker band. The tail
always resumes at `meta.cached` rather than at the split, so a split that moves
back a point (the decimator forces the final point through, so the array churns
at its end) can neither double-draw nor skip.

**This is the one change here that is not pixel-identical, and it cannot be.**
The prefix is quantised to 8 bits in the intermediate bitmap before the tail
composites over it. Measured against a single-pass redraw of the same 600-point
stroke: 49 pixels of 11,334 inked differ for brush (0.43%, worst 6/255), 36 of
9,349 for fountain (0.39%, worst 16/255 on three pixels, 21 of the 36 differing
by exactly 1). All of them are antialiased edge pixels, scattered rather than in
runs. For reference, two single-pass redraws of the same path are **bit**-identical,
so this is the change's own cost and not Skia variance.
`tests/test_canvas_blit.py::test_a_growing_stroke_matches_one_drawn_in_a_single_pass`
budgets it, and leans on the longest *run* of changed pixels rather than on any
single pixel's delta — a seam is a run, rounding is scatter.

**Partly addressed 2026-09-11 — the count of points, not the cost per point.**
`__decimateForRender` now drops samples closer together than
`__RENDER_MIN_SPACING` (0.20) device pixels before the rasteriser walks them.
It reads `path.points` and never writes it, so the stored stroke keeps every
sample for export, hit-testing and write assist. Most of the benefit is when
the view is zoomed out, where a stored stroke packs many samples into each
device pixel; at scale 1 `appendInkPoint` has already refused samples closer
than 0.12 world units, so there is little left to drop.

**This is a visual tradeoff and the threshold is not a free knob.** These nibs
lay down one round cap per sample, so thinning the samples thins the stroke.
Swept against an undecimated render: at 0.20 it flips 0.41% (brush) / 0.52%
(fountain) of inked pixels and loses 0.56% / 1.06% of total alpha; by 0.75
that is 1.82% / 2.36% and 3.22% / 4.96%, which is visible as a lighter line.
`tests/test_canvas_blit.py` holds the shipped value to under 1% pixels and
1.5% alpha. Raising it for speed would trade quality the wrong way.

Both remaining steps above still stand — decimation reduces *how many* points
are walked, not the quadratic repaint of the live stroke.

---

## 4. The document is serialised twice on every save

**Why it matters:** `flushDrawingSave` in `static/js/storage.js` writes the full
path list to `localStorage` **and** to IndexedDB, so a large document is
stringified and stored twice per save.

**Why it is not urgent:** the save is debounced and runs on an idle callback, so
it is not inside a gesture.

**Open question, and the reason this is not just done:** the `localStorage` copy
looks like a legacy fallback that IndexedDB made redundant, but that needs
confirming before removal. If it is still the recovery path for a browser where
IndexedDB is blocked, it stays.

---

## 5. `penSegmentWidth` is duplicated in three places

`static/js/canvas.js` (`__penSegmentWidth`), `static/js/pdf-vector.js`, and
`app.py`. If one changes and the others do not, exported strokes come out at the
wrong weight, and the export no longer matches what was on screen.

**Done when:** there is one definition, or a test that fails when they drift.

---

## 6. ~~Two planner tests are flaky, and it hides regressions~~

**Fixed 2026-09-11. The suite is green: 177 passed, 0 failed, 6m44s** — from
17 failed / 156 passed in about 21 minutes.

The diagnosis in this item was wrong, and wrong in an instructive way. It read
16 stable failures plus a shifting membership as "two flaky tests among many
broken ones". In fact **all 16 planner failures were a single dead selector**,
and the shifting membership came from three *separate* convention breaches
elsewhere. Nobody had read the tracebacks: every one said the same thing.

- **All 16 planner tests:** `open_page` waited for `#plannerBtn` to be
  *visible*. The hamburger and its drawer were deleted in the chrome refactor;
  `#plannerBtn` now lives in `#chromeTriggers`, which write.html keeps
  permanently `hidden` so the import handlers stay bound. Every test in the
  class burned its full 30s timeout before its body ran — which is most of the
  old runtime. Now waits for `state="attached"`, and `open_planner` calls
  `Planner.open()` the way the ribbon command does instead of clicking a
  hamburger that no longer exists.
- **`test_planner_deeplink`:** asserted the en-US date string while the planner
  formats through `Intl.DateTimeFormat(undefined, ...)`, so it passed only on a
  machine set to en-US. Both planner contexts now pin `locale="en-US"`.
- **`test_document_import::test_size_preview_ring_...`:** the one browser file
  that never dismissed the feature tour. The tour takes the pointer, so the
  canvas never receives `mouseenter` and the size ring never shows. Measured
  4 failures in 6 trials — genuinely flaky, and it had been passing by luck.
- **`test_interaction_plan`:** the one file passing a *bare expression* to
  `wait_for_function` without `bypass_csp=True`. Playwright evaluates a bare
  expression with `eval()`, which the editor's CSP forbids. Fixed by passing an
  arrow function, which needs no eval and keeps the real CSP in force.

**The remaining debt is that none of these conventions are enforced.** Four
things a browser test here must do — dismiss the tour, pin the locale, pass a
function predicate (or set `bypass_csp`), and not wait on hidden chrome — are
currently folklore repeated in fifteen files. A shared base class or fixture
would make the next one impossible to get wrong. That is the real fix and it is
not done.

**Also uncovered, app-side, not fixed:** `#menuBtn` and `#sideMenu` no longer
exist in write.html, but `core.js`, `planner.js`, `onboarding.js` and
`library.js` still look them up — 15 references. In `core.js`
`syncWorkspaceShellBounds` the result feeds `menuButtonInset`, which is now
always `0`, so `dockTopInset` is permanently `Math.max(0, 0)`: dead arithmetic
on every resize. In `planner.js` and `onboarding.js` the dead lookup silently
drops focus restoration when the tour was open. Small, but it is live code
describing a UI that was removed.

---

## 7. Baseline: the suite has 16 pre-existing failures

14 in `tests/test_planner.py`, 1 in `tests/test_smart_geometry.py`
(`test_constructions_remain_on_circle_after_move_and_resize`), and 1 in
`tests/test_planner_deeplink.py` which is only a date-format locale mismatch
(the test expects `'August 9, 2026'`, the machine renders
`'Sunday, 9 August 2026'`).

These are not regressions; they were verified against reverted code. They are
listed here because a known-failing baseline that is not written down is
indistinguishable from a broken build to anyone new.

---

## 8. Group multi-stroke digits before reading them

**Why it matters:** `static/js/handwriting.js` assists each stroke on lift, on
its own. A digit written in two strokes — a 4 with a separate stem, a crossed
7 — is therefore never seen whole, so the $P templates in `ink-recognize.js`
that describe those two-stroke forms can never match. `recognizeDigit` already
takes an array of strokes, so the recogniser side is ready; what is missing is
the grouping.

**What it would take:** hold a finished pen stroke for a short window (~400 ms)
and, if another small stroke lands overlapping or adjacent to its bounding box
before the window closes, re-run `recognizeDigit` on the pair before choosing a
cleanup profile. The chip and revert already handle a correction arriving
slightly after the stroke, so the deferred path is mostly in place.

**Why it is not urgent:** the failure is benign. Each stroke still gets tidied,
and the parts of a split digit are mostly straight runs, so even a misread —
the stem of a 4 scoring as a 1 — selects a straighten-heavy profile that is
roughly right for a straight stem. Nothing is replaced, so a wrong reading
costs a slightly wrong emphasis, never a wrong glyph.

**Careful of:** the delay must not hold up `saveDrawing`, and the window has to
close on tool change, undo, and page hide, or a correction can land on a
document the writer has already moved on from.

---

## 9. Measure InkLab on the target tablet before porting any of it

**What exists (2026-09-13):** `/lab/ink`, a standalone, cross-origin-isolated
prototype, separate from the editor. Spec:
`docs/superpowers/specs/2026-09-13-inklab-webgpu-design.md`. Plan:
`docs/superpowers/plans/2026-09-13-inklab-webgpu.md`. Pointer samples cross into a
dedicated worker through a `SharedArrayBuffer` ring; the worker tessellates each
stroke in a WGSL compute shader and draws it instanced over a baked texture on
WebGPU, falling back to Canvas2D; a damped polynomial predictor draws the stroke a
frame ahead of the pen; a WebNN hook is wired, but no model ships. Covered by 34
Node unit tests and 15 browser tests - 11 on bundled Chromium, 4 on system
Chrome's real GPU.

**What is not known, and is the whole point of the lab:** whether any of it beats
the editor on the device this product is for. Every figure so far is headless
desktop. Before porting anything, open `/lab/ink` on the Lenovo tablet and record:

- which backend it gets - WebGPU availability on that GPU is unknown, and if it
  falls back the overlay says why;
- whether `predictionSource` ever reads `native` - that is, whether its Chrome
  returns predicted events at all;
- `latencyMedianMs`, against the same kind of stroke in `/write`. The overlay's
  figure stops at frame submission, so it is a lower bound on what the eye sees.

**What a port into `/write` would cost, if the numbers justify one:**

- COEP would block the YouTube player: `static/js/youtube.js` creates a
  cross-origin `youtube.com` iframe. A port needs `credentialless` with a
  per-iframe opt-in, or a different way of embedding YouTube.
- The brush width formula would exist in five places - `canvas.js`,
  `pdf-vector.js`, `app.py`, `static/js/inklab/stroke-width.js`, and the WGSL in
  `static/js/inklab/shaders.js`. The lab's parity tests pin only its two copies.
- The editor's live stroke already costs 0.100 ms per frame, flat with stroke
  length (measured 2026-09-11). Rasterisation is not where its latency is;
  prediction is the part most likely to matter.
- The stroke shader reads a storage buffer in the vertex stage. WebGPU
  compatibility mode, which some low-end Android GPUs run in, can forbid that.

**Implemented but untested:** recovery from a lost GPU device - rebuild once on the
same canvas, then ask the page for a fresh canvas and continue in 2D. There is no
reliable way to lose a device on demand in a test.

---

## 10. ~~Browser tests fail at random when the OS hands out a port Chromium blocks~~

**Fixed 2026-09-13; see the end of this item.** Found the same day. A full run failed all three tests in
`tests/test_pen_smoothing.py` with
`Page.goto: net::ERR_UNSAFE_PORT at http://127.0.0.1:4045/write`. Nothing was wrong
with the code: the file passes on its own, and passes when run straight after the
tests that preceded it in the suite.

**Cause.** Every browser test class starts its server with
`make_server("127.0.0.1", 0, app)`, so the operating system picks the port - all 19
browser test files do this. Chromium refuses to navigate to a fixed list of ports
reserved for other protocols (the Fetch standard's "bad ports"), before any
connection is even attempted; 4045 is NFS `lockd`. On this machine the dynamic port
range is 1024-65534 (`netsh int ipv4 show dynamicport tcp`), far wider than the
Windows default of 49152-65535, so it contains 17 blocked ports: 1719, 1720, 1723,
2049, 3659, 4045, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6697 and
10080.

**Verified, not assumed.** Navigating this Chromium (151) to every port on the
published list blocked 80 of the 82. Ports 4190 and 6679 are *not* blocked in this
build, so any fix has to test against the browser rather than copy the list. Nine
nearby control ports were refused, not blocked.

**Why it matters beyond one red run:** it looks exactly like a flaky test, and a
rare one - 17 blocked ports among the 64,511 the OS can assign - so it gets re-run
and forgotten. That is how an unexplained failure stops meaning anything.

**Fix, done 2026-09-13.** `tests/browser_server.py` exposes `make_browser_server(app)`,
and all 19 browser test files now start their server with it instead of calling
`make_server` - any new browser test should too. It binds 127.0.0.1 on port 0,
threaded as before, and binds again if the port is on the Fetch bad-ports list
(all 82: refusing the two this Chromium allows costs nothing). A rejected server is
kept open until a usable port turns up and only then closed, so an OS that hands
out the lowest free port cannot give the same blocked one straight back - closing
first would loop forever on a run like 6665-6669. Narrowing the machine's dynamic
port range would also have worked, but the tests should not depend on a machine
setting.

`tests/test_browser_server.py` covers it with an injected fake bind, since the OS
cannot be made to hand out a blocked port on demand: each of the 17 in-range
blocked ports is refused, the rejected server is closed, a run of consecutive
blocked ports settles, an allowed port is kept on the first bind, and the real
server is threaded on loopback. The tests were written first and watched failing
against the old behaviour, which handed the blocked port straight back.

In each file the helper is imported next to `from app import app`, *outside* the
`try: import playwright` block. Inside it, a broken helper would raise
`ImportError` and silently skip every browser test instead of failing.

**Verified:** `python -m pytest tests/ -q` - 201 passed, 0 failed, 0 skipped, 82
subtests passed, 7m41s (196 before, plus the 5 new tests).

---

## 11. ~~Every pen lift replayed the whole document~~

**Fixed 2026-09-13.** Measured first, in headless Chromium on a 1920x1200 canvas
(960x600 CSS px at DPR 2) with N visible default-nib strokes. Raw ms is JS plus
draw-command recording. Writing and panning frames were already flat at 0.2-0.3 ms
whatever the document size. A pen lift was not: `events.js` pushes the finished
stroke, `__samePathReferences` then fails, and `__rebuildCommittedLayer` replays
every visible stroke - 12 / 49 / 143 ms at 200 / 1000 / 3000 strokes, and
64 / 221 / 696 ms under a 4x CPU throttle. That is a freeze on every lift mid-word.

`__appendToCommittedLayer` in `static/js/canvas.js` now takes the pure append:
when the cached path list is a same-reference prefix of the current one, the canvas
size and ratio are unchanged, no selection drag is in progress, and every new path
is `pen` or `highlight`, it draws just the new paths into the committed layer in the
frame it was built for and extends the cached list. Everything else still rebuilds.
An audit of every place that changes `state.paths` found each one either appends a
new object or replaces or removes objects - the partial eraser splices in new
pieces, undo snapshots are JSON clones, write-assist revert swaps the object back -
and any of those breaks the prefix. Shapes, lines, constructions, tiles and images
stay on the rebuild because some of them draw depending on other paths.

**After:** a pen lift costs 0.4 / 0.4 / 0.5 ms raw, and 1.9 / 3.6 / 1.8 ms under
the 4x throttle.

`tests/test_canvas_blit.py` covers it: a speed test (a lift under a fifth of a
rebuild at 2000 strokes - it failed first at 80.5 ms against 74.9 ms), pixel-exact
identity with a rebuild for the default, brush and fountain nibs and the highlighter
at a zoomed, panned view, and two fallbacks - an earlier stroke replaced alongside
the new one, and the eraser splitting the newest stroke. Mutation-checked: without
the prefix check both fallbacks fail (14,941 and 390 channels), and drawing without
the layer margin fails the identity test (125,589 channels). Full suite 205 passed,
0 failed, 82 subtests, 7m59s.

**What this leans on,** as every cached frame already did: a path changed in place
must invalidate the cache or be replaced by a new object. The next pen lift no
longer repairs one that does neither.

**Measurement trap:** adding a 1px readback after each render, to force raster,
adds a flat ~3.5 ms (1x) / ~14 ms (4x) regardless of stroke count. That is headless
software compositing of the whole frame, not a tablet GPU's cost, so compare raw
numbers.

---

## 12. ~~Remaining render latency: raw input, tail frames, sliced rebuilds, region repair~~

**Done 2026-09-14.** Spec: `docs/superpowers/specs/2026-09-13-render-latency-design.md`,
with what building it taught in 4.1a, 4.4a and 4.5a. Plan:
`docs/superpowers/plans/2026-09-13-render-latency.md`. Tests: `tests/test_render_latency.py`
(13) and `tests/test_raw_input.py` (2). Benchmark: `python tests/bench_render.py`. Each
change was written test-first and mutation-checked - 17 mutations, all caught against
the final code. Full suite 218 passed, 0 failed, 130 subtests, 6m50s.

**What shipped,** measured on a 1920x1200 canvas in headless Chromium, at 1x and under
a 4x CPU throttle, with 3000 strokes unless noted:

- **Raw input** (`events.js`): ink is taken from `pointerrawupdate` as well as
  `pointermove`, each sample exactly once by its timestamp, and painted at once. From
  a sample reaching the page to its first paint: 0.3 ms median, against 5.1 ms from
  `pointermove` alone.
- **Tail frames** (`canvas.js`): while a stroke is written, only a rectangle around its
  tail is repainted. With raster forced: 0.3 ms against 3.7 ms for a full frame (1x),
  2.2 against 15.8 (4x).
- **Sliced sharp rebuilds:** a view moved past the cached margin, or settling after a
  zoom, keeps showing the old layer while the sharp one is built in 5 ms slices and
  swapped in. Worst frame of a 700 px jump: 51 ms against a 144 ms rebuild (1x), 235
  against 665 (4x) - see the first open item.
- **Region repair:** the partial eraser and every frame of a selection drag redraw only
  the region that changed, and an exact copy of the layer is built behind the repair.
  Erase: 34 ms against 144 (1x), 137 against 665 (4x). Pages under 200 paths rebuild.
- **Selection:** neither a marquee nor a drag forces a rebuild any more. `applyAction`
  in `tools/select.js` assigns clones back, so a drag is an ordinary content change.

**What the tests had to learn:**

- **Only a pure append or a full rebuild is bit-exact.** Skia rasterises a path
  relative to its bounds, clip and canvas: one appended point moved 15 channels near
  the start of a 25-point stroke; a rectangle clip changed 121 of 962 pixels inside it;
  a scratch canvas offset by whole pixels did no better. So live and just-repaired
  frames are checked for shape - clusters of pixels moved by 32 or more - and settled
  frames for exactness.
- **Brush and fountain taper their width over the last points,** so their tail is
  `__WET_TAIL + 3` points, not 3. A 3-point tail left stale segments (alpha moves of
  223 in runs of 19).
- **A drag-exclusion layer was built, then removed.** Its mutation checks passed too,
  and a trace showed a drag replaces the path object on every move, so the exclusion
  never ran.

**Open:**

1. **The swap frame pays the deferred raster.** Slices record draw commands; the
   browser rasterises them when the pending layer is first drawn, on the swap frame.
   Verified: forcing raster after each slice cut the worst frame of the jump from 39 to
   24 ms (1x) and 160 to 49 ms (4x), with totals unchanged. Not shipped: the probe
   forced it with a 1px draw and readback, and a readback on a tablet GPU may cost more
   than it saves. Whether a draw without the readback is enough, and what either costs
   on the device, is unmeasured.
2. **A repair walks every path.** Finding what touches the region and diffing the path
   lists cost about 10 ms on a 2000-path page, whatever the region; a dab over one glyph
   came to about a fifth of a rebuild. A spatial index would remove the walk.
3. **Nothing here is measured on the Lenovo tablet** - above all, whether drawing from
   `pointerrawupdate` gets ink to the glass sooner on its `desynchronized` canvas.

## 13. ~~Write lag was observable again~~

Reported 2026-09-17. Two separate causes, both fixed; a third is still open.

**Diagnosis that was wrong, recorded so it is not repeated.** The first read of this
said the live filter's "mouse-only catch-up was deleted", leaving pen and touch
lagging. It was *replaced*, deliberately: `finishInkInput` rebuilds the stroke from
`tracker.rawPoints` through `InkSmooth.smoothStroke`, which is symmetric and has no
lag, so a stroke now ends exactly where the pen lifted — the old catch-up ran for the
mouse only and left pen and touch ~11px short. The live cutoffs were raised 4.5 → 11 Hz
at the same time. Acting on that report would have undone an improvement.

**Fixed 1 — the chrome was republished on every sample.** Drawing renders from
`pointerrawupdate` (which is what bought sample-to-paint 0.3 ms against 5.1 ms), so
`renderCanvasFrame` runs at digitizer rate. Measured: **80 `canvasRendered` dispatches
for 40 pointer moves** — two per move, because raw update renders and `pointermove`
schedules another. Each carried `updateNotebookUi` (three full-document scans through an
uncached `pathBounds`, plus an unconditional `textContent` write that also wakes
`icons.js`'s MutationObserver), `units.js` `syncInputs` (a document-wide
`querySelectorAll`), `geometry.js` `syncInspector`, and `ppt.js` `updatePptUi`. The
event still fires on every frame — it is the "a frame was painted" signal, and
suppressing it broke `test_raw_input.py`, which times raw input against `pointermove`
with it — but now carries `{ liveInk }`, and those four listeners bail on it.
`clampNotebookTransform` and the construction overlay (which rebuilds a string
signature over every path) are skipped outright. Notebook clamps during a stroke:
**80 → 0**. `tests/test_live_stroke_cost.py`.

**Fixed 2 — every pen lift deep-cloned the document.** `captureHistory` went through
`JSON.parse(JSON.stringify(path))` per path, 80 snapshots retained. Measured **28.1 ms
for a 2000-stroke page on a desktop, on every lift** — which is why the lag arrived as
the page filled. Replaced with a direct clone (depth guard rather than a visited Set:
80,000 point objects each paying an add/has/delete cost more than the copy):
**28.1 → 14.1 ms**. Still a real deep copy — sharing path objects would let the partial
eraser, which appends into `path.erasers` in place, reach back into an earlier snapshot.
`tests/test_history_snapshot.py`.

**Also fixed — `test_lift_smoothing_is_cheap` was failing at baseline**, 2.50 ms against
a 2.0 ms budget, and it is in the write path. Two changes, both exact or near enough not
to move a smoothed point: the kernel loop read `points[j].x/.y/.pressure` off an array of
plain objects once per tap (~25k megamorphic loads for a 500-point stroke) — hoisted into
`Float64Array`s, 2.50 → 2.10; and `Math.exp` in the same loop replaced by an interpolated
table over the bounded range `d²/2w² ∈ [0, 4.5]`, error ~1e-7 relative, far below the
movement clamp every point is held inside afterwards.

**Open:**

1. **Structural sharing in history snapshots.** 14.1 ms per lift on a full page is
   within a frame but not free. Sharing unchanged paths by reference would make it
   near-zero, but the partial eraser mutates `path.erasers` in place, so it needs either
   copy-on-write or an audit of every in-place mutation first. Getting it wrong corrupts
   undo, which is data loss — it was not attempted blind.
2. **Nothing here is measured on the Lenovo tablet.** Every number above is a desktop
   number. The per-lift costs are the ones most likely to be several times worse there.

## 14. The colour studio is three HSL sliders, not an SV square

Noted 2026-09-17 while auditing the tool panels. `color-studio.js` is Hue / Saturation /
Lightness ranges plus recents, samples and an eyedropper — there is no 2-D
saturation-value plane, and no SV-square rebuild exists anywhere in this repo. If one was
planned it was planned in a chat log, which is the failure mode CLAUDE.md warns about.
Recorded here so the next person finds it in the file rather than rediscovering it.

## 15. YouTube frames: what the server-side cut depends on

Landed 2026-09-19 (DESIGN.md, same date). Three things worth knowing before
touching it:

1. **yt-dlp needs the machine's TLS bargain too.** On a machine whose antivirus
   scans HTTPS, yt-dlp fails twice over: it verifies against certifi, which
   cannot contain a root that only lives in the Windows store, and Python 3.13+
   then rejects that root under `VERIFY_X509_STRICT` (Basic Constraints not
   critical). `_patch_ytdlp_ssl` in app.py fixes both — `compat_opts:
   {"no-certifi"}` (a compat option, not a flag: it is what drives
   `prefer_system_certs`) plus clearing the strict flag on
   `RequestHandler._make_sslcontext`. Chain and hostname stay verified. Note it
   patches the *method*: yt-dlp binds `make_ssl_context` by name at import, so
   patching the helper module does nothing — that was tried first and failed.
2. **yt-dlp breaks when YouTube changes its player.** When it does, frames fall
   back to the 320×180 storyboard and the toast says "preview frame". The fix is
   almost always `pip install -U yt-dlp`, not a code change. `requirements.txt`
   pins only a floor for that reason.
3. **Server tests must stub `_video_frame`.** Left live, every storyboard test
   resolves a real stream over the network. `FrameEndpointTests.get_frame`
   does this; `?quality=preview` is the same escape hatch for manual checks.

~~**Open:** the cold path is 4–5s~~ -- done 2026-09-19, when "as fast as
possible" was asked for by name: `/api/youtube/prepare` resolves the stream and
pulls its header when a video loads, and `_StreamFile` replaced FFmpeg's own
HTTP reader (the real cost -- 6-7s far into a video, now under 0.9s). First
capture 4.8s -> 0.6s. The trade that was held back is now made: a stream URL is
resolved for every video opened, whether or not a frame is saved.

**Noticed in passing:** the select tool's canvas overlay (the dashed outline and
handles round a selected object) is still indigo. The 2026-09-17 palette sweep
covered the tool panels, not canvas.js overlays.

## 16. Write assist past Strong: what is left to try

The slider (2026-09-19) keeps the geometry flat from Strong (70) to Max (100),
because Strong's pen output already sits at the smoothness of the intended line
(turn jitter 0.0559 against 0.0575, mean of 12 synthetic strokes). Touch still
has ~13% headroom that nothing tried could reach without rounding letters.

- **Fairing rather than smoothing.** A Gaussian shrinks curves; what would help
  touch is a fit that minimises change of curvature for a given distance from
  the samples (a smoothing spline). Twicing was the cheap approximation and did
  not survive averaging over twelve strokes.
- **Uniform across strokes, not within one.** Everything here works on a single
  stroke. Handwriting that looks untidy is often uneven letter size, slant and
  baseline across a word. That is a different feature -- it moves strokes
  relative to each other -- and needs its own design.
- **Measured on real writing.** Every number above is synthetic. The hook
  thresholds (140 degrees, 4px) in particular were set against constructed
  strokes and a 1's flag; they want checking against real stylus input on the
  tablet before anyone tunes them further.

## 17. Discoverability and compliance: what was deliberately left (2026-09-20)

From `docs/superpowers/plans/2026-09-20-discoverability-and-compliance.md`.
Both halves of it landed on the same day, so both lists live here together.

**SEO (Part I)**

- **`/write` load cost.** 52 script tags, ~3.5 MB of JS. The Core Web Vitals
  work in the plan covers the three marketing pages only. The editor needs its
  own plan, and item 1 above is the first half of it.
- **`templates/home-classic.html` is dead** -- no route renders it. Delete it.
- **HSTS `preload`.** The header ships `max-age` and `includeSubDomains` but
  not `preload`; submitting to hstspreload.org is a commitment that is hard to
  undo, so it is a decision, not a task.
- **Guide pages** (`/guides/<slug>`) are Tier 3 of
  `docs/seo/backlink-strategy.md`. Each new page must be added to
  `SITEMAP_ROUTES` or the coverage test in `tests/test_seo.py` fails -- which
  is the intended behaviour.

**Legal and privacy (Part II)**

- **GA4 or a cookieless counter -- still undecided, and it is the decision that
  governs all the others.** The plan's Part II opening makes the case: dropping
  GA4 for a self-hosted aggregate counter (Plausible CE, Umami, or ~40 lines of
  Flask) ends the consent requirement, the US-transfer question and the
  DPDP/COPPA child-tracking question at once, and shrinks the banner to a
  footer link. Everything built for consent works either way; this is not
  blocked on code.
- **The EULA trigger.** Not applicable today -- there is no downloadable
  client. The day one ships, it becomes applicable.
- **WCAG 2.1 AA.** Whatever the axe gate could not be made to pass stays on the
  list, with the reason, rather than being marked done.
- **Two monthly chores.** `pip-audit -r requirements.txt` (PyMuPDF and Pillow
  are the advisories that matter here -- both parse attacker-supplied files),
  and `python tools/prune_consent_log.py`, which expires consent records past
  24 months and re-chains the survivors so `tools/verify_consent_log.py` still
  reports the chain intact.
- **Re-read the legal documents in a year**, or sooner on any trigger listed in
  `docs/legal/README.md`. They are drafts written to be reviewed by a lawyer
  qualified in India with EU/UK exposure, and they should not go live unread.

**Three things that came out of doing the work**

- **The fonts are still Google's.** `tools/vendor_fonts.py` is written and
  ready: it fetches both families' CSS with a modern-Chrome User-Agent, pulls
  every woff2 into `static/fonts/` and writes `static/css/fonts.css` with the
  `unicode-range` values carried over. It could not be run here -- this machine
  has no outbound network -- so `fonts.googleapis.com` is still in `style-src`
  and every visitor's IP still reaches Google on every page load, which is the
  one flow in the plan that needs no consent to remove. Run the tool on a
  networked machine, then make the three edits it prints.
- **The share card is generated, and it is a real screenshot.**
  `static/img/og-cover.png`, 1200x630, 27 KB, made by `tools/make_og_image.py`
  from the live homepage. Regenerate it whenever the hero changes. The tool
  pre-answers the consent banner in `localStorage` before the screenshot --
  without that the banner covers the bottom third of the card.
- **`consent_log.verify` returns `(ok, checked)`, not a bool.** Every caller in
  the tools unpacks it; a bare `assert consent_log.verify(path)` would pass on
  a broken chain, because a 2-tuple is truthy.

- **`test_ink_smoothing.py::test_lift_smoothing_is_cheap` is a marginal budget,
  not a regression (measured 2026-09-20).** It failed the full suite at 2.30ms
  and an isolated re-run at 2.10ms against a 2.0ms ceiling. Five trials each
  way put the median-of-medians at **1.80ms with this session's consent scripts
  on the page and 2.00ms with them blocked** -- blocking them made it *slower*,
  so the page's extra DOM and two scripts are not the cause, and nothing here
  touched `ink-smooth.js`. The real spread is 1.5-2.4ms per run, straddling the
  ceiling, and `performance.now()` is clamped to 0.1ms buckets. This is the same
  shape as `test_capturing_a_full_page_is_cheap`, whose budget was raised 16 to
  22 for exactly this reason. Either raise the ceiling to ~2.6ms or measure the
  minimum of the 20 samples instead of the median -- the minimum is the least
  noisy estimate of the true cost. Left alone here: changing a perf gate is the
  owner's call, not a passing change.

- **Browser tests are contention-sensitive; run the suite, not batches
  (measured 2026-09-20).** Three separate parallel batches each failed a
  *different* timing test, and every one passed alone and in a clean full run:
  `test_lift_smoothing_is_cheap` (a 2.0ms budget), `test_render_latency`'s
  same-frame assertion, `test_file_ribbon`'s save-and-reload, and
  `test_tool_panel_close`'s 8s `page.goto` on /write. Each module launches its
  own Chromium and its own server, so six at once is six browsers.
  The `page.goto` ceiling is the one worth raising: /write reaches
  `domcontentloaded` in a **725ms median** on an idle machine, so 8s is not
  generous, it is simply far from the failure mode -- until the machine is
  loaded, when it is not. Either run `pytest tests/` whole, or raise that
  timeout to ~20s.

---

## 18. Production-readiness pass (2026-09-21)

An audit against a launch checklist: privacy, secrets, HTTPS, consent, SEO,
social card, favicon, sitemap, robots, alt text, images, performance,
contrast, mobile, 404, links, forms, anti-abuse, analytics, CTA. Most of it
was already done and in good shape; what follows is only what changed, plus
what was found and deliberately left.

### Landed

- **The fonts are self-hosted.** `tools/vendor_fonts.py` finally ran. 9 woff2
  subsets, 143 KB in `static/fonts/`, of which a latin-only visitor fetches
  about 66 KB; `static/css/fonts.css` keeps every `unicode-range`;
  `static/fonts/OFL.txt` carries both families' licences verbatim.
  `fonts.googleapis.com` is out of `style-src` and `fonts.gstatic.com` out of
  `font-src`. **A first visit now makes no request to any Google origin** --
  `tests/test_consent.py` asserts it in a real browser with no carve-out.
  Two bugs in the tool surfaced on its first real run and are fixed: `_BLOCK_RE`
  was used but never defined (so it had never run at all), and `fetch()` used
  urllib's default TLS, which fails behind antivirus HTTPS interception -- it
  now falls back to `curl`, which verifies the chain with its own CA bundle
  rather than switching verification off.

- **Two unbounded caches keyed by a caller-supplied video id.** `/api/youtube/frame`
  accepts any 11 characters matching `[A-Za-z0-9_-]` and takes the video's lock
  *before* it resolves anything, so ids that are not real videos still left
  entries behind: `_YOUTUBE_VIDEO_LOCKS` was a `defaultdict` that grew forever.
  `YOUTUBE_STREAM_CACHE` had no ceiling either, and each entry owns a
  kept-alive socket. Both are now LRU-capped at 256; eviction skips a lock that
  is currently held (dropping it would hand the next caller a different lock and
  let two captures seek down one connection) and closes the socket it drops.

- **A ceiling on frame decoding.** Cutting a frame is the most expensive thing
  the server does and nothing authenticates the caller. `YOUTUBE_FRAME_CONCURRENCY`
  (3) caps how many run at once; `/prepare` declines when busy, `/frame` falls
  through to the storyboard, so a loaded server still answers. **Global, not
  per-IP, on purpose:** a per-IP budget means keeping a table of who asked for
  what, which is the trade `/api/consent` already refuses.

- **404.html used the design system for the first time.** It loaded only its
  own stylesheet, so `--accent`, `--accent-wash`, `--r-sm/-md/-lg/-pill`,
  `--s4` and `--ink-2` all resolved to nothing -- and `not-found.css` declared
  `--accent: var(--accent)`, which is self-referential and computes to the
  guaranteed-invalid value. The primary CTA fell back to a hard-coded blue
  gradient with square corners, in Segoe UI, at **4.19 : 1** against the top of
  its gradient: an AA failure on the one page people reach by accident. It now
  loads `fonts.css` and `tokens.css` first like every other page and wears the
  brand primary button at 7.74 : 1.

- **The editor footer, at the size of the tablet this is for.** `<footer>` was
  `width: 100%` plus 20px padding in content-box, so it measured 1000px in a
  960px viewport and the last 20px of *Do Not Sell or Share My Personal
  Information* sat off the right edge -- with no scrollbar, because the
  overflow was off-screen rather than in flow. And `opacity: 0.4` on `<footer>`
  dimmed `.editor-legal` along with the decorative credit: the privacy, cookie,
  terms and CCPA links asked for `--ink-2` (7.70 : 1) and rendered at
  **1.89 : 1** at 12px. The 0.4 now sits on `footer .left`, so the credit stays
  as quiet as it was designed to be and the legal row does not.

- **pdf.min.js (312 KB) is loaded on demand**, the same bargain `pdf-export.js`
  already makes for pdf-lib and the worker has always made. `pdfjsLib` was
  referenced in exactly one place, so this was isolated. `/write` went from
  **2.14 MB / 557 KB gzipped / 69 requests to 1.83 MB / 470 KB / 68** -- 16%
  off the transfer for every visitor who does not open a PDF. The caller
  already shows a loading state before this point, so there is no new gap.

- **`/api/consent` could write megabytes per request into the audit log.** It
  validated `analytics` and `version` but wrote `id` and `source` verbatim,
  under the global `MAX_CONTENT_LENGTH` of 120 MB (sized for slide decks), so
  one POST could fsync ~120 MB into `data/consent-log.jsonl` -- the docstring's
  "worst a flood can do is grow a file of anonymous rows" assumed the rows were
  small. Bodies over `CONSENT_MAX_BODY_BYTES` (1 KB; a real one is ~120 bytes)
  now get 413 before parsing; `id` must be a printable string of 64 characters
  or fewer (or absent), `source` a printable string of 32 or fewer, and
  `version: true` is refused (`bool` is a subclass of `int`). Still no IP, still
  no rate limit -- the privacy trade the endpoint makes is unchanged.

- **`templates/home-classic.html` deleted** (item 17 above; no route rendered it).

- **XSS, checked and clean.** The two attacker-influenced paths are YouTube
  search results (anyone can title a video `<img onerror=...>`) and notebook
  names from an imported `.inky` file (which can come from someone else).
  Every YouTube field goes through `escapeHtml` in `youtube.js`, which covers
  `& < > " '`; notebook names reach the DOM only through `textContent` and
  `setAttribute` in `library.js`. Nothing changed.

### Tests added

`test_seo.py` four, `test_analytics_csp.py` one, `test_youtube_capture.py` six
(`ResourceCeilingTests`), `test_consent_log.py` four, `test_accessibility.py`
four plus three pages added
to the axe list (`/legal/cookies`, `/legal/terms`, `/no-such-page` -- the 404
had never been audited, and it was the page with the defect).

Two of those are worth knowing about:

- `TokenVocabularyTests` enforces the DESIGN.md rule directly: no stylesheet
  may declare a custom property as itself, and every page must load
  `tokens.css` before its own styles. It strips CSS comments first -- the note
  in `not-found.css` explaining the bug quotes the broken line, and the first
  draft reported the explanation as the defect.
- `TabletFooterTests` measures the footer at 960x600. Its first draft **passed
  against the bug**, because it read `.editor-legal`'s own computed opacity,
  which stays 1 while an ancestor at 0.4 halves what reaches the screen.
  Opacity composites, it does not inherit; the test now multiplies up the
  ancestor chain. Both tests were re-run against a deliberately reverted
  stylesheet to confirm they go red.

### Found and deliberately left

- **Touch targets in the marketing nav are 36-38px**, against the `--tap: 44px`
  the design system defines as "the smallest thing a finger can reliably hit":
  the theme toggle (36x36), the nav links (37px tall), the editor's `↖` and `✎`
  (38x38). Not a WCAG 2.1 AA failure -- target size is 2.5.5, which is AAA --
  and axe passes, but the system contradicts itself here. 27 controls are under
  44px on the homepage at 960px; most are links in running prose, where it does
  not matter. The handful of chrome controls do.
- **`.backup-20260904-161513/` still holds an old `write.html` with an eager,
  ungated `gtag` tag.** Untracked, never served, and a GA4 measurement id is
  public by design, so this is not an exposure -- but anyone restoring from
  that backup reintroduces tracking-before-consent. The repo has git now; the
  directory is the old safety net. Deleting it is the owner's call.
- **`SECRET_KEY` falls back to `os.urandom(32).hex()`** when unset. Flask
  sessions, cookies and `flash` are not used anywhere, so nothing signs
  anything today and the risk is nil -- but the fallback means a future feature
  that *does* use the session silently gets per-worker keys under Gunicorn. A
  fail-fast when unset in production is one line, and was left because it
  changes deployment behaviour.
- **The remaining 53 scripts on `/write`.** Item 1 above is still the plan.
  What was done here was the one file that could be moved without touching
  load order; the rest need the dependency map that item 1 describes.
- **`og-cover.png` is a screenshot of the homepage.** It works and it is
  honest, but a purpose-drawn card would read better at thumbnail size. Not
  changed, because the current one is not wrong.

---

## 19. Tool panels and shape assist: what was left (2026-09-21)

DESIGN.md's decision log (five rows dated 2026-09-21) has what changed and why:
Shape assist became Off / Straight / Exact; tool panels got one owner at every
width, a body-level layer and the shared free area; floating surfaces became
mutually exclusive; panel controls moved onto `--tap`. Regression tests are in
`tests/test_tool_panel_layout.py` (new) and `tests/test_write_assist.py`.

- **"Assisted as it is drawn" was read as "true to the drawing", not "live".**
  The request said step 3 is "the max assist where the shape will be assisted
  as it is drawn", then "in step 3 you assist whatever the exact drawing
  tells". Exact does the second. If the first meant a live preview while the
  pen is still down -- the "draw and hold" snap other apps have -- it is not
  built. It would run recognition on the pen's hot path, which renders at
  digitizer rate (see the live-ink frame budget note in memory), so it wants
  a dwell timer that fires once per pause rather than per sample, and a
  measurement on the target tablet first.
- **Straight is generous by design.** A four-cornered outline whose corners
  are within 22° of square on average becomes a rectangle or square, even if
  it was drawn quite loosely; a deliberate rhombus (60/120) stays a rhombus.
  If real use shows Straight catching shapes meant to stay irregular, the one
  number to move is `INTENT.straight.rightAngleMean` in `ink-recognize.js`.
- **Not tried on the device.** Everything was measured in headless Chromium
  and the preview pane at 960x600, 390x844 and 1440x900. A pen on the budget
  Android tablet has not drawn a single shape through the new recogniser.
- **`test_lift_smoothing_is_cheap`** is unchanged by this work and still the
  one known timing failure (item 18, CLAUDE.md).

---

## 20. Version 2: what was left (2026-11-15)

`CHANGELOG.md` has what shipped and `docs/V2-REVIEW.md` has the review and the
measurements. Item 17's open decision is closed: **GA4 is gone**, and with it
the banner, the audit chain and both monthly consent chores.

- **The privacy contact is still a placeholder.** `/legal/privacy` says so in
  bold. It must be a monitored address before the site is public, and the
  three legal pages are still drafts that want a lawyer's read.
- **Not tried on the device.** The new two-bar chrome, the offline shell and
  the Blueprint colours were all measured in desktop Chromium at 960x600,
  768x1024 and 375x812. A pen on the budget Android tablet has not touched v2.
- **The offline shell precaches about 4.4 MB** (95 files) in the background
  after first load, six requests at a time. Fine on Wi-Fi; on a metered
  connection it is the whole app paid for up front. Item 1 (load features on
  demand) would let it precache the core and fetch the rest on first use.
- **Things that still need a connection:** PDF and PowerPoint *server*
  conversion, YouTube, and AR Inky (its hand-tracking model comes from
  cdn.jsdelivr.net). Vendoring the AR model would make it offline too.
- **55 script tags on `/write`**, 624 KB transferred. Still item 1.
- **Feature palettes are aliased, not deleted.** `--tour-*`, `--ribbon-*` and
  `--planner-*` now point at the core tokens. Replacing the aliases with the
  tokens themselves is mechanical and was left out to keep the diff reviewable.
- **Light-mode screenshots for the share card.** `static/img/og-cover.png` was
  regenerated in the dark Blueprint look; there is no light variant.
- **Existing visitors keep their saved canvas ground** (Graphite for most).
  Only new visitors get Blueprint by default. That is deliberate: a saved
  preference is theirs.
- **Modal sheets still cover what is under them**, by definition: Help,
  Pomodoro, Planner, My Notebooks and the Clear confirm all dim the page and
  sit over the bars. Non-modal surfaces (tool panels, the File sheet, the
  canvas popover, the player, the page switcher) no longer overlap anything.
- **`test_lift_smoothing_is_cheap`** is unchanged and still the one marginal
  timing budget (items 17 and 18).
