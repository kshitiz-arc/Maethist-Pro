// The editor's shared interaction parts: tooltips, the command search and
// the keyboard sheet.
//
// Patterns taken from the projects the owner pointed at, rebuilt in plain
// JS on the core tokens (DESIGN.md), not copied:
//
//  * shadcn/ui Tooltip. A styled label after a short hover, at once on
//    keyboard focus, with the key that does the same thing. The skip-delay
//    rule means the next tooltip along a toolbar opens straight away. It
//    replaces the browser's own title bubble: that one is slow, unstyled,
//    never shows on focus and never names the shortcut.
//  * shadcn/ui Command (cmdk). Ctrl+K or "/" opens one search box over every
//    tool and every File, Insert, Export and Tools command, each with its key.
//    Arrows move, Enter runs.
//  * "?" for the keyboard sheet. (2.7.1 also borrowed ComfyUI's
//    double-click-to-search; 2.8.4 took it out, see below.)
(function () {
  "use strict";

  const $ = (sel, root = document) => root.querySelector(sel);
  const icon = (ref) => {
    try { return window.Inkyscib?.Icon?.svg?.(ref) || ""; } catch (_) { return ""; }
  };
  const typing = (el) => !!el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable);
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform || "");

  // The keys, said once. Tool letters mirror events.js TOOL_SHORTCUTS.
  const TOOL_KEYS = {
    selectTool: "V", penTool: "P", eraserTool: "E", highlightTool: "H", shapeTool: "S",
    lineTool: "L", compassTool: "C", angleTool: "A", manipulativeTool: "T",
    undoBtn: "Ctrl Z", redoBtn: "Ctrl Y", clearBtn: "Ctrl Del", panMode: "Space"
  };

  function keyLabel(text) {
    return String(text || "")
      .replace(/Control\+|Ctrl\+?/g, isMac ? "⌘ " : "Ctrl ")
      .replace(/\+/g, " ")
      .replace(/Delete/g, "Del")
      .trim();
  }

  function kbd(text) {
    if (!text) return "";
    return '<span class="ui-kbd-row">' + keyLabel(text).split(/\s+/).map((k) => `<kbd class="ui-kbd">${k}</kbd>`).join("") + "</span>";
  }

  // ---------- tooltips ----------

  let tip = null;
  let tipFor = null;
  let tipTimer = 0;
  let lastHidden = 0;

  const TIP_SCOPE = ".toolbar, .tool-rail, .file-ribbon, .img-bar, .ar-hud, .tool-panel-head, .yt-player, .canvas-picture-row";

  function tipTarget(el) {
    const target = el?.closest?.("button, [role='button'], a.tool");
    if (!target || !target.closest(TIP_SCOPE)) return null;
    if (target.closest(".file-backstage")) return null;
    return target;
  }

  // The label a person reads and the key that does the same, from the
  // control's own attributes. The native title is moved aside on first use, so
  // two tooltips never show at once; the accessible name is kept.
  function describe(el) {
    if (el.hasAttribute("title")) {
      const t = el.getAttribute("title");
      if (!el.getAttribute("aria-label") && !el.textContent.trim()) el.setAttribute("aria-label", t);
      el.dataset.tip = t;
      el.removeAttribute("title");
    }
    let label = el.dataset.tip || el.getAttribute("aria-label") || "";
    // "Undo (Ctrl+Z)" carries its own key; show it as a key instead.
    let key = el.dataset.shortcut || el.getAttribute("aria-keyshortcuts") || TOOL_KEYS[el.id] || "";
    const inline = label.match(/\s*\(((?:[^()]*(?:Ctrl|Del|Shift|Alt|⌘)[^()]*)|[A-Za-z0-9[\]?/]{1,3})\)\s*$/);
    if (inline) {
      key = key || inline[1];
      label = label.slice(0, inline.index);
    }
    const visibleText = el.textContent.trim();
    // A button that already says its name needs a tooltip only to add a key.
    if (visibleText && visibleText === label.trim() && !key) return null;
    return label ? { label, key } : null;
  }

  function showTip(el) {
    const info = describe(el);
    if (!info) return;
    if (!tip) {
      tip = document.createElement("div");
      tip.className = "ui-tooltip";
      tip.id = "uiTooltip";
      tip.setAttribute("role", "tooltip");
      document.body.appendChild(tip);
    }
    tip.innerHTML = `<span>${info.label.replace(/</g, "&lt;")}</span>${kbd(info.key)}`;
    tip.hidden = false;
    tipFor = el;
    el.setAttribute("aria-describedby", "uiTooltip");
    placeTip(el);
    tip.classList.remove("is-in");
    void tip.offsetWidth;
    tip.classList.add("is-in");
  }

  function placeTip(el) {
    const r = el.getBoundingClientRect();
    const t = tip.getBoundingClientRect();
    const gap = 8;
    const side = el.closest(".tool-rail") ? "right" : r.bottom + gap + t.height > innerHeight - 8 ? "top" : "bottom";
    let x;
    let y;
    if (side === "right") {
      x = r.right + gap;
      y = r.top + r.height / 2 - t.height / 2;
    } else {
      x = r.left + r.width / 2 - t.width / 2;
      y = side === "top" ? r.top - gap - t.height : r.bottom + gap;
    }
    x = Math.max(8, Math.min(innerWidth - t.width - 8, x));
    y = Math.max(8, Math.min(innerHeight - t.height - 8, y));
    tip.dataset.side = side;
    tip.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }

  function hideTip() {
    clearTimeout(tipTimer);
    if (!tip || tip.hidden) return;
    tip.hidden = true;
    tipFor?.removeAttribute("aria-describedby");
    tipFor = null;
    lastHidden = performance.now();
  }

  document.addEventListener("pointerover", (event) => {
    if (event.pointerType !== "mouse") return;
    const el = tipTarget(event.target);
    if (!el || el === tipFor) return;
    clearTimeout(tipTimer);
    // Moving along a toolbar: the next one opens at once (Radix skip delay).
    const warm = performance.now() - lastHidden < 600 || (tip && !tip.hidden);
    hideTip();
    tipTimer = setTimeout(() => showTip(el), warm ? 0 : 450);
  });
  document.addEventListener("pointerout", (event) => {
    const el = tipTarget(event.target);
    if (el && !el.contains(event.relatedTarget)) hideTip();
  });
  document.addEventListener("focusin", (event) => {
    const el = tipTarget(event.target);
    if (el && el.matches(":focus-visible")) showTip(el);
  });
  // Only the control the tooltip belongs to losing focus hides it; focus
  // moving elsewhere (a dialog closing, the window blurring) leaves a hover
  // tooltip where it is.
  document.addEventListener("focusout", (event) => { if (event.target === tipFor) hideTip(); });
  document.addEventListener("pointerdown", hideTip, true);
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") hideTip(); }, true);
  window.addEventListener("scroll", (event) => {
    if (tipFor && (event.target === document || event.target.contains?.(tipFor))) hideTip();
  }, true);
  window.addEventListener("resize", hideTip);

  // ---------- the command search ----------

  let palette = null;
  let items = [];
  let shown = [];
  let active = 0;
  let returnFocus = null;

  function clickId(id) {
    const el = document.getElementById(id);
    if (el) el.click();
  }

  function toolCommand(id, tool, title, keywords) {
    return {
      id: "tool-" + tool, group: "Tools", title, keywords, key: TOOL_KEYS[id],
      iconHtml: () => document.querySelector(`#${id} svg`)?.outerHTML || "",
      run: () => (window.setTool ? window.setTool(tool) : clickId(id))
    };
  }

  function buildItems() {
    const list = [
      toolCommand("selectTool", "select", "Select", "move pick arrow"),
      toolCommand("penTool", "pen", "Pen", "write draw ink"),
      toolCommand("eraserTool", "eraser", "Eraser", "rub delete lasso"),
      toolCommand("highlightTool", "highlight", "Highlighter", "marker"),
      toolCommand("shapeTool", "shape", "Shapes", "rectangle circle triangle square"),
      toolCommand("lineTool", "line", "Line", "straight ruler arrow"),
      toolCommand("compassTool", "compass", "Compass", "circle arc construction"),
      toolCommand("angleTool", "angle", "Measure angle", "protractor degrees"),
      toolCommand("manipulativeTool", "manipulative", "Algebra tiles", "manipulative"),
      { id: "undo", group: "Edit", title: "Undo", key: "Ctrl Z", run: () => window.undo?.() },
      { id: "redo", group: "Edit", title: "Redo", key: "Ctrl Y", run: () => window.redo?.() },
      { id: "clear", group: "Edit", title: "Clear the canvas", key: "Ctrl Del", keywords: "erase all wipe", run: () => clickId("clearBtn") },
      { id: "zoomIn", group: "View", title: "Zoom in", keywords: "bigger magnify", run: () => clickId("zoomIn") },
      { id: "zoomOut", group: "View", title: "Zoom out", keywords: "smaller", run: () => clickId("zoomOut") },
      { id: "resetView", group: "View", title: "Back to the start of the page", key: "0", keywords: "reset view home fit", run: () => window.resetView?.() },
      { id: "pan", group: "View", title: "Pan", key: "Space", keywords: "move hand scroll", run: () => window.setPanMode?.(!window.appState?.panMode) },
      { id: "rail", group: "View", title: "Hide or show the tool rail", keywords: "sidebar toolbar focus", run: () => { const q = window.Inkyscib?.QuickAccess; q?.setRailHidden?.(!q.railHidden()); } },
      { id: "theme", group: "View", title: "Canvas theme and pattern", keywords: "background grid dots lines colour dark light", run: () => clickId("themeToggle") },
      { id: "picture", group: "View", title: "Use a picture as the background", keywords: "wallpaper image photo", run: () => window.Inkyscib?.CanvasPicture?.choose?.() },
      { id: "shortcuts", group: "Help", title: "Keyboard shortcuts", key: "?", keywords: "keys help", run: () => openSheet() }
    ];
    const ribbon = window.Inkyscib?.FileRibbon;
    (ribbon?.commands?.() || []).forEach((c) => {
      list.push({
        id: "ribbon-" + c.id, group: "File and tools", title: c.title, note: c.note, key: c.key,
        run: () => ribbon.runCommand(c.id)
      });
    });
    return list;
  }

  // Letters in order, anywhere: "imtx" finds "Image to text". Earlier and
  // closer together scores higher; a match at the start of a word, more.
  function score(item, query) {
    if (!query) return 1;
    const hay = (item.title + " " + (item.keywords || "") + " " + item.group).toLowerCase();
    const q = query.toLowerCase().replace(/\s+/g, " ").trim();
    const direct = hay.indexOf(q);
    if (direct >= 0) return 1000 - direct + (direct === 0 || hay[direct - 1] === " " ? 200 : 0);
    let at = -1;
    let total = 0;
    for (const ch of q.replace(/ /g, "")) {
      const next = hay.indexOf(ch, at + 1);
      if (next < 0) return 0;
      total += next - at;
      at = next;
    }
    return Math.max(1, 500 - total);
  }

  function buildPalette() {
    palette = document.createElement("div");
    palette.className = "ui-palette";
    palette.id = "commandPalette";
    palette.hidden = true;
    palette.dataset.iconSet = "lucide";
    palette.innerHTML = `
      <div class="ui-palette-card" role="dialog" aria-modal="true" aria-label="Search commands">
        <label class="ui-palette-search">${icon("lucide:search")}
          <input type="text" role="combobox" aria-expanded="true" aria-controls="commandList" aria-autocomplete="list"
            placeholder="Search tools and commands…" aria-label="Search tools and commands" autocomplete="off" spellcheck="false">
          <kbd class="ui-kbd">Esc</kbd>
        </label>
        <div class="ui-palette-list" id="commandList" role="listbox" aria-label="Commands"></div>
        <div class="ui-palette-foot"><span>${kbd("↑ ↓")} to move</span><span>${kbd("Enter")} to run</span><span>${kbd("?")} all keys</span></div>
      </div>`;
    document.body.appendChild(palette);
    const input = $("input", palette);
    input.addEventListener("input", () => { active = 0; renderList(input.value); });
    input.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        if (!shown.length) return;
        active = (active + (event.key === "ArrowDown" ? 1 : -1) + shown.length) % shown.length;
        syncActive();
      } else if (event.key === "Enter") {
        event.preventDefault();
        runAt(active);
      } else if (event.key === "Escape") {
        event.preventDefault();
        closePalette();
      } else if (event.key === "Tab") {
        event.preventDefault();
      }
    });
    ["keyup", "keypress"].forEach((type) => input.addEventListener(type, (e) => e.stopPropagation()));
    palette.addEventListener("pointerdown", (event) => {
      if (event.target === palette) { event.preventDefault(); closePalette(); }
    });
    palette.addEventListener("click", (event) => {
      const row = event.target.closest("[data-index]");
      if (row) runAt(Number(row.dataset.index));
    });
    palette.addEventListener("pointermove", (event) => {
      const row = event.target.closest("[data-index]");
      if (row && Number(row.dataset.index) !== active) { active = Number(row.dataset.index); syncActive(false); }
    });
  }

  // Frequency of use (DESIGN.md): what you run most comes first. Counted in
  // this browser only, like every other preference.
  const USAGE_KEY = "inkyscib-command-usage";
  function usage() {
    try { return JSON.parse(localStorage.getItem(USAGE_KEY) || "{}") || {}; } catch (_) { return {}; }
  }
  function countUse(id) {
    const counts = usage();
    counts[id] = (counts[id] || 0) + 1;
    try { localStorage.setItem(USAGE_KEY, JSON.stringify(counts)); } catch (_) { /* storage blocked */ }
  }

  function renderList(query) {
    const counts = usage();
    const used = (item) => counts[item.id] || 0;
    shown = items
      .map((item) => ({ item, s: score(item, query) }))
      .filter((x) => x.s > 0)
      // A search ranks by match, nudged by use; no search puts the most used
      // first, as a "Frequent" group of up to four, then everything in order.
      .sort((a, b) => (query ? (b.s + Math.log2(1 + used(b.item)) * 40) - (a.s + Math.log2(1 + used(a.item)) * 40) : 0))
      .map((x) => x.item);
    if (!query) {
      const frequent = shown.filter((item) => used(item) > 0).sort((a, b) => used(b) - used(a)).slice(0, 4)
        .map((item) => ({ ...item, group: "Frequent" }));
      const ids = new Set(frequent.map((item) => item.id));
      shown = frequent.concat(shown.filter((item) => !ids.has(item.id)));
    }
    const list = $(".ui-palette-list", palette);
    if (!shown.length) {
      list.innerHTML = '<p class="ui-palette-empty">Nothing matches. Try a tool name, like "compass".</p>';
      return;
    }
    let group = "";
    list.innerHTML = shown.map((item, i) => {
      const head = !query && item.group !== group ? `<p class="ui-palette-group" role="presentation">${(group = item.group)}</p>` : "";
      return head + `<div class="ui-palette-item" role="option" id="cmd-${i}" data-index="${i}" aria-selected="false">
          <span class="ui-palette-icon" aria-hidden="true">${item.iconHtml ? item.iconHtml() : ""}</span>
          <span class="ui-palette-text"><span class="ui-palette-title">${item.title}</span>${item.note ? `<span class="ui-palette-note">${item.note}</span>` : ""}</span>
          ${kbd(item.key)}
        </div>`;
    }).join("");
    window.Inkyscib?.Motion?.stagger?.(list);
    syncActive();
  }

  function syncActive(scroll = true) {
    palette.querySelectorAll("[data-index]").forEach((row) => {
      const on = Number(row.dataset.index) === active;
      row.setAttribute("aria-selected", String(on));
      if (on && scroll) row.scrollIntoView({ block: "nearest" });
    });
    $("input", palette).setAttribute("aria-activedescendant", shown.length ? "cmd-" + active : "");
  }

  function runAt(index) {
    const item = shown[index];
    if (!item) return;
    countUse(item.id);
    closePalette(false);
    // After the palette is gone, so a command that opens a sheet takes focus.
    setTimeout(() => item.run(), 0);
  }

  function openPalette(query = "") {
    if (!palette) buildPalette();
    items = buildItems();
    returnFocus = document.activeElement;
    palette.hidden = false;
    document.dispatchEvent(new CustomEvent("inkyscib:surface-open", { detail: { id: "command-palette" } }));
    const input = $("input", palette);
    input.value = query;
    active = 0;
    renderList(query);
    requestAnimationFrame(() => input.focus());
  }

  function closePalette(restore = true) {
    if (!palette || palette.hidden) return;
    palette.hidden = true;
    if (restore) returnFocus?.focus?.({ preventScroll: true });
  }

  // ---------- the keyboard sheet ----------

  let sheet = null;

  function openSheet() {
    if (!sheet) {
      sheet = document.createElement("div");
      sheet.className = "ui-palette ui-keys";
      sheet.id = "shortcutSheet";
      const rows = (pairs) => pairs.map(([k, what]) => `<li><span>${what}</span>${kbd(k)}</li>`).join("");
      sheet.innerHTML = `
        <div class="ui-palette-card ui-keys-card" role="dialog" aria-modal="true" aria-labelledby="shortcutSheetTitle" tabindex="-1">
          <div class="ui-keys-head"><h2 id="shortcutSheetTitle">${icon("lucide:keyboard")} Keyboard shortcuts</h2>
            <button type="button" class="ui-keys-close" aria-label="Close">${icon("lucide:x")}</button></div>
          <div class="ui-keys-grid">
            <section><h3>Tools</h3><ul>${rows([["V", "Select"], ["P", "Pen"], ["E", "Eraser"], ["H", "Highlighter"], ["S", "Shapes"], ["L", "Line"], ["C", "Compass"], ["A", "Measure angle"], ["T", "Algebra tiles"]])}</ul></section>
            <section><h3>Edit</h3><ul>${rows([["Ctrl Z", "Undo"], ["Ctrl Y", "Redo"], ["Del", "Delete the selection"], ["Ctrl Del", "Clear the canvas"], ["[ ]", "Smaller or bigger pen"], ["E", "Edit the selected picture"]])}</ul></section>
            <section><h3>View</h3><ul>${rows([["Space", "Hold and drag to pan"], ["0", "Back to the start"], ["Ctrl K", "Search tools and commands"], ["/", "Search, too"], ["?", "This sheet"]])}</ul></section>
            <section><h3>Touch and pen</h3><ul>${rows([["Hold", "Still for 0.7s: the quick ring"], ["2 fingers", "Pinch to zoom, drag to pan"], ["Double-tap", "On empty canvas with Select: search"]])}</ul></section>
          </div>
        </div>`;
      document.body.appendChild(sheet);
      sheet.addEventListener("pointerdown", (event) => { if (event.target === sheet) closeSheet(); });
      $(".ui-keys-close", sheet).addEventListener("click", closeSheet);
      sheet.addEventListener("keydown", (event) => {
        event.stopPropagation();
        if (event.key === "Escape" || event.key === "?") { event.preventDefault(); closeSheet(); }
      });
    }
    returnFocus = document.activeElement;
    sheet.hidden = false;
    requestAnimationFrame(() => $(".ui-keys-close", sheet).focus());
  }

  function closeSheet() {
    if (!sheet || sheet.hidden) return;
    sheet.hidden = true;
    returnFocus?.focus?.({ preventScroll: true });
  }

  // ---------- opening them ----------

  // Ctrl+K is taken at the window, in the capture phase, ahead of every other
  // handler: a tool panel's field (the compass radius, say) stops its keys
  // from bubbling, and the shortcut must still work from there.
  window.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "k") {
      event.preventDefault();
      event.stopPropagation();
      if (palette && !palette.hidden) closePalette();
      else openPalette();
    }
  }, true);

  document.addEventListener("keydown", (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey || typing(event.target)) return;
    if (document.querySelector(".img-sheet:not([hidden]), .ocr-overlay:not([hidden]), #commandPalette:not([hidden]), #shortcutSheet:not([hidden])")) return;
    if (event.key === "/") { event.preventDefault(); openPalette(); }
    else if (event.key === "?") { event.preventDefault(); openSheet(); }
  });

  // No double-click search. 2.7.1 opened this box on a double-click of empty
  // canvas with Select, believing the gesture was free; it was not. A double
  // tap on the canvas has long meant "back to the pen" (events.js,
  // handleCanvasDoubleClick), so the owner got the pen and the search box at
  // once (reported 2.8.3). The pen keeps the gesture; Ctrl+K and "/" search.

  window.Inkyscib = window.Inkyscib || {};
  window.Inkyscib.UiKit = {
    openPalette,
    closePalette,
    openShortcuts: openSheet,
    closeShortcuts: closeSheet,
    paletteOpen: () => !!palette && !palette.hidden,
    _score: score
  };
})();
