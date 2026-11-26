"""The live class board (live_board.py, live-board.js, live-view.js; 2.10.0).

A teacher's page, followed live by a class at /live/<code>. Pinned here: only
the key holder writes, a poll gets exactly what changed, a board is deleted
when it ends or goes quiet, the QR code really reads, and in the browser a
student sees strokes while they are being written, undo, and the end.
"""

import threading
import time
import unittest
from pathlib import Path

import live_board
from app import app
from browser_server import make_browser_server
from qr_svg import qr_matrix

try:
    from playwright.sync_api import sync_playwright

    PLAYWRIGHT_AVAILABLE = True
except ImportError:  # pragma: no cover
    PLAYWRIGHT_AVAILABLE = False

try:
    import cv2
    import numpy as np

    CV2_AVAILABLE = True
except ImportError:  # pragma: no cover
    CV2_AVAILABLE = False

ROOT = Path(__file__).resolve().parents[1]


def stroke(x, n=6):
    return {"tool": "pen", "color": "#111111", "size": 3, "penStyle": "default",
            "points": [{"x": x + i, "y": 10 + i, "pressure": 0.5} for i in range(n)]}


class LiveBoardApiTests(unittest.TestCase):
    def setUp(self):
        self.client = app.test_client()
        with live_board._LOCK:
            live_board._BOARDS.clear()

    def start(self):
        data = self.client.post("/api/live").get_json()
        return data["code"], {"X-Live-Key": data["key"]}

    def test_a_board_has_a_readable_code_and_a_secret_key(self):
        code, key = self.start()
        self.assertRegex(code, r"^[A-HJKMNP-Z2-9]{6}$")
        self.assertGreaterEqual(len(key["X-Live-Key"]), 24)
        board = live_board._BOARDS[code]
        self.assertNotIn(key["X-Live-Key"], repr(board), "only a hash of the key is kept")

    def test_only_the_key_holder_writes(self):
        code, key = self.start()
        body = {"set": {"a1": stroke(0)}, "order": ["a1"]}
        self.assertEqual(self.client.post(f"/api/live/{code}", json=body).status_code, 403)
        self.assertEqual(self.client.post(f"/api/live/{code}", json=body, headers={"X-Live-Key": "nope"}).status_code, 403)
        self.assertEqual(self.client.post(f"/api/live/{code}", json=body, headers=key).status_code, 200)
        self.assertEqual(self.client.post("/api/live/ZZZZZZ", json=body, headers=key).status_code, 404)

    def test_a_poll_gets_only_what_changed(self):
        code, key = self.start()
        v1 = self.client.post(f"/api/live/{code}", json={
            "set": {"a1": stroke(0), "b2": stroke(50)}, "order": ["a1", "b2"],
            "view": {"x": 0, "y": 0, "w": 800, "h": 600}, "bg": "#FBFBF9", "theme": "light"}, headers=key).get_json()["v"]
        full = self.client.get(f"/api/live/{code}?since=0").get_json()
        self.assertEqual(full["order"], ["a1", "b2"])
        self.assertEqual(set(full["set"]), {"a1", "b2"})
        self.assertEqual(full["set"]["a1"]["points"][0], {"x": 0, "y": 10, "pressure": 0.5})
        self.assertEqual((full["bg"], full["theme"], full["view"]["w"]), ("#FBFBF9", "light", 800.0))
        self.assertEqual(self.client.get(f"/api/live/{code}?since={v1}").status_code, 204, "nothing new: an empty answer")

        # A stroke in progress, then committed; one erased.
        self.client.post(f"/api/live/{code}", json={"live": stroke(90, 3)}, headers=key)
        mid = self.client.get(f"/api/live/{code}?since={v1}").get_json()
        self.assertEqual(mid["set"], {})
        self.assertEqual(len(mid["live"]["points"]), 3)
        self.assertNotIn("order", mid)
        v3 = self.client.post(f"/api/live/{code}", json={"set": {"c3": stroke(90)}, "order": ["b2", "c3"], "live": None}, headers=key).get_json()["v"]
        after = self.client.get(f"/api/live/{code}?since={mid['v']}").get_json()
        self.assertEqual(set(after["set"]), {"c3"}, "only the new stroke is sent again")
        self.assertEqual(after["order"], ["b2", "c3"])
        self.assertIsNone(after["live"])
        self.assertEqual(after["v"], v3)
        self.assertNotIn("a1", live_board._BOARDS[code]["paths"], "an erased stroke is dropped from memory")

    def test_ending_a_board_tells_the_class_and_forgets_the_page(self):
        code, key = self.start()
        self.client.post(f"/api/live/{code}", json={"set": {"a1": stroke(0)}, "order": ["a1"]}, headers=key)
        self.assertEqual(self.client.delete(f"/api/live/{code}").status_code, 403)
        self.assertEqual(self.client.delete(f"/api/live/{code}", headers=key).status_code, 200)
        seen = self.client.get(f"/api/live/{code}?since=0").get_json()
        self.assertTrue(seen["ended"])
        self.assertEqual((seen["set"], seen["order"]), ({}, []))
        self.assertEqual(self.client.post(f"/api/live/{code}", json={"order": []}, headers=key).status_code, 410)

    def test_a_board_is_deleted_when_it_ends_or_goes_quiet(self):
        quiet, _ = self.start()
        ended, key = self.start()
        self.client.delete(f"/api/live/{ended}", headers=key)
        with live_board._LOCK:
            live_board._BOARDS[quiet]["touched"] -= live_board.BOARD_IDLE_SECONDS + 1
            live_board._BOARDS[ended]["ended_at"] -= live_board.ENDED_GRACE_SECONDS + 1
            live_board._last_sweep[0] = 0
        self.assertEqual(self.client.get(f"/api/live/{quiet}").status_code, 404)
        self.assertEqual(self.client.get(f"/api/live/{ended}").status_code, 404)
        self.assertEqual(live_board._BOARDS, {})

    def test_bad_pushes_are_refused_and_limits_hold(self):
        code, key = self.start()
        for body in ({"set": {"bad id!": stroke(0)}}, {"set": {"a1": "not a stroke"}}, {"order": "a1"},
                     {"view": {"x": "left"}}, ["not", "an", "object"]):
            self.assertEqual(self.client.post(f"/api/live/{code}", json=body, headers=key).status_code, 400, body)
        huge = stroke(0)
        huge["src"] = "data:image/png;base64," + "A" * (live_board.MAX_PATH_BYTES + 10)
        self.client.post(f"/api/live/{code}", json={"set": {"big": huge}, "order": ["big"]}, headers=key)
        self.assertNotIn("big", live_board._BOARDS[code]["paths"], "too big to share: skipped, not stored")
        with live_board._LOCK:
            for i in range(live_board.MAX_BOARDS):
                live_board._BOARDS[f"X{i}"] = dict(live_board._BOARDS[code], ended_at=None, touched=time.monotonic())
        self.assertEqual(self.client.post("/api/live").status_code, 503)

    def test_the_viewer_and_join_pages(self):
        page = self.client.get("/live/ABCDEF")
        self.assertEqual(page.status_code, 200)
        html = page.get_data(as_text=True)
        self.assertIn('data-code="ABCDEF"', html)
        self.assertIn("noindex", html)
        join = self.client.get("/live").get_data(as_text=True)
        self.assertIn("Join a live board", join)
        bad = self.client.get("/live/oops!").get_data(as_text=True)
        self.assertIn("There is no live board with the code", bad)
        robots = self.client.get("/robots.txt").get_data(as_text=True).splitlines()
        self.assertIn("Disallow: /live", robots)

    @unittest.skipUnless(CV2_AVAILABLE, "OpenCV is not installed")
    def test_the_qr_code_reads_back_as_the_join_link(self):
        code, _ = self.start()
        svg = self.client.get(f"/api/live/{code}/qr.svg", base_url="https://maethist.example").get_data(as_text=True)
        self.assertIn("<svg", svg)
        detector = cv2.QRCodeDetector()
        for text in (f"https://maethist.example/live/{code}", "x" * 60, "y" * 150):
            m = np.array(qr_matrix(text), dtype=np.uint8)
            img = np.pad((1 - m) * 255, 4, constant_values=255).astype(np.uint8)
            img = cv2.resize(img, None, fx=8, fy=8, interpolation=cv2.INTER_NEAREST)
            self.assertEqual(detector.detectAndDecode(img)[0], text)


