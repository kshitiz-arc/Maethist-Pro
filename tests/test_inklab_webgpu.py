"""InkLab on a real WebGPU device.

Bundled Playwright Chromium finds a WebGPU adapter on this machine but cannot
create a device - `requestDevice` fails loading dxil.dll. The installed Chrome
can, headless, on the page and inside a worker (probed 2026-09-13). So these
tests launch `channel='chrome'`, and skip - saying why - wherever that browser or
its device is missing, rather than failing.
"""

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


# Every sample carries a numeric pressure: WGSL has no "is a number" test, so
# the GPU copy of the formula cannot take the 0.55 fallback. The samples reach a
# zero-length segment (samples 2 and 3) and a zero time interval (samples 3 and
# 4), which the formula turns into 16 ms.
PARITY_SAMPLES = [
    {"x": 100.0, "y": 200.0, "pressure": 0.2, "time": 0.0},
    {"x": 104.5, "y": 201.0, "pressure": 0.3, "time": 8.0},
    {"x": 111.0, "y": 203.5, "pressure": 0.45, "time": 16.0},
    {"x": 111.0, "y": 203.5, "pressure": 0.5, "time": 24.0},
    {"x": 125.0, "y": 210.0, "pressure": 0.6, "time": 24.0},
    {"x": 140.0, "y": 214.0, "pressure": 0.7, "time": 33.0},
    {"x": 160.0, "y": 216.0, "pressure": 0.9, "time": 41.0},
    {"x": 175.0, "y": 219.0, "pressure": 0.8, "time": 49.0},
    {"x": 183.0, "y": 224.0, "pressure": 0.65, "time": 57.0},
    {"x": 188.0, "y": 231.0, "pressure": 0.5, "time": 65.0},
    {"x": 190.0, "y": 240.0, "pressure": 0.35, "time": 73.0},
    {"x": 190.5, "y": 251.0, "pressure": 0.25, "time": 81.0},
]

# Just enough for the compute pass to need a device.
DEVICE_PROBE = PARITY_SAMPLES[:2]

# The worker answers each request by id. If it never does, fail with a reason
# after a few seconds instead of hanging the whole run.
WITH_TIMEOUT = """
async ({ call, args, ms }) => Promise.race([
  window.InkLab.lab[call](...args),
  new Promise((resolve) => setTimeout(() => resolve({ timedOut: true }), ms))
])
"""


