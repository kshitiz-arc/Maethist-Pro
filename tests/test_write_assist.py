"""Write assist, second half: shape snapping, digit-aware tidy, and the way back.

The live one-euro filter in events.js is covered by test_pen_smoothing.py.
This file covers what happens on lift, and it is written around one promise:
a correction is only acceptable if it is *bounded* and *reversible*. A stroke
may be steadied, but it must stay recognisably the stroke that was drawn, and
one tap must put the original back.

The synthetic strokes below are wobbled deterministically, so a failure is
reproducible rather than a coin toss.
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


# Builds a wobbled outline in page script. Kept as one helper so every test
# draws its shapes the same way and a threshold change shows up everywhere.
STROKE_HELPERS = """
window.__seed = 20260906;
window.__rnd = () => { window.__seed = (window.__seed * 1103515245 + 12345) & 0x7fffffff;
                       return window.__seed / 0x7fffffff; };
window.__wobble = (points, amount) => {
  const xs = points.map(p => p.x), ys = points.map(p => p.y);
  const size = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) || 1;
  const amp = amount * size, ph = window.__rnd() * 6.28;
  return points.map((p, i) => {
    const t = i / Math.max(1, points.length - 1);
    return { x: p.x + amp * Math.sin(t * 7.1 + ph), y: p.y + amp * Math.cos(t * 6.3 + ph),
             pressure: 0.55, time: 1000 + i * 8 };
  });
};
window.__circle = (cx, cy, r, n) => { const o = [];
  for (let i = 0; i <= (n || 48); i++) { const a = (i / (n || 48)) * Math.PI * 2;
    o.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r }); } return o; };
window.__poly = (verts, per) => { const o = [];
  for (let i = 0; i < verts.length; i++) { const a = verts[i], b = verts[(i + 1) % verts.length];
    for (let k = 0; k <= (per || 16); k++) { const t = k / (per || 16);
      o.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }); } } return o; };

