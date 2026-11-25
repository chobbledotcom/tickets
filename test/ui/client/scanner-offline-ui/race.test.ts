/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
// test-groups: run-alone — the bundle runs inside happy-dom, whose internal
// task timers can outlive `happyDOM.abort()` under load; in a shared isolate a
// trailing timer fires during whichever suite runs next and fails its op
// sanitizer. Solo, it dies with the isolate — the proven-safe historical mode.

/**
 * The races the offline door's queue and sync run: a scan that lands while
 * its digest still runs or while a sync is already replaying, the re-run
 * the returning connection schedules, and the fetched list an offline scan
 * validates against. Every test drives the real built bundle, so the words
 * asserted are the words the door reads.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { hmacHex } from "#shared/sha256.ts";
import {
  cameraFakes,
  drain,
  scanFirst,
  scanNext,
  start,
  whenStatusShows,
  whenStoreHolds,
  withEmptyCache,
} from "#test/ui/client/scanner/camera-fakes.ts";
import {
  DOOR_KEY,
  el,
  SCAN_PATH,
  storedQueue,
  TOKEN,
  useScannerSuite,
} from "#test/ui/client/scanner/fixture.ts";
import {
  askedUrls,
  digestOf,
  expectOneStoredCheckIn,
  firstRow,
  postedDeliveryHashes,
  scanWaitingOnDigest,
} from "#test/ui/client/scanner/offline-door.ts";
import { stubFetch } from "#test-utils/fetch-stub.ts";

describe("scanner offline races", {
  sanitizeOps: false,
  sanitizeResources: false,
}, () => {
  const fresh = useScannerSuite();

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
      expect(postedDeliveryHashes(fetchStub)).toEqual([
        await digestOf(scanToken),
      ]);
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
        ? Response.json({
            entries: [{ hash: await hmacHex(DOOR_KEY, TOKEN), tickets: 1 }],
          })
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
        entries: [{ hash: await hmacHex(DOOR_KEY, TOKEN), tickets: 1 }],
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
      await expectOneStoredCheckIn(h, TOKEN);

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

  test("queues nothing when the page holds no offline list", async () => {
    // A scan made offline with no stored list has nothing that can vouch
    // for the ticket. The page sends the door online to load one, and
    // keeps no scan.
    const h = fresh({ onLine: false });
    using fakes = cameraFakes(h);
    fakes.ready(4);

    await start(h);
    await scanFirst(fakes, TOKEN);
    await whenStatusShows(
      h.statusEl,
      "No offline ticket list yet. Go online and reload this page first.",
    );

    // The panel carries no rows, and the wait for a queued check-in runs
    // out and names the page: nothing was kept.
    expect(() => firstRow(h)).toThrow("The queue panel carries no first row");
    await expect(whenStoreHolds(h, "scanner-queue")).rejects.toThrow(
      "The store never held scanner-queue",
    );
  });
});
