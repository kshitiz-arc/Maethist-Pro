function initShapeTool() {
    const shapeTool = document.getElementById('shapeTool');
    const shapeOptions = document.getElementById('shapeOptions');
    const shapeSize = document.getElementById('shapeSize');
    const shapeSizeInput = document.getElementById('shapeSizeInput');
    const shapeCustomColor = document.getElementById('shapeCustomColor');
    const triangleTypesSection = document.getElementById('triangleTypesSection');
    
    let shapeClickTimer = null;
    let currentShape = 'circle';
    
    if (!window.appState.toolSettings.shape) {
        window.appState.toolSettings.shape = {
            size: 3,
            color: '#ffffff',
            shapeType: 'circle',
            triangleType: 'isosceles'
        };
    } else {
        if (!window.appState.toolSettings.shape.color || 
            window.appState.toolSettings.shape.color === 'black') {
            window.appState.toolSettings.shape.color = '#ffffff';
        }
        window.appState.toolSettings.shape.triangleType = normalizeTriangleType(
            window.appState.toolSettings.shape.triangleType
        );
    }
    
    currentShape = normalizeShapeType(window.appState.toolSettings.shape.shapeType);
    window.appState.toolSettings.shape.shapeType = currentShape;
    updateShapeSelection();
    
    shapeTool.onclick = () => {
        if (window.Inkyscib?.ToolDock?.isDockMode?.()) {
            closeAllToolboxes();
            setTool('shape');
            return;
        }
        const state = window.appState;
        
        if (state.currentTool === 'shape' && !state.panMode) {
            if (shapeClickTimer) {
                clearTimeout(shapeClickTimer);
                shapeClickTimer = null;
                toggleToolbox('shapeOptions');
            } else {
                shapeClickTimer = setTimeout(() => {
                    shapeClickTimer = null;
                }, 300);
            }
        } else {
            closeAllToolboxes();
            setTool('shape');
        }
    };
    
    document.querySelectorAll('.shape-btn').forEach(btn => {
        btn.onclick = () => {
            currentShape = btn.dataset.shape;
            window.appState.toolSettings.shape.shapeType = currentShape;
            updateShapeSelection({ animate: true });
            updateTriangleTypeSelection();
            if (typeof window.saveDrawing === 'function') {
                window.saveDrawing();
            }
        };
    });

    document.querySelectorAll('.triangle-type-btn').forEach(btn => {
        btn.onclick = () => {
            window.appState.toolSettings.shape.triangleType = normalizeTriangleType(btn.dataset.triangleType);
            updateTriangleTypeSelection();
            if (typeof window.savePreferences === 'function') {
                window.savePreferences();
            }
        };
    });
    
    shapeSize.oninput = () => {
        window.appState.toolSettings.shape.size = +shapeSize.value;
        shapeSizeInput.value = shapeSize.value;
        if (window.appState.currentTool === 'shape' && window.sizePreview) {
            window.sizePreview.updateSize();
        }
        if (typeof window.savePreferences === 'function') {
            window.savePreferences();
        }
    };
    
    shapeSizeInput.oninput = () => {
        let v = Math.min(50, Math.max(1, +shapeSizeInput.value));
        shapeSizeInput.value = v;
        shapeSize.value = v;
        window.appState.toolSettings.shape.size = v;
        if (window.appState.currentTool === 'shape' && window.sizePreview) {
            window.sizePreview.updateSize();
        }
        if (typeof window.savePreferences === 'function') {
            window.savePreferences();
        }
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
    
    shapeSize.value = window.appState.toolSettings.shape.size;
    shapeSizeInput.value = window.appState.toolSettings.shape.size;
    shapeSize.setAttribute('min', '1');
    shapeSize.setAttribute('max', '50');
    shapeSizeInput.setAttribute('min', '1');
    shapeSizeInput.setAttribute('max', '50');
    
    updateColorSwatchSelection('shapeOptions', window.appState.toolSettings.shape.color);
    updateTriangleTypeSelection();
    
    function normalizeShapeType(shape) {
        return ['circle', 'square', 'rectangle', 'triangle', 'parallelogram', 'rhombus', 'kite'].includes(shape) ? shape : 'circle';
    }

    function normalizeTriangleType(type) {
        return ['isosceles', 'equilateral', 'right', 'custom'].includes(type) ? type : 'isosceles';
    }

    function updateShapeToolIcon(shape, animate = false) {
        if (!shapeTool) return;

        const normalized = normalizeShapeType(shape);
        const labels = {
            circle: 'Circle',
            square: 'Square',
            rectangle: 'Rectangle',
            triangle: 'Triangle',
            parallelogram: 'Parallelogram',
            rhombus: 'Rhombus',
            kite: 'Kite'
        };

        shapeTool.dataset.shape = normalized;
        shapeTool.title = `${labels[normalized]} shape`;
        shapeTool.setAttribute('aria-label', `${labels[normalized]} shape`);
        // The rename just wiped the keyboard hint off the tooltip; ask for it back.
        window.Inkyscib?.Shortcuts?.applyLabels?.();

        if (!animate) return;

        shapeTool.classList.remove('is-changing');
        void shapeTool.offsetWidth;
        shapeTool.classList.add('is-changing');
        window.clearTimeout(shapeTool._shapeIconTimer);
        shapeTool._shapeIconTimer = window.setTimeout(() => {
            shapeTool.classList.remove('is-changing');
        }, 560);
    }

    function updateShapeSelection(options = {}) {
        currentShape = normalizeShapeType(currentShape);
        document.querySelectorAll('.shape-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.shape === currentShape);
        });
        updateShapeToolIcon(currentShape, !!options.animate);
    }

    function updateTriangleTypeSelection(triangleType = null) {
        const current = normalizeTriangleType(triangleType || window.appState.toolSettings.shape.triangleType);
        const isTriangle = currentShape === 'triangle';

        window.appState.toolSettings.shape.triangleType = current;

        if (triangleTypesSection) {
            triangleTypesSection.hidden = !isTriangle;
            triangleTypesSection.style.display = isTriangle ? 'flex' : 'none';
        }

        document.querySelectorAll('.triangle-type-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.triangleType === current);
        });
    }

    window.updateTriangleTypeSelection = updateTriangleTypeSelection;
    window.syncShapeSelectionFromState = function syncShapeSelectionFromState(options = {}) {
        currentShape = normalizeShapeType(window.appState.toolSettings.shape?.shapeType);
        if (window.appState.toolSettings.shape) {
            window.appState.toolSettings.shape.shapeType = currentShape;
        }
        updateShapeSelection({ animate: !!options.animate });
        updateTriangleTypeSelection();
    };
    
    console.log('Shape tool initialized with default color:', window.appState.toolSettings.shape.color);
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
