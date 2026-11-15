// Write assist. The filtering itself lives in events.js appendInkPoint and
// ink-smooth.js smoothStroke; this owns the setting and the slider that sets
// it. The setting is a level, 0-100. It used to be "off" / "natural" /
// "strong" and old saves still say so; ink-smooth.js maps those onto 0 / 40 /
// 70, and this rewrites the stored value as a number the first time it runs.
const WRITE_ASSIST_STOPS = [
    { level: 0, name: 'Off' },
    { level: 40, name: 'Natural' },
    { level: 70, name: 'Strong' },
    { level: 100, name: 'Max' }
];
// Within this many steps of a stop, the slider settles on it. The stops are
// where the smoothing was calibrated, so they are worth landing on exactly.
const WRITE_ASSIST_SNAP = 3;

function writeAssistName(level) {
    if (level === 0) return 'Off';
    if (level < 30) return 'Light';
    if (level < 55) return 'Natural';
    if (level < 85) return 'Strong';
    return 'Max';
}

// A few words of deliberately unsteady handwriting for the preview: a looping
// cursive line with tremor, a hook where the pen touched down, and a hook
// where it lifted, so every part of the range has something to change.
function writeAssistSample() {
    let seed = 20260919;
    const rand = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
    const points = [];
    // Touch-down hook.
    points.push({ x: 8.6, y: 25.5 }, { x: 8.2, y: 24.2 }, { x: 8.1, y: 23.2 });
    const count = 150;
    for (let i = 0; i <= count; i++) {
        const t = i / count;
        const x = 8 + t * 204;
        const y = 20 + 9 * Math.sin(t * Math.PI * 2 * 4.2) + 3 * Math.sin(t * Math.PI * 2 * 11);
        points.push({
            x: x + (rand() - 0.5) * 2.2,
            y: y + (rand() - 0.5) * 2.2 + 0.8 * Math.sin(i * 0.9),
        });
    }
    // Lift-off hook.
    const last = points[points.length - 1];
    points.push({ x: last.x - 0.6, y: last.y + 1.4 }, { x: last.x - 1.2, y: last.y + 2.6 });
    // Pressure swings the way a stylus's does -- heavy on the downstrokes,
    // light on the joins -- so the preview has real thick-and-thin to show
    // being evened out at the top of the range.
    return points.map((p, i) => ({ ...p, pressure: 0.15 + 0.7 * Math.abs(Math.sin(i / 6)), time: i * 4 }));
}

function writeAssistPathData(points) {
    if (!points.length) return '';
    let d = `M${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`;
    for (let i = 1; i < points.length; i++) d += `L${points[i].x.toFixed(2)} ${points[i].y.toFixed(2)}`;
    return d;
}

// The stroke as a filled outline whose width follows each point's pressure,
// the way the pressure-sensitive nibs draw it. A plain SVG line has one width,
// so it could never show the top of the range evening the weight out.
function writeAssistOutlineData(points) {
    if (points.length < 2) return '';
    const left = [];
    const right = [];
    for (let i = 0; i < points.length; i++) {
        const a = points[Math.max(0, i - 1)];
        const b = points[Math.min(points.length - 1, i + 1)];
        let nx = -(b.y - a.y);
        let ny = b.x - a.x;
        const length = Math.hypot(nx, ny) || 1;
        nx /= length;
        ny /= length;
        const pressure = typeof points[i].pressure === 'number' ? points[i].pressure : 0.5;
        const half = 0.3 + pressure * 2.2;
        left.push(`${(points[i].x + nx * half).toFixed(2)} ${(points[i].y + ny * half).toFixed(2)}`);
        right.push(`${(points[i].x - nx * half).toFixed(2)} ${(points[i].y - ny * half).toFixed(2)}`);
    }
    return `M${left.join('L')}L${right.reverse().join('L')}Z`;
}

