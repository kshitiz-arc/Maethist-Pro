import json
import threading
import unittest
from unittest.mock import patch

from app import YOUTUBE_SEARCH_CACHE, _parse_youtube_search_html, app


class YouTubeSearchParserTests(unittest.TestCase):
    def setUp(self):
        YOUTUBE_SEARCH_CACHE.clear()

    def test_parser_handles_current_assignment_and_nested_braces_in_titles(self):
        initial_data = {
            "contents": {
                "changedLayoutRenderer": {
                    "items": [
                        {
                            "videoRenderer": {
                                "videoId": "abcDEF123_4",
                                "title": {"runs": [{"text": "Polynomials {Class 10}"}]},
                                "thumbnail": {
                                    "thumbnails": [
                                        {"url": "https://i.ytimg.com/vi/abcDEF123_4/hqdefault.jpg"}
                                    ]
                                },
                                "longBylineText": {"runs": [{"text": "Math Channel"}]},
                                "lengthText": {"simpleText": "12:34"},
                            }
                        }
                    ]
                }
            }
        }
        html = (
            '<script>window["ytInitialData"] = '
            + json.dumps(initial_data)
            + ";</script>"
        )

        videos = _parse_youtube_search_html(html)

        self.assertEqual(len(videos), 1)
        self.assertEqual(videos[0]["id"], "abcDEF123_4")
        self.assertEqual(videos[0]["title"], "Polynomials {Class 10}")
        self.assertEqual(videos[0]["channel"], "Math Channel")
        self.assertEqual(videos[0]["duration"], "12:34")

    def test_search_endpoint_keeps_a_stable_array_contract(self):
        expected = [{"id": "abcDEF123_4", "title": "Polynomial lesson"}]
        with patch("app._search_youtube_result", return_value=(expected, True)):
            response = app.test_client().get("/api/youtube/search?q=polynomials")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json(), expected)
        self.assertEqual(response.headers["X-Inkyscib-YouTube-Status"], "ok")

    def test_unavailable_upstream_is_explicit_without_breaking_the_array_contract(self):
        with patch("app._search_youtube_result", return_value=([], False)):
            response = app.test_client().get("/api/youtube/search?q=polynomials")

        self.assertEqual(response.get_json(), [])
        self.assertEqual(response.headers["X-Inkyscib-YouTube-Status"], "unavailable")


try:
    from playwright.sync_api import sync_playwright
    from werkzeug.serving import make_server

    PLAYWRIGHT_AVAILABLE = True
except ImportError:
    PLAYWRIGHT_AVAILABLE = False


@unittest.skipUnless(PLAYWRIGHT_AVAILABLE, "Playwright is not installed")
class YouTubeSearchFallbackBrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = make_server("127.0.0.1", 0, app, threaded=True)
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

    def test_failed_internal_search_offers_a_working_client_side_escape_hatch(self):
        context = self.browser.new_context()
        self.addCleanup(context.close)
        context.add_init_script(
            """
            const nativeFetch = window.fetch.bind(window);
            window.fetch = (input, options) => {
              if (String(input).startsWith('/api/youtube/search')) {
                return Promise.resolve(new Response('', { status: 503 }));
              }
              return nativeFetch(input, options);
            };
            window.__openedYouTubeUrl = '';
            window.open = (url) => { window.__openedYouTubeUrl = String(url); return null; };
            """
        )
        page = context.new_page()
        page.goto(self.base_url + "/write", wait_until="domcontentloaded")
        page.wait_for_function("() => window.appState?.storageReady === true")

        page.evaluate(
            """
            () => {
              document.getElementById('ytToggleBtn').click();
              document.getElementById('ytSearchInput').value = 'class 10 maths polynomials';
              document.getElementById('ytSearchBtn').click();
            }
            """
        )
        page.locator("#ytSearchExternalBtn").wait_for()

        self.assertIn(
            "paste a video link above",
            page.locator("#ytSearchResults").inner_text().lower(),
        )
        page.evaluate("() => document.getElementById('ytSearchExternalBtn').click()")
        opened_url = page.evaluate("() => window.__openedYouTubeUrl")
        self.assertIn("youtube.com/results?search_query=class%2010%20maths%20polynomials", opened_url)
        self.assertTrue(page.locator("#ytSearchRetryBtn").is_visible())

    def test_youtube_capture_resize_keeps_its_native_aspect_ratio(self):
        context = self.browser.new_context()
        self.addCleanup(context.close)
        page = context.new_page()
        page.goto(self.base_url + "/write", wait_until="domcontentloaded")
        page.wait_for_function("() => window.appState?.storageReady === true")

        result = page.evaluate(
            """
            () => {
              const state = window.appState;
              state.transform = { scale: 1, offsetX: 0, offsetY: 0 };
              state.notebook.active = false;
              state.ppt.active = false;
              state.paths = [{
                tool: 'youtube-frame',
                points: [{ x: 100, y: 120 }, { x: 420, y: 300 }],
                image: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
                videoId: 'abcDEF123_4',
                videoTime: 2,
                aspectRatio: 16 / 9
              }];
              window.setTool('select');
              window.Inkyscib.Selection.selectIndex(0);

              const canvas = document.getElementById('drawingCanvas');
              const rect = canvas.getBoundingClientRect();
              const asEvent = (x, y) => ({
                clientX: rect.left + x * rect.width / canvas.width,
                clientY: rect.top + y * rect.height / canvas.height,
                pointerType: 'mouse'
              });

              const selection = window.Inkyscib.Selection;
              selection.handleDown(asEvent(420, 300));
              selection.handleMove(asEvent(260, 400));
              selection.handleUp();

              const points = state.paths[0].points;
              const width = Math.abs(points[1].x - points[0].x);
              const height = Math.abs(points[1].y - points[0].y);
              return { width, height, aspectRatio: state.paths[0].aspectRatio };
            }
            """
        )

        self.assertAlmostEqual(result["width"] / result["height"], 16 / 9, places=5)
        self.assertAlmostEqual(result["aspectRatio"], 16 / 9, places=5)

    def test_old_squashed_youtube_captures_are_repaired_and_persist_the_ratio(self):
        context = self.browser.new_context()
        self.addCleanup(context.close)
        page = context.new_page()
        page.goto(self.base_url + "/write", wait_until="domcontentloaded")
        page.wait_for_function("() => window.appState?.storageReady === true")

        result = page.evaluate(
            """
            () => {
              const oldCapture = {
                tool: 'youtube-frame',
                points: [{ x: 20, y: 80 }, { x: 380, y: 210 }],
                image: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
                videoId: 'abcDEF123_4',
                videoTime: 2
              };
              const repaired = window.normalizeLoadedPath(oldCapture);
              const saved = window.compactPath(repaired);
              const width = Math.abs(repaired.points[1].x - repaired.points[0].x);
              const height = Math.abs(repaired.points[1].y - repaired.points[0].y);
              return {
                repairedRatio: width / height,
                runtimeRatio: repaired.aspectRatio,
                savedRatio: saved.aspectRatio
              };
            }
            """
        )

        self.assertAlmostEqual(result["repairedRatio"], 16 / 9, places=5)
        self.assertAlmostEqual(result["runtimeRatio"], 16 / 9, places=5)
        self.assertAlmostEqual(result["savedRatio"], 16 / 9, places=5)


if __name__ == "__main__":
    unittest.main()
