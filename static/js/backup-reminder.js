/* Reminds a student to back up before the browser can lose their work.
 *
 * MAETHIST keeps every notebook in this browser and nowhere else. Clearing
 * site data, a reset tablet or a browser that evicts storage under pressure
 * deletes it, and nobody outside tech expects that. The .inky backup is the
 * only copy that survives, so this nudges toward it:
 *
 *   - never backed up, and there has been work here for 2+ days, or
 *   - the last backup is 7+ days old and there has been work since.
 *
 * "Later" snoozes it for 2 days. It never opens on a first visit, never over
 * a dialog, and never while drawing, and it sits in the bottom-left corner,
 * clear of the toolbar, the panels and the page switcher.
 */
(function () {
  "use strict";

  var LAST_BACKUP = "inkyscib-last-backup";
  var FIRST_WORK = "inkyscib-first-work-at";
  var LAST_WORK = "inkyscib-last-work-at";
  var SNOOZE = "inkyscib-backup-snooze-until";
  var DAY = 24 * 60 * 60 * 1000;
  var NEVER_AFTER = 2 * DAY;
  var STALE_AFTER = 7 * DAY;
  var SNOOZE_FOR = 2 * DAY;

  function read(key) {
    try { return window.localStorage.getItem(key); } catch (error) { return null; }
  }

  function write(key, value) {
    try { window.localStorage.setItem(key, value); } catch (error) { /* blocked */ }
  }

  function time(key) {
    var value = Date.parse(read(key) || "");
    return Number.isFinite(value) ? value : null;
  }

  function hasWork() {
    var state = window.appState;
    if (!state) return false;
    var paths = state.notebook && state.notebook.active
      ? (state.notebook.freeformPaths || []).concat(state.notebook.paths || [])
      : (state.paths || []);
    return paths.length > 0 || !!(state.ppt && state.ppt.active);
  }

  // Exposed so a test can ask the question without waiting days.
  function due(now) {
    now = now || Date.now();
    var snooze = time(SNOOZE);
    if (snooze && snooze > now) return null;
    var first = time(FIRST_WORK);
    var last = time(LAST_BACKUP);
    var lastWork = time(LAST_WORK) || first;
    if (!first) return null;
    if (!last) return now - first >= NEVER_AFTER ? { never: true } : null;
    if (now - last >= STALE_AFTER && lastWork && lastWork > last) {
      return { never: false, days: Math.floor((now - last) / DAY) };
    }
    return null;
  }

  function busy() {
    var state = window.appState;
    if (state && (state.isDrawing || state.isPanning)) return true;
    return !!document.querySelector(
      ".library-modal.active, .file-backstage.is-open, .feature-tour.is-open, " +
      ".pomo-overlay.is-open, .planner-overlay:not([hidden]), .tool-help-sheet:not([hidden])"
    );
  }

  var bar = null;

  function hide() {
    if (bar) { bar.remove(); bar = null; }
  }

  function show(reason) {
    if (bar) return;
    bar = document.createElement("div");
    bar.className = "backup-reminder";
    bar.setAttribute("role", "status");
    var text = document.createElement("p");
    text.className = "backup-reminder-text";
    text.textContent = reason.never
      ? "Your notes are saved only in this browser. Download a backup so you can't lose them."
      : "Your last backup was " + reason.days + " days ago. Download a fresh one so new notes are safe.";
    var now = document.createElement("button");
    now.type = "button";
    now.className = "backup-reminder-go";
    now.textContent = "Back up now";
    now.addEventListener("click", function () {
      var library = window.Inkyscib && window.Inkyscib.Library;
      if (library && typeof library.exportBackup === "function") library.exportBackup();
      hide();
    });
    var later = document.createElement("button");
    later.type = "button";
    later.className = "backup-reminder-later";
    later.textContent = "Later";
    later.addEventListener("click", function () {
      write(SNOOZE, new Date(Date.now() + SNOOZE_FOR).toISOString());
      hide();
    });
    bar.appendChild(text);
    bar.appendChild(now);
    bar.appendChild(later);
    document.body.appendChild(bar);
  }

  function check() {
    var reason = due();
    if (!reason) { hide(); return; }
    if (busy()) return;
    show(reason);
  }

  document.addEventListener("inkyscibDocumentSaved", function () {
    if (!hasWork()) return;
    var stamp = new Date().toISOString();
    if (!read(FIRST_WORK)) write(FIRST_WORK, stamp);
    write(LAST_WORK, stamp);
  });

  document.addEventListener("inkyscibBackupSaved", hide);

  window.Inkyscib = window.Inkyscib || {};
  window.Inkyscib.BackupReminder = { due: due, check: check };

  function start() {
    // Late, so it never competes with the first paint or the first stroke.
    window.setTimeout(check, 8000);
    window.setInterval(check, 10 * 60 * 1000);
  }

  if (document.readyState === "complete") start();
  else window.addEventListener("load", start, { once: true });
}());
