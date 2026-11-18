const canvas = document.getElementById('drawingCanvas');
const ctx = canvas.getContext('2d');
const container = document.getElementById('canvas-container');

// The canvas is laid out in CSS pixels but its backing store is sized in device
// pixels, otherwise a 2x display upscales every stroke and every imported page
// and the whole workspace reads soft until you zoom in. All app coordinates
// (transform, paths, hit testing) stay in CSS pixels; the ratio is applied once,
// at the point each context is transformed.
const MAX_CANVAS_PIXEL_RATIO = 3;

function getCanvasPixelRatio() {
    const ratio = Number(window.devicePixelRatio);
    if (!Number.isFinite(ratio) || ratio <= 0) return 1;
    return Math.max(1, Math.min(MAX_CANVAS_PIXEL_RATIO, ratio));
}

// Reading `getBoundingClientRect()` and `clientWidth` forces the browser to
// flush layout. Every pointer sample used to pay that cost three times over
// (once per read), and a pen emitting coalesced samples multiplies it again,
// so the measurement was charged tens of times per frame while drawing. The
// canvas geometry only changes when the window, the container or the zoom
// level changes, so measure once and reuse until something invalidates it.
let __canvasMetricsCache = null;
let __canvasMetricsFrame = null;

function invalidateCanvasMetrics() {
    __canvasMetricsCache = null;
}

function getCanvasMetrics() {
    if (__canvasMetricsCache) return __canvasMetricsCache;

    // The snapshot is deliberately short-lived: it expires on the next
    // animation frame. A CSS transform or a class toggle can move the canvas
    // without firing resize, scroll or ResizeObserver, so holding the
    // measurement any longer than a frame could hand back stale coordinates.
    // One measurement per frame is what the renderer already cost; what this
    // removes is the dozens of extra measurements per frame that the input
    // path was making.
    if (__canvasMetricsFrame === null && typeof requestAnimationFrame === 'function') {
        __canvasMetricsFrame = requestAnimationFrame(() => {
            __canvasMetricsFrame = null;
            __canvasMetricsCache = null;
        });
    }

    const ratio = getCanvasPixelRatio();
    const width = Math.round(container.clientWidth);
    const height = Math.round(container.clientHeight);
    const domRect = canvas.getBoundingClientRect();

    __canvasMetricsCache = {
        canvas,
        container,
        // A plain snapshot rather than the live DOMRect: consumers only read
        // left/top/width/height, and a detached object cannot silently
        // re-trigger layout later.
        rect: {
            left: domRect.left,
            top: domRect.top,
            right: domRect.right,
            bottom: domRect.bottom,
            width: domRect.width,
            height: domRect.height
        },
        width,
        height,
        ratio,
        pixelWidth: Math.max(1, Math.round(width * ratio)),
        pixelHeight: Math.max(1, Math.round(height * ratio))
    };
    return __canvasMetricsCache;
}

// Anything that can move or resize the canvas drops the snapshot. Scroll is
// captured so an ancestor scrolling counts too, and ResizeObserver catches
// layout changes that fire no window event at all - a side panel opening, the
// tool dock changing height, the on-screen keyboard appearing.
window.addEventListener('resize', invalidateCanvasMetrics, { passive: true });
window.addEventListener('orientationchange', invalidateCanvasMetrics, { passive: true });
window.addEventListener('scroll', invalidateCanvasMetrics, { passive: true, capture: true });
if (typeof ResizeObserver === 'function') {
    const canvasResizeObserver = new ResizeObserver(invalidateCanvasMetrics);
    canvasResizeObserver.observe(container);
    canvasResizeObserver.observe(canvas);
}

canvas.width = Math.max(1, Math.round(container.clientWidth * getCanvasPixelRatio()));
canvas.height = Math.max(1, Math.round(container.clientHeight * getCanvasPixelRatio()));

function clientPointToCanvas(clientX, clientY) {
    const metrics = getCanvasMetrics();
    // Backing pixels divided by the ratio gives the CSS-pixel drawing surface,
    // which is the space every stored coordinate lives in.
    const width = (canvas.width || metrics.pixelWidth) / metrics.ratio;
    const height = (canvas.height || metrics.pixelHeight) / metrics.ratio;

    if (!metrics.rect.width || !metrics.rect.height) {
        return { x: 0, y: 0 };
    }

    return {
        x: (clientX - metrics.rect.left) * (width / metrics.rect.width),
        y: (clientY - metrics.rect.top) * (height / metrics.rect.height)
    };
}

function clientPointToWorld(clientX, clientY) {
    const point = clientPointToCanvas(clientX, clientY);
    return {
        x: (point.x - window.appState.transform.offsetX) / window.appState.transform.scale,
        y: (point.y - window.appState.transform.offsetY) / window.appState.transform.scale
    };
}

function getCanvasCenterPoint() {
    const metrics = getCanvasMetrics();
    return {
        x: metrics.width / 2,
        y: metrics.height / 2
    };
}

function normalizeToolbarLocation(location) {
    return location === 'down' ? 'down' : 'up';
}

