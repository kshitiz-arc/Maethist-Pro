// Image tools: what you can do to a picture on the canvas.
//
// A captured YouTube frame or an inserted picture used to be selectable and
// nothing else: no way to delete it with a tap, crop it, straighten it, or make
// a dark lecture slide readable on white paper. Select one (the capture
// selects it for you) and a bar of actions appears above it; Edit opens a sheet
// with crop, presets, sliders, rotation and the frame's background.
//
// Every edit is one undo step and lives on the path as `edit` (static/js/
// canvas.js, __drawMediaImage, draws it). The picture's own pixels are never
// changed, so Reset always gets the original back. History snapshots share a
// frame's objects rather than copying its image, so an edit always replaces
// `edit` and `points` with new objects and never changes them in place.
(function () {
  "use strict";

  const MEDIA = new Set(["youtube-frame", "image"]);
  const PRESETS = {
    original: { label: "Original", values: {} },
    // The council's first pick for photos of notes: even light, levels, a
    // little sharpening, then grey. It used to be contrast and brightness only,
    // which brightened the shadow along with the paper.
    scan: { label: "Clean scan", values: { clean: true, autoLevels: true, sharpen: 0.45, grayscale: 1, contrast: 1.1 } },
    board: { label: "Board to paper", values: { invert: 1, grayscale: 1, contrast: 1.35, brightness: 1.04, sharpen: 0.3 } },
    ink: { label: "Ink only", values: { clean: true, threshold: 0.45, clearPaper: 0.5 } },
    mono: { label: "Mono", values: { grayscale: 1 } },
    vivid: { label: "Vivid", values: { saturate: 1.45, contrast: 1.12 } },
    warm: { label: "Warm", values: { sepia: 0.28, saturate: 1.15 } }
  };
  const FILTER_KEYS = ["brightness", "contrast", "saturate", "grayscale", "invert", "sepia", "hue",
    "clean", "autoLevels", "sharpen", "threshold", "clearPaper", "blur"];
  // Every slider in the sheet: key, label, range, the value that means "no
  // change", how its reading is written, and the section it sits in.
  const SLIDERS = [
    ["brightness", "Brightness", 0.5, 1.5, 0.01, 1, "%", "light"],
    ["contrast", "Contrast", 0.5, 2, 0.01, 1, "%", "light"],
    ["saturate", "Saturation", 0, 2, 0.01, 1, "%", "light"],
    ["hue", "Hue", -180, 180, 1, 0, "deg", "light"],
    ["blur", "Blur", 0, 20, 0.1, 0, "", "light"],
    ["opacity", "Opacity", 0.2, 1, 0.01, 1, "%", "light"],
    ["fade", "Fade", 0, 0.9, 0.01, 0, "%", "bg"],
    ["sharpen", "Sharpen", 0, 2, 0.05, 0, "%", "clean"],
    ["threshold", "Black and white", 0, 1, 0.01, 0, "%", "clean"],
    ["clearPaper", "Clear the paper", 0, 1, 0.01, 0, "%", "clean"],
    ["straighten", "Straighten", -15, 15, 0.1, 0, "deg", "clean"]
  ];
  const NEUTRAL = Object.fromEntries(SLIDERS.map((row) => [row[0], row[5]]));
  const TOGGLES = [["clean", "Even out light"], ["autoLevels", "Auto levels"]];
  const FITS = [{ id: "cover", label: "Fill" }, { id: "contain", label: "Fit" }, { id: "tile", label: "Tile" }];

  function formatValue(key, value) {
    const row = SLIDERS.find((r) => r[0] === key);
    if (!row) return String(value);
    if (row[6] === "%") return Math.round(value * 100) + "%";
    if (row[6] === "deg") return (value > 0 ? "+" : "") + (Math.round(value * 10) / 10) + "\u00b0";
    return value ? String(Math.round(value * 10) / 10) : "Off";
  }
  const BACKDROPS = [
    { id: "auto", label: "Theme" },
    { id: "paper", label: "Paper" },
    { id: "ink", label: "Ink" },
    { id: "none", label: "None" }
  ];
  const ASPECTS = [
    { id: "free", label: "Free", ratio: null },
    { id: "original", label: "Original", ratio: "original" },
    { id: "16:9", label: "16:9", ratio: 16 / 9 },
    { id: "4:3", label: "4:3", ratio: 4 / 3 },
    { id: "1:1", label: "1:1", ratio: 1 }
  ];

  const icon = (ref) => {
    try { return window.Inkyscib?.Icon?.svg?.(ref) || ""; } catch (_) { return ""; }
  };
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const state = () => window.appState;
  const selection = () => window.Inkyscib?.Selection;

  function render() {
    if (typeof window.invalidateCanvasDrawingCache === "function") window.invalidateCanvasDrawingCache();
    if (typeof window.render === "function") window.render();
  }

  function save() {
    if (typeof window.saveDrawing === "function") window.saveDrawing();
  }

  function notify(message, tone) {
    if (window.Inkyscib?.notify) window.Inkyscib.notify(message, { tone: tone || "success" });
  }

  // ---------- the selected picture ----------

  function selectedMedia() {
    const sel = selection();
    const s = state();
    if (!sel || !s || s.currentTool !== "select") return null;
    const indices = sel.selectedIndices?.() || [];
    if (indices.length !== 1) return null;
    const index = indices[0];
    const path = s.paths?.[index];
    return path && MEDIA.has(path.tool) ? { index, path } : null;
  }

  function box(path) {
    const [a, b] = path.points;
    return {
      left: Math.min(a.x, b.x),
      top: Math.min(a.y, b.y),
      width: Math.abs(b.x - a.x),
      height: Math.abs(b.y - a.y)
    };
  }

  function boxPoints(cx, cy, width, height) {
    return [
      { x: cx - width / 2, y: cy - height / 2 },
      { x: cx + width / 2, y: cy + height / 2 }
    ];
  }

  function editOf(path) {
    const e = path?.edit && typeof path.edit === "object" ? path.edit : {};
    return { ...e, crop: e.crop ? { ...e.crop } : null };
  }

  function sourceSize(path) {
    const img = new Image();
    img.src = path.image;
    return { width: img.naturalWidth || 16, height: img.naturalHeight || 9 };
  }

  // Width over height of what is shown: the crop, turned by the rotation.
  function shownAspect(path, edit) {
    const src = sourceSize(path);
    const crop = edit.crop || { x: 0, y: 0, w: 1, h: 1 };
    let aspect = (src.width * crop.w) / Math.max(1e-6, src.height * crop.h);
    const rot = ((edit.rotate || 0) % 360 + 360) % 360;
    if (rot === 90 || rot === 270) aspect = 1 / aspect;
    return aspect;
  }

  // One undoable change to the selected picture.
  function update(change, options = {}) {
    const found = selectedMedia();
    if (!found) return null;
    if (options.history !== false && typeof window.commitHistory === "function") window.commitHistory();
    const next = {
      ...found.path,
      points: found.path.points.map((p) => ({ ...p })),
      edit: editOf(found.path)
    };
    change(next);
    if (next.edit && !Object.keys(next.edit).some((k) => next.edit[k] !== null && next.edit[k] !== undefined)) delete next.edit;
    state().paths[found.index] = next;
    render();
    save();
    syncBar(true);
    return next;
  }

  // Keep the box's width (or fit its longest side) and match the new aspect.
  function refit(next) {
    const b = box(next);
    const aspect = shownAspect(next, next.edit);
    const cx = b.left + b.width / 2;
    const cy = b.top + b.height / 2;
    const longest = Math.max(b.width, b.height);
    const width = aspect >= 1 ? longest : longest * aspect;
    const height = aspect >= 1 ? longest / aspect : longest;
    next.points = boxPoints(cx, cy, width, height);
    // The selection resizes frames at this ratio, and loading repairs a frame
    // back to it, so it has to describe what is shown now.
    next.aspectRatio = width / height;
  }

  // ---------- actions ----------

  const actions = {
    rotate(direction = 1) {
      update((next) => {
        next.edit.rotate = (((next.edit.rotate || 0) + 90 * direction) % 360 + 360) % 360;
        const b = box(next);
        next.points = boxPoints(b.left + b.width / 2, b.top + b.height / 2, b.height, b.width);
        next.aspectRatio = b.height / Math.max(1e-6, b.width);
      });
    },
    flipX() { update((next) => { next.edit.flipX = !next.edit.flipX; }); },
    flipY() { update((next) => { next.edit.flipY = !next.edit.flipY; }); },
    duplicate() {
      const found = selectedMedia();
      if (!found) return;
      if (typeof window.commitHistory === "function") window.commitHistory();
      const b = box(found.path);
      const shift = Math.max(16, Math.min(48, b.width * 0.06));
      const copy = {
        ...found.path,
        points: found.path.points.map((p) => ({ x: p.x + shift, y: p.y + shift })),
        edit: found.path.edit ? editOf(found.path) : undefined,
        timestamp: Date.now()
      };
      if (!copy.edit) delete copy.edit;
      state().paths.push(copy);
      selection()?.selectIndex?.(state().paths.length - 1);
      render();
      save();
      syncBar(true);
    },
    remove() {
      const sel = selection();
      if (!selectedMedia() || !sel?.deleteSelected) return;
      sel.deleteSelected();
      render();
      hideBar();
      notify("Deleted. Undo brings it back.");
    },
    undo() {
      if (typeof window.undo === "function") window.undo();
      window.requestAnimationFrame(() => syncBar(true));
    },
    redo() {
      if (typeof window.redo === "function") window.redo();
      window.requestAnimationFrame(() => syncBar(true));
    },
    toFront() {
      const found = selectedMedia();
      if (!found) return;
      if (typeof window.commitHistory === "function") window.commitHistory();
      const paths = state().paths;
      paths.push(paths.splice(found.index, 1)[0]);
      selection()?.selectIndex?.(paths.length - 1);
      render();
      save();
    },
    toBack() {
      const found = selectedMedia();
      if (!found) return;
      if (typeof window.commitHistory === "function") window.commitHistory();
      const paths = state().paths;
      paths.unshift(paths.splice(found.index, 1)[0]);
      selection()?.selectIndex?.(0);
      render();
      save();
    },
    toggleBadge() {
      update((next) => {
        if (next.hideBadge) delete next.hideBadge;
        else next.hideBadge = true;
      });
    },
    reset() {
      update((next) => {
        delete next.edit;
        delete next.hideBadge;
        next.edit = {};
        refit(next);
      });
    },
    openVideo() {
      const found = selectedMedia();
      if (found?.path.tool === "youtube-frame") window.Inkyscib?.YouTube?.openFrame?.(found.path);
    },
    async download() {
      const found = selectedMedia();
      if (!found) return;
      try {
        const blob = await renderEdited(found.path, editOf(found.path));
        const link = document.createElement("a");
        const stamp = found.path.tool === "youtube-frame" ? `-${Math.floor(found.path.videoTime || 0)}s` : "";
        link.download = `maethist-image${stamp}.png`;
        link.href = URL.createObjectURL(blob);
        document.body.appendChild(link);
        link.click();
        link.remove();
        window.setTimeout(() => URL.revokeObjectURL(link.href), 4000);
      } catch (_) {
        notify("That image could not be saved", "error");
      }
    },
    edit() { openSheet(); },
    // Read the picture with Image to text. It is sent at most 1600px on its
    // long side (a 4K frame is several megabytes and reads no better), and a
    // video frame starts on Text, a picture on Equation; the sheet switches.
    toText() {
      const found = selectedMedia();
      const Ocr = window.Inkyscib?.Ocr;
      if (!found || !Ocr) return;
      const source = found.path.image;
      const img = new Image();
      img.onload = () => {
        const k = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
        const c = document.createElement("canvas");
        c.width = Math.max(1, Math.round(img.naturalWidth * k));
        c.height = Math.max(1, Math.round(img.naturalHeight * k));
        const g = c.getContext("2d");
        g.fillStyle = "#ffffff";
        g.fillRect(0, 0, c.width, c.height);
        g.drawImage(img, 0, 0, c.width, c.height);
        Ocr.convertImage(c.toDataURL("image/jpeg", 0.92), found.path.tool === "youtube-frame" ? "text" : "math");
      };
      img.src = typeof source === "string" ? source : source?.src || "";
    }
  };

  // The edited picture at its own resolution, for Save image.
  function renderEdited(path, edit) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const crop = edit.crop || { x: 0, y: 0, w: 1, h: 1 };
        const cw = img.naturalWidth * crop.w;
        const ch = img.naturalHeight * crop.h;
        const rot = ((edit.rotate || 0) % 360 + 360) % 360;
        const quarter = rot === 90 || rot === 270;
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(quarter ? ch : cw));
        canvas.height = Math.max(1, Math.round(quarter ? cw : ch));
        const ctx = canvas.getContext("2d");
        window.Inkyscib.MediaDraw.draw(ctx, img, 0, 0, canvas.width, canvas.height, edit);
        canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("encode"))), "image/png");
      };
      img.onerror = reject;
      img.src = path.image;
    });
  }

  // ---------- the bar ----------

  let bar = null;
  let more = null;
  let tracking = 0;
  let lastKey = "";

  function buildBar() {
    bar = document.createElement("div");
    bar.className = "img-bar";
    bar.id = "imageToolsBar";
    bar.dataset.iconSet = "lucide";
    bar.setAttribute("role", "toolbar");
    bar.setAttribute("aria-label", "Image");
    bar.hidden = true;
    bar.innerHTML = `
      <button type="button" class="img-btn img-btn-primary" data-act="edit" title="Edit: crop, filters, light">${icon("lucide:sliders-horizontal")}<span>Edit</span></button>
      <button type="button" class="img-btn" data-act="rotate" title="Rotate 90°" aria-label="Rotate 90 degrees">${icon("lucide:rotate-cw")}</button>
      <button type="button" class="img-btn" data-act="duplicate" title="Duplicate" aria-label="Duplicate">${icon("lucide:copy")}</button>
      <button type="button" class="img-btn" data-act="openVideo" data-only="youtube-frame" title="Open the video at this moment" aria-label="Open the video at this moment">${icon("lucide:tv-minimal-play")}</button>
      <span class="img-sep" aria-hidden="true"></span>
      <button type="button" class="img-btn" data-act="undo" title="Undo (Ctrl+Z)" aria-label="Undo">${icon("lucide:undo-2")}</button>
      <button type="button" class="img-btn" data-act="redo" title="Redo (Ctrl+Y)" aria-label="Redo">${icon("lucide:redo-2")}</button>
      <button type="button" class="img-btn img-btn-danger" data-act="remove" title="Delete (Del)" aria-label="Delete">${icon("lucide:trash")}</button>
      <button type="button" class="img-btn" data-act="more" title="More" aria-label="More image actions" aria-haspopup="menu" aria-expanded="false">${icon("lucide:ellipsis")}</button>`;
    more = document.createElement("div");
    more.className = "img-more";
    more.id = "imageToolsMore";
    more.dataset.iconSet = "lucide";
    more.setAttribute("role", "menu");
    more.hidden = true;
    more.innerHTML = `
      <button type="button" role="menuitem" data-act="flipX">${icon("lucide:square-split-horizontal")}<span>Flip left to right</span></button>
      <button type="button" role="menuitem" data-act="flipY">${icon("lucide:square-split-vertical")}<span>Flip upside down</span></button>
      <button type="button" role="menuitem" data-act="toFront">${icon("lucide:bring-to-front")}<span>Bring to front</span></button>
      <button type="button" role="menuitem" data-act="toBack">${icon("lucide:send-to-back")}<span>Send behind ink</span></button>
      <button type="button" role="menuitem" data-act="toggleBadge" data-only="youtube-frame">${icon("lucide:eye-off")}<span class="img-badge-label">Hide the timestamp</span></button>
      <button type="button" role="menuitem" data-act="toText">${icon("lucide:scan-text")}<span>Convert to text</span></button>
      <button type="button" role="menuitem" data-act="download">${icon("lucide:download")}<span>Save image</span></button>
      <button type="button" role="menuitem" data-act="reset">${icon("lucide:rotate-ccw")}<span>Reset all edits</span></button>`;
    document.body.append(bar, more);

    const onAct = (event) => {
      const button = event.target.closest("[data-act]");
      if (!button) return;
      event.preventDefault();
      event.stopPropagation();
      const act = button.dataset.act;
      if (act === "more") {
        setMore(more.hidden);
        return;
      }
      setMore(false);
      actions[act]?.();
    };
    [bar, more].forEach((el) => {
      el.addEventListener("click", onAct);
      // Never start a stroke or a marquee under the bar.
      ["pointerdown", "mousedown", "touchstart"].forEach((type) =>
        el.addEventListener(type, (event) => event.stopPropagation(), { passive: true }));
    });
  }

  function setMore(open) {
    if (!more || !bar) return;
    more.hidden = !open;
    bar.querySelector('[data-act="more"]')?.setAttribute("aria-expanded", String(!!open));
    if (open) placeMore();
  }

  function chromeFloor() {
    let floor = 0;
    document.querySelectorAll(".toolbar, .file-ribbon").forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.height && r.top < window.innerHeight / 2) floor = Math.max(floor, r.bottom);
    });
    return floor;
  }

  function place() {
    const found = selectedMedia();
    const sel = selection();
    const metrics = typeof window.getCanvasMetrics === "function" ? window.getCanvasMetrics() : null;
    if (!found || !sel || !metrics) return false;
    const t = state().transform || { scale: 1, offsetX: 0, offsetY: 0 };
    const b = box(found.path);
    const rect = metrics.rect;
    const left = rect.left + b.left * t.scale + t.offsetX;
    const top = rect.top + b.top * t.scale + t.offsetY;
    const right = left + b.width * t.scale;
    const bottom = top + b.height * t.scale;
    const key = [left, top, right, bottom, found.index].map((v) => Math.round(v)).join(",");
    if (key === lastKey && !bar.hidden) return true;
    lastKey = key;
    const w = bar.offsetWidth || 360;
    const h = bar.offsetHeight || 48;
    const floor = chromeFloor() + 8;
    let y = top - h - 14;
    let below = false;
    if (y < floor) {
      y = bottom + 14;
      below = true;
    }
    // A picture filling the screen: sit inside its top edge instead.
    if (y + h > window.innerHeight - 8) {
      y = Math.max(floor, top + 10);
      below = false;
    }
    const x = clamp((left + right) / 2 - w / 2, 8, Math.max(8, window.innerWidth - w - 8));
    bar.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    bar.classList.toggle("is-below", below);
    if (!more.hidden) placeMore();
    return true;
  }

  function placeMore() {
    const anchor = bar.querySelector('[data-act="more"]').getBoundingClientRect();
    const w = more.offsetWidth || 220;
    const h = more.offsetHeight || 300;
    const x = clamp(anchor.right - w, 8, window.innerWidth - w - 8);
    let y = anchor.bottom + 8;
    if (y + h > window.innerHeight - 8) y = Math.max(8, anchor.top - h - 8);
    more.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }

  function hideBar() {
    if (!bar) return;
    bar.hidden = true;
    setMore(false);
    lastKey = "";
    if (tracking) window.cancelAnimationFrame(tracking);
    tracking = 0;
  }

  function track() {
    tracking = 0;
    if (!selectedMedia() || sheetOpen()) {
      hideBar();
      return;
    }
    place();
    tracking = window.requestAnimationFrame(track);
  }

  function syncBar(force) {
    if (!bar) buildBar();
    const found = selectedMedia();
    if (!found || sheetOpen()) {
      hideBar();
      return;
    }
    const isFrame = found.path.tool === "youtube-frame";
    [bar, more].forEach((root) => root.querySelectorAll("[data-only]").forEach((el) => {
      el.hidden = el.dataset.only !== found.path.tool;
    }));
    const badge = more.querySelector(".img-badge-label");
    if (badge && isFrame) badge.textContent = found.path.hideBadge ? "Show the timestamp" : "Hide the timestamp";
    const s = state();
    bar.querySelector('[data-act="undo"]').disabled = !(s.undoStack || []).length;
    bar.querySelector('[data-act="redo"]').disabled = !(s.redoStack || []).length;
    const wasHidden = bar.hidden;
    bar.hidden = false;
    if (force) lastKey = "";
    place();
    if (wasHidden) {
      bar.classList.remove("is-in");
      void bar.offsetWidth;
      bar.classList.add("is-in");
    }
    if (!tracking) tracking = window.requestAnimationFrame(track);
  }

  // ---------- the Edit sheet ----------

  let sheet = null;
  let draft = null;
  let draftHideBadge = false;
  let editing = null;
  let sourceImage = null;
  let view = "adjust";
  let aspectId = "free";

  function sheetOpen() {
    return !!sheet && !sheet.hidden;
  }

  function buildSheet() {
    sheet = document.createElement("div");
    sheet.className = "img-sheet";
    sheet.id = "imageEditSheet";
    sheet.dataset.iconSet = "lucide";
    sheet.hidden = true;
    sheet.innerHTML = `
      <div class="img-sheet-card" role="dialog" aria-modal="true" aria-labelledby="imgSheetTitle">
        <div class="img-sheet-head">
          <h2 id="imgSheetTitle">Edit image</h2>
          <div class="img-tabs" role="tablist" aria-label="Edit">
            <button type="button" role="tab" data-view="adjust" aria-selected="true">${icon("lucide:sun")}<span>Adjust</span></button>
            <button type="button" role="tab" data-view="crop" aria-selected="false">${icon("lucide:crop")}<span>Crop</span></button>
          </div>
          <button type="button" class="img-sheet-close" data-sheet="cancel" aria-label="Cancel">${icon("lucide:x")}</button>
        </div>
        <div class="img-stage">
          <canvas class="img-preview" width="640" height="400" aria-label="Preview"></canvas>
          <div class="img-crop" hidden>
            <div class="img-crop-box" tabindex="0" aria-label="Crop area">
              <span data-h="nw"></span><span data-h="ne"></span><span data-h="sw"></span><span data-h="se"></span>
            </div>
          </div>
        </div>
        <div class="img-panel" data-panel="adjust">
          <div class="img-presets" role="group" aria-label="Looks">
            ${Object.entries(PRESETS).map(([id, p]) => `<button type="button" class="img-chip" data-preset="${id}">${p.label}</button>`).join("")}
          </div>
          <div class="img-group img-bg-only" role="group" aria-label="Picture size">
            <span class="img-group-label">Picture</span>
            ${FITS.map((f) => `<button type="button" class="img-chip img-chip-sm" data-fit="${f.id}">${f.label}</button>`).join("")}
            <label class="img-check"><input type="checkbox" data-grid> Grid over it</label>
          </div>
          <p class="img-section">Light and colour</p>
          <div class="img-sliders">
            ${SLIDERS.filter((r) => r[7] === "light" || r[7] === "bg").map((r) => slider(...r)).join("")}
          </div>
          <p class="img-section">Clean up</p>
          <div class="img-toggles" role="group" aria-label="Clean up">
            ${TOGGLES.map(([key, label]) => `<button type="button" class="img-chip" data-toggle="${key}" aria-pressed="false">${label}</button>`).join("")}
          </div>
          <div class="img-sliders">
            ${SLIDERS.filter((r) => r[7] === "clean").map((r) => slider(...r)).join("")}
          </div>
          <div class="img-row">
            <div class="img-group" role="group" aria-label="Turn">
              <button type="button" class="img-mini" data-turn="-1" aria-label="Rotate left">${icon("lucide:rotate-ccw")}</button>
              <button type="button" class="img-mini" data-turn="1" aria-label="Rotate right">${icon("lucide:rotate-cw")}</button>
              <button type="button" class="img-mini" data-flip="x" aria-label="Flip left to right">${icon("lucide:square-split-horizontal")}</button>
              <button type="button" class="img-mini" data-flip="y" aria-label="Flip upside down">${icon("lucide:square-split-vertical")}</button>
            </div>
            <div class="img-group img-frame-only" role="group" aria-label="Background">
              <span class="img-group-label">Background</span>
              ${BACKDROPS.map((b) => `<button type="button" class="img-chip img-chip-sm" data-backdrop="${b.id}">${b.label}</button>`).join("")}
            </div>
            <label class="img-check img-frame-only"><input type="checkbox" data-badge> Timestamp</label>
          </div>
        </div>
        <div class="img-panel" data-panel="crop" hidden>
          <div class="img-presets" role="group" aria-label="Shape">
            ${ASPECTS.map((a) => `<button type="button" class="img-chip" data-aspect="${a.id}">${a.label}</button>`).join("")}
          </div>
          <p class="img-hint">Drag the corners, or drag inside to move the crop.</p>
        </div>
        <div class="img-sheet-foot">
          <button type="button" class="img-ghost" data-sheet="reset">${icon("lucide:rotate-ccw")}<span>Reset</span></button>
          <button type="button" class="img-ghost img-compare" data-compare aria-label="Hold to see the original">${icon("lucide:eye")}<span>Hold to compare</span></button>
          <span class="img-gap"></span>
          <button type="button" class="img-ghost" data-sheet="cancel">Cancel</button>
          <button type="button" class="img-apply" data-sheet="apply">${icon("lucide:check")}<span>Apply</span></button>
        </div>
      </div>`;
    document.body.appendChild(sheet);

    sheet.addEventListener("click", (event) => {
      if (event.target === sheet) return closeSheet(false);
      const t = event.target.closest("button");
      if (!t) return;
      if (t.dataset.view) setView(t.dataset.view);
      else if (t.dataset.preset) applyPreset(t.dataset.preset);
      else if (t.dataset.toggle) {
        draft[t.dataset.toggle] = !draft[t.dataset.toggle];
        sheet.querySelectorAll("[data-preset]").forEach((b) => b.setAttribute("aria-pressed", "false"));
        syncSheet();
        drawPreview();
      } else if (t.dataset.fit) {
        draft.fit = t.dataset.fit;
        syncSheet();
        drawPreview();
      }
      else if (t.dataset.turn) {
        draft.rotate = (((draft.rotate || 0) + 90 * Number(t.dataset.turn)) % 360 + 360) % 360;
        drawPreview();
      } else if (t.dataset.flip) {
        const key = t.dataset.flip === "x" ? "flipX" : "flipY";
        draft[key] = !draft[key];
        drawPreview();
      } else if (t.dataset.backdrop) {
        draft.backdrop = t.dataset.backdrop === "auto" ? undefined : t.dataset.backdrop;
        syncSheet();
        drawPreview();
      } else if (t.dataset.aspect) setAspect(t.dataset.aspect);
      else if (t.dataset.sheet === "apply") closeSheet(true);
      else if (t.dataset.sheet === "cancel") closeSheet(false);
      else if (t.dataset.sheet === "reset") {
        draft = { crop: null };
        draftHideBadge = false;
        aspectId = "free";
        syncSheet();
        drawPreview();
        if (view === "crop") placeCropBox();
      }
    });
    sheet.addEventListener("input", (event) => {
      const input = event.target.closest("[data-slider]");
      if (input) {
        draft[input.dataset.slider] = Number(input.value);
        sheet.querySelector(`[data-out="${input.dataset.slider}"]`).textContent = formatValue(input.dataset.slider, Number(input.value));
        sheet.querySelectorAll("[data-preset]").forEach((b) => b.setAttribute("aria-pressed", "false"));
        drawPreview();
      }
      if (event.target.matches("[data-grid]")) {
        draft.grid = event.target.checked;
      }
      if (event.target.matches("[data-badge]")) {
        draftHideBadge = !event.target.checked;
        drawPreview();
      }
    });
    sheet.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Escape") closeSheet(false);
      if (event.key === "Enter" && !event.target.matches("button, input[type=range]")) closeSheet(true);
      if (event.key === "Tab") trapFocus(event);
    });
    ["keyup", "keypress"].forEach((type) => sheet.addEventListener(type, (event) => event.stopPropagation()));
    ["pointerdown", "mousedown", "touchstart", "wheel"].forEach((type) =>
      sheet.addEventListener(type, (event) => event.stopPropagation(), { passive: type !== "pointerdown" }));
    bindCrop();
    // Hold to compare: the original while the button is held.
    const compare = sheet.querySelector("[data-compare]");
    const showOriginal = (on) => { comparing = on; compare.classList.toggle("is-held", on); drawPreview(); };
    compare.addEventListener("pointerdown", (event) => { event.preventDefault(); showOriginal(true); });
    ["pointerup", "pointerleave", "pointercancel"].forEach((type) =>
      compare.addEventListener(type, () => { if (comparing) showOriginal(false); }));
    compare.addEventListener("keydown", (event) => { if (event.key === " " && !comparing) { event.preventDefault(); showOriginal(true); } });
    compare.addEventListener("keyup", (event) => { if (event.key === " ") showOriginal(false); });
  }

  let comparing = false;

  function slider(key, label, min, max, step, neutral = 1, _unit = "%", group = "") {
    return `<label class="img-slider${group === "bg" ? " img-bg-only" : ""}"><span>${label} <output data-out="${key}">${formatValue(key, neutral)}</output></span>
      <input type="range" data-slider="${key}" min="${min}" max="${max}" step="${step}" value="${neutral}"></label>`;
  }

  function trapFocus(event) {
    const items = [...sheet.querySelectorAll("button:not([hidden]), input, [tabindex='0']")]
      .filter((el) => el.offsetParent !== null);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }

  function applyPreset(id) {
    const preset = PRESETS[id];
    if (!preset) return;
    FILTER_KEYS.forEach((key) => { delete draft[key]; });
    Object.assign(draft, preset.values);
    syncSheet();
    sheet.querySelectorAll("[data-preset]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.preset === id)));
    drawPreview();
  }

  function syncSheet() {
    SLIDERS.forEach(([key, , , , , neutral]) => {
      const value = Number.isFinite(Number(draft[key])) ? Number(draft[key]) : neutral;
      const input = sheet.querySelector(`[data-slider="${key}"]`);
      input.value = value;
      sheet.querySelector(`[data-out="${key}"]`).textContent = formatValue(key, value);
    });
    TOGGLES.forEach(([key]) => sheet.querySelector(`[data-toggle="${key}"]`).setAttribute("aria-pressed", String(!!draft[key])));
    const isFrame = editing?.path.tool === "youtube-frame";
    const isBackground = editing?.kind === "background";
    sheet.querySelectorAll(".img-frame-only").forEach((el) => { el.hidden = !isFrame; });
    sheet.querySelectorAll(".img-bg-only").forEach((el) => { el.hidden = !isBackground; });
    sheet.querySelector("#imgSheetTitle").textContent = isBackground ? "Edit the background picture" : "Edit image";
    sheet.querySelectorAll("[data-fit]").forEach((b) => b.setAttribute("aria-pressed", String((draft.fit || "cover") === b.dataset.fit)));
    const grid = sheet.querySelector("[data-grid]");
    if (grid) grid.checked = !!draft.grid;
    sheet.querySelectorAll("[data-backdrop]").forEach((b) =>
      b.setAttribute("aria-pressed", String((draft.backdrop || "auto") === b.dataset.backdrop)));
    const badge = sheet.querySelector("[data-badge]");
    if (badge) badge.checked = !draftHideBadge;
    sheet.querySelectorAll("[data-aspect]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.aspect === aspectId)));
  }

  function setView(next) {
    view = next === "crop" ? "crop" : "adjust";
    sheet.querySelectorAll("[data-view]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.view === view)));
    sheet.querySelectorAll("[data-panel]").forEach((p) => { p.hidden = p.dataset.panel !== view; });
    sheet.querySelector(".img-crop").hidden = view !== "crop";
    drawPreview();
    if (view === "crop") placeCropBox();
  }

  // The preview. In Crop it shows the whole, unturned picture so the crop is
  // drawn on what it cuts; in Adjust it shows the result.
  let previewRect = { x: 0, y: 0, w: 0, h: 0 };

  function drawPreview() {
    if (!sheet || !sourceImage?.naturalWidth) return;
    const canvas = sheet.querySelector(".img-preview");
    const stage = sheet.querySelector(".img-stage");
    const ratio = window.devicePixelRatio || 1;
    const cssW = Math.max(200, stage.clientWidth);
    const cssH = Math.max(160, stage.clientHeight);
    canvas.width = Math.round(cssW * ratio);
    canvas.height = Math.round(cssH * ratio);
    canvas.style.width = cssW + "px";
    canvas.style.height = cssH + "px";
    const ctx = canvas.getContext("2d");
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    const pad = 16;
    const shown = view === "crop"
      ? { ...draft, crop: null, rotate: 0, flipX: false, flipY: false, straighten: 0 }
      : comparing ? {} : draft;
    const sw = sourceImage.naturalWidth;
    const sh = sourceImage.naturalHeight;
    const crop = shown.crop || { x: 0, y: 0, w: 1, h: 1 };
    let aspect = (sw * crop.w) / (sh * crop.h);
    const rot = ((shown.rotate || 0) % 360 + 360) % 360;
    if (rot === 90 || rot === 270) aspect = 1 / aspect;
    const availW = cssW - pad * 2;
    const availH = cssH - pad * 2;
    let w = availW;
    let h = w / aspect;
    if (h > availH) { h = availH; w = h * aspect; }
    const x = (cssW - w) / 2;
    const y = (cssH - h) / 2;
    previewRect = { x, y, w, h };
    if (editing?.path.tool === "youtube-frame" && view !== "crop") {
      const backdrop = draft.backdrop || "auto";
      if (backdrop !== "none") {
        ctx.fillStyle = backdrop === "paper" ? "#ffffff" : backdrop === "ink" ? "#111111"
          : (document.documentElement.dataset.theme === "light" ? "#e8e8eb" : "#12141b");
        ctx.fillRect(x, y, w, h);
      }
    }
    window.Inkyscib.MediaDraw.draw(ctx, sourceImage, x, y, w, h, shown);
    if (editing?.kind === "background" && !comparing && Number(draft.fade) > 0.001 && view !== "crop") {
      ctx.save();
      ctx.globalAlpha = Math.min(0.9, Number(draft.fade));
      ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--canvas-ground").trim() || "#0A0D12";
      ctx.fillRect(x, y, w, h);
      ctx.restore();
    }
  }

  // ---------- crop ----------

  let cropDrag = null;

  function cropRectPx() {
    const c = draft.crop || { x: 0, y: 0, w: 1, h: 1 };
    return {
      x: previewRect.x + c.x * previewRect.w,
      y: previewRect.y + c.y * previewRect.h,
      w: c.w * previewRect.w,
      h: c.h * previewRect.h
    };
  }

  function placeCropBox() {
    const el = sheet.querySelector(".img-crop-box");
    const r = cropRectPx();
    el.style.left = r.x + "px";
    el.style.top = r.y + "px";
    el.style.width = r.w + "px";
    el.style.height = r.h + "px";
  }

  function aspectRatio() {
    const a = ASPECTS.find((item) => item.id === aspectId);
    if (!a || !a.ratio) return null;
    if (a.ratio === "original") return sourceImage.naturalWidth / sourceImage.naturalHeight;
    return a.ratio;
  }

  // An aspect in pixels becomes a ratio of normalised width to height.
  function normalisedAspect() {
    const ratio = aspectRatio();
    if (!ratio) return null;
    return ratio * (sourceImage.naturalHeight / sourceImage.naturalWidth);
  }

  function setAspect(id) {
    aspectId = id;
    const na = normalisedAspect();
    if (na) {
      const c = draft.crop || { x: 0, y: 0, w: 1, h: 1 };
      const cx = c.x + c.w / 2;
      const cy = c.y + c.h / 2;
      let w = c.w;
      let h = w / na;
      if (h > c.h) { h = c.h; w = h * na; }
      if (h > 1) { h = 1; w = na; }
      if (w > 1) { w = 1; h = 1 / na; }
      draft.crop = {
        x: clamp(cx - w / 2, 0, 1 - w),
        y: clamp(cy - h / 2, 0, 1 - h),
        w,
        h
      };
    }
    syncSheet();
    placeCropBox();
  }

  function bindCrop() {
    const layer = sheet.querySelector(".img-crop");
    layer.addEventListener("pointerdown", (event) => {
      const boxEl = event.target.closest(".img-crop-box");
      if (!boxEl) return;
      event.preventDefault();
      layer.setPointerCapture?.(event.pointerId);
      cropDrag = {
        handle: event.target.dataset.h || "move",
        sx: event.clientX,
        sy: event.clientY,
        start: { ...(draft.crop || { x: 0, y: 0, w: 1, h: 1 }) }
      };
    });
    layer.addEventListener("pointermove", (event) => {
      if (!cropDrag) return;
      const dx = (event.clientX - cropDrag.sx) / previewRect.w;
      const dy = (event.clientY - cropDrag.sy) / previewRect.h;
      const s = cropDrag.start;
      const MIN = 0.06;
      let { x, y, w, h } = s;
      if (cropDrag.handle === "move") {
        x = clamp(s.x + dx, 0, 1 - s.w);
        y = clamp(s.y + dy, 0, 1 - s.h);
      } else {
        const hd = cropDrag.handle;
        let left = s.x;
        let top = s.y;
        let right = s.x + s.w;
        let bottom = s.y + s.h;
        if (hd.includes("w")) left = clamp(s.x + dx, 0, right - MIN);
        if (hd.includes("e")) right = clamp(right + dx, left + MIN, 1);
        if (hd.includes("n")) top = clamp(s.y + dy, 0, bottom - MIN);
        if (hd.includes("s")) bottom = clamp(bottom + dy, top + MIN, 1);
        const na = normalisedAspect();
        if (na) {
          // Keep the shape: the height follows the width, anchored opposite the corner.
          let nw = right - left;
          let nh = nw / na;
          if (hd.includes("n")) top = bottom - nh; else bottom = top + nh;
          if (top < 0 || bottom > 1) {
            nh = hd.includes("n") ? bottom : 1 - top;
            nw = nh * na;
            if (hd.includes("n")) top = bottom - nh; else bottom = top + nh;
            if (hd.includes("w")) left = right - nw; else right = left + nw;
          }
        }
        x = left; y = top; w = right - left; h = bottom - top;
      }
      draft.crop = { x, y, w, h };
      placeCropBox();
    });
    const end = () => {
      if (!cropDrag) return;
      cropDrag = null;
      const c = draft.crop;
      if (c && c.x <= 0.001 && c.y <= 0.001 && c.w >= 0.999 && c.h >= 0.999) draft.crop = null;
    };
    layer.addEventListener("pointerup", end);
    layer.addEventListener("pointercancel", end);
  }

  // ---------- open and close ----------

  let returnFocus = null;

  // target, when given, edits something that is not a selected picture (the
  // picture background): { kind, image, edit, apply(edit) }.
  function openSheet(target) {
    const found = target && target.image
      ? { path: { tool: "image", image: target.image, edit: target.edit || {} }, kind: target.kind, apply: target.apply }
      : selectedMedia();
    if (!found) return;
    if (!sheet) buildSheet();
    editing = found;
    comparing = false;
    draft = editOf(found.path);
    draftHideBadge = !!found.path.hideBadge;
    aspectId = "free";
    view = "adjust";
    returnFocus = document.activeElement;
    hideBar();
    sheet.hidden = false;
    document.body.classList.add("img-sheet-open");
    sourceImage = new Image();
    sourceImage.onload = () => { drawPreview(); if (view === "crop") placeCropBox(); };
    sourceImage.src = found.path.image;
    syncSheet();
    setView("adjust");
    sheet.querySelectorAll("[data-preset]").forEach((b) => b.setAttribute("aria-pressed", "false"));
    window.requestAnimationFrame(() => sheet.querySelector('[data-view="adjust"]')?.focus());
  }

  function closeSheet(apply) {
    if (!sheetOpen()) return;
    sheet.hidden = true;
    document.body.classList.remove("img-sheet-open");
    if (apply && editing) {
      const edit = { ...draft, crop: draft.crop ? { ...draft.crop } : null };
      Object.keys(edit).forEach((k) => {
        if (edit[k] === undefined || edit[k] === null || edit[k] === false) delete edit[k];
        else if (k in NEUTRAL && Math.abs(edit[k] - NEUTRAL[k]) < 0.005) delete edit[k];
      });
      if (typeof editing.apply === "function") {
        editing.apply(edit);
        editing = null;
        return;
      }
      const before = editOf(editing.path);
      const turned = (edit.rotate || 0) !== (before.rotate || 0);
      update((next) => {
        next.edit = edit;
        if (draftHideBadge) next.hideBadge = true; else delete next.hideBadge;
        if (turned || JSON.stringify(edit.crop || null) !== JSON.stringify(before.crop || null)) refit(next);
      });
    }
    editing = null;
    window.setTimeout(() => {
      syncBar(true);
      (bar && !bar.hidden ? bar.querySelector('[data-act="edit"]') : returnFocus)?.focus?.({ preventScroll: true });
    }, 0);
  }

  // ---------- wiring ----------

  // Escape cancels the sheet and nothing else. Taken at the window, before
  // the editor's own Escape handlers, which would also clear the selection
  // and leave the picture without its bar.
  window.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !sheetOpen()) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    closeSheet(false);
  }, true);

  document.addEventListener("selectionChanged", () => syncBar(true));
  document.addEventListener("toolChanged", () => window.setTimeout(() => syncBar(true), 0));
  window.addEventListener("resize", () => { if (bar && !bar.hidden) syncBar(true); });
  document.addEventListener("pointerdown", (event) => {
    if (more && !more.hidden && !more.contains(event.target) && !bar.contains(event.target)) setMore(false);
  }, true);
  // E opens the editor for the selected picture, like a desktop app.
  document.addEventListener("keydown", (event) => {
    if (sheetOpen() || event.ctrlKey || event.metaKey || event.altKey) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(event.target?.tagName || "") || event.target?.isContentEditable) return;
    if (event.key.toLowerCase() === "e" && selectedMedia()) {
      event.preventDefault();
      openSheet();
    }
  });

  window.Inkyscib = window.Inkyscib || {};
  window.Inkyscib.ImageTools = {
    actions,
    open: openSheet,
    close: closeSheet,
    isOpen: sheetOpen,
    sync: () => syncBar(true),
    barVisible: () => !!bar && !bar.hidden,
    applyPreset: (id) => { if (sheetOpen()) applyPreset(id); },
    setDraft: (values) => { if (sheetOpen()) { Object.assign(draft, values); syncSheet(); drawPreview(); } },
    setView: (v) => { if (sheetOpen()) setView(v); },
    setAspect: (id) => { if (sheetOpen()) setAspect(id); }
  };
})();
