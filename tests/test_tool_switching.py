"""Switching tools, the way a person does it, never leaves the editor confused.

A seeded random walk over the rail, the keyboard shortcuts, the quick ring,
strokes, pauses (so the smart eraser hands the pen back), double clicks and
Escape. After every step: the rail lights exactly the tool in hand, nothing
is left mid-stroke or with the ring open, a shortcut gives the tool it names,
and the next stroke on open canvas does what the tool in hand does.

Written after a live demo where "switching tools got bugged" (2.10.2).
"""

import random
import threading
import unittest

from app import app
from browser_server import make_browser_server

try:
    from playwright.sync_api import sync_playwright

    PLAYWRIGHT_AVAILABLE = True
except ImportError:  # pragma: no cover
    PLAYWRIGHT_AVAILABLE = False

TOOLS = ["pen", "eraser", "highlight", "select", "line", "shape"]
KEYS = {"pen": "p", "eraser": "e", "highlight": "h", "select": "v", "line": "l", "shape": "s"}
STATE = """() => { const s = window.appState;
  return { tool: s.currentTool, pan: !!s.panMode, drawing: !!s.isDrawing, ring: window.Inkyscib.QuickAccess.ringOpen(), n: s.paths.length,
    active: [...document.querySelectorAll('.tool.active')].map((b) => b.id).filter((i) => /^[a-z]+Tool$/.test(i)),
    overlay: !!document.querySelector('.lesson-sheet, #commandPalette:not([hidden]), #shortcutSheet:not([hidden])') }; }"""
OPEN = "([x, y]) => document.elementFromPoint(x, y)?.id === 'drawingCanvas' && document.elementFromPoint(x + 60, y + 14)?.id === 'drawingCanvas'"


@unittest.skipUnless(PLAYWRIGHT_AVAILABLE, "Playwright is not installed")
class ToolSwitchingTests(unittest.TestCase):
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

    def walk(self, width, height, seed, steps=70):
        context = self.browser.new_context(viewport={"width": width, "height": height})
        self.addCleanup(context.close)
        context.add_init_script("localStorage.setItem('inkyscib-feature-tour-v1', 'seen')")
        page = context.new_page()
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.goto(self.base_url + "/write", wait_until="domcontentloaded")
        page.wait_for_function("() => window.appState?.storageReady === true && !!window.Inkyscib?.QuickAccess")
        page.wait_for_timeout(500)
        rnd = random.Random(seed)

        def spot():
            for _ in range(40):
                x, y = rnd.uniform(width * 0.1, width * 0.9), rnd.uniform(height * 0.2, height * 0.9)
                if page.evaluate(OPEN, [x, y]):
                    return x, y
            return width * 0.6, height * 0.6

        def stroke(x, y):
            page.mouse.move(x, y)
            page.mouse.down()
            for i in range(1, 12):
                page.mouse.move(x + i * 5, y + (i % 4) * 4)
            page.mouse.up()

        problems = []
        for step in range(steps):
            kind = rnd.choice(["rail", "rail", "key", "key", "ring", "stroke", "stroke", "stroke", "wait", "dbl", "esc"])
            target = rnd.choice(TOOLS)
            if kind == "rail":
                page.evaluate("(t) => document.getElementById(t + 'Tool')?.click()", target)
            elif kind == "key":
                page.mouse.move(*spot())
                page.keyboard.press(KEYS[target])
            elif kind == "ring":
                page.evaluate("(p) => window.Inkyscib.QuickAccess.openRingAt(p[0], p[1])", list(spot()))
                page.wait_for_timeout(250)
                page.evaluate("(s) => window.Inkyscib.QuickAccess.choose(s)", rnd.choice(["pen", "eraser", "select", "line", "undo"]))
            elif kind == "stroke":
                stroke(*spot())
            elif kind == "wait":
                page.wait_for_timeout(rnd.choice([200, 700, 1400]))
            elif kind == "dbl":
                page.mouse.dblclick(*spot())
            else:
                page.keyboard.press("Escape")
            page.wait_for_timeout(60)
            st = page.evaluate(STATE)
            where = f"step {step} ({kind} {target}), tool {st['tool']}"
            if st["drawing"]:
                problems.append(f"{where}: left mid-stroke")
            if st["ring"]:
                problems.append(f"{where}: ring left open")
            if not st["pan"] and st["active"] != [st["tool"] + "Tool"]:
                problems.append(f"{where}: rail lights {st['active']}")
            if kind in ("rail", "key") and st["tool"] != target and not st["overlay"]:
                problems.append(f"{where}: asked for {target}")
            if st["tool"] in ("pen", "highlight") and not st["pan"] and not st["overlay"]:
                stroke(*spot())
                page.wait_for_timeout(80)
                made, tool = page.evaluate("() => [window.appState.paths.length, window.appState.paths.at(-1)?.tool]")
                if made != st["n"] + 1 or tool != st["tool"]:
                    problems.append(f"{where}: the next stroke made {made - st['n']} {tool}")
        self.assertEqual(problems, [])
        self.assertEqual(errors, [])

    def test_a_laptop(self):
        self.walk(1280, 800, seed=3)

    def test_a_budget_tablet(self):
        self.walk(960, 600, seed=4)


if __name__ == "__main__":
    unittest.main()
