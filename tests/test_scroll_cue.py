"""Long panels say they are long.

A tool panel taller than the screen scrolls, but on an Android tablet the
scrollbar only shows mid-scroll, so the options below the fold were invisible.
static/js/scroll-cue.js adds a More chip and edge fades. Pinned here: the chip
shows on a long panel at the 960x600 tablet size, is a real touch target,
scrolls the panel when tapped, and goes away at the end.
"""

import threading
import unittest

from app import app
from browser_server import make_browser_server

try:
    from playwright.sync_api import sync_playwright

    PLAYWRIGHT_AVAILABLE = True
except ImportError:  # pragma: no cover - optional dependency
    PLAYWRIGHT_AVAILABLE = False


@unittest.skipUnless(PLAYWRIGHT_AVAILABLE, "Playwright is not installed")
class ScrollCueTests(unittest.TestCase):
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

    def test_a_long_tablet_panel_shows_more_and_the_chip_scrolls_it(self):
        context = self.browser.new_context(viewport={"width": 960, "height": 600})
        self.addCleanup(context.close)
        context.add_init_script("localStorage.setItem('inkyscib-feature-tour-v1', 'seen')")
        page = context.new_page()
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.goto(self.base_url + "/write", wait_until="domcontentloaded")
        page.wait_for_function("() => window.appState?.storageReady === true && !!window.Inkyscib?.ScrollCue")
        page.evaluate("() => { window.setTool('compass'); window.Inkyscib.ToolDock.setCollapsed(false); }")
        page.wait_for_timeout(900)
        panel = "() => [...document.querySelectorAll('.tool-panel-layer > .tool-options')].find((e) => e.offsetHeight > 0)"
        before = page.evaluate(
            "() => { const p = (" + panel + ")(); const chip = p.querySelector('.sc-more');"
            " const r = chip.getBoundingClientRect(); const pr = p.getBoundingClientRect();"
            " return { long: p.scrollHeight > p.clientHeight, below: p.classList.contains('sc-below'),"
            "  shown: !p.__scrollCue.hidden, w: r.width, h: r.height, inside: r.bottom <= pr.bottom + 1 && r.top >= pr.top,"
            "  top: p.scrollTop }; }"
        )
        self.assertTrue(before["long"], "the compass panel is longer than a 600px tablet")
        self.assertTrue(before["below"])
        self.assertTrue(before["shown"])
        self.assertGreaterEqual(before["w"], 44)
        self.assertGreaterEqual(before["h"], 44)
        self.assertTrue(before["inside"], "the chip sits inside the visible part of the panel")

        page.evaluate("() => (" + panel + ")().querySelector('.sc-more').click()")
        page.wait_for_timeout(700)
        moved = page.evaluate("() => (" + panel + ")().scrollTop")
        self.assertGreater(moved, before["top"] + 100)

        page.evaluate("() => { const p = (" + panel + ")(); p.scrollTop = p.scrollHeight; }")
        page.wait_for_timeout(300)
        end = page.evaluate("() => { const p = (" + panel + ")(); return { shown: !p.__scrollCue.hidden, above: p.classList.contains('sc-above') }; }")
        self.assertFalse(end["shown"], "no chip once the end is reached")
        self.assertTrue(end["above"], "the top edge fades once there is content above")
        self.assertEqual(errors, [])


if __name__ == "__main__":
    unittest.main()
