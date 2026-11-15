# Render latency: raw input, dirty-rect frames, non-blocking rebuilds

**Date:** 2026-09-13. **Status:** implemented 2026-09-14 following
`docs/superpowers/plans/2026-09-13-render-latency.md`, with the amendments recorded in
4.1a, 4.4a and 4.5a. Full suite 218 passed, 0 failed. Results: TODOS.md item 12.

## 1. Goal

Remove the latency Inkyscib's own code adds between a pen sample and the pixels
that show it, and make sure no rebuild of the committed layer blocks input on a
heavy page. Digitiser, operating system and display refresh are out of reach.

Settled frames must stay **pixel-identical** to what a full rebuild draws today.
Two transient differences are approved: a soft or edge-blank view while a rebuild
is still running on a heavy page (§4.3), and dragged strokes drawn above other ink
during a selection drag (§4.5).

## 2. Measured starting point

Headless Chromium 151, 1920x1200 canvas (960x600 CSS px at DPR 2). "Raw" is JS
plus draw-command recording; "readback" adds a 1px readback to force raster.

| Stage | 1x CPU | 4x CPU throttle |
|---|---|---|
| Live-stroke, blit-pan, idle frame (raw) | 0.2-0.3 ms, flat | 1.2-1.6 ms, flat |
| Same frames with readback | 3.5-3.7 ms | 14-17 ms |
| Full rebuild, 200 / 1000 / 3000 strokes (raw) | 11 / 46 / 135 ms | 48 / 426 / 679 ms |
| Pen lift after TODOS.md item 11 (raw) | 0.4-0.5 ms | 1.8-3.6 ms |

`pointermove` reaches the page after `pointerrawupdate` carrying the same sample
(matched by `timeStamp`): median **10.7 ms** for the mouse and **13.0 ms** for
touch, p90 12.4 / 14.4 ms, max 23.8 / 16.6 ms. The wait from `pointermove` to the
animation frame that draws it is ~0.2 ms, so the hold-back is the whole cost.

Still O(document) today: the sharp rebuild 140 ms after the last blitted frame, a
blit that no longer covers the canvas (fast pan), zoom past `__BLIT_MAX_ZOOM`
(1.6), every frame of a selection drag or marquee, the partial eraser, write-assist
revert, undo and redo.

## 3. Constraints

- Vanilla JS, classic scripts, no build step. Match `canvas.js` / `events.js` idiom.
- Pixel identity is checked by exact channel comparison. Skia is deterministic for
  identical draw-command sequences; clip rectangles are integer device pixels so
  clipping adds no antialiasing.
- A path changed in place must invalidate the cache or be replaced by a new object
  (already true for every cached frame). Undo snapshots are JSON clones.
- Test seams follow `window.__inkyscibSetRenderMinSpacing`: a `window.__inkyscib*`
  setter, off by default in production behaviour terms.
- Browser tests follow CLAUDE.md: dismiss the tour, arrow-function predicates,
  `make_browser_server`.

## 4. Work packages

### 4.1 P1 - Repaint only the changed rectangle while writing

In `__paintDrawingLayer`, before the normal paint, a fast path runs when **all** of:

- the previous frame painted the same `currentPath` object while drawing, with the
  same canvas size, pixel ratio and transform, and the committed layer has not been
  rebuilt, appended to, repaired or swapped since (a layer revision counter);
- the live path is `pen` with style `default`, `brush` or `fountain`, or
  `highlight`; gel and calligraphy fall back (glow and smoothing reach further back);
- there is no selection action, eraser lasso, `handPath` or `clearAnimation`;
- the stroke only grew or had its last point replaced: `appendInkPoint` never
  touches earlier points, checked by the identity of `points[0]` and of the point
  at the previous frame's second-to-last index;
- for brush and fountain, the wet cache was already in use last frame and will not
  reset this frame (`__liveStrokeCacheIsCurrent` and `cached <= loopEnd`), because
  a reset re-quantises the whole prefix.

The rectangle is the world bounds of the points from `previousCount - tail` to the
end, with `tail` 3 for default and highlighter and `__WET_TAIL + 3` for brush and
fountain, expanded by `max(8, size * 2)` world units, mapped to device pixels,
floored and ceiled outward by 2 px and clipped to the canvas. Inside a clip of that
rectangle the frame clears, draws the committed layer, the live stroke and the
overlays exactly as the full path does. Outside it nothing changed.

A seam `window.__inkyscibSetDirtyRectFrames(enabled)` turns the fast path off so a
test can render the same state as a full frame.

