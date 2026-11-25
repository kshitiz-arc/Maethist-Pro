
(function () {
  "use strict";
  function getCanvas() {
    return document.getElementById("drawingCanvas");
  }

  function state() {
    return window.appState;
  }

  function requestRedraw() {
    if (typeof window.render === "function") window.render();
  }

  function safeCloseToolboxes() {
    if (typeof window.closeAllToolboxes === "function") window.closeAllToolboxes();
  }

  function safeSave() {
    if (typeof window.saveDrawing === "function") window.saveDrawing();
  }

  function clearSelectionForCanvasAction() {
    if (state()?.currentTool !== "select" && window.Inkyscib?.Selection?.clear) {
      window.Inkyscib.Selection.clear({ render: false });
    }
  }
  function safeSavePreferences() {
    // Debounced: this runs from wheel, pan and pinch, where an immediate
    // synchronous write would land inside the gesture's own frames.
    if (typeof window.schedulePreferencesSave === "function") {
      window.schedulePreferencesSave();
    } else if (typeof window.savePreferences === "function") {
      window.savePreferences();
    } else {
      safeSave();
    }
  }

  function clampScale(s) {
    return Math.max(0.15, Math.min(6, s));
  }
  function clientToCanvas(clientX, clientY) {
    if (typeof window.clientPointToCanvas === "function") {
      return window.clientPointToCanvas(clientX, clientY);
    }
    return { x: clientX, y: clientY };
  }
  function screenToWorld(canvasX, canvasY, tr) {
    return {
      x: (canvasX - tr.offsetX) / tr.scale,
      y: (canvasY - tr.offsetY) / tr.scale,
    };
  }
  function zoomAboutScreenPoint(tr, screenX, screenY, newScale) {
    const world = screenToWorld(screenX, screenY, tr);
    tr.scale = newScale;
    tr.offsetX = screenX - world.x * tr.scale;
    tr.offsetY = screenY - world.y * tr.scale;
  }
  function normalizePressure(e) {
    const raw = typeof e.pressure === "number" ? e.pressure : null;
    if (raw !== null && raw > 0) return Math.max(0.05, Math.min(1, raw));
    return 0.55;
  }
  function getDrawingPoint(e) {
    const pos = window.getCanvasPos ? window.getCanvasPos(e) : { x: e.clientX, y: e.clientY };
    return {
      ...pos,
      pressure: normalizePressure(e),
      time: Number.isFinite(e?.timeStamp) ? e.timeStamp : performance.now(),
    };
  }
  function inputType(e) {
    if (typeof e?.pointerType === "string" && e.pointerType) return e.pointerType;
    return e?.touches ? "touch" : "mouse";
  }
  function setInkInput(path, value) {
    Object.defineProperty(path, "__inkInput", {
      value,
      configurable: true,
      writable: true,
    });
  }
  function beginInkInput(path, point, e) {
    if (path?.tool !== "pen") return;
    setInkInput(path, {
      type: inputType(e),
      raw: { ...point },
      filtered: { ...point },
      speed: 0,
      time: point.time,
      // Every sample as the pen reported it. On lift the stroke is rebuilt
      // from these (static/js/ink-smooth.js), so the live filter below only
      // has to keep the ink tidy while it is being drawn.
      rawPoints: [{ ...point }],
      // Display only: the renderer draws the live stroke through to here, the
      // newest sample, so the ink on screen reaches the nib.
      tip: { ...point },
    });
  }
  // Off, then the two useful amounts. Values are cutoff frequencies in Hz.
  // They used to be 4.5 and 2.4, which smoothed hard enough to trail the nib by
  // ~10px and ~16px; the heavy smoothing now happens on lift, with no lag, so
  // the live filter is light enough to stay a few pixels behind.
  const INK_SMOOTHING = {
    off: null,
    natural: { base: 11, gain: 18, ceiling: 28 },
    strong: { base: 9.5, gain: 16, ceiling: 22 },
  };

  // The pen's write-assist level, 0-100. Stored as a number since the slider;
  // older saves hold "off" / "natural" / "strong", which ink-smooth.js maps
  // onto 0 / 40 / 70. The fallback only matters if that file failed to load.
  function smoothingStrength() {
    const value = state()?.toolSettings?.pen?.smoothing;
    const level = window.Inkyscib?.InkSmooth?.assistLevel;
    if (typeof level === "function") return level(value);
    return Object.prototype.hasOwnProperty.call(INK_SMOOTHING, value) ? value : "natural";
  }

  function liveFilterFor(strength) {
    const live = window.Inkyscib?.InkSmooth?.liveFilter;
    if (typeof live === "function") return live(strength);
    return INK_SMOOTHING[strength] || null;
  }

  function smoothingAlpha(cutoff, elapsedMs) {
    const elapsedSeconds = Math.max(0.001, Math.min(0.05, elapsedMs / 1000));
    const timeConstant = 1 / (Math.PI * 2 * cutoff);
    return elapsedSeconds / (timeConstant + elapsedSeconds);
  }
  function appendInkPoint(path, point, e) {
    if (path?.tool !== "pen") {
      path.points.push(point);
      return;
    }

    let tracker = path.__inkInput;
    if (!tracker) {
      beginInkInput(path, path.points[0] || point, e);
      tracker = path.__inkInput;
    }
    // Recorded before any filtering, for the lift-time rebuild, and shown as
    // the tip so the ink on screen reaches the nib.
    tracker.rawPoints.push({ ...point });
    tracker.tip = { ...point };

    // Write assist. This used to run for the mouse only, on the reasoning that
    // "pens already provide carefully sampled input" -- but a stylus reports a
    // clean sample of a shaky hand, and a fingertip is shakier still. On the
    // tablet this product is written for, that left handwriting unassisted.
    // It is a setting now rather than a device check: the filter suppresses
    // slow tremor and releases quickly as the stroke speeds up, so the ink
    // never feels like it is trailing behind the nib.
    //
    // Render-time smoothing (canvas.js smoothPoints + soften) fits a curve
    // through whatever is recorded; it cannot remove a wobble that is already
    // in the points. This is the layer that can.
    const preset = liveFilterFor(smoothingStrength());

    if (!preset) {
      path.points.push(point);
      tracker.raw = { ...point };
      tracker.filtered = { ...point };
      tracker.time = point.time;
      return;
    }

    const elapsed = Math.max(1, point.time - tracker.time);
    const rawDistance = Math.hypot(point.x - tracker.raw.x, point.y - tracker.raw.y);
    const instantSpeed = rawDistance / elapsed;
    const speedAlpha = smoothingAlpha(7.5, elapsed);
    tracker.speed += (instantSpeed - tracker.speed) * speedAlpha;

    // A lower cutoff smooths harder. It rises with speed so a fast stroke
    // stays responsive while slow, deliberate writing gets the most help.
    const cutoff = preset.base + Math.min(preset.ceiling, tracker.speed * preset.gain);
    const alpha = smoothingAlpha(cutoff, elapsed);
    const filtered = {
      ...point,
      x: tracker.filtered.x + (point.x - tracker.filtered.x) * alpha,
      y: tracker.filtered.y + (point.y - tracker.filtered.y) * alpha,
    };

    const last = path.points[path.points.length - 1];
    const scale = Math.max(0.15, state()?.transform?.scale || 1);
    const minimumDistance = 0.12 / scale;
    if (!last || Math.hypot(filtered.x - last.x, filtered.y - last.y) >= minimumDistance) {
      path.points.push(filtered);
    } else if (path.points.length > 1) {
      path.points[path.points.length - 1] = filtered;
    }

    tracker.raw = { ...point };
    tracker.filtered = filtered;
    tracker.time = point.time;
  }
  function finishInkInput(path) {
    const tracker = path?.__inkInput;
    if (!tracker) return;

    // On lift the stroke is rebuilt from what the pen actually reported, with
    // symmetric smoothing that has no lag (static/js/ink-smooth.js), so it ends
    // exactly where the pen lifted. The catch-up that used to stand here ran
    // for the mouse only, and pen and touch strokes stopped ~11px short.
    // Off keeps the raw points it already stored.
    const strength = smoothingStrength();
    const smoothStroke = window.Inkyscib?.InkSmooth?.smoothStroke;
    if (liveFilterFor(strength) && smoothStroke && tracker.rawPoints.length >= 3) {
      const scale = Math.max(0.15, state()?.transform?.scale || 1);
      path.points = smoothStroke(tracker.rawPoints, strength, scale, tracker.type);
    }

    delete path.__inkInput;
  }
  function smartGeometryApi() {
    return window.Inkyscib?.SmartGeometry || null;
  }
  function isSmartShapePath(path) {
    if (!path || path.tool !== "shape") return false;
    const geometry = smartGeometryApi();
    if (geometry?.isSmartGeometry?.(path)) return true;
    return Number(path.geometryVersion) === 1 &&
      typeof path.geometryKind === "string" &&
      path.geometryKind === path.shapeType;
  }
  function updateSmartShapeDraft(path, point) {
    const geometry = smartGeometryApi();
    if (geometry?.updateShapeDraft) {
      return geometry.updateShapeDraft(path, point);
    }
    if (geometry?.isSmartCircle?.(path) && geometry.updateCircleDraft) {
      return geometry.updateCircleDraft(path, point);
    }
    return false;
  }
  function finalizeSmartShape(path) {
    const geometry = smartGeometryApi();
    if (geometry?.finalizeSmartShape) {
      return geometry.finalizeSmartShape(path);
    }
    if (geometry?.isSmartCircle?.(path) && geometry.finalizeCircle) {
      return geometry.finalizeCircle(path);
    }
    return false;
  }
  function isMeaningfulSmartShape(path) {
    const geometry = smartGeometryApi();
    if (geometry?.isMeaningfulShape) {
      return geometry.isMeaningfulShape(path);
    }
    if (geometry?.isSmartCircle?.(path) && geometry.circleRadius) {
      return geometry.circleRadius(path) >= 4;
    }
    return Array.isArray(path?.points) && path.points.length >= 3;
  }
  function snapGeometryPoint(point, path, settings = {}) {
    const geometry = smartGeometryApi();
    if (!geometry?.snapPoint) return point;
    const snapped = geometry.snapPoint(point, path || null, {
      grid: path ? path.snapToGrid !== false : settings.snapToGrid !== false,
      objects: path ? path.snapToObjects !== false : settings.snapToObjects !== false
    });
    return snapped?.point || point;
  }
  // Ruler-and-compass constructions are only useful if the Line tool lands
  // exactly on the points the compass produced, so line endpoints snap to
  // construction geometry (existing points, arc intersections, midpoints).
  // Freehand tools are deliberately excluded — snapping would fight the ink.
  // The snap the last call landed on, and the ones holding the two ends of the
  // line being drawn. Kept here rather than on the path so nothing temporary
  // reaches the serializer.
  let lastConstructionSnap = null;
  let lineStartSnap = null;
  let lineEndSnap = null;

  function snapConstructionPoint(point) {
    lastConstructionSnap = null;
    const construction = window.Inkyscib?.Construction;
    if (!construction?.findSnapTarget || !point) return point;

    const target = construction.findSnapTarget(point, {
      transform: state()?.transform
    });
    if (!target) return point;

    lastConstructionSnap = target;
    return { ...point, x: target.x, y: target.y, __snapType: target.type };
  }

  // An arc crossing is only implied by its two parents, so a line joined to one
  // turns it into a real stored point. That is what keeps the crossing usable
  // after the compass has moved on — and it labels it like any other point.
  function anchorLineEndpoints() {
    const construction = window.Inkyscib?.Construction;
    if (!construction?.materializeSnap) return;
    const start = construction.materializeSnap(lineStartSnap);
    const end = construction.materializeSnap(lineEndSnap);
    // Remember which points the ends sit on: dragging one later carries the
    // line with it (select.js, followMovedPoints).
    const path = state()?.currentPath;
    if (path && path.tool === "line") {
      if (start?.gid) path.startPointId = start.gid;
      if (end?.gid) path.endPointId = end.gid;
    }
  }

  function clearConstructionSnaps() {
    lastConstructionSnap = null;
    lineStartSnap = null;
    lineEndSnap = null;
    if (window.Inkyscib?.Construction?.setActiveSnap?.(null)) requestRedraw();
  }

  // Highlight the crossing under the cursor before the user commits to it, so
  // "join these two arcs" is a visible target rather than a guess.
  function updateConstructionHover(e) {
    const s = state();
    const construction = window.Inkyscib?.Construction;
    if (!construction?.setActiveSnap) return;
    if (s.currentTool !== "line" || s.isDrawing || s.isPanning || s.panMode) {
      if (construction.setActiveSnap(null)) requestRedraw();
      return;
    }
    let pos = getDrawingPoint(e);
    if (s.notebook?.active && typeof window.normalizeNotebookPoint === "function") {
      pos = window.normalizeNotebookPoint(pos, { clamp: true });
      if (!pos) return;
    }
    const target = construction.findSnapTarget(pos, { transform: s.transform });
    if (construction.setActiveSnap(target)) requestRedraw();
  }

  // With an exact length set, the drag chooses the direction and the setting
  // chooses the distance.
  //
  // This runs AFTER construction snapping deliberately. Both want to own the far
  // end, and a typed length is an explicit instruction while a snap is a
  // convenience, so the length wins. The snap still does half the job: it
  // decides the direction, which is what the user is still steering.
  function applyFixedLineLength(from, to) {
    const api = window.Inkyscib?.LineLength;
    if (!api || !from || !to) return to;
    const worldLength = api.fixedWorldLength();
    if (!worldLength) return to;
    return api.projectToLength(from, to, worldLength);
  }

  function isCustomTriangleMode() {
    const s = state();
    const shape = s?.toolSettings?.shape || {};
    return s?.currentTool === "shape" &&
      shape.shapeType === "triangle" &&
      shape.triangleType === "custom";
  }
  function isCustomTriangleActive() {
    const path = state()?.currentPath;
    return !!path &&
      path.tool === "shape" &&
      path.shapeType === "triangle" &&
      path.triangleType === "custom";
  }
  function cancelCustomTriangle() {
    const s = state();
    if (!isCustomTriangleActive()) return false;
    s.isDrawing = false;
    s.currentPath = null;
    requestRedraw();
    return true;
  }
  function handleCustomTrianglePoint(e) {
    const s = state();
    let pos = getDrawingPoint(e);
    if (s.notebook?.active && typeof window.normalizeNotebookPoint === "function") {
      pos = window.normalizeNotebookPoint(pos, { clamp: false });
      if (!pos) return true;
    }

    safeCloseToolboxes();
    s.isDrawing = true;
    s.isPanning = false;
    const settings = s.toolSettings?.shape || {};
    pos = snapGeometryPoint(pos, s.currentPath, settings);

    if (!isCustomTriangleActive()) {
      s.currentPath = smartGeometryApi()?.createCustomTrianglePath?.(pos, settings) || {
        tool: "shape",
        size: settings.size || 3,
        color: settings.color || "#ffffff",
        shapeType: "triangle",
        triangleType: "custom",
        points: [pos],
        timestamp: Date.now()
      };
    } else if ((s.currentPath.points || []).length < 3) {
      s.currentPath.points.push(pos);
    }

    delete s.currentPath.previewPoint;

    if (s.currentPath.points.length >= 3) {
      const finalPath = {
        ...s.currentPath,
        points: s.currentPath.points.slice(0, 3),
        timestamp: Date.now()
      };
      delete finalPath.previewPoint;
      const geometry = smartGeometryApi();
      geometry?.promoteTriangle?.(finalPath);
      finalizeSmartShape(finalPath);
      if (typeof window.commitHistory === "function") window.commitHistory();
      s.paths.push(finalPath);
      const createdIndex = s.paths.length - 1;
      s.isDrawing = false;
      s.currentPath = null;
      requestRedraw();
      safeSave();
      geometry?.afterPathCreated?.(finalPath, createdIndex);
      return true;
    }

    requestRedraw();
    return true;
  }
  function updateCustomTrianglePreview(e) {
    const s = state();
    if (!isCustomTriangleActive()) return false;
    let point = getDrawingPoint(e);
    if (s.notebook?.active && typeof window.normalizeNotebookPoint === "function") {
      point = window.normalizeNotebookPoint(point, { clamp: true });
      if (!point) return false;
    }
    point = snapGeometryPoint(point, s.currentPath);
    s.currentPath.previewPoint = point;
    requestRedraw();
    return true;
  }
  let targetTransform = null;
  let rafId = null;

  function ensureTarget() {
    if (!targetTransform) {
      const tr = state().transform;
      targetTransform = { scale: tr.scale, offsetX: tr.offsetX, offsetY: tr.offsetY };
    }
    return targetTransform;
  }

  function startSmoothTransform() {
    if (rafId) return;

    const step = () => {
      rafId = null;

      const s = state();
      const tr = s.transform;
      const tg = ensureTarget();
      const k = 0.22;

      const ns = tr.scale + (tg.scale - tr.scale) * k;
      const nx = tr.offsetX + (tg.offsetX - tr.offsetX) * k;
      const ny = tr.offsetY + (tg.offsetY - tr.offsetY) * k;

      tr.scale = ns;
      tr.offsetX = nx;
      tr.offsetY = ny;
      if (typeof window.clampPptTransform === "function" && s.ppt?.active) {
        window.clampPptTransform(tr);
      }

      requestRedraw();

      const done =
        Math.abs(tg.scale - ns) < 0.0005 &&
        Math.abs(tg.offsetX - nx) < 0.25 &&
        Math.abs(tg.offsetY - ny) < 0.25;

      if (!done) rafId = requestAnimationFrame(step);
    };

    rafId = requestAnimationFrame(step);
  }
  function startDrawing(e) {
    const s = state();
    let pos = getDrawingPoint(e);
    if (s.notebook?.active && typeof window.normalizeNotebookPoint === "function") {
      pos = window.normalizeNotebookPoint(pos, { clamp: false });
      if (!pos) return;
    }

    safeCloseToolboxes();
    clearSelectionForCanvasAction();

    s.isDrawing = true;
    s.isPanning = false;

    if (s.currentTool === "line") {
      pos = snapConstructionPoint(pos);
      lineStartSnap = lastConstructionSnap;
      lineEndSnap = null;
    }

    s.currentPath = window.createPath ? window.createPath(pos) : { points: [pos] };
    beginInkInput(s.currentPath, pos, e);
    if (s.currentTool === "shape" || s.currentTool === "line") {
      if (!isSmartShapePath(s.currentPath)) {
        s.currentPath.points = [pos, { ...pos }];
      }
    }
  }

  function continueDrawing(e) {
    const s = state();
    if (!s.isDrawing || !s.currentPath) return;

    if (s.currentPath.tool === "manipulative") {
      let pos = getDrawingPoint(e);
      if (s.notebook?.active && typeof window.normalizeNotebookPoint === "function") {
        pos = window.normalizeNotebookPoint(pos, { clamp: true });
        if (!pos) return;
      }
      window.Inkyscib?.Manipulatives?.moveTileTo?.(s.currentPath, pos);
      requestRedraw();
      return;
    }

    if (s.currentPath.tool === "shape" || s.currentPath.tool === "line") {
      let pos = getDrawingPoint(e);
      if (s.notebook?.active && typeof window.normalizeNotebookPoint === "function") {
        pos = window.normalizeNotebookPoint(pos, { clamp: true });
        if (!pos) return;
      }
      if (isSmartShapePath(s.currentPath)) {
        updateSmartShapeDraft(s.currentPath, pos);
      } else {
        // the far end of a construction line must land on the point too
        if (s.currentPath.tool === "line") {
          s.currentPath.points[1] = applyFixedLineLength(
            s.currentPath.points[0],
            snapConstructionPoint(pos)
          );
          lineEndSnap = lastConstructionSnap;
          window.Inkyscib?.Construction?.setActiveSnap?.(lastConstructionSnap);
        } else {
          s.currentPath.points[1] = pos;
        }
      }
    } else {
      takeInkSamples(e);
    }

    requestRedraw();
  }

  // Chromium holds pointermove back to the next frame. pointerrawupdate carries
  // the same samples as soon as they arrive - measured 10.7 ms earlier for the
  // mouse and 13 ms for touch at the median - so ink is taken from whichever
  // brings a sample first. Each sample is appended once, in order, so the
  // smoothing filter in appendInkPoint sees exactly what it always did.
  const lastSampleTime = new WeakMap();
  let rawInputEnabled = true;

  // Test seam: off leaves drawing to pointermove alone.
  window.__inkyscibSetRawInput = (enabled) => {
    rawInputEnabled = enabled !== false;
  };

  function takeInkSamples(e) {
    const s = state();
    const path = s.currentPath;
    const coalesced = typeof e.getCoalescedEvents === "function"
      ? e.getCoalescedEvents()
      : [];
    const samples = coalesced.length ? coalesced : [e];
    let taken = 0;
    samples.forEach((sample) => {
      const time = Number.isFinite(sample.timeStamp) ? sample.timeStamp : null;
      const previous = lastSampleTime.get(path);
      if (time !== null && previous !== undefined && time <= previous) return;
      let pos = getDrawingPoint(sample);
      if (s.notebook?.active && typeof window.normalizeNotebookPoint === "function") {
        pos = window.normalizeNotebookPoint(pos, { clamp: true });
        if (!pos) return;
      }
      appendInkPoint(path, pos, sample);
      if (time !== null) lastSampleTime.set(path, time);
      taken++;
    });
    return taken;
  }

  function onPointerRawUpdate(e) {
    if (!rawInputEnabled) return;
    const s = state();
    const tool = s.currentPath?.tool;
    if (!s.isDrawing || (tool !== "pen" && tool !== "highlight")) return;
    if (s.isPanning || s.isTouchZooming) return;
    if (e.pointerType !== "mouse" && (!pointers.has(e.pointerId) || pointers.size >= 2)) return;
    if (takeInkSamples(e) && typeof window.renderNow === "function") {
      window.renderNow();
    }
  }

  function endDrawing() {
      const s = state();
      if (!s.isDrawing || !s.currentPath) return;
      finishInkInput(s.currentPath);
      const smartShape = isSmartShapePath(s.currentPath);
      const tile = s.currentPath.tool === "manipulative";
      if (tile) {
          window.Inkyscib?.Manipulatives?.finalizeTile?.(s.currentPath);
      } else if (smartShape) {
          finalizeSmartShape(s.currentPath);
      } else if (s.currentPath.tool === "shape" && s.currentPath.points.length === 2) {
          const [p1, p2] = s.currentPath.points;
          s.currentPath.width = Math.abs(p2.x - p1.x);
          s.currentPath.height = Math.abs(p2.y - p1.y);
          s.currentPath.centerX = (p1.x + p2.x) / 2;
          s.currentPath.centerY = (p1.y + p2.y) / 2;
      }
      const meaningful =
          tile
              ? true
              : s.currentPath.tool === "eraser"
              ? s.currentPath.points.length > 0
              : smartShape
                  ? isMeaningfulSmartShape(s.currentPath)
                  : (s.currentPath.tool === "line" || s.currentPath.tool === "shape")
                      ? s.currentPath.points.length === 2
                      : s.currentPath.points.length > 1;
    
      let createdPath = null;
      let createdIndex = -1;
      if (meaningful) {
          if (s.currentPath.tool === "eraser" && s.currentPath.eraseMode === "object" &&
              typeof window.eraseInkyscibObjectsTouched === "function") {
              const beforeErase = typeof window.captureHistory === "function" ? window.captureHistory() : null;
              if (window.eraseInkyscibObjectsTouched(s.paths, s.currentPath)) {
                  if (beforeErase && typeof window.commitHistory === "function") window.commitHistory(beforeErase);
              }
          } else if (s.currentPath.tool === "eraser" && typeof window.applyInkyscibEraserToPaths === "function") {
              // Snapshot before erasing so undo can restore the split/removed strokes.
              const beforeErase = typeof window.captureHistory === "function" ? window.captureHistory() : null;
              if (window.applyInkyscibEraserToPaths(s.paths, s.currentPath)) {
                  if (beforeErase && typeof window.commitHistory === "function") window.commitHistory(beforeErase);
              }
          } else {
              if (typeof window.commitHistory === "function") window.commitHistory();
              // After the snapshot, so one undo takes the line and the points
              // it created away together.
              if (s.currentPath.tool === "line") {
                anchorLineEndpoints();
                if (s.currentPath.showLabels) {
                  window.Inkyscib?.LineLabels?.ensure?.(s.currentPath);
                }
              }
              s.paths.push(s.currentPath);
              createdPath = s.currentPath;
              createdIndex = s.paths.length - 1;
          }
      }
    
      s.isDrawing = false;
      s.currentPath = null;
      clearConstructionSnaps();

      // Write assist, second half. appendInkPoint above steadies the hand as
      // the stroke is made, but it is causal and can only ever see the past;
      // snapping an outline to a shape or straightening a run needs the
      // finished stroke, so it happens here. It may hand back a different path
      // object — a promoted geometry shape — which is what the dispatch below
      // then belongs to.
      let promotedByAssist = false;
      if (createdPath?.tool === "pen" && window.Inkyscib?.Handwriting?.assist) {
          const assisted = window.Inkyscib.Handwriting.assist(createdPath, createdIndex);
          if (assisted) {
              promotedByAssist = assisted !== createdPath;
              createdPath = assisted;
          }
      }

      requestRedraw();
      if (typeof window.saveDrawing === 'function') {
          window.saveDrawing();
      }
      // A shape that shape assist made keeps the pen in hand. afterPathCreated
      // switches to Select, which under someone mid-sentence turns their next
      // stroke into a marquee; the chip's Edit button does that on request.
      if (createdPath?.tool === "manipulative") {
        window.Inkyscib?.Manipulatives?.afterTileCreated?.(createdPath, createdIndex);
      } else if (createdPath && !promotedByAssist && window.Inkyscib?.SmartGeometry?.afterPathCreated) {
        window.Inkyscib.SmartGeometry.afterPathCreated(createdPath, createdIndex);
      }
  }
  function fixShapeClickSizeIfNeeded(startClient, endClient) {
    const s = state();
    if (s.currentTool !== "shape" || !s.currentPath || !s.currentPath.points || s.currentPath.points.length < 2) return;

    const dx = endClient.x - startClient.x;
    const dy = endClient.y - startClient.y;
    const dist = Math.hypot(dx, dy);

    if (dist < 5) {
      if (isSmartShapePath(s.currentPath)) {
        const geometry = smartGeometryApi();
        if (geometry?.isSmartCircle?.(s.currentPath) && geometry.setDefaultCircleSize) {
          geometry.setDefaultCircleSize(s.currentPath, s.toolSettings?.shape?.size);
        } else {
          // Collapse a jitter-sized polygon so finalization supplies its useful default size.
          const anchor = s.currentPath.draftStart || s.currentPath.points[0];
          if (anchor && Number.isFinite(anchor.x) && Number.isFinite(anchor.y)) {
            s.currentPath.points = s.currentPath.points.map(() => ({ ...anchor }));
          }
          finalizeSmartShape(s.currentPath);
        }
        return;
      }
      const size = s.toolSettings?.shape?.size ?? 30;
      const p1 = s.currentPath.points[0];
      s.currentPath.points[1] = { x: p1.x + size, y: p1.y + size };
    }
  }
  function handleMouseDown(e) {
    const canvas = getCanvas();
    const s = state();
    if (s.clearAnimation) return;
    if (e.button === 1) {
      e.preventDefault();
      const point = clientToCanvas(e.clientX, e.clientY);
      s.isPanning = true;
      s.isDrawing = false;
      s.start = point;
      canvas.style.cursor = "grabbing";
      return;
    }
    if (e.button === 0) {
      if (s.panMode && !s.arMode) {
        const point = clientToCanvas(e.clientX, e.clientY);
        s.isPanning = true;
        s.isDrawing = false;
        s.start = point;
        canvas.style.cursor = "grabbing";
      } else {
        if (s.currentTool !== "select" && s.currentTool !== "eraser") clearSelectionForCanvasAction();
        if (s.currentTool === "eraser" && armEraserHold(e, "mouse")) return;
        if (s.currentTool === "select" && window.Inkyscib?.Selection?.handleDown) {
          window.Inkyscib.Selection.handleDown(e);
          return;
        }
        if (s.currentTool === "compass" && window.Inkyscib?.Compass?.handleDown) {
          window.Inkyscib.Compass.handleDown(e);
          return;
        }
        if (s.currentTool === "angle" && window.Inkyscib?.AngleTool?.handleDown) {
          window.Inkyscib.AngleTool.handleDown(e);
          return;
        }
        if (isCustomTriangleMode()) {
          handleCustomTrianglePoint(e);
          return;
        }
        startDrawing(e);
      }
    }
  }

  function handleMouseMove(e) {
    const canvas = getCanvas();
    const s = state();
    if (window.sizePreview && window.sizePreview.isVisible) {
      window.sizePreview.updatePosition(e.clientX, e.clientY);
    }

    if (continueEraserHold(e, "mouse")) return;

    if (s.isPanning) {
      const point = clientToCanvas(e.clientX, e.clientY);
      const dx = point.x - s.start.x;
      const dy = point.y - s.start.y;
      s.transform.offsetX += dx;
      s.transform.offsetY += dy;
      if (typeof window.clampPptTransform === "function" && s.ppt?.active) {
        window.clampPptTransform();
      } else if (typeof window.clampNotebookTransform === "function" && s.notebook?.active) {
        window.clampNotebookTransform();
      }
      s.start = point;
      requestRedraw();
      return;
    }

    if (s.currentTool === "select" && window.Inkyscib?.Selection?.handleMove) {
      window.Inkyscib.Selection.handleMove(e);
      return;
    }

    if (s.currentTool === "compass" && window.Inkyscib?.Compass?.handleMove) {
      window.Inkyscib.Compass.handleMove(e);
      return;
    }
    if (s.currentTool === "angle" && window.Inkyscib?.AngleTool?.handleMove?.(e)) return;

    if (updateCustomTrianglePreview(e)) return;

    updateConstructionHover(e);

    if (s.isDrawing) continueDrawing(e);
  }

  function handleMouseUp(e) {
    const canvas = getCanvas();
    const s = state();
    const wasPanning = s.isPanning;

    if (e.button === 1) {
      s.isPanning = false;
      canvas.style.cursor = s.panMode ? "grab" : "default";
      if (wasPanning) safeSavePreferences();
      return;
    }

    if (e.button === 0) {
      if (finishEraserHold(e, "mouse")) return;
      if (s.isPanning) {
        s.isPanning = false;
        canvas.style.cursor = s.panMode ? "grab" : "default";
        if (wasPanning) safeSavePreferences();
      } else if (s.currentTool === "select" && window.Inkyscib?.Selection?.handleUp) {
        window.Inkyscib.Selection.handleUp(e);
        return;
      } else if (s.currentTool === "compass" && window.Inkyscib?.Compass?.handleUp) {
        window.Inkyscib.Compass.handleUp(e);
        return;
      } else if (isCustomTriangleActive()) {
        return;
      } else if (s.isDrawing) {
        fixShapeClickSizeIfNeeded(
          { x: s._mouseDownX ?? e.clientX, y: s._mouseDownY ?? e.clientY },
          { x: e.clientX, y: e.clientY }
        );
        endDrawing();
      }
    }
  }

  function handleMouseLeave() {
    const s = state();
    const canvas = getCanvas();
    const wasPanning = s.isPanning;

    s.isDrawing = false;
    s.isPanning = false;
    clearEraserHold(true);
    if (wasPanning) safeSavePreferences();
    if (window.Inkyscib?.Selection?.handleUp) window.Inkyscib.Selection.handleUp();

    if (window.sizePreview) window.sizePreview.hide();
    clearConstructionSnaps();
    if (canvas) canvas.style.cursor = s.panMode ? "grab" : "default";
  }
  function trackMouseDownPoint(e) {
    const s = state();
    if (e.button === 0) {
      s._mouseDownX = e.clientX;
      s._mouseDownY = e.clientY;
    }
  }
  const pointers = new Map();

  const ERASER_HOLD_MS = 520;
  const ERASER_HOLD_SLOP_PX = 9;
  let eraserHold = null;

  function heldEvent(e) {
    return {
      clientX: e.clientX,
      clientY: e.clientY,
      pointerType: e.pointerType || "mouse",
      pressure: e.pressure,
      timeStamp: e.timeStamp,
      getCoalescedEvents: () => []
    };
  }

  function clearEraserHold(cancelLasso = false) {
    if (!eraserHold) return;
    if (eraserHold.timer) window.clearTimeout(eraserHold.timer);
    if (cancelLasso) window.Inkyscib?.Eraser?.cancelLasso?.();
    eraserHold = null;
  }

  function armEraserHold(e, pointerId) {
    const s = state();
    const eraser = window.Inkyscib?.Eraser;
    if (s?.currentTool !== "eraser" || !eraser?.beginLasso) return false;

    clearSelectionForCanvasAction();
    const down = heldEvent(e);
    const world = getDrawingPoint(down);
    eraserHold = {
      pointerId,
      down,
      world,
      startClient: { x: e.clientX, y: e.clientY },
      active: false,
      timer: window.setTimeout(() => {
        if (!eraserHold || eraserHold.pointerId !== pointerId) return;
        eraserHold.active = true;
        eraserHold.timer = null;
        eraser.beginLasso(eraserHold.world);
        announceGesture("Lasso erase");
        if (navigator.vibrate) navigator.vibrate(18);
      }, ERASER_HOLD_MS)
    };
    return true;
  }

  function continueEraserHold(e, pointerId) {
    if (!eraserHold || eraserHold.pointerId !== pointerId) return false;
    if (eraserHold.active) {
      window.Inkyscib?.Eraser?.extendLasso?.(getDrawingPoint(e));
      return true;
    }

    const moved = Math.hypot(
      e.clientX - eraserHold.startClient.x,
      e.clientY - eraserHold.startClient.y
    );
    if (moved < ERASER_HOLD_SLOP_PX) return true;

    const down = eraserHold.down;
    clearEraserHold();
    startDrawing(down);
    continueDrawing(e);
    return true;
  }

  function finishEraserHold(e, pointerId) {
    if (!eraserHold || eraserHold.pointerId !== pointerId) return false;
    const active = eraserHold.active;
    const down = eraserHold.down;
    clearEraserHold();

    if (active) {
      window.Inkyscib?.Eraser?.finishLasso?.(getDrawingPoint(e));
      return true;
    }

    // A quick tap is still a normal eraser dab.
    startDrawing(down);
    continueDrawing(e);
    endDrawing();
    return true;
  }
  let lastPinchDist = null;
  let lastPinchMid = null;

  function getTwoPointers() {
    const arr = Array.from(pointers.values());
    return [arr[0], arr[1]];
  }

  function midpoint(a, b) {
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }

  function dist(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  function capturePointer(canvas, pointerId) {
    try {
      canvas?.setPointerCapture?.(pointerId);
    } catch (_) {
      // Some older WebViews reject capture during a cancelled/synthetic touch.
    }
  }

  function releasePointer(canvas, pointerId) {
    try {
      if (!canvas?.hasPointerCapture || canvas.hasPointerCapture(pointerId)) {
        canvas?.releasePointerCapture?.(pointerId);
      }
    } catch (_) {
      // The pointer may already have been released by the browser.
    }
  }

  // A gesture has no button to light up and no tooltip, so without this a
  // screen reader user gets silence and a sighted user gets only whatever the
  // canvas happens to redraw. One shared live region for both.
  let liveRegion = null;

  function announceGesture(message) {
    if (!liveRegion) {
      liveRegion = document.getElementById("inkyscibLiveRegion");
      if (!liveRegion) {
        liveRegion = document.createElement("div");
        liveRegion.id = "inkyscibLiveRegion";
        liveRegion.className = "sr-only";
        liveRegion.setAttribute("role", "status");
        liveRegion.setAttribute("aria-live", "polite");
        document.body.appendChild(liveRegion);
      }
    }
    // Re-announce an identical message: assistive tech ignores an unchanged
    // node, and pressing undo twice should say "Undo" twice.
    liveRegion.textContent = "";
    window.setTimeout(() => {
      if (liveRegion) liveRegion.textContent = message;
    }, 30);
  }

  // ---------------------------------------------------------------------
  // Multi-touch tap gestures
  //
  // Undo is the most repeated action in handwriting, and on a tablet it cost a
  // trip to a 44px button in the top bar, away from where you are writing. Two
  // fingers to undo and three to redo is the convention in GoodNotes,
  // Notability and Procreate, so it is what a student arriving from those
  // already has in their hands.
  //
  // The hard part is telling a deliberate tap from a palm. A palm landing
  // mid-stroke also pushes the pointer count to two, and firing undo on that
  // would destroy the stroke the user is in the middle of writing. So the
  // gesture only arms when the extra fingers arrive *together with* the first
  // one - a palm arrives late, by definition, because a stroke was already
  // under way.
  const GESTURE_TAP_MS = 300;       // longer than this is a hold, not a tap
  const GESTURE_TOGETHER_MS = 200;  // fingers must land as one gesture
  const GESTURE_MOVE_SLOP = 10;     // canvas px; beyond this it is a pan or pinch

  let firstPointerDownAt = 0;
  let gesture = null;

  function armGesture(count) {
    gesture = { startedAt: performance.now(), maxPointers: count, moved: false };
  }

  function noteGesturePointer(count) {
    if (!gesture) return;
    if (count > gesture.maxPointers) gesture.maxPointers = count;
  }

  function markGestureMoved() {
    if (gesture) gesture.moved = true;
  }

  // Returns true when the release completed a tap gesture and it was handled.
  function resolveGesture() {
    const pending = gesture;
    gesture = null;
    if (!pending || pending.moved) return false;
    if (performance.now() - pending.startedAt > GESTURE_TAP_MS) return false;

    if (pending.maxPointers === 2) {
      if (typeof window.undo !== "function") return false;
      window.undo();
      announceGesture("Undo");
      return true;
    }
    if (pending.maxPointers === 3) {
      if (typeof window.redo !== "function") return false;
      window.redo();
      announceGesture("Redo");
      return true;
    }
    return false;
  }

  function onPointerDown(e) {
    const canvas = getCanvas();
    const s = state();
    if (s.clearAnimation) return;
    if (e.pointerType === "mouse") return;

    capturePointer(canvas, e.pointerId);
    const point = clientToCanvas(e.clientX, e.clientY);
    pointers.set(e.pointerId, {
      x: point.x,
      y: point.y,
      type: e.pointerType,
      downX: point.x,
      downY: point.y,
    });
    if (pointers.size === 1) {
      firstPointerDownAt = performance.now();
      gesture = null;
    }
    if (pointers.size >= 2) {
      clearEraserHold(true);
      // Late arrival means a palm, or a second finger joining an action already
      // in progress. Either way it is not a tap gesture, so leave it disarmed.
      if (pointers.size === 2) {
        if (performance.now() - firstPointerDownAt <= GESTURE_TOGETHER_MS) {
          armGesture(2);
        }
      } else {
        noteGesturePointer(pointers.size);
      }
      s.isDrawing = false;
      s.currentPath = null;

      s.isPanning = true;
      s.isTouchZooming = true;

      const [p1, p2] = getTwoPointers();
      lastPinchMid = midpoint(p1, p2);
      lastPinchDist = dist(p1, p2);

      return;
    }
    if (s.panMode) {
      s.isPanning = true;
      s.isDrawing = false;
      s.start = point;
      return;
    }
    if (s.currentTool !== "select" && s.currentTool !== "eraser") clearSelectionForCanvasAction();
    if (s.currentTool === "select" && window.Inkyscib?.Selection?.handleDown) {
      window.Inkyscib.Selection.handleDown(e);
      return;
    }
    if (s.currentTool === "compass" && window.Inkyscib?.Compass?.handleDown) {
      window.Inkyscib.Compass.handleDown(e);
      return;
    }
    if (s.currentTool === "angle" && window.Inkyscib?.AngleTool?.handleDown) {
      window.Inkyscib.AngleTool.handleDown(e);
      return;
    }
    if (isCustomTriangleMode()) {
      handleCustomTrianglePoint(e);
      return;
    }
    if (s.currentTool === "eraser" && armEraserHold(e, e.pointerId)) return;
    startDrawing(e);
  }

  function onPointerMove(e) {
    const canvas = getCanvas();
    const s = state();

    if (e.pointerType === "mouse") return;
    if (!pointers.has(e.pointerId)) return;

    e.preventDefault();

    const prev = pointers.get(e.pointerId);
    const point = clientToCanvas(e.clientX, e.clientY);
    // Measured from where this finger landed, not from the previous frame: a
    // slow drift is small every frame but large overall, and it is still a
    // drag rather than a tap.
    const downX = prev?.downX ?? point.x;
    const downY = prev?.downY ?? point.y;
    if (gesture && Math.hypot(point.x - downX, point.y - downY) > GESTURE_MOVE_SLOP) {
      markGestureMoved();
    }
    pointers.set(e.pointerId, {
      x: point.x,
      y: point.y,
      type: e.pointerType,
      downX,
      downY,
    });
    if (pointers.size >= 2) {
      const tg = ensureTarget();
      const [p1, p2] = getTwoPointers();

      const mid = midpoint(p1, p2);
      const d = dist(p1, p2);

      if (lastPinchDist && lastPinchMid) {
        const factor = d / lastPinchDist;
        const newScale = clampScale(tg.scale * factor);
        zoomAboutScreenPoint(tg, mid.x, mid.y, newScale);
        tg.offsetX += (mid.x - lastPinchMid.x);
        tg.offsetY += (mid.y - lastPinchMid.y);
        if (typeof window.clampPptTransform === "function" && s.ppt?.active) {
          window.clampPptTransform(tg);
        } else if (typeof window.clampNotebookTransform === "function" && s.notebook?.active) {
          window.clampNotebookTransform(tg);
        }

        startSmoothTransform();
      }

      lastPinchMid = mid;
      lastPinchDist = d;

      s.isTouchZooming = true;
      s.isPanning = true;
      s.isDrawing = false;
      s.currentPath = null;

      return;
    }
    if (s.panMode && s.isPanning) {
      const tg = ensureTarget();
      const dx = point.x - (s.start?.x ?? prev.x);
      const dy = point.y - (s.start?.y ?? prev.y);

      tg.offsetX += dx;
      tg.offsetY += dy;
      if (typeof window.clampPptTransform === "function" && s.ppt?.active) {
        window.clampPptTransform(tg);
      } else if (typeof window.clampNotebookTransform === "function" && s.notebook?.active) {
        window.clampNotebookTransform(tg);
      }

      s.start = point;
      startSmoothTransform();
      return;
    }
    if (continueEraserHold(e, e.pointerId)) return;
    if (s.currentTool === "select" && window.Inkyscib?.Selection?.handleMove) {
      window.Inkyscib.Selection.handleMove(e);
      return;
    }
    if (s.currentTool === "compass" && window.Inkyscib?.Compass?.handleMove) {
      window.Inkyscib.Compass.handleMove(e);
      return;
    }
    if (s.currentTool === "angle" && window.Inkyscib?.AngleTool?.handleMove?.(e)) return;
    if (updateCustomTrianglePreview(e)) return;
    updateConstructionHover(e);
    if (s.isDrawing) {
      continueDrawing(e);
    }
  }

  function onPointerUp(e) {
    const canvas = getCanvas();
    const s = state();
    const wasTransforming = s.isPanning || s.isTouchZooming;

    if (e.pointerType === "mouse") return;

    pointers.delete(e.pointerId);
    if (pointers.size < 2) {
      s.isTouchZooming = false;
      lastPinchDist = null;
      lastPinchMid = null;
    }
    if (pointers.size === 0) {
      s.isPanning = false;
      if (eraserHold?.pointerId === e.pointerId) {
        if (e.type === "pointercancel") {
          clearEraserHold(true);
        } else {
          finishEraserHold(e, e.pointerId);
        }
        releasePointer(canvas, e.pointerId);
        return;
      }
      // Resolved before the transform is committed below, because a tap moved
      // nothing and has no transform to commit. Undo redraws for itself.
      if (resolveGesture()) {
        releasePointer(canvas, e.pointerId);
        targetTransform = null;
        return;
      }
      if (wasTransforming && targetTransform) {
        if (rafId) {
          cancelAnimationFrame(rafId);
          rafId = null;
        }
        s.transform.scale = targetTransform.scale;
        s.transform.offsetX = targetTransform.offsetX;
        s.transform.offsetY = targetTransform.offsetY;
        targetTransform = null;
        requestRedraw();
      }
      if (s.isDrawing) {
        if (isCustomTriangleActive()) {
          releasePointer(canvas, e.pointerId);
          return;
        }
        fixShapeClickSizeIfNeeded(
          { x: s._touchDownX ?? e.clientX, y: s._touchDownY ?? e.clientY },
          { x: e.clientX, y: e.clientY }
        );
        endDrawing();
      } else if (s.currentTool === "select" && window.Inkyscib?.Selection?.handleUp) {
        window.Inkyscib.Selection.handleUp(e);
      } else if (s.currentTool === "compass" && window.Inkyscib?.Compass?.handleUp) {
        window.Inkyscib.Compass.handleUp(e);
      }

      releasePointer(canvas, e.pointerId);
      if (wasTransforming) safeSavePreferences();
    }
  }
  function trackTouchDownPoint(e) {
    const s = state();
    if (e.pointerType !== "mouse") {
      s._touchDownX = e.clientX;
      s._touchDownY = e.clientY;
    }
  }
  function handleWheel(e) {
    const s = state();
    if (s.clearAnimation) return;
    if (s.arMode) return;

    if (s.notebook?.active && !e.ctrlKey) {
      e.preventDefault();
      s.transform.offsetY -= e.deltaY;
      if (typeof window.clampNotebookTransform === "function") {
        window.clampNotebookTransform();
      }
      requestRedraw();
      safeSavePreferences();
      return;
    }

    if (!e.ctrlKey) return;

    e.preventDefault();

    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    const newScale = clampScale(s.transform.scale * factor);
    const point = clientToCanvas(e.clientX, e.clientY);
    zoomAboutScreenPoint(s.transform, point.x, point.y, newScale);
    if (typeof window.clampPptTransform === "function" && s.ppt?.active) {
      window.clampPptTransform();
    } else if (typeof window.clampNotebookTransform === "function" && s.notebook?.active) {
      window.clampNotebookTransform();
    }

    requestRedraw();
    safeSave();
  }

  function handleCanvasDoubleClick(e) {
    if (e.button !== 0 || typeof window.setTool !== "function") return;
    e.preventDefault();
    window.Inkyscib?.Selection?.clear?.({ render: false });
    window.setTool("pen");
    window.Inkyscib?.ToolDock?.setCollapsed?.(true);
    requestRedraw();
  }
  // ---------------------------------------------------------------------
  // Keyboard command layer
  //
  // This is a stylus tool: the hand that is not drawing has nothing to do, and
  // every tool change used to be a round trip from the drawing point out to a
  // 44px target in the rail and back. The letters follow the conventions
  // people already carry from other drawing applications (V for select, P for
  // pen, E for eraser) so the muscle memory transfers.
  //
  // This map is the single source of truth: the tooltips are generated from it
  // at startup, so a binding and its label cannot drift apart.
  const TOOL_SHORTCUTS = {
    v: "select",
    p: "pen",
    e: "eraser",
    h: "highlight",
    s: "shape",
    l: "line",
    c: "compass",
    a: "angle",
    t: "manipulative",
  };

  // Derived from TOOL_SHORTCUTS rather than written out again, so the keymap
  // stays the single place a binding is declared.
  const CODE_SHORTCUTS = Object.fromEntries(
    Object.entries(TOOL_SHORTCUTS).map(([key, tool]) => ["Key" + key.toUpperCase(), tool])
  );

  function codeToTool(code) {
    return code ? CODE_SHORTCUTS[code] : undefined;
  }

  // A field has focus, so the keystroke is text, not a command. TEXTAREA,
  // SELECT and contenteditable are listed ahead of need: the planned text tool
  // only has to focus a field for the whole layer to step aside.
  function isTypingTarget(target) {
    if (!target) return false;
    if (target.isContentEditable) return true;
    const tag = target.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
  }

  // Overlays that own the whole screen. Unmodified letters were inert before
  // the command layer existed, so nothing needed this; now a stray "e" typed
  // with the planner open would quietly swap the tool on the canvas behind it.
  // The YouTube runtime and the geometry sheet are deliberately absent: you are
  // meant to keep drawing with those open.
  const BLOCKING_OVERLAYS = ["planner-open", "library-open", "menu-open", "help-sheet-open"];

  function isOverlayOpen() {
    const classes = document.body.classList;
    return BLOCKING_OVERLAYS.some((name) => classes.contains(name));
  }

  // Sizes are changed through the tool's own slider rather than by writing to
  // appState, so the number field, the on-canvas size preview and the
  // preference save all update through the paths they already use.
  function adjustCurrentToolSize(direction) {
    const s = state();
    const slider = document.getElementById(`${s.currentTool}Size`);
    if (!slider) return false;

    const step = Number(slider.step) || 1;
    const min = Number(slider.min);
    const max = Number(slider.max);
    const current = Number(slider.value);
    if (!Number.isFinite(current)) return false;

    let next = current + direction * step;
    if (Number.isFinite(min)) next = Math.max(min, next);
    if (Number.isFinite(max)) next = Math.min(max, next);
    // Steps like 0.5 accumulate float noise otherwise.
    next = Math.round(next * 1000) / 1000;
    if (next === current) return false;

    slider.value = next;
    slider.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  }

  // Tooltips are written from the keymap so the rail always advertises the
  // binding that is actually live.
  function labelToolShortcuts() {
    Object.entries(TOOL_SHORTCUTS).forEach(([key, tool]) => {
      const button = document.getElementById(`${tool}Tool`);
      if (!button) return;
      const base = button.getAttribute("aria-label") || button.title || tool;
      const shortcut = key.toUpperCase();
      if (base.endsWith(`(${shortcut})`)) return;
      button.title = `${base} (${shortcut})`;
      button.setAttribute("aria-keyshortcuts", shortcut);
    });
  }

  function handleKeyboardShortcuts(e) {
    if (document.body.classList.contains("feature-tour-open")) return;
    if (document.body.classList.contains("clear-confirm-open") || state().clearAnimation) return;
    if (isTypingTarget(e.target)) return;

    const s = state();
    const canvas = getCanvas();
    if (e.key === "Escape") {
      if (cancelCustomTriangle()) {
        e.preventDefault();
        return;
      }
      if (s.currentTool === "select" && window.Inkyscib?.Selection?.clear) {
        window.Inkyscib.Selection.clear();
        e.preventDefault();
        return;
      }
    }
    if (e.key === "Escape" && s.currentTool === "compass" && window.Inkyscib?.Compass?.cancel) {
      e.preventDefault();
      window.Inkyscib.Compass.cancel();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !e.shiftKey) {
      e.preventDefault();
      if (typeof window.undo === "function") window.undo();
    }
    if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === "y" || (e.shiftKey && e.key === "Z"))) {
      e.preventDefault();
      if (typeof window.redo === "function") window.redo();
    }

    if ((e.ctrlKey || e.metaKey) && e.key === "Delete") {
      e.preventDefault();
      if (typeof window.clearCanvas === "function") {
        window.clearCanvas();
      }
    }
    if (!e.ctrlKey && !e.metaKey && (e.key === "Delete" || e.key === "Backspace") && s.currentTool === "select") {
      if (window.Inkyscib?.Selection?.deleteSelected?.()) {
        e.preventDefault();
        return;
      }
    }
    if (e.key === " " && !e.repeat) {
      if (s.arMode) return;
      e.preventDefault();
      if (!s.spacePan) {
        s.spacePan = true;
        s.previousTool = s.currentTool;
        if (typeof window.setPanMode === "function") window.setPanMode(true);
        if (canvas) canvas.style.cursor = "grab";
      }
    }

    // Everything below is an unmodified key, so Ctrl/Cmd/Alt combinations
    // (Ctrl+S to save, Ctrl+P to print) are left to the browser and to the
    // File ribbon.
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (s.arMode || isOverlayOpen()) return;

    if (e.key === "[" || e.key === "]") {
      if (adjustCurrentToolSize(e.key === "]" ? 1 : -1)) e.preventDefault();
      return;
    }

    // An infinite canvas needs a way back. resetView has always existed and
    // has never been reachable from the interface.
    if (e.key === "0") {
      if (typeof window.resetView === "function") {
        e.preventDefault();
        window.resetView();
      }
      return;
    }

    // `e.key` is the character the layout produces, so on a Cyrillic or Greek
    // layout the physical V key reports a letter that is not in this map and
    // every shortcut silently does nothing, with no error to explain it.
    // `e.code` is the physical key regardless of layout. `e.key` stays as the
    // fallback for the rare keyboard that reports no code.
    const shortcutTool = codeToTool(e.code) || TOOL_SHORTCUTS[e.key.toLowerCase()];
    if (shortcutTool && !e.repeat) {
      if (typeof window.setTool !== "function") return;
      e.preventDefault();
      if (typeof window.closeAllToolboxes === "function") window.closeAllToolboxes();
      window.setTool(shortcutTool);
      // The rail button lights up, but a keyboard user may not be looking at
      // the rail and a screen reader user cannot see it at all.
      announceGesture(window.Inkyscib?.Shortcuts?.labels?.[shortcutTool] || shortcutTool);
    }
  }

  function handleSpaceUp(e) {
    if (e.key !== " ") return;

    const s = state();
    if (!s.spacePan) return;

    s.spacePan = false;
    if (typeof window.setPanMode === "function") window.setPanMode(false);
    if (typeof window.setTool === "function") window.setTool(s.previousTool || "pen");
  }
  function setupModeIndicators() {
    document.addEventListener("toolChanged", (e) => {
      clearEraserHold(true);
      updateCursor(e.detail.tool);
      clearConstructionSnaps();
    });

    document.addEventListener("panModeChanged", (e) => {
      updateCursor(e.detail.enabled ? "pan" : state().currentTool);
    });

    updateCursor(state().currentTool);
  }

  function updateCursor(mode) {
    const canvas = getCanvas();
    if (!canvas) return;

    const s = state();

    canvas.classList.remove(
      "cursor-pen",
      "cursor-eraser",
      "cursor-highlight",
      "cursor-line",
      "cursor-select",
      "cursor-pan",
      "cursor-grabbing"
    );

    if (s.isPanning) {
      canvas.classList.add("cursor-grabbing");
      canvas.style.cursor = "grabbing";
      return;
    }

    if (mode === "pan") {
      canvas.classList.add("cursor-pan");
      canvas.style.cursor = "grab";
      return;
    }

    switch (mode) {
      case "pen":
      case "highlight":
      case "line":
      case "shape":
        canvas.style.cursor = "crosshair";
        break;
      case "select":
        canvas.classList.add("cursor-select");
        canvas.style.cursor = "default";
        break;
      case "eraser":
        canvas.style.cursor = "cell";
        break;
      default:
        canvas.style.cursor = "default";
    }
  }
  function initEventHandlers() {
    const canvas = getCanvas();
    if (!canvas) return;
    canvas.addEventListener("mousedown", trackMouseDownPoint);
    canvas.addEventListener("mousedown", handleMouseDown);
    canvas.addEventListener("mousemove", handleMouseMove);
    canvas.addEventListener("mouseup", handleMouseUp);
    canvas.addEventListener("mouseleave", handleMouseLeave);
    canvas.style.touchAction = "none";
    canvas.addEventListener("pointerdown", trackTouchDownPoint, { passive: false });
    canvas.addEventListener("pointerdown", onPointerDown, { passive: false });
    canvas.addEventListener("pointermove", onPointerMove, { passive: false });
    if ("onpointerrawupdate" in window) {
      canvas.addEventListener("pointerrawupdate", onPointerRawUpdate, { passive: true });
    }
    canvas.addEventListener("pointerup", onPointerUp, { passive: false });
    canvas.addEventListener("pointercancel", onPointerUp, { passive: false });
    canvas.addEventListener("wheel", handleWheel, { passive: false });
    canvas.addEventListener("dblclick", handleCanvasDoubleClick);
    document.addEventListener("keydown", handleKeyboardShortcuts);
    labelToolShortcuts();
    document.addEventListener("keyup", handleSpaceUp);
    canvas.addEventListener("click", safeCloseToolboxes);

    setupModeIndicators();
    console.log("Event handlers initialized (recode)");
  }

  document.addEventListener("DOMContentLoaded", initEventHandlers);
  window.Inkyscib = window.Inkyscib || {};

  // Published so the help card can list the bindings from the same map the
  // handler dispatches on: a shortcut cannot end up documented but unbound, or
  // bound but undocumented.
  window.Inkyscib.Shortcuts = {
    tools: TOOL_SHORTCUTS,
    // Tool buttons that rewrite their own label - the shape button renames
    // itself for whichever shape is loaded - call this afterwards to get the
    // key suffix back, instead of each of them hard-coding a letter.
    applyLabels: labelToolShortcuts,
    labels: {
      select: "Select",
      pen: "Pen",
      eraser: "Eraser",
      highlight: "Highlighter",
      shape: "Shape",
      line: "Line",
      compass: "Compass",
      angle: "Angle",
      manipulative: "Algebra tiles",
    },
    global: [
      { keys: "[ ]", label: "Smaller / bigger" },
      { keys: "0", label: "Reset the view" },
      { keys: "Space", label: "Hold to pan" },
      { keys: "Ctrl+Z", label: "Undo" },
      { keys: "Ctrl+Y", label: "Redo" },
    ],
    // Pan and pinch already worked and were never written down anywhere. A
    // gesture nobody documents is a gesture nobody finds.
    gestures: [
      { label: "Two-finger tap", action: "Undo" },
      { label: "Three-finger tap", action: "Redo" },
      { label: "Two-finger drag", action: "Move around the canvas" },
      { label: "Pinch", action: "Zoom in and out" },
    ],
  };

  window.Inkyscib.Events = {
    initEventHandlers,
    handleMouseDown,
    handleMouseMove,
    handleMouseUp,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    startDrawing,
    continueDrawing,
    endDrawing,
    handleWheel,
    handleKeyboardShortcuts,
    updateCursor,
  };
})();
