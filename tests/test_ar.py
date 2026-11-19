"""AR MAETHIST (static/js/ar.js): drawing in the air over the camera.

No camera or model in a test browser, so the camera is a canvas stream and
MediaPipe's results are fed in by hand through Inkyscib.AR._results, the
same callback the real tracker calls.
"""

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

FAKE_CAMERA = """
navigator.mediaDevices.getUserMedia = async () => {
  const c = document.createElement('canvas'); c.width = 1280; c.height = 720;
  const g = c.getContext('2d'); g.fillStyle = '#334'; g.fillRect(0, 0, 1280, 720);
  return c.captureStream(15);
};
"""

FAKE_HANDS = (
    "window.Hands = class { setOptions() {} onResults(f) { this.f = f; } "
    "send() { return Promise.resolve(); } close() {} };"
)

# A hand with thumb tip (4) and index tip (8) apart or together, centred on
# (x, y) in the camera picture's own 0..1 space.
HAND = """(args) => {
  const [x, y, pinched] = args;
  const hand = Array.from({length: 21}, () => ({x, y: y + 0.1, z: 0}));
  hand[0] = {x, y: y + 0.25, z: 0};
  hand[9] = {x, y: y + 0.05, z: 0};
  const gap = pinched ? 0.02 : 0.15;
  hand[4] = {x: x - gap / 2, y, z: 0};
  hand[8] = {x: x + gap / 2, y, z: 0};
  window.Inkyscib.AR._results({multiHandLandmarks: [hand]});
}"""


class ArSourceTests(unittest.TestCase):
    def test_it_is_called_ar_maethist_everywhere_a_person_reads(self):
        for name in ("static/js/ar.js", "static/js/file-ribbon.js", "templates/write.html", "templates/features.html"):
            text = (ROOT / name).read_text(encoding="utf-8")
            with self.subTest(name=name):
                self.assertNotIn("AR Inky", text)
        self.assertIn('title: "AR MAETHIST"', (ROOT / "static/js/file-ribbon.js").read_text(encoding="utf-8"))

    def test_the_library_is_pinned(self):
        source = (ROOT / "static/js/ar.js").read_text(encoding="utf-8")
        self.assertRegex(source, r'HANDS_VERSION = "\d+\.\d+\.\d{6,}"')


@unittest.skipUnless(PLAYWRIGHT_AVAILABLE, "Playwright is not installed")
class ArBrowserTests(unittest.TestCase):
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

    def new_page(self):
        context = self.browser.new_context(viewport={"width": 1280, "height": 800})
        self.addCleanup(context.close)
        context.add_init_script("localStorage.setItem('inkyscib-feature-tour-v1', 'seen');" + FAKE_CAMERA)
        page = context.new_page()
        self.errors = []
        page.on("pageerror", lambda error: self.errors.append(str(error)))
        # The real library is never fetched in a test; a stand-in is.
        page.route("**/npm/@mediapipe/hands@*/hands.js", lambda route: route.fulfill(
            status=200, content_type="text/javascript", body=FAKE_HANDS))
        page.goto(self.base_url + "/write", wait_until="domcontentloaded")
        page.wait_for_function("() => window.appState?.storageReady === true && !!window.Inkyscib?.AR")
        return page

    def open_ar(self):
        page = self.new_page()
        page.evaluate("() => { window.appState.paths = []; window.setTool('pen'); return window.Inkyscib.AR.enterAR(); }")
        page.wait_for_function("() => document.querySelector('#arHud .ar-hud-text')?.textContent.includes('Show your hand')")
        return page

    def hand(self, page, x, y, pinched):
        page.evaluate(HAND, [x, y, pinched])

    def test_a_pinch_draws_and_opening_the_fingers_lifts_the_pen(self):
        page = self.open_ar()
        self.hand(page, 0.5, 0.5, False)
        self.assertIn("Pinch", page.inner_text("#arHud"))
        for i in range(8):
            self.hand(page, 0.5 - i * 0.02, 0.5, True)
        self.assertIn("Drawing", page.inner_text("#arHud"))
        self.hand(page, 0.34, 0.5, False)
        paths = page.evaluate("() => window.appState.paths.map((p) => ({tool: p.tool, n: p.points.length}))")
        self.assertEqual(len(paths), 1)
        self.assertEqual(paths[0]["tool"], "pen")
        self.assertGreater(paths[0]["n"], 4)
        # Moving with the fingers apart draws nothing.
        for i in range(5):
            self.hand(page, 0.4, 0.4 + i * 0.02, False)
        self.assertEqual(page.evaluate("() => window.appState.paths.length"), 1)
        self.assertEqual(self.errors, [])

    def test_the_dot_sits_on_the_finger_in_a_cropped_picture(self):
        """The picture is 16:9 shown with object-fit: cover on a 16:10 screen,
        so its sides are cropped away. The middle of the picture is the
        middle of the screen, and a point a quarter across lands a quarter of
        the shown (not the screen) width from it, mirrored."""
        page = self.open_ar()
        out = page.evaluate("""() => {
          const v = document.getElementById('arVideo').getBoundingClientRect();
          const mid = window.Inkyscib.AR._toScreen({x: 0.5, y: 0.5});
          const q = window.Inkyscib.AR._toScreen({x: 0.75, y: 0.5});
          const dw = 1280 * Math.max(v.width / 1280, v.height / 720);
          return {mid: [mid.x - (v.left + v.width / 2), mid.y - (v.top + v.height / 2)],
                  quarter: q.x - (v.left + v.width / 2), expected: -dw / 4};
        }""")
        self.assertLess(abs(out["mid"][0]), 0.5)
        self.assertLess(abs(out["mid"][1]), 0.5)
        self.assertAlmostEqual(out["quarter"], out["expected"], delta=0.5)

    def test_the_bar_is_the_way_out_and_escape_works_too(self):
        page = self.open_ar()
        self.assertTrue(page.is_visible("#arHud"))
        page.click('#arHud [data-ar="exit"]')
        state = page.evaluate("() => ({ar: window.appState.arMode, cam: !!window.appState.arStream, hud: document.getElementById('arHud').hidden})")
        self.assertEqual(state, {"ar": False, "cam": False, "hud": True})
        page.evaluate("() => window.Inkyscib.AR.enterAR()")
        page.wait_for_function("() => window.appState.arMode === true")
        page.keyboard.press("Escape")
        self.assertFalse(page.evaluate("() => window.appState.arMode"))
        self.assertEqual(self.errors, [])

    def test_the_view_comes_back_on_exit(self):
        page = self.new_page()
        page.evaluate("() => { Object.assign(window.appState.transform, {scale: 1.7, offsetX: -120, offsetY: 40}); return window.Inkyscib.AR.enterAR(); }")
        self.assertEqual(page.evaluate("() => window.appState.transform.scale"), 1)
        page.evaluate("() => window.Inkyscib.AR.exitAR()")
        self.assertEqual(
            page.evaluate("() => [window.appState.transform.scale, window.appState.transform.offsetX, window.appState.transform.offsetY]"),
            [1.7, -120, 40])

    def test_the_tools_pane_calls_it_ar_maethist(self):
        page = self.new_page()
        page.click('.file-ribbon-tab[data-ribbon-tab="tools"]')
        page.wait_for_selector(".file-backstage.is-open")
        self.assertIn("AR MAETHIST", page.inner_text(".file-backstage"))


if __name__ == "__main__":
    unittest.main()
