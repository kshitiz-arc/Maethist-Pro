// The first 30 seconds (2.9.3): on an empty canvas, under "Draw anywhere to
// start", one button shows what makes this canvas different. "See it answer"
// writes 12 + 7 = on the page, stroke by stroke, and the maths chip answers.
//
// The demo ink is real ink drawn through the normal path list, so it is the
// actual feature at work, not a picture of it. It is marked, never saved, and
// taken off the page the moment you touch the canvas, so your first stroke
// lands on a clean page.
(() => {
  "use strict";

  const s = () => window.appState;
  let demo = null;

  const L = (x0, y0, x1, y1, n = 10) => Array.from({ length: n + 1 }, (_, i) => ({ x: x0 + (x1 - x0) * i / n, y: y0 + (y1 - y0) * i / n }));
  const arc = (cx, cy, rx, ry, a, b, n = 20) => Array.from({ length: n + 1 }, (_, i) => {
    const t = a + (b - a) * i / n;
    return { x: cx + Math.cos(t) * rx, y: cy + Math.sin(t) * ry };
  });
  const PI = Math.PI;
  // A hand's version of each symbol in a unit box, y down: the same shapes
  // the digit reader was tuned on, so the demo reads first time.
  const GLYPHS = {
    "1": [[...L(0.3, 0.2, 0.5, 0.02, 5), ...L(0.5, 0.02, 0.5, 0.98, 16)]],
    "2": [[...arc(0.5, 0.33, 0.32, 0.28, PI, 2 * PI, 16), ...L(0.82, 0.33, 0.14, 0.95, 12), ...L(0.14, 0.95, 0.9, 0.95, 8)]],
    "7": [[...L(0.14, 0.08, 0.86, 0.08, 10), ...L(0.86, 0.08, 0.34, 0.97, 14)]],
    "+": [L(0.5, 0.2, 0.5, 0.8), L(0.2, 0.5, 0.8, 0.5)],
    "=": [L(0.2, 0.38, 0.8, 0.38), L(0.2, 0.62, 0.8, 0.62)]
  };

  function world(screenX, screenY) {
    const t = s()?.transform || { scale: 1, offsetX: 0, offsetY: 0 };
    const c = document.getElementById("drawingCanvas")?.getBoundingClientRect() || { left: 0, top: 0 };
    return { x: (screenX - c.left - (t.offsetX || 0)) / (t.scale || 1), y: (screenY - c.top - (t.offsetY || 0)) / (t.scale || 1) };
  }

  function inkColour() {
    const pen = s()?.toolSettings?.pen?.color;
    if (pen) return pen;
    return document.documentElement.dataset.theme === "light" ? "#1b1b18" : "#ffffff";
  }

  function repaint() {
    if (typeof window.invalidateCanvasDrawingCache === "function") window.invalidateCanvasDrawingCache();
    if (typeof window.render === "function") window.render();
  }

  async function play() {
    const st = s();
    if (!st || demo) return;
    if (typeof window.setTool === "function") window.setTool("pen");
    const canvas = document.getElementById("drawingCanvas")?.getBoundingClientRect();
    if (!canvas) return;
    const t = st.transform || { scale: 1 };
    const size = 46 / (t.scale || 1);
    const origin = world(canvas.left + canvas.width / 2 - 150, canvas.top + canvas.height / 2 - 110);
    const strokes = [];
    let x = origin.x;
    for (const ch of "12+7=") {
      const w = (ch === "1" ? 0.5 : 0.75) * size;
      for (const run of GLYPHS[ch]) strokes.push(run.map((p) => ({ x: x + p.x * w, y: origin.y + p.y * size, pressure: 0.55 })));
      x += w + size * 0.28;
    }
    demo = { paths: [], cancelled: false };
    document.body.classList.add("first-run-playing");
    // Each stroke grows point by point, at about a hand's pace.
    for (const run of strokes) {
      if (demo.cancelled) break;
      const path = { tool: "pen", size: 3, color: inkColour(), penStyle: "default", points: [run[0]], timestamp: Date.now(), firstRunDemo: true };
      st.paths.push(path);
      demo.paths.push(path);
      for (let i = 1; i < run.length && !demo.cancelled; i += 2) {
        path.points = run.slice(0, i + 1);
        repaint();
        await new Promise((r) => window.setTimeout(r, 14));
      }
      path.points = run;
      repaint();
      await new Promise((r) => window.setTimeout(r, 90));
    }
    document.body.classList.remove("first-run-playing");
    if (demo.cancelled) return;
    // The real feature reads the real ink.
    window.Inkyscib?.InkMath?.answerRuns?.(demo.paths.map((p) => p.points));
  }

  // The demo ink leaves the moment the canvas is touched, or a tool is used.
  function clear() {
    if (!demo) return;
    demo.cancelled = true;
    const gone = new Set(demo.paths);
    const st = s();
    if (st?.paths) st.paths = st.paths.filter((p) => !gone.has(p));
    demo = null;
    document.getElementById("inkMathChip")?.setAttribute("hidden", "");
    repaint();
  }
  document.addEventListener("pointerdown", (e) => {
    if (demo && !e.target?.closest?.("#firstRunTry")) clear();
  }, true);

  function mount() {
    const hint = document.getElementById("emptyHint");
    if (!hint || document.getElementById("firstRunTry")) return;
    const button = document.createElement("button");
    button.type = "button";
    button.id = "firstRunTry";
    button.className = "first-run-try";
    button.textContent = "See it answer maths";
    button.setAttribute("aria-describedby", "emptyHint");
    button.addEventListener("click", play);
    hint.after(button);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount, { once: true });
  else mount();

  window.Inkyscib = window.Inkyscib || {};
  window.Inkyscib.FirstRun = { play, clear, playing: () => !!demo };
})();
