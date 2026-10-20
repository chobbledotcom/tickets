/**
 * The scanner door's offline store: the saved ticket digests, the queue of
 * check-ins waiting to send, the on/off switch, and the replay run.
 *
 * The device stores digests only. It never stores a ticket token or a guest
 * detail. A read of the device's storage hands over nothing that opens a
 * door. The saved list answers scans for 12 hours. After that it deletes
 * itself, and the door goes online to load a fresh list.
 *
 * These are pure functions over a key-value store, so tests drive them with a
 * fake store. The browser wiring around them lives in scanner-offline.ts.
 */

import { unique } from "#fp";
import { storedArray } from "./stored-array.ts";

/** The storage the offline rules read and write. localStorage-shaped, so a
 * test can hand the rules a Map-backed fake. */
export type KeyValueStore = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
};

/** One door a scanner page works: a single listing, or a whole group. */
export type DoorScope =
  | { kind: "listing"; id: number }
  | { kind: "group"; id: number };

/** The page's message templates, as its data-message-* attributes carry
 * them. A page the template did not render whole can miss any of them. */
export type ScanMessages = Record<string, string | undefined>;

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
 * readers and writers can never drift apart. */
const storageKeys = (
  scope: DoorScope,
): {
  hashes: string;
  mode: string;
  queue: string;
} => ({
  hashes: `scanner:hashes:${scope.kind}-${scope.id}`,
  mode: `scanner:offline:${scope.kind}-${scope.id}`,
  queue: `scanner:queue:${scope.kind}-${scope.id}`,
});

/** How long a saved list answers scans. The user set 12 hours. An event
 * runs well inside it. A device that sleeps for a day must not answer
 * scans from a stale list. */
const CACHE_VALID_FOR_MS = 12 * 60 * 60 * 1000;

const parseStringArray = (raw: string | null): string[] => {
  try {
    return storedArray(
      raw,
      (entry): entry is string => typeof entry === "string",
    );
  } catch {
    // A value another version wrote reads as absent here. The next online
    // load replaces the list whole.
    return [];
  }
};

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
    saved = JSON.parse(raw) as { hashes?: unknown; savedAt?: unknown };
  } catch {
    // A value another version wrote reads as absent here.
    store.removeItem(key);
    return null;
  }
  if (
    typeof saved.savedAt !== "number" ||
    !Array.isArray(saved.hashes) ||
    now - saved.savedAt > CACHE_VALID_FOR_MS
  ) {
    store.removeItem(key);
    return null;
  }
  return new Set(
    saved.hashes.filter((entry): entry is string => typeof entry === "string"),
  );
};

/** The check-ins waiting to send, oldest first. The queue holds the digest
 * of each scanned token — the device never held the token itself. */
export const queuedCheckInHashes = (
  store: KeyValueStore,
  scope: DoorScope,
): string[] => parseStringArray(store.getItem(storageKeys(scope).queue));

/** Add a check-in to the queue. A digest already queued stays single, so a
 * double scan offline cannot send one ticket twice. Answers false then. */
export const queueCheckIn = (
  store: KeyValueStore,
  scope: DoorScope,
  tokenHash: string,
): boolean => {
  const queue = queuedCheckInHashes(store, scope);
  if (queue.includes(tokenHash)) return false;
  store.setItem(
    storageKeys(scope).queue,
    JSON.stringify([...queue, tokenHash]),
  );
  return true;
};

/** Take one check-in out of the queue. The door calls this only after the
 * server answered the scan for good. */
export const dropQueuedCheckIn = (
  store: KeyValueStore,
  scope: DoorScope,
  tokenHash: string,
): void => {
  const queue = queuedCheckInHashes(store, scope).filter(
    (entry) => entry !== tokenHash,
  );
  store.setItem(storageKeys(scope).queue, JSON.stringify(queue));
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

/** Fill the `{name}`-style holes in a message template. */
export const interpolate = (
  template: string,
  values: Record<string, string | number>,
): string =>
  template.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? ""));

/** The statuses the scan API speaks. Anything else (a login page, a bare
 * error object) is not a scan answer. A replay must not treat such a body
 * as one door answer and drop the check-in. */
const SCAN_ANSWER_STATUS: Record<string, true> = {
  already_checked_in: true,
  checked_in: true,
  error: true,
  not_found: true,
  refunded: true,
  select_quantity: true,
  verify_id: true,
  wrong_listing: true,
};

export type ScanAnswer = { status: string; [key: string]: unknown };

/** The scan POST a replay runs through. The body names the person by token
 * (a live scan) or by token digest (a replay). The door's choices ride
 * along. */
export type ScanPost = (
  scanPath: string,
  token: string,
  csrfToken: string,
  choices?: Record<string, unknown>,
) => Promise<ScanAnswer>;

/** One full live admission of one queued check-in: its digest, the replay's
 * post, and the replay's messages. The page owns the flow. The offline mode
 * owns what the post sends and what the messages say. */
export type AdmitOne = (
  tokenHash: string,
  post: ScanPost,
  messages: ScanMessages,
) => Promise<void>;

/** The scan answers a replay trusts: only the statuses the scan API really
 * speaks. Any other body means the check-in did not land, so the replay
 * stops and the token stays queued. */
export const strictScannerPost =
  (post: ScanPost): ScanPost =>
  async (...args) => {
    const answer = await post(...args);
    if (!(answer.status in SCAN_ANSWER_STATUS)) {
      throw new Error(`Not a scan answer: ${JSON.stringify(answer)}`);
    }
    return answer;
  };

/** Send every queued check-in, oldest first, through the page's live
 * admission flow, its asks included. One digest gets one turn. A check-in
 * leaves the queue only after its admission finished for good. The first
 * send that cannot reach the server stops the run, and the rest stay
 * queued. */
export const replayQueuedCheckIns = async (deps: {
  admitOne: AdmitOne;
  messages: ScanMessages;
  onQueueChange?: (waiting: number) => void;
  post: ScanPost;
  scope: DoorScope;
  store: KeyValueStore;
}): Promise<{ sent: number; waiting: number }> => {
  let sent = 0;
  for (const tokenHash of queuedCheckInHashes(deps.store, deps.scope)) {
    try {
      await deps.admitOne(tokenHash, deps.post, deps.messages);
    } catch {
      // The server was out of reach: the digest stays queued for the next
      // run, and nothing else sends this turn.
      break;
    }
    dropQueuedCheckIn(deps.store, deps.scope, tokenHash);
    sent += 1;
    deps.onQueueChange?.(queuedCheckInHashes(deps.store, deps.scope).length);
  }
  return { sent, waiting: queuedCheckInHashes(deps.store, deps.scope).length };
};

/** One replay at a time: a second trigger while one runs stands down, so
 * two queued sends can never race each other. Each page owns its own gate. */
export const replayGate = (): {
  replaying: () => boolean;
  run: (
    deps: Parameters<typeof replayQueuedCheckIns>[0],
  ) => Promise<{ sent: number; waiting: number } | null>;
} => {
  let running = false;
  return {
    replaying: () => running,
    run: async (deps) => {
      if (running) return null;
      running = true;
      try {
        return await replayQueuedCheckIns(deps);
      } finally {
        running = false;
      }
    },
  };
};
