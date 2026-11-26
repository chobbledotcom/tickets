/** The door that a test downloads an offline list from: its cache pages, a
 * door that answers them by cursor, and reads of the switch, the progress
 * line, and the stored list. The switch tests and the store tests share
 * them. */

import { expect } from "@std/expect";
import {
  savedEntry,
  whenStatusShows,
  whenStoreHolds,
} from "#test/ui/client/scanner/camera-fakes.ts";
import {
  el,
  MODE_KEY,
  SCAN_PATH,
  type ScannerHarness,
} from "#test/ui/client/scanner/fixture.ts";
import { type FetchResponder, stubFetch } from "#test-utils/fetch-stub.ts";

export const LIST_KEY = `scanner-tickets-${SCAN_PATH}`;
/** The first page's address: a request with no cursor. */
export const FIRST_PAGE = `${SCAN_PATH}-cache`;
export const READY =
  "Offline mode is on. The ticket list is saved on this device.";
export const FAILED =
  "The ticket list did not download. Check your connection, then try again.";

/** One cache page, as the door's cache endpoint answers it. */
export const cachePage = (
  hash: string,
  next: string | null,
  people: number,
  total: number,
) => ({ entries: [savedEntry(hash)], next, people, total });

/** A list a device saved earlier, still fresh. */
export const savedList = JSON.stringify({
  entries: [savedEntry("saved")],
  storedAt: Date.now(),
});

/** Answers each cache page by the cursor it asks for. The first page asks
 * for none, and its key is "". A cursor with no page answers 500. */
export const doorWith =
  (pages: Record<string, unknown>): FetchResponder =>
  (url) => {
    const from =
      new URL(String(url), "http://localhost").searchParams.get("from") ?? "";
    const page = pages[from];
    return page === undefined
      ? Response.json({}, { status: 500 })
      : Response.json(page);
  };

export const progress = (h: ScannerHarness) =>
  el(h.document, "scanner-offline-progress");
export const toggle = (h: ScannerHarness) =>
  el(h.document, "scanner-offline-toggle");

/** A door whose first cache page answers at once and whose second page
 * waits for `held`. */
export const doorWithHeldSecondPage =
  (held: Promise<Response>): FetchResponder =>
  (url, init) =>
    String(url).endsWith("from=c7")
      ? held
      : doorWith({ "": cachePage("first", "c7", 250, 251) })(url, init);

/** Turn the switch on and wait until the first page of 250 people is in. */
export const startDownload = async (h: ScannerHarness): Promise<void> => {
  toggle(h).click();
  await whenStatusShows(
    progress(h),
    "Downloading the ticket list (250 of 251 people)",
  );
};

/** Start a download whose second page waits for `secondPage`. The caller
 * disposes the returned fetch stub. */
export const startHeldDownload = async (fresh: () => ScannerHarness) => {
  const secondPage = Promise.withResolvers<Response>();
  const fetchStub = stubFetch(doorWithHeldSecondPage(secondPage.promise));
  const h = fresh();
  await startDownload(h);
  return { fetchStub, h, secondPage };
};

/** The switch is off: nothing stored for it, and it reads as not pressed. */
export const expectSwitchOff = (h: ScannerHarness): void => {
  expect(h.window.localStorage.getItem(MODE_KEY)).toBe(null);
  expect(toggle(h).getAttribute("aria-pressed")).toBe("false");
};

/** Hop real turns until a stopped download ends, and prove the store never
 * took its list. */
export const expectNoListStored = async (h: ScannerHarness): Promise<void> => {
  await expect(whenStoreHolds(h, LIST_KEY)).rejects.toThrow(
    `The store never held ${LIST_KEY}`,
  );
};

/** The list the store holds, as the page wrote it. */
export const storedList = (h: ScannerHarness): { entries: unknown } =>
  JSON.parse(String(h.window.localStorage.getItem(LIST_KEY)));

/** The entries of the list the store holds. */
export const storedEntries = (h: ScannerHarness): unknown =>
  storedList(h).entries;

/** A device whose switch is on and whose saved list is still fresh. */
export const switchOnWithList = (store: Storage): void => {
  store.setItem(MODE_KEY, "1");
  store.setItem(LIST_KEY, savedList);
};
