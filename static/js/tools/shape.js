// The Shape tool: its rail button and its panel.
//
// The panel is fifteen labelled buttons in four groups, then fill and outline
// (docs/superpowers/specs/2026-09-14-editor-feedback-design.md, section 8).
// Each triangle type is a button of its own, not a second choice that appears
// once a triangle is picked, so every button names one shape and one tap is the
// whole decision.

// The first entry of each list is its default.
const SHAPE_TYPES = ['circle', 'ellipse', 'triangle', 'square', 'rectangle', 'parallelogram',
    'rhombus', 'kite', 'trapezium', 'pentagon', 'hexagon', 'octagon'];
const TRIANGLE_TYPES = ['isosceles', 'equilateral', 'right', 'custom'];
const SHAPE_FILLS = ['none', 'tint', 'solid'];
const SHAPE_DASHES = ['solid', 'dashed', 'dotted'];

function initShapeTool() {
    const shapeTool = document.getElementById('shapeTool');
    const shapeOptions = document.getElementById('shapeOptions');
    const shapeSize = document.getElementById('shapeSize');
    const shapeSizeInput = document.getElementById('shapeSizeInput');
    const shapeCustomColor = document.getElementById('shapeCustomColor');


    function pick(allowed, value) {
        return allowed.includes(value) ? value : allowed[0];
    }

    function settings() {
        const toolSettings = window.appState.toolSettings;
        if (!toolSettings.shape) {
            toolSettings.shape = {
                size: 3,
                color: '#ffffff',
                shapeType: 'circle',
                triangleType: 'isosceles',
                fill: 'none',
                dash: 'solid'
            };
        }
        const shape = toolSettings.shape;
        if (!shape.color || shape.color === 'black') shape.color = '#ffffff';
        shape.shapeType = pick(SHAPE_TYPES, shape.shapeType);
        shape.triangleType = pick(TRIANGLE_TYPES, shape.triangleType);
        shape.fill = pick(SHAPE_FILLS, shape.fill);
        shape.dash = pick(SHAPE_DASHES, shape.dash);
        return shape;
    }

    function persist() {
        if (typeof window.savePreferences === 'function') window.savePreferences();
    }

    shapeTool.onclick = () => {
        // Opening and closing this tool's panel is tool-dock.js's job at every
        // width: it sees the tap in the capture phase and toggles on a second
        // tap. This handler only selects the tool. A second owner here -- a
        // double-tap timer below 1180px, writing style.display directly -- is
        // what left the panels out of step with the dock and, for Algebra
        // tiles, hid the panel the moment the tool was picked.
        closeAllToolboxes();
        setTool('shape');
    };

    shapeOptions.querySelectorAll('.shape-btn').forEach((button) => {
        button.addEventListener('click', () => {
            const shape = settings();
            shape.shapeType = pick(SHAPE_TYPES, button.dataset.shape);
            if (button.dataset.triangleType) {
                shape.triangleType = pick(TRIANGLE_TYPES, button.dataset.triangleType);
            }
            syncShapePanel({ animate: true });
            persist();
        });
    });

    shapeOptions.querySelectorAll('.shape-style-option').forEach((button) => {
        button.addEventListener('click', () => {
            const shape = settings();
            if (button.dataset.fill) shape.fill = pick(SHAPE_FILLS, button.dataset.fill);
            if (button.dataset.dash) shape.dash = pick(SHAPE_DASHES, button.dataset.dash);
            syncShapePanel();
            persist();
        });
    });

    shapeSize.oninput = () => {
        window.appState.toolSettings.shape.size = +shapeSize.value;
        shapeSizeInput.value = shapeSize.value;
        if (window.appState.currentTool === 'shape' && window.sizePreview) {
            window.sizePreview.updateSize();
        }
        persist();
    };

    shapeSizeInput.oninput = () => {
        let v = Math.min(50, Math.max(1, +shapeSizeInput.value));
        shapeSizeInput.value = v;
        shapeSize.value = v;
        window.appState.toolSettings.shape.size = v;
        if (window.appState.currentTool === 'shape' && window.sizePreview) {
            window.sizePreview.updateSize();
        }
        persist();
    };

    document.querySelectorAll('#shapeOptions .color-swatch').forEach(s => {
        s.onclick = () => {
            window.appState.toolSettings.shape.color = s.dataset.color;
            updateColorSwatchSelection('shapeOptions', s.dataset.color);
            if (typeof window.saveDrawing === 'function') {
                window.saveDrawing();
            }
        };
    });

    shapeCustomColor.oninput = e => {
        window.appState.toolSettings.shape.color = e.target.value;
        if (typeof window.saveDrawing === 'function') {
            window.saveDrawing();
        }
    };

    // The button's own label, so the rail's tooltip cannot disagree with it.
    function shapeName(shape) {
        const selector = shape.shapeType === 'triangle'
            ? `.shape-btn[data-shape="triangle"][data-triangle-type="${shape.triangleType}"]`
            : `.shape-btn[data-shape="${shape.shapeType}"]`;
        // Soft hyphens mark where a long label may break; they are not part of its name.
        const label = shapeOptions.querySelector(selector)?.querySelector('.shape-btn-label')?.textContent
            .replace(/\u00ad/g, '').trim() || 'Shape';
        return shape.shapeType === 'triangle' ? `${label} triangle` : label;
    }

    function updateShapeToolIcon(animate) {
        const shape = settings();
        shapeTool.dataset.shape = shape.shapeType;
        if (shape.shapeType === 'triangle') {
            shapeTool.dataset.triangleType = shape.triangleType;
        } else {
            delete shapeTool.dataset.triangleType;
        }
        const name = `${shapeName(shape)} shape`;
        shapeTool.title = name;
        shapeTool.setAttribute('aria-label', name);
        // The rename just wiped the keyboard hint off the tooltip; ask for it back.
        window.Inkyscib?.Shortcuts?.applyLabels?.();

        if (!animate) return;
        shapeTool.classList.remove('is-changing');
        void shapeTool.offsetWidth;
        shapeTool.classList.add('is-changing');
        window.clearTimeout(shapeTool._shapeIconTimer);
        shapeTool._shapeIconTimer = window.setTimeout(() => {
            shapeTool.classList.remove('is-changing');
        }, 200);
    }

    function syncShapePanel(options = {}) {
        const shape = settings();
        shapeOptions.querySelectorAll('.shape-btn').forEach((button) => {
            const chosen = button.dataset.shape === shape.shapeType &&
                (!button.dataset.triangleType || button.dataset.triangleType === shape.triangleType);
            button.classList.toggle('active', chosen);
            button.setAttribute('aria-pressed', chosen ? 'true' : 'false');
        });
        shapeOptions.querySelectorAll('.shape-style-option').forEach((button) => {
            const chosen = button.dataset.fill
                ? button.dataset.fill === shape.fill
                : button.dataset.dash === shape.dash;
            button.classList.toggle('active', chosen);
            button.setAttribute('aria-pressed', chosen ? 'true' : 'false');
        });
        updateShapeToolIcon(!!options.animate);
    }

    shapeSize.value = settings().size;
    shapeSizeInput.value = settings().size;
    shapeSize.setAttribute('min', '1');
    shapeSize.setAttribute('max', '50');
    shapeSizeInput.setAttribute('min', '1');
    shapeSizeInput.setAttribute('max', '50');

    updateColorSwatchSelection('shapeOptions', settings().color);
    syncShapePanel();

    // Called by core.js once saved preferences are applied.
    window.updateTriangleTypeSelection = function updateTriangleTypeSelection(triangleType = null) {
        if (triangleType) settings().triangleType = pick(TRIANGLE_TYPES, triangleType);
        syncShapePanel();
    };
    window.syncShapeSelectionFromState = function syncShapeSelectionFromState(options = {}) {
        syncShapePanel({ animate: !!options.animate });
    };
}