**Tests:** a sample-by-sample 170-point stroke at a zoomed, panned view, checked
every 25 samples against a full frame of the same state, for default, brush,
fountain and highlighter. Brush and fountain frames drawn from the wet cache must
match exactly. A stroke drawn as one path cannot (4.1a), so for those the check
tells rounding from a stale segment by shape: at most 40 pixels whose alpha moved
by 32 or more, and no cluster of more than 16 of them touching. The stroke is drawn
twice per nib - steady, 4.5 world units between samples, and fast, 13 apart, where
the margin around the newest point no longer covers the changed segments. A fast
frame with readback costs at most a third
of a full frame on a 1920x1200 canvas. Mutations: tail 0, no `clearRect`, a brush
tail without the taper span, and no tail rectangle at all.

#### 4.1a Found while building it

**Skia rasterises a path relative to its own bounds,** so appending a point moves
antialiased edge pixels anywhere along the path. One added point changed 15
channels near the start of a 25-point stroke - identically on a CPU canvas, a GPU
canvas, a `desynchronized` one and in the app's own full frames. Full frames
already shimmer that much from one frame to the next; a tail frame keeps the older
pixels instead. Measured per checkpoint, across every nib on a steady and a fast
stroke: at most 25 pixels with an alpha change of 32 or more, in touching clusters
of at most 8. A tail that was too short left clusters of 90-461 such pixels, or 64
scattered ones on a thin fountain taper. Horizontal runs did not separate the two
(3 either way on a steady stroke), and repainting full-width rows instead of the
tail rectangle did not remove the drift, so it is not scanline coupling. Settled
frames are unaffected: once the pen lifts, the frame is painted in full from the
exact committed layer.

**Brush and fountain need the longer tail** this section specified. Their width
tapers over the last points (`remaining` in `__penSegmentWidth`) and each segment
blends its width with the next, so a new point re-widens several segments. With a
3-point tail, frames below the wet-cache threshold left stale segments (alpha
moves of up to 223 in runs of 19); with `__WET_TAIL + 3` they drift like the
default nib.

### 4.2 P2 - Draw from `pointerrawupdate`

`events.js` listens for `pointerrawupdate` on the canvas when
`'onpointerrawupdate' in window`. The handler acts only while drawing a `pen` or
`highlight` path, with no pan, pinch or eraser hold in progress. It feeds the
event's coalesced samples through the same code `continueDrawing` uses, then paints
at once with `renderNow()` (cheap because of P1).

Samples are consumed once: the path records the `timeStamp` of the last sample it
took, and `continueDrawing` skips samples at or before it. So whichever event
arrives first wins, the smoothing filter sees each sample exactly once and in order,
and browsers without the event keep today's path unchanged. A seam
`window.__inkyscibSetRawInput(enabled)` disables the listener's effect.

**Tests:** a stroke drawn with raw input records each sample once (unique, strictly
increasing times, same count as with raw input off). For most samples a render
happens after `pointerrawupdate` and before the matching `pointermove`. Mutations:
no de-duplication, and `requestRedraw` instead of an immediate paint.

### 4.3 P3 - Build sharp layers in slices

A second bitmap, `__pendingLayer`, is built at a target transform a slice at a time:
visible paths in document order until `performance.now()` passes a 5 ms deadline,
always at least one path per slice. When it reaches the end of `state.paths` the two
bitmaps swap and the frame draws from the new one.

- **Starts** when the sharp-rebuild timer fires (instead of invalidating), and when a
  frame's blit fails coverage or the zoom cap.
- **Progresses** in the same frame it starts, so a light page finishes at once and
  looks exactly like today; otherwise it requests another frame.
- **While running,** a frame whose normal blit fails draws a loose blit - the same
  mapping without the coverage and zoom checks - so the view is soft or has blank
  borders instead of freezing.
- **Keeps going** if its target can still serve the current transform; otherwise it
  restarts at the current transform.
- **A pen lift** goes into the committed layer as now; the pending build walks
  `state.paths` live, so it picks the new path up. Any non-append content change,
  a resize, or `invalidateCanvasDrawingCache()` cancels it.
- With no committed layer at all, the rebuild stays synchronous.

**Tests:** on a heavy page, a view jump past coverage renders in several frames, none
over a third of a synchronous rebuild, and the final frame equals a synchronous
rebuild exactly. A light page finishes in one frame. A pen lift during the build is
in the final frame. The post-gesture sharp rebuild ends pixel-identical to a
rebuild at that zoom. Mutations: no deadline, and swapping before the end.

### 4.4 P4 - Repair only the changed region

When the committed content is stale but not a pure append, compare the cached and
current path lists by identity. Repair is used when:

