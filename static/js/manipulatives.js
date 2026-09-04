(function () {
  "use strict";

  // Algebra-tile manipulatives.
  //
  // A tile is an axis-aligned rectangle whose width and height are each driven
  // by a *label*. A label is one of:
  //   ""        free   - drag the handle, nothing else depends on it
  //   "2"       fixed  - a constant number of units
  //   "x"       bound  - reads/writes the page-wide variable registry
  //   "x-y"     derived- computed from the registry, handle disabled
  //
  // The registry (state.manipulativeVariables) is the single source of truth
  // for bound lengths, which is what makes "every x-tile on this page is the
  // same length" true no matter which one you drag.

  const TILE_VERSION = 1;
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

  const MIN_UNITS = 0.25;
  const MAX_UNITS = 60;
  const STEP_UNITS = 0.25;
  const HANDLE_SCREEN_RADIUS = 12;
  const NEGATIVE_COLOR = "#ff5a76";
  const SEED_LENGTHS = { x: 3, y: 2, z: 1.5, w: 1.25, a: 2.5, b: 1.75, n: 2 };
  const DEFAULT_SEED = 2;

  const PRESETS = [
    { id: "unit", name: "Unit", width: "1", height: "1", color: "#fbbf24" },
    { id: "x", name: "x", width: "x", height: "1", color: "#7c74ff" },
    { id: "y", name: "y", width: "y", height: "1", color: "#2dd4bf" },
    { id: "x2", name: "x²", width: "x", height: "x", color: "#7c74ff" },
    { id: "xy", name: "xy", width: "x", height: "y", color: "#a855f7" },
    { id: "diff", name: "x − y", width: "x-y", height: "1", color: "#38bdf8" },
    { id: "free", name: "Free", width: "", height: "", color: "#94a3b8" }
  ];

  const PALETTE = ["#7c74ff", "#2dd4bf", "#fbbf24", "#a855f7", "#38bdf8", "#f97316", "#94a3b8"];

  function expr() {
    return window.Inkyscib?.ManipulativeExpr;
  }

  function state() {
    return window.appState;
  }

  function currentScale() {
    return Math.max(0.15, state()?.transform?.scale || 1);
  }

  function worldSize(pixels) {
    return pixels / currentScale();
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function quantize(units) {
    return clamp(Math.round(units / STEP_UNITS) * STEP_UNITS, MIN_UNITS, MAX_UNITS);
  }

  function finitePoint(point) {
    return !!point && Number.isFinite(point.x) && Number.isFinite(point.y);
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

  function isTile(path) {
    return !!path && path.tool === "manipulative" && Array.isArray(path.points) && path.points.length >= 4;
  }

  function tiles() {
    return (state()?.paths || []).filter(isTile);
  }

  function registry() {
    const s = state();
    if (!s) return {};
    if (!s.manipulativeVariables || typeof s.manipulativeVariables !== "object") {
      s.manipulativeVariables = {};
    }
    return s.manipulativeVariables;
  }

  function unitScale(path) {
    return Number.isFinite(path?.unitScale) && path.unitScale > 0 ? path.unitScale : DEFAULT_UNIT_SCALE;
  }

  // ---------------------------------------------------------------- geometry

  function tileRect(path) {
    const points = (path?.points || []).filter(finitePoint);
    if (points.length < 2) return { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0, cx: 0, cy: 0 };
    const xs = points.map((point) => point.x);
    const ys = points.map((point) => point.y);
    const left = Math.min(...xs);
    const right = Math.max(...xs);
    const top = Math.min(...ys);
    const bottom = Math.max(...ys);
    return {
      left,
      top,
      right,
      bottom,
      width: right - left,
      height: bottom - top,
      cx: (left + right) / 2,
      cy: (top + bottom) / 2
    };
  }

  function setTileRect(path, left, top, width, height) {
    const w = Math.max(1, width);
    const h = Math.max(1, height);
    path.points = [
      { x: left, y: top },
      { x: left + w, y: top },
      { x: left + w, y: top + h },
      { x: left, y: top + h }
    ];
    path.centerX = left + w / 2;
    path.centerY = top + h / 2;
    path.width = w;
    path.height = h;
    return path;
  }

  function dimensionUnits(path, dimension) {
    const rect = tileRect(path);
    return (dimension === "width" ? rect.width : rect.height) / unitScale(path);
  }

  function setDimensionUnits(path, dimension, units) {
    const rect = tileRect(path);
    const pixels = Math.max(MIN_UNITS, units) * unitScale(path);
    if (dimension === "width") {
      setTileRect(path, rect.left, rect.top, pixels, rect.height);
    } else {
      setTileRect(path, rect.left, rect.top, rect.width, pixels);
    }
  }

  function label(path, dimension) {
    return String((dimension === "width" ? path?.widthLabel : path?.heightLabel) || "");
  }

  function setLabel(path, dimension, value) {
    const cleaned = expr()?.normalizeSource(value) ?? String(value || "").trim();
    if (dimension === "width") path.widthLabel = cleaned;
    else path.heightLabel = cleaned;
  }

  // ------------------------------------------------------------- propagation

  function seedLength(name) {
    return SEED_LENGTHS[name] ?? DEFAULT_SEED;
  }

  // Which tile owns a variable's value. Only used for the "source removed"
  // warning: any bound tile can still be dragged and write to the registry.
  function variableSources() {
    const sources = new Map();
    tiles().forEach((path, index) => {
      ["width", "height"].forEach((dimension) => {
        const info = expr()?.classify(label(path, dimension));
        if (info?.kind !== "variable") return;
        if (!sources.has(info.name)) sources.set(info.name, { path, index, dimension });
      });
    });
    return sources;
  }

  function usedVariables() {
    const used = new Set();
    tiles().forEach((path) => {
      ["width", "height"].forEach((dimension) => {
        const info = expr()?.classify(label(path, dimension));
        if (info?.kind === "variable") used.add(info.name);
        else if (info?.kind === "expression") (info.dependencies || []).forEach((name) => used.add(name));
      });
    });
    return used;
  }

  function dependencyGraph() {
    const graph = {};
    tiles().forEach((path) => {
      ["width", "height"].forEach((dimension) => {
        const info = expr()?.classify(label(path, dimension));
        if (info?.kind !== "expression") return;
        // A derived dimension never defines a variable, so the only edges we
        // can build are expression -> its inputs. Recorded anyway so a future
        // "named derived tile" feature inherits the cycle guard for free.
        (info.dependencies || []).forEach((name) => {
          graph[name] = graph[name] || [];
        });
      });
    });
    return graph;
  }

  // Recomputes every tile from the registry. Bound dimensions whose variable is
  // still unknown seed the registry from their current on-canvas length, so
  // opening an old save (or one written before the registry existed) rebuilds
  // the variables instead of collapsing every tile.
  function syncAll() {
    const engine = expr();
    if (!engine) return false;

    const list = tiles();
    if (!list.length) return false;

    const reg = registry();
    const sources = variableSources();
    let changed = false;

    sources.forEach((source, name) => {
      if (Number.isFinite(reg[name])) return;
      const measured = dimensionUnits(source.path, source.dimension);
      reg[name] = measured >= MIN_UNITS ? quantize(measured) : seedLength(name);
    });

    // An expression may name a variable no tile defines yet (typing "x+2" on the
    // first tile of a blank page). Seeding it keeps the tile a sensible size and
    // surfaces the variable in the panel, where its value can be typed exactly.
    list.forEach((path) => {
      ["width", "height"].forEach((dimension) => {
        const info = engine.classify(label(path, dimension));
        if (info?.kind !== "expression") return;
        (info.dependencies || []).forEach((name) => {
          if (!Number.isFinite(reg[name])) reg[name] = seedLength(name);
        });
      });
    });

    const cycles = engine.findCycles(dependencyGraph());

    list.forEach((path) => {
      path.locked = { width: false, height: false };
      path.invalid = { width: false, height: false };
      path.detail = {};

      ["width", "height"].forEach((dimension) => {
        const raw = label(path, dimension);
        const info = engine.classify(raw);
        const detail = { kind: info.kind, text: info.text || "" };
        let target = null;

        if (info.kind === "number") {
          target = info.value;
          path.locked[dimension] = true;
        } else if (info.kind === "variable") {
          target = Number.isFinite(reg[info.name]) ? reg[info.name] : seedLength(info.name);
          reg[info.name] = target;
          detail.name = info.name;
          detail.orphan = !sources.has(info.name);
        } else if (info.kind === "expression") {
          path.locked[dimension] = true;
          const cyclic = [...(info.dependencies || [])].some((name) => cycles.has(name));
          const result = cyclic
            ? { value: null, error: "Circular reference" }
            : engine.evaluate(raw, reg);
          detail.error = result.error || null;
          detail.raw = result.value;
          detail.orphan = [...(info.dependencies || [])].some((name) => !sources.has(name));
          if (result.error || !Number.isFinite(result.value) || result.value < MIN_UNITS) {
            target = MIN_UNITS;
            path.invalid[dimension] = true;
          } else {
            target = result.value;
          }
        } else if (info.kind === "error") {
          path.locked[dimension] = true;
          path.invalid[dimension] = true;
          detail.error = info.error;
          target = MIN_UNITS;
        }

        if (Number.isFinite(target)) {
          const next = clamp(target, MIN_UNITS, MAX_UNITS);
          detail.value = next;
          if (Math.abs(dimensionUnits(path, dimension) - next) > 0.0005) {
            setDimensionUnits(path, dimension, next);
            changed = true;
          }
        } else {
          detail.value = dimensionUnits(path, dimension);
        }

        path.detail[dimension] = detail;
      });
    });

    return changed;
  }

  // Typed values are taken literally (clamped, not snapped) — the 0.25 lattice
  // is a dragging aid, and someone who types 4.375 means 4.375.
  function setVariable(name, value) {
    const next = Number(value);
    if (!name || !Number.isFinite(next)) return false;
    registry()[name] = clamp(next, MIN_UNITS, MAX_UNITS);
    syncAll();
    return true;
  }

  // Applies an exact length to whatever actually governs this dimension: the
  // shared variable, the literal in the label, or the tile's own geometry.
  function setDimensionValue(path, dimension, value) {
    const engine = expr();
    const next = Number(value);
    if (!isTile(path) || !engine || !Number.isFinite(next) || next <= 0) return false;

    const info = engine.classify(label(path, dimension));
    const target = clamp(next, MIN_UNITS, MAX_UNITS);

    if (info.kind === "variable") return setVariable(info.name, target);
    if (info.kind === "number") {
      setLabel(path, dimension, formatUnits(target));
      syncAll();
      return true;
    }
    if (info.kind === "empty") {
      setDimensionUnits(path, dimension, target);
      syncAll();
      return true;
    }
    // Derived dimensions are computed; the label is the thing to edit.
    return false;
  }

  function variableList() {
    const reg = registry();
    const used = usedVariables();
    const sources = variableSources();
    return [...used].sort().map((name) => ({
      name,
      value: Number.isFinite(reg[name]) ? reg[name] : seedLength(name),
      hasSource: sources.has(name)
    }));
  }

  // Makes the tiles on the page authoritative again: every variable is re-read
  // from the tile that names it, and variables nothing references are dropped.
  // Undo/redo and document loads both need this, because the registry lives
  // outside the paths array that those two restore.
  function rebuildRegistryFromPaths() {
    const s = state();
    if (!s) return;
    const reg = registry();
    const used = usedVariables();
    Object.keys(reg).forEach((name) => {
      if (!used.has(name)) delete reg[name];
    });

    variableSources().forEach((source, name) => {
      const measured = dimensionUnits(source.path, source.dimension);
      if (measured >= MIN_UNITS) reg[name] = quantize(measured);
    });

    tiles().forEach((path) => { delete path.detail; });
    syncAll();
    notifyChange(true);
  }

  // ------------------------------------------------------------------ colors

  function toHex(color) {
    if (typeof color === "string" && /^#[0-9a-f]{6}$/i.test(color)) return color;
    if (typeof color === "string" && /^#[0-9a-f]{3}$/i.test(color)) {
      return `#${color[1]}${color[1]}${color[2]}${color[2]}${color[3]}${color[3]}`;
    }
    return "#7c74ff";
  }

  function rgba(color, alpha) {
    const hex = toHex(color);
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  function luminance(color) {
    const hex = toHex(color);
    const r = parseInt(hex.slice(1, 3), 16) / 255;
    const g = parseInt(hex.slice(3, 5), 16) / 255;
    const b = parseInt(hex.slice(5, 7), 16) / 255;
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  function tileColor(path) {
    return path?.negative ? NEGATIVE_COLOR : toHex(path?.color);
  }

  function inkColor(path) {
    return luminance(tileColor(path)) > 0.62 ? "#131a2b" : "#ffffff";
  }

  // ----------------------------------------------------------------- drawing

  function prettyMinus(text) {
    return String(text || "").replace(/-/g, "−").replace(/\*/g, "·");
  }

  function formatUnits(value) {
    if (!Number.isFinite(value)) return "?";
    return value.toFixed(2).replace(/(\.\d*?[1-9])0+$/, "$1").replace(/\.0+$/, "");
  }

  function dimensionText(path, dimension) {
    const detail = path?.detail?.[dimension];
    if (!detail) return "";
    if (detail.kind === "number") return prettyMinus(detail.text);
    if (detail.kind === "variable") {
      if (!measurementsVisible()) return "";
      return path.showMeasurements === false
        ? detail.text
        : `${detail.text} = ${formatUnits(detail.value)}`;
    }
    if (detail.kind === "expression" || detail.kind === "error") {
      const raw = Number.isFinite(detail.raw) ? detail.raw : detail.value;
      return `${prettyMinus(detail.text)} = ${prettyMinus(formatUnits(raw))}`;
    }
    if (!measurementsVisible()) return "";
    return path.showMeasurements === false ? "" : `${formatUnits(detail.value)} ${unitLabel()}`;
  }

  function areaText(path) {
    const width = path?.detail?.width;
    const height = path?.detail?.height;
    if (!width || !height) return "";
    if (!width.text && !height.text) return "";
    if (width.kind === "number" && height.kind === "number") {
      return formatUnits((width.value || 0) * (height.value || 0));
    }
    if (width.text && width.text === height.text && width.kind === "variable") {
      return `${width.text}²`;
    }
    const wrap = (detail) => {
      const text = detail.text ? prettyMinus(detail.text) : formatUnits(detail.value);
      return detail.kind === "expression" ? `(${text})` : text;
    };
    // A "× 1" factor is noise on a classic x-tile, so only the other side shows.
    const isUnit = (detail) => detail.kind === "number" && Math.abs(detail.value - 1) < 0.0001;
    if (isUnit(width) && isUnit(height)) return "1";
    if (isUnit(height)) return wrap(width);
    if (isUnit(width)) return wrap(height);
    return `${wrap(width)}·${wrap(height)}`;
  }

  function roundedRect(ctx, left, top, width, height, radius) {
    const r = Math.max(0, Math.min(radius, width / 2, height / 2));
    ctx.beginPath();
    if (typeof ctx.roundRect === "function") {
      ctx.roundRect(left, top, width, height, r);
      return;
    }
    ctx.moveTo(left + r, top);
    ctx.lineTo(left + width - r, top);
    ctx.quadraticCurveTo(left + width, top, left + width, top + r);
    ctx.lineTo(left + width, top + height - r);
    ctx.quadraticCurveTo(left + width, top + height, left + width - r, top + height);
    ctx.lineTo(left + r, top + height);
    ctx.quadraticCurveTo(left, top + height, left, top + height - r);
    ctx.lineTo(left, top + r);
    ctx.quadraticCurveTo(left, top, left + r, top);
    ctx.closePath();
  }

  function drawChip(ctx, text, point, options = {}) {
    if (!text) return;
    const scale = currentScale();
    const fontSize = (options.small ? 10 : 11.5) / scale;
    const padX = 6 / scale;
    const padY = 4 / scale;

    ctx.save();
    if (options.rotate) {
      ctx.translate(point.x, point.y);
      ctx.rotate(-Math.PI / 2);
      ctx.translate(-point.x, -point.y);
    }
    ctx.font = `800 ${fontSize}px "Segoe UI", system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const width = ctx.measureText(text).width + padX * 2;
    const height = fontSize + padY * 2;
    roundedRect(ctx, point.x - width / 2, point.y - height / 2, width, height, 6 / scale);
    ctx.fillStyle = options.background || "rgba(12, 16, 25, 0.9)";
    ctx.fill();
    ctx.lineWidth = 1 / scale;
    ctx.strokeStyle = options.border || "rgba(255, 255, 255, 0.22)";
    ctx.stroke();
    ctx.fillStyle = options.color || "#f5f3ff";
    ctx.fillText(text, point.x, point.y + 0.4 / scale);
    ctx.restore();
  }

  function drawLockGlyph(ctx, x, y, color) {
    const scale = currentScale();
    const size = 5 / scale;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.3 / scale;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.arc(x, y - size * 0.55, size * 0.55, Math.PI, 0);
    ctx.stroke();
    roundedRect(ctx, x - size * 0.8, y - size * 0.1, size * 1.6, size * 1.2, size * 0.3);
    ctx.stroke();
    ctx.restore();
  }

  // Once tiles are packed flush, an interior label sits on top of its
  // neighbour. Anything that would land on another tile is dropped, which
  // leaves the dimensions readable around the outside of an area model.
  function anchorIsCovered(point, path) {
    return tiles().some((other) => {
      if (other === path) return false;
      const rect = tileRect(other);
      return point.x > rect.left + 0.01 && point.x < rect.right - 0.01 &&
        point.y > rect.top + 0.01 && point.y < rect.bottom - 0.01;
    });
  }

  function drawTile(ctx, path) {
    if (!isTile(path)) return;
    if (!path.detail) syncAll();

    const rect = tileRect(path);
    if (rect.width <= 0 || rect.height <= 0) return;

    const scale = currentScale();
    const base = tileColor(path);
    const ink = inkColor(path);
    const stroke = Math.max(0.6, path.size || 2);
    // Square corners: tiles are meant to butt flush against each other, and
    // rounded ends read as gaps at the seams.
    const radius = 0;
    const flagged = !!(path.invalid?.width || path.invalid?.height);

    ctx.save();

    const fill = ctx.createLinearGradient(rect.left, rect.top, rect.right, rect.bottom);
    fill.addColorStop(0, rgba(base, 0.94));
    fill.addColorStop(1, rgba(base, 0.72));
    roundedRect(ctx, rect.left, rect.top, rect.width, rect.height, radius);
    ctx.fillStyle = fill;
    ctx.fill();

    ctx.lineWidth = stroke;
    ctx.strokeStyle = rgba(base, 1);
    ctx.stroke();

    // Inner highlight keeps stacked tiles readable against each other.
    roundedRect(
      ctx,
      rect.left + stroke,
      rect.top + stroke,
      Math.max(0, rect.width - stroke * 2),
      Math.max(0, rect.height - stroke * 2),
      Math.max(0, radius - stroke)
    );
    ctx.lineWidth = Math.max(0.4, 1 / scale);
    ctx.strokeStyle = ink === "#ffffff" ? "rgba(255,255,255,0.26)" : "rgba(0,0,0,0.16)";
    ctx.stroke();

    if (path.negative) {
      ctx.lineWidth = Math.max(1.6, 2.4 / scale);
      ctx.strokeStyle = ink;
      ctx.globalAlpha = 0.85;
      const barWidth = Math.min(rect.width, rect.height) * 0.34;
      ctx.beginPath();
      ctx.moveTo(rect.cx - barWidth / 2, rect.cy);
      ctx.lineTo(rect.cx + barWidth / 2, rect.cy);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    const area = areaText(path);
    const areaFont = Math.min(rect.height * 0.42, rect.width * 0.34, 20 / scale);
    if (area && !path.negative && areaFont > 6 / scale) {
      ctx.font = `800 ${areaFont}px "Segoe UI", system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = ink;
      ctx.globalAlpha = 0.66;
      ctx.fillText(area, rect.cx, rect.cy);
      ctx.globalAlpha = 1;
    }

    if (flagged) {
      ctx.setLineDash([6 / scale, 4 / scale]);
      ctx.lineWidth = Math.max(1.2, 1.8 / scale);
      ctx.strokeStyle = "#ff5a76";
      roundedRect(
        ctx,
        rect.left - worldSize(3),
        rect.top - worldSize(3),
        rect.width + worldSize(6),
        rect.height + worldSize(6),
        radius + worldSize(3)
      );
      ctx.stroke();
      ctx.setLineDash([]);
    }

    ctx.restore();

    const widthText = dimensionText(path, "width");
    const heightText = dimensionText(path, "height");
    const chipStyle = (dimension) => ({
      background: path.invalid?.[dimension] ? "rgba(72, 14, 26, 0.94)" : "rgba(12, 16, 25, 0.9)",
      border: path.invalid?.[dimension] ? "rgba(255, 90, 118, 0.85)" : rgba(base, 0.6),
      color: path.invalid?.[dimension] ? "#ffd5dc" : "#f4f3ff"
    });

    const widthAnchor = { x: rect.cx, y: rect.bottom + worldSize(26) };
    if (widthText && !anchorIsCovered(widthAnchor, path)) {
      const point = widthAnchor;
      drawChip(ctx, widthText, point, chipStyle("width"));
      // Only derived dimensions earn a padlock: a literal "1" is obviously
      // fixed, and badging every unit side turns the page into noise.
      if (path.detail?.width?.kind === "expression") {
        drawLockGlyph(ctx, rect.cx + worldSize(4) + ctxTextHalf(ctx, widthText), point.y, rgba(base, 0.9));
      }
    }

    // Sideways text only pays off down a tall edge with something to read.
    const rotate = rect.height > rect.width * 0.9 && heightText.length >= 3;
    const heightAnchor = { x: rect.left - worldSize(rotate ? 14 : 16), y: rect.cy };
    if (heightText && !anchorIsCovered(heightAnchor, path)) {
      const anchor = heightAnchor;
      drawChip(ctx, heightText, anchor, {
        ...chipStyle("height"),
        rotate
      });
    }

    if (flagged) {
      drawChip(ctx, "⚠", { x: rect.right - worldSize(3), y: rect.top - worldSize(3) }, {
        small: true,
        background: "rgba(72, 14, 26, 0.96)",
        border: "rgba(255, 90, 118, 0.9)",
        color: "#ffd5dc"
      });
    }
  }

  function ctxTextHalf(ctx, text) {
    const scale = currentScale();
    ctx.save();
    ctx.font = `800 ${11.5 / scale}px "Segoe UI", system-ui, sans-serif`;
    const half = ctx.measureText(text).width / 2 + 6 / scale;
    ctx.restore();
    return half;
  }

  // ------------------------------------------------------------- interaction

  function selectedTile() {
    const indices = window.Inkyscib?.Selection?.selectedIndices?.() || [];
    if (indices.length !== 1) return null;
    const path = state()?.paths?.[indices[0]];
    return isTile(path) ? { path, index: indices[0] } : null;
  }

  // Handles sit just outside the tile so they never cover its label or fill,
  // and stay a comfortable thumb apart on a tablet.
  const HANDLE_OFFSET = 8;
  // How close (in screen pixels) an edge has to come before it clicks into place.
  const SNAP_SCREEN_DISTANCE = 18;

  function tileHandles(path) {
    const rect = tileRect(path);
    const offset = worldSize(HANDLE_OFFSET);
    return [
      // A corner grip rather than a centre one: the middle of the tile carries
      // its area label, and the body itself is already draggable.
      { type: "move", x: rect.left - worldSize(11), y: rect.top - worldSize(11) },
      {
        type: "width",
        x: rect.right + offset,
        y: rect.cy,
        edge: rect.right,
        disabled: !!path.locked?.width
      },
      {
        type: "height",
        x: rect.cx,
        y: rect.bottom + offset,
        edge: rect.bottom,
        disabled: !!path.locked?.height
      }
    ];
  }


  // ---------------------------------------------------------------- snapping

  // Magnetic placement. A dragged tile looks for edges on its neighbours and
  // clicks onto them, so tiles butt flush the way physical manipulatives do
  // instead of landing a hair apart. Each axis is solved independently and the
  // winning guide is returned so the overlay can show why it moved.
  function snapOffsets(rect, path) {
    const threshold = worldSize(SNAP_SCREEN_DISTANCE);
    const others = tiles().filter((tile) => tile !== path);
    if (!others.length) return { dx: 0, dy: 0, guides: [] };

    let bestX = null;
    let bestY = null;

    const consider = (axis, moving, target, guide) => {
      const delta = target - moving;
      const distance = Math.abs(delta);
      if (distance > threshold) return;
      const current = axis === "x" ? bestX : bestY;
      // Prefer flush contact over centre alignment when both are in range.
      if (current && (current.distance < distance ||
        (current.distance === distance && current.priority <= guide.priority))) return;
      const entry = { delta, distance, priority: guide.priority, guide };
      if (axis === "x") bestX = entry;
      else bestY = entry;
    };

    others.forEach((other) => {
      const o = tileRect(other);
      // Only offer contact snaps when the tiles actually face each other,
      // otherwise a tile across the page would tug at this one.
      const facesVertically = rect.top < o.bottom + threshold && rect.bottom > o.top - threshold;
      const facesHorizontally = rect.left < o.right + threshold && rect.right > o.left - threshold;

      if (facesVertically) {
        consider("x", rect.left, o.right, { priority: 2, kind: "contact", axis: "x", at: o.right, from: o, to: rect });
        consider("x", rect.right, o.left, { priority: 2, kind: "contact", axis: "x", at: o.left, from: o, to: rect });
      }
      consider("x", rect.left, o.left, { priority: 1, kind: "align", axis: "x", at: o.left, from: o, to: rect });
      consider("x", rect.right, o.right, { priority: 1, kind: "align", axis: "x", at: o.right, from: o, to: rect });
      consider("x", rect.cx, o.cx, { priority: 0, kind: "align", axis: "x", at: o.cx, from: o, to: rect });

      if (facesHorizontally) {
        consider("y", rect.top, o.bottom, { priority: 2, kind: "contact", axis: "y", at: o.bottom, from: o, to: rect });
        consider("y", rect.bottom, o.top, { priority: 2, kind: "contact", axis: "y", at: o.top, from: o, to: rect });
      }
      consider("y", rect.top, o.top, { priority: 1, kind: "align", axis: "y", at: o.top, from: o, to: rect });
      consider("y", rect.bottom, o.bottom, { priority: 1, kind: "align", axis: "y", at: o.bottom, from: o, to: rect });
      consider("y", rect.cy, o.cy, { priority: 0, kind: "align", axis: "y", at: o.cy, from: o, to: rect });
    });

    const guides = [];
    if (bestX) guides.push(bestX.guide);
    if (bestY) guides.push(bestY.guide);
    return { dx: bestX ? bestX.delta : 0, dy: bestY ? bestY.delta : 0, guides };
  }

  // Places a tile at a grid-quantised position, then lets neighbouring edges
  // pull it the rest of the way.
  function placeTileRect(path, left, top, rect) {
    const step = unitScale(path) * STEP_UNITS;
    const gridLeft = Math.round(left / step) * step;
    const gridTop = Math.round(top / step) * step;
    const probe = {
      left: gridLeft,
      top: gridTop,
      right: gridLeft + rect.width,
      bottom: gridTop + rect.height,
      width: rect.width,
      height: rect.height,
      cx: gridLeft + rect.width / 2,
      cy: gridTop + rect.height / 2
    };
    const snap = snapOffsets(probe, path);
    setTileRect(path, gridLeft + snap.dx, gridTop + snap.dy, rect.width, rect.height);
    return snap.guides;
  }

  function handleAt(point, path) {
    const tolerance = worldSize(HANDLE_SCREEN_RADIUS + 6);
    return tileHandles(path).find(
      (handle) => Math.hypot(point.x - handle.x, point.y - handle.y) <= tolerance
    ) || null;
  }

  function eventWorldPoint(event) {
    if (typeof window.getCanvasPos === "function") return window.getCanvasPos(event);
    return { x: event.clientX, y: event.clientY };
  }

  function setCursor(handle) {
    const canvas = document.getElementById("drawingCanvas");
    if (!canvas) return;
    if (!handle) canvas.style.cursor = "default";
    else if (handle.disabled) canvas.style.cursor = "not-allowed";
    else if (handle.type === "move") canvas.style.cursor = "move";
    else canvas.style.cursor = handle.type === "width" ? "ew-resize" : "ns-resize";
  }

  function pointInsideTile(point, path) {
    const rect = tileRect(path);
    return point.x >= rect.left && point.x <= rect.right &&
      point.y >= rect.top && point.y <= rect.bottom;
  }

  function beginTileAction(event) {
    const selected = selectedTile();
    if (!selected) return false;
    const point = eventWorldPoint(event);
    // Dragging the tile body is a move as much as the corner grip is. Routing
    // it through here (instead of the generic selection move) is what lets a
    // tile snap to its neighbours wherever the user grabs it.
    const handle = handleAt(point, selected.path) ||
      (pointInsideTile(point, selected.path) ? { type: "move", body: true } : null);
    if (!handle) return false;

    setCursor(handle);
    if (handle.disabled) return true;

    const rect = tileRect(selected.path);
    state().selection.tileAction = {
      index: selected.index,
      handle,
      startPoint: point,
      grabOffset: handle.type === "move"
        ? { x: point.x - rect.cx, y: point.y - rect.cy }
        : { x: point.x - (handle.edge ?? point.x), y: point.y - (handle.edge ?? point.y) },
      before: typeof window.captureHistory === "function" ? window.captureHistory() : null,
      moved: false
    };
    requestRedraw();
    return true;
  }

  function applyTileAction(event) {
    const s = state();
    const action = s?.selection?.tileAction;
    if (!action) return false;
    const path = s.paths[action.index];
    if (!isTile(path)) {
      delete s.selection.tileAction;
      return false;
    }

    const point = eventWorldPoint(event);
    action.moved = action.moved ||
      Math.hypot(point.x - action.startPoint.x, point.y - action.startPoint.y) > worldSize(1.5);

    const rect = tileRect(path);
    const scale = unitScale(path);

    if (action.handle.type === "move") {
      action.guides = placeTileRect(
        path,
        point.x - action.grabOffset.x - rect.width / 2,
        point.y - action.grabOffset.y - rect.height / 2,
        rect
      );
    } else {
      const dimension = action.handle.type;
      const rawUnits = dimension === "width"
        ? (point.x - action.grabOffset.x - rect.left) / scale
        : (point.y - action.grabOffset.y - rect.top) / scale;
      const next = quantize(rawUnits);
      const info = expr()?.classify(label(path, dimension));
      if (info?.kind === "variable") {
        registry()[info.name] = next;
      } else {
        setDimensionUnits(path, dimension, next);
      }
      syncAll();
      action.guides = [];
    }

    requestRedraw();
    notifyChange();
    return true;
  }

  function endTileAction() {
    const s = state();
    const action = s?.selection?.tileAction;
    if (!action) return false;
    delete s.selection.tileAction;
    if (action.moved) {
      if (typeof window.commitHistory === "function" && action.before) window.commitHistory(action.before);
      safeSave();
    }
    setCursor(null);
    requestRedraw();
    notifyChange();
    return true;
  }

  function hoverTileHandle(event) {
    const selected = selectedTile();
    if (!selected || !event) return false;
    const handle = handleAt(eventWorldPoint(event), selected.path);
    if (!handle) return false;
    setCursor(handle);
    return true;
  }

  function drawHandle(ctx, handle) {
    const scale = currentScale();
    const radius = (handle.type === "move" ? 8 : handle.disabled ? 5.5 : 7.5) / scale;
    ctx.save();
    ctx.globalAlpha = handle.disabled ? 0.72 : 1;
    ctx.lineWidth = 1.6 / scale;
    ctx.strokeStyle = handle.disabled ? "rgba(255, 116, 135, 0.95)" : "rgba(170, 165, 255, 1)";
    ctx.fillStyle = handle.disabled ? "rgba(48, 14, 24, 0.95)" : "rgba(12, 16, 25, 0.96)";
    ctx.shadowColor = "rgba(91, 82, 255, 0.42)";
    ctx.shadowBlur = 8 / scale;
    ctx.beginPath();
    ctx.arc(handle.x, handle.y, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.shadowBlur = 0;

    const arm = radius * 0.5;
    ctx.beginPath();
    if (handle.type === "move") {
      ctx.moveTo(handle.x - arm, handle.y);
      ctx.lineTo(handle.x + arm, handle.y);
      ctx.moveTo(handle.x, handle.y - arm);
      ctx.lineTo(handle.x, handle.y + arm);
    } else if (handle.disabled) {
      ctx.moveTo(handle.x - arm, handle.y - arm);
      ctx.lineTo(handle.x + arm, handle.y + arm);
    } else if (handle.type === "width") {
      ctx.moveTo(handle.x - arm, handle.y);
      ctx.lineTo(handle.x + arm, handle.y);
    } else {
      ctx.moveTo(handle.x, handle.y - arm);
      ctx.lineTo(handle.x, handle.y + arm);
    }
    ctx.stroke();
    ctx.restore();
  }

  function drawTileOverlay(ctx, path) {
    const rect = tileRect(path);
    const scale = currentScale();
    ctx.save();
    ctx.lineWidth = 1.4 / scale;
    ctx.strokeStyle = "rgba(132, 125, 255, 0.96)";
    ctx.setLineDash([7 / scale, 5 / scale]);
    roundedRect(
      ctx,
      rect.left - worldSize(5),
      rect.top - worldSize(5),
      rect.width + worldSize(10),
      rect.height + worldSize(10),
      worldSize(9)
    );
    ctx.stroke();
    ctx.restore();
    tileHandles(path).forEach((handle) => drawHandle(ctx, handle));
    drawSnapGuides(ctx);
  }

  // A short line along the edge that captured the tile, drawn only while the
  // magnet is actually holding it.
  function drawSnapGuides(ctx) {
    const guides = state()?.selection?.tileAction?.guides || [];
    if (!guides.length) return;
    const scale = currentScale();

    ctx.save();
    ctx.lineWidth = 1.6 / scale;
    ctx.setLineDash([]);
    guides.forEach((guide) => {
      ctx.strokeStyle = guide.kind === "contact" ? "#5eead4" : "rgba(251, 191, 36, 0.95)";
      const pad = worldSize(10);
      ctx.beginPath();
      if (guide.axis === "x") {
        const top = Math.min(guide.from.top, guide.to.top) - pad;
        const bottom = Math.max(guide.from.bottom, guide.to.bottom) + pad;
        ctx.moveTo(guide.at, top);
        ctx.lineTo(guide.at, bottom);
      } else {
        const left = Math.min(guide.from.left, guide.to.left) - pad;
        const right = Math.max(guide.from.right, guide.to.right) + pad;
        ctx.moveTo(left, guide.at);
        ctx.lineTo(right, guide.at);
      }
      ctx.stroke();
    });
    ctx.restore();
  }

  function installSelectionHooks() {
    const selection = window.Inkyscib?.Selection;
    if (!selection || selection.__manipulativesInstalled) return;

    const base = {
      handleDown: selection.handleDown,
      handleMove: selection.handleMove,
      handleUp: selection.handleUp,
      drawOverlay: selection.drawOverlay,
      clear: selection.clear,
      updateHoverCursor: selection.updateHoverCursor
    };

    selection.handleDown = function handleTileDown(event) {
      if (beginTileAction(event)) return true;
      return base.handleDown(event);
    };
    selection.handleMove = function handleTileMove(event) {
      if (state()?.selection?.tileAction) return applyTileAction(event);
      if (hoverTileHandle(event)) return true;
      return base.handleMove(event);
    };
    selection.handleUp = function handleTileUp(event) {
      if (state()?.selection?.tileAction) return endTileAction(event);
      return base.handleUp(event);
    };
    selection.drawOverlay = function drawTileOverlayHook(ctx) {
      const selected = selectedTile();
      const marquee = state()?.selection?.action?.mode === "marquee";
      if (selected && !marquee) {
        drawTileOverlay(ctx, selected.path);
        // The geometry inspector hides itself from its own sync pass, which we
        // just skipped by not calling through to the base overlay.
        window.Inkyscib?.SmartGeometry?.syncInspector?.();
        notifyChange();
        return;
      }
      base.drawOverlay(ctx);
      notifyChange();
    };
    selection.clear = function clearTileSelection(options) {
      if (state()?.selection?.tileAction) delete state().selection.tileAction;
      const result = base.clear(options);
      notifyChange(true);
      return result;
    };
    selection.updateHoverCursor = function updateTileHover(event) {
      if (hoverTileHandle(event)) return true;
      return base.updateHoverCursor(event);
    };

    selection.__manipulativesInstalled = true;
  }

  // --------------------------------------------------------- create / import

  function toolSettings() {
    const s = state();
    if (!s) return {};
    if (!s.toolSettings.manipulative) {
      s.toolSettings.manipulative = {
        preset: "x",
        color: "#7c74ff",
        negative: false,
        size: 2,
        showMeasurements: true
      };
    }
    return s.toolSettings.manipulative;
  }

  function presetById(id) {
    return PRESETS.find((preset) => preset.id === id) || PRESETS[1];
  }

  function plannedUnits(labelText, fallback) {
    const info = expr()?.classify(labelText);
    if (!info || info.kind === "empty") return fallback;
    if (info.kind === "number") return info.value;
    if (info.kind === "variable") {
      const reg = registry();
      return Number.isFinite(reg[info.name]) ? reg[info.name] : seedLength(info.name);
    }
    const result = expr()?.evaluate(labelText, registry());
    return Number.isFinite(result?.value) && result.value >= MIN_UNITS ? result.value : fallback;
  }

  function createTilePath(position, options = {}) {
    const settings = toolSettings();
    const preset = presetById(options.preset || settings.preset);
    const widthLabel = options.widthLabel ?? preset.width;
    const heightLabel = options.heightLabel ?? preset.height;
    // The active preset honours a swatch the user picked; a tile dragged
    // straight out of the tray keeps its own preset colour.
    const presetColor = preset.id === settings.preset ? (settings.color || preset.color) : preset.color;
    const scale = DEFAULT_UNIT_SCALE;
    const widthUnits = clamp(plannedUnits(widthLabel, 2), MIN_UNITS, MAX_UNITS);
    const heightUnits = clamp(plannedUnits(heightLabel, 1), MIN_UNITS, MAX_UNITS);

    const path = {
      tool: "manipulative",
      tileVersion: TILE_VERSION,
      shapeType: "rectangle",
      geometryKind: "rectangle",
      points: [],
      widthLabel,
      heightLabel,
      negative: !!(options.negative ?? settings.negative),
      color: toHex(options.color || presetColor),
      size: Number.isFinite(settings.size) ? settings.size : 2,
      unitScale: scale,
      showMeasurements: settings.showMeasurements !== false,
      locked: { width: false, height: false },
      invalid: { width: false, height: false },
      timestamp: Date.now()
    };

    setTileRect(path, 0, 0, widthUnits * scale, heightUnits * scale);
    placeTileRect(
      path,
      position.x - (widthUnits * scale) / 2,
      position.y - (heightUnits * scale) / 2,
      tileRect(path)
    );
    return path;
  }

  function moveTileTo(path, position) {
    if (!isTile(path)) return;
    const rect = tileRect(path);
    placeTileRect(path, position.x - rect.width / 2, position.y - rect.height / 2, rect);
  }

  function finalizeTile(path) {
    if (!isTile(path)) return false;
    normalizeTile(path);
    return true;
  }

  function afterTileCreated(path, index) {
    if (!isTile(path)) return false;
    syncAll();
    if (typeof window.setTool === "function") window.setTool("select");
    window.Inkyscib?.Selection?.selectIndex?.(index);
    requestRedraw();
    notifyChange(true);
    return true;
  }

  function normalizeTile(path) {
    if (!path || path.tool !== "manipulative") return path;
    path.tileVersion = TILE_VERSION;
    path.shapeType = "rectangle";
    path.geometryKind = "rectangle";
    path.unitScale = unitScale(path);
    path.color = toHex(path.color);
    path.negative = !!path.negative;
    path.showMeasurements = path.showMeasurements !== false;
    path.size = Number.isFinite(path.size) ? clamp(path.size, 0.5, 20) : 2;
    path.widthLabel = expr()?.normalizeSource(path.widthLabel) ?? "";
    path.heightLabel = expr()?.normalizeSource(path.heightLabel) ?? "";

    const rect = tileRect(path);
    const width = rect.width >= 1 ? rect.width : path.unitScale;
    const height = rect.height >= 1 ? rect.height : path.unitScale;
    setTileRect(path, rect.left, rect.top, width, height);

    if (!path.locked) path.locked = { width: false, height: false };
    if (!path.invalid) path.invalid = { width: false, height: false };
    // Dropping the cached read-out forces the next draw through syncAll, so a
    // tile that was group-scaled or rotated snaps back to its bound length.
    delete path.detail;
    return path;
  }

  // ------------------------------------------------------------------ events

  const listeners = new Set();
  let notifyQueued = false;

  function runListeners() {
    listeners.forEach((listener) => {
      try {
        listener();
      } catch (error) {
        console.warn("Manipulatives listener failed:", error);
      }
    });
  }

  // Per-frame callers batch through rAF; selection changes flush immediately so
  // the inspector is on screen in the same tick the tile becomes selected.
  function notifyChange(immediate = false) {
    if (immediate) {
      notifyQueued = false;
      runListeners();
      return;
    }
    if (notifyQueued) return;
    notifyQueued = true;
    window.requestAnimationFrame(() => {
      notifyQueued = false;
      runListeners();
    });
  }

  function onChange(listener) {
    if (typeof listener === "function") listeners.add(listener);
    return () => listeners.delete(listener);
  }

  window.Inkyscib = window.Inkyscib || {};
  window.Inkyscib.Manipulatives = {
    version: TILE_VERSION,
    PRESETS,
    PALETTE,
    MIN_UNITS,
    MAX_UNITS,
    STEP_UNITS,
    isTile,
    tiles,
    tileRect,
    setTileRect,
    dimensionUnits,
    setDimensionUnits,
    setDimensionValue,
    label,
    setLabel,
    registry,
    setVariable,
    variableList,
    rebuildRegistryFromPaths,
    syncAll,
    drawTile,
    drawTileOverlay,
    selectedTile,
    createTilePath,
    moveTileTo,
    snapOffsets,
    placeTileRect,
    finalizeTile,
    afterTileCreated,
    normalizeTile,
    toolSettings,
    presetById,
    formatUnits,
    prettyMinus,
    toHex,
    onChange,
    notifyChange,
    requestRedraw
  };

  installSelectionHooks();
  document.addEventListener("DOMContentLoaded", () => {
    installSelectionHooks();
    rebuildRegistryFromPaths();
  });
})();
