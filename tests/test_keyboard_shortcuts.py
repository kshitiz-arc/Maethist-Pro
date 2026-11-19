"""The keyboard command layer.

Every tool change used to be a round trip out to a 44px target in the rail and
back. These tests care about three things: that a key reaches the tool it
advertises, that the layer steps aside whenever the keystroke is meant for
something else, and that what the help card shows is what the handler actually
dispatches on.
"""

import sys
import threading
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from app import app
from browser_server import make_browser_server

try:
    from playwright.sync_api import sync_playwright

    BROWSER_AVAILABLE = True
except ImportError:  # pragma: no cover - optional dependency
    BROWSER_AVAILABLE = False


# The binding is the contract; the label is what the rail and the help card
# promise for it.
TOOL_KEYS = [
    ("v", "select"),
    ("p", "pen"),
    ("e", "eraser"),
    ("h", "highlight"),
    ("s", "shape"),
    ("l", "line"),
    ("c", "compass"),
    ("a", "angle"),
    ("t", "manipulative"),
]


class EditorFixture:
    """Server + browser plumbing shared by both suites.

    Deliberately not a TestCase: pytest collects every TestCase subclass it
    finds, so inheriting the fixture from another test class would re-run that
    class's tests inside this one.
    """

    @classmethod
    def setUpClass(cls):
        app.config["TESTING"] = True
        cls.server = make_browser_server(app)
        cls.port = cls.server.server_port
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.thread.join(timeout=5)

    def setUp(self):
        self.page_errors = []

    def start(self, playwright):
        browser = playwright.chromium.launch()
        context = browser.new_context(bypass_csp=True)
        page = context.new_page()
        page.on("pageerror", lambda error: self.page_errors.append(str(error)))
        return browser, context, page

    def open_editor(self, page):
        url = "http://127.0.0.1:%d/write" % self.port
        page.goto(url)
        # The first-run tour swallows every key and every click until dismissed.
        page.evaluate(
            "localStorage.setItem('inkyscib-consent-v1', JSON.stringify({version: 1, analytics: false})); localStorage.setItem('inkyscib-feature-tour-v1', JSON.stringify({seen: true}))"
        )
        page.goto(url)
        page.wait_for_function(
            "window.Inkyscib?.Shortcuts !== undefined", timeout=30000
        )
        page.wait_for_function("window.appState?.storageReady === true", timeout=30000)

    def current_tool(self, page):
        return page.evaluate("window.appState.currentTool")


