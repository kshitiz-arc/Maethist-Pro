"""Pan and zoom serve most frames from the cached committed layer rather than
replaying every stroke. That cache is transformed rather than redrawn, so what
needs pinning is the coordinate maths: a blitted frame has to put ink exactly
where a full rebuild would. Getting it wrong translates every stroke on screen
at once, which is the failure this file exists to catch.

It also budgets the render-time decimation. Dropping sub-pixel samples is not
free - brush and fountain lay down one round cap per sample, so thinning the
samples thins the stroke - and the test holds that cost under one percent of
an undecimated render rather than assuming it away.

Pixels are compared inside the page and only counts come back: the drawing
canvas is `desynchronized`, so it is copied into a plain canvas before being
read, and a full frame is several megabytes that have no business crossing the
Playwright bridge.
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


# Shared page-side helpers: seed strokes, snapshot the canvas, compare two
# snapshots. Synthesised pointer drags are flaky and nothing here depends on
# the input path, so paths go straight into appState.
HELPERS = """
window.__blitTest = {
  seed(count) {
    const state = window.appState;
    state.notebook.active = false;
    state.ppt.active = false;
    state.paths = [];
    for (let stroke = 0; stroke < count; stroke++) {
      const points = [];
      for (let i = 0; i < 48; i++) {
        points.push({
          x: 120 + stroke * 37 + i * 6,
          y: 160 + stroke * 23 + Math.sin(i / 3) * 40,
          pressure: 0.5 + 0.4 * Math.sin(i / 5),
          time: i * 9
        });
      }
      state.paths.push({
        tool: 'pen', points, color: '#ffffff', size: 3, style: 'default'
      });
    }
    window.invalidateCanvasDrawingCache();
  },

  snapshot() {
    const source = document.getElementById('drawingCanvas');
    const copy = document.createElement('canvas');
    copy.width = source.width;
    copy.height = source.height;
    copy.getContext('2d').drawImage(source, 0, 0);
    const { width, height } = copy;
    const data = copy.getContext('2d').getImageData(0, 0, width, height).data;
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity, inked = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (data[(y * width + x) * 4 + 3] < 8) continue;
        inked++;
        if (x < left) left = x;
        if (x > right) right = x;
        if (y < top) top = y;
        if (y > bottom) bottom = y;
      }
    }
    return {
      width, height, data, inked,
      box: inked ? { left, top, right, bottom } : null
    };
  },

  // Renders without clearing the cache, so a moved view is served by the blit.
  blitFrame(transform) {
    Object.assign(window.appState.transform, transform);
    window.renderNow();
    return this.snapshot();
  },

  // Renders from scratch at the same transform, which is the reference.
  rebuiltFrame(transform) {
    Object.assign(window.appState.transform, transform);
    window.invalidateCanvasDrawingCache();
    window.renderNow();
    return this.snapshot();
  },

  // Skia does not guarantee two independent rasterisations of the same
  // geometry are bit-identical, so this reports the shape of the difference
  // rather than demanding zero: how many channels moved, by how much, and
  // whether any of it was colour rather than coverage.
  compare(a, b) {
    if (a.width !== b.width || a.height !== b.height) {
      return { differing: -1, worst: 255, colourDiffering: 255 };
    }
    let differing = 0, worst = 0, colourDiffering = 0;
    for (let i = 0; i < a.data.length; i++) {
      const delta = Math.abs(a.data[i] - b.data[i]);
      if (!delta) continue;
      differing++;
      if (delta > worst) worst = delta;
      if (i % 4 !== 3) colourDiffering++;
    }
    return { differing, worst, colourDiffering };
  }
};
"""


@unittest.skipUnless(PLAYWRIGHT_AVAILABLE, "Playwright is not installed")
class CanvasBlitBrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = make_browser_server(app)
        cls.server_thread = threading.Thread(
            target=cls.server.serve_forever,
            daemon=True,
        )
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
        context = self.browser.new_context(viewport={"width": 1100, "height": 720})
        self.addCleanup(context.close)
        # The first-run tour covers the canvas and would land in the pixels.
        context.add_init_script(
            "localStorage.setItem('inkyscib-consent-v1', JSON.stringify({version: 1, analytics: false})); localStorage.setItem('inkyscib-feature-tour-v1', JSON.stringify({seen: true}))"
        )
        page = context.new_page()
        page.goto(self.base_url + "/write", wait_until="domcontentloaded")
        page.wait_for_function("() => window.appState?.storageReady === true")
        page.evaluate(HELPERS)
        page.evaluate("() => window.__blitTest.seed(6)")
        return page

    def test_panned_frame_lands_exactly_where_a_full_rebuild_puts_it(self):
        page = self.open_page()
        result = page.evaluate(
            """
            () => {
              const t = window.__blitTest;
              t.rebuiltFrame({ scale: 1, offsetX: 0, offsetY: 0 });
              // A pure pan keeps the blit at scale 1, so it is a straight copy
              // and there is no resampling to excuse a difference.
              const panned = { scale: 1, offsetX: -24, offsetY: 16 };
              const blitted = t.blitFrame(panned);
              const rebuilt = t.rebuiltFrame(panned);
              return Object.assign({
                blittedBox: blitted.box,
                rebuiltBox: rebuilt.box,
                blittedInked: blitted.inked
              }, t.compare(blitted, rebuilt));
            }
            """
        )

        self.assertGreater(result["blittedInked"], 0, "panned frame drew no ink")
        # The box is the assertion that catches a translation bug: getting the
        # blit maths wrong moves every stroke at once, so the box moves with it.
        self.assertEqual(
            result["blittedBox"], result["rebuiltBox"],
            "blitted ink sits somewhere other than where a rebuild puts it",
        )
        # What is left over is antialiasing along stroke edges, which is
        # coverage only - a real positioning error would show up as colour
        # differences and as thousands of changed channels, not a handful.
        self.assertEqual(
            result["colourDiffering"], 0,
            "a blitted pan changed pixel colour, not just edge coverage",
        )
        self.assertLessEqual(
            result["worst"], 8,
            f"blitted pan differs from a rebuild by up to {result['worst']}/255",
        )
        self.assertLess(
            result["differing"], result["blittedInked"] * 0.01,
            f"{result['differing']} channels differ between a blitted pan and a "
            "rebuild - too many to be antialiasing",
        )

    def test_zoomed_frame_lands_in_the_same_place_and_leaves_no_blank_edge(self):
        page = self.open_page()
        result = page.evaluate(
            """
            () => {
              const t = window.__blitTest;
              t.rebuiltFrame({ scale: 1, offsetX: 0, offsetY: 0 });
              // Magnifying resamples the cached bitmap, so position is what is
              // asserted here, not sharpness.
              const zoomed = { scale: 1.25, offsetX: -40, offsetY: -30 };
              const blitted = t.blitFrame(zoomed);
              const rebuilt = t.rebuiltFrame(zoomed);
              return {
                blittedBox: blitted.box,
                rebuiltBox: rebuilt.box,
                blittedInked: blitted.inked,
                rebuiltInked: rebuilt.inked
              };
            }
            """
        )

        self.assertIsNotNone(result["blittedBox"], "zoomed frame drew no ink")
        self.assertIsNotNone(result["rebuiltBox"])
        for edge in ("left", "top", "right", "bottom"):
            self.assertLessEqual(
                abs(result["blittedBox"][edge] - result["rebuiltBox"][edge]), 2,
                f"blitted ink {edge} edge is more than 2px from the rebuilt one",
            )

        # A blit that failed to cover the canvas shows up as missing ink rather
        # than as a shifted box.
        self.assertGreater(
            result["blittedInked"], result["rebuiltInked"] * 0.85,
            "blitted frame is missing ink a rebuild draws - likely a blank edge",
        )

    def test_a_growing_stroke_matches_one_drawn_in_a_single_pass(self):
        """The live stroke's settled prefix is cached in its own bitmap and
        only its last few points are redrawn each frame. The prefix and the
        tail meet on a loop index, which is an exact split - so what this
        guards is that the join leaves neither a gap nor a doubled segment,
        either of which would show as a band down a long stroke.

        It is not pixel-exact and cannot be: the prefix is quantised to 8 bits
        in the intermediate bitmap before the tail composites over it. The
        budget below is what that quantisation actually costs, measured.
        """
        page = self.open_page()
        result = page.evaluate(
            """
            () => {
              const state = window.appState;
              state.notebook.active = false;
              state.ppt.active = false;
              state.transform = { scale: 1, offsetX: 0, offsetY: 0 };

              const build = (n, style) => {
                const points = [];
                for (let i = 0; i < n; i++) {
                  const t = i / (n - 1);
                  points.push({
                    x: 80 + t * 560,
                    y: 250 + Math.sin(t * 9) * 150,
                    pressure: 0.45 + 0.4 * Math.sin(t * 22),
                    time: i * 7
                  });
                }
                return { tool: 'pen', points, color: '#ffffff', size: 5, style };
              };

              // One frame per sample, the way a real stroke arrives.
              const grown = (full) => {
                state.paths = [];
                state.isDrawing = true;
                window.invalidateCanvasDrawingCache();
                const live = Object.assign({}, full, { points: [] });
                state.currentPath = live;
                for (const point of full.points) {
                  live.points.push(point);
                  window.renderNow();
                }
                const shot = window.__blitTest.snapshot();
                state.isDrawing = false;
                state.currentPath = null;
                return shot;
              };

              const atOnce = (full) => {
                state.isDrawing = false;
                state.currentPath = null;
                state.paths = [full];
                window.invalidateCanvasDrawingCache();
                window.renderNow();
                return window.__blitTest.snapshot();
              };

              const out = {};
              for (const style of ['brush', 'fountain']) {
                const full = build(600, style);
                const a = grown(full);
                const b = atOnce(full);
                let differing = 0, worst = 0, worstRun = 0;
                for (let y = 0; y < a.height; y++) {
                  let run = 0;
                  for (let x = 0; x < a.width; x++) {
                    const i = (y * a.width + x) * 4 + 3;
                    const delta = Math.abs(a.data[i] - b.data[i]);
                    if (delta) {
                      differing++; run++;
                      if (delta > worst) worst = delta;
                    } else if (run) {
                      if (run > worstRun) worstRun = run;
                      run = 0;
                    }
                  }
                  if (run > worstRun) worstRun = run;
                }
                out[style] = {
                  differing, worst, worstRun,
                  inkedGrown: a.inked, inkedAtOnce: b.inked
                };
              }
              return out;
            }
            """
        )

        for style in ("brush", "fountain"):
            row = result[style]
            self.assertGreater(row["inkedAtOnce"], 2000, f"{style} drew almost nothing")
            # A gap or a doubled segment changes how much ink lands.
            self.assertLessEqual(
                abs(row["inkedGrown"] - row["inkedAtOnce"]), 4,
                f"{style}: growing the stroke changed its inked area by "
                f"{abs(row['inkedGrown'] - row['inkedAtOnce'])} pixels",
            )
            # The run length is what separates rounding from a seam, and it is
            # the assertion doing the real work here. Quantisation scatters
            # isolated pixels; a gap or a doubled segment is a solid run across
            # the stroke's width, which at size 5 is several pixels.
            self.assertLessEqual(
                row["worstRun"], 4,
                f"{style}: {row['worstRun']} adjacent pixels changed in a row, "
                "which is the shape of a seam rather than of rounding",
            )
            # A ceiling on any single pixel, sized to catch a segment that went
            # missing (which would read near 255) rather than to police
            # rounding. Measured at 600 points: brush tops out at 6, fountain
            # at 16 with three pixels above 6 and 21 of 36 differing by 1 -
            # mid-tone edge pixels where several antialiased edges stack.
            self.assertLessEqual(
                row["worst"], 32,
                f"{style}: alpha moved by {row['worst']}/255 on one pixel - "
                "too much to be the intermediate bitmap rounding",
            )
            self.assertLess(
                row["differing"], row["inkedAtOnce"] * 0.02,
                f"{style}: {row['differing']} pixels differ (budget 2% of inked)",
            )

    def test_a_pen_lift_costs_far_less_than_a_full_rebuild(self):
        """Lifting the pen used to replay every stroke on screen, because a
        pushed path fails the cache's reference check - 50 to 700 ms on a full
        page. A lift only adds ink on top, so it should cost about one stroke.

        Timed with a 1px readback so the cost includes rasterisation. The
        budget is a fifth of a rebuild; the measured ratio is nearer 1/30.
        """
        page = self.open_page()
        result = page.evaluate(
            """
            () => {
              const state = window.appState;
              state.transform = { scale: 1, offsetX: 0, offsetY: 0 };
              const glyph = (x0, y0) => {
                const points = [];
                for (let i = 0; i < 40; i++) {
                  const t = i / 39;
                  points.push({
                    x: x0 + 5 * Math.sin(t * Math.PI * 3) + t * 9,
                    y: y0 + 7 * Math.cos(t * Math.PI * 2),
                    pressure: 0.5, time: i * 8
                  });
                }
                return { tool: 'pen', points, color: '#ffffff', size: 2, style: 'default' };
              };
              // A page of handwriting, all of it on screen so nothing is culled.
              state.paths = [];
              for (let n = 0; n < 2000; n++) {
                state.paths.push(glyph(20 + (n % 70) * 14, 20 + Math.floor(n / 70) * 20));
              }

              const probe = document.createElement('canvas');
              probe.width = probe.height = 1;
              const probeCtx = probe.getContext('2d', { willReadFrequently: true });
              const drawing = document.getElementById('drawingCanvas');
              const flush = () => {
                probeCtx.drawImage(drawing, 0, 0, 1, 1, 0, 0, 1, 1);
                probeCtx.getImageData(0, 0, 1, 1);
              };
              const median = (xs) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];

              window.invalidateCanvasDrawingCache();
              window.renderNow();
              flush();
              const rebuild = [], lift = [];
              for (let i = 0; i < 7; i++) {
                let t0 = performance.now();
                window.invalidateCanvasDrawingCache();
                window.renderNow();
                flush();
                rebuild.push(performance.now() - t0);

                t0 = performance.now();
                state.paths.push(glyph(30 + i * 9, 660));
                window.renderNow();
                flush();
                lift.push(performance.now() - t0);
              }
              return { rebuild: median(rebuild), lift: median(lift) };
            }
            """
        )

        self.assertLess(
            result["lift"], result["rebuild"] / 5,
            f"a pen lift took {result['lift']:.1f} ms against {result['rebuild']:.1f} ms "
            "for a full rebuild - it is still replaying the whole document",
        )

    def test_ink_added_by_a_pen_lift_matches_a_full_rebuild(self):
        """Drawing only the new stroke into the cached layer is the same
        sequence of draw commands a rebuild issues, so the result has to be
        identical, not merely close - at a zoomed, panned view, for every nib
        and for the highlighter."""
        page = self.open_page()
        result = page.evaluate(
            """
            () => {
              const t = window.__blitTest;
              const state = window.appState;
              const view = { scale: 1.3, offsetX: -40, offsetY: 25 };
              t.rebuiltFrame(view);

              const curve = (tool, style, color, size, y) => {
                const points = [];
                for (let i = 0; i < 60; i++) {
                  points.push({
                    x: 90 + i * 7,
                    y: y + Math.sin(i / 6) * 25,
                    pressure: 0.45 + 0.4 * Math.sin(i / 4),
                    time: i * 8
                  });
                }
                return { tool, style, color, size, points };
              };
              const added = [
                curve('pen', 'default', '#ffffff', 3, 120),
                curve('pen', 'brush', '#ff8844', 5, 200),
                curve('pen', 'fountain', '#44ddff', 4, 280),
                curve('highlight', undefined, 'rgba(255,255,0,0.3)', 14, 360)
              ];
              // One lift, one frame, as it happens when writing.
              for (const path of added) {
                state.paths.push(path);
                window.renderNow();
              }
              const lifted = t.snapshot();
              const rebuilt = t.rebuiltFrame(view);
              return Object.assign({ inked: lifted.inked, rebuiltInked: rebuilt.inked }, t.compare(lifted, rebuilt));
            }
            """
        )

        self.assertGreater(result["inked"], 0, "nothing was drawn")
        self.assertEqual(
            result["differing"], 0,
            f"{result['differing']} channels differ between ink added on a pen lift "
            f"and a full rebuild (worst {result['worst']}/255)",
        )

    def test_a_replaced_earlier_stroke_still_redraws_everything(self):
        """Only a pure append may skip the rebuild. If an earlier path was
        replaced as well - an undo, a write-assist revert - the cached layer
        still holds the old one, and drawing just the new stroke would leave it
        on screen."""
        page = self.open_page()
        result = page.evaluate(
            """
            () => {
              const t = window.__blitTest;
              const state = window.appState;
              const view = { scale: 1, offsetX: 0, offsetY: 0 };
              t.rebuiltFrame(view);

              const first = state.paths[0];
              state.paths[0] = Object.assign({}, first, {
                points: first.points.map((p) => ({ ...p, y: p.y + 90 }))
              });
              state.paths.push(Object.assign({}, first, {
                points: first.points.map((p) => ({ ...p, x: p.x + 300 }))
              }));
              window.renderNow();
              const changed = t.snapshot();
              const rebuilt = t.rebuiltFrame(view);
              return Object.assign({ inked: changed.inked }, t.compare(changed, rebuilt));
            }
            """
        )

        self.assertGreater(result["inked"], 0, "nothing was drawn")
        self.assertEqual(
            result["differing"], 0,
            f"{result['differing']} channels differ from a full rebuild - the replaced "
            "stroke was left in the cached layer",
        )

    def test_erasing_through_the_newest_stroke_redraws_everything(self):
        """The partial eraser splits a stroke into pieces, so the path list
        grows and every new entry is still pen ink - which looks like an
        append. It is not: the uncut stroke is in the cached layer, and has to
        go."""
        page = self.open_page()
        result = page.evaluate(
            """
            () => {
              const t = window.__blitTest;
              const state = window.appState;
              const view = { scale: 1, offsetX: 0, offsetY: 0 };
              t.rebuiltFrame(view);

              const points = [];
              for (let i = 0; i < 60; i++) points.push({ x: 200 + i * 6, y: 560, pressure: 0.5, time: i * 8 });
              state.paths.push({ tool: 'pen', style: 'default', color: '#ffffff', size: 4, points });
              window.renderNow();
              const before = state.paths.length;

              const cut = window.applyInkyscibEraserToPaths(state.paths, {
                tool: 'eraser', size: 24,
                points: [{ x: 380, y: 520 }, { x: 380, y: 600 }]
              });
              window.renderNow();
              const erased = t.snapshot();
              const rebuilt = t.rebuiltFrame(view);
              return Object.assign(
                { cut, before, after: state.paths.length, inked: erased.inked },
                t.compare(erased, rebuilt)
              );
            }
            """
        )

        self.assertTrue(result["cut"], "the eraser did not touch the stroke")
        self.assertGreater(
            result["after"], result["before"],
            "the eraser did not split the stroke, so the case under test never arose",
        )
        self.assertEqual(
            result["differing"], 0,
            f"{result['differing']} channels differ from a full rebuild - the uncut "
            "stroke was left in the cached layer",
        )

    def test_decimation_costs_under_one_percent_of_a_variable_stroke(self):
        """Brush and fountain lay down one round cap per sample, so thinning
        the samples thins the stroke. The shipped threshold is only defensible
        if that cost is far below what anyone can see, which means measuring it
        against the same curve rendered with decimation switched off.
        """
        result = self.measure_decimation(self.open_page())

        for style in ("brush", "fountain"):
            row = result[style]
            self.assertGreater(row["baseInked"], 0, f"{style} stroke drew nothing")
            self.assertGreater(
                row["pixelPct"], 0,
                f"{style}: the shipped threshold changed nothing against an "
                "undecimated render, so this budget is not being exercised",
            )
            self.assertLess(
                row["pixelPct"], 1.0,
                f"{style}: decimation flips {row['pixelPct']:.2f}% of inked pixels "
                "(budget 1%)",
            )
            self.assertLess(
                row["alphaPct"], 1.5,
                f"{style}: decimation loses {row['alphaPct']:.2f}% of laid-down ink "
                "(budget 1.5%)",
            )

    def measure_decimation(self, page):
        return page.evaluate(
            """
            () => {
              const state = window.appState;
              state.notebook.active = false;
              state.ppt.active = false;
              state.transform = { scale: 1, offsetX: 0, offsetY: 0 };

              // Sampled far denser than a real stroke, so there is plenty for
              // the threshold to remove.
              const build = (style) => {
                const points = [];
                for (let d = 0; d <= 300; d += 0.12) {
                  points.push({
                    x: 200 + d,
                    y: 300 + Math.sin(d / 40) * 60,
                    pressure: 0.55 + 0.3 * Math.sin(d / 70),
                    time: d * 4
                  });
                }
                return { tool: 'pen', points, color: '#ffffff', size: 6, style };
              };

              const render = (style, spacing) => {
                window.__inkyscibSetRenderMinSpacing(spacing);
                state.paths = [build(style)];
                window.invalidateCanvasDrawingCache();
                window.renderNow();
                const shot = window.__blitTest.snapshot();
                const mask = new Uint8Array(shot.width * shot.height);
                let inked = 0, alpha = 0;
                for (let i = 0; i < mask.length; i++) {
                  const a = shot.data[i * 4 + 3];
                  mask[i] = a >= 8 ? 1 : 0;
                  inked += mask[i];
                  alpha += a;
                }
                return { mask, inked, alpha };
              };

              const out = {};
              for (const style of ['brush', 'fountain']) {
                const base = render(style, 0);        // decimation off
                const shipped = render(style, undefined);  // the shipped value
                let flipped = 0;
                for (let i = 0; i < base.mask.length; i++) {
                  if (base.mask[i] !== shipped.mask[i]) flipped++;
                }
                out[style] = {
                  baseInked: base.inked,
                  inkedDelta: base.inked - shipped.inked,
                  pixelPct: 100 * flipped / base.inked,
                  alphaPct: 100 * (base.alpha - shipped.alpha) / base.alpha
                };
              }
              window.__inkyscibSetRenderMinSpacing(undefined);
              return out;
            }
            """
        )


if __name__ == "__main__":
    unittest.main()
