import threading
import unittest
from datetime import datetime
from urllib.parse import parse_qs, urlparse
from zoneinfo import ZoneInfo

from app import app


try:
    from playwright.sync_api import sync_playwright
    from werkzeug.serving import make_server

    PLAYWRIGHT_AVAILABLE = True
except ImportError:
    PLAYWRIGHT_AVAILABLE = False


@unittest.skipUnless(PLAYWRIGHT_AVAILABLE, "Playwright is not installed")
class PlannerDeepLinkTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = make_server("127.0.0.1", 0, app, threaded=True)
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

    def test_planner_deep_link_opens_requested_date_and_cleans_its_query(self):
        context = self.browser.new_context(timezone_id="Asia/Kolkata")
        self.addCleanup(context.close)
        page = context.new_page()
        page.clock.install(
            time=datetime(
                2026,
                7,
                18,
                15,
                0,
                0,
                tzinfo=ZoneInfo("Asia/Kolkata"),
            )
        )

        page.goto(
            self.base_url
            + "/write?keep=canvas&planner=1&date=2026-08-09#drawing",
            wait_until="domcontentloaded",
        )
        page.clock.run_for(10)
        page.locator("#plannerModal.is-open").wait_for(state="visible")

        self.assertEqual(
            page.locator(
                '.planner-day[data-date="2026-08-09"]'
            ).get_attribute("aria-pressed"),
            "true",
        )
        self.assertIn(
            "August 9, 2026",
            page.locator("#plannerSelectedDate").inner_text(),
        )

        parsed_url = urlparse(page.url)
        query = parse_qs(parsed_url.query)
        self.assertEqual(query.get("keep"), ["canvas"])
        self.assertNotIn("planner", query)
        self.assertNotIn("date", query)
        self.assertEqual(parsed_url.fragment, "drawing")


if __name__ == "__main__":
    unittest.main()