class LiveBoardIsDocumentedTests(unittest.TestCase):
    def test_the_policies_describe_it(self):
        privacy = (ROOT / "templates/legal/privacy.html").read_text(encoding="utf-8")
        self.assertIn("live_board.py", privacy)
        self.assertIn("A live board in the server's memory", privacy)
        cookies = (ROOT / "templates/legal/cookies.html").read_text(encoding="utf-8")
        self.assertIn("<code>inkyscib_live</code>", cookies)
        self.assertIn('SESSION_KEY = "inkyscib_live"', (ROOT / "static/js/live-board.js").read_text(encoding="utf-8"))


@unittest.skipUnless(PLAYWRIGHT_AVAILABLE, "Playwright is not installed")
class LiveBoardBrowserTests(unittest.TestCase):
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

    def teacher(self):
        context = self.browser.new_context(viewport={"width": 1280, "height": 800})
        self.addCleanup(context.close)
        context.add_init_script("localStorage.setItem('inkyscib-feature-tour-v1', 'seen')")
        page = context.new_page()
        self.errors = []
        page.on("pageerror", lambda error: self.errors.append(str(error)))
        page.goto(self.base_url + "/write", wait_until="domcontentloaded")
        page.wait_for_function("() => window.appState?.storageReady === true && !!window.Inkyscib?.LiveBoard")
        page.wait_for_timeout(300)
        page.evaluate("() => { window.setTool('pen'); window.Inkyscib.ToolDock?.setCollapsed?.(true); }")
        return page

    def student(self, code):
        context = self.browser.new_context(viewport={"width": 420, "height": 860})
        self.addCleanup(context.close)
        page = context.new_page()
        self.student_errors = []
        page.on("pageerror", lambda error: self.student_errors.append(str(error)))
        page.goto(self.base_url + "/live/" + code, wait_until="domcontentloaded")
        return page

    def scribble(self, page, x, y, steps=30):
        page.mouse.move(x, y)
        page.mouse.down()
        for i in range(steps):
            page.mouse.move(x + i * 3, y + (i % 10) * 6)
        page.mouse.up()

    def test_the_class_follows_the_page_as_it_is_written(self):
        t = self.teacher()
        t.evaluate("() => window.Inkyscib.LiveBoard.openSheet()")
        t.click(".live-start")
        t.wait_for_selector(".live-qr")
        code = t.evaluate("() => window.Inkyscib.LiveBoard.current().code")
        self.assertRegex(code, r"^[A-Z2-9]{6}$")
        self.assertEqual(t.evaluate("() => document.querySelector('.live-big-code').textContent"), code)
        self.assertTrue(t.evaluate("() => document.querySelector('.live-qr').naturalWidth > 0"), "the QR code loads")
        t.click(".live-done")
        for k in range(3):
            self.scribble(t, 300 + k * 120, 300)

        s = self.student(code)
        s.wait_for_function("() => window.Inkyscib?.LiveView?.board.order.length === 3", timeout=10000)
        self.assertEqual(s.evaluate("() => document.getElementById('liveStatus').dataset.state"), "live")

        # A stroke shows while it is still being written.
        t.mouse.move(700, 500)
        t.mouse.down()
        for i in range(25):
            t.mouse.move(700 + i * 4, 500 - i * 3)
        s.wait_for_function("() => (window.Inkyscib.LiveView.board.live?.points?.length || 0) > 3", timeout=5000)
        t.mouse.up()
        s.wait_for_function("() => window.Inkyscib.LiveView.board.order.length === 4 && !window.Inkyscib.LiveView.board.live", timeout=5000)

        # Undo reaches the class too.
        t.keyboard.press("Control+z")
        s.wait_for_function("() => window.Inkyscib.LiveView.board.order.length === 3", timeout=5000)

        # The ink is drawn: pixels under the strokes are not the background.
        inked = s.evaluate("""() => { const c = document.getElementById('liveCanvas');
          const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
          let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++; return n; }""")
        self.assertGreater(inked, 200)

        t.evaluate("() => window.Inkyscib.LiveBoard.stop()")
        s.wait_for_function("() => document.getElementById('liveStatus').dataset.state === 'ended'", timeout=5000)
        self.assertIsNone(t.evaluate("() => window.Inkyscib.LiveBoard.current()"))
        self.assertTrue(t.evaluate("() => document.getElementById('livePill').hidden"))
        self.assertEqual(self.errors, [])
        self.assertEqual(self.student_errors, [])

    def test_a_reload_carries_on_with_the_same_board(self):
        t = self.teacher()
        code = t.evaluate("async () => (await window.Inkyscib.LiveBoard.start()).code")
        t.reload(wait_until="domcontentloaded")
        t.wait_for_function("() => window.Inkyscib?.LiveBoard?.current()?.code", timeout=8000)
        self.assertEqual(t.evaluate("() => window.Inkyscib.LiveBoard.current().code"), code)
        self.assertFalse(t.evaluate("() => document.getElementById('livePill').hidden"))
        t.evaluate("() => window.Inkyscib.LiveBoard.stop()")

    def test_a_student_can_look_closer_and_follow_again(self):
        t = self.teacher()
        code = t.evaluate("async () => (await window.Inkyscib.LiveBoard.start()).code")
        self.scribble(t, 400, 300)
        s = self.student(code)
        s.wait_for_function("() => window.Inkyscib?.LiveView?.board.order.length === 1", timeout=10000)
        before = s.evaluate("() => window.Inkyscib.LiveView.camera().s")
        s.mouse.move(210, 450)
        s.mouse.wheel(0, -400)
        s.wait_for_timeout(100)
        self.assertGreater(s.evaluate("() => window.Inkyscib.LiveView.camera().s"), before * 1.3)
        self.assertFalse(s.evaluate("() => window.Inkyscib.LiveView.following()"))
        s.click("#liveFollow")
        self.assertTrue(s.evaluate("() => window.Inkyscib.LiveView.following()"))
        self.assertTrue(s.evaluate("() => document.getElementById('liveFollow').hidden"))
        t.evaluate("() => window.Inkyscib.LiveBoard.stop()")

    def test_the_join_page_takes_a_typed_code(self):
        context = self.browser.new_context(viewport={"width": 420, "height": 860})
        self.addCleanup(context.close)
        page = context.new_page()
        page.goto(self.base_url + "/live", wait_until="domcontentloaded")
        page.fill("#liveCodeInput", "k7pq2m")
        self.assertEqual(page.input_value("#liveCodeInput"), "K7PQ2M")
        page.click(".lv-join-form button")
        page.wait_for_url("**/live/K7PQ2M")
        page.wait_for_function("() => document.getElementById('liveStatus')?.dataset.state === 'gone'", timeout=8000)
        self.assertIn("No board has this code", page.text_content("#liveStatus"))


if __name__ == "__main__":
    unittest.main()
