"""The smart eraser (static/js/smart-eraser.js, 2.8.3).

Reported: after erasing a mistake and pausing, the pen should come back on
its own -- but erasing in places far apart is a clean-up, and then the
eraser should stay. These drive real mouse strokes over the canvas.
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


@unittest.skipUnless(PLAYWRIGHT_AVAILABLE, "Playwright is not installed")
class SmartEraserTests(unittest.TestCase):
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
        context = self.browser.new_context(viewport={"width": 1440, "height": 900})
        self.addCleanup(context.close)
        context.add_init_script("localStorage.setItem('inkyscib-feature-tour-v1', 'seen')")
        page = context.new_page()
        self.errors = []
        page.on("pageerror", lambda error: self.errors.append(str(error)))
        page.goto(self.base_url + "/write", wait_until="domcontentloaded")
        page.wait_for_function("() => window.appState?.storageReady === true && !!window.Inkyscib?.SmartEraser")
        page.wait_for_timeout(450)
        self.pause = page.evaluate("() => window.Inkyscib.SmartEraser.PAUSE_MS")
        return page

    def scrub(self, page, x, y):
        page.mouse.move(x, y)
        page.mouse.down()
        for step in range(1, 7):
            page.mouse.move(x + step * 8, y + (step % 2) * 6)
        page.mouse.up()

    def tool(self, page):
        return page.evaluate("() => window.appState.currentTool")

    def test_a_quick_fix_hands_the_pen_back_after_a_pause(self):
        page = self.open()
        page.evaluate("() => { window.setTool('pen'); window.setTool('eraser'); }")
        self.assertEqual(page.evaluate("() => window.Inkyscib.SmartEraser.state().mode"), "temporary")
        self.scrub(page, 700, 450)
        chip = page.evaluate("() => { const c = document.getElementById('smartEraserChip'); return { shown: !c.hidden, counting: c.classList.contains('is-countdown') }; }")
        self.assertEqual(chip, {"shown": True, "counting": True}, "the pause is shown as it runs")
        page.wait_for_timeout(self.pause // 2)
        self.assertEqual(self.tool(page), "eraser", "not before the pause is up")
        page.wait_for_timeout(self.pause // 2 + 300)
        self.assertEqual(self.tool(page), "pen")
        self.assertFalse(page.evaluate("() => !!window.appState.quietToolChange"))
        self.assertEqual(self.errors, [])

    def test_erasing_again_inside_the_pause_restarts_it(self):
        page = self.open()
        page.evaluate("() => { window.setTool('pen'); window.setTool('eraser'); }")
        self.scrub(page, 700, 450)
        page.wait_for_timeout(int(self.pause * 0.7))
        self.scrub(page, 760, 470)
        page.wait_for_timeout(int(self.pause * 0.7))
        self.assertEqual(self.tool(page), "eraser")
        page.wait_for_timeout(int(self.pause * 0.5) + 200)
        self.assertEqual(self.tool(page), "pen")

    def test_erasing_far_apart_keeps_the_eraser(self):
        page = self.open()
        page.evaluate("() => { window.setTool('pen'); window.setTool('eraser'); }")
        # Clear of the eraser panel, which opens on the left.
        self.scrub(page, 620, 230)
        self.scrub(page, 1260, 780)
        self.assertEqual(page.evaluate("() => window.Inkyscib.SmartEraser.state().mode"), "permanent")
        page.wait_for_timeout(self.pause + 400)
        self.assertEqual(self.tool(page), "eraser")
        self.assertIn("stays", page.evaluate("() => document.getElementById('smartEraserChip').textContent"))

    def test_picked_from_a_non_writing_tool_it_stays(self):
        page = self.open()
        page.evaluate("() => { window.setTool('select'); window.setTool('eraser'); }")
        self.assertEqual(page.evaluate("() => window.Inkyscib.SmartEraser.state().mode"), "permanent")
        self.scrub(page, 700, 450)
        page.wait_for_timeout(self.pause + 300)
        self.assertEqual(self.tool(page), "eraser")

    def test_the_highlighter_comes_back_as_itself(self):
        page = self.open()
        page.evaluate("() => { window.setTool('highlight'); window.setTool('eraser'); }")
        self.scrub(page, 700, 450)
        page.wait_for_timeout(self.pause + 300)
        self.assertEqual(self.tool(page), "highlight")

    def test_keep_eraser_on_the_chip_keeps_it(self):
        page = self.open()
        page.evaluate("() => { window.setTool('pen'); window.setTool('eraser'); }")
        self.scrub(page, 700, 450)
        page.click("#smartEraserChip .se-keep")
        page.wait_for_timeout(self.pause + 300)
        self.assertEqual(self.tool(page), "eraser")

    def test_the_panel_can_switch_it_off_and_it_is_remembered(self):
        page = self.open()
        page.evaluate("() => { window.setTool('pen'); window.setTool('eraser'); document.querySelector('[data-eraser-return=\"off\"]').click(); }")
        self.assertFalse(page.evaluate("() => window.appState.toolSettings.eraser.autoReturn"))
        self.scrub(page, 700, 450)
        page.wait_for_timeout(self.pause + 300)
        self.assertEqual(self.tool(page), "eraser")
        pressed = page.evaluate("() => document.querySelector('[data-eraser-return=\"off\"]').getAttribute('aria-pressed')")
        self.assertEqual(pressed, "true")


if __name__ == "__main__":
    unittest.main()
