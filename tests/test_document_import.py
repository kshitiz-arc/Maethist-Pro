"""Import fidelity for PDF and PPTX decks.

These cover the things that were silently broken: pages rendering at half the
device resolution, decks rasterised at 1:1 so they only read when zoomed, and a
positioned table painting over the rest of its slide.
"""

import sys
import tempfile
import threading
import unittest
from pathlib import Path

from app import app
from browser_server import make_browser_server

sys.path.insert(0, str(Path(__file__).parent))

try:
    from playwright.sync_api import sync_playwright

    PLAYWRIGHT_AVAILABLE = True
except ImportError:
    PLAYWRIGHT_AVAILABLE = False

try:
    import fitz

    PYMUPDF_AVAILABLE = True
except ImportError:
    PYMUPDF_AVAILABLE = False

try:
    from pptx_fixture import build_sample_pptx

    PPTX_FIXTURE_AVAILABLE = True
except Exception:  # pragma: no cover - Pillow missing
    PPTX_FIXTURE_AVAILABLE = False


def build_mixed_pdf(directory):
    """A4 portrait page followed by an A4 landscape page, with small body text."""
    document = fitz.open()
    portrait = document.new_page(width=595, height=842)
    portrait.insert_text((56, 90), "Chapter 7", fontsize=20, fontname="hebo")
    for index in range(12):
        portrait.insert_text(
            (56, 130 + index * 17),
            "The quick brown fox jumps over the lazy dog (line %d)" % (index + 1),
            fontsize=9.5,
        )
    landscape = document.new_page(width=842, height=595)
    landscape.insert_text((56, 90), "Landscape page", fontsize=22, fontname="hebo")
    path = Path(directory) / "mixed.pdf"
    document.save(path)
    document.close()
    return path


# Samples a pixel out of a slide's rendered bitmap, in the slide's own
# coordinate space, so assertions read like positions on the page.
SAMPLE_PIXEL = """
async ([index, xFraction, yFraction]) => {
  const slide = window.appState.ppt.slides[index];
  const image = new Image();
  await new Promise((resolve, reject) => {
    image.onload = resolve;
    image.onerror = reject;
    image.src = slide.image;
  });
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0);
  const x = Math.round(image.naturalWidth * xFraction);
  const y = Math.round(image.naturalHeight * yFraction);
  const data = ctx.getImageData(x, y, 1, 1).data;
  return {
    rgb: [data[0], data[1], data[2]],
    rasterWidth: image.naturalWidth,
    rasterHeight: image.naturalHeight
  };
}
"""


# Scans a horizontal band of a slide for any pixel close to a colour. Thin
# strokes fall between single-pixel samples, so a band scan is the honest test.
SCAN_FOR_COLOR = """
async ([index, yStart, yEnd, target, tolerance]) => {
  const slide = window.appState.ppt.slides[index];
  const image = new Image();
  await new Promise((resolve, reject) => {
    image.onload = resolve;
    image.onerror = reject;
    image.src = slide.image;
  });
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0);
  const top = Math.floor(image.naturalHeight * yStart);
  const bottom = Math.ceil(image.naturalHeight * yEnd);
  const band = ctx.getImageData(0, top, image.naturalWidth, Math.max(1, bottom - top)).data;
  for (let i = 0; i < band.length; i += 4) {
    if (Math.abs(band[i] - target[0]) <= tolerance &&
        Math.abs(band[i + 1] - target[1]) <= tolerance &&
        Math.abs(band[i + 2] - target[2]) <= tolerance) {
      return true;
    }
  }
  return false;
}
"""


