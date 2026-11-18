/* Odometer digits, ported from VengeanceUI's animated-number (MIT, Ashutosh —
 * https://github.com/Ashutoshx7/VengeanceUI).
 *
 * Upstream renders a vertical strip per digit and slides it with Framer
 * Motion's AnimatePresence. The library is not what makes it work: a column of
 * 0-9 translated by -digit x 1em is, and that is three lines of CSS plus this.
 *
 * Progressive enhancement, strictly. The number in the markup is the truth;
 * this reads it, rolls to it once when the element is first scrolled into
 * view, and never runs again. With JavaScript off, or under reduced motion,
 * the page is exactly what it is today.
 *
 * One IIFE, one global -- in a classic script a top-level `function name` is
 * `window.name`, which broke every preference save in this app once.
 */
(function () {
  "use strict";

  var SELECTOR = ".profile-stat b";
  var DIGITS = "0123456789";

  function prefersReducedMotion() {
    try {
      return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch (error) {
      return false;   // no matchMedia: treat as no preference expressed
    }
  }

  /* "390+" -> the digits roll, the "+" does not. "#1" keeps its hash. Anything
     with no digit at all is left alone entirely. */
  function build(element) {
    var text = element.textContent.trim();
    if (!text || !/\d/.test(text)) return null;

    var wrapper = document.createElement("span");
    wrapper.className = "odometer";

    // The real number, visually hidden but present in the accessibility tree
    // and in the text layer. An aria-label on a plain span is a prohibited
    // attribute (axe flagged it), and it would also have left the visible
    // strips as the only copyable text -- selecting "390+" would have yielded
    // "012345678901234567890123456789+".
    var value = document.createElement("span");
    value.className = "odometer-value";
    value.textContent = text;
    wrapper.appendChild(value);

    var strips = [];
    var digitIndex = 0;

    for (var i = 0; i < text.length; i += 1) {
      var character = text.charAt(i);

      if (DIGITS.indexOf(character) === -1) {
        var literal = document.createElement("span");
        literal.textContent = character;
        literal.setAttribute("aria-hidden", "true");
        wrapper.appendChild(literal);
        continue;
      }

      var cell = document.createElement("span");
      cell.className = "odometer-digit";
      cell.setAttribute("aria-hidden", "true");

      var strip = document.createElement("span");
      strip.className = "odometer-strip";
      for (var n = 0; n < 10; n += 1) {
        var digit = document.createElement("span");
        digit.textContent = String(n);
        strip.appendChild(digit);
      }

      // Start at 0 and roll to the real digit, staggered left to right so the
      // number reads as settling rather than flicking.
      strip.style.setProperty("--odometer-delay", (digitIndex * 70) + "ms");
      cell.appendChild(strip);
      wrapper.appendChild(cell);
      strips.push({ strip: strip, value: Number(character) });
      digitIndex += 1;
    }

    return { wrapper: wrapper, strips: strips };
  }

  function roll(built) {
    built.strips.forEach(function (entry) {
      // One cell per digit. The cell is taller than the glyph (vengeance.css,
      // --odometer-cell), so it is the cell, not 1em, the strip moves by.
      entry.strip.style.transform = "translateY(calc(-" + entry.value + " * var(--odometer-cell, 1.3em)))";
    });
  }

  function ready(fn) {
    if (document.readyState !== "loading") { fn(); return; }
    document.addEventListener("DOMContentLoaded", fn);
  }

  ready(function () {
    var targets = document.querySelectorAll(SELECTOR);
    if (!targets.length) return;

    // Reduced motion, or a browser without IntersectionObserver: leave the
    // markup untouched. The number is already correct.
    if (prefersReducedMotion() || !window.IntersectionObserver) return;

    var pending = [];

    Array.prototype.forEach.call(targets, function (element) {
      var built = build(element);
      if (!built) return;
      element.textContent = "";
      element.appendChild(built.wrapper);
      pending.push({ element: element, built: built });
    });

    if (!pending.length) return;

    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        observer.unobserve(entry.target);   // one roll, ever
        for (var i = 0; i < pending.length; i += 1) {
          if (pending[i].element === entry.target) {
            roll(pending[i].built);
            break;
          }
        }
      });
    }, { threshold: 0.6 });

    pending.forEach(function (item) { observer.observe(item.element); });
  });
}());
