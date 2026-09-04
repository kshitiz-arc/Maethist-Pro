// Hex entry for every colour picker in the app.
//
// Rather than teach each tool about hex codes, this upgrades the native
// <input type="color"> each panel already has: the hex field writes into that
// input and fires its events, so every handler the tools already registered
// keeps working, untouched. Adding a colour picker anywhere in future gets hex
// for free.
//
// Opt out with data-no-hex on the input.
(function () {
  "use strict";

  const HEX_PATTERN = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

  // "5a5aff", "#5A5AFF" and "5af" all name the same colour. The canonical
  // six-digit form is what gets written back, so a typed colour and a picked
  // one compare equal.
  function normalizeHex(raw) {
    const value = String(raw == null ? "" : raw).trim();
    if (!value) return null;
    const match = HEX_PATTERN.exec(value);
    if (!match) return null;
    let digits = match[1].toLowerCase();
    if (digits.length === 3) {
      digits = digits[0] + digits[0] + digits[1] + digits[1] + digits[2] + digits[2];
    }
    return "#" + digits;
  }

  // Swatches carry any CSS colour: "black", "rgba(...)", a hex. The browser is
  // the only thing that knows what they all resolve to, so ask it.
  const resolver = document.createElement("span");

  function toHex(cssColor) {
    if (!cssColor) return null;
    const direct = normalizeHex(cssColor);
    if (direct) return direct;

    resolver.style.color = "";
    resolver.style.color = cssColor;
    if (!resolver.style.color) return null;

    document.body.appendChild(resolver);
    const computed = getComputedStyle(resolver).color;
    resolver.remove();

    const match = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i.exec(computed);
    if (!match) return null;
    return "#" + [1, 2, 3]
      .map((i) => Number(match[i]).toString(16).padStart(2, "0"))
      .join("");
  }

  function upgrade(picker) {
    if (!picker || picker.dataset.hexReady === "true") return;
    if (picker.hasAttribute("data-no-hex")) return;

    picker.dataset.hexReady = "true";

    const wrap = document.createElement("span");
    wrap.className = "hex-field";

    const hash = document.createElement("span");
    hash.className = "hex-field-hash";
    hash.setAttribute("aria-hidden", "true");
    hash.textContent = "#";

    const input = document.createElement("input");
    input.type = "text";
    input.className = "hex-field-input";
    input.maxLength = 7;
    input.autocomplete = "off";
    input.spellcheck = false;
    input.placeholder = "ffffff";
    input.setAttribute(
      "aria-label",
      (picker.getAttribute("aria-label") || picker.title || "Colour") + " hex code"
    );

    wrap.appendChild(hash);
    wrap.appendChild(input);
    picker.after(wrap);

    function pull() {
      // never overwrite a half-typed code under the cursor
      if (document.activeElement === input) return;
      const value = normalizeHex(picker.value);
      input.value = value ? value.slice(1) : "";
    }

    // Drive the real picker and fire its events, so whatever the tool already
    // registered on it runs exactly as if the swatch had been used.
    function push(hex) {
      picker.value = hex;
      picker.dispatchEvent(new Event("input", { bubbles: true }));
      picker.dispatchEvent(new Event("change", { bubbles: true }));
    }

    // Opt-in: a tool where clearing the field means "no custom colour" rather
    // than "some colour I have not finished typing". The compass needs this —
    // its first swatch is an explicit no-colour state — and without it the
    // shared field could not replace the compass's own hex control.
    const clearable = picker.hasAttribute("data-hex-clearable");

    function clear() {
      picker.dispatchEvent(new CustomEvent("hexcleared", { bubbles: true }));
    }

    input.addEventListener("input", () => {
      // typed a character at a time, so an incomplete code is not an error
      const parsed = normalizeHex(input.value);
      if (parsed) push(parsed);
      else if (clearable && !input.value.trim()) clear();
    });

    // An unparseable code snaps back to the colour actually in force rather
    // than leaving the field claiming something that was never applied.
    const commit = () => {
      const parsed = normalizeHex(input.value);
      if (parsed) push(parsed);
      else if (clearable && !input.value.trim()) clear();
      pull();
    };

    input.addEventListener("change", commit);
    input.addEventListener("blur", commit);
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        commit();
        input.blur();
      } else if (event.key === "Escape") {
        event.preventDefault();
        pull();
        input.blur();
      }
      // the canvas listens for bare keys (space pans, Delete clears)
      event.stopPropagation();
    });

    picker.addEventListener("input", pull);
    picker.addEventListener("change", pull);

    pull();
    return pull;
  }

  const syncs = [];

  function upgradeAll() {
    document.querySelectorAll('input[type="color"]').forEach((picker) => {
      const pull = upgrade(picker);
      if (pull) syncs.push(pull);
    });
  }

  // A swatch click changes the colour without touching the picker, so the hex
  // fields are refreshed whenever anything that could have changed one settles.
  function syncAll() {
    syncs.forEach((pull) => pull());
  }

  function init() {
    upgradeAll();

    // A swatch sets the tool's colour without going through the picker, so the
    // hex field would keep showing the previous value. Mirror the swatch into
    // the picker (silently — the tool's own handler has already run) so the
    // field reads true.
    document.addEventListener("click", (event) => {
      const swatch = event.target?.closest?.(".color-swatch, .compass-swatch");
      if (swatch) {
        const row = swatch.closest(".colors, .compass-colors");
        const picker = row?.querySelector('input[type="color"]');
        const value = swatch.dataset.color
          || swatch.dataset.compassColor
          || swatch.dataset.angleColor
          || swatch.style.background;
        const hex = toHex(value);
        if (picker && hex) picker.value = hex;
      } else if (!event.target?.closest?.(".colors")) {
        return;
      }
      window.setTimeout(syncAll, 0);
    });

    document.addEventListener("toolChanged", () => window.setTimeout(syncAll, 0));
  }

  window.Inkyscib = window.Inkyscib || {};
  window.Inkyscib.ColorField = { upgradeAll, syncAll, normalizeHex, toHex };

  document.addEventListener("DOMContentLoaded", init);
})();