function syncWorkspaceShellBounds() {
    const shell = document.getElementById('workspaceShell');
    if (!shell) return;
    const toolDock = document.getElementById('toolDock');

    const menuButton = document.getElementById('menuBtn');
    const menuButtonRect = menuButton?.getBoundingClientRect();
    // The canvas runs the full height of the window. The toolbar and the
    // footer credit float over it rather than carving bands out of it, which
    // is what every other drawing surface does and what makes the page feel
    // like a canvas instead of a panel between two bars.
    const topInset = 0;
    const bottomInset = 0;

    shell.style.top = `${topInset}px`;
    shell.style.bottom = `${bottomInset}px`;
    if (toolDock) {
        const menuButtonInset = menuButtonRect && menuButtonRect.top < window.innerHeight / 2
            ? Math.round(menuButtonRect.bottom + 12)
            : 0;
        const dockTopInset = Math.max(topInset, menuButtonInset);
        toolDock.style.top = `${dockTopInset}px`;
        toolDock.style.bottom = `${bottomInset}px`;
    }

    // These writes can move the canvas, so the cached measurement goes with them.
    invalidateCanvasMetrics();
}

window.appState = {
    transform: { scale: 1, offsetX: 0, offsetY: 0 },
    isDrawing: false,
    isPanning: false,
    panMode: false,
    currentTool: 'pen',
    toolbarLocation: 'up',
    selection: {
        selectedIndex: -1,
        selectedIndices: [],
        hoverHandle: null,
        action: null
    },
    start: { x: 0, y: 0 },
    paths: [],
    undoStack: [],
    redoStack: [],
    currentPath: null,
    storageReady: false,
    arMode: false,
    arStream: null,
    handPath: null,
    isTouchZooming: false,
    lastTouchDist: null,
    lastTouchMid: null,
    toolSettings: {
        // smoothing is the write-assist level, 0-100 (40 = the old "natural").
        pen: { size: 2, color: '#ffffff', style: 'default', smoothing: 40 },
        // mode is what a dragged eraser does; lassoAction is what the hold
        // gesture does when you draw a loop. They are separate keys because
        // the two gestures answer different questions, and because the mode
        // normaliser coerces anything that is not 'object' back to 'partial'.
        eraser: { size: 20, mode: 'partial', lassoAction: 'erase' },
        highlight: { size: 10, color: 'rgba(255,255,0,0.3)' },
        // A line segment is a measurement, not a mark. It comes out carrying its
        // length and the names of its ends by default; both toggle off in the
        // Line panel for anyone who wants a bare stroke.
        line: { size: 2, color: '#ffffff', lineType: 'solid', arrowStyle: 'triangle', lineKind: 'segment', showLabels: true, showLength: true, showAngle: true, showCoords: false, showMidpoint: false, fixedLength: null },
        shape: { size: 3, color: '#ffffff', shapeType: 'circle', triangleType: 'isosceles', fill: 'none', dash: 'solid' },
        settingsVersion: 2,
        compass: { color: null },
        angle: { color: null, size: 1.7, showText: true }
    },
    ppt: {
        active: false,
        name: '',
        renderMode: '',
        slides: [],
        currentSlide: 0
    },
    notebook: {
        active: false,
        paths: [],
        freeformPaths: [],
        transform: null,
        pageWidth: 794,
        pageHeight: 1123,
        pageGap: 96
    }
};
let clearCanvasResolve = null;
let clearCanvasLastFocus = null;

