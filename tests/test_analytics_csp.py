"""There is no analytics, and nothing may quietly bring it back.

Version 2 removed Google Analytics, the consent banner that gated it and the
server endpoint that logged the answer. With no tracker there is nothing to
ask a visitor about, so the banner is not merely hidden: it does not exist.
These tests fail if a tag, a measurement id or an analytics origin returns to
a template, a script or the Content-Security-Policy.
"""

import re
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


ROOT = Path(app.root_path)
PAGES = ("/", "/features", "/about", "/write", "/legal/privacy", "/legal/cookies", "/legal/terms")
TRACKER_MARKS = (
    "googletagmanager",
    "google-analytics",
    "analytics.google.com",
    "gtag(",
    "dataLayer",
    "G-5SW3NRK6X6",
)


def parse_csp(header):
    directives = {}
    for section in header.split(";"):
        name, *sources = section.strip().split()
        if name:
            directives[name] = set(sources)
    return directives


class NoAnalyticsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = app.test_client()

    def test_no_page_carries_a_tracker(self):
        for path in PAGES:
            with self.subTest(path=path):
                html = self.client.get(path).get_data(as_text=True)
                for mark in TRACKER_MARKS:
                    self.assertNotIn(mark, html)

    def test_no_shipped_script_or_template_carries_a_tracker(self):
        files = [
            path
            for folder, pattern in (("static/js", "*.js"), ("templates", "*.html"), ("templates", "*.js"))
            for path in (ROOT / folder).rglob(pattern)
            if "vendor" not in path.parts
        ]
        self.assertTrue(files)
        for path in files:
            source = path.read_text(encoding="utf-8", errors="ignore")
            for mark in TRACKER_MARKS:
                with self.subTest(file=path.name, mark=mark):
                    self.assertNotIn(mark, source)

    def test_the_csp_allows_no_analytics_origin(self):
        for path in ("/", "/write"):
            with self.subTest(path=path):
                header = self.client.get(path).headers["Content-Security-Policy"]
                self.assertNotRegex(header, r"google-analytics|googletagmanager|analytics\.google")
                csp = parse_csp(header)
                self.assertEqual(csp["connect-src"], {"'self'", "https://cdn.jsdelivr.net"})

    def test_the_consent_banner_and_its_endpoint_are_gone(self):
        for path in PAGES:
            with self.subTest(path=path):
                html = self.client.get(path).get_data(as_text=True)
                self.assertNotIn("consentBanner", html)
                self.assertNotIn("Accept analytics", html)
                self.assertNotIn("doNotSellLink", html)
        self.assertEqual(self.client.post("/api/consent", json={"analytics": True}).status_code, 404)
        for gone in ("static/js/consent.js", "static/js/consent-banner.js", "templates/_consent_banner.html"):
            self.assertFalse((ROOT / gone).exists(), gone)

    def test_the_legal_pages_say_so(self):
        privacy = self.client.get("/legal/privacy").get_data(as_text=True)
        self.assertIn("There is no analytics on this site", privacy)
        cookies = self.client.get("/legal/cookies").get_data(as_text=True)
        self.assertNotRegex(cookies, r"<code>_ga</code>")
        self.assertNotIn("inkyscib-consent", cookies)


@unittest.skipUnless(PLAYWRIGHT_AVAILABLE, "Playwright is not installed")
class NoThirdPartyRequestTests(unittest.TestCase):
    """The claim on the privacy page, checked in a real browser: a first visit
    talks to this origin and nobody else."""

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

    def test_a_first_visit_reaches_no_other_origin(self):
        for path in ("/", "/write"):
            with self.subTest(path=path):
                context = self.browser.new_context()
                self.addCleanup(context.close)
                page = context.new_page()
                requested = []
                page.on("request", lambda request: requested.append(request.url))
                page.goto(self.base_url + path, wait_until="load")
                page.wait_for_timeout(1500)
                foreign = [
                    url for url in requested
                    if not url.startswith(self.base_url) and not re.match(r"^(data|blob|about):", url)
                ]
                self.assertEqual(foreign, [])

    def test_no_banner_stands_between_a_new_visitor_and_the_page(self):
        context = self.browser.new_context(viewport={"width": 960, "height": 600})
        self.addCleanup(context.close)
        page = context.new_page()
        page.goto(self.base_url + "/", wait_until="load")
        self.assertEqual(page.locator("#consentBanner").count(), 0)
        self.assertEqual(page.evaluate("() => document.cookie"), "")


if __name__ == "__main__":
    unittest.main()
