"""The launch checklist, held in place.

Visit counter (first-party, cookieless), request limits on the public API,
HTTPS by default in production, one call to action, compressed brand images,
and import errors that actually reach the screen.
"""

import base64
import importlib
import json
import os
import re
import subprocess
import sys
import tempfile
import threading
import unittest
import unittest.mock
from pathlib import Path

import app as app_module
from app import app
from browser_server import make_browser_server

try:
    from playwright.sync_api import sync_playwright

    PLAYWRIGHT_AVAILABLE = True
except ImportError:  # pragma: no cover
    PLAYWRIGHT_AVAILABLE = False

ROOT = Path(app.root_path)
PHONE = "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 Mobile Safari/537.36"
TABLET = "Mozilla/5.0 (Linux; Android 13; Lenovo TB-X606F) AppleWebKit/537.36 Safari/537.36"


class VisitCounterTests(unittest.TestCase):
    def setUp(self):
        self.client = app.test_client()
        self.saved = json.loads(json.dumps(app_module._VISITS))
        app_module._VISITS["days"] = {}
        self.tmp = tempfile.TemporaryDirectory()
        self.path_patch = unittest.mock.patch.object(app_module, "VISITS_PATH", Path(self.tmp.name) / "v.json")
        self.path_patch.start()

    def tearDown(self):
        self.path_patch.stop()
        app_module._VISITS.clear()
        app_module._VISITS.update(self.saved)
        self.tmp.cleanup()

    def today(self):
        return next(iter(app_module._VISITS["days"].values()), None)

    def test_a_page_load_is_counted_by_page_device_and_referring_site(self):
        self.client.get("/", headers={"User-Agent": PHONE, "Referer": "https://www.google.com/search?q=maths"})
        self.client.get("/write", headers={"User-Agent": TABLET})
        day = self.today()
        self.assertEqual(day["views"], 2)
        self.assertEqual(day["pages"], {"/": 1, "/write": 1})
        self.assertEqual(day["devices"], {"phone": 1, "tablet": 1})
        self.assertEqual(day["referrers"], {"www.google.com": 1}, "only the host, never the full address")

    def test_bots_prefetches_api_calls_and_own_links_are_not_counted(self):
        self.client.get("/", headers={"User-Agent": "Mozilla/5.0 (compatible; Googlebot/2.1)"})
        self.client.get("/", headers={"User-Agent": PHONE, "Sec-Purpose": "prefetch"})
        self.client.get("/api/youtube/search?q=", headers={"User-Agent": PHONE})
        self.client.get("/static/logo.ico", headers={"User-Agent": PHONE})
        self.client.get("/features", headers={"User-Agent": PHONE, "Referer": "http://localhost/"})
        day = self.today()
        self.assertEqual(day["views"], 1)
        self.assertEqual(day["referrers"], {})

    def test_nothing_identifying_is_stored(self):
        self.client.get("/", headers={"User-Agent": PHONE, "Referer": "https://example.org/a/b?x=1"},
                        environ_base={"REMOTE_ADDR": "203.0.113.9"})
        app_module._flush_visits(force=True)
        stored = app_module.VISITS_PATH.read_text(encoding="utf-8")
        for leak in ("203.0.113", "Pixel", "Mozilla", "/a/b", "x=1"):
            self.assertNotIn(leak, stored)
        response = self.client.get("/")
        self.assertNotIn("Set-Cookie", response.headers)

    def test_the_stats_page_needs_the_token_and_does_not_exist_without_one(self):
        with unittest.mock.patch.object(app_module, "STATS_TOKEN", ""):
            self.assertEqual(self.client.get("/stats").status_code, 404)
        with unittest.mock.patch.object(app_module, "STATS_TOKEN", "s3cret"):
            self.assertEqual(self.client.get("/stats").status_code, 401)
            bad = base64.b64encode(b"x:wrong").decode()
            self.assertEqual(self.client.get("/stats", headers={"Authorization": "Basic " + bad}).status_code, 401)
            good = base64.b64encode(b"owner:s3cret").decode()
            response = self.client.get("/stats", headers={"Authorization": "Basic " + good})
            self.assertEqual(response.status_code, 200)
            self.assertIn("Visit counter", response.get_data(as_text=True))
            self.assertEqual(response.headers["X-Robots-Tag"], "noindex")
        self.assertIn("Disallow: /stats", self.client.get("/robots.txt").get_data(as_text=True))

    def test_the_privacy_policy_describes_the_count_and_the_limits(self):
        html = self.client.get("/legal/privacy").get_data(as_text=True)
        self.assertIn("A visit count", html)
        self.assertIn("no cookie, no identifier, no IP", " ".join(html.split()))
        self.assertIn("Keeping the service up", html)
        self.assertIn("The daily visit count", html)


