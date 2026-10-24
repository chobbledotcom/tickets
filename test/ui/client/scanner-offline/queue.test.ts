/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
// test-groups: run-alone — the bundle runs inside happy-dom, whose internal
// task timers can outlive `happyDOM.abort()` under load; in a shared isolate a
// trailing timer fires during whichever suite runs next and fails its op
// sanitizer. Solo, it dies with the isolate — the proven-safe historical mode.

/**
 * The offline door's queue: the scans a dead connection keeps, and the ones
 * it refuses, with the words the door reads. The replay that settles the
 * queue is #test/ui/client/scanner-offline-ui/sync.test.ts. Every test
 * drives the real built bundle, so the words asserted are the words the door
 * reads.
 */

// jscpd:ignore-start -- imports
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
  SCAN_PATH,
  type ScannerHarness,
  storedQueue,
  TOKEN,
  useScannerSuite,
} from "#test/ui/client/scanner/fixture.ts";
import {
  askedUrls,
  expectOneStoredCheckIn,
} from "#test/ui/client/scanner/offline-door.ts";
import { stubFetch } from "#test-utils/fetch-stub.ts";

// jscpd:ignore-end

describe("scanner offline queue", {
  sanitizeOps: false,
  sanitizeResources: false,
}, () => {
  const fresh = useScannerSuite();

  /** One offline scan: the camera opens with the door's cache holding the
   * given ticket — or, when `cache` is null, with nothing seeded — and the
   * first decode reaches the page. */
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
      // The door reads the page's own words: the queue panel is out with
      // the kept scan's count.
      expect(el(h.document, "scanner-queue").className).not.toContain("hidden");
      expect(el(h.document, "scanner-queue-summary").textContent).toBe(
        "1 queued check-in",
      );
      // No scan left the page: only the page load's cache refresh ran.
      expect(askedUrls(fetchStub)).toEqual([`${SCAN_PATH}-cache`]);
    } finally {
      fetchStub.restore();
    }
  });

  test("sends an unknown ticket away with the offline wording", async () => {
    const fetchStub = stubFetch(new Error("offline"));
    try {
      const h = fresh({ onLine: false });
      // The cache holds another ticket's digest; the scanned one is a stranger.
      await scanOffline(h, TOKEN, { token: "other12345" });
      await whenStatusShows(
        h.statusEl,
        "This ticket cannot be checked in offline. Scan it again when you are back online to see why.",
      );
      expect(h.statusEl.className).toContain("scanner-status-error");
      expect(storedQueue(h)).toBe(null);
      // The refusal asked for nothing: only the page load's cache refresh ran.
      expect(askedUrls(fetchStub)).toEqual([`${SCAN_PATH}-cache`]);
    } finally {
      fetchStub.restore();
    }
  });

  test("says the offline ticket list is missing when the store holds none", async () => {
    const fetchStub = stubFetch(new Error("offline"));
    try {
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
      expect(askedUrls(fetchStub)).toEqual([`${SCAN_PATH}-cache`]);
    } finally {
      fetchStub.restore();
    }
  });
});
