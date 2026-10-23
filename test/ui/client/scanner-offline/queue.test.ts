/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
// test-groups: run-alone — the bundle runs inside happy-dom, whose internal
// task timers can outlive `happyDOM.abort()` under load; in a shared isolate a
// trailing timer fires during whichever suite runs next and fails its op
// sanitizer. Solo, it dies with the isolate — the proven-safe historical mode.

/**
 * The offline door: the switch the page restores from its store, and the
 * scans a dead connection queues or refuses. The replay that settles the
 * queue is #test/ui/client/scanner-offline-ui/sync.test.ts. Every test
 * drives the real built bundle, so the words asserted are the words the
 * door reads.
 */

// jscpd:ignore-start -- imports
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { Stub } from "@std/testing/mock";
import { hmacHex } from "#shared/sha256.ts";
import {
  cameraFakes,
  doorKey,
  drain,
  postedScanTokens,
  scanFirst,
  scanNext,
  scanWaitingOnDigest,
  seedTicketCache,
  start,
  whenStatusShows,
  whenStoreHolds,
  withEmptyCache,
} from "#test/ui/client/scanner/camera-fakes.ts";
import {
  el,
  fullStore,
  queuedItem,
  SCAN_PATH,
  type ScannerHarness,
  storedQueue,
  TOKEN,
  useScannerSuite,
} from "#test/ui/client/scanner/fixture.ts";
import { stubFetch } from "#test-utils/fetch-stub.ts";

// jscpd:ignore-end

