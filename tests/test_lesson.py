"""Lesson replay (static/js/lesson.js, 2.9.1).

Record what you write, and your voice if you like, then play it back stroke
by stroke. Pinned here: strokes keep their timing, the player shows the page
as it was at any moment, playback can never be saved over the page, and
closing the player puts everything back.
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


@unittest.skipUnless(PLAYWRIGHT_AVAILABLE, "Playwright is not installed")
class LessonTests(unittest.TestCase):
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
        page.wait_for_function("() => window.appState?.storageReady === true && !!window.Inkyscib?.Lesson")
        page.wait_for_timeout(300)
        page.evaluate("() => { window.setTool('pen'); window.Inkyscib.ToolDock?.setCollapsed?.(true); }")
        return page

    def stroke(self, page, x, y, length=120):
        page.mouse.move(x, y)
        page.mouse.down()
        for step in range(1, 13):
            page.mouse.move(x + step * length / 12, y + (step % 3) * 4)
            page.wait_for_timeout(15)
        page.mouse.up()

    def record(self, page):
        """A lesson: one stroke before Record (the baseline), two during."""
        self.stroke(page, 300, 250)
        page.wait_for_timeout(200)
        self.assertTrue(page.evaluate("() => window.Inkyscib.Lesson.startRecording({ voice: false })"))
        page.wait_for_timeout(300)
        self.stroke(page, 300, 350)
        page.wait_for_timeout(600)
        self.stroke(page, 300, 450)
        page.wait_for_timeout(300)
        return page.evaluate("""async () => { const l = await window.Inkyscib.Lesson.stopRecording();
          return l && { baseline: l.baseline.length, strokes: l.strokes.map((k) => [Math.round(k.start), k.path.points.length]), duration: l.duration, audio: !!l.audio }; }""")

    def test_a_recording_keeps_each_stroke_and_its_timing(self):
        page = self.open()
        lesson = self.record(page)
        self.assertEqual(lesson["baseline"], 1, "the page as it was when Record was pressed")
        self.assertEqual(len(lesson["strokes"]), 2)
        (first, _), (second, points) = lesson["strokes"]
        self.assertLess(first, second, "in the order they were written")
        self.assertGreater(second - first, 500, "with the pause between them kept")
        self.assertGreater(points, 5)
        self.assertFalse(lesson["audio"])
        saved = page.evaluate("async () => (await window.Inkyscib.Lesson.list()).length")
        self.assertEqual(saved, 1, "and it is kept on the device")
        self.assertEqual(self.errors, [])

    def test_the_player_shows_the_page_as_it_was_at_any_moment(self):
        page = self.open()
        self.record(page)
        frames = page.evaluate("""async () => { const [l] = await window.Inkyscib.Lesson.list();
          const at = (t) => window.Inkyscib.Lesson.frameAt(l, t).length;
          const mid = l.strokes[1].path.points; const half = mid[Math.floor(mid.length / 2)].lt;
          const partial = window.Inkyscib.Lesson.frameAt(l, half).find((p) => p.points.length < mid.length && p.points.length > 0);
          return { start: at(0), afterFirst: at(l.strokes[0].start + 400), end: at(l.duration), partial: !!partial }; }""")
        self.assertEqual(frames, {"start": 1, "afterFirst": 2, "end": 3, "partial": True},
                         "a stroke is drawn point by point, as it was written")

    def test_playback_never_saves_over_the_page_and_closing_restores_it(self):
        page = self.open()
        self.record(page)
        before = page.evaluate("() => window.appState.paths.length")
        page.evaluate("async () => { const [l] = await window.Inkyscib.Lesson.list(); await window.Inkyscib.Lesson.openPlayer(l); window.Inkyscib.Lesson.seek(0); }")
        page.wait_for_timeout(100)
        during = page.evaluate("() => ({ shown: window.appState.paths.length, guarded: window.appState.lessonPlayback === true, shield: !!document.getElementById('lessonShield') })")
        self.assertEqual(during, {"shown": 1, "guarded": True, "shield": True})
        # A save forced mid-lesson (as closing the tab does) writes nothing.
        stored = page.evaluate("""async () => { await window.saveDrawing({ force: true });
          return JSON.parse(localStorage.getItem('inkyscib_drawing') || 'null'); }""")
        if isinstance(stored, list):
            self.assertEqual(len(stored), before, "the stored page is the real one, not the lesson's frame")
        page.keyboard.press("Escape")
        after = page.evaluate("() => ({ n: window.appState.paths.length, guarded: !!window.appState.lessonPlayback, open: window.Inkyscib.Lesson.open() })")
        self.assertEqual(after, {"n": before, "guarded": False, "open": False})

    def test_the_lessons_sheet_lists_and_deletes(self):
        page = self.open()
        self.record(page)
        page.evaluate("() => window.Inkyscib.FileRibbon.runCommand('lessons')")
        page.wait_for_selector("#lessonSheet .lesson-item")
        self.assertEqual(page.locator("#lessonSheet .lesson-item").count(), 1)
        page.once("dialog", lambda d: d.accept())
        page.click("#lessonSheet .lesson-delete")
        page.wait_for_selector("#lessonSheet .lesson-empty")
        self.assertEqual(page.evaluate("async () => (await window.Inkyscib.Lesson.list()).length"), 0)

    def test_the_microphone_is_allowed_for_this_site_only(self):
        with app.test_client() as client:
            policy = client.get("/write").headers.get("Permissions-Policy", "")
        self.assertIn("microphone=(self)", policy)
        self.assertIn("geolocation=()", policy)


if __name__ == "__main__":
    unittest.main()
