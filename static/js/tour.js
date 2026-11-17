/* The welcome tour: what a new visitor sees the first time they open the
 * editor. Six short steps, each pointing at the real control it describes.
 *
 * Replaces the old 11-step onboarding.js and keeps its public interface, so
 * the File menu, the Planner and the tests did not have to change:
 *
 *   window.Inkyscib.FeatureTour.open({ step })   close({ markSeen })
 *   getStep()   reset()   isOpen()
 *
 * Seen-state lives in localStorage["inkyscib-feature-tour-v1"]; any value at
 * all means "already seen" (older builds stored other shapes). While open the
 * page carries body.feature-tour-open, which the canvas, Pomodoro and Planner
 * read to stay out of the way. Phosphor icons: the tour is a Phosphor surface.
 * Styles: static/css/tour.css.
 */
(function () {
  "use strict";

  const STORAGE_KEY = "inkyscib-feature-tour-v1";

  const STEPS = [
    {
      color: "yellow",
      icon: "sparkle",
      kicker: "Welcome",
      title: "Maths you can touch.",
      body: "MAETHIST is a free canvas for writing, building geometry and studying from your own books. Here is the 30-second version.",
      art: "welcome",
    },
    {
      color: "blue",
      icon: "pencil-simple",
      kicker: "Step 1 · Tools",
      title: "Pick a tool and write.",
      body: "Pen, highlighter, eraser, shapes, compass and angle all live on the tool bar. Tap the tool in your hand again to change its colour and size.",
      target: [".tool-rail", ".toolbar"],
      art: "tools",
    },
    {
      color: "red",
      icon: "file-pdf",
      kicker: "Step 2 · Your material",
      title: "Write on your own textbook.",
      body: "Insert opens a PDF, a PowerPoint or a picture. Pages convert on this device and you write straight on top of them.",
      target: [".file-ribbon"],
      art: "pdf",
    },
    {
      color: "purple",
      icon: "compass-tool",
      kicker: "Step 3 · Live geometry",
      title: "Constructions that stay live.",
      body: "Set the compass, sweep an arc, cross it with another. The points where they meet stay connected: drag the circle and everything follows.",
      target: ["#compassTool"],
      art: "geometry",
    },
    {
      color: "green",
      icon: "lock-simple",
      kicker: "Step 4 · Yours, and safe",
      title: "Saved here. Works offline.",
      body: "Everything saves in this browser as you go, with no account. It opens without a connection, and File › Back up everything keeps a copy you own.",
      art: "safe",
    },
    {
      color: "yellow",
      icon: "check-circle",
      kicker: "Ready",
      title: "Your page is waiting.",
      body: "Draw anywhere to start. The ? button lists every shortcut and gesture, and this tour lives in Tools whenever you want it back.",
      target: ["#toolDockHelp"],
      art: "ready",
      last: true,
    },
  ];

  const ART = {
    welcome: '<svg viewBox="0 0 200 160" aria-hidden="true"><rect class="w-fill-y" x="18" y="40" width="44" height="44" rx="10" transform="rotate(-8 40 62)"/><rect class="w-fill-r" x="132" y="30" width="52" height="20" rx="8" transform="rotate(6 158 40)"/><rect class="w-fill-b" x="26" y="112" width="54" height="16" rx="7"/><path class="w-stroke-thick" d="M108 16 V148 M44 86 H182"/><path class="w-stroke" d="M138 104 l30 30 M168 104 l-30 30"/></svg>',
    tools: '<svg viewBox="0 0 200 160" aria-hidden="true"><rect class="w-card" x="24" y="18" width="46" height="124" rx="12"/><rect class="w-fill-y" x="33" y="30" width="28" height="28" rx="8"/><circle class="w-dot" cx="47" cy="78" r="7"/><circle class="w-dot" cx="47" cy="102" r="7"/><circle class="w-dot" cx="47" cy="126" r="7"/><path class="w-stroke" d="M92 112 C112 62 132 136 152 82 S178 58 186 72"/></svg>',
    pdf: '<svg viewBox="0 0 200 160" aria-hidden="true"><rect class="w-card" x="46" y="14" width="96" height="128" rx="10" transform="rotate(-5 94 78)"/><rect class="w-card" x="58" y="20" width="96" height="128" rx="10"/><path class="w-line" d="M74 46 H136 M74 62 H136 M74 78 H118"/><path class="w-ink" d="M72 106 C92 92 104 120 124 100 S146 92 150 104"/><rect class="w-fill-r" x="122" y="118" width="42" height="22" rx="7"/></svg>',
    geometry: '<svg viewBox="0 0 200 160" aria-hidden="true"><circle class="w-stroke" cx="80" cy="82" r="50"/><circle class="w-stroke" cx="124" cy="82" r="50"/><path class="w-ink" d="M102 37 V127"/><circle class="w-fill-y" cx="102" cy="37" r="8"/><circle class="w-fill-y" cx="102" cy="127" r="8"/></svg>',
    safe: '<svg viewBox="0 0 200 160" aria-hidden="true"><rect class="w-card" x="54" y="62" width="92" height="74" rx="14"/><path class="w-stroke-thick" d="M76 62 V44 a24 24 0 0 1 48 0 V62"/><circle class="w-fill-g" cx="100" cy="96" r="12"/><path class="w-stroke" d="M100 106 V120"/><path class="w-line" d="M20 30 h20 M164 120 h20 M170 30 l10 10"/></svg>',
    ready: '<svg viewBox="0 0 200 160" aria-hidden="true"><rect class="w-card" x="30" y="22" width="140" height="116" rx="14"/><path class="w-ink" d="M56 98 C76 58 96 120 118 78 S146 62 150 86"/><circle class="w-fill-y" cx="150" cy="40" r="16"/><path class="w-stroke" d="M143 40 l5 5 l9 -10"/></svg>',
  };

  const state = { open: false, current: 0, root: null, ring: null, card: null, lastFocus: null };

  const icon = (name) => window.Inkyscib?.Icon?.svg?.("phosphor:" + name) || "";

  function seen() {
    try { return !!window.localStorage.getItem(STORAGE_KEY); } catch (error) { return !!window.__inkyscibFeatureTourSeen; }
  }

  function markSeen() {
    window.__inkyscibFeatureTourSeen = true;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 3, completedAt: new Date().toISOString() }));
    } catch (error) { /* blocked storage: the flag above still holds for this visit */ }
  }

  function build() {
    if (state.root) return;
    const root = document.createElement("div");
    root.id = "featureTour";
    root.className = "welcome";
    root.dataset.iconSet = "phosphor";
    root.hidden = true;
    root.innerHTML = `
      <div class="welcome-ring" aria-hidden="true"></div>
      <section class="welcome-card" role="dialog" aria-modal="true" aria-labelledby="welcomeTitle" aria-describedby="welcomeBody" tabindex="-1">
        <div class="welcome-art"></div>
        <div class="welcome-copy">
          <div class="welcome-top">
            <span class="welcome-kicker"></span>
            <button class="welcome-close" type="button" aria-label="Close the tour">${icon("x")}</button>
          </div>
          <h2 class="welcome-title" id="welcomeTitle"></h2>
          <p class="welcome-body" id="welcomeBody"></p>
          <div class="welcome-foot">
            <div class="welcome-dots" role="group" aria-label="Tour steps"></div>
            <div class="welcome-actions">
              <button class="welcome-back" type="button">${icon("arrow-left")}<span>Back</span></button>
              <button class="welcome-next" type="button"><span>Next</span>${icon("arrow-right")}</button>
            </div>
          </div>
        </div>
      </section>`;
    document.body.appendChild(root);
    state.root = root;
    state.ring = root.querySelector(".welcome-ring");
    state.card = root.querySelector(".welcome-card");

    const dots = root.querySelector(".welcome-dots");
    STEPS.forEach((step, index) => {
      const dot = document.createElement("button");
      dot.type = "button";
      dot.className = "welcome-dot";
      dot.setAttribute("aria-label", `Go to step ${index + 1} of ${STEPS.length}`);
      dot.addEventListener("click", () => go(index));
      dots.appendChild(dot);
    });

    root.querySelector(".welcome-close").addEventListener("click", () => closeTour(true));
    root.querySelector(".welcome-back").addEventListener("click", () => go(state.current - 1));
    root.querySelector(".welcome-next").addEventListener("click", () => {
      if (STEPS[state.current].last) closeTour(true);
      else go(state.current + 1);
    });
    root.addEventListener("keydown", onKey);
    root.addEventListener("click", (event) => {
      if (event.target === root) closeTour(true);
    });
  }

  function onKey(event) {
    if (event.key === "Escape") { event.preventDefault(); closeTour(true); return; }
    if (event.key === "ArrowRight") { event.preventDefault(); if (!STEPS[state.current].last) go(state.current + 1); return; }
    if (event.key === "ArrowLeft") { event.preventDefault(); go(state.current - 1); return; }
    if (event.key === "Tab") {
      const focusable = [...state.card.querySelectorAll("button:not([disabled])")].filter((el) => el.offsetParent !== null);
      if (!focusable.length) return;
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
    event.stopPropagation();
  }

  function visibleTarget(selectors) {
    for (const selector of selectors || []) {
      const el = document.querySelector(selector);
      if (!el) continue;
      const box = el.getBoundingClientRect();
      if (box.width > 4 && box.height > 4 && box.bottom > 0 && box.top < window.innerHeight) return el;
    }
    return null;
  }

  function placeRing() {
    if (!state.open) return;
    const target = visibleTarget(STEPS[state.current].target);
    const ring = state.ring;
    if (!target) {
      ring.classList.remove("is-on");
      state.root.classList.remove("has-target");
      return;
    }
    const box = target.getBoundingClientRect();
    const pad = 6;
    ring.style.left = Math.max(4, box.left - pad) + "px";
    ring.style.top = Math.max(4, box.top - pad) + "px";
    ring.style.width = Math.min(window.innerWidth - 8, box.width + pad * 2) + "px";
    ring.style.height = box.height + pad * 2 + "px";
    ring.classList.add("is-on");
    state.root.classList.add("has-target");
  }

  function go(index) {
    const next = Math.max(0, Math.min(STEPS.length - 1, index));
    state.current = next;
    const step = STEPS[next];
    const root = state.root;
    root.dataset.color = step.color;
    root.querySelector(".welcome-kicker").textContent = step.kicker;
    root.querySelector(".welcome-title").textContent = step.title;
    root.querySelector(".welcome-body").textContent = step.body;
    root.querySelector(".welcome-art").innerHTML =
      `<span class="welcome-art-icon">${icon(step.icon)}</span>${ART[step.art] || ""}`;
    root.querySelectorAll(".welcome-dot").forEach((dot, i) => {
      dot.classList.toggle("is-current", i === next);
      dot.classList.toggle("is-done", i < next);
      if (i === next) dot.setAttribute("aria-current", "step"); else dot.removeAttribute("aria-current");
    });
    const back = root.querySelector(".welcome-back");
    back.disabled = next === 0;
    back.hidden = next === 0;
    root.querySelector(".welcome-next span").textContent = step.last ? "Start writing" : "Next";
    state.card.classList.remove("is-changing");
    void state.card.offsetWidth;
    state.card.classList.add("is-changing");
    placeRing();
  }

  function openTour(options = {}) {
    build();
    if (state.open) { go(options.step ?? state.current); return; }
    state.lastFocus = document.activeElement;
    state.open = true;
    state.root.hidden = false;
    document.body.classList.add("feature-tour-open");
    window.requestAnimationFrame(() => state.root.classList.add("is-open"));
    go(options.step ?? 0);
    state.card.focus({ preventScroll: true });
    window.addEventListener("resize", placeRing, { passive: true });
  }

  function closeTour(remember = true) {
    if (!state.open) return;
    state.open = false;
    if (remember) markSeen();
    state.root.classList.remove("is-open");
    document.body.classList.remove("feature-tour-open");
    window.removeEventListener("resize", placeRing);
    window.setTimeout(() => { if (!state.open) state.root.hidden = true; }, 220);
    if (state.lastFocus && state.lastFocus.focus) state.lastFocus.focus({ preventScroll: true });
  }

  function waitForBootAndOpen() {
    if (seen()) return;
    const started = Date.now();
    const tick = () => {
      if (seen()) return;
      // Wait for the editor to finish loading, then give it a breath so the
      // first thing a new visitor sees is the canvas, not a dialog.
      if (window.appState?.storageReady || Date.now() - started > 6000) {
        window.setTimeout(() => { if (!seen() && !state.open) openTour({ step: 0 }); }, 700);
        return;
      }
      window.setTimeout(tick, 120);
    };
    tick();
  }

  function init() {
    window.Inkyscib = window.Inkyscib || {};
    window.Inkyscib.FeatureTour = {
      open: openTour,
      close: (options = {}) => closeTour(options.markSeen !== false),
      getStep: () => state.current,
      reset: () => {
        try { window.localStorage.removeItem(STORAGE_KEY); } catch (error) { /* blocked */ }
        window.__inkyscibFeatureTourSeen = false;
        openTour({ step: 0 });
      },
      isOpen: () => state.open,
    };
    const replay = document.getElementById("featureTourBtn");
    if (replay) replay.addEventListener("click", () => openTour({ step: 0 }));
    waitForBootAndOpen();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init, { once: true });
  else init();
})();
