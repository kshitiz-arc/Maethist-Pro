import threading
import unittest

from app import app


MEASUREMENT_ID = "G-5SW3NRK6X6"


def parse_csp(header):
    directives = {}
    for section in header.split(";"):
        name, *sources = section.strip().split()
        if name:
            directives[name] = set(sources)
    return directives


class AnalyticsCspTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = app.test_client()

    def test_analytics_tag_and_core_ga4_origins_are_available_on_pages(self):
        required_sources = {
            "script-src": "https://*.googletagmanager.com",
            "img-src": "https://*.googletagmanager.com",
            "connect-src": "https://*.googletagmanager.com",
        }

        for path in ("/", "/write"):
            with self.subTest(path=path):
                response = self.client.get(path)
                html = response.get_data(as_text=True)
                directives = parse_csp(response.headers["Content-Security-Policy"])

                self.assertEqual(response.status_code, 200)
                self.assertEqual(
                    html.count(
                        f"https://www.googletagmanager.com/gtag/js?id={MEASUREMENT_ID}"
                    ),
                    1,
                )
                self.assertEqual(
                    html.count(f"gtag('config', '{MEASUREMENT_ID}')"),
                    1,
                )
                for directive, source in required_sources.items():
                    self.assertIn(source, directives[directive])

                self.assertIn(
                    "https://*.google-analytics.com",
                    directives["connect-src"],
                )
                self.assertIn(
                    "https://analytics.google.com",
                    directives["connect-src"],
                )
                self.assertIn(
                    "https://*.analytics.google.com",
                    directives["connect-src"],
                )

    def test_optional_advertising_origins_remain_disabled(self):
        response = self.client.get("/")
        csp = response.headers["Content-Security-Policy"]

        for advertising_origin in (
            "doubleclick.net",
            "googlesyndication.com",
        ):
            with self.subTest(origin=advertising_origin):
                self.assertNotIn(advertising_origin, csp)


try:
    from playwright.sync_api import sync_playwright
    from werkzeug.serving import make_server

    PLAYWRIGHT_AVAILABLE = True
except ImportError:
    PLAYWRIGHT_AVAILABLE = False


@unittest.skipUnless(PLAYWRIGHT_AVAILABLE, "Playwright is not installed")
class AnalyticsBrowserCspTests(unittest.TestCase):
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

    def test_ga4_bare_collect_origin_passes_the_real_browser_csp(self):
        context = self.browser.new_context()
        self.addCleanup(context.close)
        page = context.new_page()
        collect_requests = []

        # Replace Google's loader with a tiny local probe. The browser still
        # applies Inkyscib's production CSP to the real GA4 destination, while
        # routing keeps the test offline and prevents test data reaching GA.
        page.route(
            "**/gtag/js**",
            lambda route: route.fulfill(
                status=200,
                content_type="application/javascript",
                body="""
                    window.__gaCspProbeResult = "pending";
                    fetch(
                      "https://analytics.google.com/g/collect?v=2"
                        + "&tid=G-5SW3NRK6X6&en=page_view",
                      { mode: "no-cors", keepalive: true }
                    ).then(
                      () => { window.__gaCspProbeResult = "sent"; },
                      () => { window.__gaCspProbeResult = "blocked"; }
                    );
                """,
            ),
        )

        def fulfill_collect(route):
            collect_requests.append(route.request.url)
            route.fulfill(status=204, body="")

        page.route("https://analytics.google.com/**", fulfill_collect)
        page.goto(self.base_url + "/", wait_until="domcontentloaded")

        # wait_for_function evaluates its string predicate via eval, which the
        # production CSP correctly rejects. Pump browser events until the routed
        # collect request arrives instead, without weakening CSP for the test.
        for _ in range(100):
            if collect_requests:
                break
            page.wait_for_timeout(25)
        page.wait_for_timeout(25)

        self.assertEqual(page.evaluate("window.__gaCspProbeResult"), "sent")
        self.assertEqual(len(collect_requests), 1)
        self.assertIn("/g/collect", collect_requests[0])


if __name__ == "__main__":
    unittest.main()
