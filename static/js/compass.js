// Compass tool: interaction controller and state machine.
//
// Explicit states rather than scattered event handlers (spec §31):
//
//   IDLE ── activate ──> SELECT_CENTER ──> SELECT_RADIUS ──> READY
//                             ^                                │
//                             │                        pointerdown
//                             │                                v
//                        (re-arm)                          SWEEPING
//                             │                                │
//                             └────────── commit arc ──────────┘
//
// The radius is stored once and never recomputed from the cursor, which is
// what makes "copy this distance elsewhere" exact (spec §6): moving the centre
// changes `centerPointId` and nothing else.
(function () {
  "use strict";

  const G = () => window.Inkyscib?.GeometryEngine;
  const C = () => window.Inkyscib?.Construction;

  const STATES = {
    IDLE: "IDLE",
    SELECT_CENTER: "SELECT_CENTER",
    SELECT_RADIUS: "SELECT_RADIUS",
    READY: "READY",
    SWEEPING: "SWEEPING",
    EXTENDING: "EXTENDING"
  };

  // How close a press has to land on an arc's own end before it means
  // "carry this arc on" rather than "start a new one here".
  const EXTEND_GRAB_SCREEN_PX = 12;

  // Tapping an arc's curve reopens it. Deliberately wider than the end grab:
  // this is the forgiving gesture, the endpoints are the precise one.
  const ARC_BODY_GRAB_SCREEN_PX = 14;

  // Below this world distance a drag is treated as a tap, so touch users get
  // click-click sweeping instead of being forced to drag precisely.
  const DRAG_SLOP_PX = 4;

  const compassState = {
    phase: STATES.IDLE,
    centerPointId: null,
    center: null,
    radius: null,
    radiusFromId: null, // the two points that defined the radius; the display
    radiusToId: null,   // label is derived from them so renames stay in step
    mode: "arc",
    lastArcGid: null,   // the arc just drawn; drives the New arc affordance
    startAngle: null,
    endAngle: null,
    cursor: null,
    snap: null,
    selectedPointId: null,
    pendingDown: null,
    sweepAccum: 0,     // signed radians swept, so the arc follows the drag direction
    lastAngle: null,
    tapSweep: false,   // sweeping started by a tap, waiting for a second tap
    measuring: false,  // dragging the compass open
    color: null,       // ink colour for arcs drawn next
    showAngle: false,  // write the swept angle on arcs drawn next
    extend: null,      // { gid, end: 'start'|'end', armed } while stretching an arc
    intersections: []
  };

  let statusTimer = null;

  function state() {
    return window.appState;
  }

  function transform() {
    return state()?.transform || { scale: 1, offsetX: 0, offsetY: 0 };
  }

  function render() {
    if (typeof window.render === "function") window.render();
  }

  function save() {
    if (typeof window.saveDrawing === "function") window.saveDrawing();
  }

  function commitHistory() {
    if (typeof window.commitHistory === "function") window.commitHistory();
  }

  // ---------- unit display (spec §20) ----------
  //
  // geometry.js works in world units with DEFAULT_UNIT_SCALE = 32 world units
  // per notebook unit. No physical scale is claimed, so lengths are reported
  // in those units rather than pretending pixels are centimetres.
  const WORLD_UNITS_PER_UNIT = 32;
  // The unit's display name is shared across every tool that measures
  // something; see static/js/units.js. Falls back to "u" so a label never
  // comes out with a bare number if this module loads first.
  function unitLabel(squared) {
    return window.Inkyscib?.Units?.label({ squared: !!squared }) || (squared ? "u\u00b2" : "u");
  }


  function formatLength(worldLength) {
    const engine = G();
    if (!engine || !engine.isFiniteNumber(worldLength)) return "—";
    const units = worldLength / WORLD_UNITS_PER_UNIT;
    return `${units.toFixed(2)} ${unitLabel()}`;
  }

  // ---------- status line ----------

  function setStatus(message, transient = false) {
    const element = document.getElementById("compassStatus");
    if (!element) return;
    element.textContent = message || "";
    if (statusTimer) {
      window.clearTimeout(statusTimer);
      statusTimer = null;
    }
    if (transient && message) {
      statusTimer = window.setTimeout(() => {
        statusTimer = null;
        syncPanel();
      }, 2600);
    }
  }

  const PHASE_HINTS = {
    [STATES.SELECT_CENTER]: "Tap a point to place the compass needle.",
    [STATES.SELECT_RADIUS]: "Drag out from the centre to open the compass.",
    [STATES.READY]: "Drag to sweep an arc, or tap once to start and again to finish.",
    [STATES.SWEEPING]: "Release to place the arc.",
    [STATES.EXTENDING]: "Drag the end round to extend the arc."
  };

  const PHASE_STEP = {
    [STATES.IDLE]: "center",
    [STATES.SELECT_CENTER]: "center",
    [STATES.SELECT_RADIUS]: "radius",
    [STATES.READY]: "draw",
    [STATES.SWEEPING]: "draw",
    [STATES.EXTENDING]: "draw"
  };

  // The label box edits whichever point the student last touched: an
  // intersection they just promoted, or failing that the compass centre.
  function labelTargetId() {
    const construction = C();
    if (compassState.selectedPointId && construction?.get(compassState.selectedPointId)) {
      return compassState.selectedPointId;
    }
    return compassState.centerPointId;
  }

  function renameSelectedPoint(rawValue) {
    const construction = C();
    const target = labelTargetId();
    const path = target ? construction?.get(target) : null;
    if (!path) return false;

    const value = String(rawValue || "").trim().slice(0, 4);
    if (!value) return false;
    if (value === path.label) return true;

    const taken = construction.allPoints()
      .some((point) => point !== path && point.label === value);
    if (taken) {
      setStatus(`Point ${value} already exists.`, true);
      return false;
    }

    commitHistory();
    path.label = value;
    save();
    render();
    return true;
  }

  // Derived, never cached: renaming a point must update the radius readout
  // rather than leaving the name it had when the distance was measured.
  function radiusSourceLabel() {
    const construction = C();
    const from = compassState.radiusFromId ? construction?.get(compassState.radiusFromId) : null;
    const to = compassState.radiusToId ? construction?.get(compassState.radiusToId) : null;
    // a radius measured to open canvas has no second label to show
    if (!from || !to) return null;
    return `${from.label || "?"}${to.label || "?"}`;
  }

  // Typing an exact radius is often faster than dragging one, and it is the
  // only way to reproduce a value a textbook gives you. Entered in the same
  // display units the readout shows.
  function setRadiusUnits(rawValue) {
    const engine = G();
    const units = Number.parseFloat(rawValue);
    if (!engine || !Number.isFinite(units) || units <= 0) return false;

    const world = units * WORLD_UNITS_PER_UNIT;
    if (!engine.isFiniteNumber(world) || world <= engine.POINT_TOLERANCE) return false;

    commitHistory();
    compassState.radius = world;
    // a typed radius has no defining pair of points any more
    compassState.radiusFromId = compassState.centerPointId;
    compassState.radiusToId = null;
    if (compassState.centerPointId) compassState.phase = STATES.READY;
    syncPanel();
    save();
    render();
    return true;
  }

  // Preferences are restored from IndexedDB asynchronously and routinely land
  // after initCompass has run, so the saved arc colour is re-adopted whenever
  // the panel syncs rather than only once at startup. Without this the colour
  // survived in storage but never reached the arcs after a reload.
  function adoptSavedColor() {
    const saved = state()?.toolSettings?.compass?.color || null;
    if (saved === compassState.color) return;
    setColor(saved, { save: false });
  }

  function syncPanel() {
    adoptSavedColor();
    adoptSavedShowAngle();
    const construction = C();
    const centerPath = compassState.centerPointId ? construction?.get(compassState.centerPointId) : null;

    const centerField = document.getElementById("compassCenterValue");
    if (centerField) centerField.textContent = centerPath?.label || "—";

    const radiusField = document.getElementById("compassRadiusValue");
    if (radiusField) {
      const source = radiusSourceLabel();
      radiusField.textContent = compassState.radius
        ? `${source ? source + "  " : ""}${formatLength(compassState.radius)}`
        : "—";
    }

    const radiusInput = document.getElementById("compassRadiusInput");
    if (radiusInput && document.activeElement !== radiusInput) {
      radiusInput.value = compassState.radius
        ? (compassState.radius / WORLD_UNITS_PER_UNIT).toFixed(2)
        : "";
    }

    const labelInput = document.getElementById("compassPointLabel");
    if (labelInput && document.activeElement !== labelInput) {
      const target = labelTargetId();
      const path = target ? construction?.get(target) : null;
      labelInput.value = path?.label || "";
      labelInput.disabled = !path;
    }
    const hint = document.getElementById("compassLabelHint");
    if (hint) {
      const target = labelTargetId();
      hint.textContent = target ? "Rename this point" : "Tap a point to rename it";
    }

    const activeStep = PHASE_STEP[compassState.phase] || "center";
    const done = {
      center: !!compassState.centerPointId,
      radius: !!compassState.radius,
      // Draw is never "done": finishing an arc returns the compass to READY,
      // which maps back to this same step ready for the next sweep. The New
      // arc button below is what tells you the last one landed — a tick here
      // could never render, since is-done only applies to a step that is not
      // the current one.
      draw: false
    };
    document.querySelectorAll(".compass-step").forEach((button) => {
      const step = button.dataset.compassAction;
      const isCurrent = step === activeStep;
      button.classList.toggle("is-current", isCurrent);
      button.classList.toggle("is-done", !isCurrent && !!done[step]);
      // state is carried by aria-current and a tick glyph, not colour alone
      if (isCurrent) button.setAttribute("aria-current", "step");
      else button.removeAttribute("aria-current");
    });

    const newArc = document.getElementById("compassNewArc");
    if (newArc) newArc.hidden = !compassState.lastArcGid;

    const showAngleToggle = document.getElementById("compassShowAngle");
    const selectedArcs = selectedArcPaths();
    if (showAngleToggle) {
      showAngleToggle.checked = selectedArcs.length
        ? selectedArcs.every((path) => path.showAngle === true)
        : compassState.showAngle;
    }

    document.querySelectorAll("[data-compass-mode]").forEach((button) => {
      const active = button.dataset.compassMode === compassState.mode;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", active ? "true" : "false");
    });

    setStatus(PHASE_HINTS[compassState.phase] || "Select the compass centre.");
  }

  // ---------- snapping ----------

  function snapAt(worldPoint) {
    const construction = C();
    if (!construction) return null;
    return construction.findSnapTarget(worldPoint, { transform: transform() });
  }

  function resolvePoint(worldPoint) {
    const snap = snapAt(worldPoint);
    return snap ? { x: snap.x, y: snap.y, snap } : { x: worldPoint.x, y: worldPoint.y, snap: null };
  }

  // Turn whatever is under the cursor into a real point we can reference.
  function pointAt(worldPoint) {
    const construction = C();
    const resolved = resolvePoint(worldPoint);

    if (resolved.snap?.type === "point" && resolved.snap.id) {
      return construction.get(resolved.snap.id);
    }
    if (resolved.snap?.type === "intersection") {
      return construction.createPoint(resolved, {
        origin: "intersection",
        sourceIds: resolved.snap.sourceObjectIds
      });
    }
    return construction.createPoint(resolved, { origin: "user" });
  }

  // An arc's two ends are grab handles. This finds one near `world` by walking
  // the arcs directly rather than going through snapAt, because once an end has
  // been promoted to a named point the point wins the snap and the end would
  // never be reachable.
  function extendTargetAt(world) {
    const construction = C();
    const engine = G();
    if (!construction || !engine || !engine.isValidPoint(world)) return null;

    const grab = engine.screenDistanceToWorld(
      EXTEND_GRAB_SCREEN_PX,
      state()?.transform
    );

    let best = null;
    let bestDistance = grab;

    construction.rebuildIndex().arcs.forEach((path) => {
      const centre = construction.center(path);
      if (!centre || !engine.isFiniteNumber(path.radius) || path.radius <= 0) return;

      // A short arc's two ends can sit inside one grab radius, so the handles
      // fight each other and neither is reliably reachable. Shrink the grab to
      // a third of the arc's own length in that case: the ends stay
      // distinguishable however tight the arc is, which is the whole
      // "hard to get back to the extension" problem.
      const sweep = Math.abs(arcSweepLength(path));
      const limit = sweep > 0 ? Math.min(grab, sweep / 3) : grab;

      [["start", path.startAngle], ["end", path.endAngle]].forEach((pair) => {
        const at = engine.pointOnCircleAt(centre, path.radius, pair[1]);
        const distance = engine.distance(world, at);
        if (distance <= limit && distance <= bestDistance) {
          best = { gid: path.gid, end: pair[0], armed: false };
          bestDistance = distance;
        }
      });
    });

    return best;
  }

  /** Arc length along the curve, used to keep end handles apart on short arcs. */
  function arcSweepLength(path) {
    const engine = G();
    if (!engine?.isFiniteNumber(path?.radius)) return 0;
    const start = Number(path.startAngle);
    const end = Number(path.endAngle);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
    return Math.abs(end - start) * path.radius;
  }

  /**
   * The arc under the cursor, by its curve rather than its ends.
   *
   * Tapping the body of an arc is a much larger target than either endpoint,
   * so this is how you get back to an arc that is too short to grab.
   */
  function arcBodyAt(world) {
    const construction = C();
    const engine = G();
    if (!construction || !engine || !engine.isValidPoint(world)) return null;

    const tolerance = engine.screenDistanceToWorld(
      ARC_BODY_GRAB_SCREEN_PX,
      state()?.transform
    );

    let best = null;
    let bestDistance = tolerance;

    construction.rebuildIndex().arcs.forEach((path) => {
      const centre = construction.center(path);
      if (!centre || !engine.isFiniteNumber(path.radius) || path.radius <= 0) return;

      // Distance to the circle the arc lies on, then check the press is
      // actually within the drawn sweep rather than the rest of the circle.
      const offset = Math.abs(engine.distance(world, centre) - path.radius);
      if (offset > bestDistance) return;
      if (!withinSweep(path, centre, world)) return;

      best = path;
      bestDistance = offset;
    });

    return best;
  }

  function withinSweep(path, centre, world) {
    if (path.full) return true;
    const start = Number(path.startAngle);
    const end = Number(path.endAngle);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return false;

    const angle = Math.atan2(world.y - centre.y, world.x - centre.x);
    const span = end - start;
    const TAU = Math.PI * 2;
    // Normalise the press onto the same turn as the sweep before comparing.
    const offset = ((angle - start) % TAU + TAU) % TAU;
    const swept = ((span) % TAU + TAU) % TAU;
    return span >= 0 ? offset <= swept : (TAU - offset) <= (TAU - swept) || offset >= swept;
  }

  // Moving one end keeps the centre, the radius and the other end where they
  // are: the sweep grows or shrinks, the circle it lives on does not move.
  function applyExtend(world) {
    const construction = C();
    const engine = G();
    if (!compassState.extend || !construction || !engine) return false;

    const path = construction.get(compassState.extend.gid);
    if (!path || path.geomType !== "arc") return false;

    const centre = construction.center(path);
    if (!centre) return false;

    const angle = engine.normalizeAngle(engine.angleOf(centre, world));
    if (compassState.extend.end === "start") path.startAngle = angle;
    else path.endAngle = angle;

    construction.invalidateIntersections();
    return true;
  }

  function finishExtend(world) {
    if (world) applyExtend(world);
    compassState.extend = null;
    compassState.phase = compassState.radius ? STATES.READY : STATES.SELECT_RADIUS;
    refreshIntersections();
    syncPanel();
    save();
    render();
  }

  // Entry point for the right-click menu: arm the arc and let the next move
  // stretch it, the way a tap-tap sweep works on touch.
  function beginExtend(gid, end) {
    const construction = C();
    const path = construction?.get(gid);
    if (!path || path.geomType !== "arc") return false;

    if (state()?.currentTool !== "compass" && typeof window.setTool === "function") {
      window.setTool("compass");
    }

    commitHistory();
    compassState.extend = { gid, end: end === "start" ? "start" : "end", armed: true };
    compassState.phase = STATES.EXTENDING;
    setStatus("Move to stretch the arc, then click to finish.");
    render();
    return true;
  }

  function refreshIntersections() {
    const construction = C();
    compassState.intersections = construction ? construction.computeIntersections() : [];
  }

  // ---------- state transitions ----------

  // The compass holds ids and a label ("AB") that refer to geometry which can
  // disappear underneath it — Clear canvas, an undo past the point's creation,
  // or switching notebook. A stale centre would silently draw arcs around a
  // deleted point, and a stale "AB" label would misreport where the radius
  // came from, so both are re-checked whenever the tool becomes active.
  // The numeric radius itself is kept: it is just a length, and keeping it is
  // what lets a measured distance outlive the segment it came from (spec §6).
  function validateReferences() {
    const construction = C();
    if (!construction) return;

    if (compassState.centerPointId && !construction.get(compassState.centerPointId)) {
      compassState.centerPointId = null;
      compassState.center = null;
    }

    // the radius keeps its value, but stops claiming a provenance whose points
    // no longer exist
    if (compassState.radiusFromId && !construction.get(compassState.radiusFromId)) {
      compassState.radiusFromId = null;
    }
    if (compassState.radiusToId && !construction.get(compassState.radiusToId)) {
      compassState.radiusToId = null;
    }
  }

  function activate() {
    validateReferences();
    compassState.phase = !compassState.centerPointId
      ? STATES.SELECT_CENTER
      : compassState.radius
        ? STATES.READY
        : STATES.SELECT_RADIUS;
    refreshIntersections();
    syncPanel();
    render();
  }

  // Full reset, for Clear canvas and for tests.
  function reset() {
    compassState.phase = STATES.SELECT_CENTER;
    compassState.centerPointId = null;
    compassState.center = null;
    compassState.radius = null;
    compassState.radiusFromId = null;
    compassState.radiusToId = null;
    compassState.startAngle = null;
    compassState.endAngle = null;
    compassState.cursor = null;
    compassState.snap = null;
    compassState.selectedPointId = null;
    compassState.pendingDown = null;
    compassState.measuring = false;
    compassState.extend = null;
    compassState.lastArcGid = null;
    compassState.sweepAccum = 0;
    compassState.lastAngle = null;
    compassState.intersections = [];
    C()?.invalidateIntersections();
    syncPanel();
  }

  function deactivate() {
    compassState.phase = STATES.IDLE;
    compassState.cursor = null;
    compassState.snap = null;
    compassState.pendingDown = null;
    render();
  }

  /**
   * Begin a second arc without unpicking the first.
   *
   * The centre and radius are kept: drawing a second arc from the same centre
   * is the common case (that is what a compass is for), so this re-arms the
   * draw step rather than making you place everything again. Placing a new
   * centre is still one tap on step 1.
   */
  function startAnotherArc() {
    compassState.mode = "arc";
    reset();
    setStatus("Tap a point to place the centre of the new arc.");
    render();
  }

  /**
   * Reopen an arc you already drew.
   *
   * Adopting its centre, radius and colour means "carry on from that one" is a
   * tap on the arc rather than a hunt for its endpoint — which is what made
   * short arcs so awkward, since their two ends sit inside one grab radius.
   */
  function reopenArc(path) {
    if (!path) return false;
    const centre = construction.center(path);
    if (!centre || !engine.isFiniteNumber(path.radius) || path.radius <= 0) return false;

    compassState.centerPointId = path.centerId || compassState.centerPointId;
    compassState.center = centre;
    compassState.radius = path.radius;
    compassState.lastArcGid = path.gid || null;
    if (path.color) compassState.color = path.color;

    armDraw();
    syncPanel();
    syncColorInputs();
    render();
    setStatus("Picked that arc back up — sweep to carry it on.");
    return true;
  }

  function armCenter() {
    compassState.phase = STATES.SELECT_CENTER;
    syncPanel();
    render();
  }

  function armRadius() {
    if (!compassState.centerPointId) {
      setStatus("Place the compass centre first.", true);
      return;
    }
    compassState.phase = STATES.SELECT_RADIUS;
    syncPanel();
    render();
  }

  function armDraw() {
    if (!compassState.centerPointId) {
      setStatus("Place the compass centre first.", true);
      armCenter();
      return;
    }
    if (!compassState.radius) {
      setStatus("Set a compass radius first.", true);
      armRadius();
      return;
    }
    compassState.phase = STATES.READY;
    syncPanel();
    render();
  }

  function clearRadius() {
    compassState.radius = null;
    compassState.radiusFromId = null;
    compassState.radiusToId = null;
    compassState.phase = compassState.centerPointId ? STATES.SELECT_RADIUS : STATES.SELECT_CENTER;
    syncPanel();
    render();
  }

  // "5a5aff", "#5A5AFF" and "5af" all name the same colour. The canonical
  // six-digit form is what gets stored, so a colour typed by hand and the same
  // colour picked from a swatch compare equal.
  const HEX_PATTERN = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

  function normalizeHex(raw) {
    const value = String(raw == null ? "" : raw).trim();
    if (!value) return null;
    const match = HEX_PATTERN.exec(value);
    if (!match) return null;
    let digits = match[1].toLowerCase();
    if (digits.length === 3) {
      digits = digits[0] + digits[0] + digits[1] + digits[1] + digits[2] + digits[2];
    }
    return `#${digits}`;
  }

  function syncColorInputs() {
    const color = compassState.color;
    const picker = document.getElementById("compassCustomColor");
    const wrap = document.getElementById("compassCustomSwatch");

    // The hex text field belongs to color-field.js now and mirrors the picker
    // on its own, so this only has to keep the picker itself true.
    if (picker) picker.value = color || "#5a5aff";
    if (wrap) {
      const isPreset = Array.from(document.querySelectorAll("[data-compass-color]"))
        .some((swatch) => (swatch.dataset.compassColor || null) === (color || null));
      wrap.classList.toggle("is-selected", !!color && !isPreset);
    }
  }

  function setColor(color, options = {}) {
    compassState.color = color || null;
    // persist alongside the other per-tool settings so the choice survives a
    // reload, the way pen/line colour does
    const settings = state()?.toolSettings;
    if (settings) {
      if (!settings.compass) settings.compass = { color: null };
      settings.compass.color = compassState.color;
      if (options.save !== false && typeof window.savePreferences === "function") {
        window.savePreferences();
      }
    }
    document.querySelectorAll("[data-compass-color]").forEach((swatch) => {
      const on = (swatch.dataset.compassColor || null) === (compassState.color || null);
      swatch.classList.toggle("is-selected", on);
      swatch.setAttribute("aria-pressed", on ? "true" : "false");
    });
    syncColorInputs();
    render();
  }

  function selectedArcPaths() {
    const s = state();
    const indices = window.Inkyscib?.Selection?.selectedIndices?.() || [];
    return indices.map((index) => s?.paths?.[index]).filter((path) => (
      path?.tool === "construction" && (path.geomType === "arc" || path.geomType === "circle")
    ));
  }

  // With an arc selected this edits that arc's legend. Otherwise it remains a
  // default for arcs drawn from now on.
  function setShowAngle(enabled, options = {}) {
    const selected = options.defaultsOnly ? [] : selectedArcPaths();
    if (selected.length) {
      commitHistory();
      selected.forEach((path) => { path.showAngle = !!enabled; });
      const toggle = document.getElementById("compassShowAngle");
      if (toggle) toggle.checked = !!enabled;
      save();
      render();
      return;
    }

    compassState.showAngle = !!enabled;

    const settings = state()?.toolSettings;
    if (settings) {
      if (!settings.compass) settings.compass = { color: null };
      settings.compass.showAngle = compassState.showAngle;
      if (options.save !== false && typeof window.savePreferences === "function") {
        window.savePreferences();
      }
    }

    const toggle = document.getElementById("compassShowAngle");
    if (toggle) toggle.checked = compassState.showAngle;
    render();
  }

  function adoptSavedShowAngle() {
    const saved = !!state()?.toolSettings?.compass?.showAngle;
    if (saved === compassState.showAngle) return;
    setShowAngle(saved, { save: false, defaultsOnly: true });
  }

  function setMode(mode) {
    compassState.mode = mode === "circle" ? "circle" : "arc";
    syncPanel();
    render();
  }

  function cancel() {
    // Escape out of a stretch leaves the arc wherever it currently sits; the
    // history snapshot taken when it started is what undo restores.
    if (compassState.phase === STATES.EXTENDING) {
      compassState.extend = null;
      compassState.phase = compassState.radius ? STATES.READY : STATES.SELECT_RADIUS;
      refreshIntersections();
      syncPanel();
      render();
      return;
    }

    if (compassState.phase === STATES.SWEEPING) {
      compassState.phase = STATES.READY;
      compassState.startAngle = null;
      compassState.pendingDown = null;
    } else {
      compassState.centerPointId = null;
      compassState.center = null;
      compassState.phase = STATES.SELECT_CENTER;
    }
    syncPanel();
    render();
  }

  function setCenterFromPath(pointPath) {
    if (!pointPath) return;
    compassState.centerPointId = pointPath.gid;
    compassState.center = { ...C().center(pointPath) };
    // Radius is deliberately untouched — this is what makes copying a
    // distance to a new centre exact (spec §6).
    compassState.phase = compassState.radius ? STATES.READY : STATES.SELECT_RADIUS;
    syncPanel();
  }

  // ---------- pointer handling ----------

  // getCanvasPos already returns WORLD coordinates (it calls clientPointToWorld
  // internally), so the transform must NOT be applied a second time. Doing so
  // was a no-op at scale 1 with no offset, and silently misplaced every click
  // the moment the canvas was panned or zoomed.
  function worldFromEvent(event) {
    let point = window.getCanvasPos
      ? window.getCanvasPos(event)
      : { x: event.clientX, y: event.clientY };

    // Notebook mode maps the canvas onto discrete pages; every other tool
    // normalises through this, and the compass has to agree with them.
    const s = state();
    if (s?.notebook?.active && typeof window.normalizeNotebookPoint === "function") {
      point = window.normalizeNotebookPoint(point, { clamp: true }) || point;
    }

    return { x: point.x, y: point.y };
  }

  function handleDown(event) {
    const engine = G();
    const construction = C();
    if (!engine || !construction) return false;

    const world = worldFromEvent(event);
    compassState.cursor = world;

    // An arc armed from the menu commits on the next press.
    if (compassState.phase === STATES.EXTENDING && compassState.extend?.armed) {
      finishExtend(world);
      return true;
    }

    // Pressing on an arc's own end carries that arc on instead of starting a
    // new one. Only from READY: mid-setup the press means something else.
    if (compassState.phase === STATES.READY) {
      const grabbed = extendTargetAt(world);
      if (grabbed) {
        commitHistory();
        compassState.extend = grabbed;
        compassState.phase = STATES.EXTENDING;
        setStatus("Extending the arc.");
        render();
        return true;
      }

      // Missed the ends but landed on the arc itself: pick that arc back up.
      // Only when it is not already the one in hand, so this never fights a
      // press meant to start a fresh sweep from the current setup.
      const body = arcBodyAt(world);
      if (body && body.gid !== compassState.lastArcGid) {
        commitHistory();
        if (reopenArc(body)) return true;
      }
    }

    if (compassState.phase === STATES.SELECT_CENTER || !compassState.centerPointId) {
      commitHistory();
      const point = pointAt(world);
      compassState.selectedPointId = point?.gid || null;
      setCenterFromPath(point);
      refreshIntersections();
      save();
      render();
      return true;
    }

    if (compassState.phase === STATES.SELECT_RADIUS) {
      // Press and drag to open the compass: the distance dragged IS the
      // radius, exactly like widening a real pair of compasses. Releasing
      // locks it. Tapping an existing point still measures to that point.
      compassState.measuring = true;
      compassState.pendingDown = { x: world.x, y: world.y };
      compassState.radius = engine.distance(compassState.center, world) || null;
      render();
      return true;
    }

    // Second tap of a tap-to-tap sweep: set the end angle and commit through
    // the same path a drag-release uses.
    if (compassState.phase === STATES.SWEEPING && compassState.tapSweep) {
      compassState.endAngle = engine.angleOf(compassState.center, world);
      compassState.pendingDown = null;
      compassState.tapSweep = false;
      return commitSweep(world);
    }

    // READY: begin sweeping an arc
    if (!compassState.radius) {
      setStatus("Set a compass radius first.", true);
      return true;
    }

    compassState.startAngle = engine.angleOf(compassState.center, world);
    compassState.endAngle = compassState.startAngle;
    compassState.lastAngle = compassState.startAngle;
    compassState.sweepAccum = 0;
    compassState.pendingDown = { x: world.x, y: world.y };
    compassState.phase = STATES.SWEEPING;
    render();
    return true;
  }

  function handleMove(event) {
    const engine = G();
    if (!engine) return false;

    const world = worldFromEvent(event);
    compassState.cursor = world;

    if (compassState.phase === STATES.EXTENDING) {
      applyExtend(world);
      compassState.snap = null;
      render();
      return true;
    }

    if (compassState.measuring) {
      // radius follows the drag, live
      compassState.radius = engine.distance(compassState.center, world) || null;
      compassState.snap = snapAt(world);
      syncPanel();
      render();
      return true;
    }

    if (compassState.phase === STATES.SWEEPING) {
      const angle = engine.angleOf(compassState.center, world);
      if (engine.isFiniteNumber(compassState.lastAngle)) {
        // shortest signed step, so crossing the -pi/+pi seam does not register
        // as a near-full rotation
        let delta = angle - compassState.lastAngle;
        while (delta > Math.PI) delta -= engine.TAU;
        while (delta < -Math.PI) delta += engine.TAU;
        compassState.sweepAccum = engine.clamp(
          compassState.sweepAccum + delta, -engine.TAU, engine.TAU
        );
      }
      compassState.lastAngle = angle;
      compassState.endAngle = angle;
      compassState.snap = null;
    } else {
      compassState.snap = snapAt(world);
    }

    render();
    return true;
  }

  // Arcs are stored sweeping from startAngle towards endAngle in the direction
  // of INCREASING angle. A user dragging anticlockwise would therefore get the
  // complement of the arc they just drew (a 90 degree drag becoming a 270
  // degree arc), so the pair is ordered from the direction actually swept.
  // With no drag information (a tap-tap sweep on touch, which produces no move
  // events) the shorter of the two arcs is the sensible reading.
  function resolveSweep(endAngle) {
    const engine = G();
    const start = compassState.startAngle;
    const accumulated = compassState.sweepAccum;

    if (engine.isFiniteNumber(accumulated) && Math.abs(accumulated) > 1e-6) {
      return accumulated >= 0 ? { start, end: endAngle } : { start: endAngle, end: start };
    }

    // no direction information: prefer the minor arc
    const forward = engine.arcSweep(start, endAngle);
    return forward <= Math.PI ? { start, end: endAngle } : { start: endAngle, end: start };
  }

  // Shared by drag-release and the second tap of a tap-tap sweep.
  function commitSweep(world) {
    const engine = G();
    const construction = C();

    commitHistory();

    const swept = resolveSweep(engine.angleOf(compassState.center, world));

    const isCircle = compassState.mode === "circle";
    const arc = construction.createArc(
      compassState.center,
      compassState.radius,
      swept.start,
      swept.end,
      {
        full: isCircle,
        centerId: compassState.centerPointId,
        radiusSource: radiusSourceLabel(),
        color: compassState.color,
        showAngle: compassState.showAngle,
        isConstruction: true
      }
    );

    compassState.phase = STATES.READY;
    compassState.pendingDown = null;
    compassState.tapSweep = false;
    compassState.startAngle = null;
    compassState.sweepAccum = 0;
    compassState.lastAngle = null;

    // An arc has landed. The stepper's three ticks now read as "finished", so
    // the panel needs something that says how to begin the next one.
    if (arc) compassState.lastArcGid = arc.gid || null;

    if (!arc) {
      setStatus("Could not place that arc.", true);
      render();
      return true;
    }

    construction.invalidateIntersections();
    refreshIntersections();

    const count = compassState.intersections.length;
    setStatus(count ? `${count} intersection${count === 1 ? "" : "s"} available.` : "No intersection.", true);

    // The panel was never refreshed after a sweep landed, which is why step 3
    // could be hardcoded incomplete without anyone noticing. It has real state
    // to show now — the third tick and the New arc button — so it has to run.
    syncPanel();
    save();
    render();
    return true;
  }

  function handleUp(event) {
    const engine = G();
    const construction = C();
    if (!engine || !construction) return false;

    // A drag-started extension finishes on release; a menu-armed one waits
    // for a click instead, so it is left alone here.
    if (compassState.phase === STATES.EXTENDING && !compassState.extend?.armed) {
      finishExtend(worldFromEvent(event));
      return true;
    }

    if (compassState.measuring) {
      const world = worldFromEvent(event);
      compassState.measuring = false;

      // Snapping to a real point keeps the radius exact and gives the readout
      // a name; otherwise it is simply the distance dragged.
      const resolved = resolvePoint(world);
      const existing = resolved.snap?.type === "point" && resolved.snap.id
        ? construction.get(resolved.snap.id)
        : null;
      const target = existing ? construction.center(existing) : resolved;
      const radius = engine.distance(compassState.center, target);

      if (!engine.isFiniteNumber(radius) || radius <= engine.POINT_TOLERANCE) {
        compassState.radius = null;
        setStatus("Drag further to open the compass.", true);
        syncPanel();
        render();
        return true;
      }

      commitHistory();
      compassState.radius = radius;
      compassState.radiusFromId = compassState.centerPointId;
      compassState.radiusToId = existing ? existing.gid : null;
      if (existing) compassState.selectedPointId = existing.gid;
      compassState.phase = STATES.READY;
      refreshIntersections();
      syncPanel();
      save();
      render();
      return true;
    }

    if (compassState.phase !== STATES.SWEEPING) return false;

    const world = worldFromEvent(event);
    const moved = compassState.pendingDown
      ? engine.distance(compassState.pendingDown, world) * transform().scale
      : 0;

    // A tap rather than a drag: touch devices have no hover, so requiring a
    // drag would make arcs hard to place on the tablets this app targets.
    // The first tap anchors the arc's start and stays in SWEEPING; the second
    // tap (handled in handleDown) sets the end and commits.
    if (moved < DRAG_SLOP_PX && compassState.mode !== "circle" && !compassState.tapSweep) {
      compassState.tapSweep = true;
      compassState.pendingDown = null;
      setStatus("Now tap where the arc should end.");
      render();
      return true;
    }

    return commitSweep(world);
  }

  // Clicking a highlighted intersection turns it into a real point (spec §15).
  // Deliberately does not draw anything next (spec §16).
  function handleTapSelect(world) {
    const construction = C();
    const snap = snapAt(world);
    if (!snap || snap.type !== "intersection") return false;

    commitHistory();
    const point = construction.createPoint(snap, {
      origin: "intersection",
      sourceIds: snap.sourceObjectIds
    });
    compassState.selectedPointId = point?.gid || null;
    setStatus(`Point ${point?.label || ""} created.`, true);
    save();
    render();
    return true;
  }

  // ---------- overlay state for the renderer ----------

  function getOverlayState() {
    if (state()?.currentTool !== "compass") return null;

    const construction = C();
    const selectedPath = compassState.selectedPointId
      ? construction?.get(compassState.selectedPointId)
      : null;

    return {
      intersections: compassState.intersections,
      snap: compassState.snap,
      selected: selectedPath ? construction.center(selectedPath) : null,
      preview:
        compassState.center && compassState.radius
          ? {
              center: compassState.center,
              radius: compassState.radius,
              cursor: compassState.cursor,
              mode: compassState.mode,
              color: compassState.color,
              sweeping: compassState.phase === STATES.SWEEPING,
              // preview the arc that would actually be committed, including
              // its direction, so what you see is what you get
              ...(compassState.phase === STATES.SWEEPING
                ? (() => {
                    const swept = resolveSweep(compassState.endAngle);
                    return { startAngle: swept.start, endAngle: swept.end };
                  })()
                : {
                    startAngle: compassState.startAngle,
                    endAngle:
                      compassState.cursor && G()
                        ? G().angleOf(compassState.center, compassState.cursor)
                        : null
                  })
            }
          : compassState.center
            ? { center: compassState.center, radius: null }
            : null
    };
  }

  // ---------- wiring ----------

  // Every tool wires its own toolbar button (tools/pen.js, tools/select.js …);
  // there is no generic binding, so the compass needs its own. Follows the same
  // convention: in dock mode the button only selects the tool, and below the
  // dock breakpoint a second tap on the already-active tool toggles its
  // options popover.
  function bindToolButton() {
    const button = document.getElementById("compassTool");
    if (!button) return;


    function selectCompass() {
      if (typeof window.closeAllToolboxes === "function") window.closeAllToolboxes();
      if (typeof window.setTool === "function") {
        window.setTool("compass");
      } else {
        const s = state();
        s.currentTool = "compass";
        s.panMode = false;
        document.querySelectorAll(".tool").forEach((b) => b.classList.remove("active"));
        button.classList.add("active");
      }
    }

    function onPress(event) {
      event.stopPropagation();
      // Opening and closing this tool's panel is tool-dock.js's job at every
      // width: it sees the tap in the capture phase and toggles on a second
      // tap. This handler only selects the tool. A second owner here -- a
      // double-tap timer below 1180px, writing style.display directly -- is
      // what left the panels out of step with the dock and, for Algebra tiles,
      // hid the panel the moment the tool was picked.
      selectCompass();
    }

    // click only. A touchstart listener here called preventDefault, which
    // cancels the click a tap synthesises -- so on a touch screen the second
    // tap never reached tool-dock.js and the compass panel could not be put
    // away. click fires for touch, pen and mouse alike.
    button.addEventListener("click", onPress);
  }

  function bindLabelInput() {
    const input = document.getElementById("compassPointLabel");
    if (!input) return;

    const apply = () => {
      if (!renameSelectedPoint(input.value)) syncPanel();
    };

    input.addEventListener("change", apply);
    input.addEventListener("blur", apply);
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") { event.preventDefault(); apply(); input.blur(); }
      if (event.key === "Escape") { event.preventDefault(); syncPanel(); input.blur(); }
      // typing must not reach the canvas shortcuts
      event.stopPropagation();
    });
  }

  function bindRadiusInput() {
    const input = document.getElementById("compassRadiusInput");
    if (!input) return;

    const apply = () => {
      if (!setRadiusUnits(input.value)) syncPanel();
    };

    input.addEventListener("change", apply);
    input.addEventListener("blur", apply);
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") { event.preventDefault(); apply(); input.blur(); }
      if (event.key === "Escape") { event.preventDefault(); syncPanel(); input.blur(); }
      event.stopPropagation();
    });
  }

  function bindColorInputs() {
    const picker = document.getElementById("compassCustomColor");
    if (!picker) return;

    // The hex text field is color-field.js's, shared with every other tool. It
    // drives this picker and fires its events, so one handler covers typing a
    // code, using the swatch, and the OS colour dialog alike.
    picker.addEventListener("input", () => setColor(normalizeHex(picker.value)));

    // Emptying the hex field means "no custom colour" — back to the arc's
    // default — which is a state the compass has and most tools do not.
    picker.addEventListener("hexcleared", () => setColor(null));
  }

  function initCompass() {
    // adopt whatever is already loaded; syncPanel re-adopts once the async
    // preference load lands
    adoptSavedColor();

    bindToolButton();
    bindLabelInput();
    bindRadiusInput();
    bindColorInputs();
    syncColorInputs();

    document.getElementById("compassShowAngle")?.addEventListener("change", (event) => {
      setShowAngle(event.target.checked);
    });

    document.querySelectorAll("[data-compass-action]").forEach((button) => {
      button.addEventListener("click", () => {
        const action = button.dataset.compassAction;
        if (action === "center") armCenter();
        else if (action === "draw") armDraw();
        else if (action === "radius") armRadius();
        else if (action === "clear-radius") clearRadius();
        else if (action === "new-arc") startAnotherArc();
      });
    });

    document.querySelectorAll("[data-compass-mode]").forEach((button) => {
      button.addEventListener("click", () => setMode(button.dataset.compassMode));
    });

    document.querySelectorAll("[data-compass-color]").forEach((swatch) => {
      swatch.addEventListener("click", () => setColor(swatch.dataset.compassColor));
    });

    document.addEventListener("toolChanged", (event) => {
      if (event.detail?.tool === "compass") activate();
      else deactivate();
    });
    document.addEventListener("selectionChanged", syncPanel);

    // Clearing the canvas deletes every point the compass refers to.
    const originalClear = window.clearCanvas;
    if (typeof originalClear === "function" && !originalClear.__compassWrapped) {
      const wrappedClear = async function () {
        const result = await originalClear.apply(this, arguments);
        C()?.rebuildFromPaths();
        reset();
        render();
        return result;
      };
      wrappedClear.__compassWrapped = true;
      window.clearCanvas = wrappedClear;
    }

    // Rebuild the index and candidate list after an undo/redo swaps the paths
    // array wholesale.
    ["undo", "redo"].forEach((name) => {
      const original = window[name];
      if (typeof original !== "function" || original.__compassWrapped) return;
      const wrapped = function () {
        const result = original.apply(this, arguments);
        C()?.rebuildFromPaths();
        C()?.invalidateIntersections();
        if (state()?.currentTool === "compass") {
          // the centre may have been undone out of existence
          validateReferences();
          if (!compassState.centerPointId) compassState.phase = STATES.SELECT_CENTER;
          refreshIntersections();
          syncPanel();
          render();
        }
        return result;
      };
      wrapped.__compassWrapped = true;
      window[name] = wrapped;
    });

    syncPanel();
  }

  window.Inkyscib = window.Inkyscib || {};

  // Renaming the unit changes every label this panel prints, so rebuild it.
  document.addEventListener("inkyscibUnitNameChanged", () => syncPanel());
  window.Inkyscib.Compass = {
    STATES,
    compassState,
    handleDown,
    handleMove,
    handleUp,
    handleTapSelect,
    getOverlayState,
    activate,
    deactivate,
    armCenter,
    armRadius,
    armDraw,
    clearRadius,
    setMode,
    setColor,
    setShowAngle,
    // Preferences land after the panel is built; this pulls them in again.
    syncSettings() {
      adoptSavedColor();
      adoptSavedShowAngle();
      syncColorInputs();
    },
    setRadiusUnits,
    cancel,
    reset,
    beginExtend,
    extendTargetAt,
    arcBodyAt,
    reopenArc,
    startAnotherArc,
    renameSelectedPoint,
    validateReferences,
    formatLength,
    syncPanel
  };

  document.addEventListener("DOMContentLoaded", initCompass);
})();
