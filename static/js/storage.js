const INKYSCIB_VALID_TOOLS = ['select', 'pen', 'eraser', 'highlight', 'line', 'shape', 'manipulative', 'compass', 'angle'];
const INKYSCIB_PEN_STYLES = ['default', 'fountain', 'brush', 'gel', 'calligraphy'];
const INKYSCIB_LEGACY_PEN_COLORS = {
    blue: 'rgb(22, 240, 244)',
    green: 'rgb(27, 230, 27)',
    yellow: 'rgb(240, 240, 21)'
};
const INKYSCIB_TOOLBAR_LOCATIONS = ['up', 'down'];
const INKYSCIB_DB_NAME = 'inkyscib_cache';
// v2 adds the `documents` store, which holds imported files as Blobs so the
// original upload survives the import instead of only its rasterised preview.
const INKYSCIB_DB_VERSION = 2;
const INKYSCIB_DB_STORE = 'records';
const INKYSCIB_DB_DOCUMENT_STORE = 'documents';
const INKYSCIB_MAX_MEDIA_DATA_URL_LENGTH = 2 * 1024 * 1024;
const INKYSCIB_GEOMETRY_CONSTRUCTIONS = new Set([
    'radius',
    'diameter',
    'chord',
    'arc',
    'central-angle',
    'inscribed-angle',
    'cyclic-quadrilateral',
    'tangent'
]);
// Smart polygon kinds and their corner counts. Mirrors POLYGON_VERTEX_COUNT in
// static/js/geometry.js, which also knows the triangle separately.
const INKYSCIB_SMART_POLYGON_VERTICES = {
    triangle: 3,
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
const INKYSCIB_SMART_POLYGON_KINDS = new Set(Object.keys(INKYSCIB_SMART_POLYGON_VERTICES));
// Smart kinds stored as a fixed number of points that are not corners: the
// circle's bounding box and the ellipse's four axis ends. They keep geometry
// precision but get no vertex labels.
const INKYSCIB_SMART_POINT_KINDS = { circle: 2, ellipse: 4 };
// A shape's fill and outline. Only a value other than the default is saved.
const INKYSCIB_SHAPE_FILLS = new Set(['none', 'tint', 'solid']);
const INKYSCIB_SHAPE_DASHES = new Set(['solid', 'dashed', 'dotted']);

let inkyscibDbPromise = null;
let drawingSaveTimer = null;
let drawingSaveIdleCallback = null;
let drawingSaveInFlight = null;
let drawingSaveRequested = false;
const INKYSCIB_SAVE_DEBOUNCE_MS = Number(navigator.deviceMemory || 4) <= 4 ? 1000 : 650;

function normalizePenStyle(style) {
    if (style === 'marker') return 'calligraphy';
    return INKYSCIB_PEN_STYLES.includes(style) ? style : 'default';
}

function normalizePenColor(color) {
    return INKYSCIB_LEGACY_PEN_COLORS[color] || color;
}

function normalizeStoredToolbarLocation(location) {
    if (typeof window.normalizeToolbarLocation === 'function') {
        return window.normalizeToolbarLocation(location);
    }
    return INKYSCIB_TOOLBAR_LOCATIONS.includes(location) ? location : 'up';
}

function roundStoredNumber(value, places = 2) {
    if (!Number.isFinite(value)) return value;
    const factor = 10 ** places;
    return Math.round(value * factor) / factor;
}

function compactPoint(point, coordinatePlaces = 2) {
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;

    const compact = {
        x: roundStoredNumber(point.x, coordinatePlaces),
        y: roundStoredNumber(point.y, coordinatePlaces)
    };

    if (Number.isFinite(point.pressure)) {
        compact.pressure = roundStoredNumber(point.pressure, 3);
    }

    return compact;
}

function compactEraserCut(eraser) {
    if (!eraser || !Array.isArray(eraser.points)) return null;

    const points = eraser.points.map(compactPoint).filter(Boolean);
    if (points.length === 0) return null;

    const compact = {
        tool: 'eraser',
        points
    };

    if (Number.isFinite(eraser.size)) compact.size = roundStoredNumber(eraser.size);
    if (eraser.timestamp !== undefined) compact.timestamp = eraser.timestamp;

    return compact;
}

function compactBounds(bounds) {
    if (!bounds ||
        !Number.isFinite(bounds.left) ||
        !Number.isFinite(bounds.right) ||
        !Number.isFinite(bounds.top) ||
        !Number.isFinite(bounds.bottom)) {
        return null;
    }
    return {
        left: roundStoredNumber(bounds.left),
        right: roundStoredNumber(bounds.right),
        top: roundStoredNumber(bounds.top),
        bottom: roundStoredNumber(bounds.bottom)
    };
}

function compactGeometryConstruction(construction) {
    if (!construction || !INKYSCIB_GEOMETRY_CONSTRUCTIONS.has(construction.type)) return null;
    const compact = {
        id: typeof construction.id === 'string'
            ? construction.id.slice(0, 80)
            : `geometry-${Date.now().toString(36)}`,
        type: construction.type
    };
    ['angle', 'startAngle', 'endAngle', 'vertexAngle'].forEach((key) => {
        if (Number.isFinite(construction[key])) compact[key] = roundStoredNumber(construction[key], 6);
    });
    if (Array.isArray(construction.angles)) {
        compact.angles = construction.angles
            .filter(Number.isFinite)
            .slice(0, 4)
            .map((angle) => roundStoredNumber(angle, 6));
    }
    return compact;
}

function smartGeometryVertexCount(path) {
    const version = Number(path?.geometryVersion);
    if (!path || path.tool !== 'shape' || version !== 1) return 0;
    if (path.geometryKind !== path.shapeType) return 0;
    const count = INKYSCIB_SMART_POINT_KINDS[path.geometryKind] ||
        INKYSCIB_SMART_POLYGON_VERTICES[path.geometryKind] || 0;
    return count > 0 && Array.isArray(path.points) && path.points.length >= count ? count : 0;
}

function compactVertexLabels(labels, count) {
    return Array.from({ length: count }, (_, index) => {
        const value = Array.isArray(labels) ? labels[index] : null;
        const fallback = String.fromCharCode(65 + index);
        if (typeof value !== 'string') return fallback;
        return value.trim().slice(0, 12) || fallback;
    });
}

function compactAngleMarks(marks) {
    return Array.from({ length: 3 }, (_, index) => !!(Array.isArray(marks) && marks[index]));
}

function compactLockedAngles(angles) {
    return Array.from({ length: 3 }, (_, index) => {
        const value = Array.isArray(angles) ? angles[index] : null;
        return Number.isFinite(value) ? roundStoredNumber(value, 10) : null;
    });
}

function compactPath(path) {
    if (!path || !Array.isArray(path.points)) return null;

    // An inserted picture is only as trustworthy as its data URL: an oversized
    // or malformed one would be carried into every history snapshot and every
    // save, so it is dropped at the boundary rather than stored.
    if (path.tool === 'image') {
        const validImage = typeof path.image === 'string' &&
            /^data:image\/(?:jpeg|png|webp|gif);base64,/i.test(path.image) &&
            path.image.length <= INKYSCIB_MAX_MEDIA_DATA_URL_LENGTH;
        if (!validImage) return null;
    }

    if (path.tool === 'youtube-frame') {
        const validImage = typeof path.image === 'string' &&
            /^data:image\/(?:jpeg|png|webp);base64,/i.test(path.image) &&
            path.image.length <= INKYSCIB_MAX_MEDIA_DATA_URL_LENGTH;
        const validVideo = typeof path.videoId === 'string' && /^[A-Za-z0-9_-]{11}$/.test(path.videoId);
        if (!validImage || !validVideo) return null;
    }

    // Construction geometry is exact mathematics, not ink: rounding an
    // intersection to 2dp would move it off the arcs that produced it, so it
    // is stored at the same precision as smart geometry.
    const geometryPointPrecision =
        smartGeometryVertexCount(path) > 0 ||
        path.tool === 'construction' ||
        path.tool === 'line' ? 6 : 2;
    const points = path.points.map((point) => compactPoint(point, geometryPointPrecision)).filter(Boolean);
    if (points.length === 0) return null;

    const compact = { points };
    [
        'tool',
        'color',
        'shapeType',
        'triangleType',
        'geometryKind',
        // construction geometry (compass / ruler-and-compass constructions)
        'geomType',
        'gid',
        'label',
        'origin',
        'isConstruction',
        'full',
        'sourceIds',
        'centerId',
        'startPointId',
        'endPointId',
        'radiusSource',
        'showAngle',
        'mode',
        'variableLabel',
        'widthLabel',
        'heightLabel',
        'lineType',
        'lineKind',
        'arrowStyle',
        // per-segment labelling
        'showLabels',
        'showLength',
        'showCoords',
        'showMidpoint',
        'labelStart',
        'labelEnd',
        'image',
        'videoId',
        'videoTitle',
        'timestamp'
    ].forEach((key) => {
        if (path[key] !== undefined) compact[key] = path[key];
    });

    ['size', 'width', 'height', 'centerX', 'centerY', 'rotation', 'videoTime', 'frameTime', 'aspectRatio',
        'geometryVersion', 'unitScale', 'radius', 'radiusAngle', 'tileVersion',
        'startAngle', 'endAngle'].forEach((key) => {
        if (Number.isFinite(path[key])) {
            // Construction radii and arc angles define exact geometry: at 2dp
            // an arc endpoint drifts off the intersection that created it, so
            // they keep full working precision.
            const exactGeometryKey =
                path.tool === 'construction' && (key === 'radius' || key === 'startAngle' || key === 'endAngle');
            const precision = key === 'rotation' || exactGeometryKey
                ? 10
                : key === 'aspectRatio' || key === 'radiusAngle' ? 6 : 2;
            compact[key] = roundStoredNumber(path[key], precision);
        }
    });

    ['radiusLocked', 'showMeasurements', 'showAxes', 'snapToGrid', 'snapToObjects', 'negative'].forEach((key) => {
        if (typeof path[key] === 'boolean') compact[key] = path[key];
    });

    if (path.tool === 'shape') {
        if (INKYSCIB_SHAPE_FILLS.has(path.fill) && path.fill !== 'none') compact.fill = path.fill;
        if (INKYSCIB_SHAPE_DASHES.has(path.dash) && path.dash !== 'solid') compact.dash = path.dash;
    }

    if (Number(path.geometryVersion) === 1 && path.geometryKind === 'circle') {
        compact.constructions = Array.isArray(path.constructions)
            ? path.constructions.map(compactGeometryConstruction).filter(Boolean)
            : [];
    }

    const geometryVertexCount = smartGeometryVertexCount(path);
    if (geometryVertexCount >= 3 && INKYSCIB_SMART_POLYGON_KINDS.has(path.geometryKind)) {
        compact.vertexLabels = compactVertexLabels(path.vertexLabels, geometryVertexCount);
        if (path.geometryKind === 'triangle') {
            compact.angleMarks = compactAngleMarks(path.angleMarks);
            compact.lockedAngles = compactLockedAngles(path.lockedAngles);
        }
    }

    if (path.tool === 'pen' || path.penStyle || path.style) {
        compact.penStyle = normalizePenStyle(path.penStyle || path.style || 'default');
    }

    const erasers = Array.isArray(path.erasers)
        ? path.erasers.map(compactEraserCut).filter(Boolean)
        : [];
    if (erasers.length > 0) compact.erasers = erasers;

    const componentPoints = Array.isArray(path.componentPoints)
        ? path.componentPoints.map(compactPoint).filter(Boolean)
        : [];
    if (componentPoints.length > 0) compact.componentPoints = componentPoints;

    const componentBounds = compactBounds(path.componentBounds);
    if (componentBounds) compact.componentBounds = componentBounds;

    return compact;
}

function normalizeLoadedPath(path) {
    if (!path || !Array.isArray(path.points)) return null;

    if (path.tool === 'youtube-frame') {
        const validImage = typeof path.image === 'string' &&
            /^data:image\/(?:jpeg|png|webp);base64,/i.test(path.image) &&
            path.image.length <= INKYSCIB_MAX_MEDIA_DATA_URL_LENGTH;
        const validVideo = typeof path.videoId === 'string' && /^[A-Za-z0-9_-]{11}$/.test(path.videoId);
        if (!validImage || !validVideo) return null;
    }

    // Construction geometry is exact mathematics, not ink: rounding an
    // intersection to 2dp would move it off the arcs that produced it, so it
    // is stored at the same precision as smart geometry.
    const geometryPointPrecision =
        smartGeometryVertexCount(path) > 0 || path.tool === 'construction' ? 6 : 2;
    const points = path.points.map((point) => compactPoint(point, geometryPointPrecision)).filter(Boolean);
    if (points.length === 0) return null;

    const normalized = { ...path, points };
    if (normalized.tool === 'youtube-frame') {
        const storedAspect = Number(normalized.aspectRatio);
        normalized.aspectRatio = Number.isFinite(storedAspect) && storedAspect > 0
            ? storedAspect
            : 16 / 9;

        // Repair captures resized by older builds that allowed freeform media
        // scaling. Keep the chosen width and centre while restoring the frame's
        // native proportions.
        if (normalized.points.length >= 2) {
            const start = normalized.points[0];
            const end = normalized.points[1];
            const width = Math.abs(end.x - start.x);
            const height = Math.abs(end.y - start.y);
            const currentAspect = width / Math.max(0.001, height);
            if (width > 0.5 && Math.abs(currentAspect - normalized.aspectRatio) > 0.01) {
                const centerY = (start.y + end.y) / 2;
                const directionY = end.y >= start.y ? 1 : -1;
                const repairedHeight = width / normalized.aspectRatio;
                start.y = centerY - directionY * repairedHeight / 2;
                end.y = centerY + directionY * repairedHeight / 2;
            }
        }
    }
    if (normalized.penStyle || normalized.style || normalized.tool === 'pen') {
        normalized.penStyle = normalizePenStyle(normalized.penStyle || normalized.style || 'default');
        delete normalized.style;
    }

    if (normalized.tool === 'shape' && normalized.shapeType === 'triangle' && !normalized.triangleType) {
        normalized.triangleType = 'isosceles';
    }

    if (normalized.tool === 'shape') {
        normalized.fill = INKYSCIB_SHAPE_FILLS.has(normalized.fill) ? normalized.fill : 'none';
        normalized.dash = INKYSCIB_SHAPE_DASHES.has(normalized.dash) ? normalized.dash : 'solid';
    }

    if (normalized.tool === 'manipulative') {
        normalized.widthLabel = typeof normalized.widthLabel === 'string' ? normalized.widthLabel.slice(0, 64) : '';
        normalized.heightLabel = typeof normalized.heightLabel === 'string' ? normalized.heightLabel.slice(0, 64) : '';
        normalized.negative = !!normalized.negative;
        normalized.showMeasurements = normalized.showMeasurements !== false;
        if (window.Inkyscib?.Manipulatives?.normalizeTile) {
            window.Inkyscib.Manipulatives.normalizeTile(normalized);
        }
    }

    const geometryVertexCount = smartGeometryVertexCount(normalized);
    if (geometryVertexCount > 0) {
        normalized.showMeasurements = normalized.showMeasurements !== false;
        normalized.snapToGrid = normalized.snapToGrid !== false;
        normalized.snapToObjects = normalized.snapToObjects !== false;

        if (normalized.geometryKind === 'circle') {
            normalized.constructions = Array.isArray(normalized.constructions)
                ? normalized.constructions.map(compactGeometryConstruction).filter(Boolean)
                : [];
            normalized.radiusLocked = !!normalized.radiusLocked;
        } else if (INKYSCIB_SMART_POLYGON_KINDS.has(normalized.geometryKind)) {
            normalized.vertexLabels = compactVertexLabels(normalized.vertexLabels, geometryVertexCount);
            if (normalized.geometryKind === 'triangle') {
                normalized.angleMarks = compactAngleMarks(normalized.angleMarks);
                normalized.lockedAngles = compactLockedAngles(normalized.lockedAngles);
            }
        }

        if (window.Inkyscib?.SmartGeometry?.normalizeSmartGeometry) {
            window.Inkyscib.SmartGeometry.normalizeSmartGeometry(normalized);
        } else if (normalized.geometryKind === 'circle' && window.Inkyscib?.SmartGeometry?.normalizeCircle) {
            window.Inkyscib.SmartGeometry.normalizeCircle(normalized);
        }
    }

    if (normalized.rotation !== undefined && !Number.isFinite(normalized.rotation)) {
        delete normalized.rotation;
    }

    const erasers = Array.isArray(path.erasers)
        ? path.erasers.map(compactEraserCut).filter(Boolean)
        : [];
    if (erasers.length > 0) {
        normalized.erasers = erasers;
    } else {
        delete normalized.erasers;
    }

    const componentPoints = Array.isArray(path.componentPoints)
        ? path.componentPoints.map(compactPoint).filter(Boolean)
        : [];
    if (componentPoints.length > 0) {
        normalized.componentPoints = componentPoints;
    } else {
        delete normalized.componentPoints;
    }

    const componentBounds = compactBounds(path.componentBounds);
    if (componentBounds) {
        normalized.componentBounds = componentBounds;
    } else {
        delete normalized.componentBounds;
    }

    return normalized;
}

function safeSetItem(key, value) {
    try {
        localStorage.setItem(key, value);
        return true;
    } catch (e) {
        console.warn(`Failed to save ${key}:`, e);
        return false;
    }
}

function safeGetItem(key) {
    try {
        return localStorage.getItem(key);
    } catch (e) {
        console.warn(`Failed to read ${key}:`, e);
        return null;
    }
}

function openInkyscibDb() {
    if (!window.indexedDB) return Promise.resolve(null);
    if (inkyscibDbPromise) return inkyscibDbPromise;

    inkyscibDbPromise = new Promise((resolve) => {
        const request = indexedDB.open(INKYSCIB_DB_NAME, INKYSCIB_DB_VERSION);

        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(INKYSCIB_DB_STORE)) {
                db.createObjectStore(INKYSCIB_DB_STORE);
            }
            // Upgrading from v1 keeps every existing record; this only adds
            // somewhere for original uploads to live.
            if (!db.objectStoreNames.contains(INKYSCIB_DB_DOCUMENT_STORE)) {
                db.createObjectStore(INKYSCIB_DB_DOCUMENT_STORE);
            }
        };

        request.onsuccess = () => {
            const db = request.result;
            // A second tab still holding an older schema would otherwise block
            // the upgrade and leave that tab unable to save. Step aside for it.
            db.onversionchange = () => {
                try {
                    db.close();
                } catch (error) {
                    console.warn('Could not release the Inkyscib database for upgrade:', error);
                }
                inkyscibDbPromise = null;
            };
            resolve(db);
        };
        request.onerror = () => {
            console.warn('IndexedDB unavailable for Inkyscib:', request.error);
            resolve(null);
        };
        request.onblocked = () => {
            console.warn('IndexedDB upgrade blocked for Inkyscib.');
            resolve(null);
        };
    });

    return inkyscibDbPromise;
}

