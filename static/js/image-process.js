// Image processing for pictures, video frames and the picture background.
//
// The edits an LLM council chose for students annotating photos of notes,
// worksheets and lecture frames (docs/council/council-image-edits-2026-11-19.md):
//
//   clean       even out the lighting (a phone's shadow across a page)
//   autoLevels  stretch the darkest ink to black and the paper to white
//   sharpen     an unsharp mask, for soft video frames and photos
//   threshold   black and white, for faint pencil
//   clearPaper  make the paper transparent, so the ink sits on the canvas
//   blur        a soft focus, mostly for a picture used as the background
//
// None of these can be a ctx.filter string, so each picture is baked once into
// a canvas and that canvas is drawn from then on: one drawImage a frame, never
// a pixel loop under live ink. Bakes are cached per picture and per size
// bucket (512, 1024, 2048 on the long side), so a thumbnail in the edit sheet
// costs a 512px pass while the slider moves and the page gets its own size.
// The original pixels are never touched: Reset is always lossless.
(function () {
  "use strict";

  const cache = new WeakMap();
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

  function hasPixelOps(edit) {
    return !!edit && !!(edit.clean || edit.autoLevels || num(edit.sharpen) > 0.01 ||
      num(edit.threshold) > 0.01 || num(edit.clearPaper) > 0.01 || num(edit.blur) > 0.05);
  }

  function bucket(n) {
    return n <= 600 ? 512 : n <= 1200 ? 1024 : 2048;
  }

  function cacheKey(edit, side) {
    return [side, edit.clean ? 1 : 0, edit.autoLevels ? 1 : 0, num(edit.sharpen).toFixed(2),
      num(edit.threshold).toFixed(2), num(edit.clearPaper).toFixed(2), num(edit.blur).toFixed(1)].join("|");
  }

  // The picture to draw for this edit: the source itself when nothing needs
  // pixels, or a baked canvas. wantSide is how many device pixels the whole
  // picture would span on its long side where it is being drawn.
  function process(image, edit, wantSide) {
    if (!hasPixelOps(edit)) return image;
    const sw = image.naturalWidth || image.width || 0;
    const sh = image.naturalHeight || image.height || 0;
    if (!sw || !sh) return image;
    const side = Math.min(bucket(wantSide || 2048), Math.max(sw, sh));
    const key = cacheKey(edit, side);
    let entries = cache.get(image);
    if (!entries) {
      entries = new Map();
      cache.set(image, entries);
    }
    const hit = entries.get(key);
    if (hit) return hit;
    const out = bake(image, sw, sh, side, edit);
    entries.set(key, out);
    // A slider being dragged makes a new bake per step; keep the last few.
    while (entries.size > 4) entries.delete(entries.keys().next().value);
    return out;
  }

  function bake(image, sw, sh, side, edit) {
    const k = side / Math.max(sw, sh);
    const w = Math.max(1, Math.round(sw * k));
    const h = Math.max(1, Math.round(sh * k));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const g = canvas.getContext("2d", { willReadFrequently: true });
    const blur = num(edit.blur);
    if (blur > 0.05 && "filter" in g) {
      // Relative to the picture, so it looks the same at every bake size.
      g.filter = `blur(${(blur * Math.max(w, h)) / 1000}px)`;
      // Drawn a little oversize, so the blur does not pull in a dark edge.
      const pad = (blur * Math.max(w, h)) / 500;
      g.drawImage(image, -pad, -pad, w + pad * 2, h + pad * 2);
      g.filter = "none";
    } else {
      g.drawImage(image, 0, 0, w, h);
    }
    const needsPixels = edit.clean || edit.autoLevels || num(edit.sharpen) > 0.01 ||
      num(edit.threshold) > 0.01 || num(edit.clearPaper) > 0.01;
    if (!needsPixels) return canvas;
    let frame;
    try {
      frame = g.getImageData(0, 0, w, h);
    } catch (_) {
      return canvas; // a picture from another origin cannot be read
    }
    const d = frame.data;
    if (edit.clean) flatten(d, w, h, canvas);
    if (edit.autoLevels) levels(d);
    if (num(edit.sharpen) > 0.01) sharpen(d, w, h, Math.min(3, num(edit.sharpen)));
    if (num(edit.threshold) > 0.01) threshold(d, Math.min(1, num(edit.threshold)));
    if (num(edit.clearPaper) > 0.01) clearPaper(d, Math.min(1, num(edit.clearPaper)));
    g.putImageData(frame, 0, 0);
    return canvas;
  }

  const lum = (d, i) => d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;

  // Shadow removal. The paper's own brightness is estimated from a tiny copy
  // where writing has been grown over by the paper around it (a max filter),
  // and each pixel is divided by it: a shadowed corner and a lit one both
  // become white paper, and the ink keeps its darkness relative to them. A
  // dark board is the same thing the other way up.
  function flatten(d, w, h, source) {
    const sw = Math.max(4, Math.round(w / 24));
    const sh = Math.max(4, Math.round(h / 24));
    const small = document.createElement("canvas");
    small.width = sw;
    small.height = sh;
    const sg = small.getContext("2d", { willReadFrequently: true });
    sg.imageSmoothingQuality = "high";
    sg.drawImage(source, 0, 0, sw, sh);
    const s = sg.getImageData(0, 0, sw, sh);
    let total = 0;
    for (let i = 0; i < d.length; i += 4 * 97) total += lum(d, i);
    const dark = total / Math.ceil(d.length / (4 * 97)) < 110;
    const pick = dark ? Math.min : Math.max;
    for (let pass = 0; pass < 2; pass++) {
      const src = new Uint8ClampedArray(s.data);
      for (let y = 0; y < sh; y++) {
        for (let x = 0; x < sw; x++) {
          for (let c = 0; c < 3; c++) {
            let v = src[(y * sw + x) * 4 + c];
            for (let dy = -1; dy <= 1; dy++) {
              for (let dx = -1; dx <= 1; dx++) {
                const yy = y + dy;
                const xx = x + dx;
                if (yy >= 0 && yy < sh && xx >= 0 && xx < sw) v = pick(v, src[(yy * sw + xx) * 4 + c]);
              }
            }
            s.data[(y * sw + x) * 4 + c] = v;
          }
        }
      }
    }
    sg.putImageData(s, 0, 0);
    const big = document.createElement("canvas");
    big.width = w;
    big.height = h;
    const bg = big.getContext("2d", { willReadFrequently: true });
    bg.imageSmoothingQuality = "high";
    bg.drawImage(small, 0, 0, w, h);
    const b = bg.getImageData(0, 0, w, h).data;
    for (let i = 0; i < d.length; i += 4) {
      for (let c = 0; c < 3; c++) {
        const v = d[i + c];
        const p = b[i + c];
        d[i + c] = dark
          ? ((v - p) * 255) / Math.max(1, 255 - p)
          : Math.min(255, (v * 255) / Math.max(1, p));
      }
    }
  }

  // Auto levels: the 1st and 99th percentiles of brightness become black and
  // white, through one lookup table, so colour keeps its balance.
  function levels(d) {
    const hist = new Uint32Array(256);
    let n = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 8) continue;
      hist[Math.round(lum(d, i))] += 1;
      n += 1;
    }
    if (!n) return;
    let lo = 0;
    let hi = 255;
    let acc = 0;
    for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc > n * 0.01) { lo = v; break; } }
    acc = 0;
    for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc > n * 0.01) { hi = v; break; } }
    if (hi - lo < 16) return;
    const lut = new Uint8ClampedArray(256);
    for (let v = 0; v < 256; v++) lut[v] = ((v - lo) * 255) / (hi - lo);
    for (let i = 0; i < d.length; i += 4) {
      d[i] = lut[d[i]];
      d[i + 1] = lut[d[i + 1]];
      d[i + 2] = lut[d[i + 2]];
    }
  }

  // Unsharp mask on the four neighbours: an edge gets steeper, a flat area
  // stays flat.
  function sharpen(d, w, h, amount) {
    const src = new Uint8ClampedArray(d);
    const row = w * 4;
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * row + x * 4;
        for (let c = 0; c < 3; c++) {
          const v = src[i + c];
          const edge = 4 * v - src[i + c - 4] - src[i + c + 4] - src[i + c - row] - src[i + c + row];
          d[i + c] = v + amount * edge;
        }
      }
    }
  }

  // Black and white. A higher setting moves the cut-off up, so more of the
  // grey becomes ink: faint pencil turns bold.
  function threshold(d, strength) {
    const cut = 70 + strength * 160;
    for (let i = 0; i < d.length; i += 4) {
      const v = lum(d, i) < cut ? 0 : 255;
      d[i] = v;
      d[i + 1] = v;
      d[i + 2] = v;
    }
  }

  // Paper to transparent: anything near white fades out over a soft edge, so
  // scanned notes or a diagram sit straight on the canvas.
  function clearPaper(d, strength) {
    const top = 250 - strength * 110;
    const soft = 28;
    for (let i = 0; i < d.length; i += 4) {
      const v = Math.min(d[i], d[i + 1], d[i + 2]);
      if (v >= top) d[i + 3] = 0;
      else if (v > top - soft) d[i + 3] = Math.round(d[i + 3] * ((top - v) / soft));
    }
  }

  window.Inkyscib = window.Inkyscib || {};
  window.Inkyscib.ImageProcess = { process, hasPixelOps, bucket };
})();
