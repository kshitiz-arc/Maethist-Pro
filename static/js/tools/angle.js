// Angle tool: measure an angle, the way the textbook writes it.
//
// Two ways in, chosen by the first tap:
//
//   * Tap a line, then another. The mark lands at the corner they make, on
//     the side of each line you tapped (it used to take the far end of each
//     line, so on an X crossing the mark could land on the wrong corner).
//   * Tap anywhere else: three taps, one arm, the corner, the other arm, as in
//     angle ABC. Taps snap to points and intersections when they are close,
//     and are free otherwise, so it also measures a triangle drawn with the
//     pen, or one in an imported PDF or picture, which the two-line mode never
//     could.
//
// While aiming, the reading follows the pointer. Tapping inside a finished
// mark flips it between the angle and its reflex. A right angle gets the
// square instead of a number, because that is what every textbook draws.
(function () {
  "use strict";

  const C = () => window.Inkyscib?.Construction;
  const G = () => window.Inkyscib?.GeometryEngine;

  // How close a tap has to land on a line to mean that line, for a mouse.
  // geometry-engine.js hitScreenPx scales it up for a pen and a finger.
  const PICK_SCREEN_PX = 14;

  // Radius of the mark, on screen, so it looks the same at every zoom.
  const MARK_SCREEN_RADIUS = 34;

  const POINT_SNAPS = new Set(["point", "intersection", "endpoint", "arc-endpoint", "center"]);

  const IDLE_PROMPT ="Tap a line, then another. Or tap three points: an arm, the corner, the other arm.";

  let first = null;   // { id, a, b, mode, pickedAt } the first line picked
  let taps = [];      // three-point mode: [arm, vertex] so far
  let hover = null;   // where the pointer is, for the live reading
  let lastResult = "";

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

  function pickTolerance(event) {
    const engine = G();
    const px = engine.hitScreenPx ? engine.hitScreenPx(PICK_SCREEN_PX, event) : PICK_SCREEN_PX;
    return engine.screenDistanceToWorld(px, state()?.transform);
  }

  // A measured angle as a student checks it: a constructed 60 degrees is 60,
  // not 59.9. Within 0.05 of a whole degree it is that degree.
  function degreesText(radians) {
    // One rule for the status line and the label on the canvas.
    const shared = window.Inkyscib?.ConstructionRender?.formatDegrees;
    if (shared) return shared(radians);
    const degrees = (radians * 180) / Math.PI;
    const whole = Math.round(degrees);
    if (Math.abs(degrees - whole) < 0.05) return whole + "°";
    return degrees.toFixed(1) + "°";
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

  function lineAt(world, event) {
    const engine = G();
    if (!engine) return null;

    const tolerance = pickTolerance(event);
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
        best = { ...segment, pickedAt: projected.point };
        bestDistance = distance;
      }
    });

    return best;
  }

  function snapAt(world) {
    return C()?.findSnapTarget?.(world, { includeIntersections: true }) || null;
  }

  // A point to tap on: a construction point or an intersection when one is
  // close, otherwise exactly where the finger is.
  function pointAt(world) {
    const snap = snapAt(world);
    return snap && Number.isFinite(snap.x)
      ? { x: snap.x, y: snap.y, snapped: true }
      : { x: world.x, y: world.y, snapped: false };
  }

  // ---------- building the mark ----------

  // Where the two lines actually cross, treating both as infinite. Two segments
  // that form a corner without literally touching still have an angle between
  // them, and that is the common case when a corner is drawn by hand.
  function vertexOf(one, two, event) {
    const engine = G();
    const sharedTolerance = pickTolerance(event);
    for (const a of [one.a, one.b]) {
      for (const b of [two.a, two.b]) {
        if (engine.distance(a, b) <= sharedTolerance) {
          return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        }
      }
    }
    return engine.lineLineIntersection(one.a, one.b, two.a, two.b, { mode: "line" });
  }

  // Each side runs from the vertex toward where that line was tapped, so the
  // mark spans the corner the student pointed at. A tap right on the vertex
  // says nothing about a side, so it falls back to the line's far end.
  function directionFrom(vertex, segment) {
    const engine = G();
    const tiny = engine.screenDistanceToWorld(6, state()?.transform);
    if (segment.pickedAt && engine.distance(vertex, segment.pickedAt) > tiny) {
      return engine.angleOf(vertex, segment.pickedAt);
    }
    const toA = engine.distance(vertex, segment.a);
    const toB = engine.distance(vertex, segment.b);
    const far = toA >= toB ? segment.a : segment.b;
    return engine.angleOf(vertex, far);
  }

  function placeMark(vertex, fromAngle, toAngle, sourceIds) {
    const construction = C();
    const engine = G();
    const radius = engine.screenDistanceToWorld(MARK_SCREEN_RADIUS, state()?.transform);

    if (typeof window.commitHistory === "function") window.commitHistory();
    const mark = construction.createAngle(vertex, fromAngle, toAngle, {
      radius,
      sourceIds,
      color: settings().color,
      size: settings().size,
      showAngle: settings().showText
    });

    if (!mark) {
      setStatus("Could not mark that angle.");
      return null;
    }

    const sweep = engine.arcSweep(mark.startAngle, mark.endAngle);
    // The reading stays until the next angle is started: it used to be
    // replaced by the next prompt in the same tap, before anyone could read it.
    lastResult = "Measured " + degreesText(sweep) + ". Tap inside the mark to flip it to " +
      degreesText(Math.PI * 2 - sweep) + ".";
    setStatus(lastResult);

    if (typeof window.saveDrawing === "function") window.saveDrawing();
    render();
    return mark;
  }

  function commit(one, two, event) {
    const vertex = vertexOf(one, two, event);
    if (!vertex) {
      setStatus("Those two lines are parallel, so there is no angle between them.");
      return false;
    }
    return !!placeMark(vertex, directionFrom(vertex, one), directionFrom(vertex, two), [one.id, two.id]);
  }

  function commitThree(armA, vertex, armB) {
    const engine = G();
    const tiny = engine.screenDistanceToWorld(4, state()?.transform);
    if (engine.distance(armA, vertex) < tiny || engine.distance(armB, vertex) < tiny) {
      setStatus("The arms need to be away from the corner. Tap a little further out.");
      return false;
    }
    return !!placeMark(vertex, engine.angleOf(vertex, armA), engine.angleOf(vertex, armB), null);
  }

  // A finished angle mark under the pointer, for the flip.
  function markAt(world, event, insideOnly) {
    const engine = G();
    const s = state();
    const tolerance = insideOnly ? 0 : pickTolerance(event);
    for (let i = (s?.paths?.length || 0) - 1; i >= 0; i--) {
      const path = s.paths[i];
      if (path?.tool !== "construction" || path.geomType !== "angle") continue;
      const vertex = path.points?.[0];
      if (!vertex) continue;
      const d = engine.distance(world, vertex);
      if (d > (path.radius || 30) + tolerance || d < 1e-6) continue;
      if (engine.angleInArc(engine.angleOf(vertex, world), path.startAngle, path.endAngle)) return path;
    }
    return null;
  }

  function flip(mark) {
    const engine = G();
    if (typeof window.commitHistory === "function") window.commitHistory();
    const start = mark.startAngle;
    mark.startAngle = mark.endAngle;
    mark.endAngle = start;
    const sweep = engine.arcSweep(mark.startAngle, mark.endAngle);
    lastResult = "Flipped to " + degreesText(sweep) + ". Tap inside it again to flip back.";
    setStatus(lastResult);
    if (typeof window.saveDrawing === "function") window.saveDrawing();
    render();
  }

  // ---------- interaction ----------

  function reset() {
    first = null;
    taps = [];
    hover = null;
    cachedPreview = null;
    setStatus(lastResult || IDLE_PROMPT);
    render();
  }

  function handleDown(event) {
    const world = typeof window.getCanvasPos === "function" ? window.getCanvasPos(event) : null;
    if (!world) return false;
    hover = world;
    cachedPreview = null;

    // Three-point mode, already under way.
    if (taps.length) {
      const point = pointAt(world);
      if (taps.length === 1) {
        taps.push(point);
        setStatus("Now tap the other arm.");
        render();
        return true;
      }
      const [armA, vertex] = taps;
      taps = [];
      commitThree(armA, vertex, point);
      render();
      return true;
    }

    // A tap inside a finished mark flips it. Checked before the lines: with a
    // finger's larger reach, the lines that make the corner are within reach
    // of every tap inside a small mark, and would otherwise always win.
    // Not when a point is under the tap: that is the first arm of a new
    // angle (measuring angle B of a triangle starts by tapping A, which sits
    // inside A's own mark).
    const pointUnder = snapAt(world);
    if (!first && !(pointUnder && POINT_SNAPS.has(pointUnder.type))) {
      const mark = markAt(world, event, true);
      if (mark) {
        flip(mark);
        return true;
      }
    }

    const picked = lineAt(world, event);

    // Two-line mode, already under way.
    if (first) {
      if (!picked) {
        setStatus("That missed the line. Tap the second line.");
        return true;
      }
      if (picked.id === first.id) {
        setStatus("Pick a different line for the second side.");
        return true;
      }
      // Consume the pair before committing, so a render or save during commit
      // can never leak the first side into the next angle.
      const chosenFirst = first;
      first = null;
      commit(chosenFirst, picked, event);
      return true;
    }

    // A fresh start. A point wins over the line it sits on: tapping a point
    // means three-point mode. "On the line" is a snap too, but it is the line,
    // so it does not count.
    const found = snapAt(world);
    const snap = found && POINT_SNAPS.has(found.type) ? found : null;
    if (picked && !snap) {
      first = picked;
      lastResult = "";
      setStatus("Now tap the second line.");
      render();
      return true;
    }

    const mark = !snap ? markAt(world, event) : null;
    if (mark) {
      flip(mark);
      return true;
    }

    taps = [pointAt(world)];
    lastResult = "";
    setStatus("Now tap the corner (the vertex).");
    render();
    return true;
  }

  // The live reading while aiming.
  let cachedPreview = null;

  function handleMove(event) {
    if (!first && !taps.length) return false;
    const world = typeof window.getCanvasPos === "function" ? window.getCanvasPos(event) : null;
    if (!world) return false;
    hover = world;
    // Worked out once per move. It snaps and walks every segment, which is
    // too much to repeat on every render of a dense construction.
    cachedPreview = preview();
    render();
    return true;
  }

  function angleBetween(vertex, from, to) {
    const engine = G();
    let start = engine.normalizeAngle(from);
    let end = engine.normalizeAngle(to);
    if (engine.arcSweep(start, end) > Math.PI) {
      const swap = start;
      start = end;
      end = swap;
    }
    return { vertex, start, end, text: degreesText(engine.arcSweep(start, end)) };
  }

  function preview() {
    const engine = G();
    if (!engine || !hover) return null;
    if (taps.length === 2) {
      const [armA, vertex] = taps;
      const target = pointAt(hover);
      if (engine.distance(vertex, target) < 1e-6) return null;
      return angleBetween(vertex, engine.angleOf(vertex, armA), engine.angleOf(vertex, target));
    }
    if (first) {
      const line = lineAt(hover);
      if (!line || line.id === first.id) return null;
      const vertex = vertexOf(first, line);
      if (!vertex) return null;
      return angleBetween(vertex, directionFrom(vertex, first), directionFrom(vertex, line));
    }
    return null;
  }

  function getOverlayState() {
    if (state()?.currentTool !== "angle") return null;
    return {
      firstPicked: first ? { a: first.a, b: first.b, pickedAt: first.pickedAt } : null,
      taps: taps.map((p) => ({ x: p.x, y: p.y })),
      hover: hover && (first || taps.length) ? { x: hover.x, y: hover.y } : null,
      preview: first || taps.length ? cachedPreview : null,
      markRadius: G()?.screenDistanceToWorld(MARK_SCREEN_RADIUS, state()?.transform)
    };
  }

  function selectedAngleMarks() {
    const s = state();
    const indices = window.Inkyscib?.Selection?.selectedIndices?.() || [];
    return indices.map((index) => s?.paths?.[index]).filter((path) => (
      path?.tool === "construction" && path.geomType === "angle"
    ));
  }

  function mutateSelectedAngles(mutate) {
    const marks = selectedAngleMarks();
    if (!marks.length) return false;
    if (typeof window.commitHistory === "function") window.commitHistory();
    marks.forEach(mutate);
    if (typeof window.saveDrawing === "function") window.saveDrawing();
    render();
    return true;
  }

  function syncPanel() {
    const a = settings();
    const selected = selectedAngleMarks();
    const shown = selected[0] || a;
    const size = document.getElementById("angleSize");
    const sizeInput = document.getElementById("angleSizeInput");
    const showText = document.getElementById("angleShowText");
    const picker = document.getElementById("angleCustomColor");

    const shownSize = Number.isFinite(shown.size) ? shown.size : a.size;
    const shownText = selected.length ? selected.every((mark) => mark.showAngle !== false) : a.showText !== false;
    if (size) size.value = shownSize;
    if (sizeInput && document.activeElement !== sizeInput) sizeInput.value = shownSize;
    if (showText) showText.checked = shownText;
    if (picker && shown.color) picker.value = shown.color;

    document.querySelectorAll("[data-angle-color]").forEach((swatch) => {
      const on = (swatch.dataset.angleColor || null) === (shown.color || null);
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
      if (!mutateSelectedAngles((mark) => { mark.size = next; })) {
        settings().size = next;
        saveSettings();
      }
      syncPanel();
    };

    size?.addEventListener("input", () => setSize(size.value));
    sizeInput?.addEventListener("input", () => setSize(sizeInput.value));

    showText?.addEventListener("change", () => {
      if (!mutateSelectedAngles((mark) => { mark.showAngle = showText.checked; })) {
        settings().showText = showText.checked;
        saveSettings();
      }
      syncPanel();
    });

    picker?.addEventListener("input", () => {
      if (!mutateSelectedAngles((mark) => { mark.color = picker.value; })) {
        settings().color = picker.value;
        saveSettings();
      }
      syncPanel();
    });

    document.querySelectorAll("[data-angle-color]").forEach((swatch) => {
      swatch.addEventListener("click", () => {
        const color = swatch.dataset.angleColor || null;
        if (!mutateSelectedAngles((mark) => { mark.color = color; })) {
          settings().color = color;
          saveSettings();
        }
        syncPanel();
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
      if (event.detail?.tool !== "angle") {
        first = null;
        taps = [];
        hover = null;
      }
      syncPanel();
    });
    // Escape abandons an angle half-way through.
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || state()?.currentTool !== "angle" || (!first && !taps.length)) return;
      first = null;
      taps = [];
      setStatus(IDLE_PROMPT);
      render();
    });
    document.addEventListener("selectionChanged", syncPanel);
  }

  window.Inkyscib = window.Inkyscib || {};
  window.Inkyscib.AngleTool = { handleDown, handleMove, reset, getOverlayState, lineAt, syncPanel, degreesText };

  document.addEventListener("DOMContentLoaded", init);
})();
