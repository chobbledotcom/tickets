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
  postedScanBodies,
  scanFirst,
  start,
  whenStatusShows,
} from "#test/ui/client/scanner/camera-fakes.ts";
import {
  el,
  fullStore,
  queuedItem,
  SCAN_PATH,
  SCANNER_PAGE_WITHOUT_REPLAY_WINDOW,
  storedQueue,
  TOKEN,
  useScannerSuite,
} from "#test/ui/client/scanner/fixture.ts";
import {
  askedUrls,
  expectOfflineRefusal,
  scanOffline,
} from "#test/ui/client/scanner/offline-door.ts";
import { stubFetch } from "#test-utils/fetch-stub.ts";

describe("scanner offline door", {
  sanitizeOps: false,
  sanitizeResources: false,
}, () => {
  const fresh = useScannerSuite();

  test("stores the offline switch the door turns on", () => {
    const h = fresh();
    const toggle = el(h.document, "scanner-offline-toggle");
    toggle.click();

    expect(h.window.localStorage.getItem("scanner-offline-mode")).toBe("1");
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(el(h.document, "scanner-offline-banner-text").textContent).toBe(
      "Offline mode is on. Scans are queued and checked in when you are back online.",
    );
  });

  test("shows the no-connection banner while the page has no connection", () => {
    const h = fresh({ onLine: false });
    expect(el(h.document, "scanner-offline-banner").className).not.toContain(
      "hidden",
    );
    expect(el(h.document, "scanner-offline-banner-text").textContent).toBe(
      "No connection. Scans are queued and checked in when you are back online.",
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
    expect(askedUrls(fetchStub)).toEqual([`${SCAN_PATH}-cache`]);
  });

  test("treats a cache stamped in the future as expired", async () => {
    using fetchStub = stubFetch(new Error("offline"));
    const h = fresh({ onLine: false });
    await scanOffline(h, TOKEN, { storedAt: Date.now() + 60_000 });
    await whenStatusShows(
      h.statusEl,
      "The offline ticket list has expired. Go online and reload this page.",
    );
    expect(storedQueue(h)).toBe(null);
    expect(askedUrls(fetchStub)).toEqual([`${SCAN_PATH}-cache`]);
  });

  test("says a scan was not saved when the store refuses it", async () => {
    using fetchStub = stubFetch(new Error("offline"));
    const h = fresh({ onLine: false });
    fullStore(h);
    await scanOffline(h, TOKEN);
    await expectOfflineRefusal(
      h,
      fetchStub,
      "This scan was not saved. Free up space on this device, then scan it again.",
    );
  });
});

describe("scanner offline door on a page without the replay window", {
  sanitizeOps: false,
  sanitizeResources: false,
}, () => {
  const fresh = useScannerSuite(SCANNER_PAGE_WITHOUT_REPLAY_WINDOW);

  test("scans online only when the page carries no replay window", async () => {
    // The client bounds its replay window by the count the page carries.
    // Without it the offline side is absent furniture: the scan goes
    // online, the way the page worked before the offline side existed.
    using fetchStub = stubFetch(() =>
      Response.json({
        listingName: "Standard",
        name: "Ada",
        quantity: 1,
        status: "checked_in",
        total: 1,
      }),
    );
    const h = fresh({ onLine: false });
    using fakes = cameraFakes(h);
    fakes.ready(4);
    await start(h);
    await scanFirst(fakes, TOKEN);

    // The check-in went out as a live scan, and nothing was queued.
    expect(postedScanBodies(fetchStub)).toEqual([{ token: TOKEN }]);
    expect(storedQueue(h)).toBe(null);
  });
});
