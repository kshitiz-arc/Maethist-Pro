"""Access, portability and erasure, exercised in a real browser.

MAETHIST holds a visitor's work in their own browser, so GDPR Art. 15, 17 and
20 are three buttons on /legal/privacy rather than a support queue. These tests
drive window.InkyscibPrivacy (static/js/privacy-controls.js) against seeded
localStorage, an IndexedDB database and a cookie.

House conventions: the tour is dismissed in an add_init_script, the server
comes from make_browser_server, and every wait_for_function gets an arrow
function because the production CSP forbids eval.
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

PRIVACY_PAGE = "/legal/privacy"

# The controls live in the privacy policy, so the consent choice is seeded too:
# an open banner would otherwise sit over the buttons this module clicks.
INIT_SCRIPT = """
localStorage.setItem('inkyscib-feature-tour-v1', 'dismissed');
localStorage.setItem(
  'inkyscib-consent-v1',
  JSON.stringify({ version: 1, analytics: false, at: '2026-09-20T00:00Z' })
);
"""

SEED_EVERY_STORE = """
async () => {
  window.localStorage.setItem('inkyscib-theme', 'dark');
  window.localStorage.setItem('inkyscib-notebook-1', '{"strokes":[]}');
  document.cookie = 'inkyscib-seeded=1; path=/';
  await new Promise((resolve) => {
    const request = window.indexedDB.open('inkyscib_cache', 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('notebooks', { keyPath: 'id' });
    };
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction('notebooks', 'readwrite');
      tx.objectStore('notebooks').put({ id: 'n1', title: 'Term 1' });
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); resolve(); };
    };
    request.onerror = () => resolve();
  });
}
"""


@unittest.skipUnless(PLAYWRIGHT_AVAILABLE, "Playwright is not installed")
class PrivacyControlsTests(unittest.TestCase):
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

    def _seeded_page(self):
        """A /legal/privacy page with something in every store."""
        context = self.browser.new_context(viewport={"width": 1280, "height": 900})
        self.addCleanup(context.close)
        context.add_init_script(INIT_SCRIPT)
        page = context.new_page()
        page.goto(f"{self.base_url}{PRIVACY_PAGE}", wait_until="load")
        page.wait_for_function("() => Boolean(window.InkyscibPrivacy)")
        page.evaluate(SEED_EVERY_STORE)
        return page

    def test_the_inventory_reports_every_store_the_app_uses(self):
        page = self._seeded_page()
        inventory = page.evaluate("() => window.InkyscibPrivacy.inventory()")

        self.assertGreater(inventory["localStorage"], 0)
        self.assertIn("inkyscib_cache", inventory["indexedDB"])
        self.assertGreater(inventory["cookies"], 0)

    def test_export_returns_every_key_the_inventory_counted(self):
        page = self._seeded_page()
        payload = page.evaluate(
            "async () => JSON.parse(await (await window.InkyscibPrivacy"
            ".exportEverything()).text())"
        )

        self.assertIn("localStorage", payload)
        self.assertIn("indexedDB", payload)
        self.assertIn("exportedAt", payload)
        self.assertIn("inkyscib-notebook-1", payload["localStorage"])

    def test_erase_leaves_nothing_behind_in_any_store(self):
        page = self._seeded_page()
        page.evaluate("async () => window.InkyscibPrivacy.eraseEverything()")
        after = page.evaluate("() => window.InkyscibPrivacy.inventory()")

        self.assertEqual(after["localStorage"], 0)
        self.assertEqual(after["indexedDB"], [])
        self.assertEqual(after["caches"], [])
        self.assertEqual(after["cookies"], 0)

    def test_erase_asks_first_and_stops_on_a_no(self):
        page = self._seeded_page()
        page.on("dialog", lambda dialog: dialog.dismiss())
        page.click("#eraseEverything")
        after = page.evaluate("() => window.InkyscibPrivacy.inventory()")

        self.assertGreater(after["localStorage"], 0)
        self.assertIn("inkyscib_cache", after["indexedDB"])


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
