import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { describeWithEnv } from "#test-utils/db.ts";
import { grantingRowClaim } from "#test-utils/refund-routes.ts";
import {
  candidate,
  finishedCounts,
  processRefundBatchAt,
  provider,
} from "./helpers.ts";

describeWithEnv(
  "admin refund provider > one charge two attendees carry",
  { db: true },
  () => {
    test("is asked about once in a run, not once per attendee", async () => {
      const shared = provider({
        refundCapability: "keyless",
        refunded: new Set(["pi_both"]),
      });

      const counts = finishedCounts(
        await processRefundBatchAt(
          shared,
          [
            candidate(
              [
                {
                  provider: "sumup",
                  reference: "pi_both",
                  refundState: "none",
                },
              ],
              11,
            ),
            candidate(
              [
                {
                  provider: "sumup",
                  reference: "pi_both",
                  refundState: "none",
                },
              ],
              12,
            ),
          ],
          7,
          { claim: grantingRowClaim() },
        ),
      );

      expect(shared.refunds).toEqual(["pi_both"]);
      expect(counts).toEqual({
        failedCount: 0,
        notRecordedCount: 2,
        pendingCount: 0,
        refundedCount: 0,
      });
    });
  },
);

describeWithEnv(
  "admin refund provider > a run that dies after a settled answer",
  { db: true },
  () => {
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
            record: () => Promise.reject(new Error("the ledger fell over")),
          },
        ),
      ).rejects.toThrow("the ledger fell over");

      expect(claim.unrecorded).toEqual([[sessionId]]);
      expect(claim.released).toEqual([[sessionId]]);
    });
  },
);

describeWithEnv(
  "admin refund provider > a newly accepted refund",
  { db: true },
  () => {
    test("releases its checking fence while durable authority tracks it", async () => {
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
      expect(claim.released).toEqual([[sessionId]]);
    });
  },
);
