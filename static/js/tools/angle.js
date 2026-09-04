// Angle tool: mark the angle between two lines.
//
// Click one line, click another, and the mark lands at the corner they make,
// with the angle written on it. A right angle gets the square instead of a
// number, because that is what a right angle looks like in every textbook the
// students using this have ever opened.
//
// It measures whatever is already on the page — a line drawn with the Line
// tool, a construction segment, a polygon edge — because Construction sees all
// of them the same way.
(function () {
  "use strict";

  const C = () => window.Inkyscib?.Construction;
  const G = () => window.Inkyscib?.GeometryEngine;

  // How close a click has to land on a line to mean that line.
  const PICK_SCREEN_PX = 14;

  // Radius of the mark, on screen, so it looks the same at every zoom.
  const MARK_SCREEN_RADIUS = 34;

  let first = null;   // { id, a, b, mode } the first line picked

  function settings() {
    const s = state();
    if (!s.toolSettings.angle) {
      s.toolSettings.angle = { color: null, size: 1.7, showText: true };
    }
    const a = s.toolSettings.angle;
    if (!Number.isFinite(a.size)) a.size = 1.7;
    if (typeof a.showText !== "boolean") a.showText = true;
    return a;
  }

  function state() {
    return window.appState;
  }

  function render() {
    if (typeof window.render === "function") window.render();
  }

  function setStatus(message) {
    const element = document.getElementById("angleStatus");
    if (element) element.textContent = message || "";
  }

  // ---------- picking a line ----------

  // Every straight edge Construction knows about, whichever tool drew it.
  function segments() {
    const construction = C();
    if (!construction) return [];
    const index = construction.rebuildIndex();
    const out = [];

    index.segments.forEach((path) => {
      const [a, b] = path.points || [];
      if (a && b) out.push({ id: path.gid, a, b, mode: path.mode || "segment" });
    });

    index.drawn.forEach((entry) => {
      entry.edges.forEach((edge, i) => {
        out.push({ id: entry.id + "e" + i, a: edge.a, b: edge.b, mode: edge.mode });
      });
    });

    return out;
  }

  function lineAt(world) {
    const engine = G();
    if (!engine) return null;

    const tolerance = engine.screenDistanceToWorld(PICK_SCREEN_PX, state()?.transform);
    let best = null;
    let bestDistance = tolerance;

    segments().forEach((segment) => {
      const projected = engine.projectPointOnLine(world, segment.a, segment.b);
      // A ray or an infinite line is pickable past its drawn points; a plain
      // segment is not.
      const t = projected.t;
      const within = segment.mode === "line" ? true
        : segment.mode === "ray" ? t >= 0
        : t >= 0 && t <= 1;
      if (!within) return;

      const distance = engine.distance(world, projected.point);
      if (distance <= bestDistance) {
        best = segment;
        bestDistance = distance;
      }
    });

    return best;
  }

  // ---------- building the mark ----------

  // Where the two lines actually cross, treating both as infinite. Two segments
  // that form a corner without literally touching still have an angle between
  // them, and that is the common case when a corner is drawn by hand.
  function vertexOf(one, two) {
    const engine = G();
    return engine.lineLineIntersection(one.a, one.b, two.a, two.b, { mode: "line" });
  }

  // Point each line away from the vertex, so the mark spans the corner rather
  // than its vertical opposite.
  function directionFrom(vertex, segment) {
    const engine = G();
    const toA = engine.distance(vertex, segment.a);
    const toB = engine.distance(vertex, segment.b);
    const far = toA >= toB ? segment.a : segment.b;
    return engine.angleOf(vertex, far);
  }

  function commit(one, two) {
    const construction = C();
    const engine = G();

    const vertex = vertexOf(one, two);
    if (!vertex) {
      setStatus("Those two lines are parallel — no angle between them.");
      return false;
    }

    const radius = engine.screenDistanceToWorld(MARK_SCREEN_RADIUS, state()?.transform);

    if (typeof window.commitHistory === "function") window.commitHistory();
    const mark = construction.createAngle(
      vertex,
      directionFrom(vertex, one),
      directionFrom(vertex, two),
      {
        radius,
        sourceIds: [one.id, two.id],
        color: settings().color,
        size: settings().size,
        showAngle: settings().showText
      }
    );

    if (!mark) {
      setStatus("Could not mark that angle.");
      return false;
    }

    const sweep = engine.arcSweep(mark.startAngle, mark.endAngle);
    setStatus("Marked " + ((sweep * 180) / Math.PI).toFixed(1) + "°.");

    if (typeof window.saveDrawing === "function") window.saveDrawing();
    render();
    return true;
  }

  // ---------- interaction ----------

  function reset() {
    first = null;
    setStatus("Click the first line.");
    render();
  }

  function handleDown(event) {
    const world = typeof window.getCanvasPos === "function" ? window.getCanvasPos(event) : null;
    if (!world) return false;

    const picked = lineAt(world);
    if (!picked) {
      setStatus(first ? "That missed — click the second line." : "Click a line to start.");
      return true;
    }

    if (!first) {
      first = picked;
      setStatus("Now click the second line.");
      render();
      return true;
    }

    if (picked.id === first.id) {
      setStatus("Pick a different line for the second side.");
      return true;
    }

    // A refusal (parallel lines) has already explained itself; overwriting that
    // with the idle prompt would leave the user with two clicks and no reason.
    if (commit(first, picked)) {
      setStatus("Click the first line.");
    }
    first = null;
    return true;
  }

  function getOverlayState() {
    if (state()?.currentTool !== "angle") return null;
    return { firstPicked: first ? { a: first.a, b: first.b } : null };
  }

  function syncPanel() {
    const a = settings();
    const size = document.getElementById("angleSize");
    const sizeInput = document.getElementById("angleSizeInput");
    const showText = document.getElementById("angleShowText");
    const picker = document.getElementById("angleCustomColor");

    if (size) size.value = a.size;
    if (sizeInput && document.activeElement !== sizeInput) sizeInput.value = a.size;
    if (showText) showText.checked = a.showText !== false;
    if (picker && a.color) picker.value = a.color;

    document.querySelectorAll("[data-angle-color]").forEach((swatch) => {
      const on = (swatch.dataset.angleColor || null) === (a.color || null);
      swatch.classList.toggle("selected", on);
    });
  }

  function saveSettings() {
    if (typeof window.savePreferences === "function") window.savePreferences();
  }

  function bindPanel() {
    const size = document.getElementById("angleSize");
    const sizeInput = document.getElementById("angleSizeInput");
    const showText = document.getElementById("angleShowText");
    const picker = document.getElementById("angleCustomColor");

    const setSize = (value) => {
      const next = Math.min(8, Math.max(1, Number(value)));
      if (!Number.isFinite(next)) return;
      settings().size = next;
      syncPanel();
      saveSettings();
    };

    size?.addEventListener("input", () => setSize(size.value));
    sizeInput?.addEventListener("input", () => setSize(sizeInput.value));

    showText?.addEventListener("change", () => {
      settings().showText = showText.checked;
      saveSettings();
    });

    picker?.addEventListener("input", () => {
      settings().color = picker.value;
      syncPanel();
      saveSettings();
    });

    document.querySelectorAll("[data-angle-color]").forEach((swatch) => {
      swatch.addEventListener("click", () => {
        settings().color = swatch.dataset.angleColor || null;
        syncPanel();
        saveSettings();
      });
    });

    syncPanel();
  }

  function init() {
    const button = document.getElementById("angleTool");
    if (!button) return;

    bindPanel();

    button.onclick = () => {
      if (typeof window.closeAllToolboxes === "function") window.closeAllToolboxes();
      if (typeof window.setTool === "function") window.setTool("angle");
      reset();
    };

    document.addEventListener("toolChanged", (event) => {
      if (event.detail?.tool !== "angle") first = null;
    });
  }

  window.Inkyscib = window.Inkyscib || {};
  window.Inkyscib.AngleTool = { handleDown, reset, getOverlayState, lineAt, syncPanel };

  document.addEventListener("DOMContentLoaded", init);
})();
