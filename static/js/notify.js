/* One on-screen notice for the whole editor: window.Inkyscib.notify().
 *
 * Several features report into status lines that live in the side menu,
 * which the v2 chrome never shows. Every import error -- a wrong file type,
 * a damaged PDF, a PowerPoint that cannot be rendered -- was therefore written
 * somewhere nobody could see it, and the import simply appeared to do
 * nothing. Anything a person must read now also comes through here.
 *
 *   window.Inkyscib.notify("Choose a .pdf file to import.", { tone: "error" })
 *
 * Tones: "error" (stays 6 s, announced assertively), "success", "info".
 * The same message twice in a row is shown once. Styles: chrome-compact.css.
 */
(function () {
  "use strict";

  let host = null;
  let last = { text: "", at: 0 };

  function ensureHost() {
    if (host && host.isConnected) return host;
    host = document.createElement("div");
    host.className = "app-notice-host";
    host.setAttribute("aria-live", "polite");
    document.body.appendChild(host);
    return host;
  }

  function notify(message, options) {
    const text = String(message || "").trim();
    if (!text) return;
    const tone = (options && options.tone) || "info";
    const now = Date.now();
    if (text === last.text && now - last.at < 1500) return;
    last = { text, at: now };

    const root = ensureHost();
    const notice = document.createElement("div");
    notice.className = "app-notice is-" + tone;
    notice.setAttribute("role", tone === "error" ? "alert" : "status");
    const iconRef = tone === "error" ? "lucide:circle-alert" : tone === "success" ? "lucide:circle-check" : "lucide:circle-question-mark";
    notice.innerHTML = (window.Inkyscib?.Icon?.svg?.(iconRef) || "") + "<span></span>";
    notice.querySelector("span").textContent = text;
    root.appendChild(notice);
    while (root.children.length > 3) root.firstElementChild.remove();

    window.setTimeout(() => {
      notice.classList.add("is-leaving");
      window.setTimeout(() => notice.remove(), 220);
    }, tone === "error" ? 6000 : 3200);
  }

  window.Inkyscib = window.Inkyscib || {};
  window.Inkyscib.notify = notify;
}());
