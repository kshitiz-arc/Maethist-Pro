import threading
import unittest

from app import app
from browser_server import make_browser_server


try:
    from playwright.sync_api import sync_playwright

    PLAYWRIGHT_AVAILABLE = True
except ImportError:
    PLAYWRIGHT_AVAILABLE = False


@unittest.skipUnless(PLAYWRIGHT_AVAILABLE, "Playwright is not installed")
class AlgebraTileBrowserTests(unittest.TestCase):
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
        context = self.browser.new_context(viewport={"width": 1280, "height": 820})
        self.addCleanup(context.close)
        page = context.new_page()
        self.errors = []
        page.on("pageerror", lambda error: self.errors.append(str(error)))
        page.goto(self.base_url + "/write", wait_until="domcontentloaded")
        page.wait_for_function("() => window.appState?.storageReady === true")
        page.evaluate(
            """
            () => {
              const state = window.appState;
              state.paths = [];
              state.manipulativeVariables = {};
              state.transform = { scale: 1, offsetX: 0, offsetY: 0 };
              state.notebook.active = false;
              state.ppt.active = false;
            }
            """
        )
        return page

    # ------------------------------------------------------------- expression

    def test_expression_engine_parses_evaluates_and_classifies(self):
        page = self.open_page()
        result = page.evaluate(
            """
            () => {
              const expr = window.Inkyscib.ManipulativeExpr;
              const registry = { x: 3, y: 1.2, z: 4 };
              return {
                simple: expr.evaluate('x-y', registry).value,
                chain: expr.evaluate('z-y+z', registry).value,
                parens: expr.evaluate('2*(x-y)', registry).value,
                unary: expr.evaluate('-x+z', registry).value,
                unicodeMinus: expr.evaluate('x − y', registry).value,
                missing: expr.evaluate('x-q', registry).error,
                broken: expr.evaluate('x-', registry).error,
                dependencies: [...expr.dependenciesOf('z-y+z')].sort(),
                kinds: ['', '2.5', 'x', 'x-y', 'x+'].map((item) => expr.classify(item).kind),
                cycles: [...expr.findCycles({ a: ['b'], b: ['a'], c: [] })].sort()
              };
            }
            """
        )
        self.assertAlmostEqual(result["simple"], 1.8, places=6)
        self.assertAlmostEqual(result["chain"], 6.8, places=6)
        self.assertAlmostEqual(result["parens"], 3.6, places=6)
        self.assertAlmostEqual(result["unary"], 1.0, places=6)
        self.assertAlmostEqual(result["unicodeMinus"], 1.8, places=6)
        self.assertIn("q", result["missing"])
        self.assertTrue(result["broken"])
        self.assertEqual(result["dependencies"], ["y", "z"])
        self.assertEqual(result["kinds"], ["empty", "number", "variable", "expression", "error"])
        self.assertEqual(result["cycles"], ["a", "b"])
        self.assertEqual(self.errors, [])

    # ------------------------------------------------------------- placement

    def test_placing_a_tile_selects_it_and_opens_the_inspector(self):
        page = self.open_page()
        result = page.evaluate(
            """
            () => {
              const canvas = document.getElementById('drawingCanvas');
              const rect = canvas.getBoundingClientRect();
              window.Inkyscib.ManipulativeTool.placeTile(rect.left + 300, rect.top + 300, 'x');
              const path = window.appState.paths[0];
              window.render();
              return {
                count: window.appState.paths.length,
                tool: path.tool,
                widthLabel: path.widthLabel,
                heightLabel: path.heightLabel,
                widthUnits: window.Inkyscib.Manipulatives.dimensionUnits(path, 'width'),
                heightUnits: window.Inkyscib.Manipulatives.dimensionUnits(path, 'height'),
                currentTool: window.appState.currentTool,
                selectedIndex: window.appState.selection.selectedIndex,
                inspectorVisible: !document.getElementById('manipulativeInspector').hidden,
                title: document.getElementById('manipulativeInspectorTitle').textContent
              };
            }
            """
        )
        self.assertEqual(result["count"], 1)
        self.assertEqual(result["tool"], "manipulative")
        self.assertEqual(result["widthLabel"], "x")
        self.assertEqual(result["heightLabel"], "1")
        self.assertAlmostEqual(result["widthUnits"], 3.0, places=4)
        self.assertAlmostEqual(result["heightUnits"], 1.0, places=4)
        self.assertEqual(result["currentTool"], "select")
        self.assertEqual(result["selectedIndex"], 0)
        self.assertTrue(result["inspectorVisible"])
        self.assertIn("x", result["title"])
        self.assertEqual(self.errors, [])

    def test_tiles_sharing_a_label_share_a_length(self):
        page = self.open_page()
        result = page.evaluate(
            """
            () => {
              const canvas = document.getElementById('drawingCanvas');
              const rect = canvas.getBoundingClientRect();
              const tool = window.Inkyscib.ManipulativeTool;
              const api = window.Inkyscib.Manipulatives;
              tool.placeTile(rect.left + 200, rect.top + 200, 'x');
              tool.placeTile(rect.left + 200, rect.top + 400, 'x');
              const before = window.appState.paths.map((p) => api.dimensionUnits(p, 'width'));
              api.setVariable('x', 5.5);
              const after = window.appState.paths.map((p) => api.dimensionUnits(p, 'width'));
              return { before, after, registry: window.appState.manipulativeVariables.x };
            }
            """
        )
        self.assertEqual([round(value, 4) for value in result["before"]], [3.0, 3.0])
        self.assertEqual([round(value, 4) for value in result["after"]], [5.5, 5.5])
        self.assertAlmostEqual(result["registry"], 5.5, places=4)
        self.assertEqual(self.errors, [])

    def test_dragging_a_bound_handle_updates_every_matching_tile(self):
        page = self.open_page()
        result = page.evaluate(
            """
            () => {
              const canvas = document.getElementById('drawingCanvas');
              const rect = canvas.getBoundingClientRect();
              const tool = window.Inkyscib.ManipulativeTool;
              const api = window.Inkyscib.Manipulatives;
              const selection = window.Inkyscib.Selection;
              tool.placeTile(rect.left + 200, rect.top + 200, 'x');
              tool.placeTile(rect.left + 200, rect.top + 420, 'x');

              window.setTool('select');
              selection.selectIndex(0);
              const first = window.appState.paths[0];
              const box = api.tileRect(first);
              const clientAt = (x, y) => ({
                clientX: rect.left + x * rect.width / canvas.width,
                clientY: rect.top + y * rect.height / canvas.height,
                pointerType: 'mouse'
              });

              selection.handleDown(clientAt(box.right, box.cy));
              selection.handleMove(clientAt(box.left + api.tileRect(first).width * 2, box.cy));
              selection.handleUp(clientAt(box.left + api.tileRect(first).width * 2, box.cy));

              return {
                widths: window.appState.paths.map((p) => api.dimensionUnits(p, 'width')),
                registry: window.appState.manipulativeVariables.x
              };
            }
            """
        )
        self.assertAlmostEqual(result["widths"][0], 6.0, places=4)
        self.assertAlmostEqual(result["widths"][1], 6.0, places=4)
        self.assertAlmostEqual(result["registry"], 6.0, places=4)
        self.assertEqual(self.errors, [])

    # ------------------------------------------------------------ expressions

    def test_derived_tile_recomputes_and_clamps_when_negative(self):
        page = self.open_page()
        result = page.evaluate(
            """
            () => {
              const canvas = document.getElementById('drawingCanvas');
              const rect = canvas.getBoundingClientRect();
              const tool = window.Inkyscib.ManipulativeTool;
              const api = window.Inkyscib.Manipulatives;
              tool.placeTile(rect.left + 200, rect.top + 180, 'x');
              tool.placeTile(rect.left + 200, rect.top + 300, 'y');
              tool.placeTile(rect.left + 200, rect.top + 420, 'diff');
              const derived = window.appState.paths[2];

              api.setVariable('x', 4);
              api.setVariable('y', 1.5);
              const healthy = {
                width: api.dimensionUnits(derived, 'width'),
                locked: derived.locked.width,
                invalid: derived.invalid.width
              };

              api.setVariable('y', 9);
              const clamped = {
                width: api.dimensionUnits(derived, 'width'),
                invalid: derived.invalid.width,
                raw: derived.detail.width.raw
              };
              return { healthy, clamped, minUnits: api.MIN_UNITS };
            }
            """
        )
        self.assertAlmostEqual(result["healthy"]["width"], 2.5, places=4)
        self.assertTrue(result["healthy"]["locked"])
        self.assertFalse(result["healthy"]["invalid"])
        self.assertAlmostEqual(result["clamped"]["width"], result["minUnits"], places=4)
        self.assertTrue(result["clamped"]["invalid"])
        self.assertAlmostEqual(result["clamped"]["raw"], -5.0, places=4)
        self.assertEqual(self.errors, [])

    def test_deleting_the_defining_tile_freezes_dependents_and_warns(self):
        page = self.open_page()
        result = page.evaluate(
            """
            () => {
              const canvas = document.getElementById('drawingCanvas');
              const rect = canvas.getBoundingClientRect();
              const tool = window.Inkyscib.ManipulativeTool;
              const api = window.Inkyscib.Manipulatives;
              tool.placeTile(rect.left + 200, rect.top + 180, 'x');
              tool.placeTile(rect.left + 200, rect.top + 300, 'y');
              tool.placeTile(rect.left + 200, rect.top + 420, 'diff');
              api.setVariable('x', 5);
              api.setVariable('y', 2);
              const derived = window.appState.paths[2];
              const before = api.dimensionUnits(derived, 'width');

              // Remove the tile labelled "y" entirely.
              window.appState.paths.splice(1, 1);
              api.rebuildRegistryFromPaths();

              return {
                before,
                after: api.dimensionUnits(window.appState.paths[1], 'width'),
                orphan: window.appState.paths[1].detail.width.orphan,
                variables: window.Inkyscib.Manipulatives.variableList()
              };
            }
            """
        )
        self.assertAlmostEqual(result["before"], 3.0, places=4)
        self.assertAlmostEqual(result["after"], 3.0, places=4)
        self.assertTrue(result["orphan"])
        orphaned = [item for item in result["variables"] if item["name"] == "y"]
        self.assertEqual(len(orphaned), 1)
        self.assertFalse(orphaned[0]["hasSource"])
        self.assertEqual(self.errors, [])

    # ------------------------------------------------------------ persistence

    def test_tiles_and_registry_survive_a_reload(self):
        page = self.open_page()
        page.evaluate(
            """
            async () => {
              const canvas = document.getElementById('drawingCanvas');
              const rect = canvas.getBoundingClientRect();
              const tool = window.Inkyscib.ManipulativeTool;
              const api = window.Inkyscib.Manipulatives;
              tool.placeTile(rect.left + 240, rect.top + 200, 'x');
              tool.placeTile(rect.left + 240, rect.top + 360, 'diff');
              api.setVariable('x', 4.75);
              api.setVariable('y', 1.25);
              await window.saveDrawing({ force: true });
            }
            """
        )
        page.reload(wait_until="domcontentloaded")
        page.wait_for_function("() => window.appState?.storageReady === true")
        result = page.evaluate(
            """
            () => {
              const api = window.Inkyscib.Manipulatives;
              const tiles = window.appState.paths.filter(api.isTile);
              window.render();
              return {
                count: tiles.length,
                labels: tiles.map((p) => [p.widthLabel, p.heightLabel]),
                widths: tiles.map((p) => api.dimensionUnits(p, 'width')),
                registry: window.appState.manipulativeVariables
              };
            }
            """
        )
        self.assertEqual(result["count"], 2)
        self.assertEqual(result["labels"], [["x", "1"], ["x-y", "1"]])
        self.assertAlmostEqual(result["widths"][0], 4.75, places=3)
        self.assertAlmostEqual(result["widths"][1], 3.5, places=3)
        self.assertAlmostEqual(result["registry"]["x"], 4.75, places=3)
        self.assertAlmostEqual(result["registry"]["y"], 1.25, places=3)
        self.assertEqual(self.errors, [])

    def test_label_edits_from_the_inspector_resize_the_tile(self):
        page = self.open_page()
        page.evaluate(
            """
            () => {
              const canvas = document.getElementById('drawingCanvas');
              const rect = canvas.getBoundingClientRect();
              window.Inkyscib.ManipulativeTool.placeTile(rect.left + 300, rect.top + 300, 'free');
              window.render();
            }
            """
        )
        page.fill("#manipulativeWidthLabel", "x+2")
        page.dispatch_event("#manipulativeWidthLabel", "change")
        result = page.evaluate(
            """
            () => {
              const api = window.Inkyscib.Manipulatives;
              const path = window.appState.paths[0];
              return {
                widthLabel: path.widthLabel,
                widthUnits: api.dimensionUnits(path, 'width'),
                locked: path.locked.width,
                status: document.getElementById('manipulativeWidthStatus').textContent
              };
            }
            """
        )
        self.assertEqual(result["widthLabel"], "x+2")
        self.assertAlmostEqual(result["widthUnits"], 5.0, places=4)
        self.assertTrue(result["locked"])
        self.assertTrue(result["status"])
        self.assertEqual(self.errors, [])

    def test_typing_an_exact_width_drives_the_right_thing_per_label_kind(self):
        page = self.open_page()
        page.evaluate(
            """
            () => {
              const canvas = document.getElementById('drawingCanvas');
              const rect = canvas.getBoundingClientRect();
              const tool = window.Inkyscib.ManipulativeTool;
              tool.placeTile(rect.left + 220, rect.top + 180, 'x');
              tool.placeTile(rect.left + 220, rect.top + 300, 'x');
              tool.placeTile(rect.left + 220, rect.top + 420, 'free');
              window.setTool('select');
              window.Inkyscib.Selection.selectIndex(0);
              window.render();
            }
            """
        )

        # A bound dimension writes through to the shared variable.
        page.fill("#manipulativeWidthValue", "5.75")
        page.dispatch_event("#manipulativeWidthValue", "change")
        bound = page.evaluate(
            """
            () => {
              const api = window.Inkyscib.Manipulatives;
              return {
                widths: window.appState.paths.slice(0, 2).map((p) => api.dimensionUnits(p, 'width')),
                registry: window.appState.manipulativeVariables.x
              };
            }
            """
        )
        self.assertAlmostEqual(bound["widths"][0], 5.75, places=4)
        self.assertAlmostEqual(bound["widths"][1], 5.75, places=4)
        self.assertAlmostEqual(bound["registry"], 5.75, places=4)

        # A literal dimension rewrites the label itself.
        page.fill("#manipulativeHeightValue", "3")
        page.dispatch_event("#manipulativeHeightValue", "change")
        literal = page.evaluate(
            """
            () => {
              const api = window.Inkyscib.Manipulatives;
              const path = window.appState.paths[0];
              return {
                label: path.heightLabel,
                height: api.dimensionUnits(path, 'height'),
                otherHeight: api.dimensionUnits(window.appState.paths[1], 'height')
              };
            }
            """
        )
        self.assertEqual(literal["label"], "3")
        self.assertAlmostEqual(literal["height"], 3.0, places=4)
        self.assertAlmostEqual(literal["otherHeight"], 1.0, places=4)

        # A free dimension just resizes its own tile.
        page.evaluate("() => { window.Inkyscib.Selection.selectIndex(2); window.render(); }")
        page.fill("#manipulativeWidthValue", "4.375")
        page.dispatch_event("#manipulativeWidthValue", "change")
        free = page.evaluate(
            """
            () => {
              const api = window.Inkyscib.Manipulatives;
              const path = window.appState.paths[2];
              return { label: path.widthLabel, width: api.dimensionUnits(path, 'width') };
            }
            """
        )
        self.assertEqual(free["label"], "")
        self.assertAlmostEqual(free["width"], 4.375, places=4)
        self.assertEqual(self.errors, [])

    def test_derived_dimension_input_is_disabled(self):
        page = self.open_page()
        page.evaluate(
            """
            () => {
              const canvas = document.getElementById('drawingCanvas');
              const rect = canvas.getBoundingClientRect();
              const tool = window.Inkyscib.ManipulativeTool;
              tool.placeTile(rect.left + 220, rect.top + 200, 'x');
              tool.placeTile(rect.left + 220, rect.top + 320, 'y');
              tool.placeTile(rect.left + 220, rect.top + 440, 'diff');
              window.setTool('select');
              window.Inkyscib.Selection.selectIndex(2);
              window.render();
            }
            """
        )
        result = page.evaluate(
            """
            () => ({
              widthDisabled: document.getElementById('manipulativeWidthValue').disabled,
              heightDisabled: document.getElementById('manipulativeHeightValue').disabled,
              size: document.getElementById('manipulativeMeasureSize').textContent
            })
            """
        )
        self.assertTrue(result["widthDisabled"])
        self.assertFalse(result["heightDisabled"])
        self.assertIn("×", result["size"])
        self.assertEqual(self.errors, [])

    def test_undo_restores_both_the_tiles_and_their_variable(self):
        page = self.open_page()
        result = page.evaluate(
            """
            () => {
              const canvas = document.getElementById('drawingCanvas');
              const rect = canvas.getBoundingClientRect();
              const tool = window.Inkyscib.ManipulativeTool;
              const api = window.Inkyscib.Manipulatives;
              const selection = window.Inkyscib.Selection;
              tool.placeTile(rect.left + 220, rect.top + 200, 'x');
              tool.placeTile(rect.left + 220, rect.top + 420, 'diff');

              window.setTool('select');
              selection.selectIndex(0);
              const tile = window.appState.paths[0];
              const box = api.tileRect(tile);
              const clientAt = (x, y) => ({
                clientX: rect.left + x * rect.width / canvas.width,
                clientY: rect.top + y * rect.height / canvas.height,
                pointerType: 'mouse'
              });
              selection.handleDown(clientAt(box.right, box.cy));
              selection.handleMove(clientAt(box.left + box.width * 2, box.cy));
              selection.handleUp(clientAt(box.left + box.width * 2, box.cy));

              const dragged = {
                x: window.appState.manipulativeVariables.x,
                derived: api.dimensionUnits(window.appState.paths[1], 'width')
              };

              window.undo();
              const undone = {
                x: window.appState.manipulativeVariables.x,
                width: api.dimensionUnits(window.appState.paths[0], 'width'),
                derived: api.dimensionUnits(window.appState.paths[1], 'width')
              };
              return { dragged, undone };
            }
            """
        )
        self.assertAlmostEqual(result["dragged"]["x"], 6.0, places=4)
        self.assertAlmostEqual(result["dragged"]["derived"], 4.0, places=4)
        self.assertAlmostEqual(result["undone"]["x"], 3.0, places=4)
        self.assertAlmostEqual(result["undone"]["width"], 3.0, places=4)
        self.assertAlmostEqual(result["undone"]["derived"], 1.0, places=4)
        self.assertEqual(self.errors, [])

    # -------------------------------------------------------------- snapping

    def test_dragging_a_tile_snaps_flush_against_its_neighbour(self):
        page = self.open_page()
        result = page.evaluate(
            """
            () => {
              const canvas = document.getElementById('drawingCanvas');
              const rect = canvas.getBoundingClientRect();
              const tool = window.Inkyscib.ManipulativeTool;
              const api = window.Inkyscib.Manipulatives;
              const selection = window.Inkyscib.Selection;

              tool.placeTile(rect.left + 300, rect.top + 300, 'x');
              tool.placeTile(rect.left + 700, rect.top + 600, 'unit');

              const anchor = api.tileRect(window.appState.paths[0]);
              const mover = window.appState.paths[1];

              window.setTool('select');
              selection.selectIndex(1);

              const start = api.tileRect(mover);
              // Aim for a spot 6px shy of flush with the anchor's right edge.
              const targetLeft = anchor.right + 6;
              const targetTop = anchor.top + 5;
              const clientAt = (x, y) => ({
                clientX: rect.left + x * rect.width / canvas.width,
                clientY: rect.top + y * rect.height / canvas.height,
                pointerType: 'mouse'
              });

              selection.handleDown(clientAt(start.cx, start.cy));
              const dx = targetLeft - start.left;
              const dy = targetTop - start.top;
              selection.handleMove(clientAt(start.cx + dx, start.cy + dy));
              const guides = (window.appState.selection.tileAction?.guides || []).map((g) => g.kind);
              selection.handleUp(clientAt(start.cx + dx, start.cy + dy));

              const landed = api.tileRect(window.appState.paths[1]);
              return {
                anchorRight: anchor.right,
                anchorTop: anchor.top,
                landedLeft: landed.left,
                landedTop: landed.top,
                guides
              };
            }
            """
        )
        # Flush against the neighbour's right edge, and aligned to its top.
        self.assertAlmostEqual(result["landedLeft"], result["anchorRight"], places=3)
        self.assertAlmostEqual(result["landedTop"], result["anchorTop"], places=3)
        self.assertIn("contact", result["guides"])
        self.assertEqual(self.errors, [])

    def test_a_far_away_tile_is_not_pulled_by_the_magnet(self):
        page = self.open_page()
        result = page.evaluate(
            """
            () => {
              const canvas = document.getElementById('drawingCanvas');
              const rect = canvas.getBoundingClientRect();
              const api = window.Inkyscib.Manipulatives;
              const tool = window.Inkyscib.ManipulativeTool;
              tool.placeTile(rect.left + 200, rect.top + 200, 'x');
              tool.placeTile(rect.left + 700, rect.top + 640, 'unit');
              const anchor = api.tileRect(window.appState.paths[0]);
              const mover = window.appState.paths[1];
              // 64px clear of the anchor: on the 8px placement lattice, and well
              // outside the 9px magnet range, so nothing should tug at it.
              api.placeTileRect(mover, anchor.right + 64, anchor.top + 64, api.tileRect(mover));
              const landed = api.tileRect(mover);
              return { left: landed.left, expected: anchor.right + 64 };
            }
            """
        )
        self.assertAlmostEqual(result["left"], result["expected"], places=3)
        self.assertEqual(self.errors, [])

    # ----------------------------------------------------------- circle axes

    def test_circle_reference_axes_default_on_and_toggle(self):
        page = self.open_page()
        result = page.evaluate(
            """
            () => {
              const canvas = document.getElementById('drawingCanvas');
              const rect = canvas.getBoundingClientRect();
              const state = window.appState;
              state.toolSettings.shape.shapeType = 'circle';
              window.setTool('shape');
              const eventAt = (x, y) => ({
                clientX: rect.left + x * rect.width / canvas.width,
                clientY: rect.top + y * rect.height / canvas.height,
                pointerType: 'mouse',
                timeStamp: performance.now()
              });
              window.Inkyscib.Events.startDrawing(eventAt(300, 300));
              window.Inkyscib.Events.continueDrawing(eventAt(396, 300));
              window.Inkyscib.Events.endDrawing();
              window.render();

              const toggle = document.getElementById('geometryShowAxes');
              const before = { path: state.paths[0].showAxes, checkbox: toggle.checked };
              toggle.checked = false;
              toggle.dispatchEvent(new Event('change', { bubbles: true }));
              return {
                before,
                after: state.paths[0].showAxes,
                toggleVisible: !document.getElementById('geometryAxesToggle').hidden
              };
            }
            """
        )
        self.assertTrue(result["before"]["path"])
        self.assertTrue(result["before"]["checkbox"])
        self.assertFalse(result["after"])
        self.assertTrue(result["toggleVisible"])
        self.assertEqual(self.errors, [])

    def test_tile_is_selectable_and_erasable_like_other_objects(self):
        page = self.open_page()
        result = page.evaluate(
            """
            () => {
              const canvas = document.getElementById('drawingCanvas');
              const rect = canvas.getBoundingClientRect();
              window.Inkyscib.ManipulativeTool.placeTile(rect.left + 300, rect.top + 300, 'x2');
              const api = window.Inkyscib.Manipulatives;
              const path = window.appState.paths[0];
              const box = api.tileRect(path);
              const hitIndex = window.Inkyscib.Selection.hitEditablePath({ x: box.cx, y: box.cy });
              const missIndex = window.Inkyscib.Selection.hitEditablePath({
                x: box.right + 400,
                y: box.bottom + 400
              });
              const bounds = window.Inkyscib.Geometry.pathBounds(path);
              return {
                hitIndex,
                missIndex,
                boundsWidth: bounds ? Math.round(bounds.width) : null,
                tileWidth: Math.round(box.width)
              };
            }
            """
        )
        self.assertEqual(result["hitIndex"], 0)
        self.assertEqual(result["missIndex"], -1)
        self.assertGreaterEqual(result["boundsWidth"], result["tileWidth"])
        self.assertEqual(self.errors, [])


if __name__ == "__main__":
    unittest.main()
