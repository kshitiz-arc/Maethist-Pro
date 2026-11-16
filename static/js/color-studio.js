// One colour picker, for every tool.
//
// color-field.js already gave each tool's colour a hex box. That solves typing
// a code you already know. It does nothing for the harder half: finding the
// code in the first place — matching a colour off a diagram, nudging a shade
// warmer, or reusing the blue you used ten minutes ago.
//
// This is that half. A single popover, mounted once and opened from whichever
// hex field you are standing next to, so the compass and the pen and the
// highlighter all get the same picker rather than four different ones.
//
// It writes back through the tool's own <input type="color">, exactly as the
// hex box does, so no tool needs to know this exists.
(function () {
  "use strict";

  const RECENT_KEY = "inkyscib_recent_colors";
  const RECENT_MAX = 8;

  // Reference colours, not a full palette: enough to grab a sensible ink
  // without opening the gradient, spread across hue and lightness.
  const SAMPLES = [
    "#ffffff", "#c9d4da", "#8b9aa3", "#3d4a52", "#101819", "#000000",
    "#e0407a", "#f0553b", "#f0932b", "#f7d154", "#5fbf6a", "#2f9e8f",
    "#4bc6cf", "#3b82f6", "#5a5aff", "#8b5cf6", "#c026d3", "#7c3f2e"
  ];

  let root = null;
  let target = null;      // the <input type="color"> being edited
  let current = "#ffffff";
  let recent = [];

  // ---------- colour maths ----------

  function clamp(value, low, high) {
    return Math.min(high, Math.max(low, value));
  }

  function normalize(value) {
    return window.Inkyscib?.ColorField?.normalizeHex?.(value) || null;
  }

  function hexToRgb(hex) {
    const clean = normalize(hex) || "#ffffff";
    return [1, 3, 5].map((index) => parseInt(clean.slice(index, index + 2), 16));
  }

  function rgbToHex(r, g, b) {
    return "#" + [r, g, b]
      .map((channel) => clamp(Math.round(channel), 0, 255).toString(16).padStart(2, "0"))
      .join("");
  }

  function rgbToHsl(r, g, b) {
    const rn = r / 255;
    const gn = g / 255;
    const bn = b / 255;
    const max = Math.max(rn, gn, bn);
    const min = Math.min(rn, gn, bn);
    const lightness = (max + min) / 2;
    const delta = max - min;

    if (!delta) return [0, 0, lightness * 100];

    const saturation = delta / (1 - Math.abs(2 * lightness - 1));
    let hue;
    if (max === rn) hue = ((gn - bn) / delta) % 6;
    else if (max === gn) hue = (bn - rn) / delta + 2;
    else hue = (rn - gn) / delta + 4;

    return [(hue * 60 + 360) % 360, saturation * 100, lightness * 100];
  }

  function hslToHex(h, s, l) {
    const saturation = clamp(s, 0, 100) / 100;
    const lightness = clamp(l, 0, 100) / 100;
    const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
    const hue = ((h % 360) + 360) % 360 / 60;
    const second = chroma * (1 - Math.abs((hue % 2) - 1));

    let rgb;
    if (hue < 1) rgb = [chroma, second, 0];
    else if (hue < 2) rgb = [second, chroma, 0];
    else if (hue < 3) rgb = [0, chroma, second];
    else if (hue < 4) rgb = [0, second, chroma];
    else if (hue < 5) rgb = [second, 0, chroma];
    else rgb = [chroma, 0, second];

    const match = lightness - chroma / 2;
    return rgbToHex(...rgb.map((channel) => (channel + match) * 255));
  }

  // ---------- recent colours ----------

  function loadRecent() {
    try {
      const stored = JSON.parse(window.localStorage.getItem(RECENT_KEY) || "[]");
      recent = Array.isArray(stored)
        ? stored.map(normalize).filter(Boolean).slice(0, RECENT_MAX)
        : [];
    } catch (error) {
      recent = [];
    }
  }

  function remember(hex) {
    const value = normalize(hex);
    if (!value) return;
    // Most recent first, no duplicates: the row stays a genuine history rather
    // than filling with one colour you nudged twenty times.
    recent = [value, ...recent.filter((entry) => entry !== value)].slice(0, RECENT_MAX);
    try {
      window.localStorage.setItem(RECENT_KEY, JSON.stringify(recent));
    } catch (error) {
      /* private mode; the row simply will not survive the session */
    }
    renderRecent();
  }

  // ---------- applying ----------

  function apply(hex, options = {}) {
    const value = normalize(hex);
    if (!value) return;
    current = value;

    if (target) {
      target.value = value;
      // Same route the hex box takes, so the tool's own handler runs untouched.
      target.dispatchEvent(new Event("input", { bubbles: true }));
      target.dispatchEvent(new Event("change", { bubbles: true }));
    }
    window.Inkyscib?.ColorField?.syncAll?.();

    syncControls(options.from);
    if (options.remember) remember(value);
  }

  function syncControls(skip) {
    if (!root) return;
    const preview = root.querySelector(".studio-preview");
    if (preview) preview.style.background = current;

    const field = root.querySelector(".studio-hex-input");
    if (field && skip !== "hex" && document.activeElement !== field) {
      field.value = current.slice(1);
    }

    const [h, s, l] = rgbToHsl(...hexToRgb(current));
    const set = (selector, value) => {
      const slider = root.querySelector(selector);
      if (slider && skip !== "slider") slider.value = String(Math.round(value));
    };
    set(".studio-hue", h);
    set(".studio-sat", s);
    set(".studio-light", l);

    // The saturation and lightness tracks are only meaningful against the hue
    // you are actually on, so repaint them as it moves.
    const satTrack = root.querySelector(".studio-sat");
    if (satTrack) {
      satTrack.style.setProperty("--track",
        `linear-gradient(90deg, ${hslToHex(h, 0, l)}, ${hslToHex(h, 100, l)})`);
    }
    const lightTrack = root.querySelector(".studio-light");
    if (lightTrack) {
      lightTrack.style.setProperty("--track",
        `linear-gradient(90deg, #000, ${hslToHex(h, s, 50)}, #fff)`);
    }
  }

  function fromSliders() {
    const value = (selector) => Number(root.querySelector(selector)?.value || 0);
    apply(hslToHex(value(".studio-hue"), value(".studio-sat"), value(".studio-light")),
      { from: "slider" });
  }

  // ---------- picking a colour off something ----------

  const canPickScreen = typeof window.EyeDropper === "function";

  async function pickFromScreen() {
    if (!canPickScreen) return;
    setStatus("Tap anywhere to sample that colour…");
    try {
      const result = await new window.EyeDropper().open();
      apply(result.sRGBHex, { remember: true });
      setStatus("");
    } catch (error) {
      // Cancelling the eyedropper rejects; that is not a failure.
      setStatus("");
    }
  }

  // The eyedropper samples anything on screen — an imported PDF page, your own
  // drawing, a reference open behind the window. Firefox has no EyeDropper, so
  // loading an image and clicking it covers the same need everywhere.
  function pickFromImage(file) {
    if (!file) return;
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      const stage = root.querySelector(".studio-image-stage");
      const canvas = root.querySelector(".studio-image-canvas");
      if (!stage || !canvas) return;

      const scale = Math.min(1, 320 / Math.max(image.naturalWidth, image.naturalHeight));
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);

      stage.hidden = false;
      URL.revokeObjectURL(url);
      setStatus("Tap the image to take its colour.");
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      setStatus("That image could not be read.");
    };
    image.src = url;
  }

  function sampleCanvasAt(canvas, event) {
    const rect = canvas.getBoundingClientRect();
    const x = Math.round((event.clientX - rect.left) * (canvas.width / rect.width));
    const y = Math.round((event.clientY - rect.top) * (canvas.height / rect.height));
    const [r, g, b] = canvas.getContext("2d").getImageData(
      clamp(x, 0, canvas.width - 1), clamp(y, 0, canvas.height - 1), 1, 1
    ).data;
    apply(rgbToHex(r, g, b), { remember: true });
  }

  function setStatus(message) {
    const status = root?.querySelector(".studio-status");
    if (status) status.textContent = message || "";
  }

  // ---------- building ----------

  function swatchRow(className, colors) {
    return colors
      .map((color) => `<button type="button" class="${className}" data-studio-color="${color}"` +
        ` style="background:${color}" title="${color}" aria-label="${color}"></button>`)
      .join("");
  }

  function renderRecent() {
    const row = root?.querySelector(".studio-recent");
    if (!row) return;
    row.innerHTML = recent.length
      ? swatchRow("studio-swatch", recent)
      : '<span class="studio-empty">Colours you use will collect here.</span>';
  }

  function build() {
    root = document.createElement("div");
    root.className = "color-studio";
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-label", "Colour picker");
    root.hidden = true;

    root.innerHTML = `
      <div class="studio-head">
        <span class="studio-preview" aria-hidden="true"></span>
        <span class="studio-title">Colour</span>
        <button type="button" class="studio-copy" aria-label="Copy hex code" title="Copy hex code">
          ${window.Inkyscib?.Icon?.svg?.("lucide:copy", { size: 17 }) || ""}
        </button>
        <button type="button" class="studio-close" aria-label="Close colour picker">&times;</button>
      </div>

      <div class="studio-field-row">
        <label class="studio-field-label" for="studioHexInput">Hex</label>
        <div class="studio-hex">
          <span class="studio-hex-hash" aria-hidden="true">#</span>
          <input id="studioHexInput" class="studio-hex-input" type="text" maxlength="7"
            autocomplete="off" spellcheck="false" placeholder="ffffff"
            inputmode="text" aria-describedby="studioHexNote">
        </div>
      </div>
      <p class="studio-hex-note" id="studioHexNote" role="status" aria-live="polite"></p>

      <div class="studio-sliders">
        <label class="studio-slider-row"><span>Hue</span>
          <input class="studio-hue" type="range" min="0" max="360" step="1" aria-label="Hue"></label>
        <label class="studio-slider-row"><span>Saturation</span>
          <input class="studio-sat" type="range" min="0" max="100" step="1" aria-label="Saturation"></label>
        <label class="studio-slider-row"><span>Lightness</span>
          <input class="studio-light" type="range" min="0" max="100" step="1" aria-label="Lightness"></label>
      </div>

      <div class="studio-section">
        <span class="studio-label">Recent</span>
        <div class="studio-recent"></div>
      </div>

      <div class="studio-section">
        <span class="studio-label">Samples</span>
        <div class="studio-samples">${swatchRow("studio-swatch", SAMPLES)}</div>
      </div>

      <div class="studio-pick">
        <button type="button" class="studio-btn studio-screen"${canPickScreen ? "" : " hidden"}>
          Pick from screen
        </button>
        <button type="button" class="studio-btn studio-file">Pick from an image</button>
        <input class="studio-file-input" type="file" accept="image/*" hidden>
      </div>

      <div class="studio-image-stage" hidden>
        <canvas class="studio-image-canvas"></canvas>
      </div>

      <p class="studio-status" aria-live="polite"></p>
    `;

    document.body.appendChild(root);
    bind();
    renderRecent();
  }

  function bind() {
    root.addEventListener("click", (event) => {
      const swatch = event.target.closest("[data-studio-color]");
      if (swatch) {
        apply(swatch.dataset.studioColor, { remember: true });
        return;
      }
      if (event.target.closest(".studio-close")) close();
      if (event.target.closest(".studio-screen")) pickFromScreen();
      if (event.target.closest(".studio-file")) root.querySelector(".studio-file-input").click();
    });

    root.querySelector(".studio-file-input").addEventListener("change", (event) => {
      pickFromImage(event.target.files && event.target.files[0]);
      event.target.value = "";
    });

    root.querySelector(".studio-image-canvas").addEventListener("click", (event) => {
      sampleCanvasAt(event.currentTarget, event);
    });

    root.querySelectorAll(".studio-hue, .studio-sat, .studio-light").forEach((slider) => {
      slider.addEventListener("input", fromSliders);
      slider.addEventListener("change", () => remember(current));
    });

    const field = root.querySelector(".studio-hex-input");
    const note = root.querySelector(".studio-hex-note");

    function setNote(text, bad) {
      if (!note) return;
      note.textContent = text || "";
      note.classList.toggle("is-bad", !!bad);
    }

    // Typing over a code is what people do here, so land ready to overwrite
    // rather than making them select the old value first.
    field.addEventListener("focus", () => field.select());

    field.addEventListener("input", () => {
      // A hex copied from anywhere arrives with its #, and people paste it
      // into a field that already shows one. Take it either way.
      const raw = field.value.trim().replace(/^#+/, "");
      if (raw !== field.value.trim()) field.value = raw;

      const parsed = normalize(raw);
      if (parsed) {
        apply(parsed, { from: "hex" });
        setNote("");
      } else if (raw.length >= 3) {
        // Only complain once there is enough typed to be wrong; complaining at
        // one character is just shouting at someone mid-word.
        setNote("Needs 3 or 6 characters, 0-9 and a-f.", true);
      } else {
        setNote("");
      }
    });

    field.addEventListener("change", () => {
      const parsed = normalize(field.value);
      if (parsed) { remember(current); setNote(""); }
      else { field.value = current.slice(1); setNote(""); }
    });

    const copyBtn = root.querySelector(".studio-copy");
    copyBtn?.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(current);
        setNote("Copied " + current);
      } catch {
        // Clipboard blocked (insecure origin, denied permission). Select the
        // code instead so Ctrl+C still works.
        field.focus();
        field.select();
        setNote("Press Ctrl+C to copy");
      }
      window.setTimeout(() => setNote(""), 1600);
    });

    // The canvas listens for bare keys — space pans, Delete clears — so nothing
    // typed in here may reach it.
    root.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
        return;
      }
      event.stopPropagation();
    });

    document.addEventListener("pointerdown", (event) => {
      if (root.hidden) return;
      if (root.contains(event.target)) return;
      if (event.target.closest?.(".studio-trigger")) return;
      close();
    });

    // It belongs to the panel that opened it, so it never announces itself --
    // that would put its own panel away -- but it closes whenever any other
    // surface opens: a different tool's panel, the canvas theme, a File menu.
    // Its target is a colour field in the panel it came from, which is no
    // longer on screen once another surface has taken over.
    document.addEventListener("inkyscib:surface-open", () => {
      if (!root.hidden) close();
    });
  }

  // ---------- open / close ----------

  function open(picker, trigger) {
    if (!root) build();
    target = picker;
    current = normalize(picker?.value) || "#ffffff";

    root.hidden = false;
    root.querySelector(".studio-image-stage").hidden = true;
    setStatus("");
    syncControls();
    position(trigger);
    root.querySelector(".studio-hex-input")?.focus();
  }

  /**
   * Beside the panel that opened it, inside the area no bar covers.
   *
   * It used to open under its trigger, or above it when there was no room --
   * and on a 960x600 tablet there never was, so "above" clamped to y=10 and
   * the studio covered the toolbar (six buttons, Undo and Redo among them).
   * On a wide screen it opened at the trigger's own x, inside the dock, over
   * the panel it came from. Now: to the right of that panel if it fits, to
   * its left if that fits, and over it only when the screen is too narrow
   * for either -- always between the bars and the footer, scrolling itself
   * when it is taller than the room left.
   */
  function position(trigger) {
    const anchor = trigger?.getBoundingClientRect?.();
    if (!anchor) return;

    const gap = 8;
    const area = window.Inkyscib?.ToolDock?.freeArea?.() || {
      top: gap, bottom: window.innerHeight - gap, left: gap, right: window.innerWidth - gap
    };
    const room = Math.max(160, area.bottom - area.top);
    root.style.maxHeight = room + "px";
    root.style.overflowY = "auto";

    // Measure after capping, so the height used below is the one on screen.
    const box = root.getBoundingClientRect();
    // The dock before the panel: docked, the panel sits inside the dock's
    // frame and padding, so "beside the panel" still overlapped the dock.
    const owner = trigger.closest?.(".tool-dock") || trigger.closest?.(".tool-options");
    const beside = owner ? owner.getBoundingClientRect() : anchor;

    let left;
    if (beside.right + gap + box.width <= area.right) left = beside.right + gap;
    else if (beside.left - gap - box.width >= area.left) left = beside.left - gap - box.width;
    else left = clamp(anchor.left, area.left, area.right - box.width);

    // Level with the trigger, so the eye does not have to travel, then held
    // inside the free area.
    const top = clamp(anchor.top - 12, area.top, Math.max(area.top, area.bottom - box.height));

    root.style.left = Math.round(left) + "px";
    root.style.top = Math.round(top) + "px";
  }

  function close() {
    if (!root) return;
    root.hidden = true;
    target = null;
  }

  // ---------- the trigger on every hex field ----------

  // color-field.js puts a .hex-field beside every colour input. Hanging the
  // trigger off that is what makes one picker serve every tool, including any
  // tool added later.
  function mountTriggers() {
    document.querySelectorAll(".hex-field").forEach((wrap) => {
      if (wrap.dataset.studioReady === "true") return;
      wrap.dataset.studioReady = "true";

      const picker = wrap.previousElementSibling;
      if (!picker || picker.type !== "color") return;

      const button = document.createElement("button");
      button.type = "button";
      button.className = "studio-trigger";
      button.title = "Open the colour picker";
      button.setAttribute("aria-label", "Open the colour picker");
      button.innerHTML = '<span aria-hidden="true"></span>';
      button.addEventListener("click", (event) => {
        event.preventDefault();
        if (!root?.hidden && target === picker) close();
        else open(picker, button);
      });
      wrap.appendChild(button);
    });
  }

  function init() {
    loadRecent();
    mountTriggers();
    // Panels are built and relocated after load (tool-dock.js moves them), so
    // re-scan whenever the dock changes hands.
    document.addEventListener("toolChanged", () => {
      // The open picker belongs to the panel that is going away. Leaving it up
      // would have it quietly editing the previous tool's colour.
      close();
      window.setTimeout(mountTriggers, 0);
    });
  }

  window.Inkyscib = window.Inkyscib || {};
  window.Inkyscib.ColorStudio = {
    open, close, mountTriggers,
    // exported for tests
    hslToHex, rgbToHsl, hexToRgb, rgbToHex,
    getRecent: () => recent.slice()
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
