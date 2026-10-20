/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
// test-groups: run-alone — shares the scanner bundle harness, whose
// happy-dom timers can outlive the window under load (see fixture.ts).

/**
 * Offline behaviour of the scanner camera bundle (`src/ui/client/scanner.js`
 * plus `src/ui/client/scanner-offline*.js`): caching the door's ticket
 * hashes on load, validating a scan offline, queueing the check-in, and
 * settling the queue once the connection is back.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { sha256Hex } from "#shared/sha256.ts";
import { stubFetch } from "#test-utils/fetch-stub.ts";
import {
  type CameraFakes,
  cameraFakes,
  scanFirst,
  scanNext,
  start,
} from "./scanner/camera-fakes.ts";
import { el, type ScannerHarness, useScannerSuite } from "./scanner/fixture.ts";

const SCAN_PATH = "/admin/groups/5/scan";
const CACHE_KEY = `scanner-tickets-${SCAN_PATH}`;
const QUEUE_KEY = "scanner-queue";
const MODE_KEY = "scanner-offline-mode";
const CLOCK_START = 1_000;

/** A stored cache naming exactly the given tokens, stamped on the camera
 * tests' clock so it counts as fresh. The digests are the ones the door's
 * cache endpoint answers with. */
const freshCache = async (...tokens: string[]) =>
  JSON.stringify({
    hashes: await Promise.all(tokens.map(sha256Hex)),
    storedAt: CLOCK_START,
  });

/** The page's stored queue, as the client writes it. */
const storedQueue = (h: ScannerHarness): { token: string }[] =>
  JSON.parse(h.window.localStorage.getItem(QUEUE_KEY) ?? "[]");

/** Real timer captured before the camera fakes replace the global one: an
 * offline scan hashes with WebCrypto, whose promise settles on the event
 * loop rather than on microtasks alone. */
const realTimeout = setTimeout;

/** Drain the promise hops an offline scan needs, pumping real ticks so the
 * hash digests land. */
const settleOffline = async (): Promise<void> => {
  for (let hop = 0; hop < 100; hop++) {
    await Promise.resolve();
    const { promise, resolve } = Promise.withResolvers<void>();
    realTimeout(resolve, 0);
    await promise;
  }
};

/** Feed one scan to the booted door and let the offline promise hops land. */
const scanOffline = async (
  fakes: CameraFakes,
  token: string,
  ms?: number,
): Promise<void> => {
  if (ms === undefined) await scanFirst(fakes, token);
  else await scanNext(fakes, token, ms);
  await settleOffline();
};

/** Bring the offline door back online and let the queue's sync settle. */
const backOnline = async (h: ScannerHarness): Promise<void> => {
  h.stash.set("navigator", { onLine: true });
  h.window.dispatchEvent(new h.window.Event("online"));
  await settleOffline();
};

const queueRows = (h: ScannerHarness): (string | null)[] =>
  [...h.document.getElementById("scanner-queue-items")!.children].map(
    (row) => row.textContent,
  );

const queueSummary = (h: ScannerHarness): string | null =>
  h.document.getElementById("scanner-queue-summary")!.textContent;

const bannerText = (h: ScannerHarness): string =>
  h.document.getElementById("scanner-offline-banner-text")!.textContent ?? "";

