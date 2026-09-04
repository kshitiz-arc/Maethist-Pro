function initPenTool() {
    const penStyles = ['default', 'fountain', 'brush', 'gel', 'calligraphy'];
    const penTool = document.getElementById('penTool');
    const penOptions = document.getElementById('penOptions');
    const penSize = document.getElementById('penSize');
    const penSizeInput = document.getElementById('penSizeInput');
    const penCustomColor = document.getElementById('penCustomColor');
    
    let penClickTimer = null;
    
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
            if (window.Inkyscib?.ToolDock?.isDockMode?.()) {
                closeAllToolboxes();
                if (typeof window.setTool === 'function') {
                    window.setTool('pen');
                }
                return;
            }
            const state = window.appState;
            
            if (state.currentTool === 'pen' && !state.panMode) {
                if (penClickTimer) {
                    clearTimeout(penClickTimer);
                    penClickTimer = null;
                    if (penOptions) {
                        penOptions.style.display = penOptions.style.display === 'flex' ? 'none' : 'flex';
                    }
                } else {
                    penClickTimer = setTimeout(() => {
                        penClickTimer = null;
                    }, 300);
                }
            } else {
                closeAllToolboxes();
                if (typeof window.setTool === 'function') {
                    window.setTool('pen');
                } else {
                    window.appState.currentTool = 'pen';
                    window.appState.panMode = false;
                    
                    document.querySelectorAll('.tool').forEach(b => b.classList.remove('active'));
                    penTool.classList.add('active');
                    document.getElementById('panMode')?.classList.remove('active');
                }
            }
        });
        
        penTool.addEventListener('touchstart', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (window.Inkyscib?.ToolDock?.isDockMode?.()) {
                closeAllToolboxes();
                if (typeof window.setTool === 'function') {
                    window.setTool('pen');
                }
                return;
            }
            
            const state = window.appState;
            
            if (state.currentTool === 'pen' && !state.panMode) {
                if (penClickTimer) {
                    clearTimeout(penClickTimer);
                    penClickTimer = null;
                    if (penOptions) {
                        penOptions.style.display = penOptions.style.display === 'flex' ? 'none' : 'flex';
                    }
                } else {
                    penClickTimer = setTimeout(() => {
                        penClickTimer = null;
                    }, 300);
                }
            } else {
                closeAllToolboxes();
                if (typeof window.setTool === 'function') {
                    window.setTool('pen');
                } else {
                    window.appState.currentTool = 'pen';
                    window.appState.panMode = false;
                    
                    document.querySelectorAll('.tool').forEach(b => b.classList.remove('active'));
                    penTool.classList.add('active');
                    document.getElementById('panMode')?.classList.remove('active');
                }
            }
        }, { passive: false });
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

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initPenTool);
} else {
    initPenTool();
}

window.updatePenStyleSelection = updatePenStyleSelection;
