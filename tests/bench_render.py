"""Times /write's render path in headless Chromium.

Not collected by pytest. Run from the repo root: python tests/bench_render.py

Tablet-shaped: 960x600 CSS px at DPR 2, a 1920x1200 canvas. Figures are raw ms -
JS plus draw-command recording - as medians. Headless compositing is software, so
these are for comparing code, not for quoting as frame times on a tablet.
"""

import json
import os
import sys
import threading

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO)
sys.path.insert(0, os.path.join(REPO, "tests"))
os.chdir(REPO)
os.environ.setdefault("SECRET_KEY", "dev")

from app import app  # noqa: E402
from browser_server import make_browser_server  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

TOUR = "localStorage.setItem('inkyscib-consent-v1', JSON.stringify({version: 1, analytics: false})); localStorage.setItem('inkyscib-feature-tour-v1', JSON.stringify({seen: true}))"

BENCH = r"""
({ count }) => {
  const state = window.appState;
  state.notebook.active = false;
  state.ppt.active = false;
  state.isDrawing = false;
  state.currentPath = null;
  state.transform = { scale: 1, offsetX: 0, offsetY: 0 };
  const median = (xs) => +xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)].toFixed(3);
  const raw = (fn) => { const t0 = performance.now(); fn(); return performance.now() - t0; };
  const glyph = (x0, y0) => {
    const points = [];
    for (let i = 0; i < 40; i++) {
      const t = i / 39;
      points.push({ x: x0 + 5 * Math.sin(t * Math.PI * 3) + t * 9, y: y0 + 7 * Math.cos(t * Math.PI * 2), pressure: 0.5, time: i * 8 });
    }
    return { tool: 'pen', style: 'default', points, color: '#ffffff', size: 2 };
  };
  const metrics = window.getCanvasMetrics();
  const cols = Math.max(1, Math.floor((metrics.width - 40) / 14));
  const rowStep = Math.max(3, (metrics.height - 60) / Math.ceil(count / cols));
  state.paths = [];
  for (let n = 0; n < count; n++) state.paths.push(glyph(20 + (n % cols) * 14, 20 + Math.floor(n / cols) * rowStep));
  window.invalidateCanvasDrawingCache();
  window.renderNow();

  const out = { strokes: count };
  out.fullRebuild = median(Array.from({ length: 9 }, () => raw(() => { window.invalidateCanvasDrawingCache(); window.renderNow(); })));
  out.penLift = median(Array.from({ length: 9 }, (_, i) => raw(() => { state.paths.push(glyph(30 + i * 3, 30)); window.renderNow(); })));

  // Live frames of a growing default-nib stroke, points 120-240. Raw, and with a
  // 1px readback so raster is included - which is where tail frames save time -
  // both with tail frames on and switched off through their test seam.
  const probe = document.createElement('canvas');
  probe.width = probe.height = 1;
  const probeCtx = probe.getContext('2d', { willReadFrequently: true });
  const drawing = document.getElementById('drawingCanvas');
  const readback = (fn) => raw(() => {
    fn();
    probeCtx.drawImage(drawing, 0, 0, 1, 1, 0, 0, 1, 1);
    probeCtx.getImageData(0, 0, 1, 1);
  });
  const liveFrames = (tails) => {
    window.__inkyscibSetDirtyRectFrames(tails);
    const live = { tool: 'pen', style: 'default', color: '#ffffff', size: 2, points: [] };
    state.currentPath = live;
    state.isDrawing = true;
    const rawFrames = [], readbackFrames = [];
    for (let i = 0; i < 240; i++) {
      live.points.push({ x: 100 + i * 3, y: 300 + 40 * Math.sin(i / 9), pressure: 0.5, time: i * 8 });
      if (i < 120) { window.renderNow(); continue; }
      if (i % 2) rawFrames.push(raw(() => window.renderNow()));
      else readbackFrames.push(readback(() => window.renderNow()));
    }
    state.isDrawing = false;
    state.currentPath = null;
    window.renderNow();
    window.__inkyscibSetDirtyRectFrames(true);
    return { raw: median(rawFrames), readback: median(readbackFrames) };
  };
  const full = liveFrames(false);
  const tail = liveFrames(true);
  out.liveFrame = tail.raw;
  out.liveFrameReadback = tail.readback;
  out.liveFrameReadbackFullFrames = full.readback;

  state.transform = { scale: 1, offsetX: -700, offsetY: 0 };
  const jump = [];
  for (let i = 0; i < 400; i++) {
    jump.push(raw(() => window.renderNow()));
    if (typeof __pendingMeta === 'undefined' || !__pendingMeta) break;
  }
  out.viewJumpWorstFrame = +Math.max(...jump).toFixed(3);
  out.viewJumpFrames = jump.length;

  state.transform = { scale: 1, offsetX: 0, offsetY: 0 };
  window.invalidateCanvasDrawingCache();
  window.renderNow();
  out.erase = +raw(() => {
    window.applyInkyscibEraserToPaths(state.paths, { tool: 'eraser', size: 24, points: [{ x: 300, y: 200 }, { x: 300, y: 260 }] });
    window.renderNow();
  }).toFixed(3);
  return out;
}
"""

# From a sample reaching the page to the first frame painted after it.
DELAY_SETUP = r"""
() => {
  const log = window.__delay = { arrivals: [], renders: [] };
  window.addEventListener('pointerrawupdate', () => log.arrivals.push(performance.now()), { capture: true, passive: true });
  document.addEventListener('canvasRendered', () => log.renders.push(performance.now()));
}
"""

DELAY_RESULT = r"""
() => {
  const { arrivals, renders } = window.__delay;
  const delays = [];
  for (const at of arrivals) {
    const painted = renders.find((t) => t >= at);
    if (painted !== undefined) delays.push(painted - at);
  }
  delays.sort((a, b) => a - b);
  return delays.length ? +delays[Math.floor(delays.length / 2)].toFixed(2) : null;
}
"""


def open_page(browser, base):
    context = browser.new_context(viewport={"width": 960, "height": 600}, device_scale_factor=2)
    context.add_init_script(TOUR)
    page = context.new_page()
    page.goto(base, wait_until="domcontentloaded")
    page.wait_for_function("() => window.appState?.storageReady === true")
    page.wait_for_timeout(300)
    return context, page


def ink_delay(page, raw):
    page.evaluate(
        "(raw) => { window.__inkyscibSetRawInput(raw); window.setTool('pen');"
        " window.__delay.arrivals.length = 0; window.__delay.renders.length = 0; }",
        raw,
    )
    page.mouse.move(200, 300)
    page.mouse.down()
    for i in range(60):
        page.mouse.move(206 + i * 5, 300 + (i % 7))
        page.wait_for_timeout(6)
    page.mouse.up()
    return page.evaluate(DELAY_RESULT)


def main():
    server = make_browser_server(app)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{server.server_port}/write"
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        for throttle in (1, 4):
            for count in (200, 1000, 3000):
                context, page = open_page(browser, base)
                if throttle > 1:
                    context.new_cdp_session(page).send("Emulation.setCPUThrottlingRate", {"rate": throttle})
                row = page.evaluate(BENCH, {"count": count})
                row["cpu"] = f"{throttle}x"
                print(json.dumps(row), flush=True)
                context.close()
        context, page = open_page(browser, base)
        page.evaluate(DELAY_SETUP)
        print(json.dumps({
            "inkDelayMedianMs": {"rawInput": ink_delay(page, True), "pointermoveOnly": ink_delay(page, False)}
        }), flush=True)
        context.close()
        browser.close()
    server.shutdown()


if __name__ == "__main__":
    main()
