// Option C editor chrome: splits the single .toolbar into a left tool rail
// (the drawing tools, which have contextual options) and a top-right action
// bar (everything else), on wide screens only.
//
// Uses the same 1180px breakpoint and the same anchor/restore pattern as
// tool-dock.js, so the two stay in step: tool-dock.js moves each tool's
// .tool-options panel into #toolDock, this moves the buttons into the rail.
// Below the breakpoint both restore and the original toolbar comes back.
(function () {
  "use strict";

  // Order matters: this is the order they sit in inside the rail.
  const RAIL_GROUPS = [
    ["selectTool", "penTool", "eraserTool", "highlightTool"],
    ["shapeTool", "manipulativeTool", "lineTool", "compassTool", "angleTool", "toolDockHelp"],
  ];

  // The menu button and the File ribbon are separate floating islands in the
  // markup. In rail mode they join the action bar as its leading zone, so the
  // top band is one object instead of two islands with 444px of empty bar
  // between them.
  // The hamburger is gone -- its drawer was redundant with the ribbon, so the
  // ribbon is the only thing left to move into the bar in rail mode.
  const DOC_NODES = [".file-ribbon"];

  const railQuery = window.matchMedia("(min-width: 1180px)");
  const anchors = new Map();
  const docAnchors = new Map();
  let docZone = null;

  let toolbar = null;
  let rail = null;
  let railBuilt = false;

  function ensureRail() {
    if (rail) return rail;

    rail = document.createElement("div");
    rail.className = "tool-rail";
    rail.setAttribute("role", "toolbar");
    rail.setAttribute("aria-label", "Drawing tools");
    rail.hidden = true;
    document.body.appendChild(rail);

    RAIL_GROUPS.forEach((_, index) => {
      const group = document.createElement("div");
      group.className = "tool-rail-group";
      group.dataset.railGroup = String(index);
      rail.appendChild(group);
    });

    return rail;
  }

  // Remember where each button came from so it can go back verbatim.
  function ensureAnchors() {
    RAIL_GROUPS.flat().forEach((id) => {
      const button = document.getElementById(id);
      if (!button || anchors.has(id)) return;

      const anchor = document.createElement("span");
      anchor.hidden = true;
      anchor.dataset.railAnchor = id;
      button.before(anchor);
      anchors.set(id, anchor);
    });
  }

  // A divider left stranded at either end of the action bar reads as a stray
  // line, so hide the ones that end up on an edge.
  function syncDividers(useRail) {
    if (!toolbar) return;

    const dividers = Array.from(toolbar.querySelectorAll(".toolbar-divider"));
    dividers.forEach((divider) => divider.classList.remove("is-edge"));

    if (!useRail) return;

    const visible = Array.from(toolbar.children).filter(
      (child) => !child.hidden && child.dataset.railAnchor === undefined
    );

    const first = visible[0];
    const last = visible[visible.length - 1];

    if (first && first.classList.contains("toolbar-divider")) {
      first.classList.add("is-edge");
    }
    if (last && last.classList.contains("toolbar-divider")) {
      last.classList.add("is-edge");
    }
  }

  function ensureDocZone() {
    if (docZone && docZone.isConnected) return docZone;
    docZone = toolbar.querySelector(".bar-doc");
    if (!docZone) {
      docZone = document.createElement("div");
      docZone.className = "bar-zone bar-doc";
      toolbar.prepend(docZone);
    }
    return docZone;
  }

  // Same remember-where-it-came-from pattern as the tool buttons, so below the
  // breakpoint the original floating islands come back verbatim.
  function ensureDocAnchors() {
    DOC_NODES.forEach((selector) => {
      const node = document.querySelector(selector);
      if (!node || docAnchors.has(selector)) return;
      const anchor = document.createElement("span");
      anchor.hidden = true;
      anchor.dataset.docAnchor = selector;
      node.before(anchor);
      docAnchors.set(selector, anchor);
    });
  }

  function applyDocZone(useRail) {
    ensureDocAnchors();

    if (useRail) {
      const zone = ensureDocZone();
      DOC_NODES.forEach((selector) => {
        const node = document.querySelector(selector);
        if (node && node.parentElement !== zone) zone.appendChild(node);
      });
      return;
    }

    DOC_NODES.forEach((selector) => {
      const node = document.querySelector(selector);
      const anchor = docAnchors.get(selector);
      if (!node || !anchor) return;
      if (node.previousElementSibling !== anchor) anchor.after(node);
    });
    if (docZone) docZone.remove();
    docZone = null;
  }

  function applyLayout(useRail) {
    if (!toolbar) return;

    ensureAnchors();
    applyDocZone(useRail);

    if (useRail) {
      ensureRail();

      RAIL_GROUPS.forEach((ids, index) => {
        const group = rail.querySelector('[data-rail-group="' + index + '"]');
        if (!group) return;

        ids.forEach((id) => {
          const button = document.getElementById(id);
          if (button && button.parentElement !== group) {
            group.appendChild(button);
          }
        });
      });

      rail.hidden = false;
      railBuilt = true;
    } else if (railBuilt) {
      RAIL_GROUPS.flat().forEach((id) => {
        const button = document.getElementById(id);
        const anchor = anchors.get(id);
        if (!button || !anchor) return;

        if (button.previousElementSibling !== anchor) {
          anchor.after(button);
        }
      });

      if (rail) rail.hidden = true;
    }

    document.body.classList.toggle("chrome-rail", useRail);
    toolbar.classList.toggle("is-topbar", useRail);
    syncDividers(useRail);
    syncInsets(useRail);
  }

  // core.js owns the vertical insets: it writes inline top/bottom on the
  // workspace shell and the dock from the toolbar's measured position. Moving
  // tools out changes the toolbar's height, so re-run it, then mirror the same
  // number into --chrome-top so the rail lines up with the panel exactly.
  function syncInsets(useRail) {
    if (typeof window.syncWorkspaceShellBounds === "function") {
      window.syncWorkspaceShellBounds();
    }

    if (!useRail || !toolbar) {
      document.body.style.removeProperty("--chrome-top");
      return;
    }

    const bar = toolbar.getBoundingClientRect();

    // same formula core.js uses for the dock's top inset. The hamburger used
    // to be a second candidate here, in case it hung lower than the bar; it
    // no longer exists, so the bar is the only thing to clear.
    const chromeTop = Math.max(0, Math.round(bar.bottom + 10));

    document.body.style.setProperty("--chrome-top", chromeTop + "px");

    // core.js's "toolbar location = down" branch derives the bottom inset from
    // the toolbar's own offsetTop, assuming the bar really sits at the bottom.
    // In rail mode the action bar is pinned top-right, so that branch produces
    // a bottom inset of nearly the whole viewport and collapses the canvas to
    // zero height. Recompute the insets here, after core.js has written its own.
    // The canvas runs the full height of the window; the topbar and the footer
    // credit float over it. core.js writes the same pair, so this only has to
    // avoid putting the old footer-derived inset back.
    const shell = document.getElementById("workspaceShell");
    if (shell) {
      shell.style.top = "0px";
      shell.style.bottom = "0px";
    }

    const dock = document.getElementById("toolDock");
    if (dock) dock.style.top = chromeTop + "px";
  }

  function sync() {
    applyLayout(railQuery.matches);
  }

  // sync() measures and then writes styles, so running it per resize event
  // forces a reflow on every frame of a drag-resize. Coalesce to one per frame.
  let framePending = false;
  function syncThrottled() {
    if (framePending) return;
    framePending = true;
    window.requestAnimationFrame(() => {
      framePending = false;
      sync();
    });
  }

  function initEditorChrome() {
    toolbar = document.querySelector(".toolbar");
    if (!toolbar) return;

    sync();

    if (typeof railQuery.addEventListener === "function") {
      railQuery.addEventListener("change", sync);
    } else if (typeof railQuery.addListener === "function") {
      railQuery.addListener(sync);
    }

    window.addEventListener("resize", syncThrottled);
    // the toolbar can change height when a tool's own controls appear
    document.addEventListener("toolChanged", () => syncInsets(railQuery.matches));

    // the location toggle still applies below the breakpoint, but in rail mode
    // it must not be allowed to rewrite the insets
    document.querySelectorAll("[data-toolbar-location]").forEach((button) => {
      button.addEventListener("click", () => {
        window.requestAnimationFrame(() => syncInsets(railQuery.matches));
      });
    });

    // The chrome is now the real chrome: the rail exists, the tools are in it,
    // the ribbon has been built and the insets are measured. write.html holds
    // all of it at opacity:0 until this class lands, so the half-built version
    // -- every tool in one centred bar, no rail, no ribbon -- is never painted.
    // This runs last of the three chrome scripts (file-ribbon, tool-dock, then
    // this one), so by here they have all had their DOMContentLoaded turn.
    document.body.classList.add("chrome-ready");
  }

  window.Inkyscib = window.Inkyscib || {};
  window.Inkyscib.EditorChrome = { sync };

  // With `defer` the DOM is already parsed when this runs, so waiting for
  // DOMContentLoaded only waited for the other 40-odd scripts to download.
  // Build the chrome as soon as this file executes; the readyState guard
  // keeps it correct if the script is ever loaded without defer.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initEditorChrome, { once: true });
  } else {
    initEditorChrome();
  }
})();
