"""Circle construction and angle measurement, tuned for a finger.

From the LLM council review (2026-11-18), whose five advisors agreed that the
compass and the angle tool were tuned for a mouse on a product meant for a
budget tablet. Pinned here, one test per fix:

- hit targets and the tap-or-drag threshold scale with pointerType;
- the angle tool marks the corner you tapped, not the far ends of the lines;
- three taps (arm, corner, arm) measure an angle anywhere, even on empty
  canvas, which is what an angle on pen ink or an imported PDF needs;
- a mark flips to its reflex, so 110 can be read as 250 and back;
- a constructed 60 reads 60, not 59.9;
- the reading stays on screen after it is taken;
- in circle mode the radius drag draws the circle, and one Undo removes it;
- pressing on an older arc and dragging starts a new arc, not the old one.
"""

import math
import threading
import unittest

from app import app
from browser_server import make_browser_server

try:
    from playwright.sync_api import sync_playwright

    PLAYWRIGHT_AVAILABLE = True
except ImportError:  # pragma: no cover - optional dependency
    PLAYWRIGHT_AVAILABLE = False


HELPERS = """
window.__t = (() => {
  const c = document.getElementById('drawingCanvas').getBoundingClientRect();
  const ev = (x, y, pointerType = 'touch') => ({ clientX: c.left + x, clientY: c.top + y, pointerType, button: 0 });
  const E = window.Inkyscib.GeometryEngine;
  const deg = (m) => E.arcSweep(m.startAngle, m.endAngle) * 180 / Math.PI;
  const marks = () => window.appState.paths.filter((p) => p.geomType === 'angle');
  const fresh = (paths) => {
    const s = window.appState;
    s.transform = { scale: 1, offsetX: 0, offsetY: 0 };
    s.paths = paths || [];
    s.undoStack = [];
    s.redoStack = [];
    window.Inkyscib.Construction.rebuildIndex(true);
  };
  return { ev, deg, marks, fresh };
})();
"""

CROSS = """[
  {tool: 'line', points: [{x: 200, y: 300}, {x: 500, y: 300}], size: 2, lineKind: 'segment'},
  {tool: 'line', points: [{x: 350, y: 150}, {x: 350, y: 450}], size: 2, lineKind: 'segment'}
]"""


