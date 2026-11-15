"""The Shape tool's picker: every kind, told apart at a glance.

Reported: "the shape tool should have more options and more tools, and
differentiation should be easy among the other shapes." The picker was seven
icon-only buttons - a Font Awesome square for the square, a play glyph turned
on its side for the triangle - with the triangle's types hidden in a second
section that only appeared once a triangle was chosen.

It is now fifteen labelled buttons in four groups, each drawn to show what
separates it from its neighbours, with the triangle types as buttons of their
own, plus fill and outline choices. These tests hold the structure, the touch
targets on the tablet and in the dock, what a tap writes, and that the
choices survive a reload. Geometry is covered by test_shape_kinds.py and
test_shape_style.py.
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


GROUPS = [
    ("Round", [("circle", None, "Circle"), ("ellipse", None, "Ellipse")]),
    # Isosceles first: it is the default type, so a plain
    # `.shape-btn[data-shape="triangle"]` still picks what it always did.
    ("Triangles", [
        ("triangle", "isosceles", "Isosceles"),
        ("triangle", "equilateral", "Equilateral"),
        ("triangle", "right", "Right"),
        ("triangle", "custom", "Custom"),
    ]),
    ("Quadrilaterals", [
        ("square", None, "Square"),
        ("rectangle", None, "Rectangle"),
        ("parallelogram", None, "Parallelogram"),
        ("rhombus", None, "Rhombus"),
        ("kite", None, "Kite"),
        ("trapezium", None, "Trapezium"),
    ]),
    ("Polygons", [("pentagon", None, "Pentagon"), ("hexagon", None, "Hexagon"), ("octagon", None, "Octagon")]),
]
BUTTONS = [button for _, buttons in GROUPS for button in buttons]

LAYOUTS = {
    "floating": {"width": 960, "height": 720},
    "docked": {"width": 1440, "height": 900},
}


@unittest.skipUnless(PLAYWRIGHT_AVAILABLE, "Playwright is not installed")
class ShapePickerTests(unittest.TestCase):
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

    def open_page(self, layout="docked"):
        context = self.browser.new_context(viewport=LAYOUTS[layout])
        self.addCleanup(context.close)
        page = context.new_page()
        page.set_default_timeout(15000)
        self.errors = []
        page.on("pageerror", lambda error: self.errors.append(str(error)))
        page.add_init_script("localStorage.setItem('inkyscib-consent-v1', JSON.stringify({version: 1, analytics: false})); localStorage.setItem('inkyscib-feature-tour-v1', 'seen')")
        page.goto(self.base_url + "/write", wait_until="domcontentloaded")
        self.show_panel(page)
        return page

    def show_panel(self, page):
        page.wait_for_function("() => window.appState?.storageReady === true && !!window.Inkyscib?.ToolDock")
        page.evaluate("() => { window.setTool('shape'); window.Inkyscib.ToolDock.setCollapsed(false); }")
        page.wait_for_function("() => getComputedStyle(document.getElementById('shapeOptions')).display !== 'none'")

    def test_fifteen_labelled_shapes_in_four_groups(self):
        page = self.open_page()
        structure = page.evaluate(
            """() => [...document.querySelectorAll('#shapeOptions .shape-group')].map(group => ({
                 heading: group.querySelector('.shape-group-heading')?.textContent.trim(),
                 buttons: [...group.querySelectorAll('.shape-btn')].map(button => ({
                   shape: button.dataset.shape,
                   triangleType: button.dataset.triangleType || null,
                   label: button.querySelector('.shape-btn-label')?.textContent.replace(/\\u00ad/g, '').trim(),
                   icon: button.querySelector('svg')?.innerHTML.replace(/\\s+/g, ' ').trim() || ''
                 }))
               }))"""
        )
        self.assertEqual([group["heading"] for group in structure], [name for name, _ in GROUPS])
        for (name, expected), group in zip(GROUPS, structure):
            with self.subTest(group=name):
                got = [(b["shape"], b["triangleType"], b["label"]) for b in group["buttons"]]
                self.assertEqual(got, list(expected))
        icons = [b["icon"] for group in structure for b in group["buttons"]]
        self.assertTrue(all(icons), "every shape has a drawn icon")
        self.assertEqual(len(set(icons)), len(BUTTONS), "no two shapes share an icon")
        self.assertEqual(self.errors, [])

    def check_touch_and_fit(self, layout):
        page = self.open_page(layout)
        result = page.evaluate(
            """() => {
              const panel = document.getElementById('shapeOptions');
              const small = [...panel.querySelectorAll('.shape-btn, .shape-style-option')]
                .map(el => ({ id: (el.dataset.shape || '') + (el.dataset.triangleType || '') + (el.dataset.fill || '') + (el.dataset.dash || ''),
                              box: el.getBoundingClientRect() }))
                .filter(item => item.box.width < 44 || item.box.height < 44)
                .map(item => `${item.id} ${Math.round(item.box.width)}x${Math.round(item.box.height)}`);
              const scroller = panel.classList.contains('is-docked') ? document.getElementById('toolDockBody') : panel;
              return { small, overflow: scroller.scrollWidth - scroller.clientWidth,
                       styles: panel.querySelectorAll('.shape-style-option').length };
            }"""
        )
        self.assertEqual(result["small"], [], f"{layout}: controls under 44px")
        self.assertLessEqual(result["overflow"], 1, f"{layout}: the panel scrolls sideways")
        self.assertEqual(result["styles"], 6, "three fills and three outlines")
        self.assertEqual(self.errors, [])

    def test_every_control_is_a_real_touch_target_when_floating(self):
        self.check_touch_and_fit("floating")

    def test_every_control_is_a_real_touch_target_in_the_dock(self):
        self.check_touch_and_fit("docked")

    def test_a_tap_picks_the_shape_and_the_rail_shows_it(self):
        page = self.open_page()
        for shape, triangle_type, label in BUTTONS:
            with self.subTest(shape=label):
                selector = f'#shapeOptions .shape-btn[data-shape="{shape}"]'
                if triangle_type:
                    selector += f'[data-triangle-type="{triangle_type}"]'
                page.click(selector)
                state = page.evaluate(
                    """() => ({
                      shape: window.appState.toolSettings.shape.shapeType,
                      triangleType: window.appState.toolSettings.shape.triangleType,
                      pressed: [...document.querySelectorAll('#shapeOptions .shape-btn[aria-pressed="true"]')]
                        .map(b => (b.dataset.shape) + (b.dataset.triangleType ? ':' + b.dataset.triangleType : '')),
                      rail: [...document.querySelectorAll('#shapeTool .shape-tool-svg')]
                        .filter(svg => getComputedStyle(svg).display !== 'none')
                        .map(svg => [...svg.classList].find(name => name !== 'shape-tool-svg'))
                    })"""
                )
                self.assertEqual(state["shape"], shape)
                expected_key = shape + (f":{triangle_type}" if triangle_type else "")
                if triangle_type:
                    self.assertEqual(state["triangleType"], triangle_type)
                self.assertEqual(state["pressed"], [expected_key], "exactly one shape is chosen")
                rail_class = f"shape-tool-triangle-{triangle_type}" if triangle_type else f"shape-tool-{shape}"
                self.assertEqual(state["rail"], [rail_class], "the rail button shows the chosen shape")
        self.assertEqual(self.errors, [])

    def test_fill_and_outline_choices_stick_across_a_reload(self):
        page = self.open_page()
        page.click('#shapeOptions .shape-style-option[data-fill="tint"]')
        page.click('#shapeOptions .shape-style-option[data-dash="dashed"]')
        page.click('#shapeOptions .shape-btn[data-shape="hexagon"]')
        read = """() => ({
          fill: window.appState.toolSettings.shape.fill,
          dash: window.appState.toolSettings.shape.dash,
          shape: window.appState.toolSettings.shape.shapeType,
          fillPressed: document.querySelector('#shapeOptions .shape-style-option[data-fill][aria-pressed="true"]')?.dataset.fill,
          dashPressed: document.querySelector('#shapeOptions .shape-style-option[data-dash][aria-pressed="true"]')?.dataset.dash
        })"""
        before = page.evaluate(read)
        page.reload(wait_until="domcontentloaded")
        self.show_panel(page)
        after = page.evaluate(read)
        expected = {"fill": "tint", "dash": "dashed", "shape": "hexagon", "fillPressed": "tint", "dashPressed": "dashed"}
        self.assertEqual(before, expected)
        self.assertEqual(after, expected)
        self.assertEqual(self.errors, [])

    def test_older_selectors_still_pick_a_triangle(self):
        """test_smart_geometry.py clicks these; they must keep choosing triangles."""
        page = self.open_page()
        result = page.evaluate(
            """() => {
              document.querySelector('.shape-btn[data-shape="triangle"]').click();
              const first = [window.appState.toolSettings.shape.shapeType, window.appState.toolSettings.shape.triangleType];
              document.querySelector('.triangle-type-btn[data-triangle-type="equilateral"]').click();
              return { first, shape: window.appState.toolSettings.shape.shapeType,
                       type: window.appState.toolSettings.shape.triangleType };
            }"""
        )
        self.assertEqual(result, {"first": ["triangle", "isosceles"], "shape": "triangle", "type": "equilateral"})
        self.assertEqual(self.errors, [])


if __name__ == "__main__":
    unittest.main()
