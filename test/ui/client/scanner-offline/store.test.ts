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
  el,
  queuedItem,
  SCAN_PATH,
  type ScannerHarness,
  storedQueue,
  TOKEN,
  useScannerSuite,
  whenTextShows,
} from "#test/ui/client/scanner/fixture.ts";
import {
  digestOf,
  expectSwitchRefused,
  postedDeliveryHashes,
  queuedItems,
  settledCheckIn,
} from "#test/ui/client/scanner/offline-door.ts";
import { stubFetch } from "#test-utils/fetch-stub.ts";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const CACHE_PATH = SCAN_PATH.replace(/\/scan$/, "/scan-cache");
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

  const summary = (h: ScannerHarness): string | null =>
    el(h.document, "scanner-queue-summary").textContent;

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

  test("takes a list stored at the very moment of the scan", async () => {
    using _fetch = stubFetch(() => Response.json({}, { status: 500 }));
    const h = await scanListStoredAgo(0);
    await whenStatusShows(h.statusEl, QUEUED_WORDS);
  });

  test("takes a list stored just inside twelve hours ago", async () => {
    using _fetch = stubFetch(() => Response.json({}, { status: 500 }));
    const h = await scanListStoredAgo(12 * HOUR_MS - 1000);
    await whenStatusShows(h.statusEl, QUEUED_WORDS);
  });

  test("refuses a list stored thirteen hours ago", async () => {
    using _fetch = stubFetch(() => Response.json({}, { status: 500 }));
    const h = await scanListStoredAgo(13 * HOUR_MS);
    await whenStatusShows(h.statusEl, EXPIRED_WORDS);
  });

  test("refuses a list stamped after the scan", async () => {
    using _fetch = stubFetch(() => Response.json({}, { status: 500 }));
    const h = await scanListStoredAgo(-HOUR_MS);
    await whenStatusShows(h.statusEl, EXPIRED_WORDS);
  });

  test("drops a stored list it cannot read", async () => {
    using _fetch = stubFetch(() => Response.json({}, { status: 500 }));
    const h = fresh({
      onLine: false,
      seed: (store) => store.setItem(LIST_KEY, "not a list"),
    });
    using fakes = cameraFakes(h);
    fakes.ready(4);
    await start(h);
    await scanFirst(fakes, TOKEN);

    await whenStatusShows(
      h.statusEl,
      "No offline ticket list yet. Go online and reload this page first.",
    );
    expect(h.window.localStorage.getItem(LIST_KEY)).toBeNull();
  });

  test("stores the list the page load fetches, stamped with this device's clock", async () => {
    const entries = [{ hash: "digest-one", tickets: 2 }];
    using _fetch = stubFetch((url) =>
      String(url) === CACHE_PATH
        ? Response.json({ entries })
        : Response.json({}, { status: 500 }),
    );
    const h = fresh();
    await drain();

    const stored = JSON.parse(
      h.window.localStorage.getItem(LIST_KEY) ?? "null",
    );
    expect(stored.entries).toEqual(entries);
    expect(typeof stored.storedAt).toBe("number");
  });

  test("keeps no list from a door that refused the fetch", async () => {
    using _fetch = stubFetch(() =>
      Response.json(
        { entries: [{ hash: "digest-one", tickets: 2 }] },
        {
          status: 500,
        },
      ),
    );
    const h = fresh();
    await drain();

    expect(h.window.localStorage.getItem(LIST_KEY)).toBeNull();
  });

  test("keeps no list from a door that sent a bad one", async () => {
    using _fetch = stubFetch(() =>
      Response.json({ entries: [{ hash: "digest-one", tickets: 0 }] }),
    );
    const h = fresh();
    await drain();

    expect(h.window.localStorage.getItem(LIST_KEY)).toBeNull();
  });

  test("registers the scanner's own service worker", async () => {
    using _fetch = stubFetch(() => Response.json({}, { status: 500 }));
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

  test("reads a stored mode back as the switch's position", () => {
    using _fetch = stubFetch(() => Response.json({}, { status: 500 }));
    const h = fresh({
      onLine: false,
      seed: (store) => store.setItem("scanner-offline-mode", "1"),
    });

    expect(
      el(h.document, "scanner-offline-toggle").getAttribute("aria-pressed"),
    ).toBe("true");
  });

  test("stores the mode the door turns on and clears it when the door turns it off", () => {
    using _fetch = stubFetch(() => Response.json({}, { status: 500 }));
    const h = fresh({ onLine: false });
    const toggle = el(h.document, "scanner-offline-toggle");

    toggle.click();
    expect(h.window.localStorage.getItem("scanner-offline-mode")).toBe("1");
    expect(h.statusEl.className).not.toContain("scanner-status-error");

    toggle.click();
    expect(h.window.localStorage.getItem("scanner-offline-mode")).toBeNull();
  });

  test("keeps the switch on and says so when the store refuses the change", async () => {
    using _fetch = stubFetch(new Error("offline"));
    await expectSwitchRefused(
      fresh({
        onLine: false,
        seed: (store) => store.setItem("scanner-offline-mode", "1"),
      }),
    );
  });

  test("ignores a queued item that names no delivery", () => {
    using _fetch = stubFetch(() => Response.json({}, { status: 500 }));
    const queue = JSON.stringify([{ ...queuedItem, operationId: "" }]);
    const h = fresh({
      onLine: false,
      seed: (store) => store.setItem("scanner-queue", queue),
    });

    expect(summary(h)).toBe("0 queued check-ins");
    expect(storedQueue(h)).toBe(queue);
  });

  test("ignores a queued item that names no ticket digest", () => {
    using _fetch = stubFetch(() => Response.json({}, { status: 500 }));
    const queue = JSON.stringify([{ ...queuedItem, tokenHash: "" }]);
    const h = fresh({
      onLine: false,
      seed: (store) => store.setItem("scanner-queue", queue),
    });

    expect(summary(h)).toBe("0 queued check-ins");
    expect(storedQueue(h)).toBe(queue);
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
