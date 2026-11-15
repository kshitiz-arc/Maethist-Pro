/* The tool row below 1180px scrolls sideways (static/css/chrome-compact.css).
 * This tells it which edges have more to reach, so it can fade them, and
 * brings the tool you pick into view. No layout is decided here.
 */
(function () {
  "use strict";

  function ready(fn) {
    if (document.readyState !== "loading") { fn(); return; }
    document.addEventListener("DOMContentLoaded", fn, { once: true });
  }

  ready(function () {
    var bar = document.querySelector(".toolbar");
    if (!bar) return;

    var queued = false;

    function measure() {
      queued = false;
      var max = bar.scrollWidth - bar.clientWidth;
      bar.classList.toggle("can-scroll-start", max > 1 && bar.scrollLeft > 1);
      bar.classList.toggle("can-scroll-end", max > 1 && bar.scrollLeft < max - 1);
    }

    function schedule() {
      if (queued) return;
      queued = true;
      window.requestAnimationFrame(measure);
    }

    bar.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule, { passive: true });

    // A wheel over the row moves it sideways; a mouse has no other way.
    bar.addEventListener("wheel", function (event) {
      if (bar.scrollWidth <= bar.clientWidth) return;
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      bar.scrollLeft += event.deltaY;
      event.preventDefault();
    }, { passive: false });

    bar.addEventListener("click", function (event) {
      var control = event.target.closest && event.target.closest("button");
      if (!control || !bar.contains(control)) return;
      if (bar.scrollWidth <= bar.clientWidth) return;
      var box = control.getBoundingClientRect();
      var frame = bar.getBoundingClientRect();
      if (box.left < frame.left + 44) bar.scrollLeft -= (frame.left + 44 - box.left);
      else if (box.right > frame.right - 44) bar.scrollLeft += (box.right - frame.right + 44);
    });

    // editor-chrome.js moves controls in and out at the rail breakpoint.
    if ("MutationObserver" in window) {
      new MutationObserver(schedule).observe(bar, { childList: true, subtree: true });
    }
    schedule();
    window.addEventListener("load", schedule, { once: true });
  });
}());
