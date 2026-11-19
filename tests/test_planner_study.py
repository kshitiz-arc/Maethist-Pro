"""The Planner's study layer (2.8.0), chosen by an LLM council
(docs/council/council-planner-2026-11-19.md): exams with a countdown and a
revision plan spread before them, a streak, this week at a glance, focus
sessions started from a task and logged against it, a task's notebook, and
backup and restore. Old saved plans keep loading.
"""

import json
import threading
import unittest

from app import app
from browser_server import make_browser_server

try:
    from playwright.sync_api import sync_playwright

    PLAYWRIGHT_AVAILABLE = True
except ImportError:  # pragma: no cover
    PLAYWRIGHT_AVAILABLE = False

KEY = "inkyscib-planner-v1"


@unittest.skipUnless(PLAYWRIGHT_AVAILABLE, "Playwright is not installed")
class PlannerStudyTests(unittest.TestCase):
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

    def open(self, seed=None):
        context = self.browser.new_context(viewport={"width": 1440, "height": 900}, accept_downloads=True)
        self.addCleanup(context.close)
        script = "localStorage.setItem('inkyscib-feature-tour-v1', 'seen');"
        if seed is not None:
            script += "if (!sessionStorage.getItem('seeded')) { localStorage.setItem(%r, %r); sessionStorage.setItem('seeded', '1'); }" % (KEY, json.dumps(seed))
        context.add_init_script(script)
        page = context.new_page()
        self.errors = []
        page.on("pageerror", lambda error: self.errors.append(str(error)))
        page.goto(self.base_url + "/write", wait_until="domcontentloaded")
        page.wait_for_function("() => window.appState?.storageReady === true && !!window.Inkyscib?.FileRibbon")
        page.evaluate("() => window.Inkyscib.FileRibbon.runCommand('planner')")
        page.wait_for_selector("#plannerModal:not([hidden]) .planner-study")
        return page

    def stored(self, page):
        return page.evaluate("(k) => JSON.parse(localStorage.getItem(k) || '{}')", KEY)

    def day(self, page, offset):
        return page.evaluate("(n) => { const d = new Date(); d.setDate(d.getDate() + n); return [d.getFullYear(), String(d.getMonth()+1).padStart(2,'0'), String(d.getDate()).padStart(2,'0')].join('-'); }", offset)

    def test_an_exam_counts_down_and_spreads_its_chapters_before_it(self):
        page = self.open()
        exam_day = self.day(page, 6)
        page.click("#plannerAddExamBtn")
        page.fill("#plannerExamName", "Maths unit test")
        page.fill("#plannerExamDate", exam_day)
        page.click('[data-fill-class="10"]')
        chapters = page.input_value("#plannerExamChapters").split("\n")
        self.assertEqual(len(chapters), 14, "Class 10 has fourteen chapters")
        page.fill("#plannerExamChapters", "Quadratic Equations\nTriangles\nProbability")
        page.click("#plannerExamForm .planner-save-task-btn")
        self.assertTrue(page.evaluate("() => document.getElementById('plannerExamForm').hidden"))
        self.assertIn("6", page.inner_text("#plannerExamList .planner-exam-days"))
        data = self.stored(page)
        self.assertEqual([e["name"] for e in data["exams"]], ["Maths unit test"])
        revisions = [t for t in data["tasks"] if t["title"].startswith("Revise: ")]
        self.assertEqual(len(revisions), 3)
        self.assertTrue(all(t["startDate"] < exam_day for t in revisions), "every revision lands before the exam")
        self.assertEqual(len({t["startDate"] for t in revisions}), 3, "spread over different days")
        self.assertEqual(revisions[0]["topic"], "Quadratic Equations")
        self.assertEqual(self.errors, [])

    def test_streak_and_this_week_count_what_was_done(self):
        today = None
        page = self.open()
        today = self.day(page, 0)
        yesterday = self.day(page, -1)
        seed = {"version": 1, "tasks": [
            {"id": "a", "title": "Old work", "startDate": yesterday, "recurrence": "none", "createdAt": 1, "completed": {yesterday: 1}},
            {"id": "b", "title": "Today's work", "startDate": today, "recurrence": "none", "createdAt": 2, "completed": {today: 2}},
            {"id": "c", "title": "Still to do", "startDate": today, "recurrence": "none", "createdAt": 3, "completed": {}},
        ]}
        page = self.open(seed)
        self.assertEqual(page.inner_text("#plannerStreakValue"), "2")
        self.assertEqual(page.locator("#plannerWeekStrip .planner-week-day").count(), 7)
        self.assertIn("done", page.inner_text("#plannerWeekMeta"))
        page.locator("#plannerWeekStrip .planner-week-day.is-today").click()

    def test_focus_from_a_task_runs_the_timer_and_logs_the_minutes(self):
        page = self.open()
        today = self.day(page, 0)
        page = self.open({"version": 1, "tasks": [
            {"id": "t1", "title": "Practise integrals", "startDate": today, "recurrence": "none", "createdAt": 1, "completed": {}, "topic": "Integrals"}]})
        self.assertIn("Integrals", page.inner_text("#plannerTaskList"))
        page.click('#plannerTaskList [data-planner-action="focus"]')
        page.wait_for_function("() => document.getElementById('plannerModal').hidden")
        page.evaluate("() => document.dispatchEvent(new CustomEvent('inkyscib:focus-complete', {detail: {minutes: 25}}))")
        data = self.stored(page)
        self.assertEqual(data["tasks"][0]["focusMinutes"], 25)
        self.assertEqual(data["focusDays"][today], 25)
        page.evaluate("() => window.Inkyscib.FileRibbon.runCommand('planner')")
        page.wait_for_selector("#plannerModal:not([hidden])")
        self.assertIn("25 min focused", page.inner_text("#plannerTaskList"))
        self.assertIn("25 min", page.inner_text("#plannerWeekMeta"))

    def test_the_timer_offers_start_focus(self):
        page = self.open()
        self.assertTrue(page.evaluate("() => typeof window.Inkyscib.Pomodoro.startFocus === 'function'"))

    def test_a_backup_restores_without_duplicates(self):
        page = self.open()
        today = self.day(page, 0)
        page = self.open({"version": 1, "tasks": [
            {"id": "keep", "title": "Keep me", "startDate": today, "recurrence": "none", "createdAt": 1, "completed": {}}],
            "exams": [{"id": "e1", "name": "Boards", "date": self.day(page, 30)}]})
        with page.expect_download() as download:
            page.click("#plannerBackupBtn")
        path = download.value.path()
        backup = json.loads(open(path, encoding="utf-8").read())
        self.assertEqual(backup["app"], "maethist-planner")
        backup["tasks"].append({"id": "new", "title": "From the backup", "startDate": today, "recurrence": "none", "createdAt": 5, "completed": {}})
        page.set_input_files("#plannerRestoreInput", files=[{"name": "plan.json", "mimeType": "application/json", "buffer": json.dumps(backup).encode()}])
        page.wait_for_function("(k) => JSON.parse(localStorage.getItem(k)).tasks.length === 2", arg=KEY)
        data = self.stored(page)
        self.assertEqual(sorted(t["id"] for t in data["tasks"]), ["keep", "new"])
        self.assertEqual(len(data["exams"]), 1, "the exam was already here, so it is not added twice")

    def test_a_plan_saved_before_2_8_still_opens(self):
        page = self.open()
        today = self.day(page, 0)
        page = self.open({"version": 1, "tasks": [
            {"id": "old", "title": "Saved long ago", "startDate": today, "recurrence": "weekly", "reminderTime": None, "createdAt": 1, "completed": {}}]})
        self.assertIn("Saved long ago", page.inner_text("#plannerTaskList"))
        self.assertEqual(self.errors, [])


if __name__ == "__main__":
    unittest.main()
