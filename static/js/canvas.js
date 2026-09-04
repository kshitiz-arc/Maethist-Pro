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
const __committedLayer = document.createElement('canvas');
const __committedLayerCtx = __committedLayer.getContext('2d', {
    alpha: true,
    desynchronized: true
});
let __committedLayerMeta = null;
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

function __drawVariablePenStroke(ctx, path, style) {
    const points = path.points || [];
    const color = path.color || '#ffffff';
    const baseSize = Math.max(0.5, path.size || 2);
    if (points.length === 0) return;

    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (points.length === 1) {
        const width = __penSegmentWidth(style, baseSize, points, 0);
        ctx.beginPath();
        ctx.arc(points[0].x, points[0].y, width / 2, 0, Math.PI * 2);
        ctx.fill();
        return;
    }

    function midpoint(a, b) {
        return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    }

    // Use short connected curves instead of raw line segments. Round caps hide
    // width transitions while the quadratic centerline removes visible corners.
    const firstMidpoint = midpoint(points[0], points[1]);
    ctx.lineWidth = __penSegmentWidth(style, baseSize, points, 1);
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    ctx.lineTo(firstMidpoint.x, firstMidpoint.y);
    ctx.stroke();

    for (let i = 1; i < points.length - 1; i++) {
        const start = midpoint(points[i - 1], points[i]);
        const end = midpoint(points[i], points[i + 1]);
        const currentWidth = __penSegmentWidth(style, baseSize, points, i);
        const nextWidth = __penSegmentWidth(style, baseSize, points, i + 1);
        ctx.lineWidth = (currentWidth + nextWidth) / 2;
        ctx.beginPath();
        ctx.moveTo(start.x, start.y);
        ctx.quadraticCurveTo(points[i].x, points[i].y, end.x, end.y);
        ctx.stroke();
    }

    const lastIndex = points.length - 1;
    const lastMidpoint = midpoint(points[lastIndex - 1], points[lastIndex]);
    ctx.lineWidth = __penSegmentWidth(style, baseSize, points, lastIndex);
    ctx.beginPath();
    ctx.moveTo(lastMidpoint.x, lastMidpoint.y);
    ctx.lineTo(points[lastIndex].x, points[lastIndex].y);
    ctx.stroke();
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
        __drawImageContained(ctx, media.image, left, top, width, height);
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

    ctx.fillStyle = isLight ? '#e8e8eb' : '#12141b';
    ctx.fillRect(left, top, width, height);
    if (media?.ready) {
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        // Never stretch legacy or malformed media bounds. Current captures are
        // aspect-locked, while this remains a safe fallback for older drawings.
        __drawImageContained(ctx, media.image, left, top, width, height);
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
    ctx.restore();

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

function __visibleWorldRect(state, canvas) {
    const ratio = __pixelRatio();
    const scale = state.transform.scale;
    if (!Number.isFinite(scale) || scale <= 0) return null;

    const cssWidth = canvas.width / ratio;
    const cssHeight = canvas.height / ratio;
    return {
        left: (0 - state.transform.offsetX) / scale - __CULL_MARGIN,
        top: (0 - state.transform.offsetY) / scale - __CULL_MARGIN,
        right: (cssWidth - state.transform.offsetX) / scale + __CULL_MARGIN,
        bottom: (cssHeight - state.transform.offsetY) / scale + __CULL_MARGIN
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

// Selection mutates existing path objects in place, so path identity stops
// being enough to tell whether the cached layer is stale. That was handled by
// refusing to cache at all while the Select tool was active, which meant every
// frame redrew the whole document - including the great majority of frames
// where the tool was merely selected and nothing was being dragged. Tracking
// the drag itself keeps the cache for the idle case and still rebuilds for the
// frame after a drag ends, when the final positions have to be baked in.
let __selectionWasActive = false;

function __activeSelectionAction(state) {
    if (state.currentTool !== 'select') return null;
    return state.selection?.action || null;
}

function __committedLayerIsCurrent(state, canvas) {
    const meta = __committedLayerMeta;
    if (!meta || !__committedLayerCtx) return false;

    return meta.width === canvas.width &&
        meta.height === canvas.height &&
        __sameTransform(meta, state.transform) &&
        __samePathReferences(meta.paths, state.paths);
}

function __rebuildCommittedLayer(state, canvas) {
    if (!__committedLayerCtx) return false;

    if (__committedLayer.width !== canvas.width) __committedLayer.width = canvas.width;
    if (__committedLayer.height !== canvas.height) __committedLayer.height = canvas.height;

    const ratio = __pixelRatio();
    __committedLayerCtx.setTransform(1, 0, 0, 1, 0, 0);
    __committedLayerCtx.clearRect(0, 0, __committedLayer.width, __committedLayer.height);
    __committedLayerCtx.setTransform(
        state.transform.scale * ratio,
        0,
        0,
        state.transform.scale * ratio,
        state.transform.offsetX * ratio,
        state.transform.offsetY * ratio
    );
    const viewport = __visibleWorldRect(state, canvas);
    state.paths.forEach((path) => {
        if (!__pathIsVisible(path, viewport)) return;
        __drawStoredPath(__committedLayerCtx, path);
    });

    __committedLayerMeta = {
        width: canvas.width,
        height: canvas.height,
        scale: state.transform.scale,
        offsetX: state.transform.offsetX,
        offsetY: state.transform.offsetY,
        paths: state.paths.slice()
    };
    return true;
}

function __paintDrawingLayer(state, canvas) {
    const ratio = __pixelRatio();
    drawingCtx.setTransform(1, 0, 0, 1, 0, 0);
    // A live eraser intentionally switches the context to destination-out.
    // Canvas state survives between frames, so restore the neutral composite
    // state before painting the cached committed layer on the next frame.
    drawingCtx.globalCompositeOperation = 'source-over';
    drawingCtx.globalAlpha = 1;
    drawingCtx.clearRect(0, 0, canvas.width, canvas.height);

    const selectionAction = __activeSelectionAction(state);
    const selectionDirty = !!selectionAction || __selectionWasActive;
    __selectionWasActive = !!selectionAction;

    if (selectionDirty || !__committedLayerIsCurrent(state, canvas)) {
        __rebuildCommittedLayer(state, canvas);
    }

    if (__committedLayerCtx) {
        drawingCtx.drawImage(__committedLayer, 0, 0);
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

    if (state.isDrawing && state.currentPath) {
        __drawStoredPath(drawingCtx, state.currentPath);
    }
    if (state.handPath) {
        __drawStoredPath(drawingCtx, state.handPath);
    }
    if (window.Inkyscib?.Selection?.drawOverlay) {
        window.Inkyscib.Selection.drawOverlay(drawingCtx);
    }
    // Compass preview, snap indicator and intersection candidates are live
    // state, so they are drawn every frame rather than baked into the
    // committed layer.
    if (window.Inkyscib?.ConstructionRender?.drawOverlay) {
        window.Inkyscib.ConstructionRender.drawOverlay(drawingCtx);
    }
}

function renderCanvasFrame() {
    const state = window.appState;
    if (!state) return;
    
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

    if (state.ppt?.active && typeof window.clampPptTransform === 'function') {
        window.clampPptTransform();
    } else if (state.notebook?.active && typeof window.clampNotebookTransform === 'function') {
        window.clampNotebookTransform();
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

    if (typeof window.dispatchAppEvent === 'function') {
        window.dispatchAppEvent('canvasRendered', {});
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
window.bakeInkyscibEraserMasks = __bakeStandaloneErasersIntoPaths;
window.invalidateCanvasDrawingCache = invalidateCanvasDrawingCache;
window.invalidateCanvasBackground = invalidateCanvasBackground;
window.addEventListener("resize", () => {
    invalidateCanvasBackground();
    invalidateCanvasDrawingCache();
    requestCanvasRender();
});

