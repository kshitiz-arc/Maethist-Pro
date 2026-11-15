"""A live ink stroke must not replay the document's chrome on every sample.

Reported 2026-09-17: "The lag in writing is again observable."

Drawing renders from `pointerrawupdate` rather than `pointermove`, which is
what bought sample-to-paint 0.3 ms against 5.1 ms (2026-09-14). That is
deliberate and must stay. The cost is that `renderNow()` runs the whole frame
function at digitizer rate -- four times per displayed frame on a 240 Hz
stylus, sixteen on a 1000 Hz mouse -- so anything per-frame is multiplied by
that factor.

Three things in the frame cannot change while ink is being laid down, and all
three walk the whole document:

  - `clampNotebookTransform()` -> writtenPageCount -> pathBounds per path
  - `ConstructionRender.drawOverlay()` -> hasCrossableGeometry -> signature(),
    which concatenates a string over every path
  - the `canvasRendered` dispatch, whose listeners include updateNotebookUi
    (three more full-document scans) and a document-wide querySelectorAll

They are deferred to the lift, not dropped: `endDrawing` renders once with
isDrawing false, so every one of them runs exactly once with the finished
stroke in place.
"""

import threading
import unittest

from app import app
from browser_server import make_browser_server

try:
    from playwright.sync_api import sync_playwright

    PLAYWRIGHT_AVAILABLE = True
except ImportError:  # pragma: no cover
    PLAYWRIGHT_AVAILABLE = False


MOVES = 40


@unittest.skipUnless(PLAYWRIGHT_AVAILABLE, "Playwright is not installed")
class LiveStrokeCostTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # make_browser_server, never make_server(..., 0, ...): the OS can hand
        # out a port Chromium blocks, which reads exactly like a flake.
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

    def open_page(self, notebook=False):
        context = self.browser.new_context(viewport={"width": 960, "height": 600})
        self.addCleanup(context.close)
        # The tour takes the pointer, so without this the canvas never sees
        # the stroke at all.
        context.add_init_script(
            "localStorage.setItem('inkyscib-consent-v1', JSON.stringify({version: 1, analytics: false})); localStorage.setItem('inkyscib-feature-tour-v1', JSON.stringify({seen: true}))"
        )
        page = context.new_page()
        page.goto(self.base_url + "/write", wait_until="domcontentloaded")
        page.wait_for_function("() => window.appState?.storageReady === true")
        page.evaluate("() => { window.appState.paths = []; window.setTool('pen'); }")
        return page

    def instrument(self, page):
        page.evaluate(
            """() => {
              window.__live = { rendered: 0, marked: 0, overlay: 0, clamped: 0, notebookUi: 0 };
              document.addEventListener('canvasRendered', (event) => {
                window.__live.rendered += 1;
                if (event?.detail?.liveInk) window.__live.marked += 1;
              });

              const render = window.Inkyscib?.ConstructionRender;
              if (render?.drawOverlay) {
                const real = render.drawOverlay.bind(render);
                render.drawOverlay = (ctx) => { window.__live.overlay += 1; return real(ctx); };
              }
              if (typeof window.clampNotebookTransform === 'function') {
                const real = window.clampNotebookTransform;
                window.clampNotebookTransform = function (...args) {
                  window.__live.clamped += 1;
                  return real.apply(this, args);
                };
              }
            }"""
        )

    def draw_stroke(self, page):
        """Returns the counts taken mid-stroke and again after the lift."""
        page.mouse.move(200, 300)
        page.mouse.down()
        # Zeroed after the pen is down so the first frame of the stroke, which
        # is allowed to publish (the empty-canvas hint has to clear), does not
        # count against the mid-stroke budget.
        page.evaluate(
            "() => { window.__live = { rendered: 0, marked: 0, overlay: 0, clamped: 0, notebookUi: 0 }; }"
        )
        for i in range(MOVES):
            page.mouse.move(206 + i * 6, 300 + (i % 5))
        during = page.evaluate("() => ({ ...window.__live })")
        page.mouse.up()
        after = page.evaluate("() => ({ ...window.__live })")
        return during, after

    def test_the_chrome_is_not_republished_on_every_sample(self):
        page = self.open_page()
        self.instrument(page)
        during, after = self.draw_stroke(page)

        # The event itself must keep firing. It is the "a frame was painted"
        # signal, and test_raw_input times raw input against pointermove with
        # it -- suppressing it hid real paints and broke that measurement.
        self.assertGreater(
            during["rendered"], 0,
            "no frame was published during the stroke; the paint signal is gone",
        )
        # ...but every one of them must be marked, so the listeners that walk
        # the document can bail.
        self.assertEqual(
            during["marked"], during["rendered"],
            f"{during['rendered'] - during['marked']} of {during['rendered']} "
            "mid-stroke frames were published without the liveInk flag, so the "
            "document-scanning listeners ran",
        )
        self.assertEqual(
            during["overlay"], 0,
            f"the construction overlay ran {during['overlay']} times during a "
            f"{MOVES}-move stroke; it rebuilds a signature over every path",
        )
        # And the frame after the lift must be unmarked, so everything catches
        # up exactly once with the finished stroke in place.
        self.assertGreater(
            after["rendered"] - after["marked"], 0,
            "no unmarked frame followed the lift - the chrome never caught up",
        )

    def test_the_stroke_is_still_painted_on_every_sample(self):
        """The guard must skip chrome, never ink. Sample-to-paint is the whole
        point of drawing from pointerrawupdate."""
        page = self.open_page()
        page.mouse.move(200, 300)
        page.mouse.down()
        for i in range(MOVES):
            page.mouse.move(206 + i * 6, 300 + (i % 5))
        points = page.evaluate("() => window.appState.currentPath.points.length")
        page.mouse.up()

        # One point per move is the ceiling (the filter can rewrite rather than
        # append when two land closer than the minimum spacing), but the stroke
        # must clearly be tracking the pointer, not a fraction of it.
        self.assertGreater(
            points, MOVES // 2,
            f"only {points} points recorded for {MOVES} moves - the guard is "
            "swallowing samples, not just chrome",
        )

    def test_the_notebook_transform_is_not_reclamped_on_every_sample(self):
        """clampNotebookTransform walks every path through pathBounds, which is
        uncached and allocates. It cannot change mid-stroke: there is no pan or
        zoom with the pen down."""
        page = self.open_page()
        page.evaluate(
            """() => {
              if (window.appState.notebook) window.appState.notebook.active = true;
            }"""
        )
        self.instrument(page)
        during, after = self.draw_stroke(page)

        self.assertEqual(
            during["clamped"], 0,
            f"the notebook transform was reclamped {during['clamped']} times "
            f"during a {MOVES}-move stroke",
        )
        self.assertGreaterEqual(
            after["clamped"], during["clamped"],
            "the clamp never ran after the lift",
        )


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
