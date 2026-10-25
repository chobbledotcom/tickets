/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
// test-groups: run-alone — the bundle runs inside happy-dom, whose internal
// task timers can outlive `happyDOM.abort()` under load; in a shared isolate a
// trailing timer fires during whichever suite runs next and fails its op
// sanitizer. Solo, it dies with the isolate — the proven-safe historical mode.

/**
 * The shared helpers the offline door's suites lean on, pinned at their own
 * contracts: the store wait that hops real event-loop turns, the one
 * check-in read, and the queue panel's first row.
 */

// jscpd:ignore-start -- imports
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  whenStoreHolds,
  withEmptyCache,
} from "#test/ui/client/scanner/camera-fakes.ts";
import {
  queuedItem,
  SCAN_PATH,
  TOKEN,
  useScannerSuite,
} from "#test/ui/client/scanner/fixture.ts";
import {
  expectOneStoredCheckIn,
  firstRow,
} from "#test/ui/client/scanner/offline-door.ts";
import { stubFetch } from "#test-utils/fetch-stub.ts";

// jscpd:ignore-end

describe("scanner offline door helpers", {
  sanitizeOps: false,
  sanitizeResources: false,
}, () => {
  const fresh = useScannerSuite();

  test("waits for the list the page's own load stores later", async () => {
    using _fetch = stubFetch(withEmptyCache(() => Response.json({})));
    const h = fresh();
    // The cache refresh stores its list on the platform's crypto promise,
    // which no microtask drain resolves, so the wait hops real turns.
    const stored = await whenStoreHolds(h, `scanner-tickets-${SCAN_PATH}`);
    expect(JSON.parse(stored)).toEqual({
      entries: [],
      storedAt: expect.any(Number),
    });
  });

  test("gives up when the store never holds the key", async () => {
    const h = fresh({ onLine: false });
    // The offline page writes nothing to the queue store: the wait runs
    // out and names the key it never saw.
    await expect(whenStoreHolds(h, "scanner-queue")).rejects.toThrow(
      "The store never held scanner-queue",
    );
  });

  test("reads one queued check-in back from the store", async () => {
    const h = fresh({
      onLine: false,
      seed: (store) =>
        store.setItem("scanner-queue", JSON.stringify([queuedItem])),
    });
    await expectOneStoredCheckIn(h, TOKEN);
  });

  test("throws when the queue panel carries no first row", () => {
    const h = fresh({ onLine: false });
    // Nothing was queued, so the panel carries no rows.
    expect(() => firstRow(h)).toThrow("The queue panel carries no first row");
  });
});
