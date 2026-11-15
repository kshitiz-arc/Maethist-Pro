"""The eraser's hold-to-lasso gesture can erase objects or select them.

Reported 2026-09-17: "Hold to draw a magnetic lasso is also like an object
clearing tool. There should be option for object or selection eraser in that."

The cause is sharper than the report: `finishLasso` never read
`toolSettings.eraser.mode` at all, so the panel could say Partial while the
hold gesture deleted whole objects regardless. A third `mode` value cannot fix
it -- `eraser.js` coerces anything that is not exactly "object" back to
"partial" on every read -- so the choice lives in its own key,
`toolSettings.eraser.lassoAction`.

Erase stays the default: `test_interaction_plan.py` pins lasso-deletes-objects
and people already rely on it.
"""

import threading
import unittest

from app import app
from browser_server import make_browser_server

try:
    from playwright.sync_api import sync_playwright

    BROWSER_AVAILABLE = True
except ImportError:  # pragma: no cover
    BROWSER_AVAILABLE = False


@unittest.skipUnless(BROWSER_AVAILABLE, "playwright is not installed")
class LassoActionTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        app.config["TESTING"] = True
        # Not make_server(..., 0, ...): the OS can hand out a port Chromium
        # blocks, which fails the whole class with ERR_UNSAFE_PORT and reads
        # exactly like a flake.
        cls.server = make_browser_server(app)
        cls.port = cls.server.server_port
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.thread.join(timeout=5)

    def open_editor(self, page):
        url = "http://127.0.0.1:%d/write" % self.port
        page.goto(url)
        # The first-run tour opens over the canvas and takes the pointer, so
        # without this the canvas never sees the gesture at all.
        page.evaluate(
            "localStorage.setItem('inkyscib-consent-v1', JSON.stringify({version: 1, analytics: false})); localStorage.setItem('inkyscib-feature-tour-v1', JSON.stringify({seen: true}))"
        )
        page.goto(url)
        # An arrow function, not a bare expression: Playwright evaluates bare
        # expressions with eval(), which the editor's CSP forbids.
        page.wait_for_function(
            "() => window.appState?.storageReady === true", timeout=30000
        )

    def seed_two_lines(self, page, polygon):
        """One line inside the polygon, one far outside it."""
        page.evaluate(
            """(screen) => {
              const state = window.appState;
              const world = screen.map(([clientX, clientY]) =>
                window.getCanvasPos({clientX, clientY}));
              state.paths = [
                {tool: 'line', points: [world[0], world[2]], size: 2},
                {tool: 'line', points: [{x: 900, y: 900}, {x: 980, y: 900}], size: 2}
              ];
              window.setTool('eraser');
            }""",
            polygon,
        )

    def drag_lasso(self, page, polygon):
        """Hold past ERASER_HOLD_MS, trace the polygon, release."""
        page.evaluate(
            """([clientX, clientY]) => document.querySelector('#drawingCanvas').dispatchEvent(
              new MouseEvent('mousedown', {bubbles: true, button: 0, clientX, clientY})
            )""",
            polygon[0],
        )
        # ERASER_HOLD_MS is 520.
        page.wait_for_timeout(560)
        self.assertTrue(
            page.evaluate("window.Inkyscib.Eraser.isLassoActive()"),
            "the hold never armed the lasso",
        )
        for point in polygon[1:]:
            page.evaluate(
                """([clientX, clientY]) => document.querySelector('#drawingCanvas').dispatchEvent(
                  new MouseEvent('mousemove', {bubbles: true, buttons: 1, clientX, clientY})
                )""",
                point,
            )
        page.evaluate(
            """([clientX, clientY]) => {
              const canvas = document.querySelector('#drawingCanvas');
              canvas.dispatchEvent(new MouseEvent('mousemove', {
                bubbles: true, buttons: 1, clientX, clientY
              }));
              canvas.dispatchEvent(new MouseEvent('mouseup', {
                bubbles: true, button: 0, clientX, clientY
              }));
            }""",
            polygon[0],
        )

    @staticmethod
    def polygon_for(box):
        return [
            (box["x"] + 300, box["y"] + 240),
            (box["x"] + 460, box["y"] + 240),
            (box["x"] + 460, box["y"] + 330),
            (box["x"] + 300, box["y"] + 330),
        ]

    def test_lasso_selects_the_encircled_objects_without_erasing_them(self):
        """lassoAction 'select' hands the objects to Selection instead of deleting."""
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch()
            page = browser.new_page()
            self.open_editor(page)
            polygon = self.polygon_for(page.locator("#drawingCanvas").bounding_box())
            self.seed_two_lines(page, polygon)
            page.evaluate(
                "window.appState.toolSettings.eraser.lassoAction = 'select'"
            )

            self.drag_lasso(page, polygon)

            result = page.evaluate(
                """() => ({
                  paths: window.appState.paths.length,
                  selected: window.Inkyscib.Selection.selectedIndices(),
                  tool: window.appState.currentTool
                })"""
            )
            # Nothing is deleted...
            self.assertEqual(result["paths"], 2)
            # ...the encircled line is selected...
            self.assertEqual(result["selected"], [0])
            # ...and the tool has moved to select, so the handles are usable.
            self.assertEqual(result["tool"], "select")
            browser.close()

    def test_lasso_still_erases_by_default(self):
        """Erase is the default, so existing muscle memory is unchanged."""
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch()
            page = browser.new_page()
            self.open_editor(page)
            polygon = self.polygon_for(page.locator("#drawingCanvas").bounding_box())
            self.seed_two_lines(page, polygon)

            default_action = page.evaluate(
                "window.appState.toolSettings.eraser.lassoAction"
            )
            self.assertEqual(default_action, "erase")

            self.drag_lasso(page, polygon)

            self.assertEqual(page.evaluate("window.appState.paths.length"), 1)
            browser.close()

    def test_the_choice_survives_a_reload(self):
        """A setting that does not survive a reload has not been saved.

        storage.js exports a debounced scheduler as window.savePreferences, so
        the flush has to be awaited rather than assumed.
        """
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch()
            page = browser.new_page()
            self.open_editor(page)

            page.evaluate(
                """() => {
                  window.appState.toolSettings.eraser.lassoAction = 'select';
                  window.savePreferences();
                }"""
            )
            page.wait_for_function(
                """() => {
                  const raw = localStorage.getItem('inkyscib_settings');
                  if (!raw) return false;
                  return JSON.parse(raw)?.eraser?.lassoAction === 'select';
                }""",
                timeout=5000,
            )

            page.reload()
            page.wait_for_function(
                "() => window.appState?.storageReady === true", timeout=30000
            )
            self.assertEqual(
                page.evaluate("window.appState.toolSettings.eraser.lassoAction"),
                "select",
            )
            browser.close()

    def test_the_eraser_panel_offers_both_lasso_actions(self):
        """Both choices are real touch targets on the 960px tablet."""
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch()
            # Fixed at context creation: resizing a loaded editor flips it
            # between the two layouts, which is not how a tablet opens it.
            context = browser.new_context(viewport={"width": 960, "height": 720})
            page = context.new_page()
            self.open_editor(page)

            page.evaluate("window.setTool('eraser')")
            page.evaluate("window.Inkyscib.ToolDock.setCollapsed(false)")

            buttons = page.locator("#eraserOptions [data-eraser-lasso]")
            self.assertEqual(buttons.count(), 2)

            values = page.eval_on_selector_all(
                "#eraserOptions [data-eraser-lasso]",
                "els => els.map(e => e.dataset.eraserLasso)",
            )
            self.assertEqual(sorted(values), ["erase", "select"])

            for index in range(buttons.count()):
                box = buttons.nth(index).bounding_box()
                self.assertGreaterEqual(box["width"], 44, values[index])
                self.assertGreaterEqual(box["height"], 44, values[index])

            # Clicking writes the setting through, the way the mode buttons do.
            page.click('#eraserOptions [data-eraser-lasso="select"]')
            self.assertEqual(
                page.evaluate("window.appState.toolSettings.eraser.lassoAction"),
                "select",
            )
            self.assertEqual(
                page.get_attribute(
                    '#eraserOptions [data-eraser-lasso="select"]', "aria-pressed"
                ),
                "true",
            )
            browser.close()

    def test_a_lasso_erase_does_not_invalidate_the_whole_committed_layer(self):
        """The lasso must take the region-repair path, like the drag eraser.

        finishLasso called invalidateCanvasDrawingCache(), nulling the
        committed-layer meta and forcing a full O(N) rebuild, while
        __eraseObjectsTouched did not. That inconsistency cost a full replay of
        the document on every lasso.
        """
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch()
            page = browser.new_page()
            self.open_editor(page)
            polygon = self.polygon_for(page.locator("#drawingCanvas").bounding_box())
            self.seed_two_lines(page, polygon)

            # Settle the committed layer so there is a cache to preserve.
            page.evaluate("window.renderNow()")
            page.wait_for_function(
                "() => __committedLayerMeta != null", timeout=5000
            )

            # The hold and the trace, then the release read back synchronously:
            # finishLasso only *schedules* its redraw, so by the next animation
            # frame the layer has been rebuilt and the invalidation is invisible.
            page.evaluate(
                """([clientX, clientY]) => document.querySelector('#drawingCanvas').dispatchEvent(
                  new MouseEvent('mousedown', {bubbles: true, button: 0, clientX, clientY})
                )""",
                polygon[0],
            )
            page.wait_for_timeout(560)
            for point in polygon[1:]:
                page.evaluate(
                    """([clientX, clientY]) => document.querySelector('#drawingCanvas').dispatchEvent(
                      new MouseEvent('mousemove', {bubbles: true, buttons: 1, clientX, clientY})
                    )""",
                    point,
                )
            survived = page.evaluate(
                """([clientX, clientY]) => {
                  const canvas = document.querySelector('#drawingCanvas');
                  canvas.dispatchEvent(new MouseEvent('mousemove', {
                    bubbles: true, buttons: 1, clientX, clientY
                  }));
                  canvas.dispatchEvent(new MouseEvent('mouseup', {
                    bubbles: true, button: 0, clientX, clientY
                  }));
                  return __committedLayerMeta != null;
                }""",
                polygon[0],
            )

            # The layer was repaired, not thrown away and rebuilt from nothing.
            self.assertTrue(
                survived,
                "the lasso discarded the committed layer instead of repairing it",
            )
            browser.close()


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
