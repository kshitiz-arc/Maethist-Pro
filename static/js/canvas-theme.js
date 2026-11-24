// Canvas theme presets: the ground you write on, and its grid.
//
// A preset is a canvas, not a chrome theme. The menus and toolbars stay light
// or dark on the DESIGN.md tokens, and each preset names which of the two it
// pairs with, so a dark ground always sits in dark chrome and a light ground in
// light. That pairing is what keeps every older `data-theme` check in the
// canvas code right without touching it: light chrome means a light ground.
//
// What a preset owns: the stage's ground (--canvas-ground, canvas-theme.css),
// the grid colours canvas.js draws with, notebook page colours, and which of
// the two default pen colours is the default.
//
// The inline script in write.html's <head> stamps data-canvas before first
// paint and duplicates the id -> chrome table below for that reason. See
// docs/superpowers/specs/2026-09-14-editor-feedback-design.md, section 3.
(function () {
  "use strict";

  const STORAGE_KEY = "inkyscib-canvas-theme";
  const PATTERN_KEY = "inkyscib-pattern";
  const DARK_GROUND_INK = "#ffffff";
  const LIGHT_GROUND_INK = "#1b1b18";

  function grid(rgb, minor, major, dot) {
    return {
      minor: `rgba(${rgb}, ${minor})`,
      major: `rgba(${rgb}, ${major})`,
      dot: `rgba(${rgb}, ${dot})`
    };
  }

  // Grid colours keep one hue per preset and vary only in alpha, so a line
  // and a crossing read as the same ink. Every default ink clears 7:1 against
  // its ground (tests/test_canvas_theme.py measures it).
  const PRESETS = [
    {
      id: "graphite", label: "Graphite", chrome: "dark", ground: "#0A0D12", ink: DARK_GROUND_INK,
      grid: grid("255, 255, 255", 0.10, 0.18, 0.16),
      page: { page: "rgba(7, 10, 15, 0.96)", border: "rgba(255, 255, 255, 0.12)", shadow: "rgba(0, 0, 0, 0.28)" }
    },
    {
      id: "paper", label: "Paper", chrome: "light", ground: "#FBFBF9", ink: LIGHT_GROUND_INK,
      grid: grid("15, 23, 42", 0.10, 0.17, 0.16),
      page: { page: "rgba(255, 255, 255, 0.96)", border: "rgba(71, 85, 105, 0.22)", shadow: "rgba(71, 85, 105, 0.12)" }
    },
    {
      id: "chalkboard", label: "Chalkboard", chrome: "dark", ground: "#1E2B24", ink: DARK_GROUND_INK,
      grid: grid("236, 240, 232", 0.12, 0.20, 0.18),
      page: { page: "rgba(35, 49, 41, 0.97)", border: "rgba(236, 240, 232, 0.14)", shadow: "rgba(0, 0, 0, 0.30)" }
    },
    {
      id: "blueprint", label: "Blueprint", chrome: "dark", ground: "#0B1D31", ink: DARK_GROUND_INK,
      grid: grid("160, 205, 255", 0.13, 0.24, 0.22),
      page: { page: "rgba(14, 34, 56, 0.97)", border: "rgba(160, 205, 255, 0.24)", shadow: "rgba(0, 0, 0, 0.30)" }
    },
    {
      id: "midnight", label: "Midnight", chrome: "dark", ground: "#0D1321", ink: DARK_GROUND_INK,
      grid: grid("170, 185, 220", 0.12, 0.20, 0.18),
      page: { page: "rgba(19, 27, 45, 0.97)", border: "rgba(170, 185, 220, 0.14)", shadow: "rgba(0, 0, 0, 0.32)" }
    },
    {
      id: "cream", label: "Cream", chrome: "light", ground: "#F5EEDC", ink: LIGHT_GROUND_INK,
      grid: grid("110, 84, 48", 0.14, 0.24, 0.22),
      page: { page: "rgba(250, 245, 232, 0.98)", border: "rgba(110, 84, 48, 0.22)", shadow: "rgba(110, 84, 48, 0.14)" }
    },
    {
      id: "whiteboard", label: "Whiteboard", chrome: "light", ground: "#FFFFFF", ink: LIGHT_GROUND_INK,
      grid: grid("90, 100, 115", 0.10, 0.16, 0.16),
      page: { page: "rgba(255, 255, 255, 1)", border: "rgba(90, 100, 115, 0.20)", shadow: "rgba(90, 100, 115, 0.12)" }
    },
    {
      id: "contrast", label: "High contrast", chrome: "dark", ground: "#000000", ink: DARK_GROUND_INK,
      grid: grid("255, 255, 255", 0.28, 0.45, 0.45),
      page: { page: "rgba(0, 0, 0, 1)", border: "rgba(255, 255, 255, 0.40)", shadow: "rgba(0, 0, 0, 0)" }
    }
  ];

  const PATTERNS = [
    { id: "dot", label: "Dots" },
    { id: "lines", label: "Lines" },
    { id: "graph", label: "Graph" }
  ];

  const BY_ID = new Map(PRESETS.map((preset) => [preset.id, preset]));
  const DEFAULT_FOR_CHROME = { dark: "blueprint", light: "paper" };

  function readStored(key) {
    try {
      return window.localStorage.getItem(key);
    } catch (error) {
      return null;
    }
  }

  function writeStored(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch (error) {
      /* storage blocked: the choice still holds for this session */
    }
  }

  function initialId() {
    const root = document.documentElement;
    if (BY_ID.has(root.dataset.canvas)) return root.dataset.canvas;
    const stored = readStored(STORAGE_KEY);
    if (BY_ID.has(stored)) return stored;
    return DEFAULT_FOR_CHROME[root.dataset.theme === "light" ? "light" : "dark"];
  }

  let currentId = initialId();

  function get() {
    return BY_ID.get(currentId);
  }

  function isLightGround() {
    return get().chrome === "light";
  }

  function stampAttributes(preset) {
    const root = document.documentElement;
    root.dataset.canvas = preset.id;
    root.dataset.theme = preset.chrome;
  }

  // Only the two defaults trade places, exactly as core.js setTheme always
  // did for the pen - a colour someone picked is theirs and never changes.
  // Line and shape defaults were white-for-dark as well, so they follow too.
  function swapDefaultInk(lightGround) {
    const settings = window.appState?.toolSettings;
    if (!settings) return;
    const wanted = lightGround ? LIGHT_GROUND_INK : DARK_GROUND_INK;
    const other = lightGround ? DARK_GROUND_INK : LIGHT_GROUND_INK;

    const pen = settings.pen;
    if (pen) {
      const colour = String(pen.color || "").toLowerCase();
      if (!colour || colour === "black" || colour === "#000000" || colour === other) pen.color = wanted;
    }
    ["line", "shape"].forEach((tool) => {
      const tool_settings = settings[tool];
      if (!tool_settings) return;
      const colour = String(tool_settings.color || "").toLowerCase();
      if (!colour || colour === other) tool_settings.color = wanted;
    });
  }

  function set(id, options) {
    const preset = BY_ID.get(id);
    if (!preset) return false;
    const opts = options || {};
    currentId = id;
    stampAttributes(preset);

    if (opts.persist !== false) {
      writeStored(STORAGE_KEY, id);
      // Kept for pages that only know light and dark (the marketing site).
      writeStored("theme", preset.chrome);
    }

    swapDefaultInk(preset.chrome === "light");
    if (typeof window.syncUIWithSettings === "function") window.syncUIWithSettings();
    if (typeof window.invalidateCanvasBackground === "function") window.invalidateCanvasBackground();
    syncPopover();
    document.dispatchEvent(new CustomEvent("inkyscib:canvastheme", { detail: { id } }));

    if (opts.render !== false && typeof window.render === "function") window.render();
    if (opts.persist !== false && typeof window.savePreferences === "function") window.savePreferences();
    return true;
  }

  // A preferences record written before presets existed knows only light or
  // dark. Keep the current preset when it already pairs with that chrome.
  function adoptChrome(theme) {
    const chrome = theme === "light" ? "light" : "dark";
    if (get().chrome === chrome) {
      stampAttributes(get());
      return;
    }
    set(DEFAULT_FOR_CHROME[chrome], { persist: false, render: false });
  }

  function setPattern(id) {
    if (!PATTERNS.some((pattern) => pattern.id === id)) return false;
    document.documentElement.dataset.pattern = id;
    writeStored(PATTERN_KEY, id);
    if (typeof window.invalidateCanvasBackground === "function") window.invalidateCanvasBackground();
    syncPopover();
    if (typeof window.render === "function") window.render();
    return true;
  }

  // ---------- the Canvas popover ----------

  let button = null;
  let pop = null;

  function syncPopover() {
    if (!pop) return;
    const pattern = document.documentElement.dataset.pattern || "dot";
    pop.querySelectorAll("[data-canvas-preset]").forEach((tile) => {
      tile.setAttribute("aria-checked", String(tile.dataset.canvasPreset === currentId));
    });
    pop.querySelectorAll(".pattern-option").forEach((option) => {
      option.setAttribute("aria-checked", String(option.dataset.pattern === pattern));
    });
  }

  function placePopover() {
    if (!pop || !button) return;
    const rect = button.getBoundingClientRect();
    const margin = 16;
    const width = pop.offsetWidth;
    const left = Math.min(
      Math.max(margin, rect.right - width),
      Math.max(margin, window.innerWidth - width - margin)
    );
    pop.style.left = `${Math.round(left)}px`;
    // A clear gap under the bar the button sits in, not under the button: the
    // bar's padding and hard shadow made 8px read as touching (DESIGN.md,
    // --chrome-gap).
    const bar = button.closest(".toolbar, .file-ribbon")?.getBoundingClientRect() || rect;
    pop.style.top = `${Math.round(Math.max(rect.bottom, bar.bottom) + 14)}px`;
  }

  function isOpen() {
    return !!pop && !pop.hidden;
  }

  function open() {
    if (!pop) return;
    syncPopover();
    pop.hidden = false;
    // One floating surface at a time (tool-dock.js, SURFACE_EVENT): opening
    // this used to leave a floating tool panel open underneath it, the two
    // overlapping by 237x195px on a 960px tablet.
    document.dispatchEvent(new CustomEvent("inkyscib:surface-open", { detail: { id: "canvas-theme" } }));
    placePopover();
    // It grows out of the button that opened it (DESIGN.md, origin awareness).
    // Measured once the popover has its final width and place.
    window.requestAnimationFrame(() => window.Inkyscib?.Motion?.originFrom?.(pop, button));
    button.setAttribute("aria-expanded", "true");
    pop.querySelector('[data-canvas-preset][aria-checked="true"]')?.focus({ preventScroll: true });
  }

  function close({ restoreFocus = false } = {}) {
    if (!isOpen()) return;
    pop.hidden = true;
    button.setAttribute("aria-expanded", "false");
    if (restoreFocus) button.focus({ preventScroll: true });
  }

  function swatchMarkup(preset) {
    // The ink stroke is what makes the tile a preview rather than a colour
    // chip: it shows the default pen on that ground.
    return `<span class="canvas-theme-swatch" aria-hidden="true" ` +
      `style="--swatch-ground:${preset.ground};--swatch-grid:${preset.grid.major};--swatch-ink:${preset.ink}">` +
      `<svg viewBox="0 0 48 28" preserveAspectRatio="none"><path d="M7 19c5-9 10-9 14-1s9 8 20-6" ` +
      `fill="none" stroke="var(--swatch-ink)" stroke-width="2.2" stroke-linecap="round"/></svg></span>`;
  }

  function buildPopover() {
    button = document.getElementById("themeToggle");
    if (!button || document.getElementById("canvasThemePop")) return;

    button.setAttribute("aria-haspopup", "dialog");
    button.setAttribute("aria-expanded", "false");
    button.setAttribute("aria-controls", "canvasThemePop");

    pop = document.createElement("div");
    pop.id = "canvasThemePop";
    pop.className = "canvas-theme-pop";
    pop.setAttribute("role", "dialog");
    pop.setAttribute("aria-label", "Canvas");
    pop.hidden = true;
    pop.innerHTML =
      '<p class="canvas-theme-heading" id="canvasThemeHeading">Theme</p>' +
      '<div class="canvas-theme-grid" role="radiogroup" aria-labelledby="canvasThemeHeading">' +
      PRESETS.map((preset) =>
        `<button type="button" class="canvas-theme-tile" role="radio" aria-checked="false" data-canvas-preset="${preset.id}">` +
        swatchMarkup(preset) +
        `<span class="canvas-theme-label">${preset.label}</span></button>`
      ).join("") +
      "</div>" +
      '<p class="canvas-theme-heading" id="canvasPatternHeading">Pattern</p>' +
      '<div class="canvas-pattern-row" role="radiogroup" aria-labelledby="canvasPatternHeading">' +
      PATTERNS.map((pattern) =>
        `<button type="button" class="pattern-option" role="radio" aria-checked="false" data-pattern="${pattern.id}">` +
        `<span class="canvas-pattern-swatch is-${pattern.id}" aria-hidden="true"></span>` +
        `<span>${pattern.label}</span></button>`
      ).join("") +
      "</div>" +
      // A picture of your own as the ground (static/js/canvas-picture.js).
      '<div class="canvas-picture-slot"></div>';
    document.body.appendChild(pop);
    document.dispatchEvent(new CustomEvent("inkyscib:canvas-pop-built", { detail: { pop } }));

    button.addEventListener("click", (event) => {
      event.stopPropagation();
      if (isOpen()) close();
      else open();
    });

    pop.addEventListener("click", (event) => {
      const tile = event.target.closest("[data-canvas-preset]");
      if (tile) {
        // The new canvas grows out of the tile that was picked (motion.js).
        const wipe = window.Inkyscib && window.Inkyscib.Motion && window.Inkyscib.Motion.themeWipe;
        if (wipe && tile.getAttribute("aria-checked") !== "true") wipe(() => set(tile.dataset.canvasPreset), tile);
        else set(tile.dataset.canvasPreset);
        return;
      }
      const option = event.target.closest(".pattern-option");
      if (option) setPattern(option.dataset.pattern);
    });

    // Pointer-down outside closes it, and never consumes the event: the
    // stroke that started on the canvas still lands.
    document.addEventListener("pointerdown", (event) => {
      if (!isOpen()) return;
      if (pop.contains(event.target) || button.contains(event.target)) return;
      close();
    }, true);

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && isOpen()) close({ restoreFocus: true });
    });

    // ...and step aside when another surface opens -- a tool panel chosen from
    // the keyboard, or a File menu -- since neither involves a pointerdown
    // outside this one.
    document.addEventListener("inkyscib:surface-open", (event) => {
      if (event.detail?.id !== "canvas-theme" && isOpen()) close();
    });

    window.addEventListener("resize", () => {
      if (isOpen()) placePopover();
    });

    syncPopover();
  }

  // Attributes first, so everything that runs after this file sees the preset.
  stampAttributes(get());

  window.Inkyscib = window.Inkyscib || {};
  window.Inkyscib.CanvasTheme = {
    PRESETS,
    PATTERNS,
    get,
    set,
    adoptChrome,
    setPattern,
    isLightGround,
    grid: () => get().grid,
    page: () => get().page,
    open,
    close
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", buildPopover, { once: true });
  } else {
    buildPopover();
  }
})();
