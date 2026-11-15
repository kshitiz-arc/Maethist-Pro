"""Write assist: handwriting that is smooth, lands where the pen went, and keeps up.

Measured before this change on a synthetic stylus stroke (220 samples at 250Hz,
two superposed sine waves, 1.6px jitter plus a 10Hz tremor; touch 3.2px):

    pointer:mode    live lag   end gap   RMS from intended   turn jitter
    pen:natural      9.73px    10.70px        1.633             0.079
    pen:strong      15.66px    17.88px        3.128             0.070
    touch:natural    9.28px    10.19px        1.545             0.089
    touch:strong    14.92px    17.20px        3.008             0.091
    (raw pen 0.821 / 0.432, raw touch 1.163 / 0.900, intended curve 0.055)

So "natural" traded wobble for lag, cut curves and a stroke that stopped ~11px
short of the lift: it landed further from the intended line than no assist.

What changed, and what these tests hold it to:

- While drawing, the ink is drawn through to the latest sample, so what is on
  screen reaches the nib. That tip is display only - `__inkInput.tip` - and
  never stored.
- On lift the stroke is rebuilt from the raw samples with zero-phase smoothing
  in arc-length space, so the wobble goes without the ink being pulled off the
  line or shortened. Both ends are the true pen-down and pen-up points, sharp
  corners are kept, and no point moves further than a small bound.
- Off stays exactly raw.
"""

import threading
import unittest

from app import app
from browser_server import make_browser_server


try:
    from playwright.sync_api import sync_playwright

    PLAYWRIGHT_AVAILABLE = True
except ImportError:  # pragma: no cover - optional dependency
    PLAYWRIGHT_AVAILABLE = False


# The measurement from the design spec, unchanged except that live lag is also
# taken at the point the ink is drawn to (the display-only tip).
HARNESS = r"""
window.__inkHarness = (pointerTypes, modes) => {
  const events = window.Inkyscib.Events; const state = window.appState;
  function rng(seed){ return () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; }; }
  const clean = t => ({ x: 300 + t * 420, y: 320 + 34 * Math.sin(t * Math.PI * 2 * 3) + 10 * Math.sin(t * Math.PI * 2 * 7.3) });
  const dense = Array.from({length: 4000}, (_, i) => clean(i / 3999));
  function nearest(p){ let best = Infinity; for (const q of dense){ const d = (p.x-q.x)**2 + (p.y-q.y)**2; if (d < best) best = d; } return Math.sqrt(best); }
  function resample(pts, step){ const out=[pts[0]]; let prev=pts[0], acc=0; for(let i=1;i<pts.length;i++){ let cur=pts[i]; let d=Math.hypot(cur.x-prev.x,cur.y-prev.y); while(acc+d>=step && d>0){ const k=(step-acc)/d; const np={x:prev.x+(cur.x-prev.x)*k,y:prev.y+(cur.y-prev.y)*k}; out.push(np); prev=np; d=Math.hypot(cur.x-prev.x,cur.y-prev.y); acc=0; } acc+=d; prev=cur; } return out; }
  function turnJitter(pts){ const r = resample(pts, 3); const ang=[]; for(let i=1;i<r.length;i++) ang.push(Math.atan2(r[i].y-r[i-1].y, r[i].x-r[i-1].x)); let s=0,n=0; for(let i=2;i<ang.length;i++){ let a=ang[i]-2*ang[i-1]+ang[i-2]; a=Math.atan2(Math.sin(a),Math.cos(a)); s+=a*a; n++; } return Math.sqrt(s/Math.max(1,n)); }
  const out = {};
  for (const pointerType of pointerTypes) for (const mode of modes) {
    state.paths = []; state.transform = { scale: 1, offsetX: 0, offsetY: 0 }; state.notebook.active = false; state.ppt.active = false; window.setTool('pen'); state.toolSettings.pen.smoothing = mode;
    const r = rng(7); const N = 220; const raw = [];
    const jitter = pointerType === 'touch' ? 3.2 : 1.6;
    for (let i = 0; i < N; i++) { const t = i / (N - 1); const c = clean(t); const tremor = 1.1 * Math.sin(i * 0.0251 * 10); raw.push({ clientX: c.x + (r()-0.5)*jitter + tremor*0.7, clientY: c.y + (r()-0.5)*jitter + tremor, timeStamp: 1000 + i * 4, pointerType, pressure: 0.5, pointerId: 1, buttons: 1 }); }
    const storedLags = []; const shownLags = [];
    events.startDrawing(raw[0]);
    raw.slice(1).forEach((p) => {
      events.continueDrawing(p);
      const live = state.currentPath;
      if (live?.points?.length) {
        const w = window.getCanvasPos(p);
        const stored = live.points[live.points.length - 1];
        const shown = live.__inkInput?.tip || stored;
        storedLags.push(Math.hypot(stored.x - w.x, stored.y - w.y));
        shownLags.push(Math.hypot(shown.x - w.x, shown.y - w.y));
      }
    });
    events.endDrawing();
    const path = state.paths[state.paths.length - 1];
    const toWorld = raw.map(p => window.getCanvasPos(p));
    const pts = path.points.map(p => ({x: p.x, y: p.y}));
    const rms = a => Math.sqrt(a.reduce((s, p) => s + nearest(p) ** 2, 0) / a.length);
    const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
    const lastRaw = toWorld[toWorld.length-1], lastInk = pts[pts.length-1], firstRaw = toWorld[0], firstInk = pts[0];
    out[pointerType + ':' + mode] = {
      n: pts.length, rawCount: raw.length,
      devRms: rms(pts), rawDevRms: rms(toWorld),
      turnJitter: turnJitter(pts), rawTurnJitter: turnJitter(toWorld),
      meanStoredLag: mean(storedLags), meanShownLag: mean(shownLags),
      endGap: Math.hypot(lastRaw.x-lastInk.x, lastRaw.y-lastInk.y),
      startGap: Math.hypot(firstRaw.x-firstInk.x, firstRaw.y-firstInk.y),
      tipSaved: Object.prototype.hasOwnProperty.call(path, '__inkInput') || Object.keys(path).includes('tip')
    };
  }
  return out;
};
"""