function initInkSmoothing() {
    const slider = document.getElementById('writeAssistLevel');
    if (!slider) return;
    const nameOut = document.getElementById('writeAssistName');
    const numberOut = document.getElementById('writeAssistNumber');
    const preview = document.getElementById('writeAssistPreview');
    const ghost = document.getElementById('writeAssistGhost');
    const sample = writeAssistSample();
    const stops = Array.from(document.querySelectorAll('#writeAssistSpectrum [data-stop]'));
    if (ghost) ghost.setAttribute('d', writeAssistPathData(sample));

    const levelOf = (value) => {
        const level = window.Inkyscib?.InkSmooth?.assistLevel;
        return typeof level === 'function' ? level(value) : 40;
    };

    function current() {
        return levelOf(window.appState?.toolSettings?.pen?.smoothing);
    }

    function show(level) {
        const name = writeAssistName(level);
        slider.value = String(level);
        slider.style.setProperty('--assist-fill', `${level}%`);
        slider.setAttribute('aria-valuetext', `${name}, ${level} of 100`);
        if (nameOut) nameOut.textContent = name;
        if (numberOut) numberOut.textContent = String(level);
        const smooth = window.Inkyscib?.InkSmooth?.smoothStroke;
        if (preview && typeof smooth === 'function') {
            preview.setAttribute('d', writeAssistOutlineData(level ? smooth(sample, level, 1, 'pen') : sample));
        }
        stops.forEach((stop) => stop.classList.toggle('is-here', Number(stop.dataset.stop) === level));
    }

    function commit(level) {
        const pen = window.appState?.toolSettings?.pen;
        if (!pen) return;
        pen.smoothing = level;
        show(level);
        if (typeof window.savePreferences === 'function') window.savePreferences();
    }

    function snapped(raw) {
        const value = Math.round(Number(raw) || 0);
        for (const stop of WRITE_ASSIST_STOPS) {
            if (Math.abs(value - stop.level) <= WRITE_ASSIST_SNAP) return stop.level;
        }
        return value;
    }

    // While dragging, only the preview and readout follow -- the setting is
    // written once, on release, so a drag does not schedule a save per pixel.
    slider.addEventListener('input', () => show(snapped(slider.value)));
    slider.addEventListener('change', () => commit(snapped(slider.value)));

    // Rewrite an old saved name ("strong") as its number, so what is stored
    // matches what the slider shows. Run on init AND on every resync: the
    // preferences load asynchronously, after this, and restoring them writes
    // the old name straight back over a migration done here at start-up.
    function migrate() {
        const pen = window.appState?.toolSettings?.pen;
        if (pen && typeof pen.smoothing !== 'number') pen.smoothing = current();
    }

    migrate();
    show(current());

    window.Inkyscib = window.Inkyscib || {};
    window.Inkyscib.WriteAssist = {
        sync: () => { migrate(); show(current()); },
        set: commit,
        levelName: writeAssistName
    };
}

