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

  // Tells rounding from a stale patch: pixels whose premultiplied colour or
  // alpha moved by 32 or more, and the largest 8-connected cluster of them.
  // Premultiplied, so a near-transparent edge pixel whose unpremultiplied colour
  // jumps from 0 to 255 does not count as a large change.
  shape(a, b) {
    const width = a.width, height = a.height;
    const moved = new Uint8Array(width * height);
    let strong = 0;
    for (let i = 0; i < moved.length; i++) {
      const k = i * 4;
      const alphaA = a.data[k + 3], alphaB = b.data[k + 3];
      let delta = Math.abs(alphaA - alphaB);
      for (let c = 0; c < 3; c++) {
        delta = Math.max(delta, Math.abs(a.data[k + c] * alphaA - b.data[k + c] * alphaB) / 255);
      }
      if (delta >= 32) {
        moved[i] = 1;
        strong++;
      }
    }
    let cluster = 0;
    const stack = [];
    for (let i = 0; i < moved.length; i++) {
      if (moved[i] !== 1) continue;
      let size = 0;
      moved[i] = 2;
      stack.push(i);
      while (stack.length) {
        const j = stack.pop();
        size++;
        const x = j % width, y = (j - x) / width;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
            const index = ny * width + nx;
            if (moved[index] === 1) {
              moved[index] = 2;
              stack.push(index);
            }
          }
        }
      }
      if (size > cluster) cluster = size;
    }
    return { strong, cluster };
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
            "localStorage.setItem('inkyscib-consent-v1', JSON.stringify({version: 1, analytics: false})); localStorage.setItem('inkyscib-feature-tour-v1', JSON.stringify({seen: true}))"
        )
        page = context.new_page()
        page.goto(self.base_url + "/write", wait_until="domcontentloaded")
        page.wait_for_function("() => window.appState?.storageReady === true")
        page.evaluate(HELPERS)
        return page

    def test_a_tail_frame_matches_a_full_frame(self):
        """While a stroke is written only its tail is repainted. Checked every
        25 samples against a full frame of the same state, for each nib the
        fast path takes, at a zoomed, panned view.

        Exact where it can be: brush and fountain strokes long enough for the
        wet cache already draw incrementally, and match bit for bit. A stroke
        drawn as one path cannot. Skia rounds a path against its own bounds, so
        adding one point moved 15 channels near the start of a 25-point stroke -
        on a CPU canvas exactly as on the GPU. Full frames already shimmer that
        much from one frame to the next; a tail frame keeps the older pixels.

        So for those, the test tells rounding from a stale segment by shape.
        Rounding scatters: across every nib, on a steady and a fast stroke, at
        most 25 pixels per checkpoint had their alpha moved by 32 or more, and no
        more than 8 of them touched. A segment left behind by a tail that was too
        short is a coherent patch - clusters of 90 to 461 such pixels, or 64 of
        them along a thin fountain taper.
        """
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
              // A steady stroke, about 6 device px between samples, long enough
              // for the wet cache; and a fast one, about 17 px apart, where the
              // margin around the newest point no longer covers the segments a
              // new point changes, so how far back the tail reaches is tested.
              const strokes = [
                { spacing: 4.5, count: 170, every: 25 },
                { spacing: 13, count: 60, every: 10 }
              ];
              const checks = [];
              for (const [tool, style, color, size] of nibs) {
                for (const { spacing, count, every } of strokes) {
                  const live = { tool, style, color, size, points: [] };
                  state.currentPath = live;
                  state.isDrawing = true;
                  for (let i = 0; i < count; i++) {
                    live.points.push({
                      x: 40 + i * spacing, y: 260 + Math.sin(i * spacing / 50) * 90,
                      pressure: 0.45 + 0.4 * Math.sin(i / 7), time: i * 8
                    });
                    window.renderNow();
                    if (i % every !== every - 1) continue;
                    const tail = L.snapshot();
                    window.__inkyscibSetDirtyRectFrames(false);
                    window.renderNow();
                    const full = L.snapshot();
                    window.__inkyscibSetDirtyRectFrames(true);
                    const width = full.width, height = full.height;
                    const moved = new Uint8Array(width * height);
                    let pixels = 0, strong = 0;
                    for (let i = 0; i < moved.length; i++) {
                      const delta = Math.abs(tail.data[i * 4 + 3] - full.data[i * 4 + 3]);
                      if (delta) pixels++;
                      if (delta >= 32) {
                        moved[i] = 1;
                        strong++;
                      }
                    }
                    // The largest 8-connected cluster of strongly moved pixels.
                    let cluster = 0;
                    const stack = [];
                    for (let i = 0; i < moved.length; i++) {
                      if (moved[i] !== 1) continue;
                      let size = 0;
                      moved[i] = 2;
                      stack.push(i);
                      while (stack.length) {
                        const j = stack.pop();
                        size++;
                        const x = j % width, y = (j - x) / width;
                        for (let dy = -1; dy <= 1; dy++) {
                          for (let dx = -1; dx <= 1; dx++) {
                            const nx = x + dx, ny = y + dy;
                            if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
                            const k = ny * width + nx;
                            if (moved[k] === 1) {
                              moved[k] = 2;
                              stack.push(k);
                            }
                          }
                        }
                      }
                      if (size > cluster) cluster = size;
                    }
                    checks.push({
                      nib: style || tool, spacing, points: live.points.length,
                      pixels, strong, cluster, inked: full.inked
                    });
                  }
                  state.isDrawing = false;
                  state.currentPath = null;
                  window.renderNow();
                }
              }
              return checks;
            }
            """
        )

        for check in result:
            nib = check["nib"]
            where = f"{nib} at {check['points']} points, {check['spacing']} apart"
            with self.subTest(where):
                self.assertGreater(check["inked"], 0, f"{where}: nothing drawn")
                if nib in ("brush", "fountain") and check["points"] >= 96:
                    self.assertEqual(
                        check["pixels"], 0,
                        f"{where}: a wet-cached tail frame differs from a full frame "
                        f"in {check['pixels']} pixels",
                    )
                    continue
                self.assertLessEqual(
                    check["cluster"], 16,
                    f"{where}: {check['cluster']} strongly changed pixels touch each other - "
                    "the shape of a stale segment, not rounding (measured at most 8)",
                )
                self.assertLessEqual(
                    check["strong"], 40,
                    f"{where}: {check['strong']} pixels moved by 32+ alpha "
                    "(rounding measured at most 25)",
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

    # Rows of handwriting spread well beyond the viewport on both sides, so any
    # view has a full page of it.
    HEAVY_PAGE = "L.seed(6000, -900, 20, 220, 14, 20);"

    def test_a_view_jump_on_a_heavy_page_never_blocks_a_frame(self):
        """Moving the view past the cached margin used to rebuild the layer in
        one blocking frame. The sharp layer is now built in slices while the
        frame shows the old one, and swapped in when complete."""
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
        """A page light enough to rebuild inside one slice must look exactly
        as it did before slicing existed: sharp in the first frame."""
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
        """The build walks the live path list, so a stroke finished while it
        runs is picked up rather than lost when the layers swap."""
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
        """A zoom is served soft from the cached layer; once it settles, the
        sharp layer is built in slices instead of by dropping the cache."""
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

    def test_erasing_repairs_only_the_erased_region(self):
        """The partial eraser replaces a few paths and leaves the rest, so only
        the region they covered is cleared and redrawn - other ink crossing it,
        and a line that is never culled, included.

        A clipped redraw rasterises edge pixels a little differently from an
        unclipped one, so the frame right after the erase is checked for shape -
        nothing left behind, nothing missing - and the layer for exact identity
        once the copy built behind it has been swapped in."""
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
              const cut = window.applyInkyscibEraserToPaths(state.paths, {
                tool: 'eraser', size: 30, points: [{ x: 460, y: 250 }, { x: 460, y: 360 }]
              });
              window.renderNow();
              const immediate = L.snapshot();
              for (let i = 0; i < 400 && __pendingMeta; i++) window.renderNow();
              const settledFully = !__pendingMeta;
              const settled = L.snapshot();
              const reference = L.full();
              return Object.assign(
                { cut, settledFully, inked: reference.inked, immediate: L.shape(immediate, reference) },
                L.compare(settled, reference)
              );
            }
            """
        )

        self.assertTrue(result["cut"])
        self.assertGreater(result["inked"], 0)
        immediate = result["immediate"]
        self.assertLessEqual(
            immediate["cluster"], 16,
            f"right after the erase, {immediate['cluster']} strongly changed pixels touch - "
            "ink was left behind or missed in the repaired region",
        )
        self.assertLessEqual(
            immediate["strong"], 40,
            f"right after the erase, {immediate['strong']} pixels are far from a rebuild",
        )
        self.assertTrue(result["settledFully"], "the exact copy of the repaired layer was never built")
        self.assertEqual(
            result["differing"], 0,
            f"once settled, {result['differing']} channels differ from a rebuild",
        )

    def test_a_small_erase_costs_a_fraction_of_a_rebuild(self):
        """Erasing a dab used to rebuild the whole layer. A repair's drawing
        follows the region, but it still walks every path once to find what
        touches the region and diffs the path lists - measured about 10 ms of
        fixed cost on this 2000-path page at full CPU speed, whatever the region.
        A dab over one glyph measured about a fifth of a rebuild; the budget is a
        third. Removing the fixed walk would need a spatial index."""
        page = self.open_page()
        result = page.evaluate(
            """
            () => {
              const L = window.__latency;
              const state = window.appState;
              L.seed(2000);
              window.renderNow();
              // Size the pending canvas once, as any earlier sliced build would.
              __startPendingRebuild(state, document.getElementById('drawingCanvas'));
              __cancelPendingRebuild();
              L.flush();
              const rebuild = L.time(() => { window.invalidateCanvasDrawingCache(); window.renderNow(); });
              const cut = window.applyInkyscibEraserToPaths(state.paths, {
                tool: 'eraser', size: 14, points: [{ x: 102, y: 96 }, { x: 104, y: 104 }]
              });
              const repair = L.time(() => window.renderNow());
              for (let i = 0; i < 400 && __pendingMeta; i++) window.renderNow();
              const settled = L.snapshot();
              const reference = L.full();
              return Object.assign({ cut, rebuild, repair }, L.compare(settled, reference));
            }
            """
        )

        self.assertTrue(result["cut"], "the dab erased nothing")
        self.assertLess(
            result["repair"], result["rebuild"] / 3,
            f"erasing a dab took {result['repair']:.1f} ms against a {result['rebuild']:.1f} ms rebuild",
        )
        self.assertEqual(result["differing"], 0, "once settled, the layer differs from a rebuild")

    def test_a_reorder_alongside_an_erase_still_matches_a_rebuild(self):
        """A repair only redraws the changed region, so it is only right when
        the paths it keeps are still stacked in the same order."""
        page = self.open_page()
        result = page.evaluate(
            """
            () => {
              const L = window.__latency;
              const state = window.appState;
              // Heavy enough that an exact copy cannot finish in the same frame
              // and hide a repair that kept the old stacking.
              L.seed(2000);
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

    def drag_setup(self, page):
        """A full page, plus one stroke on an empty row, selected."""
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
        """Every frame of a drag used to replay the document, because a move
        mutates paths in place. The dragged paths are now taken out of the
        cached layer once and drawn live on top."""
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
              for (let i = 0; i < 400; i++) {
                window.renderNow();
                if (!__pendingMeta) break;
              }
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
        """A marquee selects; it changes no content, so its frames have no
        reason to rebuild the layer."""
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


if __name__ == "__main__":
    unittest.main()
