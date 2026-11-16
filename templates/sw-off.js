/* MAETHIST offline shell: switched off (OFFLINE_SHELL=off in app.py).
 *
 * Replaces whatever worker a visitor has installed. It deletes the cached
 * copy of the app, unregisters itself, and reloads any open MAETHIST tab so
 * it is served straight from the network. It never touches the visitor's
 * notes, which live in IndexedDB and localStorage, not in Cache Storage.
 */
"use strict";

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(
      names.filter((name) => name.startsWith("inkyscib-shell-")).map((name) => caches.delete(name))
    );
    await self.registration.unregister();
    const tabs = await self.clients.matchAll({ type: "window" });
    for (const tab of tabs) {
      try { tab.navigate(tab.url); } catch (error) { /* a tab mid-unload */ }
    }
  })());
});
