"""YouTube frame capture.

"Save frame" used to place the video's thumbnail every time, for two reasons
that each fell through to a silent `maxresdefault.jpg`:

1. The server could not reach YouTube at all on a machine whose antivirus
   re-signs HTTPS. Python 3.14 verifies certificates with
   `VERIFY_X509_STRICT`, and a scanning root whose Basic Constraints are not
   marked critical fails that check, so every storyboard lookup returned 502.
2. Even with the storyboard spec in hand, the sprite sheets on i.ytimg.com are
   served without `Access-Control-Allow-Origin`, so the browser could not read
   their pixels.

The frame is now cut out on the server, from the video itself at the exact
playhead time (yt-dlp + PyAV), with YouTube's own storyboard preview as the
fallback. Screen capture is gone entirely -- it asked to share the whole screen
and could only ever photograph the player's small box -- and a tripwire here
fails if anything reaches for it again. A thumbnail is never passed off as the
frame.
"""

import base64
import io
import json
import math
import ssl
import threading
import time
import sys
import unittest
from pathlib import Path
import urllib.error
from unittest.mock import patch

from PIL import Image

import app as app_module
from app import app
from browser_server import make_browser_server


VIDEO_ID = "abcDEF123_4"
CELL_W, CELL_H = 320, 180
COLS, ROWS = 3, 3
FRAME_COUNT = 20
INTERVAL_MS = 2000
SPEC = (
    f"https://i.ytimg.com/sb/{VIDEO_ID}/storyboard3_L$L/$N.jpg?sqp=abc"
    "|48#27#100#10#10#0#default#rs$first"
    f"|{CELL_W}#{CELL_H}#{FRAME_COUNT}#{COLS}#{ROWS}#{INTERVAL_MS}#M$M#rs$second"
)


def cell_colour(frame_index):
    """A colour per frame that survives JPEG and is unlike its neighbours."""
    return (
        (frame_index * 67) % 256,
        (255 - frame_index * 41) % 256,
        (frame_index * 113 + 60) % 256,
    )


def sprite_sheet(sheet_index):
    image = Image.new("RGB", (CELL_W * COLS, CELL_H * ROWS), (0, 0, 0))
    per_sheet = COLS * ROWS
    for cell in range(per_sheet):
        frame = sheet_index * per_sheet + cell
        if frame >= FRAME_COUNT:
            break
        col, row = cell % COLS, cell // COLS
        image.paste(
            cell_colour(frame),
            (col * CELL_W, row * CELL_H, (col + 1) * CELL_W, (row + 1) * CELL_H),
        )
    buffer = io.BytesIO()
    # YouTube serves these as WebP despite the .jpg name.
    image.save(buffer, "WEBP", quality=95)
    return buffer.getvalue()


def watch_page(spec=SPEC):
    player = {"storyboards": {"playerStoryboardSpecRenderer": {"spec": spec}}} if spec else {}
    return (
        "<html><script>var ytInitialPlayerResponse = "
        + json.dumps(player)
        + ";</script></html>"
    ).encode("utf-8")


# Full-resolution capture is the default (app.YOUTUBE_FULL_FRAMES). Pinned on
# here so a developer's YOUTUBE_FULL_FRAMES=false cannot change what these
# tests exercise; FullResolutionDefaultTests at the end checks the default.
app_module.YOUTUBE_FULL_FRAMES = True


class FakeYouTube:
    def __init__(self, spec=SPEC, fail=False):
        self.spec = spec
        self.fail = fail
        self.urls = []

    def __call__(self, url, headers=None, timeout=8, max_bytes=None):
        self.urls.append(url)
        if self.fail:
            raise urllib.error.URLError("certificate verify failed")
        if url.startswith(f"https://www.youtube.com/watch?v={VIDEO_ID}"):
            return watch_page(self.spec)
        if url.startswith(f"https://i.ytimg.com/sb/{VIDEO_ID}/"):
            sheet = int(url.split("/M")[1].split(".jpg")[0])
            return sprite_sheet(sheet)
        raise AssertionError(f"unexpected upstream URL: {url}")


def decode_data_url(data_url):
    header, payload = data_url.split(",", 1)
    return header, Image.open(io.BytesIO(base64.b64decode(payload))).convert("RGB")


class OutboundTlsTests(unittest.TestCase):
    def test_context_keeps_verification_and_drops_only_the_strict_profile(self):
        context = app_module._outbound_ssl_context()
        self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)
        self.assertTrue(context.check_hostname)
        self.assertFalse(context.verify_flags & ssl.VERIFY_X509_STRICT)

    def test_search_goes_through_the_shared_fetch(self):
        initial = {"contents": [{"videoRenderer": {
            "videoId": VIDEO_ID, "title": {"simpleText": "Circles"},
        }}]}
        html = ('<script>var ytInitialData = ' + json.dumps(initial) + ';</script>').encode()
        app_module.YOUTUBE_SEARCH_CACHE.clear()
        with patch("app._fetch_youtube_bytes", return_value=html) as fetch:
            videos, available = app_module._search_youtube_result("circles class 9")
        self.assertTrue(available)
        self.assertEqual([video["id"] for video in videos], [VIDEO_ID])
        self.assertTrue(fetch.call_args[0][0].startswith("https://www.youtube.com/results?"))


