function initLineTool() {
    const lineTool = document.getElementById('lineTool');
    const lineSize = document.getElementById('lineSize');
    const lineSizeInput = document.getElementById('lineSizeInput');
    const lineCustomColor = document.getElementById('lineCustomColor');
    const arrowStylesPanel = document.getElementById('arrowStyles');
    const arrowStylesSection = document.getElementById('arrowStylesSection');

    let lineClickTimer = null;
    // legacy: 'arrow' was a line type; it is now a separate arrow tip
    if (window.appState.toolSettings.line.lineType === 'arrow') {
        window.appState.toolSettings.line.lineType = 'solid';
        if (!window.appState.toolSettings.line.arrowStyle ||
            window.appState.toolSettings.line.arrowStyle === 'none') {
            window.appState.toolSettings.line.arrowStyle = 'triangle';
        }
    }
    if (!window.appState.toolSettings.line.arrowStyle) {
        window.appState.toolSettings.line.arrowStyle = 'none';
    }
    if (!window.appState.toolSettings.line.lineType) {
        window.appState.toolSettings.line.lineType = 'solid';
    }
    if (!window.appState.toolSettings.line.arrowStyle) {
        window.appState.toolSettings.line.arrowStyle = 'triangle';
    }
    lineTool.onclick = () => {
        if (window.Inkyscib?.ToolDock?.isDockMode?.()) {
            closeAllToolboxes();
            setTool('line');
            return;
        }
        const state = window.appState;

        if (state.currentTool === 'line' && !state.panMode) {
            if (lineClickTimer) {
                clearTimeout(lineClickTimer);
                lineClickTimer = null;
                toggleToolbox('lineOptions');
            } else {
                lineClickTimer = setTimeout(() => {
                    lineClickTimer = null;
                }, 300);
            }
        } else {
            closeAllToolboxes();
            setTool('line');
        }
    };
    lineSize.oninput = () => {
        window.appState.toolSettings.line.size = +lineSize.value;
        lineSizeInput.value = lineSize.value;
        if (typeof window.savePreferences === 'function') {
            window.savePreferences();
        }
    };

    lineSizeInput.oninput = () => {
        let v = Math.min(200, Math.max(1, +lineSizeInput.value));
        lineSizeInput.value = v;
        lineSize.value = v;
        window.appState.toolSettings.line.size = v;
        if (typeof window.savePreferences === 'function') {
            window.savePreferences();
        }
    };
    document.querySelectorAll('#lineOptions .color-swatch').forEach(s => {
        s.onclick = () => {
            window.appState.toolSettings.line.color = s.dataset.color;
            updateColorSwatchSelection('lineOptions', s.dataset.color);
            saveDrawing();
        };
    });
    lineCustomColor.oninput = e => {
        window.appState.toolSettings.line.color = e.target.value;
        saveDrawing();
    };
    document.querySelectorAll('.line-type-btn').forEach(btn => {
        btn.onclick = () => {
            var lt = btn.dataset.linetype;
            window.appState.toolSettings.line.lineType = lt;
            updateLineTypeSelection();
            if (typeof window.saveDrawing === 'function') window.saveDrawing();
        };
    });
    // Geometric kind: segment / ray / line. Independent of the visual style,
    // because a dotted ray and a solid ray are the same object mathematically.
    if (!window.appState.toolSettings.line.lineKind) {
        window.appState.toolSettings.line.lineKind = 'segment';
    }
    document.querySelectorAll('.line-kind-btn').forEach(btn => {
        btn.onclick = () => {
            window.appState.toolSettings.line.lineKind = btn.dataset.linekind;
            updateLineKindSelection();
            if (typeof window.savePreferences === 'function') window.savePreferences();
            else if (typeof window.saveDrawing === 'function') window.saveDrawing();
        };
    });
    function updateLineKindSelection() {
        var current = window.appState.toolSettings.line.lineKind || 'segment';
        document.querySelectorAll('.line-kind-btn').forEach(btn => {
            var on = btn.dataset.linekind === current;
            btn.classList.toggle('active', on);
            btn.setAttribute('aria-pressed', on ? 'true' : 'false');
        });
        // an infinite line has no end to put an arrow on
        var arrowRow = document.getElementById('arrowStylesSection');
        if (arrowRow) arrowRow.style.display = current === 'line' ? 'none' : '';
    }
    updateLineKindSelection();

    document.querySelectorAll('.arrow-style-btn').forEach(btn => {
        btn.onclick = () => {
            window.appState.toolSettings.line.arrowStyle = btn.dataset.arrow;
            updateArrowStyleSelection();
            if (typeof window.saveDrawing === 'function') window.saveDrawing();
        };
    });
    function updateLineTypeSelection() {
        var current = window.appState.toolSettings.line.lineType;
        document.querySelectorAll('.line-type-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.linetype === current);
        });
    }

    function updateArrowStyleSelection() {
        var current = window.appState.toolSettings.line.arrowStyle;
        document.querySelectorAll('.arrow-style-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.arrow === current);
        });
    }
    updateLineTypeSelection();
    updateArrowStyleSelection();

    // Exact length. Empty means "drag freely"; a number locks every new line to
    // that length and leaves you only the direction to choose.
    var fixedInput = document.getElementById('lineFixedLength');
    var fixedClear = document.getElementById('lineFixedClear');

    function syncFixedLength() {
        if (!fixedInput) return;
        var stored = window.appState.toolSettings.line.fixedLength;
        var active = Number.isFinite(stored) && stored > 0;
        if (document.activeElement !== fixedInput) {
            fixedInput.value = active ? stored : '';
        }
        fixedInput.classList.toggle('is-active', active);
    }

    if (fixedInput) {
        syncFixedLength();
        fixedInput.oninput = () => {
            var value = parseFloat(fixedInput.value);
            window.appState.toolSettings.line.fixedLength =
                Number.isFinite(value) && value > 0 ? value : null;
            fixedInput.classList.toggle('is-active',
                Number.isFinite(value) && value > 0);
            if (typeof window.savePreferences === 'function') window.savePreferences();
        };
    }

    if (fixedClear) {
        fixedClear.onclick = () => {
            window.appState.toolSettings.line.fixedLength = null;
            syncFixedLength();
            if (typeof window.savePreferences === 'function') window.savePreferences();
        };
    }

    // Preferences are restored from IndexedDB after this panel has already been
    // built, so the stored value has to be pulled in again once it lands.
    window.Inkyscib = window.Inkyscib || {};
    window.Inkyscib.LineSettingsSync = function () {
        syncFixedLength();
        syncDetailToggles();
    };

    // Defaults for lines drawn from now on. A line already on the page is
    // changed from the inspector instead, one segment at a time.
    // One row per thing a segment can carry. Each is stamped onto the line at
    // creation, so ticking a box changes what you draw next, not what is drawn.
    var DETAIL_TOGGLES = [
        ['lineDefaultLabels', 'showLabels'],
        ['lineDefaultLength', 'showLength'],
        ['lineDefaultAngle', 'showAngle'],
        ['lineDefaultCoords', 'showCoords'],
        ['lineDefaultMidpoint', 'showMidpoint']
    ];

    function syncDetailToggles() {
        DETAIL_TOGGLES.forEach(function (pair) {
            var box = document.getElementById(pair[0]);
            if (box) box.checked = window.appState.toolSettings.line[pair[1]] === true;
        });
    }

    DETAIL_TOGGLES.forEach(function (pair) {
        var box = document.getElementById(pair[0]);
        if (!box) return;
        box.onchange = () => {
            window.appState.toolSettings.line[pair[1]] = box.checked;
            if (typeof window.savePreferences === 'function') window.savePreferences();
        };
    });
    syncDetailToggles();
    // The arrow tip is always offered now (with an explicit "none"); it is only
    // hidden for an infinite line, which has no end to decorate.
    if (arrowStylesPanel) arrowStylesPanel.style.display = 'flex';
    updateLineKindSelection();
}
// A segment stops at its endpoints; a ray continues past the second point;
// a line continues past both. Only the drawn extent changes — the two defining
// points stay exactly where the user put them, so measurements, snapping and
// intersections keep referring to the real geometry.
function extendLineForKind(p1, p2, kind, ctx) {
    if (kind !== 'ray' && kind !== 'line') return [p1, p2];

    var dx = p2.x - p1.x;
    var dy = p2.y - p1.y;
    var length = Math.hypot(dx, dy);
    if (!isFinite(length) || length < 1e-9) return [p1, p2];

    // Reach beyond the visible canvas in world units, whatever the zoom.
    var scale = Math.max(0.05, (window.appState && window.appState.transform
        ? window.appState.transform.scale : 1) || 1);
    // canvas.width is in DEVICE pixels; world units come from CSS pixels, so the
    // device-pixel ratio has to be divided out before dividing by the zoom.
    // (Same screen-vs-world unit confusion that misplaced the compass centre —
    // harmless here since it only over-extends, but wrong is wrong.)
    var canvas = ctx && ctx.canvas ? ctx.canvas : null;
    var cssWidth = canvas ? (canvas.getBoundingClientRect().width || canvas.width) : 0;
    var ratio = canvas && cssWidth ? canvas.width / cssWidth : 1;
    var diagonalCss = canvas ? Math.hypot(canvas.width, canvas.height) / (ratio || 1) : 4000;
    var span = (diagonalCss / scale) + length;

    var ux = dx / length;
    var uy = dy / length;

    var start = kind === 'line'
        ? { x: p1.x - ux * span, y: p1.y - uy * span }
        : p1;
    var end = { x: p2.x + ux * span, y: p2.y + uy * span };

    return [start, end];
}

