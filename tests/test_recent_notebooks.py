"""Recents can rename and delete a notebook, not only open one.

Reported 2026-09-17: "The file menu has recents option but there is no option
to rename or delete those notebooks."

Both operations already existed and worked -- Library.renameDocument and
Library.deleteDocument, reachable from the Library modal's per-card pencil and
trash. The Recents pane was read-only by construction: each row was a single
<button> whose only behaviour was open-or-close, and HTML forbids nesting
interactive controls inside a button. So this routes to the existing functions
rather than growing a second implementation (DESIGN.md:316 is the precedent
against that).

Two things the row must keep, both pinned by test_file_ribbon.py: the bare
notebook name as the textContent of a .file-recent-name inside
.file-recent-item, and the row's CENTRE as the open target -- Playwright clicks
element centres, and more to the point a mis-click at the middle of a row must
never delete a notebook.
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
class RecentNotebookTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        app.config["TESTING"] = True
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

    def open_recents(self, extra=2, width=960):
        context = self.browser.new_context(viewport={"width": width, "height": 720})
        self.addCleanup(context.close)
        context.add_init_script(
            "localStorage.setItem('inkyscib-consent-v1', JSON.stringify({version: 1, analytics: false})); localStorage.setItem('inkyscib-feature-tour-v1', JSON.stringify({seen: true}))"
        )
        page = context.new_page()
        page.goto(self.base_url + "/write", wait_until="domcontentloaded")
        page.wait_for_function("() => window.appState?.storageReady === true")

        for i in range(extra):
            page.evaluate(
                "(name) => window.Inkyscib.Library.createDocument({ name })",
                f"Notebook {i + 2}",
            )
            page.wait_for_timeout(120)

        page.evaluate("() => window.Inkyscib.FileRibbon.open('recent')")
        page.wait_for_selector(".file-recent-item", timeout=10000)
        # The backstage animates in from scale(0.985), so anything measured
        # before it settles reads 1.5% short -- a 44px target measures 43.34
        # and looks exactly like a real tap-target bug.
        page.wait_for_function(
            """() => {
              const el = document.querySelector('.file-backstage');
              if (!el) return false;
              const t = getComputedStyle(el).transform;
              if (t === 'none') return true;
              // Exactly 1, not approximately: at scale 0.99995 a 44px row
              // still measures 43.998 and fails the floor by a rounding hair.
              const m = new DOMMatrixReadOnly(t);
              return m.a === 1 && m.d === 1;
            }""",
            timeout=5000,
        )
        return page

    def names(self, page):
        return page.eval_on_selector_all(
            ".file-recent-item .file-recent-name",
            "els => els.map(e => e.textContent.trim())",
        )

    # ---- what the row must still do -------------------------------------

    def test_the_name_is_still_the_rows_bare_text(self):
        """A rename or delete label leaking into .file-recent-name would put
        junk in the names list test_file_ribbon.py reads."""
        page = self.open_recents()
        for name in self.names(page):
            self.assertNotIn("Rename", name)
            self.assertNotIn("Delete", name)
            self.assertTrue(name.strip(), "a row rendered with an empty name")

    def test_the_centre_of_a_row_opens_it(self):
        """Playwright clicks element centres, and a mis-click in the middle of
        a row must never hit a destructive control."""
        page = self.open_recents()
        before = page.evaluate("() => window.Inkyscib.Library.listDocuments()")
        page.click('.file-recent-item:not([aria-current="true"])')
        page.wait_for_timeout(400)
        after = page.evaluate("() => window.Inkyscib.Library.listDocuments()")
        self.assertNotEqual(
            before["activeId"], after["activeId"],
            "clicking the middle of a row no longer switches notebook",
        )

    def test_rows_are_real_touch_targets(self):
        page = self.open_recents()
        boxes = page.eval_on_selector_all(
            ".file-recent-item",
            "els => els.map(e => e.getBoundingClientRect().height)",
        )
        self.assertTrue(boxes, "no rows rendered")
        for height in boxes:
            self.assertGreaterEqual(height, 44, "a recents row is under the 44px floor")

    # ---- the new affordances --------------------------------------------

    def test_every_row_offers_rename_and_delete(self):
        page = self.open_recents()
        rows = page.eval_on_selector_all(
            ".file-recent-item",
            """els => els.map(e => ({
                 rename: !!e.querySelector('[data-recent-rename]'),
                 remove: !!e.querySelector('[data-recent-delete]')
               }))""",
        )
        self.assertTrue(rows)
        for row in rows:
            self.assertTrue(row["rename"], "a row has no rename control")
            self.assertTrue(row["remove"], "a row has no delete control")

    def test_the_action_buttons_are_real_touch_targets(self):
        page = self.open_recents()
        boxes = page.eval_on_selector_all(
            ".file-recent-item [data-recent-rename], .file-recent-item [data-recent-delete]",
            "els => els.map(e => { const r = e.getBoundingClientRect(); return [r.width, r.height]; })",
        )
        self.assertTrue(boxes, "no action buttons rendered")
        for width, height in boxes:
            self.assertGreaterEqual(width, 44)
            self.assertGreaterEqual(height, 44)

    def test_renaming_a_notebook_changes_its_name_and_keeps_it(self):
        page = self.open_recents()
        target = page.locator('.file-recent-item:not([aria-current="true"])').first
        original = target.locator(".file-recent-name").text_content().strip()

        target.locator("[data-recent-rename]").click()
        field = page.locator(".file-recent-item .file-recent-rename-input").first
        field.wait_for(state="visible", timeout=4000)
        field.fill("Trigonometry")
        field.press("Enter")

        page.wait_for_function(
            """() => {
              const rows = document.querySelectorAll('.file-recent-item .file-recent-name');
              return [...rows].some((el) => el.textContent.trim() === 'Trigonometry');
            }""",
            timeout=5000,
        )
        # It has to reach storage too, not just the row.
        # listDocuments() is async. Reading .documents off the promise gives
        # undefined, and the check silently reads as "not saved" no matter what
        # happened -- page.evaluate only awaits a promise it is *returned*.
        self.assertTrue(
            page.evaluate(
                """async () => {
                  const index = await window.Inkyscib.Library.listDocuments();
                  return (index.documents || []).some((d) => d.name === 'Trigonometry');
                }"""
            ),
            "the new name never reached the library",
        )
        self.assertIn("Trigonometry", self.names(page))
        self.assertNotIn(original, self.names(page))

    def test_renaming_can_be_abandoned_with_escape(self):
        page = self.open_recents()
        target = page.locator('.file-recent-item:not([aria-current="true"])').first
        original = target.locator(".file-recent-name").text_content().strip()

        target.locator("[data-recent-rename]").click()
        field = page.locator(".file-recent-item .file-recent-rename-input").first
        field.wait_for(state="visible", timeout=4000)
        field.fill("Discarded")
        field.press("Escape")
        page.wait_for_timeout(300)

        self.assertIn(original, self.names(page))
        self.assertNotIn("Discarded", self.names(page))

    def test_deleting_asks_first_and_can_be_refused(self):
        """Destructive, so it goes through the app's own confirm rather than
        window.confirm -- which Playwright auto-dismisses and which looks
        nothing like the app."""
        page = self.open_recents()
        before = self.names(page)
        target = page.locator('.file-recent-item:not([aria-current="true"])').first
        doomed = target.locator(".file-recent-name").text_content().strip()

        target.locator("[data-recent-delete]").click()
        dialog = page.locator(".clear-confirm-modal")
        dialog.wait_for(state="visible", timeout=4000)
        # The dialog has to name what it is about to destroy.
        self.assertIn(doomed, dialog.text_content())

        page.click(".clear-confirm-cancel")
        page.wait_for_timeout(300)
        self.assertEqual(sorted(self.names(page)), sorted(before), "cancel deleted anyway")

    def test_confirming_the_delete_removes_the_notebook(self):
        page = self.open_recents()
        before = self.names(page)
        target = page.locator('.file-recent-item:not([aria-current="true"])').first
        doomed = target.locator(".file-recent-name").text_content().strip()

        target.locator("[data-recent-delete]").click()
        page.locator(".clear-confirm-modal").wait_for(state="visible", timeout=4000)
        page.click(".clear-confirm-danger")

        # Waiting on the DOM, not on the library: re-rendering the list is the
        # actual claim here. Nothing used to refresh it, so a delete that only
        # reached storage would leave a row pointing at a notebook that is gone.
        page.wait_for_function(
            """(name) => {
              const rows = document.querySelectorAll('.file-recent-item .file-recent-name');
              return ![...rows].some((el) => el.textContent.trim() === name);
            }""",
            arg=doomed,
            timeout=5000,
        )
        after = self.names(page)
        self.assertNotIn(doomed, after)
        self.assertEqual(len(after), len(before) - 1)

    def test_the_clear_canvas_confirm_still_says_what_it_used_to(self):
        """The confirm is shared now, so its original caller must be unchanged."""
        page = self.open_recents(extra=0)
        page.evaluate("() => window.Inkyscib.FileRibbon.close()")
        page.evaluate(
            "() => { window.appState.paths = [{tool:'pen', points:[{x:1,y:1},{x:9,y:9}], size:2}]; }"
        )
        # Not `() => window.clearCanvas()`: Playwright awaits a returned
        # promise, and clearCanvas does not settle until the dialog is
        # answered, so returning it deadlocks the test against itself.
        page.evaluate("() => { window.clearCanvas(); }")
        dialog = page.locator(".clear-confirm-modal")
        dialog.wait_for(state="visible", timeout=4000)
        text = dialog.text_content()
        self.assertIn("Clear the canvas?", text)
        self.assertIn("Keep drawing", text)
        page.click(".clear-confirm-cancel")


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