class FrameEndpointTests(unittest.TestCase):
    def setUp(self):
        app_module.YOUTUBE_STORYBOARD_CACHE.clear()
        app_module.YOUTUBE_SPRITE_CACHE.clear()
        self.client = app.test_client()

    def get_frame(self, fake, query):
        # _video_frame stubbed to None on purpose: these tests are about the
        # storyboard fallback, and leaving it live would make every one of them
        # resolve a real stream over the network.
        with patch("app._fetch_youtube_bytes", side_effect=fake),                 patch("app._video_frame", return_value=None):
            return self.client.get("/api/youtube/frame?" + query)

    def assert_colour(self, image, expected, tolerance=14):
        centre = image.getpixel((image.width // 2, image.height // 2))
        for got, want in zip(centre, expected):
            self.assertLessEqual(abs(got - want), tolerance, f"{centre} is not {expected}")

    def test_it_cuts_out_the_cell_nearest_the_requested_time(self):
        fake = FakeYouTube()
        response = self.get_frame(fake, f"v={VIDEO_ID}&t=4.2")

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        body = response.get_json()
        header, image = decode_data_url(body["image"])
        self.assertEqual(header, "data:image/jpeg;base64")
        self.assertEqual((body["width"], body["height"]), (CELL_W, CELL_H))
        self.assertEqual(image.size, (CELL_W, CELL_H))
        self.assertEqual(body["source"], "storyboard")
        # 4.2s at a 2s interval is nearest frame 2, the third cell of sheet 0.
        self.assertAlmostEqual(body["frameTime"], 4.0)
        self.assert_colour(image, cell_colour(2))

    def test_later_frames_come_from_later_sheets_at_the_sharpest_level(self):
        fake = FakeYouTube()
        response = self.get_frame(fake, f"v={VIDEO_ID}&t=21")

        body = response.get_json()
        _, image = decode_data_url(body["image"])
        # 21s -> frame 11 (10.5 rounds up) -> sheet 1, cell 2.
        self.assertAlmostEqual(body["frameTime"], 22.0)
        self.assert_colour(image, cell_colour(11))
        sprite_urls = [url for url in fake.urls if "/sb/" in url]
        self.assertEqual(len(sprite_urls), 1)
        self.assertIn("/storyboard3_L1/M1.jpg", sprite_urls[0])
        self.assertIn("sigh=rs$second", sprite_urls[0])

    def test_a_time_past_the_end_uses_the_last_frame(self):
        response = self.get_frame(FakeYouTube(), f"v={VIDEO_ID}&t=9999")
        body = response.get_json()
        _, image = decode_data_url(body["image"])
        self.assertAlmostEqual(body["frameTime"], (FRAME_COUNT - 1) * INTERVAL_MS / 1000)
        self.assert_colour(image, cell_colour(FRAME_COUNT - 1))

    def test_the_video_frame_is_preferred_over_the_storyboard(self):
        """Full resolution at the exact timestamp, with the storyboard only
        standing in when the video cannot be read."""
        sharp = {
            "image": "data:image/jpeg;base64,AAAA",
            "width": 1920,
            "height": 1080,
            "frameTime": 61.3,
        }
        with patch("app._video_frame", return_value=sharp) as cut,                 patch("app._storyboard_frame") as storyboard:
            response = self.client.get(f"/api/youtube/frame?v={VIDEO_ID}&t=61.3")

        self.assertEqual(response.status_code, 200)
        body = response.get_json()
        self.assertEqual(body["source"], "video")
        self.assertEqual((body["width"], body["height"]), (1920, 1080))
        self.assertAlmostEqual(body["frameTime"], 61.3)
        cut.assert_called_once()
        storyboard.assert_not_called()

    def test_an_unreadable_video_falls_back_to_the_storyboard(self):
        fake = FakeYouTube()
        with patch("app._fetch_youtube_bytes", side_effect=fake),                 patch("app._video_frame", return_value=None):
            response = self.client.get(f"/api/youtube/frame?v={VIDEO_ID}&t=4.2")

        self.assertEqual(response.status_code, 200)
        body = response.get_json()
        self.assertEqual(body["source"], "storyboard")
        self.assertEqual((body["width"], body["height"]), (CELL_W, CELL_H))

    def test_preview_quality_skips_the_video_entirely(self):
        """The escape hatch that keeps the storyboard tests off the network."""
        fake = FakeYouTube()
        with patch("app._fetch_youtube_bytes", side_effect=fake),                 patch("app._video_frame") as cut:
            response = self.client.get(
                f"/api/youtube/frame?v={VIDEO_ID}&t=4.2&quality=preview"
            )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["source"], "storyboard")
        cut.assert_not_called()

    def test_prepare_warms_the_video_and_refuses_bad_ids(self):
        with patch("app._prepare_video", return_value={"width": 1920, "height": 1080}) as warm:
            response = self.client.get(f"/api/youtube/prepare?v={VIDEO_ID}")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json(), {"ready": True, "width": 1920, "height": 1080})
        warm.assert_called_once_with(VIDEO_ID)

        with patch("app._prepare_video") as warm:
            response = self.client.get("/api/youtube/prepare?v=not-an-id")
        self.assertEqual(response.status_code, 400)
        warm.assert_not_called()

    def test_a_failed_prepare_is_harmless(self):
        """Fire-and-forget: the capture will try again, so a failure here must
        not surface as an error."""
        with patch("app._prepare_video", side_effect=RuntimeError("offline")):
            response = self.client.get(f"/api/youtube/prepare?v={VIDEO_ID}")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json(), {"ready": False})

    def test_the_stream_reader_only_talks_to_youtubes_video_hosts(self):
        """The reader opens raw connections to whatever URL the resolve handed
        back; anything but googlevideo.com over HTTPS did not come from YouTube."""
        for url in (
            "https://evil.example.com/videoplayback?x=1",
            "http://r1---sn.googlevideo.com/videoplayback?x=1",
            "https://googlevideo.com.evil.example/videoplayback",
        ):
            with self.subTest(url=url):
                entry = {"url": url, "format": "137", "size": 10, "conn": None}
                reader = app_module._StreamFile(VIDEO_ID, entry)
                with self.assertRaises(ValueError):
                    reader._connect()

    def test_bad_input_is_refused_before_anything_is_fetched(self):
        fake = FakeYouTube()
        for query in (
            "v=not-an-id&t=3",
            f"v={VIDEO_ID}&t=-1",
            f"v={VIDEO_ID}&t=nan",
            f"v={VIDEO_ID}&t=inf",
            f"v={VIDEO_ID}&t=three",
        ):
            with self.subTest(query=query):
                response = self.get_frame(fake, query)
                self.assertEqual(response.status_code, 400)
                self.assertIn("error", response.get_json())
        self.assertEqual(fake.urls, [])

    def test_a_video_without_a_storyboard_is_a_404(self):
        response = self.get_frame(FakeYouTube(spec=None), f"v={VIDEO_ID}&t=3")
        self.assertEqual(response.status_code, 404)
        self.assertIn("error", response.get_json())

    def test_an_unreachable_youtube_is_a_502(self):
        response = self.get_frame(FakeYouTube(fail=True), f"v={VIDEO_ID}&t=3")
        self.assertEqual(response.status_code, 502)
        self.assertIn("error", response.get_json())

    def test_only_youtube_urls_derived_from_the_spec_are_ever_fetched(self):
        fake = FakeYouTube()
        self.get_frame(fake, f"v={VIDEO_ID}&t=3&url=https://evil.example/x.jpg")
        self.assertTrue(fake.urls)
        for url in fake.urls:
            self.assertTrue(
                url.startswith(f"https://www.youtube.com/watch?v={VIDEO_ID}")
                or url.startswith(f"https://i.ytimg.com/sb/{VIDEO_ID}/"),
                url,
            )

        # A spec pointing anywhere but i.ytimg.com is treated as no storyboard.
        app_module.YOUTUBE_STORYBOARD_CACHE.clear()
        hostile = FakeYouTube(spec=SPEC.replace("https://i.ytimg.com", "https://evil.example"))
        response = self.get_frame(hostile, f"v={VIDEO_ID}&t=3")
        self.assertEqual(response.status_code, 404)
        self.assertFalse([url for url in hostile.urls if "evil.example" in url])