// Small ticks mark where the defining points sit once the stroke runs past
// them, so a ray still visibly starts somewhere.
function drawLineKindMarkers(ctx, p1, p2, kind, size, color) {
    if (kind !== 'ray' && kind !== 'line') return;
    var radius = Math.max(1.6, size * 0.9);
    ctx.save();
    ctx.setLineDash([]);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(p1.x, p1.y, radius, 0, Math.PI * 2);
    ctx.fill();
    if (kind === 'ray') {
        ctx.beginPath();
        ctx.arc(p2.x, p2.y, radius * 0.75, 0, Math.PI * 2);
        ctx.fill();
    }
    ctx.restore();
}

function drawLineWithType(ctx, path) {
    if (!path || !path.points || path.points.length < 2) return;

    var p1 = path.points[0];
    var p2 = path.points[1];
    var lineKind = path.lineKind || 'segment';
    var lineType = normalizeLineType(path.lineType);
    var arrowStyle = normalizeArrowStyle(path.arrowStyle, path.lineType);
    var size = path.size || 2;
    var color = path.color || '#ffffff';

    ctx.strokeStyle = color;
    ctx.lineWidth = size;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.setLineDash(lineType === 'dotted' ? [size * 2, size * 2.5] : []);

    // A geometric line is ALWAYS the straight path between its two points.
    // (An earlier build routed arrows through an orthogonal elbow, which made
    // every arrow line come out horizontal-then-vertical.)
    var ends = extendLineForKind(p1, p2, lineKind, ctx);
    ctx.beginPath();
    ctx.moveTo(ends[0].x, ends[0].y);
    ctx.lineTo(ends[1].x, ends[1].y);
    ctx.stroke();
    ctx.setLineDash([]);

    // An arrow tip marks a direction, so it only makes sense where the drawn
    // stroke actually stops: at p2 on a segment, at the far end of a ray.
    if (arrowStyle && arrowStyle !== 'none' && lineKind !== 'line') {
        var tip = lineKind === 'ray' ? ends[1] : p2;
        drawArrowHead(ctx, p1, tip, size, color, arrowStyle);
    }

    drawLineKindMarkers(ctx, p1, p2, lineKind, size, color);
    drawLineLabels(ctx, path, p1, p2);
    drawLiveReadout(ctx, path, p1, p2);
}

