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
  drain,
  savedEntry,
  whenStatusShows,
} from "#test/ui/client/scanner/camera-fakes.ts";
import {
  cachePage,
  doorWith,
  doorWithHeldSecondPage,
  expectNoListStored,
  expectSwitchOff,
  FAILED,
  FIRST_PAGE,
  LIST_KEY,
  progress,
  READY,
  savedList,
  startDownload,
  startHeldDownload,
  storedEntries,
  storedList,
  switchOnWithList,
  toggle,
} from "#test/ui/client/scanner/download-door.ts";
import {
  el,
  fullStore,
  MODE_KEY,
  useScannerSuite,
} from "#test/ui/client/scanner/fixture.ts";
import { askedUrls } from "#test/ui/client/scanner/offline-door.ts";
import { stubFetch } from "#test-utils/fetch-stub.ts";

describe("scanner offline switch", {
  sanitizeOps: false,
  sanitizeResources: false,
}, () => {
  const fresh = useScannerSuite();

  test("records the switch, downloads every page, then turns offline mode on", async () => {
    // The first page is in and the second is still on its way: the door
    // sees how far the download got, and the switch is not on yet.
    const { fetchStub, h, secondPage } = await startHeldDownload(fresh);
    using _fetch = fetchStub;
    expect(progress(h).className).not.toContain("hidden");
    expect(toggle(h).getAttribute("aria-busy")).toBe("true");
    expectSwitchOff(h);
    expect(h.window.localStorage.getItem(LIST_KEY)).toBe(null);

    secondPage.resolve(Response.json(cachePage("second", null, 1, 251)));
    await whenStatusShows(h.statusEl, READY);

    expect(storedList(h)).toEqual({
      entries: [savedEntry("first"), savedEntry("second")],
      storedAt: expect.any(Number),
    });
    expect(h.window.localStorage.getItem(MODE_KEY)).toBe("1");
    expect(toggle(h).getAttribute("aria-pressed")).toBe("true");
    expect(toggle(h).getAttribute("aria-busy")).toBe(null);
    expect(progress(h).className).toContain("hidden");
    expect(el(h.document, "scanner-offline-banner-text").textContent).toBe(
      "Offline mode is on. Scans are queued and checked in when you are back online.",
    );
    // The first page asks with no cursor. Each later page asks with the
    // cursor the page before it named.
    expect(askedUrls(fetchStub)).toEqual([FIRST_PAGE, `${FIRST_PAGE}?from=c7`]);
  });

  test("shows no numbers until the first page answers", async () => {
    const firstPage = Promise.withResolvers<Response>();
    using _fetch = stubFetch(() => firstPage.promise);
    const h = fresh();
    toggle(h).click();
    await drain();

    // The wait reads as busy, not as an empty door: the numbers wait for
    // the page that carries them.
    expect(toggle(h).getAttribute("aria-busy")).toBe("true");
    expect(progress(h).className).toContain("hidden");
    expect(progress(h).textContent).toBe("");

    firstPage.resolve(Response.json(cachePage("first", null, 1, 1)));
    await whenStatusShows(
      progress(h),
      "Downloading the ticket list (1 of 1 people)",
    );
    await whenStatusShows(h.statusEl, READY);
  });

  test("shows no more people than the total when bookings land mid-download", async () => {
    using _fetch = stubFetch(
      doorWith({
        "": cachePage("first", "c3", 2, 2),
        c3: cachePage("second", null, 1, 2),
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

  test("leaves the switch off and asks for a reload when the door refuses the first page", async () => {
    using fetchStub = stubFetch(() =>
      Response.json({ error: "Not authenticated" }, { status: 401 }),
    );
    const h = fresh();
    toggle(h).click();
    await whenStatusShows(
      h.statusEl,
      "Something went wrong. Reload this page, then try again.",
    );
    expect(h.statusEl.className).toContain("scanner-status-error");
    expect(askedUrls(fetchStub)).toEqual([FIRST_PAGE]);
    expectSwitchOff(h);
  });

  test("keeps the saved list and leaves the switch off when the connection drops mid-download", async () => {
    using _fetch = stubFetch(
      Response.json(cachePage("first", "c7", 250, 251)),
      new Error("offline"),
    );
    const h = fresh({ seed: (store) => store.setItem(LIST_KEY, savedList) });
    toggle(h).click();
    await whenStatusShows(h.statusEl, FAILED);
    expect(h.window.localStorage.getItem(LIST_KEY)).toBe(savedList);
    expectSwitchOff(h);
    expect(progress(h).className).toContain("hidden");
  });

  test("stops the download and stores nothing when the switch is clicked again", async () => {
    const { fetchStub, h, secondPage } = await startHeldDownload(fresh);
    using _fetch = fetchStub;

    toggle(h).click();
    secondPage.resolve(Response.json(cachePage("second", null, 1, 251)));
    await expectNoListStored(h);

    expect(h.window.localStorage.getItem(LIST_KEY)).toBe(null);
    expectSwitchOff(h);
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
      if (String(url) === FIRST_PAGE) firstPages += 1;
      return firstPages === 2 && String(url) === FIRST_PAGE
        ? newPage.promise
        : doorWithHeldSecondPage(stoppedPage.promise)(url, init);
    });
    const h = fresh();
    await startDownload(h);
    toggle(h).click();
    toggle(h).click();
    expect(toggle(h).getAttribute("aria-busy")).toBe("true");

    // The stopped download runs to its end and must leave the new one's
    // progress on the page.
    stoppedPage.resolve(Response.json(cachePage("second", null, 1, 251)));
    await expectNoListStored(h);
    expect(toggle(h).getAttribute("aria-busy")).toBe("true");
    expect(progress(h).className).not.toContain("hidden");

    newPage.resolve(Response.json(cachePage("fresh", null, 1, 1)));
    await whenStatusShows(h.statusEl, READY);
    expect(storedEntries(h)).toEqual([savedEntry("fresh")]);
    expect(toggle(h).getAttribute("aria-busy")).toBe(null);
  });

  test("deletes the saved list when the door turns offline mode off", async () => {
    using _fetch = stubFetch(new Error("offline"));
    const h = fresh({
      onLine: false,
      seed: switchOnWithList,
    });
    toggle(h).click();
    expectSwitchOff(h);
    expect(h.window.localStorage.getItem(LIST_KEY)).toBe(null);
  });

  test("downloads a fresh list on load while the switch is on, without a new record", async () => {
    using fetchStub = stubFetch(
      doorWith({ "": cachePage("fresh", null, 1, 1) }),
    );
    const h = fresh({
      seed: switchOnWithList,
    });
    await whenStatusShows(h.statusEl, READY);
    expect(storedEntries(h)).toEqual([savedEntry("fresh")]);
    expect(askedUrls(fetchStub)).toEqual([FIRST_PAGE]);
  });

  test("keeps the switch on and the saved list when the load's download finds no connection", async () => {
    using _fetch = stubFetch(new Error("offline"));
    const h = fresh({
      seed: switchOnWithList,
    });
    await whenStatusShows(h.statusEl, FAILED);
    expect(h.window.localStorage.getItem(MODE_KEY)).toBe("1");
    expect(h.window.localStorage.getItem(LIST_KEY)).toBe(savedList);
    expect(toggle(h).getAttribute("aria-pressed")).toBe("true");
  });

  test("downloads nothing on load while another door's switch is on", async () => {
    using fetchStub = stubFetch(doorWith({}));
    const h = fresh({
      seed: (store) =>
        store.setItem("scanner-offline-mode-/admin/listing/9/scan", "1"),
    });
    expect(askedUrls(fetchStub)).toEqual([]);
    expect(toggle(h).getAttribute("aria-pressed")).toBe("false");
    expect(el(h.document, "scanner-offline-banner").className).toContain(
      "hidden",
    );
  });

  test("drops the list and says so when the store refuses the switch", async () => {
    using _fetch = stubFetch(doorWith({ "": cachePage("first", null, 1, 1) }));
    const h = fresh();
    // The store takes the list, then refuses the switch's own write.
    const stored = h.window.localStorage;
    h.stash.set(
      "localStorage",
      Object.create(stored, {
        setItem: {
          value: (key: string, value: string) => {
            if (key === MODE_KEY) {
              throw new DOMException("The store is full", "QuotaExceededError");
            }
            stored.setItem(key, value);
          },
        },
      }),
    );
    toggle(h).click();
    await whenStatusShows(
      h.statusEl,
      "The ticket list is too big to save on this device. Keep scanning online.",
    );
    expect(stored.getItem(LIST_KEY)).toBe(null);
    expect(stored.getItem(MODE_KEY)).toBe(null);
  });

  test("keeps the saved list when a refresh no longer fits the store", async () => {
    const firstPage = Promise.withResolvers<Response>();
    using _fetch = stubFetch(() => firstPage.promise);
    const h = fresh({ seed: switchOnWithList });

    // The store holds the door's mode and its saved list, then refuses every
    // write: the page-load refresh cannot replace the list the door keeps.
    fullStore(h);
    firstPage.resolve(Response.json(cachePage("fresh", null, 1, 251)));

    await whenStatusShows(
      h.statusEl,
      "The new ticket list is too big for this device. The saved list stays until it expires.",
    );
    expect(h.statusEl.className).toContain("scanner-status-warning");
    expect(h.window.localStorage.getItem(LIST_KEY)).toBe(savedList);
    expect(h.window.localStorage.getItem(MODE_KEY)).toBe("1");
    expect(toggle(h).getAttribute("aria-pressed")).toBe("true");
  });
});
