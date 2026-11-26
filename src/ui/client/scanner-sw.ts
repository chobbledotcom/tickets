/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
// Browser-only code - the scanner's service worker, served same-origin at
// /admin/scanner-sw.js (scope /admin/) with no-cache headers. An updated
// worker registers on the next scanner page load.
//
// It keeps the scanner page's script and stylesheet loadable without a
// connection. It stores nothing else. The scan posts, the ticket-hash cache
// responses, and the rendered admin pages carry live door state and guest
// details. The device must not hold those outside the page's own store.

/** The install and activate events: the worker holds the phase open until
 * the promise it hands over settles. */
type LifecycleEvent = Event & { waitUntil: (work: Promise<unknown>) => void };

/** The fetch event: the worker answers the request with `respondWith`. */
type RequestEvent = Event & {
  request: Request;
  respondWith: (answer: Promise<Response>) => void;
};

type WorkerEvents = {
  activate: LifecycleEvent;
  fetch: RequestEvent;
  install: LifecycleEvent;
};

/** The part of the worker's scope this file uses. The page's DOM typings and
 * the worker typings cannot share one type-check run, so the scope is
 * described here instead of imported. */
type WorkerScope = {
  addEventListener: <Type extends keyof WorkerEvents>(
    type: Type,
    listener: (event: WorkerEvents[Type]) => void,
  ) => void;
  clients: { claim: () => Promise<void> };
  skipWaiting: () => Promise<void>;
};

const worker = self as WorkerScope & typeof self;

const CACHE = "scanner-offline-assets";

const ASSETS = ["/scanner.js", "/style.css"];

const SCANNER_PAGE =
  /^\/admin\/(?:scanner|listing\/\d+\/scanner|groups\/\d+\/scanner)$/;

const OFFLINE_PAGE = `<!doctype html><meta charset="utf-8"><title>Scanner offline</title><p>You are offline. Reopen the scanner when you are back online.</p>`;

worker.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      for (const asset of ASSETS) {
        // The bare URLs carry year-long immutable headers, so the precache
        // fetch must bypass the HTTP cache. Otherwise a worker update stores
        // the stale bare-URL copy the browser already holds.
        const response = await fetch(asset, { cache: "reload" });
        if (!response.ok) throw new Error(`Precache failed for ${asset}`);
        await cache.put(asset, response);
      }
      await worker.skipWaiting();
    })(),
  );
});

worker.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      for (const name of names) {
        // A renamed scanner cache is this worker's to clear. The origin's
        // other caches belong to other code and stay.
        if (name !== CACHE && name.startsWith("scanner-offline")) {
          await caches.delete(name);
        }
      }
      await worker.clients.claim();
    })(),
  );
});

const networkFirst = async (request: Request): Promise<Response> => {
  const cache = await caches.open(CACHE);
  // The precache and the refreshes sit under the bare pathname. A
  // cache-busted request then stores and reads one entry, and no variant
  // piles up per build.
  const key = new URL(request.url).pathname;
  try {
    const response = await fetch(request);
    // A deploy's 404 or 500 must not become the stored copy the door then
    // serves offline.
    if (response.ok) await storeFresh(cache, key, response);
    return response;
  } catch {
    // Offline: the stored copy serves the door, and a miss answers the 503.
    return (
      (await cache.match(key)) ??
      new Response("", { status: 503, statusText: "Offline" })
    );
  }
};

/** Write the fresh copy under the bare pathname before the request answers.
 * The write waits, so it survives the fetch event. The store is best effort.
 * A rejected write leaves the door the fresh network copy it already has. The
 * next online visit writes the store again. */
const storeFresh = async (
  cache: Cache,
  key: string,
  response: Response,
): Promise<void> => {
  try {
    await cache.put(key, response.clone());
  } catch {
    // A full store is the documented fallback: the fresh answer still serves.
  }
};

worker.addEventListener("fetch", (event) => {
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
