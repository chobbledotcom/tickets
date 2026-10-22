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

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { type FetchResponder, stubFetch } from "#test-utils/fetch-stub.ts";
import { cameraFakes, scanFirst, start } from "./camera-fakes.ts";
import {
  el,
  fullStore,
  queuedItem,
  SCAN_PATH,
  type ScannerGlobals,
  type ScannerHarness,
  storedQueue,
  TOKEN,
  useScannerSuite,
  whenMessageShows,
  whenTextShows,
} from "./fixture.ts";

describe("scanner offline sync", {
  sanitizeOps: false,
  sanitizeResources: false,
}, () => {
  const fresh = useScannerSuite();

  /** The queue panel's first row, which every sync test's page carries. */
  const firstRow = (h: ScannerHarness): Element => {
    const row = el(h.document, "scanner-queue-items").children[0];
    if (!row) throw new Error("The queue panel carries no first row");
    return row;
  };

  /** Every row the queue panel carries, as the words it shows. */
  const rowWords = (h: ScannerHarness): (string | null)[] =>
    [...el(h.document, "scanner-queue-items").children].map(
      (row) => row.textContent,
    );

  /** The page globals one queued check-in seeds, for the tests that replay
   * the queue. */
  const queueSeeded = (): ScannerGlobals => ({
    seed: (store) =>
      store.setItem("scanner-queue", JSON.stringify([queuedItem])),
  });

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

  /** The queued check-ins one reload settles, oldest first. */
  const queuedItems = (tokens: string[]): string =>
    JSON.stringify(
      tokens.map((token, index) => ({
        queuedAt: index + 1,
        scanPath: SCAN_PATH,
        token,
      })),
    );

  /** The door's answer one settled queue replay gets. A fresh response per
   * call: the page load's cache refresh consumes the first one's body, and a
   * reused body would fail the replay's read. */
  const settledCheckIn = (): Response =>
    Response.json({
      listingName: "Standard",
      name: "Ada",
      quantity: 1,
      status: "checked_in",
      total: 1,
    });

  /** Answers each replayed check-in with the answer its queued token maps
   * to, and the page's cache refresh with an empty list. */
  const answerEachToken =
    (answers: Record<string, Record<string, unknown>>): FetchResponder =>
    (url, init) => {
      if (String(url).endsWith("-cache")) {
        return Response.json({ hashes: [] });
      }
      const { token } = JSON.parse(String(init?.body));
      const answer = answers[token];
      if (!answer) throw new Error(`No answer staged for ${token}`);
      return Response.json(answer);
    };

  test("settles a queued check-in on the next page load", async () => {
    const fetchStub = stubFetch(settledCheckIn);
    try {
      const h = fresh(queueSeeded());
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
    const fetchStub = stubFetch(
      answerEachToken({
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
        seed: (store) =>
          store.setItem("scanner-queue", queuedItems(["tok1", "tok2", "tok3"])),
      });
      await whenTextShows(h.statusEl, "Queued tickets are done.");

      // Each row carries its own answer's words, oldest queue item first.
      expect(rowWords(h)).toEqual([
        "Was already checked in",
        "Refunded — not checked in",
        "Ticket not found",
      ]);
      expect(storedQueue(h)).toBe("[]");
      expect(el(h.document, "scanner-queue-summary").textContent).toBe(
        "0 queued check-ins",
      );
      // The replay sent each queued ticket to the door it was scanned at.
      expect(
        fetchStub.calls
          .filter((call) => String(call.args[0]) === SCAN_PATH)
          .map((call) => JSON.parse(String(call.args[1]?.body)).token),
      ).toEqual(["tok1", "tok2", "tok3"]);
    } finally {
      fetchStub.restore();
    }
  });

  test("reports each ask the door declined on its row", async () => {
    const fetchStub = stubFetch(
      answerEachToken({
        tok1: { listingName: "Standard", name: "Ada", status: "wrong_listing" },
        tok2: { name: "Ada", status: "verify_id" },
        tok3: { max: 3, name: "Ada", status: "select_quantity" },
      }),
    );
    using _fetch = fetchStub;
    const h = fresh({
      seed: (store) =>
        store.setItem("scanner-queue", queuedItems(["tok1", "tok2", "tok3"])),
    });

    // The replay meets each ask in its turn, and the door declines all
    // three: nobody is checked in.
    await whenMessageShows(
      h,
      'Ada is registered for "Standard", not this listing. Check in anyway?',
    );
    h.confirm.no.click();
    await whenMessageShows(h, 'Does their ID match "Ada"?');
    h.confirm.no.click();
    await whenTextShows(
      el(h.document, "scanner-quantity-message"),
      "How many tickets for Ada?",
    );
    el(h.document, "scanner-quantity-cancel").click();

    await whenTextShows(h.statusEl, "Queued tickets are done.");
    expect(rowWords(h)).toEqual([
      "This ticket has no door to check in at.",
      "Not checked in",
      "Not checked in",
    ]);
    expect(storedQueue(h)).toBe("[]");
    // A declined ask is the end: no re-scan went out for any of them.
    expect(
      fetchStub.calls.filter((call) => String(call.args[0]) === SCAN_PATH)
        .length,
    ).toBe(3);
  });
});
