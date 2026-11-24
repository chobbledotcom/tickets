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
/** The first page's address: a request with no cursor. */
const FIRST_PAGE = `${SCAN_PATH}-cache`;
const READY = "Offline mode is on. The ticket list is saved on this device.";
const FAILED =
  "The ticket list did not download. Check your connection, then try again.";

/** One cache page, as the door's cache endpoint answers it. */
const cachePage = (
  hash: string,
  next: string | null,
  people: number,
  total: number,
) => ({ entries: [{ hash, tickets: 1 }], next, people, total });

/** A list a device saved earlier, still fresh. */
const savedList = JSON.stringify({
  entries: [{ hash: "saved", tickets: 1 }],
  storedAt: Date.now(),
});

/** Answers each cache page by the cursor it asks for. The first page asks
 * for none, and its key is "". A cursor with no page answers 500. */
const doorWith =
  (pages: Record<string, unknown>): FetchResponder =>
  (url) => {
    const from =
      new URL(String(url), "http://localhost").searchParams.get("from") ?? "";
    const page = pages[from];
    return page === undefined
      ? Response.json({}, { status: 500 })
      : Response.json(page);
  };

const progress = (h: ScannerHarness) =>
  el(h.document, "scanner-offline-progress");
const toggle = (h: ScannerHarness) => el(h.document, "scanner-offline-toggle");

/** A door whose first cache page answers at once and whose second page
 * waits for `held`. */
const doorWithHeldSecondPage =
  (held: Promise<Response>): FetchResponder =>
  (url, init) =>
    String(url).endsWith("from=c7")
      ? held
      : doorWith({ "": cachePage("first", "c7", 250, 251) })(url, init);

/** Turn the switch on and wait until the first page of 250 people is in. */
const startDownload = async (h: ScannerHarness): Promise<void> => {
  toggle(h).click();
  await whenStatusShows(
    progress(h),
    "Downloading the ticket list (250 of 251 people)",
  );
};

/** Start a download whose second page waits for `secondPage`. The caller
 * disposes the returned fetch stub. */
const startHeldDownload = async (fresh: () => ScannerHarness) => {
  const secondPage = Promise.withResolvers<Response>();
  const fetchStub = stubFetch(doorWithHeldSecondPage(secondPage.promise));
  const h = fresh();
  await startDownload(h);
  return { fetchStub, h, secondPage };
};

/** The switch is off: nothing stored for it, and it reads as not pressed. */
const expectSwitchOff = (h: ScannerHarness): void => {
  expect(h.window.localStorage.getItem(MODE_KEY)).toBe(null);
  expect(toggle(h).getAttribute("aria-pressed")).toBe("false");
};

/** Hop real turns until a stopped download ends, and prove the store never
 * took its list. */
const expectNoListStored = async (h: ScannerHarness): Promise<void> => {
  await expect(whenStoreHolds(h, LIST_KEY)).rejects.toThrow(
    `The store never held ${LIST_KEY}`,
  );
};

/** The list the store holds, as the page wrote it. */
const storedList = (h: ScannerHarness): { entries: unknown } =>
  JSON.parse(String(h.window.localStorage.getItem(LIST_KEY)));

/** The entries of the list the store holds. */
const storedEntries = (h: ScannerHarness): unknown => storedList(h).entries;

/** A device whose switch is on and whose saved list is still fresh. */
const switchOnWithList = (store: Storage): void => {
  store.setItem(MODE_KEY, "1");
  store.setItem(LIST_KEY, savedList);
};

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
    // The first page asks with no cursor. Each later page asks with the
    // cursor the page before it named.
    expect(askedUrls(fetchStub)).toEqual([FIRST_PAGE, `${FIRST_PAGE}?from=c7`]);
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

  test("leaves the switch off when the door refuses the first page", async () => {
    using fetchStub = stubFetch(() =>
      Response.json({ error: "Not authenticated" }, { status: 401 }),
    );
    const h = fresh();
    toggle(h).click();
    await whenStatusShows(h.statusEl, FAILED);
    expect(h.statusEl.className).toContain("scanner-status-error");
    expect(askedUrls(fetchStub)).toEqual([FIRST_PAGE]);
    expectSwitchOff(h);
  });

  test("keeps the saved list and leaves the switch off when a page fails", async () => {
    using _fetch = stubFetch(
      doorWith({ "": cachePage("first", "c7", 250, 251) }),
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
    expect(storedEntries(h)).toEqual([{ hash: "fresh", tickets: 1 }]);
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
    expect(storedEntries(h)).toEqual([{ hash: "fresh", tickets: 1 }]);
    expect(askedUrls(fetchStub)).toEqual([FIRST_PAGE]);
  });

  test("keeps the switch on and the saved list when the load's download fails", async () => {
    using _fetch = stubFetch(doorWith({}));
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
