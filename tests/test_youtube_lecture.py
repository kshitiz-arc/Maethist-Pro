"""The lecture tools in the YouTube player (static/js/youtube.js).

A lecture is studied, not watched: back ten seconds, slow down, loop the part
you missed, mark moments with notes, and pick up tomorrow where you stopped.
Each of those is driven here through a stand-in for YouTube's iframe API whose
clock only moves when the test moves it, so every assertion is exact.
"""

import json
import threading
import unittest

from app import app
from browser_server import make_browser_server

try:
    from playwright.sync_api import sync_playwright

    PLAYWRIGHT_AVAILABLE = True
except ImportError:  # pragma: no cover - optional dependency
    PLAYWRIGHT_AVAILABLE = False


VIDEO_ID = "WUvTyaaNkzM"
OTHER_ID = "9vKqVkMQHKk"
LIBRARY_KEY = "inkyscib-yt-library-v1"

FAKE_IFRAME_API = """
window.__yt = { time: 0, rate: 1, state: 1, loads: [], seeks: [] };
window.__ytAdvance = (seconds) => { window.__yt.time += seconds; };
window.YT = {
  PlayerState: { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 },
  Player: function (id, options) {
    const mount = document.getElementById(id);
    const frame = document.createElement('iframe');
    frame.id = id;
    mount.replaceWith(frame);
    const yt = window.__yt;
    let videoId = options.videoId;
    yt.time = options.playerVars && options.playerVars.start || 0;
    yt.loads.push({ videoId, start: yt.time });
    const player = {
      getIframe: () => frame,
      getCurrentTime: () => yt.time,
      getDuration: () => 600,
      getPlayerState: () => yt.state,
      getVideoData: () => ({ video_id: videoId, title: 'Limits, explained' }),
      pauseVideo: () => { yt.state = 2; },
      playVideo: () => { yt.state = 1; },
      seekTo: (t) => { yt.time = t; yt.seeks.push(t); },
      setPlaybackRate: (r) => { yt.rate = r; },
      loadVideoById: (load) => { videoId = load.videoId; yt.time = load.startSeconds || 0; yt.loads.push({ videoId, start: yt.time }); },
      destroy: () => {}
    };
    setTimeout(() => {
      options.events.onReady({ target: player });
      options.events.onStateChange({ target: player, data: 1 });
    }, 0);
    return player;
  }
};
window.onYouTubeIframeAPIReady && window.onYouTubeIframeAPIReady();
"""


