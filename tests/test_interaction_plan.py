"""Regression coverage for the September canvas interaction pass."""

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
class InteractionPlanTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        app.config["TESTING"] = True
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
        page.evaluate(
            "localStorage.setItem('inkyscib-consent-v1', JSON.stringify({version: 1, analytics: false})); localStorage.setItem('inkyscib-feature-tour-v1', JSON.stringify({seen: true}))"
        )
        page.goto(url)
        # Passed as an arrow function, not a bare expression: Playwright
        # evaluates a bare expression with eval(), which the editor's CSP
        # forbids, and this file opens a plain page with no context to set
        # bypass_csp=True on. The other files that pass bare expressions all
        # set that flag; this one did not, so the wait failed intermittently
        # with an EvalError. A function predicate needs no eval at all, which
        # also keeps the real CSP in force for the test.
        page.wait_for_function(
            "() => window.appState?.storageReady === true", timeout=30000
        )

    def test_double_click_switches_to_pen_and_a_retap_closes_pen_options(self):
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch()
            page = browser.new_page()
            self.open_editor(page)

            page.evaluate("window.setTool('eraser')")
            page.dispatch_event("#drawingCanvas", "dblclick", {"button": 0})
            self.assertEqual(page.evaluate("window.appState.currentTool"), "pen")

            page.evaluate("window.Inkyscib.ToolDock.setCollapsed(false)")
            page.click("#penTool")
            page.wait_for_timeout(50)
            self.assertTrue(page.evaluate("window.Inkyscib.ToolDock.isCollapsed()"))
            browser.close()

    def test_lines_are_finite_segments_and_no_ray_or_infinite_choices_remain(self):
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch()
            page = browser.new_page()
            self.open_editor(page)
            result = page.evaluate(
                """() => {
                  const a = {x: 10, y: 20};
                  const b = {x: 50, y: 80};
                  const ends = extendLineForKind(a, b, 'line', null);
                  return {
                    choices: document.querySelectorAll('.line-kind-btn').length,
                    ends,
                    mode: window.Inkyscib.Construction.drawnLineMode?.({lineKind: 'ray'}) || 'segment'
                  };
                }"""
            )
            self.assertEqual(result["choices"], 0)
            self.assertEqual(result["ends"], [{"x": 10, "y": 20}, {"x": 50, "y": 80}])
            self.assertEqual(result["mode"], "segment")
            browser.close()

    def test_selected_line_legend_controls_edit_that_line(self):
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch()
            page = browser.new_page()
            self.open_editor(page)
            result = page.evaluate(
                """() => {
                  const state = window.appState;
                  state.paths = [{
                    tool: 'line', points: [{x: 100, y: 100}, {x: 220, y: 100}],
                    size: 2, lineKind: 'segment', showLength: false
                  }];
                  window.setTool('select');
                  window.Inkyscib.Selection.selectIndex(0);
                  window.setTool('line');
                  const toggle = document.getElementById('lineDefaultLength');
                  toggle.checked = true;
                  toggle.dispatchEvent(new Event('change', {bubbles: true}));
                  return {
                    selected: window.Inkyscib.Selection.selectedIndex(),
                    showLength: state.paths[0].showLength
                  };
                }"""
            )
            self.assertEqual(result, {"selected": 0, "showLength": True})
            browser.close()

    def test_angle_pick_cue_clears_and_selected_angle_legend_is_editable(self):
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch()
            page = browser.new_page()
            self.open_editor(page)
            result = page.evaluate(
                """() => {
                  const state = window.appState;
                  state.transform = {scale: 1, offsetX: 0, offsetY: 0};
                  state.paths = [
                    {tool: 'line', points: [{x: 200, y: 200}, {x: 360, y: 200}], size: 2, lineKind: 'segment'},
                    {tool: 'line', points: [{x: 200, y: 200}, {x: 200, y: 360}], size: 2, lineKind: 'segment'}
                  ];
                  window.Inkyscib.Construction.rebuildIndex(true);
                  window.setTool('angle');
                  const canvas = document.getElementById('drawingCanvas');
                  const rect = canvas.getBoundingClientRect();
                  const eventAt = (x, y) => ({clientX: rect.left + x, clientY: rect.top + y});
                  window.Inkyscib.AngleTool.handleDown(eventAt(280, 200));
                  const cue = window.Inkyscib.AngleTool.getOverlayState().firstPicked;
                  window.Inkyscib.AngleTool.handleDown(eventAt(200, 280));
                  const cleared = window.Inkyscib.AngleTool.getOverlayState().firstPicked;
                  const angleIndex = state.paths.findIndex(path => path.geomType === 'angle');
                  window.setTool('select');
                  window.Inkyscib.Selection.selectIndex(angleIndex);
                  window.setTool('angle');
                  const toggle = document.getElementById('angleShowText');
                  toggle.checked = false;
                  toggle.dispatchEvent(new Event('change', {bubbles: true}));
                  return {
                    cue: !!cue?.pickedAt,
                    cleared,
                    angleIndex,
                    labelVisible: state.paths[angleIndex]?.showAngle !== false,
                    selected: window.Inkyscib.Selection.selectedIndex()
                  };
                }"""
            )
            self.assertTrue(result["cue"])
            self.assertIsNone(result["cleared"])
            self.assertGreaterEqual(result["angleIndex"], 2)
            self.assertFalse(result["labelVisible"])
            self.assertEqual(result["selected"], result["angleIndex"])
            browser.close()

    def test_lasso_and_whole_object_eraser_remove_complete_objects(self):
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch()
            page = browser.new_page()
            self.open_editor(page)
            canvas = page.locator("#drawingCanvas")
            box = canvas.bounding_box()
            polygon = [
                (box["x"] + 300, box["y"] + 240),
                (box["x"] + 460, box["y"] + 240),
                (box["x"] + 460, box["y"] + 330),
                (box["x"] + 300, box["y"] + 330),
            ]
            page.evaluate(
                """(screen) => {
                  const state = window.appState;
                  const world = screen.map(([clientX, clientY]) => window.getCanvasPos({clientX, clientY}));
                  state.paths = [
                    {tool: 'line', points: [world[0], world[2]], size: 2},
                    {tool: 'line', points: [{x: 900, y: 900}, {x: 980, y: 900}], size: 2}
                  ];
                  window.setTool('eraser');
                }""",
                polygon,
            )

            page.evaluate(
                """([clientX, clientY]) => document.querySelector('#drawingCanvas').dispatchEvent(
                  new MouseEvent('mousedown', {bubbles: true, button: 0, clientX, clientY})
                )""",
                polygon[0],
            )
            page.wait_for_timeout(560)
            self.assertTrue(page.evaluate("window.Inkyscib.Eraser.isLassoActive()"))
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

            result = page.evaluate(
                """() => {
                  const state = window.appState;
                  const afterLasso = state.paths.length;

                  state.paths.push({tool: 'line', points: [{x: 250, y: 250}, {x: 350, y: 250}], size: 2});
                  window.eraseInkyscibObjectsTouched(state.paths, {
                    tool: 'eraser', size: 30, points: [{x: 300, y: 245}, {x: 300, y: 255}]
                  });
                  return {afterLasso, final: state.paths.length};
                }"""
            )
            self.assertEqual(result, {"afterLasso": 1, "final": 1})
            browser.close()
