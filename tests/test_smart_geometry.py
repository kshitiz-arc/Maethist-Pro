import threading
import unittest

from app import app


try:
    from playwright.sync_api import sync_playwright
    from werkzeug.serving import make_server

    PLAYWRIGHT_AVAILABLE = True
except ImportError:
    PLAYWRIGHT_AVAILABLE = False


@unittest.skipUnless(PLAYWRIGHT_AVAILABLE, "Playwright is not installed")
class SmartGeometryBrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = make_server("127.0.0.1", 0, app, threaded=True)
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
        page.goto(self.base_url + "/write", wait_until="domcontentloaded")
        page.wait_for_function("() => window.appState?.storageReady === true")
        return page

    def test_circle_draws_center_outward_and_opens_live_inspector(self):
        page = self.open_page()
        result = page.evaluate(
            """
            () => {
              const canvas = document.getElementById('drawingCanvas');
              const rect = canvas.getBoundingClientRect();
              const state = window.appState;
              state.paths = [];
              state.transform = { scale: 1, offsetX: 0, offsetY: 0 };
              state.notebook.active = false;
              state.ppt.active = false;
              state.toolSettings.shape.shapeType = 'circle';
              window.setTool('shape');

              const eventAt = (x, y) => ({
                clientX: rect.left + x * rect.width / canvas.width,
                clientY: rect.top + y * rect.height / canvas.height,
                pointerType: 'mouse',
                timeStamp: performance.now()
              });
              window.Inkyscib.Events.startDrawing(eventAt(240, 240));
              window.Inkyscib.Events.continueDrawing(eventAt(336, 240));
              window.Inkyscib.Events.endDrawing();

              const path = state.paths[0];
              const measures = window.Inkyscib.SmartGeometry.measureCircle(path);
              return {
                geometryKind: path.geometryKind,
                center: [path.centerX, path.centerY],
                radius: path.radius,
                width: path.width,
                measures,
                currentTool: state.currentTool,
                selectedIndex: state.selection.selectedIndex,
                inspectorVisible: !document.getElementById('geometryInspector').hidden,
                radiusText: document.getElementById('geometryMeasureRadius').textContent
              };
            }
            """
        )

        self.assertEqual(result["geometryKind"], "circle")
        self.assertAlmostEqual(result["center"][0], 240, places=6)
        self.assertAlmostEqual(result["center"][1], 240, places=6)
        self.assertAlmostEqual(result["radius"], 96, places=4)
        self.assertAlmostEqual(result["width"], 192, places=4)
        self.assertAlmostEqual(result["measures"]["radius"], 3, places=4)
        self.assertAlmostEqual(result["measures"]["diameter"], 6, places=4)
        self.assertEqual(result["currentTool"], "select")
        self.assertEqual(result["selectedIndex"], 0)
        self.assertTrue(result["inspectorVisible"])
        self.assertIn("r = 3", result["radiusText"])

    def test_constructions_remain_on_circle_after_move_and_resize(self):
        page = self.open_page()
        result = page.evaluate(
            """
            () => {
              const geometry = window.Inkyscib.SmartGeometry;
              const path = geometry.createCirclePath({ x: 240, y: 240 }, { size: 3, color: '#fff' });
              geometry.setCircleGeometry(path, { x: 240, y: 240 }, 96, 0);
              path.constructions = [
                geometry.newConstruction('radius'),
                geometry.newConstruction('diameter'),
                geometry.newConstruction('chord'),
                geometry.newConstruction('arc'),
                geometry.newConstruction('central-angle'),
                geometry.newConstruction('inscribed-angle'),
                geometry.newConstruction('cyclic-quadrilateral'),
                geometry.newConstruction('tangent')
              ];
              geometry.setCircleGeometry(path, { x: 410, y: 300 }, 144, Math.PI / 5);

              const center = geometry.circleCenter(path);
              const radialErrors = [];
              path.constructions.forEach((construction) => {
                geometry.constructionPoints(path, construction).forEach((point) => {
                  if (point.x === center.x && point.y === center.y) return;
                  radialErrors.push(Math.abs(Math.hypot(point.x - center.x, point.y - center.y) - path.radius));
                });
              });

              const tangent = path.constructions.find((item) => item.type === 'tangent');
              const tangentPoint = geometry.constructionPoints(path, tangent)[0];
              const worldAngle = tangent.angle + (path.rotation || 0);
              const tangentDirection = { x: -Math.sin(worldAngle), y: Math.cos(worldAngle) };
              const radiusVector = { x: tangentPoint.x - center.x, y: tangentPoint.y - center.y };
              const tangentDot = radiusVector.x * tangentDirection.x + radiusVector.y * tangentDirection.y;
              return {
                constructionCount: path.constructions.length,
                maxRadialError: Math.max(...radialErrors),
                tangentDot
              };
            }
            """
        )

        self.assertEqual(result["constructionCount"], 8)
        self.assertLess(result["maxRadialError"], 1e-8)
        self.assertLess(abs(result["tangentDot"]), 1e-8)

    def test_radius_edit_lock_and_persistence(self):
        page = self.open_page()
        result = page.evaluate(
            """
            async () => {
              const geometry = window.Inkyscib.SmartGeometry;
              const state = window.appState;
              state.paths = [];
              state.transform = { scale: 1, offsetX: 0, offsetY: 0 };
              const path = geometry.createCirclePath({ x: 240, y: 240 }, { size: 3, color: '#ffffff' });
              geometry.setCircleGeometry(path, { x: 240, y: 240 }, 96, 0);
              path.constructions.push(geometry.newConstruction('chord'));
              state.paths.push(path);
              window.setTool('select');
              window.Inkyscib.Selection.selectIndex(0);
              geometry.syncInspector(true);

              const radiusInput = document.getElementById('geometryRadiusInput');
              radiusInput.focus();
              radiusInput.value = '5';
              radiusInput.dispatchEvent(new Event('input', { bubbles: true }));
              radiusInput.dispatchEvent(new Event('change', { bubbles: true }));
              document.getElementById('geometryRadiusLock').click();

              const lockedRadius = state.paths[0].radius;
              const canvas = document.getElementById('drawingCanvas');
              const rect = canvas.getBoundingClientRect();
              const eventAt = (x, y) => ({
                clientX: rect.left + x * rect.width / canvas.width,
                clientY: rect.top + y * rect.height / canvas.height,
                pointerType: 'mouse'
              });
              const center = geometry.circleCenter(state.paths[0]);
              window.Inkyscib.Selection.handleDown(eventAt(center.x + lockedRadius, center.y));
              window.Inkyscib.Selection.handleMove(eventAt(center.x + lockedRadius + 60, center.y));
              window.Inkyscib.Selection.handleUp();

              await window.saveDrawing({ force: true });
              const stored = JSON.parse(localStorage.getItem('inkyscib_drawing'))[0];
              return {
                radius: state.paths[0].radius,
                lockedRadius,
                radiusLocked: state.paths[0].radiusLocked,
                smartActionActive: !!state.selection.smartAction,
                stored: {
                  geometryVersion: stored.geometryVersion,
                  geometryKind: stored.geometryKind,
                  radius: stored.radius,
                  radiusLocked: stored.radiusLocked,
                  constructionType: stored.constructions[0].type
                }
              };
            }
            """
        )

        self.assertAlmostEqual(result["lockedRadius"], 160, places=4)
        self.assertAlmostEqual(result["radius"], result["lockedRadius"], places=4)
        self.assertTrue(result["radiusLocked"])
        self.assertFalse(result["smartActionActive"])
        self.assertEqual(result["stored"]["geometryVersion"], 1)
        self.assertEqual(result["stored"]["geometryKind"], "circle")
        self.assertAlmostEqual(result["stored"]["radius"], 160, places=4)
        self.assertTrue(result["stored"]["radiusLocked"])
        self.assertEqual(result["stored"]["constructionType"], "chord")

    def test_shape_picker_draws_smart_triangles_and_quadrilaterals(self):
        page = self.open_page()
        results = page.evaluate(
            """
            () => {
              const canvas = document.getElementById('drawingCanvas');
              const rect = canvas.getBoundingClientRect();
              const state = window.appState;
              const geometry = window.Inkyscib.SmartGeometry;
              state.transform = { scale: 1, offsetX: 0, offsetY: 0 };
              state.notebook.active = false;
              state.ppt.active = false;

              const eventAt = (x, y) => ({
                clientX: rect.left + x * rect.width / canvas.width,
                clientY: rect.top + y * rect.height / canvas.height,
                pointerType: 'mouse',
                timeStamp: performance.now()
              });

              return ['triangle', 'rectangle', 'parallelogram', 'rhombus', 'kite'].map((kind, index) => {
                state.paths = [];
                window.Inkyscib.Selection.clear();
                const pickerButton = document.querySelector(`.shape-btn[data-shape="${kind}"]`);
                pickerButton.click();
                window.setTool('shape');
                const startX = 170 + index * 20;
                const startY = 150 + index * 15;
                window.Inkyscib.Events.startDrawing(eventAt(startX, startY));
                window.Inkyscib.Events.continueDrawing(eventAt(startX + 150, startY + 110));
                window.Inkyscib.Events.endDrawing();

                const path = state.paths[0];
                const measures = geometry.measureGeometry(path);
                return {
                  requestedKind: kind,
                  pickerExists: !!pickerButton,
                  pickerActive: pickerButton.classList.contains('active'),
                  settingKind: state.toolSettings.shape.shapeType,
                  geometryKind: path?.geometryKind,
                  shapeType: path?.shapeType,
                  pointCount: path?.points?.length,
                  smart: geometry.isSmartGeometry(path),
                  area: measures?.area,
                  selectedIndex: state.selection.selectedIndex,
                  currentTool: state.currentTool,
                  inspectorVisible: !document.getElementById('geometryInspector').hidden,
                  inspectorTitle: document.getElementById('geometryInspectorTitle').textContent
                };
              });
            }
            """
        )

        self.assertEqual([item["requestedKind"] for item in results], [
            "triangle", "rectangle", "parallelogram", "rhombus", "kite"
        ])
        for item in results:
            self.assertTrue(item["pickerExists"])
            self.assertTrue(item["pickerActive"])
            self.assertEqual(item["settingKind"], item["requestedKind"])
            self.assertEqual(item["geometryKind"], item["requestedKind"])
            self.assertEqual(item["shapeType"], item["requestedKind"])
            self.assertEqual(
                item["pointCount"],
                3 if item["requestedKind"] == "triangle" else 4
            )
            self.assertTrue(item["smart"])
            self.assertGreater(item["area"], 0)
            self.assertEqual(item["selectedIndex"], 0)
            self.assertEqual(item["currentTool"], "select")
            self.assertTrue(item["inspectorVisible"])
            self.assertIn(item["requestedKind"].title(), item["inspectorTitle"])

    def test_triangle_angle_edit_mark_lock_drag_and_persistence(self):
        page = self.open_page()
        result = page.evaluate(
            """
            async () => {
              const geometry = window.Inkyscib.SmartGeometry;
              const state = window.appState;
              const canvas = document.getElementById('drawingCanvas');
              const rect = canvas.getBoundingClientRect();
              state.paths = [];
              state.transform = { scale: 1, offsetX: 0, offsetY: 0 };
              state.notebook.active = false;
              state.ppt.active = false;

              const path = geometry.createShapePath('triangle', { x: 250, y: 170 }, {
                size: 3,
                color: '#ffffff',
                triangleType: 'isosceles'
              });
              geometry.updateShapeDraft(path, { x: 430, y: 350 });
              geometry.finalizeSmartShape(path);
              path.snapToGrid = false;
              path.snapToObjects = false;
              state.paths.push(path);
              window.setTool('select');
              window.Inkyscib.Selection.selectIndex(0);
              geometry.syncInspector(true);

              document.querySelector('[data-geometry-angle="0"]').click();
              document.getElementById('geometryAngleMark').click();
              const angleInput = document.getElementById('geometryAngleInput');
              angleInput.focus();
              angleInput.value = '52';
              angleInput.dispatchEvent(new Event('input', { bubbles: true }));
              angleInput.dispatchEvent(new Event('change', { bubbles: true }));
              document.getElementById('geometryAngleLock').click();

              const beforeDrag = path.points.map((point) => ({ ...point }));
              const dragged = beforeDrag[2];
              const eventAt = (x, y) => ({
                clientX: rect.left + x * rect.width / canvas.width,
                clientY: rect.top + y * rect.height / canvas.height,
                pointerType: 'mouse',
                timeStamp: performance.now()
              });
              const downHandled = window.Inkyscib.Selection.handleDown(eventAt(dragged.x, dragged.y));
              window.Inkyscib.Selection.handleMove(eventAt(dragged.x + 95, dragged.y - 55));
              window.Inkyscib.Selection.handleUp();

              const metrics = geometry.measureGeometry(path);
              await window.saveDrawing({ force: true });
              const stored = JSON.parse(localStorage.getItem('inkyscib_drawing'))[0];
              return {
                downHandled,
                angleDegrees: metrics.angleDegrees[0],
                angleMarked: path.angleMarks[0],
                lockedAngle: path.lockedAngles[0],
                vertexMoved: Math.hypot(
                  path.points[2].x - beforeDrag[2].x,
                  path.points[2].y - beforeDrag[2].y
                ),
                smartActionActive: !!state.selection.smartAction,
                inspectorTitle: document.getElementById('geometryInspectorTitle').textContent,
                inputValue: document.getElementById('geometryAngleInput').value,
                lockPressed: document.getElementById('geometryAngleLock').getAttribute('aria-pressed'),
                circleControlsDisplay: getComputedStyle(document.getElementById('geometryCircleDimensionRow')).display,
                triangleControlsDisplay: getComputedStyle(document.getElementById('geometryTriangleControls')).display,
                stored: {
                  geometryKind: stored.geometryKind,
                  pointCount: stored.points.length,
                  angleMarks: stored.angleMarks,
                  lockedAngles: stored.lockedAngles
                }
              };
            }
            """
        )

        self.assertTrue(result["downHandled"])
        self.assertAlmostEqual(result["angleDegrees"], 52, places=5)
        self.assertTrue(result["angleMarked"])
        self.assertAlmostEqual(result["lockedAngle"], 52 * 3.141592653589793 / 180, places=8)
        self.assertGreater(result["vertexMoved"], 20)
        self.assertFalse(result["smartActionActive"])
        self.assertIn("Triangle", result["inspectorTitle"])
        self.assertAlmostEqual(float(result["inputValue"]), 52, places=5)
        self.assertEqual(result["lockPressed"], "true")
        self.assertEqual(result["circleControlsDisplay"], "none")
        self.assertNotEqual(result["triangleControlsDisplay"], "none")
        self.assertEqual(result["stored"]["geometryKind"], "triangle")
        self.assertEqual(result["stored"]["pointCount"], 3)
        self.assertEqual(result["stored"]["angleMarks"], [True, False, False])
        self.assertAlmostEqual(
            result["stored"]["lockedAngles"][0],
            52 * 3.141592653589793 / 180,
            places=8
        )

    def test_legacy_square_stays_on_its_two_point_pipeline(self):
        page = self.open_page()
        result = page.evaluate(
            """
            async () => {
              const state = window.appState;
              const canvas = document.getElementById('drawingCanvas');
              const rect = canvas.getBoundingClientRect();
              state.paths = [];
              state.transform = { scale: 1, offsetX: 0, offsetY: 0 };
              state.notebook.active = false;
              state.ppt.active = false;
              state.toolSettings.shape.shapeType = 'square';
              window.setTool('shape');
              const eventAt = (x, y) => ({
                clientX: rect.left + x * rect.width / canvas.width,
                clientY: rect.top + y * rect.height / canvas.height,
                pointerType: 'mouse'
              });
              window.Inkyscib.Events.startDrawing(eventAt(180, 170));
              window.Inkyscib.Events.continueDrawing(eventAt(340, 290));
              window.Inkyscib.Events.endDrawing();
              await window.saveDrawing({ force: true });
              const path = state.paths[0];
              const stored = JSON.parse(localStorage.getItem('inkyscib_drawing'))[0];
              return {
                smart: window.Inkyscib.SmartGeometry.isSmartGeometry(path),
                shapeType: path.shapeType,
                geometryKind: path.geometryKind || null,
                pointCount: path.points.length,
                displayPointCount: window.Inkyscib.Geometry.shapeDisplayPoints(path).length,
                width: path.width,
                height: path.height,
                currentTool: state.currentTool,
                storedShapeType: stored.shapeType,
                storedPointCount: stored.points.length
              };
            }
            """
        )

        self.assertFalse(result["smart"])
        self.assertEqual(result["shapeType"], "square")
        self.assertIsNone(result["geometryKind"])
        self.assertEqual(result["pointCount"], 2)
        self.assertEqual(result["displayPointCount"], 4)
        self.assertAlmostEqual(result["width"], 160, places=5)
        self.assertAlmostEqual(result["height"], 120, places=5)
        self.assertEqual(result["currentTool"], "shape")
        self.assertEqual(result["storedShapeType"], "square")
        self.assertEqual(result["storedPointCount"], 2)

    def test_custom_three_click_triangle_is_promoted_to_smart_geometry(self):
        page = self.open_page()
        result = page.evaluate(
            """
            () => {
              const state = window.appState;
              const geometry = window.Inkyscib.SmartGeometry;
              const canvas = document.getElementById('drawingCanvas');
              const rect = canvas.getBoundingClientRect();
              state.paths = [];
              state.transform = { scale: 1, offsetX: 0, offsetY: 0 };
              state.notebook.active = false;
              state.ppt.active = false;
              state.toolSettings.shape.shapeType = 'triangle';
              state.toolSettings.shape.triangleType = 'custom';
              window.setTool('shape');

              const eventAt = (x, y) => ({
                button: 0,
                clientX: rect.left + x * rect.width / canvas.width,
                clientY: rect.top + y * rect.height / canvas.height,
                pointerType: 'mouse',
                preventDefault() {}
              });
              window.Inkyscib.Events.handleMouseDown(eventAt(180, 320));
              window.Inkyscib.Events.handleMouseDown(eventAt(285, 145));
              window.Inkyscib.Events.handleMouseDown(eventAt(430, 335));

              const path = state.paths[0];
              const metrics = geometry.measureGeometry(path);
              const right = geometry.createShapePath('triangle', { x: 520, y: 160 }, {
                size: 3,
                color: '#ffffff',
                triangleType: 'right'
              });
              geometry.updateShapeDraft(right, { x: 680, y: 310 });
              geometry.finalizeSmartShape(right);
              return {
                smart: geometry.isSmartGeometry(path),
                kind: path?.geometryKind,
                triangleType: path?.triangleType,
                pointCount: path?.points?.length,
                labels: path?.vertexLabels,
                angleSum: metrics.angleDegrees.reduce((sum, angle) => sum + angle, 0),
                area: metrics.area,
                rightAngle: geometry.measureGeometry(right).angleDegrees[1],
                rightAngleMarked: right.angleMarks[1],
                rightAngleLocked: right.lockedAngles[1],
                selectedIndex: state.selection.selectedIndex,
                currentTool: state.currentTool
              };
            }
            """
        )

        self.assertTrue(result["smart"])
        self.assertEqual(result["kind"], "triangle")
        self.assertEqual(result["triangleType"], "custom")
        self.assertEqual(result["pointCount"], 3)
        self.assertEqual(result["labels"], ["A", "B", "C"])
        self.assertAlmostEqual(result["angleSum"], 180, places=7)
        self.assertGreater(result["area"], 0)
        self.assertAlmostEqual(result["rightAngle"], 90, places=8)
        self.assertTrue(result["rightAngleMarked"])
        self.assertAlmostEqual(result["rightAngleLocked"], 3.141592653589793 / 2, places=10)
        self.assertEqual(result["selectedIndex"], 0)
        self.assertEqual(result["currentTool"], "select")

    def test_quadrilateral_vertex_drags_preserve_constraints_and_controls(self):
        page = self.open_page()
        result = page.evaluate(
            """
            async () => {
              const geometry = window.Inkyscib.SmartGeometry;
              const state = window.appState;
              const canvas = document.getElementById('drawingCanvas');
              const rect = canvas.getBoundingClientRect();
              state.transform = { scale: 1, offsetX: 0, offsetY: 0 };
              state.notebook.active = false;
              state.ppt.active = false;

              const distance = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
              const eventAt = (x, y) => ({
                clientX: rect.left + x * rect.width / canvas.width,
                clientY: rect.top + y * rect.height / canvas.height,
                pointerType: 'mouse',
                timeStamp: performance.now()
              });
              const rectangleCornerChecks = [0, 1, 2, 3].map((vertexIndex) => {
                const start = { x: 250, y: 170 };
                const rectangle = geometry.createShapePath('rectangle', start, { size: 3, color: '#ffffff' });
                geometry.updateShapeDraft(rectangle, { x: 440, y: 330 });
                geometry.finalizeSmartShape(rectangle);
                rectangle.snapToGrid = false;
                rectangle.snapToObjects = false;
                const original = JSON.parse(JSON.stringify(rectangle));
                const opposite = original.points[(vertexIndex + 2) % 4];
                const offsets = [
                  { x: 34, y: -26 },
                  { x: -31, y: -28 },
                  { x: -36, y: 25 },
                  { x: 33, y: 29 }
                ];
                const target = {
                  x: opposite.x + offsets[vertexIndex].x,
                  y: opposite.y + offsets[vertexIndex].y
                };
                geometry.updateGeometryVertex(rectangle, vertexIndex, target, original);
                const points = rectangle.points;
                const rightAngleErrors = points.map((point, index) => {
                  const previous = points[(index + 3) % 4];
                  const next = points[(index + 1) % 4];
                  const a = { x: previous.x - point.x, y: previous.y - point.y };
                  const b = { x: next.x - point.x, y: next.y - point.y };
                  return Math.abs(a.x * b.x + a.y * b.y) /
                    Math.max(1, Math.hypot(a.x, a.y) * Math.hypot(b.x, b.y));
                });
                return {
                  targetError: distance(points[vertexIndex], target),
                  maxRightAngleError: Math.max(...rightAngleErrors),
                  closureError: Math.hypot(
                    points[0].x + points[2].x - points[1].x - points[3].x,
                    points[0].y + points[2].y - points[1].y - points[3].y
                  )
                };
              });
              const cases = [
                { kind: 'rectangle', index: 0, delta: { x: -38, y: 27 } },
                { kind: 'parallelogram', index: 0, delta: { x: -45, y: 32 } },
                { kind: 'rhombus', index: 0, delta: { x: 28, y: -42 } },
                { kind: 'kite', index: 1, delta: { x: 52, y: 24 } }
              ];

              const outcomes = cases.map((testCase, caseIndex) => {
                state.paths = [];
                window.Inkyscib.Selection.clear();
                const start = { x: 210 + caseIndex * 30, y: 160 + caseIndex * 20 };
                const path = geometry.createShapePath(testCase.kind, start, {
                  size: 3,
                  color: '#ffffff'
                });
                geometry.updateShapeDraft(path, { x: start.x + 180, y: start.y + 150 });
                geometry.finalizeSmartShape(path);
                path.snapToGrid = false;
                path.snapToObjects = false;
                state.paths.push(path);
                window.setTool('select');
                window.Inkyscib.Selection.selectIndex(0);
                geometry.syncInspector(true);

                const initial = { ...path.points[testCase.index] };
                const target = {
                  x: initial.x + testCase.delta.x,
                  y: initial.y + testCase.delta.y
                };
                const downHandled = window.Inkyscib.Selection.handleDown(eventAt(initial.x, initial.y));
                window.Inkyscib.Selection.handleMove(eventAt(target.x, target.y));
                window.Inkyscib.Selection.handleUp();

                const points = path.points;
                const sides = points.map((point, index) => distance(point, points[(index + 1) % 4]));
                return {
                  kind: testCase.kind,
                  downHandled,
                  moved: distance(initial, points[testCase.index]),
                  area: geometry.measureGeometry(path).area,
                  rectangleRightAngleError: Math.abs(
                    (points[1].x - points[0].x) * (points[3].x - points[0].x) +
                    (points[1].y - points[0].y) * (points[3].y - points[0].y)
                  ),
                  parallelogramError: Math.hypot(
                    points[0].x + points[2].x - points[1].x - points[3].x,
                    points[0].y + points[2].y - points[1].y - points[3].y
                  ),
                  rhombusSideSpread: Math.max(...sides) - Math.min(...sides),
                  kitePairError: Math.max(
                    Math.abs(sides[0] - sides[3]),
                    Math.abs(sides[1] - sides[2])
                  ),
                  title: document.getElementById('geometryInspectorTitle').textContent
                };
              });

              const kite = state.paths[0];
              document.getElementById('geometryDuplicate').click();
              const duplicateCount = state.paths.length;
              const duplicateOffset = distance(state.paths[0].points[0], state.paths[1].points[0]);
              await window.saveDrawing({ force: true });
              const stored = JSON.parse(localStorage.getItem('inkyscib_drawing'));
              const storedKinds = stored.map((path) => path.geometryKind);
              document.getElementById('geometryDelete').click();

              return {
                outcomes,
                rectangleCornerChecks,
                duplicateCount,
                duplicateOffset,
                storedKinds,
                countAfterDelete: state.paths.length,
                remainingKind: state.paths[0]?.geometryKind,
                originalKind: kite.geometryKind
              };
            }
            """
        )

        outcomes = {item["kind"]: item for item in result["outcomes"]}
        self.assertEqual(set(outcomes), {"rectangle", "parallelogram", "rhombus", "kite"})
        for kind, item in outcomes.items():
            self.assertTrue(item["downHandled"], kind)
            self.assertGreater(item["moved"], 20, kind)
            self.assertGreater(item["area"], 0, kind)
            self.assertIn(kind.title(), item["title"])
        self.assertLess(outcomes["rectangle"]["rectangleRightAngleError"], 1e-8)
        self.assertLess(outcomes["rectangle"]["parallelogramError"], 1e-8)
        self.assertLess(outcomes["parallelogram"]["parallelogramError"], 1e-8)
        self.assertLess(outcomes["rhombus"]["rhombusSideSpread"], 1e-8)
        self.assertLess(outcomes["kite"]["kitePairError"], 1e-8)
        for check in result["rectangleCornerChecks"]:
            self.assertLess(check["targetError"], 1e-8)
            self.assertLess(check["maxRightAngleError"], 1e-10)
            self.assertLess(check["closureError"], 1e-8)
        self.assertEqual(result["duplicateCount"], 2)
        self.assertGreater(result["duplicateOffset"], 0)
        self.assertEqual(result["storedKinds"], ["kite", "kite"])
        self.assertEqual(result["countAfterDelete"], 1)
        self.assertEqual(result["remainingKind"], "kite")
        self.assertEqual(result["originalKind"], "kite")

    def test_equilateral_creation_and_every_vertex_drag_remain_exact(self):
        page = self.open_page()
        result = page.evaluate(
            """
            () => {
              const state = window.appState;
              const geometry = window.Inkyscib.SmartGeometry;
              const canvas = document.getElementById('drawingCanvas');
              const rect = canvas.getBoundingClientRect();
              state.paths = [];
              state.transform = { scale: 1, offsetX: 0, offsetY: 0 };
              state.notebook.active = false;
              state.ppt.active = false;

              const eventAt = (x, y) => ({
                clientX: rect.left + x * rect.width / canvas.width,
                clientY: rect.top + y * rect.height / canvas.height,
                pointerType: 'mouse',
                timeStamp: performance.now()
              });
              const sideSpread = (metrics) => {
                const sides = [metrics.sideAB, metrics.sideBC, metrics.sideCA];
                return Math.max(...sides) - Math.min(...sides);
              };
              const angleError = (metrics) => Math.max(
                ...metrics.angleDegrees.map((angle) => Math.abs(angle - 60))
              );

              document.querySelector('.shape-btn[data-shape="triangle"]').click();
              const equilateralButton = document.querySelector(
                '.triangle-type-btn[data-triangle-type="equilateral"]'
              );
              equilateralButton.click();
              window.setTool('shape');
              window.Inkyscib.Events.startDrawing(eventAt(220, 170));
              window.Inkyscib.Events.continueDrawing(eventAt(420, 345));
              window.Inkyscib.Events.endDrawing();

              const created = state.paths[0];
              const createdMetrics = geometry.measureGeometry(created);
              const original = JSON.parse(JSON.stringify(created));
              const deltas = [
                { x: -42, y: -31 },
                { x: -51, y: 37 },
                { x: 58, y: 29 }
              ];
              const drags = [0, 1, 2].map((vertexIndex) => {
                const candidate = JSON.parse(JSON.stringify(original));
                candidate.snapToGrid = false;
                candidate.snapToObjects = false;
                state.paths = [candidate];
                window.Inkyscib.Selection.clear({ render: false });
                window.setTool('select');
                window.Inkyscib.Selection.selectIndex(0);
                const start = { ...candidate.points[vertexIndex] };
                const target = {
                  x: start.x + deltas[vertexIndex].x,
                  y: start.y + deltas[vertexIndex].y
                };
                const downHandled = window.Inkyscib.Selection.handleDown(eventAt(start.x, start.y));
                window.Inkyscib.Selection.handleMove(eventAt(target.x, target.y));
                window.Inkyscib.Selection.handleUp();
                const updated = state.paths[0];
                const metrics = geometry.measureGeometry(updated);
                return {
                  vertexIndex,
                  downHandled,
                  moved: Math.hypot(
                    updated.points[vertexIndex].x - start.x,
                    updated.points[vertexIndex].y - start.y
                  ),
                  sideSpread: sideSpread(metrics),
                  angleError: angleError(metrics),
                  angleSum: metrics.angleDegrees.reduce((sum, angle) => sum + angle, 0),
                  area: metrics.area
                };
              });

              return {
                pickerExists: !!equilateralButton,
                pickerActive: equilateralButton.classList.contains('active'),
                configuredType: state.toolSettings.shape.triangleType,
                triangleType: created.triangleType,
                smart: geometry.isSmartTriangle(created),
                creationSideSpread: sideSpread(createdMetrics),
                creationAngleError: angleError(createdMetrics),
                creationAngleSum: createdMetrics.angleDegrees.reduce((sum, angle) => sum + angle, 0),
                drags
              };
            }
            """
        )

        self.assertTrue(result["pickerExists"])
        self.assertTrue(result["pickerActive"])
        self.assertEqual(result["configuredType"], "equilateral")
        self.assertEqual(result["triangleType"], "equilateral")
        self.assertTrue(result["smart"])
        self.assertLess(result["creationSideSpread"], 1e-10)
        self.assertLess(result["creationAngleError"], 1e-10)
        self.assertAlmostEqual(result["creationAngleSum"], 180, places=10)
        self.assertEqual([item["vertexIndex"] for item in result["drags"]], [0, 1, 2])
        for item in result["drags"]:
            self.assertTrue(item["downHandled"], item)
            self.assertGreater(item["moved"], 5, item)
            self.assertLess(item["sideSpread"], 1e-10, item)
            self.assertLess(item["angleError"], 1e-10, item)
            self.assertAlmostEqual(item["angleSum"], 180, places=10)
            self.assertGreater(item["area"], 0)

    def test_quadrilateral_dimension_inputs_apply_exact_values(self):
        page = self.open_page()
        result = page.evaluate(
            """
            () => {
              const state = window.appState;
              const geometry = window.Inkyscib.SmartGeometry;
              state.paths = [];
              state.transform = { scale: 1, offsetX: 0, offsetY: 0 };
              state.notebook.active = false;
              state.ppt.active = false;

              const normalized = (value) => String(value || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
              const findDimensionInput = (key) => {
                const pascal = key.charAt(0).toUpperCase() + key.slice(1);
                const fields = document.getElementById('geometryDimensionFields');
                const direct = fields?.querySelector(
                  `[data-geometry-dimension="${key}"], ` +
                  `[data-dimension-key="${key}"], ` +
                  `#geometryDimension${pascal}Input`
                );
                if (direct) return direct.matches('input') ? direct : direct.querySelector('input');
                const wanted = normalized(key);
                return [...(fields?.querySelectorAll('input') || [])].find((input) => {
                  const label = input.closest('label');
                  const identity = normalized([
                    input.id,
                    input.name,
                    input.dataset.geometryDimension,
                    input.dataset.dimensionKey,
                    label?.textContent
                  ].join(' '));
                  return identity.includes(wanted);
                }) || null;
              };
              const missing = [];
              const editDimension = (kind, key, value) => {
                const input = findDimensionInput(key);
                if (!input) {
                  missing.push(`${kind}:${key}`);
                  return null;
                }
                input.focus();
                input.value = String(value);
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
                input.blur();
                return input.id || input.dataset.geometryDimension || input.dataset.dimensionKey || key;
              };
              const createAndSelect = (kind, index) => {
                state.paths = [];
                window.Inkyscib.Selection.clear({ render: false });
                const start = { x: 220 + index * 25, y: 170 + index * 20 };
                const path = geometry.createShapePath(kind, start, { size: 3, color: '#ffffff' });
                path.snapToGrid = true;
                path.snapToObjects = false;
                geometry.updateShapeDraft(path, { x: start.x + 190, y: start.y + 145 });
                geometry.finalizeSmartShape(path);
                state.paths.push(path);
                window.setTool('select');
                window.Inkyscib.Selection.selectIndex(0);
                geometry.syncInspector(true);
                return path;
              };

              const rectangle = createAndSelect('rectangle', 0);
              const rectangleInputs = [
                editDimension('rectangle', 'width', 5.25),
                editDimension('rectangle', 'height', 3.75)
              ];
              const rectangleMetrics = geometry.measureGeometry(rectangle);

              const parallelogram = createAndSelect('parallelogram', 1);
              const parallelogramInputs = [
                editDimension('parallelogram', 'base', 5.5),
                editDimension('parallelogram', 'side', 3.25),
                editDimension('parallelogram', 'angle', 68)
              ];
              const parallelogramMetrics = geometry.measureGeometry(parallelogram);

              const rhombus = createAndSelect('rhombus', 2);
              const rhombusInputs = [
                editDimension('rhombus', 'diagonalAC', 6.25),
                editDimension('rhombus', 'diagonalBD', 3.75)
              ];
              const rhombusMetrics = geometry.measureGeometry(rhombus);

              const kite = createAndSelect('kite', 3);
              const kiteInputs = [
                editDimension('kite', 'diagonalAC', 6.5),
                editDimension('kite', 'diagonalBD', 4.25)
              ];
              const kiteMetrics = geometry.measureGeometry(kite);

              return {
                missing,
                controlsVisible: !document.getElementById('geometryDimensionControls').hidden,
                fieldCount: document.querySelectorAll('#geometryDimensionFields input').length,
                rectangleInputs,
                rectangle: {
                  width: rectangleMetrics.sides[0],
                  height: rectangleMetrics.sides[1],
                  rightAngle: rectangleMetrics.angles[0] * 180 / Math.PI
                },
                parallelogramInputs,
                parallelogram: {
                  base: parallelogramMetrics.sides[0],
                  side: parallelogramMetrics.sides[1],
                  oppositeBase: parallelogramMetrics.sides[2],
                  oppositeSide: parallelogramMetrics.sides[3],
                  angle: parallelogramMetrics.angles[0] * 180 / Math.PI
                },
                rhombusInputs,
                rhombus: {
                  diagonalAC: rhombusMetrics.diagonalAC,
                  diagonalBD: rhombusMetrics.diagonalBD,
                  sideSpread: Math.max(...rhombusMetrics.sides) - Math.min(...rhombusMetrics.sides)
                },
                kiteInputs,
                kite: {
                  diagonalAC: kiteMetrics.diagonalAC,
                  diagonalBD: kiteMetrics.diagonalBD,
                  firstPairError: Math.abs(kiteMetrics.sides[0] - kiteMetrics.sides[3]),
                  secondPairError: Math.abs(kiteMetrics.sides[1] - kiteMetrics.sides[2])
                }
              };
            }
            """
        )

        self.assertEqual(result["missing"], [])
        self.assertTrue(result["controlsVisible"])
        self.assertEqual(result["fieldCount"], 2)
        self.assertTrue(all(result["rectangleInputs"]))
        self.assertAlmostEqual(result["rectangle"]["width"], 5.25, places=8)
        self.assertAlmostEqual(result["rectangle"]["height"], 3.75, places=8)
        self.assertAlmostEqual(result["rectangle"]["rightAngle"], 90, places=8)
        self.assertTrue(all(result["parallelogramInputs"]))
        self.assertAlmostEqual(result["parallelogram"]["base"], 5.5, places=8)
        self.assertAlmostEqual(result["parallelogram"]["side"], 3.25, places=8)
        self.assertAlmostEqual(result["parallelogram"]["oppositeBase"], 5.5, places=8)
        self.assertAlmostEqual(result["parallelogram"]["oppositeSide"], 3.25, places=8)
        self.assertAlmostEqual(result["parallelogram"]["angle"], 68, places=8)
        self.assertTrue(all(result["rhombusInputs"]))
        self.assertAlmostEqual(result["rhombus"]["diagonalAC"], 6.25, places=8)
        self.assertAlmostEqual(result["rhombus"]["diagonalBD"], 3.75, places=8)
        self.assertLess(result["rhombus"]["sideSpread"], 1e-8)
        self.assertTrue(all(result["kiteInputs"]))
        self.assertAlmostEqual(result["kite"]["diagonalAC"], 6.5, places=8)
        self.assertAlmostEqual(result["kite"]["diagonalBD"], 4.25, places=8)
        self.assertLess(result["kite"]["firstPairError"], 1e-8)
        self.assertLess(result["kite"]["secondPairError"], 1e-8)

    def test_smart_rotation_handle_and_numeric_rotation_preserve_dimensions(self):
        page = self.open_page()
        result = page.evaluate(
            """
            () => {
              const state = window.appState;
              const geometry = window.Inkyscib.SmartGeometry;
              const canvas = document.getElementById('drawingCanvas');
              const rect = canvas.getBoundingClientRect();
              state.paths = [];
              state.transform = { scale: 1, offsetX: 0, offsetY: 0 };
              state.notebook.active = false;
              state.ppt.active = false;

              const eventAt = (x, y) => ({
                clientX: rect.left + x * rect.width / canvas.width,
                clientY: rect.top + y * rect.height / canvas.height,
                pointerType: 'mouse',
                timeStamp: performance.now()
              });
              const centerOf = (path) => ({
                x: path.points.reduce((sum, point) => sum + point.x, 0) / path.points.length,
                y: path.points.reduce((sum, point) => sum + point.y, 0) / path.points.length
              });
              const edgeAngle = (path) => {
                const angle = Math.atan2(
                  path.points[1].y - path.points[0].y,
                  path.points[1].x - path.points[0].x
                ) * 180 / Math.PI;
                return (angle % 360 + 360) % 360;
              };

              const path = geometry.createShapePath('rectangle', { x: 250, y: 190 }, {
                size: 3,
                color: '#ffffff'
              });
              path.snapToGrid = false;
              path.snapToObjects = false;
              geometry.updateShapeDraft(path, { x: 440, y: 330 });
              geometry.finalizeSmartShape(path);
              state.paths.push(path);
              window.setTool('select');
              window.Inkyscib.Selection.selectIndex(0);
              geometry.syncInspector(true);

              const beforeMetrics = geometry.measureGeometry(path);
              const beforeCenter = centerOf(path);
              const rotationInput = document.getElementById('geometryRotationInput');
              rotationInput.focus();
              rotationInput.value = '37.5';
              rotationInput.dispatchEvent(new Event('input', { bubbles: true }));
              rotationInput.dispatchEvent(new Event('change', { bubbles: true }));
              rotationInput.blur();
              const afterNumeric = state.paths[0];
              const numericMetrics = geometry.measureGeometry(afterNumeric);
              const numericCenter = centerOf(afterNumeric);
              const numericAngle = edgeAngle(afterNumeric);
              const numericInputValue = rotationInput.value;

              document.getElementById('geometryRotationReset').click();
              const resetPath = state.paths[0];
              const resetCenter = centerOf(resetPath);
              const resetAngle = edgeAngle(resetPath);
              const top = Math.min(...resetPath.points.map((point) => point.y));
              const handleStart = { x: resetCenter.x, y: top - 34 };
              const handleRadius = Math.hypot(
                handleStart.x - resetCenter.x,
                handleStart.y - resetCenter.y
              );
              const downHandled = window.Inkyscib.Selection.handleDown(
                eventAt(handleStart.x, handleStart.y)
              );
              const actionHandle = state.selection.smartAction?.handle?.type ||
                state.selection.action?.handle?.type || null;
              window.Inkyscib.Selection.handleMove(
                eventAt(resetCenter.x + handleRadius, resetCenter.y)
              );
              window.Inkyscib.Selection.handleUp();
              const afterHandle = state.paths[0];
              const handleMetrics = geometry.measureGeometry(afterHandle);
              const handleCenter = centerOf(afterHandle);

              return {
                rotationVisible: !document.getElementById('geometryRotationRow').hidden,
                numericAngle,
                numericInputValue,
                numericCenterError: Math.hypot(
                  numericCenter.x - beforeCenter.x,
                  numericCenter.y - beforeCenter.y
                ),
                numericSideErrors: numericMetrics.sides.map(
                  (side, index) => Math.abs(side - beforeMetrics.sides[index])
                ),
                resetAngle,
                downHandled,
                actionHandle,
                handleAngle: edgeAngle(afterHandle),
                handleCenterError: Math.hypot(
                  handleCenter.x - resetCenter.x,
                  handleCenter.y - resetCenter.y
                ),
                handleSideErrors: handleMetrics.sides.map(
                  (side, index) => Math.abs(side - beforeMetrics.sides[index])
                )
              };
            }
            """
        )

        self.assertTrue(result["rotationVisible"])
        self.assertAlmostEqual(result["numericAngle"], 37.5, places=7)
        self.assertAlmostEqual(float(result["numericInputValue"]), 37.5, places=7)
        self.assertLess(result["numericCenterError"], 1e-8)
        self.assertLess(max(result["numericSideErrors"]), 1e-8)
        self.assertAlmostEqual(result["resetAngle"], 0, places=7)
        self.assertTrue(result["downHandled"])
        self.assertIn(result["actionHandle"], {"rotate", "rotation"})
        self.assertAlmostEqual(result["handleAngle"], 90, places=6)
        self.assertLess(result["handleCenterError"], 1e-8)
        self.assertLess(max(result["handleSideErrors"]), 1e-8)

    def test_grid_drag_uses_half_units_typed_value_stays_exact_and_objects_snap(self):
        page = self.open_page()
        result = page.evaluate(
            """
            () => {
              const state = window.appState;
              const geometry = window.Inkyscib.SmartGeometry;
              const canvas = document.getElementById('drawingCanvas');
              const rect = canvas.getBoundingClientRect();
              state.paths = [];
              state.transform = { scale: 1, offsetX: 0, offsetY: 0 };
              state.notebook.active = false;
              state.ppt.active = false;

              const eventAt = (x, y) => ({
                clientX: rect.left + x * rect.width / canvas.width,
                clientY: rect.top + y * rect.height / canvas.height,
                pointerType: 'mouse',
                timeStamp: performance.now()
              });
              const dimensionFields = document.getElementById('geometryDimensionFields');
              const findWidthInput = () => dimensionFields.querySelector(
                '[data-geometry-dimension="width"], [data-dimension-key="width"], ' +
                '#geometryDimensionWidthInput'
              ) || [...dimensionFields.querySelectorAll('input')].find((input) =>
                /width/i.test(`${input.id} ${input.name} ${input.closest('label')?.textContent || ''}`)
              );

              const rectangle = geometry.createShapePath('rectangle', { x: 256, y: 192 }, {
                size: 3,
                color: '#ffffff'
              });
              rectangle.snapToGrid = true;
              rectangle.snapToObjects = false;
              geometry.updateShapeDraft(rectangle, { x: 384, y: 288 });
              geometry.finalizeSmartShape(rectangle);
              state.paths.push(rectangle);
              window.setTool('select');
              window.Inkyscib.Selection.selectIndex(0);
              geometry.syncInspector(true);

              const gridStart = { ...rectangle.points[0] };
              const gridDown = window.Inkyscib.Selection.handleDown(eventAt(gridStart.x, gridStart.y));
              window.Inkyscib.Selection.handleMove(eventAt(242, 178));
              const gridSnapKind = state.selection.smartAction?.snap?.kind || null;
              const snappedBeforeUp = { ...state.paths[0].points[0] };
              window.Inkyscib.Selection.handleUp();
              const gridMetrics = geometry.measureGeometry(state.paths[0]);

              const widthInput = findWidthInput();
              if (widthInput) {
                widthInput.focus();
                widthInput.value = '4.37';
                widthInput.dispatchEvent(new Event('input', { bubbles: true }));
                widthInput.dispatchEvent(new Event('change', { bubbles: true }));
                widthInput.blur();
              }
              const typedWidth = geometry.measureGeometry(state.paths[0]).sides[0];

              state.paths = [];
              window.Inkyscib.Selection.clear({ render: false });
              const source = geometry.createShapePath('triangle', { x: 190, y: 185 }, {
                size: 3,
                color: '#ffffff',
                triangleType: 'custom'
              });
              source.snapToGrid = false;
              source.snapToObjects = true;
              geometry.updateShapeDraft(source, { x: 350, y: 330 });
              geometry.finalizeSmartShape(source);
              const target = geometry.createCirclePath({ x: 520, y: 260 }, {
                size: 3,
                color: '#ffffff',
                snapToGrid: false,
                snapToObjects: false
              });
              geometry.setCircleGeometry(target, { x: 520, y: 260 }, 64, 0);
              state.paths.push(source, target);
              window.setTool('select');
              window.Inkyscib.Selection.selectIndex(0);
              geometry.syncInspector(true);

              const objectStart = { ...source.points[0] };
              const objectDown = window.Inkyscib.Selection.handleDown(
                eventAt(objectStart.x, objectStart.y)
              );
              window.Inkyscib.Selection.handleMove(eventAt(523, 258));
              const objectSnapKind = state.selection.smartAction?.snap?.kind || null;
              const objectSnappedPoint = { ...state.paths[0].points[0] };
              window.Inkyscib.Selection.handleUp();

              return {
                gridDown,
                gridSnapKind,
                snappedBeforeUp,
                halfUnitX: snappedBeforeUp.x / 16,
                halfUnitY: snappedBeforeUp.y / 16,
                halfUnitWidth: gridMetrics.sides[0] * 2,
                halfUnitHeight: gridMetrics.sides[1] * 2,
                widthInputFound: !!widthInput,
                typedWidth,
                typedDistanceFromHalfUnit: Math.abs(typedWidth * 2 - Math.round(typedWidth * 2)),
                objectDown,
                objectSnapKind,
                objectSnappedPoint,
                targetCenter: geometry.circleCenter(target),
                gridLabel: document.getElementById('geometryGridSnapLabel').textContent,
                objectLabel: document.getElementById('geometryObjectSnapLabel').textContent
              };
            }
            """
        )

        self.assertTrue(result["gridDown"])
        self.assertEqual(result["gridSnapKind"], "grid")
        self.assertAlmostEqual(result["halfUnitX"], round(result["halfUnitX"]), places=9)
        self.assertAlmostEqual(result["halfUnitY"], round(result["halfUnitY"]), places=9)
        self.assertAlmostEqual(result["halfUnitWidth"], round(result["halfUnitWidth"]), places=9)
        self.assertAlmostEqual(result["halfUnitHeight"], round(result["halfUnitHeight"]), places=9)
        self.assertTrue(result["widthInputFound"], result)
        self.assertAlmostEqual(result["typedWidth"], 4.37, places=8)
        self.assertGreater(result["typedDistanceFromHalfUnit"], 0.1)
        self.assertTrue(result["objectDown"])
        self.assertEqual(result["objectSnapKind"], "object")
        self.assertAlmostEqual(
            result["objectSnappedPoint"]["x"], result["targetCenter"]["x"], places=9
        )
        self.assertAlmostEqual(
            result["objectSnappedPoint"]["y"], result["targetCenter"]["y"], places=9
        )
        self.assertIn("grid", result["gridLabel"].lower())
        self.assertIn("object", result["objectLabel"].lower())

    def test_triangle_side_edit_keeps_input_focused_and_commits_on_blur(self):
        page = self.open_page()
        result = page.evaluate(
            """
            async () => {
              const state = window.appState;
              const geometry = window.Inkyscib.SmartGeometry;
              state.transform = { scale: 1, offsetX: 0, offsetY: 0 };
              state.notebook.active = false;
              state.ppt.active = false;

              const outcomes = [];
              for (const [caseIndex, triangleType] of ['isosceles', 'right'].entries()) {
                state.paths = [];
                state.undoStack = [];
                state.redoStack = [];
                window.Inkyscib.Selection.clear({ render: false });
                const start = { x: 230 + caseIndex * 30, y: 165 + caseIndex * 20 };
                const path = geometry.createShapePath('triangle', start, {
                  size: 3,
                  color: '#ffffff',
                  triangleType
                });
                path.snapToGrid = false;
                path.snapToObjects = false;
                geometry.updateShapeDraft(path, { x: start.x + 185, y: start.y + 155 });
                geometry.finalizeSmartShape(path);
                state.paths.push(path);
                window.setTool('select');
                window.Inkyscib.Selection.selectIndex(0);
                geometry.syncInspector(true);

                const input = document.getElementById('geometryDimensionSideABInput');
                const originalSave = window.saveDrawing;
                let saveCalls = 0;
                window.saveDrawing = (...args) => {
                  saveCalls += 1;
                  return originalSave.apply(window, args);
                };
                const undoBefore = state.undoStack.length;
                const desiredSide = caseIndex === 0 ? 4.125 : 5.375;
                input.focus();
                const focusedBeforeInput = document.activeElement === input;
                input.value = String(desiredSide);
                input.dispatchEvent(new Event('input', { bubbles: true }));

                const currentInput = document.getElementById('geometryDimensionSideABInput');
                const connectedAfterInput = input.isConnected;
                const sameNodeAfterInput = currentInput === input;
                const focusedAfterInput = document.activeElement === input;
                const sideAfterInput = geometry.measureGeometry(state.paths[0]).sideAB;
                const typeAfterInput = state.paths[0].triangleType;

                input.blur();
                await Promise.resolve();
                const undoAfterBlur = state.undoStack.length;
                const focusedAfterBlur = document.activeElement === input;
                window.saveDrawing = originalSave;

                outcomes.push({
                  triangleType,
                  inputExists: !!input,
                  focusedBeforeInput,
                  connectedAfterInput,
                  sameNodeAfterInput,
                  focusedAfterInput,
                  focusedAfterBlur,
                  desiredSide,
                  sideAfterInput,
                  typeAfterInput,
                  undoDelta: undoAfterBlur - undoBefore,
                  saveCalls,
                  redoCount: state.redoStack.length,
                  ariaInvalid: input.getAttribute('aria-invalid')
                });
              }
              return outcomes;
            }
            """
        )

        self.assertEqual([item["triangleType"] for item in result], ["isosceles", "right"])
        for item in result:
            self.assertTrue(item["inputExists"], item)
            self.assertTrue(item["focusedBeforeInput"], item)
            self.assertTrue(item["connectedAfterInput"], item)
            self.assertTrue(item["sameNodeAfterInput"], item)
            self.assertTrue(item["focusedAfterInput"], item)
            self.assertFalse(item["focusedAfterBlur"], item)
            self.assertAlmostEqual(item["sideAfterInput"], item["desiredSide"], places=9)
            self.assertIn(item["typeAfterInput"], {item["triangleType"], "custom"})
            self.assertEqual(item["undoDelta"], 1, item)
            self.assertGreaterEqual(item["saveCalls"], 1, item)
            self.assertEqual(item["redoCount"], 0)
            self.assertEqual(item["ariaInvalid"], "false")

    def test_rotation_input_native_validity_accepts_decimal_degrees(self):
        page = self.open_page()
        result = page.evaluate(
            """
            () => {
              const state = window.appState;
              const geometry = window.Inkyscib.SmartGeometry;
              state.paths = [];
              state.transform = { scale: 1, offsetX: 0, offsetY: 0 };
              state.notebook.active = false;
              state.ppt.active = false;

              const path = geometry.createShapePath('rectangle', { x: 245, y: 180 }, {
                size: 3,
                color: '#ffffff'
              });
              path.snapToGrid = false;
              path.snapToObjects = false;
              geometry.updateShapeDraft(path, { x: 435, y: 325 });
              geometry.finalizeSmartShape(path);
              state.paths.push(path);
              window.setTool('select');
              window.Inkyscib.Selection.selectIndex(0);
              geometry.syncInspector(true);

              const input = document.getElementById('geometryRotationInput');
              input.focus();
              input.value = '37.5';
              const validityBeforeInput = input.validity.valid;
              const stepMismatchBeforeInput = input.validity.stepMismatch;
              const checkValidityBeforeInput = input.checkValidity();
              input.dispatchEvent(new Event('input', { bubbles: true }));
              const edgeAngle = Math.atan2(
                state.paths[0].points[1].y - state.paths[0].points[0].y,
                state.paths[0].points[1].x - state.paths[0].points[0].x
              ) * 180 / Math.PI;
              input.blur();

              return {
                inputType: input.type,
                step: input.step,
                value: input.value,
                validityBeforeInput,
                stepMismatchBeforeInput,
                checkValidityBeforeInput,
                validityAfterInput: input.validity.valid,
                stepMismatchAfterInput: input.validity.stepMismatch,
                badInput: input.validity.badInput,
                ariaInvalid: input.getAttribute('aria-invalid'),
                edgeAngle
              };
            }
            """
        )

        self.assertEqual(result["inputType"], "number")
        self.assertEqual(result["value"], "37.5")
        self.assertTrue(result["validityBeforeInput"])
        self.assertFalse(result["stepMismatchBeforeInput"])
        self.assertTrue(result["checkValidityBeforeInput"])
        self.assertTrue(result["validityAfterInput"])
        self.assertFalse(result["stepMismatchAfterInput"])
        self.assertFalse(result["badInput"])
        self.assertEqual(result["ariaInvalid"], "false")
        self.assertAlmostEqual(result["edgeAngle"], 37.5, places=8)

    def test_object_snap_stays_exact_after_circle_and_rectangle_solvers(self):
        page = self.open_page()
        result = page.evaluate(
            """
            () => {
              const state = window.appState;
              const geometry = window.Inkyscib.SmartGeometry;
              const canvas = document.getElementById('drawingCanvas');
              const rect = canvas.getBoundingClientRect();
              state.transform = { scale: 1, offsetX: 0, offsetY: 0 };
              state.notebook.active = false;
              state.ppt.active = false;

              const eventAt = (x, y) => ({
                clientX: rect.left + x * rect.width / canvas.width,
                clientY: rect.top + y * rect.height / canvas.height,
                pointerType: 'mouse',
                timeStamp: performance.now()
              });
              const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
              const selectOnly = (index) => {
                window.setTool('select');
                window.Inkyscib.Selection.selectIndex(index);
                geometry.syncInspector(true);
              };

              state.paths = [];
              window.Inkyscib.Selection.clear({ render: false });
              const sourceCircle = geometry.createCirclePath({ x: 240, y: 240 }, {
                size: 3,
                color: '#ffffff',
                snapToGrid: false,
                snapToObjects: false
              });
              geometry.setCircleGeometry(sourceCircle, { x: 240, y: 240 }, 64, 0);
              sourceCircle.snapToGrid = true;
              sourceCircle.snapToObjects = true;
              const circleAnchor = { x: 361.25, y: 267.75 };
              const circleTarget = geometry.createCirclePath(circleAnchor, {
                size: 2,
                color: '#5eead4',
                snapToGrid: false,
                snapToObjects: false
              });
              geometry.setCircleGeometry(circleTarget, circleAnchor, 38, 0);
              state.paths.push(sourceCircle, circleTarget);
              selectOnly(0);

              const circleGridOn = document.getElementById('geometrySnapGrid').checked;
              const circleObjectsOn = document.getElementById('geometrySnapObjects').checked;
              const radiusStart = geometry.pointOnCircle(
                sourceCircle,
                Number.isFinite(sourceCircle.radiusAngle) ? sourceCircle.radiusAngle : 0
              );
              const circleDown = window.Inkyscib.Selection.handleDown(
                eventAt(radiusStart.x, radiusStart.y)
              );
              const circleHandleType = state.selection.smartAction?.handle?.type || null;
              window.Inkyscib.Selection.handleMove(
                eventAt(circleAnchor.x + 2.25, circleAnchor.y - 1.5)
              );
              const circleSnapKind = state.selection.smartAction?.snap?.kind || null;
              const finalRadiusHandle = geometry.pointOnCircle(
                state.paths[0],
                Number.isFinite(state.paths[0].radiusAngle) ? state.paths[0].radiusAngle : 0
              );
              const circleHandleError = distance(finalRadiusHandle, circleAnchor);
              window.Inkyscib.Selection.handleUp();

              state.paths = [];
              window.Inkyscib.Selection.clear({ render: false });
              const rectangle = geometry.createShapePath('rectangle', { x: 210, y: 155 }, {
                size: 3,
                color: '#ffffff',
                snapToGrid: false,
                snapToObjects: false
              });
              geometry.updateShapeDraft(rectangle, { x: 385, y: 305 });
              geometry.finalizeSmartShape(rectangle);
              rectangle.snapToGrid = true;
              rectangle.snapToObjects = true;
              const rectangleAnchor = { x: 517.375, y: 349.625 };
              const rectangleTarget = geometry.createCirclePath(rectangleAnchor, {
                size: 2,
                color: '#5eead4',
                snapToGrid: false,
                snapToObjects: false
              });
              geometry.setCircleGeometry(rectangleTarget, rectangleAnchor, 41, 0);
              state.paths.push(rectangle, rectangleTarget);
              selectOnly(0);

              const rectangleGridOn = document.getElementById('geometrySnapGrid').checked;
              const rectangleObjectsOn = document.getElementById('geometrySnapObjects').checked;
              const vertexIndex = 2;
              const vertexStart = { ...rectangle.points[vertexIndex] };
              const rectangleDown = window.Inkyscib.Selection.handleDown(
                eventAt(vertexStart.x, vertexStart.y)
              );
              const rectangleHandleType = state.selection.smartAction?.handle?.type || null;
              window.Inkyscib.Selection.handleMove(
                eventAt(rectangleAnchor.x - 1.75, rectangleAnchor.y + 2.25)
              );
              const rectangleSnapKind = state.selection.smartAction?.snap?.kind || null;
              const finalVertex = { ...state.paths[0].points[vertexIndex] };
              const rectangleHandleError = distance(finalVertex, rectangleAnchor);
              window.Inkyscib.Selection.handleUp();

              return {
                circle: {
                  gridOn: circleGridOn,
                  objectsOn: circleObjectsOn,
                  downHandled: circleDown,
                  handleType: circleHandleType,
                  snapKind: circleSnapKind,
                  handleError: circleHandleError,
                  finalHandle: finalRadiusHandle,
                  anchor: circleAnchor
                },
                rectangle: {
                  gridOn: rectangleGridOn,
                  objectsOn: rectangleObjectsOn,
                  downHandled: rectangleDown,
                  handleType: rectangleHandleType,
                  snapKind: rectangleSnapKind,
                  handleError: rectangleHandleError,
                  finalHandle: finalVertex,
                  anchor: rectangleAnchor
                }
              };
            }
            """
        )

        self.assertTrue(result["circle"]["gridOn"], result["circle"])
        self.assertTrue(result["circle"]["objectsOn"], result["circle"])
        self.assertTrue(result["circle"]["downHandled"], result["circle"])
        self.assertEqual(result["circle"]["handleType"], "radius")
        self.assertEqual(result["circle"]["snapKind"], "object")
        self.assertLess(result["circle"]["handleError"], 1e-8, result["circle"])

        self.assertTrue(result["rectangle"]["gridOn"], result["rectangle"])
        self.assertTrue(result["rectangle"]["objectsOn"], result["rectangle"])
        self.assertTrue(result["rectangle"]["downHandled"], result["rectangle"])
        self.assertEqual(result["rectangle"]["handleType"], "vertex")
        self.assertEqual(result["rectangle"]["snapKind"], "object")
        self.assertLess(result["rectangle"]["handleError"], 1e-8, result["rectangle"])


if __name__ == "__main__":
    unittest.main()
