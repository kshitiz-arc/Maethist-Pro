// Smart eraser: a quick fix hands the pen back; a clean-up keeps the eraser.
//
// Reported (2.8.3): "if I have selected eraser and erased something, I need
// some delay in which the system will understand that I have already erased,
// and when I write again the pencil is selected" -- but not when "I'm erasing
// top left and then somewhere far, like bottom right".
//
// So every pick of the eraser starts a session that is one of two kinds:
//   temporary  the eraser was picked while writing (pen or highlighter). After
//              each erase stroke a short pause (PAUSE_MS) hands the writing
//              tool back, so the next stroke writes.
//   permanent  the eraser was picked from any other tool, the user pressed
//              "Keep eraser", the panel says "Stay eraser", or the strokes
//              wander: one that lands further than FAR of the screen diagonal
//              from everything erased so far is a clean-up, not a fix, and
//              the eraser stays until the user changes tool.
// A chip by the erased spot says which, with a draining bar for the pause.
(() => {
  "use strict";

  const PAUSE_MS = 1200;
  const FAR = 0.3;
  const WRITING = new Set(["pen", "highlight"]);
  const LABEL = { pen: "Pen", highlight: "Highlighter" };

  const s = () => window.appState;
  const enabled = () => s()?.toolSettings?.eraser?.autoReturn !== false;

  let lastTool = null;
  let session = null;
  let stroke = null;
  let switching = false;
  let chip = null;
  let chipTimer = 0;

  // ---------- the session ----------

  function begin(from) {
    const back = WRITING.has(from) ? from : null;
    session = { back, mode: back && enabled() ? "temporary" : "permanent", box: null, strokes: 0, timer: 0 };
  }

  function end() {
    if (session) window.clearTimeout(session.timer);
    session = null;
    stroke = null;
    hideChip();
  }

  function makePermanent(text) {
    if (!session) return;
    const was = session.mode;
    session.mode = "permanent";
    window.clearTimeout(session.timer);
    if (was === "temporary" && text) showChip(text, { kept: true });
  }

  function handBack() {
    if (!session || session.mode !== "temporary" || stroke) return;
    if (s()?.currentTool !== "eraser") return end();
    const back = session.back;
    switching = true;
    // The pen comes back without its panel: nobody asked for its controls.
    s().quietToolChange = true;
    try { window.setTool?.(back); } finally {
      s().quietToolChange = false;
      switching = false;
    }
    lastTool = back;
    session = null;
    showChip(`${LABEL[back] || "Pen"} is back`, { done: true });
  }

  // ---------- reading the strokes ----------

  function gap(a, b) {
    const dx = Math.max(0, a.left - b.right, b.left - a.right);
    const dy = Math.max(0, a.top - b.bottom, b.top - a.bottom);
    return Math.hypot(dx, dy);
  }

  function finishStroke() {
    const box = stroke;
    stroke = null;
    if (!session || !box) return;
    session.strokes += 1;
    const diag = Math.hypot(window.innerWidth, window.innerHeight);
    if (session.box && gap(session.box, box) > FAR * diag) {
      makePermanent("Erasing all over: the eraser stays");
    }
    session.box = session.box
      ? { left: Math.min(session.box.left, box.left), top: Math.min(session.box.top, box.top),
          right: Math.max(session.box.right, box.right), bottom: Math.max(session.box.bottom, box.bottom) }
      : box;
    if (session.mode !== "temporary") return;
    window.clearTimeout(session.timer);
    session.timer = window.setTimeout(handBack, PAUSE_MS);
    showChip(`${LABEL[session.back] || "Pen"} in a moment`, { countdown: true });
  }

  const onCanvas = (event) => event.target?.id === "drawingCanvas";
  const erasing = () => session && s()?.currentTool === "eraser" && !s()?.panMode;

  document.addEventListener("pointerdown", (event) => {
    if (!erasing() || !onCanvas(event) || !event.isPrimary) return;
    window.clearTimeout(session.timer);
    if (session.mode === "temporary") hideChip();
    stroke = { id: event.pointerId, left: event.clientX, right: event.clientX, top: event.clientY, bottom: event.clientY };
  }, true);

  document.addEventListener("pointermove", (event) => {
    if (!stroke || event.pointerId !== stroke.id) return;
    stroke.left = Math.min(stroke.left, event.clientX);
    stroke.right = Math.max(stroke.right, event.clientX);
    stroke.top = Math.min(stroke.top, event.clientY);
    stroke.bottom = Math.max(stroke.bottom, event.clientY);
  }, true);

  for (const type of ["pointerup", "pointercancel"]) {
    document.addEventListener(type, (event) => {
      if (stroke && event.pointerId === stroke.id) finishStroke();
    }, true);
  }

  document.addEventListener("toolChanged", (event) => {
    const tool = event.detail?.tool;
    if (switching) return;
    if (tool === "eraser" && lastTool !== "eraser") {
      end();
      begin(lastTool);
    } else if (tool !== "eraser") {
      end();
    }
    lastTool = tool;
  });

  // ---------- the chip ----------

  function buildChip() {
    chip = document.createElement("div");
    chip.className = "se-chip";
    chip.id = "smartEraserChip";
    chip.hidden = true;
    chip.setAttribute("role", "status");
    chip.setAttribute("aria-live", "polite");
    chip.innerHTML = `<span class="se-chip-text"></span>
      <button type="button" class="se-keep">Keep eraser</button>
      <i class="se-bar" aria-hidden="true"></i>`;
    chip.querySelector(".se-keep").addEventListener("click", () => makePermanent("Eraser kept"));
    document.body.appendChild(chip);
  }

  function showChip(text, { countdown = false, kept = false, done = false } = {}) {
    if (!chip) buildChip();
    window.clearTimeout(chipTimer);
    chip.querySelector(".se-chip-text").textContent = text;
    chip.classList.toggle("is-countdown", countdown);
    chip.classList.toggle("is-kept", kept);
    chip.classList.toggle("is-done", done);
    chip.style.setProperty("--se-ms", PAUSE_MS + "ms");
    const box = session?.box;
    if (box) {
      // Beside what was erased, never over it, and always on screen.
      const x = Math.min(window.innerWidth - 230, Math.max(12, box.right + 14));
      // Fully above the stroke (the chip is about 44px tall); below it when
      // the stroke is too near the top to fit.
      const above = box.top - 62;
      const y = Math.min(window.innerHeight - 56, above >= 70 ? above : box.bottom + 18);
      chip.style.left = x + "px";
      chip.style.top = y + "px";
    }
    chip.hidden = false;
    // Restart the entrance and the bar each time.
    chip.classList.remove("is-in");
    void chip.offsetWidth;
    chip.classList.add("is-in");
    if (!countdown) chipTimer = window.setTimeout(hideChip, done ? 900 : 1600);
  }

  function hideChip() {
    window.clearTimeout(chipTimer);
    if (chip) {
      chip.hidden = true;
      chip.classList.remove("is-in", "is-countdown");
    }
  }

  // ---------- the panel switch ----------

  function syncReturnButtons() {
    const on = enabled();
    document.querySelectorAll("[data-eraser-return]").forEach((button) => {
      const active = (button.dataset.eraserReturn === "on") === on;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", active ? "true" : "false");
    });
  }

  function start() {
    lastTool = s()?.currentTool || "pen";
    if (lastTool === "eraser") begin(null);
    document.querySelectorAll("[data-eraser-return]").forEach((button) => {
      button.addEventListener("click", () => {
        const settings = s()?.toolSettings;
        if (!settings) return;
        settings.eraser = settings.eraser || {};
        settings.eraser.autoReturn = button.dataset.eraserReturn === "on";
        if (!settings.eraser.autoReturn) makePermanent();
        syncReturnButtons();
        if (typeof window.savePreferences === "function") window.savePreferences();
      });
    });
    syncReturnButtons();
    // Saved preferences arrive after the scripts run.
    window.setTimeout(syncReturnButtons, 400);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();

  window.Inkyscib = window.Inkyscib || {};
  window.Inkyscib.SmartEraser = {
    PAUSE_MS,
    FAR,
    state: () => (session ? { mode: session.mode, back: session.back, strokes: session.strokes } : null),
    keep: () => makePermanent("Eraser kept")
  };
})();
