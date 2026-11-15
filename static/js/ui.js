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

    // Clear canvas has two entry points -- the top bar button beside history
    // and the File ribbon -- so the behaviour stays on a global and both call
    // the same thing rather than growing two implementations that drift.
    window.clearCanvasAction = () => {
        if (typeof window.clearCanvas === 'function') {
            window.clearCanvas();
        } else {
            // Fallback only: the real clearCanvas() confirms first and pushes
            // an undo snapshot. Keep the stacks intact here too so the two
            // paths cannot disagree about whether a clear is recoverable.
            if (typeof window.commitHistory === 'function') window.commitHistory();
            window.appState.paths = [];
            if (typeof window.render === 'function') window.render();
        }
    };

    // Guarded, unlike the binding this replaces. The old one was an unguarded
    // getElementById(...).onclick, which is one absent button away from
    // throwing and taking the rest of initUIControls() down with it -- see the
    // 2026-09-04 entry in DESIGN.md's decision log.
    const clearBtn = document.getElementById('clearBtn');
    if (clearBtn) {
        clearBtn.addEventListener('click', () => window.clearCanvasAction());
    }

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
        // Same bounds the wheel, the buttons and pinch all clamp to, so a typed
        // value cannot reach a zoom the rest of the app refuses to produce.
        const MIN_ZOOM = 15;
        const MAX_ZOOM = 600;

        let shown = null;
        const currentPercent = () => {
            const scale = window.appState && window.appState.transform
                ? window.appState.transform.scale : null;
            return typeof scale === 'number' ? Math.round(scale * 100) : null;
        };

        const syncZoom = () => {
            // Never overwrite what someone is in the middle of typing; the poll
            // runs four times a second and would eat the keystrokes.
            if (document.activeElement === zoomLevel) return;
            const pct = currentPercent();
            if (pct === null || pct === shown) return;
            shown = pct;
            zoomLevel.value = pct + '%';
        };

        const applyTypedZoom = () => {
            // Take the first number in the field, so "150", "150%" and a stray
            // space all work, and a minus sign is simply not part of the match.
            const match = String(zoomLevel.value).match(/\d+(?:\.\d+)?/);
            const target = match ? Number(match[0]) : NaN;
            const scale = window.appState?.transform?.scale;

            if (!Number.isFinite(target) || target <= 0 || typeof scale !== 'number') {
                shown = null;
                syncZoom();
                return;
            }

            const clamped = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, target));
            // Go through zoom() rather than writing the transform, so the view
            // stays anchored on the canvas centre exactly as the buttons do.
            if (typeof window.zoom === 'function') window.zoom((clamped / 100) / scale);
            shown = null;
            syncZoom();
        };

        zoomLevel.addEventListener('focus', () => zoomLevel.select());
        zoomLevel.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') {
                event.preventDefault();
                applyTypedZoom();
                zoomLevel.blur();
            } else if (event.key === 'Escape') {
                event.preventDefault();
                shown = null;
                syncZoom();
                zoomLevel.blur();
            }
        });
        zoomLevel.addEventListener('blur', applyTypedZoom);

        syncZoom();
        window.setInterval(syncZoom, 250);
    }
    
    // #themeToggle opens the Canvas popover now (static/js/canvas-theme.js).
    // Flipping data-theme here as well would pull the chrome away from the
    // preset it pairs with.

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