// While the line is still being dragged, its length and bearing sit beside the
// moving end. Committed lines carry their length in the middle instead, so this
// only ever shows for the one in hand.
//
// It shows regardless of the "show length" setting: this is feedback for the
// gesture in progress, not an annotation that stays on the page.
function drawLiveReadout(ctx, path, p1, p2) {
    var s = window.appState;
    if (!s || !s.isDrawing || s.currentPath !== path) return;

    var dx = p2.x - p1.x;
    var dy = p2.y - p1.y;
    var length = Math.hypot(dx, dy);
    if (!isFinite(length) || length < 1e-6) return;

    var zoom = Math.max(0.05, (s.transform ? s.transform.scale : 1) || 1);
    var render = window.Inkyscib && window.Inkyscib.ConstructionRender;
    var colors = render && render.palette ? render.palette() : null;
    var ink = colors ? colors.label : '#cbd5e1';
    var halo = colors ? colors.halo : 'rgba(10, 12, 18, 0.85)';

    var degrees = Math.atan2(dy, dx) * 180 / Math.PI;
    if (degrees < 0) degrees += 360;

    var locked = window.Inkyscib && window.Inkyscib.LineLength
        && window.Inkyscib.LineLength.fixedWorldLength();
    var text = formatLineLength(length) + '   ' + degrees.toFixed(1) + '°'
        + (locked ? '   locked' : '');

    var pad = 14 / zoom;
    var fontSize = 12 / zoom;

    ctx.save();
    ctx.setLineDash([]);
    ctx.font = '700 ' + fontSize + "px 'Segoe UI', system-ui, sans-serif";
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.lineWidth = 3 / zoom;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = halo;
    ctx.fillStyle = ink;
    ctx.strokeText(text, p2.x + pad, p2.y - pad);
    ctx.fillText(text, p2.x + pad, p2.y - pad);
    ctx.restore();
}

