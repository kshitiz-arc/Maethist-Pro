"""The regression that guards the PDF quality contract.

Inkyscib's contract for an imported document is four invariants:

  1. The uploaded file is the source of truth and is never modified.
  2. Anything on screen is a disposable cache and never feeds an export.
  3. Ink and typed text stay vector end to end.
  4. Nothing is re-encoded silently.

These were written as strict xfails against the old pipeline, which broke all
four: a page was rasterised on import and the export was a photograph of that
raster. The lossless pipeline has since landed and they now pass, so the
markers are gone and these are ordinary regression tests — which is what they
were always for.

Both writers are covered, because they have to keep the same promise: the
browser's own pdf-lib path, which is what normal use hits, and the server
endpoint it falls back to.
"""

import json
import math
import sys
import threading
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from app import app
from pdf_quality import (
    COMPARE_DPI,
    FIXTURE_BUILDERS,
    build_form_pdf,
    build_heavy_pdf,
    build_scanned_pdf,
    build_vector_pdf,
    compare_renders,
    content_stream_digests,
    form_field_names,
    image_filters,
    measure,
    page_sizes,
    page_texts,
    render_page,
)

try:
    from playwright.sync_api import sync_playwright
    from werkzeug.serving import make_server

    BROWSER_AVAILABLE = True
except ImportError:  # pragma: no cover - optional dependency
    BROWSER_AVAILABLE = False

# The plan calls for five generations. Anything that degrades per round trip is
# already obvious by three, but five is what catches a slow leak.
GENERATIONS = 5


# --------------------------------------------------------------------------
# driving the current pipeline
# --------------------------------------------------------------------------


def server_round_trip(pdf_bytes, filename="fixture.pdf", annotations=None):
    """One import/export cycle through the server's lossless export.

    The browser writes its own PDFs with pdf-lib; this endpoint is the fallback
    for when it cannot. Both keep the same promise, so the invariants below
    apply to it unchanged: hand it the original plus the annotations that
    belong on each page, and everything it was not asked to draw on must come
    back exactly as it went in.
    """
    client = app.test_client()

    exported = client.post(
        "/api/pdf/export",
        data={
            "pdf": (io_bytes(pdf_bytes), filename),
            "annotations": json.dumps(annotations or []),
            "filename": filename,
        },
        content_type="multipart/form-data",
    )
    if exported.status_code != 200:
        raise AssertionError("export failed: %s" % exported.get_data(as_text=True)[:200])

    return exported.data


def io_bytes(data):
    import io

    return io.BytesIO(data)


# --------------------------------------------------------------------------
# the harness itself
# --------------------------------------------------------------------------


