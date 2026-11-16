/* Inkyscib offline shell.
 *
 * Rendered by Flask (app.py: service_worker) so the asset list below is the
 * real one, with each file's own version token. Three rules:
 *
 *   - pages:    network first, the cached copy when the network fails or
 *               takes longer than NETWORK_GRACE_MS (a sleeping host).
 *               A visitor on a working connection gets today's HTML.
 *   - /static/: cache first. Every URL carries a token derived from the file,
 *               so a cached answer can never be a stale one.
 *   - the rest: untouched. /api/ needs the server by definition, and anything
 *               cross-origin (the YouTube player, the AR model) is not ours
 *               to cache.
 *
 * Nothing a visitor draws passes through here. Their work lives in
 * localStorage and IndexedDB, which never needed the network.
 */
"use strict";

const CACHE = {{ cache_name|tojson }};
const PREFIX = "inkyscib-shell-";
const PAGES = {{ pages|tojson }};
const ASSETS = {{ assets|tojson }};

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // One missing file must not sink the install, so each is added on its
    // own instead of through addAll(), which is all-or-nothing.
    const add = async (url) => {
      try {
        const response = await fetch(url, { cache: "no-cache" });
        if (response.ok) await cache.put(url, response);
      } catch (error) { /* offline mid-install: the next visit retries */ }
    };
    await Promise.all(PAGES.map(add));
    // Six at a time: this runs beside someone's first strokes on a slow
    // tablet, and a hundred parallel requests would be felt.
    const queue = ASSETS.slice();
    const worker = async () => {
      while (queue.length) await add(queue.shift());
    };
    await Promise.all([1, 2, 3, 4, 5, 6].map(worker));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(
      names
        .filter((name) => name.startsWith(PREFIX) && name !== CACHE)
        .map((name) => caches.delete(name))
    );
    await self.clients.claim();
  })());
});

// A free-tier host sleeps when idle and takes 30-60 s to wake. Network-first
// alone would make a student stare at a blank tab all that time even though a
// working copy of the page is on the device. So the network gets this long;
// after that the cached page is shown and the fresh one still lands in the
// cache for next time.
const NETWORK_GRACE_MS = 3500;

async function pageResponse(event) {
  const request = event.request;
  const cache = await caches.open(CACHE);
  const url = new URL(request.url);
  const fromNetwork = fetch(request).then((response) => {
    if (response.ok && PAGES.includes(url.pathname)) {
      cache.put(url.pathname, response.clone());
    }
    return response;
  });
  // Keep the worker alive until the network answer is stored, even when the
  // cached copy was served first.
  event.waitUntil(fromNetwork.catch(() => {}));

  const cached = await cache.match(url.pathname);
  if (!cached) {
    try {
      return await fromNetwork;
    } catch (error) {
      // An uncached page offline: the editor is the useful place to land.
      const editor = await cache.match("/write");
      if (editor) return editor;
      throw error;
    }
  }

  const slow = new Promise((resolve) => setTimeout(() => resolve(null), NETWORK_GRACE_MS));
  try {
    const first = await Promise.race([fromNetwork, slow]);
    return first || cached;
  } catch (error) {
    return cached;
  }
}

async function assetResponse(request) {
  const cache = await caches.open(CACHE);
  const exact = await cache.match(request);
  if (exact) return exact;
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch (error) {
    // Same file under an older token is better than nothing while offline.
    const loose = await cache.match(request, { ignoreSearch: true });
    if (loose) return loose;
    throw error;
  }
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/lab/")) return;
  if (url.pathname.startsWith("/static/js/inklab/")) return;

  if (request.mode === "navigate") {
    event.respondWith(pageResponse(event));
    return;
  }
  if (url.pathname.startsWith("/static/")) {
    event.respondWith(assetResponse(request));
  }
});
