/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { lazyRef } from "#fp";
import type { TicketCacheEntry } from "#routes/admin/scan-cache.ts";
import { isRecord } from "#types";

/** One door's stored ticket list and the time this device stored it. */
export type TicketCache = { entries: TicketCacheEntry[]; storedAt: number };

/** One check-in that waits for a connection. */
export type QueuedCheckIn = {
  operationId: string;
  quantity: number;
  queuedAt: number;
  scanPath: string;
  tokenHash: string;
};

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

/** The guard for a stored list: every item passes `isItem`. */
const isListOf =
  <Item>(isItem: (item: unknown) => item is Item) =>
  (value: unknown): value is Item[] =>
    Array.isArray(value) && value.every(isItem);

/** Whether a value is one ticket digest, with the places one scan at its
 * door admits of the ticket's booking. */
const isTicketEntry = (entry: unknown): entry is TicketCacheEntry =>
  isRecord(entry) &&
  typeof entry.hash === "string" &&
  typeof entry.tickets === "number" &&
  Number.isInteger(entry.tickets) &&
  entry.tickets > 0;

const isCacheList = isListOf(isTicketEntry);

/** The stored list one door's page keeps, or null when none is stored. A
 * list we cannot parse is treated as absent and dropped. The page then
 * answers "no offline list" instead of breaking, and the next online load
 * rebuilds it. */
export const readTicketCache = (scanPath: string): TicketCache | null => {
  const raw = localStorage.getItem(TICKETS_KEY_PREFIX + scanPath);
  if (raw === null) return null;
  try {
    const cache: unknown = JSON.parse(raw);
    if (
      !isRecord(cache) ||
      typeof cache.storedAt !== "number" ||
      !isCacheList(cache.entries)
    ) {
      throw new Error(`Stored ticket cache for ${scanPath} has a bad shape`);
    }
    return { entries: cache.entries, storedAt: cache.storedAt };
  } catch (error) {
    localStorage.removeItem(TICKETS_KEY_PREFIX + scanPath);
    throw error;
  }
};

/** Store one door's list, stamped with the time this device stored it. The
 * clock that judges the 12-hour validity is this device's own, so a server
 * clock a minute away cannot stretch or cut the window. */
export const storeTicketCache = (
  scanPath: string,
  entries: TicketCacheEntry[],
): void => {
  localStorage.setItem(
    TICKETS_KEY_PREFIX + scanPath,
    JSON.stringify({ entries, storedAt: Date.now() }),
  );
};

export const isCacheFresh = (cache: TicketCache): boolean => {
  // A device clock that moved back after the write must not stretch the
  // window: only an age inside it counts as fresh.
  const age = Date.now() - cache.storedAt;
  return age >= 0 && age < CACHE_TTL_MS;
};

/** Fetch one door's list from the scan-cache endpoint behind its scan
 * endpoint, and store it. Throws when the request or the body fails, so the
 * caller decides what an unusable cache means for it. */
export const refreshTicketCache = async (
  scanPath: string,
): Promise<TicketCache | null> => {
  const res = await fetch(scanPath.replace(/\/scan$/, "/scan-cache"));
  if (!res.ok) {
    throw new Error(`The ticket cache for ${scanPath} answered ${res.status}`);
  }
  const body: unknown = await res.json();
  if (!isRecord(body) || !isCacheList(body.entries)) {
    throw new Error(`The ticket cache for ${scanPath} has a bad shape`);
  }
  storeTicketCache(scanPath, body.entries);
  return readTicketCache(scanPath);
};

/** Register the scanner's service worker, which keeps the page's script and
 * stylesheet loadable without a connection. A browser without service
 * workers, or one that refuses registration, still scans: everything offline
 * needs lives in the page and in localStorage. */
export const registerScannerWorker = (): void => {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register(SCANNER_SW_PATH).catch(() => {
    // Registration failure is a degraded cache, not a broken scanner: the
    // documented behavior is to keep scanning without the offline page shell.
  });
};