describe("scanner offline door", {
  sanitizeOps: false,
  sanitizeResources: false,
}, () => {
  const fresh = useScannerSuite();

  /** Every fetch the page made, as the urls it asked for. */
  const askedUrls = (fetchStub: Stub): string[] =>
    fetchStub.calls.map((call) => String(call.args[0]));

  /** The store holds exactly one queued check-in, the token the page kept. */
  const expectOneStoredCheckIn = (h: ScannerHarness, token: string): void => {
    expect(JSON.parse(String(storedQueue(h)))).toEqual([
      { queuedAt: expect.any(Number), scanPath: SCAN_PATH, token },
    ]);
  };

  /** What the page shows and keeps when the store refuses a switch
   * change: the refusal words, and every surface as it was. */
  const refusedChangeLeaves = (
    h: ScannerHarness,
    left: { bannerHidden: boolean; mode: string | null; pressed: string },
  ): void => {
    expect(h.statusEl.textContent).toBe(
      "Your change was not saved. Free up space on this device, then try again.",
    );
    expect(h.statusEl.className).toContain("scanner-status-error");
    expect(
      el(h.document, "scanner-offline-toggle").getAttribute("aria-pressed"),
    ).toBe(left.pressed);
    expect(
      el(h.document, "scanner-offline-banner").className.includes("hidden"),
    ).toBe(left.bannerHidden);
    expect(h.window.localStorage.getItem("scanner-offline-mode")).toBe(
      left.mode,
    );
  };

  /** One offline scan: the camera opens with the door's cache holding the
   * given tickets' digests — or, when the store holds no cache, with nothing
   * seeded — and the first decode reaches the page. */
  const scanOffline = async (
    h: ScannerHarness,
    scanned: string,
    cache: { token?: string; storedAt?: number } | null = {},
  ): Promise<void> => {
    using fakes = cameraFakes(h);
    fakes.ready(4);
    if (cache !== null) {
      await seedTicketCache(
        h,
        cache.token ?? scanned,
        cache.storedAt ?? Date.now(),
      );
    }
    await start(h);
    await scanFirst(fakes, scanned);
  };

  test("restores the offline switch the store holds", () => {
    const h = fresh({
      seed: (store) => store.setItem("scanner-offline-mode", "1"),
    });

    const banner = el(h.document, "scanner-offline-banner");
    expect(banner.className).not.toContain("hidden");
    expect(el(h.document, "scanner-offline-banner-text").textContent).toBe(
      "Offline mode is on. Scans are queued and checked in when you are back online.",
    );
    expect(
      el(h.document, "scanner-offline-toggle").getAttribute("aria-pressed"),
    ).toBe("true");
  });

  test("shows the no-connection banner while the page has no connection", () => {
    const h = fresh({ onLine: false });

    // Nobody turned the switch: the dead connection alone puts the banner
    // up, worded for the missing connection.
    expect(el(h.document, "scanner-offline-banner").className).not.toContain(
      "hidden",
    );
    expect(el(h.document, "scanner-offline-banner-text").textContent).toBe(
      "No connection. Scans are queued and checked in when you are back online.",
    );
  });

  test("stores the offline switch the door turns on", () => {
    const h = fresh();
    const toggle = el(h.document, "scanner-offline-toggle");

    toggle.click();

    expect(h.window.localStorage.getItem("scanner-offline-mode")).toBe("1");
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(el(h.document, "scanner-offline-banner-text").textContent).toBe(
      "Offline mode is on. Scans are queued and checked in when you are back online.",
    );

    // A fresh page restores the position the click stored.
    const restored = fresh({
      seed: (store) =>
        store.setItem(
          "scanner-offline-mode",
          String(h.window.localStorage.getItem("scanner-offline-mode")),
        ),
    });
    expect(
      el(restored.document, "scanner-offline-banner").className,
    ).not.toContain("hidden");
    expect(
      el(restored.document, "scanner-offline-toggle").getAttribute(
        "aria-pressed",
      ),
    ).toBe("true");
  });

  test("queues a valid scan offline without posting it", async () => {
    const fetchStub = stubFetch(() => Response.json({}, { status: 500 }));
    try {
      const h = fresh({ onLine: false });
      await scanOffline(h, TOKEN);
      await whenStatusShows(
        h.statusEl,
        "Ticket looks valid. It will be checked in when you are back online.",
      );
      expectOneStoredCheckIn(h, TOKEN);
      // The words the door reads: the banner is up with the page's
      // statement, and the queue panel shows the kept scan.
      expect(el(h.document, "scanner-offline-banner").className).not.toContain(
        "hidden",
      );
      expect(el(h.document, "scanner-offline-banner-text").textContent).toBe(
        "No connection. Scans are queued and checked in when you are back online.",
      );
      expect(el(h.document, "scanner-queue").className).not.toContain("hidden");
      // The door read the page's own words off the queue panel.
      expect(el(h.document, "scanner-queue-summary").textContent).toBe(
        "1 queued check-in",
      );
      // No scan left the page: only the page load's cache refresh ran.
      expect(askedUrls(fetchStub)).toEqual([`${SCAN_PATH}-cache`]);
    } finally {
      fetchStub.restore();
    }
  });

  test("sends a scan the connection returned for while its digest ran", async () => {
    // The scan's digest runs on the platform's crypto. The connection
    // returns while that digest still waits, and the store it finds is
    // empty, so the returning connection schedules nothing. The queued
    // check-in itself must ask for the sync once it lands.
    const fetchStub = stubFetch(
      withEmptyCache(() =>
        Response.json({
          listingName: "Standard",
          name: "Ada",
          quantity: 1,
          status: "checked_in",
          total: 1,
        }),
      ),
    );
    try {
      const h = fresh({ onLine: false });
      using fakes = cameraFakes(h);
      fakes.ready(4);
      const scanToken = "tokC67890";
      using digest = await scanWaitingOnDigest(h, fakes, scanToken);

      // The connection returns while the digest still waits. The store is
      // empty, so the returning connection schedules nothing.
      h.stash.set("navigator", { onLine: true });
      h.window.dispatchEvent(new h.window.Event("online"));
      await drain();
      expect(storedQueue(h)).toBe(null);
      expect(askedUrls(fetchStub)).toEqual([`${SCAN_PATH}-cache`]);

      digest.release();
      await whenStatusShows(h.statusEl, "Queued tickets are done.");
      expect(storedQueue(h)).toBe("[]");
      expect(postedScanTokens(fetchStub)).toEqual([scanToken]);
      expect(
        el(h.document, "scanner-queue-items").children[0]?.textContent,
      ).toBe("Checked in");
    } finally {
      fetchStub.restore();
    }
  });

  test("validates a scan against the list the page load fetched", async () => {
    // The page load fetches the door's ticket list from the cache endpoint
    // and stores it. A scan made offline reads that stored list alone: the
    // ticket it holds queues, and a stranger the list does not hold is
    // sent away. No test hand writes the store's list.
    const fetchStub = stubFetch(async (url) =>
      String(url).endsWith("-cache")
        ? Response.json({ hashes: [await hmacHex(doorKey, TOKEN)] })
        : Response.json({}, { status: 500 }),
    );
    try {
      const h = fresh();
      using fakes = cameraFakes(h);
      fakes.ready(4);
      await start(h);
      // The fetched list sits in the store, written by the page's own load.
      const stored = await whenStoreHolds(h, `scanner-tickets-${SCAN_PATH}`);
      expect(JSON.parse(stored)).toEqual({
        hashes: [await hmacHex(doorKey, TOKEN)],
        storedAt: expect.any(Number),
      });

      // The connection drops, and the scan reads the fetched list alone.
      h.stash.set("navigator", { onLine: false });
      h.window.dispatchEvent(new h.window.Event("offline"));
      await scanFirst(fakes, TOKEN);
      await whenStatusShows(
        h.statusEl,
        "Ticket looks valid. It will be checked in when you are back online.",
      );
      expectOneStoredCheckIn(h, TOKEN);

      // A stranger the fetched list does not hold: sent away, nothing kept.
      await scanNext(fakes, "other12345", 3000);
      await whenStatusShows(
        h.statusEl,
        "This ticket cannot be checked in offline. Scan it again when you are back online to see why.",
      );
      expect(JSON.parse(String(storedQueue(h)))).toHaveLength(1);
      // No scan left the page: only the load's cache request ran.
      expect(askedUrls(fetchStub)).toEqual([`${SCAN_PATH}-cache`]);
    } finally {
      fetchStub.restore();
    }
  });

  test("sends an unknown ticket away with the offline wording", async () => {
    const h = fresh({ onLine: false });
    // The cache holds another ticket's digest; the scanned one is a stranger.
    await scanOffline(h, TOKEN, { token: "other12345" });
    await whenStatusShows(
      h.statusEl,
      "This ticket cannot be checked in offline. Scan it again when you are back online to see why.",
    );
    expect(storedQueue(h)).toBe(null);
  });

  test("refuses a second scan of a ticket already queued", async () => {
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
    // The first queue item stands alone.
    expect(storedQueue(h)).toBe(JSON.stringify([queuedItem]));
  });

  test("says a scan was not saved when the store refuses it", async () => {
    const h = fresh({ onLine: false });
    fullStore(h);
    await scanOffline(h, TOKEN);
    await whenStatusShows(
      h.statusEl,
      "This scan was not saved. Free up space on this device, then scan it again.",
    );
    expect(h.statusEl.className).toContain("scanner-status-error");
    expect(storedQueue(h)).toBe(null);
  });

  test("keeps the switch off and says so when the store refuses the change", () => {
    const h = fresh();
    fullStore(h);

    el(h.document, "scanner-offline-toggle").click();

    refusedChangeLeaves(h, {
      bannerHidden: true,
      mode: null,
      pressed: "false",
    });
  });

  test("keeps the switch on and says so when the store refuses the change", () => {
    using _fetch = stubFetch(new Error("offline"));
    const h = fresh({ onLine: false });
    el(h.document, "scanner-offline-toggle").click();
    fullStore(h);

    el(h.document, "scanner-offline-toggle").click();

    refusedChangeLeaves(h, {
      bannerHidden: false,
      mode: "1",
      pressed: "true",
    });
  });

  test("says the offline ticket list is missing when the store holds none", async () => {
    using _fetch = stubFetch(new Error("offline"));
    const h = fresh({ onLine: false });
    // The store holds no ticket list, and the refresh that would fetch one
    // cannot run offline: the door learns why the scan is refused.
    await scanOffline(h, TOKEN, null);
    await whenStatusShows(
      h.statusEl,
      "No offline ticket list yet. Go online and reload this page first.",
    );
    expect(h.statusEl.className).toContain("scanner-status-error");
    expect(storedQueue(h)).toBe(null);
  });

  test("treats a cache stamped in the future as expired", async () => {
    using _fetch = stubFetch(new Error("offline"));
    const h = fresh({ onLine: false });
    await scanOffline(h, TOKEN, { storedAt: Date.now() + 60_000 });
    await whenStatusShows(
      h.statusEl,
      "The offline ticket list has expired. Go online and reload this page.",
    );
    expect(storedQueue(h)).toBe(null);
  });

  test("makes no fetch for a stale list at scan time while the switch is on", async () => {
    const fetchStub = stubFetch(() => Response.json({}, { status: 500 }));
    try {
      // The connection holds, but the switch keeps the door offline: the
      // scan reads the stored list alone, however stale it has grown.
      const h = fresh({
        seed: (store) => store.setItem("scanner-offline-mode", "1"),
      });
      await scanOffline(h, TOKEN, {
        storedAt: Date.now() - 13 * 60 * 60 * 1000,
      });
      await whenStatusShows(
        h.statusEl,
        "The offline ticket list has expired. Go online and reload this page.",
      );
      // Only the page load's refresh ran; the scan itself asked for nothing.
      expect(askedUrls(fetchStub)).toEqual([`${SCAN_PATH}-cache`]);
      expect(storedQueue(h)).toBe(null);
    } finally {
      fetchStub.restore();
    }
  });
});
