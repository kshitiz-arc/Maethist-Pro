// Construction geometry model + store.
//
// Geometry objects are stored as entries in appState.paths with
// tool === 'construction'. That is deliberate: history in this app is a
// whole-paths-array snapshot (core.js captureHistory/__restorePaths), so
// anything living outside that array would not participate in undo/redo.
// Because the array can be replaced wholesale by an undo, the id index is
// rebuilt from the paths rather than held as the source of truth — the same
// approach Manipulatives uses.
//
// Path shapes (points[] is required by the serializer, so every object keeps
// its defining coordinates there):
//   point   { geomType:'point',   points:[p] }
//   segment { geomType:'segment', points:[a, b] }
//   arc     { geomType:'arc',     points:[center], radius, startAngle, endAngle }
//   circle  { geomType:'circle',  points:[center], radius, full:true }
(function () {
  "use strict";

  const G = () => window.Inkyscib?.GeometryEngine;

  const POINT_LABELS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  // World-space budget for "this is the same point the user already made".
  const MERGE_TOLERANCE = 0.5;

  let idCounter = 0;
  let index = null;
  let indexSignature = "";

  function state() {
    return window.appState;
  }

  function paths() {
    const s = state();
    return Array.isArray(s?.paths) ? s.paths : [];
  }

  function isConstructionPath(path) {
    return !!path && path.tool === "construction" && typeof path.geomType === "string";
  }

  // ---------- geometry drawn with the ordinary tools ----------
  //
  // A line from the Line tool and a shape from the Shape tool are ink paths,
  // not construction objects, but geometrically they are segments, polygons
  // and circles like any other. Their ends, corners, middles and crossings
  // have to stay live, or a construction could only ever be continued from
  // compass work. Nothing is copied: the descriptors below hold references to
  // the path's own coordinates, so moving a line moves its snap points too.

  function isDrawnLine(path) {
    return !!path &&
      path.tool === "line" &&
      Array.isArray(path.points) &&
      path.points.length >= 2 &&
      !!path.points[0] &&
      !!path.points[1];
  }

  // The editor works on a finite page: legacy ray/line values are treated as
  // ordinary segments when rebuilding the construction index.
  function drawnLineMode(path) {
    return "segment";
  }

  function withinDrawnBounds(t, mode) {
    if (mode === "line") return true;
    if (mode === "ray") return t >= 0;
    return t >= 0 && t <= 1;
  }

  function edgesOf(vertices) {
    return vertices.map((a, i) => ({
      a,
      b: vertices[(i + 1) % vertices.length],
      mode: "segment"
    }));
  }

  // null for anything with no usable geometry (freehand ink, text, tiles).
  function drawnGeometry(path, id) {
    const engine = G();
    const smart = window.Inkyscib?.SmartGeometry;
    if (!engine || !path) return null;

    if (isDrawnLine(path)) {
      const [a, b] = path.points;
      if (!engine.isValidPoint(a) || !engine.isValidPoint(b)) return null;
      return { id, path, edges: [{ a, b, mode: drawnLineMode(path) }], circles: [] };
    }

    if (smart?.isSmartCircle?.(path)) {
      const centre = smart.circleCenter?.(path);
      const radius = smart.circleRadius?.(path);
      if (!engine.isValidPoint(centre) || !engine.isFiniteNumber(radius) || radius <= 0) return null;
      return { id, path, edges: [], circles: [{ center: centre, radius }] };
    }

    if (smart?.isSmartTriangle?.(path) || smart?.isSmartQuadrilateral?.(path)) {
      const vertices = (smart.geometryDisplayPoints?.(path) || []).filter((point) =>
        engine.isValidPoint(point)
      );
      if (vertices.length < 3) return null;
      return { id, path, edges: edgesOf(vertices), circles: [] };
    }

    return null;
  }

  // ---------- ids ----------

  function nextId(prefix) {
    idCounter += 1;
    return `${prefix}${idCounter}`;
  }

  // Undo can restore paths carrying ids beyond our counter; keep the counter
  // ahead of anything already present so new ids never collide.
  function reserveIdsFrom(list) {
    list.forEach((path) => {
      if (!isConstructionPath(path) || typeof path.gid !== "string") return;
      const numeric = Number.parseInt(path.gid.replace(/^[a-z]+/i, ""), 10);
      if (Number.isFinite(numeric) && numeric > idCounter) idCounter = numeric;
    });
  }

  // ---------- index ----------

  function signature(list) {
    // cheap change detector: count + ids, so the index only rebuilds when the
    // construction set actually changed
    let parts = "";
    for (let i = 0; i < list.length; i += 1) {
      const path = list[i];
      if (isConstructionPath(path)) parts += path.gid + ",";
      // Drawn lines and shapes have no id of their own; their position in the
      // array is enough to notice one appearing, going or being reordered.
      else if (path && (path.tool === "line" || path.tool === "shape")) {
        parts += path.tool[0] + i + ",";
      }
    }
    return parts;
  }

  function rebuildIndex(force = false) {
    const list = paths();
    const nextSignature = signature(list);
    if (!force && index && nextSignature === indexSignature) return index;

    reserveIdsFrom(list);

    const built = {
      byId: new Map(),
      points: [],
      segments: [],
      arcs: [],
      circles: [],
      angles: [],
      drawn: [],
      all: []
    };

    list.forEach((path) => {
      if (!isConstructionPath(path)) {
        const drawn = drawnGeometry(path, "d" + built.drawn.length);
        if (drawn) built.drawn.push(drawn);
        return;
      }
      built.byId.set(path.gid, path);
      built.all.push(path);
      if (path.geomType === "point") built.points.push(path);
      else if (path.geomType === "segment") built.segments.push(path);
      else if (path.geomType === "arc") built.arcs.push(path);
      else if (path.geomType === "circle") built.circles.push(path);
      // An angle mark is an annotation, not geometry: it is deliberately kept
      // out of the arc bucket so it never produces a snap target or a crossing
      // with the very lines it is measuring.
      else if (path.geomType === "angle") built.angles.push(path);
    });

    index = built;
    indexSignature = nextSignature;
    return index;
  }

  // Called after an undo/redo replaces the paths array wholesale.
  function rebuildFromPaths() {
    index = null;
    indexSignature = "";
    return rebuildIndex(true);
  }

  function get(id) {
    return rebuildIndex().byId.get(id) || null;
  }

  function allPoints() {
    return rebuildIndex().points;
  }

  // Every arc-like object (arcs + circles) in engine form.
  function arcLikes() {
    const idx = rebuildIndex();
    const out = [];
    idx.arcs.forEach((path) => out.push({ path, shape: toShape(path) }));
    idx.circles.forEach((path) => out.push({ path, shape: toShape(path) }));
    return out;
  }

  // ---------- conversion to engine shapes ----------

  function center(path) {
    return path?.points?.[0] || null;
  }

  function toShape(path) {
    if (!isConstructionPath(path)) return null;
    if (path.geomType === "circle") {
      return { kind: "circle", center: center(path), radius: path.radius };
    }
    if (path.geomType === "arc") {
      return {
        kind: "arc",
        center: center(path),
        radius: path.radius,
        startAngle: path.startAngle,
        endAngle: path.endAngle,
        full: !!path.full
      };
    }
    if (path.geomType === "segment") {
      return { kind: "segment", a: path.points[0], b: path.points[1], mode: path.mode || "segment" };
    }
    return null;
  }

  // ---------- labels ----------

  // Points and line ends draw their names from one alphabet: two things called
  // "A" in the same diagram is worse than either naming scheme on its own.
  function usedLabels() {
    const used = new Set();
    allPoints().forEach((path) => {
      if (path.label) used.add(path.label);
    });
    paths().forEach((path) => {
      if (!isDrawnLine(path)) return;
      if (path.labelStart) used.add(path.labelStart);
      if (path.labelEnd) used.add(path.labelEnd);
    });
    return used;
  }

  // `taken` covers names claimed in this same operation but not stored yet,
  // so naming both ends of one segment cannot hand out "A" twice.
  function nextLabel(taken) {
    const used = usedLabels();
    (taken || []).forEach((label) => {
      if (label) used.add(label);
    });
    for (let i = 0; i < POINT_LABELS.length; i += 1) {
      if (!used.has(POINT_LABELS[i])) return POINT_LABELS[i];
    }
    // A, B ... Z exhausted -> A1, B1, ...
    let suffix = 1;
    for (;;) {
      for (let i = 0; i < POINT_LABELS.length; i += 1) {
        const candidate = POINT_LABELS[i] + suffix;
        if (!used.has(candidate)) return candidate;
      }
      suffix += 1;
    }
  }

  // ---------- creation ----------
  //
  // None of these commit history themselves; the caller decides what counts as
  // one undoable operation (placing an arc and the point it came from may be
  // one user action or two).

  function findPointAt(position, tolerance = MERGE_TOLERANCE) {
    const engine = G();
    if (!engine || !engine.isValidPoint(position)) return null;
    let best = null;
    let bestDistance = tolerance;
    allPoints().forEach((path) => {
      const d = engine.distance(center(path), position);
      if (d <= bestDistance) {
        best = path;
        bestDistance = d;
      }
    });
    return best;
  }

  // Never create a second point on top of an existing one (spec §26).
  function createPoint(position, options = {}) {
    const engine = G();
    if (!engine || !engine.isValidPoint(position)) return null;

    const existing = findPointAt(position, options.tolerance ?? MERGE_TOLERANCE);
    if (existing) return existing;

    const path = {
      tool: "construction",
      geomType: "point",
      gid: nextId("p"),
      points: [{ x: position.x, y: position.y }],
      label: options.label || nextLabel(),
      origin: options.origin || "user",
      isConstruction: options.isConstruction === true,
      size: 2,
      color: options.color || null
    };
    if (Array.isArray(options.sourceIds) && options.sourceIds.length) {
      path.sourceIds = options.sourceIds.slice(0, 4);
    }

    paths().push(path);
    rebuildIndex(true);
    return path;
  }

  function createArc(centerPoint, radius, startAngle, endAngle, options = {}) {
    const engine = G();
    if (!engine || !engine.isValidPoint(centerPoint)) return null;
    if (!engine.isFiniteNumber(radius) || radius <= 0) return null;

    const path = {
      tool: "construction",
      geomType: options.full ? "circle" : "arc",
      gid: nextId(options.full ? "c" : "a"),
      points: [{ x: centerPoint.x, y: centerPoint.y }],
      radius,
      isConstruction: options.isConstruction !== false,
      size: options.size || 2,
      color: options.color || null
    };

    if (options.full) {
      path.full = true;
    } else {
      path.startAngle = engine.normalizeAngle(startAngle);
      path.endAngle = engine.normalizeAngle(endAngle);
    }
    if (options.centerId) path.centerId = options.centerId;
    if (options.radiusSource) path.radiusSource = options.radiusSource;
    // Recorded per arc, so turning the setting off later leaves arcs already
    // drawn exactly as they were.
    if (options.showAngle) path.showAngle = true;

    paths().push(path);
    rebuildIndex(true);
    return path;
  }

  // An angle mark between two directions at a vertex. Same fields an arc uses
  // (centre, radius, start and end angle), so it needs nothing new from the
  // serializer; only the geomType tells the renderer to draw it as a marker.
  //
  // The pair is ordered so the mark spans the SMALLER of the two angles the
  // directions make, which is the one a person means when they point at a
  // corner and ask "what is that angle".
  function createAngle(vertex, fromAngle, toAngle, options = {}) {
    const engine = G();
    if (!engine || !engine.isValidPoint(vertex)) return null;
    if (!engine.isFiniteNumber(fromAngle) || !engine.isFiniteNumber(toAngle)) return null;

    let start = engine.normalizeAngle(fromAngle);
    let end = engine.normalizeAngle(toAngle);
    if (engine.arcSweep(start, end) > Math.PI) {
      const swap = start;
      start = end;
      end = swap;
    }

    const radius = engine.isFiniteNumber(options.radius) && options.radius > 0
      ? options.radius
      : 30;

    const path = {
      tool: "construction",
      geomType: "angle",
      gid: nextId("g"),
      points: [{ x: vertex.x, y: vertex.y }],
      radius,
      startAngle: start,
      endAngle: end,
      isConstruction: true,
      size: engine.isFiniteNumber(options.size) && options.size > 0 ? options.size : 1.7,
      color: options.color || null
    };
    if (options.showAngle === false) path.showAngle = false;
    if (Array.isArray(options.sourceIds) && options.sourceIds.length) {
      path.sourceIds = options.sourceIds.slice(0, 4);
    }

    paths().push(path);
    rebuildIndex(true);
    return path;
  }

  function createSegment(a, b, options = {}) {
    const engine = G();
    if (!engine || !engine.isValidPoint(a) || !engine.isValidPoint(b)) return null;
    if (engine.distance(a, b) <= engine.POINT_TOLERANCE) return null;

    const path = {
      tool: "construction",
      geomType: "segment",
      gid: nextId("s"),
      points: [{ x: a.x, y: a.y }, { x: b.x, y: b.y }],
      isConstruction: options.isConstruction === true,
      mode: options.mode || "segment",
      size: options.size || 2,
      color: options.color || null
    };
    if (options.startPointId) path.startPointId = options.startPointId;
    if (options.endPointId) path.endPointId = options.endPointId;

    paths().push(path);
    rebuildIndex(true);
    return path;
  }

  function remove(id) {
    const list = paths();
    const position = list.findIndex((path) => isConstructionPath(path) && path.gid === id);
    if (position < 0) return false;
    list.splice(position, 1);
    rebuildIndex(true);
    return true;
  }

  // ---------- intersections ----------
  //
  // Recomputed from the stored geometry rather than persisted, so an undo that
  // removes an arc cannot leave orphaned candidates behind (spec §28).
  // Spatial filtering: two arc-likes can only meet if their centres are within
  // r1 + r2, which is a cheap rejection before the full solve (spec §33).

  // How far past an arc's drawn end an intersection may sit and still count.
  const ARC_ENDPOINT_SCREEN_TOLERANCE = 6;

  // O(n^2) over the pairs. A page carrying more crossable objects than this is
  // not a construction any more, and marking every crossing on it would cost
  // more than it tells anyone.
  const MAX_CROSSABLE_OBJECTS = 150;

  let intersectionCache = null;
  let intersectionSignature = "";

  function geometrySignature() {
    const idx = rebuildIndex();
    let parts = "";
    idx.all.forEach((path) => {
      if (path.geomType === "point") return;
      const c = center(path) || { x: 0, y: 0 };
      parts += `${path.gid}:${c.x.toFixed(4)},${c.y.toFixed(4)},${(path.radius || 0).toFixed(4)},${(path.startAngle || 0).toFixed(4)},${(path.endAngle || 0).toFixed(4)};`;
    });
    // Dragging a line with the Select tool moves its crossings, so the drawn
    // geometry has to be part of the cache key as well as the compass's.
    idx.drawn.forEach((entry) => {
      parts += `${entry.id}:`;
      entry.edges.forEach((edge) => {
        parts += `${edge.a.x.toFixed(4)},${edge.a.y.toFixed(4)},${edge.b.x.toFixed(4)},${edge.b.y.toFixed(4)},${edge.mode}|`;
      });
      entry.circles.forEach((circle) => {
        parts += `${circle.center.x.toFixed(4)},${circle.center.y.toFixed(4)},${circle.radius.toFixed(4)}|`;
      });
      parts += ";";
    });
    return parts;
  }

  function computeIntersections(options = {}) {
    const engine = G();
    if (!engine) return [];

    const nextSignature = geometrySignature();
    if (!options.force && intersectionCache && nextSignature === intersectionSignature) {
      return intersectionCache;
    }

    const idx = rebuildIndex();
    const shapes = [];
    idx.arcs.forEach((path) => shapes.push({ id: path.gid, shape: toShape(path) }));
    idx.circles.forEach((path) => shapes.push({ id: path.gid, shape: toShape(path) }));
    idx.segments.forEach((path) => shapes.push({ id: path.gid, shape: toShape(path) }));
    idx.drawn.forEach((entry) => {
      // `owner` keeps a polygon from crossing itself: two edges of one triangle
      // meet at a corner, which is already an endpoint and not a crossing.
      entry.edges.forEach((edge, i) =>
        shapes.push({
          id: entry.id + "e" + i,
          owner: entry.id,
          shape: { kind: "segment", a: edge.a, b: edge.b, mode: edge.mode }
        })
      );
      entry.circles.forEach((circle, i) =>
        shapes.push({
          id: entry.id + "c" + i,
          owner: entry.id,
          shape: { kind: "circle", center: circle.center, radius: circle.radius }
        })
      );
    });

    if (shapes.length > MAX_CROSSABLE_OBJECTS) {
      intersectionCache = [];
      intersectionSignature = nextSignature;
      return intersectionCache;
    }

    const found = [];

    for (let i = 0; i < shapes.length; i += 1) {
      for (let j = i + 1; j < shapes.length; j += 1) {
        const a = shapes[i];
        const b = shapes[j];
        if (a.owner && a.owner === b.owner) continue;

        // cheap spatial rejection for two arc-likes
        if (a.shape.kind !== "segment" && b.shape.kind !== "segment") {
          const gap = engine.distance(a.shape.center, b.shape.center);
          if (!Number.isFinite(gap)) continue;
          if (gap > a.shape.radius + b.shape.radius) continue;
          if (gap < Math.abs(a.shape.radius - b.shape.radius)) continue;
        }

        // Forgive an arc that stops a few pixels short of the crossing: the
        // allowance is specified on screen so it stays constant while zooming.
        const points = engine.intersect(a.shape, b.shape, {
          endpointTolerance: engine.screenDistanceToWorld(
            options.endpointScreenTolerance ?? ARC_ENDPOINT_SCREEN_TOLERANCE,
            state()?.transform
          )
        });
        points.forEach((point) => {
          if (!engine.isValidPoint(point)) return;
          // Collapse duplicates arising from several object pairs meeting at
          // the same place. The budget is MERGE_TOLERANCE rather than machine
          // epsilon because a line joined to a crossing then crosses both of
          // its parents a hair away from it, which is one point to anybody
          // looking at it — and to createPoint, which merges on the same
          // distance.
          const duplicate = found.some((existing) =>
            engine.pointEquals(existing, point, MERGE_TOLERANCE)
          );
          if (duplicate) return;
          found.push({
            x: point.x,
            y: point.y,
            sourceObjectIds: [a.id, b.id]
          });
        });
      }
    }

    intersectionCache = found;
    intersectionSignature = nextSignature;
    return found;
  }

  function invalidateIntersections() {
    intersectionCache = null;
    intersectionSignature = "";
  }

  // Cheap "could anything cross?" test. The overlay asks every frame whether
  // there are crossings to mark, and a page that is only handwriting should
  // not pay for the solve.
  function hasCrossableGeometry() {
    const idx = rebuildIndex();
    let count = idx.arcs.length + idx.circles.length + idx.segments.length;
    for (let i = 0; i < idx.drawn.length && count < 2; i += 1) {
      count += idx.drawn[i].edges.length + idx.drawn[i].circles.length;
    }
    return count >= 2;
  }

  // ---------- snapping ----------
  //
  // Everything is judged in screen space so the threshold stays constant while
  // zooming (spec §17), then converted back to exact world coordinates.

  const SNAP_SCREEN_DISTANCE = 10;

  // Lower number wins (spec §18).
  const SNAP_PRIORITY = {
    point: 1,
    intersection: 2,
    endpoint: 3,
    "arc-endpoint": 4,
    center: 5,
    midpoint: 6,
    "on-geometry": 7
  };

  function findSnapTarget(worldPosition, options = {}) {
    const engine = G();
    if (!engine || !engine.isValidPoint(worldPosition)) return null;

    const transform = options.transform || state()?.transform || { scale: 1, offsetX: 0, offsetY: 0 };
    const threshold = engine.screenDistanceToWorld(
      options.screenDistance ?? SNAP_SCREEN_DISTANCE,
      transform
    );

    const candidates = [];
    const add = (type, position, payload) => {
      if (!engine.isValidPoint(position)) return;
      const d = engine.distance(worldPosition, position);
      if (d > threshold) return;
      candidates.push({
        type,
        priority: SNAP_PRIORITY[type] ?? 9,
        distance: d,
        x: position.x,
        y: position.y,
        ...payload
      });
    };

    const idx = rebuildIndex();

    idx.points.forEach((path) => add("point", center(path), { id: path.gid, label: path.label }));

    if (options.includeIntersections !== false) {
      computeIntersections().forEach((point) =>
        add("intersection", point, { sourceObjectIds: point.sourceObjectIds })
      );
    }

    idx.segments.forEach((path) => {
      add("endpoint", path.points[0], { id: path.gid });
      add("endpoint", path.points[1], { id: path.gid });
      add("midpoint", engine.midpoint(path.points[0], path.points[1]), { id: path.gid });
      const projected = engine.projectPointOnLine(worldPosition, path.points[0], path.points[1]);
      if (projected.t >= 0 && projected.t <= 1) {
        add("on-geometry", projected.point, { id: path.gid });
      }
    });

    idx.arcs.forEach((path) => {
      const c = center(path);
      add("center", c, { id: path.gid });
      add("arc-endpoint", engine.pointOnCircleAt(c, path.radius, path.startAngle), { id: path.gid });
      add("arc-endpoint", engine.pointOnCircleAt(c, path.radius, path.endAngle), { id: path.gid });
      const angle = engine.angleOf(c, worldPosition);
      if (engine.angleInArc(angle, path.startAngle, path.endAngle)) {
        add("on-geometry", engine.pointOnCircleAt(c, path.radius, angle), { id: path.gid });
      }
    });

    idx.circles.forEach((path) => {
      const c = center(path);
      add("center", c, { id: path.gid });
      const angle = engine.angleOf(c, worldPosition);
      add("on-geometry", engine.pointOnCircleAt(c, path.radius, angle), { id: path.gid });
    });

    // The ends, corners and middles of ordinary lines and shapes rank exactly
    // like their construction equivalents: where a point came from should not
    // change how it behaves once it is on the page.
    idx.drawn.forEach((entry) => {
      entry.edges.forEach((edge) => {
        add("endpoint", edge.a, { id: entry.id });
        add("endpoint", edge.b, { id: entry.id });
        add("midpoint", engine.midpoint(edge.a, edge.b), { id: entry.id });
        const projected = engine.projectPointOnLine(worldPosition, edge.a, edge.b);
        if (withinDrawnBounds(projected.t, edge.mode)) {
          add("on-geometry", projected.point, { id: entry.id });
        }
      });
      entry.circles.forEach((circle) => {
        add("center", circle.center, { id: entry.id });
        const angle = engine.angleOf(circle.center, worldPosition);
        add(
          "on-geometry",
          engine.pointOnCircleAt(circle.center, circle.radius, angle),
          { id: entry.id }
        );
      });
    });

    if (!candidates.length) return null;

    candidates.sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return a.distance - b.distance;
    });

    return candidates[0];
  }

  // ---------- the snap under the pointer ----------
  //
  // Published by whichever tool is driving (compass, line, ...) so the renderer
  // can highlight it without knowing which tool that is.

  let activeSnap = null;

  // Returns true when the highlight actually moved, so callers can redraw only
  // when there is something new to see.
  function setActiveSnap(snap) {
    const same =
      (!snap && !activeSnap) ||
      (!!snap && !!activeSnap &&
        snap.type === activeSnap.type &&
        Math.abs(snap.x - activeSnap.x) < 1e-9 &&
        Math.abs(snap.y - activeSnap.y) < 1e-9);
    activeSnap = snap || null;
    return !same;
  }

  function getActiveSnap() {
    return activeSnap;
  }

  // An intersection is derived: it exists only while both parents do, and
  // nothing in the drawing can refer to it. Anchoring anything to one (a line
  // endpoint, the compass needle) promotes it to a real stored point first,
  // which is what lets the crossing still be used long afterwards.
  function materializeSnap(target) {
    if (!target) return null;
    if (target.type === "point" && target.id) return get(target.id);
    if (target.type === "intersection") {
      return createPoint(target, {
        origin: "intersection",
        sourceIds: target.sourceObjectIds
      });
    }
    return null;
  }

  window.Inkyscib = window.Inkyscib || {};
  window.Inkyscib.Construction = {
    MERGE_TOLERANCE,
    SNAP_SCREEN_DISTANCE,

    isConstructionPath,
    isDrawnLine,
    rebuildFromPaths,
    rebuildIndex,
    get,
    allPoints,
    arcLikes,
    toShape,
    center,

    nextLabel,
    usedLabels,
    findPointAt,
    createPoint,
    createArc,
    createAngle,
    createSegment,
    remove,

    computeIntersections,
    invalidateIntersections,
    hasCrossableGeometry,
    findSnapTarget,
    setActiveSnap,
    getActiveSnap,
    materializeSnap
  };
})();
