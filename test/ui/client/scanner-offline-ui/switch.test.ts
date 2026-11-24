/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
// test-groups: run-alone — the bundle runs inside happy-dom, whose internal
// task timers can outlive `happyDOM.abort()` under load; in a shared isolate a
// trailing timer fires during whichever suite runs next and fails its op
// sanitizer. Solo, it dies with the isolate — the proven-safe historical mode.

/** The offline mode switch: turning it on records the switch with the door,
 * downloads the door's list page by page with its progress, and only then
 * counts as on. Every test runs the real built bundle, so the words asserted
 * are the words the door reads. */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  whenStatusShows,
  whenStoreHolds,
} from "#test/ui/client/scanner/camera-fakes.ts";
import {
  el,
  MODE_KEY,
  SCAN_PATH,
  type ScannerHarness,
  useScannerSuite,
} from "#test/ui/client/scanner/fixture.ts";
import { askedUrls } from "#test/ui/client/scanner/offline-door.ts";
import { type FetchResponder, stubFetch } from "#test-utils/fetch-stub.ts";

const LIST_KEY = `scanner-tickets-${SCAN_PATH}`;
const OFFLINE_PATH = "/admin/groups/5/scan-offline";
const READY = "Offline mode is on. The ticket list is saved on this device.";
const FAILED =
  "The ticket list did not download. Check your connection, then try again.";

/** One cache page, as the door's cache endpoint answers it. */
const cachePage = (
  hash: string,
  next: number | null,
  people: number,
  total: number,
) => ({ entries: [{ hash, tickets: 1 }], next, people, total });

/** A list a device saved earlier, still fresh. */
const savedList = JSON.stringify({
  entries: [{ hash: "saved", tickets: 1 }],
  storedAt: Date.now(),
});

/** Answers the switch's record with the door's ok, and each cache page by
 * the cursor it asks for. A cursor with no page answers 500. */
const doorWith =
  (pages: Record<string, unknown>): FetchResponder =>
  (url) => {
    if (String(url) === OFFLINE_PATH) return Response.json({ status: "ok" });
    const after = new URL(String(url), "http://localhost").searchParams.get(
      "after",
    );
    const page = after === null ? undefined : pages[after];
    return page === undefined
      ? Response.json({}, { status: 500 })
      : Response.json(page);
  };

const progress = (h: ScannerHarness) =>
  el(h.document, "scanner-offline-progress");
const toggle = (h: ScannerHarness) => el(h.document, "scanner-offline-toggle");

