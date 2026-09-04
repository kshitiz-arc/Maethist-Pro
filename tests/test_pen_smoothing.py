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
class PenSmoothingBrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = make_server("127.0.0.1", 0, app, threaded=True)
        cls.server_thread = threading.Thread(
            target=cls.server.serve_forever,
            daemon=True,
        )
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
        context = self.browser.new_context()
        self.addCleanup(context.close)
        page = context.new_page()
        page.goto(self.base_url + "/write", wait_until="domcontentloaded")
        page.wait_for_function("() => window.appState?.storageReady === true")
        return page

    def test_mouse_handwriting_filters_jitter_without_losing_the_endpoint(self):
        page = self.open_page()
        result = page.evaluate(
            """
            () => {
              const events = window.Inkyscib.Events;
              const state = window.appState;
              state.paths = [];
              state.transform = { scale: 1, offsetX: 0, offsetY: 0 };
              state.notebook.active = false;
              state.ppt.active = false;
              window.setTool('pen');

              const raw = Array.from({ length: 18 }, (_, index) => ({
                clientX: 400 + index * 5,
                clientY: 280 + (index % 2 ? 2.4 : -2.4),
                timeStamp: index * 8,
                pointerType: 'mouse'
              }));
              events.startDrawing(raw[0]);
              raw.slice(1).forEach((point) => events.continueDrawing(point));
              events.endDrawing();

              const path = state.paths[0];
              const rawWorld = raw.map((point) => window.getCanvasPos(point));
              const roughness = (points) => points.slice(2).reduce((total, point, index) => {
                const a = points[index];
                const b = points[index + 1];
                return total + Math.abs(point.y - b.y * 2 + a.y);
              }, 0);
              return {
                rawRoughness: roughness(rawWorld),
                inkRoughness: roughness(path.points.slice(0, -1)),
                finalX: path.points[path.points.length - 1].x,
                expectedFinalX: rawWorld[rawWorld.length - 1].x,
                transientStateSaved: Object.prototype.hasOwnProperty.call(path, '__inkInput')
              };
            }
            """
        )

        self.assertLess(result["inkRoughness"], result["rawRoughness"] * 0.45)
        self.assertGreater(result["finalX"], result["expectedFinalX"] - 3)
        self.assertFalse(result["transientStateSaved"])

    def test_line_tool_keeps_exact_geometry(self):
        page = self.open_page()
        points = page.evaluate(
            """
            () => {
              const events = window.Inkyscib.Events;
              window.appState.paths = [];
              window.appState.transform = { scale: 1, offsetX: 0, offsetY: 0 };
              window.appState.notebook.active = false;
              window.appState.ppt.active = false;
              window.setTool('line');
              const start = { clientX: 400, clientY: 250, timeStamp: 0 };
              const end = { clientX: 600, clientY: 375, timeStamp: 16 };
              const expected = [window.getCanvasPos(start), window.getCanvasPos(end)];
              events.startDrawing(start);
              events.continueDrawing(end);
              events.endDrawing();
              return { points: window.appState.paths[0].points, expected };
            }
            """
        )

        actual_xy = [{"x": point["x"], "y": point["y"]} for point in points["points"]]
        self.assertEqual(actual_xy, points["expected"])

    def test_first_four_pen_styles_have_distinct_stroke_signatures(self):
        page = self.open_page()
        metrics = page.evaluate(
            """
            () => {
              function render(style, points) {
                const canvas = document.createElement('canvas');
                canvas.width = 220;
                canvas.height = 220;
                const ctx = canvas.getContext('2d');
                window.drawInkyscibPathForExport(ctx, {
                  tool: 'pen', penStyle: style, color: '#ffffff', size: 8, points
                });
                const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
                const opaque = (x, y) => pixels[(y * canvas.width + x) * 4 + 3] > 48;
                return {
                  atX(x) {
                    let count = 0;
                    for (let y = 0; y < canvas.height; y++) count += opaque(x, y) ? 1 : 0;
                    return count;
                  },
                  atY(y) {
                    let count = 0;
                    for (let x = 0; x < canvas.width; x++) count += opaque(x, y) ? 1 : 0;
                    return count;
                  }
                };
              }

              const horizontal = Array.from({ length: 33 }, (_, i) => ({
                x: 30 + i * 5, y: 110, pressure: 0.55, time: i * 8
              }));
              const vertical = Array.from({ length: 33 }, (_, i) => ({
                x: 110, y: 30 + i * 5, pressure: 0.55, time: i * 8
              }));
              const brush = Array.from({ length: 33 }, (_, i) => ({
                x: 30 + i * 5,
                y: 110,
                pressure: 0.55,
                time: i <= 16 ? i * 18 : 16 * 18 + (i - 16) * 3
              }));

              const fineliner = render('default', horizontal);
              const gel = render('gel', horizontal);
              const fountainHorizontal = render('fountain', horizontal);
              const fountainVertical = render('fountain', vertical);
              const brushStroke = render('brush', brush);
              return {
                fineliner: fineliner.atX(110),
                gel: gel.atX(110),
                fountainCross: fountainHorizontal.atX(110),
                fountainDown: fountainVertical.atY(110),
                brushSlow: brushStroke.atX(75),
                brushFast: brushStroke.atX(175)
              };
            }
            """
        )

        self.assertGreater(metrics["gel"], metrics["fineliner"] * 1.3)
        self.assertGreater(metrics["fountainDown"], metrics["fountainCross"] * 2)
        self.assertGreater(metrics["brushSlow"], metrics["brushFast"] * 1.5)


if __name__ == "__main__":
    unittest.main()
