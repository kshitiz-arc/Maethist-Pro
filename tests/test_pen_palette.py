import threading
import unittest

from app import app
from browser_server import make_browser_server


EXPECTED_PEN_COLORS = (
    "rgb(22, 240, 244)",
    "rgb(27, 230, 27)",
    "rgb(240, 240, 21)",
)


class PenPaletteMarkupTests(unittest.TestCase):
    def test_visual_pen_swatches_use_the_same_canvas_color_value(self):
        html = app.test_client().get("/write").get_data(as_text=True)

        for color in EXPECTED_PEN_COLORS:
            with self.subTest(color=color):
                self.assertIn(
                    f'data-color="{color}" style="background:{color}"',
                    html,
                )


try:
    from playwright.sync_api import sync_playwright

    PLAYWRIGHT_AVAILABLE = True
except ImportError:
    PLAYWRIGHT_AVAILABLE = False


@unittest.skipUnless(PLAYWRIGHT_AVAILABLE, "Playwright is not installed")
class PenPaletteBrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = make_browser_server(app)
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

    def open_page(self, init_script=None):
        context = self.browser.new_context()
        self.addCleanup(context.close)
        if init_script:
            context.add_init_script(init_script)
        page = context.new_page()
        page.goto(self.base_url + "/write", wait_until="domcontentloaded")
        page.wait_for_function("() => window.appState?.storageReady === true")
        return page

    def test_clicking_each_changed_swatch_sets_the_path_canvas_color(self):
        page = self.open_page()

        for color in EXPECTED_PEN_COLORS:
            with self.subTest(color=color):
                result = page.locator(
                    f'#penOptions .color-swatch[data-color="{color}"]'
                ).evaluate(
                    """
                    (swatch) => {
                      swatch.click();
                      return {
                        setting: window.appState.toolSettings.pen.color,
                        path: window.createPath({ x: 10, y: 10 }).color,
                        visual: swatch.style.backgroundColor
                      };
                    }
                    """
                )
                self.assertEqual(result["setting"], color)
                self.assertEqual(result["path"], color)
                self.assertEqual(result["visual"], color)

    def test_saved_legacy_color_name_moves_to_the_new_palette_value(self):
        page = self.open_page(
            """
            localStorage.setItem('inkyscib_settings', JSON.stringify({
              pen: { size: 2, color: 'blue', style: 'default' }
            }));
            localStorage.setItem('inkyscib_preferences_saved_at', '1');
            """
        )

        result = page.evaluate(
            """
            () => ({
              setting: window.appState.toolSettings.pen.color,
              path: window.createPath({ x: 10, y: 10 }).color
            })
            """
        )
        self.assertEqual(result["setting"], EXPECTED_PEN_COLORS[0])
        self.assertEqual(result["path"], EXPECTED_PEN_COLORS[0])


if __name__ == "__main__":
    unittest.main()