describe("scanner offline mode", {
  sanitizeOps: false,
  sanitizeResources: false,
}, () => {
  const fresh = useScannerSuite();

  /** One booted door: offline unless the door says otherwise, the named
   * tokens in its stored cache, extra seed lines riding along, camera
   * ready, page started. The camera fakes dispose when the door's test
   * body ends. */
  const withOfflineDoor = async (
    door: {
      onLine?: boolean;
      seedMore?: (store: Storage) => void;
      tokens?: string[];
    },
    run: (h: ScannerHarness, fakes: CameraFakes) => Promise<void>,
  ): Promise<void> => {
    const cache = door.tokens ? await freshCache(...door.tokens) : null;
    const h = fresh({
      onLine: door.onLine ?? false,
      seed: (store) => {
        if (cache !== null) store.setItem(CACHE_KEY, cache);
        door.seedMore?.(store);
      },
    });
    using fakes = cameraFakes(h);
    fakes.ready(4);
    await start(h);
    await run(h, fakes);
  };

  test("stores the door's ticket hashes when the page loads", async () => {
    using _fetch = stubFetch(
      Response.json({
        hashes: [await sha256Hex("tok-1"), await sha256Hex("tok-2")],
      }),
    );
    const h = fresh();
    await settleOffline();

    const stored = JSON.parse(h.window.localStorage.getItem(CACHE_KEY)!);
    expect(stored.hashes).toEqual(
      await Promise.all([sha256Hex("tok-1"), sha256Hex("tok-2")]),
    );
    expect(typeof stored.storedAt).toBe("number");
  });

  test("queues an offline scan the stored cache names", async () => {
    await withOfflineDoor({ tokens: ["tok12345"] }, async (h, fakes) => {
      await scanOffline(fakes, "tok12345");

      expect(h.statusEl.textContent).toBe(
        "Ticket looks valid. It will check in when you are back online.",
      );
      expect(storedQueue(h)).toEqual([
        {
          queuedAt: expect.any(Number),
          scanPath: SCAN_PATH,
          token: "tok12345",
        },
      ]);
      expect(queueRows(h)).toEqual(["Queued — will check in when online"]);
      expect(queueSummary(h)).toBe("1 queued check-in");
      // No connection: the banner says why the door scans offline.
      expect(bannerText(h)).toBe(
        "No connection. Scans are queued and checked in when you are back online.",
      );
    });
  });

  test("refuses an offline scan the stored cache does not name", async () => {
    await withOfflineDoor({ tokens: ["tok99999"] }, async (h, fakes) => {
      await scanOffline(fakes, "tok12345");

      expect(h.statusEl.textContent).toBe(
        "This ticket cannot be checked in offline. Scan it again when you are back online to see why.",
      );
      expect(storedQueue(h)).toEqual([]);
      expect(queueRows(h)).toEqual([]);
    });
  });

  test("says the offline list has expired past twelve hours", async () => {
    const expired = JSON.stringify({
      hashes: [await sha256Hex("tok12345")],
      storedAt: CLOCK_START - 13 * 60 * 60 * 1000,
    });
    await withOfflineDoor(
      {
        seedMore: (store) => store.setItem(CACHE_KEY, expired),
      },
      async (h, fakes) => {
        await scanOffline(fakes, "tok12345");

        expect(h.statusEl.textContent).toBe(
          "The offline ticket list has expired. Go online and reload this page.",
        );
        expect(storedQueue(h)).toEqual([]);
      },
    );
  });

  test("asks for a list when the offline door has none stored", async () => {
    await withOfflineDoor({}, async (h, fakes) => {
      await scanOffline(fakes, "tok12345");

      expect(h.statusEl.textContent).toBe(
        "No offline ticket list yet. Go online and reload this page first.",
      );
    });
  });

  test("settles the queue when the connection returns, reporting each", async () => {
    await withOfflineDoor(
      {
        tokens: ["tok12345", "tok67890"],
      },
      async (h, fakes) => {
        await scanOffline(fakes, "tok12345");
        await scanOffline(fakes, "tok67890", 2000);
        expect(storedQueue(h)).toHaveLength(2);

        // The second ticket was checked in at another door while this one was
        // offline, so its row must say so unmistakably.
        using _fetch = stubFetch(
          Response.json({
            listingName: "Standard",
            name: "Ada",
            quantity: 1,
            status: "checked_in",
            total: 1,
          }),
          Response.json({
            listingName: "Standard",
            name: "Ada",
            quantity: 1,
            status: "already_checked_in",
            total: 1,
          }),
        );
        await backOnline(h);

        expect(queueRows(h)).toEqual(["Checked in", "Was already checked in"]);
        expect(storedQueue(h)).toEqual([]);
        expect(queueSummary(h)).toBe("0 queued check-ins");
      },
    );
  });

  test("keeps a queued check-in the sync cannot send", async () => {
    await withOfflineDoor({ tokens: ["tok12345"] }, async (h, fakes) => {
      await scanOffline(fakes, "tok12345");
      expect(storedQueue(h)).toHaveLength(1);

      using _fetch = stubFetch(new Error("offline"));
      await backOnline(h);

      expect(queueRows(h)).toEqual(["Not sent yet — still queued"]);
      expect(storedQueue(h)).toHaveLength(1);
    });
  });

  test("holds new scans while a sync is running", async () => {
    await withOfflineDoor(
      {
        tokens: ["tok12345", "tok67890"],
      },
      async (h, fakes) => {
        await scanOffline(fakes, "tok12345");
        expect(storedQueue(h)).toHaveLength(1);

        // The sync's answer never arrives, so the hold stays on.
        const _fetch = stubFetch(
          () => Promise.withResolvers<Response>().promise,
        );
        await backOnline(h);
        expect(_fetch.calls.length).toBe(1);

        // A ticket scanned while the queue settles is held, not queued.
        await scanOffline(fakes, "tok67890", 2000);
        expect(storedQueue(h)).toHaveLength(1);
        expect(queueRows(h)).toEqual(["Queued — will check in when online"]);
        _fetch.restore();
      },
    );
  });

  test("arms offline mode from the toggle and disarms it again", async () => {
    const h = fresh();
    const toggle = el(h.document, "scanner-offline-toggle");
    const banner = h.document.getElementById("scanner-offline-banner")!;

    toggle.click();
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(h.window.localStorage.getItem(MODE_KEY)).toBe("1");
    expect(banner.classList.contains("hidden")).toBe(false);
    expect(bannerText(h)).toBe(
      "Offline mode is on. Scans are queued and checked in when you are back online.",
    );

    toggle.click();
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(h.window.localStorage.getItem(MODE_KEY)).toBeNull();
    expect(banner.classList.contains("hidden")).toBe(true);
  });

  test("queues a scan while the manual mode is on, even online", async () => {
    await withOfflineDoor(
      {
        onLine: true,
        seedMore: (store) => store.setItem(MODE_KEY, "1"),
        tokens: ["tok12345"],
      },
      async (h, fakes) => {
        await scanOffline(fakes, "tok12345");

        // No stub carries the answer: the scan never reached the network.
        expect(h.statusEl.textContent).toBe(
          "Ticket looks valid. It will check in when you are back online.",
        );
        expect(storedQueue(h)).toHaveLength(1);
        expect(bannerText(h)).toBe(
          "Offline mode is on. Scans are queued and checked in when you are back online.",
        );
      },
    );
  });
});
