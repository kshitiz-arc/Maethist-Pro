// What happens to a stroke the moment the pen leaves the page.
//
// This is the second half of write assist, and it exists because the first
// half cannot do this job. The one-euro filter in events.js runs *while* you
// write, which makes it causal: at every sample it has only the past to work
// with. That is what lets it steady a shaky hand without lag, and it is also
// why it can never straighten a line or close a loop — deciding that a stroke
// was "meant to be straight" needs the whole stroke, and the whole stroke does
// not exist until the pen lifts.
//
// So this module runs once, on lift, and does three things the live filter
// cannot:
//
//   1. Snaps a drawn outline to a real shape, promoting it into the geometry
//      objects geometry.js already knows how to draw, measure and edit.
//   2. Tidies handwriting: straightens the runs that were nearly straight and
//      closes the loops that nearly closed.
//   3. Reads digits, and uses the reading only to choose *how* to tidy.
//
// Point 3 is deliberate. A recognised 7 does not become a drawn 7 — nothing
// here ever replaces a letterform with a glyph, because the letterform is the
// part that belongs to the person writing. Recognition only says "this was
// meant to have straight strokes", and the tidy leans accordingly.
//
// Every correction is bounded and reversible: no point moves further than
// `maxShiftFor` allows, and the untouched original is kept so one tap puts it
// back.
(function () {
  "use strict";

  const SETTING_KEY = "inkyscib-write-assist-shapes";

  const TIDY = {
    // A stroke smaller than this is handwriting, not a diagram. Shape snapping
    // is skipped below it, which is what keeps a written 0 from turning into a
    // circle object the moment someone writes a phone number.
    SHAPE_MIN_SIZE: 46,
    // An open stroke must be at least this long before it is looked at as a
    // straight line. 90 was too low: large handwriting reaches it, and a
    // written 1 at 90px was rebuilt as a sampled line with the pen's
    // smoothing switched off (test_with_smoothing_off_handwriting_is_not_
    // tidied). An axis, a segment or an underline is well past 140.
    LINE_MIN_LENGTH: 140,
    // No point of a tidied stroke may sit further than this from the original,
    // as a share of the stroke's diagonal. This is the promise that the
    // handwriting stays yours, expressed as a number a test can check.
    MAX_SHIFT: 0.05,
    MAX_SHIFT_FLOOR: 1.5,
    MAX_SHIFT_CEILING: 14,
    // An almost-straight run is blended toward its fitted line. Runs bendier
    // than this are left alone: they are curves, and straightening a curve is
    // not tidying it.
    STRAIGHT_ENOUGH: 0.06,
    // Ends closer than this share of the stroke's size are pulled together.
    CLOSE_GAP: 0.16,
    // A tidy that moves ink less than this is not worth telling anyone about.
    // Without it the chip fires after every stroke, including the ones that
    // were already clean, and a notice that always fires stops being read.
    WORTH_MENTIONING: 0.75,
    // How long the revert chip stays up.
    CHIP_MS: 5000
  };

  // How hard to tidy, once the digit is known. Strokes made of straight runs
  // want straightening; round ones want their loops closed instead.
  const DIGIT_PROFILES = {
    "1": { straighten: 0.85, close: 0 },
    "4": { straighten: 0.8, close: 0 },
    "7": { straighten: 0.8, close: 0 },
    "2": { straighten: 0.45, close: 0 },
    "5": { straighten: 0.5, close: 0 },
    "3": { straighten: 0.2, close: 0.2 },
    "0": { straighten: 0.1, close: 0.9 },
    "6": { straighten: 0.15, close: 0.6 },
    "8": { straighten: 0.1, close: 0.7 },
    "9": { straighten: 0.15, close: 0.6 }
  };
  const DEFAULT_PROFILE = { straighten: 0.35, close: 0.35 };

  // How many corners each polygon kind has, for promote(). Kinds the
  // recogniser does not return yet are listed so recognising them later is a
  // change to ink-recognize.js alone.
  const POLYGON_VERTEX_COUNTS = {
    triangle: 3,
    rectangle: 4,
    square: 4,
    parallelogram: 4,
    rhombus: 4,
    kite: 4,
    trapezium: 4,
    pentagon: 5,
    hexagon: 6,
    octagon: 8
  };

  function recognizer() {
    return window.Inkyscib?.InkRecognize || null;
  }

  function geometry() {
    return window.Inkyscib?.SmartGeometry || null;
  }

  function appState() {
    return window.appState || null;
  }

  // ---------- the setting ----------
  //
  // Three steps, not a switch:
  //   0  Off       every stroke stays ink.
  //   1  Straight  the figure you meant: a leaning square becomes a square,
  //                square to the page, and a long straight stroke a straight
  //                line.
  //   2  Exact     the figure you drew: a rhombus stays a rhombus, a tilted
  //                box stays tilted, and an outline with no name keeps its
  //                corners with straight edges between them.
  //
  // Stored under the key the old on/off switch used. Its "1" meant on, and
  // Straight is the step that replaces it, so an old setting needs no
  // migration: "0" and "1" already mean what they meant.
  const LEVELS = [
    { level: 0, name: "Off", hint: "Everything you draw stays ink." },
    {
      level: 1,
      name: "Straight",
      hint: "Tidies what you meant: a wobbly square becomes a true square, straight to the page."
    },
    {
      level: 2,
      name: "Exact",
      hint: "Keeps what you drew: straight edges and clean curves, every corner where you put it."
    }
  ];
  const DEFAULT_LEVEL = 1;
  // What the top-bar button turns back on to. Off is one tap from anything,
  // and on is the step you last chose rather than a default you did not.
  const LAST_LEVEL_KEY = "inkyscib-write-assist-shapes-last";

  let currentLevel = null;

  function readStored(key) {
    try {
      return window.localStorage.getItem(key);
    } catch (error) {
      // Private browsing and blocked site data both throw here. Assist is a
      // convenience, so it defaults on and simply stops persisting.
      return null;
    }
  }

  function writeStored(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch (error) {
      /* not persisting is survivable; the setting still holds for this session */
    }
  }

  function clampLevel(value) {
    const number = Math.round(Number(value));
    return Number.isFinite(number) ? Math.max(0, Math.min(2, number)) : DEFAULT_LEVEL;
  }

  function level() {
    if (currentLevel === null) {
      const stored = readStored(SETTING_KEY);
      currentLevel = stored === null ? DEFAULT_LEVEL : clampLevel(stored);
    }
    return currentLevel;
  }

  function setLevel(value) {
    currentLevel = clampLevel(value);
    writeStored(SETTING_KEY, String(currentLevel));
    if (currentLevel > 0) writeStored(LAST_LEVEL_KEY, String(currentLevel));
    syncToggle();
    return currentLevel;
  }

  function lastOnLevel() {
    const stored = readStored(LAST_LEVEL_KEY);
    const value = stored === null ? DEFAULT_LEVEL : clampLevel(stored);
    return value > 0 ? value : DEFAULT_LEVEL;
  }

  // The on/off vocabulary the rest of the app and the tests already speak.
  function isEnabled() {
    return level() > 0;
  }

  function setEnabled(value) {
    setLevel(value ? lastOnLevel() : 0);
    return isEnabled();
  }

  // ---------- geometry helpers ----------

  function distance(a, b) {
    return Math.hypot(b.x - a.x, b.y - a.y);
  }

  function boundsOf(points) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const point of points) {
      if (point.x < minX) minX = point.x;
      if (point.y < minY) minY = point.y;
      if (point.x > maxX) maxX = point.x;
      if (point.y > maxY) maxY = point.y;
    }
    if (!Number.isFinite(minX)) return null;
    return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
  }

  // reach is ink-smooth.js tidyReach: 1 through Strong, so this promise is
  // unchanged across the old range, and up to 1.6 at the top of the slider.
  function maxShiftFor(bounds, reach = 1) {
    const diagonal = Math.hypot(bounds.width, bounds.height);
    return Math.min(
      Math.max(diagonal * TIDY.MAX_SHIFT, TIDY.MAX_SHIFT_FLOOR),
      TIDY.MAX_SHIFT_CEILING
    ) * reach;
  }

  function assistSetting() {
    return window.appState?.toolSettings?.pen?.smoothing;
  }

  function assistReach() {
    const reach = window.Inkyscib?.InkSmooth?.tidyReach;
    return typeof reach === "function" ? reach(assistSetting()) : 1;
  }

  /** Closest point to `point` anywhere on the polyline, segments included. */
  function nearestOnPolyline(point, polyline) {
    let best = null;
    let bestDistance = Infinity;
    for (let i = 1; i < polyline.length; i += 1) {
      const from = polyline[i - 1];
      const to = polyline[i];
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const lengthSquared = dx * dx + dy * dy;
      let t = 0;
      if (lengthSquared > 0) {
        t = ((point.x - from.x) * dx + (point.y - from.y) * dy) / lengthSquared;
        t = Math.max(0, Math.min(1, t));
      }
      const candidate = { x: from.x + dx * t, y: from.y + dy * t };
      const d = distance(point, candidate);
      if (d < bestDistance) {
        bestDistance = d;
        best = candidate;
      }
    }
    return best ? { point: best, distance: bestDistance } : null;
  }

  /**
   * Pull every sample back until it is within `limit` of the original stroke.
   *
   * This is what makes "keeps your handwriting" checkable rather than a claim:
   * however the tidy below is tuned, the result provably stays inside a band
   * around what was actually drawn.
   */
  function clampToOriginal(samples, original, limit) {
    return samples.map((sample) => {
      const nearest = nearestOnPolyline(sample, original);
      if (!nearest || nearest.distance <= limit) return sample;
      const ratio = limit / nearest.distance;
      return {
        ...sample,
        x: nearest.point.x + (sample.x - nearest.point.x) * ratio,
        y: nearest.point.y + (sample.y - nearest.point.y) * ratio
      };
    });
  }

  // ---------- the tidy ----------

  /**
   * Straighten the runs that were nearly straight, then close a near-closed
   * loop, then hold everything inside the displacement bound.
   *
   * Corners are found first and never smoothed across: the sharp turn in a 4
   * or a 7 is the letterform, not noise, and rounding it off is exactly the
   * "improvement" that makes handwriting stop looking like the writer's.
   */
  function tidy(points, profile) {
    const ink = recognizer();
    if (!ink || !Array.isArray(points) || points.length < 4) return null;

    const bounds = boundsOf(points);
    if (!bounds) return null;
    const size = Math.max(bounds.width, bounds.height);
    if (!(size > 0)) return null;

    // Resample so the fits below are not dominated by wherever the hand
    // slowed; keep roughly the original detail level.
    const target = Math.max(12, Math.min(160, Math.round(points.length)));
    let samples = ink.resample(points, target);
    const corners = ink.detectCorners(samples, false);

    if (profile.straighten > 0) {
      samples = straightenRuns(ink, samples, corners, profile.straighten);
    }
    if (profile.close > 0) {
      samples = closeLoop(samples, size, profile.close);
    }

    return clampToOriginal(samples, points, maxShiftFor(bounds, assistReach()));
  }

  /**
   * Blend each run between corners toward the straight line fitted through it,
   * but only when the run was nearly straight to begin with.
   */
  function straightenRuns(ink, samples, corners, strength) {
    const breaks = [0, ...corners.filter((i) => i > 0 && i < samples.length - 1), samples.length - 1];
    const output = samples.map((sample) => ({ ...sample }));

    for (let i = 1; i < breaks.length; i += 1) {
      const from = breaks[i - 1];
      const to = breaks[i];
      if (to - from < 3) continue;

      const run = samples.slice(from, to + 1);
      if (ink.edgeStraightness(run) > TIDY.STRAIGHT_ENOUGH) continue;

      const line = ink.fitLine(run);
      if (!line) continue;

      // Project onto the fitted line, then move only part of the way there, so
      // the result is steadier without becoming mechanical.
      for (let j = from; j <= to; j += 1) {
        const sample = samples[j];
        const offset = line.normal.x * sample.x + line.normal.y * sample.y - line.offset;
        output[j].x = sample.x - line.normal.x * offset * strength;
        output[j].y = sample.y - line.normal.y * offset * strength;
      }
    }
    return output;
  }

  /** Draw the two ends together when they nearly met. */
  function closeLoop(samples, size, strength) {
    if (samples.length < 4) return samples;
    const first = samples[0];
    const last = samples[samples.length - 1];
    const gap = distance(first, last);
    if (!(gap > 0) || gap / size > TIDY.CLOSE_GAP) return samples;

    const midX = (first.x + last.x) / 2;
    const midY = (first.y + last.y) / 2;
    const output = samples.map((sample) => ({ ...sample }));
    output[0].x = first.x + (midX - first.x) * strength;
    output[0].y = first.y + (midY - first.y) * strength;
    output[output.length - 1].x = last.x + (midX - last.x) * strength;
    output[output.length - 1].y = last.y + (midY - last.y) * strength;
    return output;
  }

  // ---------- promotion ----------

  /**
   * Turn a recognised outline into one of geometry.js' own objects.
   *
   * Returns the new path, or null if geometry.js would not build it. Going
   * through createShapePath rather than hand-rolling a shape record is what
   * gets the vertices, measurements, inspector and construction points for
   * free — and keeps this module from having a second opinion about what a
   * triangle is.
   */
  function promote(path, shape) {
    const smart = geometry();
    if (!smart?.createShapePath) return null;

    const settings = {
      size: path.size,
      color: path.color,
      // The stroke already says where it goes. Snapping it to the grid or to
      // nearby objects here would move it away from what was drawn.
      snapToGrid: false,
      snapToObjects: false
    };

    if (shape.kind === "circle") {
      const created = smart.createShapePath("circle", shape.center, settings);
      if (!created || !smart.setCircleGeometry) return null;
      smart.setCircleGeometry(created, shape.center, shape.radius);
      return created;
    }

    if (shape.kind === "ellipse") {
      const created = smart.createShapePath("ellipse", shape.center, settings);
      if (!created || !smart.setEllipseGeometry) return null;
      smart.setEllipseGeometry(created, shape.center, shape.rx, shape.ry, shape.rotation);
      delete created.draftStart;
      if (smart.normalizeSmartGeometry) smart.normalizeSmartGeometry(created);
      return created;
    }

    // Every polygon kind is one table row, so a kind geometry.js learns to
    // build can be recognised without restructuring this. A kind it cannot
    // build makes createShapePath return null below, and the stroke stays ink.
    const vertices = shape.vertices || [];
    const expected = POLYGON_VERTEX_COUNTS[shape.kind];
    if (!expected || vertices.length !== expected) return null;

    const center = {
      x: vertices.reduce((sum, vertex) => sum + vertex.x, 0) / vertices.length,
      y: vertices.reduce((sum, vertex) => sum + vertex.y, 0) / vertices.length
    };
    const created = smart.createShapePath(shape.kind, center, {
      ...settings,
      triangleType: shape.triangleType
    });
    if (!created) return null;

    created.points = vertices.map((vertex) => ({ x: vertex.x, y: vertex.y }));
    // draftStart is a drag artefact; leaving it makes the shape think it is
    // still being drawn.
    delete created.draftStart;
    if (shape.kind === "triangle") {
      created.triangleType = shape.triangleType || "custom";
      // A right triangle keeps its right angle at index 1, locked, exactly as
      // the Shape tool makes one; interpretShape already ordered it there.
      // Without the lock the first corner drag would quietly lose the 90°.
      created.angleMarks = [false, created.triangleType === "right", false];
      created.lockedAngles = [null, created.triangleType === "right" ? Math.PI / 2 : null, null];
    }
    if (smart.normalizeSmartGeometry) smart.normalizeSmartGeometry(created);
    if (smart.isMeaningfulShape && !smart.isMeaningfulShape(created)) return null;
    return created;
  }

  /**
   * Straight-edged ink through exact corners, for a figure with no name.
   *
   * An irregular quadrilateral or a five-sided outline that is not a regular
   * pentagon is still a drawing with straight sides. It stays ink -- there is
   * no geometry kind that would keep it as drawn -- but its edges come out
   * straight and its corners sharp, where the pen actually turned. Pressure
   * is the stroke's own median, so it reads as the same pen.
   */
  function straightInk(path, corners, closed) {
    const original = path.points || [];
    if (corners.length < 2 || !original.length) return null;
    const pressures = original
      .map((point) => point.pressure)
      .filter((value) => Number.isFinite(value))
      .sort((a, b) => a - b);
    const pressure = pressures.length ? pressures[Math.floor(pressures.length / 2)] : 0.5;
    const firstTime = Number(original[0].time) || 0;
    const lastTime = Number(original[original.length - 1].time) || firstTime;

    const runs = closed ? corners.concat([corners[0]]) : corners;
    let total = 0;
    for (let i = 1; i < runs.length; i += 1) total += distance(runs[i - 1], runs[i]);
    if (!(total > 0)) return null;

    // A sample every few pixels: the pen renderer draws a smooth curve
    // through its points, so sparse samples would round the corners off.
    const STEP = 4;
    const out = [];
    let travelled = 0;
    for (let i = 1; i < runs.length; i += 1) {
      const a = runs[i - 1];
      const b = runs[i];
      const length = distance(a, b);
      const steps = Math.max(1, Math.round(length / STEP));
      for (let k = i === 1 ? 0 : 1; k <= steps; k += 1) {
        const t = k / steps;
        const along = travelled + length * t;
        out.push({
          x: a.x + (b.x - a.x) * t,
          y: a.y + (b.y - a.y) * t,
          pressure,
          time: firstTime + (lastTime - firstTime) * (along / total)
        });
      }
      travelled += length;
    }
    return out;
  }

  // ---------- the hook ----------

  let lastCorrection = null;

  /**
   * Called once per finished pen stroke, from endDrawing.
   *
   * Returns the path that should stand in the document — the promoted shape
   * when one was recognised, otherwise the same path object, tidied in place.
   * Returning the path rather than mutating a global lets endDrawing carry on
   * dispatching to whichever subsystem now owns it.
   */
  function assist(path, index) {
    if (!path || path.tool !== "pen") return null;
    if (path.penStyle && path.penStyle !== "default") return null;

    const ink = recognizer();
    const state = appState();
    if (!ink || !state || !Array.isArray(state.paths)) return null;
    if (state.paths[index] !== path) return null;

    const points = (path.points || []).filter(
      (point) => point && Number.isFinite(point.x) && Number.isFinite(point.y)
    );
    if (points.length < 4) return null;

    const bounds = boundsOf(points);
    if (!bounds) return null;
    const size = Math.max(bounds.width, bounds.height);
    const original = points.map((point) => ({ ...point }));

    // A big closed outline is a diagram, and a long straight stroke is a line
    // in one. With shape assist on, try to make it a real shape first; with
    // it off, every stroke stays ink.
    const assistLevel = level();
    if (assistLevel > 0 && size >= TIDY.SHAPE_MIN_SIZE && ink.analyzeShape) {
      // Lines are only looked for above LINE_MIN_LENGTH: a written 1, l or 7
      // is an open straight stroke too, and they are well under it.
      const analysis = ink.analyzeShape(points, {
        lines: strokeLength(points) >= TIDY.LINE_MIN_LENGTH
      });
      const shape = analysis && ink.interpretShape(analysis, assistLevel);

      if (shape && (shape.kind === "polyline" || shape.kind === "line")) {
        const corners = shape.kind === "line" ? [shape.a, shape.b] : shape.vertices;
        const straightened = straightInk(path, corners, shape.kind === "polyline");
        if (straightened) {
          path.points = straightened;
          remember({ index, original: { ...path, points: original }, replacement: path });
          showChip(shape.kind === "line" ? "Straight line" : "Straightened");
          repaint();
          return path;
        }
      }

      const promoted = shape && promote(path, shape);
      if (promoted) {
        state.paths[index] = promoted;
        remember({ index, original: path, replacement: promoted });
        showChip(shapeName(shape), { shape: true });
        repaint();
        return promoted;
      }
    }

    // Otherwise tidy it, letting a recognised digit choose how. The tidy is a
    // kind of smoothing, so it follows the pen's smoothing setting: Off means
    // the ink is left exactly as it was drawn.
    // A number since the slider: `=== "off"` would miss a stored 0 and tidy
    // strokes for someone who had switched assist off.
    // smoothLevel, not `level`: a local of that name shadowed the shape-assist
    // level() for the whole of this function, so calling it above threw.
    const smoothLevel = window.Inkyscib?.InkSmooth?.assistLevel;
    const setting = state.toolSettings?.pen?.smoothing;
    if (setting === "off" || (typeof smoothLevel === "function" && smoothLevel(setting) === 0)) return null;
    const reading = ink.recognizeDigit([points]);
    const profile = (reading && DIGIT_PROFILES[reading.digit]) || DEFAULT_PROFILE;
    const tidied = tidy(points, profile);
    if (!tidied || !movedEnoughToMention(original, tidied)) return null;

    path.points = tidied;
    remember({ index, original: { ...path, points: original }, replacement: path });
    showChip(reading ? "Tidied " + reading.digit : "Tidied");
    repaint();
    return path;
  }

  /**
   * Did the tidy actually change anything a person would see?
   *
   * Without this the chip appears after every stroke, including the ones that
   * were already clean, and a correction notice that fires constantly stops
   * being read.
   */
  function movedEnoughToMention(original, tidied) {
    let worst = 0;
    for (const sample of tidied) {
      const nearest = nearestOnPolyline(sample, original);
      if (nearest) worst = Math.max(worst, nearest.distance);
    }
    return worst >= TIDY.WORTH_MENTIONING;
  }

  /**
   * What the chip calls the result. The triangle's type is named because it
   * is the part assist decided: "Right triangle" says the corner was squared.
   */
  function shapeName(shape) {
    const kind = typeof shape === "string" ? shape : shape?.kind;
    if (kind === "triangle" && shape?.triangleType && shape.triangleType !== "custom") {
      const type = shape.triangleType;
      return type.charAt(0).toUpperCase() + type.slice(1) + " triangle";
    }
    const text = String(kind || "shape");
    return text.charAt(0).toUpperCase() + text.slice(1);
  }

  function strokeLength(points) {
    let total = 0;
    for (let i = 1; i < points.length; i += 1) total += distance(points[i - 1], points[i]);
    return total;
  }

  /**
   * Open the snapped shape's own settings: the Select tool with that shape
   * selected, which is what drawing with the Shape tool ends in. Only ever on
   * request - doing it on every snap took the pen out of the writer's hand.
   */
  function editLast() {
    const state = appState();
    const correction = lastCorrection;
    if (!correction || !state?.paths) return false;
    const { index, replacement } = correction;
    lastCorrection = null;
    hideChip();
    if (state.paths[index] !== replacement || replacement?.tool !== "shape") return false;
    geometry()?.afterPathCreated?.(replacement, index);
    return true;
  }

  function remember(correction) {
    lastCorrection = correction;
  }

  function repaint() {
    if (typeof window.requestRedraw === "function") window.requestRedraw();
    else if (typeof window.render === "function") window.render();
  }

  /**
   * Persisting is deliberately NOT done by `assist`.
   *
   * endDrawing saves once, straight after calling us, and a save serialises
   * the whole document to localStorage and IndexedDB — doing it twice on every
   * stroke would double that cost for nothing. Reverting happens outside that
   * flow, so it has to save for itself.
   */
  function persist() {
    if (typeof window.saveDrawing === "function") window.saveDrawing();
  }

  /** Put the stroke back exactly as it was drawn. */
  function revertLast() {
    const state = appState();
    if (!lastCorrection || !state?.paths) return false;

    const { index, original, replacement } = lastCorrection;
    // Anything could have happened since — an undo, an erase, another stroke.
    // Only put the original back if what we changed is still sitting there.
    if (state.paths[index] !== replacement) {
      lastCorrection = null;
      hideChip();
      return false;
    }

    state.paths[index] = original;
    lastCorrection = null;
    hideChip();
    repaint();
    persist();
    return true;
  }

  // ---------- the chip ----------

  let chip = null;
  let chipTimer = null;

  function ensureChip() {
    if (chip) return chip;
    chip = document.createElement("div");
    chip.className = "write-assist-chip";
    chip.hidden = true;
    // Announced politely so a screen-reader user hears that the stroke changed
    // and that there is a way back, without interrupting what they are doing.
    chip.setAttribute("role", "status");
    chip.setAttribute("aria-live", "polite");

    const label = document.createElement("span");
    label.className = "write-assist-chip-label";

    // Only a snapped shape has settings worth opening, so Edit shows for those.
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "write-assist-chip-edit";
    edit.textContent = "Edit";
    edit.hidden = true;
    edit.addEventListener("click", () => editLast());

    const undo = document.createElement("button");
    undo.type = "button";
    undo.className = "write-assist-chip-undo";
    undo.textContent = "Undo";
    undo.addEventListener("click", () => revertLast());

    chip.append(label, edit, undo);
    document.body.appendChild(chip);
    return chip;
  }

  function showChip(text, { shape = false } = {}) {
    const element = ensureChip();
    element.querySelector(".write-assist-chip-label").textContent = text;
    element.querySelector(".write-assist-chip-edit").hidden = !shape;
    // After a snap the choice is between the shape and the ink it came from;
    // after a tidy it is just taking the change back.
    element.querySelector(".write-assist-chip-undo").textContent = shape ? "Keep as ink" : "Undo";
    element.hidden = false;
    if (chipTimer) window.clearTimeout(chipTimer);
    chipTimer = window.setTimeout(hideChip, TIDY.CHIP_MS);
  }

  function hideChip() {
    if (chipTimer) {
      window.clearTimeout(chipTimer);
      chipTimer = null;
    }
    if (chip) chip.hidden = true;
  }

  // ---------- the toggle ----------

  // Two controls, one setting. The pen panel's slider chooses the step; the
  // top bar's button beside Undo and Redo is the quick way out and back --
  // Off, then the step you last chose. Both reflect the stored value rather
  // than their own last input, so they cannot drift apart.

  // The preview's three sample outlines, drawn the way a hand draws them: a
  // square leaning 16°, a right triangle a little off square, an oval that
  // was meant to be a circle. Deterministic, so the preview never flickers.
  function previewSamples() {
    const wobble = (points, seed) => points.map((p, i) => ({
      x: p.x + Math.sin(i * 1.7 + seed) * 2.2,
      y: p.y + Math.cos(i * 1.3 + seed) * 2.2
    }));
    const outline = (corners, per) => {
      const out = [];
      corners.forEach((a, i) => {
        const b = corners[(i + 1) % corners.length];
        for (let k = 0; k < per; k += 1) {
          out.push({ x: a.x + (b.x - a.x) * k / per, y: a.y + (b.y - a.y) * k / per });
        }
      });
      out.push({ ...corners[0] });
      return out;
    };
    const lean = Math.tan(16 * Math.PI / 180);
    const square = [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 200 }, { x: 0, y: 200 }]
      .map((p) => ({ x: p.x + (200 - p.y) * lean - 30, y: p.y + (p.x > 100 ? 8 : -6) }));
    const triangle = [{ x: 10, y: 0 }, { x: -6, y: 200 }, { x: 230, y: 188 }];
    const oval = [];
    for (let i = 0; i <= 48; i += 1) {
      const t = i / 48 * Math.PI * 2;
      oval.push({ x: 100 + Math.cos(t) * 112, y: 100 + Math.sin(t) * 94 });
    }
    return [
      wobble(outline(square, 16), 0.4),
      wobble(outline(triangle, 16), 1.9),
      wobble(oval, 3.1)
    ];
  }

  let previewCache = null;

  // One sample is 200-ish world units; each preview slot is 44 wide and tall.
  function previewTransform(points, slot) {
    const bounds = boundsOf(points);
    const size = Math.max(bounds.width, bounds.height) || 1;
    const scale = 40 / size;
    const midX = bounds.minX + bounds.width / 2;
    const midY = bounds.minY + bounds.height / 2;
    const cx = 36 + slot * 74;
    return (p) => ({ x: cx + (p.x - midX) * scale, y: 28 + (p.y - midY) * scale });
  }

  function svgPath(points, closed) {
    if (!points.length) return "";
    const head = `M${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)}`;
    const body = points.slice(1).map((p) => `L${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join("");
    return head + body + (closed ? "Z" : "");
  }

  /** What the recogniser makes of a sample at a level, as an SVG path. */
  function previewShape(sample, stepLevel, map) {
    const ink = recognizer();
    const shape = stepLevel > 0 && ink?.analyzeShape
      ? ink.interpretShape(ink.analyzeShape(sample), stepLevel)
      : null;
    if (!shape) return svgPath(sample.map(map), false);
    if (shape.kind === "circle" || shape.kind === "ellipse") {
      const rx = shape.kind === "circle" ? shape.radius : shape.rx;
      const ry = shape.kind === "circle" ? shape.radius : shape.ry;
      const turn = shape.rotation || 0;
      const ring = [];
      for (let i = 0; i < 48; i += 1) {
        const t = i / 48 * Math.PI * 2;
        const x = Math.cos(t) * rx;
        const y = Math.sin(t) * ry;
        ring.push(map({
          x: shape.center.x + x * Math.cos(turn) - y * Math.sin(turn),
          y: shape.center.y + x * Math.sin(turn) + y * Math.cos(turn)
        }));
      }
      return svgPath(ring, true);
    }
    return svgPath((shape.vertices || []).map(map), true);
  }

  function renderPreview(stepLevel) {
    const ghost = document.getElementById("shapeAssistGhost");
    const inkLayer = document.getElementById("shapeAssistPreview");
    if (!ghost || !inkLayer) return;
    if (!previewCache) previewCache = previewSamples();
    const ghostPaths = [];
    const inkPaths = [];
    previewCache.forEach((sample, slot) => {
      const map = previewTransform(sample, slot);
      ghostPaths.push(`<path d="${svgPath(sample.map(map), false)}"/>`);
      inkPaths.push(`<path d="${previewShape(sample, stepLevel, map)}"/>`);
    });
    // At Off the result IS the drawing, so the faint copy underneath would
    // only thicken it.
    ghost.innerHTML = stepLevel > 0 ? ghostPaths.join("") : "";
    inkLayer.innerHTML = inkPaths.join("");
  }

  function syncToggle() {
    const current = level();
    const on = current > 0;
    const step = LEVELS[current];

    const button = document.getElementById("shapeAssistBtn");
    if (button) {
      button.classList.toggle("active", on);
      button.setAttribute("aria-pressed", on ? "true" : "false");
      button.title = on ? `Shape assist: ${step.name}. Tap to turn off.` : "Shape assist: off. Tap to turn on.";
    }

    const slider = document.getElementById("shapeAssistLevel");
    if (slider) {
      slider.value = String(current);
      slider.setAttribute("aria-valuetext", step.name);
      slider.style.setProperty("--assist-fill", `${current * 50}%`);
    }
    const name = document.getElementById("shapeAssistName");
    if (name) name.textContent = step.name;
    const hint = document.getElementById("shapeAssistHintText");
    if (hint) hint.textContent = step.hint;
    document.querySelectorAll("#shapeAssistSpectrum [data-stop]").forEach((stop) => {
      stop.classList.toggle("is-here", Number(stop.dataset.stop) === current);
    });
    renderPreview(current);
  }

  function bindToggle() {
    const button = document.getElementById("shapeAssistBtn");
    if (button) {
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        setEnabled(!isEnabled());
      });
    }
    const slider = document.getElementById("shapeAssistLevel");
    if (slider) {
      // Three stops, so every input is a real choice: commit as it moves
      // rather than waiting for release, and the preview keeps up.
      slider.addEventListener("input", () => setLevel(slider.value));
    }
    syncToggle();
  }

  document.addEventListener("DOMContentLoaded", bindToggle);
  // setTool clears `.active` from every `.tool` button, and the top-bar switch
  // is one, so it would go dark on every tool change without this.
  document.addEventListener("toolChanged", syncToggle);
  document.addEventListener("panModeChanged", syncToggle);

  window.Inkyscib = window.Inkyscib || {};
  window.Inkyscib.Handwriting = {
    assist,
    revertLast,
    isEnabled,
    setEnabled,
    level,
    setLevel,
    LEVELS,
    TIDY,
    // exported for tests
    tidy,
    promote,
    nearestOnPolyline,
    maxShiftFor,
    DIGIT_PROFILES,
    DEFAULT_PROFILE
  };
})();