@unittest.skipUnless(BROWSER_AVAILABLE, "playwright is not installed")
class KeyboardShortcutTest(EditorFixture, unittest.TestCase):
    def test_each_letter_reaches_its_tool(self):
        with sync_playwright() as playwright:
            browser, context, page = self.start(playwright)
            try:
                self.open_editor(page)
                for key, tool in TOOL_KEYS:
                    page.evaluate("window.setTool('pen')")
                    page.keyboard.press(key)
                    self.assertEqual(
                        self.current_tool(page),
                        tool,
                        "pressing %r should select %s" % (key, tool),
                    )

                # Shift is not a modifier that means anything here, so a
                # capital letter is the same command as a lowercase one.
                page.evaluate("window.setTool('pen')")
                page.keyboard.press("Shift+E")
                self.assertEqual(self.current_tool(page), "eraser")
            finally:
                context.close()
                browser.close()
        self.assertEqual(self.page_errors, [])

    def test_bracket_keys_resize_through_the_tools_own_slider(self):
        """The slider is the one place size is written.

        Going through it rather than straight to appState is what keeps the
        number field, the on-canvas size preview and the saved preference in
        step, so the test asserts on the slider and the field, not just state.
        """
        with sync_playwright() as playwright:
            browser, context, page = self.start(playwright)
            try:
                self.open_editor(page)
                page.evaluate("window.setTool('pen')")
                page.evaluate(
                    "document.getElementById('penSize').value = 4;"
                    "document.getElementById('penSize')"
                    ".dispatchEvent(new Event('input', {bubbles: true}))"
                )

                page.keyboard.press("]")
                bigger = page.evaluate("window.appState.toolSettings.pen.size")
                self.assertGreater(bigger, 4)

                page.keyboard.press("[")
                page.keyboard.press("[")
                smaller = page.evaluate("window.appState.toolSettings.pen.size")
                self.assertLess(smaller, bigger)

                self.assertEqual(
                    page.evaluate("Number(document.getElementById('penSize').value)"),
                    smaller,
                )
                self.assertEqual(
                    page.evaluate(
                        "Number(document.getElementById('penSizeInput').value)"
                    ),
                    smaller,
                )

                # The slider's own floor holds: the key cannot drive the size
                # below what dragging could reach.
                floor = page.evaluate("Number(document.getElementById('penSize').min)")
                for _ in range(60):
                    page.keyboard.press("[")
                self.assertEqual(
                    page.evaluate("window.appState.toolSettings.pen.size"), floor
                )
            finally:
                context.close()
                browser.close()
        self.assertEqual(self.page_errors, [])

    def test_zero_returns_a_lost_view_to_the_origin(self):
        with sync_playwright() as playwright:
            browser, context, page = self.start(playwright)
            try:
                self.open_editor(page)
                page.evaluate(
                    "window.appState.transform = "
                    "{scale: 2.75, offsetX: 640, offsetY: -410}"
                )
                page.keyboard.press("0")
                transform = page.evaluate("({...window.appState.transform})")
                self.assertEqual(transform["scale"], 1)
                self.assertEqual(transform["offsetX"], 0)
                self.assertEqual(transform["offsetY"], 0)
            finally:
                context.close()
                browser.close()
        self.assertEqual(self.page_errors, [])

    def test_the_layer_stands_down_when_the_key_belongs_to_something_else(self):
        with sync_playwright() as playwright:
            browser, context, page = self.start(playwright)
            try:
                self.open_editor(page)

                # A modifier means the keystroke is a browser or ribbon command.
                page.evaluate("window.setTool('pen')")
                page.keyboard.press("Control+e")
                self.assertEqual(self.current_tool(page), "pen")

                # Typing in a field is text, not a command. (The panel opens
                # when the pen is picked up; since 2.7.1 it is closed on load.)
                page.evaluate("window.setTool('select'); window.setTool('pen')")
                page.evaluate("document.getElementById('penSizeInput').focus()")
                page.keyboard.press("e")
                self.assertEqual(self.current_tool(page), "pen")
                page.evaluate("document.getElementById('penSizeInput').blur()")

                # A full-screen overlay owns the keyboard while it is up.
                for overlay in ("planner-open", "library-open", "menu-open"):
                    page.evaluate("window.setTool('pen')")
                    page.evaluate("document.body.classList.add(%r)" % overlay)
                    page.keyboard.press("e")
                    page.evaluate("document.body.classList.remove(%r)" % overlay)
                    self.assertEqual(
                        self.current_tool(page),
                        "pen",
                        "%s should hold the keyboard" % overlay,
                    )

                # And it comes back afterwards.
                page.keyboard.press("e")
                self.assertEqual(self.current_tool(page), "eraser")
            finally:
                context.close()
                browser.close()
        self.assertEqual(self.page_errors, [])

    def test_shortcuts_survive_a_non_latin_keyboard_layout(self):
        """Dispatch is on the physical key, not the character it produces.

        On a Cyrillic layout the physical V key reports a letter that is not in
        the keymap. Matching on `e.key` meant every shortcut silently did
        nothing, with no error and no way for the user to find out why.
        """
        with sync_playwright() as playwright:
            browser, context, page = self.start(playwright)
            try:
                self.open_editor(page)
                press = (
                    "([key, code]) => document.dispatchEvent("
                    "new KeyboardEvent('keydown', "
                    "{key, code, bubbles: true, cancelable: true}))"
                )

                for key, code, expected in [
                    ("м", "KeyV", "select"),    # Cyrillic on physical V
                    ("у", "KeyE", "eraser"),    # Cyrillic on physical E
                    ("π", "KeyP", "pen"),       # Greek on physical P
                    ("h", "KeyH", "highlight"),       # Latin still works
                ]:
                    page.evaluate("window.setTool('manipulative')")
                    page.evaluate(press, [key, code])
                    self.assertEqual(
                        self.current_tool(page),
                        expected,
                        "physical %s should select %s whatever it prints"
                        % (code, expected),
                    )

                # A keyboard that reports no code at all still works off the key.
                page.evaluate("window.setTool('manipulative')")
                page.evaluate(press, ["s", ""])
                self.assertEqual(self.current_tool(page), "shape")
            finally:
                context.close()
                browser.close()
        self.assertEqual(self.page_errors, [])

    def test_the_rail_and_the_help_card_advertise_what_is_bound(self):
        """One map drives the handler, the tooltips and the help card.

        A shortcut that is documented but unbound is worse than none at all, so
        the labels are generated rather than written down twice.
        """
        with sync_playwright() as playwright:
            browser, context, page = self.start(playwright)
            try:
                self.open_editor(page)

                for key, tool in TOOL_KEYS:
                    button = page.locator("#%sTool" % tool)
                    self.assertEqual(
                        button.get_attribute("aria-keyshortcuts"),
                        key.upper(),
                        "%s should advertise %s" % (tool, key.upper()),
                    )
                    self.assertTrue(
                        (button.get_attribute("title") or "").endswith(
                            "(%s)" % key.upper()
                        ),
                        "%s tooltip should name its key" % tool,
                    )

                listed = page.evaluate(
                    "[...document.querySelectorAll('.tool-dock-shortcuts dt')]"
                    ".map(dt => dt.textContent)"
                )
                for key, _tool in TOOL_KEYS:
                    self.assertIn(key.upper(), listed)
            finally:
                context.close()
                browser.close()
        self.assertEqual(self.page_errors, [])


