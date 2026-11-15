"""Arc workflow and the shared colour system.

Covers the six items from the arc-and-colour plan, and in particular the three
places where the plan's premise turned out to be different from the code:

  * Hex is not added per tool — color-field.js upgrades every colour input, and
    the compass now goes through it instead of its own duplicate control.
  * The "?" is a help button, not a drawing tool, so it has no colour at all.
  * A label toggle was never broken; labels belong to the object drawn. The
    master switch is what hides them all at once.
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


@unittest.skipUnless(BROWSER_AVAILABLE, "playwright is not installed")
class ArcColourTestBase(unittest.TestCase):
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
        page.evaluate(
            "localStorage.setItem('inkyscib-consent-v1', JSON.stringify({version: 1, analytics: false})); localStorage.setItem('inkyscib-feature-tour-v1', JSON.stringify({seen: true}))"
        )
        page.goto(url)
        page.wait_for_function("window.appState?.storageReady === true", timeout=30000)

    def use_tool(self, page, tool):
        page.evaluate("window.setTool(%r)" % tool)
        page.wait_for_timeout(300)

    def raise_for_page_errors(self):
        if self.page_errors:
            raise AssertionError("page errors: %s" % self.page_errors[:3])


class ColourConsistencyTest(ArcColourTestBase):
    """Item 4 and 6: one colour interface, everywhere it makes sense."""

    def test_every_colour_input_gets_a_hex_field(self):
        with sync_playwright() as playwright:
            browser, context, page = self.start(playwright)
            try:
                self.open_editor(page)
                counts = page.evaluate(
                    """() => ({
                      pickers: document.querySelectorAll('input[type=color]').length,
                      hexFields: document.querySelectorAll('.hex-field').length,
                      optedOut: document.querySelectorAll('input[type=color][data-no-hex]').length
                    })"""
                )
            finally:
                context.close()
                browser.close()

        self.raise_for_page_errors()
        self.assertGreaterEqual(counts["pickers"], 9)
        self.assertEqual(
            counts["optedOut"], 0, "no tool should be running its own colour control any more"
        )
        self.assertEqual(
            counts["hexFields"], counts["pickers"], "every picker needs the shared hex field"
        )

    def test_the_compass_no_longer_has_its_own_hex_control(self):
        """The duplicate was the actual inconsistency in item 6."""
        with sync_playwright() as playwright:
            browser, context, page = self.start(playwright)
            try:
                self.open_editor(page)
                leftovers = page.evaluate(
                    "document.querySelectorAll('#compassHexInput, .compass-hex-input').length"
                )
            finally:
                context.close()
                browser.close()

        self.raise_for_page_errors()
        self.assertEqual(leftovers, 0)

    def test_typing_a_hex_code_drives_the_compass_colour(self):
        with sync_playwright() as playwright:
            browser, context, page = self.start(playwright)
            try:
                self.open_editor(page)
                self.use_tool(page, "compass")
                field = page.locator("#compassCustomColor + .hex-field .hex-field-input")
                field.fill("ff00aa")
                page.wait_for_timeout(200)
                colour = page.evaluate("window.Inkyscib.Compass.compassState.color")
            finally:
                context.close()
                browser.close()

        self.raise_for_page_errors()
        self.assertEqual(colour, "#ff00aa")

    def test_clearing_the_hex_field_returns_the_compass_to_no_colour(self):
        """The compass has a real 'no custom colour' state the shared field
        would otherwise have swallowed."""
        with sync_playwright() as playwright:
            browser, context, page = self.start(playwright)
            try:
                self.open_editor(page)
                self.use_tool(page, "compass")
                field = page.locator("#compassCustomColor + .hex-field .hex-field-input")
                field.fill("ff00aa")
                page.wait_for_timeout(150)
                field.fill("")
                page.wait_for_timeout(200)
                colour = page.evaluate("window.Inkyscib.Compass.compassState.color")
            finally:
                context.close()
                browser.close()

        self.raise_for_page_errors()
        self.assertIsNone(colour)

    def test_the_help_button_is_not_a_drawing_tool(self):
        """Item 4 asked for colour on the '?'. It draws nothing."""
        with sync_playwright() as playwright:
            browser, context, page = self.start(playwright)
            try:
                self.open_editor(page)
                help_button = page.evaluate(
                    """() => {
                      const el = document.getElementById('toolDockHelp');
                      return {
                        exists: !!el,
                        looksLikeATool: el ? el.classList.contains('tool') : null,
                        hasColour: el ? !!el.querySelector('input[type=color]') : null
                      };
                    }"""
                )
            finally:
                context.close()
                browser.close()

        self.raise_for_page_errors()
        self.assertTrue(help_button["exists"])
        self.assertFalse(help_button["looksLikeATool"], "it should not read as a tool")
        self.assertFalse(help_button["hasColour"])


class ColourStudioTest(ArcColourTestBase):
    """Item 5: the dedicated picker."""

    def test_a_trigger_appears_on_every_hex_field(self):
        with sync_playwright() as playwright:
            browser, context, page = self.start(playwright)
            try:
                self.open_editor(page)
                counts = page.evaluate(
                    """() => ({
                      fields: document.querySelectorAll('.hex-field').length,
                      triggers: document.querySelectorAll('.studio-trigger').length
                    })"""
                )
            finally:
                context.close()
                browser.close()

        self.raise_for_page_errors()
        self.assertGreater(counts["fields"], 0)
        self.assertEqual(counts["triggers"], counts["fields"], "one picker per colour, no gaps")

    def test_opening_the_studio_and_taking_a_sample_colour(self):
        with sync_playwright() as playwright:
            browser, context, page = self.start(playwright)
            try:
                self.open_editor(page)
                self.use_tool(page, "pen")

                trigger = page.locator("#penCustomColor + .hex-field .studio-trigger")
                trigger.click()
                page.wait_for_selector(".color-studio:not([hidden])", timeout=5000)

                page.click('.studio-samples [data-studio-color="#e0407a"]')
                page.wait_for_timeout(200)

                result = page.evaluate(
                    """() => ({
                      picker: document.getElementById('penCustomColor').value,
                      hex: document.querySelector('.studio-hex-input').value,
                      recent: window.Inkyscib.ColorStudio.getRecent()
                    })"""
                )
            finally:
                context.close()
                browser.close()

        self.raise_for_page_errors()
        self.assertEqual(result["picker"], "#e0407a")
        self.assertEqual(result["hex"], "e0407a")
        self.assertIn("#e0407a", result["recent"], "picking a colour should remember it")

    def test_the_studio_closes_when_you_change_tool(self):
        """It is anchored to one tool's colour input.

        Left open across a tool switch it would still be editing the panel that
        just went away, which is worse than not opening at all.
        """
        with sync_playwright() as playwright:
            browser, context, page = self.start(playwright)
            try:
                self.open_editor(page)
                self.use_tool(page, "pen")
                page.locator("#penCustomColor + .hex-field .studio-trigger").click()
                page.wait_for_selector(".color-studio:not([hidden])", timeout=5000)
                opened = page.evaluate("!document.querySelector('.color-studio').hidden")

                self.use_tool(page, "compass")
                still_open = page.evaluate("!document.querySelector('.color-studio').hidden")
            finally:
                context.close()
                browser.close()

        self.raise_for_page_errors()
        self.assertTrue(opened)
        self.assertFalse(still_open, "the picker must not outlive the panel it belongs to")

    def test_recent_colours_survive_a_reload_and_stay_deduplicated(self):
        with sync_playwright() as playwright:
            browser, context, page = self.start(playwright)
            try:
                self.open_editor(page)
                page.evaluate(
                    """() => {
                      const picker = document.getElementById('penCustomColor');
                      window.Inkyscib.ColorStudio.open(picker, picker);
                    }"""
                )
                for colour in ("#e0407a", "#5fbf6a", "#e0407a"):
                    page.click('.studio-samples [data-studio-color="%s"]' % colour)
                    page.wait_for_timeout(120)

                self.open_editor(page)
                recent = page.evaluate("window.Inkyscib.ColorStudio.getRecent()")
            finally:
                context.close()
                browser.close()

        self.raise_for_page_errors()
        self.assertEqual(recent[0], "#e0407a", "most recent first")
        self.assertEqual(len(recent), len(set(recent)), "no duplicates in the row")
        self.assertIn("#5fbf6a", recent)

    def test_the_colour_maths_round_trips(self):
        """The gradient sliders are only useful if hex survives the trip."""
        with sync_playwright() as playwright:
            browser, context, page = self.start(playwright)
            try:
                self.open_editor(page)
                results = page.evaluate(
                    """() => {
                      const S = window.Inkyscib.ColorStudio;
                      return ['#e0407a', '#5fbf6a', '#000000', '#ffffff', '#4bc6cf'].map(hex => {
                        const [h, s, l] = S.rgbToHsl(...S.hexToRgb(hex));
                        return [hex, S.hslToHex(h, s, l)];
                      });
                    }"""
                )
            finally:
                context.close()
                browser.close()

        self.raise_for_page_errors()
        for original, round_tripped in results:
            self.assertEqual(original, round_tripped, "%s did not survive HSL" % original)


class ArcWorkflowTest(ArcColourTestBase):
    """Items 1, 2 and 3."""

    def draw_an_arc(self, page):
        """Place a centre, a radius and sweep an arc through the module's own API."""
        return page.evaluate(
            """() => {
              const C = window.Inkyscib.Compass;
              C.activate();
              const construction = window.Inkyscib.Construction;
              const centre = construction.createPoint({ x: 400, y: 300 }, { origin: 'user' });
              C.compassState.centerPointId = centre.gid;
              C.compassState.center = { x: 400, y: 300 };
              C.compassState.radius = 120;
              C.compassState.lastArcGid = null;
              const arc = construction.createArc(
                { x: 400, y: 300 }, 120, 0, Math.PI / 2,
                { centerId: centre.gid, isConstruction: true, showAngle: true }
              );
              C.compassState.lastArcGid = arc?.gid || null;
              return { gid: arc?.gid || null, radius: arc?.radius || null };
            }"""
        )

    def test_the_new_arc_button_appears_once_an_arc_lands(self):
        """Item 3's real affordance.

        A tick on step 3 cannot work: finishing an arc returns the compass to
        READY, which is step 3 again, and a step that is current is never also
        marked done. The button is what says "that one landed, here is how to
        start another".
        """
        with sync_playwright() as playwright:
            browser, context, page = self.start(playwright)
            try:
                self.open_editor(page)
                self.use_tool(page, "compass")
                before = page.evaluate(
                    "document.getElementById('compassNewArc')?.hidden"
                )

                self.draw_an_arc(page)
                page.evaluate("window.Inkyscib.Compass.syncSettings?.()")
                # syncPanel runs on the real commit path; the fixture builds the
                # arc directly, so drive the same refresh through a state change.
                page.evaluate("window.Inkyscib.Compass.setMode('arc')")
                page.wait_for_timeout(250)
                after = page.evaluate(
                    "document.getElementById('compassNewArc')?.hidden"
                )
            finally:
                context.close()
                browser.close()

        self.raise_for_page_errors()
        self.assertTrue(before, "nothing drawn yet, so nothing to follow on from")
        self.assertFalse(after, "the + button should appear once an arc exists")

    def test_new_arc_returns_to_step_one(self):
        """New arc starts a fresh construction instead of continuing the old one."""
        with sync_playwright() as playwright:
            browser, context, page = self.start(playwright)
            try:
                self.open_editor(page)
                self.use_tool(page, "compass")
                self.draw_an_arc(page)
                after = page.evaluate(
                    """() => {
                      window.Inkyscib.Compass.startAnotherArc();
                      const s = window.Inkyscib.Compass.compassState;
                      return { radius: s.radius, centre: !!s.centerPointId, last: s.lastArcGid };
                    }"""
                )
            finally:
                context.close()
                browser.close()

        self.raise_for_page_errors()
        self.assertIsNone(after["radius"], "a new construction must not inherit the old radius")
        self.assertFalse(after["centre"], "a new construction must ask for a fresh centre")
        self.assertIsNone(after["last"], "the new arc has not been drawn yet")

    def test_tapping_an_arcs_body_picks_it_back_up(self):
        """The fix for item 1: a short arc's ends are unreachable, its curve is not."""
        with sync_playwright() as playwright:
            browser, context, page = self.start(playwright)
            try:
                self.open_editor(page)
                self.use_tool(page, "compass")
                arc = self.draw_an_arc(page)
                found = page.evaluate(
                    """(gid) => {
                      const C = window.Inkyscib.Compass;
                      // A point on the arc's curve, away from either endpoint.
                      const angle = Math.PI / 4;
                      const at = { x: 400 + Math.cos(angle) * 120, y: 300 + Math.sin(angle) * 120 };
                      const hit = C.arcBodyAt(at);
                      const offCurve = C.arcBodyAt({ x: 400, y: 300 });
                      return { hitGid: hit?.gid || null, wanted: gid, centreHits: !!offCurve };
                    }""",
                    arc["gid"],
                )
            finally:
                context.close()
                browser.close()

        self.raise_for_page_errors()
        self.assertEqual(found["hitGid"], found["wanted"], "the arc's curve should be tappable")
        self.assertFalse(found["centreHits"], "the centre is not on the curve")

    def test_short_arcs_keep_their_two_ends_distinguishable(self):
        """A fixed 12px grab made both ends of a short arc claim the same press."""
        with sync_playwright() as playwright:
            browser, context, page = self.start(playwright)
            try:
                self.open_editor(page)
                self.use_tool(page, "compass")
                result = page.evaluate(
                    """() => {
                      const C = window.Inkyscib.Compass;
                      const construction = window.Inkyscib.Construction;
                      C.activate();
                      const centre = construction.createPoint({ x: 400, y: 300 }, { origin: 'user' });
                      // A deliberately tiny sweep: both ends within a few pixels.
                      const arc = construction.createArc(
                        { x: 400, y: 300 }, 120, 0, 0.04,
                        { centerId: centre.gid, isConstruction: true }
                      );
                      const at = (a) => ({
                        x: 400 + Math.cos(a) * 120, y: 300 + Math.sin(a) * 120
                      });
                      return {
                        atStart: C.extendTargetAt(at(0))?.end || null,
                        atEnd: C.extendTargetAt(at(0.04))?.end || null,
                        gid: arc?.gid || null
                      };
                    }"""
                )
            finally:
                context.close()
                browser.close()

        self.raise_for_page_errors()
        self.assertEqual(result["atStart"], "start")
        self.assertEqual(result["atEnd"], "end", "the far end must not be claimed by the near one")


