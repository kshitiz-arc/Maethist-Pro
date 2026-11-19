"""Where tool panels and the other floating surfaces go, at the sizes that matter.

Reported on 2026-09-21 as "every button dialogue box sometimes overlaps".
Measured before any fix, at the ~960x600 budget tablet this product is written
for (CLAUDE.md), a 390x844 phone and a 1440x900 desktop:

* Algebra tiles' panel never opened below 1180px. Its button selected the tool,
  the dock showed the panel, then a leftover toggleToolbox() hid it again.
* Every tool ran its own open/close gesture below 1180px -- single tap for two,
  a 300ms double tap for four, none at all for one -- writing style.display
  behind tool-dock.js's back, so the two disagreed about what was open.
* Floating panels ran 20px off the bottom of a 600px window and over the
  footer's privacy links: content-box sizing put the padding, border and a
  stray margin outside the max-height.
* They lived inside the toolbar, which is centred with a transform. A transform
  is the containing block for position:fixed children, so each panel was
  placed from the toolbar's corner (46px across on a phone) and stuck under
  its z-index of 10.
* Tapping the canvas and pressing Escape both did nothing below 1180px -- the
  one width where the panel sits over the canvas.
* The canvas-theme popover opened over an open panel; the colour studio opened
  over the toolbar, hiding six of its buttons; the File sheet ran to y=709 in a
  600px window, with "Clear canvas" at 664 and nothing that scrolled to it.

Every test here waits for transitions to finish: the preview pane these were
first found in never advances CSS transitions, and a panel frozen mid-slide
reads as a layout bug that a real browser does not have.
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


TOOLS = ("pen", "eraser", "highlight", "shape", "manipulative", "compass", "angle", "line")
TABLET = {"width": 960, "height": 600}
PHONE = {"width": 390, "height": 844}
DESKTOP = {"width": 1440, "height": 900}
SETTLE_MS = 350  # longest chrome transition is 200ms

# Rectangles, overlap and the free area, measured in the page.
HELPERS = """
window.__rect = (el) => { const r = el.getBoundingClientRect();
  return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height }; };
window.__overlap = (a, b) => Math.max(0, Math.min(a.r, b.r) - Math.max(a.l, b.l)) *
  Math.max(0, Math.min(a.b, b.b) - Math.max(a.t, b.t));
window.__shown = (id) => getComputedStyle(document.getElementById(id)).display !== 'none';
window.__pick = (tool) => { document.getElementById('selectTool').click();
  document.getElementById(tool + 'Tool').click(); };