function syncToolbarLocationControls(location) {
    const normalized = normalizeToolbarLocation(location);
    document.querySelectorAll('[data-toolbar-location]').forEach((button) => {
        const active = button.dataset.toolbarLocation === normalized;
        button.classList.toggle('active', active);
        button.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
}

function indexToolbarButtons() {
    document.querySelectorAll('.toolbar .tool').forEach((button, index) => {
        button.style.setProperty('--toolbar-index', index);
    });
}

function applyToolbarLocation(location, options = {}) {
    const normalized = normalizeToolbarLocation(location);
    const state = window.appState;
    const previous = normalizeToolbarLocation(state?.toolbarLocation);
    const animate = !!options.animate && previous !== normalized;

    if (state) state.toolbarLocation = normalized;
    document.body.classList.toggle('toolbar-location-down', normalized === 'down');
    document.body.classList.toggle('toolbar-location-up', normalized !== 'down');
    indexToolbarButtons();
    syncToolbarLocationControls(normalized);

    if (animate) {
        document.body.classList.remove('toolbar-relocating');
        void document.body.offsetWidth;
        document.body.classList.add('toolbar-relocating');
        window.clearTimeout(window.__inkyscibToolbarMoveTimer);
        window.__inkyscibToolbarMoveTimer = window.setTimeout(() => {
            document.body.classList.remove('toolbar-relocating');
            handleWindowResize();
        }, 720);
    }

    requestAnimationFrame(() => {
        handleWindowResize();
    });

    if (options.persist !== false && typeof window.savePreferences === 'function') {
        window.savePreferences();
    }
}

function animateCanvasClear() {
    const state = window.appState;
    const drawingCanvas = document.getElementById('drawingCanvas');

    if (!drawingCanvas || drawingCanvas.width === 0 || drawingCanvas.height === 0) {
        return Promise.resolve();
    }

    // Clear is rare and needs an exact snapshot even if the last input event
    // was coalesced into the next animation frame.
    if (typeof window.renderNow === 'function') {
        window.renderNow();
    }

    const snapshot = document.createElement('canvas');
    snapshot.width = drawingCanvas.width;
    snapshot.height = drawingCanvas.height;
    const snapshotCtx = snapshot.getContext('2d');
    snapshotCtx.drawImage(drawingCanvas, 0, 0);

    state.clearAnimation = {
        snapshot,
        startedAt: performance.now(),
        duration: 420
    };

    document.body.classList.add('canvas-clearing');

    return new Promise((resolve) => {
        function step(now) {
            const animation = state.clearAnimation;
            if (!animation) {
                document.body.classList.remove('canvas-clearing');
                resolve();
                return;
            }

            animation.progress = Math.min(1, (now - animation.startedAt) / animation.duration);

            if (typeof window.render === 'function') {
                window.render();
            }

            if (animation.progress < 1) {
                window.requestAnimationFrame(step);
                return;
            }

            state.clearAnimation = null;
            document.body.classList.remove('canvas-clearing');
            resolve();
        }

        window.requestAnimationFrame(step);
    });
}

function ensureClearCanvasModal() {
    let modal = document.getElementById('clearCanvasModal');
    if (modal) return modal;

    modal = document.createElement('div');
    modal.id = 'clearCanvasModal';
    modal.className = 'clear-confirm-modal';
    modal.setAttribute('aria-hidden', 'true');
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'clearCanvasTitle');
    modal.innerHTML = `
        <div class="clear-confirm-panel">
            <button class="clear-confirm-close" type="button" aria-label="Close dialog" data-clear-cancel>
                <i class="fas fa-times"></i>
            </button>
            <div class="clear-confirm-head">
                <div class="clear-confirm-mark" aria-hidden="true">
                    <i class="fas fa-trash-can"></i>
                </div>
                <div class="clear-confirm-headings">
                    <h3 id="clearCanvasTitle">Clear the canvas?</h3>
                    <p class="clear-confirm-copy">Every stroke on this page goes. Undo brings them back.</p>
                </div>
            </div>
            <div class="clear-confirm-actions">
                <button class="clear-confirm-btn clear-confirm-cancel" type="button" data-clear-cancel>
                    Keep drawing
                </button>
                <button class="clear-confirm-btn clear-confirm-danger" type="button" data-clear-confirm>
                    Clear it
                </button>
            </div>
        </div>
    `;

    modal.addEventListener('click', (e) => {
        if (e.target === modal) {
            closeClearCanvasModal(false);
        }
    });

    modal.querySelectorAll('[data-clear-cancel]').forEach((button) => {
        button.addEventListener('click', () => closeClearCanvasModal(false));
    });

    modal.querySelector('[data-clear-confirm]').addEventListener('click', () => {
        modal.classList.add('is-confirming');
        window.setTimeout(() => closeClearCanvasModal(true), 180);
    });

    document.body.appendChild(modal);
    return modal;
}

function isClearCanvasModalOpen() {
    const modal = document.getElementById('clearCanvasModal');
    return !!modal && modal.classList.contains('active');
}

// The dialog's copy, so the one destructive confirm in the app can be reused
// rather than grown a second time. Defaults are exactly what it always said,
// so clearCanvas() keeps working untouched.
const CLEAR_CONFIRM_DEFAULTS = {
    title: 'Clear the canvas?',
    body: 'Every stroke on this page goes. Undo brings them back.',
    confirmLabel: 'Clear it',
    cancelLabel: 'Keep drawing'
};

function applyClearConfirmCopy(modal, options) {
    const copy = { ...CLEAR_CONFIRM_DEFAULTS, ...(options || {}) };
    const title = modal.querySelector('#clearCanvasTitle');
    const body = modal.querySelector('.clear-confirm-copy');
    const confirmBtn = modal.querySelector('.clear-confirm-danger');
    const cancelBtn = modal.querySelector('.clear-confirm-cancel');
    // textContent, not innerHTML: a notebook name reaches this straight from
    // the user.
    if (title) title.textContent = copy.title;
    if (body) body.textContent = copy.body;
    if (confirmBtn) confirmBtn.textContent = copy.confirmLabel;
    if (cancelBtn) cancelBtn.textContent = copy.cancelLabel;
}

function openClearCanvasModal(options) {
    const modal = ensureClearCanvasModal();
    applyClearConfirmCopy(modal, options);
    clearCanvasLastFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    modal.classList.remove('is-confirming');
    modal.classList.add('active');
    modal.setAttribute('aria-hidden', 'false');
    document.body.classList.add('clear-confirm-open');

    const cancelBtn = modal.querySelector('.clear-confirm-cancel');
    if (cancelBtn) {
        window.requestAnimationFrame(() => cancelBtn.focus());
    }
}

function closeClearCanvasModal(confirmed) {
    const modal = document.getElementById('clearCanvasModal');
    if (!modal || !clearCanvasResolve) return;

    modal.classList.remove('active', 'is-confirming');
    modal.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('clear-confirm-open');

    const resolve = clearCanvasResolve;
    clearCanvasResolve = null;

    const focusTarget = clearCanvasLastFocus;
    clearCanvasLastFocus = null;

    if (focusTarget && typeof focusTarget.focus === 'function') {
        window.requestAnimationFrame(() => focusTarget.focus());
    }

    resolve(confirmed);
}

// Called with no arguments this is still the clear-canvas confirm, word for
// word. Pass { title, body, confirmLabel, cancelLabel } to reuse it for another
// destructive action -- deleting a notebook from Recents does.
function showClearCanvasConfirm(options) {
    ensureClearCanvasModal();

    if (clearCanvasResolve) {
        clearCanvasResolve(false);
        clearCanvasResolve = null;
    }

    return new Promise((resolve) => {
        clearCanvasResolve = resolve;
        openClearCanvasModal(options);
    });
}

// A name that says what it is, for callers that are not clearing the canvas.
// Deliberately an alias of the same function rather than a wrapper: in a
// classic script a top-level `function foo` IS `window.foo`, so exporting a
// wrapper under an existing name silently replaces what the file's own calls
// resolve to. That is what broke every preference save until 2026-09-15.
window.showDestructiveConfirm = showClearCanvasConfirm;

function handleClearCanvasModalKeydown(e) {
    if (!isClearCanvasModalOpen()) return;

    const modal = document.getElementById('clearCanvasModal');
    if (!modal) return;

    if (e.key === 'Escape') {
        e.preventDefault();
        closeClearCanvasModal(false);
        return;
    }

    if (e.key !== 'Tab') return;

    const focusable = Array.from(modal.querySelectorAll('button'));
    if (focusable.length === 0) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
    }
}