@unittest.skipUnless(PLAYWRIGHT_AVAILABLE, "Playwright is not installed")
class LectureToolsTests(unittest.TestCase):
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

    def context(self, library=None, viewport=None):
        context = self.browser.new_context(viewport=viewport or {"width": 1440, "height": 900})
        self.addCleanup(context.close)
        seed = "localStorage.setItem('inkyscib-feature-tour-v1', 'seen');"
        if library is not None:
            seed += f"localStorage.setItem({json.dumps(LIBRARY_KEY)}, {json.dumps(json.dumps(library))});"
        context.add_init_script(f"if (!sessionStorage.getItem('seeded')) {{ {seed} sessionStorage.setItem('seeded', '1'); }}")
        return context

    def open_page(self, context):
        page = context.new_page()
        self.errors = []
        page.on("pageerror", lambda error: self.errors.append(str(error)))
        self.requests = []
        page.on("request", lambda request: self.requests.append(request.url))
        page.route("https://www.youtube.com/iframe_api",
                   lambda route: route.fulfill(status=200, content_type="text/javascript", body=FAKE_IFRAME_API))
        page.route("**/api/youtube/prepare?**",
                   lambda route: route.fulfill(status=200, content_type="application/json", body='{"ready": true}'))
        page.goto(self.base_url + "/write", wait_until="domcontentloaded")
        page.wait_for_function("() => window.appState?.storageReady === true")
        return page

    def play(self, page, link=f"https://youtu.be/{VIDEO_ID}"):
        page.evaluate(
            """(link) => {
              if (document.getElementById('ytPlayer').hidden) document.getElementById('ytToggleBtn').click();
              document.getElementById('ytSearchInput').value = link;
              document.getElementById('ytSearchBtn').click();
            }""",
            link,
        )
        page.wait_for_function("() => window.Inkyscib.YouTube.lectureState().transport && window.__yt && window.__yt.loads.length")
        page.wait_for_timeout(300)

    def state(self, page):
        return page.evaluate("() => window.Inkyscib.YouTube.lectureState()")

    # ---------- transport ----------

    def test_the_transport_appears_with_a_video_and_drives_it(self):
        page = self.open_page(self.context())
        self.assertTrue(page.evaluate("() => document.getElementById('ytTransport').hidden"))
        self.play(page)
        page.evaluate("() => window.__ytAdvance(75)")
        page.wait_for_timeout(400)
        self.assertEqual(page.inner_text("#ytTime"), "1:15 / 10:00")
        page.click("#ytFwd10")
        self.assertAlmostEqual(self.state(page)["time"], 85, places=3)
        page.click("#ytBack10")
        page.click("#ytBack10")
        self.assertAlmostEqual(self.state(page)["time"], 65, places=3)
        page.click("#ytPlayPause")
        self.assertEqual(page.evaluate("() => window.__yt.state"), 2)
        page.wait_for_timeout(300)
        self.assertEqual(page.get_attribute("#ytPlayPause", "aria-label"), "Play")
        page.focus("#ytScrub")
        page.keyboard.press("ArrowRight")
        self.assertAlmostEqual(self.state(page)["time"], 70, places=3)
        self.assertEqual(self.errors, [])

    def test_seeking_never_runs_past_either_end(self):
        page = self.open_page(self.context())
        self.play(page)
        page.evaluate("() => window.Inkyscib.YouTube.seekBy(-50)")
        self.assertEqual(self.state(page)["time"], 0)
        page.evaluate("() => window.Inkyscib.YouTube.seekTo(5000)")
        self.assertLess(self.state(page)["time"], 600)

    def test_speed_steps_through_the_presets_and_is_remembered(self):
        context = self.context()
        page = self.open_page(context)
        self.play(page)
        page.click("#ytSpeed")
        page.click("#ytSpeed")
        self.assertEqual(self.state(page)["speed"], 1.5)
        self.assertEqual(page.evaluate("() => window.__yt.rate"), 1.5)
        self.assertEqual(page.inner_text("#ytSpeed"), "1.5×")
        page.reload(wait_until="domcontentloaded")
        page.wait_for_function("() => window.appState?.storageReady === true")
        self.play(page)
        self.assertEqual(page.evaluate("() => window.__yt.rate"), 1.5)

    def test_a_section_loops_between_the_two_marks(self):
        page = self.open_page(self.context())
        self.play(page)
        page.evaluate("() => { window.__yt.time = 100; window.Inkyscib.YouTube.toggleLoop(); }")
        self.assertEqual(self.state(page)["loop"], {"a": 100, "b": None})
        page.evaluate("() => { window.__yt.time = 130; window.Inkyscib.YouTube.toggleLoop(); }")
        self.assertEqual(self.state(page)["loop"], {"a": 100, "b": 130})
        self.assertEqual(page.evaluate("() => window.__yt.time"), 100, "setting the end jumps back to the start")
        page.wait_for_timeout(800)
        page.evaluate("() => { window.__yt.time = 131; }")
        page.wait_for_timeout(500)
        self.assertEqual(page.evaluate("() => window.__yt.time"), 100, "reaching the end loops back")
        self.assertEqual(page.get_attribute("#ytLoop", "aria-pressed"), "true")
        page.evaluate("() => window.Inkyscib.YouTube.toggleLoop()")
        self.assertEqual(self.state(page)["loop"], {"a": None, "b": None})

    # ---------- notes ----------

    def test_notes_are_kept_in_time_order_and_survive_a_reload(self):
        context = self.context()
        page = self.open_page(context)
        self.play(page)
        page.evaluate("""() => {
          window.__yt.time = 300; window.Inkyscib.YouTube.bookmark();
          window.Inkyscib.YouTube.addNote('Squeeze theorem', 120);
        }""")
        page.click("#ytNotesToggle")
        self.assertEqual(page.locator("#ytNoteList .yt-note").count(), 2)
        self.assertEqual(page.locator("#ytScrubMarks i").count(), 2)
        self.assertEqual(page.inner_text("#ytNotesCount"), "2")
        text = page.evaluate("() => window.Inkyscib.YouTube.notesAsText()")
        self.assertIn(f"2:00  Squeeze theorem  https://youtu.be/{VIDEO_ID}?t=120s", text)
        self.assertIn(f"5:00  (bookmark)  https://youtu.be/{VIDEO_ID}?t=300s", text)

        page.reload(wait_until="domcontentloaded")
        page.wait_for_function("() => window.appState?.storageReady === true")
        self.play(page, f"https://youtu.be/{VIDEO_ID}?t=1")
        notes = self.state(page)["notes"]
        self.assertEqual([(n["t"], n["text"]) for n in notes], [(120, "Squeeze theorem"), (300, "")])

        page.click("#ytNotesToggle")
        page.click("#ytNoteList .yt-note:first-child .yt-note-time")
        self.assertEqual(self.state(page)["time"], 120)
        page.click("#ytNoteList .yt-note:first-child .yt-note-del")
        self.assertEqual(len(self.state(page)["notes"]), 1)
        self.assertEqual(self.errors, [])

    def test_a_typed_note_is_for_the_moment_typing_began_and_pauses_the_video(self):
        page = self.open_page(self.context())
        self.play(page)
        page.evaluate("() => { window.__yt.time = 42; }")
        page.click("#ytNotesToggle")
        page.click("#ytNoteInput")
        self.assertEqual(page.evaluate("() => window.__yt.state"), 2, "pause while I type is on by default")
        page.evaluate("() => { window.__yt.time = 55; }")
        page.keyboard.type("L'Hopital applies here")
        page.keyboard.press("Enter")
        note = self.state(page)["notes"][0]
        self.assertEqual((note["t"], note["text"]), (42, "L'Hopital applies here"))
        self.assertEqual(page.evaluate("() => window.appState.paths.length"), 0, "typing never drew on the canvas")

    def test_the_notes_never_squeeze_the_video_to_a_strip(self):
        page = self.open_page(self.context())
        self.play(page)
        page.click("#ytNotesToggle")
        page.wait_for_timeout(500)
        box = page.evaluate(
            """() => { const v = document.getElementById('ytVideoContainer').getBoundingClientRect();
                       const p = document.getElementById('ytPlayer').getBoundingClientRect();
                       return { ratio: v.width / v.height, bottom: p.bottom, height: innerHeight }; }"""
        )
        self.assertLess(box["ratio"], 2.0, box)
        self.assertLessEqual(box["bottom"], box["height"], box)

    # ---------- coming back ----------

    def test_a_link_without_a_time_picks_up_where_you_stopped(self):
        library = {"speed": 1, "pauseOnType": True, "videos": {
            VIDEO_ID: {"title": "Limits", "duration": 600, "position": 312.5, "updatedAt": 1, "notes": []},
            OTHER_ID: {"title": "Done", "duration": 600, "position": 590, "updatedAt": 2, "notes": []},
        }}
        page = self.open_page(self.context(library))
        self.play(page)
        # The embed starts on whole seconds.
        self.assertEqual(page.evaluate("() => window.__yt.loads.at(-1).start"), 312)
        self.play(page, f"https://youtu.be/{VIDEO_ID}?t=10")
        self.assertEqual(page.evaluate("() => window.__yt.loads.at(-1).start"), 10, "an explicit time wins")
        self.play(page, f"https://youtu.be/{OTHER_ID}")
        self.assertEqual(page.evaluate("() => window.__yt.loads.at(-1).start"), 0, "a finished video starts over")

    def test_continue_watching_lists_recent_lectures_without_asking_youtube(self):
        library = {"speed": 1, "pauseOnType": True, "videos": {
            VIDEO_ID: {"title": "Limits, explained", "duration": 600, "position": 150, "updatedAt": 5,
                       "notes": [{"t": 10, "text": "x", "at": 1}]},
        }}
        page = self.open_page(self.context(library))
        page.click("#ytToggleBtn")
        page.wait_for_selector("#ytRecent:not([hidden])")
        self.assertIn("Limits, explained", page.inner_text("#ytRecentList"))
        self.assertIn("2:30 of 10:00 · 1 note", page.inner_text("#ytRecentList"))
        youtube = [url for url in self.requests
                   if not url.startswith(self.base_url) and ("youtube" in url or "ytimg" in url)]
        self.assertEqual(youtube, [], "an unplayed list must not contact YouTube")
        page.click(".yt-recent-open")
        page.wait_for_function("() => window.__yt && window.__yt.loads.length")
        self.assertEqual(page.evaluate("() => window.__yt.loads.at(-1)"), {"videoId": VIDEO_ID, "start": 150})

    # ---------- placement and keys ----------

    def test_the_player_docks_beside_the_canvas_and_floats_back(self):
        page = self.open_page(self.context())
        self.play(page)
        before = page.evaluate("() => { const r = document.getElementById('ytPlayer').getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; }")
        page.click("#ytDock")
        docked = page.evaluate(
            """() => { const r = document.getElementById('ytPlayer').getBoundingClientRect();
                       const bar = document.querySelector('.toolbar').getBoundingClientRect();
                       return { right: innerWidth - r.right, top: r.top, barBottom: bar.bottom, height: r.height }; }"""
        )
        self.assertTrue(self.state(page)["docked"])
        self.assertLessEqual(docked["right"], 10)
        self.assertGreaterEqual(docked["top"], docked["barBottom"])
        self.assertGreater(docked["height"], 600)
        page.click("#ytDock")
        after = page.evaluate("() => { const r = document.getElementById('ytPlayer').getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; }")
        for got, want in zip(after, before):
            self.assertAlmostEqual(got, want, delta=2)

    def test_shortcuts_work_only_while_the_pointer_is_over_the_player(self):
        page = self.open_page(self.context())
        self.play(page)
        page.mouse.move(400, 500)
        page.keyboard.press("b")
        self.assertEqual(self.state(page)["notes"], [], "the canvas keeps its keys")
        box = page.locator("#ytTransport").bounding_box()
        page.mouse.move(box["x"] + box["width"] / 2, box["y"] + 4)
        page.evaluate("() => { window.__yt.time = 200; }")
        page.keyboard.press("b")
        page.keyboard.press("l")
        page.keyboard.press("]")
        state = self.state(page)
        self.assertEqual([n["t"] for n in state["notes"]], [200])
        self.assertEqual(state["time"], 210)
        self.assertEqual(state["speed"], 1.25)
        self.assertEqual(self.errors, [])


if __name__ == "__main__":
    unittest.main()
