"""The File ribbon and the .maedoc container.

The ribbon is only worth having if every command on it actually runs, so these
drive the real buttons in a real browser rather than calling the modules
directly. The .maedoc tests care about one thing above all: a document saved
and reopened must come back with its original intact and its ink still
editable — otherwise it is an export, not a document format.
"""

import hashlib
import json
import sys
import threading
import unittest
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from app import app
from browser_server import make_browser_server
from pdf_quality import build_vector_pdf

try:
    from playwright.sync_api import sync_playwright

    BROWSER_AVAILABLE = True
except ImportError:  # pragma: no cover - optional dependency
    BROWSER_AVAILABLE = False


@unittest.skipUnless(BROWSER_AVAILABLE, "playwright is not installed")
class RibbonTestBase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        app.config["TESTING"] = True
        cls.server = make_browser_server(app)
        cls.port = cls.server.server_port
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.thread.join(timeout=5)

    def setUp(self):
        import tempfile

        self._temp = tempfile.TemporaryDirectory(prefix="inkyscib_ribbon_")
        self.addCleanup(self._temp.cleanup)
        self.directory = Path(self._temp.name)
        self.page_errors = []

    def start(self, playwright):
        browser = playwright.chromium.launch()
        # bypass_csp: Playwright's wait_for_function polling needs eval, which
        # the editor's CSP forbids. CSP is covered by test_analytics_csp.py.
        context = browser.new_context(bypass_csp=True, accept_downloads=True)
        page = context.new_page()
        page.on("pageerror", lambda error: self.page_errors.append(str(error)))
        return browser, context, page

    def open_editor(self, page):
        url = "http://127.0.0.1:%d/write" % self.port
        page.goto(url)
        # The first-run feature tour covers the screen and would swallow every
        # click; mark it seen, then load the editor for real.
        page.evaluate(
            "localStorage.setItem('inkyscib-consent-v1', JSON.stringify({version: 1, analytics: false})); localStorage.setItem('inkyscib-feature-tour-v1', JSON.stringify({seen: true}))"
        )
        page.goto(url)
        page.wait_for_function("window.Inkyscib?.FileRibbon !== undefined", timeout=30000)
        page.wait_for_function("window.appState?.storageReady === true", timeout=30000)

    def import_pdf(self, page, path):
        page.set_input_files("#pdfImportInput", str(path))
        page.wait_for_function("window.appState?.ppt?.active === true", timeout=90000)
        page.wait_for_function(
            "!window.appState.ppt.slides.some(s => /Rendering page/.test(s.image || ''))",
            timeout=90000,
        )

    def draw_a_stroke(self, page):
        """Put a real pen path on the page.

        Added through the same commit-and-save sequence the drawing tools use
        (see static/js/tools/image.js) rather than by synthesising a pointer
        drag: a synthesised drag intermittently produced no path at all, which
        made every save and reopen assertion downstream flaky for a reason that
        has nothing to do with the File ribbon. The pen's own input handling is
        covered by test_pen_smoothing.py.
        """
        before = page.evaluate("window.appState.paths.length")
        page.evaluate(
            """() => {
              window.setTool('pen');
              const points = [];
              for (let step = 0; step < 24; step += 1) {
                points.push({ x: 180 + step * 9, y: 240 + Math.sin(step / 3) * 26, pressure: 0.5 });
              }
              if (typeof window.commitHistory === 'function') window.commitHistory();
              window.appState.paths.push({
                tool: 'pen',
                points,
                color: '#ff5c8a',
                size: 4,
                penStyle: 'default',
                timestamp: Date.now()
              });
              window.render();
              window.saveDrawing();
            }"""
        )
        page.wait_for_function(
            "count => window.appState.paths.length > count", arg=before, timeout=10000
        )

    def open_backstage(self, page, tab):
        """Show `tab`, whether or not the backstage is already up.

        Insert, Export and Tools are the ribbon's own tabs and are no longer
        repeated in the File panel's rail, so they open from the ribbon. File
        and Recent are the rail. The bar tabs toggle, so a tab that is already
        showing is never clicked again.
        """
        if tab in ("insert", "export", "tools"):
            ribbon_tab = '[data-ribbon-tab="%s"]' % tab
            if page.get_attribute(ribbon_tab, "aria-expanded") != "true":
                page.click(ribbon_tab)
            page.wait_for_selector(ribbon_tab + '[aria-expanded="true"]', timeout=5000)
            page.wait_for_selector(".file-backstage.is-open", timeout=5000)
            return

        rail_showing = page.evaluate(
            """() => {
              const rail = document.querySelector('.file-backstage.is-open .file-backstage-rail');
              return !!rail && getComputedStyle(rail).display !== 'none';
            }"""
        )
        if not rail_showing:
            page.click('[data-ribbon-tab="file"]')
            page.wait_for_selector(".file-backstage.is-open", timeout=5000)

        page.click('[data-rail-tab="%s"]' % tab)
        page.wait_for_selector(
            '[data-rail-tab="%s"][aria-selected="true"]' % tab, timeout=5000
        )
        page.wait_for_selector(".file-backstage.is-open", timeout=5000)

    def raise_for_page_errors(self):
        if self.page_errors:
            raise AssertionError("page errors: %s" % self.page_errors[:3])


