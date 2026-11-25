/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
// test-groups: run-alone — the bundle runs inside happy-dom, whose internal
// task timers can outlive `happyDOM.abort()` under load; in a shared isolate a
// trailing timer fires during whichever suite runs next and fails its op
// sanitizer. Solo, it dies with the isolate — the proven-safe historical mode.

/**
 * The offline door's queue: the scans a dead connection keeps, and the ones
 * it refuses, with the words the door reads. The replay that settles the
 * queue is #test/ui/client/scanner-offline-ui/sync.test.ts. Every test
 * drives the real built bundle, so the words asserted are the words the door
 * reads.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { HTMLSelectElement as HappyHTMLSelectElement } from "happy-dom";
import { whenStatusShows } from "#test/ui/client/scanner/camera-fakes.ts";
import {
  el,
  SCAN_PATH,
  storedQueue,
  TOKEN,
  useScannerSuite,
} from "#test/ui/client/scanner/fixture.ts";
import {
  askedUrls,
  digestOf,
  expectCancelQueuesNothing,
  expectOfflineRefusal,
  expectOneStoredCheckIn,
  scanOffline,
  scanPartyOfThree,
} from "#test/ui/client/scanner/offline-door.ts";
import { stubFetch } from "#test-utils/fetch-stub.ts";

describe("scanner offline queue", {
  sanitizeOps: false,
  sanitizeResources: false,
}, () => {
  const fresh = useScannerSuite();

  test("queues a valid scan offline without posting it", async () => {
    using fetchStub = stubFetch(() => Response.json({}, { status: 500 }));
    const h = fresh({ onLine: false });
    await scanOffline(h, TOKEN);
    await whenStatusShows(
      h.statusEl,
      "Ticket looks valid. It will be checked in when you are back online.",
    );
    await expectOneStoredCheckIn(h, TOKEN);
    // The door reads the page's own words: the queue panel is out with
    // the kept scan's count.
    expect(el(h.document, "scanner-queue").className).not.toContain("hidden");
    expect(el(h.document, "scanner-queue-summary").textContent).toBe(
      "1 queued check-in",
    );
    // No scan left the page: only the page load's cache refresh ran.
    expect(askedUrls(fetchStub)).toEqual([`${SCAN_PATH}-cache`]);
  });

  test("asks how many people the check-in admits and queues the pick", async () => {
    // The booking owed three places when the list was built, so the scan
    // asks before it queues. The door checks in two of the three now.
    using fetchStub = stubFetch(() => Response.json({}, { status: 500 }));
    const h = fresh({ onLine: false });
    await scanPartyOfThree(h);

    // The whole party is the common case, so it starts selected.
    expect(
      (el(h.document, "scanner-quantity-select") as HappyHTMLSelectElement)
        .value,
    ).toBe("3");
    const select = el(
      h.document,
      "scanner-quantity-select",
    ) as HappyHTMLSelectElement;
    select.value = "2";
    el(h.document, "scanner-quantity-confirm").click();

    await whenStatusShows(
      h.statusEl,
      "Ticket looks valid. It will be checked in when you are back online.",
    );
    const [item] = JSON.parse(String(storedQueue(h)));
    expect(item.quantity).toBe(2);
    expect(item.tokenHash).toBe(await digestOf(TOKEN));
    expect(item.operationId).toEqual(expect.any(String));
    // No scan left the page: only the page load's cache refresh ran.
    expect(askedUrls(fetchStub)).toEqual([`${SCAN_PATH}-cache`]);
  });

  test("queues nothing when the door cancels the quantity ask", async () => {
    using _fetch = stubFetch(new Error("offline"));
    await expectCancelQueuesNothing(fresh({ onLine: false }));
  });

  test("sends an unknown ticket away with the offline wording", async () => {
    using fetchStub = stubFetch(new Error("offline"));
    const h = fresh({ onLine: false });
    // The cache holds another ticket's digest; the scanned one is a stranger.
    await scanOffline(h, TOKEN, { token: "other12345" });
    await expectOfflineRefusal(
      h,
      fetchStub,
      "This ticket cannot be checked in offline. Scan it again when you are back online to see why.",
    );
  });

  test("says the offline ticket list is missing when the store holds none", async () => {
    using fetchStub = stubFetch(new Error("offline"));
    const h = fresh({ onLine: false });
    // The store holds no ticket list, and the refresh that would fetch one
    // cannot run offline: the door learns why the scan is refused.
    await scanOffline(h, TOKEN, null);
    await expectOfflineRefusal(
      h,
      fetchStub,
      "No offline ticket list yet. Go online and reload this page first.",
    );
  });
});
