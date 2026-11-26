/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
// test-groups: run-alone — the bundle runs inside happy-dom, whose internal
// task timers can outlive `happyDOM.abort()` under load; in a shared isolate a
// trailing timer fires during whichever suite runs next and fails its op
// sanitizer. Solo, it dies with the isolate — the proven-safe historical mode.

/** The paged download of one door's list, and the stored switch: each page
 * counts its people into the progress, a stopped download stores nothing,
 * and turning the switch off forgets the switch and the list. Every test
 * runs the real built bundle. */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  savedEntry,
  whenStatusShows,
} from "#test/ui/client/scanner/camera-fakes.ts";
import {
  cachePage,
  doorWith,
  doorWithHeldSecondPage,
  expectNoListStored,
  LIST_KEY,
  progress,
  READY,
  startDownload,
  startHeldDownload,
  storedEntries,
  toggle,
} from "#test/ui/client/scanner/download-door.ts";
import { MODE_KEY, useScannerSuite } from "#test/ui/client/scanner/fixture.ts";
import { stubFetch } from "#test-utils/fetch-stub.ts";

describe("scanner offline download", {
  sanitizeOps: false,
  sanitizeResources: false,
}, () => {
  const fresh = useScannerSuite();

  test("counts each page's people, stores every page, and forgets both on off", async () => {
    const secondPage = Promise.withResolvers<Response>();
    using _fetch = stubFetch(doorWithHeldSecondPage(secondPage.promise));
    const h = fresh();
    // The first page reads 250 of the door's 251 people.
    await startDownload(h);

    secondPage.resolve(Response.json(cachePage("second", null, 1, 251)));
    await whenStatusShows(h.statusEl, READY);
    expect(progress(h).textContent).toBe(
      "Downloading the ticket list (251 of 251 people)",
    );
    expect(storedEntries(h)).toEqual([
      savedEntry("first"),
      savedEntry("second"),
    ]);
    expect(h.window.localStorage.getItem(MODE_KEY)).toBe("1");

    toggle(h).click();
    expect(h.window.localStorage.getItem(MODE_KEY)).toBe(null);
    expect(h.window.localStorage.getItem(LIST_KEY)).toBe(null);
  });

  test("stores nothing from a page that lands after the door stopped", async () => {
    const { fetchStub, h, secondPage } = await startHeldDownload(fresh);
    using _fetch = fetchStub;
    toggle(h).click();

    // The stub ignores the stop signal, so only the download's own check
    // keeps the late page out of the store.
    secondPage.resolve(
      await doorWith({ "": cachePage("late", null, 1, 251) })("", {}),
    );
    await expectNoListStored(h);
  });
});
