/// <reference lib="dom" />

/**
 * The scanner's offline shell: a service worker that saves the scanner page
 * and its bundle, so a door can reload the page with no connection.
 *
 * The strategies are plain request-in/response-out functions a test can
 * drive. The worker wiring at the bottom is three lines. The worker only
 * ever answers two requests: the scanner page itself, and the scanner
 * bundle. Everything else — the scan API, the token list, every other admin
 * page — reaches the network untouched.
 */

import { SCANNER_JS_PATH } from "#shared/asset-paths.ts";

/** Bump the version when the saved shell's contents change. Activation
 * then drops the previous version's cache. */
const CACHE_NAME = "scanner-shell-v1";

const isScannerAssetPath = (pathname: string): boolean =>
  pathname === SCANNER_JS_PATH;

/** The two camera pages the shell reloads offline: one listing's door and a
 * group's door. */
const isScannerPagePath = (pathname: string): boolean =>
  /^\/admin\/(?:listing\/\d+|groups\/\d+)\/scanner$/.test(pathname);

/** The shell's own cache, under this version's name. */
const openShellCache = (): Promise<Cache> => caches.open(CACHE_NAME);

/** Keep one fetched copy in the shell's cache, by request or URL. */
const saveShellCopy = async (
  request: Request | string,
  res: Response,
): Promise<void> => {
  const cache = await openShellCache();
  await cache.put(request, res.clone());
};

/** Save the scanner bundle at install, so the very first offline reload
 * already has it. */
export const cacheShell = async (): Promise<void> => {
  await saveShellCopy(SCANNER_JS_PATH, await fetch(SCANNER_JS_PATH));
};

export const handleInstall = (event: ExtendableEventLike): void => {
  event.waitUntil(cacheShell());
};

/** Drop every cache this version did not write. */
export const dropOldCaches = async (): Promise<void> => {
  const names = await caches.keys();
  await Promise.all(
    names
      .filter((name) => name !== CACHE_NAME)
      .map((name) => caches.delete(name)),
  );
};

export const handleActivate = (event: ExtendableEventLike): void => {
  event.waitUntil(dropOldCaches());
};

/** The worker events this shell reads, declared here so the module needs no
 * worker library. */
export interface ExtendableEventLike {
  waitUntil: (promise: Promise<void>) => void;
}

export interface FetchEventLike extends ExtendableEventLike {
  request: Request;
  respondWith: (response: Promise<Response> | Response) => void;
}

/** The saved copy of one request, when the shell holds one. */
const savedShellCopy = (request: Request): Promise<Response | undefined> =>
  caches.match(request);

/** Fetch the request the normal way and keep a copy in the shell. */
const fetchAndSave = async (request: Request): Promise<Response> => {
  const res = await fetch(request);
  await saveShellCopy(request, res);
  return res;
};

/** Network first, saved copy second. Online, the door always gets the
 * fresh page and a fresh saved copy. Offline, the last saved copy
 * answers. */
export const scannerPageResponse = async (
  request: Request,
): Promise<Response> => {
  try {
    return await fetchAndSave(request);
  } catch (error) {
    const saved = await savedShellCopy(request);
    if (saved) return saved;
    throw error;
  }
};

/** The saved bundle first, the network second. The bundle only changes
 * with a new build, so a saved copy is as good as a fresh one. */
export const scannerAssetResponse = async (
  request: Request,
): Promise<Response> => {
  const saved = await savedShellCopy(request);
  if (saved) return saved;
  return fetchAndSave(request);
};

export const handleFetch = (event: FetchEventLike): void => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (isScannerAssetPath(url.pathname)) {
    event.respondWith(scannerAssetResponse(event.request));
    return;
  }
  // A GET to a scanner page's own URL is the offline reload. A script-side
  // GET of the same URL gets the same network-first treatment. That costs
  // nothing and keeps the saved copy fresh.
  if (isScannerPagePath(url.pathname)) {
    event.respondWith(scannerPageResponse(event.request));
  }
};

/** The worker scope's addEventListener, narrowed to the three events this
 * shell answers. Where there is no worker (tests, plain tabs) the same
 * calls just register listeners nothing fires. */
const worker = self as unknown as {
  addEventListener: ((
    type: "install" | "activate",
    handler: (event: ExtendableEventLike) => void,
  ) => void) &
    ((type: "fetch", handler: (event: FetchEventLike) => void) => void);
};

worker.addEventListener("install", handleInstall);
worker.addEventListener("activate", handleActivate);
worker.addEventListener("fetch", handleFetch);