// Commit a stroke the way the app does, so endDrawing's real wiring runs
// rather than a reimplementation of it.
window.__draw = (points) => {
  const s = window.appState;
  s.paths.length = 0;
  s.currentTool = 'pen';
  s.isDrawing = true;
  s.currentPath = { tool: 'pen', penStyle: 'default', color: '#ffffff', size: 3,
                    points: points.map(p => ({ ...p })), timestamp: Date.now() };
  window.Inkyscib.Events.endDrawing();
  return s.paths[0] || null;
};
"""


@unittest.skipUnless(PLAYWRIGHT_AVAILABLE, "Playwright is not installed")
class WriteAssistTests(unittest.TestCase):
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

    def open_page(self, viewport=None):
        # bypass_csp because the editor forbids 'unsafe-eval', which is also
        # what Playwright's polling waits need. The viewport is set here rather
        # than after load: resizing a loaded editor flips it into tool-dock
        # mode, which is a different layout from the one a tablet actually
        # opens in.
        context = self.browser.new_context(
            bypass_csp=True, **({"viewport": viewport} if viewport else {})
        )
        self.addCleanup(context.close)
        page = context.new_page()
        self.errors = []
        page.on("pageerror", lambda error: self.errors.append(str(error)))
        # The first-run tour swallows clicks and would make every wait time out
        # for a reason unrelated to what is under test.
        page.add_init_script("localStorage.setItem('inkyscib-consent-v1', JSON.stringify({version: 1, analytics: false})); localStorage.setItem('inkyscib-feature-tour-v1', 'seen')")
        page.goto(self.base_url + "/write", wait_until="domcontentloaded")
        page.wait_for_function("() => window.appState?.storageReady === true")
        page.wait_for_function("() => window.Inkyscib?.Handwriting && window.Inkyscib?.InkRecognize")
        # Wrapped in a function on purpose: evaluating the helpers as a bare
        # expression makes Playwright call the last value in them — which is a
        # function — with no arguments.
        # STROKE_HELPERS ends in a newline, so the tail below starts on its own
        # line and is not swallowed by the last // comment.
        page.evaluate("() => {" + STROKE_HELPERS + "return true; }")
        return page

    def assert_no_page_errors(self):
        self.assertEqual(self.errors, [], "unexpected page errors")

    # ---------- snapping ----------

    def test_a_drawn_circle_becomes_a_real_geometry_object(self):
        """Not just tidier ink — an object with a centre and a radius.

        This is the difference the feature turns on: a snapped circle can be
        resized, measured and used in a construction, because it goes through
        the same geometry.js path a circle drawn with the shape tool does.
        """
        page = self.open_page()
        result = page.evaluate(
            """() => {
              const path = window.__draw(window.__wobble(window.__circle(300, 300, 90), 0.03));
              return { tool: path?.tool, kind: path?.geometryKind,
                       smart: !!window.Inkyscib.SmartGeometry.isSmartCircle(path),
                       radius: window.Inkyscib.SmartGeometry.circleRadius(path) };
            }"""
        )
        self.assertEqual(result["tool"], "shape")
        self.assertEqual(result["kind"], "circle")
        self.assertTrue(result["smart"], "it must be a SmartGeometry circle, not shaped ink")
        # It has to land on the circle that was drawn, not just any circle.
        self.assertAlmostEqual(result["radius"], 90, delta=12)
        self.assert_no_page_errors()

    def test_a_drawn_box_becomes_a_rectangle_with_four_corners(self):
        page = self.open_page()
        result = page.evaluate(
            """() => {
              const box = window.__poly([{x:200,y:200},{x:440,y:200},{x:440,y:380},{x:200,y:380}]);
              const path = window.__draw(window.__wobble(box, 0.02));
              return { tool: path?.tool, kind: path?.geometryKind, corners: path?.points?.length };
            }"""
        )
        self.assertEqual(result["tool"], "shape")
        self.assertEqual(result["kind"], "rectangle")
        self.assertEqual(result["corners"], 4)
        self.assert_no_page_errors()

    def test_a_scribble_is_left_exactly_as_drawn(self):
        """The failure mode that matters most.

        Snapping something that was not a shape destroys work, so a stroke the
        recogniser cannot place must come through untouched.
        """
        page = self.open_page()
        result = page.evaluate(
            """() => {
              const pts = [];
              for (let i = 0; i < 90; i++)
                pts.push({ x: 100 + i * 5, y: 300 + Math.sin(i / 2.5) * 70 + Math.cos(i / 1.3) * 25 });
              const before = pts.map(p => ({ ...p }));
              const path = window.__draw(pts);
              return { tool: path?.tool, count: path?.points?.length, before: before.length };
            }"""
        )
        self.assertEqual(result["tool"], "pen", "a scribble must stay ink")
        self.assert_no_page_errors()

    def test_a_written_digit_is_tidied_but_never_snapped_to_a_shape(self):
        """A small round stroke is a zero, not a circle.

        Size is what separates the two, and getting it wrong would turn every
        handwritten 0 into a geometry object mid-sentence.
        """
        page = self.open_page()
        result = page.evaluate(
            """() => {
              const path = window.__draw(window.__wobble(window.__circle(200, 200, 14), 0.04));
              return { tool: path?.tool, kind: path?.geometryKind || null };
            }"""
        )
        self.assertEqual(result["tool"], "pen", "a written 0 must stay handwriting")
        self.assertIsNone(result["kind"])
        self.assert_no_page_errors()

    # ---------- the promise ----------

    def test_the_tidy_never_moves_ink_outside_its_stated_bound(self):
        """The whole 'it is still your handwriting' claim, as a number.

        However the tidy is tuned, no point of the result may sit further from
        the original stroke than maxShiftFor allows.
        """
        page = self.open_page()
        worst = page.evaluate(
            """() => {
              const HW = window.Inkyscib.Handwriting;
              let worst = 0;
              for (const amount of [0.01, 0.03, 0.06, 0.1]) {
                for (const profile of [HW.DEFAULT_PROFILE, HW.DIGIT_PROFILES['1'], HW.DIGIT_PROFILES['0']]) {
                  const raw = window.__wobble(window.__circle(300, 300, 70), amount);
                  const tidied = HW.tidy(raw, profile);
                  if (!tidied) continue;
                  const xs = raw.map(p => p.x), ys = raw.map(p => p.y);
                  const bounds = { width: Math.max(...xs) - Math.min(...xs),
                                   height: Math.max(...ys) - Math.min(...ys) };
                  const limit = HW.maxShiftFor(bounds);
                  for (const point of tidied) {
                    const near = HW.nearestOnPolyline(point, raw);
                    if (near) worst = Math.max(worst, near.distance / limit);
                  }
                }
              }
              return worst;
            }"""
        )
        # Ratio of actual displacement to the allowed limit; 1.0 is the bound.
        self.assertLessEqual(worst, 1.001, "the tidy moved ink past its own limit")
        self.assert_no_page_errors()

    def test_undo_puts_the_original_stroke_back(self):
        page = self.open_page()
        result = page.evaluate(
            """() => {
              const raw = window.__wobble(window.__circle(300, 300, 90), 0.03);
              const before = raw.map(p => ({ x: p.x, y: p.y }));
              const snapped = window.__draw(raw);
              const wasShape = snapped?.tool === 'shape';
              const reverted = window.Inkyscib.Handwriting.revertLast();
              const now = window.appState.paths[0];
              let worst = 0;
              (now?.points || []).forEach((p, i) => {
                if (before[i]) worst = Math.max(worst, Math.hypot(p.x - before[i].x, p.y - before[i].y));
              });
              return { wasShape, reverted, tool: now?.tool, count: now?.points?.length,
                       expected: before.length, worst };
            }"""
        )
        self.assertTrue(result["wasShape"], "the stroke should have been snapped first")
        self.assertTrue(result["reverted"])
        self.assertEqual(result["tool"], "pen")
        self.assertEqual(result["count"], result["expected"], "every original point must return")
        self.assertLess(result["worst"], 1e-6, "the original must come back unmodified")
        self.assert_no_page_errors()

    def test_turning_shape_assist_off_never_snaps(self):
        # Off stops snapping only. Tidying handwriting follows the pen's own
        # smoothing setting; test_with_smoothing_off_handwriting_is_not_tidied
        # covers that half.
        page = self.open_page()
        result = page.evaluate(
            """() => {
              window.Inkyscib.Handwriting.setEnabled(false);
              const path = window.__draw(window.__wobble(window.__circle(300, 300, 90), 0.03));
              const off = { tool: path?.tool, count: path?.points?.length };
              window.Inkyscib.Handwriting.setEnabled(true);
              const again = window.__draw(window.__wobble(window.__circle(300, 300, 90), 0.03));
              return { off, onTool: again?.tool };
            }"""
        )
        self.assertEqual(result["off"]["tool"], "pen", "assist off must not snap anything")
        self.assertEqual(result["onTool"], "shape", "and turning it back on must work")
        self.assert_no_page_errors()

    def test_the_slider_is_reachable_and_a_real_touch_target(self):
        """Three steps -- Off, Straight, Exact -- on one 44px slider.

        The on/off switch it replaced could only ever say "snap" or "don't";
        whether a leaning square should become a square or stay the rhombus
        it was drawn as is a separate question, and the slider asks it.
        Measured at the ~960px tablet this is written for.
        """
        page = self.open_page(viewport={"width": 960, "height": 720})
        # Below the dock a panel no longer opens by itself on load, so open the
        # pen panel the way a person does: tap the pen, which is already in hand.
        page.evaluate("() => document.getElementById('penTool').click()")
        page.wait_for_timeout(350)
        box = page.evaluate(
            """() => {
              const slider = document.getElementById('shapeAssistLevel');
              if (!slider) return null;
              const rect = slider.getBoundingClientRect();
              return { height: rect.height, min: slider.min, max: slider.max, step: slider.step,
                       value: slider.value, valuetext: slider.getAttribute('aria-valuetext'),
                       stops: [...document.querySelectorAll('#shapeAssistSpectrum [data-stop]')]
                         .map(s => s.textContent.trim()) };
            }"""
        )
        self.assertIsNotNone(box, "the shape assist slider should exist in the pen panel")
        self.assertGreaterEqual(box["height"], 44, "below DESIGN.md's 44px minimum touch target")
        self.assertEqual((box["min"], box["max"], box["step"]), ("0", "2", "1"))
        self.assertEqual(box["stops"], ["Off", "Straight", "Exact"])
        self.assertEqual(box["value"], "1", "Straight is the default")
        self.assertEqual(box["valuetext"], "Straight")
        self.assert_no_page_errors()

    # ---------- the top-bar toggle ----------

    def test_shape_assist_sits_between_redo_and_the_divider(self):
        """Undo · Redo · Shape assist | Clear, and a real touch target on the tablet."""
        page = self.open_page(viewport={"width": 960, "height": 720})
        result = page.evaluate(
            """() => {
              const button = document.getElementById('shapeAssistBtn');
              if (!button) return null;
              const zone = button.closest('.bar-work');
              const order = zone ? [...zone.children].map(el =>
                el.id || (el.classList.contains('toolbar-divider') ? 'divider' : el.tagName)) : [];
              const rect = button.getBoundingClientRect();
              return { order, width: rect.width, height: rect.height,
                       pressed: button.getAttribute('aria-pressed'),
                       label: button.getAttribute('aria-label') };
            }"""
        )
        self.assertIsNotNone(result, "#shapeAssistBtn should exist in the top bar")
        self.assertEqual(result["order"], ["undoBtn", "redoBtn", "shapeAssistBtn", "divider", "clearBtn"])
        self.assertGreaterEqual(result["width"], 44)
        self.assertGreaterEqual(result["height"], 44)
        self.assertEqual(result["pressed"], "true", "shape assist is on by default")
        self.assertEqual(result["label"], "Shape assist")
        self.assert_no_page_errors()

    def test_the_top_bar_and_the_slider_are_one_setting(self):
        """The bar button is Off and back; the slider picks the step. Back
        means the step last chosen, not a default the writer did not pick."""
        page = self.open_page(viewport={"width": 1440, "height": 900})
        state = """() => ({
          level: window.Inkyscib.Handwriting.level(),
          bar: document.getElementById('shapeAssistBtn').getAttribute('aria-pressed'),
          slider: document.getElementById('shapeAssistLevel').value
        })"""
        set_slider = """value => { const s = document.getElementById('shapeAssistLevel');
          s.value = String(value); s.dispatchEvent(new Event('input', { bubbles: true })); }"""
        page.evaluate(set_slider, 2)
        exact = page.evaluate(state)
        page.click("#shapeAssistBtn")
        off = page.evaluate(state)
        page.click("#shapeAssistBtn")
        back = page.evaluate(state)
        page.evaluate(set_slider, 0)
        slid_off = page.evaluate(state)
        self.assertEqual(exact, {"level": 2, "bar": "true", "slider": "2"})
        self.assertEqual(off, {"level": 0, "bar": "false", "slider": "0"})
        self.assertEqual(back, {"level": 2, "bar": "true", "slider": "2"}, "back to Exact, not to a default")
        self.assertEqual(slid_off, {"level": 0, "bar": "false", "slider": "0"})
        self.assert_no_page_errors()

    def test_an_old_on_setting_reads_as_straight(self):
        """The key is the old switch's; its "1" meant on, and Straight replaces on."""
        page = self.open_page()
        level = page.evaluate(
            """() => { localStorage.setItem('inkyscib-write-assist-shapes', '1');
                       return true; }"""
        )
        page.reload(wait_until="domcontentloaded")
        page.wait_for_function("() => !!window.Inkyscib?.Handwriting")
        self.assertEqual(page.evaluate("() => window.Inkyscib.Handwriting.level()"), 1)
        self.assert_no_page_errors()

    def test_off_a_drawn_shape_stays_handwriting(self):
        page = self.open_page()
        result = page.evaluate(
            """() => {
              document.getElementById('shapeAssistBtn').click();
              const path = window.__draw(window.__wobble(window.__circle(300, 300, 90), 0.03));
              return { tool: path?.tool, kind: path?.geometryKind || null };
            }"""
        )
        self.assertEqual(result, {"tool": "pen", "kind": None})
        self.assert_no_page_errors()

    def test_a_snap_keeps_the_pen_in_hand(self):
        """Switching to Select under a writer who is mid-sentence loses their next stroke."""
        page = self.open_page()
        result = page.evaluate(
            """() => {
              window.setTool('pen');
              const path = window.__draw(window.__wobble(window.__circle(300, 300, 90), 0.03));
              return { tool: path?.tool, current: window.appState.currentTool };
            }"""
        )
        self.assertEqual(result["tool"], "shape")
        self.assertEqual(result["current"], "pen", "a snap must not switch tools")
        self.assert_no_page_errors()

    def snap_a_circle(self, page):
        page.evaluate(
            """() => {
              window.setTool('pen');
              window.__before = window.__wobble(window.__circle(300, 300, 90), 0.03);
              window.__draw(window.__before.map(p => ({ ...p })));
            }"""
        )
        chip = page.locator(".write-assist-chip")
        chip.wait_for(state="visible")
        return chip

    def test_the_chip_offers_edit_and_keep_as_ink(self):
        page = self.open_page()
        chip = self.snap_a_circle(page)
        label = chip.locator(".write-assist-chip-label").inner_text()
        edit = chip.get_by_role("button", name="Edit")
        keep = chip.get_by_role("button", name="Keep as ink")
        boxes = [edit.bounding_box(), keep.bounding_box()]

        self.assertTrue(label.startswith("Circle"), label)
        for box in boxes:
            self.assertIsNotNone(box)
            self.assertGreaterEqual(box["height"], 44)
            self.assertGreaterEqual(box["width"], 44)

        edit.click()
        result = page.evaluate(
            """() => ({ current: window.appState.currentTool,
                        selected: window.Inkyscib.Selection.selectedIndices(),
                        chip: getComputedStyle(document.querySelector('.write-assist-chip')).display })"""
        )
        self.assertEqual(result["current"], "select")
        self.assertEqual(result["selected"], [0])
        self.assertEqual(result["chip"], "none")
        self.assert_no_page_errors()

    def test_keep_as_ink_restores_the_stroke_exactly(self):
        page = self.open_page()
        chip = self.snap_a_circle(page)
        chip.get_by_role("button", name="Keep as ink").click()
        result = page.evaluate(
            """() => {
              const now = window.appState.paths[0];
              let worst = 0;
              window.__before.forEach((p, i) => {
                const q = now?.points?.[i];
                worst = Math.max(worst, q ? Math.hypot(q.x - p.x, q.y - p.y) : Infinity);
              });
              return { tool: now?.tool, count: now?.points?.length, expected: window.__before.length,
                       worst, current: window.appState.currentTool,
                       chip: getComputedStyle(document.querySelector('.write-assist-chip')).display };
            }"""
        )
        self.assertEqual(result["tool"], "pen")
        self.assertEqual(result["count"], result["expected"])
        self.assertLess(result["worst"], 1e-6)
        self.assertEqual(result["current"], "pen")
        self.assertEqual(result["chip"], "none")
        self.assert_no_page_errors()

    def test_with_smoothing_off_handwriting_is_not_tidied(self):
        """Off means off: the pen's smoothing setting also governs the lift tidy."""
        page = self.open_page()
        result = page.evaluate(
            """() => {
              const stroke = () => {
                const pts = [];
                // A gently bowed downstroke. The tidy reads it as a 1 and, on
                // Natural, straightens it by about 1.6px - measured, so the
                // control below proves this test can fail.
                for (let i = 0; i <= 40; i++)
                  pts.push({ x: 200 + Math.sin(Math.PI * i / 40) * 3, y: 120 + i * 2.25, pressure: 0.55, time: 1000 + i * 8 });
                return pts;
              };
              const moved = (mode) => {
                window.appState.toolSettings.pen.smoothing = mode;
                const raw = stroke();
                const path = window.__draw(raw.map(p => ({ ...p })));
                let worst = 0;
                raw.forEach((p, i) => {
                  const q = path.points[i];
                  worst = Math.max(worst, q ? Math.hypot(q.x - p.x, q.y - p.y) : Infinity);
                });
                return { worst, count: path.points.length, expected: raw.length };
              };
              // 0 as well as 'off': since the slider the setting is a number,
              // and the tidy used to test `=== "off"`, which 0 never equals.
              return { natural: moved('natural'), off: moved('off'), zero: moved(0) };
            }"""
        )
        self.assertGreater(result["natural"]["worst"], 0.75, "control: natural should tidy this stroke")
        for key in ("off", "zero"):
            self.assertEqual(result[key]["count"], result[key]["expected"], key)
            self.assertLess(result[key]["worst"], 1e-9, f"smoothing {key} must leave the stroke as drawn")
        self.assert_no_page_errors()

    # ---------- the recogniser on its own ----------

    def test_the_chip_actually_disappears_when_it_is_dismissed(self):
        """Checked as computed style, not as the hidden attribute.

        `.write-assist-chip { display: flex }` is a class selector and so wins
        against the user agent's `[hidden] { display: none }`. Asserting on the
        property alone passes while the chip sits on screen for ever, which is
        exactly what it did.
        """
        page = self.open_page()
        result = page.evaluate(
            """() => {
              const HW = window.Inkyscib.Handwriting;
              window.__draw(window.__wobble(window.__circle(300, 300, 90), 0.03));
              const chip = document.querySelector('.write-assist-chip');
              const shown = getComputedStyle(chip).display;
              HW.revertLast();
              return { shown, hiddenDisplay: getComputedStyle(chip).display };
            }"""
        )
        self.assertNotEqual(result["shown"], "none", "the chip should be visible after a snap")
        self.assertEqual(result["hiddenDisplay"], "none", "the chip must actually go away")
        self.assert_no_page_errors()

    def test_the_recogniser_refuses_to_guess(self):
        """Open arcs, letters and scribbles must all come back as nothing.

        A recogniser that answers everything is worse than none: it corrupts
        strokes that were already what the writer wanted.
        """
        page = self.open_page()
        verdicts = page.evaluate(
            """() => {
              const R = window.Inkyscib.InkRecognize;
              const arc = [];
              for (let i = 0; i <= 40; i++) { const a = (i / 40) * Math.PI * 0.8;
                arc.push({ x: 200 + Math.cos(a) * 90, y: 200 + Math.sin(a) * 90 }); }
              const zig = window.__poly([{x:0,y:0},{x:70,y:-60},{x:130,y:40},{x:200,y:-50},{x:140,y:70}], 6);
              const noise = [];
              for (let i = 0; i < 80; i++) noise.push({ x: i * 4, y: Math.sin(i / 3) * 40 + (i % 7) * 6 });
              return {
                arc: R.recognizeShape(arc), zig: R.recognizeShape(zig), noise: R.recognizeShape(noise)
              };
            }"""
        )
        self.assertIsNone(verdicts["arc"], "an open arc is not a shape")
        self.assertIsNone(verdicts["zig"], "a zigzag is not a shape")
        self.assertIsNone(verdicts["noise"], "a scribble is not a shape")
        self.assert_no_page_errors()

    # ---------- the three steps ----------
    #
    # Reported 2026-09-21: "if I am trying to draw a square, sometimes shape
    # assist makes it a rhombus". Measured before the fix: a square whose
    # sides lean 14° came out a rhombus 25% of the time and one leaning 18°
    # every time, and a square leaning 10° was rebuilt 239x198 -- the
    # rectangle rebuild measured the diagonal, so the lean was added to the
    # width. Straight is the step that answers the report; Exact is the one
    # that keeps a deliberate rhombus a rhombus.

    LEANING = """lean => {
      const t = Math.tan(lean * Math.PI / 180);
      return window.__wobble(window.__poly(
        [{x:300,y:200},{x:500,y:200},{x:500,y:400},{x:300,y:400}]
          .map(p => ({ x: p.x - (p.y - 200) * t, y: p.y }))), 0.012);
    }"""

    GEOMETRY = """path => {
      const vs = path.points || [];
      const n = vs.length;
      const angles = vs.map((v, i) => { const p = vs[(i + n - 1) % n], q = vs[(i + 1) % n];
        let d = Math.abs(Math.atan2(p.y - v.y, p.x - v.x) - Math.atan2(q.y - v.y, q.x - v.x));
        if (d > Math.PI) d = 2 * Math.PI - d; return d * 180 / Math.PI; });
      const sides = vs.map((v, i) => Math.hypot(vs[(i + 1) % n].x - v.x, vs[(i + 1) % n].y - v.y));
      const edges = vs.map((v, i) => { let a = Math.atan2(vs[(i + 1) % n].y - v.y, vs[(i + 1) % n].x - v.x) * 180 / Math.PI;
        return ((a % 90) + 90) % 90; });
      return { tool: path.tool, kind: path.geometryKind || null, angles, sides, edges };
    }"""

    def draw_at(self, page, level, builder, argument):
        return page.evaluate(
            """([level, builder, geometry, argument]) => {
              window.Inkyscib.Handwriting.setLevel(level);
              const build = eval(builder);   // test-only; bypass_csp is on
              const measure = eval(geometry);
              return measure(window.__draw(build(argument)));
            }""",
            [level, self.LEANING if builder == "leaning" else builder, self.GEOMETRY, argument],
        )

    def test_straight_turns_a_leaning_square_into_a_true_square(self):
        page = self.open_page()
        for lean in (0, 10, 14, 18):
            with self.subTest(lean=lean):
                g = self.draw_at(page, 1, "leaning", lean)
                self.assertEqual((g["tool"], g["kind"]), ("shape", "square"))
                for angle in g["angles"]:
                    self.assertAlmostEqual(angle, 90, delta=0.5)
                self.assertLess(max(g["sides"]) - min(g["sides"]), 0.5, "four equal sides")
                # 200 across as drawn, not 239: the lean adds nothing to the size.
                self.assertAlmostEqual(g["sides"][0], 200, delta=8)
                for edge in g["edges"]:
                    self.assertTrue(edge < 0.5 or edge > 89.5, "square to the page")
        self.assert_no_page_errors()

    def test_exact_keeps_a_leaning_square_the_shape_it_was_drawn(self):
        page = self.open_page()
        g = self.draw_at(page, 2, "leaning", 18)
        self.assertEqual(g["tool"], "shape")
        self.assertIn(g["kind"], ("rhombus", "parallelogram"), "it was drawn as one")
        # The drawn corners were 72 and 108; Exact keeps them.
        self.assertAlmostEqual(min(g["angles"]), 72, delta=3)
        self.assertAlmostEqual(max(g["angles"]), 108, delta=3)
        self.assert_no_page_errors()

    def test_exact_straightens_an_outline_with_no_name_and_keeps_its_corners(self):
        page = self.open_page()
        result = page.evaluate(
            """() => {
              window.Inkyscib.Handwriting.setLevel(2);
              const corners = [{x:300,y:200},{x:520,y:232},{x:468,y:418},{x:288,y:362}];
              const path = window.__draw(window.__wobble(window.__poly(corners), 0.01));
              const pts = path.points;
              // Every drawn corner must have a straightened point within a few px.
              const nearest = corners.map(c => Math.min(...pts.map(p => Math.hypot(p.x - c.x, p.y - c.y))));
              return { tool: path.tool, kind: path.geometryKind || null, nearest };
            }"""
        )
        self.assertEqual(result["tool"], "pen", "no named figure fits, so it stays ink")
        for gap in result["nearest"]:
            self.assertLess(gap, 6, "a corner moved away from where it was drawn")
        self.assert_no_page_errors()

    def test_a_long_straight_stroke_becomes_a_straight_line(self):
        page = self.open_page()
        result = page.evaluate(
            """() => {
              const stroke = [];
              for (let i = 0; i <= 40; i++)
                stroke.push({ x: 200 + i * 6, y: 300 + i * 0.35 + Math.sin(i) * 1.2 });
              const measure = (level) => {
                window.Inkyscib.Handwriting.setLevel(level);
                const path = window.__draw(stroke);
                const a = path.points[0], b = path.points[path.points.length - 1];
                const len = Math.hypot(b.x - a.x, b.y - a.y);
                const off = Math.max(...path.points.map(p =>
                  Math.abs((b.x - a.x) * (a.y - p.y) - (a.x - p.x) * (b.y - a.y)) / len));
                return { tool: path.tool, off, angle: Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI };
              };
              return { straight: measure(1), exact: measure(2) };
            }"""
        )
        for step in ("straight", "exact"):
            with self.subTest(step=step):
                self.assertEqual(result[step]["tool"], "pen", "a line stays ink")
                self.assertLess(result[step]["off"], 0.01, "and is perfectly straight")
        self.assertAlmostEqual(result["straight"]["angle"], 0, delta=0.01, msg="Straight levels it")
        self.assertAlmostEqual(result["exact"]["angle"], 3.3, delta=0.5, msg="Exact keeps the drawn angle")
        self.assert_no_page_errors()

    def test_a_short_straight_stroke_is_handwriting_not_a_line(self):
        """A written 1 or l is an open straight stroke too."""
        page = self.open_page()
        result = page.evaluate(
            """() => {
              window.Inkyscib.Handwriting.setLevel(2);
              const one = [];
              for (let i = 0; i <= 12; i++) one.push({ x: 300 + Math.sin(i) * 0.8, y: 300 + i * 4 });
              const before = one.map(p => ({ ...p }));
              const path = window.__draw(one);
              const a = path.points[0], b = path.points[path.points.length - 1];
              return { tool: path.tool, count: path.points.length, drawn: before.length };
            }"""
        )
        self.assertEqual(result["tool"], "pen")
        self.assertLessEqual(result["count"], result["drawn"] + 2,
                             "a 48px stroke was rebuilt as a sampled line")
        self.assert_no_page_errors()

    def test_nothing_that_is_not_a_figure_is_touched_at_any_step(self):
        page = self.open_page()
        verdicts = page.evaluate(
            """() => {
              const R = window.Inkyscib.InkRecognize;
              const arc = [];
              for (let i = 0; i <= 40; i++) { const a = (i / 40) * Math.PI * 1.2;
                arc.push({ x: 400 + Math.cos(a) * 150, y: 300 + Math.sin(a) * 150 }); }
              const star = window.__poly([0, 1, 2, 3, 4].map(k => ({
                x: 400 + Math.cos(-Math.PI / 2 + k * 4 * Math.PI / 5) * 150,
                y: 300 + Math.sin(-Math.PI / 2 + k * 4 * Math.PI / 5) * 150 })), 10);
              const blob = [];
              for (let i = 0; i <= 80; i++) { const t = i / 80 * 2 * Math.PI, r = 110 + 35 * Math.sin(5 * t);
                blob.push({ x: 400 + Math.cos(t) * r, y: 300 + Math.sin(t) * r }); }
              const out = {};
              for (const level of [1, 2]) for (const [name, pts] of Object.entries({ arc, star, blob })) {
                const shape = R.interpretShape(R.analyzeShape(pts, { lines: true }), level);
                out[name + '@' + level] = shape ? shape.kind : null;
              }
              return out;
            }"""
        )
        for name, kind in verdicts.items():
            with self.subTest(stroke=name):
                self.assertIsNone(kind, f"{name} came back as {kind}")
        self.assert_no_page_errors()

    def test_a_snapped_right_triangle_edits_like_one_from_the_shape_tool(self):
        """geometry.js locks a right triangle's 90° at index 1. A snapped one
        must too, or the first corner drag quietly loses the right angle."""
        page = self.open_page()
        result = page.evaluate(
            """() => {
              window.Inkyscib.Handwriting.setLevel(1);
              const path = window.__draw(window.__wobble(window.__poly(
                [{x:300,y:200},{x:306,y:400},{x:560,y:392}]), 0.01));
              return { kind: path.geometryKind, type: path.triangleType,
                       locked: path.lockedAngles, marks: path.angleMarks };
            }"""
        )
        self.assertEqual((result["kind"], result["type"]), ("triangle", "right"))
        self.assertAlmostEqual(result["locked"][1], 1.5707963, places=4)
        self.assertTrue(result["marks"][1])
        self.assert_no_page_errors()

    def test_straight_recognises_hand_drawn_squares_reliably(self):
        """Many strokes, not one: tuned on the mean, as the rest of this file is.

        Forty squares with the faults a hand actually makes -- a lean of up to
        20°, corners off by up to 12px, a tilt of up to 8° -- must come back as
        squares at least 95% of the time, and never as a rhombus.
        """
        page = self.open_page()
        tally = page.evaluate(
            """() => {
              let seed = 4242;
              const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
              const R = window.Inkyscib.InkRecognize;
              const out = {};
              for (let i = 0; i < 40; i++) {
                const lean = (rnd() * 2 - 1) * 20 * Math.PI / 180, tilt = (rnd() * 2 - 1) * 8 * Math.PI / 180;
                const corners = [{x:-100,y:-100},{x:100,y:-100},{x:100,y:100},{x:-100,y:100}].map(p => {
                  const x = p.x - p.y * Math.tan(lean), y = p.y;
                  return { x: 400 + x * Math.cos(tilt) - y * Math.sin(tilt) + (rnd() * 2 - 1) * 12,
                           y: 300 + x * Math.sin(tilt) + y * Math.cos(tilt) + (rnd() * 2 - 1) * 12 };
                });
                const shape = R.recognizeShape(window.__wobble(window.__poly(corners), 0.01), 1);
                const kind = shape ? shape.kind : 'ink';
                out[kind] = (out[kind] || 0) + 1;
              }
              return out;
            }"""
        )
        self.assertGreaterEqual(tally.get("square", 0), 38, tally)
        self.assertEqual(tally.get("rhombus", 0), 0, tally)
        self.assert_no_page_errors()


if __name__ == "__main__":
    unittest.main()
