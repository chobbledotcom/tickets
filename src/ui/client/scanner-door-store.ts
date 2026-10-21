/**
 * The scanner door's offline store: the saved ticket digests, the queue of
 * check-ins waiting to send, and the on/off switch's stored state.
 *
 * The device stores digests only. It never stores a ticket token or a guest
 * detail. The saved list answers scans for 12 hours, then deletes itself.
 *
 * These are rules over a key-value store, so tests drive them with a fake
 * store. The page wiring lands in the next layer (docs/scanner-offline.md).
 */

import { mapNotNullish, unique } from "#fp";

/** The storage the offline rules read and write. localStorage-shaped, so a
 * test can hand the rules a Map-backed fake. */
export type KeyValueStore = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
  /** The number of stored keys, and the key at one index, as localStorage
   * names them. The queue reads its entries through this list. */
  readonly length: number;
  key: (index: number) => string | null;
};

/** One door a scanner page works: a single listing, or a whole group. */
export type DoorScope =
  | { kind: "listing"; id: number }
  | { kind: "group"; id: number };

/** Read the door out of the page's token-list URL. A wrong-shaped path is a
 * broken page, so the caller throws rather than half-wire offline mode. */
export const scopeFromTokensPath = (path: string): DoorScope => {
  const match = path.match(/^\/admin\/(listing|groups)\/(\d+)\/scan-tokens$/);
  if (!match) throw new Error(`No door scope in token path: ${path}`);
  return match[1] === "listing"
    ? { id: Number(match[2]), kind: "listing" }
    : { id: Number(match[2]), kind: "group" };
};

/** The three storage slots one door's offline mode uses, named once so the
 * readers and writers can never drift apart. The queue is a prefix, not one
 * slot: each queued check-in writes its own key under it. */
const storageKeys = (
  scope: DoorScope,
): {
  hashes: string;
  mode: string;
  queuePrefix: string;
} => ({
  hashes: `scanner:hashes:${scope.kind}-${scope.id}`,
  mode: `scanner:offline:${scope.kind}-${scope.id}`,
  queuePrefix: `scanner:queue:${scope.kind}-${scope.id}:`,
});

/** How long a saved list answers scans. The user set 12 hours. An event
 * runs well inside it. A device that sleeps for a day must not answer
 * scans from a stale list. */
const CACHE_VALID_FOR_MS = 12 * 60 * 60 * 1000;

/** Replace the door's saved digest list with the list the server just sent.
 * The list saves with the moment it arrived, so its 12 hours start here. */
export const saveHashList = (
  store: KeyValueStore,
  scope: DoorScope,
  hashes: readonly string[],
  savedAt: number,
): void => {
  store.setItem(
    storageKeys(scope).hashes,
    JSON.stringify({ hashes: unique([...hashes]).sort(), savedAt }),
  );
};

/** The door's saved digests, for a scan to check against. The answer is null
 * when the door has no list, or when the list is past its 12 hours. An
 * expired list deletes itself, so the device keeps no digests past their
 * use. */
export const savedHashList = (
  store: KeyValueStore,
  scope: DoorScope,
  now: number,
): Set<string> | null => {
  const key = storageKeys(scope).hashes;
  const raw = store.getItem(key);
  if (raw === null) return null;
  let saved: { hashes?: unknown; savedAt?: unknown };
  try {
    const parsed: unknown = JSON.parse(raw);
    // A stored null parses, so it needs the same treatment as junk.
    if (typeof parsed !== "object" || parsed === null) {
      store.removeItem(key);
      return null;
    }
    saved = parsed as { hashes?: unknown; savedAt?: unknown };
  } catch {
    // A value another version wrote reads as absent here.
    store.removeItem(key);
    return null;
  }
  if (
    typeof saved.savedAt !== "number" ||
    !Array.isArray(saved.hashes) ||
    // A device clock that ran fast must not stretch the list's life.
    saved.savedAt > now ||
    now - saved.savedAt > CACHE_VALID_FOR_MS
  ) {
    store.removeItem(key);
    return null;
  }
  return new Set(
    saved.hashes.filter((entry): entry is string => typeof entry === "string"),
  );
};