document.addEventListener('keydown', handleClearCanvasModalKeydown);
async function initApp() {
    console.log('Initializing MAETHIST...');
    ensureClearCanvasModal();
    if (typeof window.loadDrawing === 'function') {
        await window.loadDrawing();
    } else {
        window.appState.storageReady = true;
    }
    if (!window.appState.toolSettings.shape) {
        window.appState.toolSettings.shape = {
            size: 3,
            color: '#ffffff',
            shapeType: 'circle',
            triangleType: 'isosceles'
        };
    } else if (!window.appState.toolSettings.shape.color || 
               window.appState.toolSettings.shape.color === 'black') {
        window.appState.toolSettings.shape.color = '#ffffff';
    }
    const theme = document.documentElement.dataset.theme || 'dark';
    if (theme === 'dark' && 
        (!window.appState.toolSettings.pen.color || 
         window.appState.toolSettings.pen.color === 'black')) {
        window.appState.toolSettings.pen.color = '#ffffff';
    }
    setTheme();
    applyToolbarLocation(window.appState.toolbarLocation || 'up', { animate: false, persist: false });
    setTool(window.appState.currentTool || 'pen');
    syncWorkspaceShellBounds();
    if (typeof window.syncUIWithSettings === 'function') {
        window.syncUIWithSettings();
    }
    if (typeof window.render === 'function') {
        window.render();
    }
    setupWindowEvents();
    requestAnimationFrame(handleWindowResize);
    
    console.log('MAETHIST initialized successfully.');
    // The editor is now genuinely usable. Nothing was covering it, so this
    // only releases the 180ms fade on the restored drawing -- and it is the
    // readiness signal the tests wait on, replacing the old boot-overlay class
    // which was a timer dressed up as a state.
    document.body.classList.add('app-ready');
}
function setTheme() {
    const html = document.documentElement;
    // The canvas preset owns the theme now: it names the chrome it pairs with
    // and swaps the default pen colour the same way the code below does.
    const canvasTheme = window.Inkyscib?.CanvasTheme;
    if (canvasTheme) {
        canvasTheme.set(canvasTheme.get().id, { persist: false, render: false });
        return;
    }
    const savedTheme = localStorage.getItem('theme');
    if (savedTheme) {
        html.dataset.theme = savedTheme;
    } else if (!html.dataset.theme) {
        // Follow the operating system when the user has not chosen. The
        // editor used to force dark here while the marketing pages followed
        // the OS, so a light-mode visitor got a light site and then a dark
        // editor and the two read as different products. The pen default
        // below already handles either ground.
        html.dataset.theme =
            window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    }
    // The default pen has to follow the ground it draws on, in BOTH
    // directions. This only ever flipped to white for a dark canvas, which was
    // harmless while the editor was always dark. Now that it follows the
    // operating system, a stored white default on a near-white page is
    // invisible ink.
    //
    // Only the two defaults are swapped for each other. A colour the user
    // actually picked is theirs and is never touched.
    const DARK_GROUND_PEN = '#ffffff';
    const LIGHT_GROUND_PEN = '#1b1b18';
    const penSettings = window.appState.toolSettings.pen;
    const wantsDarkPen = html.dataset.theme !== 'dark';
    const currentPen = (penSettings.color || '').toLowerCase();

    if (!currentPen || currentPen === 'black' || currentPen === '#000000') {
        penSettings.color = wantsDarkPen ? LIGHT_GROUND_PEN : DARK_GROUND_PEN;
    } else if (wantsDarkPen && currentPen === DARK_GROUND_PEN) {
        penSettings.color = LIGHT_GROUND_PEN;
    } else if (!wantsDarkPen && currentPen === LIGHT_GROUND_PEN) {
        penSettings.color = DARK_GROUND_PEN;
    }
}
function setupWindowEvents() {
    let resizeFrame = null;
    const scheduleWindowResize = () => {
        if (resizeFrame !== null) return;
        resizeFrame = requestAnimationFrame(() => {
            resizeFrame = null;
            handleWindowResize();
        });
    };

    window.addEventListener("resize", scheduleWindowResize, { passive: true });
    window.addEventListener("orientationchange", () => {
        setTimeout(() => {
            syncWorkspaceShellBounds();
            handleWindowResize();
        }, 400);
    });
    setInterval(() => {
        if (!document.hidden && typeof window.saveDrawing === 'function') {
            window.saveDrawing();
        }
    }, 30000);
}
function handleWindowResize() {
    syncWorkspaceShellBounds();
    const metrics = getCanvasMetrics();

    canvas.width = metrics.pixelWidth;
    canvas.height = metrics.pixelHeight;
    if (window.appState.ppt?.active) {
        clampPptTransform();
    }
    
    if (typeof window.softCanvasRefresh === 'function') {
        window.softCanvasRefresh();
    }
}
function getCanvasPos(e) {
    const clientX = e.touches?.[0]?.clientX ?? e.clientX;
    const clientY = e.touches?.[0]?.clientY ?? e.clientY;
    return clientPointToWorld(clientX, clientY);
}
function createPath(pos) {
    const state = window.appState;
    const settings = state.toolSettings[state.currentTool] || {};

    if (state.currentTool === 'manipulative') {
        const tile = window.Inkyscib?.Manipulatives?.createTilePath?.(pos);
        if (tile) return tile;
    }

    if (state.currentTool === 'shape') {
        const shapeSettings = state.toolSettings.shape || {};
        const shapeType = shapeSettings.shapeType;
        const smartGeometry = window.Inkyscib?.SmartGeometry;
        if (smartGeometry?.createShapePath) {
            const smartPath = smartGeometry.createShapePath(shapeType, pos, shapeSettings);
            if (smartPath) return smartPath;
        }

        // Keep compatibility with geometry builds that only expose smart circles.
        if (shapeType === 'circle' && smartGeometry?.createCirclePath) {
            return smartGeometry.createCirclePath(pos, shapeSettings);
        }
    }
    
    var path = {
        tool: state.currentTool,
        size: settings.size || 2,
        color: state.currentTool === 'eraser' ? null : (settings.color || '#ffffff'),
        shapeType: state.currentTool === 'shape' ? state.toolSettings.shape.shapeType : null,
        points: state.currentTool === 'line' || state.currentTool === 'shape' ? [pos, pos] : [pos],
        timestamp: Date.now()
    };

    if (state.currentTool === 'eraser') {
        path.eraseMode = settings.mode === 'object' ? 'object' : 'partial';
    }

    if (state.currentTool === 'pen') {
        path.penStyle = settings.style || 'default';
    }

    if (state.currentTool === 'line') {
        path.lineType = settings.lineType || 'solid';
        path.arrowStyle = settings.arrowStyle || 'triangle';
        // geometric kind, independent of the visual style
        // MAETHIST is a bounded page, so every drawn line is a finite segment.
        // Keep the property for old documents, but never create new rays or
        // infinite lines.
        path.lineKind = 'segment';
        // Whether this segment names its ends and reports its length. Set per
        // line, seeded from the tool's defaults; the letters themselves are
        // handed out once the line is actually committed.
        path.showLabels = settings.showLabels === true;
        path.showLength = settings.showLength === true;
        path.showAngle = settings.showAngle === true;
        path.showCoords = settings.showCoords === true;
        path.showMidpoint = settings.showMidpoint === true;
    }

    if (state.currentTool === 'shape' && path.shapeType === 'triangle') {
        path.triangleType = settings.triangleType || 'isosceles';
    }

    return path;
}
function setTool(tool) {
    const state = window.appState;
    if (state.currentPath?.tool === 'shape' &&
        state.currentPath.shapeType === 'triangle' &&
        state.currentPath.triangleType === 'custom') {
        state.isDrawing = false;
        state.currentPath = null;
    }
    window.appState.currentTool = tool;
    window.appState.panMode = false;
    window.appState.isPanning = false;
    // Keep the selected object while its tool panel opens. This is what lets
    // controls such as labels and measurements edit the object the user just
    // selected. The selection is cleared when the next canvas action starts.
    document.querySelectorAll('.tool').forEach(b => b.classList.remove('active'));
    const toolButton = document.getElementById(tool + 'Tool');
    if (toolButton) {
        toolButton.classList.add('active');
    }
    const panButton = document.getElementById('panMode');
    if (panButton) {
        panButton.classList.remove('active');
    }
    dispatchAppEvent('toolChanged', { tool });
    if (typeof window.savePreferences === 'function') {
        window.savePreferences();
    }
    
    console.log(`Tool changed to: ${tool}`);
}
function setPanMode(enabled) {
    const state = window.appState;
    state.panMode = enabled;
    state.isPanning = false;
    state.isDrawing = false;
    if (state.currentPath) {
        state.currentPath = null;
    }
    
    if (enabled) {
        document.querySelectorAll('.tool').forEach(b => b.classList.remove('active'));
        const panButton = document.getElementById('panMode');
        if (panButton) {
            panButton.classList.add('active');
        }
        canvas.style.cursor = 'grab';
    } else {
        const cursor = state.currentTool === 'line' ? 'crosshair' : 'default';
        canvas.style.cursor = cursor;
    }
    dispatchAppEvent('panModeChanged', { enabled });
}
function closeAllToolboxes() {
    const keepDocked = !!window.Inkyscib?.ToolDock?.isDockMode?.();
    document.querySelectorAll('.tool-options').forEach(opt => {
        if (keepDocked && opt.classList.contains('is-docked')) {
            return;
        }
        opt.style.display = 'none';
    });
    ['pen', 'eraser', 'highlight', 'line', 'shape'].forEach(tool => {
        const input = document.getElementById(`${tool}SizeInput`);
        const slider = document.getElementById(`${tool}Size`);
        const confirmed = window.appState.toolSettings[tool]?.size;
        
        if (input && input.value.trim() === '0' && confirmed) {
            input.value = confirmed;
        }
        if (slider && slider.value === '0' && confirmed) {
            slider.value = confirmed;
        }
    });
    // tool-dock.js decides which panel is showing, at every width: hide, then
    // hand back to it. This used to hand back only in dock mode, so below
    // 1180px every stroke start and canvas click (events.js) hid the floating
    // panel -- the sticky Compass and Angle panels too, the live readout of a
    // construction in progress -- while the dock still believed it was open,
    // and the next resize or tool sync brought it back unasked.
    window.Inkyscib?.ToolDock?.syncActivePanel?.();
}
function toggleToolbox(id) {
    const el = document.getElementById(id);
    if (el) {
        el.style.display = (el.style.display === 'flex') ? 'none' : 'flex';
    }
}
// History is snapshot-based: each entry is a deep copy of the whole paths
// array. A pop-the-last-path model cannot undo destructive edits like erasing
// (which splices/splits existing strokes) or moving/deleting a selection, so we
// snapshot the paths before every committed mutation instead.
const HISTORY_LIMIT = 80;

