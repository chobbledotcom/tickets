/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
// test-groups: run-alone — the bundle runs inside happy-dom, whose internal
// task timers can outlive `happyDOM.abort()` under load; in a shared isolate a
// trailing timer fires during whichever suite runs next and fails its op
// sanitizer. Solo, it dies with the isolate — the proven-safe historical mode.

/** The offline door's switch and the scans a dead connection refuses. Every
 * test runs the real built bundle, so the words asserted are the words the
 * door reads. */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  cameraFakes,
  scanFirst,
  seedTicketCache,
  start,
  whenStatusShows,
} from "#test/ui/client/scanner/camera-fakes.ts";
import {
  el,
  fullStore,
  queuedItem,
  SCANNER_PAGE_WITHOUT_REPLAY_WINDOW,
  SCANNER_PAGE_WITHOUT_SCAN_PATH,
  type ScannerHarness,
  storedQueue,
  TOKEN,
  useScanner,
  useScannerSuite,
} from "#test/ui/client/scanner/fixture.ts";
import {
  askedUrls,
  expectOfflineRefusal,
} from "#test/ui/client/scanner/offline-door.ts";
import { stubFetch } from "#test-utils/fetch-stub.ts";

describe("scanner offline door", {
  sanitizeOps: false,
  sanitizeResources: false,
}, () => {
  const fresh = useScannerSuite();

  /** One offline scan: the camera opens and the first decode reaches the page. */
  const scanOffline = async (
    h: ScannerHarness,
    scanned: string,
    storedAt?: number,
  ): Promise<void> => {
    using fakes = cameraFakes(h);
    fakes.ready(4);
    await seedTicketCache(h, scanned, storedAt ?? Date.now());
    await start(h);
    await scanFirst(fakes, scanned);
  };

  test("shows the no-connection banner while the page has no connection", () => {
    const h = fresh({ onLine: false });
    expect(el(h.document, "scanner-offline-banner").className).not.toContain(
      "hidden",
    );
    // The switch is off, so the banner says the door needs offline mode.
    expect(el(h.document, "scanner-offline-banner-text").textContent).toBe(
      "No connection. Turn on offline mode while you have a connection to scan without one.",
    );
  });

  test("refuses a second scan of a ticket already queued", async () => {
    const fetchStub = stubFetch(() => Response.json({}, { status: 500 }));
    try {
      const h = fresh({
        onLine: false,
        seed: (store) =>
          store.setItem("scanner-queue", JSON.stringify([queuedItem])),
      });
      await scanOffline(h, TOKEN);
      await whenStatusShows(
        h.statusEl,
        "This ticket is already queued. Do not let them in again.",
      );
      // The first queue item stands alone, and no scan left the page.
      expect(storedQueue(h)).toBe(JSON.stringify([queuedItem]));
      expect(askedUrls(fetchStub)).toEqual([]);
    } finally {
      fetchStub.restore();
    }
  });

  test("treats a cache stamped in the future as expired", async () => {
    const fetchStub = stubFetch(new Error("offline"));
    try {
      const h = fresh({ onLine: false });
      await scanOffline(h, TOKEN, Date.now() + 60_000);
      await whenStatusShows(
        h.statusEl,
        "The offline ticket list has expired. Go online and reload this page.",
      );
      expect(storedQueue(h)).toBe(null);
      expect(askedUrls(fetchStub)).toEqual([]);
    } finally {
      fetchStub.restore();
    }
  });

  test("says a scan was not saved when the store refuses it", async () => {
    const fetchStub = stubFetch(new Error("offline"));
    try {
      const h = fresh({ onLine: false });
      fullStore(h);
      await scanOffline(h, TOKEN);
      await expectOfflineRefusal(
        h,
        fetchStub,
        "This was not saved because this device has no room left for this site. Turn offline mode off to free the space.",
      );
    } finally {
      fetchStub.restore();
    }
  });
});

describe("scanner offline door on a page without the replay window", {
  sanitizeOps: false,
  sanitizeResources: false,
}, () => {
  test("refuses to start, naming the missing replay window", () => {
    // The client bounds its replay window by the count the page carries.
    // A page without it is a broken page, so the scanner names the fault.
    expect(() => useScanner(SCANNER_PAGE_WITHOUT_REPLAY_WINDOW)).toThrow(
      "The scanner page carries no usable data-scan-operation-retention-days",
    );
  });
});

describe("scanner page without the scan path", {
  sanitizeOps: false,
  sanitizeResources: false,
}, () => {
  test("refuses to start, naming the missing attribute", () => {
    // The client names the door it scans for by this attribute. A page
    // without it is a broken page, so the scanner names the fault instead
    // of scanning an invented path.
    expect(() => useScanner(SCANNER_PAGE_WITHOUT_SCAN_PATH)).toThrow(
      "Missing attribute: data-scan-path",
    );
  });
});
