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
  MODE_KEY,
  queuedItem,
  SCANNER_PAGE,
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
    using fetchStub = stubFetch(() => Response.json({}, { status: 500 }));
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
  });

  test("tells the door it cannot read the stored queue, and keeps it", () => {
    using _fetch = stubFetch(new Error("offline"));
    const oldQueue = '{"old":[]}';
    const h = fresh({
      seed: (store) => {
        store.setItem("scanner-queue", oldQueue);
        store.setItem(MODE_KEY, "1");
      },
    });

    expect(h.statusEl.textContent).toBe(
      "This device holds queued check-ins this page cannot read. Offline mode is off on this page. Scanning online still works.",
    );
    expect(h.statusEl.className).toContain("scanner-status-error");
    expect(storedQueue(h)).toBe(oldQueue);
  });

  test("treats a cache stamped in the future as expired", async () => {
    using fetchStub = stubFetch(new Error("offline"));
    const h = fresh({ onLine: false });
    await scanOffline(h, TOKEN, Date.now() + 60_000);
    await whenStatusShows(
      h.statusEl,
      "The offline ticket list has expired. Go online and reload this page.",
    );
    expect(storedQueue(h)).toBe(null);
    expect(askedUrls(fetchStub)).toEqual([]);
  });

  test("says a scan was not saved when the store refuses it", async () => {
    using fetchStub = stubFetch(new Error("offline"));
    const h = fresh({ onLine: false });
    fullStore(h);
    await scanOffline(h, TOKEN);
    await expectOfflineRefusal(
      h,
      fetchStub,
      "This was not saved because this device has no room left for this site. Turn offline mode off to free the space.",
    );
  });
});

describe("scanner page the template did not render whole", {
  sanitizeOps: false,
  sanitizeResources: false,
}, () => {
  // Each attribute names something the client cannot guess: the replay
  // window it bounds its queue by, and the door it scans for. A page
  // without one is a broken page, so the scanner names the fault instead of
  // scanning with an invented value.
  const brokenPages: readonly [string, string, string][] = [
    [
      "the replay window",
      SCANNER_PAGE_WITHOUT_REPLAY_WINDOW,
      "Missing attribute: data-scan-operation-retention-days",
    ],
    [
      "a usable replay window",
      SCANNER_PAGE.replace(
        'data-scan-operation-retention-days="7"',
        'data-scan-operation-retention-days="0"',
      ),
      "The scanner page carries no usable data-scan-operation-retention-days",
    ],
    [
      "the scan path",
      SCANNER_PAGE_WITHOUT_SCAN_PATH,
      "Missing attribute: data-scan-path",
    ],
  ];
  for (const [what, page, refusal] of brokenPages) {
    test(`refuses to start without ${what}, naming it`, () => {
      expect(() => useScanner(page)).toThrow(refusal);
    });
  }
});
