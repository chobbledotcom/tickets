/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
// test-groups: run-alone — the bundle runs inside happy-dom, whose internal
// task timers can outlive `happyDOM.abort()` under load; in a shared isolate a
// trailing timer fires during whichever suite runs next and fails its op
// sanitizer. Solo, it dies with the isolate — the proven-safe historical mode.

/**
 * How the scanner page settles a queued check-in with the door when the door
 * asks for an ID check first. Every test drives the real built bundle, so the
 * words asserted are the words the door reads.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stubFetch } from "#test-utils/fetch-stub.ts";
import { whenStatusShows, withEmptyCache } from "./camera-fakes.ts";
import { queuedItem, SCAN_PATH, TOKEN, useScannerSuite } from "./fixture.ts";
import { expectSyncSettled, firstRow, idAskedOnQueue } from "./offline-door.ts";

describe("scanner delivery with an ID check", {
  sanitizeOps: false,
  sanitizeResources: false,
}, () => {
  const fresh = useScannerSuite();

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
    const h = await idAskedOnQueue(fresh);
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
});