if __name__ == "__main__":
    unittest.main()


# Gestures share this file because they share a purpose: reaching a command
# without leaving the place you are working. Keyboard is the laptop half,
# touch is the tablet half.
TAP_JS = """
([fingers, holdMs, driftPx]) => {
  const canvas = document.getElementById('drawingCanvas');
  const rect = canvas.getBoundingClientRect();
  const send = (type, id, x, y) => canvas.dispatchEvent(new PointerEvent(type, {
    pointerId: id, pointerType: 'touch',
    clientX: rect.left + x, clientY: rect.top + y,
    bubbles: true, cancelable: true,
  }));
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  return (async () => {
    for (let i = 0; i < fingers; i++) send('pointerdown', i + 1, 200 + i * 60, 200);
    if (driftPx) {
      for (let i = 0; i < fingers; i++) send('pointermove', i + 1, 200 + i * 60 + driftPx, 200);
    }
    await sleep(holdMs);
    for (let i = 0; i < fingers; i++) send('pointerup', i + 1, 200 + i * 60 + (driftPx || 0), 200);
    await sleep(150);
    return window.appState.paths.length;
  })();
}
"""

# A palm landing mid-stroke also makes the pointer count two. Firing undo on
# that would destroy the stroke being written, so the gesture must not arm.
PALM_JS = """
() => {
  const canvas = document.getElementById('drawingCanvas');
  const rect = canvas.getBoundingClientRect();
  const send = (type, id, x, y) => canvas.dispatchEvent(new PointerEvent(type, {
    pointerId: id, pointerType: 'touch',
    clientX: rect.left + x, clientY: rect.top + y,
    bubbles: true, cancelable: true,
  }));
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  return (async () => {
    send('pointerdown', 1, 200, 200);
    await sleep(400);            // a stroke is already under way
    send('pointerdown', 2, 260, 200);   // palm arrives late
    await sleep(50);
    send('pointerup', 1, 200, 200);
    send('pointerup', 2, 260, 200);
    await sleep(150);
    return window.appState.paths.length;
  })();
}
"""


@unittest.skipUnless(BROWSER_AVAILABLE, "playwright is not installed")
class TouchGestureTest(EditorFixture, unittest.TestCase):
    """Two fingers to undo, three to redo, the way GoodNotes and Procreate do it."""

    def seed(self, page, count=3):
        page.evaluate(
            """(count) => {
                const s = window.appState;
                s.paths = [];
                s.undoStack.length = 0;
                s.redoStack.length = 0;
                for (let k = 0; k < count; k++) {
                    window.commitHistory();
                    s.paths.push({tool:'pen', color:'#fff', size:3,
                        points:[{x:10+k*20,y:10},{x:40+k*20,y:40}]});
                }
                window.render();
                return s.paths.length;
            }""",
            count,
        )

    def test_two_finger_tap_undoes_and_three_finger_tap_redoes(self):
        with sync_playwright() as playwright:
            browser, context, page = self.start(playwright)
            try:
                self.open_editor(page)

                self.seed(page)
                after_undo = page.evaluate(TAP_JS, [2, 60, 0])
                self.assertEqual(after_undo, 2, "two-finger tap should undo")

                after_redo = page.evaluate(TAP_JS, [3, 60, 0])
                self.assertEqual(after_redo, 3, "three-finger tap should redo")

                # Back to back, which is how anyone correcting a mistake uses it.
                again = page.evaluate(TAP_JS, [2, 60, 0])
                self.assertEqual(again, 2, "a second undo right after should work")
            finally:
                context.close()
                browser.close()
        self.assertEqual(self.page_errors, [])

    def test_a_gesture_that_moves_or_lingers_is_not_a_tap(self):
        with sync_playwright() as playwright:
            browser, context, page = self.start(playwright)
            try:
                self.open_editor(page)

                # Dragging two fingers is a pan. It must not undo.
                self.seed(page)
                self.assertEqual(
                    page.evaluate(TAP_JS, [2, 60, 40]), 3,
                    "a two-finger drag is a pan, not an undo",
                )

                # Resting two fingers is a hold. It must not undo.
                self.seed(page)
                self.assertEqual(
                    page.evaluate(TAP_JS, [2, 600, 0]), 3,
                    "a long two-finger hold is not a tap",
                )
            finally:
                context.close()
                browser.close()
        self.assertEqual(self.page_errors, [])

    def test_a_palm_landing_mid_stroke_never_undoes(self):
        with sync_playwright() as playwright:
            browser, context, page = self.start(playwright)
            try:
                self.open_editor(page)
                self.seed(page)
                self.assertEqual(
                    page.evaluate(PALM_JS), 3,
                    "a late second contact is a palm, and must not undo the stroke",
                )
            finally:
                context.close()
                browser.close()
        self.assertEqual(self.page_errors, [])


