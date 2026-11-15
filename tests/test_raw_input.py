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
            "localStorage.setItem('inkyscib-consent-v1', JSON.stringify({version: 1, analytics: false})); localStorage.setItem('inkyscib-feature-tour-v1', JSON.stringify({seen: true}))"
        )
        page = context.new_page()
        page.goto(self.base_url + "/write", wait_until="domcontentloaded")
        page.wait_for_function("() => window.appState?.storageReady === true")
        page.evaluate("() => { window.appState.paths = []; window.setTool('pen'); }")
        return page

    def stroke_times(self, page, raw):
        """Draws a 40-move stroke and returns its point times before the pen
        lifts, while nothing has tidied the stroke yet."""
        page.evaluate("(raw) => window.__inkyscibSetRawInput(raw)", raw)
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
