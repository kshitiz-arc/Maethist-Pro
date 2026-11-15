# Render Latency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut the latency `/write` adds between a pen sample and its pixels, and stop any committed-layer rebuild from blocking input.

**Architecture:** Five packages inside the existing render path. `static/js/canvas.js` gains tail-rectangle frames, a sliced second layer that swaps in when complete, region repair keyed on path identity, and a drag exclusion. `static/js/events.js` gains a `pointerrawupdate` path with timestamp de-duplication. Every settled frame keeps issuing the same draw commands as a full rebuild, so tests compare exact pixels.

**Tech Stack:** Vanilla JS classic scripts, Canvas 2D, Flask, pytest + Playwright (bundled Chromium 151).

**Spec:** `docs/superpowers/specs/2026-09-13-render-latency-design.md`

## Global Constraints

- Not a git repository: there are no commits. Each task ends by running its test files instead.
- Run tests from the repo root: `python -m pytest tests/<file> -q --show-capture=no`.
- Do not edit files while a test run is in progress: the in-process Flask server reads `static/` from disk.
- Browser tests: dismiss the tour with `localStorage['inkyscib-feature-tour-v1']` in `add_init_script`; start the server with `make_browser_server(app)` from `tests/browser_server.py`; pass `wait_for_function` an arrow function.
- Settled frames must be pixel-identical to a full rebuild: exact channel comparison, `differing == 0`.
- Test seams are `window.__inkyscib*` setters, like the existing `window.__inkyscibSetRenderMinSpacing`.
- Script-scoped `let`/`const` in `canvas.js` (for example `__pendingMeta`) are readable by name from `page.evaluate`, because classic scripts share the global lexical scope.
- Match file idiom: 4-space indentation in `canvas.js`, 2-space in `events.js`, comments explain why.
- Each task: failing test first, watch it fail for the stated reason, implement, pass, then the listed mutation checks (break the code, see the named test fail, restore).

---

### Task 1: Tail-rectangle frames (spec 4.1)

> **Amended during execution (2026-09-14).** Two findings, recorded in spec 4.1a,
> changed this task. (1) The exact-match identity test below cannot pass for a
> stroke drawn as one path: Skia's rounding moves edge pixels along the whole path
> when a point is added. `tests/test_render_latency.py` now checks exactness for
> wet-cached brush and fountain frames, and a rounding budget (at most 40 pixels with
> alpha moved 32+, no touching cluster of more than 16) for the rest, on a steady
> stroke 4.5 world units apart and a fast one 13 apart. (2) Brush and fountain without the wet cache take their tail
> from `length - __WET_TAIL - __TAIL_POINTS`, not `length - __TAIL_POINTS`, as the
> spec said. The file in the repo is authoritative where it differs from the code
> below.

**Files:**
- Modify: `static/js/canvas.js` (top-of-file layer state; `__rebuildCommittedLayer`; `__appendToCommittedLayer`; `__paintDrawingLayer`; new functions before `__paintDrawingLayer`)
- Create: `tests/test_render_latency.py`

**Interfaces:**
- Produces: `let __committedRevision` (incremented whenever committed-layer pixels change); `window.__inkyscibSetDirtyRectFrames(enabled)`; `__liveTailStyle(path)`, `__liveTailRect(state, canvas, ratio)`, `__rememberFrame(state, canvas, ratio)`; the test module's `HELPERS` (`window.__latency`) and `open_page(width, height, scale)`.

- [ ] **Step 1: Write the failing tests**

Create `tests/test_render_latency.py`:

```python
"""Latency work on the render path: tail frames, sliced rebuilds, region repair
and drag exclusion. See docs/superpowers/specs/2026-09-13-render-latency-design.md.

Every settled frame here has to be pixel-identical to a full rebuild, so the
tests compare exact channels inside the page and only counts cross the bridge.
"""

import threading
import unittest

from app import app
from browser_server import make_browser_server


try:
    from playwright.sync_api import sync_playwright

    PLAYWRIGHT_AVAILABLE = True
except ImportError:
    PLAYWRIGHT_AVAILABLE = False


HELPERS = """
window.__latency = {
  glyph(x0, y0) {
    const points = [];
    for (let i = 0; i < 40; i++) {
      const t = i / 39;
      points.push({
        x: x0 + 5 * Math.sin(t * Math.PI * 3) + t * 9,
        y: y0 + 7 * Math.cos(t * Math.PI * 2),
        pressure: 0.5, time: i * 8
      });
    }
    return { tool: 'pen', style: 'default', points, color: '#ffffff', size: 2 };
  },

  // Rows of handwriting starting at (left, top).
  seed(count, left = 20, top = 20, cols = 70, colStep = 14, rowStep = 20) {
    const state = window.appState;
    state.notebook.active = false;
    state.ppt.active = false;
    state.isDrawing = false;
    state.currentPath = null;
    state.transform = { scale: 1, offsetX: 0, offsetY: 0 };
    state.paths = [];
    for (let n = 0; n < count; n++) {
      state.paths.push(this.glyph(left + (n % cols) * colStep, top + Math.floor(n / cols) * rowStep));
    }
    window.invalidateCanvasDrawingCache();
  },

  snapshot() {
    const source = document.getElementById('drawingCanvas');
    const copy = document.createElement('canvas');
    copy.width = source.width;
    copy.height = source.height;
    const ctx = copy.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(source, 0, 0);
    const data = ctx.getImageData(0, 0, copy.width, copy.height).data;
    let inked = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] >= 8) inked++;
    return { width: copy.width, height: copy.height, data, inked };
  },

  compare(a, b) {
    if (a.width !== b.width || a.height !== b.height) return { differing: -1, worst: 255 };
    let differing = 0, worst = 0;
    for (let i = 0; i < a.data.length; i++) {
      const delta = Math.abs(a.data[i] - b.data[i]);
      if (!delta) continue;
      differing++;
      if (delta > worst) worst = delta;
    }
    return { differing, worst };
  },

  // Forces raster with a 1px readback, so a timing includes it.
  flush() {
    if (!this.probe) {
      this.probe = document.createElement('canvas');
      this.probe.width = this.probe.height = 1;
      this.probeCtx = this.probe.getContext('2d', { willReadFrequently: true });
    }
    this.probeCtx.drawImage(document.getElementById('drawingCanvas'), 0, 0, 1, 1, 0, 0, 1, 1);
    this.probeCtx.getImageData(0, 0, 1, 1);
  },

  time(fn) {
    const t0 = performance.now();
    fn();
    this.flush();
    return performance.now() - t0;
  },

  median(values) {
    return values.slice().sort((a, b) => a - b)[Math.floor(values.length / 2)];
  },

  // The reference: replay the whole document at the current transform.
  full() {
    window.invalidateCanvasDrawingCache();
    window.renderNow();
    return this.snapshot();
  }
};
"""


@unittest.skipUnless(PLAYWRIGHT_AVAILABLE, "Playwright is not installed")
class RenderLatencyBrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = make_browser_server(app)
        cls.server_thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.server_thread.start()
        cls.base_url = f"http://127.0.0.1:{cls.server.server_port}"
        cls.playwright = sync_playwright().start()
        cls.browser = cls.playwright.chromium.launch(headless=True)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()
        cls.server.shutdown()
        cls.server_thread.join(timeout=3)

    def open_page(self, width=1100, height=720, scale=1):
        context = self.browser.new_context(
            viewport={"width": width, "height": height}, device_scale_factor=scale
        )
        self.addCleanup(context.close)
        context.add_init_script(
            "localStorage.setItem('inkyscib-feature-tour-v1', JSON.stringify({seen: true}))"
        )
        page = context.new_page()
        page.goto(self.base_url + "/write", wait_until="domcontentloaded")
        page.wait_for_function("() => window.appState?.storageReady === true")
        page.evaluate(HELPERS)
        return page

    def test_a_tail_frame_matches_a_full_frame(self):
        """While a stroke is written only its tail is repainted. Checked every
        25 samples against a full frame of the same state, for each nib the
        fast path takes, at a zoomed, panned view."""
        page = self.open_page()
        result = page.evaluate(
            """
            () => {
              const L = window.__latency;
              const state = window.appState;
              L.seed(300);
              state.transform = { scale: 1.3, offsetX: -40, offsetY: 25 };
              window.renderNow();
              const nibs = [
                ['pen', 'default', '#ffffff', 3],
                ['pen', 'brush', '#ff8844', 5],
                ['pen', 'fountain', '#44ddff', 4],
                ['highlight', undefined, 'rgba(255,255,0,0.3)', 14]
              ];
              const out = {};
              for (const [tool, style, color, size] of nibs) {
                const live = { tool, style, color, size, points: [] };
                state.currentPath = live;
                state.isDrawing = true;
                let differing = 0, worst = 0, inked = 0;
                for (let i = 0; i < 300; i++) {
                  live.points.push({
                    x: 80 + i * 1.8, y: 260 + Math.sin(i / 11) * 90,
                    pressure: 0.45 + 0.4 * Math.sin(i / 7), time: i * 8
                  });
                  window.renderNow();
                  if (i % 25 === 24) {
                    const tail = L.snapshot();
                    window.__inkyscibSetDirtyRectFrames(false);
                    window.renderNow();
                    const full = L.snapshot();
                    window.__inkyscibSetDirtyRectFrames(true);
                    const c = L.compare(tail, full);
                    differing += c.differing;
                    worst = Math.max(worst, c.worst);
                    inked = full.inked;
                  }
                }
                state.isDrawing = false;
                state.currentPath = null;
                window.renderNow();
                out[style || tool] = { differing, worst, inked };
              }
              return out;
            }
            """
        )

        for nib, row in result.items():
            self.assertGreater(row["inked"], 0, f"{nib}: nothing drawn")
            self.assertEqual(
                row["differing"], 0,
                f"{nib}: a tail frame differs from a full frame in {row['differing']} "
                f"channels (worst {row['worst']}/255)",
            )

    def test_a_tail_frame_costs_a_fraction_of_a_full_frame(self):
        """A 1920x1200 frame spends most of its time clearing and compositing
        the whole canvas; a tail frame should not."""
        page = self.open_page(width=960, height=600, scale=2)
        result = page.evaluate(
            """
            () => {
              const L = window.__latency;
              const state = window.appState;
              L.seed(200);
              window.renderNow();
              L.flush();
              const out = {};
              for (const style of ['default', 'brush']) {
                const live = { tool: 'pen', style, color: '#ffffff', size: 3, points: [] };
                state.currentPath = live;
                state.isDrawing = true;
                const tail = [], full = [];
                for (let i = 0; i < 240; i++) {
                  live.points.push({ x: 60 + i * 3, y: 300 + Math.sin(i / 9) * 60, pressure: 0.5, time: i * 8 });
                  if (i < 120 || i % 2) {
                    const ms = L.time(() => window.renderNow());
                    if (i >= 120) tail.push(ms);
                    continue;
                  }
                  window.__inkyscibSetDirtyRectFrames(false);
                  full.push(L.time(() => window.renderNow()));
                  window.__inkyscibSetDirtyRectFrames(true);
                  window.renderNow();
                  L.flush();
                }
                state.isDrawing = false;
                state.currentPath = null;
                out[style] = { tail: L.median(tail), full: L.median(full) };
              }
              return out;
            }
            """
        )

        for style, row in result.items():
            self.assertLess(
                row["tail"], row["full"] / 3,
                f"{style}: a tail frame took {row['tail']:.2f} ms against "
                f"{row['full']:.2f} ms for a full frame",
            )


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `python -m pytest tests/test_render_latency.py -q --show-capture=no`
Expected: both FAIL with `TypeError: window.__inkyscibSetDirtyRectFrames is not a function`. That is a missing-feature failure, not a typo.

- [ ] **Step 3: Implement**

In `static/js/canvas.js`, after `let __committedLayerMeta = null;` add:

```js
// Bumped whenever the committed layer's pixels change, so a frame can tell
// whether the layer under it is the one the previous frame drew.
let __committedRevision = 0;
```

In `__rebuildCommittedLayer`, directly before `return true;` add `__committedRevision++;`. In `__appendToCommittedLayer`, directly before `return true;` add `__committedRevision++;`.

Before `function __paintDrawingLayer` add:

```js
// ---------------------------------------------------------------------------
// Tail frames
//
// While a stroke is being written, the only pixels that differ from the last
// frame are around its last few points: `appendInkPoint` only ever adds a
// point or rewrites the final one, and the committed layer under it has not
// changed. Clearing and repainting the whole canvas for that is most of a live
// frame - 3.6 ms of it at 1920x1200 when raster is forced. So when nothing else
// changed, the frame is painted inside a clip around the tail. Inside the clip
// it issues exactly the commands a full frame would; outside it the previous
// frame's pixels are already right.
//
// Gel and calligraphy are left out: glow and smoothing reach further back along
// the stroke than a few points.
const __TAIL_POINTS = 3;
let __tailFrames = true;
let __lastFrame = null;

