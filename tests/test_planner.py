import json
import struct
import threading
import unittest
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from app import app
from browser_server import make_browser_server


ROOT = Path(__file__).resolve().parents[1]


class PlannerIntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = app.test_client()

    def test_planner_is_local_and_sits_immediately_before_ar(self):
        response = self.client.get("/write")
        html = response.get_data(as_text=True)

        self.assertEqual(response.status_code, 200)
        planner_position = html.index('id="plannerBtn"')
        ar_position = html.index('id="arSection"')
        self.assertLess(planner_position, ar_position)
        self.assertIn("Plan your day", html)
        self.assertIn("css/planner.css", html)
        self.assertIn("js/planner.js", html)

        planner_routes = [
            str(rule)
            for rule in app.url_map.iter_rules()
            if "planner" in str(rule).lower()
        ]
        self.assertEqual(planner_routes, [])

    def test_planner_static_assets_are_served(self):
        for path in (
            "/static/css/planner.css",
            "/static/js/planner.js",
            "/static/js/planner-sw.js",
        ):
            with self.subTest(path=path):
                with self.client.get(path) as response:
                    self.assertEqual(response.status_code, 200)
                    self.assertGreater(len(response.data), 100)

    def test_installable_manifest_and_notification_icons_are_local(self):
        with self.client.get("/static/manifest.webmanifest") as response:
            self.assertEqual(response.status_code, 200)
            manifest = json.loads(response.get_data(as_text=True))

        self.assertEqual(manifest["id"], "/write")
        self.assertEqual(manifest["start_url"], "/write")
        self.assertEqual(manifest["display"], "standalone")
        self.assertEqual(manifest["scope"], "/")
        self.assertIn(
            "/static/icons/maethist-maskable-512.png",
            [icon["src"] for icon in manifest["icons"]],
        )

        expected_sizes = {
            "maethist-180.png": (180, 180),
            "maethist-192.png": (192, 192),
            "maethist-512.png": (512, 512),
            "maethist-maskable-512.png": (512, 512),
            "maethist-badge-96.png": (96, 96),
        }
        for filename, expected_size in expected_sizes.items():
            with self.subTest(filename=filename):
                payload = (ROOT / "static" / "icons" / filename).read_bytes()
                self.assertEqual(payload[:8], b"\x89PNG\r\n\x1a\n")
                self.assertEqual(
                    struct.unpack(">II", payload[16:24]),
                    expected_size,
                )

        for path in ("/", "/write"):
            with self.subTest(path=path):
                html = self.client.get(path).get_data(as_text=True)
                self.assertIn('rel="manifest"', html)
                self.assertIn('rel="apple-touch-icon"', html)

    def test_pomodoro_keeps_focus_prompt_without_task_list(self):
        source = (ROOT / "static" / "js" / "pomodoro.js").read_text(encoding="utf-8")

        self.assertIn('placeholder="What are you working on?"', source)
        self.assertNotIn('<span>Tasks</span>', source)
        self.assertNotIn('class="pomo-task-form"', source)
        self.assertNotIn("function renderTasks()", source)


try:
    from playwright.sync_api import sync_playwright

    PLAYWRIGHT_AVAILABLE = True
except ImportError:
    PLAYWRIGHT_AVAILABLE = False