class RateLimitTests(unittest.TestCase):
    def setUp(self):
        self.client = app.test_client()
        app_module._RATE_BUCKETS.clear()

    def tearDown(self):
        app_module._RATE_BUCKETS.clear()

    def test_a_flood_from_one_visitor_is_turned_away_politely(self):
        allowed, _ = app_module.RATE_LIMITS["youtube_search"]
        visitor = {"REMOTE_ADDR": "198.51.100.20"}
        codes = [self.client.get("/api/youtube/search?q=", environ_base=visitor).status_code for _ in range(allowed + 1)]
        self.assertNotIn(429, codes[:allowed])
        self.assertEqual(codes[-1], 429)
        response = self.client.get("/api/youtube/search?q=", environ_base=visitor)
        self.assertIn("Too many requests", response.get_json()["error"])
        self.assertGreater(int(response.headers["Retry-After"]), 0)

    def test_neighbours_on_the_same_network_share_a_budget_but_others_do_not(self):
        allowed, _ = app_module.RATE_LIMITS["import_pdf"]
        for _ in range(allowed):
            self.client.post("/api/pdf/import", data={}, environ_base={"REMOTE_ADDR": "198.51.100.30"})
        same_network = self.client.post("/api/pdf/import", data={}, environ_base={"REMOTE_ADDR": "198.51.100.31"})
        elsewhere = self.client.post("/api/pdf/import", data={}, environ_base={"REMOTE_ADDR": "192.0.2.5"})
        self.assertEqual(same_network.status_code, 429)
        self.assertEqual(elsewhere.status_code, 400)

    def test_every_public_api_endpoint_has_a_limit(self):
        api = {rule.endpoint for rule in app.url_map.iter_rules() if str(rule).startswith("/api/")}
        self.assertEqual(sorted(api - set(app_module.RATE_LIMITS)), [])
        self.assertEqual(sorted(set(app_module.RATE_LIMITS) - api), [], "a limit names an endpoint that does not exist")

    def test_the_address_is_never_kept(self):
        self.client.get("/api/youtube/search?q=", environ_base={"REMOTE_ADDR": "198.51.100.44"})
        self.assertNotIn("198.51.100", json.dumps([list(k) for k in app_module._RATE_BUCKETS]))


class HttpsDefaultTests(unittest.TestCase):
    def run_app(self, env):
        code = "import app; print(app.FORCE_HTTPS)"
        full = {k: v for k, v in os.environ.items() if k not in ("FORCE_HTTPS", "INKYSCIB_ENV", "RENDER")}
        full.update(env)
        full.setdefault("SECRET_KEY", "x")
        result = subprocess.run([sys.executable, "-c", code], cwd=ROOT, env=full,
                                capture_output=True, text=True, timeout=120)
        return result.stdout.strip().splitlines()[-1]

    def test_production_redirects_to_https_unless_told_not_to(self):
        self.assertEqual(self.run_app({"RENDER": "true"}), "True")
        self.assertEqual(self.run_app({"INKYSCIB_ENV": "production"}), "True")
        self.assertEqual(self.run_app({"RENDER": "true", "FORCE_HTTPS": "false"}), "False")
        self.assertEqual(self.run_app({}), "False", "a local run has no certificate")