@unittest.skipUnless(BROWSER_AVAILABLE, "playwright is not installed")
class HelpReachabilityTest(EditorFixture, unittest.TestCase):
    """The help has to exist on the device the product is written for.

    Above 1180px it fills the tool dock. Below that the dock is display:none,
    and the "?" button in the rail used to still be visible and do nothing at
    all, which is the worst of both: a control that looks live and is not.
    """

    def open_at(self, page, width, height=800):
        page.set_viewport_size({"width": width, "height": height})
        self.open_editor(page)

    def test_help_opens_as_a_sheet_below_the_dock_breakpoint(self):
        with sync_playwright() as playwright:
            browser, context, page = self.start(playwright)
            try:
                self.open_at(page, 900)
                self.assertFalse(
                    page.evaluate("window.Inkyscib.ToolDock.isDockMode()"),
                    "900px should be below the dock breakpoint",
                )

                page.click("#toolDockHelp")
                page.wait_for_selector("#toolHelpSheet.is-open", timeout=5000)

                # It must clear the File ribbon, which sits at z-index 9996.
                self.assertGreater(
                    int(page.evaluate(
                        "getComputedStyle(document.getElementById('toolHelpSheet')).zIndex"
                    )),
                    9996,
                )
                # And it must have a real surface: the --chrome-* palette is
                # scoped to body.chrome-rail, which does not exist at this width.
                self.assertNotIn(
                    page.evaluate(
                        "getComputedStyle(document.querySelector"
                        "('.tool-help-sheet-panel')).backgroundColor"
                    ),
                    ("rgba(0, 0, 0, 0)", "transparent"),
                )

                rows = page.evaluate(
                    "document.querySelectorAll('#toolHelpSheet .is-gestures dt').length"
                )
                self.assertEqual(rows, 4, "all four gestures should be listed")

                # Letters must not reach the canvas while the sheet owns the screen.
                page.evaluate("window.setTool('pen')")
                page.keyboard.press("e")
                self.assertEqual(page.evaluate("window.appState.currentTool"), "pen")

                page.keyboard.press("Escape")
                # A closed sheet is display:none, so wait on the state rather
                # than on visibility.
                page.wait_for_function(
                    "!document.querySelector('#toolHelpSheet.is-open')", timeout=5000
                )
                self.assertFalse(
                    page.evaluate(
                        "document.body.classList.contains('help-sheet-open')"
                    )
                )
            finally:
                context.close()
                browser.close()
        self.assertEqual(self.page_errors, [])

    def test_help_fills_the_dock_above_the_breakpoint(self):
        with sync_playwright() as playwright:
            browser, context, page = self.start(playwright)
            try:
                self.open_at(page, 1400)
                self.assertTrue(page.evaluate("window.Inkyscib.ToolDock.isDockMode()"))
                page.click("#toolDockHelp")
                page.wait_for_timeout(250)
                self.assertTrue(page.evaluate("window.Inkyscib.ToolDock.isHelpOpen()"))
                # The sheet is the narrow-screen path and must stay shut here.
                self.assertFalse(
                    page.evaluate(
                        "!!document.querySelector('#toolHelpSheet.is-open')"
                    ),
                    "the dock and the sheet must never both show the same list",
                )
            finally:
                context.close()
                browser.close()
        self.assertEqual(self.page_errors, [])
