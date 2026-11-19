"""More image edits, and a picture of your own as the canvas background.

The edits came from an LLM council (docs/council/council-image-edits-2026-11-19.md):
even out light, auto levels, sharpen, black and white, clear the paper,
straighten, plus hue and blur. They are baked once by image-process.js, so
these tests check the pixels the bake produces, the Edit sheet that sets
them, and the background that reuses the same sheet.
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

# Draws test pictures in the page: a paper photo with a shadow down its left
# half and a dark ink bar, as a canvas.
MAKE = """() => {
  window.__paper = (() => {
    const c = document.createElement('canvas'); c.width = 400; c.height = 200;
    const g = c.getContext('2d');
    const grad = g.createLinearGradient(0, 0, 400, 0);
    grad.addColorStop(0, 'rgb(120,120,120)'); grad.addColorStop(1, 'rgb(240,240,240)');
    g.fillStyle = grad; g.fillRect(0, 0, 400, 200);
    g.fillStyle = 'rgb(40,40,40)'; g.fillRect(40, 90, 320, 12);
    return c;
  })();
  window.__px = (canvas, x, y) => Array.from(canvas.getContext('2d').getImageData(x, y, 1, 1).data);
}"""


@unittest.skipUnless(PLAYWRIGHT_AVAILABLE, "Playwright is not installed")
class ImageEditTests(unittest.TestCase):
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

    def open_page(self, context=None):
        if context is None:
            context = self.browser.new_context(viewport={"width": 1280, "height": 800})
            self.addCleanup(context.close)
            context.add_init_script("localStorage.setItem('inkyscib-feature-tour-v1', 'seen')")
        page = context.new_page()
        self.errors = []
        page.on("pageerror", lambda error: self.errors.append(str(error)))
        page.goto(self.base_url + "/write", wait_until="domcontentloaded")
        page.wait_for_function("() => window.appState?.storageReady === true && !!window.Inkyscib?.ImageProcess && !!window.Inkyscib?.CanvasPicture")
        page.evaluate(MAKE)
        return page, context

    # ---------- the bake ----------

    def test_evening_out_the_light_turns_a_shadowed_page_white(self):
        page, _ = self.open_page()
        out = page.evaluate("""() => {
          const P = window.Inkyscib.ImageProcess;
          const before = [__px(__paper, 10, 20)[0], __px(__paper, 390, 20)[0]];
          const baked = P.process(__paper, {clean: true}, 400);
          return {before, after: [__px(baked, 10, 20)[0], __px(baked, 390, 20)[0]], ink: __px(baked, 200, 96)[0]};
        }""")
        self.assertGreater(out["before"][1] - out["before"][0], 100, "the shadow is there to begin with")
        self.assertGreater(out["after"][0], 225, "the shadowed paper is white")
        self.assertGreater(out["after"][1], 225)
        self.assertLess(out["ink"], 120, "and the ink is still ink")

    def test_black_and_white_and_clear_paper(self):
        page, _ = self.open_page()
        out = page.evaluate("""() => {
          const P = window.Inkyscib.ImageProcess;
          const bw = P.process(__paper, {threshold: 0.4}, 400);
          const d = bw.getContext('2d').getImageData(0, 0, 400, 200).data;
          const greys = new Set(); for (let i = 0; i < d.length; i += 4) greys.add(d[i]);
          const clear = P.process(__paper, {clean: true, clearPaper: 0.5}, 400);
          return {greys: [...greys].sort((a, b) => a - b), paperAlpha: __px(clear, 390, 20)[3], inkAlpha: __px(clear, 200, 96)[3]};
        }""")
        self.assertEqual(out["greys"], [0, 255])
        self.assertEqual(out["paperAlpha"], 0, "the paper is see-through")
        self.assertEqual(out["inkAlpha"], 255, "the ink is not")

    def test_sharpen_steepens_an_edge_and_a_bake_is_reused(self):
        page, _ = self.open_page()
        out = page.evaluate("""() => {
          const P = window.Inkyscib.ImageProcess;
          const soft = document.createElement('canvas'); soft.width = 100; soft.height = 40;
          const g = soft.getContext('2d'); g.filter = 'blur(2px)'; g.fillStyle = '#fff'; g.fillRect(0, 0, 100, 40);
          g.fillStyle = '#000'; g.fillRect(50, -10, 60, 60);
          const a = P.process(soft, {sharpen: 1.5}, 100);
          const b = P.process(soft, {sharpen: 1.5}, 100);
          return {before: __px(soft, 48, 20)[0], after: __px(a, 48, 20)[0], same: a === b,
                  none: P.process(soft, {brightness: 1.2}, 100) === soft};
        }""")
        self.assertGreater(out["after"], out["before"], "the light side of the edge gets lighter")
        self.assertTrue(out["same"], "the second call is the cached bake")
        self.assertTrue(out["none"], "a filter-only edit needs no bake")

    def test_hue_is_a_filter_and_straighten_fills_its_frame(self):
        page, _ = self.open_page()
        out = page.evaluate("""() => {
          const M = window.Inkyscib.MediaDraw;
          const red = document.createElement('canvas'); red.width = 200; red.height = 100;
          const g = red.getContext('2d'); g.fillStyle = '#ff0000'; g.fillRect(0, 0, 200, 100);
          const out = document.createElement('canvas'); out.width = 200; out.height = 100;
          const o = out.getContext('2d');
          M.draw(o, red, 0, 0, 200, 100, {straighten: 10});
          const corner = Array.from(o.getImageData(1, 1, 1, 1).data);
          return {filter: M.filter({hue: 120}), corner};
        }""")
        self.assertEqual(out["filter"], "hue-rotate(120deg)")
        self.assertEqual(out["corner"][:3], [255, 0, 0], "a straightened picture leaves no empty corner")
        self.assertEqual(self.errors, [])

    # ---------- the sheet ----------

    def put_picture(self, page):
        page.evaluate("""() => {
          const s = window.appState; s.paths = []; s.transform = {scale: 1, offsetX: 0, offsetY: 0};
          s.paths.push({tool: 'image', points: [{x: 300, y: 200}, {x: 700, y: 400}], image: __paper.toDataURL(), timestamp: Date.now()});
          window.setTool('select'); window.Inkyscib.Selection.selectIndex(0); window.render();
          window.Inkyscib.ImageTools.open();
        }""")
        page.wait_for_selector("#imageEditSheet:not([hidden])")

    def test_the_sheet_has_the_new_edits_and_drops_untouched_ones(self):
        page, _ = self.open_page()
        self.put_picture(page)
        for key in ("hue", "blur", "sharpen", "threshold", "clearPaper", "straighten"):
            with self.subTest(key=key):
                self.assertEqual(page.locator(f'#imageEditSheet [data-slider="{key}"]').count(), 1)
        self.assertFalse(page.is_visible('#imageEditSheet [data-fit="cover"]'), "Fill/Fit/Tile are for the background only")
        page.click('#imageEditSheet [data-toggle="clean"]')
        page.evaluate("""() => { const i = document.querySelector('#imageEditSheet [data-slider="sharpen"]');
          i.value = 0.8; i.dispatchEvent(new Event('input', {bubbles: true})); }""")
        self.assertEqual(page.inner_text('#imageEditSheet [data-out="sharpen"]'), "80%")
        page.click('#imageEditSheet [data-sheet="apply"]')
        edit = page.evaluate("() => window.appState.paths[0].edit")
        self.assertEqual(edit, {"clean": True, "sharpen": 0.8})
        self.assertEqual(self.errors, [])

    def test_clean_scan_and_hold_to_compare(self):
        page, _ = self.open_page()
        self.put_picture(page)
        page.click('#imageEditSheet [data-preset="scan"]')
        self.assertEqual(page.get_attribute('#imageEditSheet [data-toggle="clean"]', "aria-pressed"), "true")
        sample = """() => { const c = document.querySelector('#imageEditSheet .img-preview');
          const r = c.width / c.getBoundingClientRect().width;
          return Array.from(c.getContext('2d').getImageData(Math.round(c.width * 0.2), Math.round(c.height * 0.3), 1, 1).data); }"""
        edited = page.evaluate(sample)
        box = page.locator("#imageEditSheet [data-compare]").bounding_box()
        page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
        page.mouse.down()
        original = page.evaluate(sample)
        page.mouse.up()
        again = page.evaluate(sample)
        self.assertNotEqual(edited, original, "holding shows the original")
        self.assertEqual(edited, again, "letting go shows the edit again")

    # ---------- the background ----------

    def test_a_picture_background_is_drawn_faded_and_kept(self):
        context = self.browser.new_context(viewport={"width": 1280, "height": 800})
        self.addCleanup(context.close)
        context.add_init_script("localStorage.setItem('inkyscib-feature-tour-v1', 'seen')")
        page, _ = self.open_page(context)
        page.evaluate("""async () => {
          const c = document.createElement('canvas'); c.width = 320; c.height = 200;
          const g = c.getContext('2d'); g.fillStyle = 'rgb(0,200,0)'; g.fillRect(0, 0, 320, 200);
          await window.Inkyscib.CanvasPicture.use(c.toDataURL('image/png'), {fit: 'cover'});
        }""")
        centre = """() => { const p = document.getElementById('patternCanvas');
          return Array.from(p.getContext('2d').getImageData(p.width >> 1, p.height >> 1, 1, 1).data); }"""
        page.wait_for_timeout(100)
        self.assertEqual(page.evaluate(centre)[:3], [0, 200, 0])
        page.evaluate("() => { window.Inkyscib.CanvasPicture.edit(); }")
        page.wait_for_selector("#imageEditSheet:not([hidden])")
        self.assertIn("background picture", page.inner_text("#imgSheetTitle"))
        self.assertTrue(page.is_visible('#imageEditSheet [data-fit="tile"]'))
        page.evaluate("""() => { const i = document.querySelector('#imageEditSheet [data-slider="fade"]');
          i.value = 0.5; i.dispatchEvent(new Event('input', {bubbles: true})); }""")
        page.click('#imageEditSheet [data-sheet="apply"]')
        page.wait_for_timeout(100)
        faded = page.evaluate(centre)
        ground = page.evaluate("""() => { const c = document.createElement('canvas').getContext('2d');
          c.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--canvas-ground').trim();
          c.fillRect(0, 0, 1, 1); return Array.from(c.getImageData(0, 0, 1, 1).data); }""")
        expected = [round(0.5 * v + 0.5 * g) for v, g in zip((0, 200, 0), ground[:3])]
        for got, want in zip(faded[:3], expected):
            self.assertLess(abs(got - want), 4, (faded, expected, "halfway to the canvas colour"))
        page.wait_for_timeout(300)
        # Kept in this browser: a reload brings it back with its edit.
        page.reload(wait_until="domcontentloaded")
        page.wait_for_function("() => window.Inkyscib?.CanvasPicture?.active()")
        self.assertEqual(page.evaluate("() => window.Inkyscib.CanvasPicture.get().edit.fade"), 0.5)
        page.evaluate("() => window.Inkyscib.CanvasPicture.remove()")
        page.wait_for_timeout(100)
        self.assertFalse(page.evaluate("() => window.Inkyscib.CanvasPicture.active()"))
        self.assertNotEqual(page.evaluate(centre)[:3], [0, 200, 0])

    def test_the_canvas_popover_offers_a_picture(self):
        page, _ = self.open_page()
        page.evaluate("() => document.getElementById('themeToggle').click()")
        page.wait_for_selector("#canvasThemePop:not([hidden])")
        self.assertIn("Use a picture", page.inner_text("#canvasThemePop"))
        self.assertFalse(page.is_visible('#canvasThemePop [data-picture="edit"]'))


if __name__ == "__main__":
    unittest.main()
