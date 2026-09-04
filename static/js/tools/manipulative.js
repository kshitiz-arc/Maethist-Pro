(function () {
  "use strict";
  // The unit's display name is shared across every tool that measures
  // something; see static/js/units.js. Falls back to "u" so a label never
  // comes out with a bare number if this module loads first.
  function unitLabel(squared) {
    return window.Inkyscib?.Units?.label({ squared: !!squared }) || (squared ? "u\u00b2" : "u");
  }


  // Toolbar / panel glue for the algebra-tile manipulatives. Mirrors the shape
  // tool's structure: a toolbar button that owns an options panel, plus a
  // selection inspector that appears whenever a single tile is selected.

  const LABEL_SUGGESTIONS = ["1", "2", "x", "y", "z", "x-y", "x+y"];

  let panel = null;
  let inspector = null;
  let toolButton = null;
  let clickTimer = null;
  let fieldEdit = null;
  let inspectorSignature = "";
  let variableSignature = "";
  let dragSession = null;

  function api() {
    return window.Inkyscib?.Manipulatives;
  }

  function state() {
    return window.appState;
  }

  function settings() {
    return api()?.toolSettings?.() || {};
  }

  function savePreferences() {
    if (typeof window.savePreferences === "function") window.savePreferences();
  }

  function saveDrawing() {
    if (typeof window.saveDrawing === "function") window.saveDrawing();
  }

  function redraw() {
    api()?.requestRedraw?.();
  }

  // ------------------------------------------------------------- placement

  function worldPointFromClient(clientX, clientY) {
    if (typeof window.clientPointToWorld !== "function") return null;
    let point = window.clientPointToWorld(clientX, clientY);
    if (state()?.notebook?.active && typeof window.normalizeNotebookPoint === "function") {
      point = window.normalizeNotebookPoint(point, { clamp: true });
    }
    return point;
  }

  function pointIsOverCanvas(clientX, clientY) {
    const canvas = document.getElementById("drawingCanvas");
    if (!canvas) return false;
    const rect = canvas.getBoundingClientRect();
    return clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom;
  }

  function placeTile(clientX, clientY, presetId) {
    const manipulatives = api();
    const s = state();
    if (!manipulatives || !s) return false;

    const point = worldPointFromClient(clientX, clientY);
    if (!point) return false;

    const path = manipulatives.createTilePath(point, presetId ? { preset: presetId } : {});
    if (typeof window.commitHistory === "function") window.commitHistory();
    s.paths.push(path);
    manipulatives.afterTileCreated(path, s.paths.length - 1);
    saveDrawing();
    return true;
  }

  // Drag a preset straight out of the tray and drop it on the canvas. Pointer
  // events keep this identical for mouse, pen, and touch.
  function startTrayDrag(event, chip) {
    if (event.button && event.button !== 0) return;
    const presetId = chip.dataset.tilePreset;
    if (!presetId) return;

    dragSession = {
      presetId,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      ghost: null,
      chip
    };

    try {
      chip.setPointerCapture(event.pointerId);
    } catch (error) {
      // Capture is a nicety; the window listeners below still finish the drag.
    }
  }

  function makeGhost(chip) {
    const ghost = chip.cloneNode(true);
    ghost.classList.add("tile-chip-ghost");
    ghost.removeAttribute("id");
    document.body.appendChild(ghost);
    return ghost;
  }

  function moveTrayDrag(event) {
    if (!dragSession || event.pointerId !== dragSession.pointerId) return;
    const dx = event.clientX - dragSession.startX;
    const dy = event.clientY - dragSession.startY;

    if (!dragSession.ghost) {
      if (Math.hypot(dx, dy) < 8) return;
      dragSession.ghost = makeGhost(dragSession.chip);
      document.body.classList.add("tile-dragging");
    }

    event.preventDefault();
    dragSession.ghost.style.transform =
      `translate3d(${event.clientX - 32}px, ${event.clientY - 26}px, 0) scale(1.06)`;
    dragSession.ghost.classList.toggle("is-over-canvas", pointIsOverCanvas(event.clientX, event.clientY));
  }

  function endTrayDrag(event) {
    if (!dragSession || event.pointerId !== dragSession.pointerId) return;
    const session = dragSession;
    dragSession = null;
    document.body.classList.remove("tile-dragging");

    if (session.ghost) {
      session.ghost.remove();
      if (pointIsOverCanvas(event.clientX, event.clientY)) {
        placeTile(event.clientX, event.clientY, session.presetId);
      }
    }

    try {
      session.chip.releasePointerCapture(session.pointerId);
    } catch (error) {
      // Already released when the pointer left the element.
    }
  }

  // ------------------------------------------------------------------ panel

  function setPreset(presetId, options = {}) {
    const config = settings();
    config.preset = presetId;
    // Each preset carries its own colour so a tray of tiles reads as a set at a
    // glance. Picking a swatch afterwards still overrides it.
    const preset = api()?.presetById?.(presetId);
    if (preset?.color) config.color = preset.color;
    syncPresetSelection();
    syncColorSelection();
    savePreferences();
    if (options.activateTool !== false && typeof window.setTool === "function") {
      if (state()?.currentTool !== "manipulative") window.setTool("manipulative");
    }
  }

  function syncPresetSelection() {
    const active = settings().preset || "x";
    document.querySelectorAll("[data-tile-preset]").forEach((chip) => {
      const isActive = chip.dataset.tilePreset === active;
      chip.classList.toggle("active", isActive);
      chip.setAttribute("aria-pressed", isActive ? "true" : "false");
    });
  }

  function syncSignSelection() {
    const negative = !!settings().negative;
    document.querySelectorAll("[data-tile-sign]").forEach((button) => {
      const isActive = (button.dataset.tileSign === "negative") === negative;
      button.classList.toggle("active", isActive);
      button.setAttribute("aria-pressed", isActive ? "true" : "false");
    });
  }

  function syncColorSelection() {
    const color = api()?.toHex?.(settings().color) || "#7c74ff";
    document.querySelectorAll("#manipulativeOptions .color-swatch").forEach((swatch) => {
      swatch.classList.toggle("active", swatch.dataset.color === color);
    });
    const custom = document.getElementById("manipulativeCustomColor");
    if (custom && document.activeElement !== custom) custom.value = color;
  }

  function renderVariables() {
    const list = document.getElementById("manipulativeVariableList");
    const empty = document.getElementById("manipulativeVariableEmpty");
    const manipulatives = api();
    if (!list || !manipulatives) return;

    const variables = manipulatives.variableList();
    const signature = variables
      .map((item) => `${item.name}:${item.value}:${item.hasSource}`)
      .join("|");
    if (signature === variableSignature) return;
    variableSignature = signature;

    if (empty) empty.hidden = variables.length > 0;
    list.replaceChildren();

    variables.forEach((variable) => {
      const row = document.createElement("div");
      row.className = "tile-variable-row";
      if (!variable.hasSource) row.classList.add("is-orphan");

      const name = document.createElement("span");
      name.className = "tile-variable-name";
      name.textContent = variable.name;

      const wrap = document.createElement("span");
      wrap.className = "geometry-number-wrap tile-variable-input";
      const input = document.createElement("input");
      input.type = "number";
      input.inputMode = "decimal";
      input.step = String(manipulatives.STEP_UNITS);
      input.min = String(manipulatives.MIN_UNITS);
      input.value = manipulatives.formatUnits(variable.value);
      input.dataset.tileVariable = variable.name;
      input.setAttribute("aria-label", `Value of ${variable.name}`);
      const unit = document.createElement("small");
      unit.dataset.unitName = "";
      window.Inkyscib?.Units?.bindAll?.();
      wrap.append(input, unit);

      row.append(name, wrap);

      if (!variable.hasSource) {
        const warning = document.createElement("span");
        warning.className = "tile-variable-warning";
        warning.title = "No tile defines this variable any more";
        warning.textContent = "⚠";
        row.appendChild(warning);
      }

      list.appendChild(row);
    });
  }

  function bindPanel() {
    panel = document.getElementById("manipulativeOptions");
    toolButton = document.getElementById("manipulativeTool");
    if (!panel || !toolButton) return;

    toolButton.onclick = () => {
      if (window.Inkyscib?.ToolDock?.isDockMode?.()) {
        if (typeof window.closeAllToolboxes === "function") window.closeAllToolboxes();
        if (typeof window.setTool === "function") window.setTool("manipulative");
        return;
      }

      const s = state();
      if (s?.currentTool === "manipulative" && !s.panMode) {
        if (clickTimer) {
          clearTimeout(clickTimer);
          clickTimer = null;
          if (typeof window.toggleToolbox === "function") window.toggleToolbox("manipulativeOptions");
        } else {
          clickTimer = setTimeout(() => { clickTimer = null; }, 300);
        }
        return;
      }

      if (typeof window.closeAllToolboxes === "function") window.closeAllToolboxes();
      if (typeof window.setTool === "function") window.setTool("manipulative");
      if (typeof window.toggleToolbox === "function") window.toggleToolbox("manipulativeOptions");
    };

    panel.querySelectorAll("[data-tile-preset]").forEach((chip) => {
      chip.addEventListener("click", () => setPreset(chip.dataset.tilePreset));
      chip.addEventListener("pointerdown", (event) => startTrayDrag(event, chip));
    });

    panel.querySelectorAll("[data-tile-sign]").forEach((button) => {
      button.addEventListener("click", () => {
        settings().negative = button.dataset.tileSign === "negative";
        syncSignSelection();
        savePreferences();
      });
    });

    panel.querySelectorAll(".color-swatch").forEach((swatch) => {
      swatch.addEventListener("click", () => {
        settings().color = swatch.dataset.color;
        syncColorSelection();
        savePreferences();
      });
    });

    const custom = document.getElementById("manipulativeCustomColor");
    if (custom) {
      custom.addEventListener("input", () => {
        settings().color = custom.value;
        syncColorSelection();
        savePreferences();
      });
    }

    const list = document.getElementById("manipulativeVariableList");
    if (list) {
      list.addEventListener("input", (event) => {
        const input = event.target;
        if (!(input instanceof HTMLInputElement) || !input.dataset.tileVariable) return;
        const value = Number(input.value);
        if (!Number.isFinite(value) || value <= 0) return;
        api()?.setVariable(input.dataset.tileVariable, value);
        variableSignature = "";
        redraw();
      });
      list.addEventListener("change", () => {
        saveDrawing();
        variableSignature = "";
        renderVariables();
      });
    }

    window.addEventListener("pointermove", moveTrayDrag, { passive: false });
    window.addEventListener("pointerup", endTrayDrag);
    window.addEventListener("pointercancel", endTrayDrag);

    syncPresetSelection();
    syncSignSelection();
    syncColorSelection();
    renderVariables();
  }

  // -------------------------------------------------------------- inspector

  function selected() {
    return api()?.selectedTile?.() || null;
  }

  function beginFieldEdit(key) {
    if (fieldEdit?.key === key) return;
    fieldEdit = {
      key,
      before: typeof window.captureHistory === "function" ? window.captureHistory() : null,
      dirty: false
    };
  }

  function liveFieldEdit(key, mutator) {
    const target = selected();
    if (!target) return;
    beginFieldEdit(key);
    mutator(target.path);
    fieldEdit.dirty = true;
    api()?.syncAll();
    redraw();
    inspectorSignature = "";
    variableSignature = "";
    syncInspector(true);
    renderVariables();
  }

  function finishFieldEdit(key) {
    if (fieldEdit?.key !== key) return;
    const edit = fieldEdit;
    fieldEdit = null;
    if (!edit.dirty) return;
    if (typeof window.commitHistory === "function" && edit.before) window.commitHistory(edit.before);
    saveDrawing();
  }

  function statusFor(path, dimension) {
    const detail = path?.detail?.[dimension];
    const manipulatives = api();
    if (!detail || !manipulatives) return { text: "", tone: "" };

    if (detail.kind === "empty") return { text: "Free — drag the handle or type a length", tone: "" };
    if (detail.kind === "number") {
      return { text: `Fixed length · type a value to change it`, tone: "locked" };
    }
    if (detail.kind === "variable") {
      return {
        text: `Shared variable · setting this resizes every ${detail.text} tile`,
        tone: "bound"
      };
    }
    if (detail.kind === "error") return { text: detail.error || "Cannot read this label", tone: "bad" };

    if (path.invalid?.[dimension]) {
      const raw = Number.isFinite(detail.raw) ? manipulatives.formatUnits(detail.raw) : "—";
      return {
        text: `${manipulatives.prettyMinus(detail.text)} = ${raw} → clamped to ${manipulatives.formatUnits(manipulatives.MIN_UNITS)} ${unitLabel()}`,
        tone: "bad"
      };
    }
    if (detail.orphan) return { text: "Source tile removed — value frozen", tone: "warn" };
    return { text: `Computed · ${manipulatives.formatUnits(detail.value)} ${unitLabel()}`, tone: "locked" };
  }

  function tileTitle(path) {
    const manipulatives = api();
    if (!manipulatives) return "Tile";
    const width = path.detail?.width?.text || "";
    const height = path.detail?.height?.text || "";
    const sign = path.negative ? "−" : "";
    if (!width && !height) return `${sign}Tile`.trim() || "Tile";
    if (width && width === height) return `${sign}${width}² tile`;
    return `${sign}${manipulatives.prettyMinus(width || "?")} × ${manipulatives.prettyMinus(height || "?")} tile`;
  }

  function syncInspector(force = false) {
    if (!inspector) return;
    const manipulatives = api();
    const target = selected();
    const visible = !!target && !state()?.clearAnimation;

    inspector.hidden = !visible;
    inspector.setAttribute("aria-hidden", visible ? "false" : "true");
    document.body.classList.toggle("tile-sheet-open", visible);
    if (!visible || !manipulatives) {
      inspectorSignature = "";
      return;
    }

    const { path } = target;
    if (!path.detail) manipulatives.syncAll();

    const signature = [
      target.index,
      path.widthLabel,
      path.heightLabel,
      path.negative,
      path.color,
      path.showMeasurements,
      JSON.stringify(path.detail || {}),
      JSON.stringify(path.invalid || {})
    ].join(":");
    if (!force && signature === inspectorSignature) return;
    inspectorSignature = signature;

    inspector.querySelector("#manipulativeInspectorTitle").textContent = tileTitle(path);

    const widthInput = inspector.querySelector("#manipulativeWidthLabel");
    const heightInput = inspector.querySelector("#manipulativeHeightLabel");
    if (document.activeElement !== widthInput) widthInput.value = path.widthLabel || "";
    if (document.activeElement !== heightInput) heightInput.value = path.heightLabel || "";

    [["width", "#manipulativeWidthStatus"], ["height", "#manipulativeHeightStatus"]].forEach(
      ([dimension, selector]) => {
        const node = inspector.querySelector(selector);
        const status = statusFor(path, dimension);
        node.textContent = status.text;
        node.dataset.tone = status.tone;
      }
    );

    const widthUnits = manipulatives.dimensionUnits(path, "width");
    const heightUnits = manipulatives.dimensionUnits(path, "height");
    inspector.querySelector("#manipulativeMeasureSize").textContent =
      `${manipulatives.formatUnits(widthUnits)} × ${manipulatives.formatUnits(heightUnits)} ${unitLabel()}`;
    inspector.querySelector("#manipulativeMeasureArea").textContent =
      `${manipulatives.formatUnits(widthUnits * heightUnits)} ${unitLabel(true)}`;

    [["width", "#manipulativeWidthValue", widthUnits], ["height", "#manipulativeHeightValue", heightUnits]]
      .forEach(([dimension, selector, units]) => {
        const input = inspector.querySelector(selector);
        const locked = path.detail?.[dimension]?.kind === "expression" ||
          path.detail?.[dimension]?.kind === "error";
        if (document.activeElement !== input) input.value = manipulatives.formatUnits(units);
        input.disabled = locked;
        input.title = locked
          ? "This length is computed — edit the label to change it"
          : "Type an exact length";
        input.closest(".tile-value-input")?.classList.toggle("is-locked", locked);
      });

    inspector.querySelectorAll("[data-tile-inspector-sign]").forEach((button) => {
      const isActive = (button.dataset.tileInspectorSign === "negative") === !!path.negative;
      button.classList.toggle("active", isActive);
      button.setAttribute("aria-pressed", isActive ? "true" : "false");
    });

    const colorInput = inspector.querySelector("#manipulativeTileColor");
    if (document.activeElement !== colorInput) colorInput.value = manipulatives.toHex(path.color);
    inspector.querySelector("#manipulativeShowValues").checked = path.showMeasurements !== false;
  }

  function attachSuggestions(input, dimension) {
    const row = input.closest(".tile-label-field")?.querySelector(".tile-suggestions");
    if (!row) return;
    LABEL_SUGGESTIONS.forEach((suggestion) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "tile-suggestion";
      chip.textContent = api()?.prettyMinus?.(suggestion) || suggestion;
      chip.addEventListener("click", () => {
        liveFieldEdit(`label-${dimension}`, (path) => api()?.setLabel(path, dimension, suggestion));
        finishFieldEdit(`label-${dimension}`);
        input.value = suggestion;
      });
      row.appendChild(chip);
    });
  }

  function bindLabelInput(id, dimension) {
    const input = inspector.querySelector(id);
    if (!input) return;
    const key = `label-${dimension}`;

    input.addEventListener("focus", () => beginFieldEdit(key));
    input.addEventListener("input", () => {
      liveFieldEdit(key, (path) => api()?.setLabel(path, dimension, input.value));
    });
    input.addEventListener("change", () => finishFieldEdit(key));
    input.addEventListener("blur", () => finishFieldEdit(key));
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") input.blur();
    });

    attachSuggestions(input, dimension);
  }

  function bindValueInput(id, dimension) {
    const input = inspector.querySelector(id);
    if (!input) return;
    const key = `value-${dimension}`;

    input.addEventListener("focus", () => beginFieldEdit(key));
    input.addEventListener("input", () => {
      const value = Number(input.value);
      if (!Number.isFinite(value) || value <= 0) return;
      liveFieldEdit(key, (path) => api()?.setDimensionValue(path, dimension, value));
    });
    input.addEventListener("change", () => finishFieldEdit(key));
    input.addEventListener("blur", () => finishFieldEdit(key));
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") input.blur();
    });
  }

  function bindInspector() {
    inspector = document.getElementById("manipulativeInspector");
    if (!inspector) return;

    inspector.querySelector("#manipulativeInspectorClose").addEventListener("click", () => {
      window.Inkyscib?.Selection?.clear?.();
    });

    bindLabelInput("#manipulativeWidthLabel", "width");
    bindLabelInput("#manipulativeHeightLabel", "height");
    bindValueInput("#manipulativeWidthValue", "width");
    bindValueInput("#manipulativeHeightValue", "height");

    inspector.querySelectorAll("[data-tile-inspector-sign]").forEach((button) => {
      button.addEventListener("click", () => {
        const negative = button.dataset.tileInspectorSign === "negative";
        liveFieldEdit("sign", (path) => { path.negative = negative; });
        finishFieldEdit("sign");
      });
    });

    const colorInput = inspector.querySelector("#manipulativeTileColor");
    colorInput.addEventListener("input", () => {
      liveFieldEdit("color", (path) => { path.color = colorInput.value; });
    });
    colorInput.addEventListener("change", () => finishFieldEdit("color"));
    colorInput.addEventListener("blur", () => finishFieldEdit("color"));

    inspector.querySelector("#manipulativeShowValues").addEventListener("change", (event) => {
      liveFieldEdit("showValues", (path) => { path.showMeasurements = !!event.target.checked; });
      finishFieldEdit("showValues");
    });

    inspector.querySelector("#manipulativeDuplicate").addEventListener("click", () => {
      const target = selected();
      const s = state();
      const manipulatives = api();
      if (!target || !s || !manipulatives) return;
      const copy = JSON.parse(JSON.stringify(target.path));
      const rect = manipulatives.tileRect(copy);
      manipulatives.setTileRect(
        copy,
        rect.left + rect.width + copy.unitScale * 0.5,
        rect.top,
        rect.width,
        rect.height
      );
      copy.timestamp = Date.now();
      if (typeof window.commitHistory === "function") window.commitHistory();
      s.paths.push(copy);
      manipulatives.syncAll();
      window.Inkyscib?.Selection?.selectIndex?.(s.paths.length - 1);
      redraw();
      saveDrawing();
    });

    inspector.querySelector("#manipulativeDelete").addEventListener("click", () => {
      window.Inkyscib?.Selection?.deleteSelected?.();
      api()?.rebuildRegistryFromPaths();
      variableSignature = "";
      renderVariables();
      redraw();
      saveDrawing();
    });

    api()?.onChange(() => {
      syncInspector();
      renderVariables();
    });
  }

  function init() {
    bindPanel();
    bindInspector();
    syncInspector(true);

    document.addEventListener("toolChanged", () => {
      syncPresetSelection();
      syncSignSelection();
      syncColorSelection();
      renderVariables();
    });
  }

  window.Inkyscib = window.Inkyscib || {};
  window.Inkyscib.ManipulativeTool = {
    placeTile,
    setPreset,
    renderVariables,
    syncInspector
  };


  // Renaming the unit changes every label this panel prints, so rebuild it.
  document.addEventListener("inkyscibUnitNameChanged", () => syncInspector(true));
  document.addEventListener("DOMContentLoaded", init);
})();
