"""The vendored icon sets: Lucide, Phosphor and Remix Icon.

Pinned here: every icon the app asks for exists (a missing one is a blank
button), the vendored markup is drawing and nothing else (it is inlined into
every page), each library's licence ships beside it, and each surface uses
exactly one family so two icon styles never share a row.
"""

import json
import re
import threading
import unittest
from pathlib import Path

from app import app, icon
from browser_server import make_browser_server

try:
    from playwright.sync_api import sync_playwright

    PLAYWRIGHT_AVAILABLE = True
except ImportError:  # pragma: no cover
    PLAYWRIGHT_AVAILABLE = False

ROOT = Path(app.root_path)
REGISTRY_JS = ROOT / "static" / "js" / "icon-set.js"
TOUR_DONE = "localStorage.setItem('inkyscib-feature-tour-v1', JSON.stringify({seen: true}))"


def registry():
    text = REGISTRY_JS.read_text(encoding="utf-8")
    return json.loads(text.split("window.InkyscibIconSet = ", 1)[1].rstrip().rstrip(";"))


def referenced_icons():
    """Every set:name the templates and scripts ask for."""
    refs = set()
    for path in list((ROOT / "templates").rglob("*.html")):
        refs.update(re.findall(r'icon\("((?:lucide|phosphor|remix):[a-z0-9-]+)"', path.read_text(encoding="utf-8")))
    scripts = {p.name: p.read_text(encoding="utf-8") for p in (ROOT / "static" / "js").glob("*.js")}
    for source in scripts.values():
        refs.update(re.findall(r"""["']((?:lucide|phosphor|remix):[a-z0-9-]+)["']""", source))
    ribbon = scripts["file-ribbon.js"]
    block = ribbon[ribbon.index("const ICON_REFS = {"):ribbon.index("};", ribbon.index("const ICON_REFS = {"))]
    refs.update("lucide:" + name for name in re.findall(r':\s*"([a-z0-9-]+)"', block))
    tour = scripts["onboarding.js"]
    refs.update("phosphor:" + name for name in re.findall(r'phosphor\("([a-z0-9-]+)"\)', tour))
    icons_js = scripts["icons.js"]
    legacy = icons_js[icons_js.index("const LEGACY = {"):icons_js.index("const LEGACY_NAMES")]
    refs.update(f"{family}:{name}" for family, name in re.findall(r"(lucide|phosphor|remix): '([a-z0-9-]+)'", legacy))
    return refs


class VendoredIconTests(unittest.TestCase):
    def test_every_icon_the_app_asks_for_is_vendored(self):
        known = set(registry()["icons"])
        refs = referenced_icons()
        self.assertGreater(len(refs), 100)
        self.assertEqual(sorted(refs - known), [])
        for ref in refs:
            family, name = ref.split(":")
            with self.subTest(ref=ref):
                self.assertTrue((ROOT / "static" / "icons" / family / f"{name}.svg").is_file())

    def test_the_vendored_markup_is_drawing_and_nothing_else(self):
        allowed = {"path", "circle", "rect", "line", "polyline", "polygon", "ellipse", "g"}
        for ref, inner in registry()["icons"].items():
            with self.subTest(ref=ref):
                tags = set(re.findall(r"<\s*/?\s*([a-zA-Z]+)", inner))
                self.assertLessEqual(tags, allowed)
                self.assertNotRegex(inner, r"(?i)\bon[a-z]+\s*=|href|javascript:|style=|<script")
        for path in (ROOT / "static" / "icons").rglob("*.svg"):
            with self.subTest(file=path.name):
                self.assertNotRegex(path.read_text(encoding="utf-8"), r"(?i)\bon[a-z]+\s*=|href|<script|style=")

    def test_each_library_ships_with_its_licence(self):
        text = (ROOT / "static" / "icons" / "LICENSES.md").read_text(encoding="utf-8")
        self.assertIn("lucide-icons/lucide 1.66.0 (ISC)", text)
        self.assertIn("phosphor-icons/core v2.0.8 (MIT)", text)
        self.assertIn("Remix-Design/RemixIcon v4.9.1 (Remix Icon License v1.0)", text)
        self.assertIn("ISC License", text)
        self.assertIn("MIT License", text)
        self.assertIn("Remix Icon License v1.0", text)

    def test_the_server_and_the_browser_draw_the_same_svg(self):
        with app.app_context():
            server = str(icon("lucide:trash"))
        inner = registry()["icons"]["lucide:trash"]
        self.assertIn(inner, server)
        self.assertIn('class="icon icon-lucide icon-trash"', server)
        self.assertIn('aria-hidden="true"', server)

    def test_an_unknown_icon_fails_loudly_rather_than_rendering_blank(self):
        with app.app_context():
            with self.assertRaises(ValueError):
                icon("lucide:not-a-real-icon")
            with self.assertRaises(ValueError):
                icon("fontawesome:pen")

    def test_the_hand_drawn_editor_icons_are_gone(self):
        source = (ROOT / "static" / "js" / "icons.js").read_text(encoding="utf-8")
        self.assertNotIn("strokeIcon(", source)
        self.assertNotIn("<path d=", source)
        ribbon = (ROOT / "static" / "js" / "file-ribbon.js").read_text(encoding="utf-8")
        self.assertNotIn("function icon(paths)", ribbon)

    def test_marketing_pages_draw_remix_icons_without_unicode_stand_ins(self):
        client = app.test_client()
        home = client.get("/").get_data(as_text=True)
        self.assertIn("icon-remix", home)
        for glyph in ("&#8598;", "&#9998;", "&#9675;", "&#9585;", "&#9651;", "&#9633;", "◐"):
            self.assertNotIn(glyph, home)
        self.assertNotIn("icon-lucide", home)
        self.assertNotIn("icon-phosphor", home)
        about = client.get("/about").get_data(as_text=True)
        self.assertNotIn("↗</a>", about)