class MeasurementMasterSwitchTest(ArcColourTestBase):
    """Item 2, as the architecture decision resolved it."""

    def test_the_switch_hides_labels_without_erasing_their_settings(self):
        with sync_playwright() as playwright:
            browser, context, page = self.start(playwright)
            try:
                self.open_editor(page)
                self.use_tool(page, "compass")
                page.evaluate(
                    """() => {
                      const construction = window.Inkyscib.Construction;
                      window.Inkyscib.Compass.activate();
                      const centre = construction.createPoint({ x: 400, y: 300 }, { origin: 'user' });
                      construction.createArc({ x: 400, y: 300 }, 120, 0, Math.PI / 2,
                        { centerId: centre.gid, isConstruction: true, showAngle: true });
                    }"""
                )

                before = page.evaluate("window.Inkyscib.Measurements.visible()")
                page.evaluate("window.Inkyscib.Measurements.set(true)")
                page.wait_for_timeout(150)
                hidden = page.evaluate(
                    """() => ({
                      visible: window.Inkyscib.Measurements.visible(),
                      arcStillWantsIt: window.Inkyscib.Construction.rebuildIndex()
                        .arcs.some(a => a.showAngle === true),
                      bodyFlag: document.body.classList.contains('measurements-hidden')
                    })"""
                )
                page.evaluate("window.Inkyscib.Measurements.set(false)")
                page.wait_for_timeout(150)
                restored = page.evaluate("window.Inkyscib.Measurements.visible()")
            finally:
                context.close()
                browser.close()

        self.raise_for_page_errors()
        self.assertTrue(before)
        self.assertFalse(hidden["visible"])
        self.assertTrue(hidden["bodyFlag"])
        self.assertTrue(
            hidden["arcStillWantsIt"],
            "hiding must not overwrite what each arc remembers, or turning it back on loses them",
        )
        self.assertTrue(restored, "labels come back")

    def test_the_switch_survives_a_reload(self):
        with sync_playwright() as playwright:
            browser, context, page = self.start(playwright)
            try:
                self.open_editor(page)
                page.evaluate("window.Inkyscib.Measurements.set(true)")
                page.wait_for_timeout(200)
                self.open_editor(page)
                page.wait_for_timeout(200)
                state = page.evaluate(
                    """() => ({
                      hidden: window.Inkyscib.Measurements.isHidden(),
                      checkbox: document.getElementById('compassHideAll')?.checked
                    })"""
                )
            finally:
                context.close()
                browser.close()

        self.raise_for_page_errors()
        self.assertTrue(state["hidden"])
        self.assertTrue(state["checkbox"], "the panel checkbox should show the stored state")


if __name__ == "__main__":
    unittest.main()