async function writeStoredRecord(key, value) {
    const db = await openInkyscibDb();
    if (!db) return false;

    return new Promise((resolve) => {
        const tx = db.transaction(INKYSCIB_DB_STORE, 'readwrite');
        const store = tx.objectStore(INKYSCIB_DB_STORE);
        store.put({ value, savedAt: Date.now() }, key);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => {
            console.warn(`Failed to save ${key} in IndexedDB:`, tx.error);
            resolve(false);
        };
        tx.onabort = () => {
            console.warn(`IndexedDB save aborted for ${key}:`, tx.error);
            resolve(false);
        };
    });
}

async function readStoredRecord(key) {
    const db = await openInkyscibDb();
    if (!db) return { found: false, value: null, savedAt: 0 };

    return new Promise((resolve) => {
        const tx = db.transaction(INKYSCIB_DB_STORE, 'readonly');
        const request = tx.objectStore(INKYSCIB_DB_STORE).get(key);

        request.onsuccess = () => {
            if (request.result === undefined) {
                resolve({ found: false, value: null, savedAt: 0 });
                return;
            }

            resolve({
                found: true,
                value: request.result.value,
                savedAt: Number(request.result.savedAt) || 0
            });
        };

        request.onerror = () => {
            console.warn(`Failed to read ${key} from IndexedDB:`, request.error);
            resolve({ found: false, value: null, savedAt: 0 });
        };
    });
}