class PageTests(unittest.TestCase):
    def setUp(self):
        self.client = app.test_client()

    def test_every_marketing_page_has_one_call_to_action_button(self):
        for path in ("/", "/features", "/about"):
            with self.subTest(path=path):
                html = self.client.get(path).get_data(as_text=True)
                main = html.split("<main", 1)[1] if "<main" in html else html
                # One call to action. The homepage repeats it at the foot of
                # the page, so every primary button must be that same action.
                primaries = re.findall(r'<a class="primary[^"]*" href="([^"]+)"[^>]*>(.*?)</a>', main, re.S)
                self.assertGreaterEqual(len(primaries), 1)
                self.assertLessEqual(len(primaries), 2)
                self.assertEqual(main.count('class="primary'), len(primaries))
                for href, label in primaries:
                    self.assertEqual(href, "/write")
                    self.assertIn("Start writing, free", label)
                self.assertNotIn('class="secondary"', main)
                self.assertIn("Start writing, free", main)
        header = self.client.get("/").get_data(as_text=True)
        self.assertIn('class="write-btn" href="/write">Start writing, free</a>', header)

    def test_the_404_page_is_described_and_kept_out_of_search(self):
        response = self.client.get("/no-such-page")
        html = response.get_data(as_text=True)
        self.assertEqual(response.status_code, 404)
        self.assertIn('<meta name="robots" content="noindex"', html)
        self.assertIn('<meta name="description"', html)

    def test_brand_images_are_compressed(self):
        budgets = {
            "static/logo.ico": 16_000,
            "static/img/maethist-mark.png": 8_000,
            "static/icons/maethist-192.png": 10_000,
            "static/icons/maethist-512.png": 30_000,
            "static/icons/maethist-maskable-512.png": 25_000,
            "static/img/og-cover.png": 60_000,
        }
        for path, limit in budgets.items():
            with self.subTest(path=path):
                self.assertLessEqual((ROOT / path).stat().st_size, limit)


@unittest.skipUnless(PLAYWRIGHT_AVAILABLE, "Playwright is not installed")
class ImportErrorVisibilityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = make_browser_server(app)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base_url = f"http://127.0.0.1:{cls.server.server_port}"
        cls.playwright = sync_playwright().start()
        cls.browser = cls.playwright.chromium.launch(headless=True)
        cls.tmp = tempfile.TemporaryDirectory()
        cls.text_file = Path(cls.tmp.name) / "notes.txt"
        cls.text_file.write_text("hello")

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()
        cls.server.shutdown()
        cls.thread.join(timeout=3)
        cls.tmp.cleanup()

    def test_a_wrong_file_says_so_on_screen(self):
        """The messages used to land in side-menu status lines nobody can
        see, so a wrong file looked like a button that did nothing."""
        damaged_pdf = Path(self.tmp.name) / "damaged.pdf"
        damaged_pdf.write_bytes(b"this is not a pdf")
        damaged_png = Path(self.tmp.name) / "damaged.png"
        damaged_png.write_bytes(bytes([0x89]) + b"PNG broken")
        cases = (
            ("wrong file in the PDF picker", lambda p: p.set_input_files("#pdfImportInput", str(self.text_file)), "Choose a .pdf file"),
            ("a damaged PDF", lambda p: p.set_input_files("#pdfImportInput", str(damaged_pdf)), "Could not open this PDF"),
            ("wrong file in the PowerPoint picker", lambda p: p.set_input_files("#pptImportInput", str(self.text_file)), "Choose a .pptx file"),
            ("wrong file in the image picker", lambda p: p.set_input_files("#imageInsertInput", str(self.text_file)), "That file is not an image"),
            ("a damaged image", lambda p: p.set_input_files("#imageInsertInput", str(damaged_png)), "could not be read"),
            ("a bad backup with My Notebooks closed",
             lambda p: p.evaluate("async () => { await window.Inkyscib.Library.importBackup(new File(['{}'], 'x.inky')); }"),
             "not a valid MAETHIST backup"),
            ("the camera blocked for AR MAETHIST",
             lambda p: p.evaluate("async () => { navigator.mediaDevices.getUserMedia = () => Promise.reject(Object.assign(new Error('denied'), {name: 'NotAllowedError'})); await window.Inkyscib.AR.enterAR(); }"),
             "Camera access was blocked"),
        )
        for label, act, expected in cases:
            with self.subTest(case=label):
                context = self.browser.new_context(viewport={"width": 960, "height": 600})
                self.addCleanup(context.close)
                context.add_init_script("localStorage.setItem('inkyscib-feature-tour-v1', JSON.stringify({seen: true}))")
                page = context.new_page()
                dialogs = []
                page.on("dialog", lambda dialog: (dialogs.append(dialog.message), dialog.dismiss()))
                page.goto(self.base_url + "/write", wait_until="load")
                page.wait_for_function("() => window.appState?.storageReady === true")
                act(page)
                notice = page.wait_for_selector(".app-notice.is-error", state="visible", timeout=10000)
                self.assertIn(expected, notice.text_content())
                box = notice.bounding_box()
                self.assertGreaterEqual(box["x"], 0)
                self.assertLessEqual(box["x"] + box["width"], 960)
                self.assertEqual(notice.get_attribute("role"), "alert")
                self.assertEqual(dialogs, [], "a native pop-up blocked the page")


if __name__ == "__main__":
    unittest.main()