// World units per notebook unit — the scale geometry.js and the compass both
// report in, so a segment's length and a triangle's side agree.
var LINE_UNIT_SCALE = 32;
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


function formatLineLength(worldLength) {
    if (!isFinite(worldLength)) return '';
    return (worldLength / LINE_UNIT_SCALE).toFixed(2) + ' ' + unitLabel();
}

// Names live on the segment and are drawn from its own two points, so they
// travel with it when it is dragged and can never fall out of step. p1 and p2
// are the DEFINING points: a ray's stroke runs past p2, but the name belongs
// to the point, not to wherever the ink happens to stop.
// Coordinates in the same units the length is reported in, so the two numbers
// on one segment are on one scale.
function formatPoint(point) {
    return '(' + (point.x / LINE_UNIT_SCALE).toFixed(1)
        + ', ' + (point.y / LINE_UNIT_SCALE).toFixed(1) + ')';
}

// Inclination from horizontal, normalised to 0-180: a segment has a direction
// but no arrow of time, so 200 degrees and 20 degrees are the same slope and
// reporting the larger one just reads as wrong.
function formatInclination(dx, dy) {
    var degrees = Math.atan2(dy, dx) * 180 / Math.PI;
    if (degrees < 0) degrees += 180;
    if (degrees >= 180) degrees -= 180;
    return degrees.toFixed(1) + '°';
}

