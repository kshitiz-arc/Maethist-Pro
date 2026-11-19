"""Image to text (ocr_engine.py, /api/ocr, static/js/ocr.js).

Pinned every run, without loading a model: the image decoder's limits and
its handling of transparent and dark canvases, the line splitter, the LaTeX
clean-up, the API's refusals and its switch, the rate limit, the privacy
policy's description of where an image goes, and the editor's capture and
result sheet (with the server answer stubbed).

The models themselves are exercised only with OCR_MODEL_TESTS=1, because
loading them costs a minute and ~1.5 GB, and the suite has to stay quick.
"""

import base64
import io
import json
import os
import threading
import unittest
from unittest import mock

from PIL import Image, ImageDraw

import ocr_engine
from app import app, RATE_LIMITS
from browser_server import make_browser_server

try:
    from playwright.sync_api import sync_playwright

    PLAYWRIGHT_AVAILABLE = True
except ImportError:  # pragma: no cover - optional dependency
    PLAYWRIGHT_AVAILABLE = False


def data_url(image, fmt="PNG"):
    buffer = io.BytesIO()
    image.save(buffer, fmt)
    return f"data:image/{fmt.lower()};base64," + base64.b64encode(buffer.getvalue()).decode()


class EngineTests(unittest.TestCase):
    def test_decode_puts_transparent_ink_on_white(self):
        image = Image.new("RGBA", (40, 20), (0, 0, 0, 0))
        ImageDraw.Draw(image).line([(2, 10), (38, 10)], fill=(10, 10, 10, 255), width=3)
        decoded = ocr_engine.decode_image(data_url(image))
        self.assertEqual(decoded.mode, "RGB")
        self.assertEqual(decoded.getpixel((1, 1)), (255, 255, 255))
        self.assertLess(sum(decoded.getpixel((20, 10))), 100)

    def test_decode_refuses_rubbish_and_oversize(self):
        with self.assertRaises(ocr_engine.OcrInputError):
            ocr_engine.decode_image("")
        with self.assertRaises(ocr_engine.OcrInputError):
            ocr_engine.decode_image("data:image/png;base64,bm90IGFuIGltYWdl")
        huge = "data:image/png;base64," + "A" * (ocr_engine.MAX_IMAGE_BYTES * 2)
        with self.assertRaises(ocr_engine.OcrInputError):
            ocr_engine.decode_image(huge)

    def test_decode_bounds_the_size(self):
        decoded = ocr_engine.decode_image(data_url(Image.new("RGB", (4000, 1000), "white")))
        self.assertEqual(max(decoded.size), ocr_engine.MAX_SIDE)

    def test_a_dark_canvas_is_inverted_and_trimmed_to_the_ink(self):
        image = Image.new("RGB", (300, 120), (16, 19, 28))
        ImageDraw.Draw(image).line([(100, 60), (200, 60)], fill="white", width=6)
        out = ocr_engine.normalise(image)
        self.assertGreater(sum(out.getpixel((2, 2))), 600, "paper is white after inversion")
        self.assertLess(out.width, 160, "trimmed to the stroke plus a margin")

    def test_lines_are_split_by_their_ink(self):
        image = Image.new("RGB", (400, 260), "white")
        draw = ImageDraw.Draw(image)
        draw.text((10, 20), "first line of writing", fill="black")
        draw.rectangle([10, 30, 380, 60], fill="black")
        draw.rectangle([10, 170, 380, 200], fill="black")
        self.assertEqual(len(ocr_engine.split_lines(image)), 2)

    def test_latex_spacing_is_cleaned_without_merging_commands(self):
        self.assertEqual(ocr_engine.clean_latex("x ^ { 2 } + 3 y = 7"), "x^{2}+3y=7")
        self.assertEqual(ocr_engine.clean_latex(r"\alpha b + \frac { 1 } { 2 }"), r"\alpha b+\frac{1}{2}")
        self.assertEqual(ocr_engine.clean_latex(r"\textsc { X } ^ { 2 }"), "X^{2}")

    def test_the_readers_blank_page_nonsense_is_dropped(self):
        # What the equation reader wrote for an empty box, verbatim.
        nonsense = r"\newcommand { \R } { \mathbb R } \newcommand { \1 } { \mathrm { div } } \newcommand { \id } { \mathbb R }"
        self.assertEqual(ocr_engine.clean_latex(nonsense), "")
        self.assertEqual(ocr_engine.clean_latex(nonsense + " x ^ { 2 }"), "x^{2}")

    def test_a_box_with_no_writing_is_refused_before_any_model(self):
        for paper in ("white", (16, 19, 28)):
            blank = Image.new("RGB", (300, 120), paper)
            self.assertFalse(ocr_engine.has_ink(blank))
            with mock.patch("ocr_engine._load", side_effect=AssertionError("no model for a blank box")):
                with self.assertRaisesRegex(ocr_engine.OcrInputError, "no writing"):
                    ocr_engine.convert(data_url(blank), "math")
        written = Image.new("RGB", (300, 120), "white")
        ImageDraw.Draw(written).line([(40, 60), (200, 60)], fill="black", width=4)
        self.assertTrue(ocr_engine.has_ink(written))

    def test_the_switch_turns_it_off(self):
        with mock.patch.dict(os.environ, {"OCR": "off"}):
            self.assertFalse(ocr_engine.enabled())
            with self.assertRaises(ocr_engine.OcrUnavailable):
                ocr_engine._load("math")


