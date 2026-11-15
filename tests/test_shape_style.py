"""Shape fill and outline style, and the ellipse.

Fill (none / tint / solid) and outline (solid / dashed / dotted) come from the
Shape tool's settings, travel with each shape they create, and have to show up
three ways: in the pixels on the canvas, in a saved document, and in the PDF.

The ellipse is its own kind: a centre, two radii and a rotation, measured and
exported as curves rather than approximated by a circle.
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


HELPERS = r"""
window.__style = (() => {
  const geometry = () => window.Inkyscib.SmartGeometry;
  function make(kind, settings, from, to) {
    // Measurement labels and axes off: a label drawn inside the shape would
    // read as fill.
    const path = geometry().createShapePath(kind, from || { x: 60, y: 60 }, {
      size: 4, color: '#ff3366', snapToGrid: false, snapToObjects: false,
      showMeasurements: false, showAxes: false, ...(settings || {})
    });
    geometry().updateShapeDraft(path, to || { x: 260, y: 200 });
    geometry().finalizeSmartShape(path);
    return path;
  }
  function render(path) {
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 260;
    const ctx = canvas.getContext('2d');
    window.drawInkyscibPathForExport(ctx, path);
    return ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  }
  function alphaAt(data, x, y) { return data[(y * 320 + x) * 4 + 3]; }
  // Mean alpha over a block in the middle of the shape, away from the outline.
  function interior(data) {
    let sum = 0, n = 0;
    for (let y = 110; y < 150; y++) for (let x = 140; x < 180; x++) { sum += alphaAt(data, x, y); n++; }
    return sum / n;
  }
  // Share of the top edge that carries ink: a dashed outline has gaps.
  function edgeCoverage(data) {
    let inked = 0, n = 0;
    for (let x = 80; x < 240; x++) {
      let best = 0;
      for (let y = 55; y < 66; y++) best = Math.max(best, alphaAt(data, x, y));
      if (best > 96) inked++;
      n++;
    }
    return inked / n;
  }
  return { make, render, interior, edgeCoverage };
})();
"""


@unittest.skipUnless(PLAYWRIGHT_AVAILABLE, "Playwright is not installed")
class ShapeStyleTests(unittest.TestCase):
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

    # ---------- fill and outline ----------

    def test_fill_and_dash_travel_with_the_shape_and_change_the_pixels(self):
        page = self.open_page()
        result = page.evaluate(
            """() => {
              const S = window.__style;
              const out = {};
              for (const kind of ['rectangle', 'circle', 'hexagon']) {
                const plain = S.make(kind, { fill: 'none', dash: 'solid' });
                const tint = S.make(kind, { fill: 'tint', dash: 'solid' });
                const solid = S.make(kind, { fill: 'solid', dash: 'solid' });
                out[kind] = {
                  carried: [tint.fill, solid.fill, plain.dash],
                  none: S.interior(S.render(plain)),
                  tint: S.interior(S.render(tint)),
                  solid: S.interior(S.render(solid))
                };
              }
              const solidLine = S.make('rectangle', { dash: 'solid' });
              const dashed = S.make('rectangle', { dash: 'dashed' });
              const dotted = S.make('rectangle', { dash: 'dotted' });
              out.edges = {
                carried: [dashed.dash, dotted.dash],
                solid: S.edgeCoverage(S.render(solidLine)),
                dashed: S.edgeCoverage(S.render(dashed)),
                dotted: S.edgeCoverage(S.render(dotted))
              };
              return out;
            }"""
        )
        for kind in ("rectangle", "circle", "hexagon"):
            with self.subTest(kind=kind):
                r = result[kind]
                self.assertEqual(r["carried"], ["tint", "solid", "solid"])
                self.assertLess(r["none"], 2, f"no fill leaves the inside empty: {r}")
                self.assertTrue(20 < r["tint"] < 120, f"a tint is a light wash: {r}")
                self.assertGreater(r["solid"], 230, f"solid fills the shape: {r}")
        edges = result["edges"]
        self.assertEqual(edges["carried"], ["dashed", "dotted"])
        self.assertGreater(edges["solid"], 0.95)
        self.assertLess(edges["dashed"], edges["solid"] * 0.85, f"a dashed outline has gaps: {edges}")
        self.assertLess(edges["dotted"], edges["solid"] * 0.85, f"a dotted outline has gaps: {edges}")
        self.assertEqual(self.errors, [])

    def test_fill_and_dash_survive_save_and_load(self):
        page = self.open_page()
        result = page.evaluate(
            """() => ['rectangle', 'circle', 'octagon', 'ellipse'].map((kind) => {
                 const path = window.__style.make(kind, { fill: 'tint', dash: 'dotted' });
                 const loaded = window.normalizeLoadedPath(JSON.parse(JSON.stringify(window.compactPath(path))));
                 return { kind, fill: loaded.fill, dash: loaded.dash };
               })"""
        )
        for item in result:
            with self.subTest(kind=item["kind"]):
                self.assertEqual((item["fill"], item["dash"]), ("tint", "dotted"))
        self.assertEqual(self.errors, [])

    def test_fill_and_dash_reach_the_pdf(self):
        page = self.open_page()
        result = page.evaluate(
            """() => {
              // pdf-export.js registers transparency through `resources`; a
              // stub stands in, recording what the tint asked for.
              const asked = [];
              const resources = { alpha: (fill, stroke, blend) => { asked.push([fill, stroke, blend]); return 'GS0'; } };
              const ops = (path, withResources = resources) =>
                window.Inkyscib.PdfVector.pathToOperators(path, withResources) || '';
              const S = window.__style;
              return {
                plain: ops(S.make('rectangle', { fill: 'none', dash: 'solid' })),
                tint: ops(S.make('rectangle', { fill: 'tint' })),
                tintAsked: asked.slice(),
                tintWithoutResources: ops(S.make('rectangle', { fill: 'tint' }), null),
                solidCircle: ops(S.make('circle', { fill: 'solid' })),
                dashed: ops(S.make('hexagon', { dash: 'dashed' }))
              };
            }"""
        )
        paint = lambda text: text.strip().splitlines()[-1] if text.strip() else ""
        self.assertEqual(paint(result["plain"]), "S", "an unfilled shape is only stroked")
        self.assertEqual(paint(result["tint"]), "B", "a filled shape is filled and stroked")
        self.assertEqual(paint(result["solidCircle"]), "B")
        self.assertRegex(result["tint"], r"\brg\b", "the fill colour is set")
        self.assertIn("/GS0 gs", result["tint"], "the tint's transparency is applied")
        self.assertEqual(result["tintAsked"], [[0.22, 1, None]], "a faint fill under a full-strength outline")
        self.assertEqual(result["tintWithoutResources"], "", "no transparency, no vector: fall back rather than draw it solid")
        self.assertRegex(result["dashed"], r"\[[\d. ]+\] 0 d", "a dashed outline sets a dash array")
        self.assertNotRegex(result["plain"], r"\] 0 d", "a solid outline sets none")
        self.assertEqual(self.errors, [])

    # ---------- the ellipse ----------

    def test_an_ellipse_is_a_real_object_with_two_radii(self):
        page = self.open_page()
        result = page.evaluate(
            """() => {
              const geometry = window.Inkyscib.SmartGeometry;
              const path = window.__style.make('ellipse', {}, { x: 100, y: 100 }, { x: 340, y: 260 });
              const metrics = geometry.measureGeometry(path);
              const outline = window.Inkyscib.Geometry.shapeDisplayPoints(path);
              const unit = path.unitScale;
              const typed = geometry.setGeometryDimension(path, 'radiusX', 3.5);
              return {
                kind: path.geometryKind, shapeType: path.shapeType, smart: geometry.isSmartGeometry(path),
                radiusX: metrics.radiusX * unit, radiusY: metrics.radiusY * unit, area: metrics.area,
                expectedArea: Math.PI * metrics.radiusX * metrics.radiusY,
                outline: outline.length,
                typed, typedRadiusX: geometry.measureGeometry(path).radiusX,
                title: (geometry.syncInspector && (window.setTool('select'), window.appState.paths = [path],
                        window.Inkyscib.Selection.selectIndex(0), geometry.syncInspector(true),
                        document.getElementById('geometryInspectorTitle').textContent))
              };
            }"""
        )
        self.assertEqual((result["kind"], result["shapeType"]), ("ellipse", "ellipse"))
        self.assertTrue(result["smart"])
        self.assertAlmostEqual(result["radiusX"], 120, delta=1)
        self.assertAlmostEqual(result["radiusY"], 80, delta=1)
        self.assertAlmostEqual(result["area"], result["expectedArea"], places=6)
        self.assertGreaterEqual(result["outline"], 24, "the outline is traced, not a box")
        self.assertTrue(result["typed"])
        self.assertAlmostEqual(result["typedRadiusX"], 3.5, places=6)
        self.assertEqual(result["title"], "Ellipse")
        self.assertEqual(self.errors, [])

    def test_an_ellipse_survives_save_and_exports_as_curves(self):
        page = self.open_page()
        result = page.evaluate(
            """() => {
              const geometry = window.Inkyscib.SmartGeometry;
              const path = window.__style.make('ellipse', {}, { x: 100, y: 100 }, { x: 340, y: 260 });
              geometry.setGeometryRotation(path, 0.4 * 180 / Math.PI);
              const loaded = window.normalizeLoadedPath(JSON.parse(JSON.stringify(window.compactPath(path))));
              const ops = window.Inkyscib.PdfVector.pathToOperators(loaded) || '';
              const frame = (p) => { const f = geometry.ellipseFrame(p); return [f.radiusX, f.radiusY, f.rotation]; };
              return {
                kind: loaded.geometryKind, smart: geometry.isSmartGeometry(loaded),
                radii: frame(loaded),
                original: frame(path),
                curves: (ops.match(/ c\\b/g) || []).length
              };
            }"""
        )
        self.assertEqual(result["kind"], "ellipse")
        self.assertTrue(result["smart"])
        for got, want in zip(result["radii"], result["original"]):
            self.assertAlmostEqual(got, want, places=4)
        self.assertEqual(result["curves"], 4, "an ellipse exports as four Bezier arcs")
        self.assertAlmostEqual(result["original"][2], 0.4, places=6, msg="rotation is read back from the axes")
        self.assertEqual(self.errors, [])

    def test_dragging_an_axis_end_changes_only_that_radius(self):
        page = self.open_page()
        result = page.evaluate(
            """() => {
              const geometry = window.Inkyscib.SmartGeometry;
              const path = window.__style.make('ellipse', {}, { x: 100, y: 100 }, { x: 340, y: 260 });
              geometry.setGeometryRotation(path, 30);
              const before = geometry.ellipseFrame(path);
              const end = path.points[0];
              const moved = geometry.updateGeometryVertex(path, 0, { x: end.x + 20 * Math.cos(before.rotation), y: end.y + 20 * Math.sin(before.rotation) }, null, null);
              const after = geometry.ellipseFrame(path);
              return { moved, before: [before.radiusX, before.radiusY, before.rotation, before.center.x, before.center.y],
                       after: [after.radiusX, after.radiusY, after.rotation, after.center.x, after.center.y] };
            }"""
        )
        self.assertTrue(result["moved"])
        before, after = result["before"], result["after"]
        self.assertAlmostEqual(after[0], before[0] + 20, delta=0.01)
        for index in (1, 2, 3, 4):
            self.assertAlmostEqual(after[index], before[index], places=6)
        self.assertEqual(self.errors, [])

    # ---------- the inspector ----------

    def test_the_inspector_restyles_a_selected_shape_and_undo_restores_it(self):
        page = self.open_page()
        page.evaluate(
            """() => {
              const state = window.appState;
              state.transform = { scale: 1, offsetX: 0, offsetY: 0 };
              state.paths = [window.__style.make('pentagon', {}, { x: 200, y: 160 }, { x: 380, y: 320 })];
              window.setTool('select');
              window.Inkyscib.Selection.selectIndex(0);
              window.Inkyscib.SmartGeometry.syncInspector(true);
            }"""
        )
        page.wait_for_function("() => !document.getElementById('geometryInspector').hidden")
        page.select_option("#geometryFillInput", "solid")
        page.select_option("#geometryDashInput", "dotted")
        styled = page.evaluate("() => [window.appState.paths[0].fill, window.appState.paths[0].dash]")
        page.evaluate("() => window.undo()")
        undone = page.evaluate("() => [window.appState.paths[0].fill, window.appState.paths[0].dash]")
        self.assertEqual(styled, ["solid", "dotted"])
        self.assertEqual(undone, ["solid", "solid"], "one undo takes back the last change only")
        self.assertEqual(self.errors, [])


if __name__ == "__main__":
    unittest.main()