function initPenTool() {
    const penStyles = ['default', 'fountain', 'brush', 'gel', 'calligraphy'];
    const penTool = document.getElementById('penTool');
    const penOptions = document.getElementById('penOptions');
    const penSize = document.getElementById('penSize');
    const penSizeInput = document.getElementById('penSizeInput');
    const penCustomColor = document.getElementById('penCustomColor');
    
    if (document.documentElement.dataset.theme === 'dark' && 
        (!window.appState.toolSettings.pen.color || 
         window.appState.toolSettings.pen.color === 'black' || 
         window.appState.toolSettings.pen.color === '#000000')) {
        window.appState.toolSettings.pen.color = '#ffffff';
    }

    if (window.appState.toolSettings.pen.style === 'marker') {
        window.appState.toolSettings.pen.style = 'calligraphy';
    }

    if (!penStyles.includes(window.appState.toolSettings.pen.style)) {
        window.appState.toolSettings.pen.style = 'default';
    }
    
    if (penTool) {
        penTool.addEventListener('click', (e) => {
            e.stopPropagation();
            // Opening and closing this tool's panel is tool-dock.js's job at
            // every width: it sees the tap in the capture phase and toggles on
            // a second tap. This handler only selects the tool. A second owner
            // here -- a double-tap timer below 1180px, writing style.display
            // directly -- is what left the panels out of step with the dock
            // and, for Algebra tiles, hid the panel the moment the tool was
            // picked.
            closeAllToolboxes();
            if (typeof window.setTool === 'function') {
                window.setTool('pen');
            }
        });
    }
    
    if (penSize) {
        penSize.addEventListener('input', () => {
            if (window.appState.toolSettings.pen) {
                window.appState.toolSettings.pen.size = +penSize.value;
                if (penSizeInput) penSizeInput.value = penSize.value;
                
                if (window.appState.currentTool === 'pen' && window.sizePreview) {
                    window.sizePreview.updateSize();
                }
                if (typeof window.savePreferences === 'function') {
                    window.savePreferences();
                }
            }
        });
    }
    
    if (penSizeInput) {
        penSizeInput.addEventListener('input', () => {
            let v = Math.min(200, Math.max(1, +penSizeInput.value || 1));
            penSizeInput.value = v;
            if (penSize) penSize.value = v;
            if (window.appState.toolSettings.pen) {
                window.appState.toolSettings.pen.size = v;
                
                if (window.appState.currentTool === 'pen' && window.sizePreview) {
                    window.sizePreview.updateSize();
                }
                if (typeof window.savePreferences === 'function') {
                    window.savePreferences();
                }
            }
        });
    }
    
    document.querySelectorAll('#penOptions .color-swatch').forEach(s => {
        s.addEventListener('click', () => {
            const color = s.dataset.color;
            if (window.appState.toolSettings.pen) {
                window.appState.toolSettings.pen.color = color;
                updateColorSwatchSelection('penOptions', color);
                if (typeof window.saveDrawing === 'function') {
                    window.saveDrawing();
                }
            }
        });
    });
    
    if (penCustomColor) {
        penCustomColor.addEventListener('input', (e) => {
            if (window.appState.toolSettings.pen) {
                window.appState.toolSettings.pen.color = e.target.value;
                if (typeof window.saveDrawing === 'function') {
                    window.saveDrawing();
                }
            }
        });
    }

    document.querySelectorAll('#penOptions .pen-style-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const style = penStyles.includes(btn.dataset.penStyle) ? btn.dataset.penStyle : 'default';
            if (window.appState.toolSettings.pen) {
                window.appState.toolSettings.pen.style = style;
                updatePenStyleSelection(style);
                if (typeof window.saveDrawing === 'function') {
                    window.saveDrawing();
                }
            }
        });
    });
    
    if (window.appState.toolSettings.pen) {
        if (penSize) penSize.value = window.appState.toolSettings.pen.size;
        if (penSizeInput) penSizeInput.value = window.appState.toolSettings.pen.size;
        updateColorSwatchSelection('penOptions', window.appState.toolSettings.pen.color);
        updatePenStyleSelection(window.appState.toolSettings.pen.style || 'default');
    }
    
    console.log('Pen tool initialized');
}

function updatePenStyleSelection(style) {
    const current = style || 'default';
    document.querySelectorAll('#penOptions .pen-style-btn').forEach(btn => {
        btn.classList.toggle('active', (btn.dataset.penStyle || 'default') === current);
    });
}

function updateColorSwatchSelection(containerId, color) {
    document.querySelectorAll(`#${containerId} .color-swatch`).forEach(s => {
        if (s.dataset.color === color) {
            s.classList.add('active');
            s.style.border = '2px solid #5a5aff';
        } else {
            s.classList.remove('active');
            s.style.border = '2px solid transparent';
        }
    });
}

function toggleToolbox(id) {
    const el = document.getElementById(id);
    if (el) {
        el.style.display = (el.style.display === 'flex') ? 'none' : 'flex';
    }
}

function initPen() {
    initPenTool();
    initInkSmoothing();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initPen);
} else {
    initPen();
}

window.updatePenStyleSelection = updatePenStyleSelection;