function drawShapeOutline(ctx, path) {
    if (window.Inkyscib?.Geometry?.drawShapeOutline) {
        window.Inkyscib.Geometry.drawShapeOutline(ctx, path);
        return;
    }

    if (!path || !path.points || path.points.length < 2) return;

    const [p1, p2] = path.points;
    const width = Math.abs(p2.x - p1.x);
    const height = Math.abs(p2.y - p1.y);

    const finalWidth = width < 5 ? window.appState.toolSettings.shape.size * 10 : width;
    const finalHeight = height < 5 ? window.appState.toolSettings.shape.size * 10 : height;

    const centerX = (p1.x + p2.x) / 2;
    const centerY = (p1.y + p2.y) / 2;

    ctx.strokeStyle = path.color || '#ffffff';
    ctx.lineWidth = path.size;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    switch(path.shapeType) {
        case 'circle':
            ctx.beginPath();
            const radius = Math.max(finalWidth, finalHeight) / 2;
            ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
            ctx.stroke();
            break;

        case 'square':
            ctx.beginPath();
            ctx.rect(centerX - finalWidth/2, centerY - finalHeight/2, finalWidth, finalHeight);
            ctx.stroke();
            break;

        case 'triangle':
            ctx.beginPath();
            ctx.moveTo(centerX, centerY - finalHeight/2);
            ctx.lineTo(centerX - finalWidth/2, centerY + finalHeight/2);
            ctx.lineTo(centerX + finalWidth/2, centerY + finalHeight/2);
            ctx.closePath();
            ctx.stroke();
            break;
    }
}

window.drawShapeOutline = drawShapeOutline;

document.addEventListener('DOMContentLoaded', initShapeTool);