class RibbonSurfaceTest(RibbonTestBase):
    """The bar itself, and which commands it offers when."""

    def test_the_file_panel_rail_does_not_repeat_the_ribbon_tabs(self):
        """Insert, Export and Tools are tabs on the ribbon itself.

        The File panel's left rail used to list all five sections, so those
        three were offered twice, a few centimetres apart. The rail keeps what
        belongs to File alone - its commands and Recent - and stands aside when
        the panel was opened from one of the other tabs.
        """
        rail_display = (
            "() => getComputedStyle(document.querySelector('.file-backstage-rail')).display"
        )
        with sync_playwright() as playwright:
            browser, context, page = self.start(playwright)
            try:
                self.open_editor(page)
                page.click('[data-ribbon-tab="file"]')
                page.wait_for_selector(".file-backstage.is-open", timeout=5000)
                rail_tabs = page.eval_on_selector_all(
                    ".file-rail-btn", "els => els.map(e => e.dataset.railTab)"
                )
                on_file = page.evaluate(rail_display)

                on_others = {}
                for tab, command in (
                    ("insert", "importPdf"),
                    ("export", "exportPdf"),
                    ("tools", "planner"),
                ):
                    page.click('[data-ribbon-tab="%s"]' % tab)
                    page.wait_for_selector(
                        '[data-ribbon-tab="%s"][aria-expanded="true"]' % tab, timeout=5000
                    )
                    page.wait_for_selector(
                        '#fileBackstagePane [data-command="%s"]' % command, timeout=5000
                    )
                    on_others[tab] = page.evaluate(rail_display)

                page.click('[data-ribbon-tab="file"]')
                page.wait_for_selector(
                    '[data-ribbon-tab="file"][aria-expanded="true"]', timeout=5000
                )
                back_on_file = page.evaluate(rail_display)

                page.click('[data-rail-tab="recent"]')
                page.wait_for_selector(
                    '[data-rail-tab="recent"][aria-selected="true"]', timeout=5000
                )
                file_tab_on_recent = page.get_attribute('[data-ribbon-tab="file"]', "aria-expanded")
            finally:
                context.close()
                browser.close()

        self.raise_for_page_errors()
        self.assertEqual(rail_tabs, ["file", "recent"])
        self.assertNotEqual(on_file, "none")
        self.assertEqual(on_others, {"insert": "none", "export": "none", "tools": "none"})
        self.assertNotEqual(back_on_file, "none")
        self.assertEqual(file_tab_on_recent, "true", "Recent is part of the File tab")

    def test_ribbon_renders_with_its_tabs(self):
        with sync_playwright() as playwright:
            browser, context, page = self.start(playwright)
            try:
                self.open_editor(page)
                self.assertTrue(page.is_visible(".file-ribbon"))
                tabs = page.eval_on_selector_all(
                    ".file-ribbon-tab", "els => els.map(e => e.textContent.trim())"
                )
            finally:
                context.close()
                browser.close()

        self.raise_for_page_errors()
        self.assertEqual(tabs, ["File", "Insert", "Export", "Tools"])

    def test_file_pane_offers_the_document_commands(self):
        with sync_playwright() as playwright:
            browser, context, page = self.start(playwright)
            try:
                self.open_editor(page)
                self.open_backstage(page, "file")
                titles = page.eval_on_selector_all(
                    "#fileBackstagePane .file-command .file-command-title",
                    "els => els.map(e => e.firstChild.textContent.trim())",
                )
            finally:
                context.close()
                browser.close()

        self.raise_for_page_errors()
        self.assertEqual(
            titles,
            [
                "New notebook", "Open", "Save", "Save as", "My Notebooks",
                # Pages arrived here when the hamburger drawer was deleted: it
                # changes the shape of the document, so it is a File command.
                "Notebook pages",
                "Back up everything",
                # Clear canvas moved here from the top bar, where it sat one
                # control away from Undo. It is last on purpose: the only
                # destructive command in the pane.
                "Clear canvas",
            ],
        )

    def test_exports_that_cannot_work_are_disabled_with_a_reason(self):
        """A dead button is worse than an absent one; a blocked one must explain."""
        with sync_playwright() as playwright:
            browser, context, page = self.start(playwright)
            try:
                self.open_editor(page)
                self.open_backstage(page, "export")
                before = page.eval_on_selector_all(
                    "#fileBackstagePane .file-command",
                    "els => els.map(e => ({"
                    " id: e.dataset.command,"
                    " disabled: e.disabled,"
                    " note: e.querySelector('.file-command-note').textContent.trim() }))",
                )

                page.keyboard.press("Escape")
                self.import_pdf(page, build_vector_pdf(self.directory))
                self.open_backstage(page, "export")
                after = page.eval_on_selector_all(
                    "#fileBackstagePane .file-command",
                    "els => els.map(e => ({ id: e.dataset.command, disabled: e.disabled }))",
                )
            finally:
                context.close()
                browser.close()

        self.raise_for_page_errors()

        blocked = {item["id"]: item for item in before}
        self.assertTrue(blocked["exportPdf"]["disabled"])
        self.assertTrue(blocked["exportPptx"]["disabled"])
        self.assertIn("Pages", blocked["exportPdf"]["note"])
        self.assertIn("PDF or deck", blocked["exportPptx"]["note"])
        # .maedoc always works: there is always a document to save.
        self.assertFalse(blocked["exportInkydoc"]["disabled"])

        enabled = {item["id"]: item["disabled"] for item in after}
        self.assertEqual(enabled, {k: False for k in enabled}, "every export should work with a deck open")

    def test_the_quality_readout_names_the_current_pipeline(self):
        with sync_playwright() as playwright:
            browser, context, page = self.start(playwright)
            try:
                self.open_editor(page)
                self.open_backstage(page, "export")
                canvas_text = page.text_content(".file-quality-text")

                page.keyboard.press("Escape")
                self.import_pdf(page, build_vector_pdf(self.directory))
                self.open_backstage(page, "export")
                deck_text = page.text_content(".file-quality-text")
                deck_tone = page.get_attribute(".file-quality", "data-tone")
            finally:
                context.close()
                browser.close()

        self.raise_for_page_errors()
        self.assertIn("Nothing on this canvas is compressed", canvas_text)
        # With a stored original the readout may claim vector — and only
        # because the export really is. The invariants in test_pdf_quality.py
        # are what keep this sentence from becoming a lie.
        self.assertIn("Vector", deck_text)
        self.assertIn("untouched", deck_text)
        self.assertEqual(deck_tone, "ok")


