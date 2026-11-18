// Right-click menu for construction geometry.
//
// Points, crossings and arc ends are the things a construction is actually
// made of, but until now none of them could be acted on directly: a point once
// placed was permanent, and an arc once swept was fixed. This gives each of
// them a menu.
//
// The menu only ever offers actions that apply to what is genuinely under the
// cursor. Right-clicking empty canvas does nothing and lets the browser's own
// menu through, so "inspect element" still works while developing.
(function () {
  "use strict";

  const C = () => window.Inkyscib?.Construction;
  const G = () => window.Inkyscib?.GeometryEngine;
  const Compass = () => window.Inkyscib?.Compass;

  // Slightly more forgiving than the 10px snap radius: a right-click is aimed
  // deliberately, and missing it means the browser menu appears instead.
  const HIT_SCREEN_PX = 14;

  let menu = null;
  let open = false;

  function state() {
    return window.appState;
  }

  function canvas() {
    return document.getElementById("drawingCanvas");
  }

  function render() {
    if (typeof window.render === "function") window.render();
  }

  function save() {
    if (typeof window.saveDrawing === "function") window.saveDrawing();
  }

  function commitHistory() {
    if (typeof window.commitHistory === "function") window.commitHistory();
  }

  // ---------- what is under the cursor ----------

  function worldFromEvent(event) {
    if (typeof window.clientPointToWorld === "function") {
      return window.clientPointToWorld(event.clientX, event.clientY);
    }
    return null;
  }

  function pointAt(world) {
    const construction = C();
    const engine = G();
    if (!construction || !engine) return null;
    const tolerance = engine.screenDistanceToWorld(engine.hitScreenPx ? engine.hitScreenPx(HIT_SCREEN_PX) : HIT_SCREEN_PX, state()?.transform);
    return construction.findPointAt(world, tolerance);
  }

  function crossingAt(world) {
    const construction = C();
    const engine = G();
    if (!construction || !engine) return null;
    const tolerance = engine.screenDistanceToWorld(engine.hitScreenPx ? engine.hitScreenPx(HIT_SCREEN_PX) : HIT_SCREEN_PX, state()?.transform);
    let best = null;
    let bestDistance = tolerance;
    construction.computeIntersections().forEach((point) => {
      const distance = engine.distance(world, point);
      if (distance <= bestDistance) {
        best = point;
        bestDistance = distance;
      }
    });
    return best;
  }

  // ---------- actions ----------

  function removePoint(path) {
    const construction = C();
    if (!construction || !path) return;
    commitHistory();
    construction.remove(path.gid);
    construction.invalidateIntersections();
    save();
    render();
  }

  function renamePoint(path) {
    const construction = C();
    if (!construction || !path) return;
    const next = window.prompt("Name this point", path.label || "");
    if (next === null) return;
    const cleaned = next.replace(/\s+/g, "").slice(0, 4);
    commitHistory();
    path.label = cleaned;
    save();
    render();
  }

  function promoteCrossing(point) {
    const construction = C();
    if (!construction || !point) return;
    commitHistory();
    construction.createPoint(point, {
      origin: "intersection",
      sourceIds: point.sourceObjectIds
    });
    save();
    render();
  }

  // ---------- menu chrome ----------

  function ensureMenu() {
    if (menu) return menu;
    menu = document.createElement("div");
    menu.className = "construction-menu";
    menu.setAttribute("role", "menu");
    menu.hidden = true;
    document.body.appendChild(menu);
    return menu;
  }

  function closeMenu() {
    if (!menu || !open) return;
    open = false;
    menu.hidden = true;
    menu.innerHTML = "";
  }

  function buildMenu(items, clientX, clientY) {
    const element = ensureMenu();
    element.innerHTML = "";

    items.forEach((item) => {
      if (item.separator) {
        const rule = document.createElement("div");
        rule.className = "construction-menu-rule";
        element.appendChild(rule);
        return;
      }
      const button = document.createElement("button");
      button.type = "button";
      button.className = "construction-menu-item";
      if (item.danger) button.classList.add("is-danger");
      button.setAttribute("role", "menuitem");
      button.textContent = item.label;
      button.addEventListener("click", () => {
        closeMenu();
        item.run();
      });
      element.appendChild(button);
    });

    element.hidden = false;
    open = true;

    // Place it at the cursor, then pull it back inside the viewport if the
    // corner of the screen would have cut it off.
    element.style.left = "0px";
    element.style.top = "0px";
    const box = element.getBoundingClientRect();
    const left = Math.min(clientX, window.innerWidth - box.width - 8);
    const top = Math.min(clientY, window.innerHeight - box.height - 8);
    element.style.left = Math.max(8, left) + "px";
    element.style.top = Math.max(8, top) + "px";
  }

  // ---------- entry point ----------

  function handleContextMenu(event) {
    const construction = C();
    const compass = Compass();
    if (!construction) return;

    const world = worldFromEvent(event);
    if (!world) return;

    const items = [];

    const point = pointAt(world);
    const arcEnd = compass?.extendTargetAt ? compass.extendTargetAt(world) : null;
    const crossing = point ? null : crossingAt(world);

    if (arcEnd && compass?.beginExtend) {
      items.push({
        label: "Extend this arc",
        run: () => compass.beginExtend(arcEnd.gid, arcEnd.end)
      });
    }

    if (point) {
      if (items.length) items.push({ separator: true });
      items.push({
        label: point.label ? `Rename point ${point.label}` : "Name this point",
        run: () => renamePoint(point)
      });
      items.push({
        label: point.label ? `Remove point ${point.label}` : "Remove this point",
        danger: true,
        run: () => removePoint(point)
      });
    } else if (crossing) {
      if (items.length) items.push({ separator: true });
      items.push({
        label: "Make a point here",
        run: () => promoteCrossing(crossing)
      });
    }

    // Nothing of ours under the cursor: leave the browser's own menu alone.
    if (!items.length) return;

    event.preventDefault();
    buildMenu(items, event.clientX, event.clientY);
  }

  function init() {
    const element = canvas();
    if (!element) return;

    element.addEventListener("contextmenu", handleContextMenu);

    document.addEventListener("pointerdown", (event) => {
      if (open && menu && !menu.contains(event.target)) closeMenu();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeMenu();
    });
    window.addEventListener("blur", closeMenu);
    window.addEventListener("resize", closeMenu, { passive: true });
    element.addEventListener("wheel", closeMenu, { passive: true });
  }

  window.Inkyscib = window.Inkyscib || {};
  window.Inkyscib.ConstructionMenu = { close: closeMenu };

  document.addEventListener("DOMContentLoaded", init);
})();