function buildPreferences(state) {
    return {
        currentTool: state.currentTool,
        toolSettings: state.toolSettings,
        transform: {
            scale: state.transform.scale,
            offsetX: state.transform.offsetX,
            offsetY: state.transform.offsetY
        },
        toolbarLocation: normalizeStoredToolbarLocation(state.toolbarLocation),
        theme: document.documentElement.dataset.theme || 'dark',
        canvasTheme: window.Inkyscib?.CanvasTheme?.get?.().id || null,
        // What every tool calls its measurements; see static/js/units.js.
        unitName: window.Inkyscib?.Units?.get?.() || 'u'
    };
}

function applyPreferences(preferences, state) {
    if (!preferences || !state) return false;

    if (typeof preferences.unitName === 'string') {
        window.Inkyscib?.Units?.applyStored(preferences.unitName);
    }

    if (INKYSCIB_VALID_TOOLS.includes(preferences.currentTool)) {
        state.currentTool = preferences.currentTool;
    }

    const parsed = preferences.toolSettings || {};
    if (parsed.pen) {
        parsed.pen.color = normalizePenColor(parsed.pen.color);
        if (document.documentElement.dataset.theme === 'dark' &&
            (!parsed.pen.color || parsed.pen.color === 'black')) {
            parsed.pen.color = '#ffffff';
        }
        parsed.pen.style = normalizePenStyle(parsed.pen.style);
        Object.assign(state.toolSettings.pen, parsed.pen);
    }

    if (parsed.eraser) Object.assign(state.toolSettings.eraser, parsed.eraser);

    if (parsed.compass) {
        if (!state.toolSettings.compass) state.toolSettings.compass = { color: null };
        Object.assign(state.toolSettings.compass, parsed.compass);
    }

    if (parsed.highlight) {
        if (!parsed.highlight.color) {
            parsed.highlight.color = 'rgba(255,255,0,0.3)';
        }
        Object.assign(state.toolSettings.highlight, parsed.highlight);
    }

    if (parsed.line) {
        if (document.documentElement.dataset.theme === 'dark' &&
            (!parsed.line.color || parsed.line.color === 'black')) {
            parsed.line.color = '#ffffff';
        }
        // Length and end names used to default off, so anyone who has opened the
        // app before carries `false` in their saved settings and would never see
        // the new default. Adopt it once, then respect whatever they choose from
        // then on. The stamp is what stops this re-running and overriding them.
        if (parsed.settingsVersion !== 2) {
            delete parsed.showLabels;
            delete parsed.showLength;
            delete parsed.line.showLabels;
            delete parsed.line.showLength;
        }
        Object.assign(state.toolSettings.line, parsed.line);
    }

    // Stamped so the adoption above runs exactly once. The next savePreferences
    // writes it, and from then on the user's own choice is what loads.
    state.toolSettings.settingsVersion = 2;

    if (parsed.manipulative) {
        if (!state.toolSettings.manipulative) {
            state.toolSettings.manipulative = {
                preset: 'x',
                color: '#7c74ff',
                negative: false,
                size: 2,
                showMeasurements: true
            };
        }
        Object.assign(state.toolSettings.manipulative, parsed.manipulative);
    }

    if (parsed.shape) {
        if (!state.toolSettings.shape) {
            state.toolSettings.shape = { size: 3, color: '#ffffff', shapeType: 'circle', triangleType: 'isosceles', fill: 'none', dash: 'solid' };
        }
        Object.assign(state.toolSettings.shape, parsed.shape);
    }

    if (preferences.shapeSettings) {
        if (!state.toolSettings.shape) {
            state.toolSettings.shape = { size: 3, color: '#ffffff', shapeType: 'circle', triangleType: 'isosceles', fill: 'none', dash: 'solid' };
        }
        Object.assign(state.toolSettings.shape, preferences.shapeSettings);
    }

    if (!state.toolSettings.shape) {
        state.toolSettings.shape = { size: 3, color: '#ffffff', shapeType: 'circle', triangleType: 'isosceles', fill: 'none', dash: 'solid' };
    }

    if (!state.toolSettings.shape.color || state.toolSettings.shape.color === 'black') {
        state.toolSettings.shape.color = '#ffffff';
    }

    if (!state.toolSettings.shape.triangleType) {
        state.toolSettings.shape.triangleType = 'isosceles';
    }

    const transform = preferences.transform;
    if (transform &&
        Number.isFinite(transform.scale) &&
        Number.isFinite(transform.offsetX) &&
        Number.isFinite(transform.offsetY)) {
        state.transform.scale = transform.scale;
        state.transform.offsetX = transform.offsetX;
        state.transform.offsetY = transform.offsetY;
    }

    // The canvas preset carries its chrome theme. A record saved before presets
    // existed knows only light or dark; adoptChrome keeps the current preset
    // when it already pairs with that.
    const canvasTheme = window.Inkyscib?.CanvasTheme;
    const presetApplied = !!(canvasTheme && preferences.canvasTheme &&
        canvasTheme.set(preferences.canvasTheme, { persist: false, render: false }));
    if (!presetApplied && preferences.theme) {
        document.documentElement.dataset.theme = preferences.theme;
        canvasTheme?.adoptChrome?.(preferences.theme);
    }

    if (preferences.toolbarLocation) {
        state.toolbarLocation = normalizeStoredToolbarLocation(preferences.toolbarLocation);
    }

    return true;
}