class HarnessTest(unittest.TestCase):
    """Guards the fixtures, so a failure below is never the harness lying."""

    def setUp(self):
        import tempfile

        self._temp = tempfile.TemporaryDirectory(prefix="inkyscib_quality_")
        self.addCleanup(self._temp.cleanup)
        self.directory = self._temp.name

    def test_every_fixture_builds_and_is_measurable(self):
        for name, build in FIXTURE_BUILDERS.items():
            with self.subTest(fixture=name):
                data = build(self.directory).read_bytes()
                stats = measure(data)
                self.assertGreater(len(stats["page_sizes"]), 0)
                self.assertEqual(len(stats["content_digests"]), len(stats["page_sizes"]))

    def test_fixtures_carry_the_properties_the_invariants_rely_on(self):
        vector = build_vector_pdf(self.directory).read_bytes()
        self.assertGreater(len(page_texts(vector)[0]), 500, "vector fixture needs a real text layer")
        self.assertEqual(image_filters(vector), set(), "vector fixture must contain no images")

        scan = build_scanned_pdf(self.directory).read_bytes()
        self.assertEqual(image_filters(scan), {"FlateDecode"}, "scan must start lossless")

        form = build_form_pdf(self.directory).read_bytes()
        self.assertEqual(form_field_names(form), {"name", "class", "roll_number"})

    def test_comparison_detects_a_resample(self):
        """A diff that cannot tell a resample from a match proves nothing."""
        original = build_vector_pdf(self.directory).read_bytes()
        page = render_page(original, 0, dpi=COMPARE_DPI)

        self.assertTrue(compare_renders(page, page)["identical"])

        softened = page.resize((page.width // 3, page.height // 3)).resize(page.size)
        degraded = compare_renders(page, softened)
        self.assertFalse(degraded["identical"])
        self.assertGreater(degraded["changed_fraction"], 0.01)

    def test_round_trip_driver_returns_a_readable_pdf(self):
        original = build_vector_pdf(self.directory).read_bytes()
        result = server_round_trip(original)
        self.assertTrue(result.startswith(b"%PDF"))
        self.assertEqual(len(page_sizes(result)), len(page_sizes(original)))


# --------------------------------------------------------------------------
# the invariants
# --------------------------------------------------------------------------


class ServerRoundTripInvariantTest(unittest.TestCase):
    """Invariants 1, 3 and 4 across the server import/export path."""

    def setUp(self):
        import tempfile

        self._temp = tempfile.TemporaryDirectory(prefix="inkyscib_quality_")
        self.addCleanup(self._temp.cleanup)
        self.directory = self._temp.name

    def test_text_layer_survives_a_round_trip(self):
        original = build_vector_pdf(self.directory).read_bytes()
        result = server_round_trip(original)
        self.assertEqual(page_texts(result), page_texts(original))

    def test_original_page_objects_are_preserved(self):
        original = build_vector_pdf(self.directory).read_bytes()
        result = server_round_trip(original)
        self.assertEqual(content_stream_digests(result), content_stream_digests(original))

    def test_form_fields_survive_a_round_trip(self):
        original = build_form_pdf(self.directory).read_bytes()
        result = server_round_trip(original)
        self.assertEqual(form_field_names(result), form_field_names(original))

    def test_rendered_pages_are_unchanged(self):
        original = build_vector_pdf(self.directory).read_bytes()
        result = server_round_trip(original)
        comparison = compare_renders(
            render_page(original, 0, dpi=COMPARE_DPI),
            render_page(result, 0, dpi=COMPARE_DPI),
        )
        self.assertTrue(comparison["identical"], comparison)

    def test_a_vector_page_does_not_acquire_an_image(self):
        original = build_vector_pdf(self.directory).read_bytes()
        result = server_round_trip(original)
        self.assertEqual(image_filters(result), image_filters(original))

    def test_a_round_trip_does_not_inflate_the_file(self):
        original = build_vector_pdf(self.directory).read_bytes()
        result = server_round_trip(original)
        self.assertLessEqual(len(result), len(original) * 2)

    def test_page_geometry_survives_mixed_orientations(self):
        """Page size is the one thing the current pipeline already gets right.

        Unmarked deliberately: it passes today and must keep passing through
        the rewrite, so it is a genuine regression guard rather than a target.
        """
        original = FIXTURE_BUILDERS["mixed"](self.directory).read_bytes()
        result = server_round_trip(original)
        self.assertEqual(page_sizes(result), page_sizes(original))

    def test_quality_does_not_decay_across_generations(self):
        original = build_vector_pdf(self.directory).read_bytes()
        reference = render_page(original, 0, dpi=COMPARE_DPI)

        current = original
        for generation in range(GENERATIONS):
            current = server_round_trip(current, "generation-%d.pdf" % generation)

        comparison = compare_renders(reference, render_page(current, 0, dpi=COMPARE_DPI))
        self.assertTrue(
            comparison["identical"],
            "generation %d drifted from the original: %s" % (GENERATIONS, comparison),
        )



# --------------------------------------------------------------------------
# the browser path
# --------------------------------------------------------------------------


@unittest.skipUnless(BROWSER_AVAILABLE, "playwright is not installed")
class BrowserTestBase(unittest.TestCase):
    """Serves the real app and drives the real editor.

    Normal use never touches the Flask importer — the browser does all of it —
    so anything asserted about what a user actually gets has to run here.
    """

    @classmethod
    def setUpClass(cls):
        app.config["TESTING"] = True
        cls.server = make_server("127.0.0.1", 0, app, threaded=True)
        cls.port = cls.server.server_port
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.thread.join(timeout=5)

    def setUp(self):
        import tempfile

        self._temp = tempfile.TemporaryDirectory(prefix="inkyscib_browser_")
        self.addCleanup(self._temp.cleanup)
        self.directory = Path(self._temp.name)
        self.page_errors = []

    def new_page(self, context):
        page = context.new_page()
        page.on("pageerror", lambda error: self.page_errors.append(str(error)))
        return page

    def new_context(self, browser, **kwargs):
        # The editor's CSP forbids 'unsafe-eval', which is also what
        # Playwright's wait_for_function polling needs. Without this the waits
        # below fail on CSP rather than on the thing under test — and an xfail
        # that passes for the wrong reason guards nothing. CSP itself is
        # covered by test_analytics_csp.py.
        return browser.new_context(bypass_csp=True, **kwargs)

    def open_editor(self, page):
        page.goto("http://127.0.0.1:%d/write" % self.port)
        page.wait_for_function("window.importPdfLocally !== undefined", timeout=30000)

    def import_pdf(self, page, path):
        page.set_input_files("#pdfImportInput", str(path))
        page.wait_for_function("window.appState?.ppt?.active === true", timeout=90000)
        # Pages are swapped in one at a time over placeholders; wait for the last.
        page.wait_for_function(
            "!window.appState.ppt.slides.some(s => /Rendering page/.test(s.image || ''))",
            timeout=90000,
        )

    def raise_for_page_errors(self):
        """Surface JS exceptions.

        A page error makes every wait time out for a reason that has nothing to
        do with quality, and an xfail would happily absorb it.
        """
        if self.page_errors:
            raise AssertionError("page errors: %s" % self.page_errors[:3])


class DocumentStoreTest(BrowserTestBase):
    """Phase 1: the uploaded file is kept, and kept intact.

    Not xfails. The document store is expected to work now, and this is the
    guard that it keeps working as the rest of the pipeline is rebuilt on it.
    """

    READ_BACK = """
    async (id) => {
      const store = window.Inkyscib?.DocStore;
      if (!store) return { error: 'no-doc-store' };
      const verified = await store.verifyDocument(id);
      const bytes = await store.getDocumentBytes(id);
      if (!bytes) return { error: 'no-bytes', verified };
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      const hex = Array.from(new Uint8Array(digest))
        .map(b => b.toString(16).padStart(2, '0')).join('');
      return { verified, hex, byteLength: bytes.byteLength };
    }
    """

    def import_and_read_back(self, source, reload_between=True):
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch()
            context = self.new_context(browser)
            page = self.new_page(context)
            try:
                self.open_editor(page)
                self.import_pdf(page, source)

                doc_id = page.evaluate("window.appState?.ppt?.docId || null")
                if reload_between:
                    # Prove it survives the save/load cycle, not just the tab.
                    page.evaluate("window.flushDrawingSave({ force: true })")
                    page.wait_for_timeout(500)
                    self.open_editor(page)
                    page.wait_for_function(
                        "window.appState?.ppt?.active === true", timeout=30000
                    )
                    doc_id = page.evaluate("window.appState?.ppt?.docId || null")

                result = page.evaluate(self.READ_BACK, doc_id) if doc_id else {}
                result["docId"] = doc_id
                return result
            finally:
                context.close()
                browser.close()

    def test_a_large_original_survives_import_and_reload_byte_identical(self):
        import hashlib

        source = build_heavy_pdf(self.directory)
        expected = hashlib.sha256(source.read_bytes()).hexdigest()
        self.assertGreater(
            source.stat().st_size,
            2 * 1024 * 1024,
            "the fixture must exceed the old 2 MB media ceiling for this to mean anything",
        )

        result = self.import_and_read_back(source)
        self.raise_for_page_errors()

        self.assertIsNotNone(result.get("docId"), "import did not keep the original")
        self.assertIsNone(result.get("error"), result)
        self.assertTrue(result["verified"]["ok"], result["verified"])
        self.assertEqual(result["byteLength"], source.stat().st_size)
        self.assertEqual(
            result["hex"], expected, "the stored original is not the file that was uploaded"
        )

    def test_the_document_id_is_the_content_hash(self):
        """Deduplication and verification both rest on this."""
        import hashlib

        source = build_vector_pdf(self.directory)
        expected = hashlib.sha256(source.read_bytes()).hexdigest()

        result = self.import_and_read_back(source, reload_between=False)
        self.raise_for_page_errors()
        self.assertEqual(result.get("docId"), expected)

    def test_slides_record_which_page_they_came_from(self):
        source = FIXTURE_BUILDERS["mixed"](self.directory)
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch()
            context = self.new_context(browser)
            page = self.new_page(context)
            try:
                self.open_editor(page)
                self.import_pdf(page, source)
                indices = page.evaluate("window.appState.ppt.slides.map(s => s.pageIndex)")
            finally:
                context.close()
                browser.close()

        self.raise_for_page_errors()
        self.assertEqual(indices, [0, 1, 2])


class BrowserRoundTripInvariantTest(BrowserTestBase):
    """The path a real user takes: the in-browser importer and PDF writer.

    This is where the JPEG generations come from.
    """

    def browser_round_trip(self, source_path, generations=1):
        """Import through the real file input, export through the real button."""
        results = []
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch()
            context = self.new_context(browser, accept_downloads=True)
            page = self.new_page(context)
            try:
                current = source_path
                for generation in range(generations):
                    self.open_editor(page)
                    self.import_pdf(page, current)

                    with page.expect_download(timeout=90000) as download_info:
                        page.evaluate("window.exportPptDeck('pdf')")
                    download = download_info.value

                    target = self.directory / ("generation-%d.pdf" % (generation + 1))
                    download.save_as(str(target))
                    results.append(target.read_bytes())
                    current = target
            finally:
                context.close()
                browser.close()

        self.raise_for_page_errors()
        return results

    def test_export_adds_no_lossy_codec(self):
        source = build_vector_pdf(self.directory)
        result = self.browser_round_trip(source)[0]
        self.assertNotIn(
            "DCTDecode",
            image_filters(result),
            "a JPEG generation was added to a document that had no images",
        )

    def test_browser_export_keeps_the_text_layer(self):
        source = build_vector_pdf(self.directory)
        result = self.browser_round_trip(source)[0]
        self.assertEqual(page_texts(result), page_texts(source.read_bytes()))

    def test_browser_quality_holds_across_generations(self):
        source = build_vector_pdf(self.directory)
        reference = render_page(source.read_bytes(), 0, dpi=COMPARE_DPI)
        generations = self.browser_round_trip(source, generations=3)

        comparison = compare_renders(reference, render_page(generations[-1], 0, dpi=COMPARE_DPI))
        self.assertTrue(comparison["identical"], comparison)

    def test_a_scan_keeps_its_resolution(self):
        source = build_scanned_pdf(self.directory)
        result = self.browser_round_trip(source)[0]
        self.assertNotIn("DCTDecode", image_filters(result))



# --------------------------------------------------------------------------
# exporting with ink on the page
# --------------------------------------------------------------------------


def pen_stroke(x=120, y=200, points=24, style="default", color="#e0407a"):
    """A pen path shaped like the ones the drawing tools produce."""
    return {
        "tool": "pen",
        "penStyle": style,
        "color": color,
        "size": 4,
        "points": [
            {"x": x + step * 11, "y": y + math.sin(step / 3) * 24, "pressure": 0.55}
            for step in range(points)
        ],
    }


class AnnotatedExportTest(unittest.TestCase):
    """The invariants above mostly cover a document with nothing drawn on it.

    These cover the case the app actually exists for: ink on the page. The
    document underneath must survive it, and the ink must arrive as geometry
    rather than as a picture.
    """

    def setUp(self):
        import tempfile

        self._temp = tempfile.TemporaryDirectory(prefix="inkyscib_annotated_")
        self.addCleanup(self._temp.cleanup)
        self.directory = self._temp.name

    def test_ink_lands_on_the_page_it_belongs_to(self):
        original = build_vector_pdf(self.directory).read_bytes()
        result = server_round_trip(original, annotations=[{"pageIndex": 0, "paths": [pen_stroke()]}])

        first = compare_renders(render_page(original, 0), render_page(result, 0))
        second = compare_renders(render_page(original, 1), render_page(result, 1))

        self.assertFalse(first["identical"], "the stroke should be visible on page 1")
        self.assertGreater(first["changed_fraction"], 0.0005)
        self.assertTrue(second["identical"], "page 2 had no ink and must be untouched")

    def test_the_document_survives_being_drawn_on(self):
        original = build_vector_pdf(self.directory).read_bytes()
        result = server_round_trip(original, annotations=[{"pageIndex": 0, "paths": [pen_stroke()]}])

        self.assertEqual(page_texts(result), page_texts(original), "text must survive the ink")
        self.assertEqual(image_filters(result), image_filters(original), "no bitmap should appear")
        self.assertEqual(page_sizes(result), page_sizes(original))

    def test_a_form_still_works_after_being_annotated(self):
        original = build_form_pdf(self.directory).read_bytes()
        result = server_round_trip(original, annotations=[{"pageIndex": 0, "paths": [pen_stroke(y=400)]}])
        self.assertEqual(form_field_names(result), form_field_names(original))

    def test_a_scan_keeps_its_own_encoding_under_ink(self):
        """Drawing on a scan must not re-encode the scan."""
        original = build_scanned_pdf(self.directory).read_bytes()
        result = server_round_trip(original, annotations=[{"pageIndex": 0, "paths": [pen_stroke()]}])
        self.assertEqual(image_filters(result), {"FlateDecode"})
        self.assertNotIn("DCTDecode", image_filters(result))

    def test_every_pen_style_draws_something(self):
        original = build_vector_pdf(self.directory).read_bytes()
        for style in ("default", "gel", "fountain", "brush"):
            with self.subTest(style=style):
                result = server_round_trip(
                    original, annotations=[{"pageIndex": 0, "paths": [pen_stroke(style=style)]}]
                )
                comparison = compare_renders(render_page(original, 0), render_page(result, 0))
                self.assertFalse(comparison["identical"], "%s drew nothing" % style)
                self.assertEqual(page_texts(result), page_texts(original))

    def test_ink_stays_vector_across_generations(self):
        """Export, re-open, export again: the ink must not thicken or soften."""
        original = build_vector_pdf(self.directory).read_bytes()
        annotations = [{"pageIndex": 0, "paths": [pen_stroke()]}]

        once = server_round_trip(original, annotations=annotations)
        # Re-exporting the already-inked file with no new annotations must be
        # a no-op on every page.
        twice = server_round_trip(once, annotations=[])

        self.assertEqual(content_stream_digests(twice), content_stream_digests(once))
        comparison = compare_renders(render_page(once, 0), render_page(twice, 0))
        self.assertTrue(comparison["identical"], comparison)

    def test_a_stroke_the_server_cannot_draw_is_reported_not_faked(self):
        """Calligraphy needs nib geometry that only the browser renderer has.

        Skipping it and saying so is correct; drawing an approximation and
        calling it the same stroke would not be.
        """
        original = build_vector_pdf(self.directory).read_bytes()
        client = app.test_client()
        response = client.post(
            "/api/pdf/export",
            data={
                "pdf": (io_bytes(original), "fixture.pdf"),
                "annotations": json.dumps([
                    {"pageIndex": 0, "paths": [pen_stroke(), pen_stroke(style="calligraphy")]}
                ]),
            },
            content_type="multipart/form-data",
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["X-Inkyscib-Strokes-Drawn"], "1")
        self.assertEqual(response.headers["X-Inkyscib-Strokes-Skipped"], "1")

    def test_annotations_for_a_page_that_does_not_exist_are_ignored(self):
        original = build_vector_pdf(self.directory).read_bytes()
        result = server_round_trip(
            original, annotations=[{"pageIndex": 99, "paths": [pen_stroke()]}]
        )
        self.assertEqual(content_stream_digests(result), content_stream_digests(original))


class BrowserAnnotatedExportTest(BrowserTestBase):
    """The same promise through the writer normal use actually hits."""

    def export_with_ink(self, source, style="default"):
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch()
            context = self.new_context(browser, accept_downloads=True)
            page = self.new_page(context)
            try:
                self.open_editor(page)
                self.import_pdf(page, source)

                page.evaluate(
                    """(style) => {
                      const points = [];
                      for (let step = 0; step < 24; step += 1) {
                        points.push({ x: 120 + step * 11, y: 200 + Math.sin(step / 3) * 24, pressure: 0.55 });
                      }
                      window.appState.paths.push({
                        tool: 'pen', penStyle: style, color: '#e0407a', size: 4,
                        points, timestamp: Date.now()
                      });
                      window.render();
                    }""",
                    style,
                )

                with page.expect_download(timeout=90000) as info:
                    page.evaluate("window.exportPptDeck('pdf')")
                target = self.directory / "inked.pdf"
                info.value.save_as(str(target))
                status = page.text_content("#pptImportStatus")
            finally:
                context.close()
                browser.close()

        self.raise_for_page_errors()
        return target.read_bytes(), status

    def test_the_browser_writes_vector_ink_onto_the_original(self):
        source = build_vector_pdf(self.directory)
        original = source.read_bytes()
        result, status = self.export_with_ink(source)

        self.assertEqual(page_texts(result), page_texts(original), "text must survive")
        self.assertNotIn("DCTDecode", image_filters(result), "no JPEG may appear")
        self.assertEqual(image_filters(result), image_filters(original))

        inked = compare_renders(render_page(original, 0), render_page(result, 0))
        clean = compare_renders(render_page(original, 1), render_page(result, 1))
        self.assertFalse(inked["identical"], "the stroke should be visible")
        self.assertTrue(clean["identical"], "the page with no ink must be untouched")

        self.assertIn("untouched", status)

    def test_a_stroke_pdf_cannot_draw_is_placed_as_an_image_and_reported(self):
        """Calligraphy fills angled nib quads that this exporter cannot emit.

        The fallback renders that stroke alone to a transparent PNG over its
        own bounding box, so the document under it is still untouched — and
        the status line says how many strokes needed it rather than implying
        the whole export was vector.
        """
        source = build_vector_pdf(self.directory)
        original = source.read_bytes()
        result, status = self.export_with_ink(source, style="calligraphy")

        self.assertEqual(page_texts(result), page_texts(original), "text must still survive")

        # The overlay is a PNG, so it is Flate — never a JPEG generation.
        self.assertNotIn("DCTDecode", image_filters(result))
        self.assertIn("FlateDecode", image_filters(result), "the fallback image should be there")

        inked = compare_renders(render_page(original, 0), render_page(result, 0))
        clean = compare_renders(render_page(original, 1), render_page(result, 1))
        self.assertFalse(inked["identical"], "the calligraphy stroke should be visible")
        self.assertTrue(clean["identical"], "the page with no ink must still be untouched")

        self.assertIn("1 that PDF cannot draw exactly", status)
        self.assertIn("400 DPI", status)

    def test_the_export_is_smaller_than_the_flattened_one_it_replaces(self):
        """The old path turned a 14 KB document into 852 KB of JPEG."""
        source = build_vector_pdf(self.directory)
        original = source.read_bytes()
        result, _ = self.export_with_ink(source)
        self.assertLess(len(result), len(original) * 3)


if __name__ == "__main__":
    unittest.main()
