(function () {
    "use strict";

    const HANDLE_SIZE = 9;
    const ROTATE_OFFSET = 34;
    const MIN_SIZE = 6;
    const MARQUEE_THRESHOLD = 6;
    const YOUTUBE_FRAME_DEFAULT_ASPECT = 16 / 9;
    let lastYouTubeFrameTap = null;
    let lastTouchPointerAt = 0;
    let redrawFrame = null;

    function state() {
        return window.appState;
    }

    function canvas() {
        return document.getElementById("drawingCanvas");
    }

    function requestRedraw() {
        if (redrawFrame !== null) return;
        redrawFrame = requestAnimationFrame(() => {
            redrawFrame = null;
            if (typeof window.render === "function") window.render();
        });
    }

    function safeSave() {
        if (typeof window.saveDrawing === "function") window.saveDrawing();
    }

    // Media paths are the ones stored as an image inside two corner points:
    // a captured video moment, or a picture the user inserted. They move,
    // resize and hit-test the same way, so the whole file asks this rather
    // than naming one tool.
    const MEDIA_TOOLS = ["youtube-frame", "image"];

    function isMediaPath(path) {
        return !!path && MEDIA_TOOLS.includes(path.tool);
    }

    function clonePath(path) {
        if (isMediaPath(path)) {
            return {
                ...path,
                points: (path.points || []).map((point) => ({ ...point }))
            };
        }
        return JSON.parse(JSON.stringify(path));
    }

    function currentScale() {
        return Math.max(0.01, state()?.transform?.scale || 1);
    }

    function worldSize(screenPx) {
        return screenPx / currentScale();
    }

    function finitePoint(point) {
        return point && Number.isFinite(point.x) && Number.isFinite(point.y);
    }

    function isSmartGeometry(path) {
        const geometry = window.Inkyscib?.SmartGeometry;
        if (typeof geometry?.isSmartGeometry === "function") {
            return geometry.isSmartGeometry(path);
        }

        const version = Number(path?.geometryVersion);
        if (!path || path.tool !== "shape" || version !== 1) return false;
        if (path.geometryKind !== path.shapeType) return false;
        if (path.geometryKind === "circle") return Array.isArray(path.points) && path.points.length >= 2;
        if (path.geometryKind === "triangle") return Array.isArray(path.points) && path.points.length >= 3;
        return ["rectangle", "parallelogram", "rhombus", "kite"].includes(path.geometryKind) &&
            Array.isArray(path.points) &&
            path.points.length >= 4;
    }

    function isSmartPolygon(path) {
        return isSmartGeometry(path) && path.geometryKind !== "circle";
    }

    // Algebra-tile manipulatives are their own tool but behave like a plain
    // axis-aligned quad for everything the select tool cares about.
    function isManipulativeTile(path) {
        return !!path && path.tool === "manipulative" &&
            Array.isArray(path.points) && path.points.length >= 4;
    }

    function normalizeTransformedTile(path) {
        if (!isManipulativeTile(path)) return;
        window.Inkyscib?.Manipulatives?.normalizeTile?.(path);
    }

    function smartGeometryDisplayPoints(path) {
        const geometry = window.Inkyscib?.SmartGeometry;
        if (typeof geometry?.geometryDisplayPoints === "function") {
            const points = geometry.geometryDisplayPoints(path);
            return Array.isArray(points) ? points.filter(finitePoint) : [];
        }
        if (geometry?.isSmartCircle?.(path) && typeof geometry.circleDisplayPoints === "function") {
            const points = geometry.circleDisplayPoints(path);
            return Array.isArray(points) ? points.filter(finitePoint) : [];
        }
        const vertexCount = path?.geometryKind === "triangle" ? 3 : 4;
        return (path?.points || []).filter(finitePoint).slice(0, vertexCount);
    }

    function normalizeTransformedSmartGeometry(path) {
        if (!isSmartGeometry(path)) return;
        const geometry = window.Inkyscib?.SmartGeometry;
        if (typeof geometry?.normalizeSmartGeometry === "function") {
            geometry.normalizeSmartGeometry(path);
        } else if (typeof geometry?.normalizeGeometryAfterTransform === "function") {
            geometry.normalizeGeometryAfterTransform(path);
        } else if (geometry?.isSmartCircle?.(path) && typeof geometry.normalizeCircle === "function") {
            geometry.normalizeCircle(path);
        }
    }

    function rotatePoint(point, center, angle) {
        const s = Math.sin(angle);
        const c = Math.cos(angle);
        const dx = point.x - center.x;
        const dy = point.y - center.y;
        return {
            x: center.x + dx * c - dy * s,
            y: center.y + dx * s + dy * c
        };
    }

    function normalizeBounds(bounds) {
        if (!bounds) return null;
        const left = Math.min(bounds.left, bounds.right);
        const right = Math.max(bounds.left, bounds.right);
        const top = Math.min(bounds.top, bounds.bottom);
        const bottom = Math.max(bounds.top, bounds.bottom);
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

    function expandBounds(bounds, pad) {
        if (!bounds) return null;
        return normalizeBounds({
            left: bounds.left - pad,
            right: bounds.right + pad,
            top: bounds.top - pad,
            bottom: bounds.bottom + pad
        });
    }

    // Construction geometry is centre+radius, not a polyline: points[0] is the
    // centre for arcs/circles, so a naive boundsFromPoints would collapse to a
    // zero-size box and the object would be unselectable.
    function constructionBounds(path) {
        const engine = window.Inkyscib?.GeometryEngine;
        const centre = path?.points?.[0];
        if (!centre) return null;

        if (path.geomType === "point") {
            const r = 6;
            return normalizeBounds({
                left: centre.x - r, right: centre.x + r,
                top: centre.y - r, bottom: centre.y + r
            });
        }

        if (path.geomType === "segment") {
            return boundsFromPoints(path.points || [], pathPadding(path));
        }

        const radius = Number(path.radius);
        if (!Number.isFinite(radius) || radius <= 0) return null;

        // A full circle spans the whole radius in every direction. For a partial
        // arc that is an over-estimate, but a loose box only makes the object
        // easier to grab; it never makes it unselectable.
        const pad = 4;
        return normalizeBounds({
            left: centre.x - radius - pad, right: centre.x + radius + pad,
            top: centre.y - radius - pad, bottom: centre.y + radius + pad
        });
    }

    function boundsFromPoints(points, padding = 0) {
        const valid = (points || []).filter(finitePoint);
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

        return expandBounds(normalizeBounds({ left, right, top, bottom }), padding);
    }

    function unionBounds(boundsList) {
        const valid = boundsList.filter(Boolean);
        if (!valid.length) return null;

        return normalizeBounds({
            left: Math.min(...valid.map((bounds) => bounds.left)),
            right: Math.max(...valid.map((bounds) => bounds.right)),
            top: Math.min(...valid.map((bounds) => bounds.top)),
            bottom: Math.max(...valid.map((bounds) => bounds.bottom))
        });
    }

    function boundsIntersect(a, b) {
        if (!a || !b) return false;
        return a.left <= b.right &&
            a.right >= b.left &&
            a.top <= b.bottom &&
            a.bottom >= b.top;
    }

    function boundsContainsPoint(bounds, point) {
        return !!bounds &&
            point.x >= bounds.left &&
            point.x <= bounds.right &&
            point.y >= bounds.top &&
            point.y <= bounds.bottom;
    }

    function shapeBox(path) {
        const points = path?.points || [];

        if (isSmartPolygon(path)) {
            return boundsFromPoints(smartGeometryDisplayPoints(path));
        }

        if (points.length < 2) return null;

        const p1 = points[0];
        const p2 = points[1];
        if (!finitePoint(p1) || !finitePoint(p2)) return null;

        if (window.Inkyscib?.SmartGeometry?.isSmartCircle?.(path)) {
            const center = window.Inkyscib.SmartGeometry.circleCenter(path);
            const radius = Math.max(0, window.Inkyscib.SmartGeometry.circleRadius(path));
            return {
                left: center.x - radius,
                right: center.x + radius,
                top: center.y - radius,
                bottom: center.y + radius,
                width: radius * 2,
                height: radius * 2,
                center
            };
        }

        const center = {
            x: Number.isFinite(path.centerX) ? path.centerX : (p1.x + p2.x) / 2,
            y: Number.isFinite(path.centerY) ? path.centerY : (p1.y + p2.y) / 2
        };

        let width = Math.abs(p2.x - p1.x);
        let height = Math.abs(p2.y - p1.y);
        const clickSize = Math.max(MIN_SIZE, (path.size || 2) * 10);

        if (width < MIN_SIZE) {
            width = Number.isFinite(path.width) && path.width >= MIN_SIZE ? path.width : clickSize;
        }
        if (height < MIN_SIZE) {
            height = Number.isFinite(path.height) && path.height >= MIN_SIZE ? path.height : clickSize;
        }

        return {
            left: center.x - width / 2,
            right: center.x + width / 2,
            top: center.y - height / 2,
            bottom: center.y + height / 2,
            width,
            height,
            center
        };
    }

    function boxSigns(path) {
        const p1 = path?.points?.[0];
        const p2 = path?.points?.[1];
        return {
            signX: finitePoint(p1) && finitePoint(p2) && p2.x < p1.x ? -1 : 1,
            signY: finitePoint(p1) && finitePoint(p2) && p2.y < p1.y ? -1 : 1
        };
    }

    function setShapeBox(path, center, width, height, signX = 1, signY = 1) {
        const safeWidth = Math.max(MIN_SIZE, Math.abs(width));
        const safeHeight = Math.max(MIN_SIZE, Math.abs(height));

        if (window.Inkyscib?.SmartGeometry?.isSmartCircle?.(path)) {
            window.Inkyscib.SmartGeometry.setCircleGeometry(
                path,
                center,
                path.radiusLocked
                    ? window.Inkyscib.SmartGeometry.circleRadius(path)
                    : Math.max(safeWidth, safeHeight) / 2,
                path.radiusAngle || 0
            );
            return;
        }

        const left = center.x - safeWidth / 2;
        const right = center.x + safeWidth / 2;
        const top = center.y - safeHeight / 2;
        const bottom = center.y + safeHeight / 2;

        path.points = [
            {
                x: signX < 0 ? right : left,
                y: signY < 0 ? bottom : top
            },
            {
                x: signX < 0 ? left : right,
                y: signY < 0 ? top : bottom
            }
        ];
        path.width = safeWidth;
        path.height = safeHeight;
        path.centerX = center.x;
        path.centerY = center.y;
    }

    function triangleVertices(path, box) {
        const type = path.triangleType || "isosceles";

        if (type === "custom" || (path.points || []).length >= 3) {
            const points = (path.points || []).filter(finitePoint).slice(0, 3);
            if (path.previewPoint && points.length < 3 && finitePoint(path.previewPoint)) {
                points.push(path.previewPoint);
            }
            return points;
        }

        if (!box) return [];

        if (type === "right") {
            const p1 = path.points?.[0];
            const p2 = path.points?.[1];

            if (finitePoint(p1) && finitePoint(p2)) {
                return [
                    { x: p1.x, y: p1.y },
                    { x: p1.x, y: p2.y },
                    { x: p2.x, y: p2.y }
                ].map((point) => rotatePoint(point, box.center, path.rotation || 0));
            }

            return [
                { x: box.left, y: box.top },
                { x: box.left, y: box.bottom },
                { x: box.right, y: box.bottom }
            ].map((point) => rotatePoint(point, box.center, path.rotation || 0));
        }

        return [
            { x: box.center.x, y: box.top },
            { x: box.left, y: box.bottom },
            { x: box.right, y: box.bottom }
        ].map((point) => rotatePoint(point, box.center, path.rotation || 0));
    }

    function rectVertices(box, rotation) {
        if (!box) return [];
        return [
            { x: box.left, y: box.top },
            { x: box.right, y: box.top },
            { x: box.right, y: box.bottom },
            { x: box.left, y: box.bottom }
        ].map((point) => rotatePoint(point, box.center, rotation || 0));
    }

    function circleDisplayPoints(path) {
        if (window.Inkyscib?.SmartGeometry?.isSmartCircle?.(path)) {
            return window.Inkyscib.SmartGeometry.circleDisplayPoints(path);
        }
        const box = shapeBox(path);
        if (!box) return [];
        const radius = Math.max(box.width, box.height) / 2;
        const points = [];

        for (let i = 0; i < 20; i++) {
            const angle = (Math.PI * 2 * i) / 20;
            points.push({
                x: box.center.x + Math.cos(angle) * radius,
                y: box.center.y + Math.sin(angle) * radius
            });
        }

        return points;
    }

    function shapeDisplayPoints(path) {
        if (!path || path.tool !== "shape") return [];

        if (isSmartGeometry(path)) {
            return smartGeometryDisplayPoints(path);
        }

        if (path.shapeType === "triangle" && (path.triangleType === "custom" || (path.points || []).length >= 3)) {
            return (path.points || []).filter(finitePoint).slice(0, 3);
        }

        if (path.shapeType === "circle") {
            return circleDisplayPoints(path);
        }

        const box = shapeBox(path);
        if (!box) return [];

        if (path.shapeType === "triangle") {
            return triangleVertices(path, box);
        }

        return rectVertices(box, path.rotation || 0);
    }

    function pathPadding(path) {
        if (!path) return 0;
        if (path.tool === "eraser") return Math.max(4, (path.size || 2) / 2);
        if (path.tool === "highlight") return Math.max(4, (path.size || 2) / 1.4);
        if (path.tool === "pen") return Math.max(3, (path.size || 2) * 1.25);
        return Math.max(2, (path.size || 2) / 2);
    }

    function pathBounds(path) {
        if (!path) return null;
        if (path.componentBounds &&
            Number.isFinite(path.componentBounds.left) &&
            Number.isFinite(path.componentBounds.right) &&
            Number.isFinite(path.componentBounds.top) &&
            Number.isFinite(path.componentBounds.bottom)) {
            return normalizeBounds(path.componentBounds);
        }
        if (path.tool === "construction") return constructionBounds(path);
        if (path.tool === "line") return boundsFromPoints(path.points || [], pathPadding(path));
        if (path.tool === "manipulative") return boundsFromPoints(path.points || [], pathPadding(path));
        if (path.tool === "shape") return boundsFromPoints(shapeDisplayPoints(path), pathPadding(path));
        if (isMediaPath(path)) return boundsFromPoints(path.points || []);
        if (path.tool === "pen" || path.tool === "highlight" || path.tool === "eraser") {
            return boundsFromPoints(path.points || [], pathPadding(path));
        }
        return null;
    }

    function drawShapeOutline(ctx, path) {
        const isCustomTrianglePreview = path?.shapeType === "triangle" &&
            path?.triangleType === "custom" &&
            path?.previewPoint &&
            (path.points || []).length > 0;

        if (!path || !path.points || (path.points.length < 2 && !isCustomTrianglePreview)) return;

        ctx.save();
        ctx.strokeStyle = path.color || "#ffffff";
        ctx.lineWidth = Math.max(0.5, path.size || 2);
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.setLineDash([]);

        if (path.shapeType === "circle") {
            const box = shapeBox(path);
            if (!box) {
                ctx.restore();
                return;
            }
            const radius = Math.max(box.width, box.height) / 2;
            ctx.beginPath();
            ctx.arc(box.center.x, box.center.y, radius, 0, Math.PI * 2);
            ctx.stroke();
            ctx.restore();
            return;
        }

        if (path.shapeType === "square") {
            const box = shapeBox(path);
            const points = rectVertices(box, path.rotation || 0);
            if (points.length < 2) {
                ctx.restore();
                return;
            }
            ctx.beginPath();
            ctx.moveTo(points[0].x, points[0].y);
            points.slice(1).forEach((point) => ctx.lineTo(point.x, point.y));
            ctx.closePath();
            ctx.stroke();
            ctx.restore();
            return;
        }

        if (path.shapeType === "triangle") {
            const box = shapeBox(path);
            const points = triangleVertices(path, box);
            if (!points.length) {
                ctx.restore();
                return;
            }
            if (path.triangleType === "custom" && path.previewPoint && path.points.length < 3) {
                drawCustomTrianglePreview(ctx, path);
                ctx.restore();
                return;
            }
            ctx.beginPath();
            ctx.moveTo(points[0].x, points[0].y);
            points.slice(1).forEach((point) => ctx.lineTo(point.x, point.y));
            if (points.length >= 3) {
                ctx.closePath();
            }
            ctx.stroke();
        }

        ctx.restore();
    }

    function animatedPreviewDash() {
        const scale = currentScale();
        return {
            dash: [10 / scale, 7 / scale],
            offset: -((performance.now() / 55) % 17) / scale
        };
    }

    function drawCustomTrianglePreview(ctx, path) {
        const points = (path.points || []).filter(finitePoint).slice(0, 2);
        const preview = path.previewPoint;
        if (!points.length || !finitePoint(preview)) return;

        ctx.save();
        ctx.strokeStyle = path.color || "#ffffff";
        ctx.lineWidth = Math.max(0.5, path.size || 2);
        ctx.lineCap = "round";
        ctx.lineJoin = "round";

        if (points.length >= 2) {
            ctx.setLineDash([]);
            ctx.globalAlpha = 0.98;
            ctx.beginPath();
            ctx.moveTo(points[0].x, points[0].y);
            ctx.lineTo(points[1].x, points[1].y);
            ctx.stroke();
        }

        const previewDash = animatedPreviewDash();
        ctx.setLineDash(previewDash.dash);
        ctx.lineDashOffset = previewDash.offset;
        ctx.globalAlpha = 0.82;
        ctx.beginPath();
        ctx.moveTo(points[points.length - 1].x, points[points.length - 1].y);
        ctx.lineTo(preview.x, preview.y);
        if (points.length >= 2) {
            ctx.lineTo(points[0].x, points[0].y);
        }
        ctx.stroke();

        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
        ctx.fillStyle = path.color || "#ffffff";
        [...points, preview].forEach((point, index) => {
            const radius = index === points.length ? Math.max(2.2, (path.size || 2) * 0.72) : Math.max(1.8, (path.size || 2) * 0.55);
            ctx.beginPath();
            ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
            ctx.fill();
        });
        ctx.restore();
    }

    function pointLineDistance(point, a, b) {
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len2 = dx * dx + dy * dy;
        if (!len2) return Math.hypot(point.x - a.x, point.y - a.y);
        const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / len2));
        const px = a.x + dx * t;
        const py = a.y + dy * t;
        return Math.hypot(point.x - px, point.y - py);
    }

    function pointInPolygon(point, polygon) {
        let inside = false;
        for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
            const pi = polygon[i];
            const pj = polygon[j];
            const crosses = ((pi.y > point.y) !== (pj.y > point.y)) &&
                point.x < ((pj.x - pi.x) * (point.y - pi.y)) / ((pj.y - pi.y) || 1) + pi.x;
            if (crosses) inside = !inside;
        }
        return inside;
    }

    function polygonEdgeDistance(point, polygon) {
        if (!polygon.length) return Infinity;
        let min = Infinity;
        for (let i = 0; i < polygon.length; i++) {
            const a = polygon[i];
            const b = polygon[(i + 1) % polygon.length];
            min = Math.min(min, pointLineDistance(point, a, b));
        }
        return min;
    }

    function strokeDistance(point, path) {
        const points = (path.points || []).filter(finitePoint);
        if (!points.length) return Infinity;
        if (points.length === 1) return Math.hypot(point.x - points[0].x, point.y - points[0].y);

        let min = Infinity;
        for (let i = 1; i < points.length; i++) {
            min = Math.min(min, pointLineDistance(point, points[i - 1], points[i]));
        }
        return min;
    }

    function isEditable(path) {
        return path && (
            path.tool === "construction" ||
            path.tool === "line" ||
            path.tool === "shape" ||
            path.tool === "manipulative" ||
            path.tool === "pen" ||
            path.tool === "highlight" ||
            isMediaPath(path)
        );
    }

    function isEraserMask(path) {
        return path && path.tool === "eraser";
    }

    function embeddedErasers(path) {
        return Array.isArray(path?.erasers) ? path.erasers.filter(isEraserMask) : [];
    }

    function transformEmbeddedErasers(path, mapper, sizeScale = 1) {
        if (!Array.isArray(path?.erasers)) return;
        path.erasers.forEach((eraser) => {
            eraser.points = (eraser.points || []).map(mapper);
            if (Number.isFinite(eraser.size) && Number.isFinite(sizeScale)) {
                eraser.size = Math.max(0.5, eraser.size * sizeScale);
            }
        });
    }

    function hitLine(point, path, tolerance) {
        const points = path.points || [];
        if (points.length < 2) return false;
        return pointLineDistance(point, points[0], points[1]) <= tolerance + (path.size || 2) / 2;
    }

    function hitShape(point, path, tolerance) {
        if (path.shapeType === "circle") {
            const box = shapeBox(path);
            if (!box) return false;
            const radius = Math.max(box.width, box.height) / 2;
            const distance = Math.hypot(point.x - box.center.x, point.y - box.center.y);
            return distance <= radius + tolerance;
        }

        const points = shapeDisplayPoints(path);
        if (points.length < 3) return false;
        return pointInPolygon(point, points) || polygonEdgeDistance(point, points) <= tolerance + (path.size || 2) / 2;
    }

    function eraserCoversPoint(point, eraserPath) {
        if (!isEraserMask(eraserPath)) return false;
        return strokeDistance(point, eraserPath) <= pathPadding(eraserPath) + worldSize(2);
    }

    function isPointErasedForPath(point, pathIndex) {
        const s = state();
        if (!s || !Number.isInteger(pathIndex) || pathIndex < 0) return false;

        const path = s.paths[pathIndex];
        if (embeddedErasers(path).some((eraser) => eraserCoversPoint(point, eraser))) {
            return true;
        }

        for (let index = pathIndex + 1; index < s.paths.length; index++) {
            if (eraserCoversPoint(point, s.paths[index])) {
                return true;
            }
        }

        return false;
    }

    function hitPath(point, path, pathIndex = -1) {
        if (!isEditable(path)) return false;
        if (isPointErasedForPath(point, pathIndex)) return false;
        if (path.componentBounds && !boundsContainsPoint(expandBounds(pathBounds(path), worldSize(4)), point)) {
            return false;
        }

        const tolerance = worldSize(9);
        if (Array.isArray(path.componentPoints) && path.componentPoints.length > 0) {
            return strokeDistance(point, { points: path.componentPoints }) <= tolerance + pathPadding(path);
        }
        if (path.tool === "line") return hitLine(point, path, tolerance);
        if (path.tool === "manipulative") {
            const corners = (path.points || []).filter(finitePoint).slice(0, 4);
            if (corners.length < 3) return false;
            return pointInPolygon(point, corners) || polygonEdgeDistance(point, corners) <= tolerance;
        }
        if (path.tool === "construction") return hitConstruction(point, path, tolerance);
        if (path.tool === "shape") return hitShape(point, path, tolerance);
        if (isMediaPath(path)) return boundsContainsPoint(pathBounds(path), point);
        return strokeDistance(point, path) <= tolerance + pathPadding(path);
    }

    // An arc's points[] holds only its centre, so the generic polyline
    // strokeDistance would measure to the centre and never register a click on
    // the drawn curve. Hit the ring, then confirm the angle is inside the sweep.
    function hitConstruction(point, path, tolerance) {
        const engine = window.Inkyscib?.GeometryEngine;
        const centre = path?.points?.[0];
        if (!centre || !finitePoint(point)) return false;

        if (path.geomType === "point") {
            return Math.hypot(point.x - centre.x, point.y - centre.y) <= tolerance;
        }

        if (path.geomType === "segment") {
            return strokeDistance(point, path) <= tolerance;
        }

        const radius = Number(path.radius);
        if (!engine || !Number.isFinite(radius) || radius <= 0) return false;

        const fromCentre = Math.hypot(point.x - centre.x, point.y - centre.y);
        if (Math.abs(fromCentre - radius) > tolerance) return false;

        if (path.geomType === "circle" || path.full) return true;

        // tolerance is a world distance; convert to an angle at this radius so
        // the grab feels the same near either end of the arc
        return engine.angleInArc(
            engine.angleOf(centre, point),
            path.startAngle,
            path.endAngle,
            { tolerance: tolerance / radius }
        );
    }

    function hitEditablePath(point) {
        const paths = state()?.paths || [];
        for (let i = paths.length - 1; i >= 0; i--) {
            if (hitPath(point, paths[i], i)) return i;
        }
        return -1;
    }

    function pathSamplePoints(path) {
        if (!path) return [];

        if (isMediaPath(path)) {
            const bounds = pathBounds(path);
            if (!bounds) return [];
            return [
                { x: bounds.left, y: bounds.top },
                { x: bounds.right, y: bounds.top },
                { x: bounds.right, y: bounds.bottom },
                { x: bounds.left, y: bounds.bottom },
                bounds.center
            ];
        }

        if (path.tool === "manipulative") {
            const bounds = pathBounds(path);
            const points = (path.points || []).filter(finitePoint);
            return bounds ? [...points, bounds.center] : points;
        }

        if (path.tool === "construction") {
            const engine = window.Inkyscib?.GeometryEngine;
            const centre = path.points?.[0];
            if (!centre) return [];
            if (path.geomType === "point") return [centre];
            if (path.geomType === "segment") return (path.points || []).filter(finitePoint);

            const radius = Number(path.radius);
            if (!engine || !Number.isFinite(radius) || radius <= 0) return [centre];

            const full = path.geomType === "circle" || path.full;
            const start = full ? 0 : path.startAngle;
            const sweep = full ? Math.PI * 2 : engine.arcSweep(path.startAngle, path.endAngle);
            const steps = 12;
            const samples = [];
            for (let i = 0; i <= steps; i++) {
                samples.push(engine.pointOnCircleAt(centre, radius, start + (sweep * i) / steps));
            }
            return samples;
        }

        if (path.tool === "shape") {
            const points = shapeDisplayPoints(path);
            const bounds = pathBounds(path);
            return bounds ? [...points, bounds.center] : points;
        }

        const points = (
            Array.isArray(path.componentPoints) && path.componentPoints.length > 0
                ? path.componentPoints
                : path.points || []
        ).filter(finitePoint);
        const samples = [...points];

        for (let i = 1; i < points.length; i++) {
            samples.push({
                x: (points[i - 1].x + points[i].x) / 2,
                y: (points[i - 1].y + points[i].y) / 2
            });
        }

        return samples;
    }

    function pathHasVisiblePointInBounds(pathIndex, bounds) {
        const s = state();
        const path = s?.paths?.[pathIndex];
        if (!path || !bounds) return false;

        const relaxedBounds = expandBounds(bounds, pathPadding(path) + worldSize(4));
        return pathSamplePoints(path).some((point) => (
            boundsContainsPoint(relaxedBounds, point) &&
            !isPointErasedForPath(point, pathIndex)
        ));
    }

    function ensureSelection() {
        const s = state();
        if (!s.selection) {
            s.selection = { selectedIndex: -1, selectedIndices: [], hoverHandle: null, action: null };
        }
        if (!Array.isArray(s.selection.selectedIndices)) {
            s.selection.selectedIndices = Number.isInteger(s.selection.selectedIndex) && s.selection.selectedIndex >= 0
                ? [s.selection.selectedIndex]
                : [];
        }
        return s.selection;
    }

    function selectedIndices() {
        const s = state();
        if (!s) return [];
        const selection = ensureSelection();
        const unique = [];

        selection.selectedIndices.forEach((index) => {
            if (!Number.isInteger(index)) return;
            if (index < 0 || index >= s.paths.length) return;
            if (!isEditable(s.paths[index])) return;
            if (!unique.includes(index)) unique.push(index);
        });

        selection.selectedIndices = unique;
        selection.selectedIndex = unique.length ? unique[0] : -1;
        return unique;
    }

    function selectedIndex() {
        return selectedIndices()[0] ?? -1;
    }

    function selectedPath() {
        const index = selectedIndex();
        return index >= 0 ? state().paths[index] : null;
    }

    function setSelectedIndices(indices) {
        const s = state();
        const selection = ensureSelection();
        const unique = [];

        (indices || []).forEach((index) => {
            if (!Number.isInteger(index)) return;
            if (index < 0 || index >= s.paths.length) return;
            if (!isEditable(s.paths[index])) return;
            if (!unique.includes(index)) unique.push(index);
        });

        selection.selectedIndices = unique;
        selection.selectedIndex = unique.length ? unique[0] : -1;
        selection.hoverHandle = null;
    }

    function setSelectedIndex(index) {
        setSelectedIndices(Number.isInteger(index) && index >= 0 ? [index] : []);
    }

    function selectedBounds() {
        const s = state();
        return unionBounds(selectedIndices().map((index) => pathBounds(s.paths[index])));
    }

    function companionEraserIndices(indices, bounds) {
        const s = state();
        if (!s || !Array.isArray(indices) || !indices.length || !bounds) return [];

        const selectedSet = new Set(indices);
        const searchBounds = expandBounds(bounds, worldSize(10));
        const companions = [];

        s.paths.forEach((path, index) => {
            if (!isEraserMask(path) || selectedSet.has(index)) return;

            // Eraser paths only affect ink drawn before them in the render order.
            const canEraseSelectedInk = indices.some((selectedIndex) => selectedIndex < index);
            if (!canEraseSelectedInk) return;

            const eraserBounds = pathBounds(path);
            if (boundsIntersect(searchBounds, eraserBounds)) {
                companions.push(index);
            }
        });

        return companions;
    }

    function selectionHandles() {
        const indices = selectedIndices();
        const bounds = selectedBounds();
        if (!bounds) return [];

        const rotateY = bounds.top - worldSize(ROTATE_OFFSET);
        const containsYoutubeFrame = indices.some((index) => isMediaPath(state().paths[index]));
        const handles = containsYoutubeFrame
            ? []
            : [{ type: "rotate", x: bounds.center.x, y: rotateY }];

        if (indices.length === 1) {
            const path = state().paths[indices[0]];
            if (path.tool === "line" && !Array.isArray(path.componentPoints)) {
                const points = path.points || [];
                if (finitePoint(points[0])) handles.push({ type: "start", x: points[0].x, y: points[0].y });
                if (finitePoint(points[1])) handles.push({ type: "end", x: points[1].x, y: points[1].y });
                return handles;
            }
        }

        handles.push(
            { type: "nw", x: bounds.left, y: bounds.top },
            { type: "ne", x: bounds.right, y: bounds.top },
            { type: "se", x: bounds.right, y: bounds.bottom },
            { type: "sw", x: bounds.left, y: bounds.bottom }
        );
        return handles;
    }

    function handleAt(point) {
        const mediaSelected = selectedIndices().some((index) => isMediaPath(state().paths[index]));
        const hitSize = worldSize(mediaSelected ? 24 : HANDLE_SIZE + 4);
        return selectionHandles().find((handle) => Math.hypot(point.x - handle.x, point.y - handle.y) <= hitSize) || null;
    }

    function cursorForHandle(type) {
        if (type === "rotate") return "grab";
        if (type === "start" || type === "end") return "crosshair";
        if (type === "n" || type === "s") return "ns-resize";
        if (type === "e" || type === "w") return "ew-resize";
        if (type === "nw" || type === "se") return "nwse-resize";
        if (type === "ne" || type === "sw") return "nesw-resize";
        return "move";
    }

    function updateCursor(cursorValue) {
        const el = canvas();
        if (el) el.style.cursor = cursorValue;
    }

    function youtubeFrameAspect(path) {
        const aspect = Number(path?.aspectRatio);
        return Number.isFinite(aspect) && aspect > 0
            ? aspect
            : YOUTUBE_FRAME_DEFAULT_ASPECT;
    }

    function makeResizeBounds(bounds, handle, point, preserveAspect = false, preferredAspect = null) {
        if (preserveAspect) {
            const anchorX = handle.includes("w") ? bounds.right : bounds.left;
            const anchorY = handle.includes("n") ? bounds.bottom : bounds.top;
            const directionX = handle.includes("w") ? -1 : 1;
            const directionY = handle.includes("n") ? -1 : 1;
            const currentAspect = bounds.width / Math.max(1, bounds.height);
            const aspect = Number.isFinite(preferredAspect) && preferredAspect > 0
                ? preferredAspect
                : Math.max(0.01, currentAspect);
            const pointerWidth = Math.max(0, directionX * (point.x - anchorX));
            const pointerHeight = Math.max(0, directionY * (point.y - anchorY));

            let height = Math.max(pointerHeight, pointerWidth / aspect);
            height = Math.max(height, MIN_SIZE, MIN_SIZE / aspect);
            const width = height * aspect;
            const edgeX = anchorX + directionX * width;
            const edgeY = anchorY + directionY * height;

            return normalizeBounds({
                left: anchorX,
                right: edgeX,
                top: anchorY,
                bottom: edgeY
            });
        }

        let left = bounds.left;
        let right = bounds.right;
        let top = bounds.top;
        let bottom = bounds.bottom;

        if (handle.includes("w")) left = point.x;
        if (handle.includes("e")) right = point.x;
        if (handle.includes("n")) top = point.y;
        if (handle.includes("s")) bottom = point.y;

        if (right < left) [left, right] = [right, left];
        if (bottom < top) [top, bottom] = [bottom, top];

        if (right - left < MIN_SIZE) {
            if (handle.includes("w")) left = right - MIN_SIZE;
            else right = left + MIN_SIZE;
        }
        if (bottom - top < MIN_SIZE) {
            if (handle.includes("n")) top = bottom - MIN_SIZE;
            else bottom = top + MIN_SIZE;
        }

        return normalizeBounds({ left, right, top, bottom });
    }

    function translatePath(path, dx, dy) {
        path.points = (path.points || []).map((point) => ({ ...point, x: point.x + dx, y: point.y + dy }));
        if (Array.isArray(path.componentPoints)) {
            path.componentPoints = path.componentPoints.map((point) => ({ ...point, x: point.x + dx, y: point.y + dy }));
        }
        if (path.componentBounds) {
            path.componentBounds = {
                left: path.componentBounds.left + dx,
                right: path.componentBounds.right + dx,
                top: path.componentBounds.top + dy,
                bottom: path.componentBounds.bottom + dy
            };
        }
        if (Number.isFinite(path.centerX)) path.centerX += dx;
        if (Number.isFinite(path.centerY)) path.centerY += dy;
        transformEmbeddedErasers(path, (point) => ({ ...point, x: point.x + dx, y: point.y + dy }));
        normalizeTransformedSmartGeometry(path);
    }

    function scalePoint(point, fromBounds, toBounds) {
        const sx = toBounds.width / Math.max(1, fromBounds.width);
        const sy = toBounds.height / Math.max(1, fromBounds.height);
        return {
            ...point,
            x: toBounds.left + (point.x - fromBounds.left) * sx,
            y: toBounds.top + (point.y - fromBounds.top) * sy
        };
    }

    function transformBounds(bounds, mapper) {
        if (!bounds) return null;
        return boundsFromPoints([
            { x: bounds.left, y: bounds.top },
            { x: bounds.right, y: bounds.top },
            { x: bounds.right, y: bounds.bottom },
            { x: bounds.left, y: bounds.bottom }
        ].map(mapper));
    }

    function resizeStrokeScale(fromBounds, toBounds) {
        const sx = Math.abs(toBounds.width / Math.max(1, fromBounds.width));
        const sy = Math.abs(toBounds.height / Math.max(1, fromBounds.height));
        return Math.sqrt(sx * sy);
    }

    function scalePathStrokeWidths(path, sizeScale) {
        if (!Number.isFinite(sizeScale) || sizeScale <= 0) return;
        if (Number.isFinite(path.size)) {
            path.size = Math.max(0.5, path.size * sizeScale);
        }
        transformEmbeddedErasers(path, (point) => point, sizeScale);
    }

    function scalePathToBounds(path, fromBounds, toBounds) {
        if (!fromBounds || !toBounds) return;
        const sizeScale = resizeStrokeScale(fromBounds, toBounds);

        if (path.tool === "shape" &&
            !isSmartPolygon(path) &&
            !(path.shapeType === "triangle" && (path.triangleType === "custom" || (path.points || []).length >= 3))) {
            const box = shapeBox(path);
            if (!box) return;
            const center = scalePoint(box.center, fromBounds, toBounds);
            const width = box.width * (toBounds.width / Math.max(1, fromBounds.width));
            const height = box.height * (toBounds.height / Math.max(1, fromBounds.height));
            const signs = boxSigns(path);
            setShapeBox(path, center, width, height, signs.signX, signs.signY);
            transformEmbeddedErasers(path, (point) => scalePoint(point, fromBounds, toBounds));
            scalePathStrokeWidths(path, sizeScale);
            normalizeTransformedSmartGeometry(path);
            return;
        }

        path.points = (path.points || []).map((point) => scalePoint(point, fromBounds, toBounds));
        if (Array.isArray(path.componentPoints)) {
            path.componentPoints = path.componentPoints.map((point) => scalePoint(point, fromBounds, toBounds));
            path.componentBounds = transformBounds(
                path.componentBounds,
                (point) => scalePoint(point, fromBounds, toBounds)
            );
        }
        if (Number.isFinite(path.centerX) && Number.isFinite(path.centerY)) {
            const center = scalePoint({ x: path.centerX, y: path.centerY }, fromBounds, toBounds);
            path.centerX = center.x;
            path.centerY = center.y;
        }
        transformEmbeddedErasers(path, (point) => scalePoint(point, fromBounds, toBounds));
        scalePathStrokeWidths(path, sizeScale);
        normalizeTransformedSmartGeometry(path);
        normalizeTransformedTile(path);
    }

    function rotatePathForGroup(path, center, angle) {
        if (path.tool === "shape" &&
            !isSmartPolygon(path) &&
            !(path.shapeType === "triangle" && (path.triangleType === "custom" || (path.points || []).length >= 3))) {
            const box = shapeBox(path);
            if (!box) return;
            const nextCenter = rotatePoint(box.center, center, angle);
            const signs = boxSigns(path);
            setShapeBox(path, nextCenter, box.width, box.height, signs.signX, signs.signY);
            path.rotation = (path.rotation || 0) + angle;
            transformEmbeddedErasers(path, (point) => rotatePoint(point, center, angle));
            normalizeTransformedSmartGeometry(path);
            return;
        }

        path.points = (path.points || []).map((point) => rotatePoint(point, center, angle));
        if (Array.isArray(path.componentPoints)) {
            path.componentPoints = path.componentPoints.map((point) => rotatePoint(point, center, angle));
            path.componentBounds = transformBounds(
                path.componentBounds,
                (point) => rotatePoint(point, center, angle)
            );
        }
        if (Number.isFinite(path.centerX) && Number.isFinite(path.centerY)) {
            const nextCenter = rotatePoint({ x: path.centerX, y: path.centerY }, center, angle);
            path.centerX = nextCenter.x;
            path.centerY = nextCenter.y;
        }
        transformEmbeddedErasers(path, (point) => rotatePoint(point, center, angle));
        if (isSmartGeometry(path)) {
            path.rotation = (Number.isFinite(path.rotation) ? path.rotation : 0) + angle;
        }
        normalizeTransformedSmartGeometry(path);
        normalizeTransformedTile(path);
    }

    function beginAction(mode, handle, point) {
        const s = state();
        const indices = selectedIndices();
        if (!indices.length) return false;

        const bounds = selectedBounds();
        if (!bounds) return false;

        const selection = ensureSelection();
        const eraserCompanions = [];
        const transformIndices = [...indices]
            .filter((index, position, list) => list.indexOf(index) === position)
            .sort((a, b) => a - b);

        selection.action = {
            mode,
            handle,
            indices,
            eraserCompanions,
            transformIndices,
            startPoint: point,
            startBounds: bounds,
            center: bounds.center,
            startAngle: Math.atan2(point.y - bounds.center.y, point.x - bounds.center.x),
            originalPaths: transformIndices.map((index) => ({ index, path: clonePath(s.paths[index]) })),
            moved: false
        };
        return true;
    }

    function beginMarquee(point) {
        const selection = ensureSelection();
        setSelectedIndices([]);
        selection.action = {
            mode: "marquee",
            startPoint: point,
            currentPoint: point,
            moved: false
        };
        requestRedraw();
        return true;
    }

    function marqueeBounds(action) {
        if (!action || action.mode !== "marquee") return null;
        return normalizeBounds({
            left: action.startPoint.x,
            right: action.currentPoint.x,
            top: action.startPoint.y,
            bottom: action.currentPoint.y
        });
    }

    function selectWithinMarquee(bounds) {
        const s = state();
        if (!bounds || bounds.width < worldSize(MARQUEE_THRESHOLD) || bounds.height < worldSize(MARQUEE_THRESHOLD)) {
            setSelectedIndices([]);
            return;
        }

        const selected = [];
        s.paths.forEach((path, index) => {
            if (!isEditable(path)) return;
            const boundsForPath = pathBounds(path);
            if (boundsIntersect(bounds, boundsForPath) && pathHasVisiblePointInBounds(index, bounds)) selected.push(index);
        });
        setSelectedIndices(selected);
    }

    function applyAction(point) {
        const s = state();
        const action = s?.selection?.action;
        if (!action) return false;

        const dx = point.x - action.startPoint.x;
        const dy = point.y - action.startPoint.y;
        action.moved = action.moved || Math.hypot(dx, dy) > worldSize(1.5);

        if (action.mode === "marquee") {
            action.currentPoint = point;
            requestRedraw();
            return true;
        }

        const youtubeFrames = action.originalPaths.filter((entry) => isMediaPath(entry.path));
        const preserveResizeAspect = youtubeFrames.length > 0 ||
            action.originalPaths.some((entry) => embeddedErasers(entry.path).length > 0) ||
            action.originalPaths.some((entry) => isSmartGeometry(entry.path));
        const preferredResizeAspect = action.indices.length === 1 && youtubeFrames.length === 1
            ? youtubeFrameAspect(youtubeFrames[0].path)
            : null;
        const nextBounds = action.mode === "resize"
            ? makeResizeBounds(
                action.startBounds,
                action.handle,
                point,
                preserveResizeAspect,
                preferredResizeAspect
            )
            : null;
        const angle = action.mode === "rotate"
            ? Math.atan2(point.y - action.center.y, point.x - action.center.x)
            : 0;
        const delta = action.mode === "rotate" ? angle - action.startAngle : 0;

        action.originalPaths.forEach((entry) => {
            if (entry.index < 0 || entry.index >= s.paths.length) return;
            const updated = clonePath(entry.path);

            if (isMediaPath(updated)) {
                updated.aspectRatio = youtubeFrameAspect(updated);
            }

            if (action.mode === "move") {
                translatePath(updated, dx, dy);
            }

            if (action.mode === "resize") {
                const singleLineEndpoint = action.indices.length === 1 &&
                    updated.tool === "line" &&
                    (action.handle === "start" || action.handle === "end");

                if (singleLineEndpoint) {
                    if (action.handle === "start") updated.points[0] = point;
                    if (action.handle === "end") updated.points[1] = point;
                } else {
                    scalePathToBounds(updated, action.startBounds, nextBounds);
                }
            }

            if (action.mode === "rotate") {
                rotatePathForGroup(updated, action.center, delta);
            }

            s.paths[entry.index] = updated;
        });

        requestRedraw();
        return true;
    }

    function endAction() {
        const s = state();
        const action = s?.selection?.action;
        if (!action) return false;

        s.selection.action = null;

        if (action.mode === "move" && !action.moved && action.indices.length === 1) {
            const index = action.indices[0];
            const path = s.paths[index];
            if (isMediaPath(path)) {
                const now = performance.now();
                const isDoubleTap = lastYouTubeFrameTap &&
                    lastYouTubeFrameTap.index === index &&
                    now - lastYouTubeFrameTap.at <= 430 &&
                    Math.hypot(
                        action.startPoint.x - lastYouTubeFrameTap.point.x,
                        action.startPoint.y - lastYouTubeFrameTap.point.y
                    ) <= worldSize(24);

                if (isDoubleTap) {
                    lastYouTubeFrameTap = null;
                    window.Inkyscib?.YouTube?.openFrame?.(path);
                } else {
                    lastYouTubeFrameTap = { index, at: now, point: action.startPoint };
                }
            } else {
                lastYouTubeFrameTap = null;
            }
        }

        if (action.mode === "marquee") {
            if (action.moved) {
                selectWithinMarquee(marqueeBounds(action));
            } else {
                setSelectedIndices([]);
            }
            updateHoverCursor();
            requestRedraw();
            return true;
        }

        if (action.moved) {
            if (typeof window.commitHistory === "function") {
                // Reconstruct the pre-move paths from the originals captured at drag start.
                const before = typeof window.captureHistory === "function" ? window.captureHistory() : s.paths.slice();
                (action.originalPaths || []).forEach(({ index, path }) => {
                    if (index >= 0 && index < before.length) before[index] = path;
                });
                window.commitHistory(before);
            } else {
                s.redoStack = [];
            }
            safeSave();
        }
        updateHoverCursor();
        return true;
    }

    function worldPointFromEvent(e) {
        return typeof window.getCanvasPos === "function" ? window.getCanvasPos(e) : { x: e.clientX, y: e.clientY };
    }

    function selectedContainsHit(point) {
        const s = state();
        return selectedIndices().some((index) => hitPath(point, s.paths[index], index));
    }

    function updateHoverCursor(e = null) {
        const s = state();
        if (!s || s.currentTool !== "select" || s.panMode) return false;
        if (s.selection?.action) return true;

        if (!e) {
            updateCursor("default");
            return true;
        }

        const point = worldPointFromEvent(e);
        const handle = handleAt(point);

        if (handle) {
            s.selection.hoverHandle = handle.type;
            updateCursor(cursorForHandle(handle.type));
            return true;
        }

        if (selectedContainsHit(point) || boundsContainsPoint(selectedBounds(), point)) {
            s.selection.hoverHandle = "move";
            updateCursor("move");
            return true;
        }

        const hitIndex = hitEditablePath(point);
        s.selection.hoverHandle = hitIndex >= 0 ? "move" : "marquee";
        updateCursor(hitIndex >= 0 ? "move" : "crosshair");
        return true;
    }

    function handleDown(e) {
        const s = state();
        if (!s || s.currentTool !== "select" || s.panMode || s.clearAnimation) return false;

        if (e?.pointerType && e.pointerType !== "mouse") {
            lastTouchPointerAt = performance.now();
        } else if (performance.now() - lastTouchPointerAt < 700) {
            // A touch pointer is followed by a synthetic mouse event in some
            // browsers. Treat both as one tap so a single tap cannot trigger
            // the frame's double-tap action.
            return true;
        }

        if (typeof window.closeAllToolboxes === "function") window.closeAllToolboxes();

        const point = worldPointFromEvent(e);
        const handle = handleAt(point);

        if (handle) {
            const mode = handle.type === "rotate" ? "rotate" : "resize";
            beginAction(mode, handle.type, point);
            updateCursor(cursorForHandle(handle.type));
            requestRedraw();
            return true;
        }

        if (selectedIndices().length && (selectedContainsHit(point) || boundsContainsPoint(selectedBounds(), point))) {
            beginAction("move", "move", point);
            updateCursor("move");
            requestRedraw();
            return true;
        }

        const hitIndex = hitEditablePath(point);
        if (hitIndex >= 0) {
            if (!selectedIndices().includes(hitIndex)) {
                setSelectedIndex(hitIndex);
            }
            beginAction("move", "move", point);
            updateCursor("move");
        } else {
            beginMarquee(point);
            updateCursor("crosshair");
        }

        requestRedraw();
        return true;
    }

    function handleMove(e) {
        const s = state();
        if (!s || s.currentTool !== "select") return false;
        if (s.selection?.action) {
            applyAction(worldPointFromEvent(e));
            return true;
        }
        return updateHoverCursor(e);
    }

    function handleUp() {
        return endAction();
    }

    function clear(options = {}) {
        const s = state();
        if (!s) return;
        const selection = ensureSelection();
        selection.selectedIndex = -1;
        selection.selectedIndices = [];
        selection.hoverHandle = null;
        selection.action = null;
        updateCursor(s.currentTool === "select" ? "default" : "");
        if (options.render !== false) requestRedraw();
    }

    function deleteSelected() {
        const s = state();
        const indices = selectedIndices().slice().sort((a, b) => b - a);
        if (!indices.length) return false;

        if (typeof window.commitHistory === "function") window.commitHistory();
        else s.redoStack = [];
        indices.forEach((index) => s.paths.splice(index, 1));
        clear({ render: false });
        requestRedraw();
        safeSave();
        return true;
    }

    function drawHandle(ctx, handle, radius) {
        ctx.beginPath();
        if (handle.type === "rotate") {
            ctx.arc(handle.x, handle.y, radius * 0.9, 0, Math.PI * 2);
        } else {
            ctx.roundRect(handle.x - radius, handle.y - radius, radius * 2, radius * 2, radius * 0.55);
        }
        ctx.fill();
        ctx.stroke();
    }

    function drawMarquee(ctx, action) {
        const bounds = marqueeBounds(action);
        if (!bounds || bounds.width < 0.1 || bounds.height < 0.1) return;

        const scale = currentScale();
        const dash = animatedPreviewDash();
        ctx.save();
        ctx.lineWidth = 1.25 / scale;
        ctx.strokeStyle = "rgba(126, 119, 255, 0.96)";
        ctx.fillStyle = "rgba(90, 90, 255, 0.11)";
        ctx.setLineDash(dash.dash);
        ctx.lineDashOffset = dash.offset;
        ctx.fillRect(bounds.left, bounds.top, bounds.width, bounds.height);
        ctx.strokeRect(bounds.left, bounds.top, bounds.width, bounds.height);
        ctx.restore();
    }

    function drawOverlay(ctx) {
        const s = state();
        if (!s || s.currentTool !== "select" || s.clearAnimation) return;

        if (s.selection?.action?.mode === "marquee") {
            drawMarquee(ctx, s.selection.action);
            return;
        }

        const bounds = selectedBounds();
        if (!bounds) return;

        const scale = currentScale();
        const lineWidth = 1.35 / scale;
        const mediaSelected = selectedIndices().some((index) => isMediaPath(s.paths[index]));
        const handleRadius = worldSize(mediaSelected ? 8 : HANDLE_SIZE / 2);
        const handles = selectionHandles();
        const rotateHandle = handles.find((handle) => handle.type === "rotate");

        ctx.save();
        ctx.lineWidth = lineWidth;
        ctx.strokeStyle = "rgba(126, 119, 255, 0.95)";
        ctx.fillStyle = "rgba(10, 12, 20, 0.92)";
        ctx.shadowColor = "rgba(91, 91, 255, 0.38)";
        ctx.shadowBlur = 8 / scale;

        if (selectedIndices().length > 1) {
            ctx.save();
            ctx.globalAlpha = 0.62;
            ctx.setLineDash([4 / scale, 5 / scale]);
            selectedIndices().forEach((index) => {
                const itemBounds = pathBounds(s.paths[index]);
                if (itemBounds) {
                    ctx.strokeRect(itemBounds.left, itemBounds.top, itemBounds.width || lineWidth, itemBounds.height || lineWidth);
                }
            });
            ctx.restore();
        }

        ctx.setLineDash([7 / scale, 5 / scale]);
        ctx.strokeRect(bounds.left, bounds.top, bounds.width || lineWidth, bounds.height || lineWidth);
        ctx.setLineDash([]);

        if (rotateHandle) {
            ctx.beginPath();
            ctx.moveTo(bounds.center.x, bounds.top);
            ctx.lineTo(rotateHandle.x, rotateHandle.y);
            ctx.stroke();
        }

        handles.forEach((handle) => drawHandle(ctx, handle, handleRadius));
        ctx.restore();
    }

    function initSelectTool() {
        const selectTool = document.getElementById("selectTool");
        if (!selectTool) return;

        selectTool.onclick = () => {
            if (typeof window.closeAllToolboxes === "function") window.closeAllToolboxes();
            if (typeof window.setTool === "function") window.setTool("select");
        };
    }

    window.Inkyscib = window.Inkyscib || {};
    window.Inkyscib.Geometry = {
        rotatePoint,
        boundsFromPoints,
        unionBounds,
        shapeBox,
        shapeDisplayPoints,
        pathBounds,
        drawShapeOutline,
        pointLineDistance,
        pointInPolygon,
        polygonEdgeDistance
    };
    window.Inkyscib.Selection = {
        initSelectTool,
        handleDown,
        handleMove,
        handleUp,
        clear,
        deleteSelected,
        drawOverlay,
        selectedIndex,
        selectedIndices,
        selectedPath,
        selectedBounds,
        selectIndex: setSelectedIndex,
        hitEditablePath,
        updateHoverCursor
    };

    document.addEventListener("DOMContentLoaded", initSelectTool);
})();
