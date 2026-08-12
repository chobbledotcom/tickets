import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { grantingRowClaim } from "#test-utils/refund-routes.ts";
import {
  candidate,
  finishedCounts,
  processRefundBatchAt,
  provider,
} from "./helpers.ts";

describe("admin refund provider > one charge two attendees carry", () => {
  test("is asked about once in a run, not once per attendee", async () => {
    const shared = provider({
      refundCapability: "keyless",
      refunded: new Set(["pi_both"]),
    });

    const counts = finishedCounts(
      await processRefundBatchAt(
        shared,
        [
          candidate([{ reference: "pi_both", refundState: "none" }], 11),
          candidate([{ reference: "pi_both", refundState: "none" }], 12),
        ],
        7,
        { claim: grantingRowClaim(), markReturned: () => Promise.resolve() },
      ),
    );

    expect(shared.refunds).toEqual(["pi_both"]);
    expect(counts).toEqual({
      errorCount: 0,
      failedCount: 0,
      notRecordedCount: 2,
      pendingCount: 0,
      refundedCount: 0,
    });
  });
});

describe("admin refund provider > a run that dies after a settled answer", () => {
  test("records the exact returned row before raising a ledger failure", async () => {
    const sessionId = "sess_pi_held";
    const claim = grantingRowClaim(new Map([[11, [sessionId]]]));

    await expect(
      processRefundBatchAt(
        provider({ refunded: new Set(["pi_held"]) }),
        [candidate([{ reference: "pi_held" }], 11)],
        7,
        {
          claim,
          markReturned: () => Promise.resolve(),
          record: () => Promise.reject(new Error("the ledger fell over")),
        },
      ),
    ).rejects.toThrow("the ledger fell over");

    expect(claim.unrecorded).toEqual([[sessionId]]);
    expect(claim.released).toEqual([[sessionId]]);
  });
});

describe("admin refund provider > a newly accepted refund", () => {
  test("keeps its fresh claim until the provider proves it returned", async () => {
    const sessionId = "sess_pi_fresh_pending";
    const claim = grantingRowClaim(new Map([[11, [sessionId]]]));
    const source = provider({ accepted: new Set(["pi_fresh_pending"]) });

    const counts = finishedCounts(
      await processRefundBatchAt(
        source,
        [candidate([{ reference: "pi_fresh_pending" }], 11)],
        7,
        { claim },
      ),
    );

    expect(source.refunds).toEqual(["pi_fresh_pending"]);
    expect(counts.pendingCount).toBe(1);
    expect(claim.released).toEqual([]);
  });
});
