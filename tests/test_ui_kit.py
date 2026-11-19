"""The interaction parts taken from shadcn/ui and ComfyUI (static/js/ui-kit.js),
and the owner's fixes that came with them in 2.7.0: a clear gap under the
bars, the pen panel left closed on load, Move for the background picture,
the draggable homepage triangle with a faster intro, and About's type.
"""

import re
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
class UiKitTests(unittest.TestCase):
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

    def open(self, path="/write", viewport=None, touch=False):
        context = self.browser.new_context(viewport=viewport or {"width": 1440, "height": 900}, has_touch=touch)
        self.addCleanup(context.close)
        context.add_init_script("localStorage.setItem('inkyscib-feature-tour-v1', 'seen')")
        page = context.new_page()
        self.errors = []
        page.on("pageerror", lambda error: self.errors.append(str(error)))
        page.goto(self.base_url + path, wait_until="domcontentloaded")
        if path == "/write":
            page.wait_for_function("() => window.appState?.storageReady === true && !!window.Inkyscib?.UiKit")
        return page

    # ---------- command search ----------

    def test_ctrl_k_finds_a_tool_and_enter_picks_it(self):
        page = self.open()
        page.evaluate("() => window.setTool('pen')")
        page.keyboard.press("Control+k")
        page.wait_for_selector("#commandPalette:not([hidden])")
        page.keyboard.type("compass")
        first = page.inner_text("#commandList [aria-selected='true']")
        self.assertIn("Compass", first)
        self.assertIn("C", first, "the key is shown beside it")
        page.keyboard.press("Enter")
        page.wait_for_function("() => window.appState.currentTool === 'compass'")
        self.assertTrue(page.evaluate("() => document.getElementById('commandPalette').hidden"))
        self.assertEqual(self.errors, [])

    def test_it_holds_the_ribbon_commands_and_closes_on_escape(self):
        page = self.open()
        page.keyboard.press("/")
        page.wait_for_selector("#commandPalette:not([hidden])")
        page.keyboard.type("image to text")
        self.assertIn("Image to text", page.inner_text("#commandList"))
        page.keyboard.press("Escape")
        self.assertTrue(page.evaluate("() => document.getElementById('commandPalette').hidden"))

    def test_letters_in_order_find_a_command(self):
        page = self.open()
        scores = page.evaluate("""() => { const s = window.Inkyscib.UiKit._score;
          return [s({title: 'Measure angle', group: 'Tools'}, 'msang'), s({title: 'Pen', group: 'Tools'}, 'msang')]; }""")
        self.assertGreater(scores[0], 0)
        self.assertEqual(scores[1], 0)

    def test_double_click_on_empty_canvas_with_select_searches(self):
        page = self.open()
        page.evaluate("() => { window.appState.paths = []; window.setTool('select'); window.render(); }")
        box = page.locator("#drawingCanvas").bounding_box()
        page.mouse.dblclick(box["x"] + 700, box["y"] + 450)
        page.wait_for_selector("#commandPalette:not([hidden])")

    def test_question_mark_opens_the_keyboard_sheet(self):
        page = self.open()
        page.keyboard.press("Shift+Slash")
        page.wait_for_selector("#shortcutSheet:not([hidden])")
        text = page.inner_text("#shortcutSheet")
        for phrase in ("Keyboard shortcuts", "Pen", "Hold and drag to pan", "Search tools and commands"):
            self.assertIn(phrase, text)
        page.keyboard.press("Escape")
        self.assertTrue(page.evaluate("() => document.getElementById('shortcutSheet').hidden"))

    # ---------- tooltips ----------

    def test_a_tooltip_names_the_tool_and_its_key_and_replaces_the_title(self):
        page = self.open()
        box = page.locator("#eraserTool").bounding_box()
        page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
        page.wait_for_selector("#uiTooltip:not([hidden])", timeout=2000)
        self.assertEqual(page.inner_text("#uiTooltip .ui-kbd-row"), "E")
        self.assertTrue(page.inner_text("#uiTooltip").startswith("Eraser"))
        self.assertNotIn("(E)", page.inner_text("#uiTooltip"))
        state = page.evaluate("() => ({title: document.getElementById('eraserTool').hasAttribute('title'), label: document.getElementById('eraserTool').getAttribute('aria-label')})")
        self.assertFalse(state["title"], "no second, native tooltip")
        self.assertTrue(state["label"], "the accessible name stays")

    def test_keyboard_focus_shows_it_at_once(self):
        page = self.open()
        page.evaluate("() => document.getElementById('undoBtn').focus({focusVisible: true})")
        page.keyboard.press("Tab")
        page.keyboard.press("Shift+Tab")
        page.wait_for_selector("#uiTooltip:not([hidden])", timeout=1500)

    # ---------- the gap under the bars ----------

    def test_what_opens_from_a_bar_sits_clear_of_it(self):
        for viewport, touch in (({"width": 1440, "height": 900}, False), ({"width": 960, "height": 600}, True)):
            for name, act, sel in (
                ("tools", "() => document.querySelector('.file-ribbon-tab[data-ribbon-tab=\"tools\"]').click()", ".file-backstage"),
                ("canvas", "() => document.getElementById('themeToggle').click()", "#canvasThemePop"),
            ):
                with self.subTest(viewport=viewport["width"], surface=name):
                    page = self.open(viewport=viewport, touch=touch)
                    page.evaluate(act)
                    page.wait_for_timeout(400)
                    gap = page.evaluate("""(sel) => { const r = document.querySelector(sel).getBoundingClientRect(); let bar = 0;
                      document.querySelectorAll('.file-ribbon, .toolbar').forEach((b) => { const q = b.getBoundingClientRect();
                        if (q.height && q.bottom <= r.top + 1 && q.top < 200 && q.right > r.left && q.left < r.right) bar = Math.max(bar, q.bottom); });
                      return r.top - bar; }""", sel)
                    self.assertGreaterEqual(gap, 12)

    # ---------- the pen panel on load ----------

    def test_the_pen_is_in_hand_but_its_panel_waits_to_be_asked(self):
        page = self.open()
        page.wait_for_timeout(400)
        state = page.evaluate("""() => ({tool: window.appState.currentTool,
          open: document.getElementById('toolDock')?.classList.contains('has-active-panel') || false})""")
        self.assertEqual(state, {"tool": "pen", "open": False})
        page.click("#eraserTool")
        page.wait_for_function("() => document.getElementById('toolDock').classList.contains('has-active-panel')")

    # ---------- Move for the background picture ----------

    def test_move_slides_the_picture_and_escape_puts_it_back(self):
        page = self.open()
        page.evaluate("""async () => { const c = document.createElement('canvas'); c.width = 300; c.height = 200;
          c.getContext('2d').fillRect(0, 0, 300, 200);
          await window.Inkyscib.CanvasPicture.use(c.toDataURL('image/png'), {fit: 'contain'}); window.Inkyscib.CanvasPicture.move(); }""")
        page.wait_for_selector("#canvasPictureMover")
        page.mouse.move(700, 450)
        page.mouse.down()
        page.mouse.move(844, 450, steps=6)
        page.mouse.up()
        moved = page.evaluate("() => window.Inkyscib.CanvasPicture.get().edit.offsetX")
        self.assertAlmostEqual(moved, 0.1, delta=0.01)
        self.assertEqual(page.evaluate("() => window.appState.paths.length"), 0, "dragging drew nothing")
        page.keyboard.press("Escape")
        self.assertFalse(page.evaluate("() => window.Inkyscib.CanvasPicture.moving()"))
        self.assertIsNone(page.evaluate("() => window.Inkyscib.CanvasPicture.get().edit.offsetX ?? null"))
        page.evaluate("() => window.Inkyscib.CanvasPicture.move()")
        page.mouse.move(700, 450)
        page.mouse.down()
        page.mouse.move(700, 540, steps=6)
        page.mouse.up()
        page.click('#canvasPictureMover [data-move="done"]')
        kept = page.evaluate("() => window.Inkyscib.CanvasPicture.get().edit")
        self.assertAlmostEqual(kept["offsetY"], 0.1, delta=0.01)
        self.assertFalse(kept.get("grid", False), "the grid shown while placing goes back to how it was")
        page.evaluate("() => window.Inkyscib.CanvasPicture.remove()")

    # ---------- the homepage demo ----------

    def test_the_whole_triangle_can_be_dragged_and_the_intro_is_quick(self):
        page = self.open("/")
        page.wait_for_selector("#geometrySvg")
        page.wait_for_timeout(1600)
        self.assertFalse(page.evaluate("() => document.getElementById('geometrySvg').classList.contains('is-drawing')"),
                         "the construction has finished drawing well inside two seconds")
        svg = page.locator("#geometrySvg")
        svg.scroll_into_view_if_needed()
        before = page.evaluate("() => [...document.querySelectorAll('#geometrySvg .point')].map((p) => [+p.getAttribute('cx'), +p.getAttribute('cy')])")
        # The centroid is inside the triangle and far from every corner.
        cx = sum(p[0] for p in before) / 3
        cy = sum(p[1] for p in before) / 3
        at = page.evaluate("""(p) => { const svg = document.getElementById('geometrySvg');
          const q = new DOMPoint(p[0], p[1]).matrixTransform(svg.getScreenCTM()); return [q.x, q.y]; }""", [cx, cy])
        page.mouse.move(at[0], at[1])
        page.mouse.down()
        page.mouse.move(at[0] + 30, at[1] + 20, steps=5)
        page.mouse.up()
        after = page.evaluate("() => [...document.querySelectorAll('#geometrySvg .point')].map((p) => [+p.getAttribute('cx'), +p.getAttribute('cy')])")
        shifts = {(round(a[0] - b[0]), round(a[1] - b[1])) for a, b in zip(after, before)}
        self.assertEqual(len(shifts), 1, "all three corners moved together")
        self.assertNotEqual(shifts.pop(), (0, 0))

    def test_an_obtuse_triangle_carries_bc_on_to_the_foot_of_the_altitude(self):
        page = self.open("/")
        page.wait_for_selector("#geometrySvg")
        page.wait_for_timeout(1500)
        page.locator("#geometrySvg").scroll_into_view_if_needed()
        to_screen = """(p) => { const svg = document.getElementById('geometrySvg');
          const q = new DOMPoint(p[0], p[1]).matrixTransform(svg.getScreenCTM()); return [q.x, q.y]; }"""
        a = page.evaluate("() => { const p = document.querySelector('[data-pt=\"A\"]'); return [+p.getAttribute('cx'), +p.getAttribute('cy')]; }")
        start = page.evaluate(to_screen, a)
        end = page.evaluate(to_screen, [60, 120])
        page.mouse.move(*start)
        page.mouse.down()
        page.mouse.move(*end, steps=8)
        page.mouse.up()
        g = page.evaluate("""() => { const v = (id, k) => +document.getElementById(id).getAttribute(k);
          return { alt: [v('gAlt','x1'), v('gAlt','y1'), v('gAlt','x2'), v('gAlt','y2')],
                   bc: [v('gBC','x1'), v('gBC','y1'), v('gBC','x2'), v('gBC','y2')],
                   ext: [v('gExt','x1'), v('gExt','y1'), v('gExt','x2'), v('gExt','y2')],
                   extShown: document.getElementById('gExt').style.display !== 'none' }; }""")
        ax, ay, fx, fy = g["alt"]
        bx, by, cx, cy = g["bc"]
        dot = (fx - ax) * (cx - bx) + (fy - ay) * (cy - by)
        self.assertLess(abs(dot) / (((fx - ax) ** 2 + (fy - ay) ** 2) ** 0.5 * ((cx - bx) ** 2 + (cy - by) ** 2) ** 0.5), 0.01,
                        "the altitude is perpendicular to BC")
        self.assertTrue(g["extShown"], "the foot is past B, so BC is carried on")
        ex1, ey1, ex2, ey2 = g["ext"]
        self.assertLess(abs(ex1 - bx) + abs(ey1 - by), 0.5, "the extension starts at B")
        # The foot lies on the extension.
        cross = (fx - ex1) * (ey2 - ey1) - (fy - ey1) * (ex2 - ex1)
        self.assertLess(abs(cross) / (((ex2 - ex1) ** 2 + (ey2 - ey1) ** 2) ** 0.5), 0.5)

    # ---------- About ----------

    def test_about_has_the_new_name_type_and_numbers(self):
        page = self.open("/about")
        name = page.locator(".pf-name")
        self.assertEqual(name.get_attribute("aria-label"), "Kshitiz Kumar Sinha")
        self.assertEqual(page.locator(".pf-name .pf-ch").count(), len("KshitizKumarSinha"))
        family = page.evaluate("() => getComputedStyle(document.querySelector('.pf-name')).fontFamily")
        self.assertIn("Bricolage", family)
        size = page.evaluate("() => parseFloat(getComputedStyle(document.querySelector('.pf-name')).fontSize)")
        self.assertGreaterEqual(size, 48, "the name is display size")
        text = page.inner_text(".profile-stats")
        self.assertIn("600+", text)
        self.assertIn("180+", text)
        self.assertRegex(text, re.compile("institutional solver", re.I))


if __name__ == "__main__":
    unittest.main()
