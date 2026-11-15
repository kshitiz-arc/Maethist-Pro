"""The two crawler-facing things a test client cannot see: layout shift and
mobile overflow. Conventions here are the house ones -- dismiss the tour, use
make_browser_server, pass wait_for_function an arrow function.
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

MARKETING_PAGES = ("/", "/features", "/about")

COLLECT_VITALS = """
() => new Promise((resolve) => {
  let cls = 0;
  let lcp = 0;
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (!entry.hadRecentInput) { cls += entry.value; }
    }
  }).observe({ type: 'layout-shift', buffered: true });
  new PerformanceObserver((list) => {
    const entries = list.getEntries();
    lcp = entries[entries.length - 1].startTime;
  }).observe({ type: 'largest-contentful-paint', buffered: true });
  setTimeout(() => resolve({ cls, lcp }), 1500);
})
"""


@unittest.skipUnless(PLAYWRIGHT_AVAILABLE, "Playwright is not installed")
class WebVitalsTests(unittest.TestCase):
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

    def _vitals(self, path):
        page = self.browser.new_page(viewport={"width": 1280, "height": 900})
        page.add_init_script(
            "localStorage.setItem('inkyscib-feature-tour-v1', 'dismissed')"
        )
        try:
            page.goto(f"{self.base_url}{path}", wait_until="load")
            return page.evaluate(COLLECT_VITALS)
        finally:
            page.close()

    def test_no_marketing_page_shifts_its_layout_after_paint(self):
        for path in MARKETING_PAGES:
            with self.subTest(path=path):
                self.assertLess(self._vitals(path)["cls"], 0.1)

    def test_largest_contentful_paint_stays_inside_the_good_threshold(self):
        # Served from localhost, so this is a regression guard rather than a
        # field measurement: if it creeps past 2.5s here, something is very
        # wrong. Real numbers come from Search Console's Core Web Vitals
        # report once traffic exists.
        for path in MARKETING_PAGES:
            with self.subTest(path=path):
                self.assertLess(self._vitals(path)["lcp"], 2500)


VIEWPORTS = (
    ("phone", 360, 740),
    ("tablet-768", 768, 1024),
    ("tablet-960", 960, 600),   # the device this product is written for
)


@unittest.skipUnless(PLAYWRIGHT_AVAILABLE, "Playwright is not installed")
class MobileLayoutTests(unittest.TestCase):
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

    def _page(self, width, height, path):
        page = self.browser.new_page(viewport={"width": width, "height": height})
        page.add_init_script(
            "localStorage.setItem('inkyscib-feature-tour-v1', 'dismissed')"
        )
        page.goto(f"{self.base_url}{path}", wait_until="load")
        return page

    def test_nothing_scrolls_sideways_at_any_target_width(self):
        for name, width, height in VIEWPORTS:
            for path in MARKETING_PAGES:
                with self.subTest(viewport=name, path=path):
                    page = self._page(width, height, path)
                    try:
                        overflow = page.evaluate(
                            "() => document.documentElement.scrollWidth"
                            " - document.documentElement.clientWidth"
                        )
                    finally:
                        page.close()
                    self.assertLessEqual(overflow, 1, f"{name} {path}: {overflow}px")

    def test_header_controls_meet_the_44px_touch_floor_on_a_phone(self):
        page = self._page(360, 740, "/")
        try:
            heights = page.eval_on_selector_all(
                "header .nav a, header .write-btn, header .icon-btn",
                "nodes => nodes.map(node => node.getBoundingClientRect().height)",
            )
        finally:
            page.close()

        self.assertTrue(heights)
        for height in heights:
            with self.subTest(height=height):
                self.assertGreaterEqual(round(height), 44)

    def test_the_viewport_is_declared_without_locking_zoom(self):
        page = self._page(360, 740, "/")
        try:
            content = page.get_attribute('meta[name="viewport"]', "content")
        finally:
            page.close()

        self.assertIn("width=device-width", content)
        self.assertNotIn("user-scalable=no", content)
        self.assertNotIn("maximum-scale=1", content)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
