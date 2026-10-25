/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
// test-groups: run-alone — the bundle runs inside happy-dom, whose internal
// task timers can outlive `happyDOM.abort()` under load; in a shared isolate a
// trailing timer fires during whichever suite runs next and fails its op
// sanitizer. Solo, it dies with the isolate — the proven-safe historical mode.

/**
 * The queue's sync: the replay that settles every queued check-in once the
 * connection is back, and the words each settled row carries. Every test
 * drives the real built bundle, so the words asserted are the words the door
 * reads.
 */

// jscpd:ignore-start -- imports
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  cameraFakes,
  scanFirst,
  start,
  whenStatusShows,
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
  whenMessageShows,
  whenTextShows,
} from "#test/ui/client/scanner/fixture.ts";
import {
  digestOf,
  expectSyncSettled,
  firstRow,
  postedDeliveryHashes,
  queuedItems,
  queueSeeded,
  rowWords,
  settledCheckIn,
} from "#test/ui/client/scanner/offline-door.ts";
import { type FetchResponder, stubFetch } from "#test-utils/fetch-stub.ts";

// jscpd:ignore-end

describe("scanner offline sync", {
  sanitizeOps: false,
  sanitizeResources: false,
}, () => {
  const fresh = useScannerSuite();

  /** What one unsettled replay leaves: the still-queued warning, the row's
   * words, and the check-in back in the store. */
  const expectStillQueued = async (h: ScannerHarness): Promise<void> => {
    await whenTextShows(
      h.statusEl,
      "Some tickets are still queued. The page will try to check them in again.",
    );
    expect(h.statusEl.className).toContain("scanner-status-warning");
    expect(firstRow(h).textContent).toBe("Not sent yet — still queued");
    expect(storedQueue(h)).toBe(JSON.stringify([queuedItem]));
  };

  /** Answers each replayed delivery with the answer its queued ticket maps
   * to, and the page's cache refresh with an empty list. The delivery names
   * its ticket by the digest it stored. */
  const answerEachToken = async (
    answers: Record<string, Record<string, unknown>>,
  ): Promise<FetchResponder> => {
    const byDigest = new Map(
      await Promise.all(
        Object.entries(answers).map(
          async ([token, answer]) => [await digestOf(token), answer] as const,
        ),
      ),
    );
    return withEmptyCache((_url, init) => {
      const { token_hash } = JSON.parse(String(init?.body));
      const answer = byDigest.get(token_hash);
      if (!answer) throw new Error(`No answer staged for ${token_hash}`);
      return Response.json(answer);
    });
  };

  test("settles a queued check-in on the next page load", async () => {
    const fetchStub = stubFetch(settledCheckIn);
    try {
      const h = fresh(queueSeeded());
      const summary = el(h.document, "scanner-queue-summary");
      await whenTextShows(summary, "0 queued check-ins");

      // The replay carried the queued delivery to the door it was scanned
      // at: the digest it stored, the delivery id it answers by, and the
      // person it admits.
      const scanCall = fetchStub.calls.find(
        (call) => String(call.args[0]) === SCAN_PATH,
      );
      expect(scanCall).toBeDefined();
      expect(JSON.parse(String(scanCall?.args[1]?.body))).toEqual({
        operation_id: queuedItem.operationId,
        quantity: 1,
        token_hash: queuedItem.tokenHash,
      });
      expect(storedQueue(h)).toBe("[]");
      expect(firstRow(h).textContent).toBe("Checked in");
    } finally {
      fetchStub.restore();
    }
  });

  test("settles the queue when the door turns offline mode off", async () => {
    using _fetch = stubFetch(settledCheckIn);
    const h = fresh({
      seed: (store) => store.setItem("scanner-offline-mode", "1"),
    });
    // The scan queued while the switch was on; the page load's sync ran
    // against an empty queue, so the switch's own disarm does the settling.
    h.window.localStorage.setItem(
      "scanner-queue",
      JSON.stringify([queuedItem]),
    );

    el(h.document, "scanner-offline-toggle").click();

    await whenTextShows(h.statusEl, "Queued tickets are done.");
    expect(storedQueue(h)).toBe("[]");
    expect(firstRow(h).textContent).toBe("Checked in");
    // The switch disarmed: the store holds no mode and the banner is gone.
    expect(h.window.localStorage.getItem("scanner-offline-mode")).toBe(null);
    expect(el(h.document, "scanner-offline-banner").className).toContain(
      "hidden",
    );
  });

  test("keeps the switch on and says so when the store refuses the change", async () => {
    using _fetch = stubFetch(new Error("offline"));
    const h = fresh({
      onLine: false,
      seed: (store) => store.setItem("scanner-offline-mode", "1"),
    });

    // The store refuses the removal: the switch stays armed, and the page
    // says why nothing changed.
    fullStore(h);
    el(h.document, "scanner-offline-toggle").click();

    await whenTextShows(
      h.statusEl,
      "Your change was not saved. Free up space on this device, then try again.",
    );
    expect(h.statusEl.className).toContain("scanner-status-error");
    // The armed switch keeps its position: the mode stays stored, the
    // banner stays up, and the switch reads as pressed.
    expect(h.window.localStorage.getItem("scanner-offline-mode")).toBe("1");
    expect(el(h.document, "scanner-offline-banner").className).not.toContain(
      "hidden",
    );
    expect(
      el(h.document, "scanner-offline-toggle").getAttribute("aria-pressed"),
    ).toBe("true");
  });

  test("keeps a check-in the door did not answer and says so", async () => {
    using _fetch = stubFetch(new Error("offline"));
    const h = fresh(queueSeeded());

    await expectStillQueued(h);
  });

  test("keeps a check-in the door refused to settle and says so", async () => {
    using _fetch = stubFetch(() =>
      Response.json({ error: "Not authenticated" }, { status: 401 }),
    );
    const h = fresh(queueSeeded());

    // The refusal names no scan decision: the page keeps the check-in for
    // the sync that runs after the door lets it in again.
    await expectStillQueued(h);
  });

  test("keeps the settled row on the page when the switch is clicked mid-sync", async () => {
    const { promise, resolve } = Promise.withResolvers<Response>();
    using _fetch = stubFetch((url) => {
      if (String(url).endsWith("-cache")) {
        return Response.json({ hashes: [] });
      }
      return promise;
    });
    const h = fresh(queueSeeded());

    // The sync is waiting on the door's answer. The switch's re-render must
    // leave the row elements the sync writes to on the page.
    el(h.document, "scanner-offline-toggle").click();
    resolve(
      Response.json({
        listingName: "Standard",
        name: "Ada",
        quantity: 1,
        status: "checked_in",
        total: 1,
      }),
    );

    await whenTextShows(h.statusEl, "Queued tickets are done.");
    expect(firstRow(h).textContent).toBe("Checked in");
    expect(storedQueue(h)).toBe("[]");
  });

  test("stops the sync and names the store when a settled check-in will not save", async () => {
    using _fetch = stubFetch(settledCheckIn);
    const h = fresh(queueSeeded());
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
    const h = fresh(queueSeeded());
    using fakes = cameraFakes(h);
    fakes.ready(4);
    await start(h);
    await scanFirst(fakes, TOKEN);

    expect(h.statusEl.textContent).toBe(
      "Checking in queued tickets. Scan again when done.",
    );
    expect(h.statusEl.className).toContain("scanner-status-warning");
  });

  test("shows each settled answer on its own row", async () => {
    const seed = await queuedItems(["tok1", "tok2", "tok3"]);
    const fetchStub = stubFetch(
      await answerEachToken({
        tok1: {
          listingName: "Standard",
          name: "Ada",
          quantity: 1,
          status: "already_checked_in",
          total: 1,
        },
        tok2: { name: "Ada", status: "refunded" },
        tok3: { status: "not_found" },
      }),
    );
    try {
      const h = fresh({
        seed: (store) => store.setItem("scanner-queue", seed),
      });
      await expectSyncSettled(h, whenTextShows, fetchStub, [
        "tok1",
        "tok2",
        "tok3",
      ]);

      // Each row carries its own answer's words, oldest queue item first.
      expect(rowWords(h)).toEqual([
        "Was already checked in",
        "Refunded — not checked in",
        "Ticket not found",
      ]);
    } finally {
      fetchStub.restore();
    }
  });

  test("rides the ID check on the same delivery and answers once", async () => {
    // A non-transferable listing asks for an ID check before it admits. The
    // door makes the check now, and the answer rides the very delivery the
    // check-in queued — the server records one delivery either way.
    const fetchStub = stubFetch(
      withEmptyCache((_url, init) => {
        const { id_verified } = JSON.parse(String(init?.body));
        return id_verified
          ? Response.json({
              listingName: "Standard",
              name: "Ada",
              quantity: 1,
              status: "checked_in",
              total: 1,
            })
          : Response.json({
              listingName: "Standard",
              name: "Ada",
              status: "verify_id",
            });
      }),
    );
    using _fetch = fetchStub;
    const h = fresh(queueSeeded());

    await whenMessageShows(h, 'Does their ID match "Ada"?');
    h.confirm.yes.click();

    // The second post and the settled row ride the platform's own promise
    // turns, so the wait hops real event-loop turns. Both posts carried the
    // one delivery's digest.
    await expectSyncSettled(h, whenStatusShows, fetchStub, [TOKEN, TOKEN]);
    expect(firstRow(h).textContent).toBe("Checked in");
    // Two posts went out for one delivery: the ask, then the answer that
    // rides it — each naming the same digest and the same delivery id.
    const bodies = fetchStub.calls
      .filter((call) => String(call.args[0]) === SCAN_PATH)
      .map((call) => JSON.parse(String(call.args[1]?.body)));
    expect(bodies).toEqual([
      {
        operation_id: queuedItem.operationId,
        quantity: 1,
        token_hash: queuedItem.tokenHash,
      },
      {
        id_verified: true,
        operation_id: queuedItem.operationId,
        quantity: 1,
        token_hash: queuedItem.tokenHash,
      },
    ]);
  });

  test("reports an ID check the door declined on its row", async () => {
    const fetchStub = stubFetch(
      await answerEachToken({
        [TOKEN]: {
          listingName: "Standard",
          name: "Ada",
          status: "verify_id",
        },
      }),
    );
    using _fetch = fetchStub;
    const h = fresh(queueSeeded());

    await whenMessageShows(h, 'Does their ID match "Ada"?');
    h.confirm.no.click();

    await expectSyncSettled(h, whenStatusShows, fetchStub, [TOKEN]);
    expect(firstRow(h).textContent).toBe("Not checked in");
    // A declined ask is the end: the answer that names the mismatch went
    // out once, and no second post followed it.
    expect(
      fetchStub.calls.filter((call) => String(call.args[0]) === SCAN_PATH)
        .length,
    ).toBe(1);
  });

  test("alerts the door when the booking could not supply the pick", async () => {
    // Two offline devices can each name more than is left. The delivery
    // that lands second admits what is left, and its answer says the
    // numbers: the row alerts, and the store drops the settled item.
    const fetchStub = stubFetch(
      await answerEachToken({
        [TOKEN]: {
          listingName: "Standard",
          name: "Ada",
          overAdmission: { admitted: 1, bought: 4, named: 3 },
          quantity: 1,
          status: "checked_in",
          total: 4,
        },
      }),
    );
    using _fetch = fetchStub;
    const seed = await queuedItems([TOKEN]);
    const h = fresh({
      seed: (store) => store.setItem("scanner-queue", seed),
    });

    await expectSyncSettled(h, whenStatusShows, fetchStub, [TOKEN]);
    expect(rowWords(h)).toEqual([
      "Alert: Ada — this check-in was for 3, but the booking only had 1 left. The booking holds 4 in total.",
    ]);
    // The alert row stands out among the settled rows.
    expect(firstRow(h).className).toBe("scanner-queue-alert");
  });

  test("sends nothing for a check-in past the door's replay window", async () => {
    // The server keeps one delivery's replay record for the window the page
    // carries. Past it a resend cannot be told from a first send, so the
    // page sends nothing, drops the check-in, and tells the door to scan
    // the ticket again. The check-in beside it is still inside the window,
    // and the door sends it.
    const stale = {
      ...queuedItem,
      operationId: "018f3c2e-1b7d-7f31-9d4a-2f5c8e6a9b90",
      queuedAt: Date.now() - 8 * 24 * 60 * 60 * 1000,
    };
    const fetchStub = stubFetch(
      await answerEachToken({
        [TOKEN]: {
          listingName: "Standard",
          name: "Ada",
          quantity: 1,
          status: "checked_in",
          total: 1,
        },
      }),
    );
    try {
      const h = fresh({
        seed: (store) =>
          store.setItem("scanner-queue", JSON.stringify([stale, queuedItem])),
      });

      await whenTextShows(h.statusEl, "Queued tickets are done.");
      // The stale row's words tell the door what to do; the fresh row
      // carries its answer. The store holds neither.
      expect(rowWords(h)).toEqual([
        "This queued check-in is too old to send. Scan the ticket again while you are online.",
        "Checked in",
      ]);
      expect(storedQueue(h)).toBe("[]");
      // One delivery left the page: the fresh check-in's own.
      expect(postedDeliveryHashes(fetchStub)).toEqual([await digestOf(TOKEN)]);
    } finally {
      fetchStub.restore();
    }
  });
});
