"""Version 2 release plumbing: the offline shell, the health check, the
production guard on SECRET_KEY, and the compact chrome on tablets and phones.
"""

import json
import os
import re
import subprocess
import sys
import threading
import unittest
import unittest.mock
from pathlib import Path

import app as app_module
from app import app
from browser_server import make_browser_server

try:
    from playwright.sync_api import sync_playwright

    PLAYWRIGHT_AVAILABLE = True
except ImportError:  # pragma: no cover
    PLAYWRIGHT_AVAILABLE = False

ROOT = Path(app.root_path)
TOUR_DONE = "localStorage.setItem('inkyscib-feature-tour-v1', JSON.stringify({seen: true}))"


class ReleaseTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = app.test_client()

    def test_the_version_agrees_with_the_version_file(self):
        self.assertEqual(app_module.APP_VERSION, "2.8.2")
        self.assertEqual((ROOT / "VERSION").read_text().strip(), app_module.APP_VERSION)

    def test_the_health_check_answers_and_is_never_cached(self):
        response = self.client.get("/healthz")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json(), {"status": "ok", "version": "2.8.2"})
        self.assertEqual(response.headers["Cache-Control"], "no-store")

    def test_production_refuses_to_start_without_a_secret_key(self):
        env = {k: v for k, v in os.environ.items() if k != "SECRET_KEY"}
        env["INKYSCIB_ENV"] = "production"
        result = subprocess.run(
            [sys.executable, "-c", "import app"], cwd=ROOT, env=env,
            capture_output=True, text=True, timeout=120,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("SECRET_KEY is not set", result.stderr)

    def test_development_still_starts_without_one(self):
        env = {k: v for k, v in os.environ.items() if k not in ("SECRET_KEY", "INKYSCIB_ENV", "RENDER")}
        result = subprocess.run(
            [sys.executable, "-c", "import app; print(len(app.app.config['SECRET_KEY']))"],
            cwd=ROOT, env=env, capture_output=True, text=True, timeout=120,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip().splitlines()[-1], "64")

    def test_the_render_blueprint_starts_the_app_the_way_it_is_built(self):
        blueprint = (ROOT / "render.yaml").read_text()
        self.assertIn("gunicorn wsgi:app --config gunicorn.conf.py", blueprint)
        self.assertIn("healthCheckPath: /healthz", blueprint)
        self.assertIn("generateValue: true", blueprint)
        self.assertTrue((ROOT / "gunicorn.conf.py").exists())

    def test_every_runtime_dependency_is_pinned(self):
        for line in (ROOT / "requirements.txt").read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            with self.subTest(requirement=line):
                self.assertRegex(line, r"^[A-Za-z0-9_.-]+==[0-9][^;]*(;.*)?$")


class OfflineShellTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = app.test_client()
        cls.response = cls.client.get("/sw.js")
        cls.source = cls.response.get_data(as_text=True)

    def _list(self, name):
        return json.loads(re.search(rf"const {name} = (\[.*?\]);", self.source, re.S).group(1))

    def test_the_worker_is_served_from_the_root_as_javascript_and_revalidated(self):
        self.assertEqual(self.response.status_code, 200)
        self.assertIn("javascript", self.response.headers["Content-Type"])
        self.assertEqual(self.response.headers["Cache-Control"], "no-cache")
        self.assertEqual(self.response.headers["Service-Worker-Allowed"], "/")

    def test_it_precaches_the_pages_and_every_asset_the_editor_loads(self):
        self.assertEqual(self._list("PAGES"), ["/", "/write", "/features", "/about"])
        assets = {url.split("?")[0] for url in self._list("ASSETS")}
        editor = self.client.get("/write").get_data(as_text=True)
        loaded = set(re.findall(r'(?:src|href)="(/static/[^"?]+)', editor))
        self.assertTrue(loaded)
        missing = sorted(url for url in loaded if url not in assets)
        self.assertEqual(missing, [], "the editor loads files the offline shell does not cache")
        # Loaded on demand rather than by a tag, so the scan above cannot see them.
        for lazy in ("/static/js/vendor/pdf.min.js", "/static/js/vendor/pdf.worker.min.js",
                     "/static/js/vendor/pdf-lib.min.js"):
            self.assertIn(lazy, assets)

    def test_every_precached_url_exists_and_carries_its_version(self):
        for url in self._list("ASSETS"):
            with self.subTest(url=url):
                self.assertRegex(url, r"\?v=[0-9a-f]{8}$")
                self.assertTrue((ROOT / url.split("?")[0].lstrip("/")).is_file())

    def test_the_cache_name_changes_when_an_asset_does(self):
        name = re.search(r'const CACHE = "([^"]+)"', self.source).group(1)
        self.assertTrue(name.startswith("inkyscib-shell-2.8.2-"))
        with unittest.mock.patch.object(
            app_module, "offline_asset_urls", return_value=["/static/x.js?v=00000000"]
        ):
            other = self.client.get("/sw.js").get_data(as_text=True)
        self.assertNotEqual(name, re.search(r'const CACHE = "([^"]+)"', other).group(1))

    def test_the_api_and_the_lab_are_never_cached(self):
        self.assertIn('url.pathname.startsWith("/api/")', self.source)
        self.assertFalse(any("/inklab/" in url for url in self._list("ASSETS")))

    def test_every_page_registers_it(self):
        for path in ("/", "/features", "/about", "/write"):
            with self.subTest(path=path):
                self.assertIn("js/sw-register.js", self.client.get(path).get_data(as_text=True))


@unittest.skipUnless(PLAYWRIGHT_AVAILABLE, "Playwright is not installed")
class BrowserTests(unittest.TestCase):
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

    def editor(self, width, height, extra_script=""):
        context = self.browser.new_context(viewport={"width": width, "height": height})
        self.addCleanup(context.close)
        context.add_init_script(TOUR_DONE + ";" + extra_script)
        page = context.new_page()
        page.goto(self.base_url + "/write", wait_until="load")
        page.wait_for_function("() => window.appState?.storageReady === true")
        return context, page

    def test_the_editor_opens_with_the_network_gone(self):
        context, page = self.editor(960, 600, "window.__inkyscibOfflineShell = true")
        page.wait_for_function(
            "() => navigator.serviceWorker.ready.then(() => !!navigator.serviceWorker.controller)",
            timeout=60000,
        )
        page.wait_for_function(
            """async () => {
              const names = (await caches.keys()).filter((n) => n.startsWith('inkyscib-shell-'));
              if (!names.length) return false;
              const cache = await caches.open(names[0]);
              const scripts = [...document.scripts].map((s) => s.src).filter((s) => s.includes('/static/'));
              for (const src of scripts) { if (!(await cache.match(src))) return false; }
              return !!(await cache.match('/write'));
            }""",
            timeout=90000,
        )
        context.set_offline(True)
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.reload(wait_until="load")
        page.wait_for_function("() => window.appState?.storageReady === true", timeout=20000)
        self.assertTrue(page.locator("#drawingCanvas").is_visible())
        self.assertEqual(errors, [])

    def test_tablet_and_phone_get_two_docked_bars_that_do_not_touch(self):
        for width, height in ((960, 600), (768, 1024), (375, 812)):
            with self.subTest(width=width):
                _, page = self.editor(width, height)
                box = page.evaluate(
                    """() => {
                      const r = (s) => { const b = document.querySelector(s).getBoundingClientRect();
                        return { top: b.top, bottom: b.bottom, left: b.left, right: b.right }; };
                      const bar = document.querySelector('.toolbar');
                      const rows = new Set([...bar.querySelectorAll('button')]
                        .filter((b) => b.offsetParent !== null)
                        .map((b) => Math.round(b.getBoundingClientRect().top + b.getBoundingClientRect().height / 2)));
                      return { ribbon: r('.file-ribbon'), toolbar: r('.toolbar'), rows: rows.size,
                               docWidth: document.documentElement.scrollWidth };
                    }"""
                )
                self.assertLessEqual(box["ribbon"]["bottom"], box["toolbar"]["top"], "the bars overlap")
                self.assertEqual(box["rows"], 1, "the tools wrapped onto a second row")
                self.assertLessEqual(box["toolbar"]["bottom"], 130, "the chrome grew past two bars")
                self.assertGreaterEqual(box["toolbar"]["left"], 0)
                self.assertLessEqual(box["toolbar"]["right"], width)
                self.assertLessEqual(box["docWidth"], width, "the page scrolls sideways")

    def test_every_tool_fits_without_scrolling_on_the_target_tablet(self):
        _, page = self.editor(960, 600)
        overflow = page.evaluate(
            "() => { const b = document.querySelector('.toolbar'); return b.scrollWidth - b.clientWidth; }"
        )
        self.assertLessEqual(overflow, 0)

    def test_a_phone_can_reach_the_tools_past_the_edge(self):
        _, page = self.editor(375, 812)
        page.wait_for_function(
            "() => document.querySelector('.toolbar').classList.contains('can-scroll-end')"
        )
        reached = page.evaluate(
            """() => { const bar = document.querySelector('.toolbar'); bar.scrollLeft = bar.scrollWidth;
              const b = document.querySelector('#pomodoroBtn').getBoundingClientRect();
              return { left: b.left, right: b.right, width: innerWidth }; }"""
        )
        self.assertGreaterEqual(reached["left"], 0)
        self.assertLessEqual(reached["right"], reached["width"])

    def test_the_file_sheet_opens_clear_of_both_bars_and_inside_the_window(self):
        for width, height in ((960, 600), (375, 812)):
            with self.subTest(width=width):
                _, page = self.editor(width, height)
                page.locator(".file-ribbon-tab").first.click()
                page.wait_for_selector(".file-backstage.is-open")
                page.wait_for_timeout(350)
                box = page.evaluate(
                    """() => { const r = (s) => document.querySelector(s).getBoundingClientRect();
                      const sheet = r('.file-backstage'), bar = r('.toolbar'), legal = r('.editor-legal');
                      return { top: sheet.top, bottom: sheet.bottom, left: sheet.left, right: sheet.right,
                               toolbarBottom: bar.bottom, legalTop: legal.top, w: innerWidth }; }"""
                )
                self.assertGreaterEqual(box["top"], box["toolbarBottom"], "the sheet covers the tool row")
                self.assertLessEqual(box["bottom"], box["legalTop"], "the sheet covers the footer links")
                self.assertGreaterEqual(box["left"], 0)
                self.assertLessEqual(box["right"], box["w"])

    def test_the_page_switcher_does_not_sit_on_the_footer_links(self):
        for width, height in ((1440, 900), (960, 600), (375, 812)):
            with self.subTest(width=width):
                _, page = self.editor(width, height)
                gap = page.evaluate(
                    """() => { const el = document.querySelector('#notebookPageNav');
                      el.hidden = false; el.style.display = 'inline-flex';
                      const nav = el.getBoundingClientRect();
                      const legal = document.querySelector('.editor-legal').getBoundingClientRect();
                      return legal.top - nav.bottom; }"""
                )
                self.assertGreaterEqual(gap, 0)

    def test_the_help_sheet_fits_a_phone(self):
        _, page = self.editor(375, 812)
        page.evaluate("() => document.querySelector('#toolDockHelp').click()")
        page.wait_for_selector(".tool-help-sheet-panel")
        page.wait_for_timeout(250)
        box = page.evaluate(
            "() => { const r = document.querySelector('.tool-help-sheet-panel').getBoundingClientRect();"
            " return [r.left, r.right, innerWidth]; }"
        )
        self.assertGreaterEqual(box[0], 0)
        self.assertLessEqual(box[1], box[2])



class ImportGuardTests(unittest.TestCase):
    """2.0.1: the conversion endpoints refuse oversized uploads before reading
    them, and run at most IMPORT_CONCURRENCY conversions at once."""

    def setUp(self):
        self.client = app.test_client()

    def test_an_oversized_upload_is_refused_with_a_readable_message(self):
        for route in ("/api/pdf/import", "/api/ppt/import"):
            with self.subTest(route=route):
                body = b"x" * (app_module.MAX_IMPORT_UPLOAD_BYTES + 1)
                response = self.client.post(
                    route, data=body, headers={"Content-Type": "multipart/form-data; boundary=x"}
                )
                self.assertEqual(response.status_code, 413)
                self.assertIn("too large", response.get_json()["error"])

    def test_a_full_server_answers_busy_instead_of_queueing_forever(self):
        slots = app_module._IMPORT_SLOTS
        taken = 0
        try:
            while slots.acquire(blocking=False):
                taken += 1
            with unittest.mock.patch.object(app_module, "IMPORT_WAIT_SECONDS", 0.05):
                response = self.client.post("/api/pdf/import", data={})
        finally:
            for _ in range(taken):
                slots.release()
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.headers["Retry-After"], "10")
        self.assertIn("busy", response.get_json()["error"])

    def test_a_normal_request_still_reaches_the_endpoint(self):
        response = self.client.post("/api/pdf/import", data={})
        self.assertEqual(response.status_code, 400)
        self.assertIn("Choose a PDF", response.get_json()["error"])


