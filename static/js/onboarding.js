(function () {
  "use strict";

  const STORAGE_KEY = "inkyscib-feature-tour-v1";
  const MENU_TRANSITION_MS = 280;
  const state = {
    current: 0,
    open: false,
    previousFocus: null,
    layoutFrame: 0,
    layoutTimer: 0,
    bootObserver: null,
  };

  const svg = (content, viewBox = "0 0 24 24") =>
    `<svg viewBox="${viewBox}" aria-hidden="true">${content}</svg>`;

  const icons = {
    pen: svg('<path d="m4 20 4.2-1 10-10a2.4 2.4 0 0 0-3.4-3.4l-10 10L4 20Z"/><path d="m13.5 7 3.5 3.5"/>'),
    select: svg('<path d="M5 3 18 14l-5.5 1.2 3 5.8-2.8 1.2-3-5.7-4 3.8Z"/>'),
    eraser: svg('<path d="m5 15 8-8a2.5 2.5 0 0 1 3.5 0l2 2a2.5 2.5 0 0 1 0 3.5L13 18H8Z"/><path d="m11 9 5 5"/><path d="M13 18h7"/>'),
    highlight: svg('<path d="m5 15 9-9 4 4-9 9-5 1Z"/><path d="m12 8 4 4"/><path d="M3 22h17"/>'),
    shape: svg('<circle cx="8" cy="9" r="4"/><rect x="12" y="12" width="8" height="8" rx="1"/>'),
    line: svg('<path d="M4 18 19 5"/><path d="m14 5 5 0 0 5"/>'),
    local: svg('<path d="M7 8V6a5 5 0 0 1 10 0v2"/><rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 12v4"/>'),
    move: svg('<path d="M12 3v18M3 12h18"/><path d="m12 3-3 3m3-3 3 3m-3 15-3-3m3 3 3-3M3 12l3-3m-3 3 3 3m15-3-3-3m3 3-3 3"/>'),
    zoom: svg('<circle cx="10" cy="10" r="6"/><path d="m15 15 5 5M10 7v6M7 10h6"/>'),
    pressure: svg('<path d="M5 18c4-8 7 4 14-10"/><path d="M5 21h14"/>'),
    palette: svg('<path d="M12 3a9 9 0 1 0 0 18h1.2a2 2 0 0 0 0-4H12a2 2 0 0 1 0-4h3a6 6 0 0 0-3-10Z"/><circle cx="7.5" cy="9" r=".8"/><circle cx="10" cy="6.5" r=".8"/><circle cx="15" cy="7" r=".8"/>'),
    slider: svg('<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="2"/><circle cx="15" cy="17" r="2"/>'),
    styles: svg('<path d="M4 6h16M4 12h10M4 18h16"/><path d="M16 12h1m2 0h1"/>'),
    notebook: svg('<path d="M6 4h12v16H6z"/><path d="M9 4v16M3.5 7H7m-3.5 5H7m-3.5 5H7"/>'),
    pattern: svg('<circle cx="6" cy="6" r="1"/><circle cx="12" cy="6" r="1"/><circle cx="18" cy="6" r="1"/><circle cx="6" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="18" cy="12" r="1"/><circle cx="6" cy="18" r="1"/><circle cx="12" cy="18" r="1"/><circle cx="18" cy="18" r="1"/>'),
    backup: svg('<path d="M5 4h11l3 3v13H5z"/><path d="M8 4v6h7V4M8 16h8"/>'),
    pages: svg('<path d="M7 3h10v14H7z"/><path d="M4 7v14h10"/>'),
    pdf: svg('<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v5h4M8.5 15h7M8.5 18h5"/>'),
    slides: svg('<rect x="3" y="5" width="18" height="13" rx="2"/><path d="M7 9h5M7 12h9M7 15h7"/>'),
    export: svg('<path d="M12 16V4M8 8l4-4 4 4"/><path d="M5 13v7h14v-7"/>'),
    video: svg('<rect x="3" y="5" width="18" height="14" rx="3"/><path d="m10 9 5 3-5 3Z"/>'),
    timer: svg('<circle cx="12" cy="13" r="8"/><path d="M12 13V8m-3-5h6"/>'),
    capture: svg('<path d="M5 8h3l1.5-2h5L16 8h3v11H5z"/><circle cx="12" cy="13" r="3"/>'),
    camera: svg('<path d="M5 8h3l1.5-2h5L16 8h3a2 2 0 0 1 2 2v8H3v-8a2 2 0 0 1 2-2Z"/><circle cx="12" cy="13" r="3"/>'),
    location: svg('<path d="M4 7h16M4 17h16"/><path d="m8 4-3 3 3 3m8 4 3 3-3 3"/>'),
    theme: svg('<circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 1 0 16Z"/>'),
    history: svg('<path d="M7 7H3v4"/><path d="M3.5 11A8 8 0 1 1 6 18"/><path d="M12 8v5l3 2"/>'),
    keyboard: svg('<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M6 10h1m3 0h1m3 0h1m3 0h1M7 14h10"/>'),
    calendar: svg('<rect x="3.5" y="5.5" width="17" height="15" rx="3"/><path d="M7.5 3.5v4m9-4v4m-13 2h17"/><path d="m8 15 2 2 5-5"/>'),
    bell: svg('<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M10 20h4"/>'),
    repeat: svg('<path d="m17 2 4 4-4 4"/><path d="M3 11V9a3 3 0 0 1 3-3h15"/><path d="m7 22-4-4 4-4"/><path d="M21 13v2a3 3 0 0 1-3 3H3"/>'),
    progress: svg('<path d="M4 18V8m5 10V4m5 14v-6m5 6V7"/><path d="M2 21h20"/>'),
    tile: svg('<rect x="4" y="4" width="7" height="7" rx="1"/><rect x="13" y="4" width="7" height="16" rx="1"/><rect x="4" y="13" width="7" height="7" rx="1"/>'),
    compass: svg('<circle cx="12" cy="5" r="1.3" fill="currentColor" stroke="none"/><path d="M10.8 6.3 5.8 19"/><path d="M13.2 6.3 18.2 19"/><path d="M8.3 15.5h2.4"/>'),
    angle: svg('<path d="M4 20h16"/><path d="M4 20 16 6"/><path d="M8 20a8 8 0 0 1 3-6.2"/>'),
  };

  const featurePills = (items) => items.map(([name, label]) => `
    <div class="tour-feature-pill">
      ${icons[name] || ""}
      <span>${label}</span>
    </div>
  `).join("");

  const visuals = {
    welcome: `
      <div class="feature-tour-visual tour-welcome-visual" aria-hidden="true">
        <div class="tour-welcome-board">
          <div class="tour-welcome-toolrail"><span></span><span></span><span></span><span></span></div>
          <svg viewBox="0 0 260 70">
            <defs><linearGradient id="tourWelcomeGradient"><stop stop-color="#7777ff"/><stop offset="1" stop-color="#67e8f9"/></linearGradient></defs>
            <path class="tour-welcome-stroke" d="M8 49c32-34 52 25 83-5 27-27 42 20 68-9 28-31 52 19 92-14"/>
          </svg>
        </div>
        <span class="tour-welcome-badge local">Local-first</span>
        <span class="tour-welcome-badge free">No account</span>
      </div>`,
    canvas: `
      <div class="feature-tour-visual tour-canvas-visual" aria-hidden="true">
        <div class="tour-canvas-sheet">
          <svg viewBox="0 0 230 100"><path d="M9 65c28-47 51 25 83-12s52 25 88-11c14-14 28-15 42-5"/><path d="M22 78c42-8 82-7 123-13"/></svg>
        </div>
        <div class="tour-canvas-gestures">
          <div class="tour-canvas-gesture">${icons.zoom}</div>
          <div class="tour-canvas-gesture">${icons.move}</div>
        </div>
      </div>`,
    tools: `
      <div class="feature-tour-visual tour-tools-visual" aria-hidden="true">
        <div class="tour-tools-row">
          <span class="tour-tool-chip">${icons.select}</span>
          <span class="tour-tool-chip is-active">${icons.pen}</span>
          <span class="tour-tool-chip">${icons.eraser}</span>
          <span class="tour-tool-chip">${icons.highlight}</span>
          <span class="tour-tool-chip">${icons.shape}</span>
          <span class="tour-tool-chip">${icons.line}</span>
        </div>
        <div class="tour-tools-caption"><span>Move + resize</span><span>Ink + mark</span><span>Shapes + arrows</span></div>
      </div>`,
    controls: `
      <div class="feature-tour-visual tour-controls-visual" aria-hidden="true">
        <div class="tour-control-swatches">
          <span style="--swatch:#f8fafc"></span><span style="--swatch:#60a5fa"></span><span style="--swatch:#f87171"></span><span style="--swatch:#4ade80"></span><span></span>
        </div>
        <div class="tour-control-slider"></div>
        <div class="tour-stroke-styles"><span><i style="--stroke:2px"></i></span><span><i style="--stroke:1px"></i></span><span><i style="--stroke:5px"></i></span><span><i style="--stroke:3px"></i></span><span><i style="--stroke:4px"></i></span></div>
      </div>`,
    library: `
      <div class="feature-tour-visual tour-library-visual" aria-hidden="true">
        <div class="tour-notebook-stack"><div class="tour-notebook"></div><div class="tour-notebook"></div><div class="tour-notebook"><strong>Physics</strong><small>24 pages</small></div></div>
        <div class="tour-library-list">
          <div class="tour-library-item"><span style="--book:#7777ff"></span><strong>Physics</strong><em>Today</em></div>
          <div class="tour-library-item"><span style="--book:#56e39f"></span><strong>Chemistry</strong><em>8 pages</em></div>
          <div class="tour-library-item"><span style="--book:#ffd36a"></span><strong>Math</strong><em>Deck</em></div>
        </div>
      </div>`,
    files: `
      <div class="feature-tour-visual tour-files-visual" aria-hidden="true">
        <div class="tour-file-card import">${icons.pdf}<span>PDF / PPT</span></div><span class="tour-file-arrow">→</span>
        <div class="tour-file-card markup">${icons.pen}<span>Annotate</span></div><span class="tour-file-arrow">→</span>
        <div class="tour-file-card export">${icons.export}<span>PDF / PPTX</span></div>
      </div>`,
    focus: `
      <div class="feature-tour-visual tour-focus-visual" aria-hidden="true">
        <div class="tour-focus-window"><div class="tour-focus-video"><span class="tour-focus-play"></span></div><div class="tour-focus-notes"></div></div>
        <div class="tour-pomo-clock"><span>25:00</span></div><div class="tour-capture-chip">Save moment</div>
      </div>`,
    planner: `
      <div class="feature-tour-visual tour-planner-visual" aria-hidden="true">
        <div class="tour-planner-calendar">
          <div class="tour-planner-calendar-head"><strong>JUL</strong><span>2026</span></div>
          <div class="tour-planner-days">
            <i></i><i></i><i></i><i></i><i></i><i></i><i></i>
            <i></i><i></i><i class="has-task"></i><i></i><i></i><i></i><i class="is-selected">18</i>
          </div>
        </div>
        <div class="tour-planner-tasks">
          <div class="tour-planner-progress"><span></span><em>67%</em></div>
          <div class="tour-planner-task is-done"><i>✓</i><span></span></div>
          <div class="tour-planner-task"><i></i><span></span></div>
          <div class="tour-planner-task"><i></i><span></span></div>
        </div>
      </div>`,
    ar: `
      <div class="feature-tour-visual tour-ar-visual" aria-hidden="true">
        <div class="tour-ar-camera"><div class="tour-ar-airline"></div><div class="tour-ar-hand">
          <svg viewBox="0 0 90 100"><path d="M18 76 27 42m0 0 3-28m-3 28 15-34m-9 40 23-36m-15 43 27-27m-38 46c12 14 31 18 42 6 8-9 9-24-4-35"/><circle cx="30" cy="14" r="3"/><circle cx="42" cy="8" r="3"/><circle cx="56" cy="12" r="3"/><circle cx="68" cy="28" r="3"/><circle cx="18" cy="76" r="3"/></svg>
        </div></div>
        <div class="tour-location-switch"><div>↑ Toolbar top</div><div>↓ Toolbar bottom</div><div>☀ Light / dark</div></div>
      </div>`,
    ready: `
      <div class="feature-tour-visual tour-ready-visual" aria-hidden="true">
        <div class="tour-ready-orbit"><span class="tour-ready-core">✓</span><span class="tour-ready-dot">INK</span><span class="tour-ready-dot">PDF</span><span class="tour-ready-dot">YT</span><span class="tour-ready-dot">25</span></div>
      </div>`,
    math: `
      <div class="feature-tour-visual tour-tools-visual" aria-hidden="true">
        <div class="tour-tools-row">
          <span class="tour-tool-chip is-active">${icons.tile}</span>
          <span class="tour-tool-chip">${icons.compass}</span>
          <span class="tour-tool-chip">${icons.angle}</span>
        </div>
        <div class="tour-tools-caption"><span>Tiles + variables</span><span>Circle constructions</span><span>Live measurements</span></div>
      </div>`,
  };

  const steps = [
    {
      kicker: "Welcome to Inkyscib",
      title: "One canvas. Your whole study flow.",
      copy: "This quick visual tour maps the workspace before you make your first mark. Nothing to configure, and the guide itself runs entirely in your browser.",
      visual: visuals.welcome,
      features: [["local", "Local-first workspace"], ["pen", "Write naturally"], ["video", "Study beside video"], ["notebook", "Organize notebooks"]],
      hint: "About a minute. Use the progress rail to jump to any chapter.",
      target: null,
    },
    {
      kicker: "Your workspace",
      title: "Draw freely. Move around endlessly.",
      copy: "The center is an <strong>infinite, pressure-aware canvas</strong>. Write with a pen or finger, pinch or scroll to zoom, and use Pan to travel without changing your ink.",
      visual: visuals.canvas,
      features: [["pressure", "Pressure-aware strokes"], ["zoom", "Pinch / wheel zoom"], ["move", "Pan in any direction"], ["local", "Auto-saved locally"]],
      hint: "Your drawing and preferences restore automatically on this device.",
      target: "#workspaceShell",
      padding: 6,
      radius: 22,
    },
    {
      kicker: "Drawing toolkit",
      title: "Every mark starts here.",
      copy: "Select ink to <strong>move and resize</strong>, write with Pen, clean with Eraser, layer a Highlighter, or build precise shapes, straight lines, dotted lines, and arrows.",
      visual: visuals.tools,
      features: [["select", "Select + transform"], ["pen", "Pen + five styles"], ["highlight", "Highlighter + eraser"], ["shape", "Shapes + custom arrows"]],
      hint: "Tap an active drawing tool again on compact screens to open its controls.",
      // On wide screens the drawing tools live in the left rail, not the
      // toolbar (which becomes the action bar) — point at whichever holds them.
      target: () => {
        const rail = document.querySelector(".tool-rail");
        if (rail && !rail.hidden) return rail;
        return document.querySelector(".toolbar");
      },
      padding: 8,
      radius: 18,
    },
    {
      kicker: "Tool controls",
      title: "Make every tool feel like yours.",
      copy: "Choose exact colors and sizes. Pen adds <strong>default, fountain, brush, gel, and calligraphy</strong> styles; triangles and arrows have their own precise variants.",
      visual: visuals.controls,
      features: [["palette", "Preset + custom colors"], ["slider", "Fine size control"], ["styles", "Five pen feels"], ["shape", "Triangle + arrow types"]],
      hint: "On wide screens settings dock on the left. On phones and tablets they open beside the toolbar.",
      target: function () {
        const dock = document.getElementById("toolDock");
        if (dock && window.getComputedStyle(dock).display !== "none") return dock;
        return document.getElementById("penTool");
      },
      padding: 9,
      radius: 16,
    },
    {
      kicker: "Math tools",
      title: "Built for STEM, not just sketching.",
      copy: "Algebra tiles drag onto the page and stay <strong>linked to their variables</strong> — resize one x tile and every other x tile follows. Draw a circle with Shape, then use <strong>Construct</strong> to add a radius, chord, tangent, or angle with live measurements.",
      visual: visuals.math,
      features: [["tile", "Unit, x, x², xy tiles"], ["compass", "Radius, chord, tangent"], ["angle", "Central + inscribed angles"], ["pattern", "Snap to grid or points"]],
      hint: "Algebra tiles has its own toolbar icon. Construct appears in Shape's panel once it's set to a circle.",
      target: "#manipulativeTool",
      padding: 10,
      radius: 16,
    },
    {
      kicker: "Notebooks + canvas",
      title: "Keep every subject in its own space.",
      copy: "Open <strong>My Notebooks</strong> to create, rename, preview, and switch subjects. Choose dot, ruled, or graph paper, then back up or restore your library with one portable file.",
      visual: visuals.library,
      features: [["notebook", "Multi-notebook library"], ["pattern", "3 canvas patterns"], ["backup", "Backup + restore"], ["local", "Stored on this device"]],
      hint: "The menu is also where you switch between infinite canvas and page-based notes.",
      target: "#libraryBtn",
      menu: true,
      padding: 7,
      radius: 13,
    },
    {
      kicker: "Documents + pages",
      title: "Bring material in. Send clean work out.",
      copy: "Import <strong>PDFs and PowerPoint decks</strong>, annotate slide by slide, and export the result as PDF or PPTX. Notebook Mode gives you clean A4-style pages and its own PDF export.",
      visual: visuals.files,
      features: [["pdf", "PDF import"], ["slides", "PPT / PPTX import"], ["pages", "A4 notebook pages"], ["export", "PDF / PPTX export"]],
      hint: "Export buttons appear only when a deck or paged notebook is active, so the toolbar stays calm.",
      target: "#pptImportBtn",
      menu: true,
      padding: 7,
      radius: 13,
    },
    {
      kicker: "Focus tools",
      title: "Watch, capture, and keep moving.",
      copy: "Open a YouTube lecture in a <strong>floating, draggable player</strong> while you write. Save a video moment onto the canvas, reopen it later at that timestamp, and use Pomodoro for focused sessions.",
      visual: visuals.focus,
      features: [["video", "YouTube beside notes"], ["capture", "Save video moments"], ["select", "Move + resize captures"], ["timer", "Built-in Pomodoro"]],
      hint: "The YouTube and clock buttons sit together on the main toolbar.",
      target: "#ytToggleBtn",
      padding: 11,
      radius: 14,
    },
    {
      kicker: "Plan + remember",
      title: "Turn a busy day into a finishable plan.",
      copy: "Planner maps the next year into clear daily tasks. Set one-time, <strong>daily, or weekly</strong> plans, watch progress fill as you finish, and enable device reminders when you want an extra nudge.",
      visual: visuals.planner,
      features: [["calendar", "One-year calendar"], ["bell", "Timed + smart nudges"], ["repeat", "Daily + weekly plans"], ["progress", "Live completion progress"]],
      hint: "Everything stays on this device. Tasks without a time get a smart reminder after three hours.",
      target: "#plannerBtn",
      menu: true,
      padding: 7,
      radius: 14,
    },
    {
      kicker: "Teaching + layout",
      title: "Go hands-free, or move the controls.",
      copy: "On supported laptops, experimental <strong>AR Inky</strong> uses the webcam and hand tracking to draw in the air. You can also dock the toolbar at the top or bottom and swap light or dark themes.",
      visual: visuals.ar,
      features: [["camera", "AR air drawing"], ["location", "Toolbar top / bottom"], ["theme", "Light + dark themes"], ["move", "Desktop + touch layouts"]],
      hint: "AR is shown only on compatible desktop devices and asks for camera permission when you choose it.",
      target: function () {
        const arSection = document.getElementById("arSection");
        if (arSection) {
          const rect = arSection.getBoundingClientRect();
          if (rect.width && rect.height) return arSection;
        }
        return document.getElementById("toolbarLocationToggle");
      },
      menu: true,
      padding: 7,
      radius: 13,
    },
    {
      kicker: "You are ready",
      title: "Explore without worrying about mistakes.",
      copy: "Undo and redo cover your edits, Clear asks before wiping the canvas, and Select lets you refine what is already there. Zoom, Pan, themes, exports, and this tour are always within reach.",
      visual: visuals.ready,
      features: [["history", "Undo + redo"], ["select", "Move + resize"], ["keyboard", "Keyboard shortcuts"], ["local", "Replay from the menu"]],
      hint: "Open the ☰ menu any time and choose Feature tour to see this guide again.",
      target: null,
    },
  ];

  let tour = null;
  let card = null;
  let spotlight = null;
  let body = null;
  let kicker = null;
  let title = null;
  let copy = null;
  let visual = null;
  let featureGrid = null;
  let hint = null;
  let progress = null;
  let stepCount = null;
  let backButton = null;
  let nextButton = null;

  function readCompletion() {
    try {
      return !!window.localStorage.getItem(STORAGE_KEY);
    } catch (error) {
      return !!window.__inkyscibFeatureTourSeen;
    }
  }

  function saveCompletion() {
    window.__inkyscibFeatureTourSeen = true;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
        version: 1,
        completedAt: new Date().toISOString(),
      }));
    } catch (error) {
      // The in-memory flag still prevents a repeat during this page session.
    }
  }

  function clearCompletion() {
    window.__inkyscibFeatureTourSeen = false;
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch (error) {
      // Storage can be blocked in strict privacy modes.
    }
  }

  function createTour() {
    if (tour) return;

    tour = document.createElement("div");
    tour.id = "featureTour";
    tour.className = "feature-tour";
    tour.setAttribute("aria-hidden", "true");
    tour.innerHTML = `
      <div class="feature-tour-spotlight" aria-hidden="true"></div>
      <section class="feature-tour-card" role="dialog" aria-modal="true" aria-labelledby="featureTourTitle" aria-describedby="featureTourCopy">
        <div class="feature-tour-card-top">
          <div class="feature-tour-brand"><span class="feature-tour-brand-mark">I</span><span>Feature map</span></div>
          <button class="feature-tour-close" type="button" aria-label="Close feature tour">
            <svg viewBox="0 0 24 24" fill="none"><path d="m6 6 12 12M18 6 6 18"/></svg>
          </button>
        </div>
        <div class="feature-tour-card-body">
          <p class="feature-tour-kicker"></p>
          <h2 id="featureTourTitle" class="feature-tour-title"></h2>
          <p id="featureTourCopy" class="feature-tour-copy"></p>
          <div class="feature-tour-visual-slot"></div>
          <div class="tour-feature-grid"></div>
          <p class="feature-tour-hint"></p>
        </div>
        <div class="feature-tour-footer">
          <div class="feature-tour-progress" style="--tour-steps:${steps.length}" role="group" aria-label="Tour chapters"></div>
          <div class="feature-tour-actions">
            <span class="feature-tour-step-count" aria-live="polite"></span>
            <button class="feature-tour-btn feature-tour-back" type="button">Back</button>
            <button class="feature-tour-btn feature-tour-next" type="button"><span class="feature-tour-next-label">Next</span><span class="feature-tour-next-arrow" aria-hidden="true">→</span></button>
          </div>
        </div>
      </section>
    `;

    document.body.appendChild(tour);
    card = tour.querySelector(".feature-tour-card");
    spotlight = tour.querySelector(".feature-tour-spotlight");
    body = tour.querySelector(".feature-tour-card-body");
    kicker = tour.querySelector(".feature-tour-kicker");
    title = tour.querySelector(".feature-tour-title");
    copy = tour.querySelector(".feature-tour-copy");
    visual = tour.querySelector(".feature-tour-visual-slot");
    featureGrid = tour.querySelector(".tour-feature-grid");
    hint = tour.querySelector(".feature-tour-hint");
    progress = tour.querySelector(".feature-tour-progress");
    stepCount = tour.querySelector(".feature-tour-step-count");
    backButton = tour.querySelector(".feature-tour-back");
    nextButton = tour.querySelector(".feature-tour-next");

    progress.innerHTML = steps.map((step, index) => `
      <button class="feature-tour-progress-btn" type="button" data-tour-step="${index}" aria-label="Go to chapter ${index + 1}: ${step.kicker}"></button>
    `).join("");

    tour.querySelector(".feature-tour-close").addEventListener("click", () => closeTour(true));
    backButton.addEventListener("click", previousStep);
    nextButton.addEventListener("click", nextStep);
    progress.addEventListener("click", (event) => {
      const button = event.target.closest("[data-tour-step]");
      if (!button) return;
      goToStep(Number(button.dataset.tourStep));
    });
  }

  function setMenuOpen(open) {
    const sideMenu = document.getElementById("sideMenu");
    document.body.classList.toggle("menu-open", open);
    if (sideMenu) sideMenu.setAttribute("aria-hidden", open ? "false" : "true");
  }

  function getTarget(step) {
    if (!step.target) return null;
    const target = typeof step.target === "function"
      ? step.target()
      : document.querySelector(step.target);
    if (!target || !target.isConnected) return null;
    return target;
  }

  function prepareStep(step, menuWasOpen) {
    setMenuOpen(!!step.menu);

    const target = getTarget(step);
    if (step.menu && target) {
      target.scrollIntoView({ block: "center", inline: "nearest" });
    }

    window.clearTimeout(state.layoutTimer);
    const waitForMenu = !!step.menu && !menuWasOpen;
    if (waitForMenu) {
      tour.classList.remove("has-target");
      tour.classList.add("is-centered");
      positionCardCentered();
      state.layoutTimer = window.setTimeout(scheduleLayout, MENU_TRANSITION_MS);
    } else {
      scheduleLayout();
      state.layoutTimer = window.setTimeout(scheduleLayout, MENU_TRANSITION_MS);
    }
  }

  function goToStep(index) {
    if (!state.open) return;
    const nextIndex = Math.max(0, Math.min(steps.length - 1, index));
    const menuWasOpen = document.body.classList.contains("menu-open");
    state.current = nextIndex;
    const step = steps[state.current];

    card.classList.remove("is-changing");
    void card.offsetWidth;
    card.classList.add("is-changing");
    body.scrollTop = 0;

    kicker.textContent = step.kicker;
    title.textContent = step.title;
    copy.innerHTML = step.copy;
    visual.innerHTML = step.visual;
    featureGrid.innerHTML = featurePills(step.features || []);
    hint.textContent = step.hint || "";
    hint.hidden = !step.hint;
    stepCount.textContent = `${state.current + 1} / ${steps.length}`;
    backButton.hidden = state.current === 0;
    nextButton.querySelector(".feature-tour-next-label").textContent = state.current === steps.length - 1 ? "Start creating" : "Next";
    nextButton.querySelector(".feature-tour-next-arrow").textContent = state.current === steps.length - 1 ? "✓" : "→";

    progress.querySelectorAll(".feature-tour-progress-btn").forEach((button, buttonIndex) => {
      const active = buttonIndex === state.current;
      button.classList.toggle("is-active", active);
      button.classList.toggle("is-seen", buttonIndex <= state.current);
      button.setAttribute("aria-current", active ? "step" : "false");
    });

    prepareStep(step, menuWasOpen);
  }

  function nextStep() {
    if (state.current >= steps.length - 1) {
      closeTour(true);
      return;
    }
    goToStep(state.current + 1);
  }

  function previousStep() {
    goToStep(state.current - 1);
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function positionCardCentered() {
    if (!card) return;
    const margin = 10;
    const width = card.offsetWidth;
    const height = card.offsetHeight;
    card.style.left = `${Math.max(margin, (window.innerWidth - width) / 2)}px`;
    card.style.top = `${Math.max(margin, (window.innerHeight - height) / 2)}px`;
  }

  function positionCardNear(rect) {
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const width = card.offsetWidth;
    const height = card.offsetHeight;
    const margin = viewportWidth <= 720 ? 10 : 14;
    const gap = viewportWidth <= 720 ? 12 : 18;
    const compact = viewportWidth <= 720 || viewportHeight <= 590;

    let left;
    let top;

    if (compact) {
      left = (viewportWidth - width) / 2;
      top = rect.top + rect.height / 2 < viewportHeight / 2
        ? viewportHeight - height - margin
        : margin;

      const overlaps = !(
        left + width + gap < rect.left ||
        left - gap > rect.right ||
        top + height + gap < rect.top ||
        top - gap > rect.bottom
      );

      if (overlaps) {
        const roomAbove = rect.top - margin;
        const roomBelow = viewportHeight - rect.bottom - margin;
        if (roomBelow >= Math.min(height, viewportHeight * 0.45)) {
          top = rect.bottom + gap;
        } else if (roomAbove >= Math.min(height, viewportHeight * 0.45)) {
          top = rect.top - height - gap;
        }
      }
    } else {
      const candidates = [
        { left: rect.left + (rect.width - width) / 2, top: rect.bottom + gap, fits: rect.bottom + gap + height <= viewportHeight - margin },
        { left: rect.left + (rect.width - width) / 2, top: rect.top - height - gap, fits: rect.top - height - gap >= margin },
        { left: rect.right + gap, top: rect.top + (rect.height - height) / 2, fits: rect.right + gap + width <= viewportWidth - margin },
        { left: rect.left - width - gap, top: rect.top + (rect.height - height) / 2, fits: rect.left - width - gap >= margin },
      ];
      const chosen = candidates.find((candidate) => candidate.fits);

      if (chosen) {
        left = chosen.left;
        top = chosen.top;
      } else {
        left = viewportWidth - width - margin;
        top = viewportHeight - height - margin;
      }
    }

    card.style.left = `${clamp(left, margin, Math.max(margin, viewportWidth - width - margin))}px`;
    card.style.top = `${clamp(top, margin, Math.max(margin, viewportHeight - height - margin))}px`;
  }

  function syncLayout() {
    if (!state.open || !tour) return;
    const step = steps[state.current];
    const target = getTarget(step);

    if (!target) {
      tour.classList.remove("has-target");
      tour.classList.add("is-centered");
      positionCardCentered();
      return;
    }

    const targetRect = target.getBoundingClientRect();
    if (!targetRect.width || !targetRect.height) {
      tour.classList.remove("has-target");
      tour.classList.add("is-centered");
      positionCardCentered();
      return;
    }

    const padding = step.padding == null ? 10 : step.padding;
    const left = clamp(targetRect.left - padding, 4, window.innerWidth - 8);
    const top = clamp(targetRect.top - padding, 4, window.innerHeight - 8);
    const right = clamp(targetRect.right + padding, 8, window.innerWidth - 4);
    const bottom = clamp(targetRect.bottom + padding, 8, window.innerHeight - 4);
    const rect = {
      left,
      top,
      right,
      bottom,
      width: Math.max(4, right - left),
      height: Math.max(4, bottom - top),
    };

    spotlight.style.width = `${rect.width}px`;
    spotlight.style.height = `${rect.height}px`;
    spotlight.style.borderRadius = `${step.radius || 16}px`;
    spotlight.style.transform = `translate3d(${rect.left}px, ${rect.top}px, 0)`;
    tour.classList.remove("is-centered");
    tour.classList.add("has-target");
    positionCardNear(rect);
  }

  function scheduleLayout() {
    window.cancelAnimationFrame(state.layoutFrame);
    state.layoutFrame = window.requestAnimationFrame(() => {
      state.layoutFrame = window.requestAnimationFrame(syncLayout);
    });
  }

  function getFocusableElements() {
    if (!tour) return [];
    return Array.from(tour.querySelectorAll('button:not([hidden]):not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'))
      .filter((element) => element.offsetParent !== null);
  }

  function handleKeydown(event) {
    if (!state.open) return;

    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeTour(true);
      return;
    }

    if (event.key === "ArrowRight") {
      event.preventDefault();
      event.stopPropagation();
      nextStep();
      return;
    }

    if (event.key === "ArrowLeft") {
      event.preventDefault();
      event.stopPropagation();
      previousStep();
      return;
    }

    if (event.key !== "Tab") return;
    const focusable = getFocusableElements();
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      event.stopPropagation();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      event.stopPropagation();
      first.focus();
    }
  }

  function openTour(options = {}) {
    createTour();
    if (state.open) {
      goToStep(Number.isFinite(options.step) ? options.step : 0);
      return;
    }

    state.open = true;
    state.previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    document.body.classList.add("feature-tour-open");
    setMenuOpen(false);
    tour.classList.add("is-open", "is-centered");
    tour.setAttribute("aria-hidden", "false");
    document.addEventListener("keydown", handleKeydown, true);
    goToStep(Number.isFinite(options.step) ? options.step : 0);

    window.requestAnimationFrame(() => {
      const closeButton = tour.querySelector(".feature-tour-close");
      if (closeButton) closeButton.focus({ preventScroll: true });
    });
  }

  function closeTour(markSeen) {
    if (!state.open) return;
    state.open = false;
    window.clearTimeout(state.layoutTimer);
    window.cancelAnimationFrame(state.layoutFrame);
    if (markSeen) saveCompletion();
    setMenuOpen(false);
    document.body.classList.remove("feature-tour-open");
    tour.classList.remove("is-open", "has-target", "is-centered");
    tour.setAttribute("aria-hidden", "true");
    document.removeEventListener("keydown", handleKeydown, true);

    let previousFocus = state.previousFocus;
    state.previousFocus = null;
    const sideMenu = document.getElementById("sideMenu");
    if (previousFocus && sideMenu && sideMenu.contains(previousFocus)) {
      previousFocus = document.getElementById("menuBtn");
    }
    if (previousFocus && previousFocus.isConnected && typeof previousFocus.focus === "function") {
      window.requestAnimationFrame(() => previousFocus.focus({ preventScroll: true }));
    }
  }

  function waitForBootAndOpen() {
    if (readCompletion()) return;

    const show = () => {
      if (readCompletion() || state.open) return;
      window.setTimeout(() => {
        if (readCompletion() || state.open) return;
        if (document.body.classList.contains("planner-open")) {
          window.addEventListener("inkyscib:planner-close", show, { once: true });
          return;
        }
        openTour({ step: 0 });
      }, 320);
    };

    // Was: wait for the boot overlay to leave. The overlay is gone, and its
    // class was a timer rather than a state, so waiting on it now resolves
    // instantly and the tour lands on an editor that has not finished
    // restoring. app-ready is the real signal, set at the end of init().
    if (document.body.classList.contains("app-ready")) {
      show();
      return;
    }

    state.bootObserver = new MutationObserver(() => {
      if (!document.body.classList.contains("app-ready")) return;
      state.bootObserver.disconnect();
      state.bootObserver = null;
      show();
    });
    state.bootObserver.observe(document.body, { attributes: true, attributeFilter: ["class"] });
  }

  function init() {
    createTour();

    const replayButton = document.getElementById("featureTourBtn");
    if (replayButton) {
      replayButton.addEventListener("click", () => openTour({ step: 0 }));
    }

    window.addEventListener("resize", scheduleLayout, { passive: true });
    window.addEventListener("orientationchange", scheduleLayout, { passive: true });
    const sideMenu = document.getElementById("sideMenu");
    if (sideMenu) sideMenu.addEventListener("scroll", scheduleLayout, { passive: true });

    window.Inkyscib = window.Inkyscib || {};
    window.Inkyscib.FeatureTour = {
      open: openTour,
      close: (options = {}) => closeTour(options.markSeen !== false),
      getStep: () => state.current,
      reset: () => {
        clearCompletion();
        openTour({ step: 0 });
      },
      isOpen: () => state.open,
    };

    waitForBootAndOpen();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
