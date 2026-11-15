"""InkLab: the cross-origin-isolated ink lab at /lab/ink.

Two layers. The header tests use Flask's test client and need no browser. They
are also the guard that keeps isolation off /write, where COEP would block the
cross-origin YouTube player.

The page tests drive bundled Playwright Chromium, which on this machine finds a
WebGPU adapter but cannot create a device (`requestDevice` fails loading
dxil.dll). So they exercise the Canvas2D backend and everything that does not
depend on the GPU: isolation, the worker, the ring, stroke assembly, baking.
The GPU path is covered by test_inklab_webgpu.py.
"""

import re
import threading
import unittest

from app import app
from browser_server import make_browser_server
from inklab_helpers import (
    INJECT_STROKE,
    assert_stroke_reaches_the_screen,
    snapshot_until,
    stroke,
)


try:
    from playwright.sync_api import sync_playwright

    PLAYWRIGHT_AVAILABLE = True
except ImportError:
    PLAYWRIGHT_AVAILABLE = False


ISOLATION = {
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
}


class InkLabHeaderTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = app.test_client()

    def assert_isolated(self, path):
        with self.client.get(path) as response:
            self.assertEqual(response.status_code, 200, path)
            for header, value in ISOLATION.items():
                self.assertEqual(response.headers.get(header), value, f"{header} on {path}")

    def assert_not_isolated(self, path):
        with self.client.get(path) as response:
            self.assertEqual(response.status_code, 200, path)
            for header in ISOLATION:
                self.assertIsNone(response.headers.get(header), f"{header} leaked onto {path}")

    def test_the_lab_page_is_cross_origin_isolated(self):
        self.assert_isolated("/lab/ink")

    def test_the_render_worker_script_carries_its_own_isolation_headers(self):
        # Probed 2026-09-13: an isolated page's worker is blocked outright unless
        # the worker script's own response carries COOP and COEP.
        self.assert_isolated("/static/js/inklab/render-worker.js")

    def test_the_editor_is_not_isolated(self):
        self.assert_not_isolated("/write")

    def test_other_static_files_are_not_isolated(self):
        self.assert_not_isolated("/static/js/core.js")

    def test_the_lab_page_loads_nothing_from_another_origin(self):
        with self.client.get("/lab/ink") as response:
            # Without this the test passes against a 404 page.
            self.assertEqual(response.status_code, 200)
            html = response.get_data(as_text=True)
        external = re.findall(r"""(?:src|href)\s*=\s*["'](?:https?:)?//[^"']+""", html)
        self.assertEqual(external, [], "require-corp would block these")


@unittest.skipUnless(PLAYWRIGHT_AVAILABLE, "Playwright is not installed")
class InkLabPageTests(unittest.TestCase):
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

    def open_lab(self):
        context = self.browser.new_context(viewport={"width": 1000, "height": 700})
        self.addCleanup(context.close)
        page = context.new_page()
        page.goto(self.base_url + "/lab/ink", wait_until="domcontentloaded")
        page.wait_for_function("() => !!(window.InkLab && window.InkLab.lab)", timeout=10000)
        ready = page.evaluate("() => window.InkLab.lab.ready")
        return page, ready

    def assert_no_lab_errors(self, page):
        self.assertEqual(page.evaluate("() => window.InkLab.lab.errors"), [])

    def test_the_page_is_isolated_and_says_why_it_fell_back_to_canvas2d(self):
        page, ready = self.open_lab()
        self.assertTrue(page.evaluate("() => self.crossOriginIsolated"))
        self.assertEqual(ready["backend"], "canvas2d")
        self.assertTrue(ready["fallbackReason"], "a fallback must state its reason")
        self.assert_no_lab_errors(page)

    def test_an_injected_stroke_is_baked(self):
        page, _ = self.open_lab()
        page.evaluate(INJECT_STROKE, stroke())
        snapshot = snapshot_until(self, page, lambda s: s["finishedStrokes"] == 1)
        self.assertGreater(snapshot["inked"], 500)
        self.assertEqual(snapshot["overflow"], 0)
        self.assertIsNotNone(snapshot["bbox"])
        self.assert_no_lab_errors(page)

    def test_predicted_samples_are_never_baked(self):
        page, _ = self.open_lab()
        # Stroke A carries predictions 200 px below its own path. If any of them
        # reached the baked layer, the ink would cover a different area.
        page.evaluate(INJECT_STROKE, stroke(predicted_every=10, predicted_offset=200))
        with_predictions = snapshot_until(self, page, lambda s: s["finishedStrokes"] == 1)

        page.evaluate("() => window.InkLab.lab.clear()")
        snapshot_until(self, page, lambda s: s["finishedStrokes"] == 0 and s["inked"] == 0)

        page.evaluate(INJECT_STROKE, stroke())
        without = snapshot_until(self, page, lambda s: s["finishedStrokes"] == 1)

        self.assertEqual(with_predictions["inked"], without["inked"])
        self.assertEqual(with_predictions["bbox"], without["bbox"])
        self.assert_no_lab_errors(page)

    def test_a_real_pointer_stroke_is_captured_and_baked(self):
        # Real pointer events this time, through getCoalescedEvents into the
        # ring, rather than samples injected through the test seam.
        page, _ = self.open_lab()
        page.mouse.move(150, 300)
        page.mouse.down()
        page.mouse.move(450, 340, steps=30)
        page.mouse.up()

        snapshot = snapshot_until(self, page, lambda s: s["finishedStrokes"] == 1)
        self.assertGreater(snapshot["inked"], 500)
        self.assertEqual(snapshot["overflow"], 0)

        dpr = page.evaluate("() => window.devicePixelRatio")
        bbox = snapshot["bbox"]
        self.assertLessEqual(abs(bbox["left"] - 150 * dpr), 20, bbox)
        self.assertLessEqual(abs(bbox["right"] - 450 * dpr), 20, bbox)
        self.assert_no_lab_errors(page)

    def test_a_steady_stroke_is_predicted_by_the_polynomial_predictor(self):
        # No native predictions are injected and the pen is still down, so the
        # worker has to extrapolate the stroke ahead by itself.
        page, _ = self.open_lab()
        page.evaluate(INJECT_STROKE, dict(stroke(finish=False), moves=8))
        snapshot = snapshot_until(
            self,
            page,
            lambda s: s["activeSamples"] >= 4 and s["predictionSource"] != "none",
            timeout=3.0,
        )
        self.assertEqual(snapshot["predictionSource"], "polynomial")
        self.assert_no_lab_errors(page)

    def test_strokes_reach_the_screen_through_both_present_paths(self):
        page, _ = self.open_lab()
        assert_stroke_reaches_the_screen(self, page)
        self.assert_no_lab_errors(page)

    def test_clear_empties_the_baked_layer(self):
        page, _ = self.open_lab()
        page.evaluate(INJECT_STROKE, stroke())
        snapshot_until(self, page, lambda s: s["finishedStrokes"] == 1 and s["inked"] > 0)
        page.evaluate("() => window.InkLab.lab.clear()")
        snapshot = snapshot_until(self, page, lambda s: s["finishedStrokes"] == 0)
        self.assertEqual(snapshot["inked"], 0)
        self.assert_no_lab_errors(page)


if __name__ == "__main__":
    unittest.main()