class FrameQualityTests(unittest.TestCase):
    """HD (1080p) is the preset; quality=best asks for the most the video has,
    up to YOUTUBE_FRAME_BEST_HEIGHT, cached apart from the HD stream."""

    def setUp(self):
        self.client = app.test_client()

    def test_best_asks_for_the_higher_ceiling(self):
        seen = []

        def fake(video_id, seconds, max_height=None):
            seen.append(max_height)
            return {"image": "data:image/jpeg;base64,AA", "width": 16, "height": 9, "quality": 95, "frameTime": seconds}

        with patch("app._video_frame", side_effect=fake), patch.object(app_module, "YOUTUBE_FULL_FRAMES", True):
            self.client.get("/api/youtube/frame?v=abcdefghijk&t=3")
            self.client.get("/api/youtube/frame?v=abcdefghijk&t=3&quality=best")
        self.assertEqual(seen, [app_module.YOUTUBE_FRAME_MAX_HEIGHT, app_module.YOUTUBE_FRAME_BEST_HEIGHT])
        self.assertEqual(app_module.YOUTUBE_FRAME_BEST_HEIGHT, 2160)

    def test_each_ceiling_has_its_own_stream(self):
        self.assertEqual(app_module._stream_key("abcdefghijk", app_module.YOUTUBE_FRAME_MAX_HEIGHT), "abcdefghijk")
        self.assertEqual(app_module._stream_key("abcdefghijk", 2160), "abcdefghijk@2160")

