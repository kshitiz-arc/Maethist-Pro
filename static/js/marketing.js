// Shared behaviour for the marketing pages (home, features, about).
//
// The starfield, the nebula parallax and the "SYSTEM READY" ticker used to
// live here. They animated a sci-fi frame that DESIGN.md retired: an
// instrument does not announce that it has booted.
//
// Two rules hold throughout:
//   1. Every block checks that what it drives is actually on the page. This
//      file is shared, and one missing element must never take the theme
//      toggle down with it.
//   2. Nothing here is load-bearing. With this file blocked the pages still
//      read, navigate and route into the editor.
(function () {
  "use strict";

  const root = document.documentElement;
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  // ---------- theme ----------
  //
  // data-theme on <html>, mirrored into localStorage under "theme" — the same
  // contract the editor reads, so the choice survives the walk into /write.

  const themeButton = document.getElementById("themeButton");
  const themeColor = document.querySelector('meta[name="theme-color"]');

  function applyTheme(theme) {
    const next = theme === "light" ? "light" : "dark";
    root.dataset.theme = next;
    if (themeButton) {
      themeButton.setAttribute(
        "aria-label",
        next === "light" ? "Switch to dark interface" : "Switch to light interface"
      );
    }
    if (themeColor) themeColor.content = next === "light" ? "#F3F7FB" : "#0E2238";
    try {
      localStorage.setItem("theme", next);
    } catch (error) {
      // Storage blocked: the theme still applies, it just is not remembered.
    }
  }

  // With no explicit choice the page follows the operating system, so the
  // toggle has to read what is actually on screen rather than assume dark.
  function resolvedTheme() {
    if (root.dataset.theme === "light" || root.dataset.theme === "dark") {
      return root.dataset.theme;
    }
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }

  if (themeButton) {
    const current = resolvedTheme();
    themeButton.setAttribute(
      "aria-label",
      current === "light" ? "Switch to dark interface" : "Switch to light interface"
    );
    themeButton.addEventListener("click", () => {
      const next = resolvedTheme() === "light" ? "dark" : "light";
      const wipe = window.Inkyscib && window.Inkyscib.Motion && window.Inkyscib.Motion.themeWipe;
      if (wipe) wipe(() => applyTheme(next), themeButton);
      else applyTheme(next);
    });
  }

  // ---------- canvas preview (homepage only) ----------

  const svg = document.getElementById("geometrySvg");
  const zoomValue = document.getElementById("zoomValue");
  const zoomIn = document.getElementById("zoomIn");
  const zoomOut = document.getElementById("zoomOut");

  let zoom = 100;

  function renderZoom() {
    if (zoomValue) zoomValue.textContent = zoom + "%";
    if (svg) svg.style.transform = "scale(" + zoom / 100 + ")";
  }

  function changeZoom(amount) {
    const next = Math.max(50, Math.min(200, zoom + amount));
    if (next === zoom) return;
    zoom = next;
    renderZoom();
  }

  if (zoomIn && zoomOut && zoomValue) {
    zoomIn.addEventListener("click", () => changeZoom(10));
    zoomOut.addEventListener("click", () => changeZoom(-10));
  }

  // Tool selection is a real toggle on a real preview, not a decorative row.
  const tools = document.querySelectorAll(".tool");

  tools.forEach((tool) => {
    tool.addEventListener("click", () => {
      tools.forEach((other) => {
        other.classList.remove("selected");
        other.setAttribute("aria-pressed", "false");
      });
      tool.classList.add("selected");
      tool.setAttribute("aria-pressed", "true");
    });
  });

  // ---------- geometry intro ----------

  // The construction draws itself once on arrival: circle, the three sides,
  // the arc, the altitude, then the points (brutal.css: .is-drawing). After
  // that it is a working demo (static/js/demo-canvas.js).
  if (svg && svg.querySelector(".draw") && !reduceMotion.matches) {
    window.requestAnimationFrame(() => window.setTimeout(() => {
      svg.classList.add("is-drawing");
      window.setTimeout(() => svg.classList.remove("is-drawing"), 1300);
    }, 120));
  }

})();
