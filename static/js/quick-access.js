// Quick access: hide the tool rail, and the hold ring.
//
// 1. A button in the File ribbon hides the left tool rail completely (on a
//    tablet, the tool row) and brings it back. The choice is remembered.
//
// 2. Press and hold still on the canvas (0.45s) and a ring of the
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

  // 2.8.3: 0.7s felt slow. 0.45s is still well past a tap or a dot, and the
  // charge shows from 80ms, so the hold is visible almost at once.
  const HOLD_MS = 450;
  const SHOW_ARC_MS = 80;
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

  // The HUD pieces, as SVG: drawn once, then the compositor only turns or
  // scales them (quick-access.css says why).
  const C = 'viewBox="-1 -1 2 2"';
  function rays() {
    let out = "";
    for (let i = 0; i < 28; i++) {
      const a = (i / 28) * Math.PI * 2 + (i % 2 ? 0.05 : 0);
      const r0 = 0.36 + (i % 3) * 0.04;
      const r1 = r0 + 0.22 + ((i * 7) % 5) * 0.05;
      const w = i % 4 === 0 ? 0.012 : 0.006;
      out += `<line class="qa-ray${i % 3 === 0 ? " is-white" : ""}" stroke-width="${w}" x1="${(Math.cos(a) * r0).toFixed(3)}" y1="${(Math.sin(a) * r0).toFixed(3)}" x2="${(Math.cos(a) * r1).toFixed(3)}" y2="${(Math.sin(a) * r1).toFixed(3)}"/>`;
    }
    return `<svg ${C}>${out}</svg>`;
  }
  const HUD = {
    burst: () => rays(),
    plate: `<svg class="qa-ticks" viewBox="-140 -140 280 280"><circle class="qa-tick-fine" r="131" pathLength="360"/><circle class="qa-tick-long" r="131" pathLength="360"/></svg>
      <svg class="qa-sheen" viewBox="-140 -140 280 280"><defs><linearGradient id="qaSheenGrad" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="#ffffff" stop-opacity="0"/><stop offset="0.6" stop-color="#ffffff"/><stop offset="1" stop-color="#5CC8FF"/></linearGradient></defs>
        <circle r="138" pathLength="360"/></svg>`,
    orbit: `<svg class="qa-orbit-a" viewBox="-156 -156 312 312"><circle class="qa-arc-a" r="153" pathLength="360"/><circle class="qa-arc-b" r="153" pathLength="360"/></svg>
      <svg class="qa-orbit-b" viewBox="-156 -156 312 312"><circle class="qa-track-b" r="144" pathLength="360"/><circle class="qa-sat" cx="0" cy="-144" r="3.5"/></svg>`,
    hub: `<svg class="qa-hub-ring" viewBox="-40 -40 80 80"><circle class="qa-seg-lock" r="37" pathLength="360"/><circle class="qa-seg-hud" r="37" pathLength="360"/></svg>`
  };

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
      <div class="qa-burst" aria-hidden="true">${HUD.burst()}</div>
      <div class="qa-plate" aria-hidden="true">${HUD.plate}</div>
      <div class="qa-orbit" aria-hidden="true">${HUD.orbit}</div>
      <div class="qa-charge" aria-hidden="true">
        <svg class="qa-progress" viewBox="0 0 100 100"><defs><linearGradient id="qaChargeGrad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#5CC8FF"/><stop offset="0.55" stop-color="#A78BFA"/><stop offset="1" stop-color="#FFD23F"/></linearGradient></defs>
          <circle class="qa-track" cx="50" cy="50" r="46"/>
          <circle class="qa-fill" cx="50" cy="50" r="40" pathLength="1"/></svg>
        <div class="qa-brackets">${[0, 90, 180, 270].map((r) => `<i class="qa-bracket" style="--r:${r}deg"></i>`).join("")}</div>
      </div>
      <div class="qa-hub" aria-hidden="true">${HUD.hub}<img class="qa-mark" src="${MARK}" alt="" width="34" height="34" decoding="async"></div>
      <div class="qa-slices"></div>
      <div class="qa-readout" aria-hidden="true"><span class="qa-readout-k">In hand</span><span class="qa-readout-v"></span></div>`;
    ring.style.setProperty("--qa-charge-ms", (HOLD_MS - SHOW_ARC_MS) + "ms");
    document.body.appendChild(ring);
    ring.addEventListener("pointerdown", (event) => {
      event.stopPropagation();
      const slice = event.target.closest("[data-slice]");
      if (!slice && !event.target.closest(".qa-hub")) close();
    });
    ring.addEventListener("pointerover", (event) => {
      // A pointer other than the one that opened the ring (a mouse after a
      // tap, a second pass) lights what it is over. :hover is not used: it
      // stuck to whichever slice swept under a still cursor during the pop.
      if (!open || (event.pointerId === open.pointerId && !open.lifted)) return;
      const slice = event.target.closest("[data-slice]");
      ring.querySelectorAll("[data-slice]").forEach((b) => b.classList.toggle("is-hover", b === slice));
      aimAt(slice);
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
      // Arcs (DESIGN.md): the CSS swings each slice out from 55 degrees back
      // along the circle (--a is its angle), rather than in a line.
      const a = (angle * 180) / Math.PI;
      const swatch = item.color ? `<span class="qa-swatch" style="background:${item.color}"></span>` : icon(item.icon);
      return `<button type="button" role="menuitem" class="qa-slice${item.active ? " is-active" : ""}" data-slice="${item.id}"
        style="--x:${x.toFixed(1)}px; --y:${y.toFixed(1)}px; --a:${a.toFixed(1)}deg; --i:${index}" aria-label="${item.label}">
        ${swatch}<span class="qa-label">${item.label}</span></button>`;
    }).join("");
  }

  // The readout names the slice pointed at; with nothing pointed at, the
  // tool in hand. (2.8.4: the needle that also swung to it is gone, by request.)
  function aimAt(slice) {
    if (!ring) return;
    const readK = ring.querySelector(".qa-readout-k");
    const readV = ring.querySelector(".qa-readout-v");
    if (slice) {
      if (readK) readK.textContent = "Pick";
      if (readV) readV.textContent = slice.getAttribute("aria-label") || "";
    } else {
      const inHand = open?.items?.find((it) => it.active);
      if (readK) readK.textContent = "In hand";
      if (readV) readV.textContent = inHand ? inHand.label : "Quick tools";
    }
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
    ring.classList.remove("is-settled");
    window.clearTimeout(settleTimer);
    settleTimer = window.setTimeout(() => { if (open) ring.classList.add("is-settled"); }, 420);
    return "stay";
  }

  function place(x, y) {
    const r = 160;
    const cx = Math.max(r, Math.min(window.innerWidth - r, x));
    const cy = Math.max(r, Math.min(window.innerHeight - 186, y));
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
        ring.classList.remove("is-open", "is-closing", "is-settled");
        ring.hidden = false;
        ring.classList.add("is-charging");
        if (!open) {
          hold.items = currentItems();
          renderSlices(hold.items);
        }
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

  // Throwing away the press's dot means a canvas redraw. Done in the same
  // task as the opening, it held up the pop's first frames; one frame later
  // the dot hides under the hub for 16ms and nobody sees it.
  function discardPressStroke() {
    window.requestAnimationFrame(() => {
      if (typeof window.invalidateCanvasDrawingCache === "function") window.invalidateCanvasDrawingCache();
      if (typeof window.render === "function") window.render();
    });
  }

  function fire() {
    if (!hold) return;
    const at = { x: hold.x, y: hold.y, id: hold.id };
    const drawn = hold.items;
    hold = null;
    // The press began a stroke; it is not one, so it leaves nothing behind.
    const s = state();
    if (s) {
      s.isDrawing = false;
      s.currentPath = null;
      s.isPanning = false;
    }
    discardPressStroke();
    window.clearTimeout(closeTimer);
    window.clearTimeout(settleTimer);
    ring.classList.remove("is-closing", "is-settled");
    open = { pointerId: at.id, items: drawn || currentItems(), lifted: false };
    if (!drawn) renderSlices(open.items);
    Object.assign(open, place(at.x, at.y));
    ring.hidden = false;
    ring.classList.remove("is-charging");
    aimAt(null);
    ring.classList.add("is-open");
    // Hover easing waits until every slice has landed (quick-access.css).
    settleTimer = window.setTimeout(() => { if (open) ring.classList.add("is-settled"); }, 420);
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
  let settleTimer = 0;
  function close() {
    open = null;
    if (!ring) return;
    window.clearTimeout(settleTimer);
    ring.classList.remove("is-charging", "is-settled");
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
      aimAt(slice);
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

  // The first open used to hitch for ~500ms: building the ring, decoding the
  // mark, rasterising the HUD layers and compiling the blur all landed on the
  // first pop. Do all of that once while the page is idle, off screen, so
  // the first hold is as smooth as the hundredth.
  function warm() {
    if (open || hold) return;
    if (!ring) build();
    renderSlices(currentItems());
    // On screen at 1% (quick-access.css): the browser skips rasterising
    // layers parked off screen, which made an off-screen warm-up do nothing.
    place(window.innerWidth / 2, window.innerHeight / 2);
    ring.classList.add("is-charging", "is-warming");
    ring.hidden = false;
    const frame = (fn) => window.requestAnimationFrame(() => window.requestAnimationFrame(fn));
    // The charge first, then the open ring: each has layers the other lacks.
    frame(() => {
      if (open || hold) return ring.classList.remove("is-warming");
      ring.classList.remove("is-charging");
      ring.classList.add("is-open");
      frame(() => {
        ring.classList.remove("is-warming");
        if (open || hold) return;
        ring.classList.remove("is-open");
        ring.hidden = true;
      });
    });
  }

  function start() {
    const idle = window.requestIdleCallback || ((fn) => window.setTimeout(fn, 1200));
    idle(() => warm(), { timeout: 2500 });
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
