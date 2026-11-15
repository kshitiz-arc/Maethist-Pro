/* Registers the offline shell (/sw.js) once the page has finished loading.
 *
 * Deliberately late and deliberately idle: the worker's install fetches every
 * script and font the app owns, and that must not compete with the first
 * stroke on a slow tablet.
 *
 * Automated browsers skip it unless a test asks for it by setting
 * window.__inkyscibOfflineShell = true, because a hundred background fetches
 * per test context turns the timing tests into noise.
 */
(function () {
  "use strict";

  if (!("serviceWorker" in navigator)) return;
  if (navigator.webdriver && !window.__inkyscibOfflineShell) return;

  function register() {
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(function () {
      /* Private mode, or an insecure origin: the app works online as before. */
    });
  }

  function whenIdle() {
    if ("requestIdleCallback" in window) {
      window.requestIdleCallback(register, { timeout: 4000 });
    } else {
      window.setTimeout(register, 2000);
    }
  }

  if (document.readyState === "complete") {
    whenIdle();
  } else {
    window.addEventListener("load", whenIdle, { once: true });
  }
}());
