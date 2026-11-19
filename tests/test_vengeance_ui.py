"""The three effects ported from VengeanceUI: border beam, sliding link
underline, odometer digits.

What these pin is not "does it look nice" but the four promises made when the
port was accepted: it degrades to today's design, it stops under reduced
motion, it costs nothing at rest in the editor, and it does not disturb the
layout it decorates. Each one of those was broken at some point while writing
it, which is why each has a test.
"""

import io
import re
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

try:
    from PIL import Image, ImageChops

    PIL_AVAILABLE = True
except ImportError:  # pragma: no cover
    PIL_AVAILABLE = False

CSS = Path(app.root_path) / "static" / "css" / "vengeance.css"
JS = Path(app.root_path) / "static" / "js" / "odometer.js"

DISMISS = (
    "localStorage.setItem('inkyscib-feature-tour-v1','dismissed');"
    "localStorage.setItem('inkyscib-consent-v1',"
    " JSON.stringify({version:1,analytics:false}))"
)


class SourceTests(unittest.TestCase):
    """Cheap invariants that do not need a browser."""

    @classmethod
    def setUpClass(cls):
        cls.client = app.test_client()
        cls.css = CSS.read_text(encoding="utf-8")

    def test_the_stylesheet_reaches_every_page_including_the_404(self):
        for path in ("/", "/features", "/about", "/write", "/legal/privacy",
                     "/no-such-page"):
            with self.subTest(path=path):
                html = self.client.get(path).get_data(as_text=True)
                self.assertIn("css/vengeance.css", html)

    def test_the_odometer_script_stays_off_the_editor(self):
        """It has nothing to animate there, and /write already carries 52
        scripts."""
        self.assertNotIn("js/odometer.js",
                         self.client.get("/write").get_data(as_text=True))
        self.assertIn("js/odometer.js",
                      self.client.get("/about").get_data(as_text=True))

    def test_nothing_was_added_that_needs_a_new_csp_origin(self):
        """The whole point of porting by hand rather than installing: no CDN,
        no framework, no new origin in CONTENT_SECURITY_POLICY."""
        for source in (self.css, JS.read_text(encoding="utf-8")):
            with self.subTest():
                self.assertNotIn("http://", source)
                self.assertNotIn("https://cdn", source)
                self.assertNotIn("unpkg", source)

    def test_the_port_credits_its_source(self):
        """MIT: keep the attribution with the code that came from it."""
        for source in (self.css, JS.read_text(encoding="utf-8")):
            with self.subTest():
                self.assertIn("VengeanceUI", source)
                self.assertIn("MIT", source)

    def test_the_beam_never_positions_the_file_ribbon_itself(self):
        """`position: relative` on .file-ribbon loses to
        `.chrome-rail .toolbar.is-topbar .file-ribbon` above 1180px and beats
        `position: fixed` below it, which unpins the ribbon on the 960px
        tablet. The beam belongs on the state chip."""
        block = re.search(
            r"\.hero \.cta \.primary,\s*\.nb-cta \.primary,\s*\.page-cta \.primary,\s*"
            r"\.lost-copy \.return-button,\s*([^{]+)\{\s*position: relative",
            self.css,
        )
        self.assertIsNotNone(block, "the position:relative block moved")
        self.assertNotIn(".file-ribbon\n", block.group(1))
        self.assertIn(".file-ribbon-state", block.group(1))

    def test_every_effect_is_switched_off_under_reduced_motion(self):
        reduced = self.css.split("prefers-reduced-motion")[1]
        for stopped in ("beam-lap", "animation: none", "transition: none"):
            with self.subTest(stopped=stopped):
                self.assertIn(stopped, self.css)
        self.assertIn(".odometer-strip", reduced)