class OfflineSwitchTests(unittest.TestCase):
    """OFFLINE_SHELL=off is the remote undo for a broken service worker."""

    def setUp(self):
        self.client = app.test_client()

    def test_pages_say_whether_the_shell_is_on(self):
        for path in ("/", "/write"):
            with self.subTest(path=path):
                html = self.client.get(path).get_data(as_text=True)
                self.assertIn('<meta name="inkyscib-offline-shell" content="on"', html)
        with unittest.mock.patch.object(app_module, "OFFLINE_SHELL_ENABLED", False):
            html = self.client.get("/write").get_data(as_text=True)
        self.assertIn('<meta name="inkyscib-offline-shell" content="off"', html)

    def test_switched_off_the_worker_removes_itself_and_its_cache(self):
        with unittest.mock.patch.object(app_module, "OFFLINE_SHELL_ENABLED", False):
            response = self.client.get("/sw.js")
        source = response.get_data(as_text=True)
        self.assertEqual(response.headers["Cache-Control"], "no-cache")
        self.assertIn("self.registration.unregister()", source)
        self.assertIn('startsWith("inkyscib-shell-")', source)
        self.assertNotIn("ASSETS", source)

    def test_a_sleeping_host_does_not_leave_a_blank_tab(self):
        source = self.client.get("/sw.js").get_data(as_text=True)
        self.assertIn("NETWORK_GRACE_MS", source)
        self.assertIn("Promise.race([fromNetwork, slow])", source)


