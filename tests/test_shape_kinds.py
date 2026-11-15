"""New shape kinds: square, trapezium, pentagon, hexagon and octagon.

Each is a real SmartGeometry object like the rectangle or the kite - vertices,
measurements, labels, handles, the inspector - not a picture of the shape. That
means each has to keep what makes it that shape when it is edited: a square
stays square, a regular polygon stays regular, a trapezium keeps its one
parallel pair. It has to survive a save and a reload, and export to PDF as
vectors. That last one also covers a bug the smart rectangle had: PDF export
read only its first two corners as a box, so it came out zero-height.

Creation is driven through SmartGeometry and the Events API with the shape
setting assigned directly, not through the picker buttons, so these tests hold
the geometry to account independently of the picker's markup.
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


NEW_KINDS = {"square": 4, "trapezium": 4, "pentagon": 5, "hexagon": 6, "octagon": 8}

HELPERS = r"""
window.__shapes = (() => {
  const geometry = () => window.Inkyscib.SmartGeometry;
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const sides = (points) => points.map((p, i) => dist(p, points[(i + 1) % points.length]));
  const angleAt = (points, i) => {
    const n = points.length, v = points[i], a = points[(i + n - 1) % n], b = points[(i + 1) % n];
    const u = { x: a.x - v.x, y: a.y - v.y }, w = { x: b.x - v.x, y: b.y - v.y };
    return Math.atan2(Math.abs(u.x * w.y - u.y * w.x), u.x * w.x + u.y * w.y);
  };
  const cross = (a, b) => a.x * b.y - a.y * b.x;
  const direction = (a, b) => { const l = dist(a, b) || 1; return { x: (b.x - a.x) / l, y: (b.y - a.y) / l }; };

  function draw(kind) {
    const state = window.appState;
    state.paths = [];
    state.transform = { scale: 1, offsetX: 0, offsetY: 0 };
    state.notebook.active = false;
    state.ppt.active = false;
    const path = geometry().createShapePath(kind, { x: 200, y: 160 }, {
      size: 3, color: '#ffffff', snapToGrid: false, snapToObjects: false
    });
    if (!path) return null;
    geometry().updateShapeDraft(path, { x: 380, y: 320 });
    geometry().finalizeSmartShape(path);
    state.paths.push(path);
    return path;
  }

  function describe(path) {
    const points = path.points;
    const s = sides(points);
    const angles = points.map((_, i) => angleAt(points, i));
    return {
      kind: path.geometryKind,
      shapeType: path.shapeType,
      smart: geometry().isSmartGeometry(path),
      count: points.length,
      labels: path.vertexLabels,
      area: geometry().measureGeometry(path)?.area,
      sideSpread: (Math.max(...s) - Math.min(...s)) / Math.max(...s),
      angleSpreadDeg: (Math.max(...angles) - Math.min(...angles)) * 180 / Math.PI,
      rightAngleErrorDeg: Math.max(...angles.map((a) => Math.abs(a - Math.PI / 2))) * 180 / Math.PI,
      // Parallel test for a trapezium: AB against DC.
      topBottomCross: points.length === 4 ? Math.abs(cross(direction(points[0], points[1]), direction(points[3], points[2]))) : null,
      sideCross: points.length === 4 ? Math.abs(cross(direction(points[1], points[2]), direction(points[0], points[3]))) : null
    };
  }

  function drag(path, index, dx, dy) {
    const target = { x: path.points[index].x + dx, y: path.points[index].y + dy };
    const moved = geometry().updateGeometryVertex(path, index, target, null, null);
    return { moved, reached: dist(path.points[index], target) };
  }

  return { draw, describe, drag };
})();
"""


@unittest.skipUnless(PLAYWRIGHT_AVAILABLE, "Playwright is not installed")
class ShapeKindTests(unittest.TestCase):
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

    def open_page(self):
        context = self.browser.new_context(viewport={"width": 1280, "height": 800})
        self.addCleanup(context.close)
        page = context.new_page()
        page.set_default_timeout(15000)
        self.errors = []
        page.on("pageerror", lambda error: self.errors.append(str(error)))
        page.add_init_script("localStorage.setItem('inkyscib-consent-v1', JSON.stringify({version: 1, analytics: false})); localStorage.setItem('inkyscib-feature-tour-v1', 'seen')")
        page.goto(self.base_url + "/write", wait_until="domcontentloaded")
        page.wait_for_function("() => window.appState?.storageReady === true")
        page.wait_for_function("() => !!window.Inkyscib?.SmartGeometry && !!window.Inkyscib?.PdfVector")
        page.evaluate("() => {" + HELPERS + "return true; }")
        return page

    def test_every_new_kind_is_a_real_geometry_object(self):
        page = self.open_page()
        results = page.evaluate(
            """(kinds) => Object.fromEntries(kinds.map((kind) => {
                 const path = window.__shapes.draw(kind);
                 return [kind, path ? window.__shapes.describe(path) : null];
               }))""",
            list(NEW_KINDS),
        )
        for kind, count in NEW_KINDS.items():
            with self.subTest(kind=kind):
                r = results[kind]
                self.assertIsNotNone(r, f"createShapePath('{kind}') returned nothing")
                self.assertEqual((r["kind"], r["shapeType"]), (kind, kind))
                self.assertTrue(r["smart"])
                self.assertEqual(r["count"], count)
                self.assertEqual(r["labels"], [chr(65 + i) for i in range(count)])
                self.assertGreater(r["area"], 0)
        self.assertEqual(self.errors, [])

    def test_squares_and_regular_polygons_are_regular(self):
        page = self.open_page()
        results = page.evaluate(
            """() => Object.fromEntries(['square', 'pentagon', 'hexagon', 'octagon'].map((kind) =>
                 [kind, window.__shapes.describe(window.__shapes.draw(kind))]))"""
        )
        for kind, r in results.items():
            with self.subTest(kind=kind):
                self.assertLess(r["sideSpread"], 0.005, f"{kind} sides differ: {r}")
                self.assertLess(r["angleSpreadDeg"], 0.5, f"{kind} angles differ: {r}")
        self.assertLess(results["square"]["rightAngleErrorDeg"], 0.5)
        self.assertEqual(self.errors, [])

    def test_a_trapezium_has_exactly_one_parallel_pair(self):
        page = self.open_page()
        r = page.evaluate("() => window.__shapes.describe(window.__shapes.draw('trapezium'))")
        self.assertLess(r["topBottomCross"], 0.005, "AB and DC should be parallel")
        self.assertGreater(r["sideCross"], 0.05, "a trapezium is not a parallelogram")
        self.assertEqual(self.errors, [])

    def test_dragging_a_corner_keeps_the_shape_what_it_is(self):
        page = self.open_page()
        results = page.evaluate(
            """() => {
              const out = {};
              for (const kind of ['square', 'pentagon', 'hexagon', 'octagon', 'trapezium']) {
                const path = window.__shapes.draw(kind);
                const drags = [];
                for (let index = 0; index < path.points.length; index++) {
                  drags.push(window.__shapes.drag(path, index, 23, -17).moved);
                }
                out[kind] = { moved: drags, after: window.__shapes.describe(path) };
              }
              return out;
            }"""
        )
        for kind in ("square", "pentagon", "hexagon", "octagon"):
            with self.subTest(kind=kind):
                r = results[kind]
                self.assertTrue(all(r["moved"]), f"{kind} refused a vertex drag")
                self.assertLess(r["after"]["sideSpread"], 0.005, f"{kind} lost equal sides: {r['after']}")
                self.assertLess(r["after"]["angleSpreadDeg"], 0.5, f"{kind} lost equal angles: {r['after']}")
        self.assertLess(results["square"]["after"]["rightAngleErrorDeg"], 0.5)
        trapezium = results["trapezium"]
        self.assertTrue(all(trapezium["moved"]))
        self.assertLess(trapezium["after"]["topBottomCross"], 0.005, f"lost the parallel pair: {trapezium['after']}")
        self.assertEqual(self.errors, [])

    def test_new_kinds_survive_save_and_load(self):
        page = self.open_page()
        results = page.evaluate(
            """(kinds) => Object.fromEntries(kinds.map((kind) => {
                 const path = window.__shapes.draw(kind);
                 const before = path.points.map(p => ({ x: p.x, y: p.y }));
                 const loaded = window.normalizeLoadedPath(JSON.parse(JSON.stringify(window.compactPath(path))));
                 const worst = Math.max(...before.map((p, i) => Math.hypot(p.x - loaded.points[i].x, p.y - loaded.points[i].y)));
                 return [kind, { kind: loaded.geometryKind, count: loaded.points.length,
                                 smart: window.Inkyscib.SmartGeometry.isSmartGeometry(loaded), worst,
                                 labels: loaded.vertexLabels }];
               }))""",
            list(NEW_KINDS),
        )
        for kind, count in NEW_KINDS.items():
            with self.subTest(kind=kind):
                r = results[kind]
                self.assertEqual(r["kind"], kind)
                self.assertEqual(r["count"], count)
                self.assertTrue(r["smart"])
                self.assertLess(r["worst"], 0.01, "vertices must come back where they were")
                self.assertEqual(len(r["labels"]), count)
        self.assertEqual(self.errors, [])

    def test_every_smart_polygon_exports_as_vectors_with_its_real_corners(self):
        page = self.open_page()
        results = page.evaluate(
            """() => {
              const out = {};
              for (const kind of ['rectangle', 'parallelogram', 'rhombus', 'kite', 'square', 'trapezium', 'pentagon', 'hexagon', 'octagon']) {
                const path = window.__shapes.draw(kind);
                const ops = window.Inkyscib.PdfVector.pathToOperators(path);
                const text = typeof ops === 'string' ? ops : null;
                out[kind] = {
                  vector: !!text,
                  moves: text ? (text.match(/ m\\b/g) || []).length : 0,
                  lines: text ? (text.match(/ l\\b/g) || []).length : 0,
                  closed: text ? /\\bh\\b/.test(text) : false,
                  count: path.points.length,
                  height: Math.max(...path.points.map(p => p.y)) - Math.min(...path.points.map(p => p.y))
                };
              }
              return out;
            }"""
        )
        for kind, r in results.items():
            with self.subTest(kind=kind):
                self.assertTrue(r["vector"], f"{kind} fell back to raster")
                self.assertEqual(r["moves"], 1)
                self.assertEqual(r["lines"], r["count"] - 1, f"{kind} should trace every corner: {r}")
                self.assertTrue(r["closed"])
        self.assertGreater(results["rectangle"]["height"], 10, "the rectangle export must keep its height")
        self.assertEqual(self.errors, [])


if __name__ == "__main__":
    unittest.main()
