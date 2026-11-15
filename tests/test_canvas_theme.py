"""Canvas theme presets.

The theme button used to flip the whole editor between light and dark, and
that was the only choice of canvas. It is now a Canvas popover with eight
presets and the pattern choice that used to be a button of its own.

A preset is a canvas, not a chrome theme: the menus and toolbars stay light or
dark on the DESIGN.md tokens, and each preset says which of the two it pairs
with. What a preset changes is the ground, the grid, notebook pages, and the
default pen colour - and those are what these tests look at, as pixels and
computed styles rather than as the attributes that are supposed to cause them.
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


PRESET_IDS = ["graphite", "paper", "chalkboard", "blueprint", "midnight", "cream", "whiteboard", "contrast"]

COLOUR_HELPERS = r"""
window.__colour = (() => {
  function rgb(value) {
    const probe = document.createElement('span');
    probe.style.color = value;
    document.body.appendChild(probe);
    const parsed = getComputedStyle(probe).color.match(/[\d.]+/g).map(Number);
    probe.remove();
    return parsed.slice(0, 3);
  }
  function luminance([r, g, b]) {
    const channel = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  }
  function contrast(a, b) {
    const [hi, lo] = [luminance(rgb(a)), luminance(rgb(b))].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  }
  return { rgb, contrast };
})();
"""


@unittest.skipUnless(PLAYWRIGHT_AVAILABLE, "Playwright is not installed")
class CanvasThemeTests(unittest.TestCase):
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

    def open_page(self, viewport=None, init_script=None):
        context = self.browser.new_context(viewport=viewport or {"width": 1440, "height": 900})
        self.addCleanup(context.close)
        page = context.new_page()
        page.set_default_timeout(15000)
        self.errors = []
        page.on("pageerror", lambda error: self.errors.append(str(error)))
        page.add_init_script("localStorage.setItem('inkyscib-consent-v1', JSON.stringify({version: 1, analytics: false})); localStorage.setItem('inkyscib-feature-tour-v1', 'seen')")
        if init_script:
            page.add_init_script(init_script)
        page.goto(self.base_url + "/write", wait_until="domcontentloaded")
        self.wait_ready(page)
        return page

    def wait_ready(self, page):
        page.wait_for_function("() => window.appState?.storageReady === true")
        page.wait_for_function("() => !!window.Inkyscib?.CanvasTheme")
        page.evaluate("() => {" + COLOUR_HELPERS + "return true; }")
        # A plain <style> rather than page.add_style_tag: after a reload the
        # page's analytics request trips its own CSP, and Playwright reported
        # that violation as a failure of add_style_tag.
        page.evaluate(
            """() => { const style = document.createElement('style');
                       style.textContent = '*{transition:none!important;animation:none!important}';
                       document.head.appendChild(style); }"""
        )

    def test_the_popover_offers_eight_presets_and_the_patterns(self):
        page = self.open_page()
        page.click("#themeToggle")
        page.wait_for_selector("#canvasThemePop", state="visible")
        result = page.evaluate(
            """() => {
              const pop = document.getElementById('canvasThemePop');
              return {
                presets: [...pop.querySelectorAll('[data-canvas-preset]')].map(b => b.dataset.canvasPreset),
                roles: [...pop.querySelectorAll('[data-canvas-preset]')].map(b => b.getAttribute('role')),
                labels: [...pop.querySelectorAll('[data-canvas-preset]')].map(b => b.textContent.trim()),
                patterns: [...pop.querySelectorAll('.pattern-option')].map(b => b.dataset.pattern),
                oldPatternButton: !!document.getElementById('patternBtn'),
                apiIds: window.Inkyscib.CanvasTheme.PRESETS.map(p => p.id)
              };
            }"""
        )
        self.assertEqual(result["presets"], PRESET_IDS)
        self.assertEqual(result["apiIds"], PRESET_IDS)
        self.assertEqual(set(result["roles"]), {"radio"})
        self.assertTrue(all(result["labels"]), "every preset carries its name")
        self.assertEqual(result["patterns"], ["dot", "lines", "graph"])
        self.assertFalse(result["oldPatternButton"], "the pattern choice moved into the popover")
        self.assertEqual(self.errors, [])

    def test_each_preset_repaints_the_ground_and_the_grid(self):
        page = self.open_page()
        results = page.evaluate(
            """(ids) => {
              const { rgb } = window.__colour;
              const state = window.appState;
              state.notebook.active = false;
              state.ppt.active = false;
              state.transform = { scale: 1, offsetX: 0, offsetY: 0 };
              document.documentElement.dataset.pattern = 'graph';
              const out = {};
              for (const id of ids) {
                window.Inkyscib.CanvasTheme.set(id);
                (window.renderNow || window.render)();
                const preset = window.Inkyscib.CanvasTheme.get();
                const canvas = document.getElementById('patternCanvas');
                const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
                let r = 0, g = 0, b = 0, n = 0;
                for (let i = 0; i < data.length; i += 4) {
                  if (data[i + 3] > 20) { r += data[i]; g += data[i + 1]; b += data[i + 2]; n++; }
                }
                out[id] = {
                  canvas: document.documentElement.dataset.canvas,
                  theme: document.documentElement.dataset.theme,
                  chrome: preset.chrome,
                  stage: rgb(getComputedStyle(document.querySelector('.workspace-stage')).backgroundColor),
                  ground: rgb(preset.ground),
                  gridPixels: n,
                  gridAverage: n ? [r / n, g / n, b / n] : null,
                  gridColour: rgb(preset.grid.minor),
                  checked: document.querySelector(`[data-canvas-preset="${id}"]`)?.getAttribute('aria-checked')
                };
              }
              return out;
            }""",
            PRESET_IDS,
        )
        for preset_id, r in results.items():
            with self.subTest(preset=preset_id):
                self.assertEqual(r["canvas"], preset_id)
                self.assertEqual(r["theme"], r["chrome"], "the chrome follows the preset's pairing")
                for got, want in zip(r["stage"], r["ground"]):
                    self.assertLessEqual(abs(got - want), 2, f"stage {r['stage']} is not ground {r['ground']}")
                self.assertGreater(r["gridPixels"], 1000, "the grid should be drawn")
                for got, want in zip(r["gridAverage"], r["gridColour"]):
                    self.assertLessEqual(abs(got - want), 16, f"grid {r['gridAverage']} is not {r['gridColour']}")
                self.assertEqual(r["checked"], "true")
        grounds = {tuple(r["ground"]) for r in results.values()}
        self.assertEqual(len(grounds), len(PRESET_IDS), "every preset is a different ground")
        self.assertEqual(self.errors, [])

    def test_notebook_pages_follow_the_preset(self):
        page = self.open_page()
        page.evaluate("() => document.getElementById('notebookModeToggle').click()")
        page.wait_for_function("() => window.appState.notebook.active === true")
        samples = page.evaluate(
            """() => {
              const { rgb } = window.__colour;
              document.documentElement.dataset.pattern = 'dot';
              const out = {};
              for (const id of ['cream', 'chalkboard']) {
                window.Inkyscib.CanvasTheme.set(id);
                (window.renderNow || window.render)();
                const s = window.appState;
                const canvas = document.getElementById('patternCanvas');
                const ratio = canvas.width / canvas.getBoundingClientRect().width;
                const worldX = (s.notebook.pageWidth || 794) / 2;
                const x = Math.round((worldX * s.transform.scale + s.transform.offsetX) * ratio);
                const y = Math.round((260 * s.transform.scale + s.transform.offsetY) * ratio);
                const block = canvas.getContext('2d').getImageData(x - 6, y - 6, 13, 13).data;
                const channels = [[], [], []];
                for (let i = 0; i < block.length; i += 4) for (let c = 0; c < 3; c++) channels[c].push(block[i + c]);
                const median = channels.map(values => values.sort((a, b) => a - b)[Math.floor(values.length / 2)]);
                out[id] = { pixel: median, page: rgb(window.Inkyscib.CanvasTheme.page().page) };
              }
              return out;
            }"""
        )
        for preset_id, sample in samples.items():
            with self.subTest(preset=preset_id):
                for got, want in zip(sample["pixel"], sample["page"]):
                    self.assertLessEqual(abs(got - want), 12, f"{sample}")
        self.assertNotEqual(samples["cream"]["page"], samples["chalkboard"]["page"])
        self.assertEqual(self.errors, [])

    def test_the_default_pen_follows_the_ground_and_a_chosen_colour_stays(self):
        page = self.open_page()
        result = page.evaluate(
            """() => {
              const theme = window.Inkyscib.CanvasTheme;
              const pen = window.appState.toolSettings.pen;
              const out = {};
              theme.set('graphite');
              pen.color = '#ffffff';
              theme.set('paper'); out.onPaper = pen.color;
              theme.set('chalkboard'); out.onChalkboard = pen.color;
              pen.color = '#ff5c8a';
              theme.set('whiteboard'); out.custom = pen.color;
              return out;
            }"""
        )
        self.assertEqual(result, {"onPaper": "#1b1b18", "onChalkboard": "#ffffff", "custom": "#ff5c8a"})
        self.assertEqual(self.errors, [])

    def test_the_default_ink_is_readable_on_every_ground(self):
        page = self.open_page()
        ratios = page.evaluate(
            """() => Object.fromEntries(window.Inkyscib.CanvasTheme.PRESETS.map(p =>
                 [p.id, window.__colour.contrast(p.ink, p.ground)]))"""
        )
        for preset_id, ratio in ratios.items():
            with self.subTest(preset=preset_id):
                self.assertGreaterEqual(ratio, 7.0, f"{preset_id}: {ratio:.2f}:1")
        self.assertEqual(self.errors, [])

    def test_the_choice_survives_a_reload_and_is_painted_before_the_scripts(self):
        # Records data-canvas the moment <body> exists: after the inline head
        # script, before any deferred script, so only a pre-paint stamp passes.
        # It observes the Document itself: init scripts run before <html> has
        # been parsed, so document.documentElement is still null here.
        record = """
          new MutationObserver((_, observer) => {
            if (document.body) {
              window.__canvasAtFirstPaint = document.documentElement.dataset.canvas || null;
              observer.disconnect();
            }
          }).observe(document, { childList: true, subtree: true });
        """
        page = self.open_page(init_script=record)
        page.evaluate("() => window.Inkyscib.CanvasTheme.set('blueprint')")
        page.reload(wait_until="domcontentloaded")
        self.wait_ready(page)
        result = page.evaluate(
            """() => ({ early: window.__canvasAtFirstPaint, now: document.documentElement.dataset.canvas,
                        theme: document.documentElement.dataset.theme })"""
        )
        self.assertEqual(result, {"early": "blueprint", "now": "blueprint", "theme": "dark"})
        self.assertEqual(self.errors, [])

    def test_patterns_still_switch_from_the_popover(self):
        page = self.open_page()
        page.click("#themeToggle")
        page.click('#canvasThemePop .pattern-option[data-pattern="lines"]')
        page.wait_for_function("() => document.documentElement.dataset.pattern === 'lines'")
        stored = page.evaluate("() => localStorage.getItem('inkyscib-pattern')")
        self.assertEqual(stored, "lines")
        self.assertEqual(self.errors, [])

    def test_the_popover_is_touch_sized_and_easy_to_dismiss(self):
        page = self.open_page(viewport={"width": 960, "height": 720})
        page.click("#themeToggle")
        page.wait_for_selector("#canvasThemePop", state="visible")
        small = page.evaluate(
            """() => [...document.querySelectorAll('#canvasThemePop [data-canvas-preset], #canvasThemePop .pattern-option')]
                .map(el => ({ id: el.dataset.canvasPreset || el.dataset.pattern, box: el.getBoundingClientRect() }))
                .filter(item => item.box.width < 44 || item.box.height < 44)
                .map(item => item.id)"""
        )
        self.assertEqual(small, [], "options under the 44px floor")

        page.keyboard.press("Escape")
        page.wait_for_selector("#canvasThemePop", state="hidden")
        page.click("#themeToggle")
        page.wait_for_selector("#canvasThemePop", state="visible")
        page.mouse.click(480, 600)
        page.wait_for_selector("#canvasThemePop", state="hidden")
        self.assertEqual(self.errors, [])


if __name__ == "__main__":
    unittest.main()