class InkydocRoundTripTest(RibbonTestBase):
    """Save As, then Open: the format's whole reason for existing."""

    def save_as_maedoc(self, page, name="saved.maedoc"):
        with page.expect_download(timeout=90000) as info:
            page.click('[data-command="exportInkydoc"]')
        target = self.directory / name
        info.value.save_as(str(target))
        return target

    def test_a_saved_document_embeds_the_original_untouched(self):
        source = build_vector_pdf(self.directory)
        expected = hashlib.sha256(source.read_bytes()).hexdigest()

        with sync_playwright() as playwright:
            browser, context, page = self.start(playwright)
            try:
                self.open_editor(page)
                self.import_pdf(page, source)
                self.open_backstage(page, "export")
                saved = self.save_as_maedoc(page)
            finally:
                context.close()
                browser.close()

        self.raise_for_page_errors()

        with zipfile.ZipFile(saved) as archive:
            names = archive.namelist()
            self.assertEqual(names[0], "mimetype", "the mimetype entry must come first")
            self.assertEqual(
                archive.read("mimetype").decode(), "application/vnd.maethist.document"
            )
            self.assertIn("manifest.json", names)
            self.assertIn("document.json", names)

            manifest = json.loads(archive.read("manifest.json"))
            self.assertEqual(manifest["format"], "maedoc")
            self.assertEqual(manifest["version"], 1)
            self.assertEqual(manifest["mode"], "slides")
            self.assertEqual(manifest["pageCount"], 2)
            self.assertEqual(manifest["source"]["docId"], expected)
            self.assertEqual(manifest["title"], "vector", "the title drops the source extension")

            embedded = archive.read(manifest["source"]["path"])

        self.assertEqual(
            hashlib.sha256(embedded).hexdigest(),
            expected,
            "the embedded original is not the file that was uploaded",
        )

    def test_reopening_restores_the_pages_and_keeps_the_ink_editable(self):
        source = build_vector_pdf(self.directory)

        with sync_playwright() as playwright:
            browser, context, page = self.start(playwright)
            try:
                self.open_editor(page)
                self.import_pdf(page, source)
                self.draw_a_stroke(page)

                before = page.evaluate(
                    "({ docId: window.appState.ppt.docId,"
                    "   pages: window.appState.ppt.slides.length,"
                    "   strokes: window.appState.paths.length })"
                )
                self.assertGreater(before["strokes"], 0, "the test needs ink on the page")

                self.open_backstage(page, "export")
                saved = self.save_as_maedoc(page)

                # A fresh editor, so nothing can be left over in memory.
                self.open_editor(page)
                page.evaluate(
                    """async () => {
                      const store = window.Inkyscib.DocStore;
                      for (const doc of await store.listDocuments()) {
                        await store.deleteDocument(doc.id);
                      }
                    }"""
                )
                reopened = page.evaluate(
                    """async (bytes) => {
                      const file = new File([new Uint8Array(bytes)], 'saved.maedoc');
                      const manifest = await window.Inkyscib.Inkydoc.open(file);
                      return {
                        title: manifest.title,
                        docId: window.appState.ppt?.docId || null,
                        pages: window.appState.ppt?.slides?.length || 0,
                        strokes: window.appState.paths.length,
                        firstStrokeTool: window.appState.paths[0]?.tool || null,
                        firstStrokePoints: window.appState.paths[0]?.points?.length || 0,
                        originalRestored: await window.Inkyscib.DocStore.hasDocument(
                          window.appState.ppt?.docId
                        )
                      };
                    }""",
                    list(saved.read_bytes()),
                )
            finally:
                context.close()
                browser.close()

        self.raise_for_page_errors()

        self.assertEqual(reopened["pages"], before["pages"])
        self.assertEqual(reopened["docId"], before["docId"])
        self.assertEqual(reopened["strokes"], before["strokes"])
        # Editable means real vector strokes, not a picture of them.
        self.assertEqual(reopened["firstStrokeTool"], "pen")
        self.assertGreater(reopened["firstStrokePoints"], 1)
        self.assertTrue(
            reopened["originalRestored"],
            "reopening must put the original PDF back in the document store",
        )

    def test_the_reader_accepts_an_archive_written_by_another_zip_tool(self):
        """The container is a plain ZIP, and has to stay one.

        Written by Python's zipfile with deflate, read by the browser: if the
        two ever disagree, .maedoc has quietly become a private format.
        """
        payload = self.directory / "external.maedoc"
        with zipfile.ZipFile(payload, "w", zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("mimetype", "application/vnd.maethist.document")
            archive.writestr(
                "manifest.json",
                json.dumps({"format": "maedoc", "version": 1, "title": "From zipfile", "source": None}),
            )
            archive.writestr(
                "document.json", json.dumps({"drawing": [], "notebook": None, "ppt": None})
            )

        with sync_playwright() as playwright:
            browser, context, page = self.start(playwright)
            try:
                self.open_editor(page)
                parsed = page.evaluate(
                    """async (bytes) => {
                      const file = new File([new Uint8Array(bytes)], 'external.maedoc');
                      const result = await window.Inkyscib.Inkydoc.parse(file);
                      return { title: result.manifest.title, hasDocument: !!result.document };
                    }""",
                    list(payload.read_bytes()),
                )
            finally:
                context.close()
                browser.close()

        self.raise_for_page_errors()
        self.assertEqual(parsed["title"], "From zipfile")
        self.assertTrue(parsed["hasDocument"])

    def test_a_document_from_a_newer_version_is_refused_clearly(self):
        payload = self.directory / "future.maedoc"
        with zipfile.ZipFile(payload, "w", zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("mimetype", "application/vnd.maethist.document")
            archive.writestr(
                "manifest.json", json.dumps({"format": "maedoc", "version": 99, "title": "Future"})
            )
            archive.writestr("document.json", json.dumps({"drawing": []}))

        with sync_playwright() as playwright:
            browser, context, page = self.start(playwright)
            try:
                self.open_editor(page)
                message = page.evaluate(
                    """async (bytes) => {
                      const file = new File([new Uint8Array(bytes)], 'future.maedoc');
                      try {
                        await window.Inkyscib.Inkydoc.parse(file);
                        return null;
                      } catch (error) {
                        return error.message;
                      }
                    }""",
                    list(payload.read_bytes()),
                )
            finally:
                context.close()
                browser.close()

        self.raise_for_page_errors()
        self.assertIsNotNone(message, "a newer format version must not parse")
        self.assertIn("newer version", message)


class RibbonCommandTest(RibbonTestBase):
    """The commands that write something out."""

    def test_png_export_is_lossless_and_at_the_stated_resolution(self):
        source = build_vector_pdf(self.directory)

        with sync_playwright() as playwright:
            browser, context, page = self.start(playwright)
            try:
                self.open_editor(page)
                self.import_pdf(page, source)
                self.open_backstage(page, "export")

                with page.expect_download(timeout=90000) as info:
                    page.click('[data-command="exportPng"]')
                target = self.directory / "page.png"
                info.value.save_as(str(target))
            finally:
                context.close()
                browser.close()

        self.raise_for_page_errors()

        data = target.read_bytes()
        self.assertTrue(data.startswith(b"\x89PNG"), "the export must be a real PNG, never a JPEG")

        from PIL import Image

        with Image.open(target) as image:
            # An A4 page is 595 pt wide; 300 dpi is 2479 px. The backing raster
            # may already be wider, and the exporter takes whichever is sharper.
            self.assertGreaterEqual(image.width, 2400)

    def test_save_writes_the_workspace_and_reports_it(self):
        source = build_vector_pdf(self.directory)

        with sync_playwright() as playwright:
            browser, context, page = self.start(playwright)
            try:
                self.open_editor(page)
                self.import_pdf(page, source)
                self.draw_a_stroke(page)

                self.open_backstage(page, "file")
                page.click('[data-command="save"]')
                page.wait_for_selector('.file-backstage-status[data-tone="success"]', timeout=30000)
                status = page.text_content("#fileBackstageStatus")
                ribbon_state = page.get_attribute(".file-ribbon", "data-state")

                # Reload and confirm the stroke actually survived.
                self.open_editor(page)
                survived = page.evaluate(
                    "({ strokes: window.appState.paths.length,"
                    "   active: !!window.appState.ppt?.active })"
                )
            finally:
                context.close()
                browser.close()

        self.raise_for_page_errors()
        self.assertEqual(status.strip(), "Saved.")
        self.assertEqual(ribbon_state, "saved")
        self.assertTrue(survived["active"])
        self.assertGreater(survived["strokes"], 0)

    def test_new_notebook_leaves_the_previous_one_in_the_library(self):
        with sync_playwright() as playwright:
            browser, context, page = self.start(playwright)
            try:
                self.open_editor(page)
                self.draw_a_stroke(page)

                self.open_backstage(page, "file")
                page.click('[data-command="new"]')
                page.wait_for_selector('.file-backstage-status[data-tone="success"]', timeout=30000)
                page.wait_for_timeout(400)

                result = page.evaluate(
                    """async () => {
                      const index = await window.Inkyscib.Library.listDocuments();
                      return { count: index.documents.length, strokes: window.appState.paths.length };
                    }"""
                )
            finally:
                context.close()
                browser.close()

        self.raise_for_page_errors()
        self.assertGreaterEqual(result["count"], 2, "the previous notebook must still be there")
        self.assertEqual(result["strokes"], 0, "a new notebook starts empty")

    def test_recent_lists_notebooks_and_switches_between_them(self):
        with sync_playwright() as playwright:
            browser, context, page = self.start(playwright)
            try:
                self.open_editor(page)
                self.draw_a_stroke(page)

                self.open_backstage(page, "file")
                page.click('[data-command="new"]')
                page.wait_for_timeout(600)

                self.open_backstage(page, "recent")
                page.wait_for_selector(".file-recent-item", timeout=10000)
                names = page.eval_on_selector_all(
                    ".file-recent-item .file-recent-name", "els => els.map(e => e.textContent.trim())"
                )

                # Switch to the one that is not currently open.
                page.click('.file-recent-item:not([aria-current="true"])')
                page.wait_for_timeout(900)
                strokes = page.evaluate("window.appState.paths.length")
            finally:
                context.close()
                browser.close()

        self.raise_for_page_errors()
        self.assertGreaterEqual(len(names), 2)
        self.assertGreater(strokes, 0, "switching back should restore the earlier notebook's ink")

    def test_keyboard_shortcuts_reach_the_commands(self):
        with sync_playwright() as playwright:
            browser, context, page = self.start(playwright)
            try:
                self.open_editor(page)
                self.draw_a_stroke(page)

                page.keyboard.press("Control+s")
                page.wait_for_function(
                    "document.querySelector('.file-ribbon')?.dataset.state === 'saved'",
                    timeout=30000,
                )
                saved_state = page.get_attribute(".file-ribbon", "data-state")

                self.open_backstage(page, "file")
                page.keyboard.press("Escape")
                page.wait_for_selector(".file-backstage:not(.is-open)", timeout=5000)
                closed = not page.evaluate(
                    "document.querySelector('.file-backstage').classList.contains('is-open')"
                )
            finally:
                context.close()
                browser.close()

        self.raise_for_page_errors()
        self.assertEqual(saved_state, "saved")
        self.assertTrue(closed, "Escape must close the backstage")


if __name__ == "__main__":
    unittest.main()