class ResourceCeilingTests(unittest.TestCase):
    """Nothing keyed by a caller-supplied video id may grow without bound.

    /api/youtube/frame accepts any 11 characters from [A-Za-z0-9_-] and takes
    the video's lock *before* it tries to resolve anything, so an id that is
    not a real video still left an entry behind. A script walking random ids
    grew the lock table forever, and the stream cache -- which holds a
    kept-alive socket per entry -- had no ceiling either.
    """

    def setUp(self):
        self._locks = app_module._YOUTUBE_VIDEO_LOCKS.copy()
        self._streams = app_module.YOUTUBE_STREAM_CACHE.copy()
        app_module._YOUTUBE_VIDEO_LOCKS.clear()
        app_module.YOUTUBE_STREAM_CACHE.clear()

    def tearDown(self):
        app_module._YOUTUBE_VIDEO_LOCKS.clear()
        app_module._YOUTUBE_VIDEO_LOCKS.update(self._locks)
        app_module.YOUTUBE_STREAM_CACHE.clear()
        app_module.YOUTUBE_STREAM_CACHE.update(self._streams)

    @staticmethod
    def _ids(count, prefix="id"):
        return [f"{prefix}{index:09d}"[:11].ljust(11, "x") for index in range(count)]

    def test_a_flood_of_unknown_ids_does_not_grow_the_lock_table(self):
        cap = app_module._YOUTUBE_VIDEO_LOCKS_MAX
        for video_id in self._ids(cap * 4):
            app_module._video_lock(video_id)
        self.assertLessEqual(len(app_module._YOUTUBE_VIDEO_LOCKS), cap)

    def test_a_lock_in_use_is_never_evicted(self):
        """Evicting a held lock hands the next caller for the same video a
        different one, and the two then seek concurrently down a single
        kept-alive connection."""
        held = app_module._video_lock("HELDHELDHEL")
        held.acquire()
        try:
            for video_id in self._ids(app_module._YOUTUBE_VIDEO_LOCKS_MAX * 3, "z"):
                app_module._video_lock(video_id)
            self.assertIs(app_module._video_lock("HELDHELDHEL"), held)
        finally:
            held.release()

    def test_the_stream_cache_is_capped_and_keeps_the_freshest_entry(self):
        cap = app_module.YOUTUBE_STREAM_CACHE_MAX_ENTRIES
        ids = self._ids(cap * 2)
        for video_id in ids:
            app_module.YOUTUBE_STREAM_CACHE[video_id] = {
                "expires": time.time() + 3600, "conn": None,
            }
        app_module._evict_stream_cache(ids[-1])
        self.assertLessEqual(len(app_module.YOUTUBE_STREAM_CACHE), cap)
        self.assertIn(ids[-1], app_module.YOUTUBE_STREAM_CACHE)

    def test_eviction_closes_the_connection_it_drops(self):
        """An evicted entry still owns a socket. Dropping the reference without
        closing it leaks a file descriptor per evicted video."""
        closed = []

        class Conn:
            def close(self):
                closed.append(True)

        app_module.YOUTUBE_STREAM_CACHE["expiredxxxx"] = {"expires": 1, "conn": Conn()}
        app_module.YOUTUBE_STREAM_CACHE["freshxxxxxx"] = {
            "expires": time.time() + 3600, "conn": None,
        }
        app_module._evict_stream_cache("freshxxxxxx")

        self.assertEqual(closed, [True])
        self.assertEqual(list(app_module.YOUTUBE_STREAM_CACHE), ["freshxxxxxx"])

    def test_decode_slots_are_limited_and_release_again(self):
        """Cutting a frame is the most expensive thing the server does and
        nothing authenticates the caller, so the number running at once is
        capped globally -- globally rather than per-IP, because a per-IP budget
        would mean keeping a table of who asked for what."""
        app_module.YOUTUBE_FRAME_WAIT_SECONDS = 0.05
        held = []
        try:
            for _ in range(app_module.YOUTUBE_FRAME_CONCURRENCY):
                slot = app_module._youtube_frame_slot()
                slot.__enter__()
                held.append(slot)
            with self.assertRaises(app_module._Busy):
                with app_module._youtube_frame_slot():
                    pass
        finally:
            for slot in held:
                slot.__exit__(None, None, None)
            app_module.YOUTUBE_FRAME_WAIT_SECONDS = 20

        # Released again, so a busy minute does not disable capture for good.
        with app_module._youtube_frame_slot():
            pass

    def test_a_busy_server_still_answers_a_capture_from_the_storyboard(self):
        """The fallback exists precisely so a frame request never hard-fails."""
        app_module.YOUTUBE_FRAME_WAIT_SECONDS = 0.05
        app_module.YOUTUBE_STORYBOARD_CACHE.clear()
        app_module.YOUTUBE_SPRITE_CACHE.clear()
        fake = FakeYouTube()
        held = []
        try:
            for _ in range(app_module.YOUTUBE_FRAME_CONCURRENCY):
                slot = app_module._youtube_frame_slot()
                slot.__enter__()
                held.append(slot)
            # _video_frame is deliberately NOT stubbed here: the point is that
            # the slot ceiling stops it before it touches the network at all.
            with patch("app._fetch_youtube_bytes", side_effect=fake):
                response = app.test_client().get(
                    f"/api/youtube/frame?v={VIDEO_ID}&t=3"
                )
        finally:
            for slot in held:
                slot.__exit__(None, None, None)
            app_module.YOUTUBE_FRAME_WAIT_SECONDS = 20

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["source"], "storyboard")


try:
    from playwright.sync_api import sync_playwright

    PLAYWRIGHT_AVAILABLE = True
except ImportError:  # pragma: no cover - optional dependency
    PLAYWRIGHT_AVAILABLE = False


