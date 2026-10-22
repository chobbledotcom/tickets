// test-groups: run-alone — the bundle runs inside happy-dom, whose internal
// task timers can outlive `happyDOM.abort()` under load; in a shared isolate
// a trailing timer fires during whichever suite runs next and fails its op
// sanitizer. Solo, it dies with the isolate — the proven-safe historical
// mode.

/**
 * The offline suites' shared wiring: one door's storage keys, the server
 * answers the stubbed fetch gives, and the page steps every offline test
 * walks. The suites drive the built bundle; `fixture.ts` builds the pages.
 */

import { expect } from "@std/expect";
import { deriveDoorCacheKey } from "#crypto/hashing.ts";
import { hmacHex } from "#crypto/sha256.ts";
import {
  type QueuedCheckIn,
  queuedCheckIns,
} from "#src/ui/client/scanner-door-store.ts";
import { type FetchReply, stubFetch } from "#test-utils/fetch-stub.ts";
import { type ScannerHarness, whenTextShows } from "./fixture.ts";

export const HASHES_KEY = "scanner:hashes:group-5";
export const MODE_KEY = "scanner:offline:group-5";

/** The digest the device stores for one token: the keyed digest the door's
 * cache key makes, the same construction the token list endpoint and the
 * page's own scan digest use. The key digests under the same door the
 * fixture page's `data-door-cache-key` names. */
export const digestOf = (token: string): Promise<string> =>
  hmacHex(deriveDoorCacheKey("group:5"), token);

/** The door's scope the fixtures wire: group 5, as the tokens path names
 * it. */
const SCOPE = { id: 5, kind: "group" } as const;

/** The door's queued deliveries, read the way the page reads them:
 * through the store's own reader. */
export const readQueue = (): QueuedCheckIn[] =>
  queuedCheckIns(localStorage, SCOPE);

/** Drain the promise hops the stubbed fetch and its render chain need —
 * the same bound-drain idiom `whenTextShows` uses, with no clock. */
export const settle = async (): Promise<void> => {
  for (let hops = 0; hops < 100; hops++) {
    await Promise.resolve();
  }
};

/** The reply the door's token list endpoint gives, digests only. */
export const hashesReply = async (...tokens: string[]): Promise<Response> =>
  Response.json({
    hashes: (await Promise.all(tokens.map(digestOf))).sort(),
  });

/** A queued check-in's replay answer that checks the person in. */
export const checkedInReply = (): Response =>
  Response.json({
    listingName: "Doors",
    name: "Ada",
    quantity: 1,
    status: "checked_in",
    total: 1,
  });

/** A queued check-in's replay answer that says another door already took
 * that person in. */
export const duplicateReply = (name: string): Response =>
  Response.json({
    listingName: "Doors",
    name,
    quantity: 1,
    status: "already_checked_in",
    total: 1,
  });

export const dispatchScan = (h: ScannerHarness, token: string): Promise<void> =>
  h.module.dispatchScan(
    h.module.offline!,
    "/admin/groups/5/scan",
    token,
    "csrf",
    h.statusEl,
    h.messages,
  );

/** One fresh door page, settled after its saved list loads. */
export const settledDoor = async (
  fresh: () => ScannerHarness,
): Promise<ScannerHarness> => {
  const h = fresh();
  await settle();
  return h;
};

/** Turn the switch on and queue one saved ticket against the door's
 * list. */
export const queueSavedTicket = async (
  h: ScannerHarness,
  token: string,
): Promise<void> => {
  h.offline.toggle.click();
  await dispatchScan(h, token);
};

/** Queue one saved ticket and let its first replay fail to settle: the
 * page says the send did not land, and the check-in the door queued comes
 * back for the test to read. */
export const queuedAndSendFailed = async (
  h: ScannerHarness,
): Promise<QueuedCheckIn[]> => {
  await queueSavedTicket(h, "AAAA");
  h.offline.toggle.click();
  await whenTextShows(
    h.statusEl,
    "Some check-ins did not send. They stay saved on this device.",
  );
  const queued = readQueue();
  expect(queued.map((delivery) => delivery.tokenHash)).toEqual([
    await digestOf("AAAA"),
  ]);
  return queued;
};

/** One door page reloaded where the saved list cannot refresh: no list
 * arrived, so the connection stays unproven and the queue waits quiet. */
export const quietReload = async (
  fresh: () => ScannerHarness,
  reply: FetchReply,
): Promise<ScannerHarness> => {
  using _reload = stubFetch(reply);
  const second = fresh();
  await settle();
  expect(second.statusEl.textContent).toBe("");
  expect(second.offline.queueLine.textContent).toBe(
    "1 check-in waiting to send.",
  );
  return second;
};

/** One door page whose queued check-in could not send: offline mode is
 * off, the send cannot land, and the check-in waits on the device. The
 * page runs inside its own fetch scope, so the caller's next stub owns
 * what the reload meets. */
export const pageWithWaitingCheckIn = async (
  fresh: () => ScannerHarness,
): Promise<void> => {
  {
    using _fetch = stubFetch(await hashesReply("AAAA"), new Error("offline"));
    const first = await settledDoor(fresh);
    // Offline mode is off: the door scans online first, and a send that
    // cannot land is accepted against the saved list and waits here.
    await dispatchScan(first, "AAAA");
    expect(first.offline.queueLine.textContent).toBe(
      "1 check-in waiting to send.",
    );
  }
};

/** Turn the switch on and queue two saved tickets against the door's
 * list. */
export const queueTwoSaved = async (h: ScannerHarness): Promise<void> => {
  h.offline.toggle.click();
  await dispatchScan(h, "AAAA");
  await dispatchScan(h, "BBBB");
};

/** Turn the switch off, let the sync run, and wait until the page tells
 * the door what happened to one queued check-in by name. */
export const syncAndWait = async (
  h: ScannerHarness,
  name: string,
): Promise<void> => {
  h.offline.toggle.click();
  await whenTextShows(h.statusEl, `${name} was already checked in elsewhere.`);
  await settle();
};

/** The door's saved list, once the refresh lands the expected digest in
 * storage: the refresh saves on its own hops, so the test waits for the
 * list instead of counting hops. */
export const whenListIs = async (digest: string): Promise<string> => {
  const savedHashes = (): string | null => localStorage.getItem(HASHES_KEY);
  for (let hop = 0; hop < 50; hop++) {
    await Promise.resolve();
    const saved = savedHashes();
    if (saved?.includes(digest)) {
      return saved;
    }
    await digestOf("warmup");
  }
  const finalSaved = savedHashes();
  return finalSaved ?? "";
};

/** A reply that records the scan body it was given, then answers a
 * check-in. */
export const recordedCheckIn =
  (posts: unknown[]) =>
  (_url: string, init?: RequestInit): Response => {
    posts.push(JSON.parse(String(init?.body)));
    return checkedInReply();
  };

/** A reply that records the scan body it was given, then loses the
 * answer: the request reached the server, the page never read what it
 * said. */
export const lostAfterSend =
  (posts: unknown[]) =>
  (_url: string, init?: RequestInit): Response => {
    posts.push(JSON.parse(String(init?.body)));
    throw new Error("answer lost");
  };
