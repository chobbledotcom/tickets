/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
// test-groups: run-alone — the bundle runs inside happy-dom, whose internal
// task timers can outlive `happyDOM.abort()` under load; in a shared isolate a
// trailing timer fires during whichever suite runs next and fails its op
// sanitizer. Solo, it dies with the isolate — the proven-safe historical mode.

/**
 * The offline door: the switch the page restores from its store, and the
 * scans a dead connection queues or refuses. The replay that settles the
 * queue is offline-sync.test.ts. Every test drives the real built bundle, so
 * the words asserted are the words the door reads.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { Stub } from "@std/testing/mock";
import { fromBase64Url } from "#crypto/utils.ts";
import { hmacHex } from "#shared/sha256.ts";
import { stubFetch } from "#test-utils/fetch-stub.ts";
import { cameraFakes, scanFirst, start } from "./camera-fakes.ts";
import {
  el,
  fullStore,
  queuedItem,
  SCAN_PATH,
  type ScannerHarness,
  storedQueue,
  TOKEN,
  useScannerSuite,
} from "./fixture.ts";

describe("scanner offline door", {
  sanitizeOps: false,
  sanitizeResources: false,
}, () => {
  const fresh = useScannerSuite();

  /** The page's own door key, as the fixture renders it. */
  const doorKey = fromBase64Url("dGVzdC1kb296LWNhY2hlLWtleQ");

  /** The door's ticket cache, stamped by the clock the scan will read. The
   * camera fakes own the clock, so the seed lands after they do. */
  const seedTicketCache = async (
    h: ScannerHarness,
    token: string,
    storedAt: number,
  ): Promise<void> => {
    h.window.localStorage.setItem(
      `scanner-tickets-${SCAN_PATH}`,
      JSON.stringify({ hashes: [await hmacHex(doorKey, token)], storedAt }),
    );
  };

  /** Every fetch the page made, as the urls it asked for. */
  const askedUrls = (fetchStub: Stub): string[] =>
    fetchStub.calls.map((call) => String(call.args[0]));

  /** The real timer the camera fakes replace, captured at module load. */
  const realSetTimeout = globalThis.setTimeout;

  /** Waits for the status line over real event-loop turns: the offline
   * digest runs on the platform's own crypto promise, which no microtask
   * drain resolves. */
  const whenStatusShows = async (
    h: ScannerHarness,
    text: string,
  ): Promise<void> => {
    for (
      let turns = 0;
      turns < 20 && h.statusEl.textContent !== text;
      turns++
    ) {
      await new Promise<void>((resolve) => realSetTimeout(resolve, 0));
      for (let hops = 0; hops < 50; hops++) await Promise.resolve();
    }
    expect(h.statusEl.textContent).toBe(text);
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
        h,
        "Ticket looks valid. It will be checked in when you are back online.",
      );
      expect(JSON.parse(String(storedQueue(h)))).toEqual([
        { queuedAt: expect.any(Number), scanPath: SCAN_PATH, token: TOKEN },
      ]);
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

  test("sends an unknown ticket away with the offline wording", async () => {
    const h = fresh({ onLine: false });
    // The cache holds another ticket's digest; the scanned one is a stranger.
    await scanOffline(h, TOKEN, { token: "other12345" });
    await whenStatusShows(
      h,
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
      h,
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
      h,
      "This scan was not saved. Free up space on this device, then scan it again.",
    );
    expect(h.statusEl.className).toContain("scanner-status-error");
    expect(storedQueue(h)).toBe(null);
  });

  test("keeps the switch off and says so when the store refuses the change", () => {
    const h = fresh();
    fullStore(h);

    el(h.document, "scanner-offline-toggle").click();

    expect(h.statusEl.textContent).toBe(
      "Your change was not saved. Free up space on this device, then try again.",
    );
    expect(h.statusEl.className).toContain("scanner-status-error");
    // The refused arm left the switch, the banner, and the store as they
    // were.
    expect(
      el(h.document, "scanner-offline-toggle").getAttribute("aria-pressed"),
    ).toBe("false");
    expect(el(h.document, "scanner-offline-banner").className).toContain(
      "hidden",
    );
    expect(h.window.localStorage.getItem("scanner-offline-mode")).toBe(null);
  });

  test("says the offline ticket list is missing when the store holds none", async () => {
    using _fetch = stubFetch(new Error("offline"));
    const h = fresh({ onLine: false });
    // The store holds no ticket list, and the refresh that would fetch one
    // cannot run offline: the door learns why the scan is refused.
    await scanOffline(h, TOKEN, null);
    await whenStatusShows(
      h,
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
      h,
      "The offline ticket list has expired. Go online and reload this page.",
    );
    expect(storedQueue(h)).toBe(null);
  });
});
