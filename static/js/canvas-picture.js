// A picture of your own as the canvas background.
//
// Chosen from the device in the Canvas popover (beside the theme and the
// grid), kept in this browser's IndexedDB and nowhere else, and drawn behind
// the page like wallpaper: it stays put while the page pans and zooms. It is
// edited in the same sheet as pictures on the page (image-tools.js), with
// three extras that only make sense for a background: Fill, Fit or Tile; Fade,
// which washes it toward the canvas colour so ink stays readable over it; and
// whether the grid is drawn over it.
//
// The background layer is its own canvas and is redrawn only when the view,
// the theme or this picture changes, never per pen sample, and every edit
// that needs pixels is baked once (image-process.js).
(function () {
  "use strict";

  const DB_NAME = "inkyscib_background";
  const STORE = "picture";
  const KEY = "current";
  const MAX_SIDE = 2560;

  let picture = null; // { image: HTMLImageElement, src: dataURL, edit: {} }
  let slot = null;

  const icon = (ref) => {
    try { return window.Inkyscib?.Icon?.svg?.(ref) || ""; } catch (_) { return ""; }
  };
  const notify = (message, tone) => window.Inkyscib?.notify?.(message, { tone: tone || "success" });

  // ---------- storage ----------

  function db() {
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) return reject(new Error("no IndexedDB"));
      const open = indexedDB.open(DB_NAME, 1);
      open.onupgradeneeded = () => open.result.createObjectStore(STORE);
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
  }

  async function store(value) {
    const conn = await db();
    await new Promise((resolve, reject) => {
      const tx = conn.transaction(STORE, "readwrite");
      if (value) tx.objectStore(STORE).put(value, KEY);
      else tx.objectStore(STORE).delete(KEY);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    conn.close();
  }

  async function load() {
    try {
      const conn = await db();
      const value = await new Promise((resolve, reject) => {
        const req = conn.transaction(STORE, "readonly").objectStore(STORE).get(KEY);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
      });
      conn.close();
      if (value && typeof value.src === "string") await use(value.src, value.edit || {}, false);
    } catch (_) {
      /* private window or storage blocked: no picture, nothing breaks */
    }
  }

  function use(src, edit, persist = true) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => {
        picture = { image, src, edit: edit || {} };
        refresh();
        if (persist) store({ src, edit: picture.edit }).catch(() => notify("The picture is shown, but this browser would not keep it.", "error"));
        resolve();
      };
      image.onerror = () => reject(new Error("That picture could not be read."));
      image.src = src;
    });
  }

  function refresh() {
    window.invalidateCanvasBackground?.();
    window.render?.();
    syncSlot();
  }

  // ---------- choosing ----------

  function choose() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (!file) return;
      if (!/^image\//.test(file.type)) return notify("That file is not a picture.", "error");
      const reader = new FileReader();
      reader.onload = () => shrink(String(reader.result))
        .then((src) => use(src, { fit: "cover", fade: 0.25 }))
        .then(() => edit())
        .catch((error) => notify(error.message || "That picture could not be used.", "error"));
      reader.readAsDataURL(file);
    });
    input.click();
  }

  // A phone photo is 12 megapixels; a background needs the screen's worth.
  function shrink(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const k = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
        if (k === 1 && src.length < 3e6) return resolve(src);
        const c = document.createElement("canvas");
        c.width = Math.max(1, Math.round(img.naturalWidth * k));
        c.height = Math.max(1, Math.round(img.naturalHeight * k));
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL("image/jpeg", 0.9));
      };
      img.onerror = () => reject(new Error("That picture could not be read."));
      img.src = src;
    });
  }

  function edit() {
    if (!picture) return;
    window.Inkyscib?.ImageTools?.open?.({
      kind: "background",
      image: picture.src,
      edit: picture.edit,
      apply: (next) => {
        picture.edit = next;
        refresh();
        store({ src: picture.src, edit: next }).catch(() => {});
      }
    });
  }

  function remove() {
    picture = null;
    store(null).catch(() => {});
    refresh();
  }

  // ---------- drawing ----------

  // The edited picture's own width over height: the crop, turned.
  function aspect(edit) {
    const w = picture.image.naturalWidth * (edit.crop?.w || 1);
    const h = picture.image.naturalHeight * (edit.crop?.h || 1);
    const rot = (((edit.rotate || 0) % 360) + 360) % 360;
    return rot === 90 || rot === 270 ? h / w : w / h;
  }

  function draw(ctx, canvas) {
    if (!picture || !window.Inkyscib?.MediaDraw) return false;
    const edit = picture.edit || {};
    const look = { ...edit };
    delete look.fit;
    delete look.fade;
    delete look.grid;
    const W = canvas.width;
    const H = canvas.height;
    const a = aspect(edit);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const fit = edit.fit || "cover";
    if (fit === "tile") {
      const ratio = window.devicePixelRatio || 1;
      const th = Math.min(H, 360 * ratio);
      const tw = th * a;
      for (let y = 0; y < H; y += th) {
        for (let x = 0; x < W; x += tw) window.Inkyscib.MediaDraw.draw(ctx, picture.image, x, y, tw, th, look);
      }
    } else {
      const s = fit === "contain" ? Math.min(W / a, H) : Math.max(W / a, H);
      const h = s;
      const w = s * a;
      window.Inkyscib.MediaDraw.draw(ctx, picture.image, (W - w) / 2, (H - h) / 2, w, h, look);
    }
    const fade = Math.max(0, Math.min(0.9, Number(edit.fade) || 0));
    if (fade > 0.001) {
      ctx.globalAlpha = fade;
      ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--canvas-ground").trim() || "#0A0D12";
      ctx.fillRect(0, 0, W, H);
    }
    ctx.restore();
    return true;
  }

  // ---------- the popover row ----------

  function mount(target) {
    slot = target;
    if (!slot) return;
    slot.innerHTML =
      '<p class="canvas-theme-heading" id="canvasPictureHeading">Picture</p>' +
      '<div class="canvas-picture-row" data-icon-set="lucide" role="group" aria-labelledby="canvasPictureHeading">' +
      '<span class="canvas-picture-thumb" aria-hidden="true"></span>' +
      `<button type="button" class="canvas-picture-btn" data-picture="choose">${icon("lucide:image")}<span>Use a picture</span></button>` +
      `<button type="button" class="canvas-picture-btn" data-picture="edit">${icon("lucide:sliders-horizontal")}<span>Edit</span></button>` +
      `<button type="button" class="canvas-picture-btn" data-picture="remove" aria-label="Remove the picture">${icon("lucide:trash")}</button>` +
      "</div>";
    slot.addEventListener("click", (event) => {
      const button = event.target.closest("[data-picture]");
      if (!button) return;
      const act = button.dataset.picture;
      if (act === "choose") choose();
      else if (act === "edit") edit();
      else if (act === "remove") remove();
    });
    syncSlot();
  }

  function syncSlot() {
    if (!slot) return;
    const has = !!picture;
    const thumb = slot.querySelector(".canvas-picture-thumb");
    thumb.hidden = !has;
    thumb.style.backgroundImage = has ? `url("${picture.src}")` : "";
    slot.querySelector('[data-picture="choose"] span').textContent = has ? "Change" : "Use a picture";
    slot.querySelector('[data-picture="edit"]').hidden = !has;
    slot.querySelector('[data-picture="remove"]').hidden = !has;
  }

  document.addEventListener("inkyscib:canvas-pop-built", (event) => mount(event.detail?.pop?.querySelector(".canvas-picture-slot")));
  const ready = () => {
    const existing = document.querySelector("#canvasThemePop .canvas-picture-slot");
    if (existing && !slot) mount(existing);
    load();
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", ready, { once: true });
  else ready();

  window.Inkyscib = window.Inkyscib || {};
  window.Inkyscib.CanvasPicture = {
    active: () => !!picture,
    showGrid: () => !!picture?.edit?.grid,
    draw,
    choose,
    edit,
    remove,
    use: (src, editValue) => use(src, editValue || { fit: "cover" }),
    get: () => (picture ? { src: picture.src, edit: { ...picture.edit } } : null)
  };
})();
