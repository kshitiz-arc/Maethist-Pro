// MAETHIST strokes as PDF path operators.
//
// The canvas renderer in canvas.js draws ink as quadratic Béziers with round
// caps and joins. PDF draws cubic Béziers with round caps and joins. That is a
// lossless correspondence — a quadratic converts exactly to a cubic — so ink
// can leave the app as real vector geometry rather than as a picture of
// itself, and stay sharp at any zoom and any print size.
//
// This module only produces operator text. It knows nothing about pdf-lib or
// about documents; pdf-export.js owns those. Keeping it separate is what makes
// the geometry testable on its own.
(function () {
  "use strict";

  // Tools whose appearance this module can reproduce exactly. Anything else is
  // reported as unsupported so the caller can fall back per path rather than
  // dropping it or silently drawing something different.
  const VECTOR_TOOLS = new Set(["pen", "highlight", "line", "shape"]);

  function n(value) {
    // PDF reals: trim to two decimals. At page-point scale that is well under
    // a thousandth of a millimetre, and it keeps content streams compact.
    if (!Number.isFinite(value)) return "0";
    const rounded = Math.round(value * 100) / 100;
    return Object.is(rounded, -0) ? "0" : String(rounded);
  }

  // ---------- colour ----------

  const NAMED = {
    black: [0, 0, 0],
    white: [1, 1, 1],
    red: [1, 0, 0],
    green: [0, 0.5, 0],
    blue: [0, 0, 1],
    yellow: [1, 1, 0]
  };

  /**
   * CSS colour to PDF DeviceRGB components plus alpha.
   *
   * Returns { rgb: [r, g, b], alpha }. Unrecognised colours become black at
   * full opacity rather than throwing: a stroke drawn in the wrong colour is
   * recoverable, a failed export is not.
   */
  function parseColor(value) {
    const fallback = { rgb: [0, 0, 0], alpha: 1 };
    if (typeof value !== "string") return fallback;

    const text = value.trim().toLowerCase();
    if (NAMED[text]) return { rgb: NAMED[text], alpha: 1 };

    if (text.startsWith("#")) {
      const hex = text.slice(1);
      const expand = hex.length === 3 || hex.length === 4
        ? hex.split("").map((character) => character + character).join("")
        : hex;
      if (expand.length !== 6 && expand.length !== 8) return fallback;
      const byte = (index) => parseInt(expand.slice(index * 2, index * 2 + 2), 16) / 255;
      const rgb = [byte(0), byte(1), byte(2)];
      if (rgb.some((component) => !Number.isFinite(component))) return fallback;
      return { rgb, alpha: expand.length === 8 ? byte(3) : 1 };
    }

    const match = text.match(/^rgba?\(([^)]+)\)$/);
    if (match) {
      const parts = match[1].split(/[,\s/]+/).filter(Boolean).map(Number);
      if (parts.length < 3 || parts.slice(0, 3).some((part) => !Number.isFinite(part))) {
        return fallback;
      }
      return {
        rgb: parts.slice(0, 3).map((part) => Math.min(1, Math.max(0, part / 255))),
        alpha: parts.length > 3 && Number.isFinite(parts[3]) ? Math.min(1, Math.max(0, parts[3])) : 1
      };
    }

    return fallback;
  }

  // ---------- geometry ----------

  /**
   * The matrix that puts PDF.js viewport coordinates into PDF user space.
   *
   * Annotations are stored in the space PDF.js reports at scale 1, which has y
   * growing downward and already has the page's /Rotate applied. PDF user
   * space has y growing upward. Emitting the inverse of the viewport transform
   * as a `cm` prologue lets every coordinate below be written exactly as it is
   * stored — no per-point arithmetic, and rotated or offset pages come out
   * right for free.
   *
   * `viewBox` must be the box PDF.js laid the page out in — its CropBox
   * clipped to its MediaBox, which is what `Page#view` returns — and NOT the
   * MediaBox alone. On a cropped page the two differ, and passing the MediaBox
   * shifts every stroke on the page by the offset between them.
   */
  function viewportToPdfMatrix(rotation, viewBox) {
    const x0 = Math.min(viewBox[0], viewBox[2]);
    const y0 = Math.min(viewBox[1], viewBox[3]);
    const x1 = Math.max(viewBox[0], viewBox[2]);
    const y1 = Math.max(viewBox[1], viewBox[3]);

    const turn = ((Math.round((rotation || 0) / 90) * 90) % 360 + 360) % 360;

    // PDF.js PageViewport at scale 1, as [a, b, c, d, e, f].
    let forward;
    if (turn === 90) forward = [0, 1, 1, 0, -y0, -x0];
    else if (turn === 180) forward = [-1, 0, 0, 1, x1, -y0];
    else if (turn === 270) forward = [0, -1, -1, 0, y1, x1];
    else forward = [1, 0, 0, -1, -x0, y1];

    const [a, b, c, d, e, f] = forward;
    const determinant = a * d - b * c;
    if (!determinant) return [1, 0, 0, -1, 0, y1];

    return [
      d / determinant,
      -b / determinant,
      -c / determinant,
      a / determinant,
      (c * f - d * e) / determinant,
      (b * e - a * f) / determinant
    ];
  }

  function finite(point) {
    return point && Number.isFinite(point.x) && Number.isFinite(point.y);
  }

  function usablePoints(path) {
    return (path?.points || []).filter(finite);
  }

  /**
   * The centreline of a stroke, as PDF path operators.
   *
   * Mirrors __drawSmoothStroke in canvas.js: a polyline through the midpoints
   * with each original point as the control. Each quadratic (P0, Q, P2) is
   * written as the cubic that draws the identical curve, with control points
   * P0 + 2/3(Q - P0) and P2 + 2/3(Q - P2).
   */
  function centreline(points) {
    if (!points.length) return "";

    const ops = [`${n(points[0].x)} ${n(points[0].y)} m`];

    if (points.length === 1) {
      ops.push(`${n(points[0].x + 0.1)} ${n(points[0].y + 0.1)} l`);
      return ops.join("\n");
    }

    if (points.length === 2) {
      ops.push(`${n(points[1].x)} ${n(points[1].y)} l`);
      return ops.join("\n");
    }

    let from = points[0];
    for (let index = 1; index < points.length - 1; index += 1) {
      const control = points[index];
      const to = {
        x: (points[index].x + points[index + 1].x) / 2,
        y: (points[index].y + points[index + 1].y) / 2
      };
      ops.push(quadraticAsCubic(from, control, to));
      from = to;
    }

    const last = points[points.length - 1];
    ops.push(`${n(last.x)} ${n(last.y)} l`);
    return ops.join("\n");
  }

  function quadraticAsCubic(from, control, to) {
    const c1x = from.x + (2 / 3) * (control.x - from.x);
    const c1y = from.y + (2 / 3) * (control.y - from.y);
    const c2x = to.x + (2 / 3) * (control.x - to.x);
    const c2y = to.y + (2 / 3) * (control.y - to.y);
    return `${n(c1x)} ${n(c1y)} ${n(c2x)} ${n(c2y)} ${n(to.x)} ${n(to.y)} c`;
  }

  function circle(cx, cy, radius) {
    // Four cubics, the standard 0.5523 circle approximation.
    const k = radius * 0.5523;
    return [
      `${n(cx + radius)} ${n(cy)} m`,
      `${n(cx + radius)} ${n(cy + k)} ${n(cx + k)} ${n(cy + radius)} ${n(cx)} ${n(cy + radius)} c`,
      `${n(cx - k)} ${n(cy + radius)} ${n(cx - radius)} ${n(cy + k)} ${n(cx - radius)} ${n(cy)} c`,
      `${n(cx - radius)} ${n(cy - k)} ${n(cx - k)} ${n(cy - radius)} ${n(cx)} ${n(cy - radius)} c`,
      `${n(cx + k)} ${n(cy - radius)} ${n(cx + radius)} ${n(cy - k)} ${n(cx + radius)} ${n(cy)} c`
    ].join("\n");
  }

  // ---------- pen widths ----------

  function clamp(value, low, high) {
    return Math.min(high, Math.max(low, value));
  }

  function pointPressure(points, index) {
    const raw = points[index]?.pressure;
    return typeof raw === "number" ? clamp(raw, 0.05, 1) : 0.55;
  }

  function segmentSpeed(points, index) {
    const a = points[index - 1];
    const b = points[index];
    if (!a || !b) return 0;
    const distance = Math.hypot(b.x - a.x, b.y - a.y);
    const dt = Math.max(8, (b.time || 0) - (a.time || 0) || 16);
    return distance / dt;
  }

  // A verbatim copy of __penSegmentWidth in canvas.js, kept here so an export
  // never depends on the canvas module having loaded. If that function ever
  // changes, this one has to change with it or exported strokes will come out
  // the wrong weight — test_pdf_vector.py compares the two.
  function penSegmentWidth(style, baseSize, points, index) {
    const pressure = pointPressure(points, index);
    const speed = segmentSpeed(points, index);
    const previous = points[Math.max(0, index - 1)] || points[0];
    const current = points[Math.min(points.length - 1, index)] || previous;
    const dx = current.x - previous.x;
    const dy = current.y - previous.y;
    const distance = Math.hypot(dx, dy) || 1;
    const vertical = Math.abs(dy) / distance;
    const remaining = Math.max(0, points.length - 1 - index);

    if (style === "brush") {
      const speedWeight = clamp(1.58 - speed * 0.88, 0.42, 1.5);
      const pressureWeight = 0.42 + pressure * 1.95;
      const taper = Math.min(1, 0.18 + index / 3.5, 0.16 + remaining / 5);
      return Math.max(0.55, baseSize * pressureWeight * speedWeight * taper);
    }

    const nibAngleWeight = 0.42 + Math.pow(vertical, 0.72) * 1.32;
    const pressureWeight = 0.82 + pressure * 0.32;
    const speedWeight = clamp(1.08 - speed * 0.18, 0.82, 1.08);
    const taper = Math.min(1, 0.35 + index / 3, 0.3 + remaining / 4);
    return Math.max(0.35, baseSize * nibAngleWeight * pressureWeight * speedWeight * taper);
  }

  // ---------- emitting ----------

  function setStroke(color, width) {
    const { rgb } = parseColor(color);
    return [
      `${n(rgb[0])} ${n(rgb[1])} ${n(rgb[2])} RG`,
      `${n(Math.max(0.1, width))} w`
    ].join("\n");
  }

  function setFill(color) {
    const { rgb } = parseColor(color);
    return `${n(rgb[0])} ${n(rgb[1])} ${n(rgb[2])} rg`;
  }

  /**
   * One path as PDF operators.
   *
   * `resources.alpha(fill, stroke, blend)` must register an ExtGState and
   * return its resource name; the caller owns the page's resource dictionary.
   *
   * Returns null when this module cannot reproduce the path exactly, which
   * tells the caller to fall back for that path alone.
   */
  function pathToOperators(path, resources) {
    if (!path || !VECTOR_TOOLS.has(path.tool)) return null;

    // A stroke that has been erased into is stored with the cuts alongside it
    // rather than baked into its points, and PDF has no subtractive clip that
    // reproduces them faithfully. Hand those back for a per-path fallback.
    if (Array.isArray(path.eraserCuts) && path.eraserCuts.length) return null;

    const points = usablePoints(path);
    if (!points.length) return null;

    if (path.tool === "highlight") return highlightOps(path, points, resources);
    if (path.tool === "pen") return penOps(path, points, resources);
    if (path.tool === "line") return lineOps(path, points);
    if (path.tool === "shape") return shapeOps(path, points, resources);
    return null;
  }

  function penOps(path, points, resources) {
    const color = path.color || "#ffffff";
    const baseSize = Math.max(0.5, path.size || 2);
    const raw = path.penStyle || path.style || "default";
    const style = raw === "marker" ? "calligraphy" : raw;

    if (style === "calligraphy") {
      // The canvas renderer fills angled quads rather than stroking a line;
      // reproducing that needs the nib geometry, which lives in canvas.js.
      return null;
    }

    if (style === "fountain" || style === "brush") {
      return variableWidthOps(path, points, style, baseSize, color, resources);
    }

    if (style === "gel") {
      // Two passes, as on canvas: a wide translucent bed and an opaque core.
      // The canvas version also carries a shadow glow, which has no vector
      // equivalent; the two passes carry the look, the bloom is dropped.
      const bed = resources.alpha(null, 0.42, null);
      return [
        "1 J 1 j",
        `/${bed} gs`,
        setStroke(color, baseSize * 1.72),
        centreline(points),
        "S",
        `/${resources.alpha(null, 1, null)} gs`,
        setStroke(color, baseSize * 1.34),
        centreline(points),
        "S"
      ].join("\n");
    }

    const { alpha } = parseColor(color);
    const ops = ["1 J 1 j"];
    if (alpha < 1) ops.push(`/${resources.alpha(null, alpha, null)} gs`);
    ops.push(setStroke(color, baseSize), centreline(points), "S");
    return ops.join("\n");
  }

  function variableWidthOps(path, points, style, baseSize, color, resources) {
    const opacity = style === "brush" ? 0.96 : 1;
    const ops = ["1 J 1 j", `/${resources.alpha(null, opacity, null)} gs`, setFill(color)];
    const { rgb } = parseColor(color);
    ops.push(`${n(rgb[0])} ${n(rgb[1])} ${n(rgb[2])} RG`);

    if (points.length === 1) {
      const width = penSegmentWidth(style, baseSize, points, 0);
      ops.push(circle(points[0].x, points[0].y, width / 2), "f");
      return ops.join("\n");
    }

    const midpoint = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

    // Each span is stroked on its own because its width differs; round caps
    // hide the joins exactly as they do on canvas.
    const first = midpoint(points[0], points[1]);
    ops.push(
      `${n(penSegmentWidth(style, baseSize, points, 1))} w`,
      `${n(points[0].x)} ${n(points[0].y)} m`,
      `${n(first.x)} ${n(first.y)} l`,
      "S"
    );

    for (let index = 1; index < points.length - 1; index += 1) {
      const start = midpoint(points[index - 1], points[index]);
      const end = midpoint(points[index], points[index + 1]);
      const current = penSegmentWidth(style, baseSize, points, index);
      const next = penSegmentWidth(style, baseSize, points, index + 1);
      ops.push(
        `${n((current + next) / 2)} w`,
        `${n(start.x)} ${n(start.y)} m`,
        quadraticAsCubic(start, points[index], end),
        "S"
      );
    }

    const lastIndex = points.length - 1;
    const lastMid = midpoint(points[lastIndex - 1], points[lastIndex]);
    ops.push(
      `${n(penSegmentWidth(style, baseSize, points, lastIndex))} w`,
      `${n(lastMid.x)} ${n(lastMid.y)} m`,
      `${n(points[lastIndex].x)} ${n(points[lastIndex].y)} l`,
      "S"
    );

    return ops.join("\n");
  }

  function highlightOps(path, points, resources) {
    const color = path.color || "#ffee58";
    const width = Math.max(1, path.size || 18);
    const { alpha } = parseColor(color);

    // Multiply is what makes a highlighter darken the text under it instead of
    // veiling it, and it is exactly what the canvas renderer does.
    const gs = resources.alpha(null, alpha < 1 ? alpha : 0.4, "Multiply");
    return [
      "1 J 1 j",
      `/${gs} gs`,
      setStroke(color, width),
      centreline(points),
      "S"
    ].join("\n");
  }

  function lineOps(path, points) {
    if (points.length < 2) return null;
    // Only a plain two-point line is reproduced here. Arrowheads, dashes and
    // the measurement labels live in tools/line.js, so anything carrying them
    // goes to the fallback rather than exporting as something it is not.
    if (path.lineType && path.lineType !== "plain") return null;
    if (path.startArrow || path.endArrow || path.label) return null;

    return [
      "1 J 1 j",
      setStroke(path.color || "#ffffff", path.size || 2),
      `${n(points[0].x)} ${n(points[0].y)} m`,
      `${n(points[1].x)} ${n(points[1].y)} l`,
      "S"
    ].join("\n");
  }

  const SMART_POLYGON_KINDS = new Set([
    "triangle", "rectangle", "parallelogram", "rhombus", "kite",
    "square", "trapezium", "pentagon", "hexagon", "octagon"
  ]);

  // Mirrors paintShape in tools/select.js, which paints the same shapes on the
  // canvas: a tint is the shape's colour at 22% under a full-strength outline,
  // and dash lengths grow with the line width. If either changes there it has
  // to change here, or an exported shape stops matching the page.
  const SHAPE_TINT_ALPHA = 0.22;

  function shapeDash(path) {
    const width = Math.max(0.5, path.size || 2);
    if (path.dash === "dashed") return `[${n(width * 3 + 6)} ${n(width * 2 + 6)}] 0 d`;
    // A zero-length dash with round caps is a dot.
    if (path.dash === "dotted") return `[0 ${n(width * 2 + 4)}] 0 d`;
    return null;
  }

  /**
   * The set-up before a shape's outline and the paint operator after it.
   *
   * Returns null for a tint when there is no resource dictionary to register
   * its transparency in: drawn opaque it would hide whatever is under it, so
   * the caller falls back for that path instead.
   */
  function shapePaint(path, resources) {
    const color = path.color || "#ffffff";
    const filled = path.fill === "tint" || path.fill === "solid";
    const before = ["1 J 1 j"];
    if (path.fill === "tint") {
      if (typeof resources?.alpha !== "function") return null;
      before.push(`/${resources.alpha(SHAPE_TINT_ALPHA, 1, null)} gs`);
    }
    before.push(setStroke(color, path.size || 2));
    if (filled) before.push(setFill(color));
    const dash = shapeDash(path);
    if (dash) before.push(dash);
    return { before, paint: filled ? "B" : "S" };
  }

  // Four cubics through the ends of an ellipse's axes: circle()'s quarter arcs
  // drawn in the frame of its two semi-axes, so a tilted ellipse is as exact as
  // a circle.
  function ellipse(points) {
    const cx = (points[0].x + points[1].x + points[2].x + points[3].x) / 4;
    const cy = (points[0].y + points[1].y + points[2].y + points[3].y) / 4;
    const u = { x: points[0].x - cx, y: points[0].y - cy };
    const v = { x: points[1].x - cx, y: points[1].y - cy };
    const k = 0.5523;
    const at = (along, across) =>
      `${n(cx + u.x * along + v.x * across)} ${n(cy + u.y * along + v.y * across)}`;
    return [
      `${at(1, 0)} m`,
      `${at(1, k)} ${at(k, 1)} ${at(0, 1)} c`,
      `${at(-k, 1)} ${at(-1, k)} ${at(-1, 0)} c`,
      `${at(-1, -k)} ${at(-k, -1)} ${at(0, -1)} c`,
      `${at(k, -1)} ${at(1, -k)} ${at(1, 0)} c`,
      "h"
    ].join("\n");
  }

  function shapeOps(path, points, resources) {
    if (points.length < 2) return null;
    const kind = path.shapeType || "rect";
    const [a, b] = points;
    const style = shapePaint(path, resources);
    if (!style) return null;
    const draw = (outline) => [...style.before, outline, style.paint].join("\n");
    const smart = Number(path.geometryVersion) === 1 && path.geometryKind === kind;

    // A smart polygon stores every corner, so it is traced corner to corner.
    // Reading only the first two as a box exported a smart rectangle
    // ([TL, TR, BR, BL]) as a zero-height rectangle, and every other smart
    // polygon fell back to raster.
    if (smart && SMART_POLYGON_KINDS.has(kind) && points.length >= 3) {
      return draw([
        `${n(points[0].x)} ${n(points[0].y)} m`,
        ...points.slice(1).map((point) => `${n(point.x)} ${n(point.y)} l`),
        "h"
      ].join("\n"));
    }

    if (smart && kind === "ellipse" && points.length >= 4) {
      return draw(ellipse(points));
    }

    if (kind === "circle") {
      const cx = (a.x + b.x) / 2;
      const cy = (a.y + b.y) / 2;
      const rx = Math.abs(b.x - a.x) / 2;
      const ry = Math.abs(b.y - a.y) / 2;
      if (Math.abs(rx - ry) > 0.01) return null; // an old stretched circle; raster keeps its look
      return draw(`${circle(cx, cy, rx)}\nh`);
    }

    if (kind === "rect" || kind === "rectangle" || kind === "square") {
      const x = Math.min(a.x, b.x);
      const y = Math.min(a.y, b.y);
      return draw(`${n(x)} ${n(y)} ${n(Math.abs(b.x - a.x))} ${n(Math.abs(b.y - a.y))} re`);
    }

    return null;
  }

  window.Inkyscib = window.Inkyscib || {};
  window.Inkyscib.PdfVector = {
    VECTOR_TOOLS,
    parseColor,
    viewportToPdfMatrix,
    pathToOperators,
    // exported for tests
    centreline,
    penSegmentWidth
  };
})();
