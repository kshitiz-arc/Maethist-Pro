// Note: syncUIWithSettings lives in core.js (the null-safe version). Keep it
// out of this file so the global isn't silently overridden.

function initUIControls() {
    initToolbarLocationControls();

    document.getElementById('undoBtn').onclick = () => {
        if (typeof window.undo === 'function') window.undo();
    };

    document.getElementById('redoBtn').onclick = () => {
        if (typeof window.redo === 'function') window.redo();
    };

    // Clear canvas no longer has a button in the top bar. It sat one control
    // away from Undo -- the least safe and the safest thing side by side --
    // and it now lives in the File ribbon. The behaviour moves to a global so
    // the ribbon and any future entry point share one implementation.
    window.clearCanvasAction = () => {
        if (typeof window.clearCanvas === 'function') {
            window.clearCanvas();
        } else {
            window.appState.paths = [];
            window.appState.undoStack = [];
            window.appState.redoStack = [];
            if (typeof window.render === 'function') window.render();
        }
    };

    // resetView() was already the only thing bound to the `0` key. It is the
    // same operation as fit-to-page, so the button reuses it rather than
    // growing a second implementation that can drift.
    const fitViewBtn = document.getElementById('fitView');
    if (fitViewBtn) {
        fitViewBtn.onclick = () => {
            if (typeof window.resetView === 'function') window.resetView();
        };
    }

    // The zoom buttons gave no feedback at all, so there was no way to know
    // what zoom you were at or get back to 100%. Poll the live scale rather
    // than counting clicks: wheel and pinch zoom write the transform directly
    // and never go through window.zoom, so a click counter would drift.
    // Four reads of one number per second, only when the value changed.
    const zoomLevel = document.getElementById('zoomLevel');
    if (zoomLevel) {
        let shown = null;
        const syncZoom = () => {
            const scale = window.appState && window.appState.transform
                ? window.appState.transform.scale : null;
            if (typeof scale !== 'number') return;
            const pct = Math.round(scale * 100);
            if (pct === shown) return;
            shown = pct;
            zoomLevel.textContent = pct + '%';
        };
        syncZoom();
        window.setInterval(syncZoom, 250);
    }
    
    document.getElementById('themeToggle').onclick = () => {
        const html = document.documentElement;
        html.dataset.theme = html.dataset.theme === 'dark' ? 'light' : 'dark';
        if (typeof window.render === 'function') window.render();
        if (typeof window.savePreferences === 'function') window.savePreferences();
    };
    
    document.getElementById('zoomIn').onclick = () => {
        if (typeof window.zoom === 'function') {
            window.zoom(1.1);
        } else {
            window.appState.transform.scale *= 1.1;
            if (typeof window.render === 'function') window.render();
        }
    };
    
    document.getElementById('zoomOut').onclick = () => {
        if (typeof window.zoom === 'function') {
            window.zoom(0.9);
        } else {
            window.appState.transform.scale *= 0.9;
            if (typeof window.render === 'function') window.render();
        }
    };
    
    document.getElementById('panMode').onclick = () => {
        const state = window.appState;
        const enabled = !state.panMode;

        // setPanMode also resets the in-progress stroke, sets the canvas cursor
        // and dispatches panModeChanged, which the tool dock, size preview and
        // events module all listen for. Toggling the flag by hand skipped all
        // of that and left those listeners stale.
        if (typeof window.setPanMode === 'function') {
            window.setPanMode(enabled);
        } else {
            state.panMode = enabled;
            document.querySelectorAll('.tool').forEach(b => b.classList.remove('active'));
            document.getElementById('panMode').classList.add('active');
        }

        if (!enabled && typeof window.setTool === 'function') {
            window.setTool(state.currentTool);
        }
    };
}

function initToolbarLocationControls() {
    const buttons = document.querySelectorAll('[data-toolbar-location]');
    if (!buttons.length) return;

    buttons.forEach((button) => {
        button.addEventListener('click', () => {
            const location = button.dataset.toolbarLocation;
            if (typeof window.applyToolbarLocation === 'function') {
                window.applyToolbarLocation(location, { animate: true, persist: true });
            }
        });
    });

    if (typeof window.applyToolbarLocation === 'function') {
        window.applyToolbarLocation(window.appState?.toolbarLocation || 'up', { animate: false, persist: false });
    }
}

document.addEventListener('DOMContentLoaded', initUIControls);