function drawLineLabels(ctx, path, p1, p2) {
    if (!measurementsVisible()) return;
    if (!path.showLabels && !path.showLength &&
        !path.showAngle && !path.showCoords && !path.showMidpoint) return;

    var zoom = Math.max(0.05, (window.appState && window.appState.transform
        ? window.appState.transform.scale : 1) || 1);
    var render = window.Inkyscib && window.Inkyscib.ConstructionRender;
    var colors = render && render.palette ? render.palette() : null;
    var ink = colors ? colors.label : '#cbd5e1';
    var halo = colors ? colors.halo : 'rgba(10, 12, 18, 0.85)';

    var dx = p2.x - p1.x;
    var dy = p2.y - p1.y;
    var length = Math.hypot(dx, dy);
    if (!isFinite(length) || length < 1e-9) return;
    var ux = dx / length;
    var uy = dy / length;

    var fontSize = 12 / zoom;
    var gap = 10 / zoom;

    ctx.save();
    ctx.setLineDash([]);
    ctx.font = '700 ' + fontSize + "px 'Segoe UI', system-ui, sans-serif";
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    ctx.lineWidth = 3 / zoom;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = halo;
    ctx.fillStyle = ink;

    var write = function (text, x, y) {
        if (!text) return;
        ctx.strokeText(text, x, y);
        ctx.fillText(text, x, y);
    };

    if (path.showLabels) {
        // pushed outward along the line, so a name never sits on the stroke
        write(path.labelStart, p1.x - ux * gap, p1.y - uy * gap);
        write(path.labelEnd, p2.x + ux * gap, p2.y + uy * gap);
    }

    var midX = (p1.x + p2.x) / 2;
    var midY = (p1.y + p2.y) / 2;

    if (path.showLength) {
        // offset square to the line, on the side that keeps it clear of both
        // the stroke and the arrow tip
        write(formatLineLength(length), midX - uy * gap, midY + ux * gap);
    }

    // The slope goes on the opposite side of the line from the length, so the
    // two never collide however the segment is turned.
    if (path.showAngle) {
        write(formatInclination(dx, dy), midX + uy * gap * 1.6, midY - ux * gap * 1.6);
    }

    // Coordinates sit further out than the names, on the same axis, so a
    // segment showing both reads outward: name, then position.
    if (path.showCoords) {
        ctx.font = '600 ' + (fontSize * 0.82) + "px 'Segoe UI', system-ui, sans-serif";
        var out = gap * (path.showLabels ? 2.5 : 1.2);
        write(formatPoint(p1), p1.x - ux * out, p1.y - uy * out);
        write(formatPoint(p2), p2.x + ux * out, p2.y + uy * out);
        ctx.font = '700 ' + fontSize + "px 'Segoe UI', system-ui, sans-serif";
    }

    if (path.showMidpoint) {
        ctx.beginPath();
        ctx.arc(midX, midY, 3 / zoom, 0, Math.PI * 2);
        ctx.fillStyle = ink;
        ctx.fill();
        ctx.strokeStyle = halo;
        ctx.lineWidth = 1.5 / zoom;
        ctx.stroke();
        ctx.lineWidth = 3 / zoom;
        ctx.strokeStyle = halo;
        ctx.fillStyle = ink;
        write('M', midX - uy * gap * 2.4, midY + ux * gap * 2.4);
    }

    ctx.restore();
}

// 'arrow' used to be a line TYPE, which conflated "dashed vs solid" with
// "has an arrowhead". Old saved paths and preferences are migrated on read.
function normalizeLineType(lineType) {
    return lineType === 'dotted' ? 'dotted' : 'solid';
}

function normalizeArrowStyle(arrowStyle, legacyLineType) {
    if (arrowStyle === 'none') return 'none';
    if (arrowStyle) return arrowStyle;
    return legacyLineType === 'arrow' ? 'triangle' : 'none';
}