// A direct deep copy, in place of JSON.parse(JSON.stringify(path)). The round
// trip serialised every stroke to a string and reparsed it: 28 ms for a
// 2000-stroke page on a desktop, on every pen lift, which is why the lag
// arrived as the page filled.
//
// It stays a real deep copy. Sharing objects with the live array would let the
// partial eraser, which appends into path.erasers in place, reach back into a
// snapshot taken before it ran.
//
// undefined and function values are skipped so the result stays
// value-identical to what JSON produced, and self-references are refused the
// same way rather than looping forever.
// Depth rather than a visited Set: a page carries ~80,000 point objects, and
// an add/has/delete on each cost more than the copy itself. A path is four
// levels deep at worst (path -> erasers -> cut -> points -> point), so
// anything past __CLONE_MAX_DEPTH is a cycle, which throws and falls back the
// same way JSON.stringify would.
const __CLONE_MAX_DEPTH = 12;

function __cloneValue(value, depth) {
    if (value === null || typeof value !== 'object') return value;
    if (depth > __CLONE_MAX_DEPTH) throw new TypeError('path nested too deeply');
    const next = depth + 1;
    if (Array.isArray(value)) {
        const count = value.length;
        const out = new Array(count);
        for (let i = 0; i < count; i++) {
            const item = value[i];
            // JSON writes null for a hole, an undefined or a function in an array.
            out[i] = (item === undefined || typeof item === 'function')
                ? null
                : __cloneValue(item, next);
        }
        return out;
    }
    const out = {};
    const keys = Object.keys(value);
    for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        const item = value[key];
        if (item === undefined || typeof item === 'function') continue;
        out[key] = (item === null || typeof item !== 'object')
            ? item
            : __cloneValue(item, next);
    }
    return out;
}

