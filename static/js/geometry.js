(function () {
  "use strict";

  const GEOMETRY_VERSION = 1;
  const DEFAULT_UNIT_SCALE = 32;
  // The master switch (static/js/measurements.js) hides every label at once
  // without touching what each object remembers, so turning it back on
  // restores them individually.
  function measurementsVisible() {
    return window.Inkyscib?.Measurements?.visible?.() !== false;
  }

  // The unit's display name is shared across every tool that measures
  // something; see static/js/units.js. Falls back to "u" so a label never
  // comes out with a bare number if this module loads first.
  function unitLabel(squared) {
    return window.Inkyscib?.Units?.label({ squared: !!squared }) || (squared ? "u\u00b2" : "u");
  }

  const DEFAULT_RADIUS = 72;
  const MIN_RADIUS = 4;
  const DEFAULT_MEASUREMENT_STEP = 0.5;
  const MIN_DIMENSION_UNITS = 0.5;
  const HANDLE_SCREEN_RADIUS = 8;
  const SNAP_SCREEN_DISTANCE = 7;
  const TAU = Math.PI * 2;
  const CONSTRUCTION_NAMES = {
    radius: "Radius",
    diameter: "Diameter",
    chord: "Chord",
    arc: "Arc",
    "central-angle": "Central angle",
    "inscribed-angle": "Inscribed angle",
    "cyclic-quadrilateral": "Cyclic quadrilateral",
    tangent: "Tangent"
  };

  let constructionCounter = 0;
  let inspector = null;
  let inspectorSignature = "";
  let constructionListSignature = "";
  let dimensionFieldsSignature = "";
  let fieldEdit = null;
  let lastSmartTouchAt = -Infinity;
  let activeTriangleAngle = 0;

  function state() {
    return window.appState;
  }

  function currentScale() {
    return Math.max(0.15, state()?.transform?.scale || 1);
  }

  function worldSize(pixels) {
    return pixels / currentScale();
  }

  function geometryGridStep(unitScale = DEFAULT_UNIT_SCALE) {
    return Math.max(1, unitScale * DEFAULT_MEASUREMENT_STEP);
  }

  function quantizeWorldLength(path, length, preserveExact = false) {
    if (preserveExact || path?.snapToGrid === false) return Math.max(4, length);
    const step = geometryGridStep(geometryUnitScale(path));
    return Math.max(step, Math.round(length / step) * step);
  }

  function rotateAround(point, center, angle) {
    const vector = rotateVector({ x: point.x - center.x, y: point.y - center.y }, angle);
    return { x: center.x + vector.x, y: center.y + vector.y };
  }

  function finitePoint(point) {
    return !!point && Number.isFinite(point.x) && Number.isFinite(point.y);
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function normalizeAngle(angle) {
    let value = Number.isFinite(angle) ? angle % TAU : 0;
    if (value < 0) value += TAU;
    return value;
  }

  function numberOr(value, fallback = 0) {
    return Number.isFinite(value) ? value : fallback;
  }

  function positiveArc(start, end) {
    let delta = normalizeAngle(end) - normalizeAngle(start);
    if (delta <= 0) delta += TAU;
    return delta;
  }

  function deepClone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function requestRedraw() {
    if (typeof window.invalidateCanvasDrawingCache === "function") {
      window.invalidateCanvasDrawingCache();
    }
    if (typeof window.render === "function") window.render();
  }

  function safeSave() {
    if (typeof window.saveDrawing === "function") window.saveDrawing();
  }

  function isSmartCircle(path) {
    return !!path &&
      path.tool === "shape" &&
      path.shapeType === "circle" &&
      Number(path.geometryVersion) === GEOMETRY_VERSION &&
      path.geometryKind === "circle";
  }

  function isSmartTriangle(path) {
    return !!path &&
      path.tool === "shape" &&
      path.shapeType === "triangle" &&
      Number(path.geometryVersion) === GEOMETRY_VERSION &&
      path.geometryKind === "triangle" &&
      Array.isArray(path.points) &&
      path.points.length >= 3;
  }

  // Stored as the four ends of its axes; see ellipseFrame.
  function isSmartEllipse(path) {
    return !!path &&
      path.tool === "shape" &&
      path.shapeType === "ellipse" &&
      Number(path.geometryVersion) === GEOMETRY_VERSION &&
      path.geometryKind === "ellipse" &&
      Array.isArray(path.points) &&
      path.points.length >= 4;
  }

  // Every polygon kind other than the triangle, and how many corners it has.
  // Listed once, so a kind added here is created, drawn, measured, labelled,
  // handled and normalised everywhere that asks. isSmartQuadrilateral keeps its
  // name for the callers that already use it; it now covers every polygon.
  const POLYGON_VERTEX_COUNT = {
    rectangle: 4,
    parallelogram: 4,
    rhombus: 4,
    kite: 4,
    square: 4,
    trapezium: 4,
    pentagon: 5,
    hexagon: 6,
    octagon: 8
  };
  const REGULAR_POLYGON_KINDS = new Set(["square", "pentagon", "hexagon", "octagon"]);

  function polygonVertexCount(path) {
    if (isSmartTriangle(path)) return 3;
    return POLYGON_VERTEX_COUNT[path?.geometryKind] || 0;
  }

  function isSmartQuadrilateral(path) {
    const count = POLYGON_VERTEX_COUNT[path?.shapeType];
    return !!path &&
      !!count &&
      path.tool === "shape" &&
      Number(path.geometryVersion) === GEOMETRY_VERSION &&
      path.geometryKind === path.shapeType &&
      Array.isArray(path.points) &&
      path.points.length >= count;
  }

  function isSmartGeometry(path) {
    return isSmartCircle(path) || isSmartTriangle(path) || isSmartQuadrilateral(path) || isSmartEllipse(path);
  }

  function polygonCenter(path) {
    const points = (path?.points || []).filter(finitePoint);
    if (!points.length) return { x: 0, y: 0 };
    return {
      x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
      y: points.reduce((sum, point) => sum + point.y, 0) / points.length
    };
  }

  function geometryCenter(path) {
    return isSmartCircle(path) ? circleCenter(path) : polygonCenter(path);
  }

  function geometryUnitScale(path) {
    return Number.isFinite(path?.unitScale) && path.unitScale > 0
      ? path.unitScale
      : DEFAULT_UNIT_SCALE;
  }

  // How a shape is painted: no fill, a tint of its colour, or solid; an outline
  // solid, dashed or dotted. Anything unrecognised is the default, so a
  // document from before these existed draws exactly as it did.
  const SHAPE_FILLS = new Set(["none", "tint", "solid"]);
  const SHAPE_DASHES = new Set(["solid", "dashed", "dotted"]);

  function shapeFill(value) {
    return SHAPE_FILLS.has(value) ? value : "none";
  }

  function shapeDash(value) {
    return SHAPE_DASHES.has(value) ? value : "solid";
  }

  function geometryBasePath(kind, settings = {}) {
    return {
      tool: "shape",
      size: settings.size || 3,
      color: settings.color || "#ffffff",
      fill: shapeFill(settings.fill),
      dash: shapeDash(settings.dash),
      shapeType: kind,
      geometryVersion: GEOMETRY_VERSION,
      geometryKind: kind,
      unitScale: DEFAULT_UNIT_SCALE,
      rotation: 0,
      showMeasurements: settings.showMeasurements !== false,
      snapToGrid: settings.snapToGrid !== false,
      snapToObjects: settings.snapToObjects !== false,
      timestamp: Date.now()
    };
  }

  function circleCenter(path) {
    if (Number.isFinite(path?.centerX) && Number.isFinite(path?.centerY)) {
      return { x: path.centerX, y: path.centerY };
    }
    const p1 = path?.points?.[0];
    const p2 = path?.points?.[1];
    if (finitePoint(p1) && finitePoint(p2)) {
      return { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
    }
    return { x: 0, y: 0 };
  }

  function circleRadius(path) {
    if (Number.isFinite(path?.radius) && path.radius >= 0) return path.radius;
    const p1 = path?.points?.[0];
    const p2 = path?.points?.[1];
    if (!finitePoint(p1) || !finitePoint(p2)) return 0;
    return Math.max(Math.abs(p2.x - p1.x), Math.abs(p2.y - p1.y)) / 2;
  }

  function circleRotation(path) {
    return Number.isFinite(path?.rotation) ? path.rotation : 0;
  }

  function circleUnitScale(path) {
    return Number.isFinite(path?.unitScale) && path.unitScale > 0
      ? path.unitScale
      : DEFAULT_UNIT_SCALE;
  }

  function syncCirclePoints(path) {
    if (!path) return path;
    const center = circleCenter(path);
    const radius = Math.max(0, circleRadius(path));
    path.centerX = center.x;
    path.centerY = center.y;
    path.radius = radius;
    path.width = radius * 2;
    path.height = radius * 2;
    path.points = [
      { x: center.x - radius, y: center.y - radius },
      { x: center.x + radius, y: center.y + radius }
    ];
    return path;
  }

  function setCircleGeometry(path, center, radius, radiusAngle = null) {
    if (!path || !finitePoint(center)) return path;
    path.centerX = center.x;
    path.centerY = center.y;
    path.radius = Math.max(MIN_RADIUS, Number.isFinite(radius) ? radius : MIN_RADIUS);
    if (Number.isFinite(radiusAngle)) path.radiusAngle = normalizeAngle(radiusAngle);
    return syncCirclePoints(path);
  }

  function pointOnCircle(path, localAngle, radiusMultiplier = 1) {
    const center = circleCenter(path);
    const radius = circleRadius(path) * radiusMultiplier;
    const angle = normalizeAngle(localAngle + circleRotation(path));
    // Angles here are CCW-positive (standard math convention); screen y grows
    // downward, so the sin term is negated to place the point correctly.
    return {
      x: center.x + Math.cos(angle) * radius,
      y: center.y - Math.sin(angle) * radius
    };
  }

  // An ellipse is stored as the four ends of its axes, in order +a, +b, -a, -b.
  // Moving, turning and scaling points is what the select tool already does to
  // every polygon, so the ellipse needs no transform code of its own: its
  // centre, radii and tilt are read back from wherever those points end up.
  function ellipseFrame(path) {
    const points = (path?.points || []).slice(0, 4);
    if (points.length < 4 || !points.every(finitePoint)) {
      return { center: { x: 0, y: 0 }, radiusX: 0, radiusY: 0, rotation: 0 };
    }
    const center = {
      x: points.reduce((sum, point) => sum + point.x, 0) / 4,
      y: points.reduce((sum, point) => sum + point.y, 0) / 4
    };
    const axis = { x: points[0].x - points[2].x, y: points[0].y - points[2].y };
    const across = { x: points[1].x - points[3].x, y: points[1].y - points[3].y };
    const length = Math.hypot(axis.x, axis.y);
    // After a stretch the two diameters are no longer at right angles. Keeping
    // the first as the axis and only the perpendicular part of the second
    // keeps the area the stretch produced.
    const radiusY = length > 1e-9
      ? Math.abs(axis.x * across.y - axis.y * across.x) / length / 2
      : Math.hypot(across.x, across.y) / 2;
    return {
      center,
      radiusX: length / 2,
      radiusY,
      rotation: Math.atan2(axis.y, axis.x)
    };
  }

  function setEllipseGeometry(path, center, radiusX, radiusY, rotation) {
    if (!path || !finitePoint(center)) return path;
    const a = Math.max(MIN_RADIUS, numberOr(radiusX, MIN_RADIUS));
    const b = Math.max(MIN_RADIUS, numberOr(radiusY, MIN_RADIUS));
    const turn = numberOr(rotation);
    const cos = Math.cos(turn);
    const sin = Math.sin(turn);
    path.points = [
      { x: center.x + cos * a, y: center.y + sin * a },
      { x: center.x - sin * b, y: center.y + cos * b },
      { x: center.x - cos * a, y: center.y - sin * a },
      { x: center.x + sin * b, y: center.y - cos * b }
    ];
    path.rotation = turn;
    return path;
  }

  // The point at parameter `t` on a frame's ellipse, in screen space.
  function pointOnEllipse(frame, t) {
    const along = Math.cos(t) * frame.radiusX;
    const across = Math.sin(t) * frame.radiusY;
    const cos = Math.cos(frame.rotation);
    const sin = Math.sin(frame.rotation);
    return {
      x: frame.center.x + along * cos - across * sin,
      y: frame.center.y + along * sin + across * cos
    };
  }

  function ellipseDisplayPoints(path) {
    if (!isSmartEllipse(path)) return [];
    const frame = ellipseFrame(path);
    return Array.from({ length: 48 }, (_, index) => pointOnEllipse(frame, (index / 48) * TAU));
  }

  function shapeAnchors(path) {
    if (!path) return [];
    if (isSmartCircle(path)) {
      const center = circleCenter(path);
      return [
        center,
        pointOnCircle(path, 0),
        pointOnCircle(path, Math.PI / 2),
        pointOnCircle(path, Math.PI),
        pointOnCircle(path, Math.PI * 1.5)
      ];
    }
    if (isSmartEllipse(path)) {
      return [ellipseFrame(path).center, ...path.points.slice(0, 4).filter(finitePoint)];
    }
    if (isSmartTriangle(path) || isSmartQuadrilateral(path)) {
      const points = path.points.filter(finitePoint).slice(0, polygonVertexCount(path));
      const anchors = [...points, polygonCenter(path)];
      points.forEach((point, index) => {
        const next = points[(index + 1) % points.length];
        anchors.push({ x: (point.x + next.x) / 2, y: (point.y + next.y) / 2 });
      });
      return anchors;
    }
    if (path.tool === "line") return (path.points || []).filter(finitePoint).slice(0, 2);
    if (path.tool === "shape") {
      const points = window.Inkyscib?.Geometry?.shapeDisplayPoints?.(path) || [];
      const anchors = points.filter(finitePoint);
      if (Number.isFinite(path.centerX) && Number.isFinite(path.centerY)) {
        anchors.push({ x: path.centerX, y: path.centerY });
      }
      return anchors;
    }
    return [];
  }

  function snapPoint(rawPoint, sourcePath = null, options = {}) {
    const raw = { x: rawPoint.x, y: rawPoint.y };
    const threshold = worldSize(SNAP_SCREEN_DISTANCE);
    let best = null;

    if (options.objects !== false) {
      const consider = (anchor) => {
        const distance = Math.hypot(raw.x - anchor.x, raw.y - anchor.y);
        if (distance <= threshold && (!best || distance < best.distance)) {
          best = { point: { x: anchor.x, y: anchor.y }, distance, kind: "object" };
        }
      };
      (state()?.paths || []).forEach((path) => {
        if (path === sourcePath) return;
        shapeAnchors(path).forEach(consider);

        if (isSmartCircle(path)) {
          const center = circleCenter(path);
          const dx = raw.x - center.x;
          const dy = raw.y - center.y;
          const length = Math.hypot(dx, dy);
          if (length > 0.001) {
            const radius = circleRadius(path);
            consider({ x: center.x + dx / length * radius, y: center.y + dy / length * radius });
          }
        }
      });
    }

    if (!best && options.grid !== false) {
      // Smart geometry uses a semantic half-unit lattice. Object anchors win
      // when nearby; otherwise grid mode always lands on a clean 0.5 u step.
      const unit = geometryGridStep(
        Number.isFinite(options.unitScale)
          ? options.unitScale
          : geometryUnitScale(sourcePath)
      );
      const grid = {
        x: Math.round(raw.x / unit) * unit,
        y: Math.round(raw.y / unit) * unit
      };
      const distance = Math.hypot(raw.x - grid.x, raw.y - grid.y);
      best = { point: grid, distance, kind: "grid" };
    }

    return best || { point: raw, distance: Infinity, kind: null };
  }

  function createCirclePath(position, settings = {}) {
    const snapped = snapPoint(position, null, {
      grid: settings.snapToGrid !== false,
      objects: settings.snapToObjects !== false,
      unitScale: DEFAULT_UNIT_SCALE
    });
    const center = snapped.point;
    return {
      tool: "shape",
      size: settings.size || 3,
      color: settings.color || "#ffffff",
      fill: shapeFill(settings.fill),
      dash: shapeDash(settings.dash),
      shapeType: "circle",
      points: [{ ...center }, { ...center }],
      centerX: center.x,
      centerY: center.y,
      radius: 0,
      width: 0,
      height: 0,
      radiusAngle: 0,
      rotation: 0,
      geometryVersion: GEOMETRY_VERSION,
      geometryKind: "circle",
      unitScale: DEFAULT_UNIT_SCALE,
      radiusLocked: false,
      showMeasurements: settings.showMeasurements !== false,
      showAxes: settings.showAxes !== false,
      snapToGrid: settings.snapToGrid !== false,
      snapToObjects: settings.snapToObjects !== false,
      variableLabel: "r",
      constructions: [],
      timestamp: Date.now()
    };
  }

  function createTrianglePath(position, settings = {}) {
    const snapped = snapPoint(position, null, {
      grid: settings.snapToGrid !== false,
      objects: settings.snapToObjects !== false,
      unitScale: DEFAULT_UNIT_SCALE
    }).point;
    return {
      ...geometryBasePath("triangle", settings),
      triangleType: settings.triangleType || "isosceles",
      points: [{ ...snapped }, { ...snapped }, { ...snapped }],
      draftStart: { ...snapped },
      angleMarks: [false, false, false],
      lockedAngles: [null, null, null],
      vertexLabels: ["A", "B", "C"]
    };
  }

  function createCustomTrianglePath(position, settings = {}) {
    const path = createTrianglePath(position, { ...settings, triangleType: "custom" });
    path.points = [{ ...path.draftStart }];
    return path;
  }

  function createQuadrilateralPath(kind, position, settings = {}) {
    const snapped = snapPoint(position, null, {
      grid: settings.snapToGrid !== false,
      objects: settings.snapToObjects !== false,
      unitScale: DEFAULT_UNIT_SCALE
    }).point;
    const count = POLYGON_VERTEX_COUNT[kind] || 4;
    return {
      ...geometryBasePath(kind, settings),
      points: Array.from({ length: count }, () => ({ ...snapped })),
      draftStart: { ...snapped },
      vertexLabels: Array.from({ length: count }, (_, index) => String.fromCharCode(65 + index))
    };
  }

  function createEllipsePath(position, settings = {}) {
    const snapped = snapPoint(position, null, {
      grid: settings.snapToGrid !== false,
      objects: settings.snapToObjects !== false,
      unitScale: DEFAULT_UNIT_SCALE
    }).point;
    return {
      ...geometryBasePath("ellipse", settings),
      points: Array.from({ length: 4 }, () => ({ ...snapped })),
      draftStart: { ...snapped }
    };
  }

  function createShapePath(kind, position, settings = {}) {
    if (kind === "circle") return createCirclePath(position, settings);
    if (kind === "triangle") return createTrianglePath(position, settings);
    if (kind === "ellipse") return createEllipsePath(position, settings);
    if (POLYGON_VERTEX_COUNT[kind]) return createQuadrilateralPath(kind, position, settings);
    return null;
  }

  function draftBounds(start, pointer) {
    const minSize = 8;
    let left = Math.min(start.x, pointer.x);
    let right = Math.max(start.x, pointer.x);
    let top = Math.min(start.y, pointer.y);
    let bottom = Math.max(start.y, pointer.y);
    if (right - left < minSize) right = left + minSize;
    if (bottom - top < minSize) bottom = top + minSize;
    return {
      left,
      right,
      top,
      bottom,
      width: right - left,
      height: bottom - top,
      center: { x: (left + right) / 2, y: (top + bottom) / 2 }
    };
  }

  function equilateralPoints(center, side, rotation = 0) {
    const height = side * Math.sqrt(3) / 2;
    return [
      { x: center.x, y: center.y - height * 2 / 3 },
      { x: center.x - side / 2, y: center.y + height / 3 },
      { x: center.x + side / 2, y: center.y + height / 3 }
    ].map((point) => rotateAround(point, center, rotation));
  }

  function updateTriangleDraft(path, pointer) {
    const start = path.draftStart || path.points?.[0];
    if (!finitePoint(start)) return false;
    const box = draftBounds(start, pointer);
    if (path.triangleType === "equilateral") {
      const side = quantizeWorldLength(path, Math.max(box.width, box.height * 2 / Math.sqrt(3)));
      path.points = equilateralPoints(box.center, side);
    } else if (path.triangleType === "right") {
      path.points = [
        { x: box.left, y: box.top },
        { x: box.left, y: box.bottom },
        { x: box.right, y: box.bottom }
      ];
    } else {
      path.points = [
        { x: box.center.x, y: box.top },
        { x: box.left, y: box.bottom },
        { x: box.right, y: box.bottom }
      ];
    }
    return true;
  }

  function updateQuadrilateralDraft(path, pointer) {
    const start = path.draftStart || path.points?.[0];
    if (!finitePoint(start)) return false;
    const box = draftBounds(start, pointer);
    if (path.geometryKind === "rectangle") {
      path.points = [
        { x: box.left, y: box.top },
        { x: box.right, y: box.top },
        { x: box.right, y: box.bottom },
        { x: box.left, y: box.bottom }
      ];
    } else if (path.geometryKind === "parallelogram") {
      const rawSkew = box.width * 0.2;
      const base = quantizeWorldLength(path, box.width - rawSkew);
      const side = Math.max(box.height, quantizeWorldLength(path, Math.hypot(rawSkew, box.height)));
      const skew = Math.sqrt(Math.max(0, side * side - box.height * box.height));
      const a = {
        x: box.center.x - (base - skew) / 2,
        y: box.center.y - box.height / 2
      };
      path.points = [
        a,
        { x: a.x + base, y: a.y },
        { x: a.x + base - skew, y: a.y + box.height },
        { x: a.x - skew, y: a.y + box.height }
      ];
    } else if (path.geometryKind === "rhombus") {
      path.points = [
        { x: box.center.x, y: box.top },
        { x: box.right, y: box.center.y },
        { x: box.center.x, y: box.bottom },
        { x: box.left, y: box.center.y }
      ];
    } else if (path.geometryKind === "kite") {
      const crossY = box.top + box.height * 0.42;
      path.points = [
        { x: box.center.x, y: box.top },
        { x: box.right, y: crossY },
        { x: box.center.x, y: box.bottom },
        { x: box.left, y: crossY }
      ];
    } else if (path.geometryKind === "square") {
      const side = quantizeWorldLength(path, Math.max(box.width, box.height));
      path.points = regularPolygonPoints(box.center, side / Math.SQRT2, 4, -Math.PI * 3 / 4);
    } else if (path.geometryKind === "trapezium") {
      const inset = box.width * 0.2;
      path.points = [
        { x: box.left + inset, y: box.top },
        { x: box.right - inset, y: box.top },
        { x: box.right, y: box.bottom },
        { x: box.left, y: box.bottom }
      ];
    } else if (REGULAR_POLYGON_KINDS.has(path.geometryKind)) {
      const sides = POLYGON_VERTEX_COUNT[path.geometryKind];
      path.points = regularPolygonPoints(box.center, Math.min(box.width, box.height) / 2, sides, flatBottomStart(sides));
    } else {
      // A kind in POLYGON_VERTEX_COUNT with no draft of its own. This branch
      // used to be the kite, so a new kind silently drew as one.
      return false;
    }
    return true;
  }

  // Corners of a regular polygon: `radius` from `center`, the first corner at
  // `start` radians, the rest clockwise on screen.
  function regularPolygonPoints(center, radius, sides, start) {
    return Array.from({ length: sides }, (_, index) => {
      const angle = start + index * Math.PI * 2 / sides;
      return { x: center.x + Math.cos(angle) * radius, y: center.y + Math.sin(angle) * radius };
    });
  }

  // The start angle that lays one edge flat along the bottom, the way a
  // pentagon or hexagon is usually drawn. Screen y grows downward.
  function flatBottomStart(sides) {
    return Math.PI / 2 + Math.PI / sides;
  }

  // Dragged corner to corner like a rectangle, the ellipse filling the box.
  function updateEllipseDraft(path, pointer) {
    const start = path.draftStart || path.points?.[0];
    if (!finitePoint(start)) return false;
    const box = draftBounds(start, pointer);
    setEllipseGeometry(path, box.center, box.width / 2, box.height / 2, 0);
    return true;
  }

  function updateShapeDraft(path, pointer) {
    if (!isSmartGeometry(path) || !finitePoint(pointer)) return false;
    const snapped = snapPoint(pointer, path, {
      grid: path.snapToGrid !== false,
      objects: path.snapToObjects !== false,
      unitScale: geometryUnitScale(path)
    }).point;
    if (isSmartCircle(path)) return updateCircleDraft(path, snapped);
    if (isSmartTriangle(path)) return updateTriangleDraft(path, snapped);
    if (isSmartQuadrilateral(path)) return updateQuadrilateralDraft(path, snapped);
    if (isSmartEllipse(path)) return updateEllipseDraft(path, snapped);
    return false;
  }

  function promoteTriangle(path) {
    if (!path || path.tool !== "shape" || path.shapeType !== "triangle") return path;
    path.geometryVersion = GEOMETRY_VERSION;
    path.geometryKind = "triangle";
    path.unitScale = geometryUnitScale(path);
    path.showMeasurements = path.showMeasurements !== false;
    path.snapToGrid = path.snapToGrid !== false;
    path.snapToObjects = path.snapToObjects !== false;
    path.angleMarks = Array.isArray(path.angleMarks) ? path.angleMarks.slice(0, 3).map(Boolean) : [false, false, false];
    while (path.angleMarks.length < 3) path.angleMarks.push(false);
    path.lockedAngles = Array.isArray(path.lockedAngles) ? path.lockedAngles.slice(0, 3) : [null, null, null];
    while (path.lockedAngles.length < 3) path.lockedAngles.push(null);
    path.vertexLabels = Array.isArray(path.vertexLabels)
      ? path.vertexLabels.slice(0, 3).map((label, index) => String(label || String.fromCharCode(65 + index)).slice(0, 8))
      : ["A", "B", "C"];
    while (path.vertexLabels.length < 3) path.vertexLabels.push(String.fromCharCode(65 + path.vertexLabels.length));
    return path;
  }

  function polygonAreaWorld(points) {
    if (!Array.isArray(points) || points.length < 3) return 0;
    let twiceArea = 0;
    points.forEach((point, index) => {
      const next = points[(index + 1) % points.length];
      twiceArea += point.x * next.y - next.x * point.y;
    });
    return Math.abs(twiceArea) / 2;
  }

  function finalizeSmartShape(path) {
    if (!isSmartGeometry(path)) return false;
    if (isSmartCircle(path)) return finalizeCircle(path);
    if (isSmartEllipse(path)) {
      delete path.draftStart;
      const frame = ellipseFrame(path);
      // A tap rather than a drag: give it a size worth editing.
      if (Math.PI * frame.radiusX * frame.radiusY < 64) {
        setEllipseGeometry(path, frame.center, 72, 48, 0);
      }
      return true;
    }
    delete path.draftStart;
    if (isSmartTriangle(path)) {
      promoteTriangle(path);
      if (polygonAreaWorld(path.points) < 8) {
        const center = polygonCenter(path);
        path.points = path.triangleType === "equilateral"
          ? equilateralPoints(center, geometryGridStep(geometryUnitScale(path)) * 8)
          : path.triangleType === "right"
          ? [
            { x: center.x - 48, y: center.y - 52 },
            { x: center.x - 48, y: center.y + 52 },
            { x: center.x + 64, y: center.y + 52 }
          ]
          : [
            { x: center.x, y: center.y - 64 },
            { x: center.x - 56, y: center.y + 40 },
            { x: center.x + 56, y: center.y + 40 }
          ];
      }
      if (path.triangleType === "equilateral") {
        path.angleMarks = [true, true, true];
        path.lockedAngles = [null, null, null];
      }
      if (path.triangleType === "right" && !(path.lockedAngles || []).some(Number.isFinite)) {
        path.angleMarks[1] = true;
        path.lockedAngles[1] = Math.PI / 2;
      }
    }
    if (isSmartQuadrilateral(path) && polygonAreaWorld(path.points) < 12) {
      const center = polygonCenter(path);
      path.draftStart = { x: center.x - 56, y: center.y - 42 };
      updateQuadrilateralDraft(path, { x: center.x + 56, y: center.y + 42 });
      delete path.draftStart;
    }
    return true;
  }

  function isMeaningfulShape(path) {
    if (!isSmartGeometry(path)) return false;
    if (isSmartCircle(path)) return circleRadius(path) >= MIN_RADIUS;
    if (isSmartEllipse(path)) {
      const frame = ellipseFrame(path);
      return frame.radiusX >= MIN_RADIUS && frame.radiusY >= MIN_RADIUS;
    }
    return polygonAreaWorld(path.points) >= 8;
  }

  function updateCircleDraft(path, pointer) {
    if (!isSmartCircle(path) || !finitePoint(pointer)) return false;
    const center = circleCenter(path);
    const snapped = snapPoint(pointer, path, {
      grid: path.snapToGrid !== false,
      objects: path.snapToObjects !== false,
      unitScale: circleUnitScale(path)
    });
    const radius = quantizeWorldLength(
      path,
      Math.hypot(snapped.point.x - center.x, snapped.point.y - center.y),
      snapped.kind === "object"
    );
    // CCW-positive, paired with pointOnCircle's write-side convention.
    const worldAngle = Math.atan2(center.y - snapped.point.y, snapped.point.x - center.x);
    setCircleGeometry(path, center, Math.max(0.01, radius), worldAngle - circleRotation(path));
    return true;
  }

  function setDefaultCircleSize(path, drawingSize = 3) {
    if (!isSmartCircle(path)) return false;
    const radius = Math.max(DEFAULT_RADIUS, Number(drawingSize || 3) * 12);
    setCircleGeometry(path, circleCenter(path), radius, 0);
    return true;
  }

  function finalizeCircle(path) {
    if (!isSmartCircle(path)) return false;
    if (circleRadius(path) < MIN_RADIUS) setDefaultCircleSize(path, path.size);
    path.radius = Math.max(MIN_RADIUS, circleRadius(path));
    syncCirclePoints(path);
    return true;
  }

  function afterPathCreated(path, index) {
    if (!isSmartGeometry(path)) return false;
    if (typeof window.setTool === "function") window.setTool("select");
    window.Inkyscib?.Selection?.selectIndex?.(index);
    requestRedraw();
    syncInspector(true);
    return true;
  }

  function measureCircle(path) {
    const scale = circleUnitScale(path);
    const radius = circleRadius(path) / scale;
    return {
      radius,
      diameter: radius * 2,
      circumference: TAU * radius,
      area: Math.PI * radius * radius
    };
  }

  // Perimeter by Ramanujan's second approximation: exact for a circle and within
  // 0.05% for any ellipse at all.
  function measureEllipse(path) {
    const unit = geometryUnitScale(path);
    const frame = ellipseFrame(path);
    const radiusX = frame.radiusX / unit;
    const radiusY = frame.radiusY / unit;
    const sum = radiusX + radiusY;
    const h = sum > 0 ? ((radiusX - radiusY) / sum) ** 2 : 0;
    const major = Math.max(radiusX, radiusY);
    const minor = Math.min(radiusX, radiusY);
    return {
      radiusX,
      radiusY,
      area: Math.PI * radiusX * radiusY,
      perimeter: Math.PI * sum * (1 + 3 * h / (10 + Math.sqrt(4 - 3 * h))),
      eccentricity: major > 0 ? Math.sqrt(Math.max(0, 1 - (minor * minor) / (major * major))) : 0
    };
  }

  function formatNumber(value) {
    if (!Number.isFinite(value)) return "0";
    return value.toFixed(2).replace(/(\.\d*?[1-9])0+$/, "$1").replace(/\.0+$/, "");
  }

  function formatEditableNumber(value) {
    if (!Number.isFinite(value)) return "0";
    return value.toFixed(4).replace(/(\.\d*?[1-9])0+$/, "$1").replace(/\.0+$/, "");
  }

  function normalizedVariable(path) {
    const value = String(path?.variableLabel || "").trim();
    return /^[A-Za-z][A-Za-z0-9_]{0,7}$/.test(value) ? value : "";
  }

  function measurementStrings(path) {
    const values = measureCircle(path);
    const variable = normalizedVariable(path);
    const suffix = " " + unitLabel();
    if (!variable) {
      return {
        radius: `${formatNumber(values.radius)}${suffix}`,
        diameter: `${formatNumber(values.diameter)}${suffix}`,
        circumference: `${formatNumber(values.circumference)}${suffix}`,
        area: `${formatNumber(values.area)} ${unitLabel(true)}`,
        canvasRadius: `r = ${formatNumber(values.radius)}${suffix}`
      };
    }
    return {
      radius: `${variable} = ${formatNumber(values.radius)}${suffix}`,
      diameter: `2${variable} = ${formatNumber(values.diameter)}${suffix}`,
      circumference: `2π${variable} = ${formatNumber(values.circumference)}${suffix}`,
      area: `π${variable}² = ${formatNumber(values.area)} ${unitLabel(true)}`,
      canvasRadius: `${variable} = ${formatNumber(values.radius)}${suffix}`
    };
  }

  function pointDistance(a, b) {
    return Math.hypot(b.x - a.x, b.y - a.y);
  }

  function rotateVector(vector, angle) {
    const cosine = Math.cos(angle);
    const sine = Math.sin(angle);
    return {
      x: vector.x * cosine - vector.y * sine,
      y: vector.x * sine + vector.y * cosine
    };
  }

  function triangleAngle(points, index) {
    const vertex = points[index];
    const a = points[(index + 1) % 3];
    const b = points[(index + 2) % 3];
    const u = { x: a.x - vertex.x, y: a.y - vertex.y };
    const v = { x: b.x - vertex.x, y: b.y - vertex.y };
    if (Math.hypot(u.x, u.y) < 0.001 || Math.hypot(v.x, v.y) < 0.001) return 0;
    return Math.atan2(Math.abs(u.x * v.y - u.y * v.x), u.x * v.x + u.y * v.y);
  }

  function triangleMetrics(path) {
    const points = path.points.slice(0, 3);
    const unit = geometryUnitScale(path);
    const sideAB = pointDistance(points[0], points[1]) / unit;
    const sideBC = pointDistance(points[1], points[2]) / unit;
    const sideCA = pointDistance(points[2], points[0]) / unit;
    const angles = [0, 1, 2].map((index) => triangleAngle(points, index));
    return {
      sideAB,
      sideBC,
      sideCA,
      perimeter: sideAB + sideBC + sideCA,
      area: polygonAreaWorld(points) / (unit * unit),
      angles,
      angleDegrees: angles.map((angle) => angle * 180 / Math.PI)
    };
  }

  // Any polygon, not only four-cornered ones. Diagonals AC and BD are what the
  // quadrilateral inspector shows; on a pentagon or larger they are simply two
  // of its diagonals.
  function quadrilateralMetrics(path) {
    const count = Math.max(3, polygonVertexCount(path) || 4);
    const points = path.points.slice(0, count);
    const unit = geometryUnitScale(path);
    const sides = points.map((point, index) => pointDistance(point, points[(index + 1) % count]) / unit);
    const diagonalAC = pointDistance(points[0], points[2 % count]) / unit;
    const diagonalBD = pointDistance(points[1], points[3 % count]) / unit;
    return {
      sides,
      diagonalAC,
      diagonalBD,
      perimeter: sides.reduce((sum, side) => sum + side, 0),
      area: polygonAreaWorld(points) / (unit * unit),
      angles: points.map((_, index) => {
        const vertex = points[index];
        const previous = points[(index + count - 1) % count];
        const next = points[(index + 1) % count];
        const u = { x: previous.x - vertex.x, y: previous.y - vertex.y };
        const v = { x: next.x - vertex.x, y: next.y - vertex.y };
        return Math.atan2(Math.abs(u.x * v.y - u.y * v.x), u.x * v.x + u.y * v.y);
      })
    };
  }

  function measureGeometry(path) {
    if (isSmartCircle(path)) return measureCircle(path);
    if (isSmartEllipse(path)) return measureEllipse(path);
    if (isSmartTriangle(path)) return triangleMetrics(path);
    if (isSmartQuadrilateral(path)) return quadrilateralMetrics(path);
    return null;
  }

  function signedOrientation(a, b, c) {
    const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    return cross < 0 ? -1 : 1;
  }

  function keepTriangleOffBase(points, draggedIndex, previousPoints) {
    const a = points[(draggedIndex + 1) % 3];
    const b = points[(draggedIndex + 2) % 3];
    const point = points[draggedIndex];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = Math.hypot(dx, dy);
    if (length < 4) return previousPoints.map((value) => ({ ...value }));
    const signedDistance = ((point.x - a.x) * -dy + (point.y - a.y) * dx) / length;
    const minimum = 3;
    if (Math.abs(signedDistance) >= minimum) return points;
    const previousSign = signedOrientation(a, b, previousPoints[draggedIndex]);
    const normal = { x: -dy / length, y: dx / length };
    points[draggedIndex] = {
      x: point.x + normal.x * (previousSign * minimum - signedDistance),
      y: point.y + normal.y * (previousSign * minimum - signedDistance)
    };
    return points;
  }

  function setTriangleAngle(path, index, degrees) {
    if (!isSmartTriangle(path) || !Number.isInteger(index) || index < 0 || index > 2) return false;
    if (path.triangleType === "equilateral" && Math.abs(Number(degrees) - 60) < 0.000001) return true;
    if (path.triangleType === "equilateral") {
      path.triangleType = "custom";
      path.lockedAngles = [null, null, null];
    }
    const target = clamp(Number(degrees), 1, 178) * Math.PI / 180;
    const points = path.points.map((point) => ({ ...point }));
    const pivot = points[index];
    const referenceIndex = (index + 1) % 3;
    const movingIndex = (index + 2) % 3;
    const reference = points[referenceIndex];
    const moving = points[movingIndex];
    const referenceVector = { x: reference.x - pivot.x, y: reference.y - pivot.y };
    const referenceLength = Math.max(4, Math.hypot(referenceVector.x, referenceVector.y));
    const movingLength = Math.max(4, pointDistance(pivot, moving));
    const unit = { x: referenceVector.x / referenceLength, y: referenceVector.y / referenceLength };
    const orientation = signedOrientation(pivot, reference, moving);
    const direction = rotateVector(unit, orientation * target);
    points[movingIndex] = {
      x: pivot.x + direction.x * movingLength,
      y: pivot.y + direction.y * movingLength
    };
    path.points = points;
    path.angleMarks[index] = true;
    if (Number.isFinite(path.lockedAngles[index])) path.lockedAngles[index] = target;
    return true;
  }

  function updateTriangleVertex(path, index, target, originalPath = null, snapKind = null) {
    const previous = (originalPath?.points || path.points).map((point) => ({ ...point }));
    const points = path.points.map((point) => ({ ...point }));
    if (path.triangleType === "equilateral") {
      const fixedIndex = (index + 1) % 3;
      const dependentIndex = (index + 2) % 3;
      const originalVector = {
        x: previous[fixedIndex].x - target.x,
        y: previous[fixedIndex].y - target.y
      };
      const originalLength = Math.hypot(originalVector.x, originalVector.y);
      const fallbackVector = {
        x: previous[fixedIndex].x - previous[index].x,
        y: previous[fixedIndex].y - previous[index].y
      };
      const fallbackLength = Math.hypot(fallbackVector.x, fallbackVector.y) || 1;
      const direction = originalLength >= 0.001
        ? { x: originalVector.x / originalLength, y: originalVector.y / originalLength }
        : { x: fallbackVector.x / fallbackLength, y: fallbackVector.y / fallbackLength };
      const side = quantizeWorldLength(path, Math.max(4, originalLength), snapKind === "object");
      const fixed = {
        x: target.x + direction.x * side,
        y: target.y + direction.y * side
      };
      const sign = signedOrientation(previous[index], previous[fixedIndex], previous[dependentIndex]);
      const dependentVector = rotateVector({ x: fixed.x - target.x, y: fixed.y - target.y }, sign * Math.PI / 3);
      path.points = [];
      path.points[index] = { ...target };
      path.points[fixedIndex] = fixed;
      path.points[dependentIndex] = {
        x: target.x + dependentVector.x,
        y: target.y + dependentVector.y
      };
      path.angleMarks = [true, true, true];
      return true;
    }
    const lockedIndex = (path.lockedAngles || []).findIndex(Number.isFinite);

    if (lockedIndex < 0) {
      points[index] = { ...target };
      path.points = keepTriangleOffBase(points, index, previous);
      return true;
    }

    if (index === lockedIndex) {
      const fixedIndex = (lockedIndex + 1) % 3;
      const movingIndex = (lockedIndex + 2) % 3;
      const oldMoving = points[movingIndex];
      const oldMovingLength = quantizeWorldLength(path, pointDistance(points[lockedIndex], oldMoving), snapKind === "object");
      points[lockedIndex] = { ...target };
      const reference = {
        x: points[fixedIndex].x - target.x,
        y: points[fixedIndex].y - target.y
      };
      const referenceLength = Math.hypot(reference.x, reference.y);
      if (referenceLength < 4) return false;
      const unit = { x: reference.x / referenceLength, y: reference.y / referenceLength };
      const candidates = [1, -1].map((sign) => {
        const direction = rotateVector(unit, sign * path.lockedAngles[lockedIndex]);
        return {
          x: target.x + direction.x * oldMovingLength,
          y: target.y + direction.y * oldMovingLength
        };
      });
      points[movingIndex] = candidates.reduce((best, candidate) => (
        pointDistance(candidate, oldMoving) < pointDistance(best, oldMoving) ? candidate : best
      ));
      path.points = points;
      return true;
    }

    const pivot = points[lockedIndex];
    const fixedIndex = [0, 1, 2].find((candidate) => candidate !== lockedIndex && candidate !== index);
    const fixed = points[fixedIndex];
    const reference = { x: fixed.x - pivot.x, y: fixed.y - pivot.y };
    const referenceLength = Math.max(4, Math.hypot(reference.x, reference.y));
    const unit = { x: reference.x / referenceLength, y: reference.y / referenceLength };
    const targetAngle = path.lockedAngles[lockedIndex];
    const distance = quantizeWorldLength(path, pointDistance(pivot, target), snapKind === "object");
    const candidates = [1, -1].map((sign) => {
      const direction = rotateVector(unit, sign * targetAngle);
      return { x: pivot.x + direction.x * distance, y: pivot.y + direction.y * distance };
    });
    points[index] = candidates.reduce((best, candidate) => (
      pointDistance(candidate, target) < pointDistance(best, target) ? candidate : best
    ));
    path.points = points;
    return true;
  }

  function updateRectangleVertex(path, index, target, originalPath = null, snapKind = null) {
    const source = (originalPath?.points || path.points).map((point) => ({ ...point }));
    const opposite = (index + 2) % 4;
    const next = (index + 1) % 4;
    const previous = (index + 3) % 4;
    const anchor = source[opposite];
    const nextVector = { x: source[next].x - anchor.x, y: source[next].y - anchor.y };
    const previousVector = { x: source[previous].x - anchor.x, y: source[previous].y - anchor.y };
    const nextLength = Math.hypot(nextVector.x, nextVector.y);
    if (nextLength < 4 || Math.hypot(previousVector.x, previousVector.y) < 4) return false;
    const nextAxis = { x: nextVector.x / nextLength, y: nextVector.y / nextLength };
    const previousAxis = closestPerpendicular(nextAxis, previousVector);
    const delta = { x: target.x - anchor.x, y: target.y - anchor.y };
    const clampComponent = (value) => {
      const sign = value < 0 ? -1 : 1;
      return sign * quantizeWorldLength(path, Math.abs(value), snapKind === "object");
    };
    const nextComponent = clampComponent(delta.x * nextAxis.x + delta.y * nextAxis.y);
    const previousComponent = clampComponent(delta.x * previousAxis.x + delta.y * previousAxis.y);
    const points = source.map((point) => ({ ...point }));
    points[next] = {
      x: anchor.x + nextAxis.x * nextComponent,
      y: anchor.y + nextAxis.y * nextComponent
    };
    points[previous] = {
      x: anchor.x + previousAxis.x * previousComponent,
      y: anchor.y + previousAxis.y * previousComponent
    };
    points[index] = {
      x: points[next].x + points[previous].x - anchor.x,
      y: points[next].y + points[previous].y - anchor.y
    };
    path.points = points;
    return true;
  }

  function updateParallelogramVertex(path, index, target, originalPath = null, snapKind = null) {
    const source = (originalPath?.points || path.points).map((point) => ({ ...point }));
    const points = source.map((point) => ({ ...point }));
    const next = (index + 1) % 4;
    const previous = (index + 3) % 4;
    const opposite = (index + 2) % 4;
    points[index] = { ...target };
    [next, previous].forEach((neighbor) => {
      const vector = { x: source[neighbor].x - target.x, y: source[neighbor].y - target.y };
      const rawLength = Math.hypot(vector.x, vector.y);
      const fallback = {
        x: source[neighbor].x - source[index].x,
        y: source[neighbor].y - source[index].y
      };
      const fallbackLength = Math.max(0.001, Math.hypot(fallback.x, fallback.y));
      const direction = rawLength > 0.001
        ? { x: vector.x / rawLength, y: vector.y / rawLength }
        : { x: fallback.x / fallbackLength, y: fallback.y / fallbackLength };
      const length = quantizeWorldLength(path, rawLength || fallbackLength, snapKind === "object");
      points[neighbor] = { x: target.x + direction.x * length, y: target.y + direction.y * length };
    });
    points[opposite] = {
      x: points[next].x + points[previous].x - target.x,
      y: points[next].y + points[previous].y - target.y
    };
    path.points = points;
    return true;
  }

  function closestPerpendicular(direction, reference) {
    const first = { x: -direction.y, y: direction.x };
    const second = { x: direction.y, y: -direction.x };
    return first.x * reference.x + first.y * reference.y >= second.x * reference.x + second.y * reference.y
      ? first
      : second;
  }

  function updateRhombusVertex(path, index, target, snapKind = null) {
    const points = path.points.map((point) => ({ ...point }));
    const center = {
      x: (points[0].x + points[2].x + points[1].x + points[3].x) / 4,
      y: (points[0].y + points[2].y + points[1].y + points[3].y) / 4
    };
    const vector = { x: target.x - center.x, y: target.y - center.y };
    const length = quantizeWorldLength(path, Math.hypot(vector.x, vector.y), snapKind === "object");
    const direction = { x: vector.x / length, y: vector.y / length };
    const opposite = (index + 2) % 4;
    const adjacent = (index + 1) % 4;
    const otherAdjacent = (index + 3) % 4;
    const adjacentLength = quantizeWorldLength(path, (pointDistance(center, points[adjacent]) + pointDistance(center, points[otherAdjacent])) / 2);
    const previousAdjacent = { x: points[adjacent].x - center.x, y: points[adjacent].y - center.y };
    const perpendicular = closestPerpendicular(direction, previousAdjacent);
    points[index] = { x: center.x + direction.x * length, y: center.y + direction.y * length };
    points[opposite] = { x: center.x - direction.x * length, y: center.y - direction.y * length };
    points[adjacent] = { x: center.x + perpendicular.x * adjacentLength, y: center.y + perpendicular.y * adjacentLength };
    points[otherAdjacent] = { x: center.x - perpendicular.x * adjacentLength, y: center.y - perpendicular.y * adjacentLength };
    path.points = points;
    return true;
  }

  function updateKiteVertex(path, index, target, snapKind = null) {
    const points = path.points.map((point) => ({ ...point }));
    const center = { x: (points[1].x + points[3].x) / 2, y: (points[1].y + points[3].y) / 2 };
    const vector = { x: target.x - center.x, y: target.y - center.y };
    const length = quantizeWorldLength(path, Math.hypot(vector.x, vector.y), snapKind === "object");
    const direction = { x: vector.x / length, y: vector.y / length };

    if (index === 0 || index === 2) {
      const opposite = index === 0 ? 2 : 0;
      const oppositeLength = quantizeWorldLength(path, pointDistance(center, points[opposite]));
      const wingLength = quantizeWorldLength(path, (pointDistance(center, points[1]) + pointDistance(center, points[3])) / 2);
      const previousWing = { x: points[1].x - center.x, y: points[1].y - center.y };
      const wingDirection = closestPerpendicular(direction, previousWing);
      points[index] = { x: center.x + direction.x * length, y: center.y + direction.y * length };
      points[opposite] = { x: center.x - direction.x * oppositeLength, y: center.y - direction.y * oppositeLength };
      points[1] = { x: center.x + wingDirection.x * wingLength, y: center.y + wingDirection.y * wingLength };
      points[3] = { x: center.x - wingDirection.x * wingLength, y: center.y - wingDirection.y * wingLength };
    } else {
      const opposite = index === 1 ? 3 : 1;
      const topLength = quantizeWorldLength(path, pointDistance(center, points[0]));
      const bottomLength = quantizeWorldLength(path, pointDistance(center, points[2]));
      const previousAxis = { x: points[0].x - center.x, y: points[0].y - center.y };
      const axisDirection = closestPerpendicular(direction, previousAxis);
      points[index] = { x: center.x + direction.x * length, y: center.y + direction.y * length };
      points[opposite] = { x: center.x - direction.x * length, y: center.y - direction.y * length };
      points[0] = { x: center.x + axisDirection.x * topLength, y: center.y + axisDirection.y * topLength };
      points[2] = { x: center.x - axisDirection.x * bottomLength, y: center.y - axisDirection.y * bottomLength };
    }
    path.points = points;
    return true;
  }

  function updateGeometryVertex(path, index, target, originalPath = null, snapKind = null) {
    if (isSmartEllipse(path)) return updateEllipseAxis(path, index, target, snapKind);
    if (isSmartTriangle(path)) return updateTriangleVertex(path, index, target, originalPath, snapKind);
    if (path.geometryKind === "rectangle") return updateRectangleVertex(path, index, target, originalPath, snapKind);
    if (path.geometryKind === "parallelogram") return updateParallelogramVertex(path, index, target, originalPath, snapKind);
    if (path.geometryKind === "rhombus") return updateRhombusVertex(path, index, target, snapKind);
    if (path.geometryKind === "kite") return updateKiteVertex(path, index, target, snapKind);
    if (REGULAR_POLYGON_KINDS.has(path.geometryKind)) return updateRegularPolygonVertex(path, index, target, snapKind);
    if (path.geometryKind === "trapezium") return updateTrapeziumVertex(path, index, target);
    return false;
  }

  // Dragging an axis end changes that radius alone. The centre and the tilt stay
  // put, the way a compass keeps its point.
  function updateEllipseAxis(path, index, target, snapKind = null) {
    if (!finitePoint(target) || !Number.isInteger(index) || index < 0 || index > 3) return false;
    const frame = ellipseFrame(path);
    const cos = Math.cos(frame.rotation);
    const sin = Math.sin(frame.rotation);
    const along = index % 2 === 0 ? { x: cos, y: sin } : { x: -sin, y: cos };
    const reach = Math.abs((target.x - frame.center.x) * along.x + (target.y - frame.center.y) * along.y);
    const radius = quantizeWorldLength(path, reach, snapKind === "object");
    if (index % 2 === 0) setEllipseGeometry(path, frame.center, radius, frame.radiusY, frame.rotation);
    else setEllipseGeometry(path, frame.center, frame.radiusX, radius, frame.rotation);
    return true;
  }

  // Square, pentagon, hexagon, octagon: the dragged corner sets the size and
  // the turn, and every other corner follows, so the shape stays regular.
  function updateRegularPolygonVertex(path, index, target, snapKind = null) {
    const count = POLYGON_VERTEX_COUNT[path.geometryKind];
    const center = polygonCenter({ points: path.points.slice(0, count) });
    const rawRadius = pointDistance(center, target);
    if (rawRadius < 4) return false;
    // The side is what the inspector and the labels show, so that is what snaps.
    const halfAngle = Math.sin(Math.PI / count);
    const side = quantizeWorldLength(path, 2 * rawRadius * halfAngle, snapKind === "object");
    const start = Math.atan2(target.y - center.y, target.x - center.x) - index * Math.PI * 2 / count;
    path.points = regularPolygonPoints(center, side / (2 * halfAngle), count, start);
    return true;
  }

  // A trapezium keeps AB parallel to DC. The dragged corner goes where it is
  // put; its partner on the same base keeps its place along that base and takes
  // the dragged corner's distance across it, so the base stays parallel.
  function updateTrapeziumVertex(path, index, target) {
    const points = path.points.slice(0, 4).map((point) => ({ ...point }));
    const onTop = index === 0 || index === 1;
    const partner = { 0: 1, 1: 0, 2: 3, 3: 2 }[index];
    const [p, q] = onTop ? [points[3], points[2]] : [points[0], points[1]];
    const length = pointDistance(p, q);
    if (length < 0.001) return false;
    const along = { x: (q.x - p.x) / length, y: (q.y - p.y) / length };
    const across = { x: -along.y, y: along.x };
    const partnerAlong = (points[partner].x - p.x) * along.x + (points[partner].y - p.y) * along.y;
    const offset = (target.x - p.x) * across.x + (target.y - p.y) * across.y;
    points[index] = { x: target.x, y: target.y };
    points[partner] = {
      x: p.x + along.x * partnerAlong + across.x * offset,
      y: p.y + along.y * partnerAlong + across.y * offset
    };
    if (polygonAreaWorld(points) < 8) return false;
    path.points = points;
    return true;
  }

  function translateGeometry(path, targetCenter) {
    const center = geometryCenter(path);
    const dx = targetCenter.x - center.x;
    const dy = targetCenter.y - center.y;
    if (isSmartCircle(path)) {
      setCircleGeometry(path, targetCenter, circleRadius(path), path.radiusAngle || 0);
    } else {
      path.points = path.points.map((point) => ({ x: point.x + dx, y: point.y + dy }));
    }
  }

  function geometryDisplayPoints(path) {
    if (isSmartCircle(path)) return circleDisplayPoints(path);
    if (isSmartEllipse(path)) return ellipseDisplayPoints(path);
    if (isSmartTriangle(path)) return path.points.filter(finitePoint).slice(0, 3);
    if (isSmartQuadrilateral(path)) return path.points.filter(finitePoint).slice(0, polygonVertexCount(path));
    return [];
  }

  function constructionPoint(path, angle) {
    return pointOnCircle(path, angle);
  }

  function constructionPoints(path, construction) {
    if (!isSmartCircle(path) || !construction) return [];
    switch (construction.type) {
      case "radius":
        return [circleCenter(path), constructionPoint(path, numberOr(construction.angle))];
      case "diameter":
        return [
          constructionPoint(path, numberOr(construction.angle)),
          constructionPoint(path, numberOr(construction.angle) + Math.PI)
        ];
      case "chord":
      case "arc":
      case "central-angle":
        return [
          constructionPoint(path, numberOr(construction.startAngle)),
          constructionPoint(path, numberOr(construction.endAngle, Math.PI / 2))
        ];
      case "inscribed-angle":
        return [
          constructionPoint(path, numberOr(construction.vertexAngle)),
          constructionPoint(path, numberOr(construction.startAngle, Math.PI / 2)),
          constructionPoint(path, numberOr(construction.endAngle, Math.PI))
        ];
      case "cyclic-quadrilateral":
        return (construction.angles || []).slice(0, 4).map((angle) => constructionPoint(path, angle));
      case "tangent":
        return [constructionPoint(path, numberOr(construction.angle))];
      default:
        return [];
    }
  }

  function circleDisplayPoints(path) {
    if (!isSmartCircle(path)) return [];
    const points = [];
    for (let index = 0; index < 32; index += 1) {
      points.push(pointOnCircle(path, (index / 32) * TAU));
    }
    (path.constructions || []).forEach((construction) => {
      if (construction.type === "tangent") {
        const tangentPoint = constructionPoint(path, numberOr(construction.angle));
        const angle = numberOr(construction.angle) + circleRotation(path) + Math.PI / 2;
        const halfLength = circleRadius(path) * 0.85;
        // CCW-positive angle convention: sin term negated to match pointOnCircle.
        points.push(
          { x: tangentPoint.x - Math.cos(angle) * halfLength, y: tangentPoint.y + Math.sin(angle) * halfLength },
          { x: tangentPoint.x + Math.cos(angle) * halfLength, y: tangentPoint.y - Math.sin(angle) * halfLength }
        );
      } else {
        points.push(...constructionPoints(path, construction));
      }
    });
    return points;
  }

  function drawSegment(ctx, a, b) {
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }

  function drawCanvasLabel(ctx, text, point, options = {}) {
    const scale = currentScale();
    const fontSize = (options.small ? 10.5 : 12) / scale;
    const padX = 6 / scale;
    const padY = 4 / scale;
    ctx.save();
    ctx.font = `700 ${fontSize}px Segoe UI, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const width = ctx.measureText(text).width + padX * 2;
    const height = fontSize + padY * 2;
    const left = point.x - width / 2;
    const top = point.y - height / 2;
    ctx.fillStyle = options.background || "rgba(12, 16, 25, 0.88)";
    ctx.strokeStyle = options.border || "rgba(139, 132, 255, 0.55)";
    ctx.lineWidth = 1 / scale;
    ctx.beginPath();
    if (typeof ctx.roundRect === "function") {
      ctx.roundRect(left, top, width, height, 6 / scale);
    } else {
      ctx.rect(left, top, width, height);
    }
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = options.color || "#f5f3ff";
    ctx.fillText(text, point.x, point.y + 0.3 / scale);
    ctx.restore();
  }

  function drawAngleArc(ctx, vertex, fromPoint, toPoint, radius) {
    const start = Math.atan2(fromPoint.y - vertex.y, fromPoint.x - vertex.x);
    let end = Math.atan2(toPoint.y - vertex.y, toPoint.x - vertex.x);
    let delta = normalizeAngle(end - start);
    if (delta > Math.PI) {
      end = start - (TAU - delta);
    }
    ctx.beginPath();
    ctx.arc(vertex.x, vertex.y, radius, start, end, end < start);
    ctx.stroke();
  }

  function angleDegrees(vertex, a, b) {
    const first = Math.atan2(a.y - vertex.y, a.x - vertex.x);
    const second = Math.atan2(b.y - vertex.y, b.x - vertex.x);
    let difference = Math.abs(normalizeAngle(second - first));
    if (difference > Math.PI) difference = TAU - difference;
    return difference * 180 / Math.PI;
  }

  function drawConstructions(ctx, path) {
    const center = circleCenter(path);
    const radius = circleRadius(path);
    if (radius <= 0) return;

    ctx.save();
    ctx.strokeStyle = path.color || "#ffffff";
    ctx.fillStyle = path.color || "#ffffff";
    ctx.lineWidth = Math.max((path.size || 2) * 0.72, worldSize(1.25));
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.globalAlpha = 0.9;

    (path.constructions || []).forEach((construction) => {
      const points = constructionPoints(path, construction);
      switch (construction.type) {
        case "radius":
          drawSegment(ctx, points[0], points[1]);
          break;
        case "diameter":
        case "chord":
          drawSegment(ctx, points[0], points[1]);
          break;
        case "arc": {
          const startAngle = numberOr(construction.startAngle);
          const endAngle = numberOr(construction.endAngle, Math.PI / 2);
          const start = startAngle + circleRotation(path);
          const delta = positiveArc(startAngle, endAngle);
          // start/delta are in the CCW-positive (math) convention; ctx.arc's
          // native angle convention is CW-positive (screen y-down), so convert
          // at the call site and sweep anticlockwise to draw the same visual arc.
          const nativeStart = -start;
          ctx.save();
          ctx.lineWidth = Math.max((path.size || 2) * 1.65, worldSize(2.2));
          ctx.beginPath();
          ctx.arc(center.x, center.y, radius, nativeStart, nativeStart - delta, true);
          ctx.stroke();
          ctx.restore();
          break;
        }
        case "central-angle": {
          drawSegment(ctx, center, points[0]);
          drawSegment(ctx, center, points[1]);
          const arcRadius = Math.min(radius * 0.25, worldSize(32));
          drawAngleArc(ctx, center, points[0], points[1], arcRadius);
          const startAngle = numberOr(construction.startAngle);
          const endAngle = numberOr(construction.endAngle);
          const middle = normalizeAngle(startAngle + positiveArc(startAngle, endAngle) / 2);
          const labelPoint = pointOnCircle(path, middle, arcRadius / radius + 0.16);
          drawCanvasLabel(ctx, `${formatNumber(angleDegrees(center, points[0], points[1]))}°`, labelPoint, { small: true });
          break;
        }
        case "inscribed-angle": {
          const vertex = points[0];
          drawSegment(ctx, vertex, points[1]);
          drawSegment(ctx, vertex, points[2]);
          drawAngleArc(ctx, vertex, points[1], points[2], Math.min(radius * 0.18, worldSize(24)));
          const labelPoint = {
            x: vertex.x + (center.x - vertex.x) * 0.25,
            y: vertex.y + (center.y - vertex.y) * 0.25
          };
          drawCanvasLabel(ctx, `${formatNumber(angleDegrees(vertex, points[1], points[2]))}°`, labelPoint, { small: true });
          break;
        }
        case "cyclic-quadrilateral":
          if (points.length === 4) {
            ctx.beginPath();
            ctx.moveTo(points[0].x, points[0].y);
            points.slice(1).forEach((point) => ctx.lineTo(point.x, point.y));
            ctx.closePath();
            ctx.stroke();
          }
          break;
        case "tangent": {
          const tangentPoint = points[0];
          const worldAngle = numberOr(construction.angle) + circleRotation(path);
          const tangentAngle = worldAngle + Math.PI / 2;
          const halfLength = radius * 0.85;
          // CCW-positive angle convention: sin term negated to match pointOnCircle.
          const a = {
            x: tangentPoint.x - Math.cos(tangentAngle) * halfLength,
            y: tangentPoint.y + Math.sin(tangentAngle) * halfLength
          };
          const b = {
            x: tangentPoint.x + Math.cos(tangentAngle) * halfLength,
            y: tangentPoint.y - Math.sin(tangentAngle) * halfLength
          };
          drawSegment(ctx, a, b);
          ctx.save();
          ctx.globalAlpha = 0.55;
          ctx.setLineDash([4 / currentScale(), 4 / currentScale()]);
          drawSegment(ctx, center, tangentPoint);
          ctx.restore();
          break;
        }
      }
    });

    ctx.restore();
  }

  // Fixed 0°/90° reference axes through the centre. These stay world-aligned on
  // purpose: the rotating radius handle already shows the circle's own frame, so
  // a pair of steady axes is what makes an angle readable against the page.
  function drawCircleAxes(ctx, path) {
    if (path.showAxes === false) return;
    const radius = circleRadius(path);
    if (radius < MIN_RADIUS) return;

    const center = circleCenter(path);
    const scale = currentScale();
    const tick = Math.min(radius * 0.12, worldSize(9));

    ctx.save();
    ctx.strokeStyle = path.color || "#ffffff";
    ctx.globalAlpha = 0.32;
    ctx.lineWidth = Math.max(worldSize(0.9), (path.size || 2) * 0.35);
    ctx.setLineDash([4 / scale, 5 / scale]);
    drawSegment(ctx, { x: center.x - radius, y: center.y }, { x: center.x + radius, y: center.y });
    drawSegment(ctx, { x: center.x, y: center.y - radius }, { x: center.x, y: center.y + radius });
    ctx.restore();

    ctx.save();
    ctx.strokeStyle = path.color || "#ffffff";
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = Math.max(worldSize(1), (path.size || 2) * 0.4);
    ctx.setLineDash([]);
    drawSegment(ctx, { x: center.x - tick, y: center.y }, { x: center.x + tick, y: center.y });
    drawSegment(ctx, { x: center.x, y: center.y - tick }, { x: center.x, y: center.y + tick });
    ctx.restore();
  }

  function drawMeasurement(ctx, path) {
    if (path.showMeasurements === false || circleRadius(path) < MIN_RADIUS) return;
    const center = circleCenter(path);
    const localAngle = Number.isFinite(path.radiusAngle) ? path.radiusAngle : 0;
    const handle = pointOnCircle(path, localAngle);
    const worldAngle = localAngle + circleRotation(path);
    // CCW-positive angle convention: sin term negated to match pointOnCircle.
    const normal = { x: Math.sin(worldAngle), y: Math.cos(worldAngle) };
    const labelPoint = {
      x: (center.x + handle.x) / 2 + normal.x * worldSize(17),
      y: (center.y + handle.y) / 2 + normal.y * worldSize(17)
    };

    ctx.save();
    ctx.strokeStyle = path.color || "#ffffff";
    ctx.globalAlpha = 0.42;
    ctx.lineWidth = Math.max(worldSize(1), (path.size || 2) * 0.45);
    ctx.setLineDash([5 / currentScale(), 5 / currentScale()]);
    drawSegment(ctx, center, handle);
    ctx.restore();
    drawCanvasLabel(ctx, measurementStrings(path).canvasRadius, labelPoint);
  }

  // Fill and outline style come from paintShape in tools/select.js, shared with
  // the circle and the triangle so no two kinds can paint differently.
  function drawSmartPolygon(ctx, path) {
    const points = geometryDisplayPoints(path);
    if (points.length < 3) return;
    window.Inkyscib.Geometry.paintShape(ctx, path, (context) => {
      context.moveTo(points[0].x, points[0].y);
      points.slice(1).forEach((point) => context.lineTo(point.x, point.y));
      context.closePath();
    });
  }

  function drawSmartEllipse(ctx, path) {
    const frame = ellipseFrame(path);
    if (frame.radiusX <= 0 || frame.radiusY <= 0) return;
    window.Inkyscib.Geometry.paintShape(ctx, path, (context) => {
      context.ellipse(frame.center.x, frame.center.y, frame.radiusX, frame.radiusY, frame.rotation, 0, TAU);
    });
  }

  // The two semi-axes, dashed from the centre and labelled a and b, drawn the
  // way the circle draws its radius.
  function drawEllipseAnnotations(ctx, path) {
    if (path.showMeasurements === false || !measurementsVisible()) return;
    const frame = ellipseFrame(path);
    if (frame.radiusX < MIN_RADIUS || frame.radiusY < MIN_RADIUS) return;
    const values = measureEllipse(path);
    const cos = Math.cos(frame.rotation);
    const sin = Math.sin(frame.rotation);
    const endA = pointOnEllipse(frame, 0);
    const endB = pointOnEllipse(frame, -Math.PI / 2);
    ctx.save();
    ctx.strokeStyle = path.color || "#ffffff";
    ctx.globalAlpha = 0.42;
    ctx.lineWidth = Math.max(worldSize(1), (path.size || 2) * 0.45);
    ctx.setLineDash([5 / currentScale(), 5 / currentScale()]);
    drawSegment(ctx, frame.center, endA);
    drawSegment(ctx, frame.center, endB);
    ctx.restore();
    const suffix = ` ${unitLabel()}`;
    // a sits just off its axis on the side away from b; b sits beside its axis.
    drawCanvasLabel(ctx, `a = ${formatNumber(values.radiusX)}${suffix}`, {
      x: (frame.center.x + endA.x) / 2 - sin * worldSize(14),
      y: (frame.center.y + endA.y) / 2 + cos * worldSize(14)
    }, { small: true });
    drawCanvasLabel(ctx, `b = ${formatNumber(values.radiusY)}${suffix}`, {
      x: (frame.center.x + endB.x) / 2 + cos * worldSize(36),
      y: (frame.center.y + endB.y) / 2 + sin * worldSize(36)
    }, { small: true });
  }

  function drawEdgeMeasurement(ctx, points, index, value, centroid) {
    const a = points[index];
    const b = points[(index + 1) % points.length];
    const midpoint = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const edge = { x: b.x - a.x, y: b.y - a.y };
    const length = Math.hypot(edge.x, edge.y) || 1;
    let normal = { x: -edge.y / length, y: edge.x / length };
    const towardCenter = { x: centroid.x - midpoint.x, y: centroid.y - midpoint.y };
    if (normal.x * towardCenter.x + normal.y * towardCenter.y > 0) {
      normal = { x: -normal.x, y: -normal.y };
    }
    if (!measurementsVisible()) return;
    drawCanvasLabel(ctx, `${formatNumber(value)} ${unitLabel()}`, {
      x: midpoint.x + normal.x * worldSize(19),
      y: midpoint.y + normal.y * worldSize(19)
    }, { small: true });
  }

  function drawQuadrilateralAnnotations(ctx, path) {
    if (!isSmartQuadrilateral(path)) return;
    const points = path.points.slice(0, polygonVertexCount(path));
    const centroid = polygonCenter(path);
    points.forEach((vertex, index) => {
      const away = { x: vertex.x - centroid.x, y: vertex.y - centroid.y };
      const length = Math.hypot(away.x, away.y) || 1;
      drawCanvasLabel(ctx, path.vertexLabels?.[index] || String.fromCharCode(65 + index), {
        x: vertex.x + away.x / length * worldSize(16),
        y: vertex.y + away.y / length * worldSize(16)
      }, { small: true });
    });
    if (path.showMeasurements === false) return;
    const metrics = quadrilateralMetrics(path);
    // Equal-sided shapes need one side labelled, not two.
    const edges = path.geometryKind === "rhombus" || REGULAR_POLYGON_KINDS.has(path.geometryKind) ? [0] : [0, 1];
    edges.forEach((index) => drawEdgeMeasurement(ctx, points, index, metrics.sides[index], centroid));
  }

  function drawTriangleAnnotations(ctx, path) {
    if (!isSmartTriangle(path)) return;
    const points = path.points.slice(0, 3);
    const centroid = polygonCenter(path);
    const metrics = triangleMetrics(path);
    const marks = path.angleMarks || [false, false, false];
    const locks = path.lockedAngles || [null, null, null];

    if (path.showMeasurements !== false) {
      [metrics.sideAB, metrics.sideBC, metrics.sideCA]
        .forEach((side, index) => drawEdgeMeasurement(ctx, points, index, side, centroid));
    }

    points.forEach((vertex, index) => {
      const away = { x: vertex.x - centroid.x, y: vertex.y - centroid.y };
      const length = Math.hypot(away.x, away.y) || 1;
      const labelPoint = {
        x: vertex.x + away.x / length * worldSize(16),
        y: vertex.y + away.y / length * worldSize(16)
      };
      drawCanvasLabel(ctx, path.vertexLabels?.[index] || String.fromCharCode(65 + index), labelPoint, { small: true });
      if (!marks[index] && !Number.isFinite(locks[index])) return;

      const first = points[(index + 1) % 3];
      const second = points[(index + 2) % 3];
      const arcRadius = Math.min(pointDistance(vertex, first), pointDistance(vertex, second), worldSize(30)) * 0.3;
      ctx.save();
      ctx.strokeStyle = Number.isFinite(locks[index]) ? "#a8a2ff" : (path.color || "#ffffff");
      ctx.lineWidth = Math.max(worldSize(1.3), (path.size || 2) * 0.55);
      drawAngleArc(ctx, vertex, first, second, Math.max(worldSize(10), arcRadius));
      ctx.restore();
      const inside = { x: centroid.x - vertex.x, y: centroid.y - vertex.y };
      const insideLength = Math.hypot(inside.x, inside.y) || 1;
      const angleLabel = {
        x: vertex.x + inside.x / insideLength * Math.max(worldSize(26), arcRadius + worldSize(12)),
        y: vertex.y + inside.y / insideLength * Math.max(worldSize(26), arcRadius + worldSize(12))
      };
      drawCanvasLabel(
        ctx,
        `${formatNumber(metrics.angleDegrees[index])}°${Number.isFinite(locks[index]) ? " •" : ""}`,
        angleLabel,
        { small: true, border: Number.isFinite(locks[index]) ? "rgba(94, 234, 212, 0.68)" : undefined }
      );
    });
  }

  function installGeometryRenderer() {
    const geometry = window.Inkyscib?.Geometry;
    if (!geometry || geometry.__smartGeometryInstalled) return;
    const baseDrawShapeOutline = geometry.drawShapeOutline;
    geometry.drawShapeOutline = function drawGeometryShape(ctx, path) {
      if (isSmartEllipse(path)) {
        drawSmartEllipse(ctx, path);
        drawEllipseAnnotations(ctx, path);
        return;
      }
      if (isSmartQuadrilateral(path)) {
        drawSmartPolygon(ctx, path);
        drawQuadrilateralAnnotations(ctx, path);
        return;
      }
      baseDrawShapeOutline(ctx, path);
      if (isSmartCircle(path)) {
        drawCircleAxes(ctx, path);
        drawConstructions(ctx, path);
        drawMeasurement(ctx, path);
      } else if (isSmartTriangle(path)) {
        drawTriangleAnnotations(ctx, path);
      }
    };
    geometry.__smartGeometryInstalled = true;
  }

  function selectedGeometry() {
    const selection = window.Inkyscib?.Selection;
    const indices = selection?.selectedIndices?.() || [];
    if (indices.length !== 1) return null;
    const path = state()?.paths?.[indices[0]];
    return isSmartGeometry(path) ? { path, index: indices[0] } : null;
  }

  function constructionHandles(path) {
    const handles = [];
    (path.constructions || []).forEach((construction) => {
      const add = (key, angle, offset = 0, index = null) => {
        const point = pointOnCircle(path, angle + offset);
        handles.push({
          type: "construction",
          constructionId: construction.id,
          key,
          index,
          angleOffset: offset,
          x: point.x,
          y: point.y
        });
      };
      switch (construction.type) {
        case "radius":
        case "tangent":
          add("angle", numberOr(construction.angle));
          break;
        case "diameter":
          add("angle", numberOr(construction.angle));
          add("angle", numberOr(construction.angle), Math.PI);
          break;
        case "chord":
        case "arc":
        case "central-angle":
          add("startAngle", numberOr(construction.startAngle));
          add("endAngle", numberOr(construction.endAngle));
          break;
        case "inscribed-angle":
          add("vertexAngle", numberOr(construction.vertexAngle));
          add("startAngle", numberOr(construction.startAngle));
          add("endAngle", numberOr(construction.endAngle));
          break;
        case "cyclic-quadrilateral":
          (construction.angles || []).slice(0, 4).forEach((angle, index) => add("angles", angle, 0, index));
          break;
      }
    });
    return handles;
  }

  function smartRotationHandle(path) {
    const center = geometryCenter(path);
    let top = center.y;
    if (isSmartCircle(path)) {
      top = center.y - circleRadius(path);
    } else {
      const points = geometryDisplayPoints(path);
      if (points.length) top = Math.min(...points.map((point) => point.y));
    }
    return { type: "rotation", x: center.x, y: top - worldSize(34) };
  }

  function smartHandles(path) {
    const center = geometryCenter(path);
    const rotationHandle = smartRotationHandle(path);
    if (isSmartCircle(path)) {
      const radiusHandle = pointOnCircle(path, Number.isFinite(path.radiusAngle) ? path.radiusAngle : 0);
      return [
        ...constructionHandles(path),
        { type: "radius", x: radiusHandle.x, y: radiusHandle.y, locked: !!path.radiusLocked },
        { type: "center", x: center.x, y: center.y },
        rotationHandle
      ];
    }

    if (isSmartEllipse(path)) {
      const ends = path.points.slice(0, 4).map((point, index) => ({ type: "vertex", index, x: point.x, y: point.y }));
      return [...ends, { type: "center", x: center.x, y: center.y }, rotationHandle];
    }

    const count = polygonVertexCount(path) || 4;
    const vertices = path.points.slice(0, count).map((point, index) => ({
      type: "vertex",
      index,
      label: path.vertexLabels?.[index] || String.fromCharCode(65 + index),
      x: point.x,
      y: point.y
    }));
    return [...vertices, { type: "center", x: center.x, y: center.y }, rotationHandle];
  }

  function handleAt(point, path) {
    const tolerance = worldSize(HANDLE_SCREEN_RADIUS + 4);
    const handles = smartHandles(path);
    for (let index = 0; index < handles.length; index += 1) {
      const handle = handles[index];
      if (Math.hypot(point.x - handle.x, point.y - handle.y) <= tolerance) return handle;
    }
    return null;
  }

  function eventWorldPoint(event) {
    if (typeof window.getCanvasPos === "function") return window.getCanvasPos(event);
    return { x: event.clientX, y: event.clientY };
  }

  function updateCanvasCursor(handle) {
    const canvas = document.getElementById("drawingCanvas");
    if (!canvas) return;
    if (!handle) {
      canvas.style.cursor = "default";
      return;
    }
    if (handle.type === "radius" && handle.locked) {
      canvas.style.cursor = "not-allowed";
    } else if (handle.type === "center") {
      canvas.style.cursor = "move";
    } else if (handle.type === "rotation") {
      canvas.style.cursor = "grab";
    } else {
      canvas.style.cursor = "crosshair";
    }
  }

  function beginSmartAction(event) {
    const selected = selectedGeometry();
    if (!selected) return false;
    const point = eventWorldPoint(event);
    const handle = handleAt(point, selected.path);
    if (!handle) return false;

    if (event?.pointerType && event.pointerType !== "mouse") {
      lastSmartTouchAt = performance.now();
    } else if (lastSmartTouchAt > 0 && performance.now() - lastSmartTouchAt < 700) {
      return true;
    }

    updateCanvasCursor(handle);
    if (handle.type === "radius" && handle.locked) return true;

    const action = {
      index: selected.index,
      handle,
      startPoint: point,
      originalPath: deepClone(selected.path),
      before: typeof window.captureHistory === "function" ? window.captureHistory() : null,
      moved: false,
      snap: null
    };
    if (handle.type === "rotation") {
      const center = geometryCenter(selected.path);
      action.rotationCenter = center;
      // Circles store rotation in CCW-positive (standard math) convention;
      // every other smart shape keeps the original screen-space (CW-positive)
      // convention that rotateAround/rotateVector already assume, so only the
      // circle branch gets the y-negation here.
      action.rotationStartAngle = isSmartCircle(selected.path)
        ? Math.atan2(center.y - point.y, point.x - center.x)
        : Math.atan2(point.y - center.y, point.x - center.x);
      action.rotationStartValue = numberOr(selected.path.rotation);
      const canvas = document.getElementById("drawingCanvas");
      if (canvas) canvas.style.cursor = "grabbing";
    }
    state().selection.smartAction = action;
    requestRedraw();
    return true;
  }

  function applySmartAction(event) {
    const s = state();
    const action = s?.selection?.smartAction;
    if (!action) return false;
    const path = s.paths[action.index];
    if (!isSmartGeometry(path)) {
      delete s.selection.smartAction;
      return false;
    }

    const raw = eventWorldPoint(event);
    const handle = action.handle;
    action.moved = action.moved || Math.hypot(raw.x - action.startPoint.x, raw.y - action.startPoint.y) > worldSize(1.5);

    if (handle.type === "rotation") {
      const center = action.rotationCenter;
      // Must match the convention beginSmartAction used for rotationStartAngle
      // above (CCW-positive for circles, unchanged screen-space for everything
      // else) so the delta below is computed consistently.
      const pointerAngle = isSmartCircle(path)
        ? Math.atan2(center.y - raw.y, raw.x - center.x)
        : Math.atan2(raw.y - center.y, raw.x - center.x);
      const rawDelta = pointerAngle - action.rotationStartAngle;
      const delta = Math.atan2(Math.sin(rawDelta), Math.cos(rawDelta));
      if (isSmartCircle(path)) {
        path.rotation = action.rotationStartValue + delta;
        syncCirclePoints(path);
      } else {
        path.points = action.originalPath.points.map((point) => rotateAround(point, center, delta));
        path.rotation = action.rotationStartValue + delta;
      }
      action.snap = null;
      requestRedraw();
      syncInspector(true);
      return true;
    }

    const snapped = snapPoint(raw, path, {
      grid: path.snapToGrid !== false,
      objects: path.snapToObjects !== false,
      unitScale: geometryUnitScale(path)
    });
    const point = snapped.point;
    const center = geometryCenter(path);
    action.snap = snapped.kind ? { ...point, kind: snapped.kind } : null;

    if (handle.type === "center") {
      translateGeometry(path, point);
    } else if (handle.type === "radius" && !path.radiusLocked) {
      const radius = quantizeWorldLength(path, Math.hypot(point.x - center.x, point.y - center.y), snapped.kind === "object");
      // CCW-positive, paired with pointOnCircle's write-side convention below.
      const worldAngle = Math.atan2(center.y - point.y, point.x - center.x);
      setCircleGeometry(path, center, radius, worldAngle - circleRotation(path));
    } else if (handle.type === "construction") {
      const construction = (path.constructions || []).find((item) => item.id === handle.constructionId);
      if (construction) {
        const angle = normalizeAngle(
          Math.atan2(center.y - point.y, point.x - center.x) - circleRotation(path) - (handle.angleOffset || 0)
        );
        if (handle.key === "angles" && Number.isInteger(handle.index)) {
          construction.angles[handle.index] = angle;
        } else {
          construction[handle.key] = angle;
        }
      }
    } else if (handle.type === "vertex" && Number.isInteger(handle.index)) {
      updateGeometryVertex(path, handle.index, point, action.originalPath, snapped.kind);
    }

    requestRedraw();
    syncInspector(true);
    return true;
  }

  function endSmartAction() {
    const s = state();
    const action = s?.selection?.smartAction;
    if (!action) return false;
    delete s.selection.smartAction;
    if (action.moved) {
      if (typeof window.commitHistory === "function" && action.before) window.commitHistory(action.before);
      else s.redoStack = [];
      safeSave();
    }
    updateCanvasCursor(null);
    requestRedraw();
    syncInspector(true);
    return true;
  }

  function hoverSmartHandle(event) {
    const selected = selectedGeometry();
    if (!selected || !event) return false;
    const handle = handleAt(eventWorldPoint(event), selected.path);
    if (!handle) return false;
    updateCanvasCursor(handle);
    return true;
  }

  function drawOverlayHandle(ctx, handle) {
    const scale = currentScale();
    const radius = (handle.type === "center" || handle.type === "rotation" ? 7.5 : handle.type === "radius" ? 7 : 5.5) / scale;
    ctx.save();
    ctx.lineWidth = 1.5 / scale;
    ctx.strokeStyle = handle.locked ? "rgba(255, 116, 135, 0.98)" : "rgba(170, 165, 255, 1)";
    ctx.fillStyle = handle.type === "construction"
      ? "rgba(112, 103, 255, 0.9)"
      : "rgba(12, 16, 25, 0.96)";
    ctx.shadowColor = "rgba(91, 82, 255, 0.4)";
    ctx.shadowBlur = 7 / scale;
    ctx.beginPath();
    if (handle.type === "construction") {
      ctx.moveTo(handle.x, handle.y - radius);
      ctx.lineTo(handle.x + radius, handle.y);
      ctx.lineTo(handle.x, handle.y + radius);
      ctx.lineTo(handle.x - radius, handle.y);
      ctx.closePath();
    } else {
      ctx.arc(handle.x, handle.y, radius, 0, TAU);
    }
    ctx.fill();
    ctx.stroke();

    if (handle.type === "center") {
      ctx.shadowBlur = 0;
      ctx.beginPath();
      ctx.moveTo(handle.x - radius * 0.55, handle.y);
      ctx.lineTo(handle.x + radius * 0.55, handle.y);
      ctx.moveTo(handle.x, handle.y - radius * 0.55);
      ctx.lineTo(handle.x, handle.y + radius * 0.55);
      ctx.stroke();
    }
    if (handle.type === "rotation") {
      ctx.shadowBlur = 0;
      ctx.beginPath();
      ctx.arc(handle.x, handle.y, radius * 0.55, Math.PI * 0.2, Math.PI * 1.75);
      ctx.stroke();
      const arrowAngle = Math.PI * 1.75;
      const arrowX = handle.x + Math.cos(arrowAngle) * radius * 0.55;
      const arrowY = handle.y + Math.sin(arrowAngle) * radius * 0.55;
      ctx.beginPath();
      ctx.moveTo(arrowX, arrowY);
      ctx.lineTo(arrowX - radius * 0.5, arrowY - radius * 0.08);
      ctx.lineTo(arrowX - radius * 0.08, arrowY + radius * 0.48);
      ctx.stroke();
    }
    if (handle.locked) {
      ctx.shadowBlur = 0;
      ctx.fillStyle = "rgba(255, 116, 135, 1)";
      ctx.beginPath();
      ctx.arc(handle.x + radius * 0.72, handle.y - radius * 0.72, radius * 0.34, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  }

  function drawSmartOverlay(ctx, path) {
    const center = geometryCenter(path);
    const handles = smartHandles(path);
    const radiusHandle = handles.find((handle) => handle.type === "radius");
    const rotationHandle = handles.find((handle) => handle.type === "rotation");
    const action = state()?.selection?.smartAction;

    ctx.save();
    ctx.lineWidth = 1.3 / currentScale();
    ctx.strokeStyle = "rgba(132, 125, 255, 0.96)";
    ctx.setLineDash([7 / currentScale(), 5 / currentScale()]);
    if (isSmartCircle(path)) {
      ctx.beginPath();
      ctx.arc(center.x, center.y, circleRadius(path) + worldSize(5), 0, TAU);
      ctx.stroke();
    } else {
      const points = geometryDisplayPoints(path);
      if (points.length) {
        ctx.beginPath();
        ctx.moveTo(points[0].x, points[0].y);
        points.slice(1).forEach((point) => ctx.lineTo(point.x, point.y));
        ctx.closePath();
        ctx.stroke();
      }
    }
    ctx.setLineDash([]);
    if (radiusHandle) {
      ctx.globalAlpha = 0.72;
      drawSegment(ctx, center, radiusHandle);
    }
    if (rotationHandle) {
      ctx.globalAlpha = 0.72;
      drawSegment(ctx, center, rotationHandle);
    }
    ctx.restore();

    handles.forEach((handle) => drawOverlayHandle(ctx, handle));

    if (action?.snap) {
      ctx.save();
      ctx.strokeStyle = action.snap.kind === "object" ? "#5eead4" : "#fbbf24";
      ctx.lineWidth = 1.5 / currentScale();
      const marker = 9 / currentScale();
      ctx.beginPath();
      ctx.arc(action.snap.x, action.snap.y, marker, 0, TAU);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(action.snap.x - marker * 1.45, action.snap.y);
      ctx.lineTo(action.snap.x + marker * 1.45, action.snap.y);
      ctx.moveTo(action.snap.x, action.snap.y - marker * 1.45);
      ctx.lineTo(action.snap.x, action.snap.y + marker * 1.45);
      ctx.stroke();
      ctx.restore();
    }
  }

  function installSelectionHooks() {
    const selection = window.Inkyscib?.Selection;
    if (!selection || selection.__smartGeometryInstalled) return;
    const base = {
      handleDown: selection.handleDown,
      handleMove: selection.handleMove,
      handleUp: selection.handleUp,
      drawOverlay: selection.drawOverlay,
      clear: selection.clear,
      updateHoverCursor: selection.updateHoverCursor
    };

    selection.handleDown = function handleGeometryDown(event) {
      if (beginSmartAction(event)) return true;
      return base.handleDown(event);
    };
    selection.handleMove = function handleGeometryMove(event) {
      if (state()?.selection?.smartAction) return applySmartAction(event);
      if (hoverSmartHandle(event)) return true;
      return base.handleMove(event);
    };
    selection.handleUp = function handleGeometryUp(event) {
      if (state()?.selection?.smartAction) return endSmartAction(event);
      return base.handleUp(event);
    };
    selection.drawOverlay = function drawGeometryOverlay(ctx) {
      const selected = selectedGeometry();
      const marquee = state()?.selection?.action?.mode === "marquee";
      if (selected && !marquee) {
        drawSmartOverlay(ctx, selected.path);
      } else {
        base.drawOverlay(ctx);
      }
      syncInspector();
    };
    selection.clear = function clearGeometrySelection(options) {
      if (state()?.selection?.smartAction) delete state().selection.smartAction;
      const result = base.clear(options);
      syncInspector(true);
      return result;
    };
    selection.updateHoverCursor = function updateGeometryHover(event) {
      if (hoverSmartHandle(event)) return true;
      return base.updateHoverCursor(event);
    };
    selection.__smartGeometryInstalled = true;
  }

  function newConstruction(type) {
    const base = {
      id: `geometry-${Date.now().toString(36)}-${(++constructionCounter).toString(36)}`,
      type
    };
    switch (type) {
      case "radius":
        return { ...base, angle: Math.PI / 4 };
      case "diameter":
        return { ...base, angle: 0 };
      case "chord":
        return { ...base, startAngle: -Math.PI / 3, endAngle: Math.PI / 3 };
      case "arc":
        return { ...base, startAngle: Math.PI * 0.12, endAngle: Math.PI * 0.82 };
      case "central-angle":
        return { ...base, startAngle: -Math.PI / 6, endAngle: Math.PI / 3 };
      case "inscribed-angle":
        return { ...base, vertexAngle: Math.PI * 1.45, startAngle: Math.PI * 0.15, endAngle: Math.PI * 0.82 };
      case "cyclic-quadrilateral":
        return { ...base, angles: [0.22, 1.65, 3.18, 4.75] };
      case "tangent":
        return { ...base, angle: -Math.PI / 4 };
      default:
        return null;
    }
  }

  function mutateSelected(mutator) {
    const selected = selectedGeometry();
    if (!selected) return false;
    if (typeof window.commitHistory === "function") window.commitHistory();
    mutator(selected.path, selected.index);
    normalizeSmartGeometry(selected.path);
    requestRedraw();
    safeSave();
    syncInspector(true);
    return true;
  }

  function beginFieldEdit(kind) {
    const selected = selectedGeometry();
    if (!selected) return;
    fieldEdit = {
      kind,
      index: selected.index,
      before: typeof window.captureHistory === "function" ? window.captureHistory() : null,
      changed: false
    };
  }

  function liveFieldEdit(kind, mutator) {
    const selected = selectedGeometry();
    if (!selected) return;
    if (!fieldEdit || fieldEdit.kind !== kind || fieldEdit.index !== selected.index) beginFieldEdit(kind);
    mutator(selected.path);
    normalizeSmartGeometry(selected.path);
    if (fieldEdit) fieldEdit.changed = true;
    requestRedraw();
    syncInspector(true);
  }

  function finishFieldEdit(kind) {
    if (!fieldEdit || fieldEdit.kind !== kind) return;
    if (fieldEdit.changed) {
      if (typeof window.commitHistory === "function" && fieldEdit.before) window.commitHistory(fieldEdit.before);
      safeSave();
    }
    fieldEdit = null;
    syncInspector(true);
  }

  function inputIsFocused(element) {
    return document.activeElement === element;
  }

  function colorToHex(color) {
    if (/^#[0-9a-f]{6}$/i.test(color || "")) return color;
    const names = { white: "#ffffff", black: "#000000", red: "#ff0000", green: "#008000", blue: "#0000ff" };
    return names[String(color || "").toLowerCase()] || "#ffffff";
  }

  function geometryDimensionDescriptors(path) {
    if (isSmartEllipse(path)) {
      const values = measureEllipse(path);
      return [
        { key: "radiusX", label: "Semi-axis a", value: values.radiusX, unit: unitLabel(), min: MIN_DIMENSION_UNITS },
        { key: "radiusY", label: "Semi-axis b", value: values.radiusY, unit: unitLabel(), min: MIN_DIMENSION_UNITS }
      ];
    }
    if (isSmartTriangle(path)) {
      const values = triangleMetrics(path);
      if (path.triangleType === "equilateral") {
        return [{ key: "side", label: "Equal sides", value: values.sideAB, unit: unitLabel(), min: MIN_DIMENSION_UNITS }];
      }
      return [
        { key: "sideAB", label: "Side AB", value: values.sideAB, unit: unitLabel(), min: MIN_DIMENSION_UNITS },
        { key: "sideBC", label: "Side BC", value: values.sideBC, unit: unitLabel(), min: MIN_DIMENSION_UNITS },
        { key: "sideCA", label: "Side CA", value: values.sideCA, unit: unitLabel(), min: MIN_DIMENSION_UNITS }
      ];
    }
    if (!isSmartQuadrilateral(path)) return [];
    const values = quadrilateralMetrics(path);
    if (REGULAR_POLYGON_KINDS.has(path.geometryKind)) {
      return [{ key: "side", label: "Side", value: values.sides[0], unit: unitLabel(), min: MIN_DIMENSION_UNITS }];
    }
    if (path.geometryKind === "trapezium") return [];
    if (path.geometryKind === "rectangle") {
      return [
        { key: "width", label: "Width", value: values.sides[0], unit: unitLabel(), min: MIN_DIMENSION_UNITS },
        { key: "height", label: "Height", value: values.sides[1], unit: unitLabel(), min: MIN_DIMENSION_UNITS }
      ];
    }
    if (path.geometryKind === "parallelogram") {
      return [
        { key: "base", label: "Base", value: values.sides[0], unit: unitLabel(), min: MIN_DIMENSION_UNITS },
        { key: "side", label: "Side", value: values.sides[3], unit: unitLabel(), min: MIN_DIMENSION_UNITS },
        { key: "angle", label: "Angle A", value: values.angles[0] * 180 / Math.PI, unit: "\u00b0", min: 1, max: 179 }
      ];
    }
    if (path.geometryKind === "rhombus") {
      return [
        { key: "diagonalAC", label: "Diagonal AC", value: values.diagonalAC, unit: unitLabel(), min: MIN_DIMENSION_UNITS },
        { key: "diagonalBD", label: "Diagonal BD", value: values.diagonalBD, unit: unitLabel(), min: MIN_DIMENSION_UNITS }
      ];
    }
    return [
      { key: "diagonalAC", label: "Axis AC", value: values.diagonalAC, unit: unitLabel(), min: MIN_DIMENSION_UNITS },
      { key: "diagonalBD", label: "Cross BD", value: values.diagonalBD, unit: unitLabel(), min: MIN_DIMENSION_UNITS }
    ];
  }

  function setGeometryDimension(path, key, rawValue) {
    if (!isSmartGeometry(path)) return false;
    const value = Number(rawValue);
    if (!Number.isFinite(value)) return false;
    const unit = geometryUnitScale(path);

    if (isSmartEllipse(path)) {
      if ((key !== "radiusX" && key !== "radiusY") || value < MIN_DIMENSION_UNITS) return false;
      const frame = ellipseFrame(path);
      setEllipseGeometry(
        path,
        frame.center,
        key === "radiusX" ? value * unit : frame.radiusX,
        key === "radiusY" ? value * unit : frame.radiusY,
        frame.rotation
      );
      return true;
    }

    if (isSmartTriangle(path)) {
      if (path.triangleType === "equilateral" && key === "side") {
        if (value < MIN_DIMENSION_UNITS) return false;
        const center = polygonCenter(path);
        const first = path.points[0];
        const rotation = Math.atan2(first.y - center.y, first.x - center.x) + Math.PI / 2;
        path.points = equilateralPoints(center, value * unit, rotation);
        path.angleMarks = [true, true, true];
        return true;
      }
      const pairs = { sideAB: [0, 1], sideBC: [1, 2], sideCA: [2, 0] };
      const pair = pairs[key];
      if (!pair || value < MIN_DIMENSION_UNITS) return false;
      const [firstIndex, secondIndex] = pair;
      const first = path.points[firstIndex];
      const second = path.points[secondIndex];
      const length = pointDistance(first, second);
      const lockedIndex = (path.lockedAngles || []).findIndex(Number.isFinite);
      if (lockedIndex >= 0) {
        const targetLength = value * unit;
        if (pair.includes(lockedIndex)) {
          const movingIndex = firstIndex === lockedIndex ? secondIndex : firstIndex;
          const pivot = path.points[lockedIndex];
          const moving = path.points[movingIndex];
          const rayLength = Math.max(0.001, pointDistance(pivot, moving));
          path.points[movingIndex] = {
            x: pivot.x + (moving.x - pivot.x) / rayLength * targetLength,
            y: pivot.y + (moving.y - pivot.y) / rayLength * targetLength
          };
        } else {
          const scale = targetLength / Math.max(0.001, length);
          const pivot = path.points[lockedIndex];
          pair.forEach((pointIndex) => {
            const point = path.points[pointIndex];
            path.points[pointIndex] = {
              x: pivot.x + (point.x - pivot.x) * scale,
              y: pivot.y + (point.y - pivot.y) * scale
            };
          });
        }
        return true;
      }
      const direction = length > 0.001
        ? { x: (second.x - first.x) / length, y: (second.y - first.y) / length }
        : { x: 1, y: 0 };
      const midpoint = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
      const half = value * unit / 2;
      path.points[firstIndex] = { x: midpoint.x - direction.x * half, y: midpoint.y - direction.y * half };
      path.points[secondIndex] = { x: midpoint.x + direction.x * half, y: midpoint.y + direction.y * half };
      path.triangleType = "custom";
      path.lockedAngles = [null, null, null];
      return true;
    }

    if (path.geometryKind === "rectangle") {
      if (!["width", "height"].includes(key) || value < MIN_DIMENSION_UNITS) return false;
      const center = polygonCenter(path);
      const a = path.points[0];
      const b = path.points[1];
      const d = path.points[3];
      const edge = { x: b.x - a.x, y: b.y - a.y };
      const edgeLength = Math.max(0.001, Math.hypot(edge.x, edge.y));
      const e = { x: edge.x / edgeLength, y: edge.y / edgeLength };
      const n = closestPerpendicular(e, { x: d.x - a.x, y: d.y - a.y });
      const values = quadrilateralMetrics(path);
      const width = (key === "width" ? value : values.sides[0]) * unit;
      const height = (key === "height" ? value : values.sides[1]) * unit;
      path.points = [
        { x: center.x - e.x * width / 2 - n.x * height / 2, y: center.y - e.y * width / 2 - n.y * height / 2 },
        { x: center.x + e.x * width / 2 - n.x * height / 2, y: center.y + e.y * width / 2 - n.y * height / 2 },
        { x: center.x + e.x * width / 2 + n.x * height / 2, y: center.y + e.y * width / 2 + n.y * height / 2 },
        { x: center.x - e.x * width / 2 + n.x * height / 2, y: center.y - e.y * width / 2 + n.y * height / 2 }
      ];
      return true;
    }

    if (path.geometryKind === "parallelogram") {
      if (!["base", "side", "angle"].includes(key)) return false;
      if (key === "angle" ? value < 1 || value > 179 : value < MIN_DIMENSION_UNITS) return false;
      const a = path.points[0];
      const b = path.points[1];
      const d = path.points[3];
      const u = { x: b.x - a.x, y: b.y - a.y };
      const v = { x: d.x - a.x, y: d.y - a.y };
      const uLength = Math.max(0.001, Math.hypot(u.x, u.y));
      const vLength = Math.max(0.001, Math.hypot(v.x, v.y));
      const e = { x: u.x / uLength, y: u.y / uLength };
      const handedness = u.x * v.y - u.y * v.x < 0 ? -1 : 1;
      const currentAngle = Math.atan2(Math.abs(u.x * v.y - u.y * v.x), u.x * v.x + u.y * v.y);
      const base = key === "base" ? value * unit : uLength;
      const side = key === "side" ? value * unit : vLength;
      const angle = key === "angle" ? value * Math.PI / 180 : currentAngle;
      const nextU = { x: e.x * base, y: e.y * base };
      const sideDirection = rotateVector(e, handedness * angle);
      const nextV = { x: sideDirection.x * side, y: sideDirection.y * side };
      const center = polygonCenter(path);
      const nextA = { x: center.x - (nextU.x + nextV.x) / 2, y: center.y - (nextU.y + nextV.y) / 2 };
      path.points = [
        nextA,
        { x: nextA.x + nextU.x, y: nextA.y + nextU.y },
        { x: nextA.x + nextU.x + nextV.x, y: nextA.y + nextU.y + nextV.y },
        { x: nextA.x + nextV.x, y: nextA.y + nextV.y }
      ];
      return true;
    }

    if (path.geometryKind === "rhombus") {
      if (!["diagonalAC", "diagonalBD"].includes(key) || value < MIN_DIMENSION_UNITS) return false;
      const center = polygonCenter(path);
      const axis = { x: path.points[0].x - center.x, y: path.points[0].y - center.y };
      const axisLength = Math.max(0.001, Math.hypot(axis.x, axis.y));
      const e = { x: axis.x / axisLength, y: axis.y / axisLength };
      const n = closestPerpendicular(e, { x: path.points[1].x - center.x, y: path.points[1].y - center.y });
      const values = quadrilateralMetrics(path);
      const halfAC = (key === "diagonalAC" ? value : values.diagonalAC) * unit / 2;
      const halfBD = (key === "diagonalBD" ? value : values.diagonalBD) * unit / 2;
      path.points = [
        { x: center.x + e.x * halfAC, y: center.y + e.y * halfAC },
        { x: center.x + n.x * halfBD, y: center.y + n.y * halfBD },
        { x: center.x - e.x * halfAC, y: center.y - e.y * halfAC },
        { x: center.x - n.x * halfBD, y: center.y - n.y * halfBD }
      ];
      return true;
    }

    if (path.geometryKind === "kite") {
      if (!["diagonalAC", "diagonalBD"].includes(key) || value < MIN_DIMENSION_UNITS) return false;
      const [a, b, c, d] = path.points;
      const axis = { x: c.x - a.x, y: c.y - a.y };
      const axisLength = Math.max(0.001, Math.hypot(axis.x, axis.y));
      const e = { x: axis.x / axisLength, y: axis.y / axisLength };
      const foot = { x: (b.x + d.x) / 2, y: (b.y + d.y) / 2 };
      const n = closestPerpendicular(e, { x: b.x - foot.x, y: b.y - foot.y });
      const split = clamp(((foot.x - a.x) * e.x + (foot.y - a.y) * e.y) / axisLength, 0.05, 0.95);
      const values = quadrilateralMetrics(path);
      const lengthAC = (key === "diagonalAC" ? value : values.diagonalAC) * unit;
      const lengthBD = (key === "diagonalBD" ? value : values.diagonalBD) * unit;
      const center = polygonCenter(path);
      const nextFoot = {
        x: center.x - e.x * ((1 - 2 * split) * lengthAC / 4),
        y: center.y - e.y * ((1 - 2 * split) * lengthAC / 4)
      };
      path.points = [
        { x: nextFoot.x - e.x * split * lengthAC, y: nextFoot.y - e.y * split * lengthAC },
        { x: nextFoot.x + n.x * lengthBD / 2, y: nextFoot.y + n.y * lengthBD / 2 },
        { x: nextFoot.x + e.x * (1 - split) * lengthAC, y: nextFoot.y + e.y * (1 - split) * lengthAC },
        { x: nextFoot.x - n.x * lengthBD / 2, y: nextFoot.y - n.y * lengthBD / 2 }
      ];
      return true;
    }

    if (REGULAR_POLYGON_KINDS.has(path.geometryKind)) {
      if (key !== "side" || value < MIN_DIMENSION_UNITS) return false;
      const count = POLYGON_VERTEX_COUNT[path.geometryKind];
      const points = path.points.slice(0, count);
      const center = polygonCenter({ points });
      const start = Math.atan2(points[0].y - center.y, points[0].x - center.x);
      path.points = regularPolygonPoints(center, value * unit / (2 * Math.sin(Math.PI / count)), count, start);
      return true;
    }
    return false;
  }

  function geometryRotationDegrees(path) {
    const radians = numberOr(path?.rotation);
    return Math.atan2(Math.sin(radians), Math.cos(radians)) * 180 / Math.PI;
  }

  function setGeometryRotation(path, degrees) {
    if (!isSmartGeometry(path) || !Number.isFinite(Number(degrees))) return false;
    const target = Number(degrees) * Math.PI / 180;
    const current = numberOr(path.rotation);
    const delta = target - current;
    if (!isSmartCircle(path)) {
      const center = geometryCenter(path);
      path.points = path.points.map((point) => rotateAround(point, center, delta));
    }
    path.rotation = target;
    if (isSmartCircle(path)) syncCirclePoints(path);
    return true;
  }

  function renderDimensionFields(path) {
    const section = inspector?.querySelector("#geometryDimensionControls");
    const fields = inspector?.querySelector("#geometryDimensionFields");
    if (!section || !fields) return;
    const descriptors = isSmartCircle(path) ? [] : geometryDimensionDescriptors(path);
    section.hidden = descriptors.length === 0;
    if (!descriptors.length) {
      dimensionFieldsSignature = "";
      fields.replaceChildren();
      return;
    }
    const signature = `${path.geometryKind}:${descriptors.map((item) => (
      `${item.key}:${item.label}:${item.unit}:${item.min}:${item.max ?? ""}`
    )).join("|")}`;
    if (signature !== dimensionFieldsSignature) {
      dimensionFieldsSignature = signature;
      fields.replaceChildren();
      descriptors.forEach((descriptor) => {
        const label = document.createElement("label");
        label.className = "geometry-dimension-field";
        const caption = document.createElement("span");
        caption.textContent = descriptor.label;
        const wrap = document.createElement("span");
        wrap.className = "geometry-number-wrap";
        const input = document.createElement("input");
        input.type = "number";
        input.inputMode = "decimal";
        input.step = "any";
        input.min = String(descriptor.min);
        if (Number.isFinite(descriptor.max)) input.max = String(descriptor.max);
        input.id = `geometryDimension${descriptor.key.charAt(0).toUpperCase()}${descriptor.key.slice(1)}Input`;
        input.dataset.geometryDimension = descriptor.key;
        input.setAttribute("aria-label", descriptor.label);
        const unitLabel = document.createElement("small");
        unitLabel.textContent = descriptor.unit;
        wrap.append(input, unitLabel);
        label.append(caption, wrap);
        fields.append(label);
      });
    }
    descriptors.forEach((descriptor) => {
      const input = fields.querySelector(`[data-geometry-dimension="${descriptor.key}"]`);
      if (input && !inputIsFocused(input)) {
        input.value = formatEditableNumber(descriptor.value);
        input.setAttribute("aria-invalid", "false");
      }
    });
  }

  function updateConstructionList(path) {
    const list = inspector?.querySelector("#geometryConstructionList");
    if (!list) return;
    const signature = (path.constructions || []).map((item) => `${item.id}:${item.type}`).join("|");
    if (signature === constructionListSignature) return;
    constructionListSignature = signature;
    list.replaceChildren();
    (path.constructions || []).forEach((construction) => {
      const item = document.createElement("div");
      item.className = "geometry-construction-item";
      item.innerHTML = `<span aria-hidden="true"></span><strong>${CONSTRUCTION_NAMES[construction.type] || construction.type}</strong>`;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.dataset.removeConstruction = construction.id;
      remove.setAttribute("aria-label", `Remove ${CONSTRUCTION_NAMES[construction.type] || construction.type}`);
      remove.title = "Remove construction";
      remove.textContent = "×";
      item.appendChild(remove);
      list.appendChild(item);
    });
  }

  function unitText(value, squared = false) {
    return `${formatNumber(value)} ${unitLabel(squared)}`;
  }

  function inspectorMeasurementData(path) {
    if (isSmartCircle(path)) {
      const strings = measurementStrings(path);
      return {
        title: "Circle",
        labels: ["Radius", "Diameter", "Circumference", "Area"],
        values: [strings.radius, strings.diameter, strings.circumference, strings.area],
        summary: ""
      };
    }

    if (isSmartEllipse(path)) {
      const values = measureEllipse(path);
      return {
        title: "Ellipse",
        labels: ["Semi-axis a", "Semi-axis b", "Perimeter", "Area"],
        values: [unitText(values.radiusX), unitText(values.radiusY), `\u2248 ${unitText(values.perimeter)}`, unitText(values.area, true)],
        summary: `Area \u03c0ab \u2022 Eccentricity ${formatNumber(values.eccentricity)}`
      };
    }

    if (isSmartTriangle(path)) {
      const values = triangleMetrics(path);
      return {
        title: path.triangleType === "equilateral"
          ? "Equilateral Triangle"
          : path.triangleType === "right"
          ? "Right Triangle"
          : "Triangle",
        labels: ["Side AB", "Side BC", "Side CA", "Area"],
        values: [unitText(values.sideAB), unitText(values.sideBC), unitText(values.sideCA), unitText(values.area, true)],
        summary: `Perimeter ${unitText(values.perimeter)} \u2022 ` +
          values.angleDegrees.map((angle, index) => `\u2220${String.fromCharCode(65 + index)} ${formatNumber(angle)}\u00b0`).join(" \u2022 ")
      };
    }

    const values = quadrilateralMetrics(path);
    const titles = {
      rectangle: "Rectangle",
      parallelogram: "Parallelogram",
      rhombus: "Rhombus",
      kite: "Kite",
      square: "Square",
      trapezium: "Trapezium",
      pentagon: "Pentagon",
      hexagon: "Hexagon",
      octagon: "Octagon"
    };
    const title = titles[path.geometryKind] || "Quadrilateral";
    if (REGULAR_POLYGON_KINDS.has(path.geometryKind)) {
      const corners = polygonVertexCount(path);
      return {
        title,
        labels: ["Side", "Perimeter", "Area", "Interior angle"],
        values: [unitText(values.sides[0]), unitText(values.perimeter), unitText(values.area, true), `${formatNumber((corners - 2) * 180 / corners)}\u00b0`],
        summary: `${corners} equal sides and equal angles`
      };
    }
    if (path.geometryKind === "trapezium") {
      return {
        title,
        labels: ["Top AB", "Bottom DC", "Area", "Perimeter"],
        values: [unitText(values.sides[0]), unitText(values.sides[2]), unitText(values.area, true), unitText(values.perimeter)],
        summary: "AB is parallel to DC"
      };
    }
    if (path.geometryKind === "rectangle") {
      return {
        title,
        labels: ["Width AB", "Height BC", "Area", "Perimeter"],
        values: [unitText(values.sides[0]), unitText(values.sides[1]), unitText(values.area, true), unitText(values.perimeter)],
        summary: `Diagonals ${unitText(values.diagonalAC)} \u00d7 ${unitText(values.diagonalBD)}`
      };
    }
    if (path.geometryKind === "rhombus") {
      return {
        title,
        labels: ["Diagonal AC", "Diagonal BD", "Side", "Area"],
        values: [unitText(values.diagonalAC), unitText(values.diagonalBD), unitText(values.sides[0]), unitText(values.area, true)],
        summary: `Equal sides \u2022 Perimeter ${unitText(values.perimeter)}`
      };
    }
    if (path.geometryKind === "kite") {
      return {
        title,
        labels: ["Axis AC", "Cross BD", "Area", "Perimeter"],
        values: [unitText(values.diagonalAC), unitText(values.diagonalBD), unitText(values.area, true), unitText(values.perimeter)],
        summary: `Side pairs ${unitText((values.sides[0] + values.sides[3]) / 2)} \u2022 ${unitText((values.sides[1] + values.sides[2]) / 2)}`
      };
    }
    return {
      title,
      labels: ["Side AB", "Side BC", "Area", "Perimeter"],
      values: [unitText(values.sides[0]), unitText(values.sides[1]), unitText(values.area, true), unitText(values.perimeter)],
      summary: `Diagonals ${unitText(values.diagonalAC)} \u00d7 ${unitText(values.diagonalBD)}`
    };
  }

  function syncInspector(force = false) {
    if (!inspector) return;
    const selected = selectedGeometry();
    const visible = !!selected && state()?.currentTool === "select" && !state()?.clearAnimation;
    inspector.hidden = !visible;
    inspector.setAttribute("aria-hidden", visible ? "false" : "true");
    document.body.classList.toggle("geometry-sheet-open", visible);
    if (!visible) {
      inspectorSignature = "";
      constructionListSignature = "";
      dimensionFieldsSignature = "";
      return;
    }

    const { path, index } = selected;
    const data = inspectorMeasurementData(path);
    const signature = [
      index,
      path.geometryKind,
      JSON.stringify(path.points),
      path.radius,
      path.radiusLocked,
      path.variableLabel,
      JSON.stringify(path.angleMarks),
      JSON.stringify(path.lockedAngles),
      activeTriangleAngle,
      path.showMeasurements,
      path.showAxes,
      path.snapToGrid,
      path.snapToObjects,
      path.color,
      path.size,
      path.fill,
      path.dash,
      path.rotation,
      (path.constructions || []).length
    ].join(":");
    if (!force && signature === inspectorSignature) return;
    inspectorSignature = signature;

    inspector.querySelector("#geometryInspectorTitle").textContent = data.title;
    ["#geometryMeasureLabel1", "#geometryMeasureLabel2", "#geometryMeasureLabel3", "#geometryMeasureLabel4"]
      .forEach((selector, cardIndex) => { inspector.querySelector(selector).textContent = data.labels[cardIndex]; });
    ["#geometryMeasureRadius", "#geometryMeasureDiameter", "#geometryMeasureCircumference", "#geometryMeasureArea"]
      .forEach((selector, cardIndex) => { inspector.querySelector(selector).textContent = data.values[cardIndex]; });
    inspector.querySelector("#geometryShapeSummary").textContent = data.summary;

    const circleControls = isSmartCircle(path);
    const triangleControls = isSmartTriangle(path);
    inspector.querySelector("#geometryCircleDimensionRow").hidden = !circleControls;
    inspector.querySelector("#geometryVariableField").hidden = !circleControls;
    inspector.querySelector("#geometryTriangleControls").hidden = !triangleControls;
    inspector.querySelector("#geometryConstructWrap").hidden = !circleControls;
    inspector.querySelector("#geometryConstructionList").hidden = !circleControls;
    inspector.querySelector("#geometryRotationRow").hidden = false;
    renderDimensionFields(path);

    const radiusInput = inspector.querySelector("#geometryRadiusInput");
    const variableInput = inspector.querySelector("#geometryVariableInput");
    const angleInput = inspector.querySelector("#geometryAngleInput");
    const rotationInput = inspector.querySelector("#geometryRotationInput");
    const widthInput = inspector.querySelector("#geometryWidthInput");
    const colorInput = inspector.querySelector("#geometryColorInput");
    if (circleControls && !inputIsFocused(radiusInput)) radiusInput.value = formatEditableNumber(measureCircle(path).radius);
    if (circleControls && !inputIsFocused(variableInput)) variableInput.value = normalizedVariable(path);
    if (!inputIsFocused(rotationInput)) {
      rotationInput.value = formatEditableNumber(geometryRotationDegrees(path));
      rotationInput.setAttribute("aria-invalid", "false");
    }
    if (!inputIsFocused(widthInput)) widthInput.value = path.size || 2;
    if (!inputIsFocused(colorInput)) colorInput.value = colorToHex(path.color);
    const fillInput = inspector.querySelector("#geometryFillInput");
    const dashInput = inspector.querySelector("#geometryDashInput");
    if (fillInput && !inputIsFocused(fillInput)) fillInput.value = shapeFill(path.fill);
    if (dashInput && !inputIsFocused(dashInput)) dashInput.value = shapeDash(path.dash);

    const lockButton = inspector.querySelector("#geometryRadiusLock");
    lockButton.classList.toggle("active", circleControls && !!path.radiusLocked);
    lockButton.setAttribute("aria-pressed", circleControls && path.radiusLocked ? "true" : "false");
    lockButton.title = path.radiusLocked ? "Unlock radius" : "Lock radius";
    lockButton.querySelector(".geometry-lock-copy").textContent = path.radiusLocked ? "Locked" : "Lock";

    if (triangleControls) {
      const metrics = triangleMetrics(path);
      const equilateral = path.triangleType === "equilateral";
      activeTriangleAngle = clamp(activeTriangleAngle, 0, 2);
      inspector.querySelectorAll("[data-geometry-angle]").forEach((button) => {
        const angleIndex = Number(button.dataset.geometryAngle);
        const marked = !!path.angleMarks?.[angleIndex];
        const locked = equilateral || Number.isFinite(path.lockedAngles?.[angleIndex]);
        button.classList.toggle("active", angleIndex === activeTriangleAngle);
        button.classList.toggle("marked", marked);
        button.classList.toggle("locked", locked);
        button.setAttribute("aria-pressed", angleIndex === activeTriangleAngle ? "true" : "false");
        button.querySelector("strong").textContent = `${formatNumber(metrics.angleDegrees[angleIndex])}\u00b0`;
      });
      if (!inputIsFocused(angleInput)) angleInput.value = formatEditableNumber(metrics.angleDegrees[activeTriangleAngle]);
      angleInput.readOnly = equilateral;
      angleInput.title = equilateral ? "An equilateral triangle always has three 60\u00b0 angles" : "Type an exact angle";
      inspector.querySelector("#geometryAngleInputLabel").textContent = `Angle ${String.fromCharCode(65 + activeTriangleAngle)}${equilateral ? " (fixed)" : ""}`;
      const markButton = inspector.querySelector("#geometryAngleMark");
      const marked = !!path.angleMarks?.[activeTriangleAngle];
      markButton.disabled = equilateral;
      markButton.title = equilateral ? "All three angles are always marked" : "Show or hide this angle mark";
      markButton.classList.toggle("active", marked);
      markButton.setAttribute("aria-pressed", marked ? "true" : "false");
      markButton.textContent = marked ? "Marked" : "Mark";
      const angleLock = inspector.querySelector("#geometryAngleLock");
      const locked = equilateral || Number.isFinite(path.lockedAngles?.[activeTriangleAngle]);
      angleLock.disabled = equilateral;
      angleLock.classList.toggle("active", locked);
      angleLock.setAttribute("aria-pressed", locked ? "true" : "false");
      angleLock.title = equilateral ? "Equilateral angles are fixed at 60\u00b0" : locked ? "Unlock angle" : "Lock angle";
      angleLock.querySelector(".geometry-lock-copy").textContent = equilateral ? "Fixed" : locked ? "Locked" : "Lock";
    }
    inspector.querySelector("#geometryShowMeasurements").checked = path.showMeasurements !== false;
    inspector.querySelector("#geometryAxesToggle").hidden = !circleControls;
    inspector.querySelector("#geometryShowAxes").checked = path.showAxes !== false;
    inspector.querySelector("#geometrySnapGrid").checked = path.snapToGrid !== false;
    inspector.querySelector("#geometrySnapObjects").checked = path.snapToObjects !== false;
    inspector.querySelector("#geometryGridSnapLabel").textContent = path.snapToGrid !== false ? "0.5 u grid" : "Grid off";
    inspector.querySelector("#geometryObjectSnapLabel").textContent = path.snapToObjects !== false ? "Objects" : "Objects off";
    const snapParts = [];
    if (path.snapToGrid !== false) snapParts.push("0.5 u steps");
    if (path.snapToObjects !== false) snapParts.push("nearby centers and corners");
    inspector.querySelector("#geometrySnapHint").textContent = snapParts.length
      ? `Dragging snaps to ${snapParts.join("; ")}. Object points take priority.`
      : "Free dragging is on. Turn on a snap option for precise placement.";
    if (circleControls) updateConstructionList(path);
  }

  function bindInspector() {
    inspector = document.getElementById("geometryInspector");
    if (!inspector) return;

    const radiusInput = inspector.querySelector("#geometryRadiusInput");
    const variableInput = inspector.querySelector("#geometryVariableInput");
    const angleInput = inspector.querySelector("#geometryAngleInput");
    const dimensionFields = inspector.querySelector("#geometryDimensionFields");
    const rotationInput = inspector.querySelector("#geometryRotationInput");
    const rotationReset = inspector.querySelector("#geometryRotationReset");
    const widthInput = inspector.querySelector("#geometryWidthInput");
    const colorInput = inspector.querySelector("#geometryColorInput");
    const constructToggle = inspector.querySelector("#geometryConstructToggle");
    const constructMenu = inspector.querySelector("#geometryConstructMenu");

    inspector.querySelector("#geometryInspectorClose").addEventListener("click", () => {
      window.Inkyscib?.Selection?.clear?.();
    });

    const collapseButton = inspector.querySelector("#geometryInspectorCollapse");
    if (collapseButton) {
      collapseButton.addEventListener("click", () => {
        const collapsed = inspector.classList.toggle("is-collapsed");
        collapseButton.setAttribute("aria-expanded", collapsed ? "false" : "true");
        collapseButton.setAttribute("aria-label", collapsed ? "Expand geometry controls" : "Collapse geometry controls");
        collapseButton.title = collapsed ? "Expand" : "Collapse";
      });
    }

    radiusInput.addEventListener("focus", () => beginFieldEdit("radius"));
    radiusInput.addEventListener("input", () => {
      const value = Number(radiusInput.value);
      if (!Number.isFinite(value) || value <= 0) return;
      liveFieldEdit("radius", (path) => {
        if (!isSmartCircle(path)) return;
        setCircleGeometry(path, circleCenter(path), value * circleUnitScale(path), path.radiusAngle || 0);
      });
    });
    radiusInput.addEventListener("change", () => finishFieldEdit("radius"));
    radiusInput.addEventListener("blur", () => finishFieldEdit("radius"));

    variableInput.addEventListener("focus", () => beginFieldEdit("variable"));
    variableInput.addEventListener("input", () => {
      const cleaned = variableInput.value.replace(/[^A-Za-z0-9_]/g, "").slice(0, 8);
      if (cleaned !== variableInput.value) variableInput.value = cleaned;
      liveFieldEdit("variable", (path) => {
        if (!isSmartCircle(path)) return;
        path.variableLabel = /^[A-Za-z]/.test(cleaned) ? cleaned : "";
      });
    });
    variableInput.addEventListener("change", () => finishFieldEdit("variable"));
    variableInput.addEventListener("blur", () => finishFieldEdit("variable"));

    widthInput.addEventListener("focus", () => beginFieldEdit("width"));
    widthInput.addEventListener("input", () => {
      const value = Number(widthInput.value);
      if (!Number.isFinite(value)) return;
      liveFieldEdit("width", (path) => { path.size = clamp(value, 0.5, 50); });
    });
    widthInput.addEventListener("change", () => finishFieldEdit("width"));
    widthInput.addEventListener("blur", () => finishFieldEdit("width"));

    colorInput.addEventListener("focus", () => beginFieldEdit("color"));
    colorInput.addEventListener("input", () => {
      liveFieldEdit("color", (path) => { path.color = colorInput.value; });
    });
    colorInput.addEventListener("change", () => finishFieldEdit("color"));
    colorInput.addEventListener("blur", () => finishFieldEdit("color"));

    // Picking from a list is one decision, not a drag, so each change is its
    // own undo step.
    [["#geometryFillInput", "fill", shapeFill], ["#geometryDashInput", "dash", shapeDash]].forEach(([selector, key, normalize]) => {
      const input = inspector.querySelector(selector);
      if (!input) return;
      input.addEventListener("change", () => {
        beginFieldEdit(key);
        liveFieldEdit(key, (path) => { path[key] = normalize(input.value); });
        finishFieldEdit(key);
      });
    });

    inspector.querySelectorAll("[data-geometry-angle]").forEach((button) => {
      button.addEventListener("click", () => {
        activeTriangleAngle = clamp(Number(button.dataset.geometryAngle), 0, 2);
        syncInspector(true);
        angleInput.focus();
        angleInput.select();
      });
    });
    angleInput.addEventListener("focus", () => beginFieldEdit("angle"));
    angleInput.addEventListener("input", () => {
      const value = Number(angleInput.value);
      if (!Number.isFinite(value) || value < 1 || value > 178) return;
      liveFieldEdit("angle", (path) => {
        if (isSmartTriangle(path)) setTriangleAngle(path, activeTriangleAngle, value);
      });
    });
    angleInput.addEventListener("change", () => finishFieldEdit("angle"));
    angleInput.addEventListener("blur", () => finishFieldEdit("angle"));

    dimensionFields.addEventListener("focusin", (event) => {
      const input = event.target.closest("[data-geometry-dimension]");
      if (input) beginFieldEdit(`dimension:${input.dataset.geometryDimension}`);
    });
    dimensionFields.addEventListener("input", (event) => {
      const input = event.target.closest("[data-geometry-dimension]");
      if (!input) return;
      const value = Number(input.value);
      const minimum = Number(input.min);
      const maximum = input.max === "" ? Infinity : Number(input.max);
      const valid = Number.isFinite(value) && value >= minimum && value <= maximum;
      input.setAttribute("aria-invalid", valid ? "false" : "true");
      if (!valid) return;
      const key = input.dataset.geometryDimension;
      liveFieldEdit(`dimension:${key}`, (path) => { setGeometryDimension(path, key, value); });
    });
    dimensionFields.addEventListener("change", (event) => {
      const input = event.target.closest("[data-geometry-dimension]");
      if (input) finishFieldEdit(`dimension:${input.dataset.geometryDimension}`);
    });
    dimensionFields.addEventListener("focusout", (event) => {
      const input = event.target.closest("[data-geometry-dimension]");
      if (input) finishFieldEdit(`dimension:${input.dataset.geometryDimension}`);
    });

    rotationInput.addEventListener("focus", () => beginFieldEdit("rotation"));
    rotationInput.addEventListener("input", () => {
      const value = Number(rotationInput.value);
      const valid = Number.isFinite(value);
      rotationInput.setAttribute("aria-invalid", valid ? "false" : "true");
      if (!valid) return;
      liveFieldEdit("rotation", (path) => { setGeometryRotation(path, value); });
    });
    rotationInput.addEventListener("change", () => finishFieldEdit("rotation"));
    rotationInput.addEventListener("blur", () => finishFieldEdit("rotation"));
    rotationReset.addEventListener("click", () => {
      mutateSelected((path) => { setGeometryRotation(path, 0); });
    });

    inspector.querySelector("#geometryAngleMark").addEventListener("click", () => {
      mutateSelected((path) => {
        if (!isSmartTriangle(path)) return;
        path.angleMarks[activeTriangleAngle] = !path.angleMarks[activeTriangleAngle];
      });
    });
    inspector.querySelector("#geometryAngleLock").addEventListener("click", () => {
      mutateSelected((path) => {
        if (!isSmartTriangle(path)) return;
        const alreadyLocked = Number.isFinite(path.lockedAngles?.[activeTriangleAngle]);
        path.lockedAngles = [null, null, null];
        if (!alreadyLocked) {
          path.lockedAngles[activeTriangleAngle] = triangleMetrics(path).angles[activeTriangleAngle];
          path.angleMarks[activeTriangleAngle] = true;
        }
      });
    });

    inspector.querySelector("#geometryRadiusLock").addEventListener("click", () => {
      mutateSelected((path) => {
        if (isSmartCircle(path)) path.radiusLocked = !path.radiusLocked;
      });
    });
    inspector.querySelector("#geometryShowMeasurements").addEventListener("change", (event) => {
      mutateSelected((path) => { path.showMeasurements = event.target.checked; });
    });
    inspector.querySelector("#geometryShowAxes").addEventListener("change", (event) => {
      mutateSelected((path) => {
        if (isSmartCircle(path)) path.showAxes = event.target.checked;
      });
    });
    inspector.querySelector("#geometrySnapGrid").addEventListener("change", (event) => {
      mutateSelected((path) => { path.snapToGrid = event.target.checked; });
    });
    inspector.querySelector("#geometrySnapObjects").addEventListener("change", (event) => {
      mutateSelected((path) => { path.snapToObjects = event.target.checked; });
    });

    constructToggle.addEventListener("click", () => {
      const open = constructMenu.hidden;
      constructMenu.hidden = !open;
      constructToggle.setAttribute("aria-expanded", open ? "true" : "false");
    });
    constructMenu.addEventListener("click", (event) => {
      const button = event.target.closest("[data-geometry-construct]");
      if (!button) return;
      const construction = newConstruction(button.dataset.geometryConstruct);
      if (!construction) return;
      mutateSelected((path) => {
        if (!isSmartCircle(path)) return;
        if (!Array.isArray(path.constructions)) path.constructions = [];
        path.constructions.push(construction);
      });
      constructMenu.hidden = true;
      constructToggle.setAttribute("aria-expanded", "false");
    });

    inspector.querySelector("#geometryConstructionList").addEventListener("click", (event) => {
      const button = event.target.closest("[data-remove-construction]");
      if (!button) return;
      mutateSelected((path) => {
        if (!isSmartCircle(path)) return;
        path.constructions = (path.constructions || []).filter((item) => item.id !== button.dataset.removeConstruction);
      });
    });

    inspector.querySelector("#geometryDuplicate").addEventListener("click", () => {
      const selected = selectedGeometry();
      if (!selected) return;
      if (typeof window.commitHistory === "function") window.commitHistory();
      const copy = deepClone(selected.path);
      copy.timestamp = Date.now();
      const center = geometryCenter(copy);
      translateGeometry(copy, { x: center.x + geometryUnitScale(copy), y: center.y + geometryUnitScale(copy) });
      if (isSmartCircle(copy)) {
        copy.constructions = (copy.constructions || []).map((construction) => ({
          ...construction,
          id: `geometry-${Date.now().toString(36)}-${(++constructionCounter).toString(36)}`
        }));
      }
      normalizeSmartGeometry(copy);
      state().paths.push(copy);
      window.Inkyscib?.Selection?.selectIndex?.(state().paths.length - 1);
      requestRedraw();
      safeSave();
      syncInspector(true);
    });

    inspector.querySelector("#geometryDelete").addEventListener("click", () => {
      window.Inkyscib?.Selection?.deleteSelected?.();
      syncInspector(true);
    });

    document.addEventListener("toolChanged", () => syncInspector(true));
    // The selection cannot change between two samples of one stroke, and
    // syncInspector writes hidden/aria-hidden/class before its signature
    // check short-circuits.
    document.addEventListener("canvasRendered", (event) => {
      if (event?.detail?.liveInk) return;
      syncInspector();
    });
    document.addEventListener("click", (event) => {
      if (constructMenu.hidden || inspector.contains(event.target)) return;
      constructMenu.hidden = true;
      constructToggle.setAttribute("aria-expanded", "false");
    });
    syncInspector(true);
  }

  function normalizeCircle(path) {
    if (!isSmartCircle(path)) return path;
    path.unitScale = circleUnitScale(path);
    path.rotation = numberOr(path.rotation);
    path.radiusAngle = normalizeAngle(path.radiusAngle || 0);
    path.radiusLocked = !!path.radiusLocked;
    path.showMeasurements = path.showMeasurements !== false;
    path.showAxes = path.showAxes !== false;
    path.snapToGrid = path.snapToGrid !== false;
    path.snapToObjects = path.snapToObjects !== false;
    path.variableLabel = normalizedVariable(path) || "";
    path.constructions = Array.isArray(path.constructions)
      ? path.constructions.filter((construction) => construction && CONSTRUCTION_NAMES[construction.type])
      : [];
    return syncCirclePoints(path);
  }

  function defaultPolygonPoints(kind, center) {
    if (kind === "square") return regularPolygonPoints(center, 62, 4, -Math.PI * 3 / 4);
    if (REGULAR_POLYGON_KINDS.has(kind)) {
      const sides = POLYGON_VERTEX_COUNT[kind];
      return regularPolygonPoints(center, 62, sides, flatBottomStart(sides));
    }
    if (kind === "trapezium") {
      return [
        { x: center.x - 38, y: center.y - 42 },
        { x: center.x + 38, y: center.y - 42 },
        { x: center.x + 62, y: center.y + 42 },
        { x: center.x - 62, y: center.y + 42 }
      ];
    }
    if (kind === "triangle") {
      return [
        { x: center.x, y: center.y - 64 },
        { x: center.x - 56, y: center.y + 40 },
        { x: center.x + 56, y: center.y + 40 }
      ];
    }
    if (kind === "rectangle") {
      return [
        { x: center.x - 62, y: center.y - 42 },
        { x: center.x + 62, y: center.y - 42 },
        { x: center.x + 62, y: center.y + 42 },
        { x: center.x - 62, y: center.y + 42 }
      ];
    }
    if (kind === "parallelogram") {
      return [
        { x: center.x - 40, y: center.y - 42 },
        { x: center.x + 56, y: center.y - 42 },
        { x: center.x + 40, y: center.y + 42 },
        { x: center.x - 56, y: center.y + 42 }
      ];
    }
    if (kind === "rhombus") {
      return [
        { x: center.x, y: center.y - 58 },
        { x: center.x + 62, y: center.y },
        { x: center.x, y: center.y + 58 },
        { x: center.x - 62, y: center.y }
      ];
    }
    return [
      { x: center.x, y: center.y - 64 },
      { x: center.x + 58, y: center.y - 8 },
      { x: center.x, y: center.y + 70 },
      { x: center.x - 58, y: center.y - 8 }
    ];
  }

  function normalizeParallelogramPoints(path) {
    const points = path.points.map((point) => ({ ...point }));
    points[3] = {
      x: points[0].x + points[2].x - points[1].x,
      y: points[0].y + points[2].y - points[1].y
    };
    path.points = points;
  }

  function normalizeRectanglePoints(path) {
    const points = path.points.map((point) => ({ ...point }));
    const a = points[0];
    const diagonal = { x: points[2].x - a.x, y: points[2].y - a.y };
    const edge = { x: points[1].x - a.x, y: points[1].y - a.y };
    const edgeLength = Math.hypot(edge.x, edge.y);
    if (edgeLength < 4 || Math.hypot(diagonal.x, diagonal.y) < 8) {
      path.points = defaultPolygonPoints("rectangle", polygonCenter(path));
      return;
    }
    const firstAxis = { x: edge.x / edgeLength, y: edge.y / edgeLength };
    const secondAxis = closestPerpendicular(firstAxis, { x: points[3].x - a.x, y: points[3].y - a.y });
    const width = diagonal.x * firstAxis.x + diagonal.y * firstAxis.y;
    const height = diagonal.x * secondAxis.x + diagonal.y * secondAxis.y;
    if (Math.abs(width) < 4 || Math.abs(height) < 4) {
      path.points = defaultPolygonPoints("rectangle", polygonCenter(path));
      return;
    }
    points[1] = { x: a.x + firstAxis.x * width, y: a.y + firstAxis.y * width };
    points[3] = { x: a.x + secondAxis.x * height, y: a.y + secondAxis.y * height };
    points[2] = {
      x: a.x + firstAxis.x * width + secondAxis.x * height,
      y: a.y + firstAxis.y * width + secondAxis.y * height
    };
    path.points = points;
  }

  function normalizeRhombusPoints(path) {
    const points = path.points.map((point) => ({ ...point }));
    const center = { x: (points[0].x + points[2].x) / 2, y: (points[0].y + points[2].y) / 2 };
    let axis = { x: points[0].x - center.x, y: points[0].y - center.y };
    let axisLength = Math.hypot(axis.x, axis.y);
    if (axisLength < 4) {
      path.points = defaultPolygonPoints("rhombus", center);
      return;
    }
    axis = { x: axis.x / axisLength, y: axis.y / axisLength };
    const perpendicular = closestPerpendicular(axis, { x: points[1].x - center.x, y: points[1].y - center.y });
    const halfDiagonal = Math.max(4, (pointDistance(center, points[1]) + pointDistance(center, points[3])) / 2);
    points[1] = { x: center.x + perpendicular.x * halfDiagonal, y: center.y + perpendicular.y * halfDiagonal };
    points[3] = { x: center.x - perpendicular.x * halfDiagonal, y: center.y - perpendicular.y * halfDiagonal };
    path.points = points;
  }

  function normalizeKitePoints(path) {
    const points = path.points.map((point) => ({ ...point }));
    const a = points[0];
    const c = points[2];
    const axisVector = { x: c.x - a.x, y: c.y - a.y };
    const axisLength = Math.hypot(axisVector.x, axisVector.y);
    if (axisLength < 8) {
      path.points = defaultPolygonPoints("kite", polygonCenter(path));
      return;
    }
    const axis = { x: axisVector.x / axisLength, y: axisVector.y / axisLength };
    let perpendicular = { x: -axis.y, y: axis.x };
    const project = (point) => (point.x - a.x) * axis.x + (point.y - a.y) * axis.y;
    const along = clamp((project(points[1]) + project(points[3])) / 2, 4, axisLength - 4);
    const foot = { x: a.x + axis.x * along, y: a.y + axis.y * along };
    if ((points[1].x - foot.x) * perpendicular.x + (points[1].y - foot.y) * perpendicular.y < 0) {
      perpendicular = { x: -perpendicular.x, y: -perpendicular.y };
    }
    const halfWidth = Math.max(4, (pointDistance(foot, points[1]) + pointDistance(foot, points[3])) / 2);
    points[1] = { x: foot.x + perpendicular.x * halfWidth, y: foot.y + perpendicular.y * halfWidth };
    points[3] = { x: foot.x - perpendicular.x * halfWidth, y: foot.y - perpendicular.y * halfWidth };
    path.points = points;
  }

  // Loaded or transformed: rebuild from the centre, the mean corner distance
  // and the first corner's angle, so a regular polygon stays exactly regular.
  function normalizeRegularPolygonPoints(path) {
    const count = POLYGON_VERTEX_COUNT[path.geometryKind];
    const points = path.points.slice(0, count);
    const center = polygonCenter({ points });
    const radius = points.reduce((sum, point) => sum + pointDistance(center, point), 0) / count;
    if (radius < 4) return;
    const start = Math.atan2(points[0].y - center.y, points[0].x - center.x);
    path.points = regularPolygonPoints(center, radius, count, start);
  }

  function normalizeEllipse(path) {
    path.geometryVersion = GEOMETRY_VERSION;
    path.unitScale = geometryUnitScale(path);
    path.showMeasurements = path.showMeasurements !== false;
    path.snapToGrid = path.snapToGrid !== false;
    path.snapToObjects = path.snapToObjects !== false;
    delete path.draftStart;
    delete path.previewPoint;
    delete path.vertexLabels;
    const finite = Array.isArray(path.points) ? path.points.filter(finitePoint) : [];
    if (finite.length >= 4) {
      const frame = ellipseFrame({ points: finite });
      if (frame.radiusX >= MIN_RADIUS / 2 && frame.radiusY >= MIN_RADIUS / 2) {
        return setEllipseGeometry(path, frame.center, frame.radiusX, frame.radiusY, frame.rotation);
      }
    }
    const center = finite.length
      ? polygonCenter({ points: finite })
      : { x: numberOr(path.centerX), y: numberOr(path.centerY) };
    return setEllipseGeometry(path, center, 72, 48, 0);
  }

  function normalizeSmartGeometry(path) {
    if (!path || path.tool !== "shape") return path;
    path.fill = shapeFill(path.fill);
    path.dash = shapeDash(path.dash);
    if (path.geometryKind === "ellipse" && path.shapeType === "ellipse") return normalizeEllipse(path);
    if (path.geometryKind === "circle" && path.shapeType === "circle") {
      path.geometryVersion = GEOMETRY_VERSION;
      return normalizeCircle(path);
    }

    const kind = path.geometryKind;
    if (path.shapeType !== kind || (kind !== "triangle" && !POLYGON_VERTEX_COUNT[kind])) return path;
    path.geometryVersion = GEOMETRY_VERSION;
    path.unitScale = geometryUnitScale(path);
    path.rotation = numberOr(path.rotation);
    path.showMeasurements = path.showMeasurements !== false;
    path.snapToGrid = path.snapToGrid !== false;
    path.snapToObjects = path.snapToObjects !== false;

    const count = kind === "triangle" ? 3 : POLYGON_VERTEX_COUNT[kind];
    const finite = Array.isArray(path.points) ? path.points.filter(finitePoint).slice(0, count) : [];
    const fallbackCenter = finite.length
      ? { x: finite.reduce((sum, point) => sum + point.x, 0) / finite.length, y: finite.reduce((sum, point) => sum + point.y, 0) / finite.length }
      : { x: numberOr(path.centerX), y: numberOr(path.centerY) };
    path.points = finite.length === count
      ? finite.map((point) => ({ x: point.x, y: point.y }))
      : defaultPolygonPoints(kind, fallbackCenter);
    delete path.draftStart;
    delete path.previewPoint;

    path.vertexLabels = Array.isArray(path.vertexLabels)
      ? path.vertexLabels.slice(0, count).map((label, index) => String(label || String.fromCharCode(65 + index)).slice(0, 8))
      : [];
    while (path.vertexLabels.length < count) path.vertexLabels.push(String.fromCharCode(65 + path.vertexLabels.length));

    if (kind === "triangle") {
      path.triangleType = ["custom", "isosceles", "right", "equilateral"].includes(path.triangleType)
        ? path.triangleType
        : "custom";
      path.angleMarks = Array.isArray(path.angleMarks) ? path.angleMarks.slice(0, 3).map(Boolean) : [];
      while (path.angleMarks.length < 3) path.angleMarks.push(false);
      if (path.triangleType === "equilateral") {
        const center = polygonCenter(path);
        const lengths = [
          pointDistance(path.points[0], path.points[1]),
          pointDistance(path.points[1], path.points[2]),
          pointDistance(path.points[2], path.points[0])
        ];
        const averageSide = lengths.reduce((sum, length) => sum + length, 0) / 3;
        const side = averageSide >= 4 ? averageSide : geometryGridStep(path.unitScale) * 8;
        const first = path.points[0];
        const rotation = Math.atan2(first.y - center.y, first.x - center.x) + Math.PI / 2;
        path.points = equilateralPoints(center, side, rotation);
        path.angleMarks = [true, true, true];
        path.lockedAngles = [null, null, null];
        return path;
      }
      const storedLocks = Array.isArray(path.lockedAngles) ? path.lockedAngles.slice(0, 3) : [];
      path.lockedAngles = [null, null, null];
      const lockedIndex = storedLocks.findIndex((value) => Number.isFinite(value) && value > 0 && value < Math.PI);
      if (lockedIndex >= 0) {
        const lockedAngle = clamp(storedLocks[lockedIndex], Math.PI / 180, Math.PI * 178 / 180);
        setTriangleAngle(path, lockedIndex, lockedAngle * 180 / Math.PI);
        path.lockedAngles[lockedIndex] = lockedAngle;
        path.angleMarks[lockedIndex] = true;
      }
      if (polygonAreaWorld(path.points) < 8) path.points = defaultPolygonPoints(kind, fallbackCenter);
      return path;
    }

    if (kind === "rectangle") normalizeRectanglePoints(path);
    if (kind === "parallelogram") normalizeParallelogramPoints(path);
    if (kind === "rhombus") normalizeRhombusPoints(path);
    if (kind === "kite") normalizeKitePoints(path);
    if (REGULAR_POLYGON_KINDS.has(kind)) normalizeRegularPolygonPoints(path);
    if (polygonAreaWorld(path.points) < 12) path.points = defaultPolygonPoints(kind, fallbackCenter);
    return path;
  }


  // Renaming the unit changes every label this panel prints, so rebuild it.
  document.addEventListener("inkyscibUnitNameChanged", () => syncInspector(true));
  window.Inkyscib = window.Inkyscib || {};
  window.Inkyscib.SmartGeometry = {
    version: GEOMETRY_VERSION,
    isSmartCircle,
    isSmartTriangle,
    isSmartQuadrilateral,
    isSmartEllipse,
    isSmartGeometry,
    createCirclePath,
    createShapePath,
    createCustomTrianglePath,
    updateCircleDraft,
    updateShapeDraft,
    setDefaultCircleSize,
    finalizeCircle,
    finalizeSmartShape,
    isMeaningfulShape,
    promoteTriangle,
    afterPathCreated,
    normalizeCircle,
    normalizeSmartGeometry,
    normalizeGeometryAfterTransform: normalizeSmartGeometry,
    circleCenter,
    circleRadius,
    setCircleGeometry,
    syncCirclePoints,
    pointOnCircle,
    circleDisplayPoints,
    geometryDisplayPoints,
    constructionPoints,
    measureCircle,
    measureEllipse,
    measureGeometry,
    ellipseFrame,
    setEllipseGeometry,
    shapeFill,
    shapeDash,
    triangleMetrics,
    quadrilateralMetrics,
    geometryDimensionDescriptors,
    setGeometryDimension,
    setGeometryRotation,
    geometryGridStep,
    setTriangleAngle,
    updateGeometryVertex,
    translateGeometry,
    measurementStrings,
    snapPoint,
    newConstruction,
    syncInspector
  };

  installGeometryRenderer();
  installSelectionHooks();
  document.addEventListener("DOMContentLoaded", bindInspector);
})();