/** One check-in waiting to send: the digest the scan read, the delivery id
 * the device minted for it, and the moment the device queued it. The replay
 * sends the same id, so the server answers one lost delivery once and
 * admits nothing twice. */
export type QueuedCheckIn = {
  tokenHash: string;
  operationId: string;
  queuedAt: number;
};

const isQueuedCheckIn = (entry: unknown): entry is QueuedCheckIn => {
  if (typeof entry !== "object" || entry === null) return false;
  const record = entry as Record<string, unknown>;
  return (
    typeof record.tokenHash === "string" &&
    typeof record.operationId === "string" &&
    typeof record.queuedAt === "number"
  );
};

/** One queued check-in read back out of its own slot. A damaged entry
 * deletes itself, as the saved list does: it holds no check-in the page
 * can send. */
const parseQueuedCheckIn = (
  store: KeyValueStore,
  key: string,
  raw: string | null,
): QueuedCheckIn | null => {
  try {
    // A value the store lists but does not hold parses as null, which is
    // never a queued check-in, so it deletes itself like junk.
    const parsed: unknown = JSON.parse(String(raw));
    if (isQueuedCheckIn(parsed)) return parsed;
  } catch {
    // Fall through to the removal below.
  }
  store.removeItem(key);
  return null;
};

/** The check-ins waiting to send, oldest first. The queue holds one storage
 * key per check-in, named after its delivery id — the device never held the
 * token itself. A queue write touches only its own key, so two page visits
 * over one device cannot erase each other's queued check-in. */
export const queuedCheckIns = (
  store: KeyValueStore,
  scope: DoorScope,
): QueuedCheckIn[] => {
  const prefix = storageKeys(scope).queuePrefix;
  const doorKeys = Array.from({ length: store.length }, (_, index) =>
    store.key(index),
  ).filter(
    (key): key is string => typeof key === "string" && key.startsWith(prefix),
  );
  return mapNotNullish((key: string) =>
    parseQueuedCheckIn(store, key, store.getItem(key)),
  )(doorKeys).sort((first, second) => first.queuedAt - second.queuedAt);
};

/** Add a check-in to the queue with a fresh delivery id. A digest already
 * queued keeps its id and stays single, so a double scan offline cannot
 * send one ticket twice. Answers false then. The new check-in writes its
 * own key, so it never rewrites another page visit's queued check-in. */
export const queueCheckIn = (
  store: KeyValueStore,
  scope: DoorScope,
  tokenHash: string,
  now: number,
): boolean => {
  if (
    queuedCheckIns(store, scope).some(
      (checkIn) => checkIn.tokenHash === tokenHash,
    )
  ) {
    return false;
  }
  const operationId = crypto.randomUUID();
  store.setItem(
    `${storageKeys(scope).queuePrefix}${operationId}`,
    JSON.stringify({ operationId, queuedAt: now, tokenHash }),
  );
  return true;
};

/** Take one check-in out of the queue. The door calls this only after the
 * server answered the scan for good. An unconfirmed request stays queued,
 * so a lost page or a failed send cannot drop a check-in. A drop removes
 * only the check-ins' own keys, so it never rewrites another page visit's
 * queue. */
export const dropQueuedCheckIn = (
  store: KeyValueStore,
  scope: DoorScope,
  tokenHash: string,
): void => {
  for (const checkIn of queuedCheckIns(store, scope)) {
    if (checkIn.tokenHash !== tokenHash) continue;
    store.removeItem(`${storageKeys(scope).queuePrefix}${checkIn.operationId}`);
  }
};

/** The manual switch's stored state. Absent means off. */
export const offlineModeOn = (
  store: KeyValueStore,
  scope: DoorScope,
): boolean => store.getItem(storageKeys(scope).mode) === "on";

/** Store the manual switch's state. Off removes the key, so the door's
 * storage carries no stale "on". */
export const setOfflineMode = (
  store: KeyValueStore,
  scope: DoorScope,
  on: boolean,
): void => {
  if (on) store.setItem(storageKeys(scope).mode, "on");
  else store.removeItem(storageKeys(scope).mode);
};
