// test-groups: run-alone — the bundle runs inside happy-dom, whose internal
// task timers can outlive `happyDOM.abort()` under load; in a shared isolate
// a trailing timer fires during whichever suite runs next and fails its op
// sanitizer. Solo, it dies with the isolate — the proven-safe historical
// mode.

/**
 * The scanner's offline mode through the built bundle: the saved ticket
 * digests, the offline scan path, the queue, and the manual switch. The
 * pure store rules live in `scanner-door-store.test.ts`; the sync's
 * per-check-in story lives in `sync.test.ts`.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stubFetch } from "#test-utils/fetch-stub.ts";
import { useScannerSuite, whenTextShows } from "./scanner/fixture.ts";
import {
  checkedInReply,
  digestOf,
  dispatchScan,
  HASHES_KEY,
  hashesReply,
  lostAfterSend,
  MODE_KEY,
  pageWithWaitingCheckIn,
  queuedAndSendFailed,
  queueSavedTicket,
  quietReload,
  readQueue,
  recordedCheckIn,
  settle,
  settledDoor,
  whenListIs,
} from "./scanner/offline-fixture.ts";

describe("scanner offline mode", {
  sanitizeOps: false,
  sanitizeResources: false,
}, () => {
  const fresh = useScannerSuite();

  test("saves the door's ticket digests on load and replaces them whole", async () => {
    {
      using _fetch = stubFetch(await hashesReply("AAAA", "BBBB"));
      fresh();
      const saved = JSON.parse(await whenListIs(await digestOf("AAAA")));
      expect(saved.hashes).toEqual(
        [await digestOf("AAAA"), await digestOf("BBBB")].sort(),
      );
      expect(typeof saved.savedAt).toBe("number");
      // The credential itself never reaches the device's storage.
      expect(localStorage.getItem(HASHES_KEY)).not.toContain("AAAA");
      expect(localStorage.getItem(HASHES_KEY)).not.toContain("BBBB");
    }
    {
      using _reload = stubFetch(await hashesReply("CCCC"));
      fresh();
      const saved = JSON.parse(await whenListIs(await digestOf("CCCC")));
      expect(saved.hashes).toEqual([await digestOf("CCCC")]);
    }
  });

  test("a saved ticket scans offline and queues its check-in", async () => {
    using fetch = stubFetch(await hashesReply("AAAA", "BBBB"));
    const h = fresh();
    await settle();
    h.offline.toggle.click();
    expect(h.offline.banner.classList.contains("hidden")).toBe(false);
    expect(h.offline.toggle.textContent).toBe("Offline mode: on");

    await dispatchScan(h, "AAAA");
    expect(h.statusEl.textContent).toBe(
      "Saved ticket. The check-in will send when the connection is back.",
    );
    expect(h.statusEl.className).toContain("scanner-status-warning");
    expect(h.offline.queueLine.textContent).toBe("1 check-in waiting to send.");

    // The same ticket scanned again queues its own delivery: a party's
    // next arrival is another check-in, and the server answers one
    // delivery once. The scanner's own cooldown takes the double press
    // of one code.
    await dispatchScan(h, "AAAA");
    expect(h.offline.queueLine.textContent).toBe(
      "2 check-ins waiting to send.",
    );
    expect(fetch.calls.length).toBe(1);
  });

  test("an unknown ticket is refused offline", async () => {
    using _fetch = stubFetch(await hashesReply("AAAA"));
    const h = fresh();
    await settle();
    h.offline.toggle.click();

    await dispatchScan(h, "ZZZZ");
    expect(h.statusEl.textContent).toBe(
      "This ticket is not in the saved list. Go online to check it.",
    );
    expect(h.statusEl.className).toContain("scanner-status-error");
    expect(h.offline.queueLine.classList.contains("hidden")).toBe(true);
  });

  test("a scan with no usable saved list sends the door online to refresh", async () => {
    // A list saved 13 hours ago is past its 12 hours. The page loads from
    // the saved shell with no connection, so the refresh fails and the
    // expired list is what the door reads.
    localStorage.setItem(
      HASHES_KEY,
      JSON.stringify({
        hashes: [await digestOf("AAAA")],
        savedAt: Date.now() - 13 * 60 * 60 * 1000,
      }),
    );
    using _fetch = stubFetch(new Error("offline"));
    const h = fresh();
    await settle();
    h.offline.toggle.click();

    await dispatchScan(h, "AAAA");
    expect(h.statusEl.textContent).toBe(
      "The saved ticket list is out of date or missing. Go online and reload the page to refresh it.",
    );
    expect(h.statusEl.className).toContain("scanner-status-error");
    expect(localStorage.getItem(HASHES_KEY)).toBeNull();
    expect(h.offline.queueLine.classList.contains("hidden")).toBe(true);
  });

  test("a send that cannot land queues the check-in while offline mode is off", async () => {
    using _fetch = stubFetch(await hashesReply("AAAA"), new Error("offline"));
    const h = await settledDoor(fresh);
    // Offline mode is off: the door scans online first, and a send that
    // cannot land is accepted against the saved list and waits here.
    await dispatchScan(h, "AAAA");
    expect(h.statusEl.textContent).toBe(
      "Saved ticket. The check-in will send when the connection is back.",
    );
    // The queue holds the delivery, not just the digest: the id the device
    // minted rides with it, so every retry of this check-in claims the
    // same delivery on the server.
    const queued = readQueue();
    expect(queued).toEqual([
      {
        operationId: expect.any(String),
        queuedAt: expect.any(Number),
        tokenHash: await digestOf("AAAA"),
      },
    ]);
    expect(queued[0]?.operationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(h.offline.queueLine.textContent).toBe("1 check-in waiting to send.");
    expect(h.offline.banner.classList.contains("hidden")).toBe(true);
  });

  test("turning the switch off drains the queue exactly once", async () => {
    const posts: unknown[] = [];
    using fetch = stubFetch(await hashesReply("AAAA"), recordedCheckIn(posts));
    const h = fresh();
    await settle();
    h.offline.toggle.click();
    await dispatchScan(h, "AAAA");
    expect(h.offline.queueLine.textContent).toBe("1 check-in waiting to send.");

    h.offline.toggle.click();
    await whenTextShows(h.statusEl, "Ada checked in for Doors (1 ticket)");
    await settle();
    // The replay names the person by the stored digest, never the token,
    // and claims the queued delivery by the id the page gave it.
    expect(posts).toEqual([
      {
        operation_id: expect.any(String),
        token_hash: await digestOf("AAAA"),
      },
    ]);
    expect(h.offline.queueLine.classList.contains("hidden")).toBe(true);
    expect(fetch.calls.length).toBe(2);
  });

  test("a send that cannot land keeps its check-in queued and says so", async () => {
    using _fetch = stubFetch(await hashesReply("AAAA"), new Error("offline"));
    const h = await settledDoor(fresh);
    await queuedAndSendFailed(h);

    expect(h.statusEl.className).toContain("scanner-status-error");
    expect(h.offline.queueLine.textContent).toBe("1 check-in waiting to send.");
  });

  test("a body that is no scan answer never settles its check-in", async () => {
    using _fetch = stubFetch(
      await hashesReply("AAAA"),
      Response.json({ error: "Please sign in again" }),
    );
    const h = await settledDoor(fresh);

    // The replay reached a server whose answer is no door answer (a sign-in
    // page's JSON, a bare error envelope). The check-in did not land, so it
    // stays queued for the next run, and the page says so.
    await queuedAndSendFailed(h);
  });

  test("a page that loads with connectivity sends what it saved", async () => {
    await pageWithWaitingCheckIn(fresh);

    // The device reloads its page where the connection works: the load
    // fetches a fresh list, which proves the connection, and the waiting
    // check-in sends behind it.
    using _reload = stubFetch(await hashesReply("AAAA"), checkedInReply());
    const second = fresh();
    await whenTextShows(second.statusEl, "Ada checked in for Doors (1 ticket)");
    await settle();
    expect(second.offline.queueLine.classList.contains("hidden")).toBe(true);
  });

  test("a refresh that fails does not try to send the queue", async () => {
    await pageWithWaitingCheckIn(fresh);

    // The page loads where the saved list cannot refresh either. No list
    // arrived, so the connection is unproven and the queue stays quiet.
    await quietReload(fresh, new Error("offline"));
  });

  test("a tokens reply that is no list does not send the queue", async () => {
    await pageWithWaitingCheckIn(fresh);

    // The tokens endpoint answered, but with no list. That is no proof the
    // connection is back, so the queue waits.
    await quietReload(fresh, Response.json({ nope: 1 }));
  });

  test("a lost answer keeps the check-in queued until a retry lands it", async () => {
    const posts: unknown[] = [];
    using _fetch = stubFetch(
      await hashesReply("AAAA"),
      lostAfterSend(posts),
      recordedCheckIn(posts),
    );
    const h = await settledDoor(fresh);

    // First replay: the request reached the server, the answer was lost.
    // The check-in stays queued, because no answer settled it for good.
    const queued = await queuedAndSendFailed(h);

    // Second replay sends the same digest again, under the SAME delivery
    // id. The server claims that id once, so the retry admits nothing a
    // second time: the ticket cannot come in twice on a lost answer.
    h.offline.toggle.click();
    h.offline.toggle.click();
    await whenTextShows(h.statusEl, "Ada checked in for Doors (1 ticket)");
    await settle();
    const [first, retry] = posts as {
      token_hash: string;
      operation_id: string;
    }[];
    expect(first?.token_hash).toBe(await digestOf("AAAA"));
    expect(retry).toEqual({
      operation_id: queued[0]?.operationId,
      token_hash: await digestOf("AAAA"),
    });
    expect(readQueue()).toEqual([]);
  });

  test("a scan that lands sends the waiting check-ins", async () => {
    // The connection returns without an online event the browser noticed.
    // The next scan that lands proves the connection, so the queue sends
    // behind it.
    const posts: unknown[] = [];
    using _fetch = stubFetch(
      await hashesReply("AAAA"),
      new Error("offline"),
      recordedCheckIn(posts),
      recordedCheckIn(posts),
    );
    const h = await settledDoor(fresh);
    await dispatchScan(h, "AAAA");
    expect(h.offline.queueLine.textContent).toBe("1 check-in waiting to send.");

    await dispatchScan(h, "BBBB");
    await settle();
    expect(posts).toEqual([
      { token: "BBBB" },
      {
        operation_id: expect.any(String),
        token_hash: await digestOf("AAAA"),
      },
    ]);
    expect(h.offline.queueLine.classList.contains("hidden")).toBe(true);
  });

  test("the manual switch persists and reloads offline", async () => {
    using _fetch = stubFetch(await hashesReply("AAAA"));
    const first = fresh();
    await settle();
    // The storage probe the page runs on load cleans up after itself: no
    // scratch key stays behind in the device's storage.
    expect(localStorage.getItem("scanner:probe")).toBeNull();
    first.offline.toggle.click();
    expect(first.offline.toggle.textContent).toBe("Offline mode: on");
    expect(first.offline.toggle.getAttribute("aria-pressed")).toBe("true");
    expect(localStorage.getItem(MODE_KEY)).toBe("on");

    const second = fresh();
    await settle();
    expect(second.offline.toggle.textContent).toBe("Offline mode: on");
    expect(second.offline.banner.classList.contains("hidden")).toBe(false);

    second.offline.toggle.click();
    expect(second.offline.toggle.textContent).toBe("Offline mode: off");
    expect(second.offline.banner.classList.contains("hidden")).toBe(true);
    expect(localStorage.getItem(MODE_KEY)).toBeNull();
  });

  test("the waiting queue survives a page reload", async () => {
    {
      using _fetch = stubFetch(await hashesReply("AAAA"));
      const first = await settledDoor(fresh);
      await queueSavedTicket(first, "AAAA");
    }
    {
      using _reload = stubFetch(await hashesReply("AAAA"));
      const second = fresh();
      await settle();
      expect(second.offline.queueLine.textContent).toBe(
        "1 check-in waiting to send.",
      );
    }
  });

  test("the connection coming back sends the waiting check-ins", async () => {
    // The online event refreshes the saved list and replays the queue, so
    // the stub answers both fetches.
    using _fetch = stubFetch(
      await hashesReply("AAAA"),
      await hashesReply("AAAA"),
      checkedInReply(),
    );
    const h = await settledDoor(fresh);
    await queueSavedTicket(h, "AAAA");
    expect(h.offline.queueLine.textContent).toBe("1 check-in waiting to send.");

    h.window.dispatchEvent(new h.window.Event("online"));
    await whenTextShows(h.statusEl, "Ada checked in for Doors (1 ticket)");
    await settle();
    expect(h.offline.queueLine.classList.contains("hidden")).toBe(true);
    // The door still works offline-first while the switch is on.
    expect(h.offline.banner.classList.contains("hidden")).toBe(false);
  });
});
