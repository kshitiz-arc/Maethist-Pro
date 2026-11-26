"""Maths that answers back (static/js/ink-math.js, 2.9.0).

Write a line of maths with the pen and pause; a chip answers it. Pinned
here: the solver, reading real ink drawn through the canvas (write assist
included), silence on anything that is not maths, and the pen panel's Off.
"""

import math
import threading
import unittest

from app import app
from browser_server import make_browser_server

try:
    from playwright.sync_api import sync_playwright

    PLAYWRIGHT_AVAILABLE = True
except ImportError:  # pragma: no cover
    PLAYWRIGHT_AVAILABLE = False

PI = math.pi


def L(x0, y0, x1, y1, n=10):
    return [(x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n) for i in range(n + 1)]


def arc(cx, cy, rx, ry, a, b, n=20):
    return [(cx + math.cos(a + (b - a) * i / n) * rx, cy + math.sin(a + (b - a) * i / n) * ry) for i in range(n + 1)]


# How a hand writes each symbol, in a unit box (y down).
GLYPHS = {
    "1": [L(0.3, 0.2, 0.5, 0.02, 5) + L(0.5, 0.02, 0.5, 0.98, 16)],
    "2": [arc(0.5, 0.33, 0.32, 0.28, PI, 2 * PI, 16) + L(0.82, 0.33, 0.14, 0.95, 12) + L(0.14, 0.95, 0.9, 0.95, 8)],
    "3": [arc(0.46, 0.27, 0.3, 0.24, -0.8 * PI, 0.5 * PI, 16) + arc(0.44, 0.72, 0.34, 0.26, -0.55 * PI, 0.8 * PI, 16)],
    "5": [L(0.8, 0.05, 0.26, 0.05, 8) + L(0.26, 0.05, 0.21, 0.45, 6) + arc(0.47, 0.7, 0.32, 0.28, -0.5 * PI, 0.75 * PI, 16)],
    "7": [L(0.14, 0.08, 0.86, 0.08, 10) + L(0.86, 0.08, 0.34, 0.97, 14)],
    "8": [arc(0.5, 0.27, 0.26, 0.25, -PI / 2, -PI / 2 + 2 * PI, 18) + arc(0.5, 0.74, 0.31, 0.24, -PI / 2, -PI / 2 - 2 * PI, 18)],
    "9": [arc(0.5, 0.29, 0.29, 0.27, -PI / 2, -PI / 2 - 2 * PI, 20) + L(0.79, 0.29, 0.64, 0.98, 10)],
    "+": [L(0.5, 0.2, 0.5, 0.8), L(0.2, 0.5, 0.8, 0.5)],
    "=": [L(0.2, 0.38, 0.8, 0.38), L(0.2, 0.62, 0.8, 0.62)],
    "x": [L(0.25, 0.35, 0.75, 0.85), L(0.75, 0.35, 0.25, 0.85)],
    "4": [L(0.62, 0.02, 0.12, 0.66, 12) + L(0.12, 0.66, 0.9, 0.66, 10), L(0.66, 0.3, 0.66, 0.98, 10)],
    # y in two strokes: a short arm into the middle of a long stem below it.
    "y": [L(0.2, 0.35, 0.5, 0.68), L(0.8, 0.35, 0.3, 1.2, 14)],
    ".": [L(0.45, 0.92, 0.5, 0.96, 2)],
}


