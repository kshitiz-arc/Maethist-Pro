"""Quick access (static/js/quick-access.js): the rail toggle and the hold ring.

The ring's contents and rules came from an LLM council (docs/council/):
Pen, Colour, Line, Eraser, Select, Pan, Redo, Undo; a still press only
(2 seconds by the council, 0.7s at the owner's request); the stroke the press began leaves nothing; a second finger or any
movement cancels it; the eraser and the compass keep their own long press.
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


FIRE = """(args) => {
  const [type, x, y, id] = args;
  const c = document.getElementById('drawingCanvas');
  const r = c.getBoundingClientRect();
  c.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: r.left + x, clientY: r.top + y,
    pointerId: id, isPrimary: id === 7, pointerType: 'touch', button: 0, buttons: type === 'pointerup' ? 0 : 1 }));
}"""


@unittest.skipUnless(PLAYWRIGHT_AVAILABLE, "Playwright is not installed")
class QuickAccessTests(unittest.TestCase):
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

    def open_page(self, viewport=None):
        context = self.browser.new_context(viewport=viewport or {"width": 1440, "height": 900})
        self.addCleanup(context.close)
        context.add_init_script("localStorage.setItem('inkyscib-feature-tour-v1', 'seen')")
        page = context.new_page()
        self.errors = []
        page.on("pageerror", lambda error: self.errors.append(str(error)))
        page.goto(self.base_url + "/write", wait_until="domcontentloaded")
        page.wait_for_function("() => window.appState?.storageReady === true && !!document.getElementById('ribbonRailToggle')")
        return page

    def fire(self, page, kind, x, y, pointer=7):
        page.evaluate(FIRE, [kind, x, y, pointer])

    # ---------- the rail ----------

    def test_the_ribbon_hides_and_shows_the_rail_and_remembers(self):
        page = self.open_page()
        page.click("#ribbonRailToggle")
        page.wait_for_timeout(450)
        hidden = page.evaluate("""() => { const r = document.querySelector('.tool-rail').getBoundingClientRect();
          return { cls: document.body.classList.contains('rail-hidden'), right: r.right,
                   pressed: document.getElementById('ribbonRailToggle').getAttribute('aria-pressed') }; }""")
        self.assertTrue(hidden["cls"])
        self.assertLessEqual(hidden["right"], 0, "the rail is off screen")
        self.assertEqual(hidden["pressed"], "true")
        page.reload(wait_until="domcontentloaded")
        page.wait_for_function("() => !!document.getElementById('ribbonRailToggle')")
        self.assertTrue(page.evaluate("() => document.body.classList.contains('rail-hidden')"))
        page.click("#ribbonRailToggle")
        self.assertFalse(page.evaluate("() => document.body.classList.contains('rail-hidden')"))
        self.assertEqual(self.errors, [])

    def test_on_a_tablet_the_tool_row_hides_too(self):
        page = self.open_page({"width": 960, "height": 600})
        page.click("#ribbonRailToggle")
        self.assertFalse(page.locator(".toolbar").first.is_visible())

    # ---------- the ring ----------

    def test_a_still_press_opens_the_ring_and_leaves_no_mark(self):
        page = self.open_page()
        page.evaluate("() => { window.setTool('pen'); window.appState.paths = []; }")
        self.assertEqual(page.evaluate("() => window.Inkyscib.QuickAccess.HOLD_MS"), 700)
        self.fire(page, "pointerdown", 600, 400)
        page.wait_for_timeout(400)
        self.assertTrue(page.evaluate("() => document.getElementById('quickRing').classList.contains('is-charging')"),
                        "the hold is visible before it opens")
        page.wait_for_timeout(500)
        state = page.evaluate("""() => ({ open: window.Inkyscib.QuickAccess.ringOpen(),
          slices: [...document.querySelectorAll('#quickRing [data-slice]')].map((s) => s.dataset.slice),
          labels: [...document.querySelectorAll('#quickRing .qa-label')].every((l) => l.textContent.trim().length > 0) })""")
        self.assertTrue(state["open"])
        self.assertEqual(state["slices"], ["pen", "colour", "line", "eraser", "select", "pan", "redo", "undo"])
        self.assertTrue(state["labels"], "every slice is labelled")
        box = page.locator('#quickRing [data-slice="line"]').bounding_box()
        page.evaluate("""(p) => document.dispatchEvent(new PointerEvent('pointerup',
          { bubbles: true, clientX: p[0], clientY: p[1], pointerId: 7, isPrimary: true }))""",
                      [box["x"] + box["width"] / 2, box["y"] + box["height"] / 2])
        after = page.evaluate("() => ({ tool: window.appState.currentTool, open: window.Inkyscib.QuickAccess.ringOpen(), paths: window.appState.paths.length })")
        self.assertEqual(after, {"tool": "line", "open": False, "paths": 0})
        self.assertEqual(self.errors, [])

    def test_sliding_toward_a_tool_while_holding_picks_it(self):
        page = self.open_page()
        page.evaluate("() => { window.setTool('pen'); window.appState.paths = []; }")
        self.fire(page, "pointerdown", 600, 400)
        page.wait_for_timeout(850)
        self.assertTrue(page.evaluate("() => window.Inkyscib.QuickAccess.ringOpen()"))
        self.assertTrue(page.evaluate("() => getComputedStyle(document.querySelector('#quickRing .qa-slice')).animationName.includes('qaSlicePop')"),
                        "the ring pops open rather than appearing")
        # Line is the slice to the right; 50px that way is enough.
        self.fire(page, "pointermove", 650, 402)
        self.assertEqual(page.evaluate("() => document.querySelector('#quickRing .is-hover')?.dataset.slice"), "line")
        self.fire(page, "pointerup", 650, 402)
        after = page.evaluate("() => ({ tool: window.appState.currentTool, open: window.Inkyscib.QuickAccess.ringOpen(), paths: window.appState.paths.length })")
        self.assertEqual(after, {"tool": "line", "open": False, "paths": 0})

    def test_a_tap_away_from_the_ring_closes_it_and_draws_nothing(self):
        page = self.open_page()
        page.evaluate("() => { window.setTool('pen'); window.appState.paths = []; window.Inkyscib.QuickAccess.openRingAt(600, 400); }")
        self.fire(page, "pointerdown", 1100, 700, pointer=9)
        self.fire(page, "pointermove", 1150, 720, pointer=9)
        self.fire(page, "pointerup", 1150, 720, pointer=9)
        page.wait_for_timeout(100)
        state = page.evaluate("() => ({ open: window.Inkyscib.QuickAccess.ringOpen(), paths: window.appState.paths.length, tool: window.appState.currentTool })")
        self.assertEqual(state, {"open": False, "paths": 0, "tool": "pen"})

    def test_the_centre_is_the_maethist_mark(self):
        page = self.open_page()
        page.evaluate("() => window.Inkyscib.QuickAccess.openRingAt(600, 400)")
        mark = page.evaluate("""() => { const img = document.querySelector('#quickRing .qa-hub img.qa-mark');
          return img && { src: img.getAttribute('src'), ok: img.complete && img.naturalWidth > 0 }; }""")
        self.assertIsNotNone(mark)
        self.assertIn("maethist-mark", mark["src"])
        page.wait_for_function("() => document.querySelector('#quickRing .qa-mark').naturalWidth > 0")

    def test_moving_or_a_second_finger_never_opens_it(self):
        page = self.open_page()
        page.evaluate("() => window.setTool('pen')")
        self.fire(page, "pointerdown", 600, 400)
        page.wait_for_timeout(300)
        self.fire(page, "pointermove", 625, 400)
        page.wait_for_timeout(2100)
        moved = page.evaluate("() => window.Inkyscib.QuickAccess.ringOpen()")
        self.fire(page, "pointerup", 625, 400)
        self.fire(page, "pointerdown", 600, 400)
        page.wait_for_timeout(300)
        self.fire(page, "pointerdown", 700, 420, pointer=8)
        page.wait_for_timeout(2100)
        pinched = page.evaluate("() => window.Inkyscib.QuickAccess.ringOpen()")
        self.assertFalse(moved, "a stroke that moved is a stroke")
        self.assertFalse(pinched, "two fingers are a pinch")

    def test_the_eraser_keeps_its_own_long_press(self):
        page = self.open_page()
        page.evaluate("() => window.setTool('eraser')")
        self.fire(page, "pointerdown", 600, 400)
        page.wait_for_timeout(1200)
        self.assertFalse(page.evaluate("() => window.Inkyscib.QuickAccess.ringOpen()"))

    def test_colour_opens_a_ring_of_swatches_and_escape_closes(self):
        page = self.open_page()
        page.evaluate("() => { window.setTool('pen'); window.Inkyscib.QuickAccess.openRingAt(700, 450); window.Inkyscib.QuickAccess.choose('colour'); }")
        labels = page.evaluate("() => [...document.querySelectorAll('#quickRing [data-slice]')].map((s) => s.getAttribute('aria-label'))")
        self.assertEqual(labels[-1], "Back")
        self.assertIn("Red", labels)
        page.keyboard.press("Escape")
        self.assertFalse(page.evaluate("() => window.Inkyscib.QuickAccess.ringOpen()"))


if __name__ == "__main__":
    unittest.main()
