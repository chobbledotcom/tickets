/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
// test-groups: run-alone — the bundle runs inside happy-dom, whose internal
// task timers can outlive `happyDOM.abort()` under load; in a shared isolate a
// trailing timer fires during whichever suite runs next and fails its op
// sanitizer. Solo, it dies with the isolate — the proven-safe historical mode.

/**
 * The queue panel and the sync's guards: when the panel shows, what its
 * count says, how a rebuild leaves the rows, and when a sync sends nothing
 * or runs again. Every test drives the real built bundle, so the words
 * asserted are the words the door reads.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { drain, withEmptyCache } from "#test/ui/client/scanner/camera-fakes.ts";
import {
  fullStore,
  queuedItem,
  type ScannerHarness,
  storedQueue,
  useScannerSuite,
  whenTextShows,
} from "#test/ui/client/scanner/fixture.ts";
import {
  elementOf,
  firstRow,
  postedDeliveryHashes,
  queuedItems,
  queueSeeded,
  queueSummary,
  rowWords,
  setConnection,
  settledCheckIn,
} from "#test/ui/client/scanner/offline-door.ts";
import { stubFetch } from "#test-utils/fetch-stub.ts";

const QUEUED_WORDS = "Waiting — will be checked in when online";
const SAVE_FAILED =
  "This device could not save the queued check-ins. Free up space, then reload this page.";
const EIGHT_DAYS_MS = 8 * 24 * 60 * 60 * 1000;

describe("scanner offline queue panel", {
  sanitizeOps: false,
  sanitizeResources: false,
}, () => {
  const fresh = useScannerSuite();

  const panel = elementOf("scanner-queue");
  const rowCount = (h: ScannerHarness): number =>
    elementOf("scanner-queue-items")(h).children.length;

  /** A door that never answers, so the queue stays as the page drew it. */
  const silentDoor = () => stubFetch(() => new Promise(() => {}));

  /** A check-in queued long enough ago that the door's replay record is gone. */
  const staleItem = (suffix: string) => ({
    ...queuedItem,
    operationId: `018f3c2e-1b7d-7f31-9d4a-2f5c8e6a9b${suffix}`,
    queuedAt: Date.now() - EIGHT_DAYS_MS,
  });

  test("hides the panel while nothing is queued", () => {
    using _fetch = silentDoor();
    const h = fresh();

    expect(queueSummary(h)).toBe("0 queued check-ins");
    expect(panel(h).className).toContain("hidden");
  });

  test("shows the panel, the count, and the running words while a check-in waits", () => {
    using _fetch = silentDoor();
    const h = fresh(queueSeeded());

    expect(queueSummary(h)).toBe("1 queued check-in");
    expect(panel(h).className).not.toContain("hidden");
    expect(h.statusEl.textContent).toBe("Checking in queued tickets...");
    expect(h.statusEl.className).toContain("scanner-status-success");
  });

  test("counts each waiting check-in and shows every row waiting", async () => {
    using _fetch = silentDoor();
    const seed = await queuedItems(["tok1", "tok2"]);
    const h = fresh({ seed: (store) => store.setItem("scanner-queue", seed) });

    expect(queueSummary(h)).toBe("2 queued check-ins");
    expect(rowWords(h)).toEqual([QUEUED_WORDS, QUEUED_WORDS]);
  });

  test("keeps the panel on the page after the queue settles", async () => {
    using _fetch = stubFetch(withEmptyCache(settledCheckIn));
    const h = fresh(queueSeeded());

    await whenTextShows(h.statusEl, "Queued tickets are done.");

    expect(queueSummary(h)).toBe("0 queued check-ins");
    expect(panel(h).className).not.toContain("hidden");
    expect(firstRow(h).className).toBe("");
  });

  test("rebuilds the rows without doubling them when the connection flips", async () => {
    using _fetch = silentDoor();
    const seed = await queuedItems(["tok1", "tok2"]);
    const h = fresh({
      onLine: false,
      seed: (store) => store.setItem("scanner-queue", seed),
    });
    expect(rowCount(h)).toBe(2);

    h.window.dispatchEvent(new h.window.Event("offline"));

    expect(rowCount(h)).toBe(2);
    expect(queueSummary(h)).toBe("2 queued check-ins");
  });

  test("sends nothing while the device has no connection", () => {
    using fetchStub = stubFetch(withEmptyCache(settledCheckIn));
    const h = fresh({ onLine: false, ...queueSeeded() });

    expect(postedDeliveryHashes(fetchStub)).toEqual([]);
    expect(storedQueue(h)).toBe(JSON.stringify([queuedItem]));
    expect(h.statusEl.textContent).not.toBe("Checking in queued tickets...");
  });

  test("retires a check-in past the replay window and shows the count at zero", () => {
    using fetchStub = stubFetch(withEmptyCache(settledCheckIn));
    const h = fresh({
      seed: (store) =>
        store.setItem("scanner-queue", JSON.stringify([staleItem("c0")])),
    });

    expect(rowWords(h)).toEqual([
      "This queued check-in is too old to send. Scan the ticket again while you are online.",
    ]);
    expect(firstRow(h).className).toBe("");
    expect(queueSummary(h)).toBe("0 queued check-ins");
    expect(storedQueue(h)).toBe("[]");
    expect(postedDeliveryHashes(fetchStub)).toEqual([]);
  });

  test("stops at a retired check-in the store will not let go", () => {
    using _fetch = silentDoor();
    const queue = JSON.stringify([staleItem("c1"), staleItem("c2")]);
    const h = fresh({
      onLine: false,
      seed: (store) => store.setItem("scanner-queue", queue),
    });
    fullStore(h);

    setConnection(h, true);

    // The first retirement cannot save, so the sync stops there and its
    // error stays up instead of the still-queued warning.
    expect(h.statusEl.textContent).toBe(SAVE_FAILED);
    expect(h.statusEl.className).toContain("scanner-status-error");
    expect(storedQueue(h)).toBe(queue);
  });

  test("sends one check-in once when the door does not answer", async () => {
    using fetchStub = stubFetch(
      withEmptyCache(() => {
        throw new Error("offline");
      }),
    );
    const h = fresh(queueSeeded());

    await whenTextShows(
      h.statusEl,
      "Some tickets are still queued. The page will try to check them in again.",
    );
    await drain();

    expect(postedDeliveryHashes(fetchStub)).toHaveLength(1);
    expect(storedQueue(h)).toBe(JSON.stringify([queuedItem]));
  });

  test("runs again once, and only once, for a connection that returns mid-sync", async () => {
    const dropped = Promise.withResolvers<Response>();
    let posts = 0;
    using _fetch = stubFetch(
      withEmptyCache(() => {
        posts += 1;
        if (posts === 1) return dropped.promise;
        if (posts === 2) throw new Error("still down");
        // A third send means the ask was never cleared: hold it here.
        return new Promise<Response>(() => {});
      }),
    );
    const h = fresh(queueSeeded());
    setConnection(h, false);
    setConnection(h, true);

    dropped.reject(new Error("connection dropped"));
    await drain();

    expect(posts).toBe(2);
    expect(storedQueue(h)).toBe(JSON.stringify([queuedItem]));
  });
});