function __clonePathSnapshot(paths) {
    return (paths || []).map(path => {
        if (path?.tool === 'youtube-frame' || path?.tool === 'image') {
            // Image data is immutable and can be shared by history snapshots.
            // Re-serializing its base64 payload on every pen stroke or resize
            // causes large pauses and memory spikes on low-end tablets. The
            // edit (crop, rotation, filters) is small and is copied, so undo
            // never shares it between steps.
            const copy = {
                ...path,
                points: (path.points || []).map(point => ({ ...point }))
            };
            if (path.edit && typeof path.edit === 'object') {
                copy.edit = { ...path.edit, crop: path.edit.crop ? { ...path.edit.crop } : path.edit.crop };
            }
            return copy;
        }
        try {
            return __cloneValue(path, 0);
        } catch (e) {
            try {
                return JSON.parse(JSON.stringify(path));
            } catch (e2) {
                return path;
            }
        }
    });
}

// Returns a deep copy of the current paths for use as a history entry.
function captureHistory() {
    const state = window.appState;
    return __clonePathSnapshot(state ? state.paths : []);
}

// Records a "before this change" snapshot and invalidates the redo branch.
// Pass an explicit snapshot when the mutation has already happened (e.g. a
// selection move), otherwise the current paths are captured.
function commitHistory(snapshot) {
    const state = window.appState;
    if (!state) return;
    if (!Array.isArray(state.undoStack)) state.undoStack = [];
    state.undoStack.push(Array.isArray(snapshot) ? snapshot : captureHistory());
    if (state.undoStack.length > HISTORY_LIMIT) state.undoStack.shift();
    state.redoStack = [];
}

// Replaces paths in place so references held elsewhere (PPT slides, notebook
// pages) keep pointing at the same array.
function __restorePaths(snapshot) {
    const state = window.appState;
    state.paths.splice(0, state.paths.length, ...snapshot);
    // Tile variables live beside the paths, so a restored snapshot has to
    // re-publish them or dependent tiles would keep the undone lengths.
    if (window.Inkyscib?.Manipulatives?.rebuildRegistryFromPaths) {
        window.Inkyscib.Manipulatives.rebuildRegistryFromPaths();
    }
}

