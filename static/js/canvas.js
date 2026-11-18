const patternCtx = document.getElementById('patternCanvas').getContext('2d', {
    alpha: true,
    desynchronized: true
});
const drawingCtx = document.getElementById('drawingCanvas').getContext('2d', {
    alpha: true,
    desynchronized: true
});

// The pattern and all committed strokes are stable while a user is writing a
// new stroke. Keeping those expensive layers cached turns each pointer frame
// into one bitmap composite plus the live stroke, instead of replaying the
// entire notebook on every input event.
let __committedLayer = document.createElement('canvas');
let __committedLayerCtx = __committedLayer.getContext('2d', {
    alpha: true,
    desynchronized: true
});
let __committedLayerMeta = null;
// Bumped whenever the committed layer's pixels change, so a frame can tell
// whether the layer under it is the one the previous frame drew.
let __committedRevision = 0;
// The sharp layer being built in slices while frames show the old one. It swaps
// with the committed layer once it reaches the end of the document.
let __pendingLayer = document.createElement('canvas');
let __pendingLayerCtx = __pendingLayer.getContext('2d', {
    alpha: true,
    desynchronized: true
});
let __pendingMeta = null;
// Per frame. Leaves room in a 16.7 ms frame for the live stroke and compositing.
const __REBUILD_SLICE_MS = 5;
// Pan and zoom used to invalidate the committed layer outright, so every frame
// of a drag or a pinch replayed the whole document through the rasteriser. The
// layer is now rendered with a margin of device pixels around the viewport,
// which buys a budget of movement that can be served by transforming the
// bitmap we already have - one composite instead of thousands of strokes.
//
// The blit is the cached layer scaled, so it goes soft as the view is
// magnified; a sharp rebuild is scheduled once movement stops. If a gesture
// travels further than the margin covers, or magnifies past the cap, the frame
// falls back to a normal rebuild and costs exactly what it costs today. The
// worst case is therefore unchanged and the common case is free.
const __COMMITTED_PAD = Number(navigator.deviceMemory || 4) <= 2 ? 96 : 192;
const __BLIT_MAX_ZOOM = 1.6;
const __SHARP_REBUILD_DELAY = 140;
let __sharpRebuildTimer = null;
let __backgroundLayerMeta = null;
let __backgroundRevision = 0;
let __renderFrame = null;

const __patternCache = new Map();
window.__patternCache = __patternCache;
const __mediaImageCache = new Map();
const __mediaImageCacheLimit = Number(navigator.deviceMemory || 4) <= 2 ? 10 : 24;

function __sameTransform(meta, transform) {
    return !!meta &&
        meta.scale === transform.scale &&
        meta.offsetX === transform.offsetX &&
        meta.offsetY === transform.offsetY;
}

function __samePathReferences(cached, paths) {
    if (!cached || cached.length !== paths.length) return false;
    for (let index = 0; index < paths.length; index++) {
        if (cached[index] !== paths[index]) return false;
    }
    return true;
}

function invalidateCanvasDrawingCache() {
    __committedLayerMeta = null;
    __pendingMeta = null;
}

function invalidateCanvasBackground() {
    __backgroundRevision += 1;
    __backgroundLayerMeta = null;
}

function __makeTile(pattern, theme) {
    const tile = document.createElement("canvas");
    const tctx = tile.getContext("2d");

    const ink = theme === "light" ? "rgba(0,0,0,0.10)" : "rgba(255,255,255,0.12)";

    if (pattern === "dot") {
        tile.width = 24; tile.height = 24;
        tctx.fillStyle = ink;
        tctx.beginPath();
        tctx.arc(12, 12, 1, 0, Math.PI * 2);
        tctx.fill();
    }

    if (pattern === "lines") {
        tile.width = 120; tile.height = 32;
        tctx.strokeStyle = ink;
        tctx.lineWidth = 1;
        tctx.beginPath();
        tctx.moveTo(0, 31.5);
        tctx.lineTo(tile.width, 31.5);
        tctx.stroke();
    }

    if (pattern === "graph") {
        tile.width = 28; tile.height = 28;
        tctx.strokeStyle = ink;
        tctx.lineWidth = 1;

        tctx.beginPath();
        tctx.moveTo(0, 0.5);
        tctx.lineTo(tile.width, 0.5);
        tctx.stroke();

        tctx.beginPath();
        tctx.moveTo(0.5, 0);
        tctx.lineTo(0.5, tile.height);
        tctx.stroke();
    }

    return tile;
}

function __getPatternFill(ctx) {
    const root = document.documentElement;
    const pattern = root.getAttribute("data-pattern") || "dot";
    const theme = root.getAttribute("data-theme") || "dark";
    const key = `${pattern}:${theme}`;

    if (!__patternCache.has(key)) {
        const tile = __makeTile(pattern, theme);
        const pat = ctx.createPattern(tile, "repeat");
        __patternCache.set(key, pat);
    }
    return __patternCache.get(key);
}

function __niceGridStep(worldStep, scale) {
    const minPx = 18;
    const maxPx = 70;

    let step = worldStep;
    let px = step * scale;

    while (px < minPx) { step *= 2; px = step * scale; }
    while (px > maxPx) { step /= 2; px = step * scale; }

    return step;
}

function __getGridStyle() {
    const root = document.documentElement;
    const theme = root.getAttribute("data-theme") || "dark";
    const pattern = root.getAttribute("data-pattern") || "dot";

    // The canvas preset owns the grid colours (static/js/canvas-theme.js).
    // The light/dark pair below is only the fallback if that file is missing.
    const preset = window.Inkyscib?.CanvasTheme?.grid?.();
    if (preset) {
        return { pattern, minor: preset.minor, major: preset.major, dot: preset.dot };
    }

    const isLight = theme === "light";

    const minor = isLight ? "rgba(0,0,0,0.10)" : "rgba(255,255,255,0.10)";
    const major = isLight ? "rgba(0,0,0,0.18)" : "rgba(255,255,255,0.18)";
    const dot   = isLight ? "rgba(0,0,0,0.16)" : "rgba(255,255,255,0.16)";

    return { pattern, minor, major, dot };
}

function __drawInfinitePattern(ctx, canvas) {
    const root = document.documentElement;
    const { pattern, minor, major, dot } = __getGridStyle();

    const { scale, offsetX, offsetY } = window.appState.transform;

    const ratio = __pixelRatio();
    const cssWidth = canvas.width / ratio;
    const cssHeight = canvas.height / ratio;

    const left   = (-offsetX) / scale;
    const top    = (-offsetY) / scale;
    const right  = (cssWidth - offsetX) / scale;
    const bottom = (cssHeight - offsetY) / scale;

    const baseWorld = 1;
    const step = __niceGridStep(baseWorld, scale);
    const majorEvery = 5;
    const majorStep = step * majorEvery;

    const worldLine = 1 / scale;

    const pad = step * 2;
    const L = left - pad, T = top - pad, R = right + pad, B = bottom + pad;

    ctx.save();

    if (pattern === "lines" || pattern === "graph") {
        ctx.lineCap = "butt";

        // One path per direction per line weight, rather than one path per
        // line. The grid is rebuilt on every frame of a pan, and at a dense
        // zoom level this was several hundred separate stroke calls each time.
        //
        // Horizontals and verticals stay in separate paths on purpose. These
        // lines are drawn at 10% alpha, so a crossing is two passes of ink and
        // reads darker than either line. Merging both directions into a single
        // path would stroke each crossing once and quietly lighten every
        // intersection on the graph grid.
        ctx.strokeStyle = minor;
        ctx.lineWidth = worldLine;

        ctx.beginPath();
        let y0 = Math.floor(T / step) * step;
        for (let y = y0; y <= B; y += step) {
            ctx.moveTo(L, y);
            ctx.lineTo(R, y);
        }
        ctx.stroke();

        if (pattern === "graph") {
            ctx.beginPath();
            let x0 = Math.floor(L / step) * step;
            for (let x = x0; x <= R; x += step) {
                ctx.moveTo(x, T);
                ctx.lineTo(x, B);
            }
            ctx.stroke();
        }

        ctx.strokeStyle = major;
        ctx.lineWidth = worldLine * 1.25;

        ctx.beginPath();
        let yM0 = Math.floor(T / majorStep) * majorStep;
        for (let y = yM0; y <= B; y += majorStep) {
            ctx.moveTo(L, y);
            ctx.lineTo(R, y);
        }
        ctx.stroke();

        if (pattern === "graph") {
            ctx.beginPath();
            let xM0 = Math.floor(L / majorStep) * majorStep;
            for (let x = xM0; x <= R; x += majorStep) {
                ctx.moveTo(x, T);
                ctx.lineTo(x, B);
            }
            ctx.stroke();
        }
    }

    if (pattern === "dot") {
        const dotStep = __niceGridStep(baseWorld, scale);
        const r = Math.max(0.6 / scale, 0.9 / scale);

        ctx.fillStyle = dot;

        let x0 = Math.floor(L / dotStep) * dotStep;
        let y0 = Math.floor(T / dotStep) * dotStep;

        // Every dot goes into one compound path filled once. `moveTo` before
        // each arc keeps the subpaths separate, so the rasterised result is
        // the same dots - it is only the per-dot call overhead that goes.
        ctx.beginPath();
        for (let y = y0; y <= B; y += dotStep) {
            for (let x = x0; x <= R; x += dotStep) {
                ctx.moveTo(x + r, y);
                ctx.arc(x, y, r, 0, Math.PI * 2);
            }
        }
        ctx.fill();
    }

    ctx.restore();
}

// Device pixels per CSS pixel. Applied when a context is transformed, so the
// rest of the pipeline keeps working in CSS-pixel coordinates.
function __pixelRatio() {
    return typeof window.getCanvasPixelRatio === 'function' ? window.getCanvasPixelRatio() : 1;
}

function __clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function __drawSmoothStroke(ctx, points, size, color) {
    if (!points || points.length === 0) return;

    ctx.strokeStyle = color;
    ctx.lineWidth = size;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);

    if (points.length === 1) {
        ctx.lineTo(points[0].x + 0.1, points[0].y + 0.1);
    } else if (points.length === 2) {
        ctx.lineTo(points[1].x, points[1].y);
    } else {
        for (let i = 1; i < points.length - 1; i++) {
            const midX = (points[i].x + points[i + 1].x) / 2;
            const midY = (points[i].y + points[i + 1].y) / 2;
            ctx.quadraticCurveTo(points[i].x, points[i].y, midX, midY);
        }
        ctx.lineTo(points[points.length - 1].x, points[points.length - 1].y);
    }

    ctx.stroke();
}

function __pointPressure(points, index) {
    const raw = points[index]?.pressure;
    return typeof raw === 'number' ? __clamp(raw, 0.05, 1) : 0.55;
}

function __segmentSpeed(points, index) {
    const a = points[index - 1];
    const b = points[index];
    if (!a || !b) return 0;

    const distance = Math.hypot(b.x - a.x, b.y - a.y);
    const dt = Math.max(8, (b.time || 0) - (a.time || 0) || 16);
    return distance / dt;
}

function __penSegmentWidth(style, baseSize, points, index) {
    const pressure = __pointPressure(points, index);
    const speed = __segmentSpeed(points, index);
    const previous = points[Math.max(0, index - 1)] || points[0];
    const current = points[Math.min(points.length - 1, index)] || previous;
    const dx = current.x - previous.x;
    const dy = current.y - previous.y;
    const distance = Math.hypot(dx, dy) || 1;
    const vertical = Math.abs(dy) / distance;
    const remaining = Math.max(0, points.length - 1 - index);

    if (style === 'brush') {
        const speedWeight = __clamp(1.58 - speed * 0.88, 0.42, 1.5);
        const pressureWeight = 0.42 + pressure * 1.95;
        const taper = Math.min(1, 0.18 + index / 3.5, 0.16 + remaining / 5);
        return Math.max(0.55, baseSize * pressureWeight * speedWeight * taper);
    }

    // A fountain nib opens on vertical/down strokes and becomes a hairline on
    // cross strokes. This remains visible with a mouse, where pressure is fixed.
    const nibAngleWeight = 0.42 + Math.pow(vertical, 0.72) * 1.32;
    const pressureWeight = 0.82 + pressure * 0.32;
    const speedWeight = __clamp(1.08 - speed * 0.18, 0.82, 1.08);
    const taper = Math.min(1, 0.35 + index / 3, 0.3 + remaining / 4);
    return Math.max(0.35, baseSize * nibAngleWeight * pressureWeight * speedWeight * taper);
}

// Minimum spacing, in device pixels, between the samples the brush and
// fountain rasterisers are asked to walk.
//
// This is a visual tradeoff, not a free win. These strokes are drawn with one
// round-capped `stroke()` per point, so denser samples overlap more caps and
// lay down a fractionally fatter, darker line; dropping samples thins it. The
// threshold was swept against an undecimated render of the same curve rather
// than picked by eye, measuring both the share of pixels whose inked/not-inked
// state flips and the share of total alpha lost:
//
//     spacing   brush px / alpha     fountain px / alpha
//       0.20      0.41% / 0.56%        0.52% / 1.06%
//       0.50      1.02% / 1.87%        1.64% / 3.59%
//       0.75      1.82% / 3.22%        2.36% / 4.96%
//       1.50      7.43% / 9.84%        4.34% / 7.87%
//
// 0.20 is the last row where both figures stay near or below half a percent
// for brush, which is well under anything visible in a stroke's weight. The
// cost climbs steeply after 0.5, so this is not a knob to raise for speed.
//
// Most of the benefit is not at scale 1 anyway - `appendInkPoint` already
// refuses samples closer than 0.12 world units, so a freshly drawn stroke has
// few to drop. It pays when the view is zoomed out, where the same stored
// stroke packs many samples into each device pixel, which is exactly when a
// rebuild has the most strokes to walk.
const __RENDER_MIN_SPACING = 0.20;
let __renderMinSpacing = __RENDER_MIN_SPACING;