describe("scanner offline switch", {
  sanitizeOps: false,
  sanitizeResources: false,
}, () => {
  const fresh = useScannerSuite();

  test("records the switch, downloads every page, then turns offline mode on", async () => {
    const secondPage = Promise.withResolvers<Response>();
    const fetchStub = stubFetch((url, init) =>
      String(url).endsWith("after=7")
        ? secondPage.promise
        : doorWith({ 0: cachePage("first", 7, 250, 251) })(url, init),
    );
    try {
      const h = fresh();
      toggle(h).click();

      // The first page is in and the second is still on its way: the door
      // sees how far the download got, and the switch is not on yet.
      await whenStatusShows(
        progress(h),
        "Downloading the ticket list (250 of 251 people)",
      );
      expect(progress(h).className).not.toContain("hidden");
      expect(toggle(h).getAttribute("aria-busy")).toBe("true");
      expect(h.window.localStorage.getItem(MODE_KEY)).toBe(null);
      expect(h.window.localStorage.getItem(LIST_KEY)).toBe(null);

      secondPage.resolve(Response.json(cachePage("second", null, 1, 251)));
      await whenStatusShows(h.statusEl, READY);

      expect(
        JSON.parse(String(h.window.localStorage.getItem(LIST_KEY))),
      ).toEqual({
        entries: [
          { hash: "first", tickets: 1 },
          { hash: "second", tickets: 1 },
        ],
        storedAt: expect.any(Number),
      });
      expect(h.window.localStorage.getItem(MODE_KEY)).toBe("1");
      expect(toggle(h).getAttribute("aria-pressed")).toBe("true");
      expect(toggle(h).getAttribute("aria-busy")).toBe(null);
      expect(progress(h).className).toContain("hidden");
      expect(el(h.document, "scanner-offline-banner-text").textContent).toBe(
        "Offline mode is on. Scans are queued and checked in when you are back online.",
      );
      // The record went first, carrying the page's token, then each page.
      expect(askedUrls(fetchStub)).toEqual([
        OFFLINE_PATH,
        `${SCAN_PATH}-cache?after=0`,
        `${SCAN_PATH}-cache?after=7`,
      ]);
      const recordHeaders = new Headers(fetchStub.calls[0]?.args[1]?.headers);
      expect(recordHeaders.get("x-csrf-token")).toBe("csrf-page-token");
    } finally {
      fetchStub.restore();
    }
  });

  test("shows no more people than the total when bookings land mid-download", async () => {
    using _fetch = stubFetch(
      doorWith({
        0: cachePage("first", 3, 2, 2),
        3: cachePage("second", null, 1, 2),
      }),
    );
    const h = fresh();
    toggle(h).click();
    await whenStatusShows(h.statusEl, READY);
    // Three people were read against a total of two: the last word stays
    // at the total.
    expect(progress(h).textContent).toBe(
      "Downloading the ticket list (2 of 2 people)",
    );
  });

  test("downloads nothing when the door does not record the switch", async () => {
    const fetchStub = stubFetch(() =>
      Response.json({ error: "Not authenticated" }, { status: 401 }),
    );
    try {
      const h = fresh();
      toggle(h).click();
      await whenStatusShows(h.statusEl, FAILED);
      expect(h.statusEl.className).toContain("scanner-status-error");
      expect(askedUrls(fetchStub)).toEqual([OFFLINE_PATH]);
      expect(h.window.localStorage.getItem(MODE_KEY)).toBe(null);
      expect(toggle(h).getAttribute("aria-pressed")).toBe("false");
    } finally {
      fetchStub.restore();
    }
  });

  test("keeps the saved list and leaves the switch off when a page fails", async () => {
    using _fetch = stubFetch(doorWith({ 0: cachePage("first", 7, 250, 251) }));
    const h = fresh({ seed: (store) => store.setItem(LIST_KEY, savedList) });
    toggle(h).click();
    await whenStatusShows(h.statusEl, FAILED);
    expect(h.window.localStorage.getItem(LIST_KEY)).toBe(savedList);
    expect(h.window.localStorage.getItem(MODE_KEY)).toBe(null);
    expect(progress(h).className).toContain("hidden");
  });

  test("stops the download and stores nothing when the switch is clicked again", async () => {
    const secondPage = Promise.withResolvers<Response>();
    using _fetch = stubFetch((url, init) =>
      String(url).endsWith("after=7")
        ? secondPage.promise
        : doorWith({ 0: cachePage("first", 7, 250, 251) })(url, init),
    );
    const h = fresh();
    toggle(h).click();
    await whenStatusShows(
      progress(h),
      "Downloading the ticket list (250 of 251 people)",
    );

    toggle(h).click();
    secondPage.resolve(Response.json(cachePage("second", null, 1, 251)));
    // The stopped download runs to its end over real turns, and the store
    // never takes its list.
    await expect(whenStoreHolds(h, LIST_KEY)).rejects.toThrow(
      `The store never held ${LIST_KEY}`,
    );

    expect(h.window.localStorage.getItem(LIST_KEY)).toBe(null);
    expect(h.window.localStorage.getItem(MODE_KEY)).toBe(null);
    expect(h.statusEl.textContent).not.toBe(FAILED);
    expect(h.statusEl.textContent).not.toBe(READY);
    expect(toggle(h).getAttribute("aria-busy")).toBe(null);
  });

  test("keeps the new download's progress when a stopped one ends after it starts", async () => {
    // The first download's second page and the new download's first page
    // both wait, so the stopped download ends while the new one still runs.
    const stoppedPage = Promise.withResolvers<Response>();
    const newPage = Promise.withResolvers<Response>();
    let firstPages = 0;
    using _fetch = stubFetch((url, init) => {
      if (String(url).endsWith("after=7")) return stoppedPage.promise;
      if (String(url).endsWith("after=0")) {
        firstPages += 1;
        if (firstPages === 2) return newPage.promise;
      }
      return doorWith({ 0: cachePage("first", 7, 250, 251) })(url, init);
    });
    const h = fresh();
    toggle(h).click();
    await whenStatusShows(
      progress(h),
      "Downloading the ticket list (250 of 251 people)",
    );
    toggle(h).click();
    toggle(h).click();
    expect(toggle(h).getAttribute("aria-busy")).toBe("true");

    // The stopped download runs to its end and must leave the new one's
    // progress on the page.
    stoppedPage.resolve(Response.json(cachePage("second", null, 1, 251)));
    await expect(whenStoreHolds(h, LIST_KEY)).rejects.toThrow(
      `The store never held ${LIST_KEY}`,
    );
    expect(toggle(h).getAttribute("aria-busy")).toBe("true");
    expect(progress(h).className).not.toContain("hidden");

    newPage.resolve(Response.json(cachePage("fresh", null, 1, 1)));
    await whenStatusShows(h.statusEl, READY);
    expect(
      JSON.parse(String(h.window.localStorage.getItem(LIST_KEY))).entries,
    ).toEqual([{ hash: "fresh", tickets: 1 }]);
    expect(toggle(h).getAttribute("aria-busy")).toBe(null);
  });

  test("deletes the saved list when the door turns offline mode off", async () => {
    using _fetch = stubFetch(new Error("offline"));
    const h = fresh({
      onLine: false,
      seed: (store) => {
        store.setItem(MODE_KEY, "1");
        store.setItem(LIST_KEY, savedList);
      },
    });
    toggle(h).click();
    expect(h.window.localStorage.getItem(MODE_KEY)).toBe(null);
    expect(h.window.localStorage.getItem(LIST_KEY)).toBe(null);
    expect(toggle(h).getAttribute("aria-pressed")).toBe("false");
  });

  test("downloads a fresh list on load while the switch is on, without a new record", async () => {
    const fetchStub = stubFetch(
      doorWith({ 0: cachePage("fresh", null, 1, 1) }),
    );
    try {
      const h = fresh({
        seed: (store) => {
          store.setItem(MODE_KEY, "1");
          store.setItem(LIST_KEY, savedList);
        },
      });
      await whenStatusShows(h.statusEl, READY);
      expect(
        JSON.parse(String(h.window.localStorage.getItem(LIST_KEY))).entries,
      ).toEqual([{ hash: "fresh", tickets: 1 }]);
      expect(askedUrls(fetchStub)).toEqual([`${SCAN_PATH}-cache?after=0`]);
    } finally {
      fetchStub.restore();
    }
  });

  test("keeps the switch on and the saved list when the load's download fails", async () => {
    using _fetch = stubFetch(doorWith({}));
    const h = fresh({
      seed: (store) => {
        store.setItem(MODE_KEY, "1");
        store.setItem(LIST_KEY, savedList);
      },
    });
    await whenStatusShows(h.statusEl, FAILED);
    expect(h.window.localStorage.getItem(MODE_KEY)).toBe("1");
    expect(h.window.localStorage.getItem(LIST_KEY)).toBe(savedList);
    expect(toggle(h).getAttribute("aria-pressed")).toBe("true");
  });

  test("downloads nothing on load while another door's switch is on", async () => {
    const fetchStub = stubFetch(doorWith({}));
    try {
      const h = fresh({
        seed: (store) =>
          store.setItem("scanner-offline-mode-/admin/listing/9/scan", "1"),
      });
      expect(askedUrls(fetchStub)).toEqual([]);
      expect(toggle(h).getAttribute("aria-pressed")).toBe("false");
      expect(el(h.document, "scanner-offline-banner").className).toContain(
        "hidden",
      );
    } finally {
      fetchStub.restore();
    }
  });

  test("drops the list and says so when the store refuses the switch", async () => {
    using _fetch = stubFetch(doorWith({ 0: cachePage("first", null, 1, 1) }));
    const h = fresh();
    // The store takes the list, then refuses the switch's own write.
    const stored = h.window.localStorage;
    h.stash.set(
      "localStorage",
      Object.create(stored, {
        setItem: {
          value: (key: string, value: string) => {
            if (key === MODE_KEY) throw new Error("The store is full");
            stored.setItem(key, value);
          },
        },
      }),
    );
    toggle(h).click();
    await whenStatusShows(
      h.statusEl,
      "Your change was not saved. Free up space on this device, then try again.",
    );
    expect(stored.getItem(LIST_KEY)).toBe(null);
    expect(stored.getItem(MODE_KEY)).toBe(null);
  });
});
