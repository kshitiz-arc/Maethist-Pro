// The master switch for measurement labels.
//
// Every tool that writes a number onto the canvas records that choice on the
// object it drew: an arc remembers whether to show its sweep, a line remembers
// whether to show its length, a tile remembers its dimensions. That is on
// purpose — it lets you label the one arc that matters and leave the
// scaffolding clean — and each panel says so.
//
// What it did not give you was a way to clear the board. Turning a tool's
// toggle off changed the next thing you drew, not the twenty already on
// screen, which reads as a toggle that does nothing.
//
// This sits above that. One switch hides every label at once, and turning it
// back on restores each object's own setting, because nothing was overwritten
// to hide it.
(function () {
  "use strict";

  const STORAGE_KEY = "inkyscib_hide_measurements";
  const CHANGE_EVENT = "inkyscibMeasurementsChanged";

  let hidden = false;

  /** False while the master switch is hiding everything. */
  function visible() {
    return !hidden;
  }

  function isHidden() {
    return hidden;
  }

  function set(next, options = {}) {
    const value = !!next;
    if (value === hidden && !options.force) return hidden;
    hidden = value;

    syncToggles();
    if (options.persist !== false) persist();

    try {
      document.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: { hidden } }));
    } catch (error) {
      /* nothing depends on this firing */
    }
    // Labels are painted by the canvas, so this is what makes the switch feel
    // instant rather than "next time you draw something".
    if (typeof window.render === "function") window.render();
    return hidden;
  }

  function toggle() {
    return set(!hidden);
  }

  function persist() {
    try {
      window.localStorage.setItem(STORAGE_KEY, hidden ? "1" : "0");
    } catch (error) {
      /* private mode; the choice will not survive the session */
    }
  }

  function restore() {
    try {
      hidden = window.localStorage.getItem(STORAGE_KEY) === "1";
    } catch (error) {
      hidden = false;
    }
  }

  // Any checkbox marked data-measurements-master drives this, so each tool
  // panel can carry one without knowing anything about the others.
  function syncToggles() {
    document.querySelectorAll("[data-measurements-master]").forEach((element) => {
      if (element.checked !== hidden) element.checked = hidden;
    });
    document.body?.classList.toggle("measurements-hidden", hidden);
  }

  function bind() {
    document.querySelectorAll("[data-measurements-master]").forEach((element) => {
      if (element.dataset.measurementsBound === "1") return;
      element.dataset.measurementsBound = "1";
      element.addEventListener("change", () => set(element.checked));
    });
    syncToggles();
  }

  function init() {
    restore();
    bind();
    // Tool panels are built and relocated after load, so re-bind when the dock
    // changes hands.
    document.addEventListener("toolChanged", bind);
  }

  window.Inkyscib = window.Inkyscib || {};
  window.Inkyscib.Measurements = {
    CHANGE_EVENT,
    visible,
    isHidden,
    set,
    toggle,
    bind
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