function drawArrowHead(ctx, p1, p2, lineWidth, color, style) {
    var angle = Math.atan2(p2.y - p1.y, p2.x - p1.x);
    var headLen = Math.max(lineWidth * 4, 12);

    ctx.fillStyle = color;
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    switch (style) {
        case 'triangle':
            ctx.beginPath();
            ctx.moveTo(p2.x, p2.y);
            ctx.lineTo(
                p2.x - headLen * Math.cos(angle - Math.PI / 6),
                p2.y - headLen * Math.sin(angle - Math.PI / 6)
            );
            ctx.lineTo(
                p2.x - headLen * Math.cos(angle + Math.PI / 6),
                p2.y - headLen * Math.sin(angle + Math.PI / 6)
            );
            ctx.closePath();
            ctx.fill();
            break;

        case 'open':
            ctx.beginPath();
            ctx.moveTo(
                p2.x - headLen * Math.cos(angle - Math.PI / 6),
                p2.y - headLen * Math.sin(angle - Math.PI / 6)
            );
            ctx.lineTo(p2.x, p2.y);
            ctx.lineTo(
                p2.x - headLen * Math.cos(angle + Math.PI / 6),
                p2.y - headLen * Math.sin(angle + Math.PI / 6)
            );
            ctx.stroke();
            break;

        case 'diamond':
            var halfLen = headLen * 0.6;
            var midX = p2.x - halfLen * Math.cos(angle);
            var midY = p2.y - halfLen * Math.sin(angle);
            ctx.beginPath();
            ctx.moveTo(p2.x, p2.y);
            ctx.lineTo(
                midX - halfLen * 0.5 * Math.cos(angle - Math.PI / 2),
                midY - halfLen * 0.5 * Math.sin(angle - Math.PI / 2)
            );
            ctx.lineTo(
                p2.x - headLen * Math.cos(angle),
                p2.y - headLen * Math.sin(angle)
            );
            ctx.lineTo(
                midX + halfLen * 0.5 * Math.cos(angle - Math.PI / 2),
                midY + halfLen * 0.5 * Math.sin(angle - Math.PI / 2)
            );
            ctx.closePath();
            ctx.fill();
            break;

        case 'circle':
            var r = headLen * 0.35;
            ctx.beginPath();
            ctx.arc(p2.x, p2.y, r, 0, Math.PI * 2);
            ctx.fill();
            break;

        default:
            ctx.beginPath();
            ctx.moveTo(p2.x, p2.y);
            ctx.lineTo(
                p2.x - headLen * Math.cos(angle - Math.PI / 6),
                p2.y - headLen * Math.sin(angle - Math.PI / 6)
            );
            ctx.lineTo(
                p2.x - headLen * Math.cos(angle + Math.PI / 6),
                p2.y - headLen * Math.sin(angle + Math.PI / 6)
            );
            ctx.closePath();
            ctx.fill();
            break;
    }
}
window.drawLineWithType = drawLineWithType;

// Letters are handed out when a line is first named rather than when it is
// created, so a line drawn without labels never burns a name, and turning
// labels on years later still gets the next free one.
window.Inkyscib = window.Inkyscib || {};
// The exact length the Line tool is locked to, in world units, or null when
// lines are drawn freely. Kept here so events.js does not have to know that the
// panel stores it in display units.
window.Inkyscib.LineLength = {
    UNIT_SCALE: LINE_UNIT_SCALE,

    fixedWorldLength: function () {
        var units = window.appState?.toolSettings?.line?.fixedLength;
        if (!Number.isFinite(units) || units <= 0) return null;
        return units * LINE_UNIT_SCALE;
    },

    // Keep the direction the drag chose, replace the distance. With no
    // direction yet (the pointer has not left the first point) there is nothing
    // to project onto, so the start is returned unchanged.
    projectToLength: function (from, to, worldLength) {
        var dx = to.x - from.x;
        var dy = to.y - from.y;
        var current = Math.hypot(dx, dy);
        if (!isFinite(current) || current < 1e-9) return { ...to };
        var k = worldLength / current;
        return { ...to, x: from.x + dx * k, y: from.y + dy * k };
    }
};

window.Inkyscib.LineLabels = {
    ensure: function (path) {
        if (!path || path.tool !== 'line') return false;
        var construction = window.Inkyscib && window.Inkyscib.Construction;
        if (!construction || !construction.nextLabel) return false;
        var changed = false;
        if (!path.labelStart) {
            path.labelStart = construction.nextLabel();
            changed = true;
        }
        if (!path.labelEnd) {
            path.labelEnd = construction.nextLabel([path.labelStart]);
            changed = true;
        }
        return changed;
    },
    format: formatLineLength
};