function undo() {
    const state = window.appState;
    if (!state || !Array.isArray(state.undoStack) || state.undoStack.length === 0) return;
    if (!Array.isArray(state.redoStack)) state.redoStack = [];
    state.redoStack.push(captureHistory());
    __restorePaths(state.undoStack.pop());
    if (typeof window.render === 'function') {
        window.render();
    }
    if (typeof window.saveDrawing === 'function') {
        window.saveDrawing();
    }
    console.log('Undo performed');
}
function redo() {
    const state = window.appState;
    if (!state || !Array.isArray(state.redoStack) || state.redoStack.length === 0) return;
    if (!Array.isArray(state.undoStack)) state.undoStack = [];
    state.undoStack.push(captureHistory());
    __restorePaths(state.redoStack.pop());
    if (typeof window.render === 'function') {
        window.render();
    }
    if (typeof window.saveDrawing === 'function') {
        window.saveDrawing();
    }
    console.log('Redo performed');
}
async function clearCanvas() {
    const state = window.appState;
    const hasInk = state.paths.length > 0 || !!state.currentPath;

    if (!hasInk || state.clearAnimation) return;

    const confirmed = await showClearCanvasConfirm();
    if (!confirmed) return;

    // Snapshot before the wipe, not after. Clearing used to reset undoStack
    // outright, so the one action that destroys everything was the one action
    // Undo could not reach -- and the File ribbon promised the opposite.
    // commitHistory() also clears the redo branch, which is what we want here.
    commitHistory();

    await animateCanvasClear();
    state.paths = [];
    state.currentPath = null;
    if (typeof window.render === 'function') {
        window.render();
    }
    if (typeof window.saveDrawing === 'function') {
        window.saveDrawing();
    }
    console.log('Canvas cleared');
}
function softCanvasRefresh() {
    const state = window.appState;
    const zoom = state.transform.scale;
    const offsetX = state.transform.offsetX;
    const offsetY = state.transform.offsetY;
    const metrics = getCanvasMetrics();
    canvas.width = metrics.pixelWidth;
    canvas.height = metrics.pixelHeight;
    state.transform.scale = zoom;
    state.transform.offsetX = offsetX;
    state.transform.offsetY = offsetY;
    requestAnimationFrame(() => {
        if (typeof window.render === 'function') {
            window.render();
        }
    });
    
    console.log('Canvas refreshed');
}
function getCurrentPptSlide() {
    const ppt = window.appState?.ppt;
    if (!ppt?.active || !Array.isArray(ppt.slides) || ppt.slides.length === 0) return null;
    return ppt.slides[Math.max(0, Math.min(ppt.currentSlide || 0, ppt.slides.length - 1))] || null;
}

function getPptFitScale() {
    const slide = getCurrentPptSlide();
    const metrics = getCanvasMetrics();
    if (!slide || !metrics.width || !metrics.height) return 1;

    const pad = metrics.width < 720 ? 28 : 64;
    return Math.min(
        (metrics.width - pad) / slide.width,
        (metrics.height - pad) / slide.height
    );
}

function fitPptSlideToViewport() {
    const slide = getCurrentPptSlide();
    if (!slide) return;

    const metrics = getCanvasMetrics();
    const scale = Math.max(0.01, getPptFitScale());
    window.appState.transform.scale = scale;
    window.appState.transform.offsetX = (metrics.width - slide.width * scale) / 2;
    window.appState.transform.offsetY = (metrics.height - slide.height * scale) / 2;
}

function clampPptTransform(target = null) {
    const slide = getCurrentPptSlide();
    if (!slide) return;

    const tr = target || window.appState.transform;
    const metrics = getCanvasMetrics();
    const fit = Math.max(0.01, getPptFitScale());
    const minScale = fit * 0.92;
    const maxScale = fit * 4.5;

    tr.scale = Math.max(minScale, Math.min(maxScale, tr.scale));

    const viewW = slide.width * tr.scale;
    const viewH = slide.height * tr.scale;
    const edge = metrics.width < 720 ? 18 : 36;

    if (viewW <= metrics.width - edge * 2) {
        tr.offsetX = (metrics.width - viewW) / 2;
    } else {
        tr.offsetX = Math.min(edge, Math.max(metrics.width - viewW - edge, tr.offsetX));
    }

    if (viewH <= metrics.height - edge * 2) {
        tr.offsetY = (metrics.height - viewH) / 2;
    } else {
        tr.offsetY = Math.min(edge, Math.max(metrics.height - viewH - edge, tr.offsetY));
    }
}