@unittest.skipUnless(PLAYWRIGHT_AVAILABLE, "Playwright is not installed")
class InkLabWebGpuTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = make_browser_server(app)
        cls.server_thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.server_thread.start()
        cls.base_url = f"http://127.0.0.1:{cls.server.server_port}"
        cls.playwright = sync_playwright().start()
        try:
            cls.browser = cls.playwright.chromium.launch(channel="chrome", headless=True)
            cls.launch_error = None
        except Exception as error:  # Chrome is not installed here
            cls.browser = None
            cls.launch_error = error

    @classmethod
    def tearDownClass(cls):
        if cls.browser is not None:
            cls.browser.close()
        cls.playwright.stop()
        cls.server.shutdown()
        cls.server_thread.join(timeout=3)

    def open_lab(self):
        if self.browser is None:
            self.skipTest(f"system Chrome is not available: {self.launch_error}")
        context = self.browser.new_context(viewport={"width": 1000, "height": 700})
        self.addCleanup(context.close)
        page = context.new_page()
        page.goto(self.base_url + "/lab/ink", wait_until="domcontentloaded")
        page.wait_for_function("() => !!(window.InkLab && window.InkLab.lab)", timeout=10000)
        ready = page.evaluate("() => window.InkLab.lab.ready")
        return page, ready

    def call(self, page, name, *args, ms=8000):
        result = page.evaluate(WITH_TIMEOUT, {"call": name, "args": list(args), "ms": ms})
        self.assertNotIn(
            "timedOut",
            result,
            f"the worker never answered {name}; page errors: "
            f"{page.evaluate('() => window.InkLab.lab.errors')}",
        )
        return result

    def require_gpu_device(self, page):
        """Skips only where no WebGPU device exists at all.

        If the compute pass can get a device, drawing must be on WebGPU too -
        so a Canvas2D backend here is a failure, not a reason to skip. Without
        this distinction the render tests would pass on Canvas2D and prove
        nothing about the GPU."""
        probe = self.call(page, "tessellate", DEVICE_PROBE, 4)
        if probe["backend"] != "webgpu":
            self.skipTest(f"no WebGPU device: {probe.get('reason')}")

    def assert_drawing_on_webgpu(self, ready):
        self.assertEqual(ready["backend"], "webgpu", f"fell back: {ready['fallbackReason']}")

    def assert_relatively_close(self, actual, expected, label):
        tolerance = 1e-4 * max(abs(expected), 1e-6)
        self.assertLessEqual(
            abs(actual - expected), tolerance, f"{label}: GPU {actual} vs JS {expected}"
        )

    def test_gpu_tessellated_widths_match_the_js_reference(self):
        page, _ = self.open_lab()
        result = self.call(page, "tessellate", PARITY_SAMPLES, 4)
        if result["backend"] != "webgpu":
            self.skipTest(f"no WebGPU device for the compute pass: {result.get('reason')}")

        dpr = result["dpr"]
        gpu_radii = result["gpuRadii"]
        js_widths = result["jsWidths"]
        self.assertEqual(len(gpu_radii), len(PARITY_SAMPLES) - 1)
        self.assertEqual(len(js_widths), len(PARITY_SAMPLES))

        # gpuRadii are device px, half a width; jsWidths are CSS px.
        for k, (ra, rb) in enumerate(gpu_radii):
            self.assert_relatively_close(ra * 2 / dpr, js_widths[k], f"segment {k} start")
            self.assert_relatively_close(rb * 2 / dpr, js_widths[k + 1], f"segment {k} end")

    def test_drawing_uses_webgpu_when_a_device_exists(self):
        page, ready = self.open_lab()
        self.require_gpu_device(page)
        self.assert_drawing_on_webgpu(ready)
        self.assertEqual(ready["fallbackReason"], "")
        self.assertEqual(page.evaluate("() => window.InkLab.lab.errors"), [])

    def test_an_injected_stroke_is_baked_into_the_gpu_texture(self):
        page, ready = self.open_lab()
        self.require_gpu_device(page)
        self.assert_drawing_on_webgpu(ready)
        page.evaluate(INJECT_STROKE, stroke())
        snapshot = snapshot_until(self, page, lambda s: s["finishedStrokes"] == 1)
        self.assertEqual(snapshot["backend"], "webgpu")
        self.assertGreater(snapshot["inked"], 500)
        self.assertEqual(snapshot["overflow"], 0)
        self.assertEqual(page.evaluate("() => window.InkLab.lab.errors"), [])

    def test_strokes_reach_the_screen_through_both_webgpu_present_paths(self):
        page, ready = self.open_lab()
        self.require_gpu_device(page)
        self.assert_drawing_on_webgpu(ready)
        assert_stroke_reaches_the_screen(self, page)
        self.assertEqual(page.evaluate("() => window.InkLab.lab.errors"), [])

    def test_clear_empties_the_gpu_texture(self):
        page, ready = self.open_lab()
        self.require_gpu_device(page)
        self.assert_drawing_on_webgpu(ready)
        page.evaluate(INJECT_STROKE, stroke())
        snapshot_until(self, page, lambda s: s["finishedStrokes"] == 1 and s["inked"] > 0)
        page.evaluate("() => window.InkLab.lab.clear()")
        snapshot = snapshot_until(self, page, lambda s: s["finishedStrokes"] == 0)
        self.assertEqual(snapshot["inked"], 0)
        self.assertEqual(page.evaluate("() => window.InkLab.lab.errors"), [])


if __name__ == "__main__":
    unittest.main()