"""


@unittest.skipUnless(PLAYWRIGHT_AVAILABLE, "Playwright is not installed")
class ToolPanelLayoutTests(unittest.TestCase):
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

    def open_page(self, viewport):
        # Fixed at creation: resizing a loaded editor crosses the dock
        # breakpoint, which is a different layout from the one a device opens in.
        context = self.browser.new_context(viewport=viewport)
        self.addCleanup(context.close)
        page = context.new_page()
        self.errors = []
        page.on("pageerror", lambda error: self.errors.append(str(error)))
        page.add_init_script(
            "localStorage.setItem('inkyscib-feature-tour-v1', 'dismissed');"
            "localStorage.setItem('inkyscib-consent-v1',"
            " JSON.stringify({version: 1, analytics: false}));"
        )
        page.goto(f"{self.base_url}/write", wait_until="load")
        page.wait_for_function("() => !!window.Inkyscib?.ToolDock && !!window.appState")
        page.evaluate("() => {" + HELPERS + "return true; }")
        return page

    def pick(self, page, tool):
        page.evaluate("tool => window.__pick(tool)", tool)
        page.wait_for_timeout(SETTLE_MS)

    def tap_tool(self, page, tool):
        page.evaluate("tool => document.getElementById(tool + 'Tool').click()", tool)
        page.wait_for_timeout(SETTLE_MS)

    def shown(self, page, tool):
        return page.evaluate("id => window.__shown(id)", tool + "Options")

    # ---------- one gesture, one owner ----------

    def test_every_tool_opens_its_panel_on_the_first_tap_at_every_width(self):
        for name, viewport in (("phone", PHONE), ("tablet", TABLET), ("desktop", DESKTOP)):
            page = self.open_page(viewport)
            for tool in TOOLS:
                with self.subTest(size=name, tool=tool):
                    self.pick(page, tool)
                    self.assertTrue(self.shown(page, tool), f"{tool} panel did not open at {name}")
        self.assertEqual(self.errors, [])

    def test_a_second_tap_closes_the_panel_and_a_third_reopens_it(self):
        for name, viewport in (("phone", PHONE), ("tablet", TABLET), ("desktop", DESKTOP)):
            page = self.open_page(viewport)
            for tool in TOOLS:
                with self.subTest(size=name, tool=tool):
                    self.pick(page, tool)
                    self.tap_tool(page, tool)
                    self.assertFalse(self.shown(page, tool), "a second tap must put it away")
                    self.tap_tool(page, tool)
                    self.assertTrue(self.shown(page, tool), "and a third bring it back")

    def test_touching_the_canvas_or_pressing_escape_puts_a_settings_panel_away(self):
        page = self.open_page(TABLET)
        self.pick(page, "pen")
        page.mouse.click(700, 400)
        page.wait_for_timeout(SETTLE_MS)
        self.assertFalse(self.shown(page, "pen"), "a tap on the canvas must clear the panel")

        self.tap_tool(page, "pen")
        self.assertTrue(self.shown(page, "pen"))
        page.keyboard.press("Escape")
        page.wait_for_timeout(SETTLE_MS)
        self.assertFalse(self.shown(page, "pen"), "Escape must clear the panel")

    def test_the_compass_panel_survives_a_canvas_tap(self):
        """It is the live readout of a construction, not settings (tool-dock.js)."""
        page = self.open_page(TABLET)
        self.pick(page, "compass")
        page.mouse.click(700, 400)
        page.wait_for_timeout(SETTLE_MS)
        self.assertTrue(self.shown(page, "compass"))

    def test_no_floating_panel_opens_by_itself_when_the_editor_loads(self):
        """Opened unasked, the pen panel covered the left third of a 960px
        tablet on load -- where a left-to-right writer starts -- and a first
        stroke there landed on the panel instead of the page."""
        for name, viewport in (("phone", PHONE), ("tablet", TABLET)):
            with self.subTest(size=name):
                page = self.open_page(viewport)
                page.wait_for_timeout(SETTLE_MS)
                self.assertFalse(self.shown(page, "pen"))
                # The pen is in hand, so one tap on it opens its panel.
                self.tap_tool(page, "pen")
                self.assertTrue(self.shown(page, "pen"))

    def test_the_desktop_dock_waits_to_be_asked_on_load(self):
        """Owner request (2.7.1): "Start writing" opened with the Pen panel
        showing. The pen is in hand; its panel opens when a tool is picked."""
        page = self.open_page(DESKTOP)
        page.wait_for_timeout(SETTLE_MS)
        self.assertFalse(self.shown(page, "pen"), "nothing opens unasked")
        page.evaluate("() => { window.setTool('select'); window.setTool('pen'); }")
        page.wait_for_timeout(SETTLE_MS)
        self.assertTrue(self.shown(page, "pen"), "the dock is a column, not an overlay")

    def test_a_floating_panel_sits_under_the_windows_a_person_opens(self):
        """Body-level, a panel's z-index finally means something, so it has to
        be the right one: under the assist chip, the YouTube player and every
        sheet, as it effectively always was inside the toolbar."""
        page = self.open_page(TABLET)
        self.pick(page, "pen")
        z = page.evaluate(
            """() => ({
              panel: +getComputedStyle(document.getElementById('penOptions')).zIndex,
              player: +getComputedStyle(document.getElementById('ytPlayer')).zIndex,
              scrim: +getComputedStyle(document.querySelector('.file-backstage-scrim')).zIndex,
              toolbar: +getComputedStyle(document.querySelector('.toolbar')).zIndex,
            })"""
        )
        self.assertGreater(z["panel"], z["toolbar"])
        self.assertLess(z["panel"], z["player"])
        self.assertLess(z["panel"], z["scrim"])

    # ---------- where a floating panel goes ----------

    def test_floating_panels_sit_between_the_bars_and_the_footer(self):
        for name, viewport in (("phone", PHONE), ("tablet", TABLET)):
            page = self.open_page(viewport)
            widths = set()
            for tool in TOOLS:
                with self.subTest(size=name, tool=tool):
                    self.pick(page, tool)
                    m = page.evaluate(
                        """tool => {
                          const panel = document.getElementById(tool + 'Options');
                          const p = window.__rect(panel);
                          const bars = ['.toolbar', '.file-ribbon', 'footer']
                            .map(s => window.__rect(document.querySelector(s)));
                          return {
                            p, vw: innerWidth, vh: innerHeight,
                            covered: bars.map(b => window.__overlap(p, b)),
                            sideways: panel.scrollWidth > panel.clientWidth + 1,
                            parent: panel.parentElement.id,
                          };
                        }""",
                        tool,
                    )
                    p = m["p"]
                    widths.add(round(p["w"]))
                    self.assertEqual(m["parent"], "toolPanelLayer",
                                     "a floating panel must not live inside the transformed toolbar")
                    self.assertAlmostEqual(p["l"], 12, delta=1, msg="docks to the left edge")
                    self.assertLessEqual(p["b"], m["vh"], "runs off the bottom of the window")
                    self.assertLessEqual(p["r"], m["vw"], "runs off the right of the window")
                    self.assertEqual(m["covered"], [0, 0, 0],
                                     "covers the toolbar, the ribbon or the footer's links")
                    self.assertFalse(m["sideways"], "scrolls sideways")
            with self.subTest(size=name):
                self.assertEqual(len(widths), 1, f"panels come out at different widths: {widths}")

    # ---------- one floating surface at a time ----------

    def test_the_canvas_theme_popover_and_a_tool_panel_never_share_the_screen(self):
        page = self.open_page(TABLET)
        self.pick(page, "pen")
        page.click("#themeToggle")
        page.wait_for_timeout(SETTLE_MS)
        popover = page.evaluate("() => !document.getElementById('canvasThemePop').hidden")
        self.assertTrue(popover)
        self.assertFalse(self.shown(page, "pen"), "the pen panel stayed open under the popover")

        # And the other way round, without a pointerdown outside it -- a tool
        # opened from script or the keyboard.
        page.evaluate("() => window.__pick('highlight')")
        page.wait_for_timeout(SETTLE_MS)
        popover = page.evaluate("() => !document.getElementById('canvasThemePop').hidden")
        self.assertFalse(popover, "the popover stayed open over a tool panel")
        self.assertTrue(self.shown(page, "highlight"))

    def test_opening_a_file_menu_puts_a_floating_panel_away(self):
        page = self.open_page(TABLET)
        self.pick(page, "pen")
        page.locator(".file-ribbon button", has_text="File").first.click()
        page.wait_for_timeout(SETTLE_MS)
        self.assertFalse(self.shown(page, "pen"))

    def test_the_file_sheet_fits_the_window_and_every_command_can_be_reached(self):
        for name, viewport in (("phone", PHONE), ("tablet", TABLET)):
            with self.subTest(size=name):
                page = self.open_page(viewport)
                page.locator(".file-ribbon button", has_text="File").first.click()
                page.wait_for_timeout(SETTLE_MS)
                m = page.evaluate(
                    """() => {
                      const sheet = document.querySelector('.file-backstage');
                      const commands = [...sheet.querySelectorAll('.file-command')]
                        .filter(c => c.checkVisibility());
                      const last = commands[commands.length - 1];
                      last.scrollIntoView({ block: 'nearest' });
                      const r = last.getBoundingClientRect();
                      return { sheetBottom: sheet.getBoundingClientRect().bottom,
                               lastTop: r.top, lastBottom: r.bottom, vh: innerHeight,
                               label: last.textContent.trim().split('\\n')[0] };
                    }"""
                )
                self.assertLessEqual(m["sheetBottom"], m["vh"], "the sheet runs off the window")
                self.assertLessEqual(m["lastBottom"], m["vh"],
                                     f"'{m['label']}' cannot be scrolled into view")
                self.assertGreaterEqual(m["lastTop"], 0)

    def test_the_colour_studio_opens_beside_its_panel_and_clear_of_the_toolbar(self):
        for name, viewport in (("tablet", TABLET), ("desktop", DESKTOP)):
            with self.subTest(size=name):
                page = self.open_page(viewport)
                self.pick(page, "pen")
                page.click("#penOptions .studio-trigger")
                page.wait_for_timeout(SETTLE_MS)
                m = page.evaluate(
                    """() => {
                      const studio = window.__rect(document.querySelector('.color-studio'));
                      const owner = document.querySelector('#toolDock.is-enabled') ||
                                    document.getElementById('penOptions');
                      const covered = [...document.querySelectorAll('.toolbar .tool')]
                        .filter(b => { const r = b.getBoundingClientRect();
                          if (!r.width) return false;
                          const e = document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2);
                          return e && !b.contains(e); })
                        .map(b => b.id);
                      return { studio, vh: innerHeight, vw: innerWidth,
                               overOwner: window.__overlap(studio, window.__rect(owner)),
                               covered };
                    }"""
                )
                self.assertEqual(m["covered"], [], "toolbar buttons hidden under the studio")
                self.assertEqual(m["overOwner"], 0, "the studio covers the panel it came from")
                self.assertLessEqual(m["studio"]["b"], m["vh"])
                self.assertLessEqual(m["studio"]["r"], m["vw"])

    # ---------- inside every panel ----------

    def test_every_control_in_every_panel_is_a_real_touch_target(self):
        """DESIGN.md's floor is 44px via --tap. Checkboxes are skipped: in these
        panels each one sits inside a label chip, and the chip is the target."""
        page = self.open_page(TABLET)
        for tool in TOOLS:
            with self.subTest(tool=tool):
                self.pick(page, tool)
                small = page.evaluate(
                    """tool => [...document.getElementById(tool + 'Options')
                        .querySelectorAll('button, select, input:not([type=checkbox]):not([type=range]):not([type=hidden])')]
                      .filter(el => el.checkVisibility())
                      .map(el => ({ el, r: el.getBoundingClientRect() }))
                      .filter(({ r }) => r.width > 0 && (r.width < 44 || r.height < 44))
                      .map(({ el, r }) => `${el.className || el.id} ${Math.round(r.width)}x${Math.round(r.height)}`)""",
                    tool,
                )
                self.assertEqual(small, [], f"under 44px in the {tool} panel")

    def test_a_lone_toggle_takes_the_whole_row(self):
        page = self.open_page(TABLET)
        self.pick(page, "angle")
        m = page.evaluate(
            """() => {
              const label = document.querySelector('#angleOptions .geometry-toggle-grid > label');
              const grid = label.parentElement;
              return { label: label.getBoundingClientRect().width,
                       grid: grid.getBoundingClientRect().width };
            }"""
        )
        self.assertGreater(m["label"], m["grid"] * 0.9, "'Show the angle' is squeezed into half a row")


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