function zoom(factor, centerX = null, centerY = null) {
    const state = window.appState;

    if (centerX === null || centerY === null) {
        const center = getCanvasCenterPoint();
        centerX = center.x;
        centerY = center.y;
    }

    const mx = centerX - state.transform.offsetX;
    const my = centerY - state.transform.offsetY;
    state.transform.offsetX -= mx * (factor - 1);
    state.transform.offsetY -= my * (factor - 1);
    
    state.transform.scale = Math.max(0.15, Math.min(6, state.transform.scale * factor));
    if (state.ppt?.active) {
        clampPptTransform();
    } else if (state.notebook?.active && typeof window.clampNotebookTransform === 'function') {
        window.clampNotebookTransform();
    }
    if (typeof window.render === 'function') {
        window.render();
    }
    if (typeof window.savePreferences === 'function') {
        window.savePreferences();
    } else if (typeof window.saveTransform === 'function') {
        window.saveTransform();
    }

    console.log(`Zoom: ${state.transform.scale.toFixed(2)}x`);
}
function resetView() {
    if (window.appState.ppt?.active) {
        fitPptSlideToViewport();
    } else if (window.appState.notebook?.active && typeof window.fitNotebookToViewport === 'function') {
        window.fitNotebookToViewport();
    } else {
        window.appState.transform = { scale: 1, offsetX: 0, offsetY: 0 };
    }
    if (typeof window.render === 'function') {
        window.render();
    }
    if (typeof window.savePreferences === 'function') {
        window.savePreferences();
    } else if (typeof window.saveTransform === 'function') {
        window.saveTransform();
    }
    
    console.log('View reset to default');
}
function dispatchAppEvent(eventName, detail) {
    const event = new CustomEvent(eventName, { detail });
    document.dispatchEvent(event);
}
function syncUIWithSettings() {
    const state = window.appState;
    ['pen', 'eraser', 'highlight', 'line', 'shape'].forEach(tool => {
        const slider = document.getElementById(`${tool}Size`);
        const input = document.getElementById(`${tool}SizeInput`);
        
        if (slider && state.toolSettings[tool]) slider.value = state.toolSettings[tool].size;
        if (input && state.toolSettings[tool]) input.value = state.toolSettings[tool].size;
    });
    if (state.toolSettings.pen.color) {
        if (state.toolSettings.pen.color.startsWith('#')) {
            const penColorInput = document.getElementById('penCustomColor');
            if (penColorInput) penColorInput.value = state.toolSettings.pen.color;
        }
    }
    
    if (state.toolSettings.highlight.color) {
        if (state.toolSettings.highlight.color.startsWith('rgba')) {
            const rgba = state.toolSettings.highlight.color.match(/\d+/g);
            if (rgba) {
                const hex = '#' + rgba.slice(0, 3).map(v => 
                    (+v).toString(16).padStart(2, '0')).join('');
                const highlightColorInput = document.getElementById('highlightCustomColor');
                if (highlightColorInput) highlightColorInput.value = hex;
            }
        }
    }
    
    if (state.toolSettings.line.color) {
        if (state.toolSettings.line.color.startsWith('#')) {
            const lineColorInput = document.getElementById('lineCustomColor');
            if (lineColorInput) lineColorInput.value = state.toolSettings.line.color;
        }
    }
    
    if (state.toolSettings.shape && state.toolSettings.shape.color) {
        if (state.toolSettings.shape.color.startsWith('#')) {
            const shapeColorInput = document.getElementById('shapeCustomColor');
            if (shapeColorInput) shapeColorInput.value = state.toolSettings.shape.color;
        }
    }
    updateColorSwatchSelection('penOptions', state.toolSettings.pen.color);
    updateColorSwatchSelection('highlightOptions', state.toolSettings.highlight.color);
    updateColorSwatchSelection('lineOptions', state.toolSettings.line.color);
    updateColorSwatchSelection('shapeOptions', state.toolSettings.shape?.color);
    if (typeof window.updatePenStyleSelection === 'function') {
        window.updatePenStyleSelection(state.toolSettings.pen.style || 'default');
    }
    if (typeof window.syncShapeSelectionFromState === 'function') {
        window.syncShapeSelectionFromState({ animate: false });
    }
    if (typeof window.updateTriangleTypeSelection === 'function') {
        window.updateTriangleTypeSelection(state.toolSettings.shape?.triangleType || 'isosceles');
    }
    
    console.log('UI synced with settings');
}
function updateColorSwatchSelection(containerId, color) {
    document.querySelectorAll(`#${containerId} .color-swatch`).forEach(s => {
        s.classList.toggle('active', s.dataset.color === color);
    });
}
function saveTransform() {
    const state = window.appState;
    localStorage.setItem('inkyscib_transform', JSON.stringify({
        scale: state.transform.scale,
        offsetX: state.transform.offsetX,
        offsetY: state.transform.offsetY
    }));
}
window.saveTransform = saveTransform;
document.addEventListener('DOMContentLoaded', initApp);
window.Inkyscib = window.Inkyscib || {};
window.Inkyscib.Core = {
    initApp,
    setTool,
    setPanMode,
    undo,
    redo,
    clearCanvas,
    zoom,
    resetView,
    getCanvasPos,
    createPath,
    closeAllToolboxes,
    toggleToolbox,
    softCanvasRefresh,
    dispatchAppEvent,
    syncUIWithSettings,
    updateColorSwatchSelection,
    saveTransform,
    getCanvasMetrics,
    invalidateCanvasMetrics,
    getCanvasPixelRatio,
    clientPointToCanvas,
    clientPointToWorld,
    getCurrentPptSlide,
    getPptFitScale,
    fitPptSlideToViewport,
    clampPptTransform,
    syncWorkspaceShellBounds,
    normalizeToolbarLocation,
    applyToolbarLocation,
    showClearCanvasConfirm,
    isClearCanvasModalOpen
};
window.setTool = setTool;
window.setPanMode = setPanMode;
window.undo = undo;
window.redo = redo;
window.captureHistory = captureHistory;
window.commitHistory = commitHistory;
window.clearCanvas = clearCanvas;
window.zoom = zoom;
window.resetView = resetView;
window.getCanvasPos = getCanvasPos;
window.createPath = createPath;
window.closeAllToolboxes = closeAllToolboxes;
window.toggleToolbox = toggleToolbox;
window.softCanvasRefresh = softCanvasRefresh;
window.dispatchAppEvent = dispatchAppEvent;
window.syncUIWithSettings = syncUIWithSettings;
window.updateColorSwatchSelection = updateColorSwatchSelection;
window.saveTransform = saveTransform;
window.getCanvasMetrics = getCanvasMetrics;
window.invalidateCanvasMetrics = invalidateCanvasMetrics;
window.getCanvasPixelRatio = getCanvasPixelRatio;
window.clientPointToCanvas = clientPointToCanvas;
window.clientPointToWorld = clientPointToWorld;
window.getCurrentPptSlide = getCurrentPptSlide;
window.getPptFitScale = getPptFitScale;
window.fitPptSlideToViewport = fitPptSlideToViewport;
window.clampPptTransform = clampPptTransform;
window.syncWorkspaceShellBounds = syncWorkspaceShellBounds;
window.normalizeToolbarLocation = normalizeToolbarLocation;
window.applyToolbarLocation = applyToolbarLocation;
window.showClearCanvasConfirm = showClearCanvasConfirm;
window.isClearCanvasModalOpen = isClearCanvasModalOpen;
