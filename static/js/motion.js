// MAETHIST v3 motion (static/css/motion.css, the premium layer in brutal.css).
//
// window.Inkyscib.Motion.themeWipe(change, fromElement) runs a theme change
// inside a view transition, so the new look grows out of the control that
// was pressed. Without the API, or under reduced motion, it just runs the
// change. The rest is the homepage: blocks rise in as they scroll into view,
// the demo window leans toward the pointer, a light follows the pointer
// across the tiles and the header settles once you scroll.
//
// Nothing here touches the ink, and every listener is passive.
(() => {
  "use strict";

  const root = document.documentElement;
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
  const finePointer = window.matchMedia("(hover: hover) and (pointer: fine)");

  // ---------- theme wipe ----------

  function themeWipe(change, fromElement) {
    if (typeof change !== "function") return;
    if (reduce.matches || typeof document.startViewTransition !== "function") {
      change();
      return;
    }
    let x = window.innerWidth / 2;
    let y = 0;
    const rect = fromElement && fromElement.getBoundingClientRect ? fromElement.getBoundingClientRect() : null;
    if (rect && rect.width) {
      x = rect.left + rect.width / 2;
      y = rect.top + rect.height / 2;
    }
    const radius = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));
    root.style.setProperty("--mx-x", x + "px");
    root.style.setProperty("--mx-y", y + "px");
    root.style.setProperty("--mx-r", Math.ceil(radius) + "px");
    root.classList.add("mx-theme-wipe");
    let transition;
    try {
      transition = document.startViewTransition(change);
    } catch (error) {
      root.classList.remove("mx-theme-wipe");
      change();
      return;
    }
    transition.finished.finally(() => root.classList.remove("mx-theme-wipe"));
  }

  // ---------- the press: anticipation, squash, stretch, follow-through ----------
  //
  // DESIGN.md, "Motion principles". On pointerdown a button squashes into its
  // shadow at once (anticipation, and the Doherty threshold: the answer starts
  // in the same frame). On release it stretches past its rest shape and
  // settles (follow-through), on an arc of scale rather than a straight line.
  // It uses the `scale` property, which composes with any `transform` the
  // element already has, and a transition, so a quick re-press interrupts it
  // mid-way instead of waiting for it to finish.
  const PRESSABLE = "button, [role='button'], .file-ribbon-tab, a.nb-btn, a.cta, .nb-btn";
  let pressed = null;

  function pressStart(event) {
    if (reduce.matches || event.button > 0) return;
    const el = event.target.closest && event.target.closest(PRESSABLE);
    if (!el || el.disabled || el.closest("[data-no-squash]") || el.matches("input, select, textarea")) return;
    pressed = el;
    el.classList.remove("mx-release");
    el.classList.add("mx-press");
  }

  function pressEnd() {
    const el = pressed;
    pressed = null;
    if (!el) return;
    el.classList.remove("mx-press");
    // Restart the release even when the previous one is still running.
    void el.offsetWidth;
    el.classList.add("mx-release");
    window.setTimeout(() => el.classList.remove("mx-release"), 360);
  }

  document.addEventListener("pointerdown", pressStart, { passive: true, capture: true });
  document.addEventListener("pointerup", pressEnd, { passive: true, capture: true });
  document.addEventListener("pointercancel", pressEnd, { passive: true, capture: true });

  // ---------- staggering ----------
  //
  // A set arrives one after another, 28ms apart, so the eye reads it as a
  // set and follows its order. Capped at twelve, so a long list never makes
  // the last row wait.
  function stagger(container) {
    if (!container) return;
    const items = [...container.children];
    items.forEach((item, i) => item.style.setProperty("--mx-i", String(Math.min(i, 12))));
    container.classList.remove("mx-stagger");
    void container.offsetWidth;
    container.classList.add("mx-stagger");
  }

  // ---------- origin awareness ----------
  //
  // A surface grows out of the control that opened it, so the eye knows
  // where it came from and where it will go back to.
  function originFrom(surface, trigger) {
    if (!surface || !trigger) return;
    const s = surface.getBoundingClientRect();
    const t = trigger.getBoundingClientRect();
    if (!s.width || !t.width) return;
    const x = t.left + t.width / 2 - s.left;
    const y = t.top + t.height / 2 - s.top;
    surface.style.setProperty("--mx-ox", Math.round(x) + "px");
    surface.style.setProperty("--mx-oy", Math.round(y) + "px");
    surface.classList.remove("mx-origin");
    void surface.offsetWidth;
    surface.classList.add("mx-origin");
  }

  // ---------- rubber banding ----------
  //
  // Past a limit, a drag keeps moving but with growing resistance, the way a
  // phone's list stretches at its end, so the limit is felt rather than hit.
  // `reach` is how far, in px, it can ever be pulled past the limit.
  function rubber(value, lo, hi, reach = 90) {
    if (value < lo) return lo - reach * (1 - 1 / ((lo - value) / reach * 0.55 + 1));
    if (value > hi) return hi + reach * (1 - 1 / ((value - hi) / reach * 0.55 + 1));
    return value;
  }

  window.Inkyscib = window.Inkyscib || {};
  window.Inkyscib.Motion = { themeWipe, stagger, originFrom, rubber };

  // ---------- marketing pages only ----------

  const isMarketing = !!document.querySelector("header .logo") && !document.getElementById("canvas");
  if (!isMarketing) return;

  // The header settles once the page has moved.
  const header = document.querySelector("header");
  if (header) {
    let ticking = false;
    const sync = () => {
      ticking = false;
      header.classList.toggle("is-scrolled", window.scrollY > 8);
    };
    window.addEventListener("scroll", () => {
      if (!ticking) {
        ticking = true;
        window.requestAnimationFrame(sync);
      }
    }, { passive: true });
    sync();
  }

  if (reduce.matches) return;

  // Blocks rise in as they arrive. Only blocks wholly below the fold at load
  // are ever hidden, so nothing on the first screen waits on this script.
  if ("IntersectionObserver" in window) {
    const blocks = [...document.querySelectorAll(
      ".nb-section-head, .nb-tile, .nb-stat, .nb-step, .nb-final, main .panel, main .card, main .principle"
    )].filter((el) => el.getBoundingClientRect().top > window.innerHeight);

    if (blocks.length) {
      const seen = new Map();
      blocks.forEach((el) => {
        const parent = el.parentElement;
        const index = seen.get(parent) || 0;
        seen.set(parent, index + 1);
        el.style.setProperty("--mx-i", String(Math.min(index, 5)));
        el.classList.add("mx-r");
      });
      root.classList.add("mx-reveal");
      const observer = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          entry.target.classList.add("is-in");
          observer.unobserve(entry.target);
        });
      }, { rootMargin: "0px 0px -8% 0px", threshold: 0.08 });
      blocks.forEach((el) => observer.observe(el));
      // Printing must never leave a gap.
      window.addEventListener("beforeprint", () => blocks.forEach((el) => el.classList.add("is-in")));
    }
  }

  if (!finePointer.matches) return;

  // A light follows the pointer across each tile.
  document.querySelectorAll(".nb-tile").forEach((tile) => {
    tile.addEventListener("pointermove", (event) => {
      const r = tile.getBoundingClientRect();
      tile.style.setProperty("--mx-x", (event.clientX - r.left) + "px");
      tile.style.setProperty("--mx-y", (event.clientY - r.top) + "px");
    }, { passive: true });
  });

  // The demo window leans a few degrees toward the pointer.
  const stage = document.querySelector(".nb-stage");
  const win = stage && stage.querySelector(".nb-window");
  if (stage && win) {
    let frame = 0;
    let px = 0.5;
    let py = 0.5;
    const paint = () => {
      frame = 0;
      win.style.setProperty("--mx-rx", ((0.5 - py) * 5).toFixed(2) + "deg");
      win.style.setProperty("--mx-ry", ((px - 0.5) * 7).toFixed(2) + "deg");
    };
    stage.addEventListener("pointermove", (event) => {
      const r = stage.getBoundingClientRect();
      px = Math.min(1, Math.max(0, (event.clientX - r.left) / r.width));
      py = Math.min(1, Math.max(0, (event.clientY - r.top) / r.height));
      win.classList.add("is-tracking");
      if (!frame) frame = window.requestAnimationFrame(paint);
    }, { passive: true });
    stage.addEventListener("pointerleave", () => {
      win.classList.remove("is-tracking");
      px = 0.5;
      py = 0.5;
      if (!frame) frame = window.requestAnimationFrame(paint);
    }, { passive: true });
  }
})();
