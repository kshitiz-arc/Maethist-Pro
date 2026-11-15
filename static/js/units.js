// What the measurements are called.
//
// Every tool that reports a length — Line, Smart geometry, Compass, Algebra
// tiles — worked in the same grid unit and labelled it "u". That is fine until
// you are teaching in centimetres, at which point every label on the page is
// the wrong word.
//
// This is a name, not a conversion. Call the unit "cm" and a line that read
// "3.00 u" reads "3.00 cm"; the number does not move, the grid does not
// change, and nothing already drawn is rescaled. One shared name, editable
// from inside whichever tool you happen to be using, kept across sessions.
(function () {
  "use strict";

  const DEFAULT_NAME = "u";
  const MAX_LENGTH = 6;
  const STORAGE_KEY = "inkyscib_unit_name";
  const CHANGE_EVENT = "inkyscibUnitNameChanged";

  let name = DEFAULT_NAME;

  /**
   * Trim a typed unit name to something safe to put in a label.
   *
   * Names go straight into canvas text and into the DOM, so anything with
   * angle brackets or newlines is stripped rather than escaped at every call
   * site. An empty name falls back to the default instead of leaving numbers
   * with nothing after them.
   */
  function sanitize(value) {
    if (typeof value !== "string") return DEFAULT_NAME;
    const cleaned = value
      .replace(/[<>&"']/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, MAX_LENGTH);
    return cleaned || DEFAULT_NAME;
  }

  function get() {
    return name;
  }

  /**
   * Rename the unit everywhere.
   *
   * Returns the name actually applied, which may differ from what was asked
   * for once it has been trimmed.
   */
  function set(value, options = {}) {
    const next = sanitize(value);
    if (next === name && !options.force) return name;

    name = next;
    syncInputs();

    // Applying a name that came *out* of storage must not write it back:
    // preferences are applied part-way through loadDrawing(), and saving then
    // can commit a half-built workspace over the stored one.
    if (options.persist !== false) persist();

    if (options.silent) return name;

    try {
      document.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: { name } }));
    } catch (error) {
      /* nothing depends on this firing */
    }
    repaint();
    return name;
  }

  /**
   * A measurement with its unit: `format(3)` gives "3.00 cm".
   *
   * Callers that already have a formatted number pass it through as a string;
   * callers with a raw number get two decimals, which is what every tool was
   * doing before this module existed.
   */
  function format(value, options = {}) {
    const text = typeof value === "string"
      ? value
      : Number(value).toFixed(Number.isFinite(options.places) ? options.places : 2);
    return text + " " + label(options);
  }

  /** Just the unit, with a superscript two when it is an area. */
  function label(options = {}) {
    return options.squared ? name + "²" : name;
  }

  // ---------- persistence ----------

  function persist() {
    try {
      window.localStorage.setItem(STORAGE_KEY, name);
    } catch (error) {
      /* private mode; the name simply will not survive the session */
    }
    // Mirrored into the same record as the rest of the preferences so a
    // library backup carries it too.
    if (typeof window.saveDrawing === "function") window.saveDrawing();
  }

  function restore() {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (stored) name = sanitize(stored);
    } catch (error) {
      /* keep the default */
    }
  }

  // ---------- the editable chips ----------

  // Any element marked data-unit-name is a live view of the name. Inputs are
  // editable; everything else just displays it. This is what puts the control
  // in every tool without each tool having to know about it.
  function syncInputs() {
    document.querySelectorAll("[data-unit-name]").forEach((element) => {
      const text = element.dataset.unitName === "squared" ? name + "²" : name;
      if (element.tagName === "INPUT") {
        if (element.value !== text) element.value = text;
      } else if (element.textContent !== text) {
        element.textContent = text;
      }
    });
  }

  function bindInput(element) {
    if (element.dataset.unitBound === "1") return;
    element.dataset.unitBound = "1";

    element.setAttribute("maxlength", String(MAX_LENGTH));
    element.setAttribute("autocomplete", "off");
    element.setAttribute("spellcheck", "false");
    if (!element.getAttribute("aria-label")) {
      element.setAttribute("aria-label", "Unit name for measurements");
    }
    if (!element.getAttribute("title")) {
      element.setAttribute("title", "What to call this unit — type cm, mm, in, anything");
    }

    element.addEventListener("focus", () => element.select());
    // Commit as you type: seeing the labels follow along is the whole point,
    // and there is nothing destructive to undo.
    element.addEventListener("input", () => set(element.value));
    element.addEventListener("blur", () => set(element.value, { force: true }));
    element.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        element.blur();
      }
      // The canvas has single-key tool shortcuts; typing "cm" must not switch
      // tools halfway through.
      event.stopPropagation();
    });
  }

  function bindAll() {
    document.querySelectorAll("input[data-unit-name]").forEach(bindInput);
    syncInputs();
  }

  // ---------- repaint ----------

  // Canvas labels are redrawn here; each tool panel listens for the change
  // event and rebuilds its own text, since only the panel knows what it prints.
  function repaint() {
    if (typeof window.render === "function") window.render();
  }

  function init() {
    restore();
    bindAll();
    // Tool panels are built and moved around after load (tool-dock.js relocates
    // them), so re-bind whenever the dock changes hands.
    document.addEventListener("toolChanged", bindAll);
    // syncInputs runs a document-wide querySelectorAll, so it is skipped
    // while ink is in flight; unit names cannot change mid-stroke.
    document.addEventListener("canvasRendered", (event) => {
      if (event?.detail?.liveInk) return;
      syncInputs();
    });
  }

  window.Inkyscib = window.Inkyscib || {};
  window.Inkyscib.Units = {
    DEFAULT_NAME,
    CHANGE_EVENT,
    get,
    set,
    format,
    label,
    sanitize,
    bindAll,
    // called by storage.js when preferences load
    applyStored(value) {
      if (value) set(value, { silent: true, persist: false });
    }
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
