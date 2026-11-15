(function () {
  "use strict";

  const TOOL_PANELS = {
    pen: { panelId: "penOptions", title: "Pen" },
    eraser: { panelId: "eraserOptions", title: "Eraser" },
    highlight: { panelId: "highlightOptions", title: "Highlighter" },
    shape: { panelId: "shapeOptions", title: "Shape" },
    manipulative: { panelId: "manipulativeOptions", title: "Algebra tiles" },
    line: { panelId: "lineOptions", title: "Line" },
    compass: { panelId: "compassOptions", title: "Compass" },
    angle: { panelId: "angleOptions", title: "Angle" },
  };

  const dockQuery = window.matchMedia("(min-width: 1180px)");

  let dock = null;
  let dockBody = null;
  let dockKicker = null;
  let dockEmpty = null;
  let dockHelp = null;

  // The "?" lives in the tool rail now. The dock shows either a tool's controls
  // or, while help is open, the explanation — never a permanent card of help
  // text parked on the canvas.
  let helpOpen = false;

  function isDockMode() {
    return dockQuery.matches;
  }

  // ---------- the free area ----------
  //
  // The part of the window that no bar is sitting on. A bar in the top half
  // pushes the top down; anything in the bottom half -- the footer, which
  // wraps to two lines on a phone, or the toolbar when it has been moved to
  // the bottom -- pulls the bottom up.
  //
  // Every floating surface asks this one function, so they agree. They used
  // not to: the floating panel measured the two top bars and ignored the
  // footer (so it ran over the privacy links), the colour studio used the raw
  // viewport (so on a tablet it opened over the toolbar), and the File sheet
  // used 85vh from a top that had moved (so its last commands were off-screen).
  const FREE_GAP = 8;
  const FREE_BARS = [".toolbar", ".file-ribbon", "footer"];

  function freeArea() {
    const width = window.innerWidth;
    const height = window.innerHeight;
    let top = FREE_GAP;
    let bottom = height - FREE_GAP;
    FREE_BARS.forEach((selector) => {
      const bar = document.querySelector(selector);
      if (!bar || !bar.getClientRects().length) return;
      const rect = bar.getBoundingClientRect();
      if (rect.height <= 0 || rect.width <= 0) return;
      if ((rect.top + rect.bottom) / 2 < height / 2) {
        top = Math.max(top, rect.bottom + FREE_GAP);
      } else {
        bottom = Math.min(bottom, rect.top - FREE_GAP);
      }
    });
    return {
      top: Math.round(top),
      bottom: Math.round(Math.max(top + 120, bottom)),
      left: FREE_GAP,
      right: width - FREE_GAP
    };
  }

  // ---------- one floating surface at a time ----------
  //
  // A tool's panel, the canvas-theme popover and the File sheet each used to
  // open over whichever of the others was already open: the theme popover
  // landed on top of the pen panel, and the pen panel stayed open underneath
  // every File menu. Each surface now announces itself when it opens and
  // closes itself when another one does. The event carries an id so a surface
  // can ignore its own announcement.
  const SURFACE_EVENT = "inkyscib:surface-open";

  function announceSurface(id) {
    document.dispatchEvent(new CustomEvent(SURFACE_EVENT, { detail: { id } }));
  }

  let floatingOpenId = null;

  // Below the dock breakpoint the panels float, and they float from here: a
  // layer that is a direct child of <body>. They used to be put back inside
  // the toolbar, and the toolbar is centred with transform: translateX(-50%).
  // A transform makes an element the containing block for its position:fixed
  // descendants and a stacking context of its own, so every "fixed" panel was
  // positioned from the toolbar's corner (46px across and 6px down on a
  // phone) and could never rise above the toolbar's z-index of 10, whatever
  // its own said.
  let panelLayer = null;

  function ensurePanelLayer() {
    if (panelLayer && panelLayer.isConnected) return panelLayer;
    panelLayer = document.getElementById("toolPanelLayer");
    if (!panelLayer) {
      panelLayer = document.createElement("div");
      panelLayer.id = "toolPanelLayer";
      panelLayer.className = "tool-panel-layer";
      document.body.appendChild(panelLayer);
    }
    return panelLayer;
  }

  function movePanelsToDock(useDock) {
    const layer = useDock ? dockBody : ensurePanelLayer();

    Object.values(TOOL_PANELS).forEach(({ panelId }) => {
      const panel = document.getElementById(panelId);
      if (!panel) return;
      if (panel.parentElement !== layer) layer.appendChild(panel);
      panel.classList.toggle("is-docked", useDock);
      panel.style.display = "none";
    });
  }

  // Most panels are settings: pick a colour or a width and get back to
  // drawing, so they get out of the way the moment the canvas is touched.
  //
  // The compass panel is not settings. It is the live readout of a
  // construction in progress — which point is the centre, what radius is set,
  // which step you are on, what the status line is telling you. Dismissing
  // that on the first canvas click would throw away the thread of the thing
  // being built, one click into building it. It stays until the compass button
  // is clicked again.
  const STICKY_TOOLS = new Set(["compass", "angle"]);

  // Clicking the tool you are already on hides its controls; clicking again
  // brings them back. In dock mode the panel opens alongside the tool and every
  // tool button returns early before its own toggle, so without this there is
  // no way to put a panel away.
  let collapsed = false;
  let lastActiveTool = null;
  let hasSynced = false;



  function toolFromButton(button) {
    const id = button && button.id;
    if (!id || !id.endsWith("Tool")) return null;
    const tool = id.slice(0, -"Tool".length);
    return TOOL_PANELS[tool] ? tool : null;
  }

  function setCollapsedState(next) {
    if (collapsed === next) return false;
    collapsed = next;
    syncActivePanel();
    return true;
  }

  // A click that *switched* tools opens the new tool's controls; only a click
  // on the tool already in hand means "put these away".
  //
  // Runs in the CAPTURE phase for two reasons: the tool buttons stop the click
  // before it reaches document, so a bubble-phase listener never sees it at
  // all; and capture runs before setTool, so the tool read here is the one that
  // was in hand when the click started. The toggle itself is deferred to the
  // next task so it lands after the button's own handler and the panel sync it
  // sets off.
  function handleToolClick(event) {
    const button = event.target && event.target.closest
      ? event.target.closest(".tool")
      : null;
    const tool = toolFromButton(button);
    if (!tool) return;
    if (getActiveTool() !== tool) return;

    // The same gesture at every width. Below 1180px each tool used to run its
    // own version -- a single tap for the pen and eraser, a double tap within
    // 300ms for four others, none at all for the angle -- and each wrote the
    // panel's display behind this file's back, so the two disagreed about
    // whether it was open. The tools/*.js handlers now only select the tool.
    window.setTimeout(() => setCollapsedState(!collapsed), 0);
  }

  // ---------- closing a panel ----------
  //
  // Tapping the tool again always put its controls away, but nothing on screen
  // said so beyond one line of hint text in the dock, and a panel floating
  // below the breakpoint had no dismissal of its own. Every panel now has a
  // close button: the dock head's while docked, its own head while floating.
  // Both collapse, exactly as a second tap on the tool does, so the tool's
  // normal gesture brings the controls back.
  let dockClose = null;

  const CLOSE_ICON =
    '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">' +
    '<path d="M6 6l12 12M18 6 6 18" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round"/>' +
    "</svg>";

  function makeCloseButton(id, onClose) {
    const button = document.createElement("button");
    button.type = "button";
    button.id = id;
    button.className = "tool-panel-close";
    button.innerHTML = CLOSE_ICON;
    button.addEventListener("click", (event) => {
      // Kept off the document: a click reaching the canvas handlers would be
      // read as a stroke or a deselect.
      event.stopPropagation();
      onClose();
    });
    return button;
  }

  function closeActivePanel() {
    if (isDockMode() && helpOpen) {
      helpOpen = false;
      syncActivePanel();
      dockHelp?.focus();
      return;
    }
    const tool = getActiveTool();
    if (!tool) return;
    setCollapsedState(true);
    document.getElementById(tool + "Tool")?.focus();
  }

  function ensureCloseButtons() {
    if (!dockClose && dockKicker) {
      const head = document.createElement("div");
      head.className = "tool-dock-head";
      dockKicker.before(head);
      dockClose = makeCloseButton("toolDockClose", closeActivePanel);
      head.append(dockKicker, dockClose);
    }

    Object.values(TOOL_PANELS).forEach(({ panelId, title }) => {
      const panel = document.getElementById(panelId);
      if (!panel || panel.querySelector(":scope > .tool-options-head")) return;
      const head = document.createElement("div");
      head.className = "tool-options-head";
      const label = document.createElement("span");
      label.className = "tool-options-title";
      label.textContent = title;
      const close = makeCloseButton(panelId + "Close", closeActivePanel);
      close.setAttribute("aria-label", "Close " + title + " options");
      head.append(label, close);
      panel.prepend(head);
    });
  }

  // Touching the canvas puts a settings panel away. Sticky tools keep theirs:
  // see STICKY_TOOLS. Never consumes the event — the stroke still lands.
  //
  // At every width. This returned early below 1180px, which is exactly where
  // the panel floats OVER the canvas -- so on the tablet the only way to get
  // it out of the way of your drawing was to find its close button.
  function handleCanvasPointerDown() {
    if (collapsed) return;
    const tool = getActiveTool();
    if (!tool || STICKY_TOOLS.has(tool)) return;
    setCollapsedState(true);
  }

  // Escape is the universal "put it away", but the compass already uses it to
  // cancel a half-drawn arc, so its panel is left out rather than having the
  // two fight over one key.
  function handleEscape(event) {
    if (event.key !== "Escape") return;
    if (isHelpSheetOpen()) {
      closeHelpSheet();
      return;
    }
    if (collapsed) return;
    const tool = getActiveTool();
    if (!tool || STICKY_TOOLS.has(tool)) return;
    setCollapsedState(true);
  }

  function getActiveTool() {
    const state = window.appState;
    if (!state || state.panMode) return null;
    return TOOL_PANELS[state.currentTool] ? state.currentTool : null;
  }

  function syncActivePanel() {
    if (!dock || !dockBody) return;

    const useDock = isDockMode();
    // The active tool is the active tool at any width. This used to be nulled
    // below the dock breakpoint, and the loop at the end of this function then
    // set `display: none` on every tool panel -- so under 1180px no tool's
    // controls could be opened at all. There is no other way in: toggleToolbox
    // in core.js is exported and never called. That put pen colour, size and
    // style out of reach on exactly the tablet this product is written for.
    // Only the dock CHROME is gated on useDock now; the panels are not.
    const activeTool = getActiveTool();

    // Reaching for a different tool always opens its own controls -- but the
    // tool that is merely in hand when the editor loads does not, below the
    // dock. There the panel floats over the canvas, and opening it unasked
    // covered the left third of a 960px tablet the moment it loaded, where a
    // left-to-right writer starts. The dock is its own column beside the
    // canvas and keeps showing its panel.
    if (activeTool !== lastActiveTool) {
      collapsed = !hasSynced && !useDock;
      // ...and closes the help card, which otherwise keeps the dock and hides
      // the panel you just asked for. `collapsed` was already cleared here for
      // exactly this reason; helpOpen was missed.
      helpOpen = false;
      lastActiveTool = activeTool;
    }
    hasSynced = true;

    const activeConfig = activeTool && !collapsed ? TOOL_PANELS[activeTool] : null;

    // Help takes the dock over while it is open, and hands it back on close.
    const showHelp = useDock && helpOpen;

    dock.classList.toggle("is-enabled", useDock);
    dock.classList.toggle("has-active-panel", useDock && (!!activeConfig || showHelp));
    dock.classList.toggle("is-help-open", showHelp);

    // The help card is built from window.Inkyscib.Shortcuts, which events.js
    // defines. This file now runs before events.js -- it only needs core.js,
    // and moving it earlier is what makes the chrome appear promptly -- so at
    // init that map does not exist yet and buildHelpContent returns nothing.
    // Build it when the card is actually opened instead; renderShortcutHelp
    // is guarded and only does the work once.
    if (showHelp) renderShortcutHelp();
    dock.setAttribute("aria-hidden", useDock ? "false" : "true");

    if (dockHelp) {
      dockHelp.setAttribute("aria-expanded", helpOpen ? "true" : "false");
      dockHelp.classList.toggle("active", helpOpen);
    }

    if (dockKicker) {
      dockKicker.textContent = showHelp
        ? "Tool controls"
        : (activeConfig ? activeConfig.title : "Tool controls");
    }

    // The "<Tool> settings" heading that used to be written here went into an
    // element that was display:none at every width, in three separate rules.
    // Element, rules and write are all gone; .tool-options-head carries the
    // panel's name and is actually on screen.

    // The dock head's close button is for whatever the dock is showing: a
    // tool's controls, or the shortcut card while help has the dock.
    if (dockClose) {
      dockClose.hidden = !showHelp && !activeConfig;
      dockClose.setAttribute(
        "aria-label",
        showHelp ? "Close shortcuts" : (activeConfig ? `Close ${activeConfig.title} options` : "Close")
      );
    }

    if (dockEmpty) {
      dockEmpty.style.display = showHelp ? "block" : "none";
    }

    let floatingNow = null;
    Object.entries(TOOL_PANELS).forEach(([tool, { panelId }]) => {
      const panel = document.getElementById(panelId);
      if (!panel) return;
      const visible = !showHelp && activeConfig && tool === activeTool;
      panel.style.display = visible ? "flex" : "none";

      // Below the breakpoint the panel floats over the canvas instead of
      // living in the dock: in the free area, at its left edge, no taller
      // than the room actually left. Position, width and box model are in
      // write.css under .is-floating; only the two measured numbers are
      // written here.
      if (visible && !useDock) {
        const area = freeArea();
        panel.classList.add("is-floating");
        panel.style.top = area.top + "px";
        panel.style.maxHeight = area.bottom - area.top + "px";
        floatingNow = panelId;
      } else {
        panel.classList.remove("is-floating");
        panel.style.top = "";
        panel.style.maxHeight = "";
      }
    });

    // Tell the other floating surfaces, but only on the transition to open:
    // this function runs on every tool change and resize, and announcing on
    // each of those would close a popover the moment the window moved.
    if (floatingNow && floatingNow !== floatingOpenId) announceSurface("tool-panel");
    floatingOpenId = floatingNow;

    // Swapping panels changes the scroll height without touching the child
    // list, and every tool's panel is a different height, so the affordance is
    // re-measured here rather than left to the observers alone.
    syncScrollAffordance();
  }

  // The dock scrolls whenever a panel is taller than the frame -- the compass
  // is roughly 950px of controls in 700px -- and it used to do so with the
  // scrollbar set to zero width, so nothing on screen said the rest was there.
  // `has-more` drives a fade on the bottom edge and is on only while something
  // is actually below the fold, so it disappears as you reach the end rather
  // than sitting there permanently and meaning nothing.
  const SCROLL_END_SLOP = 2;

  function hasMoreBelow(element) {
    if (!element) return false;
    return element.scrollHeight - element.clientHeight - element.scrollTop > SCROLL_END_SLOP;
  }

  function syncScrollAffordance() {
    if (dock && dockBody) {
      dock.classList.toggle("has-more", hasMoreBelow(dockBody));
    }
    // Below 1180px there is no dock, and the panel scrolls inside itself. The
    // cue only ever existed on the dock, so on the tablet this product is
    // written for the compass's ~950px of controls scrolled with nothing on
    // screen saying so.
    // Every panel is in the DOM at once, so this has to be the one on screen
    // rather than the first one found.
    document.querySelectorAll(".tool-options:not(.is-docked)").forEach((panel) => {
      const shown = panel.style.display && panel.style.display !== "none";
      panel.classList.toggle("has-more", !!shown && hasMoreBelow(panel));
    });
  }

  // A floating panel is its own scroller, so it needs its own listener.
  document.addEventListener(
    "scroll",
    (event) => {
      const target = event.target;
      if (target instanceof HTMLElement && target.classList?.contains("tool-options")) {
        syncScrollAffordance();
      }
    },
    true
  );

  function syncLayout() {
    if (!dock || !dockBody) return;
    // Rotating a tablet can cross the breakpoint with the sheet open, which
    // would leave the sheet and the dock card both showing the same list.
    if (isDockMode() && isHelpSheetOpen()) closeHelpSheet();
    movePanelsToDock(isDockMode());
    syncActivePanel();
    syncScrollAffordance();
  }

  // Help content is built from the live shortcut map rather than a hand-written
  // list, so a binding that changes in events.js changes here too.
  //
  // It has to render in two places. Above 1180px it fills the dock. Below that
  // the dock is display:none, and the "?" button in the rail was still visible
  // and did nothing at all - a dead control on exactly the budget tablet this
  // product is written for. Below the breakpoint the same content opens as a
  // sheet over the canvas instead.
  let shortcutsRendered = false;
  let helpSheet = null;

  function addShortcutRow(list, keys, label) {
    const dt = document.createElement("dt");
    keys.split(/\s+/).filter(Boolean).forEach((key) => {
      const kbd = document.createElement("kbd");
      kbd.textContent = key;
      dt.appendChild(kbd);
    });
    const dd = document.createElement("dd");
    dd.textContent = label;
    list.append(dt, dd);
  }

  function buildHelpContent() {
    const shortcuts = window.Inkyscib?.Shortcuts;
    const fragment = document.createDocumentFragment();
    if (!shortcuts) return fragment;

    const gestures = shortcuts.gestures || [];
    if (gestures.length) {
      const heading = document.createElement("p");
      heading.className = "tool-dock-shortcuts-heading";
      heading.textContent = "Touch";
      const list = document.createElement("dl");
      list.className = "tool-dock-shortcuts is-gestures";
      gestures.forEach(({ label, action }) => {
        const dt = document.createElement("dt");
        const chip = document.createElement("span");
        chip.className = "gesture-chip";
        chip.textContent = label;
        dt.appendChild(chip);
        const dd = document.createElement("dd");
        dd.textContent = action;
        list.append(dt, dd);
      });
      fragment.append(heading, list);
    }

    const keyHeading = document.createElement("p");
    keyHeading.className = "tool-dock-shortcuts-heading";
    keyHeading.textContent = "Keyboard";
    const keyList = document.createElement("dl");
    keyList.className = "tool-dock-shortcuts";
    Object.entries(shortcuts.tools).forEach(([key, tool]) => {
      addShortcutRow(keyList, key.toUpperCase(), shortcuts.labels?.[tool] || tool);
    });
    (shortcuts.global || []).forEach(({ keys, label }) => addShortcutRow(keyList, keys, label));
    fragment.append(keyHeading, keyList);

    return fragment;
  }

  function renderShortcutHelp() {
    if (shortcutsRendered || !dockEmpty) return;
    const content = buildHelpContent();
    if (!content.childNodes.length) return;
    dockEmpty.appendChild(content);
    shortcutsRendered = true;
  }

  function closeHelpSheet() {
    if (!helpSheet) return;
    helpSheet.classList.remove("is-open");
    helpSheet.setAttribute("aria-hidden", "true");
    document.body.classList.remove("help-sheet-open");
    helpOpen = false;
    if (dockHelp) {
      dockHelp.setAttribute("aria-expanded", "false");
      dockHelp.classList.remove("active");
      dockHelp.focus();
    }
  }

  function ensureHelpSheet() {
    if (helpSheet) return helpSheet;

    helpSheet = document.createElement("div");
    helpSheet.id = "toolHelpSheet";
    helpSheet.className = "tool-help-sheet";
    helpSheet.setAttribute("aria-hidden", "true");

    const backdrop = document.createElement("div");
    backdrop.className = "tool-help-sheet-backdrop";
    backdrop.addEventListener("click", closeHelpSheet);

    const panel = document.createElement("div");
    panel.className = "tool-help-sheet-panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-label", "Shortcuts and gestures");

    const title = document.createElement("h3");
    title.className = "tool-help-sheet-title";
    title.textContent = "Shortcuts and gestures";

    const close = document.createElement("button");
    close.type = "button";
    close.className = "tool-help-sheet-close";
    close.setAttribute("aria-label", "Close");
    close.textContent = "×";
    close.addEventListener("click", closeHelpSheet);

    const body = document.createElement("div");
    body.className = "tool-help-sheet-body";
    body.appendChild(buildHelpContent());

    panel.append(close, title, body);
    helpSheet.append(backdrop, panel);
    document.body.appendChild(helpSheet);
    return helpSheet;
  }

  function openHelpSheet() {
    const sheet = ensureHelpSheet();
    sheet.classList.add("is-open");
    sheet.setAttribute("aria-hidden", "false");
    document.body.classList.add("help-sheet-open");
    helpOpen = true;
    if (dockHelp) {
      dockHelp.setAttribute("aria-expanded", "true");
      dockHelp.classList.add("active");
    }
    sheet.querySelector(".tool-help-sheet-close")?.focus();
  }

  function isHelpSheetOpen() {
    return !!helpSheet && helpSheet.classList.contains("is-open");
  }

  function initToolDock() {
    dock = document.getElementById("toolDock");
    dockBody = document.getElementById("toolDockBody");
    dockKicker = document.getElementById("toolDockKicker");
    dockEmpty = document.getElementById("toolDockEmpty");
    dockHelp = document.getElementById("toolDockHelp");

    if (!dock || !dockBody) return;

    ensureCloseButtons();
    dockBody.addEventListener("scroll", syncScrollAffordance, { passive: true });
    // Each tool's panel is a different height, and panels are swapped in and
    // out of this one container, so the measurement has to be retaken whenever
    // the contents change rather than once at startup.
    if (typeof ResizeObserver === "function") {
      const observer = new ResizeObserver(syncScrollAffordance);
      observer.observe(dockBody);
      [...dockBody.children].forEach((child) => observer.observe(child));
      new MutationObserver(() => {
        [...dockBody.children].forEach((child) => observer.observe(child));
        syncScrollAffordance();
      }).observe(dockBody, { childList: true });
    }

    if (dockHelp) {
      dockHelp.addEventListener("click", (event) => {
        event.stopPropagation();
        if (!isDockMode()) {
          if (isHelpSheetOpen()) closeHelpSheet();
          else openHelpSheet();
          return;
        }
        helpOpen = !helpOpen;
        syncActivePanel();
      });
    }

    // Double-clicking the opened card puts it away, matching how a
    // double-click dismisses a tool's own controls.
    if (dockEmpty) {
      dockEmpty.addEventListener("dblclick", () => {
        helpOpen = false;
        syncActivePanel();
      });
    }

    renderShortcutHelp();
    // ...and again once every script has run. The card is built from
    // window.Inkyscib.Shortcuts, which events.js defines, and this file now
    // loads before it -- moving the chrome scripts early is what makes the
    // frame appear promptly. At this point the document is parsed but
    // DOMContentLoaded has not fired, so this listener still gets its turn.
    // renderShortcutHelp is guarded, so whichever call finds the map wins and
    // the other is a no-op.
    document.addEventListener("DOMContentLoaded", renderShortcutHelp, { once: true });
    syncLayout();

    document.addEventListener("toolChanged", syncActivePanel);
    document.addEventListener("panModeChanged", syncActivePanel);
    // Another floating surface opened: a floating panel steps aside. A docked
    // one does not -- the dock is its own column, not something over the
    // canvas, and the File sheet already has a scrim over it.
    document.addEventListener(SURFACE_EVENT, (event) => {
      if (event.detail?.id === "tool-panel" || isDockMode()) return;
      if (floatingOpenId && !collapsed) setCollapsedState(true);
    });
    document.addEventListener("click", handleToolClick, true);
    document.addEventListener("keydown", handleEscape);
    document.getElementById("drawingCanvas")
      ?.addEventListener("pointerdown", handleCanvasPointerDown, { passive: true });
    window.addEventListener("resize", syncLayout);

    if (typeof dockQuery.addEventListener === "function") {
      dockQuery.addEventListener("change", syncLayout);
    } else if (typeof dockQuery.addListener === "function") {
      dockQuery.addListener(syncLayout);
    }
  }

  window.Inkyscib = window.Inkyscib || {};
  window.Inkyscib.ToolDock = {
    isDockMode,
    freeArea,
    announceSurface,
    SURFACE_EVENT,
    syncLayout,
    syncActivePanel,
    isCollapsed: () => collapsed,
    isHelpOpen: () => helpOpen,
    setCollapsed(next) {
      collapsed = !!next;
      syncActivePanel();
    },
  };

  // With `defer` the DOM is already parsed when this runs, so waiting for
  // DOMContentLoaded only waited for the other 40-odd scripts to download.
  // Build the chrome as soon as this file executes; the readyState guard
  // keeps it correct if the script is ever loaded without defer.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initToolDock, { once: true });
  } else {
    initToolDock();
  }
})();