function readLocalPreferences() {
    const preferences = {};
    let hasValue = false;

    const savedUnitName = safeGetItem('inkyscib_unit_name');
    if (savedUnitName) {
        preferences.unitName = savedUnitName;
        hasValue = true;
    }

    const savedTool = safeGetItem('inkyscib_tool');
    if (savedTool && INKYSCIB_VALID_TOOLS.includes(savedTool)) {
        preferences.currentTool = savedTool;
        hasValue = true;
    }

    const savedSettings = safeGetItem('inkyscib_settings');
    if (savedSettings) {
        try {
            preferences.toolSettings = JSON.parse(savedSettings);
            hasValue = true;
        } catch (e) {
            console.error('Failed to parse settings:', e);
        }
    }

    const savedShape = safeGetItem('inkyscib_shape_settings');
    if (savedShape) {
        try {
            preferences.shapeSettings = JSON.parse(savedShape);
            hasValue = true;
        } catch (e) {
            console.error('Failed to parse shape settings:', e);
        }
    }

    const savedTransform = safeGetItem('inkyscib_transform');
    if (savedTransform) {
        try {
            preferences.transform = JSON.parse(savedTransform);
            hasValue = true;
        } catch (e) {
            console.error('Failed to parse transform:', e);
        }
    }

    const savedTheme = safeGetItem('theme');
    if (savedTheme) {
        preferences.theme = savedTheme;
        hasValue = true;
    }

    const savedCanvasTheme = safeGetItem('inkyscib-canvas-theme');
    if (savedCanvasTheme) {
        preferences.canvasTheme = savedCanvasTheme;
        hasValue = true;
    }

    const savedToolbarLocation = safeGetItem('inkyscib_toolbar_location');
    if (savedToolbarLocation) {
        preferences.toolbarLocation = normalizeStoredToolbarLocation(savedToolbarLocation);
        hasValue = true;
    }

    if (!hasValue) return null;

    return {
        value: preferences,
        savedAt: Number(safeGetItem('inkyscib_preferences_saved_at')) || 0
    };
}

