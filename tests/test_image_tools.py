"""Image tools (static/js/image-tools.js): what you can do to a picture.

A captured frame or an inserted picture could be selected and nothing else.
Pinned here: the bar appears for a selected picture and nothing else, each
edit is one undo step, edits are drawn (not baked into the pixels), they
survive a reload, and the frame's video link and time survive every edit.
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


ADD_FRAME = """() => {
  const c = document.createElement('canvas'); c.width = 320; c.height = 180;
  const g = c.getContext('2d');
  g.fillStyle = '#102010'; g.fillRect(0, 0, 320, 180);
  g.fillStyle = '#ffffff'; g.fillRect(140, 70, 40, 40);
  const s = window.appState;
  window.commitHistory();
  s.paths.push({ tool: 'youtube-frame', points: [{x: 200, y: 160}, {x: 520, y: 340}],
                 image: c.toDataURL('image/png'), videoId: 'WUvTyaaNkzM', videoTitle: 'Limits',
                 videoTime: 95, frameTime: 95, aspectRatio: 16 / 9, timestamp: Date.now() });
  window.setTool('select');
  window.Inkyscib.Selection.selectIndex(s.paths.length - 1);
  window.render();
  return s.paths.length - 1;
}"""


@unittest.skipUnless(PLAYWRIGHT_AVAILABLE, "Playwright is not installed")
class ImageToolsTests(unittest.TestCase):
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

    def open_page(self, viewport=None):
        context = self.browser.new_context(viewport=viewport or {"width": 1440, "height": 900})
        self.addCleanup(context.close)
        context.add_init_script("localStorage.setItem('inkyscib-feature-tour-v1', 'seen')")
        page = context.new_page()
        self.errors = []
        page.on("pageerror", lambda error: self.errors.append(str(error)))
        page.goto(self.base_url + "/write", wait_until="domcontentloaded")
        page.wait_for_function("() => window.appState?.storageReady === true && !!window.Inkyscib?.ImageTools")
        return page

    def add_frame(self, page):
        index = page.evaluate(ADD_FRAME)
        page.wait_for_function("() => window.Inkyscib.ImageTools.barVisible()")
        page.wait_for_timeout(300)  # the bar's entrance animation
        return index

    def path(self, page, index):
        return page.evaluate("(i) => window.appState.paths[i] && { ...window.appState.paths[i], image: undefined }", index)

    def test_the_bar_appears_for_a_selected_picture_and_only_then(self):
        page = self.open_page()
        self.add_frame(page)
        bar = page.evaluate(
            """() => { const b = document.getElementById('imageToolsBar').getBoundingClientRect();
                       const floor = document.querySelector('.toolbar').getBoundingClientRect().bottom;
                       return { top: b.top, floor, buttons: [...document.querySelectorAll('#imageToolsBar [data-act]')]
                         .filter((x) => !x.hidden).map((x) => x.dataset.act) }; }"""
        )
        self.assertEqual(bar["buttons"], ["edit", "rotate", "duplicate", "openVideo", "undo", "redo", "remove", "more"])
        self.assertGreaterEqual(bar["top"], bar["floor"])
        small = page.evaluate(
            """() => [...document.querySelectorAll('#imageToolsBar button')].filter((b) => !b.hidden)
                 .map((b) => b.getBoundingClientRect()).filter((r) => r.width < 44 || r.height < 44).length"""
        )
        self.assertEqual(small, 0)
        page.evaluate("() => window.Inkyscib.Selection.clear()")
        page.wait_for_function("() => !window.Inkyscib.ImageTools.barVisible()")
        page.evaluate("() => window.setTool('pen')")
        self.assertFalse(page.evaluate("() => window.Inkyscib.ImageTools.barVisible()"))
        self.assertEqual(self.errors, [])

    def test_delete_and_undo_bring_the_frame_back(self):
        page = self.open_page()
        self.add_frame(page)
        page.click('#imageToolsBar [data-act="remove"]')
        self.assertEqual(page.evaluate("() => window.appState.paths.filter((p) => p.tool === 'youtube-frame').length"), 0)
        page.evaluate("() => window.Inkyscib.ImageTools.actions.undo()")
        self.assertEqual(page.evaluate("() => window.appState.paths.filter((p) => p.tool === 'youtube-frame').length"), 1)

    def test_rotate_turns_the_box_and_one_undo_reverts_it(self):
        page = self.open_page()
        index = self.add_frame(page)
        page.click('#imageToolsBar [data-act="rotate"]')
        turned = self.path(page, index)
        self.assertEqual(turned["edit"]["rotate"], 90)
        width = abs(turned["points"][1]["x"] - turned["points"][0]["x"])
        height = abs(turned["points"][1]["y"] - turned["points"][0]["y"])
        self.assertAlmostEqual(width, 180, delta=0.5)
        self.assertAlmostEqual(height, 320, delta=0.5)
        self.assertEqual((turned["videoId"], turned["videoTime"]), ("WUvTyaaNkzM", 95))
        page.evaluate("() => window.undo()")
        self.assertNotIn("edit", self.path(page, index))

    def test_the_sheet_crops_and_filters_in_one_undo_step_and_it_survives_a_reload(self):
        page = self.open_page()
        index = self.add_frame(page)
        page.click('#imageToolsBar [data-act="edit"]')
        page.wait_for_selector("#imageEditSheet:not([hidden])")
        page.click('[data-preset="board"]')
        page.click('[data-backdrop="paper"]')
        page.click('[data-view="crop"]')
        page.click('[data-aspect="1:1"]')
        undo_before = page.evaluate("() => window.appState.undoStack.length")
        page.click('[data-sheet="apply"]')
        edited = self.path(page, index)
        self.assertEqual(page.evaluate("() => window.appState.undoStack.length"), undo_before + 1)
        self.assertEqual(edited["edit"]["invert"], 1)
        self.assertEqual(edited["edit"]["backdrop"], "paper")
        crop = edited["edit"]["crop"]
        self.assertAlmostEqual(crop["w"] * 320, crop["h"] * 180, delta=1)
        width = abs(edited["points"][1]["x"] - edited["points"][0]["x"])
        height = abs(edited["points"][1]["y"] - edited["points"][0]["y"])
        self.assertAlmostEqual(width, height, delta=0.5)

        page.wait_for_timeout(1500)
        page.reload(wait_until="domcontentloaded")
        page.wait_for_function("() => window.appState?.storageReady === true")
        page.wait_for_timeout(500)
        loaded = page.evaluate("() => { const p = window.appState.paths.find((x) => x.tool === 'youtube-frame'); return p && { edit: p.edit, points: p.points }; }")
        self.assertEqual(loaded["edit"]["backdrop"], "paper")
        self.assertAlmostEqual(loaded["edit"]["crop"]["w"], crop["w"], places=4)
        lw = abs(loaded["points"][1]["x"] - loaded["points"][0]["x"])
        lh = abs(loaded["points"][1]["y"] - loaded["points"][0]["y"])
        self.assertAlmostEqual(lw / lh, 1, delta=0.01, msg="the load-time aspect repair must keep the crop")
        self.assertEqual(self.errors, [])

    def test_cancel_changes_nothing(self):
        page = self.open_page()
        index = self.add_frame(page)
        before = self.path(page, index)
        page.click('#imageToolsBar [data-act="edit"]')
        page.click('[data-preset="mono"]')
        page.keyboard.press("Escape")
        self.assertEqual(self.path(page, index), before)
        # Escape cancels the sheet only: the picture stays selected with its bar.
        page.wait_for_function("() => window.Inkyscib.ImageTools.barVisible()", timeout=2000)
        self.assertEqual(page.evaluate("() => window.Inkyscib.Selection.selectedIndices()"), [index])

    def test_edits_are_drawn_not_baked(self):
        page = self.open_page()
        index = self.add_frame(page)
        source = page.evaluate("(i) => window.appState.paths[i].image", index)
        pixel = """() => { const c = document.getElementById('drawingCanvas'); const r = c.getBoundingClientRect();
                     const k = c.width / r.width; const t = window.appState.transform;
                     const x = (360 * t.scale + t.offsetX) * k, y = (250 * t.scale + t.offsetY) * k;
                     return Array.from(c.getContext('2d').getImageData(Math.round(x), Math.round(y), 1, 1).data).slice(0, 3); }"""
        page.wait_for_timeout(300)
        plain = page.evaluate(pixel)
        page.evaluate("() => { window.Inkyscib.ImageTools.open(); window.Inkyscib.ImageTools.applyPreset('board'); window.Inkyscib.ImageTools.close(true); }")
        page.wait_for_timeout(300)
        inverted = page.evaluate(pixel)
        self.assertGreater(plain[0], 200, "the white square at the centre")
        self.assertLess(inverted[0], 80, "board to paper turns it dark")
        self.assertEqual(page.evaluate("(i) => window.appState.paths[i].image", index), source)

    def test_hide_timestamp_and_duplicate(self):
        page = self.open_page()
        index = self.add_frame(page)
        page.click('#imageToolsBar [data-act="more"]')
        page.click('#imageToolsMore [data-act="toggleBadge"]')
        self.assertTrue(self.path(page, index)["hideBadge"])
        page.click('#imageToolsBar [data-act="duplicate"]')
        frames = page.evaluate("() => window.appState.paths.filter((p) => p.tool === 'youtube-frame').length")
        self.assertEqual(frames, 2)


if __name__ == "__main__":
    unittest.main()