class ApiTests(unittest.TestCase):
    def setUp(self):
        self.client = app.test_client()

    def test_status_reports_each_reader(self):
        body = self.client.get("/api/ocr/status").get_json()
        self.assertEqual(set(body), {"available", "math", "text"})

    def test_bad_input_is_a_400_with_a_reason(self):
        with mock.patch("app._ocr_available", return_value=True):
            response = self.client.post("/api/ocr", json={"image": "nope", "kind": "math"})
        self.assertEqual(response.status_code, 400)
        self.assertIn("error", response.get_json())

    def test_switched_off_is_a_503(self):
        with mock.patch.dict(os.environ, {"OCR": "off"}):
            response = self.client.post("/api/ocr", json={"image": "x", "kind": "math"})
        self.assertEqual(response.status_code, 503)

    def test_a_result_comes_back_as_json(self):
        with mock.patch("app._ocr_available", return_value=True), \
                mock.patch("ocr_engine.convert", return_value={"kind": "math", "latex": "x^{2}"}):
            response = self.client.post("/api/ocr", json={"image": "data:image/png;base64,AA", "kind": "math"})
        self.assertEqual(response.get_json(), {"kind": "math", "latex": "x^{2}"})

    def test_it_is_rate_limited(self):
        self.assertIn("ocr_convert", RATE_LIMITS)

    def test_the_privacy_policy_says_where_an_image_goes(self):
        html = self.client.get("/legal/privacy").get_data(as_text=True)
        self.assertIn("An image you convert to text", html)
        self.assertIn("never written to disk", html)
        self.assertIn("any other company", html)


@unittest.skipUnless(os.environ.get("OCR_MODEL_TESTS") == "1", "set OCR_MODEL_TESTS=1 to run the models")
class ModelTests(unittest.TestCase):
    def test_an_equation_reads_as_latex(self):
        from PIL import ImageFont

        image = Image.new("RGB", (560, 130), "white")
        try:
            font = ImageFont.truetype("C:/Windows/Fonts/segoepr.ttf", 54)
        except OSError:
            self.skipTest("no handwriting-style font on this machine")
        ImageDraw.Draw(image).text((20, 20), "x\u00b2 + 3y = 7", fill="black", font=font)
        self.assertEqual(ocr_engine.convert(data_url(image), "math")["latex"], "x^{2}+3y=7")


