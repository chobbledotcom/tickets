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
import {
  drain,
  whenStatusShows,
  withEmptyCache,
} from "#test/ui/client/scanner/camera-fakes.ts";
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
  elementOf,
  postedDeliveryHashes,
  queueSeeded,
  refusingDoor,
  scanOffline,
  setConnection,
  settledCheckIn,
  switchArmed,
} from "#test/ui/client/scanner/offline-door.ts";
import { stubFetch } from "#test-utils/fetch-stub.ts";

const MANUAL_WORDS =
  "Offline mode is on. Scans are queued and checked in when you are back online.";

const AUTO_OFF_WORDS =
  "No connection. Turn on offline mode while you have a connection to scan without one.";

const CACHE_PATH = SCAN_PATH.replace(/\/scan$/, "/scan-cache");

describe("scanner offline switch and banner", {
  sanitizeOps: false,
  sanitizeResources: false,
}, () => {
  const fresh = useScannerSuite();
  const toggleOf = elementOf("scanner-offline-toggle");
  const bannerOf = elementOf("scanner-offline-banner");
  const bannerWords = (h: ScannerHarness): string | null =>
    elementOf("scanner-offline-banner-text")(h).textContent;

  test("words the banner for the connection each time it flips, and hides it online", () => {
    using _fetch = refusingDoor();
    const h = fresh({ onLine: false });
    // No switch, no saved list: the banner says the door needs offline
    // mode, not that scans are queued when nothing can vouch for them.
    expect(bannerWords(h)).toBe(AUTO_OFF_WORDS);
    expect(bannerOf(h).className).not.toContain("hidden");

    setConnection(h, true);
    expect(bannerOf(h).className).toContain("hidden");

    setConnection(h, false);
    expect(bannerWords(h)).toBe(AUTO_OFF_WORDS);
    expect(bannerOf(h).className).not.toContain("hidden");
  });

  test("words the banner for the switch while the connection holds", () => {
    using _fetch = refusingDoor();
    const h = fresh(switchArmed);

    // The stored mode really armed the switch: the toggle reads pressed
    // and the banner shows, each worded for the switch.
    expect(toggleOf(h).getAttribute("aria-pressed")).toBe("true");
    expect(bannerOf(h).className).not.toContain("hidden");
    expect(bannerWords(h)).toBe(MANUAL_WORDS);
  });

  test("sends the queue when the connection returns", async () => {
    using fetchStub = stubFetch(withEmptyCache(settledCheckIn));
    const h = fresh({ onLine: false, ...queueSeeded() });
    expect(postedDeliveryHashes(fetchStub)).toEqual([]);

    setConnection(h, true);

    await whenTextShows(h.statusEl, "Queued tickets are done.");
    expect(postedDeliveryHashes(fetchStub)).toEqual([queuedItem.tokenHash]);
    expect(storedQueue(h)).toBe("[]");
  });

  test("sends the queue when the page loads online", async () => {
    using fetchStub = stubFetch(withEmptyCache(settledCheckIn));
    const h = fresh(queueSeeded());

    await whenTextShows(h.statusEl, "Queued tickets are done.");
    expect(postedDeliveryHashes(fetchStub)).toEqual([queuedItem.tokenHash]);
  });

  test("asks for a fresh list when the door arms the switch online", () => {
    using fetchStub = stubFetch(() => Response.json({}, { status: 500 }));
    const h = fresh();
    const before = askedUrls(fetchStub).length;

    toggleOf(h).click();

    expect(askedUrls(fetchStub).slice(before)).toEqual([CACHE_PATH]);
  });

  test("holds the queue while the door arms the switch", async () => {
    using fetchStub = stubFetch(withEmptyCache(settledCheckIn));
    const h = fresh({ onLine: false, ...queueSeeded() });
    h.stash.set("navigator", { onLine: true });

    toggleOf(h).click();
    await drain();

    expect(postedDeliveryHashes(fetchStub)).toEqual([]);
    expect(storedQueue(h)).toBe(JSON.stringify([queuedItem]));
  });

  test("queues a ticket beside one the door already holds", async () => {
    using _fetch = refusingDoor();
    const h = fresh({ onLine: false, ...queueSeeded() });

    await scanOffline(h, "tokB67890");
    await whenStatusShows(
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
    using _fetch = refusingDoor();
    const h = fresh();

    expect(el(h.document, "scanner-queue-summary").textContent).toBe(
      "0 queued check-ins",
    );
  });
});
