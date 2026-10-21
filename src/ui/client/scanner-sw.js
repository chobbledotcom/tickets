// Browser-only code - the scanner's service worker, served same-origin at
// /admin/scanner-sw.js (scope /admin/) with no-cache headers. An updated
// worker registers on the next scanner page load.
//
// It keeps the scanner page's script and stylesheet loadable without a
// connection. It stores nothing else. The scan posts, the ticket-hash cache
// responses, and the rendered admin pages carry live door state and guest
// details. The device must not hold those outside the page's own store.

const CACHE = "scanner-offline-assets";

const ASSETS = ["/scanner.js", "/style.css"];

const SCANNER_PAGE =
  /^\/admin\/(?:scanner|listing\/\d+\/scanner|groups\/\d+\/scanner)$/;

const OFFLINE_PAGE = `<!doctype html><meta charset="utf-8"><title>Scanner offline</title><p>You are offline. Reopen the scanner when you are back online.</p>`;

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await cache.addAll(ASSETS);
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      for (const name of names) {
        if (name !== CACHE) await caches.delete(name);
      }
      await self.clients.claim();
    })(),
  );
});

const networkFirst = async (request) => {
  const cache = await caches.open(CACHE);
  // The precache and the refreshes sit under the bare pathname. A
  // cache-busted request then stores and reads one entry, and no variant
  // piles up per build.
  const key = new URL(request.url).pathname;
  try {
    const response = await fetch(request);
    // A deploy's 404 or 500 must not become the stored copy the door then
    // serves offline.
    if (response.ok) cache.put(key, response.clone());
    return response;
  } catch {
    // Offline: the stored copy serves the door, and a miss answers the 503.
    return (
      (await cache.match(key)) ??
      new Response("", { status: 503, statusText: "Offline" })
    );
  }
};

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (request.mode === "navigate" && SCANNER_PAGE.test(url.pathname)) {
    // The rendered pages carry guest details, so they are never stored. An
    // offline navigation answers with a plain notice instead of the
    // browser's dead-page error.
    event.respondWith(
      fetch(request).catch(
        () =>
          new Response(OFFLINE_PAGE, {
            headers: { "content-type": "text/html; charset=utf-8" },
          }),
      ),
    );
    return;
  }
  if (ASSETS.includes(url.pathname)) {
    event.respondWith(networkFirst(request));
  }
});
