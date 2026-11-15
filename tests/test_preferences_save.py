"""Tool preferences reach storage and come back after a reload.

Found while building the Shape tool's fill and outline choices: nothing a
teacher chose in any tool panel survived a reload. storage.js declared
`function savePreferences()` and then exported a debounced scheduler as
`window.savePreferences`. In a classic script those are the same global
binding, so the scheduler's timer called the scheduler, which rescheduled
itself every 220ms and never wrote. `window.savePreferencesNow` was assigned
after the swap and pointed at the scheduler too.
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


@unittest.skipUnless(PLAYWRIGHT_AVAILABLE, "Playwright is not installed")
class PreferencesSaveTests(unittest.TestCase):
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
        return page

    def test_the_exported_names_are_the_ones_they_say(self):
        page = self.open_page()
        names = page.evaluate(
            """() => ({
              save: window.savePreferences === window.schedulePreferencesSave,
              nowIsNotTheScheduler: window.savePreferencesNow !== window.schedulePreferencesSave,
              nowIsAFunction: typeof window.savePreferencesNow === 'function'
            })"""
        )
        self.assertEqual(names, {"save": True, "nowIsNotTheScheduler": True, "nowIsAFunction": True})
        self.assertEqual(self.errors, [])

    def test_a_debounced_save_is_written_once_input_stops(self):
        page = self.open_page()
        page.evaluate(
            """() => {
              window.appState.toolSettings.pen.size = 17;
              window.savePreferences();
              window.savePreferences();
            }"""
        )
        page.wait_for_function(
            "() => JSON.parse(localStorage.getItem('inkyscib_settings') || '{}')?.pen?.size === 17",
            timeout=3000,
        )
        self.assertEqual(self.errors, [])

    def test_a_choice_made_just_before_a_reload_survives_it(self):
        page = self.open_page()
        page.evaluate(
            """() => {
              window.appState.toolSettings.pen.size = 23;
              window.savePreferences();
            }"""
        )
        # Straight to a reload, inside the debounce window: the unload flush has
        # to carry it.
        page.reload(wait_until="domcontentloaded")
        page.wait_for_function("() => window.appState?.storageReady === true")
        self.assertEqual(page.evaluate("() => window.appState.toolSettings.pen.size"), 23)
        self.assertEqual(self.errors, [])


if __name__ == "__main__":
    unittest.main()
