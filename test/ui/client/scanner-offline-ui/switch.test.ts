/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
// test-groups: run-alone — the bundle runs inside happy-dom, whose internal
// task timers can outlive `happyDOM.abort()` under load; in a shared isolate a
// trailing timer fires during whichever suite runs next and fails its op
// sanitizer. Solo, it dies with the isolate — the proven-safe historical mode.

/**
 * The offline door's page furniture: the switch, the banner, the queue panel
 * the page wires, and what a returning or dropping connection does. Every
 * test drives the real built bundle, so the words asserted are the words the
 * door reads.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { drain, withEmptyCache } from "#test/ui/client/scanner/camera-fakes.ts";
import {
  el,
  queuedItem,
  SCAN_PATH,
  SCANNER_PAGE,
  type ScannerHarness,
  storedQueue,
  useScannerSuite,
  whenTextShows,
} from "#test/ui/client/scanner/fixture.ts";
import {
  askedUrls,
  expectCancelQueuesNothing,
  expectSwitchRefused,
  firstRow,
  postedDeliveryHashes,
  queueSeeded,
  scanOffline,
  settledCheckIn,
} from "#test/ui/client/scanner/offline-door.ts";
import { stubFetch } from "#test-utils/fetch-stub.ts";

const CACHE_PATH = SCAN_PATH.replace(/\/scan$/, "/scan-cache");
const MANUAL_WORDS =
  "Offline mode is on. Scans are queued and checked in when you are back online.";
const AUTO_WORDS =
  "No connection. Scans are queued and checked in when you are back online.";

describe("scanner offline switch and banner", {
  sanitizeOps: false,
  sanitizeResources: false,
}, () => {
  const fresh = useScannerSuite();
  const toggleOf = (h: ScannerHarness) =>
    el(h.document, "scanner-offline-toggle");
  const bannerOf = (h: ScannerHarness) =>
    el(h.document, "scanner-offline-banner");
  const bannerWords = (h: ScannerHarness): string | null =>
    el(h.document, "scanner-offline-banner-text").textContent;

  const flip = (h: ScannerHarness, onLine: boolean): void => {
    h.stash.set("navigator", { onLine });
    h.window.dispatchEvent(new h.window.Event(onLine ? "online" : "offline"));
  };

  test("settles the queue when the door turns offline mode off", async () => {
    using _fetch = stubFetch(settledCheckIn);
    const h = fresh({
      seed: (store) => store.setItem("scanner-offline-mode", "1"),
    });
    // The scan queued while the switch was on; the page load's sync ran
    // against an empty queue, so the switch's own disarm does the settling.
    h.window.localStorage.setItem(
      "scanner-queue",
      JSON.stringify([queuedItem]),
    );

    el(h.document, "scanner-offline-toggle").click();

    await whenTextShows(h.statusEl, "Queued tickets are done.");
    expect(storedQueue(h)).toBe("[]");
    expect(firstRow(h).textContent).toBe("Checked in");
    // The switch disarmed: the store holds no mode and the banner is gone.
    expect(h.window.localStorage.getItem("scanner-offline-mode")).toBe(null);
    expect(el(h.document, "scanner-offline-banner").className).toContain(
      "hidden",
    );
  });

  test("keeps the settled row on the page when the switch is clicked mid-sync", async () => {
    const { promise, resolve } = Promise.withResolvers<Response>();
    using _fetch = stubFetch((url) => {
      if (String(url).endsWith("-cache")) {
        return Response.json({ hashes: [] });
      }
      return promise;
    });
    const h = fresh(queueSeeded());

    // The sync is waiting on the door's answer. The switch's re-render must
    // leave the row elements the sync writes to on the page.
    el(h.document, "scanner-offline-toggle").click();
    resolve(
      Response.json({
        listingName: "Standard",
        name: "Ada",
        quantity: 1,
        status: "checked_in",
        total: 1,
      }),
    );

    await whenTextShows(h.statusEl, "Queued tickets are done.");
    expect(firstRow(h).textContent).toBe("Checked in");
    expect(storedQueue(h)).toBe("[]");
  });

  test("words the banner for the connection each time it flips, and hides it online", () => {
    using _fetch = stubFetch(() => Response.json({}, { status: 500 }));
    const h = fresh({ onLine: false });
    expect(bannerWords(h)).toBe(AUTO_WORDS);
    expect(bannerOf(h).className).not.toContain("hidden");

    flip(h, true);
    expect(bannerOf(h).className).toContain("hidden");

    flip(h, false);
    expect(bannerWords(h)).toBe(AUTO_WORDS);
    expect(bannerOf(h).className).not.toContain("hidden");
  });

  test("words the banner for the switch while the connection holds", () => {
    using _fetch = stubFetch(() => Response.json({}, { status: 500 }));
    const h = fresh({
      seed: (store) => store.setItem("scanner-offline-mode", "1"),
    });

    expect(bannerWords(h)).toBe(MANUAL_WORDS);
  });

  test("sends the queue when the connection returns", async () => {
    const fetchStub = stubFetch(withEmptyCache(settledCheckIn));
    try {
      const h = fresh({ onLine: false, ...queueSeeded() });
      expect(postedDeliveryHashes(fetchStub)).toEqual([]);

      flip(h, true);

      await whenTextShows(h.statusEl, "Queued tickets are done.");
      expect(postedDeliveryHashes(fetchStub)).toEqual([queuedItem.tokenHash]);
      expect(storedQueue(h)).toBe("[]");
    } finally {
      fetchStub.restore();
    }
  });

  test("sends the queue when the page loads online", async () => {
    const fetchStub = stubFetch(withEmptyCache(settledCheckIn));
    try {
      const h = fresh(queueSeeded());

      await whenTextShows(h.statusEl, "Queued tickets are done.");
      expect(postedDeliveryHashes(fetchStub)).toEqual([queuedItem.tokenHash]);
    } finally {
      fetchStub.restore();
    }
  });

  test("asks for a fresh list when the door arms the switch online", () => {
    const fetchStub = stubFetch(() => Response.json({}, { status: 500 }));
    try {
      const h = fresh();
      const before = askedUrls(fetchStub).length;

      toggleOf(h).click();

      expect(askedUrls(fetchStub).slice(before)).toEqual([CACHE_PATH]);
    } finally {
      fetchStub.restore();
    }
  });

  test("asks for no list when the door arms the switch with no connection", () => {
    const fetchStub = stubFetch(() => Response.json({}, { status: 500 }));
    try {
      const h = fresh({ onLine: false });
      const before = askedUrls(fetchStub).length;

      toggleOf(h).click();

      expect(askedUrls(fetchStub).slice(before)).toEqual([]);
    } finally {
      fetchStub.restore();
    }
  });

  test("holds the queue while the door arms the switch", async () => {
    const fetchStub = stubFetch(withEmptyCache(settledCheckIn));
    try {
      const h = fresh({ onLine: false, ...queueSeeded() });
      h.stash.set("navigator", { onLine: true });

      toggleOf(h).click();
      await drain();

      expect(postedDeliveryHashes(fetchStub)).toEqual([]);
      expect(storedQueue(h)).toBe(JSON.stringify([queuedItem]));
    } finally {
      fetchStub.restore();
    }
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

  test("queues nothing when the door cancels the quantity ask", async () => {
    using _fetch = stubFetch(new Error("offline"));
    await expectCancelQueuesNothing(fresh({ onLine: false }));
  });

  test("queues a ticket beside one the door already holds", async () => {
    using _fetch = stubFetch(() => Response.json({}, { status: 500 }));
    const h = fresh({ onLine: false, ...queueSeeded() });

    await scanOffline(h, "tokB67890");
    await whenTextShows(
      h.statusEl,
      "Ticket looks valid. It will be checked in when you are back online.",
    );

    expect(JSON.parse(String(storedQueue(h)))).toHaveLength(2);
  });
});

describe("scanner offline page with a one-day replay window", {
  sanitizeOps: false,
  sanitizeResources: false,
}, () => {
  const fresh = useScannerSuite(
    SCANNER_PAGE.replace(
      'data-scan-operation-retention-days="7"',
      'data-scan-operation-retention-days="1"',
    ),
  );

  test("wires the offline side for the window", () => {
    using _fetch = stubFetch(() => Response.json({}, { status: 500 }));
    const h = fresh();

    expect(el(h.document, "scanner-queue-summary").textContent).toBe(
      "0 queued check-ins",
    );
  });
});