// Test seam: lets the sweep above be reproduced, and 0 turns decimation off so
// a render can be compared against an undecimated one.
window.__inkyscibSetRenderMinSpacing = (value) => {
    __renderMinSpacing = Number.isFinite(value) && value >= 0
        ? value
        : __RENDER_MIN_SPACING;
    invalidateCanvasDrawingCache();
};

// Brush and fountain strokes are drawn with one `stroke()` per point, so a
// slow, deliberate stroke - which reports many samples inside the same pixel -
// costs far more than a fast one covering the same distance, and the same
// stroke costs more again when the view is zoomed out. Dropping samples closer
// together than a device pixel removes that work without moving the
// centreline: at this spacing the quadratic through the kept points passes
// within a fraction of a pixel of the dropped ones.
//
// This reads `path.points` but never writes it. The stored stroke keeps every
// sample, with its pressure and timestamp, for export, hit-testing and write
// assist; only the rasteriser sees the shorter list. The first and last points
// are always kept so the stroke starts and ends exactly where it was drawn.
function __decimateForRender(points, minDistance) {
    if (!(minDistance > 0) || points.length < 4) return points;

    const last = points[points.length - 1];
    const kept = [points[0]];
    let anchor = points[0];
    for (let index = 1; index < points.length - 1; index++) {
        const point = points[index];
        if (!point) continue;
        if (Math.hypot(point.x - anchor.x, point.y - anchor.y) < minDistance) continue;
        kept.push(point);
        anchor = point;
    }
    kept.push(last);
    // Collapsing a stroke to two points would change which branch of the
    // rasteriser runs, so keep the original when that is the outcome.
    return kept.length < 3 ? points : kept;
}

function __renderMinWorldSpacing(ctx) {
    if (typeof ctx.getTransform !== 'function') return 0;
    const deviceScale = Math.abs(ctx.getTransform().a);
    if (!Number.isFinite(deviceScale) || deviceScale <= 0) return 0;
    return __renderMinSpacing / deviceScale;
}

