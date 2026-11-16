"""The footer credit: "(c) <year> MAETHIST Created by @kshitizarc".

The handle links to the author's LinkedIn profile. Pinned here: the words,
where the link goes, that it opens in a new tab without handing that tab a
reference back to this page, that it has a name a screen reader can say, that
it is legible, and that the credit never takes a click meant for the canvas.
"""

import datetime
import threading
import unittest

from app import app
from browser_server import make_browser_server

try:
    from playwright.sync_api import sync_playwright

    PLAYWRIGHT_AVAILABLE = True
except ImportError:  # pragma: no cover
    PLAYWRIGHT_AVAILABLE = False


@unittest.skipUnless(PLAYWRIGHT_AVAILABLE, "Playwright is not installed")
class FooterCreditTests(unittest.TestCase):
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

    def open_page(self, reduced_motion=False):
        context = self.browser.new_context(
            viewport={"width": 960, "height": 720},
            reduced_motion="reduce" if reduced_motion else "no-preference",
        )
        self.addCleanup(context.close)
        context.add_init_script(
            "localStorage.setItem('inkyscib-consent-v1', JSON.stringify({version: 1, analytics: false})); localStorage.setItem('inkyscib-feature-tour-v1', JSON.stringify({seen: true}))"
        )
        page = context.new_page()
        self.errors = []
        page.on("pageerror", lambda error: self.errors.append(str(error)))
        page.goto(self.base_url + "/write", wait_until="domcontentloaded")
        page.wait_for_function("() => window.appState?.storageReady === true")
        return page

    def test_the_credit_reads_right_and_links_out_safely(self):
        page = self.open_page()
        credit = page.evaluate(
            """() => {
              const left = document.querySelector('footer .left');
              const link = left.querySelector('a');
              return {
                text: left.textContent.replace(/\\s+/g, ' ').trim(),
                href: link.href,
                target: link.target,
                rel: link.rel,
                name: link.getAttribute('aria-label'),
              };
            }"""
        )
        self.assertEqual(
            credit["text"], f"© {datetime.date.today().year} MAETHIST Created by @kshitizarc"
        )
        self.assertEqual(credit["href"], "https://www.linkedin.com/in/kshitiz47/")
        # A new tab, and no handle back to this page for the one it opens.
        self.assertEqual(credit["target"], "_blank")
        self.assertIn("noopener", credit["rel"])
        self.assertIn("@kshitizarc", credit["name"])
        self.assertEqual(self.errors, [])

    def test_the_link_takes_its_click_and_the_rest_goes_to_the_canvas(self):
        page = self.open_page()
        hits = page.evaluate(
            """() => {
              const link = document.querySelector('.footer-credit-link');
              const r = link.getBoundingClientRect();
              const y = r.top + r.height / 2;
              const on = document.elementFromPoint(r.left + r.width / 2, y);
              const beside = document.elementFromPoint(r.right + 40, y);
              return { onLink: link.contains(on), beside: beside && beside.id };
            }"""
        )
        self.assertTrue(hits["onLink"], "the credit link does not take its own click")
        self.assertEqual(hits["beside"], "drawingCanvas", "the credit is eating canvas clicks")

    def test_the_credit_is_legible(self):
        """It rested at 40% opacity when it was a decorative signature. A name
        with a link on it has to be readable, so nothing above it may dim it."""
        page = self.open_page()
        opacity = page.evaluate(
            """() => {
              let node = document.querySelector('.footer-credit-link'), total = 1;
              while (node && node.nodeType === 1) {
                total *= parseFloat(getComputedStyle(node).opacity);
                node = node.parentElement;
              }
              return total;
            }"""
        )
        self.assertGreaterEqual(opacity, 0.99)


if __name__ == "__main__":
    unittest.main()
