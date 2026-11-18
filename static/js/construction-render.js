// Rendering layer for construction geometry.
//
// Drawing only: every coordinate, angle and intersection handed to this file
// has already been computed by GeometryEngine / Construction. Nothing here
// calculates geometry (spec §35).
//
// canvas.js transforms the context into world space before calling in, so all
// coordinates are world coordinates. Stroke widths are divided by the zoom
// scale so construction guides keep a constant weight on screen instead of
// getting heavier as you zoom in.
(function () {
  "use strict";
  // The master switch (static/js/measurements.js) hides every label at once
  // without touching what each object remembers, so turning it back on
  // restores them individually.
  function measurementsVisible() {
    return window.Inkyscib?.Measurements?.visible?.() !== false;
  }


  const G = () => window.Inkyscib?.GeometryEngine;
  const C = () => window.Inkyscib?.Construction;


  function isLight() {
    return document.documentElement.dataset.theme === "light";
  }

  function palette() {
    const light = isLight();
    return {
      ink: light ? "#0f172a" : "#f8fafc",
      construction: light ? "rgba(15, 23, 42, 0.45)" : "rgba(248, 250, 252, 0.42)",
      guide: light ? "rgba(90, 90, 255, 0.5)" : "rgba(165, 165, 255, 0.55)",
      accent: light ? "#4338ca" : "#a5a5ff",
      label: light ? "#334155" : "#cbd5e1",
      halo: light ? "rgba(255, 255, 255, 0.9)" : "rgba(10, 12, 18, 0.85)"
    };
  }

  function scale() {
    return Math.max(0.05, window.appState?.transform?.scale || 1);
  }

  // world units that render as `pixels` on screen
  function px(pixels) {
    return pixels / scale();
  }

  function setStroke(ctx, color, widthPx, dashPx) {
    ctx.strokeStyle = color;
    ctx.lineWidth = px(widthPx);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.setLineDash(Array.isArray(dashPx) ? dashPx.map(px) : []);
  }

  function drawLabel(ctx, text, position, colors, offsetPx = 9) {
    if (!text) return;
    const size = px(12);
    ctx.save();
    ctx.font = `600 ${size}px 'Segoe UI', system-ui, sans-serif`;
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    const x = position.x + px(offsetPx);
    const y = position.y - px(offsetPx);
    // halo keeps the label readable over dense construction lines
    ctx.lineWidth = px(3);
    ctx.strokeStyle = colors.halo;
    ctx.strokeText(text, x, y);
    ctx.fillStyle = colors.label;
    ctx.fillText(text, x, y);
    ctx.restore();
  }

  // ---------- stored geometry ----------

  function drawPoint(ctx, path, colors) {
    const centre = C().center(path);
    if (!centre) return;
    const r = px(3.5);
    ctx.save();
    ctx.beginPath();
    ctx.arc(centre.x, centre.y, r, 0, Math.PI * 2);
    ctx.fillStyle = path.origin === "intersection" ? colors.accent : colors.ink;
    ctx.fill();
    ctx.lineWidth = px(1.5);
    ctx.strokeStyle = colors.halo;
    ctx.stroke();
    ctx.restore();
    drawLabel(ctx, path.label, centre, colors);
  }

  function drawArcPath(ctx, path, colors) {
    const centre = C().center(path);
    const engine = G();
    if (!centre || !engine || !engine.isFiniteNumber(path.radius)) return;
    if (path.radius <= 0) return;

    const construction = path.isConstruction !== false;
    ctx.save();
    setStroke(
      ctx,
      path.color || (construction ? colors.construction : colors.ink),
      path.color ? 1.7 : (construction ? 1.25 : 2),
      path.color ? null : (construction ? [5, 4] : null)
    );
    ctx.beginPath();
    if (path.geomType === "circle" || path.full) {
      ctx.arc(centre.x, centre.y, path.radius, 0, Math.PI * 2);
    } else {
      // canvas arc() sweeps counter-clockwise only when the last argument is
      // true; the engine's convention is increasing angle, which matches the
      // default direction here.
      ctx.arc(centre.x, centre.y, path.radius, path.startAngle, path.endAngle, false);
    }
    ctx.stroke();
    ctx.restore();
  }

  // Degrees, to one place, with the degree sign. One place is what a protractor
  // reads to; more would be pretending to a precision the pointer never had.
  function formatDegrees(radians) {
    const engine = G();
    if (!engine || !engine.isFiniteNumber(radians)) return "";
    let degrees = (radians * 180) / Math.PI;
    if (!Number.isFinite(degrees)) return "";
    degrees = Math.abs(degrees) % 360;
    // A constructed 60 degrees reads 60, not 59.9: float noise below 0.05 of
    // a whole degree is not a measurement a student should have to doubt.
    const whole = Math.round(degrees);
    if (Math.abs(degrees - whole) < 0.05) return whole + "°";
    return degrees.toFixed(1) + "°";
  }

  // The swept angle, written just outside the arc at its midpoint so it never
  // sits on the curve itself.
  function drawArcAngle(ctx, path, colors) {
    const engine = G();
    const centre = C().center(path);
    if (!engine || !centre || path.geomType === "circle" || path.full) return;
    if (!engine.isFiniteNumber(path.startAngle) || !engine.isFiniteNumber(path.endAngle)) return;

    const sweep = engine.arcSweep(path.startAngle, path.endAngle);
    if (!(sweep > 1e-4)) return;

    const midAngle = path.startAngle + sweep / 2;
    const at = engine.pointOnCircleAt(centre, path.radius + px(14), midAngle);
    drawLabel(ctx, formatDegrees(sweep), at, colors, 0);
  }

  // A right angle gets the square that every textbook draws; anything else gets
  // an arc and a number. Reading "90.0°" where a square belongs is the tell of
  // a diagram drawn by something that does not know what a right angle is.
  function drawAngleMark(ctx, path, colors) {
    const engine = G();
    const vertex = C().center(path);
    if (!engine || !vertex) return;
    if (!engine.isFiniteNumber(path.startAngle) || !engine.isFiniteNumber(path.endAngle)) return;

    const radius = engine.isFiniteNumber(path.radius) && path.radius > 0 ? path.radius : px(28);
    const sweep = engine.arcSweep(path.startAngle, path.endAngle);
    if (!(sweep > 1e-4)) return;

    const accent = path.color || colors.accent;
    const isRight = Math.abs(sweep - Math.PI / 2) < 0.02;
    const weight = engine.isFiniteNumber(path.size) && path.size > 0 ? path.size : 1.7;

    ctx.save();
    setStroke(ctx, accent, weight);

    if (isRight) {
      const a = engine.pointOnCircleAt(vertex, radius, path.startAngle);
      const b = engine.pointOnCircleAt(vertex, radius, path.endAngle);
      const corner = {
        x: a.x + (b.x - vertex.x),
        y: a.y + (b.y - vertex.y)
      };
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(corner.x, corner.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.arc(vertex.x, vertex.y, radius, path.startAngle, path.endAngle, false);
      ctx.stroke();
    }
    ctx.restore();

    if (!measurementsVisible()) return;
    if (path.showAngle === false) return;

    const midAngle = path.startAngle + sweep / 2;
    const at = engine.pointOnCircleAt(vertex, radius + px(15), midAngle);
    drawLabel(ctx, isRight ? "90°" : formatDegrees(sweep), at, colors, 0);
  }

  function drawSegmentPath(ctx, path, colors) {
    const [a, b] = path.points || [];
    if (!a || !b) return;
    const construction = path.isConstruction === true;
    ctx.save();
    setStroke(
      ctx,
      construction ? colors.construction : colors.ink,
      construction ? 1.25 : 2,
      construction ? [5, 4] : null
    );
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.restore();
  }

  // Entry point used by canvas.js's path dispatch.
  function drawPath(ctx, path) {
    const construction = C();
    if (!construction || !construction.isConstructionPath(path)) return;
    const colors = palette();

    if (path.geomType === "point") drawPoint(ctx, path, colors);
    else if (path.geomType === "segment") drawSegmentPath(ctx, path, colors);
    else if (path.geomType === "angle") drawAngleMark(ctx, path, colors);
    else {
      drawArcPath(ctx, path, colors);
      if (path.showAngle && measurementsVisible()) drawArcAngle(ctx, path, colors);
    }
  }

  // ---------- overlay (redrawn every frame, never cached) ----------

  // Every end of every drawn thing is somewhere a construction can be picked
  // up again, so it is marked rather than only being discoverable by hovering
  // over it. Past this many the rings stop being landmarks and become texture.
  const MAX_ENDPOINT_MARKERS = 120;

  function collectEndpoints(construction) {
    const engine = G();
    const idx = construction.rebuildIndex?.();
    if (!engine || !idx) return [];

    const out = [];
    const seen = new Set();
    const push = (point) => {
      if (!engine.isValidPoint(point)) return;
      const key = point.x.toFixed(3) + "," + point.y.toFixed(3);
      if (seen.has(key)) return;
      seen.add(key);
      out.push(point);
    };

    // a polygon's corner is the end of two edges; the key above collapses it
    idx.drawn.forEach((entry) =>
      entry.edges.forEach((edge) => {
        push(edge.a);
        push(edge.b);
      })
    );
    idx.segments.forEach((path) => {
      push(path.points?.[0]);
      push(path.points?.[1]);
    });
    idx.arcs.forEach((path) => {
      const centre = construction.center(path);
      if (!centre) return;
      push(engine.pointOnCircleAt(centre, path.radius, path.startAngle));
      push(engine.pointOnCircleAt(centre, path.radius, path.endAngle));
    });
    return out;
  }

  // A hollow ring, so an end never reads as the solid dot of a named point or
  // as the saltire of a crossing (spec §37: shape carries the meaning).
  function drawEndpointMarker(ctx, point, colors) {
    ctx.save();
    setStroke(ctx, colors.construction, 1.4);
    ctx.beginPath();
    ctx.arc(point.x, point.y, px(3), 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  // Past this many crossings the marks stop reading as landmarks and start
  // reading as static (a grid of ruled lines crosses itself everywhere), so
  // they are dropped. Snapping and the hover highlight are unaffected.
  const MAX_INTERSECTION_MARKERS = 60;

  function drawIntersectionMarker(ctx, point, colors, emphasised) {
    const size = px(emphasised ? 6 : 4);
    ctx.save();
    setStroke(ctx, colors.accent, emphasised ? 2 : 1.4);
    // a small saltire reads as "candidate", distinct from a solid point
    ctx.beginPath();
    ctx.moveTo(point.x - size, point.y - size);
    ctx.lineTo(point.x + size, point.y + size);
    ctx.moveTo(point.x + size, point.y - size);
    ctx.lineTo(point.x - size, point.y + size);
    ctx.stroke();
    if (emphasised) {
      ctx.beginPath();
      ctx.arc(point.x, point.y, px(9), 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  // Shape, not just colour, distinguishes the snap state (spec §37).
  function drawSnapIndicator(ctx, snap, colors) {
    if (!snap) return;
    ctx.save();
    setStroke(ctx, colors.accent, 1.8);
    ctx.beginPath();
    ctx.arc(snap.x, snap.y, px(8), 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(snap.x, snap.y, px(2), 0, Math.PI * 2);
    ctx.fillStyle = colors.accent;
    ctx.fill();
    ctx.restore();

    const text = snap.label || SNAP_LABELS[snap.type] || null;
    if (text) drawLabel(ctx, text, snap, colors, 11);
  }

  const SNAP_LABELS = {
    intersection: "Intersection",
    midpoint: "Midpoint",
    center: "Centre",
    endpoint: "Endpoint",
    "arc-endpoint": "Arc end",
    "on-geometry": null
  };

  // Minimal preview: where the needle is, how far the pencil is, and the arc
  // that would be drawn. No drawn instrument — the point is to see the
  // geometry, not a picture of a compass.
  function drawCompassPreview(ctx, preview, colors) {
    if (!preview || !preview.center) return;
    const engine = G();
    if (!engine) return;

    const { center, radius } = preview;
    const accent = preview.color || colors.accent;

    // needle
    ctx.save();
    ctx.beginPath();
    ctx.arc(center.x, center.y, px(3.5), 0, Math.PI * 2);
    ctx.fillStyle = accent;
    ctx.fill();
    ctx.restore();

    if (!engine.isFiniteNumber(radius) || radius <= 0) return;

    const angle = engine.isFiniteNumber(preview.endAngle)
      ? preview.endAngle
      : preview.cursor ? engine.angleOf(center, preview.cursor) : 0;
    const tip = engine.pointOnCircleAt(center, radius, angle);

    // radius guide: the opening, shown as a thin leader
    ctx.save();
    setStroke(ctx, accent, 1.1, [4, 4]);
    ctx.globalAlpha = 0.75;
    ctx.beginPath();
    ctx.moveTo(center.x, center.y);
    ctx.lineTo(tip.x, tip.y);
    ctx.stroke();
    ctx.restore();

    // the arc that would land
    ctx.save();
    if (preview.mode === "circle") {
      setStroke(ctx, accent, 1.5, [6, 5]);
      ctx.beginPath();
      ctx.arc(center.x, center.y, radius, 0, Math.PI * 2);
    } else if (preview.sweeping) {
      setStroke(ctx, accent, 1.8);
      ctx.beginPath();
      ctx.arc(center.x, center.y, radius, preview.startAngle, preview.endAngle, false);
    } else {
      setStroke(ctx, accent, 1.4, [6, 5]);
      ctx.beginPath();
      ctx.arc(center.x, center.y, radius, 0, Math.PI * 2);
    }
    ctx.globalAlpha = preview.sweeping ? 1 : 0.55;
    ctx.stroke();
    ctx.restore();

    // pencil position
    ctx.save();
    ctx.beginPath();
    ctx.arc(tip.x, tip.y, px(3), 0, Math.PI * 2);
    ctx.fillStyle = accent;
    ctx.fill();
    ctx.restore();

    // The radius, on the opening itself while it is being set: the panel
    // that used to be the only place it showed is shut on a tablet, and the
    // finger is covering the pencil end anyway.
    if (preview.radiusText && (preview.measuring || !preview.sweeping)) {
      const mid = { x: (center.x + tip.x) / 2, y: (center.y + tip.y) / 2 };
      const normal = angle - Math.PI / 2;
      drawLabel(ctx, "r = " + preview.radiusText, {
        x: mid.x + Math.cos(normal) * px(16),
        y: mid.y + Math.sin(normal) * px(16)
      }, colors, 0);
    }
  }

  function drawSelection(ctx, point, colors) {
    if (!point) return;
    ctx.save();
    setStroke(ctx, colors.accent, 1.8);
    ctx.beginPath();
    ctx.arc(point.x, point.y, px(7), 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  // Three-point mode and the live reading: the taps so far, a guide to the
  // pointer, and the angle it would make, drawn at the mark's own radius.
  function drawAngleAim(ctx, overlay, colors) {
    const engine = G();
    if (!engine) return;
    const taps = overlay.taps || [];
    ctx.save();
    setStroke(ctx, colors.accent, 2.4);
    if (taps.length) {
      ctx.setLineDash([px(6), px(5)]);
      ctx.beginPath();
      if (taps.length === 1 && overlay.hover) {
        ctx.moveTo(taps[0].x, taps[0].y);
        ctx.lineTo(overlay.hover.x, overlay.hover.y);
      } else if (taps.length === 2) {
        ctx.moveTo(taps[0].x, taps[0].y);
        ctx.lineTo(taps[1].x, taps[1].y);
        if (overlay.hover) ctx.lineTo(overlay.hover.x, overlay.hover.y);
      }
      ctx.stroke();
      ctx.setLineDash([]);
      taps.forEach((point, index) => {
        ctx.beginPath();
        ctx.arc(point.x, point.y, px(index === 1 ? 6.5 : 5), 0, Math.PI * 2);
        ctx.fillStyle = index === 1 ? colors.accent : (colors.surface || colors.halo);
        ctx.fill();
        ctx.stroke();
      });
    }
    const p = overlay.preview;
    if (p && p.vertex) {
      const radius = overlay.markRadius || px(34);
      ctx.globalAlpha = 0.85;
      ctx.beginPath();
      ctx.arc(p.vertex.x, p.vertex.y, radius, p.start, p.end, false);
      ctx.stroke();
      ctx.globalAlpha = 1;
      // The reading sits by the pointer, where the eye already is, rather
      // than in a panel the finger is covering or the tablet has shut.
      const at = overlay.hover || engine.pointOnCircleAt(p.vertex, radius + px(18), p.start + engine.arcSweep(p.start, p.end) / 2);
      drawLabel(ctx, p.text, { x: at.x + px(22), y: at.y - px(22) }, colors, 0);
    }
    ctx.restore();
  }

  function drawPickedAngleSide(ctx, picked, colors) {
    if (!picked?.a || !picked?.b) return;
    ctx.save();
    setStroke(ctx, colors.accent, 3.2);
    ctx.globalAlpha = 0.9;
    ctx.beginPath();
    ctx.moveTo(picked.a.x, picked.a.y);
    ctx.lineTo(picked.b.x, picked.b.y);
    ctx.stroke();

    [picked.a, picked.b].forEach((point) => {
      ctx.beginPath();
      ctx.arc(point.x, point.y, px(5), 0, Math.PI * 2);
      ctx.fillStyle = colors.surface || colors.halo;
      ctx.fill();
      ctx.stroke();
    });

    if (picked.pickedAt) {
      ctx.beginPath();
      ctx.arc(picked.pickedAt.x, picked.pickedAt.y, px(4), 0, Math.PI * 2);
      ctx.fillStyle = colors.accent;
      ctx.fill();
    }
    ctx.restore();
  }

  function drawOverlay(ctx) {
    const compass = window.Inkyscib?.Compass;
    const construction = C();
    if (!construction) return;

    const colors = palette();
    const overlay = compass?.getOverlayState ? compass.getOverlayState() : null;
    const angleOverlay = window.Inkyscib?.AngleTool?.getOverlayState?.() || null;

    // A crossing belongs to the drawing, not to the tool that happened to be
    // open when it appeared. Once two arcs meet, the mark stays there under
    // every tool, so a line can be joined to it at any point later on.
    const intersections = construction.hasCrossableGeometry?.()
      ? construction.computeIntersections()
      : [];
    // Whoever is driving publishes the snap; the compass keeps its own copy
    // because it also snaps while the pointer is down.
    const snap = overlay?.snap || construction.getActiveSnap?.() || null;

    const marked = intersections.length > MAX_INTERSECTION_MARKERS ? [] : intersections;
    marked.forEach((point) => {
      // Once promoted to a real labelled point, the dot says it better than a
      // candidate cross drawn on top of it.
      if (construction.findPointAt?.(point)) return;
      const emphasised =
        snap &&
        snap.type === "intersection" &&
        Math.abs(snap.x - point.x) < 1e-6 &&
        Math.abs(snap.y - point.y) < 1e-6;
      drawIntersectionMarker(ctx, point, colors, emphasised);
    });

    const ends = collectEndpoints(construction);
    if (ends.length <= MAX_ENDPOINT_MARKERS) {
      ends.forEach((point) => {
        // a stored point already draws itself, as a filled dot with its name
        if (construction.findPointAt?.(point)) return;
        drawEndpointMarker(ctx, point, colors);
      });
    }

    if (overlay?.preview) drawCompassPreview(ctx, overlay.preview, colors);
    if (overlay?.selected) drawSelection(ctx, overlay.selected, colors);
    if (angleOverlay?.firstPicked) drawPickedAngleSide(ctx, angleOverlay.firstPicked, colors);
    if (angleOverlay) drawAngleAim(ctx, angleOverlay, colors);
    if (snap) drawSnapIndicator(ctx, snap, colors);
  }

  window.Inkyscib = window.Inkyscib || {};
  // Shared so labels drawn by the tools (a named line end, for one) match the
  // halo, weight and zoom behaviour of the ones drawn here.
  function drawLabelAt(ctx, text, position, offsetPx) {
    drawLabel(ctx, text, position, palette(), offsetPx);
  }

  window.Inkyscib.ConstructionRender = { drawPath, drawOverlay, palette, drawLabelAt, formatDegrees };
})();