// The Line inspector: a selected segment's own labels, edited one segment at
// a time. It follows the same shape as the smart-geometry inspector — a panel
// that syncs itself off the selection overlay — because there is no selection
// change event to listen to.
function initLineInspector() {
    var panel = document.getElementById('lineInspector');
    if (!panel) return;

    var titleEl = document.getElementById('lineInspectorTitle');
    var lengthEl = document.getElementById('lineMeasureLength');
    var angleEl = document.getElementById('lineMeasureAngle');
    var labelsToggle = document.getElementById('lineShowLabels');
    var lengthToggle = document.getElementById('lineShowLength');
    var fields = document.getElementById('lineLabelFields');
    var startInput = document.getElementById('lineLabelStart');
    var endInput = document.getElementById('lineLabelEnd');
    var closeButton = document.getElementById('lineInspectorClose');

    var signature = '';

    var KIND_TITLES = { segment: 'Segment', ray: 'Ray', line: 'Line' };

    function selectedLine() {
        var selection = window.Inkyscib && window.Inkyscib.Selection;
        if (!selection || !selection.selectedPath) return null;
        if (window.appState.currentTool !== 'select') return null;
        if (window.appState.clearAnimation) return null;
        var path = selection.selectedPath();
        if (!path || path.tool !== 'line') return null;
        if (!Array.isArray(path.points) || path.points.length < 2) return null;
        return path;
    }

    // Every edit is one undo step, taken before the change so undo puts the
    // label back exactly as it was.
    function edit(mutate) {
        var path = selectedLine();
        if (!path) return;
        if (typeof window.commitHistory === 'function') window.commitHistory();
        mutate(path);
        signature = '';
        if (typeof window.saveDrawing === 'function') window.saveDrawing();
        if (typeof window.render === 'function') window.render();
        sync();
    }

    function cleanLabel(value) {
        return (value || '').replace(/\s+/g, '').slice(0, 4);
    }

    if (closeButton) {
        closeButton.addEventListener('click', () => {
            if (window.Inkyscib && window.Inkyscib.Selection) window.Inkyscib.Selection.clear();
        });
    }

    labelsToggle.addEventListener('change', () => {
        edit((path) => {
            path.showLabels = labelsToggle.checked;
            if (path.showLabels) window.Inkyscib.LineLabels.ensure(path);
        });
    });

    lengthToggle.addEventListener('change', () => {
        edit((path) => { path.showLength = lengthToggle.checked; });
    });

    startInput.addEventListener('change', () => {
        edit((path) => { path.labelStart = cleanLabel(startInput.value); });
    });
    endInput.addEventListener('change', () => {
        edit((path) => { path.labelEnd = cleanLabel(endInput.value); });
    });

    function sync() {
        var path = selectedLine();
        var visible = !!path;
        panel.hidden = !visible;
        panel.setAttribute('aria-hidden', visible ? 'false' : 'true');
        document.body.classList.toggle('line-sheet-open', visible);
        if (!visible) {
            signature = '';
            return;
        }

        var a = path.points[0];
        var b = path.points[1];
        var next = [
            path.lineKind, path.showLabels, path.showLength,
            path.labelStart, path.labelEnd,
            a.x, a.y, b.x, b.y
        ].join(':');
        if (next === signature) return;
        signature = next;

        titleEl.textContent = KIND_TITLES[path.lineKind] || 'Segment';
        var length = Math.hypot(b.x - a.x, b.y - a.y);
        lengthEl.textContent = formatLineLength(length);
        var degrees = Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI;
        if (degrees < 0) degrees += 360;
        angleEl.textContent = degrees.toFixed(1) + '\u00b0';

        labelsToggle.checked = path.showLabels === true;
        lengthToggle.checked = path.showLength === true;
        fields.hidden = path.showLabels !== true;
        if (document.activeElement !== startInput) startInput.value = path.labelStart || '';
        if (document.activeElement !== endInput) endInput.value = path.labelEnd || '';
    }

    // Same trick smart geometry uses: the selection overlay is redrawn every
    // frame, which is the only reliable signal that the selection moved.
    var selection = window.Inkyscib && window.Inkyscib.Selection;
    if (selection && !selection.__lineInspectorInstalled) {
        var baseDraw = selection.drawOverlay;
        var baseClear = selection.clear;
        selection.drawOverlay = function drawLineInspectorOverlay(ctx) {
            var result = baseDraw ? baseDraw.call(this, ctx) : undefined;
            sync();
            return result;
        };
        selection.clear = function clearForLineInspector(options) {
            var result = baseClear ? baseClear.call(this, options) : undefined;
            sync();
            return result;
        };
        selection.__lineInspectorInstalled = true;
    }

    document.addEventListener('toolChanged', sync);
    sync();
}

document.addEventListener('DOMContentLoaded', initLineTool);
document.addEventListener('DOMContentLoaded', initLineInspector);

