"""Tool panels, tidied (static/css/panel-tidy.css, 2.8.4).

The owner asked for the panels "minimal but aesthetic", in the app's own
theme, with positioning and alignment fixed. These pin each measured fix.
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

TOOLS = ["pen", "eraser", "highlight", "shape", "manipulative", "compass", "angle", "line"]

CONTRAST = r"""() => {
  const P = (c) => { const m = c.match(/[\d.]+/g).map(Number); return { rgb: m.slice(0, 3), a: m[3] ?? 1 }; };
  const lum = (rgb) => { const v = rgb.map((x) => x / 255).map((x) => x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4);
    return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]; };
  const over = (fg, bg) => fg.rgb.map((x, i) => x * fg.a + bg[i] * (1 - fg.a));
  const solid = (el) => { for (let e = el; e; e = e.parentElement) { const c = P(getComputedStyle(e).backgroundColor); if (c.a > 0.95) return c.rgb; } return [255, 255, 255]; };
  return [...document.querySelectorAll('#lineOptions .geometry-toggle-grid input:not(:checked) + span')].filter((s) => s.offsetParent).map((s) => {
    const bg = over(P(getComputedStyle(s).backgroundColor), solid(s.parentElement));
    const fg = over(P(getComputedStyle(s).color), bg);
    const [x, y] = [lum(fg), lum(bg)];
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }); }"""


@unittest.skipUnless(PLAYWRIGHT_AVAILABLE, "Playwright is not installed")
class PanelTidyTests(unittest.TestCase):
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

    def open(self, theme="dark"):
        context = self.browser.new_context(viewport={"width": 1440, "height": 900})
        self.addCleanup(context.close)
        context.add_init_script("localStorage.setItem('inkyscib-feature-tour-v1', 'seen')")
        page = context.new_page()
        page.goto(self.base_url + "/write", wait_until="domcontentloaded")
        page.wait_for_function("() => window.appState?.storageReady === true")
        page.evaluate("(t) => { document.documentElement.dataset.theme = t; }", theme)
        return page

    def show(self, page, tool):
        page.evaluate("(t) => { window.setTool('select'); window.setTool(t); window.Inkyscib.ToolDock?.setCollapsed?.(false); }", tool)
        page.wait_for_timeout(350)

    def test_every_panel_speaks_in_one_readable_voice(self):
        page = self.open()
        for tool in TOOLS:
            with self.subTest(tool=tool):
                self.show(page, tool)
                found = page.evaluate("""(t) => { const p = document.getElementById(t + 'Options');
                  const vis = (sel) => [...p.querySelectorAll(sel)].filter((e) => e.offsetParent);
                  return {
                    hints: vis('.geometry-control-hint, .tile-hint, .compass-label-hint, .geometry-snap-hint').map((h) => parseFloat(getComputedStyle(h).fontSize)),
                    shouting: vis('.geometry-toggle-grid span, .eraser-mode-btn, .compass-btn').filter((e) => getComputedStyle(e).textTransform === 'uppercase').map((e) => e.textContent.trim()),
                    // Lines of text, counted from the text itself: the chip's own
                    // box has a 33px minimum and says nothing about wrapping.
                    wrapped: vis('.geometry-toggle-grid span').filter((e) => {
                      const range = document.createRange(); range.selectNodeContents(e);
                      const tops = new Set([...range.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.top)));
                      return tops.size > 1; }).map((e) => e.textContent.trim()),
                    numbers: vis('input[type=number]').map((n) => [getComputedStyle(n).fontFamily.includes('JetBrains Mono'), getComputedStyle(n).fontVariantNumeric]),
                  }; }""", tool)
                for size in found["hints"]:
                    self.assertGreaterEqual(size, 12, "hints are at least the 12px step")
                self.assertEqual(found["shouting"], [], "choices are sentence case")
                self.assertEqual(found["wrapped"], [], "a short label never wraps")
                for mono, variant in found["numbers"]:
                    self.assertTrue(mono, "numbers are in the mono")
                    self.assertIn("tabular-nums", variant)

    def test_an_off_chip_reads_as_a_choice_on_both_themes(self):
        for theme in ("dark", "light"):
            with self.subTest(theme=theme):
                page = self.open(theme)
                self.show(page, "line")
                ratios = page.evaluate(CONTRAST)
                self.assertTrue(ratios)
                for ratio in ratios:
                    self.assertGreaterEqual(ratio, 4.5)

    def test_the_ring_has_no_line_from_its_centre(self):
        page = self.open()
        page.evaluate("() => { window.setTool('pen'); window.Inkyscib.QuickAccess.openRingAt(700, 450); }")
        self.assertEqual(page.evaluate("() => document.querySelectorAll('#quickRing .qa-aim').length"), 0)


if __name__ == "__main__":
    unittest.main()
