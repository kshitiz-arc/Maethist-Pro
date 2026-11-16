/* Data-subject rights, exercised by the person who holds the data.
 *
 * MAETHIST keeps notes, drawings and preferences in the visitor's own browser,
 * so GDPR Art. 15 (access), Art. 17 (erasure) and Art. 20 (portability) are
 * three buttons rather than a support queue. Nobody else can reach this data
 * -- which also means nobody else can delete it for them.
 *
 * One IIFE, one global (see consent.js for why that rule exists here).
 */
(function () {
  "use strict";

  // indexedDB.databases() is unimplemented in Firefox, so the database this
  // app actually creates is listed as a fallback: storage.js:9, one database
  // at version 2 with the `records` and `documents` object stores. Read from
  // the code and confirmed against a live page rather than guessed -- a wrong
  // name here reaches the privacy policy, which is a representation.
  var KNOWN_DATABASES = ["inkyscib_cache"];

  function listDatabases() {
    if (window.indexedDB && window.indexedDB.databases) {
      return window.indexedDB.databases()
        .then(function (entries) {
          return entries.map(function (entry) { return entry.name; })
            .filter(Boolean);
        })
        .catch(function () { return KNOWN_DATABASES.slice(); });
    }
    return Promise.resolve(KNOWN_DATABASES.slice());
  }

  function listCaches() {
    if (!window.caches || !window.caches.keys) return Promise.resolve([]);
    return window.caches.keys().catch(function () { return []; });
  }

  function cookieNames() {
    return document.cookie
      .split(";")
      .map(function (entry) { return entry.split("=")[0].trim(); })
      .filter(Boolean);
  }

  function readDatabase(name) {
    return new Promise(function (resolve) {
      var request;
      try {
        request = window.indexedDB.open(name);
      } catch (error) {
        resolve({ name: name, error: "could not open" });
        return;
      }
      request.onerror = function () { resolve({ name: name, error: "could not open" }); };
      request.onsuccess = function () {
        var db = request.result;
        var stores = Array.prototype.slice.call(db.objectStoreNames);
        if (!stores.length) { db.close(); resolve({ name: name, stores: {} }); return; }

        var out = {};
        var pending = stores.length;
        var tx = db.transaction(stores, "readonly");
        stores.forEach(function (store) {
          var all = tx.objectStore(store).getAll();
          all.onsuccess = function () {
            out[store] = all.result;
            if (--pending === 0) { db.close(); resolve({ name: name, stores: out }); }
          };
          all.onerror = function () {
            out[store] = "unreadable";
            if (--pending === 0) { db.close(); resolve({ name: name, stores: out }); }
          };
        });
      };
    });
  }

  function deleteDatabase(name) {
    return new Promise(function (resolve) {
      var request;
      try {
        request = window.indexedDB.deleteDatabase(name);
      } catch (error) { resolve(); return; }
      request.onsuccess = resolve;
      request.onerror = resolve;
      request.onblocked = resolve;   // a second tab holds it open; move on
    });
  }

  function inventory() {
    return Promise.all([listDatabases(), listCaches()]).then(function (results) {
      var localCount = 0;
      try { localCount = window.localStorage.length; } catch (error) { localCount = 0; }
      return {
        localStorage: localCount,
        indexedDB: results[0],
        caches: results[1],
        cookies: cookieNames().length
      };
    });
  }

  function exportEverything() {
    return listDatabases().then(function (names) {
      return Promise.all(names.map(readDatabase)).then(function (databases) {
        var local = {};
        try {
          for (var index = 0; index < window.localStorage.length; index += 1) {
            var key = window.localStorage.key(index);
            local[key] = window.localStorage.getItem(key);
          }
        } catch (error) { /* blocked storage exports as empty */ }

        var payload = {
          product: "MAETHIST",
          exportedAt: new Date().toISOString(),
          note: "Everything this browser holds for MAETHIST. GDPR Art. 15 and"
            + " Art. 20; nothing here was ever sent to a server.",
          localStorage: local,
          indexedDB: databases,
          cookies: cookieNames()
        };

        return new Blob([JSON.stringify(payload, null, 2)],
          { type: "application/json" });
      });
    });
  }

  function eraseEverything() {
    return listDatabases().then(function (names) {
      return Promise.all(names.map(deleteDatabase));
    }).then(function () {
      return listCaches();
    }).then(function (keys) {
      return Promise.all(keys.map(function (key) {
        return window.caches.delete(key).catch(function () {});
      }));
    }).then(function () {
      cookieNames().forEach(function (name) {
        var host = window.location.hostname;
        ["", "." + host, host].forEach(function (domain) {
          document.cookie = name + "=; Max-Age=0; path=/"
            + (domain ? "; domain=" + domain : "");
        });
      });
      try {
        window.sessionStorage.clear();
        window.localStorage.clear();   // last: it holds the consent record too
      } catch (error) { /* nothing to clear */ }
    });
  }

  function download(blob, filename) {
    var url = URL.createObjectURL(blob);
    var anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  window.InkyscibPrivacy = {
    inventory: inventory,
    exportEverything: exportEverything,
    eraseEverything: eraseEverything
  };

  function ready(fn) {
    if (document.readyState !== "loading") { fn(); return; }
    document.addEventListener("DOMContentLoaded", fn);
  }

  ready(function () {
    var exportButton = document.getElementById("exportEverything");
    var eraseButton = document.getElementById("eraseEverything");

    if (exportButton) {
      exportButton.addEventListener("click", function () {
        exportEverything().then(function (blob) {
          download(blob, "inkyscib-my-data-"
            + new Date().toISOString().slice(0, 10) + ".json");
        });
      });
    }

    if (eraseButton) {
      eraseButton.addEventListener("click", function () {
        var confirmed = window.confirm(
          "This deletes every notebook, drawing and preference in this "
          + "browser. It cannot be undone. Export a backup first if you want "
          + "to keep anything."
        );
        if (!confirmed) return;
        eraseEverything().then(function () {
          window.alert("Everything MAETHIST held in this browser is gone.");
          window.location.reload();
        });
      });
    }
  });
}());
