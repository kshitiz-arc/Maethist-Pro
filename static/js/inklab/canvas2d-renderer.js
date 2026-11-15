// InkLab's Canvas2D renderer: the fallback for any browser without a WebGPU
// device, and the backend the headless tests exercise. Same interface as the
// WebGPU renderer (spec section 7).
//
// Each segment is drawn as a round-capped line at the average of its two end
// widths, where the GPU tapers within the segment. The difference is not
// visible at these sizes, and a backend is only ever compared with itself.
(function (root) {
  'use strict';

  function cssColour([r, g, b, a]) {
    if (a <= 0) return 'rgba(0, 0, 0, 0)';
    const channel = (value) => Math.round((value / a) * 255);
    return `rgba(${channel(r)}, ${channel(g)}, ${channel(b)}, ${a})`;
  }

  function create() {
    const { brushWidth } = root.InkLab.StrokeWidth;

    let canvas = null;
    let ctx = null;
    let baked = null;
    let bakedCtx = null;
    let size = null;
    let colour = '';
    let baseSize = 4;

    function allocate() {
      const width = Math.max(1, Math.round(size.width * size.dpr));
      const height = Math.max(1, Math.round(size.height * size.dpr));
      canvas.width = width;
      canvas.height = height;
      baked = new OffscreenCanvas(width, height);
      bakedCtx = baked.getContext('2d');
    }

    // Draws in device pixels. Width at each end comes from the whole array, so
    // taper follows how many samples the stroke has right now.
    function drawStroke(target, points) {
      if (points.length < 2) return;
      const dpr = size.dpr;
      target.strokeStyle = colour;
      target.lineCap = 'round';
      for (let i = 1; i < points.length; i++) {
        const a = points[i - 1];
        const b = points[i];
        const width = (brushWidth(points, i - 1, baseSize) + brushWidth(points, i, baseSize)) / 2;
        target.lineWidth = width * dpr;
        target.beginPath();
        target.moveTo(a.x * dpr, a.y * dpr);
        target.lineTo(b.x * dpr, b.y * dpr);
        target.stroke();
      }
    }

    return {
      name: 'canvas2d',

      async init(target, initialSize, ink, base) {
        canvas = target;
        ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('The canvas would not provide a 2d context');
        size = initialSize;
        baseSize = base;
        colour = cssColour(ink);
        allocate();
      },

      resize(nextSize, finished) {
        size = nextSize;
        allocate();
        for (const stroke of finished) drawStroke(bakedCtx, stroke);
      },

      drawFrame(committed, provisional) {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(baked, 0, 0);
        drawStroke(ctx, provisional.length ? committed.concat(provisional) : committed);
      },

      bake(committed) {
        drawStroke(bakedCtx, committed);
      },

      clear() {
        bakedCtx.clearRect(0, 0, baked.width, baked.height);
      },

      async snapshot() {
        const { width, height } = baked;
        const data = bakedCtx.getImageData(0, 0, width, height).data;
        let inked = 0;
        let left = Infinity;
        let top = Infinity;
        let right = -Infinity;
        let bottom = -Infinity;
        for (let y = 0; y < height; y++) {
          const row = y * width;
          for (let x = 0; x < width; x++) {
            if (data[(row + x) * 4 + 3] < 8) continue;
            inked++;
            if (x < left) left = x;
            if (x > right) right = x;
            if (y < top) top = y;
            if (y > bottom) bottom = y;
          }
        }
        return { inked, bbox: inked ? { left, top, right, bottom } : null };
      },
    };
  }

  root.InkLab = root.InkLab || {};
  root.InkLab.Canvas2DRenderer = Object.freeze({ create });
})(self);