@unittest.skipUnless(PLAYWRIGHT_AVAILABLE, "Playwright is not installed")
class IconSurfaceBrowserTests(unittest.TestCase):
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

    def editor(self, width=1440, height=900):
        context = self.browser.new_context(viewport={"width": width, "height": height})
        self.addCleanup(context.close)
        context.add_init_script(TOUR_DONE)
        page = context.new_page()
        self.warnings = []
        page.on("console", lambda m: self.warnings.append(m.text) if "[icons]" in m.text else None)
        page.goto(self.base_url + "/write", wait_until="load")
        page.wait_for_function("() => window.appState?.storageReady === true")
        return page

    FAMILIES = """(selector) => {
      const found = new Set();
      document.querySelectorAll(selector).forEach((root) => {
        root.querySelectorAll('svg.icon').forEach((svg) => {
          ['lucide', 'phosphor', 'remix'].forEach((f) => { if (svg.classList.contains('icon-' + f)) found.add(f); });
        });
      });
      return [...found].sort();
    }"""

    def test_the_editor_chrome_is_all_lucide_and_nothing_renders_blank(self):
        page = self.editor()
        self.assertEqual(page.evaluate(self.FAMILIES, ".toolbar, .file-ribbon, .tool-rail"), ["lucide"])
        blank = page.evaluate(
            """() => [...document.querySelectorAll('.toolbar button.tool, .toolbar .tool-help-btn')]
                 .filter((b) => b.offsetParent !== null && !b.querySelector('svg'))
                 .map((b) => b.id || b.className)"""
        )
        self.assertEqual(blank, [])
        page.locator(".file-ribbon-tab").first.click()
        page.wait_for_selector(".file-backstage.is-open .file-command svg.icon-lucide")
        self.assertEqual(page.evaluate(self.FAMILIES, ".file-backstage"), ["lucide"])
        self.assertEqual(self.warnings, [])

    def test_planner_pomodoro_and_tour_are_phosphor(self):
        page = self.editor()
        page.evaluate("() => window.Inkyscib?.Planner?.open?.() || document.getElementById('plannerBtn')?.click()")
        page.wait_for_selector(".planner-overlay svg.icon-phosphor", state="attached")
        self.assertEqual(page.evaluate(self.FAMILIES, ".planner-overlay"), ["phosphor"])
        page.keyboard.press("Escape")
        page.evaluate("() => document.getElementById('pomodoroBtn').click()")
        page.wait_for_selector("#pomodoroModal svg.icon-phosphor", state="attached")
        self.assertEqual(page.evaluate(self.FAMILIES, "#pomodoroModal"), ["phosphor"])
        self.assertEqual(self.warnings, [])

    def test_icons_keep_their_own_paint(self):
        """A stroke on a filled Phosphor glyph, or a fill on an open Lucide
        path, is what the old per-button CSS would do without the guard."""
        page = self.editor()
        page.evaluate("() => document.getElementById('pomodoroBtn').click()")
        page.wait_for_selector("#pomodoroModal svg.icon-phosphor", state="attached")
        paint = page.evaluate(
            """() => {
              const lucide = document.querySelector('.toolbar svg.icon-lucide path');
              const phos = document.querySelector('#pomodoroModal svg.icon-phosphor path');
              const l = getComputedStyle(lucide), p = getComputedStyle(phos);
              return { lucideFill: l.fill, lucideStroke: l.stroke, phosFill: p.fill, phosStroke: p.stroke };
            }"""
        )
        self.assertEqual(paint["lucideFill"], "none")
        self.assertNotEqual(paint["lucideStroke"], "none")
        self.assertEqual(paint["phosStroke"], "none")
        self.assertNotEqual(paint["phosFill"], "none")


if __name__ == "__main__":
    unittest.main()
