import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { prepareRefundReadiness } from "#routes/admin/refunds/readiness.ts";
import { anchorSessionId } from "#shared/db/payment-anchor/session.ts";
import {
  candidate,
  charge,
  found,
  heldClaim,
  stripeReadiness,
  untagged,
} from "./helpers.ts";

describe("admin refund readiness row anchors", () => {
  test("keeps a rowless legacy reference anchored under its old index", async () => {
    const attendeeId = 7;
    const legacy = untagged("pi_legacy");
    const oldAnchor = anchorSessionId(attendeeId, legacy.index);
    const rowless = {
      ...legacy,
      heldRowSessionIds: [oldAnchor],
      rowSessionIds: [],
      sessionIds: [],
    };

    const result = await prepareRefundReadiness(
      [candidate(attendeeId, [rowless])],
      {
        held: new Map([[attendeeId, [oldAnchor]]]),
        heldSince: heldClaim.heldSince,
      },
      new Set(),
      stripeReadiness((reference) =>
        Promise.resolve(found(reference, "stripe", charge())),
      ),
    );

    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") return;
    expect(result.candidates[0]?.references[0]?.reference).toMatchObject({
      index: `bound_${legacy.index}`,
      rowSessionIds: [oldAnchor],
    });
  });
});
