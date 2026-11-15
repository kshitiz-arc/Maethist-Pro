(function () {
    "use strict";

    let lassoPoints = [];
    let lassoActive = false;

    function state() {
        return window.appState;
    }

    function requestRedraw() {
        if (typeof window.render === "function") window.render();
    }

    function savePreferences() {
        if (typeof window.savePreferences === "function") window.savePreferences();
    }

    function settings() {
        const s = state();
        if (!s.toolSettings.eraser) {
            s.toolSettings.eraser = { size: 20, mode: "partial", lassoAction: "erase" };
        }
        if (s.toolSettings.eraser.mode !== "object") s.toolSettings.eraser.mode = "partial";
        if (s.toolSettings.eraser.lassoAction !== "select") {
            s.toolSettings.eraser.lassoAction = "erase";
        }
        return s.toolSettings.eraser;
    }

    function syncModeButtons() {
        const mode = settings().mode;
        document.querySelectorAll("[data-eraser-mode]").forEach((button) => {
            const active = button.dataset.eraserMode === mode;
            button.classList.toggle("active", active);
            button.setAttribute("aria-pressed", active ? "true" : "false");
        });
    }

    function syncLassoButtons() {
        const action = settings().lassoAction;
        document.querySelectorAll("[data-eraser-lasso]").forEach((button) => {
            const active = button.dataset.eraserLasso === action;
            button.classList.toggle("active", active);
            button.setAttribute("aria-pressed", active ? "true" : "false");
        });
    }

    function beginLasso(point) {
        lassoPoints = point ? [{ x: point.x, y: point.y }] : [];
        lassoActive = true;
        requestRedraw();
        return true;
    }

    function extendLasso(point) {
        if (!lassoActive || !point) return false;
        const last = lassoPoints[lassoPoints.length - 1];
        const scale = Math.max(0.15, state()?.transform?.scale || 1);
        if (!last || Math.hypot(point.x - last.x, point.y - last.y) >= 2 / scale) {
            lassoPoints.push({ x: point.x, y: point.y });
            requestRedraw();
        }
        return true;
    }

    function cancelLasso() {
        const wasActive = lassoActive;
        lassoActive = false;
        lassoPoints = [];
        if (wasActive) requestRedraw();
    }

    function finishLasso(point) {
        if (!lassoActive) return false;
        if (point) extendLasso(point);

        const polygon = lassoPoints.slice();
        lassoActive = false;
        lassoPoints = [];

        const selection = window.Inkyscib?.Selection;
        const indices = selection?.indicesWithinPolygon?.(polygon) || [];
        if (!indices.length) {
            requestRedraw();
            return true;
        }

        // What the loop does is a setting. This used to be an unconditional
        // delete that never read toolSettings at all, so the panel could say
        // Partial while the hold gesture cleared whole objects regardless.
        if (settings().lassoAction === "select") {
            selection?.selectIndices?.(indices);
            // Without the tool change the handles are unreachable and the next
            // tap erases what was just selected. This switch is safe where
            // SmartGeometry's is not: nothing appeared under the pen, the user
            // asked for a selection and got one.
            if (typeof window.setTool === "function") window.setTool("select");
            requestRedraw();
            return true;
        }

        if (typeof window.commitHistory === "function") window.commitHistory();
        indices.slice().sort((a, b) => b - a).forEach((index) => state().paths.splice(index, 1));
        selection?.clear?.({ render: false });
        // Deliberately no invalidateCanvasDrawingCache(): that nulled the
        // committed layer and forced a full O(N) rebuild, while the dragged
        // object eraser (__eraseObjectsTouched) splices the same way and gets
        // region repair instead. Splicing is what the repair diffs against.
        if (typeof window.saveDrawing === "function") window.saveDrawing();
        requestRedraw();
        return true;
    }

    function drawOverlay(ctx) {
        if (!lassoActive || !lassoPoints.length || !ctx) return;
        const scale = Math.max(0.15, state()?.transform?.scale || 1);
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(lassoPoints[0].x, lassoPoints[0].y);
        lassoPoints.slice(1).forEach((point) => ctx.lineTo(point.x, point.y));
        if (lassoPoints.length > 2) ctx.closePath();
        ctx.setLineDash([7 / scale, 5 / scale]);
        ctx.lineWidth = 1.8 / scale;
        ctx.strokeStyle = "rgba(251, 113, 133, 0.96)";
        ctx.fillStyle = "rgba(251, 113, 133, 0.1)";
        if (lassoPoints.length > 2) ctx.fill();
        ctx.stroke();
        ctx.restore();
    }

    function initEraserTool() {
        const eraserTool = document.getElementById("eraserTool");
        const eraserOptions = document.getElementById("eraserOptions");
        const eraserSize = document.getElementById("eraserSize");
        const eraserSizeInput = document.getElementById("eraserSizeInput");
        if (!eraserTool || !eraserOptions || !eraserSize || !eraserSizeInput) return;

        eraserTool.onclick = (event) => {
            event.stopPropagation();
            // Opening and closing this tool's panel is tool-dock.js's job at
            // every width: it sees the tap in the capture phase and toggles on
            // a second tap. This handler only selects the tool. A second owner
            // here -- a double-tap timer below 1180px, writing style.display
            // directly -- is what left the panels out of step with the dock
            // and, for Algebra tiles, hid the panel the moment the tool was
            // picked.
            closeAllToolboxes();
            setTool("eraser");
        };

        eraserSize.oninput = () => {
            settings().size = +eraserSize.value;
            eraserSizeInput.value = eraserSize.value;
            savePreferences();
        };

        eraserSizeInput.oninput = () => {
            const value = Math.min(200, Math.max(1, +eraserSizeInput.value || 1));
            eraserSizeInput.value = value;
            eraserSize.value = value;
            settings().size = value;
            savePreferences();
        };

        document.querySelectorAll("[data-eraser-mode]").forEach((button) => {
            button.addEventListener("click", () => {
                settings().mode = button.dataset.eraserMode === "object" ? "object" : "partial";
                syncModeButtons();
                savePreferences();
            });
        });

        document.querySelectorAll("[data-eraser-lasso]").forEach((button) => {
            button.addEventListener("click", () => {
                settings().lassoAction = button.dataset.eraserLasso === "select" ? "select" : "erase";
                syncLassoButtons();
                savePreferences();
            });
        });

        eraserSize.value = settings().size || 20;
        eraserSizeInput.value = settings().size || 20;
        syncModeButtons();
        syncLassoButtons();
    }

    // Preferences load asynchronously, often after initEraserTool has already
    // run, so the buttons have to be re-synced once they arrive. storage.js
    // called Compass.syncSettings here and nothing else; this export had no
    // caller anywhere in the repo, so a restored eraser mode never reached the
    // panel.
    function syncSettings() {
        syncModeButtons();
        syncLassoButtons();
        const eraserSize = document.getElementById("eraserSize");
        const eraserSizeInput = document.getElementById("eraserSizeInput");
        const size = settings().size || 20;
        if (eraserSize) eraserSize.value = size;
        if (eraserSizeInput) eraserSizeInput.value = size;
    }

    window.Inkyscib = window.Inkyscib || {};
    window.Inkyscib.Eraser = {
        beginLasso,
        extendLasso,
        finishLasso,
        cancelLasso,
        drawOverlay,
        isLassoActive: () => lassoActive,
        syncSettings
    };

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", initEraserTool, { once: true });
    } else {
        initEraserTool();
    }
})();