- the paths present in both lists are in the same relative order;
- something was removed or added, and every changed path has finite render bounds;
- the union of the changed paths' `__pathRenderBounds`, in layer device pixels
  (integer, 2 px margin), covers under 40% of the layer.

Inside a clip of that rectangle the layer is cleared and every current path that
touches it is redrawn in document order (non-cullable tools always). Otherwise the
full rebuild runs as today. Undo and redo replace every object, so they rebuild.

**Tests:** erasing through a stroke that crosses other ink and a never-culled line
on a 2000-stroke page: the frame right after is right in shape (no cluster of more
than 16 strongly changed pixels, at most 40 of them) and the layer is exact once its
copy is swapped in. A dab over one glyph costs under a third of a rebuild and
settles exact. A reorder alongside an erase still matches a rebuild immediately, on
a page too heavy for the copy to finish in one frame. Mutations: no clear, redrawing
only the added paths, no stacking check, and repair disabled.

#### 4.4a Found while building it

**A partial redraw cannot be bit-exact.** Drawing one stroke with a rectangle clip
changed 121 of 962 inked pixels inside the rectangle compared with drawing it
unclipped (worst alpha 35). Drawing the region unclipped into a scratch canvas
offset by whole pixels, and copying it back, was no better at any margin up to
64 px. So a repair is right to the eye but not bit for bit: an exact copy of the
layer is built behind every repair, in slices (4.3's mechanism), and swapped in -
within the same frame on a light page. Settled frames are exact; the frame right
after an erase is not.

**A repair has a fixed cost per page.** It walks every path once to find what
touches the region, and diffs the path lists by identity: about 10 ms on a
2000-path page at full CPU speed, whatever the region's size. Measured: a dab over
one glyph (20 paths redrawn) 15.5 ms against a 76 ms rebuild; the test's long erase
(265 paths redrawn) 28 ms against 69 ms. A spatial index would remove the walk; not
done.

**Light pages rebuild instead.** Below 200 paths a rebuild takes a few milliseconds
(about 35 us a path at full CPU speed) and is exact at once, so a repair gains
nothing. It also made a light page's exactness depend on timing: the exact copy
was meant to finish inside the repair's frame, but sizing the pending canvas the
first time took 3.3-4.6 ms of the 5 ms slice, and in one of three runs the copy
walked 1 of 7 paths and the frame showed the approximate repair. Selection drags
follow the same rule.

### 4.5 P5 - Selection drag

- **Marquee** frames change no content, so they no longer force a rebuild.
- **Drags** no longer force one either. The forced rebuild existed because selection
  was understood to mutate paths in place; it does not. `applyAction` in
  `tools/select.js` clones every dragged path from its drag-start original and
  assigns the clone back, for move, resize and rotate alike, and only `select.js`
  sets `selection.action`. So each drag frame is an ordinary content change, and
  4.4's region repair keeps the layer current - with the dragged paths in their
  proper stacking order, and exact once the copy behind the last repair lands.
- Pages under 200 paths, and repairs refused for size, rebuild as before.

**Tests:** dragging a selected stroke across a 2000-stroke page: drag frames under a
fifth of a rebuild, nothing left where the stroke started, the stroke drawn where it
is, and the layer exact once settled after the drop. A marquee's frames under a
fifth of a rebuild. Mutations: selection frames forcing a rebuild, drag frames not
repaired, and the repaired region not cleared.

#### 4.5a Found while building it

The first implementation took the dragged paths out of the layer once and drew them
live on top, assuming in-place mutation. Its tests passed, but two of its mutation
checks - leaving the dragged paths in the layer, and not drawing them live - passed
too. A trace showed why: the dragged path was a new object after every one of 10
moves, so every frame went through region repair and the exclusion was never used.
It was removed, and the approved transient of dragged strokes drawn above other ink
went with it.

## 5. Order and verification

P1, P2, P3, P4, P5. For each: failing test first, implementation, mutation checks,
the canvas and render test files green. The full suite after P2 (it touches
`events.js`) and at the end. The benchmark gains raw-input hold-back, dirty-rect
frame, pan-end worst frame, erase repair and drag frame rows. Results go to TODOS.md
and memory.

## 6. Not verified here

- Whether earlier drawing reaches the tablet's glass sooner: only the in-browser
  hold-back is measurable headless. Drawing outside the animation frame relies on the
  canvas being `desynchronized`.
- Real GPU compositing cost; headless compositing is software.
- Out of scope: smart-geometry and tile drags (they invalidate themselves), undo and
  redo rebuild cost, gel and calligraphy dirty rectangles, load time.