// The immediate write. Not named savePreferences: in a classic script a
// top-level function declaration and window.savePreferences are one binding,
// so exporting the debounced scheduler under that name below replaced this
// function, and the scheduler's timer called itself forever. No preference
// reached storage.
function writePreferences() {
    const state = window.appState;
    if (!state) return false;

    const preferences = buildPreferences(state);
    const savedAt = Date.now();
    let ok = true;

    ok = safeSetItem('inkyscib_tool', preferences.currentTool) && ok;
    if (preferences.unitName) {
        ok = safeSetItem('inkyscib_unit_name', preferences.unitName) && ok;
    }
    ok = safeSetItem('inkyscib_settings', JSON.stringify(preferences.toolSettings)) && ok;
    ok = safeSetItem('inkyscib_transform', JSON.stringify(preferences.transform)) && ok;
    ok = safeSetItem('inkyscib_toolbar_location', preferences.toolbarLocation) && ok;
    ok = safeSetItem('theme', preferences.theme) && ok;
    // The pre-paint script in write.html reads this key to stamp the canvas
    // before first paint.
    if (preferences.canvasTheme) {
        ok = safeSetItem('inkyscib-canvas-theme', preferences.canvasTheme) && ok;
    }
    ok = safeSetItem('inkyscib_preferences_saved_at', String(savedAt)) && ok;

    if (preferences.toolSettings.shape) {
        ok = safeSetItem('inkyscib_shape_settings', JSON.stringify(preferences.toolSettings.shape)) && ok;
    }

    window.__inkyscibLastPreferenceSave = writeStoredRecord('preferences', preferences);
    return ok;
}

function compactPptDeck(state) {
    const ppt = state?.ppt;
    if (!ppt?.active || !Array.isArray(ppt.slides) || ppt.slides.length === 0) return null;

    const currentSlide = Math.max(0, Math.min(ppt.currentSlide || 0, ppt.slides.length - 1));

    return {
        active: true,
        name: ppt.name || 'Inkyscib presentation',
        renderMode: ppt.renderMode || 'browser',
        // Points at the original upload in the `documents` store. Decks
        // imported before that store existed have none, and keep working from
        // their rasterised pages alone.
        docId: typeof ppt.docId === 'string' ? ppt.docId : null,
        currentSlide,
        slides: ppt.slides.map((slide, index) => ({
            index,
            pageIndex: Number.isFinite(slide.pageIndex) ? slide.pageIndex : index,
            width: Number.isFinite(slide.width) ? slide.width : 1920,
            height: Number.isFinite(slide.height) ? slide.height : 1080,
            sourceWidthEmu: Number.isFinite(slide.sourceWidthEmu) ? slide.sourceWidthEmu : null,
            sourceHeightEmu: Number.isFinite(slide.sourceHeightEmu) ? slide.sourceHeightEmu : null,
            image: slide.image,
            paths: (slide.paths || [])
                .map(compactPath)
                .filter(path => path && path.points && path.points.length > 0)
        }))
    };
}

