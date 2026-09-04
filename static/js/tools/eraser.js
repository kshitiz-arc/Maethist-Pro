function initEraserTool() {
    const eraserTool = document.getElementById('eraserTool');
    const eraserSize = document.getElementById('eraserSize');
    const eraserSizeInput = document.getElementById('eraserSizeInput');
    
    let eraserClickTimer = null;
    
    eraserTool.onclick = () => {
        if (window.Inkyscib?.ToolDock?.isDockMode?.()) {
            closeAllToolboxes();
            setTool('eraser');
            return;
        }
        const state = window.appState;
        
        if (state.currentTool === 'eraser' && !state.panMode) {
            if (eraserClickTimer) {
                clearTimeout(eraserClickTimer);
                eraserClickTimer = null;
                toggleToolbox('eraserOptions');
            } else {
                eraserClickTimer = setTimeout(() => {
                    eraserClickTimer = null;
                }, 300);
            }
        } else {
            closeAllToolboxes();
            setTool('eraser');
        }
    };
    
    eraserSize.oninput = () => {
        window.appState.toolSettings.eraser.size = +eraserSize.value;
        eraserSizeInput.value = eraserSize.value;
        if (typeof window.savePreferences === 'function') {
            window.savePreferences();
        }
    };
    
    eraserSizeInput.oninput = () => {
        let v = Math.min(200, Math.max(1, +eraserSizeInput.value));
        eraserSizeInput.value = v;
        eraserSize.value = v;
        window.appState.toolSettings.eraser.size = v;
        if (typeof window.savePreferences === 'function') {
            window.savePreferences();
        }
    };
}

document.addEventListener('DOMContentLoaded', initEraserTool);