# A stand-in for https://www.youtube.com/iframe_api. It builds a real (empty)
# iframe where the player would be, reports itself playing, and implements the
# handful of methods youtube.js calls - so the capture flow runs without the
# network.
FAKE_IFRAME_API = """
window.__ytCalls = [];
window.YT = {
  PlayerState: { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 },
  Player: function (id, options) {
    const mount = document.getElementById(id);
    const frame = document.createElement('iframe');
    frame.id = id;
    frame.style.width = '100%';
    frame.style.height = '100%';
    mount.replaceWith(frame);
    let state = 1;
    let videoId = options.videoId;
    const player = {
      getIframe: () => frame,
      getCurrentTime: () => 61.3,
      getDuration: () => 212,
      getPlayerState: () => state,
      getVideoData: () => ({ video_id: videoId, title: 'Circle theorems' }),
      pauseVideo: () => { window.__ytCalls.push('pause'); state = 2; },
      playVideo: () => { state = 1; },
      seekTo: () => {},
      loadVideoById: (load) => { videoId = load.videoId; },
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

STORYBOARD_FRAME = (
    "data:image/jpeg;base64,"
    + base64.b64encode(
        (lambda buffer: (Image.new("RGB", (320, 180), (40, 90, 200)).save(buffer, "JPEG"), buffer.getvalue())[1])(io.BytesIO())
    ).decode()
)

# There is no screen capture any more, so the only stub needed is a tripwire.
# If anything ever reaches for getDisplayMedia again the count goes up and the
# test that watches it fails: asking to share the whole screen to photograph one
# video was the complaint that started this.
SCREEN_SHARE_TRIPWIRE = """
window.__displayMediaCalls = 0;
if (navigator.mediaDevices) {
  navigator.mediaDevices.getDisplayMedia = async () => {
    window.__displayMediaCalls += 1;
    throw new Error('screen capture must not be used');
  };
}
"""

# A full-resolution frame, as the server now returns it: a solid orange 16:9
# picture standing in for the decoded video frame.
def _video_frame_payload(width=1920, height=1080):
    image = Image.new("RGB", (width, height), (240, 130, 20))
    buffer = io.BytesIO()
    image.save(buffer, "JPEG", quality=90)
    return (
        "data:image/jpeg;base64," + base64.b64encode(buffer.getvalue()).decode()
    )


VIDEO_FRAME = _video_frame_payload()
@unittest.skipUnless(PLAYWRIGHT_AVAILABLE, "Playwright is not installed")
class FrameCaptureBrowserTests(unittest.TestCase):
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

    def open_player(self, capture_stub=SCREEN_SHARE_TRIPWIRE, frame_body=None, frame_status=200,
                    viewport=None):
        self.frame_body = frame_body if frame_body is not None else {
            "videoId": VIDEO_ID, "image": VIDEO_FRAME, "width": 1920,
            "height": 1080, "frameTime": 61.3, "source": "video",
        }
        self.frame_status = frame_status
        context = self.browser.new_context(**({"viewport": viewport} if viewport else {}))
        self.addCleanup(context.close)
        context.add_init_script("localStorage.setItem('inkyscib-consent-v1', JSON.stringify({version: 1, analytics: false})); localStorage.setItem('inkyscib-feature-tour-v1', 'seen')")
        context.add_init_script(capture_stub)
        page = context.new_page()
        self.errors = []
        page.on("pageerror", lambda error: self.errors.append(str(error)))

        self.upstream_requests = []
        self.frame_requests = []
        page.on("request", lambda req: self.upstream_requests.append(req.url))
        page.route(
            "https://www.youtube.com/iframe_api",
            lambda route: route.fulfill(status=200, content_type="text/javascript", body=FAKE_IFRAME_API),
        )

        def serve_frame(route):
            self.frame_requests.append(route.request.url)
            route.fulfill(
                status=self.frame_status,
                content_type="application/json",
                body=json.dumps(self.frame_body),
            )

        page.route("**/api/youtube/frame?**", serve_frame)

        # Loading a video warms the server's frame cut. Routed here because the
        # test server is the real app, and a live /prepare would resolve a real
        # stream over the network for every test that opens a video.
        self.prepare_requests = []

        def serve_prepare(route):
            self.prepare_requests.append(route.request.url)
            route.fulfill(
                status=200,
                content_type="application/json",
                body=json.dumps({"ready": True, "width": 1920, "height": 1080}),
            )

        page.route("**/api/youtube/prepare?**", serve_prepare)
        page.goto(self.base_url + "/write", wait_until="domcontentloaded")
        page.wait_for_function("() => window.appState?.storageReady === true")
        page.evaluate(
            """() => {
              window.appState.paths = [];
              document.getElementById('ytToggleBtn').click();
              document.getElementById('ytSearchInput').value = 'https://youtu.be/%s';
              document.getElementById('ytSearchBtn').click();
            }""" % VIDEO_ID
        )
        page.wait_for_function("() => { const b = document.getElementById('ytSaveFrame'); return b && !b.disabled; }")
        return page

    def capture(self, page):
        return page.evaluate(
            """async () => {
              await window.Inkyscib.YouTube.saveCurrentFrame();
              const path = window.appState.paths.at(-1) || null;
              return path && { tool: path.tool, image: path.image, videoId: path.videoId,
                               videoTime: path.videoTime, count: window.appState.paths.length };
            }"""
        )

    def last_path_geometry(self, page):
        """The fields capture() does not project: where the frame was placed
        and what ratio it was stored at."""
        return page.evaluate(
            """() => {
              const path = window.appState.paths.at(-1);
              if (!path) return null;
              return {
                aspectRatio: path.aspectRatio,
                width: Math.abs(path.points[1].x - path.points[0].x),
                height: Math.abs(path.points[1].y - path.points[0].y)
              };
            }"""
        )

    def assert_never_used_a_thumbnail(self):
        thumbnails = [url for url in self.upstream_requests if "ytimg.com/vi/" in url]
        self.assertEqual(thumbnails, [], "a thumbnail must never stand in for the frame")

    def test_the_servers_frame_is_placed_at_the_moment_asked_for(self):
        """One full-frame request, carrying the exact playhead time, and the
        image is placed byte for byte. A quick preview request goes out beside
        it (since 2.7.0) so the page has something at once; the full frame
        replaces it."""
        page = self.open_player()
        path = self.capture(page)

        self.assertIsNotNone(path)
        self.assertEqual(path["tool"], "youtube-frame")
        self.assertEqual(path["image"], VIDEO_FRAME)
        self.assertEqual(path["videoId"], VIDEO_ID)
        self.assertAlmostEqual(path["videoTime"], 61.3, places=2)

        full = [url for url in self.frame_requests if "quality=preview" not in url]
        previews = [url for url in self.frame_requests if "quality=preview" in url]
        self.assertEqual(len(full), 1, self.frame_requests)
        self.assertEqual(len(previews), 1, self.frame_requests)
        request = full[0]
        self.assertIn(f"v={VIDEO_ID}", request)
        # The timestamp goes out at full precision: the frame saved has to be
        # the frame that was on screen, not the nearest second.
        self.assertIn("t=61.3", request)
        self.assert_never_used_a_thumbnail()
        self.assertEqual(self.errors, [])

    def test_a_slow_import_can_be_stopped_from_the_chip(self):
        page = self.open_player()
        held = []
        # Registered last, so it wins: the server never answers.
        page.route("**/api/youtube/frame?**", lambda route: held.append(route))
        page.evaluate("() => { window.Inkyscib.YouTube.saveCurrentFrame(); }")
        page.wait_for_selector(".file-ribbon-progress-stop:not([hidden])", state="attached")
        page.evaluate("() => document.querySelector('.file-ribbon-progress-stop').click()")
        page.wait_for_timeout(150)
        state = page.evaluate("""() => ({
          frames: window.appState.paths.filter((p) => p.tool === 'youtube-frame').length,
          label: document.querySelector('.file-ribbon-progress-label').textContent,
          canCapture: !document.getElementById('ytSaveFrame').disabled })""")
        self.assertEqual(state, {"frames": 0, "label": "Stopped", "canCapture": True})
        self.assertEqual(self.errors, [])

    def test_the_quality_toggle_asks_for_the_best_and_is_remembered(self):
        page = self.open_player()
        self.assertEqual(page.inner_text("#ytFrameQuality"), "HD")
        page.evaluate("() => document.getElementById('ytFrameQuality').click()")
        self.assertEqual(page.inner_text("#ytFrameQuality"), "MAX")
        self.capture(page)
        full = [u for u in self.frame_requests if "quality=preview" not in u]
        self.assertTrue(full and "quality=best" in full[-1], self.frame_requests)
        self.assertEqual(page.evaluate("() => localStorage.getItem('inkyscib-yt-frame-best')"), "1")

    def test_nothing_ever_asks_to_share_the_screen(self):
        """The whole point of moving this to the server. Two captures, so a
        second one cannot quietly reach for it either."""
        page = self.open_player()
        self.capture(page)
        self.capture(page)

        self.assertEqual(page.evaluate("() => window.__displayMediaCalls"), 0)
        self.assertEqual(len([u for u in self.frame_requests if "quality=preview" not in u]), 2)
        self.assertEqual(self.errors, [])

    def test_the_player_is_not_resized_to_take_the_shot(self):
        """Nothing moves on screen: the panel is the same size and in the same
        place afterwards."""
        page = self.open_player()
        # The panel animates in, so a measurement taken too early is 2px out
        # and reads exactly like the capture having moved it. Settle first.
        page.wait_for_function(
            """() => {
              const el = document.getElementById('ytPlayer');
              const r = el.getBoundingClientRect();
              const key = [r.width, r.height, r.x, r.y].join();
              const settled = window.__lastBox === key;
              window.__lastBox = key;
              return settled;
            }""",
            timeout=5000,
        )
        before = page.evaluate(
            "() => { const r = document.getElementById('ytPlayer').getBoundingClientRect();"
            "  return { w: Math.round(r.width), h: Math.round(r.height),"
            "           x: Math.round(r.x), y: Math.round(r.y) }; }"
        )
        self.capture(page)
        after = page.evaluate(
            "() => { const r = document.getElementById('ytPlayer').getBoundingClientRect();"
            "  return { w: Math.round(r.width), h: Math.round(r.height),"
            "           x: Math.round(r.x), y: Math.round(r.y) }; }"
        )
        self.assertEqual(before, after, "the player moved or resized during a capture")
        self.assertEqual(self.errors, [])

    def test_a_frame_is_placed_at_the_size_it_was_captured(self):
        """Every frame used to be placed at a hard-coded 360 units wide, with
        the captured dimensions read only for their ratio and then discarded --
        so a sharper capture was thrown away at paint time."""
        page = self.open_player()
        path = self.capture(page)
        self.assertIsNotNone(path)

        geometry = self.last_path_geometry(page)
        self.assertGreater(
            geometry["width"], 360 * 1.15,
            f"the frame was placed {geometry['width']:.0f} units wide, at or near "
            "the old hard-coded 360 regardless of what was captured",
        )
        self.assertAlmostEqual(
            geometry["width"] / geometry["height"], geometry["aspectRatio"], delta=0.02
        )
        self.assertAlmostEqual(geometry["aspectRatio"], 16 / 9, delta=0.02)
        self.assertEqual(self.errors, [])

    def test_the_ribbon_says_what_it_is_doing(self):
        """A couple of seconds of silence with nothing on screen reads as a
        broken button, so the work is named where the commands are."""
        page = self.open_player()
        page.evaluate(
            """() => {
              window.__progressSeen = [];
              const chip = document.getElementById('fileRibbonProgress');
              new MutationObserver(() => {
                if (!chip.hidden) {
                  window.__progressSeen.push(
                    chip.querySelector('.file-ribbon-progress-label').textContent
                  );
                }
              }).observe(chip, { attributes: true, childList: true, subtree: true });
            }"""
        )
        self.capture(page)

        seen = page.evaluate("() => window.__progressSeen")
        self.assertTrue(seen, "the ribbon never said anything was happening")
        self.assertTrue(
            any("YT frame" in text for text in seen),
            f"the progress chip never named the job: {seen}",
        )
        # And it goes away again -- judged by what is on screen, not by the
        # hidden property. The property was true all along while a class
        # selector's display:inline-flex kept the chip visible on every page
        # load, spinning with nothing running.
        page.wait_for_function(
            "() => getComputedStyle(document.getElementById('fileRibbonProgress')).display === 'none'",
            timeout=5000,
        )
        self.assertEqual(self.errors, [])

    TITLE_BAR_IS_REACHABLE = """() => {
      const handle = document.getElementById('ytDragHandle')
        || document.querySelector('#ytPlayer .yt-player-header');
      const r = handle.getBoundingClientRect();
      // Three points along the bar, not just the centre: the ribbon covered
      // the left half of it on a tablet.
      const ys = r.top + r.height / 2;
      return [0.15, 0.5, 0.85].map((f) => {
        const hit = document.elementFromPoint(r.left + r.width * f, ys);
        return !!hit && document.getElementById('ytPlayer').contains(hit);
      });
    }"""

    # The other half of "no overlap": with the chrome ignored, a player dragged
    # to the top sits on top of the tool bar instead (the tool bar stacks below
    # it), so its own title bar is reachable while it covers the tools. A
    # mutation check caught exactly that -- the title-bar check alone passed.
    CHROME_IS_REACHABLE = """() => {
      const targets = [
        document.querySelector('.file-ribbon [data-ribbon-tab="file"]'),
        document.querySelector('.file-ribbon [data-ribbon-tab="tools"]'),
        document.getElementById('penTool'),
      ].filter(Boolean);
      return targets.map((el) => {
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) return true;  // not on screen at this width
        // Below 1180px the tool row scrolls sideways (chrome-compact.css), and
        // opening the player from its button at the far end scrolls the pen
        // out of the row. Scrolled away is not covered.
        const row = el.closest('.toolbar');
        if (row) {
          const bar = row.getBoundingClientRect();
          if (r.right <= bar.left + 1 || r.left >= bar.right - 1) return true;
        }
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return !!hit && el.contains(hit);
      });
    }"""

    def assert_no_overlap(self, page, where):
        bar = page.evaluate(self.TITLE_BAR_IS_REACHABLE)
        self.assertEqual(bar, [True, True, True], f"{where}: part of the player's title bar is covered")
        chrome = page.evaluate(self.CHROME_IS_REACHABLE)
        self.assertTrue(all(chrome), f"{where}: the player covers the ribbon or the tool bar: {chrome}")

    def test_the_title_bar_is_not_under_the_ribbon(self):
        """Reported 2026-09-19: opening the player and starting a video left half
        its title bar hidden behind the File ribbon, which stacks above it."""
        for width, height in ((960, 720), (640, 800), (1440, 900)):
            with self.subTest(viewport=f"{width}x{height}"):
                page = self.open_player(viewport={"width": width, "height": height})
                page.wait_for_timeout(200)
                self.assert_no_overlap(page, f"opened at {width}x{height}")
                self.assertEqual(self.errors, [])

    def test_the_title_bar_cannot_be_dragged_under_the_ribbon(self):
        """The title bar is the only handle there is. Dragged under the ribbon,
        the player could not be moved again."""
        page = self.open_player(viewport={"width": 960, "height": 720})
        page.wait_for_timeout(200)
        box = page.eval_on_selector(
            "#ytDragHandle",
            "el => { const r = el.getBoundingClientRect(); return {x: r.left + 40, y: r.top + r.height / 2}; }",
        )
        page.mouse.move(box["x"], box["y"])
        page.mouse.down()
        page.mouse.move(box["x"], 4, steps=8)
        page.mouse.up()
        page.wait_for_timeout(200)

        self.assert_no_overlap(page, "dragged to the top")
        self.assertEqual(self.errors, [])

    def test_loading_a_video_warms_the_frame_cut_once(self):
        """The ~3s stream resolve happens while the video is watched, not after
        the button is pressed: measured, first capture 0.6s against 4.8s."""
        page = self.open_player()
        page.wait_for_timeout(300)
        self.assertEqual(len(self.prepare_requests), 1, self.prepare_requests)
        self.assertIn(f"v={VIDEO_ID}", self.prepare_requests[0])

        # Capturing does not prepare again.
        self.capture(page)
        self.capture(page)
        self.assertEqual(len(self.prepare_requests), 1, self.prepare_requests)
        self.assertEqual(self.errors, [])

    def test_the_click_is_answered_before_the_frame_arrives(self):
        """The shutter goes on in the same task as the click, so there is never
        a moment where pressing the button looks like it did nothing."""
        page = self.open_player()
        shuttered = page.evaluate(
            """() => {
              const container = document.getElementById('ytEmbedSlot').parentElement;
              // Deliberately not awaited: what matters is the state the
              // instant the click has been handled.
              window.Inkyscib.YouTube.saveCurrentFrame();
              return container.classList.contains('yt-shutter');
            }"""
        )
        self.assertTrue(shuttered, "nothing on screen acknowledged the click")
        self.assertEqual(self.errors, [])

    def test_the_progress_chip_is_not_on_screen_when_nothing_is_running(self):
        page = self.open_player()
        display = page.evaluate(
            "() => getComputedStyle(document.getElementById('fileRibbonProgress')).display"
        )
        self.assertEqual(display, "none", "the progress chip shows with no job running")
        self.assertEqual(self.errors, [])

    def test_a_storyboard_fallback_is_still_placed_and_labelled(self):
        """When the video cannot be read the server says so, and the preview
        frame is placed rather than nothing."""
        page = self.open_player(frame_body={
            "videoId": VIDEO_ID, "image": STORYBOARD_FRAME, "width": 320,
            "height": 180, "frameTime": 62.0, "source": "storyboard",
        })
        path = self.capture(page)

        self.assertIsNotNone(path)
        self.assertEqual(path["image"], STORYBOARD_FRAME)
        self.assert_never_used_a_thumbnail()
        self.assertEqual(self.errors, [])

    def test_a_failed_frame_request_places_nothing_and_says_so(self):
        page = self.open_player(frame_status=404, frame_body={"error": "YouTube has no preview frames for this video"})
        page.unroute("**/api/youtube/frame?**")
        page.route(
            "**/api/youtube/frame?**",
            lambda route: route.fulfill(
                status=404, content_type="application/json",
                body=json.dumps({"error": "YouTube has no preview frames for this video"}),
            ),
        )
        path = self.capture(page)

        self.assertIsNone(path)
        toast = page.locator(".yt-frame-toast.is-error").first.inner_text()
        self.assertIn("no preview frames", toast.lower())
        self.assert_never_used_a_thumbnail()


class FullResolutionDefaultTests(unittest.TestCase):
    """Since 2.0.1 a saved moment is cut from the video itself, at the source's
    own resolution up to a ceiling (1080p since 2.7.0, for speed; 4K before),
    unless the host switches it off."""

    def setUp(self):
        self.client = app.test_client()

    def test_full_capture_is_on_unless_the_host_switches_it_off(self):
        source = (Path(app.root_path) / "app.py").read_text(encoding="utf-8")
        self.assertIn('os.environ.get("YOUTUBE_FULL_FRAMES", "true")', source)
        self.assertEqual(app_module.YOUTUBE_FRAME_MAX_HEIGHT, 1080)
        self.assertEqual(app_module.MAX_FRAME_WIDTH, 1920)

    def test_the_stream_is_chosen_by_resolution_then_decode_speed(self):
        """Resolution decides. The codec is never a filter (4K exists only
        as VP9 or AV1, and a host may raise the ceiling); H.264 and 30 fps only
        break ties, because they are the quickest to decode."""
        captured = {}

        class FakeYDL:
            def __init__(self, options):
                captured.update(options)

            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

            def extract_info(self, url, download=False):
                return {"url": "https://example.googlevideo.com/v", "format_id": "315",
                        "width": 1920, "height": 1080, "duration": 600}

        fake_module = type(sys)("yt_dlp")
        fake_module.YoutubeDL = FakeYDL
        app_module.YOUTUBE_STREAM_CACHE.pop("abcdefghijk", None)
        with patch.dict(sys.modules, {"yt_dlp": fake_module}), patch("app._patch_ytdlp_ssl"):
            entry = app_module._youtube_stream("abcdefghijk")
        app_module.YOUTUBE_STREAM_CACHE.pop("abcdefghijk", None)
        self.assertNotIn("avc1", captured["format"])
        self.assertIn("height<=1080", captured["format"])
        self.assertIn("dynamic_range=SDR", captured["format"])
        self.assertEqual(captured["format_sort"], ["res:1080", "vcodec:h264", "fps:30"])
        self.assertEqual((entry["width"], entry["height"]), (1920, 1080))

    def test_frames_are_encoded_at_quality_95_without_chroma_subsampling(self):
        from PIL import Image as PILImage
        image = PILImage.new("RGB", (640, 360))
        # Thin coloured lines: what 4:2:0 subsampling smears.
        for x in range(0, 640, 4):
            for y in range(360):
                image.putpixel((x, y), (220, 30, 30))
        data_url, quality = app_module._encode_frame(image)
        self.assertEqual(quality, 95)
        raw = base64.b64decode(data_url.split(",", 1)[1])
        decoded = PILImage.open(io.BytesIO(raw))
        decoded.load()
        # JpegImagePlugin exposes the sampling via layer; 4:4:4 means every
        # component is sampled 1x1.
        self.assertEqual({(h, v) for _, h, v, _ in decoded.layer}, {(1, 1)})

    def test_an_oversized_frame_steps_quality_down_instead_of_failing(self):
        from PIL import Image as PILImage
        image = PILImage.effect_noise((800, 450), 120).convert("RGB")
        with patch.object(app_module, "YOUTUBE_FRAME_MAX_DATA_URL", 250_000):
            data_url, quality = app_module._encode_frame(image)
        self.assertLess(quality, 95)
        self.assertTrue(data_url.startswith("data:image/jpeg;base64,"))

    def test_the_server_budget_fits_inside_the_browser_budget(self):
        storage = (Path(app.root_path) / "static/js/storage.js").read_text(encoding="utf-8")
        player = (Path(app.root_path) / "static/js/youtube.js").read_text(encoding="utf-8")
        self.assertIn("INKYSCIB_MAX_FRAME_DATA_URL_LENGTH = 12 * 1024 * 1024", storage)
        self.assertIn("MAX_FRAME_DATA_URL = 12 * 1024 * 1024", player)
        self.assertLessEqual(app_module.YOUTUBE_FRAME_MAX_DATA_URL, 12 * 1024 * 1024)

    def test_switched_off_a_frame_request_never_touches_the_video_stream(self):
        frame = {"image": "data:image/jpeg;base64,AAAA", "width": 320, "height": 180}
        with patch.object(app_module, "YOUTUBE_FULL_FRAMES", False), \
                patch("app._video_frame") as cut, \
                patch("app._storyboard_frame", return_value=frame):
            response = self.client.get("/api/youtube/frame?v=abcdefghijk&t=12")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["source"], "storyboard")
        cut.assert_not_called()

    def test_switched_off_warming_is_declined_without_resolving_anything(self):
        with patch.object(app_module, "YOUTUBE_FULL_FRAMES", False), \
                patch("app._prepare_video") as prepare:
            response = self.client.get("/api/youtube/prepare?v=abcdefghijk")
        self.assertEqual(response.get_json(), {"ready": False})
        prepare.assert_not_called()


if __name__ == "__main__":
    unittest.main()
