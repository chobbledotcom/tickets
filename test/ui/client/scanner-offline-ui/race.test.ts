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

// jscpd:ignore-start -- imports
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { hmacHex } from "#shared/sha256.ts";
import {
  type CameraFakes,
  cameraFakes,
  drain,
  scanFirst,
  scanNext,
  seedTicketCache,
  start,
  whenStatusShows,
  whenStoreHolds,
  withEmptyCache,
} from "#test/ui/client/scanner/camera-fakes.ts";
import {
  DOOR_KEY,
  el,
  queuedItem,
  SCAN_PATH,
  type ScannerHarness,
  storedQueue,
  TOKEN,
  useScannerSuite,
  whenTextShows,
} from "#test/ui/client/scanner/fixture.ts";
import {
  askedUrls,
  digestOf,
  expectOneStoredCheckIn,
  expectSyncSettled,
  firstRow,
  postedDeliveryHashes,
  queuedItems,
  queueSeeded,
  rowWords,
  settledCheckIn,
} from "#test/ui/client/scanner/offline-door.ts";
import { stubFetch } from "#test-utils/fetch-stub.ts";

// jscpd:ignore-end

/** The held ticket digest: release opens the gate, and disposing restores
 * the platform's own sign. */
interface HeldTicketDigest {
  release: () => void;
  [Symbol.dispose]: () => void;
}

/** Holds the platform's ticket digest until the test opens the gate: the
 * scan's hmac then waits mid-flight, the way a slow device digests. Compute
 * every seed digest before the hold starts, or the seed waits on it too. */
const holdTicketDigest = (): HeldTicketDigest => {
  const gate = Promise.withResolvers<void>();
  const realSign = globalThis.crypto.subtle.sign.bind(globalThis.crypto.subtle);
  globalThis.crypto.subtle.sign = (async (
    algorithm: AlgorithmIdentifier,
    key: CryptoKey,
    data: BufferSource,
  ) => {
    await gate.promise;
    return realSign(algorithm, key, data);
  }) as typeof globalThis.crypto.subtle.sign;
  return {
    release: (): void => gate.resolve(),
    [Symbol.dispose]: (): void => {
      globalThis.crypto.subtle.sign = realSign;
    },
  };
};

/** Seeds the door's cache with the token's digest, holds the platform's
 * digest so the scan waits mid-hmac, opens the camera, and decodes the
 * token once. The scan waits on the gate the test opens. */
const scanWaitingOnDigest = async (
  h: ScannerHarness,
  fakes: CameraFakes,
  token: string,
): Promise<HeldTicketDigest> => {
  await seedTicketCache(h, token, Date.now());
  const digest = holdTicketDigest();
  await start(h);
  await scanFirst(fakes, token);
  return digest;
};

describe("scanner offline races", {
  sanitizeOps: false,
  sanitizeResources: false,
}, () => {
  const fresh = useScannerSuite();

  /** Drops and restores the connection the way the browser hands the state
   * and its event over. */
  const reconnect = (h: ScannerHarness): void => {
    h.stash.set("navigator", { onLine: false });
    h.window.dispatchEvent(new h.window.Event("offline"));
    h.stash.set("navigator", { onLine: true });
    h.window.dispatchEvent(new h.window.Event("online"));
  };

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

  test("retries the queue when the connection returns during a sync", async () => {
    // The page-load sync waits on the door's answer. The connection drops
    // and returns while that answer is still pending, so the online ask
    // arrives mid-run: it must not die with the run it interrupted.
    const dropped = Promise.withResolvers<Response>();
    let posts = 0;
    const fetchStub = stubFetch(
      withEmptyCache(() => {
        posts += 1;
        return posts === 1 ? dropped.promise : settledCheckIn();
      }),
    );
    try {
      const h = fresh(queueSeeded());

      reconnect(h);

      // The run's own answer dies with the connection, and the ask the
      // returning connection made now settles the queue.
      dropped.reject(new Error("connection dropped"));
      await expectSyncSettled(h, whenTextShows, fetchStub, [TOKEN, TOKEN]);
      expect(firstRow(h).textContent).toBe("Checked in");
    } finally {
      fetchStub.restore();
    }
  });

  test("replays only the check-ins still queued when the sync re-runs", async () => {
    // The first check-in settles and the second's answer dies with the
    // connection. The online ask that lands mid-run schedules a re-run,
    // and the re-run walks the rows the first run rendered: a row the
    // first run settled must not replay its check-in.
    const dropped = Promise.withResolvers<Response>();
    const firstDigest = await digestOf("tok1");
    let firstPosts = 0;
    let secondPosts = 0;
    const fetchStub = stubFetch(
      withEmptyCache((_url, init) => {
        const { token_hash } = JSON.parse(String(init?.body));
        if (token_hash === firstDigest) {
          firstPosts += 1;
          // The door's guard reads a replayed check-in as one it already
          // counted, the way it answers the page's own replay.
          return firstPosts === 1
            ? settledCheckIn()
            : Response.json({ name: "Ada", status: "already_checked_in" });
        }
        secondPosts += 1;
        return secondPosts === 1 ? dropped.promise : settledCheckIn();
      }),
    );
    try {
      const seed = await queuedItems(["tok1", "tok2"]);
      const h = fresh({
        seed: (store) => store.setItem("scanner-queue", seed),
      });

      reconnect(h);

      // The run's own answer dies with the connection, and the ask the
      // returning connection made settles only what is still queued.
      dropped.reject(new Error("connection dropped"));
      await expectSyncSettled(h, whenTextShows, fetchStub, [
        "tok1",
        "tok2",
        "tok2",
      ]);
      // The settled row keeps the answer the page's own check-in got.
      expect(rowWords(h)).toEqual(["Checked in", "Checked in"]);
    } finally {
      fetchStub.restore();
    }
  });

  test("settles a scan queued while the sync is already running", async () => {
    // The sync waits on the queued check-in's answer, and the scan's digest
    // waits on the platform's crypto. Both gates stage the reachable order:
    // the sync starts while the scan is still digesting its token.
    const answerGate = Promise.withResolvers<void>();
    const fetchStub = stubFetch(
      withEmptyCache(async () => {
        await answerGate.promise;
        return settledCheckIn();
      }),
    );
    try {
      const h = fresh({
        onLine: false,
        seed: (store) =>
          store.setItem("scanner-queue", JSON.stringify([queuedItem])),
      });
      using fakes = cameraFakes(h);
      fakes.ready(4);
      // The scan's own token, not the queued one: the queue refuses a
      // ticket it already holds.
      const scanToken = "tokB67890";
      using digest = await scanWaitingOnDigest(h, fakes, scanToken);

      // The connection returns and the sync starts while the scan is still
      // digesting. The digest then comes back, and the new check-in must
      // join the rows the running sync settles instead of a rebuild that
      // detaches them.
      h.stash.set("navigator", { onLine: true });
      h.window.dispatchEvent(new h.window.Event("online"));
      digest.release();
      await whenStatusShows(
        h.statusEl,
        "Ticket looks valid. It will be checked in when you are back online.",
      );
      answerGate.resolve();

      // The running sync settles the queued check-in and the new one: both
      // rows read their answer, the store empties, and the panel agrees.
      await expectSyncSettled(h, whenStatusShows, fetchStub, [
        TOKEN,
        scanToken,
      ]);
      expect(rowWords(h)).toEqual(["Checked in", "Checked in"]);
    } finally {
      fetchStub.restore();
    }
  });
});
