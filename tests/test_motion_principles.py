"""The motion and interaction principles (DESIGN.md, "Motion and interaction
principles"): each one asked for by name, each with a rule and a home.
These pin the behaviours the code implements; the rest are design rules the
table records.
"""

import json
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

ROOT = Path(__file__).resolve().parents[1]
PRINCIPLES = [
    "Timing", "Slow in, slow out", "Anticipation", "Squash and stretch", "Follow-through", "Arcs",
    "Staggering", "Origin awareness", "Interruptible motion", "Rubber banding", "Secondary action",
    "Exaggeration", "Solid drawing", "Doherty threshold", "Fitts's law", "Hick's law",
    "Frequency of use", "Von Restorff effect", "Peak-end rule",
]


class DesignDocTests(unittest.TestCase):
    def test_every_principle_has_a_row(self):
        text = (ROOT / "DESIGN.md").read_text(encoding="utf-8")
        for name in PRINCIPLES:
            with self.subTest(principle=name):
                self.assertIn(f"| **{name}** |", text)


@unittest.skipUnless(PLAYWRIGHT_AVAILABLE, "Playwright is not installed")
class MotionPrincipleTests(unittest.TestCase):
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

    def open(self, reduced=False):
        context = self.browser.new_context(viewport={"width": 1440, "height": 900},
                                           reduced_motion="reduce" if reduced else "no-preference")
        self.addCleanup(context.close)
        context.add_init_script("localStorage.setItem('inkyscib-feature-tour-v1', 'seen')")
        page = context.new_page()
        self.errors = []
        page.on("pageerror", lambda error: self.errors.append(str(error)))
        page.goto(self.base_url + "/write", wait_until="domcontentloaded")
        page.wait_for_function("() => window.appState?.storageReady === true && !!window.Inkyscib?.Motion?.stagger && !!window.Inkyscib?.UiKit")
        return page

    def test_a_press_squashes_at_once_and_stretches_on_release(self):
        page = self.open()
        box = page.locator("#undoBtn").bounding_box()
        page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
        page.mouse.down()
        pressed = page.evaluate("() => document.getElementById('undoBtn').classList.contains('mx-press')")
        page.mouse.up()
        released = page.evaluate("() => document.getElementById('undoBtn').classList.contains('mx-release')")
        self.assertTrue(pressed, "anticipation: the squash starts on pointerdown")
        self.assertTrue(released, "follow-through: the release plays")
        self.assertEqual(self.errors, [])

    def test_reduced_motion_keeps_buttons_still(self):
        page = self.open(reduced=True)
        box = page.locator("#undoBtn").bounding_box()
        page.mouse.move(box["x"] + 5, box["y"] + 5)
        page.mouse.down()
        self.assertFalse(page.evaluate("() => document.getElementById('undoBtn').classList.contains('mx-press')"))
        page.mouse.up()

    def test_the_canvas_popover_grows_from_its_button(self):
        page = self.open()
        page.click("#themeToggle")
        page.wait_for_selector("#canvasThemePop.mx-origin:not([hidden])")
        state = page.evaluate("""() => { const pop = document.getElementById('canvasThemePop');
          const b = document.getElementById('themeToggle').getBoundingClientRect();
          // The popover's set place, not its box: mid-grow, scale shrinks the box.
          const p = { left: parseFloat(pop.style.left) };
          return { cls: pop.classList.contains('mx-origin'), ox: parseFloat(pop.style.getPropertyValue('--mx-ox')),
                   expected: b.left + b.width / 2 - p.left }; }""")
        self.assertTrue(state["cls"])
        self.assertLess(abs(state["ox"] - state["expected"]), 6, "the origin is the button, to the pixel or so")

    def test_the_file_sheet_is_gone_after_it_closes(self):
        """Reported (2.8.1): the sheet stayed painted on screen after closing,
        because its grow-in animation held opacity 1 over the fade-out."""
        page = self.open()
        page.click('.file-ribbon-tab[data-ribbon-tab="file"]')
        page.wait_for_selector(".file-backstage.is-open")
        page.wait_for_timeout(400)
        page.keyboard.press("Escape")
        page.wait_for_timeout(500)
        state = page.evaluate("""() => { const b = document.querySelector('.file-backstage');
          return { open: b.classList.contains('is-open'), opacity: getComputedStyle(b).opacity, anim: getComputedStyle(b).animationName }; }""")
        self.assertFalse(state["open"])
        self.assertEqual(state["opacity"], "0", state)
        page.click('.file-ribbon-tab[data-ribbon-tab="tools"]')
        page.wait_for_selector(".file-backstage.is-open")
        page.wait_for_timeout(400)
        self.assertEqual(page.evaluate("() => getComputedStyle(document.querySelector('.file-backstage')).opacity"), "1",
                         "and it still opens")

    def test_no_button_has_a_line_under_it(self):
        """Reported (2.8.2): the nav pills drew a text-link underline across
        their bottom edge, and the editor's home tile kept the browser's own."""
        scan = """() => [...document.querySelectorAll('header .nav a, .file-ribbon-home')].filter((e) => e.offsetParent).map((e) => {
          const after = getComputedStyle(e, '::after');
          return { text: e.textContent.trim(), underline: getComputedStyle(e).textDecorationLine,
                   line: after.content !== 'none' && after.content !== 'normal' && parseFloat(after.height) <= 4 }; })"""
        page = self.open()
        found = page.evaluate(scan)
        page.goto(self.base_url + "/about", wait_until="domcontentloaded")
        page.hover("header .nav a")
        found += page.evaluate(scan)
        self.assertTrue(found)
        for item in found:
            with self.subTest(item=item["text"]):
                self.assertNotIn("underline", item["underline"])
                self.assertFalse(item["line"])

    def test_search_rows_stagger_and_what_you_use_most_comes_first(self):
        page = self.open()
        for _ in range(3):
            page.keyboard.press("Control+k")
            page.wait_for_selector("#commandPalette:not([hidden])")
            page.keyboard.type("compass")
            page.keyboard.press("Enter")
            page.wait_for_function("() => document.getElementById('commandPalette').hidden")
        page.keyboard.press("Escape")
        page.keyboard.press("Control+k")
        page.wait_for_selector("#commandPalette:not([hidden])")
        state = page.evaluate("""() => { const list = document.getElementById('commandList');
          return { stagger: list.classList.contains('mx-stagger'),
                   firstGroup: list.querySelector('.ui-palette-group')?.textContent,
                   first: list.querySelector('.ui-palette-item .ui-palette-title')?.textContent,
                   i3: list.querySelectorAll('.ui-palette-item')[3]?.style.getPropertyValue('--mx-i') }; }""")
        self.assertTrue(state["stagger"])
        self.assertEqual(state["firstGroup"], "Frequent")
        self.assertEqual(state["first"], "Compass")
        self.assertTrue(state["i3"])
        counts = page.evaluate("() => JSON.parse(localStorage.getItem('inkyscib-command-usage'))")
        self.assertEqual(counts, {"tool-compass": 3})

    def test_ring_slices_take_an_arc_and_closing_can_be_interrupted(self):
        page = self.open()
        page.evaluate("() => { window.setTool('pen'); window.Inkyscib.QuickAccess.openRingAt(700, 450); }")
        arc = page.evaluate("""() => [...document.querySelectorAll('#quickRing [data-slice]')].map((s) => {
          const g = (k) => parseFloat(s.style.getPropertyValue(k)); return [g('--x'), g('--y'), g('--ax'), g('--ay')]; })""")
        for x, y, ax, ay in arc:
            # The midpoint is off the straight line from the centre to the slice.
            cross = x * ay - y * ax
            self.assertGreater(abs(cross), 1500)
        page.evaluate("() => window.Inkyscib.QuickAccess.close()")
        closing = page.evaluate("() => { const r = document.getElementById('quickRing'); return { hidden: r.hidden, closing: r.classList.contains('is-closing') }; }")
        self.assertEqual(closing, {"hidden": False, "closing": True}, "it leaves rather than vanishing")
        page.evaluate("() => window.Inkyscib.QuickAccess.openRingAt(700, 450)")
        page.wait_for_timeout(200)
        reopened = page.evaluate("() => { const r = document.getElementById('quickRing'); return { hidden: r.hidden, open: r.classList.contains('is-open'), closing: r.classList.contains('is-closing') }; }")
        self.assertEqual(reopened, {"hidden": False, "open": True, "closing": False})

    def test_rubber_band_resists_and_is_bounded(self):
        page = self.open()
        out = page.evaluate("""() => { const r = window.Inkyscib.Motion.rubber;
          return [r(50, 0, 100), r(-40, 0, 100, 90), r(-4000, 0, 100, 90), r(140, 0, 100, 90)]; }""")
        self.assertEqual(out[0], 50, "inside the limits it follows exactly")
        self.assertTrue(-40 < out[1] < 0, "past the limit it moves less than the pointer")
        self.assertGreater(out[2], -90, "and never more than its reach")
        self.assertTrue(100 < out[3] < 140)

    def test_ticking_a_task_pops_the_tick(self):
        page = self.open()
        page.evaluate("""() => { const d = new Date(); const key = [d.getFullYear(), String(d.getMonth()+1).padStart(2,'0'), String(d.getDate()).padStart(2,'0')].join('-');
          localStorage.setItem('inkyscib-planner-v1', JSON.stringify({version: 1, tasks: [{id: 't', title: 'One thing', startDate: key, recurrence: 'none', createdAt: 1, completed: {}}]})); }""")
        page.reload(wait_until="domcontentloaded")
        page.wait_for_function("() => window.appState?.storageReady === true && !!window.Inkyscib?.FileRibbon")
        page.evaluate("() => window.Inkyscib.FileRibbon.runCommand('planner')")
        page.wait_for_selector("#plannerModal:not([hidden]) .planner-task-check")
        page.click("#plannerTaskList .planner-task-check")
        self.assertTrue(page.evaluate("() => document.querySelector('#plannerTaskList .planner-task-check').classList.contains('is-just-done')"))
        self.assertTrue(page.evaluate("() => document.getElementById('plannerStreakValue').classList.contains('is-bumped')"))


if __name__ == "__main__":
    unittest.main()
