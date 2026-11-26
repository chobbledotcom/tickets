/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
// test-groups: run-alone — the bundle runs inside happy-dom, whose internal
// task timers can outlive `happyDOM.abort()` under load; in a shared isolate a
// trailing timer fires during whichever suite runs next and fails its op
// sanitizer. Solo, it dies with the isolate — the proven-safe historical mode.

/**
 * What the offline door keeps in the page's store: the ticket list and how
 * long it stays valid, the list the page load fetches, the switch's mode, and
 * the queue's shape. Every test drives the real built bundle, so the words
 * asserted are the words the door reads.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  cameraFakes,
  drain,
  postedScanBodies,
  scanFirst,
  seedTicketCache,
  start,
  whenStatusShows,
  withEmptyCache,
} from "#test/ui/client/scanner/camera-fakes.ts";
import {
  MODE_KEY,
  queuedItem,
  SCAN_PATH,
  type ScannerHarness,
  storedQueue,
  TOKEN,
  useScannerSuite,
  whenTextShows,
} from "#test/ui/client/scanner/fixture.ts";
import {
  askedUrls,
  digestOf,
  postedDeliveryHashes,
  queuedItems,
  refusingDoor,
  settledCheckIn,
} from "#test/ui/client/scanner/offline-door.ts";
import { stubFetch } from "#test-utils/fetch-stub.ts";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const LIST_KEY = `scanner-tickets-${SCAN_PATH}`;
const QUEUED_WORDS =
  "Ticket looks valid. It will be checked in when you are back online.";
const EXPIRED_WORDS =
  "The offline ticket list has expired. Go online and reload this page.";

describe("scanner offline store", {
  sanitizeOps: false,
  sanitizeResources: false,
}, () => {
  const fresh = useScannerSuite();

  /** One offline scan against a list stored `ageMs` before the scan reads the
   * clock. The camera fakes move the clock one second at the scan, so the
   * list is stamped from the time that second will bring. */
  const scanListStoredAgo = async (ageMs: number): Promise<ScannerHarness> => {
    const h = fresh({ onLine: false });
    using fakes = cameraFakes(h);
    fakes.ready(4);
    await start(h);
    await seedTicketCache(h, TOKEN, Date.now() + 1000 - ageMs);
    await scanFirst(fakes, TOKEN);
    return h;
  };

  const listAges: readonly [string, number, string][] = [
    ["takes a list stored at the very moment of the scan", 0, QUEUED_WORDS],
    [
      "takes a list stored just inside twelve hours ago",
      12 * HOUR_MS - 1000,
      QUEUED_WORDS,
    ],
    ["refuses a list stored thirteen hours ago", 13 * HOUR_MS, EXPIRED_WORDS],
    ["refuses a list stamped after the scan", -HOUR_MS, EXPIRED_WORDS],
  ];
  for (const [name, ageMs, words] of listAges) {
    test(name, async () => {
      using _fetch = refusingDoor();
      const h = await scanListStoredAgo(ageMs);
      await whenStatusShows(h.statusEl, words);
      expect(h.statusEl.textContent).toBe(words);
    });
  }

  const badLists: readonly [string, () => Response][] = [
    ["refused the fetch", () => Response.json({}, { status: 500 })],
    [
      "sent a bad one",
      () =>
        Response.json({
          entries: [
            { details: [], hash: "digest-one", name: "Ada", quantity: 0 },
          ],
          next: null,
          people: 1,
          total: 1,
        }),
    ],
  ];
  for (const [what, answer] of badLists) {
    test(`keeps no list from a door that ${what}`, async () => {
      using fetchStub = stubFetch(answer);
      const h = fresh({ seed: (store) => store.setItem(MODE_KEY, "1") });
      await whenStatusShows(
        h.statusEl,
        "Something went wrong. Reload this page, then try again.",
      );

      // The armed switch really asked for the door's list, and the refused
      // answer stored nothing.
      expect(askedUrls(fetchStub)).toEqual([
        SCAN_PATH.replace(/\/scan$/, "/scan-cache"),
      ]);
      expect(h.window.localStorage.getItem(LIST_KEY)).toBeNull();
    });
  }

  test("registers the scanner's own service worker", async () => {
    using _fetch = refusingDoor();
    const registered: string[] = [];
    fresh({
      serviceWorker: {
        register: (path) => {
          registered.push(path);
          return Promise.resolve({});
        },
      },
    });

    expect(registered).toEqual(["/admin/scanner-sw.js"]);
  });

  test("settles each queued check-in on its own and empties the store", async () => {
    const seed = await queuedItems(["tok1", "tok2"]);
    const fetchStub = stubFetch(withEmptyCache(settledCheckIn));
    try {
      const h = fresh({
        seed: (store) => store.setItem("scanner-queue", seed),
      });

      await whenTextShows(h.statusEl, "Queued tickets are done.");

      expect(postedDeliveryHashes(fetchStub)).toEqual([
        await digestOf("tok1"),
        await digestOf("tok2"),
      ]);
      expect(storedQueue(h)).toBe("[]");
    } finally {
      fetchStub.restore();
    }
  });

  test("sends a check-in inside the replay window and retires one past it", async () => {
    const inside = {
      ...queuedItem,
      operationId: "018f3c2e-1b7d-7f31-9d4a-2f5c8e6a9b01",
      queuedAt: Date.now() - 6 * DAY_MS,
    };
    const past = {
      ...queuedItem,
      operationId: "018f3c2e-1b7d-7f31-9d4a-2f5c8e6a9b02",
      queuedAt: Date.now() - 8 * DAY_MS,
    };
    const fetchStub = stubFetch(withEmptyCache(settledCheckIn));
    try {
      fresh({
        seed: (store) =>
          store.setItem("scanner-queue", JSON.stringify([past, inside])),
      });
      await drain();

      expect(
        postedScanBodies(fetchStub).map((body) => body.operation_id),
      ).toEqual([inside.operationId]);
    } finally {
      fetchStub.restore();
    }
  });
});
