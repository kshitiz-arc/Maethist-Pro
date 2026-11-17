// Insert a picture onto the canvas.
//
// Stored as an `image` path: two corner points plus a data URL, the same shape
// a captured video moment uses, so selection, moving and aspect-locked resize
// come for free from select.js.
//
// Everything is downscaled before it is stored. A phone photo is several
// megabytes, the save layer drops any media data URL over 2 MB, and a silently
// dropped picture is worse than a slightly softer one.
(function () {
  "use strict";

  // Long edge, in image pixels. A notebook page is ~794 world units wide, so
  // this still has detail to spare at full zoom.
  const MAX_EDGE = 1600;

  // Kept under the storage layer's 2 MB ceiling with room for the base64
  // overhead, which inflates the payload by about a third.
  const MAX_DATA_URL = 1.8 * 1024 * 1024;

  const QUALITY_STEPS = [0.86, 0.72, 0.6, 0.48];

  function state() {
    return window.appState;
  }

  function setStatus(message, tone) {
    // The status line is in the side menu, off screen in the v2 chrome.
    if (tone) window.Inkyscib?.notify?.(message, { tone });
    const element = document.getElementById("imageInsertStatus");
    if (element) element.textContent = message || "";
    if (message) window.setTimeout(() => {
      if (element && element.textContent === message) element.textContent = "";
    }, 4000);
  }

  // ---------- reading the file ----------

  function readAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error("read failed"));
      reader.readAsDataURL(file);
    });
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("decode failed"));
      image.src = src;
    });
  }

  // Re-encode down to something the save layer will actually keep. PNG is
  // preserved only when it is already small, since flattening a screenshot to
  // JPEG turns crisp text to mush.
  function compress(image) {
    const scale = Math.min(1, MAX_EDGE / Math.max(image.naturalWidth, image.naturalHeight));
    const width = Math.max(1, Math.round(image.naturalWidth * scale));
    const height = Math.max(1, Math.round(image.naturalHeight * scale));

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(image, 0, 0, width, height);

    const png = canvas.toDataURL("image/png");
    if (png.length <= MAX_DATA_URL) return { dataUrl: png, width, height };

    for (let i = 0; i < QUALITY_STEPS.length; i += 1) {
      const jpeg = canvas.toDataURL("image/jpeg", QUALITY_STEPS[i]);
      if (jpeg.length <= MAX_DATA_URL) return { dataUrl: jpeg, width, height };
    }
    return null;
  }

  // ---------- where it lands ----------

  function visibleWorldRect() {
    const s = state();
    const metrics = typeof window.getCanvasMetrics === "function"
      ? window.getCanvasMetrics()
      : { width: 900, height: 600 };
    const scale = Math.max(0.05, s?.transform?.scale || 1);
    const offsetX = Number.isFinite(s?.transform?.offsetX) ? s.transform.offsetX : 0;
    const offsetY = Number.isFinite(s?.transform?.offsetY) ? s.transform.offsetY : 0;
    return {
      left: -offsetX / scale,
      top: -offsetY / scale,
      width: (metrics.width || 900) / scale,
      height: (metrics.height || 600) / scale
    };
  }

  // Centred on what is on screen, at about two thirds of the smaller side, and
  // never wider than a notebook page when one is in use.
  function placement(imageWidth, imageHeight) {
    const view = visibleWorldRect();
    const notebook = window.Inkyscib?.Notebook;
    const active = !!state()?.notebook?.active;

    let maxWidth = view.width * 0.66;
    let maxHeight = view.height * 0.66;

    if (active && notebook?.dims) {
      const page = notebook.dims();
      maxWidth = Math.min(maxWidth, page.pageWidth * 0.8);
      maxHeight = Math.min(maxHeight, page.pageHeight * 0.8);
    }

    const ratio = Math.min(maxWidth / imageWidth, maxHeight / imageHeight, 1);
    const width = Math.max(24, imageWidth * ratio);
    const height = Math.max(24, imageHeight * ratio);

    let centreX = view.left + view.width / 2;
    const centreY = view.top + view.height / 2;

    // A notebook page is a fixed column; keep the picture inside it rather
    // than half over the margin.
    if (active && notebook?.dims) {
      centreX = notebook.dims().pageWidth / 2;
    }

    return {
      left: centreX - width / 2,
      top: centreY - height / 2,
      right: centreX + width / 2,
      bottom: centreY + height / 2
    };
  }

  // ---------- insertion ----------

  async function insertFile(file) {
    if (!file) return false;
    if (!/^image\//i.test(file.type)) {
      setStatus("That file is not an image. Choose a PNG, JPEG, WebP or GIF.", "error");
      return false;
    }

    setStatus("Reading image…");

    let compressed = null;
    try {
      const image = await loadImage(await readAsDataUrl(file));
      compressed = compress(image);
    } catch (error) {
      setStatus("That image could not be read. It may be damaged.", "error");
      return false;
    }

    if (!compressed) {
      setStatus("That image is too large to store, even compressed.", "error");
      return false;
    }

    const box = placement(compressed.width, compressed.height);
    const path = {
      tool: "image",
      image: compressed.dataUrl,
      points: [
        { x: box.left, y: box.top },
        { x: box.right, y: box.bottom }
      ],
      timestamp: Date.now()
    };

    if (typeof window.commitHistory === "function") window.commitHistory();
    state().paths.push(path);

    if (typeof window.render === "function") window.render();
    if (typeof window.saveDrawing === "function") window.saveDrawing();

    // Drop straight into Select so it can be moved or resized immediately.
    const index = state().paths.length - 1;
    if (typeof window.setTool === "function") window.setTool("select");
    window.Inkyscib?.Selection?.selectIndex?.(index);
    if (typeof window.render === "function") window.render();

    setStatus("Image added.");
    return true;
  }

  function init() {
    const button = document.getElementById("imageInsertBtn");
    const input = document.getElementById("imageInsertInput");
    if (!button || !input) return;

    button.addEventListener("click", () => input.click());

    input.addEventListener("change", async () => {
      const file = input.files && input.files[0];
      // Reset first: picking the same file twice must fire change again.
      input.value = "";
      if (file) await insertFile(file);
    });
  }

  window.Inkyscib = window.Inkyscib || {};
  window.Inkyscib.ImageInsert = { insertFile };

  document.addEventListener("DOMContentLoaded", init);
})();
