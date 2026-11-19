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
    delete look.offsetX;
    delete look.offsetY;
    delete look.zoom;
    const W = canvas.width;
    const H = canvas.height;
    const a = aspect(edit);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const fit = edit.fit || "cover";
    // Where it was placed with Move: a shift as a share of the window, and a
    // scale on top of the fit.
    const zoom = Math.max(0.2, Math.min(6, Number(edit.zoom) || 1));
    const dx = (Number(edit.offsetX) || 0) * W;
    const dy = (Number(edit.offsetY) || 0) * H;
    if (fit === "tile") {
      const ratio = window.devicePixelRatio || 1;
      const th = Math.min(H, 360 * ratio) * zoom;
      const tw = th * a;
      const x0 = (((dx % tw) + tw) % tw) - tw;
      const y0 = (((dy % th) + th) % th) - th;
      for (let y = y0; y < H; y += th) {
        for (let x = x0; x < W; x += tw) window.Inkyscib.MediaDraw.draw(ctx, picture.image, x, y, tw, th, look);
      }
    } else {
      const s = (fit === "contain" ? Math.min(W / a, H) : Math.max(W / a, H)) * zoom;
      const h = s;
      const w = s * a;
      window.Inkyscib.MediaDraw.draw(ctx, picture.image, (W - w) / 2 + dx, (H - h) / 2 + dy, w, h, look);
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

  // ---------- Move: placing the picture against the grid ----------
  //
  // A mode over the canvas: drag to slide the picture, the wheel or a pinch to
  // scale it, with the grid drawn on top meanwhile so it can be lined up.
  // Nothing on the page is touched while it is on.

  let mover = null;

  function snapshot(pointers) {
    return {
      pts: new Map(pointers),
      offsetX: Number(picture.edit.offsetX) || 0,
      offsetY: Number(picture.edit.offsetY) || 0,
      zoom: Number(picture.edit.zoom) || 1
    };
  }

  function startMove() {
    if (!picture || mover) return;
    document.getElementById("canvasThemePop")?.setAttribute("hidden", "");
    const before = { ...picture.edit };
    const wasGrid = !!picture.edit.grid;
    picture.edit = { ...picture.edit, grid: true };
    refresh();
    mover = document.createElement("div");
    mover.className = "canvas-picture-mover";
    mover.id = "canvasPictureMover";
    mover.dataset.iconSet = "lucide";
    mover.innerHTML =
      '<div class="canvas-picture-mover-bar" role="toolbar" aria-label="Place the picture">' +
      icon("lucide:move") + "<span>Drag to place the picture. Scroll or pinch to size it.</span>" +
      '<button type="button" data-move="reset">Reset</button>' +
      '<button type="button" data-move="cancel">Cancel</button>' +
      '<button type="button" class="is-primary" data-move="done">' + icon("lucide:check") + "<span>Done</span></button>" +
      "</div>";
    document.body.appendChild(mover);
    const pointers = new Map();
    let start = null;
    const apply = (next) => {
      picture.edit = { ...picture.edit, ...next };
      window.invalidateCanvasBackground?.();
      window.render?.();
    };
    const onKey = (event) => {
      if (event.key === "Escape") { event.stopPropagation(); finish(false); }
      else if (event.key === "Enter") { event.stopPropagation(); finish(true); }
    };
    const finish = (keep) => {
      picture.edit = keep ? { ...picture.edit, grid: wasGrid } : before;
      mover.remove();
      mover = null;
      document.removeEventListener("keydown", onKey, true);
      refresh();
      if (keep) store({ src: picture.src, edit: picture.edit }).catch(() => {});
    };
    document.addEventListener("keydown", onKey, true);
    mover.addEventListener("click", (event) => {
      const act = event.target.closest("[data-move]")?.dataset.move;
      if (act === "done") finish(true);
      else if (act === "cancel") finish(false);
      else if (act === "reset") apply({ offsetX: 0, offsetY: 0, zoom: 1 });
    });
    mover.addEventListener("pointerdown", (event) => {
      if (event.target.closest(".canvas-picture-mover-bar")) return;
      event.preventDefault();
      mover.setPointerCapture?.(event.pointerId);
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      start = snapshot(pointers);
    });
    mover.addEventListener("pointermove", (event) => {
      if (!pointers.has(event.pointerId) || !start) return;
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      const now = [...pointers.values()];
      const was = [...start.pts.values()];
      if (now.length !== was.length) return;
      const mid = (list) => ({
        x: list.reduce((t, q) => t + q.x, 0) / list.length,
        y: list.reduce((t, q) => t + q.y, 0) / list.length
      });
      const a = mid(now);
      const b = mid(was);
      const next = {
        offsetX: start.offsetX + (a.x - b.x) / window.innerWidth,
        offsetY: start.offsetY + (a.y - b.y) / window.innerHeight
      };
      if (now.length >= 2) {
        const spread = (list) => Math.hypot(list[0].x - list[1].x, list[0].y - list[1].y) || 1;
        next.zoom = Math.max(0.2, Math.min(6, start.zoom * spread(now) / spread(was)));
      }
      apply(next);
    });
    const lift = (event) => {
      pointers.delete(event.pointerId);
      start = pointers.size ? snapshot(pointers) : null;
    };
    mover.addEventListener("pointerup", lift);
    mover.addEventListener("pointercancel", lift);
    mover.addEventListener("wheel", (event) => {
      event.preventDefault();
      const zoom = Math.max(0.2, Math.min(6, (Number(picture.edit.zoom) || 1) * Math.exp(-event.deltaY * 0.0015)));
      apply({ zoom });
    }, { passive: false });
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
      `<button type="button" class="canvas-picture-btn" data-picture="move">${icon("lucide:move")}<span>Move</span></button>` +
      `<button type="button" class="canvas-picture-btn" data-picture="remove" aria-label="Remove the picture">${icon("lucide:trash")}</button>` +
      "</div>";
    slot.addEventListener("click", (event) => {
      const button = event.target.closest("[data-picture]");
      if (!button) return;
      const act = button.dataset.picture;
      if (act === "choose") choose();
      else if (act === "edit") edit();
      else if (act === "move") startMove();
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
    slot.querySelector('[data-picture="move"]').hidden = !has;
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
    move: startMove,
    moving: () => !!mover,
    remove,
    use: (src, editValue) => use(src, editValue || { fit: "cover" }),
    get: () => (picture ? { src: picture.src, edit: { ...picture.edit } } : null)
  };
})();
