function initHighlightTool() {
    const highlightTool = document.getElementById('highlightTool');
    const highlightSize = document.getElementById('highlightSize');
    const highlightSizeInput = document.getElementById('highlightSizeInput');
    const highlightCustomColor = document.getElementById('highlightCustomColor');
    
    let highlightClickTimer = null;
    
    if (!window.appState.toolSettings.highlight.color) {
        window.appState.toolSettings.highlight.color = 'rgba(255,255,0,0.3)';
    }
    
    highlightTool.onclick = () => {
        if (window.Inkyscib?.ToolDock?.isDockMode?.()) {
            closeAllToolboxes();
            setTool('highlight');
            return;
        }
        const state = window.appState;
        
        if (state.currentTool === 'highlight' && !state.panMode) {
            if (highlightClickTimer) {
                clearTimeout(highlightClickTimer);
                highlightClickTimer = null;
                toggleToolbox('highlightOptions');
            } else {
                highlightClickTimer = setTimeout(() => {
                    highlightClickTimer = null;
                }, 300);
            }
        } else {
            closeAllToolboxes();
            setTool('highlight');
        }
    };
    
    highlightSize.oninput = () => {
        window.appState.toolSettings.highlight.size = +highlightSize.value;
        highlightSizeInput.value = highlightSize.value;
        if (typeof window.savePreferences === 'function') {
            window.savePreferences();
        }
    };
    
    highlightSizeInput.oninput = () => {
        let v = Math.min(200, Math.max(1, +highlightSizeInput.value));
        highlightSizeInput.value = v;
        highlightSize.value = v;
        window.appState.toolSettings.highlight.size = v;
        if (typeof window.savePreferences === 'function') {
            window.savePreferences();
        }
    };
    
    document.querySelectorAll('#highlightOptions .color-swatch').forEach(s => {
        s.onclick = () => {
            window.appState.toolSettings.highlight.color = s.dataset.color;
            updateColorSwatchSelection('highlightOptions', s.dataset.color);
            if (typeof window.saveDrawing === 'function') {
                window.saveDrawing();
            }
        };
    });
    
    highlightCustomColor.oninput = e => {
        const r = parseInt(e.target.value.substr(1, 2), 16);
        const g = parseInt(e.target.value.substr(3, 2), 16);
        const b = parseInt(e.target.value.substr(5, 2), 16);
        window.appState.toolSettings.highlight.color = `rgba(${r},${g},${b},0.3)`;
        if (typeof window.saveDrawing === 'function') {
            window.saveDrawing();
        }
    };
}

document.addEventListener('DOMContentLoaded', initHighlightTool);
