/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
// test-groups: run-alone — the bundle runs inside happy-dom, whose internal
// task timers can outlive `happyDOM.abort()` under load; in a shared isolate a
// trailing timer fires during whichever suite runs next and fails its op
// sanitizer. Solo, it dies with the isolate — the proven-safe historical mode.

/**
 * The offline door: the switch the page restores from its store, the scans a
 * dead connection queues, and the sync that settles them. Every test drives
 * the real built bundle, so the words asserted are the words the door reads.
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
  type ScannerHarness,
  useScannerSuite,
  whenTextShows,
} from "./fixture.ts";

describe("scanner offline door", {
  sanitizeOps: false,
  sanitizeResources: false,
}, () => {
  const fresh = useScannerSuite();

  const SCAN_PATH = "/admin/groups/5/scan";
  const TOKEN = "tok12345";
  /** The page's own door key, as the fixture renders it. */
  const doorKey = fromBase64Url("dGVzdC1kb296LWNhY2hlLWtleQ");

  /** The queued check-in one reload would restore. */
  const queuedItem = {
    queuedAt: 1,
    scanPath: SCAN_PATH,
    token: TOKEN,
  };

  const storedQueue = (h: ScannerHarness): string | null =>
    h.window.localStorage.getItem("scanner-queue");

  /** The queue panel's first row, which every sync test's page carries. */
  const firstRow = (h: ScannerHarness): Element => {
    const row = el(h.document, "scanner-queue-items").children[0];
    if (!row) throw new Error("The queue panel carries no first row");
    return row;
  };

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

  /** The store of a full or blocked device: every write to it fails. */
  const fullStore = (h: ScannerHarness): void => {
    h.stash.set(
      "localStorage",
      Object.create(h.window.localStorage, {
        setItem: {
          value: () => {
            throw new Error("The store is full");
          },
        },
      }),
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
   * given tickets' digests, and the first decode reaches the page. */
  const scanOffline = async (
    h: ScannerHarness,
    scanned: string,
    cache: { token?: string; storedAt?: number } = {},
  ): Promise<void> => {
    using fakes = cameraFakes(h);
    fakes.ready(4);
    await seedTicketCache(
      h,
      cache.token ?? scanned,
      cache.storedAt ?? Date.now(),
    );
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

  test("settles a queued check-in on the next page load", async () => {
    // A fresh response per call: the page load's cache refresh consumes the
    // first one's body, and a reused body would fail the replay's read.
    const fetchStub = stubFetch(() =>
      Response.json({
        listingName: "Standard",
        name: "Ada",
        quantity: 1,
        status: "checked_in",
        total: 1,
      }),
    );
    try {
      const h = fresh({
        seed: (store) =>
          store.setItem("scanner-queue", JSON.stringify([queuedItem])),
      });
      const summary = el(h.document, "scanner-queue-summary");
      await whenTextShows(summary, "0 queued check-ins");

      // The replay carried the queued ticket to the door it was scanned at.
      const scanCall = fetchStub.calls.find(
        (call) => String(call.args[0]) === SCAN_PATH,
      );
      expect(scanCall).toBeDefined();
      expect(JSON.parse(String(scanCall?.args[1]?.body))).toEqual({
        token: TOKEN,
      });
      expect(storedQueue(h)).toBe("[]");
      expect(firstRow(h).textContent).toBe("Checked in");
    } finally {
      fetchStub.restore();
    }
  });

  test("keeps a check-in the door did not answer and says so", async () => {
    using _fetch = stubFetch(new Error("offline"));
    const h = fresh({
      seed: (store) =>
        store.setItem("scanner-queue", JSON.stringify([queuedItem])),
    });

    await whenTextShows(
      h.statusEl,
      "Some tickets are still queued. The page will try to check them in again.",
    );

    expect(h.statusEl.className).toContain("scanner-status-warning");
    expect(firstRow(h).textContent).toBe("Not sent yet — still queued");
    expect(storedQueue(h)).toBe(JSON.stringify([queuedItem]));
  });

  test("stops the sync and names the store when a settled check-in will not save", async () => {
    // A fresh response per call: the page load's cache refresh consumes the
    // first one's body, and a reused body would fail the replay's read.
    using _fetch = stubFetch(() =>
      Response.json({
        listingName: "Standard",
        name: "Ada",
        quantity: 1,
        status: "checked_in",
        total: 1,
      }),
    );
    const h = fresh({
      seed: (store) =>
        store.setItem("scanner-queue", JSON.stringify([queuedItem])),
    });
    // The sync suspends at its first send, so the swap lands before the
    // settled item's removal write runs.
    fullStore(h);

    await whenTextShows(
      h.statusEl,
      "This device could not save the queued check-ins. Free up space, then reload this page.",
    );

    // The door answered, so the item stays for a replay that reads as
    // already checked in, and its row keeps the queued words.
    expect(storedQueue(h)).toBe(JSON.stringify([queuedItem]));
    expect(firstRow(h).textContent).toBe(
      "Waiting — will be checked in when online",
    );
  });

  test("tells the door a scan made during a sync is ignored", async () => {
    using _fetch = stubFetch(() => new Promise(() => {}));
    const h = fresh({
      seed: (store) =>
        store.setItem("scanner-queue", JSON.stringify([queuedItem])),
    });
    using fakes = cameraFakes(h);
    fakes.ready(4);
    await start(h);
    await scanFirst(fakes, TOKEN);

    expect(h.statusEl.textContent).toBe(
      "Checking in queued tickets. Scan again when done.",
    );
    expect(h.statusEl.className).toContain("scanner-status-warning");
  });
});