function compactNotebookState(state) {
    const notebook = state?.notebook;
    if (!notebook) return null;

    const active = !!notebook.active;
    const activeNotebookPaths = active ? state.paths : notebook.paths;

    return {
        active,
        pageWidth: Number.isFinite(notebook.pageWidth) ? notebook.pageWidth : 794,
        pageHeight: Number.isFinite(notebook.pageHeight) ? notebook.pageHeight : 1123,
        pageGap: Number.isFinite(notebook.pageGap) ? notebook.pageGap : 96,
        // Blank pages the reader added past the end of the writing. Content
        // alone cannot imply them, so they have to be stored.
        pageCount: Number.isFinite(notebook.pageCount) ? Math.max(0, Math.round(notebook.pageCount)) : 0,
        transform: {
            scale: Number.isFinite((active ? state.transform : notebook.transform)?.scale)
                ? (active ? state.transform : notebook.transform).scale
                : 1,
            offsetX: Number.isFinite((active ? state.transform : notebook.transform)?.offsetX)
                ? (active ? state.transform : notebook.transform).offsetX
                : 0,
            offsetY: Number.isFinite((active ? state.transform : notebook.transform)?.offsetY)
                ? (active ? state.transform : notebook.transform).offsetY
                : 24
        },
        freeformTransform: notebook.freeformTransform || null,
        paths: (activeNotebookPaths || [])
            .map(compactPath)
            .filter(path => path && path.points && path.points.length > 0)
    };
}

function normalizeNotebookState(record) {
    if (!record || typeof record !== 'object') return null;

    const transform = record.transform &&
        Number.isFinite(record.transform.scale) &&
        Number.isFinite(record.transform.offsetX) &&
        Number.isFinite(record.transform.offsetY)
        ? {
            scale: record.transform.scale,
            offsetX: record.transform.offsetX,
            offsetY: record.transform.offsetY
        }
        : null;

    const freeformTransform = record.freeformTransform &&
        Number.isFinite(record.freeformTransform.scale) &&
        Number.isFinite(record.freeformTransform.offsetX) &&
        Number.isFinite(record.freeformTransform.offsetY)
        ? {
            scale: record.freeformTransform.scale,
            offsetX: record.freeformTransform.offsetX,
            offsetY: record.freeformTransform.offsetY
        }
        : null;

    return {
        active: !!record.active,
        pageWidth: Number.isFinite(record.pageWidth) ? record.pageWidth : 794,
        pageHeight: Number.isFinite(record.pageHeight) ? record.pageHeight : 1123,
        pageGap: Number.isFinite(record.pageGap) ? record.pageGap : 96,
        pageCount: Number.isFinite(record.pageCount) ? Math.max(0, Math.round(record.pageCount)) : 0,
        transform,
        freeformTransform,
        paths: Array.isArray(record.paths)
            ? record.paths
                .map(normalizeLoadedPath)
                .filter(path => path && path.points && path.points.length > 0)
            : [],
        freeformPaths: []
    };
}

function applyNotebookState(record, state) {
    const normalized = normalizeNotebookState(record);
    if (!normalized) return false;
    state.notebook = {
        ...(state.notebook || {}),
        ...normalized
    };
    return true;
}

function normalizePptDeck(deck) {
    if (!deck?.active || !Array.isArray(deck.slides) || deck.slides.length === 0) return null;

    const slides = deck.slides
        .filter(slide => slide && slide.image)
        .map((slide, index) => ({
            index,
            pageIndex: Number.isFinite(slide.pageIndex) ? slide.pageIndex : index,
            width: Number.isFinite(slide.width) ? slide.width : 1920,
            height: Number.isFinite(slide.height) ? slide.height : 1080,
            sourceWidthEmu: Number.isFinite(slide.sourceWidthEmu) ? slide.sourceWidthEmu : null,
            sourceHeightEmu: Number.isFinite(slide.sourceHeightEmu) ? slide.sourceHeightEmu : null,
            image: slide.image,
            paths: Array.isArray(slide.paths)
                ? slide.paths
                    .map(normalizeLoadedPath)
                    .filter(path => path && path.points && path.points.length > 0)
                : []
        }));

    if (slides.length === 0) return null;

    return {
        active: true,
        name: deck.name || 'Inkyscib presentation',
        renderMode: deck.renderMode || 'browser',
        docId: typeof deck.docId === 'string' ? deck.docId : null,
        currentSlide: Math.max(0, Math.min(deck.currentSlide || 0, slides.length - 1)),
        slides
    };
}

function applyPptDeck(deck, state) {
    const normalized = normalizePptDeck(deck);
    if (!normalized) {
        state.ppt = { active: false, name: '', renderMode: '', slides: [], currentSlide: 0 };
        return false;
    }

    state.ppt = normalized;
    state.paths = normalized.slides[normalized.currentSlide].paths || [];
    state.undoStack = [];
    state.redoStack = [];
    return true;
}

// The tile variable registry is always re-derivable from the tiles themselves,
// so this record is a convenience: it keeps exact values (and variables whose
// defining tile was deleted) across reloads instead of re-seeding from pixels.
function compactManipulativeVariables(state) {
    const source = state?.manipulativeVariables;
    if (!source || typeof source !== 'object') return {};

    const compact = {};
    Object.keys(source).slice(0, 64).forEach((name) => {
        if (!/^[A-Za-z_][A-Za-z0-9_]{0,15}$/.test(name)) return;
        const value = Number(source[name]);
        if (Number.isFinite(value) && value > 0) compact[name] = roundStoredNumber(value, 4);
    });
    return compact;
}

function applyManipulativeVariables(record, state) {
    if (!state) return false;
    state.manipulativeVariables = compactManipulativeVariables({ manipulativeVariables: record });
    return true;
}

