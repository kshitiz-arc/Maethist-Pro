// Mathematical geometry engine.
//
// Pure functions over plain {x, y} world coordinates. This file knows nothing
// about the DOM, the canvas, appState or rendering — that separation is what
// lets the compass, and later a ruler/protractor/parallel tool, share one
// correct implementation.
//
// Angle convention: angles are measured with Math.atan2(dy, dx) in world
// space. The canvas y axis points down, so a positive angle sweep appears
// clockwise on screen. Arcs always sweep from startAngle towards endAngle in
// the direction of increasing angle.
(function () {
  "use strict";

  const EPSILON = 1e-9;
  // Geometry produced from pointer input carries far more error than 1e-9;
  // "is this the same point the user already made" needs a world-space budget.
  const POINT_TOLERANCE = 1e-6;
  const TAU = Math.PI * 2;

  // ---------- scalar helpers ----------

  function isFiniteNumber(value) {
    return typeof value === "number" && Number.isFinite(value);
  }

  function approximatelyEqual(a, b, epsilon = EPSILON) {
    if (!isFiniteNumber(a) || !isFiniteNumber(b)) return false;
    const diff = Math.abs(a - b);
    if (diff <= epsilon) return true;
    // relative comparison so large coordinates stay comparable
    return diff <= epsilon * Math.max(Math.abs(a), Math.abs(b));
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function isValidPoint(point) {
    return !!point && isFiniteNumber(point.x) && isFiniteNumber(point.y);
  }

  // ---------- points ----------

  function distance(a, b) {
    if (!isValidPoint(a) || !isValidPoint(b)) return NaN;
    return Math.hypot(b.x - a.x, b.y - a.y);
  }

  function distanceSquared(a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    return dx * dx + dy * dy;
  }

  function pointEquals(a, b, tolerance = POINT_TOLERANCE) {
    if (!isValidPoint(a) || !isValidPoint(b)) return false;
    return distance(a, b) <= tolerance;
  }

  function midpoint(a, b) {
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }

  // ---------- angles ----------

  // Normalize to [0, TAU).
  function normalizeAngle(angle) {
    if (!isFiniteNumber(angle)) return 0;
    let a = angle % TAU;
    if (a < 0) a += TAU;
    // guard the case where a tiny negative rounds up to exactly TAU
    return a >= TAU ? 0 : a;
  }

  function angleOf(center, point) {
    return Math.atan2(point.y - center.y, point.x - center.x);
  }

  // Sweep from start to end in the direction of increasing angle, in [0, TAU].
  function arcSweep(startAngle, endAngle) {
    const start = normalizeAngle(startAngle);
    const end = normalizeAngle(endAngle);
    const sweep = normalizeAngle(end - start);
    return sweep;
  }

  // Is `angle` inside the arc's angular range?
  // A full circle (sweep >= TAU - eps, or an explicit full flag) contains
  // every angle.
  function angleInArc(angle, startAngle, endAngle, options = {}) {
    const tolerance = options.tolerance ?? 1e-9;
    if (options.full) return true;

    const sweep = arcSweep(startAngle, endAngle);
    // a degenerate/complete sweep is treated as a full circle
    if (sweep >= TAU - tolerance) return true;

    const relative = normalizeAngle(angle - normalizeAngle(startAngle));
    // tolerance at both ends so an intersection sitting exactly on an
    // endpoint still counts
    if (relative <= sweep + tolerance) return true;
    return relative >= TAU - tolerance;
  }

  function pointOnCircleAt(center, radius, angle) {
    return {
      x: center.x + radius * Math.cos(angle),
      y: center.y + radius * Math.sin(angle)
    };
  }

  // ---------- circle / circle ----------

  // Returns an array of 0, 1 or 2 points, plus a `kind` describing the
  // configuration so callers can give the user a real message rather than
  // guessing why nothing appeared.
  function circleCircleIntersection(c1, r1, c2, r2, options = {}) {
    const tolerance = options.tolerance ?? 1e-7;
    const empty = (kind) => Object.assign([], { kind });

    if (!isValidPoint(c1) || !isValidPoint(c2)) return empty("invalid");
    if (!isFiniteNumber(r1) || !isFiniteNumber(r2)) return empty("invalid");
    if (r1 <= tolerance || r2 <= tolerance) return empty("degenerate");

    const d = distance(c1, c2);
    if (!isFiniteNumber(d)) return empty("invalid");

    // Concentric: either identical circles (infinitely many intersections) or
    // none at all. Both are reported as "no discrete intersection".
    if (d <= tolerance) {
      return empty(Math.abs(r1 - r2) <= tolerance ? "coincident" : "concentric");
    }

    const sum = r1 + r2;
    const diff = Math.abs(r1 - r2);

    if (d > sum + tolerance) return empty("separate");
    if (d < diff - tolerance) return empty("contained");

    // a = signed distance from c1 to the radical line along c1->c2
    const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d);
    const hSquared = r1 * r1 - a * a;

    const ux = (c2.x - c1.x) / d;
    const uy = (c2.y - c1.y) / d;
    const base = { x: c1.x + a * ux, y: c1.y + a * uy };

    // External or internal tangency, or numerical noise pushing h² below zero.
    const tangent =
      Math.abs(d - sum) <= tolerance ||
      Math.abs(d - diff) <= tolerance ||
      hSquared <= tolerance * tolerance;

    if (tangent) {
      if (!isValidPoint(base)) return empty("invalid");
      return Object.assign([base], { kind: "tangent" });
    }

    const h = Math.sqrt(Math.max(0, hSquared));
    // perpendicular to c1->c2
    const p1 = { x: base.x - h * uy, y: base.y + h * ux };
    const p2 = { x: base.x + h * uy, y: base.y - h * ux };

    if (!isValidPoint(p1) || !isValidPoint(p2)) return empty("invalid");
    return Object.assign([p1, p2], { kind: "secant" });
  }

  // ---------- arcs ----------
  //
  // An arc is { center, radius, startAngle, endAngle, full }. `full: true`
  // means a complete circle, which lets circles and arcs share one code path.

  function isFullCircle(arc) {
    if (!arc) return false;
    if (arc.full) return true;
    if (!isFiniteNumber(arc.startAngle) || !isFiniteNumber(arc.endAngle)) return true;
    return arcSweep(arc.startAngle, arc.endAngle) >= TAU - 1e-9;
  }

  function pointOnArc(point, arc, options = {}) {
    const tolerance = options.tolerance ?? 1e-6;
    if (!isValidPoint(point) || !arc || !isValidPoint(arc.center)) return false;
    if (!approximatelyEqual(distance(point, arc.center), arc.radius, tolerance)) {
      if (Math.abs(distance(point, arc.center) - arc.radius) > tolerance) return false;
    }
    if (isFullCircle(arc)) return true;
    return angleInArc(angleOf(arc.center, point), arc.startAngle, arc.endAngle, {
      tolerance: options.angleTolerance ?? 1e-9
    });
  }

  // An arc drawn by hand almost never stops exactly on the crossing point: the
  // pointer lands a fraction of a degree short and the intersection falls just
  // outside [startAngle, endAngle]. A hard boundary would then report "no
  // intersection" for a construction that visibly crosses, which breaks the
  // headline perpendicular-bisector workflow.
  //
  // `endpointTolerance` is a forgiveness measured in world units along the arc.
  // Converting it per arc (angle = arcLength / radius) keeps the allowance a
  // constant on-screen distance regardless of how large the arc is. Callers
  // that want exact mathematics leave it at 0.
  function endpointAngleTolerance(arc, options) {
    const base = options.angleTolerance ?? 1e-9;
    const worldTolerance = options.endpointTolerance ?? 0;
    if (!(worldTolerance > 0) || !isFiniteNumber(arc.radius) || arc.radius <= EPSILON) {
      return base;
    }
    return Math.max(base, worldTolerance / arc.radius);
  }

  // The single entry point for arc/arc, arc/circle and circle/circle.
  // Computes the underlying circle intersection, then keeps only the points
  // that actually lie on both *visible* arcs — two overlapping circles do not
  // mean the drawn arcs cross.
  function arcArcIntersection(arcA, arcB, options = {}) {
    const raw = circleCircleIntersection(
      arcA.center, arcA.radius, arcB.center, arcB.radius, options
    );

    const toleranceA = endpointAngleTolerance(arcA, options);
    const toleranceB = endpointAngleTolerance(arcB, options);

    const filtered = raw.filter(
      (point) =>
        angleInArc(angleOf(arcA.center, point), arcA.startAngle, arcA.endAngle, {
          tolerance: toleranceA, full: isFullCircle(arcA)
        }) &&
        angleInArc(angleOf(arcB.center, point), arcB.startAngle, arcB.endAngle, {
          tolerance: toleranceB, full: isFullCircle(arcB)
        })
    );

    return Object.assign(filtered, { kind: raw.kind });
  }

  // ---------- line / segment ----------

  function projectPointOnLine(point, a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSquared = dx * dx + dy * dy;
    if (lengthSquared <= EPSILON) return { point: { x: a.x, y: a.y }, t: 0 };
    const t = ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared;
    return { point: { x: a.x + t * dx, y: a.y + t * dy }, t };
  }

  function pointOnSegment(point, a, b, tolerance = 1e-6) {
    if (!isValidPoint(point) || !isValidPoint(a) || !isValidPoint(b)) return false;
    const { point: projected, t } = projectPointOnLine(point, a, b);
    if (t < -tolerance || t > 1 + tolerance) return false;
    return distance(point, projected) <= tolerance;
  }

  // mode: "segment" (between a and b), "ray" (from a through b) or "line".
  function withinLineBounds(t, mode, tolerance) {
    if (mode === "line") return true;
    if (mode === "ray") return t >= -tolerance;
    return t >= -tolerance && t <= 1 + tolerance;
  }

  // Needed for the angle-bisector construction: an arc centred on the vertex
  // has to be intersected with the two rays forming the angle.
  function lineCircleIntersection(a, b, center, radius, options = {}) {
    const mode = options.mode || "segment";
    const tolerance = options.tolerance ?? 1e-7;
    const empty = (kind) => Object.assign([], { kind });

    if (!isValidPoint(a) || !isValidPoint(b) || !isValidPoint(center)) return empty("invalid");
    if (!isFiniteNumber(radius) || radius <= tolerance) return empty("degenerate");

    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSquared = dx * dx + dy * dy;
    if (lengthSquared <= EPSILON) return empty("degenerate");

    const fx = a.x - center.x;
    const fy = a.y - center.y;

    const A = lengthSquared;
    const B = 2 * (fx * dx + fy * dy);
    const C = fx * fx + fy * fy - radius * radius;

    let discriminant = B * B - 4 * A * C;
    if (discriminant < -tolerance) return empty("separate");
    if (discriminant < 0) discriminant = 0;

    const sqrtDisc = Math.sqrt(discriminant);
    const candidates = [];

    if (approximatelyEqual(discriminant, 0, tolerance)) {
      const t = -B / (2 * A);
      if (withinLineBounds(t, mode, tolerance)) {
        candidates.push({ x: a.x + t * dx, y: a.y + t * dy });
      }
      return Object.assign(candidates, { kind: "tangent" });
    }

    [(-B - sqrtDisc) / (2 * A), (-B + sqrtDisc) / (2 * A)].forEach((t) => {
      if (withinLineBounds(t, mode, tolerance)) {
        candidates.push({ x: a.x + t * dx, y: a.y + t * dy });
      }
    });

    return Object.assign(candidates, { kind: candidates.length ? "secant" : "out-of-range" });
  }

  function lineArcIntersection(a, b, arc, options = {}) {
    const raw = lineCircleIntersection(a, b, arc.center, arc.radius, options);
    const tolerance = endpointAngleTolerance(arc, options);
    const filtered = raw.filter((point) =>
      angleInArc(angleOf(arc.center, point), arc.startAngle, arc.endAngle, {
        tolerance, full: isFullCircle(arc)
      })
    );
    return Object.assign(filtered, { kind: raw.kind });
  }

  function lineLineIntersection(a1, a2, b1, b2, options = {}) {
    const mode = options.mode || "segment";
    const tolerance = options.tolerance ?? 1e-9;

    const d1x = a2.x - a1.x;
    const d1y = a2.y - a1.y;
    const d2x = b2.x - b1.x;
    const d2y = b2.y - b1.y;

    const denominator = d1x * d2y - d1y * d2x;
    if (Math.abs(denominator) <= tolerance) return null; // parallel or degenerate

    const t = ((b1.x - a1.x) * d2y - (b1.y - a1.y) * d2x) / denominator;
    const u = ((b1.x - a1.x) * d1y - (b1.y - a1.y) * d1x) / denominator;

    if (!withinLineBounds(t, mode, tolerance)) return null;
    if (!withinLineBounds(u, mode, tolerance)) return null;

    const point = { x: a1.x + t * d1x, y: a1.y + t * d1y };
    return isValidPoint(point) ? point : null;
  }

  // ---------- generic dispatch ----------
  //
  // Callers hold heterogeneous objects; this keeps the type-matching in one
  // place. Shapes: {kind:"arc"|"circle", center, radius, startAngle, endAngle}
  // and {kind:"segment", a, b, mode}.

  function toArcLike(object) {
    if (!object) return null;
    if (object.kind === "circle") {
      return { center: object.center, radius: object.radius, full: true, startAngle: 0, endAngle: TAU };
    }
    if (object.kind === "arc") {
      return {
        center: object.center,
        radius: object.radius,
        startAngle: object.startAngle,
        endAngle: object.endAngle,
        full: !!object.full
      };
    }
    return null;
  }

  function intersect(objectA, objectB, options = {}) {
    if (!objectA || !objectB) return Object.assign([], { kind: "invalid" });

    const arcA = toArcLike(objectA);
    const arcB = toArcLike(objectB);

    if (arcA && arcB) return arcArcIntersection(arcA, arcB, options);

    if (arcA && objectB.kind === "segment") {
      return lineArcIntersection(objectB.a, objectB.b, arcA, {
        ...options, mode: objectB.mode || "segment"
      });
    }
    if (arcB && objectA.kind === "segment") {
      return lineArcIntersection(objectA.a, objectA.b, arcB, {
        ...options, mode: objectA.mode || "segment"
      });
    }
    if (objectA.kind === "segment" && objectB.kind === "segment") {
      const point = lineLineIntersection(objectA.a, objectA.b, objectB.a, objectB.b, {
        ...options,
        mode: objectA.mode === "line" || objectB.mode === "line" ? "line" : "segment"
      });
      return Object.assign(point ? [point] : [], { kind: point ? "secant" : "separate" });
    }

    return Object.assign([], { kind: "unsupported" });
  }

  // ---------- coordinate transforms ----------
  //
  // events.js keeps a private screenToWorld; the construction layer needs the
  // pair available everywhere, so they live here against an explicit
  // transform {scale, offsetX, offsetY}.

  function worldToScreen(point, transform) {
    const scale = transform?.scale || 1;
    return {
      x: point.x * scale + (transform?.offsetX || 0),
      y: point.y * scale + (transform?.offsetY || 0)
    };
  }

  function screenToWorld(point, transform) {
    const scale = transform?.scale || 1;
    return {
      x: (point.x - (transform?.offsetX || 0)) / scale,
      y: (point.y - (transform?.offsetY || 0)) / scale
    };
  }

  // A screen-space threshold converted into world units, so snapping keeps a
  // constant feel in pixels at every zoom level.
  function screenDistanceToWorld(pixels, transform) {
    const scale = Math.max(1e-6, transform?.scale || 1);
    return pixels / scale;
  }

  window.Inkyscib = window.Inkyscib || {};
  window.Inkyscib.GeometryEngine = {
    EPSILON,
    POINT_TOLERANCE,
    TAU,

    isFiniteNumber,
    isValidPoint,
    approximatelyEqual,
    clamp,

    distance,
    distanceSquared,
    pointEquals,
    midpoint,

    normalizeAngle,
    angleOf,
    arcSweep,
    angleInArc,
    endpointAngleTolerance,
    pointOnCircleAt,
    isFullCircle,

    circleCircleIntersection,
    arcArcIntersection,
    lineCircleIntersection,
    lineArcIntersection,
    lineLineIntersection,
    intersect,

    projectPointOnLine,
    pointOnSegment,
    pointOnArc,

    worldToScreen,
    screenToWorld,
    screenDistanceToWorld
  };
})();