@unittest.skipUnless(PLAYWRIGHT_AVAILABLE, "Playwright is not installed")
class DocumentImportTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = make_browser_server(app)
        cls.server_thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.server_thread.start()
        cls.base_url = f"http://127.0.0.1:{cls.server.server_port}"
        cls.playwright = sync_playwright().start()
        cls.browser = cls.playwright.chromium.launch(headless=True)
        cls.tmp = tempfile.mkdtemp()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()
        cls.server.shutdown()
        cls.server_thread.join(timeout=3)

    def open_page(self, device_scale_factor=1):
        context = self.browser.new_context(
            viewport={"width": 1280, "height": 820},
            device_scale_factor=device_scale_factor,
        )
        self.addCleanup(context.close)
        # The first-run tour opens over the canvas a moment after boot and
        # takes the pointer with it, so a mouse move lands on the overlay and
        # the canvas never sees `mouseenter`. Whether it wins that race is
        # timing, which made test_size_preview_ring_tracks_the_pointer_at_high_dpr
        # fail about two runs in three - measured, not guessed. Every other
        # browser test file in this suite already dismisses it this way.
        context.add_init_script(
            "localStorage.setItem('inkyscib-consent-v1', JSON.stringify({version: 1, analytics: false})); localStorage.setItem('inkyscib-feature-tour-v1', JSON.stringify({seen: true}))"
        )
        page = context.new_page()
        self.errors = []
        page.on("pageerror", lambda error: self.errors.append(str(error)))
        page.goto(self.base_url + "/write", wait_until="domcontentloaded")
        page.wait_for_function("() => window.appState?.storageReady === true")
        # init() sets app-ready once the editor is genuinely usable. This
        # replaced a wait on the boot overlay leaving, which was a timer and
        # would have passed instantly once the overlay was deleted.
        page.wait_for_function(
            "() => document.body.classList.contains('app-ready')", timeout=15000
        )
        # The canvas is sized from its container on the first render frame,
        # so wait for one to land before measuring anything about it.
        page.evaluate(
            "() => new Promise((resolve) => {"
            "  if (typeof window.render === 'function') window.render();"
            "  requestAnimationFrame(() => requestAnimationFrame(resolve));"
            "})"
        )
        return page

    def import_deck(self, page, selector, path):
        """Imports a deck and waits until every page has really been rendered.

        Both importers show a PNG "Rendering page N..." placeholder first and
        overwrite it with a JPEG once the page is drawn, so the encoding is the
        reliable done-signal. Reading the deck too early gives placeholder
        geometry (every page inherits page 1's size).
        """
        page.set_input_files(selector, str(path))
        page.wait_for_function("() => window.appState?.ppt?.active === true", timeout=60000)
        page.wait_for_function(
            "() => window.appState.ppt.slides.length > 0 && window.appState.ppt.slides.every("
            "(s) => (s.image || '').startsWith('data:image/jpeg'))",
            timeout=60000,
        )

    # ------------------------------------------------------------------ canvas

    def test_canvas_backing_store_follows_the_device_pixel_ratio(self):
        page = self.open_page(device_scale_factor=2)
        result = page.evaluate(
            """
            () => {
              const canvas = document.getElementById('drawingCanvas');
              const pattern = document.getElementById('patternCanvas');
              const container = document.getElementById('canvas-container');
              return {
                dpr: window.devicePixelRatio,
                ratio: window.getCanvasPixelRatio(),
                backingWidth: canvas.width,
                patternBackingWidth: pattern.width,
                // Layout width, not the visual rect: the reveal animation
                // briefly scales the workspace and would skew a rect reading.
                cssWidth: Math.round(container.clientWidth)
              };
            }
            """
        )
        self.assertEqual(result["dpr"], 2)
        self.assertEqual(result["ratio"], 2)
        # The backing store is twice the CSS size, which is what stops the whole
        # workspace reading soft on a retina display.
        self.assertAlmostEqual(result["backingWidth"], result["cssWidth"] * 2, delta=2)
        self.assertAlmostEqual(result["patternBackingWidth"], result["cssWidth"] * 2, delta=2)
        self.assertEqual(self.errors, [])

    def test_pointer_coordinates_stay_in_css_pixels_at_high_dpr(self):
        page = self.open_page(device_scale_factor=2)
        result = page.evaluate(
            """
            () => {
              const canvas = document.getElementById('drawingCanvas');
              const rect = canvas.getBoundingClientRect();
              const point = window.clientPointToCanvas(rect.left + 100, rect.top + 60);
              return { x: point.x, y: point.y };
            }
            """
        )
        # A click 100 CSS px into the canvas must still be 100 in app space,
        # otherwise every stroke lands at twice the offset.
        self.assertAlmostEqual(result["x"], 100, delta=1.5)
        self.assertAlmostEqual(result["y"], 60, delta=1.5)
        self.assertEqual(self.errors, [])

    def test_size_preview_ring_tracks_the_pointer_at_high_dpr(self):
        page = self.open_page(device_scale_factor=2)
        page.evaluate("() => window.setTool('pen')")
        canvas = page.locator("#drawingCanvas")
        box = canvas.bounding_box()
        target_x = box["x"] + box["width"] * 0.6
        target_y = box["y"] + box["height"] * 0.45

        # Enter the canvas, then settle on the target so mouseenter/mousemove
        # both fire the way a real pointer would.
        page.mouse.move(box["x"] + 40, box["y"] + 40)
        page.mouse.move(target_x, target_y)
        page.wait_for_timeout(120)

        placement = page.evaluate(
            """
            () => {
              const preview = document.getElementById('sizePreview');
              return {
                left: parseFloat(preview.style.left),
                top: parseFloat(preview.style.top),
                visible: window.sizePreview.isVisible
              };
            }
            """
        )
        self.assertTrue(placement["visible"])
        # The ring is centred on the pointer, so its origin is the pointer.
        self.assertAlmostEqual(placement["left"], target_x, delta=1.5)
        self.assertAlmostEqual(placement["top"], target_y, delta=1.5)
        self.assertEqual(self.errors, [])

    # --------------------------------------------------------------------- pdf

    @unittest.skipUnless(PYMUPDF_AVAILABLE, "PyMuPDF is required")
    def test_pdf_keeps_each_page_size_and_orientation(self):
        page = self.open_page()
        pdf = build_mixed_pdf(self.tmp)
        self.import_deck(page, "#pdfImportInput", pdf)
        result = page.evaluate(
            """
            () => ({
              mode: window.appState.ppt.renderMode,
              sizes: window.appState.ppt.slides.map((s) => [s.width, s.height])
            })
            """
        )
        self.assertEqual(result["mode"], "pdf")
        # Portrait stays portrait, landscape stays landscape, at native points.
        self.assertEqual(result["sizes"], [[595, 842], [842, 595]])
        self.assertEqual(self.errors, [])

    @unittest.skipUnless(PYMUPDF_AVAILABLE, "PyMuPDF is required")
    def test_pdf_pages_are_rasterised_well_above_their_point_size(self):
        page = self.open_page()
        pdf = build_mixed_pdf(self.tmp)
        self.import_deck(page, "#pdfImportInput", pdf)
        sample = page.evaluate(SAMPLE_PIXEL, [0, 0.5, 0.9])
        # 595pt wide page: anything near 1:1 would be unreadable without zooming.
        self.assertGreaterEqual(sample["rasterWidth"], 595 * 2)
        self.assertEqual(self.errors, [])

    # -------------------------------------------------------------------- pptx

    @unittest.skipUnless(PPTX_FIXTURE_AVAILABLE, "Pillow is required")
    def test_pptx_keeps_its_native_four_by_three_size(self):
        page = self.open_page()
        deck = build_sample_pptx(self.tmp)
        self.import_deck(page, "#pptImportInput", deck)
        result = page.evaluate(
            """
            () => ({
              mode: window.appState.ppt.renderMode,
              sizes: window.appState.ppt.slides.map((s) => [s.width, s.height])
            })
            """
        )
        self.assertEqual(result["mode"], "local")
        self.assertEqual(result["sizes"], [[960, 720], [960, 720]])
        self.assertEqual(self.errors, [])

    @unittest.skipUnless(PPTX_FIXTURE_AVAILABLE, "Pillow is required")
    def test_pptx_slide_is_supersampled(self):
        page = self.open_page()
        deck = build_sample_pptx(self.tmp)
        self.import_deck(page, "#pptImportInput", deck)
        sample = page.evaluate(SAMPLE_PIXEL, [0, 0.5, 0.5])
        self.assertGreaterEqual(sample["rasterWidth"], 960 * 2)
        self.assertGreaterEqual(sample["rasterHeight"], 720 * 2)
        self.assertEqual(self.errors, [])

    @unittest.skipUnless(PPTX_FIXTURE_AVAILABLE, "Pillow is required")
    def test_pptx_renders_shapes_text_and_picture_without_the_table_covering_them(self):
        page = self.open_page()
        deck = build_sample_pptx(self.tmp)
        self.import_deck(page, "#pptImportInput", deck)

        def rgb(x, y, index=0):
            return page.evaluate(SAMPLE_PIXEL, [index, x, y])["rgb"]

        def is_close(actual, expected, tolerance=42):
            return all(abs(a - e) <= tolerance for a, e in zip(actual, expected))

        # The blue autoshape (2563EB) and the pink ellipse (DB2777), sampled off
        # their centres so the white label text is not what gets measured.
        self.assertTrue(is_close(rgb(0.62, 0.20), [37, 99, 235]), rgb(0.62, 0.20))
        self.assertTrue(is_close(rgb(0.80, 0.21), [219, 39, 119]), rgb(0.80, 0.21))
        # The embedded picture paints its orange disc.
        self.assertTrue(is_close(rgb(0.6875, 0.45), [245, 158, 11]), rgb(0.6875, 0.45))
        # Group children still render.
        self.assertTrue(is_close(rgb(0.673, 0.672), [16, 185, 129]), rgb(0.673, 0.672))
        self.assertTrue(is_close(rgb(0.848, 0.675), [139, 92, 246]), rgb(0.848, 0.675))

        # The connector is a thin line, so scan its band rather than one pixel.
        self.assertTrue(
            page.evaluate(SCAN_FOR_COLOR, [0, 0.55, 0.62, [220, 38, 38], 60]),
            "expected the red connector to be drawn",
        )

        # The table used to be given a full-slide box and its opaque cells wiped
        # the slide. The title band must stay untouched white with dark glyphs.
        title_band = [rgb(x / 40, 0.09) for x in range(6, 34)]
        self.assertTrue(
            any(sum(pixel) < 400 for pixel in title_band),
            "expected dark title text across the top of the slide",
        )
        # And the table itself sits in its own frame near the bottom left.
        self.assertTrue(is_close(rgb(0.30, 0.985), [255, 255, 255]), rgb(0.30, 0.985))
        self.assertEqual(self.errors, [])

    @unittest.skipUnless(PPTX_FIXTURE_AVAILABLE, "Pillow is required")
    def test_pptx_star_preset_is_not_flattened_to_a_rectangle(self):
        page = self.open_page()
        deck = build_sample_pptx(self.tmp)
        self.import_deck(page, "#pptImportInput", deck)

        def rgb(x, y):
            return page.evaluate(SAMPLE_PIXEL, [1, x, y])["rgb"]

        centre = rgb(0.49, 0.14)
        corner = rgb(0.41, 0.06)
        # Filled at the star's middle, empty at the corner of its bounding box.
        self.assertTrue(all(abs(a - e) <= 45 for a, e in zip(centre, [245, 158, 11])), centre)
        self.assertTrue(all(value > 230 for value in corner), corner)
        self.assertEqual(self.errors, [])


if __name__ == "__main__":
    unittest.main()