async function persistDrawing(options) {
    const state = window.appState;
    if (!state) return null;

    // While the library switches documents, the active-workspace keys hold a
    // half-written mix of two documents; a timer-driven save landing then
    // would corrupt both. The library passes { force: true } for its own
    // final snapshot.
    if (window.__inkyscibSuspendSaves && !options?.force) return null;

    if (typeof window.bakeInkyscibEraserMasks === 'function') {
        window.bakeInkyscibEraserMasks(state.paths);
        if (state.notebook?.paths) {
            window.bakeInkyscibEraserMasks(state.notebook.paths);
        }
        if (state.notebook?.freeformPaths) {
            window.bakeInkyscibEraserMasks(state.notebook.freeformPaths);
        }
        if (state.ppt?.active && Array.isArray(state.ppt.slides)) {
            state.ppt.slides.forEach((slide) => window.bakeInkyscibEraserMasks(slide.paths || []));
        }
    }

    if (state.notebook?.active && typeof window.syncNotebookCurrentPaths === 'function') {
        window.syncNotebookCurrentPaths();
    }

    if (state.ppt?.active && typeof window.syncPptCurrentSlidePaths === 'function') {
        window.syncPptCurrentSlidePaths();
    }

    const preferencesSaved = writePreferences();

    try {
        const pptDeck = compactPptDeck(state);
        const notebookState = compactNotebookState(state);
        const drawingPaths = state.notebook?.active
            ? (state.notebook.freeformPaths || [])
            : state.paths;
        const validPaths = drawingPaths
            .map(compactPath)
            .filter(p => p && p.points && p.points.length > 0);

        const manipulativeVariables = compactManipulativeVariables(state);

        const localDrawingSaved = safeSetItem('inkyscib_drawing', JSON.stringify(validPaths));
        const localNotebookSaved = safeSetItem('inkyscib_notebook', JSON.stringify(notebookState));
        safeSetItem('inkyscib_manipulatives', JSON.stringify(manipulativeVariables));
        await writeStoredRecord('manipulatives', manipulativeVariables);
        const idbPreferencesSaved = await (window.__inkyscibLastPreferenceSave || Promise.resolve(false));
        const idbDrawingSaved = await writeStoredRecord('drawing', validPaths);
        const idbPptSaved = await writeStoredRecord('ppt', pptDeck);
        const idbNotebookSaved = await writeStoredRecord('notebook', notebookState);

        if ((preferencesSaved || idbPreferencesSaved) &&
            (localDrawingSaved || localNotebookSaved || idbDrawingSaved || idbPptSaved || idbNotebookSaved)) {
            console.log('Drawing saved successfully');
        } else if (preferencesSaved || idbPreferencesSaved) {
            console.warn('Preferences saved, but drawing could not be saved. Browser storage may be blocked or full.');
        }

        return { preferencesSaved, localDrawingSaved, localNotebookSaved, idbPreferencesSaved, idbDrawingSaved, idbPptSaved, idbNotebookSaved };
    } catch (e) {
        console.error('Failed to save drawing:', e);
        return null;
    }
}

function cancelScheduledDrawingSave() {
    if (drawingSaveTimer !== null) {
        clearTimeout(drawingSaveTimer);
        drawingSaveTimer = null;
    }
    if (drawingSaveIdleCallback !== null && typeof window.cancelIdleCallback === 'function') {
        window.cancelIdleCallback(drawingSaveIdleCallback);
    }
    drawingSaveIdleCallback = null;
}

function scheduleDrawingSave() {
    cancelScheduledDrawingSave();
    drawingSaveTimer = window.setTimeout(() => {
        drawingSaveTimer = null;
        const run = () => {
            drawingSaveTimer = null;
            drawingSaveIdleCallback = null;
            flushDrawingSave();
        };

        if (typeof window.requestIdleCallback === 'function') {
            drawingSaveIdleCallback = window.requestIdleCallback(run, { timeout: 1800 });
        } else {
            drawingSaveTimer = window.setTimeout(run, 16);
        }
    }, INKYSCIB_SAVE_DEBOUNCE_MS);
}

async function flushDrawingSave(options = {}) {
    const force = !!options.force;
    cancelScheduledDrawingSave();

    const state = window.appState;
    if (!state) return null;
    if (window.__inkyscibSuspendSaves && !force) {
        drawingSaveRequested = true;
        scheduleDrawingSave();
        return null;
    }
    if ((state.isDrawing || state.isPanning || state.isTouchZooming) && !force) {
        drawingSaveRequested = true;
        scheduleDrawingSave();
        return null;
    }

    if (drawingSaveInFlight) {
        drawingSaveRequested = true;
        const activeSave = drawingSaveInFlight;
        if (force) {
            await activeSave;
            return flushDrawingSave(options);
        }
        return activeSave;
    }

    drawingSaveRequested = false;
    drawingSaveInFlight = persistDrawing(options);
    try {
        const result = await drawingSaveInFlight;
        announceSaveState('inkyscibDocumentSaved');
        return result;
    } finally {
        drawingSaveInFlight = null;
        if (drawingSaveRequested) scheduleDrawingSave();
    }
}

// Fired for anything that shows whether the document is written out yet.
// Cheap on purpose: the listener must not have to read storage to find out.
function announceSaveState(name) {
    try {
        document.dispatchEvent(new CustomEvent(name));
    } catch (error) {
        /* CustomEvent is unavailable in some very old embeds; nothing depends on it */
    }
}

function saveDrawing(options = {}) {
    if (options.force) return flushDrawingSave(options);
    drawingSaveRequested = true;
    announceSaveState('inkyscibDocumentDirty');
    scheduleDrawingSave();
    return drawingSaveInFlight || Promise.resolve(null);
}

function loadLocalDrawing(state) {
    const saved = safeGetItem('inkyscib_drawing');
    if (!saved) return false;

    try {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) {
            state.paths = parsed
                .map(normalizeLoadedPath)
                .filter(p => p && p.points && p.points.length > 0);
            return true;
        }

        state.paths = [];
        return true;
    } catch (e) {
        console.error('Failed to parse saved drawing:', e);
        state.paths = [];
        return false;
    }
}

function readLocalNotebookState() {
    const saved = safeGetItem('inkyscib_notebook');
    if (!saved) return null;

    try {
        return JSON.parse(saved);
    } catch (e) {
        console.error('Failed to parse saved notebook:', e);
        return null;
    }
}