@unittest.skipUnless(PLAYWRIGHT_AVAILABLE, "Playwright is not installed")
class DataSafetyBrowserTests(unittest.TestCase):
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

    def editor(self, extra_script=""):
        context = self.browser.new_context(viewport={"width": 960, "height": 600}, accept_downloads=True)
        self.addCleanup(context.close)
        context.add_init_script(TOUR_DONE + ";" + extra_script)
        page = context.new_page()
        page.goto(self.base_url + "/write", wait_until="load")
        page.wait_for_function("() => window.appState?.storageReady === true")
        return page

    DRAW = """() => {
      const c = document.querySelector('#drawingCanvas'); const r = c.getBoundingClientRect();
      const ev = (t, x, y) => c.dispatchEvent(new PointerEvent(t, {bubbles: true, cancelable: true,
        pointerId: 5, pointerType: 'pen', isPrimary: true, clientX: x, clientY: y, pressure: 0.5,
        buttons: t === 'pointerup' ? 0 : 1}));
      const x = r.left + r.width * 0.5, y = r.top + r.height * 0.6;
      ev('pointerdown', x, y); for (let i = 1; i < 25; i++) ev('pointermove', x + i * 5, y + i * 2);
      ev('pointerup', x + 125, y + 50);
    }"""

    def test_the_first_save_asks_the_browser_not_to_evict_the_notes(self):
        page = self.editor("""
          window.__persistCalls = 0;
          if (navigator.storage) {
            navigator.storage.persisted = () => Promise.resolve(false);
            navigator.storage.persist = () => { window.__persistCalls += 1; return Promise.resolve(true); };
          }
        """)
        page.evaluate("() => document.querySelector('#penTool').click()")
        page.keyboard.press("Escape")
        page.evaluate(self.DRAW)
        page.evaluate("() => window.saveDrawing && window.saveDrawing({ force: true })")
        page.wait_for_function("() => window.__persistCalls >= 1", timeout=10000)
        page.evaluate("() => window.saveDrawing && window.saveDrawing({ force: true })")
        page.wait_for_timeout(300)
        self.assertEqual(page.evaluate("() => window.__persistCalls"), 1, "asked more than once")

    def test_the_backup_reminder_is_due_only_when_work_has_gone_unbacked(self):
        page = self.editor()
        day = 24 * 60 * 60 * 1000
        result = page.evaluate(
            """(day) => {
              const set = (k, v) => v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v);
              const iso = (ms) => new Date(ms).toISOString();
              const now = Date.now(), due = (n) => window.Inkyscib.BackupReminder.due(n);
              const out = {};
              ['inkyscib-first-work-at','inkyscib-last-work-at','inkyscib-last-backup','inkyscib-backup-snooze-until']
                .forEach((k) => set(k, null));
              out.noWork = due(now);
              set('inkyscib-first-work-at', iso(now - 1 * day));
              out.oneDayNoBackup = due(now);
              set('inkyscib-first-work-at', iso(now - 3 * day));
              out.threeDaysNoBackup = due(now);
              set('inkyscib-backup-snooze-until', iso(now + day));
              out.snoozed = due(now);
              set('inkyscib-backup-snooze-until', null);
              set('inkyscib-last-backup', iso(now - 2 * day));
              set('inkyscib-last-work-at', iso(now - 1 * day));
              out.recentBackup = due(now);
              set('inkyscib-last-backup', iso(now - 9 * day));
              out.staleBackup = due(now);
              set('inkyscib-last-work-at', iso(now - 10 * day));
              out.staleButNoNewWork = due(now);
              return out;
            }""",
            day,
        )
        self.assertIsNone(result["noWork"])
        self.assertIsNone(result["oneDayNoBackup"])
        self.assertEqual(result["threeDaysNoBackup"], {"never": True})
        self.assertIsNone(result["snoozed"])
        self.assertIsNone(result["recentBackup"])
        self.assertEqual(result["staleBackup"], {"never": False, "days": 9})
        self.assertIsNone(result["staleButNoNewWork"])

    def test_the_reminder_sits_clear_of_the_chrome_and_its_button_backs_up(self):
        page = self.editor()
        page.evaluate(
            """() => { localStorage.setItem('inkyscib-first-work-at', new Date(Date.now() - 5 * 864e5).toISOString());
                       window.Inkyscib.BackupReminder.check(); }"""
        )
        page.wait_for_selector(".backup-reminder")
        boxes = page.evaluate(
            """() => { const r = (s) => document.querySelector(s).getBoundingClientRect();
              const b = r('.backup-reminder'), t = r('.toolbar'), l = r('.editor-legal');
              return { top: b.top, bottom: b.bottom, right: b.right, toolbarBottom: t.bottom,
                       legalTop: l.top, legalLeft: l.left, w: innerWidth }; }"""
        )
        self.assertGreater(boxes["top"], boxes["toolbarBottom"])
        self.assertLessEqual(boxes["bottom"], boxes["legalTop"] + 1)
        self.assertLessEqual(boxes["right"], boxes["w"])
        with page.expect_download() as download:
            page.locator(".backup-reminder-go").click()
        self.assertTrue(download.value.suggested_filename.endswith(".mae"))
        page.wait_for_function("() => !document.querySelector('.backup-reminder')")
        self.assertTrue(page.evaluate("() => !!localStorage.getItem('inkyscib-last-backup')"))

    def test_a_backup_restores_every_stroke(self):
        """The council's point: a backup nobody has restored is a hope. Draw,
        export the whole library, wipe the browser, import, and compare."""
        page = self.editor()
        page.evaluate("() => document.querySelector('#penTool').click()")
        page.keyboard.press("Escape")
        page.evaluate(self.DRAW)
        page.evaluate("() => window.saveDrawing({ force: true })")
        before = page.evaluate("() => JSON.stringify(window.appState.paths.map((p) => p.points.length))")
        self.assertNotEqual(before, "[]")

        with page.expect_download() as download:
            page.evaluate("() => window.Inkyscib.Library.exportBackup()")
        backup_path = download.value.path()
        backup = Path(backup_path).read_text(encoding="utf-8")
        self.assertIn('"kind":"inkyscib-backup"', backup)

        # A fresh browser, as after a reset tablet: nothing stored at all.
        fresh = self.editor()
        self.assertEqual(fresh.evaluate("() => window.appState.paths.length"), 0)
        fresh.on("dialog", lambda dialog: dialog.accept())
        ids_before = fresh.evaluate(
            "async () => (await window.Inkyscib.Library.listDocuments()).documents.map((d) => d.id)"
        )
        fresh.evaluate(
            """async (text) => {
              const file = new File([text], 'restore.mae', { type: 'application/json' });
              await window.Inkyscib.Library.importBackup(file);
            }""",
            backup,
        )
        docs = fresh.evaluate("async () => (await window.Inkyscib.Library.listDocuments()).documents.length")
        self.assertGreaterEqual(docs, 2, "the restored notebook was not added to the library")
        restored = fresh.evaluate(
            """async (before) => {
              const { documents } = await window.Inkyscib.Library.listDocuments();
              const added = documents.filter((d) => !before.includes(d.id));
              if (added.length !== 1) return 'added ' + added.length;
              await window.Inkyscib.Library.openDocument(added[0].id);
              return JSON.stringify(window.appState.paths.map((p) => p.points.length));
            }""",
            ids_before,
        )
        self.assertEqual(restored, before)


if __name__ == "__main__":
    unittest.main()
