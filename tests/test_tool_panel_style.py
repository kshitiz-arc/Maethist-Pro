"""Tool panels look the same at 960px as they do at 1440px.

Reported 2026-09-17: "Every tool's sub tool i.e., their dialogue box UI is not
interesting. Fix that."

The panels were not unstyled. The styling was gated: everything good lived
behind `@media (min-width: 1180px)` / `body.chrome-rail`, and this product is
written for a ~960px budget Android tablet. Below the gate the panels fell back
to write.css's base layer, which was written for a 48px vertical dock, so on
the target device the size slider was browser-default blue, the swatches were a
ragged flex wrap, headings were centred at 0.66 opacity, and a tall panel
scrolled with no cue that there was more.

These tests run BOTH layouts and assert the same things of each. The viewport
is fixed at context creation: resizing a loaded editor flips it between the two
layouts, which is not how a tablet opens it.
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


LAYOUTS = {"floating": (960, 720), "docked": (1440, 900)}

# Hue ranges that must not appear in a panel. The system is ochre; DESIGN.md
# records the violet as removed (it survived in light mode) and the cyan as the
# "third un-migrated pocket".
# Narrowed from 220 after the first run flagged slate rgba(148,163,184) at
# 215-220deg -- that is neutral chrome, not a palette violation. Real indigo
# (rgba(133,126,255)) sits at 245deg and 0.51 saturation, so the saturation
# floor below separates them without needing the band to reach down into blue.
FORBIDDEN_HUES = (
    ("indigo/violet", 232, 300),
)


@unittest.skipUnless(PLAYWRIGHT_AVAILABLE, "Playwright is not installed")
class ToolPanelStyleTests(unittest.TestCase):
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

    def open_panel(self, tool, width, height):
        context = self.browser.new_context(viewport={"width": width, "height": height})
        self.addCleanup(context.close)
        context.add_init_script(
            "localStorage.setItem('inkyscib-consent-v1', JSON.stringify({version: 1, analytics: false})); localStorage.setItem('inkyscib-feature-tour-v1', JSON.stringify({seen: true}))"
        )
        page = context.new_page()
        page.goto(self.base_url + "/write", wait_until="domcontentloaded")
        page.wait_for_function("() => window.appState?.storageReady === true")
        page.evaluate("(tool) => window.setTool(tool)", tool)
        page.evaluate("() => window.Inkyscib.ToolDock.setCollapsed(false)")
        return page

    # ---- the tablet gets what the desktop gets --------------------------

    def test_the_size_slider_is_the_apps_colour_not_the_browsers(self):
        """accent-color was only set under .chrome-rail, so the slider on the
        target device was browser-default blue."""
        for name, (width, height) in LAYOUTS.items():
            with self.subTest(layout=name):
                page = self.open_panel("pen", width, height)
                accent = page.eval_on_selector(
                    "#penSize", "el => getComputedStyle(el).accentColor"
                )
                self.assertNotIn(
                    accent.lower(), ("auto", "initial", ""),
                    "the size slider is still browser-default",
                )

    def test_the_swatches_are_a_grid_not_a_ragged_wrap(self):
        """DESIGN.md records the ragged wrap as fixed; the fix only landed
        above 1180px."""
        for name, (width, height) in LAYOUTS.items():
            with self.subTest(layout=name):
                page = self.open_panel("pen", width, height)
                display = page.eval_on_selector(
                    "#penOptions .colors", "el => getComputedStyle(el).display"
                )
                self.assertEqual(display, "grid", "the swatches still wrap raggedly")

    def test_headings_are_left_and_legible(self):
        for name, (width, height) in LAYOUTS.items():
            with self.subTest(layout=name):
                page = self.open_panel("pen", width, height)
                style = page.eval_on_selector(
                    "#penOptions .tool-option-heading",
                    """el => {
                         const s = getComputedStyle(el);
                         return { align: s.textAlign, opacity: parseFloat(s.opacity) };
                       }""",
                )
                self.assertIn(style["align"], ("left", "start"))
                self.assertGreaterEqual(
                    style["opacity"], 0.9, "the heading is dimmed to near-unreadable"
                )

    def test_control_rows_lie_along_the_panel(self):
        """.line-types and .arrow-styles were a vertical column below 1180px,
        so the Line panel's five arrow tips stacked into a tower."""
        for name, (width, height) in LAYOUTS.items():
            with self.subTest(layout=name):
                page = self.open_panel("line", width, height)
                direction = page.eval_on_selector(
                    "#lineOptions .arrow-styles",
                    "el => getComputedStyle(el).flexDirection",
                )
                self.assertEqual(direction, "row", "the arrow tips still stack")

    def test_a_tall_panel_says_there_is_more(self):
        """The compass carries ~950px of controls. .has-more was a .tool-dock
        class, and there is no dock below 1180px, so on the tablet it scrolled
        silently."""
        page = self.open_panel("compass", 960, 720)
        page.wait_for_timeout(250)
        has_cue = page.evaluate(
            """() => {
              const panel = document.getElementById('compassOptions');
              if (!panel) return false;
              const scroller = panel.scrollHeight > panel.clientHeight + 2 ? panel : null;
              if (!scroller) return true;  // nothing to scroll, nothing to say
              return panel.classList.contains('has-more') ||
                     panel.closest('.has-more') !== null;
            }"""
        )
        self.assertTrue(has_cue, "a scrolling panel gives no sign there is more")

    # ---- nothing off the palette ----------------------------------------

    def test_no_panel_paints_itself_off_the_palette(self):
        """One accent, and since v2 it is the Blueprint cyan (198deg), so the old
        cyan/teal band is no longer forbidden; indigo and violet still are. The violet DESIGN.md recorded as
        removed survived in light mode, the active swatch border was #8b84ff,
        every checked toggle chip was indigo, and seven focus rings were cyan."""
        for name, (width, height) in LAYOUTS.items():
            with self.subTest(layout=name):
                page = self.open_panel("line", width, height)
                offenders = page.evaluate(
                    """(forbidden) => {
                      const toHsl = (value) => {
                        const m = value.match(/rgba?\\(([^)]+)\\)/);
                        if (!m) return null;
                        const [r, g, b, a] = m[1].split(',').map(Number);
                        if (a === 0) return null;
                        const rr = r / 255, gg = g / 255, bb = b / 255;
                        const max = Math.max(rr, gg, bb), min = Math.min(rr, gg, bb);
                        const d = max - min;
                        if (d < 0.25) return null;            // grey enough to be chrome
                        let h = 0;
                        if (max === rr) h = ((gg - bb) / d) % 6;
                        else if (max === gg) h = (bb - rr) / d + 2;
                        else h = (rr - gg) / d + 4;
                        h = Math.round(h * 60);
                        return h < 0 ? h + 360 : h;
                      };
                      const found = [];
                      const panel = document.getElementById('lineOptions');
                      const nodes = [panel, ...panel.querySelectorAll('*')];
                      for (const el of nodes) {
                        // A swatch's fill is the colour you draw with, and
                        // tokens.css exempts the user's ink from the palette
                        // by name: content, not chrome.
                        if (el.classList.contains('color-swatch')) continue;
                        if (el.tagName === 'INPUT' && el.type === 'color') continue;
                        const s = getComputedStyle(el);
                        for (const prop of ['backgroundColor', 'borderTopColor', 'color', 'outlineColor']) {
                          const hue = toHsl(s[prop]);
                          if (hue === null) continue;
                          for (const [label, lo, hi] of forbidden) {
                            if (hue >= lo && hue <= hi) {
                              found.push(label + ' ' + hue + 'deg on ' +
                                (el.className || el.tagName) + ' via ' + prop);
                            }
                          }
                        }
                      }
                      return found.slice(0, 8);
                    }""",
                    FORBIDDEN_HUES,
                )
                self.assertEqual(offenders, [], "off-palette colour in a tool panel")

    def test_a_checked_toggle_takes_the_accent(self):
        for name, (width, height) in LAYOUTS.items():
            with self.subTest(layout=name):
                page = self.open_panel("line", width, height)
                page.evaluate(
                    """() => {
                      const input = document.querySelector('#lineOptions .geometry-toggle-grid input');
                      if (input && !input.checked) input.click();
                    }"""
                )
                page.wait_for_timeout(120)
                accent = page.evaluate(
                    "() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()"
                )
                self.assertTrue(accent, "--accent is not defined")

    def test_panels_do_not_blur_what_they_then_cover(self):
        """An opaque fill over a backdrop-filter blurs pixels the fill hides --
        pure cost, and DESIGN.md removed exactly this from the rail and top bar.
        This one survived, on the device with the slowest GPU."""
        for name, (width, height) in LAYOUTS.items():
            with self.subTest(layout=name):
                page = self.open_panel("pen", width, height)
                filters = page.eval_on_selector(
                    "#penOptions",
                    """el => {
                         const s = getComputedStyle(el);
                         return [s.backdropFilter, s.webkitBackdropFilter].join(' ');
                       }""",
                )
                self.assertNotIn("blur", filters)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