@unittest.skipUnless(PLAYWRIGHT_AVAILABLE, "Playwright is not installed")
class InkMathTests(unittest.TestCase):
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
        page.wait_for_function("() => window.appState?.storageReady === true && !!window.Inkyscib?.InkMath")
        page.wait_for_timeout(300)
        page.evaluate("() => { window.setTool('pen'); window.Inkyscib.ToolDock?.setCollapsed?.(true); }")
        return page

    def write(self, page, text, x, y, size=40):
        """Write text in ink. "^" raises the next symbol, small, as a power."""
        cx = x
        raise_next = False
        for ch in text:
            if ch == "^":
                raise_next = True
                continue
            h, top = (size * 0.5, y - size * 0.22) if raise_next else (size, y)
            raise_next = False
            w = h * 0.5 if ch == "1" else h * (0.3 if ch == "." else 0.75)
            for stroke in GLYPHS[ch]:
                pts = [(cx + px * w, top + py * h) for px, py in stroke]
                page.mouse.move(*pts[0])
                page.mouse.down()
                for point in pts[1:]:
                    page.mouse.move(*point)
                page.mouse.up()
            cx += w + (6 if ch == "." or h < size else 12)

    def chip(self, page):
        return page.evaluate("""() => { const c = document.getElementById('inkMathChip');
          return c && !c.hidden ? { read: c.dataset.read, kind: c.dataset.kind, say: c.querySelector('.im-say').textContent } : null; }""")

    def test_the_solver_answers_checks_and_solves(self):
        page = self.open()
        cases = {
            "12+7=": "= 19", "7-9=": "= -2", "3x4=": "= 12", "10÷4=": "= 5/2 = 2.5",
            "5+3=9": "Not quite: 5 + 3 = 8", "6x4=24": "Correct", "12/3=4": "Correct",
            "2x+3=11": "x = 4", "2(x+1)=x+5": "x = 3", "3x=7": "x = 7/3 ≈ 2.333",
            "x(x-5)=-6": "x = 2 or x = 3", "x+1=x+2": "No x makes this true",
        }
        got = page.evaluate("(cs) => Object.fromEntries(cs.map((c) => [c, window.Inkyscib.InkMath.answer(c)?.say ?? null]))", list(cases))
        self.assertEqual(got, cases)
        silent = page.evaluate("() => ['hello', '1+2', '=5', 'x=4', 'y=', 'x=xy', ''].map((c) => window.Inkyscib.InkMath.answer(c))")
        self.assertEqual(silent, [None] * 7, "nothing to say, so nothing is said")

    def test_powers_decimals_and_higher_degrees(self):
        page = self.open()
        cases = {
            "x^2=9": "x = -3 or x = 3", "2^10=": "= 1024", "3^2+4^2=5^2": "Correct",
            "0.1+0.2=": "= 0.3", "2.5x4=": "= 10", "1.5+1.5=4": "Not quite: 1.5 + 1.5 = 3",
            "x^3-6x^2+11x-6=0": "x = 1, 2 or 3", "(x-1)^2(x+2)=0": "x = -2 or x = 1",
            "x^2+1=0": "No real x", "x^3=2": "x ≈ 1.26", "x^4=16": "x = -2 or x = 2",
            "1/x=4": "x = 1/4",
        }
        got = page.evaluate("(cs) => Object.fromEntries(cs.map((c) => [c, window.Inkyscib.InkMath.answer(c)?.say ?? null]))", list(cases))
        self.assertEqual(got, cases)
        graph = page.evaluate("() => { const a = window.Inkyscib.InkMath.answer('y=x^2-4'); return [a.kind, a.say]; }")
        self.assertEqual(graph, ["graph", "y = x² - 4"])

    def test_written_powers_and_decimals_are_read(self):
        page = self.open()
        self.write(page, "x^2=4", 560, 300)
        page.wait_for_timeout(1300)
        self.assertEqual(self.chip(page), {"read": "x^2=4", "kind": "solve", "say": "x = -2 or x = 2"})
        self.write(page, "2.5x4=", 560, 450)
        page.wait_for_timeout(1300)
        self.assertEqual(self.chip(page), {"read": "2.5x4=", "kind": "value", "say": "= 10"})
        self.assertEqual(self.errors, [])

    def test_a_written_y_line_offers_a_graph_drawn_in_ink(self):
        page = self.open()
        self.write(page, "y=2x+1", 480, 220)
        page.wait_for_timeout(1300)
        self.assertEqual(self.chip(page), {"read": "y=2x+1", "kind": "graph", "say": "y = 2x + 1"})
        before = page.evaluate("() => window.appState.paths.length")
        page.click("#inkMathChip .im-act")
        page.wait_for_timeout(150)
        added = page.evaluate("""() => { const g = window.appState.paths.filter((p) => p.mathGraph);
          return { n: g.length, ids: new Set(g.map((p) => p.mathGraph)).size,
                   pen: g.every((p) => p.tool === 'pen' && p.points.length >= 2) }; }""")
        self.assertGreater(added["n"], 10, "axes, ticks, numbers and the curve")
        self.assertEqual(added["ids"], 1)
        self.assertTrue(added["pen"], "ordinary ink, so it saves, exports and erases like writing")
        self.assertTrue(page.evaluate("() => document.getElementById('inkMathChip').hidden"))
        # Slope 2 at equal scales is -2 on a y-down page.
        slope = page.evaluate("""() => { const curve = window.appState.paths.filter((p) => p.mathGraph && p.color !== '#8a8f98');
          const pts = curve.flatMap((p) => p.points); const a = pts[0], b = pts[pts.length - 1];
          return (b.y - a.y) / (b.x - a.x); }""")
        self.assertAlmostEqual(slope, -2, delta=0.05)
        page.keyboard.press("Control+z")
        page.wait_for_timeout(150)
        self.assertEqual(page.evaluate("() => window.appState.paths.length"), before, "one undo takes the whole graph off")
        self.assertEqual(self.errors, [])

    def test_written_maths_is_answered_at_the_end_of_its_line(self):
        page = self.open()
        self.write(page, "12+7=", 560, 300)
        page.wait_for_timeout(1300)
        first = self.chip(page)
        self.assertEqual(first, {"read": "12+7=", "kind": "value", "say": "= 19"})
        self.write(page, "2x+3=11", 560, 450)
        page.wait_for_timeout(1300)
        self.assertEqual(self.chip(page), {"read": "2x+3=11", "kind": "solve", "say": "x = 4"},
                         "only the line just written is read, not the one above")
        box = page.evaluate("() => document.getElementById('inkMathChip').getBoundingClientRect().left")
        self.assertGreater(box, 560 + 40 * 3, "the chip sits after the writing, not over it")
        self.assertEqual(self.errors, [])

    def test_a_wrong_sum_is_marked_with_the_right_one(self):
        page = self.open()
        self.write(page, "5+3=9", 560, 300)
        page.wait_for_timeout(1300)
        self.assertEqual(self.chip(page), {"read": "5+3=9", "kind": "wrong", "say": "Not quite: 5 + 3 = 8"})

    def test_scribbles_are_never_answered(self):
        page = self.open()
        shown = page.evaluate("""() => { let seed = 99; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
          const letter = (x, y, h) => { const pts = []; let px = x, py = y + rnd() * h, a = rnd() * 6.28;
            const n = 18 + Math.floor(rnd() * 30);
            for (let i = 0; i < n; i++) { a += (rnd() - 0.5) * 1.2; px += Math.cos(a) * h * 0.08 + h * 0.02; py = Math.max(y, Math.min(y + h, py + Math.sin(a) * h * 0.08)); pts.push({ x: px, y: py }); }
            return pts; };
          let shown = 0;
          for (let t = 0; t < 1500; t++) {
            const strokes = []; let x = 50; const h = 30 + rnd() * 30;
            for (let i = 0, n = 3 + Math.floor(rnd() * 8); i < n; i++) { const s = letter(x, 200, h); strokes.push(s); x = Math.max(...s.map((p) => p.x)) + 4 + rnd() * 10; }
            const r = window.Inkyscib.InkMath.readLine(strokes);
            if (r && window.Inkyscib.InkMath.answer(r.text)) shown++;
          }
          return shown; }""")
        self.assertEqual(shown, 0)

    def test_the_pen_panel_can_switch_it_off(self):
        page = self.open()
        page.evaluate("() => document.querySelector('[data-math-answers=\"off\"]').click()")
        self.assertFalse(page.evaluate("() => window.appState.toolSettings.pen.mathAnswers"))
        self.write(page, "12+7=", 560, 300)
        page.wait_for_timeout(1300)
        self.assertIsNone(self.chip(page))


if __name__ == "__main__":
    unittest.main()
