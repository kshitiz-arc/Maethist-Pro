"""Every tool panel can be put away with a close button.

Before this the only ways to dismiss a tool's controls were to tap the tool
again (which nothing on screen says, beyond one line of hint text in the dock)
or, in the dock, to touch the canvas. Below the 1180px breakpoint the floating
panel had no dismissal of its own at all, on the tablet this product is for.

Both layouts are checked, because they are built differently: at 1440px the
panels live inside the tool dock, whose header carries the button; at 960px
each panel floats on its own and carries its own.
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


TOOLS = [
    ("pen", "penOptions", "Pen"),
    ("eraser", "eraserOptions", "Eraser"),
    ("highlight", "highlightOptions", "Highlighter"),
    ("shape", "shapeOptions", "Shape"),
    ("manipulative", "manipulativeOptions", "Algebra tiles"),
    ("line", "lineOptions", "Line"),
    ("compass", "compassOptions", "Compass"),
    ("angle", "angleOptions", "Angle"),
]

LAYOUTS = {
    "floating": {"width": 960, "height": 720},
    "docked": {"width": 1440, "height": 900},
}

PANEL_SHOWN = "id => getComputedStyle(document.getElementById(id)).display !== 'none'"
PANEL_HIDDEN = "id => getComputedStyle(document.getElementById(id)).display === 'none'"


@unittest.skipUnless(PLAYWRIGHT_AVAILABLE, "Playwright is not installed")
class ToolPanelCloseTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = make_browser_server(app)
        cls.server_thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
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

    def open_page(self, viewport):
        # The viewport is fixed at creation: resizing a loaded editor flips it
        # between the two layouts, which is not how a tablet opens it.
        context = self.browser.new_context(viewport=viewport)
        self.addCleanup(context.close)
        page = context.new_page()
        # A missing button should fail in seconds, not after 30s per subtest.
        page.set_default_timeout(8000)
        self.errors = []
        page.on("pageerror", lambda error: self.errors.append(str(error)))
        page.add_init_script("localStorage.setItem('inkyscib-consent-v1', JSON.stringify({version: 1, analytics: false})); localStorage.setItem('inkyscib-feature-tour-v1', 'seen')")
        page.goto(self.base_url + "/write", wait_until="domcontentloaded")
        page.wait_for_function("() => window.appState?.storageReady === true")
        page.wait_for_function("() => !!window.Inkyscib?.ToolDock")
        return page

    def check_layout(self, layout):
        page = self.open_page(LAYOUTS[layout])
        self.assertEqual(
            page.evaluate("() => window.Inkyscib.ToolDock.isDockMode()"),
            layout == "docked",
        )

        for tool, panel_id, title in TOOLS:
            with self.subTest(layout=layout, tool=tool):
                page.evaluate(
                    "tool => { window.setTool(tool); window.Inkyscib.ToolDock.setCollapsed(false); }",
                    tool,
                )
                page.wait_for_function(PANEL_SHOWN, arg=panel_id)

                selector = "#toolDockClose" if layout == "docked" else f"#{panel_id}Close"
                other = f"#{panel_id}Close" if layout == "docked" else "#toolDockClose"
                self.assertFalse(
                    page.locator(other).is_visible(),
                    "only one close button may show for one panel",
                )

                button = page.locator(selector)
                # The previous subtest pressed this same button; its release
                # (motion.css, squash and stretch) scales the drawn box for
                # 320ms. The target is the button at rest, so wait it out.
                page.wait_for_function(
                    "(s) => { const b = document.querySelector(s); return b && !b.classList.contains('mx-release') && !b.classList.contains('mx-press'); }",
                    arg=selector)
                box = button.bounding_box()
                self.assertIsNotNone(box, f"{selector} is not rendered")
                self.assertGreaterEqual(box["width"], 44, "below DESIGN.md's 44px minimum")
                self.assertGreaterEqual(box["height"], 44, "below DESIGN.md's 44px minimum")
                self.assertEqual(button.get_attribute("aria-label"), f"Close {title} options")

                # A real click, so an element covering the button fails the test.
                button.click()
                page.wait_for_function(PANEL_HIDDEN, arg=panel_id)
                after = page.evaluate(
                    "() => ({ tool: window.appState.currentTool, focused: document.activeElement?.id || '' })"
                )
                self.assertEqual(after["tool"], tool, "closing the panel must not change the tool")
                self.assertEqual(after["focused"], f"{tool}Tool", "focus returns to the tool")

                # The tool's own gesture brings the controls back.
                page.evaluate("tool => document.getElementById(tool + 'Tool').click()", tool)
                page.wait_for_function(PANEL_SHOWN, arg=panel_id)

        self.assertEqual(self.errors, [])

    def test_floating_panels_close_from_their_own_button(self):
        self.check_layout("floating")

    def test_docked_panels_close_from_the_dock_header(self):
        self.check_layout("docked")


if __name__ == "__main__":
    unittest.main()