@unittest.skipUnless(PLAYWRIGHT_AVAILABLE, "Playwright is not installed")
class TouchGeometryTests(unittest.TestCase):
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

    def setUp(self):
        context = self.browser.new_context(viewport={"width": 1280, "height": 860})
        self.addCleanup(context.close)
        context.add_init_script("localStorage.setItem('inkyscib-feature-tour-v1', 'seen')")
        self.page = context.new_page()
        self.errors = []
        self.page.on("pageerror", lambda error: self.errors.append(str(error)))
        self.page.goto(self.base_url + "/write", wait_until="domcontentloaded")
        self.page.wait_for_function("() => window.appState?.storageReady === true && !!window.Inkyscib?.AngleTool")
        self.page.evaluate("() => {" + HELPERS + "}")

    def run_js(self, body):
        return self.page.evaluate("async () => { const { ev, deg, marks, fresh } = window.__t; " + body + " }")

    # ---------- input sizing ----------

    def test_targets_and_the_tap_threshold_grow_for_a_finger(self):
        sizes = self.run_js("""
          const E = window.Inkyscib.GeometryEngine;
          return { mouse: E.hitScreenPx(10, { pointerType: 'mouse' }), pen: E.hitScreenPx(10, { pointerType: 'pen' }),
                   touch: E.hitScreenPx(10, { pointerType: 'touch' }),
                   slop: [E.dragSlopPx({ pointerType: 'mouse' }), E.dragSlopPx({ pointerType: 'pen' }), E.dragSlopPx({ pointerType: 'touch' })] };
        """)
        self.assertEqual(sizes["mouse"], 10)
        self.assertAlmostEqual(sizes["pen"], 13)
        self.assertAlmostEqual(sizes["touch"], 18)
        self.assertEqual(sizes["slop"], [4, 6, 10])

    # ---------- angles ----------

    def test_the_mark_lands_on_the_corner_you_tapped(self):
        result = self.run_js(f"""
          fresh({CROSS});
          window.setTool('angle');
          const A = window.Inkyscib.AngleTool;
          const corner = (m) => {{ const a = m.startAngle + window.Inkyscib.GeometryEngine.arcSweep(m.startAngle, m.endAngle) / 2;
                                    return [Math.sign(Math.round(Math.cos(a) * 10)), Math.sign(Math.round(Math.sin(a) * 10))]; }};
          A.handleDown(ev(450, 300)); A.handleDown(ev(350, 200));
          const upperRight = corner(marks().at(-1));
          A.handleDown(ev(260, 300)); A.handleDown(ev(350, 420));
          const lowerLeft = corner(marks().at(-1));
          return {{ upperRight, lowerLeft, status: document.getElementById('angleStatus').textContent }};
        """)
        self.assertEqual(result["upperRight"], [1, -1])
        self.assertEqual(result["lowerLeft"], [-1, 1])
        self.assertIn("Measured 90°", result["status"], "the reading stays on screen")
        self.assertEqual(self.errors, [])

    def test_three_taps_measure_an_angle_on_empty_canvas(self):
        result = self.run_js("""
          fresh([]);
          window.setTool('angle');
          const A = window.Inkyscib.AngleTool;
          A.handleDown(ev(700, 300));          // one arm, on nothing at all
          A.handleDown(ev(400, 300));          // the corner
          A.handleMove(ev(400 + 300 * Math.cos(Math.PI / 3), 300 - 300 * Math.sin(Math.PI / 3)));
          const live = A.getOverlayState().preview?.text;
          A.handleDown(ev(400 + 300 * Math.cos(Math.PI / 3), 300 - 300 * Math.sin(Math.PI / 3)));
          return { live, degrees: deg(marks().at(-1)), count: marks().length, label: A.degreesText(deg(marks().at(-1)) * Math.PI / 180) };
        """)
        self.assertEqual(result["count"], 1)
        self.assertAlmostEqual(result["degrees"], 60, delta=0.3)
        self.assertEqual(result["live"], "60°", "the reading follows the pointer before the last tap")
        self.assertEqual(result["label"], "60°")

    def test_a_mark_flips_to_its_reflex_and_back(self):
        result = self.run_js(f"""
          fresh({CROSS});
          window.setTool('angle');
          const A = window.Inkyscib.AngleTool;
          A.handleDown(ev(450, 300)); A.handleDown(ev(350, 200));
          A.handleDown(ev(370, 282));
          const flipped = deg(marks().at(-1));
          const undoSteps = window.appState.undoStack.length;
          A.handleDown(ev(335, 315));  // inside the reflex side of the mark
          const back = deg(marks().at(-1));
          return {{ flipped, back, undoSteps, count: marks().length }};
        """)
        self.assertAlmostEqual(result["flipped"], 270, delta=0.5)
        self.assertAlmostEqual(result["back"], 90, delta=0.5)
        self.assertEqual(result["count"], 1)
        self.assertEqual(result["undoSteps"], 2, "placing and flipping are one undo step each")

    def test_float_noise_reads_as_the_whole_degree(self):
        labels = self.run_js("""
          const A = window.Inkyscib.AngleTool;
          return [59.97, 60.04, 47.3, 89.96].map((d) => A.degreesText(d * Math.PI / 180));
        """)
        self.assertEqual(labels, ["60°", "60°", "47.3°", "90°"])

    # ---------- the compass ----------

    def test_in_circle_mode_the_radius_drag_draws_the_circle(self):
        result = self.run_js("""
          fresh([]);
          window.setTool('compass');
          const K = window.Inkyscib.Compass;
          K.reset();
          K.setMode('circle');
          K.handleDown(ev(400, 300)); K.handleUp(ev(400, 300));
          K.handleDown(ev(400, 300)); K.handleMove(ev(450, 300));
          const readout = K.getOverlayState().preview?.radiusText || '';
          K.handleMove(ev(520, 300)); K.handleUp(ev(520, 300));
          const circles = () => window.appState.paths.filter((p) => p.full === true);
          const drawn = circles().map((p) => Math.round(p.radius));
          window.undo();
          return { drawn, readout, afterUndo: circles().length };
        """)
        self.assertEqual(result["drawn"], [120])
        self.assertRegex(result["readout"], r"^\d+\.\d\d ")
        self.assertEqual(result["afterUndo"], 0, "one Undo removes the circle")

    def test_pressing_on_an_older_arc_and_dragging_draws_a_new_arc(self):
        result = self.run_js("""
          fresh([]);
          window.setTool('compass');
          const K = window.Inkyscib.Compass;
          K.reset();
          K.setMode('arc');
          const arcs = () => window.appState.paths.filter((p) => p.geomType === 'arc');
          K.handleDown(ev(400, 300)); K.handleUp(ev(400, 300));
          K.handleDown(ev(400, 300)); K.handleMove(ev(500, 300)); K.handleUp(ev(500, 300));
          // arc one, below the centre
          K.handleDown(ev(500, 300)); K.handleMove(ev(471, 371)); K.handleMove(ev(400, 400)); K.handleUp(ev(400, 400));
          // arc two, above, so arc one is no longer the one in hand
          K.handleDown(ev(400, 200)); K.handleMove(ev(471, 229)); K.handleMove(ev(500, 300)); K.handleUp(ev(500, 300));
          const before = arcs().length;
          // press on arc one's body and drag away: a new arc, not arc one picked up
          K.handleDown(ev(436, 393)); K.handleMove(ev(370, 395)); K.handleMove(ev(310, 340)); K.handleUp(ev(310, 340));
          return { before, after: arcs().length, phase: K.compassState.phase };
        """)
        self.assertEqual(result["before"], 2)
        self.assertEqual(result["after"], 3)
        self.assertEqual(result["phase"], "READY")

    def test_a_small_finger_wobble_is_still_a_tap(self):
        result = self.run_js("""
          fresh([]);
          window.setTool('compass');
          const K = window.Inkyscib.Compass;
          K.reset();
          K.setMode('arc');
          K.handleDown(ev(400, 300)); K.handleUp(ev(400, 300));
          K.handleDown(ev(400, 300)); K.handleMove(ev(500, 300)); K.handleUp(ev(500, 300));
          // a 7px wobble while tapping the arc's start: a tap for a finger
          K.handleDown(ev(500, 300, 'touch')); K.handleMove(ev(505, 305, 'touch')); K.handleUp(ev(505, 305, 'touch'));
          return { tapSweep: K.compassState.tapSweep, arcs: window.appState.paths.filter((p) => p.geomType === 'arc').length };
        """)
        self.assertTrue(result["tapSweep"], "the wobble arms a tap-to-tap sweep instead of committing a sliver")
        self.assertEqual(result["arcs"], 0)

    def test_holding_on_an_older_arc_picks_it_up_and_the_drag_carries_on(self):
        """reopenArc used to throw (construction and engine were not in scope),
        so picking an arc back up had never worked."""
        result = self.run_js("""
          fresh([]);
          window.setTool('compass');
          const K = window.Inkyscib.Compass;
          K.reset();
          K.setMode('arc');
          const arcs = () => window.appState.paths.filter((p) => p.geomType === 'arc');
          K.handleDown(ev(400, 300)); K.handleUp(ev(400, 300));
          K.handleDown(ev(400, 300)); K.handleMove(ev(500, 300)); K.handleUp(ev(500, 300));
          K.handleDown(ev(500, 300)); K.handleMove(ev(471, 371)); K.handleMove(ev(400, 400)); K.handleUp(ev(400, 400));
          const first = arcs()[0].gid;
          // a second arc around a new centre, with a different radius
          K.reset();
          K.handleDown(ev(800, 300)); K.handleUp(ev(800, 300));
          K.handleDown(ev(800, 300)); K.handleMove(ev(860, 300)); K.handleUp(ev(860, 300));
          K.handleDown(ev(860, 300)); K.handleMove(ev(842, 342)); K.handleMove(ev(800, 360)); K.handleUp(ev(800, 360));
          // hold still on the first arc's body
          K.handleDown(ev(436, 393));
          await new Promise((r) => setTimeout(r, 600));
          const held = { phase: K.compassState.phase, radius: Math.round(K.compassState.radius), last: K.compassState.lastArcGid === first };
          K.handleMove(ev(370, 395)); K.handleMove(ev(310, 340)); K.handleUp(ev(310, 340));
          return { held, count: arcs().length, newRadius: Math.round(arcs().at(-1).radius) };
        """)
        self.assertEqual(result["held"], {"phase": "SWEEPING", "radius": 100, "last": True})
        self.assertEqual(result["count"], 3)
        self.assertEqual(result["newRadius"], 100, "the carried-on arc uses the picked-up arc's radius")
        self.assertEqual(self.errors, [])

    def test_a_point_inside_a_mark_starts_a_new_angle_instead_of_flipping(self):
        result = self.run_js("""
          fresh([
            {tool: 'construction', geomType: 'point', gid: 'pA', label: 'A', points: [{x: 300, y: 400}], isConstruction: true},
            {tool: 'construction', geomType: 'point', gid: 'pB', label: 'B', points: [{x: 600, y: 400}], isConstruction: true},
            {tool: 'construction', geomType: 'point', gid: 'pC', label: 'C', points: [{x: 450, y: 140}], isConstruction: true}
          ]);
          window.setTool('angle');
          const A = window.Inkyscib.AngleTool;
          // angle A first: B, A, C
          A.handleDown(ev(600, 400)); A.handleDown(ev(300, 400)); A.handleDown(ev(450, 140));
          const markA = deg(marks()[0]);
          // now angle B: A (inside A's mark), B, C
          A.handleDown(ev(301, 399)); A.handleDown(ev(600, 400)); A.handleDown(ev(450, 140));
          return { markA, markAAfter: deg(marks()[0]), count: marks().length, markB: deg(marks().at(-1)) };
        """)
        self.assertAlmostEqual(result["markA"], 60, delta=0.5)
        self.assertAlmostEqual(result["markAAfter"], 60, delta=0.5, msg="angle A was not flipped")
        self.assertEqual(result["count"], 2)
        self.assertAlmostEqual(result["markB"], 60, delta=0.5)


if __name__ == "__main__":
    unittest.main()
