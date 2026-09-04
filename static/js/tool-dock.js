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
  const anchors = new Map();

  let dock = null;
  let dockBody = null;
  let dockTitle = null;
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

  function ensureAnchors() {
    Object.values(TOOL_PANELS).forEach(({ panelId }) => {
      const panel = document.getElementById(panelId);
      if (!panel || anchors.has(panelId)) return;

      const anchor = document.createElement("span");
      anchor.hidden = true;
      anchor.dataset.toolPanelAnchor = panelId;
      panel.before(anchor);
      anchors.set(panelId, anchor);
    });
  }

  function movePanelsToDock(useDock) {
    ensureAnchors();

    Object.values(TOOL_PANELS).forEach(({ panelId }) => {
      const panel = document.getElementById(panelId);
      const anchor = anchors.get(panelId);
      if (!panel || !anchor) return;

      if (useDock) {
        if (panel.parentElement !== dockBody) {
          dockBody.appendChild(panel);
        }
        panel.classList.add("is-docked");
        panel.style.display = "none";
        return;
      }

      if (panel.parentElement !== anchor.parentElement || panel.previousElementSibling !== anchor) {
        anchor.after(panel);
      }
      panel.classList.remove("is-docked");
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
    // Outside the dock each tool toggles its own panel already.
    if (!isDockMode()) return;

    const button = event.target && event.target.closest
      ? event.target.closest(".tool")
      : null;
    const tool = toolFromButton(button);
    if (!tool) return;
    if (getActiveTool() !== tool) return;

    window.setTimeout(() => setCollapsedState(!collapsed), 0);
  }

  // Touching the canvas puts a settings panel away. Sticky tools keep theirs:
  // see STICKY_TOOLS. Never consumes the event — the stroke still lands.
  function handleCanvasPointerDown() {
    if (!isDockMode() || collapsed) return;
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
    if (!isDockMode() || collapsed) return;
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
    const activeTool = useDock ? getActiveTool() : null;

    // Reaching for a different tool always opens its own controls.
    if (activeTool !== lastActiveTool) {
      collapsed = false;
      lastActiveTool = activeTool;
    }

    const activeConfig = activeTool && !collapsed ? TOOL_PANELS[activeTool] : null;

    // Help takes the dock over while it is open, and hands it back on close.
    const showHelp = useDock && helpOpen;

    dock.classList.toggle("is-enabled", useDock);
    dock.classList.toggle("has-active-panel", !!activeConfig || showHelp);
    dock.classList.toggle("is-help-open", showHelp);
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

    if (dockTitle) {
      dockTitle.textContent = activeConfig ? `${activeConfig.title} settings` : "Select a drawing tool";
    }

    if (dockEmpty) {
      dockEmpty.style.display = showHelp ? "block" : "none";
    }

    Object.entries(TOOL_PANELS).forEach(([tool, { panelId }]) => {
      const panel = document.getElementById(panelId);
      if (!panel) return;
      const visible = !showHelp && activeConfig && tool === activeTool;
      panel.style.display = visible ? "flex" : "none";
    });
  }

  function syncLayout() {
    if (!dock || !dockBody) return;
    // Rotating a tablet can cross the breakpoint with the sheet open, which
    // would leave the sheet and the dock card both showing the same list.
    if (isDockMode() && isHelpSheetOpen()) closeHelpSheet();
    movePanelsToDock(isDockMode());
    syncActivePanel();
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
    dockTitle = document.getElementById("toolDockTitle");
    dockKicker = document.getElementById("toolDockKicker");
    dockEmpty = document.getElementById("toolDockEmpty");
    dockHelp = document.getElementById("toolDockHelp");

    if (!dock || !dockBody) return;

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
    syncLayout();

    document.addEventListener("toolChanged", syncActivePanel);
    document.addEventListener("panModeChanged", syncActivePanel);
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
    syncLayout,
    syncActivePanel,
    isCollapsed: () => collapsed,
    isHelpOpen: () => helpOpen,
    setCollapsed(next) {
      collapsed = !!next;
      syncActivePanel();
    },
  };

  document.addEventListener("DOMContentLoaded", initToolDock);
})();
