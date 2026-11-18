// "There is more": a cue on every panel that scrolls.
//
// A long tool panel or sheet scrolls, but on an Android tablet a scrollbar
// only appears once you are already scrolling, so options below the fold
// simply did not exist for anyone who did not think to swipe. Every scroller
// listed here gets:
//
//   * a "More" chip pinned to its bottom edge while anything is below; a tap
//     scrolls about a screenful, and the chip goes once the end is reached;
//   * soft fades at whichever edge has content beyond it.
//
// The chip lives inside the scroller (position: sticky), so it moves with
// the panel and needs no positioning of its own. Panels that appear later
// (the Pomodoro, the Sound studio, the image sheet) are picked up as they are
// added. static/css/scroll-cue.css draws it.
(() => {
  "use strict";

  const SELECTORS = [
    ".tool-dock-body",
    ".tool-panel-layer > .tool-options",
    ".file-backstage-pane",
    ".pomo-panel",
    ".img-sheet-card",
    ".yt-note-list",
    ".library-panel-body",
    ".canvas-theme-pop"
  ].join(",");

  const tracked = new WeakSet();
  const EDGE = 6;

  function update(el) {
    const cue = el.__scrollCue;
    const scrollable = el.scrollHeight - el.clientHeight > EDGE;
    const above = scrollable && el.scrollTop > EDGE;
    const below = scrollable && el.scrollTop + el.clientHeight < el.scrollHeight - EDGE;
    el.classList.toggle("sc-above", above);
    el.classList.toggle("sc-below", below);
    if (cue) cue.hidden = !below;
  }

  function attach(el) {
    if (tracked.has(el)) return;
    tracked.add(el);
    el.classList.add("sc-scroller");

    const wrap = document.createElement("div");
    wrap.className = "sc-cue";
    wrap.hidden = true;
    wrap.innerHTML = '<button type="button" class="sc-more" aria-label="Scroll down for more options">' +
      '<svg viewBox="0 0 24 24" aria-hidden="true" class="sc-arrow"><path d="M6 9l6 6 6-6"/></svg>' +
      "<span>More</span></button>";
    el.appendChild(wrap);
    el.__scrollCue = wrap;

    wrap.querySelector("button").addEventListener("click", (event) => {
      event.stopPropagation();
      el.scrollBy({ top: Math.max(120, el.clientHeight * 0.8), behavior: "smooth" });
    });

    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        update(el);
      });
    };
    el.addEventListener("scroll", schedule, { passive: true });
    if ("ResizeObserver" in window) {
      const ro = new ResizeObserver(schedule);
      ro.observe(el);
      [...el.children].forEach((child) => { if (child !== wrap) ro.observe(child); });
    }
    update(el);
  }

  function scan(root) {
    const scope = root && root.querySelectorAll ? root : document;
    if (scope.matches && scope.matches(SELECTORS)) attach(scope);
    scope.querySelectorAll(SELECTORS).forEach(attach);
  }

  let pending = 0;
  function rescan() {
    if (pending) return;
    pending = window.setTimeout(() => {
      pending = 0;
      scan(document);
      // A panel that was hidden when it was attached has no size until it
      // opens, so re-measure everything we know about on each change.
      document.querySelectorAll(".sc-scroller").forEach(update);
    }, 120);
  }

  function start() {
    scan(document);
    new MutationObserver(rescan).observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["hidden", "class", "style"]
    });
    window.addEventListener("resize", rescan, { passive: true });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();

  window.Inkyscib = window.Inkyscib || {};
  window.Inkyscib.ScrollCue = { refresh: rescan, attach };
})();