@unittest.skipUnless(PLAYWRIGHT_AVAILABLE, "Playwright is not installed")
class InkSmoothingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
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

    def open_page(self):
        context = self.browser.new_context(viewport={"width": 1280, "height": 720})
        self.addCleanup(context.close)
        page = context.new_page()
        page.set_default_timeout(20000)
        self.errors = []
        page.on("pageerror", lambda error: self.errors.append(str(error)))
        page.add_init_script("localStorage.setItem('inkyscib-consent-v1', JSON.stringify({version: 1, analytics: false})); localStorage.setItem('inkyscib-feature-tour-v1', 'seen')")
        page.goto(self.base_url + "/write", wait_until="domcontentloaded")
        page.wait_for_function("() => window.appState?.storageReady === true")
        page.wait_for_function("() => !!window.Inkyscib?.InkSmooth")
        # Shape assist and the handwriting tidy (handwriting.js) run on lift
        # after the smoothing, and the tidy resamples any stroke it moves, so
        # a measurement taken through it is a measurement of both layers. They
        # have their own tests in test_write_assist.py; this file measures the
        # smoothing alone.
        page.evaluate("() => { window.Inkyscib.Handwriting.assist = () => null; " + HARNESS + " return true; }")
        return page

    def measure(self, page, pointer_types, modes):
        return page.evaluate(
            "([types, modes]) => window.__inkHarness(types, modes)", [pointer_types, modes]
        )

    def test_off_is_exactly_what_the_pen_reported(self):
        page = self.open_page()
        result = self.measure(page, ["pen", "touch"], ["off"])
        for key, m in result.items():
            with self.subTest(case=key):
                self.assertEqual(m["n"], m["rawCount"])
                self.assertAlmostEqual(m["devRms"], m["rawDevRms"], places=9)
                self.assertAlmostEqual(m["turnJitter"], m["rawTurnJitter"], places=9)
                self.assertLess(m["endGap"], 1e-9)
        self.assertEqual(self.errors, [])

    def test_assisted_ink_keeps_up_lands_where_the_pen_went_and_loses_the_wobble(self):
        page = self.open_page()
        result = self.measure(page, ["pen", "touch"], ["natural", "strong"])
        report = {k: {n: (round(v, 3) if isinstance(v, float) else v) for n, v in m.items()} for k, m in result.items()}
        for key, m in result.items():
            mode = key.split(":")[1]
            with self.subTest(case=key):
                self.assertLessEqual(m["meanShownLag"], 1.5, f"the ink should reach the nib: {report[key]}")
                self.assertLessEqual(m["meanStoredLag"], 6.0, f"the drawn-through tip should stay short: {report[key]}")
                self.assertLessEqual(m["endGap"], 0.5, f"the stroke should end where the pen lifted: {report[key]}")
                self.assertLessEqual(m["startGap"], 0.5, f"and start where it went down: {report[key]}")
                self.assertLess(m["devRms"], m["rawDevRms"], f"closer to the intended line than raw: {report[key]}")
                self.assertLessEqual(m["turnJitter"], 0.08 if mode == "natural" else 0.07, f"wobble: {report[key]}")
                self.assertFalse(m["tipSaved"], "the display tip must never be stored")
        self.assertEqual(self.errors, [])

    def test_sharp_corners_in_handwriting_survive(self):
        """A v, a z or a 4 is made of corners; rounding them off is not tidying."""
        page = self.open_page()
        moved = page.evaluate(
            """() => {
              const smooth = window.Inkyscib.InkSmooth.smoothStroke;
              const corners = [{ x: 100, y: 100 }, { x: 140, y: 170 }, { x: 180, y: 100 }, { x: 220, y: 170 }, { x: 260, y: 100 }];
              const raw = [];
              let seed = 11;
              const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
              for (let c = 0; c < corners.length - 1; c++) {
                const a = corners[c], b = corners[c + 1];
                for (let k = 0; k < 20; k++) {
                  const t = k / 20;
                  raw.push({ x: a.x + (b.x - a.x) * t + (rnd() - 0.5) * 0.8, y: a.y + (b.y - a.y) * t + (rnd() - 0.5) * 0.8,
                             pressure: 0.5, time: raw.length * 4 });
                }
              }
              raw.push({ ...corners[corners.length - 1], pressure: 0.5, time: raw.length * 4 });
              const out = {};
              for (const strength of ['natural', 'strong']) {
                const points = smooth(raw, strength, 1);
                // How close the smoothed stroke still comes to each inner corner.
                out[strength] = corners.slice(1, -1).map(corner =>
                  Math.min(...points.map(p => Math.hypot(p.x - corner.x, p.y - corner.y))));
              }
              return out;
            }"""
        )
        for strength, distances in moved.items():
            limit = 1.5 if strength == "natural" else 2.5
            with self.subTest(strength=strength):
                self.assertLessEqual(max(distances), limit, f"corners pulled in by {distances}")
        self.assertEqual(self.errors, [])

    def test_time_and_pressure_survive_and_nothing_moves_far(self):
        page = self.open_page()
        result = page.evaluate(
            """() => {
              const raw = [];
              for (let i = 0; i < 300; i++) raw.push({ x: 100 + i * 1.5 + Math.sin(i * 1.9) * 2, y: 200 + Math.sin(i / 20) * 30 + Math.cos(i * 2.3) * 2,
                                                       pressure: 0.3 + 0.4 * (i % 2), time: 1000 + i * 4 });
              const out = window.Inkyscib.InkSmooth.smoothStroke(raw, 'strong', 1);
              let worst = 0, pressureFlicker = 0, rawFlicker = 0;
              out.forEach((p, i) => {
                worst = Math.max(worst, Math.hypot(p.x - raw[i].x, p.y - raw[i].y));
                if (i) { pressureFlicker += Math.abs(p.pressure - out[i - 1].pressure); rawFlicker += Math.abs(raw[i].pressure - raw[i - 1].pressure); }
              });
              return { count: out.length, times: out.every((p, i) => p.time === raw[i].time), worst,
                       pressureFlicker, rawFlicker, first: out[0], last: out.at(-1), rawFirst: raw[0], rawLast: raw.at(-1) };
            }"""
        )
        self.assertEqual(result["count"], 300)
        self.assertTrue(result["times"], "each sample keeps its own time")
        self.assertLessEqual(result["worst"], 6.0, "no point may travel far from where it was drawn")
        self.assertLess(result["pressureFlicker"], result["rawFlicker"] * 0.25, "line width should not flicker")
        for key in ("x", "y"):
            self.assertAlmostEqual(result["first"][key], result["rawFirst"][key], places=9)
            self.assertAlmostEqual(result["last"][key], result["rawLast"][key], places=9)
        self.assertEqual(self.errors, [])

    def test_the_top_of_the_slider_is_never_rougher_than_strong(self):
        """Write assist became a 0-100 level on 2026-09-19. Past Strong (70)
        the smoothing deliberately stops growing: measured, Strong's pen output
        is already as smooth as the intended line itself, and a wider kernel
        only rounded the letters. The top buys even weight and trimmed hooks
        instead -- so every level above Strong must be at least as clean as
        Strong and hold the shape at least as well."""
        page = self.open_page()
        result = self.measure(page, ["pen", "touch"], ["strong", 80, 90, 100])
        for kind in ("pen", "touch"):
            strong = result[f"{kind}:strong"]
            for level in (80, 90, 100):
                with self.subTest(input=kind, level=level):
                    m = result[f"{kind}:{level}"]
                    self.assertLessEqual(m["turnJitter"], strong["turnJitter"] * 1.02, f"rougher than Strong: {m}")
                    self.assertLessEqual(m["devRms"], strong["devRms"] + 0.05, f"further from the line: {m}")
                    # A trimmed hook may move an end by a few px; never more.
                    self.assertLessEqual(m["endGap"], 4.5, f"end moved too far: {m}")

    def test_lift_smoothing_is_cheap(self):
        page = self.open_page()
        median_ms = page.evaluate(
            """() => {
              const raw = [];
              for (let i = 0; i < 500; i++) raw.push({ x: i * 1.2 + Math.sin(i * 1.7), y: 300 + Math.sin(i / 25) * 40 + Math.cos(i * 2.1), pressure: 0.5, time: i * 4 });
              const smooth = window.Inkyscib.InkSmooth.smoothStroke;
              for (let i = 0; i < 5; i++) smooth(raw, 'strong', 1);
              const times = [];
              for (let i = 0; i < 20; i++) { const t0 = performance.now(); smooth(raw, 'strong', 1); times.push(performance.now() - t0); }
              times.sort((a, b) => a - b);
              return times[10];
            }"""
        )
        self.assertLessEqual(median_ms, 2.0, f"lift smoothing took {median_ms:.2f}ms for 500 points")
        self.assertEqual(self.errors, [])


if __name__ == "__main__":
    unittest.main()
