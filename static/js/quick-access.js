// Quick access: hide the tool rail, and the hold ring.
//
// 1. A button in the File ribbon hides the left tool rail completely (on a
//    tablet, the tool row) and brings it back. The choice is remembered.
//
// 2. Press and hold still on the canvas for two seconds and a ring of the
//    most used features opens around the pointer. The eight were chosen by an
//    LLM council (docs/council/): Pen, Pen colour, Line, Eraser, Select, Pan,
//    Redo, Undo, clockwise from the top. Its rules are the council's too:
//      - a progress arc fills from the first moment, so the hold is visible
//        and never looks broken;
//      - only a still press counts: moving more than ~10px (12 on touch), a
//        second finger, or lifting cancels it, so pausing mid-stroke or a
//        resting palm while writing never opens it;
//      - the stroke the press began is discarded, so no dot is left behind;
//      - every slice is labelled; drag onto one and lift, or tap it;
//      - Esc, a tap outside or a lift in the centre dismisses it.
//    The eraser (whose hold is its lasso) and the compass (whose hold picks
//    an arc back up) keep their own long press.
(() => {
  "use strict";

  const HOLD_MS = 700;
  const SHOW_ARC_MS = 200;
  // Past this distance from the centre, the direction of the pointer picks
  // the slice, so a short slide toward a tool is enough.
  const DEAD_ZONE = 30;
  const RAIL_KEY = "inkyscib-rail-hidden";
  const NO_RING_TOOLS = new Set(["eraser", "compass"]);
  const icon = (ref) => {
    try { return window.Inkyscib?.Icon?.svg?.(ref) || ""; } catch (_) { return ""; }
  };
  const state = () => window.appState;

  // ---------- 1. the rail toggle ----------

  function railHidden() {
    return document.body.classList.contains("rail-hidden");
  }

  function setRailHidden(hidden, persist = true) {
    document.body.classList.toggle("rail-hidden", !!hidden);
    const button = document.getElementById("ribbonRailToggle");
    if (button) {
      button.setAttribute("aria-pressed", String(!!hidden));
      button.title = hidden ? "Show the tools" : "Hide the tools";
      button.setAttribute("aria-label", button.title);
      button.innerHTML = hidden ? icon("lucide:panel-left-open") : icon("lucide:panel-left-close");
    }
    if (persist) {
      try { localStorage.setItem(RAIL_KEY, hidden ? "1" : "0"); } catch (_) { /* storage blocked */ }
    }
    // The dock and the canvas edge follow the rail; let the chrome re-measure.
    window.dispatchEvent(new Event("resize"));
  }

  function mountRailToggle() {
    const ribbon = document.querySelector(".file-ribbon");
    if (!ribbon || document.getElementById("ribbonRailToggle")) return !!ribbon;
    const button = document.createElement("button");
    button.type = "button";
    button.id = "ribbonRailToggle";
    button.className = "file-ribbon-railtoggle";
    button.dataset.iconSet = "lucide";
    const home = ribbon.querySelector(".file-ribbon-home");
    if (home) home.after(button);
    else ribbon.prepend(button);
    button.addEventListener("click", () => setRailHidden(!railHidden()));
    let saved = false;
    try { saved = localStorage.getItem(RAIL_KEY) === "1"; } catch (_) { /* storage blocked */ }
    setRailHidden(saved, false);
    return true;
  }

  // ---------- 2. the hold ring ----------

  const SLICES = [
    { id: "pen", label: "Pen", icon: "lucide:pen-line", run: () => window.setTool?.("pen") },
    { id: "colour", label: "Colour", icon: "lucide:palette", run: () => openColours() },
    { id: "line", label: "Line", icon: "lucide:slash", run: () => window.setTool?.("line") },
    { id: "eraser", label: "Eraser", icon: "lucide:eraser", run: () => window.setTool?.("eraser") },
    { id: "select", label: "Select", icon: "lucide:mouse-pointer-2", run: () => window.setTool?.("select") },
    { id: "pan", label: "Pan", icon: "lucide:hand", run: () => window.setPanMode?.(true) },
    { id: "redo", label: "Redo", icon: "lucide:redo-2", run: () => window.redo?.() },
    { id: "undo", label: "Undo", icon: "lucide:undo-2", run: () => window.undo?.() }
  ];

  // The MAETHIST mark at the centre, taken from the page's own footer logo so
  // the path comes from Flask's url_for, not a guess.
  const MARK = document.querySelector("img.footer-mark")?.getAttribute("src") || "/static/img/maethist-mark.png";

  let ring = null;
  let hold = null;
  let open = null;

  function build() {
    ring = document.createElement("div");
    ring.className = "qa-ring";
    ring.id = "quickRing";
    ring.dataset.iconSet = "lucide";
    ring.hidden = true;
    ring.setAttribute("role", "menu");
    ring.setAttribute("aria-label", "Quick tools");
    ring.innerHTML = `
      <svg class="qa-progress" viewBox="0 0 120 120" aria-hidden="true"><circle cx="60" cy="60" r="52" pathLength="1"/></svg>
      <div class="qa-hub" aria-hidden="true"><img class="qa-mark" src="${MARK}" alt="" width="34" height="34" decoding="async"></div>
      <div class="qa-slices"></div>`;
    document.body.appendChild(ring);
    ring.addEventListener("pointerdown", (event) => {
      event.stopPropagation();
      const slice = event.target.closest("[data-slice]");
      if (!slice && !event.target.closest(".qa-hub")) close();
    });
    ring.addEventListener("click", (event) => {
      const slice = event.target.closest("[data-slice]");
      if (slice) choose(slice.dataset.slice);
    });
  }

  function renderSlices(items) {
    const host = ring.querySelector(".qa-slices");
    host.innerHTML = items.map((item, index) => {
      const angle = (index / items.length) * Math.PI * 2 - Math.PI / 2;
      const x = Math.cos(angle) * 96;
      const y = Math.sin(angle) * 96;
      // Arcs (DESIGN.md): each slice sweeps out along a curve, through a point
      // turned back 40 degrees at 55% of its reach, rather than in a line.
      const back = angle - 0.7;
      const ax = Math.cos(back) * 96 * 0.55;
      const ay = Math.sin(back) * 96 * 0.55;
      const swatch = item.color ? `<span class="qa-swatch" style="background:${item.color}"></span>` : icon(item.icon);
      return `<button type="button" role="menuitem" class="qa-slice${item.active ? " is-active" : ""}" data-slice="${item.id}"
        style="--x:${x.toFixed(1)}px; --y:${y.toFixed(1)}px; --ax:${ax.toFixed(1)}px; --ay:${ay.toFixed(1)}px; --i:${index}" aria-label="${item.label}">
        ${swatch}<span class="qa-label">${item.label}</span></button>`;
    }).join("");
  }

  function currentItems() {
    const tool = state()?.currentTool;
    return SLICES.map((s) => ({ ...s, active: !state()?.panMode && s.id === tool || (s.id === "pan" && state()?.panMode) }));
  }

  function colourItems() {
    const swatches = [...document.querySelectorAll("#penOptions .color-swatch[data-color]")].slice(0, 7);
    const current = state()?.toolSettings?.pen?.color;
    const items = swatches.map((el, i) => ({
      id: "c" + i,
      label: ["Black", "Cyan", "Red", "Green", "Yellow", "White", "Colour"][i] || "Colour",
      color: el.dataset.color,
      active: el.dataset.color === current,
      run: () => {
        window.setTool?.("pen");
        el.click();
      }
    }));
    items.push({ id: "back", label: "Back", icon: "lucide:arrow-left", run: () => { renderSlices(currentItems()); open.items = currentItems(); return "stay"; } });
    return items;
  }

  function openColours() {
    open.items = colourItems();
    renderSlices(open.items);
    return "stay";
  }

  function place(x, y) {
    const r = 150;
    const cx = Math.max(r, Math.min(window.innerWidth - r, x));
    const cy = Math.max(r, Math.min(window.innerHeight - r, y));
    ring.style.left = cx + "px";
    ring.style.top = cy + "px";
    return { cx, cy };
  }

  function startHold(event) {
    const s = state();
    if (!s || event.button > 0 || !event.isPrimary) return;
    if (NO_RING_TOOLS.has(s.currentTool)) return;
    if (!ring) build();
    cancelHold();
    hold = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      slop: event.pointerType === "touch" ? 12 : 10,
      timer: window.setTimeout(fire, HOLD_MS),
      shown: window.setTimeout(() => {
        if (!hold) return;
        place(hold.x, hold.y);
        ring.hidden = false;
        ring.classList.add("is-charging");
        ring.classList.remove("is-open");
      }, SHOW_ARC_MS)
    };
  }

  function cancelHold() {
    if (!hold) return;
    window.clearTimeout(hold.timer);
    window.clearTimeout(hold.shown);
    hold = null;
    if (ring && !open) {
      ring.hidden = true;
      ring.classList.remove("is-charging");
    }
  }

  function fire() {
    if (!hold) return;
    const at = { x: hold.x, y: hold.y, id: hold.id };
    hold = null;
    // The press began a stroke; it is not one, so it leaves nothing behind.
    const s = state();
    if (s) {
      s.isDrawing = false;
      s.currentPath = null;
      s.isPanning = false;
    }
    if (typeof window.invalidateCanvasDrawingCache === "function") window.invalidateCanvasDrawingCache();
    if (typeof window.render === "function") window.render();
    window.clearTimeout(closeTimer);
    ring.classList.remove("is-closing");
    open = { pointerId: at.id, items: currentItems(), lifted: false };
    renderSlices(open.items);
    Object.assign(open, place(at.x, at.y));
    ring.hidden = false;
    ring.classList.remove("is-charging");
    ring.classList.add("is-open");
    if (navigator.vibrate) {
      try { navigator.vibrate(15); } catch (_) { /* not allowed */ }
    }
  }

  // The slice under the pointer, or else the one it points toward from the
  // centre: sliding a little in a tool's direction picks it.
  function sliceAt(x, y) {
    const el = document.elementFromPoint(x, y);
    const hit = el ? el.closest?.("#quickRing [data-slice]") : null;
    if (!open || open.cx == null) return hit;
    const dx = x - open.cx;
    const dy = y - open.cy;
    const dist = Math.hypot(dx, dy);
    // Direction decides past the dead zone: while the slices are still
    // sweeping out along their arcs, the one under the pointer is not
    // always the one it points toward.
    if (dist < DEAD_ZONE || dist > 220) return hit;
    const slices = ring.querySelectorAll("[data-slice]");
    const n = slices.length;
    const turn = (Math.atan2(dy, dx) + Math.PI / 2 + Math.PI * 2) % (Math.PI * 2);
    return slices[Math.round(turn / (Math.PI * 2 / n)) % n] || null;
  }

  function choose(id) {
    if (!open) return;
    const item = open.items.find((it) => it.id === id);
    if (!item) return;
    const result = item.run();
    if (result !== "stay") close();
  }

  // Interruptible motion (DESIGN.md): closing pulls the slices back in over
  // 140ms instead of vanishing, and a ring opened again meanwhile simply
  // takes over from wherever they are.
  let closeTimer = 0;
  function close() {
    open = null;
    if (!ring) return;
    ring.classList.remove("is-charging");
    if (ring.hidden || !ring.classList.contains("is-open")) {
      ring.classList.remove("is-open");
      ring.hidden = true;
      return;
    }
    ring.classList.remove("is-open");
    ring.classList.add("is-closing");
    window.clearTimeout(closeTimer);
    closeTimer = window.setTimeout(() => {
      ring.classList.remove("is-closing");
      if (!open) ring.hidden = true;
    }, 150);
  }

  // Capture phase, ahead of the canvas's own handlers, which never see the
  // pointer once the ring has it.
  document.addEventListener("pointerdown", (event) => {
    if (open) {
      // A press anywhere off the ring closes it, and draws nothing.
      if (!event.target?.closest?.("#quickRing")) {
        event.stopPropagation();
        event.preventDefault();
        swallow = event.pointerId;
        close();
      }
      return;
    }
    if (event.target?.id === "drawingCanvas") startHold(event);
  }, true);
  // The rest of the press that closed the ring belongs to nobody.
  let swallow = null;
  for (const type of ["pointermove", "pointerup", "pointercancel"]) {
    document.addEventListener(type, (event) => {
      if (swallow === null || event.pointerId !== swallow) return;
      event.stopPropagation();
      event.preventDefault();
      if (type !== "pointermove") swallow = null;
    }, true);
  }

  document.addEventListener("pointermove", (event) => {
    if (hold && event.pointerId === hold.id) {
      if (Math.hypot(event.clientX - hold.x, event.clientY - hold.y) > hold.slop) cancelHold();
      return;
    }
    if (open && event.pointerId === open.pointerId && !open.lifted) {
      event.stopPropagation();
      event.preventDefault();
      const slice = sliceAt(event.clientX, event.clientY);
      ring.querySelectorAll("[data-slice]").forEach((b) => b.classList.toggle("is-hover", b === slice));
    }
  }, true);

  document.addEventListener("pointerdown", (event) => {
    // A second finger means a pinch or a pan, not a hold.
    if (hold && event.pointerId !== hold.id) cancelHold();
  }, true);

  const lift = (event) => {
    if (hold && event.pointerId === hold.id) cancelHold();
    if (open && event.pointerId === open.pointerId && !open.lifted) {
      open.lifted = true;
      event.stopPropagation();
      event.preventDefault();
      const slice = sliceAt(event.clientX, event.clientY);
      if (slice) choose(slice.dataset.slice);
      // Otherwise the ring stays open for a tap; outside or Esc closes it.
    }
  };
  document.addEventListener("pointerup", lift, true);
  document.addEventListener("pointercancel", (event) => {
    if (hold && event.pointerId === hold.id) cancelHold();
  }, true);

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && open) {
      event.stopPropagation();
      close();
    }
  }, true);
  document.addEventListener("toolChanged", () => cancelHold());

  // ---------- start ----------

  function start() {
    if (!mountRailToggle()) {
      // The ribbon is built on DOMContentLoaded by file-ribbon.js; wait for it.
      let tries = 0;
      const wait = window.setInterval(() => {
        tries += 1;
        if (mountRailToggle() || tries > 40) window.clearInterval(wait);
      }, 100);
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();

  window.Inkyscib = window.Inkyscib || {};
  window.Inkyscib.QuickAccess = {
    setRailHidden,
    railHidden,
    ringOpen: () => !!open,
    openRingAt: (x, y) => { if (!ring) build(); hold = { x, y, id: -1, slop: 10, timer: 0, shown: 0 }; fire(); },
    choose,
    close,
    HOLD_MS,
    SLICES: SLICES.map((s) => s.id)
  };
})();