@unittest.skipUnless(PLAYWRIGHT_AVAILABLE, "Playwright is not installed")
class PlannerBrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = make_browser_server(app)
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

    def open_page(self, viewport=None, at=None):
        context = self.browser.new_context(
            viewport=viewport or {"width": 1366, "height": 768},
            timezone_id="Asia/Kolkata",
            # The planner renders dates through Intl with an undefined locale,
            # so it follows whatever the machine is set to. Pinning it keeps
            # assertions about date text from depending on where the suite runs.
            locale="en-US",
        )
        self.addCleanup(context.close)
        # The first-run tour covers the editor and swallows the #menuBtn click
        # that open_planner depends on.
        context.add_init_script(
            "localStorage.setItem('inkyscib-consent-v1', JSON.stringify({version: 1, analytics: false})); localStorage.setItem('inkyscib-feature-tour-v1', JSON.stringify({seen: true}))"
        )
        page = context.new_page()
        page.clock.install(
            time=at or datetime(
                2026, 7, 18, 15, 0, 0,
                tzinfo=ZoneInfo("Asia/Kolkata"),
            ),
        )
        page.goto(self.base_url + "/write", wait_until="domcontentloaded")
        # #plannerBtn lives inside the menu panel, which starts closed, so it is
        # never *visible* on load - only once open_planner opens the menu.
        # Waiting for visibility here stalled every test in this class for the
        # full 30s timeout before its body ever ran.
        page.wait_for_selector("#plannerBtn", state="attached")
        return page

    @staticmethod
    def open_planner(page, date=None):
        """Open the planner the way the File ribbon does.

        This used to click `#menuBtn` and then `#plannerBtn`. Both of those
        are gone: the hamburger and its drawer were removed, `#menuBtn` with
        them, and `#plannerBtn` survives only inside `#chromeTriggers` in
        write.html - a permanently `hidden` block kept so the import handlers
        stay bound (see the comment there and the DESIGN.md decision log).
        Waiting for a permanently hidden button is what stalled every test in
        this class for its full 30s timeout.

        The ribbon's planner command calls `Planner.open()` directly, so these
        tests do the same. The launch path itself is covered once, by
        `test_the_file_ribbon_tools_tab_opens_the_planner`.
        """
        if date:
            page.evaluate(
                "(date) => window.Inkyscib.Planner.open(date)",
                date,
            )
        else:
            page.evaluate("() => window.Inkyscib.Planner.open()")
        page.locator("#plannerModal.is-open").wait_for(state="visible")

    def test_the_file_ribbon_tools_tab_opens_the_planner(self):
        """The only route a user has to the planner.

        Every other test in this class calls `Planner.open()` directly, so
        without this one nothing would notice if the ribbon command broke -
        which is exactly how the removed hamburger went unnoticed here.
        """
        page = self.open_page()

        page.click('[data-ribbon-tab="tools"]')
        page.wait_for_selector(
            '[data-ribbon-tab="tools"][aria-expanded="true"]', timeout=5000
        )
        page.click('[data-command="planner"]')

        page.locator("#plannerModal.is-open").wait_for(state="visible")

    def test_calendar_has_exact_inclusive_one_year_boundary(self):
        page = self.open_page()
        self.open_planner(page)

        self.assertEqual(
            page.locator('.planner-day[data-date="2026-07-18"]').get_attribute(
                "aria-pressed"
            ),
            "true",
        )
        self.assertTrue(
            page.locator('.planner-day[data-date="2026-07-17"]').is_disabled()
        )

        self.open_planner(page, "2027-07-18")
        self.assertFalse(
            page.locator('.planner-day[data-date="2027-07-18"]').is_disabled()
        )
        self.assertTrue(
            page.locator('.planner-day[data-date="2027-07-19"]').is_disabled()
        )

        pure_results = page.evaluate(
            """
            () => ({
              leapMax: window.Inkyscib.Planner.getDateBounds(
                new Date(2028, 1, 29, 12)
              ).max,
              weeklyMatch: window.Inkyscib.Planner.occursOn(
                { startDate: '2026-07-18', recurrence: 'weekly' },
                '2026-07-25'
              ),
              weeklyMiss: window.Inkyscib.Planner.occursOn(
                { startDate: '2026-07-18', recurrence: 'weekly' },
                '2026-07-24'
              )
            })
            """
        )
        self.assertEqual(pure_results["leapMax"], "2029-02-28")
        self.assertTrue(pure_results["weeklyMatch"])
        self.assertFalse(pure_results["weeklyMiss"])

    def test_daily_task_progress_is_per_occurrence_and_persists(self):
        page = self.open_page()
        self.open_planner(page)

        page.locator("#plannerAddTaskBtn").click()
        page.locator("#plannerTaskTitle").fill("Finish physics notes")
        page.locator('input[name="plannerRepeat"][value="daily"]').check()
        page.locator("#plannerTaskForm").evaluate(
            "(form) => form.requestSubmit()"
        )

        page.locator(".planner-task-title").filter(
            has_text="Finish physics notes"
        ).wait_for()
        self.assertEqual(page.locator("#plannerProgressValue").inner_text(), "0%")
        page.locator(".planner-task-check").click()
        self.assertEqual(page.locator("#plannerProgressValue").inner_text(), "100%")

        state = page.evaluate("() => window.Inkyscib.Planner.getState()")
        self.assertEqual(state["tasks"][0]["recurrence"], "daily")
        self.assertIn("2026-07-18", state["tasks"][0]["completed"])

        self.open_planner(page, "2026-07-19")
        self.assertEqual(page.locator("#plannerProgressValue").inner_text(), "0%")
        self.assertEqual(
            page.locator(".planner-task-title").inner_text(),
            "Finish physics notes",
        )

        page.reload(wait_until="domcontentloaded")
        self.open_planner(page, "2026-07-19")
        self.assertEqual(
            page.locator(".planner-task-title").inner_text(),
            "Finish physics notes",
        )

    def test_today_time_picker_disables_past_am_and_minutes(self):
        page = self.open_page()
        self.open_planner(page)
        page.locator("#plannerAddTaskBtn").click()
        page.locator(".planner-switch").click()

        picker = page.evaluate(
            """
            () => ({
              amDisabled: document.querySelector(
                '#plannerPeriod option[value="AM"]'
              ).disabled,
              pmDisabled: document.querySelector(
                '#plannerPeriod option[value="PM"]'
              ).disabled,
              twoPmDisabled: document.querySelector(
                '#plannerHour option[value="2"]'
              ).disabled,
              threePmMinuteZeroDisabled: (() => {
                const hour = document.querySelector('#plannerHour');
                const minute = document.querySelector('#plannerMinute');
                const period = document.querySelector('#plannerPeriod');
                period.value = 'PM';
                period.dispatchEvent(new Event('change', { bubbles: true }));
                hour.value = '3';
                hour.dispatchEvent(new Event('change', { bubbles: true }));
                return minute.querySelector('option[value="0"]').disabled;
              })()
            })
            """
        )

        self.assertTrue(picker["amDisabled"])
        self.assertFalse(picker["pmDisabled"])
        self.assertTrue(picker["twoPmDisabled"])
        self.assertTrue(picker["threePmMinuteZeroDisabled"])

    def test_three_hour_smart_nudge_fires_once(self):
        page = self.open_page()
        self.open_planner(page)
        page.locator("#plannerAddTaskBtn").click()
        page.locator("#plannerTaskTitle").fill("Review the chapter")
        page.locator("#plannerTaskForm").evaluate(
            "(form) => form.requestSubmit()"
        )

        page.clock.fast_forward("03:00:01")
        page.locator(".planner-toast.is-smart").wait_for(state="visible")
        self.assertIn(
            "1 task left",
            page.locator(".planner-toast.is-smart").inner_text(),
        )

        page.evaluate("() => window.Inkyscib.Planner.scanReminders()")
        state = page.evaluate("() => window.Inkyscib.Planner.getState()")
        self.assertIn("2026-07-18", state["tasks"][0]["notified"]["auto"])
        self.assertEqual(page.locator(".planner-toast.is-smart").count(), 1)

    def test_device_notification_uses_static_service_worker_and_fires_once(self):
        page = self.open_page()
        page.evaluate(
            """
            () => {
              Object.defineProperty(Notification, 'permission', {
                configurable: true,
                get: () => 'granted'
              });
              window.__plannerNotifications = [];
              const registration = {
                active: { state: 'activated' },
                showNotification: async (title, options) => {
                  window.__plannerNotifications.push({ title, options });
                }
              };
              navigator.serviceWorker.register = async () => registration;
            }
            """
        )
        self.open_planner(page)

        page.wait_for_function(
            "() => document.querySelector('#plannerNotifyBtn').dataset.state === 'granted'"
        )
        page.locator("#plannerAddTaskBtn").click()
        page.locator("#plannerTaskTitle").fill("Join the study call")
        page.locator(".planner-switch").click()
        page.locator("#plannerPeriod").select_option("PM")
        page.locator("#plannerHour").select_option("3")
        page.locator("#plannerMinute").select_option("1")
        page.locator("#plannerTaskForm").evaluate(
            "(form) => form.requestSubmit()"
        )

        page.clock.fast_forward("00:01:02")
        page.locator(".planner-toast.is-reminder").wait_for(state="visible")
        notifications = page.evaluate("() => window.__plannerNotifications")

        self.assertEqual(len(notifications), 1)
        self.assertEqual(notifications[0]["title"], "MAETHIST Planner")
        self.assertIn(
            "Join the study call",
            notifications[0]["options"]["body"],
        )
        self.assertEqual(
            notifications[0]["options"]["data"]["date"],
            "2026-07-18",
        )
        self.assertIn(
            "/write?planner=1&date=2026-07-18",
            notifications[0]["options"]["data"]["url"],
        )
        self.assertEqual(
            notifications[0]["options"]["icon"],
            "/static/icons/maethist-192.png",
        )
        self.assertEqual(
            notifications[0]["options"]["badge"],
            "/static/icons/maethist-badge-96.png",
        )
        self.assertFalse(notifications[0]["options"]["requireInteraction"])
        self.assertFalse(notifications[0]["options"]["renotify"])
        self.assertEqual(
            notifications[0]["options"]["actions"],
            [{"action": "open-planner", "title": "Open planner"}],
        )
        self.assertTrue(notifications[0]["options"]["silent"])
        self.assertNotIn("vibrate", notifications[0]["options"])
        self.assertNotIn("sound", notifications[0]["options"])

        page.evaluate("() => window.Inkyscib.Planner.scanReminders()")
        notifications_after_rescan = page.evaluate(
            "() => window.__plannerNotifications.length"
        )
        self.assertEqual(notifications_after_rescan, 1)

    def test_lock_screen_test_uses_system_alert_sound_and_vibration(self):
        page = self.open_page()
        page.evaluate(
            """
            () => {
              Object.defineProperty(Notification, 'permission', {
                configurable: true,
                get: () => 'granted'
              });
              window.__plannerNotifications = [];
              const registration = {
                active: { state: 'activated' },
                showNotification: async (title, options) => {
                  window.__plannerNotifications.push({ title, options });
                }
              };
              navigator.serviceWorker.register = async () => registration;
            }
            """
        )
        self.open_planner(page)

        page.locator("#plannerNotifyBtn").click()
        page.locator(".planner-toast").filter(
            has_text="Lock-screen test armed"
        ).wait_for(state="visible")
        self.assertEqual(
            page.locator("#plannerNotifyText").inner_text(),
            "Test in 5 seconds",
        )

        page.clock.fast_forward("00:00:06")
        page.wait_for_function(
            "() => window.__plannerNotifications.length === 1"
        )
        notification = page.evaluate(
            "() => window.__plannerNotifications[0]"
        )
        options = notification["options"]

        self.assertEqual(notification["title"], "MAETHIST Planner")
        self.assertEqual(
            options["tag"],
            "inkyscib-planner-lock-screen-test",
        )
        self.assertEqual(options["vibrate"], [120, 70, 120])
        self.assertTrue(options["requireInteraction"])
        self.assertTrue(options["renotify"])
        self.assertNotIn("silent", options)
        self.assertNotIn("sound", options)
        self.assertIn("Lock-screen test", options["body"])
        self.assertEqual(
            page.locator("#plannerNotifyText").inner_text(),
            "Reminders on · test",
        )

    def test_foreground_reminder_batch_plays_one_subtle_chime(self):
        page = self.open_page()
        page.evaluate(
            """
            () => {
              Object.defineProperty(Notification, 'permission', {
                configurable: true,
                get: () => 'granted'
              });
              window.__plannerToneStarts = 0;
              window.__plannerNotifications = [];

              class FakeAudioParam {
                setValueAtTime() {}
                exponentialRampToValueAtTime() {}
              }
              class FakeNode {
                connect() {}
                disconnect() {}
              }
              class FakeOscillator extends FakeNode {
                constructor() {
                  super();
                  this.frequency = new FakeAudioParam();
                  this.type = 'sine';
                  this.onended = null;
                }
                start() {
                  window.__plannerToneStarts += 1;
                }
                stop() {}
              }
              class FakeGain extends FakeNode {
                constructor() {
                  super();
                  this.gain = new FakeAudioParam();
                }
              }
              class FakeAudioContext {
                constructor() {
                  this.state = 'running';
                  this.currentTime = 0;
                  this.destination = {};
                }
                resume() {
                  this.state = 'running';
                  return Promise.resolve();
                }
                createOscillator() {
                  return new FakeOscillator();
                }
                createGain() {
                  return new FakeGain();
                }
              }
              window.AudioContext = FakeAudioContext;

              const registration = {
                active: { state: 'activated' },
                showNotification: async (title, options) => {
                  window.__plannerNotifications.push({ title, options });
                }
              };
              navigator.serviceWorker.register = async () => registration;
            }
            """
        )
        self.open_planner(page)

        page.locator("#plannerAddTaskBtn").click()
        page.locator("#plannerTaskTitle").fill("Join the evening call")
        page.locator(".planner-switch").click()
        page.locator("#plannerPeriod").select_option("PM")
        page.locator("#plannerHour").select_option("6")
        page.locator("#plannerMinute").select_option("0")
        page.locator("#plannerTaskForm").evaluate(
            "(form) => form.requestSubmit()"
        )

        page.locator("#plannerAddTaskBtn").click()
        page.locator("#plannerTaskTitle").fill("Review today's notes")
        page.locator("#plannerTaskForm").evaluate(
            "(form) => form.requestSubmit()"
        )

        page.clock.fast_forward("03:00:02")
        page.wait_for_function("() => window.__plannerToneStarts === 2")

        self.assertEqual(
            page.evaluate("() => window.__plannerToneStarts"),
            2,
        )
        self.assertEqual(
            page.evaluate("() => window.__plannerNotifications.length"),
            2,
        )
        self.assertEqual(
            page.locator(".planner-toast.is-reminder").count(),
            1,
        )
        self.assertEqual(
            page.locator(".planner-toast.is-smart").count(),
            1,
        )

    def test_static_notification_worker_reaches_activated_state(self):
        page = self.open_page()
        result = page.evaluate(
            """
            async () => {
              const registration = await navigator.serviceWorker.register(
                '/static/js/planner-sw.js',
                { scope: '/static/js/' }
              );
              if (!registration.active) {
                const worker = registration.installing || registration.waiting;
                await new Promise((resolve, reject) => {
                  worker.addEventListener('statechange', () => {
                    if (worker.state === 'activated') resolve();
                    if (worker.state === 'redundant') reject(
                      new Error('worker became redundant')
                    );
                  });
                });
              }
              return {
                scope: registration.scope,
                state: registration.active && registration.active.state
              };
            }
            """
        )
        self.assertTrue(result["scope"].endswith("/static/js/"))
        self.assertEqual(result["state"], "activated")

    def test_visible_planner_rolls_to_today_at_midnight(self):
        page = self.open_page(
            at=datetime(
                2026, 7, 18, 23, 59, 58,
                tzinfo=ZoneInfo("Asia/Kolkata"),
            )
        )
        self.open_planner(page)
        page.locator("#plannerAddTaskBtn").click()
        page.locator("#plannerTaskTitle").fill("Midnight-safe task")

        page.clock.fast_forward("00:00:04")
        self.assertEqual(
            page.locator("#plannerSelectedKicker").text_content(),
            "Today",
        )
        self.assertIn(
            "July 19, 2026",
            page.locator("#plannerSelectedDate").inner_text(),
        )
        self.assertIn(
            "Jul 19, 2026",
            page.locator("#plannerComposerDate").inner_text(),
        )

        page.locator("#plannerTaskForm").evaluate(
            "(form) => form.requestSubmit()"
        )
        state = page.evaluate("() => window.Inkyscib.Planner.getState()")
        self.assertEqual(state["tasks"][0]["startDate"], "2026-07-19")

    def test_late_weekly_task_keeps_its_first_three_hour_nudge(self):
        page = self.open_page(
            at=datetime(
                2026, 7, 18, 22, 0, 0,
                tzinfo=ZoneInfo("Asia/Kolkata"),
            )
        )
        self.open_planner(page)
        page.locator("#plannerAddTaskBtn").click()
        page.locator("#plannerTaskTitle").fill("Late weekly review")
        page.locator('input[name="plannerRepeat"][value="weekly"]').check()
        page.locator("#plannerTaskForm").evaluate(
            "(form) => form.requestSubmit()"
        )

        page.clock.fast_forward("03:00:02")
        page.locator(".planner-toast.is-smart").wait_for(state="visible")
        self.assertIn(
            "Carried from Jul 18, 2026",
            page.locator(".planner-task-card.is-carryover").inner_text(),
        )
        state = page.evaluate("() => window.Inkyscib.Planner.getState()")
        self.assertIn("2026-07-18", state["tasks"][0]["notified"]["auto"])

    def test_device_calendar_export_has_native_alarm_recurrence_and_utf8_folding(self):
        page = self.open_page()
        self.open_planner(page)
        page.evaluate(
            """
            () => {
              Object.defineProperty(navigator, 'share', {
                configurable: true,
                value: undefined
              });
              Object.defineProperty(navigator, 'canShare', {
                configurable: true,
                value: undefined
              });
            }
            """
        )

        title = "Review 😀, chapters; path\\notes " + ("é" * 55)
        page.locator("#plannerAddTaskBtn").click()
        page.locator("#plannerTaskTitle").fill(title)
        page.locator(".planner-switch").click()
        page.locator("#plannerPeriod").select_option("PM")
        page.locator("#plannerHour").select_option("3")
        page.locator("#plannerMinute").select_option("5")
        page.locator('input[name="plannerRepeat"][value="daily"]').check()
        page.locator("#plannerTaskForm").evaluate(
            "(form) => form.requestSubmit()"
        )

        device_button = page.locator(
            'button[data-planner-action="device-calendar"]'
        )
        self.assertIn(
            "Works when MAETHIST is closed",
            device_button.get_attribute("aria-label"),
        )
        device_button.click()
        disclosure = page.locator(".planner-toast.is-reminder").filter(
            has_text="Alerts when MAETHIST is closed"
        )
        disclosure.wait_for(state="visible")
        self.assertIn(
            "will not sync",
            disclosure.inner_text(),
        )

        with page.expect_download() as download_info:
            disclosure.locator(".planner-toast-action").click()
        download = download_info.value
        payload = Path(download.path()).read_bytes()
        calendar = payload.decode("utf-8")
        unfolded = calendar.replace("\r\n ", "")

        self.assertTrue(download.suggested_filename.endswith(".ics"))
        self.assertTrue(calendar.endswith("\r\n"))
        self.assertNotIn("\n", calendar.replace("\r\n", ""))
        for physical_line in calendar.split("\r\n"):
            with self.subTest(line=physical_line[:30]):
                self.assertLessEqual(len(physical_line.encode("utf-8")), 75)

        self.assertEqual(calendar.count("BEGIN:VEVENT"), 1)
        self.assertIn("METHOD:PUBLISH", calendar)
        self.assertIn("DTSTART:20260718T150500", calendar)
        self.assertIn("RRULE:FREQ=DAILY;COUNT=366", calendar)
        self.assertRegex(calendar, r"\r\nSEQUENCE:[1-9][0-9]*\r\n")
        self.assertIn("BEGIN:VALARM", calendar)
        self.assertIn("ACTION:DISPLAY", calendar)
        self.assertIn("TRIGGER:PT0S", calendar)
        self.assertIn(
            "Review 😀\\, chapters\\; path\\\\notes",
            unfolded,
        )
        self.assertIn(
            "do not sync to Calendar",
            unfolded,
        )
        page.locator(".planner-toast.is-success").filter(
            has_text="Calendar file ready"
        ).wait_for(state="visible")

    def test_device_calendar_mobile_share_and_failure_paths_stay_local(self):
        page = self.open_page({"width": 390, "height": 844})
        self.open_planner(page)
        page.evaluate(
            """
            () => {
              window.__calendarShareMode = 'success';
              window.__calendarShares = [];
              window.__calendarObjectUrls = 0;
              const createObjectURL = URL.createObjectURL.bind(URL);
              URL.createObjectURL = (value) => {
                window.__calendarObjectUrls += 1;
                return createObjectURL(value);
              };
              Object.defineProperty(navigator, 'canShare', {
                configurable: true,
                value: ({ files }) => (
                  Array.isArray(files) &&
                  files.length === 1 &&
                  files[0] instanceof File
                )
              });
              Object.defineProperty(navigator, 'share', {
                configurable: true,
                value: async (payload) => {
                  const file = payload.files[0];
                  window.__calendarShares.push({
                    filename: file.name,
                    type: file.type,
                    content: await file.text()
                  });
                  if (window.__calendarShareMode === 'cancel') {
                    throw new DOMException('Share cancelled', 'AbortError');
                  }
                  if (window.__calendarShareMode === 'error') {
                    throw new Error('Share unavailable');
                  }
                }
              });
            }
            """
        )
        page.locator("#plannerAddTaskBtn").click()
        page.locator("#plannerTaskTitle").fill("Share locally")
        page.locator(".planner-switch").click()
        page.locator("#plannerMinute").select_option("15")
        page.locator("#plannerTaskForm").evaluate(
            "(form) => form.requestSubmit()"
        )

        def open_device_handoff():
            page.locator(
                'button[data-planner-action="device-calendar"]'
            ).click()
            disclosure = page.locator(".planner-toast.is-reminder").filter(
                has_text="Alerts when MAETHIST is closed"
            ).last
            disclosure.wait_for(state="visible")
            return disclosure

        open_device_handoff().locator(".planner-toast-action").click()
        page.wait_for_function("() => window.__calendarShares.length === 1")
        first_share = page.evaluate("window.__calendarShares[0]")
        self.assertTrue(first_share["filename"].endswith(".ics"))
        self.assertEqual(first_share["type"], "text/calendar;charset=utf-8")
        self.assertIn("BEGIN:VALARM", first_share["content"])
        self.assertEqual(page.evaluate("window.__calendarObjectUrls"), 0)

        page.locator(".planner-toast.is-success").filter(
            has_text="Calendar file ready"
        ).locator(".planner-toast-close").click()
        page.clock.fast_forward("00:00:02")
        page.evaluate("window.__calendarShareMode = 'cancel'")
        open_device_handoff().locator(".planner-toast-action").click()
        page.wait_for_function("() => window.__calendarShares.length === 2")
        page.evaluate("() => Promise.resolve().then(() => Promise.resolve())")
        self.assertEqual(page.evaluate("window.__calendarObjectUrls"), 0)

        first_sequence = int(next(
            line.split(":", 1)[1]
            for line in first_share["content"].split("\r\n")
            if line.startswith("SEQUENCE:")
        ))
        second_share = page.evaluate("window.__calendarShares[1]")
        second_sequence = int(next(
            line.split(":", 1)[1]
            for line in second_share["content"].split("\r\n")
            if line.startswith("SEQUENCE:")
        ))
        self.assertGreater(second_sequence, first_sequence)

        page.evaluate("window.__calendarShareMode = 'error'")
        disclosure = open_device_handoff()
        with page.expect_download() as download_info:
            disclosure.locator(".planner-toast-action").click()
        self.assertTrue(download_info.value.suggested_filename.endswith(".ics"))
        self.assertEqual(page.evaluate("window.__calendarObjectUrls"), 1)

    def test_recurring_smart_nudge_calendar_keeps_midnight_first_alarm(self):
        page = self.open_page(
            at=datetime(
                2026, 7, 18, 22, 0, 0,
                tzinfo=ZoneInfo("Asia/Kolkata"),
            )
        )
        self.open_planner(page)
        page.evaluate(
            """
            () => {
              Object.defineProperty(navigator, 'share', {
                configurable: true,
                value: undefined
              });
              Object.defineProperty(navigator, 'canShare', {
                configurable: true,
                value: undefined
              });
            }
            """
        )
        page.locator("#plannerAddTaskBtn").click()
        page.locator("#plannerTaskTitle").fill("Late weekly calendar nudge")
        page.locator('input[name="plannerRepeat"][value="weekly"]').check()
        page.locator("#plannerTaskForm").evaluate(
            "(form) => form.requestSubmit()"
        )
        created_at = page.evaluate(
            "() => window.Inkyscib.Planner.getState().tasks[0].createdAt"
        )
        expected_first_alarm = datetime.fromtimestamp(
            (created_at + (3 * 60 * 60 * 1000)) / 1000,
            tz=ZoneInfo("Asia/Kolkata"),
        ).strftime("%Y%m%dT%H%M%S")

        page.locator(
            'button[data-planner-action="device-calendar"]'
        ).click()
        disclosure = page.locator(".planner-toast.is-reminder").filter(
            has_text="Alerts when MAETHIST is closed"
        )
        with page.expect_download() as download_info:
            disclosure.locator(".planner-toast-action").click()
        calendar = Path(download_info.value.path()).read_bytes().decode("utf-8")

        self.assertEqual(calendar.count("BEGIN:VEVENT"), 2)
        self.assertIn("DTSTART:" + expected_first_alarm, calendar)
        self.assertIn("DTSTART:20260725T120000", calendar)
        self.assertIn("RRULE:FREQ=WEEKLY;COUNT=52", calendar)
        self.assertIn(".auto-first@", calendar)
        self.assertIn(".auto-series@", calendar)

    def test_phone_layout_has_no_horizontal_overflow(self):
        page = self.open_page({"width": 360, "height": 740})
        self.open_planner(page)
        page.locator("#plannerAddTaskBtn").click()
        page.locator("#plannerTaskTitle").fill("Responsive repeating reminder")
        page.locator('input[name="plannerRepeat"][value="daily"]').check()
        page.locator("#plannerTaskForm").evaluate(
            "(form) => form.requestSubmit()"
        )

        metrics = page.evaluate(
            """
            () => ({
              viewport: document.documentElement.clientWidth,
              documentWidth: document.documentElement.scrollWidth,
              modalWidth: document.querySelector('.planner-shell').scrollWidth,
              bodyWidth: document.body.scrollWidth,
              cardClientWidth: document.querySelector('.planner-task-card').clientWidth,
              cardScrollWidth: document.querySelector('.planner-task-card').scrollWidth,
              deviceAlertHeight: document.querySelector('.planner-task-device').getBoundingClientRect().height
            })
            """
        )
        self.assertLessEqual(metrics["documentWidth"], metrics["viewport"])
        self.assertLessEqual(metrics["bodyWidth"], metrics["viewport"])
        self.assertLessEqual(metrics["modalWidth"], metrics["viewport"])
        self.assertLessEqual(
            metrics["cardScrollWidth"],
            metrics["cardClientWidth"],
        )
        self.assertGreaterEqual(metrics["deviceAlertHeight"], 32)

    def test_calendar_keyboard_reaches_and_crosses_future_months(self):
        page = self.open_page()
        self.open_planner(page)

        page.locator("#plannerNextMonth").click()
        self.assertIn(
            "August 2026",
            page.locator("#plannerMonthLabel").inner_text(),
        )
        self.assertEqual(
            page.locator('.planner-day[tabindex="0"]').get_attribute("data-date"),
            "2026-08-01",
        )

        august_last = page.locator('.planner-day[data-date="2026-08-31"]')
        august_last.focus()
        august_last.press("ArrowRight")
        page.wait_for_function(
            "() => document.activeElement?.dataset?.date === '2026-09-01'"
        )

        self.assertIn(
            "September 2026",
            page.locator("#plannerMonthLabel").inner_text(),
        )
        self.assertEqual(
            page.locator('.planner-day[tabindex="0"]').get_attribute("data-date"),
            "2026-09-01",
        )

    def test_task_controls_are_named_and_toast_dismiss_restores_focus(self):
        page = self.open_page()
        self.open_planner(page)
        page.locator("#plannerAddTaskBtn").click()
        page.locator("#plannerTaskTitle").fill("Prepare lab summary")
        page.locator("#plannerTaskForm").evaluate(
            "(form) => form.requestSubmit()"
        )

        self.assertEqual(
            page.locator(".planner-task-check").get_attribute("aria-label"),
            "Mark task complete: Prepare lab summary",
        )
        toast_close = page.locator(".planner-toast.is-success .planner-toast-close")
        toast_close.focus()
        toast_close.click()
        page.clock.run_for(250)

        self.assertEqual(
            page.evaluate("() => document.activeElement?.id"),
            "plannerCloseBtn",
        )


if __name__ == "__main__":
    unittest.main()