// Test seam: off paints every frame in full, so a tail frame can be compared.
window.__inkyscibSetDirtyRectFrames = (enabled) => {
    __tailFrames = enabled !== false;
    __lastFrame = null;
};

function __liveTailStyle(path) {
    if (path?.tool === 'highlight') return 'highlight';
    if (path?.tool !== 'pen') return null;
    const style = path.penStyle || path.style || 'default';
    return style === 'default' || style === 'brush' || style === 'fountain' ? style : null;
}

// The device-pixel rectangle that can differ from the previous frame, or null
// when this frame has to be painted in full.
function __liveTailRect(state, canvas, ratio) {
    const last = __lastFrame;
    const path = state.currentPath;
    if (!__tailFrames || !last || !state.isDrawing || !path || last.path !== path) return null;
    if (last.revision !== __committedRevision ||
        last.width !== canvas.width ||
        last.height !== canvas.height ||
        last.ratio !== ratio ||
        !__sameTransform(last, state.transform)) {
        return null;
    }
    if (state.handPath || state.clearAnimation || state.selection?.action) return null;

    const style = __liveTailStyle(path);
    const points = path.points || [];
    if (!style || points.length < 2 || points.length < last.count || points[0] !== last.first) return null;
    if (last.count >= 2 && points[last.count - 2] !== last.beforeLast) return null;

    const transform = state.transform;
    const deviceScale = transform.scale * ratio;
    // Brush and fountain draw a decimated copy, and their wet cache counts in
    // it, so their tail is taken from that copy.
    const tail = style === 'brush' || style === 'fountain'
        ? __decimateForRender(points, __renderMinSpacing / Math.abs(deviceScale)).slice(Math.max(0, last.tailFrom))
        : points.slice(Math.max(0, last.count - __TAIL_POINTS));
    const bounds = __boundsFromPoints(tail, Math.max(8, (path.size || 2) * 2));
    if (!bounds) return null;

    const left = Math.max(0, Math.floor(bounds.left * deviceScale + transform.offsetX * ratio) - 2);
    const top = Math.max(0, Math.floor(bounds.top * deviceScale + transform.offsetY * ratio) - 2);
    const right = Math.min(canvas.width, Math.ceil(bounds.right * deviceScale + transform.offsetX * ratio) + 2);
    const bottom = Math.min(canvas.height, Math.ceil(bounds.bottom * deviceScale + transform.offsetY * ratio) + 2);
    return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

function __rememberFrame(state, canvas, ratio) {
    const path = state.isDrawing ? state.currentPath : null;
    const points = path?.points || [];
    const style = __liveTailStyle(path);
    let tailFrom = points.length - __TAIL_POINTS;
    if (style === 'brush' || style === 'fountain') {
        // What the next frame can still change starts where the wet cache
        // stops, or near the end when there is no cache yet.
        tailFrom = __wetMeta && __wetMeta.path === path
            ? __wetMeta.cached - __TAIL_POINTS
            : __decimateForRender(points, __renderMinSpacing / Math.abs(state.transform.scale * ratio)).length - __TAIL_POINTS;
    }
    __lastFrame = {
        path,
        count: points.length,
        first: points[0],
        beforeLast: points[points.length - 2],
        tailFrom,
        revision: __committedRevision,
        width: canvas.width,
        height: canvas.height,
        ratio,
        scale: state.transform.scale,
        offsetX: state.transform.offsetX,
        offsetY: state.transform.offsetY
    };
}
```

Replace `__paintDrawingLayer` with:

```js
function __paintDrawingLayer(state, canvas) {
    const ratio = __pixelRatio();

    const selectionAction = __activeSelectionAction(state);
    const selectionDirty = !!selectionAction || __selectionWasActive;
    __selectionWasActive = !!selectionAction;

    let blit = null;
    // A pure append makes the layer current again; the transform check below
    // then decides between drawing it straight and blitting it.
    if (!selectionDirty) __appendToCommittedLayer(state, canvas);
    if (selectionDirty || !__committedContentIsCurrent(state, canvas)) {
        __rebuildCommittedLayer(state, canvas);
    } else if (!__sameTransform(__committedLayerMeta, state.transform)) {
        // Content is still good; only the view moved. Try to serve the frame
        // from the bitmap we already have.
        blit = __blitTransform(__committedLayerMeta, state.transform, canvas);
        if (!blit) __rebuildCommittedLayer(state, canvas);
    }

    if (blit) __scheduleSharpRebuild();
    else __cancelSharpRebuild();

    const tail = __liveTailRect(state, canvas, ratio);
    drawingCtx.setTransform(1, 0, 0, 1, 0, 0);
    // A live eraser intentionally switches the context to destination-out.
    // Canvas state survives between frames, so restore the neutral composite
    // state before painting the cached committed layer on the next frame.
    drawingCtx.globalCompositeOperation = 'source-over';
    drawingCtx.globalAlpha = 1;
    drawingCtx.save();
    if (tail) {
        drawingCtx.beginPath();
        drawingCtx.rect(tail.x, tail.y, tail.width, tail.height);
        drawingCtx.clip();
        drawingCtx.clearRect(tail.x, tail.y, tail.width, tail.height);
    } else {
        drawingCtx.clearRect(0, 0, canvas.width, canvas.height);
    }

    if (__committedLayerCtx) {
        const pad = __committedLayerMeta ? __committedLayerMeta.pad : __COMMITTED_PAD;
        if (blit) {
            drawingCtx.setTransform(blit.k, 0, 0, blit.k, blit.tx, blit.ty);
        } else {
            drawingCtx.setTransform(1, 0, 0, 1, 0, 0);
        }
        drawingCtx.drawImage(__committedLayer, -pad, -pad);
        drawingCtx.setTransform(1, 0, 0, 1, 0, 0);
    } else {
        drawingCtx.setTransform(
            state.transform.scale * ratio,
            0,
            0,
            state.transform.scale * ratio,
            state.transform.offsetX * ratio,
            state.transform.offsetY * ratio
        );
        const fallbackViewport = __visibleWorldRect(state, canvas);
        state.paths.forEach((path) => {
            if (!__pathIsVisible(path, fallbackViewport)) return;
            __drawStoredPath(drawingCtx, path);
        });
    }

    drawingCtx.setTransform(
        state.transform.scale * ratio,
        0,
        0,
        state.transform.scale * ratio,
        state.transform.offsetX * ratio,
        state.transform.offsetY * ratio
    );

    const wetBefore = __wetMeta;
    if (state.isDrawing && state.currentPath) {
        if (!__drawLiveStroke(drawingCtx, state.currentPath, state, canvas, ratio)) {
            __drawStoredPath(drawingCtx, state.currentPath);
        }
    } else if (__wetMeta) {
        // The stroke is finished and has gone into the committed layer.
        __resetLiveStrokeCache();
    }
    if (tail && __wetMeta !== wetBefore) {
        // The wet cache was rebuilt, which re-quantises the whole prefix, so
        // pixels outside the tail changed too. Paint this frame in full.
        drawingCtx.restore();
        __lastFrame = null;
        __paintDrawingLayer(state, canvas);
        return;
    }
    if (state.handPath) {
        __drawStoredPath(drawingCtx, state.handPath);
    }
    if (window.Inkyscib?.Selection?.drawOverlay) {
        window.Inkyscib.Selection.drawOverlay(drawingCtx);
    }
    if (window.Inkyscib?.Eraser?.drawOverlay) {
        window.Inkyscib.Eraser.drawOverlay(drawingCtx);
    }
    // Compass preview, snap indicator and intersection candidates are live
    // state, so they are drawn every frame rather than baked into the
    // committed layer.
    if (window.Inkyscib?.ConstructionRender?.drawOverlay) {
        window.Inkyscib.ConstructionRender.drawOverlay(drawingCtx);
    }
    drawingCtx.restore();
    __rememberFrame(state, canvas, ratio);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `python -m pytest tests/test_render_latency.py tests/test_canvas_blit.py -q --show-capture=no`
Expected: all pass (2 new + 8 existing).

- [ ] **Step 5: Mutation checks**

With the file restored between each: set `__TAIL_POINTS = 0` → `test_a_tail_frame_matches_a_full_frame` fails. Remove the `clearRect` inside the `if (tail)` branch → the same test fails. Make `__liveTailRect` always return null → `test_a_tail_frame_costs_a_fraction_of_a_full_frame` fails.

---

### Task 2: Draw from `pointerrawupdate` (spec 4.2)

**Files:**
- Modify: `static/js/events.js` (`continueDrawing` sample loop at the `getCoalescedEvents` branch; new functions after `continueDrawing`; listener registration beside `canvas.addEventListener("pointermove", ...)`)
- Create: `tests/test_raw_input.py`

**Interfaces:**
- Consumes: `window.renderNow()`; Task 1 tail frames keep the immediate paint cheap.
- Produces: `takeInkSamples(e)` (returns the number of samples appended), `onPointerRawUpdate(e)`, `window.__inkyscibSetRawInput(enabled)`.

- [ ] **Step 1: Write the failing tests**

Create `tests/test_raw_input.py`:

```python
"""Ink from pointerrawupdate.

Chromium holds pointermove back to the next frame: measured 10.7 ms (mouse) and
13 ms (touch) at the median behind pointerrawupdate carrying the same sample.
Drawing from the raw event wins that back, provided each sample is still taken
exactly once.
"""

import threading
import unittest

from app import app
from browser_server import make_browser_server


try:
    from playwright.sync_api import sync_playwright

    PLAYWRIGHT_AVAILABLE = True
except ImportError:
    PLAYWRIGHT_AVAILABLE = False


@unittest.skipUnless(PLAYWRIGHT_AVAILABLE, "Playwright is not installed")
class RawInputBrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = make_browser_server(app)
        cls.server_thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.server_thread.start()
        cls.base_url = f"http://127.0.0.1:{cls.server.server_port}"
        cls.playwright = sync_playwright().start()
        cls.browser = cls.playwright.chromium.launch(headless=True)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()
        cls.server.shutdown()
        cls.server_thread.join(timeout=3)

    def open_page(self):
        context = self.browser.new_context(viewport={"width": 960, "height": 600})
        self.addCleanup(context.close)
        context.add_init_script(
            "localStorage.setItem('inkyscib-feature-tour-v1', JSON.stringify({seen: true}))"
        )
        page = context.new_page()
        page.goto(self.base_url + "/write", wait_until="domcontentloaded")
        page.wait_for_function("() => window.appState?.storageReady === true")
        page.evaluate("() => { window.appState.paths = []; window.setTool('pen'); }")
        return page

    def stroke_times(self, page, raw):
        """Draws a 40-move stroke and returns its point times before the pen
        lifts, while nothing has tidied the stroke yet."""
        page.evaluate(f"() => window.__inkyscibSetRawInput({'true' if raw else 'false'})")
        page.mouse.move(200, 300)
        page.mouse.down()
        for i in range(40):
            page.mouse.move(206 + i * 6, 300 + (i % 5))
            page.wait_for_timeout(5)
        times = page.evaluate("() => window.appState.currentPath.points.map((p) => p.time)")
        page.mouse.up()
        return times

    def test_each_sample_is_taken_once(self):
        page = self.open_page()
        with_raw = self.stroke_times(page, raw=True)
        without_raw = self.stroke_times(page, raw=False)

        self.assertEqual(
            len(with_raw), len(set(with_raw)),
            "a sample was appended twice - once from pointerrawupdate, once from pointermove",
        )
        self.assertEqual(with_raw, sorted(with_raw), "samples were appended out of order")
        self.assertEqual(
            len(with_raw), len(without_raw),
            f"raw input recorded {len(with_raw)} points where pointermove alone "
            f"recorded {len(without_raw)}",
        )

    def test_ink_is_painted_before_pointermove_arrives(self):
        page = self.open_page()
        page.evaluate(
            """
            () => {
              const log = window.__rawLog = { raw: new Map(), move: new Map(), renders: [] };
              const record = (map) => (e) => {
                const now = performance.now();
                for (const s of (e.getCoalescedEvents ? e.getCoalescedEvents() : [e])) map.set(s.timeStamp, now);
              };
              window.addEventListener('pointerrawupdate', record(log.raw), { capture: true, passive: true });
              window.addEventListener('pointermove', record(log.move), { capture: true, passive: true });
              document.addEventListener('canvasRendered', () => log.renders.push(performance.now()));
            }
            """
        )
        self.stroke_times(page, raw=True)
        result = page.evaluate(
            """
            () => {
              const log = window.__rawLog;
              let early = 0, total = 0;
              for (const [time, moveAt] of log.move) {
                const rawAt = log.raw.get(time);
                if (rawAt === undefined) continue;
                total++;
                if (log.renders.some((at) => at >= rawAt && at <= moveAt)) early++;
              }
              return { early, total };
            }
            """
        )

        self.assertGreaterEqual(result["total"], 30, "too few samples were matched to judge")
        self.assertGreaterEqual(
            result["early"] / result["total"], 0.8,
            f"only {result['early']} of {result['total']} samples were painted before "
            "their pointermove arrived",
        )


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `python -m pytest tests/test_raw_input.py -q --show-capture=no`
Expected: both FAIL with `TypeError: window.__inkyscibSetRawInput is not a function`.

- [ ] **Step 3: Implement**

In `static/js/events.js`, replace the `else` branch of `continueDrawing` (the block from `const coalesced = ...` to the end of `samples.forEach(...)`) with:

```js
    } else {
      takeInkSamples(e);
    }
```

After `continueDrawing` add:

```js
  // Chromium holds pointermove back to the next frame. pointerrawupdate carries
  // the same samples as soon as they arrive - measured 10.7 ms earlier for the
  // mouse and 13 ms for touch at the median - so ink is taken from whichever
  // brings a sample first. Each sample is appended once, in order, so the
  // smoothing filter in appendInkPoint sees exactly what it always did.
  const lastSampleTime = new WeakMap();
  let rawInputEnabled = true;

  // Test seam: off leaves drawing to pointermove alone.
  window.__inkyscibSetRawInput = (enabled) => {
    rawInputEnabled = enabled !== false;
  };

  function takeInkSamples(e) {
    const s = state();
    const path = s.currentPath;
    const coalesced = typeof e.getCoalescedEvents === "function"
      ? e.getCoalescedEvents()
      : [];
    const samples = coalesced.length ? coalesced : [e];
    let taken = 0;
    samples.forEach((sample) => {
      const time = Number.isFinite(sample.timeStamp) ? sample.timeStamp : null;
      const previous = lastSampleTime.get(path);
      if (time !== null && previous !== undefined && time <= previous) return;
      let pos = getDrawingPoint(sample);
      if (s.notebook?.active && typeof window.normalizeNotebookPoint === "function") {
        pos = window.normalizeNotebookPoint(pos, { clamp: true });
        if (!pos) return;
      }
      appendInkPoint(path, pos, sample);
      if (time !== null) lastSampleTime.set(path, time);
      taken++;
    });
    return taken;
  }

  function onPointerRawUpdate(e) {
    if (!rawInputEnabled) return;
    const s = state();
    const tool = s.currentPath?.tool;
    if (!s.isDrawing || (tool !== "pen" && tool !== "highlight")) return;
    if (s.isPanning || s.isTouchZooming) return;
    if (e.pointerType !== "mouse" && (!pointers.has(e.pointerId) || pointers.size >= 2)) return;
    if (takeInkSamples(e) && typeof window.renderNow === "function") {
      window.renderNow();
    }
  }
```

After `canvas.addEventListener("pointermove", onPointerMove, { passive: false });` add:

```js
    if ("onpointerrawupdate" in window) {
      canvas.addEventListener("pointerrawupdate", onPointerRawUpdate, { passive: true });
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `python -m pytest tests/test_raw_input.py tests/test_pen_smoothing.py tests/test_write_assist.py -q --show-capture=no`
Expected: all pass.

- [ ] **Step 5: Mutation checks, then the full suite**

Remove the `time <= previous` early return → `test_each_sample_is_taken_once` fails. Replace `window.renderNow()` in `onPointerRawUpdate` with `requestRedraw()` → `test_ink_is_painted_before_pointermove_arrives` fails. Restore, then run `python -m pytest tests/ -q` (about 8 minutes) and expect 0 failed.

---

### Task 3: Sliced sharp rebuilds (spec 4.3)

**Files:**
- Modify: `static/js/canvas.js` (layer declarations become `let`; pending-layer state; `invalidateCanvasDrawingCache`; `__rebuildCommittedLayer` and `__appendToCommittedLayer` draw through `__drawPathIntoLayer`; `__scheduleSharpRebuild`; the decision section and committed-layer draw in `__paintDrawingLayer`)
- Test: `tests/test_render_latency.py`

**Interfaces:**
- Consumes: `__committedRevision` (Task 1).
- Produces: `__drawPathIntoLayer(ctx, path)`, `let __pendingMeta`, `__startPendingRebuild(state, canvas)`, `__advancePendingRebuild(state, canvas)` (returns true when it swapped), `__cancelPendingRebuild()`, `__looseBlitTransform(meta, transform)`.

- [ ] **Step 1: Write the failing tests**

Add to `RenderLatencyBrowserTests`:

```python
    HEAVY_PAGE = "L.seed(6000, -900, 20, 220, 14, 20);"

    def test_a_view_jump_on_a_heavy_page_never_blocks_a_frame(self):
        page = self.open_page()
        result = page.evaluate(
            """
            () => {
              const L = window.__latency;
              const state = window.appState;
              %s
              window.renderNow();
              L.flush();
              const rebuild = L.time(() => { window.invalidateCanvasDrawingCache(); window.renderNow(); });
              state.transform = { scale: 1, offsetX: -700, offsetY: 0 };
              const frames = [];
              for (let i = 0; i < 400; i++) {
                frames.push(L.time(() => window.renderNow()));
                if (!__pendingMeta) break;
              }
              const finished = !__pendingMeta;
              const sliced = L.snapshot();
              const reference = L.full();
              return Object.assign(
                { rebuild, frames: frames.length, worst: Math.max(...frames), finished, inked: reference.inked },
                L.compare(sliced, reference)
              );
            }
            """ % self.HEAVY_PAGE
        )

        self.assertTrue(result["finished"], "the sliced build never completed")
        self.assertGreater(result["frames"], 1, "the build finished in one frame, so nothing was sliced")
        self.assertLess(
            result["worst"], result["rebuild"] / 3,
            f"the worst frame took {result['worst']:.1f} ms against a "
            f"{result['rebuild']:.1f} ms rebuild",
        )
        self.assertGreater(result["inked"], 0)
        self.assertEqual(result["differing"], 0, f"{result['differing']} channels differ from a rebuild")

    def test_a_view_jump_on_a_light_page_finishes_in_the_same_frame(self):
        page = self.open_page()
        result = page.evaluate(
            """
            () => {
              const L = window.__latency;
              const state = window.appState;
              L.seed(6, 800, 200);
              window.renderNow();
              state.transform = { scale: 1, offsetX: -700, offsetY: 0 };
              window.renderNow();
              const pending = !!__pendingMeta;
              const first = L.snapshot();
              const reference = L.full();
              return Object.assign({ pending, inked: reference.inked }, L.compare(first, reference));
            }
            """
        )

        self.assertFalse(result["pending"], "a light page left a build running")
        self.assertGreater(result["inked"], 0)
        self.assertEqual(result["differing"], 0)

    def test_a_pen_lift_during_a_sliced_build_is_in_the_result(self):
        page = self.open_page()
        result = page.evaluate(
            """
            () => {
              const L = window.__latency;
              const state = window.appState;
              %s
              window.renderNow();
              state.transform = { scale: 1, offsetX: -700, offsetY: 0 };
              window.renderNow();
              const running = !!__pendingMeta;
              const lifted = L.glyph(900, 650);
              lifted.size = 6;
              state.paths.push(lifted);
              for (let i = 0; i < 400 && __pendingMeta; i++) window.renderNow();
              const sliced = L.snapshot();
              const reference = L.full();
              return Object.assign({ running }, L.compare(sliced, reference));
            }
            """ % self.HEAVY_PAGE
        )

        self.assertTrue(result["running"], "the build finished before the pen lift, so the case never arose")
        self.assertEqual(result["differing"], 0)

    def test_the_sharp_rebuild_after_a_zoom_ends_identical_to_a_rebuild(self):
        page = self.open_page()
        result = page.evaluate(
            """
            async () => {
              const L = window.__latency;
              const state = window.appState;
              %s
              window.renderNow();
              state.transform = { scale: 1.25, offsetX: -40, offsetY: -30 };
              window.renderNow();
              const blitted = __committedLayerMeta.scale === 1;
              await new Promise((resolve) => setTimeout(resolve, 250));
              for (let i = 0; i < 400 && __pendingMeta; i++) window.renderNow();
              const sharpScale = __committedLayerMeta.scale;
              const sharp = L.snapshot();
              const reference = L.full();
              return Object.assign({ blitted, sharpScale }, L.compare(sharp, reference));
            }
            """ % self.HEAVY_PAGE
        )

        self.assertTrue(result["blitted"], "the zoom was not served by a blit")
        self.assertEqual(result["sharpScale"], 1.25, "the sharp layer was never built")
        self.assertEqual(result["differing"], 0)
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `python -m pytest tests/test_render_latency.py -q --show-capture=no -k "view_jump or sliced or sharp_rebuild"`
Expected: FAIL with `ReferenceError: __pendingMeta is not defined`.

- [ ] **Step 3: Implement**

At the top of `static/js/canvas.js`, change `const __committedLayer` and `const __committedLayerCtx` to `let` (the two layers swap). After `let __committedRevision = 0;` add:

```js
// The sharp layer being built in slices while the frame shows the old one.
// It swaps with the committed layer when it reaches the end of the document.
let __pendingLayer = document.createElement('canvas');
let __pendingLayerCtx = __pendingLayer.getContext('2d', {
    alpha: true,
    desynchronized: true
});
let __pendingMeta = null;
// Per frame. Leaves room in a 16.7 ms frame for the live stroke and compositing.
const __REBUILD_SLICE_MS = 5;
```

In `invalidateCanvasDrawingCache` add `__pendingMeta = null;` after `__committedLayerMeta = null;`.

Before `__rebuildCommittedLayer` add:

```js
// Each path draws from the same context state, whichever layer it lands in and
// whatever was drawn before it, so a path appended, repaired or drawn into the
// pending layer produces the pixels a full rebuild does.
function __drawPathIntoLayer(ctx, path) {
    ctx.save();
    __drawStoredPath(ctx, path);
    ctx.restore();
}
```

In `__rebuildCommittedLayer` and `__appendToCommittedLayer`, replace `__drawStoredPath(__committedLayerCtx, path);` with `__drawPathIntoLayer(__committedLayerCtx, path);`.

After `__committedContentIsCurrent` add:

```js
function __cancelPendingRebuild() {
    __pendingMeta = null;
}

function __startPendingRebuild(state, canvas) {
    const pad = __COMMITTED_PAD;
    const width = canvas.width + pad * 2;
    const height = canvas.height + pad * 2;
    if (__pendingLayer.width !== width) __pendingLayer.width = width;
    if (__pendingLayer.height !== height) __pendingLayer.height = height;
    __pendingLayerCtx.setTransform(1, 0, 0, 1, 0, 0);
    __pendingLayerCtx.clearRect(0, 0, width, height);
    __pendingMeta = {
        width: canvas.width,
        height: canvas.height,
        pad,
        ratio: __pixelRatio(),
        scale: state.transform.scale,
        offsetX: state.transform.offsetX,
        offsetY: state.transform.offsetY,
        // The paths already walked, in order. A pen lift extends the document
        // and is picked up; anything that changes this prefix cancels the build.
        paths: [],
        viewport: __visibleWorldRect(state, canvas, pad)
    };
}

// Draws paths into the pending layer until the slice deadline, always at least
// one. Returns true when the build reached the end and was swapped in.
function __advancePendingRebuild(state, canvas) {
    const meta = __pendingMeta;
    if (!meta) return false;
    if (meta.width !== canvas.width || meta.height !== canvas.height || meta.ratio !== __pixelRatio()) {
        __cancelPendingRebuild();
        return false;
    }
    const paths = state.paths;
    const walked = meta.paths;
    if (paths.length < walked.length) {
        __cancelPendingRebuild();
        return false;
    }
    for (let index = 0; index < walked.length; index++) {
        if (walked[index] !== paths[index]) {
            __cancelPendingRebuild();
            return false;
        }
    }

    __pendingLayerCtx.setTransform(
        meta.scale * meta.ratio,
        0,
        0,
        meta.scale * meta.ratio,
        meta.offsetX * meta.ratio + meta.pad,
        meta.offsetY * meta.ratio + meta.pad
    );
    const deadline = performance.now() + __REBUILD_SLICE_MS;
    do {
        if (walked.length >= paths.length) break;
        const path = paths[walked.length];
        if (__pathIsVisible(path, meta.viewport)) __drawPathIntoLayer(__pendingLayerCtx, path);
        walked.push(path);
    } while (performance.now() < deadline);
    if (walked.length < paths.length) return false;

    const layer = __committedLayer;
    const layerCtx = __committedLayerCtx;
    __committedLayer = __pendingLayer;
    __committedLayerCtx = __pendingLayerCtx;
    __pendingLayer = layer;
    __pendingLayerCtx = layerCtx;
    __committedLayerMeta = {
        width: meta.width,
        height: meta.height,
        pad: meta.pad,
        ratio: meta.ratio,
        scale: meta.scale,
        offsetX: meta.offsetX,
        offsetY: meta.offsetY,
        paths: walked
    };
    __pendingMeta = null;
    __committedRevision++;
    return true;
}

// The blit mapping without its coverage and magnification checks. Only used
// while a sharp layer is still being built: a soft view, or one with blank
// borders, is better than a frozen one.
function __looseBlitTransform(meta, transform) {
    if (!meta || !(meta.scale > 0) || !(transform.scale > 0)) return null;
    const k = transform.scale / meta.scale;
    return {
        k,
        tx: meta.ratio * (transform.offsetX - meta.offsetX * k),
        ty: meta.ratio * (transform.offsetY - meta.offsetY * k)
    };
}
```

Replace the timer body in `__scheduleSharpRebuild`:

```js
    __sharpRebuildTimer = setTimeout(() => {
        __sharpRebuildTimer = null;
        // Start the sharp layer instead of throwing the cache away: frames keep
        // blitting the soft one until the new one is ready.
        const state = window.appState;
        const canvas = document.getElementById('drawingCanvas');
        if (state && canvas && !__pendingMeta && __committedLayerMeta &&
            !__sameTransform(__committedLayerMeta, state.transform)) {
            __startPendingRebuild(state, canvas);
        }
        requestCanvasRender();
    }, __SHARP_REBUILD_DELAY);
```

In `__paintDrawingLayer`, replace the decision section (from `let blit = null;` to `else __cancelSharpRebuild();`) with:

```js
    let blit = null;
    let loose = null;
    // A pure append makes the layer current again; the transform check below
    // then decides between drawing it straight and blitting it.
    if (!selectionDirty) __appendToCommittedLayer(state, canvas);
    if (selectionDirty || !__committedContentIsCurrent(state, canvas)) {
        __cancelPendingRebuild();
        __rebuildCommittedLayer(state, canvas);
    } else if (__sameTransform(__committedLayerMeta, state.transform)) {
        // The layer on hand is already sharp for this view.
        __cancelPendingRebuild();
    } else {
        // A build whose target can no longer serve this view restarts here.
        if (__pendingMeta && !__blitTransform(__pendingMeta, state.transform, canvas)) {
            __startPendingRebuild(state, canvas);
        }
        blit = __blitTransform(__committedLayerMeta, state.transform, canvas);
        if (!blit && !__pendingMeta) __startPendingRebuild(state, canvas);
        if (__pendingMeta && __advancePendingRebuild(state, canvas)) {
            blit = __sameTransform(__committedLayerMeta, state.transform)
                ? null
                : __blitTransform(__committedLayerMeta, state.transform, canvas);
        }
        if (!blit && !__sameTransform(__committedLayerMeta, state.transform)) {
            loose = __looseBlitTransform(__committedLayerMeta, state.transform);
        }
        if (__pendingMeta) requestCanvasRender();
    }

    if (blit) __scheduleSharpRebuild();
    else __cancelSharpRebuild();
```

In the committed-layer draw, replace `if (blit) { drawingCtx.setTransform(blit.k, 0, 0, blit.k, blit.tx, blit.ty); }` with:

```js
        const mapping = blit || loose;
        if (mapping) {
            drawingCtx.setTransform(mapping.k, 0, 0, mapping.k, mapping.tx, mapping.ty);
        }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `python -m pytest tests/test_render_latency.py tests/test_canvas_blit.py -q --show-capture=no`
Expected: all pass.

- [ ] **Step 5: Mutation checks**

Replace `while (performance.now() < deadline)` with `while (true)` → `test_a_view_jump_on_a_heavy_page_never_blocks_a_frame` fails on the worst frame. Change `if (walked.length < paths.length) return false;` to `if (walked.length < paths.length / 2) return false;` → the same test fails on pixels. Remove the `__advancePendingRebuild` call from `__paintDrawingLayer` → `test_the_sharp_rebuild_after_a_zoom_ends_identical_to_a_rebuild` fails on `sharpScale`.

---

### Task 4: Region repair (spec 4.4)

> **Amended during execution (2026-09-14).** A clipped region redraw cannot be
> bit-exact (spec 4.4a), so `__repairCommittedLayer` ends by starting an exact copy
> (`__startRefreshRebuild`, a pending build flagged `refresh`) that advances on still
> frames and swaps in; `__advancePendingRebuild` takes the frame's deadline
> (`frameDeadline`, set at the top of `__paintDrawingLayer`). Pages under
> `__REPAIR_MIN_PATHS` (200) rebuild instead. `__redrawLayerRegion` checks the region
> before the viewport. Tests: the long erase checks the frame's shape (`L.shape`) and
> exactness once settled; a new dab test checks cost (under a third of a rebuild);
> the reorder test runs on a 2000-glyph page. The file in the repo is authoritative
> where it differs from the code below.

**Files:**
- Modify: `static/js/canvas.js` (new functions after `__appendToCommittedLayer`; stale-content branch of `__paintDrawingLayer`)
- Test: `tests/test_render_latency.py`

**Interfaces:**
- Consumes: `__drawPathIntoLayer`, `__committedRevision`, `__cancelPendingRebuild` (Task 3).
- Produces: `__layerDeviceRect(meta, bounds)` (returns `{x, y, width, height}` or null), `__redrawLayerRegion(ctx, meta, rect, paths, exclude)`, `__repairCommittedLayer(state, canvas, exclude)` (returns true when it repaired).

- [ ] **Step 1: Write the failing tests**

Add to `RenderLatencyBrowserTests`:

```python
    def test_erasing_repairs_only_the_erased_region(self):
        page = self.open_page()
        result = page.evaluate(
            """
            () => {
              const L = window.__latency;
              const state = window.appState;
              L.seed(2000);
              const long = { tool: 'pen', style: 'default', color: '#ff6666', size: 4, points: [] };
              for (let i = 0; i <= 60; i++) long.points.push({ x: 300 + i * 5, y: 305, pressure: 0.5, time: i * 8 });
              const line = { tool: 'line', color: '#88ff88', size: 3, points: [{ x: 320, y: 240 }, { x: 350, y: 380 }] };
              state.paths.push(long, line);
              window.renderNow();
              L.flush();
              const rebuild = L.time(() => { window.invalidateCanvasDrawingCache(); window.renderNow(); });
              const cut = window.applyInkyscibEraserToPaths(state.paths, {
                tool: 'eraser', size: 30, points: [{ x: 460, y: 250 }, { x: 460, y: 360 }]
              });
              const repair = L.time(() => window.renderNow());
              const repaired = L.snapshot();
              const reference = L.full();
              return Object.assign({ cut, rebuild, repair, inked: reference.inked }, L.compare(repaired, reference));
            }
            """
        )

        self.assertTrue(result["cut"])
        self.assertGreater(result["inked"], 0)
        self.assertEqual(result["differing"], 0, f"{result['differing']} channels differ from a rebuild")
        self.assertLess(
            result["repair"], result["rebuild"] / 5,
            f"the repair took {result['repair']:.1f} ms against a {result['rebuild']:.1f} ms rebuild",
        )

    def test_a_reorder_alongside_an_erase_still_matches_a_rebuild(self):
        page = self.open_page()
        result = page.evaluate(
            """
            () => {
              const L = window.__latency;
              const state = window.appState;
              L.seed(40);
              const across = { tool: 'pen', style: 'default', color: '#ff4444', size: 10, points: [] };
              const down = { tool: 'pen', style: 'default', color: '#4488ff', size: 10, points: [] };
              for (let i = 0; i <= 40; i++) {
                across.points.push({ x: 500 + i * 5, y: 500, pressure: 0.5, time: i * 8 });
                down.points.push({ x: 600, y: 400 + i * 5, pressure: 0.5, time: i * 8 });
              }
              state.paths.push(across, down);
              window.renderNow();
              const a = state.paths.length - 2;
              [state.paths[a], state.paths[a + 1]] = [state.paths[a + 1], state.paths[a]];
              window.applyInkyscibEraserToPaths(state.paths, {
                tool: 'eraser', size: 20, points: [{ x: 60, y: 10 }, { x: 60, y: 40 }]
              });
              window.renderNow();
              const repaired = L.snapshot();
              const reference = L.full();
              return L.compare(repaired, reference);
            }
            """
        )

        self.assertEqual(result["differing"], 0, "the swapped strokes kept their old stacking")
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `python -m pytest tests/test_render_latency.py -q --show-capture=no -k "erasing_repairs or reorder"`
Expected: `test_erasing_repairs_only_the_erased_region` FAILS on the cost assertion (the frame is a full rebuild). The reorder test passes now; it guards the order check added below.

- [ ] **Step 3: Implement**

After `__appendToCommittedLayer` in `static/js/canvas.js` add:

```js
// ---------------------------------------------------------------------------
// Region repair
//
// The partial eraser and a write-assist revert replace a handful of path
// objects and leave the rest alone, yet a stale layer used to mean replaying
// the whole document. Inside a clip of the changed paths' bounds, clearing the
// layer and redrawing every path that touches that rectangle, in document order,
// gives the pixels a rebuild would: nothing outside the rectangle changed, and
// paths that miss it contribute nothing inside it.
const __REPAIR_MAX_AREA = 0.4;
// Undo and redo replace every object; past this many, rebuild without looking.
const __REPAIR_MAX_PATHS = 64;

// World bounds to an integer device rectangle in the layer, or null if empty.
function __layerDeviceRect(meta, bounds) {
    const scale = meta.scale * meta.ratio;
    const originX = meta.offsetX * meta.ratio + meta.pad;
    const originY = meta.offsetY * meta.ratio + meta.pad;
    const left = Math.max(0, Math.floor(bounds.left * scale + originX) - 2);
    const top = Math.max(0, Math.floor(bounds.top * scale + originY) - 2);
    const right = Math.min(meta.width + meta.pad * 2, Math.ceil(bounds.right * scale + originX) + 2);
    const bottom = Math.min(meta.height + meta.pad * 2, Math.ceil(bounds.bottom * scale + originY) + 2);
    if (right <= left || bottom <= top) return null;
    return { x: left, y: top, width: right - left, height: bottom - top };
}

function __redrawLayerRegion(ctx, meta, rect, paths, exclude) {
    const scale = meta.scale * meta.ratio;
    const originX = meta.offsetX * meta.ratio + meta.pad;
    const originY = meta.offsetY * meta.ratio + meta.pad;
    const region = {
        left: (rect.x - originX) / scale,
        top: (rect.y - originY) / scale,
        right: (rect.x + rect.width - originX) / scale,
        bottom: (rect.y + rect.height - originY) / scale
    };
    const viewport = __visibleWorldRect({ transform: meta }, meta, meta.pad);

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.beginPath();
    ctx.rect(rect.x, rect.y, rect.width, rect.height);
    ctx.clip();
    ctx.clearRect(rect.x, rect.y, rect.width, rect.height);
    ctx.setTransform(scale, 0, 0, scale, originX, originY);
    paths.forEach((path) => {
        if (exclude && exclude.has(path)) return;
        if (!__pathIsVisible(path, viewport) || !__pathIsVisible(path, region)) return;
        __drawPathIntoLayer(ctx, path);
    });
    ctx.restore();
}

function __repairCommittedLayer(state, canvas, exclude) {
    const meta = __committedLayerMeta;
    if (!meta || !__committedLayerCtx) return false;
    if (meta.width !== canvas.width || meta.height !== canvas.height || meta.ratio !== __pixelRatio()) {
        return false;
    }

    const before = meta.paths;
    const after = state.paths;
    const beforeSet = new Set(before);
    const afterSet = new Set(after);
    const removed = before.filter((path) => !afterSet.has(path));
    const added = after.filter((path) => !beforeSet.has(path));
    const changed = removed.concat(added);
    if (!changed.length || changed.length > __REPAIR_MAX_PATHS) return false;

    // Paths present in both lists must keep their stacking order.
    const keptBefore = before.filter((path) => afterSet.has(path));
    const keptAfter = after.filter((path) => beforeSet.has(path));
    if (keptBefore.length !== keptAfter.length) return false;
    for (let index = 0; index < keptBefore.length; index++) {
        if (keptBefore[index] !== keptAfter[index]) return false;
    }

    const bounds = __unionBounds(changed.map(__pathRenderBounds));
    if (!bounds ||
        !Number.isFinite(bounds.left) || !Number.isFinite(bounds.right) ||
        !Number.isFinite(bounds.top) || !Number.isFinite(bounds.bottom)) {
        return false;
    }
    const rect = __layerDeviceRect(meta, bounds);
    if (rect) {
        const layerArea = (meta.width + meta.pad * 2) * (meta.height + meta.pad * 2);
        if (rect.width * rect.height > layerArea * __REPAIR_MAX_AREA) return false;
        __redrawLayerRegion(__committedLayerCtx, meta, rect, after, exclude);
    }
    meta.paths = after.slice();
    __committedRevision++;
    return true;
}
```

In `__paintDrawingLayer`, replace the stale-content branch body:

```js
    if (selectionDirty || !__committedContentIsCurrent(state, canvas)) {
        __cancelPendingRebuild();
        if (selectionDirty || !__repairCommittedLayer(state, canvas)) {
            __rebuildCommittedLayer(state, canvas);
        }
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `python -m pytest tests/test_render_latency.py tests/test_canvas_blit.py -q --show-capture=no`
Expected: all pass.

- [ ] **Step 5: Mutation checks**

Remove `ctx.clearRect(...)` from `__redrawLayerRegion` → `test_erasing_repairs_only_the_erased_region` fails. Replace `paths.forEach(` in `__redrawLayerRegion` with `added.forEach(` passed from the caller (redraw only the added paths) → the same test fails. Remove the stacking-order loop → `test_a_reorder_alongside_an_erase_still_matches_a_rebuild` fails.

---

### Task 5: Selection drag and marquee (spec 4.5)

> **Amended during execution (2026-09-14).** The exclusion below was built and then
> removed (spec 4.5a): selection drags assign clones back every frame, so region
> repair already handles them and the exclusion was dead code its mutation checks
> could not reach. What shipped removes the forced selection rebuild
> (`__selectionWasActive`, `__activeSelectionAction`) and adds no drag-specific code.
> The two tests below stand, with the drop settling before its exactness check.

**Files:**
- Modify: `static/js/canvas.js` (`__rebuildCommittedLayer` gains `exclude`; new drag functions after `__repairCommittedLayer`; selection logic and a dragged-paths draw in `__paintDrawingLayer`)
- Test: `tests/test_render_latency.py`

**Interfaces:**
- Consumes: `__layerDeviceRect`, `__redrawLayerRegion`, `__repairCommittedLayer(state, canvas, exclude)` (Task 4); `selection.action.transformIndices` and `selection.action.originalPaths` from `static/js/tools/select.js` `beginAction`.
- Produces: `let __drag` (`{ action, excluded: Set, bounds }` or null), `__beginDragExclusion(state, canvas, action)`, `__finishDragExclusion(state, canvas)`.

- [ ] **Step 1: Write the failing tests**

Add to `RenderLatencyBrowserTests`:

```python
    def drag_setup(self, page):
        return page.evaluate(
            """
            () => {
              const L = window.__latency;
              const state = window.appState;
              L.seed(2000);
              const stroke = { tool: 'pen', style: 'default', color: '#ffcc00', size: 5, points: [] };
              for (let i = 0; i <= 60; i++) stroke.points.push({ x: 100 + i * 5, y: 660, pressure: 0.5, time: i * 8 });
              state.paths.push(stroke);
              window.setTool('select');
              window.Inkyscib.Selection.selectIndex(state.paths.length - 1);
              window.renderNow();
              L.flush();
              const rebuild = L.time(() => { window.invalidateCanvasDrawingCache(); window.renderNow(); });
              const rect = document.getElementById('drawingCanvas').getBoundingClientRect();
              return { rebuild, left: rect.left, top: rect.top };
            }
            """
        )

    def test_a_selection_drag_draws_only_the_moved_strokes(self):
        page = self.open_page()
        setup = self.drag_setup(page)
        page.mouse.move(setup["left"] + 250, setup["top"] + 660)
        page.mouse.down()
        frames = []
        for step in range(1, 11):
            page.mouse.move(setup["left"] + 250 + step * 30, setup["top"] + 660)
            frames.append(page.evaluate("() => window.__latency.time(() => window.renderNow())"))
        during = page.evaluate(
            """
            () => {
              // The stroke started at x 100-400 and has moved 300 to the right;
              // nothing else is drawn on this row, so its old place must be empty.
              const shot = window.__latency.snapshot();
              let ghost = 0, moved = 0;
              for (let y = 648; y < 672; y++) {
                for (let x = 100; x < 380; x++) if (shot.data[(y * shot.width + x) * 4 + 3] >= 8) ghost++;
                for (let x = 420; x < 680; x++) if (shot.data[(y * shot.width + x) * 4 + 3] >= 8) moved++;
              }
              return { ghost, moved };
            }
            """
        )
        page.mouse.up()
        drop = page.evaluate(
            """
            () => {
              const L = window.__latency;
              window.renderNow();
              const dropped = L.snapshot();
              const reference = L.full();
              return L.compare(dropped, reference);
            }
            """
        )

        median = sorted(frames)[len(frames) // 2]
        self.assertLess(
            median, setup["rebuild"] / 5,
            f"a drag frame took {median:.1f} ms against a {setup['rebuild']:.1f} ms rebuild",
        )
        self.assertEqual(during["ghost"], 0, "the dragged stroke was still drawn where it started")
        self.assertGreater(during["moved"], 0, "the dragged stroke was not drawn where it is")
        self.assertEqual(drop["differing"], 0, f"{drop['differing']} channels differ from a rebuild after the drop")

    def test_a_marquee_does_not_replay_the_document(self):
        page = self.open_page()
        setup = self.drag_setup(page)
        page.evaluate("() => window.Inkyscib.Selection.clear()")
        page.mouse.move(setup["left"] + 1040, setup["top"] + 700)
        page.mouse.down()
        frames = []
        for step in range(1, 8):
            page.mouse.move(setup["left"] + 1040 - step * 20, setup["top"] + 700 - step * 5)
            frames.append(page.evaluate("() => window.__latency.time(() => window.renderNow())"))
        page.mouse.up()

        median = sorted(frames)[len(frames) // 2]
        self.assertLess(
            median, setup["rebuild"] / 5,
            f"a marquee frame took {median:.1f} ms against a {setup['rebuild']:.1f} ms rebuild",
        )
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `python -m pytest tests/test_render_latency.py -q --show-capture=no -k "selection_drag or marquee"`
Expected: both FAIL on the frame-cost assertion (every selection frame is a rebuild today).

- [ ] **Step 3: Implement**

Change the signature of `__rebuildCommittedLayer` to `function __rebuildCommittedLayer(state, canvas, exclude)` and its loop to:

```js
    state.paths.forEach((path) => {
        if (exclude && exclude.has(path)) return;
        if (!__pathIsVisible(path, viewport)) return;
        __drawPathIntoLayer(__committedLayerCtx, path);
    });
```

After `__repairCommittedLayer` add:

```js
// ---------------------------------------------------------------------------
// Selection drags
//
// A move, scale or rotate mutates the selected paths in place, which used to
// mean replaying the whole document on every frame of the drag. Instead the
// selected paths are taken out of the committed layer once - by repairing the
// region they were drawn in, from the originals the selection tool keeps - and
// drawn live on top each frame. On drop, the union of where they were and where
// they are is repaired with everything back in document order.
//
// While dragging, the moved strokes draw above other ink. After the drop the
// layer is exact again.
let __drag = null;

function __beginDragExclusion(state, canvas, action) {
    const excluded = new Set(
        (action.transformIndices || action.indices || [])
            .map((index) => state.paths[index])
            .filter(Boolean)
    );
    const originals = (action.originalPaths || []).map((entry) => entry.path).filter(Boolean);
    if (!excluded.size || originals.length !== excluded.size) return false;
    const bounds = __unionBounds(originals.map(__pathRenderBounds));
    if (!bounds) return false;

    const meta = __committedLayerMeta;
    if (!meta || !__committedContentIsCurrent(state, canvas)) {
        __rebuildCommittedLayer(state, canvas, excluded);
    } else {
        const rect = __layerDeviceRect(meta, bounds);
        if (rect) {
            const layerArea = (meta.width + meta.pad * 2) * (meta.height + meta.pad * 2);
            if (rect.width * rect.height > layerArea * __REPAIR_MAX_AREA) return false;
            __redrawLayerRegion(__committedLayerCtx, meta, rect, state.paths, excluded);
            __committedRevision++;
        }
    }
    __drag = { action, excluded, bounds };
    return true;
}

function __finishDragExclusion(state, canvas) {
    const drag = __drag;
    __drag = null;
    const meta = __committedLayerMeta;
    if (!meta) return;
    const bounds = __unionBounds([drag.bounds, ...[...drag.excluded].map(__pathRenderBounds)]);
    const rect = bounds && __layerDeviceRect(meta, bounds);
    const layerArea = (meta.width + meta.pad * 2) * (meta.height + meta.pad * 2);
    if (!rect || rect.width * rect.height > layerArea * __REPAIR_MAX_AREA) {
        __rebuildCommittedLayer(state, canvas);
        return;
    }
    // meta.paths is left alone: if the drop also added or removed paths, the
    // content check that follows still sees it and repairs that too.
    __redrawLayerRegion(__committedLayerCtx, meta, rect, state.paths, null);
    __committedRevision++;
}
```

In `__paintDrawingLayer`, replace the three selection lines with:

```js
    const selectionAction = __activeSelectionAction(state);
    // A marquee changes no content, so it no longer forces a rebuild.
    const dragAction = selectionAction && selectionAction.mode !== 'marquee' ? selectionAction : null;
    if (__drag && __drag.action !== dragAction) __finishDragExclusion(state, canvas);
    let selectionDirty = false;
    if (dragAction && !__drag && !__beginDragExclusion(state, canvas, dragAction)) {
        // The region was too large to take out; replay the document each frame.
        selectionDirty = true;
    }
    selectionDirty = selectionDirty || __selectionWasActive;
    __selectionWasActive = !!dragAction && !__drag;
```

In the stale-content branch pass the exclusion:

```js
        if (selectionDirty || !__repairCommittedLayer(state, canvas, __drag?.excluded)) {
            __rebuildCommittedLayer(state, canvas, __drag?.excluded);
        }
```

In the committed-layer draw, directly after `drawingCtx.drawImage(__committedLayer, -pad, -pad);` add:

```js
        if (__drag) {
            drawingCtx.setTransform(
                state.transform.scale * ratio,
                0,
                0,
                state.transform.scale * ratio,
                state.transform.offsetX * ratio,
                state.transform.offsetY * ratio
            );
            state.paths.forEach((path) => {
                if (__drag.excluded.has(path)) __drawStoredPath(drawingCtx, path);
            });
        }
```

In `__advancePendingRebuild`, a build that finishes mid-drag must not put the dragged paths back into the layer. Change its draw line to:

```js
        if (__pathIsVisible(path, meta.viewport) && !__drag?.excluded.has(path)) {
            __drawPathIntoLayer(__pendingLayerCtx, path);
        }
```

In `invalidateCanvasDrawingCache` leave `__drag` alone: a rebuild during a drag is passed `__drag.excluded` above.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `python -m pytest tests/test_render_latency.py tests/test_canvas_blit.py -q --show-capture=no`
Expected: all pass.

- [ ] **Step 5: Mutation checks**

Pass `null` instead of `excluded` to `__redrawLayerRegion` in `__beginDragExclusion` → `test_a_selection_drag_draws_only_the_moved_strokes` fails on `ghost`. Remove the dragged-paths draw block → the same test fails on `moved`. Make `dragAction` include marquee (`selectionAction`) → `test_a_marquee_does_not_replay_the_document` fails.

---

### Task 6: Verification and records

**Files:**
- Create: `tests/bench_render.py` (not collected by pytest: no `test_` prefix)
- Modify: `TODOS.md` (new item 12), memory files `inkyscib-render-cost-ceiling.md` and `inkyscib-test-suite-baseline.md`

- [ ] **Step 1: Full suite**

Run: `python -m pytest tests/ -q` (about 8 minutes; edit nothing meanwhile).
Expected: 205 + 12 new tests passed, 0 failed, 0 skipped. Record the exact counts.

- [ ] **Step 2: Benchmark**

Create `tests/bench_render.py`:

```python
"""Times /write's render path in headless Chromium.

Not collected by pytest. Run from the repo root: python tests/bench_render.py

Tablet-shaped: 960x600 CSS px at DPR 2, a 1920x1200 canvas. Figures are raw ms -
JS plus draw-command recording - as medians. Headless compositing is software, so
these are for comparing code, not for quoting as frame times on a tablet.
"""

import json
import os
import sys
import threading

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO)
sys.path.insert(0, os.path.join(REPO, "tests"))
os.chdir(REPO)
os.environ.setdefault("SECRET_KEY", "dev")

from app import app  # noqa: E402
from browser_server import make_browser_server  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

TOUR = "localStorage.setItem('inkyscib-feature-tour-v1', JSON.stringify({seen: true}))"

BENCH = r"""
({ count }) => {
  const state = window.appState;
  state.notebook.active = false;
  state.ppt.active = false;
  state.isDrawing = false;
  state.currentPath = null;
  state.transform = { scale: 1, offsetX: 0, offsetY: 0 };
  const median = (xs) => +xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)].toFixed(3);
  const raw = (fn) => { const t0 = performance.now(); fn(); return performance.now() - t0; };
  const glyph = (x0, y0) => {
    const points = [];
    for (let i = 0; i < 40; i++) {
      const t = i / 39;
      points.push({ x: x0 + 5 * Math.sin(t * Math.PI * 3) + t * 9, y: y0 + 7 * Math.cos(t * Math.PI * 2), pressure: 0.5, time: i * 8 });
    }
    return { tool: 'pen', style: 'default', points, color: '#ffffff', size: 2 };
  };
  const metrics = window.getCanvasMetrics();
  const cols = Math.max(1, Math.floor((metrics.width - 40) / 14));
  const rowStep = Math.max(3, (metrics.height - 60) / Math.ceil(count / cols));
  state.paths = [];
  for (let n = 0; n < count; n++) state.paths.push(glyph(20 + (n % cols) * 14, 20 + Math.floor(n / cols) * rowStep));
  window.invalidateCanvasDrawingCache();
  window.renderNow();

  const out = { strokes: count };
  out.fullRebuild = median(Array.from({ length: 9 }, () => raw(() => { window.invalidateCanvasDrawingCache(); window.renderNow(); })));
  out.penLift = median(Array.from({ length: 9 }, (_, i) => raw(() => { state.paths.push(glyph(30 + i * 3, 30)); window.renderNow(); })));

  const live = { tool: 'pen', style: 'default', color: '#ffffff', size: 2, points: [] };
  state.currentPath = live;
  state.isDrawing = true;
  const frames = [];
  for (let i = 0; i < 240; i++) {
    live.points.push({ x: 100 + i * 3, y: 300 + 40 * Math.sin(i / 9), pressure: 0.5, time: i * 8 });
    const ms = raw(() => window.renderNow());
    if (i >= 120) frames.push(ms);
  }
  state.isDrawing = false;
  state.currentPath = null;
  window.renderNow();
  out.liveFrame = median(frames);

  state.transform = { scale: 1, offsetX: -700, offsetY: 0 };
  const jump = [];
  for (let i = 0; i < 400; i++) {
    jump.push(raw(() => window.renderNow()));
    if (typeof __pendingMeta === 'undefined' || !__pendingMeta) break;
  }
  out.viewJumpWorstFrame = +Math.max(...jump).toFixed(3);
  out.viewJumpFrames = jump.length;

  state.transform = { scale: 1, offsetX: 0, offsetY: 0 };
  window.invalidateCanvasDrawingCache();
  window.renderNow();
  out.erase = +raw(() => {
    window.applyInkyscibEraserToPaths(state.paths, { tool: 'eraser', size: 24, points: [{ x: 300, y: 200 }, { x: 300, y: 260 }] });
    window.renderNow();
  }).toFixed(3);
  return out;
}
"""

# From a sample reaching the page to the first frame painted after it.
DELAY_SETUP = r"""
() => {
  const log = window.__delay = { arrivals: [], renders: [] };
  window.addEventListener('pointerrawupdate', () => log.arrivals.push(performance.now()), { capture: true, passive: true });
  document.addEventListener('canvasRendered', () => log.renders.push(performance.now()));
}
"""

DELAY_RESULT = r"""
() => {
  const { arrivals, renders } = window.__delay;
  const delays = [];
  for (const at of arrivals) {
    const painted = renders.find((t) => t >= at);
    if (painted !== undefined) delays.push(painted - at);
  }
  delays.sort((a, b) => a - b);
  return delays.length ? +delays[Math.floor(delays.length / 2)].toFixed(2) : null;
}
"""


def open_page(browser, base):
    context = browser.new_context(viewport={"width": 960, "height": 600}, device_scale_factor=2)
    context.add_init_script(TOUR)
    page = context.new_page()
    page.goto(base, wait_until="domcontentloaded")
    page.wait_for_function("() => window.appState?.storageReady === true")
    page.wait_for_timeout(300)
    return context, page


def ink_delay(page, raw):
    page.evaluate(
        "(raw) => { window.__inkyscibSetRawInput(raw); window.setTool('pen');"
        " window.__delay.arrivals.length = 0; window.__delay.renders.length = 0; }",
        raw,
    )
    page.mouse.move(200, 300)
    page.mouse.down()
    for i in range(60):
        page.mouse.move(206 + i * 5, 300 + (i % 7))
        page.wait_for_timeout(6)
    page.mouse.up()
    return page.evaluate(DELAY_RESULT)


def main():
    server = make_browser_server(app)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{server.server_port}/write"
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        for throttle in (1, 4):
            for count in (200, 1000, 3000):
                context, page = open_page(browser, base)
                if throttle > 1:
                    context.new_cdp_session(page).send("Emulation.setCPUThrottlingRate", {"rate": throttle})
                row = page.evaluate(BENCH, {"count": count})
                row["cpu"] = f"{throttle}x"
                print(json.dumps(row), flush=True)
                context.close()
        context, page = open_page(browser, base)
        page.evaluate(DELAY_SETUP)
        print(json.dumps({
            "inkDelayMedianMs": {"rawInput": ink_delay(page, True), "pointermoveOnly": ink_delay(page, False)}
        }), flush=True)
        context.close()
        browser.close()
    server.shutdown()


if __name__ == "__main__":
    main()
```

Run `python tests/bench_render.py` and keep the JSON rows.

- [ ] **Step 3: Record**

Add TODOS.md item 12, struck through, with before and after numbers, the tests, the mutation results, the approved transient differences, and what stays unverified (tablet glass latency, GPU compositing). Update the two memory files with the new baseline count and results.
