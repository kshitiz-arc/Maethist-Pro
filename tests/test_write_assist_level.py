"""Write assist is a level, 0-100, set with a slider.

Requested 2026-09-19: "can the handwriting assist make the handwriting more
cleaner and more uniform as much as possible, make it a spectrum slider and not
buttons for the levels of support".

What is pinned here:

  - The old presets were calibrated by measurement (test_ink_smoothing.py), so
    they are anchors on the new scale, not approximations of it: 40 must be
    Natural and 70 must be Strong to the last digit, and 0 must be Off.
  - Old saved settings ("off" / "natural" / "strong") keep meaning what they
    meant, and a stored 0 really is off -- the handwriting tidy used to test
    `=== "off"`, which a number never equals.
  - Past Strong the smoothing does not grow: measured, Strong's pen output is
    already as smooth as the intended line itself (turn jitter 0.0559 against
    0.0575), so more would only round letters off. The top of the range buys
    uniformity instead -- even line weight and trimmed end hooks -- and must
    never come out rougher than Strong.
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


STROKES = r"""
window.__assist = (() => {
  const line = (a, b, n) => Array.from({ length: n }, (_, i) => ({
    x: a.x + (b.x - a.x) * i / (n - 1), y: a.y + (b.y - a.y) * i / (n - 1) }));
  const join = (...parts) => parts
    .reduce((acc, p) => acc.concat(acc.length ? p.slice(1) : p), [])
    .map((p, i) => ({ ...p, pressure: 0.5, time: i * 4 }));
  let seed = 11;
  const rand = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  const wobbly = Array.from({ length: 220 }, (_, i) => {
    const t = i / 219;
    return { x: 300 + t * 420 + (rand() - 0.5) * 2.4,
             y: 320 + 34 * Math.sin(t * Math.PI * 6) + (rand() - 0.5) * 2.4,
             pressure: 0.15 + 0.7 * Math.abs(Math.sin(i / 6)), time: i * 4 };
  });
  return {
    wobbly,
    // A real touch-down hook: 2.5px that folds straight back on the stroke.
    hooked: join(line({x:100,y:102.5},{x:100.4,y:100},6), line({x:100.4,y:100},{x:100.4,y:160},60)),
    // And a real lift-off hook at the far end.
    hookedEnd: join(line({x:100,y:100},{x:100,y:160},60), line({x:100,y:160},{x:101.5,y:157.8},6)),
    // A handwritten 1: its ~135 degree flag is part of the letter.
    one: join(line({x:97,y:103},{x:100,y:100},6), line({x:100,y:100},{x:100,y:130},40)),
    vee: join(line({x:100,y:100},{x:115,y:130},30), line({x:115,y:130},{x:130,y:100},30)),
  };
})();
"""


@unittest.skipUnless(PLAYWRIGHT_AVAILABLE, "Playwright is not installed")
class WriteAssistLevelTests(unittest.TestCase):
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

    def open_page(self, seed_settings=None):
        context = self.browser.new_context(viewport={"width": 960, "height": 720})
        self.addCleanup(context.close)
        context.add_init_script(
            "localStorage.setItem('inkyscib-consent-v1', JSON.stringify({version: 1, analytics: false})); localStorage.setItem('inkyscib-feature-tour-v1', JSON.stringify({seen: true}))"
        )
        if seed_settings is not None:
            # Seeded once, not on every navigation, so a reload reads back
            # whatever the app itself saved.
            context.add_init_script(
                "if (!sessionStorage.getItem('__seeded')) {"
                "  sessionStorage.setItem('__seeded', '1');"
                f"  localStorage.setItem('inkyscib_settings', {seed_settings!r});"
                "}"
            )
        page = context.new_page()
        self.errors = []
        page.on("pageerror", lambda error: self.errors.append(str(error)))
        page.goto(self.base_url + "/write", wait_until="domcontentloaded")
        page.wait_for_function("() => window.appState?.storageReady === true")
        page.evaluate("() => {" + STROKES + "}")
        return page

    # ---- the scale ---------------------------------------------------------

    def test_the_old_names_are_exact_points_on_the_scale(self):
        page = self.open_page()
        result = page.evaluate(
            """() => {
              const ink = window.Inkyscib.InkSmooth;
              const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
              const raw = window.__assist.wobbly;
              const out = {};
              for (const type of ['pen', 'touch', 'mouse']) {
                out[type] = {
                  natural: same(ink.smoothStroke(raw, 'natural', 1, type), ink.smoothStroke(raw, 40, 1, type)),
                  strong: same(ink.smoothStroke(raw, 'strong', 1, type), ink.smoothStroke(raw, 70, 1, type)),
                  off: same(ink.smoothStroke(raw, 0, 1, type), raw.map((p) => ({ ...p }))),
                };
              }
              out.levels = ['off', 'natural', 'strong', 0, 55, -5, 150, 'garbage', '', null]
                .map((v) => ink.assistLevel(v));
              return out;
            }"""
        )
        for kind in ("pen", "touch", "mouse"):
            with self.subTest(input=kind):
                self.assertTrue(result[kind]["natural"], "level 40 is not exactly Natural")
                self.assertTrue(result[kind]["strong"], "level 70 is not exactly Strong")
                self.assertTrue(result[kind]["off"], "level 0 is not exactly Off")
        self.assertEqual(result["levels"], [0, 40, 70, 0, 55, 0, 100, 40, 40, 40])

    # A stored 0 turning the handwriting tidy off is pinned in
    # test_write_assist.py, test_with_smoothing_off_handwriting_is_not_tidied,
    # alongside 'off', on the stroke that test already proves Natural tidies.

    # ---- the top of the range ---------------------------------------------

    def test_end_hooks_are_trimmed_at_max_and_letters_are_not(self):
        page = self.open_page()
        result = page.evaluate(
            """() => {
              const ink = window.Inkyscib.InkSmooth;
              const s = window.__assist;
              const count = (pts, level) => ink.smoothStroke(pts, level, 1, 'pen').length;
              return {
                hooked: [count(s.hooked, 70), count(s.hooked, 100)],
                hookedEnd: [count(s.hookedEnd, 70), count(s.hookedEnd, 100)],
                one: [count(s.one, 70), count(s.one, 100)],
                vee: [count(s.vee, 70), count(s.vee, 100)],
                start: (() => { const o = ink.smoothStroke(s.hooked, 100, 1, 'pen')[0]; return [o.x, o.y]; })(),
              };
            }"""
        )
        self.assertLess(result["hooked"][1], result["hooked"][0], "a touch-down hook survived Max")
        self.assertLess(result["hookedEnd"][1], result["hookedEnd"][0], "a lift-off hook survived Max")
        # Trimmed at the turning point, where the letter actually starts.
        self.assertAlmostEqual(result["start"][0], 100.4, places=1)
        self.assertAlmostEqual(result["start"][1], 100.0, places=1)
        self.assertEqual(result["one"][0], result["one"][1], "a 1 lost its flag")
        self.assertEqual(result["vee"][0], result["vee"][1], "a v lost part of its shape")

    def test_max_evens_the_line_weight_and_strong_does_not(self):
        page = self.open_page()
        spread = page.evaluate(
            """() => {
              const ink = window.Inkyscib.InkSmooth;
              const raw = window.__assist.wobbly;
              const range = (pts) => {
                const p = pts.map((q) => q.pressure).sort((a, b) => a - b);
                // Ignore the tapered ends; compare the body of the stroke.
                const body = p.slice(Math.floor(p.length * 0.1), Math.ceil(p.length * 0.9));
                return body[body.length - 1] - body[0];
              };
              return { strong: range(ink.smoothStroke(raw, 70, 1, 'pen')), max: range(ink.smoothStroke(raw, 100, 1, 'pen')) };
            }"""
        )
        self.assertLess(
            spread["max"], spread["strong"] * 0.4,
            f"Max left the weight nearly as uneven as Strong: {spread}",
        )

    # ---- the slider -------------------------------------------------------

    def test_the_slider_replaces_the_buttons_and_is_a_real_touch_target(self):
        page = self.open_page()
        page.evaluate("() => { window.setTool('pen'); window.Inkyscib.ToolDock.setCollapsed(false); }")
        state = page.evaluate(
            """() => {
              const s = document.getElementById('writeAssistLevel');
              const r = s.getBoundingClientRect();
              return {
                buttons: document.querySelectorAll('.ink-smooth-btn').length,
                type: s.type, min: s.min, max: s.max, value: s.value,
                height: r.height,
                name: document.getElementById('writeAssistName').textContent,
                valuetext: s.getAttribute('aria-valuetext'),
              };
            }"""
        )
        self.assertEqual(state["buttons"], 0, "the old Off/Natural/Strong buttons are still there")
        self.assertEqual((state["type"], state["min"], state["max"]), ("range", "0", "100"))
        self.assertEqual(state["value"], "40", "the default is not Natural")
        self.assertGreaterEqual(state["height"], 44)
        self.assertEqual(state["name"], "Natural")
        self.assertIn("Natural", state["valuetext"])
        self.assertEqual(self.errors, [])

    def test_dragging_sets_the_level_and_lands_on_the_calibrated_stops(self):
        page = self.open_page()
        page.evaluate("() => { window.setTool('pen'); window.Inkyscib.ToolDock.setCollapsed(false); }")
        result = page.evaluate(
            """() => {
              const s = document.getElementById('writeAssistLevel');
              const drop = (v) => {
                s.value = String(v);
                s.dispatchEvent(new Event('input', { bubbles: true }));
                s.dispatchEvent(new Event('change', { bubbles: true }));
                return { stored: window.appState.toolSettings.pen.smoothing, shown: s.value,
                         name: document.getElementById('writeAssistName').textContent };
              };
              return { near: drop(42), free: drop(55), top: drop(98), off: drop(2) };
            }"""
        )
        self.assertEqual(result["near"]["stored"], 40, "42 should settle on Natural")
        self.assertEqual(result["free"]["stored"], 55, "55 is between stops and should stay")
        self.assertEqual(result["top"]["stored"], 100)
        self.assertEqual(result["top"]["name"], "Max")
        self.assertEqual(result["off"]["stored"], 0)
        self.assertEqual(result["off"]["name"], "Off")
        self.assertEqual(self.errors, [])

    def test_an_old_saved_name_is_read_as_its_level_and_a_number_survives_reload(self):
        page = self.open_page(seed_settings='{"pen": {"smoothing": "strong"}}')
        page.evaluate("() => { window.setTool('pen'); window.Inkyscib.ToolDock.setCollapsed(false); }")
        migrated = page.evaluate(
            "() => ({ stored: window.appState.toolSettings.pen.smoothing,"
            "         shown: document.getElementById('writeAssistLevel').value })"
        )
        self.assertEqual(migrated, {"stored": 70, "shown": "70"}, "a saved 'strong' did not land on 70")

        page.evaluate("() => window.Inkyscib.WriteAssist.set(85)")
        page.wait_for_function(
            """() => {
              try { return JSON.parse(localStorage.getItem('inkyscib_settings')).pen.smoothing === 85; }
              catch (_) { return false; }
            }""",
            timeout=5000,
        )
        page.reload()
        page.wait_for_function("() => window.appState?.storageReady === true")
        page.wait_for_function(
            "() => document.getElementById('writeAssistLevel')?.value === '85'", timeout=5000
        )
        self.assertEqual(page.evaluate("() => window.appState.toolSettings.pen.smoothing"), 85)
        self.assertEqual(self.errors, [])


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
