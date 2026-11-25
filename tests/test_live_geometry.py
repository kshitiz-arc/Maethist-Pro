"""Live geometry (static/js/tools/select.js, followMovedPoints, 2.9.2).

Drag a point and what is attached to it follows: a segment or line joined to
it keeps that end on it, an arc drawn about it keeps its centre there. Undo
puts the whole figure back.
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

BUILD = """() => { const C = window.Inkyscib.Construction;
  window.appState.paths = [];
  C.rebuildIndex(true);
  const a = C.createPoint({ x: 400, y: 400 });
  const b = C.createPoint({ x: 600, y: 400 });
  C.createSegment(a.points[0], b.points[0], { startPointId: a.gid, endPointId: b.gid });
  C.createArc(a.points[0], 120, 0, Math.PI, { centerId: a.gid });
  window.appState.paths.push({ tool: 'line', size: 2, color: '#000', points: [{ x: 600, y: 400 }, { x: 600, y: 250 }],
    lineType: 'solid', lineKind: 'segment', startPointId: b.gid, timestamp: Date.now() });
  window.render?.();
  return { a: a.gid, b: b.gid }; }"""

STATE = """() => window.appState.paths.map((p) => ({ kind: p.geomType || p.tool,
  first: p.points[0] && [Math.round(p.points[0].x), Math.round(p.points[0].y)],
  last: p.points.at(-1) && [Math.round(p.points.at(-1).x), Math.round(p.points.at(-1).y)] }))"""


@unittest.skipUnless(PLAYWRIGHT_AVAILABLE, "Playwright is not installed")
class LiveGeometryTests(unittest.TestCase):
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

    def open(self):
        context = self.browser.new_context(viewport={"width": 1440, "height": 900})
        self.addCleanup(context.close)
        context.add_init_script("localStorage.setItem('inkyscib-feature-tour-v1', 'seen')")
        page = context.new_page()
        self.errors = []
        page.on("pageerror", lambda error: self.errors.append(str(error)))
        page.goto(self.base_url + "/write", wait_until="domcontentloaded")
        page.wait_for_function("() => window.appState?.storageReady === true && !!window.Inkyscib?.Construction && !!window.Inkyscib?.Selection")
        page.wait_for_timeout(300)
        return page

    def drag_point(self, page, gid, dx, dy):
        """Press on the point with the Select tool and drag, as a person does."""
        start = page.evaluate("""(gid) => { const t = window.appState.transform; const c = document.getElementById('drawingCanvas').getBoundingClientRect();
          const p = window.Inkyscib.Construction.get(gid).points[0];
          return [c.left + p.x * t.scale + t.offsetX, c.top + p.y * t.scale + t.offsetY]; }""", gid)
        page.evaluate("() => { window.setTool('select'); window.Inkyscib.ToolDock?.setCollapsed?.(true); }")
        page.mouse.move(*start)
        page.mouse.down()
        for step in range(1, 9):
            page.mouse.move(start[0] + dx * step / 8, start[1] + dy * step / 8)
        page.mouse.up()
        page.wait_for_timeout(100)

    def test_dragging_a_point_carries_what_is_attached_to_it(self):
        page = self.open()
        ids = page.evaluate(BUILD)
        self.drag_point(page, ids["a"], 0, 100)
        state = page.evaluate(STATE)
        by_kind = {s["kind"]: s for s in state}
        point_a = page.evaluate("(gid) => { const p = window.Inkyscib.Construction.get(gid).points[0]; return [Math.round(p.x), Math.round(p.y)]; }", ids["a"])
        self.assertNotEqual(point_a, [400, 400], "the point moved")
        self.assertGreater(point_a[1], 430, "downward, with the pointer")
        self.assertEqual(by_kind["segment"]["first"], point_a, "the segment's end followed it exactly")
        self.assertEqual(by_kind["segment"]["last"], [600, 400], "and its other end stayed put")
        self.assertEqual(by_kind["arc"]["first"], point_a, "the arc's centre followed it")
        self.assertEqual(self.errors, [])

    def test_a_line_joined_to_a_point_follows_it_and_undo_restores_all(self):
        page = self.open()
        ids = page.evaluate(BUILD)
        before = page.evaluate(STATE)
        self.drag_point(page, ids["b"], 50, 0)
        line = next(s for s in page.evaluate(STATE) if s["kind"] == "line")
        point_b = page.evaluate("(gid) => { const p = window.Inkyscib.Construction.get(gid).points[0]; return [Math.round(p.x), Math.round(p.y)]; }", ids["b"])
        self.assertGreater(point_b[0], 615, "the point moved right")
        self.assertEqual(line["first"], point_b, "a pen line drawn to the point follows it")
        self.assertEqual(line["last"], [600, 250], "and its free end stays where it was")
        page.evaluate("() => window.undo()")
        page.wait_for_timeout(100)
        self.assertEqual(page.evaluate(STATE), before, "one undo puts the whole figure back")


if __name__ == "__main__":
    unittest.main()