/** The door switch's stored position. A store this page cannot read reads
 * as off, so the page boots and scans instead of stopping. */
export const readManualMode = (): boolean => {
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
export const writeManualMode = (on: boolean): boolean => {
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
export const offlineModeActive = (): boolean =>
  readManualMode() || !navigator.onLine;

/** Whether a value is one queued item. It names its door, its ticket
 * digest, its delivery id, the people its check-in admits, and the moment it
 * went in. */
const isQueuedCheckIn = (item: unknown): item is QueuedCheckIn =>
  isRecord(item) &&
  typeof item.operationId === "string" &&
  item.operationId !== "" &&
  typeof item.queuedAt === "number" &&
  typeof item.quantity === "number" &&
  Number.isInteger(item.quantity) &&
  item.quantity > 0 &&
  typeof item.scanPath === "string" &&
  typeof item.tokenHash === "string" &&
  item.tokenHash !== "";

const isStoredQueue = isListOf(isQueuedCheckIn);

/** The queued check-ins, oldest first. A store the page cannot open reads
 * as no queue. So does a queue an older or newer build left in another
 * shape. The door keeps scanning. The raw value stays stored: the next
 * successful write replaces it, and nothing deletes queued check-ins on
 * its own. */
export const readQueue = (): QueuedCheckIn[] => {
  let raw: string | null;
  try {
    raw = localStorage.getItem(QUEUE_KEY);
  } catch {
    // Site data is blocked for this page, so nothing is read or stored.
    return [];
  }
  if (raw === null) return [];
  try {
    const queue: unknown = JSON.parse(raw);
    if (isStoredQueue(queue)) return queue;
  } catch {
    // The unreadable value stands in the store until a write replaces it.
  }
  return [];
};

export const writeQueue = (queue: QueuedCheckIn[]): void =>
  localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));

/** Queue one scan's check-in under the door it scanned at. The item carries
 * the ticket's keyed digest (never the raw token), the delivery id this one
 * check-in answers by, and the people it admits. */
export const queueCheckIn = (
  scanPath: string,
  tokenHash: string,
  quantity: number,
): QueuedCheckIn => {
  const queue = readQueue();
  const item: QueuedCheckIn = {
    operationId: crypto.randomUUID(),
    quantity,
    queuedAt: Date.now(),
    scanPath,
    tokenHash,
  };
  writeQueue([...queue, item]);
  return item;
};

/** Whether two stored queue items are the same check-in. The rendered rows
 * hold parsed copies, so the match is on the stored fields, not the
 * reference. */
export const sameQueuedCheckIn = (
  one: QueuedCheckIn,
  two: QueuedCheckIn,
): boolean =>
  one.queuedAt === two.queuedAt &&
  one.scanPath === two.scanPath &&
  one.tokenHash === two.tokenHash;

/** Whether the stored queue still holds this item. A sync re-run walks the
 * rows an earlier run rendered. A row whose item that run settled left the
 * store, so the re-run must not replay its check-in. */
export const queueHolds = (item: QueuedCheckIn): boolean =>
  readQueue().some((queued) => sameQueuedCheckIn(queued, item));

/** Whether a queued check-in grew older than the door's replay window.
 * The window is how long the server keeps one delivery's replay record.
 * Past it the server cannot tell a resend from a first send. The page
 * must not send the check-in again: a resend admits twice. */
export const deliveryExpired = (
  item: QueuedCheckIn,
  replayWindowMs: number,
): boolean => Date.now() - item.queuedAt >= replayWindowMs;

/** Drop one settled item from the queue. */
export const dropFromQueue = (item: QueuedCheckIn): void =>
  writeQueue(readQueue().filter((queued) => !sameQueuedCheckIn(queued, item)));

/** Whether a sync is running. The camera loop holds its scans while the
 * queue settles, so one overlay asks one question at a time. */
export const [isSyncing, setSyncing] = lazyRef(() => false);
