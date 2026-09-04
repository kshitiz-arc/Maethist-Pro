"""The editable unit name.

Every tool that measures something used to print "u" after the number. That
label is now a text field: type "cm" and every measurement in the app says cm.
It is a name, not a conversion — the numbers do not move and nothing already
drawn is rescaled — so what these tests care about is that the name reaches
every surface, and that it stays put.
"""

import sys
import threading
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from app import app

try:
    from playwright.sync_api import sync_playwright
    from werkzeug.serving import make_server

    BROWSER_AVAILABLE = True
except ImportError:  # pragma: no cover - optional dependency
    BROWSER_AVAILABLE = False


@unittest.skipUnless(BROWSER_AVAILABLE, "playwright is not installed")
class UnitNameTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        app.config["TESTING"] = True
        cls.server = make_server("127.0.0.1", 0, app, threaded=True)
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
        page.evaluate(
            "localStorage.setItem('inkyscib-feature-tour-v1', JSON.stringify({seen: true}))"
        )
        page.goto(url)
        page.wait_for_function("window.Inkyscib?.Units !== undefined", timeout=30000)
        page.wait_for_function("window.appState?.storageReady === true", timeout=30000)

    def visible_chip(self, page, tool="line"):
        """A chip the user can actually reach.

        Each chip lives inside its own tool's options panel, which is hidden
        until that tool is selected — that is what "in every tool" means here.
        """
        page.evaluate("window.setTool(%r)" % tool)
        page.wait_for_timeout(250)
        chip = page.locator("input[data-unit-name]:visible").first
        chip.wait_for(state="visible", timeout=10000)
        return chip

    def raise_for_page_errors(self):
        if self.page_errors:
            raise AssertionError("page errors: %s" % self.page_errors[:3])

    # ---------- the name itself ----------

    def test_the_default_name_is_unchanged(self):
        """Nobody who never opens this should notice it exists."""
        with sync_playwright() as playwright:
            browser, context, page = self.start(playwright)
            try:
                self.open_editor(page)
                name = page.evaluate("window.Inkyscib.Units.get()")
                chips = page.eval_on_selector_all(
                    "input[data-unit-name]", "els => els.map(e => e.value)"
                )
            finally:
                context.close()
                browser.close()

        self.raise_for_page_errors()
        self.assertEqual(name, "u")
        self.assertGreaterEqual(len(chips), 5, "every measuring tool needs a chip")
        self.assertEqual(set(chips), {"u"})

    def test_typing_a_name_reaches_every_tool(self):
        """One shared name — that is the whole point of it being shared."""
        with sync_playwright() as playwright:
            browser, context, page = self.start(playwright)
            try:
                self.open_editor(page)
                # Type into one chip the way a person would.
                chip = self.visible_chip(page)
                chip.click()
                chip.fill("cm")
                chip.blur()
                page.wait_for_timeout(200)

                chips = page.eval_on_selector_all(
                    "input[data-unit-name]", "els => els.map(e => e.value)"
                )
                labels = page.evaluate(
                    "({ plain: window.Inkyscib.Units.label(),"
                    "   squared: window.Inkyscib.Units.label({ squared: true }),"
                    "   formatted: window.Inkyscib.Units.format(3) })"
                )
            finally:
                context.close()
                browser.close()

        self.raise_for_page_errors()
        self.assertEqual(set(chips), {"cm"}, "every chip should follow the shared name")
        self.assertEqual(labels["plain"], "cm")
        self.assertEqual(labels["squared"], "cm²")
        self.assertEqual(labels["formatted"], "3.00 cm")

    def test_the_name_survives_a_reload(self):
        """'if i put cm it stays as cm' — including after closing the tab."""
        with sync_playwright() as playwright:
            browser, context, page = self.start(playwright)
            try:
                self.open_editor(page)
                page.evaluate("window.Inkyscib.Units.set('cm')")
                page.wait_for_timeout(300)

                self.open_editor(page)
                name = page.evaluate("window.Inkyscib.Units.get()")
                chips = page.eval_on_selector_all(
                    "input[data-unit-name]", "els => els.map(e => e.value)"
                )
            finally:
                context.close()
                browser.close()

        self.raise_for_page_errors()
        self.assertEqual(name, "cm")
        self.assertEqual(set(chips), {"cm"})

    def test_a_name_is_trimmed_rather_than_trusted(self):
        """The name goes into canvas text and into the DOM."""
        with sync_playwright() as playwright:
            browser, context, page = self.start(playwright)
            try:
                self.open_editor(page)
                results = page.evaluate(
                    """() => {
                      const U = window.Inkyscib.Units;
                      return {
                        markup: U.sanitize('<b>x</b>'),
                        empty: U.sanitize('   '),
                        long: U.sanitize('centimetres'),
                        notAString: U.sanitize(null),
                        keepsLetters: U.sanitize('int')
                      };
                    }"""
                )
            finally:
                context.close()
                browser.close()

        self.raise_for_page_errors()
        self.assertNotIn("<", results["markup"])
        self.assertEqual(results["empty"], "u", "an empty name falls back rather than vanishing")
        self.assertEqual(len(results["long"]), 6)
        self.assertEqual(results["notAString"], "u")
        # An earlier version of the sanitiser stripped r, n and t as escapes.
        self.assertEqual(results["keepsLetters"], "int")

    # ---------- the surfaces ----------

    def test_the_line_length_label_uses_the_name(self):
        with sync_playwright() as playwright:
            browser, context, page = self.start(playwright)
            try:
                self.open_editor(page)
                before = page.evaluate("window.formatLineLength(64)")
                page.evaluate("window.Inkyscib.Units.set('cm')")
                after = page.evaluate("window.formatLineLength(64)")
            finally:
                context.close()
                browser.close()

        self.raise_for_page_errors()
        self.assertEqual(before, "2.00 u")
        self.assertEqual(after, "2.00 cm", "the number must not move, only the name")

    def test_renaming_does_not_move_any_number(self):
        """A rename is a label change. Geometry must come out identical."""
        with sync_playwright() as playwright:
            browser, context, page = self.start(playwright)
            try:
                self.open_editor(page)
                measure = """() => {
                  const path = window.Inkyscib.SmartGeometry.createCirclePath(
                    { x: 400, y: 300 }, 96
                  );
                  return window.Inkyscib.SmartGeometry.measurementStrings
                    ? window.Inkyscib.SmartGeometry.measurementStrings(path)
                    : { radius: String(window.Inkyscib.SmartGeometry.circleRadius(path)) };
                }"""
                before = page.evaluate(measure)
                page.evaluate("window.Inkyscib.Units.set('cm')")
                after = page.evaluate(measure)
            finally:
                context.close()
                browser.close()

        self.raise_for_page_errors()
        for key, value in before.items():
            digits_before = "".join(c for c in str(value) if c.isdigit() or c == ".")
            digits_after = "".join(c for c in str(after[key]) if c.isdigit() or c == ".")
            self.assertEqual(digits_before, digits_after, "%s changed value, not just name" % key)

    def test_typing_in_the_chip_does_not_switch_tools(self):
        """The canvas has single-key tool shortcuts; 'cm' must not trigger them."""
        with sync_playwright() as playwright:
            browser, context, page = self.start(playwright)
            try:
                self.open_editor(page)
                # Editing the chip happens while its own tool is selected,
                # which is the only time the panel is on screen.
                chip = self.visible_chip(page, "line")
                chip.click()
                for character in "cmx":
                    chip.press(character)
                page.wait_for_timeout(200)

                tool = page.evaluate("window.appState.currentTool")
                name = page.evaluate("window.Inkyscib.Units.get()")
            finally:
                context.close()
                browser.close()

        self.raise_for_page_errors()
        self.assertEqual(tool, "line", "typing a unit name must not change tool")
        self.assertEqual(name, "cmx")


if __name__ == "__main__":
    unittest.main()
