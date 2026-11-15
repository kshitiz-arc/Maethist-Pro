function initHighlightTool() {
    const highlightTool = document.getElementById('highlightTool');
    const highlightSize = document.getElementById('highlightSize');
    const highlightSizeInput = document.getElementById('highlightSizeInput');
    const highlightCustomColor = document.getElementById('highlightCustomColor');
    
    
    if (!window.appState.toolSettings.highlight.color) {
        window.appState.toolSettings.highlight.color = 'rgba(255,255,0,0.3)';
    }
    
    highlightTool.onclick = () => {
        // Opening and closing this tool's panel is tool-dock.js's job at every
        // width: it sees the tap in the capture phase and toggles on a second
        // tap. This handler only selects the tool. A second owner here -- a
        // double-tap timer below 1180px, writing style.display directly -- is
        // what left the panels out of step with the dock and, for Algebra
        // tiles, hid the panel the moment the tool was picked.
        closeAllToolboxes();
        setTool('highlight');
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