@unittest.skipUnless(PLAYWRIGHT_AVAILABLE, "Playwright is not installed")
class EffectTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = make_browser_server(app)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.base_url = f"http://127.0.0.1:{cls.server.server_port}"
        cls.playwright = sync_playwright().start()
        cls.browser = cls.playwright.chromium.launch(headless=True)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()
        cls.server.shutdown()

    def _context(self, motion="no-preference", width=1280):
        context = self.browser.new_context(
            reduced_motion=motion, viewport={"width": width, "height": 860}
        )
        context.add_init_script(DISMISS)
        return context

    def test_the_beam_runs_a_fixed_number_of_laps_and_then_stops(self):
        """Ambient motion is a permanent repaint on a budget tablet. Upstream
        loops forever; this one does not."""
        context = self._context()
        page = context.new_page()
        try:
            page.goto(f"{self.base_url}/", wait_until="load")
            beam = page.evaluate(
                "() => { const s = getComputedStyle("
                "document.querySelector('.nb-cta .primary'), '::after');"
                " return { name: s.animationName, iter: s.animationIterationCount }; }"
            )
        finally:
            context.close()

        self.assertEqual(beam["name"], "beam-lap")
        self.assertNotEqual(beam["iter"], "infinite")

    def test_reduced_motion_stops_all_three(self):
        context = self._context(motion="reduce")
        page = context.new_page()
        try:
            page.goto(f"{self.base_url}/", wait_until="load")
            beam = page.evaluate(
                "() => getComputedStyle(document.querySelector("
                "'.nb-cta .primary'), '::after').animationName"
            )
            underline = page.evaluate(
                "() => getComputedStyle(document.querySelector('.nav a'),"
                " '::after').transitionDuration"
            )
            page.goto(f"{self.base_url}/about", wait_until="load")
            page.wait_for_timeout(400)
            odometer = page.evaluate(
                "() => document.querySelector('.profile-stat b').textContent.trim()"
            )
        finally:
            context.close()

        self.assertEqual(beam, "none")
        self.assertEqual(underline, "0s")
        # Untouched markup: the number, exactly as the template wrote it.
        self.assertEqual(odometer, "600+")

    def test_the_odometer_lands_on_the_real_digits(self):
        """A strip that stops between two digits shows a number that is simply
        wrong. The shift must be an exact multiple of the cell height."""
        context = self._context()
        page = context.new_page()
        try:
            page.goto(f"{self.base_url}/about", wait_until="load")
            page.evaluate(
                "() => document.querySelector('.profile-stats').scrollIntoView()"
            )
            page.wait_for_timeout(2000)
            rows = page.evaluate("""() => Array.from(
              document.querySelectorAll('.profile-stat b')).map(b => ({
                value: b.querySelector('.odometer-value').textContent,
                digits: Array.from(b.querySelectorAll('.odometer-digit')).map(cell => {
                  const strip = cell.querySelector('.odometer-strip');
                  const shift = -new DOMMatrix(getComputedStyle(strip).transform).m42;
                  const height = cell.getBoundingClientRect().height;
                  return { shift, height, digit: Math.round(shift / height) };
                })
              }))""")
        finally:
            context.close()

        self.assertTrue(rows)
        for row in rows:
            with self.subTest(value=row["value"]):
                wanted = [int(ch) for ch in row["value"] if ch.isdigit()]
                self.assertEqual([d["digit"] for d in row["digits"]], wanted)
                for digit in row["digits"]:
                    # Exactly on a cell boundary, not between two digits.
                    self.assertAlmostEqual(
                        digit["shift"] / digit["height"], digit["digit"], places=2
                    )

    def test_the_number_stays_readable_to_a_screen_reader_and_copyable(self):
        context = self._context()
        page = context.new_page()
        try:
            page.goto(f"{self.base_url}/about", wait_until="load")
            page.wait_for_timeout(400)
            state = page.evaluate("""() => {
              const b = document.querySelector('.profile-stat b');
              // What an assistive technology is left with: the subtree minus
              // everything marked aria-hidden. innerText is the wrong measure
              // here -- the strips are rendered, they are just not exposed.
              const clone = b.cloneNode(true);
              clone.querySelectorAll('[aria-hidden="true"]')
                   .forEach(node => node.remove());
              const strip = b.querySelector('.odometer-strip span');
              return {
                exposed: clone.textContent.trim(),
                prohibited: !!b.querySelector('span[aria-label]:not([role])'),
                stripsHidden: Array.from(b.querySelectorAll('.odometer-digit'))
                  .every(cell => cell.getAttribute('aria-hidden') === 'true'),
                stripSelectable: getComputedStyle(strip).userSelect
              };
            }""")
        finally:
            context.close()

        # The accessibility tree sees the number and nothing else.
        self.assertEqual(state["exposed"], "600+")
        self.assertTrue(state["stripsHidden"])
        # aria-label on a bare span is a prohibited attribute; the real text
        # carries the meaning instead.
        self.assertFalse(state["prohibited"])
        # And a copy of the number does not drag 0-9 along with it.
        self.assertEqual(state["stripSelectable"], "none")

    @unittest.skipUnless(PIL_AVAILABLE, "Pillow is not installed")
    def test_the_editor_beam_costs_nothing_once_the_save_has_landed(self):
        """The one rule for anything added to /write: no steady-state work."""
        context = self._context(width=960)
        page = context.new_page()
        try:
            page.goto(f"{self.base_url}/write", wait_until="domcontentloaded")
            page.wait_for_selector(".file-ribbon-state", state="attached")
            page.wait_for_timeout(700)

            ribbon_position = page.evaluate(
                "() => getComputedStyle(document.querySelector('.file-ribbon')).position"
            )

            chip = page.locator(".file-ribbon-state")
            page.evaluate(
                "() => { document.querySelector('.file-ribbon').dataset.state = 'unsaved'; }"
            )
            page.wait_for_timeout(1400)
            before = Image.open(io.BytesIO(chip.screenshot())).convert("RGB")
            page.evaluate(
                "() => { document.querySelector('.file-ribbon').dataset.state = 'saved'; }"
            )
            page.wait_for_timeout(300)
            during = Image.open(io.BytesIO(chip.screenshot())).convert("RGB")

            page.wait_for_timeout(1400)     # comfortably past the 1.1s lap
            settled = Image.open(io.BytesIO(chip.screenshot())).convert("RGB")
            page.wait_for_timeout(400)
            later = Image.open(io.BytesIO(chip.screenshot())).convert("RGB")
        finally:
            context.close()

        moved = ImageChops.difference(before, during).getbbox()
        at_rest = ImageChops.difference(settled, later).getbbox()

        # The ribbon must still be pinned on the tablet this product targets.
        self.assertEqual(ribbon_position, "fixed")
        self.assertIsNotNone(moved, "the save beam never painted")
        self.assertIsNone(at_rest, "the editor beam is still animating at rest")


if __name__ == "__main__":
    unittest.main()
