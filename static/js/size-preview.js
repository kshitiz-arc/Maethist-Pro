class SizePreview {
    constructor() {
        this.preview = document.getElementById('sizePreview');
        this.canvas = document.getElementById('drawingCanvas');
        this.state = window.appState;
        this.isVisible = false;
        this.currentTool = null;
        
        this.init();
    }
    
    init() {
        this.setupEventListeners();
        this.setupSizeInputListeners();
        this.hide();
    }
    
    setupEventListeners() {
        this.canvas.addEventListener('mouseenter', (e) => {
            if (this.shouldShowPreview()) {
                this.showAtPosition(e.clientX, e.clientY);
            }
        });
        
        this.canvas.addEventListener('mousemove', (e) => {
            if (this.isVisible && !this.state.isDrawing && !this.state.isPanning) {
                this.updatePosition(e.clientX, e.clientY);
            }
        });
        
        this.canvas.addEventListener('mouseleave', () => {
            this.hide();
        });
        
        this.canvas.addEventListener('mousedown', () => {
            this.hide();
        });
        
        this.canvas.addEventListener('mouseup', (e) => {
            if (this.shouldShowPreview()) {
                setTimeout(() => this.showAtPosition(e.clientX, e.clientY), 100);
            }
        });
        
        this.canvas.addEventListener('touchstart', () => {
            this.hide();
        });
        
        this.canvas.addEventListener('touchend', (e) => {
            if (this.shouldShowPreview() && e.changedTouches[0]) {
                const touch = e.changedTouches[0];
                setTimeout(() => this.showAtPosition(touch.clientX, touch.clientY), 100);
            }
        });
        
        document.addEventListener('toolChanged', (e) => {
            this.currentTool = e.detail.tool;
            this.updateSize();
        });
        
        document.addEventListener('panModeChanged', (e) => {
            if (e.detail.enabled) {
                this.hide();
            } else if (this.shouldShowPreview()) {
                setTimeout(() => this.show(), 100);
            }
        });
    }
    
    setupSizeInputListeners() {
        const tools = ['pen', 'eraser', 'highlight', 'line'];
        
        tools.forEach(tool => {
            const slider = document.getElementById(`${tool}Size`);
            const input = document.getElementById(`${tool}SizeInput`);
            
            if (slider) {
                slider.addEventListener('input', () => {
                    if (this.state.currentTool === tool) {
                        this.updateSize();
                    }
                });
            }
            
            if (input) {
                input.addEventListener('input', () => {
                    if (this.state.currentTool === tool) {
                        setTimeout(() => this.updateSize(), 50);
                    }
                });
            }
        });
    }
    
    shouldShowPreview() {
        if (this.state.panMode) return false;
        
        const drawingTools = ['pen', 'eraser', 'highlight', 'line'];
        return drawingTools.includes(this.state.currentTool);
    }
    
    showAtPosition(x, y) {
        if (!this.shouldShowPreview()) return;
        
        this.updateSize();
        this.updatePosition(x, y);
        this.show();
    }
    
    updatePosition(x, y) {
        // The preview is position:fixed and centred on its own origin, so it
        // belongs at the pointer's client coordinates exactly. It used to route
        // through the canvas backing store and back again, which cancelled out
        // only while the backing store matched the CSS size -- on a high-DPI
        // screen that round trip pushed the ring away from the pointer.
        this.preview.style.left = `${x}px`;
        this.preview.style.top = `${y}px`;
    }
    
    updateSize() {
        const tool = this.state.currentTool;
        if (!tool || !this.state.toolSettings[tool]) return;
        
        const size = this.state.toolSettings[tool].size;
        const scale = this.state.transform.scale;
        
        const displaySize = size * scale;
        
        this.preview.style.width = `${displaySize}px`;
        this.preview.style.height = `${displaySize}px`;
        
        this.preview.className = 'size-preview';
        this.preview.classList.add(tool);
        
        this.updateSizeLabel(size);
    }
    
    updateSizeLabel(size) {
        const existingLabel = this.preview.querySelector('.size-label');
        if (existingLabel) {
            existingLabel.remove();
        }
        
        if (size > 30) {
            const label = document.createElement('div');
            label.className = 'size-label';
            label.textContent = size;
            label.style.cssText = `
                position: absolute;
                top: 50%;
                left: 50%;
                transform: translate(-50%, -50%);
                font-size: 12px;
                font-weight: bold;
                color: white;
                text-shadow: 1px 1px 2px black;
                pointer-events: none;
            `;
            
            this.preview.appendChild(label);
        }
    }
    
    show() {
        if (!this.shouldShowPreview()) return;
        
        this.isVisible = true;
        this.preview.style.display = 'block';
        
        this.preview.style.opacity = '0';
        setTimeout(() => {
            this.preview.style.transition = 'opacity 0.2s ease';
            this.preview.style.opacity = '1';
        }, 10);
    }
    
    hide() {
        this.isVisible = false;
        
        this.preview.style.transition = 'opacity 0.15s ease';
        this.preview.style.opacity = '0';
        
        setTimeout(() => {
            this.preview.style.display = 'none';
            this.preview.style.transition = '';
        }, 150);
    }
    
    refresh() {
        if (this.isVisible) {
            this.updateSize();
        }
    }
    
    onToolChange(tool) {
        this.currentTool = tool;
        if (this.isVisible) {
            this.updateSize();
            this.preview.className = 'size-preview';
            this.preview.classList.add(tool);
        }
    }
}

let sizePreviewInstance = null;

document.addEventListener('DOMContentLoaded', () => {
    sizePreviewInstance = new SizePreview();
    
    window.sizePreview = sizePreviewInstance;
});
