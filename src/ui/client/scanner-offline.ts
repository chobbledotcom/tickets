/// <reference lib="dom" />
import * as v from "valibot";
import { parseJsonOrNull } from "#shared/read-json.ts";
import {
  type TicketCacheEntry,
  TicketCacheEntrySchema,
  TicketCachePageSchema,
} from "#shared/ticket-cache.ts";
import { integerAtLeast } from "#shared/validation/number.ts";
import { NonEmptyTextSchema } from "#shared/validation/string.ts";

/** How long a stored ticket-hash set stays valid. After this the set answers
 * nothing: an expired set admits tickets against stale check-in state. */
export const CACHE_TTL_MS = 12 * 60 * 60 * 1000;

const TICKETS_KEY_PREFIX = "scanner-tickets-";
const QUEUE_KEY = "scanner-queue";
const MODE_KEY_PREFIX = "scanner-offline-mode-";

/** The worker's own URL, same-origin under /admin/ so its scope covers the
 * scanner pages. It is not an asset-paths constant: the edge build rewrites
 * those onto the CDN origin, and a service worker cannot register across
 * origins. */
const SCANNER_SW_PATH = "/admin/scanner-sw.js";

/** The text stored under `key`. Null is the documented answer for a
 * missing value. It is also the answer for a store this page cannot open,
 * because site data is blocked. */
const readStoredOrNull = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    // Site data is blocked for this page.
    return null;
  }
};

/** The list one door's page stores, stamped with the time this device
 * stored it. */
const StoredListSchema = v.object({
  entries: v.array(TicketCacheEntrySchema),
  storedAt: v.number(),
});

export type StoredList = v.InferOutput<typeof StoredListSchema>;

/** The stored list one door's page keeps. Null is the documented answer
 * when none is stored. A list that does not parse is dropped and also
 * answers null. The page then says "no offline list" instead of breaking.
 * The next download rebuilds the list. */
export const readTicketCacheOrNull = (scanPath: string): StoredList | null => {
  const key = TICKETS_KEY_PREFIX + scanPath;
  const raw = readStoredOrNull(key);
  if (raw === null) return null;
  const parsed = v.safeParse(StoredListSchema, parseJsonOrNull(raw));
  if (parsed.success) return parsed.output;
  localStorage.removeItem(key);
  return null;
};

/** Store one door's list, stamped with the time this device stored it. The
 * clock that judges the 12-hour validity is this device's own, so a server
 * clock a minute away cannot stretch or cut the window. */
const storeTicketCache = (
  scanPath: string,
  entries: TicketCacheEntry[],
): void => {
  localStorage.setItem(
    TICKETS_KEY_PREFIX + scanPath,
    JSON.stringify({ entries, storedAt: Date.now() }),
  );
};

export const isCacheFresh = (cache: StoredList): boolean => {
  // A device clock that moved back after the write must not stretch the
  // window: only an age inside it counts as fresh.
  const age = Date.now() - cache.storedAt;
  return age >= 0 && age < CACHE_TTL_MS;
};

/** Delete one door's stored list. */
export const removeTicketCache = (scanPath: string): void =>
  localStorage.removeItem(TICKETS_KEY_PREFIX + scanPath);

/** Fetch one page of a door's list: the first page when `from` is null,
 * else the page that the signed cursor `from` names. The first page is the
 * request the server logs. Throws when the request or the body fails. */
const fetchCachePage = async (
  scanPath: string,
  from: string | null,
  signal: AbortSignal,
): Promise<v.InferOutput<typeof TicketCachePageSchema>> => {
  const base = scanPath.replace(/\/scan$/, "/scan-cache");
  const url = from === null ? base : `${base}?from=${encodeURIComponent(from)}`;
  const res = await fetch(url, { signal });
  if (!res.ok) {
    throw new Error(`The ticket cache for ${scanPath} answered ${res.status}`);
  }
  return v.parse(TicketCachePageSchema, await res.json());
};

/** Download one door's whole list page by page, and store it once the last
 * page arrives. `onProgress` hears how many people are read out of the
 * total after each page. A failed or stopped download stores nothing, so
 * any list the door already holds stands. */
export const downloadTicketCache = async (
  scanPath: string,
  onProgress: (done: number, total: number) => void,
  signal: AbortSignal,
): Promise<void> => {
  const entries: TicketCacheEntry[] = [];
  let from: string | null = null;
  let read = 0;
  do {
    const page = await fetchCachePage(scanPath, from, signal);
    entries.push(...page.entries);
    read += page.people;
    // People booked during the download can push the total past the
    // first page's count, so the shown count never passes the total.
    onProgress(Math.min(read, page.total), page.total);
    from = page.next;
  } while (from !== null);
  signal.throwIfAborted();
  storeTicketCache(scanPath, entries);
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

/** One door's switch position, stored per door so turning offline mode on
 * at one door does not arm a door with no list. A store this page cannot
 * read reads as off, so the page boots and scans instead of stopping. */
export const readManualMode = (scanPath: string): boolean =>
  readStoredOrNull(MODE_KEY_PREFIX + scanPath) === "1";

/** Store one door's switch position, and say whether the store took it. A
 * blocked or full store keeps the old position: the switch stays where it
 * was, and the caller tells the door why nothing changed. */
export const writeManualMode = (scanPath: string, on: boolean): boolean => {
  try {
    if (on) localStorage.setItem(MODE_KEY_PREFIX + scanPath, "1");
    else localStorage.removeItem(MODE_KEY_PREFIX + scanPath);
    return true;
  } catch {
    // Site data is blocked for this page, or the store is full: the same
    // refusal every other write in this module answers with a message.
    return false;
  }
};

/** Whether a scan at this door settles offline: its switch says so, or the
 * device has no connection. The stored cache decides later whether an
 * offline scan can be validated at all. */
export const offlineModeActive = (scanPath: string): boolean =>
  readManualMode(scanPath) || !navigator.onLine;

/** One queued check-in: its door, its ticket digest, its delivery id, the
 * people it admits, and the moment it went in. */
const QueuedCheckInSchema = v.object({
  operationId: NonEmptyTextSchema,
  quantity: integerAtLeast(1),
  queuedAt: v.number(),
  scanPath: v.string(),
  tokenHash: NonEmptyTextSchema,
});

export type QueuedCheckIn = v.InferOutput<typeof QueuedCheckInSchema>;

const StoredQueueSchema = v.array(QueuedCheckInSchema);

/** The queued check-ins, oldest first. A store the page cannot open reads
 * as no queue. So does a queue an older or newer build left in another
 * shape. The door keeps scanning. The raw value stays stored: the next
 * successful write replaces it, and nothing deletes queued check-ins on
 * its own. */
export const readQueue = (): QueuedCheckIn[] => {
  const raw = readStoredOrNull(QUEUE_KEY);
  if (raw === null) return [];
  const parsed = v.safeParse(StoredQueueSchema, parseJsonOrNull(raw));
  return parsed.success ? parsed.output : [];
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
  const item = {
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
const sync = { running: false };

export const isSyncing = (): boolean => sync.running;

export const setSyncing = (value: boolean): void => {
  sync.running = value;
};
