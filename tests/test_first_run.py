"""The first 30 seconds (static/js/first-run.js, 2.9.3).

On an empty canvas one button shows the canvas answering maths. Pinned: it is
only offered on an empty page, the demo is really read and answered, its ink
leaves the moment the canvas is touched, and it is never saved.
"""

import threading
import unittest
from pathlib import Path

from app import app
from browser_server import make_browser_server

try:
    from playwright.sync_api import sync_playwright

    PLAYWRIGHT_AVAILABLE = True
except ImportError:  # pragma: no cover
    PLAYWRIGHT_AVAILABLE = False

ROOT = Path(__file__).resolve().parents[1]


class DemoInkIsNeverSavedTests(unittest.TestCase):
    def test_the_serializer_drops_demo_ink(self):
        source = (ROOT / "static/js/storage.js").read_text(encoding="utf-8")
        start = source.index("function compactPath(path) {")
        self.assertIn("if (path?.firstRunDemo) return null;", source[start:start + 300])


@unittest.skipUnless(PLAYWRIGHT_AVAILABLE, "Playwright is not installed")
class FirstRunTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = make_browser_server(app)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base_url = f"http://127.0.0.1:{cls.server.server_port}"
        cls.playwright = sync_playwright().start()
        cls.browser = cls.playwright.chromium.launch(headless=True)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()
        cls.server.shutdown()
        cls.thread.join(timeout=3)

    def open(self):
        context = self.browser.new_context(viewport={"width": 1280, "height": 800})
        self.addCleanup(context.close)
        context.add_init_script("localStorage.setItem('inkyscib-feature-tour-v1', 'seen')")
        page = context.new_page()
        self.errors = []
        page.on("pageerror", lambda error: self.errors.append(str(error)))
        page.goto(self.base_url + "/write", wait_until="domcontentloaded")
        page.wait_for_function("() => window.appState?.storageReady === true && !!window.Inkyscib?.FirstRun")
        page.wait_for_timeout(300)
        return page

    def test_an_empty_page_offers_it_and_it_answers(self):
        page = self.open()
        page.wait_for_selector("#firstRunTry", state="visible")
        page.click("#firstRunTry")
        page.wait_for_selector("#inkMathChip:not([hidden])", timeout=15000)
        chip = page.evaluate("() => document.querySelector('#inkMathChip .im-say').textContent")
        self.assertEqual(chip, "= 19", "the real reader read the demo's ink")
        hidden = page.evaluate("() => getComputedStyle(document.getElementById('firstRunTry')).visibility")
        self.assertEqual(hidden, "hidden", "and the offer goes once there is ink on the page")
        self.assertEqual(self.errors, [])

    def test_touching_the_canvas_clears_the_demo(self):
        page = self.open()
        page.click("#firstRunTry")
        page.wait_for_selector("#inkMathChip:not([hidden])", timeout=15000)
        self.assertGreater(page.evaluate("() => window.appState.paths.filter((p) => p.firstRunDemo).length"), 0)
        page.mouse.click(300, 600)
        page.wait_for_timeout(150)
        self.assertEqual(page.evaluate("() => window.appState.paths.filter((p) => p.firstRunDemo).length"), 0)
        self.assertTrue(page.evaluate("() => document.getElementById('inkMathChip').hidden"))


if __name__ == "__main__":
    unittest.main()