async function loadDrawing() {
    const state = window.appState;
    if (!state) return;

    state.storageReady = false;

    try {
        const storedPpt = await readStoredRecord('ppt');
        const loadedPpt = storedPpt.found && storedPpt.value
            ? applyPptDeck(storedPpt.value, state)
            : false;

        const storedNotebook = await readStoredRecord('notebook');
        const notebookRecord = storedNotebook.found && storedNotebook.value
            ? storedNotebook.value
            : readLocalNotebookState();
        const loadedNotebook = notebookRecord ? applyNotebookState(notebookRecord, state) : false;

        let freeformPaths = [];
        const storedDrawing = await readStoredRecord('drawing');
        if (storedDrawing.found && Array.isArray(storedDrawing.value)) {
            freeformPaths = storedDrawing.value
                .map(normalizeLoadedPath)
                .filter(p => p && p.points && p.points.length > 0);
        } else {
            const previousPaths = state.paths;
            if (loadLocalDrawing(state)) {
                freeformPaths = state.paths;
            }
            state.paths = previousPaths;
        }

        if (loadedPpt) {
            if (state.notebook) {
                state.notebook.active = false;
                state.notebook.freeformPaths = freeformPaths;
            }
        } else {
            if (loadedNotebook && state.notebook?.active) {
                state.notebook.freeformPaths = freeformPaths;
                state.paths = state.notebook.paths || [];
                if (state.notebook.transform) {
                    state.transform = state.notebook.transform;
                }
            } else {
                if (state.notebook) state.notebook.freeformPaths = freeformPaths;
                state.paths = freeformPaths;
            }
        }

        const localPreferences = readLocalPreferences();
        const storedPreferences = await readStoredRecord('preferences');
        const preferenceRecords = [];

        if (localPreferences) preferenceRecords.push(localPreferences);
        if (storedPreferences.found) preferenceRecords.push(storedPreferences);

        preferenceRecords
            .sort((a, b) => a.savedAt - b.savedAt)
            .forEach((record) => applyPreferences(record.value, state));

        if (!loadedPpt && state.notebook?.active) {
            if (state.notebook.transform) {
                state.transform = state.notebook.transform;
            } else if (typeof window.fitNotebookToViewport === 'function') {
                window.fitNotebookToViewport();
            }
        }

        if (typeof window.bakeInkyscibEraserMasks === 'function') {
            window.bakeInkyscibEraserMasks(state.paths);
            if (state.notebook?.paths) {
                window.bakeInkyscibEraserMasks(state.notebook.paths);
            }
            if (state.notebook?.freeformPaths) {
                window.bakeInkyscibEraserMasks(state.notebook.freeformPaths);
            }
            if (state.ppt?.active && Array.isArray(state.ppt.slides)) {
                state.ppt.slides.forEach((slide) => window.bakeInkyscibEraserMasks(slide.paths || []));
            }
        }

        const storedVariables = await readStoredRecord('manipulatives');
        const localVariables = safeGetItem('inkyscib_manipulatives');
        let variableRecord = storedVariables.found ? storedVariables.value : null;
        if (!variableRecord && localVariables) {
            try {
                variableRecord = JSON.parse(localVariables);
            } catch (e) {
                console.warn('Failed to parse saved tile variables:', e);
            }
        }
        applyManipulativeVariables(variableRecord || {}, state);
        // Older saves predate the registry entirely; rebuilding from the tiles
        // seeds every variable from the lengths already on the page.
        if (window.Inkyscib?.Manipulatives?.rebuildRegistryFromPaths) {
            window.Inkyscib.Manipulatives.rebuildRegistryFromPaths();
        }

        // The notebook chrome (status text, pager) syncs on DOMContentLoaded,
        // which fires before this restore finishes. Without a second sync the
        // pager stays hidden and the counter reads 1 / 1 on every reload.
        if (typeof window.Inkyscib?.Notebook?.updateNotebookUi === 'function') {
            window.Inkyscib.Notebook.updateNotebookUi();
        }
        if (typeof window.Inkyscib?.LineSettingsSync === 'function') {
            window.Inkyscib.LineSettingsSync();
        }
        if (typeof window.Inkyscib?.Compass?.syncSettings === 'function') {
            window.Inkyscib.Compass.syncSettings();
        }
        if (typeof window.Inkyscib?.Eraser?.syncSettings === 'function') {
            window.Inkyscib.Eraser.syncSettings();
        }
        if (typeof window.Inkyscib?.WriteAssist?.sync === 'function') {
            window.Inkyscib.WriteAssist.sync();
        }

        console.log('Drawing loaded successfully. Paths:', state.paths.length);
    } catch (e) {
        console.error('Failed to load drawing:', e);
    } finally {
        state.storageReady = true;
    }
}

// writePreferences() writes eight localStorage keys synchronously and then
// queues an IndexedDB record. Wheel scrolling and panning called it once per
// input event, which put a disk-backed synchronous write in the middle of
// every scroll frame. Nothing needs the value on disk that instant - the
// unload handlers below flush whatever is outstanding - so the hot paths
// coalesce instead.
const PREFERENCES_SAVE_DEBOUNCE_MS = 220;
let preferencesSaveTimer = null;
let preferencesSaveRequested = false;

function flushPreferencesSave() {
    if (preferencesSaveTimer !== null) {
        clearTimeout(preferencesSaveTimer);
        preferencesSaveTimer = null;
    }
    if (!preferencesSaveRequested) return false;
    preferencesSaveRequested = false;
    return writePreferences();
}

function schedulePreferencesSave() {
    preferencesSaveRequested = true;
    if (preferencesSaveTimer !== null) clearTimeout(preferencesSaveTimer);
    preferencesSaveTimer = window.setTimeout(() => {
        preferencesSaveTimer = null;
        preferencesSaveRequested = false;
        writePreferences();
    }, PREFERENCES_SAVE_DEBOUNCE_MS);
}

window.saveDrawing = saveDrawing;
window.flushDrawingSave = flushDrawingSave;
// The UI calls this from tool switches, colour swatches and - once per input
// event - from dragging a size slider. Writing eight localStorage keys
// synchronously on each of those put disk I/O inside the drag. The exported
// name is the coalescing one; the immediate write is still what runs, just
// once the input stops. Nothing reads the return value, and the unload
// handlers below flush anything outstanding.
window.savePreferences = schedulePreferencesSave;
window.schedulePreferencesSave = schedulePreferencesSave;
window.flushPreferencesSave = flushPreferencesSave;
window.savePreferencesNow = writePreferences;
window.loadDrawing = loadDrawing;

window.addEventListener('beforeunload', () => {
    flushPreferencesSave();
    flushDrawingSave({ force: true });
});

window.addEventListener('pagehide', () => {
    flushPreferencesSave();
    flushDrawingSave({ force: true });
});

document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'hidden') return;
    flushPreferencesSave();
    if (drawingSaveRequested) {
        flushDrawingSave({ force: true });
    }
});