function __midpoint(a, b) {
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

// Draws part of a variable-width stroke: the loop segments in [loopFrom,
// loopTo), plus whichever end caps this span owns.
//
// Splitting on a loop index is exact rather than approximate. Segment i runs
// from the midpoint before points[i] to the midpoint after it, so two spans
// that meet at k cover the stroke with no overlap and no gap - which matters,
// because these nibs draw at globalAlpha 0.96 and a segment drawn twice would
// show as a darker band.
function __drawVariableSpan(ctx, points, style, baseSize, color, loopFrom, loopTo, drawHead, drawTail) {
    if (points.length === 0) return;

    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (points.length === 1) {
        if (!drawHead) return;
        const width = __penSegmentWidth(style, baseSize, points, 0);
        ctx.beginPath();
        ctx.arc(points[0].x, points[0].y, width / 2, 0, Math.PI * 2);
        ctx.fill();
        return;
    }

    const lastIndex = points.length - 1;

    // Use short connected curves instead of raw line segments. Round caps hide
    // width transitions while the quadratic centerline removes visible corners.
    if (drawHead) {
        const firstMidpoint = __midpoint(points[0], points[1]);
        ctx.lineWidth = __penSegmentWidth(style, baseSize, points, 1);
        ctx.beginPath();
        ctx.moveTo(points[0].x, points[0].y);
        ctx.lineTo(firstMidpoint.x, firstMidpoint.y);
        ctx.stroke();
    }

    const from = Math.max(1, loopFrom);
    const to = Math.min(loopTo, lastIndex);
    const midpoint = __midpoint;

    // Each segment blends the width at its own point with the width at the
    // next one, so consecutive iterations used to compute the same width
    // twice - once as `nextWidth`, then again as `currentWidth`. Carrying it
    // forward halves the number of __penSegmentWidth calls and produces the
    // identical stroke; the live stroke is re-rasterised on every pointer
    // frame, so this runs thousands of times a second while drawing.
    let currentWidth = from <= lastIndex
        ? __penSegmentWidth(style, baseSize, points, from)
        : 0;
    for (let i = from; i < to; i++) {
        const start = midpoint(points[i - 1], points[i]);
        const end = midpoint(points[i], points[i + 1]);
        const nextWidth = __penSegmentWidth(style, baseSize, points, i + 1);
        ctx.lineWidth = (currentWidth + nextWidth) / 2;
        currentWidth = nextWidth;
        ctx.beginPath();
        ctx.moveTo(start.x, start.y);
        ctx.quadraticCurveTo(points[i].x, points[i].y, end.x, end.y);
        ctx.stroke();
    }

    if (drawTail) {
        const lastMidpoint = midpoint(points[lastIndex - 1], points[lastIndex]);
        ctx.lineWidth = __penSegmentWidth(style, baseSize, points, lastIndex);
        ctx.beginPath();
        ctx.moveTo(lastMidpoint.x, lastMidpoint.y);
        ctx.lineTo(points[lastIndex].x, points[lastIndex].y);
        ctx.stroke();
    }
}

function __drawVariablePenStroke(ctx, path, style) {
    const rawPoints = path.points || [];
    if (rawPoints.length === 0) return;

    const points = __decimateForRender(rawPoints, __renderMinWorldSpacing(ctx));
    __drawVariableSpan(
        ctx, points, style,
        Math.max(0.5, path.size || 2),
        path.color || '#ffffff',
        1, points.length - 1, true, true
    );
}

// --- the live stroke's settled prefix ------------------------------------
//
// The stroke being drawn is re-rasterised on every pointer frame, so it costs
// more with every point added to it: linear per frame, quadratic over the
// whole stroke. Measured for a brush nib at a fixed on-screen extent: 0.2 ms
// at 125 points, 0.6 ms at 1000, 2.7 ms at 4000. That is comfortable on a
// desktop and is not on the budget tablet this product targets, where a long
// stroke would drop frames exactly as it got longest.
//
// This is EasiNote 5's DynamicRenderer idea in the only shape a canvas allows.
// It renders wet ink on a surface of its own so the settled ink is never
// redrawn; here the settled *part of the stroke* is rasterised once into its
// own bitmap, and each frame redraws only the last few points over it.
//
// The tail has to be long enough to cover everything that can still change.
// Two things can: `appendInkPoint` rewrites the final point in place when a
// sample lands closer than its minimum spacing, and `__decimateForRender`
// always forces the final point through, so the decimated array churns by an
// element or so at its end. Twelve points is far more than either needs.
const __WET_TAIL = 12;
// Below this a full redraw is already under a tenth of a millisecond, and the
// bitmap would cost more than it saves.
const __WET_MIN_POINTS = 96;
const __wetLayer = document.createElement('canvas');
const __wetLayerCtx = __wetLayer.getContext('2d', {
    alpha: true,
    desynchronized: true
});
let __wetMeta = null;

function __resetLiveStrokeCache() {
    __wetMeta = null;
}

function __variableNibStyle(path) {
    if (!path || path.tool !== 'pen') return null;
    const raw = path.penStyle || path.style || 'default';
    const style = raw === 'marker' ? 'calligraphy' : raw;
    return style === 'brush' || style === 'fountain' ? style : null;
}

function __liveStrokeCacheIsCurrent(path, style, canvas, transform, ratio) {
    const meta = __wetMeta;
    return !!meta &&
        meta.path === path &&
        meta.style === style &&
        meta.size === path.size &&
        meta.color === path.color &&
        meta.width === canvas.width &&
        meta.height === canvas.height &&
        meta.ratio === ratio &&
        __sameTransform(meta, transform);
}

// Returns true when it painted the stroke. False means it declined - the
// caller draws the whole thing the ordinary way.
function __drawLiveStroke(ctx, path, state, canvas, ratio) {
    const style = __variableNibStyle(path);
    if (!style || !__wetLayerCtx) return false;

    const rawPoints = path.points || [];
    if (rawPoints.length < __WET_MIN_POINTS) return false;

    const points = __decimateForRender(rawPoints, __renderMinWorldSpacing(ctx));
    const loopEnd = points.length - 1;
    const split = loopEnd - __WET_TAIL;
    if (split <= 1) return false;

    const transform = state.transform;
    if (!__liveStrokeCacheIsCurrent(path, style, canvas, transform, ratio) ||
        __wetMeta.cached > loopEnd) {
        if (__wetLayer.width !== canvas.width) __wetLayer.width = canvas.width;
        if (__wetLayer.height !== canvas.height) __wetLayer.height = canvas.height;
        __wetLayerCtx.setTransform(1, 0, 0, 1, 0, 0);
        __wetLayerCtx.clearRect(0, 0, __wetLayer.width, __wetLayer.height);
        __wetMeta = {
            path,
            style,
            size: path.size,
            color: path.color,
            width: canvas.width,
            height: canvas.height,
            ratio,
            scale: transform.scale,
            offsetX: transform.offsetX,
            offsetY: transform.offsetY,
            // The loop index the bitmap already covers. The head cap is drawn
            // with the first appended span, so this starts where the loop does.
            cached: 1
        };
    }

    const meta = __wetMeta;
    const baseSize = Math.max(0.5, path.size || 2);
    const color = path.color || '#ffffff';
    const alpha = style === 'brush' ? 0.96 : 1;

    if (split > meta.cached) {
        __wetLayerCtx.setTransform(
            transform.scale * ratio,
            0,
            0,
            transform.scale * ratio,
            transform.offsetX * ratio,
            transform.offsetY * ratio
        );
        __wetLayerCtx.setLineDash([]);
        __wetLayerCtx.globalCompositeOperation = 'source-over';
        __wetLayerCtx.globalAlpha = alpha;
        __drawVariableSpan(
            __wetLayerCtx, points, style, baseSize, color,
            meta.cached, split, meta.cached === 1, false
        );
        meta.cached = split;
    }

    // The bitmap is in device space, so it composites straight on at alpha 1 -
    // the nib's own alpha was already applied to each segment inside it.
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.drawImage(__wetLayer, 0, 0);
    ctx.restore();

    // The tail always resumes exactly where the bitmap stops, never at the
    // split, so a split that moves back a point cannot double-draw a segment
    // or leave a gap.
    ctx.save();
    ctx.setLineDash([]);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = alpha;
    __drawVariableSpan(
        ctx, points, style, baseSize, color,
        meta.cached, loopEnd, false, true
    );
    ctx.restore();
    return true;
}

// The live stroke is drawn through to the newest sample, which events.js keeps
// on `__inkInput.tip` (display only), so the ink on screen reaches the nib
// rather than trailing the live filter. The finished stroke is rebuilt on lift
// and never contains this segment. Gel and calligraphy draw in passes a single
// segment cannot match, so they keep their stored end.
function __drawInkTip(ctx, path) {
    const tip = path?.tool === 'pen' ? path.__inkInput?.tip : null;
    const points = path?.points;
    if (!tip || !points || points.length === 0) return;
    const last = points[points.length - 1];
    if (Math.hypot(tip.x - last.x, tip.y - last.y) < 0.05) return;
    const style = path.penStyle || path.style || 'default';
    if (style !== 'default' && style !== 'brush' && style !== 'fountain') return;

    const baseSize = Math.max(0.5, path.size || 2);
    ctx.save();
    ctx.setLineDash([]);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = style === 'brush' ? 0.96 : 1;
    ctx.strokeStyle = path.color || '#ffffff';
    ctx.lineWidth = style === 'default'
        ? baseSize
        : __penSegmentWidth(style, baseSize, points, points.length - 1);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(last.x, last.y);
    ctx.lineTo(tip.x, tip.y);
    ctx.stroke();
    ctx.restore();
}

function __drawCalligraphyPenStroke(ctx, path) {
    const points = (path.points || []).filter(Boolean);
    const color = path.color || '#ffffff';
    const baseSize = Math.max(0.5, path.size || 2);
    const calligraphySize = Math.min(baseSize, 6 + Math.sqrt(baseSize) * 2.2);
    if (points.length === 0) return;

    if (points.length === 1) {
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.ellipse(points[0].x, points[0].y, calligraphySize * 1.2, calligraphySize * 0.35, -Math.PI / 4, 0, Math.PI * 2);
        ctx.fill();
        return;
    }

    const hairlineWidth = Math.max(0.45, Math.min(2.2, calligraphySize * 0.085));
    const shadeWidth = Math.max(hairlineWidth * 8, Math.min(56, calligraphySize * 1.85));

    function lerp(a, b, t) {
        return a + (b - a) * t;
    }

    function smoothstep(edge0, edge1, value) {
        const t = __clamp((value - edge0) / (edge1 - edge0), 0, 1);
        return t * t * (3 - 2 * t);
    }

    function catmull(p0, p1, p2, p3, t) {
        const t2 = t * t;
        const t3 = t2 * t;
        return {
            x: 0.5 * (
                (2 * p1.x) +
                (-p0.x + p2.x) * t +
                (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
                (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3
            ),
            y: 0.5 * (
                (2 * p1.y) +
                (-p0.y + p2.y) * t +
                (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
                (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3
            ),
            pressure: lerp(p1.pressure ?? 0.55, p2.pressure ?? 0.55, t)
        };
    }

    function smoothPoints(rawPoints) {
        const output = [];

        for (let i = 0; i < rawPoints.length - 1; i++) {
            const p0 = rawPoints[Math.max(0, i - 1)];
            const p1 = rawPoints[i];
            const p2 = rawPoints[i + 1];
            const p3 = rawPoints[Math.min(rawPoints.length - 1, i + 2)];
            const distance = Math.hypot(p2.x - p1.x, p2.y - p1.y);
            const steps = Math.max(4, Math.ceil(distance / 2));

            for (let step = 0; step < steps; step++) {
                output.push(catmull(p0, p1, p2, p3, step / steps));
            }
        }

        output.push({
            x: rawPoints[rawPoints.length - 1].x,
            y: rawPoints[rawPoints.length - 1].y,
            pressure: rawPoints[rawPoints.length - 1].pressure ?? 0.55
        });

        return output;
    }

    function averagePoint(a, b, c) {
        return {
            x: (a.x + b.x * 2 + c.x) / 4,
            y: (a.y + b.y * 2 + c.y) / 4,
            pressure: (a.pressure + b.pressure * 2 + c.pressure) / 4
        };
    }

    function soften(samples) {
        if (samples.length < 5) return samples;
        const softened = [samples[0]];

        for (let i = 1; i < samples.length - 1; i++) {
            softened.push(averagePoint(samples[i - 1], samples[i], samples[i + 1]));
        }

        softened.push(samples[samples.length - 1]);
        return softened;
    }

    let samples = smoothPoints(points);
    samples = soften(soften(samples));

    if (samples.length < 2) return;

    function sampleTangent(i) {
        const prev = samples[Math.max(0, i - 1)];
        const next = samples[Math.min(samples.length - 1, i + 1)];
        const dx = next.x - prev.x;
        const dy = next.y - prev.y;
        const length = Math.hypot(dx, dy) || 1;
        return { x: dx / length, y: dy / length };
    }

    function sampleWidth(i) {
        const current = samples[i];
        const tangent = sampleTangent(i);
        const pressure = __clamp(current.pressure ?? 0.55, 0.18, 1);
        const prevTangent = sampleTangent(Math.max(0, i - 3));
        const nextTangent = sampleTangent(Math.min(samples.length - 1, i + 3));
        const turn = Math.abs(prevTangent.x * nextTangent.y - prevTangent.y * nextTangent.x);

        const downstroke = smoothstep(-0.03, 0.7, tangent.y);
        const verticalBias = smoothstep(0.1, 0.78, Math.abs(tangent.y));
        const directionShade = Math.pow(downstroke * verticalBias, 1.06);
        const curveLift = 1 + Math.min(0.24, turn * 0.36);
        const edgeTaper = Math.min(1, i / 16, (samples.length - 1 - i) / 16);
        const softTaper = 0.16 + edgeTaper * 0.84;
        const pressureScale = 0.82 + pressure * 0.26;

        return hairlineWidth + (shadeWidth - hairlineWidth) * directionShade * curveLift * softTaper * pressureScale;
    }

    let widths = samples.map((_, i) => sampleWidth(i));
    for (let pass = 0; pass < 3; pass++) {
        widths = widths.map((width, i) => {
            const prev = widths[Math.max(0, i - 1)];
            const next = widths[Math.min(widths.length - 1, i + 1)];
            return (prev + width * 2 + next) / 4;
        });
    }

    function sampleNormal(i) {
        const tangent = sampleTangent(i);
        return { x: -tangent.y, y: tangent.x };
    }

    function drawCenterSpline(startIndex, endIndex) {
        if (endIndex - startIndex < 1) return;

        ctx.beginPath();
        ctx.moveTo(samples[startIndex].x, samples[startIndex].y);

        for (let i = startIndex + 1; i < endIndex; i++) {
            const midX = (samples[i].x + samples[i + 1].x) / 2;
            const midY = (samples[i].y + samples[i + 1].y) / 2;
            ctx.quadraticCurveTo(samples[i].x, samples[i].y, midX, midY);
        }

        ctx.lineTo(samples[endIndex].x, samples[endIndex].y);
        ctx.stroke();
    }

    function drawShadeRun(startIndex, endIndex) {
        if (endIndex - startIndex < 2) return;

        const runLength = endIndex - startIndex;
        const taperSamples = Math.max(10, Math.min(28, Math.floor(runLength * 0.45)));

        function taperedWidthAt(i) {
            const rawWidth = Number.isFinite(widths[i]) ? widths[i] : hairlineWidth;
            const runFade = Math.min(
                1,
                Math.max(0, (i - startIndex + 1) / taperSamples),
                Math.max(0, (endIndex - i + 1) / taperSamples)
            );
            return hairlineWidth + (rawWidth - hairlineWidth) * smoothstep(0, 1, runFade);
        }

        ctx.fillStyle = color;

        for (let i = startIndex + 1; i <= endIndex; i++) {
            const prev = samples[i - 1];
            const current = samples[i];
            const prevWidth = taperedWidthAt(i - 1);
            const currentWidth = taperedWidthAt(i);
            if (!Number.isFinite(prevWidth + currentWidth) || Math.max(prevWidth, currentWidth) <= hairlineWidth * 1.55) continue;

            const dx = current.x - prev.x;
            const dy = current.y - prev.y;
            const segmentLength = Math.hypot(dx, dy) || 1;
            const overlap = Math.max(1.2, Math.min(3.5, Math.max(prevWidth, currentWidth) * 0.08));
            const startX = prev.x - (dx / segmentLength) * overlap;
            const startY = prev.y - (dy / segmentLength) * overlap;
            const endX = current.x + (dx / segmentLength) * overlap;
            const endY = current.y + (dy / segmentLength) * overlap;
            const prevNormal = sampleNormal(i - 1);
            const currentNormal = sampleNormal(i);
            const prevHalf = Math.max(hairlineWidth * 0.45, prevWidth / 2);
            const currentHalf = Math.max(hairlineWidth * 0.45, currentWidth / 2);

            ctx.beginPath();
            ctx.moveTo(startX + prevNormal.x * prevHalf, startY + prevNormal.y * prevHalf);
            ctx.lineTo(endX + currentNormal.x * currentHalf, endY + currentNormal.y * currentHalf);
            ctx.lineTo(endX - currentNormal.x * currentHalf, endY - currentNormal.y * currentHalf);
            ctx.lineTo(startX - prevNormal.x * prevHalf, startY - prevNormal.y * prevHalf);
            ctx.closePath();
            ctx.fill();
        }
    }

    ctx.strokeStyle = color;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = hairlineWidth;
    drawCenterSpline(0, samples.length - 1);

    const shadeThreshold = hairlineWidth + (shadeWidth - hairlineWidth) * 0.06;
    let runStart = null;

    for (let i = 0; i < samples.length; i++) {
        const isShaded = Number.isFinite(widths[i]) && widths[i] > shadeThreshold;

        if (isShaded && runStart === null) {
            runStart = i;
        } else if (!isShaded && runStart !== null) {
            drawShadeRun(runStart, i - 1);
            runStart = null;
        }
    }

    if (runStart !== null) {
        drawShadeRun(runStart, samples.length - 1);
    }
}

function __drawPenPath(ctx, path) {
    const points = path.points || [];
    const color = path.color || '#ffffff';
    const baseSize = Math.max(0.5, path.size || 2);
    const rawStyle = path.penStyle || path.style || 'default';
    const style = rawStyle === 'marker' ? 'calligraphy' : rawStyle;

    ctx.save();
    ctx.setLineDash([]);
    ctx.globalCompositeOperation = 'source-over';

    if (style === 'calligraphy') {
        ctx.globalAlpha = 1;
        __drawCalligraphyPenStroke(ctx, path);
        ctx.restore();
        return;
    }

    if (style === 'brush' || style === 'fountain') {
        ctx.globalAlpha = style === 'brush' ? 0.96 : 1;
        __drawVariablePenStroke(ctx, path, style);
        ctx.restore();
        return;
    }

    if (style === 'gel') {
        // Gel ink is dense, rounded and slightly luminous instead of behaving
        // like another fineliner. Keep the glow restrained at large sizes.
        ctx.globalAlpha = 0.42;
        ctx.shadowColor = color;
        ctx.shadowBlur = Math.max(1.2, Math.min(7, baseSize * 0.72));
        __drawSmoothStroke(ctx, points, baseSize * 1.72, color);
        ctx.globalAlpha = 1;
        ctx.shadowBlur = 0;
        __drawSmoothStroke(ctx, points, baseSize * 1.34, color);
        ctx.restore();
        return;
    }

    __drawSmoothStroke(ctx, points, baseSize, color);
    ctx.restore();
}

function __isFinitePoint(point) {
    return point && Number.isFinite(point.x) && Number.isFinite(point.y);
}

function __clonePoint(point) {
    const cloned = { x: point.x, y: point.y };
    if (Number.isFinite(point.pressure)) cloned.pressure = point.pressure;
    if (Number.isFinite(point.time)) cloned.time = point.time;
    return cloned;
}

function __cloneEraserCut(eraser) {
    return {
        tool: 'eraser',
        size: Math.max(1, eraser?.size || 20),
        timestamp: eraser?.timestamp || Date.now(),
        points: (eraser?.points || []).filter(__isFinitePoint).map(__clonePoint)
    };
}

function __boundsFromPoints(points, padding = 0) {
    const valid = (points || []).filter(__isFinitePoint);
    if (!valid.length) return null;

    let left = valid[0].x;
    let right = valid[0].x;
    let top = valid[0].y;
    let bottom = valid[0].y;

    valid.forEach((point) => {
        left = Math.min(left, point.x);
        right = Math.max(right, point.x);
        top = Math.min(top, point.y);
        bottom = Math.max(bottom, point.y);
    });

    return {
        left: left - padding,
        right: right + padding,
        top: top - padding,
        bottom: bottom + padding,
        width: right - left + padding * 2,
        height: bottom - top + padding * 2,
        center: {
            x: (left + right) / 2,
            y: (top + bottom) / 2
        }
    };
}

function __unionBounds(boundsList) {
    const valid = (boundsList || []).filter(Boolean);
    if (!valid.length) return null;

    const left = Math.min(...valid.map((bounds) => bounds.left));
    const right = Math.max(...valid.map((bounds) => bounds.right));
    const top = Math.min(...valid.map((bounds) => bounds.top));
    const bottom = Math.max(...valid.map((bounds) => bounds.bottom));

    return {
        left,
        right,
        top,
        bottom,
        width: right - left,
        height: bottom - top,
        center: {
            x: (left + right) / 2,
            y: (top + bottom) / 2
        }
    };
}

function __expandBounds(bounds, padding) {
    if (!bounds) return null;
    return {
        left: bounds.left - padding,
        right: bounds.right + padding,
        top: bounds.top - padding,
        bottom: bounds.bottom + padding,
        width: bounds.width + padding * 2,
        height: bounds.height + padding * 2,
        center: bounds.center
    };
}

function __boundsIntersect(a, b) {
    return !!a && !!b &&
        a.left <= b.right &&
        a.right >= b.left &&
        a.top <= b.bottom &&
        a.bottom >= b.top;
}

function __pointLineDistance(point, a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    if (!len2) return Math.hypot(point.x - a.x, point.y - a.y);
    const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / len2));
    const px = a.x + dx * t;
    const py = a.y + dy * t;
    return Math.hypot(point.x - px, point.y - py);
}

function __pointOnSegment(point, a, b) {
    return point.x <= Math.max(a.x, b.x) + 0.001 &&
        point.x >= Math.min(a.x, b.x) - 0.001 &&
        point.y <= Math.max(a.y, b.y) + 0.001 &&
        point.y >= Math.min(a.y, b.y) - 0.001;
}

function __orientation(a, b, c) {
    const value = (b.y - a.y) * (c.x - b.x) - (b.x - a.x) * (c.y - b.y);
    if (Math.abs(value) < 0.001) return 0;
    return value > 0 ? 1 : 2;
}

function __segmentsIntersect(a, b, c, d) {
    const o1 = __orientation(a, b, c);
    const o2 = __orientation(a, b, d);
    const o3 = __orientation(c, d, a);
    const o4 = __orientation(c, d, b);

    if (o1 !== o2 && o3 !== o4) return true;
    if (o1 === 0 && __pointOnSegment(c, a, b)) return true;
    if (o2 === 0 && __pointOnSegment(d, a, b)) return true;
    if (o3 === 0 && __pointOnSegment(a, c, d)) return true;
    if (o4 === 0 && __pointOnSegment(b, c, d)) return true;
    return false;
}

function __segmentDistance(a, b, c, d) {
    if (__segmentsIntersect(a, b, c, d)) return 0;
    return Math.min(
        __pointLineDistance(a, c, d),
        __pointLineDistance(b, c, d),
        __pointLineDistance(c, a, b),
        __pointLineDistance(d, a, b)
    );
}

function __strokeDistance(point, path) {
    const points = (path?.points || []).filter(__isFinitePoint);
    if (!points.length) return Infinity;
    if (points.length === 1) return Math.hypot(point.x - points[0].x, point.y - points[0].y);

    let min = Infinity;
    for (let i = 1; i < points.length; i++) {
        min = Math.min(min, __pointLineDistance(point, points[i - 1], points[i]));
    }
    return min;
}

function __segmentTouchesEraser(a, b, eraser, threshold) {
    const eraserPoints = (eraser?.points || []).filter(__isFinitePoint);
    if (!eraserPoints.length) return false;
    if (eraserPoints.length === 1) return __pointLineDistance(eraserPoints[0], a, b) <= threshold;

    for (let i = 1; i < eraserPoints.length; i++) {
        if (__segmentDistance(a, b, eraserPoints[i - 1], eraserPoints[i]) <= threshold) {
            return true;
        }
    }

    return false;
}

function __rawPathBounds(path) {
    if (!path) return null;
    const geometryBounds = window.Inkyscib?.Geometry?.pathBounds;
    if (typeof geometryBounds === 'function') {
        const sourcePath = path.componentPoints ? { ...path, componentPoints: null, componentBounds: null } : path;
        const bounds = geometryBounds(sourcePath);
        if (bounds) return bounds;
    }
    return __boundsFromPoints(path.points || [], Math.max(4, (path.size || 2) / 2));
}

function __pathBounds(path) {
    if (path?.componentBounds &&
        Number.isFinite(path.componentBounds.left) &&
        Number.isFinite(path.componentBounds.right) &&
        Number.isFinite(path.componentBounds.top) &&
        Number.isFinite(path.componentBounds.bottom)) {
        const bounds = path.componentBounds;
        return {
            left: bounds.left,
            right: bounds.right,
            top: bounds.top,
            bottom: bounds.bottom,
            width: bounds.right - bounds.left,
            height: bounds.bottom - bounds.top,
            center: {
                x: (bounds.left + bounds.right) / 2,
                y: (bounds.top + bounds.bottom) / 2
            }
        };
    }
    return __rawPathBounds(path);
}

function __pathCanReceiveEraser(path) {
    return path && ['pen', 'highlight', 'line', 'shape', 'manipulative'].includes(path.tool) &&
        Array.isArray(path.points) && path.points.length > 0;
}

function __eraserThreshold(path, eraser) {
    const strokeRadius = Math.max(0.25, (path?.size || 2) / 2);
    const eraserRadius = Math.max(0.5, (eraser?.size || 20) / 2);
    return strokeRadius + eraserRadius;
}

function __eraserAffectsPath(path, eraser, eraserBounds = null) {
    if (!__pathCanReceiveEraser(path)) return false;

    const targetBounds = __pathBounds(path);
    const maskBounds = eraserBounds || __pathBounds(eraser);
    if (!__boundsIntersect(targetBounds, maskBounds)) return false;

    const tolerance = __eraserThreshold(path, eraser);

    if (path.tool === 'pen' || path.tool === 'highlight' || path.tool === 'line') {
        const pathPoints = (path.points || []).filter(__isFinitePoint);
        const eraserPoints = (eraser.points || []).filter(__isFinitePoint);
        return pathPoints.some((point) => __strokeDistance(point, eraser) <= tolerance) ||
            eraserPoints.some((point) => __strokeDistance(point, path) <= tolerance) ||
            pathPoints.some((point, index) => index > 0 && __segmentTouchesEraser(pathPoints[index - 1], point, eraser, tolerance));
    }

    if (path.tool === 'shape' || path.tool === 'manipulative') {
        const geometry = window.Inkyscib?.Geometry;
        const shapePoints = path.tool === 'manipulative'
            ? (path.points || []).filter(__isFinitePoint)
            : (typeof geometry?.shapeDisplayPoints === 'function' ? geometry.shapeDisplayPoints(path) : []);
        const eraserPoints = (eraser.points || []).filter(__isFinitePoint);
        if (shapePoints.length >= 2 && typeof geometry?.polygonEdgeDistance === 'function') {
            return shapePoints.some((point) => __strokeDistance(point, eraser) <= tolerance) ||
                eraserPoints.some((point) => geometry.polygonEdgeDistance(point, shapePoints) <= tolerance);
        }
    }

    return true;
}

function __appendCenterlinePoint(points, point) {
    const last = points[points.length - 1];
    if (!last || Math.hypot(last.x - point.x, last.y - point.y) > 0.05) {
        points.push({ x: point.x, y: point.y });
    }
}

function __sampleLinearSegment(output, a, b, spacing) {
    const distance = Math.hypot(b.x - a.x, b.y - a.y);
    const steps = Math.max(1, Math.ceil(distance / spacing));
    for (let step = 1; step <= steps; step++) {
        const t = step / steps;
        __appendCenterlinePoint(output, {
            x: a.x + (b.x - a.x) * t,
            y: a.y + (b.y - a.y) * t
        });
    }
}

function __sampleQuadraticSegment(output, start, control, end, spacing) {
    const estimate = Math.hypot(control.x - start.x, control.y - start.y) +
        Math.hypot(end.x - control.x, end.y - control.y);
    const steps = Math.max(2, Math.ceil(estimate / spacing));
    for (let step = 1; step <= steps; step++) {
        const t = step / steps;
        const u = 1 - t;
        __appendCenterlinePoint(output, {
            x: u * u * start.x + 2 * u * t * control.x + t * t * end.x,
            y: u * u * start.y + 2 * u * t * control.y + t * t * end.y
        });
    }
}

function __samplePathCenterline(path) {
    const existing = (path?.componentPoints || []).filter(__isFinitePoint);
    if (existing.length) return existing.map(__clonePoint);

    const points = (path?.points || []).filter(__isFinitePoint);
    if (!points.length) return [];
    if (points.length === 1) return [__clonePoint(points[0])];

    const spacing = 1.25;
    const output = [{ x: points[0].x, y: points[0].y }];
    const penStyle = path.penStyle || path.style || 'default';
    const useLinear = path.tool === 'line' ||
        (path.tool === 'pen' && (penStyle === 'brush' || penStyle === 'fountain'));

    if (useLinear || points.length === 2) {
        for (let index = 1; index < points.length; index++) {
            __sampleLinearSegment(output, points[index - 1], points[index], spacing);
        }
        return output;
    }

    let start = points[0];
    for (let index = 1; index < points.length - 1; index++) {
        const end = {
            x: (points[index].x + points[index + 1].x) / 2,
            y: (points[index].y + points[index + 1].y) / 2
        };
        __sampleQuadraticSegment(output, start, points[index], end, spacing);
        start = end;
    }
    __sampleLinearSegment(output, start, points[points.length - 1], spacing);
    return output;
}

function __centerlinePointErased(point, erasers) {
    return (erasers || []).some((eraser) => (
        __strokeDistance(point, eraser) <= Math.max(0.5, (eraser.size || 20) / 2)
    ));
}

function __componentClipWidth(path) {
    const size = Math.max(0.5, path?.size || 2);
    const style = path?.penStyle || path?.style || 'default';
    if (style === 'brush') return size * 3.2 + 6;
    if (style === 'gel') return size * 2.8 + 8;
    if (style === 'fountain') return size * 2.1 + 6;
    if (style === 'calligraphy' || style === 'marker') return Math.max(16, Math.min(64, size * 2.2 + 8));
    return size * 1.2 + 6;
}

function __componentBounds(path, points) {
    return __boundsFromPoints(points, __componentClipWidth(path) / 2);
}

function __visibleCenterlineComponents(path) {
    const samples = __samplePathCenterline(path);
    if (!samples.length) return [];

    const components = [];
    let active = [];
    samples.forEach((point) => {
        if (__centerlinePointErased(point, path.erasers)) {
            if (active.length) components.push(active);
            active = [];
            return;
        }
        __appendCenterlinePoint(active, point);
    });
    if (active.length) components.push(active);

    return components.filter((points) => points.length > 0);
}

function __splitPathIntoVisibleComponents(path) {
    if (!['pen', 'highlight', 'line'].includes(path?.tool)) {
        return [path];
    }

    const components = __visibleCenterlineComponents(path);
    if (!components.length) return [];

    return components.map((componentPoints) => ({
        ...path,
        componentPoints,
        componentBounds: __componentBounds(path, componentPoints)
    }));
}

function __erasePathWithEraser(path, eraser) {
    if (!__eraserAffectsPath(path, eraser)) return { changed: false, replacements: [path] };

    const maskedPath = {
        ...path,
        erasers: [
            ...((path.erasers || []).map(__cloneEraserCut)),
            __cloneEraserCut(eraser)
        ]
    };
    return { changed: true, replacements: __splitPathIntoVisibleComponents(maskedPath) };
}

function __applyEraserToPaths(paths, eraserPath) {
    if (!Array.isArray(paths) || !eraserPath || eraserPath.tool !== 'eraser') return false;

    const eraser = __cloneEraserCut(eraserPath);
    if (eraser.points.length === 0) return false;

    let changed = false;

    for (let index = paths.length - 1; index >= 0; index--) {
        const result = __erasePathWithEraser(paths[index], eraser);
        if (!result.changed) continue;
        paths.splice(index, 1, ...result.replacements);
        changed = true;
    }

    return changed;
}

// Stroke eraser: remove each touched object as one unit. This complements the
// default partial eraser, which cuts ink precisely, and also works for
// construction objects that cannot sensibly be split into raster fragments.
function __eraseObjectsTouched(paths, eraserPath) {
    if (!Array.isArray(paths) || !eraserPath) return false;
    const indices = window.Inkyscib?.Selection?.indicesTouchedByStroke?.(eraserPath) || [];
    if (!indices.length) return false;
    indices.slice().sort((a, b) => b - a).forEach((index) => paths.splice(index, 1));
    return true;
}

function __bakeStandaloneErasersIntoPaths(paths) {
    if (!Array.isArray(paths)) return false;

    let changed = false;
    const baked = [];

    paths.forEach((path) => {
        if (path?.tool === 'eraser') {
            __applyEraserToPaths(baked, path);
            changed = true;
        } else if (Array.isArray(path?.erasers) && path.erasers.length > 0 && !Array.isArray(path.componentPoints)) {
            baked.push(...__splitPathIntoVisibleComponents(path));
            changed = true;
        } else {
            baked.push(path);
        }
    });

    if (changed) {
        paths.splice(0, paths.length, ...baked);
    }

    return changed;
}

function __pathRenderBounds(path) {
    if (path?.componentBounds) {
        return __expandBounds(__pathBounds(path), Math.max(4, (path.size || 2) / 2));
    }
    const bounds = __unionBounds([
        __pathBounds(path),
        ...((path.erasers || []).map(__pathBounds))
    ]);
    return __expandBounds(bounds, Math.max(8, (path.size || 2) * 2));
}

function __formatVideoTime(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    return hours > 0
        ? `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
        : `${minutes}:${String(secs).padStart(2, '0')}`;
}

function __roundedRectPath(ctx, x, y, width, height, radius) {
    const safeRadius = Math.max(0, Math.min(radius, width / 2, height / 2));
    if (typeof ctx.roundRect === 'function') {
        ctx.roundRect(x, y, width, height, safeRadius);
        return;
    }
    ctx.moveTo(x + safeRadius, y);
    ctx.arcTo(x + width, y, x + width, y + height, safeRadius);
    ctx.arcTo(x + width, y + height, x, y + height, safeRadius);
    ctx.arcTo(x, y + height, x, y, safeRadius);
    ctx.arcTo(x, y, x + width, y, safeRadius);
    ctx.closePath();
}

function __cachedMediaImage(source) {
    if (!source || typeof source !== 'string') return null;
    let record = __mediaImageCache.get(source);
    if (record) return record;

    if (__mediaImageCache.size >= __mediaImageCacheLimit) {
        const oldest = __mediaImageCache.keys().next().value;
        if (oldest) __mediaImageCache.delete(oldest);
    }

    const image = new Image();
    record = { image, ready: false, failed: false };
    __mediaImageCache.set(source, record);
    image.onload = () => {
        record.ready = true;
        invalidateCanvasDrawingCache();
        if (typeof window.render === 'function') window.render();
    };
    image.onerror = () => {
        record.failed = true;
        invalidateCanvasDrawingCache();
        if (typeof window.render === 'function') window.render();
    };
    image.src = source;
    return record;
}

function __drawImageContained(ctx, image, left, top, width, height) {
    const sourceWidth = image.naturalWidth || image.width || 0;
    const sourceHeight = image.naturalHeight || image.height || 0;
    if (sourceWidth <= 0 || sourceHeight <= 0) return;

    const scale = Math.min(width / sourceWidth, height / sourceHeight);
    const drawWidth = sourceWidth * scale;
    const drawHeight = sourceHeight * scale;
    const drawX = left + (width - drawWidth) / 2;
    const drawY = top + (height - drawHeight) / 2;
    ctx.drawImage(image, drawX, drawY, drawWidth, drawHeight);
}

// ---------- edits on a picture (static/js/image-tools.js) ----------
//
// A frame or an inserted picture can carry `edit`: a crop (fractions of the
// source), a quarter-turn rotation, flips, CSS-style filters and an opacity.
// The source pixels are never touched; this draws the edit every time, so
// Reset is always lossless and PDF export, which renders through here, shows
// exactly what the canvas shows.

function __mediaEdit(path) {
    const edit = path && path.edit;
    return edit && typeof edit === 'object' ? edit : null;
}

function __mediaFilter(edit) {
    if (!edit) return 'none';
    const parts = [];
    const num = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
    const add = (name, value, neutral, unit = '') => {
        const v = num(value, neutral);
        if (Math.abs(v - neutral) > 0.001) parts.push(`${name}(${v}${unit})`);
    };
    // Invert first, so "board to paper" turns chalk dark before the contrast.
    add('invert', edit.invert, 0);
    add('grayscale', edit.grayscale, 0);
    add('sepia', edit.sepia, 0);
    add('brightness', edit.brightness, 1);
    add('contrast', edit.contrast, 1);
    add('saturate', edit.saturate, 1);
    return parts.length ? parts.join(' ') : 'none';
}

function __drawMediaImage(ctx, image, left, top, width, height, edit) {
    const sourceWidth = image.naturalWidth || image.width || 0;
    const sourceHeight = image.naturalHeight || image.height || 0;
    if (sourceWidth <= 0 || sourceHeight <= 0) return;
    if (!edit) {
        __drawImageContained(ctx, image, left, top, width, height);
        return;
    }

    const raw = edit.crop || {};
    const cx = Math.max(0, Math.min(0.98, Number(raw.x) || 0));
    const cy = Math.max(0, Math.min(0.98, Number(raw.y) || 0));
    const cw = Math.max(0.02, Math.min(1 - cx, Number.isFinite(Number(raw.w)) ? Number(raw.w) : 1));
    const ch = Math.max(0.02, Math.min(1 - cy, Number.isFinite(Number(raw.h)) ? Number(raw.h) : 1));
    const sx = cx * sourceWidth;
    const sy = cy * sourceHeight;
    const sw = cw * sourceWidth;
    const sh = ch * sourceHeight;

    const rotation = (((Number(edit.rotate) || 0) % 360) + 360) % 360;
    const quarter = rotation === 90 || rotation === 270;
    const fitWidth = quarter ? height : width;
    const fitHeight = quarter ? width : height;
    const scale = Math.min(fitWidth / sw, fitHeight / sh);
    const drawWidth = sw * scale;
    const drawHeight = sh * scale;

    ctx.save();
    ctx.translate(left + width / 2, top + height / 2);
    if (rotation) ctx.rotate((rotation * Math.PI) / 180);
    ctx.scale(edit.flipX ? -1 : 1, edit.flipY ? -1 : 1);
    const filter = __mediaFilter(edit);
    if (filter !== 'none' && 'filter' in ctx) ctx.filter = filter;
    if (Number.isFinite(Number(edit.opacity))) {
        ctx.globalAlpha *= Math.max(0.05, Math.min(1, Number(edit.opacity)));
    }
    ctx.drawImage(image, sx, sy, sw, sh, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight);
    ctx.restore();
}

window.Inkyscib = window.Inkyscib || {};
window.Inkyscib.MediaDraw = { draw: __drawMediaImage, filter: __mediaFilter };

// An inserted picture: the same two-corner geometry a captured video moment
// uses, without the badge and play button painted over it.
function __drawInsertedImage(ctx, path) {
    const points = (path?.points || []).filter(__isFinitePoint);
    if (points.length < 2) return;

    const left = Math.min(points[0].x, points[1].x);
    const right = Math.max(points[0].x, points[1].x);
    const top = Math.min(points[0].y, points[1].y);
    const bottom = Math.max(points[0].y, points[1].y);
    const width = right - left;
    const height = bottom - top;
    if (width < 0.5 || height < 0.5) return;

    const radius = Math.min(10, width * 0.03, height * 0.03);
    const media = __cachedMediaImage(path.image);

    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.beginPath();
    __roundedRectPath(ctx, left, top, width, height, radius);
    ctx.clip();

    if (media?.ready) {
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        __drawMediaImage(ctx, media.image, left, top, width, height, __mediaEdit(path));
    } else {
        // Still decoding, or the data URL is gone: a quiet placeholder rather
        // than a hole in the page.
        const isLight = (document.documentElement.dataset.theme || 'dark') === 'light';
        ctx.fillStyle = isLight ? 'rgba(15, 23, 42, 0.06)' : 'rgba(255, 255, 255, 0.06)';
        ctx.fillRect(left, top, width, height);
    }

    ctx.restore();
}

function __drawYoutubeFrame(ctx, path) {
    const points = (path?.points || []).filter(__isFinitePoint);
    if (points.length < 2) return;

    const left = Math.min(points[0].x, points[1].x);
    const right = Math.max(points[0].x, points[1].x);
    const top = Math.min(points[0].y, points[1].y);
    const bottom = Math.max(points[0].y, points[1].y);
    const width = right - left;
    const height = bottom - top;
    if (width < 0.5 || height < 0.5) return;

    const radius = Math.min(12, width * 0.035, height * 0.07);
    const media = __cachedMediaImage(path.image);
    const isLight = (document.documentElement.dataset.theme || 'dark') === 'light';

    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.beginPath();
    __roundedRectPath(ctx, left, top, width, height, radius);
    ctx.clip();

    const edit = __mediaEdit(path);
    const backdrop = edit?.backdrop || 'auto';
    if (backdrop !== 'none') {
        ctx.fillStyle = backdrop === 'paper' ? '#ffffff'
            : backdrop === 'ink' ? '#111111'
            : (isLight ? '#e8e8eb' : '#12141b');
        ctx.fillRect(left, top, width, height);
    }
    if (media?.ready) {
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        // Never stretch legacy or malformed media bounds. Current captures are
        // aspect-locked, while this remains a safe fallback for older drawings.
        __drawMediaImage(ctx, media.image, left, top, width, height, edit);
    } else {
        const stripeWidth = Math.max(10, width / 12);
        ctx.fillStyle = isLight ? 'rgba(0,0,0,0.045)' : 'rgba(255,255,255,0.045)';
        for (let x = left - height; x < right + height; x += stripeWidth * 2) {
            ctx.beginPath();
            ctx.moveTo(x, bottom);
            ctx.lineTo(x + stripeWidth, bottom);
            ctx.lineTo(x + height + stripeWidth, top);
            ctx.lineTo(x + height, top);
            ctx.closePath();
            ctx.fill();
        }
    }

    // The timestamp badge can be hidden from the image tools; the frame keeps
    // its video time and still reopens the video on a double tap.
    if (!path.hideBadge) {
        const badgeHeight = Math.max(16, Math.min(30, height * 0.16));
        const badgePad = badgeHeight * 0.28;
        const badgeY = bottom - badgeHeight - badgePad;
        const fontSize = Math.max(9, Math.min(15, badgeHeight * 0.48));
        const timeLabel = __formatVideoTime(path.videoTime);
        ctx.font = `700 ${fontSize}px system-ui, sans-serif`;
        const textWidth = ctx.measureText(timeLabel).width;
        const badgeWidth = badgeHeight + textWidth + badgePad * 2.1;

        ctx.fillStyle = 'rgba(5, 6, 10, 0.82)';
        ctx.beginPath();
        __roundedRectPath(ctx, left + badgePad, badgeY, badgeWidth, badgeHeight, badgeHeight / 2);
        ctx.fill();

        const playX = left + badgePad * 1.9;
        const playY = badgeY + badgeHeight / 2;
        const playSize = badgeHeight * 0.34;
        ctx.fillStyle = '#ff3038';
        ctx.beginPath();
        ctx.moveTo(playX - playSize * 0.32, playY - playSize * 0.58);
        ctx.lineTo(playX + playSize * 0.65, playY);
        ctx.lineTo(playX - playSize * 0.32, playY + playSize * 0.58);
        ctx.closePath();
        ctx.fill();

        ctx.fillStyle = '#ffffff';
        ctx.textBaseline = 'middle';
        ctx.fillText(timeLabel, left + badgePad + badgeHeight, playY);
    }
    ctx.restore();

    if (__mediaEdit(path)?.backdrop === 'none') return;
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = isLight ? 'rgba(20, 22, 30, 0.24)' : 'rgba(255,255,255,0.22)';
    ctx.lineWidth = Math.max(0.8, Math.min(2, width * 0.006));
    ctx.beginPath();
    __roundedRectPath(ctx, left, top, width, height, radius);
    ctx.stroke();
    ctx.restore();
}

function __drawStoredPathRaw(ctx, path) {
    if (!path || !path.points) return;

    ctx.globalCompositeOperation = 'source-over';

    if (path.tool === 'youtube-frame') {
        __drawYoutubeFrame(ctx, path);
        return;
    }

    if (path.tool === 'image') {
        __drawInsertedImage(ctx, path);
        return;
    }

    if (path.tool === 'manipulative') {
        if (window.Inkyscib?.Manipulatives?.drawTile) {
            window.Inkyscib.Manipulatives.drawTile(ctx, path);
        }
        return;
    }

    if (path.tool === 'construction') {
        if (window.Inkyscib?.ConstructionRender?.drawPath) {
            window.Inkyscib.ConstructionRender.drawPath(ctx, path);
        }
        return;
    }

    if (path.tool === 'shape') {
        if (window.drawShapeOutline) {
            window.drawShapeOutline(ctx, path);
        }
        return;
    }

    if (path.tool === 'line' && path.points.length >= 2) {
        if (typeof window.drawLineWithType === 'function') {
            window.drawLineWithType(ctx, path);
            return;
        }
        const [p1, p2] = path.points;
        ctx.strokeStyle = path.color || '#ffffff';
        ctx.lineWidth = path.size || 2;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.stroke();
        return;
    }

    if (path.tool === 'pen') {
        __drawPenPath(ctx, path);
        return;
    }

    ctx.lineWidth = path.size || 2;
    ctx.lineCap = 'round';
    ctx.beginPath();

    if (path.points.length > 0) {
        ctx.moveTo(path.points[0].x, path.points[0].y);

        if (path.points.length === 1) {
            ctx.lineTo(path.points[0].x + 0.1, path.points[0].y + 0.1);
        } else if (path.points.length === 2) {
            ctx.lineTo(path.points[1].x, path.points[1].y);
        } else {
            for (let i = 1; i < path.points.length - 1; i++) {
                const midX = (path.points[i].x + path.points[i + 1].x) / 2;
                const midY = (path.points[i].y + path.points[i + 1].y) / 2;
                ctx.quadraticCurveTo(path.points[i].x, path.points[i].y, midX, midY);
            }
            ctx.lineTo(path.points[path.points.length - 1].x, path.points[path.points.length - 1].y);
        }
    }

    if (path.tool === 'eraser') {
        ctx.globalCompositeOperation = 'destination-out';
        ctx.strokeStyle = 'rgba(0,0,0,1)';
    } else {
        ctx.globalCompositeOperation = 'source-over';
        ctx.strokeStyle = path.color || '#ffffff';
    }
    ctx.stroke();
}

function __drawStoredPathWithCuts(ctx, path) {
    const bounds = __pathRenderBounds(path);
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) {
        __drawStoredPathRaw(ctx, path);
        return;
    }

    const transform = ctx.getTransform();
    const deviceScale = window.devicePixelRatio || 1;
    let layerScale = Math.max(1, Math.min(3, Math.abs(transform.a || 1) * deviceScale));
    const maxLayerSide = 4096;
    layerScale = Math.min(layerScale, maxLayerSide / Math.max(1, bounds.width), maxLayerSide / Math.max(1, bounds.height));
    layerScale = Math.max(0.5, layerScale);

    const alignedLeft = Math.floor(bounds.left * layerScale) / layerScale;
    const alignedTop = Math.floor(bounds.top * layerScale) / layerScale;
    const alignedRight = Math.ceil(bounds.right * layerScale) / layerScale;
    const alignedBottom = Math.ceil(bounds.bottom * layerScale) / layerScale;
    const alignedWidth = alignedRight - alignedLeft;
    const alignedHeight = alignedBottom - alignedTop;

    const layer = document.createElement('canvas');
    layer.width = Math.max(1, Math.ceil(alignedWidth * layerScale));
    layer.height = Math.max(1, Math.ceil(alignedHeight * layerScale));

    const layerCtx = layer.getContext('2d');
    layerCtx.setTransform(layerScale, 0, 0, layerScale, -alignedLeft * layerScale, -alignedTop * layerScale);
    __drawStoredPathRaw(layerCtx, path);
    (path.erasers || []).forEach((eraser) => __drawStoredPathRaw(layerCtx, {
        ...eraser,
        tool: 'eraser'
    }));
    if (Array.isArray(path.componentPoints) && path.componentPoints.length > 0) {
        layerCtx.save();
        layerCtx.globalCompositeOperation = 'destination-in';
        layerCtx.strokeStyle = 'rgba(0,0,0,1)';
        layerCtx.fillStyle = 'rgba(0,0,0,1)';
        layerCtx.lineWidth = __componentClipWidth(path);
        layerCtx.lineCap = 'round';
        layerCtx.lineJoin = 'round';
        layerCtx.beginPath();
        layerCtx.moveTo(path.componentPoints[0].x, path.componentPoints[0].y);
        if (path.componentPoints.length === 1) {
            layerCtx.arc(
                path.componentPoints[0].x,
                path.componentPoints[0].y,
                __componentClipWidth(path) / 2,
                0,
                Math.PI * 2
            );
            layerCtx.fill();
        } else {
            path.componentPoints.slice(1).forEach((point) => layerCtx.lineTo(point.x, point.y));
            layerCtx.stroke();
        }
        layerCtx.restore();
    }

    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(
        layer,
        alignedLeft,
        alignedTop,
        layer.width / layerScale,
        layer.height / layerScale
    );
    ctx.restore();
}

function __drawStoredPath(ctx, path) {
    if (path?.tool !== 'eraser' && Array.isArray(path?.erasers) && path.erasers.length > 0) {
        __drawStoredPathWithCuts(ctx, path);
        return;
    }

    __drawStoredPathRaw(ctx, path);
}

function __backgroundIsCurrent(state, canvas) {
    const meta = __backgroundLayerMeta;
    if (!meta) return false;

    const root = document.documentElement;
    const transform = state.transform;
    const ppt = state.ppt?.active ? state.ppt : null;
    const slide = ppt?.slides?.[ppt.currentSlide || 0] || null;
    const notebook = state.notebook?.active ? state.notebook : null;

    return meta.width === canvas.width &&
        meta.height === canvas.height &&
        meta.theme === (root.dataset.theme || 'dark') &&
        meta.canvas === (root.dataset.canvas || '') &&
        meta.pattern === (root.dataset.pattern || 'dot') &&
        meta.arMode === !!state.arMode &&
        meta.ppt === ppt &&
        meta.slide === slide &&
        meta.notebook === notebook &&
        meta.revision === __backgroundRevision &&
        __sameTransform(meta, transform) &&
        (!notebook || __samePathReferences(meta.paths, state.paths));
}

function __rememberBackgroundState(state, canvas) {
    const root = document.documentElement;
    const ppt = state.ppt?.active ? state.ppt : null;
    __backgroundLayerMeta = {
        width: canvas.width,
        height: canvas.height,
        theme: root.dataset.theme || 'dark',
        // Two presets share a chrome theme but not a grid, so the preset is
        // part of what the cached background was drawn for.
        canvas: root.dataset.canvas || '',
        pattern: root.dataset.pattern || 'dot',
        arMode: !!state.arMode,
        ppt,
        slide: ppt?.slides?.[ppt.currentSlide || 0] || null,
        notebook: state.notebook?.active ? state.notebook : null,
        paths: state.notebook?.active ? state.paths.slice() : null,
        revision: __backgroundRevision,
        scale: state.transform.scale,
        offsetX: state.transform.offsetX,
        offsetY: state.transform.offsetY
    };
}

function __renderBackgroundLayer(state, canvas) {
    if (__backgroundIsCurrent(state, canvas)) return;

    const ratio = __pixelRatio();
    patternCtx.setTransform(1, 0, 0, 1, 0, 0);
    patternCtx.clearRect(0, 0, canvas.width, canvas.height);
    patternCtx.setTransform(
        state.transform.scale * ratio,
        0,
        0,
        state.transform.scale * ratio,
        state.transform.offsetX * ratio,
        state.transform.offsetY * ratio
    );

    if (!state.arMode) {
        if (state.ppt?.active && typeof window.renderPptSlideBackground === 'function') {
            window.renderPptSlideBackground(patternCtx, canvas);
        } else if (state.notebook?.active && typeof window.renderNotebookBackground === 'function') {
            window.renderNotebookBackground(patternCtx, canvas);
        } else {
            __drawInfinitePattern(patternCtx, canvas);
        }
    }

    __rememberBackgroundState(state, canvas);
}

// ---------------------------------------------------------------------------
// Viewport culling
//
// Every stored path used to be handed to the rasteriser on every rebuild, even
// when it sat far outside the visible area, so panning a long document cost the
// same as drawing all of it. Only tools whose ink is fully described by their
// own bounding box are culled: shapes, lines, construction geometry and
// manipulatives carry labels, handles and angle marks that can be painted
// outside those bounds, and there are rarely enough of them to matter. Ink
// strokes are the ones that run into the thousands.
//
// The list is an allowlist rather than a denylist on purpose. It happens to be
// complete today - the five tools named here plus the five that are not
// (compass, construction, line, manipulative, shape) are every tool that
// stores a path - but a tool added later and forgotten should default to being
// drawn, not to being silently culled at the edge of the viewport.
const __CULLABLE_TOOLS = new Set(['pen', 'eraser', 'highlight', 'image', 'youtube-frame']);
const __CULL_MARGIN = 64;
const __cullBoundsCache = new WeakMap();

function __cullSignature(path) {
    const points = path.points || [];
    const first = points[0];
    const last = points[points.length - 1];
    return points.length + '|' +
        (first ? first.x + ',' + first.y : '') + '|' +
        (last ? last.x + ',' + last.y : '') + '|' +
        (path.size || 0) + '|' +
        (path.erasers ? path.erasers.length : 0);
}

function __cullableBounds(path) {
    const cached = __cullBoundsCache.get(path);
    const signature = __cullSignature(path);
    if (cached && cached.signature === signature) return cached.bounds;

    const bounds = __pathRenderBounds(path);
    __cullBoundsCache.set(path, { signature, bounds });
    return bounds;
}

// `padDevice` widens the rect by the committed layer's margin, so the paths
// that will scroll into view during a blit are rasterised into that margin
// rather than culled away and revealed as blank.
function __visibleWorldRect(state, canvas, padDevice = 0) {
    const ratio = __pixelRatio();
    const scale = state.transform.scale;
    if (!Number.isFinite(scale) || scale <= 0) return null;

    const padCss = padDevice / ratio;
    const cssWidth = canvas.width / ratio;
    const cssHeight = canvas.height / ratio;
    return {
        left: (-padCss - state.transform.offsetX) / scale - __CULL_MARGIN,
        top: (-padCss - state.transform.offsetY) / scale - __CULL_MARGIN,
        right: (cssWidth + padCss - state.transform.offsetX) / scale + __CULL_MARGIN,
        bottom: (cssHeight + padCss - state.transform.offsetY) / scale + __CULL_MARGIN
    };
}

function __pathIsVisible(path, viewport) {
    if (!viewport || !path || !__CULLABLE_TOOLS.has(path.tool)) return true;

    const bounds = __cullableBounds(path);
    // No usable bounds means no confident answer, so the path is drawn.
    if (!bounds ||
        !Number.isFinite(bounds.left) ||
        !Number.isFinite(bounds.right) ||
        !Number.isFinite(bounds.top) ||
        !Number.isFinite(bounds.bottom)) {
        return true;
    }

    return bounds.right >= viewport.left &&
        bounds.left <= viewport.right &&
        bounds.bottom >= viewport.top &&
        bounds.top <= viewport.bottom;
}

function __rebuildCommittedLayer(state, canvas) {
    if (!__committedLayerCtx) return false;

    // The bitmap is larger than the canvas by __COMMITTED_PAD on every side.
    // Its pixel (0, 0) is device (-pad, -pad) in the frame it was built for.
    const pad = __COMMITTED_PAD;
    const layerWidth = canvas.width + pad * 2;
    const layerHeight = canvas.height + pad * 2;
    if (__committedLayer.width !== layerWidth) __committedLayer.width = layerWidth;
    if (__committedLayer.height !== layerHeight) __committedLayer.height = layerHeight;
    // The pending layer swaps places with this one, so it has to be the same
    // size. Sizing it here pays its allocation in a frame that is already a
    // full rebuild. Left to __startPendingRebuild, the first pan after load
    // paid it instead - 8.2ms measured, against a 5ms slice - so a light page
    // missed its one-frame rebuild. __startPendingRebuild clears the layer
    // before drawing, so nothing about the pixels changes.
    if (__pendingLayer.width !== layerWidth) __pendingLayer.width = layerWidth;
    if (__pendingLayer.height !== layerHeight) __pendingLayer.height = layerHeight;

    const ratio = __pixelRatio();
    __committedLayerCtx.setTransform(1, 0, 0, 1, 0, 0);
    __committedLayerCtx.clearRect(0, 0, layerWidth, layerHeight);
    __committedLayerCtx.setTransform(
        state.transform.scale * ratio,
        0,
        0,
        state.transform.scale * ratio,
        state.transform.offsetX * ratio + pad,
        state.transform.offsetY * ratio + pad
    );
    const viewport = __visibleWorldRect(state, canvas, pad);
    state.paths.forEach((path) => {
        if (!__pathIsVisible(path, viewport)) return;
        __drawPathIntoLayer(__committedLayerCtx, path);
    });

    __committedLayerMeta = {
        width: canvas.width,
        height: canvas.height,
        pad,
        ratio,
        scale: state.transform.scale,
        offsetX: state.transform.offsetX,
        offsetY: state.transform.offsetY,
        paths: state.paths.slice()
    };
    __committedRevision++;
    return true;
}

function __cancelSharpRebuild() {
    if (__sharpRebuildTimer === null) return;
    clearTimeout(__sharpRebuildTimer);
    __sharpRebuildTimer = null;
}

// A blit reuses a layer rasterised for a different scale, so it is soft
// wherever the view has been magnified. Once movement stops, start building the
// layer at the scale actually on screen - in slices, while frames keep blitting
// the soft one, so a heavy page never freezes at the end of a gesture. Each blit
// frame pushes the timer out, so this fires once at the end of a gesture rather
// than once per frame during it.
function __scheduleSharpRebuild() {
    __cancelSharpRebuild();
    __sharpRebuildTimer = setTimeout(() => {
        __sharpRebuildTimer = null;
        const state = window.appState;
        const canvas = document.getElementById('drawingCanvas');
        if (state && canvas && !__pendingMeta && __committedLayerMeta &&
            !__sameTransform(__committedLayerMeta, state.transform)) {
            __startPendingRebuild(state, canvas);
        }
        requestCanvasRender();
    }, __SHARP_REBUILD_DELAY);
}

// Content validity is now separate from transform validity: a pan or a zoom
// leaves the cached strokes perfectly usable, it only moves where they belong.
function __committedContentIsCurrent(state, canvas) {
    const meta = __committedLayerMeta;
    if (!meta || !__committedLayerCtx) return false;

    return meta.width === canvas.width &&
        meta.height === canvas.height &&
        meta.ratio === __pixelRatio() &&
        __samePathReferences(meta.paths, state.paths);
}

// Each path draws from the same context state, whichever layer it lands in and
// whatever was drawn before it, so a path appended, repaired or drawn into the
// pending layer produces the pixels a full rebuild does.
function __drawPathIntoLayer(ctx, path) {
    ctx.save();
    __drawStoredPath(ctx, path);
    ctx.restore();
}

function __cancelPendingRebuild() {
    __pendingMeta = null;
}

function __startPendingRebuild(state, canvas) {
    const pad = __COMMITTED_PAD;
    const width = canvas.width + pad * 2;
    const height = canvas.height + pad * 2;
    if (__pendingLayer.width !== width) __pendingLayer.width = width;
    if (__pendingLayer.height !== height) __pendingLayer.height = height;
    __pendingLayerCtx.setTransform(1, 0, 0, 1, 0, 0);
    __pendingLayerCtx.clearRect(0, 0, width, height);
    __pendingMeta = {
        width: canvas.width,
        height: canvas.height,
        pad,
        ratio: __pixelRatio(),
        scale: state.transform.scale,
        offsetX: state.transform.offsetX,
        offsetY: state.transform.offsetY,
        // The paths already walked, in order. A pen lift extends the document
        // and is picked up; anything that changes this prefix cancels the build.
        paths: [],
        viewport: __visibleWorldRect(state, canvas, pad)
    };
}

// Draws paths into the pending layer until the slice deadline, always at least
// one. Returns true when the build reached the end and was swapped in.
function __advancePendingRebuild(state, canvas, deadline) {
    const meta = __pendingMeta;
    if (!meta) return false;
    if (meta.width !== canvas.width || meta.height !== canvas.height || meta.ratio !== __pixelRatio()) {
        __cancelPendingRebuild();
        return false;
    }
    const paths = state.paths;
    const walked = meta.paths;
    if (paths.length < walked.length) {
        __cancelPendingRebuild();
        return false;
    }
    for (let index = 0; index < walked.length; index++) {
        if (walked[index] !== paths[index]) {
            __cancelPendingRebuild();
            return false;
        }
    }

    __pendingLayerCtx.setTransform(
        meta.scale * meta.ratio,
        0,
        0,
        meta.scale * meta.ratio,
        meta.offsetX * meta.ratio + meta.pad,
        meta.offsetY * meta.ratio + meta.pad
    );
    do {
        if (walked.length >= paths.length) break;
        const path = paths[walked.length];
        if (__pathIsVisible(path, meta.viewport)) __drawPathIntoLayer(__pendingLayerCtx, path);
        walked.push(path);
    } while (performance.now() < deadline);
    if (walked.length < paths.length) return false;

    const layer = __committedLayer;
    const layerCtx = __committedLayerCtx;
    __committedLayer = __pendingLayer;
    __committedLayerCtx = __pendingLayerCtx;
    __pendingLayer = layer;
    __pendingLayerCtx = layerCtx;
    __committedLayerMeta = {
        width: meta.width,
        height: meta.height,
        pad: meta.pad,
        ratio: meta.ratio,
        scale: meta.scale,
        offsetX: meta.offsetX,
        offsetY: meta.offsetY,
        paths: walked
    };
    __pendingMeta = null;
    __committedRevision++;
    return true;
}

// The blit mapping without its coverage and magnification checks. Only used
// while a sharp layer is still being built: a soft view, or one with blank
// borders, is better than a frozen one.
function __looseBlitTransform(meta, transform) {
    if (!meta || !(meta.scale > 0) || !(transform.scale > 0)) return null;
    const k = transform.scale / meta.scale;
    return {
        k,
        tx: meta.ratio * (transform.offsetX - meta.offsetX * k),
        ty: meta.ratio * (transform.offsetY - meta.offsetY * k)
    };
}

// Maps the cached bitmap's own device space onto the current one. Returns null
// when the mapped bitmap would not cover the whole canvas - which would show
// blank edges - or would be magnified past the point where the softness reads
// as a bug. Both cases fall back to a rebuild.
function __blitTransform(meta, transform, canvas) {
    if (!meta || !Number.isFinite(meta.scale) || meta.scale <= 0) return null;
    if (!Number.isFinite(transform.scale) || transform.scale <= 0) return null;

    const k = transform.scale / meta.scale;
    if (!Number.isFinite(k) || k <= 0 || k > __BLIT_MAX_ZOOM) return null;

    const ratio = meta.ratio;
    const tx = ratio * (transform.offsetX - meta.offsetX * k);
    const ty = ratio * (transform.offsetY - meta.offsetY * k);
    if (!Number.isFinite(tx) || !Number.isFinite(ty)) return null;

    const pad = meta.pad;
    const left = k * -pad + tx;
    const top = k * -pad + ty;
    const right = k * (meta.width + pad) + tx;
    const bottom = k * (meta.height + pad) + ty;
    if (left > 0.001 || top > 0.001) return null;
    if (right < canvas.width - 0.001 || bottom < canvas.height - 0.001) return null;

    return { k, tx, ty };
}

// A pen lift only adds ink on top of what the layer already holds, yet a pushed
// path fails the reference check and used to replay the whole document - 50 to
// 700 ms on a full page. Drawing just the new paths into the layer, in the
// frame it was built for, issues the same commands a rebuild would, so it
// gives the same pixels for the cost of one stroke. Only ink qualifies: shapes,
// lines, constructions and tiles can change how other paths draw. Anything that
// replaced or removed an existing path breaks the reference prefix and still
// rebuilds - including the partial eraser, whose pieces are new pen paths.
const __APPENDABLE_TOOLS = new Set(['pen', 'highlight']);

function __appendToCommittedLayer(state, canvas) {
    const meta = __committedLayerMeta;
    if (!meta || !__committedLayerCtx) return false;

    const cached = meta.paths;
    const paths = state.paths;
    if (paths.length <= cached.length) return false;
    if (meta.width !== canvas.width || meta.height !== canvas.height || meta.ratio !== __pixelRatio()) {
        return false;
    }
    for (let index = 0; index < cached.length; index++) {
        if (cached[index] !== paths[index]) return false;
    }
    const added = paths.slice(cached.length);
    if (!added.every((path) => __APPENDABLE_TOOLS.has(path?.tool))) return false;

    __committedLayerCtx.setTransform(
        meta.scale * meta.ratio,
        0,
        0,
        meta.scale * meta.ratio,
        meta.offsetX * meta.ratio + meta.pad,
        meta.offsetY * meta.ratio + meta.pad
    );
    // The meta carries the transform the layer was built at, so it stands in
    // for state when working out what that frame could see.
    const viewport = __visibleWorldRect({ transform: meta }, canvas, meta.pad);
    added.forEach((path) => {
        if (!__pathIsVisible(path, viewport)) return;
        __drawPathIntoLayer(__committedLayerCtx, path);
    });
    meta.paths = paths.slice();
    __committedRevision++;
    return true;
}

// ---------------------------------------------------------------------------
// Region repair
//
// The partial eraser and a write-assist revert replace a handful of path
// objects and leave the rest alone, yet a stale layer used to mean replaying
// the whole document. Inside a clip of the changed paths' bounds, clearing the
// layer and redrawing every path that touches that rectangle, in document order,
// gives the pixels a rebuild would: nothing outside the rectangle changed, and
// paths that miss it contribute nothing inside it.
const __REPAIR_MAX_AREA = 0.4;
// Undo and redo replace every object; past this many, rebuild without looking.
const __REPAIR_MAX_PATHS = 64;
// Below this many paths a rebuild takes a few milliseconds (about 35 us a path
// at full CPU speed) and is exact at once, so a repair - right to the eye, and
// exact only when its copy is swapped in - gains nothing. It also keeps a light
// page from depending on that copy finishing inside the frame, which the
// pending canvas's first allocation can prevent.
const __REPAIR_MIN_PATHS = 200;

// World bounds to an integer device rectangle in the layer, or null if empty.
function __layerDeviceRect(meta, bounds) {
    const scale = meta.scale * meta.ratio;
    const originX = meta.offsetX * meta.ratio + meta.pad;
    const originY = meta.offsetY * meta.ratio + meta.pad;
    const left = Math.max(0, Math.floor(bounds.left * scale + originX) - 2);
    const top = Math.max(0, Math.floor(bounds.top * scale + originY) - 2);
    const right = Math.min(meta.width + meta.pad * 2, Math.ceil(bounds.right * scale + originX) + 2);
    const bottom = Math.min(meta.height + meta.pad * 2, Math.ceil(bounds.bottom * scale + originY) + 2);
    if (right <= left || bottom <= top) return null;
    return { x: left, y: top, width: right - left, height: bottom - top };
}

function __redrawLayerRegion(ctx, meta, rect, paths) {
    const scale = meta.scale * meta.ratio;
    const originX = meta.offsetX * meta.ratio + meta.pad;
    const originY = meta.offsetY * meta.ratio + meta.pad;
    const region = {
        left: (rect.x - originX) / scale,
        top: (rect.y - originY) / scale,
        right: (rect.x + rect.width - originX) / scale,
        bottom: (rect.y + rect.height - originY) / scale
    };
    // The same culling the rebuild used, so the region holds exactly the paths
    // a rebuild would have put there.
    const viewport = __visibleWorldRect({ transform: meta }, meta, meta.pad);

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.beginPath();
    ctx.rect(rect.x, rect.y, rect.width, rect.height);
    ctx.clip();
    ctx.clearRect(rect.x, rect.y, rect.width, rect.height);
    ctx.setTransform(scale, 0, 0, scale, originX, originY);
    paths.forEach((path) => {
        // The small region rejects almost every path, so it is checked first.
        if (!__pathIsVisible(path, region) || !__pathIsVisible(path, viewport)) return;
        __drawPathIntoLayer(ctx, path);
    });
    ctx.restore();
}

function __repairCommittedLayer(state, canvas) {
    const meta = __committedLayerMeta;
    if (!meta || !__committedLayerCtx) return false;
    if (meta.width !== canvas.width || meta.height !== canvas.height || meta.ratio !== __pixelRatio()) {
        return false;
    }

    if (state.paths.length < __REPAIR_MIN_PATHS) return false;

    const before = meta.paths;
    const after = state.paths;
    const beforeSet = new Set(before);
    const afterSet = new Set(after);
    const removed = before.filter((path) => !afterSet.has(path));
    const added = after.filter((path) => !beforeSet.has(path));
    const changed = removed.concat(added);
    if (!changed.length || changed.length > __REPAIR_MAX_PATHS) return false;

    // Paths present in both lists must keep their stacking order.
    const keptBefore = before.filter((path) => afterSet.has(path));
    const keptAfter = after.filter((path) => beforeSet.has(path));
    if (keptBefore.length !== keptAfter.length) return false;
    for (let index = 0; index < keptBefore.length; index++) {
        if (keptBefore[index] !== keptAfter[index]) return false;
    }

    const bounds = __unionBounds(changed.map(__pathRenderBounds));
    if (!bounds ||
        !Number.isFinite(bounds.left) || !Number.isFinite(bounds.right) ||
        !Number.isFinite(bounds.top) || !Number.isFinite(bounds.bottom)) {
        return false;
    }
    const rect = __layerDeviceRect(meta, bounds);
    if (rect) {
        const layerArea = (meta.width + meta.pad * 2) * (meta.height + meta.pad * 2);
        if (rect.width * rect.height > layerArea * __REPAIR_MAX_AREA) return false;
        __redrawLayerRegion(__committedLayerCtx, meta, rect, after);
    }
    meta.paths = after.slice();
    __committedRevision++;
    if (rect) __startRefreshRebuild(state, canvas);
    return true;
}

// A clipped redraw rasterises antialiased edges a little differently from an
// unclipped one - measured up to 35/255 alpha on a few hundred pixels inside the
// region, and drawing into an unclipped scratch canvas and copying the region
// back did no better - so a repaired layer is right to the eye but not bit for
// bit. An exact copy is built behind it in slices and swapped in; on a light
// page that happens within the same frame.
function __startRefreshRebuild(state, canvas) {
    __startPendingRebuild(state, canvas);
    __pendingMeta.refresh = true;
}

// ---------------------------------------------------------------------------
// Tail frames
//
// While a stroke is being written, the only pixels that differ from the last
// frame are around its last few points: `appendInkPoint` only ever adds a
// point or rewrites the final one, and the committed layer under it has not
// changed. Clearing and repainting the whole canvas for that is most of a live
// frame - 3.6 ms of it at 1920x1200 when raster is forced. So when nothing else
// changed, the frame is painted inside a clip around the tail. Inside the clip
// it issues exactly the commands a full frame would; outside it the previous
// frame's pixels are already right.
//
// Gel and calligraphy are left out: glow and smoothing reach further back along
// the stroke than a few points.
const __TAIL_POINTS = 3;
let __tailFrames = true;
let __lastFrame = null;

// Test seam: off paints every frame in full, so a tail frame can be compared.
window.__inkyscibSetDirtyRectFrames = (enabled) => {
    __tailFrames = enabled !== false;
    __lastFrame = null;
};

function __liveTailStyle(path) {
    if (path?.tool === 'highlight') return 'highlight';
    if (path?.tool !== 'pen') return null;
    const style = path.penStyle || path.style || 'default';
    return style === 'default' || style === 'brush' || style === 'fountain' ? style : null;
}

// The device-pixel rectangle that can differ from the previous frame, or null
// when this frame has to be painted in full.
function __liveTailRect(state, canvas, ratio) {
    const last = __lastFrame;
    const path = state.currentPath;
    if (!__tailFrames || !last || !state.isDrawing || !path || last.path !== path) return null;
    if (last.revision !== __committedRevision ||
        last.width !== canvas.width ||
        last.height !== canvas.height ||
        last.ratio !== ratio ||
        !__sameTransform(last, state.transform)) {
        return null;
    }
    if (state.handPath || state.clearAnimation || state.selection?.action) return null;

    const style = __liveTailStyle(path);
    const points = path.points || [];
    if (!style || points.length < 2 || points.length < last.count || points[0] !== last.first) return null;
    if (last.count >= 2 && points[last.count - 2] !== last.beforeLast) return null;

    const transform = state.transform;
    const deviceScale = transform.scale * ratio;
    // Brush and fountain draw a decimated copy, and their wet cache counts in
    // it, so their tail is taken from that copy.
    const tail = style === 'brush' || style === 'fountain'
        ? __decimateForRender(points, __renderMinSpacing / Math.abs(deviceScale)).slice(Math.max(0, last.tailFrom))
        : points.slice(Math.max(0, last.count - __TAIL_POINTS));
    // The drawn-through tip (__drawInkTip) reaches past the stored points, and
    // where last frame's tip was has to be painted over as well.
    const tips = [path.__inkInput?.tip, last.tip].filter(Boolean);
    const bounds = __boundsFromPoints(tips.length ? tail.concat(tips) : tail, Math.max(8, (path.size || 2) * 2));
    if (!bounds) return null;

    const left = Math.max(0, Math.floor(bounds.left * deviceScale + transform.offsetX * ratio) - 2);
    const top = Math.max(0, Math.floor(bounds.top * deviceScale + transform.offsetY * ratio) - 2);
    const right = Math.min(canvas.width, Math.ceil(bounds.right * deviceScale + transform.offsetX * ratio) + 2);
    const bottom = Math.min(canvas.height, Math.ceil(bounds.bottom * deviceScale + transform.offsetY * ratio) + 2);
    return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

function __rememberFrame(state, canvas, ratio) {
    const path = state.isDrawing ? state.currentPath : null;
    const points = path?.points || [];
    const style = __liveTailStyle(path);
    let tailFrom = points.length - __TAIL_POINTS;
    if (style === 'brush' || style === 'fountain') {
        // What the next frame can still change starts where the wet cache
        // stops. Without a cache it reaches further back than the default
        // nib's three points: these nibs taper over the last few points
        // (`remaining` in __penSegmentWidth) and blend each segment's width
        // with the next, so a new point re-widens several segments. The wet
        // cache's own tail is sized to cover that, so take the same span.
        tailFrom = __wetMeta && __wetMeta.path === path
            ? __wetMeta.cached - __TAIL_POINTS
            : __decimateForRender(points, __renderMinSpacing / Math.abs(state.transform.scale * ratio)).length - __WET_TAIL - __TAIL_POINTS;
    }
    __lastFrame = {
        path,
        // Copied, because events.js replaces the tip object on every sample.
        tip: path?.__inkInput?.tip ? { ...path.__inkInput.tip } : null,
        count: points.length,
        first: points[0],
        beforeLast: points[points.length - 2],
        tailFrom,
        revision: __committedRevision,
        width: canvas.width,
        height: canvas.height,
        ratio,
        scale: state.transform.scale,
        offsetX: state.transform.offsetX,
        offsetY: state.transform.offsetY
    };
}

function __paintDrawingLayer(state, canvas) {
    const ratio = __pixelRatio();
    // Sliced builds get whatever is left of this once the frame's own work is done.
    const frameDeadline = performance.now() + __REBUILD_SLICE_MS;

    let blit = null;
    let loose = null;
    // A pure append makes the layer current again; the transform check below
    // then decides between drawing it straight and blitting it.
    __appendToCommittedLayer(state, canvas);
    if (!__committedContentIsCurrent(state, canvas)) {
        // Any other change is repaired in the region it touched, or rebuilt. That
        // includes every frame of a selection drag, which replays nothing: it
        // assigns clones of the dragged paths back (applyAction in
        // tools/select.js) for move, resize and rotate alike, so their old and
        // new places are what changed. A marquee changes no paths at all.
        __cancelPendingRebuild();
        if (!__repairCommittedLayer(state, canvas)) {
            __rebuildCommittedLayer(state, canvas);
        }
    } else if (__sameTransform(__committedLayerMeta, state.transform)) {
        // The layer on hand is already sharp for this view. A repaired one is
        // still being replaced by its exact copy, below.
        if (!__pendingMeta?.refresh) __cancelPendingRebuild();
    } else {
        // Content is still good; only the view moved. Serve the frame from the
        // bitmap we already have, and build a sharp one in slices when that
        // bitmap cannot cover the view. A build whose target can no longer
        // serve the view restarts at the view actually on screen.
        if (__pendingMeta && !__blitTransform(__pendingMeta, state.transform, canvas)) {
            __startPendingRebuild(state, canvas);
        }
        blit = __blitTransform(__committedLayerMeta, state.transform, canvas);
        if (!blit && !__pendingMeta) __startPendingRebuild(state, canvas);
        if (__pendingMeta && __advancePendingRebuild(state, canvas, frameDeadline)) {
            blit = __sameTransform(__committedLayerMeta, state.transform)
                ? null
                : __blitTransform(__committedLayerMeta, state.transform, canvas);
        }
        if (!blit && !__sameTransform(__committedLayerMeta, state.transform)) {
            loose = __looseBlitTransform(__committedLayerMeta, state.transform);
        }
        if (__pendingMeta) requestCanvasRender();
    }
    if (__pendingMeta?.refresh &&
        __sameTransform(__committedLayerMeta, state.transform) &&
        __sameTransform(__pendingMeta, state.transform)) {
        if (!__advancePendingRebuild(state, canvas, frameDeadline)) requestCanvasRender();
    }

    if (blit) __scheduleSharpRebuild();
    else __cancelSharpRebuild();

    const tail = __liveTailRect(state, canvas, ratio);
    drawingCtx.setTransform(1, 0, 0, 1, 0, 0);
    // A live eraser intentionally switches the context to destination-out.
    // Canvas state survives between frames, so restore the neutral composite
    // state before painting the cached committed layer on the next frame.
    drawingCtx.globalCompositeOperation = 'source-over';
    drawingCtx.globalAlpha = 1;
    drawingCtx.save();
    if (tail) {
        drawingCtx.beginPath();
        drawingCtx.rect(tail.x, tail.y, tail.width, tail.height);
        drawingCtx.clip();
        drawingCtx.clearRect(tail.x, tail.y, tail.width, tail.height);
    } else {
        drawingCtx.clearRect(0, 0, canvas.width, canvas.height);
    }

    if (__committedLayerCtx) {
        const pad = __committedLayerMeta ? __committedLayerMeta.pad : __COMMITTED_PAD;
        const mapping = blit || loose;
        if (mapping) {
            drawingCtx.setTransform(mapping.k, 0, 0, mapping.k, mapping.tx, mapping.ty);
        } else {
            drawingCtx.setTransform(1, 0, 0, 1, 0, 0);
        }
        drawingCtx.drawImage(__committedLayer, -pad, -pad);
        drawingCtx.setTransform(1, 0, 0, 1, 0, 0);
    } else {
        drawingCtx.setTransform(
            state.transform.scale * ratio,
            0,
            0,
            state.transform.scale * ratio,
            state.transform.offsetX * ratio,
            state.transform.offsetY * ratio
        );
        const fallbackViewport = __visibleWorldRect(state, canvas);
        state.paths.forEach((path) => {
            if (!__pathIsVisible(path, fallbackViewport)) return;
            __drawStoredPath(drawingCtx, path);
        });
    }

    drawingCtx.setTransform(
        state.transform.scale * ratio,
        0,
        0,
        state.transform.scale * ratio,
        state.transform.offsetX * ratio,
        state.transform.offsetY * ratio
    );

    const wetBefore = __wetMeta;
    if (state.isDrawing && state.currentPath) {
        if (!__drawLiveStroke(drawingCtx, state.currentPath, state, canvas, ratio)) {
            __drawStoredPath(drawingCtx, state.currentPath);
        }
        __drawInkTip(drawingCtx, state.currentPath);
    } else if (__wetMeta) {
        // The stroke is finished and has gone into the committed layer.
        __resetLiveStrokeCache();
    }
    if (tail && __wetMeta !== wetBefore) {
        // The wet cache was rebuilt, which re-quantises the whole prefix, so
        // pixels outside the tail changed too. Paint this frame in full.
        drawingCtx.restore();
        __lastFrame = null;
        __paintDrawingLayer(state, canvas);
        return;
    }
    if (state.handPath) {
        __drawStoredPath(drawingCtx, state.handPath);
    }
    if (window.Inkyscib?.Selection?.drawOverlay) {
        window.Inkyscib.Selection.drawOverlay(drawingCtx);
    }
    if (window.Inkyscib?.Eraser?.drawOverlay) {
        window.Inkyscib.Eraser.drawOverlay(drawingCtx);
    }
    // Compass preview, snap indicator and intersection candidates are live
    // state, so they are drawn every frame rather than baked into the
    // committed layer. Not while ink is in flight, though: drawOverlay reaches
    // hasCrossableGeometry -> rebuildIndex -> signature(), which concatenates a
    // string over every path on every call, and none of these previews belong
    // to a pen or highlighter stroke. The selection and eraser overlays above
    // stay - the eraser's lasso is drawn live.
    if (!__liveInkInFlight(state) && window.Inkyscib?.ConstructionRender?.drawOverlay) {
        window.Inkyscib.ConstructionRender.drawOverlay(drawingCtx);
    }
    drawingCtx.restore();
    __rememberFrame(state, canvas, ratio);
}

// True while ink is actually being laid down. Drawing renders from
// pointerrawupdate, so renderCanvasFrame runs at digitizer rate -- about four
// times per displayed frame on a 240 Hz stylus. That is deliberate and is what
// bought sample-to-paint 0.3 ms against 5.1 ms from pointermove; the answer is
// to make the frame cheap, not to make it rarer.
//
// Everything gated on this walks the whole document and cannot change between
// two samples of one stroke. None of it is dropped: endDrawing renders once
// more with isDrawing false, so it all runs exactly once, with the finished
// stroke in place.
function __liveInkInFlight(state) {
    if (!state?.isDrawing) return false;
    if (state.isPanning || state.isTouchZooming) return false;
    const tool = state.currentPath?.tool;
    return tool === 'pen' || tool === 'highlight';
}

function renderCanvasFrame() {
    const state = window.appState;
    if (!state) return;
    const liveInk = __liveInkInFlight(state);

    const patternCanvas = document.getElementById('patternCanvas');
    const drawingCanvas = document.getElementById('drawingCanvas');
    const metrics = typeof window.getCanvasMetrics === 'function'
        ? window.getCanvasMetrics()
        : {
            width: Math.round(patternCanvas?.parentElement?.clientWidth || 0),
            height: Math.round(patternCanvas?.parentElement?.clientHeight || 0)
        };
    
    if (!patternCanvas || !drawingCanvas) return;
    if (!metrics.width || !metrics.height) return;

    let resized = false;
    const pixelWidth = metrics.pixelWidth || metrics.width;
    const pixelHeight = metrics.pixelHeight || metrics.height;
    if (patternCanvas.width !== pixelWidth) { patternCanvas.width = pixelWidth; resized = true; }
    if (patternCanvas.height !== pixelHeight) { patternCanvas.height = pixelHeight; resized = true; }
    if (drawingCanvas.width !== pixelWidth) { drawingCanvas.width = pixelWidth; resized = true; }
    if (drawingCanvas.height !== pixelHeight) { drawingCanvas.height = pixelHeight; resized = true; }
    if (resized) {
        invalidateCanvasBackground();
        invalidateCanvasDrawingCache();
    }

    // Both clamps reach writtenPageCount -> pathBounds for every path, which
    // is uncached and allocates. The transform cannot move with the pen down.
    if (!liveInk) {
        if (state.ppt?.active && typeof window.clampPptTransform === 'function') {
            window.clampPptTransform();
        } else if (state.notebook?.active && typeof window.clampNotebookTransform === 'function') {
            window.clampNotebookTransform();
        }
    }
    __renderBackgroundLayer(state, patternCanvas);

    if (!state.clearAnimation) {
        __paintDrawingLayer(state, drawingCanvas);
    }

    if (state.clearAnimation?.snapshot) {
        const root = document.documentElement;
        const isLight = (root.getAttribute('data-theme') || 'dark') === 'light';
        const progress = Math.min(1, Math.max(0, state.clearAnimation.progress ?? 0));
        const eased = 1 - Math.pow(1 - progress, 3);
        const wipeRatio = __pixelRatio();
        const wipeX = drawingCanvas.width * eased;
        const bandWidth = wipeRatio * Math.max(34, Math.min(82, drawingCanvas.width / wipeRatio * 0.06));
        const leadingEdge = Math.min(drawingCanvas.width, wipeX + bandWidth);

        drawingCtx.setTransform(1, 0, 0, 1, 0, 0);
        drawingCtx.clearRect(0, 0, wipeX, drawingCanvas.height);

        drawingCtx.save();
        drawingCtx.beginPath();
        drawingCtx.rect(leadingEdge, 0, drawingCanvas.width - leadingEdge, drawingCanvas.height);
        drawingCtx.clip();
        drawingCtx.drawImage(state.clearAnimation.snapshot, 0, 0);
        drawingCtx.restore();

        const wipe = drawingCtx.createLinearGradient(wipeX - bandWidth * 0.35, 0, leadingEdge, 0);
        if (isLight) {
            wipe.addColorStop(0, 'rgba(255,255,255,0)');
            wipe.addColorStop(0.35, 'rgba(255,248,236,0.78)');
            wipe.addColorStop(1, 'rgba(229,214,189,0.98)');
        } else {
            wipe.addColorStop(0, 'rgba(255,255,255,0)');
            wipe.addColorStop(0.35, 'rgba(241,231,214,0.72)');
            wipe.addColorStop(1, 'rgba(212,196,170,0.94)');
        }

        drawingCtx.fillStyle = wipe;
        drawingCtx.fillRect(Math.max(0, wipeX - bandWidth * 0.35), 0, bandWidth * 1.35, drawingCanvas.height);

        drawingCtx.strokeStyle = isLight ? 'rgba(171, 142, 102, 0.32)' : 'rgba(248, 230, 201, 0.24)';
        drawingCtx.lineWidth = 2;
        drawingCtx.beginPath();
        drawingCtx.moveTo(Math.min(drawingCanvas.width, wipeX + bandWidth * 0.1), 0);
        drawingCtx.lineTo(Math.min(drawingCanvas.width, wipeX + bandWidth * 0.1), drawingCanvas.height);
        drawingCtx.stroke();
    }

    // Still dispatched on every frame: this is the "a frame was painted"
    // signal, and suppressing it hid real paints from anything watching (it
    // broke test_ink_is_painted_before_pointermove_arrives, which uses it to
    // time raw input against pointermove).
    //
    // The cost was never the dispatch, it was the listeners: updateNotebookUi
    // alone runs three full-document scans plus an unconditional textContent
    // write, and units.js syncInputs runs a document-wide querySelectorAll.
    // The flag lets each listener decide; the ones that scan the document bail
    // on it and run again on the frame after the pen lifts.
    if (typeof window.dispatchAppEvent === 'function') {
        window.dispatchAppEvent('canvasRendered', { liveInk });
    }
}

function requestCanvasRender() {
    if (__renderFrame !== null) return;
    __renderFrame = requestAnimationFrame(() => {
        __renderFrame = null;
        renderCanvasFrame();
    });
}

function renderCanvasNow() {
    if (__renderFrame !== null) {
        cancelAnimationFrame(__renderFrame);
        __renderFrame = null;
    }
    renderCanvasFrame();
}

function softCanvasRefresh() {
    if (!window.appState) return;
    requestCanvasRender();
}
window.render = requestCanvasRender;
window.renderNow = renderCanvasNow;
window.requestCanvasRender = requestCanvasRender;
window.softCanvasRefresh = softCanvasRefresh;
window.drawInkyscibPathForExport = __drawStoredPath;
window.applyInkyscibEraserToPaths = __applyEraserToPaths;
window.eraseInkyscibObjectsTouched = __eraseObjectsTouched;
window.bakeInkyscibEraserMasks = __bakeStandaloneErasersIntoPaths;
window.invalidateCanvasDrawingCache = invalidateCanvasDrawingCache;
window.invalidateCanvasBackground = invalidateCanvasBackground;
window.addEventListener("resize", () => {
    invalidateCanvasBackground();
    invalidateCanvasDrawingCache();
    requestCanvasRender();
});