@unittest.skipUnless(PLAYWRIGHT_AVAILABLE, "Playwright is not installed")
class EditorTests(unittest.TestCase):
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

    def open_page(self, available=True):
        context = self.browser.new_context(viewport={"width": 1440, "height": 900})
        self.addCleanup(context.close)
        context.add_init_script("localStorage.setItem('inkyscib-feature-tour-v1', 'seen')")
        page = context.new_page()
        self.errors = []
        page.on("pageerror", lambda error: self.errors.append(str(error)))
        self.sent = []

        def answer(route):
            self.sent.append(json.loads(route.request.post_data or "{}"))
            route.fulfill(status=200, content_type="application/json",
                          body=json.dumps({"kind": "math", "latex": r"\frac{a+b}{2}=x^{2}"}))

        # Whether this machine has the models installed must not decide a test.
        page.route("**/api/ocr/status", lambda route: route.fulfill(
            status=200, content_type="application/json",
            body=json.dumps({"available": available, "math": available, "text": available})))
        page.route("**/api/ocr", answer)
        page.goto(self.base_url + "/write", wait_until="domcontentloaded")
        page.wait_for_function("() => window.appState?.storageReady === true && !!window.Inkyscib?.Ocr")
        return page

    def test_boxing_writing_sends_the_crop_and_places_the_result(self):
        page = self.open_page()
        page.evaluate("""() => {
          const s = window.appState; s.transform = {scale: 1, offsetX: 0, offsetY: 0}; s.paths = [];
          s.paths.push({tool: 'pen', points: [{x: 400, y: 300}, {x: 500, y: 360}], color: '#ffffff', size: 6});
          window.render(); window.Inkyscib.Ocr.start();
        }""")
        canvas = page.locator("#drawingCanvas").bounding_box()
        page.mouse.move(canvas["x"] + 380, canvas["y"] + 280)
        page.mouse.down()
        page.mouse.move(canvas["x"] + 520, canvas["y"] + 380, steps=5)
        page.mouse.up()
        page.wait_for_function("() => document.getElementById('ocrResult')?.value.length > 0")
        self.assertEqual(len(self.sent), 1)
        self.assertEqual(self.sent[0]["kind"], "math")
        self.assertTrue(self.sent[0]["image"].startswith("data:image/png;base64,"))
        preview = page.inner_text(".ocr-preview")
        self.assertIn("x\u00b2", preview)
        self.assertIn("(a+b)/2", preview)
        page.click('[data-ocr="place"]')
        placed = page.evaluate("() => window.appState.paths.filter((p) => p.tool === 'image' && p.ocrSource === 'math').length")
        self.assertEqual(placed, 1)
        self.assertEqual(self.errors, [])

    def test_an_empty_box_is_not_sent(self):
        page = self.open_page()
        page.evaluate("() => { window.appState.paths = []; window.render(); window.Inkyscib.Ocr.start(); }")
        canvas = page.locator("#drawingCanvas").bounding_box()
        page.mouse.move(canvas["x"] + 700, canvas["y"] + 300)
        page.mouse.down()
        page.mouse.move(canvas["x"] + 900, canvas["y"] + 420, steps=4)
        page.mouse.up()
        page.wait_for_timeout(150)
        self.assertEqual(self.sent, [])
        self.assertTrue(page.is_visible("#ocrOverlay"), "the capture stays open for another try")
        self.assertIn("Nothing is written", page.inner_text(".ocr-hint-text"))

    def test_a_server_without_the_readers_says_so_on_opening(self):
        page = self.open_page(available=False)
        page.evaluate("() => window.Inkyscib.Ocr.start()")
        page.wait_for_function("() => document.getElementById('ocrOverlay').classList.contains('is-unavailable')")
        self.assertIn("not set up on this server", page.inner_text(".ocr-hint-text"))
        self.assertFalse(page.is_visible(".ocr-upload"))
        canvas = page.locator("#drawingCanvas").bounding_box()
        page.mouse.move(canvas["x"] + 400, canvas["y"] + 300)
        page.mouse.down()
        page.mouse.move(canvas["x"] + 600, canvas["y"] + 400, steps=4)
        page.mouse.up()
        page.wait_for_timeout(150)
        self.assertEqual(self.sent, [])
        self.assertFalse(page.is_visible(".ocr-box"))

    def test_the_tools_pane_offers_it(self):
        page = self.open_page()
        page.click('.file-ribbon-tab[data-ribbon-tab="tools"]')
        page.wait_for_selector(".file-backstage.is-open")
        self.assertIn("Image to text", page.inner_text(".file-backstage"))

    def test_latex_is_made_readable_for_the_page(self):
        page = self.open_page()
        cases = {
            r"x^{2}+y_{1}=\sqrt{3}": "x\u00b2+y\u2081=\u221a3",
            r"\alpha\times\beta\leq\pi": "\u03b1\u00d7\u03b2\u2264\u03c0",
            r"\frac{1}{2}": "1/2",
            # A power inside a fraction is read before the fraction is.
            r"\frac{x^{2}}{4}+\frac{y^{2}}{9}=1": "x\u00b2/4+y\u00b2/9=1",
            r"x=\frac{-b\pm\sqrt{b^{2}-4ac}}{2a}": "x=(-b\u00b1\u221a(b\u00b2-4ac))/2a",
            r"\sqrt{\frac{1}{2}}": "\u221a(1/2)",
            r"\angle ABC=60^{\circ}": "\u2220 ABC=60\u00b0",
            r"\sqrt[3]{8}=2": "\u221b8=2",
            # No raised q exists, so the power is written out.
            r"x^{q+1}": "x^(q+1)",
            r"\left(\frac{a}{b}\right)^{2}": "(a/b)\u00b2",
            r"\begin{array}{l}x=1\\y=2\end{array}": "x=1\ny=2",
            r"\{1,2,3\}": "{1,2,3}",
        }
        out = page.evaluate("(inputs) => inputs.map((s) => window.Inkyscib.Ocr.latexToReadable(s))", list(cases))
        self.assertEqual(dict(zip(cases, out)), cases)


if __name__ == "__main__":
    unittest.main()
