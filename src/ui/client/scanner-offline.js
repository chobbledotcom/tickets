/** How long a stored ticket-hash set stays valid. After this the set answers
 * nothing: an expired set admits tickets against stale check-in state. */
export const CACHE_TTL_MS = 12 * 60 * 60 * 1000;

const TICKETS_KEY_PREFIX = "scanner-tickets-";
const QUEUE_KEY = "scanner-queue";
const MODE_KEY = "scanner-offline-mode";

/** The worker's own URL, same-origin under /admin/ so its scope covers the
 * scanner pages. It is not an asset-paths constant: the edge build rewrites
 * those onto the CDN origin, and a service worker cannot register across
 * origins. */
const SCANNER_SW_PATH = "/admin/scanner-sw.js";

/** Whether a value is a list of token digests, the only shape the cache
 * stores and the cache endpoint answers. */
const isHashList = (value) =>
  Array.isArray(value) && value.every((hash) => typeof hash === "string");

/** The stored hash set one door's page keeps, or null when none is stored.
 * A set we cannot parse is treated as absent and dropped. The page then
 * answers "no offline list" instead of breaking, and the next online load
 * rebuilds it. */
export const readTicketCache = (scanPath) => {
  const raw = localStorage.getItem(TICKETS_KEY_PREFIX + scanPath);
  if (raw === null) return null;
  try {
    const cache = JSON.parse(raw);
    if (typeof cache.storedAt !== "number" || !isHashList(cache.hashes)) {
      throw new Error(`Stored ticket cache for ${scanPath} has a bad shape`);
    }
    return cache;
  } catch (error) {
    localStorage.removeItem(TICKETS_KEY_PREFIX + scanPath);
    throw error;
  }
};

/** Store one door's hash set, stamped with the time this device stored it.
 * The clock that judges the 12-hour validity is this device's own, so a
 * server clock a minute away cannot stretch or cut the window. */
export const storeTicketCache = (scanPath, hashes) => {
  localStorage.setItem(
    TICKETS_KEY_PREFIX + scanPath,
    JSON.stringify({ hashes, storedAt: Date.now() }),
  );
};

export const isCacheFresh = (cache) => {
  // A device clock that moved back after the write must not stretch the
  // window: only an age inside it counts as fresh.
  const age = Date.now() - cache.storedAt;
  return age >= 0 && age < CACHE_TTL_MS;
};

/** Fetch one door's hash set from the scan-cache endpoint behind its scan
 * endpoint, and store it. Throws when the request or the body fails, so the
 * caller decides what an unusable cache means for it. */
export const refreshTicketCache = async (scanPath) => {
  const res = await fetch(scanPath.replace(/\/scan$/, "/scan-cache"));
  if (!res.ok) {
    throw new Error(`The ticket cache for ${scanPath} answered ${res.status}`);
  }
  const body = await res.json();
  if (!isHashList(body.hashes)) {
    throw new Error(`The ticket cache for ${scanPath} has a bad shape`);
  }
  storeTicketCache(scanPath, body.hashes);
  return readTicketCache(scanPath);
};

/** Register the scanner's service worker, which keeps the page's script and
 * stylesheet loadable without a connection. A browser without service
 * workers, or one that refuses registration, still scans: everything offline
 * needs lives in the page and in localStorage. */
export const registerScannerWorker = () => {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register(SCANNER_SW_PATH).catch(() => {
    // Registration failure is a degraded cache, not a broken scanner: the
    // documented behavior is to keep scanning without the offline page shell.
  });
};

/** The door switch's stored position. A store this page cannot read reads
 * as off, so the page boots and scans instead of stopping. */
export const readManualMode = () => {
  try {
    return localStorage.getItem(MODE_KEY) === "1";
  } catch {
    // Site data is blocked for this page, so nothing is read or stored.
    return false;
  }
};

/** Store the door switch's position, and say whether the store took it. A
 * blocked or full store keeps the old position: the switch stays where it
 * was, and the caller tells the door why nothing changed. */
export const writeManualMode = (on) => {
  try {
    if (on) localStorage.setItem(MODE_KEY, "1");
    else localStorage.removeItem(MODE_KEY);
    return true;
  } catch {
    // Site data is blocked for this page, or the store is full: the same
    // refusal every other write in this module answers with a message.
    return false;
  }
};

/** Whether a scan settles offline: the door switch says so, or the device
 * has no connection. The stored cache decides later whether an offline scan
 * can be validated at all. */
export const offlineModeActive = () => readManualMode() || !navigator.onLine;

/** Whether a value is the stored queue: a list where every item names its
 * door, its token, and the moment it was queued. */
const isStoredQueue = (value) =>
  Array.isArray(value) &&
  value.every(
    (item) =>
      typeof item.scanPath === "string" &&
      typeof item.token === "string" &&
      typeof item.queuedAt === "number",
  );

/** The queued check-ins, oldest first. A store the page cannot open reads
 * as no queue. So does a queue an older or newer build left in another
 * shape. The door keeps scanning. The raw value stays stored: the next
 * successful write replaces it, and nothing deletes queued check-ins on
 * its own. */
export const readQueue = () => {
  let raw;
  try {
    raw = localStorage.getItem(QUEUE_KEY);
  } catch {
    // Site data is blocked for this page, so nothing is read or stored.
    return [];
  }
  if (raw === null) return [];
  try {
    const queue = JSON.parse(raw);
    if (isStoredQueue(queue)) return queue;
  } catch {
    // The unreadable value stands in the store until a write replaces it.
  }
  return [];
};

export const writeQueue = (queue) =>
  localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));

/** Queue one scan's check-in under the door it scanned at. */
export const queueCheckIn = (scanPath, token) => {
  const queue = readQueue();
  const item = { queuedAt: Date.now(), scanPath, token };
  writeQueue([...queue, item]);
  return item;
};

/** Whether two stored queue items are the same check-in. The rendered rows
 * hold parsed copies, so the match is on the stored fields, not the
 * reference. */
export const sameQueuedCheckIn = (one, two) =>
  one.queuedAt === two.queuedAt &&
  one.scanPath === two.scanPath &&
  one.token === two.token;

/** Whether the stored queue still holds this item. A sync re-run walks the
 * rows an earlier run rendered. A row whose item that run settled left the
 * store, so the re-run must not replay its check-in. */
export const queueHolds = (item) =>
  readQueue().some((queued) => sameQueuedCheckIn(queued, item));

/** Drop one settled item from the queue. */
export const dropFromQueue = (item) =>
  writeQueue(readQueue().filter((queued) => !sameQueuedCheckIn(queued, item)));

/** Whether a sync is running. The camera loop holds its scans while the
 * queue settles, so one overlay asks one question at a time. */
let syncing = false;

export const isSyncing = () => syncing;

export const setSyncing = (value) => {
  syncing = value;
};
